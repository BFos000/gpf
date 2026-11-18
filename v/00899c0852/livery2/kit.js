// Livery v2 kit for the game: the v1 kit's interface (gfx/liveries/livery.js) on top of the v2 renderer, so
// draw.js / app.js / real_ui.js keep their calls. Seasons load on demand from the packed files
// (gfx/tools/livery2_pack.py); a car whose season or render isn't ready yet is drawn as a flat silhouette in its
// base colour and swaps in on a later frame.
//
//   const kit = await loadLiveryKit("data/sprites/livery2/");
//   drawLiveryCar(ctx, kit, 1973, design, x, yGround, w)   -> {hx, hy, hd, season}
//   await renderLiveryAsync(kit, 1973, design)              -> canvas
//
// A livery is a v2 element design (elements.js): { v: 2, colors: {a, b, c, d}, finish, body, stripe, nose, tail,
// wings, contour, pattern, number: {text, style, panel, digits, font}, sponsors: [{id, where, color}] }.
// v1 specs ({scheme, colors: {base, c2, c3}, ...}) are accepted anywhere and converted by migrate().
import * as L2 from "./livery2.js";
import * as EL from "./elements.js";

// ------------------------------------------------------------------ loading
export async function loadLiveryKit(base = "pack/", { fetch: get = (u) => fetch(u) } = {}) {
  const meta = await (await get(base + "index.json")).json();
  const decals = await (await get(base + "decals.json")).json();
  const kit = { v: 2, base, get, meta, decals, keys: Object.keys(meta.shapes).sort(), tpl: new Map(), loading: new Map(),
    cache: new Map(), sil: new Map(), queue: new Map(), listeners: new Set() };
  kit.years = kit.keys.map(Number);
  return kit;
}

/** the template for a race year: that season, else the nearest earlier one (else the earliest). */
export function seasonFor(kit, year) {
  let best = kit.keys[0];
  for (const k of kit.keys) if (+k <= +year) best = k;
  return best;
}

async function inflateRaw(buf) {
  if (typeof DecompressionStream === "function") {
    const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  const z = await import("node:zlib");
  return new Uint8Array(z.inflateRawSync(buf));
}

/** packed season bytes (inflated) -> {meta, data} for L2.loadTemplate */
export function parsePack(b) {
  if (b[0] !== 76 || b[1] !== 86 || b[2] !== 50) throw new Error("not a livery v2 pack");
  const hl = b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24), head = JSON.parse(new TextDecoder().decode(b.subarray(8, 8 + hl)));
  const body = b.subarray(8 + hl), data = {};
  for (const [k, off, len] of head.layers) data[k] = body.subarray(off, off + len);
  return { meta: head.meta, data };
}

/** the season's template, loading it if needed */
export function loadSeason(kit, season) {
  const key = kit.meta.shapes[season] ? String(season) : seasonFor(kit, season);
  if (kit.tpl.has(key)) return Promise.resolve(kit.tpl.get(key));
  if (!kit.loading.has(key)) {
    kit.loading.set(key, (async () => {
      const r = await kit.get(`${kit.base}${key}.bin`);
      const T = L2.loadTemplate(parsePack(await inflateRaw(await r.arrayBuffer())));
      kit.tpl.set(key, T); kit.loading.delete(key); pump(kit);
      return T;
    })().catch((e) => { kit.loading.delete(key); console.warn("livery season", key, e); throw e; }));
  }
  return kit.loading.get(key);
}

// ------------------------------------------------------------------ v1 specs -> v2 designs (migrate.js)
import { migrate, SCHEMES, teamColours } from "./migrate.js";
export { migrate, SCHEMES, teamColours };

// ------------------------------------------------------------------ rendering
const keyOf = (season, lv, view) => `${season}|${view}|${JSON.stringify(lv)}`;

/** {w, h, rgba} if the season is loaded, else null (and the load starts) */
export function renderRGBA(kit, season, lv, view = "paint") {
  const key = kit.meta.shapes[season] ? String(season) : seasonFor(kit, season), T = kit.tpl.get(key);
  if (!T) { loadSeason(kit, key).catch(() => {}); return null; }
  return L2.render(T, EL.compile(migrate(lv), T, kit.decals), { view, decals: kit.decals });
}

function toCanvas(r) {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  const cv = document.createElement("canvas"); cv.width = r.w; cv.height = r.h;
  const g = cv.getContext?.("2d"); if (!g) return null;
  g.putImageData(new ImageData(r.rgba, r.w, r.h), 0, 0);
  return cv;
}

/** a canvas of the painted car, or null while its season loads (v1 returned a canvas synchronously) */
export function renderLivery(kit, season, lv, view = "paint") {
  const key = kit.meta.shapes[season] ? String(season) : seasonFor(kit, season), ck = keyOf(key, lv, view);
  if (kit.cache.has(ck)) return kit.cache.get(ck);
  const r = renderRGBA(kit, key, lv, view); if (!r) return null;
  const cv = toCanvas(r); remember(kit, ck, cv);
  return cv;
}
export async function renderLiveryAsync(kit, season, lv, view = "paint") {
  const key = kit.meta.shapes[season] ? String(season) : seasonFor(kit, season);
  await loadSeason(kit, key);
  return renderLivery(kit, key, lv, view);
}
function remember(kit, ck, cv) {
  kit.cache.set(ck, cv);
  if (kit.cache.size > 400) kit.cache.delete(kit.cache.keys().next().value);
}

// renders wanted by drawLiveryCar are done a few at a time between frames, so a full grid never stalls a frame
function pump(kit) {
  if (kit.pumping || !kit.queue.size) return;
  kit.pumping = true;
  const later = typeof requestIdleCallback === "function" ? (f) => requestIdleCallback(f, { timeout: 120 }) : (f) => setTimeout(f, 0);
  later(() => {
    kit.pumping = false;
    const t0 = Date.now();
    let done = 0;
    for (const [ck, job] of kit.queue) {
      if (!kit.tpl.has(job.key)) { loadSeason(kit, job.key).catch(() => kit.queue.delete(ck)); continue; }
      kit.queue.delete(ck);
      if (!kit.cache.has(ck)) { const r = renderRGBA(kit, job.key, job.lv); if (r) remember(kit, ck, toCanvas(r)); done++; }
      if (Date.now() - t0 > 12) break;
    }
    if (done) for (const f of kit.listeners) f();
    if ([...kit.queue.values()].some((j) => kit.tpl.has(j.key))) pump(kit);
  });
}
/** call f() whenever queued renders finish (UIs that draw once can redraw) */
export const onRendered = (kit, f) => { kit.listeners.add(f); return () => kit.listeners.delete(f); };

// silhouette from the index's run-length mask, in the livery's base colour, drawn while the real render is pending
function silhouette(kit, key, colour) {
  const ck = `${key}|${colour}`;
  if (kit.sil.has(ck)) return kit.sil.get(ck);
  const S = kit.meta.shapes[key], n = S.w * S.h, rgba = new Uint8ClampedArray(n * 4), c = L2.hex(colour);
  const b = Uint8Array.from(atob(S.mask), (ch) => ch.charCodeAt(0)), runs = new Uint16Array(b.buffer, 0, b.length >> 1);
  let p = 0, on = false;
  for (const r of runs) {
    if (on) for (let i = p; i < p + r && i < n; i++) {
      const x = i % S.w, y = (i / S.w) | 0, wheel = S.wheels.some(([wx, wy, wr]) => (x - wx) ** 2 + (y - wy) ** 2 < wr * wr * 0.86);
      const k = wheel ? [34, 35, 38] : c;
      rgba[i * 4] = k[0]; rgba[i * 4 + 1] = k[1]; rgba[i * 4 + 2] = k[2]; rgba[i * 4 + 3] = 255;
    }
    p += r; on = !on;
  }
  const cv = toCanvas({ w: S.w, h: S.h, rgba });
  kit.sil.set(ck, cv);
  return cv;
}

/** draw like Sprites.drawCar: car `w` px wide, wheels on yGround. Returns the helmet spot. */
export function drawLiveryCar(ctx, kit, year, lv, x, yGround, w, alpha = 1) {
  const key = seasonFor(kit, year), S = kit.meta.shapes[key], ck = keyOf(key, lv, "paint");
  let c = kit.cache.get(ck), pending = false;
  if (!c) {
    pending = true;
    if (!kit.queue.has(ck)) { kit.queue.set(ck, { key, lv }); loadSeason(kit, key).catch(() => {}); pump(kit); }
    c = silhouette(kit, key, migrate(lv)?.colors?.a ?? "#888888");
  }
  const s = w / S.w, h = S.h * s;
  const ground = S.wheels.length ? Math.max(...S.wheels.map(([, wy, wr]) => wy + wr)) : S.h;   // tyre bottom
  const y = yGround - ground * s;
  if (c) {
    const prev = [ctx.globalAlpha, ctx.imageSmoothingEnabled];
    ctx.globalAlpha = alpha; ctx.imageSmoothingEnabled = !S.pixel_art;
    ctx.drawImage(c, x, y, w, h);
    [ctx.globalAlpha, ctx.imageSmoothingEnabled] = prev;
  }
  const [hx, hy, hd] = S.helmet;
  return { hx: x + hx * s, hy: y + hy * s, hd: hd * s, season: key, pending };
}

// ------------------------------------------------------------------ period-correct random designs
/** national colours before 1968; later, colours of real cars within 12 years plus the plain mixes */
export function eraPalettes(kit, year) {
  const P = kit.meta.palettes, ks = Object.keys(P);
  if (+year < 1968) return ks.filter((k) => P[k].nation);
  return ks.filter((k) => (P[k].group === "car" && Math.abs(P[k].year - year) <= 12) || P[k].group === "generic");
}
// element choices by era (weights by repetition): what period cars wore
const ERA_SLOTS = {
  veteran: { body: ["none", "none", "none", "lower"], nose: ["none", "band", "whole"], stripe: ["none", "none", "single"], tail: ["none", "cap"] },
  prewar: { body: ["none", "none", "lower"], nose: ["none", "band", "whole", "whole"], stripe: ["none", "none", "single", "twin"], tail: ["none", "cap"] },
  frontengine: { body: ["none", "none", "lower"], nose: ["none", "band", "whole"], stripe: ["none", "single", "twin", "deck"], tail: ["none", "cap"] },
  cigar: { body: ["none", "none", "lower", "front_half"], nose: ["none", "band", "whole", "chevron"], stripe: ["none", "single", "twin", "deck", "coachline"], tail: ["none", "cap"] },
  wings: { body: ["none", "lower", "front_half", "arrow", "sash", "upper"], nose: ["none", "band", "chevron", "tip"], stripe: ["none", "single", "twin", "coachline", "tricolore"], tail: ["none", "cap", "chequer"] },
  turbo: { body: ["none", "lower", "upper", "arrow", "sash", "swoosh", "front_half"], nose: ["none", "chevron", "tip", "arrowhead"], stripe: ["none", "single", "coachline", "rising", "tricolore"], tail: ["none", "cap", "fade"] },
  v10: { body: ["lower", "upper", "swoosh", "rising", "arrow", "fade", "spear"], nose: ["none", "tip", "arrowhead", "top"], stripe: ["none", "none", "rising", "wave", "single"], tail: ["none", "fade", "cap"] },
  hybrid: { body: ["lower", "swoosh", "rising", "fade", "spear", "panels"], nose: ["none", "tip", "arrowhead", "top"], stripe: ["none", "none", "wave", "rising"], tail: ["none", "fade"] },
  groundeffect: { body: ["lower", "swoosh", "rising", "fade", "spear", "panels", "cover"], nose: ["none", "tip", "arrowhead", "top"], stripe: ["none", "none", "wave", "rising"], tail: ["none", "fade"] },
};

export function randomLivery(kit, season, seed = Date.now(), colours = null) {
  let sd = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  const rnd = () => { sd = (sd * 16807) % 2147483647; return (sd - 1) / 2147483646; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const key = seasonFor(kit, season), yr = +season, era = kit.meta.shapes[key].era, P = kit.meta.palettes;
  const pk = pick(eraPalettes(kit, yr)), pal = colours ?? { base: P[pk].base, c2: P[pk].c2, c3: P[pk].c3 };
  const base = L2.hex(pal.base), light = (base[0] + base[1] + base[2]) / 3 > 150;
  const E = ERA_SLOTS[era] ?? ERA_SLOTS.wings;
  const d = { v: 2, colors: { a: pal.base, b: pal.c2, c: pal.c3, d: "#141414" }, finish: yr < 1950 ? "satin" : "gloss" };
  for (const slot of ["body", "nose", "stripe", "tail"]) {
    const id = pick(E[slot]);
    if (id !== "none") d[slot] = { id, color: slot === "stripe" ? pick(["b", "c"]) : "b" };
  }
  if (yr >= 1968) d.wings = { id: pick(["match", "fill", "fill"]), color: "b" };
  const style = yr <= 1972 ? pick(yr < 1968 ? ["roundel", "roundel", "ring", "oval"] : ["roundel", "panel"]) : yr <= 1994 ? pick(["panel", "plain"]) : "plain";
  d.number = { text: String(1 + Math.floor(rnd() * 39)), style, panel: style === "plain" ? "#f4f4f4" : "#f4f4f4",
    digits: style !== "plain" ? "#141414" : light ? "#141414" : "#f4f4f4", font: yr < 1980 ? "classic" : pick(["condensed", "modern"]) };
  d.sponsors = [];
  if (yr >= 1968) {
    const plain = Object.keys(kit.meta.sponsors).filter((k) => !k.endsWith("_box"));
    const n = yr < 1972 ? 1 : 2 + Math.floor(rnd() * 3);
    for (const where of ["sidepod", "tail", "rear_wing", "engine_cover"].slice(0, n))
      d.sponsors.push({ id: pick(plain) + (rnd() < 0.3 ? "_box" : ""), where, color: light ? "#141414" : pick(["#f4f4f4", pal.c3, pal.c2]) });
  }
  return d;
}

// ------------------------------------------------------------------ colour harmony (as v1)
const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function toHsl(h) {
  const [r, g, b] = L2.hex(h).map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hh * 60, s, l];
}
function fromHsl(h, s, l) {
  h = ((h % 360) + 360) % 360; s = clamp(s); l = clamp(l);
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return "#" + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
}
export const HARMONIES = { complementary: "Complementary", analogous: "Analogous", triadic: "Triadic", split: "Split", mono: "Mono" };
/** accent (b) and trim (c) for a base colour by a colour-wheel rule */
export function harmony(base, rule) {
  const [h, s, l] = toHsl(base), s2 = Math.max(s, 0.55), contrast = l > 0.55 ? 0.15 : 0.92;
  switch (rule) {
    case "complementary": return { b: fromHsl(h + 180, s2, 0.5), c: fromHsl(h, 0.05, contrast) };
    case "analogous": return { b: fromHsl(h + 30, s2, Math.min(0.6, l + 0.1)), c: fromHsl(h - 30, s2, Math.max(0.3, l - 0.1)) };
    case "triadic": return { b: fromHsl(h + 120, s2, 0.5), c: fromHsl(h + 240, s2, 0.5) };
    case "split": return { b: fromHsl(h + 150, s2, 0.5), c: fromHsl(h + 210, s2, 0.5) };
    case "mono": return { b: fromHsl(h, s, l > 0.5 ? l - 0.3 : l + 0.3), c: fromHsl(h, s * 0.6, contrast) };
  }
  return {};
}

export { SLOTS, REGIONS } from "./elements.js";
