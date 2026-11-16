// Career mode engine (no DOM): a tiered championship of decade-constructor entries.
//
// - Every constructor is a team; it owns one entry per decade it raced in (Ferrari: 50s to 20s).
//   An entry runs one car, a model from that decade. Each offseason a CPU entry's model drifts at random by up
//   to one year; the player's entries keep theirs unless the player moves one, by up to one year (setModel).
// - Entries are split into tiers of 26 (one race per tier per round); 6 up, 6 down each season.
// - Drivers stay at their peak season. Contracts (2-6 seasons) bind a driver to an entry.
// - Offseason market: rounds of offers. Each driver holds the best offer so far (best car for the
//   foreseeable future: expected pace of the entry's model range plus upgrades, plus tier) and rejects
//   the rest; rejected teams go again next round, until every seat is filled.
// - Prize money from race and championship results buys upgrades (pace, tyre wear, reliability) for the
//   player's entries. Upgrades are permanent; CPU teams don't upgrade.
//
// - Driver career (C.mode "driver"): the player is a driver, not a team. Their driver joins the database with nine
//   skills, each a share of the real drivers it beats (bought up with the player's money: salary plus race and
//   season bonuses). CPU teams judge the player like any other driver; offers to the player wait for an answer
//   (accept one, decline the rest; unanswered offers lapse when the next round runs).
//
// State is plain JSON (save files). Derived tables (driver peaks, car index) are rebuilt by `index(db)`.
import { packCareer } from "./archive.js";
import { simulateRace } from "./sim/race.js";
import { layoutFor, indexDb, SKILLS } from "./sim/db.js";

// pre-war decades (golden-era data, 1906-1941): labelled in full so they don't clash with 00s / 10s / 20s
export const DECADES = [["1900s", 1900, 1909], ["1910s", 1910, 1919], ["1920s", 1920, 1929], ["1930s", 1930, 1941],
  ["50s", 1950, 1959], ["60s", 1960, 1969], ["70s", 1970, 1979], ["80s", 1980, 1989], ["90s", 1990, 1999], ["00s", 2000, 2009], ["10s", 2010, 2019], ["20s", 2020, 2024]];
export const TIER_SIZE = 26, MOVE = 6, ROUNDS = 10;
export const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];            // 2024 system, no fastest-lap point
export const TIER_PRIZE = [1, 0.6, 0.38, 0.24, 0.15];                  // prize multiplier by tier (lower tiers: x0.6 each)
export const tierPrize = (t) => TIER_PRIZE[t] ?? TIER_PRIZE.at(-1) * 0.6 ** (t - TIER_PRIZE.length + 1);
export const START_MONEY = 15;                                          // $M
export const CONTRACT_MIN = 2, CONTRACT_MAX = 6;
// upgrades: level 0..max; effect per level; cost of the next level = base + inc * level ($M)
// pace adds per level (% of lap time); tyre wear and reliability multiply by (1 + per) per level (compounding,
// so the top level never reaches zero wear / failures)
export const UPGRADES = {
  pace: { label: "Pace", max: 10, per: -0.12, base: 4, inc: 2, unit: "% lap time" },
  deg: { label: "Tyre wear", max: 10, per: -0.12, base: 2, inc: 1, unit: "x wear" },
  rel: { label: "Reliability", max: 10, per: -0.16, base: 2, inc: 1, unit: "x failures" },
};
export const upgradeEffect = (stat, level) => (stat === "pace" ? UPGRADES.pace.per * level : (1 + UPGRADES[stat].per) ** level);
export const DEFAULT_CALENDAR = ["albert_park", "sepang", "imola", "monaco", "villeneuve", "silverstone", "hockenheimring",
  "spa", "monza", "suzuka"];
// calendar modes: "fixed" (the venues stay; the player edits them in the offseason), "shuffle" (same venues, new
// order every offseason), "random" (a new draw of venues every offseason, from every circuit with a track map, each with a random mapped layout)
export const CAL_MODES = [["fixed", "Fixed"], ["shuffle", "Shuffle the order each offseason"], ["random", "Random venues and layouts each offseason"],
  ["iconic", "Random each offseason, weighted to iconic layouts"]];
// iconic weighting: a layout's weight is its iconic score (1-10, config/layout_iconic.json) to this power; 0 = even
export const ICONIC_POW = { def: 2, min: 0, max: 5 };
export const iconicOf = (db, key) => db.realSeasons?.iconic?.[key] ?? 5;
// weighted draw without replacement: k items, weight w(x)
export function weightedPick(items, w, k, R) {
  const pool = items.map((x) => [x, Math.max(1e-9, w(x))]), out = [];
  while (out.length < k && pool.length) {
    let u = R() * pool.reduce((s, [, v]) => s + v, 0), j = 0;
    while (j < pool.length - 1 && (u -= pool[j][1]) > 0) j++;
    out.push(pool.splice(j, 1)[0][0]);
  }
  return out;
}
const mapped = (db) => [...index(db).circuits.values()].filter((c) => c.layouts.some((l) => l.geo_id)).map((c) => c.ref).sort();
// the next season's calendar under the career's mode (seeded by career and season, so a reload gives the same)
export function rollCalendar(db, C, salt = "") {
  const mode = C.calMode ?? "fixed", n = C.calendar.length || ROUNDS;
  const R = rngOf(C.seed, C.season, "cal", salt);
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  if (mode === "shuffle") C.calendar = shuffle([...C.calendar]);
  else if (mode === "iconic") {                 // venues and layouts drawn by iconic score ^ strength
    const ix = index(db), pw = C.iconicPow ?? ICONIC_POW.def;
    const lays = (c) => ix.circuits.get(c).layouts.filter((l) => l.geo_id);
    const best = (c) => Math.max(...lays(c).map((l) => iconicOf(db, l.key)));
    C.calendar = weightedPick(mapped(db), (c) => best(c) ** pw, n, R).map((circuit) =>
      ({ circuit, layout: weightedPick(lays(circuit), (l) => iconicOf(db, l.key) ** pw, 1, R)[0].key }));
  }
  else if (mode === "random") {                 // random venues, each with a random layout that has a track map
    const ix = index(db);
    C.calendar = shuffle(mapped(db)).slice(0, n).map((circuit) => {
      const lays = ix.circuits.get(circuit).layouts.filter((l) => l.geo_id);
      return { circuit, layout: lays[Math.floor(R() * lays.length)].key };
    });
  }
}
export function setCalMode(db, C, mode) {
  if (!CAL_MODES.some(([m]) => m === mode) || C.phase !== "market") return false;
  C.calMode = mode;
  return true;
}
export function setIconicPow(C, v) {
  if (C.phase !== "market") return false;
  C.iconicPow = Math.max(ICONIC_POW.min, Math.min(ICONIC_POW.max, Number(v) || 0));
  return true;
}
// rounds in this career's season (its calendar; ROUNDS for new careers)
export const roundsOf = (C) => C.calendar.length;
const TIER_W = 0.35;            // a driver values one tier up like this much pace (pct of lap)
const SCOUT_SD = 0.12;          // CPU teams' error in judging a driver

// ---------- helpers ----------
const strH = (s) => { let h = 2166136261; for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };
export function seedOf(...xs) {
  let h = 0x9e3779b9;
  for (const x of xs) { h = Math.imul(h ^ (typeof x === "number" ? x >>> 0 : strH(x)), 2654435761) >>> 0; h ^= h >>> 15; }
  return (h >>> 0) || 1;
}
function rngOf(...xs) { let a = seedOf(...xs); return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const decOf = (y) => DECADES.find(([, a, b]) => y >= a && y <= b)?.[0];
const round1 = (x) => Math.round(x * 10) / 10;
const money = (x) => Math.round(x * 100) / 100;     // $M, to $10k

// pre-war makes that are also championship constructors: one team across the eras (Mercedes 1930s ... 20s)
const PW_TEAM = { pw_alfa_romeo: "alfa", pw_maserati: "maserati", pw_mercedes_benz: "mercedes", pw_mercedes: "mercedes",
  pw_era: "era", pw_alta: "alta", pw_frazer_nash: "frazer_nash", pw_talbot: "lago" };
const PW_MIN_RACES = 3;         // a pre-war make gets a career entry for a decade with at least this many starts
export const teamRef = (c) => (c.prewar ? PW_TEAM[c.ref] ?? c.ref : c.ref);
// a pre-war car's pace in a career (mixed eras, field-relative): put on the 1950s spread of car pace (the early
// fields were further apart) and shrunk toward the field average by its number of starts (few starts = noisy)
const PW_SPREAD = { 1900: 0.71, 1910: 0.82, 1920: 0.84, 1930: 0.89, 1940: 0.96 };   // sd(1950s) / sd(decade)
const PW_SHRINK_K = 3;
function careerCar(c) {
  const n = c.n_races || 0;
  return { ...c, pace: Math.round(c.pace * (PW_SPREAD[Math.floor(c.year / 10) * 10] ?? 1) * n / (n + PW_SHRINK_K) * 1000) / 1000 };
}
// a pre-war make has several models a year: its entry runs the Grand Prix car with the most starts that year
function prewarCars(db, minRaces = PW_MIN_RACES) {
  const best = new Map();
  for (const c of db.cars) {
    if (!c.prewar || c.cls !== "gp" || c.premier === false || c.estimated || c.ref === "pw_unknown" || c.ref === "pw_") continue;
    const k = `${teamRef(c)}|${c.year}`, b = best.get(k);
    if (!b || (c.n_races || 0) > (b.n_races || 0) || ((c.n_races || 0) === (b.n_races || 0) && c.pace < b.pace)) best.set(k, c);
  }
  const starts = new Map();      // make|decade -> starts
  for (const [k, c] of best) { const d = `${k.split("|")[0]}|${decOf(c.year)}`; starts.set(d, (starts.get(d) ?? 0) + (c.n_races || 0)); }
  return [...best.entries()].filter(([k, c]) => (starts.get(`${k.split("|")[0]}|${decOf(c.year)}`) ?? 0) >= minRaces)
    .map(([k, c]) => [k, c]);
}

// ---------- derived tables ----------
export function index(db) {
  if (db._career) return db._career;
  const cars = new Map(db.cars.map((c) => [c.id, c]));
  const carAt = new Map(db.cars.filter((c) => !c.prewar).map((c) => [`${c.ref}|${c.year}`, c]));
  const pwCars = prewarCars(db);                     // new careers: makes with enough starts in the decade
  // every pre-war make's car is resolvable, so a save keeps loading when a data update drops a make below the
  // new-career threshold (v50's once-per-event counting did that to seven, e.g. the 1920s Hispano-Suiza)
  for (const [k, c] of prewarCars(db, 0)) carAt.set(k, careerCar(c));
  // driver peak: the season with the best pace, judged cautiously (mean + 1 sd) so a noisy one-off season doesn't win
  const peaks = new Map();
  // every driver at their peak season, pre-war ones included (a season the model only estimated doesn't count)
  for (const d of db.drivers) {
    let best = null;
    for (const [y, s] of Object.entries(d.seasons)) {
      if (s.estimated) continue;
      const p = s.skills?.pace; if (!p) continue;
      const v = p[0] + p[1];
      if (!best || v < best.score) best = { year: +y, score: v, pace: p[0] };
    }
    if (best) peaks.set(String(d.id), best);              // ids as strings: they are JSON object keys in saves
  }
  const scores = [...peaks.values()].map((p) => p.score);
  const sMin = Math.min(...scores);
  for (const p of peaks.values()) p.rating = ratingOf(p.score, sMin);
  const drivers = new Map(db.drivers.filter((d) => peaks.has(String(d.id))).map((d) => [String(d.id), d]));
  const circuits = new Map(db.circuits.map((c) => [c.ref, c]));
  const carMin = Math.min(...db.cars.filter((c) => !c.prewar).map((c) => c.pace));
  // each skill over the drivers' peak seasons, best first (the scale of the player's skill levels) + its typical sd
  const qs = {}, sds = {};
  for (const k of SKILLS) {
    const v = [], u = [];
    for (const [id, pk] of peaks) { const x = drivers.get(id)?.seasons[pk.year]?.skills?.[k]; if (x) { v.push(x[0]); u.push(x[1]); } }
    qs[k] = v.sort((a, b) => (SKILL_UP[k].dir < 0 ? a - b : b - a));
    sds[k] = u.sort((a, b) => a - b)[Math.floor(u.length / 2)] ?? 0;
  }
  db._career = { cars, carAt, pwCars, peaks, drivers, circuits, carMin, sMin, qs, sds };
  return db._career;
}

const ratingOf = (score, sMin) => Math.max(1, Math.round(99 - (score - sMin) * 18));

// ---------- entries, cars ----------
export const pairName = (C, p) => `${C.teams[C.pairs[p].ref].name} ${C.pairs[p].dec}`;
export const modelId = (db, pr) => index(db).carAt.get(`${pr.ref}|${pr.model}`).id;
export function modOf(pr) {
  return { pace: upgradeEffect("pace", pr.up.pace), deg: upgradeEffect("deg", pr.up.deg), rel: upgradeEffect("rel", pr.up.rel) };
}
// the upgrades as the race sim takes them, plus a pre-war car's career pace adjustment (careerCar) over its raw pace
export function raceMod(db, pr) {
  const ix = index(db), m = modOf(pr), c = ix.carAt.get(`${pr.ref}|${pr.model}`);
  return { ...m, pace: m.pace + (c.pace - ix.cars.get(c.id).pace) };
}
// effective pace of an entry's current model (pct of lap, lower is faster)
export function carPace(db, pr) { return index(db).carAt.get(`${pr.ref}|${pr.model}`).pace + modOf(pr).pace; }
// what a driver expects of an entry: its model and the neighbouring ones it may drift to, plus upgrades
export function expectedPace(db, pr) {
  const ix = index(db), k = pr.years.indexOf(pr.model);
  const ys = pr.years.slice(Math.max(0, k - 1), k + 2);
  const m = ys.reduce((s, y) => s + ix.carAt.get(`${pr.ref}|${y}`).pace, 0) / ys.length;
  return 0.6 * ix.carAt.get(`${pr.ref}|${pr.model}`).pace + 0.4 * m + modOf(pr).pace;
}
export const carRating = (db, pace) => Math.max(1, Math.round(99 - (pace - index(db).carMin) * 7));
export const nTiers = (C) => Math.ceil(C.pairs.length / TIER_SIZE);
export const tierPairs = (C, t) => C.pairs.map((_, p) => p).filter((p) => C.pairs[p].tier === t);
export const driverOf = (C, p) => Object.keys(C.contracts).find((d) => C.contracts[d].pair === p) ?? null;
export function upgradeCost(pr, stat) { const u = UPGRADES[stat], l = pr.up[stat]; return l >= u.max ? null : u.base + u.inc * l; }

// ---------- new career ----------
export function newCareer(db, { seed, rulesYear = 2016, player = null, me = null, calMode = "fixed", iconicPow = ICONIC_POW.def }) {
  detachMe(db);
  const ix = index(db);
  const R = rngOf(seed, "init");
  const teams = {}, pairs = [];
  // championship cars, and each pre-war make's entry car (under the constructor's ref when it raced in F1 too)
  const f1cars = [...db.cars.filter((c) => !c.prewar).map((c) => [c.ref, c]), ...ix.pwCars.map(([k, c]) => [k.split("|")[0], c])];
  const refs = [...new Set(f1cars.map(([r]) => r))].sort();
  for (const ref of refs) {
    const cs = f1cars.filter(([r]) => r === ref).map(([, c]) => c).sort((a, b) => a.year - b.year);
    teams[ref] = { name: cs.at(-1).name, money: START_MONEY, colour: cs.at(-1).colours?.[0] ?? "#888" };
    for (const [dec] of DECADES) {
      const years = cs.filter((c) => decOf(c.year) === dec).map((c) => c.year);
      if (!years.length) continue;
      const model = years[Math.floor(R() * years.length)];
      pairs.push({ id: `${ref}|${dec}`, ref, dec, years, model, base: model, tier: 0,
                   up: { pace: 0, deg: 0, rel: 0 } });
    }
  }
  // seeding: by the entry's strength (its model, and the decade's range of models), best 26 in tier 1, ...
  const strength = (pr) => 0.5 * ix.carAt.get(`${pr.ref}|${pr.model}`).pace
    + 0.5 * pr.years.reduce((s, y) => s + ix.carAt.get(`${pr.ref}|${y}`).pace, 0) / pr.years.length;
  [...pairs].sort((a, b) => strength(a) - strength(b)).forEach((pr, k) => { pr.tier = Math.floor(k / TIER_SIZE); });
  const C = {
    v: 1, seed, rulesYear, season: 1, phase: "market", player: me ? null : player, teams, pairs, contracts: {},
    mode: me ? "driver" : "team",
    me: me ? { id: String(ME_ID), name: String(me.name).slice(0, 40), code: String(me.code ?? "").toUpperCase().slice(0, 3),
               helmet: me.helmet ?? null, lv: Object.fromEntries(SKILLS.map((k) => [k, 0])), money: ME_START_MONEY, earned: 0 } : null,
    calendar: DEFAULT_CALENDAR.filter((c) => ix.circuits.has(c)).map((circuit) => ({ circuit })), calMode, iconicPow,
    round: 0, results: [], pending: null, autoWatch: true, watchExtra: [],
    market: null, news: [], history: [],
  };
  attachMe(db, C);
  if (calMode !== "fixed") rollCalendar(db, C);
  startMarket(db, C);
  return C;
}

// ---------- market ----------
// held[d] = { pair, years, own?: true (staying on the last year of the current deal), ext?: true }
function startMarket(db, C) {
  const held = {};
  for (const [d, c] of Object.entries(C.contracts)) if (c.left === 1) held[d] = { pair: c.pair, years: 1, own: true };
  C.market = { round: 0, held, rejected: {}, log: [], userOffers: {}, myOffers: [], done: false };
  // CPU teams extend last-year drivers they rate highly for the entry's tier
  for (const [d, h] of Object.entries(held)) {
    const pr = C.pairs[h.pair];
    if (pr.ref === C.player) continue;
    const q = quality(db, C, pr.ref, d);
    const tierQ = tierPairs(C, pr.tier).map((p) => driverOf(C, p)).filter(Boolean).map((x) => quality(db, C, pr.ref, x)).sort((a, b) => a - b);
    if (q <= tierQ[Math.floor(tierQ.length * 0.5)] ?? Infinity) {
      if (d === meId(C)) {                          // the player decides: an extension offer
        C.market.myOffers.push({ pair: h.pair, years: contractLength(db, C, h.pair, d), salary: salaryOf(db, C, h.pair), ext: true });
        log(C, `${pairName(C, h.pair)} offers you an extension (${C.market.myOffers.at(-1).years} seasons).`, true);
        continue;
      }
      held[d] = { pair: h.pair, years: contractLength(db, C, h.pair, d), ext: true };
      log(C, `${pairName(C, h.pair)} extends ${dname(db, d)} (${held[d].years} seasons).`, pr.ref === C.player);
    }
  }
  updateOpen(C);
}
const dname = (db, d) => index(db).drivers.get(d)?.name ?? d;
function log(C, text, mine = false) { C.market.log.push({ r: C.market.round, text, mine }); }
// firm: contract running past next season (not on the market)
const firm = (C, d) => (C.contracts[d]?.left ?? 0) >= 2;
export function seatHolder(C, p) {
  for (const [d, h] of Object.entries(C.market?.held ?? {})) if (h.pair === p) return d;
  for (const [d, c] of Object.entries(C.contracts)) if (c.pair === p && c.left >= 2) return d;
  return null;
}
function updateOpen(C, db = null) {
  const taken = new Set();
  for (const [d, c] of Object.entries(C.contracts)) if (c.left >= 2) taken.add(c.pair);
  for (const h of Object.values(C.market.held)) taken.add(h.pair);
  C.market.open = C.pairs.map((_, p) => p).filter((p) => !taken.has(p));
  C.market.done = C.market.open.length === 0;
  if (C.market.done && db) seatForMe(db, C);
}
// a driver's value of an entry (higher is better)
export function driverValue(db, C, p) { return -expectedPace(db, C.pairs[p]) - TIER_W * C.pairs[p].tier; }
export function heldValue(db, C, d) { const h = C.market?.held[d]; return h ? driverValue(db, C, h.pair) : -Infinity; }
// would driver d take an offer from entry p now?
export function wouldAccept(db, C, d, p) {
  if (firm(C, d)) return false;
  if ((C.market.rejected[d] ?? []).includes(p)) return false;
  const h = C.market.held[d];
  if (h && h.pair === p) return true;              // extension
  if (d === meId(C)) return true;                  // the player hears every offer (and may take a worse car)
  return driverValue(db, C, p) > heldValue(db, C, d) + 1e-9;
}
// how good a team thinks a driver is (lower is better): true peak plus the team's scouting error
export function quality(db, C, ref, d) {
  const u = rngOf(C.seed, "scout", ref, d);
  return index(db).peaks.get(d).score + SCOUT_SD * (u() + u() + u() - 1.5) * 2;
}
// contract length a CPU team offers: long for drivers better than the entry's tier, short otherwise
function contractLength(db, C, p, d) {
  const pr = C.pairs[p];
  const q = index(db).peaks.get(d).score;
  const all = [...index(db).peaks.values()].map((x) => x.score).sort((a, b) => a - b);
  const pct = all.findIndex((x) => x >= q) / all.length;              // 0 = best driver
  const tierPct = (pr.tier + 0.5) / nTiers(C) * 0.5;                    // what the tier would expect
  const r = rngOf(C.seed, C.season, "len", p, d)();
  if (pct < tierPct * 0.6) return 5 + (r < 0.5 ? 1 : 0);
  if (pct < tierPct) return 3 + Math.floor(r * 2);
  return 2 + (r < 0.3 ? 1 : 0);
}
// candidates on the market for entry p (not under a firm contract, not already said no to p)
function candidates(db, C, p) {
  const out = [];
  for (const d of index(db).drivers.keys()) if (wouldAccept(db, C, d, p) && C.market.held[d]?.pair !== p) out.push(d);
  return out;
}
// CPU choice for an open entry: the best driver (by its own judgement) it can realistically land. Entries
// are ranked by how attractive they are; the k-th best entry aims around the k-th best available driver,
// so the whole grid doesn't chase the same star and the market settles in a few rounds.
function cpuPick(db, C, p, ranks, consensus) {
  const ref = C.pairs[p].ref;
  const cand = candidates(db, C, p);
  if (!cand.length) return null;
  const cr = new Map(consensus.map((d, k) => [d, k]));
  cand.sort((a, b) => (cr.get(a) ?? 1e9) - (cr.get(b) ?? 1e9));
  const k = ranks.get(p) ?? 0;
  const lo = Math.max(0, Math.floor(k * 0.85) - 2 - C.market.round);   // aim higher once the market thins out
  const pool = cand.slice(Math.min(lo, Math.max(0, cand.length - 1)), Math.min(cand.length, lo + 6));
  const use = pool.length ? pool : cand;
  let best = null, bq = Infinity;
  for (const d of use) { const q = quality(db, C, ref, d); if (q < bq) { bq = q; best = d; } }
  return best;
}
// one round of offers. userOffers: { pair: { driver, years } } for the player's open entries;
// staff: also let the CPU pick for the player's open entries without an offer.
export function marketRound(db, C, { staff = false } = {}) {
  const M = C.market;
  if (M.done) return;
  M.round++;
  const open = M.open;
  const ranks = new Map([...open].sort((a, b) => driverValue(db, C, b) - driverValue(db, C, a)).map((p, k) => [p, k]));
  const consensus = [...index(db).drivers.keys()].filter((d) => !firm(C, d))
    .sort((a, b) => index(db).peaks.get(a).score - index(db).peaks.get(b).score);
  const offers = [];
  const targeted = new Map();                                          // spread offers within the round
  for (const p of open) {
    const mine = C.pairs[p].ref === C.player;
    if (mine) {
      const u = M.userOffers[p];
      if (u) { offers.push({ pair: p, driver: u.driver, years: u.years, user: true }); continue; }
      if (!staff) continue;
    }
    const d = cpuPick(db, C, p, ranks, consensus.filter((x) => !targeted.has(x) || driverValue(db, C, p) > targeted.get(x)));
    if (!d) continue;
    targeted.set(d, Math.max(targeted.get(d) ?? -Infinity, driverValue(db, C, p)));
    offers.push({ pair: p, driver: d, years: contractLength(db, C, p, d) });
  }
  M.userOffers = {};
  // offers to the player that were not answered lapse (as a declined offer)
  for (const o of M.myOffers ?? []) if (!o.ext) (M.rejected[meId(C)] ??= []).push(o.pair);
  M.myOffers = [];
  // each driver keeps the best offer (held one included) and rejects the rest
  const byDriver = new Map();
  for (const o of offers) (byDriver.get(o.driver) ?? byDriver.set(o.driver, []).get(o.driver)).push(o);
  for (const [d, os] of byDriver) {
    if (d === meId(C)) {                            // the player answers in the market tab
      for (const o of os) {
        M.myOffers.push({ pair: o.pair, years: o.years, salary: salaryOf(db, C, o.pair) });
        log(C, `${pairName(C, o.pair)} (Tier ${C.pairs[o.pair].tier + 1}) offers you ${o.years} season${o.years === 1 ? "" : "s"} at ${fmtMoney(M.myOffers.at(-1).salary)} a season.`, true);
      }
      continue;
    }
    const h = M.held[d];
    let best = h ? { ...h, held: true } : null, bv = h ? driverValue(db, C, h.pair) : -Infinity;
    for (const o of os) {
      const v = driverValue(db, C, o.pair);
      // a better car wins; same entry (an extension) wins over the held deal
      if (v > bv + 1e-9 || (best && o.pair === best.pair && !best.ext)) { best = o; bv = v; }
    }
    for (const o of os) if (o !== best) {
      (M.rejected[d] ??= []).push(o.pair);
      if (o.user || C.pairs[o.pair].ref === C.player) log(C, `${dname(db, d)} turned down ${pairName(C, o.pair)}${h || best ? ` (prefers ${pairName(C, best.pair)})` : ""}.`, true);
    }
    if (best && !best.held) {
      const prev = h ? h.pair : null;
      M.held[d] = { pair: best.pair, years: best.years, ...(prev === best.pair ? { ext: true } : {}) };
      const mine = C.pairs[best.pair].ref === C.player || (prev !== null && C.pairs[prev].ref === C.player)
        || (C.mode === "driver" && (best.pair === myPair(C) || prev === myPair(C)));
      log(C, `${dname(db, d)} agrees terms with ${pairName(C, best.pair)} (${best.years} season${best.years === 1 ? "" : "s"})` +
        (prev !== null && prev !== best.pair ? `, leaving ${pairName(C, prev)}.` : "."), mine);
      if (prev !== null && prev !== best.pair) (M.rejected[d] ??= []).push(prev);   // no going back
    }
  }
  updateOpen(C, db);
  // stuck: open CPU entries that made no offer (everyone left turned them down): take any free driver
  if (!offers.length && M.open.some((p) => C.pairs[p].ref !== C.player)) {
    for (const p of M.open) if (C.pairs[p].ref !== C.player) {
      const d = [...index(db).drivers.keys()].find((x) => !firm(C, x) && !M.held[x] && x !== meId(C));
      if (d) { M.held[d] = { pair: p, years: 2 }; log(C, `${dname(db, d)} joins ${pairName(C, p)} (2 seasons).`); }
    }
    updateOpen(C, db);
  }
  return offers.length;
}
export const userOpen = (C) => (C.market?.open ?? []).filter((p) => C.pairs[p].ref === C.player);
// run rounds until the market closes or only the player's seats are left
export function runMarket(db, C, maxRounds = 60) {
  for (let k = 0; k < maxRounds && !C.market.done; k++) {
    if (C.market.open.every((p) => C.pairs[p].ref === C.player) && !Object.keys(C.market.userOffers).length) break;
    if (C.mode === "driver" && C.market.myOffers.length) break;     // the player has offers to answer
    marketRound(db, C);
  }
}
export function closeMarket(db, C) {
  const M = C.market;
  if (!M.done) throw new Error("market still open");
  for (const [d, h] of Object.entries(M.held)) {
    if (h.own) continue;                                         // stays on the last year of the deal
    for (const [x, c] of Object.entries(C.contracts)) if (c.pair === h.pair && x !== d) delete C.contracts[x];
    C.contracts[d] = { pair: h.pair, left: h.years, ...(h.salary != null ? { salary: h.salary } : {}) };
  }
  // drivers on their last year who left: their old deal is gone (they hold another seat), already replaced above
  C.news.push({ season: C.season, text: `Market closed after ${M.round} rounds.` });
  C.market = null;
}
const fmtMoney = (x) => `$${(Math.round(x * 10) / 10).toFixed(1)}M`;

// ---------- season ----------
export function startSeason(db, C) {
  if (C.market) closeMarket(db, C);
  C.phase = "season"; C.round = 0; C.results = []; C.pending = null;
}
// race config for round r, tier t
export function raceConfig(db, C, r, t) {
  const ix = index(db);
  const cal = C.calendar[r];
  const circ = ix.circuits.get(cal.circuit);
  const lay = layoutFor(circ, C.rulesYear, cal.layout);
  const real = db.races.filter((x) => x.circuit === circ.ref && x.layout === lay.key);
  const laps = real.length ? real.reduce((a, b) => (b.year > a.year ? b : a)).laps : Math.ceil(305 / (lay.length_km ?? 5));
  // weather: a real race at this circuit, drawn at random (so rain comes as often as it did there)
  const u = rngOf(C.seed, C.season, r, "wx")();
  const wxr = db.races.filter((x) => x.circuit === circ.ref);
  const w = wxr.length ? wxr[Math.floor(u * wxr.length)].weather : null;
  const wet = w ? Math.min(1, (w.rain_mm ?? 0) / 3) : 0;
  const ps = tierPairs(C, t);
  return {
    name: `S${C.season} R${r + 1} · Tier ${t + 1} · ${circ.name}`, circuit: circ.ref, layout: lay.key, year: C.rulesYear,
    laps, wet, mode: "relative", grid: "quali", seed: seedOf(C.seed, C.season, r, t), relReliability: true,
    entries: ps.map((p) => {
      const d = driverOf(C, p), pr = C.pairs[p];
      return { driver: Number(d), season: ix.peaks.get(d).year, car: modelId(db, pr), mod: raceMod(db, pr), ...(pr.ref === C.player || (C.mode === "driver" && d === meId(C)) ? { mine: true } : {}) };
    }),
    career: { season: C.season, round: r, tier: t, pairs: ps },
  };
}
export function watchTiers(C) {
  const mine = new Set(C.mode === "driver" ? (myPair(C) !== null ? [C.pairs[myPair(C)].tier] : [])
    : C.pairs.filter((pr) => pr.ref === C.player).map((pr) => pr.tier));
  const s = new Set(C.autoWatch ? mine : []);
  for (const t of C.watchExtra ?? []) s.add(t);
  return [...s].sort((a, b) => a - b);
}
// start round r: sim every tier not watched; returns the tiers left to watch
export function playRound(db, C, trackFor, watch = watchTiers(C)) {
  const r = C.round;
  C.results[r] ??= [];
  const todo = [];
  for (let t = 0; t < nTiers(C); t++) {
    if (C.results[r][t]) continue;
    if (watch.includes(t)) { todo.push(t); continue; }
    simTier(db, C, r, t, trackFor);
  }
  C.pending = todo.length ? { round: r, tiers: todo } : null;
  if (!todo.length) finishRound(db, C);
  return todo;
}
export function simTier(db, C, r, t, trackFor) {
  const cfg = raceConfig(db, C, r, t);
  const out = simulateRace(db, { ...cfg, calls: [] }, trackFor(cfg.circuit, cfg.layout));
  recordRace(db, C, cfg, out, []);
}
export function recordRace(db, C, cfg, out, calls) {
  const { round: r, tier: t, pairs } = cfg.career;
  if (cfg.career.season !== C.season || C.results[r]?.[t]) return false;
  C.results[r] ??= [];
  C.results[r][t] = out.result.map((x) => {
    const pts = x.status === "finished" ? (POINTS[x.pos - 1] ?? 0) : 0;
    const p = pairs[x.c];
    const prize = money(tierPrize(t) * (0.25 + 0.12 * pts));
    C.teams[C.pairs[p].ref].money = money(C.teams[C.pairs[p].ref].money + prize);
    const d = String(cfg.entries[x.c].driver);
    const row = { p, d, pos: x.pos, fin: x.status === "finished" ? 1 : 0, pts, prize, grid: out.cars[x.c].grid };
    if (C.mode === "driver" && d === meId(C)) {      // the player's pay: a share of the salary, plus a result bonus
      row.earn = money((C.contracts[d]?.salary ?? 0) / roundsOf(C) + driverPay(t) * (0.02 + 0.02 * pts));
      C.me.money = money(C.me.money + row.earn); C.me.earned = money((C.me.earned ?? 0) + row.earn);
    }
    return row;
  });
  // the exact race, for replays (current season only)
  (C.replays ??= {})[`${r}:${t}`] = { ...cfg, calls };
  if (C.pending && C.pending.round === r) {
    C.pending.tiers = C.pending.tiers.filter((x) => x !== t);
    if (!C.pending.tiers.length) { C.pending = null; finishRound(db, C); }
  }
  return true;
}
function finishRound(db, C) {
  C.round++;
  if (C.round >= roundsOf(C)) C.phase = "review";
}
// tier standings for the current season
export function standings(C, t) {
  const rows = new Map(tierPairs(C, t).map((p) => [p, { p, pts: 0, wins: 0, pod: 0, fin: [], last: [] }]));
  C.results.forEach((rr) => {
    for (const x of rr?.[t] ?? []) {
      const s = rows.get(x.p); if (!s) continue;
      s.pts += x.pts; if (x.fin) { s.fin.push(x.pos); if (x.pos === 1) s.wins++; if (x.pos <= 3) s.pod++; }
      s.last.push(x.fin ? x.pos : "R");
    }
  });
  const cmp = (a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    for (let k = 1; k <= TIER_SIZE; k++) { const x = a.fin.filter((q) => q === k).length, y = b.fin.filter((q) => q === k).length; if (x !== y) return y - x; }
    return a.p - b.p;
  };
  return [...rows.values()].sort(cmp);
}
// season end: prizes, history, promotion/relegation, contracts, model drift, upgrade wear-off, next market
export function endSeason(db, C) {
  if (C.phase !== "review") throw new Error("season not finished");
  const T = nTiers(C);
  const tables = [];
  for (let t = 0; t < T; t++) {
    const st = standings(C, t);
    st.forEach((s, k) => {
      const prize = round1(tierPrize(t) * Math.max(0, TIER_SIZE - k) * 0.6);
      C.teams[C.pairs[s.p].ref].money = money(C.teams[C.pairs[s.p].ref].money + prize);
      s.prize = prize;
      if (C.mode === "driver" && driverOf(C, s.p) === meId(C)) {     // the player's season bonus: a share of the entry's prize
        const b = money(prize * ME_SEASON_SHARE);
        C.me.money = money(C.me.money + b); C.me.earned = money((C.me.earned ?? 0) + b);
        C.news.push({ season: C.season, text: `Season bonus: ${fmtMoney(b)} (P${k + 1} in Tier ${t + 1}).`, mine: true });
      }
    });
    tables.push(st.map((s, k) => ({ p: s.p, pos: k + 1, pts: s.pts, wins: s.wins, d: driverOf(C, s.p), model: C.pairs[s.p].model, prize: s.prize })));
    C.news.push({ season: C.season, text: `Tier ${t + 1} champion: ${pairName(C, st[0].p)} with ${dname(db, driverOf(C, st[0].p))}, ${st[0].pts} pts.` });
  }
  const moves = [];
  for (let t = 0; t < T - 1; t++) {
    const mv = Math.min(MOVE, tables[t + 1].length);          // a small last tier swaps as many as it has
    const down = tables[t].slice(-mv).map((x) => x.p), up = tables[t + 1].slice(0, mv).map((x) => x.p);
    for (const p of down) { C.pairs[p].tier = t + 1; moves.push({ p, from: t, to: t + 1 }); }
    for (const p of up) { C.pairs[p].tier = t; moves.push({ p, from: t + 1, to: t }); }
  }
  for (const m of moves) if (C.pairs[m.p].ref === C.player)
    C.news.push({ season: C.season, text: `${pairName(C, m.p)} ${m.to < m.from ? "promoted to" : "relegated to"} Tier ${m.to + 1}.`, mine: true });
  C.history.push({ season: C.season, tables, moves,
                   races: C.calendar.map((c, r) => ({ circuit: c.circuit, layout: c.layout ?? null, res: packCareer(C.results[r]) })) });
  if (C.mode === "driver") for (const m of moves) if (driverOf(C, m.p) === meId(C))
    C.news.push({ season: C.season, text: `Your entry, ${pairName(C, m.p)}, is ${m.to < m.from ? "promoted to" : "relegated to"} Tier ${m.to + 1}.`, mine: true });
  // contracts run down; expired ones end
  for (const [d, c] of Object.entries(C.contracts)) { c.left--; if (c.left <= 0) delete C.contracts[d]; }
  // model drift (up to one year either way within the decade); upgrades are kept
  for (const [k, pr] of C.pairs.entries()) {
    if (pr.ref !== C.player) {                       // the player's models change only by choice (setModel)
      const u = rngOf(C.seed, C.season, "drift", k)();
      const i = pr.years.indexOf(pr.model), j = Math.max(0, Math.min(pr.years.length - 1, i + (u < 1 / 3 ? -1 : u < 2 / 3 ? 0 : 1)));
      pr.model = pr.years[j];
    }
    pr.base = pr.model;                              // this offseason's starting model: a move is up to one year from it
  }
  C.season++; C.phase = "market"; C.round = 0; C.results = []; C.replays = {}; C.pending = null;
  rollCalendar(db, C);
  startMarket(db, C);
}

// ---------- the player's model choice (offseason only, up to one model year from the season's car) ----------
export function modelChoices(C, p) {
  const pr = C.pairs[p], i = pr.years.indexOf(pr.base ?? pr.model);
  return pr.years.slice(Math.max(0, i - 1), i + 2);
}
export function setModel(C, p, year) {
  const pr = C.pairs[p];
  if (C.phase !== "market" || pr.ref !== C.player || !modelChoices(C, p).includes(year)) return false;
  pr.model = year;
  return true;
}

// ---------- upgrades ----------
export function buyUpgrade(C, p, stat) {
  const pr = C.pairs[p], cost = upgradeCost(pr, stat), team = C.teams[pr.ref];
  if (cost === null || team.money < cost) return false;
  team.money = money(team.money - cost); pr.up[stat]++;
  return true;
}
// ---------- save files ----------
export function serialize(C) { return JSON.stringify({ kind: "fantasy-gp-career", ...C }); }
export function deserialize(db, text) {
  const C = JSON.parse(text);
  if (C.kind !== "fantasy-gp-career" || !Array.isArray(C.pairs) || !C.teams) throw new Error("not a Fantasy GP career save");
  delete C.kind;
  // older saves ran 16-round seasons: cut the calendar to ROUNDS (a season already past that ends now)
  if (C.calendar.length > ROUNDS) {
    const played = C.phase === "season" ? C.round + (C.pending ? 1 : 0) : 0;
    C.calendar = C.calendar.slice(0, Math.max(ROUNDS, played));
    if (C.phase === "season" && !C.pending && C.round >= C.calendar.length) C.phase = "review";
  }
  const ix = index(db);
  attachMe(db, C);
  repairCars(db, C);
  for (const pr of C.pairs) if (!ix.carAt.has(`${pr.ref}|${pr.model}`)) throw new Error(`unknown car ${pr.ref} ${pr.model}`);
  repairDrivers(db, C);
  return C;
}
// makes a data update renamed (goldenera spellings merged): old team ref -> new
const REF_ALIAS = { pw_itala_spl: "pw_itala_special", pw_itala_spcl: "pw_itala_special" };
// entries whose car the database no longer has: a renamed make takes its new name (the save's team record moves
// with it); a missing year takes the make's nearest year in the entry's decade. Returns what changed.
export function repairCars(db, C) {
  const ix = index(db), fixed = [];
  const yearsOf = (ref) => [...ix.carAt.keys()].filter((k) => k.startsWith(ref + "|")).map((k) => Number(k.split("|")[1]));
  for (const pr of C.pairs) {
    if (ix.carAt.has(`${pr.ref}|${pr.model}`)) continue;
    const to = REF_ALIAS[pr.ref];
    if (to && !yearsOf(pr.ref).length) {
      if (C.teams[pr.ref] && !C.teams[to]) C.teams[to] = C.teams[pr.ref];
      if (C.player === pr.ref) C.player = to;
      fixed.push(`${pr.ref} -> ${to}`);
      pr.ref = to; pr.id = `${to}|${pr.dec}`;
    }
    const ys = yearsOf(pr.ref);
    if (!ys.length || ys.includes(pr.model)) continue;
    const near = (y) => ys.reduce((a, b) => (Math.abs(b - y) < Math.abs(a - y) ? b : a));
    const inDec = ys.filter((y) => Math.floor(y / 10) === Math.floor(pr.model / 10));
    const ny = inDec.length ? inDec.reduce((a, b) => (Math.abs(b - pr.model) < Math.abs(a - pr.model) ? b : a)) : near(pr.model);
    fixed.push(`${pr.ref} ${pr.model} -> ${ny}`);
    pr.years = [...new Set([...pr.years.filter((y) => ys.includes(y)), ny])].sort((a, b) => a - b);
    pr.model = ny; if (!ys.includes(pr.base)) pr.base = ny;
  }
  if (fixed.length) (C.news ??= []).push({ season: C.season, text: `Data update: ${fixed.join(", ")}.` });
  return fixed;
}
// drivers the save names but the database no longer has (a data update can drop or renumber drivers): free their
// seats. In the market the seat reopens; mid-season the strongest free driver takes it on the same deal.
export function repairDrivers(db, C) {
  const ix = index(db), ok = (d) => ix.drivers.has(String(d));
  const fixed = [];
  const M = C.market;
  if (M) {
    for (const d of Object.keys(M.held ?? {})) if (!ok(d)) { delete M.held[d]; fixed.push(d); }
    for (const d of Object.keys(M.rejected ?? {})) if (!ok(d)) delete M.rejected[d];
    for (const [p, u] of Object.entries(M.userOffers ?? {})) if (!ok(u.driver)) delete M.userOffers[p];
  }
  const gone = Object.keys(C.contracts).filter((d) => !ok(d));
  for (const d of gone) {
    const c = C.contracts[d];
    delete C.contracts[d];
    fixed.push(d);
    if (M) continue;                                             // the market fills the seat
    const busy = new Set(Object.keys(C.contracts));
    let best = null;
    for (const [x, pk] of ix.peaks) if (!busy.has(x) && x !== meId(C) && ok(x) && (!best || pk.score < ix.peaks.get(best).score)) best = x;   // lower = faster
    if (best) { C.contracts[best] = { ...c }; C.news.push({ season: C.season, text: `${dname(db, best)} takes over a seat at ${pairName(C, c.pair)} (data update).` }); }
  }
  if (M) updateOpen(C, db);
  return fixed;
}

// ---------- driver career ----------
export const ME_ID = 990001;                  // the player's driver id (outside the real ids)
export const ME_START_MONEY = 3;              // $M
const ME_SEASON_SHARE = 0.25;                 // share of the entry's season prize paid to its driver
// driver pay by tier: flatter than team prizes, so a driver in a low tier can still afford to improve
export const driverPay = (t) => 4 * 0.75 ** t;
export const SKILL_MAX = 10;
// the player's skills: dir -1 = lower is better; w = cost weight ($M scale of a level)
export const SKILL_UP = {
  pace: { label: "Pace", dir: -1, w: 1.5, hint: "race lap time" },
  quali: { label: "Qualifying", dir: -1, w: 1.0, hint: "one-lap speed" },
  starts: { label: "Starts", dir: 1, w: 0.5, hint: "places gained on lap 1" },
  deg: { label: "Tyre management", dir: -1, w: 0.6, hint: "tyre wear" },
  consistency: { label: "Consistency", dir: -1, w: 0.8, hint: "lap-to-lap spread" },
  wet: { label: "Wet weather", dir: -1, w: 0.5, hint: "pace in the rain" },
  errors: { label: "Mistakes", dir: -1, w: 0.8, hint: "spins, offs and crashes" },
  attack: { label: "Overtaking", dir: 1, w: 0.6, hint: "passing" },
  defence: { label: "Defending", dir: 1, w: 0.6, hint: "holding position" },
};
// level 0..10 -> share of the real drivers (at their peak) that the player beats in that skill. Level 0 is just
// short of a seat (117 seats for ~570 drivers); level 10 is the best of all time.
export const skillPct = (L) => 0.7 + 0.03 * L;
export const skillCost = (k, L) => (L >= SKILL_MAX ? null : money(SKILL_UP[k].w * (0.4 + 0.3 * L)));
export const meId = (C) => (C?.mode === "driver" ? C.me.id : null);
// the player's seat this season (contract), or null
export function myPair(C) { const c = C.contracts[meId(C)]; return c ? c.pair : null; }
function skillValue(db, k, L) {
  const q = index(db).qs[k];
  if (!q.length) return 0;
  return q[Math.round((1 - skillPct(L)) * (q.length - 1))];
}
function meSkills(db, C) {
  const ix = index(db);
  return Object.fromEntries(SKILLS.map((k) => [k, [skillValue(db, k, C.me.lv[k] ?? 0), 0.5 * ix.sds[k]]]));
}
function mePeak(db, d, year) {
  const p = d.seasons[year].skills.pace, score = p[0] + p[1];
  return { year, score, pace: p[0], rating: ratingOf(score, index(db).sMin) };
}
// put the player's driver into the database (sim index and career index); remove any earlier one
export function attachMe(db, C) {
  detachMe(db);
  if (C?.mode !== "driver") return;
  indexDb(db); const ix = index(db);              // population means and quantiles without the player
  const year = C.rulesYear;
  const d = { id: ME_ID, ref: "player", name: C.me.name, code: C.me.code || C.me.name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase(),
              nationality: "", helmet: null, player: true, seasons: { [year]: { car: null, skills: meSkills(db, C) } } };
  db.drivers.push(d);
  db._ix.drivers.set(ME_ID, d);
  ix.drivers.set(String(ME_ID), d);
  ix.peaks.set(String(ME_ID), mePeak(db, d, year));
}
export function detachMe(db) {
  if (!db.drivers.some((d) => d.id === ME_ID)) return;
  db.drivers = db.drivers.filter((d) => d.id !== ME_ID);
  db._ix?.drivers.delete(ME_ID);
  db._career?.drivers.delete(String(ME_ID));
  db._career?.peaks.delete(String(ME_ID));
}
export function buySkill(db, C, k) {
  const cost = skillCost(k, C.me.lv[k] ?? 0);
  if (cost === null || C.me.money < cost - 1e-9) return false;
  C.me.money = money(C.me.money - cost); C.me.lv[k] = (C.me.lv[k] ?? 0) + 1;
  const d = index(db).drivers.get(C.me.id);
  d.seasons[C.rulesYear].skills = meSkills(db, C);
  index(db).peaks.set(C.me.id, mePeak(db, d, C.rulesYear));
  return true;
}
// salary an entry offers the player ($M a season): its tier's money, more for a better driver
export function salaryOf(db, C, p) {
  const ix = index(db), me = ix.peaks.get(meId(C));
  if (!me) return 0;
  const all = [...ix.peaks.values()].map((x) => x.score);
  const f = all.filter((x) => x > me.score).length / all.length;       // share of drivers the player beats
  return money(0.5 + driverPay(C.pairs[p].tier) * (1 + 3 * f * f));
}
export function acceptOffer(db, C, k) {
  const M = C.market, me = meId(C), o = M?.myOffers[k];
  if (!o) return false;
  const h = M.held[me], prev = h ? h.pair : null;
  M.held[me] = { pair: o.pair, years: o.years, salary: o.salary, ...(prev === o.pair ? { ext: true } : {}) };
  if (prev !== null && prev !== o.pair) (M.rejected[me] ??= []).push(prev);
  for (const [j, x] of M.myOffers.entries()) if (j !== k && !x.ext) (M.rejected[me] ??= []).push(x.pair);
  M.myOffers = [];
  log(C, `You sign for ${pairName(C, o.pair)} (${o.years} season${o.years === 1 ? "" : "s"}, ${fmtMoney(o.salary)} a season)` +
    (prev !== null && prev !== o.pair ? `, leaving ${pairName(C, prev)}.` : "."), true);
  updateOpen(C, db);
  return true;
}
export function declineOffer(C, k) {
  const M = C.market, o = M?.myOffers[k];
  if (!o) return false;
  if (!o.ext) (M.rejected[meId(C)] ??= []).push(o.pair);
  M.myOffers.splice(k, 1);
  log(C, `You turn down ${pairName(C, o.pair)}.`, true);
  return true;
}
// the market is done and nobody signed the player: the weakest-held seat in the lowest tier goes to the player
// for a season (its signing loses the drive), so the player always races
function seatForMe(db, C) {
  const me = meId(C), M = C.market;
  if (!me || M.held[me] || firm(C, me)) return;
  for (let t = nTiers(C) - 1; t >= 0; t--) {
    const cand = tierPairs(C, t).map((p) => [p, Object.keys(M.held).find((d) => M.held[d].pair === p && !M.held[d].own)])
      .filter(([, d]) => d);
    if (!cand.length) continue;
    const [p, d] = cand.reduce((a, b) => (index(db).peaks.get(b[1]).score > index(db).peaks.get(a[1]).score ? b : a));
    delete M.held[d];
    M.held[me] = { pair: p, years: 1, salary: salaryOf(db, C, p) };
    log(C, `No offer suited you: ${pairName(C, p)} gives you a one-season drive in place of ${dname(db, d)}.`, true);
    return;
  }
}
