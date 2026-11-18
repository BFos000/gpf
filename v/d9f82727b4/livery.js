// Livery kit runtime: paint a livery spec on the blank car of any season (1900-2026).
// Data: gfx/liveries/atlas/ (atlas.json + blanks/maps/zones/accents/originals.png), built by
//   python gfx/tools/build_liveries.py && python gfx/tools/build_liveries.py --assets --atlas
// The pixel maths mirrors gfx/tools/livery_assets.py (render / layer_alpha), so Python renders and these match.
//
// Livery spec (plain JSON, safe to keep in a save file):
//   { scheme: "centre_stripe",                       // id from kit.meta.schemes
//     colors: { base: "#0f4a2c", c2: "#f0f0ea", c3: "#e8c632", wheel: "#c8a24a" | "c2" | omitted },
//                                              // wheel omitted: the accent (c2) before 1950, metallic after
//     number: "7", number_style: "roundel"|"ring"|"panel"|"oval"|"plain", number_colors: [panel, digits],
//     digit_font: "classic"|"condensed"|"modern",
//     sponsors: [{ decal: "kestrel" | "kestrel_box" | ..., slot: "side"|"top"|"tail"|"rear_wing"|"nose", color: "#fff" }] }
// The season picks the silhouette, so one spec follows a team through every era.
//
//   const kit = await loadLiveryKit("atlas/");
//   const canvas = renderLivery(kit, "1967", spec);              // native-size canvas
//   const a = drawLiveryCar(ctx, kit, 1973, spec, x, yGround, w); // a = {hx, hy, hd} helmet centre/diameter on screen

export const ERA_NAMES = { veteran: "Veteran", prewar: "Pre-war", frontengine: "Front-engined", cigar: "Cigar",
  wings: "Wings and slicks", turbo: "Turbo", v10: "V10", hybrid: "Hybrid", groundeffect: "Ground effect" };
export const SLOTS = ["side", "top", "tail", "rear_wing", "nose"];

const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
function pixels(im) {
  const c = document.createElement("canvas"); c.width = im.width; c.height = im.height;
  const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(im, 0, 0);
  return g.getImageData(0, 0, im.width, im.height);
}

export async function loadLiveryKit(base = "atlas/", { originals = false } = {}) {
  const meta = await (await fetch(base + "atlas.json")).json();
  const names = ["blanks", "maps", "zones", "accents"].concat(originals ? ["originals"] : []);
  const ims = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await loadImg(`${base}${n}.png`)])));
  const kit = { meta, ims, B: pixels(ims.blanks), M: pixels(ims.maps), Z: pixels(ims.zones),
    keys: Object.keys(meta.shapes).sort(), schemes: Object.fromEntries(meta.schemes.map((s) => [s.id, s])),
    tint: new Map(), cache: new Map() };
  kit.years = kit.keys.map(Number);
  return kit;
}

/** the silhouette for a race year: that season, else the nearest earlier one (else the earliest). */
export function seasonFor(kit, year) {
  let best = kit.keys[0];
  for (const k of kit.keys) if (+k <= +year) best = k;
  return best;
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function layerAlpha(ly, s, t, z, x, y, e) {
  let a = shapeAlpha(ly, s, t, z, x, y, e);
  if (ly.clip) for (const c of ly.clip) a *= shapeAlpha(c, s, t, z, x, y, e);
  return a;
}
function shapeAlpha(ly, s, t, z, x, y, e) {
  const ramp = (v, a, b) => clamp((v - a) / e + 0.5) * clamp((b - v) / e + 0.5);
  switch (ly.kind) {
    case "all": return 1;
    case "band": { const v = ly.axis === "s" ? s : ly.axis === "t" ? t + (ly.rise || 0) * (s - 0.5) : s + (ly.k || 0) * (t - 0.5) * 0.25;
      return ramp(v, ly.a, ly.b); }
    case "zone": return ly.ids.includes(z) ? 1 : 0;
    case "diag": { const a = clamp((s + ly.k * (t - 0.5) * 0.25 - ly.c) / e + 0.5); return ly.flip ? 1 - a : a; }
    case "chevron": return clamp(((s - ly.s0) - (ly.dir ?? 1) * Math.abs(t - (ly.tc ?? 0.5)) * ly.k * 0.25) / e + 0.5);
    case "fade": { const v = ly.axis === "s" ? s : t; return clamp((v - ly.a) / (ly.b - ly.a)); }
    case "checker": return ramp(t, ly.a, ly.b) * ((Math.floor(x / ly.n) + Math.floor(y / ly.n)) % 2 === 0 ? 1 : 0);
  }
  return 0;
}

export function tinted(kit, key, col) {
  const k = key + col; if (kit.tint.has(k)) return kit.tint.get(k);
  const [x, y, w, h] = kit.meta.accents[key]; const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"); g.drawImage(kit.ims.accents, x, y, w, h, 0, 0, w, h);
  g.globalCompositeOperation = "source-in"; g.fillStyle = col; g.fillRect(0, 0, w, h);
  kit.tint.set(k, c); return c;
}

export function digitsCanvas(kit, num, font, col) {
  const parts = [...String(num)].filter((ch) => kit.meta.accents[`digit:${font}:${ch}`]).map((ch) => tinted(kit, `digit:${font}:${ch}`, col));
  if (!parts.length) return null;
  const c = document.createElement("canvas"); c.width = Math.max(1, parts.reduce((a, p) => a + p.width, 0) - 4 * (parts.length - 1)); c.height = 64;
  const g = c.getContext("2d"); let x = 0; for (const p of parts) { g.drawImage(p, x, 0); x += p.width - 4; } return c;
}

/** native-size canvas of the season's car in the livery. view: "paint" | "blank" | "mask" | "zones" */
export function renderLivery(kit, season, lv, view = "paint") {
  const key = kit.meta.shapes[season] ? String(season) : seasonFor(kit, season);
  const S = kit.meta.shapes[key], [rx, ry, w, h] = S.rect, AW = kit.B.width, MB = kit.M.data, ZB = kit.Z.data, BB = kit.B.data;
  const out = document.createElement("canvas"); out.width = w; out.height = h;
  const go = out.getContext("2d"); const O = go.createImageData(w, h);
  const pc = document.createElement("canvas"); pc.width = w; pc.height = h;
  const gp = pc.getContext("2d", { willReadFrequently: true }); const P = gp.createImageData(w, h);
  const layers = kit.schemes[lv.scheme].layers.map((ly) => ({ ly, c: hex(ly.fill.startsWith("#") ? ly.fill : lv.colors[ly.fill]),
    e: (ly.axis || "s") === "s" ? 1.2 / w : 1 / 30, al: ly.alpha ?? 1 }));
  // wheels (zone 7): their own colour; before 1950 the accent by default, later metallic
  const wd = (lv.colors && lv.colors.wheel) || S.wheel_default || "#b9bdc4";
  const wc = hex(wd.startsWith("#") ? wd : lv.colors[wd]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ai = ((ry + y) * AW + rx + x) * 4, o = (y * w + x) * 4;
    if (MB[ai + 3] === 0) continue;
    const s = MB[ai + 1] / 255, t = MB[ai + 2] / 255, z = ZB[ai];
    if (z === 7) { P.data[o] = wc[0]; P.data[o + 1] = wc[1]; P.data[o + 2] = wc[2]; P.data[o + 3] = 255; continue; }
    let r = 0, g = 0, b = 0;
    for (const L of layers) { const a = layerAlpha(L.ly, s, t, z, x, y, L.e) * L.al;
      if (a > 0) { r += (L.c[0] - r) * a; g += (L.c[1] - g) * a; b += (L.c[2] - b) * a; } }
    P.data[o] = r; P.data[o + 1] = g; P.data[o + 2] = b; P.data[o + 3] = 255;
  }
  gp.putImageData(P, 0, 0);
  // accents go on the paint layer so the car's shading falls on them too
  const nb = S.slots.number;
  if (lv.number && nb) {
    const [cx, cy, rr] = nb, d = Math.round(rr * 2), st = lv.number_style || "roundel", nc = lv.number_colors || ["#f4f4f4", "#141414"];
    if (st !== "plain") gp.drawImage(tinted(kit, `panel:${st}`, nc[0]), Math.round(cx - rr), Math.round(cy - rr), d, d);
    const [bx, by, bw, bh] = kit.meta.number_panels[st];
    const dg = digitsCanvas(kit, lv.number, lv.digit_font || "classic", nc[1]);
    if (dg) { const k = Math.min(bw * d / dg.width, bh * d / dg.height), dw = dg.width * k, dh = dg.height * k;
      gp.drawImage(dg, cx - rr + bx * d + (bw * d - dw) / 2, cy - rr + by * d + (bh * d - dh) / 2, dw, dh); }
  }
  for (const sp of lv.sponsors || []) {
    const rc = S.slots[sp.slot]; if (!rc || !sp.decal || !kit.meta.accents[`sponsor:${sp.decal}`]) continue;
    const im = tinted(kit, `sponsor:${sp.decal}`, sp.color || "#ffffff"), [x0, y0, rw, rh] = rc;
    const k = Math.min(rw * 0.92 / im.width, rh * 0.9 / im.height), dw = im.width * k, dh = im.height * k;
    gp.drawImage(im, x0 + (rw - dw) / 2, y0 + (rh - dh) / 2, dw, dh);
  }
  const PP = gp.getImageData(0, 0, w, h).data;
  const zc = [[0,0,0],[232,84,84],[84,160,232],[92,206,120],[230,188,72],[196,112,230],[240,142,62],[240,240,240]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ai = ((ry + y) * AW + rx + x) * 4, o = (y * w + x) * 4, m = MB[ai + 3] > 0;
    let r = BB[ai], g = BB[ai + 1], b = BB[ai + 2];
    if (m) {
      const k = MB[ai] / kit.meta.shade_1;
      if (view === "paint") { r = PP[o] * k; g = PP[o + 1] * k; b = PP[o + 2] * k; }
      else if (view === "mask") { r = 255; g = 255; b = 255; }
      else if (view === "zones") { const c = zc[ZB[ai]] || zc[0]; r = r * 0.35 + c[0] * 0.65; g = g * 0.35 + c[1] * 0.65; b = b * 0.35 + c[2] * 0.65; }
    } else if (view === "mask") { r *= 0.25; g *= 0.25; b *= 0.25; }
    O.data[o] = r; O.data[o + 1] = g; O.data[o + 2] = b; O.data[o + 3] = BB[ai + 3];
  }
  go.putImageData(O, 0, 0);
  return out;
}

/** draw like Sprites.drawCar: car `w` px wide, wheels on yGround. Cached per season+spec. Returns the helmet spot. */
export function drawLiveryCar(ctx, kit, year, lv, x, yGround, w, alpha = 1) {
  const key = seasonFor(kit, year), S = kit.meta.shapes[key], ck = key + JSON.stringify(lv);
  let c = kit.cache.get(ck);
  if (!c) { c = renderLivery(kit, key, lv); kit.cache.set(ck, c); if (kit.cache.size > 400) kit.cache.delete(kit.cache.keys().next().value); }
  const s = w / S.w, h = S.h * s;
  const ground = S.wheels.length ? Math.max(...S.wheels.map(([, wy, wr]) => wy + wr)) : S.h;  // tyre bottom
  const y = yGround - ground * s;
  const prev = [ctx.globalAlpha, ctx.imageSmoothingEnabled];
  ctx.globalAlpha = alpha; ctx.imageSmoothingEnabled = !S.pixel_art;
  ctx.drawImage(c, x, y, w, h);
  [ctx.globalAlpha, ctx.imageSmoothingEnabled] = prev;
  const [hx, hy, hd] = S.helmet;
  return { hx: x + hx * s, hy: y + hy * s, hd: hd * s, season: key };
}

// ------------------------------------------------------------------ period-correct random liveries
export const eraSchemes = (kit, era) => kit.meta.schemes.filter((s) => s.eras === "all" || s.eras.includes(era)).map((s) => s.id);
/** national colours before 1968; later, colours of real cars within 12 years plus the plain mixes */
export function eraPalettes(kit, year) {
  const P = kit.meta.palettes, ks = Object.keys(P);
  if (+year < 1968) return ks.filter((k) => P[k].nation);
  return ks.filter((k) => (P[k].group === "car" && Math.abs(P[k].year - year) <= 12) || P[k].group === "generic");
}

// ------------------------------------------------------------------ colour harmony helpers
function toHsl(h) {
  const [r, g, b] = hex(h).map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
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
/** second and trim colours for a base colour by a colour-wheel rule. Greys get a contrasting neutral. */
export function harmony(base, rule) {
  const [h, s, l] = toHsl(base), s2 = Math.max(s, 0.55), contrast = l > 0.55 ? 0.15 : 0.92;
  switch (rule) {
    case "complementary": return { c2: fromHsl(h + 180, s2, 0.5), c3: fromHsl(h, 0.05, contrast) };
    case "analogous": return { c2: fromHsl(h + 30, s2, Math.min(0.6, l + 0.1)), c3: fromHsl(h - 30, s2, Math.max(0.3, l - 0.1)) };
    case "triadic": return { c2: fromHsl(h + 120, s2, 0.5), c3: fromHsl(h + 240, s2, 0.5) };
    case "split": return { c2: fromHsl(h + 150, s2, 0.5), c3: fromHsl(h + 210, s2, 0.5) };
    case "mono": return { c2: fromHsl(h, s, l > 0.5 ? l - 0.3 : l + 0.3), c3: fromHsl(h, s * 0.6, contrast) };
  }
  return {};
}

export function randomLivery(kit, season, seed = Date.now(), scheme = null) {
  let sd = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  const rnd = () => { sd = (sd * 16807) % 2147483647; return (sd - 1) / 2147483646; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const key = seasonFor(kit, season), yr = +season, era = kit.meta.shapes[key].era, P = kit.meta.palettes;
  const pk = pick(eraPalettes(kit, yr)), pal = { base: P[pk].base, c2: P[pk].c2, c3: P[pk].c3 };
  const base = hex(pal.base), light = (base[0] + base[1] + base[2]) / 3 > 150;
  const style = yr <= 1972 ? pick(yr < 1968 ? ["roundel", "roundel", "ring", "oval"] : ["roundel", "panel"])
    : yr <= 1994 ? pick(["panel", "plain"]) : "plain";
  const lv = { scheme: scheme || pick(eraSchemes(kit, era)), colors: pal, number: String(1 + Math.floor(rnd() * 39)), number_style: style,
    number_colors: style !== "plain" ? ["#f4f4f4", "#141414"] : ["#000000", light ? "#141414" : "#f4f4f4"],
    digit_font: yr < 1980 ? "classic" : pick(["condensed", "modern"]), sponsors: [] };
  if (yr >= 1950 && rnd() < 0.35) lv.colors.wheel = pick(["#c8a24a", "#f4f4f4", "#1b1b1b", pal.c2]);  // painted rims
  if (yr >= 1968) {
    const plain = Object.keys(kit.meta.sponsors).filter((k) => !k.endsWith("_box"));
    const n = yr < 1972 ? 1 : 2 + Math.floor(rnd() * 3);
    for (const slot of ["side", "tail", "rear_wing", "top"].slice(0, n))
      lv.sponsors.push({ decal: pick(plain) + (rnd() < 0.3 ? "_box" : ""), slot, color: light ? "#141414" : pick(["#f4f4f4", pal.c3, pal.c2]) });
  }
  return lv;
}
