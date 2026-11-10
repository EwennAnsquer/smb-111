// Quinzo — quiz multijoueur.
// Une instance (PC, Docker) : état en mémoire.
// Plusieurs réplicas (Kubernetes) : REDIS_URL défini → état, sessions et thèmes dans Redis,
// diffusion Socket.IO entre réplicas via l'adaptateur Redis, échéances gérées par un leader élu.
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { ThemeStore, FileThemeBackend, RedisThemeBackend, TYPES } = require('./lib/themes');
const { MemoryStore, RedisStore } = require('./lib/store');
const { Auth, hashPassword } = require('./lib/auth');
const game = require('./lib/game');

// Utilitaire : node server.js hash-password "mon mot de passe"  → valeur pour ADMIN_PASSWORD_HASH
if (process.argv[2] === 'hash-password') {
  if (!process.argv[3]) { console.error('Usage : node server.js hash-password "mot de passe"'); process.exit(1); }
  console.log(hashPassword(process.argv[3]));
  process.exit(0);
}

let QRCode = null;
try { QRCode = require('qrcode'); } catch (e) { /* QR code optionnel */ }

// ---------- Configuration ----------
const env = process.env;
const PORT = parseInt(env.PORT, 10) || 3000;
const MAX_PLAYERS = parseInt(env.MAX_PLAYERS, 10) || 50;
const MAX_PER_DEVICE = 2;
const IN_DOCKER = env.IN_DOCKER === '1' || fs.existsSync('/.dockerenv');
// Derrière un Ingress / reverse proxy : l'IP du client est le dernier maillon de X-Forwarded-For.
const TRUST_PROXY = env.TRUST_PROXY === '1';
// Les IP sont-elles assez fiables pour bannir / limiter par appareil ?
const TRUST_CLIENT_IP = env.TRUST_CLIENT_IP ? env.TRUST_CLIENT_IP === '1' : (TRUST_PROXY || !IN_DOCKER);
const PUBLIC_HOST = (env.PUBLIC_HOST || '').trim();
const PUBLIC_PORT = parseInt(env.PUBLIC_PORT, 10) || PORT;
const PUBLIC_URL = (env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
const DATA_DIR = env.DATA_DIR || __dirname;
const BUNDLED_THEMES = path.join(__dirname, 'themes');
const THEMES_DIR = env.THEMES_DIR || path.join(DATA_DIR, 'themes');
const REDIS_URL = env.REDIS_URL || (env.REDIS_HOST ? `redis://${env.REDIS_HOST}:${env.REDIS_PORT || 6379}` : '');
const REDIS_PREFIX = env.REDIS_PREFIX || 'quinzo:';
const INSTANCE = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;

fs.mkdirSync(DATA_DIR, { recursive: true });
const store = REDIS_URL ? new RedisStore({ url: REDIS_URL, password: env.REDIS_PASSWORD, prefix: REDIS_PREFIX }) : new MemoryStore({ dataDir: DATA_DIR });
const themes = new ThemeStore(REDIS_URL ? new RedisThemeBackend(store.redis, REDIS_PREFIX) : new FileThemeBackend(THEMES_DIR), { bundledDir: BUNDLED_THEMES });
const auth = new Auth({ store, env, dataDir: DATA_DIR });
const MULTI = store.mode === 'redis';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6, pingInterval: 10000, pingTimeout: 8000 });

// ---------- Réseau ----------
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
  }
  const score = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  const virtual = /(vmware|virtualbox|vbox|hyper-v|vethernet|docker|wsl|tailscale|zerotier|hamachi|loopback|tun|tap)/i;
  return out.sort((a, b) => (virtual.test(a.name) - virtual.test(b.name)) || (score(a.address) - score(b.address)));
}
function ownAddresses() {
  const s = new Set(['127.0.0.1', '::1']);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) s.add(a.address);
  return s;
}
const normIp = (a) => String(a || '').replace(/^::ffff:/, '');
function clientIp(remote, headers) {
  if (TRUST_PROXY && headers['x-forwarded-for']) {
    const parts = String(headers['x-forwarded-for']).split(',').map((x) => x.trim()).filter(Boolean);
    if (parts.length) return normIp(parts[parts.length - 1]);
  }
  return normIp(remote);
}
/** Le PC qui héberge (une seule instance, hors proxy) n'est jamais banni ni limité. */
const isHostMachine = (ip) => !MULTI && !TRUST_PROXY && TRUST_CLIENT_IP && ownAddresses().has(ip);
function joinUrls() {
  if (/^https?:\/\/[^\s/]+$/.test(PUBLIC_URL)) return [PUBLIC_URL];
  if (PUBLIC_HOST) return [`http://${PUBLIC_HOST}${PUBLIC_PORT === 80 ? '' : ':' + PUBLIC_PORT}`];
  if (IN_DOCKER) return [];
  return lanAddresses().map((a) => `http://${a.address}${PORT === 80 ? '' : ':' + PORT}`);
}
const isHttps = (req) => req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

// ---------- HTTP ----------
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob: https: http:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb', type: ['text/*', 'application/csv', 'application/octet-stream'] }));

async function sessionOf(req) { return auth.validate(auth.tokenFrom(req.headers.cookie)); }
// Les requêtes qui modifient quelque chose doivent porter l'en-tête X-Quinzo (protection CSRF :
// un site tiers ne peut pas l'ajouter sans autorisation CORS, que le serveur ne donne jamais).
const csrfOk = (req) => req.method === 'GET' || req.get('x-quinzo') === '1';
const requireAdmin = async (req, res, next) => {
  try {
    if (!csrfOk(req)) return res.status(403).json({ error: 'Requête refusée.' });
    const s = await sessionOf(req);
    if (!s) return res.status(401).json({ error: 'Connexion requise.' });
    req.admin = s;
    next();
  } catch (e) { next(e); }
};
const adminPage = (file) => async (req, res, next) => {
  try {
    if (await sessionOf(req)) return res.sendFile(path.join(__dirname, 'public', file));
    res.redirect('/login?next=' + encodeURIComponent(req.path.replace(/\.html$/, '')));
  } catch (e) { next(e); }
};

// Pages d'administration : jamais servies sans session valide
app.get(['/host', '/host.html'], adminPage('host.html'));
app.get(['/editor', '/editor.html'], adminPage('editor.html'));
app.get(['/login', '/login.html'], (req, res) => (auth.enabled ? res.sendFile(path.join(__dirname, 'public', 'login.html')) : res.redirect('/host')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/images', express.static(path.join(THEMES_DIR, 'images')));

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/readyz', async (req, res) => {
  try { await store.getGame(); res.json({ ok: true, mode: store.mode, leader: isLeader }); } catch (e) { res.status(503).json({ ok: false }); }
});

app.post('/api/login', async (req, res, next) => {
  try {
    if (!csrfOk(req)) return res.status(403).json({ error: 'Requête refusée.' });
    const { username, password } = req.body || {};
    const r = await auth.login(username, password, { ip: clientIp(req.socket.remoteAddress, req.headers), ipTrusted: TRUST_CLIENT_IP });
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    if (r.token) res.setHeader('Set-Cookie', auth.cookie(r.token, isHttps(req)));
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post('/api/logout', async (req, res, next) => {
  try {
    if (!csrfOk(req)) return res.status(403).json({ error: 'Requête refusée.' });
    const token = auth.tokenFrom(req.headers.cookie);
    if (token) io.in(sessionRoom(token)).disconnectSockets(true);
    await auth.logout(token);
    res.setHeader('Set-Cookie', auth.clearCookie(isHttps(req)));
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.get('/api/me', async (req, res, next) => {
  try {
    const s = await sessionOf(req);
    res.json(s ? { authenticated: true, user: s.user, authEnabled: auth.enabled } : { authenticated: false, authEnabled: auth.enabled });
  } catch (e) { next(e); }
});
app.post('/api/admin/password', requireAdmin, async (req, res, next) => {
  try {
    const { current, next: nextPw } = req.body || {};
    const r = await auth.changePassword(auth.tokenFrom(req.headers.cookie), current, nextPw);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    io.in('host').disconnectSockets(true); // les écrans hôtes se reconnectent avec la nouvelle session
    res.setHeader('Set-Cookie', auth.cookie(r.token, isHttps(req)));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.get('/api/info', async (req, res, next) => {
  try { res.json({ urls: joinUrls(), port: PUBLIC_PORT, isHost: !!(await sessionOf(req)), docker: IN_DOCKER, types: TYPES }); } catch (e) { next(e); }
});
app.get('/api/qr', requireAdmin, async (req, res) => {
  if (!QRCode) return res.status(404).end();
  try { res.json({ qr: await QRCode.toDataURL(String(req.query.url || '').slice(0, 300), { margin: 1, width: 360, color: { dark: '#16123a', light: '#ffffff' } }) }); } catch (e) { res.status(400).end(); }
});
app.get('/api/themes', requireAdmin, async (req, res, next) => {
  try { await themes.sync(); res.json(themes.list()); } catch (e) { next(e); }
});
app.get('/api/themes/:id', requireAdmin, async (req, res, next) => {
  try {
    await themes.sync();
    const t = themes.get(req.params.id);
    t ? res.json(t) : res.status(404).json({ error: 'Thème introuvable' });
  } catch (e) { next(e); }
});
app.post('/api/themes', requireAdmin, async (req, res) => {
  try {
    const { id, ...raw } = req.body || {};
    const r = await themes.save(raw, { id });
    io.to('host').emit('themes:changed');
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/themes/:id', requireAdmin, async (req, res, next) => {
  try {
    const ok = await themes.remove(req.params.id);
    io.to('host').emit('themes:changed');
    res.json({ ok });
  } catch (e) { next(e); }
});
app.post('/api/import', requireAdmin, async (req, res) => {
  try {
    const text = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const results = await themes.importText(text, { filename: String(req.query.filename || ''), defaultName: String(req.query.name || '') });
    io.to('host').emit('themes:changed');
    res.json({ results });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/reload', requireAdmin, async (req, res, next) => {
  try {
    const errors = await themes.load();
    io.to('host').emit('themes:changed');
    res.json({ errors, count: themes.size });
  } catch (e) { next(e); }
});
app.get('/api/themes/:id/export', requireAdmin, async (req, res, next) => {
  try {
    await themes.sync();
    const t = themes.get(req.params.id);
    if (!t) return res.status(404).end();
    const { id, ...data } = t;
    res.setHeader('Content-Disposition', `attachment; filename="${id}.json"`);
    res.json(data);
  } catch (e) { next(e); }
});
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('Erreur :', err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Erreur serveur.' });
});

// ---------- Diffusion de l'état ----------
const sessionRoom = (token) => 'sess:' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
let broadcastQueued = false;
function broadcastSoon() {
  if (broadcastQueued) return;
  broadcastQueued = true;
  setTimeout(async () => {
    broadcastQueued = false;
    try { await localBroadcast(); } catch (e) { console.error('Diffusion :', e.message); }
  }, 60);
}
/** Envoie à chaque client connecté à CETTE instance sa vue personnalisée. */
async function localBroadcast() {
  const g = await store.getGame();
  if (!g) return;
  const now = Date.now();
  let hostView = null;
  for (const s of io.of('/').sockets.values()) {
    if (s.data.isHost) s.emit('state', hostView || (hostView = game.viewFor(g, null, true, { trustIp: TRUST_CLIENT_IP, now })));
    else if (s.data.playerId) s.emit('state', game.viewFor(g, s.data.playerId, false, { now }));
  }
}
/** Signale un changement : diffusion locale + aux autres réplicas (qui diffusent à leurs clients). */
function notify() {
  broadcastSoon();
  if (MULTI) io.serverSideEmit('quinzo:changed');
}
io.on('quinzo:changed', () => broadcastSoon());

async function mutate(fn) {
  const r = await store.mutate((g) => fn(g, Date.now()));
  notify();
  return r;
}
const clean = (s, max = 20) => String(s || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

// ---------- Leader : échéances (fin du chrono, enchaînement auto, ménage du salon) ----------
let isLeader = !MULTI;
async function leadLoop() {
  try {
    const was = isLeader;
    isLeader = await store.tryLead(INSTANCE, 6000);
    if (isLeader && !was) console.log(`👑 ${INSTANCE} gère maintenant les échéances de la partie`);
  } catch (e) { isLeader = false; }
}
let ticking = false;
async function tickLoop() {
  if (!isLeader || ticking) return;
  ticking = true;
  try {
    const g = await store.getGame();
    if (game.needsTick(g, Date.now())) {
      let changed = false;
      await store.mutate((g2) => { changed = game.tick(g2, Date.now()); });
      if (changed) notify();
    }
  } catch (e) { /* Redis momentanément indisponible : on réessaie au prochain tour */ } finally { ticking = false; }
}
/** Présence : un réplica qui plante n'envoie pas de « déconnexion » ; le leader réconcilie. */
async function reconcilePresence() {
  if (!isLeader || !MULTI) return;
  try {
    const sockets = await io.fetchSockets();
    const online = new Set(sockets.map((s) => s.data && s.data.playerId).filter(Boolean));
    const g0 = await store.getGame();
    const now = Date.now();
    const stale = (p) => (p.connected && !online.has(p.id) && now - (p.seenAt || 0) > 5000) || (!p.connected && online.has(p.id));
    if (!Object.values(g0.players).some(stale)) return;
    await mutate((g, t) => {
      for (const p of Object.values(g.players)) {
        if (p.connected && !online.has(p.id) && t - (p.seenAt || 0) > 5000) { p.connected = false; p.disconnectedAt = t; }
        else if (!p.connected && online.has(p.id)) { p.connected = true; p.disconnectedAt = 0; }
      }
      game.checkAllAnswered(g, t);
    });
  } catch (e) { /* réessai au prochain tour */ }
}

// ---------- Sockets ----------
io.on('connection', (socket) => {
  const ip = clientIp(socket.handshake.address, socket.handshake.headers);
  socket.data.ip = ip;
  let socketPinFails = 0;
  let hostToken = null;
  const reply = (ack, r) => { if (typeof ack === 'function') ack(r); };

  // anti-spam : 30 messages / 5 s par connexion (hors hôte)
  let evCount = 0, evStart = Date.now();
  socket.use((packet, nextFn) => {
    if (socket.data.isHost) return nextFn();
    const now = Date.now();
    if (now - evStart > 5000) { evStart = now; evCount = 0; }
    if (++evCount > 30) { socket.disconnect(true); return; }
    nextFn();
  });

  socket.on('host:hello', async (ack) => {
    try {
      // la connexion doit venir d'une page du même site (anti détournement de WebSocket)
      const origin = socket.handshake.headers.origin;
      if (origin) {
        let originHost = '';
        try { originHost = new URL(origin).host; } catch (e) { /* invalide */ }
        if (originHost !== socket.handshake.headers.host) return reply(ack, { ok: false, error: 'origin' });
      }
      const token = auth.tokenFrom(socket.handshake.headers.cookie);
      const s = await auth.validate(token);
      if (!s) return reply(ack, { ok: false, error: 'auth' });
      hostToken = token;
      socket.data.isHost = true;
      socket.join('host');
      if (token) socket.join(sessionRoom(token));
      reply(ack, { ok: true, user: s.user });
      const g = await store.getGame();
      socket.emit('state', game.viewFor(g, null, true, { trustIp: TRUST_CLIENT_IP }));
    } catch (e) { reply(ack, { ok: false, error: 'Erreur serveur.' }); }
  });

  // Chaque action de l'hôte revérifie la session (expirée, déconnectée ou mot de passe changé → refus)
  const hostOnly = (fn) => async (...args) => {
    const ack = args.find((a) => typeof a === 'function');
    if (!socket.data.isHost) return;
    try {
      if (!(await auth.validate(hostToken))) { socket.emit('auth:expired'); socket.disconnect(true); return; }
      await fn(...args);
    } catch (e) {
      console.error('Action hôte :', e.message);
      reply(ack, { ok: false, error: 'Erreur serveur, réessaie.' });
    }
  };

  socket.on('host:settings', hostOnly(async (s) => {
    s = s || {};
    await themes.sync();
    await mutate((g) => {
      if (g.state !== 'lobby' && g.state !== 'end') return;
      const st = g.settings;
      if (Array.isArray(s.themes)) st.themes = s.themes.filter((id) => themes.get(id));
      if (Number.isFinite(+s.count)) st.count = Math.max(1, Math.min(200, Math.round(+s.count)));
      if (Number.isFinite(+s.time)) st.time = Math.max(5, Math.min(300, Math.round(+s.time)));
      if (['all', 'facile', 'moyen', 'difficile'].includes(s.difficulty)) st.difficulty = s.difficulty;
      if (Array.isArray(s.types)) st.types = s.types.filter((t) => TYPES.includes(t));
      ['leaderboardEvery', 'shuffleChoices', 'autoNext'].forEach((k) => { if (typeof s[k] === 'boolean') st[k] = s[k]; });
    });
  }));
  socket.on('host:start', hostOnly(async (ack) => {
    await themes.sync();
    const r = await mutate((g, now) => {
      if (g.state !== 'lobby' && g.state !== 'end') return { ok: false, error: 'Une partie est déjà en cours.' };
      const qs = game.buildQuestions(g.settings, themes);
      if (!qs.length) return { ok: false, error: 'Aucune question ne correspond aux réglages (thèmes, types, difficulté).' };
      game.startGame(g, qs, now);
      return { ok: true, count: qs.length };
    });
    reply(ack, r);
  }));
  socket.on('host:reveal', hostOnly(() => mutate((g, now) => game.doReveal(g, now))));
  socket.on('host:next', hostOnly(() => mutate((g, now) => game.next(g, now))));
  socket.on('host:end', hostOnly(() => mutate((g) => game.endGame(g))));
  socket.on('host:lobby', hostOnly(() => mutate((g) => game.toLobby(g))));
  socket.on('host:newpin', hostOnly(() => mutate((g) => { g.pin = game.newPin(); })));
  socket.on('host:lock', hostOnly((v) => mutate((g) => { g.locked = !!v; })));
  socket.on('host:unban', hostOnly(() => mutate((g) => { g.banned = {}; })));
  socket.on('host:kick', hostOnly(async (id, ack) => {
    const r = await mutate((g, now) => {
      const p = g.players[id];
      if (!p) return { ok: false };
      delete g.players[id];
      delete g.answers[id];
      let newPin = false;
      if (TRUST_CLIENT_IP) {
        if (p.ip && !isHostMachine(p.ip)) g.banned[p.ip] = p.name; // exclu jusqu'à « débannir »
      } else {
        g.pin = game.newPin(); // IP non fiable : on change le code pour l'empêcher de revenir
        newPin = true;
      }
      game.checkAllAnswered(g, now);
      return { ok: true, newPin };
    });
    if (r.ok) {
      io.in('p:' + id).emit('kicked');
      io.in('p:' + id).socketsLeave('p:' + id);
    }
    reply(ack, r);
  }));

  socket.on('player:join', async (data, ack) => {
    try {
      data = data || {};
      const askedId = clean(data.id, 40);
      const name = clean(data.name, 16);
      const avatar = clean(data.avatar, 8) || '🙂';
      const pin = String(data.pin || '').trim().slice(0, 8);
      if (!name) return reply(ack, { ok: false, error: 'Choisis un pseudo.' });
      const g0 = await store.getGame();
      const now = Date.now();
      if (TRUST_CLIENT_IP && g0.banned[ip]) return reply(ack, { ok: false, error: 'L\'hôte t\'a exclu de la partie.', code: 'banned' });
      if (!(askedId && g0.players[askedId])) {
        // nouveau joueur : code obligatoire, avec protection contre la force brute
        const blocked = (TRUST_CLIENT_IP && await store.count('pin:ip:' + ip) >= 5) || socketPinFails >= 5 || g0.joinLockedUntil > now;
        if (blocked) return reply(ack, { ok: false, error: 'Trop d\'essais ratés. Réessaie dans une minute.', code: 'pin' });
        if (pin !== g0.pin) {
          socketPinFails++;
          if (TRUST_CLIENT_IP) await store.incr('pin:ip:' + ip, 60000);
          if (await store.incr('pin:all', 60000) >= 20) {
            await store.reset('pin:all');
            await mutate((g, t) => { g.pin = game.newPin(); g.joinLockedUntil = t + 30000; });
            console.warn('⚠️  Trop de codes faux : nouveau code généré, entrées bloquées 30 s.');
          }
          return reply(ack, { ok: false, error: 'Code incorrect. Il est affiché sur l\'écran de l\'hôte.', code: 'pin' });
        }
        if (TRUST_CLIENT_IP) await store.reset('pin:ip:' + ip);
      }
      const r = await mutate((g, t) => {
        if (TRUST_CLIENT_IP && g.banned[ip]) return { ok: false, error: 'L\'hôte t\'a exclu de la partie.', code: 'banned' };
        let p = askedId && g.players[askedId];
        if (!p) {
          if (pin !== g.pin) return { ok: false, error: 'Le code vient de changer. Regarde l\'écran de l\'hôte.', code: 'pin' };
          if (g.locked) return { ok: false, error: 'Le salon est fermé par l\'hôte.' };
          if (Object.keys(g.players).length >= MAX_PLAYERS) return { ok: false, error: 'La partie est pleine.' };
          if (TRUST_CLIENT_IP && !isHostMachine(ip) && Object.values(g.players).filter((o) => o.ip === ip).length >= MAX_PER_DEVICE) {
            return { ok: false, error: 'Trop de joueurs depuis cet appareil.' };
          }
          const id = crypto.randomBytes(8).toString('hex');
          p = { id, name, avatar, ip, score: 0, streak: 0, correctCount: 0, totalTime: 0, lastPoints: 0, prevRank: 0, connected: true, gen: 0 };
          g.players[id] = p;
        }
        let finalName = name, n = 2;
        while (Object.values(g.players).some((o) => o.id !== p.id && o.name.toLowerCase() === finalName.toLowerCase())) finalName = `${name.slice(0, 13)} ${n++}`;
        Object.assign(p, { name: finalName, avatar, ip, connected: true, disconnectedAt: 0, seenAt: t, gen: (p.gen || 0) + 1 });
        return { ok: true, id: p.id, name: p.name, gen: p.gen };
      });
      if (r.ok) {
        socket.data.playerId = r.id;
        socket.data.gen = r.gen;
        socket.join('p:' + r.id);
      }
      reply(ack, { ok: r.ok, id: r.id, name: r.name, error: r.error, code: r.code });
    } catch (e) {
      console.error('Connexion joueur :', e.message);
      reply(ack, { ok: false, error: 'Erreur serveur, réessaie.' });
    }
  });

  socket.on('player:answer', async (data) => {
    const pid = socket.data.playerId;
    if (!pid || !data) return;
    try {
      const ok = await mutate((g, now) => {
        if (g.state !== 'question' || !g.players[pid] || data.index !== g.index || g.answers[pid]) return false;
        if (now > g.cur.endsAt + 300) return false;
        const q = g.cur.q;
        let a = data.answer;
        if (q.type === 'qcm') { a = Number(a); if (!Number.isInteger(a) || a < 0 || a >= g.cur.choices.length) return false; }
        else if (q.type === 'vraifaux') a = Boolean(a);
        else if (q.type === 'estimation') { a = Number(a); if (!Number.isFinite(a)) return false; }
        else if (q.type === 'texte') { a = clean(a, 80); if (!a) return false; }
        else if (q.type === 'ordre') {
          if (!Array.isArray(a) || a.length !== q.items.length) return false;
          a = a.map(Number);
          if (new Set(a).size !== a.length || a.some((x) => !Number.isInteger(x) || x < 0 || x >= q.items.length)) return false;
        }
        g.answers[pid] = { answer: a, timeMs: Math.max(0, Math.min(g.cur.time * 1000, now - g.cur.startedAt)) };
        game.checkAllAnswered(g, now);
        return true;
      });
      if (ok) socket.emit('answer:ok');
    } catch (e) { console.error('Réponse :', e.message); }
  });

  socket.on('player:leave', async () => {
    const pid = socket.data.playerId;
    if (!pid) return;
    socket.data.playerId = null;
    socket.leave('p:' + pid);
    try { await mutate((g, now) => { delete g.players[pid]; delete g.answers[pid]; game.checkAllAnswered(g, now); }); } catch (e) { /* */ }
  });

  socket.on('disconnect', async () => {
    const pid = socket.data.playerId;
    if (!pid) return;
    const gen = socket.data.gen;
    try {
      // d'autres onglets du même joueur encore connectés, sur n'importe quel réplica ?
      const others = await io.in('p:' + pid).fetchSockets();
      if (others.length) return;
      await mutate((g, now) => {
        const p = g.players[pid];
        if (!p || p.gen !== gen) return; // reconnecté entre-temps
        p.connected = false;
        p.disconnectedAt = now;
        game.checkAllAnswered(g, now);
      });
    } catch (e) { /* la réconciliation du leader corrigera */ }
  });
});

// ---------- Démarrage / arrêt ----------
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\n❌ Le port ${PORT} est déjà utilisé. Quinzo tourne peut-être déjà, ou change de port (variable PORT).\n`);
  else console.error(e);
  process.exit(1);
});

async function start() {
  await store.init();
  await themes.init();
  await auth.init();
  await store.ensureGame(game.createGame);
  if (MULTI) {
    const { createAdapter } = require('@socket.io/redis-adapter');
    io.adapter(createAdapter(store.duplicate(), store.duplicate(), { key: REDIS_PREFIX + 'sio' }));
    await leadLoop();
    setInterval(leadLoop, 2000).unref();
    setInterval(reconcilePresence, 10000).unref();
  }
  setInterval(tickLoop, 200).unref();

  server.listen(PORT, '0.0.0.0', async () => {
    const g = await store.getGame();
    const urls = joinUrls();
    const line = '─'.repeat(62);
    const local = `http://localhost:${PUBLIC_PORT}`;
    const base = PUBLIC_URL || local;
    console.log(`\n${line}\n  🎉  QUINZO est lancé !${IN_DOCKER ? ' (conteneur)' : ''}${MULTI ? ` — mode multi-réplicas (Redis), instance ${INSTANCE}` : ''}\n${line}`);
    console.log(`  🖥️  Écran hôte            : ${base}/host`);
    if (auth.enabled) console.log(`  👤 Admin                 : ${auth.record.user} (connexion par mot de passe activée)`);
    if (urls.length) {
      console.log(`  📱 Tes potes vont sur     : ${urls[0]}`);
      urls.slice(1).forEach((u) => console.log(`                   (ou)    : ${u}`));
    } else if (IN_DOCKER) console.log('  ⚠️  Adresse réseau inconnue : définis PUBLIC_HOST / PUBLIC_URL ou saisis-la sur l\'écran hôte.');
    else console.log('  ⚠️  Aucune adresse réseau détectée — es-tu connecté au Wi-Fi ?');
    console.log(`  🔑 Code de la partie      : ${g.pin}`);
    console.log(`  📚 ${themes.size} thèmes disponibles`);
    console.log(IN_DOCKER ? line : `${line}\n  Laisse cette fenêtre ouverte pendant la partie. Ctrl+C pour arrêter.\n`);
    if (env.NO_OPEN !== '1' && !IN_DOCKER) {
      const { exec } = require('child_process');
      const url = `${local}/host`;
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      exec(cmd, () => {});
    }
  });
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('Arrêt en cours…');
  setTimeout(() => process.exit(0), 3000).unref();
  try { if (MULTI) await store.releaseLead(INSTANCE); } catch (e) { /* */ }
  io.local.disconnectSockets(true); // les clients se reconnectent aussitôt sur un autre réplica
  server.close();
  await new Promise((r) => setTimeout(r, 300));
  await store.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch((e) => {
  console.error('❌ Démarrage impossible :', e.message);
  if (REDIS_URL) console.error('   Vérifie que Redis est joignable :', REDIS_URL.replace(/\/\/[^@]*@/, '//***@'));
  process.exit(1);
});
