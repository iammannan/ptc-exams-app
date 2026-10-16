// Nominal Roll (DOTE) PDF parser.
// Works in the browser and in Node — caller passes in the pdf.js module.

const COL = {
  sl: [0, 52],
  roll: [52, 135],
  name: [135, 285],
  dob: [285, 345],
  sems: [345, 420],
  count: [420, 475],
  codes: [470, 770],
  reg: [770, 9999],
};
const inCol = (it, c) => it.x >= COL[c][0] && it.x < COL[c][1];
const DOB_RE = /^(\d{2})-(\d{2})-(\d{4})(\s+[\d:]+)?$/;
const SEM_LABEL_RE = /^SEM\s*(\d+)\s*\(([A-Z]+)\)\s*:?$/i;
const Y_TOL = 2.5;

const splitList = (s) => s.split(',').map((t) => t.trim()).filter(Boolean);

async function extractItems(pdfjs, data) {
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  const items = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      const str = it.str.replace(/\s+/g, ' ').trim();
      if (!str) continue;
      items.push({ page: p, x: it.transform[4], y: it.transform[5], str });
    }
    page.cleanup();
  }
  const numPages = doc.numPages;
  await doc.destroy();
  // document reading order: page, top→bottom, left→right
  items.sort((a, b) => a.page - b.page || (Math.abs(a.y - b.y) > Y_TOL ? b.y - a.y : a.x - b.x));
  return { items, numPages };
}

// Group already-sorted items into visual lines.
function toLines(items) {
  const lines = [];
  for (const it of items) {
    const last = lines[lines.length - 1];
    if (last && last.page === it.page && Math.abs(last.y - it.y) <= Y_TOL) last.items.push(it);
    else lines.push({ page: it.page, y: it.y, items: [it] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

function readMeta(lines) {
  const meta = {};
  const labels = {
    'Exam Name': 'exam',
    'Processing Year': 'year',
    'Processing Semester': 'processingSemester',
    'Student Count': 'studentCount',
    'Generated On': 'generatedOn',
  };
  for (const l of lines.slice(0, 15)) {
    for (let i = 0; i < l.items.length; i++) {
      const key = labels[l.items[i].str.replace(/\s*:\s*$/, '')];
      if (key && l.items[i + 1]) meta[key] = l.items[i + 1].str;
    }
    const t = l.items.map((i) => i.str).join(' ');
    if (!meta.college && /^\d+\s*-\s*\S/.test(t) && !/Course/i.test(t)) meta.college = t;
  }
  if (meta.studentCount) meta.studentCount = parseInt(meta.studentCount, 10);
  return meta;
}

// Students may carry several regulations ("R2023, Z"). Work out which one applies to each semester
// from the subject-code style: R20xx codes are alphanumeric (BE232290) or 10-digit; older ones are 5/7 digits.
function assignRegulations(regs, sems) {
  if (regs.length <= 1) return sems.forEach((s) => (s.regulation = regs[0] || ''));
  const isNewStyle = (codes) => codes.some((c) => /^\d{10}$/.test(c) || (/[A-Z]/i.test(c) && /\d/.test(c) && c.length >= 8));
  const rNew = regs.filter((r) => /^R\d{4}$/i.test(r));
  const rOld = regs.filter((r) => !/^R\d{4}$/i.test(r));
  if (rNew.length === 1 && rOld.length === 1) {
    for (const s of sems) s.regulation = isNewStyle(s.codes) ? rNew[0] : rOld[0];
  } else if (regs.length === sems.length) {
    sems.forEach((s, i) => (s.regulation = regs[i]));
  } else {
    for (const s of sems) s.regulation = regs.join(', ');
  }
}

export async function parseNominalRoll(pdfjs, data, fileName = '') {
  const { items, numPages } = await extractItems(pdfjs, data);
  const lines = toLines(items);
  const meta = readMeta(lines);

  const rows = [];
  const blocks = []; // SEM blocks in reading order
  const tableTotals = [];
  let course = null;

  for (const l of lines) {
    const texts = l.items.map((i) => i.str);

    const ci = texts.findIndex((t) => /^Course Name\s*:?$/i.test(t));
    if (ci >= 0) {
      const v = texts.slice(ci + 1).join(' ');
      const m = v.match(/^(\w+)\s*-\s*(.+)$/);
      course = m ? { courseNo: m[1], courseName: m[2].trim() } : { courseNo: '', courseName: v };
      continue;
    }
    const ti = texts.findIndex((t) => /^Total Students\s*:?$/i.test(t));
    if (ti >= 0) {
      tableTotals.push(parseInt(texts[ti + 1], 10) || 0);
      continue;
    }

    // Subject-code column: "SEM n (X):" label starts a block; label-less lines continue the previous one
    const codeItems = l.items.filter((i) => inCol(i, 'codes'));
    const dobItem = l.items.find((i) => inCol(i, 'dob') && DOB_RE.test(i.str));
    if (codeItems.length && !texts.includes('Sem-wise Subject Codes')) {
      const label = codeItems.find((i) => SEM_LABEL_RE.test(i.str));
      const codes = codeItems.filter((i) => i !== label).flatMap((i) => splitList(i.str));
      if (label) {
        const m = label.str.match(SEM_LABEL_RE);
        blocks.push({ sem: +m[1], type: m[2].toUpperCase(), codes });
      } else if (blocks.length) {
        blocks[blocks.length - 1].codes.push(...codes);
      }
    }

    if (dobItem) {
      const get = (c) => l.items.filter((i) => inCol(i, c)).map((i) => i.str).join(' ');
      const d = dobItem.str.match(DOB_RE);
      rows.push({
        slNo: get('sl'),
        regNo: get('roll'),
        name: get('name'),
        dob: `${d[1]}-${d[2]}-${d[3]}`,
        semesters: splitList(get('sems')).map(Number),
        subjectCount: parseInt(get('count'), 10) || 0,
        regulationRaw: get('reg'),
        courseNo: course?.courseNo || '',
        courseName: course?.courseName || '',
        page: l.page,
      });
    }
  }

  // Hand out SEM blocks to rows in order — each row owns as many blocks as it lists semesters.
  let bi = 0;
  const students = rows.map((r) => {
    const sems = blocks.slice(bi, bi + r.semesters.length).map((b) => ({ ...b, codes: [...b.codes] }));
    bi += r.semesters.length;
    const regs = splitList(r.regulationRaw);
    assignRegulations(regs, sems);
    const codeCount = sems.reduce((n, s) => n + s.codes.length, 0);
    const issues = [];
    if (sems.length !== r.semesters.length || sems.some((s, i) => s.sem !== r.semesters[i]))
      issues.push(`Semester list ${r.semesters.join(',')} ≠ parsed ${sems.map((s) => s.sem).join(',')}`);
    if (codeCount !== r.subjectCount) issues.push(`Subject count ${r.subjectCount} ≠ parsed ${codeCount} codes`);
    if (!r.regNo) issues.push('Missing reg no');
    return {
      regNo: r.regNo,
      name: r.name,
      dob: r.dob,
      courseNo: r.courseNo,
      courseName: r.courseName,
      semesters: r.semesters,
      subjectCount: r.subjectCount,
      regulation: r.regulationRaw,
      sems,
      verified: issues.length === 0,
      issues,
      page: r.page,
    };
  });

  const fileIssues = [];
  if (bi !== blocks.length) fileIssues.push(`${blocks.length - bi} SEM line(s) not matched to a student`);
  const tableSum = tableTotals.reduce((a, b) => a + b, 0);
  if (tableSum !== students.length) fileIssues.push(`Table totals say ${tableSum} students, parsed ${students.length}`);
  if (meta.studentCount && meta.studentCount !== students.length)
    fileIssues.push(`Header says ${meta.studentCount} students, parsed ${students.length}`);

  return {
    fileName,
    numPages,
    meta,
    courses: [...new Map(students.map((s) => [s.courseNo, { courseNo: s.courseNo, courseName: s.courseName }])).values()],
    students,
    issues: fileIssues,
    parsedAt: new Date().toISOString(),
  };
}
