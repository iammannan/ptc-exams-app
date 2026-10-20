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
  return { meta: tt.meta, slot };
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

export function buildQp(tickets, timetable) {
  const tt = makeTimetable(timetable);
  const papers = new Map();
  const dateMismatch = [];
  let undated = 0;

  for (const t of tickets) {
    for (const s of t.subjects) {
      let slot = tt.slot(s.code, t.courseNo, s.date, s.session);
      if (!slot && s.date) slot = { date: s.date, session: s.session, time: s.time, name: s.name, fromTicket: true, setDate: !!s.setDate };
      if (!slot) {
        undated++;
        continue;
      }
      if (s.date && !slot.fromTicket && (s.date !== slot.date || s.session !== slot.session)) dateMismatch.push({ t, s, slot });
      const key = `${slot.date}|${slot.session}|${s.code}`;
      const p = papers.get(key) || papers.set(key, {
        key, code: s.code, name: slot.name || s.name, date: slot.date, session: slot.session, time: slot.time,
        fromTicket: !!slot.fromTicket, setDate: !!slot.setDate, courses: new Set(), sems: new Set(), regs: new Set(), R: 0, S: 0, total: 0, students: [],
      }).get(key);
      p.courses.add(t.courseNo);
      p.sems.add(s.sem);
      p.regs.add(s.regulation);
      p[s.type] = (p[s.type] || 0) + 1;
      p.total++;
      p.students.push({ t, s });
    }
  }

  const list = [...papers.values()].sort((a, b) => a.date.localeCompare(b.date) || (a.session === b.session ? 0 : a.session === 'FN' ? -1 : 1) || a.code.localeCompare(b.code, undefined, { numeric: true }));
  const days = [];
  for (const p of list) {
    let d = days[days.length - 1];
    if (!d || d.date !== p.date) days.push((d = { date: p.date, FN: [], AN: [] }));
    d[p.session].push(p);
  }
  return { papers: list, days, timetable: tt.meta, undated, dateMismatch };
}
