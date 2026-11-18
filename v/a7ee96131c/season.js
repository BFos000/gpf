// Season mode: a calendar of races run with one field (the current setup's drivers and cars, under
// one rules year), points by that rules year, and driver and constructor standings.
//
// season = { name, year, calYear, seed, mode, grid, entries, rounds: [{name, circuit, layout, laps, wet}],
//            results: [null | [{e, pos, status, pts, fl}]] }
// Rounds are run in order. A watched round is recorded when it finishes (with any strategy calls made);
// "sim" rounds are run headless with the CPU strategists only.
import { simulateRace } from "./sim/race.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

// points for classified finishers, by rules year; fl: a point for the fastest lap (top-10 finisher only)
export function pointsFor(year) {
  if (year <= 1990) return { table: [9, 6, 4, 3, 2, 1], fl: 0 };
  if (year <= 2002) return { table: [10, 6, 4, 3, 2, 1], fl: 0 };
  if (year <= 2009) return { table: [10, 8, 6, 5, 4, 3, 2, 1], fl: 0 };
  return { table: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], fl: year >= 2019 && year <= 2024 ? 1 : 0 };
}

// a real year's calendar, keeping the rounds that have a track map
export function calendarOf(db, calYear, hasTrack) {
  return db.races.filter((r) => r.year === calYear && hasTrack(r.circuit, r.layout)).sort((a, b) => a.round - b.round)
    .map((r) => ({ name: r.name, circuit: r.circuit, layout: r.layout, laps: r.laps,
                   wet: r.weather ? Math.min(1, (r.weather.rain_mm ?? 0) / 3) : 0 }));
}

export function newSeason(cfg, rounds, calYear, seed) {
  return {
    name: `${cfg.year} rules · ${calYear} calendar`, year: cfg.year, calYear, seed, mode: cfg.mode ?? "relative",
    grid: cfg.grid === "fixed" ? "fixed" : "quali",
    entries: cfg.entries.map((e) => ({ driver: e.driver, season: e.season, car: e.car, ...(e.mine ? { mine: true } : {}) })),
    rounds, results: rounds.map(() => null),
  };
}

export const nextRound = (S) => S.results.findIndex((r) => r === null);

// the race config for round k (same shape as a setup config)
export function roundConfig(S, k) {
  const r = S.rounds[k];
  return { name: `Round ${k + 1}: ${r.name}`, circuit: r.circuit, layout: r.layout, year: S.year, laps: r.laps, wet: r.wet,
           mode: S.mode, grid: S.grid, seed: S.seed * 100 + k + 1, entries: S.entries.map((e) => ({ ...e })), seasonRound: k };
}

export function simRound(db, S, k, track) {
  const c = roundConfig(S, k);
  return simulateRace(db, { seed: c.seed, year: c.year, circuit: c.circuit, layout: c.layout, laps: c.laps, wet: c.wet,
                            grid: c.grid, mode: c.mode, entries: c.entries, calls: [] }, track);
}

export function record(S, k, out) {
  const pts = pointsFor(S.year);
  // fastest lap: best non-pit lap after lap 1
  let fl = null;
  out.laps_table.forEach((row, l) => { if (l === 0) return; for (const x of row) if (!x.pit && (!fl || x.dur < fl.dur)) fl = { c: x.c, dur: x.dur }; });
  S.results[k] = out.result.map((r) => {
    const cls = r.status === "finished";
    const p = cls ? (pts.table[r.pos - 1] ?? 0) + (pts.fl && fl?.c === r.c && r.pos <= 10 ? pts.fl : 0) : 0;
    return { e: r.c, pos: r.pos, status: r.status, pts: p, fl: fl?.c === r.c, grid: out.cars[r.c].grid };
  });
}

// standings; ties broken by wins, then seconds, ...
export function standings(db, S) {
  const n = S.entries.length;
  const drv = S.entries.map((e, i) => ({ i, pts: 0, fin: [], wins: 0, podiums: 0 }));
  for (const res of S.results) if (res) for (const r of res) {
    const d = drv[r.e]; d.pts += r.pts;
    if (r.status === "finished") { d.fin.push(r.pos); if (r.pos === 1) d.wins++; if (r.pos <= 3) d.podiums++; }
  }
  const cmp = (a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    for (let p = 1; p <= n; p++) { const x = a.fin.filter((q) => q === p).length, y = b.fin.filter((q) => q === p).length; if (x !== y) return y - x; }
    return 0;
  };
  drv.sort(cmp);
  const carOf = (i) => db.cars.find((c) => c.id === S.entries[i].car);
  const teams = new Map();
  for (const d of drv) {
    const car = carOf(d.i), key = car ? `${car.ref}|${car.year}` : S.entries[d.i].car;
    const t = teams.get(key) ?? { key, name: car ? `${car.name} ${car.year}` : key, pts: 0, fin: [], wins: 0, members: [] };
    t.pts += d.pts; t.fin.push(...d.fin); t.wins += d.wins; t.members.push(d.i);
    teams.set(key, t);
  }
  return { drivers: drv, teams: [...teams.values()].sort(cmp) };
}

// ---------- dialog ----------
export class SeasonUI {
  // hooks: { hasTrack(circuit, layout), trackFor(circuit, layout) -> Promise<track>, currentCfg() -> cfg,
  //          loadedOut(k) -> out | null (the viewer's race, if it is round k), watch(cfg), store }
  constructor(db, hooks) {
    this.db = db; this.h = hooks;
    this.S = hooks.store.get("season");
    const years = [...new Set(db.races.filter((r) => hooks.hasTrack(r.circuit, r.layout)).map((r) => r.year))].sort((a, b) => b - a);
    $("se-calyear").innerHTML = years.map((y) => `<option>${y}</option>`).join("");
    $("se-close").addEventListener("click", () => $("season").close());
    $("se-start").addEventListener("click", () => this.start());
    $("se-watch").addEventListener("click", () => this.watch());
    $("se-sim").addEventListener("click", () => this.sim(1));
    $("se-simall").addEventListener("click", () => this.sim(Infinity));
    $("se-end").addEventListener("click", () => {
      // two clicks (window.confirm is blocked in the artifact frame)
      if (!(this.armEnd && Date.now() - this.armEnd < 6000)) {
        this.armEnd = Date.now(); $("se-end").textContent = "Click again to end";
        this.msg("End this season? Its results will be discarded. Click again to confirm.");
        setTimeout(() => { $("se-end").textContent = "End season"; }, 6000);
        return;
      }
      this.armEnd = 0; $("se-end").textContent = "End season";
      this.S = null; this.save(); this.render();
    });
  }
  save() { this.h.store.set("season", this.S); }
  open() { const c = this.h.currentCfg(); if (c) $("se-calyear").value = $("se-calyear").value || c.year; this.render(); $("season").showModal(); }
  msg(t) { $("se-msg").textContent = t; }
  driverName(i) { const e = this.S.entries[i], d = this.db.drivers.find((x) => x.id === e.driver); return d?.name ?? e.driver; }

  start() {
    const cfg = this.h.currentCfg();
    if (!cfg || cfg.entries.length < 2) { this.msg("Set up a field first (Setup…)."); return; }
    const calYear = Number($("se-calyear").value);
    let rounds = calendarOf(this.db, calYear, this.h.hasTrack);
    const max = Math.max(1, Math.round(Number($("se-rounds").value) || rounds.length));
    if (rounds.length > max) {                      // spread the kept rounds through the calendar
      const keep = new Set(Array.from({ length: max }, (_, k) => Math.round((k * (rounds.length - 1)) / Math.max(1, max - 1))));
      rounds = rounds.filter((_, k) => keep.has(k));
    }
    if (!rounds.length) { this.msg("That calendar has no circuits with a track map."); return; }
    const seed = Math.max(1, Math.floor(Number($("se-seed").value) || 1 + Math.floor(Math.random() * 99999)));
    this.S = newSeason(cfg, rounds, calYear, seed);
    this.save(); this.render();
    this.msg(`Season started: ${rounds.length} rounds, ${cfg.entries.length} cars, ${cfg.year} rules.`);
  }
  // record the viewer's race if it is the pending round and has been run to the end (or forced)
  takeLoaded(k, force) {
    const out = this.h.loadedOut(k, force);
    if (!out) return false;
    record(this.S, k, out); this.save(); return true;
  }
  watch() {
    const k = nextRound(this.S); if (k < 0) return;
    $("season").close();
    this.h.watch(roundConfig(this.S, k));
  }
  async sim(n) {
    let done = 0;
    for (let k = nextRound(this.S); k >= 0 && done < n; k = nextRound(this.S), done++) {
      if (this.takeLoaded(k, true)) continue;     // the loaded race keeps any calls you made in it
      const r = this.S.rounds[k];
      const track = await this.h.trackFor(r.circuit, r.layout);
      record(this.S, k, simRound(this.db, this.S, k, track));
      this.msg(`Simulated round ${k + 1}: ${r.name}.`);
      if (done % 3 === 2) { this.render(); await new Promise((res) => setTimeout(res, 0)); }
    }
    this.save(); this.render();
  }
  // called by the viewer when a season race reaches the flag
  finished(k) {
    if (!this.S || this.S.results[k] || nextRound(this.S) !== k) return false;
    return this.takeLoaded(k, false);
  }

  render() {
    const S = this.S;
    $("se-new").hidden = !!S; $("se-run").hidden = !S;
    if (!S) { $("se-title").textContent = "Season"; $("se-body").innerHTML = ""; return; }
    const k = nextRound(S), pts = pointsFor(S.year);
    $("se-title").textContent = `Season: ${S.name}`;
    $("se-watch").disabled = $("se-sim").disabled = $("se-simall").disabled = k < 0;
    $("se-watch").textContent = k < 0 ? "Season complete" : `Watch round ${k + 1}`;
    $("se-info").textContent = `Points ${pts.table.join("-")}${pts.fl ? " + 1 for fastest lap" : ""} · seed ${S.seed}`;
    const st = standings(this.db, S);
    const mine = (i) => S.entries[i].mine;
    const code = (i) => { const d = this.db.drivers.find((x) => x.id === S.entries[i].driver); return d?.code ?? this.driverName(i).split(" ").at(-1).slice(0, 3).toUpperCase(); };
    const cal = S.rounds.map((r, j) => {
      const res = S.results[j];
      const win = res ? res.find((x) => x.pos === 1) : null;
      const yours = res ? res.filter((x) => mine(x.e)).map((x) => (x.status === "finished" ? `P${x.pos}` : "DNF")).join(", ") : "";
      return `<tr class="${j === k ? "next" : ""}"><td class="n">${j + 1}</td><td>${esc(r.name)}${r.wet > 0.3 ? " <span class=\"wet\">wet</span>" : ""}</td>` +
        `<td>${win ? esc(this.driverName(win.e)) : j === k ? "next" : ""}</td><td class="n">${yours}</td></tr>`;
    }).join("");
    const leader = st.drivers[0]?.pts ?? 0;
    const drv = st.drivers.map((d, p) => `<tr class="${mine(d.i) ? "mine" : ""}"><td class="n">${p + 1}</td><td>${esc(this.driverName(d.i))}` +
      `<small> ${esc(this.carName(S.entries[d.i].car))}</small></td><td class="n">${d.wins || ""}</td><td class="n">${d.podiums || ""}</td>` +
      `<td class="n b">${d.pts}</td><td class="n">${p ? "-" + (leader - d.pts) : ""}</td></tr>`).join("");
    const tms = st.teams.map((t, p) => `<tr class="${t.members.some(mine) ? "mine" : ""}"><td class="n">${p + 1}</td><td>${esc(t.name)}` +
      `<small> ${t.members.map(code).join(" ")}</small></td><td class="n">${t.wins || ""}</td><td class="n b">${t.pts}</td></tr>`).join("");
    $("se-body").innerHTML =
      `<div class="se-col"><h3>Calendar</h3><table><thead><tr><th>#</th><th>Grand Prix</th><th>Winner</th><th>Yours</th></tr></thead><tbody>${cal}</tbody></table></div>` +
      `<div class="se-col"><h3>Drivers</h3><table><thead><tr><th>#</th><th>Driver</th><th>W</th><th>Pod</th><th>Pts</th><th>Gap</th></tr></thead><tbody>${drv}</tbody></table></div>` +
      `<div class="se-col"><h3>Constructors</h3><table><thead><tr><th>#</th><th>Team</th><th>W</th><th>Pts</th></tr></thead><tbody>${tms}</tbody></table></div>`;
  }
  carName(id) { const c = this.db.cars.find((x) => x.id === id); return c ? `${c.name} ${c.year}` : id; }
}
