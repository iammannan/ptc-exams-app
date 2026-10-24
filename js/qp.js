// QP Statistics tab: question papers needed per day / session.
import { buildQp, ttDifferences, TT_DIFF, courseRows, commonCourse } from './qpcalc.js';
import { parseTimetable, packTimetable } from './ttparser.js';
import { onTickets, pdfHeader, withPdf, TABLE_STYLE, joinSet, dmy, fullDate, weekday, shortDate, openDateEditor } from './halltickets.js';
import { mapSubject, onEquiv, equivTimetable } from './equiv.js';
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
  equivTimetable(timetable); // mapping pickers list the time table's subjects too
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
// Question papers a session needs: one per student, so a student under two papers in the same session counts once.
const repN = (d, s) => d.rep?.[s]?.n || 0;
const need = (d, s) => sum(d[s], 'total') - repN(d, s);
const needDays = (days, sessions) => days.reduce((n, d) => n + sessions.reduce((m, s) => m + need(d, s), 0), 0);
const repDays = (days, sessions) => days.reduce((n, d) => n + sessions.reduce((m, s) => m + repN(d, s), 0), 0);
const visibleSessions = () => ($('qpSession').value ? [$('qpSession').value] : ['FN', 'AN']);

function render() {
  if (!timetable) return;
  const course = $('qpCourse').value;
  pref.set('qpCourse', course);
  qp = buildQp(course ? tickets.filter((t) => t.courseNo === course) : tickets, timetable, mapSubject);
  qp.days = courseRows(qp.days, kv.get('qpMerges', []), mapSubject); // one row per course + paper, joined where you merged them
  const sessions = visibleSessions();
  const days = qp.days.filter((d) => sessions.some((s) => d[s].length));
  const papers = days.flatMap((d) => sessions.flatMap((s) => d[s]));

  $('qpEmpty').hidden = days.length > 0;
  $('qpEmpty').textContent = tickets.length ? 'No question papers for these filters.' : 'No hall tickets yet. Upload hall ticket PDFs in the Hall Tickets tab.';
  for (const id of ['qpCsvBtn', 'qpPdfBtn']) $(id).disabled = !papers.length;

  const tt = qpMode() === 'tt';
  for (const id of ['qpKpis', 'qpStatsHead', 'qpDays']) $(id).hidden = tt;
  if (tt) $('qpEmpty').hidden = true;
  $('qpTtBlock').hidden = !tt;
  $('qpDayWiseWrap').hidden = !tt;
  if (tt) return renderTt();
  renderKpis(days, papers, sessions);
  renderDays(days, sessions);
  renderDiffs();
}

/* ---------- timetable with strength ---------- */
// Every time-table row (course + subject) with the number of that course's candidates; course-wise or day-wise.
const qpMode = () => $('qpMode').querySelector('[aria-checked="true"]').dataset.mode;
$('qpMode').addEventListener('click', (e) => {
  const m = e.target.closest('[data-mode]')?.dataset.mode;
  if (!m) return;
  $('qpMode').querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-checked', b.dataset.mode === m));
  pref.set('qpMode', m);
  render();
});
$('qpDayWise').addEventListener('change', () => { pref.set('qpDayWise', $('qpDayWise').checked ? '1' : '0'); render(); });
if (pref.get('qpDayWise') === '1') $('qpDayWise').checked = true;
if (pref.get('qpMode') === 'tt') $('qpMode').querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-checked', b.dataset.mode === 'tt'));

const courseName = (c) => qp?.courses?.[c] || '';
function ttScope() {
  const course = $('qpCourse').value;
  const session = $('qpSession').value;
  const dayWise = $('qpDayWise').checked;
  const rows = qp.ttRows
    .filter((r) => (!course || r.course === course || r.course === commonCourse(course)) && (!session || r.session === session))
    .sort(dayWise
      ? (a, b) => a.date.localeCompare(b.date) || (a.session === b.session ? 0 : a.session === 'FN' ? -1 : 1) || a.course.localeCompare(b.course) || a.code.localeCompare(b.code, undefined, { numeric: true })
      : (a, b) => a.course.localeCompare(b.course) || a.date.localeCompare(b.date) || (a.session === b.session ? 0 : a.session === 'FN' ? -1 : 1) || a.code.localeCompare(b.code, undefined, { numeric: true }));
  const groups = [];
  for (const r of rows) {
    const k = dayWise ? r.date : r.course;
    let g = groups[groups.length - 1];
    if (!g || g.key !== k) groups.push((g = { key: k, title: dayWise ? fullDate(r.date) : `${r.course} – ${courseName(r.course)}`, rows: [] }));
    g.rows.push(r);
  }
  return { rows, groups, dayWise };
}
function renderTt() {
  const { rows, groups, dayWise } = ttScope();
  const total = rows.reduce((n, r) => n + r.n, 0);
  $('qpTtCount').textContent = `Timetable with strength · ${rows.length} subject(s) · ${total} candidate(s)`;
  for (const id of ['qpTtCsvBtn', 'qpTtPdfBtn']) $(id).disabled = !rows.length;
  $('qpTt').innerHTML = groups.length
    ? groups.map((g) => `<section class="card flush day">
        <header class="day-head"><div class="day-date"><b>${esc(g.title)}</b><span class="muted">${g.rows.length} subject(s)</span></div>
          <div class="day-stats"><span class="pill">Strength <b>${g.rows.reduce((n, r) => n + r.n, 0)}</b></span></div></header>
        <div class="table-wrap"><table class="data papers">
          <thead><tr>${dayWise ? '' : '<th>Date</th>'}<th>Session</th>${dayWise ? '<th>Course</th>' : ''}<th>Scheme</th><th class="num">Sem</th><th>Subject code</th><th>Subject</th><th class="num">R</th><th class="num">S</th><th class="num">Strength</th></tr></thead>
          <tbody>${g.rows.map((r) => `<tr class="${r.n ? '' : 'zero'}">${dayWise ? '' : `<td>${weekday(r.date)} ${dmy(r.date)}</td>`}<td><span class="badge ${r.session.toLowerCase()}">${r.session}</span> <span class="muted">${esc(r.time)}</span></td>${dayWise ? `<td>${esc(r.course)}</td>` : ''}<td>${esc(r.scheme)}</td><td class="num">${r.sem}</td><td><b>${esc(r.code)}</b></td><td class="wrap">${esc(r.name)}${r.remarks ? `<div class="breakdown">${esc(r.remarks)}</div>` : ''}</td><td class="num">${r.R}</td><td class="num">${r.S}</td><td class="num total">${r.n}</td></tr>`).join('')}</tbody>
        </table></div>
      </section>`).join('')
    : '<p class="empty card">No time-table subjects for these filters.</p>';
}
const ttLine = (r) => [dmy(r.date), weekday(r.date), r.session, r.time, r.course, courseName(r.course), r.scheme, r.sem, r.code, r.name, r.R, r.S, r.n];
$('qpTtCsvBtn').addEventListener('click', () => {
  const { rows, dayWise } = ttScope();
  downloadCsv(slug(`Timetable_Strength_${dayWise ? 'Daywise' : 'Coursewise'}`) + '.csv', ['Date', 'Day', 'Session', 'Time', 'Course', 'Course Name', 'Scheme', 'Sem', 'Subject Code', 'Subject', 'Regular', 'Supplementary', 'Strength'], rows.map(ttLine));
});
$('qpTtPdfBtn').addEventListener('click', (e) =>
  withPdf(e.currentTarget, (jsPDF) => {
    const { rows, groups, dayWise } = ttScope();
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const y = pdfHeader(doc, 'Timetable with Strength', [['Order', dayWise ? 'Day-wise' : 'Course-wise'], ['Time Table', `${timetable.meta.version || ''}`], ['Total', `${rows.length} subjects · ${rows.reduce((n, r) => n + r.n, 0)} candidates`]]);
    const body = [];
    for (const g of groups) {
      body.push([{ content: `${g.title}   ·   strength ${g.rows.reduce((n, r) => n + r.n, 0)}`, colSpan: 7, styles: { fillColor: [232, 239, 255], fontStyle: 'bold', textColor: [24, 32, 50] } }]);
      for (const r of g.rows) body.push([dayWise ? `${r.session}  ${r.course}` : `${dmy(r.date)} ${r.session}`, r.scheme, r.sem, r.code, r.name, `${r.R} / ${r.S}`, { content: String(r.n), styles: { fontStyle: 'bold', textColor: r.n ? 0 : [150, 150, 150] } }]);
    }
    doc.autoTable({
      ...TABLE_STYLE,
      startY: y + 2,
      head: [[dayWise ? 'Session · Course' : 'Date · Session', 'Scheme', 'Sem', 'Subject code', 'Subject', 'R / S', 'Strength']],
      body,
      columnStyles: { 0: { cellWidth: 30 }, 1: { cellWidth: 16 }, 2: { cellWidth: 10, halign: 'right' }, 3: { cellWidth: 24 }, 5: { cellWidth: 16, halign: 'right' }, 6: { cellWidth: 18, halign: 'right' } },
      didDrawPage: () => pdfFooter(doc),
    });
    doc.save(slug(`Timetable_Strength_${dayWise ? 'Daywise' : 'Coursewise'}`) + '.pdf');
  }),
);

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
  for (const d of days) for (const s of sessions) { const n = need(d, s); if (n && (!peak || n > peak.n)) peak = { d, s, n }; }
  const rp = repDays(days, sessions);
  const tiles = [
    { v: needDays(days, sessions), l: 'Question papers needed', sub: `${papers.length} papers · ${days.length} exam days${rp ? ` · ${rp} repeated subtracted` : ''}` },
    { v: sessions.includes('FN') ? needDays(days, ['FN']) : '—', l: 'Forenoon (FN) QPs', sub: `${days.filter((d) => d.FN.length).length} FN sessions` },
    { v: sessions.includes('AN') ? needDays(days, ['AN']) : '—', l: 'Afternoon (AN) QPs', sub: `${days.filter((d) => d.AN.length).length} AN sessions` },
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
          <div class="day-stats">${sessions.filter((s) => d[s].length).map((s) => `<span class="pill ${s.toLowerCase()}"><i class="sw ${s.toLowerCase()}"></i>${s} <b>${need(d, s)}</b> QPs · ${d[s].length} paper(s)</span>`).join('')}</div>
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
                      <td><b>${esc(p.code)}</b>${p.setDate ? ' <span class="badge manual" title="Exam date set by you">Set date</span>' : p.fromTicket ? ' <span class="badge" title="Not in the time table — date taken from the hall ticket">HT date</span>' : ''}${p.merged ? ` <span class="badge cross" title="Includes old / legacy subjects: ${esc([...p.legacyCodes].join(', '))}">Merged</span>` : ''}${p.joined ? ` <span class="badge joined" title="Course codes merged by you: ${esc(p.keys.map((k) => k.replace('|', ' · ')).join(', '))}">Courses merged</span>` : ''}</td>
                      <td class="wrap">${esc(p.name)}${p.merged ? `<div class="breakdown">${schemeText(p)}</div>` : ''}</td>
                      <td>${esc(joinSet(p.courses))}</td>
                      <td>${esc(joinSet(p.regs))}</td>
                      <td class="num">${p.R || 0}</td>
                      <td class="num">${p.S || 0}</td>
                      <td class="num total">${p.total}</td>
                      <td class="chev"><button type="button" class="icon-btn merge-btn${p.joined ? ' on' : ''}" data-merge="${esc(p.key)}" title="Merge with other course codes" aria-label="Merge ${esc(p.code)} with other course codes"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M6 4v5a5 5 0 0 0 5 5h7m-3-3 3 3-3 3M6 20v-3"/></svg></button><button type="button" class="icon-btn" data-date="${esc(p.keys[0].split('|')[1])}" title="Edit exam date for ${esc(p.code)}">✎</button> <span aria-hidden="true">›</span></td>
                    </tr>
                    ${isOpen ? `<tr class="drill"><td colspan="9">${candidates(p)}</td></tr>` : ''}`;
                  })
                  .join('')}
                  ${repN(d, s) ? `<tr class="session-total rep ${s.toLowerCase()}"><td colspan="7">Repeated register numbers in ${s} (one student, two papers) <button type="button" class="info-btn" data-rep="${d.date}|${s}" title="Why is this subtracted?" aria-label="Why is this subtracted?">i</button></td><td class="num total">−${repN(d, s)}</td><td></td></tr>` : ''}
                  <tr class="session-total ${s.toLowerCase()}"><td colspan="7">${SESSION_LABEL[s]} (${s}) QPs</td><td class="num total">${need(d, s)}</td><td></td></tr>`)
                .join('')}
              <tr class="day-total"><td colspan="7">Day total</td><td class="num total">${needDays([d], sessions)}</td><td></td></tr>
            </tbody>
          </table>
        </div>
      </details>`;
    })
    .join('');
}

/* ---------- merge course codes into one row ---------- */
// Pick the other rows of the same session that share this question paper. Suggested: the same paper code
// (e.g. full-time 1010 and part-time 3010) or the same subject name (e.g. the Tamil-medium 7010 paper).
let mergeRow = null;
const baseName = (n) => String(n || '').toLowerCase().replace(/\(tamil\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
function openMerge(key) {
  const [date, s] = key.split('|');
  const d = qp.days.find((x) => x.date === date);
  const row = d?.[s].find((r) => r.key === key);
  if (!row) return;
  // the full course list of the session, without a course filter, so merges are made against every course
  const all = courseRows(buildQp(tickets, timetable, mapSubject).days, kv.get('qpMerges', []), mapSubject).find((x) => x.date === date)?.[s] || [];
  const codes = new Set(row.keys.map((k) => k.split('|')[1]));
  const names = new Set(row.name.split(' / ').map(baseName));
  const others = all.filter((r) => r.key !== key && !r.keys.every((k) => row.keys.includes(k)))
    .map((r) => ({ r, why: r.keys.some((k) => codes.has(k.split('|')[1])) ? 'Same paper code' : r.name.split(' / ').some((n) => names.has(baseName(n))) ? 'Same subject' : '' }))
    .sort((a, b) => !!b.why - !!a.why || a.r.code.localeCompare(b.r.code, undefined, { numeric: true }));
  mergeRow = row;
  const label = (r) => `<b>${esc([...r.courses].join(', '))}</b> · ${esc(r.code)} ${esc(r.name)} <span class="muted">(${r.total})</span>`;
  $('mergeFor').innerHTML = `${fullDate(date)} · ${SESSION_LABEL[s]} (${s})<br>${label(row)}`;
  $('mergeList').innerHTML = others.length
    ? others.map(({ r, why }) => `<label class="check merge-opt"><input type="checkbox" value="${esc(r.keys.join('+'))}" /> <span>${label(r)}${why ? ` <span class="badge cross">${why}</span>` : ''}${r.joined ? ' <span class="badge joined">Courses merged</span>' : ''}</span></label>`).join('')
    : '<p class="muted">No other course codes in this session.</p>';
  $('mergeUndo').hidden = !row.joined;
  $('mergeDlg').showModal();
}
function saveMerges(groups) {
  kv.set('qpMerges', groups.filter((g) => g.length > 1));
  $('mergeDlg').close();
  render();
}
$('mergeSave').addEventListener('click', () => {
  const picked = [...$('mergeList').querySelectorAll('input:checked')].flatMap((i) => i.value.split('+'));
  if (!picked.length) return toast('Tick the course codes to merge with');
  const keys = [...new Set([...mergeRow.keys, ...picked])];
  const groups = kv.get('qpMerges', []).map((g) => g.filter((k) => !keys.includes(k)));
  saveMerges([...groups, keys]);
  toast(`Merged into one row: ${keys.map((k) => k.replace('|', ' · ')).join(', ')}`);
});
$('mergeUndo').addEventListener('click', () => {
  saveMerges(kv.get('qpMerges', []).map((g) => g.filter((k) => !mergeRow.keys.includes(k))));
  toast('Course codes shown separately again');
});
$('mergeClose').addEventListener('click', () => $('mergeDlg').close());
$('mergeDlg').addEventListener('click', (e) => { if (e.target === $('mergeDlg')) $('mergeDlg').close(); });

// Why a session's QP count is lower than the sum of its papers.
function openRepeats(key) {
  const [date, s] = key.split('|');
  const d = qp.days.find((x) => x.date === date);
  const r = d?.rep?.[s];
  if (!r) return;
  $('repFor').textContent = `${fullDate(date)} · ${SESSION_LABEL[s]} (${s}): ${sum(d[s], 'total')} by paper − ${r.n} repeated = ${need(d, s)} question papers`;
  $('repBody').innerHTML = r.list
    .map(({ t, papers }, i) => `<tr><td class="num">${i + 1}</td><td><b>${esc(t.regNo)}</b></td><td>${esc(t.name)}</td><td>${esc(t.courseNo)}</td>
      <td class="wrap">${papers.map((p) => `<b>${esc(p.code)}</b> ${esc(p.name)}`).join('<br>')}</td><td class="num"><b>−${papers.length - 1}</b></td></tr>`)
    .join('');
  $('repMerged').textContent = r.merged ? `Also, ${r.merged} student(s) with two old subjects mapped to the same current paper are already counted once inside that paper.` : '';
  $('repDlg').showModal();
}
$('repClose').addEventListener('click', () => $('repDlg').close());
$('repDlg').addEventListener('click', (e) => { if (e.target === $('repDlg')) $('repDlg').close(); });

const toggle = (k) => { open.has(k) ? open.delete(k) : open.add(k); render(); };
$('qpDays').addEventListener('click', (e) => {
  const mk = e.target.closest('[data-merge]')?.dataset.merge;
  if (mk) return openMerge(mk);
  const rk = e.target.closest('[data-rep]')?.dataset.rep;
  if (rk) return openRepeats(rk);
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
    const rp = repDays(days, sessions);
    let y = pdfHeader(doc, 'Question Paper Statistics', [...info, ['Total', `${needDays(days, sessions)} question papers · ${all.length} papers · ${days.length} days${rp ? ` · ${rp} repeated register numbers subtracted (one student under two papers in a session)` : ''}`]]);

    // 1. day × session summary
    doc.setFont('helvetica', 'bold').setFontSize(10.5).text('Day-wise QP Requirement', 14, y + 3);
    doc.autoTable({
      ...TABLE_STYLE,
      startY: y + 6,
      head: [['Day', 'Date', ...sessions.flatMap((s) => [`${s} Papers`, `${s} QPs`]), 'Day Total']],
      body: [
        ...days.map((d, i) => [i + 1, fullDate(d.date), ...sessions.flatMap((s) => [d[s].length || '-', bold(d[s].length ? need(d, s) : '-', { fillColor: SESSION_FILL[s] })]), bold(needDays([d], sessions))]),
        [bold('Total', { halign: 'right', ...GREY }), { content: '', styles: GREY }, ...sessions.flatMap((s) => { const l = days.flatMap((d) => d[s]); return [bold(l.length, GREY), bold(needDays(days, [s]), GREY)]; }), bold(needDays(days, sessions), GREY)],
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
        if (repN(d, s)) body.push([{ content: `Repeated register numbers in ${s} (one student under two papers): ${d.rep[s].list.map((x) => x.t.regNo).join(', ')}`, colSpan: 6, styles: { halign: 'right', fontStyle: 'italic', textColor: [180, 83, 9] } }, bold(`-${repN(d, s)}`, { textColor: [180, 83, 9] })]);
        body.push([{ content: `${SESSION_LABEL[s]} (${s}) QPs`, colSpan: 6, styles: { halign: 'right', fontStyle: 'bold', fillColor: SESSION_FILL[s] } }, bold(need(d, s), { fillColor: SESSION_FILL[s] })]);
      }
      body.push([{ content: 'Day total', colSpan: 6, styles: { halign: 'right', fontStyle: 'bold', ...GREY } }, bold(needDays([d], sessions), GREY)]);
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
