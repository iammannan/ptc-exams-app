// Equivalent Subjects Mapping: one Current Subject ← many Old / Legacy Subjects (other schemes / regulations)
// that share its question paper. QP statistics and seating merge them under the current subject code.
// kv "equiv": [{ id, code, legacy: [{ scheme, course, code }] }] — your own mappings, which always win.
// Built in: DOTE's equivalent-subject table (js/data/equivalents.js, K/L/M/N scheme → newer code), on unless switched off.
import { kv, kvReady } from './kv.js';
import builtinData from './data/equivalents.js';
import { onTickets, setCodeMapper, htReload } from './halltickets.js';
import { $, esc, toast } from './util.js';

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
  render();
  changed();
}

/* ---------- built-in DOTE equivalents ---------- */
const builtin = new Map(); // 'course|old code' → { course, code, name, sem, scheme, target }
for (const [course, code, name, sem, scheme, target] of builtinData.rows) builtin.set(course + '|' + code, { course, code, name, sem, scheme, target });
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
  if (maps.some((m) => m.id !== editing && m.code === code)) return toast(`${code} already has a mapping. Edit it instead.`);
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
  $('eqBuiltinNote').textContent = `${builtin.size.toLocaleString('en-IN')} old-scheme subjects (K, L, M, N) across ${new Set([...builtin.values()].map((r) => r.course)).size} courses${useBuiltin ? ' are merged into their newer subject automatically.' : ' — switched off.'}`;
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
          const curN = countOf(m.code);
          const parts = [{ scheme: cur ? [...cur.regs].join('/') || 'Current' : 'Current', course: cur ? [...cur.courses].join(', ') : '', code: m.code, name: cur?.name || '', n: curN, current: true }, ...m.legacy.map((l) => ({ ...l, name: info.get(l.code)?.name || '', n: countOf(l.code, l.course) }))];
          const total = parts.reduce((n, p) => n + p.n, 0);
          return `<div class="card eq-card">
            <div class="card-head">
              <div><span class="muted">Current Subject</span><h2>${esc(m.code)} <span class="eq-title">${esc(cur?.name || '')}</span></h2></div>
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
