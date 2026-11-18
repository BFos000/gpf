// Real Seasons mode engine (no DOM). A new mode beside the career; its own state and saves ("fantasy-gp-real").
//
// - Starts in a chosen season (the earliest by default) and runs the real seasons in order: each season's real
//   teams with their real cars, on the real calendar (trimmed to the player's maximum season length by cutting the
//   least iconic rounds first). The real championship points system of the year.
// - Drivers carry their real age. A driver's form in a season they really raced is that season's rating; in any
//   other season (after they stopped in real life, or a gap year) it is their nearest real season moved along the
//   age curve. Drivers enter the market in their real debut season.
// - The driver market is open every offseason (rounds of offers; each driver takes the best car offered).
//   The first season starts from the real line-ups.
// - Retirement: never before the driver's real last season. After it, at the end of a contract a driver retires
//   around 40: later while still quick against the field, in a good car, or near their best form; sooner when
//   they have dropped off. A free agent past their real career nobody signs for a few seasons stops too.
// - The player runs a real team or their own team, or is a real driver or their own driver (skills bought as in
//   the career). CPU teams don't upgrade. The player's team buys upgrades: a real team's car gets the career's
//   per-level gains; an own team's car goes from a little worse than the usual worst car of the era (level 0) to
//   as dominant as the best cars ever were in their seasons (all levels).
import { packReal } from "./archive.js";
import { eraCarScale } from "./sim/race.js";
import { SKILLS } from "./sim/db.js";
import * as G from "./programme.js";
import { UPGRADES, upgradeEffect, upgradeCost as kUpgradeCost, SKILL_UP, skillCost, skillPct, index as kIndex, iconicOf, seedOf } from "./career.js";
import { migrate as migrateLivery, teamColours } from "./livery2/migrate.js";

export const KIND = "fantasy-gp-real";
export const ME_RS = 990002;                 // the player's own driver (outside real ids, and not the career's)
export const CUSTOM = "rs_custom";           // the player's own team (car ids rs_custom_<year>)
export const START_MONEY = { real: 15, custom: 25, driver: 3 };
export const CONTRACT = { min: 1, max: 4 };
export const PLAYER_SEATS = 2;               // the custom team: two cars every season
// retirement after the real career: the age it centres on (half retire at a contract's end there, an average driver),
// the spread in years, the push of pace lost from their best (beyond the usual `drop0`, per `drop`, pace %), of their
// place in the field's pace and of their team's in the constructors' (each from the middle to the end), the age no
// one races past, and the seasons unsigned before a free agent stops (by age: under 30, 34, 38, older)
const RETIRE = { age: 40.5, spread: 1.6, drop0: 0.2, drop: 0.4, wDrop: 1, wField: 3, wTeam: 1.4, hard: 48, unsigned: [4, 3, 2, 1] };
const SCOUT_SD = 0.1;
const FULL_SCALED = -2.8;                    // fully upgraded own car, era-scaled (the best cars ever: -2.7 to -3.3)
const BASE_MARGIN = 0.2;                     // level-0 own car: this much behind the era's usual worst car
const money = (x) => Math.round(x * 100) / 100;
export const fmtM = (x) => `$${(Math.round(x * 10) / 10).toFixed(1)}M`;
const PRIZE_PTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];        // prize money scale (any era)

export function pointsFor(y) {
  if (y <= 1959) return [8, 6, 4, 3, 2];
  if (y === 1960) return [8, 6, 4, 3, 2, 1];
  if (y <= 1990) return [9, 6, 4, 3, 2, 1];
  if (y <= 2002) return [10, 6, 4, 3, 2, 1];
  if (y <= 2009) return [10, 8, 6, 5, 4, 3, 2, 1];
  return [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
}

function rngOf(...xs) {
  let a = seedOf(...xs);
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (R) => Math.sqrt(-2 * Math.log(R() + 1e-12)) * Math.cos(2 * Math.PI * R());

// ---------- derived tables ----------
export function rsIndex(db) {
  if (db._rs) return db._rs;
  const rs = db.realSeasons;
  if (!rs) throw new Error("real season data not loaded");
  const years = Object.keys(rs.seasons).map(Number).sort((a, b) => a - b);
  const cars = new Map(db.cars.map((c) => [c.id, c]));
  const drivers = new Map(db.drivers.map((d) => [d.id, d]));
  // each driver's real seasons, first season, birth (dob; else first season - 24)
  const info = new Map();
  for (const d of db.drivers) {
    const ys = Object.keys(d.seasons).map(Number).filter((y) => d.seasons[y]?.skills?.pace).sort((a, b) => a - b);
    if (!ys.length) continue;
    const birth = d.dob ? Number(d.dob.slice(0, 4)) + (Number(d.dob.slice(5, 7)) - 1) / 12 : ys[0] - 24;
    info.set(d.id, { ys, first: ys[0], birth, dobKnown: !!d.dob });
  }
  // own-car scale by year: level 0 = smoothed worst car of the season fields + margin; full = era-scaled best ever
  const worst = new Map();
  for (const y of years) {
    const ps = rs.seasons[y].teams.map((t) => cars.get(t.car)?.pace).filter((x) => x != null);
    if (ps.length) worst.set(y, Math.max(...ps));
  }
  const base = new Map(), full = new Map();
  for (const y of years) {
    const w = years.filter((z) => Math.abs(z - y) <= 4 && worst.has(z)).map((z) => worst.get(z)).sort((a, b) => a - b);
    // the usual worst car around this season; a season with an unusually bad car doesn't drag the player down to it
    base.set(y, Math.min(w[Math.floor(w.length / 2)], worst.get(y) ?? Infinity) + BASE_MARGIN);
    full.set(y, FULL_SCALED / eraCarScale(y));
  }
  const age = rs.age;
  db._rs = { rs, years, cars, drivers, info, base, full, age };
  return db._rs;
}
export const seasonYears = (db) => rsIndex(db).years;
export const nextYear = (db, y) => rsIndex(db).years.find((z) => z > y) ?? null;

export function ageCurve(db, a) {
  const { ages, pace } = rsIndex(db).age;
  const x = Math.max(ages[0], Math.min(ages.at(-1), a));
  const i = Math.min(ages.length - 2, Math.floor(x - ages[0])), f = x - ages[0] - i;
  return pace[i] * (1 - f) + pace[i + 1] * f;
}
// birth years: real, or shuffled ("shuffled": every driver gets another driver's birth year, a whole number of years
// away; their career moves with it, so a real season is played at the same age: S.shift[id] = years moved)
export const shiftOf = (S, id) => S?.shift?.[id] ?? 0;
export function shuffledShift(db, seed) {
  const ix = rsIndex(db), ids = [...ix.info.keys()].sort((a, b) => a - b), R = rngOf(seed, "births");
  const births = ids.map((id) => ix.info.get(id).birth);
  for (let i = births.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [births[i], births[j]] = [births[j], births[i]]; }
  const shift = {};
  ids.forEach((id, k) => { const s = Math.round(births[k] - ix.info.get(id).birth); if (s) shift[id] = s; });
  return shift;
}
export const birthOf = (db, S, id) => { const i = rsIndex(db).info.get(Number(id)); return i ? i.birth + shiftOf(S, Number(id)) : null; };
export const debutOf = (db, S, id) => { const i = rsIndex(db).info.get(Number(id)); return i ? i.first + shiftOf(S, Number(id)) : null; };
// the last season the driver really raced (moved with shuffled births)
export const lastOf = (db, S, id) => { const i = rsIndex(db).info.get(Number(id)); return i ? i.ys[i.ys.length - 1] + shiftOf(S, Number(id)) : null; };
export const ageIn = (db, id, y, S = null) => { const b = birthOf(db, S, id); return b == null ? null : y + 0.5 - b; };

// a driver's form in season y: the real season, or their nearest real season moved along the age curve
export function formOf(db, S, id, y) {
  id = Number(id);
  if (id === ME_RS) return meSeason(db, S);
  const ix = rsIndex(db), d = ix.drivers.get(id), inf = ix.info.get(id);
  if (!d || !inf) return null;
  y -= shiftOf(S, id);                              // shuffled births: the real season at the same age
  if (d.seasons[y]?.skills?.pace) return d.seasons[y];
  const near = inf.ys.reduce((a, b) => (Math.abs(b - y) < Math.abs(a - y) ? b : a));
  const s = d.seasons[near];
  const dAge = ageCurve(db, y + 0.5 - inf.birth) - ageCurve(db, near + 0.5 - inf.birth);
  const sk = { ...s.skills };
  for (const k of ["pace", "quali"]) if (sk[k]) sk[k] = [sk[k][0] + dAge, sk[k][1]];
  return { ...s, skills: sk, aged: near };
}
export const paceOf = (db, S, id, y) => formOf(db, S, id, y)?.skills?.pace?.[0] ?? 9;

// ---------- the player's own driver (skills bought as in the career) ----------
function skillValue(db, k, L) {
  const q = kIndex(db).qs[k];
  return q.length ? q[Math.round((1 - skillPct(L)) * (q.length - 1))] : 0;
}
function meSeason(db, S) {
  const ix = kIndex(db);
  return { car: null, skills: Object.fromEntries(SKILLS.map((k) => [k, [skillValue(db, k, S.me.lv[k] ?? 0), 0.5 * ix.sds[k]]])) };
}
// the player's driver in the sim's tables (a driver record; its season comes with each entry)
export function attachMe(db, S) {
  detachMe(db);
  if (!S?.me) return;
  const d = { id: ME_RS, ref: "player_rs", name: S.me.name, code: S.me.code, nationality: "", helmet: null, player: true,
              seasons: { [S.year]: meSeason(db, S) } };
  db.drivers.push(d);
  db._ix?.drivers.set(ME_RS, d);
  rsIndex(db).drivers.set(ME_RS, d);
}
export function detachMe(db) {
  if (!db.drivers.some((d) => d.id === ME_RS)) return;
  db.drivers = db.drivers.filter((d) => d.id !== ME_RS);
  db._ix?.drivers.delete(ME_RS);
  db._rs?.drivers.delete(ME_RS);
}
export function buySkill(db, S, k) {
  const cost = skillCost(k, S.me.lv[k] ?? 0);
  if (cost === null || S.me.money < cost - 1e-9) return false;
  S.me.money = money(S.me.money - cost); S.me.lv[k] = (S.me.lv[k] ?? 0) + 1;
  attachMe(db, S);
  return true;
}

// ---------- the player's own team: a car per season, registered in the DB so the sim and viewer find it ----------
export const customCarId = (y) => `${CUSTOM}_${y}`;
export function attachCustomCar(db, S) {
  detachCustomCar(db);
  if (S?.player?.team !== CUSTOM) return;
  const ix = rsIndex(db), y = S.year;
  const field = ix.rs.seasons[y].teams.map((t) => ix.cars.get(t.car)).filter(Boolean);
  const med = (k) => { const v = field.map((c) => c[k]).filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const car = { id: customCarId(y), ref: CUSTOM, name: S.custom.name, year: y, pace: ix.base.get(y), pace_sd: 0, n_races: 99,
                deg_rel: 0, p_mech_lap: (med("p_mech_lap") ?? 0.002) * 1.15, colours: S.custom.colours, livery: S.custom.livery ?? null,
                custom: true };
  db.cars.push(car);
  db._ix?.cars.set(car.id, car);
  ix.cars.set(car.id, car);
}
export function detachCustomCar(db) {
  const gone = db.cars.filter((c) => c.ref === CUSTOM).map((c) => c.id);
  if (!gone.length) return;
  db.cars = db.cars.filter((c) => c.ref !== CUSTOM);
  for (const id of gone) { db._ix?.cars.delete(id); db._rs?.cars.delete(id); }
}

// the own team's livery: a livery v2 element design (gfx/livery2; plain colours until the player paints it). Saves
// from before v2 hold a v1 kit spec: converted on load (migrate.js), the original kept as custom.livery_v1.
export const liveryV2 = (lv) => migrateLivery(lv);
export function defaultLivery(colours = ["#2a7fff", "#ffffff"]) {
  return { v: 2, colors: { a: colours[0], b: colours[1], c: colours[1], d: "#141414" }, finish: "gloss",
           number: { text: "1", style: "roundel", panel: "#f4f4f4", digits: "#141414", font: "classic" }, sponsors: [] };
}
export function setLivery(db, S, lv) {
  lv = migrateLivery(lv);
  if (S?.player?.team !== CUSTOM || !lv?.colors?.a) return false;
  S.custom.livery = JSON.parse(JSON.stringify(lv));
  S.custom.colours = teamColours(lv);
  attachCustomCar(db, S);
  return true;
}

// ---------- teams, cars ----------
export const teamOf = (S, ref) => S.teams.find((t) => t.ref === ref) ?? null;
export const isMine = (S, ref) => S.mode === "team" && S.player.team === ref;
export function upMod(db, S, ref) {
  if (!isMine(S, ref)) return null;
  const u = S.up, y = S.year, ix = rsIndex(db);
  const pace = ref === CUSTOM ? (ix.full.get(y) - ix.base.get(y)) * u.pace / UPGRADES.pace.max : upgradeEffect("pace", u.pace);
  return { pace, deg: upgradeEffect("deg", u.deg), rel: upgradeEffect("rel", u.rel) };
}
// a team's car pace this season (field-relative % of lap, lower = faster), with the player's upgrades
export function carPace(db, S, ref) {
  const t = teamOf(S, ref); if (!t) return 9;
  if (isMine(S, ref) && S.prog) return progPace(db, S);
  return (rsIndex(db).cars.get(t.car)?.pace ?? 9) + (upMod(db, S, ref)?.pace ?? 0);
}
export const upgradeCost = (S, stat) => kUpgradeCost({ up: S.up }, stat);
export function buyUpgrade(db, S, stat) {
  const c = upgradeCost(S, stat);
  if (S.mode !== "team" || c === null || S.money < c - 1e-9) return false;
  S.money = money(S.money - c); S.up[stat]++;
  return true;
}
// ---------- the constructor programme (team mode): the player's car comes from departments and people ----------
// docs/TEAM_PROGRAMME.md. S.prog is the programme state (programme.js); CPU teams race their real cars.
const r2 = (x) => Math.round(x * 100) / 100;
export const fieldOf = (db, y) => G.fieldOf(db, y);
// the default setup for a new team: a real team starts where its real car stood; the custom team as a privateer
export function progDefaults(db, ref, y) {
  if (ref === CUSTOM || !ref) return { ...G.PRESETS.privateer, preset: "privateer", patience: 2, mentees: true };
  const ix = rsIndex(db), t = ix.rs.seasons[y].teams.find((x) => x.ref === ref), car = ix.cars.get(t?.car);
  const f = G.fieldOf(db, y), base = G.presetForCar(f, car?.pace ?? f.med, y);
  const c = G.calibrate(base, y, base.target);
  return { ...c, preset: "real", staff: Math.round(c.staff), fac: Math.round(c.fac), know: Math.round(c.know), patience: 2, mentees: true };
}
export const presetCfg = (db, ref, y, p) => (p === "real" ? progDefaults(db, ref, y) : { ...G.PRESETS[p], preset: p, patience: 2, mentees: true,
  ...(ref !== CUSTOM && ref ? { target: progDefaults(db, ref, y).target } : {}) });
// the player's car this round, as sim modifiers on top of the team's listed car (real or custom)
export function progMod(db, S, ref, r = S.round) {
  if (!isMine(S, ref) || !S.prog?.car) return null;
  const y = S.year, t = teamOf(S, ref), car = rsIndex(db).cars.get(t?.car), f = G.fieldOf(db, y);
  const sc = G.simCar(S.prog, y, r, S.calendar.length || 1, f, G.powerCap(db, y));
  const pm = car?.p_mech_lap ?? f.mechMed;
  return { pace: r2(sc.pace - (car?.pace ?? f.med)), rel: r2(sc.mod.rel * f.mechMed / pm), deg: sc.mod.deg, degRel: f.degMed ?? 0,
           lean: r2(sc.mod.lean - (car?.power_lean ?? 0)), quali: sc.mod.quali, pitS: sc.mod.pitS, read: sc.mod.read };
}
// an old save's team (upgrade levels, money in $M) as a programme: calibrated so its car matches the car it had,
// upgrades included; money becomes cash
function migrateProg(db, S) {
  const ref = S.player.team, y = S.year, f = G.fieldOf(db, y);
  const pace = (rsIndex(db).cars.get(teamOf(S, ref)?.car)?.pace ?? f.med) + (upMod(db, S, ref)?.pace ?? 0);
  const base = G.presetForCar(f, pace, y), c = G.calibrate(base, y, base.target, S.seed);
  const P = G.newProgramme({ ...c, staff: Math.round(c.staff), fac: Math.round(c.fac), know: Math.round(c.know), patience: 2, mentees: true }, y, S.seed);
  P.cash = Math.round(Math.max(0, S.money ?? 0) * 200) / 100;
  P.mig = 2;
  if (S.phase === "season" || S.phase === "review") G.buildCar(P, y);
  return P;
}
// the player's car pace (offseason: the projection's expected index)
function progPace(db, S) {
  const f = G.fieldOf(db, S.year), P = S.prog;
  const idx = P.car ? G.indexAt(P, S.round, S.calendar.length || 1) : G.projection(P, S.year).mu;
  return f.med - (idx - 50) / 25 * f.spread;
}
function seasonTeams(db, S, y) {
  const ix = rsIndex(db);
  // real teams run their real number of cars (one to three), whoever controls them; the custom team runs two
  const ts = ix.rs.seasons[y].teams.map((t) => ({ ref: t.ref, name: t.name, car: t.car, seats: t.seats }));
  if (S.player?.team === CUSTOM) ts.push({ ref: CUSTOM, name: S.custom.name, car: customCarId(y), seats: PLAYER_SEATS });
  return ts;
}
// the real calendar, trimmed to maxRounds by cutting the least iconic rounds (ties: the later round goes first)
export function seasonCalendar(db, y, maxRounds = 0) {
  const rounds = rsIndex(db).rs.seasons[y].rounds.map((r, i) => ({ ...r, i }));
  if (!maxRounds || rounds.length <= maxRounds) return rounds;
  const keep = [...rounds].sort((a, b) => iconicOf(db, b.layout) - iconicOf(db, a.layout) || a.i - b.i).slice(0, maxRounds);
  return rounds.filter((r) => keep.includes(r));
}

// ---------- new game ----------
// the season-length limit, changeable in any offseason: applies to the coming season's calendar (not yet raced)
// a team's car in a past season (history rows saved before cars were recorded)
export function carIn(db, ref, year) {
  if (ref === CUSTOM) return customCarId(year);
  return db.realSeasons?.seasons?.[year]?.teams.find((t) => t.ref === ref)?.car ?? null;
}
export function setMaxRounds(db, S, n) {
  S.maxRounds = Math.max(0, Math.min(40, Math.floor(Number(n) || 0)));
  if (S.phase === "market") S.calendar = seasonCalendar(db, S.year, S.maxRounds);
  return S.phase === "market";
}
// opts: { seed, startYear, maxRounds, mode: "team"|"driver", team: ref | CUSTOM, custom: {name, colours},
//         driver: real id | null (own driver: me = {name, code, helmet}) }
export function newGame(db, o) {
  const ix = rsIndex(db);
  const startYear = ix.years.includes(o.startYear) ? o.startYear : ix.years[0];
  const S = {
    kind: KIND, v: 1, seed: o.seed ?? 1, startYear, year: startYear, maxRounds: o.maxRounds ?? 0,
    mode: o.mode === "driver" ? "driver" : "team",
    player: o.mode === "driver" ? { driver: o.me ? ME_RS : Number(o.driver) } : { team: o.team },
    custom: o.team === CUSTOM ? { name: String(o.custom?.name || "My Team").slice(0, 30), livery: migrateLivery(o.custom?.livery) ?? defaultLivery(o.custom?.colours),
                                  colours: o.custom?.livery ? teamColours(o.custom.livery) : o.custom?.colours ?? ["#2a7fff", "#ffffff"] } : null,
    me: o.me ? { name: String(o.me.name).slice(0, 40), code: String(o.me.code ?? "").toUpperCase().slice(0, 3) || String(o.me.name).replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase(),
                 helmet: o.me.helmet ?? null, lv: Object.fromEntries(SKILLS.map((k) => [k, 0])), money: START_MONEY.driver, earned: 0 } : null,
    money: o.team === CUSTOM ? START_MONEY.custom : START_MONEY.real, up: { pace: 0, deg: 0, rel: 0 }, prog: null,
    births: o.births === "shuffled" ? "shuffled" : "real", shift: o.births === "shuffled" ? shuffledShift(db, o.seed ?? 1) : {},
    phase: "market", teams: [], contracts: {}, retired: {}, unsigned: {}, best: {},
    calendar: [], round: 0, results: [], history: [], news: [], market: null,
  };
  if (S.mode === "team" && S.player.team !== CUSTOM && !ix.rs.seasons[startYear].teams.some((t) => t.ref === S.player.team))
    throw new Error("that team did not race in the starting season");
  S.teams = seasonTeams(db, S, startYear);
  if (S.mode === "team") S.prog = G.newProgramme(o.prog ?? progDefaults(db, S.player.team, startYear), startYear, S.seed);
  attach(db, S);
  // the real line-ups (each driver once; contracts of 1-3 seasons); shuffled births: every seat starts open
  const R = rngOf(S.seed, "lineups");
  const taken = new Set();
  for (const t of S.births === "shuffled" ? [] : S.teams) {
    if (t.ref === CUSTOM) continue;
    const real = ix.rs.seasons[startYear].teams.find((x) => x.ref === t.ref)?.drivers ?? [];
    for (const d of real) {
      if (seated(S, t.ref) >= t.seats) break;
      if (taken.has(d) || !ix.info.has(d) || d === S.player.driver && S.me) continue;
      taken.add(d);
      S.contracts[d] = { team: t.ref, left: 1 + Math.floor(R() * 3) };
    }
  }
  if (S.mode === "driver" && !S.me) delete S.contracts[S.player.driver];   // the player's driver chooses their own team
  S.calendar = seasonCalendar(db, startYear, S.maxRounds);
  startMarket(db, S);
  return S;
}
function attach(db, S) { attachMe(db, S); attachCustomCar(db, S); }

// ---------- market ----------
const seated = (S, ref) => Object.values(S.contracts).filter((c) => c.team === ref).length;
export const heldBy = (S, ref) => Object.keys(S.market?.held ?? {}).filter((d) => S.market.held[d].team === ref);
export function openSeats(S, ref) { const t = teamOf(S, ref); return t ? t.seats - seated(S, ref) - heldBy(S, ref).length : 0; }
export const driverName = (db, id) => (Number(id) === ME_RS ? null : rsIndex(db).drivers.get(Number(id))?.name) ?? "—";
const name = (db, S, id) => (Number(id) === ME_RS ? S.me.name : driverName(db, id));
const playerDriver = (S) => (S.mode === "driver" ? String(S.player.driver) : null);
function log(S, text, mine = false) { S.market.log.push({ r: S.market.round, text, mine }); }
// drivers available this offseason: debuted by now, not retired, not under contract
export function pool(db, S) {
  const ix = rsIndex(db), y = S.year, out = [];
  for (const [id, inf] of ix.info) {
    const k = String(id);
    const sh = shiftOf(S, id);
    if (inf.first + sh > y || S.retired[k] || S.contracts[k]) continue;
    if (y + 0.5 - inf.birth - sh > 60) continue;
    out.push(k);
  }
  if (S.me && !S.contracts[String(ME_RS)]) out.push(String(ME_RS));
  return out;
}
function startMarket(db, S) {
  S.market = { round: 0, held: {}, rejected: {}, userOffers: {}, myOffers: [], log: [], done: false };
  S.phase = "market";
  log(S, `Offseason before ${S.year}: ${S.teams.length} teams, ${S.teams.reduce((s, t) => s + t.seats, 0)} seats.`);
  updateDone(db, S);
}
function updateDone(db, S) {
  S.market.done = S.teams.every((t) => openSeats(S, t.ref) <= 0);
}
// how a CPU team rates a driver (lower is better): this season's pace, with that team's scouting error
function scouted(db, S, ref, d) {
  const e = gauss(rngOf(S.seed, S.year, "scout", ref, d)) * SCOUT_SD;
  return paceOf(db, S, d, S.year) + e;
}
// what a driver thinks of a team's car (lower is better)
const carValue = (db, S, ref) => carPace(db, S, ref);
function contractYears(db, S, d) {
  const a = ageIn(db, d, S.year, S) ?? 28, u = rngOf(S.seed, S.year, "len", d)();
  const max = a >= 36 ? 2 : a >= 32 ? 3 : CONTRACT.max;
  return Math.max(CONTRACT.min, Math.min(max, 1 + Math.floor(u * max)));
}
export function salaryOf(db, S, ref) {
  const order = [...S.teams].sort((a, b) => carPace(db, S, a.ref) - carPace(db, S, b.ref)).map((t) => t.ref);
  const f = 1 - order.indexOf(ref) / Math.max(1, order.length - 1);
  return money(0.5 + 3 * f * f);
}
// would driver d sign for team ref now? (not turned it down already, and no faster car held)
export function wouldSign(db, S, d, ref) {
  const M = S.market;
  if (!M || (M.rejected[d] ?? []).includes(ref) || M.held[d]?.team === ref) return false;
  return !M.held[d] || carValue(db, S, M.held[d].team) > carValue(db, S, ref);
}
// a driver takes an offer: the best car, unless the player answers for their own driver
function consider(db, S, d, ref, years) {
  const M = S.market, h = M.held[d];
  if (d === playerDriver(S)) {
    if (!M.myOffers.some((o) => o.team === ref)) {
      M.myOffers.push({ team: ref, years, salary: salaryOf(db, S, ref) });
      log(S, `${teamOf(S, ref).name} offers you ${years} season${years === 1 ? "" : "s"} at ${fmtM(salaryOf(db, S, ref))} a season.`, true);
    }
    return false;
  }
  if (h && carValue(db, S, h.team) <= carValue(db, S, ref)) {
    (M.rejected[d] ??= []).push(ref);
    if (isMine(S, ref)) log(S, `${name(db, S, d)} turns you down (stays with ${teamOf(S, h.team).name}).`, true);
    return false;
  }
  if (h) {
    (M.rejected[d] ??= []).push(h.team);
    log(S, `${name(db, S, d)} leaves ${teamOf(S, h.team).name} for ${teamOf(S, ref).name}.`, isMine(S, h.team) || isMine(S, ref));
  } else log(S, `${teamOf(S, ref).name} signs ${name(db, S, d)} (${years} season${years === 1 ? "" : "s"}).`, isMine(S, ref));
  M.held[d] = { team: ref, years };
  return true;
}
// one round of offers. staff: the player's staff make offers for the player's open seats this round
export function marketRound(db, S, { staff = false } = {}) {
  const M = S.market;
  if (M.done) return false;
  M.round++;
  M.myOffers = M.myOffers.filter(() => false);              // unanswered offers to the player lapse
  const free = pool(db, S);
  let any = false;
  for (const t of S.teams) {
    let open = openSeats(S, t.ref);
    if (open <= 0) continue;
    if (isMine(S, t.ref) && !staff) {                          // the player's offers
      for (const [d, years] of Object.entries(M.userOffers)) {
        if (open <= 0) break;
        if ((M.rejected[d] ?? []).includes(t.ref) || M.held[d]?.team === t.ref) continue;
        any = true;
        if (consider(db, S, d, t.ref, years)) open--;
      }
      M.userOffers = {};
      continue;
    }
    const cands = free.filter((d) => M.held[d]?.team !== t.ref && !(M.rejected[d] ?? []).includes(t.ref)
      && (!M.held[d] || carValue(db, S, M.held[d].team) > carValue(db, S, t.ref)))
      .map((d) => [d, scouted(db, S, t.ref, d)]).sort((a, b) => a[1] - b[1]);
    for (const [d] of cands.slice(0, open)) {
      any = true;
      if (consider(db, S, d, t.ref, contractYears(db, S, d))) open--;
    }
  }
  updateDone(db, S);
  if (!any && !M.done && !userOpen(S).length) M.done = true;  // nobody left to sign: seats stay empty
  return any;
}
export const userOpen = (S) => (S.mode === "team" && openSeats(S, S.player.team) > 0 ? [S.player.team] : []);
// rounds until the market closes, or (team mode) only the player's seats are open, or (driver mode) the player has offers
export function runMarket(db, S, maxRounds = 80) {
  for (let i = 0; i < maxRounds && !S.market.done; i++) {
    if (S.mode === "team" && S.teams.every((t) => isMine(S, t.ref) || openSeats(S, t.ref) <= 0)) break;
    marketRound(db, S);
    if (S.market.myOffers.length) break;
  }
}
export function acceptOffer(db, S, k) {
  const M = S.market, d = playerDriver(S), o = M.myOffers[k];
  if (!o) return false;
  if (M.held[d]) (M.rejected[d] ??= []).push(M.held[d].team);
  M.held[d] = { team: o.team, years: o.years, salary: o.salary };
  for (const [j, x] of M.myOffers.entries()) if (j !== k) (M.rejected[d] ??= []).push(x.team);
  M.myOffers = [];
  log(S, `You sign for ${teamOf(S, o.team).name} (${o.years} season${o.years === 1 ? "" : "s"}, ${fmtM(o.salary)} a season).`, true);
  updateDone(db, S);
  return true;
}
export function declineOffer(S, k) {
  const M = S.market, o = M.myOffers[k];
  if (!o) return false;
  (M.rejected[playerDriver(S)] ??= []).push(o.team);
  M.myOffers.splice(k, 1);
  log(S, `You turn down ${teamOf(S, o.team).name}.`, true);
  return true;
}
// close the market: held offers become contracts; the player's driver always gets a seat
export function closeMarket(db, S) {
  const M = S.market;
  const me = playerDriver(S);
  if (me && !S.contracts[me] && !M.held[me]) {
    // no drive: the weakest held signing of the slowest car makes way for the player for one season
    const cand = Object.entries(M.held).sort((a, b) => carValue(db, S, b[1].team) - carValue(db, S, a[1].team));
    if (cand.length) {
      const [d, h] = cand[0];
      delete M.held[d];
      M.held[me] = { team: h.team, years: 1, salary: salaryOf(db, S, h.team) };
      log(S, `No offer suited you: ${teamOf(S, h.team).name} gives you a one-season drive in place of ${name(db, S, d)}.`, true);
    } else {                                     // nobody signed this offseason: a contracted driver of the slowest car makes way
      const [d, c] = Object.entries(S.contracts).sort((a, b) => carValue(db, S, b[1].team) - carValue(db, S, a[1].team)
        || paceOf(db, S, b[0], S.year) - paceOf(db, S, a[0], S.year))[0] ?? [];
      if (d) {
        delete S.contracts[d];
        M.held[me] = { team: c.team, years: 1, salary: salaryOf(db, S, c.team) };
        log(S, `No offer suited you: ${teamOf(S, c.team).name} gives you a one-season drive in place of ${name(db, S, d)}.`, true);
      }
    }
  }
  for (const [d, h] of Object.entries(M.held)) S.contracts[d] = { team: h.team, left: h.years, ...(h.salary ? { salary: h.salary } : {}) };
  for (const d of pool(db, S)) if (!S.contracts[d]) S.unsigned[d] = (S.unsigned[d] ?? 0) + 1;
  for (const d of Object.keys(S.contracts)) delete S.unsigned[d];
  S.market = null;
}
export function startSeason(db, S) {
  if (S.phase !== "market") return false;
  if (!S.market.done) runMarket(db, S, 200);
  if (!S.market.done && S.mode === "team" && openSeats(S, S.player.team) > 0) return false;   // sign your drivers first
  closeMarket(db, S);
  if (S.prog && !S.prog.car) {
    const cut = G.enforceCap(S.prog, S.year);
    if (cut) S.news.push({ year: S.year, text: `Cost cap: department budgets cut by ${Math.round(cut * 100)}% to fit.`, mine: true });
    const exp = G.projection(S.prog, S.year).mu, c = G.buildCar(S.prog, S.year);
    S.news.push({ year: S.year, text: `The ${S.year} car is built: index ${c.index.toFixed(1)} (expected ${exp.toFixed(1)}).`, mine: true });
  }
  S.phase = "season"; S.round = 0; S.results = [];
  return true;
}

// ---------- races ----------
export const driversOf = (S, ref) => Object.keys(S.contracts).filter((d) => S.contracts[d].team === ref);
const modFor = (db, S, ref, r) => (S.prog ? progMod(db, S, ref, r) : upMod(db, S, ref));
export function raceConfig(db, S, r) {
  const ix = rsIndex(db), cal = S.calendar[r], y = S.year;
  const circ = db.circuits.find((c) => c.ref === cal.circuit);
  const lay = circ.layouts.find((l) => l.key === cal.layout) ?? circ.layouts[0];
  const real = db.races.filter((x) => x.circuit === circ.ref && x.layout === lay.key);
  const same = real.find((x) => x.year === y);
  const laps = same?.laps ?? (real.length ? real.reduce((a, b) => (Math.abs(b.year - y) < Math.abs(a.year - y) ? b : a)).laps : Math.ceil(305 / (lay.length_km ?? 5)));
  const wxr = db.races.filter((x) => x.circuit === circ.ref && x.weather);
  const w = same?.weather ?? (wxr.length ? wxr[Math.floor(rngOf(S.seed, y, r, "wx")() * wxr.length)].weather : null);
  const entries = [];
  for (const t of S.teams) for (const d of driversOf(S, t.ref)) {
    const mine = isMine(S, t.ref) || d === playerDriver(S);
    entries.push({ driver: Number(d), season: y, seasonData: formOf(db, S, d, y), car: t.car, team: t.ref,
                   ...(modFor(db, S, t.ref, r) ? { mod: modFor(db, S, t.ref, r) } : {}), ...(mine ? { mine: true } : {}) });
  }
  return {
    name: `${y} R${r + 1} · ${cal.name}`, circuit: circ.ref, layout: lay.key, year: y, laps,
    wet: w ? Math.min(1, (w.rain_mm ?? 0) / 3) : 0, mode: "relative", grid: "quali", seed: seedOf(S.seed, y, r),
    entries, real: { year: y, round: r },
  };
}
export function recordRace(db, S, cfg, out, calls) {
  const r = cfg.real.round;
  if (cfg.real.year !== S.year || S.phase !== "season" || S.results[r] || r !== S.round) return false;
  const pts = pointsFor(S.year);
  S.results[r] = out.result.map((x) => {
    const row = resultRow(cfg, out, x, pts), fin = row.fin, e = cfg.entries[x.c];
    const pz = fin ? PRIZE_PTS[x.pos - 1] ?? 0 : 0;
    if (isMine(S, e.team) && !S.prog) S.money = money(S.money + 0.25 + 0.12 * pz);
    if (row.d === playerDriver(S) && S.me) {
      const earn = money((S.contracts[row.d]?.salary ?? 0) / S.calendar.length + 0.05 * pz);
      S.me.money = money(S.me.money + earn); S.me.earned = money(S.me.earned + earn); row.earn = earn;
    }
    return row;
  });
  (S.replays ??= {})[r] = { ...cfg, calls };
  for (const x of S.results[r]) {                              // best form seen (for retirement)
    const p = paceOf(db, S, x.d, S.year);
    if (S.best[x.d] == null || p < S.best[x.d]) S.best[x.d] = p;
  }
  S.round++;
  if (S.prog) for (const t of G.roundTick(S.prog, S.year, S.round, S.calendar.length)) S.news.push({ year: S.year, text: t, mine: true });
  if (S.round >= S.calendar.length) S.phase = "review";
  return true;
}
function resultRow(cfg, out, x, pts) {
  const e = cfg.entries[x.c], fin = x.status === "finished";
  return { d: String(e.driver), team: e.team, pos: x.pos, fin: fin ? 1 : 0, pts: fin ? pts[x.pos - 1] ?? 0 : 0, grid: out.cars[x.c].grid };
}
// A bug before v47 could record the previous race's result for a watched round (the old race was still at its flag
// while the next one loaded). Every recorded round keeps its config, so it can be re-run; the re-run can differ from
// what was watched for other reasons too (data updates, strategy calls missing from a mis-recorded round), so the
// player chooses: checkResults lists the rounds whose re-run differs, applyResult takes one. Money paid stays.
export async function checkResults(db, S, trackFor, simulateRace) {
  const found = [], pts = pointsFor(S.year);
  for (let r = 0; r < S.results.length; r++) {
    const c = S.replays?.[r], old = S.results[r];
    if (!c || !old || c.real?.year !== S.year) continue;
    const trk = await trackFor(c.circuit, c.layout);
    if (!trk) continue;
    const out = simulateRace(db, { seed: c.seed, year: c.year, circuit: c.circuit, layout: c.layout, laps: c.laps, wet: c.wet, grid: c.grid,
                                   mode: c.mode, entries: c.entries, calls: c.calls ?? [], relReliability: !!c.relReliability }, trk);
    const rows = out.result.map((x) => resultRow(c, out, x, pts));
    const key = (rs) => rs.map((x) => `${x.d}:${x.pos}:${x.fin}`).join();
    if (key(rows) === key(old)) continue;
    rows.forEach((x) => { const o = old.find((y) => y.d === x.d); if (o?.earn != null) x.earn = o.earn; });
    found.push({ r, rows });
  }
  return found;
}
export function applyResult(S, r, rows) { if (S.results[r]) S.results[r] = rows; }
// the old name: re-run and apply everything (tests)
export async function repairResults(db, S, trackFor, simulateRace) {
  const f = await checkResults(db, S, trackFor, simulateRace);
  for (const x of f) applyResult(S, x.r, x.rows);
  return f.map((x) => x.r);
}
export function simRound(db, S, trackFor, simulateRace) {
  const cfg = raceConfig(db, S, S.round);
  const out = simulateRace(db, { ...cfg, calls: [] }, trackFor(cfg.circuit, cfg.layout));
  return recordRace(db, S, cfg, out, []);
}

// ---------- standings ----------
export function driverStandings(S) {
  const m = new Map();
  for (const res of S.results) for (const x of res ?? []) {
    const s = m.get(x.d) ?? m.set(x.d, { d: x.d, team: x.team, pts: 0, wins: 0, best: 99, starts: 0 }).get(x.d);
    s.pts += x.pts; s.starts++; s.team = x.team;
    if (x.fin && x.pos === 1) s.wins++;
    if (x.fin) s.best = Math.min(s.best, x.pos);
  }
  return [...m.values()].sort((a, b) => b.pts - a.pts || b.wins - a.wins || a.best - b.best);
}
export function teamStandings(S) {
  const m = new Map();
  for (const res of S.results) for (const x of res ?? []) {
    const s = m.get(x.team) ?? m.set(x.team, { team: x.team, pts: 0, wins: 0 }).get(x.team);
    s.pts += x.pts; if (x.fin && x.pos === 1) s.wins++;
  }
  return [...m.values()].sort((a, b) => b.pts - a.pts || b.wins - a.wins);
}

// the player's team in a season: its drivers (most starts first) with their championship place and wins
export function myTeamSeason(S, ds = driverStandings(S), ts = teamStandings(S)) {
  const me = S.mode === "team" ? S.player.team : null, pd = me ? null : playerDriver(S);
  const team = me ?? ds.find((s) => s.d === pd)?.team ?? S.contracts[pd]?.team ?? null;
  if (!team) return null;
  const k = ts.findIndex((s) => s.team === team);
  return { team, name: teamOf(S, team)?.name ?? team, car: teamOf(S, team)?.car ?? null, pos: k + 1 || null, wins: ts[k]?.wins ?? 0, pts: ts[k]?.pts ?? 0,
           drivers: ds.map((s, i) => ({ d: s.d, pos: i + 1, pts: s.pts, wins: s.wins, starts: s.starts, team: s.team })).filter((s) => s.team === team)
             .sort((a, b) => b.starts - a.starts || a.pos - b.pos).map(({ team: _, ...s }) => s) };
}

// ---------- season end ----------
export function endSeason(db, S) {
  if (S.phase !== "review") throw new Error("season not finished");
  const ds = driverStandings(S), ts = teamStandings(S);
  if (S.prog) {                                                // the programme's season: money, people, know-how
    const k = ts.findIndex((s) => isMine(S, s.team)), n = Math.max(ts.length, S.teams.length);
    const place = k < 0 ? n : k + 1;
    const out = G.closeSeason(S.prog, S.year, { place, n, champion: place === 1 }, nextYear(db, S.year), S.calendar.length);
    for (const t of out.news) S.news.push({ year: S.year, text: t, mine: true });
  }
  ts.forEach((s, k) => {                                       // season prize for the player's team (before the programme)
    if (isMine(S, s.team) && !S.prog) { const b = money(Math.max(0, ts.length - k) * 0.8); S.money = money(S.money + b); S.news.push({ year: S.year, text: `Season prize: ${fmtM(b)} (P${k + 1} in the constructors').`, mine: true }); }
  });
  const teamName = (ref) => teamOf(S, ref)?.name ?? ref;
  S.history.push({ year: S.year, champion: ds[0] ? { d: ds[0].d, team: ds[0].team, pts: ds[0].pts, car: teamOf(S, ds[0].team)?.car ?? null } : null,
                   teams: ts[0] ? { team: ts[0].team, name: teamName(ts[0].team), pts: ts[0].pts, car: teamOf(S, ts[0].team)?.car ?? null } : null,
                   mine: S.mode === "team" ? (ts.findIndex((s) => s.team === S.player.team) + 1 || null) : (ds.findIndex((s) => s.d === playerDriver(S)) + 1 || null),
                   myTeam: myTeamSeason(S, ds, ts),
                   table: ds.slice(0, 10).map((s) => ({ d: s.d, team: s.team, teamName: teamName(s.team), pts: s.pts })),
                   // every race of the season (archive.js format) and the season's team names and cars
                   races: S.calendar.map((c, r) => ({ circuit: c.circuit, layout: c.layout, name: c.name, res: packReal(S.results[r]) })),
                   teamNames: Object.fromEntries(S.teams.map((t) => [t.ref, t.name])), cars: Object.fromEntries(S.teams.map((t) => [t.ref, t.car])) });
  if (ds[0]) S.news.push({ year: S.year, text: `${S.year} champion: ${name(db, S, ds[0].d)} (${teamName(ds[0].team)}), ${ds[0].pts} pts. Constructors': ${teamName(ts[0].team)}.` });
  // contracts run down; at the end of a contract a driver past their real career may retire (retireChance)
  const y = S.year;
  for (const [d, c] of Object.entries(S.contracts)) {
    c.left--;
    if (c.left > 0) continue;
    delete S.contracts[d];
    if (retires(db, S, d, y, ds, ts, c.team)) retire(db, S, d, y, "retires");
  }
  // free agents nobody signs for a few seasons retire too
  for (const [d, n] of Object.entries(S.unsigned)) {
    const a = ageIn(db, d, y, S) ?? 30;
    // not while their real career still has seasons to come (Nuvolari's minor 1921-24 races aren't the end of him)
    if ((lastOf(db, S, d) ?? 0) > y) continue;
    if (n >= RETIRE.unsigned[a < 30 ? 0 : a < 34 ? 1 : a < 38 ? 2 : 3]) { retire(db, S, d, y, "stops racing"); delete S.unsigned[d]; }
  }
  const ny = nextYear(db, y);
  S.replays = {};
  if (ny === null) { S.phase = "done"; S.news.push({ year: y, text: "That was the last season with real data. The end." }); return; }
  S.year = ny;
  S.teams = seasonTeams(db, S, ny);
  attach(db, S);
  // teams gone (or with fewer seats): their drivers are free
  for (const [d, c] of Object.entries(S.contracts)) if (!teamOf(S, c.team)) { delete S.contracts[d]; S.news.push({ year: ny, text: `${name(db, S, d)} is free: ${c.team} is gone.` }); }
  for (const t of S.teams) {
    const ds2 = driversOf(S, t.ref).sort((a, b) => paceOf(db, S, a, ny) - paceOf(db, S, b, ny));
    for (const d of ds2.slice(t.seats)) delete S.contracts[d];
  }
  S.calendar = seasonCalendar(db, ny, S.maxRounds);
  S.round = 0; S.results = [];
  startMarket(db, S);
}
export function retireChance(db, S, d, y, ds = driverStandings(S), ts = teamStandings(S), team = null) {
  if (d === playerDriver(S) || Number(d) === ME_RS) return 0;      // the player decides
  if ((lastOf(db, S, d) ?? -Infinity) > y) return 0;              // not before they stopped in real life
  const a = ageIn(db, d, y, S) ?? 30;
  if (a >= RETIRE.hard) return 1;
  const now = paceOf(db, S, d, y + 1), best = S.best[d] ?? now;
  const drop = Math.min(3, Math.max(0, (now - best - RETIRE.drop0) / RETIRE.drop));
  // their place in the field's pace next season (0 the quickest .. 1 the slowest) and their team's this season
  const field = ds.map((s) => paceOf(db, S, s.d, y + 1));
  const fq = field.length > 1 ? field.filter((p) => p < now).length / (field.length - 1) : 0.5;
  team ??= S.contracts[d]?.team ?? ds.find((s) => String(s.d) === String(d))?.team;
  const k = ts.findIndex((s) => s.team === team);
  const tq = k < 0 || ts.length < 2 ? 1 : k / (ts.length - 1);
  const z = (a - RETIRE.age) / RETIRE.spread + RETIRE.wDrop * drop + RETIRE.wField * (fq - 0.5) + RETIRE.wTeam * (tq - 0.5);
  return 1 / (1 + Math.exp(-z));
}
function retires(db, S, d, y, ds, ts, team) {
  const p = retireChance(db, S, d, y, ds, ts, team);
  return p > 0 && rngOf(S.seed, y, "retire", d)() < p;
}
function retire(db, S, d, y, verb) {
  S.retired[d] = y;
  if (S.best[d] == null) return;                   // only drivers who raced in this game make the news
  const a = ageIn(db, d, y, S);
  S.news.push({ year: y, text: `${name(db, S, d)} ${verb}${a ? ` at ${Math.floor(a)}` : ""}.` });
}

// ---------- saves ----------
export const serialize = (S) => JSON.stringify(S);
export function deserialize(db, text) {
  const S = JSON.parse(text);
  if (S.kind !== KIND) throw new Error("not a Real Seasons save");
  rsIndex(db);
  if (S.custom && !S.custom.livery) S.custom.livery = defaultLivery(S.custom.colours);
  else if (S.custom?.livery && S.custom.livery.v !== 2) { S.custom.livery_v1 = S.custom.livery; S.custom.livery = migrateLivery(S.custom.livery); }
  if (S.mode === "team" && !S.prog) {                          // saves before the programme: same car, money -> cash
    S.prog = migrateProg(db, S);
    S.news.push({ year: S.year, text: "Your team now runs a full programme, set up to match the car you had (upgrades included).", mine: true });
  } else if (S.mode === "team" && S.prog && !S.prog.mig && !S.prog.ledger.length && S.up
             && S.news.some((x) => x.year === S.year && /now runs a full programme/.test(x.text))) {
    // converted by the first version (v-programme 1), which ignored what the upgrades were worth: convert again
    const was = S.prog.car ? S.prog.car.index : G.projection(S.prog, S.year).mu;
    S.prog = migrateProg(db, S);
    const now = S.prog.car ? S.prog.car.index : G.projection(S.prog, S.year).mu;
    S.news.push({ year: S.year, text: `Programme conversion corrected: car index ${was.toFixed(0)} -> ${now.toFixed(0)}, matching your upgraded car.`, mine: true });
  }
  attach(db, S);
  repairRetired(db, S);
  return S;
}
// drivers retired before their real last season (saves before v52: unsigned free agents; before the age rule:
// drivers who had dropped off at a contract's end) come back while their real career still runs
export function repairRetired(db, S) {
  const back = [];
  for (const [d, y] of Object.entries(S.retired)) {
    if (S.contracts[d] || d === String(playerDriver(S))) continue;
    if ((lastOf(db, S, d) ?? 0) > y && (lastOf(db, S, d) ?? 0) >= S.year) { delete S.retired[d]; back.push(d); }
  }
  if (back.length) S.news.push({ year: S.year, text: `Back on the market: ${back.length} driver${back.length === 1 ? "" : "s"} retired before their real careers ended (${back.slice(0, 6).map((d) => name(db, S, d)).join(", ")}${back.length > 6 ? ", …" : ""}).` });
  return back;
}
