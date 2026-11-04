// E-Logic BBA. The site opens on Ask E-Logic, a cited answer bot over the handbook PDF and the
// master-data workbook; the other pages (hash routes) are rendered from site-data.json. The bot uses
// the Local Q&A engine in lib/: documents are read in this browser, and questions go straight to
// Anthropic with the visitor's own key.
import * as engine from './lib/engine.js';
import * as charts from './lib/qa-chart.js';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
};
const icon = (name, cls = '') => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (cls) svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
};
const webStore = (kind) => ({
  get(key) { try { return window[kind].getItem(key); } catch (e) { return null; } },
  set(key, value) {
    try { if (value == null) window[kind].removeItem(key); else window[kind].setItem(key, value); } catch (e) { /* blocked */ }
  },
});
const session = webStore('sessionStorage');
const local = webStore('localStorage');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const countBy = (rows, key) => rows.reduce((m, r) => m.set(r[key], (m.get(r[key]) || 0) + 1), new Map());

const DOCS = ['E-Logic_BBA_Student_Handbook_2026-27.pdf', 'E-Logic_BBA_Master_Data_2026-27.xlsx'];
// The two documents are about 170k characters; sending them whole (prompt-cached) beats retrieval for
// "list every…" and "how many…" questions. Past this size the bot falls back to best-matching passages.
const FULL_CONTEXT_LIMIT = 260000;

let data = null;

// ================================================================== routing

const VIEWS = ['ask', 'programme', 'curriculum', 'faculty', 'students', 'handbook', 'planner', 'ask'];
let curSem = 0; // 0 = all semesters

function route() {
  const [view, sub] = location.hash.replace(/^#/, '').split('/');
  const name = VIEWS.includes(view) ? view : 'ask';
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== name;
  for (const a of document.querySelectorAll('.primary-nav a[data-route]')) a.classList.toggle('is-current', a.dataset.route === name);
  $('primary-nav').classList.remove('is-open');
  $('nav-toggle').setAttribute('aria-expanded', 'false');
  $('fab').hidden = name === 'ask';
  if (name === 'curriculum' && sub && /^[1-6]$/.test(sub)) { curSem = Number(sub); renderCurriculum(); }
  if (name === 'planner') showPlanTab(sub);
  const target = sub && name === 'programme' ? document.getElementById(`programme-${sub}`) : null;
  if (target) target.scrollIntoView({ behavior: 'smooth' });
  else window.scrollTo({ top: 0 });
  if (name === 'ask') openAsk();
}

// ================================================================== programme

function renderStructure() {
  const bySem = new Map();
  for (const c of data.curriculum) {
    const s = bySem.get(c.Semester) || { core: 0, coreCredits: 0, electives: 0 };
    if (c.Type === 'Core') { s.core += 1; s.coreCredits += c.Credits; } else s.electives += 1;
    bySem.set(c.Semester, s);
  }
  const elective = { 3: 'Choose 1 open elective (2 credits) of 3', 4: 'Choose 1 open elective (2 credits) of 3', 5: '2 subjects (8 credits) of your specialisation', 6: '2 subjects (8 credits) of your specialisation' };
  const rows = [...bySem.entries()].map(([sem, s]) => {
    const earned = s.coreCredits + (sem >= 5 ? 8 : sem >= 3 ? 2 : 0);
    return el('tr', {}, el('td', { text: `Semester ${sem}` }), el('td', { text: `Year ${Math.ceil(sem / 2)}` }),
      el('td', { class: 'num', text: String(s.core) }), el('td', { class: 'num', text: String(s.coreCredits) }),
      el('td', { text: elective[sem] || '-' }), el('td', { class: 'num', text: String(earned) }));
  });
  $('structure-table').replaceChildren(
    el('thead', {}, el('tr', {}, ['Semester', 'Year', 'Core subjects', 'Core credits', 'Electives', 'Credits earned'].map((h) => el('th', { text: h })))),
    el('tbody', {}, rows),
    el('tfoot', {}, el('tr', {}, el('td', { text: 'Total' }), el('td'), el('td'), el('td'), el('td'), el('td', { class: 'num', text: String(data.totalCredits) }))));
}

// ================================================================== curriculum

const tag = (text) => el('span', { class: `tag tag-${text.toLowerCase()}`, text });
const facultyName = (id) => (data.faculty.find((f) => f.id === id) || {}).name || id;

function renderCurriculum() {
  if (!data) return;
  const tabs = $('sem-tabs');
  if (!tabs.children.length) {
    ['All', 1, 2, 3, 4, 5, 6].forEach((s, i) => tabs.append(el('button', { role: 'tab', type: 'button', text: i ? `Sem ${s}` : s,
      onclick: () => { curSem = i; renderCurriculum(); } })));
    // Areas in the order they first appear in the curriculum.
    [...new Set(data.curriculum.map((c) => c['Subject Area']))].forEach((a) => $('cur-area').append(el('option', { text: a })));
    $('cur-area').addEventListener('change', renderCurriculum);
    $('cur-type').addEventListener('change', renderCurriculum);
    $('cur-assess').addEventListener('change', renderCurriculum);
  }
  [...tabs.children].forEach((b, i) => b.setAttribute('aria-selected', String(i === curSem)));
  const type = $('cur-type').value;
  const assess = $('cur-assess').value;
  const area = $('cur-area').value;
  const rows = data.curriculum.filter((c) => (!curSem || c.Semester === curSem) && (!type || c.Type === type)
    && (!assess || c.Assessment === assess) && (!area || c['Subject Area'] === area));
  const credits = rows.reduce((n, r) => n + r.Credits, 0);
  const total = (key) => rows.reduce((n, r) => n + r[key], 0);
  $('cur-kpis').replaceChildren(
    kpi(rows.length, 'subjects shown'), kpi(total('Number of Sections'), 'sections running'),
    kpi(credits, 'credits offered (incl. every elective)'), kpi(total('Number of Sessions').toLocaleString('en-IN'), 'sessions (one section each)'),
    kpi(total('Hours Taught').toLocaleString('en-IN'), 'hours taught (one section each)'));
  const body = [];
  let lastSem = null;
  for (const r of rows) {
    if (!curSem && r.Semester !== lastSem) {
      body.push(el('tr', { class: 'sem-row' }, el('td', { colspan: 12, text: `Semester ${r.Semester} · ${r['Programme Year']}` })));
      lastSem = r.Semester;
    }
    body.push(el('tr', {}, el('td', { text: r['Subject Code'] }), el('td', {}, el('strong', { text: r.Subject }),
      r['Elective Group'] !== '-' ? el('div', { class: 'qa-ref', text: r['Elective Group'] }) : null),
    el('td', { text: r['Subject Area'] }), el('td', { text: r['Academic Year'] }),
    ['Credits', 'Number of Sessions', 'Hours Taught', 'Faculty Credit Hours', 'Number of Sections'].map((k) => el('td', { class: 'num', text: String(r[k]) })),
    el('td', {}, tag(r.Type)), el('td', {}, tag(r.Assessment)),
    el('td', { text: facultyName(r['Faculty ID']) })));
  }
  $('cur-table').replaceChildren(
    el('thead', {}, el('tr', {}, ['Code', 'Subject', 'Subject Area', 'Academic Year', 'Credits', 'Sessions', 'Hours taught', 'Faculty credit hours', 'Sections', 'Type', 'Assessment', 'Faculty'].map((h) => el('th', { text: h })))),
    el('tbody', {}, body.length ? body : el('tr', {}, el('td', { colspan: 12, text: 'No subjects match these filters.' }))));
}

const kpi = (value, label) => el('div', { class: 'kpi' }, el('strong', { text: String(value) }), el('span', { text: label }));

// ================================================================== faculty

const AVATAR = ['#e35a1b', '#1f4e9c', '#11804a', '#8a3ffc', '#b8430d', '#16233f', '#0f7a7a', '#a0337a'];
const initials = (name) => name.replace(/\(.*?\)|Prof\.|Dr\.|Adv\.|Ms\.|Mr\./g, '').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('');

function renderFaculty() {
  const areaSel = $('fac-area');
  if (areaSel.options.length === 1) {
    [...new Set(data.faculty.map((f) => f.area))].sort().forEach((a) => areaSel.append(el('option', { text: a })));
    areaSel.addEventListener('change', renderFaculty);
    $('fac-q').addEventListener('input', renderFaculty);
  }
  const q = $('fac-q').value.trim().toLowerCase();
  const area = areaSel.value;
  const subjectName = (code) => (data.curriculum.find((c) => c['Subject Code'] === code) || {}).Subject || code;
  const people = data.faculty.filter((f) => (!area || f.area === area)
    && (!q || [f.name, f.area, f.specialism, f.designation, f.role, ...f.subjects.map(subjectName), ...f.subjects].join(' ').toLowerCase().includes(q)));
  $('fac-grid').replaceChildren(...people.map((f, i) => el('article', { class: 'person' },
    el('div', { class: 'person-top' }, el('span', { class: 'avatar', style: `background:${AVATAR[data.faculty.indexOf(f) % AVATAR.length]}`, text: initials(f.name) }),
      el('div', {}, el('h3', { text: f.name }), el('div', { class: 'desig', text: f.designation }))),
    el('p', { class: 'area' }, el('strong', { text: f.area }), ` · ${f.specialism} · ${f.qualification} · ${f.experience} years`),
    f.role !== '-' ? el('span', { class: 'role', text: f.role }) : null,
    el('div', { class: 'load' },
      el('span', { class: `util ${f.utilization > 100 ? 'util-over' : f.utilization < 80 ? 'util-under' : 'util-ok'}`, text: `${f.utilization}% of goal` }),
      el('span', { text: `${f.fch} of ${f.goal} faculty credit hours · ${plural(f.sections, 'section')} · ${f.credits} credits` })),
    el('div', { class: 'subj' }, f.subjects.map((code) => el('span', { class: 'tag', title: subjectName(code), text: code }))))));
  // Faculty Utilization: one row per section taught, linked to Faculty Master (Faculty ID) and Curriculum Master (Subject Code).
  const rows = data.facultyUtilization.filter((r) => people.some((p) => p.id === r['Faculty ID']));
  const sum = (key) => rows.reduce((n, r) => n + r[key], 0);
  $('fac-table').replaceChildren(
    el('thead', {}, el('tr', {}, ['Prof Name', 'Semester', 'Term', 'Code', 'Subject', 'Subject Area', 'Type', 'Section', 'Students', 'Credits', 'Sessions', 'Hours taught', 'Faculty credit hours', 'Status']
      .map((h) => el('th', { text: h })))),
    el('tbody', {}, rows.map((r) => el('tr', {}, el('td', { text: r['Prof Name'] }), el('td', { class: 'num', text: String(r.Semester) }),
      el('td', { text: r.Term.split(' (')[0], title: r.Term }), el('td', { text: r['Subject Code'] }), el('td', { text: r.Subject }), el('td', { text: r['Subject Area'] }),
      el('td', {}, tag(r.Type)), el('td', { text: `${r.Section} of ${r['Number of Sections']}` }),
      ['Students', 'Credits', 'Number of Sessions', 'Hours Taught', 'Faculty Credit Hours'].map((k) => el('td', { class: 'num', text: String(r[k]) })),
      el('td', { text: r.Status })))),
    el('tfoot', {}, el('tr', {}, el('td', { colspan: 7, text: `Total · ${plural(rows.length, 'section')}` }), el('td'),
      ['Students', 'Credits', 'Number of Sessions', 'Hours Taught', 'Faculty Credit Hours'].map((k) => el('td', { class: 'num', text: sum(k).toLocaleString('en-IN') })),
      el('td'))));
}

// ================================================================== students

const STU_COLS = ['Student ID', 'Student Name', 'Batch', 'Current Semester', 'Section', 'Home State', 'Home City', 'Parent / Guardian',
  'Relationship', 'Date of Admission', 'Specialisation', 'CGPA', 'Attendance % (current sem)', 'Fee Status', 'Faculty Mentor'];

function hbars(node, counts, limit = 10) {
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const max = Math.max(...rows.map((r) => r[1]));
  node.replaceChildren(...rows.map(([k, v]) => el('div', { class: 'hbar' }, el('span', { text: k }),
    el('div', { class: 'hbar-track' }, el('div', { class: 'hbar-fill', style: `width:${(v / max) * 100}%` })), el('b', { text: String(v) }))));
}

function renderStudents() {
  const all = data.students;
  const batchSel = $('stu-batch');
  const stateSel = $('stu-state');
  if (batchSel.options.length === 1) {
    [...new Set(all.map((s) => s.Batch))].sort().forEach((b) => batchSel.append(el('option', { text: b })));
    [...new Set(all.map((s) => s['Home State']))].sort().forEach((b) => stateSel.append(el('option', { text: b })));
    for (const n of [batchSel, stateSel]) n.addEventListener('change', renderStudents);
    $('stu-q').addEventListener('input', renderStudents);
    const graded = all.filter((s) => typeof s.CGPA === 'number');
    const avg = graded.reduce((n, s) => n + s.CGPA, 0) / graded.length;
    const low = all.filter((s) => s['Attendance % (current sem)'] < 75);
    $('stu-kpis').replaceChildren(kpi(all.length, 'students'), kpi(new Set(all.map((s) => s['Home State'])).size, 'home states'),
      kpi(all.filter((s) => s['Hostel Resident'] === 'Yes').length, 'hostel residents'), kpi(avg.toFixed(2), 'average CGPA (Years 2-3)'),
      kpi(low.length, 'below 75% attendance'), kpi(all.filter((s) => s['Fee Status'] !== 'Paid').length, 'with fees pending'));
    hbars($('stu-states'), countBy(all, 'Home State'));
    hbars($('stu-tracks'), countBy(all.filter((s) => s['Current Year'] === 'Year 3'), 'Specialisation'));
    $('stu-risk').replaceChildren(el('div', { class: 'risk' }, low.map((s) => el('span', { class: 'tag tag-low', title: `${s.Batch}, mentor ${s['Faculty Mentor']}`,
      text: `${s['Student Name']} · ${s['Attendance % (current sem)']}%` }))));
  }
  const q = $('stu-q').value.trim().toLowerCase();
  const rows = all.filter((s) => (!batchSel.value || s.Batch === batchSel.value) && (!stateSel.value || s['Home State'] === stateSel.value)
    && (!q || [s['Student ID'], s['Student Name'], s['Parent / Guardian'], s['Home City'], s['Faculty Mentor']].join(' ').toLowerCase().includes(q)));
  $('stu-table').replaceChildren(
    el('thead', {}, el('tr', {}, STU_COLS.map((h) => el('th', { text: h === 'Attendance % (current sem)' ? 'Attendance %' : h })))),
    el('tbody', {}, rows.map((s) => el('tr', {}, STU_COLS.map((h) => {
      const v = s[h];
      if (h === 'Attendance % (current sem)') return el('td', { class: 'num' }, v < 75 ? el('span', { class: 'tag tag-low', text: `${v}` }) : String(v));
      if (h === 'Fee Status') return el('td', {}, v === 'Paid' ? 'Paid' : el('span', { class: 'tag tag-elective', text: v }));
      return el('td', { class: typeof v === 'number' ? 'num' : null, text: String(v) });
    })))));
  $('stu-count').textContent = `Showing ${plural(rows.length, 'student')} of ${all.length}. More columns (date of birth, parent contact, category, scholarship, electives) are in the Student Master sheet.`;
}

// ================================================================== Ask E-Logic: sources

// Two separate sources, each with its own documents and conversation. "elogic" is the BBA handbook and
// master data; "mine" holds only what the visitor uploads, and never sees the E-Logic documents.
// ================================================================== course planner

// The documents are built ahead of time and reviewed; docs/course-docs/index.json lists what exists.
const PLAN_DIR = 'docs/course-docs/';
const PLAN_DOCS = [['outline', 'Course Outline'], ['aol', 'AoL Plan'], ['report', 'AoL Report']];
const PLAN_BLANKS = { outline: 'E-Logic_Course_Outline_Template.docx', aol: 'E-Logic_AoL_Plan_Template.docx', report: 'E-Logic_AoL_Report_Template.xlsx' };
const JSZIP = 'https://cdn.jsdelivr.net/npm/jszip@3.10.2/+esm';
const PIZZIP = 'https://cdn.jsdelivr.net/npm/pizzip@3.3.0/+esm';
const DOCXTEMPLATER = 'https://cdn.jsdelivr.net/npm/docxtemplater@3.71.0/+esm';
const EXCELJS = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
const MAMMOTH = 'https://cdn.jsdelivr.net/npm/mammoth@1.13.0/mammoth.browser.min.js';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const TEMPLATE_LIMIT = 10 * 1024 * 1024;
// Old branding that must not reach E-Logic documents; encoded so this public file doesn't name it.
const OLD_BRANDING = new RegExp(atob('dFwuPyA/YVwuPyA/cGFpfHRhcG1pfG1hbmlwYWw='), 'i');
let planIndex = {};
let planFiles = [];
let planCustom = {}; // kind -> { name, blob, savedAt, warnings }: uploaded templates in this browser
const planFields = new Map();

const loadScript = (src, global) => new Promise((resolve, reject) => {
  if (window[global]) { resolve(window[global]); return; }
  const script = el('script', { src });
  script.onload = () => resolve(window[global]);
  script.onerror = () => reject(new Error(`Couldn't load ${global}`));
  document.head.append(script);
});
const loadExcel = () => loadScript(EXCELJS, 'ExcelJS');
const loadPizZip = async () => (await import(PIZZIP)).default;

// ------------------------------------------------------------------ uploaded templates, kept in this browser

function templateStore(mode, work) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('elogic-planner', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('templates');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('templates', mode);
      const req = work(tx.objectStore('templates'));
      tx.oncomplete = () => { open.result.close(); resolve(req.result); };
      tx.onerror = () => { open.result.close(); reject(tx.error); };
    };
  });
}

async function loadCustomTemplates() {
  for (const [kind] of PLAN_DOCS) {
    try {
      const saved = await templateStore('readonly', (s) => s.get(kind));
      if (saved) planCustom[kind] = saved;
    } catch (e) { /* storage blocked: the defaults still work */ }
  }
}

const xmlText = (xml) => xml.replace(/<[^>]+>/g, '');

async function checkTemplate(kind, file) {
  const wantXlsx = kind === 'report';
  if (!file.name.toLowerCase().endsWith(wantXlsx ? '.xlsx' : '.docx')) return { error: `Please upload a ${wantXlsx ? '.xlsx' : '.docx'} file.` };
  if (file.size > TEMPLATE_LIMIT) return { error: 'That file is over 10 MB.' };
  const buffer = await file.arrayBuffer();
  const warnings = [];
  let parts;
  try {
    const PizZip = await loadPizZip();
    parts = new PizZip(buffer);
  } catch (e) {
    return { error: 'That file couldn’t be opened. It may be damaged.' };
  }
  const texts = Object.values(parts.files).filter((f) => !f.dir && /\.(xml|rels)$/.test(f.name)).map((f) => xmlText(f.asText()));
  if (texts.some((t) => OLD_BRANDING.test(t))) warnings.push('This file mentions another institute. Please remove it before using this template.');
  if (wantXlsx) {
    const path = marksSheetPath(parts);
    if (!path || !reportStart(parseXml(parts.file(path).asText()), sharedStrings(parts))) {
      return { error: 'This needs a sheet named Marks Sheet with the Bloom\'s Level row, as in the blank template.' };
    }
  } else {
    const { default: Docxtemplater } = await import(DOCXTEMPLATER);
    try {
      new Docxtemplater(parts, { paragraphLoop: true, linebreaks: true });
    } catch (e) {
      const first = (e.properties && e.properties.errors && e.properties.errors[0]) || e;
      const detail = first.properties && first.properties.explanation;
      return { error: `A marked field isn't written correctly. ${detail || first.message}` };
    }
    const text = xmlText(parts.file('word/document.xml').asText());
    if (!/\{[#/]?[\w.]+\}/.test(text)) warnings.push('No marked fields found, so every subject would get the same document.');
  }
  return { warnings };
}

// ------------------------------------------------------------------ filling a template for one subject

async function subjectFields(code) {
  if (!planFields.has(code)) {
    const res = await fetch(`${PLAN_DIR}fields/${code}.json`);
    if (!res.ok) throw new Error(`No field data for ${code}`);
    planFields.set(code, await res.json());
  }
  return planFields.get(code);
}

async function fillDocx(blob, fields) {
  const [PizZip, { default: Docxtemplater }] = await Promise.all([loadPizZip(), import(DOCXTEMPLATER)]);
  const doc = new Docxtemplater(new PizZip(await blob.arrayBuffer()), { paragraphLoop: true, linebreaks: true, nullGetter: () => '' });
  doc.render(fields);
  return doc.getZip().generate({ type: 'blob', mimeType: DOCX_TYPE });
}

// Reports are filled by editing the workbook's XML in place, so its formulas, formats and rules stay exactly as saved.
const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const parseXml = (text) => new DOMParser().parseFromString(text, 'application/xml');
const toXml = (doc) => {
  const xml = new XMLSerializer().serializeToString(doc);
  return xml.startsWith('<?xml') ? xml : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`;
};
const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tagged = (node, name) => [...node.getElementsByTagNameNS(SHEET_NS, name)];

function marksSheetPath(zip) {
  const book = zip.file('xl/workbook.xml');
  const rels = zip.file('xl/_rels/workbook.xml.rels');
  if (!book || !rels) return null;
  const sheet = tagged(parseXml(book.asText()), 'sheet').find((n) => n.getAttribute('name') === 'Marks Sheet');
  if (!sheet) return null;
  const id = sheet.getAttribute('r:id');
  const rel = [...parseXml(rels.asText()).documentElement.children].find((n) => n.getAttribute('Id') === id);
  const target = rel && rel.getAttribute('Target');
  return target ? target.replace(/^\/?(xl\/)?/, 'xl/') : null;
}

function sharedStrings(zip) {
  const file = zip.file('xl/sharedStrings.xml');
  return file ? tagged(parseXml(file.asText()), 'si').map((si) => tagged(si, 't').map((t) => t.textContent).join('')) : [];
}

// The first student row: the one under the Bloom's Level label.
function reportStart(sheet, strings) {
  const label = tagged(sheet, 'c').find((c) => {
    const value = tagged(c, 'v')[0];
    const text = c.getAttribute('t') === 's' && value ? strings[Number(value.textContent)] : tagged(c, 't').map((t) => t.textContent).join('');
    return text === 'Bloom\'s Level';
  });
  return label ? Number(label.getAttribute('r').replace(/\D/g, '')) + 1 : null;
}

function setSheetCell(sheet, ref, value) {
  const cell = tagged(sheet, 'c').find((c) => c.getAttribute('r') === ref);
  if (!cell) throw new Error(`The template has no cell ${ref}`);
  cell.replaceChildren();
  cell.removeAttribute('t');
  if (typeof value === 'number') {
    cell.append(Object.assign(sheet.createElementNS(SHEET_NS, 'v'), { textContent: String(value) }));
    return;
  }
  cell.setAttribute('t', 'inlineStr');
  const text = sheet.createElementNS(SHEET_NS, 't');
  text.textContent = value;
  const inline = sheet.createElementNS(SHEET_NS, 'is');
  inline.append(text);
  cell.append(inline);
}

async function fillReport(blob, fields) {
  const PizZip = await loadPizZip();
  const zip = new PizZip(await blob.arrayBuffer());
  const { cells, students } = fields.report;
  // Text sits in the shared list in files Excel saved, and in each sheet in others.
  for (const file of Object.values(zip.files).filter((f) => /^xl\/(sharedStrings|worksheets\/[^/]+)\.xml$/.test(f.name))) {
    zip.file(file.name, file.asText().replace(/\{(\w+)\}/g, (all, key) => (key in cells ? escapeXml(cells[key]) : all)));
  }
  const strings = sharedStrings(zip);
  const path = marksSheetPath(zip);
  const sheet = parseXml(zip.file(path).asText());
  const start = reportStart(sheet, strings);
  students.forEach((s, i) => {
    [i + 1, s.section, s.name, s.roll, ...s.marks].forEach((value, c) => setSheetCell(sheet, `${'ABCDEFGHIJ'[c]}${start + i}`, value));
  });
  zip.file(path, toXml(sheet));
  // Excel works out every formula again when the file opens.
  const book = parseXml(zip.file('xl/workbook.xml').asText());
  const calc = tagged(book, 'calcPr')[0] || book.documentElement.appendChild(book.createElementNS(SHEET_NS, 'calcPr'));
  calc.setAttribute('fullCalcOnLoad', '1');
  zip.file('xl/workbook.xml', toXml(book));
  return zip.generate({ type: 'blob', mimeType: XLSX_TYPE, compression: 'DEFLATE' });
}

// One document for a subject: built from an uploaded template if there is one, otherwise the reviewed file.
async function planBlob({ code, kind, name }) {
  const custom = planCustom[kind];
  if (custom) {
    const fields = await subjectFields(code);
    return kind === 'report' ? fillReport(custom.blob, fields) : fillDocx(custom.blob, fields);
  }
  const res = await fetch(PLAN_DIR + name);
  if (!res.ok) throw new Error(name);
  return res.blob();
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  el('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function downloadPlanFile(file) {
  $('plan-status').textContent = `Building ${file.name}…`;
  try {
    saveBlob(await planBlob(file), file.name);
    $('plan-status').textContent = `${file.name} is ready.`;
  } catch (e) {
    $('plan-status').textContent = `${file.name} couldn’t be built from your template. Check its marked fields, or restore the default.`;
  }
}

const planSubjects = () => data.curriculum.filter((c) => planIndex[c['Subject Code']]);

function fillPlanSubjects() {
  const sem = Number($('plan-sem').value);
  const rows = planSubjects().filter((c) => !sem || c.Semester === sem);
  $('plan-subject').replaceChildren(el('option', { value: '', text: `All subjects (${rows.length})` }),
    ...rows.map((c) => el('option', { value: c['Subject Code'], text: `${c['Subject Code']} ${c.Subject}` })));
}

function clearPlanResults() {
  $('plan-results').hidden = true;
  const picked = PLAN_DOCS.some(([kind]) => $(`plan-${kind}`).checked);
  $('plan-generate').disabled = !picked;
}

function generatePlan() {
  const sem = Number($('plan-sem').value);
  const code = $('plan-subject').value;
  const kinds = PLAN_DOCS.filter(([kind]) => $(`plan-${kind}`).checked);
  const rows = planSubjects().filter((c) => (!sem || c.Semester === sem) && (!code || c['Subject Code'] === code));
  planFiles = [];
  const head = el('tr', {}, ['Subject', 'Professor', 'Sem', 'Credits', 'Assessment', ...kinds.map(([, label]) => label)]
    .map((text) => el('th', { text })));
  const body = rows.map((c) => el('tr', {},
    el('td', {}, el('strong', { text: c['Subject Code'] }), ` ${c.Subject}`),
    el('td', { text: facultyName(c['Faculty ID']) }),
    el('td', { text: String(c.Semester) }),
    el('td', { text: String(c.Credits) }),
    el('td', {}, tag(c.Assessment)),
    kinds.map(([kind]) => {
      const name = planIndex[c['Subject Code']][kind];
      if (!name) return el('td', { class: 'plan-none', text: 'Not available yet' });
      const file = { code: c['Subject Code'], kind, name };
      planFiles.push(file);
      if (!planCustom[kind]) return el('td', {}, el('a', { href: PLAN_DIR + name, download: true }, icon('download'), ' Download'));
      return el('td', {}, el('button', { class: 'btn-link', type: 'button', onclick: () => downloadPlanFile(file) }, icon('download'), ' Download'),
        el('small', { class: 'plan-custom', text: 'Your template' }));
    })));
  $('plan-table').replaceChildren(el('thead', {}, head), el('tbody', {}, body));
  $('plan-status').textContent = `${plural(planFiles.length, 'document')} for ${plural(rows.length, 'subject')}.`;
  $('plan-zip').disabled = !planFiles.length;
  $('plan-results').hidden = false;
}

async function downloadPlanZip() {
  const button = $('plan-zip');
  button.disabled = true;
  $('plan-status').textContent = 'Preparing the ZIP…';
  try {
    const { default: JSZip } = await import(JSZIP);
    const zip = new JSZip();
    await Promise.all(planFiles.map(async (file) => zip.file(file.name, await planBlob(file))));
    saveBlob(await zip.generateAsync({ type: 'blob' }), 'E-Logic_Course_Documents.zip');
    $('plan-status').textContent = `ZIP ready with ${plural(planFiles.length, 'document')}.`;
  } catch (e) {
    $('plan-status').textContent = 'The ZIP couldn’t be made. Please use the individual downloads.';
  }
  button.disabled = false;
}

// ------------------------------------------------------------------ templates tab

function showPlanTab(tab) {
  const templates = tab === 'templates';
  $('plan-panel-generate').hidden = templates;
  $('plan-panel-templates').hidden = !templates;
  $('plan-tab-generate').setAttribute('aria-selected', String(!templates));
  $('plan-tab-templates').setAttribute('aria-selected', String(templates));
}

async function activeTemplate(kind) {
  if (planCustom[kind]) return planCustom[kind].blob;
  const res = await fetch(`${PLAN_DIR}templates/${PLAN_BLANKS[kind]}`);
  if (!res.ok) throw new Error(PLAN_BLANKS[kind]);
  return res.blob();
}

async function previewTemplate(kind, label) {
  const body = $('tpl-preview-body');
  $('tpl-preview').hidden = false;
  $('tpl-preview-title').textContent = `${label} preview`;
  $('tpl-preview-note').textContent = kind === 'report' ? 'First rows of each sheet.' : 'Word’s layout is only approximate here. Download the file for the exact version.';
  body.replaceChildren(el('p', { class: 'fine', text: 'Loading…' }));
  try {
    const blob = await activeTemplate(kind);
    if (kind === 'report') {
      const ExcelJS = await loadExcel();
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(await blob.arrayBuffer());
      const shown = [];
      book.eachSheet((sheet) => {
        const rows = [];
        sheet.eachRow((row, n) => {
          if (n > 14) return;
          const cells = Array.from({ length: sheet.columnCount }, (_, i) => row.getCell(i + 1));
          // A merged block shows its text once, and formulas show as blank until the file is opened.
          rows.push(el('tr', {}, cells.map((c) => {
            const shown = (c.isMerged && c.master !== c) || c.value == null || typeof c.value === 'object' ? '' : String(c.value);
            return el('td', { text: shown });
          })));
        });
        shown.push(el('h3', { class: 'tpl-sheet', text: sheet.name }), el('div', { class: 'table-card table-scroll' }, el('table', { class: 'dt dt-compact' }, el('tbody', {}, rows))));
      });
      body.replaceChildren(...shown);
    } else {
      const mammoth = await loadScript(MAMMOTH, 'mammoth');
      const { value } = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
      // Uploaded files are shown in a sandbox with no scripts.
      const frame = el('iframe', { class: 'tpl-frame', title: `${label} preview`, sandbox: '' });
      frame.srcdoc = `<!doctype html><meta charset="utf-8"><style>body{font:15px/1.5 Georgia,serif;color:#222;background:#fff;margin:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:6px;vertical-align:top}img{max-width:220px}</style>${value}`;
      body.replaceChildren(frame);
    }
    $('tpl-preview').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    body.replaceChildren(el('p', { class: 'fine', text: 'This preview couldn’t be shown. You can still download the file.' }));
  }
}

async function uploadTemplate(kind, file, message) {
  message.textContent = 'Checking the file…';
  message.className = 'tpl-msg';
  try {
    const { error, warnings = [] } = await checkTemplate(kind, file);
    if (error) { message.textContent = error; message.className = 'tpl-msg is-error'; return; }
    const saved = { name: file.name, blob: new Blob([file], { type: file.type }), savedAt: new Date().toISOString(), warnings };
    await templateStore('readwrite', (s) => s.put(saved, kind));
    planCustom[kind] = saved;
    clearPlanResults();
    renderTemplates();
  } catch (e) {
    message.textContent = 'This file couldn’t be saved in this browser.';
    message.className = 'tpl-msg is-error';
  }
}

async function restoreTemplate(kind) {
  try { await templateStore('readwrite', (s) => s.delete(kind)); } catch (e) { /* nothing was stored */ }
  delete planCustom[kind];
  clearPlanResults();
  renderTemplates();
}

function renderTemplates() {
  $('tpl-grid').replaceChildren(...PLAN_DOCS.map(([kind, label]) => {
    const custom = planCustom[kind];
    const excel = kind === 'report';
    const message = el('p', { class: 'tpl-msg', role: 'status' });
    const input = el('input', { type: 'file', accept: excel ? '.xlsx' : '.docx', hidden: true, 'aria-label': `Upload ${label} template`, id: `tpl-file-${kind}`,
      onchange: (e) => { if (e.target.files[0]) uploadTemplate(kind, e.target.files[0], message); e.target.value = ''; } });
    return el('article', { class: 'tpl-card' },
      el('h3', { text: label }),
      el('p', { class: 'tpl-meta', text: excel ? 'Excel template' : 'Word template' }),
      el('p', { class: 'tpl-version' }, custom ? el('strong', { text: 'Your template: ' }) : el('strong', { text: 'E-Logic default' }), custom ? custom.name : ''),
      (custom ? custom.warnings : []).map((text) => el('p', { class: 'tpl-msg is-warning', text })),
      message,
      el('div', { class: 'tpl-actions' },
        el('button', { class: 'btn btn-outline btn-sm', type: 'button', text: 'Preview', onclick: () => previewTemplate(kind, label) }),
        el('a', { class: 'btn btn-outline btn-sm', href: `${PLAN_DIR}templates/${PLAN_BLANKS[kind]}`, download: true, text: 'Download blank' }),
        custom ? el('button', { class: 'btn btn-outline btn-sm', type: 'button', text: 'Download yours', onclick: () => saveBlob(custom.blob, custom.name) }) : null,
        el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: 'Upload new', onclick: () => input.click() }),
        custom ? el('button', { class: 'btn-link', type: 'button', text: 'Restore default', onclick: () => restoreTemplate(kind) }) : null),
      input);
  }));
}

async function renderPlanner() {
  $('plan-tab-generate').addEventListener('click', () => { location.hash = 'planner'; });
  $('plan-tab-templates').addEventListener('click', () => { location.hash = 'planner/templates'; });
  $('tpl-preview-close').addEventListener('click', () => { $('tpl-preview').hidden = true; });
  await loadCustomTemplates();
  renderTemplates();
  try {
    planIndex = await (await fetch(`${PLAN_DIR}index.json`)).json();
  } catch (e) {
    $('plan-note').textContent = 'The course documents couldn’t be loaded.';
    $('plan-generate').disabled = true;
    return;
  }
  const rows = planSubjects();
  $('plan-program').append(el('option', { text: 'BBA' }));
  $('plan-sem').append(el('option', { value: '', text: 'All semesters' }),
    ...[...new Set(rows.map((c) => c.Semester))].map((s) => el('option', { value: s, text: `Semester ${s}` })));
  fillPlanSubjects();
  $('plan-note').textContent = `${plural(rows.length, 'sample subject')} available so far, with more to come. `
    + 'All documents are drafts for faculty review, and marks in the AoL Report are dummy data.';
  $('plan-sem').addEventListener('change', () => { fillPlanSubjects(); clearPlanResults(); });
  $('plan-subject').addEventListener('change', clearPlanResults);
  for (const [kind] of PLAN_DOCS) $(`plan-${kind}`).addEventListener('change', clearPlanResults);
  $('plan-generate').addEventListener('click', generatePlan);
  $('plan-zip').addEventListener('click', downloadPlanZip);
}

const newKb = () => ({ files: [], chunks: [], index: null, full: true, ready: null });
const newChat = () => ({ history: [], count: 0, asked: 0 });
const SOURCES = {
  elogic: { id: 'elogic', kb: newKb(), chat: newChat(), thread: 'chat-thread', welcome: 'chat-welcome', resume: 'resume-chat', resumeCount: 'resume-count',
    placeholder: 'Ask about subjects, credits, students, faculty, dates…', reading: 'Reading the handbook and master data',
    notFound: 'I couldn’t find this in the handbook or the master data.' },
  mine: { id: 'mine', kb: newKb(), chat: newChat(), thread: 'mine-thread', welcome: 'mine-welcome', resume: 'mine-resume', resumeCount: 'mine-resume-count',
    placeholder: 'Ask about your uploaded files…', reading: 'Reading your files',
    notFound: 'I couldn’t find this in your uploaded files.' },
};
let src = SOURCES.elogic;
let busy = false; // one question at a time, across both sources
let nextFileId = 1;

function defaultSettings() {
  const s = Object.fromEntries(Object.entries(engine.PARAMS).map(([k, p]) => [k, p.default]));
  return { ...s, max_answer_tokens: 2000, history_turns: 4 };
}
const settings = defaultSettings();
const chunkParams = () => ({ chunk_strategy: settings.chunk_strategy, chunk_size: settings.chunk_size, chunk_overlap: settings.chunk_overlap });
const describeFile = (f) => (f.parsed.tables && f.parsed.tables.length
  ? `${plural(f.parsed.tables.length, 'sheet')} · ${plural(f.parsed.units.length, 'row')}`
  : f.pages ? plural(f.pages, 'page') : plural(f.parsed.units.length, 'section'));

/** Reads one file into a source: parse, chunk, and add it. Search vectors are built later, only if needed. */
async function addToKb(kb, name, folder, buffer) {
  const parsed = await engine.parseFile(name, buffer);
  const record = { fileId: `f${nextFileId++}`, name, folder, pages: parsed.pages, parsed };
  kb.files.push(record);
  kb.chunks.push(...engine.chunkFile(record.fileId, record, parsed, chunkParams()));
  kb.full = kb.chunks.reduce((n, c) => n + c.text.length, 0) <= FULL_CONTEXT_LIMIT;
  return record;
}

function removeFromKb(kb, fileId) {
  kb.files = kb.files.filter((f) => f.fileId !== fileId);
  kb.chunks = kb.chunks.filter((c) => c.fileId !== fileId);
  if (kb.index) kb.index.removeFile(fileId);
  kb.full = kb.chunks.reduce((n, c) => n + c.text.length, 0) <= FULL_CONTEXT_LIMIT;
}

/** When a source is too big to send whole, embeds whatever isn't in its search index yet. The index
 *  always holds a prefix of kb.chunks in the same order, so new chunks are the tail. */
async function ensureIndex(kb) {
  if (kb.full) return;
  kb.index ||= new engine.VectorIndex();
  const todo = kb.chunks.slice(kb.index.size);
  if (!todo.length) return;
  showStatus('Preparing search over your files (the first time downloads a 34 MB model)…');
  kb.index.add(todo, await engine.embedPassages(todo.map((c) => c.text)));
  hideStatus();
}

/** Fetches, reads and chunks the two E-Logic documents once. */
function loadElogic() {
  const kb = SOURCES.elogic.kb;
  kb.ready ||= (async () => {
    for (const name of DOCS) {
      try {
        await addToKb(kb, name, '', await (await fetch(`docs/${name}`)).arrayBuffer());
      } catch (e) {
        throw new Error(`Couldn’t read ${name}: ${e.message}. Check your connection (the readers load from a CDN) and reload.`);
      }
    }
  })().catch((e) => { kb.ready = null; kb.files = []; kb.chunks = []; throw e; });
  return kb.ready;
}

// ================================================================== Ask E-Logic: your data (uploads)

const ACCEPT = [...engine.SUPPORTED, '.zip'];
const upload = { reading: false, failed: [] }; // failed: {name, error}

async function addUploads(fileList) {
  const files = [...fileList].filter((f) => !f.name.startsWith('.') && !f.name.startsWith('~$'));
  if (!files.length || upload.reading) return;
  const kb = SOURCES.mine.kb;
  upload.reading = true;
  renderUploads();
  const queue = [];
  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (lower.endsWith('.zip')) {
      if (f.size > engine.LIMITS.maxZipMb * 1024 * 1024) { upload.failed.push({ name: f.name, error: `zip larger than ${engine.LIMITS.maxZipMb} MB` }); continue; }
      try {
        const { entries, skipped } = await engine.expandZip(f.name, await f.arrayBuffer());
        for (const e of entries) queue.push({ name: e.name, folder: e.folder, read: async () => e.buffer });
        for (const sk of skipped) upload.failed.push({ name: sk.path, error: sk.reason });
      } catch (e) { upload.failed.push({ name: f.name, error: e.message }); }
    } else if (!engine.isSupported(f.name)) {
      upload.failed.push({ name: f.name, error: 'not a PDF, Word or Excel file' });
    } else if (f.size > engine.LIMITS.maxFileMb * 1024 * 1024) {
      upload.failed.push({ name: f.name, error: `larger than ${engine.LIMITS.maxFileMb} MB` });
    } else queue.push({ name: f.name, folder: '', read: () => f.arrayBuffer() });
  }
  const room = engine.LIMITS.maxFiles - kb.files.length;
  for (const extra of queue.splice(Math.max(0, room))) upload.failed.push({ name: extra.name, error: `file limit reached (${engine.LIMITS.maxFiles})` });
  let done = 0;
  for (const item of queue) {
    $('mine-progress').textContent = `Reading ${item.name} (${++done} of ${queue.length})…`;
    try {
      await addToKb(kb, item.name, item.folder, await item.read());
    } catch (e) {
      upload.failed.push({ name: item.name, error: e.message || 'could not read file' });
    }
    renderUploads();
  }
  upload.reading = false;
  renderUploads();
}

function renderUploads() {
  const kb = SOURCES.mine.kb;
  $('mine-progress').hidden = !upload.reading;
  $('mine-files').replaceChildren(...kb.files.map((f) => el('li', {},
    icon('file'), el('div', { class: 'up-name' }, el('strong', { text: f.folder ? `${f.folder}/${f.name}` : f.name }), el('small', { text: describeFile(f) })),
    el('button', { type: 'button', class: 'up-remove', 'aria-label': `Remove ${f.name}`, title: 'Remove',
      onclick: () => { removeFromKb(kb, f.fileId); renderUploads(); } }, icon('x')))));
  $('mine-failed').hidden = !upload.failed.length;
  $('mine-failed').replaceChildren(el('p', { class: 'qa-label', text: 'Not added' }),
    el('ul', {}, upload.failed.map((f) => el('li', { text: `${f.name}: ${f.error}` }))),
    el('button', { type: 'button', class: 'btn-link', text: 'Dismiss', onclick: () => { upload.failed = []; renderUploads(); } }));
  const n = kb.files.length;
  $('mine-count').textContent = n ? String(n) : '';
  $('mine-ready').hidden = !n;
  $('mine-ready-text').textContent = n ? `${plural(n, 'file')} ready. Answers will use only ${n === 1 ? 'this file' : 'these files'}.` : '';
  $('mine-clear').hidden = !n;
  paintHeaderFiles();
  updateComposer();
}

/** The header lists the uploaded files while "Your data" is selected and at least one file is ready. */
function paintHeaderFiles() {
  const { files } = SOURCES.mine.kb;
  const box = $('kb-mine');
  box.hidden = src.id !== 'mine' || !files.length;
  if (box.hidden) return;
  const shown = files.slice(0, 4);
  const rows = shown.map((f) => el('div', { class: 'kb-row', title: f.folder ? `${f.folder}/${f.name}` : f.name },
    icon('file'), el('span', { text: f.name }), el('em', { text: describeFile(f) })));
  if (files.length > shown.length) rows.push(el('p', { class: 'kb-more', text: `+ ${files.length - shown.length} more` }));
  box.replaceChildren(el('p', { class: 'kb-head', text: `Answering from your ${plural(files.length, 'file')}` }), ...rows);
}

function wireUploads() {
  const input = $('mine-input');
  input.accept = ACCEPT.join(',');
  input.addEventListener('change', () => { addUploads(input.files); input.value = ''; });
  const zone = $('mine-drop');
  for (const ev of ['dragenter', 'dragover']) zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('is-over'); });
  for (const ev of ['dragleave', 'drop']) zone.addEventListener(ev, () => zone.classList.remove('is-over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); addUploads(e.dataTransfer.files); });
  $('mine-clear').addEventListener('click', () => {
    const kb = SOURCES.mine.kb;
    for (const f of [...kb.files]) removeFromKb(kb, f.fileId);
    renderUploads();
  });
  $('mine-starters').replaceChildren(...[
    'Give me a short summary of each file.',
    'What sheets and columns does my spreadsheet have?',
    'What are the key numbers or dates in these files?',
    'List anything that looks inconsistent or missing.',
  ].map((q) => el('button', { class: 'chip-q', type: 'button', text: q, onclick: () => ask(q) })));
  renderUploads();
}

// ================================================================== Ask E-Logic: switching source

function switchSource(id) {
  src = SOURCES[id];
  for (const b of document.querySelectorAll('.source-tabs button')) b.setAttribute('aria-selected', String(b.dataset.source === id));
  paintHeaderFiles();
  for (const s of Object.values(SOURCES)) {
    $(s.thread).hidden = true;
    $(s.welcome).hidden = true;
  }
  hideStatus();
  $('question').placeholder = src.placeholder;
  if (src.chat.asked && !src.leftThread) showThread(); else showStart();
  updateComposer();
  session.set('elogic.source', id);
}

function updateComposer() {
  const empty = src.id === 'mine' && !src.kb.files.length;
  $('question').disabled = empty;
  $('send').disabled = empty || busy;
  if (empty) $('question').placeholder = 'Upload a file above to start asking';
  else $('question').placeholder = src.placeholder;
}

// ================================================================== Ask E-Logic: key and model

const readKey = () => session.get('localqa.apiKey') || local.get('localqa.apiKey') || '';
const readWorkspace = () => session.get('localqa.workspace') || local.get('localqa.workspace') || '';
function storeKey() {
  const key = $('api-key').value.trim();
  const ws = $('workspace').value.trim();
  const remember = $('remember-key').checked;
  session.set('localqa.apiKey', remember ? null : key || null);
  local.set('localqa.apiKey', remember ? key || null : null);
  session.set('localqa.workspace', remember ? null : ws || null);
  local.set('localqa.workspace', remember ? ws || null : null);
  $('key-status').textContent = key ? '' : 'No key yet.';
}
const model = () => $('model').value;

function wireKey() {
  const select = $('model');
  engine.MODELS.forEach((m) => select.append(el('option', { value: m, text: m })));
  select.value = engine.MODELS.includes(local.get('elogic.model')) ? local.get('elogic.model') : 'claude-sonnet-5';
  if (!select.value) select.selectedIndex = 0;
  select.addEventListener('change', () => local.set('elogic.model', select.value));
  $('api-key').value = readKey();
  $('workspace').value = readWorkspace();
  $('remember-key').checked = !!local.get('localqa.apiKey');
  for (const id of ['api-key', 'workspace']) $(id).addEventListener('change', storeKey);
  $('remember-key').addEventListener('change', storeKey);
  $('test-key').addEventListener('click', async () => {
    storeKey();
    const status = $('key-status');
    if (!readKey()) { status.textContent = 'Enter a key first.'; return; }
    status.textContent = 'Testing…';
    try {
      await engine.testKey(readKey(), readWorkspace());
      status.textContent = '✓ Key works';
    } catch (e) {
      status.textContent = e.message;
      if (e.code === 'needs_workspace' || e.code === 'bad_workspace') document.querySelector('.ws').open = true;
    }
  });
}

// ================================================================== Ask E-Logic: chat

function starterGroups() {
  const pickStudent = (pred) => data.students.find(pred) || data.students[0];
  const first = pickStudent((s) => s['Current Semester'] === 1);
  const second = pickStudent((s) => s['Current Semester'] === 3 && typeof s.CGPA === 'number');
  return [
    { who: 'Students', questions: [
      'What are my open elective options in Semester 3, and how is each one assessed?',
      'What happens if my attendance falls below 75%?',
      'How many credits do I need to graduate, and how are they split across semesters?'] },
    { who: 'Parents', questions: [
      `Who is the faculty mentor for ${first['Student Name']}, and how do I contact them?`,
      `What are the attendance, CGPA and fee status of ${second['Student Name']}?`,
      'When is the next Parent-Teacher Meeting, and when are fee instalments due?'] },
    { who: 'Faculty', questions: [
      'Which subjects does Dr. Kavya Reddy teach, and how many sessions are assigned?',
      'List the Year 2 students with attendance below 80%, with their mentors.',
      'How is a Workshop subject evaluated, and how many sessions per credit does it get?'] },
    { who: 'Dean', questions: [
      'Chart the number of students by home state.',
      'Which faculty are above their faculty credit hour goal, and by how much?',
      'Which students have fees due or partially paid, and who are their mentors?'] },
  ];
}

function renderStarters() {
  $('starters').replaceChildren(...starterGroups().map((g) => el('div', { class: 'starter-group' }, el('h3', { text: g.who }),
    g.questions.map((q) => el('button', { class: 'chip-q', type: 'button', text: q, onclick: () => ask(q) })))));
}

function openAsk() {
  loadElogic().catch((e) => { if (src.id === 'elogic') showStatus(e.message, true); });
  setTimeout(() => $('question').focus({ preventScroll: true }), 50);
}

function showStatus(text, error = false) {
  const s = $('chat-status');
  s.textContent = text;
  s.classList.toggle('is-error', error);
  s.hidden = false;
}
const hideStatus = () => { $('chat-status').hidden = true; };

const botBubble = (...children) => el('div', { class: 'msg-bot' },
  el('span', { class: 'bot-avatar', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'), el('b')),
  el('div', { class: 'msg-bot-body' }, ...children));

/** Builds the prompt with the Local Q&A engine, then moves the documents into a cached system block so
 *  follow-up questions reuse them instead of paying for them again. */
function buildRequest(source, question, hits, history) {
  const { kb } = source;
  const catalog = engine.chartCatalog(kb.files);
  const { system, messages } = engine.buildPrompt(question, hits, history, settings, catalog, kb.full);
  const last = messages[messages.length - 1].content;
  const cut = last.lastIndexOf('\n\nQuestion: ');
  const documents = last.slice(0, cut);
  const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const persona = source.id === 'elogic'
    ? 'You are Ask E-Logic, the assistant for the BBA programme at E-Logic School of Business (a fictitious institution). '
      + 'You help students, parents and guardians, faculty and the Dean. The documents are the BBA Student Handbook 2026-27 (PDF) '
      + 'and the BBA master data workbook, with the sheets Curriculum Master, Student Master, Faculty Master and Faculty Utilization. '
      + 'Faculty Utilization has one row per section taught in 2026-27; it links to Faculty Master by Faculty ID and to Curriculum Master '
      + 'by Subject Code, and each section consumes the subject’s credits, sessions and faculty credit hours, so a professor’s load is the sum '
      + 'of their rows. The Assumptions sheet gives the rule: 1 credit = 10 sessions of 75 minutes = 12.5 hours taught = 15 faculty credit '
      + 'hours; each faculty member’s goal is 150 faculty credit hours per academic year, and Utilization % in the Faculty Master is faculty '
      + 'credit hours divided by the goal. '
    : 'You are Ask E-Logic, answering questions about files the user uploaded. The documents below are the only source: '
      + `${kb.files.map((f) => f.name).join(', ')}. Do not use anything you may know about E-Logic School of Business, its handbook `
      + 'or its data, and do not use outside knowledge; if the uploaded files don’t answer the question, say so. ';
  return {
    system: [
      { type: 'text', text: `${persona}Today is ${today}; use it for questions about what is next or coming up. Be warm and direct. `
        + system.replace('provided in their message', 'provided below') },
      { type: 'text', text: documents, cache_control: { type: 'ephemeral' } },
    ],
    messages: [...messages.slice(0, -1), { role: 'user', content: last.slice(cut + 2) }],
  };
}

async function ask(question) {
  question = (question || '').trim();
  if (!question || busy) return;
  const source = src; // the answer belongs to this source even if the visitor switches tabs meanwhile
  const { kb, chat } = source;
  if (source.id === 'mine' && !kb.files.length) { showStatus('Upload a file first. Answers here use only your files.', true); return; }
  storeKey();
  if (!readKey()) {
    showStatus('Add your Anthropic API key on the left, then press send.', true);
    $('question').value = question; // keep the question so it isn't lost
    autoGrow();
    $('api-key').focus();
    return;
  }
  busy = true;
  updateComposer();
  hideStatus();
  source.leftThread = false;
  showThread();
  const log = $('chat-log');
  const thread = $(source.thread);
  thread.append(el('div', { class: 'msg-user', text: question }));
  $('question').value = '';
  autoGrow();
  const live = el('div', { class: 'answer' }, el('span', { class: 'typing', text: source.reading }));
  const bubble = botBubble(live);
  thread.append(bubble);
  bubble.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  try {
    if (source.id === 'elogic') await loadElogic();
    await ensureIndex(kb);
    const history = chat.history.slice(-2 * settings.history_turns);
    const hits = kb.full ? kb.chunks.map((chunk) => ({ chunk, score: 1 }))
      : kb.index.search(await engine.queryVector(question, history), settings);
    const { system, messages } = buildRequest(source, question, hits, history);
    let text = '';
    const result = await engine.streamAnswer({
      apiKey: readKey(), workspaceId: readWorkspace(), model: model(), system, messages, settings,
      tools: [engine.CHART_TOOL, engine.CALC_TOOL, engine.NOT_FOUND_TOOL],
      onCalculate: (input) => charts.computeTable(input, kb.files),
    }, (delta) => {
      text += delta;
      live.classList.add('streaming');
      live.textContent = text;
      if (src === source) log.scrollTop = log.scrollHeight;
    });
    const rec = toRecord(source, text, hits, result);
    bubble.replaceWith(renderRecord(source, rec));
    chat.history.push({ role: 'user', content: question }, { role: 'assistant', content: historyEntry(source, rec, text) });
    chat.history = chat.history.slice(-20);
    chat.asked += 1;
    if (src === source) $('chat-bar-title').textContent = `Conversation · ${plural(chat.asked, 'question')}`;
  } catch (e) {
    hideStatus();
    live.classList.remove('streaming');
    live.replaceChildren(el('p', { class: 'error', text: e.message || 'Something went wrong.' }),
      el('button', { type: 'button', class: 'btn-link', text: 'Try again', onclick: () => { bubble.previousSibling.remove(); bubble.remove(); ask(question); } }));
    if (e.code === 'invalid_api_key') $('api-key').focus();
    if (e.code === 'needs_workspace' || e.code === 'bad_workspace') document.querySelector('.ws').open = true;
  } finally {
    busy = false;
    updateComposer();
  }
}

function toRecord(source, text, hits, { notes, chart, calcs, usage, stopReason, notFound }) {
  const { kb } = source;
  const id = `${source.id}-${++source.chat.count}`;
  const meta = { model: model(), mode: kb.full ? `${plural(kb.files.length, 'document')} in full` : 'Best-matching passages', excerpts: hits.length,
    calculations: calcs.length, tokensIn: usage.input, tokensOut: usage.output, stopReason, reply: text };
  const tables = calcs.filter((c) => c.ok).map((c) => c.table);
  const source_ = (n) => ({ n, chunk: hits[n - 1].chunk, score: hits[n - 1].score });
  const cited = [...new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))].filter((n) => n >= 1 && n <= hits.length).sort((a, b) => a - b);
  const full = kb.full;
  if (chart) {
    const prepared = charts.prepareChart(chart, kb.files, hits, engine.sourceLabel);
    if (prepared.ok) {
      const refs = [...new Set(prepared.chart.series.flatMap((s) => s.refs || []))];
      return { kind: 'chart', id, full, text, notes, tables, meta, chart: prepared.chart, status: 'proposed',
        sources: [...new Set([...cited, ...refs])].sort((a, b) => a - b).map(source_) };
    }
    notes.push(`I couldn’t prepare that chart: ${prepared.error}. Try naming the sheet and column.`);
  }
  if (notFound || (engine.isNotFound(text) && !tables.length)) {
    return { kind: 'notfound', id, meta, missing: notFound && notFound.missing ? String(notFound.missing) : '',
      checks: notFound && Array.isArray(notFound.checks) ? notFound.checks.filter((c) => c && c.document) : [] };
  }
  const shown = cited.length || full ? cited : hits.map((_, i) => i + 1);
  return { kind: 'answer', id, full, text, notes, tables, meta, sources: shown.map(source_) };
}

function historyEntry(source, rec, text) {
  if (rec.kind === 'chart') return `${text.trim()}\n[Proposed a ${rec.chart.type} chart “${rec.chart.title}”; waiting for the user to confirm.]`;
  return rec.kind === 'notfound' ? engine.NOT_FOUND : text.trim() || '(answer)';
}

function renderRecord(source, rec) {
  if (rec.kind === 'notfound') {
    const body = [el('div', { class: 'answer' }, el('p', {}, el('strong', { text: source.notFound }),
      rec.missing ? el('br') : null, rec.missing ? el('span', { class: 'qa-help', text: rec.missing }) : null))];
    if (rec.checks.length) {
      body.push(el('details', { class: 'qa-calc' }, el('summary', { text: 'How I checked' }), el('div', { class: 'qa-table-wrap' }, el('table', { class: 'qa-table' },
        el('tbody', {}, rec.checks.map((c) => el('tr', {}, el('th', { text: String(c.document) }), el('td', { text: String(c.reason || '') }))))))));
    }
    const b = botBubble(...body, meta(rec));
    b.querySelector('.msg-bot-body').classList.add('notfound');
    return b;
  }
  const count = rec.sources.length ? Math.max(...rec.sources.map((s) => s.n)) : 0;
  return botBubble(
    rec.text && rec.text.trim() ? el('div', { class: 'answer' }, formatAnswer(rec.text, rec.id, count)) : null,
    (rec.notes || []).filter((n) => !/whole-documents|temperature/.test(n)).map((n) => el('p', { class: 'note' }, icon('info'), n)),
    rec.kind === 'chart' ? chartBlock(rec) : null,
    rec.tables.length ? calcTables(rec.tables) : null,
    rec.sources.length ? sources(rec.sources, rec.id, rec.full) : null,
    meta(rec));
}

function meta(rec) {
  const m = rec.meta;
  const rows = [['Model', m.model], ['Read', `${m.mode} (${plural(m.excerpts, 'excerpt')})`],
    ['Calculations', m.calculations ? `${m.calculations} run by the page` : 'None'],
    ['Tokens', `${(m.tokensIn || 0).toLocaleString()} in · ${(m.tokensOut || 0).toLocaleString()} out`], ['Finished because', m.stopReason || '-']];
  return el('details', { class: 'qa-meta' }, el('summary', { text: 'About this answer' }),
    el('table', { class: 'qa-table qa-table-settings' }, el('tbody', {}, rows.map(([k, v]) => el('tr', {}, el('th', { text: k }), el('td', { text: v }))))),
    el('pre', { class: 'qa-raw', text: m.reply || '(no text)' }));
}

function calcTables(tables) {
  const d = el('details', { class: 'qa-calc' }, el('summary', { text: `Exact figures calculated by the page (${tables.length})` }));
  for (const t of tables) { const { settings: s, data: rows } = charts.renderTables(t, { limit: 100 }); d.append(s, rows); }
  return d;
}

function chartBlock(rec) {
  const box = el('div', { class: 'qa-chart-block' });
  const { settings: s, data: rows } = charts.renderTables(rec.chart);
  const redraw = () => box.replaceWith(chartBlock(rec));
  if (rec.status === 'proposed') {
    box.append(el('p', { class: 'qa-chart-ask' }, el('strong', { text: 'Here’s what I’d plot. ' }), 'Check the data, then confirm.'), s, rows,
      el('div', { class: 'qa-row qa-chart-confirm' },
        el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => { rec.status = 'plotted'; redraw(); } }, 'Plot chart'),
        el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => { rec.status = 'cancelled'; redraw(); } }, 'Cancel')));
  } else if (rec.status === 'plotted') {
    box.append(charts.renderChart(rec.chart), el('details', { class: 'qa-chart-data' }, el('summary', { text: 'Show data table' }), s, rows));
  } else box.append(el('p', { class: 'qa-help', text: `Chart “${rec.chart.title}” cancelled.` }));
  return box;
}

/** Safe minimal formatting: paragraphs, bullets, Markdown tables, **bold**, and [n] citation chips. */
function formatAnswer(text, msgId, sourceCount) {
  const inline = (line) => {
    const out = [];
    const re = /\*\*(.+?)\*\*|\[(\d+)\]/g;
    let last = 0;
    let m;
    while ((m = re.exec(line))) {
      if (m.index > last) out.push(line.slice(last, m.index));
      if (m[1]) out.push(el('strong', { text: m[1] }));
      else if (Number(m[2]) >= 1 && Number(m[2]) <= sourceCount) out.push(el('a', { class: 'cite', href: `#src-${msgId}-${m[2]}`, text: m[2], 'aria-label': `Source ${m[2]}`, onclick: jumpToSource }));
      else out.push(m[0]);
      last = re.lastIndex;
    }
    if (last < line.length) out.push(line.slice(last));
    return out;
  };
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const isRule = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
  return text.trim().split(/\n\s*\n/).flatMap((para) => {
    const lines = para.split('\n');
    const ruleAt = lines.findIndex((l, i) => i > 0 && isRule(l) && lines[i - 1].includes('|'));
    if (ruleAt > 0) {
      const head = cells(lines[ruleAt - 1]);
      const rows = lines.slice(ruleAt + 1).filter((l) => l.includes('|')).map(cells);
      const before = lines.slice(0, ruleAt - 1).join('\n').trim();
      const table = el('div', { class: 'qa-table-wrap qa-answer-table' }, el('table', { class: 'qa-table' },
        el('thead', {}, el('tr', {}, head.map((c) => el('th', {}, inline(c))))),
        el('tbody', {}, rows.map((r) => el('tr', {}, head.map((_, i) => el('td', {}, inline(r[i] || ''))))))));
      return before ? [el('p', {}, ...inline(before)), table] : [table];
    }
    if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) return el('ul', {}, lines.map((l) => el('li', {}, inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, '')))));
    const p = el('p');
    lines.forEach((l, i) => { if (i) p.append(el('br')); p.append(...inline(l.replace(/^#{1,4}\s+/, ''))); });
    return p;
  });
}

// Citation links must not trigger the hash router, so scroll to the source by hand.
function jumpToSource(e) {
  e.preventDefault();
  const target = document.getElementById(e.currentTarget.getAttribute('href').slice(1));
  if (!target) return;
  const list = target.closest('ol');
  if (list && list.hidden) list.previousSibling.click();
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.animate([{ background: 'var(--orange-soft)' }, { background: 'transparent' }], { duration: 1600 });
}

function where(c) {
  if (c.sheet != null) return `sheet “${c.sheet}” · ${c.rowStart === c.rowEnd ? `row ${c.rowStart}` : `rows ${c.rowStart}–${c.rowEnd}`}`;
  if (c.page) return `page ${c.page}`;
  return '';
}

function sources(list, msgId, full) {
  const ol = el('ol', { hidden: true }, list.map(({ n, chunk, score }) => el('li', { id: `src-${msgId}-${n}` },
    el('span', { class: 'cite', text: String(n) }),
    el('div', {}, el('div', { class: 'where' }, chunk.fileName, where(chunk) ? ` · ${where(chunk)}` : '',
      full ? null : el('span', { class: 'score', text: ` · match ${score.toFixed(2)}` })),
    el('blockquote', { text: chunk.text })))));
  const toggle = el('button', { type: 'button', class: 'btn-link', 'aria-expanded': 'false',
    onclick: () => { ol.hidden = !ol.hidden; toggle.setAttribute('aria-expanded', String(!ol.hidden)); } },
  `Sources (${list.length})`, icon('down', 'chev-sm'));
  return el('div', { class: 'sources' }, toggle, ol);
}

/** The current source's conversation, with a bar to go back to its start screen or start over. */
function showThread() {
  src.leftThread = false;
  $(src.welcome).hidden = true;
  $(src.thread).hidden = false;
  $('chat-bar').hidden = false;
  $('chat-bar-title').textContent = src.chat.asked ? `Conversation · ${plural(src.chat.asked, 'question')}` : 'Conversation';
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
}

/** Back to the current source's start screen. The conversation is kept, and can be resumed or continued. */
function showStart() {
  const has = $(src.thread).children.length > 0;
  if (has) src.leftThread = true;
  $(src.thread).hidden = true;
  $('chat-bar').hidden = true;
  $(src.welcome).hidden = false;
  $(src.resume).hidden = !has;
  $(src.resumeCount).textContent = has ? `${plural(src.chat.asked, 'question')} so far · new questions continue it` : '';
  $('chat-log').scrollTop = 0;
}

function autoGrow() {
  const t = $('question');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 180)}px`;
}

function wireChat() {
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); ask($('question').value); });
  $('question').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask($('question').value); }
  });
  $('question').addEventListener('input', autoGrow);
  $('chat-back').addEventListener('click', showStart);
  for (const s of Object.values(SOURCES)) $(s.resume).addEventListener('click', showThread);
  $('new-chat').addEventListener('click', () => {
    if (busy) return;
    Object.assign(src.chat, { history: [], asked: 0 });
    $(src.thread).replaceChildren();
    src.leftThread = false;
    showStart();
  });
  for (const b of document.querySelectorAll('.source-tabs button')) b.addEventListener('click', () => switchSource(b.dataset.source));
}

// ================================================================== start

function wireChrome() {
  const toggle = $('nav-toggle');
  toggle.addEventListener('click', () => {
    const open = $('primary-nav').classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  const head = $('masthead');
  addEventListener('scroll', () => head.classList.toggle('is-scrolled', scrollY > 10), { passive: true });
}

async function start() {
  wireChrome();
  wireKey();
  wireChat();
  wireUploads();
  try {
    data = await (await fetch('site-data.json')).json();
  } catch (e) {
    document.querySelector('main').prepend(el('p', { class: 'chat-status is-error', text: 'Couldn’t load site-data.json. Serve this folder over HTTP (python3 -m http.server) rather than opening the file directly.' }));
    return;
  }
  document.querySelectorAll('[data-total-credits]').forEach((n) => { n.textContent = data.totalCredits; });
  renderStructure();
  renderCurriculum();
  renderFaculty();
  renderStudents();
  renderPlanner();
  renderStarters();
  switchSource(session.get('elogic.source') === 'mine' ? 'mine' : 'elogic');
  addEventListener('hashchange', route);
  route();
}

start();
