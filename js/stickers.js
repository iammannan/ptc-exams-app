// QR sticker hall separation guide. DOTE's answer-book QR sticker PDF (24 stickers an A4 page, 3 across × 8 down,
// in register-number order) is read, not changed: each sticker's register number and position is matched to its hall
// in this app's seating for the session, and a guide PDF draws every sticker page as a small map — each sticker
// labelled with its hall, thick black lines where to cut between halls — up to six maps to a landscape A4 sheet, for black-and-white printing.
import { kv } from './kv.js';
import { $, esc, toast, loadPdfjs, loadJsPdf, bindDropzone, pdfFiles } from './util.js';

const REG = /^\d{8,12}$/;
let sets = []; // [{ source, key, label, pages: [{ page, w, h, cols: [x], rows: [y], cells: [{ n, reg, name, code, c, r, hall }] }], total, missing }]

const dmyOf = (iso) => iso.split('-').reverse().join('-');
// "23102026_FN.pdf" → 2026-10-23 FN; otherwise the date and session picked in Seating
function sessionOf(fileName) {
  const m = fileName.match(/(\d{2})[-_.]?(\d{2})[-_.]?(\d{4})\D*(FN|AN)/i);
  if (m) return { key: `${m[3]}-${m[2]}-${m[1]}|${m[4].toUpperCase()}`, label: `${m[1]}-${m[2]}-${m[3]} ${m[4].toUpperCase()}` };
  const date = $('seatDate').value;
  const s = $('seatSession').querySelector('[aria-checked="true"]')?.dataset.s || 'FN';
  return date ? { key: `${date}|${s}`, label: `${dmyOf(date)} ${s}`, picked: true } : null;
}

// reg no → hall name for one exam session
function hallsFor(key) {
  const names = new Map(kv.get('halls', []).map((h) => [h.id, h.name]));
  const out = new Map();
  for (const [hallId, seats] of Object.entries(kv.get('plans', {})[key] || {}))
    for (const st of Object.values(seats)) out.set(st.reg, names.get(hallId) || hallId);
  return out;
}

// Group close coordinates (sticker columns / rows) into sorted bands.
function bands(values, tol) {
  const out = [];
  for (const v of [...values].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
  return out;
}

async function readStickers(file, pdfjs) {
  const sess = sessionOf(file.name);
  if (!sess) throw new Error('exam date not found in the file name (e.g. 23102026_FN.pdf). Pick the date and session in Seating first.');
  const hallOf = hallsFor(sess.key);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), verbosity: 0 }).promise;
  const set = { source: file.name, key: sess.key, label: sess.label, picked: !!sess.picked, pages: [], total: 0, missing: [] };
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const items = (await page.getTextContent()).items.map((i) => ({ str: i.str.trim(), x: i.transform[4], y: i.transform[5] })).filter((i) => i.str);
    page.cleanup();
    const regs = items.filter((i) => REG.test(i.str));
    if (!regs.length) continue;
    const cols = bands(regs.map((i) => i.x), 30);
    const rows = bands(regs.map((i) => -i.y), 30).map((y) => -y); // top first
    const near = (i, r, dy) => items.find((t) => Math.abs(t.x - r.x) < 4 && Math.abs(t.y - (r.y - dy)) < 4 && t !== r)?.str || '';
    const cells = regs
      .map((r) => ({
        reg: r.str,
        x: r.x,
        y: r.y,
        name: near(r, r, 16),
        code: (items.find((t) => /^·?\s*[A-Z0-9]{5,12}$/.test(t.str) && t.str.includes('·') && Math.abs(t.y - (r.y - 30)) < 4 && t.x > r.x && t.x - r.x < 60)?.str || '').replace(/^·\s*/, ''),
        c: cols.findIndex((x) => Math.abs(x - r.x) <= 30),
        r: rows.findIndex((y) => Math.abs(y - r.y) <= 30),
        hall: hallOf.get(r.str) || '',
      }))
      .sort((a, b) => a.r - b.r || a.c - b.c);
    cells.forEach((c) => { c.n = ++set.total; if (!c.hall) set.missing.push(c.reg); });
    set.pages.push({ page: p, w: vp.width, h: vp.height, cols, rows, cells });
  }
  await doc.destroy();
  if (!set.total) throw new Error('no register numbers found. Is this the DOTE QR sticker PDF?');
  return set;
}

// Sticker number runs per hall, in reading order: [{ hall, page, from, to, n }]
function runs(set) {
  const out = [];
  for (const p of set.pages)
    for (const c of p.cells) {
      const last = out[out.length - 1];
      if (last && last.hall === c.hall && last.page === p.page && last.to === c.n - 1) { last.to = c.n; last.n++; }
      else out.push({ hall: c.hall, page: p.page, from: c.n, to: c.n, n: 1 });
    }
  return out;
}
const hallTotals = (set) => {
  const m = new Map();
  for (const p of set.pages) for (const c of p.cells) m.set(c.hall || 'Not seated', (m.get(c.hall || 'Not seated') || 0) + 1);
  return [...m];
};
const numText = (r) => (r.from === r.to ? `#${r.from}` : `#${r.from}–${r.to}`);

function render() {
  $('stkAll').disabled = !sets.length;
  $('stkClear').hidden = !sets.length;
  $('stkList').innerHTML = sets
    .map((s, i) => {
      const warn = s.missing.length ? `<span class="badge warn" title="${esc(s.missing.join(', '))}">${s.missing.length} not seated</span>` : '<span class="badge ok">all seated</span>';
      const byPage = new Map();
      for (const r of runs(s)) (byPage.get(r.page) || byPage.set(r.page, []).get(r.page)).push(r);
      const guide = [...byPage].map(([pg, rs]) => `<div><b>Page ${pg}:</b> ${rs.map((r) => `${numText(r)} → <b>${esc(r.hall || 'Not seated')}</b>`).join(' · ')}</div>`).join('');
      return `<details class="progress-item att-sheet">
        <summary><span class="name">${esc(s.source)}</span>
          <span class="msg">${esc(s.label)}${s.picked ? ' (from Seating)' : ''} · ${s.pages.length} page(s) · ${s.total} stickers · ${hallTotals(s).map(([h, n]) => `${esc(h)} ${n}`).join(' · ')}</span> ${warn}
          <button class="btn ghost sm" data-stkguide="${i}">Guide PDF</button></summary>
        <div class="att-guide">${guide}</div>
      </details>`;
    })
    .join('');
}

// Up to six sticker-page maps to a landscape A4 sheet (3 across × 2 down), made for black-and-white printing: each
// map fills its share of the sheet, halls alternate white / light grey, and thick black lines mark where to cut.
// With fewer pages the maps grow: 4 as 2 × 2, 3 in a row, 2 side by side, 1 filling the sheet.
const GRID = { 1: [1, 1], 2: [2, 1], 3: [3, 1], 4: [2, 2], 6: [3, 2] };
async function guidePdf(list, name) {
  const jsPDF = await loadJsPdf();
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const n = list.reduce((m, x) => m + x.pages.length, 0);
  const per = n <= 4 ? n || 1 : 6;
  const [COLS, ROWS] = GRID[per];
  const m = 5, gap = 5, label = 6;
  const slotW = (W - 2 * m - gap * (COLS - 1)) / COLS;
  const slotH = (H - 2 * m - gap * (ROWS - 1)) / ROWS;
  // largest font (pt) at which text fits the width, capped
  const fit = (text, font, max, width) => { doc.setFont('helvetica', font).setFontSize(max); const w = doc.getTextWidth(text); return w > width ? (max * width) / w : max; };
  let k = 0;
  for (const s of list) {
    // halls in order of first appearance, shaded alternately so neighbouring halls look different in grey
    const order = [];
    for (const p of s.pages) for (const c of p.cells) if (c.hall && !order.includes(c.hall)) order.push(c.hall);
    const shade = (h) => (!h ? 255 : order.indexOf(h) % 2 ? 222 : 255);
    for (const p of s.pages) {
      if (k && k % per === 0) doc.addPage();
      const slot = k % per;
      const x = m + (slot % COLS) * (slotW + gap);
      const y = m + Math.floor(slot / COLS) * (slotH + gap);
      // the page's sticker grid stretched over the whole slot
      const nc = Math.max(...s.pages.map((q) => q.cols.length)), nr = Math.max(...s.pages.map((q) => q.rows.length));
      const cw = slotW / nc, ch = (slotH - label) / nr;
      doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(0).text(`Page ${p.page}`, x, y + 4.2);
      doc.setFont('helvetica', 'normal').setFontSize(9).text(`${s.label}  ·  #${p.cells[0].n}–${p.cells[p.cells.length - 1].n}`, x + slotW, y + 4.2, { align: 'right' });
      const at = new Map(p.cells.map((c) => [c.c + ',' + c.r, c]));
      const box = (c) => ({ bx: x + c.c * cw, by: y + label + c.r * ch, bw: cw, bh: ch });
      for (const c of p.cells) {
        const { bx, by, bw, bh } = box(c);
        doc.setFillColor(shade(c.hall)).setDrawColor(120).setLineWidth(0.2).rect(bx, by, bw, bh, 'FD');
        const hall = c.hall || 'NOT SEATED';
        const hs = fit(hall, 'bold', Math.min(20, bh * 1.25), bw - 12); // clear of the sticker number in the corner
        const rs = fit(c.reg, 'bold', Math.min(13, bh * 0.85), bw - 3);
        const gapY = (bh - (hs + rs) * 0.3528) / 3; // spread hall name and register number evenly down the box
        doc.setFont('helvetica', 'bold').setFontSize(hs).setTextColor(0).text(hall, bx + bw / 2, by + gapY + hs * 0.3528 * 0.8, { align: 'center' });
        doc.setFont('helvetica', 'normal').setFontSize(rs).text(c.reg, bx + bw / 2, by + 2 * gapY + (hs + rs * 0.8) * 0.3528, { align: 'center' });
        doc.setFontSize(Math.min(7, bh * 0.5)).setTextColor(80).text(`#${c.n}`, bx + 0.8, by + 2.4).setTextColor(0);
      }
      doc.setDrawColor(0).setLineWidth(0.5).rect(x, y + label, nc * cw, nr * ch);
      // thick black cut lines between neighbouring stickers of different halls
      doc.setLineWidth(1.1);
      for (const c of p.cells) {
        const { bx, by, bw, bh } = box(c);
        const right = at.get(c.c + 1 + ',' + c.r), below = at.get(c.c + ',' + (c.r + 1));
        if (right && right.hall !== c.hall) doc.line(bx + bw, by, bx + bw, by + bh);
        if (below && below.hall !== c.hall) doc.line(bx, by + bh, bx + bw, by + bh);
      }
      k++;
    }
  }
  doc.save(name);
}

async function handle(list) {
  const files = pdfFiles(list);
  if (!files.length) return toast('Please choose the DOTE QR sticker PDFs');
  const box = $('stkProgress');
  box.hidden = false;
  try {
    const pdfjs = await loadPdfjs();
    for (const [n, f] of files.entries()) {
      box.textContent = `Reading ${n + 1} of ${files.length}: ${f.name}…`;
      try {
        const s = await readStickers(f, pdfjs);
        sets = sets.filter((x) => x.source !== f.name);
        sets.push(s);
      } catch (e) {
        console.error(e);
        toast(`${f.name}: ${e.message || 'could not be read'}`);
      }
      await new Promise((r) => setTimeout(r));
    }
    box.hidden = true;
    render();
    const missing = sets.reduce((n, s) => n + s.missing.length, 0);
    if (sets.length) toast(missing ? `${missing} sticker(s) have no seat in that session: shown as NOT SEATED.` : 'Every sticker has a hall');
  } catch (e) {
    console.error(e);
    box.textContent = 'Could not load the PDF reader. Check your internet connection and try again.';
  }
}

bindDropzone($('stkDrop'), $('stkInput'), handle);
$('stkList').addEventListener('click', (e) => {
  const i = e.target.closest('[data-stkguide]')?.dataset.stkguide;
  if (i == null) return;
  e.preventDefault(); // keep the details row from toggling
  const s = sets[+i];
  guidePdf([s], `Sticker_Guide_${s.label}.pdf`.replace(/[^\w.-]+/g, '_'));
});
$('stkAll').addEventListener('click', () => guidePdf(sets, 'QR_Sticker_Guide.pdf'));
$('stkClear').addEventListener('click', () => { sets = []; render(); });
