// Warnings at the top of every tab, once an equivalents table with END EXAM is uploaded:
//  • serious — theory subjects (End Exam T) with no exam date: not counted in QP statistics or seating;
//  • old-scheme nominal-roll subject codes the equivalents table doesn't map (their students can't be placed);
//  • current (R2023) codes the table gives no End Exam for (counted as theory when they have a date) — for information.
import { buildQp } from './qpcalc.js';
import { onTickets, nrStudents, openDateEditor } from './halltickets.js';
import { onTimetable } from './qp.js';
import { mapSubject, onEquiv, hasExamTypes, examTypeOf, theoryOnly, inTable } from './equiv.js';
import { kv } from './kv.js';
import { $, esc } from './util.js';

let tickets = [], timetable = null;

function undatedTheory() {
  if (!timetable) return [];
  const qp = buildQp(theoryOnly(tickets), timetable, mapSubject, kv.get('crossCourse', {}), { removed: kv.get('qpRemoved', []) });
  return (qp.noDateList || []).filter((u) => examTypeOf(u.code, u.course) === 'T' || u.own.some((c) => examTypeOf(c, u.course) === 'T'));
}
function missingCodes() {
  const out = new Map(); // course|code → { course, code, sem, regulation, regs }
  for (const st of nrStudents())
    for (const x of st.sems || [])
      for (const code of x.codes) {
        if (inTable(code, st.courseNo)) continue;
        const k = st.courseNo + '|' + code;
        (out.get(k) || out.set(k, { course: st.courseNo, code, sem: x.sem, regulation: x.regulation || '', regs: new Set() }).get(k)).regs.add(st.regNo);
      }
  return [...out.values()].sort((a, b) => a.course.localeCompare(b.course) || a.sem - b.sem || a.code.localeCompare(b.code, undefined, { numeric: true }));
}

function render() {
  const box = $('topWarn');
  if (!hasExamTypes()) { box.hidden = true; return; }
  const noDate = undatedTheory();
  const all = missingCodes();
  const missing = all.filter((m) => !/^R20/i.test(m.regulation));
  const current = all.filter((m) => /^R20/i.test(m.regulation));
  box.hidden = !noDate.length && !missing.length && !current.length;
  const codeTable = (list) => `<div class="table-wrap"><table class="data"><thead><tr><th>Course</th><th class="num">Sem</th><th>Regulation</th><th>Subject code</th><th>Subject (hall ticket)</th><th class="num">Students</th></tr></thead><tbody>${list
    .map((m) => `<tr><td>${esc(m.course)}</td><td class="num">${m.sem}</td><td>${esc(m.regulation)}</td><td><b>${esc(m.code)}</b></td><td class="wrap">${esc(names.get(m.code) || '—')}</td><td class="num">${m.regs.size}</td></tr>`).join('')}</tbody></table></div>`;
  const names = new Map();
  for (const t of tickets) for (const s of t.subjects) if (!names.has(s.code)) names.set(s.code, s.name);
  box.innerHTML = [
    noDate.length && `<details class="warn-item serious">
      <summary><b>⛔ ${noDate.length} theory subject(s) have no exam date</b> — ${noDate.reduce((n, u) => n + u.n, 0)} candidate(s) are not counted in QP Statistics or seating until a date is set.</summary>
      <div class="table-wrap"><table class="data"><thead><tr><th>Course</th><th>Subject code</th><th>Subject</th><th class="num">Sem</th><th>Old codes</th><th class="num">Candidates</th><th></th></tr></thead><tbody>${noDate
        .map((u) => `<tr><td>${esc(u.course)}</td><td><b>${esc(u.code)}</b></td><td class="wrap">${esc(u.name)}</td><td class="num">${u.sems.join(', ')}</td><td>${esc(u.own.filter((c) => c !== u.code).join(', ') || '—')}</td><td class="num">${u.n}</td><td class="row-actions"><button class="btn primary sm" data-warndate="${esc(u.code)}">✎ Set date</button></td></tr>`).join('')}</tbody></table></div>
    </details>`,
    missing.length && `<details class="warn-item">
      <summary><b>⚠ ${missing.length} old-scheme subject code(s) on the nominal rolls are not in the equivalents table</b> — ${new Set(missing.flatMap((m) => [...m.regs])).size} student(s) can't be mapped to a current subject; add them in Equivalent Subjects Mapping or upload a newer table.</summary>
      ${codeTable(missing)}
    </details>`,
    current.length && `<details class="warn-item info">
      <summary><b>ⓘ ${current.length} current (R2023) subject code(s) have no End Exam in the table</b> — counted as theory when the time table / hall ticket gives a date (often skills, training and practical subjects that DOTE's list leaves out).</summary>
      ${codeTable(current)}
    </details>`,
  ].filter(Boolean).join('');
}

onTickets((list) => { tickets = list; render(); });
onTimetable((tt) => { timetable = tt; render(); });
onEquiv(() => render());
$('topWarn').addEventListener('click', (e) => { const c = e.target.closest('[data-warndate]')?.dataset.warndate; if (c) openDateEditor(c); });
