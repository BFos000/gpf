// Race setup: circuit, rules year, laps, weather, pace mode, grid, and any driver (any of their
// seasons) in any car. Configs save to this browser and export/import as JSON text.
//
// config = { name, circuit, layout, year, laps, wet, mode, grid, seed, entries: [{driver, season, car}] }

import { eraCarScale } from "./sim/race.js";
import { carThumb } from "./thumbs.js";

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem("fgp." + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("fgp." + k, JSON.stringify(v)); return true; } catch { return false; } },
};

export function configFromRace(db, race) {
  return {
    name: `${race.year} ${race.name}`, circuit: race.circuit, layout: race.layout, year: race.year, laps: race.laps,
    wet: race.weather ? Math.min(1, (race.weather.rain_mm ?? 0) / 3) : 0, mode: "relative", grid: "fixed", seed: 1,
    entries: race.grid.filter(([, c]) => c).map(([d, car]) => ({ driver: d, season: race.year, car })),
    raceId: race.id,
  };
}

export class Setup {
  constructor(db, tracksAvail, onRun, paint = null) {
    this.paint = paint;
    this.db = db; this.onRun = onRun;
    this.drivers = [...db.drivers].sort((a, b) => a.name.localeCompare(b.name));
    this.cars = [...db.cars].sort((a, b) => a.year - b.year || a.name.localeCompare(b.name));
    this.circuits = db.circuits.map((c) => ({ ...c, layouts: c.layouts.filter((l) => l.geo_id && tracksAvail.has(l.geo_id)) }))
      .filter((c) => c.layouts.length).sort((a, b) => a.name.localeCompare(b.name));
    const span = (d) => { const ys = Object.keys(d.seasons).map(Number); return `${Math.min(...ys)}–${Math.max(...ys)}`; };
    this.driverLabel = new Map(this.drivers.map((d) => [d.id, `${d.name} (${span(d)})`]));
    this.driverByLabel = new Map(this.drivers.map((d) => [this.driverLabel.get(d.id), d]));
    // pre-war cars are named by make, so a year has several: add the model (and the class when it isn't GP)
    const preLabel = (c) => `${c.year} ${c.name}${c.model && c.model.toLowerCase() !== c.name.toLowerCase() ? " " + c.model : ""}` +
      (c.cls && c.cls !== "gp" ? ` (${c.cls})` : "");
    const seen = new Map();                  // a label used twice gets a number, so every car stays pickable
    this.carLabel = new Map(this.cars.map((c) => {
      const l = c.prewar ? preLabel(c) : `${c.year} ${c.name}`, k = (seen.get(l) ?? 0) + 1;
      seen.set(l, k);
      return [c.id, k > 1 ? `${l} #${k}` : l];
    }));
    this.carByLabel = new Map(this.cars.map((c) => [this.carLabel.get(c.id), c]));
    this.cfg = null;
    this.build();
  }

  build() {
    $("dl-drivers").innerHTML = this.drivers.map((d) => `<option value="${esc(this.driverLabel.get(d.id))}"></option>`).join("");
    $("dl-cars").innerHTML = this.cars.map((c) => `<option value="${esc(this.carLabel.get(c.id))}"></option>`).join("");
    $("su-circuit").innerHTML = this.circuits.map((c) => `<option value="${c.ref}">${esc(c.name)} · ${esc(c.country ?? "")}</option>`).join("");
    // years with a real race grid, plus earlier years (results-only data): those fill from the season's drivers
    const years = [...new Set([...this.db.races.map((r) => r.year), ...this.cars.map((c) => c.year)])].sort((a, b) => b - a);
    $("su-fillyear").innerHTML = years.map((y) => `<option>${y}</option>`).join("");
    $("su-circuit").addEventListener("change", () => { this.read(); this.cfg.layout = null; this.cfg.laps = null; this.render(); });
    $("su-layout").addEventListener("change", () => { this.read(); this.cfg.laps = null; this.render(); });
    $("su-wet").addEventListener("input", () => { $("su-wetv").textContent = wetText(Number($("su-wet").value)); });
    $("su-add").addEventListener("click", () => { this.read(); const e = this.randomEntry(this.cfg.entries, clampInt($("su-minseasons").value, 1, 30, 1)); if (e) this.cfg.entries.push(e); this.render(); });
    $("su-fill").addEventListener("click", () => this.fillSeason(Number($("su-fillyear").value)));
    $("su-shuffle").addEventListener("click", () => { this.read(); shuffle(this.cfg.entries.map((e) => e.car)).forEach((c, k) => { this.cfg.entries[k].car = c; }); this.render(); });
    $("su-random").addEventListener("click", () => {
      this.read();
      const minS = clampInt($("su-minseasons").value, 1, 30, 1);
      store.set("minSeasons", minS);
      const pool = this.drivers.filter((d) => Object.keys(d.seasons).length >= minS);
      const n = Math.min(pool.length, Math.max(10, this.cfg.entries.length || 20));
      if (!n) { this.msg(`No drivers have ${minS} or more seasons in the data.`); return; }
      const field = [];
      for (let k = 0; k < n; k++) field.push(this.randomEntry(field, minS));
      this.cfg.entries = field; this.render();
      this.msg(`Random field: ${n} drivers with ${minS}+ seasons (${pool.length} eligible).`);
    });
    $("su-clear").addEventListener("click", () => { this.read(); this.cfg.entries = []; this.render(); });
    $("su-run").addEventListener("click", () => this.run());
    $("su-close").addEventListener("click", () => $("setup").close());
    $("su-save").addEventListener("click", () => this.save());
    $("su-load").addEventListener("click", () => this.load());
    $("su-del").addEventListener("click", () => this.del());
    $("su-export").addEventListener("click", () => { this.read(); $("su-json").value = JSON.stringify(this.cfg, null, 1); $("su-json").select(); this.msg("Config JSON is in the box below. Copy it to keep it."); });
    $("su-copy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText($("su-json").value); this.msg("Copied."); } catch { $("su-json").select(); this.msg("Select-all done: press Ctrl+C to copy."); }
    });
    $("su-import").addEventListener("click", () => {
      try { const c = JSON.parse($("su-json").value); this.validate(c); this.cfg = c; this.render(); this.msg("Config imported."); }
      catch (e) { this.msg(`Could not import: ${e.message}`); }
    });
    $("su-file").addEventListener("change", async (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      $("su-json").value = await f.text(); $("su-import").click();
    });
    this.refreshSaved();
    $("su-minseasons").value = store.get("minSeasons") ?? 1;
    this.buildFieldBuilder();
  }

  // ---------- field builder: filters -> a ranked list of (driver, season); a car rule; presets; grid tools ----------
  buildFieldBuilder() {
    const nats = [...new Set(this.drivers.map((d) => natOf(d)).filter(Boolean))].sort();
    $("fb-nat").innerHTML = `<option value="">Any</option>` + nats.map((n) => `<option>${esc(n)}</option>`).join("");
    const ids = ["fb-from", "fb-to", "fb-nat", "fb-pool", "fb-minsea", "fb-top", "fb-name", "fb-season", "fb-car", "fb-toppct", "fb-onecar", "fb-n", "fb-order"];
    const saved = store.get("fieldBuilder");
    if (saved) for (const [k, v] of Object.entries(saved)) { const el = $(k); if (el && ids.includes(k)) el.value = v; }
    const remember = () => store.set("fieldBuilder", Object.fromEntries(ids.map((k) => [k, $(k).value])));
    for (const k of ids) $(k).addEventListener(k === "fb-name" ? "input" : "change", () => { remember(); this.showMatches(); });
    $("fb-build").addEventListener("click", () => this.buildField(false));
    $("fb-addm").addEventListener("click", () => this.buildField(true));
    $("fb-carsonly").addEventListener("click", () => this.applyCars());
    $("su-fb").addEventListener("toggle", () => this.showMatches());
    for (const b of document.querySelectorAll("#su-fb [data-preset]")) b.addEventListener("click", () => this.preset(b.dataset.preset));
    for (const b of document.querySelectorAll("#su-fb [data-tool]")) b.addEventListener("click", () => this.tool(b.dataset.tool));
  }
  filters() {
    const from = clampInt($("fb-from").value, 1900, 2026, 1950), to = clampInt($("fb-to").value, 1900, 2026, 2024);
    return { from: Math.min(from, to), to: Math.max(from, to), nat: $("fb-nat").value, pool: $("fb-pool").value,
             minSea: clampInt($("fb-minsea").value, 1, 30, 1), top: clampInt($("fb-top").value, 0, 5000, 0),
             name: $("fb-name").value.trim().toLowerCase(), season: $("fb-season").value, car: $("fb-car").value,
             n: clampInt($("fb-n").value, 2, 60, 20), order: $("fb-order").value,
             topPct: clampInt($("fb-toppct")?.value, 1, 100, 20) };
  }
  // drivers matching the filters, best first: [{ d, season, score }], the season chosen by the season rule
  matches(f = this.filters()) {
    const out = [];
    for (const d of this.drivers) {
      if (f.nat && natOf(d) !== f.nat) continue;
      if (f.name && !d.name.toLowerCase().includes(f.name)) continue;
      const ys = Object.keys(d.seasons).map(Number)
        .filter((y) => y >= f.from && y <= f.to && (f.pool === "all" || (f.pool === "prewar" ? y < 1950 : y >= 1950)))
        .sort((a, b) => a - b);
      if (!ys.length || ys.length < f.minSea) continue;
      const pace = (y) => rankPace(d.seasons[y]);
      const peak = ys.reduce((a, y) => (pace(y) < pace(a) ? y : a), ys[0]);
      const all = bestSeason(d);
      const season = f.season === "peakall" ? (all ?? peak) : f.season === "first" ? ys[0] : f.season === "last" ? ys.at(-1)
        : f.season === "random" ? ys[Math.floor(Math.random() * ys.length)] : peak;
      out.push({ d, season, score: pace(peak) });
    }
    out.sort((a, b) => a.score - b.score);
    return f.top ? out.slice(0, f.top) : out;
  }
  showMatches() {
    if (!$("su-fb").open) return;
    const m = this.matches();
    $("fb-match").textContent = `${m.length} driver${m.length === 1 ? "" : "s"} match` +
      (m.length ? ` (best: ${m.slice(0, 3).map((x) => x.d.name).join(", ")})` : "");
  }
  // the car for a driver-season under a car rule
  carFor(rule, d, season, f) {
    if (rule === "one") return this.oneCar(f)?.id;
    if (rule === "randera") {
      const pool = this.cars.filter((c) => c.year >= f.from && c.year <= f.to && this.gpCar(c));
      return pool.length ? pool[Math.floor(Math.random() * pool.length)].id : null;
    }
    if (rule === "best") return this.fastestCar(season, season)?.id;
    if (rule === "toppct" || rule === "botpct") {   // a random car from the fastest (slowest) share of the era range
      const sgn = rule === "toppct" ? 1 : -1;
      const pool = this.cars.filter((c) => c.year >= f.from && c.year <= f.to && this.gpCar(c) && c.pace != null)
        .sort((a, b) => sgn * (this.crossPace(a) - this.crossPace(b)));
      const k = Math.max(1, Math.round(pool.length * (f.topPct ?? 20) / 100));
      return pool.length ? pool[Math.floor(Math.random() * k)].id : null;
    }
    if (rule === "careerbest") {                 // the fastest car the driver themself drove, any season
      const own = Object.values(d.seasons).map((s) => this.carById(s.car)).filter((c) => c?.pace != null);
      return own.length ? own.reduce((a, c) => (this.crossPace(c) < this.crossPace(a) ? c : a)).id
        : d.seasons[season]?.car;
    }
    if (rule === "anybest") {                    // the fastest car of any team, in any season the driver raced
      let best = null;
      for (const y of Object.keys(d.seasons).map(Number)) {
        const c = this.fastestCar(y, y);
        if (c && (!best || this.crossPace(c) < this.crossPace(best))) best = c;
      }
      return best?.id ?? d.seasons[season]?.car;
    }
    return d.seasons[season]?.car ?? this.fastestCar(season, season)?.id;
  }
  // car pace comparable across seasons: the field-relative pace with the sim's era scale for mixed fields
  crossPace(c) { return c.pace * eraCarScale(c.year); }
  carById(id) { return (this.carIndex ??= new Map(this.cars.map((c) => [c.id, c]))).get(id); }
  gpCar(c) { return !c.prewar || ((c.cls ?? "gp") === "gp" && (c.n_races ?? 2) >= 2); }
  fastestCar(y0, y1) {           // the fastest car (field-relative pace) of those years; pre-war: Grand Prix cars only
    let best = null;
    for (const c of this.cars) if (c.year >= y0 && c.year <= y1 && this.gpCar(c) && c.pace != null && (!best || c.pace < best.pace)) best = c;
    return best;
  }
  oneCar(f) { return this.carByLabel.get($("fb-onecar").value) ?? this.fastestCar(f.from, f.to); }
  buildField(append, f = this.filters(), pick = null) {
    this.read();
    let m = pick ?? this.matches(f);
    const taken = new Set(append ? this.cfg.entries.map((e) => e.driver) : []);
    m = m.filter((x) => !taken.has(x.d.id));
    if (f.order === "random") m = shuffle([...m]);
    m = m.slice(0, append ? Math.max(1, f.n - this.cfg.entries.length) : f.n);
    if (!m.length) { this.msg("No drivers match those filters."); return; }
    const old = new Map(this.cfg.entries.map((e) => [e.driver, e.car]));
    const es = m.map(({ d, season }) => ({ driver: d.id, season,
      car: (f.car === "keep" ? old.get(d.id) : null) ?? this.carFor(f.car === "keep" ? "own" : f.car, d, season, f) }))
      .filter((e) => e.car);
    this.cfg.entries = append ? [...this.cfg.entries, ...es] : es;
    this.render();
    this.msg(`${append ? "Added" : "Built a field of"} ${es.length} driver${es.length === 1 ? "" : "s"}` +
      (f.car === "one" ? ` in the ${this.carLabel.get(es[0]?.car) ?? "chosen car"}` : "") + ".");
  }
  // the Car rule on the current grid: drivers and their seasons stay, only the cars change
  applyCars() {
    this.read();
    const f = this.filters();
    if (f.car === "keep") { this.msg("The Car rule is “Keep current cars”: pick another rule to change the cars."); return; }
    let n = 0;
    for (const e of this.cfg.entries) {
      const d = this.drivers.find((x) => x.id === e.driver);
      const c = d && this.carFor(f.car, d, e.season, f);
      if (c) { e.car = c; n++; }
    }
    this.render();
    this.msg(`New cars for ${n} driver${n === 1 ? "" : "s"} (${$("fb-car").selectedOptions[0].textContent.toLowerCase()}).`);
  }
  preset(k) {
    const f = this.filters();
    const base = { ...f, nat: "", name: "", minSea: 1, season: "peak", car: "own", order: "best", n: 20, top: 0 };
    if (k === "greats") return this.buildField(false, { ...base, from: 1900, to: 2026, pool: "all" });
    if (k === "prewar") return this.buildField(false, { ...base, from: 1900, to: 1949, pool: "prewar" });
    if (k === "onecar") return this.buildField(false, { ...base, car: "one" });
    if (k === "carswap") return this.buildField(false, { ...base, car: "randera" });
    if (k === "decades") {
      const pick = [], seen = new Set();
      for (let y = Math.floor(f.from / 10) * 10; y <= f.to; y += 10)
        pick.push(...this.matches({ ...base, from: Math.max(f.from, y), to: Math.min(f.to, y + 9), pool: "all", top: 3 }));
      return this.buildField(false, { ...base, n: 60 }, pick.filter((x) => !seen.has(x.d.id) && seen.add(x.d.id)));
    }
    if (k === "nations") {
      const by = new Map();
      for (const x of this.matches({ ...f, nat: "", top: 0 })) {
        const n = natOf(x.d); if (!n) continue;
        const a = by.get(n) ?? []; if (a.length < 2) { a.push(x); by.set(n, a); }
      }
      return this.buildField(false, { ...base, n: 60 }, [...by.values()].flat().sort((a, b) => a.score - b.score));
    }
  }
  tool(k) {
    this.read();
    const f = this.filters(), es = this.cfg.entries;
    const dOf = (e) => this.drivers.find((x) => x.id === e.driver);
    const pace = (e) => rankPace(dOf(e)?.seasons[e.season]);
    if (k === "own") es.forEach((e) => { const c = dOf(e)?.seasons[e.season]?.car; if (c) e.car = c; });
    else if (k === "peak") es.forEach((e) => { const d = dOf(e); const y = d && bestSeason(d); if (y) e.season = y; });
    else if (k === "onecar") { const c = this.oneCar(f); if (c) es.forEach((e) => { e.car = c.id; }); }
    else if (k === "bestcar") es.forEach((e) => { const c = this.fastestCar(e.season, e.season); if (c) e.car = c.id; });
    else if (k === "sort") es.sort((a, b) => pace(a) - pace(b));
    else if (k === "reverse") es.reverse();
    else if (k === "shufd") shuffle(es);
    else if (k === "dedupe") { const s = new Set(); this.cfg.entries = es.filter((e) => !s.has(e.driver) && s.add(e.driver)); }
    else if (k === "trim") this.cfg.entries = es.slice(0, f.n);
    this.render();
  }

  open(cfg) { this.cfg = structuredClone(cfg); this.render(); $("setup").showModal(); }
  msg(t) { $("su-msg").textContent = t; }

  render() {
    const c = this.cfg;
    const circ = this.circuits.find((x) => x.ref === c.circuit) ?? this.circuits[0];
    c.circuit = circ.ref;
    $("su-circuit").value = circ.ref;
    $("su-layout").innerHTML = circ.layouts.map((l) => `<option value="${l.key}">${esc(l.name)} (${l.years[0]}–${l.years[1]})</option>`).join("");
    const lay = circ.layouts.find((l) => l.key === c.layout) ?? circ.layouts.find((l) => c.year >= l.years[0] && c.year <= l.years[1]) ?? circ.layouts.at(-1);
    c.layout = lay.key; $("su-layout").value = lay.key;
    $("su-name").value = c.name ?? "";
    $("su-year").value = c.year;
    const km = lay.length_km ?? 5;
    if (!c.laps) c.laps = Math.ceil(305 / km);
    $("su-laps").value = c.laps;
    $("su-wet").value = c.wet ?? 0; $("su-wetv").textContent = wetText(c.wet ?? 0);
    $("su-mode").value = c.mode ?? "relative";
    $("su-grid").value = c.grid ?? "quali";
    $("su-seed").value = c.seed ?? 1;
    const tb = $("su-entries");
    tb.innerHTML = "";
    c.entries.forEach((e, k) => {
      const d = this.db._ix?.drivers.get(e.driver) ?? this.db.drivers.find((x) => x.id === e.driver);
      const tr = document.createElement("tr");
      const seasons = d ? Object.keys(d.seasons).sort() : [];
      tr.innerHTML = `<td class="n">${k + 1}</td>
        <td class="th-cell">${carThumb(e.car, e.driver)}</td>
        <td><input list="dl-drivers" class="drv" id="su-d${k}" value="${esc(this.driverLabel.get(e.driver) ?? "")}" aria-label="Driver ${k + 1}"></td>
        <td><select class="sea" id="su-s${k}" aria-label="Season form for driver ${k + 1}">${seasons.map((y) => `<option${+y === +e.season ? " selected" : ""}>${y}</option>`).join("")}</select></td>
        <td><input list="dl-cars" class="car" id="su-c${k}" value="${esc(this.carLabel.get(e.car) ?? "")}" aria-label="Car ${k + 1}"></td>
        <td><input type="checkbox" id="su-m${k}"${e.mine ? " checked" : ""} aria-label="Entry ${k + 1} is yours"></td>
        <td><button class="btn x" title="Remove" aria-label="Remove entry ${k + 1}">✕</button></td>`;
      tr.querySelector(".x").addEventListener("click", () => { this.read(); this.cfg.entries.splice(k, 1); this.render(); });
      tr.querySelector(".drv").addEventListener("change", (ev) => {
        const nd = this.driverByLabel.get(ev.target.value);
        if (!nd) { ev.target.setCustomValidity("Pick a driver from the list"); ev.target.reportValidity(); return; }
        this.read();
        const ys = Object.keys(nd.seasons).map(Number);
        const carYear = this.cars.find((x) => x.id === this.cfg.entries[k].car)?.year;
        this.cfg.entries[k].season = ys.includes(carYear) ? carYear : bestSeason(nd);
        this.render();
      });
      tb.appendChild(tr);
    });
    this.paint?.(tb);
    $("su-count").textContent = `${c.entries.length} car${c.entries.length === 1 ? "" : "s"}`;
    $("su-run").disabled = c.entries.length < 2;
  }

  read() {                                // form -> this.cfg (keeps the last valid pick per field)
    const c = this.cfg;
    c.name = $("su-name").value.trim();
    c.circuit = $("su-circuit").value; c.layout = $("su-layout").value;
    c.year = clampInt($("su-year").value, 1906, 2026, c.year);
    c.laps = clampInt($("su-laps").value, 1, 120, c.laps);
    c.wet = Number($("su-wet").value); c.mode = $("su-mode").value; c.grid = $("su-grid").value;
    c.seed = clampInt($("su-seed").value, 1, 1e9, 1);
    c.entries.forEach((e, k) => {
      const d = this.driverByLabel.get($(`su-d${k}`)?.value); if (d) e.driver = d.id;
      const s = Number($(`su-s${k}`)?.value); if (s) e.season = s;
      const car = this.carByLabel.get($(`su-c${k}`)?.value); if (car) e.car = car.id;
      const m = $(`su-m${k}`); if (m) { if (m.checked) e.mine = true; else delete e.mine; }
    });
    delete c.raceId;
    c.calls = [];
  }

  randomEntry(entries = this.cfg.entries, minSeasons = 1) {   // a driver not already in `entries`, in a random car
    const taken = new Set(entries.map((e) => e.driver));
    const pool = this.drivers.filter((d) => !taken.has(d.id) && Object.keys(d.seasons).length >= minSeasons);
    if (!pool.length) return null;
    const d = pool[Math.floor(Math.random() * pool.length)];
    const car = this.cars[Math.floor(Math.random() * this.cars.length)];
    return { driver: d.id, season: bestSeason(d), car: car.id };
  }
  fillSeason(y) {
    this.read();
    const r = this.db.races.filter((x) => x.year === y && x.grid.length).sort((a, b) => a.round - b.round)[0];
    if (!r) {                       // no real grid (pre-1981): everyone with a season that year, fastest first
      const es = this.drivers.filter((d) => d.seasons[y]?.car)
        .map((d) => ({ driver: d.id, season: y, car: d.seasons[y].car, p: d.seasons[y].skills?.pace?.[0] ?? 9 }))
        .sort((a, b) => a.p - b.p).slice(0, 26);
      if (!es.length) return;
      this.cfg.entries = es.map(({ p, ...e }) => e);
      this.render(); this.msg(`Loaded ${es.length} drivers of ${y} (no lap data that year: line-up from season results).`);
      return;
    }
    this.cfg.entries = r.grid.filter(([, c]) => c).map(([d, car]) => ({ driver: d, season: y, car }));
    this.render(); this.msg(`Loaded the ${y} ${r.name} line-up.`);
  }
  validate(c) {
    if (!c || !Array.isArray(c.entries)) throw new Error("no entries list");
    for (const e of c.entries) {
      if (!this.driverLabel.has(e.driver)) throw new Error(`unknown driver id ${e.driver}`);
      if (!this.carLabel.has(e.car)) throw new Error(`unknown car ${e.car}`);
    }
    if (!this.circuits.some((x) => x.ref === c.circuit)) throw new Error(`no track map for circuit ${c.circuit}`);
  }
  run() {
    this.read();
    if (this.cfg.entries.length < 2) { this.msg("Add at least two cars."); return; }
    $("setup").close();
    this.onRun(structuredClone(this.cfg));
  }
  // saved configs (this browser only)
  refreshSaved() {
    const all = store.get("configs") ?? {};
    const names = Object.keys(all).sort();
    $("su-saved").innerHTML = names.length ? names.map((n) => `<option>${esc(n)}</option>`).join("") : `<option value="">No saved setups</option>`;
  }
  save() {
    this.read();
    const name = this.cfg.name || `Setup ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    this.cfg.name = name; $("su-name").value = name;
    const all = store.get("configs") ?? {};
    all[name] = this.cfg;
    this.msg(store.set("configs", all) ? `Saved "${name}" in this browser.` : "This browser blocked storage: use Export instead.");
    this.refreshSaved(); $("su-saved").value = name;
  }
  load() {
    const all = store.get("configs") ?? {}, n = $("su-saved").value;
    if (all[n]) { this.cfg = structuredClone(all[n]); this.render(); this.msg(`Loaded "${n}".`); }
  }
  del() {
    const all = store.get("configs") ?? {}, n = $("su-saved").value;
    if (!all[n]) return;
    delete all[n]; store.set("configs", all); this.refreshSaved(); this.msg(`Deleted "${n}".`);
  }
}

// nationality for the filter: the first one listed, as an adjective (the pre-war data uses country codes)
const NAT_CODE = { I: "Italian", F: "French", GB: "British", D: "German", USA: "American", CH: "Swiss", B: "Belgian",
  NL: "Dutch", E: "Spanish", A: "Austrian", CS: "Czechoslovak", CZ: "Czechoslovak", H: "Hungarian", PL: "Polish",
  S: "Swedish", FIN: "Finnish", MC: "Monegasque", RA: "Argentine", BR: "Brazilian", AUS: "Australian", NZ: "New Zealander",
  ZA: "South African", CDN: "Canadian", RO: "Romanian", RUS: "Russian", RU: "Russian", GR: "Greek", EST: "Estonian",
  P: "Portuguese", L: "Luxembourgish", N: "Norwegian", RCH: "Chilean", DZ: "Algerian", TN: "Tunisian", MA: "Moroccan",
  J: "Japanese", DK: "Danish", IRL: "Irish" };
function natOf(d) {
  const n = String(d.nationality ?? "").split("/")[0].trim();
  if (!n) return "";
  const a = NAT_CODE[n.toUpperCase()] ?? n;
  return a === "Argentinian" ? "Argentine" : a === "Czech" ? "Czechoslovak" : a;
}

// cross-era ranking value (lower = faster): the era-standardised z when the DB has it (era_std), else raw pace
// on roughly the same scale (a typical within-season spread of ~0.4%)
// (era_std's z shrunk by its uncertainty, z / (1 + sd^2), so thin records against weak fields don't top the list)
const rankPace = (s) => { const z = s?.std?.pace; if (z) return z[0] / (1 + z[1] ** 2);
  return s?.skills?.pace?.[0] != null ? s.skills.pace[0] / 0.4 : 99; };

function bestSeason(d) {               // the driver's best season by pace (lower is better)
  let best = null, bv = Infinity;
  for (const [y, s] of Object.entries(d.seasons)) { const v = s.skills?.pace?.[0]; if (v != null && v < bv) { bv = v; best = +y; } }
  return best ?? Math.max(...Object.keys(d.seasons).map(Number));
}
const wetText = (w) => (w <= 0.05 ? "Dry" : w < 0.4 ? "Damp" : w < 0.75 ? "Wet" : "Heavy rain");
const clampInt = (v, a, b, d) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(b, Math.max(a, x)) : d; };
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
