// Livery v2 element library: a design is a set of slots, each filled from a preset (a small, named collection of
// renderer layers with a few knobs). compile(design, T, decals) -> { colors, finish, layers, decalOps } for render().
//
// design = { colors: {a, b, c, d}, finish,
//            body:    {id, color, ...knobs}   main graphic (two-tone splits, swooshes, arrows, sashes, fades)
//            stripe:  {id, color, ...}        stripes running along the car
//            nose:    {id, color, ...}        nose treatment
//            tail:    {id, color, ...}        tail treatment
//            wings:   {id, color}             wing colour (falls back to the tail on wingless cars)
//            contour: {id, color, width}      pin-lines tracing panels
//            pattern: {id, color, color2, where, scale, opacity}
//            number:  {text, style, panel, digits, font, where}
//            sponsors:[{id, where, color}],  extra: [raw layers]
//            emblems: [{shape | img, where, color, size, dx, flip, over}] }   custom layer shapes (below)
// Emblems ("custom" layers): any image used as a mask and filled with the layer colour, fitted rigidly into a region
// like a decal. shape names a built-in silhouette (shapes.json: bull, disc, clover, ...); img is an uploaded image
// {w, h, a: base64 alpha}. size scales the fitted box (0.2-1), dx slides it along the car (-1 back .. 1 front), flip
// mirrors it, over: true stacks it on the previous emblem's box (a bull on a sun disc).
// Colour roles: a base, b accent, c trim, d detail. Any colour field may also be "#rrggbb".

const S = (id, name, knobs, build) => ({ id, name, knobs, build });
// knob: [key, label, min, max, step, default]

export const SLOTS = {
  body: [
    S("none", "Plain", [], () => []),
    S("lower", "Lower half", [["h", "Height", -0.6, 0.9, 0.05, 0.3]], (p) => [{ type: "split", curve: [[0, p.h], [1, p.h]], side: "below", where: "body" }]),
    S("upper", "Upper deck", [["h", "Height", -0.6, 0.6, 0.05, 0]], (p) => [{ type: "split", curve: [[0, p.h], [1, p.h]], side: "above", where: "body" }]),
    S("swoosh", "Swoosh", [["start", "Rear height", -0.5, 0.8, 0.05, 0.1], ["dip", "Sweep", 0.2, 1.2, 0.05, 0.6], ["at", "Sweep point", 0.25, 0.75, 0.01, 0.45]],
      (p) => [{ type: "split", curve: [[0, p.start], [p.at - 0.15, p.start + 0.05], [p.at, p.start + p.dip * 0.6], [p.at + 0.2, p.start + p.dip * 1.8]], side: "below", where: "body" }]),
    S("rising", "Rising wedge", [["rear", "Rear height", -0.8, 0.6, 0.05, -0.4], ["front", "Nose height", 0, 1.2, 0.05, 0.75]],
      (p) => [{ type: "split", curve: [[0, p.rear], [1, p.front]], side: "below", where: "body" }]),
    S("front_half", "Front half", [["at", "Split point", 0.2, 0.9, 0.01, 0.5], ["lean", "Lean", -0.2, 0.2, 0.01, 0.06]],
      (p) => [{ type: "cut", curve: [[-1, p.at + p.lean], [1, p.at - p.lean]], side: "front", where: "body" }]),
    S("rear_half", "Rear half", [["at", "Split point", 0.2, 0.9, 0.01, 0.5], ["lean", "Lean", -0.2, 0.2, 0.01, 0.06]],
      (p) => [{ type: "cut", curve: [[-1, p.at + p.lean], [1, p.at - p.lean]], side: "back", where: "body" }]),
    S("arrow", "Arrow", [["at", "Tip", 0.3, 0.95, 0.01, 0.62], ["k", "Sharpness", 0.05, 0.6, 0.01, 0.22], ["vc", "Height", -0.6, 0.8, 0.05, 0.2]],
      (p) => [{ type: "chevron", u0: p.at, k: -p.k, vc: p.vc, side: "back", where: "body" }]),
    S("spear", "Spear", [["at", "Tip", 0.4, 1, 0.01, 0.8], ["vc", "Height", -0.4, 0.8, 0.05, 0.3], ["w", "Width", 0.2, 1.2, 0.05, 0.7]],
      (p) => [{ type: "split", curve: [[0, p.vc - p.w / 2], [p.at, p.vc]], side: "below", where: "body",
        mask: [{ type: "split", curve: [[0, p.vc + p.w / 2], [p.at, p.vc]], side: "above" }, { type: "cut", curve: [[-1, p.at], [1, p.at]], side: "back" }] }]),
    S("sash", "Sash", [["at", "Position", 0.15, 0.9, 0.01, 0.55], ["w", "Width", 0.02, 0.2, 0.005, 0.07], ["lean", "Lean", -0.25, 0.25, 0.01, 0.1]],
      (p) => [{ type: "cstripe", curve: [[-1, p.at + p.lean], [1, p.at - p.lean]], width: p.w, where: "body" }]),
    S("fade", "Fade to tail", [["from", "Starts", 0.2, 0.9, 0.01, 0.6], ["to", "Solid at", 0, 0.5, 0.01, 0.15]],
      (p) => [{ type: "fade", axis: "u", from: p.from, to: p.to, where: "body" }]),
    S("panels", "Sidepod and nose", [], () => [{ type: "fill", where: ["sidepod", "nose"] }]),
    S("cover", "Engine cover", [], () => [{ type: "fill", where: ["engine_cover", "airbox"] }]),
  ],
  stripe: [
    S("none", "None", [], () => []),
    S("single", "Single", [["v", "Height", -0.8, 0.9, 0.05, 0.35], ["w", "Width", 0.04, 0.5, 0.01, 0.16]],
      (p) => [{ type: "stripe", curve: [[0, p.v], [1, p.v]], width: p.w, where: "body" }]),
    S("twin", "Twin", [["v", "Height", -0.8, 0.9, 0.05, 0.3], ["w", "Width", 0.03, 0.25, 0.01, 0.08], ["gap", "Gap", 0.05, 0.5, 0.01, 0.18]],
      (p) => [-1, 1].map((s) => ({ type: "stripe", curve: [[0, p.v + (s * p.gap) / 2], [1, p.v + (s * p.gap) / 2]], width: p.w, where: "body" }))),
    S("coachline", "Coachline at the shoulder", [["w", "Width", 0.02, 0.12, 0.005, 0.045]], (p) => [{ type: "stripe", curve: [[0, 0], [1, 0]], width: p.w, where: "body" }]),
    S("tricolore", "Tricolore", [["v", "Height", -0.6, 0.8, 0.05, 0.3], ["w", "Width each", 0.03, 0.2, 0.01, 0.08]],
      (p) => ["b", "c", "d"].map((c, k) => ({ type: "stripe", curve: [[0, p.v + (k - 1) * p.w], [1, p.v + (k - 1) * p.w]], width: p.w * 1.02, where: "body", color: c }))),
    S("rising", "Rising", [["rear", "Rear height", -0.4, 1, 0.05, 0.7], ["front", "Nose height", -0.6, 0.8, 0.05, 0], ["w", "Width", 0.04, 0.4, 0.01, 0.12]],
      (p) => [{ type: "stripe", curve: [[0, p.rear], [1, p.front]], width: p.w, where: "body" }]),
    S("wave", "Wave", [["v", "Height", -0.4, 0.8, 0.05, 0.3], ["amp", "Swing", 0, 0.6, 0.02, 0.25], ["w", "Width", 0.04, 0.4, 0.01, 0.12]],
      (p) => [{ type: "stripe", curve: [[0, p.v + p.amp], [0.3, p.v - p.amp], [0.6, p.v + p.amp], [0.85, p.v - p.amp], [1, p.v]], width: p.w, where: "body" }]),
    S("deck", "Top racing stripe", [["w", "Width", 0.1, 0.6, 0.01, 0.3]], (p) => [{ type: "stripe", curve: [[0, -1 + p.w / 2], [1, -1 + p.w / 2]], width: p.w, where: "body" }]),
  ],
  nose: [
    S("none", "Plain", [], () => []),
    S("tip", "Painted tip", [["at", "Length", 0.85, 0.99, 0.005, 0.95]], (p) => [{ type: "cut", curve: [[-1, p.at], [1, p.at]], side: "front", where: "body" }]),
    S("band", "Nose band", [["at", "Position", 0.84, 0.98, 0.005, 0.9], ["w", "Width", 0.01, 0.08, 0.002, 0.025]],
      (p) => [{ type: "cstripe", curve: [[-1, p.at], [1, p.at]], width: p.w, where: "body" }]),
    S("whole", "Whole nose", [], () => [{ type: "fill", where: ["nose"] }]),
    S("chevron", "Chevron", [["at", "Position", 0.8, 0.98, 0.005, 0.9], ["k", "Sharpness", 0.03, 0.4, 0.01, 0.12]],
      (p) => [{ type: "chevron", u0: p.at, k: -p.k, vc: 0.25, side: "front", where: "body" }]),
    S("arrowhead", "Arrowhead", [["at", "Position", 0.75, 0.97, 0.005, 0.86], ["k", "Sharpness", 0.03, 0.4, 0.01, 0.15], ["w", "Width", 0.01, 0.06, 0.002, 0.025]],
      (p) => [{ type: "chevron", u0: p.at, k: -p.k, vc: 0.25, side: "front", width: p.w, where: "body" }]),
    S("top", "Nose top", [["h", "Depth", -0.6, 0.6, 0.05, 0]], (p) => [{ type: "split", curve: [[0, p.h], [1, p.h]], side: "above", where: ["nose"] }]),
  ],
  tail: [
    S("none", "Plain", [], () => []),
    S("tail", "Tail colour", [], () => [{ type: "fill", where: ["tail"] }]),
    S("cap", "Tail cap", [["at", "Length", 0.03, 0.4, 0.01, 0.12]], (p) => [{ type: "cut", curve: [[-1, p.at], [1, p.at]], side: "back", where: "body" }]),
    S("chequer", "Chequered tail", [["at", "Length", 0.05, 0.4, 0.01, 0.14], ["scale", "Square", 0.05, 0.3, 0.01, 0.1]],
      (p) => [{ type: "pattern", kind: "chequer", scale: p.scale, where: "body", mask: { type: "cut", curve: [[-1, p.at], [1, p.at]], side: "back" } }]),
    S("fade", "Fade", [["from", "Starts", 0.15, 0.6, 0.01, 0.35]], (p) => [{ type: "fade", axis: "u", from: p.from, to: 0.02, where: "body" }]),
  ],
  wings: [
    S("match", "Match the body", [], () => []),
    S("fill", "Wing colour", [], () => [{ type: "fill", where: ["rear_wing", "front_wing", "endplate"] }]),
    S("rear", "Rear wing only", [], () => [{ type: "fill", where: ["rear_wing"] }]),
    S("split", "Two-tone wings", [], () => [{ type: "fade", axis: "pv", from: 0.48, to: 0.52, where: ["rear_wing", "front_wing"] }]),
  ],
  contour: [
    S("none", "None", [], () => []),
    S("panels", "Every panel", [["width", "Width", 0.6, 3, 0.1, 1.2], ["offset", "Inset", 0, 4, 0.25, 1.5]],
      (p) => ["sidepod", "engine_cover", "nose", "chassis", "cockpit", "rear_wing", "front_wing", "tail"].map((r) => ({ type: "contour", where: r, width: p.width, offset: p.offset }))),
    S("sidepod", "Sidepod", [["width", "Width", 0.6, 3, 0.1, 1.3], ["offset", "Inset", 0, 4, 0.25, 1.5]], (p) => [{ type: "contour", where: "sidepod", width: p.width, offset: p.offset }]),
    S("body", "Body outline", [["width", "Width", 0.6, 3, 0.1, 1.2], ["offset", "Inset", 0, 4, 0.25, 1.75]], (p) => [{ type: "contour", where: "body", width: p.width, offset: p.offset }]),
  ],
  pattern: [
    S("none", "None", [], () => []),
    ...["chequer", "dots", "pinstripe", "hex", "carbon", "scales"].map((k) => S(k, k[0].toUpperCase() + k.slice(1), [["scale", "Scale", 0.03, 0.4, 0.01, k === "pinstripe" ? 0.06 : 0.1], ["angle", "Angle", -90, 90, 5, k === "pinstripe" ? 60 : 0], ["opacity", "Strength", 0.1, 1, 0.05, k === "carbon" ? 0.6 : 1]],
      (p) => [{ type: "pattern", kind: k, scale: p.scale, angle: p.angle, opacity: p.opacity }])),
  ],
};
export const REGIONS = ["body", "sidepod", "engine_cover", "nose", "tail", "cockpit", "chassis", "wings", "rear_wing", "all"];

function knobs(slot, cfg) {
  const def = SLOTS[slot].find((s) => s.id === cfg?.id) ?? SLOTS[slot][0];
  const p = {};
  for (const [k, , , , , d] of def.knobs) p[k] = cfg?.[k] ?? d;
  return { def, p };
}

const DEF_COLOR = { body: "b", stripe: "c", nose: "b", tail: "b", wings: "b", contour: "c", pattern: "c" };
const ORDER = ["body", "tail", "nose", "pattern", "stripe", "wings", "contour"];

export function compile(design, T, decals) {
  const layers = [];
  for (const slot of ORDER) {
    const cfg = design[slot]; if (!cfg) continue;
    const { def, p } = knobs(slot, cfg);
    for (const L of def.build(p)) {
      const out = { color: cfg.color ?? DEF_COLOR[slot], ...L };
      if (L.color && cfg.color && slot !== "stripe") out.color = cfg.color;
      if (slot === "pattern") { out.where = cfg.where ?? "body"; if (cfg.color2) out.color2 = cfg.color2; if (cfg.opacity != null) out.opacity = cfg.opacity; }
      if (cfg.where && slot !== "pattern" && !["wings", "contour"].includes(slot)) out.where = cfg.where;
      layers.push(out);
    }
  }
  layers.push(...(design.extra ?? []));
  const lv = { colors: design.colors, finish: design.finish ?? "gloss", layers };
  lv.decalOps = T && decals ? layoutDecals(design, T, decals) : [];
  return lv;
}

// ------------------------------------------------------------------ decals (rigid: never warped)
/** biggest rectangle of a given aspect (w/h) inside a mask -> [x, y, w, h] */
export function fitRect(mask, W, H, aspect) {
  const hist = new Int32Array(W); let best = null, bestA = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) hist[x] = mask[y * W + x] ? hist[x] + 1 : 0;
    const st = [];
    for (let x = 0; x <= W; x++) {
      const hh = x < W ? hist[x] : 0; let start = x;
      while (st.length && st[st.length - 1][1] >= hh) {
        const [sx, sh] = st.pop(), rw = x - sx;
        const dh = Math.min(sh, rw / aspect), dw = dh * aspect;
        if (dw * dh > bestA) { bestA = dw * dh; best = [sx + (rw - dw) / 2, y - sh + 1 + (sh - dh) / 2, dw, dh]; }
        start = sx;
      }
      st.push([start, hh]);
    }
  }
  return best;
}

export function layoutDecals(design, T, D) {
  const ops = [], { w, h } = T, yr = T.meta.seasons?.[0] ?? 1980;
  const busy = new Uint8Array(T.n), taken = new Uint8Array(T.n);
  for (let i = 0; i < T.n; i++) if (T.line[i] > 70) busy[i] = 1;          // louvres, seams, outline
  const regionMask = (where, clear = true) => { const m = T.__region(where), o = new Uint8Array(T.n); for (let i = 0; i < T.n; i++) o[i] = m[i] && !taken[i] && !(clear && busy[i]) ? 1 : 0; return erode(o, w, h); };
  // prefer clear paint; sit over detail only when the clear spot would be under half the size
  const fit = (where, ar) => { const a = fitRect(regionMask(where), w, h, ar), b = fitRect(regionMask(where, false), w, h, ar); return !a || (b && a[3] < 0.5 * b[3]) ? b : a; };
  const claim = (r, pad = 1) => { for (let y = Math.max(0, Math.floor(r[1] - pad)); y < Math.min(h, r[1] + r[3] + pad); y++) for (let x = Math.max(0, Math.floor(r[0] - pad)); x < Math.min(w, r[0] + r[2] + pad); x++) taken[y * w + x] = 1; };
  let prev = null;
  for (const em of design.emblems ?? []) {
    const g = emblemShape(D, em); if (!g) continue;
    // emblems are graphics, not labels: they may span panel lines, so the whole region counts
    const over = em.over && prev;
    let r = over ? prev : fitRect(regionMask(em.where ?? "sidepod", false), w, h, g.w / g.h);
    if (!r) continue;
    const ar = g.w / g.h, k = Math.max(0.1, Math.min(1, em.size ?? 0.85));
    let rw = Math.min(r[2], r[3] * ar) * k, rh = rw / ar;                  // the shape's own aspect inside the box
    const slack = r[2] - rw, cx = r[0] + slack / 2 + (over ? 0 : (em.dx ?? 0) * slack / 2);
    const rr = [cx, r[1] + (r[3] - rh) / 2, rw, rh];
    if (!over) { claim(rr); prev = rr; }                                   // a stacked emblem sits on what this one drew
    ops.push({ kind: "custom", shape: em.shape ?? null, img: em.shape ? null : em.img, rect: rr, color: em.color ?? "b", flip: !!em.flip });
  }
  const N = design.number;
  if (N?.text) {
    const style = N.style ?? (yr < 1973 ? "roundel" : yr < 1995 ? "panel" : "plain");
    const cands = [].concat(N.where ?? (yr < 1973 ? ["chassis", "sidepod", "engine_cover"] : yr < 1995 ? ["nose", "engine_cover"] : ["nose", "chassis"]));
    const ar = style === "plain" ? 0.62 * Math.max(1, N.text.length) : style === "panel" ? 1.25 : style === "oval" ? 1.3 : 1;
    let r = null;
    for (const c of cands) { const q = fit(c, ar); if (q && (!r || q[3] > r[3] * 1.15)) r = q; }
    if (r) {
      const cap = (yr <= 1972 ? 0.09 : yr <= 1994 ? 0.06 : 0.045) * w * (style === "plain" ? 0.8 : 1);
      if (r[3] > cap) { const k = cap / r[3]; r = [r[0] + (r[2] * (1 - k)) / 2, r[1] + (r[3] * (1 - k)) / 2, r[2] * k, r[3] * k]; }
      claim(r);
      if (style !== "plain") ops.push({ kind: "panel", shape: style, rect: r, color: N.panel ?? "#f4f4f4" });
      const box = D.number_panels[style] ?? [0, 0, 1, 1];
      const inner = [r[0] + box[0] * r[2], r[1] + box[1] * r[3], box[2] * r[2], box[3] * r[3]];
      if (style === "plain") inner.splice(0, 4, r[0], r[1], r[2], r[3]);
      ops.push({ kind: "digits", text: String(N.text), font: N.font ?? (yr < 1980 ? "classic" : "condensed"), rect: inner, color: N.digits ?? "#141414", contrast: style === "plain" ? N.panel ?? null : null });
    }
  }
  for (const sp of design.sponsors ?? []) {
    const g = D.decals[`sponsor:${sp.id}`]; if (!g) continue;
    const r = fit(sp.where ?? "sidepod", g.w / g.h); if (!r) continue;
    const k = sp.size ?? 0.86, rr = [r[0] + (r[2] * (1 - k)) / 2, r[1] + (r[3] * (1 - k)) / 2, r[2] * k, r[3] * k];
    claim(rr);
    ops.push({ kind: "glyph", key: `sponsor:${sp.id}`, rect: rr, color: sp.color ?? "#f4f4f4" });
  }
  return ops;
}
/** the emblem's bitmap size (for its aspect): a built-in shape or an uploaded image */
export function emblemShape(D, em) {
  if (em?.shape) return D?.shapes?.[em.shape] ?? null;
  return em?.img?.w && em.img.h && em.img.a ? em.img : null;
}
function erode(m, w, h) {
  const o = new Uint8Array(m.length);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; o[i] = m[i] && m[i - 1] && m[i + 1] && m[i - w] && m[i + w] ? 1 : 0; }
  return o;
}
