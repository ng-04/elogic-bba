"""Builds each subject's marks workbook: a blank one to fill in and a sample with dummy marks.

Students come from site-data.json. Every column is tagged with the CLO it assesses, following the
AoL Plan, and the same dummy marks give the results in the pre-generated AoL Report, so uploading
a sample on the Course Planner page reproduces that report. Totals and the AoL Summary are all
Excel formulas.

Run:  python data/course_docs/build_marks.py
Writes blanks to docs/course-docs/marks/ and samples to data/outgoing/. Save the samples once in
Excel before publish.py, so their figures show before Enable Editing. Needs openpyxl.
"""
import json
import random
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter as col
from openpyxl.worksheet.datavalidation import DataValidation

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
TARGET = ROOT / "docs" / "course-docs" / "marks"
SAMPLES = ROOT / "data" / "outgoing"
MARKS, SUMMARY, HELP = "Marks Sheet", "AoL Summary", "Instructions"
# Label, marks, CLO, Bloom's level, how hard it is for this dummy class (0-1 shift). No CLO means it isn't counted.
ITEMS = {
    "BBA302": [("Mid-Term Q1", 10, "CO1", 3, 0.04), ("Mid-Term Q2", 5, "CO1", 2, 0.10), ("Mid-Term Q3", 15, None, 5, -0.08),
               ("End-Term Capital Budgeting", 30, "CO2", 4, 0.0), ("End-Term Case Question", 30, "CO3", 5, -0.06),
               ("Case Analysis Report", 20, "CO4", 3, 0.03)],
    "BBA305": [("Excel and Python Labs", 25, "CO1", 3, 0.05), ("Regression and Forecasting Labs", 25, "CO2", 4, -0.02),
               ("Showcase Evaluation", 15, "CO3", 5, -0.05), ("Showcase Presentation", 15, "CO4", 3, 0.04)],
    "BBA404": [("Venture Proposal", 10, "CO1", 3, 0.06), ("Milestone Reviews", 25, "CO2", 4, 0.0),
               ("Final Written Plan", 25, "CO3", 5, -0.04), ("Pitch and Viva", 25, "CO4", 3, 0.03)],
}
NOTES = {"BBA302": "Mid-Term Q3 has no Course Outcome because the AoL Plan assesses CLO3 at the end-term, not the mid-term."}
QUESTION_COLUMNS = 12
ABSENT = 2  # students who miss the mid-term in the dummy marks
EXCEED_AT, MEET_AT, TARGET_SHARE = 0.75, 0.5, 0.7
COACHING = json.loads((HERE / "coaching.json").read_text())
HIGHER_ORDER = 4  # Bloom's level from which an item asks students to analyse, evaluate or create
SAMPLE_YEAR = "2025-26"  # the earlier offering the sample results stand in for
RESULTS_NOTE = (f"Sample results from the {SAMPLE_YEAR} offering of this course, highlighted in yellow: illustrative marks, not real students'. "
                "Upload this term's marks sheet on the Marks & results tab of the Course Planner to replace them.")
RESULTS_RULE = ("Exceed Expectation is 75% or more of the marks for that CLO, Meet Expectation is 50% up to 75%, "
                "and Does not meet Expectation is below 50%.")
FIRST = 9  # first student row
Q_FIRST = 5  # column E holds the first question
TOTAL = Q_FIRST + QUESTION_COLUMNS
CO_COLUMN = TOTAL + 1

FONT = "Times New Roman"
thin = Side(style="thin", color="999999")
BOX = Border(left=thin, right=thin, top=thin, bottom=thin)
HEAD = PatternFill("solid", fgColor="E8EAF0")
INPUT = PatternFill("solid", fgColor="FFFF00")
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
LEFT = Alignment(horizontal="left", vertical="center", wrap_text=True)
BLUE = "0000FF"


def put(ws, ref, value, bold=False, fill=None, align=CENTER, color=None, fmt=None, size=11):
    cell = ws[ref]
    cell.value = value
    cell.font = Font(name=FONT, size=size, bold=bold, color=color)
    cell.alignment = align
    cell.border = BOX
    if fill:
        cell.fill = fill
    if fmt:
        cell.number_format = fmt
    return cell


def merge(ws, ref, value, **style):
    ws.merge_cells(ref)
    start, end = ref.split(":")
    for row in ws[ref]:
        for cell in row:
            cell.border = BOX
    return put(ws, start, value, **style)


def subject_data(code):
    data = json.loads((ROOT / "site-data.json").read_text())
    subject = next(r for r in data["curriculum"] if r["Subject Code"] == code)
    teaching = next(r for r in data["facultyUtilization"] if r["Subject Code"] == code)
    students = sorted((s for s in data["students"] if s["Batch"] == teaching["Batch"]), key=lambda s: (s["Section"], s["Student ID"]))
    return subject, teaching, students


def dummy_marks(code, students):
    """Half-mark scores that follow each student's CGPA, with a few students absent from the mid-term."""
    seed = int(code[3:])
    exam, other = random.Random(seed), random.Random(seed + 1)
    absent = sorted(students, key=lambda s: s["Attendance % (current sem)"])[:ABSENT]
    rows = {}
    for s in students:
        ability = 0.06 + 0.075 * s["CGPA"]
        scores = []
        for label, marks, _, _, shift in ITEMS[code]:
            mid_term = label.startswith("Mid-Term")
            if mid_term and s in absent:
                scores.append("AB")
                continue
            share = min(1, max(0.1, (exam if mid_term else other).gauss(ability + shift, 0.14)))
            scores.append(round(share * marks * 2) / 2)
        rows[s["Student ID"]] = scores
    return rows


def fill(text, **values):
    return text.format(**values)


def draft_review(bands, average, items):
    """Drafts a CLO's Analysis of Result and Improvement Plan, the same way the Course Planner page does."""
    assessed = sum(bands.values())
    met = (bands["exceed"] + bands["meet"]) / assessed * 100
    target = TARGET_SHARE * 100
    status = "below" if met < target else "near" if met < target + COACHING["near_margin"] else "above"
    weakest = min(items, key=lambda item: item["average"])
    values = {"met": f"{met:.1f}", "below": f"{bands['below'] / assessed * 100:.1f}", "target": f"{target:g}", "average": f"{average:.1f}",
              "item": weakest["label"], "item_average": f"{weakest['average']:.1f}"}
    wording = COACHING["analysis"]
    analysis = fill(wording["lead"] + wording["several" if len(items) > 1 else "single"], **values)
    level = "higher" if weakest["bloom"] >= HIGHER_ORDER else "lower"
    return {"analysis": analysis, "improvement": fill(COACHING["suggestions"][status][level][0], **values)}


def class_results(code):
    """Students in each band for each CLO, worked out as the Course Planner page does for an upload."""
    _, _, students = subject_data(code)
    marks = dummy_marks(code, students)
    outcomes = sorted({item[2] for item in ITEMS[code] if item[2]})
    results = []
    for outcome in outcomes:
        columns = [(n, item[1]) for n, item in enumerate(ITEMS[code]) if item[2] == outcome]
        most = sum(top for _, top in columns)
        bands = {"exceed": 0, "meet": 0, "below": 0}
        shares = []
        for scores in marks.values():
            got = [scores[n] for n, _ in columns if scores[n] != "AB"]
            if got:
                score = sum(got)
                shares.append(score / most * 100)
                bands["exceed" if score >= EXCEED_AT * most else "meet" if score >= MEET_AT * most else "below"] += 1
        assessed = sum(bands.values())
        items = []
        for n, top in columns:
            got = [scores[n] / top * 100 for scores in marks.values() if scores[n] != "AB"]
            items.append({"label": ITEMS[code][n][0], "bloom": ITEMS[code][n][3], "average": sum(got) / len(got)})
        results.append({**{key: value for band, count in bands.items()
                           for key, value in ((f"{band}_n", str(count)), (f"{band}_pct", f"{count / assessed * 100:.1f}%"))},
                        **draft_review(bands, sum(shares) / len(shares), items)})
    return results


def build_marks(wb, code, sample):
    subject, teaching, students = subject_data(code)
    items = ITEMS[code]
    ws = wb.active
    ws.title = MARKS
    last = FIRST + len(students) - 1
    q_first, q_last = col(Q_FIRST), col(TOTAL - 1)
    total = col(TOTAL)

    for ref, text in (("A1", "Exam Event"), ("B1", "Program"), ("C1", "Subject"), ("D1", "Exam Date")):
        put(ws, ref, text, bold=True)
    merge(ws, f"{q_first}1:{q_last}1", "Evaluation", bold=True)
    for ref, text in (("A2", f"E-LOGIC BLR UG AOL MARKS {subject['Academic Year']}"), ("B2", "BBA"),
                      ("C2", f"[{code}] {subject['Subject']}"), ("D2", teaching["Term"])):
        put(ws, ref, text)
    merge(ws, f"{q_first}2:{q_last}2", 1)

    for letter, text in (("A", "S.No"), ("B", "Section"), ("C", "Student Name")):
        merge(ws, f"{letter}3:{letter}8", text, bold=True, fill=HEAD)
    put(ws, "D3", "Rollnum", bold=True, fill=HEAD)
    merge(ws, f"{q_first}3:{q_last}3", f"{subject['Subject']} [AoL assessments]", bold=True, fill=HEAD)
    merge(ws, f"{total}3:{total}8", f'="Total ("&SUM({q_first}6:{q_last}6)&")"', bold=True, fill=HEAD)
    merge(ws, f"{col(CO_COLUMN)}3:{col(CO_COLUMN + 9)}3", "Marks Obtained in", bold=True, fill=HEAD)
    for n in range(10):
        letter = col(CO_COLUMN + n)
        merge(ws, f"{letter}4:{letter}8", f"CO{n + 1}", bold=True, fill=HEAD)

    for row, label in ((4, "Question"), (5, "Question No"), (6, "Question Marks"), (7, "Course Outcome"), (8, "Bloom's Level")):
        put(ws, f"D{row}", label, bold=True, fill=HEAD)
    for n in range(QUESTION_COLUMNS):
        letter = col(Q_FIRST + n)
        label, marks, outcome, bloom, _ = items[n] if n < len(items) else (None, None, None, None, None)
        put(ws, f"{letter}4", label, bold=True, fill=HEAD)
        for row, value in ((5, n + 1 if label else None), (6, marks), (7, outcome), (8, bloom)):
            put(ws, f"{letter}{row}", value, color=BLUE)

    marks = dummy_marks(code, students) if sample else {}
    span = f"${q_first}$7:${q_last}$7"
    for n, s in enumerate(students):
        r = FIRST + n
        scores = f"${q_first}{r}:${q_last}{r}"
        put(ws, f"A{r}", n + 1)
        put(ws, f"B{r}", s["Section"])
        put(ws, f"C{r}", s["Student Name"], align=LEFT)
        put(ws, f"D{r}", s["Student ID"])
        row_marks = marks.get(s["Student ID"], [])
        for i in range(QUESTION_COLUMNS):
            put(ws, f"{col(Q_FIRST + i)}{r}", row_marks[i] if i < len(row_marks) else None, color=BLUE, fmt="0.0")
        put(ws, f"{total}{r}", f'=IF(COUNTA({scores})=0,"",IF(COUNT({scores})=0,"AB",SUM({scores})))', bold=True, fmt="0.0")
        for c in range(10):
            letter = col(CO_COLUMN + c)
            put(ws, f"{letter}{r}",
                f'=IF(OR(COUNTIF({span},{letter}$4)=0,COUNTA({scores})=0),"",'
                f'IF(COUNTIFS({span},{letter}$4,{scores},">=0")=0,"AB",SUMIF({span},{letter}$4,{scores})))', fmt="0.0")

    check = DataValidation(type="custom", showErrorMessage=True, errorTitle="Check the mark",
                           error="Enter a mark from 0 up to the question's marks, or AB if absent.",
                           formula1=f'OR({q_first}{FIRST}="AB",AND(ISNUMBER({q_first}{FIRST}),{q_first}{FIRST}>=0,{q_first}{FIRST}<={q_first}$6))')
    check.add(f"{q_first}{FIRST}:{q_last}{last}")
    ws.add_data_validation(check)

    for letter, width in {"A": 34, "B": 10, "C": 30, "D": 32, total: 10}.items():
        ws.column_dimensions[letter].width = width
    for n in range(QUESTION_COLUMNS):
        ws.column_dimensions[col(Q_FIRST + n)].width = 13
    for n in range(10):
        ws.column_dimensions[col(CO_COLUMN + n)].width = 6.5
    ws.row_dimensions[3].height = 30
    ws.row_dimensions[4].height = 42
    ws.freeze_panes = f"E{FIRST}"
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToWidth, ws.page_setup.fitToHeight = 1, 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_title_rows = "1:8"


def build_summary(wb, code, sample):
    subject, _, students = subject_data(code)
    clos = json.loads((HERE / "content" / f"{code}.json").read_text())["clos"]
    ws = wb.create_sheet(SUMMARY)
    m = f"'{MARKS}'!"
    last = FIRST + len(students) - 1
    q_first, q_last, total = col(Q_FIRST), col(TOTAL - 1), col(TOTAL)
    total_range = f"{m}${total}${FIRST}:${total}${last}"

    ws.merge_cells("A1:K1")
    title = f"{code} {subject['Subject']}: AoL Summary" + (" (dummy data)" if sample else "")
    put(ws, "A1", title, bold=True, size=14, align=LEFT).border = Border()

    put(ws, "A3", "Cut-offs (edit the yellow cells)", bold=True, fill=HEAD, align=LEFT)
    put(ws, "B3", "Value", bold=True, fill=HEAD)
    for r, label, value in ((4, "Exceed Expectation: at least", EXCEED_AT), (5, "Meet Expectation: at least", MEET_AT),
                            (6, "Target: students meeting or exceeding", TARGET_SHARE)):
        put(ws, f"A{r}", label, align=LEFT)
        put(ws, f"B{r}", value, fill=INPUT, color=BLUE, fmt="0%")

    put(ws, "D3", "Class summary", bold=True, fill=HEAD, align=LEFT)
    ws.merge_cells("D3:E3")
    put(ws, "F3", "Value", bold=True, fill=HEAD)
    class_rows = ((4, "Students enrolled", f"=COUNTA({m}$D${FIRST}:$D${last})", "0"),
                  (5, "With marks", f"=COUNT({total_range})", "0"),
                  (6, "Absent throughout", f'=COUNTIF({total_range},"AB")', "0"),
                  (7, "Average total", f"=IFERROR(AVERAGE({total_range}),0)", "0.0"),
                  (8, "Highest total", f"=MAX({total_range})", "0.0"),
                  (9, "Lowest total", f"=MIN({total_range})", "0.0"))
    for r, label, formula, fmt in class_rows:
        ws.merge_cells(f"D{r}:E{r}")
        put(ws, f"D{r}", label, align=LEFT)
        ws[f"E{r}"].border = BOX
        put(ws, f"F{r}", formula, fmt=fmt)

    header = ("CO", "Course Learning Outcome", "PLG", "Max Marks", "Assessed", "Exceed", "Meet",
              "Does not meet", "% Meet or Exceed", "Target", "Result")
    start = 12
    for n, text in enumerate(header):
        put(ws, f"{col(1 + n)}{start}", text, bold=True, fill=HEAD)
    for i, clo in enumerate(clos):
        r = start + 1 + i
        letter = col(CO_COLUMN + i)
        scores = f"{m}${letter}${FIRST}:${letter}${last}"
        put(ws, f"A{r}", f"CO{i + 1}", bold=True)
        put(ws, f"B{r}", clo["text"], align=LEFT)
        put(ws, f"C{r}", f"PLG {clo['plg']}")
        put(ws, f"D{r}", f"=SUMIF({m}${q_first}$7:${q_last}$7,A{r},{m}${q_first}$6:${q_last}$6)", fmt="0")
        put(ws, f"E{r}", f"=COUNT({scores})", fmt="0")
        put(ws, f"F{r}", f'=COUNTIF({scores},">="&$B$4*D{r})', fmt="0")
        put(ws, f"G{r}", f'=COUNTIF({scores},">="&$B$5*D{r})-F{r}', fmt="0")
        put(ws, f"H{r}", f"=E{r}-F{r}-G{r}", fmt="0")
        put(ws, f"I{r}", f"=IF(E{r}=0,0,(F{r}+G{r})/E{r})", fmt="0.0%")
        put(ws, f"J{r}", "=$B$6", fmt="0%")
        put(ws, f"K{r}", f'=IF(E{r}=0,"",IF(I{r}>=J{r},"Target met","Below target"))', bold=True)
        ws.row_dimensions[r].height = 54

    notes = ["Notes",
             "CO here means Course Learning Outcome: CO1 is CLO1 in the Course Outline and AoL Plan.",
             "The cut-offs and target are drafts for faculty to check; none comes from the handbook.",
             "The Course Planner starts from the cut-offs and target set here when this file is uploaded. Its sliders can then change the cut-offs for the report.",
             "AB means absent. A student with no marks at all for a CO is left out of its Assessed count.",
             "Edit only the blue marks on the Marks Sheet and the yellow cells here; everything else recalculates."]
    if sample:
        notes.insert(1, f"Sample results: all marks in this file are illustrative, standing in for the {SAMPLE_YEAR} offering.")
    for n, text in enumerate(notes):
        r = start + len(clos) + 2 + n
        ws.merge_cells(f"A{r}:K{r}")
        cell = ws[f"A{r}"]
        cell.value = text
        cell.font = Font(name=FONT, size=11, bold=n == 0)
        cell.alignment = LEFT

    for letter, width in zip("ABCDEFGHIJK", (38, 44, 8, 9, 10, 9, 9, 10, 11, 8, 14)):
        ws.column_dimensions[letter].width = width
    ws.row_dimensions[start].height = 30
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToWidth, ws.page_setup.fitToHeight = 1, 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True


def build_help(wb, code, sample):
    ws = wb.create_sheet(HELP)
    lines = ["How to use this marks sheet",
             "Enter each student's marks in the blue cells on the Marks Sheet tab, and AB if a student was absent.",
             "Each column counts towards the CLO in its Course Outcome row, so CO1 is CLO1. Columns with no Course Outcome aren't counted.",
             "Use the columns for the assessments named in the AoL Plan. Change the labels, marks and Course Outcome row if yours differ.",
             "Then upload this file on the Marks & results tab of the Course Planner. The Results tab shows the distribution, and the AoL Report for this subject is built from it.",
             "The AoL Summary tab adds up the results with formulas as you enter marks.",
             "The marks for each column and the Bloom's levels are drafts for faculty to check; none comes from the handbook."]
    if code in NOTES:
        lines.append(NOTES[code])
    if sample:
        lines.append(f"Sample only: all marks in this file are illustrative, standing in for the {SAMPLE_YEAR} offering.")
    for n, text in enumerate(lines, 1):
        cell = ws[f"A{n}"]
        cell.value = text
        cell.font = Font(name=FONT, size=14 if n == 1 else 11, bold=n == 1)
        cell.alignment = LEFT
    ws.column_dimensions["A"].width = 120


if __name__ == "__main__":
    TARGET.mkdir(exist_ok=True)
    for code in ITEMS:
        for sample, path in ((False, TARGET / f"{code}_Marks_Sheet_Blank.xlsx"), (True, SAMPLES / f"{code}_Marks_Sheet.xlsx")):
            wb = Workbook()
            build_marks(wb, code, sample)
            build_summary(wb, code, sample)
            build_help(wb, code, sample)
            wb.properties.creator = wb.properties.lastModifiedBy = "E-Logic School of Business"
            wb.properties.title = f"{code} Marks Sheet"
            wb.save(path)
            print(path)
