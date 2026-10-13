# E-Logic BBA

Live: **https://ng-04.github.io/elogic-bba/**

A demo site for the BBA programme at **E-Logic School of Business**, a fictitious institution. It
opens on **Ask E-Logic**, a cited answer bot for students, parents, faculty and the Dean. The other
pages are:

- **Programme**: overview, pedagogy, credit framework, assessment and outcomes.
- **Curriculum Master**: semester tabs and type/assessment filters.
- **Faculty**: profile cards with each professor's teaching load, and the Faculty Utilization table.
- **Student Master**: KPIs, state and specialisation breakdowns, attendance flags and a
  searchable table.
- **Handbook**: the 10-page student handbook (PDF) and the master-data workbook (XLSX).

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
2. **Context.** The two documents together are about 190k characters (roughly 48k tokens). They are
   sent whole with every question, in a system block marked for prompt caching, so follow-up
   questions reuse the cache. Above 260k characters the bot switches to best-matching passages.
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
question. Large uploads (over 260k characters of text) switch to search over best-matching
passages. The first time, this downloads a 34 MB embedding model.

## Regenerate the data

`data/generate.py` writes the handbook, the workbook and `site-data.json` from one source, so the
three stay consistent:

```bash
pip install xlsxwriter reportlab && python data/generate.py
```

| File | Contents |
|---|---|
| `docs/E-Logic_BBA_Student_Handbook_2026-27.pdf` | 10 pages: Dean's welcome, overview, pedagogy, credit framework, subjects (2 pages), assessment, outcomes, calendar and contacts |
| `docs/E-Logic_BBA_Master_Data_2026-27.xlsx` | **Curriculum Master** (56 subjects: area, credits, sessions, minutes, hours taught, faculty credit hours, number of sections, type, assessment); **Student Master** (120 students); **Faculty Master** (20 professors, with faculty credit hours, goal and utilization %); **Faculty Utilization** (90 rows, one per section taught); **Assumptions** (the teaching-time rule) |
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
