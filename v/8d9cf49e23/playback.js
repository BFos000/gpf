// Playback: turns a simulated race (lap table + events) into car state at any race time t.
// Within a lap, cars move through each sector by the track's time-fraction profile (slow in
// corners, fast on straights); pit time is spent stationary in the pit box at the end of the in-lap
// and the start of the out-lap. Live timing uses the three sector lines as timing points.

const GRID_SLOT_M = 8;            // metres between grid slots
const SC_AHEAD_M = 70;            // the safety car runs this far ahead of the leader
export const PIT_IN_M = 300, PIT_OUT_M = 250;   // pit lane: entry before the line, exit after it

export function buildPlayback(out, track) {
  const N = track.x.length, L = track.length_m;
  const tt = track.t;
  const secT = [0, tt[track.sectors[0]], tt[track.sectors[1]], 1];
  const nLaps = out.laps;
  const res = new Map(out.result.map((r) => [r.c, r]));

  const cars = out.cars.map((c) => ({ ...c, laps: [], pts: [], stopsAt: [], finT: Infinity, retT: Infinity,
                                      retFrac: 0, retLap: 0, retCause: null, best: Infinity, bestLap: 0 }));
  out.laps_table.forEach((row, l) => row.forEach((r) => {
    cars[r.c].laps.push({ lap: l + 1, start: r.cum - r.dur, end: r.cum, dur: r.dur, s: r.s, pit: r.pit, pt: r.pt ?? 0,
                          plan: r.plan ?? null, age: r.age ?? null, fuel: r.fuel ?? null });
  }));
  // neutralised laps (SC / VSC)
  const neutral = new Set();
  for (const k of ["sc", "vsc"]) {
    let a0 = null;
    for (const e of out.events) {
      if (e.type === `${k}_start`) a0 = e.lap;
      else if (e.type === `${k}_end` && a0 != null) { for (let l = a0; l <= e.lap; l++) neutral.add(l); a0 = null; }
    }
  }
  for (const c of cars) {
    const r = res.get(c.i);
    if (r.status === "finished") { c.laps = c.laps.slice(0, r.laps); c.finT = r.time; c.finLap = r.laps; }
    const ret = out.events.find((e) => e.type === "retire" && e.c === c.i);
    if (ret && r.status !== "finished") {
      c.laps = c.laps.slice(0, ret.lap - 1);
      const last = c.laps.at(-1);
      let typical = last ? last.dur : out.baseLap * 1.1;
      // a car that stops during a neutralised lap drives there at the queue's pace (the car ahead's lap), not its own
      if (last && neutral.has(ret.lap)) {
        const prevRow = out.laps_table[ret.lap - 2] ?? [], row = out.laps_table[ret.lap - 1] ?? [];
        const ahead = prevRow.filter((x) => x.cum < last.end && row.some((y) => y.c === x.c)).sort((x, y) => y.cum - x.cum)[0];
        const lapA = ahead && row.find((y) => y.c === ahead.c);
        if (lapA && !lapA.pit) typical = Math.max(typical, lapA.cum + 0.4 - last.end);
      }
      c.retT = (last ? last.end : 0) + ret.f * typical;
      c.retFrac = ret.f; c.retLap = ret.lap; c.retCause = ret.cause; c.retDur = typical;
    }
    for (const lp of c.laps) {
      c.pts.push(lp.start + lp.s[0], lp.start + lp.s[0] + lp.s[1], lp.end);
      if (lp.pit === "in") c.stopsAt.push({ t: lp.end - lp.pt * 0.5, lap: lp.lap });
      if (!lp.pit && lp.dur < c.best) { c.best = lp.dur; c.bestLap = lp.lap; }
    }
  }
  const tEnd = Math.max(...cars.map((c) => (isFinite(c.finT) ? c.finT : isFinite(c.retT) ? c.retT : c.laps.at(-1)?.end ?? 0)));

  // leader lap boundaries (for lap counter and SC periods)
  const leadEnd = out.laps_table.map((row) => Math.min(...row.map((r) => r.cum)));
  // neutralisations: [first lap, last lap] from the sim events; periods in race time run from the leader starting
  // the first neutralised lap to the leader finishing the last one
  const periodsOf = (kind) => {
    const ls = [];
    for (const e of out.events) if (e.type === `${kind}_start`) ls.push([e.lap, null, e]);
      else if (e.type === `${kind}_end` && ls.length && ls.at(-1)[1] === null) { ls.at(-1)[1] = e.lap; ls.at(-1).push(e); }
    return ls.map(([a, b, , eEnd]) => ({ a, b: b ?? a, t0: a > 1 ? leadEnd[a - 2] : 0, t1: leadEnd[(b ?? a) - 1],
                                          tLast: (b ?? a) > 1 ? leadEnd[(b ?? a) - 2] : 0, unlap: !!eEnd?.unlap }));
  };
  const scP = periodsOf("sc"), vscP = periodsOf("vsc");
  const scLaps = scP.map((p) => [p.a, p.b]);
  const scPeriods = scP.map((p) => [p.t0, p.t1]);
  const deployWhy = out.events.filter((e) => e.type === "sc_deploy" || e.type === "vsc_deploy");

  // events with times, for the feed
  const feed = [];
  const lapOf = (c, lap) => cars[c].laps.find((x) => x.lap === lap);
  for (const e of out.events) {
    const lp = e.c !== undefined ? lapOf(e.c, e.lap) : null;
    if (e.type === "pass" && lp) feed.push({ t: lp.start + (e.f ?? 0.5) * lp.dur, lap: e.lap, kind: "pass", c: e.c, on: e.on });
    else if (e.type === "retire") feed.push({ t: cars[e.c].retT, lap: e.lap, kind: "retire", c: e.c, cause: e.cause });
    else if (e.type === "loss" && lp && e.pct * out.baseLap / 100 > 1.5) feed.push({ t: lp.start + 0.5 * lp.dur, lap: e.lap, kind: "loss", c: e.c, s: e.pct * out.baseLap / 100 });
    else if (e.type === "damage" && lp) feed.push({ t: lp.start + 0.4 * lp.dur, lap: e.lap, kind: "damage", c: e.c });
  }
  // strategy log per car (shown on the pit wall), and the reason attached to each stop
  for (const c of cars) c.log = [];
  const boxWhy = new Map();
  for (const e of out.events) {
    if (e.type === "strategy") {
      const lp = lapOf(e.c, e.lap) ?? lapOf(e.c, e.lap - 1);
      const t = lp ? lp.start : 0;
      cars[e.c].log.push({ t, lap: e.lap, act: e.act, why: e.why, text: e.text });
      if (e.act === "box") boxWhy.set(`${e.c}:${e.lap}`, e);
    } else if (e.type === "call") {
      const lp = lapOf(e.c, e.lap) ?? lapOf(e.c, e.lap - 1);
      cars[e.c].log.push({ t: lp ? lp.start : 0, lap: e.lap, act: "call", why: e.action, text: callText(e) });
    }
  }
  for (const c of cars) for (const st of c.stopsAt) {
    const lp = lapOf(c.i, st.lap), nx = lapOf(c.i, st.lap + 1);
    const w = boxWhy.get(`${c.i}:${st.lap}`);
    feed.push({ t: lp.end - lp.pt, lap: st.lap, kind: "pit", c: c.i, s: lp.pt + (nx?.pt ?? 0), why: w?.why, text: w?.text });
  }
  const why = (kind, lap) => deployWhy.find((e) => e.type === `${kind}_deploy` && e.lap === lap)?.why ?? null;
  for (const p of scP) {
    feed.push({ t: p.t0, lap: p.a, kind: "sc", why: why("sc", p.a) });
    if (p.b > p.a) feed.push({ t: p.tLast, lap: p.b, kind: "sc_in", unlap: p.unlap });
    feed.push({ t: p.t1, lap: p.b, kind: "sc_end" });
  }
  for (const p of vscP) {
    feed.push({ t: p.t0, lap: p.a, kind: "vsc", why: why("vsc", p.a) });
    feed.push({ t: p.t1, lap: p.b, kind: "vsc_end" });
  }
  const winner = out.result[0];
  feed.push({ t: cars[winner.c].finT, lap: nLaps, kind: "flag", c: winner.c });
  feed.sort((a, b) => a.t - b.t);

  // overall fastest lap progression
  const bestTimes = [];
  for (const c of cars) for (const lp of c.laps) if (!lp.pit && lp.lap > 1) bestTimes.push({ t: lp.end, dur: lp.dur, c: c.i });
  bestTimes.sort((a, b) => a.t - b.t);

  // time fraction of the lap (0..1) -> fractional point index on the centreline
  function idxOfT(f) {
    if (f >= tt[N - 1]) return N - 1 + (f - tt[N - 1]) / (1 - tt[N - 1] || 1);
    let lo = 0, hi = N - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tt[m] <= f) lo = m; else hi = m; }
    return lo + (f - tt[lo]) / ((tt[hi] - tt[lo]) || 1);
  }
  function tAtIdx(x) {                       // inverse of idxOfT
    const i = Math.floor(x), fr = x - i;
    const a = tt[Math.min(i, N - 1)], b = i + 1 < N ? tt[i + 1] : 1;
    return a + fr * (b - a);
  }
  const tEntry = tAtIdx(N - PIT_IN_M / track.step_m), tExit = tAtIdx(PIT_OUT_M / track.step_m);
  // fraction of lap time through a lap record at elapsed e (null = stationary in the pit box)
  // Fraction of lap time reached at elapsed e, or {pit: u} while in the pit lane (u in [0, 0.5] =
  // entry to box on the in-lap, [0.5, 1] = box to exit on the out-lap). Cars run at their normal
  // pace on track; the in-lap leaves the track at the pit entry and the out-lap joins at the exit,
  // and the remaining time of those laps is spent in the lane.
  function lapTimeFrac(lp, e, start) {
    const D = lp.end - start;
    const pin = lp.pit === "in" ? lp.pt : 0, pout = lp.pit === "out" ? lp.pt : 0;
    const run = D - pin - pout;                        // a full lap of running at this lap's pace
    const sd = [lp.s[0] - pout, lp.s[1], lp.s[2] - pin].map((x) => Math.max(x, 0.01));
    const k = run / (sd[0] + sd[1] + sd[2]);
    const fracAt = (x) => {                            // running time x -> lap time fraction
      let acc = 0;
      for (let j = 0; j < 3; j++) {
        const d = sd[j] * k;
        if (x <= acc + d || j === 2) return secT[j] + (secT[j + 1] - secT[j]) * Math.min(1, Math.max(0, (x - acc) / d));
        acc += d;
      }
      return 1;
    };
    const timeTo = (f) => {                            // inverse of fracAt
      let acc = 0;
      for (let j = 0; j < 3; j++) {
        const d = sd[j] * k;
        if (f <= secT[j + 1] || j === 2) return acc + d * (f - secT[j]) / (secT[j + 1] - secT[j]);
        acc += d;
      }
      return run;
    };
    if (pout) {
      const lane = pout + timeTo(tExit);               // box + lane to the exit
      if (e < lane) return { pit: 0.5 + 0.5 * Math.max(0, (e / lane - 0.2) / 0.8) };
      return fracAt(e - pout);
    }
    if (pin) {
      const onTrack = timeTo(tEntry);
      if (e > onTrack) return { pit: 0.5 * Math.min(1, (e - onTrack) / (D - onTrack) / 0.8) };
      return fracAt(e);
    }
    return fracAt(e);
  }
  const findLap = (c, t) => {               // index of the lap in progress at t (laps[k].start <= t < end)
    const a = c.laps; let lo = 0, hi = a.length - 1;
    if (!a.length || t < a[0].start) return 0;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m].start <= t) lo = m; else hi = m - 1; }
    return lo;
  };

  // state of car c at time t
  function carAt(c, t) {
    const g = (c.grid - 1) * GRID_SLOT_M + 6;
    if (t >= c.finT) {
      return { state: "fin", done: c.finLap, idx: Math.min(300, 12 + (t - c.finT) * 15) / track.step_m, progress: c.finLap + 1e-3 * (c.finT - t) };
    }
    if (t >= c.retT) {
      const idx = c.retFrac * N;
      return { state: "dnf", done: c.retLap - 1, idx, progress: -1000 - (tEnd - c.retT) };
    }
    if (t <= 0) return { state: "grid", done: 0, idx: (N - g / track.step_m) % N, progress: -g / L };
    const k = findLap(c, t);
    const lp = c.laps[k];
    if (!lp) {                                 // retired on lap 1 before completing it: crawl to the retirement point
      const f = Math.min(1, t / (c.retT || 1)) * c.retFrac;
      return { state: "run", done: 0, idx: f * N, progress: f };
    }
    if (t >= lp.end) {                         // past the last recorded lap, before retirement
      // along the lap's time profile (like the running cars), reaching the stopping point at retT
      const tR = tAtIdx(c.retFrac * N);
      const idx = Math.min(c.retFrac * N, idxOfT(tR * Math.min(1, (t - lp.end) / Math.max(1e-6, c.retT - lp.end))));
      return { state: "run", done: lp.lap, idx, progress: lp.lap + idx / N };
    }
    const start = lp.lap === 1 ? 0 : lp.start;
    const f = lapTimeFrac(lp, t - start, start);
    const done = lp.lap - 1;
    if (typeof f === "object") {
      // progress along the pit lane, which runs beside the track from the entry to the exit (box at the line):
      // cars on track keep passing a car in the lane, and cars in the lane keep their own order
      const u = f.pit, inM = PIT_IN_M / L, outM = PIT_OUT_M / L;
      const prog = lp.pit === "in" ? 1 - inM * (1 - Math.min(1, u / 0.5)) : outM * Math.max(0, (u - 0.5) / 0.5);
      return { state: "pit", done, idx: null, pitU: u, progress: done + Math.min(0.9995, Math.max(0.0005, prog)) };
    }
    if (lp.lap === 1) {                        // from the grid slot to the line along the same time profile
      const gi = N - g / track.step_m;           // grid slot as a point index on the previous lap
      const F0 = tAtIdx(gi) - 1;                 // its time fraction, negative
      const ff = F0 + (1 - F0) * f;
      const idx = ff < 0 ? idxOfT(ff + 1) : idxOfT(ff);
      const d = ff < 0 ? (idx - N) * track.step_m : idx * track.step_m;
      return { state: "run", done, idx: ((idx % N) + N) % N, progress: d / L };
    }
    const idx = idxOfT(f);
    return { state: lp.pit === "out" ? "out" : "run", done, idx, progress: done + idx / N };
  }

  // passes by lap, for the separation rule: a passing pair may run alongside on that lap
  const passPairs = new Set(out.events.filter((e) => e.type === "pass").map((e) => `${e.lap}:${e.c}:${e.on}`));
  const SEP_M = 6.5;
  // passes happen at their braking zone: the attacker stays behind until the victim reaches the
  // zone, draws alongside through the braking phase (zone start -> apex) and is ahead after the apex.
  // Each phase blends from the previous one, so positions stay continuous.
  const passesByLap = new Map();
  // (a free pass, on a car crawling or far off the pace, is not staged: the car goes by as soon as it gets there)
  for (const e of out.events) if (e.type === "pass" && !e.free) {
    const z = track.zones[e.zone];
    if (!z || z.start >= z.apex) continue;
    const k = `${e.lap}`;
    if (!passesByLap.has(k)) passesByLap.set(k, []);
    // the move starts with the run up to the braking point (slipstream), ~125 m before it
    passesByLap.get(k).push({ c: e.c, on: e.on, z0: Math.max(0, z.start - 125 / track.step_m), z1: z.apex });
  }
  function stagePasses(st) {
    for (const p of st) {
      if (p.state !== "run") continue;
      const list = passesByLap.get(`${p.done + 1}`);
      if (!list) continue;
      for (const e of list) {
        if (e.c !== p.c.i) continue;
        const v = st[e.on];
        if (v.state !== "run" || v.done !== p.done) continue;
        const sep = SEP_M / L;
        const before = Math.min(p.progress, v.progress - sep);
        const after = Math.max(p.progress, v.progress + sep);
        const w = Math.min(1, Math.max(0, (v.idx - e.z0) / (e.z1 - e.z0)));
        const np = (1 - w) * before + w * after;
        if (np !== p.progress) {
          p.progress = np;
          p.idx = ((((np - Math.floor(np)) * N) % N) + N) % N;
        }
        if (w > 0 && w < 1) { p.alongside = v.c.i; v.alongside = p.c.i; }
      }
    }
  }
  function separate(st) {
    const run = st.filter((x) => x.state === "run" || x.state === "out").sort((a, b) => b.progress - a.progress);
    for (let k = 1; k < run.length; k++) {
      const a = run[k - 1], b = run[k];
      const gap = (a.progress - b.progress) * L;
      if (gap >= SEP_M) continue;
      const lap = b.done + 1;
      if (passPairs.has(`${lap}:${b.c.i}:${a.c.i}`) || passPairs.has(`${lap}:${a.c.i}:${b.c.i}`)) {
        a.alongside = b.c.i; b.alongside = a.c.i; continue;
      }
      b.progress = a.progress - SEP_M / L;
      b.idx = ((((b.progress - Math.floor(b.progress)) * N) % N) + N) % N;
    }
  }
  const ptsBefore = (c, t) => { let lo = 0, hi = c.pts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (c.pts[m] <= t) lo = m + 1; else hi = m; } return lo; };

  // full timing picture at time t
  function snapshot(t) {
    const st = cars.map((c) => ({ c, ...carAt(c, t), P: ptsBefore(c, t) }));
    stagePasses(st);
    separate(st);
    const rank = (s) => (s.state === "fin" ? 2e6 - res.get(s.c.i).pos : s.state === "dnf" ? s.progress : s.progress);
    const order = [...st].sort((a, b) => rank(b) - rank(a));
    const lead = order[0];
    order.forEach((s, k) => {
      s.pos = k + 1;
      const timeAt = (o, P) => (P > 0 ? o.c.pts[P - 1] : 0);
      const gapTo = (o) => {                  // at the last timing line both have crossed
        if (s.P === 0 || o.P < s.P) return null;
        const down = Math.floor((o.P - s.P) / 3);
        if (down >= 1 && s.state !== "fin") return { laps: down };
        return { s: timeAt(s, s.P) - timeAt(o, s.P) };
      };
      s.gap = k === 0 ? null : gapTo(lead);
      s.int = k === 0 ? null : gapTo(order[k - 1]);
      const lastLap = s.c.laps.filter((x) => x.end <= t).at(-1);
      s.last = lastLap ? lastLap.dur : null;
      s.lastPit = lastLap?.pit ?? null;
      s.stops = s.c.stopsAt.filter((x) => x.t <= t).length;
      const lastStop = s.c.stopsAt.filter((x) => x.t <= t).at(-1);
      s.tyre = lastStop ? s.done - lastStop.lap : s.done;
      s.pb = s.c.laps.filter((x) => x.end <= t && !x.pit && x.lap > 1).reduce((m, x) => Math.min(m, x.dur), Infinity);
    });
    let fastest = null;
    for (const b of bestTimes) { if (b.t > t) break; if (!fastest || b.dur < fastest.dur) fastest = b; }
    const leadLap = Math.min(nLaps, Math.max(1, leadEnd.findIndex((x) => x > t) + 1 || nLaps));
    const scNow = scP.find((p) => t >= p.t0 && t < p.t1);
    const sc = !!scNow, vsc = vscP.some((p) => t >= p.t0 && t < p.t1);
    // the safety car: just ahead of the leader on the road; on the last SC lap it pulls off into the pit lane
    let scCar = null;
    const first = scNow && order.find((s) => (s.state === "run" || s.state === "out") && s.idx !== null);
    if (first) {                              // the first car on track (the leader may be in the pits)
      const lastLap = t >= scNow.tLast && scNow.b > scNow.a;
      const frac = first.progress - Math.floor(first.progress);
      if (!(lastLap && frac > 0.9)) {
        const p = first.progress + SC_AHEAD_M / L;
        scCar = { progress: p, idx: ((((p - Math.floor(p)) * N) % N) + N) % N };
      }
    }
    return { t, order, byCar: st, fastest, leadLap, sc, vsc, scCar, finished: t >= cars[winner.c].finT };
  }
  // race-time profile: lap progress (laps + distance fraction) -> laps + time fraction; and the lap a car is on
  const timeProg = (prog) => { const k = Math.floor(prog); return k + tAtIdx((prog - k) * N); };
  const lapDurAt = (c, t) => { const lp = cars[c].laps.find((x) => x.start <= t && t < x.end); return lp ? lp.dur : out.baseLap; };

  // inverse of timeProg: laps + time fraction -> laps + distance fraction
  const progOfTime = (tp) => { const k = Math.floor(tp); return k + idxOfT(tp - k) / N; };
  // track height (m above the lap's lowest point) at lap progress; null without elevation data
  const Z = track.z ?? null;
  const zAt = Z ? (prog) => {
    const x = (((prog - Math.floor(prog)) * N) % N + N) % N, i = Math.floor(x), fr = x - i;
    return Z[i] + fr * (Z[(i + 1) % N] - Z[i]);
  } : null;

  return { cars, tEnd, feed, snapshot, nLaps, track, L, scPeriods, timeProg, progOfTime, zAt, lapDurAt,
           baseLap: out.baseLap };
}

function callText(e) {
  if (e.action === "box") return "Your call: box this lap.";
  if (e.action === "stay") return `Your call: stay out for ${e.value ?? 3} laps.`;
  if (e.action === "stops") return `Your call: ${e.value} more stop${e.value === 1 ? "" : "s"}.`;
  if (e.action === "pace") return `Your call: ${e.value} pace.`;
  return `Your call: ${e.action}.`;
}

export function fmtLap(s) {
  if (s == null || !isFinite(s)) return "";
  const m = Math.floor(s / 60), r = s - 60 * m;
  return `${m}:${r.toFixed(3).padStart(6, "0")}`;
}
export function fmtGap(g) {
  if (!g) return "";
  if (g.laps) return `+${g.laps} LAP${g.laps > 1 ? "S" : ""}`;
  return `+${g.s.toFixed(g.s < 100 ? 3 : 1)}`;
}
export function fmtClock(s) {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}
