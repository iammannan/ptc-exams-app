// Merge DOTE's practical equivalents list (PRAC_EQU_*.csv) into the built-in table, js/data/equivalents.js.
// CSV columns: REGL, NCNO, COURSE NAME, SEM, COL NO, SUB CODE, SUBNAME, SUBCODE EQU, SUBCODE_EQU_NAME, SUBTYPE (P / PT).
// - Every row gets End Exam P. COL NO is left out on purpose: a table with column numbers turns on matching hall-ticket
//   subjects by name (equiv.js deriveFromTickets), and against a practicals-only list that would mark theory papers practical.
// - The PDF-made text is repaired: doubled letters ("PPRROOGGRRAAMM") and subject names inside the code column.
// - For the same course + old code the CSV wins. A built-in row stays only when it is another subject (the name differs)
//   and it ends on a current code; the app then picks between them by the hall-ticket name.
// - Each single new code gets its own R2023 row with its name, so nominal-roll codes (which have no names) show one.
// Usage: node tools/merge-equiv.mjs "path/to/PRAC_EQU.csv"   (tools/build-equiv.mjs would rebuild from the old list only)
import fs from 'fs';

const src = process.argv[2];
if (!src) {
  console.error('Usage: node tools/merge-equiv.mjs <PRAC_EQU.csv>');
  process.exit(1);
}
const dataFile = new URL('../js/data/equivalents.js', import.meta.url);
const { default: old } = await import(dataFile);

const parseLine = (line) => {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
};
// "PPRROOGGRRAAMM" → "PROGRAM", "((CC))" → "(C)", "IIII" → "II"; "II" itself is left alone
const undouble = (s) => String(s).split(/(\s+|\/)/).map((t) =>
  (t.length >= 4 && t.length % 2 === 0 && [...t].every((c, i) => i % 2 || c === t[i + 1]) ? [...t].filter((_, i) => !(i % 2)).join('') : t)).join('').replace(/\s+/g, ' ').trim();
const CODE = /\b(?:[A-Z]{2}\d{6}|\d{10}|\d{7}|\d{5}|[A-Z]{3}\d{3})\b/g;
const isCurrent = (code) => /^(?:[A-Z]{2}\d{6}|\d{10})$/.test(code);
const nameKey = (n) => String(n || '').toUpperCase().replace(/\(.*?\)/g, '').replace(/PRACTICALS?|LABORATORY|LAB\b/g, '').replace(/\bAND\b|&/g, '').replace(/[^A-Z0-9]/g, '');

const skipped = [];
const csv = [];
const seen = new Set();
const lines = fs.readFileSync(src, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim()).slice(1);
for (const line of lines) {
  const [regl, course, , sem, , code, name, eq, eqName] = parseLine(line);
  const row = { course: course.trim(), code: undouble(code).toUpperCase(), name: undouble(name), sem: +sem || 0, scheme: regl.trim().toUpperCase(), eqName: undouble(eqName) };
  row.target = (undouble(eq).toUpperCase().match(CODE) || []).join('/'); // a code, or several, even with a name around them
  if (!row.target) { skipped.push(`${row.scheme} ${row.course} ${row.code} ${row.name}: EQU "${eq.trim()}"`); continue; }
  const k = [row.course, row.code, row.scheme, row.target].join('|');
  if (!seen.has(k)) { seen.add(k); csv.push(row); }
}

const csvByKey = new Map();
for (const r of csv) (csvByKey.get(r.course + '|' + r.code) || csvByKey.set(r.course + '|' + r.code, []).get(r.course + '|' + r.code)).push(r);
const oldByKey = new Map(old.rows.filter((r) => r[1] !== r[5]).map((r) => [r[0] + '|' + r[1], r]));
const oldEnd = (course, code) => {
  const hops = new Set();
  let t = code;
  while (oldByKey.has(course + '|' + t) && !hops.has(t)) { hops.add(t); t = oldByKey.get(course + '|' + t)[5]; }
  return t;
};
const report = { replaced: 0, same: 0, kept: [], untouched: 0 };
const keep = old.rows.filter((r) => {
  const over = csvByKey.get(r[0] + '|' + r[1]);
  if (!over) { report.untouched++; return true; }
  const end = oldEnd(r[0], r[1]);
  if (over.some((x) => x.target.split('/').includes(end))) { report.same++; return false; }
  if (!over.some((x) => nameKey(x.name) === nameKey(r[2])) && isCurrent(end)) { report.kept.push(`${r[0]} ${r[1]} ${r[2]} → ${end} (CSV: ${over[0].name} → ${over[0].target})`); return true; }
  report.replaced++;
  return false;
});

// the new codes' names: the commonest spelling of each code's name, one row per course
const counts = new Map();
for (const r of csv) if (isCurrent(r.target) && r.eqName && !r.eqName.includes('/')) {
  const m = counts.get(r.target) || counts.set(r.target, new Map()).get(r.target);
  m.set(r.eqName, (m.get(r.eqName) || 0) + 1);
}
const bestName = new Map([...counts].map(([code, m]) => [code, [...m].sort((a, b) => b[1] - a[1] || (a[0] === a[0].toUpperCase() ? -1 : 1))[0][0]]));
const selfSeen = new Set(csv.filter((r) => r.code === r.target).map((r) => r.course + '|' + r.code));
const self = [];
for (const r of csv) {
  const k = r.course + '|' + r.target;
  if (!isCurrent(r.target) || !bestName.has(r.target) || selfSeen.has(k)) continue;
  selfSeen.add(k);
  self.push([r.course, r.target, bestName.get(r.target), '', 'R2023', r.target, 'P']);
}

const rows = [...keep, ...csv.map((r) => [r.course, r.code, r.name, r.sem, r.scheme, r.target, 'P']), ...self];
const out = `// Generated by tools/build-equiv.mjs and tools/merge-equiv.mjs on ${new Date().toISOString()} — DOTE equivalent subjects. Do not edit by hand.
// rows: [course, old subject code, old subject name, sem, scheme, equivalent subject code, End Exam (rows from the practical list: P)]
export default ${JSON.stringify({ meta: { file: `${old.meta.file.split(' + ')[0]} + ${src.split(/[\\/]/).pop()}`, rows: rows.length }, rows })};
`;
fs.writeFileSync(dataFile, out);
const onlyR = [...csvByKey.values()].filter((l) => l.every((x) => x.scheme === 'R')).length;
console.log({ csvLines: lines.length, csvRows: csv.length, duplicatesDropped: lines.length - csv.length - skipped.length, skipped: skipped.length, oldRows: old.rows.length, oldUntouched: report.untouched, oldSameAsCsv: report.same, oldReplacedByCsv: report.replaced, oldKeptAsOtherSubject: report.kept.length, nameRows: self.length, total: rows.length, oldCodesOnlyUnderR: onlyR, bytes: out.length });
console.log('Skipped:\n  ' + skipped.join('\n  '));
console.log('Kept as another subject:\n  ' + report.kept.join('\n  '));
