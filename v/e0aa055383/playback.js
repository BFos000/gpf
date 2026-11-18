// Playback: turns a simulated race (lap table + events) into car state at any race time t.
// Within a lap, cars move through each sector by the track's time-fraction profile (slow in
// corners, fast on straights); pit time is spent stationary in the pit box at the end of the in-lap
// and the start of the out-lap. Live timing uses the three sector lines as timing points.

const GRID_SLOT_M = 8;            // metres between grid slots
const SC_AHEAD_M = 70;            // the safety car runs this far ahead of the leader
export const PIT_IN_M = 300, PIT_OUT_M = 250;   // pit lane: entry before the line, exit after it

export function buildPlayback(out, track) {
  track = out._track?.x === track.x ? out._track : track;   // the era profile the sim used (sim/profile.js)
  const N = track.x.length, L = track.length_m;
  const tt = track.t;
  const S0 = track.start_idx ?? 0;          // the start (grid) line from the finish line, in samples (Spa, Long Beach)
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
  // red flags (replays): the suspension sits inside one lap of each car. That lap runs at the car's normal pace with a
  // hold just short of the line (the cars wait at the pit entry), and the clock skips the stretch where every car waits
  const redLaps = out.events.filter((e) => e.type === "red").map((e) => e.lap);
  if (redLaps.length) for (const c of cars) {
    const ds = c.laps.map((x) => x.dur).sort((a, b) => a - b), med = ds[Math.floor(ds.length / 2)] ?? 0;
    for (const lp of c.laps) if (lp.dur > med + 300) lp.hold = lp.dur - med;   // (a suspension: minutes, not a slow lap)
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
      // it stops where the lap's time profile reaches ret.f of the distance, at its own pace: timed by distance share
      // alone, a car stopping late on a lap whose early part is slow had to run ahead of its pace to get there in time
      // (a long lap: it surged through the field just before it stopped). On lap 1 it drives from its grid slot.
      const gs0 = S0 - ((c.grid - 1) * GRID_SLOT_M + 6) / track.step_m;
      const F0 = last ? 0 : gs0 < 0 ? tAtIdx(gs0 + N) - 1 : tAtIdx(gs0);
      c.retT = (last ? last.end : c.s0 ?? 0) + Math.max(0.02, tAtIdx(ret.f * N) - F0) * typical;   // (staggered start: its own)
      c.retF0 = F0;
      c.retFrac = ret.f; c.retLap = ret.lap; c.retCause = ret.cause; c.retDur = typical;
    }
    // a lap far off the car's pace without a stop (a puncture, a spin, a repair out on the course): the car runs its
    // normal pace and loses the time in one sector, not slowly all lap (the timing lines agree)
    const norm = c.laps.filter((x) => x.lap > 1 && !x.pit && !x.hold);
    if (norm.length >= 2) {
      const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
      const ref = [0, 1, 2].map((j) => med(norm.map((x) => x.s[j])));
      const refDur = ref[0] + ref[1] + ref[2];
      for (const lp of c.laps) {
        if (lp.lap === 1 || lp.pit || lp.hold || lp.dur < 1.1 * refDur) continue;
        const last = lp === c.laps.at(-1) && r.status !== "finished";
        const j = last ? 2 : (lp.lap * 7 + c.i * 3) % 3;
        const s = ref.slice();
        s[j] += lp.dur - refDur;
        lp.s = s;
      }
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
    else if (e.type === "retire") feed.push({ t: cars[e.c].retT, lap: e.lap, kind: "retire", c: e.c, cause: e.cause, text: e.text ?? null });
    else if (e.type === "loss" && lp && e.pct * out.baseLap / 100 > 1.5) feed.push({ t: lp.start + 0.5 * lp.dur, lap: e.lap, kind: "loss", c: e.c, s: e.pct * out.baseLap / 100 });
    else if (e.type === "damage" && lp) feed.push({ t: lp.start + 0.4 * lp.dur, lap: e.lap, kind: "damage", c: e.c });
    // narration: told when its lap is over (the leader's crossing; never ahead of what it tells), lap 0 at the start
    else if (e.type === "nar") feed.push({ t: e.lap >= 1 ? (leadEnd[e.lap - 1] ?? 0) + 0.01 + 0.001 * (e.k ?? 0) : 0.01 + 0.001 * (e.k ?? 0), lap: Math.max(1, e.lap), kind: "nar", c: e.c, text: e.text, q: e.q, src: e.src });
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
  // red flags: shown when the first car stops, racing again when the first moves; the all-waiting stretch is skipped
  // every held car waits through one common window [ws, we]: from when the last car can have reached the pit entry
  // to when the first must leave to make its crossing (each car's hold slides to cover it, its running split around)
  const skips = [], tE = tAtIdx(N - PIT_IN_M / track.step_m);
  const held = cars.flatMap((c) => c.laps.filter((lp) => lp.hold)).sort((x, y) => x.start - y.start);
  const clusters = [];                                 // one suspension each: held laps that overlap in time
  for (const lp of held) {
    const cl = clusters.at(-1);
    if (cl && lp.start < Math.min(...cl.map((x) => x.end))) cl.push(lp); else clusters.push([lp]);
  }
  const st = (lp) => (lp.lap === 1 ? 0 : lp.start);
  for (const hl of clusters) {
    const ws = Math.max(...hl.map((lp) => st(lp) + tE * (lp.dur - lp.hold) * 0.6));
    const we = Math.min(...hl.map((lp) => lp.end - (1 - tE) * (lp.dur - lp.hold) * 0.6));
    if (we > ws) for (const lp of hl) {
      const R = lp.dur - lp.hold, s0 = st(lp);
      const lo = Math.max(0.6 * tE * R, we - lp.hold - s0), hi = Math.min(ws - s0, R - 0.6 * (1 - tE) * R);
      lp.h0 = Math.min(Math.max(tE * R, lo), Math.max(lo, hi));
    }
    const hs = hl.map((lp) => { const a = st(lp) + (lp.h0 ?? tE * (lp.dur - lp.hold)); return [a, a + lp.hold]; });
    const a0 = Math.min(...hs.map((h) => h[0])), a1 = Math.max(...hs.map((h) => h[0])), b0 = Math.min(...hs.map((h) => h[1]));
    const L = Math.min(...hl.map((lp) => lp.lap));
    feed.push({ t: a0, lap: L, kind: "red" }, { t: b0, lap: L, kind: "red_end" });
    if (b0 - 4 > a1 + 4) skips.push([a1 + 4, b0 - 4]);
  }
  // a red flag with no suspension in the laps (it ended the race): at the leader's line
  for (const L of redLaps) if (!clusters.some((hl) => hl.some((lp) => Math.abs(lp.lap - L) <= 2)))
    feed.push({ t: (leadEnd[L - 1] ?? 0) - 0.01, lap: L, kind: "red" });
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
    const pin = lp.pit === "in" ? lp.pt : 0, pout = lp.pit === "out" ? lp.pt : 0, hold = lp.hold ?? 0;
    if (hold) {                                        // red flag: run to the pit entry, wait, run on
      const R = D - hold, pre = tEntry * R, h0 = lp.h0 ?? pre;    // h0: running time before the hold (common window)
      // (a car that would reach the entry after the suspension starts stops where it is then, never hurries there)
      const pp = Math.min(pre, h0);
      const e2 = e < h0 ? e * pp / h0 : e < h0 + hold ? pp : pp + (e - h0 - hold) * (R - pp) / Math.max(1e-6, R - h0);
      return lapTimeFrac({ ...lp, hold: 0, end: lp.end - hold }, e2, start);
    }
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
    const gs = S0 - g / track.step_m;          // grid slot, samples from the finish line (negative: on the lap before)
    if (t >= c.finT) {
      return { state: "fin", done: c.finLap, idx: Math.min(300, 12 + (t - c.finT) * 15) / track.step_m, progress: c.finLap + 1e-3 * (c.finT - t) };
    }
    if (t >= c.retT) {
      const idx = c.retFrac * N;
      return { state: "dnf", done: c.retLap - 1, idx, progress: -1000 - (tEnd - c.retT) };
    }
    const s0 = c.s0 ?? 0;                      // a staggered start: the car waits on the line until its turn
    if (t <= s0) return { state: "grid", done: 0, idx: ((gs % N) + N) % N, progress: gs / N - 1e-6 * s0 };
    const k = findLap(c, t);
    const lp = c.laps[k];
    if (!lp) {                                 // retired on lap 1 before completing it: crawl to the retirement point
      // from its grid slot at its own pace along the time profile, up to the stopping point
      const ff = Math.min(tAtIdx(c.retFrac * N), (c.retF0 ?? 0) + (t - s0) / c.retDur);
      const idx = ff < 0 ? idxOfT(ff + 1) : Math.min(c.retFrac * N, idxOfT(ff));
      const d = ff < 0 ? (idx - N) / N : idx / N;
      return { state: "run", done: 0, idx: ((idx % N) + N) % N, progress: d };
    }
    if (t >= lp.end) {                         // past the last recorded lap, before retirement
      // along the lap's time profile at its own pace (like the running cars), reaching the stopping point at retT
      const idx = Math.min(c.retFrac * N, idxOfT(Math.min(1, (t - lp.end) / Math.max(1e-6, c.retDur))));
      return { state: "run", done: lp.lap, idx, progress: lp.lap + idx / N };
    }
    const start = lp.lap === 1 ? s0 : lp.start;
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
      const F0 = gs < 0 ? tAtIdx(gs + N) - 1 : tAtIdx(gs);   // its time fraction (negative: on the lap before)
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
    // the move starts with the run up to the braking point (slipstream), ~125 m before it. A real (replayed) pass is
    // placed where the two cars' own running crosses (stagedZone)
    passesByLap.get(k).push({ c: e.c, on: e.on, lap: e.lap, real: !!e.real, z0: Math.max(0, z.start - 125 / track.step_m), z1: z.apex });
  }
  // a replayed pass: at the braking zone nearest where the attacker's own running meets the victim's on that lap; no
  // staging when the victim is far slower on the lap (it is crawling: the attacker simply goes by) or they never meet
  const zoneCache = new Map();
  function stagedZone(e) {
    const key = `${e.lap}:${e.c}:${e.on}`;
    if (zoneCache.has(key)) return zoneCache.get(key);
    let z = null;
    const A = cars[e.c], V = cars[e.on];
    const la = A.laps.find((x) => x.lap === e.lap), lv = V.laps.find((x) => x.lap === e.lap);
    if (la && lv && !(lv.dur > 1.08 * la.dur)) {
      const t0 = Math.max(la.start, lv.start), t1 = Math.min(la.end, lv.end);
      const d = (t) => carAt(A, t).progress - carAt(V, t).progress;
      if (t1 > t0 && d(t0) < 0 && d(t1) > 0) {
        let a = t0, b = t1;
        for (let it = 0; it < 30; it++) { const m = (a + b) / 2; if (d(m) < 0) a = m; else b = m; }
        const x = carAt(V, b).idx;
        let best = null, bd = Infinity;
        for (const zz of track.zones) {
          if (!(zz.start < zz.apex)) continue;
          const dd = Math.abs(zz.apex - x);
          if (dd < bd) { bd = dd; best = zz; }
        }
        if (best) z = { z0: Math.max(0, best.start - 125 / track.step_m), z1: best.apex };
      }
    }
    zoneCache.set(key, z);
    return z;
  }
  function stagePasses(st) {
    for (const p of st) {
      if (p.state !== "run") continue;
      const list = passesByLap.get(`${p.done + 1}`);
      if (!list) continue;
      for (const e0 of list) {
        if (e0.c !== p.c.i) continue;
        const v = st[e0.on];
        if (v.state !== "run" || v.done !== p.done) continue;
        const e = e0.real ? stagedZone(e0) : e0;
        if (!e) continue;
        // staged only between cars close on the road: fades out from 150 to 400 m apart (positions stay continuous)
        const near = Math.min(1, Math.max(0, (400 - Math.abs(v.progress - p.progress) * L) / 250));
        if (near <= 0) continue;
        const sep = SEP_M / L;
        const before = Math.min(p.progress, v.progress - sep);
        const after = Math.max(p.progress, v.progress + sep);
        const w = Math.min(1, Math.max(0, (v.idx - e.z0) / (e.z1 - e.z0)));
        const np = p.progress + near * ((1 - w) * before + w * after - p.progress);
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
      const ea = a.c.laps.find((x) => x.lap === lap), eb = b.c.laps.find((x) => x.lap === lap);
      const beats = lap > 1 && a.done === b.done && ea && eb && eb.end < ea.end;      // b crosses the line first on this lap
      if (beats || passPairs.has(`${lap}:${b.c.i}:${a.c.i}`) || passPairs.has(`${lap}:${a.c.i}:${b.c.i}`)) {
        a.alongside = b.c.i; b.alongside = a.c.i; continue;
      }
      b.progress = a.progress - SEP_M / L;
      b.idx = ((((b.progress - Math.floor(b.progress)) * N) % N) + N) % N;
    }
  }
  // a replayed crossing's uncertainty (s): timing point P (3 a lap) inside lap l sits between crossings l-1 and l
  const crossU = (c, l) => (l <= 0 || !c.u ? 0 : c.u[l - 1] ?? 0);
  const uAt = (c, P) => { const l = Math.ceil(P / 3); return P % 3 === 0 ? crossU(c, l) : Math.max(crossU(c, l - 1), crossU(c, l)); };
  const lapU = (c, l) => {                 // a lap between two filled crossings: about the car's lap sd
    const a = crossU(c, l), b = crossU(c, l - 1), h = Math.hypot(a, b);
    return a && b ? Math.min(h, c.usd || h) : h;
  };
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
        return { s: timeAt(s, s.P) - timeAt(o, s.P), u: Math.hypot(uAt(s.c, s.P), uAt(o.c, s.P)) };
      };
      s.gap = k === 0 ? null : gapTo(lead);
      s.int = k === 0 ? null : gapTo(order[k - 1]);
      const lastLap = s.c.laps.filter((x) => x.end <= t).at(-1);
      s.last = lastLap ? lastLap.dur : null;
      s.lastU = lastLap && s.c.u ? lapU(s.c, lastLap.lap) : 0;
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

  return { cars, tEnd, feed, skips, snapshot, nLaps, track, L, scPeriods, timeProg, progOfTime, zAt, lapDurAt,
           baseLap: out.baseLap };
}

function callText(e) {
  if (e.action === "box") return "Your call: box this lap.";
  if (e.action === "stay") return `Your call: stay out for ${e.value ?? 3} laps.`;
  if (e.action === "stops") return `Your call: ${e.value} more stop${e.value === 1 ? "" : "s"}.`;
  if (e.action === "pace") return `Your call: ${e.value} pace.`;
  return `Your call: ${e.action}.`;
}

/** decimals a value of uncertainty u (s, one sd) earns: 3 for timing data, fewer as it grows; null: whole seconds
 *  or a range */
export function digitsFor(u) {
  return !u || u < 0.002 ? 3 : u < 0.02 ? 2 : u < 0.2 ? 1 : null;
}
export function fmtLap(s, u = 0) {
  if (s == null || !isFinite(s)) return "";
  const d = digitsFor(u);
  if (d == null) {                         // an estimate: whole seconds
    const r_ = Math.round(s), m_ = Math.floor(r_ / 60);
    return `~${m_}:${String(r_ - 60 * m_).padStart(2, "0")}`;
  }
  const m = Math.floor(s / 60), r = s - 60 * m;
  return `${m}:${r.toFixed(d).padStart(d ? 3 + d : 2, "0")}`;
}
/** a gap {s, u?} or {laps}: digits by how sure it is ("+1.234", "+1.2"); an estimate "~12s"; a loose one a range
 *  of about one sd either way on a round step ("~35-40s") */
export function fmtGap(g) {
  if (!g) return "";
  if (g.laps) return `+${g.laps} LAP${g.laps > 1 ? "S" : ""}`;
  const u = g.u ?? 0, d = digitsFor(u);
  if (d != null) return `+${g.s.toFixed(g.s < 100 ? d : Math.min(d, 1))}`;
  if (u <= 1) return `~${Math.round(g.s)}s`;
  const step = u < 1.5 ? 1 : u < 6 ? 5 : 10;
  let lo = Math.max(0, Math.floor((g.s - u) / step) * step), hi = Math.ceil((g.s + u) / step) * step;
  if (hi <= lo) hi = lo + step;
  return `~${lo}–${hi}s`;
}
export function fmtClock(s) {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}
