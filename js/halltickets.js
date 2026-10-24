// Hall tickets: upload, day-wise exam schedule dashboard and exports.
import { parseHallTickets } from './htparser.js';
import { htStore } from './store.js';
import { $, esc, loadPdfjs, loadJsPdf, toast, pref, slug, downloadCsv, bindDropzone, pdfFiles, pdfFooter } from './util.js';
import { kv, kvReady } from './kv.js';

await kvReady;

const SESSION_LABEL = { FN: 'Forenoon', AN: 'Afternoon' };
const TYPE_LABEL = { R: 'Regular', S: 'Supplementary' };
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let files = [];
let tickets = [];
let nrByReg = new Map();
let view = null; // current filtered aggregation
const open = new Set(); // expanded paper keys

/* ---------- dates ---------- */
const isoParts = (iso) => iso.split('-').map(Number);
const weekday = (iso) => { const [y, m, d] = isoParts(iso); return WEEKDAY[new Date(y, m - 1, d).getDay()]; };
const dmy = (iso) => iso.split('-').reverse().join('-');
const fullDate = (iso) => `${weekday(iso)}, ${dmy(iso)}`;
const shortDate = (iso) => { const [, m, d] = isoParts(iso); return `${d} ${MONTH[m - 1]}`; };
const startMinutes = (time) => {
  const m = String(time).match(/(\d{1,2})[.:](\d{2})\s*(am|pm)/i);
  return m ? ((+m[1] % 12) + (/pm/i.test(m[3]) ? 12 : 0)) * 60 + +m[2] : 0;
};

/* ---------- dates set by hand for subjects with no exam date on the hall ticket ---------- */
// A subject (often a lab) can have several sittings; its candidates are split into batches across
// them in course / register-number order. Each sitting can fix its batch size; the rest share what's left.
// kv "setDates": { code: { slots: [{ date: 'YYYY-MM-DD', slot: 'FN'|'AN'|'L1'|'L2'|'L3', n?: number }] } }
const SLOTS = {
  FN: { label: 'FN', session: 'FN' },
  AN: { label: 'AN', session: 'AN' },
  L1: { label: '9 – 12', session: 'FN', time: '09.00 am - 12.00 pm' },
  L2: { label: '12 – 3', session: 'AN', time: '12.00 pm - 03.00 pm' },
  L3: { label: '3 – 6', session: 'AN', time: '03.00 pm - 06.00 pm' },
};
const SLOT_ORDER = Object.keys(SLOTS);
let setDates = kv.get('setDates', {});
let batches = new Map(); // code → [{ ...sitting, regs: [regNo] }], worked out on each load
let lastNr = [];
export const setDatesBackup = () => setDates;
export const setDatesReload = () => { setDates = kv.get('setDates', {}); };
export function setDatesRestore(data) {
  if (!data || typeof data !== 'object') return;
  setDates = data;
  kv.set('setDates', setDates);
}
// Older saves held one { date, session }.
const sittings = (code) => {
  const v = setDates[code];
  const list = v?.slots || (v?.date ? [{ date: v.date, slot: v.session }] : []);
  return list.filter((x) => x.date && SLOTS[x.slot]).sort((a, b) => a.date.localeCompare(b.date) || SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
};
// Time of an FN / AN sitting: the most common hall-ticket time of that session.
function sessionTime(list, session) {
  const n = new Map();
  for (const t of list) for (const x of t.subjects) if (x.date && x.session === session && !x.setDate) n.set(x.time, (n.get(x.time) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] || (session === 'FN' ? '10.00 am - 01.00 pm' : '02.00 pm - 05.00 pm');
}
// Old / legacy subjects follow the date set on their current subject (set by the Equivalent Subjects Mapping).
let codeMap = () => null;
export function setCodeMapper(fn) { codeMap = fn; }
const dateCode = (code, course) => (sittings(code).length ? code : (() => { const m = codeMap(code, course); return m && sittings(m.code).length ? m.code : null; })());

function applySetDates(list) {
  const time = { FN: sessionTime(list, 'FN'), AN: sessionTime(list, 'AN') };
  // candidates of each dated subject, in course / register-number order
  const who = new Map();
  for (const t of list) for (const x of t.subjects) { const c = dateCode(x.code, t.courseNo); if (c) (who.get(c) || who.set(c, []).get(c)).push(t); }
  batches = new Map();
  const slotOf = new Map(); // code|regNo → sitting
  for (const [code, ts] of who) {
    const regs = [...new Set(ts.sort((a, b) => a.courseNo.localeCompare(b.courseNo) || a.regNo.localeCompare(b.regNo)).map((t) => t.regNo))];
    const sits = sittings(code);
    const fixed = sits.reduce((n, x) => n + (x.n > 0 ? x.n : 0), 0);
    const auto = sits.filter((x) => !(x.n > 0)).length;
    let left = Math.max(0, regs.length - fixed), autoLeft = auto, i = 0;
    const out = sits.map((x, k) => {
      let n;
      if (x.n > 0) n = x.n;
      else { n = Math.ceil(left / autoLeft); left -= n; autoLeft--; }
      if (k === sits.length - 1) n = Math.max(n, regs.length - i); // nobody is left without a sitting
      const part = regs.slice(i, i + n);
      i += part.length;
      return { ...x, regs: part };
    });
    batches.set(code, out);
    for (const b of out) for (const r of b.regs) slotOf.set(code + '|' + r, b);
  }
  return list.map((t) => ({
    ...t,
    subjects: t.subjects.map((x) => {
      const b = slotOf.get(dateCode(x.code, t.courseNo) + '|' + t.regNo);
      if (!b) return x;
      const sl = SLOTS[b.slot];
      return { ...x, date: b.date, session: sl.session, time: sl.time || time[sl.session], setDate: true, htDate: x.date, htSession: x.session };
    }),
  }));
}

/* ---------- data ---------- */
const listeners = [];
// Other views (QP statistics) re-render when the saved hall tickets change.
export function onTickets(fn) {
  listeners.push(fn);
  fn(tickets, examMeta());
}

// Courses on the uploaded nominal rolls (with candidate edits).
export const nrCourses = () => new Set(lastNr.map((s) => s.courseNo));

export async function htReload(nrStudents = lastNr) {
  lastNr = nrStudents;
  nrByReg = new Map(nrStudents.map((s) => [s.regNo, s]));
  files = (await htStore.all()).sort((a, b) => (a.courses[0]?.courseNo || '').localeCompare(b.courses[0]?.courseNo || '') || a.fileName.localeCompare(b.fileName));
  // If a student appears in two files, the most recently uploaded one wins.
  const map = new Map();
  for (const f of [...files].sort((a, b) => a.parsedAt.localeCompare(b.parsedAt)))
    for (const t of f.tickets) map.set(t.regNo, { ...t, fileName: f.fileName });
  // A student corrected in Candidates writes only the subjects kept there: other hall-ticket subjects are dropped.
  const edited = new Map(Object.values(kv.get('studentEdits', {})?.put || {}).map((s) => [s.regNo, s]));
  const list = [...map.values()].map((t) => {
    const e = edited.get(t.regNo);
    if (!e) return t;
    const keep = new Set(e.sems.flatMap((x) => x.codes));
    const subjects = t.subjects.filter((x) => keep.has(x.code));
    return subjects.length === t.subjects.length ? t : { ...t, subjects, dropped: t.subjects.filter((x) => !keep.has(x.code)).map((x) => x.code) };
  });
  tickets = applySetDates(list)
    .map((t) => ({ ...t, nr: nrCheck(t), issues: clashIssues(t) }))
    .sort((a, b) => a.courseNo.localeCompare(b.courseNo) || a.regNo.localeCompare(b.regNo));
  renderFiles();
  renderCourseFilter();
  renderSchedule();
  for (const fn of listeners) fn(tickets, examMeta());
}

// Clashes are checked again on every load, on the subjects and dates in use now (candidate edits, set dates):
// two papers in one session, unless both codes are the same question paper (equivalent subjects).
function clashIssues(t) {
  const issues = t.issues.filter((i) => !i.startsWith('Clash'));
  const seen = new Map();
  for (const s of t.subjects) {
    if (!s.date) continue;
    const k = s.date + ' ' + s.session;
    const paper = codeMap(s.code, t.courseNo)?.code || s.code;
    const prev = seen.get(k);
    if (!prev) seen.set(k, { code: s.code, paper });
    else if (prev.paper !== paper) issues.push(`Clash on ${dmy(s.date)} ${s.session}: ${prev.code} & ${s.code}`);
  }
  return issues;
}

// Compare the hall ticket with the student's nominal roll entry (name, course, subject codes), when one is saved.
// Nominal roll names carry a status tag such as "(CURRENT)"; compare letters only, without it.
const normName = (n) => String(n || '').toUpperCase().replace(/\([^)]*\)/g, '').replace(/[^A-Z]/g, '');
function nrCheck(t) {
  const s = nrByReg.get(t.regNo);
  if (!s) return { status: 'none' };
  const ht = t.subjects.map((x) => x.code);
  const nr = s.sems.flatMap((x) => x.codes);
  const missing = nr.filter((c) => !ht.includes(c));
  const extra = ht.filter((c) => !nr.includes(c));
  const name = normName(s.name) !== normName(t.name) ? s.name : '';
  const course = s.courseNo !== t.courseNo ? s.courseNo : '';
  return missing.length || extra.length || name || course ? { status: 'diff', missing, extra, name, course } : { status: 'match' };
}

/* ---------- upload ---------- */
async function handleFiles(fileList) {
  const list = pdfFiles(fileList);
  if (!list.length) return toast('Please choose PDF files');
  const box = $('htProgress');
  box.hidden = false;
  box.innerHTML = '';
  let pdfjs;
  try {
    pdfjs = await loadPdfjs();
  } catch {
    box.innerHTML = '<div class="progress-item"><span class="name">Could not load the PDF reader. Check your internet connection and try again.</span></div>';
    return;
  }
  let ok = 0;
  for (const f of list) {
    const row = document.createElement('div');
    row.className = 'progress-item';
    row.innerHTML = `<span class="name">${esc(f.name)}</span><span class="msg">Reading…</span>`;
    box.appendChild(row);
    try {
      const rec = await parseHallTickets(pdfjs, new Uint8Array(await f.arrayBuffer()), f.name);
      if (!rec.tickets.length) throw new Error('No hall tickets found. Is this a hall ticket PDF?');
      await htStore.put(rec);
      ok++;
      const bad = rec.tickets.filter((t) => !t.verified);
      const problems = [...rec.issues, ...bad.slice(0, 5).map((t) => `${t.regNo} ${t.name}: ${t.issues.join('; ')}`)];
      if (bad.length > 5) problems.push(`…and ${bad.length - 5} more`);
      const subj = rec.tickets.reduce((n, t) => n + t.subjects.length, 0);
      row.innerHTML = `<span class="name">${esc(f.name)}</span>
        <span class="msg">${esc(rec.courses.map((c) => c.courseNo).join(', '))} · ${rec.tickets.length} tickets · ${subj} subjects</span>
        ${problems.length ? `<span class="badge warn">${problems.length} issue(s)</span><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '<span class="badge ok">Verified</span>'}`;
    } catch (e) {
      console.error(e);
      row.innerHTML = `<span class="name">${esc(f.name)}</span><span class="badge warn">Failed</span><ul><li>${esc(e.message || e)}</li></ul>`;
    }
  }
  await htReload([...nrByReg.values()]);
  const probs = problemRows();
  const sum = $('htSummary');
  const added = tickets.filter((t) => list.some((f) => f.name === t.fileName));
  sum.className = 'upload-summary ' + (!ok ? 'bad' : probs.length ? 'warn' : 'ok');
  sum.innerHTML = ok
    ? `<b>${ok === list.length ? '✓ Hall tickets uploaded successfully.' : `⚠ ${ok} of ${list.length} file(s) uploaded.`}</b>
       <span>Hall tickets read: <b>${added.length.toLocaleString('en-IN')}</b></span>
       <span>${nrByReg.size ? `Cross-checked with the nominal roll: <b>${added.filter((t) => t.nr.status === 'match').length}</b> match${probs.length ? ` · <a href="#probCard">${probs.length} difference(s) / mismatch(es) listed below</a>` : ' · no mismatches'}` : 'No nominal roll saved yet, so nothing to cross-check. Upload nominal rolls first.'}</span>`
    : '<b>✕ No hall ticket could be read.</b> <span>See the messages below.</span>';
  sum.hidden = false;
  toast(`${ok} of ${list.length} file(s) saved`);
}

bindDropzone($('htDropzone'), $('htFileInput'), handleFiles);

function nrBadge(list) {
  const n = { match: 0, diff: 0, none: 0 };
  for (const t of list) n[t.nr.status]++;
  if (n.none === list.length) return '<span class="muted">No nominal roll saved</span>';
  const parts = [];
  if (n.match) parts.push(`<span class="badge ok">${n.match} match</span>`);
  if (n.diff) {
    const tip = list.filter((t) => t.nr.status === 'diff').map((t) => `${t.regNo}: ${[t.nr.missing.length ? 'not on ticket ' + t.nr.missing.join(', ') : '', t.nr.extra.length ? 'not in roll ' + t.nr.extra.join(', ') : ''].filter(Boolean).join('; ')}`).join('\n');
    parts.push(`<button class="badge warn link" data-prob="${esc(list[0].courseNo)}" title="${esc(tip)}">${n.diff} differ</button>`);
  }
  if (n.none) parts.push(`<span class="badge" title="These students are not in any saved nominal roll">${n.none} not in roll</span>`);
  return parts.join(' ');
}

function renderFiles() {
  $('htEmpty').hidden = files.length > 0;
  $('htBody').innerHTML = files
    .map((f) => {
      const merged = tickets.filter((t) => t.fileName === f.fileName);
      const bad = f.tickets.filter((t) => !t.verified);
      const subs = f.tickets.flatMap((t) => t.subjects);
      return `<tr>
        <td class="wrap">${esc(f.fileName)}</td>
        <td class="wrap">${f.courses.map((c) => `<b>${esc(c.courseNo)}</b> ${esc(c.courseName)}`).join('<br>')}</td>
        <td class="num">${f.tickets.length}</td>
        <td class="num">${subs.length}</td>
        <td class="num">${subs.filter((s) => s.date).length}</td>
        <td>${bad.length + f.issues.length ? `<button class="badge warn link" data-prob="${esc(f.courses[0]?.courseNo || '')}" title="${esc([...f.issues, ...bad.map((t) => t.regNo + ': ' + t.issues.join('; '))].join('\n'))}">${bad.length + f.issues.length} issue(s)</button>` : '<span class="badge ok">All verified</span>'}</td>
        <td>${nrBadge(merged)}</td>
        <td class="muted">${esc(f.meta.generatedOn || '')}</td>
        <td><button class="icon-btn" data-del="${esc(f.fileName)}" title="Remove">✕</button></td>
      </tr>`;
    })
    .join('');
  const entries = tickets.flatMap((t) => t.subjects);
  const dated = entries.filter((s) => s.date);
  $('htStats').innerHTML = files.length
    ? [
        [files.length, 'Files'],
        [new Set(tickets.map((t) => t.courseNo)).size, 'Courses'],
        [tickets.length, 'Students'],
        [new Set(dated.map((s) => s.date)).size, 'Exam days'],
        [dated.length, 'Timetabled exams'],
        [entries.length - dated.length, 'Not timetabled'],
      ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('')
    : '';
  renderProblems();
}

/* ---------- differences & issues ---------- */
const subjLabel = (s) => `${s.code} ${s.name} (Sem ${s.sem} ${s.type}, ${s.date ? `${dmy(s.date)} ${s.session}` : 'no exam date'})`;

// One row per problem: ticket issues (e.g. clashes) and nominal roll differences.
function problemRows() {
  const rows = [];
  const rollCourses = new Set([...nrByReg.values()].map((s) => s.courseNo));
  const ticketRegs = new Set(tickets.map((t) => t.regNo));
  const ticketCourses = new Set(tickets.map((t) => t.courseNo));
  for (const t of tickets) {
    for (const i of t.issues) rows.push({ t, kind: 'Ticket issue', items: [i] });
    // a candidate with a hall ticket but missing from the nominal roll of that course
    if (t.nr.status === 'none' && rollCourses.has(t.courseNo)) rows.push({ t, kind: 'Hall ticket, not in nominal roll', items: ['No nominal roll entry for this register number'] });
    if (t.nr.status !== 'diff') continue;
    if (t.nr.name) rows.push({ t, kind: 'Name differs', items: [`Hall ticket: ${t.name}`, `Nominal roll: ${t.nr.name}`] });
    if (t.nr.course) rows.push({ t, kind: 'Course differs', items: [`Hall ticket: ${t.courseNo}`, `Nominal roll: ${t.nr.course}`] });
    if (t.nr.extra.length)
      rows.push({ t, kind: 'On ticket, not in nominal roll', items: t.subjects.filter((s) => t.nr.extra.includes(s.code)).map(subjLabel) });
    if (t.nr.missing.length) rows.push({ t, kind: 'In nominal roll, not on ticket', items: t.nr.missing });
  }
  // candidates in a nominal roll whose course has hall tickets, but who have no ticket
  for (const st of nrByReg.values())
    if (ticketCourses.has(st.courseNo) && !ticketRegs.has(st.regNo))
      rows.push({ t: st, kind: 'In nominal roll, no hall ticket', items: [`${st.subjectCount} subject(s): ${st.sems.flatMap((x) => x.codes).join(', ')}`] });
  return rows;
}

function renderProblems() {
  const all = problemRows();
  $('probCard').hidden = !all.length;
  if (!all.length) return;
  const counts = new Map();
  for (const r of all) counts.set(r.t.courseNo, (counts.get(r.t.courseNo) || 0) + 1);
  const sel = $('probCourse');
  const keep = sel.value;
  const opts = [['', `All courses (${all.length})`], ...[...counts].sort().map(([c, n]) => [c, `${c} (${n})`])];
  sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  sel.value = opts.some(([v]) => v === keep) ? keep : '';
  $('probBody').innerHTML = all
    .filter((r) => !sel.value || r.t.courseNo === sel.value)
    .map((r) => `<tr>
      <td>${esc(r.t.regNo)}</td>
      <td class="wrap">${esc(r.t.name)}</td>
      <td>${esc(r.t.courseNo)}</td>
      <td><span class="badge warn">${esc(r.kind)}</span></td>
      <td class="wrap codes">${r.items.map(esc).join('<br>')}</td>
    </tr>`)
    .join('');
}

$('probCourse').addEventListener('change', renderProblems);

function problemExport() {
  const course = $('probCourse').value;
  return { course, rows: problemRows().filter((r) => !course || r.t.courseNo === course), name: slug(`HallTicket_Differences_${course || 'AllCourses'}`) };
}

$('probCsvBtn').addEventListener('click', () => {
  const { rows, name } = problemExport();
  downloadCsv(name + '.csv', ['Reg No', 'Student Name', 'Course', 'Problem', 'Subjects'], rows.map((r) => [r.t.regNo, r.t.name, r.t.courseNo, r.kind, r.items.join('; ')]));
});

$('probPdfBtn').addEventListener('click', (e) =>
  withPdf(e.currentTarget, (jsPDF) => {
    const { course, rows, name } = problemExport();
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const courseName = tickets.find((t) => t.courseNo === course)?.courseName;
    const kinds = new Map();
    for (const r of rows) kinds.set(r.kind, (kinds.get(r.kind) || 0) + 1);
    const y = pdfHeader(doc, 'Hall Ticket Differences & Issues', [
      ['Course', course ? `${course} – ${courseName || ''}` : 'All courses'],
      ['Students', String(new Set(rows.map((r) => r.t.regNo)).size)],
      ['Problems', [...kinds].map(([k, n]) => `${k}: ${n}`).join('   ·   ')],
    ]);
    doc.autoTable({
      ...TABLE_STYLE,
      startY: y,
      head: [['S.No', 'Reg No', 'Student Name', 'Course', 'Problem', 'Subjects']],
      body: rows.map((r, i) => [i + 1, r.t.regNo, r.t.name, r.t.courseNo, r.kind, r.items.join('\n')]),
      columnStyles: { 0: { cellWidth: 12, halign: 'right' }, 1: { cellWidth: 22 }, 2: { cellWidth: 45 }, 3: { cellWidth: 16 }, 4: { cellWidth: 42, fontStyle: 'bold', textColor: [180, 83, 9] } },
      didDrawPage: () => pdfFooter(doc),
    });
    doc.save(name + '.pdf');
  }),
);

$('htBody').addEventListener('click', async (e) => {
  const prob = e.target.closest('[data-prob]');
  if (prob) {
    $('probCourse').value = prob.dataset.prob;
    renderProblems();
    return $('probCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  const f = e.target.closest('[data-del]')?.dataset.del;
  if (!f || !confirm(`Remove "${f}" from saved hall tickets?`)) return;
  await htStore.remove(f);
  await htReload([...nrByReg.values()]);
});

$('htClearBtn').addEventListener('click', async () => {
  if (!files.length || !confirm('Delete all saved hall tickets from this browser?')) return;
  await htStore.clear();
  $('htProgress').hidden = true;
  await htReload([...nrByReg.values()]);
});

/* ---------- schedule: aggregation ---------- */
function renderCourseFilter() {
  const courses = new Map();
  for (const t of tickets) {
    const c = courses.get(t.courseNo) || { name: t.courseName, n: 0 };
    c.n++;
    courses.set(t.courseNo, c);
  }
  const sel = $('schCourse');
  const keep = sel.value || pref.get('schCourse');
  const opts = [['', `All courses (${tickets.length})`], ...[...courses].map(([no, c]) => [no, `${no} – ${c.name} (${c.n})`])];
  sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  sel.value = opts.some(([v]) => v === keep) ? keep : '';
}

function filters() {
  return {
    course: $('schCourse').value,
    type: $('schType').value,
    session: $('schSession').value,
    q: $('schSearch').value.trim().toLowerCase(),
  };
}

function aggregate({ course, type, session, q }) {
  const papers = new Map();
  const undated = new Map();
  const studentSet = new Set();
  let clashes = 0;
  for (const t of tickets) {
    if (course && t.courseNo !== course) continue;
    if (q && !t.name.toLowerCase().includes(q) && !t.regNo.toLowerCase().includes(q)) continue;
    let any = false;
    for (const s of t.subjects) {
      if (type && s.type !== type) continue;
      if (!s.date || s.setDate) {
        const u = undated.get(s.code) || { code: s.code, name: s.name, courses: new Set(), sems: new Set(), regs: new Set(), R: 0, S: 0, list: [] };
        u.courses.add(t.courseNo); u.sems.add(s.sem); u.regs.add(s.regulation); u[s.type] = (u[s.type] || 0) + 1; u.list.push({ t, s });
        undated.set(s.code, u);
        any = true;
        if (!s.date) continue;
      }
      if (session && s.session !== session) continue;
      const key = `${s.date}|${s.session}|${s.time}|${s.code}`;
      const p = papers.get(key) || { key, date: s.date, session: s.session, time: s.time, code: s.code, name: s.name, setDate: !!s.setDate, courses: new Set(), sems: new Set(), regs: new Set(), R: 0, S: 0, list: [] };
      p.courses.add(t.courseNo); p.sems.add(s.sem); p.regs.add(s.regulation); p[s.type] = (p[s.type] || 0) + 1; p.list.push({ t, s });
      papers.set(key, p);
      any = true;
    }
    if (any) studentSet.add(t.regNo);
    if (t.issues.some((i) => i.startsWith('Clash'))) clashes++;
  }
  const order = (a, b) => a.date.localeCompare(b.date) || startMinutes(a.time) - startMinutes(b.time) || a.code.localeCompare(b.code, undefined, { numeric: true });
  const list = [...papers.values()].sort(order);
  const days = [];
  for (const p of list) {
    let d = days[days.length - 1];
    if (!d || d.date !== p.date) days.push((d = { date: p.date, papers: [], FN: new Set(), AN: new Set() }));
    d.papers.push(p);
    for (const { t } of p.list) d[p.session]?.add(t.regNo);
  }
  const undatedList = [...undated.values()].sort((a, b) => Math.min(...a.sems) - Math.min(...b.sems) || a.code.localeCompare(b.code, undefined, { numeric: true }));
  return { papers: list, days, undated: undatedList, students: studentSet.size, clashes };
}

/* ---------- schedule: render ---------- */
function renderSchedule() {
  const f = filters();
  pref.set('schCourse', f.course);
  view = aggregate(f);
  const { days, papers, undated } = view;
  const has = tickets.length > 0;

  $('schChartCard').hidden = !days.length;
  $('schUndatedBox').hidden = !undated.length;
  const empty = $('schEmpty');
  empty.hidden = days.length > 0;
  empty.textContent = has ? 'No timetabled exams match these filters.' : 'No hall tickets yet. Upload hall ticket PDFs in the Hall Tickets tab.';
  for (const id of ['schCsvBtn', 'schPdfBtn', 'schListsBtn']) $(id).disabled = !papers.length;

  const courseOpt = $('schCourse').selectedOptions[0];
  $('schContext').textContent = [
    f.course ? courseOpt.textContent.replace(/\s*\(\d+\)$/, '') : 'All courses',
    f.type ? TYPE_LABEL[f.type] : '',
    f.session ? SESSION_LABEL[f.session] : '',
    f.q ? `Student “${$('schSearch').value.trim()}”` : '',
  ].filter(Boolean).join(' · ');

  renderKpis(has);
  renderChart();
  renderDays();
  renderUndated();
}

function renderKpis(has) {
  const { days, papers, undated, students, clashes } = view;
  if (!has) return ($('schKpis').innerHTML = '');
  const scripts = papers.reduce((n, p) => n + p.list.length, 0);
  let peak = null;
  for (const d of days) for (const s of ['FN', 'AN']) if (d[s].size && (!peak || d[s].size > peak.n)) peak = { d, s, n: d[s].size };
  const range = days.length ? `${shortDate(days[0].date)} – ${shortDate(days[days.length - 1].date)}` : '—';
  const tiles = [
    { v: students, l: 'Students', sub: `${new Set(tickets.map((t) => t.courseNo)).size} course(s) loaded` },
    { v: days.length, l: 'Exam days', sub: range },
    { v: papers.length, l: 'Exam papers', sub: `${new Set(papers.map((p) => p.code)).size} subject codes` },
    { v: scripts, l: 'Answer scripts', sub: `${papers.reduce((n, p) => n + (p.R || 0), 0)} regular · ${papers.reduce((n, p) => n + (p.S || 0), 0)} supply` },
    { v: peak ? peak.n : '—', l: 'Busiest session', sub: peak ? `${weekday(peak.d.date)} ${shortDate(peak.d.date)} · ${peak.s}` : '' },
    (() => { const left = undated.filter((u) => !sittings(u.code).length); return { v: left.reduce((n, u) => n + u.list.length, 0), l: 'Not timetabled', sub: `${left.length} subjects (practicals etc.)${undated.length > left.length ? ` · ${undated.length - left.length} dated by you` : ''}` }; })(),
    clashes
      ? { v: clashes, l: 'Timetable clashes', sub: 'students with 2 exams in one session', warn: true }
      : { v: '0', l: 'Timetable clashes', sub: 'no student has 2 exams in one session', ok: true },
  ];
  $('schKpis').innerHTML = tiles
    .map((t) => `<div class="kpi${t.warn ? ' warn' : ''}${t.ok ? ' ok' : ''}"><span class="l">${t.l}</span><b>${t.v}</b><span class="sub">${esc(t.sub)}</span></div>`)
    .join('');
}

function niceMax(n) {
  if (n <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(n));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((v) => v >= n);
}

function renderChart() {
  const { days } = view;
  if (!days.length) return;
  const max = niceMax(Math.max(...days.map((d) => d.FN.size + d.AN.size)));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  const total = days.reduce((n, d) => n + d.FN.size + d.AN.size, 0);
  $('schChartNote').textContent = `Unique students per session · ${days.length} exam day(s) · tap a bar to jump to that day`;
  const chart = $('schChart');
  chart.style.setProperty('--cols', days.length);
  chart.setAttribute('aria-label', `Bar chart of students writing on each of ${days.length} exam days, ${total} student-sessions in total. The day-wise list below has the same numbers.`);
  chart.innerHTML = `
    <div class="axis">${ticks.map((v) => `<span style="bottom:${(v / max) * 100}%">${v}</span>`).join('')}</div>
    <div class="plot">
      ${ticks.map((v) => `<i class="grid" style="bottom:${(v / max) * 100}%"></i>`).join('')}
      ${days
        .map((d, i) => {
          const fn = d.FN.size, an = d.AN.size;
          return `<button class="bar" data-day="${i}" aria-label="${fullDate(d.date)}: ${fn} forenoon, ${an} afternoon">
            <span class="stack" style="height:${((fn + an) / max) * 100}%">
              ${an ? `<span class="seg an" style="flex:${an}" data-s="AN"></span>` : ''}
              ${fn ? `<span class="seg fn" style="flex:${fn}" data-s="FN"></span>` : ''}
              <span class="val">${fn + an}</span>
            </span>
          </button>`;
        })
        .join('')}
    </div>
    <div class="xlabels">${days.map((d) => `<span><b>${shortDate(d.date)}</b>${weekday(d.date)}</span>`).join('')}</div>`;
}

const chartEl = $('schChart');
chartEl.addEventListener('mousemove', (e) => {
  const bar = e.target.closest('.bar');
  const tip = $('schTip');
  if (!bar) return (tip.hidden = true);
  const d = view.days[+bar.dataset.day];
  const focus = e.target.closest('.seg')?.dataset.s;
  const n = (s) => d.papers.filter((p) => p.session === s).length;
  tip.innerHTML = `<b>${fullDate(d.date)}</b>
    ${['FN', 'AN'].map((s) => `<div class="${focus === s ? 'on' : ''}"><i class="sw ${s.toLowerCase()}"></i>${SESSION_LABEL[s]}: <b>${d[s].size}</b> students · ${n(s)} paper(s)</div>`).join('')}`;
  tip.hidden = false;
  const card = $('schChartCard').getBoundingClientRect();
  const x = Math.min(e.clientX - card.left + 14, card.width - tip.offsetWidth - 8);
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = e.clientY - card.top + 14 + 'px';
});
chartEl.addEventListener('mouseleave', () => ($('schTip').hidden = true));
chartEl.addEventListener('click', (e) => {
  const bar = e.target.closest('.bar');
  if (bar) document.getElementById('day-' + view.days[+bar.dataset.day].date)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

const joinSet = (s) => [...s].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })).join(', ');

function studentTable(p) {
  return `<table class="data inner">
    <thead><tr><th class="num">S.No</th><th>Reg No</th><th>Student Name</th><th>Course</th><th class="num">Sem</th><th>Type</th><th>Regl.</th></tr></thead>
    <tbody>${p.list
      .map(({ t, s }, i) => `<tr><td class="num">${i + 1}</td><td>${esc(t.regNo)}</td><td>${esc(t.name)}</td><td>${esc(t.courseNo)}</td><td class="num">${s.sem}</td><td><span class="badge ${s.type.toLowerCase()}" title="${TYPE_LABEL[s.type] || ''}">${esc(s.type)}</span></td><td>${esc(s.regulation)}</td></tr>`)
      .join('')}</tbody></table>`;
}

function renderDays() {
  $('schDays').innerHTML = view.days
    .map((d, i) => {
      const papersBySession = (s) => d.papers.filter((p) => p.session === s).length;
      return `<section class="card flush day" id="day-${d.date}">
        <header class="day-head">
          <div class="day-date"><span class="dow">${weekday(d.date)}</span><b>${dmy(d.date)}</b><span class="muted">Day ${i + 1}</span></div>
          <div class="day-stats">
            ${['FN', 'AN'].filter((s) => d[s].size).map((s) => `<span class="pill ${s.toLowerCase()}"><i class="sw ${s.toLowerCase()}"></i>${s} <b>${d[s].size}</b> students · ${papersBySession(s)} paper(s)</span>`).join('')}
          </div>
        </header>
        <div class="table-wrap">
          <table class="data papers">
            <thead><tr><th>Session</th><th>Time</th><th>Subject Code</th><th>Subject Name</th><th>Course</th><th class="num">Sem</th><th>Regl.</th><th class="num">R</th><th class="num">S</th><th class="num">Students</th><th></th></tr></thead>
            <tbody>${d.papers
              .map((p) => {
                const isOpen = open.has(p.key);
                return `<tr class="paper${isOpen ? ' open' : ''}" data-key="${esc(p.key)}" tabindex="0" aria-expanded="${isOpen}">
                  <td><span class="badge ${p.session.toLowerCase()}">${p.session}</span></td>
                  <td class="muted">${esc(p.time)}</td>
                  <td><b>${esc(p.code)}</b>${p.setDate ? ' <span class="badge manual" title="Exam date set by you">Set date</span>' : ''}</td>
                  <td class="wrap">${esc(p.name)}</td>
                  <td>${esc(joinSet(p.courses))}</td>
                  <td class="num">${esc(joinSet(p.sems))}</td>
                  <td>${esc(joinSet(p.regs))}</td>
                  <td class="num">${p.R || 0}</td>
                  <td class="num">${p.S || 0}</td>
                  <td class="num total">${p.list.length}</td>
                  <td class="chev" aria-hidden="true">›</td>
                </tr>
                ${isOpen ? `<tr class="drill"><td colspan="11">
                  <div class="drill-head"><span class="muted">${p.list.length} student(s) writing ${esc(p.code)} on ${fullDate(p.date)} ${p.session}</span>
                    <span class="actions"><button class="btn ghost sm" data-csv="${esc(p.key)}">CSV</button><button class="btn ghost sm" data-pdf="${esc(p.key)}">PDF</button></span></div>
                  ${studentTable(p)}</td></tr>` : ''}`;
              })
              .join('')}
              <tr class="day-total"><td colspan="9">Day total</td><td class="num total">${d.papers.reduce((n, p) => n + p.list.length, 0)}</td><td></td></tr>
            </tbody>
          </table>
        </div>
      </section>`;
    })
    .join('');
}

function renderUndated() {
  const { undated } = view;
  const set = undated.filter((u) => sittings(u.code).length).length;
  $('schUndatedNote').textContent = undated.length ? `· ${undated.length} subjects · ${undated.reduce((n, u) => n + u.list.length, 0)} student entries${set ? ` · ${set} with dates set` : ''}` : '';
  $('schUndatedBody').innerHTML = undated
    .map((u) => `<tr data-code="${esc(u.code)}"${sittings(u.code).length ? ' class="has-date"' : ''}><td><b>${esc(u.code)}</b></td><td class="wrap">${esc(u.name)}</td><td>${esc(joinSet(u.courses))}</td><td class="num">${esc(joinSet(u.sems))}</td><td>${esc(joinSet(u.regs))}</td><td class="num">${u.R || 0}</td><td class="num">${u.S || 0}</td><td class="num total">${u.list.length}</td>
        <td class="set-date">${sittingsCell(u.code)}</td></tr>`)
    .join('');
}

// Date · session · batch size rows for one subject, plus an empty row that adds another sitting.
function sittingsCell(code) {
  const slotSelect = (v) => `<select class="select-sm" data-f="slot" aria-label="Session">${SLOT_ORDER.map((k) => `<option value="${k}"${k === v ? ' selected' : ''}>${SLOTS[k].label}</option>`).join('')}</select>`;
  const sits = sittings(code);
  const done = batches.get(code) || [];
  const rows = sits.map((x, k) => {
    const b = done[k];
    const range = b?.regs.length ? `${b.regs.length} · ${b.regs[0]}${b.regs.length > 1 ? `–${b.regs[b.regs.length - 1]}` : ''}` : '0 students';
    return `<div class="sit" data-k="${k}"><input type="date" class="select-sm" data-f="date" value="${x.date}" aria-label="Date" />${slotSelect(x.slot)}<input type="number" class="select-sm n" data-f="n" min="1" value="${x.n > 0 ? x.n : ''}" placeholder="auto" title="Students in this batch (empty = share the rest equally)" aria-label="Batch size" /><span class="muted batch">${range}</span><button type="button" class="icon-btn" data-remove title="Remove this sitting">✕</button></div>`;
  });
  const next = sits.length ? SLOT_ORDER[(SLOT_ORDER.indexOf(sits[sits.length - 1].slot) + 1) % SLOT_ORDER.length] : 'FN';
  rows.push(`<div class="sit new" data-k="new"><input type="date" class="select-sm" data-f="date" aria-label="Date for a${sits.length ? 'nother' : ''} sitting" />${slotSelect(next)}<span class="muted batch">${sits.length ? '+ another sitting' : 'set a date'}</span></div>`);
  return rows.join('');
}

// Edit / override the exam date of any subject (QP Statistics ✎).
export function openDateEditor(code) {
  const own = tickets.flatMap((t) => t.subjects.filter((x) => x.code === code || codeMap(x.code, t.courseNo)?.code === code));
  const name = (own.find((x) => x.code === code) || own[0])?.name || '';
  const orig = [...new Set(own.map((x) => (x.setDate ? x.htDate : x.date) ? `${dmy(x.setDate ? x.htDate : x.date)} ${x.setDate ? x.htSession : x.session}` : 'no date'))];
  $('dateTitle').textContent = `Exam date · ${code}`;
  $('dateFor').innerHTML = `<b>${esc(name)}</b> · ${own.length} candidate(s) · on the hall ticket: ${esc(orig.join(', ') || 'no date')}. Set one or more sittings below; your date replaces the hall ticket / time table date everywhere.`;
  $('dateBody').innerHTML = `<tr data-code="${esc(code)}"><td class="set-date">${sittingsCell(code)}</td></tr>`;
  $('dateReset').hidden = !sittings(code).length;
  if (!$('dateDlg').open) $('dateDlg').showModal();
}
$('dateClose').addEventListener('click', () => $('dateDlg').close());
$('dateDone').addEventListener('click', () => $('dateDlg').close());
$('dateReset').addEventListener('click', () => {
  const code = $('dateBody').querySelector('tr[data-code]')?.dataset.code;
  if (!code) return;
  saveSetDates(code, []);
  toast(`${code}: back to the hall ticket / time table date`);
});

// Setting a date moves the subject into the day-wise schedule, QP statistics and seating; it stays editable here.
async function saveSetDates(code, list) {
  if (list.length) setDates[code] = { slots: list };
  else delete setDates[code];
  kv.set('setDates', setDates).then((ok) => ok || toast('Could not save the date in this browser'));
  await htReload();
  if ($('dateDlg').open) openDateEditor(code);
}
// Read every sitting of a row back from its inputs.
function rowSittings(row) {
  return [...row.querySelectorAll('.sit')]
    .map((el) => ({ date: el.querySelector('[data-f="date"]').value, slot: el.querySelector('[data-f="slot"]').value, n: +(el.querySelector('[data-f="n"]')?.value || 0) || undefined }))
    .filter((x) => x.date);
}
const onSitChange = (e) => {
  const row = e.target.closest('tr[data-code]');
  if (!row || (e.target.closest('.sit.new') && e.target.dataset.f !== 'date')) return; // the new row only counts once it has a date
  const list = rowSittings(row);
  saveSetDates(row.dataset.code, list);
  toast(`${row.dataset.code}: ${list.length ? `${list.length} sitting(s) set` : 'dates removed'}`);
};
const onSitRemove = (e) => {
  const sit = e.target.closest('[data-remove]')?.closest('.sit');
  if (!sit) return;
  const row = sit.closest('tr[data-code]');
  sit.remove();
  saveSetDates(row.dataset.code, rowSittings(row));
  toast(`${row.dataset.code}: sitting removed`);
};
for (const id of ['schUndatedBody', 'dateBody']) {
  $(id).addEventListener('change', onSitChange);
  $(id).addEventListener('click', onSitRemove);
}

$('schDays').addEventListener('click', (e) => {
  const csv = e.target.closest('[data-csv]')?.dataset.csv;
  const pdf = e.target.closest('[data-pdf]')?.dataset.pdf;
  if (csv) return exportListsCsv([view.papers.find((p) => p.key === csv)]);
  if (pdf) return exportListsPdf([view.papers.find((p) => p.key === pdf)], e.target.closest('button'));
  const row = e.target.closest('tr.paper');
  if (!row) return;
  const k = row.dataset.key;
  open.has(k) ? open.delete(k) : open.add(k);
  renderDays();
});
$('schDays').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr.paper')) {
    e.preventDefault();
    const k = e.target.dataset.key;
    open.has(k) ? open.delete(k) : open.add(k);
    renderDays();
    document.querySelector(`tr.paper[data-key="${CSS.escape(k)}"]`)?.focus();
  }
});

['schCourse', 'schType', 'schSession'].forEach((id) => $(id).addEventListener('change', renderSchedule));
$('schSearch').addEventListener('input', renderSchedule);

/* ---------- exports ---------- */
function scopeName(prefix, ext) {
  const f = filters();
  return slug([prefix, f.course || 'AllCourses', f.type, f.session, f.q && $('schSearch').value.trim()].filter(Boolean).join('_')) + '.' + ext;
}

function scopeInfo() {
  const f = filters();
  const courseOpt = $('schCourse').selectedOptions[0];
  return [
    ['Course', f.course ? courseOpt.textContent.replace(/\s*\(\d+\)$/, '') : 'All courses'],
    ...(f.type ? [['Exam Type', TYPE_LABEL[f.type]]] : []),
    ...(f.session ? [['Session', SESSION_LABEL[f.session]]] : []),
    ...(f.q ? [['Student', $('schSearch').value.trim()]] : []),
  ];
}

const examMeta = () => files.find((f) => f.meta?.centre)?.meta || {};

$('schCsvBtn').addEventListener('click', () => {
  const header = ['Date', 'Day', 'Session', 'Time', 'Subject Code', 'Subject Name', 'Course', 'Sem', 'Regulation', 'Regular', 'Supplementary', 'Total Students'];
  const rows = view.papers.map((p) => [dmy(p.date), weekday(p.date), p.session, p.time, p.code, p.name, joinSet(p.courses), joinSet(p.sems), joinSet(p.regs), p.R || 0, p.S || 0, p.list.length]);
  downloadCsv(scopeName('Exam_Schedule', 'csv'), header, rows);
});

function exportListsCsv(papers) {
  const header = ['Date', 'Session', 'Time', 'Subject Code', 'Subject Name', 'S.No', 'Reg No', 'Student Name', 'Course', 'Sem', 'Type', 'Regulation'];
  const rows = papers.flatMap((p) => p.list.map(({ t, s }, i) => [dmy(p.date), p.session, p.time, p.code, p.name, i + 1, t.regNo, t.name, t.courseNo, s.sem, s.type, s.regulation]));
  const name = papers.length === 1 ? slug(`Students_${papers[0].code}_${dmy(papers[0].date)}_${papers[0].session}`) + '.csv' : scopeName('Student_Lists', 'csv');
  downloadCsv(name, header, rows);
}

function pdfHeader(doc, title, info) {
  const W = doc.internal.pageSize.getWidth();
  const meta = examMeta();
  let y = 14;
  doc.setFont('helvetica', 'bold').setFontSize(12.5);
  if (meta.centre) { doc.text(meta.centre, W / 2, y, { align: 'center' }); y += 6; }
  doc.setFontSize(11).text(title, W / 2, y, { align: 'center' });
  y += 5;
  if (meta.exam) { doc.setFont('helvetica', 'normal').setFontSize(9.5).text(`Board Examinations ${meta.exam}`, W / 2, y, { align: 'center' }); y += 5; }
  y += 3;
  doc.setFontSize(9.5);
  for (const [k, v] of info) {
    doc.setFont('helvetica', 'bold').text(k + ':', 14, y);
    doc.setFont('helvetica', 'normal').text(doc.splitTextToSize(String(v), W - 62), 50, y);
    y += 5;
  }
  return y + 1;
}

async function withPdf(btn, fn) {
  btn.disabled = true;
  try {
    const jsPDF = await loadJsPdf();
    await fn(jsPDF);
  } catch (e) {
    console.error(e);
    toast('PDF export failed. Check your internet connection.');
  } finally {
    btn.disabled = false;
  }
}

const TABLE_STYLE = {
  theme: 'grid',
  styles: { fontSize: 8.5, cellPadding: 1.5, valign: 'middle', lineColor: [200, 205, 215], lineWidth: 0.1 },
  headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold' },
  margin: { left: 14, right: 14, bottom: 14 },
};

$('schPdfBtn').addEventListener('click', (e) =>
  withPdf(e.currentTarget, (jsPDF) => {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const { days, papers } = view;
    const y = pdfHeader(doc, 'Day-wise Exam Schedule with Student Count', [
      ...scopeInfo(),
      ['Exam Days', `${days.length} (${dmy(days[0].date)} to ${dmy(days[days.length - 1].date)})`],
      ['Papers / Scripts', `${papers.length} papers · ${papers.reduce((n, p) => n + p.list.length, 0)} answer scripts`],
    ]);
    // Strength of a session = answer scripts in it (R + S over its papers).
    const sum = (list, k) => list.reduce((n, p) => n + (k ? p[k] || 0 : p.list.length), 0);
    const ofSession = (d, s) => d.papers.filter((p) => p.session === s);
    const SESSION_FILL = { FN: [230, 240, 251], AN: [253, 238, 231] };
    const bold = (content, extra = {}) => ({ content, styles: { fontStyle: 'bold', ...extra } });

    // 1. Session-wise strength summary, one row per day
    const fnAll = days.flatMap((d) => ofSession(d, 'FN'));
    const anAll = days.flatMap((d) => ofSession(d, 'AN'));
    doc.setFont('helvetica', 'bold').setFontSize(10.5).text('Session-wise Strength', 14, y + 3);
    doc.autoTable({
      ...TABLE_STYLE,
      startY: y + 6,
      head: [['Day', 'Date', 'FN Papers', 'FN Strength', 'AN Papers', 'AN Strength', 'Day Total']],
      body: [
        ...days.map((d, i) => {
          const fn = ofSession(d, 'FN'), an = ofSession(d, 'AN');
          return [i + 1, fullDate(d.date), fn.length || '-', bold(fn.length ? sum(fn) : '-'), an.length || '-', bold(an.length ? sum(an) : '-'), bold(sum(d.papers))];
        }),
        [bold('Total', { halign: 'right' }), '', bold(fnAll.length), bold(sum(fnAll)), bold(anAll.length), bold(sum(anAll)), bold(sum(papers))].map((c) =>
          typeof c === 'object' ? { ...c, styles: { ...c.styles, fillColor: [245, 247, 251] } } : { content: c, styles: { fillColor: [245, 247, 251] } },
        ),
      ],
      columnStyles: {
        0: { cellWidth: 12, halign: 'right' },
        2: { halign: 'right' }, 3: { halign: 'right', fillColor: SESSION_FILL.FN }, 4: { halign: 'right' }, 5: { halign: 'right', fillColor: SESSION_FILL.AN }, 6: { halign: 'right' },
      },
      didDrawPage: () => pdfFooter(doc),
    });

    // 2. Day-wise subject list, papers grouped by session with a strength row for each
    const body = [];
    days.forEach((d, i) => {
      const sess = ['FN', 'AN'].filter((s) => ofSession(d, s).length).map((s) => `${s}: ${sum(ofSession(d, s))}`).join('    ');
      body.push([{ content: `Day ${i + 1}  ·  ${fullDate(d.date)}        Strength  ${sess}`, colSpan: 9, styles: { fillColor: [232, 239, 255], fontStyle: 'bold', textColor: [24, 32, 50] } }]);
      for (const s of ['FN', 'AN']) {
        const list = ofSession(d, s);
        if (!list.length) continue;
        for (const p of list) body.push([p.session, p.time, p.code, p.name, joinSet(p.courses), joinSet(p.sems), p.R || 0, p.S || 0, bold(p.list.length)]);
        const fill = { fillColor: SESSION_FILL[s] };
        body.push([
          { content: `${SESSION_LABEL[s]} (${s}) strength`, colSpan: 6, styles: { halign: 'right', fontStyle: 'bold', ...fill } },
          bold(sum(list, 'R'), fill), bold(sum(list, 'S'), fill), bold(sum(list), fill),
        ]);
      }
      const grey = { fillColor: [245, 247, 251] };
      const split = ['FN', 'AN'].filter((s) => ofSession(d, s).length).map((s) => `${s} ${sum(ofSession(d, s))}`).join(' + ');
      body.push([
        { content: `Day total (${split})`, colSpan: 6, styles: { halign: 'right', fontStyle: 'bold', ...grey } },
        bold(sum(d.papers, 'R'), grey), bold(sum(d.papers, 'S'), grey), bold(sum(d.papers), grey),
      ]);
    });
    let listY = doc.lastAutoTable.finalY + 9;
    if (listY > doc.internal.pageSize.getHeight() - 50) {
      doc.addPage();
      listY = 16;
    }
    doc.setFont('helvetica', 'bold').setFontSize(10.5).text('Day-wise Subject List', 14, listY);
    doc.autoTable({
      ...TABLE_STYLE,
      startY: listY + 3,
      head: [['Session', 'Time', 'Code', 'Subject Name', 'Course', 'Sem', 'R', 'S', 'Total']],
      body,
      columnStyles: { 0: { cellWidth: 17 }, 1: { cellWidth: 34 }, 2: { cellWidth: 22 }, 5: { cellWidth: 11, halign: 'right' }, 6: { cellWidth: 9, halign: 'right' }, 7: { cellWidth: 9, halign: 'right' }, 8: { cellWidth: 13, halign: 'right' } },
      didDrawPage: () => pdfFooter(doc),
    });
    doc.save(scopeName('Exam_Schedule', 'pdf'));
  }),
);

function exportListsPdf(papers, btn) {
  return withPdf(btn, (jsPDF) => {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    papers.forEach((p, i) => {
      if (i) doc.addPage();
      const y = pdfHeader(doc, 'Exam Candidates List', [
        ['Date / Session', `${fullDate(p.date)}  ·  ${SESSION_LABEL[p.session]} (${p.time})`],
        ['Subject', `${p.code} – ${p.name}`],
        ['Course / Sem', `${joinSet(p.courses)} / Sem ${joinSet(p.sems)} (${joinSet(p.regs)})`],
        ['Candidates', `${p.list.length}  (Regular ${p.R || 0}, Supplementary ${p.S || 0})`],
      ]);
      doc.autoTable({
        ...TABLE_STYLE,
        startY: y,
        head: [['S.No', 'Reg No', 'Student Name', 'Course', 'Sem', 'Type', 'Signature']],
        body: p.list.map(({ t, s }, j) => [j + 1, t.regNo, t.name, t.courseNo, s.sem, s.type, '']),
        styles: { ...TABLE_STYLE.styles, fontSize: 9, cellPadding: 2.2 },
        columnStyles: { 0: { cellWidth: 13, halign: 'right' }, 1: { cellWidth: 24 }, 3: { cellWidth: 16 }, 4: { cellWidth: 12, halign: 'right' }, 5: { cellWidth: 13 }, 6: { cellWidth: 42 } },
        didDrawPage: () => pdfFooter(doc),
      });
    });
    const name = papers.length === 1 ? slug(`Students_${papers[0].code}_${dmy(papers[0].date)}_${papers[0].session}`) + '.pdf' : scopeName('Student_Lists', 'pdf');
    doc.save(name);
  });
}

$('schListsBtn').addEventListener('click', (e) => exportListsPdf(view.papers, e.currentTarget));

export { pdfHeader, withPdf, TABLE_STYLE, joinSet, dmy, fullDate, weekday, shortDate };
