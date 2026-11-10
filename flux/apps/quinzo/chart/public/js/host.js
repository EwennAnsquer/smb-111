// Écran hôte (grand écran / PC qui héberge).
window.QUINZO_ADMIN_PAGE = true;
const socket = io(SOCKET_OPTS);
let S = null;
let themes = [];
let renderedKey = '';
let lastSec = null;
const saved = (() => { try { return JSON.parse(localStorage.getItem('quinzo_host_settings') || 'null'); } catch (e) { return null; } })();
let settings = Object.assign({ themes: [], count: 10, time: 20, difficulty: 'all', types: ['qcm', 'vraifaux', 'estimation', 'ordre', 'texte'], leaderboardEvery: true, shuffleChoices: true, autoNext: false }, saved || {});
Sound.on = localStorage.getItem('quinzo_sound') !== '0';
$('#soundBtn').textContent = Sound.on ? '🔊' : '🔇';

const ARC = 377;
const countdown = new Countdown((left, ratio) => {
  $('#ringArc').setAttribute('stroke-dashoffset', String(ARC * (1 - ratio)));
  const sec = Math.ceil(left / 1000);
  $('#ringSec').textContent = sec;
  $('#pRing').classList.toggle('low', left > 0 && left <= 5000);
  if (sec !== lastSec) {
    if (left > 0 && sec <= 5 && S && S.state === 'question') Sound.tick();
    lastSec = sec;
  }
});

// ---------- Connexion ----------
socket.on('connect', () => {
  socket.emit('host:hello', (r) => {
    if (!r || !r.ok) { location.replace('/login?next=/host'); return; }
    show('lobby');
    socket.emit('host:settings', settings);
  });
});
socket.on('themes:changed', loadThemes);
socket.on('auth:expired', () => location.replace('/login?next=/host'));
// déconnecté par le serveur (déconnexion, mot de passe changé) : on vérifie la session
socket.on('disconnect', (reason) => {
  if (reason === 'io server disconnect') fetch('/api/me').then((r) => r.json()).then((me) => { if (!me.authenticated) location.replace('/login?next=/host'); else socket.connect(); });
});

// ---------- Compte admin ----------
fetch('/api/me').then((r) => r.json()).then((me) => {
  // sans mot de passe configuré : pas de compte, on masque les boutons de session
  ['#userChip', '#pwdBtn', '#logoutBtn'].forEach((sel) => $(sel).classList.toggle('hidden', !me.authEnabled));
  if (!me.authEnabled || !me.authenticated) return;
  $('#userChip').textContent = '👤 ' + me.user;
  $('#pwdBtn').title = 'Mot de passe géré par la configuration du serveur';
  $('#pwdBtn').disabled = true;
});
$('#logoutBtn').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.replace('/login');
};
$('#pwdBtn').onclick = () => { $('#pwdForm').reset(); $('#pwdErr').textContent = ''; $('#pwdDlg').showModal(); };
$('#pwdForm').onsubmit = async (e) => {
  e.preventDefault();
  const cur = $('#pwdCur').value, n1 = $('#pwdNew').value, n2 = $('#pwdNew2').value;
  if (n1 !== n2) { $('#pwdErr').textContent = 'Les deux nouveaux mots de passe ne correspondent pas.'; return; }
  const r = await fetch('/api/admin/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current: cur, next: n1 }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { $('#pwdErr').textContent = data.error || 'Erreur'; return; }
  $('#pwdDlg').close();
  toast('🔑 Mot de passe changé. Les autres sessions sont déconnectées.');
};

let baseUrl = null, qrPin = null, qrBase = null;
async function updateQr(pin) {
  if (!baseUrl || !pin || (pin === qrPin && baseUrl === qrBase)) return;
  qrPin = pin; qrBase = baseUrl;
  try {
    const r = await (await fetch('/api/qr?url=' + encodeURIComponent(`${baseUrl}/?pin=${pin}`))).json();
    if (r.qr) { $('#qr').src = r.qr; $('#qr').classList.remove('hidden'); }
  } catch (e) { /* QR facultatif */ }
}
async function loadInfo() {
  try {
    const info = await (await fetch('/api/info')).json();
    let manual = null;
    try { manual = localStorage.getItem('quinzo_public_url'); } catch (e) { /* */ }
    if (manual) info.urls = [manual, ...info.urls.filter((u) => u !== manual)];
    if (info.urls.length) {
      baseUrl = info.urls[0];
      $('#joinUrl').textContent = info.urls[0].replace('http://', '');
      if (S && S.pin) updateQr(S.pin);
      if (info.urls.length > 1) $('#otherUrls').innerHTML = 'Si ça ne marche pas, essayez : ' + info.urls.slice(1).map((u) => `<b>${esc(u.replace('http://', ''))}</b>`).join(' ou ');
    } else {
      $('#joinUrl').textContent = 'Adresse inconnue';
      $('#otherUrls').innerHTML = info.docker
        ? 'Quinzo tourne dans Docker : clique sur « ✏️ Adresse » et tape l\'IP de ce PC (ex. 192.168.1.42).'
        : 'Connecte ce PC au Wi-Fi / à la box puis recharge la page, ou clique sur « ✏️ Adresse ».';
    }
  } catch (e) { /* hors-ligne */ }
}
async function loadThemes() {
  try { themes = await (await fetch('/api/themes')).json(); } catch (e) { themes = []; }
  const ids = new Set(themes.map((t) => t.id));
  settings.themes = settings.themes.filter((id) => ids.has(id));
  if (!settings.themes.length && themes.length && !saved) settings.themes = themes.slice(0, 4).map((t) => t.id);
  renderThemes();
  pushSettings();
}

// ---------- Réglages ----------
function pushSettings() {
  try { localStorage.setItem('quinzo_host_settings', JSON.stringify(settings)); } catch (e) { /* */ }
  socket.emit('host:settings', settings);
  renderSettings();
}
function renderThemes() {
  const grid = $('#themesGrid');
  grid.innerHTML = '';
  $('#noThemeMsg').classList.toggle('hidden', themes.length > 0);
  themes.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'theme-card' + (settings.themes.includes(t.id) ? ' sel' : '');
    if (t.color) b.style.setProperty('--tc', t.color);
    b.innerHTML = `<span class="em">${esc(t.emoji)}</span><span class="nm">${esc(t.name)}</span><span class="ct">${t.count} question${t.count > 1 ? 's' : ''}</span>`;
    b.title = t.description || '';
    b.onclick = () => {
      settings.themes = settings.themes.includes(t.id) ? settings.themes.filter((x) => x !== t.id) : [...settings.themes, t.id];
      b.classList.toggle('sel');
      pushSettings();
    };
    grid.appendChild(b);
  });
}
function poolSize() {
  let n = 0;
  themes.filter((t) => settings.themes.includes(t.id)).forEach((t) => {
    // estimation (types et difficulté filtrés séparément, approximatif mais parlant)
    const typeCount = settings.types.reduce((s, ty) => s + (t.types[ty] || 0), 0);
    const ratio = settings.difficulty === 'all' ? 1 : (t.diffs[settings.difficulty] || 0) / (t.count || 1);
    n += Math.round(typeCount * ratio);
  });
  return n;
}
function renderSettings() {
  $('#sCount').value = settings.count;
  $('#sCountV').textContent = settings.count;
  $$('#sTime button').forEach((b) => b.classList.toggle('on', +b.dataset.v === settings.time));
  $$('#sDiff button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.difficulty));
  $$('#sTypes .tgl').forEach((b) => b.classList.toggle('on', settings.types.includes(b.dataset.t)));
  $$('#sOpts .tgl').forEach((b) => b.classList.toggle('on', !!settings[b.dataset.k]));
  const pool = poolSize();
  $('#poolInfo').textContent = settings.themes.length ? `≈ ${pool} questions disponibles avec ces réglages` : 'Sélectionne au moins un thème';
  $('#startBtn').disabled = !settings.themes.length || pool === 0;
}
Object.entries(TYPE_LABELS).forEach(([t, label]) => {
  const b = document.createElement('button');
  b.className = 'tgl'; b.dataset.t = t;
  b.textContent = `${TYPE_ICONS[t]} ${label}`;
  b.onclick = () => {
    settings.types = settings.types.includes(t) ? settings.types.filter((x) => x !== t) : [...settings.types, t];
    if (!settings.types.length) settings.types = [t];
    pushSettings();
  };
  $('#sTypes').appendChild(b);
});
$('#sCount').oninput = (e) => { settings.count = +e.target.value; $('#sCountV').textContent = settings.count; };
$('#sCount').onchange = () => pushSettings();
$$('#sTime button').forEach((b) => (b.onclick = () => { settings.time = +b.dataset.v; pushSettings(); }));
$$('#sDiff button').forEach((b) => (b.onclick = () => { settings.difficulty = b.dataset.v; pushSettings(); }));
$$('#sOpts .tgl').forEach((b) => (b.onclick = () => { settings[b.dataset.k] = !settings[b.dataset.k]; pushSettings(); }));
$('#allThemes').onclick = () => { settings.themes = themes.map((t) => t.id); renderThemes(); pushSettings(); };
$('#noThemes').onclick = () => { settings.themes = []; renderThemes(); pushSettings(); };

// ---------- Actions ----------
function start() {
  Sound.init();
  socket.emit('host:start', (r) => {
    if (!r || !r.ok) return toast((r && r.error) || 'Impossible de lancer', true, 4000);
    Sound.start();
    if (r.count < settings.count) toast(`Seulement ${r.count} questions disponibles avec ces réglages`);
  });
}
$('#startBtn').onclick = start;
$('#replayBtn').onclick = start;
$('#lobbyBtn').onclick = () => socket.emit('host:lobby');
$('#lbNext').onclick = () => socket.emit('host:next');
$('#endBtn').onclick = () => { if (confirm('Terminer la partie maintenant et afficher le podium ?')) socket.emit('host:end'); };
$('#mainBtn').onclick = () => socket.emit(S && S.state === 'question' ? 'host:reveal' : 'host:next');
$('#soundBtn').onclick = () => { Sound.on = !Sound.on; localStorage.setItem('quinzo_sound', Sound.on ? '1' : '0'); $('#soundBtn').textContent = Sound.on ? '🔊' : '🔇'; };
$('#fsBtn').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {}));
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    if (!S) return;
    if (S.state === 'lobby') !$('#startBtn').disabled && start();
    else if (S.state === 'question') socket.emit('host:reveal');
    else if (S.state === 'reveal' || S.state === 'leaderboard') socket.emit('host:next');
  }
  if (e.key === 'f' || e.key === 'F') $('#fsBtn').click();
});

// ---------- Rendu ----------
const STATUS = { lobby: 'Salon', question: 'Question en cours', reveal: 'Réponse', leaderboard: 'Classement', end: 'Terminé' };
socket.on('state', (st) => {
  const prev = S;
  S = st;
  $('#statusChip').textContent = STATUS[st.state] || st.state;
  renderAccess(st);
  const key = st.state + ':' + st.index;
  if (st.state === 'lobby') { show('lobby'); countdown.stop(); renderPlayers(st); if (prev && prev.state !== 'lobby') renderSettings(); }
  else if (st.state === 'question') { if (key !== renderedKey) renderQuestion(st); else updateAnswered(st); }
  else if (st.state === 'reveal') { if (key !== renderedKey) { renderQuestion(st); renderReveal(st); Sound.reveal(); } }
  else if (st.state === 'leaderboard') { if (key !== renderedKey) renderLeaderboard(st); }
  else if (st.state === 'end') { if (key !== renderedKey) { renderEnd(st); Sound.fanfare(); } }
  renderedKey = key;
});

function renderAccess(st) {
  $('#pinBig').textContent = st.pin;
  $('#pinChip').textContent = `🔑 ${st.pin}${st.locked ? ' · 🔒 fermé' : ''}`;
  updateQr(st.pin);
  const lock = $('#lockBtn');
  lock.textContent = st.locked ? '🔒 Salon fermé' : '🔓 Salon ouvert';
  lock.title = st.locked ? 'Personne de nouveau ne peut entrer. Cliquer pour rouvrir.' : 'Cliquer pour empêcher de nouveaux joueurs d\'entrer';
  lock.classList.toggle('locked', !!st.locked);
  const bl = $('#bannedLine');
  bl.classList.toggle('hidden', !st.banned.length);
  if (st.banned.length) {
    bl.innerHTML = `🚫 Exclus : ${st.banned.map(esc).join(', ')} <button class="btn small" id="unbanBtn" style="margin-left:6px">Tout débannir</button>`;
    $('#unbanBtn').onclick = () => socket.emit('host:unban');
  }
}
$('#addrBtn').onclick = () => {
  const cur = baseUrl ? baseUrl.replace('http://', '') : '';
  const v = prompt('Adresse de ce PC sur le réseau (IP, et le port si ce n\'est pas 3000)\nExemple : 192.168.1.42 ou 192.168.1.42:3000\nLaisse vide pour revenir à la détection automatique.', cur);
  if (v === null) return;
  const t = v.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  try {
    if (!t) localStorage.removeItem('quinzo_public_url');
    else localStorage.setItem('quinzo_public_url', 'http://' + (t.includes(':') || !location.port ? t : t + ':' + location.port));
  } catch (e) { /* */ }
  loadInfo();
};
$('#newPinBtn').onclick = () => { if (confirm('Générer un nouveau code ? Les joueurs déjà connectés restent dans la partie.')) socket.emit('host:newpin'); };
$('#lockBtn').onclick = () => socket.emit('host:lock', !(S && S.locked));

let knownPlayers = new Set();
function renderPlayers(st) {
  const box = $('#players');
  $('#plCount').textContent = st.players.length;
  if (!st.players.length) { box.innerHTML = '<span class="muted">En attente de joueurs…</span>'; knownPlayers = new Set(); return; }
  const ids = new Set(st.players.map((p) => p.id));
  if ([...ids].some((id) => !knownPlayers.has(id))) Sound.join();
  knownPlayers = ids;
  box.innerHTML = st.players.map((p) => `<span class="pl ${p.connected ? '' : 'off'}" title="Cliquer pour retirer"><span class="av">${esc(p.avatar)}</span>${esc(p.name)}<button class="x" data-kick="${esc(p.id)}">✕</button></span>`).join('');
  $$('[data-kick]', box).forEach((b) => (b.onclick = () => { if (confirm(S.trustIp ? 'Retirer ce joueur ? Il ne pourra plus revenir depuis cet appareil (sauf si tu le débannis).' : 'Retirer ce joueur ? Un nouveau code sera généré pour l\'empêcher de revenir (les autres restent connectés).')) {
    socket.emit('host:kick', b.dataset.kick, (r) => { if (r && r.newPin) toast('Joueur retiré — nouveau code : ' + S.pin, false, 4000); });
  } }));
}

function renderQuestion(st) {
  show('play');
  const q = st.question;
  $('#pTheme').textContent = `${q.theme.emoji} ${q.theme.name}`;
  $('#pNum').textContent = `Question ${st.index + 1} / ${st.total}`;
  $('#pType').textContent = `${TYPE_ICONS[q.type]} ${TYPE_LABELS[q.type]}`;
  $('#pDiff').innerHTML = `<span class="diff ${q.difficulty}">${q.difficulty}</span>`;
  $('#pText').textContent = q.question;
  const img = $('#pImg');
  if (q.image) { img.src = q.image; img.classList.remove('hidden'); } else img.classList.add('hidden');
  $('#pRing').classList.toggle('hidden', st.state !== 'question');
  $('#mainBtn').textContent = st.state === 'question' ? 'Révéler maintenant' : (st.index + 1 >= st.total ? 'Voir le podium 🏆' : 'Suivant ▶');
  const box = $('#pAnswers');
  if (q.type === 'qcm' || q.type === 'vraifaux') {
    const labels = q.type === 'qcm' ? q.choices : ['Vrai', 'Faux'];
    box.innerHTML = `<div class="choices">${labels.map((l, i) => {
      const c = q.type === 'vraifaux' ? (i ? 0 : 3) : i;
      const shape = q.type === 'vraifaux' ? (i ? '✗' : '✓') : SHAPES[i];
      return `<div class="choice c${c} slide-up" style="animation-delay:${i * 0.08}s" data-i="${i}"><span class="shape">${shape}</span><span>${esc(l)}</span></div>`;
    }).join('')}</div>`;
  } else if (q.type === 'ordre') {
    box.innerHTML = `<div class="order-list" style="max-width:900px;margin:0 auto">${q.items.map((it, i) => `<div class="order-item slide-up" style="animation-delay:${i * 0.06}s"><span class="num">?</span><span>${esc(it)}</span></div>`).join('')}</div>`;
  } else if (q.type === 'estimation') {
    box.innerHTML = `<div class="hint"><span class="em">🎯</span>Estimez au plus près${q.unit ? ` (en ${esc(q.unit)})` : ''} !${q.min !== undefined ? `<div class="muted" style="font-size:.55em;margin-top:8px">entre ${fmt(q.min)} et ${fmt(q.max)}</div>` : ''}</div>`;
  } else if (q.type === 'texte') {
    box.innerHTML = '<div class="hint"><span class="em">⌨️</span>Tapez votre réponse sur votre appareil !</div>';
  }
  if (st.state === 'question') {
    lastSec = null;
    countdown.start(st.remaining, q.time * 1000);
  } else countdown.stop();
  updateAnswered(st);
}
function updateAnswered(st) {
  const total = st.playerCount;
  const n = st.answered ? st.answered.length : 0;
  $('#pAnswered').textContent = `✋ ${n} / ${total} ont répondu`;
  const byId = Object.fromEntries(st.players.map((p) => [p.id, p]));
  $('#pAvs').innerHTML = (st.answered || []).map((id) => byId[id] ? `<span title="${esc(byId[id].name)}">${esc(byId[id].avatar)}</span>` : '').join('');
}

function renderReveal(st) {
  const q = st.question, rv = st.reveal;
  const box = $('#pAnswers');
  let main = '';
  if (q.type === 'qcm' || q.type === 'vraifaux') {
    $$('.choice', box).forEach((el) => {
      const i = +el.dataset.i;
      el.classList.remove('slide-up');
      el.classList.toggle('dim', i !== rv.correctIndex);
      el.classList.toggle('right', i === rv.correctIndex);
      el.insertAdjacentHTML('beforeend', `<span class="count">${rv.stats.counts[i]} ✋</span>`);
    });
    main = box.innerHTML;
  } else if (q.type === 'ordre') {
    main = `<div class="order-list" style="max-width:900px">${rv.correctOrder.map((it, i) => `<div class="order-item set slide-up" style="animation-delay:${i * 0.12}s"><span class="num">${i + 1}</span><span>${esc(it)}</span>${rv.details ? `<span class="detail">${esc(rv.details[i])}</span>` : ''}</div>`).join('')}</div>
      <p class="muted" style="font-weight:800;margin-top:12px">${rv.stats.perfect} joueur${rv.stats.perfect > 1 ? 's' : ''} ${rv.stats.perfect > 1 ? 'ont' : 'a'} tout bon</p>`;
  } else if (q.type === 'estimation') {
    main = `<div class="big-answer pop"><small>Bonne réponse</small><div class="val">${esc(rv.correctText)}</div></div>
      <div class="guesses">${rv.stats.guesses.map((g, i) => `<div class="guess slide-up" style="animation-delay:${i * 0.05}s"><span>${i === 0 ? '🎯' : esc(g.avatar)}</span><span>${esc(g.name)}</span><span class="v">${fmt(g.value)}${q.unit ? ' ' + esc(q.unit) : ''}</span><span class="p">+${fmt(g.points)}</span></div>`).join('') || '<span class="muted">Personne n\'a répondu</span>'}</div>`;
  } else if (q.type === 'texte') {
    main = `<div class="big-answer pop"><small>Bonne réponse</small><div class="val">${esc(rv.correctText)}</div></div>
      <div class="groups">${rv.stats.groups.map((g) => `<span class="group ${g.correct ? 'ok' : 'ko'}">${g.correct ? '✓' : '✗'} ${esc(g.text)}${g.count > 1 ? ` ×${g.count}` : ''}</span>`).join('') || '<span class="muted">Personne n\'a répondu</span>'}</div>`;
  }
  const rows = rv.rows;
  box.innerHTML = `<div class="reveal-grid">
    <div>${main}${rv.explanation ? `<div class="explain slide-up">💡 ${esc(rv.explanation)}</div>` : ''}</div>
    <div class="side"><h3>Cette question</h3>${rows.map((r) => `<div class="round-row ${r.points ? '' : 'ko'} slide-up"><span>${esc(r.avatar)}</span><span class="nm">${esc(r.name)}<small>${r.missed ? 'pas de réponse' : esc(r.given)}</small></span><span>${r.missed ? '⏱️' : r.correct ? '✅' : r.points ? '🟡' : '❌'}</span><span class="p">+${fmt(r.points)}</span></div>`).join('') || '<span class="muted">Aucun joueur</span>'}</div>
  </div>`;
  $('#pAnswered').textContent = `✋ ${rv.answeredCount} / ${st.playerCount} ont répondu`;
  $('#pAvs').innerHTML = '';
}

function lbHtml(list, limit = 10) {
  return list.slice(0, limit).map((p, i) => {
    const mv = p.prevRank - p.rank;
    const move = mv > 0 ? `<span class="move" style="color:var(--good)">▲${mv}</span>` : mv < 0 ? `<span class="move" style="color:var(--bad)">▼${-mv}</span>` : '<span class="move muted">•</span>';
    return `<div class="lb-row r${p.rank} slide-up" style="animation-delay:${i * 0.06}s"><span class="rank">${p.rank}</span>${move}<span class="av">${esc(p.avatar)}</span><span class="nm">${esc(p.name)}${p.streak >= 2 ? ` <span title="série">🔥${p.streak}</span>` : ''}</span>${p.lastPoints ? `<span class="delta">+${fmt(p.lastPoints)}</span>` : '<span class="delta"></span>'}<span class="sc">${fmt(p.score)}</span></div>`;
  }).join('') || '<p class="muted center">Aucun joueur</p>';
}
function renderLeaderboard(st) {
  show('leaderboard');
  countdown.stop();
  $('#lbList').innerHTML = lbHtml(st.leaderboard);
  $('#lbNext').textContent = `Question ${st.index + 2} / ${st.total} ▶`;
}
function renderEnd(st) {
  show('end');
  countdown.stop();
  const lb = st.leaderboard;
  const order = [lb[1], lb[0], lb[2]];
  $('#podium').innerHTML = order.map((p, i) => {
    if (!p) return '<div class="pod"></div>';
    const place = [2, 1, 3][i];
    return `<div class="pod p${place}"><span class="av">${esc(p.avatar)}</span><span class="nm">${esc(p.name)}</span><span class="sc">${fmt(p.score)} pts</span><div class="block">${place}</div></div>`;
  }).join('');
  $('#endList').innerHTML = lb.length > 3 ? lbHtml(lb.slice(3), 50) : '';
  confetti();
}
function confetti() {
  const colors = ['#ff4f6d', '#3b82f6', '#f5b301', '#10b981', '#a855f7', '#ffd23f'];
  for (let i = 0; i < 120; i++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    c.style.left = Math.random() * 100 + 'vw';
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = 2.5 + Math.random() * 2.5 + 's';
    c.style.animationDelay = 1 + Math.random() * 1.5 + 's';
    c.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 7000);
  }
}

loadInfo();
loadThemes();
renderSettings();
