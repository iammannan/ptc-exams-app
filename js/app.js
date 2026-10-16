import { parseNominalRoll } from './parser.js';
import { store } from './store.js';

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
const JSPDF = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js';
const AUTOTABLE = 'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TYPE_LABEL = { R: 'Regular', S: 'Supplementary' };

let rolls = [];
let students = [];

/* ---------- helpers ---------- */
let pdfjsP;
function loadPdfjs() {
  pdfjsP ??= import(PDFJS).then((m) => {
    m.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    return m;
  });
  return pdfjsP;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}
let jspdfP;
const loadJsPdf = () => (jspdfP ??= loadScript(JSPDF).then(() => loadScript(AUTOTABLE)).then(() => window.jspdf.jsPDF));

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

const pref = {
  get(k) { try { return localStorage.getItem('ptc.' + k) ?? ''; } catch { return ''; } },
  set(k, v) { try { localStorage.setItem('ptc.' + k, v); } catch {} },
};

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const slug = (s) => String(s).replace(/[^\w-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

/* ---------- tabs ---------- */
function showTab(name) {
  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== 'tab-' + name));
  pref.set('tab', name);
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ---------- data ---------- */
async function reload() {
  rolls = (await store.all()).sort((a, b) => (a.courses[0]?.courseNo || '').localeCompare(b.courses[0]?.courseNo || '') || a.fileName.localeCompare(b.fileName));
  // Merge all rolls; if a student appears twice, the most recently uploaded roll wins.
  const map = new Map();
  for (const r of [...rolls].sort((a, b) => a.parsedAt.localeCompare(b.parsedAt)))
    for (const s of r.students) map.set(s.courseNo + '|' + s.regNo, { ...s, fileName: r.fileName });
  students = [...map.values()].sort((a, b) => a.courseNo.localeCompare(b.courseNo) || a.regNo.localeCompare(b.regNo));
  const college = rolls.find((r) => r.meta?.college)?.meta.college;
  $('collegeName').textContent = college || 'Nominal roll processor';
  renderRolls();
  renderFilters();
}

/* ---------- upload ---------- */
async function handleFiles(fileList) {
  const files = [...fileList].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
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
  let ok = 0;
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
  }
  await reload();
  toast(`${ok} of ${files.length} file(s) saved`);
}

$('fileInput').addEventListener('change', (e) => {
  handleFiles(e.target.files);
  e.target.value = '';
});
const dz = $('dropzone');
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));

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

$('backupBtn').addEventListener('click', () => {
  if (!rolls.length) return toast('Nothing to back up yet');
  const blob = new Blob([JSON.stringify({ app: 'ptc-exams', version: 1, rolls }, null, 1)], { type: 'application/json' });
  download(`ptc-exams-backup-${new Date().toISOString().slice(0, 10)}.json`, blob);
});

$('restoreInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!Array.isArray(data.rolls)) throw new Error();
    for (const r of data.rolls) await store.put(r);
    await reload();
    toast(`Restored ${data.rolls.length} file(s)`);
  } catch {
    toast('That is not a valid PTC Exams backup');
  }
});

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
  $('candHead').innerHTML = `<tr>${cols.map((c) => `<th class="${c.cls === 'num' ? 'num' : ''}">${c.h}</th>`).join('')}</tr>`;
  $('candBody').innerHTML = rows
    .map((r, i) => `<tr${r.s.verified ? '' : ' title="' + esc(r.s.issues.join('; ')) + '"'}>${cols.map((c) => `<td class="${c.cls || ''}">${c.html ? c.html(r) : esc(c.v(r, i))}</td>`).join('')}</tr>`)
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
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.map((c) => q(c.h)).join(','), ...rows.map((r, i) => cols.map((c) => q(c.v(r, i))).join(','))].join('\r\n');
  download(exportName('csv'), new Blob(['﻿' + csv], { type: 'text/csv' }));
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
      didDrawPage: () => {
        const h = doc.internal.pageSize.getHeight();
        doc.setFontSize(8).setTextColor(120);
        doc.text(`Generated by PTC Exams App on ${new Date().toLocaleString('en-IN')}`, 14, h - 7);
        doc.text(`Page ${doc.internal.getNumberOfPages()}`, W - 14, h - 7, { align: 'right' });
        doc.setTextColor(0);
      },
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
showTab(pref.get('tab') || 'upload');
reload().then(() => { if (!rolls.length) showTab('upload'); });
