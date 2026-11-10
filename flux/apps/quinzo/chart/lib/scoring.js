// Calcul des points pour chaque type de question.
const { deaccent } = require('./themes');

const MAX = 1000;

function normText(s) {
  return deaccent(String(s || ''))
    .toLowerCase()
    .replace(/[’'`]/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(le|la|les|l|un|une|des|du|de|d|the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Une réponse libre est acceptée si elle est proche (fautes de frappe tolérées) d'une réponse attendue. */
function textMatches(given, accepted) {
  const g = normText(given);
  if (!g) return false;
  return accepted.some((acc) => {
    const a = normText(acc);
    if (!a) return false;
    if (g === a) return true;
    if (/^\d+$/.test(a)) return g === a; // nombres : exact
    const allowed = a.length >= 10 ? 2 : a.length >= 5 ? 1 : 0;
    return levenshtein(g, a) <= allowed;
  });
}

/** Facteur de rapidité entre 0 et 1. */
function speed(timeMs, totalMs) {
  return Math.max(0, Math.min(1, 1 - timeMs / totalMs));
}

/**
 * Évalue une réponse. `cur` est la question en cours (avec mapping d'affichage).
 * Retourne { correct, base, partial } — base sans bonus de série.
 */
function evaluate(cur, answer, timeMs, totalMs) {
  const q = cur.q;
  const sp = speed(timeMs, totalMs);
  if (answer === undefined || answer === null) return { correct: false, base: 0 };
  switch (q.type) {
    case 'qcm': {
      const ok = Number(answer) === cur.correctDisplay;
      return { correct: ok, base: ok ? Math.round(MAX / 2 + (MAX / 2) * sp) : 0 };
    }
    case 'vraifaux': {
      const ok = Boolean(answer) === q.answer;
      return { correct: ok, base: ok ? Math.round(MAX / 2 + (MAX / 2) * sp) : 0 };
    }
    case 'texte': {
      const ok = textMatches(answer, q.answer);
      return { correct: ok, base: ok ? Math.round(MAX / 2 + (MAX / 2) * sp) : 0 };
    }
    case 'estimation': {
      const v = Number(answer);
      if (!Number.isFinite(v)) return { correct: false, base: 0 };
      const target = q.answer;
      let err, tol;
      if (q.min !== undefined && q.max !== undefined) {
        // relatif à l'amplitude du curseur (utile pour les années)
        err = Math.abs(v - target) / (q.max - q.min);
        tol = q.tolerance || 0.25;
      } else {
        err = target === 0 ? Math.abs(v) : Math.abs(v - target) / Math.abs(target);
        tol = q.tolerance || 0.5;
      }
      const ratio = Math.max(0, 1 - err / tol);
      const pts = Math.round(MAX * ratio * ratio); // courbe : être proche paie beaucoup plus
      return { correct: err <= tol * 0.1, base: pts, partial: ratio > 0 && err > tol * 0.1, error: err };
    }
    case 'ordre': {
      // answer = indices d'affichage dans l'ordre choisi
      if (!Array.isArray(answer) || answer.length !== q.items.length) return { correct: false, base: 0 };
      const chosen = answer.map((d) => cur.order[d]); // indices originaux
      let good = 0;
      chosen.forEach((orig, pos) => { if (orig === pos) good++; });
      const n = q.items.length;
      const perfect = good === n;
      const base = perfect ? Math.round(MAX / 2 + (MAX / 2) * sp) : Math.round((MAX / 2) * (good / n));
      return { correct: perfect, base, partial: !perfect && good > 0, good };
    }
    default:
      return { correct: false, base: 0 };
  }
}

function streakBonus(streak) {
  return streak >= 2 ? Math.min(streak - 1, 5) * 50 : 0;
}

module.exports = { evaluate, textMatches, normText, streakBonus, levenshtein };
