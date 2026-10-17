// Question-paper statistics: every hall-ticket subject that needs a written (theory) paper is
// grouped under the question paper it is answered on — its own R2023 code, or for old-scheme
// subjects the R2023 alternate from DOTE's list (Theory only). Dates come from the time table.
import { makeMapper } from './mapping.js';
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

export function buildQp(tickets, alternates, timetable) {
  const map = makeMapper(alternates);
  const tt = makeTimetable(timetable);
  const papers = new Map(); // qp code → paper
  const noPaper = new Map(); // old subjects whose alternate is practical / practicum
  const notMapped = new Map(); // old subjects with no alternate in DOTE's list
  const notTimetabled = new Map(); // theory papers missing from the time table
  const dateMismatch = [];
  const mappings = new Map(); // "course|regl|code" → mapping result, for display

  const bump = (m, key, init, t, s) => {
    const g = m.get(key) || m.set(key, { ...init, courses: new Set(), R: 0, S: 0, students: [] }).get(key);
    g.courses.add(t.courseNo);
    g[s.type] = (g[s.type] || 0) + 1;
    g.students.push({ t, s });
    return g;
  };

  for (const t of tickets) {
    for (const s of t.subjects) {
      let qpCode = s.code, alt = null, how = '';
      if (s.regulation !== 'R2023') {
        const key = `${t.courseNo}|${s.regulation}|${s.code}`;
        const res = mappings.get(key) || mappings.set(key, map(s, t.courseNo)).get(key);
        if (!res.alt) {
          bump(notMapped, key, { code: s.code, name: s.name, regulation: s.regulation, sem: s.sem, why: res.how }, t, s);
          continue;
        }
        if (res.alt.exam !== 'Theory') {
          bump(noPaper, key, { code: s.code, name: s.name, regulation: s.regulation, sem: s.sem, alt: res.alt }, t, s);
          continue;
        }
        alt = res.alt;
        how = res.how + (res.check ? ' — check' : '');
        qpCode = alt.code;
      }
      const slot = tt.slot(qpCode, t.courseNo, s.date, s.session);
      if (!slot) {
        // R2023 subjects outside the time table are practicals / internal — no question paper
        if (alt) bump(notTimetabled, `${t.courseNo}|${s.regulation}|${s.code}`, { code: s.code, name: s.name, regulation: s.regulation, sem: s.sem, alt }, t, s);
        continue;
      }
      if (s.date && (s.date !== slot.date || s.session !== slot.session))
        dateMismatch.push({ t, s, slot });
      const p = papers.get(`${slot.date}|${slot.session}|${qpCode}`) || papers.set(`${slot.date}|${slot.session}|${qpCode}`, {
        key: `${slot.date}|${slot.session}|${qpCode}`, code: qpCode, name: slot.name, date: slot.date, session: slot.session, time: slot.time,
        scheme: slot.scheme, members: new Map(), total: 0, R: 0, S: 0, old: 0,
      }).get(`${slot.date}|${slot.session}|${qpCode}`);
      const mk = `${s.regulation}|${s.code}`;
      const m = p.members.get(mk) || p.members.set(mk, { code: s.code, name: s.name, regulation: s.regulation, alt, how, courses: new Set(), sems: new Set(), R: 0, S: 0, students: [] }).get(mk);
      m.courses.add(t.courseNo);
      m.sems.add(s.sem);
      m[s.type] = (m[s.type] || 0) + 1;
      m.students.push({ t, s });
      p.total++;
      p[s.type] = (p[s.type] || 0) + 1;
      if (alt) p.old++;
    }
  }

  const list = [...papers.values()].sort((a, b) => a.date.localeCompare(b.date) || (a.session === b.session ? 0 : a.session === 'FN' ? -1 : 1) || a.code.localeCompare(b.code, undefined, { numeric: true }));
  for (const p of list) p.members = [...p.members.values()].sort((a, b) => (a.regulation === 'R2023' ? -1 : b.regulation === 'R2023' ? 1 : 0) || a.code.localeCompare(b.code, undefined, { numeric: true }));
  const days = [];
  for (const p of list) {
    let d = days[days.length - 1];
    if (!d || d.date !== p.date) days.push((d = { date: p.date, FN: [], AN: [] }));
    d[p.session].push(p);
  }
  const sorted = (m) => [...m.values()].sort((a, b) => b.students.length - a.students.length || a.code.localeCompare(b.code, undefined, { numeric: true }));
  return {
    papers: list, days, timetable: tt.meta,
    noPaper: sorted(noPaper), notMapped: sorted(notMapped), notTimetabled: sorted(notTimetabled), dateMismatch,
  };
}
