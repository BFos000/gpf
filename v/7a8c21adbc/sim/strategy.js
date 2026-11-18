// Race strategy: one strategist per car, re-planning at the start of every lap.
//
// The strategist uses the same tyre and fuel model as the race sim, so its choices are optimal for
// the race being simulated:
//   lap-time cost of tyre age a (pct of lap):   deg * a  +  CLIFF * max(0, a - life)^2
//   refuel era, fuel on board (laps of fuel f): FUEL_PCT * (f - fRef)
// `life` is the per-year tyre life, fitted so the planned stop counts match each year's real
// distribution (game/tools/fit_strategy.mjs -> eras.tyre_life). Linear wear alone makes one stop
// optimal everywhere after 2010; the cliff is what made 2013-16 two- and three-stop races.
//
// Each lap the strategist compares "box this lap" with every later stop lap, given the best plan
// for the rest of the race. On top of that it weighs track position:
//   safety car          the stop costs ~40% less while the SC is out
//   undercut            car ahead within reach and fresh tyres would gain more than the gap
//   cover               the car just behind has pitted and could undercut us
//   traffic             stopping now would drop us in behind a slower car: wait a lap
//   damage              a repair stop when the time lost to damage outweighs it
//   rules               from 2007 a dry race needs at least one stop (two compounds)
// Every decision is logged with its reasoning (events of type "strategy").

export const CLIFF = 0.012;          // pct per lap^2 beyond tyre life
export const FUEL_PCT = 0.08;        // pct per lap of fuel on board (refuel era, ~0.07 s/lap)
export const REPAIR_S = 7;           // extra stationary time to fix damage
const POS_VALUE = 4.0;               // s a strategist will give up for one track position (scaled by aggression)
const TRAFFIC_S = 2.5;               // s lost rejoining right behind a slower car
const UNDERCUT_REACH = 3.5;          // s: the car ahead is a target inside this gap
const MIN_STINT = 4;
const MAX_STOPS = 5;
const READ_SD = 0.25;               // strategist's misjudgement of its own tyre wear (log sd)

export const refuelEra = (year) => year >= 1994 && year <= 2009;
export const mandatoryStop = (year, wet) => year >= 2007 && wet < 0.3;

// per-year stint cost scale (tyre wear and fuel weight), fitted to real stop counts
export function stintScale(db, year) {
  const t = db.eras.stint_scale;
  if (!t) return 1;
  if (t[year] != null) return t[year];
  const ys = Object.keys(t).map(Number);
  return t[ys.reduce((a, b) => (Math.abs(b - year) < Math.abs(a - year) ? b : a))];
}

export function tyreLife(db, year) {
  const t = db.eras.tyre_life;
  if (!t) return 1e9;
  if (t[year] != null) return t[year];
  const ys = Object.keys(t).map(Number);
  const y = ys.reduce((a, b) => (Math.abs(b - year) < Math.abs(a - year) ? b : a));
  return t[y];
}

// per-car lap-time cost (seconds) of tyre age, and cumulative sums
function wearTable(c, life, baseLap, laps, lenF = 1) {
  const s = baseLap / 100;
  const f = new Float64Array(laps + 2), F = new Float64Array(laps + 2);
  for (let a = 1; a <= laps + 1; a++) {
    f[a] = s * (c.deg * a + CLIFF * lenF ** 2 * Math.max(0, a - life) ** 2);
    F[a] = F[a - 1] + f[a];
  }
  return { f, F };
}

export class Strategist {
  constructor(R, c, i, rng) {
    this.R = R; this.c = c; this.i = i;
    // tyre life in laps: the fitted life is for a LEN_REF_KM lap (c.deg is already per lap of this length)
    const lenF = R.lenF ?? 1;
    const life = R.tyreLife / lenF * Math.min(1.4, Math.max(0.7, Math.sqrt((R.era.deg || 0.01) * lenF / Math.max(c.deg, 1e-4))));
    this.life = life;
    // the strategist plans on its own read of tyre wear, which can be off (log-normal, READ_SD)
    this.read = Math.exp(READ_SD * (c.readMul ?? 1) * rng.normal());
    this.t = wearTable({ deg: c.deg * this.read }, life, R.baseLap, R.laps, R.lenF ?? 1);
    this.cache = new Map();
    this.bC = new Float64Array(R.laps + 2).fill(NaN); this.bK = new Int8Array(R.laps + 2);
    this.refuel = refuelEra(R.year);
    this.fuelS = (FUEL_PCT * (R.stintScale ?? 1) * (R.lenF ?? 1) * R.baseLap) / 100;
    this.aggression = 0.7 + 0.6 * rng.u();          // drawn for every car, whatever the race brings
    this.mandatory = mandatoryStop(R.year, R.wet);
    this.stops = 0;
    this.plan = null;                               // {k, next, laps:[...]}
    this.lastReason = null;
    this.user = null;                               // user override state
    this.targetK = null;                            // user: stops to make from here
  }
  setWear(mult) { this.t = wearTable({ deg: this.c.deg * this.read * mult }, this.life, this.R.baseLap, this.R.laps, this.R.lenF ?? 1); this.cache.clear(); this.bC.fill(NaN); }
  restCost(Rm) {                                    // best(Rm, normal pit loss), cached in typed arrays
    let v = this.bC[Rm];
    if (v !== v) { const b = this.best(Rm, this.R.pitLoss, 0); this.bC[Rm] = v = b.cost; this.bK[Rm] = b.k; }
    return v;
  }
  // stint cost: x laps starting from tyre age a (and, refuel era, carrying x laps of fuel)
  stint(a, x) {
    const { F } = this.t;
    const lim = F.length - 1;
    const tyre = F[Math.min(a + x, lim)] - F[Math.min(a, lim)];
    const fuel = this.refuel ? this.fuelS * x * (x - 1) / 2 : 0;
    return tyre + fuel;
  }
  // best cost of R laps from fresh tyres with k stops (near-equal stints), and the best k
  best(R, P, minStops = 0) {
    const key = R * 4096 + Math.round(P * 8) * 8 + minStops;
    const hit = this.cache.get(key);
    if (hit) return hit;
    let bk = 0, bc = Infinity;
    for (let k = minStops; k <= MAX_STOPS; k++) {
      if ((k + 1) * MIN_STINT > R && k > minStops) break;
      const n = k + 1, x = Math.floor(R / n), r = R - x * n;
      // r stints of x+1 laps and n-r of x laps
      const cost = k * P + r * this.stint(0, x + 1) + (n - r) * this.stint(0, x);
      if (cost < bc) { bc = cost; bk = k; }
    }
    const out = { cost: bc, k: bk };
    this.cache.set(key, out);
    return out;
  }
  // options for this lap: run x more laps on these tyres then stop (x = 1: box this lap), or run
  // to the flag. Returns the best option, "box now" (x=1), "box next lap" (x=2), the runner-up and
  // the best option with a different stop count (for the reasoning text). No arrays: hot path.
  evaluate(lap, age, P, Pnow, repair) {
    const Rem = this.R.laps - lap + 1;              // laps left including this one
    const needStop = this.mandatory && this.stops === 0;
    const tk = this.targetK;
    let best = null, second = null, now = null, x2 = null;
    const alt = new Map();                          // best per stop count
    const consider = (o) => {
      if (tk != null && o.k !== tk) { o.off = true; }
      if (!o.off) {
        if (!best || o.cost < best.cost) { second = best; best = o; }
        else if (!second || o.cost < second.cost) second = o;
      }
      const a = alt.get(o.k); if (!a || o.cost < a.cost) alt.set(o.k, o);
    };
    // run to the flag: not with a mandatory stop still to make, nor (refuel era) on a load that can't reach it
    const canFinish = !this.refuel || (this.fuelLeft ?? Rem) >= Rem;
    if (!needStop && canFinish) consider({ x: Rem, cost: this.stint(age, Rem) - repair.noStop, k: 0 });
    const maxX = this.refuel ? Math.min(Rem - 1, Math.max(1, this.fuelLeft ?? Rem)) : Rem - 1;
    const F = this.t.F, lim = F.length - 1, Fa = F[Math.min(age, lim)];
    const fuelS = this.refuel ? this.fuelS : 0;
    let bx = -1, bcost = Infinity, sx = -1, scost = Infinity;
    const hasRepair = repair.any;
    for (let x = 1; x <= maxX; x++) {
      const rc = this.restCost(Rem - x);
      const cost = F[Math.min(age + x, lim)] - Fa + fuelS * x * (x - 1) / 2 + (x === 1 ? Pnow : P) + rc - (hasRepair ? repair.at(x) : 0);
      const k = 1 + this.bK[Rem - x];
      if (x <= 2 || tk != null) {                   // keep full objects only where they are needed
        const o = { x, cost, k };
        if (x === 1) now = o; else if (x === 2) x2 = o;
        consider(o);
        continue;
      }
      const a = alt.get(k); if (!a || cost < a.cost) alt.set(k, { x, cost, k });
      if (cost < bcost) { sx = bx; scost = bcost; bx = x; bcost = cost; } else if (cost < scost) { sx = x; scost = cost; }
    }
    if (bx > 0) consider({ x: bx, cost: bcost, k: 1 + this.bK[Rem - bx] });
    if (sx > 0) consider({ x: sx, cost: scost, k: 1 + this.bK[Rem - sx] });
    if (!best) {                                    // the user's stop count is not possible: ignore it
      for (const o of alt.values()) if (!best || o.cost < best.cost) best = o;
    }
    let altK = null;
    for (const [k, o] of alt) if (k !== best.k && (!altK || o.cost < altK.cost)) altK = o;
    return { best, second, now: now && !now.off ? now : null, x2, altK };
  }
}

// Decide every car's pit call for this lap. `st` = race state at the start of the lap.
export function decideLap(R, strategists, st) {
  const { lap, alive, cum, age, damage, sc, expect, calls } = st;
  const n = strategists.length;
  const P = R.pitLoss, Pnow = sc ? 0.6 * R.pitLoss : R.pitLoss;
  const order = [...Array(n).keys()].filter((i) => alive[i]).sort((a, b) => cum[a] - cum[b]);
  const posOf = new Map(order.map((i, k) => [i, k]));
  const box = new Array(n).fill(false);
  const log = [];
  for (const i of order) {
    const S = strategists[i], c = S.c;
    if (lap === 1 || lap >= R.laps) continue;
    const a = age[i];
    const dmgS = (damage[i] * R.baseLap) / 100;
    const repair = { any: dmgS > 0, noStop: 0, at: (x) => (dmgS > 0 ? dmgS * (R.laps - lap + 1 - x) - REPAIR_S : 0) };
    const ev = S.evaluate(lap, a, P, Pnow, repair);
    const { best, now } = ev;
    // plan bookkeeping (what the strategist currently intends)
    const plan = { k: best.k, next: best.x >= R.laps - lap + 1 ? null : lap + best.x - 1 };
    const user = calls?.get(i);
    // ---- user calls override the CPU
    if (user) {
      if (user.box === lap) { box[i] = true; log.push({ c: i, act: "box", why: "user", text: "Boxing on your call." }); S.stops++; continue; }
      if (user.stayUntil && lap <= user.stayUntil) { S.plan = plan; continue; }
    }
    if (!now || a < MIN_STINT && dmgS === 0) { noteplan(S, plan, lap, log, i, ev); continue; }
    let why = null, text = null;
    const delta = now.cost - best.cost;            // what boxing now costs vs the best plan (s)
    const posVal = POS_VALUE * S.aggression;
    // undercut / cover only bring forward a stop we were going to make anyway (no extra stop)
    const stopPlanned = best.k >= 1 && now.k <= best.k;
    // track position: undercut on the car ahead
    const k = posOf.get(i);
    const ahead = k > 0 ? order[k - 1] : -1, behind = k + 1 < order.length ? order[k + 1] : -1;
    const gapAhead = ahead >= 0 ? cum[i] - cum[ahead] : Infinity;
    const gapBehind = behind >= 0 ? cum[behind] - cum[i] : Infinity;
    if (best.x === 1) {
      why = sc && Pnow < P ? "sc" : dmgS > 0.3 && repair.at(1) > 0 ? "repair" : "window";
    } else if (stopPlanned && ahead >= 0 && gapAhead < UNDERCUT_REACH && delta < posVal && age[ahead] >= MIN_STINT) {
      const Sa = strategists[ahead];
      const gain = Sa.t.f[Math.min(age[ahead] + 1, Sa.t.f.length - 1)] - S.t.f[1]
                 + 0.5 * (Sa.t.f[Math.min(age[ahead] + 2, Sa.t.f.length - 1)] - S.t.f[2]);
      if (gain > gapAhead + 0.3) { why = "undercut"; text = `Undercut on ${R.cs[ahead].code ?? R.cs[ahead].name}: ${gapAhead.toFixed(1)} s ahead, fresh tyres worth ~${gain.toFixed(1)} s.`; }
    }
    if (!why && stopPlanned && behind >= 0 && st.pittedLast?.[behind] && gapBehind < UNDERCUT_REACH + 1 && delta < posVal) {
      why = "cover"; text = `Covering ${R.cs[behind].code ?? R.cs[behind].name}: they stopped from ${gapBehind.toFixed(1)} s behind.`;
    }
    if (why) {
      // traffic check: where would we rejoin? (projected crossings at the end of this lap)
      const mine = cum[i] + R.baseLap * (1 + expect(i) / 100) + Pnow;
      let blocker = -1, bGap = Infinity;
      for (const j of order) {
        if (j === i) continue;
        const theirs = cum[j] + R.baseLap * (1 + expect(j) / 100);
        const g = mine - theirs;
        if (g > 0 && g < 1.5 && g < bGap && expect(j) > S.c.pace + S.c.deg + 0.3) { bGap = g; blocker = j; }
      }
      const nextCost = ev.x2?.cost ?? Infinity;
      if (blocker >= 0 && why !== "sc" && why !== "repair" && nextCost - now.cost < TRAFFIC_S) {
        log.push({ c: i, act: "stay", why: "traffic", text: `Staying out a lap: would rejoin ${bGap.toFixed(1)} s behind ${R.cs[blocker].code ?? R.cs[blocker].name} in traffic.` });
        S.plan = plan; continue;
      }
      box[i] = true; S.stops++;
      text = text ?? (why === "sc" ? `Safety car: the stop costs ${(P - Pnow).toFixed(0)} s less now.`
        : why === "repair" ? `Repair: damage is costing ${dmgS.toFixed(2)} s a lap.`
        : `In the window: ${best.k === 1 ? "this is the last stop" : `${best.k} stops from here, this one included`}${ev.second ? (ev.second.cost - best.cost < 0.1 ? "; a toss-up with the next option" : `; ${(ev.second.cost - best.cost).toFixed(1)} s better than the next option`) : ""}.`);
      log.push({ c: i, act: "box", why, text });
      S.plan = { k: plan.k, next: lap };
    } else noteplan(S, plan, lap, log, i, ev);
  }
  return { box, log };
}

function noteplan(S, plan, lap, log, i, ev) {
  const prev = S.plan;
  S.plan = plan;
  if (!prev) {
    log.push({ c: i, act: "plan", why: "start", text: planText(plan, ev, S) });
  } else if (prev.k !== plan.k || (prev.next && plan.next && Math.abs(prev.next - plan.next) >= 4) || (!prev.next) !== (!plan.next)) {
    log.push({ c: i, act: "plan", why: "replan", text: `New plan: ${planText(plan, ev, S)}` });
  }
}
function planText(plan, ev, S) {
  if (plan.next === null) return S.stops ? "no more stops, run to the flag." : "no stop, run to the flag.";
  const alt = ev.altK;
  const k = plan.k;
  return `${k} stop${k === 1 ? "" : "s"}${S.stops ? " more" : ""}, next around lap ${plan.next}` +
    (alt ? ` (${alt.k}-stop is ${(alt.cost - ev.best.cost).toFixed(1)} s slower)` : "") + ".";
}
