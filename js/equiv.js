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
  $('eqCodes').innerHTML = [...info]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([c, e]) => `<option value="${esc(c)}">${esc(e.name)} · ${esc([...e.courses].join(', '))} · ${esc([...e.regs].join('/'))}</option>`)
    .join('');
  render();
});


/* ---------- form ---------- */
let editing = null;
function legacyRow(l = {}) {
  const div = document.createElement('div');
  div.className = 'eq-row';
  div.innerHTML = `<label class="field"><span>Scheme / Regulation</span><input data-f="scheme" list="eqSchemes" maxlength="20" placeholder="e.g. M-Scheme" value="${esc(l.scheme || '')}" /></label>
    <label class="field"><span>Course / Dept code</span><input data-f="course" maxlength="10" placeholder="any" value="${esc(l.course || '')}" /></label>
    <label class="field"><span>Subject code *</span><input data-f="code" list="eqCodes" maxlength="20" value="${esc(l.code || '')}" /></label>
    <span class="muted eq-name">${esc(info.get(l.code)?.name || '')}</span>
    <button type="button" class="icon-btn" data-rm title="Remove this legacy subject">✕</button>`;
  $('eqLegacy').appendChild(div);
}
function resetForm() {
  editing = null;
  $('eqForm').reset();
  $('eqLegacy').innerHTML = '';
  legacyRow();
  $('eqName').textContent = '—';
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
$('eqLegacy').addEventListener('input', (e) => {
  if (e.target.dataset.f !== 'code') return;
  e.target.closest('.eq-row').querySelector('.eq-name').textContent = info.get(e.target.value.trim().toUpperCase())?.name || '';
});
$('eqCode').addEventListener('input', () => {
  const e = info.get($('eqCode').value.trim().toUpperCase());
  $('eqName').textContent = e ? `${e.name} · ${[...e.regs].join('/')} · course ${[...e.courses].join(', ')}` : '—';
});

$('eqForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('eqCode').value.trim().toUpperCase();
  const legacy = [...$('eqLegacy').querySelectorAll('.eq-row')]
    .map((r) => ({ scheme: r.querySelector('[data-f="scheme"]').value.trim(), course: r.querySelector('[data-f="course"]').value.trim(), code: r.querySelector('[data-f="code"]').value.trim().toUpperCase() }))
    .filter((l) => l.code);
  if (!legacy.length) return toast('Add at least one old / legacy subject code');
  if (legacy.some((l) => l.code === code)) return toast('A legacy subject cannot be the current subject itself');
  // a legacy code (for the same course) may belong to one current subject only
  for (const l of legacy) {
    const other = maps.find((m) => m.id !== editing && m.legacy.some((x) => x.code === l.code && (!x.course || !l.course || x.course === l.course)));
    if (other) return toast(`${l.code} is already mapped to ${other.code}`);
  }
  if (maps.some((m) => m.id !== editing && m.code === code)) return toast(`${code} already has a mapping. Edit it instead.`);
  const rec = { id: editing || 'm' + Date.now().toString(36), code, legacy };
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
    $('eqCode').value = m.code;
    $('eqCode').dispatchEvent(new Event('input'));
    $('eqLegacy').innerHTML = '';
    m.legacy.forEach(legacyRow);
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
