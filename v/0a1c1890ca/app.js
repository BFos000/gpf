// Fantasy GP viewer: pick a real race, simulate it, watch it.
import { simulateRace } from "./sim/race.js";
import { buildPlayback, fmtLap, fmtGap, fmtClock, PIT_IN_M } from "./playback.js";
import { Sprites, TrackMap, PaperdollStrip, ElevationProfile, autoLivery, colourEvidence } from "./draw.js";
import { Setup, configFromRace } from "./setup.js";
import { SeasonUI } from "./season.js";
import { CareerUI } from "./career_ui.js";
import { RealUI } from "./real_ui.js";

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem("fgp." + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("fgp." + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const SPEEDS = [1, 4, 10, 30, 60, 120, 240, 480];
const ROW_H = 28;
const esc = (x) => String(x).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

let db, sprites, tracksAvail, pb = null, mapView = null, strip = null, elevView = null;
let t = -3, playing = false, speed = store.get("speed") ?? 10, focus = 0, gapMode = "gap";
let lastUi = 0, lastFeedN = -1, raceInfo = null, cfg = null, setup = null, season = null, career = null, realUi = null, liveryKit = null;
const trackCache = new Map();

// ---------- colours: livery colour, lifted so dark liveries stay visible on the map ----------
const colourCache = new Map();
function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
const hsl = ([h, s, l]) => `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`;
function carColour(c) {
  if (colourCache.has(c.car)) return colourCache.get(c.car);
  const car = db._ix?.cars.get(c.car) ?? db.cars.find((x) => x.id === c.car);
  const m = sprites.car(c.car);
  const [c1, c2] = car?.colours ?? [m?.colour ?? "#888888", m?.colour2 ?? "#cccccc"];
  const a = hexToHsl(c1), b = hexToHsl(c2);
  // lift very dark liveries so they read on the dark track; light ones stay as they are
  const fill = hsl([a[0], a[1], Math.max(0.42, a[2])]);
  const edge = hsl([b[0], b[1], Math.abs(b[2] - a[2]) < 0.2 ? (a[2] > 0.5 ? 0.15 : 0.85) : b[2]]);
  const v = { fill, edge, bar: fill };
  colourCache.set(c.car, v);
  return v;
}

// ---------- data ----------
async function getJson(p) { const r = await fetch(p); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); }
async function trackFor(circuit, layoutKey) {
  const lay = db.circuits.find((c) => c.ref === circuit)?.layouts.find((l) => l.key === layoutKey);
  const g = lay?.geo_id;
  if (!g || !tracksAvail.has(g)) return null;
  if (!trackCache.has(g)) trackCache.set(g, await getJson(`data/tracks/${g}.json`));
  return trackCache.get(g);
}
const wetOf = (race) => (race.weather ? Math.min(1, (race.weather.rain_mm ?? 0) / 3) : 0);

// car / helmet thumbnails in the dialogs (thumbs.js); the car's main colour for fallback shapes
const thumbColour = (id) => { const car = id && (db._ix?.cars.get(id) ?? db.cars.find((x) => x.id === id)); return car?.colours?.[0] ?? sprites?.car(id)?.colour ?? "#888888"; };
const paint = (el) => sprites?.paintThumbs(el, thumbColour);

function fillRaces() {
  const sel = $("race");
  const ok = db.races.filter((r) => r.laps && r.grid.filter(([, c]) => c).length >= 6 && (() => {
    const lay = db.circuits.find((c) => c.ref === r.circuit)?.layouts.find((l) => l.key === r.layout);
    return lay?.geo_id && tracksAvail.has(lay.geo_id);
  })());
  const byYear = new Map();
  for (const r of ok) { if (!byYear.has(r.year)) byYear.set(r.year, []); byYear.get(r.year).push(r); }
  sel.innerHTML = "";
  for (const [y, rs] of [...byYear].sort((a, b) => b[0] - a[0])) {
    const og = document.createElement("optgroup"); og.label = y;
    for (const r of rs) { const o = document.createElement("option"); o.value = r.id; o.textContent = `${y} R${r.round} · ${r.name}`; og.appendChild(o); }
    sel.appendChild(og);
  }
  const saved = store.get("race");
  sel.value = ok.some((r) => r.id === saved) ? saved : ok.find((r) => r.year === 2016 && r.round === 7)?.id ?? ok.at(-1).id;
}

// ---------- run a race ----------
function loadRealRace() {
  const race = db._races.get(Number($("race").value));
  cfg = { ...configFromRace(db, race), seed: Math.max(1, Math.floor(Number($("seed").value) || 1)) };
  store.set("race", race.id);
  run();
}
async function run(keep = false) {
  const keepT = keep ? t : null, keepPlaying = playing, keepFocus = focus;
  if (!keep) cfg.calls = [];
  const seedIn = Math.max(1, Math.floor(Number($("seed").value) || cfg.seed || 1));
  if (cfg.seasonRound != null && seedIn !== cfg.seed) delete cfg.seasonRound;   // a re-rolled round is not the season's
  if (cfg.career && seedIn !== cfg.seed) delete cfg.career;
  if (cfg.real && seedIn !== cfg.seed) delete cfg.real;
  cfg.seed = seedIn;
  store.set("seed", cfg.seed); store.set("cfg", cfg);
  $("loading").hidden = false; $("loading").textContent = "Simulating…";
  raceInfo = null;                                    // nothing records until this race is built
  const track = await trackFor(cfg.circuit, cfg.layout);
  if (!track) { $("loading").textContent = "No track map for this layout yet."; return; }
  const entries = cfg.entries;
  await sprites.ready([...new Set(entries.map((e) => sprites.car(e.car)?.sheet).filter(Boolean)), "helmets.webp"]);
  const out = simulateRace(db, { seed: cfg.seed, year: cfg.year, circuit: cfg.circuit, layout: cfg.layout, laps: cfg.laps,
                                 wet: cfg.wet, grid: cfg.grid, mode: cfg.mode, entries, calls: cfg.calls ?? [],
                                 relReliability: !!cfg.relReliability }, track);
  pb = buildPlayback(out, track);
  mapView = new TrackMap($("mapcv"), track);
  elevView = new ElevationProfile($("elevcv"));
  $("elevcv").hidden = !pb.zAt;
  $("hills").disabled = !pb.zAt;
  $("hills").parentElement.title = pb.zAt ? "Show the track's hills on the strip" : "No elevation data for this track yet";
  raceInfo = { cfg, track, out };
  focus = keep ? keepFocus : (cfg.entries.findIndex((e) => e.mine) >= 0 ? cfg.entries.findIndex((e) => e.mine) : out.cars.find((c) => c.grid === 1)?.i ?? 0);
  t = keep ? keepT : -3; playing = false; lastFeedN = -1;
  $("scrub").min = -3; $("scrub").max = Math.ceil(pb.tEnd + 20);
  $("wx").textContent = cfg.wet > 0.3 ? "Wet" : cfg.wet > 0.05 ? "Damp" : "Dry";
  $("result").textContent = "";
  seasonChip();
  $("careerchip").hidden = !cfg.career;
  $("realchip").hidden = !cfg.real;
  const circ = db.circuits.find((c) => c.ref === cfg.circuit);
  $("hudrace").textContent = cfg.name || `${circ.name}, ${cfg.year} rules`;
  if (cfg.raceId) $("race").value = cfg.raceId;
  buildRows();
  $("loading").hidden = true;
  setPlaying(keep ? keepPlaying : true);
  render(true);
}

function seasonChip() {
  const S = season?.S, k = cfg?.seasonRound;
  const chip = $("seasonchip");
  if (!S || k == null) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.textContent = S.results[k] ? `Round ${k + 1} recorded: open the season` : `Season round ${k + 1} of ${S.rounds.length}`;
}

// ---------- pit wall ----------
const isMine = (i) => !!cfg.entries[i]?.mine;
let lastPw = "";
function updatePitWall(snap) {
  const c = pb.cars[focus], s = snap.byCar[focus];
  const mine = isMine(focus);
  $("pw-badge").textContent = mine ? "YOUR CAR" : "CPU";
  $("pw-badge").className = "badge" + (mine ? " you" : "");
  const hs = sprites.helmetStyle(c.driver, 28, c.car, carColour(c).fill);
  $("pw-hel").setAttribute("style", hs ?? `background:${carColour(c).fill};border-radius:50%`);
  $("pw-name").innerHTML = "";
  $("pw-name").append(c.name ?? "", Object.assign(document.createElement("small"), { textContent: `${c.carName} ${c.carYear}` }));
  $("pw-pos").textContent = s.state === "dnf" ? "OUT" : `P${s.pos}`;
  // last completed lap carries the strategist's state
  const lp = c.laps.filter((x) => x.end <= t).at(-1);
  const age = s.state === "pit" ? 0 : (lp?.age ?? 0);
  const out = raceInfo.out;
  const lossS = (out.baseLap * (c.deg * age + 0.012 * Math.max(0, age - c.life) ** 2)) / 100;
  $("pw-tyres").textContent = s.state === "pit" ? "changing" : `${age} lap${age === 1 ? "" : "s"} old`;
  $("pw-cost").textContent = `+${lossS.toFixed(2)} s/lap`;
  const stops = c.stopsAt.filter((x) => x.t <= t);
  $("pw-stops").textContent = stops.length ? `${stops.length} (lap ${stops.map((x) => x.lap).join(", ")})` : "none yet";
  const plan = lp?.plan;
  $("pw-plan").textContent = s.state === "dnf" ? "retired" : s.state === "fin" ? "finished" : !plan ? "deciding" :
    plan.next === null ? "to the flag" : `${plan.k} more, ~lap ${plan.next}`;
  $("pw-fuelbox").hidden = !out.refuel;
  if (out.refuel) $("pw-fuel").textContent = lp?.fuel != null ? `${lp.fuel} laps` : "";
  const style = c.aggression > 1.1 ? "aggressive" : c.aggression < 0.85 ? "cautious" : "balanced";
  const readTxt = c.read > 1.15 ? ", overrates wear" : c.read < 0.87 ? ", underrates wear" : "";
  $("pw-style").textContent = mine ? "you" : style + readTxt;
  const life = isFinite(c.life) && c.life < 500 ? c.life : null;
  $("pw-wear").style.width = `${Math.min(100, life ? (100 * age) / life : (100 * lossS) / 2.5)}%`;
  // reasoning, newest first
  const log = c.log.filter((x) => x.t <= t).slice(-6).reverse();
  const key = `${focus}|${log.length}|${log[0]?.t}|${mine}|${s.state}`;
  if (key !== lastPw) {
    lastPw = key;
    const ol = $("pw-log"); ol.innerHTML = "";
    if (!log.length) { const li = document.createElement("li"); li.innerHTML = '<span class="l"></span><span>Waiting for the start.</span>'; ol.appendChild(li); }
    for (const e of log) {
      const li = document.createElement("li");
      li.className = e.act === "box" ? "box" : e.act === "call" ? "call" : "";
      li.innerHTML = `<span class="l">L${e.lap}</span><span></span>`;
      li.children[1].textContent = e.text;
      ol.appendChild(li);
    }
    buildControls(mine, s);
  }
}
function buildControls(mine, s) {
  const box = $("pw-ctl"); box.innerHTML = "";
  if (s.state === "dnf" || s.state === "fin") return;
  if (!mine) {
    const b = document.createElement("button"); b.className = "btn"; b.textContent = "Take control of this car";
    b.addEventListener("click", () => { cfg.entries[focus].mine = true; store.set("cfg", cfg); lastPw = ""; buildRows(); render(true); });
    box.appendChild(b); return;
  }
  const btn = (txt, title, fn) => { const b = document.createElement("button"); b.className = "btn"; b.textContent = txt; b.title = title; b.addEventListener("click", fn); box.appendChild(b); return b; };
  btn("Box this lap", "Pit at the end of this lap (or the next, if the car is past the pit entry)", () => call("box"));
  btn("Stay out", "Ignore the strategist's stop calls for 3 laps", () => call("stay", 3));
  const seg = (label, opts, action) => {
    const l = document.createElement("label"); l.textContent = label; box.appendChild(l);
    const d = document.createElement("div"); d.className = "seg"; box.appendChild(d);
    for (const [v, txt] of opts) {
      const b = document.createElement("button"); b.textContent = txt;
      const cur = [...(cfg.calls ?? [])].reverse().find((x) => x.car === focus && x.action === action);
      if (cur ? cur.value === v : v === (action === "pace" ? "normal" : null)) b.className = "on";
      b.addEventListener("click", () => call(action, v)); d.appendChild(b);
    }
  };
  seg("Stops from here", [[null, "Auto"], [0, "0"], [1, "1"], [2, "2"], [3, "3"]], "stops");
  seg("Pace", [["push", "Push"], ["normal", "Normal"], ["conserve", "Conserve"]], "pace");
  const rel = document.createElement("button"); rel.className = "btn"; rel.textContent = "Hand back to CPU";
  rel.addEventListener("click", () => { delete cfg.entries[focus].mine; store.set("cfg", cfg); lastPw = ""; buildRows(); render(true); });
  box.appendChild(rel);
}
// a strategy call: re-simulate the race with the call added (laps before it are unchanged)
function call(action, value) {
  const s = pb.snapshot(t).byCar[focus];
  let lap = Math.max(2, s.done + 1);
  const N = raceInfo.track.x.length, pastEntry = s.idx !== null && s.idx > N - PIT_IN_M / raceInfo.track.step_m - 20;
  if (action === "pace" || action === "stops" || pastEntry || s.state === "pit") lap += 1;
  if (lap > pb.nLaps) { $("pw-msg").textContent = "Too late for that call."; return; }
  cfg.calls = (cfg.calls ?? []).filter((x) => !(x.car === focus && x.action === action && x.lap === lap));
  // t: the race time the call was made (rewinding to before it takes the call back)
  if (action === "stops" && value === null) {
    cfg.calls.push({ car: focus, lap, action, value: null, t });
  } else cfg.calls.push({ car: focus, lap, action, value, t });
  const what = action === "box" ? `box at the end of lap ${lap}` : action === "stay" ? `stay out from lap ${lap}` :
    action === "stops" ? (value === null ? `strategist picks the stops from lap ${lap}` : `${value} more stop${value === 1 ? "" : "s"} from lap ${lap}`) : `${value} pace from lap ${lap}`;
  $("pw-msg").textContent = `Call sent: ${what}.`;
  lastPw = "";
  run(true);
}

// ---------- timing tower ----------
let rowEls = [];
function buildRows() {
  const box = $("rows");
  box.innerHTML = "";
  rowEls = pb.cars.map((c) => {
    const el = document.createElement("div");
    el.className = "row";
    const col = carColour(c);
    const hs = sprites.helmetStyle(c.driver, 24, c.car, col.fill);
    const surname = (c.name ?? "").split(" ").slice(-1)[0];
    el.innerHTML = `<span class="p"></span><span class="bar" style="background:${col.bar}"></span>` +
      `<span class="hel" style="${hs ?? `background:${col.fill};border-radius:50%;transform:scale(.7)`}"></span>` +
      `<span class="nm">${isMine(c.i) ? '<span class="mine" title="Your car">★</span>' : ""}${esc(c.name ?? surname)}<small>${c.carYear ?? ""} ${esc(c.carName ?? "")}</small></span>` +
      `<span class="gap"></span><span class="lap"></span><span class="st"></span>`;
    el.title = `${c.name} · ${c.carName} ${c.carYear}`;
    el.addEventListener("click", () => setFocus(c.i));
    box.appendChild(el);
    return { el, p: el.children[0], gap: el.children[4], lap: el.children[5], st: el.children[6] };
  });
  // the rows are absolutely positioned: a sizer gives the box its scroll height, and the name column
  // is as wide as the longest name (the tower scrolls sideways when it doesn't fit)
  const sizer = document.createElement("div"); sizer.className = "sizer";
  sizer.style.height = `${pb.cars.length * ROW_H}px`;
  box.appendChild(sizer);
  const nmw = Math.ceil(Math.max(0, ...rowEls.map((r) => r.el.children[3].scrollWidth))) + 4;
  box.style.setProperty("--nmw", `${nmw}px`);
  box.style.setProperty("--roww", `${26 + 4 + 24 + nmw + 76 + 64 + 30 + 6 * 6 + 12}px`);
  sizer.style.width = `${26 + 4 + 24 + nmw + 76 + 64 + 30 + 6 * 6 + 12}px`;
}
function updateRows(snap) {
  for (const s of snap.order) {
    const r = rowEls[s.c.i];
    r.el.style.transform = `translateY(${(s.pos - 1) * ROW_H}px)`;
    r.el.classList.toggle("focus", s.c.i === focus);
    r.el.classList.toggle("dnf", s.state === "dnf");
    r.p.textContent = s.pos;
    const g = gapMode === "gap" ? s.gap : s.int;
    r.gap.textContent = s.state === "dnf" ? "" : s.pos === 1 ? (s.state === "fin" ? "Winner" : `Lap ${Math.min(pb.nLaps, s.done + 1)}`) : fmtGap(g);
    r.lap.textContent = s.state === "pit" ? "" : fmtLap(s.last);
    const fl = snap.fastest && snap.fastest.c === s.c.i && s.last === snap.fastest.dur;
    r.lap.className = "lap" + (fl ? " fl" : s.last && s.last === s.pb ? " pb" : "");
    const [cls, txt] = s.state === "pit" ? ["pit", "PIT"] : s.state === "dnf" ? ["out", "OUT"] : s.state === "fin" ? ["fin", "🏁"] :
      s.state === "out" ? ["", "OUT"] : ["", s.stops ? `${s.stops}S` : ""];
    r.st.className = "st " + cls; r.st.textContent = txt;
    r.st.title = s.state === "dnf" ? (s.c.retCause ?? "retired") : `${s.stops} stop${s.stops === 1 ? "" : "s"}, tyres ${s.tyre} laps old`;
  }
}

// ---------- feed ----------
const code = (i) => pb.cars[i].code ?? pb.cars[i].name;
function feedText(e) {
  switch (e.kind) {
    case "pass": return `${code(e.c)} passes ${code(e.on)}`;
    case "pit": return `${code(e.c)} pits (${e.s.toFixed(1)} s)${e.text ? ": " + e.text.replace(/\.$/, "") : ""}`;
    case "retire": return `${code(e.c)} retires: ${e.cause === "mechanical" ? "mechanical failure" : "accident"}`;
    case "loss": return `${code(e.c)} loses ${e.s.toFixed(1)} s (off / mistake)`;
    case "damage": return `${code(e.c)} picks up damage`;
    case "call": return e.why === "sc" ? `${code(e.c)} told to box under the safety car` : `${code(e.c)} reacts to ${code(e.on)}'s stop: box this lap`;
    case "sc": return `Safety car deployed${e.why === "incident" ? " after a crash" : e.why === "mechanical" ? ": a car has stopped on track" : e.why === "debris" ? ": debris on track" : ""}`;
    case "sc_in": return `Safety car in this lap${e.unlap ? "; lapped cars may now overtake" : ""}`;
    case "sc_end": return "Safety car in, racing resumes";
    case "vsc": return `Virtual safety car${e.why === "mechanical" ? ": a car has stopped on track" : e.why === "incident" ? " after a crash" : ""}`;
    case "vsc_end": return "VSC ending, racing resumes";
    case "flag": return `Chequered flag: ${pb.cars[e.c].name} wins`;
    default: return e.kind;
  }
}
function updateFeed() {
  let n = 0; while (n < pb.feed.length && pb.feed[n].t <= t) n++;
  if (n === lastFeedN) return;
  lastFeedN = n;
  const ol = $("feed");
  ol.innerHTML = "";
  for (let k = n - 1; k >= Math.max(0, n - 80); k--) {
    const e = pb.feed[k];
    const li = document.createElement("li");
    li.className = e.kind;
    li.innerHTML = `<span class="l">L${e.lap}</span><span></span>`;
    li.children[1].textContent = feedText(e);
    li.addEventListener("click", () => { seek(e.t - 4); if (e.c !== undefined) setFocus(e.c); });
    ol.appendChild(li);
  }
  $("feedcount").textContent = `${n} events`;
}

// ---------- render loop ----------
function render(force = false) {
  if (!pb) return;
  const snap = pb.snapshot(t);
  const colour = (c) => carColour(c);
  mapView.draw(snap, { focus, colour });
  if (pb.zAt) elevView.draw(snap, pb, { focus, colour });
  strip.draw(snap, pb, { focus, colour, hills: $("hills").checked });
  const now = performance.now();
  if (force || now - lastUi > 120) {
    lastUi = now;
    updateRows(snap);
    updateFeed();
    updatePitWall(snap);
    $("hudlap").innerHTML = t < 0 ? "Grid" : `Lap ${snap.leadLap}<span> / ${pb.nLaps}</span>`;
    const f = snap.byCar[focus];
    $("hudsub").textContent = `Focus: ${pb.cars[focus].name} · P${f.pos}${f.gap ? " · " + fmtGap(f.gap) : ""}` +
      (snap.fastest ? ` · Fastest lap ${code(snap.fastest.c)} ${fmtLap(snap.fastest.dur)}` : "");
    const flag = $("flag");
    if (snap.finished) { flag.hidden = false; flag.className = "flag chq"; flag.innerHTML = "<span>FINISH</span>"; }
    else if (snap.sc) { flag.hidden = false; flag.className = "flag sc"; flag.textContent = "SAFETY CAR"; }
    else if (snap.vsc) { flag.hidden = false; flag.className = "flag sc"; flag.textContent = "VIRTUAL SAFETY CAR"; }
    else flag.hidden = true;
    $("clock").textContent = `${fmtClock(t)} / ${fmtClock(pb.tEnd)}`;
    if (document.activeElement !== $("scrub")) $("scrub").value = t;
    // only the race on screen counts: while the next race loads, the old one (still at its flag) must not be
    // recorded against the new race's config
    if (snap.finished && raceInfo?.cfg === cfg) {
      const top = raceInfo.out.result.slice(0, 3).map((r) => code(r.c)).join(" · ");
      $("result").textContent = `Podium: ${top}`;
      if (cfg.seasonRound != null && season?.finished(cfg.seasonRound)) seasonChip();
      if (cfg.career && !cfg.career.replay && !cfg.career.recorded) {
        cfg.career.recorded = true;
        if (career.finished(cfg, raceInfo.out, cfg.calls)) $("result").textContent += " · result recorded";
      }
      if (cfg.real && !cfg.real.replay && !cfg.real.recorded) {
        cfg.real.recorded = true;
        if (realUi?.finished(cfg, raceInfo.out, cfg.calls)) $("result").textContent += " · result recorded";
      }
      $("careerchip").hidden = !cfg.career;
      $("realchip").hidden = !cfg.real;
    }
  }
}
let lastFrame = null;
function frame(ts) {
  if (lastFrame !== null && playing && pb) {
    t = Math.min(pb.tEnd + 20, t + ((ts - lastFrame) / 1000) * speed);
    if (t >= pb.tEnd + 20) setPlaying(false);
  }
  lastFrame = ts;
  render();
  requestAnimationFrame(frame);
}

// ---------- controls ----------
function setPlaying(p) { playing = p; $("play").textContent = p ? "❚❚" : "▶"; $("play").setAttribute("aria-label", p ? "Pause" : "Play"); }
function seek(x) {
  const was = t;
  t = Math.max(-3, Math.min(pb.tEnd + 20, x)); lastFeedN = -1;
  // rewinding takes back the manual calls made after the new time, and re-runs the race without them
  if (t < was && cfg.calls?.some((c) => c.t != null && c.t > t)) {
    const n = cfg.calls.length;
    cfg.calls = cfg.calls.filter((c) => c.t == null || c.t <= t);
    $("pw-msg").textContent = `Rewound: ${n - cfg.calls.length} call${n - cfg.calls.length === 1 ? "" : "s"} undone.`;
    lastPw = "";
    run(true);
    return;
  }
  render(true);
}
function setFocus(i) { focus = i; lastPw = ""; $("pw-msg").textContent = ""; render(true); }
function focusStep(dir) {
  const snap = pb.snapshot(t);
  const p = snap.byCar[focus].pos - 1 + dir;
  if (p >= 0 && p < snap.order.length) setFocus(snap.order[p].c.i);
}
function packZoom() {                 // fit the nearest car ahead and behind (or 60 m)
  const snap = pb.snapshot(t);
  const f = snap.byCar[focus];
  const ds = [-1, 1].map((k) => snap.order[f.pos - 1 + k]).filter((s) => s && s.idx !== null && s.state !== "dnf")
    .map((s) => Math.abs((s.progress - f.progress) * pb.L));
  strip.half = Math.min(1500, Math.max(20, ...ds.map((d) => d * 1.25), 20));
  render(true);
}
function buildSpeeds() {
  const box = $("speeds");
  box.innerHTML = "";
  for (const s of SPEEDS) {
    const b = document.createElement("button");
    b.textContent = `${s}×`; b.className = s === speed ? "on" : "";
    b.addEventListener("click", () => { speed = s; store.set("speed", s); buildSpeeds(); });
    box.appendChild(b);
  }
}

async function main() {
  try {
    const [gdb, sm, ti, rs] = await Promise.all([getJson("data/gamedb.json"), getJson("data/sprites/sprites.json"), getJson("data/tracks/index.json"),
      getJson("data/real_seasons.json").catch(() => null)]);
    db = gdb; db._races = new Map(db.races.map((r) => [r.id, r]));
    db.realSeasons = rs;          // real calendars and teams by season, iconic ratings, age curve (Real Seasons mode)
    sprites = new Sprites(sm, "data/sprites");
    sprites.setDriverEras(db.drivers);
    // the livery kit (own-team cars in Real Seasons): loads in the background; until then those cars use plain shapes
    import("./livery.js").then(async (L) => {
      const kit = await L.loadLiveryKit("data/sprites/liveries/");
      const evidence = colourEvidence(db, kit);
      const carOf = (id) => db._ix?.cars.get(id) ?? db.cars.find((c) => c.id === id);
      sprites.setLiveryKit(kit, L.drawLiveryCar, L.seasonFor, (id, driverId) => {
        const c = carOf(id);
        if (c?.livery) return c.livery;                              // the player's own team
        if (String(id).startsWith("rs_custom_")) return realUi?.S?.custom?.livery ?? null;   // its car in a past season
        if (!c || sprites.car(id)) return null;                      // real cars with art keep their sprite
        return autoLivery(kit, L, c, driverId, evidence.get(id));    // the rest: a period livery in evidenced colours
      });
      liveryKit = { kit, L };
      realUi?.render?.();
    }).catch((e) => console.warn("livery kit:", e));
    tracksAvail = new Set(ti);
  } catch (e) {
    $("loading").textContent = `Could not load the race data (${e.message}).`;
    return;
  }
  strip = new PaperdollStrip($("stripcv"), sprites);
  strip.half = store.get("zoom") ?? 60;
  fillRaces();
  $("seed").value = store.get("seed") ?? 1;
  buildSpeeds();
  setup = new Setup(db, tracksAvail, (c) => { delete c.seasonRound; delete c.career; cfg = c; $("seed").value = c.seed; run(); }, paint);
  career = new CareerUI(db, { store, trackFor, watch: (c) => { cfg = c; $("seed").value = c.seed; run(); },
    setHelmet: (id, url) => sprites?.setCustomHelmet(id, url), paint });
  $("opencareer").addEventListener("click", () => career.open());
  $("careerchip").addEventListener("click", () => career.open());
  realUi = new RealUI(db, { store, trackFor, watch: (c) => { cfg = c; $("seed").value = c.seed; run(); }, livery: () => liveryKit, paint });
  $("openreal").addEventListener("click", () => realUi.open());
  $("realchip").addEventListener("click", () => realUi.open());
  // resizable timing tower
  {
    const app = $("app"), rz = $("towerresize");
    const setW = (w) => { w = Math.round(Math.min(Math.max(200, w), Math.max(260, window.innerWidth * 0.6))); app.style.setProperty("--tower-w", `${w}px`); store.set("towerW", w); };
    const saved = store.get("towerW"); if (saved) app.style.setProperty("--tower-w", `${saved}px`);
    rz.addEventListener("pointerdown", (e) => {
      e.preventDefault(); rz.setPointerCapture(e.pointerId); rz.classList.add("drag");
      const x0 = e.clientX, w0 = rz.parentElement.getBoundingClientRect().width;
      const move = (ev) => { setW(w0 + ev.clientX - x0); render(true); };
      const up = () => { rz.classList.remove("drag"); rz.removeEventListener("pointermove", move); rz.removeEventListener("pointerup", up); };
      rz.addEventListener("pointermove", move); rz.addEventListener("pointerup", up);
    });
    rz.addEventListener("keydown", (e) => {
      const w = rz.parentElement.getBoundingClientRect().width;
      if (e.key === "ArrowLeft") { setW(w - 20); e.preventDefault(); } else if (e.key === "ArrowRight") { setW(w + 20); e.preventDefault(); }
    });
  }
  season = new SeasonUI(db, {
    store,
    hasTrack: (circuit, layout) => { const g = db.circuits.find((c) => c.ref === circuit)?.layouts.find((l) => l.key === layout)?.geo_id; return !!g && tracksAvail.has(g); },
    trackFor,
    currentCfg: () => cfg,
    // the viewer's race counts for round k only if it is that round, unchanged (same seed), and run to the flag
    loadedOut: (k, force) => {
      if (!raceInfo || raceInfo.cfg.seasonRound !== k || cfg.seasonRound !== k) return null;
      if (!force && !(pb && t >= pb.tEnd - 1)) return null;
      return raceInfo.out;
    },
    watch: (c) => { cfg = c; $("seed").value = c.seed; run(); },
  });
  $("openseason").addEventListener("click", () => season.open());
  $("seasonchip").addEventListener("click", () => season.open());
  $("opensetup").addEventListener("click", () => { cfg.seed = Number($("seed").value) || cfg.seed; setup.open(cfg); });
  $("go").addEventListener("click", () => run());
  $("reseed").addEventListener("click", () => { delete cfg.seasonRound; delete cfg.career; delete cfg.real; $("seed").value = 1 + Math.floor(Math.random() * 99999); run(); });
  $("race").addEventListener("change", loadRealRace);
  $("play").addEventListener("click", () => { if (pb && t >= pb.tEnd + 20) seek(-3); setPlaying(!playing); });
  $("scrub").addEventListener("input", (e) => seek(Number(e.target.value)));
  $("gapmode").addEventListener("click", () => {
    gapMode = gapMode === "gap" ? "int" : "gap";
    $("gapmode").textContent = gapMode === "gap" ? "Gap to leader" : "Interval";
    render(true);
  });
  const zoom = (f) => { strip.zoomBy(f); store.set("zoom", strip.half); render(true); };
  $("zin").addEventListener("click", () => zoom(1 / 1.6));
  $("zout").addEventListener("click", () => zoom(1.6));
  $("zfit").addEventListener("click", packZoom);
  $("prevcar").addEventListener("click", () => focusStep(-1));
  $("nextcar").addEventListener("click", () => focusStep(1));
  $("hills").checked = store.get("hills") ?? true;
  $("hills").addEventListener("change", () => { store.set("hills", $("hills").checked); render(true); });
  $("stripcv").addEventListener("wheel", (e) => { e.preventDefault(); zoom(Math.exp(e.deltaY * 0.0015)); }, { passive: false });
  $("stripcv").addEventListener("click", (e) => {
    const r = e.target.getBoundingClientRect();
    const i = strip.pick(e.clientX - r.left, e.clientY - r.top);
    if (i !== null) setFocus(i);
  });
  $("mapcv").addEventListener("click", (e) => {
    const r = e.target.getBoundingClientRect();
    const i = mapView?.pick(e.clientX - r.left, e.clientY - r.top);
    if (i != null) setFocus(i);
  });
  document.addEventListener("keydown", (e) => {
    if (!pb || ["INPUT", "SELECT", "BUTTON"].includes(document.activeElement?.tagName) && e.key === " ") return;
    if (["INPUT", "SELECT"].includes(document.activeElement?.tagName)) return;
    if (e.key === " ") { e.preventDefault(); setPlaying(!playing); }
    else if (e.key === "ArrowRight") seek(t + 10);
    else if (e.key === "ArrowLeft") seek(t - 10);
    else if (e.key === "ArrowUp") { e.preventDefault(); focusStep(-1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); focusStep(1); }
    else if (e.key === "+" || e.key === "=") zoom(1 / 1.6);
    else if (e.key === "-") zoom(1.6);
  });
  requestAnimationFrame(frame);
  const saved = store.get("cfg");
  try { if (saved) { setup.validate(saved); cfg = saved; } } catch { cfg = null; }
  if (cfg) await run(); else loadRealRace();
}
main();
