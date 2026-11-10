// Gestion des thèmes : chargement, validation, import JSON / CSV, sauvegarde.
const fs = require('fs');
const path = require('path');

const TYPES = ['qcm', 'vraifaux', 'estimation', 'ordre', 'texte'];
const TYPE_ALIASES = {
  qcm: 'qcm', choix: 'qcm', mcq: 'qcm', multiple: 'qcm', comparatif: 'qcm', duel: 'qcm',
  vraifaux: 'vraifaux', vf: 'vraifaux', 'vrai/faux': 'vraifaux', 'vrai-faux': 'vraifaux', 'vrai faux': 'vraifaux', truefalse: 'vraifaux', boolean: 'vraifaux', bool: 'vraifaux',
  estimation: 'estimation', nombre: 'estimation', number: 'estimation', numerique: 'estimation', curseur: 'estimation',
  ordre: 'ordre', chrono: 'ordre', chronologie: 'ordre', chronologique: 'ordre', order: 'ordre', classement: 'ordre',
  texte: 'texte', text: 'texte', libre: 'texte', saisie: 'texte', 'reponse libre': 'texte',
};
const DIFFS = { facile: 'facile', easy: 'facile', moyen: 'moyen', medium: 'moyen', normal: 'moyen', difficile: 'difficile', hard: 'difficile', dur: 'difficile' };

function deaccent(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function slugify(s) {
  return deaccent(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'theme';
}
function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}
function toNumber(v) {
  if (typeof v === 'number') return v;
  const s = str(v).replace(/\s/g, '').replace(/ /g, '').replace(',', '.');
  if (s === '') return NaN;
  return Number(s);
}
function splitList(v) {
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  return str(v).split('|').map((x) => x.trim()).filter(Boolean);
}

/** Valide et normalise une question. Lance une erreur lisible si invalide. */
function normalizeQuestion(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('question vide');
  const typeKey = deaccent(str(raw.type || 'qcm')).toLowerCase();
  const type = TYPE_ALIASES[typeKey];
  if (!type) throw new Error(`type inconnu « ${raw.type} » (attendu : ${TYPES.join(', ')})`);
  const question = str(raw.question || raw.q || raw.texte || raw.intitule);
  if (!question) throw new Error('intitulé de question manquant');

  const q = { type, question };
  const diff = DIFFS[deaccent(str(raw.difficulty || raw.difficulte || raw.niveau)).toLowerCase()];
  q.difficulty = diff || 'moyen';
  if (str(raw.explanation || raw.explication)) q.explanation = str(raw.explanation || raw.explication);
  if (str(raw.image)) q.image = str(raw.image);
  const t = toNumber(raw.time ?? raw.temps);
  if (Number.isFinite(t) && t >= 5 && t <= 300) q.time = Math.round(t);

  if (type === 'qcm') {
    let choices = raw.choices || raw.choix || raw.options;
    let answer = raw.answer ?? raw.reponse ?? raw.bonne_reponse;
    const wrong = raw.wrong || raw.mauvaises || raw.mauvaises_reponses;
    if (!choices && wrong) {
      choices = [str(answer), ...splitList(wrong)];
      answer = 0;
    } else if (choices && !Array.isArray(choices)) {
      // format CSV : options = mauvaises réponses, reponse = bonne réponse (texte)
      choices = splitList(choices);
      if (str(answer) !== '' && !choices.some((c) => c === str(answer))) {
        choices = [str(answer), ...choices];
        answer = 0;
      }
    }
    choices = (choices || []).map(str).filter(Boolean);
    if (choices.length < 2) throw new Error('un QCM doit avoir au moins 2 choix');
    if (choices.length > 6) throw new Error('un QCM a 6 choix maximum');
    let idx = -1;
    if (typeof answer === 'number') idx = answer;
    else if (/^\d+$/.test(str(answer)) && !choices.includes(str(answer))) idx = Number(answer) - 1; // "1".."6" en CSV
    else idx = choices.findIndex((c) => c === str(answer));
    if (idx < 0 || idx >= choices.length) throw new Error('bonne réponse du QCM introuvable dans les choix');
    q.choices = choices;
    q.answer = idx;
  } else if (type === 'vraifaux') {
    const a = raw.answer ?? raw.reponse;
    let v;
    if (typeof a === 'boolean') v = a;
    else {
      const s = deaccent(str(a)).toLowerCase();
      if (['vrai', 'true', 'v', 'oui', '1', 'yes'].includes(s)) v = true;
      else if (['faux', 'false', 'f', 'non', '0', 'no'].includes(s)) v = false;
    }
    if (v === undefined) throw new Error('réponse vrai/faux attendue');
    q.answer = v;
  } else if (type === 'estimation') {
    const a = toNumber(raw.answer ?? raw.reponse);
    if (!Number.isFinite(a)) throw new Error('la réponse d\'une estimation doit être un nombre');
    q.answer = a;
    if (str(raw.unit || raw.unite)) q.unit = str(raw.unit || raw.unite);
    const min = toNumber(raw.min), max = toNumber(raw.max);
    if (Number.isFinite(min) && Number.isFinite(max) && max > min) { q.min = min; q.max = max; }
    const tol = toNumber(raw.tolerance);
    if (Number.isFinite(tol) && tol > 0) q.tolerance = tol;
  } else if (type === 'ordre') {
    const items = splitList(raw.items || raw.elements || raw.answer || raw.reponse);
    if (items.length < 2) throw new Error('une question « ordre » demande au moins 2 éléments');
    if (items.length > 8) throw new Error('une question « ordre » accepte 8 éléments maximum');
    q.items = items;
    const details = splitList(raw.details || raw.options || []);
    if (details.length === items.length) q.details = details;
  } else if (type === 'texte') {
    const answers = splitList(raw.answer ?? raw.reponse ?? raw.answers);
    if (!answers.length) throw new Error('au moins une réponse acceptée est requise');
    q.answer = answers;
  }
  return q;
}

/** Normalise un thème. Retourne { theme, errors }. Les questions invalides sont ignorées. */
function normalizeTheme(raw, fallbackName) {
  const errors = [];
  const name = str(raw.name || raw.nom || raw.theme || fallbackName) || 'Thème sans nom';
  const theme = {
    name,
    emoji: str(raw.emoji || raw.icone) || '❓',
    description: str(raw.description),
    color: /^#[0-9a-f]{3,8}$/i.test(str(raw.color || raw.couleur)) ? str(raw.color || raw.couleur) : '',
    questions: [],
  };
  (Array.isArray(raw.questions) ? raw.questions : []).forEach((rq, i) => {
    try {
      theme.questions.push(normalizeQuestion(rq));
    } catch (e) {
      errors.push(`« ${name} » question ${i + 1} : ${e.message}`);
    }
  });
  return { theme, errors };
}

/** Parse CSV (séparateur ; , ou tabulation détecté automatiquement, guillemets gérés). */
function parseCSV(text) {
  text = String(text).replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const counts = { ';': (firstLine.match(/;/g) || []).length, ',': (firstLine.match(/,/g) || []).length, '\t': (firstLine.match(/\t/g) || []).length };
  const sep = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

const HEADER_ALIASES = {
  theme: 'theme', 'thème': 'theme', categorie: 'theme', 'catégorie': 'theme',
  emoji: 'emoji',
  type: 'type',
  question: 'question', intitule: 'question', 'intitulé': 'question',
  reponse: 'reponse', 'réponse': 'reponse', bonne_reponse: 'reponse', 'bonne réponse': 'reponse', answer: 'reponse',
  options: 'options', choix: 'options', mauvaises: 'options', mauvaises_reponses: 'options', 'mauvaises réponses': 'options', wrong: 'options',
  difficulte: 'difficulte', 'difficulté': 'difficulte', niveau: 'difficulte', difficulty: 'difficulte',
  explication: 'explication', explanation: 'explication',
  unite: 'unite', 'unité': 'unite', unit: 'unite',
  min: 'min', max: 'max', image: 'image', temps: 'temps', time: 'temps', details: 'details', 'détails': 'details',
};

/** Convertit un CSV en liste de thèmes bruts (colonne "theme" optionnelle). */
function csvToThemes(text, defaultName) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('CSV vide ou sans ligne de données');
  const header = rows[0].map((h) => HEADER_ALIASES[deaccent(h).trim().toLowerCase()] || HEADER_ALIASES[h.trim().toLowerCase()] || h.trim().toLowerCase());
  if (!header.includes('question')) throw new Error('colonne « question » introuvable dans l\'en-tête du CSV');
  const byTheme = new Map();
  for (const r of rows.slice(1)) {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] || '').trim(); });
    const tName = o.theme || defaultName || 'Import CSV';
    if (!byTheme.has(tName)) byTheme.set(tName, { name: tName, emoji: o.emoji || '📋', questions: [] });
    const t = byTheme.get(tName);
    if (o.emoji && t.emoji === '📋') t.emoji = o.emoji;
    t.questions.push({
      type: o.type || 'qcm', question: o.question, reponse: o.reponse, options: o.options,
      difficulte: o.difficulte, explication: o.explication, unite: o.unite, min: o.min, max: o.max,
      image: o.image, temps: o.temps, details: o.details,
      // pour "ordre" : la liste dans le bon ordre est dans "reponse"
      items: (TYPE_ALIASES[deaccent(o.type || '').toLowerCase()] === 'ordre') ? o.reponse : undefined,
    });
  }
  return [...byTheme.values()];
}

// ---------- Stockage des thèmes ----------
// Fichiers JSON dans un dossier (une instance) ou hash Redis (plusieurs réplicas).
class FileThemeBackend {
  constructor(dir) { this.dir = dir; fs.mkdirSync(dir, { recursive: true }); }
  async readAll() {
    return fs.readdirSync(this.dir).filter((f) => f.toLowerCase().endsWith('.json')).sort().map((f) => {
      const id = f.replace(/\.json$/i, '');
      try { return { id, raw: JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) }; } catch (e) { return { id, error: e.message }; }
    });
  }
  async isEmpty() { return !fs.readdirSync(this.dir).some((f) => f.toLowerCase().endsWith('.json')); }
  async write(id, theme) { fs.writeFileSync(path.join(this.dir, id + '.json'), JSON.stringify(theme, null, 2), 'utf8'); }
  async seed(id, theme) { const f = path.join(this.dir, id + '.json'); if (!fs.existsSync(f)) await this.write(id, theme); }
  async del(id) { try { fs.unlinkSync(path.join(this.dir, id + '.json')); } catch (e) { /* déjà supprimé */ } }
  async version() { return null; }
}

class RedisThemeBackend {
  constructor(redis, prefix = 'quinzo:') { this.redis = redis; this.key = prefix + 'themes'; this.verKey = prefix + 'themes:ver'; }
  async readAll() {
    const all = await this.redis.hgetall(this.key);
    return Object.keys(all).sort().map((id) => {
      try { return { id, raw: JSON.parse(all[id]) }; } catch (e) { return { id, error: e.message }; }
    });
  }
  async isEmpty() { return (await this.redis.hlen(this.key)) === 0; }
  async write(id, theme) { await this.redis.multi().hset(this.key, id, JSON.stringify(theme)).incr(this.verKey).exec(); }
  async seed(id, theme) { if (await this.redis.hsetnx(this.key, id, JSON.stringify(theme))) await this.redis.incr(this.verKey); }
  async del(id) { await this.redis.multi().hdel(this.key, id).incr(this.verKey).exec(); }
  async version() { return (await this.redis.get(this.verKey)) || '0'; }
}

class ThemeStore {
  constructor(backend, { bundledDir } = {}) {
    this.backend = backend;
    this.bundledDir = bundledDir;
    this.themes = new Map();
    this.ver = undefined;
  }
  /** Premier lancement : copie les thèmes fournis si le stockage est vide. */
  async init() {
    if (this.bundledDir && await this.backend.isEmpty()) {
      const files = fs.readdirSync(this.bundledDir).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        try { await this.backend.seed(f.replace(/\.json$/, ''), JSON.parse(fs.readFileSync(path.join(this.bundledDir, f), 'utf8'))); } catch (e) { console.warn('Thème fourni illisible :', f, e.message); }
      }
    }
    return this.load();
  }
  async load() {
    const ver = await this.backend.version();
    const next = new Map();
    const errors = [];
    for (const { id, raw, error } of await this.backend.readAll()) {
      if (error) { errors.push(`${id} : ${error}`); continue; }
      const { theme, errors: errs } = normalizeTheme(raw, id);
      errors.push(...errs);
      next.set(id, { id, ...theme });
    }
    this.themes = next;
    this.ver = ver;
    if (errors.length) console.warn('⚠️  Problèmes dans les thèmes :\n  - ' + errors.join('\n  - '));
    return errors;
  }
  /** Recharge si un autre réplica a modifié les thèmes (Redis). */
  async sync() {
    const v = await this.backend.version();
    if (v !== null && v !== this.ver) await this.load();
  }
  list() {
    return [...this.themes.values()].map((t) => {
      const types = {}, diffs = {};
      t.questions.forEach((q) => { types[q.type] = (types[q.type] || 0) + 1; diffs[q.difficulty] = (diffs[q.difficulty] || 0) + 1; });
      return { id: t.id, name: t.name, emoji: t.emoji, description: t.description, color: t.color, count: t.questions.length, types, diffs };
    }).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }
  get(id) { return this.themes.get(id); }
  get size() { return this.themes.size; }
  uniqueId(name) {
    const base = slugify(name);
    let id = base, n = 2;
    while (this.themes.has(id)) id = `${base}-${n++}`;
    return id;
  }
  /** Enregistre un thème brut. id existant = écrase ; mergeByName = fusionne avec un thème du même nom. */
  async save(raw, { id, mergeByName = false } = {}) {
    await this.sync();
    const { theme, errors } = normalizeTheme(raw);
    let targetId = id && this.themes.has(id) ? id : null;
    if (!targetId && mergeByName) {
      const existing = [...this.themes.values()].find((t) => t.name.toLowerCase() === theme.name.toLowerCase());
      if (existing) {
        targetId = existing.id;
        const seen = new Set(existing.questions.map((q) => q.question.toLowerCase()));
        theme.questions = [...existing.questions, ...theme.questions.filter((q) => !seen.has(q.question.toLowerCase()))];
        theme.emoji = existing.emoji !== '❓' ? existing.emoji : theme.emoji;
        theme.description = existing.description || theme.description;
        theme.color = existing.color || theme.color;
      }
    }
    targetId = targetId || this.uniqueId(theme.name);
    await this.backend.write(targetId, theme);
    this.themes.set(targetId, { id: targetId, ...theme });
    this.ver = await this.backend.version();
    return { id: targetId, count: theme.questions.length, errors };
  }
  async remove(id) {
    await this.sync();
    if (!this.themes.has(id)) return false;
    await this.backend.del(id);
    this.themes.delete(id);
    this.ver = await this.backend.version();
    return true;
  }
  /** Import d'un fichier (JSON ou CSV). */
  async importText(text, { filename = '', defaultName = '' } = {}) {
    const trimmed = String(text).replace(/^\uFEFF/, '').trim();
    let raws;
    const baseName = defaultName || filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      let data;
      try { data = JSON.parse(trimmed); } catch (e) { throw new Error('JSON invalide : ' + e.message); }
      if (Array.isArray(data)) raws = data.length && data[0] && Array.isArray(data[0].questions) ? data : [{ name: baseName || 'Import', questions: data }];
      else if (Array.isArray(data.themes)) raws = data.themes;
      else raws = [{ name: baseName, ...data }];
    } else {
      raws = csvToThemes(trimmed, baseName);
    }
    const results = [];
    for (const r of raws) {
      const { theme, errors } = normalizeTheme(r);
      if (!theme.questions.length) { results.push({ id: null, name: theme.name, count: 0, errors: errors.length ? errors : [`« ${theme.name} » : aucune question valide`] }); continue; }
      results.push(await this.save(r, { mergeByName: true }));
    }
    if (!results.some((r) => r.id)) throw new Error('aucune question valide trouvée — ' + results.flatMap((r) => r.errors).slice(0, 3).join(' ; '));
    return results;
  }
}

module.exports = { ThemeStore, FileThemeBackend, RedisThemeBackend, normalizeQuestion, normalizeTheme, parseCSV, csvToThemes, slugify, deaccent, TYPES };
