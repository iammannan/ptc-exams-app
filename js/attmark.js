// Hall marking guide for DOTE attendance sheets. The DOTE PDFs only allow printing, so they are not changed:
// the app reads each row's S.No and register number, finds the candidate's hall in this app's seat allocations
// for the exam date and session printed on the sheet, and makes a guide listing, page by page, which S.No range
// sits in which hall — so the printed sheets can be bracketed by hand.
import { kv } from './kv.js';
import { $, esc, toast, loadPdfjs, loadJsPdf, bindDropzone, pdfFiles } from './util.js';

const REG = /^[A-Z0-9]{6,12}$/;
let sheets = []; // [{ source, subject, course, title, session, pages: [{ page, runs: [{ from, to, regFrom, regTo, hall, n }] }], total, missing }]

// "22-10-2026" + "FN" from the sheet header → the seat plan key "2026-10-22|FN"
function sheetSession(items) {
  const d = items.find((i) => /^\d{2}-\d{2}-\d{4}$/.test(i.str) && i.x > 450 && i.y > 650);
  const s = items.find((i) => /^(FN|AN)$/.test(i.str) && i.x > 450 && i.y > 650);
  if (!d || !s) return null;
  const [dd, mm, yy] = d.str.split('-');
  return { key: `${yy}-${mm}-${dd}|${s.str}`, label: `${d.str} ${s.str}` };
}

// reg no → hall name for one exam session
function hallsFor(key) {
  const names = new Map(kv.get('halls', []).map((h) => [h.id, h.name]));
  const out = new Map();
  for (const [hallId, seats] of Object.entries(kv.get('plans', {})[key] || {}))
    for (const st of Object.values(seats)) out.set(st.reg, names.get(hallId) || hallId);
  return out;
}

async function readSheet(file, pdfjs) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), verbosity: 0 }).promise;
  const sheet = { source: file.name, subject: '', course: '', title: '', session: '', pages: [], total: 0, missing: [] };
  let hallOf = null;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const items = (await page.getTextContent()).items.map((i) => ({ str: i.str.trim(), x: i.transform[4], y: i.transform[5] })).filter((i) => i.str);
    page.cleanup();
    if (!hallOf) {
      const sess = sheetSession(items);
      if (!sess) throw new Error('exam date / session not found. Is this a DOTE attendance sheet?');
      hallOf = hallsFor(sess.key);
      sheet.session = sess.label;
      const top = items.filter((i) => i.y > 650 && i.x < 150);
      sheet.course = top.find((i) => /^\d{4}$/.test(i.str))?.str || '';
      sheet.subject = top.find((i) => /^\d{10}$|^[A-Z]{2}\d{6}$|^\d{5,9}$/.test(i.str) && i.str !== sheet.course)?.str || '';
      // course name and subject name (between the header labels and the table head)
      sheet.title = items.filter((i) => i.y > 676 && i.y < 702 && i.x > 150 && i.x < 450).sort((a, b) => b.y - a.y).map((i) => i.str).join(' · ');
    }
    // rows: register number in the Reg No column, paired with the S.No on the same row
    const head = items.find((i) => /^S\.?No\.?$/i.test(i.str));
    const regs = items.filter((i) => REG.test(i.str) && /\d/.test(i.str) && i.x > 45 && i.x < 120 && (!head || i.y < head.y - 5)).sort((a, b) => b.y - a.y);
    const rows = regs.map((r, k) => {
      const sno = items.find((i) => /^\d+$/.test(i.str) && i.x < 45 && Math.abs(i.y - (r.y - 4)) < 8);
      return { sno: sno ? +sno.str : sheet.total + k + 1, reg: r.str, hall: hallOf.get(r.str) || '' };
    });
    if (!rows.length) continue;
    const runs = [];
    for (const r of rows) {
      const last = runs[runs.length - 1];
      if (last && last.hall === r.hall) { last.to = r.sno; last.regTo = r.reg; last.n++; }
      else runs.push({ from: r.sno, to: r.sno, regFrom: r.reg, regTo: r.reg, hall: r.hall, n: 1 });
      if (!r.hall) sheet.missing.push(r.reg);
    }
    sheet.total += rows.length;
    sheet.pages.push({ page: p, runs });
  }
  await doc.destroy();
  return sheet;
}

const runText = (r) => (r.from === r.to ? `S.No ${r.from}` : `S.No ${r.from}–${r.to}`);
const hallTotals = (s) => {
  const m = new Map();
  for (const p of s.pages) for (const r of p.runs) m.set(r.hall || 'Not seated', (m.get(r.hall || 'Not seated') || 0) + r.n);
  return [...m];
};

function render() {
  $('attMarkAll').disabled = !sheets.length;
  $('attMarkClear').hidden = !sheets.length;
  $('attMarkList').innerHTML = sheets
    .map((s, i) => {
      const warn = s.missing.length ? `<span class="badge warn" title="${esc(s.missing.join(', '))}">${s.missing.length} not seated</span>` : '<span class="badge ok">all seated</span>';
      const guide = s.pages.map((p) => `<div><b>Page ${p.page}:</b> ${p.runs.map((r) => `${runText(r)} → <b>${esc(r.hall || 'Not seated')}</b>`).join(' · ')}</div>`).join('');
      return `<details class="progress-item att-sheet">
        <summary><span class="name">${esc(s.course)} · ${esc(s.subject)}</span>
          <span class="msg">${esc(s.session)} · ${s.pages.length} page(s) · ${s.total} candidates · ${hallTotals(s).map(([h, n]) => `${esc(h)} ${n}`).join(' · ')}</span> ${warn}
          <button class="btn ghost sm" data-attguide="${i}">Guide PDF</button></summary>
        <div class="att-guide">${guide}</div>
      </details>`;
    })
    .join('');
}

// One guide PDF for the given sheets: a table per sheet, page by page.
async function guidePdf(list, name) {
  const jsPDF = await loadJsPdf();
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const W = doc.internal.pageSize.getWidth();
  list.forEach((s, i) => {
    if (i) doc.addPage();
    doc.setFont('helvetica', 'bold').setFontSize(14).text('Hall Marking Guide — Attendance Sheet', W / 2, 16, { align: 'center' });
    doc.setFontSize(11).text(`${s.course} / ${s.subject}   ·   ${s.session}`, W / 2, 23, { align: 'center' });
    doc.setFont('helvetica', 'normal').setFontSize(9).text(doc.splitTextToSize(s.title, W - 28), W / 2, 28.5, { align: 'center' });
    doc.setFontSize(9).text(`${s.total} candidates · ${hallTotals(s).map(([h, n]) => `${h}: ${n}`).join('  ·  ')}`, W / 2, 36, { align: 'center' });
    doc.autoTable({
      startY: 40,
      head: [['Sheet page', 'S.No', 'Register No', 'Hall', 'Count']],
      // the page number spans that page's rows, so only its first row carries the cell
      body: s.pages.flatMap((p) => p.runs.map((r, k) => [
        ...(k ? [] : [{ content: String(p.page), rowSpan: p.runs.length, styles: { fontStyle: 'bold', valign: 'middle', halign: 'center' } }]),
        r.from === r.to ? String(r.from) : `${r.from} – ${r.to}`,
        r.regFrom === r.regTo ? r.regFrom : `${r.regFrom} – ${r.regTo}`,
        { content: r.hall || 'NOT SEATED', styles: { fontStyle: 'bold', fontSize: 12, textColor: r.hall ? [20, 50, 160] : [190, 30, 30] } },
        { content: String(r.n), styles: { halign: 'right' } },
      ])),
      theme: 'grid',
      styles: { fontSize: 10, cellPadding: 2, valign: 'middle', lineColor: [120, 125, 135], lineWidth: 0.2, textColor: 0 },
      headStyles: { fillColor: [232, 236, 244], textColor: 0, fontStyle: 'bold', halign: 'center' },
      columnStyles: { 0: { cellWidth: 24 }, 1: { cellWidth: 30, halign: 'center' }, 2: { halign: 'center' }, 3: { cellWidth: 36, halign: 'center' }, 4: { cellWidth: 18 } },
      margin: { left: 14, right: 14 },
    });
    const y = doc.lastAutoTable.finalY + 8;
    doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(90);
    doc.text(doc.splitTextToSize('On each printed DOTE attendance page, draw a bracket in the right margin over the listed S.No range and write the hall name beside it. Halls come from this app\'s seating for the date and session on the sheet.', W - 28), 14, y);
    doc.setTextColor(0);
  });
  doc.save(name);
}

async function handle(list) {
  const files = pdfFiles(list);
  if (!files.length) return toast('Please choose the DOTE attendance PDFs');
  const box = $('attMarkProgress');
  box.hidden = false;
  try {
    const pdfjs = await loadPdfjs();
    for (const [n, f] of files.entries()) {
      box.textContent = `Reading ${n + 1} of ${files.length}: ${f.name}…`;
      try {
        const s = await readSheet(f, pdfjs);
        sheets = sheets.filter((x) => x.source !== f.name);
        sheets.push(s);
      } catch (e) {
        console.error(e);
        toast(`${f.name}: ${e.message || 'could not be read'}`);
      }
      await new Promise((r) => setTimeout(r));
    }
    box.hidden = true;
    sheets.sort((a, b) => a.course.localeCompare(b.course) || a.subject.localeCompare(b.subject));
    render();
    const missing = sheets.reduce((n, s) => n + s.missing.length, 0);
    toast(missing ? `${missing} candidate(s) have no seat in that session: shown as NOT SEATED.` : 'Every candidate has a hall');
  } catch (e) {
    console.error(e);
    box.textContent = 'Could not load the PDF reader. Check your internet connection and try again.';
  }
}

bindDropzone($('attMarkDrop'), $('attMarkInput'), handle);
$('attMarkList').addEventListener('click', (e) => {
  const i = e.target.closest('[data-attguide]')?.dataset.attguide;
  if (i == null) return;
  e.preventDefault(); // keep the details row from toggling
  const s = sheets[+i];
  guidePdf([s], `Hall_Guide_${s.course}_${s.subject}.pdf`.replace(/[^\w.-]+/g, '_'));
});
$('attMarkAll').addEventListener('click', () => guidePdf(sheets, 'Hall_Marking_Guide.pdf'));
$('attMarkClear').addEventListener('click', () => { sheets = []; render(); });
