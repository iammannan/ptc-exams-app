// Old-scheme subject → R2023 alternate, using DOTE's "Alternate Subjects for Theory Subjects"
// table, looked up in the student's own course table (per course + regulation).

const norm = (s) =>
  String(s).toUpperCase().replace(/&/g, ' AND ').replace(/[–—-]/g, ' ').replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\b(LABORATORY|LAB)\b/g, 'PRACTICAL').replace(/\s+/g, ' ').trim();
const STOP = new Set(['AND', 'OF', 'THE', 'IN', 'FOR', 'WITH', 'ITS']);
const tokens = (s) => new Set(norm(s).split(' ').filter((w) => w && !STOP.has(w)));

export function similarity(a, b) {
  if (norm(a).replace(/ /g, '') === norm(b).replace(/ /g, '')) return 1;
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size);
}
const isPractical = (s) => /\bPRACTICAL\b/.test(norm(s));

// Decode the semester / column (and owning course) from an old-scheme code:
//  N(Z) 7-digit  4 CCC S K E → course 1CCC, sem S, column K, E≠0 = elective
//  N(Z) 5-digit  4 00 S K    → common first-year subject
//  M    5-digit  3 CC S K    → course 10CC (CC = 00: common)
export function decodeOldCode(code) {
  let m;
  if ((m = code.match(/^4(\d{3})(\d)(\d)(\d)$/))) return { scheme: 'N', course: '1' + m[1], sem: +m[2], col: +m[3], elective: +m[4] };
  if ((m = code.match(/^400(\d)(\d)$/))) return { scheme: 'N', course: '', sem: +m[1], col: +m[2], elective: 0 };
  if ((m = code.match(/^3(\d{2})(\d)(\d)$/))) return { scheme: 'M', course: m[1] === '00' ? '' : '10' + m[1], sem: +m[2], col: +m[3], elective: 0 };
  return null;
}

// alternates: { tables: { "course|regl": [[sem, col, oldNameIdx, newCode, newNameIdx, examIdx], …] }, names: [], exams: [] }
export function makeMapper(alternates) {
  const { tables, names, exams } = alternates;
  const row = (r) => ({ sem: r[0], col: r[1], oldName: names[r[2]], code: r[3], name: names[r[4]], exam: exams[r[5]] });
  const cache = new Map();
  const table = (k) => {
    if (!cache.has(k)) cache.set(k, (tables[k] || []).map(row));
    return cache.get(k);
  };

  // → { alt: {code, name, exam, oldName, sem, col}, how, score } | { alt: null, how }
  return function mapSubject({ code, name, regulation, sem }, course) {
    const rows = table(`${course}|${regulation}`);
    if (!rows.length) return { alt: null, how: `No ${regulation} table for course ${course}` };
    const d = decodeOldCode(code);
    // the code's sem/column only describe the student's own table when the code belongs to that course
    const ownCode = d && (!d.course || d.course === course || d.course.slice(1) === course.slice(1));
    let best = null;
    for (const r of rows) {
      if (isPractical(name) !== isPractical(r.oldName)) continue;
      const sim = similarity(r.oldName, name);
      const slot = ownCode && r.sem === d.sem && r.col === d.col;
      const score = sim + (slot ? 0.5 : 0) + (r.sem === sem ? 0.1 : 0);
      if (!best || score > best.score) best = { r, sim, slot, score };
    }
    if (best && best.sim >= 0.5) return { alt: best.r, how: best.slot ? 'sem/column + name' : 'name', score: best.sim };
    if (best && best.slot) return { alt: best.r, how: 'sem/column (name differs)', score: best.sim, check: true };
    return { alt: null, how: 'Not in alternate subjects list' };
  };
}
