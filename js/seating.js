// Seating arrangement: hall setup, seat allocation per exam date & session, and the hall-wise PDF.
// Halls and allocations are kept in this browser (IndexedDB, see kv.js) and travel with Backup/Restore.
import { buildQp } from './qpcalc.js';
import { onTickets, withPdf, dmy, fullDate, shortDate, weekday } from './halltickets.js';
import { onTimetable } from './qp.js';
import { $, esc, toast, pref, loadExcelJs, loadJsZip, download, loadJsPdf } from './util.js';
import { kv, kvReady } from './kv.js';
import { mapSubject, onEquiv } from './equiv.js';

await kvReady;

// kv keys: halls [{ id, name, cols, rows }] · plans { 'date|session': { hallId: { A1: { reg, course, code, x? } } } }
// · extras: subjects added to a session's dock by hand { 'date|session': [{ id, kind, code, name, from, cands }] }
// · customDays: exam dates added by hand (e.g. a rain-postponed exam), ISO strings
const KIND_LABEL = { cross: 'Cross-Date', unsched: 'Unscheduled', manual: 'Manual', postponed: 'Postponed' };
const SESSION_LABEL = { FN: 'Forenoon (FN)', AN: 'Afternoon (AN)' };

let halls = kv.get('halls', []);
let plans = kv.get('plans', {});
let extras = kv.get('extras', {});
let customDays = kv.get('customDays', []);
let subjects = new Map(); // every hall-ticket subject code → { code, name, courses, slots, students }
let tickets = [], timetable = null, examMeta = {};
let days = []; // [{ date, FN: [candidate], AN: [candidate] }]
let activeHall = pref.get('seatHall');
let selected = new Set(); // seat ids in the active hall

// Every change is saved straight away; the Save button saves again and confirms it.
async function save() {
  const ok = (await Promise.all([kv.set('halls', halls), kv.set('plans', plans), kv.set('extras', extras), kv.set('customDays', customDays)])).every(Boolean);
  $('seatSaveState').textContent = ok ? `Saved ${new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}` : 'Not saved';
  if (!ok) toast('Could not save the seating in this browser');
  return ok;
}
$('seatSaveBtn').addEventListener('click', async () => { if (await save()) toast('Halls and seating saved in this browser'); });

// Backup/Restore hooks (app.js).
export const seatingBackup = () => ({ halls, plans, extras, customDays });
export function seatingRestore(data) {
  if (!data || !Array.isArray(data.halls)) return;
  halls = data.halls;
  plans = data.plans || {};
  extras = data.extras || {};
  customDays = data.customDays || [];
  save();
  render();
}
// Restore of a new-format backup writes kv directly; pick the values up again.
export function seatingReload() {
  halls = kv.get('halls', []);
  plans = kv.get('plans', {});
  extras = kv.get('extras', {});
  customDays = kv.get('customDays', []);
  render();
}

/* ---------- seats ---------- */
const colName = (i) => String.fromCharCode(65 + i); // 0 → A
const seatId = (c, r) => colName(c) + (r + 1); // column letter + row number: A1…A6, B1…
const parseSeat = (id) => ({ c: id.charCodeAt(0) - 65, r: +id.slice(1) - 1 });
function seatOrder(h, order = $('seatOrder').value) {
  const out = [];
  if (order === 'row') for (let r = 0; r < h.rows; r++) for (let c = 0; c < h.cols; c++) out.push(seatId(c, r));
  else for (let c = 0; c < h.cols; c++) for (let r = 0; r < h.rows; r++) out.push(seatId(c, r));
  return out;
}
const capacity = (h) => h.cols * h.rows;
const seatRange = (h) => `${seatId(0, 0)}–${seatId(h.cols - 1, h.rows - 1)}`;

/* ---------- candidates for a date & session ---------- */
function rebuild() {
  if (!timetable) return;
  const qp = buildQp(tickets, timetable, mapSubject); // old / legacy subjects sit under their current subject code
  days = qp.days.map((d) => {
    const out = { date: d.date };
    for (const s of ['FN', 'AN']) {
      out[s] = d[s]
        .flatMap((p) => p.students.map(({ t, s }) => ({ reg: t.regNo, name: t.name, course: t.courseNo, code: p.code, type: s.type, own: s.code, subj: s.name })))
        .sort((a, b) => a.course.localeCompare(b.course) || a.code.localeCompare(b.code, undefined, { numeric: true }) || a.reg.localeCompare(b.reg));
    }
    return out;
  });
  // Search index over every subject on the hall tickets, whatever its date (or none).
  const slots = new Map();
  for (const p of qp.papers) (slots.get(p.code) || slots.set(p.code, []).get(p.code)).push({ date: p.date, session: p.session });
  subjects = new Map();
  for (const t of tickets)
    for (const x of t.subjects) {
      const e = subjects.get(x.code) || subjects.set(x.code, { code: x.code, name: x.name, courses: new Set(), slots: slots.get(x.code) || [], students: [] }).get(x.code);
      e.courses.add(t.courseNo);
      e.students.push({ reg: t.regNo, name: t.name, course: t.courseNo, code: x.code, type: x.type });
    }
  for (const e of subjects.values()) e.students.sort((a, b) => a.course.localeCompare(b.course) || a.reg.localeCompare(b.reg));
  const date = $('seatDate');
  if (days.length) {
    const last = pref.get('seatDate');
    if (!date.value) date.value = days.some((d) => d.date === last) || customDays.includes(last) ? last : days[0].date;
  }
  render();
}

onTickets((list, meta) => { tickets = list; examMeta = meta || {}; rebuild(); });
onTimetable((tt) => { timetable = tt; rebuild(); });
onEquiv(() => rebuild());

const session = () => $('seatSession').querySelector('[aria-checked="true"]').dataset.s;
const planKey = () => `${$('seatDate').value}|${session()}`;
const plan = () => plans[planKey()] || {};
// Old-scheme codes count as their current subject, so seats saved under an old code still match (and nobody is seated twice).
const candKey = (x) => x.reg + '|' + (mapSubject(x.code, x.course)?.code || x.code);
const scheduled = () => days.find((d) => d.date === $('seatDate').value)?.[session()] || [];
const sessionExtras = () => extras[planKey()] || [];
// Scheduled candidates plus those added by hand (tagged x = the extra's id), without duplicates.
function pool() {
  const base = scheduled();
  const seen = new Set(base.map(candKey));
  const out = [...base];
  for (const e of sessionExtras())
    for (const c of e.cands) if (!seen.has(candKey(c))) { seen.add(candKey(c)); out.push({ ...c, x: e.id }); }
  return out;
}
const seatedKeys = () => new Set(Object.values(plan()).flatMap((seats) => Object.values(seats).map(candKey)));
const waiting = () => { const done = seatedKeys(); return pool().filter((x) => !done.has(candKey(x))); };
// Groups never mix courses: by subject code means one group per subject code and course.
const groupOf = (x) => x.x || ($('seatGroup').value === 'code' ? `${x.code} · ${x.course}` : x.course);

// Course / subject colours tell groups apart on the grid: a hue per group, stable for the session.
function hues() {
  const keys = [...new Set(pool().map(groupOf))];
  for (const seats of Object.values(plan())) for (const x of Object.values(seats)) if (!keys.includes(groupOf(x))) keys.push(groupOf(x));
  return new Map(keys.map((k, i) => [k, Math.round((i * 137.508 + 210) % 360)]));
}

/* ---------- render ---------- */
function render() {
  if ($('seatDate').value) pref.set('seatDate', $('seatDate').value);
  if (!halls.some((h) => h.id === activeHall)) activeHall = halls[0]?.id || '';
  pref.set('seatHall', activeHall);
  renderHalls();
  renderDays();
  renderKpis();
  renderTabs();
  renderGrid();
  renderQueue();
}

function renderHalls() {
  $('hallsEmpty').hidden = halls.length > 0;
  $('hallsNote').textContent = halls.length ? `${halls.length} hall(s) · ${halls.reduce((n, h) => n + capacity(h), 0)} seats` : 'Add your halls to start';
  if (!halls.length) $('hallsBox').open = true;
  $('hallsBody').innerHTML = halls
    .map((h) => `<tr>
      <td><b>${esc(h.name)}</b></td>
      <td class="num">${h.cols} <span class="muted">(A–${colName(h.cols - 1)})</span></td>
      <td class="num">${h.rows}</td>
      <td class="num"><b>${capacity(h)}</b></td>
      <td class="muted">${seatRange(h)}</td>
      <td class="row-actions"><button class="btn ghost sm" data-edit="${esc(h.id)}">Edit</button><button class="icon-btn" data-del="${esc(h.id)}" title="Delete hall">✕</button></td>
    </tr>`)
    .join('');
  updateCap();
}

const isExamDay = (iso) => days.some((d) => d.date === iso);
function renderDays() {
  const cur = $('seatDate').value;
  const list = [...days.map((d) => ({ date: d.date, d })), ...customDays.filter((c) => !isExamDay(c)).map((date) => ({ date, custom: true }))]
    .sort((x, y) => x.date.localeCompare(y.date));
  $('seatDays').innerHTML = `<span class="muted">Exam days:</span> ${list
    .map((x) => x.custom
      ? `<span class="chip custom${x.date === cur ? ' on' : ''}"><button type="button" data-date="${x.date}" title="${fullDate(x.date)} · custom date">${weekday(x.date)} ${shortDate(x.date)}</button><button type="button" class="chip-x" data-undate="${x.date}" title="Remove this custom date" aria-label="Remove ${fullDate(x.date)}">✕</button></span>`
      : `<button type="button" class="chip${x.date === cur ? ' on' : ''}" data-date="${x.date}" title="${fullDate(x.date)} · FN ${x.d.FN.length} · AN ${x.d.AN.length}">${weekday(x.date)} ${shortDate(x.date)}</button>`)
    .join('')} <button type="button" class="chip add" id="seatAddDay" title="Add a date that is not in the time table, e.g. an exam postponed due to rain">+ Custom date</button>`;
}

function renderKpis() {
  const all = pool();
  const wait = waiting().length;
  const cap = halls.reduce((n, h) => n + capacity(h), 0);
  const seated = all.length - wait;
  const used = Object.values(plan()).reduce((n, s) => n + Object.keys(s).length, 0);
  const d = $('seatDate').value;
  $('seatKpis').innerHTML = [
    { v: all.length, l: 'Candidates this session', sub: d ? `${fullDate(d)} · ${SESSION_LABEL[session()]}` : 'Pick an exam date' },
    { v: seated, l: 'Seated', sub: all.length ? `${Math.round((seated / all.length) * 100)}% done` : '', cls: all.length && !wait ? 'ok' : '' },
    { v: wait, l: 'Waiting', sub: `Regular ${waiting().filter((x) => x.type === 'R').length} · Supplementary ${waiting().filter((x) => x.type === 'S').length}` },
    { v: `${used} / ${cap}`, l: 'Seats used', sub: `${halls.length} hall(s)`, cls: cap && wait > cap - used ? 'warn' : '' },
  ].map((t) => `<div class="kpi ${t.cls || ''}"><span class="l">${t.l}</span><b>${t.v}</b><span class="sub">${esc(t.sub)}</span></div>`).join('');
}

function renderTabs() {
  const p = plan();
  $('hallTabs').innerHTML = halls
    .map((h) => {
      const n = Object.keys(p[h.id] || {}).length;
      const on = h.id === activeHall;
      return `<button role="tab" class="hall-tab${on ? ' active' : ''}" data-hall="${esc(h.id)}" aria-selected="${on}"><b>${esc(h.name)}</b><span>${n}/${capacity(h)}</span></button>`;
    })
    .join('');
}

function renderGrid() {
  const h = halls.find((x) => x.id === activeHall);
  const grid = $('seatGrid');
  const empty = $('seatEmpty');
  const noDate = !$('seatDate').value;
  empty.hidden = !!h && !noDate;
  empty.textContent = !h ? 'Add an examination hall above to see its seats.' : 'Pick an exam date to allocate seats.';
  grid.hidden = !h || noDate;
  for (const id of ['seatSelEmpty', 'seatClearSel', 'seatClearHall']) $(id).disabled = !h || noDate;
  if (!h || noDate) { grid.innerHTML = ''; return renderSelInfo(); }
  const seats = plan()[h.id] || {};
  const hue = hues();
  const live = new Set(pool().map(candKey));
  let html = `<thead><tr><th class="corner"></th>${Array.from({ length: h.cols }, (_, c) => `<th scope="col">${colName(c)}</th>`).join('')}</tr></thead><tbody>`;
  for (let r = 0; r < h.rows; r++) {
    html += `<tr><th scope="row">${r + 1}</th>`;
    for (let c = 0; c < h.cols; c++) {
      const id = seatId(c, r);
      const x = seats[id];
      const stale = x && !x.x && !live.has(candKey(x)); // hand-added seats stay even if dismissed from the dock
      const cls = ['seat', x ? 'filled' : '', selected.has(id) ? 'sel' : '', stale ? 'stale' : ''].filter(Boolean).join(' ');
      const title = x ? `${id}: ${x.reg} · ${x.course} · ${x.code}${stale ? ' — no longer in this session' : ''}` : `${id}: empty`;
      html += `<td class="${cls}" data-seat="${id}" title="${esc(title)}"${x ? ` style="--h:${hue.get(groupOf(x)) ?? 0}"` : ''}>
        <span class="sid">${id}</span>${x ? `<b class="reg">${esc(x.reg)}</b><span class="grp">${esc(x.course)} · ${esc(x.code)}</span>` : ''}</td>`;
    }
    html += '</tr>';
  }
  grid.innerHTML = html + '</tbody>';
  renderSelInfo();
}

function renderSelInfo() {
  const h = halls.find((x) => x.id === activeHall);
  if (!h || !selected.size) {
    $('seatSelInfo').textContent = 'Click a seat, or drag across seats to select them. Shift-click extends, Ctrl-click adds.';
    return;
  }
  const seats = plan()[h.id] || {};
  const free = [...selected].filter((id) => !seats[id]).length;
  $('seatSelInfo').innerHTML = `<b>${selected.size}</b> seat(s) selected · <b>${free}</b> empty — pick a group below to fill them`;
}

// "Merge Regular + Supplementary" ticked: both types share one card per group and fill seats in one ascending
// register-number sequence. Unticked: an R and an S section, and a card fills seats with its own type only.
const TYPES = [['R', 'Regular (R)'], ['S', 'Supplementary (S)'], ['', 'Exam type not known']];
const MERGED = [['*', 'Regular + Supplementary']];
const sepRS = () => !$('seatMergeRS').checked;
const tKey = (type) => (sepRS() ? type || '' : '*');
const qKey = (x) => groupOf(x) + '|' + tKey(x.type);

function renderQueue() {
  const wait = waiting();
  const hue = hues();
  const byCode = $('seatGroup').value === 'code';
  const all = pool();
  $('seatPdfBtn').disabled = $('seatNoticeBtn').disabled = $('seatAllocBtn').disabled = $('seatPackBtn').disabled = !Object.values(plan()).some((s) => Object.keys(s).length);

  const groups = new Map(); // qKey → scheduled group
  const extraWait = new Map(); // qKey → waiting count of a hand-added subject
  for (const x of wait) {
    if (x.x) { extraWait.set(qKey(x), (extraWait.get(qKey(x)) || 0) + 1); continue; }
    const k = qKey(x);
    const g = groups.get(k) || groups.set(k, { key: k, label: groupOf(x), type: tKey(x.type), list: [], codes: new Set(), courses: new Set(), R: 0, S: 0 }).get(k);
    g.list.push(x);
    if (x.type === 'R' || x.type === 'S') g[x.type]++;
    g.codes.add(x.code);
    g.courses.add(x.course);
  }

  const extraCard = (e, type) => {
    const k = e.id + '|' + type;
    const n = extraWait.get(k) || 0;
    const total = e.cands.filter((c) => tKey(c.type) === type).length;
    return `<div class="q-wrap">
      <button type="button" class="q-item extra" data-group="${esc(k)}" style="--h:${hue.get(e.id) ?? 0}" title="${esc(`${e.code} ${e.name}
${e.from}`)}"${n ? '' : ' disabled'}>
        <span class="q-key">${esc(e.code)} <span class="badge ${e.kind}">${KIND_LABEL[e.kind]}</span></span>
        <span class="q-n">${n ? `<b>${n}</b> waiting` : 'all seated'} · ${total} total</span>
        <span class="q-sub">${esc(e.name || e.from)}</span>
      </button>
      <button type="button" class="q-remove" data-remove="${esc(e.id)}" title="Remove ${esc(e.code)} from the dock (all exam types)" aria-label="Remove ${esc(e.code)} from the dock">✕</button>
    </div>`;
  };
  const groupCard = (g) => {
    const detail = byCode ? [...g.courses].join(', ') : [...g.codes].join(', ');
    return `<button type="button" class="q-item" data-group="${esc(g.key)}" style="--h:${hue.get(g.label)}" title="${esc(`${detail}
First: ${g.list[0].reg} · Last: ${g.list[g.list.length - 1].reg}`)}">
      <span class="q-key">${esc(g.label)}</span>
      <span class="q-n"><b>${g.list.length}</b> waiting${g.type === '*' && g.R && g.S ? ` · R ${g.R} · S ${g.S}` : ''}</span>
      <span class="q-sub">${esc(byCode ? 'Course ' + detail : detail)}</span>
    </button>`;
  };

  const sections = (sepRS() ? TYPES : MERGED).map(([type, title]) => {
    const extrasHere = sessionExtras().filter((e) => e.cands.some((c) => tKey(c.type) === type));
    const groupsHere = [...groups.values()].filter((g) => g.type === type);
    if (!extrasHere.length && !groupsHere.length) return '';
    const n = wait.filter((x) => tKey(x.type) === type).length;
    const badge = type === '*' ? '<span class="badge r">R</span><span class="badge s">S</span>' : `<span class="badge ${type ? type.toLowerCase() : ''}">${type || '?'}</span>`;
    return `<section class="q-section ${type === '*' ? 'all' : type ? type.toLowerCase() : 'none'}">
      <h3>${badge} ${title} <span class="muted">${n} waiting${type === '*' ? ' · seats fill in ascending register-number order' : ''}</span></h3>
      <div class="queue">${extrasHere.map((e) => extraCard(e, type)).join('')}${groupsHere.map(groupCard).join('')}</div>
    </section>`;
  }).join('');

  $('seatQueue').innerHTML = sections || `<p class="empty">${
    !tickets.length ? 'No hall tickets yet. Upload hall ticket PDFs in the Hall Tickets tab.'
    : !$('seatDate').value ? 'Pick an exam date.'
    : !all.length ? (isExamDay($('seatDate').value) ? 'No exams in this session. Pick another date or session, or import a subject.' : 'No exams are scheduled on this custom date. Use Import / Search subject to bring in a postponed session or add subjects.')
    : 'Everyone in this session has a seat.'
  }</p>`;
}

/* ---------- halls: add / edit / delete ---------- */
function updateCap() {
  const c = +$('hallCols').value || 0, r = +$('hallRows').value || 0;
  $('hallCap').innerHTML = c > 0 && r > 0 && c <= 26 ? `<b>${c * r}</b> seats <span class="muted">(${r} × ${c} · ${seatId(0, 0)}–${seatId(c - 1, r - 1)})</span>` : '—';
}
['hallCols', 'hallRows'].forEach((id) => $(id).addEventListener('input', updateCap));

function resetForm() {
  $('hallId').value = '';
  $('hallName').value = '';
  $('hallSave').textContent = 'Add hall';
  $('hallCancel').hidden = true;
  updateCap();
}

$('hallForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('hallId').value;
  const name = $('hallName').value.trim();
  const cols = Math.min(26, Math.max(1, Math.round(+$('hallCols').value)));
  const rows = Math.min(40, Math.max(1, Math.round(+$('hallRows').value)));
  if (!name) return;
  if (halls.some((h) => h.id !== id && h.name.toLowerCase() === name.toLowerCase())) return toast(`There is already a hall called ${name}`);
  if (id) {
    const h = halls.find((x) => x.id === id);
    // Seats outside a smaller grid go back to the queue.
    const lost = Object.values(plans).reduce((n, p) => n + Object.keys(p[id] || {}).filter((s) => { const { c, r } = parseSeat(s); return c >= cols || r >= rows; }).length, 0);
    if (lost && !confirm(`${lost} allocated seat(s) fall outside the new size and will go back to the queue. Continue?`)) return;
    for (const p of Object.values(plans))
      for (const s of Object.keys(p[id] || {})) { const { c, r } = parseSeat(s); if (c >= cols || r >= rows) delete p[id][s]; }
    Object.assign(h, { name, cols, rows });
    toast(`${name} updated: ${cols * rows} seats`);
  } else {
    const h = { id: 'h' + Date.now().toString(36), name, cols, rows };
    halls.push(h);
    activeHall = h.id;
    toast(`${name} added: ${cols * rows} seats`);
  }
  selected.clear();
  save();
  resetForm();
  // Suggest the next name: LH1 → LH2.
  const m = name.match(/^(.*?)(\d+)$/);
  if (!id && m) $('hallName').value = m[1] + (+m[2] + 1);
  render();
});
$('hallCancel').addEventListener('click', resetForm);

$('hallsBody').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]')?.dataset.edit;
  const del = e.target.closest('[data-del]')?.dataset.del;
  if (edit) {
    const h = halls.find((x) => x.id === edit);
    $('hallId').value = h.id;
    $('hallName').value = h.name;
    $('hallCols').value = h.cols;
    $('hallRows').value = h.rows;
    $('hallSave').textContent = 'Save hall';
    $('hallCancel').hidden = false;
    updateCap();
    $('hallName').focus();
  } else if (del) {
    const h = halls.find((x) => x.id === del);
    const used = Object.values(plans).reduce((n, p) => n + Object.keys(p[del] || {}).length, 0);
    if (!confirm(`Delete hall ${h.name}?${used ? ` Its ${used} allocated seat(s) across all sessions go back to the queue.` : ''}`)) return;
    halls = halls.filter((x) => x.id !== del);
    for (const p of Object.values(plans)) delete p[del];
    if ($('hallId').value === del) resetForm();
    save();
    render();
  }
});

/* ---------- filters ---------- */
// Any date can be picked; one outside the time table is kept as a custom exam date.
function addCustomDay(iso) {
  if (!iso || isExamDay(iso) || customDays.includes(iso)) return;
  customDays.push(iso);
  save();
  toast(`${fullDate(iso)} added as a custom exam date. Use Import / Search subject to add its subjects.`);
}
$('seatDate').addEventListener('change', () => { addCustomDay($('seatDate').value); selected.clear(); render(); });
$('seatDays').addEventListener('click', (e) => {
  if (e.target.closest('#seatAddDay')) {
    try { $('seatDate').showPicker(); } catch { $('seatDate').focus(); }
    return;
  }
  const un = e.target.closest('[data-undate]')?.dataset.undate;
  if (un) {
    const keys = ['FN', 'AN'].map((x) => `${un}|${x}`);
    const used = keys.reduce((n, k) => n + Object.values(plans[k] || {}).reduce((m, st) => m + Object.keys(st).length, 0) + (extras[k]?.length || 0), 0);
    if (used && !confirm(`Remove ${fullDate(un)}? Its seat allocations and added subjects are deleted too.`)) return;
    customDays = customDays.filter((x) => x !== un);
    for (const k of keys) { delete plans[k]; delete extras[k]; }
    if ($('seatDate').value === un) $('seatDate').value = days[0]?.date || '';
    save();
    selected.clear();
    return render();
  }
  const d = e.target.closest('[data-date]')?.dataset.date;
  if (!d) return;
  $('seatDate').value = d;
  selected.clear();
  render();
});
function setSession(s) {
  $('seatSession').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', b.dataset.s === s));
  pref.set('seatSession', s);
  selected.clear();
  render();
}
$('seatSession').addEventListener('click', (e) => { const s = e.target.closest('[data-s]')?.dataset.s; if (s) setSession(s); });
$('seatGroup').addEventListener('change', () => { pref.set('seatGroup', $('seatGroup').value); render(); });
$('seatMergeRS').addEventListener('change', () => { pref.set('seatMergeRS', $('seatMergeRS').checked ? '1' : '0'); render(); });
// earlier builds stored the opposite box ("Separate", '0' = merged)
if (pref.get('seatMergeRS') === '1' || (!pref.get('seatMergeRS') && pref.get('seatSepRS') === '0')) $('seatMergeRS').checked = true;
$('seatOrder').addEventListener('change', () => pref.set('seatOrder', $('seatOrder').value));
$('seatSubjTable').addEventListener('change', () => pref.set('seatSubjTable', $('seatSubjTable').checked ? '1' : '0'));
if (pref.get('seatSubjTable') === '0') $('seatSubjTable').checked = false;
$('seatAddlSign').addEventListener('change', () => pref.set('seatAddlSign', $('seatAddlSign').checked ? '1' : '0'));
if (pref.get('seatAddlSign') === '1') $('seatAddlSign').checked = true;
if (pref.get('seatGroup')) $('seatGroup').value = pref.get('seatGroup');
if (pref.get('seatOrder')) $('seatOrder').value = pref.get('seatOrder');
if (pref.get('seatSession') === 'AN') $('seatSession').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', b.dataset.s === 'AN'));

$('hallTabs').addEventListener('click', (e) => {
  const id = e.target.closest('[data-hall]')?.dataset.hall;
  if (!id || id === activeHall) return;
  activeHall = id;
  selected.clear();
  render();
});

/* ---------- grid selection (Excel-like) ---------- */
let anchor = null, base = null, dragging = false;

function rect(a, b) {
  const p = parseSeat(a), q = parseSeat(b);
  const out = [];
  for (let c = Math.min(p.c, q.c); c <= Math.max(p.c, q.c); c++)
    for (let r = Math.min(p.r, q.r); r <= Math.max(p.r, q.r); r++) out.push(seatId(c, r));
  return out;
}
function paintSelection() {
  $('seatGrid').querySelectorAll('td.seat').forEach((td) => td.classList.toggle('sel', selected.has(td.dataset.seat)));
  renderSelInfo();
}
const seatAt = (x, y) => document.elementFromPoint(x, y)?.closest?.('#seatGrid td.seat')?.dataset.seat;

$('seatGrid').addEventListener('pointerdown', (e) => {
  const id = e.target.closest('td.seat')?.dataset.seat;
  if (!id || e.button !== 0 || e.pointerType === 'touch') return; // touch: tap toggles (see below), swipe scrolls
  e.preventDefault();
  try { e.target.releasePointerCapture(e.pointerId); } catch {} // let touch drags move over other cells
  if (e.shiftKey && anchor) {
    selected = new Set([...(base || []), ...rect(anchor, id)]);
  } else if (e.ctrlKey || e.metaKey) {
    anchor = id;
    selected.has(id) ? selected.delete(id) : selected.add(id);
    base = new Set(selected);
  } else {
    anchor = id;
    base = new Set();
    selected = new Set([id]);
  }
  dragging = true;
  $('seatGrid').focus({ preventScroll: true });
  paintSelection();
});
$('seatGrid').addEventListener('pointermove', (e) => {
  if (!dragging || !anchor) return;
  const id = seatAt(e.clientX, e.clientY);
  if (!id) return;
  selected = new Set([...base, ...rect(anchor, id)]);
  paintSelection();
});
window.addEventListener('pointerup', () => (dragging = false));
// On touch screens a tap adds or removes one seat, so several taps build a selection.
$('seatGrid').addEventListener('click', (e) => {
  if (e.pointerType !== 'touch') return;
  const id = e.target.closest('td.seat')?.dataset.seat;
  if (!id) return;
  anchor = id;
  selected.has(id) ? selected.delete(id) : selected.add(id);
  paintSelection();
});

$('seatGrid').addEventListener('keydown', (e) => {
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); clearSeats([...selected]); }
  else if (e.key === 'Escape') { selected.clear(); paintSelection(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    const h = halls.find((x) => x.id === activeHall);
    if (h) { selected = new Set(seatOrder(h)); paintSelection(); }
  }
});

$('seatSelEmpty').addEventListener('click', () => {
  const h = halls.find((x) => x.id === activeHall);
  const seats = plan()[h.id] || {};
  selected = new Set(seatOrder(h).filter((id) => !seats[id]));
  paintSelection();
});

function clearSeats(ids) {
  const seats = plan()[activeHall];
  if (!seats || !ids.length) return;
  let n = 0;
  for (const id of ids) if (seats[id]) { delete seats[id]; n++; }
  if (!n) return toast('No candidates in the selected seats');
  save();
  render();
  toast(`${n} candidate(s) back in the queue`);
}
$('seatClearSel').addEventListener('click', () => (selected.size ? clearSeats([...selected]) : toast('Select seats to clear first')));
$('seatClearHall').addEventListener('click', () => {
  const h = halls.find((x) => x.id === activeHall);
  const seats = plan()[h.id] || {};
  if (!Object.keys(seats).length) return toast(`${h.name} is already empty`);
  if (!confirm(`Return all ${Object.keys(seats).length} candidates in ${h.name} to the queue?`)) return;
  clearSeats(Object.keys(seats));
});

/* ---------- allocation ---------- */
// Fill the selected empty seats, in fill order, with the group's waiting candidates.
$('seatQueue').addEventListener('click', (e) => {
  if (e.target.closest('[data-remove]')) return;
  const key = e.target.closest('[data-group]')?.dataset.group;
  if (key == null) return;
  const h = halls.find((x) => x.id === activeHall);
  if (!h) return toast('Add an examination hall first');
  if (!selected.size) return toast('Select seats in the grid first (click or drag across them)');
  const k = planKey();
  plans[k] ??= {};
  const seats = (plans[k][h.id] ??= {});
  const free = seatOrder(h).filter((id) => selected.has(id) && !seats[id]);
  if (!free.length) return toast('The selected seats are already taken');
  // Seats are always laid in ascending register-number order, whatever the subject mix in the group.
  const list = waiting().filter((x) => qKey(x) === key).sort((a, b) => a.reg.localeCompare(b.reg, undefined, { numeric: true }));
  const n = Math.min(free.length, list.length);
  for (let i = 0; i < n; i++) seats[free[i]] = { reg: list[i].reg, course: list[i].course, code: list[i].code, ...(list[i].x ? { x: list[i].x } : {}) };
  // Keep any leftover empty seats selected so the next group can fill them.
  selected = new Set(free.slice(n));
  save();
  render();
  const [gk, type] = key.split('|');
  const label = `${sessionExtras().find((e) => e.id === gk)?.code || gk}${type && type !== '*' ? ` (${type})` : ''}`;
  toast(`${n} of ${list.length} from ${label} seated in ${h.name} (${free[0]}${n > 1 ? `–${free[n - 1]}` : ''})${list.length > n ? ` · ${list.length - n} still waiting` : ''}`);
});

/* ---------- import / search subjects (cross-date, unscheduled, manual) ---------- */
const slotText = (sl) => `${weekday(sl.date)} ${dmy(sl.date)} ${sl.session}`;

function addExtra(e) {
  const k = planKey();
  (extras[k] ??= []).push({ id: 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), ...e });
  save();
  render();
}

const paneOn = () => $('importDlg').querySelector('.dlg-tabs [aria-checked="true"]').dataset.pane;
function openImport() {
  if (!$('seatDate').value) return toast('Pick an exam date first');
  $('importFor').textContent = `Candidates you add join the waiting dock for ${fullDate($('seatDate').value)} · ${SESSION_LABEL[session()]} and fill seats like any scheduled subject.`;
  renderResults();
  $('importDlg').showModal();
  if (paneOn() === 'post') renderPostponed();
  $({ search: 'importQ', manual: 'manCode', post: 'postFrom' }[paneOn()]).focus();
}
$('seatImportBtn').addEventListener('click', openImport);
$('importClose').addEventListener('click', () => $('importDlg').close());
$('importDlg').addEventListener('click', (e) => { if (e.target === $('importDlg')) $('importDlg').close(); }); // backdrop

$('importDlg').querySelector('.dlg-tabs').addEventListener('click', (e) => {
  const pane = e.target.closest('[data-pane]')?.dataset.pane;
  if (!pane) return;
  $('importDlg').querySelectorAll('.dlg-tabs button').forEach((b) => b.setAttribute('aria-checked', b.dataset.pane === pane));
  $('paneSearch').hidden = pane !== 'search';
  $('paneManual').hidden = pane !== 'manual';
  $('panePost').hidden = pane !== 'post';
  if (pane === 'post') renderPostponed();
  $({ search: 'importQ', manual: 'manCode', post: 'postFrom' }[pane]).focus();
});

// Search every hall-ticket subject, whatever its date or session.
function renderResults() {
  const q = $('importQ').value.trim().toLowerCase();
  const date = $('seatDate').value, ses = session();
  const inDock = new Set(sessionExtras().map((e) => e.code));
  const list = [...subjects.values()]
    .filter((s) => !q || s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || [...s.courses].some((c) => c.includes(q)))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const shown = list.slice(0, 80);
  if (!subjects.size) return ($('importResults').innerHTML = '<p class="empty">No hall tickets yet. Upload them in the Hall Tickets tab, or use Manual / paste.</p>');
  if (!list.length) return ($('importResults').innerHTML = '<p class="empty">No subject matches. Use Manual / paste for a code that is not on the hall tickets.</p>');
  $('importResults').innerHTML = shown
    .map((s) => {
      const thisSession = s.slots.some((sl) => sl.date === date && sl.session === ses);
      const off = thisSession || inDock.has(s.code);
      const when = s.slots.length ? [...new Set(s.slots.map(slotText))].join(', ') : 'No exam date (practical / unscheduled)';
      const status = thisSession ? '<span class="badge ok">In this session</span>'
        : inDock.has(s.code) ? '<span class="badge">In dock</span>'
        : `<span class="badge ${s.slots.length ? 'cross' : 'unsched'}">${s.slots.length ? 'Cross-Date' : 'Unscheduled'}</span>`;
      return `<div class="result">
        <div class="r-main"><b>${esc(s.code)}</b> ${esc(s.name)} ${status}
          <div class="muted">${esc(when)} · Course ${esc([...s.courses].join(', '))} · <b>${s.students.length}</b> candidate(s)</div></div>
        <button type="button" class="btn sm ${off ? 'ghost' : 'primary'}" data-import="${esc(s.code)}"${off ? ' disabled' : ''}>Import</button>
      </div>`;
    })
    .join('') + (list.length > shown.length ? `<p class="muted center">${list.length - shown.length} more, refine the search</p>` : '');
}
$('importQ').addEventListener('input', renderResults);

$('importResults').addEventListener('click', (e) => {
  const code = e.target.closest('[data-import]')?.dataset.import;
  if (!code) return;
  const s = subjects.get(code);
  const sched = new Set(scheduled().map(candKey));
  const cands = s.students.filter((c) => !sched.has(candKey(c)));
  if (!cands.length) return toast(`All ${code} candidates are already in this session`);
  const busy = new Set(scheduled().map((c) => c.reg));
  const clash = cands.filter((c) => busy.has(c.reg)).length;
  addExtra({
    kind: s.slots.length ? 'cross' : 'unsched', code, name: s.name, cands,
    from: s.slots.length ? `Scheduled ${[...new Set(s.slots.map(slotText))].join(', ')}` : 'No exam date on the hall tickets',
  });
  renderResults();
  toast(`${code}: ${cands.length} candidate(s) added to the dock${clash ? ` · ${clash} also write another paper this session` : ''}`);
});

// Register numbers from pasted text; "22100301-22100320" or "22100301 to 22100320" expands to the range.
function parseRegs(text) {
  const out = [];
  for (const tok of text.toUpperCase().replace(/\s+TO\s+/g, '-').split(/[\s,;]+/).filter(Boolean)) {
    const m = tok.match(/^(\d+)-(\d+)$/);
    if (m && m[1].length === m[2].length && +m[2] >= +m[1] && +m[2] - +m[1] < 5000) {
      for (let n = +m[1]; n <= +m[2]; n++) out.push(String(n).padStart(m[1].length, '0'));
    } else if (/^[A-Z0-9/-]{3,20}$/.test(tok)) out.push(tok);
  }
  return [...new Set(out)];
}
const updateManCount = () => { const n = parseRegs($('manRegs').value).length; $('manCount').textContent = n ? `${n} register number(s)` : ''; };
$('manRegs').addEventListener('input', updateManCount);
$('manFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  $('manRegs').value = ($('manRegs').value.trim() + '\n' + (await f.text())).trim();
  updateManCount();
});

$('paneManual').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('manCode').value.trim().toUpperCase();
  const regs = parseRegs($('manRegs').value);
  if (!code || !regs.length) return toast('Enter a subject code and at least one register number');
  const byReg = new Map(tickets.map((t) => [t.regNo, t]));
  const course = $('manCourse').value.trim();
  const cands = regs.map((reg) => {
    const t = byReg.get(reg);
    return { reg, name: t?.name || '', course: course || t?.courseNo || code, code, type: t?.subjects.find((x) => x.code === code)?.type || '' };
  });
  const sched = new Set(scheduled().map(candKey));
  const fresh = cands.filter((c) => !sched.has(candKey(c)));
  if (!fresh.length) return toast('These candidates are already in this session');
  addExtra({ kind: 'manual', code, name: $('manName').value.trim() || subjects.get(code)?.name || '', from: 'Added by hand', cands: fresh });
  $('paneManual').reset();
  updateManCount();
  $('importDlg').close();
  const unknown = cands.filter((c) => !byReg.has(c.reg)).length;
  const busy = new Set(scheduled().map((c) => c.reg));
  const clash = fresh.filter((c) => busy.has(c.reg)).length;
  toast(`${code}: ${fresh.length} candidate(s) added to the dock${unknown ? ` · ${unknown} not on any hall ticket` : ''}${clash ? ` · ${clash} also write another paper this session` : ''}`);
});

// One click removes a hand-added subject from the dock; seats already given stay as they are.
$('seatQueue').addEventListener('click', (e) => {
  const id = e.target.closest('[data-remove]')?.dataset.remove;
  if (!id) return;
  const k = planKey();
  const ex = (extras[k] || []).find((x) => x.id === id);
  extras[k] = (extras[k] || []).filter((x) => x.id !== id);
  if (!extras[k].length) delete extras[k];
  save();
  render();
  toast(`${ex?.code || 'Subject'} removed from the dock`);
});

/* ---------- postponed session: bring every subject of another session to this one ---------- */
function postSubjects(key) {
  const [date, ses] = key.split('|');
  const by = new Map();
  for (const c of days.find((d) => d.date === date)?.[ses] || []) {
    const g = by.get(c.code) || by.set(c.code, { code: c.code, name: subjects.get(c.code)?.name || '', cands: [] }).get(c.code);
    g.cands.push(c);
  }
  return [...by.values()].sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));
}
function renderPostponed() {
  const here = planKey();
  const opts = days
    .flatMap((d) => ['FN', 'AN'].filter((x) => d[x].length).map((x) => [`${d.date}|${x}`, `${weekday(d.date)} ${dmy(d.date)} · ${SESSION_LABEL[x]} · ${d[x].length} candidates`]))
    .filter(([k]) => k !== here);
  const sel = $('postFrom');
  const keep = sel.value;
  sel.innerHTML = opts.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
  if (opts.some(([k]) => k === keep)) sel.value = keep;
  const list = sel.value ? postSubjects(sel.value) : [];
  const inDock = new Set(sessionExtras().map((e) => e.code));
  $('postList').innerHTML = list.length
    ? list.map((g) => `<label class="post-row"><input type="checkbox" value="${esc(g.code)}"${inDock.has(g.code) ? ' disabled' : ' checked'} /> <b>${esc(g.code)}</b> ${esc(g.name)} <span class="muted">${g.cands.length} candidate(s)${inDock.has(g.code) ? ' · already in dock' : ''}</span></label>`).join('')
    : '<p class="empty">No other exam sessions found.</p>';
}
$('postFrom').addEventListener('change', renderPostponed);
$('postAll').addEventListener('click', () => {
  const boxes = [...$('postList').querySelectorAll('input:not(:disabled)')];
  const on = boxes.some((x) => !x.checked);
  boxes.forEach((x) => (x.checked = on));
});
$('panePost').addEventListener('submit', (e) => {
  e.preventDefault();
  const from = $('postFrom').value;
  if (!from) return;
  const [date, ses] = from.split('|');
  const pick = new Set([...$('postList').querySelectorAll('input:checked')].map((x) => x.value));
  const groups = postSubjects(from).filter((g) => pick.has(g.code));
  if (!groups.length) return toast('Tick at least one subject');
  const sched = new Set(scheduled().map(candKey));
  const k = planKey();
  let n = 0;
  for (const g of groups) {
    const cands = g.cands.filter((c) => !sched.has(candKey(c))).map(({ reg, name, course, code, type }) => ({ reg, name, course, code, type }));
    if (!cands.length) continue;
    (extras[k] ??= []).push({ id: 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), kind: 'postponed', code: g.code, name: g.name, from: `Postponed from ${fullDate(date)} ${ses}`, cands });
    n += cands.length;
  }
  save();
  render();
  $('importDlg').close();
  toast(`${n} candidate(s) in ${groups.length} subject(s) brought from ${fullDate(date)} ${ses}`);
});

/* ---------- PDF ---------- */
// "119 - GOVERNMENT POLYTECHNIC COLLEGE, NAGERCOIL" → code 119 + name.
function college() {
  const raw = examMeta.centre || document.getElementById('collegeName').dataset.college || '';
  const m = raw.match(/^\s*(\w+)\s*-\s*(.+)$/);
  return m ? { code: m[1], name: m[2].trim() } : { code: '', name: raw.trim() };
}
// "OCTOBER / NOVEMBER - 2026" → "BOARD EXAMINATIONS - OCTOBER / NOVEMBER 2026"
const examTitle = () => {
  const e = (examMeta.exam || '').replace(/\s*-\s*(\d{4})$/, ' $1').trim().toUpperCase();
  return e ? `BOARD EXAMINATIONS - ${e}` : 'BOARD EXAMINATIONS';
};

// "2026-10-22" → "Thursday, 22-10-2026"
const longDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: 'long' })}, ${dmy(iso)}`; };
// PDF file names start with the exam date and session: "22-10-2026_FN".
const fileStem = () => `${dmy($('seatDate').value)}_${session()}`;

// Sem and subject name of a seated candidate, from their hall ticket (or the dock entry they came from).
function subjectOf(s, byReg) {
  const sub = byReg.get(s.reg)?.subjects.find((x) => x.code === s.code);
  return { sem: sub?.sem || '', name: sub?.name || subjects.get(s.code)?.name || sessionExtras().find((e) => e.code === s.code)?.name || '' };
}

// Signature spaces: Chief Superintendent bottom-right, plus Addl. Chief Superintendent bottom-left when ticked.
function signatures(doc, fy) {
  const W = doc.internal.pageSize.getWidth();
  const signs = [['Chief Superintendent', W - 14 - 30]];
  if ($('seatAddlSign').checked) signs.push(['Addl. Chief Superintendent', 14 + 30]);
  doc.setTextColor(0).setDrawColor(0).setLineWidth(0.3);
  for (const [label, cx] of signs) {
    doc.line(cx - 30, fy - 5, cx + 30, fy - 5);
    doc.setFont('helvetica', 'bold').setFontSize(10).text(label, cx, fy, { align: 'center' });
    doc.setFont('helvetica', 'normal').setFontSize(8).text('Signature', cx, fy + 4, { align: 'center' });
  }
}

// College, exam and session lines at the top of a page; returns the y below them.
function pageHeader(doc) {
  const W = doc.internal.pageSize.getWidth();
  const { code, name } = college();
  let y = 16;
  doc.setTextColor(0).setDrawColor(0);
  doc.setFont('helvetica', 'bold').setFontSize(15);
  const nameLines = doc.splitTextToSize([code, name || 'Examination Centre'].filter(Boolean).join(' - '), W - 28);
  doc.text(nameLines, W / 2, y, { align: 'center' });
  y += nameLines.length * 6;
  doc.setFontSize(11.5).text(examTitle(), W / 2, y, { align: 'center' });
  y += 6;
  doc.setFont('helvetica', 'normal').setFontSize(10).text('Hall Chart', W / 2, y, { align: 'center' });
  y += 6.5;
  doc.setFont('helvetica', 'bold').setFontSize(11.5).text(`${longDate($('seatDate').value)}  ·  ${SESSION_LABEL[session()]}`, W / 2, y, { align: 'center' });
  return y;
}

$('seatPdfBtn').addEventListener('click', (e) =>
  withPdf(e.currentTarget, (jsPDF) => {
    const p = plan();
    // Every hall gets a page; one with nobody allocated shows an empty grid.
    const list = halls;
    if (!halls.some((h) => Object.keys(p[h.id] || {}).length)) return toast('No seats allocated in this session yet');
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: list.some((h) => h.cols > 7) ? 'landscape' : 'portrait' });
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
    const ink = () => doc.setTextColor(0).setDrawColor(0);
    const withTable = $('seatSubjTable').checked;
    const byReg = new Map(tickets.map((t) => [t.regNo, t]));

    list.forEach((h, i) => {
      if (i) doc.addPage();
      // Sem / course / subject counts for this hall
      const rowsBy = new Map();
      for (const s of Object.values(p[h.id] || {})) {
        const { sem, name } = subjectOf(s, byReg);
        const k = [sem, s.course, s.code].join('|');
        const r = rowsBy.get(k) || rowsBy.set(k, { sem, course: s.course, code: s.code, name, n: 0 }).get(k);
        r.n++;
      }
      const subjRows = [...rowsBy.values()].sort((a, b) => a.course.localeCompare(b.course) || (+a.sem || 0) - (+b.sem || 0) || a.code.localeCompare(b.code));
      let y = pageHeader(doc) + 12;
      doc.setFont('helvetica', 'bold').setFontSize(26).text(h.name, W / 2, y, { align: 'center' });
      y += 4;
      doc.setLineWidth(0.6).line(W / 2 - 22, y, W / 2 + 22, y);
      y += 4;

      // subject table: Sem, Course No, Subject, Count (can be switched off)
      if (withTable && subjRows.length) {
        const fill = [245, 247, 251];
        doc.autoTable({
          startY: y,
          head: [['Sem', 'Course No', 'Subject', 'Count']],
          body: [
            ...subjRows.map((r) => [r.sem || '-', r.course, `${r.code}${r.name ? ' - ' + r.name : ''}`, r.n]),
            [{ content: 'Total', colSpan: 3, styles: { halign: 'right', fontStyle: 'bold', fillColor: fill } }, { content: Object.keys(p[h.id] || {}).length, styles: { fontStyle: 'bold', fillColor: fill } }],
          ],
          theme: 'grid',
          styles: { fontSize: 9, cellPadding: 1.4, valign: 'middle', lineColor: [120, 125, 135], lineWidth: 0.2, textColor: 0 },
          headStyles: { fillColor: [232, 236, 244], textColor: 0, fontStyle: 'bold' },
          columnStyles: { 0: { cellWidth: 14, halign: 'center' }, 1: { cellWidth: 24, halign: 'center' }, 3: { cellWidth: 18, halign: 'right' } },
          margin: { left: 14, right: 14 },
        });
        ink();
        y = doc.lastAutoTable.finalY + 2;
      }
      y += 3;
      doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(90).text('FRONT', W / 2, y, { align: 'center' });
      ink();
      y += 2.5;

      // seating grid
      const seats = p[h.id] || {};
      const footTop = H - 30; // signatures
      const left = 14, gutter = 8, headH = 7;
      const cellW = (W - 28 - gutter) / h.cols;
      const cellH = Math.max(9, Math.min(24, (footTop - y - headH) / h.rows));
      doc.setLineWidth(0.25).setDrawColor(60);
      doc.setFont('helvetica', 'bold').setFontSize(10);
      for (let c = 0; c < h.cols; c++) {
        const x = left + gutter + c * cellW;
        doc.setFillColor(232, 236, 244).rect(x, y, cellW, headH, 'FD');
        doc.text(colName(c), x + cellW / 2, y + headH / 2 + 1.3, { align: 'center' });
      }
      const top = y + headH;
      const regSize = Math.max(8, Math.min(15, cellW * 0.55, cellH * 1.05));
      for (let r = 0; r < h.rows; r++) {
        const yy = top + r * cellH;
        doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(0);
        doc.text(String(r + 1), left + gutter / 2, yy + cellH / 2 + 1.3, { align: 'center' });
        for (let c = 0; c < h.cols; c++) {
          const x = left + gutter + c * cellW;
          const id = seatId(c, r);
          const s = seats[id];
          doc.rect(x, yy, cellW, cellH);
          // seat id: regular weight, top-left
          doc.setFont('helvetica', 'normal').setFontSize(Math.min(8.5, cellH * 0.6)).setTextColor(70);
          doc.text(id, x + 1.5, yy + 3.4);
          if (!s) continue;
          // department (course) code: top-right
          doc.text(s.course, x + cellW - 1.5, yy + 3.4, { align: 'right' });
          // register number: bold, centred
          doc.setFont('helvetica', 'bold').setFontSize(regSize).setTextColor(0);
          let fs = regSize;
          while (fs > 7 && doc.getTextWidth(s.reg) > cellW - 4) doc.setFontSize((fs -= 0.5));
          doc.text(s.reg, x + cellW / 2, yy + cellH / 2 + fs * 0.18 + (cellH > 14 ? 0.5 : 1), { align: 'center' });
          if (cellH >= 14) {
            doc.setFont('helvetica', 'normal').setFontSize(6.5).setTextColor(100);
            doc.text(s.code, x + cellW - 1.5, yy + cellH - 1.6, { align: 'right' });
          }
        }
      }
      ink();

      signatures(doc, H - 20);
    });
    doc.save(`${fileStem()}.pdf`);
  }),
);

resetForm();
render();

/* ---------- entrance display: one page, course → register numbers → hall ---------- */
function noticeRows() {
  const p = plan();
  const names = new Map(tickets.map((t) => [t.courseNo, t.courseName]));
  const groups = new Map(); // course → [{ hall, regs, seats }]
  for (const h of halls) {
    const seats = p[h.id] || {};
    const order = seatOrder(h, 'col');
    const byCourse = new Map();
    for (const id of order) {
      const s = seats[id];
      if (!s) continue;
      const g = byCourse.get(s.course) || byCourse.set(s.course, { hall: h.name, regs: [], seats: [] }).get(s.course);
      g.regs.push(s.reg);
      g.seats.push(id);
    }
    for (const [c, g] of byCourse) (groups.get(c) || groups.set(c, []).get(c)).push(g);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([course, list]) => ({
      course,
      name: names.get(course) || timetable?.courses?.[course] || sessionExtras().find((e) => e.cands.some((c) => c.course === course))?.name || '',
      halls: list.map((g) => {
        const regs = [...g.regs].sort();
        return { hall: g.hall, regs, n: regs.length, seats: g.seats.length > 1 ? `${g.seats[0]}–${g.seats[g.seats.length - 1]}` : g.seats[0] };
      }),
    }));
}

$('seatNoticeBtn').addEventListener('click', (e) =>
  withPdf(e.currentTarget, (jsPDF) => {
    const rows = noticeRows();
    if (!rows.length) return toast('No seats allocated in this session yet');
    const total = rows.reduce((n, r) => n + r.halls.reduce((m, h) => m + h.n, 0), 0);
    const body = [];
    rows.forEach((r, i) =>
      r.halls.forEach((h, j) => {
        const line = [
          { content: h.regs.join(', '), styles: { fontStyle: 'bold' } },
          { content: h.n, styles: { halign: 'right' } },
          { content: h.hall, styles: { fontStyle: 'bold', halign: 'center', fillColor: [232, 239, 255] } },
        ];
        if (!j) line.unshift({ content: i + 1, rowSpan: r.halls.length, styles: { halign: 'right' } }, { content: `${r.course}\n${r.name}`, rowSpan: r.halls.length, styles: { fontStyle: 'bold' } });
        body.push(line);
      }),
    );
    // Shrink the text until the whole sheet fits on one page (very large sessions may still run over).
    let doc;
    for (let fs = 20; fs >= 6; fs -= 0.5) {
      doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
      const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
      const y = pageHeader(doc) + 11;
      doc.setFont('helvetica', 'bold').setFontSize(20).text('HALL ALLOTMENT', W / 2, y, { align: 'center' });
      // Fixed columns are as wide as their text; the register numbers take the rest.
      doc.setFontSize(fs);
      const pad = fs * 0.13 * 2 + 1;
      const fit = (texts) => Math.max(...texts.map((t) => doc.getTextWidth(String(t)))) + pad;
      const flat = rows.flatMap((r) => r.halls);
      const widths = {
        0: fit(['S.No', rows.length]),
        1: fit(['MECHANICAL ENGINEERING']),
        3: fit(['Count', total]),
        4: fit(['Hall', ...flat.map((h) => h.hall)]) * 1.15,
      };
      doc.autoTable({
        startY: y + 5,
        head: [['S.No', 'Course', 'Register Numbers', 'Count', 'Hall']],
        body,
        foot: [[{ content: 'Total candidates', colSpan: 3, styles: { halign: 'right' } }, { content: total, styles: { halign: 'right' } }, { content: '' }]],
        theme: 'grid',
        styles: { fontSize: fs, cellPadding: fs * 0.13, valign: 'middle', lineColor: [120, 125, 135], lineWidth: 0.2, textColor: 0 },
        headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold', halign: 'center' },
        footStyles: { fillColor: [245, 247, 251], textColor: 0, fontStyle: 'bold' },
        columnStyles: Object.fromEntries(Object.entries(widths).map(([k, w]) => [k, { cellWidth: w }])),
        margin: { left: 12, right: 12, bottom: 30 },
        rowPageBreak: 'avoid',
      });
      if (doc.internal.getNumberOfPages() === 1 || fs <= 6) {
        signatures(doc, H - 20); // on the last page
        break;
      }
    }
    doc.save(`${fileStem()}_Entrance.pdf`);
  }),
);

/* ---------- hall allocation details (Excel): candidates per subject in each hall ---------- */
// Each allocated cell carries a superscript: the order to collect that subject's papers from the halls
// so they come out in register-number sequence (1 = the hall holding the lowest register numbers).
$('seatAllocBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const p = plan();
    const byReg = new Map(tickets.map((t) => [t.regNo, t]));
    const rows = new Map(); // course|code → { course, code, name, by: { hallId: { n, first } }, n }
    for (const h of halls)
      for (const st of Object.values(p[h.id] || {})) {
        const k = st.course + '|' + st.code;
        const r = rows.get(k) || rows.set(k, { course: st.course, code: st.code, name: subjectOf(st, byReg).name, by: {}, n: 0 }).get(k);
        const c = (r.by[h.id] ??= { n: 0, first: st.reg });
        c.n++;
        if (st.reg < c.first) c.first = st.reg;
        r.n++;
      }
    const list = [...rows.values()].sort((x, y) => x.course.localeCompare(y.course) || x.code.localeCompare(y.code, undefined, { numeric: true }));
    if (!list.length) return toast('No seats allocated in this session yet');
    for (const r of list) {
      const order = Object.entries(r.by).sort((x, y) => x[1].first.localeCompare(y[1].first));
      order.forEach(([, c], i) => (c.seq = i + 1));
    }
    const hallTotal = (h) => Object.keys(p[h.id] || {}).length;
    const total = list.reduce((n, r) => n + r.n, 0);

    const ExcelJS = await loadExcelJs();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Hall Allocation', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true, margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } },
    });
    const H = halls.length;
    const last = 4 + H + 4; // columns: 4 fixed + halls + Total Candi., Pres., Abs., Qn. Balance
    ws.columns = [{ width: 9 }, { width: 13 }, { width: 30 }, { width: 9 }, ...halls.map(() => ({ width: 8 })), { width: 9 }, { width: 8 }, { width: 8 }, { width: 8 }];
    const thin = { style: 'thin', color: { argb: 'FF333333' } };
    const box = { top: thin, left: thin, bottom: thin, right: thin };
    const center = { horizontal: 'center', vertical: 'middle', wrapText: true };
    const grey = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8ECF4' } };
    const style = (row, from, to, extra = {}) => {
      for (let c = from; c <= to; c++) {
        const cell = row.getCell(c);
        cell.border = box;
        cell.alignment = { ...center, ...(extra.alignment || {}) };
        if (extra.font) cell.font = extra.font;
        if (extra.fill) cell.fill = extra.fill;
      }
    };
    const title = (text, size) => {
      const row = ws.addRow([text]);
      ws.mergeCells(row.number, 1, row.number, last);
      row.getCell(1).font = { bold: true, size };
      row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
      row.height = size * 1.6;
    };
    const { code, name } = college();
    title([code, name || 'Examination Centre'].filter(Boolean).join(' - '), 13);
    title(examTitle(), 11);
    title(`HALL ALLOCATION DETAILS ON ${dmy($('seatDate').value)} ${session() === 'FN' ? 'F.N' : 'A.N'}`, 13);

    const head = ws.addRow(['Course Code', 'Sub. Code', 'Subject Name', 'QP. Code', ...halls.map((h) => h.name), 'Total Candi.', 'Total Pres.', 'Total Abs.', 'Qn. Balan.']);
    head.height = 32;
    style(head, 1, last, { font: { bold: true }, fill: grey });

    for (const r of list) {
      const row = ws.addRow([r.course, r.code, r.name, '', ...halls.map(() => null), r.n, '', '', '']);
      halls.forEach((h, i) => {
        const c = r.by[h.id];
        if (!c) return;
        // count, then its collection order as a superscript
        row.getCell(5 + i).value = { richText: [{ text: String(c.n), font: { bold: true, size: 12 } }, { text: String(c.seq), font: { size: 9, vertAlign: 'superscript', color: { argb: 'FFB45309' } } }] };
      });
      row.height = 30;
      style(row, 1, last);
      row.getCell(3).alignment = { ...center, horizontal: 'left' };
      row.getCell(5 + H).font = { bold: true, size: 12 };
    }

    const tot = ws.addRow(['Hallwise Total', '', '', '', ...halls.map((h) => hallTotal(h) || null), total, '', '', '']);
    ws.mergeCells(tot.number, 1, tot.number, 4);
    tot.height = 24;
    style(tot, 1, last, { font: { bold: true, size: 12 }, fill: grey });
    tot.getCell(1).alignment = { ...center, horizontal: 'right' };

    const used = halls.filter(hallTotal).length;
    for (const [left, right] of [[`Total number of Halls  ::  ${used}`, 'Total number of Hall Supdts  ::'], ['Total number of Qn. Packets  ::', 'Total number of Bundles sent  ::']]) {
      const row = ws.addRow([left]);
      ws.mergeCells(row.number, 1, row.number, 4);
      ws.mergeCells(row.number, 5, row.number, last);
      row.getCell(5).value = right;
      row.height = 24;
      style(row, 1, last, { font: { bold: true } });
    }
    ws.addRow([]);
    const note = ws.addRow(['Superscript in a hall cell = order to collect that subject\'s papers from the halls, so they come out in register-number sequence (1 = lowest register numbers).']);
    ws.mergeCells(note.number, 1, note.number, last);
    note.getCell(1).font = { italic: true, size: 9, color: { argb: 'FF555555' } };

    const buf = await wb.xlsx.writeBuffer();
    download(`${fileStem()}_Hall_Allocation.xlsx`, new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  } catch (err) {
    console.error(err);
    toast('Excel export failed. Check your internet connection.');
  } finally {
    btn.disabled = false;
  }
});

/* ---------- attendance sheets: one PDF per course + subject code ---------- */
// Laid out like the DOTE attendance sheet (theory): 10 candidates a page, serial numbers running on across pages,
// columns for the answer book serial number, photo (blank) and signature, and present / absent counts per page.
function attendanceGroups() {
  const byReg = new Map(tickets.map((t) => [t.regNo, t]));
  // One sheet per course + question-paper subject: old-scheme equivalents sit on their current subject's sheet.
  const groups = new Map(); // course|subject code → { course, courseName, code, name, legacy: Map(code → scheme), list }
  for (const x of pool()) {
    const t = byReg.get(x.reg);
    const own = x.own || x.code;
    const k = x.course + '|' + x.code;
    const g = groups.get(k) || groups.set(k, { key: k, course: x.course, courseName: t?.courseName || '', code: x.code, name: '', legacy: new Map(), list: [] }).get(k);
    if (!g.courseName && t) g.courseName = t.courseName;
    // the current subject's own name wins over an old-scheme name
    if (own === x.code && !g.nameIsCurrent) { g.name = x.subj || t?.subjects.find((y) => y.code === own)?.name || g.name; g.nameIsCurrent = !!g.name; }
    if (!g.name) g.name = subjects.get(x.code)?.name || x.subj || '';
    const old = own !== x.code ? { code: own, scheme: mapSubject(own, x.course)?.scheme || '' } : null;
    if (old) g.legacy.set(old.code, old.scheme);
    g.list.push({ reg: x.reg, name: x.name || t?.name || '', dob: t?.dob || '', old });
  }
  for (const g of groups.values()) g.list.sort((a, b) => a.reg.localeCompare(b.reg, undefined, { numeric: true }));
  return [...groups.values()].sort((a, b) => a.course.localeCompare(b.course) || a.code.localeCompare(b.code, undefined, { numeric: true }));
}

const ROWS_PER_PAGE = 10;
function attendancePdf(jsPDF, g) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const W = doc.internal.pageSize.getWidth();
  const L = 12, R = W - 12, w = R - L;
  const { code: centre, name: centreName } = college();
  const exam = (examMeta.exam || '').replace(/\s*-\s*(\d{4})$/, ' $1').trim().toUpperCase();
  const date = $('seatDate').value;
  // column x positions: SNo | Reg No / Ins Code | Name / Answer book serial | DoB | Photo | Signature
  const cx = [L, L + 10, L + 34, L + 104, L + 126, L + 146, R];
  const line = (x1, y1, x2, y2) => doc.line(x1, y1, x2, y2);
  const cell = (text, x1, x2, y, opt = {}) => doc.text(String(text), opt.align === 'left' ? x1 + 1.5 : (x1 + x2) / 2, y, { align: opt.align === 'left' ? 'left' : 'center', maxWidth: x2 - x1 - 2 });
  const pages = Math.max(1, Math.ceil(g.list.length / ROWS_PER_PAGE));
  for (let p = 0; p < pages; p++) {
    if (p) doc.addPage();
    const rows = g.list.slice(p * ROWS_PER_PAGE, (p + 1) * ROWS_PER_PAGE);
    doc.setTextColor(0).setDrawColor(0).setLineWidth(0.3);
    let y = 12;
    doc.setFont('helvetica', 'normal').setFontSize(10);
    doc.text('GOVERNMENT OF TAMIL NADU', W / 2, y, { align: 'center' });
    doc.text('DIRECTORATE OF TECHNICAL EDUCATION, CHENNAI - 600 025', W / 2, y + 4.5, { align: 'center' });
    doc.setFont('helvetica', 'bold').text(`BOARD EXAMINATIONS :: ${exam || '—'} :: ATTENDANCE SHEET (THEORY)`, W / 2, y + 9, { align: 'center' });
    y += 11;
    // header box
    const hx = [L, L + 36, R - 30, R];
    const hRow = (labels, values, h1, h2) => {
      doc.setFont('helvetica', 'normal').setFontSize(8.5);
      labels.forEach((t, i) => doc.text(t.split('\n'), (hx[i] + hx[i + 1]) / 2, y + (t.includes('\n') ? 3.4 : 4), { align: 'center' }));
      doc.setFont('helvetica', 'bold').setFontSize(10.5);
      values.forEach((t, i) => doc.text(doc.splitTextToSize(t, hx[i + 1] - hx[i] - 3), (hx[i] + hx[i + 1]) / 2, y + h1 + 4.5, { align: 'center' }));
      doc.rect(L, y, w, h1 + h2);
      line(L, y + h1, R, y + h1);
      line(hx[1], y, hx[1], y + h1 + h2);
      line(hx[2], y, hx[2], y + h1 + h2);
      y += h1 + h2;
    };
    hRow(['Centre Code', 'Name of the Centre', 'QP Code'], [centre, centreName.toUpperCase(), ''], 6, 8);
    hRow(['Course Code\nSubject Code', 'Course Name\nSubject Name', 'Exam Date\nSession'], [`${g.course}\n${g.code}`, `${g.courseName}\n${g.name}`, `${dmy(date).replace(/-/g, '.')}\n${session()}`], 8, 11);
    // table head
    const th = 9;
    doc.setFont('helvetica', 'normal').setFontSize(8);
    ['SNo', 'Reg No\nIns Code', 'Name of the Applicant\nAnswer Book Serial Number', 'DoB', 'Photo', 'Signature of the\nCandidate'].forEach((t, i) => doc.text(t.split('\n'), (cx[i] + cx[i + 1]) / 2, y + (t.includes('\n') ? 3.6 : 5.5), { align: 'center' }));
    doc.rect(L, y, w, th);
    y += th;
    // candidate rows
    const rh = 18; // 10 rows + header + counts + signatures fit one A4 page
    rows.forEach((c, i) => {
      const sno = p * ROWS_PER_PAGE + i + 1;
      doc.rect(L, y, w, rh);
      for (let k = 1; k < cx.length - 1; k++) line(cx[k], y, cx[k], y + rh);
      doc.rect(cx[4] + 3, y + 2, cx[5] - cx[4] - 6, rh - 4); // photo box
      doc.setFont('helvetica', 'normal').setFontSize(10);
      cell(sno, cx[0], cx[1], y + rh / 2 + 1.5);
      doc.setFont('helvetica', 'bold').setFontSize(10.5);
      cell(c.reg, cx[1], cx[2], y + rh / 2 - 0.5);
      doc.setFont('helvetica', 'normal').setFontSize(9.5);
      cell(centre, cx[1], cx[2], y + rh / 2 + 4.5);
      doc.setFont('helvetica', 'bold').setFontSize(10);
      cell(c.name, cx[2], cx[3], y + 5, { align: 'left' });
      doc.setFont('helvetica', 'normal').setFontSize(10);
      cell(c.dob.replace(/-/g, '.'), cx[3], cx[4], y + rh / 2 + 1.5);
      y += rh;
    });
    // counts + signatures
    const third = w / 3;
    doc.setFontSize(8.5);
    ['No. of Candidates in this Sheet', 'No. of Candidates Present', 'No. of Candidates Absent'].forEach((t, i) => doc.text(t, L + third * i + third / 2, y + 4, { align: 'center' }));
    doc.rect(L, y, w, 14);
    line(L, y + 6, R, y + 6);
    line(L + third, y, L + third, y + 14);
    line(L + third * 2, y, L + third * 2, y + 14);
    doc.setFont('helvetica', 'bold').setFontSize(11).text(String(rows.length), L + third / 2, y + 11.5, { align: 'center' });
    y += 14;
    doc.setFont('helvetica', 'normal').setFontSize(8.5);
    ['Signature of the Hall Supdt', 'Signature of the ACS', 'Signature of the CS'].forEach((t, i) => doc.text(t, L + third * i + third / 2, y + 4, { align: 'center' }));
    doc.rect(L, y, w, 20);
    line(L, y + 6, R, y + 6);
    line(L + third, y, L + third, y + 20);
    line(L + third * 2, y, L + third * 2, y + 20);
    y += 24;
    doc.setFontSize(8).setTextColor(90).text(`Page ${p + 1} of ${pages} · ${g.course} / ${g.code} · ${g.list.length} candidate(s)`, L, y);
    doc.setTextColor(0);
  }
  return doc;
}
const attendanceName = (g) => `${fileStem()}_Attendance_${g.course}_${g.code}.pdf`.replace(/[^\w.-]+/g, '_');

function renderAttendanceList() {
  const groups = attendanceGroups();
  $('attFor').textContent = `${fullDate($('seatDate').value)} · ${SESSION_LABEL[session()]} · ${groups.length} course / subject sheet(s) · ${groups.reduce((n, g) => n + g.list.length, 0)} candidates`;
  $('attDownloadAll').disabled = !groups.length;
  $('attBody').innerHTML = groups.length
    ? groups.map((g, i) => `<tr><td><b>${esc(g.course)}</b></td><td><b>${esc(g.code)}</b></td><td class="wrap">${esc(g.name)}</td><td class="num">${g.list.length}</td><td class="num">${Math.ceil(g.list.length / ROWS_PER_PAGE)}</td><td><button class="btn ghost sm" data-att="${i}">PDF</button></td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">No candidates in this session.</td></tr>';
}
$('seatAttBtn').addEventListener('click', () => {
  if (!$('seatDate').value) return toast('Pick an exam date first');
  renderAttendanceList();
  $('attDlg').showModal();
});
$('attClose').addEventListener('click', () => $('attDlg').close());
$('attBody').addEventListener('click', (e) => {
  const i = e.target.closest('[data-att]')?.dataset.att;
  if (i == null) return;
  const g = attendanceGroups()[+i];
  withPdf(e.target.closest('button'), (jsPDF) => attendancePdf(jsPDF, g).save(attendanceName(g)));
});
$('attDownloadAll').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const groups = attendanceGroups();
    const [jsPDF, JSZip] = await Promise.all([loadJsPdf(), loadJsZip()]);
    const zip = new JSZip();
    for (const g of groups) zip.file(attendanceName(g), attendancePdf(jsPDF, g).output('arraybuffer'));
    download(`${fileStem()}_Attendance.zip`, await zip.generateAsync({ type: 'blob' }));
    toast(`${groups.length} attendance PDF(s) in one ZIP file`);
  } catch (err) {
    console.error(err);
    toast('Attendance export failed. Check your internet connection.');
  } finally {
    btn.disabled = false;
  }
});

/* ---------- packing slips: one per course + subject, six to an A4 sheet ---------- */
// Each slip: QP code box, course / subject, staff name line, and the halls in collecting order (the hall holding
// the lowest register numbers first, as in the hall allocation) with counts. Courses are never merged.
function packingGroups() {
  const p = plan();
  const byReg = new Map(tickets.map((t) => [t.regNo, t]));
  const groups = new Map(); // course|subject → { course, code, name, halls: Map(hallId → { name, n, first }) }
  for (const h of halls)
    for (const st of Object.values(p[h.id] || {})) {
      const code = mapSubject(st.code, st.course)?.code || st.code; // old-scheme seats count under the current subject
      const k = st.course + '|' + code;
      const g = groups.get(k) || groups.set(k, { course: st.course, code, name: '', halls: new Map() }).get(k);
      if (!g.name || st.code === code) g.name = (st.code === code ? subjectOf(st, byReg).name : '') || g.name || subjects.get(code)?.name || subjectOf(st, byReg).name;
      const e = g.halls.get(h.id) || g.halls.set(h.id, { name: h.name, n: 0, first: st.reg }).get(h.id);
      e.n++;
      if (st.reg.localeCompare(e.first, undefined, { numeric: true }) < 0) e.first = st.reg;
    }
  return [...groups.values()]
    .map((g) => ({ ...g, order: [...g.halls.values()].sort((a, b) => a.first.localeCompare(b.first, undefined, { numeric: true })), total: [...g.halls.values()].reduce((n, x) => n + x.n, 0) }))
    .sort((a, b) => a.course.localeCompare(b.course) || a.code.localeCompare(b.code, undefined, { numeric: true }));
}

$('seatPackBtn').addEventListener('click', (e) =>
  withPdf(e.currentTarget, (jsPDF) => {
    const list = packingGroups();
    if (!list.length) return toast('No seats allocated in this session yet');
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
    const cols = 2, rows = 3, m = 6;
    const cw = (W - 2 * m) / cols, ch = (H - 2 * m) / rows;
    const when = `${dmy($('seatDate').value)} ${session()}`;
    const cutLines = () => {
      doc.setLineDashPattern([2, 2], 0).setLineWidth(0.2).setDrawColor(150);
      for (let c = 1; c < cols; c++) doc.line(m + c * cw, m, m + c * cw, H - m);
      for (let r = 1; r < rows; r++) doc.line(m, m + r * ch, W - m, m + r * ch);
      doc.setLineDashPattern([], 0).setDrawColor(0);
    };
    list.forEach((g, i) => {
      const k = i % (cols * rows);
      if (i && !k) doc.addPage();
      if (!k) cutLines();
      const x = m + (k % cols) * cw + 7, y0 = m + Math.floor(k / cols) * ch + 10, w = cw - 14;
      let y = y0;
      doc.setTextColor(0).setLineWidth(0.3);
      // title + QP code box
      doc.setFont('helvetica', 'bold').setFontSize(15).text('PACKING', x, y + 2);
      doc.setFontSize(8).setFont('helvetica', 'normal').text('QP Code', x + w - 42, y - 2.5);
      doc.rect(x + w - 42, y - 1, 42, 8);
      y += 13;
      const field = (label, value, bold = true) => {
        doc.setFont('helvetica', 'normal').setFontSize(9.5).text(label, x, y);
        doc.setFont('helvetica', bold ? 'bold' : 'normal').setFontSize(11);
        const lines = doc.splitTextToSize(value, w - 26).slice(0, 2);
        doc.text(lines, x + 26, y);
        y += 6.5 + (lines.length - 1) * 4.6;
      };
      field('Course Code :', g.course);
      field('Sub Code :', g.code);
      field('Sub Name :', g.name || '—');
      doc.setFont('helvetica', 'normal').setFontSize(9.5).text('Staff Name :', x, y + 1);
      doc.line(x + 26, y + 1.5, x + w, y + 1.5);
      y += 9;
      // halls in collecting order, each with a line for the count; the total is written by hand too
      doc.setFont('helvetica', 'bold').setFontSize(10).text('Hall Order', x, y);
      doc.setLineWidth(0.3).line(x, y + 1.2, x + 24, y + 1.2);
      y += 6;
      const room = y0 + ch - 27 - y; // leave space for the total line and the footer
      const twoCols = g.order.length > Math.max(1, Math.floor(room / 6.5));
      const perCol = twoCols ? Math.ceil(g.order.length / 2) : g.order.length;
      const step = Math.min(6.5, room / Math.max(1, perCol));
      g.order.forEach((h, n) => {
        const col = twoCols && n >= perCol ? 1 : 0;
        const hx = x + 4 + col * (w / 2), hy = y + (col ? n - perCol : n) * step;
        doc.setFont('helvetica', 'bold').setFontSize(twoCols ? 10 : 12).text(`${n + 1}. ${h.name}`, hx, hy);
        doc.setLineWidth(0.25).line(hx + (twoCols ? 22 : 28), hy + 0.6, hx + (twoCols ? w / 2 - 8 : 62), hy + 0.6);
      });
      const ty = y + perCol * step + 2;
      doc.setFont('helvetica', 'bold').setFontSize(10.5).text('Total :', x + 4, ty);
      doc.setLineWidth(0.3).line(x + 20, ty + 0.6, x + 62, ty + 0.6);
      doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(110).text(`${when}  ·  collect the halls in this order for ascending register numbers`, x, y0 + ch - 14, { maxWidth: w });
      doc.setTextColor(0);
    });
    doc.save(`${fileStem()}_Packing.pdf`);
  }),
);
