// Equivalent Subjects Mapping: one Current Subject ← many Old / Legacy Subjects (other schemes / regulations)
// that share its question paper. QP statistics and seating merge them under the current subject code.
// kv "equiv": [{ id, code, legacy: [{ scheme, course, code }] }] — your own mappings, which always win.
// Built in: DOTE's equivalent-subject table (js/data/equivalents.js, K/L/M/N scheme → newer code), on unless switched off.
import { kv, kvReady } from './kv.js';
import builtinData from './data/equivalents.js';
import { onTickets, setCodeMapper, htReload } from './halltickets.js';
import { $, esc, toast, loadExcelJs, download } from './util.js';

await kvReady;

let maps = kv.get('equiv', []);
let tickets = [];
let info = new Map(); // code → { name, regs: Set, courses: Set, n, byCourse: Map(course → n) }
let idx = new Map(); // course → { name, regs: Map(regulation → Map(semester → Map(code → { name, n }))) } — what that course's students write
const listeners = [];
let ttData = null; // time table in use (set by qp.js), for the pickers

export const equivMaps = () => maps;
export function onEquiv(fn) {
  listeners.push(fn);
  fn(maps);
}
// A new / changed mapping can move legacy subjects onto a date set for their current subject.
const changed = () => { htReload(); listeners.forEach((fn) => fn(maps)); };
export function equivReload() {
  maps = kv.get('equiv', []);
  useBuiltin = kv.get('equivBuiltin', true) !== false;
  useTable(kv.get('equivTable', null) || builtinData);
  buildIdx();
  render();
  changed();
}

/* ---------- built-in DOTE equivalents ---------- */
// kv "equivTable": a DOTE equivalents table you uploaded (xlsx / csv); it replaces the built-in one until you switch back.
const builtin = new Map(); // 'course|old code' → { course, code, name, sem, scheme, target }
let tableMeta = builtinData.meta;
function useTable(data) {
  builtin.clear();
  for (const [course, code, name, sem, scheme, target] of data.rows) builtin.set(course + '|' + code, { course, code, name, sem, scheme, target });
  tableMeta = data.meta || {};
  builtinGroups = null;
}
let useBuiltin = kv.get('equivBuiltin', true) !== false;
// Part-time (3xxx) and Tamil-medium (7xxx) courses share the full-time (1xxx) subjects.
const tableCourse = (course) => (builtin.size && [...'37'].includes(course?.[0]) ? '1' + course.slice(1) : course);
const builtinRow = (code, course) => builtin.get(course + '|' + code) || builtin.get(tableCourse(course) + '|' + code);
// An old code may point at another old code (L → M → R2023); follow it to the end.
function resolve(code, course) {
  let t = code;
  const seen = new Set();
  for (let r = builtinRow(t, course); r && !seen.has(t); r = builtinRow(t, course)) { seen.add(t); t = r.target; }
  return t;
}
// Built-in mappings grouped by the code they end at, for the list / search.
let builtinGroups = null;
useTable(kv.get('equivTable', null) || builtinData);
function groups() {
  if (builtinGroups) return builtinGroups;
  builtinGroups = new Map();
  for (const r of builtin.values()) {
    const t = resolve(r.code, r.course);
    (builtinGroups.get(t) || builtinGroups.set(t, []).get(t)).push(r);
  }
  return builtinGroups;
}

// legacy code (+ course) → { code: current code, scheme }
export function mapSubject(code, course) {
  for (const m of maps)
    for (const l of m.legacy)
      if (l.code === code && (!l.course || l.course === course)) return { code: m.code, scheme: l.scheme || 'Legacy' };
  if (useBuiltin) {
    const r = builtinRow(code, course);
    if (r) return { code: resolve(code, course), scheme: `${r.scheme}-Scheme` };
  }
  return null;
}
setCodeMapper(mapSubject);

// Is the built-in DOTE table switched on (Equivalent Subjects Mapping)?
export const builtinOn = () => useBuiltin;
// mapSubject with the built-in table ("default mapping") and your own mappings ("custom mapping") chosen separately.
export function mapperFor({ builtin = useBuiltin, custom = true } = {}) {
  if (!builtin && !custom) return () => null;
  return (code, course) => {
    if (custom)
      for (const m of maps)
        for (const l of m.legacy)
          if (l.code === code && (!l.course || l.course === course)) return { code: m.code, scheme: l.scheme || 'Legacy' };
    if (builtin) {
      const r = builtinRow(code, course);
      if (r) return { code: resolve(code, course), scheme: `${r.scheme}-Scheme` };
    }
    return null;
  };
}

// Every old / legacy code that counts as this current subject for this course: your mappings and the built-in table
// (part-time 3xxx and Tamil-medium 7xxx use the full-time table). For the common first-year courses 1000 / 3000 every
// course's equivalents are listed. → [{ code, scheme, name }]
export function equivalentsOf(code, course, { builtin = useBuiltin, custom = true } = {}) {
  const common = /^[13]000$/.test(course);
  const map = mapperFor({ builtin, custom });
  const out = new Map();
  if (custom) for (const m of maps)
    if (m.code === code && (common || !m.course || m.course === course))
      for (const l of m.legacy) if (common || !l.course || l.course === course) out.set(l.code, { code: l.code, scheme: l.scheme || 'Legacy', name: '' });
  if (builtin)
    for (const r of groups().get(code) || [])
      if (!out.has(r.code) && (common || r.course === tableCourse(course)) && (common || map(r.code, course)?.code === code))
        out.set(r.code, { code: r.code, scheme: `${r.scheme}-Scheme`, name: r.name });
  return [...out.values()].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

// Is this code the current subject of a mapping?
export const isCurrent = (code) => maps.some((m) => m.code === code);

const countOf = (code, course) => {
  const e = info.get(code);
  if (!e) return 0;
  return course ? e.byCourse.get(course) || 0 : e.n;
};

onTickets((list) => {
  tickets = list;
  info = new Map();
  for (const t of list)
    for (const s of t.subjects) {
      const e = info.get(s.code) || info.set(s.code, { name: s.name, regs: new Set(), courses: new Set(), n: 0, byCourse: new Map() }).get(s.code);
      e.regs.add(s.regulation);
      e.courses.add(t.courseNo);
      e.n++;
      e.byCourse.set(t.courseNo, (e.byCourse.get(t.courseNo) || 0) + 1);
    }
  buildIdx();
  render();
});

// The pickers list every subject: those on the hall tickets (with their student counts), plus every subject of the
// time table and every old-scheme subject in the built-in DOTE equivalents table, shown with (0) when nobody writes it.

export function equivTimetable(tt) { ttData = tt; buildIdx(); }
function buildIdx() {
  idx = new Map();
  const add = (course, courseName, reg, sem, code, name, n) => {
    const c = idx.get(course) || idx.set(course, { name: courseName || '', regs: new Map(), n: 0 }).get(course);
    if (!c.name && courseName) c.name = courseName;
    c.n += n;
    const r = c.regs.get(reg) || c.regs.set(reg, new Map()).get(reg);
    const m = r.get(String(sem || '')) || r.set(String(sem || ''), new Map()).get(String(sem || ''));
    const e = m.get(code) || m.set(code, { name, n: 0 }).get(code);
    if (!e.name) e.name = name;
    e.n += n;
  };
  for (const t of tickets) for (const s of t.subjects) add(t.courseNo, t.courseName, s.regulation, s.sem, s.code, s.name, 1);
  const names = ttData?.courses || {};
  for (const [course, scheme, sem, , , code, name] of ttData?.rows || []) add(course, names[course], scheme, sem, code.replace(/_\d+$/, ''), name, 0);
  for (const { course, code, name, sem, scheme } of builtin.values()) add(course, names[course], scheme, sem, code, name, 0);
  refreshPickers();
  fillExportCourses();
}


/* ---------- form: course → scheme → subject ---------- */
// Single-letter regulations on the hall tickets (M, N, L, …) are schemes: "M" → "M-Scheme".
function schemeLabel(reg) { return /^[A-Z]$/.test(reg) ? `${reg}-Scheme` : reg || 'Current'; }
function byNum(a, b) { return a.localeCompare(b, undefined, { numeric: true }); }
function opts(list, value, placeholder) {
  return `<option value="">${placeholder}</option>` + list.map(([v, l]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('');
}

// Fill one picker group (three selects) and keep its value where it still exists.
function fillPicker(el, want = {}) {
  const course = want.course ?? el.course.value;
  el.course.innerHTML = opts([...idx].sort(([a, x], [b, y]) => !x.n - !y.n || byNum(a, b)).map(([c, x]) => [c, `${c} – ${x.name}${x.n ? '' : ' (0)'}`]), course, idx.size ? 'Select course' : 'Upload hall tickets first');
  const regs = idx.get(el.course.value)?.regs;
  const reg = want.reg ?? el.reg.value;
  const count = (sems) => [...sems.values()].reduce((n, m) => n + m.size, 0);
  el.reg.innerHTML = opts([...(regs || [])].sort(([a], [b]) => byNum(a, b)).map(([r, sems]) => [r, `${schemeLabel(r)} · ${count(sems)} subject(s)`]), reg, regs ? 'Select scheme' : '—');
  el.reg.disabled = !regs;
  const sems = regs?.get(el.reg.value);
  const sem = want.sem ?? el.sem.value;
  el.sem.innerHTML = opts([...(sems || [])].sort(([a], [b]) => (+a || 0) - (+b || 0)).map(([n, codes]) => [n, `${n ? `Semester ${n}` : 'Semester not given'} · ${codes.size} subject(s)`]), sem, sems ? 'Select semester' : '—');
  el.sem.disabled = !sems;
  const codes = sems?.get(el.sem.value);
  const code = want.code ?? el.code.value;
  el.code.innerHTML = opts([...(codes || [])].sort(([a, x], [b, y]) => !x.n - !y.n || byNum(a, b)).map(([c, x]) => [c, `${c} – ${x.name} (${x.n})`]), code, codes ? 'Select subject' : '—');
  el.code.disabled = !codes;
}
function pickerOf(root) {
  return { course: root.querySelector('[data-f="course"]'), reg: root.querySelector('[data-f="reg"]'), sem: root.querySelector('[data-f="sem"]'), code: root.querySelector('[data-f="code"]') };
}
// Where does a saved code sit? (first course / regulation that has it)
function locate(code, course) {
  for (const [c, x] of idx) {
    if (course && c !== course) continue;
    for (const [r, sems] of x.regs) for (const [n, codes] of sems) if (codes.has(code)) return { course: c, reg: r, sem: n, code };
  }
  return { course: course || '', reg: '', sem: '', code };
}
function refreshPickers() {
  fillPicker(pickerOf($('eqCurrent')));
  $('eqLegacy').querySelectorAll('.eq-row').forEach((r) => fillPicker(pickerOf(r)));
}

let editing = null;
function legacyRow(l) {
  const div = document.createElement('div');
  div.className = 'eq-row';
  div.innerHTML = `<label class="field"><span>1. Course / Dept code *</span><select data-f="course"></select></label>
    <label class="field"><span>2. Scheme / Regulation *</span><select data-f="reg"></select></label>
    <label class="field"><span>3. Semester *</span><select data-f="sem"></select></label>
    <label class="field"><span>4. Subject *</span><select data-f="code"></select></label>
    <button type="button" class="icon-btn" data-rm title="Remove this legacy subject">✕</button>`;
  $('eqLegacy').appendChild(div);
  fillPicker(pickerOf(div), l ? locate(l.code, l.course) : { course: pickerOf($('eqCurrent')).course.value, reg: '', sem: '', code: '' });
}
function resetForm() {
  editing = null;
  $('eqForm').reset();
  fillPicker(pickerOf($('eqCurrent')), { course: '', reg: '', sem: '', code: '' });
  $('eqLegacy').innerHTML = '';
  legacyRow();
  $('eqFormTitle').textContent = 'New mapping';
  $('eqCancel').hidden = true;
}
$('eqAddRow').addEventListener('click', () => legacyRow());
$('eqCancel').addEventListener('click', resetForm);
$('eqLegacy').addEventListener('click', (e) => {
  if (!e.target.closest('[data-rm]')) return;
  e.target.closest('.eq-row').remove();
  if (!$('eqLegacy').children.length) legacyRow();
});
// Changing the course resets the scheme and subject below it; changing the scheme resets the subject.
function cascade(e) {
  const f = e.target.dataset.f;
  if (!f || f === 'code') return;
  const el = pickerOf(e.target.closest('.eq-row, #eqCurrent'));
  fillPicker(el, f === 'course' ? { reg: '', sem: '', code: '' } : f === 'reg' ? { sem: '', code: '' } : { code: '' });
  // a new legacy row starts on the current subject's course
  if (e.target.closest('#eqCurrent') && f === 'course')
    $('eqLegacy').querySelectorAll('.eq-row').forEach((r) => { const p = pickerOf(r); if (!p.code.value) fillPicker(p, { course: el.course.value, reg: '', sem: '', code: '' }); });
}
$('eqCurrent').addEventListener('change', cascade);
$('eqLegacy').addEventListener('change', cascade);

$('eqForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cur = pickerOf($('eqCurrent'));
  const code = cur.code.value;
  if (!code) return toast('Select the current subject: course, scheme, semester, then subject');
  const legacy = [...$('eqLegacy').querySelectorAll('.eq-row')]
    .map((r) => pickerOf(r))
    .filter((p) => p.code.value)
    .map((p) => ({ scheme: schemeLabel(p.reg.value), reg: p.reg.value, sem: p.sem.value, course: p.course.value, code: p.code.value }));
  if (!legacy.length) return toast('Add at least one old / legacy subject: course, scheme, semester, subject');
  if (legacy.some((l) => l.code === code)) return toast('A legacy subject cannot be the current subject itself');
  // a legacy code (for the same course) may belong to one current subject only
  for (const l of legacy) {
    const other = maps.find((m) => m.id !== editing && m.legacy.some((x) => x.code === l.code && (!x.course || !l.course || x.course === l.course)));
    if (other) return toast(`${l.code} is already mapped to ${other.code}`);
  }
  // One mapping per current subject and course: the same code may be mapped again for another course (e.g. 1020 and 7020).
  const same = maps.find((m) => m.id !== editing && m.code === code && (m.course || '') === cur.course.value);
  if (same) return toast(`${code} already has a mapping for course ${cur.course.value}. Edit it instead.`);
  const rec = { id: editing || 'm' + Date.now().toString(36), code, course: cur.course.value, reg: cur.reg.value, sem: cur.sem.value, legacy };
  maps = editing ? maps.map((m) => (m.id === editing ? rec : m)) : [...maps, rec];
  await kv.set('equiv', maps);
  toast(`${code}: ${legacy.length} legacy subject(s) mapped`);
  resetForm();
  render();
  changed();
});

/* ---------- list / search ---------- */
function render() {
  const q = $('eqSearch').value.trim().toLowerCase();
  const list = maps
    .filter((m) => !q || m.code.toLowerCase().includes(q) || (info.get(m.code)?.name || '').toLowerCase().includes(q) || m.legacy.some((l) => l.code.toLowerCase().includes(q)))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  $('eqCount').textContent = maps.length;
  $('eqBuiltinOn').checked = useBuiltin;
  const custom = !!kv.get('equivTable', null);
  $('eqBuiltinNote').textContent = `${custom ? `Your uploaded table (${tableMeta.file || 'file'}${tableMeta.at ? `, ${new Date(tableMeta.at).toLocaleDateString('en-IN')}` : ''})` : 'Built-in table'}: ${builtin.size.toLocaleString('en-IN')} old-scheme subjects (${[...new Set([...builtin.values()].map((r) => r.scheme))].sort().join(', ')}) across ${new Set([...builtin.values()].map((r) => r.course)).size} courses${useBuiltin ? ' are merged into their newer subject automatically.' : ' — switched off.'}`;
  $('eqTableReset').hidden = !custom;
  // built-in groups matching the search (only when searching; there are hundreds)
  const bi = q && useBuiltin
    ? [...groups()]
        .filter(([t, rows]) => t.toLowerCase().includes(q) || (info.get(t)?.name || '').toLowerCase().includes(q) || rows.some((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)))
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
        .slice(0, 40)
    : [];
  const biHtml = bi
    .map(([t, rows]) => {
      const cur = info.get(t);
      const parts = [{ scheme: cur ? [...cur.regs].join('/') || 'Current' : 'Newer subject', course: cur ? [...cur.courses].join(', ') : '', code: t, name: cur?.name || '', n: countOf(t), current: true }, ...rows.sort((a, b) => a.course.localeCompare(b.course) || a.scheme.localeCompare(b.scheme)).map((r) => ({ scheme: `${r.scheme}-Scheme`, course: r.course, code: r.code, name: r.name, n: countOf(r.code, r.course) + (r.course[0] === '1' ? countOf(r.code, '3' + r.course.slice(1)) + countOf(r.code, '7' + r.course.slice(1)) : 0), sem: r.sem }))];
      const total = parts.reduce((n, p) => n + p.n, 0);
      return `<div class="card eq-card builtin">
        <div class="card-head">
          <div><span class="muted">Current Subject · <span class="badge cross">Built-in DOTE equivalent</span></span><h2>${esc(t)} <span class="eq-title">${esc(cur?.name || '')}</span></h2></div>
          <div class="actions"><span class="pill">Total candidates <b>${total}</b></span></div>
        </div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th></th><th>Scheme / Regulation</th><th>Course</th><th class="num">Sem</th><th>Subject code</th><th>Subject name</th><th class="num">Candidates</th></tr></thead>
          <tbody>${parts.map((p) => `<tr${p.current ? ' class="eq-cur"' : ''}><td>${p.current ? '<span class="badge ok">Current</span>' : '<span class="badge">Old / Legacy</span>'}</td><td>${esc(p.scheme)}</td><td>${esc(p.course || '')}</td><td class="num">${p.sem || ''}</td><td><b>${esc(p.code)}</b></td><td class="wrap">${esc(p.name || (p.current ? 'not on any hall ticket' : ''))}</td><td class="num">${p.n}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>`;
    })
    .join('');
  $('eqList').innerHTML = list.length || biHtml
    ? list
        .map((m) => {
          const cur = info.get(m.code);
          const curN = countOf(m.code, m.course); // a mapping belongs to its course
          const parts = [{ scheme: cur ? [...cur.regs].join('/') || 'Current' : 'Current', course: m.course || (cur ? [...cur.courses].join(', ') : ''), code: m.code, name: cur?.name || '', n: curN, current: true }, ...m.legacy.map((l) => ({ ...l, name: info.get(l.code)?.name || '', n: countOf(l.code, l.course) }))];
          const total = parts.reduce((n, p) => n + p.n, 0);
          return `<div class="card eq-card">
            <div class="card-head">
              <div><span class="muted">Current Subject</span><h2>${esc(m.code)} <span class="eq-title">${esc(cur?.name || '')}</span>${m.course ? ` <span class="badge">Course ${esc(m.course)}</span>` : ''}</h2></div>
              <div class="actions"><span class="pill">Total candidates <b>${total}</b></span><button class="btn ghost sm" data-eqedit="${esc(m.id)}">Edit</button><button class="icon-btn" data-eqdel="${esc(m.id)}" title="Delete mapping">✕</button></div>
            </div>
            <div class="table-wrap"><table class="data">
              <thead><tr><th></th><th>Scheme / Regulation</th><th>Course</th><th>Subject code</th><th>Subject name</th><th class="num">Candidates</th></tr></thead>
              <tbody>${parts.map((p) => `<tr${p.current ? ' class="eq-cur"' : ''}><td>${p.current ? '<span class="badge ok">Current</span>' : '<span class="badge">Old / Legacy</span>'}</td><td>${esc(p.scheme || '—')}</td><td>${esc(p.course || 'any')}</td><td><b>${esc(p.code)}</b></td><td class="wrap">${esc(p.name || (p.n ? '' : 'not on any hall ticket'))}</td><td class="num">${p.n}</td></tr>`).join('')}</tbody>
            </table></div>
          </div>`;
        })
        .join('') + biHtml
    : `<p class="empty card">${q ? 'No mapping matches this search.' : maps.length ? '' : 'No mappings of your own yet. The built-in DOTE equivalents are used automatically; search above to see them, or add your own mapping to override one.'}</p>`;
}
$('eqBuiltinOn').addEventListener('change', async () => {
  useBuiltin = $('eqBuiltinOn').checked;
  await kv.set('equivBuiltin', useBuiltin);
  toast(useBuiltin ? 'Built-in DOTE equivalents switched on' : 'Built-in DOTE equivalents switched off');
  render();
  changed();
});
$('eqSearch').addEventListener('input', render);
$('eqList').addEventListener('click', async (e) => {
  const ed = e.target.closest('[data-eqedit]')?.dataset.eqedit;
  const del = e.target.closest('[data-eqdel]')?.dataset.eqdel;
  if (ed) {
    const m = maps.find((x) => x.id === ed);
    editing = m.id;
    fillPicker(pickerOf($('eqCurrent')), locate(m.code, m.course));
    $('eqLegacy').innerHTML = '';
    m.legacy.forEach((l) => legacyRow(l));
    $('eqFormTitle').textContent = `Edit mapping for ${m.code}`;
    $('eqCancel').hidden = false;
    $('eqForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (del) {
    const m = maps.find((x) => x.id === del);
    if (!confirm(`Delete the mapping for ${m.code}? Its legacy subjects will be counted separately again.`)) return;
    maps = maps.filter((x) => x.id !== del);
    await kv.set('equiv', maps);
    if (editing === del) resetForm();
    render();
    changed();
  }
});

resetForm();
render();

/* ---------- upload a DOTE equivalents table (xlsx / csv) ---------- */
// Columns are found by their heading: CNO (course), SUBCODE, SUBNAME, SEM, REGL (scheme), EQC (equivalent code);
// others (Sno, COLNO, ELEC, Elective…) are ignored. Rows of the current regulation (R20xx) or mapped to themselves are skipped.
const HEAD = { course: ['cno', 'course', 'courseno', 'coursecode'], code: ['subcode', 'subjectcode', 'code'], name: ['subname', 'subjectname', 'name'], sem: ['sem', 'semester'], scheme: ['regl', 'regulation', 'scheme'], target: ['eqc', 'equivalent', 'equivalentcode', 'eqcode'] };
const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
function tableFromRows(grid, file) {
  const at = grid.findIndex((r) => r.some((c) => /^subcode$/i.test(norm(c).replace(/\W/g, ''))) && r.some((c) => /^eqc$/i.test(norm(c).replace(/\W/g, ''))));
  const hi = at >= 0 ? at : grid.findIndex((r) => r.filter((c) => Object.values(HEAD).flat().includes(norm(c).toLowerCase().replace(/\W/g, ''))).length >= 4);
  if (hi < 0) throw new Error('Heading row not found: it needs CNO, SUBCODE, SUBNAME, SEM, REGL and EQC');
  const col = {};
  grid[hi].forEach((c, i) => { const h = norm(c).toLowerCase().replace(/\W/g, ''); for (const [k, names] of Object.entries(HEAD)) if (col[k] == null && names.includes(h)) col[k] = i; });
  for (const k of ['course', 'code', 'scheme', 'target']) if (col[k] == null) throw new Error(`Column ${k === 'course' ? 'CNO' : k === 'code' ? 'SUBCODE' : k === 'scheme' ? 'REGL' : 'EQC'} not found`);
  const rows = [];
  let skipped = 0;
  for (const r of grid.slice(hi + 1)) {
    const course = norm(r[col.course]), code = norm(r[col.code]).toUpperCase(), target = norm(r[col.target]).toUpperCase();
    const scheme = norm(r[col.scheme]).toUpperCase(), name = col.name != null ? norm(r[col.name]) : '', sem = +norm(r[col.sem]) || 0;
    if (!course && !code) continue;
    if (!course || !code || !target || code === target || /^R(\d|$)/.test(scheme)) { skipped++; continue; } // R / R2023: current subjects
    rows.push([course, code, name, sem, scheme, target]);
  }
  if (!rows.length) throw new Error('No old-scheme rows found in this file');
  return { meta: { file, rows: rows.length, at: Date.now() }, rows, skipped };
}
// csv: comma or tab separated, quoted fields allowed
function csvGrid(text) {
  const sep = (text.split(/\r?\n/)[0].match(/\t/g) || []).length > (text.split(/\r?\n/)[0].match(/,/g) || []).length ? '\t' : ',';
  return text.split(/\r?\n/).filter((l) => l.trim()).map((line) => {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === sep) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  });
}
$('eqTableInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    let t;
    if (/\.csv$|\.txt$|\.tsv$/i.test(f.name)) t = tableFromRows(csvGrid(await f.text()), f.name);
    else {
      // the list can be on any sheet (EQC.xlsx has it on Sheet2): the first sheet with the right headings is used
      const ExcelJS = await loadExcelJs();
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await f.arrayBuffer());
      for (const ws of wb.worksheets) {
        const grid = [];
        ws.eachRow({ includeEmpty: false }, (row) => grid.push(row.values.slice(1).map((v) => (v && typeof v === 'object' ? v.text ?? v.result ?? v.richText?.map((x) => x.text).join('') ?? '' : v))));
        try { t = tableFromRows(grid, `${f.name} · ${ws.name}`); break; } catch { /* not this sheet */ }
      }
      if (!t) throw new Error(`No sheet in ${f.name} has the columns CNO, SUBCODE, SUBNAME, SEM, REGL and EQC (sheets: ${wb.worksheets.map((w) => w.name).join(', ')})`);
    }
    const { skipped, ...data } = t;
    if (!(await kv.set('equivTable', data))) throw new Error('Could not save the table in this browser');
    useTable(data);
    buildIdx();
    render();
    changed();
    toast(`${data.rows.length.toLocaleString('en-IN')} equivalent rows loaded from ${f.name}${skipped ? ` · ${skipped} skipped (current regulation or no equivalent)` : ''}`);
  } catch (err) {
    console.error(err);
    toast(err.message || 'Could not read that file');
  }
});
$('eqTableReset').addEventListener('click', async () => {
  if (!confirm('Go back to the built-in DOTE equivalents table? Your uploaded table is removed from this browser.')) return;
  await kv.remove('equivTable');
  useTable(builtinData);
  buildIdx();
  render();
  changed();
  toast('Built-in equivalents table in use');
});
$('eqTableTemplate').addEventListener('click', async () => {
  const ExcelJS = await loadExcelJs();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Equivalents');
  ws.columns = [['Sno', 6], ['CNO', 8], ['SUBCODE', 12], ['SUBNAME', 40], ['SEM', 6], ['COLNO', 7], ['ELEC', 6], ['Elective', 9], ['REGL', 7], ['EQC', 14]].map(([header, width]) => ({ header, width }));
  ws.getRow(1).font = { bold: true };
  ws.addRow([1, '1020', '11001', 'COMMUNICATION ENGLISH-I', 1, 1, 0, 0, 'K', 'EN231350']);
  ws.addRow([4, '1020', '20011', 'COMMUNICATION ENGLISH-I', 1, 1, 0, 0, 'L', '30011']);
  download('Equivalent_Subjects_Template.xlsx', new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
});

/* ---------- export the mappings in use (xlsx, DOTE format) ---------- */
// Your mappings first, then the equivalents table (built-in or uploaded) when it is switched on; a table row your own
// mapping overrides is left out. Same columns as DOTE's list plus SOURCE, so the file can be uploaded again.
// What to export: custom (yours), default (the DOTE table: built-in or uploaded) or both; all courses or one course.
// For one course the default rows are that course's table rows — part-time 3xxx and Tamil-medium 7xxx use the full-time
// 1xxx rows, written with the chosen course code (SOURCE names the table course they came from).
function fillExportCourses() {
  const sel = $('eqExpCourse');
  const keep = sel.value;
  const names = new Map([...idx].map(([c, x]) => [c, x.name]));
  const courses = new Set([...idx].filter(([, x]) => x.n > 0).map(([c]) => c));
  for (const m of maps) { if (m.course) courses.add(m.course); for (const l of m.legacy) if (l.course) courses.add(l.course); }
  sel.innerHTML = '<option value="">All courses</option>' + [...courses].sort().map((c) => `<option value="${esc(c)}">${esc(c)}${names.get(c) ? ' – ' + esc(names.get(c)) : ''}</option>`).join('');
  sel.value = [...courses].includes(keep) ? keep : '';
}
$('eqExpCourse').addEventListener('focus', fillExportCourses);
$('eqExportBtn').addEventListener('click', async () => {
  const what = $('eqExpWhat').value; // all | custom | default
  const course = $('eqExpCourse').value;
  const rows = [];
  const mine = new Set();
  if (what !== 'default')
    for (const m of maps)
      for (const l of m.legacy) {
        const c = l.course || m.course || '';
        if (course && c && c !== course) continue;
        mine.add(`${c}|${l.code}`);
        rows.push([c, l.code, info.get(l.code)?.name || builtinRow(l.code, l.course)?.name || '', +l.sem || '', l.reg || String(l.scheme || '').replace(/-Scheme$/, ''), m.code, 'Custom']);
      }
  const uploaded = !!kv.get('equivTable', null);
  const table = uploaded ? 'Uploaded table' : 'Built-in table';
  if (what !== 'custom') {
    const from = course ? tableCourse(course) : '';
    for (const r of builtin.values()) {
      if (course && r.course !== from) continue;
      const c = course || r.course;
      if (what === 'all' && mine.has(`${c}|${r.code}`)) continue; // your mapping wins
      rows.push([c, r.code, r.name, r.sem || '', r.scheme, course ? resolve(r.code, course) : r.target, from && from !== course ? `${table} (${from})` : table]);
    }
  }
  if (!rows.length) return toast(`No ${what === 'custom' ? 'custom ' : what === 'default' ? 'default ' : ''}mappings${course ? ` for course ${course}` : ''}`);
  rows.sort((x, y) => String(x[0]).localeCompare(String(y[0])) || (+x[3] || 0) - (+y[3] || 0) || String(x[1]).localeCompare(String(y[1]), undefined, { numeric: true }));
  const ExcelJS = await loadExcelJs();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Equivalents');
  ws.columns = [['Sno', 6], ['CNO', 8], ['SUBCODE', 12], ['SUBNAME', 42], ['SEM', 6], ['COLNO', 7], ['ELEC', 6], ['Elective', 9], ['REGL', 7], ['EQC', 14], ['SOURCE', 22]].map(([header, width]) => ({ header, width }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  rows.forEach(([c, code, name, sem, regl, eqc, src], i) => ws.addRow([i + 1, c, code, name, sem, 1, 0, 0, regl, eqc, src]));
  ws.autoFilter = { from: 'A1', to: 'K1' };
  const label = { all: 'All', custom: 'Custom', default: 'Default' }[what];
  download(`Equivalent_Mapping_${label}${course ? '_' + course : ''}_${new Date().toISOString().slice(0, 10)}.xlsx`, new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  toast(`${rows.length} ${label.toLowerCase()} mapping row(s) exported${course ? ` for course ${course}` : ''}${what !== 'custom' && !useBuiltin ? ' (note: the default table is switched off for counting)' : ''}`);
});
