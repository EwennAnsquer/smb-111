// Écran joueur (téléphone / PC des potes).
const socket = io(SOCKET_OPTS);
const LS = {
  get: (k) => { try { return localStorage.getItem('quinzo_' + k); } catch (e) { return null; } },
  set: (k, v) => { try { v === null ? localStorage.removeItem('quinzo_' + k) : localStorage.setItem('quinzo_' + k, v); } catch (e) { /* mode privé */ } },
};

let me = { id: LS.get('id'), name: LS.get('name') || '', avatar: LS.get('avatar') || AVATARS[Math.floor(Math.random() * AVATARS.length)] };
let joined = LS.get('joined') === '1';
// code dans l'URL (QR code) : ?pin=1234
const urlPin = new URLSearchParams(location.search).get('pin');
if (urlPin) { LS.set('pin', urlPin.replace(/\D/g, '')); history.replaceState(null, '', location.pathname); }
me.pin = LS.get('pin') || '';
let S = null; // dernier état reçu
let renderedKey = '';
let lastResultKey = '';
const countdown = new Countdown((left, ratio) => {
  const bar = $('#qTimer');
  bar.firstElementChild.style.transform = `scaleX(${ratio})`;
  bar.classList.toggle('low', left < 5000);
});

// ---------- Rejoindre ----------
const avWrap = $('#avatars');
AVATARS.forEach((a) => {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = a;
  if (a === me.avatar) b.classList.add('sel');
  b.onclick = () => { me.avatar = a; $$('.avatars button').forEach((x) => x.classList.toggle('sel', x === b)); };
  avWrap.appendChild(b);
});
$('#name').value = me.name;
$('#pin').value = me.pin;

function join() {
  socket.emit('player:join', { id: me.id, name: me.name, avatar: me.avatar, pin: me.pin }, (r) => {
    if (!r || !r.ok) {
      joined = false; LS.set('joined', null); show('join');
      if (r && r.code === 'pin') { LS.set('pin', null); $('#pin').value = ''; $('#pin').focus(); $('#pin').classList.add('shake'); setTimeout(() => $('#pin').classList.remove('shake'), 500); }
      return toast((r && r.error) || 'Impossible de rejoindre', true, 3500);
    }
    LS.set('pin', me.pin);
    me.id = r.id; me.name = r.name;
    LS.set('id', r.id); LS.set('name', me.name); LS.set('avatar', me.avatar); LS.set('joined', '1');
    joined = true;
  });
}
$('#joinForm').onsubmit = (e) => {
  e.preventDefault();
  me.name = $('#name').value.trim();
  me.pin = $('#pin').value.replace(/\D/g, '');
  if (!me.pin) return $('#pin').focus();
  if (!me.name) return;
  if (!socket.connected) return toast('Pas connecté au serveur… vérifie le Wi-Fi', true);
  join();
};
$('#leaveBtn').onclick = () => {
  socket.emit('player:leave');
  joined = false; LS.set('joined', null); LS.set('id', null); me.id = null;
  $('#meChip').classList.add('hidden');
  show('join');
};

socket.on('connect', () => {
  $('#connStatus').textContent = '';
  if (joined && me.name) join();
});
socket.on('disconnect', () => { $('#connStatus').textContent = '🔌 Connexion perdue, reconnexion…'; toast('Connexion perdue… reconnexion', true); });
socket.on('kicked', () => {
  joined = false; LS.set('joined', null); LS.set('id', null); me.id = null;
  $('#meChip').classList.add('hidden');
  show('join'); toast('Tu as été retiré de la partie par l\'hôte', true, 4000);
});

// ---------- Rendu ----------
socket.on('state', (st) => {
  S = st;
  if (!joined || !st.me) { renderedKey = ''; $('#adminBtn').classList.remove('hidden'); show('join'); return; }
  $('#meChip').classList.remove('hidden');
  $('#meAv').textContent = st.me.avatar;
  $('#meScore').textContent = fmt(st.me.score) + ' pts';
  const key = st.state + ':' + st.index;
  // bouton « Écran hôte » masqué pendant le jeu (évite un appui involontaire)
  $('#adminBtn').classList.toggle('hidden', !['lobby', 'end'].includes(st.state));
  switch (st.state) {
    case 'lobby': renderWait(st); break;
    case 'question': if (key !== renderedKey || !$('#qAnswer').childElementCount) renderQuestion(st); else updateQuestion(st); break;
    case 'reveal': if (key !== renderedKey) renderReveal(st); break;
    case 'leaderboard': if (key !== renderedKey) renderLeaderboard(st); break;
    case 'end': if (key !== renderedKey) renderEnd(st); break;
  }
  renderedKey = key;
});

function renderWait(st) {
  show('wait');
  countdown.stop();
  $('#waitAv').textContent = st.me.avatar;
  $('#waitName').textContent = st.me.name;
  const n = st.playerCount;
  $('#waitCount').textContent = `👥 ${n} joueur${n > 1 ? 's' : ''} connecté${n > 1 ? 's' : ''}`;
}

function sendAnswer(answer) {
  socket.emit('player:answer', { index: S.index, answer });
  if (navigator.vibrate) navigator.vibrate(30);
}
function showSent(label) {
  const box = $('#qAnswer');
  box.innerHTML = `<div class="sent pop"><div class="emoji">🤞</div><h2 style="margin:0">Réponse envoyée !</h2>${label ? `<p class="muted" style="margin:0">${esc(label)}</p>` : ''}<p class="muted">On attend les autres…</p><div class="who" id="whoAnswered"></div></div>`;
  renderWho(S);
}
function renderWho(st) {
  const el = $('#whoAnswered');
  if (!el || !st || !st.answered) return;
  const byId = Object.fromEntries(st.players.map((p) => [p.id, p]));
  el.innerHTML = `<div class="chip">✋ ${st.answered.length} / ${st.playerCount} ont répondu</div>
    <div class="who-avs">${st.players.filter((p) => p.connected).map((p) => `<span class="${st.answered.includes(p.id) ? 'done' : ''}" title="${esc(p.name)}">${esc(p.avatar)}</span>`).join('')}</div>`;
}

function renderQuestion(st) {
  show('question');
  const q = st.question;
  $('#qTheme').innerHTML = `${esc(q.theme.emoji)} ${esc(q.theme.name)}`;
  $('#qNum').textContent = `${st.index + 1} / ${st.total}`;
  $('#qText').textContent = q.question;
  const img = $('#qImg');
  if (q.image) { img.src = q.image; img.classList.remove('hidden'); } else img.classList.add('hidden');
  countdown.start(st.remaining, q.time * 1000);
  const box = $('#qAnswer');
  box.innerHTML = '';
  if (st.me.answered) return showSent(describeMine(st));

  if (q.type === 'qcm' || q.type === 'vraifaux') {
    const labels = q.type === 'qcm' ? q.choices : ['Vrai', 'Faux'];
    const grid = document.createElement('div');
    grid.className = 'choices' + (q.type === 'vraifaux' ? ' vf' : '');
    if (q.type === 'qcm' && labels.some((l) => l.length > 28)) grid.style.gridTemplateColumns = '1fr';
    labels.forEach((label, i) => {
      const b = document.createElement('button');
      b.className = `choice c${q.type === 'vraifaux' ? (i ? 0 : 3) : i} slide-up`;
      b.style.animationDelay = i * 0.05 + 's';
      b.innerHTML = q.type === 'vraifaux' ? (i ? '✗ Faux' : '✓ Vrai') : `<span class="shape">${SHAPES[i]}</span><span>${esc(label)}</span>`;
      b.onclick = () => { sendAnswer(q.type === 'vraifaux' ? i === 0 : i); showSent(q.type === 'vraifaux' ? (i ? 'Faux' : 'Vrai') : label); };
      grid.appendChild(b);
    });
    box.appendChild(grid);
  } else if (q.type === 'estimation') {
    const hasRange = q.min !== undefined;
    const unit = q.unit ? ` ${q.unit}` : '';
    let val = hasRange ? Math.round((q.min + q.max) / 2) : '';
    box.innerHTML = `
      ${hasRange ? `<div class="est-value" id="estVal"></div>
        <input type="range" id="estRange" min="${q.min}" max="${q.max}" step="${niceStep(q.min, q.max)}" value="${val}">
        <div class="row muted" style="justify-content:space-between;font-weight:700"><span>${fmt(q.min)}</span><span>${fmt(q.max)}</span></div>
        <label class="lbl" style="margin-top:14px">Ou tape une valeur précise</label>` : '<label class="lbl">Ton estimation</label>'}
      <div class="row"><input class="input est-input" id="estInput" inputmode="decimal" placeholder="?" value="${val}"><span style="font-weight:900;font-size:1.2em">${esc(q.unit || '')}</span></div>
      <div class="actions"><button class="btn primary big" id="estSend">Valider 🎯</button></div>`;
    const input = $('#estInput'), range = $('#estRange');
    const sync = (v) => { if ($('#estVal')) $('#estVal').textContent = (v === '' || isNaN(v) ? '?' : fmt(v)) + unit; };
    sync(val);
    if (range) range.oninput = () => { input.value = range.value; sync(range.value); };
    input.oninput = () => { const v = parseNum(input.value); if (range && !isNaN(v)) range.value = v; sync(v); };
    const send = () => {
      const v = parseNum(input.value);
      if (isNaN(v)) { input.classList.add('shake'); setTimeout(() => input.classList.remove('shake'), 500); return; }
      sendAnswer(v); showSent(fmt(v) + unit);
    };
    $('#estSend').onclick = send;
    input.onkeydown = (e) => { if (e.key === 'Enter') send(); };
  } else if (q.type === 'ordre') {
    let picked = [];
    box.innerHTML = `<p class="muted" style="margin:0 0 10px;font-weight:700">Touche les éléments dans le bon ordre (du 1er au dernier).</p><div class="order-list" id="ordList"></div>
      <div class="actions"><button class="btn small" id="ordReset">↺ Recommencer</button><button class="btn primary" id="ordSend" disabled>Valider</button></div>`;
    const list = $('#ordList');
    const draw = () => {
      list.innerHTML = '';
      q.items.forEach((it, i) => {
        const pos = picked.indexOf(i);
        const b = document.createElement('button');
        b.className = 'order-item' + (pos >= 0 ? ' set' : '');
        b.innerHTML = `<span class="num">${pos >= 0 ? pos + 1 : ''}</span><span>${esc(it)}</span>`;
        b.onclick = () => { if (pos >= 0) picked = picked.slice(0, pos); else picked.push(i); draw(); };
        list.appendChild(b);
      });
      $('#ordSend').disabled = picked.length !== q.items.length;
    };
    draw();
    $('#ordReset').onclick = () => { picked = []; draw(); };
    $('#ordSend').onclick = () => { sendAnswer(picked); showSent(picked.map((i) => q.items[i]).join(' → ')); };
  } else if (q.type === 'texte') {
    box.innerHTML = `<label class="lbl">Ta réponse</label><input class="input text-input" id="txtInput" maxlength="80" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Tape ta réponse…">
      <p class="muted" style="font-size:.9em;margin:8px 2px 0">Les accents, majuscules et petites fautes de frappe sont tolérés.</p>
      <div class="actions"><button class="btn primary big" id="txtSend">Valider ⌨️</button></div>`;
    const input = $('#txtInput');
    setTimeout(() => input.focus(), 100);
    const send = () => { const v = input.value.trim(); if (!v) return; sendAnswer(v); showSent(v); };
    $('#txtSend').onclick = send;
    input.onkeydown = (e) => { if (e.key === 'Enter') send(); };
  }
}
function updateQuestion(st) {
  // la question est déjà affichée : on resynchronise juste le chrono
  countdown.start(st.remaining, st.question.time * 1000);
  renderWho(st);
}
function describeMine(st) {
  const q = st.question, a = st.me.answer;
  if (a === undefined) return '';
  if (q.type === 'qcm') return q.choices[a];
  if (q.type === 'vraifaux') return a ? 'Vrai' : 'Faux';
  if (q.type === 'ordre') return a.map((i) => q.items[i]).join(' → ');
  if (q.type === 'estimation') return fmt(a) + (q.unit ? ' ' + q.unit : '');
  return String(a);
}
function parseNum(s) { return Number(String(s).replace(/\s/g, '').replace(',', '.')); }
function niceStep(min, max) {
  const r = max - min;
  if (r <= 20) return 1; // années, petits nombres
  const raw = r / 200;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const s = raw / p < 2 ? 1 : raw / p < 5 ? 2 : 5;
  return Math.max(1, s * p);
}

function renderReveal(st) {
  show('reveal');
  countdown.stop();
  const r = st.me.result || {};
  const rv = st.reveal || {};
  const key = 'r' + st.index;
  let cls, emoji, title;
  if (r.missed) { cls = 'bad'; emoji = '⏱️'; title = 'Trop tard !'; }
  else if (r.correct) { cls = 'good'; emoji = st.question.type === 'estimation' ? '🎯' : '✅'; title = st.question.type === 'estimation' ? 'Dans le mille !' : 'Bonne réponse !'; }
  else if (r.partial || r.points > 0) { cls = 'mid'; emoji = '🟡'; title = st.question.type === 'estimation' ? 'Pas loin !' : 'Presque !'; }
  else { cls = 'bad'; emoji = '❌'; title = 'Raté !'; }
  const res = $('#res');
  res.className = 'result pop ' + cls;
  res.innerHTML = `
    <div class="emoji">${emoji}</div>
    <h2>${title}</h2>
    <div class="pts">+${fmt(r.points || 0)}</div>
    ${r.bonus ? `<div class="chip">🔥 Série de ${r.streak} : +${r.bonus}</div>` : ''}
    <div class="answer-box"><small>La réponse</small><b>${esc(rv.correctText)}</b>${r.given && !r.correct ? `<small style="margin-top:8px">Ta réponse</small><span>${esc(r.given)}</span>` : ''}</div>
    ${rv.explanation ? `<div class="expl">💡 ${esc(rv.explanation)}</div>` : ''}
    <div class="rank-line">${medal(st.me.rank)} ${st.me.rank}<sup>${st.me.rank === 1 ? 'er' : 'e'}</sup> · ${fmt(st.me.score)} pts</div>`;
  $('#others').innerHTML = othersHtml(st);
  if (lastResultKey !== key) {
    lastResultKey = key;
    if (navigator.vibrate) navigator.vibrate(r.correct ? [40, 60, 40] : 200);
  }
}
// Ce que tout le monde a répondu (visible seulement après la révélation)
function othersHtml(st) {
  const q = st.question, rv = st.reveal || {};
  const rows = rv.rows || [];
  if (!rows.length) return '';
  let bars = '';
  if ((q.type === 'qcm' || q.type === 'vraifaux') && rv.stats && rv.stats.counts) {
    const labels = q.type === 'qcm' ? q.choices : ['Vrai', 'Faux'];
    const max = Math.max(1, ...rv.stats.counts);
    bars = `<div class="bars">${labels.map((l, i) => {
      const who = rows.filter((r) => r.given === l);
      const c = q.type === 'vraifaux' ? (i ? 0 : 3) : i;
      return `<div class="bar-row ${i === rv.correctIndex ? 'ok' : ''}">
        <div class="bar-label"><span>${q.type === 'qcm' ? SHAPES[i] + ' ' : ''}${esc(l)}</span><b>${rv.stats.counts[i]}</b></div>
        <div class="bar"><i style="width:${(rv.stats.counts[i] / max) * 100}%;background:var(--c${c})"></i></div>
        ${who.length ? `<div class="bar-who">${who.map((r) => `<span title="${esc(r.name)}">${esc(r.avatar)} ${esc(r.name)}</span>`).join('')}</div>` : ''}
      </div>`;
    }).join('')}</div>`;
  }
  const list = rows.map((r) => {
    const icon = r.missed ? '⏱️' : r.correct ? '✅' : r.points > 0 ? '🟡' : '❌';
    return `<div class="ans-row ${r.id === S.me.id ? 'me' : ''}">
      <span class="av">${esc(r.avatar)}</span>
      <div class="grow" style="min-width:0"><b class="nm">${esc(r.name)}</b><div class="given">${r.missed ? 'pas de réponse' : esc(r.given)}</div></div>
      <span>${icon}</span><span class="p">+${fmt(r.points)}</span>
    </div>`;
  }).join('');
  return `<h3 class="others-title">Les réponses de tout le monde</h3>${bars}<div class="ans-list">${list}</div>`;
}
function medal(rank) { return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '🏅'; }

function lbRows(list, limit) {
  const mine = list.find((p) => p.id === S.me.id);
  let rows = list.slice(0, limit);
  if (mine && mine.rank > limit) rows = [...rows, mine];
  return rows.map((p) => `<div class="lb-row r${p.rank} ${p.id === S.me.id ? 'me' : ''} slide-up" style="animation-delay:${Math.min(p.rank, 10) * 0.04}s">
      <span class="rank">${p.rank}</span><span class="av">${esc(p.avatar)}</span><span class="nm">${esc(p.name)}</span>
      ${p.lastPoints ? `<span class="delta">+${fmt(p.lastPoints)}</span>` : ''}<span class="sc">${fmt(p.score)}</span></div>`).join('');
}
function renderLeaderboard(st) {
  show('leaderboard');
  $('#lbMine').textContent = `Tu es ${st.me.rank}${st.me.rank === 1 ? 'er' : 'e'} sur ${st.leaderboard.length}`;
  $('#lbList').innerHTML = lbRows(st.leaderboard, 5);
}
function renderEnd(st) {
  show('end');
  countdown.stop();
  const r = st.me.rank, n = st.leaderboard.length;
  $('#endEmoji').textContent = r === 1 ? '🏆' : r <= 3 ? medal(r) : r <= n / 2 ? '👏' : '💪';
  $('#endRank').innerHTML = `${r}<sup style="font-size:.4em">${r === 1 ? 'er' : 'e'}</sup>`;
  $('#endMsg').textContent = r === 1 ? 'Victoire ! Tu écrases tout le monde 👑' : r <= 3 ? 'Sur le podium, bien joué !' : 'Partie terminée !';
  $('#endSub').textContent = `${fmt(st.me.score)} pts · ${st.me.correctCount} bonne${st.me.correctCount > 1 ? 's' : ''} réponse${st.me.correctCount > 1 ? 's' : ''}`;
  $('#endList').innerHTML = lbRows(st.leaderboard, 10);
}

show(joined ? 'wait' : 'join');
