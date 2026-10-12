# E-Logic BBA

Live: **https://ng-04.github.io/elogic-bba/**

A demo site for the BBA programme at **E-Logic School of Business**, a fictitious institution. It
opens on **Ask E-Logic**, a cited answer bot for students, parents, faculty and the Dean. The other
pages are:

- **Programme**: overview, pedagogy, credit framework, assessment and outcomes.
- **Curriculum Master**: semester tabs and type/assessment filters.
- **Faculty Master**: profile cards and teaching assignments.
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

## Regenerate the data

`data/generate.py` writes the handbook, the workbook and `site-data.json` from one source, so the
three stay consistent:

```bash
pip install openpyxl reportlab && python data/generate.py
```

| File | Contents |
|---|---|
| `docs/E-Logic_BBA_Student_Handbook_2026-27.pdf` | 10 pages: Dean's welcome, overview, pedagogy, credit framework, subjects (2 pages), assessment, outcomes, calendar and contacts |
| `docs/E-Logic_BBA_Master_Data_2026-27.xlsx` | **Curriculum Master** (56 subjects: academic year, semester, subject, credits, sessions per credit, type, assessment); **Student Master** (120 students: parent, home state, date of admission, CGPA, attendance, fees, mentor…); **Faculty Master** (56 assignments: prof name, semester, subject, sessions) |
| `site-data.json` | The same data, for the website's pages |
