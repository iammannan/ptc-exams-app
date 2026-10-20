# PTC Exams App

A lightweight, browser-only tool to process DOTE **Nominal Roll** PDFs.

**Live app:** https://iammannan.github.io/ptc-exams-app/

## Features
- **Upload** – select many nominal roll PDFs at once. Each file is parsed for student name, reg no, DOB, course no/name, semesters, regulation per semester (R)/(S) exam type and sem-wise subject codes.
- **Verification** – every student's parsed subject codes are checked against the *Subject Count* and *Semesters* columns; per-table *Total Students* and the header *Student Count* are cross-checked too.
- **Candidates** – pick a course and subject code to list all candidates with a count. Filter by exam type, search by name/reg no.
- **Export** – download the list as PDF or CSV.
- **Hall Tickets** – upload DOTE hall ticket PDFs (one PDF per course, 2–3 pages per student). Each ticket is parsed for student details and every subject's sem, regulation, exam type, exam date and session. Tickets are verified (missing fields, unreadable dates, session clashes) and cross-checked against the saved nominal roll.
- **Exam Schedule** – dashboard with stats (exam days, papers, answer scripts, busiest session, clashes), a students-per-day chart split by FN/AN, and a day-wise subject list with R/S/total student counts. Click a subject to see its students. Filter by course, exam type, session or student. Subjects with no exam date (practicals etc.) are listed separately.
- **Schedule export** – day-wise list as CSV or PDF, plus a *Student lists PDF* with one page per exam (student list with a signature column). Each subject's list can also be exported on its own.
- **QP Statistics** – question papers needed per day and FN/AN session: one paper per candidate for every hall-ticket subject code with an exam date (date from the built-in time table, or the hall ticket when the time table doesn't list the code). Click a paper to see its candidates. Export as PDF (day-wise summary + paper-wise list with session and day totals) or CSV.
- **Seating** – set up exam halls (name, columns × rows; seats labelled A1…E6, capacity worked out). Pick an exam date and session (FN/AN) to get the waiting candidates, split into Regular and Supplementary and grouped by course (or subject code). Click or drag across seats like a spreadsheet (Shift-click extends, Ctrl-click adds, Delete clears), then pick a group to fill the seats with its register numbers in order (column-wise or row-wise). Export `Seating_Arrangement.pdf` (one page per hall: college name & code, board examination month/year, the seat grid with bold register numbers and a Chief Superintendent signature space) and a one-page *Entrance display PDF* listing each course's register number range and hall. *Import / Search subject* adds any hall-ticket subject from another date (or with no exam date) to the session's dock, or a manual subject from typed / pasted / .txt register numbers (ranges like 22100301-22100320 work); these show a Cross-Date, Unscheduled or Manual badge and can be removed with one click. Changes save automatically; *Save* confirms it. Halls and allocations are included in Backup/Restore.
- **Local storage** – data is saved in your browser (IndexedDB). Nothing is uploaded anywhere. Use *Backup/Restore* to move data between devices.

## Built-in time table
`js/data/timetable.js` (Board Examinations time table, Version 2 revised 15.10.2026) is generated — refresh it with:

```
npm i --no-save pdfjs-dist@4.10.38
node tools/build-data.mjs --timetable "TT/<time table>.pdf"
```

A revised time table can also be loaded in the app (QP Statistics → *Load revised time table*); it is kept in that browser only.

## Run locally
Any static server works, e.g. `npx http-server .` then open http://localhost:8080.

No build step. Libraries (pdf.js, jsPDF) load from jsDelivr on demand.
