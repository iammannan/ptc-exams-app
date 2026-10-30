// Equivalent Subjects Mapping → Edit mappings: every mapping on one spreadsheet-like page. Table rows are the equivalents
// table in use (your uploaded .xlsx / .csv, or the built-in one); Yours rows are your own mappings (kv "equiv"), which win.
// Edits stay in this draft until Save: filter, edit cells, paste from Excel, add / delete, undo, then one save.
import { $, esc, toast } from './util.js';
import { editorData, saveEdits } from './equiv.js';

const PAGE = 100;
const FIELDS = ['course', 'code', 'name', 'sem', 'col', 'scheme', 'target', 'exam']; // the columns, in order
const MINE_LOCKED = new Set(['name', 'col', 'exam']); // your own mappings don't store these: they come from the table
const LABEL = { course: 'CNO', code: 'SUBCODE', name: 'SUBNAME', sem: 'SEM', col: 'COLNO', scheme: 'REGL', target: 'EQC', exam: 'END EXAM' };
const isCurrent = (scheme) => /^R(\d|$)/i.test(scheme);

let src = null;
let draft = []; // rows: { id, mine, course, code, name, sem, col, scheme, target, exam, del, isNew, was, orig, mapCourse, follow }
let view = [], page = 0;
let sel = new Set(), undo = [], redo = [];
let issues = new Map(); // row → { err: [], warn: [] }
let nextId = 1;
const byId = new Map();

function norm(k, v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (k === 'code' || k === 'scheme') return s.toUpperCase();
  if (k === 'target') return s.toUpperCase().replace(/\s+/g, '');
  if (k === 'sem' || k === 'col') return /^\d+$/.test(s) ? +s : '';
  if (k === 'exam') { const u = s.toUpperCase(); return !u ? '' : u[0] === 'T' ? 'T' : u[0] === 'P' ? 'P' : 'NA'; }
  return s;
}
function makeRow(fields, extra = {}) {
  const r = { id: nextId++, mine: false, del: false, isNew: false, ...extra };
  for (const k of FIELDS) r[k] = norm(k, fields[k]);
  r.was = Object.fromEntries(FIELDS.map((k) => [k, r[k]]));
  byId.set(r.id, r);
  return r;
}
const isGone = (r) => r.isNew && (r.del || (!r.code && !r.target && !r.name)); // added, then deleted or left empty: as if it never was
const fieldChanged = (r, k) => !r.isNew && r[k] !== r.was[k];
const isEdited = (r) => !r.isNew && !r.del && FIELDS.some((k) => fieldChanged(r, k));
const isChanged = (r) => !isGone(r) && (r.isNew || r.del || isEdited(r));

function load() {
  src = editorData();
  byId.clear();
  draft = src.base.rows.map((a) => {
    const [course, code, name, sem, scheme, target, exam, col] = a;
    return makeRow({ course, code, name, sem: sem || '', scheme, target, exam, col }, { orig: a });
  });
  for (const m of src.maps)
    for (const l of m.legacy)
      draft.push(makeRow({ course: l.course || '', code: l.code, sem: l.sem || '', scheme: l.reg || String(l.scheme || '').replace(/-Scheme$/, ''), target: m.code }, { mine: true, mapCourse: m.course || '', follow: (m.course || '') === (l.course || '') }));
  view = []; page = 0; sel = new Set(); undo = []; redo = [];
}

/* ---------- checks ---------- */
function check() {
  issues = new Map();
  const live = draft.filter((r) => !r.del && !isGone(r));
  const seen = new Map(); // table: 'course|code|target' → rows; same old code with another EQC but the same name
  const named = new Map();
  const mine = new Map();
  for (const r of live) {
    if (r.mine) (mine.get(r.code) || mine.set(r.code, []).get(r.code)).push(r);
    else if (r.code) {
      const k = [r.course, r.code, r.target].join('|');
      (seen.get(k) || seen.set(k, []).get(k)).push(r);
      const n = [r.course, r.code, r.name.toUpperCase()].join('|');
      (named.get(n) || named.set(n, []).get(n)).push(r);
    }
  }
  const add = (r, kind, msg) => { const x = issues.get(r) || issues.set(r, { err: [], warn: [] }).get(r); x[kind].push(msg); };
  for (const r of live) {
    if (!r.target) add(r, 'err', 'EQC is missing');
    if (r.mine) {
      if (!r.code) add(r, 'err', 'SUBCODE is missing');
      else if (r.code === r.target) add(r, 'err', 'A subject cannot map to itself');
      const other = (mine.get(r.code) || []).find((x) => x !== r && (!x.course || !r.course || x.course === r.course));
      if (other) add(r, 'err', `${r.code} is already mapped to ${other.target} in your mappings`);
      continue;
    }
    if (!r.course) add(r, 'err', 'CNO is missing');
    if (!r.scheme) add(r, 'warn', 'REGL is empty');
    if (isCurrent(r.scheme)) { if (!r.exam) add(r, 'warn', `${r.scheme} rows only give the End Exam: choose T, P or NA`); continue; }
    if (!r.code && r.col === '') add(r, 'warn', 'No SUBCODE and no COLNO: it cannot match any hall-ticket subject');
    if (r.code && r.code === r.target && !r.exam) add(r, 'warn', 'Maps to itself and has no End Exam: it does nothing');
    if (r.code && (seen.get([r.course, r.code, r.target].join('|')) || []).length > 1) add(r, 'warn', 'The same row appears more than once');
    else if (r.code && new Set((named.get([r.course, r.code, r.name.toUpperCase()].join('|')) || []).map((x) => x.target)).size > 1) add(r, 'warn', 'Same old subject with two different EQCs');
  }
  // counts
  const list = draft.filter(isChanged);
  const edited = list.filter(isEdited).length, added = list.filter((r) => r.isNew).length, deleted = list.filter((r) => r.del).length;
  const errs = [...issues.values()].filter((x) => x.err.length).length, warns = issues.size - errs;
  $('edSummary').innerHTML = [edited && `<b>${edited}</b> edited`, added && `<b>${added}</b> added`, deleted && `<b>${deleted}</b> deleted`].filter(Boolean).join(' · ') || 'No changes yet';
  $('edIssues').textContent = [errs && `${errs} to fix before saving`, warns && `${warns} warning(s)`].filter(Boolean).join(' · ');
  $('edSave').disabled = !list.length;
  $('edUndo').disabled = !undo.length;
  $('edRedo').disabled = !redo.length;
  const opt = (v, text) => { $('edView').querySelector(`option[value="${v}"]`).textContent = text; };
  opt('changes', `My changes (${list.length})`);
  opt('problems', `Problems (${issues.size})`);
}

/* ---------- filter ---------- */
function fillFilters() {
  const keep = (id, opts, first) => {
    const el = $(id), v = el.value;
    el.innerHTML = `<option value="">${first}</option>` + opts.map(([val, text]) => `<option value="${esc(val)}">${esc(text)}</option>`).join('');
    el.value = opts.some(([val]) => String(val) === v) ? v : '';
  };
  const uniq = (k) => [...new Set(draft.filter((r) => !isGone(r)).map((r) => r[k]))].filter((x) => x !== '');
  keep('edCourse', uniq('course').sort().map((c) => [c, src.courseName(c) ? `${c} – ${src.courseName(c)}` : c]), 'All courses');
  keep('edScheme', uniq('scheme').sort().map((s) => [s, s]), 'All schemes');
  keep('edSem', uniq('sem').sort((a, b) => a - b).map((s) => [s, `Sem ${s}`]), 'All semesters');
}
function filter() {
  const q = $('edSearch').value.trim().toLowerCase();
  const course = $('edCourse').value, scheme = $('edScheme').value, sem = $('edSem').value, exam = $('edExam').value, from = $('edSrc').value, show = $('edView').value;
  view = draft.filter((r) => {
    if (r.isNew && !r.del && !r.code && !r.target) return true; // a row you are adding stays in sight until it is filled in
    if (isGone(r)) return false;
    if (r.del && show !== 'changes') return false;
    if (show === 'changes' && !isChanged(r)) return false;
    if (show === 'problems' && !issues.has(r)) return false;
    if (show === 'tickets' && !src.candidates(r.code, r.course)) return false;
    if (course && r.course !== course) return false;
    if (scheme && r.scheme !== scheme) return false;
    if (sem && String(r.sem) !== sem) return false;
    if (exam && (exam === 'none' ? r.exam : r.exam !== exam)) return false;
    if (from && (from === 'mine') !== r.mine) return false;
    return !q || [r.code, r.target, r.name, r.course].some((x) => String(x).toLowerCase().includes(q)) || (r.mine && src.subjectName(r.code, r.course).toLowerCase().includes(q));
  });
  page = 0;
  sel = new Set();
  renderPage();
}

/* ---------- table ---------- */
function cell(r, k) {
  const locked = r.del || (r.mine && MINE_LOCKED.has(k));
  if (k === 'exam')
    return `<select data-k="exam" aria-label="${LABEL[k]}"${locked ? ' disabled' : ''}>${['', 'T', 'P', 'NA'].map((v) => `<option value="${v}">${v || '—'}</option>`).join('')}</select>`;
  return `<input data-k="${k}" aria-label="${LABEL[k]}" autocomplete="off" spellcheck="false"${locked ? ' disabled' : ''}${k === 'sem' || k === 'col' ? ' inputmode="numeric"' : ''} />`;
}
function rowHtml(r) {
  return `<tr data-id="${r.id}">
    <td><input type="checkbox" data-sel aria-label="Select row" /></td>
    <td><span class="badge ${r.mine ? 'manual' : 'unsched'}" title="${r.mine ? 'Your own mapping: it wins over the table and stays when a new table is uploaded' : 'A row of the equivalents table'}">${r.mine ? 'Yours' : 'Table'}</span></td>
    ${FIELDS.map((k) => `<td>${cell(r, k)}</td>`).join('')}
    <td class="ed-note"></td>
    <td class="num">${src.candidates(r.code, r.course) || ''}</td>
    <td><button type="button" class="icon-btn" data-del></button></td>
  </tr>`;
}
// Fills a row's cells from the draft, in place: focus stays where it is while editing.
function paint(tr) {
  const r = byId.get(+tr.dataset.id);
  const x = issues.get(r);
  tr.className = [r.del && 'ed-del', r.isNew && 'ed-new', x?.err.length && 'ed-err'].filter(Boolean).join(' ');
  tr.querySelector('[data-sel]').checked = sel.has(r);
  for (const el of tr.querySelectorAll('[data-k]')) {
    const k = el.dataset.k;
    const v = r.mine && k === 'name' ? src.subjectName(r.code, r.course) : String(r[k]);
    if (el !== document.activeElement || el.tagName === 'SELECT') el.value = v;
    el.classList.toggle('chg', fieldChanged(r, k));
    el.title = r[k] !== r.was[k] && !r.isNew ? `Was: ${r.was[k] === '' ? '(empty)' : r.was[k]}` : '';
  }
  const newName = r.target.split('/').map((t) => src.subjectName(t, r.course)).filter(Boolean).join(' / ');
  const wins = !r.mine && !r.del && draft.find((m) => m.mine && !m.del && m.code === r.code && m.code && (!m.course || m.course === r.course));
  tr.querySelector('.ed-note').innerHTML = (newName ? `<span title="${esc(newName)}">${esc(newName)}</span>` : r.target ? '<span class="muted">Subject name not known</span>' : '')
    + (wins ? `<div class="ed-wins">Your mapping → ${esc(wins.target)} wins</div>` : '')
    + (x ? [...x.err.map((m) => `<div class="ed-msg err">${esc(m)}</div>`), ...x.warn.map((m) => `<div class="ed-msg warn">${esc(m)}</div>`)].join('') : '');
  const b = tr.querySelector('[data-del]');
  b.textContent = r.del ? '↺' : '✕';
  b.title = r.del ? 'Restore this row' : 'Delete this row';
}
const paintAll = () => $('edBody').querySelectorAll('tr').forEach(paint);
function renderPage() {
  const pages = Math.max(1, Math.ceil(view.length / PAGE));
  page = Math.min(page, pages - 1);
  const rows = view.slice(page * PAGE, (page + 1) * PAGE);
  $('edBody').innerHTML = rows.map(rowHtml).join('');
  $('edEmpty').hidden = rows.length > 0;
  paintAll();
  $('edPage').textContent = view.length ? `${(page * PAGE + 1).toLocaleString('en-IN')}–${(page * PAGE + rows.length).toLocaleString('en-IN')} of ${view.length.toLocaleString('en-IN')}` : '0 rows';
  $('edPrev').disabled = page === 0;
  $('edNext').disabled = page >= pages - 1;
  $('edWrap').scrollTop = 0;
  renderSel();
}
function renderSel() {
  $('edBulk').hidden = !sel.size;
  $('edSelCount').textContent = `${sel.size} selected`;
  $('edAll').checked = view.length > 0 && sel.size === view.filter((r) => !r.del).length;
}

/* ---------- edits (every one can be undone) ---------- */
function commit(changes) {
  if (!changes.length) return;
  for (const c of changes) c.row[c.k] = c.to;
  undo.push(changes);
  redo = [];
  refresh();
}
function refresh() { check(); paintAll(); $('edMsg').textContent = ''; }
const change = (row, k, v) => { const to = k === 'del' ? v : norm(k, v); return row[k] === to ? [] : [{ row, k, from: row[k], to }]; };
function editCell(row, k, value) {
  if (row.mine && MINE_LOCKED.has(k)) return [];
  const out = change(row, k, value);
  // SUBNAME left empty: filled in from the table or the hall tickets when the code is known
  if (k === 'code' && out.length && !row.mine && !row.name) out.push(...change(row, 'name', src.subjectName(out[0].to, row.course)));
  return out;
}
function step(from, to) {
  const op = from.pop();
  if (!op) return;
  const rev = from === undo;
  for (const c of rev ? [...op].reverse() : op) c.row[c.k] = rev ? c.from : c.to;
  to.push(op);
  check();
  renderPage();
}
function addRow(fields, after) {
  const r = makeRow(fields, { isNew: true, mine: $('edSrc').value === 'mine', mapCourse: fields.course || '', follow: true });
  if (after) { draft.splice(draft.indexOf(after) + 1, 0, r); view.splice(view.indexOf(after) + 1, 0, r); }
  else { draft.unshift(r); view.unshift(r); }
  return r;
}
function focusCell(r, k) {
  const el = $('edBody').querySelector(`tr[data-id="${r.id}"] [data-k="${k}"]`);
  if (el && !el.disabled) { el.focus(); el.select?.(); el.closest('tr').scrollIntoView({ block: 'nearest' }); }
}

$('edBody').addEventListener('change', (e) => {
  const tr = e.target.closest('tr'), r = byId.get(+tr?.dataset.id);
  if (!r) return;
  if (e.target.matches('[data-sel]')) {
    if (e.target.checked) sel.add(r); else sel.delete(r);
    return renderSel();
  }
  const k = e.target.dataset.k;
  if (!k) return;
  const out = editCell(r, k, e.target.value);
  commit(out);
  if (!out.length) e.target.value = String(r[k]);
  else if (document.activeElement === e.target) e.target.value = String(r[k]);
});
$('edBody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del]');
  if (!b) return;
  const r = byId.get(+b.closest('tr').dataset.id);
  commit(change(r, 'del', !r.del));
  // a deleted row leaves the list (My changes keeps it, with Restore)
  if (r.del && $('edView').value !== 'changes') { view = view.filter((x) => x !== r); sel.delete(r); renderPage(); }
  else if (!r.del || $('edView').value === 'changes') renderPage();
});
$('edBody').addEventListener('keydown', (e) => {
  const el = e.target;
  if (el.tagName !== 'INPUT' || !el.dataset.k) return;
  if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const r = byId.get(+el.closest('tr').dataset.id);
  el.blur(); // commits the cell
  const next = view[view.indexOf(r) + (e.key === 'ArrowUp' ? -1 : 1)];
  if (!next) return el.focus();
  const at = view.indexOf(next);
  if (Math.floor(at / PAGE) !== page) { page = Math.floor(at / PAGE); renderPage(); }
  focusCell(next, el.dataset.k);
});
// Paste a block from Excel: cells fill from here across and down. From a new row, extra lines become new rows.
$('edBody').addEventListener('paste', (e) => {
  const el = e.target;
  if (!el.dataset?.k) return;
  const text = e.clipboardData?.getData('text') || '';
  if (!/[\t\n]/.test(text.trim())) return; // one value: the normal paste
  e.preventDefault();
  const lines = text.replace(/\r/g, '').replace(/\n+$/, '').split('\n').map((l) => l.split('\t'));
  const start = byId.get(+el.closest('tr').dataset.id);
  const first = FIELDS.indexOf(el.dataset.k);
  let at = view.indexOf(start), left = 0;
  const out = [];
  let prev = null;
  for (const cells of lines) {
    let r = view[at];
    if (!r || (start.isNew && !r.isNew)) {
      if (!start.isNew) { left++; continue; }
      r = addRow({}, prev || start);
      out.push({ row: r, k: 'del', from: true, to: false });
    }
    cells.forEach((v, i) => { const k = FIELDS[first + i]; if (k && !r.del) out.push(...editCell(r, k, v)); });
    prev = r;
    at = view.indexOf(r) + 1;
  }
  commit(out);
  renderPage();
  $('edMsg').textContent = `Pasted ${lines.length - left} line(s)${left ? `; ${left} past the end of the list were left out` : ''}.`;
});

/* ---------- toolbar ---------- */
for (const id of ['edCourse', 'edScheme', 'edSem', 'edExam', 'edSrc', 'edView']) $(id).addEventListener('change', filter);
let searchTimer = 0;
$('edSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(filter, 150); });
$('edPrev').addEventListener('click', () => { page--; renderPage(); });
$('edNext').addEventListener('click', () => { page++; renderPage(); });
$('edUndo').addEventListener('click', () => step(undo, redo));
$('edRedo').addEventListener('click', () => step(redo, undo));
$('edAdd').addEventListener('click', () => {
  const r = addRow({ course: $('edCourse').value, scheme: $('edScheme').value, sem: $('edSem').value });
  undo.push([{ row: r, k: 'del', from: true, to: false }]);
  redo = [];
  page = 0;
  check();
  renderPage();
  focusCell(r, r.course ? 'code' : 'course');
});
$('edAll').addEventListener('change', (e) => {
  sel = e.target.checked ? new Set(view.filter((r) => !r.del)) : new Set();
  paintAll();
  renderSel();
});
$('edBulkExam').addEventListener('change', (e) => {
  const v = e.target.value;
  e.target.value = 'keep';
  if (v === 'keep') return;
  commit([...sel].filter((r) => !r.mine).flatMap((r) => change(r, 'exam', v)));
});
$('edBulkEqcBtn').addEventListener('click', () => {
  const v = norm('target', $('edBulkEqc').value);
  if (!v) return $('edBulkEqc').focus();
  commit([...sel].flatMap((r) => change(r, 'target', v)));
  $('edBulkEqc').value = '';
});
$('edBulkDel').addEventListener('click', () => {
  commit([...sel].flatMap((r) => change(r, 'del', true)));
  if ($('edView').value !== 'changes') view = view.filter((r) => !r.del);
  sel = new Set();
  renderPage();
});
$('edBulkClear').addEventListener('click', () => { sel = new Set(); paintAll(); renderSel(); });

/* ---------- open / close / save ---------- */
function tryClose() {
  const n = draft.filter(isChanged).length;
  if (n && !confirm(`Discard ${n} unsaved change(s)?`)) return;
  $('edDlg').close();
}
$('edClose').addEventListener('click', tryClose);
$('edCancel').addEventListener('click', tryClose);
$('edDlg').addEventListener('cancel', (e) => { e.preventDefault(); tryClose(); });
$('edDlg').addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  if (key === 's') { e.preventDefault(); document.activeElement?.blur?.(); if (!$('edSave').disabled) save(); return; }
  if (key !== 'z' && key !== 'y') return;
  // while typing in a cell the browser undoes the typing; after that, the last edit
  const el = document.activeElement, r = byId.get(+el?.closest?.('tr')?.dataset.id);
  if (r && el.dataset.k && el.value !== String(r[el.dataset.k])) return;
  if (el === $('edSearch') || el === $('edBulkEqc')) return;
  e.preventDefault();
  if (key === 'y' || e.shiftKey) step(redo, undo); else step(undo, redo);
});

function buildTable() {
  const rows = draft.filter((r) => !r.mine && !r.del && !isGone(r));
  const toArray = (r) => (r.orig && !isEdited(r) ? r.orig : [r.course, r.code, r.name, r.sem, r.scheme, r.target, r.exam, r.col]);
  // new rows last: when a table gives an old code twice, the later row counts
  return [...rows.filter((r) => !r.isNew), ...rows.filter((r) => r.isNew)].map(toArray);
}
function buildMaps() {
  const groups = new Map();
  for (const r of draft) {
    if (!r.mine || r.del || isGone(r)) continue;
    const course = r.follow ? r.course : r.mapCourse;
    const k = r.target + '|' + course;
    (groups.get(k) || groups.set(k, { code: r.target, course, rows: [] }).get(k)).rows.push(r);
  }
  let n = 0;
  return [...groups.values()].map(({ code, course, rows }) => {
    const old = src.maps.find((m) => m.code === code && (m.course || '') === course);
    return {
      ...(old || { id: 'm' + Date.now().toString(36) + n++, reg: '', sem: '' }), code, course,
      legacy: rows.map((r) => ({ scheme: r.scheme ? src.schemeLabel(r.scheme) : 'Legacy', reg: r.scheme, sem: r.sem === '' ? '' : String(r.sem), course: r.course, code: r.code })),
    };
  });
}
async function save() {
  check();
  const errs = [...issues.values()].filter((x) => x.err.length).length;
  if (errs) {
    $('edView').value = 'problems';
    filter();
    $('edMsg').textContent = `Fix the ${errs} row(s) marked in red first.`;
    return;
  }
  const list = draft.filter(isChanged);
  if (!list.length) return;
  const table = list.some((r) => !r.mine), mine = list.some((r) => r.mine);
  $('edSave').disabled = true;
  try {
    await saveEdits({ rows: table ? buildTable() : null, maps: mine ? buildMaps() : null });
  } catch (e) {
    console.error(e);
    $('edMsg').textContent = e.message || 'Could not save';
    $('edSave').disabled = false;
    return;
  }
  $('edDlg').close();
  toast(`${list.length} change(s) saved. QP Statistics, seating and Practicals now use them.`);
}
$('edSave').addEventListener('click', save);

$('eqEditBtn').addEventListener('click', () => {
  load();
  for (const id of ['edCourse', 'edScheme', 'edSem', 'edExam', 'edSrc', 'edView']) $(id).value = '';
  $('edSearch').value = '';
  const m = src.base.meta || {};
  $('edSource').textContent = `${src.uploaded && m.at ? `Your uploaded table (${m.file || 'file'})` : src.uploaded ? 'Built-in table with your edits' : 'Built-in table'}: ${src.base.rows.length.toLocaleString('en-IN')} rows · ${src.maps.length} mapping(s) of your own${src.useBuiltin ? '' : ' · the table is switched off, so its rows are not counted now'}. Nothing changes until you press Save.`;
  fillFilters();
  check();
  filter();
  $('edDlg').showModal();
});
