// Canvas drawing: track map, side-on paperdoll strip, sprite helpers.
import { PIT_IN_M, PIT_OUT_M } from "./playback.js";

// theme tokens, re-read at most twice a second (the viewer's theme can change while playing)
const cssCache = new Map(); let cssAt = 0;
const css = (name) => {
  const now = performance.now();
  if (now - cssAt > 500) { cssCache.clear(); cssAt = now; }
  if (!cssCache.has(name)) cssCache.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim());
  return cssCache.get(name);
};

export function fitCanvas(cv) {
  const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

// ---------- vintage cars (no sprite art before 1981): a side-on shape by period ----------
const PREWAR_SCALE = 0.8;
const LIFT_RATE = 150;            // px per second: how fast a car in the paperdoll strip moves between lanes
// ---------- livery-kit paint for real cars without sprite art ----------
// A period-correct random livery (the kit's randomLivery, seeded by the team so it stays put from race to race)
// in colours from the evidence we have, best first: the car's own colours (livery / colour table / national racing
// colour of the make); for a make of unknown nationality, a known make it shares a name with (Fiat Barsanti ->
// Fiat), else the nationality most of its drivers had; else a random national colour of the period. Trim colour
// from the kit's national palette nearest the main colour. The race number follows the driver.
const hashStr = (t) => { let h = 2166136261; for (const ch of String(t)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };
const NAT_PAL = { Italian: "italy", British: "britain", English: "britain", Scottish: "britain", Welsh: "britain", French: "france",
  German: "germany", Belgian: "belgium", American: "usa", Dutch: "netherlands", Swiss: "switzerland", Japanese: "japan",
  Argentine: "argentina", Argentinian: "argentina", "South African": "south_africa" };
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const dist = (a, b) => { const x = rgbOf(a), y = rgbOf(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
/** carId -> {base, c2, c3, src} for every car; src says which evidence was used */
export function colourEvidence(db, kit) {
  const P = kit.meta.palettes, nat = Object.keys(P).filter((k) => P[k].nation);
  const trim = (base, c2) => { const k = nat.reduce((a, b) => (dist(P[b].base, base) < dist(P[a].base, base) ? b : a)); return dist(P[k].base, base) < 90 ? P[k].c3 : c2; };
  const known = new Map();                                       // make-name token -> colours (makes with a nationality)
  for (const c of db.cars) if (c.colour_src && c.colour_src !== "default" && c.colours) {
    const t = String(c.ref ?? "").replace(/^pw_/, "").split("_")[0];
    if (t && !known.has(t)) known.set(t, c.colours);
  }
  const drv = new Map();                                         // carId -> nationality counts of its drivers
  for (const d of db.drivers) for (const se of Object.values(d.seasons ?? {})) for (const id of [se.car, ...(se.cars ?? [])]) {
    if (!id || !d.nationality) continue;
    const m = drv.get(id) ?? new Map(); m.set(d.nationality, (m.get(d.nationality) ?? 0) + 1); drv.set(id, m);
  }
  const out = new Map();
  for (const c of db.cars) {
    let col = null, src = null;
    if (c.colour_src && c.colour_src !== "default" && c.colours) { col = c.colours; src = c.colour_src; }
    if (!col) {
      const toks = String(c.ref ?? c.id).replace(/^(pw|ge)_/, "").split("_");
      const t = toks.find((x) => known.has(x));
      if (t) { col = known.get(t); src = "make"; }
    }
    if (!col && drv.has(c.id)) {
      const top = [...drv.get(c.id)].sort((a, b) => b[1] - a[1]).find(([n]) => NAT_PAL[n]);
      if (top) { const p = P[NAT_PAL[top[0]]]; out.set(c.id, { base: p.base, c2: p.c2, c3: p.c3, src: "drivers" }); continue; }
    }
    if (!col) { const p = P[nat[hashStr(c.ref ?? c.id) % nat.length]]; out.set(c.id, { base: p.base, c2: p.c2, c3: p.c3, src: "random" }); continue; }
    out.set(c.id, { base: col[0], c2: col[1] ?? col[0], c3: trim(col[0], col[1] ?? col[0]), src });
  }
  return out;
}
const autoLvCache = new Map();
export function autoLivery(kit, L, car, driverId, ev = null) {
  const key = `${car.id}|${driverId ?? ""}`;
  let lv = autoLvCache.get(key);
  if (lv) return lv;
  const col = ev ?? { base: car.colours?.[0] ?? "#888888", c2: car.colours?.[1] ?? "#cccccc", c3: car.colours?.[1] ?? "#cccccc" };
  const r = L.randomLivery(kit, car.year, hashStr(car.ref ?? car.id));
  const light = rgbOf(col.base).reduce((a, b) => a + b, 0) / 3 > 150;
  let wheel = r.colors.wheel;
  if (wheel && wheel === r.colors.c2) wheel = col.c2;            // painted rims in the accent colour
  lv = { ...r, colors: { base: col.base, c2: col.c2, c3: col.c3, ...(wheel ? { wheel } : {}) },
         number: driverId == null ? "" : String(1 + (hashStr(`n${driverId}`) % 39)),
         sponsors: r.sponsors.map((x) => ({ ...x, color: light ? "#141414" : x.color === r.colors.c2 ? col.c2 : x.color === r.colors.c3 ? col.c3 : x.color })) };
  if (lv.number_style === "plain") lv.number_colors = ["#000000", light ? "#141414" : "#f4f4f4"];
  autoLvCache.set(key, lv);
  if (autoLvCache.size > 4000) autoLvCache.delete(autoLvCache.keys().next().value);
  return lv;
}

const carYear = (id) => Number(String(id).split("_").pop()) || null;
// the driver's helmet against a car drawn w px wide: 1.25 x the car's helmet size, relatively bigger as the car
// shrinks so it stays recognisable (every view that draws a car with its driver: the strip, the thumbnails)
export const helmetScaleFor = (w) => 1.25 * Math.min(1.9, Math.max(1, 220 / w));
// front-engined (to 1960), cigar (to 1967), winged wedge (1968+; sidepods 1977+). Nose to the right.
// Returns the helmet centre and size [x, y, d], placed as on the sprites.
function drawVintage(ctx, x, yg, W, colour, year) {
  const r = W * (year < 1968 ? 0.085 : 0.095), rr = year < 1968 ? r : W * 0.105;
  const yb = yg - r * 0.55;                                     // body floor
  const ink = "rgba(0,0,0,.65)";
  ctx.lineWidth = Math.max(0.8, W / 160); ctx.strokeStyle = ink; ctx.fillStyle = colour;
  const wheel = (cx, rad) => {
    ctx.fillStyle = "#16181b"; ctx.beginPath(); ctx.arc(cx, yg - rad, rad, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = year < 1968 ? "#b9bec4" : "#55595f";
    ctx.beginPath(); ctx.arc(cx, yg - rad, rad * (year < 1968 ? 0.62 : 0.45), 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#16181b"; ctx.beginPath(); ctx.arc(cx, yg - rad, rad * 0.16, 0, Math.PI * 2); ctx.fill();
  };
  const P = (pts) => { ctx.beginPath(); pts.forEach(([u, v], k) => (k ? ctx.lineTo : ctx.moveTo).call(ctx, x + u * W, yb - v * W)); ctx.closePath(); };
  let helm;
  if (year <= 1960) {
    // long bonnet, driver behind the middle, rounded tail
    ctx.beginPath();
    ctx.moveTo(x + 0.03 * W, yb - 0.02 * W);
    ctx.quadraticCurveTo(x + 0.04 * W, yb - 0.11 * W, x + 0.2 * W, yb - 0.11 * W);
    ctx.lineTo(x + 0.62 * W, yb - 0.115 * W);
    ctx.quadraticCurveTo(x + 0.96 * W, yb - 0.11 * W, x + 0.98 * W, yb - 0.04 * W);
    ctx.lineTo(x + 0.97 * W, yb); ctx.lineTo(x + 0.05 * W, yb); ctx.closePath();
    ctx.fillStyle = colour; ctx.fill(); ctx.stroke();
    ctx.fillStyle = "rgba(10,10,10,.75)"; ctx.fillRect(x + 0.955 * W, yb - 0.075 * W, 0.02 * W, 0.05 * W);   // grille
    helm = [x + 0.36 * W, yb - 0.13 * W, 0.068 * W];
    ctx.fillStyle = "rgba(255,255,255,.9)"; ctx.beginPath(); ctx.arc(x + 0.55 * W, yb - 0.055 * W, 0.035 * W, 0, Math.PI * 2); ctx.fill();
  } else if (year < 1968) {
    // rear-engined cigar
    ctx.beginPath();
    ctx.moveTo(x + 0.02 * W, yb - 0.03 * W);
    ctx.quadraticCurveTo(x + 0.08 * W, yb - 0.09 * W, x + 0.3 * W, yb - 0.09 * W);
    ctx.lineTo(x + 0.62 * W, yb - 0.085 * W);
    ctx.quadraticCurveTo(x + 0.95 * W, yb - 0.06 * W, x + 0.99 * W, yb - 0.025 * W);
    ctx.lineTo(x + 0.97 * W, yb); ctx.lineTo(x + 0.06 * W, yb); ctx.closePath();
    ctx.fillStyle = colour; ctx.fill(); ctx.stroke();
    ctx.strokeStyle = "#8a9096"; ctx.beginPath();                                                          // exhausts
    ctx.moveTo(x + 0.25 * W, yb - 0.035 * W); ctx.lineTo(x + 0.02 * W, yb - 0.05 * W); ctx.stroke(); ctx.strokeStyle = ink;
    helm = [x + 0.47 * W, yb - 0.1 * W, 0.066 * W];
    ctx.fillStyle = "rgba(255,255,255,.9)"; ctx.beginPath(); ctx.arc(x + 0.7 * W, yb - 0.045 * W, 0.03 * W, 0, Math.PI * 2); ctx.fill();
  } else {
    // wedge with wings; airbox behind the driver
    ctx.fillStyle = colour;
    P([[0.08, 0.02], [0.1, 0.1], [0.42, 0.1], [0.62, 0.085], [0.99, 0.015], [0.98, 0], [0.08, 0]]); ctx.fill(); ctx.stroke();
    if (year >= 1977) { P([[0.3, 0], [0.3, 0.06], [0.66, 0.05], [0.7, 0]]); ctx.fillStyle = colour; ctx.fill(); ctx.stroke(); }
    P([[0.38, 0.1], [0.4, 0.17], [0.47, 0.17], [0.5, 0.1]]); ctx.fillStyle = colour; ctx.fill(); ctx.stroke();      // airbox
    ctx.fillStyle = "#1c1e21"; ctx.fillRect(x + 0.06 * W, yb - 0.11 * W, 0.012 * W, 0.08 * W);           // wing strut
    P([[-0.01, 0.1], [0.15, 0.115], [0.15, 0.145], [-0.01, 0.14]]); ctx.fillStyle = colour; ctx.fill(); ctx.stroke();  // rear wing
    ctx.fillStyle = "#1c1e21"; ctx.fillRect(x + 0.86 * W, yg - 0.035 * W, 0.15 * W, 0.012 * W);           // front wing
    helm = [x + 0.56 * W, yb - 0.115 * W, 0.064 * W];
  }
  wheel(x + 0.17 * W, rr); wheel(x + 0.83 * W, r);
  return [helm[0] - 0.55 * helm[2], helm[1] + 0.5 * helm[2], helm[2]];     // centre -> bottom-left anchor
}

// the safety car on the strip: a silver road car with a light bar, nose right
function drawSafetyCarSide(ctx, x, yg, W) {
  ctx.save();
  const r = W * 0.085, yb = yg - r * 0.7;
  ctx.fillStyle = "#c9ced4"; ctx.strokeStyle = "rgba(0,0,0,.7)"; ctx.lineWidth = Math.max(0.8, W / 160);
  ctx.beginPath();
  ctx.moveTo(x + 0.02 * W, yb); ctx.lineTo(x + 0.02 * W, yb - 0.1 * W); ctx.lineTo(x + 0.25 * W, yb - 0.13 * W);
  ctx.lineTo(x + 0.4 * W, yb - 0.22 * W); ctx.lineTo(x + 0.62 * W, yb - 0.22 * W); ctx.lineTo(x + 0.78 * W, yb - 0.12 * W);
  ctx.lineTo(x + 0.98 * W, yb - 0.09 * W); ctx.lineTo(x + 0.99 * W, yb); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "rgba(20,26,34,.85)";
  ctx.beginPath(); ctx.moveTo(x + 0.43 * W, yb - 0.2 * W); ctx.lineTo(x + 0.6 * W, yb - 0.2 * W); ctx.lineTo(x + 0.72 * W, yb - 0.13 * W);
  ctx.lineTo(x + 0.36 * W, yb - 0.13 * W); ctx.closePath(); ctx.fill();
  const on = Math.floor(performance.now() / 250) % 2;
  ctx.fillStyle = on ? "#ffb000" : "#7a5500"; ctx.fillRect(x + 0.44 * W, yb - 0.255 * W, 0.07 * W, 0.035 * W);
  ctx.fillStyle = on ? "#7a5500" : "#ffb000"; ctx.fillRect(x + 0.52 * W, yb - 0.255 * W, 0.07 * W, 0.035 * W);
  ctx.fillStyle = "#111"; ctx.font = `700 ${Math.max(8, W * 0.06)}px system-ui, sans-serif`; ctx.textAlign = "center";
  ctx.fillText("SAFETY CAR", x + 0.5 * W, yb - 0.04 * W);
  for (const cx of [x + 0.2 * W, x + 0.8 * W]) {
    ctx.fillStyle = "#16181b"; ctx.beginPath(); ctx.arc(cx, yg - r, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#8a9096"; ctx.beginPath(); ctx.arc(cx, yg - r, r * 0.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// national racing colours (the historic ones; bright enough to read on a small helmet), by nationality or code
const NAT_COLOUR = {
  italian: "#c8102e", i: "#c8102e", french: "#1f4fa8", f: "#1f4fa8", british: "#0b5a32", gb: "#0b5a32",
  german: "#c7ccd1", d: "#c7ccd1", belgian: "#f2c200", b: "#f2c200", dutch: "#f07a10", nl: "#f07a10",
  swiss: "#d52b1e", ch: "#d52b1e", american: "#e9edf3", usa: "#e9edf3", spanish: "#d2a400", e: "#d2a400",
  austrian: "#e8e8e8", a: "#e8e8e8", swedish: "#1f6fb8", s: "#1f6fb8", czechoslovak: "#f0f0f0", czech: "#f0f0f0",
  cs: "#f0f0f0", cz: "#f0f0f0", japanese: "#f3efe6", j: "#f3efe6", argentine: "#5b9bd5", argentinian: "#5b9bd5",
  ra: "#5b9bd5", brazilian: "#f2d024", br: "#f2d024", australian: "#127a3e", aus: "#127a3e",
  "south african": "#d9a400", za: "#d9a400", canadian: "#d80621", cdn: "#d80621", finnish: "#f5f5f5",
  fin: "#f5f5f5", portuguese: "#b3001b", p: "#b3001b", "new zealander": "#2b2b2b", nz: "#2b2b2b",
  polish: "#f2f2f2", pl: "#f2f2f2", hungarian: "#f5f5f5", h: "#f5f5f5", mexican: "#1e7d4c", danish: "#c0c4c8",
  russian: "#f2f2f2", rus: "#f2f2f2", ru: "#f2f2f2", irish: "#1f9a52", monegasque: "#f5f5f5", mc: "#f5f5f5",
  thai: "#6aa6e0", indian: "#f5f5f5", rhodesian: "#127a3e", colombian: "#f2d024", venezuelan: "#f2d024",
  chilean: "#f5f5f5", rch: "#f5f5f5", uruguayan: "#5b9bd5", romanian: "#2b4fa8", ro: "#2b4fa8", greek: "#2b6fd0",
  gr: "#2b6fd0", yugoslav: "#2b4fa8", luxembourgish: "#f5f5f5", l: "#f5f5f5", norwegian: "#c8102e", n: "#c8102e",
  estonian: "#2b6fd0", est: "#2b6fd0", liechtensteiner: "#2b4fa8", malaysian: "#f2d024", indonesian: "#c8102e",
  chinese: "#c8102e", tn: "#c8102e", dz: "#1e7d4c", ma: "#c8102e",
};
// a driver's helmet colour: their country's racing colour, else a steady colour of their own (from the id)
export function driverColour(d) {
  const nat = String(d?.nationality ?? "").split("/")[0].trim().toLowerCase();
  if (NAT_COLOUR[nat]) return NAT_COLOUR[nat];
  let h = 2166136261;
  for (const ch of String(d?.id ?? "")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return `hsl(${h % 360} ${55 + (h >> 9) % 20}% ${38 + (h >> 17) % 14}%)`;
}

// ---------- sprites ----------
export class Sprites {
  constructor(meta, base) { this.meta = meta; this.base = base; this.img = new Map(); }
  sheet(name) {
    if (!this.img.has(name)) {
      const im = new Image(); im.src = `${this.base}/${name}`;
      this.img.set(name, im);
    }
    const im = this.img.get(name);
    return im.complete && im.naturalWidth ? im : null;
  }
  ready(names) { return Promise.all(names.map((n) => new Promise((ok) => { this.sheet(n); const im = this.img.get(n); if (im.complete) ok(); else { im.onload = ok; im.onerror = ok; } }))); }
  car(id) { return this.meta.cars[id] ?? null; }
  // height (px) of a car drawn w px wide (pre-war cars are drawn smaller)
  // how far the driver's helmet rises above the top of a car drawn w px wide (0 if it stays inside the sprite)
  helmetRise(id, w) {
    const c = this.car(id);
    if (!c || this.liveryShape(id)) return 0.12 * w * helmetScaleFor(w) / 2.375;
    const k = String(id).startsWith("ge_") ? PREWAR_SCALE : 1, s = (w * k) / c.w;
    return Math.max(0, 0.8 * c.hd * s * helmetScaleFor(w) / k - c.hy * s);
  }
  drawnHeight(id, w) {
    const L = this.liveryShape(id);
    if (L) return (L.h / L.w) * w * (carYear(id) < 1950 ? PREWAR_SCALE : 1);
    const c = this.car(id); const k = String(id).startsWith("ge_") ? PREWAR_SCALE : 1; return c ? (c.h / c.w) * w * k : 0.22 * w;
  }
  // livery kit (gfx/liveries, session -18): cars that carry a livery spec (a player's own team) are painted by it.
  // kit = loadLiveryKit(...); draw = drawLiveryCar; liveryOf(carId) -> spec | null
  setLiveryKit(kit, draw, seasonFor, liveryOf) { this.lk = { kit, draw, seasonFor, liveryOf }; }
  liverySpec(id, driverId = null) { return this.lk ? this.lk.liveryOf(id, driverId) ?? null : null; }
  liveryShape(id) { const lv = this.liverySpec(id); return lv && carYear(id) ? this.lk.kit.meta.shapes[this.lk.seasonFor(this.lk.kit, carYear(id))] : null; }
  helmet(driverId) { return this.meta.helmets[String(driverId)] ?? null; }
  // the fallback helmet's style follows the driver's era (the middle of their career), never the car's: an old
  // driver in a modern car keeps an old helmet. Before 1950 the 1950s style (fallbackHelmet clamps).
  setDriverEras(drivers) {
    this.dcol = new Map(drivers.map((d) => [String(d.id), driverColour(d)]));   // fallback helmets: national colour
    this.era = new Map(drivers.map((d) => {
      const ys = Object.keys(d.seasons ?? {}).map(Number).sort((a, b) => a - b);
      return [String(d.id), ys.length ? ys[(ys.length - 1) >> 1] : null];
    }));
  }
  eraOf(driverId, fallbackYear) { return this.era?.get(String(driverId)) ?? fallbackYear; }
  colourOf(driverId, fallback) { return this.dcol?.get(String(driverId)) ?? fallback; }
  // a helmet picture of the player's own (career driver): an image URL, drawn instead of the atlas
  setCustomHelmet(driverId, url) {
    this.custom ??= new Map();
    if (!url) { this.custom.delete(String(driverId)); return; }
    if (typeof Image === "undefined") return;
    const im = new Image(); im.src = url;
    this.custom.set(String(driverId), { im, url });
  }
  customHelmet(driverId) { const c = this.custom?.get(String(driverId)); return c && c.im.complete && c.im.naturalWidth ? c : null; }
  // draw a car side-on: width w px, left edge x, ground line y (wheels touch it)
  drawCar(ctx, carId, driverId, x, yGround, w, colour, alpha = 1, helmetScale = helmetScaleFor(w)) {
    const lv = this.liverySpec(carId, driverId), yr = carYear(carId);
    if (lv && yr) {                                     // a livery-kit car: the year picks the shape (pre-war 20% smaller)
      if (yr < 1950) { x += w * (1 - PREWAR_SCALE) / 2; w *= PREWAR_SCALE; helmetScale /= PREWAR_SCALE; }
      ctx.save(); ctx.globalAlpha = alpha;
      const a = this.lk.draw(ctx, this.lk.kit, yr, lv, x, yGround, w, alpha);
      this.drawHelmet(ctx, driverId, a.hx, a.hy, a.hd * helmetScale, colour, yr);
      ctx.restore();
      return;
    }
    const c = this.car(carId);
    const im = c && this.sheet(c.sheet);
    // pre-war cars (goldenera) are drawn 20% smaller, centred where the full-size car would be, wheels on the ground; helmets stay full size
    if (String(carId).startsWith("ge_")) { x += w * (1 - PREWAR_SCALE) / 2; w *= PREWAR_SCALE; helmetScale /= PREWAR_SCALE; }   // the helmet keeps its size
    ctx.save(); ctx.globalAlpha = alpha;
    let s, h, hx, hy, hd;
    if (im) {
      s = w / c.w; h = c.h * s;
      ctx.drawImage(im, c.x, c.y, c.w, c.h, x, yGround - h, w, h);
      hx = x + c.hx * s; hy = yGround - h + c.hy * s; hd = c.hd * s;
    } else if (carYear(carId) && carYear(carId) < 1981) {
      [hx, hy, hd] = drawVintage(ctx, x, yGround, w, colour, carYear(carId));
    } else {
      h = w * 0.22; s = 1;
      ctx.fillStyle = colour; ctx.fillRect(x, yGround - h * 0.6, w, h * 0.45);
      hx = x + w * 0.56; hy = yGround - h * 0.45; hd = w * 0.065;
    }
    this.drawHelmet(ctx, driverId, hx, hy, hd * helmetScale, colour, carYear(carId));
    ctx.restore();
  }
  // decade fallback helmet (drivers without art), its shell tinted with the team colour: an offscreen canvas
  // per decade and colour. out = px * (1 - m) + px * tint * m (multiply through the mask), alpha of the helmet.
  fallbackHelmet(year, colour) {
    const fb = this.meta.helmet_fallback;
    if (!fb || !year || typeof document === "undefined" || typeof document.createElement !== "function") return null;
    const dec = `${Math.min(2020, Math.max(1950, Math.floor(year / 10) * 10))}s`, f = fb[dec];
    const im = f && this.sheet("helmets.webp");
    if (!im) return null;
    this.tint ??= new Map();
    const key = `${dec}|${colour}`;
    if (this.tint.has(key)) return this.tint.get(key);
    const mk = document.createElement("canvas"); mk.width = f.w; mk.height = f.h;
    const m = mk.getContext("2d");
    m.drawImage(im, f.mx, f.my, f.w, f.h, 0, 0, f.w, f.h);
    m.globalCompositeOperation = "source-in"; m.fillStyle = colour; m.fillRect(0, 0, f.w, f.h);   // colour, mask alpha
    const cv = document.createElement("canvas"); cv.width = f.w; cv.height = f.h;
    const c = cv.getContext("2d");
    c.drawImage(im, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
    c.globalCompositeOperation = "multiply"; c.drawImage(mk, 0, 0);
    c.globalCompositeOperation = "destination-in"; c.drawImage(im, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
    const v = { cv, w: f.w, h: f.h, url: null };
    this.tint.set(key, v);
    return v;
  }
  // (cx, cy) = the helmet's bottom-left corner (the car's helmet anchor); d = drawn width
  drawHelmet(ctx, driverId, cx, cy, d, colour, year = null) {
    const cu = this.customHelmet(driverId);
    if (cu) {
      const k = d / cu.im.naturalWidth;
      ctx.drawImage(cu.im, cx, cy - cu.im.naturalHeight * k, d, cu.im.naturalHeight * k);
      return;
    }
    const m = this.helmet(driverId);
    const im = m && this.sheet("helmets.webp");
    if (im) {
      const k = d / m.w;
      ctx.drawImage(im, m.x, m.y, m.w, m.h, cx, cy - m.h * k, d, m.h * k);
      return;
    }
    colour = this.colourOf(driverId, colour);
    const fh = this.fallbackHelmet(this.eraOf(driverId, year), colour);
    if (fh) {
      const k = d / fh.w;
      ctx.drawImage(fh.cv, cx, cy - fh.h * k, d, fh.h * k);
      return;
    }
    // generic helmet in the team colour: shell, visor, chin
    ctx.save();
    ctx.translate(cx + d / 2, cy - d * 0.44);
    ctx.fillStyle = colour; ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.lineWidth = Math.max(0.6, d / 24);
    ctx.beginPath(); ctx.ellipse(0, 0, d / 2, d * 0.44, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "rgba(10,14,20,.85)";
    ctx.beginPath(); ctx.ellipse(d * 0.2, -d * 0.02, d * 0.26, d * 0.12, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // thumbnails in HTML (thumbs.js placeholders): painted when scrolled into view, after their sheets load.
  // colourOf(carId) -> the car's main colour (fallback shapes and helmets)
  paintThumbs(root, colourOf = () => "#888888") {
    if (!root?.querySelectorAll) return;
    const cvs = [...root.querySelectorAll("canvas[data-thumb]:not([data-done])")];
    if (!cvs.length) return;
    const paint = async (list) => {
      list.forEach((cv) => { cv.dataset.done = "1"; });
      const sheets = new Set(["helmets.webp"]);
      for (const cv of list) { const m = cv.dataset.car && this.car(cv.dataset.car); if (m) sheets.add(m.sheet); }
      await this.ready([...sheets]);
      for (const cv of list) { try { this.paintThumb(cv, colourOf); } catch (e) { console.warn("thumb", e); } }
    };
    if (typeof IntersectionObserver === "undefined") { paint(cvs); return; }
    const io = new IntersectionObserver((es) => {
      const vis = es.filter((e) => e.isIntersecting).map((e) => e.target);
      vis.forEach((v) => io.unobserve(v));
      if (vis.length) paint(vis);
    }, { rootMargin: "300px" });
    cvs.forEach((cv) => io.observe(cv));
  }
  paintThumb(cv, colourOf) {
    const W = +cv.getAttribute("width"), H = +cv.getAttribute("height"), dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    cv.style.width = `${W}px`; cv.style.height = `${H}px`; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const d = cv.dataset.d === "" || cv.dataset.d == null ? null : cv.dataset.d;
    if (cv.dataset.thumb === "car") {
      const car = cv.dataset.car, col = colourOf(car) ?? "#888888";
      const ratio = (this.drawnHeight(car, 100) || 22) / 100;
      let w = W - 2;
      // the car and the helmet above its cockpit fit the height (helmet sized as on the strip)
      for (let it = 0; it < 40 && ratio * w + this.helmetRise(car, w) > H - 1.5; it++) w *= 0.97;
      this.drawCar(ctx, car, d, (W - w) / 2, H - 1, w, col, 1);
    } else {
      const s = Math.min(W, H / 0.9), y = cv.dataset.y ? Number(cv.dataset.y) : null;
      this.drawHelmet(ctx, d, (W - s) / 2, H, s, colourOf(null) ?? "#888888", y);
    }
  }
  // helmet icon for HTML (timing tower): a div with the atlas as background
  helmetStyle(driverId, size, carId = null, colour = null) {
    const cu = this.custom?.get(String(driverId));
    if (cu) return `background-image:url(${cu.url});background-size:contain;background-repeat:no-repeat;background-position:center`;
    const m = this.helmet(driverId);
    if (!m) {
      colour = this.colourOf(driverId, colour);
      const fh = colour && this.fallbackHelmet(this.eraOf(driverId, carYear(carId)), colour);
      if (!fh) return null;
      fh.url ??= fh.cv.toDataURL();
      return `background-image:url(${fh.url});background-size:contain;background-repeat:no-repeat;background-position:center`;
    }
    const k = size / Math.max(m.w, m.h);
    const im = this.img.get("helmets.webp");
    const W = im?.naturalWidth || 1920, H = im?.naturalHeight || 1920;
    return `background-image:url(${this.base}/helmets.webp);background-size:${W * k}px ${H * k}px;` +
           `background-position:${-m.x * k + (size - m.w * k) / 2}px ${-m.y * k + (size - m.h * k) / 2}px`;
  }
}

// ---------- track map ----------
// ---------- elevation profile (under the map): height around the lap, cars as dots ----------
export class ElevationProfile {
  constructor(cv) { this.cv = cv; this.key = null; this.path = null; }
  draw(snap, pb, opts) {
    const { ctx, w, h } = fitCanvas(this.cv);
    ctx.clearRect(0, 0, w, h);
    const range = pb.track.elev?.range_m || Math.max(...pb.track.z) || 1;
    const padL = 8, padR = 8, padT = 16, padB = 6;
    const X = (f) => padL + f * (w - padL - padR);
    const Y = (z) => padT + (1 - z / range) * (h - padT - padB);
    ctx.fillStyle = "rgba(13,16,20,.62)";
    ctx.beginPath(); ctx.roundRect(0, 0, w, h, 6); ctx.fill();
    // the profile (one point per pixel)
    const n = Math.max(2, Math.round(w - padL - padR));
    ctx.beginPath(); ctx.moveTo(X(0), h - padB);
    for (let k = 0; k <= n; k++) ctx.lineTo(X(k / n), Y(pb.zAt(k / n)));
    ctx.lineTo(X(1), h - padB); ctx.closePath();
    ctx.fillStyle = "rgba(150,160,172,.22)"; ctx.fill();
    ctx.beginPath();
    for (let k = 0; k <= n; k++) (k ? ctx.lineTo : ctx.moveTo).call(ctx, X(k / n), Y(pb.zAt(k / n)));
    ctx.strokeStyle = css("--muted"); ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = css("--fg"); ctx.fillRect(X(0) - 0.5, padT - 2, 1.5, h - padT - padB + 2);   // the line
    // cars: running ones as dots on the profile; the focus car on top with a ring
    const fr = (p) => p - Math.floor(p);
    const list = snap.order.filter((s) => (s.state === "run" || s.state === "out" || s.state === "pit") && s.progress >= 0);
    list.sort((a, b) => (a.c.i === opts.focus) - (b.c.i === opts.focus));
    for (const s of list) {
      const f = fr(s.progress), isF = s.c.i === opts.focus;
      const x = X(f), y = Y(pb.zAt(f));
      ctx.beginPath(); ctx.arc(x, y, isF ? 5 : 3.2, 0, Math.PI * 2);
      ctx.fillStyle = opts.colour(s.c).fill; ctx.fill();
      ctx.lineWidth = isF ? 2 : 1; ctx.strokeStyle = isF ? css("--accent") : "rgba(0,0,0,.7)"; ctx.stroke();
    }
    ctx.font = `600 10px ${css("--font-data")}`; ctx.fillStyle = css("--muted"); ctx.textAlign = "left";
    ctx.fillText(`ELEVATION · ${Math.round(range)} m`, padL, 11);
    const fs = snap.byCar[opts.focus];
    if (fs && fs.progress >= 0 && fs.state !== "fin" && fs.state !== "dnf") {
      ctx.textAlign = "right"; ctx.fillStyle = css("--accent");
      ctx.fillText(`${s_name(fs)} ${Math.round(pb.zAt(fr(fs.progress)))} m`, w - padR, 11);
    }
    ctx.textAlign = "left";
  }
}
const s_name = (s) => s.c.code ?? (s.c.name ?? "").split(" ").at(-1);

export class TrackMap {
  constructor(cv, track) {
    this.cv = cv; this.track = track; this.hit = [];
    const { x, y } = track;
    let a = 0; for (let i = 0; i < x.length; i++) { const j = (i + 1) % x.length; a += x[i] * y[j] - x[j] * y[i]; }
    this.ccw = a > 0;                                  // inside of the loop is to the left when ccw
    this.bb = [Math.min(...x), Math.max(...x), Math.min(...y), Math.max(...y)];
    this.padBottom = track.z ? 64 : 0;                 // room for the elevation profile under the map
  }
  layout(w, h) {
    const [x0, x1, y0, y1] = this.bb, pad = 34, pb = this.padBottom;
    const s = Math.min((w - 2 * pad) / (x1 - x0), (h - 2 * pad - pb) / (y1 - y0));
    const ox = (w - s * (x1 - x0)) / 2, oy = pb + (h - pb - s * (y1 - y0)) / 2;
    this.P = (i) => [ox + s * (this.track.x[i] - x0), h - (oy + s * (this.track.y[i] - y0))];
    this.scale = s;
  }
  point(idx) {                                          // fractional index -> screen [x, y, nx, ny]
    const N = this.track.x.length;
    const i = Math.floor(idx) % N, j = (i + 1) % N, f = idx - Math.floor(idx);
    const [ax, ay] = this.P(i), [bx, by] = this.P(j);
    const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1;
    // screen y is flipped, so the left normal flips too
    const sgn = this.ccw ? 1 : -1;
    return [ax + f * dx, ay + f * dy, (sgn * dy) / l, (-sgn * dx) / l];
  }
  draw(snap, opts) {
    const { ctx, w, h } = fitCanvas(this.cv);
    if (this._w !== w || this._h !== h) { this.layout(w, h); this._w = w; this._h = h; }
    ctx.clearRect(0, 0, w, h);
    const N = this.track.x.length;
    const path = () => { ctx.beginPath(); for (let i = 0; i <= N; i++) { const [px, py] = this.P(i % N); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); } };
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    path(); ctx.strokeStyle = css("--track-edge"); ctx.lineWidth = 13; ctx.stroke();
    path(); ctx.strokeStyle = snap.sc || snap.vsc ? css("--sc") : css("--track"); ctx.lineWidth = 8; ctx.stroke();
    // height shading: the higher parts of the lap drawn lighter (matches the elevation profile under the map)
    const Z = this.track.z;
    if (Z && !(snap.sc || snap.vsc)) {
      const zr = this.track.elev?.range_m || Math.max(...Z) || 1, K = 4;
      ctx.lineWidth = 8; ctx.lineCap = "butt";
      for (let i = 0; i < N; i += K) {
        const j = Math.min(i + K, N), a = 0.38 * (Z[(i + (K >> 1)) % N] / zr);
        if (a < 0.02) continue;
        ctx.beginPath(); const [ax, ay] = this.P(i); ctx.moveTo(ax, ay);
        for (let k = i + 1; k <= j; k++) { const [bx, by] = this.P(k % N); ctx.lineTo(bx, by); }
        ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`; ctx.stroke();
      }
      ctx.lineCap = "round";
    }
    // sector lines and start/finish
    const tick = (idx, col, len, wd) => {
      const [px, py, nx, ny] = this.point(idx);
      ctx.beginPath(); ctx.moveTo(px - nx * len, py - ny * len); ctx.lineTo(px + nx * len, py + ny * len);
      ctx.strokeStyle = col; ctx.lineWidth = wd; ctx.stroke();
    };
    this.track.sectors.forEach((ix) => tick(ix, css("--muted"), 8, 2));
    tick(0, css("--fg"), 10, 3);
    // pit lane: parallel to the main straight on the inside, from entry (before the line) to exit
    const st = this.track.step_m, PIT_OFF = 13;
    this.pitPoint = (u) => {
      const idx = (N - PIT_IN_M / st + u * (PIT_IN_M + PIT_OUT_M) / st + N) % N;
      const [px, py, nx, ny] = this.point(idx);
      const ramp = Math.min(1, u / 0.12, (1 - u) / 0.12);          // merge in and out of the track
      return [px + nx * PIT_OFF * ramp, py + ny * PIT_OFF * ramp];
    };
    ctx.beginPath();
    for (let k = 0; k <= 40; k++) { const [px, py] = this.pitPoint(k / 40); k ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.strokeStyle = css("--track-edge"); ctx.lineWidth = 5; ctx.stroke();
    ctx.strokeStyle = css("--track"); ctx.lineWidth = 3; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
    // cars, back of the field first so the leader is on top
    this.hit = [];
    const order = [...snap.order].reverse();
    for (const s of order) {
      const col = opts.colour(s.c);
      let px, py;
      if (s.idx === null) { [px, py] = this.pitPoint(s.pitU ?? 0.5); }
      else { [px, py] = this.point(s.idx); }
      const focus = s.c.i === opts.focus;
      const r = focus ? 7.5 : 6;
      ctx.globalAlpha = s.state === "dnf" ? 0.35 : 1;
      if (focus) { ctx.beginPath(); ctx.arc(px, py, r + 4, 0, Math.PI * 2); ctx.strokeStyle = css("--accent"); ctx.lineWidth = 2.5; ctx.stroke(); }
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = col.fill; ctx.fill(); ctx.strokeStyle = col.edge; ctx.lineWidth = 2; ctx.stroke();
      if (focus || s.pos <= 3 || opts.labels) {
        ctx.font = `600 11px ${css("--font-data")}`; ctx.fillStyle = css("--fg");
        ctx.strokeStyle = css("--bg"); ctx.lineWidth = 3;
        ctx.strokeText(s.c.code ?? "", px + r + 3, py - r);
        ctx.fillText(s.c.code ?? "", px + r + 3, py - r);
      }
      ctx.globalAlpha = 1;
      this.hit.push([px, py, s.c.i]);
    }
    this.drawSafetyCar(ctx, snap);
  }
  drawSafetyCar(ctx, snap) {
    if (!snap.scCar) return;
    const [px, py] = this.point(snap.scCar.idx);
    ctx.save();
    ctx.fillStyle = "#f2b705"; ctx.strokeStyle = "#111"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.rect(px - 11, py - 7, 22, 14); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#111"; ctx.font = "700 9px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("SC", px, py + 0.5);
    ctx.restore();
  }
  pick(x, y) {
    let best = null, bd = 18 * 18;
    for (const [px, py, i] of this.hit) { const d = (px - x) ** 2 + (py - y) ** 2; if (d < bd) { bd = d; best = i; } }
    return best;
  }
}

// ---------- side-on paperdoll strip ----------
// The focus car sits in the middle; other cars are placed by their time gap: how long the focus car, at its
// current lap pace and the track's speed profile, takes to reach where that car is now (so a gap reads the
// same on a straight as in a hairpin). The zoom (half-window) is held in metres at the lap's mean speed;
// zoomed in, cars are near true scale (5.5 m); pulled back, sprites shrink to a minimum size and the strip
// shows a long run of the field. Cars outside the window become chips at the edges with their timing gap.
export const ZOOM_MIN = 8, ZOOM_MAX = 1500;
const CAR_LEN_M = 5.5;
const EXAG = 1;                   // hills on the strip at true scale (no vertical exaggeration)
// sprite width floor when zoomed out (legibility): 165 px, easing to 110 px at the far end of the zoom range;
// a crowded view shrinks sprites further, never below CAR_FLOOR_PX. OVERLAP: neighbours may overlap by this share.
const CAR_MIN_PX = 165, CAR_MIN_FAR_PX = 110, CAR_FLOOR_PX = 80, OVERLAP = 0.3;
export class PaperdollStrip {
  constructor(cv, sprites) { this.cv = cv; this.sprites = sprites; this.half = 60; this.hit = []; }
  zoomBy(f) { this.half = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.half * f)); }
  pick(x, y) {                         // topmost car under the point
    for (let k = this.hit.length - 1; k >= 0; k--) { const [x0, y0, x1, y1, i] = this.hit[k]; if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return i; }
    return null;
  }
  draw(snap, pb, opts) {
    const { ctx, w, h } = fitCanvas(this.cv);
    ctx.clearRect(0, 0, w, h);
    const L = pb.L;
    const focus = snap.byCar[opts.focus];
    const ground = h - 30;
    const pxm = (w / 2) / this.half;
    // time axis: seconds per pixel from the zoom in metres at the lap's mean speed; the focus car's lap time
    const vMean = L / (pb.baseLap ?? 90);
    const pxs = pxm * vMean;
    const lapT = pb.lapDurAt ? pb.lapDurAt(opts.focus, snap.t) : pb.baseLap ?? 90;
    const fT = pb.timeProg ? pb.timeProg(focus.progress ?? 0) : focus.progress ?? 0;
    // time gap ahead (s) of a point at lap progress `prog`, wrapped to within half a lap (lapped cars sit alongside)
    const tGap = (prog) => {
      let f = ((pb.timeProg ? pb.timeProg(prog) : prog) - fT) % 1;
      if (f > 0.5) f -= 1; if (f < -0.5) f += 1;
      return f * lapT;
    };
    // terrain: each screen x is a time gap, mapped back to a point on the lap and its height. The focus car stays
    // at the usual ground line unless the hills in view need room; heights are drawn at EXAG scale (true scale) and squeezed
    // to fit the strip when the view is long.
    const fProg = focus.progress ?? 0;
    const progAtX = (x) => (pb.progOfTime ? pb.progOfTime(fT + (x - w / 2) / pxs / lapT) : fProg + (x - w / 2) / pxm / L);
    const zAt = opts.hills !== false ? pb.zAt : null;       // the Hills box off: a flat road
    const zF = zAt ? zAt(fProg) : 0;
    const SX = 4, gx = [], gz = [], gd = [];
    for (let x = -SX * 2; x <= w + SX * 2; x += SX) {
      const p = progAtX(x);
      gx.push(x); gz.push(zAt ? zAt(p) - zF : 0); gd.push(p * L);
    }
    let vs = EXAG * pxm;
    const top = Math.max(60, h * 0.5), bottom = h - 22;
    const zMax = Math.max(...gz), zMin = Math.min(...gz);
    if ((zMax - zMin) * vs > bottom - top) vs = (bottom - top) / Math.max(zMax - zMin, 1e-6);
    const base = Math.min(Math.max(ground, top + zMax * vs), bottom + zMin * vs);
    const gy = gz.map((z) => base - z * vs);
    const gY = (x) => { const f = (x - gx[0]) / SX, i = Math.max(0, Math.min(gx.length - 2, Math.floor(f))), r = f - i; return gy[i] + r * (gy[i + 1] - gy[i]); };
    const slope = (x, r) => Math.atan2(gY(x + r) - gY(x - r), 2 * r);
    // scenery behind the road (scenery.js): sky, horizon strips, hillside, roadside dressing, barrier
    // with scenery, the road shows its far half behind the wheels (BACK px), so the cars sit on the asphalt
    let back = 0;
    if (opts.scenery && this.scenery) {
      back = 12;
      if (this.zRange?.[0] !== pb) { const Z = pb.track?.z ?? [0]; this.zRange = [pb, (Math.min(...Z) + Math.max(...Z)) / 2]; }
      const far0 = Math.min(1, Math.max(0, Math.log(this.half / 300) / Math.log(ZOOM_MAX / 300)));
      const carW0 = Math.min(400, Math.max(CAR_MIN_PX - (CAR_MIN_PX - CAR_MIN_FAR_PX) * far0, CAR_LEN_M * pxm));
      if (!this.scenery.draw(ctx, w, h, { gx, gy, gd, dF: fProg * L, zF: zAt ? zAt(fProg) : 0, zMid: zAt ? this.zRange[1] : 0,
                                     carW: carW0, circuit: opts.circuit, year: opts.year, back })) back = 0;
    }
    // road (to the bottom of the strip) with kerb stripes by distance (4 m, coarsened when pulled back)
    ctx.fillStyle = css("--road");
    ctx.beginPath(); ctx.moveTo(gx[0], h);
    for (let k = 0; k < gx.length; k++) ctx.lineTo(gx[k], gy[k] - 6 - back);
    ctx.lineTo(gx.at(-1), h); ctx.closePath(); ctx.fill();
    let stripe = 4; while (stripe * pxm < 10) stripe *= 4;
    const kA = css("--kerb-a"), kB = css("--kerb-b");
    for (let k = 0; k + 1 < gx.length; k++) {
      ctx.fillStyle = Math.floor(((gd[k] + gd[k + 1]) / 2) / stripe) % 2 ? kB : kA;
      ctx.beginPath();
      ctx.moveTo(gx[k], gy[k] + 12); ctx.lineTo(gx[k + 1] + 0.5, gy[k + 1] + 12);
      ctx.lineTo(gx[k + 1] + 0.5, gy[k + 1] + 19); ctx.lineTo(gx[k], gy[k] + 19); ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = css("--track-edge"); ctx.lineWidth = 2;
    ctx.beginPath(); gx.forEach((x, k) => (k ? ctx.lineTo(x, gy[k] - (back ? 6 + back : 0)) : ctx.moveTo(x, gy[k] - (back ? 6 + back : 0)))); ctx.stroke();
    // gradient under the focus car (over 40 m of track)
    if (zAt && focus.idx !== null) {
      const g = (pb.zAt(fProg + 20 / L) - pb.zAt(fProg - 20 / L)) / 40;
      if (Math.abs(g) >= 0.015) {
        ctx.font = `600 11px ${css("--font-data")}`; ctx.fillStyle = css("--muted");
        ctx.fillText(`${g > 0 ? "▲ uphill" : "▼ downhill"} ${Math.round(Math.abs(g) * 100)}%`, 12, h - 10);
      }
    }
    // scale bar (seconds)
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60];
    const bar = steps.find((b) => b * pxs >= 60) ?? 60;
    ctx.fillStyle = css("--muted"); ctx.fillRect(w - 12 - bar * pxs, h - 8, bar * pxs, 2);
    ctx.font = `500 10px ${css("--font-data")}`; ctx.textAlign = "right";
    ctx.fillText(`${bar} s`, w - 12, h - 12); ctx.textAlign = "left";

    const far = Math.min(1, Math.max(0, Math.log(this.half / 300) / Math.log(ZOOM_MAX / 300)));
    let carW = Math.min(400, Math.max(CAR_MIN_PX - (CAR_MIN_PX - CAR_MIN_FAR_PX) * far, CAR_LEN_M * pxm));
    const near = [], left = [], right = [];
    const rel = (s) => (s.gap?.s ?? 0);
    // physical distance around the lap (so a car being lapped shows up next to the leader)
    const phys = (s) => { let d = ((s.progress - focus.progress) % 1) * L; if (d > L / 2) d -= L; if (d < -L / 2) d += L; return d; };
    // grid rows: the two cars of a row (P1+P2, P3+P4, ...) are shown one above the other: the even one on the upper
    // lane at its partner's spot. Over the first ROW_RELEASE_M past the line it slides to its own place and down
    // onto the road line (lane 1 -> 0), so the grid untangles into single file without a jump.
    const ROW_RELEASE_M = 200, GRID_STAGGER = 0.25, GRID_SQUEEZE = 0.5;   // stagger in car lengths (drawn)
    const rowU = (s) => {
      if (s.state === "grid") return 1;
      if (s.state !== "run" || s.done !== 0) return 0;
      if (s.progress < 0) return 1;                              // still behind the line

      const f = Math.min(1, (s.progress * L) / ROW_RELEASE_M);
      return 1 - f * f * (3 - 2 * f);
    };
    for (const s of snap.order) {
      if (s.state === "dnf" && s.c.i !== opts.focus) continue;
      if (s.c.i === opts.focus) { near.push({ s, d: 0, g: 0 }); continue; }
      if (s.idx === null || focus.idx === null || s.state === "fin" || s.state === "grid" && focus.state !== "grid") continue;
      const d = phys(s), g = tGap(s.progress);
      const sq = 1 - (1 - GRID_SQUEEZE) * rowU(s);                // the grid is drawn squeezed: judge it squeezed
      if (Math.abs(g) * pxs * sq <= w / 2 + carW / 2) near.push({ s, d, g });
      else if (g > 0) right.push([s, g]); else left.push([s, g]);
    }
    // layout: cars at their distance, pushed apart so sprites never overlap (order kept). Two cars
    // racing side by side (a pass in progress) share a slot on two lanes.
    near.sort((p, q) => p.g - q.g);
    // pulled back with many cars in view: shrink sprites so the pack still fits (overlap allowed)
    const sepK = 1 - OVERLAP;
    if (near.length * carW * sepK > w * 1.15) carW = Math.max(CAR_FLOOR_PX, (w * 1.15) / near.length / sepK);
    // helmets get relatively bigger as the car sprite shrinks, so they stay recognisable
    const helmetScale = helmetScaleFor(carW);
    const minSep = carW * sepK;
    for (const n of near) n.x = w / 2 + n.g * pxs;
    const fk = near.findIndex((n) => n.s.c.i === opts.focus);
    for (const n of near) { n.lane = 0; n.x0 = n.x; }
    // the grid drawn tighter than the real slots (GRID_SQUEEZE of the distance to the focus car), fading out with the
    // row release; the spacing rule below still keeps cars on one lane apart
    for (const n of near) { const u = rowU(n.s); if (u > 0) n.x = n.x0 = w / 2 + (n.x - w / 2) * (1 - (1 - GRID_SQUEEZE) * u); }
    const byGrid = new Map(near.map((n) => [n.s.c.grid, n]));
    const uppers = [];
    for (const n of near) {
      const g = n.s.c.grid;
      if (!g || g % 2) continue;
      const mate = byGrid.get(g - 1), u = Math.min(rowU(n.s), mate ? rowU(mate.s) : 0);
      if (!mate || u <= 0) continue;
      n.lane = n.ug = u; n.mate = mate;
      uppers.push(n);
    }
    // spacing along the road line (the upper grid cars are placed after it, behind their partners)
    const road = near.filter((n) => n.mate == null);
    const rk = Math.max(0, road.findIndex((n) => n.s.c.i === opts.focus || n === near[fk].mate));
    // cars are drawn at their real gaps (no pushing ahead or behind); a car overlapping cars ahead of it rises into the
    // lowest lane they don't use (road, passing lane, high lane), in proportion to the overlap, so lanes fill and
    // empty smoothly. Only the grid (until each row's release) keeps cars spaced on the road line.
    const early = (p, n) => Math.min(rowU(p.s), rowU(n.s));     // grid spacing, fading out with the row release
    for (let k = rk + 1; k < road.length; k++) { const p = road[k - 1], n = road[k]; n.x += Math.max(0, p.x + minSep - n.x) * early(p, n); }
    for (let k = rk - 1; k >= 0; k--) { const p = road[k + 1], n = road[k]; n.x -= Math.max(0, n.x - (p.x - minSep)) * early(p, n); }
    const passLift = Math.max(20, 0.12 * carW);
    const hRef = this.sprites.drawnHeight(near[fk].s.c.car, carW) || 0.25 * carW;
    const LANE_H = [0, passLift, Math.max(passLift * 1.8, Math.min(0.9 * hRef, ground - hRef - 40))];
    // upper grid cars: a little behind their partner (staggered), moving to their own place as the row releases
    for (const n of uppers) n.x = n.x0 + (n.mate.x - GRID_STAGGER * carW - n.x0) * n.ug;
    // lanes are sticky: cars that were on the road line last frame claim lanes first (then front to back), so in a
    // pass the raised car stays raised until the overlap is gone, instead of the lift hopping between the two
    const prevTl = this.lanePrev ?? new Map();
    const claim = [...near].sort((a, b) => (prevTl.get(a.s.c.i) ?? 0) - (prevTl.get(b.s.c.i) ?? 0) || b.x - a.x);
    const placed = [];
    for (const n of claim) {
      n.lift = 0; n.tl = 0;
      const bl = [];
      for (const q of placed) { if (q === n.mate) continue; const o = 1 - Math.abs(q.x - n.x) / minSep; if (o > 0) bl.push([q, o]); }
      placed.push(n);
      // the upper car of a grid row: the high lane, fading with the release (the larger of that and its overlap lift)
      const gl = n.mate ? LANE_H[2] * n.ug : 0;
      if (!bl.length) { if (gl) { n.tl = 2; n.lift = gl; n.lane = Math.min(1, gl / passLift); } continue; }
      const L = [0, 1, 2].find((l) => !bl.some(([q]) => q.tl === l)) ?? 1;
      const u = Math.max(...bl.map(([, o]) => o * o * (3 - 2 * o)));   // smoothstep of the deepest overlap
      const ol = LANE_H[L] * u;
      n.tl = gl > ol ? 2 : L; n.lift = Math.max(gl, ol); n.lane = Math.min(1, n.lift / passLift);
      n.over = bl.find(([q]) => q.tl !== L)?.[0].s.c.i ?? bl[0][0].s.c.i;
    }
    this.lanePrev = new Map(near.map((n) => [n.s.c.i, n.lift > 0.5 ? n.tl : 0]));
    // heights glide: at most LIFT_RATE px per second of real time towards the lane (a seek or a car new in view: no glide)
    const now = typeof performance !== "undefined" ? performance.now() / 1000 : 0;
    const dReal = Math.min(0.1, Math.max(0, now - (this.liftNow ?? now))), jumped = Math.abs(snap.t - (this.liftT ?? snap.t)) > 2 + 600 * dReal;   // a seek, not fast playback (up to 480x)
    const liftPrev = this.liftPrev ?? new Map();
    for (const n of near) {
      const was = liftPrev.get(n.s.c.i);
      if (was != null && !jumped) n.lift = was + Math.max(-LIFT_RATE * dReal, Math.min(LIFT_RATE * dReal, n.lift - was));
      n.lane = Math.min(1, n.lift / passLift);
    }
    this.liftPrev = new Map(near.map((n) => [n.s.c.i, n.lift])); this.liftNow = now; this.liftT = snap.t;
    const drawn = near.filter((n) => n.x > -carW && n.x < w + carW);
    drawn.sort((p, q) => q.lane - p.lane || (p.s.c.i === opts.focus) - (q.s.c.i === opts.focus) || p.x - q.x);
    const order = near.map((n) => n.s.c.i), fpos = order.indexOf(opts.focus);
    this.hit = [];
    // lanes above the road line: the passing lane (a car alongside in a pass) and, higher, the grid lane (the second
    // car of a grid row, almost clear of its partner below; capped below the labels at the top)
    const liftOf = (n) => n.lift ?? 0;
    const under = new Set(near.filter((n) => n.lane > 0.5).map((n) => n.mate?.s.c.i ?? n.over).filter((i) => i != null));
    for (const n of drawn) {
      const { s, d, x: cx, lane } = n;
      const isF = s.c.i === opts.focus;
      const scale = 1 - 0.14 * lane;
      const cw = carW * scale;
      const x = cx - cw / 2, yg = gY(cx) - liftOf(n);
      const col = opts.colour(s.c);
      // a car on another lap than the focus car (lapped, or lapping it): drawn darkened, with a smaller, greyer label
      const lapsApart = isF ? 0 : Math.round(s.progress - focus.progress - d / L), other = lapsApart !== 0;
      // on a slope the car tilts with the road (wheels on the ground line)
      ctx.save(); ctx.translate(cx, yg); ctx.rotate(slope(cx, cw * 0.4));
      // contact shadow on the road under the car (fading as it lifts into a passing lane)
      ctx.fillStyle = `rgba(0,0,0,${(0.38 * (1 - Math.min(1, liftOf(n) / 30))).toFixed(2)})`;
      ctx.beginPath(); ctx.ellipse(0, liftOf(n) + 1, cw * 0.47, Math.max(2, cw * 0.022), 0, 0, Math.PI * 2); ctx.fill();
      if (other) { if ("filter" in ctx) ctx.filter = "brightness(0.5) saturate(0.35)"; ctx.globalAlpha = 0.75; }
      this.sprites.drawCar(ctx, s.c.car, s.c.driver, -cw / 2, 0, cw, col.fill, s.idx === null ? 0.5 : 1 - 0.15 * lane, helmetScale);
      ctx.restore();
      this.hit.push([x, yg - cw * 0.35, x + cw, yg, s.c.i]);
      if (minSep >= 70 || isF || drawn.length < 8) {
        const g = isF ? "" : lapsApart ? ` ${lapsApart > 0 ? "+" : "−"}${Math.abs(lapsApart)}L` : (() => { const v = rel(focus) - rel(s); return ` ${v >= 0 ? "−" : "+"}${Math.abs(v).toFixed(1)}`; })();
        // labels on two tiers (alternating out from the focus car) so neighbours' labels don't collide
        // (a stacked pair: the upper car's label on the top tier, the road car's label below it)
        const tier = lane > 0.5 ? 0 : under.has(s.c.i) ? 1 : Math.abs(order.indexOf(s.c.i) - fpos) % 2;
        const y = tier ? 50 : 16;
        const room = minSep * 2 - 8;                     // same-tier neighbours are two slots apart
        ctx.textAlign = "center";
        const F1 = other ? `600 10px ${css("--font-data")}` : `700 12px ${css("--font-data")}`, F2 = other ? `500 9px ${css("--font-data")}` : `500 11px ${css("--font-data")}`;
        ctx.font = F1;
        const no = s.c.no ? `#${s.c.no} ` : "";            // a real race: the car's real number
        const full = `P${s.pos} ${no}${s.c.name ?? ""}${g}`, short = `P${s.pos} ${no}${(s.c.name ?? "").split(" ").at(-1)}${g}`;
        const l1 = ctx.measureText(full).width <= room ? full : short;
        const w1 = ctx.measureText(l1).width;
        const l2 = `${s.c.carYear ?? ""} ${s.c.carName ?? ""}`;
        ctx.font = F2;
        const tw = Math.max(w1, ctx.measureText(l2).width) + (other ? 8 : 10);
        ctx.fillStyle = other ? "rgba(13,16,20,.45)" : "rgba(13,16,20,.6)";
        ctx.fillRect(cx - tw / 2, y - (other ? 10 : 12), tw, other ? 24 : 30);
        ctx.fillStyle = css("--muted"); if (other) ctx.globalAlpha = 0.7;
        ctx.fillText(l2, cx, y + (other ? 11 : 13));
        ctx.globalAlpha = 1;
        ctx.font = F1;
        ctx.fillStyle = isF ? css("--accent") : other ? css("--muted") : css("--fg");
        ctx.fillText(l1, cx, y);
        ctx.textAlign = "left";
      }
    }
    if (snap.scCar && focus.idx !== null) {
      const x = w / 2 + tGap(snap.scCar.progress) * pxs;
      if (x > -carW && x < w + carW) {
        ctx.save(); ctx.translate(x, gY(x)); ctx.rotate(slope(x, carW * 0.35));
        drawSafetyCarSide(ctx, -carW * 0.42, 0, carW * 0.84);
        ctx.restore();
      }
    }
    const chip = (arr, side) => {
      if (!arr.length) return;
      const [s] = side > 0 ? arr.reduce((a, b) => (b[1] < a[1] ? b : a)) : arr.reduce((a, b) => (b[1] > a[1] ? b : a));
      const v = Math.abs(rel(focus) - rel(s));
      const txt = side > 0 ? `${s.c.code} −${v.toFixed(1)}s ▶` : `◀ ${s.c.code} +${v.toFixed(1)}s`;
      ctx.font = `600 12px ${css("--font-data")}`;
      const tw = ctx.measureText(txt).width + 16;
      const x = side > 0 ? w - tw - 8 : 8;
      ctx.fillStyle = css("--panel-2"); ctx.fillRect(x, 8, tw, 22);
      ctx.fillStyle = css("--fg"); ctx.fillText(txt, x + 8, 23);
      this.hit.push([x, 8, x + tw, 30, s.c.i]);
    };
    chip(right, 1); chip(left, -1);
    if (focus.idx === null || focus.state === "dnf") {
      ctx.font = `700 13px ${css("--font-data")}`; ctx.fillStyle = css("--accent"); ctx.textAlign = "center";
      ctx.fillText(focus.state === "dnf" ? "RETIRED" : focus.state === "fin" ? "FINISHED" : "IN THE PITS", w / 2, 40); ctx.textAlign = "left";
    }
  }
}
