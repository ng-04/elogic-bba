# E-Logic BBA

Live: **https://ng-04.github.io/elogic-bba/**

A demo site for the BBA programme at **E-Logic School of Business**, a fictitious institution. It
opens on **Ask E-Logic**, a cited answer bot for students, parents, faculty and the Dean. The other
pages are:

- **Programme**: overview, pedagogy, credit framework, assessment and outcomes.
- **Curriculum Master**: semester tabs, type/assessment filters and the master table of Year 4 electives.
- **Faculty**: profile cards with each professor's teaching load, and the Faculty Utilization table.
- **Student Master**: KPIs, state and specialisation breakdowns, attendance flags and a
  searchable table.
- **Handbook & Master File**: the 11-page student handbook (PDF) and the master-data workbook (XLSX).
- **Course Planner**: pick a program, semester and subject (or all) to get each subject's Course
  Outline, AoL Plan, AoL Report and Excel marks sheet. The files are pre-generated in `docs/course-docs/`, three sample
  subjects so far. The Templates tab shows the blank templates; an uploaded template is saved in that
  browser only and fills the documents there from `docs/course-docs/fields/`. A marks sheet uploaded
  on the same tab replaces the dummy results in that subject's AoL Report, also in that browser only.
  The **Outline review** tab takes an outline from last year's version through reupload, an HTML view
  of what goes into the document, approval, a PDF and sharing with students. The **Marks & results** tab takes the marks upload and shows
  the distribution of marks for each CLO, with sliders for the band cut-offs, and prompts and
  suggestions for the report's Analysis of Result and Improvement Plan (`data/course_docs/coaching.json`).
  The site has no server or sign-in, so all of this stays in one browser and approval isn't proof of
  who approved.
- **Scheduling**: the **Faculty allocation** solver assigns a professor to each of the year's 117 sections
  (from Faculty Utilization) so that teaching hours stay within each professor's band. The objective
  (hours under and over the band, the largest single gap, sections moved, cross-area teaching, extra
  professors per subject) has switchable weights; the constraints (one professor per section, sections per
  term, area eligibility with "also teaches" exceptions, locks, bars, availability, an optional hard cap,
  annual or per-term bands) can all be changed on the page. Inputs come from the master data or from an
  uploaded input workbook (downloadable pre-filled); results download as a workbook in the Faculty
  Utilization layout with a load summary, course summary and solver report, and the model downloads in
  LP format for an exact solver. The solver is `lib/allocation.js`: a seeded search, so results repeat.
  Bands, availability and "also teaches" areas are dummy data in `data/generate.py` (`allocation` in
  `site-data.json`). The **Overview** tab outlines timetabling, rooms and the rest, still to come.

Every name, number and date here is made up.

## Run locally

```bash
python3 -m http.server 8000   # then open http://localhost:8000/
```

To ask questions, enter an Anthropic API key on the Ask page. The key stays in the browser.

## How Ask E-Logic works

It uses the Local Q&A engine in `lib/` (`engine.js`, `qa-chart.js`, copied from ng-04/news_sentiment).

1. **Reading.** On first use, the page fetches both files in `docs/`, reads them in the browser and
   splits them into chunks. Spreadsheet rows keep their column headers, so an answer can cite
   `sheet "Student Master", row 42`.
2. **Context.** The two documents together are about 270k characters (roughly 68k tokens). They are
   sent whole with every question, in a system block marked for prompt caching, so follow-up
   questions reuse the cache. Above 340k characters the bot switches to best-matching passages.
3. **Tools.** Claude can call three tools: `calculate`, which gives exact counts, totals and
   averages computed by the page; `propose_chart`, which draws a chart only after the user
   confirms; and `report_not_found`.

## Your data

The Ask page has two sources, chosen with **Answer from**:

- **E-Logic BBA documents**: the handbook and the master data.
- **Your data**: only files the visitor uploads (PDF, Word, Excel, or a ZIP of them). The E-Logic
  documents are never loaded or sent in this mode, and the prompt tells Claude the uploads are its
  only source.

Each source keeps its own conversation. Uploads are read in the browser and kept only in that tab:
reloading clears them, and nothing goes anywhere except the excerpts sent to Anthropic with a
question. Large uploads (over 340k characters of text) switch to search over best-matching
passages. The first time, this downloads a 34 MB embedding model.

## Regenerate the data

`data/generate.py` writes the handbook, the workbook and `site-data.json` from one source, so the
three stay consistent:

```bash
pip install xlsxwriter reportlab && python data/generate.py
```

| File | Contents |
|---|---|
| `docs/E-Logic_BBA_Student_Handbook_2026-27.pdf` | 11 pages: Dean's welcome, overview, pedagogy, credit framework, subjects (3 pages, including the Year 4 electives), assessment, outcomes, calendar and contacts |
| `docs/E-Logic_BBA_Master_Data_2026-27.xlsx` | **Curriculum Master** (79 subjects: area, credits, sessions, minutes, hours taught, faculty credit hours, number of sections, type, assessment); **Student Master** (160 students); **Faculty Master** (28 professors, with faculty credit hours, goal and utilization %); **Faculty Utilization** (117 rows, one per section taught); **Year 4 Electives** (the master table of 19 electives, including ESG, compliance and CSR); **Assumptions** (the teaching-time rule) |
| `site-data.json` | The same data, for the website's pages |

In Faculty Utilization, core subjects run in sections A and B of their batch. Electives run only if
students enrolled, in sections of up to 20. Each section consumes the subject's credits, sessions and
faculty credit hours, so a professor's load is the sum of their rows.

### Teaching-time rule

| Credits | Sessions | Minutes per session | Total minutes | Hours taught | Faculty credit hours |
|---|---|---|---|---|---|
| 1 | 10 | 75 | 750 | 12.5 | 15 |
| 4 | 40 | 75 | 3,000 | 50 | 60 |

The rule is the same for every subject. Each faculty member's goal is 150 faculty credit hours per
academic year, and Utilization % is faculty credit hours ÷ goal × 100.

### Formulas

Calculated columns in the workbook are Excel formulas: lookups between sheets, section and student
counts, teaching time, and utilization. They refer to named cells on the **Assumptions** sheet, so
changing a value there recalculates the workbook. Each formula is saved together with its result,
because the website and Ask E-Logic read the stored values and don't evaluate formulas.
