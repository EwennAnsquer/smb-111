// Logique de partie « pure » : toutes les fonctions travaillent sur un objet d'état
// sérialisable en JSON (stocké en mémoire ou dans Redis). Aucun minuteur ici :
// les échéances sont des horodatages (endsAt, revealAt, autoNextAt) traités par tick().
const crypto = require('crypto');
const { evaluate, streakBonus, normText } = require('./scoring');
const { TYPES } = require('./themes');

const DEFAULT_SETTINGS = {
  themes: [], count: 10, time: 20, difficulty: 'all', types: [...TYPES],
  leaderboardEvery: true, shuffleChoices: true, autoNext: false,
};
const LOBBY_GRACE_MS = 20000; // délai avant de retirer un joueur déconnecté du salon
const REVEAL_GRACE_MS = 400; // tolérance réseau après la fin du chrono
const ALL_ANSWERED_DELAY_MS = 700;

function newPin() {
  if (/^\d{4,8}$/.test(process.env.PIN || '')) return process.env.PIN;
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

function createGame() {
  return {
    version: 0,
    state: 'lobby', // lobby | question | reveal | leaderboard | end
    settings: { ...DEFAULT_SETTINGS },
    players: {}, // id -> joueur
    questions: [], // [{ q, theme }] copiés au lancement (l'état se suffit à lui-même)
    index: -1,
    cur: null,
    answers: {}, // id joueur -> { answer, timeMs }
    reveal: null,
    pin: newPin(),
    locked: false,
    banned: {}, // ip -> pseudo
    joinLockedUntil: 0,
    revealAt: 0,
    autoNextAt: 0,
  };
}

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const players = (g) => Object.values(g.players);
function ranking(g) {
  return players(g).sort((a, b) => b.score - a.score || a.totalTime - b.totalTime || a.name.localeCompare(b.name));
}
function playerList(g) {
  return players(g).map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score, connected: p.connected, streak: p.streak }));
}
function rankedList(g) {
  return ranking(g).map((p, i) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score, rank: i + 1, prevRank: p.prevRank || i + 1, lastPoints: p.lastPoints || 0, streak: p.streak, correctCount: p.correctCount, connected: p.connected }));
}

/** Tire les questions selon les réglages, réparties équitablement entre les thèmes. */
function buildQuestions(settings, themeStore) {
  let pool = [];
  for (const id of settings.themes) {
    const t = themeStore.get(id);
    if (!t) continue;
    for (const q of t.questions) pool.push({ q, theme: { id: t.id, name: t.name, emoji: t.emoji, color: t.color } });
  }
  pool = pool.filter(({ q }) => settings.types.includes(q.type) && (settings.difficulty === 'all' || q.difficulty === settings.difficulty));
  const byTheme = new Map();
  for (const item of shuffle(pool)) {
    if (!byTheme.has(item.theme.id)) byTheme.set(item.theme.id, []);
    byTheme.get(item.theme.id).push(item);
  }
  const lists = shuffle([...byTheme.values()]);
  const out = [];
  while (out.length < settings.count && lists.some((l) => l.length)) {
    for (const l of lists) if (l.length && out.length < settings.count) out.push(l.shift());
  }
  return shuffle(out);
}

function prepareCurrent(g, item) {
  const { q } = item;
  const cur = { q, theme: item.theme, time: q.time || g.settings.time };
  if (q.type === 'qcm') {
    const idx = q.choices.map((_, i) => i);
    const order = g.settings.shuffleChoices ? shuffle(idx) : idx;
    cur.order = order;
    cur.choices = order.map((i) => q.choices[i]);
    cur.correctDisplay = order.indexOf(q.answer);
  } else if (q.type === 'ordre') {
    const idx = q.items.map((_, i) => i);
    let order = shuffle(idx);
    let tries = 0;
    while (order.every((v, i) => v === i) && tries++ < 10) order = shuffle(idx);
    cur.order = order;
    cur.items = order.map((i) => q.items[i]);
  }
  return cur;
}

function publicQuestion(g) {
  const c = g.cur;
  if (!c) return null;
  const q = c.q;
  const pq = { type: q.type, question: q.question, image: q.image || null, difficulty: q.difficulty, time: c.time, theme: c.theme };
  if (q.type === 'qcm') pq.choices = c.choices;
  if (q.type === 'ordre') pq.items = c.items;
  if (q.type === 'estimation') { pq.unit = q.unit || ''; if (q.min !== undefined) { pq.min = q.min; pq.max = q.max; } }
  return pq;
}

function fmtNum(n) {
  n = Number(n);
  return Math.abs(n) < 10000 ? String(n).replace('.', ',') : n.toLocaleString('fr-FR');
}
function answerText(q) {
  switch (q.type) {
    case 'qcm': return q.choices[q.answer];
    case 'vraifaux': return q.answer ? 'Vrai' : 'Faux';
    case 'estimation': return `${fmtNum(q.answer)}${q.unit ? ' ' + q.unit : ''}`;
    case 'ordre': return q.items.join(' → ');
    case 'texte': return q.answer[0];
    default: return '';
  }
}
function formatGiven(q, cur, a) {
  if (a === undefined || a === null) return null;
  switch (q.type) {
    case 'qcm': return cur.choices[a] ?? null;
    case 'vraifaux': return a ? 'Vrai' : 'Faux';
    case 'estimation': return `${fmtNum(a)}${q.unit ? ' ' + q.unit : ''}`;
    case 'ordre': return Array.isArray(a) ? a.map((d) => cur.items[d]).join(' → ') : null;
    default: return String(a);
  }
}

/** Vue envoyée à un client : l'hôte voit tout, un joueur ne voit jamais les réponses avant la révélation. */
function viewFor(g, playerId, isHost, { trustIp = true, now = Date.now() } = {}) {
  const v = {
    state: g.state,
    index: g.index,
    total: g.questions.length,
    players: playerList(g),
    playerCount: players(g).filter((p) => p.connected).length,
  };
  if (isHost) {
    v.settings = g.settings;
    v.pin = g.pin;
    v.locked = g.locked;
    v.banned = Object.values(g.banned);
    v.trustIp = trustIp;
  }
  if (g.state === 'question' || g.state === 'reveal') {
    v.question = publicQuestion(g);
    v.remaining = g.state === 'question' && g.cur ? Math.max(0, g.cur.endsAt - now) : 0;
    v.answered = Object.keys(g.answers);
  }
  if (g.state === 'reveal' && g.reveal) {
    const r = g.reveal;
    v.reveal = isHost ? r : { correctText: r.correctText, explanation: r.explanation, correctIndex: r.correctIndex, correctOrder: r.correctOrder, answerValue: r.answerValue, details: r.details, rows: r.rows, stats: r.stats, answeredCount: r.answeredCount };
  }
  if (['leaderboard', 'end', 'reveal'].includes(g.state)) v.leaderboard = rankedList(g);
  if (playerId) {
    const p = g.players[playerId];
    if (p) {
      const rank = ranking(g).findIndex((x) => x.id === p.id) + 1;
      v.me = { id: p.id, name: p.name, avatar: p.avatar, score: p.score, rank, streak: p.streak, correctCount: p.correctCount };
      if (g.state === 'question') {
        const a = g.answers[p.id];
        v.me.answered = !!a;
        if (a) v.me.answer = a.answer;
      }
      if (g.state === 'reveal' && g.reveal) v.me.result = g.reveal.results[p.id] || { correct: false, points: 0, given: null, missed: true };
    }
  }
  return v;
}

function startQuestion(g, now) {
  g.cur = prepareCurrent(g, g.questions[g.index]);
  g.cur.startedAt = now;
  g.cur.endsAt = now + g.cur.time * 1000;
  g.answers = {};
  g.reveal = null;
  g.revealAt = 0;
  g.autoNextAt = 0;
  g.state = 'question';
}

function doReveal(g, now) {
  if (g.state !== 'question') return false;
  const cur = g.cur, q = cur.q;
  const totalMs = cur.time * 1000;
  const results = {};
  const rows = [];
  const before = ranking(g).map((p) => p.id);
  for (const p of players(g)) p.prevRank = before.indexOf(p.id) + 1;
  for (const p of players(g)) {
    const a = g.answers[p.id];
    const ev = a ? evaluate(cur, a.answer, a.timeMs, totalMs) : { correct: false, base: 0 };
    if (ev.correct) { p.streak += 1; p.correctCount += 1; } else p.streak = 0;
    const bonus = ev.correct ? streakBonus(p.streak) : 0;
    const points = ev.base + bonus;
    p.score += points;
    p.lastPoints = points;
    if (a) p.totalTime += a.timeMs;
    const given = a ? formatGiven(q, cur, a.answer) : null;
    results[p.id] = { correct: ev.correct, partial: !!ev.partial, points, bonus, streak: p.streak, given, missed: !a, timeMs: a ? a.timeMs : null, good: ev.good };
    rows.push({ id: p.id, name: p.name, avatar: p.avatar, ...results[p.id], raw: a ? a.answer : null });
  }
  const stats = {};
  if (q.type === 'qcm') stats.counts = cur.choices.map((_, i) => rows.filter((r) => r.raw === i).length);
  if (q.type === 'vraifaux') stats.counts = [rows.filter((r) => r.raw === true).length, rows.filter((r) => r.raw === false).length];
  if (q.type === 'estimation') stats.guesses = rows.filter((r) => r.raw !== null).map((r) => ({ name: r.name, avatar: r.avatar, value: Number(r.raw), points: r.points })).sort((a, b) => Math.abs(a.value - q.answer) - Math.abs(b.value - q.answer));
  if (q.type === 'texte') {
    const groups = new Map();
    rows.filter((r) => r.raw !== null).forEach((r) => {
      const k = normText(r.raw) || String(r.raw);
      if (!groups.has(k)) groups.set(k, { text: String(r.raw), count: 0, correct: r.correct, names: [] });
      const gr = groups.get(k); gr.count++; gr.names.push(r.name);
    });
    stats.groups = [...groups.values()].sort((a, b) => b.correct - a.correct || b.count - a.count);
  }
  if (q.type === 'ordre') stats.perfect = rows.filter((r) => r.correct).length;
  g.reveal = {
    correctText: answerText(q),
    explanation: q.explanation || '',
    correctIndex: q.type === 'qcm' ? cur.correctDisplay : q.type === 'vraifaux' ? (q.answer ? 0 : 1) : null,
    correctOrder: q.type === 'ordre' ? q.items : null,
    details: q.type === 'ordre' ? (q.details || null) : null,
    answerValue: q.type === 'estimation' ? q.answer : null,
    results,
    rows: rows.map(({ raw, ...r }) => r).sort((a, b) => b.points - a.points),
    stats,
    answeredCount: Object.keys(g.answers).length,
  };
  g.state = 'reveal';
  g.revealAt = 0;
  g.autoNextAt = g.settings.autoNext ? now + 7000 : 0;
  return true;
}

function next(g, now) {
  g.autoNextAt = 0;
  if (g.state === 'reveal') {
    if (g.index >= g.questions.length - 1) { g.state = 'end'; return true; }
    if (g.settings.leaderboardEvery) {
      g.state = 'leaderboard';
      if (g.settings.autoNext) g.autoNextAt = now + 5000;
      return true;
    }
  }
  if (g.state === 'reveal' || g.state === 'leaderboard') {
    g.index += 1;
    startQuestion(g, now);
    return true;
  }
  return false;
}

function resetScores(g) {
  for (const p of players(g)) Object.assign(p, { score: 0, streak: 0, correctCount: 0, totalTime: 0, lastPoints: 0, prevRank: 0 });
}

function startGame(g, questions, now) {
  for (const [id, p] of Object.entries(g.players)) if (!p.connected) delete g.players[id];
  resetScores(g);
  g.questions = questions;
  g.index = 0;
  startQuestion(g, now);
}

function endGame(g) {
  if (g.state === 'lobby') return false;
  g.state = 'end';
  g.revealAt = 0;
  g.autoNextAt = 0;
  return true;
}

function toLobby(g) {
  Object.assign(g, { state: 'lobby', index: -1, cur: null, questions: [], reveal: null, answers: {}, revealAt: 0, autoNextAt: 0 });
  resetScores(g);
  for (const [id, p] of Object.entries(g.players)) if (!p.connected) delete g.players[id];
}

/** Si tous les joueurs connectés ont répondu, programme la révélation un peu plus tôt. */
function checkAllAnswered(g, now) {
  if (g.state !== 'question') return;
  const active = players(g).filter((p) => p.connected);
  if (active.length && active.every((p) => g.answers[p.id])) {
    if (!g.revealAt) g.revealAt = now + ALL_ANSWERED_DELAY_MS;
  }
}

/** Une échéance est-elle atteinte ? (lecture seule, pour éviter de verrouiller inutilement) */
function needsTick(g, now) {
  if (!g) return false;
  if (g.state === 'question' && g.cur && (now >= g.cur.endsAt + REVEAL_GRACE_MS || (g.revealAt && now >= g.revealAt))) return true;
  if (g.autoNextAt && now >= g.autoNextAt) return true;
  if (g.state === 'lobby' && players(g).some((p) => !p.connected && p.disconnectedAt && now - p.disconnectedAt > LOBBY_GRACE_MS)) return true;
  return false;
}

/** Traite les échéances. Appelé par l'instance « leader » uniquement. */
function tick(g, now) {
  let changed = false;
  if (g.state === 'question' && g.cur && (now >= g.cur.endsAt + REVEAL_GRACE_MS || (g.revealAt && now >= g.revealAt))) changed = doReveal(g, now) || changed;
  if (g.autoNextAt && now >= g.autoNextAt) changed = next(g, now) || changed;
  if (g.state === 'lobby') {
    for (const [id, p] of Object.entries(g.players)) {
      if (!p.connected && p.disconnectedAt && now - p.disconnectedAt > LOBBY_GRACE_MS) { delete g.players[id]; changed = true; }
    }
  }
  return changed;
}

module.exports = {
  DEFAULT_SETTINGS, createGame, newPin, buildQuestions, viewFor, startGame, startQuestion, doReveal, next,
  endGame, toLobby, checkAllAnswered, needsTick, tick, ranking, players,
};
