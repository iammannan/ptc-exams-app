// Append a combined DOTE equivalents workbook (columns CNO, SUBCODE, SUBNAME, SEM, COLNO, REGL, EQC, END EXAM: theory list,
// then practical list) to the built-in table, js/data/equivalents.js. Its rows go first and as they are: End Exam and names
// keep the first row read, so its theory rows decide. Rows already in the table stay unless the workbook covers the same
// course + old code: a row ending on the same code goes, another subject (the name differs) stays, otherwise the workbook wins.
// Afterwards run tools/add-equiv.mjs, whose checked mappings win over everything.
// Usage: node tools/append-equiv.mjs "path/to/file.xlsx" [--dry]    (needs unzip on the PATH)
import fs from 'fs';
import { execFileSync } from 'child_process';

const src = process.argv[2];
const dry = process.argv.includes('--dry');
if (!src) {
  console.error('Usage: node tools/append-equiv.mjs <file.xlsx> [--dry]');
  process.exit(1);
}
const zipText = (path) => execFileSync('unzip', ['-p', src, path], { maxBuffer: 1 << 28 }).toString('utf8');
const dec = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
const shared = [...zipText('xl/sharedStrings.xml').matchAll(/<si>(.*?)<\/si>/gs)].map((m) => dec([...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((x) => x[1]).join('')));
const colNo = (c) => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const grid = [...zipText('xl/worksheets/sheet1.xml').matchAll(/<row [^>]*>(.*?)<\/row>/gs)].map((m) => {
  const out = [];
  for (const c of m[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
    const v = (c[3] || '').match(/<v>(.*?)<\/v>/s)?.[1] ?? [...(c[3] || '').matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((x) => x[1]).join('');
    out[colNo(c[1])] = /t="s"/.test(c[2]) ? shared[+v] : dec(v);
  }
  return out;
});
const text = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const at = Object.fromEntries(grid[0].map((h, i) => [text(h).toUpperCase(), i]));
for (const h of ['CNO', 'SUBCODE', 'SUBNAME', 'SEM', 'COLNO', 'REGL', 'EQC', 'END EXAM']) if (at[h] == null) { console.error(`Column ${h} not found`); process.exit(1); }

const isCur = (scheme) => /^R(\d|$)/i.test(scheme);
const book = [];
for (const r of grid.slice(1)) {
  const course = text(r[at.CNO]), code = text(r[at.SUBCODE]).toUpperCase(), target = text(r[at.EQC]).toUpperCase().replace(/\s+/g, ''), scheme = text(r[at.REGL]).toUpperCase();
  const exam = text(r[at['END EXAM']]).toUpperCase(), col = text(r[at.COLNO]) === '' ? '' : +text(r[at.COLNO]);
  if (!course || !target) continue;
  book.push([course, code, text(r[at.SUBNAME]), +text(r[at.SEM]) || 0, scheme, target, exam, col]);
}

const dataFile = new URL('../js/data/equivalents.js', import.meta.url);
const { default: table } = await import(dataFile);
const isSelf = (r) => r[1] && r[1] === r[5];
const nameKey = (n) => String(n || '').toUpperCase().replace(/\(.*?\)/g, '').replace(/PRACTICALS?|LABORATORY|LAB\b/g, '').replace(/\bAND\b|&/g, '').replace(/[^A-Z0-9]/g, '');

// where an old code ends up, reading the workbook first, then the table
const firstRow = new Map();
for (const r of [...book, ...table.rows]) if (r[1] && !isSelf(r) && !isCur(r[4]) && !firstRow.has(r[0] + '|' + r[1])) firstRow.set(r[0] + '|' + r[1], r);
const endOf = (course, target) => {
  const hops = new Set();
  let t = target.split('/')[0];
  while (firstRow.has(course + '|' + t) && !hops.has(t)) { hops.add(t); t = firstRow.get(course + '|' + t)[5].split('/')[0]; }
  return t;
};
const bookByKey = new Map();
for (const r of book) if (r[1] && !(isSelf(r) && isCur(r[4]))) (bookByKey.get(r[0] + '|' + r[1]) || bookByKey.set(r[0] + '|' + r[1], []).get(r[0] + '|' + r[1])).push(r);
const bookSelf = new Set(book.filter((r) => isSelf(r) && isCur(r[4])).map((r) => r[0] + '|' + r[1]));

const report = { kept: 0, sameCode: 0, selfDropped: 0, otherSubject: [], overruled: [] };
const kept = table.rows.filter((r) => {
  const k = r[0] + '|' + r[1];
  if (isSelf(r) && isCur(r[4])) { if (bookSelf.has(k)) { report.selfDropped++; return false; } report.kept++; return true; }
  const over = bookByKey.get(k);
  if (!over) { report.kept++; return true; }
  const end = endOf(r[0], r[5]);
  if (over.some((x) => x[5].split('/').includes(r[5]) || x[5].split('/').map((t) => endOf(r[0], t)).includes(end))) { report.sameCode++; return false; }
  if (!over.some((x) => nameKey(x[2]) === nameKey(r[2]))) { report.otherSubject.push(`${r[0]} ${r[1]} ${r[2]} → ${end} | workbook: ${over[0][2]} → ${over[0][5]}`); report.kept++; return true; }
  report.overruled.push(`${r[0]} ${r[1]} ${r[2]} ${r[6] ? 'practical list' : 'old table'} → ${end} | workbook: ${over[0][5]} → ${endOf(r[0], over[0][5])} [${over[0][6]}]`);
  return false;
});

const rows = [...book, ...kept];
console.log({ workbookRows: book.length, tableRows: table.rows.length, keptFromTable: report.kept, droppedSameCode: report.sameCode, droppedNameRows: report.selfDropped, otherSubject: report.otherSubject.length, overruledByWorkbook: report.overruled.length, total: rows.length });
if (process.argv.includes('--list') || dry) {
  console.log('Other subject (both kept):\n  ' + report.otherSubject.join('\n  '));
  console.log('Overruled:\n  ' + report.overruled.join('\n  '));
}
if (!dry) {
  const out = `// Generated by tools/build-equiv.mjs, merge-equiv.mjs, append-equiv.mjs and add-equiv.mjs on ${new Date().toISOString()} — DOTE equivalent subjects. Do not edit by hand.
// rows: [course, old subject code, old subject name, sem, scheme, equivalent subject code, End Exam (T / P / NA), column]
export default ${JSON.stringify({ meta: { file: `${table.meta.file} + ${src.split(/[\\/]/).pop()}`, rows: rows.length }, rows })};
`;
  fs.writeFileSync(dataFile, out);
  console.log(`${out.length} bytes written`);
}
