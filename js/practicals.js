// Practicals tab: hall-ticket subjects whose End Exam is Practical / Practicum (from the uploaded equivalents table),
// course-wise or day-wise (dates from imported practical exam files), with each subject's strength: own-code candidates
// plus old-scheme candidates mapped onto it (equivalents). Theory subjects stay in QP Statistics.
import { onTickets, dmy, fullDate, weekday, withPdf, pdfHeader, TABLE_STYLE, slotFromTime, slotLabel, setImportedSittings } from './halltickets.js';
import { mapSubject, onEquiv, subjectExam, hasExamTypes, equivalentsOf, isOldPracticalCode } from './equiv.js';
import { $, esc, pref, downloadCsv, slug, pdfFooter, toast } from './util.js';
import { commonCourse } from './qpcalc.js';
import { kv, kvReady } from './kv.js';

await kvReady;
let tickets = [];

/* ---------- imported practical exam files (.ptcexams) ---------- */
// One file per subject and department: its batches (date, 3-hour slot, register numbers), the students and examiners.
// kv "prImports": { 'course|code': import }. The batches become the subject's sittings, each with its own students.
let imports = kv.get('prImports', {});
const isoDate = (d) => { const m = String(d || '').match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''; };
const letters = (n) => String(n || '').toUpperCase().replace(/\([^)]*\)/g, '').replace(/[^A-Z]/g, '');
function readImport(j, file) {
  if (!j?.subjectCode || !Array.isArray(j.timeTables)) throw new Error('not a practical exam file (no subjectCode / timeTables)');
  const who = (title, name, desig) => [[title, name].filter(Boolean).join(' '), desig].filter(Boolean).join(', ');
  return {
    file, importedAt: new Date().toISOString(),
    code: String(j.subjectCode).trim(), name: j.subjectName || '', course: String(j.departmentCode || '').trim(), courseName: j.departmentName || '',
    sem: j.semester || '', regulation: j.regulation || '',
    internal: who(j.internalTitle, j.internalExaminerName, j.internalExaminerDesignation), external: who(j.externalTitle, j.externalExaminerName, j.externalExaminerDesignation),
    batches: j.timeTables.map((b, i) => ({ no: i + 1, date: isoDate(b.date), rawDate: b.date || '', time: String(b.session || ''), regs: (b.selectedRegisterNumbers || []).map(String) })),
    all: (j.allRegisterNumbers || []).map(String),
    names: Object.fromEntries((j.selectedStudents || []).map((s) => [String(s.RegNo), s.Name || ''])),
  };
}
// the subject's sittings: every imported batch of that code (Basic Engineering: one file per department)
const syncSittings = (code) => setImportedSittings(code, Object.values(imports).filter((x) => x.code === code)
  .flatMap((x) => x.batches.filter((b) => b.date).map((b) => ({ date: b.date, slot: slotFromTime(b.time), regs: b.regs }))));
async function importFiles(files, forCode) {
  const done = [];
  for (const f of files) {
    try {
      const imp = readImport(JSON.parse(await f.text()), f.name);
      imports[imp.course + '|' + imp.code] = imp;
      done.push(imp);
      if (forCode && imp.code !== forCode) toast(`${f.name} is for ${imp.code}, not ${forCode}: imported under ${imp.code}`);
    } catch (e) {
      toast(`${f.name}: ${e.message || 'could not read the file'}`);
    }
  }
  if (!done.length) return;
  await kv.set('prImports', imports);
  for (const code of new Set(done.map((x) => x.code))) await syncSittings(code); // reloads the hall tickets → render
  const issues = done.reduce((n, x) => n + issueCount(verify(x)), 0);
  toast(`${done.length} file(s) imported · ${issues ? `${issues} issue(s) to check` : 'every register number matches'}`);
}
async function removeImport(key) {
  const code = imports[key]?.code;
  delete imports[key];
  await kv.set('prImports', imports);
  if (code) await syncSittings(code);
}

// Two dated papers of a student that overlap in time, at least one of them a practical.
const span = (time, session) => {
  const t = [...String(time).matchAll(/(\d{1,2})[.:](\d{2})\s*(am|pm|noon)/gi)].map((m) => ((+m[1] % 12) + (/pm|noon/i.test(m[3]) ? 12 : 0)) * 60 + +m[2]);
  return t.length > 1 && t[1] > t[0] ? [t[0], t[1]] : session === 'FN' ? [600, 780] : [840, 1020];
};
function findClashes() {
  const out = [];
  for (const t of tickets) {
    const list = [];
    for (const s of t.subjects) {
      if (!s.date) continue;
      const code = mapSubject(s.code, t.courseNo)?.code || s.code;
      if (list.some((x) => x.code === code)) continue; // two old codes of one paper
      const [from, to] = span(s.time, s.session);
      list.push({ code, s, from, to, prac: subjectExam(s.code, t.courseNo) === 'P' });
    }
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.s.date === b.s.date && (a.prac || b.prac) && a.from < b.to && b.from < a.to) out.push({ t, a, b });
      }
  }
  return out;
}
const when = (s) => `${dmy(s.date)} ${slotLabel(s.time, s.session)}`;

// An imported file checked against the hall tickets of its department: every register number present, names,
// batches, and clashes with other practicals / theory papers.
function verify(imp, clashes = findClashes()) {
  const expected = new Map(); // reg → { t, s }: hall tickets of this course that have the subject (own or old code)
  for (const t of tickets) {
    if (imp.course && t.courseNo !== imp.course) continue;
    const s = t.subjects.find((x) => (mapSubject(x.code, t.courseNo)?.code || x.code) === imp.code);
    if (s) expected.set(t.regNo, { t, s });
  }
  const byReg = new Map(tickets.map((t) => [t.regNo, t]));
  const inBatch = new Map(); // reg → [batch]
  for (const b of imp.batches) for (const r of b.regs) (inBatch.get(r) || inBatch.set(r, []).get(r)).push(b);
  return {
    expected: expected.size, inFile: inBatch.size,
    missing: [...expected.values()].filter(({ t }) => !inBatch.has(t.regNo)),
    extra: [...inBatch.keys()].filter((r) => !expected.has(r)).map((r) => {
      const t = byReg.get(r);
      return { reg: r, name: imp.names[r] || t?.name || '', why: !t ? 'no hall ticket' : t.courseNo !== imp.course ? `hall ticket is for course ${t.courseNo}` : `hall ticket has no ${imp.code}` };
    }),
    names: [...inBatch.keys()].filter((r) => expected.has(r) && imp.names[r] && letters(imp.names[r]) !== letters(expected.get(r).t.name)).map((r) => ({ reg: r, file: imp.names[r], ticket: expected.get(r).t.name })),
    twice: [...inBatch].filter(([, b]) => b.length > 1).map(([reg, b]) => ({ reg, batches: b.map((x) => x.no) })),
    unbatched: imp.all.filter((r) => !inBatch.has(r)),
    undated: imp.batches.filter((b) => !b.date),
    clashes: clashes.filter((c) => inBatch.has(c.t.regNo) && (c.a.code === imp.code || c.b.code === imp.code)),
  };
}
const issueCount = (v) => v.missing.length + v.extra.length + v.names.length + v.twice.length + v.unbatched.length + v.undated.length + v.clashes.length;
const importsFor = (r) => Object.entries(imports).filter(([, x]) => x.code === r.code && (BASIC[r.course] ? commonCourse(x.course) === r.course : x.course === r.course));

function verifyHtml(key, imp, v) {
  const n = issueCount(v);
  const list = (title, items) => items.length ? `<li><b>${title} (${items.length})</b><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul></li>` : '';
  const other = ({ a, b }) => (a.code === imp.code ? [a, b] : [b, a]);
  return `<details class="card import${n ? ' warn-card' : ''}"${n ? ' open' : ''}>
    <summary><b>${esc(imp.course)} · ${esc(imp.code)}</b> ${esc(imp.name)} — ${imp.batches.length} batch(es), ${v.inFile} in the file, ${v.expected} on the hall tickets
      ${n ? `<span class="badge warn">${n} issue(s)</span>` : '<span class="badge ok">✓ all register numbers match</span>'}
      <span class="muted">${esc(imp.file)}</span> <button type="button" class="btn ghost sm" data-prunimport="${esc(key)}" title="Remove this import (its dates go too)">Remove</button></summary>
    <p class="muted">Internal: ${esc(imp.internal || '—')} · External: ${esc(imp.external || '—')} · ${imp.batches.map((b) => `Batch ${b.no}: ${b.date ? `${dmy(b.date)} ${esc(b.time)}` : 'no date'} (${b.regs.length})`).join(' · ')}</p>
    ${n ? `<ul class="issues">
      ${list('On the hall tickets, not in the file', v.missing.map(({ t, s }) => `${esc(t.regNo)} ${esc(t.name)} <span class="muted">(${esc(s.code)})</span>`))}
      ${list('In the file, not expected', v.extra.map((x) => `${esc(x.reg)} ${esc(x.name)} — ${esc(x.why)}`))}
      ${list('Name differs', v.names.map((x) => `${esc(x.reg)}: file “${esc(x.file)}”, hall ticket “${esc(x.ticket)}”`))}
      ${list('In two batches', v.twice.map((x) => `${esc(x.reg)}: batches ${x.batches.join(', ')}`))}
      ${list('Listed but in no batch', v.unbatched.map((r) => `${esc(r)} ${esc(imp.names[r] || '')}`))}
      ${list('Batch without a date', v.undated.map((b) => `Batch ${b.no}: “${esc(b.rawDate)}”`))}
      ${list('Clash with another exam', v.clashes.map((c) => { const [me, o] = other(c); return `${esc(c.t.regNo)} ${esc(c.t.name)}: ${esc(imp.code)} ${esc(when(me.s))} and ${o.prac ? 'practical' : 'theory'} ${esc(o.code)} ${esc(o.s.name || '')} ${esc(when(o.s))}`; }))}
    </ul>` : ''}
  </details>`;
}
function renderImports() {
  const course = $('prCourse').value;
  const list = Object.entries(imports).filter(([, x]) => !course || (BASIC[course] ? isBasic(x.code) && commonCourse(x.course) === course : x.course === course))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  if (!list.length) return ($('prImports').innerHTML = '');
  const clashes = findClashes();
  const checked = list.map(([k, x]) => [k, x, verify(x, clashes)]);
  const n = checked.reduce((a, [, , v]) => a + issueCount(v), 0);
  $('prImports').innerHTML = `<div class="result-head"><div><div class="count">Imported practical exam files</div>
    <div class="muted">${list.length} file(s) · ${n ? `${n} issue(s) to check` : 'every register number matches the hall tickets, no clashes'}</div></div></div>
    ${checked.map(([k, x, v]) => verifyHtml(k, x, v)).join('')}`;
}

// Date and slot-wise count of practical candidates (dated sittings).
function renderStats(list) {
  const dated = list.filter((r) => r.date);
  if (!dated.length) return ($('prStats').innerHTML = '');
  const slot = (r) => slotLabel(r.time, r.session);
  const cols = [...new Map(dated.map((r) => [slot(r), span(r.time, r.session)[0]]))].sort((a, b) => a[1] - b[1]).map(([c]) => c);
  const days = [...new Set(dated.map((r) => r.date))].sort();
  const cell = (rows) => rows.length ? `<b>${rows.reduce((n, r) => n + r.total, 0)}</b> <span class="muted">(${rows.length} subj.)</span>` : '–';
  const at = (d, c) => dated.filter((r) => r.date === d && (!c || slot(r) === c));
  $('prStats').innerHTML = `<section class="card flush day"><header class="day-head"><div class="day-date"><b>Date and session-wise statistics</b><span class="muted">${days.length} day(s) · candidates (subjects)</span></div></header>
    <div class="table-wrap"><table class="data papers"><thead><tr><th>Date</th>${cols.map((c) => `<th class="num">${esc(c)}</th>`).join('')}<th class="num">Day total</th></tr></thead>
    <tbody>${days.map((d) => `<tr><td>${weekday(d)} ${dmy(d)}</td>${cols.map((c) => `<td class="num">${cell(at(d, c))}</td>`).join('')}<td class="num total">${cell(at(d))}</td></tr>`).join('')}
    <tr class="day-total"><td>Total</td>${cols.map((c) => `<td class="num">${cell(dated.filter((r) => slot(r) === c))}</td>`).join('')}<td class="num total">${cell(dated)}</td></tr></tbody></table></div></section>`;
}
// Basic Engineering: the first-year subjects every department shares (letter codes: EN231350, DP232270, CET232120 …),
// shown under 1000 (full time) / 3000 (part time) with all departments' candidates added up.
const BASIC = { 1000: 'BASIC ENGINEERING', 3000: 'BASIC ENGINEERING (PART TIME)' };
const isBasic = (code) => /^[A-Z]{2,3}\d{6}$/.test(code);
// Semester of the subject itself, read from its code: R2023 1052233440 → 3 (course · 23 · sem …), DP232270 → 2;
// old 7-digit 4020470 → 4, 5-digit 30015 → 1. Old codes mapped onto it may come from other semesters.
const semOf = (code) => {
  const d = /^\d{10}$/.test(code) ? code[6] : /^[A-Z]{2,3}\d{6}$/.test(code) ? code.replace(/^[A-Z]+/, '')[2] : /^\d{7}$/.test(code) ? code[4] : /^\d{5}$/.test(code) ? code.slice(2, 4) : '';
  return +d || 0;
};
const open = new Set(); // expanded row keys (name list)
const ICON = {
  up: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 16V4m0 0-4 4m4-4 4 4M4 20h16"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 4v12m0 0-4-4m4 4 4-4M4 20h16"/></svg>',
};

// one row per course + practical subject + sitting
function collect() {
  const course = $('prCourse').value;
  const q = $('prSearch').value.trim().toLowerCase();
  const rows = new Map();
  const first = new Map(); // course|code|regNo → the row that already counts this student for the subject
  for (const t of tickets) {
    if (BASIC[course] ? commonCourse(t.courseNo) !== course : course && t.courseNo !== course) continue;
    for (const s of t.subjects) {
      if (subjectExam(s.code, t.courseNo) !== 'P') continue;
      const m = mapSubject(s.code, t.courseNo);
      const code = m ? m.code : s.code;
      // Basic Engineering papers sit only under 1000 / 3000 (one row for all departments), never under a department
      const basic = isBasic(code);
      if (BASIC[course] ? !basic : course && basic) continue;
      const rc = basic ? commonCourse(t.courseNo) : t.courseNo;
      // two old codes of one student can map to the same subject (Engineering Graphics I + II → DP232270):
      // the student sits it once, so is counted once, and the repeat is listed by name
      const had = first.get(rc + '|' + code + '|' + t.regNo);
      if (had) { had.dups.push({ t, s, kept: had.students.find((x) => x.t === t)?.s.code }); continue; }
      const k = [rc, code, s.date || '', s.session || '', s.date ? s.time || '' : ''].join('|'); // one row per lab slot (9 – 12, 12 – 3 …)
      const r = rows.get(k) || rows.set(k, { key: k, course: rc, depts: new Map(), code, name: '', oldName: '', sem: new Set(), date: s.date || '', session: s.session || '', time: s.time || '', setDate: !!s.setDate, regs: new Set(), R: 0, S: 0, own: 0, old: new Map(), students: [], dups: [] }).get(k);
      first.set(rc + '|' + code + '|' + t.regNo, r);
      if (r.regs.has(t.regNo)) continue;
      r.regs.add(t.regNo);
      r[s.type] = (r[s.type] || 0) + 1;
      r.sem.add(s.sem);
      r.depts.set(t.courseNo, (r.depts.get(t.courseNo) || 0) + 1);
      if (s.code === code) { r.own++; r.name ||= s.name; } else { r.old.set(s.code, (r.old.get(s.code) || 0) + 1); r.oldName ||= s.name; }
      r.students.push({ t, s });
    }
  }
  const list = [...rows.values()].map((r) => ({ ...r, name: r.name || r.oldName, total: r.regs.size, sem: semOf(r.code) ? new Set([semOf(r.code)]) : r.sem }));
  return list.filter((r) => !q || `${r.course} ${r.code} ${r.name} ${[...r.old.keys()].join(' ')}`.toLowerCase().includes(q));
}

function render() {
  const ready = hasExamTypes();
  $('prEmpty').hidden = ready && tickets.length > 0;
  $('prEmpty').textContent = !ready
    ? 'Upload the equivalents table with an END EXAM column (Equivalent Subjects Mapping → Upload equivalents table) to see practical subjects here.'
    : 'No hall tickets yet. Upload hall ticket PDFs in the Hall Tickets tab.';
  const list = ready ? collect() : [];
  const byDay = $('prGroup').value === 'day';
  renderImports();
  renderStats(list);
  const clashes = Object.keys(imports).length ? findClashes() : [];
  for (const id of ['prCsvBtn', 'prPdfBtn']) $(id).disabled = !list.length;
  const total = list.reduce((n, r) => n + r.total, 0);
  const dated = list.filter((r) => r.date);
  const dups = list.reduce((n, r) => n + r.dups.length, 0);
  $('prKpis').innerHTML = !ready ? '' : [
    { v: new Set(list.map((r) => r.course + '|' + r.code)).size, l: 'Practical subjects', sub: `${new Set(list.map((r) => r.course)).size} course(s)` },
    { v: total, l: 'Candidates', sub: `Regular ${list.reduce((n, r) => n + (r.R || 0), 0)} · Supplementary ${list.reduce((n, r) => n + (r.S || 0), 0)}${dups ? ` · ${dups} repeated through equivalents, counted once` : ''}` },
    { v: list.reduce((n, r) => n + [...r.old.values()].reduce((a, b) => a + b, 0), 0), l: 'Through equivalents', sub: 'old-scheme candidates mapped onto a practical' },
    { v: dated.length, l: 'Dated sittings', sub: `${list.length - dated.length} subject(s) without a date — set one with ✎` },
  ].map((t) => `<div class="kpi"><span class="l">${t.l}</span><b>${t.v}</b><span class="sub">${esc(t.sub)}</span></div>`).join('');
  const groups = new Map();
  const sorted = [...list].sort(byDay
    ? (a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.session || '').localeCompare(b.session || '') || a.course.localeCompare(b.course) || a.code.localeCompare(b.code, undefined, { numeric: true })
    : (a, b) => a.course.localeCompare(b.course) || Math.min(...a.sem) - Math.min(...b.sem) || a.code.localeCompare(b.code, undefined, { numeric: true }) || (a.date || '').localeCompare(b.date || ''));
  for (const r of sorted) {
    const k = byDay ? r.date || '' : r.course;
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  }
  $('prList').innerHTML = [...groups].map(([k, rows]) => `<section class="card flush day">
      <header class="day-head"><div class="day-date"><b>${esc(byDay ? (k ? fullDate(k) : 'Not dated') : BASIC[k] ? `${k} – ${BASIC[k]} (all departments)` : `${k} – ${rows[0].students[0]?.t.courseName || ''}`)}</b><span class="muted">${rows.length} subject(s)</span></div>
        <div class="day-stats"><span class="pill">Candidates <b>${rows.reduce((n, r) => n + r.total, 0)}</b></span></div></header>
      <div class="table-wrap"><table class="data papers">
        <thead><tr>${byDay ? '<th>Course</th>' : '<th>Date</th>'}<th class="num">Sem</th><th>Subject code</th><th>Subject</th><th class="num">Own code</th><th>Equivalents (old codes)</th><th class="num">R</th><th class="num">S</th><th class="num">Strength</th><th></th><th></th></tr></thead>
        <tbody>${rows.map((r) => {
          // every hall-ticket entry, the repeated ones too (they are taken off the strength as −1 each)
          const seen = new Map(r.old);
          for (const d of r.dups) if (d.s.code !== r.code) seen.set(d.s.code, (seen.get(d.s.code) || 0) + 1);
          const eqs = equivalentsOf(r.code, r.course).map((e) => ({ ...e, n: seen.get(e.code) || 0 }));
          for (const [c, n] of seen) if (!eqs.some((e) => e.code === c)) eqs.push({ code: c, scheme: '', n });
          const isOpen = open.has(r.key);
          const imported = importsFor(r);
          const issues = imported.reduce((n, [, x]) => n + issueCount(verify(x, clashes)), 0);
          return `<tr class="paper${isOpen ? ' open' : ''}" data-key="${esc(r.key)}" tabindex="0">
            <td>${byDay ? `${esc(r.course)} <span class="badge ${r.session.toLowerCase()}">${esc(slotLabel(r.time, r.session))}</span>` : r.date ? `${weekday(r.date)} ${dmy(r.date)} <span class="badge ${r.session.toLowerCase()}">${esc(slotLabel(r.time, r.session))}</span>` : '<span class="muted">not dated</span>'}</td>
            <td class="num">${[...r.sem].sort().join(', ')}</td>
            <td><b>${esc(r.code)}</b>${imported.length ? ` <span class="badge ${issues ? 'warn' : 'ok'}" title="${esc(imported.map(([, x]) => x.file).join(', '))}">${issues ? `Imported · ${issues} issue(s)` : 'Imported ✓'}</span>` : ''}${isOldPracticalCode(r.code, r.course) ? ' <span class="badge" title="Old-scheme practical: not on DOTE\'s list of alternates for theory subjects, so it is examined as a practical under its own code">old practical</span>' : ''}</td>
            <td class="wrap">${esc(r.name)}</td>
            <td class="num">${r.own}</td>
            <td class="wrap">${eqs.length ? eqs.map((e) => `<span class="${e.n ? '' : 'muted'}"${e.scheme ? ` title="${esc(e.scheme)}"` : ''}>${esc(e.code)}[<b>${e.n}</b>]</span>`).join(', ') : '<span class="muted">—</span>'}</td>
            <td class="num">${r.R || 0}</td><td class="num">${r.S || 0}</td><td class="num total">${r.total}${r.dups.length ? ` <span class="badge warn" title="${esc(`${r.total + r.dups.length} hall-ticket entries − ${r.dups.length} repeated = ${r.total}\n` + r.dups.map((d) => `−1 ${d.s.code}: ${d.t.regNo} ${d.t.name} (counted under ${d.kept})`).join('\n'))}">${r.total + r.dups.length} − ${r.dups.length}</span>` : ''}</td>
            <td class="row-actions"><button type="button" class="btn ghost sm" data-primport="${esc(r.code)}" title="Import the practical exam file (.ptcexams) of ${esc(r.code)}: dates, batches and register numbers">${ICON.up} Import</button><button type="button" class="btn ghost sm" data-prpdf="${esc(r.key)}" title="Key list of this sitting as PDF">${ICON.down} PDF</button></td>
            <td class="chev" aria-hidden="true">›</td>
          </tr>${isOpen ? `<tr class="drill"><td colspan="11">${imported.map(([k, x]) => verifyHtml(k, x, verify(x, clashes))).join('')}${students(r)}${r.old.size || r.dups.length || BASIC[r.course] ? strength(r) + repeats(r) : ''}</td></tr>` : ''}`;
        }).join('')}</tbody>
      </table></div>
    </section>`).join('') || (ready && tickets.length ? '<p class="empty card">No practical subjects for these filters.</p>' : '');
}
// Subject-wise strength: one line per hall-ticket code (own code and each old code), regular / supplementary, semesters.
function strength(r) {
  // every hall-ticket entry by code (repeats included), then the repeats taken off: 104 − 1 = 103
  const by = new Map();
  for (const { t, s } of [...r.students, ...r.dups]) {
    const e = by.get(s.code) || by.set(s.code, { code: s.code, name: s.name, regl: new Set(), sems: new Set(), R: 0, S: 0, n: 0 }).get(s.code);
    e.regl.add(s.regulation); e.sems.add(s.sem); e[s.type] = (e[s.type] || 0) + 1; e.n++;
  }
  const list = [...by.values()].sort((a, b) => (a.code === r.code ? -1 : b.code === r.code ? 1 : a.code.localeCompare(b.code, undefined, { numeric: true })));
  const rep = { R: r.dups.filter((d) => d.s.type === 'R').length, S: r.dups.filter((d) => d.s.type === 'S').length };
  return `<table class="data inner strength"><thead><tr><th>Hall-ticket code</th><th>Subject on the hall ticket</th><th>Scheme</th><th class="num">Sem</th><th class="num">R</th><th class="num">S</th><th class="num">Candidates</th></tr></thead><tbody>${list
    .map((e) => `<tr><td><b>${esc(e.code)}</b> ${e.code === r.code ? '<span class="badge ok">own code</span>' : '<span class="badge cross">equivalent</span>'}</td><td class="wrap">${esc(e.name)}</td><td>${esc([...e.regl].join(', '))}</td><td class="num">${[...e.sems].sort().join(', ')}</td><td class="num">${e.R || 0}</td><td class="num">${e.S || 0}</td><td class="num total">${e.n}</td></tr>`).join('')}
    ${r.dups.length ? `<tr class="day-total"><td colspan="4">Hall-ticket entries</td><td class="num">${(r.R || 0) + rep.R}</td><td class="num">${(r.S || 0) + rep.S}</td><td class="num total">${r.total + r.dups.length}</td></tr>
    ${r.dups.map((d) => `<tr class="repeat"><td><b>${esc(d.s.code)}</b> <span class="badge warn">repeated</span></td><td class="wrap" colspan="3">${esc(d.t.regNo)} ${esc(d.t.name)} — already counted under ${esc(d.kept || '')}, not again</td><td class="num">${d.s.type === 'R' ? '−1' : ''}</td><td class="num">${d.s.type === 'S' ? '−1' : ''}</td><td class="num total">−1</td></tr>`).join('')}` : ''}
    <tr class="day-total"><td colspan="4">Strength of ${esc(r.code)}</td><td class="num">${r.R || 0}</td><td class="num">${r.S || 0}</td><td class="num total">${r.total}</td></tr></tbody></table>${BASIC[r.course] ? depts(r) : ''}`;
}
// Students who reach this subject through two hall-ticket codes: counted once, listed so you can see who they are.
function repeats(r) {
  if (!r.dups.length) return '';
  return `<p class="drill-hint"><b>${r.dups.length} student(s) repeated through equivalents</b> — two of their hall-ticket subjects become ${esc(r.code)}; each sits it once, so is counted once.</p>
    <table class="data inner strength"><thead><tr><th>Reg No</th><th>Student Name</th><th>Course</th><th>Counted under</th><th>Also on the hall ticket (not counted again)</th></tr></thead><tbody>${r.dups
    .map((d) => `<tr><td>${esc(d.t.regNo)}</td><td>${esc(d.t.name)}</td><td>${esc(d.t.courseNo)}</td><td><b>${esc(d.kept || '')}</b></td><td>${esc(d.s.code)} ${esc(d.s.name || '')}</td></tr>`).join('')}</tbody></table>`;
}
// Basic Engineering: how many of the candidates come from each department
function depts(r) {
  const name = new Map(r.students.map(({ t }) => [t.courseNo, t.courseName]));
  return `<table class="data inner strength"><thead><tr><th>Department</th><th class="num">Candidates</th></tr></thead><tbody>${[...r.depts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([c, n]) => `<tr><td><b>${esc(c)}</b> ${esc(name.get(c) || '')}</td><td class="num total">${n}</td></tr>`).join('')}
    <tr class="day-total"><td>${r.depts.size} department(s)</td><td class="num total">${r.total}</td></tr></tbody></table>`;
}
const students = (r) => `<table class="data inner"><thead><tr><th class="num">S.No</th><th>Reg No</th><th>Student Name</th>${BASIC[r.course] ? '<th>Course</th>' : ''}<th>Hall-ticket code</th><th class="num">Sem</th><th>Type</th><th>Regl.</th></tr></thead><tbody>${r.students
  .sort((a, b) => a.t.regNo.localeCompare(b.t.regNo, undefined, { numeric: true }))
  .map(({ t, s }, i) => `<tr><td class="num">${i + 1}</td><td>${esc(t.regNo)}</td><td>${esc(t.name)}</td>${BASIC[r.course] ? `<td>${esc(t.courseNo)}</td>` : ''}<td>${esc(s.code)}${s.code !== r.code ? ' <span class="badge cross">old</span>' : ''}</td><td class="num">${s.sem}</td><td><span class="badge ${s.type.toLowerCase()}">${esc(s.type)}</span></td><td>${esc(s.regulation)}</td></tr>`).join('')}</tbody></table>`;

function renderCourses() {
  const sel = $('prCourse');
  const keep = sel.value || pref.get('prCourse') || '';
  const c = new Map();
  for (const t of tickets) c.set(t.courseNo, t.courseName);
  // 1000 / 3000 Basic Engineering, when any department of that kind is loaded
  const basic = [...new Set([...c.keys()].map(commonCourse))].sort().map((b) => [b, `${BASIC[b]} (all departments)`]);
  sel.innerHTML = `<option value="">All courses</option>${[...basic, ...[...c].sort()].map(([no, name]) => `<option value="${esc(no)}">${esc(no)} – ${esc(name)}</option>`).join('')}`;
  sel.value = c.has(keep) || BASIC[keep] && basic.some(([b]) => b === keep) ? keep : '';
}

onTickets((list) => { tickets = list; renderCourses(); render(); });
onEquiv(() => render());
$('prGroup').value = pref.get('prGroup') || 'course';
$('prGroup').addEventListener('change', () => { pref.set('prGroup', $('prGroup').value); render(); });
$('prCourse').addEventListener('change', () => { pref.set('prCourse', $('prCourse').value); render(); });
$('prSearch').addEventListener('input', render);
// Import (a row's button imports for that subject; the file says which subject it is), key list PDF, expand
let importFor = '';
$('prImportBtn').addEventListener('click', () => { importFor = ''; $('prImportFile').click(); });
$('prImportFile').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) await importFiles(files, importFor);
});
$('tab-practicals').addEventListener('click', (e) => {
  const un = e.target.closest('[data-prunimport]')?.dataset.prunimport;
  if (un) { e.preventDefault(); return removeImport(un).then(() => toast(`${un.replace('|', ' · ')}: import removed`)); }
});
$('prList').addEventListener('click', (e) => {
  if (e.target.closest('[data-prunimport]')) return;
  const imp = e.target.closest('[data-primport]')?.dataset.primport;
  if (imp !== undefined) { importFor = imp; return $('prImportFile').click(); }
  const pdf = e.target.closest('[data-prpdf]');
  if (pdf) return keylistPdf(collect().find((r) => r.key === pdf.dataset.prpdf), pdf);
  if (e.target.closest('details')) return;
  const row = e.target.closest('tr.paper');
  // one click: the name list; again: close
  if (row) { open.has(row.dataset.key) ? open.delete(row.dataset.key) : open.add(row.dataset.key); render(); }
});

// Key list of one sitting: the candidates of this subject on this date and slot, in register-number order.
function keylistPdf(r, btn) {
  if (!r) return;
  const [, imp] = importsFor(r)[0] || [];
  withPdf(btn, (jsPDF) => {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const basic = !!BASIC[r.course];
    const y = pdfHeader(doc, 'Practical Examination – Key List', [
      ['Course', basic ? `${r.course} ${BASIC[r.course]}` : `${r.course} ${r.students[0]?.t.courseName || ''}`],
      ['Subject', `${r.code} ${r.name}`],
      ['Date / Session', r.date ? `${fullDate(r.date)} · ${slotLabel(r.time, r.session)}${r.time ? ` (${r.time})` : ''}` : 'Not dated'],
      ['Candidates', `${r.total} (Regular ${r.R || 0} · Supplementary ${r.S || 0})`],
      ...(imp ? [['Examiners', `Internal: ${imp.internal || '-'}   External: ${imp.external || '-'}`]] : []),
    ]);
    const list = [...r.students].sort((a, b) => a.t.regNo.localeCompare(b.t.regNo, undefined, { numeric: true }));
    doc.autoTable({
      ...TABLE_STYLE, startY: y + 2,
      head: [['S.No', 'Reg No', 'Student Name', ...(basic ? ['Course'] : []), 'Hall-ticket code', 'Sem', 'Type', 'Signature']],
      body: list.map(({ t, s }, i) => [i + 1, t.regNo, t.name, ...(basic ? [t.courseNo] : []), s.code, s.sem, s.type, '']),
      styles: { ...TABLE_STYLE.styles, minCellHeight: 7 },
      columnStyles: { 0: { cellWidth: 11, halign: 'right' }, 1: { cellWidth: 24 } },
      didDrawPage: () => pdfFooter(doc),
    });
    doc.save(slug(`Keylist_${r.course}_${r.code}${r.date ? '_' + dmy(r.date) + '_' + slotLabel(r.time, r.session) : ''}`) + '.pdf');
  });
}
document.querySelector('[data-tab="practicals"]')?.addEventListener('click', render);

const line = (r) => [r.course, [...r.sem].join(' '), r.code, r.name, r.date ? dmy(r.date) : '', r.date ? slotLabel(r.time, r.session) : '', r.own, [...r.old].map(([c, n]) => `${c}[${n}]`).join(', '), r.R || 0, r.S || 0, r.total];
$('prCsvBtn').addEventListener('click', () => {
  downloadCsv(slug(`Practicals_${$('prGroup').value === 'day' ? 'Daywise' : 'Coursewise'}`) + '.csv', ['Course', 'Sem', 'Subject Code', 'Subject', 'Date', 'Session', 'Own code', 'Equivalents (old codes)', 'Regular', 'Supplementary', 'Strength'], collect().map(line));
});
$('prPdfBtn').addEventListener('click', (e) =>
  withPdf(e.currentTarget, (jsPDF) => {
    const byDay = $('prGroup').value === 'day';
    const list = collect().sort(byDay ? (a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.course.localeCompare(b.course) : (a, b) => a.course.localeCompare(b.course) || a.code.localeCompare(b.code, undefined, { numeric: true }));
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const y = pdfHeader(doc, 'Practical Examinations', [['Order', byDay ? 'Day-wise' : 'Course-wise'], ['Total', `${list.length} subject sitting(s) · ${list.reduce((n, r) => n + r.total, 0)} candidates`]]);
    const body = [];
    let last = null;
    for (const r of list) {
      const g = byDay ? (r.date ? fullDate(r.date) : 'Not dated') : r.course;
      if (g !== last) { body.push([{ content: g, colSpan: 9, styles: { fillColor: [232, 239, 255], fontStyle: 'bold' } }]); last = g; }
      body.push([byDay ? `${r.course} ${slotLabel(r.time, r.session)}` : r.date ? `${dmy(r.date)} ${slotLabel(r.time, r.session)}` : '-', [...r.sem].join(', '), r.code, r.name, r.own, [...r.old].map(([c, n]) => `${c}[${n}]`).join(', ') || '-', r.R || 0, r.S || 0, { content: String(r.total), styles: { fontStyle: 'bold' } }]);
    }
    doc.autoTable({
      ...TABLE_STYLE, startY: y + 2,
      head: [[byDay ? 'Course' : 'Date', 'Sem', 'Subject code', 'Subject', 'Own code', 'Equivalents (old codes)', 'R', 'S', 'Strength']],
      body,
      columnStyles: { 0: { cellWidth: 26 }, 1: { cellWidth: 12 }, 2: { cellWidth: 26 }, 4: { cellWidth: 18, halign: 'right' }, 6: { cellWidth: 10, halign: 'right' }, 7: { cellWidth: 10, halign: 'right' }, 8: { cellWidth: 18, halign: 'right' } },
      didDrawPage: () => pdfFooter(doc),
    });
    doc.save(slug(`Practicals_${byDay ? 'Daywise' : 'Coursewise'}`) + '.pdf');
  }),
);
