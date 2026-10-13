"""Generates the dummy data for the E-Logic BBA demo, deterministically, from one source of truth.

Outputs (in docs/):
  E-Logic_BBA_Student_Handbook_2026-27.pdf  10-page student handbook (overview, pedagogy,
                                             subjects, assessment, outcomes, calendar, contacts)
  E-Logic_BBA_Master_Data_2026-27.xlsx       five sheets: Curriculum Master, Student Master,
                                             Faculty Master, Faculty Utilization (one row per
                                             section taught; links Faculty ID and Subject Code) and
                                             Assumptions. Calculated columns are Excel formulas,
                                             saved with their results.
and site-data.json, the same data for the website's pages.

Run:  pip install xlsxwriter reportlab && python data/generate.py
E-Logic School of Business and every name, number and date here is fictitious.
"""
import json
import random
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

import xlsxwriter
from xlsxwriter.utility import xl_col_to_name
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, KeepTogether, NextPageTemplate, PageBreak,
                                PageTemplate, Paragraph, Spacer, Table, TableStyle)

random.seed(2026)
ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
DOCS.mkdir(exist_ok=True)

SCHOOL = "E-Logic School of Business"
UNIVERSITY = "E-Logic University, Bengaluru"
AY = "2026-27"
HANDBOOK = DOCS / "E-Logic_BBA_Student_Handbook_2026-27.pdf"
MASTERS = DOCS / "E-Logic_BBA_Master_Data_2026-27.xlsx"
ANNUAL_FEE = 340000

# ------------------------------------------------------------------ curriculum

# Teaching time, the same for every subject whatever its assessment: 1 credit = 10 sessions of 75 minutes
# = 12.5 hours taught. For faculty workload each credit counts as 15 faculty credit hours, and each
# faculty member's goal is 150 faculty credit hours per academic year. The workbook's Assumptions sheet
# holds these four values, and every formula refers to them.
SESSIONS_PER_CREDIT = 10
MINUTES_PER_SESSION = 75
FCH_PER_CREDIT = 15
FACULTY_GOAL = 150


def num(x):
    """12.5 stays 12.5; 50.0 becomes 50."""
    return int(x) if float(x).is_integer() else x


def teaching(credits):
    """Teaching time for one section of a subject with this many credits."""
    sessions = credits * SESSIONS_PER_CREDIT
    minutes = sessions * MINUTES_PER_SESSION
    return {"Number of Sessions": sessions, "Minutes per Session": MINUTES_PER_SESSION, "Total Minutes Taught": minutes,
            "Hours Taught": num(minutes / 60), "Faculty Credit Hours": credits * FCH_PER_CREDIT}

WEIGHTING = {
    "Exam": "40% internal (quizzes, assignments, mid-term) + 60% end-term exam",
    "Workshop": "100% continuous: studio work, practicals, participation and a final showcase",
    "Project": "50% internal milestones + 50% final report and viva / presentation",
}
TERM = {1: "Odd (Jul-Nov 2026)", 3: "Odd (Jul-Nov 2026)", 5: "Odd (Jul-Nov 2026)",
        2: "Even (Jan-Apr 2027)", 4: "Even (Jan-Apr 2027)", 6: "Even (Jan-Apr 2027)"}

# code, subject, credits, type, assessment, track (for electives), faculty id
C, E = "Core", "Elective"
CURRICULUM = {
    1: [("BBA101", "Principles of Management", 4, C, "Exam", "", "F018"),
        ("BBA102", "Business Economics I (Micro)", 4, C, "Exam", "", "F004"),
        ("BBA103", "Financial Accounting", 4, C, "Exam", "", "F007"),
        ("BBA104", "Business Mathematics", 3, C, "Exam", "", "F013"),
        ("BBA105", "Business Communication", 3, C, "Workshop", "", "F011"),
        ("BBA106", "Digital Productivity Tools", 2, C, "Workshop", "", "F006"),
        ("BBA107", "Environmental Studies & Sustainability", 2, C, "Project", "", "F019")],
    2: [("BBA201", "Organisational Behaviour", 4, C, "Exam", "", "F005"),
        ("BBA202", "Business Economics II (Macro)", 4, C, "Exam", "", "F016"),
        ("BBA203", "Cost & Management Accounting", 4, C, "Exam", "", "F014"),
        ("BBA204", "Business Statistics", 3, C, "Exam", "", "F013"),
        ("BBA205", "Indian Business Environment", 3, C, "Exam", "", "F004"),
        ("BBA206", "Design Thinking Studio", 2, C, "Workshop", "", "F012"),
        ("BBA207", "Community Engagement Project", 2, C, "Project", "", "F019")],
    3: [("BBA301", "Marketing Management", 4, C, "Exam", "", "F003"),
        ("BBA302", "Financial Management", 4, C, "Exam", "", "F002"),
        ("BBA303", "Human Resource Management", 4, C, "Exam", "", "F017"),
        ("BBA304", "Business Law", 3, C, "Exam", "", "F010"),
        ("BBA305", "Business Analytics with Excel & Python", 3, C, "Workshop", "", "F006"),
        ("BBA306", "Negotiation & Persuasion", 2, C, "Workshop", "", "F005"),
        ("BBA3E1", "Psychology of Decision Making", 2, E, "Exam", "Open Elective I", "F016"),
        ("BBA3E2", "German Language I", 2, E, "Workshop", "Open Elective I", "F015"),
        ("BBA3E3", "Creative Writing for Business", 2, E, "Project", "Open Elective I", "F011")],
    4: [("BBA401", "Operations & Supply Chain Management", 4, C, "Exam", "", "F008"),
        ("BBA402", "Research Methodology", 3, C, "Exam", "", "F013"),
        ("BBA403", "Consumer Behaviour", 3, C, "Exam", "", "F009"),
        ("BBA404", "Entrepreneurship & New Venture Creation", 4, C, "Project", "", "F012"),
        ("BBA405", "Corporate Finance & Banking", 3, C, "Exam", "", "F014"),
        ("BBA406", "Business Simulation Workshop", 3, C, "Workshop", "", "F008"),
        ("BBA4E1", "Digital Marketing Fundamentals", 2, E, "Workshop", "Open Elective II", "F020"),
        ("BBA4E2", "German Language II", 2, E, "Workshop", "Open Elective II", "F015"),
        ("BBA4E3", "Behavioural Economics", 2, E, "Exam", "Open Elective II", "F016")],
    5: [("BBA501", "Strategic Management", 4, C, "Exam", "", "F001"),
        ("BBA502", "Business Ethics & Corporate Governance", 3, C, "Exam", "", "F019"),
        ("BBA503", "Summer Internship Report & Viva", 4, C, "Project", "", "F012"),
        ("BBA504", "Leadership Lab", 3, C, "Workshop", "", "F017"),
        ("MKT511", "Sales & Distribution Management", 4, E, "Exam", "Marketing", "F003"),
        ("MKT512", "Brand Management", 4, E, "Project", "Marketing", "F009"),
        ("FIN511", "Investment Analysis & Portfolio Management", 4, E, "Exam", "Finance", "F002"),
        ("FIN512", "Financial Markets & Services", 4, E, "Exam", "Finance", "F007"),
        ("HRM511", "Talent Acquisition & Management", 4, E, "Workshop", "Human Resources", "F005"),
        ("HRM512", "Compensation & Reward Management", 4, E, "Exam", "Human Resources", "F017"),
        ("BAN511", "Data Visualisation & Storytelling", 4, E, "Workshop", "Business Analytics", "F020"),
        ("BAN512", "Predictive Analytics for Business", 4, E, "Project", "Business Analytics", "F006")],
    6: [("BBA601", "International Business", 4, C, "Exam", "", "F018"),
        ("BBA602", "Business Taxation (GST & Direct Taxes)", 3, C, "Exam", "", "F014"),
        ("BBA603", "Capstone Consulting Project", 6, C, "Project", "", "F001"),
        ("BBA604", "Career Readiness Workshop", 1, C, "Workshop", "", "F012"),
        ("MKT611", "Digital & Social Media Marketing", 4, E, "Workshop", "Marketing", "F020"),
        ("MKT612", "Retail Management", 4, E, "Exam", "Marketing", "F009"),
        ("FIN611", "Corporate Valuation", 4, E, "Project", "Finance", "F002"),
        ("FIN612", "FinTech & Digital Banking", 4, E, "Exam", "Finance", "F007"),
        ("HRM611", "Learning & Development", 4, E, "Workshop", "Human Resources", "F005"),
        ("HRM612", "Labour Laws & Industrial Relations", 4, E, "Exam", "Human Resources", "F010"),
        ("BAN611", "Machine Learning for Managers", 4, E, "Project", "Business Analytics", "F013"),
        ("BAN612", "Business Intelligence with Power BI", 4, E, "Workshop", "Business Analytics", "F006")],
}
TRACKS = ["Marketing", "Finance", "Human Resources", "Business Analytics"]

# Subject areas, and the area of every subject. Operations, internship, simulation and capstone count
# as Strategy (general management); law, communication, languages and ethics as Social Science.
SUBJECT_AREAS = ["Finance & Accounting", "Economics", "Marketing", "HR & OB", "Information Systems", "Analytics",
                 "Strategy", "Social Science"]
FA, EC, MK, HR, IS, AN, ST, SS = SUBJECT_AREAS
AREA = {
    "BBA101": ST, "BBA102": EC, "BBA103": FA, "BBA104": AN, "BBA105": SS, "BBA106": IS, "BBA107": SS,
    "BBA201": HR, "BBA202": EC, "BBA203": FA, "BBA204": AN, "BBA205": EC, "BBA206": ST, "BBA207": SS,
    "BBA301": MK, "BBA302": FA, "BBA303": HR, "BBA304": SS, "BBA305": AN, "BBA306": HR,
    "BBA3E1": SS, "BBA3E2": SS, "BBA3E3": SS,
    "BBA401": ST, "BBA402": AN, "BBA403": MK, "BBA404": ST, "BBA405": FA, "BBA406": ST,
    "BBA4E1": MK, "BBA4E2": SS, "BBA4E3": EC,
    "BBA501": ST, "BBA502": SS, "BBA503": ST, "BBA504": HR,
    "MKT511": MK, "MKT512": MK, "FIN511": FA, "FIN512": FA, "HRM511": HR, "HRM512": HR, "BAN511": AN, "BAN512": AN,
    "BBA601": ST, "BBA602": FA, "BBA603": ST, "BBA604": HR,
    "MKT611": MK, "MKT612": MK, "FIN611": FA, "FIN612": FA, "HRM611": HR, "HRM612": HR, "BAN611": AN, "BAN612": IS,
}
assert set(AREA) == {r[0] for rows in CURRICULUM.values() for r in rows}, "every subject needs exactly one area"


def sem_credits(sem):
    """Credits a student earns in a semester: all core, one open elective, two subjects of one track."""
    rows = CURRICULUM[sem]
    core = sum(r[2] for r in rows if r[3] == C)
    if sem in (3, 4):
        return core + 2
    if sem in (5, 6):
        return core + 8
    return core


TOTAL_CREDITS = sum(sem_credits(s) for s in CURRICULUM)

curriculum_rows = []
for sem, rows in CURRICULUM.items():
    for code, name, cr, typ, assess, track, fid in rows:
        curriculum_rows.append({
            "Academic Year": AY, "Programme Year": f"Year {(sem + 1) // 2}", "Semester": sem,
            "Subject Code": code, "Subject": name, "Subject Area": AREA[code], "Credits": cr, **teaching(cr),
            "Number of Sections": None,  # filled in once Faculty Utilization is built
            "Type": typ,
            "Elective Group": track or "-", "Assessment": assess, "Evaluation Weighting": WEIGHTING[assess],
            "Faculty ID": fid,
        })

# ------------------------------------------------------------------ faculty

FACULTY = [
    # id, name, designation, area, qualification, years, admin role, gender
    ("F001", "Prof. (Dr.) Meera Raghavan", "Dean & Professor", "Strategy", "PhD, Strategic Management", 26, "Dean, School of Business"),
    ("F002", "Dr. Arvind Kulkarni", "Professor", "Finance & Accounting", "PhD, Finance; CFA charterholder", 21, "Programme Director, BBA"),
    ("F003", "Dr. Sunita Menon", "Associate Professor", "Marketing", "PhD, Marketing", 16, "-"),
    ("F004", "Dr. Rahul Bhattacharya", "Associate Professor", "Economics", "PhD, Economics", 15, "-"),
    ("F005", "Dr. Farah Siddiqui", "Associate Professor", "HR & Organisational Behaviour", "PhD, Organisational Psychology", 14, "Student Welfare & Parent Liaison"),
    ("F006", "Prof. Karthik Subramanian", "Assistant Professor", "Business Analytics", "MTech (Data Science); PhD pursuing", 9, "-"),
    ("F007", "Dr. Neha Agarwal", "Assistant Professor", "Finance & Accounting", "PhD, Accounting; CA", 10, "Year 2 Coordinator"),
    ("F008", "Prof. Joseph Varghese", "Assistant Professor", "Operations & Supply Chain", "MBA (Operations); ex-logistics manager", 12, "-"),
    ("F009", "Dr. Priya Hegde", "Associate Professor", "Marketing", "PhD, Consumer Behaviour", 13, "Year 3 Coordinator"),
    ("F010", "Adv. Rohit Malhotra", "Visiting Faculty", "Business Law", "LLM, Corporate Law; practising advocate", 18, "-"),
    ("F011", "Dr. Lakshmi Narayanan", "Assistant Professor", "Communication", "PhD, English & Business Communication", 11, "Year 1 Coordinator"),
    ("F012", "Prof. Ankit Shah", "Professor of Practice", "Entrepreneurship", "MBA; founder of two start-ups", 19, "Internship & Placement Coordinator"),
    ("F013", "Dr. Kavya Reddy", "Assistant Professor", "Quantitative Methods", "PhD, Statistics", 8, "-"),
    ("F014", "Dr. Sanjay Deshmukh", "Associate Professor", "Finance & Accounting", "PhD, Taxation; CA", 17, "Controller of Examinations"),
    ("F015", "Ms. Anna Fischer", "Visiting Faculty", "Foreign Languages", "MA, German Studies; Goethe-certified trainer", 7, "-"),
    ("F016", "Dr. Imran Qureshi", "Assistant Professor", "Economics", "PhD, Behavioural Economics", 7, "-"),
    ("F017", "Dr. Pooja Iyer", "Assistant Professor", "HR & Organisational Behaviour", "PhD, Human Resource Management", 9, "-"),
    ("F018", "Prof. Vikram Rathore", "Professor of Practice", "Strategy & International Business", "MBA; former country head, FMCG", 24, "-"),
    ("F019", "Dr. Nandini Das", "Assistant Professor", "Sustainability & Ethics", "PhD, Environmental Economics", 8, "-"),
    ("F020", "Mr. Aditya Kapoor", "Visiting Faculty", "Digital Marketing & Analytics", "MBA; Head of Analytics at a retail firm", 12, "-"),
]
FAC = {f[0]: f for f in FACULTY}

# Each professor's area, on the same eight subject areas as the curriculum, chosen by what they mostly
# teach. Their own specialism (above) is kept as a separate column.
FACULTY_AREA = {
    "F001": ST, "F002": FA, "F003": MK, "F004": EC, "F005": HR, "F006": AN, "F007": FA, "F008": ST, "F009": MK, "F010": SS,
    "F011": SS, "F012": ST, "F013": AN, "F014": FA, "F015": SS, "F016": EC, "F017": HR, "F018": ST, "F019": SS, "F020": MK,
}
assert set(FACULTY_AREA) == set(FAC) and set(FACULTY_AREA.values()) <= set(SUBJECT_AREAS)


def email_of(name):
    parts = [p for p in name.replace("(Dr.)", "").replace(".", "").split() if p not in ("Prof", "Dr", "Adv", "Ms", "Mr")]
    return f"{parts[0].lower()}.{parts[-1].lower()}@elogic.example.edu"


# Faculty Master: one row per professor. What each one teaches is in Faculty Utilization (built below,
# once student enrolments are known), linked by Faculty ID.
faculty_rows = [{
    "Faculty ID": f[0], "Prof Name": f[1], "Designation": f[2], "Area": FACULTY_AREA[f[0]], "Specialism": f[3], "Qualification": f[4],
    "Experience (years)": f[5], "Administrative Role": f[6], "Email": email_of(f[1]),
} for f in FACULTY]

# ------------------------------------------------------------------ students

STATES = [  # state, weight, cities, surnames
    ("Karnataka", 30, ["Bengaluru", "Mysuru", "Mangaluru", "Hubballi", "Udupi"], ["Gowda", "Hegde", "Shetty", "Rao", "Nayak", "Bhat"]),
    ("Tamil Nadu", 10, ["Chennai", "Coimbatore", "Madurai"], ["Iyer", "Subramanian", "Krishnan", "Raman"]),
    ("Kerala", 10, ["Kochi", "Thiruvananthapuram", "Kozhikode"], ["Nair", "Menon", "Pillai", "Thomas", "Varghese"]),
    ("Maharashtra", 9, ["Mumbai", "Pune", "Nagpur"], ["Patil", "Deshpande", "Joshi", "Pawar"]),
    ("Telangana", 7, ["Hyderabad", "Warangal"], ["Reddy", "Rao", "Goud"]),
    ("Andhra Pradesh", 5, ["Visakhapatnam", "Vijayawada"], ["Naidu", "Reddy", "Chowdary"]),
    ("Delhi", 6, ["New Delhi"], ["Sharma", "Gupta", "Arora", "Malhotra"]),
    ("Uttar Pradesh", 5, ["Lucknow", "Noida", "Kanpur"], ["Verma", "Srivastava", "Mishra", "Tripathi"]),
    ("Gujarat", 5, ["Ahmedabad", "Surat", "Vadodara"], ["Patel", "Shah", "Mehta", "Desai"]),
    ("West Bengal", 4, ["Kolkata", "Siliguri"], ["Banerjee", "Chatterjee", "Ghosh", "Das"]),
    ("Rajasthan", 3, ["Jaipur", "Udaipur"], ["Rathore", "Jain", "Choudhary"]),
    ("Bihar", 2, ["Patna"], ["Sinha", "Prasad", "Jha"]),
    ("Odisha", 2, ["Bhubaneswar"], ["Mohanty", "Patnaik"]),
    ("Punjab", 1, ["Ludhiana", "Amritsar"], ["Gill", "Sandhu", "Singh"]),
    ("Assam", 1, ["Guwahati"], ["Baruah", "Bora"]),
]
MALE = ["Aarav", "Vihaan", "Arjun", "Aditya", "Rohan", "Karthik", "Siddharth", "Ishaan", "Kabir", "Nikhil", "Pranav",
        "Rahul", "Varun", "Yash", "Aniket", "Dhruv", "Harsh", "Manav", "Rishi", "Tejas", "Abhinav", "Omkar", "Sahil", "Vivek", "Neil"]
FEMALE = ["Ananya", "Diya", "Aditi", "Isha", "Kavya", "Meera", "Nandini", "Pooja", "Riya", "Sneha", "Tanvi", "Shreya",
          "Aishwarya", "Lavanya", "Priya", "Sanya", "Trisha", "Divya", "Gauri", "Navya", "Ira", "Keerthana", "Mahima", "Rhea"]
FATHERS = ["Rajesh", "Suresh", "Ramesh", "Mahesh", "Anil", "Sunil", "Vijay", "Sanjay", "Prakash", "Manoj", "Ashok", "Girish",
           "Venkatesh", "Srinivas", "Harish", "Deepak", "Rakesh", "Mohan"]
MOTHERS = ["Lakshmi", "Sunita", "Kavita", "Anita", "Rekha", "Geeta", "Meena", "Shobha", "Usha", "Asha", "Radha", "Vandana",
           "Sujata", "Padma"]
UNCLES = ["Ravi", "Satish", "Naveen", "Kiran", "Ajay"]
OCCUPATIONS = ["Business owner", "Software engineer", "Government officer", "Doctor", "School teacher", "Bank manager",
               "Chartered accountant", "Farmer", "Lawyer", "Army officer", "Architect", "Retail trader", "Civil engineer",
               "Professor", "Pharmacist", "Sales manager"]
CATEGORIES = [("General", 50), ("OBC", 25), ("EWS", 8), ("SC", 9), ("ST", 3), ("NRI", 5)]
ROUTES = [("E-LAT entrance test", 70), ("Merit (Class XII score)", 22), ("Sports quota", 4), ("NRI quota", 4)]
SCHOLARSHIPS = [("None", 70), ("Merit - 25% tuition", 12), ("Merit - 50% tuition", 5), ("Need-based - 30% tuition", 9), ("Sports - 20% tuition", 4)]
MENTORS = ["F003", "F004", "F005", "F006", "F007", "F008", "F009", "F011", "F013", "F014", "F016", "F017"]

pick = lambda pairs: random.choices([p[0] for p in pairs], [p[1] for p in pairs])[0]
BATCHES = [  # batch year, current programme year, current semester
    (2024, 3, 5), (2025, 2, 3), (2026, 1, 1),
]
OE1 = [r[1] for r in CURRICULUM[3] if r[3] == E]
OE2 = [r[1] for r in CURRICULUM[4] if r[3] == E]

student_rows = []
used_names = set()
mentor_cycle = 0
for batch, year, sem in BATCHES:
    tracks = ["Marketing"] * 12 + ["Finance"] * 12 + ["Human Resources"] * 6 + ["Business Analytics"] * 10
    random.shuffle(tracks)
    for i in range(40):
        st = random.choices(STATES, [s[1] for s in STATES])[0]
        state, cities, surnames = st[0], st[2], st[3]
        gender = "Female" if random.random() < 0.48 else "Male"
        while True:
            first = random.choice(FEMALE if gender == "Female" else MALE)
            surname = random.choice(surnames)
            if (first, surname) not in used_names:
                used_names.add((first, surname))
                break
        rel = random.choices(["Father", "Mother", "Guardian (Uncle)"], [60, 35, 5])[0]
        parent_first = random.choice(FATHERS if rel == "Father" else MOTHERS if rel == "Mother" else UNCLES)
        parent = f"{'Mr.' if rel != 'Mother' else 'Mrs.'} {parent_first} {surname}"
        dob = date(batch - 18, 1, 1) + timedelta(days=random.randint(-200, 420))
        # Admissions run from June to the week after orientation (20 July).
        admitted = date(batch, 6, 2) + timedelta(days=random.randint(0, 54))
        category = pick(CATEGORIES)
        route = "NRI quota" if category == "NRI" else pick([r for r in ROUTES if r[0] != "NRI quota"])
        out_of_state = state != "Karnataka"
        hostel = "Yes" if random.random() < (0.85 if out_of_state else 0.25) else "No"
        scholarship = "Sports - 20% tuition" if route == "Sports quota" else pick(SCHOLARSHIPS[:4])
        cgpa = None if sem == 1 else round(min(9.8, max(5.2, random.gauss(7.45, 0.85))), 2)
        attendance = round(min(100, max(58, random.gauss(86, 7.5))), 1)
        fee = random.choices(["Paid", "Partially paid", "Due"], [85, 10, 5])[0]
        mentor = FAC[MENTORS[mentor_cycle % len(MENTORS)]]
        mentor_cycle += 1 if i % 10 == 9 else 0
        sid = f"EL{batch % 100}BBA{i + 1:03d}"
        student_rows.append({
            "Student ID": sid, "Student Name": f"{first} {surname}", "Gender": gender,
            "Date of Birth": dob.isoformat(), "Batch": f"{batch}-{(batch + 3) % 100:02d}",
            "Date of Admission": admitted.isoformat(), "Current Year": f"Year {year}", "Current Semester": sem,
            "Section": "A" if i < 20 else "B",
            "Specialisation": tracks[i] if year == 3 else "Chosen at end of Year 2",
            "Open Elective I (Sem 3)": random.choice(OE1) if year >= 2 else "-",
            "Open Elective II (Sem 4)": random.choice(OE2) if year == 3 else "-",
            "Home State": state, "Home City": random.choice(cities),
            "Parent / Guardian": parent, "Relationship": rel, "Parent Occupation": random.choice(OCCUPATIONS),
            "Parent Mobile": f"+91 9{random.randint(0, 9)}{random.randint(100, 999)} {random.randint(10000, 99999)}",
            "Parent Email": f"{parent_first.lower()}.{surname.lower()}{random.randint(1, 99)}@mail.example.com",
            "Admission Category": category, "Admission Route": route, "Hostel Resident": hostel,
            "Scholarship": scholarship, "CGPA": cgpa if cgpa is not None else "Not yet graded",
            "Attendance % (current sem)": attendance, "Fee Status": fee,
            "Faculty Mentor": mentor[1], "Mentor ID": mentor[0],
        })

# Year 2 students register their Semester 4 open elective in advance. A separate generator, so every
# other student value stays exactly as before.
prereg = random.Random(4)
for st in student_rows:
    if st["Current Year"] == "Year 2":
        st["Open Elective II (Sem 4)"] = prereg.choice(OE2)

# ------------------------------------------------------------------ faculty utilization

# One row per section taught in 2026-27. Each section is taught (and its credits, sessions and faculty
# credit hours consumed) separately, so a subject with two sections uses twice as much faculty time. Core subjects
# run in the batch's own sections; an elective runs only if someone enrolled, in sections of up to 20.
SECTION_CAP = 20
BATCH_OF_SEM = {1: "2026-29", 2: "2026-29", 3: "2025-28", 4: "2025-28", 5: "2024-27", 6: "2024-27"}


def enrolled(r, batch_students):
    if r["Type"] == C:
        return None
    if r["Elective Group"] == "Open Elective I":
        return [st for st in batch_students if st["Open Elective I (Sem 3)"] == r["Subject"]]
    if r["Elective Group"] == "Open Elective II":
        return [st for st in batch_students if st["Open Elective II (Sem 4)"] == r["Subject"]]
    return [st for st in batch_students if st["Specialisation"] == r["Elective Group"]]


utilization_rows = []
not_offered = []
for r in curriculum_rows:
    sem = r["Semester"]
    batch = BATCH_OF_SEM[sem]
    batch_students = [st for st in student_rows if st["Batch"] == batch]
    takers = enrolled(r, batch_students)
    if takers is None:  # core: the batch's sections
        sections = [(sec, sum(1 for st in batch_students if st["Section"] == sec)) for sec in ("A", "B")]
    elif not takers:
        not_offered.append(r["Subject Code"])
        continue
    else:  # elective: as few sections of up to 20 as possible, sized evenly
        k = -(-len(takers) // SECTION_CAP)
        sizes = [len(takers) // k + (1 if i < len(takers) % k else 0) for i in range(k)]
        sections = [(chr(65 + i), n) for i, n in enumerate(sizes)]
    f = FAC[r["Faculty ID"]]
    for sec, n in sections:
        utilization_rows.append({
            "Academic Year": AY, "Term": TERM[sem], "Semester": sem, "Batch": batch,
            "Subject Code": r["Subject Code"], "Subject": r["Subject"], "Subject Area": r["Subject Area"], "Type": r["Type"],
            "Faculty ID": f[0], "Prof Name": f[1], "Section": sec, "Number of Sections": len(sections), "Students": n,
            "Credits": r["Credits"], **teaching(r["Credits"]),
            "Status": "Ongoing" if sem % 2 else "Upcoming",
        })

section_count = Counter(u["Subject Code"] for u in utilization_rows)
for r in curriculum_rows:
    r["Number of Sections"] = section_count[r["Subject Code"]]

# Faculty Master: each professor's faculty credit hours for the year, the goal, and how much of it is used.
for row in faculty_rows:
    fch = sum(u["Faculty Credit Hours"] for u in utilization_rows if u["Faculty ID"] == row["Faculty ID"])
    row.update({"Faculty Credit Hours": fch, "Goal (Faculty Credit Hours)": FACULTY_GOAL,
                "Utilization %": num(round(fch / FACULTY_GOAL * 100, 1))})

# ------------------------------------------------------------------ Excel workbook

ORANGE, NAVY = "#E35A1B", "#16233F"
ASSUMPTIONS = [  # name, label, value, note
    ("SessionsPerCredit", "Sessions per credit", SESSIONS_PER_CREDIT, "Same for every subject (exam, workshop or project)"),
    ("MinutesPerSession", "Minutes per session", MINUTES_PER_SESSION, "Length of one class session"),
    ("FacultyCreditHoursPerCredit", "Faculty credit hours per credit", FCH_PER_CREDIT,
     "Faculty workload per credit taught, per section (teaching plus preparation and assessment)"),
    ("FacultyGoal", "Faculty goal (faculty credit hours per academic year)", FACULTY_GOAL, "Same for every faculty member"),
]
SHEETS = {"Curriculum Master": curriculum_rows, "Student Master": student_rows, "Faculty Master": faculty_rows,
          "Faculty Utilization": utilization_rows}


def ref(sheet, header, absolute=True):
    """Column range of a sheet's data, e.g. 'Faculty Utilization'!$E$2:$E$91."""
    rows = SHEETS[sheet]
    c = xl_col_to_name(list(rows[0]).index(header))
    return f"'{sheet}'!${c}$2:${c}${len(rows) + 1}"


def cell(sheet, header, n):
    return f"{xl_col_to_name(list(SHEETS[sheet][0]).index(header))}{n}"


def lookup(target_sheet, key_header, value_header, key_cell):
    return f"INDEX({ref(target_sheet, value_header)},MATCH({key_cell},{ref(target_sheet, key_header)},0))"


def teaching_formulas(sheet):
    """Formulas for the five teaching-time columns, shared by Curriculum Master and Faculty Utilization."""
    c = lambda h, n: cell(sheet, h, n)
    return {
        "Number of Sessions": lambda n, r: f"={c('Credits', n)}*SessionsPerCredit",
        "Minutes per Session": lambda n, r: "=MinutesPerSession",
        "Total Minutes Taught": lambda n, r: f"={c('Number of Sessions', n)}*{c('Minutes per Session', n)}",
        "Hours Taught": lambda n, r: f"={c('Total Minutes Taught', n)}/60",
        "Faculty Credit Hours": lambda n, r: f"={c('Credits', n)}*FacultyCreditHoursPerCredit",
    }


def students_formula(n, r):
    """Students in this section, counted from the Student Master. Electives split their enrolment evenly."""
    u = lambda h: cell("Faculty Utilization", h, n)
    batch = f"{ref('Student Master', 'Batch')},{u('Batch')}"
    if r["Type"] == C:
        return f"=COUNTIFS({batch},{ref('Student Master', 'Section')},{u('Section')})"
    group = next(c["Elective Group"] for c in curriculum_rows if c["Subject Code"] == r["Subject Code"])
    column = {"Open Elective I": "Open Elective I (Sem 3)", "Open Elective II": "Open Elective II (Sem 4)"}.get(group, "Specialisation")
    match = u("Subject") if column != "Specialisation" else lookup("Curriculum Master", "Subject Code", "Elective Group", u("Subject Code"))
    total = f"COUNTIFS({batch},{ref('Student Master', column)},{match})"
    k = u("Number of Sections")
    return f"=INT({total}/{k})+IF(CODE({u('Section')})-64<=MOD({total},{k}),1,0)"


FORMULAS = {
    "Curriculum Master": {
        **teaching_formulas("Curriculum Master"),
        "Number of Sections": lambda n, r: f"=COUNTIF({ref('Faculty Utilization', 'Subject Code')},{cell('Curriculum Master', 'Subject Code', n)})",
    },
    "Student Master": {
        "Faculty Mentor": lambda n, r: "=" + lookup("Faculty Master", "Faculty ID", "Prof Name", cell("Student Master", "Mentor ID", n)),
    },
    "Faculty Master": {
        "Faculty Credit Hours": lambda n, r: f"=SUMIF({ref('Faculty Utilization', 'Faculty ID')},{cell('Faculty Master', 'Faculty ID', n)},"
                                             f"{ref('Faculty Utilization', 'Faculty Credit Hours')})",
        "Goal (Faculty Credit Hours)": lambda n, r: "=FacultyGoal",
        "Utilization %": lambda n, r: f"=ROUND({cell('Faculty Master', 'Faculty Credit Hours', n)}/"
                                      f"{cell('Faculty Master', 'Goal (Faculty Credit Hours)', n)}*100,1)",
    },
    # Every Faculty Utilization column is a formula except its two inputs, Subject Code and Section.
    "Faculty Utilization": {
        **{h: (lambda h: lambda n, r: "=" + lookup("Curriculum Master", "Subject Code", h, cell("Faculty Utilization", "Subject Code", n)))(h)
           for h in ("Academic Year", "Semester", "Subject", "Subject Area", "Type", "Credits", "Faculty ID")},
        "Term": lambda n, r: (lambda ay, sem: f'=IF(MOD({sem},2)=1,"Odd (Jul-Nov "&LEFT({ay},4)&")","Even (Jan-Apr "&(LEFT({ay},4)+1)&")")')(
            cell("Faculty Utilization", "Academic Year", n), cell("Faculty Utilization", "Semester", n)),
        # The batch in a semester started (semester - 1) / 2 years before this academic year, e.g. Semester 5 in 2026-27 -> 2024-27.
        "Batch": lambda n, r: (lambda ay, sem: f'=(LEFT({ay},4)-INT(({sem}-1)/2))&"-"&RIGHT(LEFT({ay},4)-INT(({sem}-1)/2)+3,2)')(
            cell("Faculty Utilization", "Academic Year", n), cell("Faculty Utilization", "Semester", n)),
        "Status": lambda n, r: f'=IF(MOD({cell("Faculty Utilization", "Semester", n)},2)=1,"Ongoing","Upcoming")',
        "Prof Name": lambda n, r: "=" + lookup("Faculty Master", "Faculty ID", "Prof Name", cell("Faculty Utilization", "Faculty ID", n)),
        "Number of Sections": lambda n, r: f"=COUNTIF({ref('Faculty Utilization', 'Subject Code')},{cell('Faculty Utilization', 'Subject Code', n)})",
        "Students": students_formula,
        **teaching_formulas("Faculty Utilization"),
    },
}

wb = xlsxwriter.Workbook(str(MASTERS))
head = wb.add_format({"bold": True, "font_color": "#FFFFFF", "bg_color": NAVY, "valign": "vcenter", "text_wrap": True, "border": 0})
body_fmt = wb.add_format({"valign": "top", "bottom": 1, "bottom_color": "#D9D9D9"})
calc_fmt = wb.add_format({"valign": "top", "bottom": 1, "bottom_color": "#D9D9D9", "bg_color": "#FDF1EA"})
note_fmt = wb.add_format({"italic": True, "font_color": "#5B6170"})


def write_sheet(name, rows, formulas):
    ws = wb.add_worksheet(name)
    headers = list(rows[0])
    ws.write_row(0, 0, headers, head)
    ws.set_row(0, 32)
    for i, r in enumerate(rows):
        n = i + 2  # Excel row number
        for j, h in enumerate(headers):
            if h in formulas:  # formula, saved with its result so readers without a calculator see the value
                ws.write_formula(i + 1, j, formulas[h](n, r), calc_fmt, r[h])
            else:
                ws.write(i + 1, j, r[h], body_fmt)
    for j, h in enumerate(headers):
        longest = max(len(str(h)), *(len(str(r[h])) for r in rows))
        ws.set_column(j, j, min(48, max(10, longest + 2)))
    ws.freeze_panes(1, 1)
    ws.autofilter(0, 0, len(rows), len(headers) - 1)
    ws.set_tab_color(ORANGE)


for name, rows in SHEETS.items():
    write_sheet(name, rows, FORMULAS.get(name, {}))

ws = wb.add_worksheet("Assumptions")
ws.write_row(0, 0, ["Parameter", "Value", "Notes"], head)
for i, (key, label, value, note) in enumerate(ASSUMPTIONS):
    ws.write_row(i + 1, 0, [label, value, note], body_fmt)
    wb.define_name(key, f"=Assumptions!$B${i + 2}")
ws.write_formula(len(ASSUMPTIONS) + 1, 0, '="Hours taught per credit"', body_fmt, "Hours taught per credit")
ws.write_formula(len(ASSUMPTIONS) + 1, 1, "=SessionsPerCredit*MinutesPerSession/60", calc_fmt,
                 num(SESSIONS_PER_CREDIT * MINUTES_PER_SESSION / 60))
ws.write(len(ASSUMPTIONS) + 1, 2, "Calculated: sessions per credit x minutes per session / 60", body_fmt)
ws.write(len(ASSUMPTIONS) + 3, 0, "Shaded cells in every sheet are formulas. Change a value here and the workbook recalculates.", note_fmt)
ws.set_column(0, 0, 50)
ws.set_column(1, 1, 10)
ws.set_column(2, 2, 80)
ws.set_tab_color(NAVY)
wb.close()

# ------------------------------------------------------------------ handbook PDF

pdfmetrics.registerFont(TTFont("DejaVu", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("DejaVu-Bold", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"))
pdfmetrics.registerFont(TTFont("DejaVu-Oblique", "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"))
pdfmetrics.registerFont(TTFont("Serif-Bold", "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"))
from reportlab.pdfbase.pdfmetrics import registerFontFamily  # noqa: E402

registerFontFamily("DejaVu", normal="DejaVu", bold="DejaVu-Bold", italic="DejaVu-Oblique", boldItalic="DejaVu-Bold")

C_ORANGE = colors.HexColor("#E35A1B")
C_NAVY = colors.HexColor("#16233F")
C_INK = colors.HexColor("#25282E")
C_MUTED = colors.HexColor("#5B6170")
C_TINT = colors.HexColor("#FDF1EA")
C_LINE = colors.HexColor("#E3E5EA")

body = ParagraphStyle("body", fontName="DejaVu", fontSize=9.2, leading=13.4, textColor=C_INK, spaceAfter=5)
small = ParagraphStyle("small", parent=body, fontSize=8, leading=11, spaceAfter=0)
cell = ParagraphStyle("cell", parent=body, fontSize=7.9, leading=10.2, spaceAfter=0)
cellb = ParagraphStyle("cellb", parent=cell, fontName="DejaVu-Bold")
cellh = ParagraphStyle("cellh", parent=cell, fontName="DejaVu-Bold", textColor=colors.white)
kicker = ParagraphStyle("kicker", parent=body, fontName="DejaVu-Bold", fontSize=8, textColor=C_ORANGE, spaceAfter=2,
                        leading=10)
h1 = ParagraphStyle("h1", parent=body, fontName="Serif-Bold", fontSize=21, leading=25, textColor=C_NAVY, spaceAfter=8)
h2 = ParagraphStyle("h2", parent=body, fontName="DejaVu-Bold", fontSize=11.2, leading=14, textColor=C_NAVY,
                    spaceBefore=7, spaceAfter=4)
bullet = ParagraphStyle("bullet", parent=body, leftIndent=11, bulletIndent=1, spaceAfter=2.5)
quote = ParagraphStyle("quote", parent=body, fontName="DejaVu-Oblique", fontSize=10, leading=15, textColor=C_NAVY)

PAGE_W, PAGE_H = A4
MARGIN = 18 * mm
CONTENT_W = PAGE_W - 2 * MARGIN


def logo(c, x, y, size, on_dark=False):
    """The E-Logic mark: an orange rounded square with three bars forming an E, and a node dot."""
    c.saveState()
    c.setFillColor(C_ORANGE)
    c.roundRect(x, y, size, size, size * 0.18, stroke=0, fill=1)
    c.setFillColor(colors.white)
    bar_h = size * 0.12
    for k, w in enumerate((0.56, 0.40, 0.56)):
        c.rect(x + size * 0.2, y + size * (0.70 - k * 0.25), size * w, bar_h, stroke=0, fill=1)
    c.circle(x + size * 0.76, y + size * 0.51, size * 0.07, stroke=0, fill=1)
    c.restoreState()


def cover(c, doc):
    c.saveState()
    c.setFillColor(C_NAVY)
    c.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    # Diagonal orange band and a grid of fine dots, echoing the website hero.
    c.setFillColor(C_ORANGE)
    p = c.beginPath()
    p.moveTo(0, PAGE_H * 0.36)
    p.lineTo(PAGE_W, PAGE_H * 0.50)
    p.lineTo(PAGE_W, PAGE_H * 0.43)
    p.lineTo(0, PAGE_H * 0.29)
    p.close()
    c.drawPath(p, stroke=0, fill=1)
    c.setFillColor(colors.HexColor("#2A3A5E"))
    for gx in range(12):
        for gy in range(8):
            c.circle(PAGE_W - 30 * mm - gx * 6 * mm, PAGE_H - 30 * mm - gy * 6 * mm, 0.9, stroke=0, fill=1)
    logo(c, MARGIN, PAGE_H - 40 * mm, 16 * mm)
    c.setFillColor(colors.white)
    c.setFont("DejaVu-Bold", 15)
    c.drawString(MARGIN + 20 * mm, PAGE_H - 30 * mm, "E-Logic")
    c.setFont("DejaVu", 9)
    c.setFillColor(colors.HexColor("#B8C1D6"))
    c.drawString(MARGIN + 20 * mm, PAGE_H - 35.5 * mm, "SCHOOL OF BUSINESS  ·  BENGALURU")
    c.setFillColor(C_ORANGE)
    c.setFont("DejaVu-Bold", 10)
    c.drawString(MARGIN, PAGE_H * 0.70, "STUDENT HANDBOOK  ·  ACADEMIC YEAR 2026-27")
    c.setFillColor(colors.white)
    c.setFont("Serif-Bold", 33)
    c.drawString(MARGIN, PAGE_H * 0.70 - 18 * mm, "Bachelor of")
    c.drawString(MARGIN, PAGE_H * 0.70 - 33 * mm, "Business Administration")
    c.setFont("DejaVu", 12)
    c.setFillColor(colors.HexColor("#D5DBE8"))
    c.drawString(MARGIN, PAGE_H * 0.70 - 45 * mm, "BBA  ·  3 years  ·  6 semesters  ·  132 credits")
    c.setFont("DejaVu", 9.5)
    lines = ["For students, parents and guardians, faculty and academic leadership.",
             "Programme overview · Pedagogy · Subjects · Assessment · Outcomes · Calendar"]
    for k, line in enumerate(lines):
        c.drawString(MARGIN, 34 * mm - k * 5.5 * mm, line)
    c.setFillColor(colors.HexColor("#8E9AB5"))
    c.setFont("DejaVu", 7.5)
    c.drawString(MARGIN, 14 * mm, "Mock-up for demonstration. E-Logic School of Business, its people and all figures are fictitious.")
    c.restoreState()


def page_chrome(c, doc):
    c.saveState()
    c.setFillColor(C_NAVY)
    c.rect(0, PAGE_H - 13 * mm, PAGE_W, 13 * mm, stroke=0, fill=1)
    c.setFillColor(C_ORANGE)
    c.rect(0, PAGE_H - 14.2 * mm, PAGE_W, 1.2 * mm, stroke=0, fill=1)
    logo(c, MARGIN, PAGE_H - 10.5 * mm, 8 * mm)
    c.setFillColor(colors.white)
    c.setFont("DejaVu-Bold", 9)
    c.drawString(MARGIN + 11 * mm, PAGE_H - 7.8 * mm, "E-Logic School of Business")
    c.setFont("DejaVu", 8)
    c.setFillColor(colors.HexColor("#B8C1D6"))
    c.drawRightString(PAGE_W - MARGIN, PAGE_H - 7.8 * mm, "BBA Student Handbook 2026-27")
    c.setStrokeColor(C_LINE)
    c.setLineWidth(0.6)
    c.line(MARGIN, 14 * mm, PAGE_W - MARGIN, 14 * mm)
    c.setFillColor(C_MUTED)
    c.setFont("DejaVu", 7.2)
    c.drawString(MARGIN, 9.5 * mm, "Fictitious institution · demonstration mock-up")
    c.drawRightString(PAGE_W - MARGIN, 9.5 * mm, f"Page {doc.page} of 10")
    c.restoreState()


def table(data, widths, header=True, zebra=True, font=cell, pad=3.2, head=None):
    rows = []
    for i, r in enumerate(data):
        style = (head or cellh) if header and i == 0 else font
        rows.append([x if not isinstance(x, str) else Paragraph(x, style) for x in r])
    t = Table(rows, colWidths=widths, repeatRows=1 if header else 0)
    st = [("VALIGN", (0, 0), (-1, -1), "TOP"),
          ("TOPPADDING", (0, 0), (-1, -1), pad), ("BOTTOMPADDING", (0, 0), (-1, -1), pad),
          ("LEFTPADDING", (0, 0), (-1, -1), 4.5), ("RIGHTPADDING", (0, 0), (-1, -1), 4.5),
          ("LINEBELOW", (0, 0), (-1, -1), 0.4, C_LINE)]
    if header:
        st.append(("BACKGROUND", (0, 0), (-1, 0), C_NAVY))
    if zebra:
        for i in range(1 if header else 0, len(rows)):
            if i % 2 == 0:
                st.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#F7F8FA")))
    t.setStyle(TableStyle(st))
    return t


def callout(paras, bg=C_TINT, bar=C_ORANGE):
    t = Table([[paras]], colWidths=[CONTENT_W])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), bg), ("LINEBEFORE", (0, 0), (0, -1), 3, bar),
                           ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                           ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7)]))
    return t


def stat_strip(items):
    cells = [[Paragraph(f'<font name="Serif-Bold" size="17" color="#E35A1B">{v}</font><br/>'
                        f'<font size="7.4" color="#5B6170">{k}</font>', ParagraphStyle("s", parent=small, leading=13))
              for v, k in items]]
    t = Table(cells, colWidths=[CONTENT_W / len(items)] * len(items))
    t.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.6, C_LINE), ("INNERGRID", (0, 0), (-1, -1), 0.6, C_LINE),
                           ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                           ("LEFTPADDING", (0, 0), (-1, -1), 8)]))
    return t


def P(text, style=body):
    return Paragraph(text, style)


def bullets(items, style=bullet):
    return [Paragraph(x, style, bulletText="•") for x in items]


def heading(k, title):
    return [P(k.upper(), kicker), P(title, h1)]


story = [NextPageTemplate("inner"), PageBreak()]

# Page 2: welcome + about
story += heading("Welcome", "A message from the Dean")
story += [
    P("Dear students, parents and colleagues,"),
    P("Welcome to the Bachelor of Business Administration at E-Logic School of Business. Over the next three years, "
      "our students will learn how organisations create value, how markets behave, how money moves through a business, "
      "and how people are led. More importantly, they will learn by <b>doing</b>: running simulated companies, "
      "consulting for real start-ups in Bengaluru, and presenting to industry juries."),
    P("This handbook is your reference for the 2026-27 academic year. It explains how the programme is structured, how "
      "each subject is taught and assessed, what we expect of students, and how parents can stay closely involved. "
      "Please keep it handy and reach out to your faculty mentor whenever you need help."),
    P("I look forward to meeting every one of you at the Parent-Teacher Meeting and across campus."),
    P("<b>Prof. (Dr.) Meera Raghavan</b><br/>Dean, E-Logic School of Business", body),
    Spacer(1, 6),
    P("About E-Logic School of Business", h2),
    P("E-Logic School of Business is the management school of E-Logic University, Bengaluru, founded in 2009. The school "
      "offers the BBA, an MBA and doctoral programmes, and works closely with more than 140 partner companies for "
      "internships, live projects and placements. The BBA admits 40 students a year in two sections of 20, which keeps "
      "classes small enough for discussion-led teaching."),
    Spacer(1, 4),
    stat_strip([("40", "students per batch"), ("20", "faculty members"), ("1 : 6", "faculty-student ratio"),
                ("140+", "partner companies"), ("94%", "placed or in higher study, 2026")]),
    Spacer(1, 10),
    P("Vision and mission", h2),
    callout([P("<b>Vision.</b> To be India's most hands-on undergraduate business school, where every graduate has "
               "already solved a real business problem before they leave campus.", body),
             P("<b>Mission.</b> To combine rigorous business fundamentals with experiential learning, ethical "
               "leadership and digital fluency, in close partnership with industry, parents and the community.",
               ParagraphStyle("m", parent=body, spaceAfter=0))]),
    PageBreak(),
]

# Page 3: programme overview
story += heading("Programme overview", "The BBA at a glance")
story += [
    P("The BBA is a full-time, three-year undergraduate degree organised in six semesters. Years 1 and 2 build a "
      "broad foundation across management, economics, accounting, marketing, finance, people and analytics. In Year 3 "
      "every student chooses one <b>specialisation</b> and completes a summer internship and a capstone consulting project."),
    table([["Item", "Details"],
           ["Degree", "Bachelor of Business Administration (BBA), awarded by E-Logic University"],
           ["Duration", "3 years, 6 semesters (odd semester July-November, even semester January-April)"],
           ["Total credits", f"{TOTAL_CREDITS} credits (22 per semester)"],
           ["Intake", "40 students per year, two sections (A and B) of 20 each"],
           ["Eligibility", "Class XII (any stream) with at least 55% aggregate (50% for SC/ST), plus the E-LAT entrance test and interview"],
           ["Specialisations", "Marketing, Finance, Human Resources, Business Analytics (chosen at the end of Year 2)"],
           ["Medium of instruction", "English"],
           ["Tuition fee", f"₹{ANNUAL_FEE:,} per year, payable in two instalments (by 15 July and 15 December)".replace(",", ",")],
           ["Minimum attendance", "75% in every subject to sit the end-term exam"],
           ["Current batches (2026-27)", "2024-27 batch in Semester 5; 2025-28 batch in Semester 3; 2026-29 batch in Semester 1"]],
          [42 * mm, CONTENT_W - 42 * mm]),
    Spacer(1, 8),
    P("How the three years build on each other", h2),
    table([["Year", "Theme", "What students do"],
           ["Year 1", "Foundations", "Management, economics, accounting, mathematics, communication and digital tools; "
                                    "a sustainability project in Semester 1 and a community engagement project in Semester 2."],
           ["Year 2", "Business functions", "Marketing, finance, HR, law, operations and analytics; one open elective each "
                                          "semester; a business simulation; an 8-week summer internship after Semester 4."],
           ["Year 3", "Specialise and apply", "Strategy, ethics, international business and taxation; four subjects in the "
                                            "chosen specialisation; the Leadership Lab and the Capstone Consulting Project."]],
          [18 * mm, 34 * mm, CONTENT_W - 52 * mm]),
    Spacer(1, 8),
    P("Who this handbook is for", h2),
    *bullets(["<b>Students</b>: what you will study, how you are assessed, and the rules you must follow.",
              "<b>Parents and guardians</b>: how to follow your ward's progress, attendance and fees, and whom to contact.",
              "<b>Faculty</b>: the shared framework for credits, sessions and evaluation across all subjects.",
              "<b>The Dean and academic leadership</b>: one reference for programme design, outcomes and policies."]),
    PageBreak(),
]

# Page 4: pedagogy
story += heading("Pedagogy", "How we teach: learn it, try it, apply it")
story += [
    P("Every subject at E-Logic combines three modes. Roughly a third of class time is spent on concepts, a third on "
      "practice, and a third on applying ideas to real organisations. Classes are capped at 40 (20 for workshops), so "
      "every student speaks, presents and gets feedback."),
    table([["Method", "What it looks like in class", "Used most in"],
           ["Case method", "Students read a business case before class and debate the decision a manager faced.", "Strategy, Marketing, Finance"],
           ["Flipped classroom", "Short videos and readings at home; class time used for problems and discussion.", "Economics, Statistics, Accounting"],
           ["Workshops and studios", "Hands-on sessions in small groups: role plays, design sprints, coding labs.", "Communication, Design Thinking, Analytics"],
           ["Business simulation", "Teams run a simulated company over eight rounds and compete on profit and market share.", "Business Simulation Workshop"],
           ["Live projects", "Briefs from partner companies, start-ups and NGOs, with a final presentation to the client.", "Brand Management, Capstone"],
           ["Industry masterclasses", "Monthly sessions with CXOs and founders; at least 12 per year for each batch.", "All years"],
           ["Peer learning", "Study circles of five, led by senior students, before mid-terms and end-terms.", "Year 1 and 2 core subjects"]],
          [33 * mm, CONTENT_W - 33 * mm - 46 * mm, 46 * mm]),
    Spacer(1, 8),
    P("Sessions and credits", h2),
    P(f"One <b>session</b> is {MINUTES_PER_SESSION} minutes. Every subject, whatever its assessment, has "
      f"<b>{SESSIONS_PER_CREDIT} sessions per credit</b>. For faculty workload, each credit taught counts as "
      f"<b>{FCH_PER_CREDIT} faculty credit hours</b> per section (teaching plus preparation and assessment), against a goal "
      f"of {FACULTY_GOAL} per faculty member per academic year."),
    table([["Credits", "Sessions", "Minutes per session", "Total minutes", "Hours taught", "Faculty credit hours"]]
          + [[str(c), str(t["Number of Sessions"]), str(t["Minutes per Session"]), f"{t['Total Minutes Taught']:,}",
              str(t["Hours Taught"]), str(t["Faculty Credit Hours"])] for c, t in ((c, teaching(c)) for c in (1, 2, 3, 4))],
          [20 * mm, 24 * mm, 34 * mm, 30 * mm, 28 * mm, CONTENT_W - 136 * mm]),
    Spacer(1, 8),
    P("Mentoring", h2),
    P("Every student is assigned a <b>faculty mentor</b> on admission, with about ten mentees each. Mentors meet each "
      "mentee at least once a month, review attendance and marks after every assessment, and are the first point of "
      "contact for parents. The mentor for each student is listed in the Student Master."),
    callout([P("<b>Digital learning.</b> All course material, assignments and grades are on the E-Logic learning portal. "
               "Students receive a laptop-ready licence for Microsoft Excel, Python (Jupyter) and Power BI in Year 1.",
               ParagraphStyle("x", parent=body, spaceAfter=0))]),
    PageBreak(),
]

# Page 5: programme structure and credit framework
by_sem = defaultdict(lambda: Counter())
for r in curriculum_rows:
    by_sem[r["Semester"]][(r["Type"], r["Assessment"])] += 1
struct = [["Semester", "Term", "Core subjects", "Elective choices", "Credits earned", "Sessions · hours taught"]]
for sem in CURRICULUM:
    rows = CURRICULUM[sem]
    core = [r for r in rows if r[3] == C]
    choice = {3: "1 open elective (2 credits) from 3", 4: "1 open elective (2 credits) from 3",
              5: "2 subjects (8 credits) of the chosen specialisation", 6: "2 subjects (8 credits) of the chosen specialisation"}.get(sem, "-")
    t = teaching(sem_credits(sem))
    struct.append([f"Semester {sem}", TERM[sem].split(" (")[0], str(len(core)), choice, str(sem_credits(sem)),
                   f"{t['Number of Sessions']} · {t['Hours Taught']} h"])
t = teaching(TOTAL_CREDITS)
struct.append(["<b>Total</b>", "", str(sum(1 for r in curriculum_rows if r["Type"] == C)), "", f"<b>{TOTAL_CREDITS}</b>",
               f"<b>{t['Number of Sessions']:,} · {t['Hours Taught']:,} h</b>"])

credits_by_assess = Counter()
for sem, rows in CURRICULUM.items():
    for r in rows:
        if r[3] == C:
            credits_by_assess[r[4]] += r[2]
credits_by_assess["Elective"] = 2 + 2 + 8 + 8

story += heading("Programme structure", "Credit framework")
story += [
    P(f"Students earn <b>22 credits every semester</b> and <b>{TOTAL_CREDITS} credits</b> in total. Core subjects are "
      "compulsory for everyone. Electives come in two kinds: <b>open electives</b> in Semesters 3 and 4 (one chosen from "
      "three each semester), and <b>specialisation electives</b> in Semesters 5 and 6 (all four subjects of the chosen "
      "track)."),
    table(struct, [22 * mm, 16 * mm, 22 * mm, CONTENT_W - 22 * mm - 16 * mm - 22 * mm - 22 * mm - 30 * mm, 22 * mm, 30 * mm]),
    Spacer(1, 8),
    P("Where the credits come from", h2),
    table([["Component", "Credits", "Share"],
           ["Core subjects assessed by exam", str(credits_by_assess["Exam"]), f"{credits_by_assess['Exam'] / TOTAL_CREDITS:.0%}"],
           ["Core workshops and studios", str(credits_by_assess["Workshop"]), f"{credits_by_assess['Workshop'] / TOTAL_CREDITS:.0%}"],
           ["Core projects (including internship and capstone)", str(credits_by_assess["Project"]), f"{credits_by_assess['Project'] / TOTAL_CREDITS:.0%}"],
           ["Electives (open and specialisation)", str(credits_by_assess["Elective"]), f"{credits_by_assess['Elective'] / TOTAL_CREDITS:.0%}"],
           ["<b>Total</b>", f"<b>{TOTAL_CREDITS}</b>", "<b>100%</b>"]],
          [CONTENT_W - 50 * mm, 25 * mm, 25 * mm]),
    Spacer(1, 8),
    P("Choosing a specialisation", h2),
    *bullets(["Students rank the four tracks in March of Year 2 after an information session with each track lead.",
              "Seats per track are capped (Marketing 12, Finance 12, Human Resources 10, Business Analytics 12); ties are "
              "broken by CGPA at the end of Semester 3.",
              "A track runs only if at least 6 students choose it. Changes are allowed until the end of the first week of Semester 5."]),
    PageBreak(),
]

# Pages 6-7: subjects


tight = ParagraphStyle("tight", parent=cell, fontSize=7.1, leading=8.6)
tighth = ParagraphStyle("tighth", parent=tight, fontName="DejaVu-Bold", textColor=colors.white)
h3 = ParagraphStyle("h3", parent=h2, fontSize=10, spaceBefore=6, spaceAfter=3)


def sem_table(sem):
    data = [["Code", "Subject", "Type", "Credits", "Sessions", "Assessed", "Faculty"]]
    for code, name, cr, typ, assess, track, fid in CURRICULUM[sem]:
        # Specialisation codes (MKT/FIN/HRM/BAN) already name the track; open electives get a short tag.
        tag = {"Open Elective I": "OE I", "Open Elective II": "OE II"}.get(track)
        label = f"{name} <font size='6.4' color='#E35A1B'>· {tag}</font>" if tag else name
        data.append([code, label, typ, str(cr), str(cr * SESSIONS_PER_CREDIT), assess,
                     FAC[fid][1].replace("Prof. (Dr.) ", "Dr. ")])
    return table(data, [15.5 * mm, 56 * mm, 14 * mm, 14 * mm, 16 * mm, 20 * mm, CONTENT_W - 135.5 * mm],
                 font=tight, head=tighth, pad=1.8)


story += heading("Subjects", "Years 1 and 2")
story += [P("Subjects, credits, sessions, assessment type and the faculty member teaching each subject in 2026-27. "
            "Open electives are tagged OE I or OE II; students choose one per group. Specialisation codes: MKT Marketing, "
            "FIN Finance, HRM Human Resources, BAN Business Analytics.", small), Spacer(1, 4)]
for sem in (1, 2, 3, 4):
    story += [KeepTogether([P(f"Semester {sem} · Year {(sem + 1) // 2} · {TERM[sem]}", h3), sem_table(sem)])]
story += [PageBreak()]

story += heading("Subjects", "Year 3 and specialisations")
for sem in (5, 6):
    story += [KeepTogether([P(f"Semester {sem} · Year 3 · {TERM[sem]}", h3), sem_table(sem)])]
story += [
    Spacer(1, 6),
    P("Specialisation tracks", h2),
    table([["Track", "Track lead", "Typical roles after graduation"],
           ["Marketing", "Dr. Priya Hegde", "Brand associate, sales and key accounts, digital marketing executive"],
           ["Finance", "Dr. Arvind Kulkarni", "Financial analyst, banking operations, wealth management, audit associate"],
           ["Human Resources", "Dr. Farah Siddiqui", "HR generalist, talent acquisition, learning and development associate"],
           ["Business Analytics", "Prof. Karthik Subramanian", "Business analyst, MIS executive, junior data analyst"]],
          [34 * mm, 42 * mm, CONTENT_W - 76 * mm]),
    PageBreak(),
]

# Page 8: assessment and evaluation
story += heading("Assessment", "How students are evaluated")
story += [
    P("Each subject is assessed in one of three ways, shown as <b>Assessment</b> in the curriculum. The weighting is "
      "fixed for each type, so students and parents always know what counts."),
    table([["Assessment type", "Internal (continuous)", "External / final", "Components"],
           ["Exam", "40%", "60% end-term exam (3 hours)", "Two quizzes (10%), assignment or case analysis (10%), mid-term exam (20%)"],
           ["Workshop", "100%", "-", "Studio or lab exercises (50%), participation and peer review (20%), final showcase (30%)"],
           ["Project", "50%", "50% report + viva", "Proposal (10%), milestone reviews (25%), mentor assessment (15%), final report and viva (50%)"]],
          [26 * mm, 30 * mm, 36 * mm, CONTENT_W - 92 * mm]),
    Spacer(1, 8),
    P("Grading scale (10-point)", h2),
    table([["Marks", "90-100", "80-89", "70-79", "60-69", "55-59", "50-54", "40-49", "Below 40"],
           ["Grade", "O", "A+", "A", "B+", "B", "C", "P", "F"],
           ["Grade point", "10", "9", "8", "7", "6", "5", "4", "0"]],
          [26 * mm] + [(CONTENT_W - 26 * mm) / 8] * 8),
    Spacer(1, 4),
    P("SGPA is the credit-weighted average of grade points in a semester; CGPA is the same across all semesters so far. "
      "A CGPA of 8.5 or above with no backlogs earns <b>First Class with Distinction</b>; 6.5 to 8.49 earns <b>First Class</b>.", small),
    Spacer(1, 6),
    P("Passing, attendance and re-examination", h2),
    *bullets(["To pass a subject, a student needs at least 40% overall <b>and</b> at least 35% in the end-term exam (Exam-type subjects).",
              "Minimum <b>75% attendance</b> in each subject is required to sit the end-term exam. Up to 10% can be condoned "
              "for documented medical reasons, with the Dean's approval.",
              "Students below 75% are flagged to their mentor and parents after the mid-term; below 65% they must repeat the subject.",
              "A student who fails can take a <b>supplementary exam</b> in June (Exam type) or resubmit within 30 days "
              "(Workshop and Project types). The grade is capped at B.",
              "Results are published on the learning portal within 21 days of the last exam. Re-evaluation requests cost ₹1,000 per "
              "subject and must be made within 7 days."]),
    Spacer(1, 4),
    callout([P("<b>Academic integrity.</b> Plagiarism above 15% (checked by software) in any submission, or any use of "
               "unauthorised AI tools in exams, leads to zero marks for that component. Repeat cases go to the Academic "
               "Integrity Committee, chaired by the Dean.", ParagraphStyle("x", parent=body, spaceAfter=0))]),
    PageBreak(),
]

# Page 9: outcomes, internships, placements
story += heading("Outcomes", "What our graduates can do")
story += [
    P("The BBA is designed backwards from seven <b>programme outcomes (POs)</b>. Every subject maps to at least two of "
      "them, and progress is reviewed each year by the Programme Director and the Dean."),
    table([["PO", "Programme outcome", "Key subjects"],
           ["PO1", "<b>Business knowledge.</b> Apply concepts of management, economics, accounting, marketing, finance and HR to business situations.", "BBA101, BBA102, BBA301, BBA302"],
           ["PO2", "<b>Critical thinking.</b> Analyse problems with data and evidence and recommend sound decisions.", "BBA204, BBA305, BBA402, BBA501"],
           ["PO3", "<b>Communication.</b> Write, present and negotiate clearly and persuasively.", "BBA105, BBA306, BBA503"],
           ["PO4", "<b>Leadership and teamwork.</b> Lead and work in diverse teams, giving and taking feedback.", "BBA201, BBA406, BBA504"],
           ["PO5", "<b>Ethics and sustainability.</b> Act responsibly towards stakeholders, society and the environment.", "BBA107, BBA207, BBA502"],
           ["PO6", "<b>Digital fluency.</b> Use spreadsheets, analytics and digital platforms to run and improve a business.", "BBA106, BBA305, BAN511"],
           ["PO7", "<b>Entrepreneurial mindset.</b> Spot opportunities, test ideas and build ventures; keep learning.", "BBA206, BBA404, BBA603"]],
          [12 * mm, CONTENT_W - 12 * mm - 42 * mm, 42 * mm]),
    Spacer(1, 6),
    P("Programme-specific outcomes by specialisation", h2),
    *bullets(["<b>Marketing:</b> plan and measure a brand or sales campaign end to end.",
              "<b>Finance:</b> value a company and build an investment or financing recommendation.",
              "<b>Human Resources:</b> design a hiring, reward or training process that meets labour law.",
              "<b>Business Analytics:</b> build a dashboard or predictive model and explain it to managers."]),
    Spacer(1, 4),
    P("Internships and placements", h2),
    P("All students complete an <b>8-week summer internship</b> between Year 2 and Year 3 (17 May to 11 July 2027 for the "
      "current Year 2). The Internship & Placement Cell, led by Prof. Ankit Shah, runs a placement-readiness programme "
      "from Semester 5."),
    stat_strip([("94%", "placed or in higher study (2026)"), ("₹6.8 LPA", "average salary offered"),
                ("₹14 LPA", "highest salary offered"), ("62", "recruiters on campus")]),
    PageBreak(),
]

# Page 10: calendar, support, contacts
story += heading("Calendar and support", "Academic calendar 2026-27 and whom to contact")
story += [
    table([["Date", "Event"],
           ["20 July 2026", "Orientation for the 2026-29 batch (students and parents)"],
           ["27 July 2026", "Odd semester classes begin (Semesters 1, 3 and 5)"],
           ["14-19 September 2026", "Mid-term exams, odd semester"],
           ["10 October 2026", "Parent-Teacher Meeting (PTM) 1, in person and online"],
           ["6-11 November 2026", "Deepavali break"],
           ["14 November 2026", "Last teaching day, odd semester"],
           ["23 November - 5 December 2026", "End-term exams, odd semester"],
           ["7 December 2026 - 3 January 2027", "Winter break"],
           ["4 January 2027", "Even semester classes begin (Semesters 2, 4 and 6)"],
           ["22-24 January 2027", "E-Fest, the annual management and cultural festival"],
           ["15-20 February 2027", "Mid-term exams, even semester"],
           ["13 March 2027", "Parent-Teacher Meeting (PTM) 2"],
           ["26 April - 8 May 2027", "End-term exams, even semester"],
           ["17 May - 11 July 2027", "Summer internship (students finishing Year 2)"],
           ["June 2027", "Supplementary exams; convocation for the 2024-27 batch"]],
          [58 * mm, CONTENT_W - 58 * mm]),
    Spacer(1, 6),
    P("For parents and guardians", h2),
    *bullets(["Attendance and marks are visible on the parent portal and are e-mailed after every mid-term and end-term.",
              "Parents are told within a week if attendance falls below 75% or fees are overdue.",
              "Two Parent-Teacher Meetings a year; mentors can also be met by appointment on any Saturday."]),
    Spacer(1, 2),
    P("Key contacts", h2),
    table([["Role", "Name", "E-mail"],
           ["Dean, School of Business", "Prof. (Dr.) Meera Raghavan", email_of("Meera Raghavan")],
           ["Programme Director, BBA", "Dr. Arvind Kulkarni", email_of("Arvind Kulkarni")],
           ["Year 1 / Year 2 / Year 3 Coordinators", "Dr. Lakshmi Narayanan / Dr. Neha Agarwal / Dr. Priya Hegde", "bba.coordinators@elogic.example.edu"],
           ["Student Welfare & Parent Liaison", "Dr. Farah Siddiqui", email_of("Farah Siddiqui")],
           ["Controller of Examinations", "Dr. Sanjay Deshmukh", email_of("Sanjay Deshmukh")],
           ["Internship & Placement Cell", "Prof. Ankit Shah", email_of("Ankit Shah")]],
          [52 * mm, CONTENT_W - 52 * mm - 62 * mm, 62 * mm]),
]

doc = BaseDocTemplate(str(HANDBOOK), pagesize=A4, title="E-Logic BBA Student Handbook 2026-27",
                      author="E-Logic School of Business (fictitious)", subject="BBA programme handbook (mock-up)",
                      leftMargin=MARGIN, rightMargin=MARGIN, topMargin=22 * mm, bottomMargin=19 * mm)
frame = Frame(MARGIN, 19 * mm, CONTENT_W, PAGE_H - 41 * mm, id="f", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
doc.addPageTemplates([PageTemplate("cover", frames=[frame], onPage=cover),
                      PageTemplate("inner", frames=[frame], onPage=page_chrome)])
doc.build(story)

# ------------------------------------------------------------------ site data

site = {
    "school": SCHOOL, "academicYear": AY, "totalCredits": TOTAL_CREDITS,
    "curriculum": curriculum_rows,
    "faculty": [{"id": f[0], "name": f[1], "designation": f[2], "area": FACULTY_AREA[f[0]], "specialism": f[3], "qualification": f[4],
                 "experience": f[5], "role": f[6], "email": email_of(f[1]),
                 "subjects": [r["Subject Code"] for r in curriculum_rows if r["Faculty ID"] == f[0]],
                 "sections": sum(1 for u in utilization_rows if u["Faculty ID"] == f[0]),
                 "credits": sum(u["Credits"] for u in utilization_rows if u["Faculty ID"] == f[0]),
                 "sessions": sum(u["Number of Sessions"] for u in utilization_rows if u["Faculty ID"] == f[0]),
                 "fch": row["Faculty Credit Hours"], "goal": row["Goal (Faculty Credit Hours)"], "utilization": row["Utilization %"]}
                for f, row in zip(FACULTY, faculty_rows)],
    "assumptions": {"sessionsPerCredit": SESSIONS_PER_CREDIT, "minutesPerSession": MINUTES_PER_SESSION,
                    "fchPerCredit": FCH_PER_CREDIT, "facultyGoal": FACULTY_GOAL},
    "facultyUtilization": utilization_rows,
    "students": student_rows,
    "files": [{"name": HANDBOOK.name, "path": f"docs/{HANDBOOK.name}", "title": "BBA Student Handbook 2026-27",
               "description": "10 pages: overview, pedagogy, subjects, assessment, outcomes, calendar, contacts."},
              {"name": MASTERS.name, "path": f"docs/{MASTERS.name}", "title": "BBA master data 2026-27",
               "description": f"Curriculum ({len(curriculum_rows)} subjects), students ({len(student_rows)}), "
                              f"faculty ({len(faculty_rows)}), faculty utilization ({len(utilization_rows)} sections)."}],
}
(ROOT / "site-data.json").write_text(json.dumps(site, indent=1, ensure_ascii=False))

chars = sum(len("; ".join(f"{k}: {v}" for k, v in r.items())) for r in curriculum_rows + student_rows + faculty_rows + utilization_rows)
print(f"curriculum {len(curriculum_rows)} rows, students {len(student_rows)}, faculty {len(faculty_rows)}, "
      f"utilization {len(utilization_rows)} sections (not offered: {', '.join(not_offered) or 'none'}), "
      f"total credits {TOTAL_CREDITS}, spreadsheet text ≈ {chars:,} chars")
