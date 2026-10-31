// Put checked mappings (tools/equiv-verified.tsv: new code, scheme, course, old code, old subject, End Exam and semester if known) into the built-in table,
// js/data/equivalents.js. A course's own row is what the app reads first, so a mapping is added under its own course unless
// that course (or the full-time course a 3xxx / 7xxx one falls back on) already gives the same code; a different row of the
// same course and old code is replaced. A subject mapped to itself always gets its course's own row. Run it after tools/merge-equiv.mjs. Usage: node tools/add-equiv.mjs
import fs from 'fs';

const dataFile = new URL('../js/data/equivalents.js', import.meta.url);
const { default: table } = await import(dataFile);
const wanted = fs.readFileSync(new URL('./equiv-verified.tsv', import.meta.url), 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split('\t'));

// the semester the old code shows: 7-digit 4 · course · sem · col · x, 5-digit s · g · sem sem · col
const semOf = (code) => (/^\d{7}$/.test(code) ? +code[4] : /^\d{5}$/.test(code) ? +code.slice(2, 4) : 0);
const fullTime = (c) => ('37'.includes(c[0]) ? '1' + c.slice(1) : c);
const has = (rows, course, code, target) => rows.some((r) => r[0] === course && r[1] === code && r[5].split('/').includes(target));
const hasAny = (rows, course, code) => rows.some((r) => r[0] === course && r[1] === code);

let rows = table.rows;
const added = [], replaced = [];
for (const [target, scheme, course, code, name, exam, sem] of wanted) {
  if (has(rows, course, code, target)) continue;
  if (code !== target && !hasAny(rows, course, code) && has(rows, fullTime(course), code, target)) continue;
  for (const r of rows) if (r[0] === course && r[1] === code) replaced.push(`${course} ${code}: ${r[5]} → ${target}`);
  rows = rows.filter((r) => !(r[0] === course && r[1] === code));
  const semester = +sem || semOf(code);
  rows.push(exam ? [course, code, name, semester, scheme, target, exam] : [course, code, name, semester, scheme, target]);
  added.push(`${course} ${code} → ${target}`);
}

const head = fs.readFileSync(dataFile, 'utf8').split('\n').slice(0, 2).join('\n');
fs.writeFileSync(dataFile, `${head}\nexport default ${JSON.stringify({ meta: { ...table.meta, rows: rows.length }, rows })};\n`);
console.log(`${wanted.length} checked; ${added.length} added, of which ${replaced.length} replaced another code; ${rows.length} rows now`);
console.log(added.map((x) => '  ' + x).join('\n'));
console.log('Replaced:\n' + replaced.map((x) => '  ' + x).join('\n'));
