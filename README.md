# PTC Exams App

A lightweight, browser-only tool for polytechnic board exams: reads DOTE **Nominal Roll** and **Hall Ticket** PDFs, works out question-paper needs and builds the seating arrangement.

**Live app:** https://iammannan.github.io/ptc-exams-app/

## Screens
1. **Home** – a flow chart of how the app is used, with the progress of each step. Click a step to open it.
2. **Nominal Roll Upload** – select many nominal roll PDFs at once. Each student's name, reg no, DOB, course, semesters, regulation, exam type (R/S) and sem-wise subject codes are read and verified against the *Subject Count*, *Semesters*, *Total Students* and header *Student Count*. After an upload the screen confirms success with the parsed student count and the total student count from the roll.
3. **Hall Ticket Upload** – upload DOTE hall ticket PDFs (one per course). Every subject's sem, regulation, exam type, exam date and session is read, tickets are verified (missing fields, unreadable dates, session clashes), and each ticket is cross-checked against the nominal roll. **Differences / Mismatches** lists candidates missing on either side, name or course differences and subject code mismatches (export as CSV or PDF).
4. **Candidates** – students from the nominal roll ("Student details displayed here are sourced from the Nominal Roll"). Filter by course, subject code (or both), exam type, name / reg no; export CSV or PDF. **Add, Edit, Delete** students: your changes are kept on top of the uploaded rolls, so re-uploading a roll doesn't lose them.
5. **Equivalent Subjects Mapping** – the built-in **DOTE equivalent subjects table** (1,025 K / L / M / N scheme subjects across 9 courses, each mapped to its newer subject; chains such as L → M → R2023 are followed) is applied automatically and can be switched off. Add your own mappings — one **Current Subject** (course → scheme → semester → subject) to any number of **Old / Legacy Subjects** — to add or override equivalents; yours always win. Search a subject code or name to see the merged subject with every legacy code and candidate counts. Part-time (3xxx) and Tamil-medium (7xxx) courses use the full-time course's equivalents.
6. **QP Statistics** – "QP Statistics are generated based on uploaded Hall Ticket data." Question papers needed per day and session (date from the built-in time table, else the hall ticket). Mapped subjects show as one row under the current subject with a per-scheme breakdown (e.g. R2023: 32 · M-Scheme: 12 · Total: 44). **+ Add missing dates** for subjects with no date, and **✎** on any paper to edit / override its date: FN, AN or a lab slot (9 – 12, 12 – 3, 3 – 6), with several sittings for labs run in batches (students split in register-number order, batch size optional). Legacy subjects follow the date of their current subject. The *Exam schedule & student lists* view has the day-wise dashboard, chart, schedule export and per-exam student lists PDF. Export QP statistics as PDF or CSV.
7. **Seating** – set up halls (columns × rows, seats A1…E6). Pick an exam date and session to get the waiting candidates, split Regular / Supplementary and grouped by course or by subject code — groups never mix course codes. Select seats like a spreadsheet and pick a group: register numbers are always laid in ascending order. Subjects can be imported from another date, typed / pasted in, or brought over from a postponed session (custom dates allowed). Exports at the bottom, in order: **1. Hall Chart** PDF (one page per hall), **2. Entrance Sheet** PDF (all register numbers per course and hall, one page) and **3. Hall Allocation** Excel (per-hall counts with paper-collection order) and **4. Attendance** — one PDF per course + subject code (old-scheme equivalents merged onto their current subject's sheet, each marked with its old code) in the DOTE attendance-sheet layout (10 candidates a page in register-number order, serial numbers running across pages, spaces for answer book serial number, photo and signature, present / absent counts, Hall Supdt / ACS / CS signatures); download each sheet or all of them as one ZIP.
8. **Settings** – light / dark / system theme, storage used by each kind of data, **Export / Import** of all data as one JSON file, and **Reset all data** (confirmed by typing a code shown as an image; offers a backup first). All app data is stored locally in this browser.

Every page also reminds you to verify equivalent subjects.

## Data & storage
Everything stays in the browser on this device; nothing is uploaded. Parsed PDFs and all app data (halls, seat allocations, set dates, mappings, candidate edits, a revised time table) are kept in **IndexedDB**, which has room for thousands of students without the 5 MB localStorage limit. Only small display preferences (last tab, theme) use localStorage.

**Upgrading from the old version:** on first start the app moves the old version's halls, seating, added subjects, custom dates and set exam dates from localStorage into IndexedDB, converts set dates to the sittings format and removes the old copies. Backups exported from the old version can be imported in Settings; they are converted the same way.

## View counter
The top bar shows **Today** and **Total Views**. Every page load counts; local copies on `localhost` show the numbers but don't count. Counts are kept by [Abacus](https://abacus.jasoncameron.dev/), a free counting API that needs no account or key: `js/views.js` hits two counters in the `iammannan-ptc-exams-app` namespace, `total` and `day-<YYYY-MM-DD>` (India time, so Today resets at midnight IST).

Notes: Abacus allows 30 requests per 10 seconds per visitor IP, and a counter not used for 6 months expires (old day counters drop off; `total` stays while the site is visited).

## Built-in time table
`js/data/timetable.js` (Board Examinations time table, Version 2 revised 15.10.2026) is generated — refresh it with:

```
npm i --no-save pdfjs-dist@4.10.38
node tools/build-data.mjs --timetable "TT/<time table>.pdf"
```

A revised time table can also be loaded in the app (QP Statistics → *Load revised time table*); it is kept in that browser only.

## Built-in equivalent subjects
`js/data/equivalents.js` is generated from DOTE's equivalent-subject table (tab-separated: course, subject code, name, sem, …, scheme, equivalent code). Refresh it with:

```
node tools/build-equiv.mjs "path/to/equivalents.csv"
```

Only old-scheme rows (K, L, M, N) with a different equivalent code are kept; R2023 rows and subjects mapped to themselves are skipped.

## Run locally
Any static server works, e.g. `npx http-server .` then open http://localhost:8080.

No build step. Libraries (pdf.js, jsPDF, ExcelJS, JSZip) load from jsDelivr on demand.

**Before each release** run `node tools/stamp.mjs`. It tags `styles.css` and every JS module in `index.html` with a version (a hash of their contents, via an import map), so browsers load the new files right after an update instead of cached old ones.
