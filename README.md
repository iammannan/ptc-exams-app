# PTC Exams App

A lightweight, browser-only tool to process DOTE **Nominal Roll** PDFs.

**Live app:** https://iammannan.github.io/ptc-exams-app/

## Features
- **Upload** – select many nominal roll PDFs at once. Each file is parsed for student name, reg no, DOB, course no/name, semesters, regulation per semester (R)/(S) exam type and sem-wise subject codes.
- **Verification** – every student's parsed subject codes are checked against the *Subject Count* and *Semesters* columns; per-table *Total Students* and the header *Student Count* are cross-checked too.
- **Candidates** – pick a course and subject code to list all candidates with a count. Filter by exam type, search by name/reg no.
- **Export** – download the list as PDF or CSV.
- **Local storage** – data is saved in your browser (IndexedDB). Nothing is uploaded anywhere. Use *Backup/Restore* to move data between devices.

## Run locally
Any static server works, e.g. `npx http-server .` then open http://localhost:8080.

No build step. Libraries (pdf.js, jsPDF) load from jsDelivr on demand.
