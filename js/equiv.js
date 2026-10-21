// Equivalent Subjects Mapping: one Current Subject ← many Old / Legacy Subjects (other schemes / regulations)
// that share its question paper. QP statistics and seating merge them under the current subject code.
// kv "equiv": [{ id, code, legacy: [{ scheme, course, code }] }]
import { kv, kvReady } from './kv.js';
import { onTickets, setCodeMapper, htReload } from './halltickets.js';
import { $, esc, toast } from './util.js';

await kvReady;

let maps = kv.get('equiv', []);
let tickets = [];
let info = new Map(); // code → { name, regs: Set, courses: Set, n, byCourse: Map(course → n) }
let idx = new Map(); // course → { name, regs: Map(regulation → Map(code → { name, n })) } — what that course's students write
const listeners = [];

export const equivMaps = () => maps;
export function onEquiv(fn) {
  listeners.push(fn);
  fn(maps);
}
// A new / changed mapping can move legacy subjects onto a date set for their current subject.
const changed = () => { htReload(); listeners.forEach((fn) => fn(maps)); };
export function equivReload() {
  maps = kv.get('equiv', []);
  render();
  changed();
}

// legacy code (+ course) → { code: current code, scheme }
export function mapSubject(code, course) {
  for (const m of maps)
    for (const l of m.legacy)
      if (l.code === code && (!l.course || l.course === course)) return { code: m.code, scheme: l.scheme || 'Legacy' };
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
  idx = new Map();
  for (const t of list) {
    const c = idx.get(t.courseNo) || idx.set(t.courseNo, { name: t.courseName, regs: new Map() }).get(t.courseNo);
    for (const s of t.subjects) {
      const r = c.regs.get(s.regulation) || c.regs.set(s.regulation, new Map()).get(s.regulation);
      const e = r.get(s.code) || r.set(s.code, { name: s.name, n: 0 }).get(s.code);
      e.n++;
    }
  }
  refreshPickers();
  render();
});


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
  el.course.innerHTML = opts([...idx].sort(([a], [b]) => byNum(a, b)).map(([c, x]) => [c, `${c} – ${x.name}`]), course, idx.size ? 'Select course' : 'Upload hall tickets first');
  const regs = idx.get(el.course.value)?.regs;
  const reg = want.reg ?? el.reg.value;
  el.reg.innerHTML = opts([...(regs || [])].sort(([a], [b]) => byNum(a, b)).map(([r, codes]) => [r, `${schemeLabel(r)} · ${codes.size} subject(s)`]), reg, regs ? 'Select scheme' : '—');
  el.reg.disabled = !regs;
  const codes = regs?.get(el.reg.value);
  const code = want.code ?? el.code.value;
  el.code.innerHTML = opts([...(codes || [])].sort(([a], [b]) => byNum(a, b)).map(([c, x]) => [c, `${c} – ${x.name} (${x.n})`]), code, codes ? 'Select subject' : '—');
  el.code.disabled = !codes;
}
function pickerOf(root) {
  return { course: root.querySelector('[data-f="course"]'), reg: root.querySelector('[data-f="reg"]'), code: root.querySelector('[data-f="code"]') };
}
// Where does a saved code sit? (first course / regulation that has it)
function locate(code, course) {
  for (const [c, x] of idx) {
    if (course && c !== course) continue;
    for (const [r, codes] of x.regs) if (codes.has(code)) return { course: c, reg: r, code };
  }
  return { course: course || '', reg: '', code };
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
    <label class="field"><span>3. Subject *</span><select data-f="code"></select></label>
    <button type="button" class="icon-btn" data-rm title="Remove this legacy subject">✕</button>`;
  $('eqLegacy').appendChild(div);
  fillPicker(pickerOf(div), l ? locate(l.code, l.course) : { course: pickerOf($('eqCurrent')).course.value, reg: '', code: '' });
}
function resetForm() {
  editing = null;
  $('eqForm').reset();
  fillPicker(pickerOf($('eqCurrent')), { course: '', reg: '', code: '' });
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
  fillPicker(el, f === 'course' ? { reg: '', code: '' } : { code: '' });
  // a new legacy row starts on the current subject's course
  if (e.target.closest('#eqCurrent') && f === 'course')
    $('eqLegacy').querySelectorAll('.eq-row').forEach((r) => { const p = pickerOf(r); if (!p.code.value) fillPicker(p, { course: el.course.value, reg: '', code: '' }); });
}
$('eqCurrent').addEventListener('change', cascade);
$('eqLegacy').addEventListener('change', cascade);

$('eqForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cur = pickerOf($('eqCurrent'));
  const code = cur.code.value;
  if (!code) return toast('Select the current subject: course, then scheme, then subject');
  const legacy = [...$('eqLegacy').querySelectorAll('.eq-row')]
    .map((r) => pickerOf(r))
    .filter((p) => p.code.value)
    .map((p) => ({ scheme: schemeLabel(p.reg.value), reg: p.reg.value, course: p.course.value, code: p.code.value }));
  if (!legacy.length) return toast('Add at least one old / legacy subject: course, scheme, subject');
  if (legacy.some((l) => l.code === code)) return toast('A legacy subject cannot be the current subject itself');
  // a legacy code (for the same course) may belong to one current subject only
  for (const l of legacy) {
    const other = maps.find((m) => m.id !== editing && m.legacy.some((x) => x.code === l.code && (!x.course || !l.course || x.course === l.course)));
    if (other) return toast(`${l.code} is already mapped to ${other.code}`);
  }
  if (maps.some((m) => m.id !== editing && m.code === code)) return toast(`${code} already has a mapping. Edit it instead.`);
  const rec = { id: editing || 'm' + Date.now().toString(36), code, course: cur.course.value, reg: cur.reg.value, legacy };
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
  $('eqList').innerHTML = list.length
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
        .join('')
    : `<p class="empty card">${maps.length ? 'No mapping matches this search.' : 'No mappings yet. Add one above: pick the current subject, then its old / legacy subject codes.'}</p>`;
}
$('eqSearch').addEventListener('input', render);
$('eqList').addEventListener('click', async (e) => {
  const ed = e.target.closest('[data-eqedit]')?.dataset.eqedit;
  const del = e.target.closest('[data-eqdel]')?.dataset.eqdel;
  if (ed) {
    const m = maps.find((x) => x.id === ed);
    editing = m.id;
    fillPicker(pickerOf($('eqCurrent')), m.course ? { course: m.course, reg: m.reg ?? locate(m.code, m.course).reg, code: m.code } : locate(m.code));
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
