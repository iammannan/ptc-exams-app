// QP Statistics tab: question papers needed per day / session.
import { buildQp, ttDifferences, TT_DIFF } from './qpcalc.js';
import { parseTimetable, packTimetable } from './ttparser.js';
import { onTickets, pdfHeader, withPdf, TABLE_STYLE, joinSet, dmy, fullDate, weekday, shortDate, openDateEditor } from './halltickets.js';
import { mapSubject, onEquiv } from './equiv.js';
import { $, esc, loadPdfjs, toast, pref, slug, downloadCsv, pdfFooter } from './util.js';
import { kv, kvReady } from './kv.js';

await kvReady;

const SESSION_LABEL = { FN: 'Forenoon', AN: 'Afternoon' };
// kv "timetable": a revised time table loaded by the user (packed JSON)

let builtinTt = null, timetable = null;
let tickets = [];
let qp = null;
const open = new Set();
// Exam days before today (India time) start folded; a day you open or close stays that way.
const dayOpen = new Map(); // date → open?
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const ttListeners = [];

// Other views (seating) place papers on dates and sessions with the time table in use.
export function onTimetable(fn) {
  ttListeners.push(fn);
  if (timetable) fn(timetable);
}

/* ---------- data ---------- */
function savedTimetable() {
  return kv.get('timetable', null);
}

async function loadData() {
  builtinTt = (await import('./data/timetable.js')).default;
  timetable = savedTimetable() || builtinTt;
  renderSource();
  render();
}

function renderSource() {
  const custom = timetable !== builtinTt;
  $('qpTtName').textContent = `${timetable.meta.title || 'Time table'} · ${timetable.meta.version || ''}`;
  $('qpTtNote').textContent = `${custom ? 'Loaded by you' : 'Built in'} · ${timetable.meta.file || ''} · ${timetable.rows.length} subject entries`;
  $('qpTtReset').hidden = !custom;
  for (const fn of ttListeners) fn(timetable); // called whenever the time table changes
}

$('qpTtInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    toast('Reading time table…');
    const packed = packTimetable(await parseTimetable(await loadPdfjs(), new Uint8Array(await f.arrayBuffer())), f.name);
    if (packed.rows.length < 10) throw new Error('No time table rows found in this PDF');
    kv.set('timetable', packed);
    timetable = packed;
    renderSource();
    render();
    toast(`Time table loaded: ${packed.rows.length} entries`);
  } catch (err) {
    console.error(err);
    toast(err.message || 'Could not read that time table');
  }
});
$('qpTtReset').addEventListener('click', () => {
  kv.remove('timetable');
  timetable = builtinTt;
  renderSource();
  render();
});

onTickets((list) => {
  tickets = list;
  renderCourses();
  render();
});

function renderCourses() {
  const counts = new Map();
  for (const t of tickets) counts.set(t.courseNo, { name: t.courseName, n: (counts.get(t.courseNo)?.n || 0) + 1 });
  const sel = $('qpCourse');
  const keep = sel.value || pref.get('qpCourse');
  const opts = [['', `All courses (${tickets.length})`], ...[...counts].map(([no, c]) => [no, `${no} – ${c.name} (${c.n})`])];
  sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  sel.value = opts.some(([v]) => v === keep) ? keep : '';
}

/* ---------- render ---------- */
const sum = (list, k) => list.reduce((n, p) => n + (p[k] || 0), 0);
const visibleSessions = () => ($('qpSession').value ? [$('qpSession').value] : ['FN', 'AN']);

function render() {
  if (!timetable) return;
  const course = $('qpCourse').value;
  pref.set('qpCourse', course);
  qp = buildQp(course ? tickets.filter((t) => t.courseNo === course) : tickets, timetable, mapSubject);
  const sessions = visibleSessions();
  const days = qp.days.filter((d) => sessions.some((s) => d[s].length));
  const papers = days.flatMap((d) => sessions.flatMap((s) => d[s]));

  $('qpEmpty').hidden = days.length > 0;
  $('qpEmpty').textContent = tickets.length ? 'No question papers for these filters.' : 'No hall tickets yet. Upload hall ticket PDFs in the Hall Tickets tab.';
  for (const id of ['qpCsvBtn', 'qpPdfBtn']) $(id).disabled = !papers.length;

  renderKpis(days, papers, sessions);
  renderDays(days, sessions);
  renderDiffs();
}

/* ---------- time table vs hall ticket ---------- */
const slotText = (date, session, time) => (date ? `${dmy(date)} ${session}${time ? ` (${time})` : ''}` : '—');

function diffRows() {
  const course = $('ttDiffCourse').value;
  const kind = $('ttDiffKind').value;
  return ttDifferences(tickets, timetable).filter((r) => (!course || r.t.courseNo === course) && (!kind || r.kind === kind));
}

function renderDiffs() {
  const all = ttDifferences(tickets, timetable);
  $('ttDiffCard').hidden = !all.length;
  if (!all.length) return;
  const fill = (sel, opts) => {
    const keep = sel.value;
    sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    sel.value = opts.some(([v]) => v === keep) ? keep : '';
  };
  const count = (f) => { const m = new Map(); for (const r of all) m.set(f(r), (m.get(f(r)) || 0) + 1); return m; };
  const byCourse = count((r) => r.t.courseNo), byKind = count((r) => r.kind);
  fill($('ttDiffCourse'), [['', `All courses (${all.length})`], ...[...byCourse].sort().map(([c, n]) => [c, `${c} (${n})`])]);
  fill($('ttDiffKind'), [['', 'All differences'], ...Object.entries(TT_DIFF).filter(([k]) => byKind.has(k)).map(([k, l]) => [k, `${l} (${byKind.get(k)})`])]);
  $('ttDiffStats').innerHTML = Object.entries(TT_DIFF).map(([k, l]) => `<span class="pill">${esc(l)}: <b>${byKind.get(k) || 0}</b></span>`).join('');
  $('ttDiffBody').innerHTML = diffRows()
    .map((r) => `<tr>
      <td>${esc(r.t.regNo)}</td>
      <td class="wrap">${esc(r.t.name)}</td>
      <td>${esc(r.t.courseNo)}</td>
      <td><span class="badge warn">${esc(TT_DIFF[r.kind])}</span></td>
      <td class="wrap subj"><b>${esc(r.s.code)}</b> ${esc(r.s.name)} <span class="muted">(Sem ${r.s.sem} ${esc(r.s.type)}, ${esc(r.s.regulation)})</span></td>
      <td title="${esc(r.s.time)}">${esc(slotText(r.s.date, r.s.session))}</td>
      <td title="${esc(r.slot?.time || '')}">${esc(r.slot ? slotText(r.slot.date, r.slot.session) : 'Not listed')}</td>
    </tr>`)
    .join('');
}

$('ttDiffCourse').addEventListener('change', renderDiffs);
$('ttDiffKind').addEventListener('change', renderDiffs);

function diffExport() {
  const course = $('ttDiffCourse').value;
  const kind = $('ttDiffKind').value;
  return { course, kind, rows: diffRows(), name: slug(['Timetable_vs_HallTicket', course || 'AllCourses', kind].filter(Boolean).join('_')) };
}

$('ttDiffCsvBtn').addEventListener('click', () => {
  const { rows, name } = diffExport();
  downloadCsv(name + '.csv', ['Reg No', 'Student Name', 'Course', 'Difference', 'Subject Code', 'Subject Name', 'Sem', 'Type', 'Regulation', 'Hall Ticket Date', 'Time Table Date'],
    rows.map((r) => [r.t.regNo, r.t.name, r.t.courseNo, TT_DIFF[r.kind], r.s.code, r.s.name, r.s.sem, r.s.type, r.s.regulation, slotText(r.s.date, r.s.session, r.s.time), r.slot ? slotText(r.slot.date, r.slot.session, r.slot.time) : 'Not listed']));
});

$('ttDiffPdfBtn').addEventListener('click', (e) =>
  withPdf(e.currentTarget, (jsPDF) => {
    const { course, kind, rows, name } = diffExport();
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const kinds = new Map();
    for (const r of rows) kinds.set(r.kind, (kinds.get(r.kind) || 0) + 1);
    const y = pdfHeader(doc, 'Time Table vs Hall Ticket Differences', [
      ['Course', course ? $('ttDiffCourse').selectedOptions[0].textContent.replace(/\s*\(\d+\)$/, '') : 'All courses'],
      ['Time Table', timetable.meta.version || ''],
      ['Students', String(new Set(rows.map((r) => r.t.regNo)).size)],
      ['Differences', kind ? `${TT_DIFF[kind]}: ${rows.length}` : [...kinds].map(([k, n]) => `${TT_DIFF[k]}: ${n}`).join('   ·   ')],
    ]);
    doc.autoTable({
      ...TABLE_STYLE,
      startY: y,
      head: [['S.No', 'Reg No', 'Student Name', 'Course', 'Difference', 'Subject', 'Hall Ticket', 'Time Table']],
      body: rows.map((r, i) => [i + 1, r.t.regNo, r.t.name, r.t.courseNo, TT_DIFF[r.kind], `${r.s.code} ${r.s.name} (Sem ${r.s.sem} ${r.s.type}, ${r.s.regulation})`, slotText(r.s.date, r.s.session), r.slot ? slotText(r.slot.date, r.slot.session) : 'Not listed']),
      columnStyles: { 0: { cellWidth: 12, halign: 'right' }, 1: { cellWidth: 22 }, 2: { cellWidth: 40 }, 3: { cellWidth: 15 }, 4: { cellWidth: 42, fontStyle: 'bold', textColor: [180, 83, 9] }, 6: { cellWidth: 26 }, 7: { cellWidth: 26 } },
      didDrawPage: () => pdfFooter(doc),
    });
    doc.save(name + '.pdf');
  }),
);

function renderKpis(days, papers, sessions) {
  if (!tickets.length) return ($('qpKpis').innerHTML = '');
  let peak = null;
  for (const d of days) for (const s of sessions) { const n = sum(d[s], 'total'); if (n && (!peak || n > peak.n)) peak = { d, s, n }; }
  const tiles = [
    { v: sum(papers, 'total'), l: 'Question papers needed', sub: `${papers.length} papers · ${days.length} exam days` },
    { v: sessions.includes('FN') ? sum(days.flatMap((d) => d.FN), 'total') : '—', l: 'Forenoon (FN) QPs', sub: `${days.filter((d) => d.FN.length).length} FN sessions` },
    { v: sessions.includes('AN') ? sum(days.flatMap((d) => d.AN), 'total') : '—', l: 'Afternoon (AN) QPs', sub: `${days.filter((d) => d.AN.length).length} AN sessions` },
    { v: `${sum(papers, 'R')} / ${sum(papers, 'S')}`, l: 'Regular / Supplementary', sub: 'question papers' },
    { v: peak ? peak.n : '—', l: 'Busiest session', sub: peak ? `${weekday(peak.d.date)} ${shortDate(peak.d.date)} · ${peak.s}` : '' },
    { v: qp.undated, l: 'No exam date', sub: 'subject entries (practicals etc.) — no QP' },
  ];
  $('qpKpis').innerHTML = tiles.map((t) => `<div class="kpi"><span class="l">${t.l}</span><b>${t.v}</b><span class="sub">${esc(t.sub)}</span></div>`).join('');
}

// "R2023: 40 · M-Scheme (4010310): 5 · Total 45"
function schemeText(p) {
  return [...p.schemes].map(([k, n]) => `<span>${esc(k)}: <b>${n}</b></span>`).join(' · ') + ` · <span>Total: <b>${p.total}</b></span>`;
}
const schemePlain = (p) => (p.merged ? [...p.schemes].map(([k, n]) => `${k}: ${n}`).join(', ') : '');

function candidates(p) {
  return `<table class="data inner">
    <thead><tr><th class="num">S.No</th><th>Reg No</th><th>Student Name</th><th>Course</th><th class="num">Sem</th><th>Type</th><th>Regl.</th></tr></thead>
    <tbody>${p.students
      .map(({ t, s }, i) => `<tr><td class="num">${i + 1}</td><td>${esc(t.regNo)}</td><td>${esc(t.name)}</td><td>${esc(t.courseNo)}</td><td class="num">${s.sem}</td><td><span class="badge ${s.type.toLowerCase()}">${esc(s.type)}</span></td><td>${esc(s.regulation)}</td></tr>`)
      .join('')}</tbody></table>`;
}

function renderDays(days, sessions) {
  const today = todayIso();
  const past = days.filter((d) => d.date < today).length;
  $('qpDays').innerHTML = (past ? `<p class="muted qp-fold-note">${past} past exam day(s) folded — click a day to open it.</p>` : '') + days
    .map((d, i) => {
      const dayPapers = sessions.flatMap((s) => d[s]);
      const isPast = d.date < today;
      const isOpen = dayOpen.get(d.date) ?? !isPast;
      return `<details class="card flush day${isPast ? ' past' : ''}" data-day="${d.date}"${isOpen ? ' open' : ''}>
        <summary class="day-head">
          <div class="day-date"><span class="dow">${weekday(d.date)}</span><b>${dmy(d.date)}</b><span class="muted">Day ${i + 1}</span>${isPast ? ' <span class="badge">Done</span>' : ''}</div>
          <div class="day-stats">${sessions.filter((s) => d[s].length).map((s) => `<span class="pill ${s.toLowerCase()}"><i class="sw ${s.toLowerCase()}"></i>${s} <b>${sum(d[s], 'total')}</b> QPs · ${d[s].length} paper(s)</span>`).join('')}</div>
        </summary>
        <div class="table-wrap">
          <table class="data papers">
            <thead><tr><th>Session</th><th>QP Code</th><th>Subject</th><th>Course</th><th>Regl.</th><th class="num">R</th><th class="num">S</th><th class="num">QPs</th><th></th></tr></thead>
            <tbody>
              ${sessions
                .filter((s) => d[s].length)
                .map((s) => `${d[s]
                  .map((p) => {
                    const isOpen = open.has(p.key);
                    return `<tr class="paper${isOpen ? ' open' : ''}" data-key="${esc(p.key)}" tabindex="0" aria-expanded="${isOpen}">
                      <td><span class="badge ${s.toLowerCase()}">${s}</span> <span class="muted">${esc(p.time)}</span></td>
                      <td><b>${esc(p.code)}</b>${p.setDate ? ' <span class="badge manual" title="Exam date set by you">Set date</span>' : p.fromTicket ? ' <span class="badge" title="Not in the time table — date taken from the hall ticket">HT date</span>' : ''}${p.merged ? ` <span class="badge cross" title="Includes old / legacy subjects: ${esc([...p.legacyCodes].join(', '))}">Merged</span>` : ''}</td>
                      <td class="wrap">${esc(p.name)}${p.merged ? `<div class="breakdown">${schemeText(p)}</div>` : ''}</td>
                      <td>${esc(joinSet(p.courses))}</td>
                      <td>${esc(joinSet(p.regs))}</td>
                      <td class="num">${p.R || 0}</td>
                      <td class="num">${p.S || 0}</td>
                      <td class="num total">${p.total}</td>
                      <td class="chev"><button type="button" class="icon-btn" data-date="${esc(p.code)}" title="Edit exam date for ${esc(p.code)}">✎</button> <span aria-hidden="true">›</span></td>
                    </tr>
                    ${isOpen ? `<tr class="drill"><td colspan="9">${candidates(p)}</td></tr>` : ''}`;
                  })
                  .join('')}
                  <tr class="session-total ${s.toLowerCase()}"><td colspan="7">${SESSION_LABEL[s]} (${s}) QPs</td><td class="num total">${sum(d[s], 'total')}</td><td></td></tr>`)
                .join('')}
              <tr class="day-total"><td colspan="7">Day total</td><td class="num total">${sum(dayPapers, 'total')}</td><td></td></tr>
            </tbody>
          </table>
        </div>
      </details>`;
    })
    .join('');
}

const toggle = (k) => { open.has(k) ? open.delete(k) : open.add(k); render(); };
$('qpDays').addEventListener('click', (e) => {
  const dc = e.target.closest('[data-date]')?.dataset.date;
  if (dc) return openDateEditor(dc);
  const row = e.target.closest('tr.paper');
  if (row) toggle(row.dataset.key);
});
$('qpDays').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr.paper')) {
    e.preventDefault();
    const k = e.target.dataset.key;
    toggle(k);
    document.querySelector(`#qpDays tr.paper[data-key="${CSS.escape(k)}"]`)?.focus();
  }
});
$('qpDays').addEventListener('toggle', (e) => { if (e.target.dataset?.day) dayOpen.set(e.target.dataset.day, e.target.open); }, true);
$('qpCourse').addEventListener('change', render);
onEquiv(() => render());

/* ---------- views: QP statistics | exam schedule ---------- */
function showView(v) {
  $('qpViews').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', b.dataset.view === v));
  $('qpViewStats').hidden = v !== 'stats';
  $('qpViewSchedule').hidden = v !== 'schedule';
  pref.set('qpView', v);
}
$('qpViews').addEventListener('click', (e) => { const v = e.target.closest('[data-view]')?.dataset.view; if (v) showView(v); });
showView(pref.get('qpView') === 'schedule' ? 'schedule' : 'stats');
$('qpMissingBtn').addEventListener('click', () => {
  const box = $('schUndatedBox');
  box.open = true;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('qpSession').addEventListener('change', render);

/* ---------- exports ---------- */
function scope() {
  const course = $('qpCourse').value;
  const session = $('qpSession').value;
  const sessions = visibleSessions();
  const days = qp.days.filter((d) => sessions.some((s) => d[s].length));
  const info = [
    ['Course', course ? $('qpCourse').selectedOptions[0].textContent.replace(/\s*\(\d+\)$/, '') : 'All courses'],
    ...(session ? [['Session', SESSION_LABEL[session]]] : []),
    ['Time Table', `${timetable.meta.version || ''}`],
  ];
  return { sessions, days, info, name: (p) => slug([p, course || 'AllCourses', session].filter(Boolean).join('_')) };
}

$('qpCsvBtn').addEventListener('click', () => {
  const { days, sessions, name } = scope();
  const rows = [];
  for (const d of days) for (const s of sessions) for (const p of d[s])
    rows.push([dmy(d.date), weekday(d.date), s, p.time, p.code, p.name, joinSet(p.courses), joinSet(p.regs), p.R || 0, p.S || 0, p.total, schemePlain(p)]);
  downloadCsv(name('QP_Statistics') + '.csv', ['Date', 'Day', 'Session', 'Time', 'QP Code', 'Subject', 'Course', 'Regulation', 'Regular', 'Supplementary', 'QPs Needed', 'Scheme breakdown (merged subjects)'], rows);
});

const GREY = { fillColor: [245, 247, 251] };
const SESSION_FILL = { FN: [230, 240, 251], AN: [253, 238, 231] };
const bold = (content, extra = {}) => ({ content, styles: { fontStyle: 'bold', ...extra } });

$('qpPdfBtn').addEventListener('click', (e) =>
  withPdf(e.currentTarget, (jsPDF) => {
    const { days, sessions, info, name } = scope();
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const all = days.flatMap((d) => sessions.flatMap((s) => d[s]));
    let y = pdfHeader(doc, 'Question Paper Statistics', [...info, ['Total', `${sum(all, 'total')} question papers · ${all.length} papers · ${days.length} days`]]);

    // 1. day × session summary
    doc.setFont('helvetica', 'bold').setFontSize(10.5).text('Day-wise QP Requirement', 14, y + 3);
    doc.autoTable({
      ...TABLE_STYLE,
      startY: y + 6,
      head: [['Day', 'Date', ...sessions.flatMap((s) => [`${s} Papers`, `${s} QPs`]), 'Day Total']],
      body: [
        ...days.map((d, i) => [i + 1, fullDate(d.date), ...sessions.flatMap((s) => [d[s].length || '-', bold(d[s].length ? sum(d[s], 'total') : '-', { fillColor: SESSION_FILL[s] })]), bold(sum(sessions.flatMap((s) => d[s]), 'total'))]),
        [bold('Total', { halign: 'right', ...GREY }), { content: '', styles: GREY }, ...sessions.flatMap((s) => { const l = days.flatMap((d) => d[s]); return [bold(l.length, GREY), bold(sum(l, 'total'), GREY)]; }), bold(sum(all, 'total'), GREY)],
      ],
      columnStyles: { 0: { cellWidth: 12, halign: 'right' }, ...Object.fromEntries(sessions.flatMap((_, i) => [[2 + i * 2, { halign: 'right' }], [3 + i * 2, { halign: 'right' }]])), [2 + sessions.length * 2]: { halign: 'right' } },
      didDrawPage: () => pdfFooter(doc),
    });

    // 2. paper-wise list per day and session
    y = doc.lastAutoTable.finalY + 9;
    if (y > doc.internal.pageSize.getHeight() - 50) { doc.addPage(); y = 16; }
    doc.setFont('helvetica', 'bold').setFontSize(10.5).text('Paper-wise QP Requirement', 14, y);
    const body = [];
    days.forEach((d, i) => {
      body.push([{ content: `Day ${i + 1}  ·  ${fullDate(d.date)}`, colSpan: 7, styles: { fillColor: [232, 239, 255], fontStyle: 'bold', textColor: [24, 32, 50] } }]);
      for (const s of sessions) {
        if (!d[s].length) continue;
        for (const p of d[s]) body.push([s, p.code, p.merged ? `${p.name}\n${schemePlain(p)}` : p.name, joinSet(p.courses), p.R || 0, p.S || 0, bold(p.total)]);
        body.push([{ content: `${SESSION_LABEL[s]} (${s}) QPs`, colSpan: 6, styles: { halign: 'right', fontStyle: 'bold', fillColor: SESSION_FILL[s] } }, bold(sum(d[s], 'total'), { fillColor: SESSION_FILL[s] })]);
      }
      body.push([{ content: 'Day total', colSpan: 6, styles: { halign: 'right', fontStyle: 'bold', ...GREY } }, bold(sum(sessions.flatMap((s) => d[s]), 'total'), GREY)]);
    });
    doc.autoTable({
      ...TABLE_STYLE,
      startY: y + 3,
      head: [['Session', 'QP Code', 'Subject', 'Course', 'R', 'S', 'QPs']],
      body,
      columnStyles: { 0: { cellWidth: 16 }, 1: { cellWidth: 24 }, 3: { cellWidth: 26 }, 4: { cellWidth: 11, halign: 'right' }, 5: { cellWidth: 11, halign: 'right' }, 6: { cellWidth: 14, halign: 'right' } },
      didDrawPage: () => pdfFooter(doc),
    });
    doc.save(name('QP_Statistics') + '.pdf');
  }),
);

loadData().catch((e) => {
  console.error(e);
  $('qpTtName').textContent = 'Could not load the built-in time table';
});
