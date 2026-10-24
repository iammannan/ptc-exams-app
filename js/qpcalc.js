// Question-paper statistics: every hall-ticket subject with an exam date is one question paper,
// counted per subject code. Dates come from the time table (or the hall ticket when the
// time table does not list the code); subjects with no exam date (practicals etc.) need no paper.
import { ttSession } from './ttparser.js';

// timetable: { meta, courses, rows: [[course, scheme, sem, date, time, code, name, remarks]] }
// First-year subjects common to every course are listed under 1000 (full time) or 3000 (part time).
export const commonCourse = (course) => (String(course)[0] === '3' ? '3000' : '1000');
export function makeTimetable(tt) {
  const byCode = new Map(); // code → every time table entry for it
  const entries = [];
  for (const [course, scheme, sem, date, time, code, name, remarks] of tt.rows) {
    const base = code.replace(/_\d+$/, ''); // "PH231330_2": same paper on another date (part-time)
    const e = { course, scheme, sem, date, time, session: ttSession(time), code: base, name, remarks, variant: code !== base };
    (byCode.get(base) || byCode.set(base, []).get(base)).push(e);
    entries.push(e);
  }
  // A student's slot: the time table entry for this subject code AND the student's course (or the common first-year
  // course 1000 / 3000). Another course's entry for the same code is not theirs (e.g. 3040's 4040410 theory exam
  // is not 1040's). Several entries (part-time variants): the one on the hall-ticket date, else the first.
  const slot = (code, course, date, session) => {
    const all = byCode.get(code) || [];
    const list = all.filter((e) => e.course === course);
    const pool = list.length ? list : all.filter((e) => e.course === commonCourse(course));
    if (!pool.length) return null;
    return (date && pool.find((e) => e.date === date && e.session === session)) || pool[0];
  };
  // The current subject's own name (time table), so a paper written only under old codes isn't named after one of them.
  const name = (code) => byCode.get(code)?.find((e) => !e.variant)?.name || byCode.get(code)?.[0]?.name || '';
  // Only an entry made for this very course (no fall-back to other courses' entries).
  const exact = (code, course) => byCode.get(code)?.find((e) => e.course === course) || null;
  // entries of this code made for other courses (not this course, not its common first-year course)
  const others = (code, course) => (byCode.get(code) || []).filter((e) => e.course !== course && e.course !== commonCourse(course));
  return { meta: tt.meta, courses: tt.courses || {}, entries, slot, exact, name, others };
}

// code → subject name from the time table (part-time "_2" variants share their paper's name).
export function subjectNames(tt) {
  const out = new Map();
  for (const r of tt?.rows || []) { const code = r[5].replace(/_\d+$/, ''); if (!out.has(code) || r[5] === code) out.set(code, r[6]); }
  return out;
}

// Every hall-ticket subject whose exam date disagrees with the time table.
export const TT_DIFF = {
  missing: 'No date on hall ticket, in time table',
  differs: 'Date differs from time table',
  extra: 'Dated on hall ticket, not in time table',
};
export function ttDifferences(tickets, timetable) {
  const tt = makeTimetable(timetable);
  const rows = [];
  for (const t of tickets) {
    for (const s of t.subjects) {
      if (s.setDate) continue; // a date set by hand isn't a hall-ticket date to check
      const slot = tt.slot(s.code, t.courseNo, s.date, s.session);
      if (!s.date && slot) rows.push({ t, s, slot, kind: 'missing' });
      else if (s.date && slot && (s.date !== slot.date || s.session !== slot.session)) rows.push({ t, s, slot, kind: 'differs' });
      else if (s.date && !slot) rows.push({ t, s, slot: null, kind: 'extra' });
    }
  }
  return rows;
}

// mapSubject(code, course) → { code: current code, scheme } for an old / legacy subject (Equivalent Subjects Mapping).
// cross (kv "crossCourse"): { 'course|code': { act: 'add' | 'hold', from: course } } — what to do with a subject that has
// no date on the hall ticket while the time table lists its code only for other courses: add it on that course's date,
// or hold it (not counted). Undecided ones are returned in crossList.
export function buildQp(tickets, timetable, mapSubject = () => null, cross = {}) {
  const tt = makeTimetable(timetable);
  const papers = new Map();
  const extraRows = new Map(); // course|code|date|session → strength row for papers dated only on the hall ticket / by you
  const strength = new Map(); // time table entry → { regs, R, S, own: { regs, R, S }, old: Map(old code → n) }
  const dateMismatch = [];
  const crossList = new Map(); // course|code → { course, code, name, status, from, options, regs }
  let undated = 0;

  for (const t of tickets) {
    for (const s of t.subjects) {
      const m = mapSubject(s.code, t.courseNo);
      const code = m ? m.code : s.code;
      // a date set by you overrides the time table; otherwise the time table, then the hall ticket
      // A mapped old subject sits with its current subject, unless the time table schedules the old code for this very
      // course (another course's entry for the old code, e.g. part-time 3020's, must not move 1020's students).
      const entry = m ? tt.exact(s.code, t.courseNo) || tt.slot(m.code, t.courseNo, s.date, s.session) || tt.slot(s.code, t.courseNo, s.date, s.session)
        : tt.slot(s.code, t.courseNo, s.date, s.session);
      if (entry) {
        const c = strength.get(entry) || strength.set(entry, { regs: new Set(), R: 0, S: 0, own: { regs: new Set(), R: 0, S: 0 }, old: new Map() }).get(entry);
        if (!c.regs.has(t.regNo)) {
          c.regs.add(t.regNo);
          c[s.type] = (c[s.type] || 0) + 1;
          // own: the hall-ticket code is the time-table code; otherwise an old-scheme subject mapped onto it
          if (s.code === entry.code) { c.own.regs.add(t.regNo); c.own[s.type] = (c.own[s.type] || 0) + 1; }
          else c.old.set(s.code, (c.old.get(s.code) || 0) + 1);
        }
      }
      let slot = s.setDate ? null : entry;
      if (!slot && s.date) slot = { date: s.date, session: s.session, time: s.time, name: s.name, fromTicket: !s.setDate, setDate: !!s.setDate };
      // no date anywhere, but the time table has this code for other courses: added by you, held, or still to decide
      if (!slot && !entry) {
        const opts = tt.others(code, t.courseNo);
        if (opts.length) {
          const k = t.courseNo + '|' + code;
          const d = cross[k];
          const pick = d?.act === 'add' ? opts.find((e) => e.course === d.from) || opts[0] : null;
          if (pick) slot = { date: pick.date, session: pick.session, time: pick.time, name: pick.name, borrowed: pick.course };
          const c = crossList.get(k) || crossList.set(k, {
            key: k, course: t.courseNo, code, name: s.name, status: pick ? 'add' : d?.act === 'hold' ? 'hold' : 'new', from: pick?.course || '',
            options: [...new Map(opts.map((e) => [e.course, { course: e.course, date: e.date, session: e.session, time: e.time, name: e.name }])).values()], regs: new Set(),
          }).get(k);
          c.regs.add(t.regNo);
        }
      }
      // a dated paper the time table doesn't list for this course (e.g. a Tamil-medium code): its own strength row
      if (!entry && slot) {
        const code = m ? m.code : s.code;
        const k = `${t.courseNo}|${code}|${slot.date}|${slot.session}`;
        const e = extraRows.get(k) || extraRows.set(k, {
          course: t.courseNo, scheme: s.regulation || '', sem: s.sem, date: slot.date, time: slot.time || '', session: slot.session, code, name: slot.name || s.name,
          remarks: slot.borrowed ? `Not in the time table for this course: added on course ${slot.borrowed}'s date` : slot.fromTicket ? 'Not in the time table for this course: date from the hall ticket' : 'Not in the time table for this course: date set by you',
          ticket: !!slot.fromTicket, setDate: !!slot.setDate, borrowed: slot.borrowed || '', regs: new Set(), R: 0, S: 0, own: { regs: new Set(), R: 0, S: 0 }, old: new Map(),
        }).get(k);
        if (!e.regs.has(t.regNo)) {
          e.regs.add(t.regNo);
          e[s.type] = (e[s.type] || 0) + 1;
          if (s.code === code) { e.own.regs.add(t.regNo); e.own[s.type] = (e.own[s.type] || 0) + 1; }
          else e.old.set(s.code, (e.old.get(s.code) || 0) + 1);
        }
      }
      if (!slot) {
        undated++;
        continue;
      }
      if (s.date && !slot.fromTicket && (s.date !== slot.date || s.session !== slot.session)) dateMismatch.push({ t, s, slot });
      const key = `${slot.date}|${slot.session}|${code}`;
      const p = papers.get(key) || papers.set(key, {
        key, code, name: m ? '' : slot.name || s.name, date: slot.date, session: slot.session, time: slot.time,
        fromTicket: !!slot.fromTicket, setDate: !!slot.setDate, borrowed: slot.borrowed || '', courses: new Set(), sems: new Set(), regs: new Set(), R: 0, S: 0, total: 0, students: [],
        schemes: new Map(), legacyCodes: new Set(), merged: false, seen: new Set(), repeats: 0,
      }).get(key);
      if (!m && !p.name) p.name = slot.name || s.name;
      if (m) { p.merged = true; p.legacyCodes.add(s.code); p.legacyName ||= slot.name || s.name; }
      // Two old subjects (e.g. sem 3 and sem 4 arrears) can map to the same current paper: one paper, one seat per student.
      if (p.seen.has(t.regNo)) { p.repeats++; continue; }
      p.seen.add(t.regNo);
      const scheme = m ? m.scheme : s.regulation || 'Current';
      p.schemes.set(scheme, (p.schemes.get(scheme) || 0) + 1);
      p.courses.add(t.courseNo);
      p.sems.add(s.sem);
      p.regs.add(s.regulation);
      p[s.type] = (p[s.type] || 0) + 1;
      p.total++;
      p.students.push({ t, s });
    }
  }

  for (const p of papers.values()) if (!p.name) p.name = tt.name(p.code) || p.legacyName || '';
  const list = [...papers.values()].sort((a, b) => a.date.localeCompare(b.date) || (a.session === b.session ? 0 : a.session === 'FN' ? -1 : 1) || a.code.localeCompare(b.code, undefined, { numeric: true }));
  const days = [];
  for (const p of list) {
    let d = days[days.length - 1];
    if (!d || d.date !== p.date) days.push((d = { date: p.date, FN: [], AN: [] }));
    d[p.session].push(p);
  }
  // A student can sit only one paper per session. Someone listed under two (or more) papers in the same session is
  // almost always an old subject whose equivalent is not mapped: count one question paper for them, not two.
  for (const d of days)
    for (const s of ['FN', 'AN']) {
      const by = new Map(); // reg → { t, papers: [paper] }
      for (const p of d[s]) for (const { t } of p.students) (by.get(t.regNo) || by.set(t.regNo, { t, papers: [] }).get(t.regNo)).papers.push(p);
      const list = [...by.values()].filter((x) => x.papers.length > 1).sort((a, b) => a.t.regNo.localeCompare(b.t.regNo, undefined, { numeric: true }));
      d.rep ??= {};
      d.rep[s] = { n: list.reduce((n, x) => n + x.papers.length - 1, 0), list, merged: d[s].reduce((n, p) => n + p.repeats, 0) };
    }
  // every time-table subject with its candidates (0 when nobody on the hall tickets writes it)
  const ttRows = tt.entries.map((e) => {
    const c = strength.get(e);
    return { ...e, R: c?.R || 0, S: c?.S || 0, n: c?.regs.size || 0, own: { R: c?.own.R || 0, S: c?.own.S || 0, n: c?.own.regs.size || 0 }, old: [...(c?.old || [])] };
  }).concat([...extraRows.values()].map(({ regs, own, old, ...e }) => ({ ...e, n: regs.size, own: { R: own.R || 0, S: own.S || 0, n: own.regs.size }, old: [...old] })));
  return { papers: list, days, timetable: tt.meta, courses: tt.courses, ttRows, undated, dateMismatch,
    crossList: [...crossList.values()].map(({ regs, ...c }) => ({ ...c, n: regs.size })).sort((a, b) => a.course.localeCompare(b.course) || a.code.localeCompare(b.code, undefined, { numeric: true })) };
}

// QP statistics rows: one per course + question paper (a paper written by several courses is split), then rows
// you merged (kv "qpMerges": [[ 'course|code', … ], …]) are joined back into one row. mapSubject gives each
// student's scheme for the breakdown. Hall allocation uses the same merges.
export const rowKey = (course, code) => course + '|' + code;
export function mergeGroupOf(merges, key) {
  return (merges || []).find((g) => g.includes(key)) || null;
}
export function courseRows(days, merges, mapSubject = () => null) {
  const join = (rows, date, s) => {
    const out = new Map(); // group id → row
    for (const r of rows) {
      const g = mergeGroupOf(merges, r.keys[0]);
      const id = g ? g.join('+') : r.keys[0];
      const m = out.get(id);
      if (!m) { out.set(id, r); continue; }
      out.set(id, {
        ...m,
        keys: [...m.keys, ...r.keys],
        code: [...new Set([...m.code.split(', '), r.code])].join(', '),
        name: m.name === r.name || !r.name ? m.name : m.name ? `${m.name} / ${r.name}` : r.name,
        courses: new Set([...m.courses, ...r.courses]), sems: new Set([...m.sems, ...r.sems]), regs: new Set([...m.regs, ...r.regs]),
        R: m.R + r.R, S: m.S + r.S, total: m.total + r.total, students: [...m.students, ...r.students],
        schemes: new Map([...m.schemes].concat([...r.schemes].map(([k, n]) => [k, (m.schemes.get(k) || 0) + n]))),
        legacyCodes: new Set([...m.legacyCodes, ...r.legacyCodes]), merged: m.merged || r.merged, setDate: m.setDate || r.setDate, fromTicket: m.fromTicket || r.fromTicket, borrowed: m.borrowed || r.borrowed,
        joined: true,
      });
    }
    return [...out.values()].map((r) => ({ ...r, key: `${date}|${s}|${r.keys.join('+')}` }));
  };
  return days.map((d) => {
    const out = { ...d };
    for (const s of ['FN', 'AN']) {
      const rows = [];
      for (const p of d[s]) {
        const by = new Map();
        for (const st of p.students) (by.get(st.t.courseNo) || by.set(st.t.courseNo, []).get(st.t.courseNo)).push(st);
        for (const [course, students] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
          const r = { keys: [rowKey(course, p.code)], code: p.code, name: p.name, date: p.date, session: p.session, time: p.time, setDate: p.setDate, fromTicket: p.fromTicket, borrowed: p.borrowed,
            courses: new Set([course]), sems: new Set(), regs: new Set(), R: 0, S: 0, total: 0, students, schemes: new Map(), legacyCodes: new Set(), merged: false };
          for (const { t, s: x } of students) {
            const m = x.code !== p.code ? mapSubject(x.code, t.courseNo) : null;
            if (x.code !== p.code) { r.merged = true; r.legacyCodes.add(x.code); }
            const scheme = m ? m.scheme : x.regulation || 'Current';
            r.schemes.set(scheme, (r.schemes.get(scheme) || 0) + 1);
            r.sems.add(x.sem);
            r.regs.add(x.regulation);
            r[x.type] = (r[x.type] || 0) + 1;
            r.total++;
          }
          rows.push(r);
        }
      }
      out[s] = join(rows, d.date, s);
    }
    return out;
  });
}
