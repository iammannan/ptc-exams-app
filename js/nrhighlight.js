// Nominal roll PDF highlight: a copy of the DOTE nominal roll with every subject code marked by how the app examines it,
// from the uploaded equivalents table (own code or old code mapped to a current subject):
//   every theory subject (End Exam T) yellow · each practical (P) its own colour, the same for its old codes ·
//   no end exam (NA) blue · not highlighted = not mapped in the app.
// First comes a summary of the roll: every current subject with its equivalents (old codes) and strength, by exam type,
// each lab's row in its colour.
// The button is in Practicals: the rolls of the course chosen there, from the PDFs kept when they were uploaded
// (Nominal Roll Upload saves each PDF in this browser); rolls uploaded before that are asked for once and kept.
// One roll downloads as "<name> - highlighted.pdf", several as one .zip.
import { onTickets, pdfHeader, TABLE_STYLE } from './halltickets.js';
import { mapSubject, subjectExam, tableName } from './equiv.js';
import { courseFromFileName, parseNominalRoll } from './parser.js';
import { commonCourse } from './qpcalc.js';
import { store, nrPdfStore } from './store.js';
import { $, loadPdfjs, loadJsPdf, loadJsZip, toast, download, pdfFiles, pdfFooter, slug } from './util.js';

const COLOR = { T: [1, 0.86, 0.1], P: [0.35, 0.8, 0.35], NA: [0.45, 0.68, 1] };
const LABEL = { T: 'Theory', P: 'Practical', NA: 'No end exam' };
// one colour per lab (none yellow or blue, which mean theory / no end exam); repeats after the last
const LABS = [[0.35, 0.8, 0.35], [1, 0.6, 0.2], [1, 0.45, 0.7], [0.7, 0.5, 1], [0.2, 0.8, 0.8], [0.95, 0.45, 0.4], [0.6, 0.9, 0.2],
  [0.85, 0.65, 0.45], [0.4, 0.9, 0.7], [0.9, 0.55, 0.95], [0.55, 0.7, 0.35], [1, 0.75, 0.55], [0.6, 0.6, 0.85], [0.3, 0.65, 0.55]];
const DISCLAIMER = 'Disclaimer: PTC Exams App is not an official app of DOTE or the Board of Examinations. This highlighted copy is for internal checking only; the original nominal roll and DOTE\'s lists remain the official record.';
const light = (rgb, k = 0.45) => rgb.map((c) => Math.round(255 - (255 - c * 255) * k)); // a paler tint for table cells
const CODE_RE = /^(\d{5}|\d{7}|\d{10}|[A-Z]{2,3}\d{6})$/; // K/L/M · N/Z · R2023 · first-year letter codes (roll numbers are 8 digits)

// hall-ticket subject names (an elective slot's old code takes the elective named on the hall ticket)
let names = new Map(); // course|code → name
onTickets((list) => {
  names = new Map();
  for (const t of list) for (const s of t.subjects) if (s.name && !names.has(t.courseNo + '|' + s.code)) names.set(t.courseNo + '|' + s.code, s.name);
});
const examOf = (code, course) => subjectExam(code, course, mapSubject, names.get(course + '|' + code) || '');
const nameOf = (code, course) => names.get(course + '|' + code) || tableName(code, course) || '';

// The roll's subjects: one row per current subject (old codes mapped onto it are its equivalents), with strength;
// codes the app can't map stay as their own rows under "Not mapped".
function summarise(roll) {
  const subj = new Map(); // course|current code → { course, code, exam, sem, regs, R, S, own, old: Map(code → n) }
  for (const st of roll.students)
    for (const x of st.sems || [])
      for (const code of x.codes) {
        const nm = names.get(st.courseNo + '|' + code) || '';
        const exam = subjectExam(code, st.courseNo, mapSubject, nm);
        const target = (exam && mapSubject(code, st.courseNo, nm)?.code) || code;
        const k = st.courseNo + '|' + target;
        const r = subj.get(k) || subj.set(k, { course: st.courseNo, code: target, exam: COLOR[exam] ? exam : '', sem: x.sem, regs: new Set(), R: 0, S: 0, own: 0, old: new Map(), oldName: '' }).get(k);
        if (target !== code) { r.old.set(code, (r.old.get(code) || 0) + 1); r.oldName ||= nm; } else r.own++;
        if (r.regs.has(st.regNo)) continue; // two old codes of one paper: one candidate
        r.regs.add(st.regNo);
        r[x.type === 'S' ? 'S' : 'R']++;
        if (target === code) r.sem = x.sem;
      }
  const order = { T: 0, P: 1, NA: 2, '': 3 };
  return [...subj.values()].sort((a, b) => order[a.exam] - order[b.exam] || a.course.localeCompare(b.course) || a.sem - b.sem || a.code.localeCompare(b.code, undefined, { numeric: true }));
}
function addSummary(doc, roll, file, list, labColor) {
  const courses = [...new Set(roll.students.map((s) => `${s.courseNo} ${s.courseName}`))];
  const count = (t) => list.filter((r) => r.exam === t).length;
  const y0 = pdfHeader(doc, 'PTC Exams App – Nominal Roll: Subjects, Equivalents and Strength', [
    ['File', file.name],
    ['Course', courses.join('; ')],
    ['Students', `${roll.students.length} · ${list.length} subject(s): ${count('T')} theory, ${count('P')} practical${count('NA') ? `, ${count('NA')} no end exam` : ''}, ${count('')} not mapped`],
    ['Highlight', 'Theory yellow (all) · each practical its own colour (as in its row below) · No end exam blue · not highlighted = not mapped in the app (no End Exam / equivalent)'],
  ]);
  // disclaimer, boxed under the header
  const W = doc.internal.pageSize.getWidth();
  doc.setFont('helvetica', 'bold').setFontSize(8.5);
  const lines = doc.splitTextToSize(DISCLAIMER, W - 36);
  const boxH = lines.length * 4 + 4;
  doc.setDrawColor(200, 60, 60).setFillColor(253, 236, 236).roundedRect(14, y0, W - 28, boxH, 1.5, 1.5, 'FD');
  doc.setTextColor(160, 30, 30).text(lines, 18, y0 + 5.2);
  doc.setTextColor(0).setFont('helvetica', 'normal').setDrawColor(0);
  const y = y0 + boxH + 2;
  const head = { T: 'Theory', P: 'Practical', NA: 'No end exam', '': 'Not mapped in the app' };
  const fill = (t) => (COLOR[t] ? light(COLOR[t]) : [235, 235, 235]);
  const body = [];
  let last = null, n = 0;
  for (const r of list) {
    if (r.exam !== last) { body.push([{ content: `${head[r.exam]} (${list.filter((x) => x.exam === r.exam).length})`, colSpan: 10, styles: { fillColor: r.exam === 'P' ? [240, 240, 240] : fill(r.exam), fontStyle: 'bold', halign: 'left' } }]); last = r.exam; n = 0; }
    const lab = labColor.get(r.course + '|' + r.code);
    body.push([++n, r.course, r.sem || '', { content: r.code, styles: { fontStyle: 'bold', ...(lab ? { fillColor: light(lab, 0.6) } : {}) } }, nameOf(r.code, r.course) || r.oldName || '-', r.own,
      [...r.old].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([c, k]) => `${c}[${k}]`).join(', ') || '-', r.R, r.S, { content: String(r.regs.size), styles: { fontStyle: 'bold' } }]);
  }
  doc.autoTable({
    ...TABLE_STYLE, startY: y + 2,
    head: [['S.No', 'Course', 'Sem', 'Subject code', 'Subject', 'Own code', 'Equivalents (old codes)[students]', 'R', 'S', 'Strength']],
    body,
    columnStyles: { 0: { cellWidth: 11, halign: 'right' }, 1: { cellWidth: 14 }, 2: { cellWidth: 10, halign: 'right' }, 3: { cellWidth: 26 }, 5: { cellWidth: 16, halign: 'right' }, 6: { cellWidth: 70 }, 7: { cellWidth: 10, halign: 'right' }, 8: { cellWidth: 10, halign: 'right' }, 9: { cellWidth: 17, halign: 'right' } },
    didDrawPage: () => pdfFooter(doc),
  });
}

// DOTE's rolls are encrypted (no editing), so each page is drawn as an image with the highlights painted on it.
const SCALE = 2;
async function highlight(file, pdfjs, jsPDF) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const roll = await parseNominalRoll(pdfjs, bytes.slice(), file.name);
  const src = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const list = summarise(roll);
  const labColor = new Map(list.filter((r) => r.exam === 'P').map((r, i) => [r.course + '|' + r.code, LABS[i % LABS.length]]));
  addSummary(doc, roll, file, list, labColor);
  const colorOf = (code, course, type) => {
    if (type !== 'P') return COLOR[type];
    const target = mapSubject(code, course, names.get(course + '|' + code) || '')?.code || code; // old codes share their lab's colour
    return labColor.get(course + '|' + target) || COLOR.P;
  };
  const seen = { T: new Set(), P: new Set(), NA: new Set(), '': new Set() };
  let course = courseFromFileName(file.name);
  for (let p = 1; p <= src.numPages; p++) {
    const page = await src.getPage(p);
    const items = (await page.getTextContent()).items.filter((i) => i.str.trim()).map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, fs: Math.hypot(i.transform[2], i.transform[3]) || 8 }));
    const vp = page.getViewport({ scale: SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    page.cleanup();
    ctx.globalCompositeOperation = 'multiply'; // the text stays readable under the colour
    const mark = (x0, y0, x1, y1, rgb) => {
      const [a, b, c, d] = vp.convertToViewportRectangle([x0, y0, x1, y1]);
      ctx.fillStyle = `rgba(${rgb.map((v) => Math.round(v * 255)).join(',')},0.6)`;
      ctx.fillRect(Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b));
    };
    // reading order, so each table's "Course Name : 1030 - …" heading comes before its codes
    items.sort((a, b) => (Math.abs(a.y - b.y) > 2.5 ? b.y - a.y : a.x - b.x));
    const lines = [];
    for (const it of items) { const l = lines[lines.length - 1]; if (l && Math.abs(l.y - it.y) <= 2.5) l.items.push(it); else lines.push({ y: it.y, items: [it] }); }
    for (const l of lines) {
      const text = l.items.map((i) => i.str).join(' ');
      const c = text.match(/Course\s*Name\s*:?\s*(\d{4})\s*-/i) || text.match(/Course\s*(?:Code|No\.?)\s*:?\s*(\d{4})\b/i);
      if (c) course = c[1];
      for (const it of l.items) {
        // a code's place in its text item, from its share of the characters (codes are digits / capitals, near-equal widths)
        for (const m of it.str.matchAll(/[A-Z0-9]+/g)) {
          if (!CODE_RE.test(m[0])) continue;
          const type = course ? examOf(m[0], course) : '';
          seen[COLOR[type] ? type : ''].add(m[0]);
          if (!COLOR[type]) continue;
          const per = it.w / Math.max(1, it.str.length);
          const x0 = it.x + per * m.index - 0.6;
          mark(x0, it.y - it.fs * 0.25, x0 + per * m[0].length + 1.2, it.y + it.fs * 0.95, colorOf(m[0], course, type));
        }
      }
    }
    // the page at its own size (mm), with a strip added below it for the legend (the roll's own footer stays clear)
    const STRIP = 8;
    const w = vp.width / SCALE * 25.4 / 72, h = vp.height / SCALE * 25.4 / 72;
    doc.addPage([w, h + STRIP], w > h + STRIP ? 'landscape' : 'portrait');
    doc.addImage(canvas.toDataURL('image/jpeg', 0.88), 'JPEG', 0, 0, w, h);
    doc.setDrawColor(210).line(0, h, w, h).setDrawColor(0);
    doc.setFont('helvetica', 'normal').setFontSize(7).setTextColor(60);
    const ty = h + STRIP / 2 + 1.2;
    let x = 8;
    const swatch = (rgb) => { doc.setFillColor(...rgb.map((v) => Math.round(v * 255))).rect(x, ty - 2.1, 3.5, 2.6, 'F'); x += 4.5; };
    for (const t of ['T', 'P', 'NA']) {
      if (t === 'P') { const labs = [...labColor.values()].slice(0, 4); (labs.length ? labs : [COLOR.P]).forEach(swatch); } else swatch(COLOR[t]);
      const label = t === 'P' ? 'Practical: one colour per lab (see the summary)' : LABEL[t];
      doc.text(label, x, ty);
      x += doc.getTextWidth(label) + 5;
    }
    doc.text('Not highlighted: not mapped in the PTC Exams app (no End Exam / equivalent)', x, ty);
    doc.setTextColor(0);
  }
  await src.destroy();
  return { name: file.name.replace(/\.pdf$/i, '') + ' - highlighted.pdf', blob: doc.output('blob'), seen };
}

// Highlight these PDFs; one downloads as itself, several as one zip.
async function run(files) {
  const btn = $('nrHlBtn');
  btn.disabled = true;
  try {
    const [pdfjs, jsPDF] = await Promise.all([loadPdfjs(), loadJsPdf()]);
    const done = [];
    for (const f of files) {
      toast(`Highlighting ${f.name} (${done.length + 1} of ${files.length})…`);
      done.push(await highlight(f, pdfjs, jsPDF));
    }
    if (done.length === 1) download(done[0].name, done[0].blob);
    else {
      const zip = new (await loadJsZip())();
      for (const d of done) zip.file(d.name, d.blob);
      download(`NR_highlighted_${slug($('prCourse').value || 'all')}.zip`, await zip.generateAsync({ type: 'blob' }));
    }
    const s = { T: 0, P: 0, NA: 0, '': new Set() };
    for (const d of done) { s.T += d.seen.T.size; s.P += d.seen.P.size; s.NA += d.seen.NA.size; for (const c of d.seen['']) s[''].add(c); }
    toast(`${done.length} roll(s) highlighted · ${s.T} theory · ${s.P} practical${s.NA ? ` · ${s.NA} no end exam` : ''} code(s) · ${s[''].size} not mapped${s[''].size ? ` (${[...s['']].slice(0, 6).join(', ')}${s[''].size > 6 ? ' …' : ''})` : ''}`);
  } catch (err) {
    console.error(err);
    toast(err.message || 'Could not highlight that PDF');
  } finally {
    btn.disabled = false;
  }
}

// The rolls of the course chosen in Practicals (all courses: every roll; 1000 / 3000: every full-time / part-time roll).
let missing = []; // file names asked for (uploaded before the PDFs were kept)
$('nrHlBtn').addEventListener('click', async () => {
  const course = $('prCourse').value;
  const of = (r) => !course || r.courses.some((c) => (/^[13]000$/.test(course) ? commonCourse(c.courseNo) === course : c.courseNo === course));
  const [rolls, pdfs] = await Promise.all([store.all(), nrPdfStore.all()]);
  const want = rolls.filter(of);
  if (!want.length) return toast(course ? `No nominal roll saved for course ${course}` : 'No nominal rolls saved yet. Upload them in Nominal Roll Upload.');
  const kept = new Map(pdfs.map((p) => [p.fileName, p]));
  missing = want.filter((r) => !kept.has(r.fileName)).map((r) => r.fileName);
  const files = want.filter((r) => kept.has(r.fileName)).map((r) => new File([kept.get(r.fileName).blob], r.fileName, { type: 'application/pdf' }));
  if (missing.length) {
    toast(`${missing.length} roll(s) were uploaded before the PDFs were kept: choose ${missing.length === 1 ? missing[0] : 'them'} once (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' …' : ''})`);
    $('nrHlInput')._have = files;
    return $('nrHlInput').click();
  }
  await run(files);
});
$('nrHlInput').addEventListener('change', async (e) => {
  const picked = pdfFiles(e.target.files);
  const have = e.target._have || [];
  e.target.value = '';
  e.target._have = null;
  // keep the chosen PDFs for next time (under the saved roll's file name when it matches)
  for (const f of picked) await nrPdfStore.put({ fileName: f.name, blob: f, savedAt: new Date().toISOString() }).catch(() => {});
  const files = [...have, ...picked.filter((f) => !have.some((h) => h.name === f.name))];
  const still = missing.filter((m) => !picked.some((f) => f.name === m));
  if (still.length) toast(`Not chosen: ${still.join(', ')} — highlighting the rest`);
  if (files.length) await run(files);
});
