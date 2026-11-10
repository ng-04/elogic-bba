"""Fills the Course Outline, AoL Plan and AoL Report Word templates for one or more subjects.

Facts (code, credits, faculty, batch, students) come from site-data.json and the assessment
split from the handbook rules; each subject's written content comes from content/<code>.json.

Run:  python data/course_docs/build.py BBA302
Writes to data/outgoing/. Needs python-docx and Pillow.
"""
import copy
import io
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path

from docx import Document
from docx.enum.table import WD_ALIGN_VERTICAL
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.opc.constants import RELATIONSHIP_TYPE
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor
from docx.table import Table
from docx.text.paragraph import Paragraph
from PIL import Image, ImageDraw, ImageFont

from build_marks import RESULTS_NOTE, RESULTS_RULE, class_results

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
TEMPLATES = ROOT / "data" / "incoming"
OUT = ROOT / "data" / "outgoing"
BLANKS = ROOT / "docs" / "course-docs" / "templates"
OUTLINE_TEMPLATE = TEMPLATES / "Course Outline Format_Semesters III, V and VII.docx"
AOL_TEMPLATE = TEMPLATES / "AoL_Plan_Format.docx"
REPORT_TEMPLATE = TEMPLATES / "AoL_Report_Format.docx"

SCHOOL = "E-Logic School of Business, Bengaluru"
PROGRAMME = "Bachelor of Business Administration (BBA)"
ROMAN = {1: "I", 2: "II", 3: "III", 4: "IV", 5: "V", 6: "VI", 7: "VII", 8: "VIII", "{semester}": "{semester}"}
DRAFT = "DRAFT FOR FACULTY REVIEW"
PREVIOUS_YEAR = "2025-26"
PREVIOUS = f"PREVIOUS VERSION {PREVIOUS_YEAR}: FOR REFERENCE"
FONT = "Times New Roman"
HEADING_SIZE, BODY_SIZE = 14, 11
NAVY, ORANGE = (0x16, 0x23, 0x3F), (0xE3, 0x5A, 0x1B)
FONTS = Path("/mnt/c/Windows/Fonts")

PLGS = {
    1: "Understanding and Application of Fundamentals",
    2: "Problem Identification and Solution",
    3: "Integrative and Critical Thinking",
    4: "Effective Communication",
    5: "Ethical Responsibility",
    6: "Leadership",
}
# Handbook, Assessment page: the final evaluation for each assessment type, as (name, weightage, minutes).
# Workshops are 100% continuous, so they have none.
END_TERM = {"Exam": ("End-Term", 60, "180"), "Workshop": None, "Project": ("Final Report and Viva", 50, None),
            "Blank": ("{end_term_name}", "{end_term_weight}", "{end_term_minutes}")}
PLAGIARISM = ("Plagiarism above 15% (checked by software) in any submission, or any use of unauthorised AI tools "
              "in exams, leads to zero marks for that component. Repeat cases go to the Academic Integrity "
              "Committee, chaired by the Dean.")


def subject_facts(code):
    data = json.loads((ROOT / "site-data.json").read_text())
    subject = next(r for r in data["curriculum"] if r["Subject Code"] == code)
    faculty = next(f for f in data["faculty"] if f["id"] == subject["Faculty ID"])
    sections = [r for r in data["facultyUtilization"] if r["Subject Code"] == code]
    director = next(f for f in data["faculty"] if f["role"] == "Programme Director, BBA")
    dean = next(f for f in data["faculty"] if f["role"].startswith("Dean"))
    # Nobody endorses their own course: the Programme Director does, or the Dean for the Director's courses.
    endorser = dean if faculty["id"] == director["id"] else director
    return {
        "subject": subject, "faculty": faculty, "endorser": endorser,
        "batch": sections[0]["Batch"], "term": sections[0]["Term"],
        "students": sum(r["Students"] for r in sections), "sections": len(sections),
    }


def clo_list(numbers):
    if isinstance(numbers, str):  # a marked field in a blank template
        return numbers
    return ", ".join(f"CLO{n}" for n in numbers)


def font(run, size=None, bold=None, italic=None, color=None):
    run.font.name = FONT
    run._r.get_or_add_rPr().rFonts.set(qn("w:cs"), FONT)
    if size:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic
    if color:
        run.font.color.rgb = RGBColor(*color)
    return run


def set_text(paragraph, text):
    """Replaces a paragraph's text, keeping the formatting of its first run."""
    runs = paragraph.runs
    if not runs:
        return paragraph.add_run(text)
    runs[0].text = text
    for extra in runs[1:]:
        extra._r.getparent().remove(extra._r)
    return runs[0]


def insert_after(element, doc, like=None):
    """Adds an empty paragraph after a body element, optionally copying another paragraph's properties."""
    new = OxmlElement("w:p")
    if like is not None and like._p.pPr is not None:
        new.append(copy.deepcopy(like._p.pPr))
    element.addnext(new)
    return Paragraph(new, doc.element.body)


def set_cell(cell, text, size=None, bold=None, left=False):
    paragraph = cell.paragraphs[0]
    for extra in cell.paragraphs[1:]:
        extra._p.getparent().remove(extra._p)
    if paragraph.runs:
        run = set_text(paragraph, text)
    else:
        run = font(paragraph.add_run(text))
    if size:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if left:
        paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
    cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER


def remove(*elements):
    for element in elements:
        element.getparent().remove(element)


def tidy_table(table, heading=None):
    """Keeps a table's heading and header row with its first row, repeats the header, and never splits a row."""
    if heading is not None:
        heading.paragraph_format.keep_with_next = True
    for n, row in enumerate(table.rows):
        props = row._tr.get_or_add_trPr()
        if props.find(qn("w:cantSplit")) is None:
            props.append(OxmlElement("w:cantSplit"))
        if n == 0:
            if props.find(qn("w:tblHeader")) is None:
                props.append(OxmlElement("w:tblHeader"))
            for cell in row.cells:
                for paragraph in cell.paragraphs:
                    paragraph.paragraph_format.keep_with_next = True


def set_widths(table, widths):
    """Sets a table's column widths in twentieths of a point."""
    for column, width in zip(table._tbl.tblGrid, widths):
        column.set(qn("w:w"), str(width))
    for row in table.rows:
        for cell, width in zip(row.cells, widths):
            cell.width = Pt(width / 20)


def keep_together(table):
    """Keeps a short table on one page."""
    for row in table.rows[:-1]:
        for cell in row.cells:
            for paragraph in cell.paragraphs:
                paragraph.paragraph_format.keep_with_next = True


def fit_rows(table, count, first=1):
    """Grows or shrinks a table to `count` body rows by cloning its first body row."""
    while len(table.rows) - first > count:
        table._tbl.remove(table.rows[-1]._tr)
    while len(table.rows) - first < count:
        table.rows[-1]._tr.addnext(copy.deepcopy(table.rows[first]._tr))


def draft_line(after, doc, text=DRAFT):
    p = insert_after(after, doc)
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(8)
    font(p.add_run(text), bold=True, color=ORANGE)
    return p


def set_size(rpr, size):
    for tag in ("w:sz", "w:szCs"):
        node = rpr.find(qn(tag))
        if node is None:
            node = OxmlElement(tag)
            rpr.append(node)
        node.set(qn("w:val"), str(size * 2))


def set_fonts(rpr):
    fonts = rpr.find(qn("w:rFonts"))
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        rpr.insert(0, fonts)
    for key in list(fonts.attrib):
        if key.endswith("Theme"):
            del fonts.attrib[key]
    for key in ("ascii", "hAnsi", "cs", "eastAsia"):
        fonts.set(qn(f"w:{key}"), FONT)


def is_heading(paragraph):
    """A heading is a line outside a table whose text is all bold, apart from the version line under the title."""
    if not paragraph.text.strip() or paragraph.text in (DRAFT, PREVIOUS):
        return False
    style_bold = bool(paragraph.style.font.bold)
    return all(run.bold or (run.bold is None and style_bold) for run in paragraph.runs if run.text.strip())


def set_type(doc):
    """Times New Roman throughout: 14 point for headings, 11 point for everything else, including tables."""
    for rpr in doc.styles.element.iter(qn("w:rPr")):
        set_fonts(rpr)
    for style in doc.styles.element.findall(qn("w:style")):
        rpr = style.find(qn("w:rPr"))
        if rpr is not None and rpr.find(qn("w:sz")) is not None:
            set_size(rpr, BODY_SIZE)

    def apply(paragraph, size):
        for run in paragraph.runs:
            rpr = run._r.get_or_add_rPr()
            set_fonts(rpr)
            set_size(rpr, size)
        ppr = paragraph._p.get_or_add_pPr()
        mark = ppr.find(qn("w:rPr"))
        if mark is None:
            mark = OxmlElement("w:rPr")
            ppr.append(mark)
        set_fonts(mark)
        set_size(mark, size)

    headings = [p._p for p in doc.paragraphs if is_heading(p)]
    for element in doc.element.body.iter(qn("w:p")):
        apply(Paragraph(element, doc.element.body), HEADING_SIZE if element in headings else BODY_SIZE)
    for section in doc.sections:
        for paragraph in (*section.header.paragraphs, *section.footer.paragraphs):
            apply(paragraph, BODY_SIZE)


def wordmark():
    """The E-Logic wordmark, sized for the template's logo slot."""
    w, h = 1376, 400
    image = Image.new("RGB", (w, h), "white")
    draw = ImageDraw.Draw(image)
    big = ImageFont.truetype(FONTS / "georgiab.ttf", 170)
    small = ImageFont.truetype(FONTS / "georgia.ttf", 52)
    name, line = "E-LOGIC", "SCHOOL OF BUSINESS  ·  BENGALURU"
    draw.text(((w - draw.textlength(name, font=big)) / 2, 40), name, font=big, fill=NAVY)
    draw.rectangle((w / 2 - 330, 245, w / 2 + 330, 253), fill=ORANGE)
    draw.text(((w - draw.textlength(line, font=small)) / 2, 280), line, font=small, fill=NAVY)
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=95)
    return buffer.getvalue()


def clean_package(path):
    """Removes the template's previous owner from file properties, then checks nothing is left."""
    with zipfile.ZipFile(path) as z:
        parts = {i: z.read(i) for i in z.infolist()}
    cleaned = {}
    for info, blob in parts.items():
        name = info.filename
        if name == "docProps/custom.xml":
            blob = re.sub(rb"<property .*?</property>", b"", blob, flags=re.S)
        elif name == "docProps/app.xml":
            blob = re.sub(rb"<Company>.*?</Company>", b"<Company>E-Logic School of Business</Company>", blob)
            blob = re.sub(rb"<Manager>.*?</Manager>", b"", blob)
        elif name == "word/_rels/settings.xml.rels":
            blob = re.sub(rb'<Relationship [^>]*attachedTemplate[^>]*/>', b"", blob)
        elif name == "word/settings.xml":
            blob = re.sub(rb"<w:attachedTemplate [^>]*/>", b"", blob)
            blob = re.sub(rb'<w:zoom (?![^>]*w:percent)', b'<w:zoom w:percent="100" ', blob)
        elif name == "word/document.xml":
            blob = re.sub(rb'descr="A picture containing text[^"]*"', b'descr="E-Logic School of Business"', blob)
        cleaned[info] = blob
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for info, blob in cleaned.items():
            z.writestr(info.filename, blob)
    terms = (TEMPLATES / "banned-terms.txt").read_text().split("\n")
    banned = re.compile("|".join(t for t in terms if t).encode(), re.I)
    for info, blob in cleaned.items():
        if not info.filename.endswith((".jpeg", ".png")) and banned.search(blob):
            raise SystemExit(f"Template reference left in {path.name}: {info.filename}")


def set_properties(doc, title):
    set_type(doc)
    props = doc.core_properties
    props.author = props.last_modified_by = "E-Logic School of Business"
    props.title = title


def build_outline(content, facts, previous=False):
    doc = Document(OUTLINE_TEMPLATE)
    body = list(doc.element.body)
    P = lambda i: Paragraph(body[i], doc.element.body)
    T = lambda i: Table(body[i], doc)
    s, faculty = facts["subject"], facts["faculty"]

    next(r for r in doc.part.rels.values() if r.reltype.endswith("/image")).target_part._blob = wordmark()
    set_text(P(1), SCHOOL.upper())
    set_text(P(2), "{COURSE_NAME}" if s["Assessment"] == "Blank" else s["Subject"].upper())
    draft_line(body[2], doc, PREVIOUS if previous else DRAFT)

    # Course details: one tab stop so the values line up.
    details = [(3, "Programme:", PROGRAMME), (4, "Batch:", facts["batch"]), (5, "Semester:", ROMAN[s["Semester"]]),
               (6, "Course Name:", s["Subject"]), (7, "Course code:", s["Subject Code"]),
               (8, "Credits:", str(s["Credits"])), (9, "Course Instructor(s):", faculty["name"])]
    heading = P(6)
    for i, label, value in details:
        p = P(i)
        if i == 7:  # the template leaves this one line in a different style
            p._p.remove(p._p.pPr) if p._p.pPr is not None else None
            p._p.insert(0, copy.deepcopy(heading._p.pPr))
            p.runs[0]._r.remove(p.runs[0]._r.rPr) if p.runs[0]._r.rPr is not None else None
            p.runs[0]._r.insert(0, copy.deepcopy(heading.runs[0]._r.rPr))
        run = set_text(p, f"{label}\t")
        value_run = copy.deepcopy(run._r)
        run._r.addnext(value_run)
        value_run = p.runs[-1]
        value_run.text = value
        value_run.bold = False
        p.paragraph_format.tab_stops.add_tab_stop(Cm(5))
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT

    # Part 1
    font(P(12).add_run(content["introduction"]))

    def numbered(first, lines):
        """Writes `lines` into the template's blank paragraph, then one new paragraph each."""
        p = first
        for n, (prefix, text) in enumerate(lines):
            if n:
                p = insert_after(p._p, doc, like=first)
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT
            if not prefix:  # a loop marker in a blank template
                font(p.add_run(text))
                continue
            p.paragraph_format.left_indent = Cm(1.25)
            p.paragraph_format.first_line_indent = Cm(-1.25)
            p.paragraph_format.tab_stops.add_tab_stop(Cm(1.25))
            p.paragraph_format.space_after = Pt(3)
            font(p.add_run(f"{prefix}\t"), bold=True)
            font(p.add_run(text))
        return p

    blank = s["Assessment"] == "Blank"
    last_objective = numbered(P(15), loop_lines("objectives", "{n}.") if blank
                              else [(f"{n}.", t) for n, t in enumerate(content["objectives"], 1)])
    insert_after(last_objective._p, doc)
    last_clo = numbered(P(17), loop_lines("clos", "CLO{n}") if blank
                        else [(f"CLO{n}", c["text"]) for n, c in enumerate(content["clos"], 1)])
    insert_after(last_clo._p, doc)

    p = P(18)
    for book in ("{#textbooks}", "{text}", "{/textbooks}") if blank else map(textbook_line, content["textbooks"]):
        p = insert_after(p._p, doc)
        font(p.add_run(book))
    insert_after(p._p, doc)

    first = P(20)
    numbered(first, loop_lines("readings", "{n}.") if blank
             else [(f"{n}.", t) for n, t in enumerate(content["readings"], 1)])
    font(P(23).add_run("{plagiarism}" if blank else PLAGIARISM))
    # The template's page break here leaves half a page empty once the fields are filled.
    remove(*P(24).runs[0]._r.findall(qn("w:br")))

    # Assessment
    a = content["assessment"]
    final = END_TERM[s["Assessment"]]
    if not blank:
        weights = (final[1] if final else 0) + sum(c["weight"] for c in a["components"])
        assert weights == 100, f"{s['Subject Code']} weights add up to {weights}"
    if final:
        name, share, minutes = final
        end_term = (name, str(share), minutes or a["end_term"]["duration"],
                    a["end_term"]["mode"], clo_list(a["end_term"]["clos"]))
    else:
        end_term = ("No end-term exam", "-", "-", "-", "-")
    for cell, text in zip(T(27).rows[1].cells, end_term):
        set_cell(cell, text)
    table = T(32)
    fit_rows(table, len(a["components"]))
    for r, c in zip(table.rows[1:], a["components"]):
        r.cells[0].vertical_alignment = WD_ALIGN_VERTICAL.CENTER  # S. No. is numbered automatically
        for cell, text in zip(r.cells[1:], (c["name"], c["unit"], str(c["weight"]), c["when"], clo_list(c["clos"]))):
            set_cell(cell, text)

    # Part 2
    table = T(37)
    fit_rows(table, len(content["sessions"]))
    for r, session in zip(table.rows[1:], content["sessions"]):
        for cell, text in zip(r.cells, session):
            set_cell(cell, text)
    tidy_table(T(27), P(26))
    tidy_table(T(32), P(30))
    keep_together(T(27))
    keep_together(T(32))
    tidy_table(table, P(35))
    P(31).paragraph_format.keep_with_next = True
    P(36).paragraph_format.keep_with_next = True

    # PLG mapping
    mapped = plg_map(content)
    for r, plg in zip(T(44).rows[1:], PLGS):
        if blank:
            set_cell(r.cells[2], f"{{plg{plg}_addressed}}")
            set_cell(r.cells[3], f"{{plg{plg}_clos}}")
            continue
        set_cell(r.cells[2], "Yes" if plg in mapped else "No")
        set_cell(r.cells[3], clo_list(mapped[plg]) if plg in mapped else "-")

    # The template's blank lines would push the two side-by-side sign-off boxes onto a page of their own.
    tidy_table(T(44), P(42))
    P(43).paragraph_format.keep_with_next = True
    remove(*body[39:42], *body[46:51])

    # Sign-off
    endorser = facts["endorser"]
    endorser_role = endorser["role"].split(",")[0]
    signature = "Signature & Date: ________________________"
    for table, label in ((T(51), f"Endorsed by: {endorser['name']}, {endorser_role}"),
                         (T(52), f"Faculty: {faculty['name']}")):
        cell = table.rows[0].cells[0]
        set_text(cell.paragraphs[1], label)
        set_text(cell.paragraphs[3], signature)
        remove(cell.paragraphs[4]._p, cell.paragraphs[0]._p)
        table._tbl.tblPr.find(qn("w:tblpPr")).set(qn("w:tblpY"), "38")

    set_properties(doc, f"{s['Subject Code']} {s['Subject']} Course Outline")
    name = f"{s['Subject Code']}_Course_Outline_{PREVIOUS_YEAR}.docx" if previous else f"{s['Subject Code']}_Course_Outline.docx"
    path = BLANKS / "E-Logic_Course_Outline_Template.docx" if blank else OUT / name
    doc.save(path)
    clean_package(path)
    return path


def fill_aol_common(doc, body, content, facts):
    """The parts the AoL Plan and AoL Report share: heading, course details, CLOs and rubrics."""
    P = lambda i: Paragraph(body[i], doc.element.body)
    T = lambda i: Table(body[i], doc)
    s, faculty = facts["subject"], facts["faculty"]

    set_text(P(0), SCHOOL)
    draft_line(body[1], doc)

    rows = T(2).rows
    semester = f"Semester {ROMAN[s['Semester']]}, {facts['term']}"
    students = f"{facts['students']} ({facts['sections']} sections)"
    set_cell(rows[0].cells[2], "Programme")
    for r, left, right in zip(rows, (s["Subject"], s["Subject Code"], s["Academic Year"], faculty["name"]),
                              ("BBA", semester, str(s["Credits"]), students)):
        set_cell(r.cells[1], left)
        set_cell(r.cells[3], right)

    clos = content["clos"]
    for table in (T(6), T(9), T(14)):
        fit_rows(table, len(clos))
    for n, (r, c) in enumerate(zip(T(6).rows[1:], clos), 1):
        set_cell(r.cells[0], c.get("first", str(n)))
        set_cell(r.cells[1], c["text"], left=True)
        set_cell(r.cells[2], c.get("plg_label") or f"PLG {c['plg']}: {PLGS[c['plg']]}", left=True)
    for n, (r, c) in enumerate(zip(T(14).rows[1:], clos), 1):
        rubric = c["rubric"]
        set_cell(r.cells[0], c.get("first", str(n)), size=10)
        set_cell(r.cells[1], f"PLG {c['plg']}", size=10)
        for cell, text in zip(r.cells[2:], (rubric["exceed"], rubric["meet"], rubric["below"])):
            set_cell(cell, text, size=10, left=True)
    tidy_table(T(6), P(5))
    tidy_table(T(9), P(8))
    keep_together(T(9))
    tidy_table(T(14), P(13))
    for row in T(14).rows[1:]:  # the template's minimum row height pushes the last CLO onto a new page
        height = row._tr.get_or_add_trPr().find(qn("w:trHeight"))
        if height is not None:
            height.getparent().remove(height)


def build_aol(content, facts):
    doc = Document(AOL_TEMPLATE)
    body = list(doc.element.body)
    s = facts["subject"]
    blank = s["Assessment"] == "Blank"
    for n, (r, c) in enumerate(zip(fit_table(doc, body[9], content), content["clos"]), 1):
        set_cell(r.cells[0], c.get("first", str(n)))
        set_cell(r.cells[1], c["text"], left=True)
        set_cell(r.cells[2], c["mode"], left=True)
    fill_aol_common(doc, body, content, facts)
    remove(*body[11:13], *body[16:20])

    set_properties(doc, f"{s['Subject Code']} {s['Subject']} AoL Plan")
    path = BLANKS / "E-Logic_AoL_Plan_Template.docx" if blank else OUT / f"{s['Subject Code']}_AoL_Plan.docx"
    doc.save(path)
    clean_package(path)
    return path


def fit_table(doc, element, content):
    table = Table(element, doc)
    fit_rows(table, len(content["clos"]))
    return table.rows[1:]


def build_report(content, facts, results):
    doc = Document(REPORT_TEMPLATE)
    body = list(doc.element.body)
    P = lambda i: Paragraph(body[i], doc.element.body)
    T = lambda i: Table(body[i], doc)
    s, clos = facts["subject"], content["clos"]
    blank = s["Assessment"] == "Blank"

    for n, (r, c) in enumerate(zip(fit_table(doc, body[9], content), clos), 1):
        set_cell(r.cells[0], c.get("first", str(n)))
        set_cell(r.cells[1], c.get("n", str(n)))
        set_cell(r.cells[2], c["text"], left=True)
        set_cell(r.cells[3], c["mode"], left=True)
    fill_aol_common(doc, body, content, facts)
    set_widths(T(9), (720, 810, 5040, 2790))  # the template's narrow columns break "CLO No." at 11 point

    fit_rows(T(22), len(clos), first=2)
    for n, (r, c, result) in enumerate(zip(T(22).rows[2:], clos, results), 1):
        set_cell(r.cells[0], c.get("first", str(n)))
        set_cell(r.cells[1], f"PLG {c['plg']}")
        for cell, key in zip(r.cells[2:], ("exceed_n", "exceed_pct", "meet_n", "meet_pct", "below_n", "below_pct")):
            set_cell(cell, result[key])
            cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
    tidy_table(T(22), P(20))
    T(22).rows[1]._tr.get_or_add_trPr().append(OxmlElement("w:tblHeader"))
    keep_together(T(22))
    note = "{results_note} {results_rule}" if blank else f"{RESULTS_NOTE} {RESULTS_RULE}"
    font(P(23).add_run(note), italic=True)

    # Drafted from the results, for faculty to reflect on and rewrite on the planner's Results tab.
    fit_rows(T(26), len(clos))
    for n, (r, c, result) in enumerate(zip(T(26).rows[1:], clos, results), 1):
        set_cell(r.cells[0], c.get("first", str(n)))
        set_cell(r.cells[1], f"PLG {c['plg']}")
        set_cell(r.cells[2], result["analysis"], left=True)
        set_cell(r.cells[3], result["improvement"] + c.get("end_row", ""), left=True)
        for cell in r.cells[2:]:
            cell.paragraphs[0].paragraph_format.left_indent = cell.paragraphs[0].paragraph_format.right_indent = Cm(0.1)
    set_widths(T(26), (810, 810, 3870, 3870))
    tidy_table(T(26), P(24))
    remove(*body[11:13], *body[16:20], body[21], body[25])

    set_properties(doc, f"{s['Subject Code']} {s['Subject']} AoL Report")
    path = BLANKS / "E-Logic_AoL_Report_Template.docx" if blank else OUT / f"{s['Subject Code']}_AoL_Report.docx"
    doc.save(path)
    clean_package(path)
    return path


def loop_lines(name, prefix):
    """The three lines that repeat one numbered entry per item in a blank template."""
    return [("", f"{{#{name}}}"), (prefix, "{text}"), ("", f"{{/{name}}}")]


def textbook_line(book):
    return f"{book} (latest edition; to be confirmed by faculty)"


def plg_map(content):
    mapped = {}
    for n, c in enumerate(content["clos"], 1):
        mapped.setdefault(c["plg"], []).append(n)
    return mapped


def blank_inputs():
    """Content and facts made of marked fields, so the normal builders write a blank template."""
    subject = {"Subject": "{course_name}", "Subject Code": "{course_code}", "Semester": "{semester}",
               "Credits": "{credits}", "Assessment": "Blank", "Academic Year": "{academic_year}"}
    facts = {"subject": subject, "faculty": {"name": "{instructor}"}, "batch": "{batch}", "term": "{term}",
             "students": "{students}", "sections": "{sections}",
             "endorser": {"name": "{endorser}", "role": "{endorser_role}"}}
    content = {
        "introduction": "{introduction}", "objectives": [], "textbooks": [], "readings": [],
        "clos": [{"first": "{#clos}{n}", "n": "{n}", "end_row": "{/clos}", "text": "{text}", "plg": "{plg}", "plg_label": "{plg_label}{/clos}", "mode": "{mode}{/clos}",
                  "rubric": {"exceed": "{exceed}", "meet": "{meet}", "below": "{below}{/clos}"}}],
        "assessment": {"end_term": {"mode": "{end_term_mode}", "clos": "{end_term_clos}"},
                       "components": [{"name": "{#components}{name}", "unit": "{unit}", "weight": "{weight}",
                                       "when": "{when}", "clos": "{clos}{/components}"}]},
        "sessions": [["{#sessions}{no}", "{topic}", "{pedagogy}", "{reading}{/sessions}"]],
    }
    return content, facts


BLANK_RESULTS = [{"exceed_n": "{exceed_n}", "exceed_pct": "{exceed_pct}", "meet_n": "{meet_n}", "meet_pct": "{meet_pct}",
                  "below_n": "{below_n}", "below_pct": "{below_pct}{/clos}", "analysis": "{analysis}", "improvement": "{improvement}"}]


def previous_facts(facts):
    """The same subject one year earlier: the batch before this one, in the previous academic year."""
    start, end = facts["batch"].split("-")
    return {**facts, "batch": f"{int(start) - 1}-{int(end) - 1:02d}"}


def subject_fields(code):
    """Everything a template's marked fields can draw on, for filling templates in the browser."""
    content = json.loads((HERE / "content" / f"{code}.json").read_text())
    facts = subject_facts(code)
    s, a = facts["subject"], content["assessment"]
    final = END_TERM[s["Assessment"]]
    mapped = plg_map(content)
    fields = {
        "course_name": s["Subject"], "COURSE_NAME": s["Subject"].upper(), "course_code": s["Subject Code"],
        "programme": PROGRAMME, "batch": facts["batch"], "semester": ROMAN[s["Semester"]], "credits": str(s["Credits"]),
        "academic_year": s["Academic Year"], "term": facts["term"], "instructor": facts["faculty"]["name"],
        "endorser": facts["endorser"]["name"], "endorser_role": facts["endorser"]["role"].split(",")[0],
        "students": str(facts["students"]), "sections": str(facts["sections"]),
        "A": "{A}", "B": "{B}",  # the outline's own section labels, which look like marked fields
        "introduction": content["introduction"], "plagiarism": PLAGIARISM,
        "objectives": [{"n": n, "text": t} for n, t in enumerate(content["objectives"], 1)],
        "textbooks": [{"text": textbook_line(t)} for t in content["textbooks"]],
        "readings": [{"n": n, "text": t} for n, t in enumerate(content["readings"], 1)],
        "clos": [{"n": n, "text": c["text"], "plg": c["plg"], "plg_label": f"PLG {c['plg']}: {PLGS[c['plg']]}",
                  "mode": c["mode"], **c["rubric"], **result}
                 for n, (c, result) in enumerate(zip(content["clos"], class_results(code)), 1)],
        "results_note": RESULTS_NOTE, "results_rule": RESULTS_RULE,
        "components": [{"name": c["name"], "unit": c["unit"], "weight": str(c["weight"]), "when": c["when"],
                        "clos": clo_list(c["clos"])} for c in a["components"]],
        "sessions": [dict(zip(("no", "topic", "pedagogy", "reading"), row)) for row in content["sessions"]],
    }
    if final:
        name, share, minutes = final
        fields.update(end_term_name=name, end_term_weight=str(share), end_term_minutes=minutes or a["end_term"]["duration"],
                      end_term_mode=a["end_term"]["mode"], end_term_clos=clo_list(a["end_term"]["clos"]))
    else:
        fields.update(end_term_name="No end-term exam", end_term_weight="-", end_term_minutes="-",
                      end_term_mode="-", end_term_clos="-")
    for plg in PLGS:
        fields[f"plg{plg}_addressed"] = "Yes" if plg in mapped else "No"
        fields[f"plg{plg}_clos"] = clo_list(mapped[plg]) if plg in mapped else "-"
    return fields


HANDBOOK = "E-Logic_BBA_Student_Handbook_2026-27.pdf"
WORKBOOK = "E-Logic_BBA_Master_Data_2026-27.xlsx"
CHECKED = "4 November 2026"
FROM_DATA, AI_DRAFT = "Taken from source", "AI draft: faculty to check"
# Handbook, Assessment page (p.9): what the page fixes for each type, and what the draft had to decide.
ASSESSMENT_TRACE = {
    "Exam": [("End-term weightage (60%) and length (3 hours)", "Handbook p.9", FROM_DATA),
             ("Component totals: quizzes 10%, case analysis 10%, mid-term 20%", "Handbook p.9", FROM_DATA),
             ("Mid-term week", "Handbook p.11", FROM_DATA),
             ("Closed book end-term", "Not in handbook", AI_DRAFT)],
    "Workshop": [("100% continuous assessment, no end-term exam", "Handbook p.9", FROM_DATA),
                 ("Components: exercises 50%, participation and peer review 20%, final showcase 30%", "Handbook p.9", FROM_DATA)],
    "Project": [("Final report and viva, 50%", "Handbook p.9", FROM_DATA),
                ("Components: proposal 10%, milestone reviews 25%, mentor assessment 15%", "Handbook p.9", FROM_DATA),
                ("Viva length", "Not in handbook", AI_DRAFT)],
}


def link(paragraph, text, url):
    rel = paragraph.part.relate_to(url, RELATIONSHIP_TYPE.HYPERLINK, is_external=True)
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("r:id"), rel)
    run = font(paragraph.add_run(text), size=10, color=(0x05, 0x63, 0xC1))
    run.underline = True
    hyperlink.append(run._r)
    paragraph._p.append(hyperlink)


def reference_table(doc, header, rows, widths):
    table = doc.add_table(rows=1, cols=len(header))
    table.style = "Table Grid"
    table.autofit = False
    for cell, text in zip(table.rows[0].cells, header):
        font(cell.paragraphs[0].add_run(text), size=10, bold=True)
        shade = OxmlElement("w:shd")
        for key, value in (("val", "clear"), ("color", "auto"), ("fill", "F0F0F0")):
            shade.set(qn(f"w:{key}"), value)
        cell._tc.get_or_add_tcPr().append(shade)
    for row in rows:
        cells = table.add_row().cells
        for cell, value in zip(cells, row):
            if isinstance(value, tuple):
                link(cell.paragraphs[0], *value)
            else:
                font(cell.paragraphs[0].add_run(value), size=10)
    for row in table.rows:
        for cell, width in zip(row.cells, widths):
            cell.width = Cm(width)
    tidy_table(table)
    return table


def build_reference(content, facts):
    s = facts["subject"]
    books = json.loads((HERE / "content" / "books.json").read_text())
    doc = Document()
    section = doc.sections[0]
    section.page_width, section.page_height = Cm(21.59), Cm(27.94)
    section.left_margin = section.right_margin = Cm(2)
    doc.styles["Normal"].font.name = FONT
    doc.styles["Normal"].font.size = Pt(11)

    def heading(text, size=12, after=4):
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(12)
        p.paragraph_format.space_after = Pt(after)
        p.paragraph_format.keep_with_next = True
        font(p.add_run(text), size=size, bold=True)

    heading(f"{s['Subject Code']} {s['Subject']}: Reference Material", size=14)
    p = doc.add_paragraph()
    font(p.add_run(f"This shows where each part of the {s['Subject Code']} Course Outline and AoL Plan came from. "
                   "Facts come from the E-Logic handbook and master data. The written course content is an AI draft "
                   "based on general subject knowledge. "))
    font(p.add_run("The books below were not opened and no text was taken from them."), bold=True)
    font(p.add_run(" Faculty should check the draft against them."))

    heading("1. Source documents")
    reference_table(doc, ("Document", "Used for", "Where to find it"), [
        (HANDBOOK, "Programme details, assessment rules, plagiarism policy, calendar", "This folder"),
        (WORKBOOK, "Subject, faculty, batch and student numbers", "This folder"),
        ("Course Outline Format_Semesters III, V and VII.docx", "Outline layout and the six PLGs", "data/incoming"),
        ("AoL_Plan_Format.docx", "AoL Plan layout", "data/incoming"),
        ("FSA_Elective_CO_Batch22_Aug2024.xlsx", "Example of how an outline is structured; no text reused", "data/incoming"),
        ("FSA_092025_2 - Copy.docx", "Example of how assessments map to CLOs and PLGs; no text reused", "data/incoming"),
    ], (7.5, 6.6, 3.5))

    heading("2. Where each part came from")
    reference_table(doc, ("Part of the documents", "Source", "Status"), [
        ("Programme and semester", "Handbook p.3, p.6", FROM_DATA),
        ("Course name, code, credits, sessions", "Handbook p.6; master data, Curriculum Master sheet", FROM_DATA),
        ("Course instructor", "Handbook p.6; master data, Faculty Master sheet", FROM_DATA),
        ("Batch, term, students, sections", "Master data, Faculty Utilization sheet", FROM_DATA),
        *ASSESSMENT_TRACE[s["Assessment"]],
        ("Plagiarism policy", "Handbook p.9", FROM_DATA),
        ("PLG names and traits", "Course Outline format", FROM_DATA),
        ("Related subjects named in the introduction", "Handbook p.6-8", FROM_DATA),
        ("Endorser", "Handbook p.11 for the role; who endorses is a drafting choice", AI_DRAFT),
        ("Introduction, objectives and CLOs", "General subject knowledge", AI_DRAFT),
        ("CLO to PLG mapping", "General subject knowledge", AI_DRAFT),
        ("Session topics, pedagogy and readings", "General subject knowledge", AI_DRAFT),
        ("Component timing, unit of evaluation and CLOs tested", "Drafting choice within the handbook rules", AI_DRAFT),
        ("AoL modes of assessment and rubrics", "General subject knowledge", AI_DRAFT),
    ], (7.5, 6.6, 3.5))

    heading("3. Books and readings")
    p = doc.add_paragraph()
    font(p.add_run(f"Each title was confirmed online on {CHECKED}. A newer edition may exist, so faculty should confirm "
                   "the edition before use. Reading entries in the session plan name topics, not chapter titles."), size=10)
    rows = []
    for role, titles in (("Prescribed", content["textbooks"]), ("Other reading", content["readings"])):
        for title in titles:
            book = next((b for author, b in books.items() if title.startswith(author)), None)
            if book:
                rows.append((title, role, book["edition"], ("Listing", book["url"])))
            else:
                rows.append((title, role, "-", "-"))
    reference_table(doc, ("Book", "Role", "Latest edition found", "Link"), rows, (8, 2.3, 5.3, 2))

    set_properties(doc, f"{s['Subject Code']} {s['Subject']} Reference Material")
    path = OUT / f"{s['Subject Code']}_Reference_Material.docx"
    doc.save(path)
    clean_package(path)
    return path


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    BLANKS.mkdir(parents=True, exist_ok=True)
    print(build_outline(*blank_inputs()))
    print(build_aol(*blank_inputs()))
    print(build_report(*blank_inputs(), BLANK_RESULTS))
    for code in sys.argv[1:]:
        content = json.loads((HERE / "content" / f"{code}.json").read_text())
        facts = subject_facts(code)
        print(build_outline(content, facts))
        print(build_outline(content, previous_facts(facts), previous=True))
        print(build_aol(content, facts))
        print(build_report(content, facts, class_results(code)))
        print(build_reference(content, facts))
    for name in (HANDBOOK, WORKBOOK):
        shutil.copy2(ROOT / "docs" / name, OUT / name)
