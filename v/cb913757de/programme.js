// Constructor programme (no DOM): departments, personnel, the car in the works, money and credit.
// Spec: docs/TEAM_PROGRAMME.md. Shared by Real Seasons and (later) the Career.
//
// Units
// - Department ratings, depth, facilities, know-how, outputs: 0-100.
// - Car index: 50 = the season's median car, 75 = a typical season's best car (fieldOf maps it to sim pace).
// - Money: budget points, 100 = the top team's budget in that era. The UI shows period money (money.js).
//
// State P (plain JSON, saved inside the mode's save):
//   { v, seed, rep, cash, credit, cleanSeasons, backing, engine, depts[6], next, profile, searches[], offers{},
//     car (this season's car), ledger[], log[], ids }
import { seedOf } from "./career.js";

export const DEPTS = [
  { key: "design", name: "Design office", head: "Technical Director", sim: "spread, carry-over" },
  { key: "aero", name: "Aerodynamics", head: "Chief aerodynamicist", sim: "pace (agility)" },
  { key: "engine", name: "Engine", head: "Chief engine designer", sim: "pace (power), failures" },
  { key: "chassis", name: "Chassis & dynamics", head: "Chief designer", sim: "pace, tyre wear" },
  { key: "production", name: "Production & reliability", head: "Production manager", sim: "failures, upgrades" },
  { key: "ops", name: "Race operations", head: "Sporting director", sim: "pit stops, strategy" },
];
export const DK = DEPTS.map((d) => d.key);
const D = Object.fromEntries(DK.map((k, i) => [k, i]));
// department weights by era (sum 1)
export const ERA_W = [
  [1900, [0.15, 0.03, 0.42, 0.2, 0.15, 0.05]], [1934, [0.15, 0.05, 0.4, 0.22, 0.13, 0.05]],
  [1961, [0.18, 0.08, 0.32, 0.25, 0.12, 0.05]], [1968, [0.18, 0.22, 0.22, 0.22, 0.1, 0.06]],
  [1977, [0.2, 0.32, 0.18, 0.15, 0.09, 0.06]], [1983, [0.17, 0.22, 0.35, 0.13, 0.08, 0.05]],
  [1989, [0.18, 0.3, 0.22, 0.15, 0.08, 0.07]], [1994, [0.18, 0.32, 0.2, 0.12, 0.07, 0.11]],
  [2009, [0.18, 0.4, 0.12, 0.15, 0.07, 0.08]], [2014, [0.17, 0.3, 0.33, 0.1, 0.05, 0.05]],
  [2022, [0.18, 0.36, 0.2, 0.14, 0.05, 0.07]]];
export const eraW = (y) => { let w = ERA_W[0][1]; for (const [y0, v] of ERA_W) if (y >= y0) w = v; return w; };
// rule changes: year -> share of accumulated know-how that stops applying
export const REGS = { 1914: 0.5, 1921: 0.6, 1922: 0.4, 1926: 0.5, 1928: 0.3, 1934: 0.8, 1938: 0.6, 1950: 0.5, 1952: 0.5,
  1954: 0.7, 1961: 0.8, 1966: 0.7, 1968: 0.3, 1977: 0.4, 1983: 0.5, 1987: 0.2, 1989: 0.6, 1994: 0.3, 1995: 0.4, 1998: 0.5,
  2006: 0.3, 2009: 0.7, 2014: 0.8, 2017: 0.4, 2022: 0.7, 2026: 0.8 };
export const regAt = (y, K = KNOBS) => (REGS[y] ?? 0) * K.reset;
// difficulty knobs (the design lab's sliders)
// luck, edge: title chance = Phi((margin - edge) / luck), fitted to full race sims (game/tools/programme_sim_check.mjs)
export const KNOBS = { reset: 1, poach: 4, converge: 0.9, luck: 7.5, edge: -0.9, stretch: 2.2, sponsor: 0.5, cap: 2021 };   // tuned: programme_balance.mjs

export const PRESETS = {
  privateer: { rep: 12, staff: 38, spread: 7, fac: 10, know: 10, backing: "none", engine: "customer", tier: 2, debt: 0 },
  midfield: { rep: 45, staff: 50, spread: 8, fac: 40, know: 35, backing: "none", engine: "customer", tier: 1, debt: 0 },
  bigname: { rep: 80, staff: 66, spread: 8, fac: 70, know: 60, backing: "partial", engine: "build", tier: 0, debt: 0 },
};
export const BACKING = { none: 0, partial: 15, works: 30 };          // points a season from a manufacturer
export const CREDIT = ["A", "B", "C", "D", "E"];
export const CREDIT_NAME = ["Sound", "Stable", "Stretched", "Distressed", "In default"];
const SPREAD_PTS = [0, 2, 5, 9, 15];                                   // interest spread by rating (% a season)
const BASE_RATE = 4;
const SEARCH = { small: { cost: 1.5, n: 1, sd: 15 }, medium: { cost: 3, n: 2, sd: 10 }, big: { cost: 6, n: 3, sd: 6 } };
export const SEARCH_SIZES = Object.keys(SEARCH);
export const searchCost = (size, urgent = false) => SEARCH[size].cost * (urgent ? 2 : 1);
const TRAVEL_PER_ROUND = 0.25;
const ENGINE_FEE = [14, 9, 5];                                         // customer engine, by supplier tier (0 = best)
const ENGINE_OUT = [72, 60, 48];                                       // customer engine output by tier
const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));
const r1 = (x) => Math.round(x * 10) / 10, r2 = (x) => Math.round(x * 100) / 100;

function rng(...xs) {
  let a = seedOf(...xs);
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (R) => Math.sqrt(-2 * Math.log(R() + 1e-12)) * Math.cos(2 * Math.PI * R());

// ---------- people ----------
const FIRST = { gb: ["John", "Peter", "David", "Tony", "Neil", "Robin", "Gordon", "Alan", "Brian", "Geoff", "Mike", "Steve", "Simon", "James", "Ian"],
  it: ["Giulio", "Carlo", "Franco", "Luigi", "Giorgio", "Mario", "Enzo", "Paolo", "Sergio", "Aldo", "Marco", "Stefano"],
  fr: ["Jean", "Pierre", "Michel", "Bernard", "André", "Gérard", "Henri", "Jacques", "Philippe", "Claude"],
  de: ["Hans", "Karl", "Fritz", "Rudolf", "Wolfgang", "Dieter", "Helmut", "Jürgen", "Klaus", "Werner"],
  us: ["Bill", "Bob", "Jim", "Dan", "Chuck", "Ed", "Frank", "Gary", "Larry"], jp: ["Hiroshi", "Takeshi", "Yoshio", "Kenji", "Masao", "Shoichi"],
  at: ["Franz", "Josef", "Erich", "Gerhard"], br: ["Ricardo", "José", "Paulo", "Rubens"], nl: ["Jan", "Pieter", "Hendrik"] };
const LAST = { gb: ["Hughes", "Clarke", "Turner", "Walsh", "Baxter", "Pearce", "Hayes", "Dennis", "Lowe", "Simmons", "Ashby", "Hale", "Moss", "Prentice", "Gray"],
  it: ["Rossi", "Bianchi", "Colombo", "Ferri", "Galli", "Marchetti", "Fontana", "Rinaldi", "Bellini", "Mancini", "Moretti"],
  fr: ["Dubois", "Lambert", "Martin", "Moreau", "Girard", "Fontaine", "Rousseau", "Leclerc", "Garnier"],
  de: ["Becker", "Schröder", "Hoffmann", "Wagner", "Krause", "Vogel", "Neumann", "Brandt", "Keller"],
  us: ["Miller", "Parker", "Stone", "Hunt", "Reed", "Wallace", "Brooks"], jp: ["Tanaka", "Suzuki", "Watanabe", "Kobayashi", "Ito"],
  at: ["Huber", "Gruber", "Steiner"], br: ["Silva", "Costa", "Pereira"], nl: ["de Vries", "Jansen", "Bakker"] };
// nationalities a search draws from, by era (more British after 1958, more global later)
const natPool = (y) => y < 1950 ? ["it", "it", "fr", "fr", "de", "de", "gb", "us"] : y < 1958 ? ["it", "it", "gb", "gb", "de", "fr"]
  : y < 1990 ? ["gb", "gb", "gb", "it", "fr", "de", "us", "at"] : ["gb", "gb", "it", "de", "fr", "jp", "nl", "br", "at"];
// real legends who turn up in searches in their active years (rating, lean: -1 agility .. +1 power)
export const LEGENDS = [
  { name: "Vittorio Jano", dept: "design", from: 1923, to: 1955, rating: 92, lean: 0.3, nat: "it" },
  { name: "Ferdinand Porsche", dept: "design", from: 1923, to: 1938, rating: 93, lean: 0.6, nat: "at" },
  { name: "Rudolf Uhlenhaut", dept: "chassis", from: 1936, to: 1955, rating: 92, lean: 0, nat: "de" },
  { name: "Gioacchino Colombo", dept: "engine", from: 1937, to: 1957, rating: 88, lean: 0.5, nat: "it" },
  { name: "Aurelio Lampredi", dept: "engine", from: 1948, to: 1958, rating: 87, lean: 0.4, nat: "it" },
  { name: "Colin Chapman", dept: "design", from: 1958, to: 1982, rating: 95, lean: -0.6, nat: "gb" },
  { name: "Mauro Forghieri", dept: "design", from: 1962, to: 1987, rating: 91, lean: 0.4, nat: "it" },
  { name: "Keith Duckworth", dept: "engine", from: 1966, to: 1985, rating: 93, lean: 0, nat: "gb" },
  { name: "Gordon Murray", dept: "design", from: 1973, to: 1991, rating: 91, lean: -0.3, nat: "gb" },
  { name: "Patrick Head", dept: "chassis", from: 1977, to: 2004, rating: 89, lean: 0, nat: "gb" },
  { name: "John Barnard", dept: "design", from: 1979, to: 1997, rating: 90, lean: -0.2, nat: "gb" },
  { name: "Rory Byrne", dept: "aero", from: 1981, to: 2006, rating: 92, lean: -0.2, nat: "gb" },
  { name: "Adrian Newey", dept: "aero", from: 1988, to: 2026, rating: 97, lean: -0.6, nat: "gb" },
  { name: "Ross Brawn", dept: "ops", from: 1991, to: 2013, rating: 94, lean: 0, nat: "gb" },
  { name: "Mario Illien", dept: "engine", from: 1991, to: 2005, rating: 90, lean: 0.5, nat: "ch" },
  { name: "James Allison", dept: "design", from: 2005, to: 2026, rating: 89, lean: 0, nat: "gb" },
];
export const marketSalary = (rating) => r2(0.3 + 2.6 * (rating / 100) ** 3);   // points a season

function makePerson(P, R, dept, rating, y, o = {}) {
  const nat = o.nat ?? natPool(y)[Math.floor(R() * natPool(y).length)];
  const fs = FIRST[nat] ?? FIRST.gb, ls = LAST[nat] ?? LAST.gb;
  P.ids = (P.ids ?? 0) + 1;
  return {
    id: P.ids, name: o.name ?? `${fs[Math.floor(R() * fs.length)]} ${ls[Math.floor(R() * ls.length)]}`, nat, dept,
    rating: r1(clamp(rating, 15, 99)), age: Math.round(o.age ?? 32 + 14 * R()), lean: r2(o.lean ?? (R() * 2 - 1) * 0.7),
    ambition: o.ambition ?? [0, 1, 1, 2][Math.floor(R() * 4)], salary: r2(o.salary ?? marketSalary(rating)), years: o.years ?? 3,
    seen: o.seen ?? 15, tenure: 0, ...(o.legend ? { legend: true } : {}),
  };
}
function makeMentee(P, R, dept, y) {
  const m = makePerson(P, R, dept, 28 + 14 * R(), y, { age: 23 + Math.floor(6 * R()), salary: 0.15, years: 3 });
  m.potential = r1(clamp(55 + 40 * R(), 40, 98)); m.wait = 0;
  return m;
}
// what the player sees of a rating: a range that narrows with time at the team
export const ratingRange = (p) => [Math.max(0, Math.round(p.rating - p.seen)), Math.min(100, Math.round(p.rating + p.seen))];
export function menteeHint(m) {
  const room = m.potential - m.rating;
  return room > 30 ? "quick learner" : room > 15 ? "still improving" : room > 5 ? "nearly there" : "has plateaued";
}

// ---------- new programme ----------
// cfg: preset key plus any overrides: rep, staff (mean head rating), spread, fac, know, backing (none|partial|works) or
// backingAmount, patience, engine (build|customer), tier, debt, mentees (bool)
export function newProgramme(cfg = {}, year, seed = 1) {
  const c = { ...PRESETS[cfg.preset ?? "midfield"], ...cfg };
  const R = rng(seed, "programme-new");
  const P = { v: 1, seed, rep: c.rep, cash: 0, debt: c.debt ?? 0, credit: c.credit ?? (c.debt > 40 ? 2 : c.debt > 15 ? 1 : 0),
    cleanSeasons: 0, ids: 0, ledger: [], log: [], searches: [], offers: {},
    backing: { kind: c.backing, amount: c.backingAmount ?? BACKING[c.backing] ?? 0, patience: c.patience ?? 2, bad: 0 },
    engine: { mode: c.engine, tier: c.tier ?? 1 },
    next: 0.15, profile: { pa: 0, sr: 0, qt: 0 }, car: null };
  P.depts = DEPTS.map((d) => ({
    key: d.key, budget: 0, invest: 0, fac: r1(clamp(c.fac + 6 * gauss(R))), know: r1(clamp(c.know + 6 * gauss(R))), carry: 0,
    head: makePerson(P, R, d.key, c.staff + c.spread * gauss(R), year, { seen: 10 }),
    mentee: c.mentees === false ? null : (R() < 0.5 ? makeMentee(P, R, d.key, year) : null),
  }));
  defaultBudgets(P, year);
  return P;
}
// a sensible split of this season's running money: by era weight
export function defaultBudgets(P, y, total = null) {
  const w = eraW(y), t = total ?? Math.max(0, 0.55 * expectedIncome(P, y));
  P.depts.forEach((d, k) => { d.budget = r1(t * w[k]); d.invest = r1(0.08 * t * w[k]); });
}

// ---------- money ----------
export function income(P, y, last = null) {
  const lines = [];
  const credPen = P.credit >= 3 ? 0.85 : 1;
  lines.push(["Sponsorship", r1((30 + 0.55 * P.rep) * credPen * (P.sponsor ?? KNOBS.sponsor))]);   // P.sponsor: a mode's own level (the Career)
  if (last?.prize != null) lines.push(["Prize money", r1(last.prize)]);
  if (y < 1960) lines.push(["Start money", r1(4 + 0.12 * P.rep)]);
  if (P.backing.amount) lines.push(["Works backing", r1(P.backing.amount)]);
  if (P.engine.mode === "build" && P.depts[D.engine].head.rating >= 70 && y >= 1950) lines.push(["Customer engines", r1(4 + 0.1 * (P.depts[D.engine].head.rating - 70))]);
  return lines;
}
// the forecast's prize: last season's, else a guess from reputation
export const prizeGuess = (P) => P.lastPrize ?? prizeFor(P.rep);
export const expectedIncome = (P, y) => income(P, y, { prize: prizeGuess(P) }).reduce((a, [, v]) => a + v, 0);
// prize by constructors' place (field of n): about 30 points for the champions, falling away
export const prizeFor = (rep) => r1(4 + 0.26 * rep);
export const prizeByPlace = (place, n) => r1(Math.max(1.5, 32 * Math.pow(0.78, place - 1) * (n >= 8 ? 1 : 0.8)));
export function spending(P, y, rounds = 16) {
  const lines = [];
  lines.push(["Department running budgets", r1(P.depts.reduce((a, d) => a + d.budget, 0))]);
  lines.push(["Facilities", r1(P.depts.reduce((a, d) => a + d.invest, 0))]);
  lines.push(["Head and mentee salaries", r1(P.depts.reduce((a, d) => a + d.head.salary + (d.mentee?.salary ?? 0), 0))]);
  if (P.engine.mode === "customer") lines.push(["Engine supply", ENGINE_FEE[P.engine.tier] * (P.credit >= 4 ? 1.25 : 1)]);
  lines.push(["Travel and entries", r1(TRAVEL_PER_ROUND * rounds)]);
  const searches = P.searchSpend ?? 0;
  if (searches) lines.push(["Searches", r1(searches)]);
  if (P.debt > 0) lines.push(["Interest", r1(P.debt * interestRate(P) / 100)]);
  return lines;
}
export const interestRate = (P) => BASE_RATE + SPREAD_PTS[P.credit];
// cost cap (from KNOBS.cap): running budgets + facilities + salaries other than the three best-paid
export function capRoom(P, y, K = KNOBS) {
  if (y < K.cap) return null;
  const sal = P.depts.map((d) => d.head.salary).sort((a, b) => b - a).slice(3).reduce((a, b) => a + b, 0)
    + P.depts.reduce((a, d) => a + (d.mentee?.salary ?? 0), 0);
  return r1(85 - P.depts.reduce((a, d) => a + d.budget + d.invest, 0) - sal);
}
// cut running budgets and facilities spending to fit under the cap; returns the share cut (0 = none)
export function enforceCap(P, y, K = KNOBS) {
  const room = capRoom(P, y, K); if (room == null || room >= 0) return 0;
  const tot = P.depts.reduce((a, d) => a + d.budget + d.invest, 0), k = Math.max(0, (tot + room) / tot);
  for (const d of P.depts) { d.budget = r1(d.budget * k); d.invest = r1(d.invest * k); }
  return 1 - k;
}
// covenants and penalties by credit rating
export const covenants = (P) => ({ facilities: P.credit < 2, searches: P.credit < 4, shortlistCut: P.credit >= 3 ? 1 : 0,
  askMore: P.credit >= 3 ? 1.2 : 1, leaveMult: P.credit >= 4 ? 2 : 1 });
export function borrow(P, amount) { amount = Math.max(0, amount); P.debt = r2(P.debt + amount); P.cash = r2(P.cash + amount); }
export function repay(P, amount) { amount = Math.max(0, Math.min(amount, P.cash, P.debt)); P.debt = r2(P.debt - amount); P.cash = r2(P.cash - amount); }
function rateCredit(P, inc, missed) {
  const ratio = P.debt / Math.max(10, inc);
  const target = missed ? 4 : ratio < 0.25 ? 0 : ratio < 0.6 ? 1 : ratio < 1 ? 2 : ratio < 1.6 ? 3 : 4;
  if (target > P.credit) { P.credit = target; P.cleanSeasons = 0; }               // drops at once
  else if (target < P.credit && ++P.cleanSeasons >= 2) { P.credit--; P.cleanSeasons = 0; }   // recovers a notch per two clean seasons
}

// ---------- outputs and the car ----------
// a department's expected output for a season's car, and its spread (narrowing with design progress 0..1)
export function deptOutput(P, k, y, progress = 0, K = KNOBS) {
  const d = P.depts[k], w = eraW(y)[k];
  const depth = 100 * (1 - Math.exp(-d.budget / (35 * w + 3)));
  let mu = 50 + K.stretch * (0.4 * d.head.rating + 0.2 * depth + 0.15 * d.fac + 0.25 * d.know - 50);
  if (k === D.engine && P.engine.mode === "customer") mu = ENGINE_OUT[P.engine.tier] + 0.15 * (d.head.rating - 50);   // integration only
  // leaning the car against a head's style costs that department up to 4 points
  const lean = k === D.aero ? -P.profile.pa : k === D.engine ? P.profile.pa : 0;
  if (lean < 0 && d.head.lean * lean < 0) mu -= 4 * Math.abs(lean) * Math.min(1, Math.abs(d.head.lean) + 0.3);
  mu *= 1 - 0.12 * P.next;                                     // effort moved to next year's car
  const reg = regAt(y, K), td = P.depts[D.design].head.rating;
  const sd = 9 * (1 - 0.45 * td / 100) * (1 + 2.5 * reg) * (1 - 0.75 * progress);
  return { mu, sd, depth, w };
}
// the whole car's projection (index), from the department outputs plus the speed/reliability lean
export function projection(P, y, progress = 0, K = KNOBS) {
  const ds = DK.map((_, k) => deptOutput(P, k, y, progress, K));
  const lean = 4 * Math.max(0, -P.profile.sr) - 4 * Math.max(0, P.profile.sr);
  const mu = ds.reduce((a, d) => a + d.w * d.mu, 0) + lean;
  const sd = Math.sqrt(ds.reduce((a, d) => a + (d.w * d.sd) ** 2, 0));
  return { depts: ds, mu, sd };
}
// launch: draw each department's output, fix the car index and its in-season development
export function buildCar(P, y, K = KNOBS) {
  const R = rng(P.seed, y, P.n ?? 0, "car");
  const ds = DK.map((_, k) => deptOutput(P, k, y, 0, K));
  const out = ds.map((d) => clamp(d.mu + d.sd * gauss(R)));
  const lean = 4 * Math.max(0, -P.profile.sr) - 4 * Math.max(0, P.profile.sr);
  const index = ds.reduce((a, d, k) => a + d.w * out[k], 0) + lean;
  // in-season development: packages from Production; total gain from how much effort stays on this car
  const prod = P.depts[D.production], packages = 1 + Math.floor((prod.head.rating + ds[D.production].depth) / 50);
  const q = (P.depts.reduce((a, d) => a + d.head.rating, 0) / 6 + ds.reduce((a, d) => a + d.depth, 0) / 6) / 120;
  // devBase: the gain with all effort on this car; the packages that arrive carry (1 - next) of it, next as set then
  const devBase = Math.max(0, 5 * q + 1.2 * gauss(R)), dev = devBase * (1 - P.next);
  P.car = { year: y, out: out.map(r1), index: r1(index), devBase: r2(devBase), packages, launch: r1(index - dev / 2), got: [] , nextSum: 0, rounds: 0 };
  return P.car;
}
// the car's index at a round: launch + the packages that have arrived (each worth devBase/packages x (1 - next) then)
export function indexAt(P, round, nRounds) {
  const c = P.car; if (!c) return null;
  const due = Math.min(c.packages, Math.floor((round / Math.max(1, nRounds)) * (c.packages + 1)));
  const got = c.got ?? [];
  let add = got.slice(0, due).reduce((a, v) => a + v, 0);
  for (let k = got.length; k < due; k++) add += (c.devBase ?? c.dev ?? 0) / c.packages * (1 - P.next);
  return c.launch + add;
}
// after each race: packages that arrived lock in the split as it stood; urgent searches report after four rounds
export function roundTick(P, y, round, nRounds) {
  const c = P.car, news = [];
  if (c) {
    c.got ??= [];
    const due = Math.min(c.packages, Math.floor((round / Math.max(1, nRounds)) * (c.packages + 1)));
    while (c.got.length < due) { c.got.push(r2((c.devBase ?? 0) / c.packages * (1 - P.next))); news.push(`Upgrade package ${c.got.length} of ${c.packages} arrives.`); }
    c.nextSum = (c.nextSum ?? 0) + P.next; c.rounds = (c.rounds ?? 0) + 1;
  }
  for (const q of [...P.searches]) if (q.urgent && ++q.rounds >= 4) { resolveSearch(P, q, y); news.push(`The ${DEPTS[D[q.dept]].head} search reports back.`); }
  P.log.push(...news.map((t) => ({ year: y, text: t })));
  return news;
}
// the season-average share of effort on next year's car so far (P.next before the first race)
export const nextShare = (P) => (P.car?.rounds ? P.car.nextSum / P.car.rounds : P.next);
// race operations: crew time per stop (s; negative = quicker) and the strategist's tyre read (x the usual error)
export function opsMod(P, y) {
  const ops = P.depts[D.ops].head.rating * 0.5 + P.depts[D.ops].know * 0.25 + deptOutput(P, D.ops, y).depth * 0.25;
  const k = y < 1950 ? 12 : y < 1994 ? 4 : y < 2010 ? 1.2 : 0.6;
  return { pitS: r2(-(ops - 50) / 50 * k), read: r2(Math.max(0.4, 1.3 - 0.6 * ops / 100)) };
}
// sim fields for the player's car this round. field: { med, spread, degMed, degSd, mechMed } of the real season
export function simCar(P, y, round, nRounds, field, powerCap = 0.15) {
  const c = P.car, idx = indexAt(P, round, nRounds);
  const ch = c.out[D.chassis], pr = c.out[D.production], eng = c.out[D.engine];
  const pace = field.med - (idx - 50) / 25 * field.spread;
  const rel = Math.exp(-(0.6 * pr + 0.4 * eng - 50) / 40) * (1 + 0.6 * Math.max(0, -P.profile.sr)) * (1 - 0.4 * Math.max(0, P.profile.sr));
  const deg = (1 - 0.25 * (ch - 50) / 50) * (1 - 0.25 * P.profile.qt);
  return { pace: r2(pace), index: r1(idx), mod: { rel: r2(rel), deg: r2(deg), lean: r2(-P.profile.pa * powerCap), quali: r2(0.15 * P.profile.qt), ...opsMod(P, y) },
           pMech: field.mechMed };
}
// the player's full lean in % lap time per sd of circuit power, for a year (db.meta.power from f1rank/gamedb/power.py)
export function powerCap(db, y) {
  const c = db?.meta?.power?.cap?.find((x) => x.years[0] <= y && y <= x.years[1]);
  return c?.lean_max ?? 0.15;
}

// ---------- searches and staff moves ----------
export function startSearch(P, dept, size, y, urgent = false) {
  if (!covenants(P).searches) return { ok: false, why: "In default: no searches until the credit rating recovers." };
  if (P.searches.some((s) => s.dept === dept)) return { ok: false, why: "A search for that role is already running." };
  const cost = SEARCH[size].cost * (urgent ? 2 : 1);
  P.searches.push({ dept, size, urgent, cost, year: y, rounds: 0 });
  P.searchSpend = r2((P.searchSpend ?? 0) + cost);             // charged to this season's accounts
  return { ok: true, cost };
}
export const cancelSearch = (P, dept) => { P.searches = P.searches.filter((s) => s.dept !== dept); };
// a search reports (offseason, or after 4 rounds if urgent): 1-3 candidates, quality from reputation and spend
export function resolveSearch(P, s, y) {
  const R = rng(P.seed, y, "search", s.dept, P.ids);
  const S = SEARCH[s.size], k = D[s.dept];
  const n = Math.max(1, S.n + Math.round(P.rep / 60) - covenants(P).shortlistCut);
  const cands = [];
  const legend = LEGENDS.find((l) => l.dept === s.dept && l.from <= y && y <= l.to && !(P.hired ?? []).includes(l.name));
  if (legend && R() < 0.08 + 0.25 * (P.rep / 100) * (s.size === "big" ? 1.5 : 1))
    cands.push(makePerson(P, R, s.dept, legend.rating - 3 * Math.max(0, y - legend.to + 3), y,
      { name: legend.name, nat: legend.nat, lean: legend.lean, legend: true, seen: S.sd / 2, salary: marketSalary(legend.rating) * 1.4, age: 35 + Math.floor(15 * R()) }));
  while (cands.length < n) cands.push(makePerson(P, R, s.dept, 40 + 0.4 * P.rep + 11 * gauss(R), y, { seen: S.sd }));
  for (const c of cands) c.salary = r2(c.salary * covenants(P).askMore);
  P.offers[s.dept] = cands;
  P.searches = P.searches.filter((x) => x !== s);
  return cands;
}
// replace the head with a candidate; the old head leaves and takes some know-how
export function hire(P, dept, i) {
  const c = P.offers[dept]?.[i]; if (!c) return false;
  const d = P.depts[D[dept]];
  d.know = r1(d.know * 0.85); d.head = c; delete P.offers[dept];
  if (c.legend) (P.hired ??= []).push(c.name);
  return true;
}
export function promoteMentee(P, dept) {
  const d = P.depts[D[dept]]; if (!d.mentee) return false;
  d.know = r1(d.know * 0.97);
  d.head = { ...d.mentee, rating: r1(d.mentee.rating + 6), salary: marketSalary(d.mentee.rating + 6), years: 3, seen: Math.min(d.mentee.seen, 8) };
  delete d.head.potential; delete d.head.wait; d.mentee = null;
  return true;
}
export function takeMentee(P, dept, y) {
  const d = P.depts[D[dept]]; if (d.mentee) return false;
  d.mentee = makeMentee(P, rng(P.seed, y, "mentee", dept, P.ids), dept, y);
  return true;
}
// engines: build your own, or buy from a supplier tier (0 = best). Starting your own programme costs the know-how
// (a new engine department starts at 15); going customer keeps the people, who become an integration team.
export function setEngine(P, mode, tier = P.engine.tier) {
  if (mode === P.engine.mode && tier === P.engine.tier) return false;
  if (mode === "build" && P.engine.mode !== "build") P.depts[D.engine].know = Math.min(P.depts[D.engine].know, 15);
  if (mode === "customer" && P.credit >= 4) tier = ENGINE_FEE.length - 1;     // in default: only the cheapest supplier
  P.engine = { mode, tier: Math.max(0, Math.min(ENGINE_FEE.length - 1, tier)) };
  return true;
}
export const ENGINE_TIERS = ENGINE_FEE.map((fee, i) => ({ tier: i, fee, output: ENGINE_OUT[i] }));
// pay a head above (or below) market: raises loyalty, costs money; a new contract runs `years`
export function setContract(P, dept, salary, years) { const h = P.depts[D[dept]].head; h.salary = r2(Math.max(0.1, salary)); h.years = years; }
export function leaveChance(P, h, seasonResult) {
  const premium = Math.max(-0.3, Math.min(0.4, h.salary / marketSalary(h.rating) - 1));
  const amb = [0.6, 1, 1.5][h.ambition ?? 1];
  const base = seasonResult === "champion" ? 0.6 : seasonResult === "podium" ? 0.2 : 0.05;
  const poach = Math.max(0, KNOBS.poach * base * (h.rating / 100) ** 2 * (1 - 2.5 * premium) * amb * (h.years > 1 ? 0.6 : 1));
  const walk = seasonResult === "struggling" ? 0.12 * amb * h.rating / 100 : 0;
  const retire = h.age > 62 ? 0.35 : h.age > 55 ? 0.08 : 0;
  return Math.min(0.95, (poach + walk) * covenants(P).leaveMult + retire);
}

// ---------- the season's close ----------
// res: { place (constructors'), n (teams), champion (bool) }; nextY: the next season's year (null at the end)
export function closeSeason(P, y, res, nextY, rounds = 16, K = KNOBS) {
  const R = rng(P.seed, y, P.n ?? 0, "close");
  const news = [], tag = res.season != null ? { season: res.season } : {};
  const result = res.champion ? "champion" : res.place <= 3 ? "podium" : res.place > res.n / 2 ? "struggling" : "midfield";
  // money for the season just run
  const prize = res.prize ?? prizeByPlace(res.place, res.n);
  P.lastPrize = prize;
  const inc = income(P, y, { prize }), out = spending(P, y, rounds);
  const tIn = inc.reduce((a, [, v]) => a + v, 0), tOut = out.reduce((a, [, v]) => a + v, 0);
  P.cash = r2(P.cash + tIn - tOut);
  let missed = false;
  if (P.cash < 0) {                                                   // the shortfall becomes debt
    const short = -P.cash; P.cash = 0; P.debt = r2(P.debt + short);
    if (P.debt > 2.2 * tIn) missed = true;
    news.push(`Shortfall of ${r1(short)} points added to the debt.`);
  }
  if (P.debt > 0 && P.cash > 5) { const pay = Math.min(P.debt, P.cash - 5); P.debt = r2(P.debt - pay); P.cash = r2(P.cash - pay); }   // lenders sweep the surplus
  P.searchSpend = 0;
  P.ledger.push({ year: y, ...tag, income: inc, spending: out, net: r1(tIn - tOut), debt: P.debt, cash: P.cash });
  rateCredit(P, tIn, missed);
  // reputation from the result
  const score = res.score ?? (res.champion ? 100 : Math.max(0, 95 - 70 * (res.place - 1) / Math.max(1, res.n - 1)));
  P.rep = r1(clamp(0.65 * P.rep + 0.35 * score));
  // works backing: reviewed by the board
  if (P.backing.amount) {
    P.backing.bad = result === "struggling" ? P.backing.bad + 1 : 0;
    if (P.backing.bad >= P.backing.patience) { P.backing.amount = r1(P.backing.amount / 2); P.backing.bad = 0; news.push("The board halves the works backing after poor seasons."); }
  }
  // default: facilities sold off cheaply to pay interest
  if (P.credit >= 4) for (const d of P.depts) d.fac = r1(d.fac * 0.9);
  // facilities and know-how
  const gap = nextY ? nextY - y : 1;
  P.depts.forEach((d, k) => {
    const o = deptOutput(P, k, y, 0, K);
    d.know = r1(clamp(d.know + 0.45 * (o.depth / 100) * (d.head.rating / 100) * (100 - d.know) * (1 - 0.5 * nextShare(P))));
    d.fac = r1(clamp(d.fac * 0.94 ** gap + (covenants(P).facilities ? d.invest * 3 : 0)));
    d.carry = nextShare(P);
  });
  // people: age, growth, contracts, leaving
  for (const d of P.depts) {
    const h = d.head;
    h.age += gap; h.tenure++; h.seen = Math.max(3, h.seen - 3); h.years--;
    h.rating = r1(clamp(h.rating + (h.age < 45 ? 1.2 : h.age < 55 ? 0 : -1.2) * gap * (0.5 + R())));
    if (d.mentee) {
      const m = d.mentee; m.age += gap; m.wait++; m.seen = Math.max(3, m.seen - 3);
      m.rating = r1(Math.min(m.potential, m.rating + gap * (2 + 0.08 * Math.max(0, h.rating - m.rating))));
      const walk = (m.wait > 5 ? 0.15 : 0.03) + (P.credit >= 4 ? 0.3 : 0);
      if (R() < walk) { news.push(`${m.name}, ${DEPTS[D[d.key]].name} mentee, leaves for a rival.`); d.mentee = null; }
    }
    const p = leaveChance(P, h, result) + (h.years <= 0 ? 0.25 : 0);
    if (R() < p) {
      const why = h.age > 55 && R() < 0.6 ? "retires" : "leaves for a rival";
      news.push(`${h.name} (${DEPTS[D[d.key]].head}) ${why}.`);
      d.vacant = true;
    } else if (h.years <= 0) h.years = 2;                            // a quiet renewal at the same pay
  }
  // vacancies: the mentee steps up, else a caretaker from inside (rating ~ 40)
  for (const d of P.depts) {
    if (!d.vacant) continue;
    delete d.vacant;
    if (d.mentee && d.mentee.rating >= 35) { promoteMentee(P, d.key); news.push(`${d.head.name} is promoted to ${DEPTS[D[d.key]].head}.`); }
    else { d.know = r1(d.know * 0.85); d.head = makePerson(P, R, d.key, 36 + 0.15 * P.rep + 6 * gauss(R), nextY ?? y, { seen: 12 }); news.push(`${d.head.name} takes over as caretaker ${DEPTS[D[d.key]].head}.`); }
  }
  // searches that were running report now
  for (const s of [...P.searches]) resolveSearch(P, s, y);
  // rule change for the next season: know-how cut, less what was carried by early work on the new car
  const reg = res.reg != null ? res.reg * K.reset : nextY ? regAt(nextY, K) : 0;
  if (reg) { for (const d of P.depts) d.know = r1(d.know * (1 - reg * (1 - 0.6 * d.carry))); news.push(`New rules${res.reg != null ? "" : ` for ${nextY}`}: ${Math.round(reg * 100)}% of the know-how no longer applies.`); }
  P.car = null; P.n = (P.n ?? 0) + 1;
  if (res.keepLedger) P.ledger = P.ledger.slice(-res.keepLedger);
  P.log.push(...news.map((t) => ({ year: y, ...tag, text: t })));
  if (res.keepLog != null) P.log = res.keepLog ? P.log.slice(-res.keepLog) : [];
  return { news, net: r1(tIn - tOut), credit: CREDIT[P.credit] };
}

// ---------- real field (Real Seasons): median pace, typical best margin, deg and failure medians ----------
export function fieldOf(db, y) {
  db._progField ??= new Map();
  if (db._progField.has(y)) return db._progField.get(y);
  const rs = db.realSeasons, cars = new Map(db.cars.map((c) => [c.id, c]));
  const stats = (yy) => {
    const cs = (rs.seasons[yy]?.teams ?? []).map((t) => cars.get(t.car)).filter((c) => c?.pace != null);
    const ps = cs.map((c) => c.pace).sort((a, b) => a - b);
    const med = (v) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : null);
    return { med: med(ps), best: ps[0], mech: med(cs.map((c) => c.p_mech_lap).filter((x) => x != null)), deg: med(cs.map((c) => c.deg_rel).filter((x) => x != null)) };
  };
  const ys = Object.keys(rs.seasons).map(Number).filter((z) => Math.abs(z - y) <= 6);
  const gaps = ys.map((z) => { const s = stats(z); return s.med != null ? s.med - s.best : null; }).filter((x) => x != null && x > 0).sort((a, b) => a - b);
  const s = stats(y);
  const f = { degMed: s.deg ?? 0, med: s.med ?? 0, spread: gaps.length ? gaps[Math.floor(gaps.length / 2)] : 1.5, mechMed: s.mech ?? 0.002,
              bestIndex: s.best != null ? 50 + 25 * (s.med - s.best) / (gaps[Math.floor(gaps.length / 2)] || 1.5) : 75 };
  db._progField.set(y, f);
  return f;
}

// ---------- compact save form (the Career keeps ~180 programmes): people and departments as arrays ----------
const PK = ["id", "name", "nat", "dept", "rating", "age", "lean", "ambition", "salary", "years", "seen", "tenure", "legend", "potential", "wait"];
const packP = (p) => { if (!p) return null; const a = PK.map((k) => p[k] ?? null); while (a.length && a.at(-1) === null) a.pop(); return a; };
const unpackP = (a) => { if (!a) return null; const p = {}; PK.forEach((k, i) => { if (a[i] != null) p[k] = a[i]; }); return p; };
export function packProg(P) {
  return { ...P, depts: P.depts.map((d) => [d.key, d.budget, d.invest, d.fac, d.know, d.carry, packP(d.head), packP(d.mentee)]),
           offers: Object.fromEntries(Object.entries(P.offers).map(([k, v]) => [k, v.map(packP)])), pk: 1 };
}
export function unpackProg(P) {
  if (!P?.pk) return P;
  const { pk, ...Q } = P;
  return { ...Q, depts: P.depts.map(([key, budget, invest, fac, know, carry, h, m]) => ({ key, budget, invest, fac, know, carry, head: unpackP(h), mentee: unpackP(m) })),
           offers: Object.fromEntries(Object.entries(P.offers).map(([k, v]) => [k, v.map(unpackP)])) };
}

// ---------- the scripted manager: CPU teams, and the balance harness's players ----------
// s: skill 0-1 (1 = perfect). R: a random source. o: { rounds, nextReg (share of know-how the next rule change cuts) }
export function autoManage(P, y, s, R, o = {}) {
  const err = (1 - s) ** 0.35, rounds = o.rounds ?? 16, nextReg = o.nextReg ?? 0;
  // next year's car before a rule change
  P.next = nextReg ? 0.6 * s * Math.min(1, nextReg / 0.5) : 0.1 * (1 - s);
  // staff: search for the weakest heads; hire the best seen candidate (worse managers: a random one); pay stars more
  const w = eraW(y);
  const weakest = [...P.depts].sort((a, b) => w[DK.indexOf(a.key)] * (a.head.rating - 90) - w[DK.indexOf(b.key)] * (b.head.rating - 90));
  const inc = expectedIncome(P, y), size = inc > 80 ? "big" : inc > 45 ? "medium" : "small";
  // good managers search only where a head is weak or close to leaving; worse ones search at random
  const need = (d) => d.head.rating < 60 + 0.35 * P.rep || d.head.age > 58 || d.head.years <= 1;
  for (const d of weakest.slice(0, 1 + Math.round(2 * s * Math.min(1, inc / 60)))) if (R() < s ? need(d) : R() < 0.5) {
    const r = startSearch(P, d.key, size, y);
    if (r.ok && o.resolve) resolveSearch(P, P.searches.find((q) => q.dept === d.key), y);
  }
  // engines: build once the money is there (better managers judge the moment), else the best affordable supplier
  if (P.engine.mode === "customer" && inc > 75 - 15 * s && R() < s) setEngine(P, "build");
  else if (P.engine.mode === "customer") setEngine(P, "customer", inc > 60 ? 0 : inc > 40 ? 1 : 2);
  const searchCost = P.searchSpend ?? 0;
  for (const [dept, cands] of Object.entries(P.offers)) {
    const d = P.depts[DK.indexOf(dept)], mid = (p) => (ratingRange(p)[0] + ratingRange(p)[1]) / 2;
    const pick = R() < s * s ? cands.reduce((a, b) => (mid(b) > mid(a) ? b : a)) : cands[Math.floor(R() * cands.length)];
    if (mid(pick) > mid(d.head) + 2) hire(P, dept, cands.indexOf(pick)); else delete P.offers[dept];
  }
  for (const d of P.depts) {
    if (d.head.rating > 65) setContract(P, d.key, marketSalary(d.head.rating) * (1 + 0.3 * s ** 3), 3);
    if (!d.mentee && R() < 0.3 + 0.7 * s) takeMentee(P, d.key, y);
  }
  // budget: spend what the season should bring in, less fixed costs; worse managers misjudge it
  const fixed = spending({ ...P, depts: P.depts.map((d) => ({ ...d, budget: 0, invest: 0 })), searchSpend: 0 }, y, rounds).reduce((a, [, v]) => a + v, 0);
  const room = Math.max(5, expectedIncome(P, y) - fixed + Math.min(P.cash, 10) - (P.debt > 0 ? 0.3 * P.debt * (0.5 + 0.5 * s) : 0));
  const total = room * Math.exp(0.2 * err * gauss(R)) - searchCost;
  let al = w.map((x) => x * Math.exp(gauss(R) * 1.3 * err)); const sa = al.reduce((a, b) => a + b, 0); al = al.map((x) => x / sa);
  P.depts.forEach((d, k) => { d.budget = +(0.88 * total * al[k]).toFixed(1); d.invest = +(0.12 * total * al[k]).toFixed(1); });
  // a sensible manager pays down debt when there is spare cash
  if (P.debt > 0 && P.cash > 5) repay(P, (P.cash - 5) * s);
}

// ---------- starting from a real team ----------
// the car index of a real car in its season (50 = median car, 75 = the usual best)
export const indexOfPace = (f, pace) => 50 + 25 * (f.med - pace) / f.spread;
// scale a preset so the first car's projection lands on a target index (staff, facilities and know-how move together)
export function calibrate(cfg, y, target, seed = 1) {
  let lo = 5, hi = 99, c = cfg;
  for (let it = 0; it < 18; it++) {
    const x = (lo + hi) / 2;
    c = { ...cfg, staff: x, fac: Math.max(5, x - 10), know: Math.max(5, x - 15) };
    const P = newProgramme(c, y, seed);
    if (projection(P, y).mu < target) lo = x; else hi = x;
  }
  return c;
}
// the starting setup for a real team: its real car's standing sets the people and the money
export function presetForCar(f, pace, y) {
  const idx = indexOfPace(f, pace);
  const base = idx >= 70 ? "bigname" : idx >= 48 ? "midfield" : "privateer";
  const rep = r1(clamp(20 + 1.1 * (idx - 30)));
  return { preset: base, ...PRESETS[base], rep, engine: idx >= 62 ? "build" : "customer", tier: idx >= 55 ? 0 : 1, target: r1(idx) };
}
// old saves (upgrade levels 0-10 for pace, deg, rel; money in $M): levels become know-how and facilities, money becomes cash
export function migrateUpgrades(P, up, moneyM) {
  const add = (k, v) => { const d = P.depts[D[k]]; d.know = r1(clamp(d.know + v)); d.fac = r1(clamp(d.fac + v * 0.8)); };
  for (const k of ["design", "aero", "engine", "chassis"]) add(k, 3 * (up?.pace ?? 0));
  add("chassis", 2 * (up?.deg ?? 0)); add("production", 4 * (up?.rel ?? 0));
  P.cash = r2(Math.max(0, moneyM ?? 0) * 2);
  return P;
}
