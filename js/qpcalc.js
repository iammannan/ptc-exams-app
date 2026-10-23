// Question-paper statistics: every hall-ticket subject with an exam date is one question paper,
// counted per subject code. Dates come from the time table (or the hall ticket when the
// time table does not list the code); subjects with no exam date (practicals etc.) need no paper.
import { ttSession } from './ttparser.js';

// timetable: { meta, courses, rows: [[course, scheme, sem, date, time, code, name, remarks]] }
export function makeTimetable(tt) {
  const byCode = new Map(); // code → every time table entry for it
  for (const [course, scheme, sem, date, time, code, name, remarks] of tt.rows) {
    const base = code.replace(/_\d+$/, ''); // "PH231330_2": same paper on another date (part-time)
    const e = { course, scheme, sem, date, time, session: ttSession(time), code: base, name, remarks, variant: code !== base };
    (byCode.get(base) || byCode.set(base, []).get(base)).push(e);
  }
  // Pick the slot for a student: their own course, else the date on their hall ticket,
  // else the same course family (3xxx part-time, 7xxx Tamil medium), else the common entry.
  const slot = (code, course, date, session) => {
    const list = byCode.get(code);
    if (!list) return null;
    return list.find((e) => e.course === course)
      || (date && list.find((e) => e.date === date && e.session === session))
      || list.find((e) => e.course[0] === course[0] && e.variant)
      || list.find((e) => !e.variant)
      || list[0];
  };
  // The current subject's own name (time table), so a paper written only under old codes isn't named after one of them.
  const name = (code) => byCode.get(code)?.find((e) => !e.variant)?.name || byCode.get(code)?.[0]?.name || '';
  // Only an entry made for this very course (no fall-back to other courses' entries).
  const exact = (code, course) => byCode.get(code)?.find((e) => e.course === course) || null;
  return { meta: tt.meta, slot, exact, name };
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
export function buildQp(tickets, timetable, mapSubject = () => null) {
  const tt = makeTimetable(timetable);
  const papers = new Map();
  const dateMismatch = [];
  let undated = 0;

  for (const t of tickets) {
    for (const s of t.subjects) {
      const m = mapSubject(s.code, t.courseNo);
      const code = m ? m.code : s.code;
      // a date set by you overrides the time table; otherwise the time table, then the hall ticket
      // A mapped old subject sits with its current subject, unless the time table schedules the old code for this very
      // course (another course's entry for the old code, e.g. part-time 3020's, must not move 1020's students).
      let slot = s.setDate ? null
        : m ? tt.exact(s.code, t.courseNo) || tt.slot(m.code, t.courseNo, s.date, s.session) || tt.slot(s.code, t.courseNo, s.date, s.session)
        : tt.slot(s.code, t.courseNo, s.date, s.session);
      if (!slot && s.date) slot = { date: s.date, session: s.session, time: s.time, name: s.name, fromTicket: !s.setDate, setDate: !!s.setDate };
      if (!slot) {
        undated++;
        continue;
      }
      if (s.date && !slot.fromTicket && (s.date !== slot.date || s.session !== slot.session)) dateMismatch.push({ t, s, slot });
      const key = `${slot.date}|${slot.session}|${code}`;
      const p = papers.get(key) || papers.set(key, {
        key, code, name: m ? '' : slot.name || s.name, date: slot.date, session: slot.session, time: slot.time,
        fromTicket: !!slot.fromTicket, setDate: !!slot.setDate, courses: new Set(), sems: new Set(), regs: new Set(), R: 0, S: 0, total: 0, students: [],
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
  return { papers: list, days, timetable: tt.meta, undated, dateMismatch };
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
        legacyCodes: new Set([...m.legacyCodes, ...r.legacyCodes]), merged: m.merged || r.merged, setDate: m.setDate || r.setDate, fromTicket: m.fromTicket || r.fromTicket,
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
          const r = { keys: [rowKey(course, p.code)], code: p.code, name: p.name, date: p.date, session: p.session, time: p.time, setDate: p.setDate, fromTicket: p.fromTicket,
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
