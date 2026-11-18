// Lap-level race simulator. Pure function of (db, config, track, seed): no DOM, runs in Node and
// the browser. Pace units: percent of lap time (lower = faster), as in the rating model.
//
// config = {
//   seed, year,                     // rules year: era physics, overtaking era, stop strategies
//   circuit: "monaco", layout?: key, laps?: n,
//   mode: "relative" | "absolute",  // field-relative car pace, or real speed across eras
//   wet?: 0..1,                     // race-long wetness (0 dry)
//   grid: "quali" | "fixed",        // qualifying sim, or entries order as given
//   uncertainty?: true,             // draw driver/car ratings from their posterior per race
//   entries: [{ driver: id, season: year, car: carId, mod?: { pace, deg, rel } }],
//            mod (career upgrades): pace offset in pct of lap (negative = faster), tyre-wear and failure multipliers;
//            programme cars also: lean (power), quali (one-lap offset), degRel (replaces car.deg_rel), pitS, read
//   relReliability?: true  // car failure rate taken relative to its own era, scaled to the rules year (mixed eras)
//   calls?: [{ car: entryIndex, lap, action: "box" | "stay" | "stops" | "pace", value? }],
//            user strategy calls (game/sim/strategy.js); every other car is run by its CPU strategist
//   replay?: a real race (game/web/history.js, docs/GAME_PLAN.md section 17). Laps 1..until are forced from the
//            record: t[i] = crossing times (s from the start) per lap, pit[i] = [[in-lap, lane ms]], fin[i] (a
//            classified finisher), cause[i] (retirement), sc / vsc = [[from, to]] lap windows, baseLap (the race's
//            own lap). Passes are derived from the order changes. After `until` the sim races on from that state.
// }
// track (optional): output/gamedb/tracks/<geo_id>.json, for sector fractions and passing zones.
import { indexDb, synthEra, overtakingEra, layoutFor, nearestYear } from "./db.js";
import { makeRng } from "./rng.js";
import { eraTrack } from "./profile.js";
import { Strategist, decideLap, tyreLife, stintScale, refuelEra, CLIFF, FUEL_PCT, REPAIR_S } from "./strategy.js";

const WET_SLOW = 12.0;
// ---- neutralisations (safety car, virtual safety car)
// A safety car follows a crash (or, less often, a car stopped with a failure, or debris). The rate per race is
// the era's (historical neutralisations per race) times a shrunk circuit factor; it is met by the chance that a
// retirement brings out the SC (q, capped), plus debris SCs for any remainder. None before 1993 (no SC rule).
// VSC from 2015 (about 40% of neutralisations after crashes, more after a car parks with a failure).
// Procedure: the leader closes on the SC car (SC_FIRST x a lap), the others must keep the delta (SC_DELTA) until
// they reach the queue, cars queue SC_GAP s apart; the SC laps after that run at SC_FACTOR. No passing, no
// spins or crashes behind the SC. Lapped cars stay a lap down, except from 2012 when they unlap themselves on
// the last SC lap and rejoin the back of the queue. Under the VSC every car runs VSC_FACTOR x a lap: gaps hold.
const SC_YEAR = 1993, VSC_YEAR = 2015, UNLAP_YEAR = 2012;
const SC_GAP = 0.8, SC_FIRST = 1.55, SC_FACTOR = 1.45, SC_DELTA = 1.2, VSC_FACTOR = 1.35;
const SC_RATE = (y) => (y < SC_YEAR ? 0 : y < 2010 ? 0.52 : 1.08);   // era neutralisations per race (detected)
const SC_Q_MAX = 0.9, SC_MECH_W = 0.25;
const SC_CAL = (y) => (y < 2010 ? 1.45 : 1.1);   // triggers lost to overlaps and late crashes (audit: realised ~ target)
const SC_LEN = 3.3, VSC_LEN = 1.6;                                  // mean laps
// Managing: a car with more than MANAGE_GAP s in hand over the car behind runs no faster than that
// car's expected pace (tyres, fuel, engine), so gaps stop growing - the 'managed' regime of the
// rating model (~18% of laps).
const MANAGE_GAP = 5.0;
const MANAGE_CAP = 0.6;          // pct: the most a managing car eases off the follower's own pace
const MANAGE_MAX = 2.0;          // pct: the most a managing car runs off its own pace
const MANAGE_STEP = 0.4;        // pct per lap: easing (and picking the pace back up) is gradual
// A car managing a lead also gives back a share of the excess gap per lap (s/lap per s of excess),
// calibrated on historical replay (winning margin, gap to 5th). Turbo-era races were fuel-limited
// rather than gap-managed, so the leader barely eases off there.
const MANAGE_RELAX = (year) => (year <= 1993 ? 0.0 : year <= 2009 ? 0.03 : 0.04);
const START_SLOT = 0.25;         // s between grid slots at the start
const START_SKILL_S = 0.35;      // s per place of 'starts' skill on lap 1
const QUALI_NOISE = 0.25;        // % per qualifying run
const START_NOISE = 0.85;        // s of random gain/loss on lap 1 (launch, first-corner melee)
const START_NOISE_TURBO = 0.5;   // turbo era: calmer lap-1 melee in replay (sim lap-1 swaps ran 25% high)
// relative-mode car pace scale by car year (mixed-year fields): 0.6 for 1950-53, rising to 1 by 1970. Calibrated so
// the best 1950s-60s cars (1951 Alfa, 1961 Ferrari, 1966 Ferrari: -2.5 to -2.7) sit just behind the strongest later
// ones (1987/1992/1995 Williams: -3.3, -2.8, -2.7). Pre-war cars, spread even wider (1929 Alfa -6.3, 1925 Ballot
// -5.8), get 0.45: their best land at -2.9 to -2.0.
export function eraCarScale(y) {
  if (y < 1950) return 0.40;
  if (y >= 1970) return 1;
  return y <= 1953 ? 0.6 : 0.6 + 0.4 * (y - 1953) / 17;
}
const START_SPREAD = 0.45;       // s minimum spacing after lap 1
const FOLLOW_EXTRA = 0.4;        // s mean extra following distance of a held car (dirty air)
const INCIDENT_SCALE = 0.8;      // E[exp(error skill)] > 1 inflates the era incident rate
// Simulator calibration of the pass logit, per overtaking era (historical replay: sim swaps vs
// real swaps). The fitted model is per contested lap; the sim field is more bunched than reality
// (more contested laps), so the logit is shifted where that over-produces passes. Re-fitted 2026-11 after
// cars stopped queueing behind a car that spun (FREE_PASS_S): those passes now count as real ones.
const PASS_CAL = { turbo: -1.9, refuel: -1.8, y2010: -1.0, drs: -1.0, ground_effect: -1.0 };
// Wet races (historical replay, 90 wet races): more passing (mistakes, different lines) as a logit
// shift per unit wetness; on lap 1 the field runs bunched, so the wet multipliers on lap-time noise
// and on loss events (spins, offs) do not apply - they made lap-1 position changes 30% too high.
const PASS_WET = 0.35;
// A car arriving more than FREE_PASS_S before the car ahead on this lap goes by: the car ahead has spun, is
// damaged or is crawling (it used to be 'held' behind it and lost the same minute).
const FREE_PASS_S = 8.0;
const LOSS_CAP = 40;
// Lap length. The per-lap rates (failures, spins, incidents, damage, passes, lap-time noise, tyre wear, fuel weight)
// were fitted on laps of LEN_REF_KM on average (1981-2024 races). A lap of another length scales them by distance:
// event chances compound per km, wear and fuel weight per km grow with the lap, lap-to-lap noise averages out
// (1/sqrt), and the gap a leader manages is held in km of track. Without this a 22.8 km Nordschleife lap was
// treated like 5 km: the field barely spread and nearly everyone finished.
export const LEN_REF_KM = 4.95;
const perLen = (p, f) => 1 - Math.pow(1 - Math.min(p, 0.999), f);             // pct of a lap: the most one loss event (spin, off) costs

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
// user pace modes: pace offset (pct) and tyre-wear multiplier
export const PACE_MODES = { push: [-0.2, 1.5], normal: [0, 1], conserve: [0.25, 0.6] };

export function setupRace(dbRaw, config, track = null) {
  const db = indexDb(dbRaw);
  const { drivers, cars, circuits, pop } = db._ix;
  const rng = makeRng(config.seed ?? 1);
  const year = config.year;
  track = eraTrack(track, year);                      // the lap's speed profile for the period's cars
  const era = synthEra(db, year);
  const ot = overtakingEra(db, year);
  const circuit = circuits.get(config.circuit);
  const layout = layoutFor(circuit, year, config.layout);
  const wet = clamp(config.wet ?? 0, 0, 1);
  // power vs agility: the layout's power sensitivity (sd units; f1rank/gamedb/power.py) times each car's lean
  const power = layout.power ?? 0;
  const unc = config.uncertainty !== false;
  const speedYears = db.speed.year;
  const bYear = (y) => speedYears[y] ?? speedYears[nearestYear(speedYears, y)];
  const lengthKm = layout.length_km ?? (track ? track.length_m / 1000 : 5);
  // the layout's reference lap (log s); missing or implausible (outside 8-40 s/km): the typical 17.5 s per km
  const sa = layout.speed_a, spk = sa != null ? Math.exp(sa) / lengthKm : NaN;
  const a = spk >= 8 && spk <= 40 ? sa : Math.log(17.5 * lengthKm);
  const baseLap = config.replay?.baseLap ?? Math.exp(a + bYear(year));   // reference lap, race year (a replay: its own)
  const laps = config.laps ?? Math.ceil(305 / lengthKm);
  const lenF = lengthKm / LEN_REF_KM;
  // stint cost scale for the rules year (tyre wear and fuel weight; config.stintScale overrides, for fitting)
  const wScale = config.stintScale ?? stintScale(db, year);
  const draw = (v, scale = 1) => (v ? (unc ? rng.normal(v[0], v[1] * scale) : v[0]) : null);

  // pre-war classes: a car's pace is relative to its own class field; mixed fields (and cross-era races) add the
  // class's gap to the GP class
  const clsSet = new Set(config.entries.map((e) => cars.get(e.car)?.cls).filter(Boolean));
  const useCls = clsSet.size > 1 || config.mode === "absolute";
  // field-relative car pace across seasons: 1950s-60s fields were far more spread out, so their gaps are compressed
  // (only when the field mixes car years; a straight replay of one season keeps its real gaps)
  const mixYears = config.mode !== "absolute" && new Set(config.entries.map((e) => cars.get(e.car)?.year)).size > 1;
  const cs = config.entries.map((e, i) => {
    const d = drivers.get(e.driver);
    // e.seasonData: a season the entry brings itself (Real Seasons: a driver aged past their real career)
    const season = e.seasonData ?? d.seasons[e.season] ?? d.seasons[nearestYear(d.seasons, e.season)];
    const sk = (k) => { const v = draw(season.skills[k]); return v === null ? 0 : v - pop[k]; };
    const car = cars.get(e.car);
    const carPace = (unc && car.pace_sd ? rng.normal(car.pace, (car.pace_sd ?? 0) / Math.sqrt(car.n_races || 1)) : car.pace)
      * (mixYears ? eraCarScale(car.year) : 1);
    const absShift = config.mode === "absolute" ? 100 * (bYear(car.year) - bYear(year)) : 0;
    const m = e.mod ?? {};
    const lean = ((car.power_lean ?? 0) + (m.lean ?? 0)) * power;   // % lap time; m.lean: the player's programme
    // relative reliability: the car's rate against its own era's (pre-war: that year's pre-war rate)
    const ownEra = car.year < 1950 && db.eras.prewar?.mech_per_lap?.[car.year] ? db.eras.prewar.mech_per_lap[car.year]
      : synthEra(db, car.year).p_mech_lap;
    const pMech = config.relReliability && car.p_mech_lap
      ? car.p_mech_lap / ownEra * era.p_mech_lap : car.p_mech_lap ?? era.p_mech_lap;
    return {
      i, driver: d.id, name: d.name, code: d.code, helmet: d.helmet, car: car.id, carName: car.name, carYear: car.year,
      pace: carPace + absShift + sk("pace") + (m.pace ?? 0) + lean + (useCls ? car.cls_offset ?? 0 : 0),
      quali: carPace + absShift + sk("quali") + (m.pace ?? 0) + (m.quali ?? 0) + lean + (useCls ? car.cls_offset ?? 0 : 0),
      starts: sk("starts"),
      deg: Math.max(era.deg + (m.degRel ?? car.deg_rel ?? 0) + sk("deg"), 0) * wScale * (m.deg ?? 1) * lenF,
      sigma: era.sigma * Math.exp(sk("consistency")) * (1 + wet) / Math.sqrt(lenF),
      pLoss: perLen(era.p_loss * Math.exp(sk("errors")) * (1 + 2 * wet), lenF),
      wetLoad: 1 + sk("wet"),
      attack: sk("attack"), defence: sk("defence"),
      pMech: perLen(pMech * (m.rel ?? 1), lenF),
      pitS: m.pitS ?? 0, readMul: m.read ?? 1,         // programme race operations: crew time per stop (s), strategist's wear read
      pInc: perLen(INCIDENT_SCALE * era.p_incident_lap * Math.exp(sk("errors")) * (1 + 2 * wet), lenF),
    };
  });
  if (config.mode !== "absolute") {                                  // centre the field
    const m = cs.reduce((s, c) => s + c.pace, 0) / cs.length;
    for (const c of cs) { c.pace -= m; c.quali -= m; }
  }
  // grid
  let order = cs.map((c) => c.i);
  if (config.grid !== "fixed") {
    for (const c of cs) c.qTime = c.quali + rng.normal(0, QUALI_NOISE) + (wet ? rng.normal(0, 0.6 * wet) : 0);
    order = [...order].sort((x, y) => cs[x].qTime - cs[y].qTime);
  }
  order.forEach((ci, g) => { cs[ci].grid = g + 1; });

  // sector fractions + passing zones from the track profile
  let sectors = [1 / 3, 1 / 3, 1 / 3], zones = [{ f: 0.05, w: 1 }];
  if (track) {
    const [s1, s2] = track.sectors.map((ix) => track.t[ix]);
    sectors = [s1, s2 - s1, 1 - s2];
    // (an oval has no braking zones: passes then happen on the main straight, the default zone)
    if (track.zones?.length) zones = track.zones.map((z) => ({ f: track.t[z.apex], w: z.drop, start: z.start, apex: z.apex }));
  }
  // pre-war (before 1950): stops were forced (tyres, fuel, plugs) and long: the period's stop time plus the
  // lane, and a chance of a stop per km (eras.prewar, from the golden-era rules by period)
  const pw = year < 1950 ? db.eras.prewar : null;
  const pitLoss = pw ? (pw.pit_s[year] ?? 120) + 15 : circuit.pit_loss_s ?? (era.loss_in + era.loss_out);
  const pStop = pw ? Math.min(0.5, (pw.stops_per_100km[year] ?? 0.12) * lengthKm / 100) : 0;
  const inShare = era.loss_in / (era.loss_in + era.loss_out);
  // neutralisations: triggered during the race (see SC_* above); the rate here sets the trigger chances
  const scLaps = new Set(), vscLaps = new Set();
  const circF = clamp(Math.sqrt((circuit.sc_per_race ?? 0.66) / 0.66), 0.6, 1.8);
  const scTarget = config.scRate ?? SC_CAL(year) * SC_RATE(year) * circF;
  const expTrig = cs.reduce((s, c) => s + (c.pInc + SC_MECH_W * c.pMech) * laps, 0);
  const scQ = scTarget > 0 ? Math.min(SC_Q_MAX, scTarget / Math.max(expTrig, 1e-6)) : 0;
  const scDebris = Math.max(0, scTarget - SC_Q_MAX * expTrig) / laps;
  const R = { db, rng, config, year, era, ot, circuit, layout, laps, baseLap, wet, cs, sectors, zones,
              pitLoss, inShare, scLaps, vscLaps, scQ, scDebris, overtakeU: circuit.overtake_u ?? 0, tyreLife: tyreLife(db, year), stintScale: wScale,
              lenF, pDmgLap: perLen(era.p_damage_lap, lenF), pStop, track };
  // one CPU strategist per car (aggression drawn for every car, so the RNG stream is fixed)
  R.strategists = cs.map((c, i) => new Strategist(R, c, i, rng));
  // refuel era: reference fuel load so the average car's pace is unchanged by the fuel model
  const st = db.eras.stops[year] ?? db.eras.stops[nearestYear(db.eras.stops, year)];
  const meanStops = Object.entries(st).reduce((m, [k, p]) => m + Number(k) * p, 0);
  R.fuelRef = refuelEra(year) ? laps / (meanStops + 1) / 2 : 0;
  return R;
}

export function simulateRace(dbRaw, config, track = null) {
  const R = setupRace(dbRaw, config, track);
  const { rng, era, ot, laps, baseLap, wet, cs, sectors, zones, pitLoss, inShare, scLaps, vscLaps } = R;
  // deploy a neutralisation from lap `from` (the crash happens during the lap before); one in progress is extended
  const neutralise = (from, kind, why) => {
    if (from > laps) return;
    const on = (l) => scLaps.has(l) || vscLaps.has(l);
    if (on(from) || on(from - 1)) {                 // already neutralised: it runs a lap longer
      const cur = scLaps.has(from) || scLaps.has(from - 1) ? scLaps : vscLaps;
      let l = from; while (cur.has(l)) l++;
      if (l <= laps) cur.add(l);
      return;
    }
    const len = kind === "vsc" ? 1 + Math.min(3, Math.floor(rng.exp(VSC_LEN - 1) + 0.5))
                               : Math.max(2, Math.min(7, Math.round(1 + rng.exp(SC_LEN - 1))));
    for (let l = from; l < from + len && l <= laps; l++) (kind === "vsc" ? vscLaps : scLaps).add(l);
    events.push({ lap: from, type: kind === "vsc" ? "vsc_deploy" : "sc_deploy", why });
  };
  const n = cs.length;
  const alive = new Array(n).fill(true);
  const cum = cs.map((c) => START_SLOT * (c.grid - 1));
  const age = new Array(n).fill(0);
  const damage = new Array(n).fill(0);
  const diag = { contested: 0, pSum: 0 };
  const lapRows = [];                 // lapRows[l] = [{c, dur, cum, s:[..], pit, held}]
  const events = [];
  const S = R.strategists;
  // replay of a real race: laps up to `until` are forced from the record
  const RP = config.replay ?? null;
  // a replay's stop costs no more than the lap's excess over the car's usual lap (its median real lap)
  const usual = RP ? RP.t.map((ts, i) => {
    const d = [];
    for (let l = 1; l < (ts?.length ?? 0); l++) d.push(ts[l] - ts[l - 1]);
    d.sort((a, b) => a - b);
    return d.length ? d[Math.floor(d.length / 2)] : null;
  }) : null;
  const until = RP ? Math.min(RP.until ?? laps, laps) : 0;
  const forced = (lap) => lap <= until;
  const rpPit = RP ? cs.map((_, i) => new Map((RP.pit?.[i] ?? []).map((p) => [p[0], p[1]]))) : null;
  const rpNext = (i, lap) => { let m = laps; for (const l of rpPit[i].keys()) if (l > lap && l < m) m = l; return m; };
  if (RP) {
    // neutralisations that began by the take-over lap run their real course; later ones are the sim's to make
    for (const [set, ws, kind] of [[scLaps, RP.sc, "sc"], [vscLaps, RP.vsc, "vsc"]]) for (const [a0, b0] of ws ?? []) {
      if (a0 > until) continue;
      for (let l = a0; l <= b0 && l <= laps; l++) set.add(l);
      events.push({ lap: a0, type: kind === "vsc" ? "vsc_deploy" : "sc_deploy", why: null });
    }
    for (const l of RP.red ?? []) if (l <= until) events.push({ lap: l, type: "red" });   // a suspension (in the lap's time)
    (RP.nar ?? []).forEach((x, k) => { if (x.lap <= until) events.push({ lap: x.lap, k, type: "nar", text: x.text, q: x.q, src: x.src, ...(x.c != null ? { c: x.c } : {}) }); });
    for (let i = 0; i < n; i++) if (!(RP.t[i]?.length)) {           // out on the opening lap
      alive[i] = false;
      events.push({ lap: 1, type: "retire", c: i, cause: RP.cause?.[i] ?? "mechanical", f: 0.1 + 0.8 * rng.u(), text: RP.why?.[i] ?? null });
    }
  }
  const mode = cs.map(() => PACE_MODES.normal);
  const cliff = (i) => CLIFF * R.lenF ** 2 * Math.max(0, age[i] - S[i].life) ** 2;
  const fuel = new Array(n).fill(0);
  const refuel = refuelEra(R.year);
  const base = (c, i) => c.pace + mode[i][0] + c.deg * mode[i][1] * age[i] + cliff(i) + damage[i]
                        + (refuel ? FUEL_PCT * R.stintScale * R.lenF * (fuel[i] - R.fuelRef) : 0);
  // user calls by lap
  const calls = new Map();
  const callsAt = (lap) => {
    for (const cl of config.calls ?? []) {
      if (cl.lap !== lap || !S[cl.car]) continue;
      const u = calls.get(cl.car) ?? {};
      if (cl.action === "box") u.box = lap;
      else if (cl.action === "stay") u.stayUntil = lap + (cl.value ?? 3) - 1;
      else if (cl.action === "stops") S[cl.car].targetK = cl.value ?? null;
      else if (cl.action === "pace") { mode[cl.car] = PACE_MODES[cl.value] ?? PACE_MODES.normal; S[cl.car].setWear(mode[cl.car][1]); }
      calls.set(cl.car, u);
      events.push({ lap, type: "call", c: cl.car, action: cl.action, value: cl.value });
    }
  };
  // starting fuel (refuel era): enough for the planned first stint plus a lap
  if (refuel) for (let i = 0; i < n; i++) {
    const ev = S[i].evaluate(1, 0, R.pitLoss, R.pitLoss, { any: false, noStop: 0, at: () => 0 });
    fuel[i] = Math.min(laps, ev.best.x + 1); S[i].fuelLeft = fuel[i];
  }
  const boxedLast = new Array(n).fill(false);
  const stopsDone = new Array(n).fill(0);
  const stopLaps = cs.map(() => []);
  const relax = MANAGE_RELAX(config.year);
  const target = new Array(n).fill(null);   // managed pace target (expected pct of the car behind)
  const ease = new Array(n).fill(0);         // applied easing (pct), moved toward the target gradually
  const expect = (c, i) => base(c, i) + ease[i];

  // take-over (replay ends): the sim's lap is calibrated on the real laps just run. The field's level is matched
  // (the record's own lap already holds the day's conditions, so wetness and fuel are not stacked on it) and each
  // car keeps half of its real form against the sim's expectation (clipped to 1.5 pct)
  let calib = 1;
  const takeOver = (lap) => {
    const rows = lapRows.slice(-3).filter((_, k, a) => { const l = lapRows.length - a.length + k + 1; return !scLaps.has(l) && !vscLaps.has(l); });
    const fuelC = (laps - lap) - laps / 2;
    const ratio = new Map();
    for (const row of rows) for (const r of row) {
      if (r.pit || !alive[r.c]) continue;
      const c = cs[r.c];
      const e = baseLap * Math.exp((expect(c, r.c) + era.phi * R.lenF * fuelC + WET_SLOW * wet * c.wetLoad) / 100);
      (ratio.get(r.c) ?? ratio.set(r.c, []).get(r.c)).push(100 * Math.log(r.dur / e));
    }
    const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
    const per = new Map([...ratio].map(([i, a]) => [i, med(a)]));
    if (per.size < 3) return;
    const m = med([...per.values()]);
    calib = Math.exp(m / 100);
    for (const [i, v] of per) cs[i].pace += clamp(0.5 * (v - m), -1.5, 1.5);
  };

  for (let lap = 1; lap <= laps; lap++) {
    if (RP && lap === until + 1 && until >= 2) takeOver(lap);
    const sc = scLaps.has(lap) || vscLaps.has(lap), vsc = vscLaps.has(lap);
    const fuelC = (laps - lap) - laps / 2;
    const end = new Array(n).fill(NaN), dur0 = new Array(n).fill(NaN);
    const inl = new Array(n).fill(false), outl = new Array(n).fill(false), loss = new Array(n).fill(0);
    const pitAdd = new Array(n).fill(0);
    // strategy calls for this lap (user first, then each CPU strategist)
    callsAt(lap);
    for (let i = 0; i < n; i++) if (refuel) S[i].fuelLeft = fuel[i];
    const fz = forced(lap);
    // a replayed lap: the real stops, no strategist calls (its plan resumes at the take-over)
    const dec = fz ? { box: cs.map((_, i) => alive[i] && rpPit[i].has(lap)), log: [] }
      : decideLap(R, S, { lap, alive, cum, age, damage, sc, calls, pittedLast: boxedLast, expect: (j) => expect(cs[j], j) });
    if (fz) for (let i = 0; i < n; i++) if (dec.box[i]) {
      S[i].stops++; S[i].plan = null;
      const ms = rpPit[i].get(lap);
      dec.log.push({ c: i, act: "box", why: "real", text: ms ? `Real stop: ${(ms / 1000).toFixed(1)} s in the pit lane.` : "Real stop." });
    }
    // refuel era: out of fuel forces a stop
    if (refuel && !fz) for (let i = 0; i < n; i++) if (alive[i] && !dec.box[i] && lap < laps && fuel[i] <= 1) {
      dec.box[i] = true; S[i].stops++; dec.log.push({ c: i, act: "box", why: "fuel", text: "Fuel: this stint's load is used up." });
    }
    // pre-war: forced stops (a tyre, fuel, plugs)
    if (R.pStop && !fz) for (let i = 0; i < n; i++) if (alive[i] && !dec.box[i] && lap < laps && rng.u() < R.pStop) {
      dec.box[i] = true; S[i].stops++;
      const w = ["a tyre", "fuel and water", "plugs", "a tyre change"][Math.floor(rng.u() * 4)];
      dec.log.push({ c: i, act: "box", why: "forced", text: `In for ${w}.` });
    }
    for (const d of dec.log) events.push({ lap, type: "strategy", c: d.c, act: d.act, why: d.why, text: d.text });
    for (const [i, u] of calls) if (u.box === lap) delete u.box;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const c = cs[i];
      const pDmg = rng.u();
      if (!sc && !fz && pDmg < R.pDmgLap) { damage[i] += era.damage_offset; events.push({ lap, type: "damage", c: i }); }
      let pct = expect(c, i) + era.phi * R.lenF * fuelC + rng.normal(0, lap === 1 ? c.sigma / (1 + wet) : c.sigma)
              + WET_SLOW * wet * c.wetLoad;
      // a spin or off costs time, not a share of the lap: its pct shrinks on a long lap
      if (rng.u() < (lap === 1 ? c.pLoss / (1 + 2 * wet) : c.pLoss) && !sc && !fz) { loss[i] = Math.min(LOSS_CAP, rng.exp(era.loss_scale)) / R.lenF; pct += loss[i]; events.push({ lap, type: "loss", c: i, pct: loss[i] }); }
      let dur = baseLap * calib * Math.exp(pct / 100);
      if (lap === 1) dur = dur * era.lap1_factor - START_SKILL_S * c.starts + rng.normal(0, config.year <= 1993 ? START_NOISE_TURBO : START_NOISE);
      inl[i] = dec.box[i];
      outl[i] = boxedLast[i];
      const noise = rng.normal(0, 1.0);                 // drawn every lap: strategy never shifts the RNG stream
      const repair = inl[i] && damage[i] > 0 ? REPAIR_S : 0;
      const pl = pitLoss * (sc ? 0.6 : 1) + (inl[i] || outl[i] ? noise : 0) + repair + (inl[i] || outl[i] ? c.pitS / 2 : 0);
      if (inl[i]) pitAdd[i] += pl * inShare;
      if (outl[i]) pitAdd[i] += pl * (1 - inShare);
      dur += pitAdd[i];
      dur0[i] = dur;
      end[i] = cum[i] + dur;
      if (fz) {                                         // the real crossing; the pit share stays inside the lap
        end[i] = RP.t[i][lap - 1];
        const real = end[i] - cum[i];
        const cap = usual?.[i] ? Math.max(0.05 * real, real - 0.97 * usual[i]) : 0.6 * real;
        if (pitAdd[i] > Math.min(cap, 0.6 * real)) pitAdd[i] = Math.min(cap, 0.6 * real);
      }
    }
    // traffic / passing, cars in order of the previous crossing
    const ord = [...Array(n).keys()].filter((i) => alive[i]).sort((x, y) => cum[x] - cum[y]);
    const cum0 = cum.slice();          // crossing times at the start of this lap (for covering)
    const held = new Array(n).fill(false);
    // the lap of the crash that brings out a (V)SC: yellow flags from the crash on, so no contested passes
    const yellow = !sc && (scLaps.has(lap + 1) || vscLaps.has(lap + 1));
    if (fz) {
      // a replayed lap: crossings are real. Passes: a car now ahead of one that led it at the line last lap, with
      // neither in the pits (not on the opening lap, nor behind the SC)
      if (sc && !(scLaps.has(lap - 1) || vscLaps.has(lap - 1))) events.push({ lap, type: vsc ? "vsc_start" : "sc_start" });
      if (sc && !(scLaps.has(lap + 1) || vscLaps.has(lap + 1))) events.push({ lap, type: vsc ? "vsc_end" : "sc_end", unlap: false });
      if (lap > 1 && !sc) for (let x = 0; x < ord.length; x++) for (let y = 0; y < x; y++) {
        const i = ord[x], j = ord[y];                   // j crossed ahead of i last lap
        if (end[i] < end[j] && !inl[i] && !outl[i] && !inl[j] && !outl[j]) {
          const zi = rng.pick(zones.map((zz) => zz.w));
          events.push({ lap, type: "pass", c: i, on: j, zone: zi, f: zones[zi].f, real: true });
        }
      }
    } else if (vsc) {
      // virtual SC: everyone at the delta, gaps held, no passing
      for (const i of ord) end[i] = cum[i] + baseLap * VSC_FACTOR + pitAdd[i];
      if (!vscLaps.has(lap - 1)) events.push({ lap, type: "vsc_start" });
      if (!vscLaps.has(lap + 1)) events.push({ lap, type: "vsc_end" });
    } else if (sc) {
      const firstLap = !scLaps.has(lap - 1), lastLap = !scLaps.has(lap + 1);
      const lead = ord[0], leadEnd = cum[lead] + baseLap * (firstLap ? SC_FIRST : SC_FACTOR);
      const scDur = leadEnd - cum[lead];
      const unlap = lastLap && R.year >= UNLAP_YEAR;
      let last = -Infinity;
      const lapped = [];
      for (const i of ord) {
        if (i === lead) { end[i] = leadEnd; last = end[i]; continue; }
        const down = Math.floor((cum[i] - cum[lead]) / (baseLap * 1.05));        // laps behind the leader
        if (down >= 1 && !unlap) { lapped.push([i, down]); continue; }
        // delta pace until the car reaches the queue, then SC_GAP behind the car ahead; a car unlapping itself
        // (2012+, last SC lap) drives round to the back of the queue and regains one lap
        end[i] = down >= 1 ? last + SC_GAP + (down - 1) * scDur : Math.max(cum[i] + baseLap * SC_DELTA, last + SC_GAP);
        if (down < 2) last = end[i];
      }
      // lapped cars (before 2012, or before the last SC lap): a lap (or more) behind the queue, in road order
      let lastL = -Infinity;
      for (const [i, down] of lapped) {
        end[i] = Math.max(cum[i] + baseLap * SC_DELTA, last + SC_GAP + (down - 1) * scDur, lastL + SC_GAP);
        lastL = end[i];
      }
      for (const i of ord) end[i] += pitAdd[i];
      if (firstLap) events.push({ lap, type: "sc_start" });
      if (lastLap) events.push({ lap, type: "sc_end", unlap });
    } else if (lap === 1) {
      // the start: free reordering from grid slot + launch, then the field strings out
      const o1 = [...ord].sort((x, y) => end[x] - end[y]);
      let last = -Infinity;
      for (const i of o1) { end[i] = Math.max(end[i], last + START_SPREAD); last = end[i]; }
    } else {
      // last / second: the two latest crossing times so far (the car just ahead and the one before it)
      let last = -Infinity, prev = -1, second = -Infinity, lastCar = -1;
      for (const i of ord) {
        const ahead = lastCar;                        // the car physically ahead at this lap's end
        const pitting = inl[i] || outl[i] || (ahead >= 0 && (inl[ahead] || outl[ahead]));
        const gap = ahead >= 0 ? cum[i] - cum[ahead] : Infinity;
        if (ahead >= 0 && outl[ahead] && !inl[i] && !outl[i] && end[i] < last) {
          // the car ahead is still in the pit lane: this one goes by on track, no contest, no hold
        } else if (ahead >= 0 && !pitting && last - end[i] > FREE_PASS_S) {
          const room = last - second;
          end[i] = Math.min(end[i], last - Math.min(0.3 + 0.4 * rng.u(), 0.5 * room));
          const zi = rng.pick(zones.map((zz) => zz.w));
          events.push({ lap, type: "pass", c: i, on: ahead, zone: zi, f: zones[zi].f, free: true });
        } else if (ahead >= 0 && gap < ot.attack_gap && !pitting && !yellow) {
          const edge = expect(cs[ahead], ahead) - expect(cs[i], i);
          const z = ot.b0 + ot.b_edge * edge + ot.b_gap * (Math.max(gap, ot.min_gap) - ot.gap_ref) + R.overtakeU
                  + cs[i].attack - cs[ahead].defence + (PASS_CAL[ot.name] ?? 0) + PASS_WET * wet;
          const pPass = perLen(1 / (1 + Math.exp(-z)), R.lenF);   // chances per km of following
          diag.contested++; diag.pSum += pPass;
          if (rng.u() < pPass) {
            // slot in between prev and the car ahead of it (a pass takes one place)
            const room = last - second;
            end[i] = Math.min(end[i], last - Math.min(0.3 + 0.4 * rng.u(), 0.5 * room));
            const zi = rng.pick(zones.map((zz) => zz.w));
            events.push({ lap, type: "pass", c: i, on: ahead, zone: zi, f: zones[zi].f });
          } else if (end[i] < last + ot.min_gap) { end[i] = last + ot.min_gap + rng.exp(FOLLOW_EXTRA); held[i] = true; }
        } else if (end[i] < last + ot.min_gap) { end[i] = last + ot.min_gap + rng.exp(FOLLOW_EXTRA); held[i] = true; }
        // a car on its in-lap turns into the pit lane before the line: it does not hold up the cars behind
        if (inl[i]) { prev = i; continue; }
        if (end[i] >= last) { second = last; last = end[i]; lastCar = i; } else if (end[i] > second) second = end[i];
        prev = i;
      }
    }
    const row = [];
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const dur = end[i] - cum[i];
      // sector split: profile fractions, pit time in S3 (in-lap) / S1 (out-lap), loss in a random sector
      // (an out-lap that is also an in-lap: its pit time, counted once, is split between the two ends)
      const both = inl[i] && outl[i] ? 0.5 : 1;
      const extraIn = inl[i] ? pitAdd[i] * both : 0, extraOut = outl[i] ? pitAdd[i] * both : 0;
      const clean = Math.max(dur - extraIn - extraOut, dur * 0.5);
      const s = sectors.map((f) => clean * f);
      s[0] += dur - clean - extraIn; s[2] += extraIn;
      row.push({ c: i, dur, cum: end[i], s, pit: inl[i] ? "in" : outl[i] ? "out" : null, pt: extraIn + extraOut, held: held[i],
                 mg: ease[i] > 0 ? 1 : 0 });
      cum[i] = end[i];
      age[i] = outl[i] ? 1 : age[i] + 1;
      row.at(-1).plan = S[i].plan ? { k: S[i].plan.k, next: S[i].plan.next } : null;
      row.at(-1).age = age[i];
      if (refuel) { fuel[i] = Math.max(0, fuel[i] - 1); row.at(-1).fuel = fuel[i]; }
      if (inl[i]) {
        stopLaps[i].push(lap); stopsDone[i]++;
        if (damage[i] > 0) { events.push({ lap, type: "repair", c: i }); damage[i] = 0; }
        age[i] = 0;                                    // new tyres from the out-lap (age 1 after it)
        if (refuel) {                                  // load fuel for the next planned stint
          S[i].fuelLeft = laps;                        // the tank is being filled: any stint length is open
          const ev = S[i].evaluate(lap + 1, 0, R.pitLoss, R.pitLoss, { any: false, noStop: 0, at: () => 0 });
          fuel[i] = Math.min(laps - lap, ev.best.x + 1);
        }
      }
    }
    for (let i = 0; i < n; i++) boxedLast[i] = inl[i];
    // replay, refuel era: the tank holds what the car really ran to its next stop
    if (fz && refuel) for (let i = 0; i < n; i++) if (alive[i]) fuel[i] = Math.max(1, rpNext(i, lap) - lap);
    lapRows.push(row);
    // retirements during the next lap (recorded at this lap's end, fraction f into the next)
    if (fz) {
      // replay: a car whose record ends here is out (a classified car has taken its flag)
      for (let i = 0; i < n; i++) if (alive[i] && RP.t[i].length === lap && lap < laps && !(RP.ext && RP.fin?.[i])) {
        alive[i] = false;
        if (!RP.fin?.[i]) events.push({ lap: lap + 1, type: "retire", c: i, cause: RP.cause?.[i] ?? "mechanical", f: 0.1 + 0.8 * rng.u(), text: RP.why?.[i] ?? null });
      }
    } else if (lap < laps) {
      const calm = scLaps.has(lap + 1) || vscLaps.has(lap + 1);    // behind the SC: no crashes, fewer failures
      for (let i = 0; i < n; i++) {
        if (!alive[i]) continue;
        const u = rng.u();
        const pm = calm ? 0.5 * cs[i].pMech : cs[i].pMech, pi = calm ? 0 : cs[i].pInc;
        if (u < pm + pi) {
          alive[i] = false;
          const cause = u < pm ? "mechanical" : "incident";
          const f = rng.u();
          events.push({ lap: lap + 1, type: "retire", c: i, cause, f });
          const q = cause === "incident" ? R.scQ : SC_MECH_W * R.scQ;
          if (rng.u() < q) {
            // deploy from the first lap the leader starts after the car stops (a car far behind the leader
            // stops after the leader has begun lap+2)
            const tStop = cum[i] + f * baseLap, leadNext = Math.min(...cum.filter((_, j) => alive[j] || j === i)) + baseLap;
            const k = Math.max(0, Math.ceil((tStop - leadNext) / baseLap));
            neutralise(lap + 2 + k, R.year >= VSC_YEAR && rng.u() < (cause === "incident" ? 0.4 : 0.6) ? "vsc" : "sc", cause);
          }
        }
      }
      if (R.scDebris > 0 && rng.u() < R.scDebris) neutralise(lap + 2, R.year >= VSC_YEAR && rng.u() < 0.5 ? "vsc" : "sc", "debris");
    }
    // managing: cars with a safe gap behind ease to the follower's pace. The follower's own (unmanaged) pace,
    // not its managed one: chaining managed targets from the back stacked the easing along the field
    // (a leader ended up >10% off its pace after a lapped car opened a big gap behind someone).
    const live = [...Array(n).keys()].filter((i) => alive[i]).sort((x, y) => cum[x] - cum[y]);
    target.fill(null);
    for (let k = live.length - 2; k >= 0; k--) {
      const i = live[k], j = live[k + 1];
      const g = cum[j] - cum[i];
      if (g <= MANAGE_GAP * R.lenF) continue;
      // a car that can still catch the one ahead (pace edge over the laps left) races it instead
      if (k > 0) {
        const a = live[k - 1], gapA = cum[i] - cum[a];
        const reach = (base(cs[a], a) - base(cs[i], i)) * baseLap / 100 * (laps - lap);
        if (reach > gapA - 1) continue;
      }
      target[i] = expect(cs[j], j) + Math.min(MANAGE_CAP, 100 * relax * (g - MANAGE_GAP * R.lenF) / baseLap);
    }
    for (let i = 0; i < n; i++) {
      const want = target[i] !== null ? clamp(target[i] - base(cs[i], i), 0, MANAGE_MAX) : 0;
      ease[i] += clamp(want - ease[i], -MANAGE_STEP, MANAGE_STEP);
    }
  }
  cs.forEach((c, i) => { c.stops = stopLaps[i]; });
  const out = finish(R, lapRows, events);
  out.diag = diag;
  return out;
}

// Classification: the leader finishes after `laps`; everyone else finishes at their first crossing
// after the leader's finish time (so lapped cars complete fewer laps).
function finish(R, lapRows, events) {
  const { cs, laps } = R;
  const n = cs.length;
  const crossings = Array.from({ length: n }, () => []);
  lapRows.forEach((row, l) => row.forEach((r) => crossings[r.c].push([l + 1, r.cum])));
  const finishers = crossings.map((x, i) => [i, x.length === laps ? x[laps - 1][1] : Infinity]).filter(([, t]) => isFinite(t));
  const T = Math.min(...finishers.map(([, t]) => t));
  const res = cs.map((c, i) => {
    const x = crossings[i];
    const k = x.findIndex(([, t]) => t >= T - 1e-9);
    const retired = events.find((e) => e.type === "retire" && e.c === i);
    if (retired && (k < 0)) return { c: i, status: "retired", cause: retired.cause, laps: x.length, time: x.length ? x[x.length - 1][1] : 0 };
    if (k < 0) return { c: i, status: "retired", laps: x.length, time: Infinity };
    return { c: i, status: "finished", laps: x[k][0], time: x[k][1] };
  });
  res.sort((a, b) => (a.status !== b.status ? (a.status === "finished" ? -1 : 1)
    : b.laps - a.laps || a.time - b.time));
  res.forEach((r, p) => { r.pos = p + 1; });
  const lead = res.filter((r) => r.status === "finished" && r.laps === laps);
  const OUT = {
    config: R.config, laps, baseLap: R.baseLap, layout: R.layout, sectors: R.sectors, zones: R.zones,
    cars: cs.map((c, i) => ({ i: c.i, driver: c.driver, name: c.name, code: c.code, helmet: c.helmet, car: c.car,
                           carName: c.carName, carYear: c.carYear, grid: c.grid, stops: c.stops, pace: c.pace,
                           deg: c.deg, life: R.strategists[i].life, aggression: R.strategists[i].aggression,
                           read: R.strategists[i].read, s0: R.config.replay?.s0?.[i] ?? 0 })),
    year: R.year, refuel: refuelEra(R.year), mandatoryStop: R.strategists[0]?.mandatory ?? false,
    laps_table: lapRows, events, result: res,
    margin_s: lead.length > 1 ? lead[1].time - lead[0].time : null,
    gap5_s: lead.length > 4 ? lead[4].time - lead[0].time : null,
  };
  Object.defineProperty(OUT, "_track", { value: R.track, enumerable: false });   // (the playback's era profile)
  return OUT;
}

// Same definitions as f1rank/gamedb/validation.py
export function raceStats(out) {
  const n = out.cars.length;
  let swaps = 0;
  const rows = out.laps_table;
  for (let l = 1; l < rows.length; l++) {
    const a = new Map(rows[l - 1].map((r) => [r.c, r])), b = new Map(rows[l].map((r) => [r.c, r]));
    const ids = [...b.keys()].filter((c) => a.has(c) && !a.get(c).pit && !b.get(c).pit);
    for (let x = 0; x < ids.length; x++) for (let y = x + 1; y < ids.length; y++) {
      const p = ids[x], q = ids[y];
      if (Math.sign(a.get(p).cum - a.get(q).cum) * Math.sign(b.get(p).cum - b.get(q).cum) < 0) swaps++;
    }
  }
  const l1 = [...rows[0]].sort((p, q) => p.cum - q.cum);
  let sw1 = 0; l1.forEach((r, k) => { sw1 += Math.abs(out.cars[r.c].grid - (k + 1)); });
  const ret = out.events.filter((e) => e.type === "retire");
  return {
    margin_s: out.margin_s, gap5_s: out.gap5_s,
    n_classified: out.result.filter((r) => r.status === "finished").length,
    n_mech: ret.filter((e) => e.cause === "mechanical").length,
    n_incident: ret.filter((e) => e.cause === "incident").length,
    swaps, swaps_lap1: sw1 / 2,
    order: out.result.filter((r) => r.status === "finished").map((r) => out.cars[r.c].driver),
    n,
  };
}

// The sim's expected lap times for a real race's reconstruction (f1rank/history, docs/GAME_PLAN.md section 17): per
// car and lap, the lap the sim expects with no traffic, stops or incidents (car + driver pace from the ratings, the
// era's fuel trend, wet running; the opening lap's launch and grid slot), and the car's lap-to-lap noise (s). The
// reconstruction conditions this prior on the data (crossings, order, finish times, fastest laps).
export function lapPrior(dbRaw, config, track = null) {
  const R = setupRace(dbRaw, { ...config, uncertainty: false, grid: "fixed" }, track);
  const { cs, era, laps, baseLap, wet } = R;
  const mu = cs.map((c) => {
    const a = [];
    for (let lap = 1; lap <= laps; lap++) {
      const fuelC = (laps - lap) - laps / 2;
      let d = baseLap * Math.exp((c.pace + era.phi * R.lenF * fuelC + WET_SLOW * wet * c.wetLoad) / 100);
      if (lap === 1) d = d * era.lap1_factor - START_SKILL_S * c.starts + START_SLOT * (c.grid - 1);
      a.push(d);
    }
    return a;
  });
  const sd = cs.map((c) => baseLap * c.sigma / 100);
  return { baseLap, laps, mu, sd, pitLoss: R.pitLoss, sd1: config.year <= 1993 ? START_NOISE_TURBO : START_NOISE };
}
