// QP Statistics tab: question papers needed per day / session.
import { buildQp, ttDifferences, TT_DIFF, courseRows, commonCourse } from './qpcalc.js';
import { parseTimetable, packTimetable } from './ttparser.js';
import { addSitting, nrCourses, nrStudents, onTickets, pdfHeader, withPdf, TABLE_STYLE, joinSet, dmy, fullDate, weekday, shortDate, openDateEditor } from './halltickets.js';
import { mapSubject, onEquiv, equivTimetable, equivalentsOf, mapperFor, builtinOn, theoryOnly } from './equiv.js';
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

// What the page counts, from the options panel.
const opt = () => ({
  ht: $('qpSrcHt').checked, nr: $('qpSrcNr').checked,
  tt: $('qpDateTt').checked, htDates: $('qpDateHt').checked, set: $('qpDateSet').checked,
  mapDef: $('qpMapDefault').checked, mapCus: $('qpMapCustom').checked, theory: $('qpTheoryOnly').checked, ours: $('qpOurCourses').checked, zero: $('qpShowZero').checked, group: $('qpGroup').value,
});
// our courses: those on the nominal rolls (else on the hall tickets), with their common first-year course 1000 / 3000
function ourCourses() {
  const ours = nrCourses().size ? new Set(nrCourses()) : new Set(tickets.map((t) => t.courseNo));
  for (const c of [...ours]) ours.add(commonCourse(c));
  return ours;
}
// The candidates to count: hall tickets (with the chosen date sources) and / or nominal-roll subjects not on them.
function inputTickets(o) {
  const dated = (s) => {
    if (s.setDate && !o.set) s = { ...s, date: s.htDate || '', session: s.htSession || '', setDate: false };
    if (!s.setDate && !o.htDates) s = { ...s, date: '', session: '', time: '' };
    return s;
  };
  const byReg = new Map(o.ht ? tickets.map((t) => [t.regNo, { ...t, subjects: t.subjects.map(dated) }]) : []);
  if (o.nr)
    for (const st of nrStudents()) {
      const t = byReg.get(st.regNo);
      const have = new Set((t?.subjects || []).map((x) => x.code));
      const extra = st.sems.flatMap((x) => x.codes.map((code) => ({ code, name: '', sem: x.sem, type: x.type, regulation: x.regulation, date: '', session: '', time: '', fromNr: true }))).filter((x) => !have.has(x.code));
      if (!extra.length) continue;
      byReg.set(st.regNo, t ? { ...t, subjects: [...t.subjects, ...extra] } : { regNo: st.regNo, name: st.name, courseNo: st.courseNo, courseName: st.courseName, dob: st.dob, subjects: extra, nrOnly: true });
    }
  const ours = o.ours ? ourCourses() : null;
  const course = $('qpCourse').value;
  return [...byReg.values()].filter((t) => (!ours || ours.has(t.courseNo)) && (!course || t.courseNo === course));
}

function render() {
  if (!timetable) return;
  const o = opt();
  pref.set('qpCourse', $('qpCourse').value);
  const map = mapperFor({ builtin: o.mapDef, custom: o.mapCus });
  qp = buildQp(o.theory ? theoryOnly(inputTickets(o), map) : inputTickets(o), timetable, map, kv.get('crossCourse', {}), { tt: o.tt, removed: kv.get('qpRemoved', []) });
  qp.days = courseRows(qp.days, kv.get('qpMerges', []), map); // one row per course + paper, joined where you merged them
  const sessions = visibleSessions();
  const days = qp.days.filter((d) => sessions.some((s) => d[s].length));
  const papers = days.flatMap((d) => sessions.flatMap((s) => d[s]));
  const byDay = o.group === 'day';

  $('qpEmpty').hidden = days.length > 0;
  $('qpEmpty').textContent = tickets.length || o.nr ? 'No question papers for these options.' : 'No hall tickets yet. Upload hall ticket PDFs in the Hall Tickets tab.';
  for (const id of ['qpCsvBtn', 'qpPdfBtn']) $(id).disabled = !papers.length;
  $('qpStatsHead').hidden = !byDay;
  $('qpTtBlock').hidden = byDay; // its CSV / PDF export the session / course lists
  $('qpTt').hidden = true;
  $('qpShowZero').disabled = byDay;

  renderKpis(days, papers, sessions);
  renderOverview(days, sessions);
  if (byDay) renderDays(days, sessions);
  else { renderTt(); renderGrouped(days, sessions, o); }
  renderDiffs();
  renderCross();
}

// Session-wise count of question papers: per exam day, FN and AN (a student in two papers of a session counts once).
function sessionCounts(days, sessions) {
  return days.map((d) => ({ date: d.date, FN: sessions.includes('FN') ? need(d, 'FN') : 0, AN: sessions.includes('AN') ? need(d, 'AN') : 0, nFN: sessions.includes('FN') ? d.FN.length : 0, nAN: sessions.includes('AN') ? d.AN.length : 0 }));
}
function renderOverview(days, sessions) {
  const list = sessionCounts(days, sessions);
  const tot = (k) => list.reduce((n, d) => n + d[k], 0);
  $('qpOverview').innerHTML = list.length ? strengthChart(list) + `<section class="card flush day">
      <header class="day-head"><div class="day-date"><b>Session-wise count</b><span class="muted">${list.length} day(s)</span></div>
        <div class="day-stats"><span class="pill fn"><i class="sw fn"></i>FN <b>${tot('FN')}</b></span><span class="pill an"><i class="sw an"></i>AN <b>${tot('AN')}</b></span></div></header>
      <div class="table-wrap"><table class="data papers">
        <thead><tr><th>Date</th><th class="num">FN papers</th><th class="num">FN count</th><th class="num">AN papers</th><th class="num">AN count</th><th class="num">Day total</th></tr></thead>
        <tbody>${list.map((d) => `<tr><td>${weekday(d.date)} ${dmy(d.date)}</td><td class="num">${d.nFN || '–'}</td><td class="num total">${d.FN || '–'}</td><td class="num">${d.nAN || '–'}</td><td class="num total">${d.AN || '–'}</td><td class="num total">${d.FN + d.AN}</td></tr>`).join('')}
          <tr class="day-total"><td>Total</td><td class="num">${tot('nFN')}</td><td class="num total">${tot('FN')}</td><td class="num">${tot('nAN')}</td><td class="num total">${tot('AN')}</td><td class="num total">${tot('FN') + tot('AN')}</td></tr></tbody>
      </table></div>
    </section>` : '';
}

/* ---------- same subject code, other course: add or hold ---------- */
// A hall-ticket subject with no date whose code the time table lists only for other courses (e.g. Tamil-medium
// 6001236112 timetabled for 7010, written by 7020 students). Nothing is guessed: you add it on that course's date, or hold it.
const optText = (o) => `${o.course} · ${weekday(o.date)} ${dmy(o.date)} ${o.session}`;
function renderCross() {
  const list = qp.crossList || [];
  const showHeld = $('qpCrossHeld').checked;
  const shown = list.filter((c) => c.status !== 'hold' || showHeld);
  const pending = list.filter((c) => c.status === 'new').length, held = list.filter((c) => c.status === 'hold').length;
  $('qpCrossCard').hidden = !list.length;
  $('qpCrossNote').textContent = `${pending} to decide · ${list.filter((c) => c.status === 'add').length} added · ${held} held`;
  $('qpCrossBody').innerHTML = shown.map((c) => `<tr class="${c.status === 'hold' ? 'zero' : ''}">
      <td>${esc(c.course)}</td><td><b>${esc(c.code)}</b></td><td class="wrap">${esc(c.name)}</td><td class="num">${c.n}</td>
      <td>${c.status === 'add' ? esc(optText(c.options.find((o) => o.course === c.from) || c.options[0])) : c.options.length > 1
        ? `<select class="select-sm" data-xopt="${esc(c.key)}">${c.options.map((o) => `<option value="${esc(o.course)}">${esc(optText(o))}</option>`).join('')}</select>`
        : esc(optText(c.options[0]))}</td>
      <td>${c.status === 'add' ? '<span class="badge ok">Added</span>' : c.status === 'hold' ? '<span class="badge">Held</span>' : '<span class="badge warn">To decide</span>'}</td>
      <td class="row-actions">${c.status === 'new'
        ? `<button class="btn primary sm" data-xadd="${esc(c.key)}">Add to session</button><button class="btn ghost sm" data-xhold="${esc(c.key)}">Hold</button>`
        : `<button class="btn ghost sm" data-xundo="${esc(c.key)}">${c.status === 'add' ? 'Remove' : 'Undo'}</button>`}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">Nothing to decide. Tick "Show held" to see held subjects.</td></tr>';
}
async function setCross(key, value) {
  const all = { ...kv.get('crossCourse', {}) };
  if (value) all[key] = value;
  else delete all[key];
  await kv.set('crossCourse', all);
  render();
  for (const fn of ttListeners) fn(timetable); // seating places the added subjects too
}
$('qpCrossBody').addEventListener('click', (e) => {
  const add = e.target.closest('[data-xadd]')?.dataset.xadd;
  const hold = e.target.closest('[data-xhold]')?.dataset.xhold;
  const undo = e.target.closest('[data-xundo]')?.dataset.xundo;
  if (add) {
    const c = qp.crossList.find((x) => x.key === add);
    const from = $('qpCrossBody').querySelector(`[data-xopt="${CSS.escape(add)}"]`)?.value || c.options[0].course;
    setCross(add, { act: 'add', from });
    toast(`${c.code} (course ${c.course}): ${c.n} candidate(s) added on course ${from}'s date`);
  } else if (hold) setCross(hold, { act: 'hold' });
  else if (undo) setCross(undo, null);
});
$('qpCrossHeld').addEventListener('change', renderCross);

/* ---------- timetable with strength ---------- */
// Every time-table row (course + subject) with the number of that course's candidates; course-wise or day-wise.
// Default mapping starts as the built-in table's own switch; an earlier "Include mapping" box sets both.
if (!pref.get('qpMapDefault')) $('qpMapDefault').checked = pref.get('qpIncMap') === '0' ? false : builtinOn();
if (!pref.get('qpMapCustom') && pref.get('qpIncMap') === '0') $('qpMapCustom').checked = false;
for (const id of ['qpSrcHt', 'qpSrcNr', 'qpDateTt', 'qpDateHt', 'qpDateSet', 'qpMapDefault', 'qpMapCustom', 'qpTheoryOnly', 'qpOurCourses', 'qpShowZero']) {
  if (pref.get(id)) $(id).checked = pref.get(id) === '1';
  $(id).addEventListener('change', () => { pref.set(id, $(id).checked ? '1' : '0'); render(); });
}
if (pref.get('qpHideZero') === '0' && !pref.get('qpShowZero')) $('qpShowZero').checked = true; // earlier "Hide 0" box
$('qpGroup').value = pref.get('qpGroup') || 'day';
$('qpGroup').addEventListener('change', () => { pref.set('qpGroup', $('qpGroup').value); render(); });

const courseName = (c) => qp?.courses?.[c] || '';
const GROUP_LABEL = { course: 'Course-wise', day: 'Day-wise', session: 'Session-wise' };
const optSummary = (o) => [
  ['Candidates', [o.ht && 'Hall tickets', o.nr && 'Nominal roll'].filter(Boolean).join(' + ') || '—'],
  ['Dates from', [o.tt && 'Time table', o.htDates && 'Hall ticket', o.set && 'Set by you'].filter(Boolean).join(', ') || '—'],
  ['Mapping', [o.mapDef && 'Default', o.mapCus && 'Custom (yours)'].filter(Boolean).join(' + ') || 'None: own subject codes only'],
  ['Subjects', o.theory ? 'Theory only (End Exam T) — practicals in the Practicals tab' : 'Theory and practical'],
];
const bySession = (a, b) => a.date.localeCompare(b.date) || (a.session === b.session ? 0 : a.session === 'FN' ? -1 : 1);
function ttScope() {
  const o = opt();
  const course = $('qpCourse').value;
  const session = $('qpSession').value;
  const group = o.group === 'course' ? 'course' : 'session';
  const ours = o.ours ? ourCourses() : null;
  const rows = qp.ttRows
    .map((r) => ({ ...r, eqs: o.mapDef || o.mapCus ? eqList(r, o) : [] }))
    .filter((r) => (!course || r.course === course || r.course === commonCourse(course)) && (!session || r.session === session))
    .filter((r) => (!ours || ours.has(r.course)) && (o.zero || r.n > 0))
    .sort(group === 'course'
      ? (a, b) => a.course.localeCompare(b.course) || bySession(a, b) || a.code.localeCompare(b.code, undefined, { numeric: true })
      : (a, b) => bySession(a, b) || a.course.localeCompare(b.course) || a.code.localeCompare(b.code, undefined, { numeric: true }));
  const groups = [];
  for (const r of rows) {
    const k = group === 'course' ? r.course : r.date + '|' + r.session;
    let g = groups[groups.length - 1];
    if (!g || g.key !== k) groups.push((g = { key: k, title: group === 'course' ? `${r.course} – ${courseName(r.course)}` : `${fullDate(r.date)} · ${SESSION_LABEL[r.session]} (${r.session})`, rows: [] }));
    g.rows.push(r);
  }
  const sessions = visibleSessions();
  return { rows, groups, group, o, sessions: sessionCounts(qp.days.filter((d) => sessions.some((s) => d[s].length)), sessions) };
}
const strengthOf = (list) => list.reduce((n, r) => n + r.n, 0);
// round an axis maximum up to 1, 2, 2.5 or 5 × 10ⁿ
const niceMax = (n) => (n <= 5 ? 5 : [1, 2, 2.5, 5, 10].map((m) => m * 10 ** Math.floor(Math.log10(n))).find((v) => v >= n));
// The number on a bar segment: inside when it fits, beside the bar when the segment is thin (and the other session has papers).
const segLabel = (n, other, max, s) => (n / max > 0.06 ? `<b class="seg-v">${n}</b>` : other ? `<b class="seg-v out ${s}">${n}</b>` : '');
// Session-wise strength as stacked FN / AN bars, one per exam day (same look as "Students writing each day").
function strengthChart(sessions) {
  const max = niceMax(Math.max(...sessions.map((d) => d.FN + d.AN), 1));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  return `<section class="card chart-card">
      <div class="card-head">
        <div><h2>Session-wise count</h2><p class="muted">Question papers per session · ${sessions.length} exam day(s) · FN and AN shown on each bar</p></div>
        <div class="legend" aria-hidden="true"><span><i class="sw fn"></i>Forenoon (FN)</span><span><i class="sw an"></i>Afternoon (AN)</span></div>
      </div>
      <div class="chart-scroll"><div class="chart" role="img" style="--cols:${sessions.length}" aria-label="Bar chart of candidates per exam day: forenoon and afternoon. The session-wise count below has the same numbers.">
        <div class="axis">${ticks.map((v) => `<span style="bottom:${(v / max) * 100}%">${v}</span>`).join('')}</div>
        <div class="plot">
          ${ticks.map((v) => `<i class="grid" style="bottom:${(v / max) * 100}%"></i>`).join('')}
          ${sessions.map((d) => `<div class="bar" title="${fullDate(d.date)}&#10;FN: ${d.FN} candidates · ${d.nFN} subject(s)&#10;AN: ${d.AN} candidates · ${d.nAN} subject(s)">
            <span class="stack" style="height:${((d.FN + d.AN) / max) * 100}%">
              ${d.AN ? `<span class="seg an" style="flex:${d.AN}">${segLabel(d.AN, d.FN, max, 'an')}</span>` : ''}
              ${d.FN ? `<span class="seg fn" style="flex:${d.FN}">${segLabel(d.FN, d.AN, max, 'fn')}</span>` : ''}
              <span class="val">${d.FN + d.AN}</span>
            </span>
          </div>`).join('')}
        </div>
        <div class="xlabels">${sessions.map((d) => `<span><b>${shortDate(d.date)}</b>${weekday(d.date)}</span>`).join('')}</div>
      </div></div>
    </section>`;
}
// every equivalent old code of a time-table subject, with its candidates (0 when nobody writes it)
function eqList(r, o) {
  const n = new Map(r.old);
  const list = equivalentsOf(r.code, r.course, { builtin: o.mapDef, custom: o.mapCus }).map((e) => ({ ...e, n: n.get(e.code) || 0 }));
  for (const [code, k] of n) if (!list.some((e) => e.code === code)) list.push({ code, scheme: '', name: '', n: k });
  return list;
}
const oldText = (r) => r.eqs.map((e) => `${e.code}${e.scheme ? ` (${e.scheme.replace('-Scheme', '')})` : ''} ×${e.n}`).join(', ');
function renderTt() {
  const { rows, groups, group, o } = ttScope();
  const own = group !== 'course'; // course column needed when a group mixes courses
  $('qpTtCount').textContent = `${GROUP_LABEL[group]} · ${rows.length} subject(s) · ${strengthOf(rows)} candidate(s)${o.mapDef || o.mapCus ? '' : ' · own codes only'}`;
  for (const id of ['qpTtCsvBtn', 'qpTtPdfBtn']) $(id).disabled = !rows.length;
  $('qpTt').innerHTML = groups.length
    ? groups.map((g) => `<section class="card flush day">
        <header class="day-head"><div class="day-date"><b>${esc(g.title)}</b><span class="muted">${g.rows.length} subject(s)</span></div>
          <div class="day-stats"><span class="pill">Strength <b>${strengthOf(g.rows)}</b></span></div></header>
        <div class="table-wrap"><table class="data papers">
          <thead><tr>${group === 'course' ? '<th>Date</th><th>Session</th>' : ''}${own ? '<th>Course</th>' : ''}<th>Scheme</th><th class="num">Sem</th><th>Subject code</th><th>Subject</th><th class="num">R</th><th class="num">S</th><th class="num">Strength</th></tr></thead>
          <tbody>${g.rows.map((r) => `<tr class="${r.n ? '' : 'zero'}">${group === 'course' ? `<td>${weekday(r.date)} ${dmy(r.date)}</td><td><span class="badge ${r.session.toLowerCase()}">${r.session}</span> <span class="muted">${esc(r.time)}</span></td>` : ''}${own ? `<td>${esc(r.course)}</td>` : ''}<td>${esc(r.scheme)}</td><td class="num">${r.sem}</td><td><b>${esc(r.code)}</b>${r.old.length ? ' <span class="badge cross">Mapped</span>' : ''}${r.setDate ? ' <span class="badge manual" title="Not in the time table for this course: date set by you">Set date</span>' : r.ticket ? ' <span class="badge" title="Not in the time table for this course: date from the hall ticket">HT date</span>' : r.borrowed ? ` <span class="badge" title="${esc(r.remarks)}">TT ${esc(r.borrowed)}</span>` : ''}</td><td class="wrap">${esc(r.name)}${r.eqs.length ? `<div class="breakdown">Own code: <b>${r.own.n}</b> · Equivalents: ${r.eqs.map((e) => `<span class="${e.n ? '' : 'muted'}" title="${esc(e.name)}">${esc(e.code)}${e.scheme ? ` (${esc(e.scheme.replace('-Scheme', ''))})` : ''} ×<b>${e.n}</b></span>`).join(', ')}</div>` : ''}${r.remarks ? `<div class="breakdown">${esc(r.remarks)}</div>` : ''}</td><td class="num">${r.R}</td><td class="num">${r.S}</td><td class="num total">${r.n}</td></tr>`).join('')}</tbody>
        </table></div>
      </section>`).join('')
    : '<p class="empty card">No subjects for these options.</p>';
}
const ttLine = (r) => [dmy(r.date), weekday(r.date), r.session, r.time, r.course, courseName(r.course), r.scheme, r.sem, r.code, r.name, r.R, r.S, r.n, r.eqs.length ? r.own.n : '', oldText(r)];
$('qpTtCsvBtn').addEventListener('click', () => {
  const { rows, group } = ttScope();
  downloadCsv(slug(`QP_Statistics_${GROUP_LABEL[group]}`) + '.csv', ['Date', 'Day', 'Session', 'Time', 'Course', 'Course Name', 'Scheme', 'Sem', 'Subject Code', 'Subject', 'Regular', 'Supplementary', 'Strength', 'Own code', 'Equivalent codes (candidates)'], rows.map(ttLine));
});
$('qpTtPdfBtn').addEventListener('click', (e) =>
  withPdf(e.currentTarget, (jsPDF) => {
    const { rows, groups, group, o, sessions } = ttScope();
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    let y = pdfHeader(doc, 'QP Statistics', [['Order', GROUP_LABEL[group]], ...optSummary(o), ['Time Table', `${timetable.meta.version || ''}`], ['Total', `${rows.length} subjects · ${strengthOf(rows)} candidates`]]);
    // 1. session-wise count
    doc.setFont('helvetica', 'bold').setFontSize(10.5).text('Session-wise Count', 14, y + 3);
    const GREY = { fillColor: [245, 247, 251] };
    doc.autoTable({
      ...TABLE_STYLE,
      startY: y + 6,
      head: [['Date', 'FN Papers', 'FN Count', 'AN Papers', 'AN Count', 'Day Total']],
      body: [
        ...sessions.map((d) => [fullDate(d.date), d.nFN || '-', { content: d.FN || '-', styles: { fontStyle: 'bold' } }, d.nAN || '-', { content: d.AN || '-', styles: { fontStyle: 'bold' } }, { content: d.FN + d.AN, styles: { fontStyle: 'bold' } }]),
        [{ content: 'Total', styles: { fontStyle: 'bold', halign: 'right', ...GREY } }, { content: sessions.reduce((n, d) => n + d.nFN, 0), styles: GREY }, { content: sessions.reduce((n, d) => n + d.FN, 0), styles: { fontStyle: 'bold', ...GREY } }, { content: sessions.reduce((n, d) => n + d.nAN, 0), styles: GREY }, { content: sessions.reduce((n, d) => n + d.AN, 0), styles: { fontStyle: 'bold', ...GREY } }, { content: sessions.reduce((n, d) => n + d.FN + d.AN, 0), styles: { fontStyle: 'bold', ...GREY } }],
      ],
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
      didDrawPage: () => pdfFooter(doc),
    });
    // bar chart of the same numbers: FN (blue) under AN (orange), the day total on top
    y = doc.lastAutoTable.finalY + 8;
    if (sessions.length) {
      const W = doc.internal.pageSize.getWidth(), ch = 58;
      if (y + ch + 22 > doc.internal.pageSize.getHeight() - 14) { doc.addPage(); y = 16; }
      doc.setFont('helvetica', 'bold').setFontSize(10.5).setTextColor(0).text('Session-wise count (chart)', 14, y);
      doc.setFont('helvetica', 'normal').setFontSize(8).setFillColor(37, 99, 235).rect(W - 70, y - 2.6, 3, 3, 'F').text('Forenoon (FN)', W - 66, y);
      doc.setFillColor(234, 88, 12).rect(W - 38, y - 2.6, 3, 3, 'F').text('Afternoon (AN)', W - 34, y);
      const top = y + 6, left = 26, width = W - left - 14;
      const max = niceMax(Math.max(...sessions.map((d) => d.FN + d.AN), 1));
      doc.setDrawColor(220).setLineWidth(0.2).setTextColor(110).setFontSize(7);
      for (const f of [0, 0.25, 0.5, 0.75, 1]) {
        const gy = top + ch - f * ch;
        doc.line(left, gy, left + width, gy);
        doc.text(String(Math.round(max * f)), left - 2, gy + 1, { align: 'right' });
      }
      const slot = width / sessions.length, bw = Math.min(14, slot * 0.6);
      sessions.forEach((d, i) => {
        const bx = left + i * slot + (slot - bw) / 2;
        const hf = (d.FN / max) * ch, ha = (d.AN / max) * ch;
        if (hf) doc.setFillColor(37, 99, 235).rect(bx, top + ch - hf, bw, hf, 'F');
        if (ha) doc.setFillColor(234, 88, 12).rect(bx, top + ch - hf - ha, bw, ha, 'F');
        doc.setTextColor(255).setFont('helvetica', 'bold').setFontSize(6);
        if (hf > 4) doc.text(String(d.FN), bx + bw / 2, top + ch - hf / 2 + 1, { align: 'center' });
        if (ha > 4) doc.text(String(d.AN), bx + bw / 2, top + ch - hf - ha / 2 + 1, { align: 'center' });
        // thin segments: the number beside the bar, in the session's colour
        if (hf && hf <= 4 && d.AN) doc.setTextColor(37, 99, 235).text(String(d.FN), bx + bw + 0.8, top + ch - hf / 2 + 1);
        if (ha && ha <= 4 && d.FN) doc.setTextColor(234, 88, 12).text(String(d.AN), bx + bw + 0.8, top + ch - hf - ha / 2 + 1);
        doc.setTextColor(0).setFont('helvetica', 'bold').setFontSize(7).text(String(d.FN + d.AN), bx + bw / 2, top + ch - hf - ha - 1.2, { align: 'center' });
        doc.setFont('helvetica', 'normal').setFontSize(6.5).setTextColor(70).text([shortDate(d.date), weekday(d.date)], bx + bw / 2, top + ch + 3.5, { align: 'center' });
      });
      doc.setTextColor(0);
      y = top + ch + 14;
    }
    // 2. subjects, grouped
    y += 1;
    if (y > doc.internal.pageSize.getHeight() - 40) { doc.addPage(); y = 16; }
    doc.setFont('helvetica', 'bold').setFontSize(10.5).text(`Subjects (${GROUP_LABEL[group]})`, 14, y);
    const body = [];
    for (const g of groups) {
      body.push([{ content: `${g.title}   ·   strength ${strengthOf(g.rows)}`, colSpan: 7, styles: { fillColor: [232, 239, 255], fontStyle: 'bold', textColor: [24, 32, 50] } }]);
      for (const r of g.rows) body.push([
        group === 'course' ? `${dmy(r.date)} ${r.session}` : group === 'day' ? `${r.session}  ${r.course}` : r.course,
        r.scheme, r.sem, r.code, r.eqs.length ? `${r.name}\nOwn code ${r.own.n} · Equivalents: ${oldText(r)}` : r.name, `${r.R} / ${r.S}`,
        { content: String(r.n), styles: { fontStyle: 'bold', textColor: r.n ? 0 : [150, 150, 150] } },
      ]);
    }
    doc.autoTable({
      ...TABLE_STYLE,
      startY: y + 3,
      head: [[group === 'course' ? 'Date · Session' : group === 'day' ? 'Session · Course' : 'Course', 'Scheme', 'Sem', 'Subject code', 'Subject', 'R / S', 'Strength']],
      body,
      columnStyles: { 0: { cellWidth: group === 'session' ? 16 : 30 }, 1: { cellWidth: 16 }, 2: { cellWidth: 10, halign: 'right' }, 3: { cellWidth: 24 }, 5: { cellWidth: 16, halign: 'right' }, 6: { cellWidth: 18, halign: 'right' } },
      didDrawPage: () => pdfFooter(doc),
    });
    doc.save(slug(`QP_Statistics_${GROUP_LABEL[group]}`) + '.pdf');
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

// One paper row (course + paper): click to see candidates; merge course codes; ✎ edit the date.
function paperRow(p, s, withDate) {
  const isOpen = open.has(p.key);
  return `<tr class="paper${isOpen ? ' open' : ''}" data-key="${esc(p.key)}" tabindex="0" aria-expanded="${isOpen}">
      <td>${withDate ? `${weekday(p.date)} ${dmy(p.date)} ` : ''}<span class="badge ${s.toLowerCase()}">${s}</span> <span class="muted">${esc(p.time)}</span></td>
      <td><b>${esc(p.code)}</b>${p.setDate ? ' <span class="badge manual" title="Exam date set by you">Set date</span>' : p.fromTicket ? ' <span class="badge" title="Not in the time table — date taken from the hall ticket">HT date</span>' : p.borrowed ? ` <span class="badge" title="Not in the time table for this course: added on course ${esc(p.borrowed)}'s date">TT ${esc(p.borrowed)}</span>` : ''}${p.merged ? ` <span class="badge cross" title="Includes old / legacy subjects: ${esc([...p.legacyCodes].join(', '))}">Merged</span>` : ''}${p.joined ? ` <span class="badge joined" title="Course codes merged by you: ${esc(p.keys.map((k) => k.replace('|', ' · ')).join(', '))}">Courses merged</span>` : ''}</td>
      <td class="wrap">${esc(p.name)}${p.merged ? `<div class="breakdown">${schemeText(p)}</div>` : ''}</td>
      <td>${esc(joinSet(p.courses))}</td>
      <td>${esc(joinSet(p.regs))}</td>
      <td class="num">${p.R || 0}</td>
      <td class="num">${p.S || 0}</td>
      <td class="num total">${p.total}</td>
      <td class="chev"><button type="button" class="icon-btn merge-btn${p.joined ? ' on' : ''}" data-merge="${esc(p.key)}" title="Merge with other course codes" aria-label="Merge ${esc(p.code)} with other course codes"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M6 4v5a5 5 0 0 0 5 5h7m-3-3 3 3-3 3M6 20v-3"/></svg></button><button type="button" class="icon-btn" data-date="${esc(p.keys[0].split('|')[1])}" title="Edit exam date for ${esc(p.code)}">✎</button><button type="button" class="icon-btn rm-btn" data-rmpaper="${esc(p.key)}" title="Remove ${esc(p.code)} (${esc(joinSet(p.courses))}) from this session — restore it from +" aria-label="Remove ${esc(p.code)} from this session">✕</button> <span aria-hidden="true">›</span></td>
    </tr>
    ${isOpen ? `<tr class="drill"><td colspan="9">${candidates(p)}</td></tr>` : ''}`;
}
// a time-table subject nobody writes (Show 0 strength): listed, nothing to act on
const zeroRow = (r, withDate) => `<tr class="zero"><td>${withDate ? `${weekday(r.date)} ${dmy(r.date)} ` : ''}<span class="badge ${r.session.toLowerCase()}">${r.session}</span> <span class="muted">${esc(r.time)}</span></td><td><b>${esc(r.code)}</b></td><td class="wrap">${esc(r.name)}</td><td>${esc(r.course)}</td><td>${esc(r.scheme)}</td><td class="num">0</td><td class="num">0</td><td class="num total">0</td><td></td></tr>`;
const addBtn = (date, s) => `<button type="button" class="icon-btn add-btn" data-addto="${date}|${s}" title="Add subjects to ${fullDate(date)} ${s}: same code timetabled for another course, or not dated and not mapped" aria-label="Add subjects to ${s}">+</button>`;
const PAPER_HEAD = '<thead><tr><th>Session</th><th>QP Code</th><th>Subject</th><th>Course</th><th>Regl.</th><th class="num">R</th><th class="num">S</th><th class="num">QPs</th><th></th></tr></thead>';
const sessionTotals = (d, s) => `${repN(d, s) ? `<tr class="session-total rep ${s.toLowerCase()}"><td colspan="7">Repeated register numbers in ${s} (one student, two papers) <button type="button" class="info-btn" data-rep="${d.date}|${s}" title="Why is this subtracted?" aria-label="Why is this subtracted?">i</button></td><td class="num total">−${repN(d, s)}</td><td></td></tr>` : ''}
  <tr class="session-total ${s.toLowerCase()}"><td colspan="7">${addBtn(d.date, s)} ${SESSION_LABEL[s]} (${s}) QPs</td><td class="num total">${need(d, s)}</td><td></td></tr>`;

// Session / course grouping: the same paper rows (candidates, merge, ✎), grouped by date + session or by course.
function renderGrouped(days, sessions, o) {
  const today = todayIso();
  const course = $('qpCourse').value;
  const ours = o.ours ? ourCourses() : null;
  const zeros = o.zero ? qp.ttRows.filter((r) => r.n === 0 && sessions.includes(r.session) && (!course || r.course === course || r.course === commonCourse(course)) && (!ours || ours.has(r.course))) : [];
  let html = '';
  if (o.group === 'session') {
    const keys = [...new Set([...days.flatMap((d) => sessions.filter((s) => d[s].length).map((s) => d.date + '|' + s)), ...zeros.map((r) => r.date + '|' + r.session)])].sort();
    html = keys.map((k) => {
      const [date, s] = k.split('|');
      const d = days.find((x) => x.date === date) || { date, FN: [], AN: [], rep: {} };
      const z = zeros.filter((r) => r.date === date && r.session === s);
      const isPast = date < today, isOpen = dayOpen.get(k) ?? !isPast;
      return `<details class="card flush day${isPast ? ' past' : ''}" data-day="${k}"${isOpen ? ' open' : ''}>
        <summary class="day-head"><div class="day-date"><span class="dow">${weekday(date)}</span><b>${dmy(date)}</b><span class="badge ${s.toLowerCase()}">${s}</span>${isPast ? ' <span class="badge">Done</span>' : ''}</div>
          <div class="day-stats"><span class="pill ${s.toLowerCase()}"><i class="sw ${s.toLowerCase()}"></i>${s} <b>${need(d, s)}</b> QPs · ${d[s].length} paper(s)</span>${addBtn(date, s)}</div></summary>
        <div class="table-wrap"><table class="data papers">${PAPER_HEAD}<tbody>${d[s].map((p) => paperRow(p, s, false)).join('')}${z.map((r) => zeroRow(r, false)).join('')}${sessionTotals(d, s)}</tbody></table></div>
      </details>`;
    }).join('');
  } else {
    // by course: a merged row (several courses) sits under its first course
    const byCourse = new Map();
    for (const d of days) for (const s of sessions) for (const p of d[s]) {
      const c = [...p.courses].sort()[0];
      (byCourse.get(c) || byCourse.set(c, []).get(c)).push({ p, s });
    }
    for (const r of zeros) (byCourse.get(r.course) || byCourse.set(r.course, []).get(r.course)).push({ z: r });
    html = [...byCourse].sort((a, b) => a[0].localeCompare(b[0])).map(([c, list]) => {
      list.sort((a, b) => ((a.p || a.z).date + (a.s || a.z.session)).localeCompare((b.p || b.z).date + (b.s || b.z.session)));
      const k = 'c:' + c, isOpen = dayOpen.get(k) ?? true;
      const total = list.reduce((n, x) => n + (x.p ? x.p.total : 0), 0);
      return `<details class="card flush day" data-day="${k}"${isOpen ? ' open' : ''}>
        <summary class="day-head"><div class="day-date"><b>${esc(c)} – ${esc(courseName(c))}</b><span class="muted">${list.length} paper(s)</span></div>
          <div class="day-stats"><span class="pill">Candidates <b>${total}</b></span></div></summary>
        <div class="table-wrap"><table class="data papers">${PAPER_HEAD}<tbody>${list.map((x) => (x.p ? paperRow(x.p, x.s, true) : zeroRow(x.z, true))).join('')}
          <tr class="day-total"><td colspan="7">Course total</td><td class="num total">${total}</td><td></td></tr></tbody></table></div>
      </details>`;
    }).join('');
  }
  $('qpDays').innerHTML = html || '<p class="empty card">No question papers for these options.</p>';
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
          <div class="day-stats">${sessions.filter((s) => d[s].length).map((s) => `<span class="pill ${s.toLowerCase()}"><i class="sw ${s.toLowerCase()}"></i>${s} <b>${need(d, s)}</b> QPs · ${d[s].length} paper(s)</span>`).join('')}${sessions.map((s) => addBtn(d.date, s).replace('>+<', `>+ ${s}<`)).join('')}</div>
        </summary>
        <div class="table-wrap">
          <table class="data papers">
            <thead><tr><th>Session</th><th>QP Code</th><th>Subject</th><th>Course</th><th>Regl.</th><th class="num">R</th><th class="num">S</th><th class="num">QPs</th><th></th></tr></thead>
            <tbody>
              ${sessions
                .filter((s) => d[s].length)
                .map((s) => `${d[s].map((p) => paperRow(p, s, false)).join('')}${sessionTotals(d, s)}`)
                .join('')}
              <tr class="day-total"><td colspan="7">Day total</td><td class="num total">${needDays([d], sessions)}</td><td></td></tr>
            </tbody>
          </table>
        </div>
      </details>`;
    })
    .join('');
}

/* ---------- remove a subject from a session ---------- */
// The row's course + code(s) leave that date and session (QP statistics and seating); the + dialog lists them to restore.
async function setRemoved(keys, on) {
  const all = new Set(kv.get('qpRemoved', []));
  for (const k of keys) on ? all.add(k) : all.delete(k);
  await kv.set('qpRemoved', [...all]);
  render();
  for (const fn of ttListeners) fn(timetable); // seating follows
}
function removePaper(key) {
  const [date, s] = key.split('|');
  const p = qp.days.find((d) => d.date === date)?.[s].find((r) => r.key === key);
  if (!p) return;
  if (!confirm(`Remove ${p.code} ${p.name} (course ${joinSet(p.courses)}, ${p.total} candidate(s)) from ${fullDate(date)} ${s}?\n\nIt is no longer counted in this session (QP statistics and seating). Restore it from the + of this session.`)) return;
  setRemoved(p.keys.map((k) => `${k}|${date}|${s}`), true);
  toast(`${p.code} removed from ${dmy(date)} ${s}`);
}

/* ---------- "+": add subjects to a session ---------- */
let addKey = '';
function openAdd(key) {
  addKey = key;
  const [date, s] = key.split('|');
  $('addTitle').textContent = `Add to ${fullDate(date)} · ${SESSION_LABEL[s]} (${s})`;
  $('addFor').textContent = 'Pick subjects the hall tickets and time table could not place here.';
  renderAdd();
  if (!$('addDlg').open) $('addDlg').showModal();
}
function renderAdd() {
  const [date, s] = addKey.split('|');
  const gone = (qp.removedList || []).filter((r) => r.date === date && r.session === s);
  $('addRemovedWrap').hidden = !gone.length;
  $('addRemoved').innerHTML = gone.map((r) => `<tr><td>${esc(r.course)}</td><td><b>${esc(r.code)}</b></td><td class="wrap">${esc(r.name)}</td><td class="num">${r.n}</td><td class="row-actions"><button class="btn primary sm" data-restore="${esc(r.key)}">Restore</button></td></tr>`).join('');
  const cross = (qp.crossList || []).filter((c) => c.status !== 'add' && c.options.some((o) => o.date === date && o.session === s));
  $('addCross').innerHTML = cross.length
    ? cross.map((c) => { const o = c.options.find((x) => x.date === date && x.session === s); return `<tr><td>${esc(c.course)}</td><td><b>${esc(c.code)}</b></td><td class="wrap">${esc(c.name)}</td><td class="num">${c.n}</td><td class="muted">time table: course ${esc(o.course)}${c.status === 'hold' ? ' · held' : ''}</td><td class="row-actions"><button class="btn primary sm" data-addx="${esc(c.key)}" data-from="${esc(o.course)}">Add</button></td></tr>`; }).join('')
    : '<tr><td class="muted">Nothing for this session.</td></tr>';
  const q = $('addQ').value.trim().toLowerCase();
  const list = (qp.undatedList || []).filter((u) => ($('addCurrent').checked || !/^R20/i.test(u.regulation)) && (!q || `${u.course} ${u.code} ${u.name}`.toLowerCase().includes(q)));
  $('addUndated').innerHTML = list.length
    ? list.slice(0, 300).map((u) => `<tr><td>${esc(u.course)}</td><td><b>${esc(u.code)}</b></td><td class="wrap">${esc(u.name)}</td><td>${esc(u.regulation)} · sem ${u.sem}</td><td class="num">${u.n}</td><td class="row-actions"><button class="btn primary sm" data-addu="${esc(u.code)}">Add</button></td></tr>`).join('') + (list.length > 300 ? `<tr><td colspan="6" class="muted">${list.length - 300} more — search to narrow down.</td></tr>` : '')
    : '<tr><td class="muted">No subjects match.</td></tr>';
}
$('addClose').addEventListener('click', () => $('addDlg').close());
$('addDlg').addEventListener('click', (e) => { if (e.target === $('addDlg')) $('addDlg').close(); });
$('addQ').addEventListener('input', renderAdd);
$('addCurrent').addEventListener('change', renderAdd);
$('addDlg').addEventListener('click', async (e) => {
  const [date, s] = addKey.split('|');
  const back = e.target.closest('[data-restore]')?.dataset.restore;
  if (back) {
    await setRemoved([back], false);
    toast(`${back.split('|')[1]} (course ${back.split('|')[0]}) back in ${dmy(date)} ${s}`);
    return renderAdd();
  }
  const x = e.target.closest('[data-addx]');
  const u = e.target.closest('[data-addu]')?.dataset.addu;
  if (x) {
    await setCross(x.dataset.addx, { act: 'add', from: x.dataset.from });
    toast(`${x.dataset.addx.split('|')[1]} (course ${x.dataset.addx.split('|')[0]}) added to ${dmy(date)} ${s}`);
    renderAdd();
  } else if (u) {
    await addSitting(u, date, s); // hall tickets reload, then QP statistics and seating
    toast(`${u}: date set to ${dmy(date)} ${s}`);
    renderAdd();
  }
});

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
  const all = courseRows(buildQp(tickets, timetable, mapSubject, kv.get('crossCourse', {}), { removed: kv.get('qpRemoved', []) }).days, kv.get('qpMerges', []), mapSubject).find((x) => x.date === date)?.[s] || [];
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
  const rm = e.target.closest('[data-rmpaper]')?.dataset.rmpaper;
  if (rm) { e.preventDefault(); return removePaper(rm); }
  const ad = e.target.closest('[data-addto]')?.dataset.addto;
  if (ad) { e.preventDefault(); return openAdd(ad); }
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
