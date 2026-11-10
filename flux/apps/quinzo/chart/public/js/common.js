// Utilitaires partagés par les pages.

// Appels /api/ : en-tête anti-CSRF ; sur une page admin, une session expirée renvoie vers la connexion.
if (window.fetch) {
  const _fetch = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    const isApi = typeof url === 'string' && url.startsWith('/api/');
    if (isApi) opts = { ...opts, credentials: 'same-origin', headers: { ...(opts.headers || {}), 'X-Quinzo': '1' } };
    const res = await _fetch(url, opts);
    if (isApi && res.status === 401 && window.QUINZO_ADMIN_PAGE && !url.startsWith('/api/login')) {
      location.replace('/login?next=' + encodeURIComponent(location.pathname));
    }
    return res;
  };
}
// Socket.IO : WebSocket d'abord (une seule connexion, robuste derrière un répartiteur), repli en long-polling.
const SOCKET_OPTS = { transports: ['websocket', 'polling'], reconnectionDelay: 500, reconnectionDelayMax: 3000 };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const SHAPES = ['▲', '◆', '●', '■', '★', '⬟'];
const TYPE_LABELS = { qcm: 'QCM', vraifaux: 'Vrai / Faux', estimation: 'Estimation', ordre: 'Remettre dans l\'ordre', texte: 'Réponse libre' };
const TYPE_ICONS = { qcm: '🔠', vraifaux: '⚖️', estimation: '🎯', ordre: '🔢', texte: '⌨️' };
const AVATARS = ['🦊', '🐼', '🐸', '🦁', '🐯', '🐨', '🐵', '🦄', '🐙', '🦖', '🐧', '🦉', '🐝', '🐳', '🦩', '🐲', '👽', '🤖', '👻', '🎃', '🍕', '🌮', '🍩', '🥑', '⚡', '🔥', '🌈', '⭐', '🎸', '🚀', '😎', '🤠'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) {
  n = Number(n);
  if (Math.abs(n) < 10000) return String(Math.round(n * 100) / 100).replace('.', ',');
  return n.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
}
function toast(msg, isErr = false, ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function show(id) {
  $$('[data-screen]').forEach((s) => s.classList.toggle('hidden', s.dataset.screen !== id));
}

// Compte à rebours fluide basé sur l'heure de fin locale.
class Countdown {
  constructor(onTick) { this.onTick = onTick; this.raf = null; }
  start(remainingMs, totalMs) {
    this.stop();
    this.endsAt = performance.now() + remainingMs;
    this.total = totalMs;
    const loop = () => {
      const left = Math.max(0, this.endsAt - performance.now());
      this.onTick(left, Math.min(1, left / this.total));
      if (left > 0) this.raf = requestAnimationFrame(loop);
    };
    loop();
  }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; }
}

// Petits sons synthétisés (pas de fichiers nécessaires).
const Sound = {
  ctx: null,
  on: true,
  init() { if (!this.ctx) try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.on = false; } },
  tone(freq, dur = 0.12, type = 'sine', vol = 0.15, when = 0) {
    if (!this.on) return;
    this.init();
    if (!this.ctx) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.ctx.destination); o.start(t); o.stop(t + dur + 0.02);
  },
  tick() { this.tone(880, 0.06, 'square', 0.05); },
  start() { [523, 659, 784].forEach((f, i) => this.tone(f, 0.15, 'triangle', 0.15, i * 0.09)); },
  reveal() { [392, 523, 659, 784].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.14, i * 0.07)); },
  good() { [659, 988].forEach((f, i) => this.tone(f, 0.16, 'triangle', 0.15, i * 0.09)); },
  bad() { [220, 165].forEach((f, i) => this.tone(f, 0.22, 'sawtooth', 0.07, i * 0.12)); },
  fanfare() { [523, 523, 523, 659, 784, 1047].forEach((f, i) => this.tone(f, i === 5 ? 0.5 : 0.14, 'triangle', 0.16, i * 0.13)); },
  join() { this.tone(1200, 0.08, 'sine', 0.08); },
};
