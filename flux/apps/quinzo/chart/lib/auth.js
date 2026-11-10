// Authentification FACULTATIVE de l'administrateur (écran hôte + éditeur).
// Désactivée par défaut : l'écran hôte est libre d'accès.
// Activée seulement si ADMIN_PASSWORD (ou ADMIN_PASSWORD_HASH) est défini.
// - Mots de passe hachés avec scrypt (sel aléatoire), comparaison en temps constant.
// - Sessions aléatoires stockées dans le store (mémoire ou Redis → partagées entre réplicas),
//   transmises par un cookie HttpOnly + SameSite=Strict (illisible par JavaScript, non envoyé cross-site).
// - Limitation des tentatives de connexion.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_TTL_MS = 12 * 3600 * 1000;
const COOKIE = 'quinzo_session';
const SCRYPT = { N: 16384, r: 8, p: 1 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  let got;
  try {
    got = crypto.scryptSync(String(pw), Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  } catch (e) { return false; }
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}
/** Mot de passe lisible : 4 groupes de 4 caractères sans ambiguïté (~80 bits). */
function generatePassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const chars = Array.from({ length: 16 }, () => alphabet[crypto.randomInt(0, alphabet.length)]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
const sessionKey = (token) => crypto.createHash('sha256').update(token).digest('hex');

class Auth {
  /**
   * @param store       MemoryStore | RedisStore
   * @param env         variables d'environnement (ADMIN_USER, ADMIN_PASSWORD, ADMIN_PASSWORD_HASH)
   * @param dataDir     dossier où écrire le mot de passe initial (mode fichier)
   */
  constructor({ store, env = process.env, dataDir }) {
    this.store = store;
    this.env = env;
    this.dataDir = dataDir;
    this.managed = false;
    this.enabled = false;
  }

  async init() {
    const user = (this.env.ADMIN_USER || 'admin').trim();
    if (this.env.ADMIN_PASSWORD_HASH || this.env.ADMIN_PASSWORD) {
      // Identifiants fournis par l'environnement (Secret Kubernetes, docker compose…)
      this.managed = true;
      this.enabled = true;
      const hash = this.env.ADMIN_PASSWORD_HASH || hashPassword(this.env.ADMIN_PASSWORD);
      // « époque » identique sur tous les réplicas : change si le mot de passe change → sessions invalidées
      const epochSrc = this.env.ADMIN_PASSWORD_HASH
        ? this.env.ADMIN_PASSWORD_HASH
        : crypto.scryptSync(this.env.ADMIN_PASSWORD, 'quinzo-epoch:' + user, 16, SCRYPT).toString('hex');
      this.record = { user, hash, epoch: 'env-' + crypto.createHash('sha256').update(epochSrc).digest('hex').slice(0, 16) };
      return;
    }
    // Pas de mot de passe configuré : pas d'authentification
    this.record = { user };
  }

  async current() { return this.record; }

  /** Limitation : 10 échecs / 15 min par IP (si fiable), ralentissement global au-delà de 30 échecs. */
  async login(username, password, { ip, ipTrusted }) {
    if (!this.enabled) return { ok: true, token: null };
    const ipKey = 'login:ip:' + ip;
    if (ipTrusted && (await this.store.count(ipKey)) >= 10) {
      return { ok: false, status: 429, error: 'Trop de tentatives. Réessaie dans 15 minutes.' };
    }
    if ((await this.store.count('login:all')) >= 30) await sleep(1500);
    const rec = await this.current();
    const userOk = safeEqual(String(username || '').trim(), rec.user);
    const passOk = verifyPassword(String(password || ''), rec.hash); // toujours calculé (temps constant)
    if (!(userOk && passOk)) {
      if (ipTrusted) await this.store.incr(ipKey, 15 * 60000);
      await this.store.incr('login:all', 15 * 60000);
      await sleep(300 + crypto.randomInt(0, 300));
      return { ok: false, status: 401, error: 'Identifiant ou mot de passe incorrect.' };
    }
    if (ipTrusted) await this.store.reset(ipKey);
    return { ok: true, token: await this.createSession(rec) };
  }

  async createSession(rec) {
    const token = crypto.randomBytes(32).toString('base64url');
    await this.store.setSession(sessionKey(token), { user: rec.user, epoch: rec.epoch, at: Date.now() }, SESSION_TTL_MS);
    return token;
  }

  /** Renvoie { user } si le jeton est valide. */
  async validate(token) {
    if (!this.enabled) return { user: this.record.user }; // accès libre
    if (!token || token.length > 100) return null;
    const s = await this.store.getSession(sessionKey(token));
    if (!s) return null;
    const rec = await this.current();
    if (s.epoch !== rec.epoch || s.user !== rec.user) return null;
    return { user: s.user };
  }

  async logout(token) { if (token) await this.store.delSession(sessionKey(token)); }

  async changePassword() {
    return { ok: false, status: 400, error: this.enabled ? 'Le mot de passe est géré par la configuration (variable d\'environnement / Secret).' : 'Aucun mot de passe : l\'écran hôte est en accès libre.' };
  }

  tokenFrom(cookieHeader) { return parseCookies(cookieHeader)[COOKIE] || null; }
  cookie(token, secure) {
    return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`;
  }
  clearCookie(secure) { return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`; }
}

module.exports = { Auth, hashPassword, verifyPassword, generatePassword, parseCookies };
