// Practicals tab: hall-ticket subjects whose End Exam is Practical / Practicum (from the uploaded equivalents table),
// course-wise or day-wise (dates you set with ✎), with each subject's strength: own-code candidates plus old-scheme
// candidates mapped onto it (equivalents). Theory subjects stay in QP Statistics.
import { onTickets, openDateEditor, dmy, fullDate, weekday, withPdf, pdfHeader, TABLE_STYLE, joinSet } from './halltickets.js';
import { mapSubject, onEquiv, subjectExam, hasExamTypes, equivalentsOf } from './equiv.js';
import { $, esc, pref, downloadCsv, slug, pdfFooter } from './util.js';

let tickets = [];
const open = new Set();

// one row per course + practical subject + sitting
function collect() {
  const course = $('prCourse').value;
  const q = $('prSearch').value.trim().toLowerCase();
  const rows = new Map();
  for (const t of tickets) {
    if (course && t.courseNo !== course) continue;
    for (const s of t.subjects) {
      if (subjectExam(s.code, t.courseNo) !== 'P') continue;
      const m = mapSubject(s.code, t.courseNo);
      const code = m ? m.code : s.code;
      const k = [t.courseNo, code, s.date || '', s.session || ''].join('|');
      const r = rows.get(k) || rows.set(k, { key: k, course: t.courseNo, code, name: '', oldName: '', sem: new Set(), date: s.date || '', session: s.session || '', time: s.time || '', setDate: !!s.setDate, regs: new Set(), R: 0, S: 0, own: 0, old: new Map(), students: [] }).get(k);
      if (r.regs.has(t.regNo)) continue;
      r.regs.add(t.regNo);
      r[s.type] = (r[s.type] || 0) + 1;
      r.sem.add(s.sem);
      if (s.code === code) { r.own++; r.name ||= s.name; } else { r.old.set(s.code, (r.old.get(s.code) || 0) + 1); r.oldName ||= s.name; }
      r.students.push({ t, s });
    }
  }
  const list = [...rows.values()].map((r) => ({ ...r, name: r.name || r.oldName, total: r.regs.size }));
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
  for (const id of ['prCsvBtn', 'prPdfBtn']) $(id).disabled = !list.length;
  const total = list.reduce((n, r) => n + r.total, 0);
  const dated = list.filter((r) => r.date);
  $('prKpis').innerHTML = !ready ? '' : [
    { v: new Set(list.map((r) => r.course + '|' + r.code)).size, l: 'Practical subjects', sub: `${new Set(list.map((r) => r.course)).size} course(s)` },
    { v: total, l: 'Candidates', sub: `Regular ${list.reduce((n, r) => n + (r.R || 0), 0)} · Supplementary ${list.reduce((n, r) => n + (r.S || 0), 0)}` },
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
      <header class="day-head"><div class="day-date"><b>${esc(byDay ? (k ? fullDate(k) : 'Not dated') : `${k} – ${rows[0].students[0]?.t.courseName || ''}`)}</b><span class="muted">${rows.length} subject(s)</span></div>
        <div class="day-stats"><span class="pill">Candidates <b>${rows.reduce((n, r) => n + r.total, 0)}</b></span></div></header>
      <div class="table-wrap"><table class="data papers">
        <thead><tr>${byDay ? '<th>Course</th>' : '<th>Date</th>'}<th class="num">Sem</th><th>Subject code</th><th>Subject</th><th class="num">Own code</th><th>Equivalents (old codes)</th><th class="num">R</th><th class="num">S</th><th class="num">Strength</th><th></th></tr></thead>
        <tbody>${rows.map((r) => {
          const eqs = equivalentsOf(r.code, r.course).map((e) => ({ ...e, n: r.old.get(e.code) || 0 }));
          for (const [c, n] of r.old) if (!eqs.some((e) => e.code === c)) eqs.push({ code: c, scheme: '', n });
          const isOpen = open.has(r.key);
          return `<tr class="paper${isOpen ? ' open' : ''}" data-key="${esc(r.key)}" tabindex="0">
            <td>${byDay ? esc(r.course) : r.date ? `${weekday(r.date)} ${dmy(r.date)} <span class="badge ${r.session.toLowerCase()}">${esc(r.session)}</span>` : '<span class="muted">not dated</span>'}</td>
            <td class="num">${[...r.sem].sort().join(', ')}</td>
            <td><b>${esc(r.code)}</b>${r.setDate ? ' <span class="badge manual">Set date</span>' : ''}</td>
            <td class="wrap">${esc(r.name)}</td>
            <td class="num">${r.own}</td>
            <td class="wrap">${eqs.length ? eqs.map((e) => `<span class="${e.n ? '' : 'muted'}">${esc(e.code)}${e.scheme ? ` (${esc(e.scheme.replace('-Scheme', ''))})` : ''} ×<b>${e.n}</b></span>`).join(', ') : '<span class="muted">—</span>'}</td>
            <td class="num">${r.R || 0}</td><td class="num">${r.S || 0}</td><td class="num total">${r.total}</td>
            <td class="chev"><button type="button" class="icon-btn" data-prdate="${esc(r.code)}" title="Set the practical exam date for ${esc(r.code)}">✎</button> <span aria-hidden="true">›</span></td>
          </tr>${isOpen ? `<tr class="drill"><td colspan="10">${students(r)}</td></tr>` : ''}`;
        }).join('')}</tbody>
      </table></div>
    </section>`).join('') || (ready && tickets.length ? '<p class="empty card">No practical subjects for these filters.</p>' : '');
}
const students = (r) => `<table class="data inner"><thead><tr><th class="num">S.No</th><th>Reg No</th><th>Student Name</th><th>Hall-ticket code</th><th class="num">Sem</th><th>Type</th><th>Regl.</th></tr></thead><tbody>${r.students
  .sort((a, b) => a.t.regNo.localeCompare(b.t.regNo, undefined, { numeric: true }))
  .map(({ t, s }, i) => `<tr><td class="num">${i + 1}</td><td>${esc(t.regNo)}</td><td>${esc(t.name)}</td><td>${esc(s.code)}${s.code !== r.code ? ' <span class="badge cross">old</span>' : ''}</td><td class="num">${s.sem}</td><td><span class="badge ${s.type.toLowerCase()}">${esc(s.type)}</span></td><td>${esc(s.regulation)}</td></tr>`).join('')}</tbody></table>`;

function renderCourses() {
  const sel = $('prCourse');
  const keep = sel.value || pref.get('prCourse') || '';
  const c = new Map();
  for (const t of tickets) c.set(t.courseNo, t.courseName);
  sel.innerHTML = `<option value="">All courses</option>${[...c].sort().map(([no, name]) => `<option value="${esc(no)}">${esc(no)} – ${esc(name)}</option>`).join('')}`;
  sel.value = c.has(keep) ? keep : '';
}

onTickets((list) => { tickets = list; renderCourses(); render(); });
onEquiv(() => render());
$('prGroup').value = pref.get('prGroup') || 'course';
$('prGroup').addEventListener('change', () => { pref.set('prGroup', $('prGroup').value); render(); });
$('prCourse').addEventListener('change', () => { pref.set('prCourse', $('prCourse').value); render(); });
$('prSearch').addEventListener('input', render);
$('prList').addEventListener('click', (e) => {
  const d = e.target.closest('[data-prdate]')?.dataset.prdate;
  if (d) return openDateEditor(d);
  const row = e.target.closest('tr.paper');
  if (row) { open.has(row.dataset.key) ? open.delete(row.dataset.key) : open.add(row.dataset.key); render(); }
});
document.querySelector('[data-tab="practicals"]')?.addEventListener('click', render);

const line = (r) => [r.course, [...r.sem].join(' '), r.code, r.name, r.date ? dmy(r.date) : '', r.session, r.own, [...r.old].map(([c, n]) => `${c} x${n}`).join(', '), r.R || 0, r.S || 0, r.total];
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
      body.push([byDay ? r.course : r.date ? `${dmy(r.date)} ${r.session}` : '-', [...r.sem].join(', '), r.code, r.name, r.own, [...r.old].map(([c, n]) => `${c} ×${n}`).join(', ') || '-', r.R || 0, r.S || 0, { content: String(r.total), styles: { fontStyle: 'bold' } }]);
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
