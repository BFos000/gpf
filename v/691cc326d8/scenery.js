// Strip scenery: a Genesis-style parallax background behind the side-on paperdoll strip (from the mockup in
// gfx/proto/strip_bg). Drawn into a low-res buffer (PS css px per pixel) and blown up without smoothing.
// Back to front: banded sky; far/mid/near horizon strips, each scrolling at its own px per metre of the focus car's
// lap distance and sinking a little as it climbs; the hillside (rows of two greens following the road's contour,
// covering the horizon at a crest); roadside dressing standing on the contour (trees, hedges, hoardings), placed by
// distance so it moves with the road; the barrier, drawn a column at a time and dropped to the road at each x (it
// follows the hills, its posts stay vertical); the verge. The strip draws the road and the cars over it.
// Art: placeholder (data/scenery, built by gfx/tools/proto_strip_bg.py), to be replaced by our own.

const PS = 2;                 // css px per scenery pixel
const RAIL_OFF = 5;           // verge between the rail's foot and the road (scenery px)

// horizon strips far -> near: [asset, px per metre, height below the horizon, share of the climb]
const SCENES = {
  forest:   { sky: "smgp_04", layers: [["smgp_13", 0.010, 0, 0.15], ["smgp_04", 0.028, 12, 0.3], ["nm_12", 0.07, 24, 0.5]],
              grass: ["#2f6a2a", "#27592a"], verge: ["#4a8a33", "#3d7a2c"], trees: ["conifer", "tree"] },
  alpine:   { sky: "smgp_02", layers: [["smgp_02", 0.008, 0, 0.15], ["smgp_13", 0.024, 12, 0.3], ["nm_11", 0.07, 24, 0.5]],
              grass: ["#3a7a30", "#316a2a"], verge: ["#4f9038", "#42802f"], trees: ["conifer", "tree_small"] },
  city:     { sky: "smgp_15", layers: [["smgp_02", 0.008, 0, 0.15], ["smgp_15", 0.024, 14, 0.3], ["nm_05", 0.07, 26, 0.5]],
              grass: ["#6f7d5a", "#5f6c4c"], verge: ["#9a9a92", "#868680"], trees: ["palm", "lamp"] },
  parkland: { sky: "smgp_08", layers: [["smgp_00", 0.010, 0, 0.15], ["smgp_08", 0.028, 12, 0.3], ["nm_10", 0.07, 24, 0.5]],
              grass: ["#3f8a2e", "#357a28"], verge: ["#5a9e3a", "#4a8a30"], trees: ["tree", "tree_small"] },
  dry:      { sky: "smgp_10", layers: [["smgp_09", 0.010, 0, 0.15], ["smgp_10", 0.028, 12, 0.3], ["nm_13", 0.07, 24, 0.5]],
              grass: ["#8a8a3a", "#7a7a32"], verge: ["#a89a52", "#968a48"], trees: ["bush", "tree_small"] },
};
const SCENE_OF = {};
const put = (scene, refs) => refs.split(" ").forEach((r) => (SCENE_OF[r] = scene));
put("forest", "spa nurburgring hockenheimring zolder nivelles essarts mosport tremblant watkins_glen anderstorp aintree pw_brno pw_gp07 pw_gp13 pw_gp14 pw_peronne pw_morlaas pw_st_gaudens pw_la_baule pw_dieppe");
put("alpine", "red_bull_ring zeltweg bremgarten charade pw_montreux pw_grenoble fuji pw_biella");
put("city", "monaco pescara boavista monsanto montjuic pedralbes baku marina_bay valencia adelaide detroit dallas phoenix long_beach las_vegas vegas miami jeddah albert_park villeneuve sochi madring pw_nice pw_antibes pw_genova pw_napoli pw_milano pw_roosevelt pw_nepliget_park pw_tre_fontane pw_littorio pw_beograd pw_bardo pw_livorno pw_montenero pw_alessandria pw_torino pw_bergamo pw_lucca pw_cremona pw_brescia pw_modena pw_nancy pw_strasbourg pw_lyon pw_tours pw_vichy pw_albi pw_pau pw_deauville pw_nimes");
put("dry", "interlagos jarama kyalami rodriguez galvez ain-diab jacarepagua estoril jerez portimao catalunya bahrain yas_marina losail buddh americas riverside george istanbul pw_tripoli pw_mellaha pw_tunis pw_alger pw_oran pw_anfa pw_madonie pw_madoniem pw_messina pw_cosenza pw_terramar pw_lasarte pw_miramas pw_alvaca");
// barrier and hoardings by period
const eraOf = (y) => y < 1960 ? { barrier: "hedge", boards: 0 } : y < 1970 ? { barrier: "armco", boards: 0.25 }
  : y < 2000 ? { barrier: "armco", boards: 0.6 } : { barrier: "fence", boards: 0.8 };
const DRESSING = ["armco_12", "bush", "bush_small", "tree", "tree_small", "conifer", "palm", "lamp", "board_nok", "board_gloy", "board_cabe", "board_inde"];
// the look: each layer pulled toward the horizon's sky colour (haze) and desaturated, more with distance, so the
// cars read against it; what stands right behind the cars (hillside, dressing, rail) is quieter and a little darker.
export const LOOK = {
  far:    { haze: 0.5, sat: 0.5, con: 0.6, mul: 1 },
  mid:    { haze: 0.38, sat: 0.55, con: 0.65, mul: 1 },
  near:   { haze: 0.25, sat: 0.6, con: 0.7, mul: 0.95 },
  dress:  { haze: 0.2, sat: 0.5, con: 0.7, mul: 0.92 },
  rail:   { haze: 0.15, sat: 1, con: 0.75, mul: 0.92 },
  ground: { haze: 0.12, sat: 0.6, con: 1, mul: 0.85 },
};
// sat: toward grey; con: toward mid-grey (128), calming busy texture; haze: toward the horizon colour; mul: darken
function grade(r, g, b, look, hz) {
  const l = 0.3 * r + 0.59 * g + 0.11 * b;
  const f = (c, h) => { c = l + (c - l) * look.sat; c = 128 + (c - 128) * look.con; return Math.max(0, Math.min(255, (c + (h - c) * look.haze) * look.mul)); };
  return [f(r, hz[0]), f(g, hz[1]), f(b, hz[2])];
}
// the day's mood: wetness w (0..1: overcast and darker as it rises) and night (floodlit: the distance in near
// darkness, what stands by the track lit). Applied after the look; per-layer night levels, far -> near
const NIGHT_MUL = { far: 0.22, mid: 0.28, near: 0.38, dress: 0.5, rail: 0.72, ground: 0.5 };
function moodGrade(q, lk, m) {
  let [r, g, b] = q;
  if (m.wet > 0) {
    const l = 0.3 * r + 0.59 * g + 0.11 * b, s = 1 - 0.55 * m.wet, k = 1 - 0.32 * m.wet;
    r = (l + (r - l) * s) * k; g = (l + (g - l) * s) * k; b = (l + (b - l) * s) * k * 1.03;
  }
  if (m.night) { const k = NIGHT_MUL[lk] ?? 0.5; r *= k * 0.82; g *= k * 0.9; b *= k * 1.12; }
  return [r, g, b].map((c) => Math.max(0, Math.min(255, c)));
}
// circuits raced at night (or into the night), from their first night race
const NIGHT_FROM = { marina_bay: 2008, yas_marina: 2009, bahrain: 2014, jeddah: 2021, losail: 2021, las_vegas: 2023, vegas: 2023 };
export const isNightRace = (circuit, year) => NIGHT_FROM[circuit] != null && (year ?? 0) >= NIGHT_FROM[circuit];
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hash = (n) => { let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16; return (x >>> 0) / 4294967296; };

export class Scenery {
  constructor(base) { this.base = base; this.img = {}; this.loading = new Set(); this.buf = null; this.meta = null; }
  async loadMeta() { try { const r = await fetch(`${this.base}assets.json`); if (r.ok) this.meta = await r.json(); } catch { /* no scenery */ } return this; }
  sceneFor(circuit) { return SCENES[SCENE_OF[circuit] ?? "parkland"]; }
  // start loading what a scene needs; true once it is all in
  ready(scene) {
    const names = [scene.sky, ...scene.layers.map((l) => l[0]), ...DRESSING];
    let ok = true;
    for (const n of names) {
      if (this.img[n]) continue;
      ok = false;
      if (this.loading.has(n) || typeof Image === "undefined") continue;
      this.loading.add(n);
      const i = new Image();
      i.onload = () => { this.img[n] = i; this.loading.delete(n); this.onload?.(); };
      i.onerror = () => this.loading.delete(n);
      i.src = `${this.base}${n}.png`;
    }
    return ok;
  }
  // v: { gx, gy, gd } (strip samples: css x, road line y, lap distance m), dF (focus car's lap distance, m),
  //    zF/zMid (focus height, mid height of the lap, m; 0 when the hills are off), carW (css px), circuit, year.
  // Returns false when the art isn't loaded yet (the strip then draws without it).
  draw(ctx, w, h, v) {
    const sc = this.sceneFor(v.circuit);
    this.mood = { wet: Math.round(Math.max(0, Math.min(1, v.wet ?? 0)) * 10) / 10, night: !!v.night };
    if (!this.meta || !this.ready(sc) || typeof document === "undefined") return false;
    const W = Math.ceil(w / PS), H = Math.ceil(h / PS);
    if (!this.buf) this.buf = document.createElement("canvas");
    if (this.buf.width !== W || this.buf.height !== H) { this.buf.width = W; this.buf.height = H; }
    const g = this.buf.getContext("2d"); g.imageSmoothingEnabled = false;
    const era = eraOf(v.year ?? 2000), I = this.img;
    const { gx, gy, gd } = v, n = gx.length, sx = gx[1] - gx[0];
    const at = (arr, x) => { const f = (x - gx[0]) / sx, i = Math.max(0, Math.min(n - 2, Math.floor(f))), r = f - i; return arr[i] + r * (arr[i + 1] - arr[i]); };
    const roadY = (xl) => (at(gy, xl * PS) - 6 - (v.back ?? 0)) / PS;   // the road's far edge, scenery px
    const dOf = (xl) => at(gd, xl * PS);
    const xOf = (d) => {                                         // screen x (scenery px) of a lap distance
      if (d <= gd[0] || d >= gd[n - 1]) return d <= gd[0] ? -1e4 : 1e4;
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (gd[m] <= d) lo = m; else hi = m; }
      return (gx[lo] + ((d - gd[lo]) / (gd[hi] - gd[lo] || 1)) * sx) / PS;
    };
    const ry = []; for (let x = 0; x <= W; x++) ry.push(Math.round(roadY(x + 0.5)));
    const hz = Math.round(H * 0.34);
    const climb = (v.zF - v.zMid) * 0.25;
    // sky
    const sky = this.skyOf(sc);
    const skyH = hz + 30, rh = skyH / sky.length;
    sky.forEach((c, i) => { g.fillStyle = c; g.fillRect(0, Math.floor(i * rh), W, Math.ceil(rh) + 1); });
    g.fillStyle = sky.at(-1); g.fillRect(0, skyH, W, H - skyH);
    if (this.mood.night && this.mood.wet < 0.3) {                // stars (fixed to the sky, drifting very slowly)
      const ox = Math.floor(v.dF * 0.004);
      for (let k = 0; k < W * hz / 90; k++) {
        const x = Math.floor(hash(k * 3 + 1) * (W + 200)) - ox % 200, y = Math.floor(hash(k * 3 + 2) * (hz - 4));
        g.fillStyle = hash(k * 3 + 3) < 0.15 ? "rgba(255,255,230,0.9)" : "rgba(200,210,255,0.5)"; g.fillRect(((x % W) + W) % W, y, 1, 1);
      }
    }
    // horizon strips
    sc.layers.forEach(([key, ppm, dy, vk], li) => {
      const im = this.graded(sc, key, ["far", "mid", "near"][li]);
      const y = Math.round(hz + dy + climb * vk - im.height);
      let ox = -((v.dF * ppm) % im.width); if (ox > 0) ox -= im.width;
      for (let x = Math.floor(ox); x < W; x += im.width) g.drawImage(im, x, y);
    });
    const grass = sc.grass.map((c) => this.colour(sc, c, "ground")), verge = sc.verge.map((c) => this.colour(sc, c, "ground"));
    // hillside: rows of two greens, 3 px each, following the contour
    const last = sc.layers.at(-1), nearBottom = Math.round(hz + last[2] + climb * last[3]);
    for (let x = 0; x < W; x++) {
      const yr = ry[x], yTop = Math.min(nearBottom - 1, yr - RAIL_OFF - 14);
      for (let y = yTop; y < yr; ) { const b = Math.floor((yr - 1 - y) / 3), e = yr - b * 3; g.fillStyle = grass[b % 2]; g.fillRect(x, y, 1, e - y); y = e; }
    }
    // roadside dressing (by distance slots: locked to the road)
    const k0 = v.carW / PS / 75;
    const spr = (name, d, lift, s) => {
      const im = this.graded(sc, name, "dress"); const x = xOf(d);
      const ww = Math.max(2, Math.round(im.width * k0 * s)), hh = Math.max(2, Math.round(im.height * k0 * s));
      if (x < -ww || x > W + ww) return;
      g.drawImage(im, Math.round(x - ww / 2), Math.round(roadY(Math.max(0, Math.min(W, x)))) - RAIL_OFF - 2 - hh - lift, ww, hh);
    };
    const slots = (spacing, fn) => {
      const d0 = dOf(0) - 40, d1 = dOf(W) + 40;
      if ((d1 - d0) / spacing > 300) return;
      for (let k = Math.floor(d0 / spacing); k <= Math.ceil(d1 / spacing); k++) fn(k, k * spacing + hash(k) * spacing * 0.6);
    };
    slots(26, (k, d) => { if (hash(k + 7) < 0.55) spr(sc.trees[hash(k + 3) < 0.6 ? 0 : 1], d, 4, 0.8 + hash(k + 11) * 0.35); });
    if (era.boards) slots(18, (k, d) => { if (hash(k + 101) < era.boards) spr(["board_nok", "board_gloy", "board_cabe", "board_inde"][Math.floor(hash(k + 5) * 4)], d, 0, 0.65); });
    // barrier: hedges, or the rail sheared to the contour (and a catch fence, modern)
    const rail = this.graded(sc, "armco_12", "rail");
    if (era.barrier === "hedge") slots(4.5, (k, d) => spr(hash(k + 13) < 0.7 ? "bush_small" : "bush", d, -3, 0.75));
    else {
      const pxm = (dOf(W) - dOf(0)) > 0 ? W / (dOf(W) - dOf(0)) : 1;
      if (era.barrier === "fence") {
        for (let x = 0; x < W; x++) {
          const yb = ry[x] - RAIL_OFF - rail.height, d = dOf(x), post = (((d % 4) + 4) % 4) < 1 / pxm;
          if (post) { g.fillStyle = "#3a3f46"; g.fillRect(x, yb - 22, 1, 22); continue; }
          g.fillStyle = "rgba(170,180,190,0.35)";
          for (let y = yb - 22; y < yb; y++) if (((x + y) & 3) === 0 || ((x - y) & 3) === 0) g.fillRect(x, y, 1, 1);
        }
      }
      for (let x = 0; x < W; x++) {
        const u = Math.floor((((dOf(x) * pxm) % rail.width) + rail.width) % rail.width);
        g.drawImage(rail, u, 0, 1, rail.height, x, ry[x] - RAIL_OFF - rail.height + 3, 1, rail.height);
      }
    }
    // floodlights (night): poles behind the barrier, a lamp head and its glow
    if (this.mood.night) slots(38, (k, d) => {
      const x = Math.round(xOf(d)); if (x < -4 || x > W + 4) return;
      const yb = ry[Math.max(0, Math.min(W, x))] - RAIL_OFF - 2, top = yb - 44;
      g.fillStyle = "#14161c"; g.fillRect(x, top, 1, yb - top);
      g.fillStyle = "rgba(255,240,200,0.10)"; g.fillRect(x - 6, top - 3, 13, 8);
      g.fillStyle = "rgba(255,240,200,0.22)"; g.fillRect(x - 3, top - 1, 7, 4);
      g.fillStyle = "#fff6d8"; g.fillRect(x - 2, top, 5, 2);
    });
    // verge: two greens by distance (6 m)
    for (let x = 0; x < W; x++) { g.fillStyle = verge[Math.floor((((dOf(x) % 12) + 12) % 12) / 6)]; g.fillRect(x, ry[x] - RAIL_OFF + 3, 1, RAIL_OFF + 2); }
    ctx.save(); ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.buf, 0, 0, W, H, 0, 0, W * PS, H * PS);
    ctx.restore();
    return true;
  }
  // an image graded to a look (cached per scene, since the haze colour is the scene's horizon)
  graded(sc, name, lk) {
    const m = this.mood ?? { wet: 0, night: false };
    const key = `${sc.sky}|${name}|${lk}|${m.wet}|${m.night}`;
    this.cache ??= new Map();
    if (this.cache.has(key)) return this.cache.get(key);
    const im = this.img[name], c = document.createElement("canvas");
    c.width = im.width; c.height = im.height;
    const g = c.getContext("2d"); g.drawImage(im, 0, 0);
    try {
      const d = g.getImageData(0, 0, c.width, c.height), p = d.data, hz = this.horizon(sc);
      for (let i = 0; i < p.length; i += 4) { if (!p[i + 3]) continue; const q = moodGrade(grade(p[i], p[i + 1], p[i + 2], LOOK[lk], hz), lk, m); p[i] = q[0]; p[i + 1] = q[1]; p[i + 2] = q[2]; }
      g.putImageData(d, 0, 0);
    } catch { /* tainted (file://): ungraded */ }
    this.cache.set(key, c);
    return c;
  }
  colour(sc, hex, lk) { const q = moodGrade(grade(...hexRgb(hex), LOOK[lk], this.horizon(sc)), lk, this.mood ?? { wet: 0, night: false }); return `rgb(${q.map(Math.round)})`; }
  horizon(sc) { return this.skyBands(sc).at(-1); }
  skyOf(sc) { return this.skyBands(sc).map((c) => `rgb(${c.map(Math.round)})`); }
  // the sky's colour bands, top to horizon, for the mood: overcast toward slate grey (darker with the rain); night a
  // deep blue (a dull grey-blue under rain clouds lit from below)
  skyBands(sc) {
    const day = this.meta?.[sc.sky]?.sky ?? [[120, 180, 230], [170, 200, 220]], m = this.mood ?? { wet: 0, night: false }, n = day.length;
    const mix = (a, b, f) => a.map((c, i) => c + (b[i] - c) * f);
    if (m.night) return day.map((_, i) => { const f = n > 1 ? i / (n - 1) : 1;
      return mix(mix([6, 9, 26], [34, 42, 74], f), mix([18, 20, 26], [52, 54, 62], f), Math.min(1, m.wet * 1.4)); });
    if (!m.wet) return day;
    const k = 1 - 0.38 * m.wet;
    return day.map((c, i) => { const f = n > 1 ? i / (n - 1) : 1; return mix(c, [96 + 40 * f, 104 + 38 * f, 114 + 34 * f].map((x) => x * k), Math.min(1, 0.35 + m.wet)); });
  }
  // rain over the whole strip (cars included): pixel streaks slanting with the wind and drifting with the camera.
  // level 0..1: drizzle (sparse, short, faint) to a downpour (dense, long). t: wall-clock seconds; dF: focus lap m
  drawRain(ctx, w, h, level, t, dF) {
    if (!(level > 0.04)) return;
    const W = Math.ceil(w / PS), H = Math.ceil(h / PS);
    const nDrops = Math.round(W * H / 1000 * (4 + 28 * level ** 1.3)), len = 2 + Math.round(5 * level);
    const fall = 260 + 160 * level, drift = 0.35;
    ctx.save();
    ctx.fillStyle = `rgba(205,215,232,${0.28 + 0.3 * level})`;
    for (let k = 0; k < nDrops; k++) {
      const sp = 0.75 + 0.5 * hash(k * 5 + 4);
      const x0 = hash(k * 5 + 1) * (W + H * drift), y0 = hash(k * 5 + 2) * (H + len);
      const y = ((y0 + t * fall * sp / PS) % (H + len)) - len;
      let x = (x0 - (y + len) * drift - dF * 2.2 / PS) % (W + H * drift); if (x < 0) x += W + H * drift;
      for (let j = 0; j < len; j++) ctx.fillRect(Math.round(x - j * drift) * PS, Math.round(y + j) * PS, PS, PS);
    }
    ctx.restore();
  }
}
