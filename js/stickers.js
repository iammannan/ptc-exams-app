// QR sticker hall separation guide. DOTE's answer-book QR sticker PDF (24 stickers an A4 page, 3 across × 8 down,
// in register-number order) is read, not changed: each sticker's register number and position is matched to its hall
// in this app's seating for the session, and a guide PDF draws every sticker page as a small map — each sticker
// tinted and labelled with its hall, red lines where to cut between halls — up to eight maps to a landscape A4 sheet.
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

// Light tints so hall names stay readable; repeated if there are more halls than tints.
const TINTS = [[219, 234, 254], [220, 252, 231], [254, 243, 199], [252, 231, 243], [237, 233, 254], [204, 251, 241], [255, 237, 213], [226, 232, 240], [254, 226, 226], [236, 252, 203]];

// Up to eight sticker-page maps to a landscape A4 sheet (4 across × 2 down), nothing else on the sheet. With fewer
// pages the maps grow: 4 pages in one row, 2 side by side, 1 filling the sheet. Each map is cropped to the stickers.
const GRID = { 1: [1, 1], 2: [2, 1], 4: [4, 1], 8: [4, 2] };
async function guidePdf(list, name) {
  const jsPDF = await loadJsPdf();
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const n = list.reduce((m, x) => m + x.pages.length, 0);
  const per = n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : 8;
  const [COLS, ROWS] = GRID[per];
  const m = 4, gap = 3, label = 4.5;
  const slotW = (W - 2 * m - gap * (COLS - 1)) / COLS;
  const slotH = (H - 2 * m - gap * (ROWS - 1)) / ROWS;
  let k = 0;
  for (const s of list) {
    const order = hallTotals(s).map(([h]) => h);
    const tint = (h) => (h ? TINTS[order.indexOf(h) % TINTS.length] : [255, 255, 255]);
    // sticker pitch and the sticker area, from the fullest page, so every page of the file shares one scale
    const full = s.pages.reduce((a, p) => (p.cells.length > a.cells.length ? p : a));
    const pitchX = full.cols.length > 1 ? (full.cols[full.cols.length - 1] - full.cols[0]) / (full.cols.length - 1) : 190;
    const pitchY = full.rows.length > 1 ? (full.rows[0] - full.rows[full.rows.length - 1]) / (full.rows.length - 1) : 96;
    const left = full.cols[0] - 6, top = full.rows[0] + 14; // sticker area's top-left, in PDF points (y up)
    const areaW = full.cols.length * pitchX - 4, areaH = full.rows.length * pitchY - 4;
    for (const p of s.pages) {
      if (k && k % per === 0) doc.addPage();
      const slot = k % per;
      const sc = Math.min(slotW / areaW, (slotH - label) / areaH);
      const mw = areaW * sc, mh = areaH * sc;
      const x = m + (slot % COLS) * (slotW + gap) + (slotW - mw) / 2;
      const y = m + Math.floor(slot / COLS) * (slotH + gap);
      const f = mw / 70; // text grows with the map
      const box = (c) => ({ bx: x + (c.x - 6 - left) * sc, by: y + label + (top - c.y - 14) * sc, bw: (pitchX - 4) * sc, bh: (pitchY - 4) * sc });
      doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(0).text(`Page ${p.page}`, x, y + 3.2);
      doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(80).text(`${s.label} · #${p.cells[0].n}–${p.cells[p.cells.length - 1].n}`, x + mw, y + 3.2, { align: 'right' }).setTextColor(0);
      const at = new Map(p.cells.map((c) => [c.c + ',' + c.r, c]));
      for (const c of p.cells) {
        const { bx, by, bw, bh } = box(c);
        doc.setFillColor(...tint(c.hall)).setDrawColor(170).setLineWidth(0.15).rect(bx, by, bw, bh, 'FD');
        const hall = c.hall || 'NOT SEATED';
        const hs = Math.min(22, (hall.length > 6 ? 9 : 12) * f);
        doc.setFont('helvetica', 'bold').setFontSize(hs).setTextColor(c.hall ? 0 : 190, c.hall ? 0 : 30, c.hall ? 0 : 30)
          .text(hall, bx + bw / 2, by + bh / 2, { align: 'center', maxWidth: bw - 1 });
        const rs = Math.min(14, 8 * f);
        doc.setFont('helvetica', 'bold').setFontSize(rs).setTextColor(40).text(c.reg, bx + bw / 2, by + bh / 2 + rs * 0.42 + 0.6, { align: 'center' });
        doc.setFont('helvetica', 'normal').setFontSize(Math.min(9, 5 * f)).setTextColor(110).text(`#${c.n}`, bx + 0.8, by + Math.min(9, 5 * f) * 0.38 + 0.5);
        doc.setTextColor(0);
      }
      // red cut lines between neighbouring stickers of different halls
      doc.setDrawColor(210, 30, 30).setLineWidth(Math.max(0.6, 0.6 * f));
      for (const c of p.cells) {
        const { bx, by, bw, bh } = box(c);
        const right = at.get(c.c + 1 + ',' + c.r), below = at.get(c.c + ',' + (c.r + 1));
        if (right && right.hall !== c.hall) { const lx = (bx + bw + box(right).bx) / 2; doc.line(lx, by - 0.6, lx, by + bh + 0.6); }
        if (below && below.hall !== c.hall) { const ly = (by + bh + box(below).by) / 2; doc.line(bx - 0.6, ly, bx + bw + 0.6, ly); }
      }
      doc.setDrawColor(0);
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
