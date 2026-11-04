"""Builds the dummy BBA302 mid-term marks sheet and its AoL summary.

Students come from site-data.json and CLO wording from content/BBA302.json. Marks are random
but repeatable, and every total and summary figure is an Excel formula.

Run:  python data/course_docs/build_marks.py
Writes to data/outgoing/. Needs openpyxl.
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
OUT = ROOT / "data" / "outgoing" / "BBA302_MidTerm_Marks_Sheet.xlsx"
BLANK = ROOT / "docs" / "course-docs" / "templates" / "E-Logic_AoL_Report_Template.xlsx"
CODE, BATCH = "BBA302", "2025-28"
MARKS, SUMMARY = "Marks Sheet", "AoL Summary"
# Question number, marks, course outcome, Bloom's level, how hard it is for this dummy class (0-1 shift).
QUESTIONS = [(1, 10, "CO1", 3, 0.04), (2, 5, "CO1", 2, 0.10), (3, 15, "CO3", 5, -0.08)]
PLG_OF = {"CO1": "PLG 1", "CO3": "PLG 3"}
ABSENT = 2
FIRST = 9  # first student row
CO_COLUMN = 9  # column I holds CO1

FONT = "Arial"
thin = Side(style="thin", color="999999")
BOX = Border(left=thin, right=thin, top=thin, bottom=thin)
HEAD = PatternFill("solid", fgColor="E8EAF0")
INPUT = PatternFill("solid", fgColor="FFFF00")
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
LEFT = Alignment(horizontal="left", vertical="center", wrap_text=True)
BLUE = "0000FF"


def put(ws, ref, value, bold=False, fill=None, align=CENTER, color=None, fmt=None, size=10):
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


EXAM_EVENT, EXAM_DATE = "E-LOGIC BLR UG MID-TERM 2026-27", "15Sep2026 (02:00 PM - 03:00 PM)"
PAPER_TITLE, SUMMARY_TITLE = "Financial Management [Answer 3 / 3]", "BBA302 Financial Management: Mid-Term AoL Summary"
REPORT_NOTE = "All names, roll numbers, marks and the exam date are dummy data."


def report_fields(students, clos):
    """What the page needs to fill a blank AoL Report for this subject."""
    marks = dummy_marks(students)
    return {"cells": {"exam_event": EXAM_EVENT, "program": "BBA", "subject": "[BBA302] Financial Management",
                      "exam_date": EXAM_DATE, "paper_title": PAPER_TITLE, "summary_title": f"{SUMMARY_TITLE} (dummy data)",
                      "report_note": REPORT_NOTE,
                      **{f"{o.lower()}_text": clos[int(o[2:]) - 1]["text"] for o in PLG_OF}},
            "students": [{"section": s["Section"], "name": s["Student Name"], "roll": s["Student ID"],
                          "marks": marks[s["Student ID"]]} for s in students]}


def dummy_marks(students):
    """Half-mark scores that follow each student's CGPA, with a few students absent."""
    random.seed(302)
    absent = sorted(students, key=lambda s: s["Attendance % (current sem)"])[:ABSENT]
    rows = {}
    for s in students:
        if s in absent:
            rows[s["Student ID"]] = ["AB"] * len(QUESTIONS)
            continue
        ability = 0.06 + 0.075 * s["CGPA"]
        scores = []
        for _, marks, _, _, shift in QUESTIONS:
            share = min(1, max(0.1, random.gauss(ability + shift, 0.14)))
            scores.append(round(share * marks * 2) / 2)
        rows[s["Student ID"]] = scores
    return rows


def build_marks(wb, students, blank=False):
    ws = wb.active
    ws.title = MARKS
    last = FIRST + len(students) - 1
    q_first, q_last = col(5), col(4 + len(QUESTIONS))
    total = col(5 + len(QUESTIONS))

    for ref, text in (("A1", "Exam Event"), ("B1", "Program"), ("C1", "Subject"), ("D1", "Exam Date")):
        put(ws, ref, text, bold=True)
    merge(ws, f"{q_first}1:{q_last}1", "Evaluation", bold=True)
    for ref, text in (("A2", "{exam_event}" if blank else EXAM_EVENT), ("B2", "{program}" if blank else "BBA"),
                      ("C2", "{subject}" if blank else "[BBA302] Financial Management"),
                      ("D2", "{exam_date}" if blank else EXAM_DATE)):
        put(ws, ref, text)
    merge(ws, f"{q_first}2:{q_last}2", 1)

    for letter, text in (("A", "S.No"), ("B", "Section"), ("C", "Student Name")):
        merge(ws, f"{letter}3:{letter}8", text, bold=True, fill=HEAD)
    put(ws, "D3", "Rollnum", bold=True, fill=HEAD)
    merge(ws, f"{q_first}3:{q_last}3", "{paper_title}" if blank else PAPER_TITLE, bold=True, fill=HEAD)
    merge(ws, f"{total}3:{total}8", f'="Total ("&SUM({q_first}6:{q_last}6)&")"', bold=True, fill=HEAD)
    co_last = col(CO_COLUMN + 9)
    merge(ws, f"{col(CO_COLUMN)}3:{co_last}3", "Marks Obtained in", bold=True, fill=HEAD)
    for n in range(10):
        letter = col(CO_COLUMN + n)
        merge(ws, f"{letter}4:{letter}8", f"CO{n + 1}", bold=True, fill=HEAD)

    for row, label in ((4, "Question"), (5, "Question No"), (6, "Question Marks"), (7, "Course Outcome"), (8, "Bloom's Level")):
        put(ws, f"D{row}", label, bold=True, fill=HEAD)
    for n, (number, marks, outcome, bloom, _) in enumerate(QUESTIONS):
        letter = col(5 + n)
        put(ws, f"{letter}4", f"Q{number}", bold=True, fill=HEAD)
        for row, value in ((5, number), (6, marks), (7, outcome), (8, bloom)):
            put(ws, f"{letter}{row}", value, color=BLUE)

    marks = {} if blank else dummy_marks(students)
    span = f"${q_first}$7:${q_last}$7"
    for n, s in enumerate(students):
        r = FIRST + n
        put(ws, f"A{r}", None if blank else n + 1)
        put(ws, f"B{r}", None if blank else s["Section"])
        put(ws, f"C{r}", None if blank else s["Student Name"], align=LEFT)
        put(ws, f"D{r}", None if blank else s["Student ID"])
        for i, score in enumerate(marks.get(s["Student ID"], [None] * len(QUESTIONS))):
            put(ws, f"{col(5 + i)}{r}", score, color=BLUE, fmt="0.0")
        put(ws, f"{total}{r}", f'=IF($D{r}="","",IF(COUNT({q_first}{r}:{q_last}{r})=0,"AB",SUM({q_first}{r}:{q_last}{r})))',
            bold=True, fmt="0.0")
        for c in range(10):
            letter = col(CO_COLUMN + c)
            put(ws, f"{letter}{r}",
                f'=IF(OR(COUNTIF({span},{letter}$4)=0,$D{r}=""),"",IF(${total}{r}="AB","AB",'
                f'SUMIF({span},{letter}$4,${q_first}{r}:${q_last}{r})))', fmt="0.0")

    check = DataValidation(type="custom", showErrorMessage=True, errorTitle="Check the mark",
                           error="Enter a mark from 0 up to the question's marks, or AB if absent.",
                           formula1=f'OR({q_first}{FIRST}="AB",AND(ISNUMBER({q_first}{FIRST}),{q_first}{FIRST}>=0,{q_first}{FIRST}<={q_first}$6))')
    check.add(f"{q_first}{FIRST}:{q_last}{last}")
    ws.add_data_validation(check)

    widths = {"A": 34, "B": 10, "C": 30, "D": 32, total: 10}
    for letter, width in widths.items():
        ws.column_dimensions[letter].width = width
    for n in range(len(QUESTIONS)):
        ws.column_dimensions[col(5 + n)].width = 11
    for n in range(10):
        ws.column_dimensions[col(CO_COLUMN + n)].width = 6.5
    ws.row_dimensions[3].height = 30
    ws.freeze_panes = f"E{FIRST}"
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToWidth, ws.page_setup.fitToHeight = 1, 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_title_rows = "1:8"
    return last


def build_summary(wb, students, last, clos, blank=False):
    ws = wb.create_sheet(SUMMARY)
    m = f"'{MARKS}'!"
    total = col(5 + len(QUESTIONS))
    q_first, q_last = col(5), col(4 + len(QUESTIONS))
    total_range = f"{m}${total}${FIRST}:${total}${last}"

    ws.merge_cells("A1:K1")
    put(ws, "A1", "{summary_title}" if blank else f"{SUMMARY_TITLE} (dummy data)", bold=True, size=13, align=LEFT).border = Border()

    put(ws, "A3", "Cut-offs (edit the yellow cells)", bold=True, fill=HEAD, align=LEFT)
    put(ws, "B3", "Value", bold=True, fill=HEAD)
    for r, label, value in ((4, "Exceed Expectation: at least", 0.75), (5, "Meet Expectation: at least", 0.5),
                            (6, "Target: students meeting or exceeding", 0.7)):
        put(ws, f"A{r}", label, align=LEFT)
        put(ws, f"B{r}", value, fill=INPUT, color=BLUE, fmt="0%")

    put(ws, "D3", "Class summary", bold=True, fill=HEAD, align=LEFT)
    ws.merge_cells("D3:E3")
    put(ws, "F3", "Value", bold=True, fill=HEAD)
    class_rows = ((4, "Students enrolled", f"=COUNTA({m}$D${FIRST}:$D${last})", "0"),
                  (5, "Appeared", f"=COUNT({total_range})", "0"),
                  (6, "Absent", f'=COUNTIF({total_range},"AB")', "0"),
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
    for i, outcome in enumerate(PLG_OF):
        r = start + 1 + i
        letter = col(CO_COLUMN + int(outcome[2:]) - 1)
        scores = f"{m}${letter}${FIRST}:${letter}${last}"
        put(ws, f"A{r}", outcome, bold=True)
        put(ws, f"B{r}", f"{{{outcome.lower()}_text}}" if blank else clos[int(outcome[2:]) - 1]["text"], align=LEFT)
        put(ws, f"C{r}", PLG_OF[outcome])
        put(ws, f"D{r}", f"=SUMIF({m}${q_first}$7:${q_last}$7,A{r},{m}${q_first}$6:${q_last}$6)", fmt="0")
        put(ws, f"E{r}", f"=COUNT({scores})", fmt="0")
        put(ws, f"F{r}", f'=COUNTIF({scores},">="&$B$4*D{r})', fmt="0")
        put(ws, f"G{r}", f'=COUNTIF({scores},">="&$B$5*D{r})-F{r}', fmt="0")
        put(ws, f"H{r}", f"=E{r}-F{r}-G{r}", fmt="0")
        put(ws, f"I{r}", f"=IF(E{r}=0,0,(F{r}+G{r})/E{r})", fmt="0.0%")
        put(ws, f"J{r}", "=$B$6", fmt="0%")
        put(ws, f"K{r}", f'=IF(I{r}>=J{r},"Target met","Below target")', bold=True)
        ws.row_dimensions[r].height = 54

    notes = ("Notes",
             "{report_note}" if blank else REPORT_NOTE,
             "CO here means Course Learning Outcome: CO1 is CLO1 and CO3 is CLO3 in the BBA302 Course Outline.",
             "The mid-term tests CO1 and CO3 only. CO2 and CO4 are assessed elsewhere, as set out in the AoL Plan.",
             "The cut-offs, target, Bloom's levels and 30-mark total are drafts for faculty to check; none comes from the handbook.",
             "AB means absent. Absent students are left out of the Assessed count.",
             "Edit only blue marks on the Marks Sheet and the yellow cells here; everything else recalculates.")
    for n, text in enumerate(notes):
        r = start + 4 + n
        ws.merge_cells(f"A{r}:K{r}")
        cell = ws[f"A{r}"]
        cell.value = text
        cell.font = Font(name=FONT, size=10, bold=n == 0)
        cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)

    for letter, width in zip("ABCDEFGHIJK", (38, 44, 8, 9, 10, 9, 9, 10, 11, 8, 14)):
        ws.column_dimensions[letter].width = width
    ws.row_dimensions[start].height = 30
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToWidth, ws.page_setup.fitToHeight = 1, 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True


if __name__ == "__main__":
    data = json.loads((ROOT / "site-data.json").read_text())
    students = sorted((s for s in data["students"] if s["Batch"] == BATCH), key=lambda s: (s["Section"], s["Student ID"]))
    clos = json.loads((HERE / "content" / f"{CODE}.json").read_text())["clos"]
    for path, blank in ((OUT, False), (BLANK, True)):
        wb = Workbook()
        last = build_marks(wb, students, blank)
        build_summary(wb, students, last, clos, blank)
        wb.properties.creator = wb.properties.lastModifiedBy = "E-Logic School of Business"
        wb.properties.title = "AoL Report template" if blank else "BBA302 Mid-Term Marks Sheet (dummy data)"
        wb.save(path)
        print(path)
