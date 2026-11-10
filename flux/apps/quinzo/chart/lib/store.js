// Stockage de l'état partagé.
// - MemoryStore : une seule instance (PC, Docker simple). Aucun service externe.
// - RedisStore  : plusieurs réplicas. État de partie, sessions admin, compteurs anti-abus,
//                 identifiants et élection d'un « leader » (qui gère les échéances) dans Redis.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class MemoryStore {
  constructor({ dataDir }) {
    this.mode = 'memory';
    this.dataDir = dataDir;
    this.game = null;
    this.chain = Promise.resolve();
    this.counters = new Map();
    this.sessions = new Map();
  }
  async init() {}
  async ensureGame(factory) { if (!this.game) this.game = factory(); }
  async getGame() { return this.game; }
  /** Exécute fn(état) en exclusion mutuelle, puis enregistre. */
  mutate(fn) {
    const run = this.chain.then(async () => {
      const r = await fn(this.game);
      this.game.version++;
      return r;
    });
    this.chain = run.catch(() => {});
    return run;
  }
  async incr(key, ttlMs) {
    const now = Date.now();
    let c = this.counters.get(key);
    if (!c || c.until < now) c = { v: 0, until: now + ttlMs };
    c.v++;
    this.counters.set(key, c);
    return c.v;
  }
  async count(key) {
    const c = this.counters.get(key);
    return c && c.until >= Date.now() ? c.v : 0;
  }
  async reset(key) { this.counters.delete(key); }
  async setSession(id, data, ttlMs) { this.sessions.set(id, { data, until: Date.now() + ttlMs }); }
  async getSession(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.until < Date.now()) { this.sessions.delete(id); return null; }
    return s.data;
  }
  async delSession(id) { this.sessions.delete(id); }
  // Identifiants admin : fichier dans le dossier de données
  get adminFile() { return path.join(this.dataDir, 'admin.json'); }
  async getAdmin() {
    try { return JSON.parse(fs.readFileSync(this.adminFile, 'utf8')); } catch (e) { return null; }
  }
  async setAdmin(rec) { fs.writeFileSync(this.adminFile, JSON.stringify(rec, null, 2), { mode: 0o600 }); }
  async createAdminIfAbsent(rec) {
    if (await this.getAdmin()) return false;
    await this.setAdmin(rec);
    return true;
  }
  async tryLead() { return true; }
  async releaseLead() {}
  async close() {}
}

const UNLOCK_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const INCR_LUA = "local v = redis.call('incr', KEYS[1]) if v == 1 then redis.call('pexpire', KEYS[1], ARGV[1]) end return v";
const LEAD_LUA = `
local cur = redis.call('get', KEYS[1])
if not cur then redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 end
if cur == ARGV[1] then redis.call('pexpire', KEYS[1], ARGV[2]) return 1 end
return 0`;

class RedisStore {
  constructor({ url, password, prefix = 'quinzo:' }) {
    const Redis = require('ioredis');
    this.mode = 'redis';
    this.prefix = prefix;
    this.opts = { lazyConnect: true, maxRetriesPerRequest: 3, enableAutoPipelining: true };
    if (password) this.opts.password = password;
    this.url = url;
    this.redis = new Redis(url, this.opts);
    this.redis.on('error', (e) => { if (!this.lastErr || Date.now() - this.lastErr > 5000) { console.error('Redis :', e.message); this.lastErr = Date.now(); } });
  }
  k(name) { return this.prefix + name; }
  /** Nouvelle connexion avec les mêmes réglages (pub/sub de l'adaptateur Socket.IO). */
  duplicate() { return this.redis.duplicate(); }
  async init() {
    await this.redis.connect();
    await this.redis.ping();
  }
  async ensureGame(factory) {
    await this.redis.set(this.k('game'), JSON.stringify(factory()), 'NX');
  }
  async getGame() {
    const s = await this.redis.get(this.k('game'));
    return s ? JSON.parse(s) : null;
  }
  async lock(ttlMs = 5000, waitMs = 8000) {
    const token = crypto.randomBytes(12).toString('hex');
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (await this.redis.set(this.k('lock'), token, 'PX', ttlMs, 'NX')) return token;
      if (Date.now() > deadline) throw new Error('verrou Redis indisponible');
      await sleep(5 + Math.random() * 15);
    }
  }
  async unlock(token) { await this.redis.eval(UNLOCK_LUA, 1, this.k('lock'), token); }
  /** Lecture-modification-écriture protégée par un verrou distribué. fn doit rester rapide et synchrone. */
  async mutate(fn) {
    const token = await this.lock();
    try {
      const raw = await this.redis.get(this.k('game'));
      const g = raw ? JSON.parse(raw) : null;
      const r = await fn(g);
      g.version++;
      await this.redis.set(this.k('game'), JSON.stringify(g));
      return r;
    } finally {
      await this.unlock(token).catch(() => {});
    }
  }
  async incr(key, ttlMs) { return Number(await this.redis.eval(INCR_LUA, 1, this.k('c:' + key), ttlMs)); }
  async count(key) { return Number(await this.redis.get(this.k('c:' + key))) || 0; }
  async reset(key) { await this.redis.del(this.k('c:' + key)); }
  async setSession(id, data, ttlMs) { await this.redis.set(this.k('sess:' + id), JSON.stringify(data), 'PX', ttlMs); }
  async getSession(id) {
    const s = await this.redis.get(this.k('sess:' + id));
    return s ? JSON.parse(s) : null;
  }
  async delSession(id) { await this.redis.del(this.k('sess:' + id)); }
  async getAdmin() {
    const s = await this.redis.get(this.k('admin'));
    return s ? JSON.parse(s) : null;
  }
  async setAdmin(rec) { await this.redis.set(this.k('admin'), JSON.stringify(rec)); }
  async createAdminIfAbsent(rec) { return (await this.redis.set(this.k('admin'), JSON.stringify(rec), 'NX')) === 'OK'; }
  /** Élection : une seule instance détient le bail « leader » (renouvelé régulièrement). */
  async tryLead(id, ttlMs) { return Number(await this.redis.eval(LEAD_LUA, 1, this.k('leader'), id, ttlMs)) === 1; }
  async releaseLead(id) { await this.redis.eval(UNLOCK_LUA, 1, this.k('leader'), id); }
  async close() { await this.redis.quit().catch(() => {}); }
}

module.exports = { MemoryStore, RedisStore };
