// Faculty allocation: which professor teaches each section, as a mixed-integer programme solved by HiGHS.
// Pure functions with no page access, so the same code runs in the browser and in tests.
//
// Decision: x[s][p] = 1 when professor p teaches section s.
// Objective (minimised, each term switchable with its own weight):
//   under  hours a professor is below their band's minimum
//   over   hours a professor is above their band's maximum
//   peak   the largest single gap from a band, for fairness
//   change sections moved away from their current professor
//   cross  sections taught outside the professor's own area
//   split  extra professors teaching the same subject in the same term
// Constraints: one professor per section; sections per professor per term between a minimum and maximum;
// area eligibility (own area, plus listed "also teaches" areas); locks; bars; availability; optional hard cap.

export const OBJECTIVE_TERMS = [
  { key: 'under', label: 'Hours below a professor’s minimum', unit: 'per hour', weight: 1, on: true },
  { key: 'over', label: 'Hours above a professor’s maximum', unit: 'per hour', weight: 1, on: true },
  { key: 'peak', label: 'Largest gap for any one professor (spreads overload fairly)', unit: 'per hour', weight: 5, on: true },
  { key: 'change', label: 'Sections moved from their current professor', unit: 'per section', weight: 10, on: true },
  { key: 'cross', label: 'Sections taught outside the professor’s own area', unit: 'per section', weight: 15, on: true },
  { key: 'split', label: 'Extra professors on the same subject in a term', unit: 'per professor', weight: 5, on: true },
];

export const DEFAULT_CONSTRAINTS = {
  basis: 'annual', // 'annual': bands cover the year; 'term': each term gets half the band
  minSections: 0, // per professor per term, unless the professor's own limit says otherwise
  maxSections: 3,
  areaRule: true, // professors teach only in their own area...
  exceptions: true, // ...or in the areas listed as "also teaches"
  hardCap: false, // never above the maximum by more than capHours
  capHours: 30,
  locks: true,
  bars: true,
  availability: true,
};

export const defaultObjective = () => Object.fromEntries(OBJECTIVE_TERMS.map((t) => [t.key, { on: t.on, weight: t.weight }]));

const round = (n) => Math.round(n * 100) / 100;

/** Each professor's band in force: their own minimum and maximum if set, otherwise their band's. */
export function limitsOf(prof, bands) {
  const band = bands.find((b) => b.band === prof.band) || { min: 0, max: Infinity };
  const num = (v, fallback) => (v === '' || v == null || Number.isNaN(Number(v)) ? fallback : Number(v));
  return { min: num(prof.minHours, band.min), max: num(prof.maxHours, band.max) };
}

export const termsOf = (sections) => [...new Set(sections.map((s) => s.term))];

/** Who may teach a section under the current constraints, before locks. */
export function eligible(section, prof, c) {
  if (c.availability && prof.available === false) return false;
  if (c.bars && (section.barred || []).includes(prof.id)) return false;
  if (!c.areaRule) return true;
  if (prof.area === section.area) return true;
  return c.exceptions && (prof.alsoTeaches || []).includes(section.area);
}

const lockOf = (section, c) => (c.locks && section.locked ? section.locked : '');

/** The periods a band is checked over: the whole year, or each term with half the band. */
function periods(sections, c) {
  return c.basis === 'term' ? termsOf(sections).map((t) => ({ key: t, share: 0.5, has: (s) => s.term === t })) : [{ key: 'Year', share: 1, has: () => true }];
}

/** Scores any allocation (a faculty ID per section) on every objective term, and lists the rules it breaks. */
export function evaluate(input, assignment, c = DEFAULT_CONSTRAINTS, objective = defaultObjective()) {
  const { sections, faculty, bands } = input;
  const per = periods(sections, c);
  const terms = termsOf(sections);
  const byId = new Map(faculty.map((p) => [p.id, p]));
  const rows = faculty.map((p) => {
    const { min, max } = limitsOf(p, bands);
    const mine = sections.filter((s, i) => assignment[i] === p.id);
    const gaps = per.map((period) => {
      const hours = mine.filter(period.has).reduce((n, s) => n + s.hours, 0);
      const lo = min * period.share;
      const hi = max * period.share;
      const off = c.availability && p.available === false;
      return { period: period.key, hours, min: lo, max: hi, under: off ? 0 : Math.max(0, lo - hours), over: Math.max(0, hours - hi) };
    });
    return {
      id: p.id, name: p.name, area: p.area, band: p.band, min, max, available: p.available !== false,
      sections: mine.length, hours: mine.reduce((n, s) => n + s.hours, 0),
      byTerm: Object.fromEntries(terms.map((t) => [t, mine.filter((s) => s.term === t).length])),
      under: round(gaps.reduce((n, g) => n + g.under, 0)), over: round(gaps.reduce((n, g) => n + g.over, 0)),
      peak: Math.max(0, ...gaps.map((g) => Math.max(g.under, g.over))), gaps,
    };
  });
  const groups = new Map();
  sections.forEach((s, i) => {
    const key = `${s.code}|${s.term}`;
    if (!groups.has(key)) groups.set(key, new Set());
    if (assignment[i]) groups.get(key).add(assignment[i]);
  });
  const metrics = {
    under: round(rows.reduce((n, r) => n + r.under, 0)),
    over: round(rows.reduce((n, r) => n + r.over, 0)),
    peak: Math.max(0, ...rows.map((r) => r.peak)),
    change: sections.filter((s, i) => assignment[i] && s.current && assignment[i] !== s.current).length,
    cross: sections.filter((s, i) => byId.get(assignment[i]) && byId.get(assignment[i]).area !== s.area).length,
    split: [...groups.values()].reduce((n, set) => n + Math.max(0, set.size - 1), 0),
  };
  metrics.objective = round(OBJECTIVE_TERMS.reduce((n, t) => n + (objective[t.key]?.on ? objective[t.key].weight * metrics[t.key] : 0), 0));
  // Rules this allocation breaks under the current constraints.
  const breaks = [];
  sections.forEach((s, i) => {
    const p = byId.get(assignment[i]);
    if (!p) { breaks.push(`${s.label}: no professor`); return; }
    if (lockOf(s, c) && lockOf(s, c) !== p.id) breaks.push(`${s.label}: locked to ${s.locked}`);
    else if (!lockOf(s, c) && !eligible(s, p, c)) breaks.push(`${s.label}: ${p.id} is not eligible`);
  });
  for (const r of rows) {
    const p = byId.get(r.id);
    for (const t of terms) {
      const { lo, hi } = sectionLimits(p, c);
      if (r.byTerm[t] > hi) breaks.push(`${r.id}: ${r.byTerm[t]} sections in ${t}, above ${hi}`);
      if (r.available && r.byTerm[t] < lo) breaks.push(`${r.id}: ${r.byTerm[t]} sections in ${t}, below ${lo}`);
    }
    if (c.hardCap) for (const g of r.gaps) if (g.hours > g.max + Number(c.capHours)) breaks.push(`${r.id}: ${g.hours} hours, above the cap of ${g.max + Number(c.capHours)}`);
  }
  return { metrics, rows, breaks };
}

function sectionLimits(p, c) {
  const num = (v, fallback) => (v === '' || v == null || Number.isNaN(Number(v)) ? fallback : Number(v));
  return { lo: num(p.minSections, Number(c.minSections)), hi: num(p.maxSections, Number(c.maxSections)) };
}

/** Problems that make a solve impossible, found before solving so the message can name the cause. */
export function diagnose(input, c) {
  const { sections, faculty, bands } = input;
  const errors = [];
  const warnings = [];
  const byId = new Map(faculty.map((p) => [p.id, p]));
  const pool = sections.map((s) => {
    const lock = lockOf(s, c);
    if (lock) {
      const p = byId.get(lock);
      if (!p) errors.push(`${s.label} is locked to ${lock}, who isn’t in the faculty list.`);
      else if (c.availability && p.available === false) warnings.push(`${s.label} is locked to ${p.id}, who is marked unavailable; the lock wins.`);
      else if (!eligible(s, p, c)) warnings.push(`${s.label} is locked to ${p.id} outside the eligibility rules; the lock wins.`);
      return p ? [p] : [];
    }
    const who = faculty.filter((p) => eligible(s, p, c));
    if (!who.length) errors.push(`${s.label} (${s.area}) has no eligible professor.`);
    return who;
  });
  for (const t of termsOf(sections)) {
    const areas = [...new Set(sections.filter((s) => s.term === t).map((s) => s.area))];
    for (const a of areas) {
      const idx = sections.map((s, i) => i).filter((i) => sections[i].term === t && sections[i].area === a);
      const profs = new Set(idx.flatMap((i) => pool[i].map((p) => p.id)));
      const room = [...profs].reduce((n, id) => n + sectionLimits(byId.get(id), c).hi, 0);
      if (idx.length > room) errors.push(`${t}: ${a} has ${idx.length} sections, but its eligible professors can take at most ${room}. Raise the section limit, add “also teaches” areas, or relax the area rule.`);
    }
    for (const p of faculty) {
      const locked = sections.filter((s) => s.term === t && lockOf(s, c) === p.id).length;
      const { hi } = sectionLimits(p, c);
      if (locked > hi) errors.push(`${p.id} has ${locked} sections locked in ${t}, above their limit of ${hi}.`);
    }
    const need = faculty.filter((p) => !(c.availability && p.available === false)).reduce((n, p) => n + sectionLimits(p, c).lo, 0);
    const have = sections.filter((s) => s.term === t).length;
    if (need > have) errors.push(`${t}: the minimum sections per professor add up to ${need}, but only ${have} sections run.`);
  }
  const demand = sections.reduce((n, s) => n + s.hours, 0);
  const capacity = faculty.filter((p) => !(c.availability && p.available === false)).reduce((n, p) => n + limitsOf(p, bands).max, 0);
  const capped = capacity + (c.hardCap ? faculty.filter((p) => !(c.availability && p.available === false)).length * Number(c.capHours) * periods(sections, c).length : 0);
  if (c.hardCap && demand > capped) errors.push(`Teaching needs ${demand.toLocaleString('en-IN')} hours, but with the hard cap no one can go above their maximum by more than ${c.capHours} hours, which allows only ${capped.toLocaleString('en-IN')}. Raise the cap, or switch it off.`);
  else if (demand > capacity) warnings.push(`Teaching needs ${demand.toLocaleString('en-IN')} hours, but the bands allow at most ${capacity.toLocaleString('en-IN')}, so at least ${(demand - capacity).toLocaleString('en-IN')} hours of overload can’t be avoided.`);
  return { errors, warnings, demand, capacity };
}

/** Writes the model in CPLEX LP format for HiGHS, with the variables it uses. */
export function buildModel(input, c = DEFAULT_CONSTRAINTS, objective = defaultObjective()) {
  const { sections, faculty, bands } = input;
  const w = (key) => (objective[key]?.on ? Number(objective[key].weight) || 0 : 0);
  const per = periods(sections, c);
  const x = []; // { name, s, p }
  const xs = sections.map(() => []);
  const xp = faculty.map(() => []);
  sections.forEach((s, si) => {
    const lock = lockOf(s, c);
    faculty.forEach((p, pi) => {
      if (lock ? lock !== p.id : !eligible(s, p, c)) return;
      const v = { name: `x${si}_${pi}`, s: si, p: pi };
      x.push(v);
      xs[si].push(v);
      xp[pi].push(v);
    });
  });
  const obj = [];
  const rows = [];
  const bounds = [];
  const add = (coef, name) => { if (coef) obj.push(`${coef >= 0 ? '+' : '-'} ${Math.abs(coef)} ${name}`); };
  for (const v of x) {
    const s = sections[v.s];
    const p = faculty[v.p];
    add((s.current && s.current !== p.id ? w('change') : 0) + (p.area !== s.area ? w('cross') : 0), v.name);
  }
  const sum = (terms) => terms.join(' ') || '0 z';
  // C1: one professor per section.
  xs.forEach((vars, si) => rows.push(`sec${si}: ${sum(vars.map((v) => `+ ${v.name}`))} = 1`));
  // Hours against the band, per period, with gap variables; C8: optional hard cap.
  faculty.forEach((p, pi) => {
    const { min, max } = limitsOf(p, bands);
    const off = c.availability && p.available === false;
    per.forEach((period, ti) => {
      const vars = xp[pi].filter((v) => period.has(sections[v.s]));
      const hours = vars.map((v) => `+ ${sections[v.s].hours} ${v.name}`);
      const u = `u${pi}_${ti}`;
      const o = `o${pi}_${ti}`;
      if (!off && min > 0) {
        rows.push(`lo${pi}_${ti}: ${sum([...hours, `+ ${u}`])} >= ${round(min * period.share)}`);
        add(w('under'), u);
        if (w('peak')) rows.push(`pu${pi}_${ti}: + z - ${u} >= 0`);
      }
      if (Number.isFinite(max) && vars.length) {
        rows.push(`hi${pi}_${ti}: ${sum([...hours, `- ${o}`])} <= ${round(max * period.share)}`);
        add(w('over'), o);
        if (w('peak')) rows.push(`po${pi}_${ti}: + z - ${o} >= 0`);
        if (c.hardCap) rows.push(`cap${pi}_${ti}: ${sum(hours)} <= ${round(max * period.share + Number(c.capHours))}`);
      }
    });
    // C2: sections per term.
    const { lo, hi } = sectionLimits(p, c);
    for (const [ti, t] of termsOf(sections).entries()) {
      const vars = xp[pi].filter((v) => sections[v.s].term === t);
      if (!vars.length) continue;
      rows.push(`n${pi}_${ti}: ${sum(vars.map((v) => `+ ${v.name}`))} <= ${hi}`);
      if (lo > 0 && !off) rows.push(`m${pi}_${ti}: ${sum(vars.map((v) => `+ ${v.name}`))} >= ${lo}`);
    }
  });
  add(w('peak'), 'z');
  // Split: y[g][p] is 1 when professor p teaches any section of subject group g.
  const y = [];
  if (w('split')) {
    const groups = new Map();
    sections.forEach((s, si) => {
      const key = `${s.code}|${s.term}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(si);
    });
    [...groups.values()].forEach((members, gi) => {
      if (members.length < 2) return;
      faculty.forEach((p, pi) => {
        const vars = members.flatMap((si) => xs[si].filter((v) => v.p === pi));
        if (!vars.length) return;
        const name = `y${gi}_${pi}`;
        y.push(name);
        add(w('split'), name);
        vars.forEach((v, k) => rows.push(`g${gi}_${pi}_${k}: + ${name} - ${v.name} >= 0`));
        bounds.push(`0 <= ${name} <= 1`);
      });
    });
  }
  const wrap = (terms, lead = ' ') => terms.reduce((lines, t) => {
    if (lines[lines.length - 1].length > 200) lines.push('   '); // continuation lines carry no label
    lines[lines.length - 1] += ` ${t}`;
    return lines;
  }, [lead]).join('\n');
  const lp = [
    'Minimize',
    wrap(obj.length ? obj : ['0 z'], ' obj:'),
    'Subject To',
    ...rows.map((r) => {
      const [head, rest] = [r.slice(0, r.indexOf(':') + 1), r.slice(r.indexOf(':') + 1)];
      const parts = rest.trim().split(/ (?=[+-] )/);
      return wrap(parts, ` ${head}`);
    }),
    'Bounds',
    ' z >= 0',
    ...bounds.map((b) => ` ${b}`),
    'Binary',
    wrap(x.map((v) => v.name)),
    'End',
  ].join('\n');
  return { lp, x, size: { binaries: x.length, continuous: y.length + faculty.length * per.length * 2 + 1, constraints: rows.length } };
}

// A small seeded random number generator, so the same inputs always give the same allocation.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Finds the allocation with the lowest objective that keeps every hard rule. It starts from the current
 * allocation, repairs any rule it breaks, then improves it by simulated annealing (moving one section, or
 * swapping two sections of the same term between professors) and a final pass that keeps only improvements.
 * The search is seeded, so it is repeatable. It finds a very good allocation but does not prove it is the best;
 * buildModel() writes the same problem for an exact solver.
 */
export function search(input, c = DEFAULT_CONSTRAINTS, objective = defaultObjective(), { iterations = 150000, restarts = 4, seed = 2026 } = {}) {
  const started = Date.now();
  const check = diagnose(input, c);
  if (check.errors.length) return { status: 'Infeasible', check };
  const { sections, faculty, bands } = input;
  const S = sections.length;
  const P = faculty.length;
  const per = periods(sections, c);
  const K = per.length;
  const terms = termsOf(sections);
  const T = terms.length;
  const w = Object.fromEntries(OBJECTIVE_TERMS.map((t) => [t.key, objective[t.key]?.on ? Number(objective[t.key].weight) || 0 : 0]));
  const idOf = new Map(faculty.map((p, i) => [p.id, i]));
  const termOf = sections.map((s) => terms.indexOf(s.term));
  const periodOf = sections.map((s) => per.findIndex((k) => k.has(s)));
  const groupKeys = [...new Set(sections.map((s) => `${s.code}|${s.term}`))];
  const groupOf = sections.map((s) => groupKeys.indexOf(`${s.code}|${s.term}`));
  const lim = faculty.map((p) => ({ ...limitsOf(p, bands), ...sectionLimits(p, c), off: c.availability && p.available === false }));
  const options = sections.map((s) => {
    const lock = lockOf(s, c);
    return lock ? [idOf.get(lock)] : faculty.map((p, i) => (eligible(s, p, c) ? i : -1)).filter((i) => i >= 0);
  });
  const sectionCost = (s, p) => (sections[s].current && sections[s].current !== faculty[p].id ? w.change : 0) + (faculty[p].area !== sections[s].area ? w.cross : 0);
  const CAP_PENALTY = 1000; // per hour above the hard cap: the search treats it as a wall, and the result is checked after
  const capExcess = (p, k) => (c.hardCap ? Math.max(0, H[p * K + k] - lim[p].max * per[k].share - Number(c.capHours)) : 0);

  // State: who teaches each section, hours per professor per period, sections per professor per term,
  // and professors per subject group.
  const a = new Int32Array(S);
  const H = new Float64Array(P * K);
  const N = new Int32Array(P * T);
  const G = new Int32Array(groupKeys.length * P);
  const D = new Int32Array(groupKeys.length);
  let base = 0;
  const place = (s, p, sign) => {
    a[s] = sign > 0 ? p : a[s];
    H[p * K + periodOf[s]] += sign * sections[s].hours;
    N[p * T + termOf[s]] += sign;
    const g = groupOf[s] * P + p;
    if (sign > 0 && G[g]++ === 0) D[groupOf[s]] += 1;
    if (sign < 0 && --G[g] === 0) D[groupOf[s]] -= 1;
    base += sign * sectionCost(s, p);
  };
  const gap = (p, k) => {
    const h = H[p * K + k];
    const share = per[k].share;
    return [lim[p].off ? 0 : Math.max(0, lim[p].min * share - h), Math.max(0, h - lim[p].max * share)];
  };
  const cost = () => {
    let under = 0;
    let over = 0;
    let peak = 0;
    let excess = 0;
    for (let p = 0; p < P; p += 1) {
      for (let k = 0; k < K; k += 1) {
        const [u, o] = gap(p, k);
        under += u;
        over += o;
        if (u > peak) peak = u;
        if (o > peak) peak = o;
        excess += capExcess(p, k);
      }
    }
    let split = 0;
    for (let g = 0; g < D.length; g += 1) split += Math.max(0, D[g] - 1);
    return w.under * under + w.over * over + w.peak * peak + w.split * split + base + CAP_PENALTY * excess;
  };

  // Start from the current allocation where it keeps the rules; place the rest on the least-loaded eligible professor.
  const load = (p) => H.slice(p * K, p * K + K).reduce((n, h) => n + h, 0) / Math.max(1, lim[p].max);
  const room = (p, t) => N[p * T + t] < lim[p].hi;
  const pending = [];
  sections.forEach((s, i) => {
    const cur = idOf.get(s.current);
    if (cur !== undefined && options[i].includes(cur) && room(cur, termOf[i])) place(i, cur, 1);
    else pending.push(i);
  });
  for (const i of pending) {
    const best = options[i].filter((p) => room(p, termOf[i])).sort((x, y) => load(x) - load(y))[0];
    if (best === undefined) return { status: 'Infeasible', check: { ...check, errors: [`${sections[i].label} can’t be placed: every eligible professor is at their section limit.`] } };
    place(i, best, 1);
  }
  // Lift anyone below their minimum sections by taking a section from a colleague who can spare one.
  for (let p = 0; p < P; p += 1) {
    if (lim[p].off) continue;
    for (let t = 0; t < T; t += 1) {
      while (N[p * T + t] < lim[p].lo) {
        const s = sections.findIndex((x, i) => termOf[i] === t && a[i] !== p && options[i].includes(p) && N[a[i] * T + t] > lim[a[i]].lo);
        if (s < 0) return { status: 'Infeasible', check: { ...check, errors: [`${faculty[p].id} can’t reach ${lim[p].lo} sections in ${terms[t]}.`] } };
        place(s, a[s], -1);
        place(s, p, 1);
      }
    }
  }

  const movable = [...Array(S).keys()].filter((s) => options[s].length > 1);
  const byTerm = terms.map((_, t) => movable.filter((s) => termOf[s] === t));
  const tryMove = (s, q, accept) => {
    const p = a[s];
    const t = termOf[s];
    if (q === p || !room(q, t) || N[p * T + t] <= lim[p].lo) return null;
    const before = cost();
    place(s, p, -1);
    place(s, q, 1);
    const delta = cost() - before;
    if (accept(delta)) return delta;
    place(s, q, -1);
    place(s, p, 1);
    return null;
  };
  const trySwap = (s, r, accept) => {
    const p = a[s];
    const q = a[r];
    if (p === q || !options[s].includes(q) || !options[r].includes(p)) return null;
    const before = cost();
    place(s, p, -1); place(r, q, -1); place(s, q, 1); place(r, p, 1);
    const delta = cost() - before;
    if (accept(delta)) return delta;
    place(s, q, -1); place(r, p, -1); place(s, p, 1); place(r, q, 1);
    return null;
  };
  const start = Int32Array.from(a);
  let best = { cost: cost(), a: Int32Array.from(a) };
  for (let run = 0; run < restarts && movable.length; run += 1) {
    // Each run starts from the repaired allocation.
    for (let s = 0; s < S; s += 1) if (a[s] !== start[s]) { place(s, a[s], -1); place(s, start[s], 1); }
    const rand = rng(seed + run * 7919);
    let temp = 40;
    const cool = Math.pow(0.05 / temp, 1 / iterations);
    for (let it = 0; it < iterations; it += 1, temp *= cool) {
      const accept = (d) => d <= 0 || rand() < Math.exp(-d / temp);
      const s = movable[Math.floor(rand() * movable.length)];
      if (rand() < 0.5) {
        const opts = options[s];
        tryMove(s, opts[Math.floor(rand() * opts.length)], accept);
      } else {
        const pool = byTerm[termOf[s]];
        trySwap(s, pool[Math.floor(rand() * pool.length)], accept);
      }
      if (it % 500 === 0) {
        const now = cost();
        if (now < best.cost - 1e-9) best = { cost: now, a: Int32Array.from(a) };
      }
    }
    const now = cost();
    if (now < best.cost - 1e-9) best = { cost: now, a: Int32Array.from(a) };
  }
  // Polish the best allocation: keep making any single move or swap that lowers the objective.
  for (let s = 0; s < S; s += 1) if (a[s] !== best.a[s]) { place(s, a[s], -1); place(s, best.a[s], 1); }
  const better = (d) => d < -1e-9;
  for (let pass = 0, improved = true; improved && pass < 50; pass += 1) {
    improved = false;
    for (const s of movable) {
      for (const q of options[s]) if (tryMove(s, q, better) !== null) improved = true;
      for (const r of byTerm[termOf[s]]) if (r !== s && trySwap(s, r, better) !== null) improved = true;
    }
  }
  const assignment = [...a].map((p) => faculty[p].id);
  const capped = c.hardCap ? faculty.flatMap((f, p) => per.map((k, ki) => (capExcess(p, ki) > 0 ? `${f.id} would need ${H[p * K + ki]} hours${K > 1 ? ` in ${k.key}` : ''}, above the cap of ${lim[p].max * k.share + Number(c.capHours)}.` : '')).filter(Boolean)) : [];
  if (capped.length) return { status: 'Infeasible', check: { ...check, errors: ['No allocation keeps everyone under the hard cap. Raise the cap, or switch it off.', ...capped] } };
  return { status: 'Solved', check, assignment, seconds: (Date.now() - started) / 1000, iterations: iterations * restarts,
    evaluation: evaluate(input, assignment, c, objective) };
}
