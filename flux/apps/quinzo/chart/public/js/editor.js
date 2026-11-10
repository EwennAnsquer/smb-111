window.QUINZO_ADMIN_PAGE = true;
// Éditeur de thèmes et de questions.
let list = [];
let cur = null; // thème en cours d'édition (copie)
let dirty = false;

const DEFAULTS = {
  qcm: () => ({ type: 'qcm', question: '', choices: ['', '', '', ''], answer: 0, difficulty: 'moyen' }),
  vraifaux: () => ({ type: 'vraifaux', question: '', answer: true, difficulty: 'moyen' }),
  estimation: () => ({ type: 'estimation', question: '', answer: 0, unit: '', difficulty: 'moyen' }),
  ordre: () => ({ type: 'ordre', question: 'Remets dans l\'ordre chronologique', items: ['', '', '', ''], difficulty: 'moyen' }),
  texte: () => ({ type: 'texte', question: '', answer: [''], difficulty: 'moyen' }),
};

async function api(url, opts = {}) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Erreur ' + r.status);
  return data;
}

async function loadList(selectId) {
  list = await api('/api/themes');
  renderList();
  if (selectId) openTheme(selectId);
}
function renderList() {
  const f = $('#search').value.trim().toLowerCase();
  $('#tlist').innerHTML = list.filter((t) => !f || t.name.toLowerCase().includes(f)).map((t) => `
    <button class="titem ${cur && cur.id === t.id ? 'on' : ''}" data-id="${esc(t.id)}"><span class="em">${esc(t.emoji)}</span><span class="nm">${esc(t.name)}</span><span class="ct">${t.count}</span></button>`).join('') || '<p class="muted">Aucun thème</p>';
  $$('.titem').forEach((b) => (b.onclick = () => openTheme(b.dataset.id)));
}
$('#search').oninput = renderList;

function confirmLeave() { return !dirty || confirm('Des modifications ne sont pas enregistrées. Continuer quand même ?'); }
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

async function openTheme(id) {
  if (!confirmLeave()) return;
  try {
    cur = await api('/api/themes/' + encodeURIComponent(id));
    dirty = false;
    renderList();
    renderEditor();
  } catch (e) { toast(e.message, true); }
}
$('#newTheme').onclick = () => {
  if (!confirmLeave()) return;
  cur = { id: null, name: 'Nouveau thème', emoji: '✨', description: '', color: '', questions: [DEFAULTS.qcm()] };
  dirty = true;
  renderList();
  renderEditor();
  setTimeout(() => { const n = $('#tName'); n.focus(); n.select(); }, 50);
};

function markDirty() { dirty = true; $('#saveBtn') && ($('#saveBtn').textContent = '💾 Enregistrer *'); }

function renderEditor() {
  const m = $('#main');
  const counts = {};
  cur.questions.forEach((q) => (counts[q.type] = (counts[q.type] || 0) + 1));
  m.innerHTML = `
    <div class="stickybar">
      <h2 style="margin:0" class="grow">${esc(cur.emoji)} ${esc(cur.name)} <span class="muted" style="font-size:.6em">${cur.questions.length} questions</span></h2>
      <button class="btn primary" id="saveBtn">💾 Enregistrer${dirty ? ' *' : ''}</button>
      ${cur.id ? `<a class="btn" href="/api/themes/${encodeURIComponent(cur.id)}/export">⬇️ Exporter</a><button class="btn danger" id="delBtn">🗑 Supprimer</button>` : ''}
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="thead">
        <div><label class="lbl">Emoji</label><input class="input emoji-in" id="tEmoji" maxlength="8" value="${esc(cur.emoji)}"></div>
        <div><label class="lbl">Nom du thème</label><input class="input" id="tName" maxlength="40" value="${esc(cur.name)}" style="font-size:1.3em;font-weight:900"></div>
        <div><label class="lbl">Couleur</label><input class="input" type="color" id="tColor" value="${cur.color && /^#[0-9a-f]{6}$/i.test(cur.color) ? cur.color : '#7b61ff'}" style="height:56px;padding:4px"></div>
      </div>
      <div class="field"><label class="lbl">Description (optionnelle)</label><input class="input" id="tDesc" maxlength="140" value="${esc(cur.description || '')}"></div>
      <p class="muted" style="margin:10px 0 0;font-size:.9em">${Object.entries(counts).map(([t, n]) => `${TYPE_ICONS[t]} ${n} ${TYPE_LABELS[t]}`).join(' · ') || 'Aucune question'}</p>
    </div>
    <div id="qs"></div>
    <div class="add-row">
      ${Object.keys(DEFAULTS).map((t) => `<button class="btn" data-add="${t}">＋ ${TYPE_ICONS[t]} ${TYPE_LABELS[t]}</button>`).join('')}
    </div>`;
  $('#tEmoji').oninput = (e) => { cur.emoji = e.target.value; markDirty(); };
  $('#tName').oninput = (e) => { cur.name = e.target.value; markDirty(); };
  $('#tDesc').oninput = (e) => { cur.description = e.target.value; markDirty(); };
  $('#tColor').oninput = (e) => { cur.color = e.target.value; markDirty(); };
  $('#saveBtn').onclick = save;
  if ($('#delBtn')) $('#delBtn').onclick = del;
  $$('[data-add]').forEach((b) => (b.onclick = () => {
    cur.questions.push(DEFAULTS[b.dataset.add]());
    markDirty();
    renderQuestions();
    const cards = $$('.qcard');
    cards[cards.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => cards[cards.length - 1].querySelector('textarea').focus(), 300);
  }));
  renderQuestions();
}

function renderQuestions() {
  const box = $('#qs');
  box.innerHTML = '';
  cur.questions.forEach((q, i) => box.appendChild(questionCard(q, i)));
}

function lines(v) { return (Array.isArray(v) ? v : [v]).join('\n'); }
function fromLines(s) { return s.split(/\n|\|/).map((x) => x.trim()).filter(Boolean); }

function questionCard(q, i) {
  const el = document.createElement('div');
  el.className = 'qcard';
  const typeOpts = Object.keys(DEFAULTS).map((t) => `<option value="${t}" ${t === q.type ? 'selected' : ''}>${TYPE_ICONS[t]} ${TYPE_LABELS[t]}</option>`).join('');
  const diffOpts = ['facile', 'moyen', 'difficile'].map((d) => `<option value="${d}" ${d === q.difficulty ? 'selected' : ''}>${d}</option>`).join('');
  let body = '';
  if (q.type === 'qcm') {
    body = `<label class="lbl field">Choix (coche la bonne réponse) — 2 à 6</label>
      ${q.choices.map((c, j) => `<div class="chline"><input type="radio" name="ans${i}" data-ans="${j}" ${q.answer === j ? 'checked' : ''}><span class="sh choice c${j}" style="padding:0;min-height:0">${SHAPES[j]}</span><input class="input" data-choice="${j}" value="${esc(c)}" placeholder="Choix ${j + 1}"><button class="icon-btn" data-rmchoice="${j}" title="Retirer">✕</button></div>`).join('')}
      ${q.choices.length < 6 ? '<button class="btn small" data-addchoice>＋ Ajouter un choix</button>' : ''}`;
  } else if (q.type === 'vraifaux') {
    body = `<label class="lbl field">Bonne réponse</label>
      <div class="row"><label class="chip"><input type="radio" name="vf${i}" data-vf="1" ${q.answer ? 'checked' : ''}> ✓ Vrai</label><label class="chip"><input type="radio" name="vf${i}" data-vf="0" ${!q.answer ? 'checked' : ''}> ✗ Faux</label></div>`;
  } else if (q.type === 'estimation') {
    body = `<div class="grid4 field">
      <div><label class="lbl">Bonne réponse</label><input class="input" data-f="answer" inputmode="decimal" value="${q.answer ?? ''}"></div>
      <div><label class="lbl">Unité</label><input class="input" data-f="unit" value="${esc(q.unit || '')}" placeholder="km, €, ans…"></div>
      <div><label class="lbl">Min curseur</label><input class="input" data-f="min" inputmode="decimal" value="${q.min ?? ''}" placeholder="optionnel"></div>
      <div><label class="lbl">Max curseur</label><input class="input" data-f="max" inputmode="decimal" value="${q.max ?? ''}" placeholder="optionnel"></div>
    </div>
    <div class="help">Avec min/max, les joueurs ont un curseur et les points dépendent de l'écart par rapport à l'amplitude (idéal pour les années). Sans, l'écart est calculé en % de la bonne réponse.</div>`;
  } else if (q.type === 'ordre') {
    body = `<div class="grid2 field">
      <div><label class="lbl">Éléments dans le BON ordre (un par ligne)</label><textarea class="input" data-f="items" rows="${Math.max(4, q.items.length)}">${esc(lines(q.items))}</textarea></div>
      <div><label class="lbl">Détails affichés à la réponse (optionnel)</label><textarea class="input" data-f="details" rows="${Math.max(4, q.items.length)}" placeholder="ex : 1789&#10;1804&#10;…">${esc(lines(q.details || []))}</textarea></div>
    </div><div class="help">Ils seront mélangés pour les joueurs. 2 à 8 éléments.</div>`;
  } else if (q.type === 'texte') {
    body = `<div class="field"><label class="lbl">Réponses acceptées (une par ligne — la première est affichée)</label><textarea class="input" data-f="answer" rows="3">${esc(lines(q.answer))}</textarea>
      <div class="help">Majuscules, accents, articles (le, la, les…) et petites fautes de frappe sont tolérés automatiquement.</div></div>`;
  }
  el.innerHTML = `
    <div class="qhead">
      <span class="n">#${i + 1}</span>
      <select class="input" data-type>${typeOpts}</select>
      <select class="input" data-diff>${diffOpts}</select>
      <span class="sp"></span>
      <button class="icon-btn" data-mv="-1" title="Monter">↑</button>
      <button class="icon-btn" data-mv="1" title="Descendre">↓</button>
      <button class="icon-btn" data-dup title="Dupliquer">⧉</button>
      <button class="icon-btn" data-rm title="Supprimer" style="color:#fca5a5">🗑</button>
    </div>
    <textarea class="input" data-f="question" rows="2" placeholder="Intitulé de la question" style="font-weight:800;font-size:1.05em">${esc(q.question)}</textarea>
    ${body}
    <details class="field"><summary class="muted" style="cursor:pointer;font-weight:700">Explication, image, temps…</summary>
      <div class="field"><label class="lbl">Explication affichée après la réponse</label><textarea class="input" data-f="explanation" rows="2">${esc(q.explanation || '')}</textarea></div>
      <div class="grid2 field">
        <div><label class="lbl">Image (URL ou /images/fichier.jpg)</label><input class="input" data-f="image" value="${esc(q.image || '')}" placeholder="optionnel"></div>
        <div><label class="lbl">Temps spécifique (secondes)</label><input class="input" data-f="time" inputmode="numeric" value="${q.time ?? ''}" placeholder="par défaut : réglage de la partie"></div>
      </div>
    </details>`;

  // liaisons
  $$('[data-f]', el).forEach((inp) => {
    inp.oninput = () => {
      const f = inp.dataset.f, v = inp.value;
      if (f === 'items' || f === 'details') q[f] = fromLines(v);
      else if (f === 'answer' && q.type === 'texte') q.answer = fromLines(v);
      else if (['answer', 'min', 'max', 'time'].includes(f)) { const n = Number(String(v).replace(/\s/g, '').replace(',', '.')); if (v.trim() === '' && f !== 'answer') delete q[f]; else q[f] = n; }
      else if (['explanation', 'image', 'unit'].includes(f) && !v.trim()) delete q[f];
      else q[f] = v;
      markDirty();
    };
  });
  $$('[data-choice]', el).forEach((inp) => (inp.oninput = () => { q.choices[+inp.dataset.choice] = inp.value; markDirty(); }));
  $$('[data-ans]', el).forEach((r) => (r.onchange = () => { q.answer = +r.dataset.ans; markDirty(); }));
  $$('[data-vf]', el).forEach((r) => (r.onchange = () => { q.answer = r.dataset.vf === '1'; markDirty(); }));
  $$('[data-rmchoice]', el).forEach((b) => (b.onclick = () => {
    if (q.choices.length <= 2) return toast('Il faut au moins 2 choix', true);
    const j = +b.dataset.rmchoice;
    q.choices.splice(j, 1);
    if (q.answer === j) q.answer = 0; else if (q.answer > j) q.answer--;
    markDirty(); renderQuestions();
  }));
  const addC = $('[data-addchoice]', el);
  if (addC) addC.onclick = () => { q.choices.push(''); markDirty(); renderQuestions(); };
  $('[data-type]', el).onchange = (e) => {
    const nq = DEFAULTS[e.target.value]();
    nq.question = q.question; nq.difficulty = q.difficulty;
    if (q.explanation) nq.explanation = q.explanation;
    if (q.image) nq.image = q.image;
    if (q.time) nq.time = q.time;
    cur.questions[i] = nq; markDirty(); renderQuestions();
  };
  $('[data-diff]', el).onchange = (e) => { q.difficulty = e.target.value; markDirty(); };
  $$('[data-mv]', el).forEach((b) => (b.onclick = () => {
    const j = i + +b.dataset.mv;
    if (j < 0 || j >= cur.questions.length) return;
    [cur.questions[i], cur.questions[j]] = [cur.questions[j], cur.questions[i]];
    markDirty(); renderQuestions();
  }));
  $('[data-dup]', el).onclick = () => { cur.questions.splice(i + 1, 0, JSON.parse(JSON.stringify(q))); markDirty(); renderQuestions(); };
  $('[data-rm]', el).onclick = () => { if (!q.question || confirm('Supprimer cette question ?')) { cur.questions.splice(i, 1); markDirty(); renderQuestions(); } };
  return el;
}

async function save() {
  if (!cur.name.trim()) return toast('Donne un nom au thème', true);
  // retire les questions vides
  const payload = { ...cur, questions: cur.questions.filter((q) => q.question.trim()) };
  if (payload.questions.some((q) => q.type === 'qcm')) payload.questions.forEach((q) => { if (q.type === 'qcm') q.choices = q.choices.map((c) => c.trim()); });
  try {
    const r = await api('/api/themes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    dirty = false;
    if (r.errors.length) {
      toast(`Enregistré, mais ${r.errors.length} question(s) invalide(s) ignorée(s)`, true, 5000);
      alert('Questions ignorées :\n\n' + r.errors.join('\n'));
    } else toast(`✅ Enregistré (${r.count} questions)`);
    await loadList(r.id);
  } catch (e) { toast(e.message, true); }
}
async function del() {
  if (!confirm(`Supprimer définitivement le thème « ${cur.name} » ?`)) return;
  await api('/api/themes/' + encodeURIComponent(cur.id), { method: 'DELETE' });
  dirty = false; cur = null;
  $('#main').innerHTML = '<div class="empty"><div style="font-size:3em">🗑</div><h2>Thème supprimé</h2></div>';
  loadList();
}

// ---------- Import ----------
async function importText(text, filename) {
  try {
    const r = await api('/api/import?filename=' + encodeURIComponent(filename || ''), { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text });
    const total = r.results.reduce((s, x) => s + x.count, 0);
    const errs = r.results.flatMap((x) => x.errors);
    const saved = r.results.filter((x) => x.id);
    toast(`✅ ${filename || 'Import'} : ${saved.length} thème(s), ${total} questions au total`, false, 4000);
    if (errs.length) alert(`${errs.length} question(s) ignorée(s) :\n\n` + errs.slice(0, 30).join('\n') + (errs.length > 30 ? '\n…' : ''));
    await loadList(saved[0] && saved[0].id);
    return true;
  } catch (e) { toast(`${filename || 'Import'} : ${e.message}`, true, 6000); return false; }
}
async function importFiles(files) {
  for (const f of files) {
    const buf = await f.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf); // CSV Excel en ANSI
    await importText(text, f.name);
  }
}
const drop = $('#drop');
drop.onclick = () => $('#fileIn').click();
$('#fileIn').onchange = (e) => { importFiles([...e.target.files]); e.target.value = ''; };
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => importFiles([...e.dataTransfer.files]));
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { e.preventDefault(); if (e.target.closest('#drop')) return; if (e.dataTransfer.files.length) importFiles([...e.dataTransfer.files]); });

$('#reloadBtn').onclick = async () => {
  const r = await api('/api/reload', { method: 'POST' });
  toast(`${r.count} thèmes relus depuis le dossier`);
  if (r.errors.length) alert('Problèmes :\n\n' + r.errors.join('\n'));
  loadList();
};

// ---------- Modèles ----------
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const CSV_TEMPLATE = `theme;emoji;type;question;reponse;options;difficulte;explication;unite;min;max
Mon thème;🎲;qcm;Quelle est la capitale de l'Australie ?;Canberra;Sydney|Melbourne|Perth;moyen;Sydney est la plus grande ville, mais pas la capitale.;;;
Mon thème;🎲;vraifaux;Le soleil est une étoile.;vrai;;facile;;;;
Mon thème;🎲;estimation;Quelle est la hauteur de la tour Eiffel ?;330;;moyen;Avec ses antennes.;m;;
Mon thème;🎲;estimation;En quelle année a eu lieu la prise de la Bastille ?;1789;;facile;;;1700;1900
Mon thème;🎲;ordre;Du plus petit au plus grand;Souris|Chat|Cheval|Éléphant;;facile;;;;
Mon thème;🎲;texte;Quel est le symbole chimique de l'or ?;Au;;moyen;Du latin aurum.;;;
`;
const JSON_TEMPLATE = JSON.stringify({
  name: 'Mon thème', emoji: '🎲', description: 'Un exemple de thème', color: '#7b61ff',
  questions: [
    { type: 'qcm', question: 'Quelle est la capitale de l\'Australie ?', choices: ['Sydney', 'Canberra', 'Melbourne', 'Perth'], answer: 1, difficulty: 'moyen', explanation: 'Sydney est la plus grande ville, mais pas la capitale.' },
    { type: 'vraifaux', question: 'Le soleil est une étoile.', answer: true, difficulty: 'facile' },
    { type: 'estimation', question: 'Quelle est la hauteur de la tour Eiffel ?', answer: 330, unit: 'm', difficulty: 'moyen' },
    { type: 'estimation', question: 'En quelle année a eu lieu la prise de la Bastille ?', answer: 1789, min: 1700, max: 1900, difficulty: 'facile' },
    { type: 'ordre', question: 'Du plus petit au plus grand', items: ['Souris', 'Chat', 'Cheval', 'Éléphant'], difficulty: 'facile' },
    { type: 'texte', question: 'Quel est le symbole chimique de l\'or ?', answer: ['Au'], difficulty: 'moyen' },
  ],
}, null, 2);
$('#dlCsv').onclick = () => download('modele-quinzo.csv', '﻿' + CSV_TEMPLATE, 'text/csv;charset=utf-8');
$('#dlJson').onclick = () => download('modele-quinzo.json', JSON_TEMPLATE, 'application/json');

const AI_PROMPT = `Génère un thème de quiz en français sur le sujet : « [TON THÈME ICI] ».
Réponds UNIQUEMENT avec un JSON valide (sans texte autour) au format suivant :

{
  "name": "Nom du thème",
  "emoji": "🎬",
  "description": "Une phrase de description",
  "questions": [
    { "type": "qcm", "question": "...", "choices": ["A", "B", "C", "D"], "answer": 0, "difficulty": "facile", "explanation": "..." },
    { "type": "vraifaux", "question": "...", "answer": true, "difficulty": "moyen" },
    { "type": "estimation", "question": "...", "answer": 1969, "unit": "", "min": 1900, "max": 2020, "difficulty": "moyen" },
    { "type": "ordre", "question": "Remets dans l'ordre chronologique", "items": ["1er", "2e", "3e", "4e"], "details": ["1789", "1815", "1870", "1914"], "difficulty": "difficile" },
    { "type": "texte", "question": "...", "answer": ["Réponse", "Variante acceptée"], "difficulty": "moyen" }
  ]
}

Règles :
- 25 questions, variées : environ 60 % de "qcm", 10 % "vraifaux", 10 % "estimation", 10 % "ordre", 10 % "texte".
- "answer" d'un qcm = index (0 à 3) de la bonne réponse dans "choices" ; varie la position de la bonne réponse.
- "items" d'une question "ordre" sont donnés dans le BON ordre (ils seront mélangés pendant le jeu).
- Pour une "estimation" d'année, mets "min" et "max". Pour une quantité, mets "unit".
- "texte" : réponses courtes (1 à 3 mots), avec variantes d'orthographe acceptées.
- "difficulty" : "facile", "moyen" ou "difficile", répartis équitablement.
- Vérifie soigneusement que chaque réponse est exacte. Ajoute une courte "explanation" amusante quand c'est possible.`;
$('#aiPrompt').textContent = AI_PROMPT;
$('#aiBtn').onclick = () => $('#aiDlg').showModal();
$('#aiCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(AI_PROMPT); toast('Prompt copié 📋'); } catch (e) {
    const r = document.createRange(); r.selectNodeContents($('#aiPrompt')); getSelection().removeAllRanges(); getSelection().addRange(r); toast('Sélectionné — fais Ctrl+C');
  }
};
$('#pasteImport').onclick = async () => {
  let t = $('#pasteJson').value.trim();
  if (!t) return;
  t = t.replace(/^```(json)?/i, '').replace(/```$/, '').trim(); // si l'IA a mis des balises
  if (await importText(t, 'collé')) { $('#pasteJson').value = ''; $('#aiDlg').close(); }
};

loadList();
