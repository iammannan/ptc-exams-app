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
- **Local storage** – data is saved in your browser (IndexedDB). Nothing is uploaded anywhere. Use *Backup/Restore* to move data between devices.

## Run locally
Any static server works, e.g. `npx http-server .` then open http://localhost:8080.

No build step. Libraries (pdf.js, jsPDF) load from jsDelivr on demand.
