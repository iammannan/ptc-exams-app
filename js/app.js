import { parseNominalRoll } from './parser.js';
import { store, htStore } from './store.js';
import { $, esc, loadPdfjs, loadJsPdf, toast, pref, slug, downloadCsv, bindDropzone, pdfFiles, pdfFooter } from './util.js';
import { kv, kvReady, kvError } from './kv.js';
import { htReload, onTickets } from './halltickets.js';
import './qp.js';
import { onEquiv } from './equiv.js';
import { initSettings } from './settings.js';
import './seating.js';
import './attmark.js';
import './stickers.js';
import './practicals.js';
import './views.js';

await kvReady;
if (kvError()) {
  $('banner').textContent = kvError();
  $('banner').hidden = false;
}

const TYPE_LABEL = { R: 'Regular', S: 'Supplementary' };

let rolls = [];
let students = [];

/* ---------- tabs ---------- */
const TABS = ['home', 'upload', 'halltickets', 'candidates', 'equiv', 'qp', 'seating', 'practicals', 'settings'];
function showTab(name) {
  if (!TABS.includes(name)) name = name === 'schedule' ? 'qp' : 'home'; // tab names from the old version
  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== 'tab-' + name));
  pref.set('tab', name);
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// The header and tabs hide while you scroll down and return when you scroll up, reach the top, point at the top edge
// of the window or tab into them — more of the screen for tables and seat grids.
{
  const bar = document.querySelector('.topbar');
  let lastY = scrollY;
  const show = () => bar.classList.remove('bar-hidden');
  addEventListener('scroll', () => {
    const y = scrollY;
    if (y < 120 || y < lastY - 6) show();
    else if (y > lastY + 6 && !bar.contains(document.activeElement)) bar.classList.add('bar-hidden');
    if (Math.abs(y - lastY) > 6) lastY = y;
  }, { passive: true });
  addEventListener('mousemove', (e) => { if (e.clientY < 14) show(); }, { passive: true });
  bar.addEventListener('focusin', show);
}
$('homeFlow').addEventListener('click', (e) => { const go = e.target.closest('[data-go]')?.dataset.go; if (go) showTab(go); });
// Links elsewhere (e.g. "add its equivalent subject") open their tab.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-go]');
  if (!a) return;
  e.preventDefault();
  a.closest('dialog')?.close();
  showTab(a.dataset.go);
  window.scrollTo({ top: 0 });
});

/* ---------- home: progress on each step ---------- */
const home = { rolls: 0, students: 0, tickets: 0, diffs: 0, maps: 0 };
function renderHome() {
  const n = (v) => Number(v).toLocaleString('en-IN');
  $('hsUpload').textContent = home.rolls ? `✓ ${home.rolls} file(s) · ${n(home.students)} students` : 'Not started';
  $('hsHt').textContent = home.tickets ? `✓ ${n(home.tickets)} hall tickets${home.diffs ? ` · ${home.diffs} mismatch(es) to review` : ''}` : 'Not started';
  $('hsCand').textContent = home.students ? `${n(home.students)} students` : '';
  $('hsEquiv').textContent = home.maps ? `${home.maps} mapping(s)` : 'Optional';
  $('hsQp').textContent = home.tickets ? 'Ready' : '';
  const halls = kv.get('halls', []).length;
  $('hsSeat').textContent = halls ? `${halls} hall(s) set up` : '';
}
onTickets((list) => {
  home.tickets = list.length;
  home.diffs = document.querySelectorAll('#probBody tr').length;
  renderHome();
});
onEquiv((maps) => { home.maps = maps.length; renderHome(); });

/* ---------- data ---------- */
async function reload() {
  rolls = (await store.all()).sort((a, b) => (a.courses[0]?.courseNo || '').localeCompare(b.courses[0]?.courseNo || '') || a.fileName.localeCompare(b.fileName));
  // Merge all rolls; if a student appears twice, the most recently uploaded roll wins.
  const map = new Map();
  for (const r of [...rolls].sort((a, b) => a.parsedAt.localeCompare(b.parsedAt)))
    for (const s of r.students) map.set(s.courseNo + '|' + s.regNo, { ...s, fileName: r.fileName });
  // Your own changes (Candidates tab) sit on top of the uploaded rolls.
  const edits = kv.get('studentEdits', { put: {}, del: [] });
  for (const k of edits.del || []) map.delete(k);
  for (const [k, st] of Object.entries(edits.put || {})) map.set(k, { ...st, fileName: 'Edited by you', edited: true });
  students = [...map.values()].sort((a, b) => a.courseNo.localeCompare(b.courseNo) || a.regNo.localeCompare(b.regNo));
  home.rolls = rolls.length;
  home.students = students.length;
  renderHome();
  const college = rolls.find((r) => r.meta?.college)?.meta.college;
  $('collegeName').textContent = college || 'Nominal roll & hall ticket processor';
  $('collegeName').dataset.college = college || '';
  renderRolls();
  renderFilters();
  await htReload(students); // hall tickets are cross-checked against the nominal rolls
}

/* ---------- upload ---------- */
async function handleFiles(fileList) {
  const files = pdfFiles(fileList);
  if (!files.length) return toast('Please choose PDF files');
  const box = $('progress');
  box.hidden = false;
  box.innerHTML = '';
  let pdfjs;
  try {
    pdfjs = await loadPdfjs();
  } catch {
    box.innerHTML = '<div class="progress-item"><span class="name">Could not load the PDF reader. Check your internet connection and try again.</span></div>';
    return;
  }
  let ok = 0, parsed = 0, declared = 0;
  $('nrSummary').hidden = true;
  for (const f of files) {
    const row = document.createElement('div');
    row.className = 'progress-item';
    row.innerHTML = `<span class="name">${esc(f.name)}</span><span class="msg">Reading…</span>`;
    box.appendChild(row);
    try {
      const roll = await parseNominalRoll(pdfjs, new Uint8Array(await f.arrayBuffer()), f.name);
      if (!roll.students.length) throw new Error('No students found — is this a nominal roll PDF?');
      await store.put(roll);
      ok++;
      parsed += roll.students.length;
      declared += roll.meta.studentCount || roll.students.length;
      const bad = roll.students.filter((s) => !s.verified);
      const problems = [...roll.issues, ...bad.slice(0, 5).map((s) => `${s.regNo} ${s.name}: ${s.issues.join('; ')}`)];
      if (bad.length > 5) problems.push(`…and ${bad.length - 5} more`);
      row.innerHTML = `<span class="name">${esc(f.name)}</span>
        <span class="msg">${esc(roll.courses.map((c) => c.courseNo).join(', '))} · ${roll.students.length} students</span>
        ${problems.length ? `<span class="badge warn">${problems.length} issue(s)</span><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '<span class="badge ok">Verified</span>'}`;
    } catch (e) {
      console.error(e);
      row.innerHTML = `<span class="name">${esc(f.name)}</span><span class="badge warn">Failed</span><ul><li>${esc(e.message || e)}</li></ul>`;
    }
    await new Promise((r) => setTimeout(r)); // let the page repaint between files
  }
  await reload();
  const sum = $('nrSummary');
  sum.className = 'upload-summary ' + (ok === files.length ? 'ok' : ok ? 'warn' : 'bad');
  sum.innerHTML = ok
    ? `<b>${ok === files.length ? '✓ Nominal roll uploaded successfully.' : `⚠ ${ok} of ${files.length} file(s) uploaded.`}</b>
       <span>Parsed students: <b>${parsed.toLocaleString('en-IN')}</b></span>
       <span>Total student count (as per nominal roll): <b>${declared.toLocaleString('en-IN')}</b>${declared !== parsed ? ' <span class="badge warn">check the issues below</span>' : ' <span class="badge ok">matches</span>'}</span>
       <span class="muted">Saved in this browser. ${students.length.toLocaleString('en-IN')} students in all saved rolls.</span>`
    : '<b>✕ No nominal roll could be read.</b> <span>See the messages below.</span>';
  sum.hidden = false;
  toast(`${ok} of ${files.length} file(s) saved`);
}

bindDropzone($('dropzone'), $('fileInput'), handleFiles);

function renderRolls() {
  const body = $('rollsBody');
  $('rollsEmpty').hidden = rolls.length > 0;
  body.innerHTML = rolls
    .map((r) => {
      const bad = r.students.filter((s) => !s.verified).length + r.issues.length;
      const subj = r.students.reduce((n, s) => n + s.subjectCount, 0);
      return `<tr>
        <td class="wrap">${esc(r.fileName)}</td>
        <td class="wrap">${r.courses.map((c) => `<b>${esc(c.courseNo)}</b> ${esc(c.courseName)}`).join('<br>')}</td>
        <td class="num">${r.students.length}${r.meta.studentCount ? ` <span class="muted">/ ${r.meta.studentCount}</span>` : ''}</td>
        <td class="num">${subj}</td>
        <td>${bad ? `<span class="badge warn" title="${esc([...r.issues, ...r.students.filter((s) => !s.verified).map((s) => s.regNo + ': ' + s.issues.join('; '))].join('\n'))}">${bad} issue(s)</span>` : '<span class="badge ok">All verified</span>'}</td>
        <td class="muted">${esc(r.meta.generatedOn || '')}</td>
        <td><button class="icon-btn" data-del="${esc(r.fileName)}" title="Remove">✕</button></td>
      </tr>`;
    })
    .join('');
  const codes = new Set(students.flatMap((s) => s.sems.flatMap((x) => x.codes)));
  const courses = new Set(students.map((s) => s.courseNo));
  const entries = students.reduce((n, s) => n + s.subjectCount, 0);
  $('stats').innerHTML = rolls.length
    ? [
        [rolls.length, 'Files'],
        [courses.size, 'Courses'],
        [students.length, 'Students'],
        [codes.size, 'Subject codes'],
        [entries, 'Subject entries'],
      ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('')
    : '';
}

$('rollsBody').addEventListener('click', async (e) => {
  const f = e.target.closest('[data-del]')?.dataset.del;
  if (!f || !confirm(`Remove "${f}" from saved data?`)) return;
  await store.remove(f);
  await reload();
});

$('clearBtn').addEventListener('click', async () => {
  if (!rolls.length || !confirm('Delete all saved nominal rolls from this browser?')) return;
  await store.clear();
  $('progress').hidden = true;
  await reload();
});

// Export / import live in Settings; they reload everything through this.
initSettings({ reload: () => reload() });


/* ---------- candidates ---------- */
function fillSelect(sel, options, keep) {
  sel.innerHTML = options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  sel.value = options.some(([v]) => v === keep) ? keep : options[0]?.[0] ?? '';
}

function renderFilters() {
  const courses = new Map();
  for (const s of students) {
    const c = courses.get(s.courseNo) || { name: s.courseName, n: 0 };
    c.n++;
    courses.set(s.courseNo, c);
  }
  fillSelect(
    $('courseSel'),
    [['', `All courses (${students.length})`], ...[...courses].map(([no, c]) => [no, `${no} – ${c.name} (${c.n})`])],
    $('courseSel').value || pref.get('course'),
  );
  renderSubjects();
}

function renderSubjects() {
  const course = $('courseSel').value;
  const type = $('typeSel').value;
  const counts = new Map();
  for (const s of students) {
    if (course && s.courseNo !== course) continue;
    for (const sem of s.sems) {
      if (type && sem.type !== type) continue;
      for (const code of sem.codes) {
        const c = counts.get(code) || { n: 0, sems: new Set(), regs: new Set() };
        c.n++;
        c.sems.add(sem.sem);
        if (sem.regulation) c.regs.add(sem.regulation);
        counts.set(code, c);
      }
    }
  }
  const opts = [...counts]
    .sort(([a, x], [b, y]) => Math.min(...x.sems) - Math.min(...y.sems) || a.localeCompare(b, undefined, { numeric: true }))
    .map(([code, c]) => [code, `${code} · Sem ${[...c.sems].join('/')} · ${[...c.regs].join('/')} (${c.n})`]);
  fillSelect($('subjectSel'), [['', `All subjects (${counts.size} codes)`], ...opts], $('subjectSel').value || pref.get('subject'));
  renderCandidates();
}

function currentRows() {
  const course = $('courseSel').value;
  const code = $('subjectSel').value;
  const type = $('typeSel').value;
  const q = $('searchInput').value.trim().toLowerCase();
  const out = [];
  for (const s of students) {
    if (course && s.courseNo !== course) continue;
    if (q && !s.name.toLowerCase().includes(q) && !s.regNo.toLowerCase().includes(q)) continue;
    if (code) {
      const sem = s.sems.find((x) => x.codes.includes(code) && (!type || x.type === type));
      if (sem) out.push({ s, sem });
    } else if (!type || s.sems.some((x) => x.type === type)) {
      out.push({ s });
    }
  }
  return out;
}

function columns() {
  const course = $('courseSel').value;
  const code = $('subjectSel').value;
  const cols = [
    { h: 'S.No', v: (r, i) => i + 1, cls: 'num' },
    { h: 'Reg No', v: (r) => r.s.regNo },
    { h: 'Student Name', v: (r) => r.s.name },
    { h: 'DOB', v: (r) => r.s.dob },
  ];
  if (!course) cols.push({ h: 'Course', v: (r) => r.s.courseNo });
  if (code) {
    cols.push(
      { h: 'Sem', v: (r) => r.sem.sem, cls: 'num' },
      { h: 'Type', v: (r) => r.sem.type, html: (r) => `<span class="badge ${r.sem.type.toLowerCase()}" title="${TYPE_LABEL[r.sem.type] || ''}">${esc(r.sem.type)}</span>` },
      { h: 'Regulation', v: (r) => r.sem.regulation },
    );
  } else {
    cols.push(
      { h: 'Semesters', v: (r) => r.s.semesters.join(', ') },
      { h: 'Subjects', v: (r) => r.s.subjectCount, cls: 'num' },
      { h: 'Regulation', v: (r) => r.s.regulation },
      {
        h: 'Sem-wise Subject Codes',
        v: (r) => r.s.sems.map((x) => `SEM ${x.sem} (${x.type}): ${x.codes.join(', ')}`).join('\n'),
        html: (r) => r.s.sems.map((x) => `<b>SEM ${x.sem} (${esc(x.type)})${r.s.regulation.includes(',') ? ' ' + esc(x.regulation) : ''}:</b> ${esc(x.codes.join(', '))}`).join('<br>'),
        cls: 'codes',
      },
    );
  }
  return cols;
}

function renderCandidates() {
  pref.set('course', $('courseSel').value);
  pref.set('subject', $('subjectSel').value);
  const rows = currentRows();
  const cols = columns();
  const code = $('subjectSel').value;
  $('candCount').textContent = rows.length;
  const courseOpt = $('courseSel').selectedOptions[0];
  $('candContext').textContent = [
    $('courseSel').value ? courseOpt.textContent.replace(/\s*\(\d+\)$/, '') : 'All courses',
    code ? `Subject ${code}` : 'All subjects',
    $('typeSel').value ? TYPE_LABEL[$('typeSel').value] : '',
  ].filter(Boolean).join(' · ');
  $('candHead').innerHTML = `<tr>${cols.map((c) => `<th class="${c.cls === 'num' ? 'num' : ''}">${c.h}</th>`).join('')}<th></th></tr>`;
  $('candBody').innerHTML = rows
    .map((r, i) => `<tr${r.s.verified ? '' : ' title="' + esc(r.s.issues.join('; ')) + '"'}>${cols.map((c) => `<td class="${c.cls || ''}">${c.html ? c.html(r) : esc(c.v(r, i))}</td>`).join('')}
      <td class="row-actions">${r.s.edited ? '<span class="badge manual" title="Added or edited by you">Edited</span> ' : ''}<button class="btn ghost sm" data-edit="${esc(r.s.courseNo + '|' + r.s.regNo)}">Edit</button><button class="icon-btn" data-delst="${esc(r.s.courseNo + '|' + r.s.regNo)}" title="Delete student">✕</button></td></tr>`)
    .join('');
  const empty = $('candEmpty');
  empty.hidden = rows.length > 0;
  empty.textContent = students.length ? 'No candidates match these filters.' : 'No data yet — upload nominal roll PDFs in the Upload tab.';
  $('pdfBtn').disabled = $('csvBtn').disabled = !rows.length;
}

$('courseSel').addEventListener('change', () => { $('subjectSel').value = ''; renderSubjects(); });
$('typeSel').addEventListener('change', renderSubjects);
$('subjectSel').addEventListener('change', renderCandidates);
$('searchInput').addEventListener('input', renderCandidates);

function exportName(ext) {
  const parts = ['Candidates', $('courseSel').value || 'AllCourses', $('subjectSel').value || 'AllSubjects', $('typeSel').value];
  return slug(parts.filter(Boolean).join('_')) + '.' + ext;
}

$('csvBtn').addEventListener('click', () => {
  const rows = currentRows();
  const cols = columns();
  downloadCsv(exportName('csv'), cols.map((c) => c.h), rows.map((r, i) => cols.map((c) => c.v(r, i))));
});

$('pdfBtn').addEventListener('click', async () => {
  const btn = $('pdfBtn');
  btn.disabled = true;
  try {
    const jsPDF = await loadJsPdf();
    const rows = currentRows();
    const cols = columns();
    const code = $('subjectSel').value;
    const doc = new jsPDF({ orientation: code ? 'portrait' : 'landscape', unit: 'mm', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    const meta = rolls.find((r) => r.meta?.college)?.meta || {};
    const courseOpt = $('courseSel').selectedOptions[0];

    let y = 14;
    doc.setFont('helvetica', 'bold').setFontSize(13);
    if (meta.college) { doc.text(meta.college, W / 2, y, { align: 'center' }); y += 6; }
    doc.setFontSize(11).text('Exam Candidates List', W / 2, y, { align: 'center' });
    y += 8;
    doc.setFont('helvetica', 'normal').setFontSize(9.5);
    const info = [
      ['Course', $('courseSel').value ? courseOpt.textContent.replace(/\s*\(\d+\)$/, '') : 'All courses'],
      ['Subject Code', code || 'All subjects'],
      ...(code ? [['Semester / Regulation', [...new Set(rows.map((r) => `Sem ${r.sem.sem} / ${r.sem.regulation}`))].join(', ')]] : []),
      ...($('typeSel').value ? [['Exam Type', TYPE_LABEL[$('typeSel').value]]] : []),
      ['Exam', [meta.exam, meta.year].filter(Boolean).join(' / ')],
      ['Total Candidates', String(rows.length)],
    ];
    for (const [k, v] of info) {
      doc.setFont('helvetica', 'bold').text(k + ':', 14, y);
      doc.setFont('helvetica', 'normal').text(doc.splitTextToSize(v, W - 64), 58, y);
      y += 5;
    }

    const codesIdx = cols.findIndex((c) => c.cls === 'codes');
    doc.autoTable({
      startY: y + 2,
      head: [cols.map((c) => c.h)],
      body: rows.map((r, i) => cols.map((c) => String(c.v(r, i)))),
      theme: 'grid',
      styles: { fontSize: code ? 9 : 7.5, cellPadding: 1.6, valign: 'middle', lineColor: [200, 205, 215], lineWidth: 0.1 },
      headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [245, 247, 251] },
      columnStyles: codesIdx >= 0 ? { [codesIdx]: { cellWidth: 95 } } : {},
      margin: { left: 14, right: 14, bottom: 14 },
      didDrawPage: () => pdfFooter(doc),
    });
    doc.save(exportName('pdf'));
  } catch (e) {
    console.error(e);
    toast('PDF export failed — check your internet connection');
  } finally {
    btn.disabled = false;
  }
});

/* ---------- start ---------- */
showTab(pref.get('tab') || 'home');
reload().catch((e) => {
  console.error(e);
  const b = $('banner');
  b.textContent = e.message || 'Could not open saved data in this browser.';
  b.hidden = false;
});

/* ---------- candidates: add / edit / delete ---------- */
// Stored in kv "studentEdits" as { put: { 'course|reg': student }, del: ['course|reg'] } on top of the uploaded rolls.
const semLine = (x) => `SEM ${x.sem} (${x.type}) ${x.regulation || ''}: ${x.codes.join(', ')}`;
function parseSems(text) {
  const out = [];
  for (const line of text.split(/\n+/).map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^SEM\s*(\d+)\s*\(?\s*([RS])?\s*\)?\s*([^:]*):\s*(.+)$/i);
    if (!m) throw new Error(`Can't read "${line}". Use: SEM 3 (R) R2023: code1, code2`);
    const codes = m[4].split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
    out.push({ sem: +m[1], type: (m[2] || 'R').toUpperCase(), regulation: m[3].trim(), codes });
  }
  if (!out.length) throw new Error('Add at least one semester line');
  return out;
}
let editing = null; // key of the student being edited, or null when adding
function openStudent(key) {
  editing = key;
  const st = key ? students.find((x) => x.courseNo + '|' + x.regNo === key) : null;
  $('studentTitle').textContent = st ? `Edit ${st.regNo}` : 'Add student';
  $('stReg').value = st?.regNo || '';
  $('stName').value = st?.name || '';
  $('stDob').value = st?.dob || '';
  $('stCourse').value = st?.courseNo || $('courseSel').value || '';
  $('stCourseName').value = st?.courseName || students.find((x) => x.courseNo === $('stCourse').value)?.courseName || '';
  $('stSems').value = st ? st.sems.map(semLine).join('\n') : $('subjectSel').value ? `SEM 1 (R) : ${$('subjectSel').value}` : '';
  $('stNote').textContent = '';
  $('courseList').innerHTML = [...new Map(students.map((x) => [x.courseNo, x.courseName]))].map(([c, n]) => `<option value="${esc(c)}">${esc(n)}</option>`).join('');
  $('studentDlg').showModal();
  $(st ? 'stName' : 'stReg').focus();
}
$('candAddBtn').addEventListener('click', () => openStudent(null));
$('studentClose').addEventListener('click', () => $('studentDlg').close());
$('stCourse').addEventListener('change', () => {
  if (!$('stCourseName').value) $('stCourseName').value = students.find((x) => x.courseNo === $('stCourse').value.trim())?.courseName || '';
});
$('studentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  let sems;
  try { sems = parseSems($('stSems').value); } catch (err) { $('stNote').textContent = err.message; return; }
  const st = {
    regNo: $('stReg').value.trim(), name: $('stName').value.trim().toUpperCase(), dob: $('stDob').value.trim(),
    courseNo: $('stCourse').value.trim(), courseName: $('stCourseName').value.trim().toUpperCase(),
    sems, semesters: sems.map((x) => x.sem), subjectCount: sems.reduce((n, x) => n + x.codes.length, 0),
    regulation: [...new Set(sems.map((x) => x.regulation).filter(Boolean))].join(', '), verified: true, issues: [],
  };
  const key = st.courseNo + '|' + st.regNo;
  if (key !== editing && students.some((x) => x.courseNo + '|' + x.regNo === key)) { $('stNote').textContent = `${st.regNo} is already in course ${st.courseNo}`; return; }
  const edits = kv.get('studentEdits', { put: {}, del: [] });
  edits.put ??= {}; edits.del ??= [];
  if (editing && editing !== key) { delete edits.put[editing]; if (!edits.del.includes(editing)) edits.del.push(editing); }
  edits.put[key] = st;
  edits.del = edits.del.filter((k) => k !== key);
  await kv.set('studentEdits', edits);
  $('studentDlg').close();
  await reload();
  toast(`${st.regNo} ${editing ? 'updated' : 'added'}`);
});
$('candBody').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit]')?.dataset.edit;
  if (edit) return openStudent(edit);
  const del = e.target.closest('[data-delst]')?.dataset.delst;
  if (!del) return;
  const st = students.find((x) => x.courseNo + '|' + x.regNo === del);
  if (!confirm(`Delete ${st?.regNo} ${st?.name} (course ${st?.courseNo})? You can add the student back later.`)) return;
  const edits = kv.get('studentEdits', { put: {}, del: [] });
  edits.put ??= {}; edits.del ??= [];
  delete edits.put[del];
  if (!edits.del.includes(del)) edits.del.push(del);
  await kv.set('studentEdits', edits);
  await reload();
  toast(`${st?.regNo} deleted`);
});
