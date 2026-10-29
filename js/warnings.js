// Warnings at the top of every tab, once an equivalents table with END EXAM is uploaded:
//  • serious — theory subjects (End Exam T) with no exam date: not counted in QP statistics or seating;
//  • old-scheme nominal-roll subject codes the equivalents table doesn't map (their students can't be placed);
//  • current (R2023) codes the table gives no End Exam for (counted as theory when they have a date) — for information.
import { buildQp } from './qpcalc.js';
import { onTickets, nrStudents, openDateEditor } from './halltickets.js';
import { onTimetable } from './qp.js';
import { mapSubject, onEquiv, hasExamTypes, examTypeOf, theoryOnly, inTable, examSetBy, addSelfRows, removeSelfRows, addedSelfRows } from './equiv.js';
import { kv } from './kv.js';
import { $, esc, toast } from './util.js';

let tickets = [], timetable = null;
let shown = { current: [], names: new Map() }; // the "no End Exam" list on screen, for its buttons
const EXAM = { T: 'Theory', P: 'Practical' };

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
        if (inTable(code, st.courseNo, true)) continue; // codes you set Theory / Practical for stay listed (to change)
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
  const setN = new Set(current.filter((m) => examSetBy(m.code)).map((m) => m.code)).size;
  const added = addedSelfRows();
  box.hidden = !noDate.length && !missing.length && !current.length && !added.length;
  // exam: Theory / Practical buttons (current codes with no End Exam in the table): after you confirm, the code is added
  // to the equivalents table as its own equivalent with that End Exam, in every course listed here
  const typeButtons = (code) => {
    const v = examSetBy(code); // an earlier choice not yet in the table
    return `<div class="seg" role="group" aria-label="End Exam of ${esc(code)}">${Object.entries(EXAM)
      .map(([t, l]) => `<button type="button" class="btn sm ${v === t ? 'primary' : 'ghost'}" data-examset="${esc(code)}" data-type="${t}" title="Add ${esc(code)} to the equivalents table as ${l.toLowerCase()} (its own equivalent)">${l}</button>`).join('')}</div>`;
  };
  const codeTable = (list, exam = false) => `<div class="table-wrap"><table class="data"><thead><tr><th>Course</th><th class="num">Sem</th><th>Regulation</th><th>Subject code</th><th>Subject (hall ticket)</th><th class="num">Students</th>${exam ? '<th>End Exam</th>' : ''}</tr></thead><tbody>${list
    .map((m) => `<tr${exam && examSetBy(m.code) ? ' class="exam-set"' : ''}><td>${esc(m.course)}</td><td class="num">${m.sem}</td><td>${esc(m.regulation)}</td><td><b>${esc(m.code)}</b></td><td class="wrap">${esc(names.get(m.code) || '—')}</td><td class="num">${m.regs.size}</td>${exam ? `<td class="row-actions">${typeButtons(m.code)}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
  const names = new Map();
  for (const t of tickets) for (const s of t.subjects) if (!names.has(s.code)) names.set(s.code, s.name);
  shown = { current, names };
  // redrawing keeps each list open and scrolled where it was (setting Theory / Practical redraws)
  const was = new Map([...box.querySelectorAll('details[data-k]')].map((d) => [d.dataset.k, { open: d.open, top: d.querySelector('.table-wrap')?.scrollTop || 0 }]));
  box.innerHTML = [
    noDate.length && `<details class="warn-item serious" data-k="nodate">
      <summary><b>⛔ ${noDate.length} theory subject(s) have no exam date</b> — ${noDate.reduce((n, u) => n + u.n, 0)} candidate(s) are not counted in QP Statistics or seating until a date is set.</summary>
      <div class="table-wrap"><table class="data"><thead><tr><th>Course</th><th>Subject code</th><th>Subject</th><th class="num">Sem</th><th>Old codes</th><th class="num">Candidates</th><th></th></tr></thead><tbody>${noDate
        .map((u) => `<tr><td>${esc(u.course)}</td><td><b>${esc(u.code)}</b></td><td class="wrap">${esc(u.name)}</td><td class="num">${u.sems.join(', ')}</td><td>${esc(u.own.filter((c) => c !== u.code).join(', ') || '—')}</td><td class="num">${u.n}</td><td class="row-actions"><button class="btn primary sm" data-warndate="${esc(u.code)}">✎ Set date</button></td></tr>`).join('')}</tbody></table></div>
    </details>`,
    missing.length && `<details class="warn-item" data-k="missing">
      <summary><b>⚠ ${missing.length} old-scheme subject code(s) on the nominal rolls are not in the equivalents table</b> — ${new Set(missing.flatMap((m) => [...m.regs])).size} student(s) can't be mapped to a current subject; add them in Equivalent Subjects Mapping or upload a newer table.</summary>
      ${codeTable(missing)}
    </details>`,
    current.length && `<details class="warn-item info" data-k="current">
      <summary><b>ⓘ ${current.length} current (R2023) subject code(s) have no End Exam in the table</b> — counted as theory when the time table / hall ticket gives a date (often skills, training and practical subjects that DOTE's list leaves out). Click Theory or Practical to add the subject to the equivalents table (its own equivalent), so it shows in QP Statistics or Practicals.</summary>
      ${setN ? `<p class="warn-bar">${setN} earlier choice(s) are highlighted but not in the table yet. <button type="button" class="btn primary sm" data-examaddall>Add the ${setN} to the equivalents table</button></p>` : ''}
      ${codeTable(current, true)}
    </details>`,
    added.length && `<details class="warn-item info" data-k="added">
      <summary><b>ⓘ ${added.length} subject(s) you added to the equivalents table</b> (own code, End Exam Theory / Practical) — Remove takes one out again.</summary>
      <div class="table-wrap"><table class="data"><thead><tr><th>Course</th><th class="num">Sem</th><th>Subject code</th><th>Subject</th><th>End Exam</th><th></th></tr></thead><tbody>${added
        .map((a) => `<tr><td>${esc(a.course)}</td><td class="num">${esc(a.sem)}</td><td><b>${esc(a.code)}</b></td><td class="wrap">${esc(a.name || names.get(a.code) || '')}</td><td><span class="badge ${a.exam === 'P' ? 'ok' : ''}">${EXAM[a.exam] || esc(a.exam)}</span></td>
          <td class="row-actions"><button type="button" class="btn ghost sm" data-examremove="${esc(a.course + '|' + a.code)}">Remove</button></td></tr>`).join('')}</tbody></table></div>
    </details>`,
  ].filter(Boolean).join('');
  for (const d of box.querySelectorAll('details[data-k]')) {
    const w = was.get(d.dataset.k);
    if (!w) continue;
    d.open = w.open;
    const wrap = d.querySelector('.table-wrap');
    if (wrap) wrap.scrollTop = w.top;
  }
}

onTickets((list) => { tickets = list; render(); });
onTimetable((tt) => { timetable = tt; render(); });
onEquiv(() => render());
$('topWarn').addEventListener('click', (e) => {
  const c = e.target.closest('[data-warndate]')?.dataset.warndate;
  if (c) return openDateEditor(c);
  // one code in every listed course, or every earlier choice; each after you confirm
  const rowsOf = (code, exam) => shown.current.filter((m) => m.code === code).map((m) => ({ course: m.course, code, name: shown.names.get(code) || '', sem: m.sem, exam }));
  const add = (list) => {
    if (!list.length) return;
    const lines = list.map((x) => `${x.course} · ${x.code} ${x.name} → ${EXAM[x.exam]}`);
    if (!confirm(`Add ${list.length} row(s) to the equivalents table as their own equivalent (R2023 → itself)?\n\n${lines.slice(0, 20).join('\n')}${lines.length > 20 ? `\n… and ${lines.length - 20} more` : ''}\n\nTheory subjects then count in QP Statistics and seating, practical ones in Practicals.`)) return;
    addSelfRows(list).then(() => toast(`${list.length} row(s) added to the equivalents table`), (err) => toast(err.message));
  };
  const b = e.target.closest('[data-examset]');
  if (b) return add(rowsOf(b.dataset.examset, b.dataset.type));
  if (e.target.closest('[data-examaddall]')) return add([...new Set(shown.current.map((m) => m.code))].filter(examSetBy).flatMap((c) => rowsOf(c, examSetBy(c))));
  const rm = e.target.closest('[data-examremove]')?.dataset.examremove;
  if (rm && confirm(`Remove ${rm.replace('|', ' · ')} from the equivalents table? It goes back to the list of codes with no End Exam.`))
    removeSelfRows([rm]).then(() => toast(`${rm.replace('|', ' · ')} removed from the equivalents table`), (err) => toast(err.message));
});
