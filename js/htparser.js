// Hall Ticket (DOTE) PDF parser.
// One ticket = a header page (student details + subject table), optional continuation page(s)
// for a long subject table, then an instructions page. Works in the browser and in Node.

const COL = {
  sem: [40, 85],
  regl: [85, 135],
  type: [135, 180],
  code: [180, 250],
  name: [250, 420],
  date: [420, 480],
  time: [480, 9999],
};
const inCol = (it, c) => it.x >= COL[c][0] && it.x < COL[c][1];
const CODE_RE = /^[A-Z0-9]{4,14}$/;
const DATE_RE = /^(\d{2})-(\d{2})-(\d{4})$/;
const ROW_REACH = 14; // max vertical distance from a row's code to its wrapped name / time lines
const Y_TOL = 2.5;

async function readPages(pdfjs, data) {
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      const str = it.str.replace(/\s+/g, ' ').trim();
      if (str) items.push({ x: it.transform[4], y: it.transform[5], str });
    }
    items.sort((a, b) => (Math.abs(a.y - b.y) > Y_TOL ? b.y - a.y : a.x - b.x));
    pages.push({ page: p, items });
    page.cleanup();
  }
  await doc.destroy();
  return pages;
}

const sameLine = (a, b) => Math.abs(a.y - b.y) <= Y_TOL;

// "10.00 am - 12.00 pm" → FN, "02.00 pm - 05.00 pm" → AN
export function sessionOf(time) {
  const m = String(time).match(/^\s*(\d{1,2})[.:](\d{2})\s*(am|pm)/i);
  if (!m) return '';
  let h = +m[1] % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h < 12 ? 'FN' : 'AN';
}

function readHeader(items) {
  const labels = { Centre: 'centre', 'Register No': 'regNo', Name: 'name', 'Date of Birth': 'dob', Course: 'course' };
  const out = {};
  for (const it of items) {
    const key = labels[it.str.replace(/\s*:\s*$/, '')];
    if (!key || it.x > 130) continue;
    out[key] = items.filter((v) => v !== it && sameLine(v, it) && v.x > it.x + 40).map((v) => v.str).join(' ');
  }
  const da = items.find((i) => /^Differently Abled/i.test(i.str));
  if (da) {
    const below = items.filter((i) => i.y < da.y - 4 && i.y > da.y - 30 && !/^Exam$|^Sem$/.test(i.str));
    const v = below.filter((i) => sameLine(i, below[0] || i)).map((i) => i.str).join(' ');
    out.concession = v === '-' ? '' : v;
  }
  const title = items.find((i) => /HALL TICKET FOR/i.test(i.str));
  if (title) out.exam = title.str.replace(/^.*HALL TICKET FOR\s*/i, '');
  const gen = items.find((i) => /^Generated On/i.test(i.str));
  if (gen) out.generatedOn = gen.str.replace(/^Generated On\s*:?\s*/i, '');
  return out;
}

// Rows are anchored on the subject code; wrapped name lines and the two-line session text sit
// a few points above/below, so every other cell joins the row whose code is vertically nearest.
function readRows(items, top, bottom) {
  const cells = items.filter((i) => i.y < top && i.y > bottom);
  const anchors = cells.filter((i) => inCol(i, 'code') && CODE_RE.test(i.str));
  const rows = anchors.map((a) => ({ y: a.y, code: a.str, parts: { sem: [], regl: [], type: [], name: [], date: [], time: [] } }));
  const lowest = Math.min(...anchors.map((a) => a.y));
  const tail = []; // name text below the last row: the start of a row continued on the next page
  for (const c of cells) {
    if (anchors.includes(c)) continue;
    let best = null;
    for (const r of rows) if (!best || Math.abs(r.y - c.y) < Math.abs(best.y - c.y)) best = r;
    if (!best || Math.abs(best.y - c.y) > ROW_REACH) {
      if (inCol(c, 'name') && c.y < lowest) tail.push(c);
      continue;
    }
    const col = Object.keys(best.parts).find((k) => inCol(c, k));
    if (col) best.parts[col].push(c);
  }
  const out = rows.map((r) => {
    const txt = (k) => r.parts[k].sort((a, b) => b.y - a.y || a.x - b.x).map((i) => i.str).join(' ').trim();
    const dateRaw = txt('date');
    const time = txt('time').replace(/\s+/g, ' ');
    const d = dateRaw.match(DATE_RE);
    return {
      sem: parseInt(txt('sem'), 10) || 0,
      regulation: txt('regl'),
      type: txt('type').toUpperCase(),
      code: r.code,
      name: txt('name'),
      date: d ? `${d[3]}-${d[2]}-${d[1]}` : '', // ISO for sorting
      time: d && time !== '-' ? time : '',
      session: d ? sessionOf(time) : '',
      dateRaw,
    };
  });
  out.tail = tail.sort((a, b) => b.y - a.y).map((i) => i.str).join(' ');
  return out;
}

function checkTicket(t) {
  const issues = [];
  if (!t.regNo) issues.push('Missing register no');
  if (!t.name) issues.push('Missing name');
  if (!t.subjects.length) issues.push('No subjects found');
  for (const s of t.subjects) {
    const bad = [];
    if (!s.sem) bad.push('sem');
    if (!s.regulation) bad.push('regulation');
    if (!/^[RS]$/.test(s.type)) bad.push('exam type');
    if (!s.name) bad.push('subject name');
    if (!s.date && s.dateRaw !== '-') bad.push(`date "${s.dateRaw}"`);
    if (s.date && !s.session) bad.push('session');
    if (bad.length) issues.push(`${s.code}: unreadable ${bad.join(', ')}`);
  }
  const seen = new Map();
  for (const s of t.subjects) {
    if (!s.date) continue;
    const k = s.date + ' ' + s.session;
    if (seen.has(k)) issues.push(`Clash on ${s.dateRaw} ${s.session}: ${seen.get(k)} & ${s.code}`);
    else seen.set(k, s.code);
  }
  return issues;
}

export async function parseHallTickets(pdfjs, data, fileName = '') {
  const pages = await readPages(pdfjs, data);
  const tickets = [];
  const meta = {};
  const fileIssues = [];
  let cur = null;
  let carry = ''; // subject name text that ran off the bottom of the previous page
  let headerPages = 0;

  for (const { page, items } of pages) {
    if (items.some((i) => /^INSTRUCTIONS TO THE CANDIDATES/i.test(i.str))) {
      cur = null; // instructions close a ticket
      carry = '';
      continue;
    }
    const sig = items.find((i) => /^Signature of the Student/i.test(i.str));
    const bottom = sig ? sig.y + 4 : 40; // footer ("PTO", "Page n") sits around y=26
    const regLabel = items.find((i) => /^Register No/i.test(i.str) && i.x < 130);

    if (regLabel) {
      headerPages++;
      const h = readHeader(items);
      meta.centre ??= h.centre;
      meta.exam ??= h.exam;
      meta.generatedOn ??= h.generatedOn;
      const cm = (h.course || '').match(/^(\w+)\s*-\s*(.+)$/);
      cur = {
        regNo: h.regNo || '',
        name: h.name || '',
        dob: h.dob || '',
        courseNo: cm ? cm[1] : '',
        courseName: cm ? cm[2].trim() : h.course || '',
        concession: h.concession || '',
        subjects: [],
        page,
      };
      tickets.push(cur);
      const head = items.filter((i) => /^(Sem|Regl\.?|Subject Code|Exam Date|Type)$/.test(i.str));
      const top = head.length ? Math.min(...head.map((i) => i.y)) - 1 : regLabel.y - 60;
      const rows = readRows(items, top, bottom);
      carry = rows.tail;
      cur.subjects.push(...rows);
    } else if (cur) {
      const rows = readRows(items, 9999, bottom);
      if (carry && rows[0]) rows[0].name = (carry + ' ' + rows[0].name).trim();
      carry = rows.tail;
      cur.subjects.push(...rows);
    } else if (items.length > 2) {
      fileIssues.push(`Page ${page}: content outside any hall ticket`);
    }
  }

  for (const t of tickets) {
    t.issues = checkTicket(t);
    t.verified = t.issues.length === 0;
  }
  if (headerPages !== tickets.length) fileIssues.push(`${headerPages} ticket headers, parsed ${tickets.length}`);
  const dup = tickets.length - new Set(tickets.map((t) => t.regNo)).size;
  if (dup) fileIssues.push(`${dup} duplicate register no(s)`);

  return {
    fileName,
    numPages: pages.length,
    meta,
    courses: [...new Map(tickets.map((t) => [t.courseNo, { courseNo: t.courseNo, courseName: t.courseName }])).values()],
    tickets,
    issues: fileIssues,
    parsedAt: new Date().toISOString(),
  };
}
