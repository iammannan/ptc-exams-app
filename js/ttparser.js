// DOTE Board Examinations Time Table PDF parser.
// Each page: course header ("1010  CIVIL ENGINEERING"), scheme headings ("R2023", "N Scheme"),
// "Semester - III" headings, then rows: Date & Day | Time | Scode | Subject | Remarks.
// Works in the browser and in Node — caller passes in the pdf.js module.

const DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8 };
const COL = { date: [60, 140], time: [140, 235], code: [235, 290], name: [290, 420], remarks: [420, 9999] };
const inCol = (it, c) => it.x >= COL[c][0] && it.x < COL[c][1];
const ROW_REACH = 12;

// "10.00 am - 12.00 noon" → FN, "02.00 pm - 04.00 pm" → AN
export function ttSession(time) {
  const m = String(time).match(/(\d{1,2})[.:](\d{2})\s*(am|pm|noon)/i);
  if (!m) return '';
  const h = (+m[1] % 12) + (/pm/i.test(m[3]) ? 12 : 0);
  return h < 12 ? 'FN' : 'AN';
}

export async function parseTimetable(pdfjs, data) {
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  const meta = {};
  const entries = [];
  let course = null, scheme = '', sem = 0;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    page.cleanup();
    const items = tc.items
      .map((it) => ({ x: it.transform[4], y: it.transform[5], str: it.str.replace(/\s+/g, ' ').trim() }))
      .filter((i) => i.str);
    if (!items.some((i) => /^Time Table/i.test(i.str))) continue; // covering letter etc.
    meta.title ??= items.find((i) => /^Time Table/i.test(i.str)).str;
    meta.version ??= items.find((i) => /^\(Version/i.test(i.str))?.str.replace(/[()]/g, '');
    items.sort((a, b) => b.y - a.y || a.x - b.x);

    // Course header: a 4-digit course number at the left, name to its right on the same line
    const head = items.find((i) => /^\d{4}$/.test(i.str) && i.x < 120);
    if (head) {
      const name = items.filter((i) => Math.abs(i.y - head.y) < 2 && i.x > head.x + 20).map((i) => i.str).join(' ');
      if (!course || course.no !== head.str) { scheme = ''; sem = 0; }
      course = { no: head.str, name };
    }
    if (!course) continue;

    const dates = items.filter((i) => inCol(i, 'date') && DATE_RE.test(i.str));
    const rows = dates.map((d) => ({ d, parts: { time: [], code: [], name: [], remarks: [] } }));
    // headings sit between rows, so walk the page top→bottom and stamp scheme/sem onto each row
    const marks = items
      .filter((i) => i.x > 240 && i.x < 340 && (/^Semester\s*-\s*[IVX]+$/i.test(i.str) || /^(R\d{4}|[A-Z] Scheme)$/i.test(i.str)))
      .map((i) => ({ y: i.y, str: i.str }));
    for (const it of items) {
      if (dates.includes(it) || it.y > (head?.y ?? 9999) - 5) continue;
      if (marks.some((m) => m.y === it.y && m.str === it.str)) continue;
      let best = null;
      for (const r of rows) if (!best || Math.abs(r.d.y - it.y) < Math.abs(best.d.y - it.y)) best = r;
      if (!best || Math.abs(best.d.y - it.y) > ROW_REACH) continue;
      const col = Object.keys(best.parts).find((k) => inCol(it, k));
      if (col) best.parts[col].push(it);
    }
    const events = [...marks.map((m) => ({ y: m.y, mark: m.str })), ...rows.map((r) => ({ y: r.d.y, row: r }))].sort((a, b) => b.y - a.y);
    for (const e of events) {
      if (e.mark) {
        const sm = e.mark.match(/^Semester\s*-\s*([IVX]+)$/i);
        if (sm) sem = ROMAN[sm[1].toUpperCase()] || 0;
        else scheme = e.mark.replace(/\s*Scheme$/i, '').toUpperCase();
        continue;
      }
      const r = e.row;
      const txt = (k) => r.parts[k].sort((a, b) => b.y - a.y || a.x - b.x).map((i) => i.str).join(' ').trim();
      const m = r.d.str.match(DATE_RE);
      const time = txt('time');
      const code = txt('code').replace(/\s+/g, '');
      if (!code) continue;
      entries.push({
        course: course.no,
        courseName: course.name,
        scheme: scheme || 'R2023',
        sem,
        date: `${m[3]}-${m[2]}-${m[1]}`,
        time,
        session: ttSession(time),
        code,
        name: txt('name'),
        remarks: txt('remarks'),
      });
    }
  }
  await doc.destroy();
  return { meta, entries };
}

// Compact form stored in the app: rows [course, scheme, sem, date, time, code, name, remarks]
export function packTimetable({ meta, entries }, file = '') {
  return {
    meta: { ...meta, file },
    courses: Object.fromEntries(entries.map((e) => [e.course, e.courseName])),
    rows: entries.map((e) => [e.course, e.scheme, e.sem, e.date, e.time, e.code, e.name, e.remarks]),
  };
}
