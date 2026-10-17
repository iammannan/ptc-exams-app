// QP Statistics tab: question papers needed per day / session, grouped by equivalent subjects.
import { buildQp } from './qpcalc.js';
import { parseTimetable, packTimetable } from './ttparser.js';
import { onTickets, pdfHeader, withPdf, TABLE_STYLE, joinSet, dmy, fullDate, weekday, shortDate } from './halltickets.js';
import { $, esc, loadPdfjs, toast, pref, slug, downloadCsv, pdfFooter } from './util.js';

const SESSION_LABEL = { FN: 'Forenoon', AN: 'Afternoon' };
const TT_KEY = 'ptc.timetable'; // a revised time table loaded by the user (packed JSON)

let alternates = null, builtinTt = null, timetable = null;
let tickets = [];
let qp = null;
const open = new Set();

/* ---------- data ---------- */
function savedTimetable() {
  try { return JSON.parse(localStorage.getItem(TT_KEY) || 'null'); } catch { return null; }
}

async function loadData() {
  const [a, t] = await Promise.all([import('./data/alternates.js'), import('./data/timetable.js')]);
  alternates = a.default;
  builtinTt = t.default;
  timetable = savedTimetable() || builtinTt;
  renderSources();
  render();
}

function renderSources() {
  const custom = timetable !== builtinTt;
  $('qpTtName').textContent = `${timetable.meta.title || 'Time table'} · ${timetable.meta.version || ''}`;
  $('qpTtNote').textContent = `${custom ? 'Loaded by you' : 'Built in'} · ${timetable.meta.file || ''} · ${timetable.rows.length} subject entries`;
  $('qpTtReset').hidden = !custom;
  $('qpAltName').textContent = alternates.title.replace(/^.*?—\s*/, '');
  $('qpAltNote').textContent = `DOTE TAM section · ${alternates.rowCount.toLocaleString('en-IN')} mappings · downloaded ${new Date(alternates.fetchedAt).toLocaleDateString('en-IN')}`;
}

$('qpTtInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    toast('Reading time table…');
    const packed = packTimetable(await parseTimetable(await loadPdfjs(), new Uint8Array(await f.arrayBuffer())), f.name);
    if (packed.rows.length < 10) throw new Error('No time table rows found in this PDF');
    try { localStorage.setItem(TT_KEY, JSON.stringify(packed)); } catch {}
    timetable = packed;
    renderSources();
    render();
    toast(`Time table loaded: ${packed.rows.length} entries`);
  } catch (err) {
    console.error(err);
    toast(err.message || 'Could not read that time table');
  }
});
$('qpTtReset').addEventListener('click', () => {
  try { localStorage.removeItem(TT_KEY); } catch {}
  timetable = builtinTt;
  renderSources();
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
  if (!alternates) return;
  const course = $('qpCourse').value;
  pref.set('qpCourse', course);
  qp = buildQp(course ? tickets.filter((t) => t.courseNo === course) : tickets, alternates, timetable);
  const sessions = visibleSessions();
  const days = qp.days.filter((d) => sessions.some((s) => d[s].length));
  const papers = days.flatMap((d) => sessions.flatMap((s) => d[s]));

  $('qpEmpty').hidden = days.length > 0;
  $('qpEmpty').textContent = tickets.length ? 'No question papers for these filters.' : 'No hall tickets yet. Upload hall ticket PDFs in the Hall Tickets tab.';
  for (const id of ['qpCsvBtn', 'qpPdfBtn', 'qpGroupsBtn']) $(id).disabled = !papers.length;

  renderKpis(days, papers, sessions);
  renderDays(days, sessions);
  renderLists();
}

function renderKpis(days, papers, sessions) {
  if (!tickets.length) return ($('qpKpis').innerHTML = '');
  let peak = null;
  for (const d of days) for (const s of sessions) { const n = sum(d[s], 'total'); if (n && (!peak || n > peak.n)) peak = { d, s, n }; }
  const nm = qp.notMapped.reduce((n, g) => n + g.students.length, 0);
  const tiles = [
    { v: sum(papers, 'total'), l: 'Question papers needed', sub: `${papers.length} papers · ${days.length} exam days` },
    { v: sessions.includes('FN') ? sum(days.flatMap((d) => d.FN), 'total') : '—', l: 'Forenoon (FN) QPs', sub: `${days.filter((d) => d.FN.length).length} FN sessions` },
    { v: sessions.includes('AN') ? sum(days.flatMap((d) => d.AN), 'total') : '—', l: 'Afternoon (AN) QPs', sub: `${days.filter((d) => d.AN.length).length} AN sessions` },
    { v: sum(papers, 'old'), l: 'Old-scheme candidates', sub: 'counted on R2023 alternate papers' },
    { v: peak ? peak.n : '—', l: 'Busiest session', sub: peak ? `${weekday(peak.d.date)} ${shortDate(peak.d.date)} · ${peak.s}` : '' },
    { v: nm, l: 'Old subjects not mapped', sub: `${qp.notMapped.length} subjects (mostly practicals)`, warn: nm > 0 && qp.notMapped.some((g) => !/PRACTICAL|PROJECT|LAB/i.test(g.name)) },
  ];
  $('qpKpis').innerHTML = tiles.map((t) => `<div class="kpi${t.warn ? ' warn' : ''}"><span class="l">${t.l}</span><b>${t.v}</b><span class="sub">${esc(t.sub)}</span></div>`).join('');
}

function memberRows(p) {
  return `<table class="data inner">
    <thead><tr><th>Subject Code</th><th>Regl.</th><th>Subject Name</th><th>Course</th><th class="num">Sem</th><th class="num">R</th><th class="num">S</th><th class="num">Strength</th></tr></thead>
    <tbody>${p.members
      .map((m) => `<tr${m.alt && /check/.test(m.how) ? ' class="check" title="Matched by semester / column only — please check"' : ''}>
        <td><b>${esc(m.code)}</b></td><td>${esc(m.regulation)}</td><td class="wrap">${esc(m.name)}${m.alt ? ` <span class="muted">→ ${esc(m.how)}</span>` : ''}</td>
        <td>${esc(joinSet(m.courses))}</td><td class="num">${esc(joinSet(m.sems))}</td><td class="num">${m.R || 0}</td><td class="num">${m.S || 0}</td><td class="num total">${m.students.length}</td></tr>`)
      .join('')}
      <tr class="day-total"><td colspan="7">Group strength</td><td class="num total">${p.total}</td></tr>
    </tbody></table>`;
}

function renderDays(days, sessions) {
  $('qpDays').innerHTML = days
    .map((d, i) => {
      const dayPapers = sessions.flatMap((s) => d[s]);
      return `<section class="card flush day">
        <header class="day-head">
          <div class="day-date"><span class="dow">${weekday(d.date)}</span><b>${dmy(d.date)}</b><span class="muted">Day ${i + 1}</span></div>
          <div class="day-stats">${sessions.filter((s) => d[s].length).map((s) => `<span class="pill ${s.toLowerCase()}"><i class="sw ${s.toLowerCase()}"></i>${s} <b>${sum(d[s], 'total')}</b> QPs · ${d[s].length} paper(s)</span>`).join('')}</div>
        </header>
        <div class="table-wrap">
          <table class="data papers">
            <thead><tr><th>Session</th><th>QP Code</th><th>Subject</th><th>Equivalent subjects</th><th class="num">R2023</th><th class="num">Old schemes</th><th class="num">QPs</th><th></th></tr></thead>
            <tbody>
              ${sessions
                .filter((s) => d[s].length)
                .map((s) => `${d[s]
                  .map((p) => {
                    const isOpen = open.has(p.key);
                    return `<tr class="paper${isOpen ? ' open' : ''}" data-key="${esc(p.key)}" tabindex="0" aria-expanded="${isOpen}">
                      <td><span class="badge ${s.toLowerCase()}">${s}</span> <span class="muted">${esc(p.time)}</span></td>
                      <td><b>${esc(p.code)}</b>${p.scheme !== 'R2023' ? ` <span class="badge">${esc(p.scheme)}</span>` : ''}</td>
                      <td class="wrap">${esc(p.name)}</td>
                      <td class="wrap muted">${p.members.length > 1 || p.old ? esc(p.members.filter((m) => m.code !== p.code).map((m) => m.code).join(', ')) : '—'}</td>
                      <td class="num">${p.total - p.old}</td>
                      <td class="num">${p.old}</td>
                      <td class="num total">${p.total}</td>
                      <td class="chev" aria-hidden="true">›</td>
                    </tr>
                    ${isOpen ? `<tr class="drill"><td colspan="8">${memberRows(p)}</td></tr>` : ''}`;
                  })
                  .join('')}
                  <tr class="session-total ${s.toLowerCase()}"><td colspan="6">${SESSION_LABEL[s]} (${s}) QPs</td><td class="num total">${sum(d[s], 'total')}</td><td></td></tr>`)
                .join('')}
              <tr class="day-total"><td colspan="6">Day total</td><td class="num total">${sum(dayPapers, 'total')}</td><td></td></tr>
            </tbody>
          </table>
        </div>
      </section>`;
    })
    .join('');
}

function renderLists() {
  const nm = [...qp.notMapped, ...qp.notTimetabled.map((g) => ({ ...g, name: `${g.name} (alternate ${g.alt.code} is not in the time table)` }))];
  $('qpNotMappedBox').hidden = !nm.length;
  $('qpNotMappedNote').textContent = `· ${nm.length} subjects · ${nm.reduce((n, g) => n + g.students.length, 0)} student entries`;
  $('qpNotMappedBody').innerHTML = nm
    .map((g) => `<tr><td><b>${esc(g.code)}</b></td><td class="wrap">${esc(g.name)}</td><td>${esc(g.regulation)}</td><td>${esc(joinSet(g.courses))}</td><td class="num">${g.sem}</td><td class="num total">${g.students.length}</td></tr>`)
    .join('');
  $('qpNoPaperBox').hidden = !qp.noPaper.length;
  $('qpNoPaperNote').textContent = `· ${qp.noPaper.length} subjects · ${qp.noPaper.reduce((n, g) => n + g.students.length, 0)} student entries`;
  $('qpNoPaperBody').innerHTML = qp.noPaper
    .map((g) => `<tr><td><b>${esc(g.code)}</b></td><td class="wrap">${esc(g.name)}</td><td>${esc(g.regulation)}</td><td>${esc(joinSet(g.courses))}</td><td class="wrap">${esc(g.alt.code)} ${esc(g.alt.name)}</td><td>${esc(g.alt.exam)}</td><td class="num total">${g.students.length}</td></tr>`)
    .join('');
}

const toggle = (k) => { open.has(k) ? open.delete(k) : open.add(k); render(); };
$('qpDays').addEventListener('click', (e) => {
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
$('qpCourse').addEventListener('change', render);
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
  return { course, session, sessions, days, info, name: (p) => slug([p, course || 'AllCourses', session].filter(Boolean).join('_')) };
}

$('qpCsvBtn').addEventListener('click', () => {
  const { days, sessions, name } = scope();
  const rows = [];
  for (const d of days) for (const s of sessions) for (const p of d[s])
    rows.push([dmy(d.date), weekday(d.date), s, p.time, p.code, p.name, p.members.filter((m) => m.code !== p.code).map((m) => `${m.code} (${m.students.length})`).join('; '), p.total - p.old, p.old, p.total]);
  downloadCsv(name('QP_Statistics') + '.csv', ['Date', 'Day', 'Session', 'Time', 'QP Code', 'Subject', 'Equivalent Old Subjects', 'R2023', 'Old Schemes', 'QPs Needed'], rows);
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
      body.push([{ content: `Day ${i + 1}  ·  ${fullDate(d.date)}`, colSpan: 6, styles: { fillColor: [232, 239, 255], fontStyle: 'bold', textColor: [24, 32, 50] } }]);
      for (const s of sessions) {
        if (!d[s].length) continue;
        for (const p of d[s]) body.push([s, p.code, p.name, p.total - p.old, p.old, bold(p.total)]);
        body.push([{ content: `${SESSION_LABEL[s]} (${s}) QPs`, colSpan: 5, styles: { halign: 'right', fontStyle: 'bold', fillColor: SESSION_FILL[s] } }, bold(sum(d[s], 'total'), { fillColor: SESSION_FILL[s] })]);
      }
      body.push([{ content: 'Day total', colSpan: 5, styles: { halign: 'right', fontStyle: 'bold', ...GREY } }, bold(sum(sessions.flatMap((s) => d[s]), 'total'), GREY)]);
    });
    doc.autoTable({
      ...TABLE_STYLE,
      startY: y + 3,
      head: [['Session', 'QP Code', 'Subject', 'R2023', 'Old Schemes', 'QPs']],
      body,
      columnStyles: { 0: { cellWidth: 16 }, 1: { cellWidth: 24 }, 3: { cellWidth: 16, halign: 'right' }, 4: { cellWidth: 20, halign: 'right' }, 5: { cellWidth: 15, halign: 'right' } },
      didDrawPage: () => pdfFooter(doc),
    });
    doc.save(name('QP_Statistics') + '.pdf');
  }),
);

$('qpGroupsBtn').addEventListener('click', (e) =>
  withPdf(e.currentTarget, (jsPDF) => {
    const { days, sessions, info, name } = scope();
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const all = days.flatMap((d) => sessions.flatMap((s) => d[s]));
    const y = pdfHeader(doc, 'Equivalent Subjects & Question Papers', [
      ...info,
      ['Papers', `${all.length} question papers · ${sum(all, 'total')} candidates (${sum(all, 'old')} from old schemes)`],
      ['Not mapped', `${qp.notMapped.length} old subjects · ${qp.notMapped.reduce((n, g) => n + g.students.length, 0)} entries`],
    ]);
    const head = [['Subject Code', 'Regl.', 'Subject Name', 'Mapped By', 'Course', 'Sem', 'R', 'S', 'Strength']];
    const body = [];
    for (const p of all) {
      body.push([{ content: `${fullDate(p.date)}  ·  ${p.session} (${p.time})      QP ${p.code} – ${p.name}`, colSpan: 8, styles: { fillColor: [232, 239, 255], fontStyle: 'bold', textColor: [24, 32, 50] } }, bold(p.total, { fillColor: [232, 239, 255] })]);
      for (const m of p.members) body.push([m.code, m.regulation, m.name, m.alt ? m.how : 'R2023 paper', joinSet(m.courses), joinSet(m.sems), m.R || 0, m.S || 0, bold(m.students.length)]);
    }
    const listTable = (title, rows, cols) => {
      if (!rows.length) return;
      let ty = doc.lastAutoTable.finalY + 10;
      if (ty > doc.internal.pageSize.getHeight() - 40) { doc.addPage(); ty = 16; }
      doc.setFont('helvetica', 'bold').setFontSize(10.5).text(title, 14, ty);
      doc.autoTable({ ...TABLE_STYLE, startY: ty + 3, head: [cols], body: rows, didDrawPage: () => pdfFooter(doc) });
    };
    doc.autoTable({
      ...TABLE_STYLE,
      startY: y,
      head,
      body,
      columnStyles: { 0: { cellWidth: 26 }, 1: { cellWidth: 14 }, 3: { cellWidth: 42 }, 4: { cellWidth: 38 }, 5: { cellWidth: 12, halign: 'right' }, 6: { cellWidth: 10, halign: 'right' }, 7: { cellWidth: 10, halign: 'right' }, 8: { cellWidth: 18, halign: 'right' } },
      didDrawPage: () => pdfFooter(doc),
    });
    const nm = [...qp.notMapped, ...qp.notTimetabled.map((g) => ({ ...g, name: `${g.name} (alternate ${g.alt.code} not in time table)` }))];
    listTable(`Old subjects not mapped (${nm.length})`, nm.map((g) => [g.code, g.regulation, g.name, joinSet(g.courses), g.sem, g.students.length]), ['Subject Code', 'Regl.', 'Subject Name', 'Course', 'Sem', 'Students']);
    listTable(`Alternate is not a theory paper — no QP (${qp.noPaper.length})`, qp.noPaper.map((g) => [g.code, g.regulation, g.name, joinSet(g.courses), `${g.alt.code} ${g.alt.name}`, g.alt.exam, g.students.length]), ['Old Code', 'Regl.', 'Old Subject', 'Course', 'R2023 Alternate', 'End Exam', 'Students']);
    doc.save(name('Equivalent_Subjects') + '.pdf');
  }),
);

loadData().catch((e) => {
  console.error(e);
  $('qpTtName').textContent = $('qpAltName').textContent = 'Could not load built-in data';
});
