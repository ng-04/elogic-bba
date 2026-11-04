"""Publishes the finished course documents to docs/course-docs/ for the Course Planner page.

Run after build.py and build_marks.py:  python data/course_docs/publish.py
Writes the files, index.json (what exists for each subject) and fields/<code>.json (what fills an
uploaded template in the browser). Needs python-docx, Pillow and openpyxl.
"""
import json
import re
import shutil
import zipfile
from pathlib import Path

from build import subject_fields
from build_marks import BATCH, report_fields

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "data" / "outgoing"
TARGET = ROOT / "docs" / "course-docs"
FILES = {"outline": "{}_Course_Outline.docx", "aol": "{}_AoL_Plan.docx", "report": "{}_MidTerm_Marks_Sheet.xlsx"}



def strip_excel_traces(path):
    """Excel records who saved a workbook and the folder it was saved in; neither belongs in a public file."""
    with zipfile.ZipFile(path) as z:
        parts = [(i.filename, z.read(i)) for i in z.infolist()]
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, blob in parts:
            if name == "docProps/core.xml":
                blob = re.sub(rb"<cp:lastModifiedBy>[^<]*", b"<cp:lastModifiedBy>E-Logic School of Business", blob)
            elif name == "xl/workbook.xml":
                blob = re.sub(rb"<mc:AlternateContent.*?</mc:AlternateContent>", b"", blob, flags=re.S)
            z.writestr(name, blob)
    with zipfile.ZipFile(path) as z:
        leaked = [n for n in z.namelist() if re.search(rb"C:\\\\Users|C:\\Users", z.read(n))]
    if leaked:
        raise SystemExit(f"Local folder left in {path.name}: {leaked}")


TARGET.mkdir(exist_ok=True)
(TARGET / "fields").mkdir(exist_ok=True)
data = json.loads((ROOT / "site-data.json").read_text())
index = {}
for content in sorted((Path(__file__).parent / "content").glob("[A-Z]*[0-9]*.json")):
    code = content.stem
    index[code] = {}
    for kind, pattern in FILES.items():
        name = pattern.format(code)
        if (SOURCE / name).exists():
            shutil.copy2(SOURCE / name, TARGET / name)
            if name.endswith(".xlsx"):
                strip_excel_traces(TARGET / name)
            index[code][kind] = name
    fields = subject_fields(code)
    if "report" in index[code]:
        students = sorted((s for s in data["students"] if s["Batch"] == BATCH), key=lambda s: (s["Section"], s["Student ID"]))
        fields["report"] = report_fields(students, json.loads(content.read_text())["clos"])
    (TARGET / "fields" / f"{code}.json").write_text(json.dumps(fields, indent=1, ensure_ascii=False) + "\n")
(TARGET / "index.json").write_text(json.dumps(index, indent=2) + "\n")
print(json.dumps(index, indent=2))
