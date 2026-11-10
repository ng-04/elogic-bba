// E-Logic BBA. The site opens on Ask E-Logic, a cited answer bot over the handbook PDF and the
// master-data workbook; the other pages (hash routes) are rendered from site-data.json. The bot uses
// the Local Q&A engine in lib/: documents are read in this browser, and questions go straight to
// Anthropic with the visitor's own key.
import * as engine from './lib/engine.js';
import * as charts from './lib/qa-chart.js';
import * as alloc from './lib/allocation.js';

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
// The two documents are about 270k characters; sending them whole (prompt-cached) beats retrieval for
// "list every…" and "how many…" questions. Past this size the bot falls back to best-matching passages.
const FULL_CONTEXT_LIMIT = 340000;

let data = null;

// ================================================================== routing

const VIEWS = ['ask', 'programme', 'curriculum', 'faculty', 'students', 'handbook', 'planner', 'scheduling'];
let curSem = 0; // 0 = all semesters

function route() {
  const [view, sub] = location.hash.replace(/^#/, '').split('/');
  const name = VIEWS.includes(view) ? view : 'ask';
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== name;
  for (const a of document.querySelectorAll('.primary-nav a[data-route]')) a.classList.toggle('is-current', a.dataset.route === name);
  $('primary-nav').classList.remove('is-open');
  $('nav-toggle').setAttribute('aria-expanded', 'false');
  $('fab').hidden = name === 'ask';
  if (name === 'curriculum' && sub && /^[1-8]$/.test(sub)) { curSem = Number(sub); renderCurriculum(); }
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
  const elective = { 3: 'Choose 1 open elective (2 credits) of 3', 4: 'Choose 1 open elective (2 credits) of 3', 5: '2 subjects (8 credits) of your specialisation', 6: '2 subjects (8 credits) of your specialisation',
    7: 'Choose 4 advanced electives (16 credits)', 8: 'Choose 4 advanced electives (16 credits)' };
  const rows = [...bySem.entries()].map(([sem, s]) => {
    const earned = s.coreCredits + (sem >= 7 ? 16 : sem >= 5 ? 8 : sem >= 3 ? 2 : 0);
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
    ['All', 1, 2, 3, 4, 5, 6, 7, 8].forEach((s, i) => tabs.append(el('button', { role: 'tab', type: 'button', text: i ? `Sem ${s}` : s,
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

// What the odd semester asks of a timetable, from Faculty Utilization. The tab itself is still to come.
function renderScheduling() {
  const tabs = { alloc: $('sch-tab-alloc'), overview: $('sch-tab-overview') };
  for (const [name, button] of Object.entries(tabs)) {
    button.onclick = () => {
      for (const [other, b] of Object.entries(tabs)) { b.setAttribute('aria-selected', String(other === name)); $(`sch-panel-${other}`).hidden = other !== name; }
    };
  }
  renderAllocation();
  const term = data.facultyUtilization.filter((u) => u.Status === 'Ongoing');
  const sum = (key) => term.reduce((n, u) => n + u[key], 0);
  $('sch-note').textContent = `${term[0].Term}: Semesters ${[...new Set(term.map((u) => u.Semester))].join(', ')}.`;
  $('sch-kpis').replaceChildren(kpi(term.length, 'sections to timetable'), kpi(sum('Number of Sessions').toLocaleString('en-IN'), 'class sessions this term'),
    kpi(new Set(term.map((u) => u['Faculty ID'])).size, 'faculty teaching'), kpi(new Set(term.map((u) => u.Batch)).size, 'batches'),
    kpi(sum('Students').toLocaleString('en-IN'), 'student seats across sections'));
}


// ------------------------------------------------------------------ faculty allocation solver

const ALLOC_KEY = 'elogic-allocation-v1';
const BAND_NAMES = () => allocState.input.bands.map((b) => b.band);
const shortTerm = (term) => String(term).split(' ')[0];
let allocState = null;

function masterAllocationInput() {
  const extra = new Map(data.allocation.faculty.map((f) => [f.id, f]));
  return {
    source: `Master data ${data.academicYear}`,
    sections: data.facultyUtilization.map((u) => ({ term: shortTerm(u.Term), semester: u.Semester, batch: u.Batch, code: u['Subject Code'], subject: u.Subject,
      area: u['Subject Area'], type: u.Type, section: u.Section, students: u.Students, credits: u.Credits, hours: u['Faculty Credit Hours'],
      current: u['Faculty ID'], locked: '', barred: [], label: `${u['Subject Code']} ${u.Section} (${shortTerm(u.Term)})`, row: u })),
    faculty: data.faculty.map((f) => ({ id: f.id, name: f.name, area: f.area, designation: f.designation, role: f.role, ...extra.get(f.id) })),
    bands: data.allocation.bands.map((b) => ({ ...b })),
  };
}

function loadAllocState() {
  const fresh = () => ({ input: masterAllocationInput(), constraints: { ...alloc.DEFAULT_CONSTRAINTS }, objective: alloc.defaultObjective(), result: null, onlyChanged: false, term: '', area: '' });
  try {
    const saved = JSON.parse(localStorage.getItem(ALLOC_KEY) || 'null');
    if (saved && saved.input && saved.input.sections) return { ...fresh(), ...saved, result: null };
  } catch (e) { /* storage blocked: start from the master data */ }
  return fresh();
}

function saveAllocState() {
  try {
    const { input, constraints, objective } = allocState;
    localStorage.setItem(ALLOC_KEY, JSON.stringify({ input: { ...input, sections: input.sections.map(({ row, ...rest }) => rest) }, constraints, objective }));
  } catch (e) { /* storage blocked: changes last for this visit */ }
}

// Any edit makes the last result stale.
function allocChanged() {
  allocState.result = null;
  saveAllocState();
  paintAllocSummary();
  paintAllocResults();
}

function renderAllocation() {
  allocState ||= loadAllocState();
  const root = $('sch-panel-alloc');
  const fileInput = el('input', { type: 'file', accept: '.xlsx', hidden: true, id: 'alloc-file', onchange: (e) => { if (e.target.files[0]) uploadAllocInput(e.target.files[0]); e.target.value = ''; } });
  root.replaceChildren(
    el('p', { class: 'fine plan-intro', text: 'Each section gets one professor. The solver searches for the allocation with the lowest objective that keeps every rule you switch on. '
      + 'It starts from the current allocation in the master data, so you can see what changes and why. Your settings stay in this browser.' }),
    el('div', { class: 'kpis', id: 'alloc-kpis' }),
    el('section', { class: 'alloc-card' },
      el('h3', { text: 'Inputs' }),
      el('p', { id: 'alloc-source', class: 'fine' }),
      el('div', { class: 'tpl-actions' },
        el('button', { class: 'btn btn-outline btn-sm', type: 'button', id: 'alloc-template', onclick: downloadAllocInput }, icon('download'), ' Download input workbook'),
        el('button', { class: 'btn btn-outline btn-sm', type: 'button', id: 'alloc-upload', onclick: () => fileInput.click() }, icon('upload'), ' Upload input workbook'),
        el('button', { class: 'btn-link', type: 'button', id: 'alloc-reset', text: 'Reset to master data and default settings', onclick: () => {
          if (!confirm('Reset every setting and edit to the master data?')) return;
          try { localStorage.removeItem(ALLOC_KEY); } catch (e) { /* nothing stored */ }
          allocState = null;
          renderAllocation();
        } })),
      el('p', { class: 'tpl-msg', id: 'alloc-msg', role: 'status' }), fileInput),
    el('div', { class: 'alloc-split' }, objectiveCard(), constraintsCard()),
    bandsCard(),
    facultyCard(),
    sectionsCard(),
    el('div', { class: 'alloc-run' },
      el('button', { class: 'btn btn-primary', type: 'button', id: 'alloc-solve', text: 'Solve', onclick: runAllocation }),
      el('span', { class: 'fine', id: 'alloc-status', role: 'status' })),
    el('div', { id: 'alloc-checks' }),
    el('div', { id: 'alloc-results' }));
  paintAllocSummary();
  paintAllocResults();
}

function paintAllocSummary() {
  const { input, constraints } = allocState;
  const check = alloc.diagnose(input, constraints);
  const terms = alloc.termsOf(input.sections);
  $('alloc-kpis').replaceChildren(
    kpi(input.sections.length, `sections (${terms.map((t) => `${input.sections.filter((s) => s.term === t).length} ${t}`).join(', ')})`),
    kpi(input.faculty.filter((f) => f.available !== false).length, 'professors available'),
    kpi(check.demand.toLocaleString('en-IN'), 'teaching hours needed'),
    kpi(check.capacity.toLocaleString('en-IN'), 'hours the bands allow'),
    kpi(Math.max(0, check.demand - check.capacity).toLocaleString('en-IN'), 'hours of overload that can’t be avoided'));
  $('alloc-source').replaceChildren(el('strong', { text: 'Data: ' }), `${input.source}. ${plural(input.sections.length, 'section')}, ${plural(input.faculty.length, 'professor')} and ${plural(input.bands.length, 'hour band')}. `
    + 'Hours are faculty credit hours: each section’s teaching, preparation and assessment.');
  const box = $('alloc-checks');
  box.replaceChildren(...check.errors.map((t) => el('p', { class: 'tpl-msg is-error', text: t })), ...check.warnings.map((t) => el('p', { class: 'tpl-msg is-warning', text: t })));
}

function numInput(value, onchange, attrs = {}) {
  return el('input', { type: 'number', class: 'alloc-num', value: value === '' || value == null ? '' : String(value), onchange: (e) => onchange(e.target.value === '' ? '' : Number(e.target.value)), ...attrs });
}

function objectiveCard() {
  const { objective } = allocState;
  const formula = el('p', { class: 'alloc-formula', id: 'alloc-formula' });
  const paint = () => {
    const parts = alloc.OBJECTIVE_TERMS.filter((t) => objective[t.key].on && Number(objective[t.key].weight)).map((t) => `${objective[t.key].weight} × ${t.label.toLowerCase().replace(/ \(.*\)/, '')}`);
    formula.textContent = parts.length ? `Minimise ${parts.join(' + ')}` : 'No objective is switched on, so any allocation that keeps the rules will do.';
  };
  paint();
  return el('section', { class: 'alloc-card' },
    el('h3', { text: 'Objective function' }),
    el('p', { class: 'fine', text: 'What the solver minimises. Switch terms on or off and set their weights: a weight is how many hours of overload one unit of that term is worth.' }),
    el('div', { class: 'table-card table-scroll' }, el('table', { class: 'dt dt-compact alloc-table alloc-wrap' },
      el('thead', {}, el('tr', {}, ['Use', 'Term', 'Weight', 'Unit'].map((h) => el('th', { text: h })))),
      el('tbody', {}, alloc.OBJECTIVE_TERMS.map((t) => el('tr', {},
        el('td', {}, el('input', { type: 'checkbox', id: `alloc-obj-${t.key}`, checked: objective[t.key].on, 'aria-label': `Use ${t.label}`, onchange: (e) => { objective[t.key].on = e.target.checked; paint(); allocChanged(); } })),
        el('td', { text: t.label }),
        el('td', {}, numInput(objective[t.key].weight, (v) => { objective[t.key].weight = v === '' ? 0 : Math.max(0, v); paint(); allocChanged(); }, { min: 0, step: 'any', id: `alloc-w-${t.key}`, 'aria-label': `Weight for ${t.label}` })),
        el('td', { class: 'fine', text: t.unit })))))),
    formula);
}

function constraintsCard() {
  const c = allocState.constraints;
  const set = (key, value) => { c[key] = value; allocChanged(); };
  const check = (key, label, id) => el('label', { class: 'alloc-check' }, el('input', { type: 'checkbox', id, checked: !!c[key], onchange: (e) => set(key, e.target.checked) }), ` ${label}`);
  return el('section', { class: 'alloc-card' },
    el('h3', { text: 'Constraints' }),
    el('p', { class: 'fine', text: 'Rules every allocation must keep. Per-professor limits in the faculty table override the defaults here.' }),
    el('ul', { class: 'alloc-rules' },
      el('li', {}, el('label', { class: 'alloc-check' }, el('input', { type: 'checkbox', checked: true, disabled: true }), ' Every section gets exactly one professor')),
      el('li', {}, 'Bands are checked over ', el('select', { id: 'alloc-basis', onchange: (e) => set('basis', e.target.value) },
        el('option', { value: 'annual', text: 'the academic year', selected: c.basis === 'annual' }), el('option', { value: 'term', text: 'each term (half the band)', selected: c.basis === 'term' }))),
      el('li', {}, 'Sections per professor per term: at least ', numInput(c.minSections, (v) => set('minSections', v === '' ? 0 : v), { min: 0, max: 10, id: 'alloc-min-sec', 'aria-label': 'Minimum sections per term' }),
        ' and at most ', numInput(c.maxSections, (v) => set('maxSections', v === '' ? 3 : v), { min: 1, max: 10, id: 'alloc-max-sec', 'aria-label': 'Maximum sections per term' })),
      el('li', {}, check('areaRule', 'Professors teach only in their own area', 'alloc-area')),
      el('li', { class: 'alloc-sub' }, check('exceptions', '… or in the areas listed as “also teaches”', 'alloc-exceptions')),
      el('li', {}, check('locks', 'Give each section to the professor who must teach it', 'alloc-locks')),
      el('li', {}, check('bars', 'Keep excluded professors off a section', 'alloc-bars')),
      el('li', {}, check('availability', 'Give no sections to professors marked unavailable', 'alloc-avail')),
      el('li', {}, check('hardCap', 'Hard cap: no one more than', 'alloc-cap'), ' ', numInput(c.capHours, (v) => set('capHours', v === '' ? 0 : v), { min: 0, step: 15, id: 'alloc-cap-hours', 'aria-label': 'Hours above the maximum' }), ' hours above their maximum')));
}

function bandsCard() {
  const { bands } = allocState.input;
  const table = el('table', { class: 'dt dt-compact alloc-table' },
    el('thead', {}, el('tr', {}, ['Band', 'Minimum hours', 'Maximum hours', 'Professors'].map((h) => el('th', { text: h })))),
    el('tbody', {}, bands.map((b) => el('tr', {},
      el('td', {}, el('strong', { text: b.band })),
      el('td', {}, numInput(b.min, (v) => { b.min = v === '' ? 0 : v; allocChanged(); }, { min: 0, step: 15, 'aria-label': `${b.band} minimum hours` })),
      el('td', {}, numInput(b.max, (v) => { b.max = v === '' ? 0 : v; allocChanged(); }, { min: 0, step: 15, 'aria-label': `${b.band} maximum hours` })),
      el('td', { class: 'num', text: String(allocState.input.faculty.filter((f) => f.band === b.band).length) })))));
  return el('details', { class: 'alloc-card alloc-details' }, el('summary', {}, el('h3', { text: 'Hour bands' }), el('span', { class: 'fine', text: 'Teaching hours a year for each band. Dummy defaults: lighter loads for academic leaders.' })),
    el('div', { class: 'table-card' }, table));
}

function facultyCard() {
  const { faculty } = allocState.input;
  const areas = [...new Set([...allocState.input.sections.map((s) => s.area), ...faculty.map((f) => f.area)])].sort();
  const message = el('p', { class: 'tpl-msg', role: 'status' });
  const rows = faculty.map((f) => {
    const { min, max } = alloc.limitsOf(f, allocState.input.bands);
    const edit = (key) => (v) => { f[key] = v; allocChanged(); };
    return el('tr', {},
      el('td', {}, el('strong', { text: f.id })),
      el('td', { text: f.name }),
      el('td', { text: f.area }),
      el('td', {}, el('select', { 'aria-label': `${f.id} band`, onchange: (e) => { f.band = e.target.value; allocChanged(); renderAllocation(); } },
        BAND_NAMES().map((b) => el('option', { value: b, text: b, selected: b === f.band })))),
      el('td', {}, numInput(f.minHours, edit('minHours'), { placeholder: String(min), min: 0, step: 15, 'aria-label': `${f.id} minimum hours` })),
      el('td', {}, numInput(f.maxHours, edit('maxHours'), { placeholder: String(max), min: 0, step: 15, 'aria-label': `${f.id} maximum hours` })),
      el('td', {}, numInput(f.minSections, edit('minSections'), { placeholder: String(allocState.constraints.minSections), min: 0, 'aria-label': `${f.id} minimum sections per term` })),
      el('td', {}, numInput(f.maxSections, edit('maxSections'), { placeholder: String(allocState.constraints.maxSections), min: 0, 'aria-label': `${f.id} maximum sections per term` })),
      el('td', {}, el('input', { type: 'checkbox', checked: f.available !== false, 'aria-label': `${f.id} available`, onchange: (e) => { f.available = e.target.checked; allocChanged(); } })),
      el('td', {}, el('input', { type: 'text', class: 'alloc-text', value: (f.alsoTeaches || []).join(', '), list: 'alloc-areas', 'aria-label': `${f.id} also teaches`,
        onchange: (e) => {
          const list = e.target.value.split(',').map((t) => t.trim()).filter(Boolean);
          const unknown = list.filter((a) => !areas.includes(a));
          if (unknown.length) { message.textContent = `Unknown area: ${unknown.join(', ')}. Use one of: ${areas.join(', ')}.`; message.className = 'tpl-msg is-error'; return; }
          message.textContent = '';
          f.alsoTeaches = list.filter((a) => a !== f.area);
          allocChanged();
        } })));
  });
  return el('details', { class: 'alloc-card alloc-details' },
    el('summary', {}, el('h3', { text: 'Faculty' }), el('span', { class: 'fine', text: 'Band, limits, availability and extra areas for each professor. Blank cells use the band or the default.' })),
    el('datalist', { id: 'alloc-areas' }, areas.map((a) => el('option', { value: a }))),
    message,
    el('div', { class: 'table-card table-scroll alloc-scroll' }, el('table', { class: 'dt dt-compact alloc-table', id: 'alloc-faculty' },
      el('thead', {}, el('tr', {}, ['ID', 'Professor', 'Area', 'Band', 'Min hours', 'Max hours', 'Min sections/term', 'Max sections/term', 'Available', 'Also teaches'].map((h) => el('th', { text: h })))),
      el('tbody', {}, rows))));
}

function sectionsCard() {
  const { sections, faculty } = allocState.input;
  const body = el('tbody');
  const terms = alloc.termsOf(sections);
  const areas = [...new Set(sections.map((s) => s.area))].sort();
  const paint = () => {
    const shown = sections.filter((s) => (!allocState.term || s.term === allocState.term) && (!allocState.area || s.area === allocState.area));
    body.replaceChildren(...shown.map((s) => el('tr', {},
      el('td', {}, el('strong', { text: `${s.code} ${s.section}` })),
      el('td', { text: s.subject }), el('td', { text: s.term }), el('td', { text: s.area }), el('td', { class: 'num', text: String(s.hours) }),
      el('td', { text: s.current || '-' }),
      el('td', {}, el('select', { 'aria-label': `Who must teach ${s.label}`, class: 'alloc-lock', onchange: (e) => { s.locked = e.target.value; allocChanged(); } },
        el('option', { value: '', text: '-' }), faculty.map((f) => el('option', { value: f.id, text: `${f.id} ${f.area === s.area ? '' : '(other area)'}`.trim(), selected: s.locked === f.id })))),
      el('td', {}, el('input', { type: 'text', class: 'alloc-text', value: (s.barred || []).join(', '), placeholder: 'e.g. F003', 'aria-label': `Exclude professors from ${s.label}`,
        onchange: (e) => { s.barred = e.target.value.split(',').map((t) => t.trim().toUpperCase()).filter((t) => faculty.some((f) => f.id === t)); e.target.value = s.barred.join(', '); allocChanged(); } })))));
  };
  paint();
  const filter = (label, key, values) => el('label', { class: 'select' }, el('span', { text: label }),
    el('select', { onchange: (e) => { allocState[key] = e.target.value; paint(); } }, el('option', { value: '', text: 'All' }), values.map((v) => el('option', { value: v, text: v, selected: allocState[key] === v }))));
  return el('details', { class: 'alloc-card alloc-details' },
    el('summary', {}, el('h3', { text: 'Sections' }), el('span', { class: 'fine', text: 'Choose who must teach a section, or exclude professors from it.' })),
    el('div', { class: 'toolbar' }, filter('Term', 'term', terms), filter('Area', 'area', areas)),
    el('div', { class: 'table-card table-scroll alloc-scroll' }, el('table', { class: 'dt dt-compact alloc-table', id: 'alloc-sections' },
      el('thead', {}, el('tr', {}, ['Section', 'Subject', 'Term', 'Area', 'Hours', 'Current', 'Must teach', 'Exclude'].map((h) => el('th', { text: h })))), body)));
}

function runAllocation() {
  const button = $('alloc-solve');
  button.disabled = true;
  $('alloc-status').textContent = 'Solving…';
  setTimeout(() => {
    const { input, constraints, objective } = allocState;
    const result = alloc.search(input, constraints, objective);
    allocState.result = result.status === 'Solved' ? { ...result, before: alloc.evaluate(input, input.sections.map((s) => s.current), constraints, objective), at: new Date() } : null;
    button.disabled = false;
    if (result.status !== 'Solved') {
      $('alloc-status').textContent = 'No allocation keeps every rule.';
      $('alloc-checks').replaceChildren(...result.check.errors.map((t) => el('p', { class: 'tpl-msg is-error', text: t })), ...result.check.warnings.map((t) => el('p', { class: 'tpl-msg is-warning', text: t })));
      paintAllocResults();
      return;
    }
    $('alloc-status').textContent = `Solved in ${result.seconds.toFixed(1)} s, after ${result.iterations.toLocaleString('en-IN')} trial moves.`;
    paintAllocResults();
    $('alloc-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 30);
}

const LOAD_STATUS = (r) => (r.over > 0 ? 'over' : r.under > 0 ? 'under' : 'within');

function paintAllocResults() {
  const box = $('alloc-results');
  if (!box) return;
  const result = allocState.result;
  if (!result) { box.replaceChildren(); return; }
  const { input } = allocState;
  const after = result.evaluation;
  const before = result.before;
  const metric = (key, label, unit) => el('tr', {}, el('td', { text: label }), el('td', { class: 'num', text: `${before.metrics[key].toLocaleString('en-IN')}${unit}` }),
    el('td', { class: 'num' }, el('strong', { text: `${after.metrics[key].toLocaleString('en-IN')}${unit}` })));
  const top = Math.max(...after.rows.map((r) => Math.max(r.hours, r.max === Infinity ? 0 : r.max)), ...before.rows.map((r) => r.hours)) || 1;
  const pct = (h) => `${Math.min(100, (h / top) * 100)}%`;
  const loads = after.rows.map((r) => {
    const was = before.rows.find((b) => b.id === r.id);
    return el('div', { class: 'alloc-load' },
      el('span', { class: 'alloc-load-name' }, el('strong', { text: r.id }), ` ${r.name.replace(/^Prof\. (\(Dr\.\) )?|^Dr\. |^Adv\. /, '')}`),
      el('span', { class: 'alloc-track', title: `${r.hours} hours; band ${r.min} to ${r.max}; was ${was.hours}` },
        el('i', { class: 'alloc-zone', style: `left:${pct(r.min)};width:calc(${pct(r.max)} - ${pct(r.min)})` }),
        el('b', { class: `alloc-bar is-${LOAD_STATUS(r)}`, style: `width:${pct(r.hours)}` }),
        el('u', { class: 'alloc-was', style: `left:${pct(was.hours)}` })),
      el('span', { class: 'alloc-load-num', text: `${r.hours} h (${r.min}-${r.max})` }));
  });
  const allocRows = input.sections.map((s, i) => ({ s, now: result.assignment[i] }));
  const tbody = el('tbody');
  const paintRows = () => tbody.replaceChildren(...allocRows.filter((r) => !allocState.onlyChanged || r.now !== r.s.current).map(({ s, now }) => el('tr', { class: now !== s.current ? 'is-changed' : '' },
    el('td', {}, el('strong', { text: `${s.code} ${s.section}` })), el('td', { text: s.subject }), el('td', { text: s.term }), el('td', { text: s.area }),
    el('td', { class: 'num', text: String(s.hours) }), el('td', { text: s.current || '-' }),
    el('td', {}, el('strong', { text: now }), ` ${facultyLabel(now)}`),
    el('td', { text: [now !== s.current ? 'Moved' : '', allocState.constraints.locks && s.locked ? 'Must teach' : '', input.faculty.find((f) => f.id === now)?.area !== s.area ? 'Other area' : ''].filter(Boolean).join(', ') }))));
  paintRows();
  box.replaceChildren(
    el('p', { class: 'kicker', text: 'Result' }), el('h2', { class: 'title title-sm', text: 'The allocation' }),
    el('div', { class: 'alloc-split' },
      el('section', { class: 'alloc-card' }, el('h3', { text: 'Current allocation and the result' }),
        el('div', { class: 'table-card table-scroll' }, el('table', { class: 'dt dt-compact alloc-table alloc-wrap', id: 'alloc-compare' },
          el('thead', {}, el('tr', {}, ['Measure', 'Current', 'Result'].map((h) => el('th', { text: h })))),
          el('tbody', {},
            metric('under', 'Hours below minimums', ''), metric('over', 'Hours above maximums', ''), metric('peak', 'Largest gap for one professor', ' h'),
            metric('change', 'Sections moved', ''), metric('cross', 'Sections outside own area', ''), metric('split', 'Extra professors on a subject', ''),
            metric('objective', 'Objective', ''),
            el('tr', {}, el('td', { text: 'Rules broken' }), el('td', { class: 'num', text: String(before.breaks.length) }), el('td', { class: 'num' }, el('strong', { text: String(after.breaks.length) })))))),
        el('p', { class: 'fine', text: `The current allocation is scored with the same settings. ${before.breaks.length ? `It breaks ${plural(before.breaks.length, 'rule')}, for example: ${before.breaks.slice(0, 2).join('; ')}.` : ''}` }),
        el('p', { class: 'fine', text: 'The solver is a seeded search: it gives the same answer every time and a very good allocation, but it does not prove no better one exists. Download the model to solve it exactly in an LP solver such as HiGHS.' }),
        el('div', { class: 'tpl-actions' },
          el('button', { class: 'btn btn-primary btn-sm', type: 'button', id: 'alloc-download', onclick: downloadAllocResult }, icon('download'), ' Download result workbook'),
          el('button', { class: 'btn btn-outline btn-sm', type: 'button', id: 'alloc-lp', onclick: downloadAllocModel }, icon('download'), ' Download model (.lp)'))),
      el('section', { class: 'alloc-card' }, el('h3', { text: 'Load per professor' }),
        el('p', { class: 'alloc-legend fine' }, el('i', { class: 'alloc-key alloc-zone' }), ' band ', el('i', { class: 'alloc-key is-within' }), ' within ',
          el('i', { class: 'alloc-key is-under' }), ' under ', el('i', { class: 'alloc-key is-over' }), ' over ', el('i', { class: 'alloc-key alloc-key-was' }), ' current load'),
        el('div', { class: 'alloc-loads', id: 'alloc-loads' }, loads))),
    el('section', { class: 'alloc-card' }, el('h3', { text: 'Section by section' }),
      el('label', { class: 'alloc-check' }, el('input', { type: 'checkbox', id: 'alloc-only-changed', checked: allocState.onlyChanged, onchange: (e) => { allocState.onlyChanged = e.target.checked; paintRows(); } }), ' Show only sections that move'),
      el('div', { class: 'table-card table-scroll alloc-scroll' }, el('table', { class: 'dt dt-compact alloc-table', id: 'alloc-result' },
        el('thead', {}, el('tr', {}, ['Section', 'Subject', 'Term', 'Area', 'Hours', 'Current', 'Allocated', 'Note'].map((h) => el('th', { text: h })))), tbody))));
}

const facultyLabel = (id) => (allocState.input.faculty.find((f) => f.id === id) || {}).name || '';

// ---- the input workbook: download pre-filled, edit in Excel, upload

const XL_FONT = { name: 'Times New Roman', size: 11 };
const XL_YELLOW = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
const XL_HEAD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2A4A' } };

function xlSheet(book, name, headers, rows, editable = [], widths = []) {
  const ws = book.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.addRow(headers);
  rows.forEach((r) => ws.addRow(r));
  ws.eachRow((row, n) => row.eachCell({ includeEmpty: true }, (cell, col) => {
    cell.font = n === 1 ? { ...XL_FONT, bold: true, color: { argb: 'FFFFFFFF' } } : XL_FONT;
    if (n === 1) cell.fill = XL_HEAD;
    else if (editable.includes(headers[col - 1])) cell.fill = XL_YELLOW;
  }));
  headers.forEach((h, i) => { ws.getColumn(i + 1).width = widths[i] || Math.max(10, Math.min(40, h.length + 4)); });
  return ws;
}

const SECTION_COLS = ['Term', 'Semester', 'Batch', 'Subject Code', 'Subject', 'Subject Area', 'Type', 'Section', 'Students', 'Credits', 'Faculty Credit Hours', 'Current Faculty ID', 'Must Teach Faculty ID', 'Excluded Faculty IDs'];
const FACULTY_COLS = ['Faculty ID', 'Prof Name', 'Designation', 'Area', 'Administrative Role', 'Load Band', 'Min Hours', 'Max Hours', 'Min Sections per Term', 'Max Sections per Term', 'Available (Y/N)', 'Also Teaches Areas'];

async function downloadAllocInput() {
  const { input, constraints } = allocState;
  const ExcelJS = await loadExcel();
  const book = new ExcelJS.Workbook();
  book.creator = 'E-Logic School of Business';
  const readme = book.addWorksheet('Read me');
  [['E-Logic faculty allocation: input workbook'], [''],
    ['Edit the yellow cells, save, and upload this file on the Scheduling page’s Faculty allocation tab.'],
    ['Sections: one row per section. Must Teach Faculty ID gives the section to that professor; Excluded Faculty IDs (comma-separated) keeps them off it.'],
    ['Faculty: Load Band must match a band on the Load Bands sheet. Blank Min/Max Hours use the band; blank section limits use the Settings.'],
    ['Also Teaches Areas: comma-separated subject areas a professor may teach besides their own.'],
    ['Load Bands: teaching hours (faculty credit hours) for each band, per academic year.'],
    ['Settings: the constraint switches. Use Y or N, Annual or Term, and numbers.'],
    ['Example: a Sections row with Must Teach Faculty ID F001 makes the Dean teach that section whatever the solver prefers.']]
    .forEach((r, i) => { const row = readme.addRow(r); row.font = { ...XL_FONT, bold: i === 0, size: i === 0 ? 14 : 11 }; });
  readme.getColumn(1).width = 120;
  xlSheet(book, 'Sections', SECTION_COLS, input.sections.map((s) => [s.term, s.semester, s.batch, s.code, s.subject, s.area, s.type, s.section, s.students, s.credits, s.hours, s.current, s.locked || '', (s.barred || []).join(', ')]),
    ['Must Teach Faculty ID', 'Excluded Faculty IDs']);
  xlSheet(book, 'Faculty', FACULTY_COLS, input.faculty.map((f) => [f.id, f.name, f.designation || '', f.area, f.role || '-', f.band, f.minHours ?? '', f.maxHours ?? '', f.minSections ?? '', f.maxSections ?? '', f.available === false ? 'N' : 'Y', (f.alsoTeaches || []).join(', ')]),
    ['Load Band', 'Min Hours', 'Max Hours', 'Min Sections per Term', 'Max Sections per Term', 'Available (Y/N)', 'Also Teaches Areas'], [10, 32, 22, 20, 30]);
  xlSheet(book, 'Load Bands', ['Band', 'Min Hours', 'Max Hours'], input.bands.map((b) => [b.band, b.min, b.max]), ['Min Hours', 'Max Hours']);
  const yn = (v) => (v ? 'Y' : 'N');
  xlSheet(book, 'Settings', ['Setting', 'Value', 'Meaning'], [
    ['Hours basis', constraints.basis === 'term' ? 'Term' : 'Annual', 'Annual: bands cover the year. Term: each term gets half the band.'],
    ['Min sections per term', constraints.minSections, 'Default for every professor'],
    ['Max sections per term', constraints.maxSections, 'Default for every professor'],
    ['Own area only', yn(constraints.areaRule), 'Professors teach only in their own area'],
    ['Allow also-teaches areas', yn(constraints.exceptions), 'Also allow the areas on the Faculty sheet'],
    ['Respect must teach', yn(constraints.locks), ''], ['Respect exclusions', yn(constraints.bars), ''], ['Respect availability', yn(constraints.availability), ''],
    ['Hard cap', yn(constraints.hardCap), 'Never above the maximum by more than the cap hours'], ['Cap hours', constraints.capHours, '']], ['Value'], [26, 12, 70]);
  saveBlob(new Blob([await book.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `E-Logic_Allocation_Input_${data.academicYear}.xlsx`);
}

async function uploadAllocInput(file) {
  const msg = $('alloc-msg');
  msg.textContent = 'Reading the workbook…';
  msg.className = 'tpl-msg';
  try {
    const ExcelJS = await loadExcel();
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await file.arrayBuffer());
    const table = (name, need) => {
      const ws = book.getWorksheet(name);
      if (!ws) throw new Error(`The workbook has no ${name} sheet.`);
      const heads = ws.getRow(1).values.slice(1).map((v) => String(v ?? '').trim()).map((h) => ({ 'Barred Faculty IDs': 'Excluded Faculty IDs', 'Locked Faculty ID': 'Must Teach Faculty ID' }[h] || h));
      const missing = need.filter((h) => !heads.includes(h));
      if (missing.length) throw new Error(`The ${name} sheet is missing: ${missing.join(', ')}.`);
      const out = [];
      ws.eachRow((row, n) => {
        if (n === 1) return;
        const rec = Object.fromEntries(heads.map((h, i) => { const v = row.getCell(i + 1).value; return [h, v && typeof v === 'object' ? (v.result ?? v.text ?? '') : v ?? '']; }));
        if (Object.values(rec).some((v) => String(v).trim() !== '')) out.push(rec);
      });
      return out;
    };
    const list = (v) => String(v || '').split(',').map((t) => t.trim()).filter(Boolean);
    const bands = table('Load Bands', ['Band', 'Min Hours', 'Max Hours']).map((r) => ({ band: String(r.Band).trim(), min: Number(r['Min Hours']) || 0, max: Number(r['Max Hours']) || 0 }));
    const faculty = table('Faculty', FACULTY_COLS).map((r) => ({ id: String(r['Faculty ID']).trim(), name: String(r['Prof Name']), designation: String(r.Designation), area: String(r.Area).trim(),
      role: String(r['Administrative Role']), band: String(r['Load Band']).trim(), minHours: r['Min Hours'] === '' ? '' : Number(r['Min Hours']), maxHours: r['Max Hours'] === '' ? '' : Number(r['Max Hours']),
      minSections: r['Min Sections per Term'] === '' ? '' : Number(r['Min Sections per Term']), maxSections: r['Max Sections per Term'] === '' ? '' : Number(r['Max Sections per Term']),
      available: !/^n/i.test(String(r['Available (Y/N)'])), alsoTeaches: list(r['Also Teaches Areas']) }));
    const ids = new Set(faculty.map((f) => f.id));
    const problems = [];
    faculty.forEach((f) => { if (!bands.some((b) => b.band === f.band)) problems.push(`${f.id}: band “${f.band}” is not on the Load Bands sheet`); });
    const sections = table('Sections', SECTION_COLS).map((r, i) => {
      const s = { term: String(r.Term).trim(), semester: Number(r.Semester), batch: String(r.Batch), code: String(r['Subject Code']).trim(), subject: String(r.Subject), area: String(r['Subject Area']).trim(),
        type: String(r.Type), section: String(r.Section).trim(), students: Number(r.Students) || 0, credits: Number(r.Credits) || 0, hours: Number(r['Faculty Credit Hours']),
        current: String(r['Current Faculty ID'] || '').trim(), locked: String(r['Must Teach Faculty ID'] || '').trim().toUpperCase(), barred: list(r['Excluded Faculty IDs']).map((t) => t.toUpperCase()) };
      s.label = `${s.code} ${s.section} (${s.term})`;
      if (!Number.isFinite(s.hours) || s.hours <= 0) problems.push(`Sections row ${i + 2}: Faculty Credit Hours must be a positive number`);
      if (s.locked && !ids.has(s.locked)) problems.push(`${s.label}: locked to unknown ${s.locked}`);
      if (s.current && !ids.has(s.current)) problems.push(`${s.label}: current professor ${s.current} is not on the Faculty sheet`);
      const master = data.facultyUtilization.find((u) => u['Subject Code'] === s.code && u.Section === s.section && shortTerm(u.Term) === s.term);
      if (master) s.row = master;
      return s;
    });
    if (problems.length) throw new Error(`Please fix: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? `; and ${problems.length - 5} more` : ''}.`);
    const settings = Object.fromEntries(table('Settings', ['Setting', 'Value']).map((r) => [String(r.Setting).trim(), r.Value]));
    const yes = (k, d) => (settings[k] === undefined || settings[k] === '' ? d : /^y/i.test(String(settings[k])));
    const num = (k, d) => (settings[k] === undefined || settings[k] === '' || Number.isNaN(Number(settings[k])) ? d : Number(settings[k]));
    const c = allocState.constraints;
    allocState.constraints = { ...c, basis: /^t/i.test(String(settings['Hours basis'] || '')) ? 'term' : 'annual', minSections: num('Min sections per term', c.minSections), maxSections: num('Max sections per term', c.maxSections),
      areaRule: yes('Own area only', c.areaRule), exceptions: yes('Allow also-teaches areas', c.exceptions), locks: yes('Respect must teach', yes('Respect locks', c.locks)), bars: yes('Respect exclusions', yes('Respect bars', c.bars)),
      availability: yes('Respect availability', c.availability), hardCap: yes('Hard cap', c.hardCap), capHours: num('Cap hours', c.capHours) };
    allocState.input = { source: `Uploaded ${file.name}`, sections, faculty, bands };
    allocState.result = null;
    saveAllocState();
    renderAllocation();
    $('alloc-msg').textContent = `Loaded ${plural(sections.length, 'section')}, ${plural(faculty.length, 'professor')} and ${plural(bands.length, 'band')} from ${file.name}.`;
  } catch (e) {
    msg.textContent = e.message && !/^[A-Z][a-z]+Error/.test(e.message) ? e.message : 'That file couldn’t be read as an allocation input workbook.';
    msg.className = 'tpl-msg is-error';
  }
}

// ---- the result workbook

async function downloadAllocResult() {
  const { input, constraints, objective, result } = allocState;
  const ExcelJS = await loadExcel();
  const book = new ExcelJS.Workbook();
  book.creator = 'E-Logic School of Business';
  const name = (id) => facultyLabel(id);
  const cols = ['Academic Year', 'Term', 'Semester', 'Batch', 'Subject Code', 'Subject', 'Subject Area', 'Type', 'Faculty ID', 'Prof Name', 'Section', 'Number of Sections', 'Students', 'Credits',
    'Number of Sessions', 'Minutes per Session', 'Total Minutes Taught', 'Hours Taught', 'Faculty Credit Hours', 'Status', 'Previous Faculty ID', 'Changed', 'Must Teach'];
  const rows = input.sections.map((s, i) => {
    const r = s.row || {};
    const id = result.assignment[i];
    return [r['Academic Year'] || data.academicYear, r.Term || s.term, s.semester, s.batch, s.code, s.subject, s.area, s.type, id, name(id), s.section, r['Number of Sections'] ?? '', s.students, s.credits,
      r['Number of Sessions'] ?? '', r['Minutes per Session'] ?? '', r['Total Minutes Taught'] ?? '', r['Hours Taught'] ?? '', s.hours, r.Status || '', s.current || '', id !== s.current ? 'Y' : 'N',
      constraints.locks && s.locked ? 'Y' : 'N'];
  });
  const ws = xlSheet(book, 'Allocation', cols, rows, [], [12, 18, 9, 9, 12, 34, 20, 9, 10, 30]);
  ws.autoFilter = { from: 'A1', to: `W${rows.length + 1}` };
  const last = rows.length + 1;
  const evalRows = result.evaluation.rows;
  const load = xlSheet(book, 'Faculty Load', ['Faculty ID', 'Prof Name', 'Area', 'Band', 'Min Hours', 'Max Hours', 'Sections', 'Hours Allocated', 'Under By', 'Over By', 'Status', 'Hours Before'],
    evalRows.map((r, i) => {
      const n = i + 2;
      const was = result.before.rows.find((b) => b.id === r.id);
      return [r.id, r.name, r.area, r.band, r.min, r.max,
        { formula: `COUNTIF(Allocation!$I$2:$I$${last},A${n})`, result: r.sections },
        { formula: `SUMIF(Allocation!$I$2:$I$${last},A${n},Allocation!$S$2:$S$${last})`, result: r.hours },
        { formula: `MAX(0,E${n}-H${n})`, result: Math.max(0, r.min - r.hours) },
        { formula: `MAX(0,H${n}-F${n})`, result: Math.max(0, r.hours - r.max) },
        { formula: `IF(J${n}>0,"Over",IF(I${n}>0,"Under","Within"))`, result: r.hours > r.max ? 'Over' : r.hours < r.min ? 'Under' : 'Within' }, was.hours];
    }), [], [10, 30, 20, 14]);
  const n = evalRows.length + 2;
  const totalRow = load.addRow(['Total', '', '', '', { formula: `SUM(E2:E${n - 1})`, result: evalRows.reduce((t, r) => t + r.min, 0) }, { formula: `SUM(F2:F${n - 1})`, result: evalRows.reduce((t, r) => t + r.max, 0) },
    { formula: `SUM(G2:G${n - 1})`, result: input.sections.length }, { formula: `SUM(H2:H${n - 1})`, result: evalRows.reduce((t, r) => t + r.hours, 0) },
    { formula: `SUM(I2:I${n - 1})`, result: evalRows.reduce((t, r) => t + Math.max(0, r.min - r.hours), 0) }, { formula: `SUM(J2:J${n - 1})`, result: evalRows.reduce((t, r) => t + Math.max(0, r.hours - r.max), 0) }, '', '']);
  totalRow.font = { ...XL_FONT, bold: true };
  if (constraints.basis === 'term') load.addRow(['Note: the solver checked half of each band in each term; the totals here are for the year.']).font = { ...XL_FONT, italic: true };
  const subjects = [...new Map(input.sections.map((s) => [`${s.code}|${s.term}`, s])).values()];
  const letters = [...new Set(input.sections.map((s) => s.section))].sort();
  xlSheet(book, 'Course Summary', ['Term', 'Subject Code', 'Subject', 'Subject Area', 'Credits', ...letters.map((l) => `Section ${l}`)],
    subjects.map((s) => [s.term, s.code, s.subject, s.area, s.credits, ...letters.map((l) => {
      const i = input.sections.findIndex((x) => x.code === s.code && x.term === s.term && x.section === l);
      return i < 0 ? '-' : result.assignment[i];
    })]), [], [10, 12, 34, 20]);
  const on = (k) => (objective[k].on ? `${objective[k].weight}` : 'off');
  const m = (key) => [result.before.metrics[key], result.evaluation.metrics[key]];
  xlSheet(book, 'Solver Report', ['Item', 'Current allocation', 'Result', 'Notes'], [
    ['Solved at', '', result.at.toLocaleString('en-IN'), `Seeded search, ${result.iterations.toLocaleString('en-IN')} trial moves, ${result.seconds.toFixed(1)} s`],
    ['Data', '', input.source, ''],
    ...alloc.OBJECTIVE_TERMS.map((t) => [t.label, ...m(t.key), `Weight ${on(t.key)} ${t.unit}`]),
    ['Objective (weighted total)', ...m('objective'), 'Lower is better'],
    ['Rules broken', result.before.breaks.length, result.evaluation.breaks.length, result.before.breaks.slice(0, 3).join('; ')],
    ['Hours needed', '', result.check.demand, ''], ['Hours the bands allow', '', result.check.capacity, ''],
    ...result.check.warnings.map((w) => ['Warning', '', '', w]),
    ['Hours basis', '', constraints.basis === 'term' ? 'Each term, half the band' : 'Academic year', ''],
    ['Sections per professor per term', '', `${constraints.minSections} to ${constraints.maxSections}`, 'Unless a professor has their own limits'],
    ['Own area only', '', constraints.areaRule ? (constraints.exceptions ? 'Yes, plus also-teaches areas' : 'Yes') : 'No', ''],
    ['Must teach, exclusions, availability', '', [constraints.locks && 'must teach', constraints.bars && 'exclusions', constraints.availability && 'availability'].filter(Boolean).join(', ') || 'none', ''],
    ['Hard cap', '', constraints.hardCap ? `${constraints.capHours} hours above the maximum` : 'Off', ''],
  ], [], [36, 18, 26, 70]);
  saveBlob(new Blob([await book.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `E-Logic_Allocation_${data.academicYear}_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function downloadAllocModel() {
  const { input, constraints, objective } = allocState;
  const { lp, size } = alloc.buildModel(input, constraints, objective);
  const head = `\\ E-Logic faculty allocation, ${data.academicYear}: ${size.binaries} binary and ${size.continuous} continuous variables, ${size.constraints} constraints.\n`
    + `\\ x<s>_<p> = 1 when professor p (faculty list order, from 0) teaches section s (section list order, from 0).\n`;
  saveBlob(new Blob([head + lp], { type: 'text/plain' }), `E-Logic_Allocation_Model_${data.academicYear}.lp`);
}

function renderYear4() {
  const heads = ['Sem', 'Code', 'Elective', 'Track', 'Credits', 'Assessment', 'Faculty', 'Advanced topics', 'Prerequisite', 'Seats', 'Enrolled'];
  $('y4-table').replaceChildren(
    el('thead', {}, el('tr', {}, heads.map((h) => el('th', { text: h })))),
    el('tbody', {}, data.year4Electives.map((r) => el('tr', {}, el('td', { class: 'num', text: String(r.Semester) }), el('td', { text: r['Subject Code'] }),
      el('td', {}, el('strong', { text: r.Elective })), el('td', { text: r.Track }), el('td', { class: 'num', text: String(r.Credits) }), el('td', {}, tag(r.Assessment)),
      el('td', { text: r['Prof Name'] }), el('td', { text: r['Advanced Topics'] }), el('td', { text: r.Prerequisite }),
      el('td', { class: 'num', text: String(r.Seats) }), el('td', { class: 'num', text: String(r.Enrolled) })))));
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
    hbars($('stu-tracks'), countBy(all.filter((s) => ['Year 3', 'Year 4'].includes(s['Current Year'])), 'Specialisation'));
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
// The order of the Generate tab's checkboxes and result columns: the marks sheet comes before the report it feeds.
const PLAN_OUTPUTS = [PLAN_DOCS[0], PLAN_DOCS[1], ['marks', 'Marks Sheet'], PLAN_DOCS[2]];
const PLAN_BLANKS = { outline: 'E-Logic_Course_Outline_Template.docx', aol: 'E-Logic_AoL_Plan_Template.docx', report: 'E-Logic_AoL_Report_Template.docx' };
// A CLO's band comes from the share of its marks a student earned. These match the marks sheet's own defaults.
const DEFAULT_CUTOFFS = { exceed: 0.75, meet: 0.5 };
const DEFAULT_TARGET = 0.7;
// Each CLO has its own cut-offs and target, as on the marks sheet's AoL Summary tab.
const cutsOf = (marks) => (Array.isArray(marks.cutoffs) ? marks.cutoffs : marks.clos.map(() => ({ ...(marks.cutoffs || DEFAULT_CUTOFFS) })));
const targetsOf = (marks) => (Array.isArray(marks.targets) ? marks.targets : marks.clos.map(() => marks.target ?? DEFAULT_TARGET));
const sameCuts = (a, b) => a.length === b.length && a.every((c, i) => c.exceed === b[i].exceed && c.meet === b[i].meet);
let planCutScope = 'all'; // which CLO the Results sliders move: 'all', or a CLO's index

// Marks saved before cut-offs were per CLO had one set for every CLO.
function perCloMarks(marks) {
  if (!marks || !marks.clos) return marks;
  const sheet = marks.sheetCutoffs;
  marks.cutoffs = cutsOf(marks);
  marks.sheetCutoffs = Array.isArray(sheet) ? sheet : marks.clos.map(() => ({ ...(sheet || marks.cutoffs[0]) }));
  marks.targets = targetsOf(marks);
  return marks;
}
const HIGHER_ORDER = 4; // Bloom's level from which an item asks students to analyse, evaluate or create
const JSZIP = 'https://cdn.jsdelivr.net/npm/jszip@3.10.2/+esm';
const PIZZIP = 'https://cdn.jsdelivr.net/npm/pizzip@3.3.0/+esm';
const DOCXTEMPLATER = 'https://cdn.jsdelivr.net/npm/docxtemplater@3.71.0/+esm';
const EXCELJS = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
const MAMMOTH = 'https://cdn.jsdelivr.net/npm/mammoth@1.13.0/mammoth.browser.min.js';
const JSPDF = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js';
const AUTOTABLE = 'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TEMPLATE_LIMIT = 10 * 1024 * 1024;
let planIndex = {};
let planFiles = [];
let planCustom = {}; // kind -> { name, blob, savedAt, warnings }: uploaded templates in this browser
let planMarks = {}; // subject code -> { name, blob, savedAt, warnings, clos, cutoffs, results, review, students }: uploaded marks in this browser
let planOutlines = {}; // subject code -> { name, blob, version, status, ... }: outlines going through review in this browser
let planMarksCode = '';
let planResultsCode = '';
let planReferences = {}; // subject code -> { name, blob, savedAt, warning }: last year's outlines to build this year's from
let planOutlineCode = '';
let planCoaching = null;
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
      if (saved && saved.name.toLowerCase().endsWith('.docx')) planCustom[kind] = saved; // an older report template was Excel
    } catch (e) { /* storage blocked: the defaults still work */ }
  }
}

async function loadSavedMarks() {
  for (const c of planSubjects()) {
    try {
      const saved = await templateStore('readonly', (s) => s.get(`marks:${c['Subject Code']}`));
      if (!saved) continue;
      // Marks saved before the Results tab kept only class totals, so read those files again.
      planMarks[c['Subject Code']] = perCloMarks(saved.clos ? saved : { ...saved, ...(await readMarks(c['Subject Code'], new File([saved.blob], saved.name))) });
    } catch (e) { /* storage blocked: the reports keep their sample results */ }
  }
}

const xmlText = (xml) => xml.replace(/<[^>]+>/g, '');

async function checkTemplate(kind, file) {
  if (!file.name.toLowerCase().endsWith('.docx')) return { error: 'Please upload a .docx file.' };
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
  return { warnings };
}

// ------------------------------------------------------------------ reading an uploaded marks sheet

const cellText = (cell) => {
  const { value } = cell;
  if (value && typeof value === 'object') return String(value.result ?? (value.richText || []).map((t) => t.text).join('')).trim();
  return value == null ? '' : String(value).trim();
};

function labelRow(sheet, label) {
  for (let r = 1; r <= sheet.rowCount; r++) if (cellText(sheet.getCell(r, 4)) === label) return r;
  return null;
}

// The columns tagged with a CLO, up to the merged block of totals that follows them.
function markedColumns(sheet, rows, cloCount) {
  const columns = [];
  for (let col = 5; col <= sheet.columnCount; col++) {
    const cell = sheet.getCell(rows.outcome, col);
    if (cell.isMerged) break;
    const tag = cellText(cell);
    if (!tag) continue;
    const clo = Number((tag.match(/^(?:CL?O)?\s*(\d+)$/i) || [])[1]);
    if (!clo || clo > cloCount) return { error: `Cell ${cell.address} says “${tag}”. This subject has CO1 to CO${cloCount}.` };
    const most = Number(cellText(sheet.getCell(rows.marks, col)));
    if (!(most > 0)) return { error: `Cell ${cell.address} has a Course Outcome, but its column has no Question Marks.` };
    columns.push({ col, clo, most, label: (rows.question && cellText(sheet.getCell(rows.question, col))) || `Question ${col - 4}`,
      bloom: rows.bloom ? Number(cellText(sheet.getCell(rows.bloom, col))) || 0 : 0 });
  }
  return columns.length ? { columns } : { error: 'No column has a Course Outcome, so there is nothing to count.' };
}

/** Each student's marks for each CLO. Absent or empty marks count as zero unless a student has none for that CLO. */
function readStudents(sheet, start, columns, cloCount) {
  const clos = Array.from({ length: cloCount }, (_, i) => {
    const mine = columns.filter((c) => c.clo === i + 1);
    return { most: mine.reduce((n, c) => n + c.most, 0), scores: [], items: mine.map(({ col, label, bloom }) => ({ col, label, bloom, sum: 0, count: 0 })) };
  });
  const seen = new Set();
  for (let r = start; r <= sheet.rowCount; r++) {
    const roll = cellText(sheet.getCell(r, 4));
    if (!roll) continue;
    if (seen.has(roll)) return { error: `Roll number ${roll} appears twice.` };
    seen.add(roll);
    const totals = new Map();
    for (const { col, clo, most } of columns) {
      const cell = sheet.getCell(r, col);
      const text = cellText(cell);
      const entry = totals.get(clo) || { got: 0, marked: false };
      if (text && !/^ab$/i.test(text)) {
        const mark = Number(text);
        if (Number.isNaN(mark) || mark < 0 || mark > most) return { error: `Cell ${cell.address} has “${text}”. Enter a mark from 0 to ${most}, or AB.` };
        entry.got += mark;
        entry.marked = true;
        const item = clos[clo - 1].items.find((i) => i.col === col);
        item.sum += mark / most * 100;
        item.count += 1;
      }
      totals.set(clo, entry);
    }
    const section = cellText(sheet.getCell(r, 2));
    for (const [clo, { got, marked }] of totals) if (marked) clos[clo - 1].scores.push({ got, section });
  }
  for (const clo of clos) clo.items = clo.items.map(({ label, bloom, sum, count }) => ({ label, bloom, average: count ? sum / count : null }));
  return { clos, students: seen.size };
}

const bandOf = (got, most, { exceed, meet }) => (got >= exceed * most ? 'exceed' : got >= meet * most ? 'meet' : 'below');

function countBands(clo, cutoffs) {
  const bands = { exceed: 0, meet: 0, below: 0 };
  for (const { got } of clo.scores) bands[bandOf(got, clo.most, cutoffs)] += 1;
  return bands;
}

const bandFields = ({ exceed, meet, below }) => {
  const assessed = exceed + meet + below;
  const pct = (n) => (assessed ? `${(n / assessed * 100).toFixed(1)}%` : '-');
  const count = (n) => (assessed ? String(n) : '-');
  return { exceed_n: count(exceed), exceed_pct: pct(exceed), meet_n: count(meet), meet_pct: pct(meet), below_n: count(below), below_pct: pct(below) };
};

// The AoL Summary's yellow cells set each CO's cut-offs and target, and the report must agree with that sheet.
function readCutoffs(book, count) {
  const fallback = { cutoffs: Array.from({ length: count }, () => ({ ...DEFAULT_CUTOFFS })), targets: Array(count).fill(DEFAULT_TARGET) };
  const sheet = book.getWorksheet('AoL Summary');
  if (!sheet) return fallback;
  const num = (cell) => { const t = cellText(cell); return t === '' ? null : Number(t); };
  let head = 0;
  for (let r = 1; r <= Math.min(sheet.rowCount, 40) && !head; r++) if (cellText(sheet.getCell(r, 1)) === 'CO') head = r;
  const cols = {};
  if (head) sheet.getRow(head).eachCell((cell, c) => { cols[cellText(cell)] = c; });
  let found;
  if (head && cols['Exceed at least'] && cols['Meet at least']) {
    found = { cutoffs: [], targets: [] };
    for (let i = 0; i < count; i++) {
      const r = head + 1 + i;
      if (cellText(sheet.getCell(r, 1)) !== `CO${i + 1}`) return { error: `The AoL Summary tab should list CO${i + 1} in row ${r}.` };
      found.cutoffs.push({ exceed: num(sheet.getCell(r, cols['Exceed at least'])) ?? DEFAULT_CUTOFFS.exceed, meet: num(sheet.getCell(r, cols['Meet at least'])) ?? DEFAULT_CUTOFFS.meet });
      found.targets.push(cols.Target ? num(sheet.getCell(r, cols.Target)) ?? DEFAULT_TARGET : DEFAULT_TARGET);
    }
  } else {
    // Older sheets had one set of cut-offs for the whole subject.
    const value = (label) => {
      for (let r = 1; r <= sheet.rowCount; r++) if (cellText(sheet.getCell(r, 1)) === label) return Number(cellText(sheet.getCell(r, 2)));
      return null;
    };
    const one = { exceed: value('Exceed Expectation: at least') ?? DEFAULT_CUTOFFS.exceed, meet: value('Meet Expectation: at least') ?? DEFAULT_CUTOFFS.meet };
    found = { cutoffs: Array.from({ length: count }, () => ({ ...one })), targets: Array(count).fill(value('Target: students meeting or exceeding') ?? DEFAULT_TARGET) };
  }
  for (const [i, { exceed, meet }] of found.cutoffs.entries()) {
    if (!(meet > 0 && meet < exceed && exceed <= 1)) return { error: `Check CO${i + 1}’s cut-offs on the AoL Summary tab: Exceed must be above Meet, and both between 0% and 100%.` };
    if (!(found.targets[i] > 0 && found.targets[i] <= 1)) return { error: `Check CO${i + 1}’s target on the AoL Summary tab: it must be between 0% and 100%.` };
  }
  return found;
}

const loadCoaching = async () => {
  planCoaching ||= await (await fetch(`${PLAN_DIR}coaching.json`)).json();
  return planCoaching;
};

function cloStatus({ exceed, meet, below }, target) {
  const met = (exceed + meet) / (exceed + meet + below) * 100;
  return met < target * 100 ? 'below' : met < target * 100 + planCoaching.near_margin ? 'near' : 'above';
}

const weakestItem = (clo) => clo.items.filter((i) => i.average != null).reduce((low, i) => (!low || i.average < low.average ? i : low), null);

// Drafts a CLO's Analysis of Result and Improvement Plan, the same way build_marks.py does for the samples.
function draftReview(clo, cutoffs, target) {
  if (!clo.scores.length) return { analysis: '', improvement: '' };
  const bands = countBands(clo, cutoffs);
  const assessed = clo.scores.length;
  const item = weakestItem(clo);
  const status = cloStatus(bands, target);
  const values = { met: ((bands.exceed + bands.meet) / assessed * 100).toFixed(1), below: (bands.below / assessed * 100).toFixed(1), target: String(Math.round(target * 1000) / 10),
    average: (clo.scores.reduce((sum, { got }) => sum + got / clo.most * 100, 0) / assessed).toFixed(1), item: item.label, item_average: item.average.toFixed(1) };
  const fill = (text) => text.replace(/\{(\w+)\}/g, (_, key) => values[key]);
  const { lead, several, single } = planCoaching.analysis;
  const several_items = clo.items.filter((i) => i.average != null).length > 1;
  return { analysis: fill(lead + (several_items ? several : single)),
    improvement: fill(planCoaching.suggestions[status][item.bloom >= HIGHER_ORDER ? 'higher' : 'lower'][0]) };
}

// Sets the cut-offs for a subject's marks and works out what depends on them. Text faculty have written stays as it is.
function applyCutoffs(marks, cutoffs) {
  marks.cutoffs = (Array.isArray(cutoffs) ? cutoffs : marks.clos.map(() => cutoffs)).map((c) => ({ exceed: c.exceed, meet: c.meet }));
  const targets = targetsOf(marks);
  marks.results = marks.clos.map((clo, i) => bandFields(countBands(clo, marks.cutoffs[i])));
  marks.review = marks.clos.map((clo, i) => {
    const old = (marks.review || [])[i] || {};
    const draft = draftReview(clo, marks.cutoffs[i], targets[i]);
    return { ...old, analysis: old.analysisEdited ? old.analysis : draft.analysis, improvement: old.improvementEdited ? old.improvement : draft.improvement };
  });
}

async function readMarks(code, file) {
  if (!file.name.toLowerCase().endsWith('.xlsx')) return { error: 'Please upload a .xlsx file.' };
  if (file.size > TEMPLATE_LIMIT) return { error: 'That file is over 10 MB.' };
  const ExcelJS = await loadExcel();
  await loadCoaching();
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(await file.arrayBuffer());
  } catch (e) {
    return { error: 'That file couldn’t be opened. It may be damaged.' };
  }
  const sheet = book.getWorksheet('Marks Sheet');
  const marksRow = sheet && labelRow(sheet, 'Question Marks');
  const outcomeRow = sheet && labelRow(sheet, 'Course Outcome');
  if (!marksRow || !outcomeRow) return { error: 'This needs a sheet named Marks Sheet with the Question Marks and Course Outcome rows, as in the blank.' };
  const named = (cellText(sheet.getCell('C2')).match(/[A-Z]{3}\d{3}/) || [])[0];
  if (named && named !== code) return { error: `This marks sheet is for ${named}, but ${code} is selected.` };
  const { clos } = await subjectFields(code);
  const { cutoffs, targets, error: cutoffError } = readCutoffs(book, clos.length);
  if (cutoffError) return { error: cutoffError };
  const bloomRow = labelRow(sheet, 'Bloom\'s Level');
  const { columns, error } = markedColumns(sheet, { outcome: outcomeRow, marks: marksRow, question: labelRow(sheet, 'Question'), bloom: bloomRow }, clos.length);
  if (error) return { error };
  const counted = readStudents(sheet, (bloomRow || outcomeRow) + 1, columns, clos.length);
  if (counted.error) return counted;
  if (counted.clos.every((c) => !c.scores.length)) return { error: 'No marks found. Enter marks on the Marks Sheet, then upload it again.' };
  const missing = clos.filter((c, i) => !counted.clos[i].scores.length).map((c) => `CLO${c.n}`);
  const marks = { clos: counted.clos, students: counted.students, targets, target: targets[0], sheetCutoffs: cutoffs.map((c) => ({ ...c })),
    warnings: missing.length ? [`No marks for ${missing.join(', ')}, so the report shows a dash for ${missing.length === 1 ? 'it' : 'them'}.`] : [] };
  applyCutoffs(marks, cutoffs);
  return marks;
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

const SAMPLE_YEAR = '2025-26'; // the earlier offering the sample marks stand in for

/** Highlights in yellow every run of a Word file whose text is one of the given passages, or part of one. */
async function highlightText(blob, passages) {
  const wanted = passages.filter((t) => t && t.trim().length > 3).map((t) => t.trim());
  const PizZip = await loadPizZip();
  const zip = new PizZip(await blob.arrayBuffer());
  const unescape = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const xml = zip.file('word/document.xml').asText().replace(/<w:r(?: [^>]*)?>[\s\S]*?<\/w:r>/g, (run) => {
    const text = unescape([...run.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')).trim();
    if (!text || !wanted.some((w) => w === text || text.includes(w) || (text.length >= 20 && w.includes(text))) || run.includes('<w:highlight')) return run;
    const mark = '<w:highlight w:val="yellow"/>';
    if (!run.includes('<w:rPr>') && !/<w:rPr\/>/.test(run)) return run.replace(/^(<w:r(?: [^>]*)?>)/, `$1<w:rPr>${mark}</w:rPr>`);
    return run.replace(/<w:rPr\/>/, `<w:rPr>${mark}</w:rPr>`).replace(/<w:rPr>([\s\S]*?)<\/w:rPr>/, (_, inner) => {
      // Word wants the highlight before underline, shading, vertical alignment and language.
      const at = inner.search(/<w:(u|effect|bdr|shd|fitText|vertAlign|rtl|cs|em|lang|eastAsianLayout|specVanish|oMath)\b/);
      return `<w:rPr>${at < 0 ? inner + mark : inner.slice(0, at) + mark + inner.slice(at)}</w:rPr>`;
    });
  });
  zip.file('word/document.xml', xml);
  return zip.generate({ type: 'blob', mimeType: DOCX_TYPE });
}

const percent = (share) => `${Math.round(share * 1000) / 10}%`;
const oneRule = ({ exceed, meet }) => `Exceed Expectation is ${percent(exceed)} or more of the marks for that CLO, `
  + `Meet Expectation is ${percent(meet)} up to ${percent(exceed)}, and Does not meet Expectation is below ${percent(meet)}.`;
// The report's rule: one sentence when every CLO shares the cut-offs, otherwise the cut-offs CLO by CLO.
const cutoffRule = (cutoffs) => {
  const list = Array.isArray(cutoffs) ? cutoffs : [cutoffs];
  if (list.every((c) => c.exceed === list[0].exceed && c.meet === list[0].meet)) return oneRule(list[0]);
  return `The cut-offs differ by CLO (Exceed Expectation from / Meet Expectation from): ${list.map((c, i) => `CLO${i + 1} ${percent(c.exceed)} / ${percent(c.meet)}`).join('; ')}. Below the Meet cut-off is Does not meet Expectation.`;
};

const withMarks = (fields, marks) => ({ ...fields, results_note: marks.sample ? fields.results_note : `From the marks in ${marks.name}.`, results_rule: cutoffRule(cutsOf(marks)),
  clos: fields.clos.map((c, i) => ({ ...c, ...marks.results[i], ...marks.review[i] })) });

// One document for a subject: built live if it has an uploaded template or marks, otherwise the reviewed file.
async function planBlob({ code, kind, name }) {
  if (kind === 'marks' && planMarks[code]) return planMarks[code].blob;
  if (kind === 'outline' && planReferences[code]) return rollForward(planReferences[code].blob, await subjectFields(code));
  if (kind === 'outline' && planOutlines[code]) return planOutlines[code].blob;
  const marks = kind === 'report' && planMarks[code];
  if (planCustom[kind] || marks) {
    const fields = marks ? withMarks(await subjectFields(code), marks) : await subjectFields(code);
    const blob = await fillDocx(await activeTemplate(kind), fields);
    // Sample results stay highlighted until this term's marks replace them.
    return kind === 'report' && (!marks || marks.sample)
      ? highlightText(blob, [fields.results_note, ...fields.clos.flatMap((c) => [c.analysis, c.improvement])]) : blob;
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
    $('plan-status').textContent = `${file.name} couldn’t be built. Check your template’s marked fields, or restore the default.`;
  }
}

const planSubjects = () => data.curriculum.filter((c) => planIndex[c['Subject Code']]);

function fillPlanSubjects() {
  const sem = Number($('plan-sem').value);
  const rows = data.curriculum.filter((c) => !sem || c.Semester === sem);
  const ready = rows.filter((c) => planIndex[c['Subject Code']]);
  $('plan-subject').replaceChildren(el('option', { value: '', text: `All available subjects (${ready.length})` }),
    ...rows.map((c) => el('option', { value: c['Subject Code'], text: `${c['Subject Code']} ${c.Subject}`, disabled: !planIndex[c['Subject Code']] })));
}

// The subjects the semester and subject dropdowns currently point at.
function pickedSubjects() {
  const sem = Number($('plan-sem').value);
  const code = $('plan-subject').value;
  return planSubjects().filter((c) => (!sem || c.Semester === sem) && (!code || c['Subject Code'] === code));
}

function openMarksTile(code) {
  planResultsCode = code;
  location.hash = 'planner/results';
}

// While "Upload Marks Sheet" is ticked, names the semester and each selected subject still without marks,
// and keeps Generate documents greyed out until they are uploaded.
function updateMarksPrompt() {
  const missing = pickedSubjects().filter((c) => !planMarks[c['Subject Code']]);
  const prompt = $('plan-marks-prompt');
  prompt.hidden = !$('plan-marks').checked || !missing.length;
  if (prompt.hidden) return [];
  const semester = $('plan-sem').selectedOptions[0]?.text || 'All semesters';
  const chip = (text) => el('mark', { class: 'plan-pick', text });
  prompt.replaceChildren(
    el('p', {}, 'Please upload the marks sheet for ', chip(semester), ' ',
      ...missing.flatMap((c, i) => [i ? (i === missing.length - 1 ? ' and ' : ', ') : '', chip(`${c['Subject Code']} ${c.Subject}`)]),
      ` on the Marks & results tab. Generate documents is available once ${missing.length === 1 ? 'it is' : 'they are'} uploaded, or untick Upload Marks Sheet. `
      + `Until then, the AoL Report shows sample results from the ${SAMPLE_YEAR} offering, highlighted in yellow.`),
    el('div', { class: 'plan-prompt-actions' }, missing.map((c) => el('button', { class: 'btn btn-outline btn-sm', type: 'button',
      text: missing.length === 1 ? 'Upload marks sheet' : `Upload for ${c['Subject Code']}`, onclick: () => openMarksTile(c['Subject Code']) }))));
  return missing;
}

function clearPlanResults() {
  $('plan-results').hidden = true;
  const missing = updateMarksPrompt();
  renderReference();
  const picked = PLAN_OUTPUTS.some(([kind]) => $(`plan-${kind}`).checked);
  const blocked = $('plan-marks').checked && missing.length > 0;
  $('plan-generate').disabled = !picked || blocked;
  $('plan-generate').title = blocked ? 'Upload the marks sheet first, or untick Upload Marks Sheet' : '';
}

function generatePlan() {
  const kinds = PLAN_OUTPUTS.filter(([kind]) => $(`plan-${kind}`).checked);
  const rows = pickedSubjects();
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
      const marks = (kind === 'report' || kind === 'marks') && planMarks[c['Subject Code']];
      const reference = kind === 'outline' && planReferences[c['Subject Code']];
      if (reference) return el('td', {}, el('button', { class: 'btn-link', type: 'button', onclick: () => downloadPlanFile(file) }, icon('download'), ' Download'),
        el('small', { class: 'plan-custom', text: 'From your reference' }));
      const outline = kind === 'outline' && planOutlines[c['Subject Code']];
      if (outline) return el('td', {}, el('button', { class: 'btn-link', type: 'button', onclick: () => downloadPlanFile(file) }, icon('download'), ' Download'),
        el('small', { class: 'plan-custom', text: `Version ${outline.version}, ${OUTLINE_STATUS[outline.status].toLowerCase()}` }));
      if (!planCustom[kind] && !marks) return el('td', {}, el('a', { href: PLAN_DIR + name, download: true }, icon('download'), ' Download'),
        kind === 'marks' ? el('small', { class: 'plan-sample', text: `Sample results, ${SAMPLE_YEAR}` }) : null);
      return el('td', {}, el('button', { class: 'btn-link', type: 'button', onclick: () => downloadPlanFile(file) }, icon('download'), ' Download'),
        el('small', { class: 'plan-custom', text: [planCustom[kind] && 'Your template', marks && (marks.sample ? `Sample results, ${SAMPLE_YEAR}` : 'Your marks')].filter(Boolean).join(', ') }));
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

const PLAN_TABS = ['generate', 'outline', 'results', 'templates'];

function showPlanTab(tab) {
  const shown = PLAN_TABS.includes(tab) ? tab : 'generate';
  for (const name of PLAN_TABS) {
    $(`plan-panel-${name}`).hidden = name !== shown;
    $(`plan-tab-${name}`).setAttribute('aria-selected', String(name === shown));
  }
  if (!Object.keys(planIndex).length) return; // the planner is still loading, and shows this tab when it's ready
  if (shown === 'outline') renderOutline();
  if (shown === 'results') renderResults();
}

async function activeTemplate(kind) {
  if (planCustom[kind]) return planCustom[kind].blob;
  const res = await fetch(`${PLAN_DIR}templates/${PLAN_BLANKS[kind]}`);
  if (!res.ok) throw new Error(PLAN_BLANKS[kind]);
  return res.blob();
}

const blankMarks = (code) => `${PLAN_DIR}marks/${code}_Marks_Sheet_Blank.xlsx`;

async function marksPreviewBlob() {
  const saved = planMarks[planMarksCode];
  if (saved) return saved.blob;
  const res = await fetch(blankMarks(planMarksCode));
  if (!res.ok) throw new Error(planMarksCode);
  return res.blob();
}

async function previewTemplate(kind, label) {
  const body = $('tpl-preview-body');
  $('tpl-preview').hidden = false;
  $('tpl-preview-title').textContent = `${label} preview`;
  $('tpl-preview-note').textContent = kind === 'marks' ? 'First rows of each sheet.' : 'Word’s layout is only approximate here. Download the file for the exact version.';
  body.replaceChildren(el('p', { class: 'fine', text: 'Loading…' }));
  try {
    const blob = kind === 'marks' ? await marksPreviewBlob() : await activeTemplate(kind);
    if (kind === 'marks') {
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

async function uploadMarks(code, file, message, sample = false) {
  message.textContent = 'Reading the marks…';
  message.className = 'tpl-msg';
  try {
    const { error, ...counted } = await readMarks(code, file);
    if (error) { message.textContent = error; message.className = 'tpl-msg is-error'; return; }
    const saved = { name: file.name, blob: new Blob([file], { type: file.type }), savedAt: new Date().toISOString(), sample, ...counted };
    await templateStore('readwrite', (s) => s.put(saved, `marks:${code}`));
    planMarks[code] = saved;
    planResultsCode = code;
    clearPlanResults();
    renderTemplates();
    if (location.hash === '#planner/results') renderResults();
    else location.hash = 'planner/results';
  } catch (e) {
    message.textContent = 'These marks couldn’t be read or saved in this browser.';
    message.className = 'tpl-msg is-error';
  }
}

async function removeMarks(code) {
  try { await templateStore('readwrite', (s) => s.delete(`marks:${code}`)); } catch (e) { /* nothing was stored */ }
  delete planMarks[code];
  clearPlanResults();
  renderTemplates();
}

function marksCard() {
  const subjects = planSubjects();
  if (!subjects.length) return null;
  planMarksCode ||= subjects[0]['Subject Code'];
  const code = planMarksCode;
  const saved = planMarks[code];
  const message = el('p', { class: 'tpl-msg', role: 'status' });
  const input = el('input', { type: 'file', accept: '.xlsx', hidden: true, 'aria-label': `Upload marks for ${code}`, id: 'tpl-file-marks',
    onchange: (e) => { if (e.target.files[0]) uploadMarks(code, e.target.files[0], message); e.target.value = ''; } });
  const picker = el('select', { id: 'tpl-marks-subject', onchange: (e) => { planMarksCode = e.target.value; renderTemplates(); } },
    subjects.map((c) => el('option', { value: c['Subject Code'], text: `${c['Subject Code']} ${c.Subject}` })));
  picker.value = code;
  return el('article', { class: 'tpl-card' },
    el('h3', { text: 'Marks Sheet' }),
    el('p', { class: 'tpl-meta', text: 'Excel upload that feeds the AoL Report' }),
    el('label', { class: 'select tpl-select' }, el('span', { text: 'Subject' }), picker),
    el('p', { class: 'tpl-version' }, saved ? el('strong', { text: saved.sample ? 'Sample results: ' : 'Your marks: ' }) : el('strong', { text: 'No marks uploaded' }),
      saved ? `${saved.name} (${plural(saved.students, 'student')})` : `. The report shows sample results from ${SAMPLE_YEAR}, highlighted.`),
    (saved ? saved.warnings : []).map((text) => el('p', { class: 'tpl-msg is-warning', text })),
    message,
    el('div', { class: 'tpl-actions' },
      el('button', { class: 'btn btn-outline btn-sm', type: 'button', text: 'Preview', onclick: () => previewTemplate('marks', `${code} Marks Sheet`) }),
      el('a', { class: 'btn btn-outline btn-sm', href: blankMarks(code), download: true, text: 'Download blank' }),
      el('a', { class: 'btn btn-outline btn-sm', href: PLAN_DIR + planIndex[code].marks, download: true, text: 'Download sample' }),
      saved ? el('button', { class: 'btn btn-outline btn-sm', type: 'button', text: 'Download yours', onclick: () => saveBlob(saved.blob, saved.name) }) : null,
      saved ? el('button', { class: 'btn btn-outline btn-sm', type: 'button', text: 'View results', onclick: () => { planResultsCode = code; location.hash = 'planner/results'; } }) : null,
      el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: 'Upload marks', onclick: () => input.click() }),
      saved ? el('button', { class: 'btn-link', type: 'button', text: 'Remove marks', onclick: () => removeMarks(code) }) : null),
    input);
}

// ------------------------------------------------------------------ results: distribution, cut-offs, reflection

const STATUS_LABEL = { below: 'Below target', near: 'Near target', above: 'Above target' };
const BAND_LABEL = { exceed: 'Exceed', meet: 'Meet', below: 'Does not meet' };
const BIN_WIDTH = 5; // percentage points of a CLO's marks in each bar

const saveMarks = (code) => templateStore('readwrite', (s) => s.put(planMarks[code], `marks:${code}`)).catch(() => { /* storage blocked: kept for this visit */ });

// Upload, blank and sample for the chosen subject, at the top of the Marks & results tab.
function marksBar(code) {
  const saved = planMarks[code];
  const message = el('p', { class: 'tpl-msg', id: 'res-message', role: 'status' });
  const input = el('input', { type: 'file', accept: '.xlsx', hidden: true, id: 'res-file', 'aria-label': `Upload the marks sheet for ${code}`,
    onchange: (e) => { if (e.target.files[0]) uploadMarks(code, e.target.files[0], message); e.target.value = ''; } });
  return el('section', { class: 'res-upload' },
    el('h3', { text: 'Marks sheet' }),
    el('p', {}, saved ? el('strong', { text: saved.sample ? `Using the sample results from ${SAMPLE_YEAR}` : `Using ${saved.name}` }) : el('strong', { text: 'No marks uploaded yet. ' }),
      saved ? `, ${plural(saved.students, 'student')}${saved.sample ? '. They stay highlighted in the AoL Report until you upload this term’s marks.' : `, uploaded ${dateText(saved.savedAt)}.`}`
        : `The AoL Report shows sample results from the ${SAMPLE_YEAR} offering, highlighted in yellow. Download the blank, enter this term’s marks in Excel, then upload it here.`),
    el('div', { class: 'tpl-actions' },
      el('a', { class: 'btn btn-outline btn-sm', href: blankMarks(code), download: true }, icon('download'), ' Download blank'),
      el('button', { class: 'btn btn-primary btn-sm', type: 'button', id: 'res-upload', onclick: () => input.click() }, icon('upload'), saved ? ' Upload a new marks sheet' : ' Upload marks sheet'),
      saved && !saved.sample ? null : el('button', { class: 'btn btn-outline btn-sm', type: 'button', id: 'res-sample', text: saved ? 'Reload the sample results' : `Try the sample results (${SAMPLE_YEAR})`, onclick: loadSampleMarks }),
      saved ? el('button', { class: 'btn-link', type: 'button', text: 'Remove marks', onclick: async () => { await removeMarks(code); renderResults(); } }) : null),
    (saved ? saved.warnings : []).map((text) => el('p', { class: 'tpl-msg is-warning', text })),
    message, input);
}

async function loadSampleMarks() {
  const code = planResultsCode;
  const name = planIndex[code].marks;
  try {
    const res = await fetch(PLAN_DIR + name);
    if (!res.ok) throw new Error(name);
    await uploadMarks(code, new File([await res.blob()], name), $('res-message'), true);
  } catch (e) {
    $('res-message').textContent = 'The sample marks couldn’t be loaded.';
  }
}

function distributionChart(clo, n, cutoffs, top) {
  const bins = Array.from({ length: 100 / BIN_WIDTH }, () => ({ exceed: 0, meet: 0, below: 0 }));
  for (const { got } of clo.scores) {
    bins[Math.min(bins.length - 1, Math.floor(got / clo.most * 100 / BIN_WIDTH))][bandOf(got, clo.most, cutoffs)] += 1;
  }
  const readout = el('p', { class: 'res-readout', text: `${plural(clo.scores.length, 'student')}. Point at a bar for detail.` });
  const bars = bins.map((bin, i) => {
    const total = bin.exceed + bin.meet + bin.below;
    const parts = ['exceed', 'meet', 'below'].filter((band) => bin[band]).map((band) => `${bin[band]} ${BAND_LABEL[band]}`);
    const text = `${i * BIN_WIDTH}% to ${(i + 1) * BIN_WIDTH}%: ${plural(total, 'student')}${parts.length ? ` (${parts.join(', ')})` : ''}`;
    const show = () => { readout.textContent = text; };
    return el('div', { class: 'res-bin', tabindex: total ? 0 : null, 'aria-label': total ? text : null, onmouseenter: show, onfocus: show },
      ['exceed', 'meet', 'below'].filter((band) => bin[band]).map((band) => el('span', { class: `res-seg res-${band}`, style: `height:${bin[band] / top * 100}%` })));
  });
  return el('figure', { class: 'res-chart' },
    el('figcaption', {}, el('strong', { text: `CLO${n}` }), ` ${planFields.get(planResultsCode).clos[n - 1].text}`),
    el('div', { class: 'res-plot' }, bars,
      el('i', { class: 'res-cut', style: `left:${cutoffs.meet * 100}%` }), el('i', { class: 'res-cut', style: `left:${cutoffs.exceed * 100}%` })),
    el('div', { class: 'res-axis', 'aria-hidden': 'true' }, [0, 25, 50, 75, 100].map((t) => el('span', { text: `${t}%` }))),
    readout);
}

function resultsTable(marks) {
  const pct = (n, all) => (all ? `${(n / all * 100).toFixed(1)}%` : '-');
  const cuts = cutsOf(marks);
  const targets = targetsOf(marks);
  const rows = marks.clos.map((clo, i) => {
    const bands = countBands(clo, cuts[i]);
    const shares = clo.scores.map(({ got }) => got / clo.most * 100);
    const n = shares.length;
    const status = n ? cloStatus(bands, targets[i]) : null;
    return el('tr', {}, el('td', {}, el('strong', { text: `CLO${i + 1}` })), el('td', { class: 'num', text: String(n) }),
      el('td', { class: 'num', text: pct(shares.reduce((a, b) => a + b, 0) / 100, n) }),
      el('td', { class: 'num', text: n ? `${Math.min(...shares).toFixed(0)}% to ${Math.max(...shares).toFixed(0)}%` : '-' }),
      el('td', { class: 'num', text: `${percent(cuts[i].meet)} / ${percent(cuts[i].exceed)}` }),
      ['exceed', 'meet', 'below'].map((band) => el('td', { class: 'num', text: `${bands[band]} (${pct(bands[band], n)})` })),
      el('td', { class: 'num', text: pct(bands.exceed + bands.meet, n) }),
      el('td', { class: 'num', text: percent(targets[i]) }),
      el('td', {}, status ? el('span', { class: `res-status res-status-${status}`, text: STATUS_LABEL[status] }) : '-'));
  });
  return el('table', { class: 'dt dt-compact' },
    el('thead', {}, el('tr', {}, ['CLO', 'Students', 'Average', 'Range', 'Meet / Exceed from', 'Exceed', 'Meet', 'Does not meet', 'Met or exceeded', 'Target', 'Against target'].map((text) => el('th', { text })))),
    el('tbody', {}, rows));
}

// Students in each band across the CLOs, as the sliders now stand, and the change from the marks sheet's cut-offs.
function bandSummary(marks) {
  const cuts = cutsOf(marks);
  const sheet = Array.isArray(marks.sheetCutoffs) ? marks.sheetCutoffs : cuts;
  const moved = !sameCuts(sheet, cuts);
  const clos = marks.clos.map((clo, i) => ({ i, clo })).filter(({ clo }) => clo.scores.length);
  const now = clos.map(({ clo, i }) => countBands(clo, cuts[i]));
  const was = clos.map(({ clo, i }) => countBands(clo, sheet[i]));
  const cell = (n, before, all) => el('td', { class: 'num' }, el('strong', { text: String(n) }),
    moved && n !== before ? el('span', { class: `res-delta ${n > before ? 'is-up' : 'is-down'}`, text: ` ${n > before ? '+' : '−'}${Math.abs(n - before)}` }) : null,
    all ? el('span', { class: 'fine', text: ` (${percent(n / all)})` }) : null);
  const total = (rows, band) => rows.reduce((t, r) => t + r[band], 0);
  const assessed = now.reduce((t, r) => t + r.exceed + r.meet + r.below, 0);
  return el('table', { class: 'dt dt-compact res-overall', id: 'res-overall' },
    el('thead', {}, el('tr', {}, ['Band', ...clos.map(({ i }) => `CLO${i + 1}`), 'All CLOs'].map((text) => el('th', { text })))),
    el('tbody', {}, ['exceed', 'meet', 'below'].map((band) => el('tr', {},
      el('td', {}, el('i', { class: `res-key res-${band}` }), ` ${BAND_LABEL[band]}`),
      now.map((r, k) => cell(r[band], was[k][band])),
      cell(total(now, band), total(was, band), assessed)))),
    el('tfoot', {}, el('tr', {}, el('td', { text: 'Students assessed' }), now.map((r) => el('td', { class: 'num', text: String(r.exceed + r.meet + r.below) })),
      el('td', { class: 'num', text: String(assessed) }))));
}

// The cut-offs the sliders show: the chosen CLO's, or with All CLOs the first CLO's.
const shownCut = (marks) => cutsOf(marks)[planCutScope === 'all' ? 0 : planCutScope] || cutsOf(marks)[0];

function paintResults() {
  const marks = planMarks[planResultsCode];
  const cuts = cutsOf(marks);
  const targets = targetsOf(marks);
  const { exceed, meet } = shownCut(marks);
  const bins = marks.clos.map((clo) => {
    const counts = new Map();
    for (const { got } of clo.scores) {
      const bin = Math.min(100 / BIN_WIDTH - 1, Math.floor(got / clo.most * 100 / BIN_WIDTH));
      counts.set(bin, (counts.get(bin) || 0) + 1);
    }
    return Math.max(0, ...counts.values());
  });
  const top = Math.max(1, ...bins); // one height scale, so the CLOs compare directly
  $('res-slider').style.setProperty('--meet', `${meet * 100}%`);
  $('res-slider').style.setProperty('--exceed', `${exceed * 100}%`);
  $('res-range-below').textContent = `0% to below ${percent(meet)}`;
  $('res-range-meet').textContent = `${percent(meet)} to below ${percent(exceed)}`;
  $('res-range-exceed').textContent = `${percent(exceed)} to 100%`;
  const sheet = Array.isArray(marks.sheetCutoffs) ? marks.sheetCutoffs : cuts;
  const moved = !sameCuts(sheet, cuts);
  const changed = cuts.map((c, i) => (c.exceed !== sheet[i].exceed || c.meet !== sheet[i].meet ? `CLO${i + 1}` : '')).filter(Boolean);
  const differ = !cuts.every((c) => c.exceed === cuts[0].exceed && c.meet === cuts[0].meet);
  $('res-reset').hidden = !moved;
  $('res-scope-note').textContent = planCutScope === 'all' && differ ? 'The CLOs have different cut-offs; the handles show CLO1’s. Moving a handle gives every CLO the same cut-offs.' : '';
  $('res-sheet-note').textContent = moved ? `${changed.join(', ')} ${changed.length === 1 ? 'differs' : 'differ'} from the marks sheet’s cut-offs. The AoL Report will use these sliders, so its numbers will differ from the sheet’s AoL Summary tab.` : '';
  $('res-charts').replaceChildren(...marks.clos.map((clo, i) => (clo.scores.length ? distributionChart(clo, i + 1, cuts[i], top)
    : el('figure', { class: 'res-chart' }, el('figcaption', {}, el('strong', { text: `CLO${i + 1}` }), ' No marks for this CLO.')))));
  $('res-table').replaceChildren(resultsTable(marks));
  $('res-overall-box').replaceChildren(bandSummary(marks));
  $('res-overall-note').textContent = moved ? 'Counts of students, each student once per CLO. Coloured figures are the change from the marks sheet’s cut-offs.' : 'Counts of students, each student once per CLO. Move a handle to see how many change band.';
  marks.clos.forEach((clo, i) => {
    const card = $(`res-review-${i}`);
    if (!card) return;
    card.querySelector('.res-analysis').value = marks.review[i].analysis;
    card.querySelector('.res-plan').value = marks.review[i].improvement;
    const status = clo.scores.length ? cloStatus(countBands(clo, cuts[i]), targets[i]) : null;
    const pill = card.querySelector('.res-status');
    if (status && card.dataset.status !== status) { card.dataset.status = status; fillReviewCoaching(card, clo, status, i); }
    if (status) { pill.className = `res-status res-status-${status}`; pill.textContent = STATUS_LABEL[status]; }
  });
}

function moveCutoff(which, value) {
  const marks = planMarks[planResultsCode];
  const { exceed, meet } = shownCut(marks);
  const next = which === 'meet' ? { exceed, meet: Math.max(1, Math.min(value, exceed * 100 - 1)) / 100 }
    : { meet, exceed: Math.min(100, Math.max(value, meet * 100 + 1)) / 100 };
  applyCutoffs(marks, cutsOf(marks).map((c, i) => (planCutScope === 'all' || planCutScope === i ? next : c)));
  $('res-meet').value = Math.round(next.meet * 100);
  $('res-exceed').value = Math.round(next.exceed * 100);
  paintResults();
}

function fillReviewCoaching(card, clo, status, i) {
  const marks = planMarks[planResultsCode];
  const weakest = weakestItem(clo);
  const fill = (text) => text.replace('{item}', weakest ? weakest.label : 'this assessment');
  const level = weakest && weakest.bloom >= HIGHER_ORDER ? 'higher' : 'lower';
  card.querySelector('.res-prompts').replaceChildren(...planCoaching.prompts[status].map((text) => el('li', { text: fill(text) })));
  card.querySelector('.res-suggest').replaceChildren(...planCoaching.suggestions[status][level].map(fill).map((text) => el('button', { class: 'res-chip', type: 'button', text: `+ ${text}`,
    onclick: () => {
      const plan = card.querySelector('.res-plan');
      if (plan.value.includes(text)) return;
      plan.value = plan.value.trim() ? `${plan.value.trim()}\n${text}` : text;
      marks.review[i].improvement = plan.value;
      marks.review[i].improvementEdited = true;
      saveMarks(planResultsCode);
    } })));
}

function reviewCard(clo, i) {
  const marks = planMarks[planResultsCode];
  const fields = planFields.get(planResultsCode).clos[i];
  const edit = (key, cls, label) => el('label', { class: 'res-field' }, el('span', { text: label }),
    el('textarea', { class: cls, rows: 4, oninput: (e) => { marks.review[i][key] = e.target.value; marks.review[i][`${key}Edited`] = true; }, onchange: () => saveMarks(planResultsCode) }));
  const sections = [...new Set(clo.scores.map((s) => s.section).filter(Boolean))].sort().map((section) => {
    const scores = clo.scores.filter((s) => s.section === section);
    return `Section ${section} ${(scores.reduce((sum, s) => sum + s.got / clo.most * 100, 0) / scores.length).toFixed(1)}%`;
  });
  const card = el('article', { class: 'res-card', id: `res-review-${i}` },
    el('div', { class: 'res-card-head' }, el('h4', { text: `CLO${i + 1} · PLG ${fields.plg}` }), el('span', { class: 'res-status' })),
    el('p', { class: 'fine', text: fields.text }),
    el('p', { class: 'res-evidence' }, el('strong', { text: 'Evidence: ' }),
      [...clo.items.filter((item) => item.average != null).map((item) => `${item.label} ${item.average.toFixed(1)}%`), ...sections].join(' · ')),
    el('div', { class: 'res-split' },
      el('div', {}, el('h5', { text: 'Ask yourself' }), el('ul', { class: 'res-prompts' })),
      el('div', {}, edit('analysis', 'res-analysis', 'Analysis of Result'),
        edit('improvement', 'res-plan', 'Improvement Plan'),
        el('h5', { text: 'Suggestions to add' }), el('div', { class: 'res-suggest' }),
        el('button', { class: 'btn-link', type: 'button', text: 'Go back to the draft', onclick: () => {
          marks.review[i] = {};
          applyCutoffs(marks, marks.cutoffs);
          saveMarks(planResultsCode);
          paintResults();
        } }))));
  return card;
}

async function renderResults() {
  const subjects = planSubjects();
  if (!subjects.length) return;
  planResultsCode ||= subjects[0]['Subject Code'];
  await subjectFields(planResultsCode);
  await loadCoaching();
  const picker = el('select', { id: 'res-subject', onchange: (e) => { planResultsCode = e.target.value; renderResults(); } },
    subjects.map((c) => el('option', { value: c['Subject Code'], text: `${c['Subject Code']} ${c.Subject}${planMarks[c['Subject Code']] ? '' : ' (no marks yet)'}` })));
  picker.value = planResultsCode;
  const head = [el('div', { class: 'toolbar' }, el('label', { class: 'select' }, el('span', { text: 'Subject' }), picker)), marksBar(planResultsCode)];
  const marks = planMarks[planResultsCode];
  if (!marks) { $('plan-panel-results').replaceChildren(...head); return; }
  perCloMarks(marks);
  if (planCutScope !== 'all' && !(planCutScope < marks.clos.length)) planCutScope = 'all';
  const slider = (id, which, label) => el('input', { type: 'range', id, min: 0, max: 100, step: 1, 'aria-label': label, value: Math.round(shownCut(marks)[which] * 100),
    oninput: (e) => moveCutoff(which, Number(e.target.value)), onchange: () => saveMarks(planResultsCode) });
  const range = (band, label) => el('div', { class: 'res-range' }, el('i', { class: `res-key res-${band}` }), el('strong', { text: label }), el('span', { id: `res-range-${band}` }));
  $('plan-panel-results').replaceChildren(...head,
    el('p', { class: 'plan-intro' }, `Marks from ${marks.name}, ${plural(marks.students, 'student')}. Drag the two handles to set where each band starts and ends. The bands meet, so the top of one is the bottom of the next.`),
    el('div', { class: 'res-top' },
    el('section', { class: 'res-bands' },
      el('div', { class: 'res-scope' }, el('label', { class: 'select' }, el('span', { text: 'Cut-offs for' }),
        el('select', { id: 'res-scope', onchange: (e) => {
          planCutScope = e.target.value === 'all' ? 'all' : Number(e.target.value);
          $('res-meet').value = Math.round(shownCut(marks).meet * 100);
          $('res-exceed').value = Math.round(shownCut(marks).exceed * 100);
          paintResults();
        } }, el('option', { value: 'all', text: 'All CLOs', selected: planCutScope === 'all' }),
          marks.clos.map((c, i) => el('option', { value: String(i), text: `CLO${i + 1}`, selected: planCutScope === i }))))),
      el('p', { class: 'fine', id: 'res-scope-note' }),
      el('div', { class: 'band-slider', id: 'res-slider' }, slider('res-meet', 'meet', 'Lowest mark for Meet Expectation, in percent'), slider('res-exceed', 'exceed', 'Lowest mark for Exceed Expectation, in percent')),
      el('div', { class: 'band-scale', 'aria-hidden': 'true' }, [0, 25, 50, 75, 100].map((t) => el('span', { text: `${t}%` }))),
      el('div', { class: 'res-ranges' }, range('below', 'Does not meet'), range('meet', 'Meet'), range('exceed', 'Exceed')),
      el('button', { class: 'btn-link', type: 'button', id: 'res-reset', text: 'Go back to the marks sheet’s cut-offs', onclick: () => {
        applyCutoffs(marks, marks.sheetCutoffs);
        saveMarks(planResultsCode);
        renderResults();
      } }),
      el('p', { class: 'fine', id: 'res-sheet-note' })),
    el('section', { class: 'res-overall-card' },
      el('h3', { class: 'res-overall-title', text: 'Students in each band' }),
      el('div', { class: 'table-card table-scroll', id: 'res-overall-box' }),
      el('p', { class: 'fine', id: 'res-overall-note' }))),
    el('h3', { class: 'subtitle', text: 'Distribution of marks by CLO' }),
    el('p', { class: 'fine', text: 'Each bar is 5% of the marks for that CLO, and its height is the number of students. The two lines are the cut-offs.' }),
    el('div', { class: 'res-charts', id: 'res-charts' }),
    el('div', { class: 'table-card table-scroll', id: 'res-table' }),
    el('h3', { class: 'subtitle', text: 'Analysis of results and improvement plan' }),
    el('p', { class: 'fine', text: 'Start from the questions, then rewrite the draft in your own words. Your text goes into the last table of the AoL Report, and the numbers in an untouched draft follow the sliders.' }),
    ...marks.clos.map((clo, i) => (clo.scores.length ? reviewCard(clo, i) : null)).filter(Boolean),
    el('div', { class: 'plan-actions' },
      el('button', { class: 'btn btn-primary', type: 'button', onclick: () => downloadReport(planResultsCode) }, icon('download'), ' Download AoL Report'),
      el('span', { class: 'fine', id: 'res-status', role: 'status' })));
  marks.clos.forEach((clo, i) => {
    const card = $(`res-review-${i}`);
    if (!card) return;
    const status = cloStatus(countBands(clo, cutsOf(marks)[i]), targetsOf(marks)[i]);
    card.dataset.status = status;
    fillReviewCoaching(card, clo, status, i);
  });
  paintResults();
}

async function downloadReport(code) {
  const name = planIndex[code].report;
  $('res-status').textContent = `Building ${name}…`;
  try {
    await saveMarks(code);
    saveBlob(await planBlob({ code, kind: 'report', name }), name);
    $('res-status').textContent = `${name} is ready.`;
  } catch (e) {
    $('res-status').textContent = 'The report couldn’t be built. Check your template’s marked fields, or restore the default.';
  }
}

// ------------------------------------------------------------------ reference outline: build this year's outline from last year's

const yearBefore = (span) => span.replace(/^(\d{4})-(\d{2,4})$/, (_, a, b) => `${a - 1}-${String(b - 1).padStart(b.length, '0')}`);
const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Turns last year's outline into this year's draft: marked fields filled, last year's batch and academic year moved on one, and the banner reset. */
async function rollForward(blob, fields) {
  let filled = blob;
  try { filled = await fillDocx(blob, fields); } catch (e) { /* stray braces in the text: use it as it is */ }
  const PizZip = await loadPizZip();
  const zip = new PizZip(await filled.arrayBuffer());
  const swaps = [[yearBefore(fields.batch), fields.batch], [yearBefore(fields.academic_year), fields.academic_year]].map(([from, to]) => [escapeXml(from), escapeXml(to)]);
  const xml = zip.file('word/document.xml').asText().replace(/(<w:t(?: [^>]*)?>)([^<]*)(<\/w:t>)/g, (_, open, text, close) => {
    let out = text.replace(/PREVIOUS VERSION[^<]*?FOR REFERENCE/, 'DRAFT FOR FACULTY REVIEW');
    for (const [from, to] of swaps) out = out.split(from).join(to);
    return open + out + close;
  });
  zip.file('word/document.xml', xml);
  return zip.generate({ type: 'blob', mimeType: DOCX_TYPE });
}

async function loadSavedReferences() {
  for (const c of planSubjects()) {
    try {
      const saved = await templateStore('readonly', (s) => s.get(`reference:${c['Subject Code']}`));
      if (saved) planReferences[c['Subject Code']] = saved;
    } catch (e) { /* storage blocked: the default is used */ }
  }
}

async function uploadReference(code, file, message) {
  message.textContent = 'Checking the file…';
  message.className = 'tpl-msg';
  if (file.size > TEMPLATE_LIMIT) { message.textContent = 'That file is over 10 MB.'; message.className = 'tpl-msg is-error'; return; }
  let body;
  try { body = await outlineBody(file); } catch (e) {
    message.textContent = 'That file couldn’t be read as a Word document (.docx).';
    message.className = 'tpl-msg is-error';
    return;
  }
  const warning = body.textContent.includes(code) ? '' : `This file doesn’t mention ${code}. Check it is the right subject’s outline.`;
  planReferences[code] = { name: file.name, blob: new Blob([file], { type: DOCX_TYPE }), savedAt: new Date().toISOString(), warning };
  try { await templateStore('readwrite', (s) => s.put(planReferences[code], `reference:${code}`)); } catch (e) { /* kept for this visit */ }
  clearPlanResults();
}

async function removeReference(code) {
  delete planReferences[code];
  try { await templateStore('readwrite', (s) => s.delete(`reference:${code}`)); } catch (e) { /* nothing was stored */ }
  clearPlanResults();
}

// The reference upload beside the Generate button, for the Course Outline only.
function renderReference() {
  const box = $('plan-reference');
  if (!box) return;
  box.hidden = !$('plan-outline').checked;
  if (box.hidden) return;
  const code = $('plan-subject').value;
  const message = el('p', { class: 'tpl-msg', role: 'status' });
  if (!code) {
    const using = pickedSubjects().map((c) => c['Subject Code']).filter((c) => planReferences[c]);
    box.replaceChildren(el('button', { class: 'btn btn-outline btn-sm', type: 'button', id: 'plan-ref-upload', disabled: true }, icon('upload'), ' Upload reference outline'),
      el('p', { class: 'fine', text: using.length ? `Course Outlines for ${using.join(', ')} are built from your reference documents; the rest use the default. Pick one subject to change its reference.`
        : 'Pick one subject to build its Course Outline from your own reference document, such as last year’s outline. Otherwise the default is used.' }));
    return;
  }
  const ref = planReferences[code];
  const input = el('input', { type: 'file', accept: '.docx', hidden: true, id: 'plan-ref-file', 'aria-label': `Upload reference Course Outline for ${code}`,
    onchange: (e) => { if (e.target.files[0]) uploadReference(code, e.target.files[0], message); e.target.value = ''; } });
  const prev = planIndex[code] && planIndex[code].previous;
  box.replaceChildren(
    el('button', { class: 'btn btn-outline btn-sm', type: 'button', id: 'plan-ref-upload', onclick: () => input.click() }, icon('upload'), ref ? ' Replace reference outline' : ' Upload reference outline'),
    ref ? el('p', { class: 'fine' }, el('strong', { text: 'Using your reference: ' }), `${ref.name}, saved ${dateText(ref.savedAt)}. The batch and academic year are moved on to this year. `,
      el('button', { class: 'btn-link', type: 'button', id: 'plan-ref-remove', text: 'Use the default instead', onclick: () => removeReference(code) }))
      : el('p', { class: 'fine' }, `Optional: build ${code}’s Course Outline from your own reference document, such as last year’s outline. Without one, the default is used. `,
        prev ? el('a', { href: PLAN_DIR + prev, download: true, text: 'Last year’s outline' }) : null),
    ...(ref && ref.warning ? [el('p', { class: 'tpl-msg is-warning', text: ref.warning })] : []),
    message, input);
}

// ------------------------------------------------------------------ outline review: reference, reupload, approval, PDF, sharing

const OUTLINE_STATUS = { draft: 'Not submitted', submitted: 'Waiting for approval', changes: 'Changes requested', approved: 'Approved' };
const dateText = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const OUTLINE_STYLES = ["p[style-name='Subtitle'] => h1:fresh", "p[style-name='Heading 1'] => p.doc-detail:fresh", "p[style-name='Heading 5'] => h2:fresh"];
const DOC_CSS = 'body{font:11pt/1.35 "Times New Roman",Times,serif;color:#111;background:#fff;margin:28px;white-space:pre-wrap;tab-size:6}h1,h2,.doc-h{font-size:14pt;font-weight:700;margin:14px 0 6px}h1{text-align:center}p{margin:0 0 6px}.doc-detail{tab-size:26}table{border-collapse:collapse;width:100%;margin:6px 0 12px;white-space:normal}td,th{border:1px solid #888;padding:4px 6px;vertical-align:top;font-size:11pt}td p{margin:0}img{display:block;margin:0 auto 8px;max-width:220px}';

const saveOutline = (code) => templateStore('readwrite', (s) => s.put(planOutlines[code], `outline:${code}`));

async function loadSavedOutlines() {
  for (const c of planSubjects()) {
    try {
      const saved = await templateStore('readonly', (s) => s.get(`outline:${c['Subject Code']}`));
      if (saved) planOutlines[c['Subject Code']] = saved;
    } catch (e) { /* storage blocked: the workflow starts fresh */ }
  }
}

async function outlineBody(blob) {
  const mammoth = await loadScript(MAMMOTH, 'mammoth');
  const { value } = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() }, { styleMap: OUTLINE_STYLES });
  const { body } = new DOMParser().parseFromString(value, 'text/html');
  for (const p of body.querySelectorAll(':scope > p')) {
    const bold = p.textContent.trim() && [...p.childNodes].every((n) => n.nodeName === 'STRONG' || !n.textContent.trim());
    if (bold && !/^(DRAFT FOR|PREVIOUS VERSION)/.test(p.textContent)) p.classList.add('doc-h');
    if (p.classList.contains('doc-detail')) {
      const [label, ...value] = p.textContent.split('\t');
      p.replaceChildren(el('strong', { text: label }), `\t${value.join(' ')}`);
    }
  }
  // Word numbers the S. No. column itself, so those cells arrive empty.
  for (const table of body.querySelectorAll('table')) {
    if (!/^S\.?\s*No/i.test(table.rows[0].cells[0].textContent.trim())) continue;
    [...table.rows].slice(1).forEach((row, n) => { if (!row.cells[0].textContent.trim()) row.cells[0].textContent = `${n + 1}.`; });
  }
  return body;
}

async function setOutline(code, name, blob, message) {
  const old = planOutlines[code];
  message.textContent = 'Checking the file…';
  message.className = 'tpl-msg';
  try {
    await outlineBody(blob);
    planOutlines[code] = { name, blob, savedAt: new Date().toISOString(), version: (old ? old.version : 0) + 1, status: 'draft' };
    await saveOutline(code);
    clearPlanResults();
    renderOutline();
  } catch (e) {
    message.textContent = 'That file couldn’t be read as a Word document.';
    message.className = 'tpl-msg is-error';
  }
}

async function decideOutline(code, changes) {
  planOutlines[code] = { ...planOutlines[code], ...changes };
  try { await saveOutline(code); } catch (e) { /* storage blocked: kept for this visit */ }
  clearPlanResults();
  renderOutline();
}

const pdfText = (text) => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/₹/g, 'Rs ').replace(/ /g, ' ');

/** Writes the approved outline as a PDF in the same type as the Word document: Times, 14 point headings, 11 point text. */
async function outlinePdf(code, record) {
  const { jsPDF } = await loadScript(JSPDF, 'jspdf');
  await loadScript(AUTOTABLE, 'jspdf-autotable');
  const body = await outlineBody(record.blob);
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 56;
  const right = pageWidth - margin;
  let y = margin + 8;
  const room = (height) => { if (y + height > pageHeight - margin) { doc.addPage(); y = margin + 8; } };

  const runsOf = (node, bold = false) => [...node.childNodes].flatMap((n) => {
    if (n.nodeType === Node.TEXT_NODE) return [{ text: pdfText(n.textContent), bold }];
    return runsOf(n, bold || n.nodeName === 'STRONG' || n.nodeName === 'B');
  });

  function write(runs, { size = 11, center = false, stop = 40, after = 5 } = {}) {
    const height = size * 1.25;
    const words = runs.flatMap(({ text, bold }) => text.split(/(\s+)/).filter(Boolean).map((word) => ({ word, bold })));
    const lines = [[]];
    let x = margin;
    let hang = margin;
    for (const { word, bold } of words) {
      doc.setFont('times', bold ? 'bold' : 'normal');
      doc.setFontSize(size);
      if (word.includes('\t')) { hang = margin + stop; x = Math.max(hang, x + 6); continue; }
      const width = doc.getTextWidth(word);
      if (/^\s+$/.test(word)) { if (x > hang) x += width; continue; }
      if (x + width > right && x > hang) { lines.push([]); x = hang; }
      lines[lines.length - 1].push({ word, bold, x, width });
      x += width;
    }
    for (const line of lines) {
      room(height);
      const shift = center && line.length ? (right - margin - (line.at(-1).x + line.at(-1).width - margin)) / 2 : 0;
      for (const { word, bold, x: at } of line) {
        doc.setFont('times', bold ? 'bold' : 'normal');
        doc.setFontSize(size);
        doc.text(word, at + shift, y);
      }
      y += height;
    }
    y += after;
  }

  const cellLines = (cell) => {
    const lists = [...cell.querySelectorAll('li')].map((li, i) => `${String.fromCharCode(97 + i)}. ${li.textContent.trim()}`);
    const paragraphs = [...cell.querySelectorAll(':scope > p')].map((p) => p.textContent.trim()).filter(Boolean);
    const text = paragraphs.length || lists.length ? [...paragraphs, ...lists].join('\n') : cell.textContent.trim();
    return pdfText(text);
  };

  for (const node of body.children) {
    const text = node.textContent.trim();
    const image = node.querySelector('img');
    if (image) {
      const { width, height } = doc.getImageProperties(image.src);
      const shown = 170;
      room(shown * height / width + 8);
      doc.addImage(image.src, (pageWidth - shown) / 2, y - 8, shown, shown * height / width);
      y += shown * height / width + 4;
    } else if (node.nodeName === 'TABLE') {
      const cells = [...node.rows].map((row) => [...row.cells].map((cell) => ({ content: cellLines(cell), colSpan: cell.colSpan, rowSpan: cell.rowSpan })));
      const [head, ...rows] = cells.length > 1 ? cells : [[], ...cells]; // a sign-off box is one row with no header
      doc.autoTable({ startY: y, head: head.length ? [head] : [], body: rows, theme: 'grid', rowPageBreak: 'avoid', margin: { left: margin, right: margin, top: margin, bottom: margin + 8 },
        styles: { font: 'times', fontSize: 11, textColor: 20, lineColor: 130, lineWidth: 0.5, cellPadding: 3.5, valign: 'middle' },
        headStyles: { fillColor: [240, 240, 240], textColor: 20, fontStyle: 'bold' } });
      y = doc.lastAutoTable.finalY + 14;
    } else if (node.nodeName === 'OL' || node.nodeName === 'UL') {
      [...node.children].forEach((li, i) => write([{ text: `${i + 1}.\t`, bold: true }, ...runsOf(li)], { after: 2 }));
      y += 3;
    } else if (/^(DRAFT FOR|PREVIOUS VERSION)/.test(text)) {
      continue; // the version line belongs to the working copy, not the approved one
    } else if (text) {
      const heading = node.nodeName === 'H1' || node.nodeName === 'H2' || node.classList.contains('doc-h');
      if (heading) { y += 6; room(50); }
      const detail = node.classList.contains('doc-detail');
      const runs = heading ? [{ text: pdfText(text), bold: true }] : runsOf(node);
      write(detail ? [{ text: text.split('\t')[0], bold: true }, { text: '\t', bold: false }, { text: pdfText(text.split('\t').slice(1).join(' ')), bold: false }] : runs,
        { size: heading ? 14 : 11, center: node.nodeName === 'H1', stop: detail ? 130 : 40, after: heading ? 7 : 5 });
    }
  }
  const stamp = `Approved by ${record.approvedBy} on ${dateText(record.approvedAt)}. Version ${record.version}.`;
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);
    doc.setFont('times', 'normal');
    doc.setFontSize(11);
    doc.text(pdfText(stamp), margin, pageHeight - 30);
    doc.text(`${page} of ${pages}`, right, pageHeight - 30, { align: 'right' });
  }
  doc.setProperties({ title: `${code} Course Outline`, author: 'E-Logic School of Business', creator: 'E-Logic Course Planner' });
  return doc.output('blob');
}

const pdfName = (code) => `${code}_Course_Outline_Approved.pdf`;

async function makeOutlinePdf(code, message) {
  message.textContent = 'Making the PDF…';
  message.className = 'tpl-msg';
  try {
    const record = planOutlines[code];
    const pdf = await outlinePdf(code, record);
    await decideOutline(code, { pdf, pdfAt: new Date().toISOString() });
  } catch (e) {
    message.textContent = 'The PDF couldn’t be made.';
    message.className = 'tpl-msg is-error';
  }
}

async function shareOutline(code) {
  const record = planOutlines[code];
  const fields = await subjectFields(code);
  const subject = `${code} ${fields.course_name}: Course Outline`;
  const text = `Dear students,\n\nThe approved Course Outline for ${fields.course_name} is attached. Please read it before the first session.\n\n${fields.instructor}`;
  const file = new File([record.pdf], pdfName(code), { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: subject, text });
    } catch (e) { return; } // cancelled: nothing was shared
  } else {
    saveBlob(record.pdf, pdfName(code));
    el('a', { href: `mailto:bba-${fields.batch}@elogic.example.edu?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}` }).click();
  }
  await decideOutline(code, { sharedAt: new Date().toISOString() });
}

function outlineStep(n, title, state, ...children) {
  return el('li', { class: `flow-step is-${state}` }, el('h3', {}, el('b', { text: String(n) }), title), ...children);
}

// ------------------------------------------------------------------ editing an outline's text in the page

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const isW = (node, name) => node.nodeType === 1 && node.namespaceURI === W_NS && node.localName === name;
const wChild = (node, name) => node && [...node.childNodes].find((c) => isW(c, name));
const wVal = (node) => node && node.getAttributeNS(W_NS, 'val');
const isOn = (node) => !!node && !['0', 'false', 'none'].includes(wVal(node) || '');
const SKIPPED = ['pPr', 'rPr', 'drawing', 'pict', 'AlternateContent', 'del', 'instrText', 'fldChar'];

// The text of a paragraph as editable pieces: Word text, tabs and line breaks, in reading order.
function textSegments(p) {
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1 || SKIPPED.includes(child.localName)) continue;
      if (isW(child, 't')) out.push({ node: child, text: child.textContent });
      else if (isW(child, 'tab')) out.push({ node: child, text: '\t' });
      else if (isW(child, 'br') || isW(child, 'cr')) out.push({ node: child, text: '\n' });
      else walk(child);
    }
  };
  walk(p);
  return out;
}

/** Writes new text into a Word paragraph, changing only the characters that differ so each run keeps its formatting. */
function applyText(p, next) {
  const segs = textSegments(p);
  const old = segs.map((x) => x.text).join('');
  next = next.replace(/ /g, ' ');
  if (old === next) return false;
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start += 1;
  let end = 0;
  while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end += 1;
  const delTo = old.length - end;
  const insert = next.slice(start, next.length - end).replace(/[\t\n]/g, ' ');
  let pos = 0;
  for (const x of segs) { x.a = pos; pos += x.text.length; x.b = pos; }
  const texts = segs.filter((x) => isW(x.node, 't'));
  // New text goes into the run it was typed in, or the one it follows.
  const target = texts.find((x) => x.a <= start && start < x.b) || [...texts].reverse().find((x) => x.b === start) || texts.find((x) => x.a >= start) || texts[texts.length - 1];
  for (const x of segs) {
    const cutA = Math.max(x.a, start);
    const cutB = Math.min(x.b, delTo);
    if (isW(x.node, 't')) {
      const keepHead = x.text.slice(0, Math.max(0, cutA - x.a));
      const keepTail = cutA < cutB ? x.text.slice(cutB - x.a) : x.text.slice(Math.max(0, cutA - x.a));
      x.out = x === target ? keepHead + insert + keepTail : (cutA < cutB ? keepHead + keepTail : x.text);
    } else if (x.a >= start && x.b <= delTo) {
      x.node.parentNode.removeChild(x.node);
    }
  }
  if (!target) {
    if (!insert) return true;
    const doc = p.ownerDocument;
    const run = doc.createElementNS(W_NS, 'w:r');
    const mark = wChild(wChild(p, 'pPr'), 'rPr');
    if (mark) run.appendChild(mark.cloneNode(true));
    const t = doc.createElementNS(W_NS, 'w:t');
    t.textContent = insert;
    t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
    run.appendChild(t);
    p.appendChild(run);
    return true;
  }
  for (const x of texts) {
    if (x.out === undefined || x.out === x.text) continue;
    x.node.textContent = x.out;
    x.node.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
  }
  return true;
}

function wordStyles(xml) {
  const styles = {};
  if (!xml) return styles;
  for (const st of new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagNameNS(W_NS, 'style')) {
    const pPr = wChild(st, 'pPr');
    const rPr = wChild(st, 'rPr');
    styles[st.getAttributeNS(W_NS, 'styleId')] = { jc: wVal(wChild(pPr, 'jc')), b: rPr && wChild(rPr, 'b') ? isOn(wChild(rPr, 'b')) : undefined,
      sz: wVal(wChild(rPr, 'sz')) };
  }
  return styles;
}

/** Opens a Word file as editable HTML: one editable block per paragraph, laid out as in Word. */
async function openDocEditor(blob) {
  const PizZip = await loadPizZip();
  const zip = new PizZip(await blob.arrayBuffer());
  const xml = new DOMParser().parseFromString(zip.file('word/document.xml').asText(), 'application/xml');
  const styles = wordStyles(zip.file('word/styles.xml') && zip.file('word/styles.xml').asText());
  const rels = {};
  const relXml = zip.file('word/_rels/document.xml.rels');
  if (relXml) for (const r of new DOMParser().parseFromString(relXml.asText(), 'application/xml').getElementsByTagName('Relationship')) rels[r.getAttribute('Id')] = r.getAttribute('Target');
  const paragraphs = [];

  const image = (p) => {
    const blip = p.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'blip')[0];
    const target = blip && rels[blip.getAttributeNS(R_NS, 'embed')];
    const file = target && zip.file(`word/${target.replace(/^\/?word\//, '')}`);
    return file ? el('img', { src: URL.createObjectURL(new Blob([file.asUint8Array()])), alt: '' }) : null;
  };
  const paragraph = (p) => {
    const pPr = wChild(p, 'pPr');
    const style = styles[wVal(wChild(pPr, 'pStyle'))] || {};
    const jc = wVal(wChild(pPr, 'jc')) || style.jc;
    const runs = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1 || ['pPr', 'del'].includes(child.localName)) continue;
        if (!isW(child, 'r')) { walk(child); continue; }
        const rPr = wChild(child, 'rPr');
        const bold = rPr && wChild(rPr, 'b') ? isOn(wChild(rPr, 'b')) : style.b;
        const size = Number(wVal(wChild(rPr, 'sz')) || style.sz || 22) / 2;
        const text = textSegments(child).map((x) => x.text).join('');
        if (!text) continue;
        runs.push(el('span', { text, style: [bold ? 'font-weight:700' : '', rPr && isOn(wChild(rPr, 'i')) ? 'font-style:italic' : '',
          rPr && wChild(rPr, 'u') && isOn(wChild(rPr, 'u')) ? 'text-decoration:underline' : '', size !== 11 ? `font-size:${size}pt` : ''].filter(Boolean).join(';') || null }));
      }
    };
    walk(p);
    const original = textSegments(p).map((x) => x.text).join('');
    const block = el('p', { class: ['doc-p', pPr && wChild(pPr, 'numPr') ? 'doc-li' : ''].filter(Boolean).join(' '),
      style: jc ? `text-align:${{ both: 'justify', center: 'center', right: 'right', end: 'right' }[jc] || 'left'}` : null,
      contenteditable: 'plaintext-only', spellcheck: 'true' }, runs);
    paragraphs.push({ node: p, block, original });
    const picture = p.getElementsByTagNameNS(W_NS, 'drawing')[0] && image(p);
    return picture ? [el('div', { class: 'doc-img' }, picture), original ? block : null] : block;
  };
  const blocks = (parent) => [...parent.childNodes].flatMap((child) => {
    if (isW(child, 'p')) return paragraph(child);
    if (isW(child, 'tbl')) {
      return el('table', {}, [...child.childNodes].filter((r) => isW(r, 'tr')).map((r) => el('tr', {},
        [...r.childNodes].filter((c) => isW(c, 'tc')).map((c) => {
          const span = wVal(wChild(wChild(c, 'tcPr'), 'gridSpan'));
          return el('td', { colspan: span || null }, blocks(c));
        }))));
    }
    if (child.nodeType === 1 && ['sdt', 'sdtContent', 'customXml', 'smartTag'].includes(child.localName)) return blocks(child);
    return [];
  });

  const view = el('div', { class: 'doc-edit' }, blocks(xml.getElementsByTagNameNS(W_NS, 'body')[0]));
  const count = el('span', { class: 'fine', role: 'status', text: 'No changes yet.' });
  const changed = () => paragraphs.filter((x) => x.block.textContent !== x.original);
  view.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); }); // one Word paragraph per block
  view.addEventListener('paste', (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').replace(/\s*\n\s*/g, ' '));
  });
  view.addEventListener('input', (e) => {
    const hit = paragraphs.find((x) => x.block === e.target.closest('.doc-p'));
    if (hit) hit.block.classList.toggle('is-changed', hit.block.textContent !== hit.original);
    const n = changed().length;
    count.textContent = n ? `${plural(n, 'paragraph')} changed.` : 'No changes yet.';
  });
  const save = () => {
    const edits = changed();
    for (const x of edits) applyText(x.node, x.block.textContent);
    zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n${new XMLSerializer().serializeToString(xml.documentElement)}`);
    return { count: edits.length, blob: zip.generate({ type: 'blob', mimeType: DOCX_TYPE, compression: 'DEFLATE' }) };
  };
  return { view, count, changed, save };
}

async function editOutline(code, holder, message) {
  const record = planOutlines[code];
  message.textContent = 'Opening the editor…';
  message.className = 'tpl-msg';
  let editor;
  try { editor = await openDocEditor(record.blob); } catch (e) {
    message.textContent = 'This file couldn’t be opened for editing here. Please edit it in Word and upload it.';
    message.className = 'tpl-msg is-error';
    return;
  }
  message.textContent = '';
  const saveEdits = async () => {
    if (!editor.changed().length) { message.textContent = 'Nothing has changed yet.'; message.className = 'tpl-msg'; return; }
    const { blob } = editor.save();
    await setOutline(code, record.name, blob, message);
  };
  holder.replaceChildren(
    el('p', { class: 'fine', text: 'Click any text to change it; the Word formatting is kept. Rows and pictures can’t be added or removed here, so do that in Word and upload the file.' }),
    editor.view,
    el('div', { class: 'tpl-actions' },
      el('button', { class: 'btn btn-primary btn-sm', type: 'button', id: 'flow-save-edits', text: 'Save as a new version', onclick: saveEdits }),
      el('button', { class: 'btn btn-outline btn-sm', type: 'button', id: 'flow-cancel-edits', text: 'Cancel', onclick: () => {
        if (editor.changed().length && !confirm('Discard your changes?')) return;
        renderOutline();
      } }),
      editor.count),
    message);
  editor.view.querySelector('.doc-p')?.focus();
}

async function renderOutline() {
  const subjects = planSubjects();
  if (!subjects.length) return;
  planOutlineCode ||= subjects[0]['Subject Code'];
  const code = planOutlineCode;
  const fields = await subjectFields(code);
  const record = planOutlines[code];
  const status = record ? record.status : null;
  const approved = status === 'approved';
  const message = el('p', { class: 'tpl-msg', role: 'status' });
  const input = el('input', { type: 'file', accept: '.docx', hidden: true, id: 'flow-file', 'aria-label': `Upload the edited outline for ${code}`,
    onchange: (e) => {
      const [file] = e.target.files;
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.docx') || file.size > TEMPLATE_LIMIT) { message.textContent = 'Please upload a .docx file under 10 MB.'; message.className = 'tpl-msg is-error'; return; }
      setOutline(code, file.name, new Blob([file], { type: DOCX_TYPE }), message);
      e.target.value = '';
    } });
  const useDraft = async () => {
    const res = await fetch(PLAN_DIR + planIndex[code].outline);
    if (res.ok) setOutline(code, planIndex[code].outline, await res.blob(), message);
  };
  const picker = el('select', { id: 'flow-subject', onchange: (e) => { planOutlineCode = e.target.value; renderOutline(); } },
    subjects.map((c) => el('option', { value: c['Subject Code'], text: `${c['Subject Code']} ${c.Subject}` })));
  picker.value = code;
  const frame = el('iframe', { class: 'tpl-frame flow-frame', title: `${code} outline as it will appear`, sandbox: '' });
  const editMessage = el('p', { class: 'tpl-msg', role: 'status' });
  const checkHolder = el('div', { class: 'flow-check' });
  const editable = status === 'draft' || status === 'changes';
  if (record) {
    checkHolder.append(
      el('p', { class: 'fine', text: editable ? 'This is the text of your Word file, shown in its final type. Edit the text here, or fix it in Word and upload it again.'
        : 'This is the text of your Word file, shown in its final type. Editing it starts a new version, which has to be approved again.' }),
      frame,
      el('div', { class: 'tpl-actions' },
        editable ? el('button', { class: 'btn btn-primary btn-sm', type: 'button', id: 'flow-submit', text: 'Submit for approval', onclick: () => decideOutline(code, { status: 'submitted', submittedAt: new Date().toISOString() }) }) : null,
        el('button', { class: 'btn btn-outline btn-sm', type: 'button', id: 'flow-edit', text: 'Edit text', onclick: () => editOutline(code, checkHolder, editMessage) })),
      editMessage);
  }
  const approver = el('input', { type: 'text', id: 'flow-approver', value: fields.endorser, 'aria-label': 'Approver’s name' });
  const comment = el('textarea', { id: 'flow-comment', rows: 2, 'aria-label': 'Comment for the faculty member', placeholder: 'Comment for the faculty member' });
  const decision = (changes) => {
    const by = approver.value.trim();
    if (!by) { message.textContent = 'Please enter the approver’s name.'; message.className = 'tpl-msg is-error'; return; }
    decideOutline(code, changes(by));
  };
  $('plan-panel-outline').replaceChildren(
    el('div', { class: 'toolbar' }, el('label', { class: 'select' }, el('span', { text: 'Subject' }), picker)),
    el('p', { class: 'fine plan-intro', text: 'Saved in this browser only, and the site has no sign-in, so approval here shows the steps rather than proving who approved.' }),
    el('ol', { class: 'flow' },
      outlineStep(1, 'Upload your updated outline', record ? 'done' : 'active',
        record ? el('p', {}, el('strong', { text: `Version ${record.version}: ` }), `${record.name}, saved ${dateText(record.savedAt)}.`) : null,
        record && record.version > 1 ? null : el('p', { class: 'fine', text: 'A new upload starts a new version, which has to be approved again.' }),
        el('div', { class: 'tpl-actions' },
          el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: record ? 'Upload a new version' : 'Upload outline', onclick: () => input.click() }),
          record ? null : el('button', { class: 'btn btn-outline btn-sm', type: 'button', id: 'flow-draft', text: `Use the ${fields.academic_year} draft instead`, onclick: useDraft })),
        message, input),
      outlineStep(2, 'Check what goes into the document', !record ? 'todo' : status === 'draft' || status === 'changes' ? 'active' : 'done',
        !record ? el('p', { class: 'fine', text: 'Your outline appears here after you upload it.' }) : checkHolder),
      outlineStep(3, 'Approval', !record || status === 'draft' ? 'todo' : status === 'approved' ? 'done' : 'active',
        el('p', {}, el('strong', { text: record ? `${OUTLINE_STATUS[status]}. ` : '' }), `Approver: ${fields.endorser}, ${fields.endorser_role}.`),
        status === 'changes' ? el('p', { class: 'tpl-msg is-warning', text: `${record.reviewedBy}: ${record.comment || 'Please revise and upload a new version.'}` }) : null,
        approved ? el('p', { text: `Approved by ${record.approvedBy} on ${dateText(record.approvedAt)}${record.comment ? `: ${record.comment}` : '.'}` }) : null,
        status === 'submitted' ? el('div', { class: 'flow-form' }, approver, comment, el('div', { class: 'tpl-actions' },
          el('button', { class: 'btn btn-primary btn-sm', type: 'button', id: 'flow-approve', text: 'Approve', onclick: () => decision((by) => ({ status: 'approved', approvedBy: by, approvedAt: new Date().toISOString(), comment: comment.value.trim() })) }),
          el('button', { class: 'btn btn-outline btn-sm', type: 'button', id: 'flow-changes', text: 'Request changes', onclick: () => decision((by) => ({ status: 'changes', reviewedBy: by, comment: comment.value.trim() })) }))) : null),
      outlineStep(4, 'Make the PDF and share it with students', !approved ? 'todo' : record.sharedAt ? 'done' : 'active',
        !approved ? el('p', { class: 'fine', text: 'Available once the outline is approved.' }) : el('div', { class: 'tpl-actions' },
          record.pdf ? null : el('button', { class: 'btn btn-primary btn-sm', type: 'button', id: 'flow-pdf', text: 'Generate PDF', onclick: () => makeOutlinePdf(code, message) }),
          record.pdf ? el('button', { class: 'btn btn-outline btn-sm', type: 'button', id: 'flow-pdf-download', onclick: () => saveBlob(record.pdf, pdfName(code)) }, icon('download'), ' Download PDF') : null,
          record.pdf ? el('button', { class: 'btn btn-primary btn-sm', type: 'button', id: 'flow-share', text: 'Share with students', onclick: () => shareOutline(code) }) : null),
        approved && record.pdf ? el('p', { class: 'fine', text: `Saves the PDF and opens an email to the ${fields.batch} batch (${fields.students} students) for you to attach it to and send.` }) : null,
        record && record.sharedAt ? el('p', {}, el('strong', { text: 'Shared ' }), `on ${dateText(record.sharedAt)}.`) : null)));
  if (record) {
    const body = await outlineBody(record.blob);
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><style>${DOC_CSS}</style>${body.innerHTML}`;
  }
}

function renderTemplates() {
  $('tpl-grid').replaceChildren(...PLAN_DOCS.map(([kind, label]) => {
    const custom = planCustom[kind];
    const sample = Object.values(planIndex)[0]?.[kind]; // a finished document, from the first sample subject
    const message = el('p', { class: 'tpl-msg', role: 'status' });
    const input = el('input', { type: 'file', accept: '.docx', hidden: true, 'aria-label': `Upload ${label} template`, id: `tpl-file-${kind}`,
      onchange: (e) => { if (e.target.files[0]) uploadTemplate(kind, e.target.files[0], message); e.target.value = ''; } });
    return el('article', { class: 'tpl-card' },
      el('h3', { text: label }),
      el('p', { class: 'tpl-meta', text: 'Word template' }),
      el('p', { class: 'tpl-version' }, custom ? el('strong', { text: 'Your template: ' }) : el('strong', { text: 'E-Logic default' }), custom ? custom.name : ''),
      (custom ? custom.warnings : []).map((text) => el('p', { class: 'tpl-msg is-warning', text })),
      message,
      el('div', { class: 'tpl-actions' },
        el('button', { class: 'btn btn-outline btn-sm', type: 'button', text: 'Preview', onclick: () => previewTemplate(kind, label) }),
        el('a', { class: 'btn btn-outline btn-sm', href: `${PLAN_DIR}templates/${PLAN_BLANKS[kind]}`, download: true, text: 'Download blank' }),
        sample ? el('a', { class: 'btn btn-outline btn-sm', href: PLAN_DIR + sample, download: true, text: 'Download sample' }) : null,
        custom ? el('button', { class: 'btn btn-outline btn-sm', type: 'button', text: 'Download yours', onclick: () => saveBlob(custom.blob, custom.name) }) : null,
        el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: 'Upload new', onclick: () => input.click() }),
        custom ? el('button', { class: 'btn-link', type: 'button', text: 'Restore default', onclick: () => restoreTemplate(kind) }) : null),
      input);
  }), ...[marksCard()].filter(Boolean));
}

async function renderPlanner() {
  $('plan-tab-generate').addEventListener('click', () => { location.hash = 'planner'; });
  for (const name of PLAN_TABS.slice(1)) $(`plan-tab-${name}`).addEventListener('click', () => { location.hash = `planner/${name}`; });
  $('tpl-preview-close').addEventListener('click', () => { $('tpl-preview').hidden = true; });
  await loadCustomTemplates();
  try {
    planIndex = await (await fetch(`${PLAN_DIR}index.json`)).json();
  } catch (e) {
    renderTemplates();
    $('plan-note').textContent = 'The course documents couldn’t be loaded.';
    $('plan-generate').disabled = true;
    return;
  }
  await loadSavedMarks();
  await loadSavedOutlines();
  await loadSavedReferences();
  renderTemplates();
  const rows = planSubjects();
  $('plan-program').append(el('option', { text: 'BBA' }));
  $('plan-sem').append(el('option', { value: '', text: 'All semesters' }),
    ...[...new Set(data.curriculum.map((c) => c.Semester))].map((s) => el('option', { value: s, text: `Semester ${s}`, disabled: !rows.some((c) => c.Semester === s) })));
  fillPlanSubjects();
  $('plan-note').textContent = `${plural(rows.length, 'sample subject')} available so far, with more to come, and the rest are greyed out. `
    + `All documents are drafts for faculty review. AoL Reports and marks sheets show sample results from the ${SAMPLE_YEAR} offering, highlighted in yellow, until this term’s marks are uploaded on the Marks & results tab, where faculty also rewrite the draft in the last table of each report.`;
  $('plan-sem').addEventListener('change', () => { fillPlanSubjects(); clearPlanResults(); });
  $('plan-subject').addEventListener('change', clearPlanResults);
  for (const [kind] of PLAN_OUTPUTS) $(`plan-${kind}`).addEventListener('change', clearPlanResults);
  clearPlanResults();
  $('plan-generate').addEventListener('click', generatePlan);
  $('plan-zip').addEventListener('click', downloadPlanZip);
  if (location.hash.startsWith('#planner')) showPlanTab(location.hash.split('/')[1]);
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
  renderYear4();
  renderScheduling();
  renderFaculty();
  renderStudents();
  renderPlanner();
  renderStarters();
  switchSource(session.get('elogic.source') === 'mine' ? 'mine' : 'elogic');
  addEventListener('hashchange', route);
  route();
}

start();
