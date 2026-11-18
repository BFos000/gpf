// Livery v2 renderer. Pure functions over typed arrays: runs in the browser (putImageData) and in node (QA renders).
// A template is a baked hand-annotated car (gfx/tools/livery2_bake.py). A livery is a stack of elements placed in the
// template's canonical frames, so one livery follows a team onto any car:
//   body frame  u: tail 0 .. rear axle .14 .. helmet .5 .. front axle .84 .. nose 1   (landmarks, not pixels)
//               v: top -1 .. belt (the car's shoulder line) 0 .. floor 1
//   part frame  pu, pv: 0..1 across the part's own box (wings, endplates)
// Regions name car parts; a part the car does not have falls back to where it would be (FALLBACK), so a sidepod
// stripe lands on the flank of a 1955 car and a rear-wing colour lands on its tail.
//
// livery = { colors: {a, b, c, d}, finish: "gloss" | "satin" | "matte" | "metallic",
//            layers: [ { type, color, where?, opacity?, ...params } ], decals: [...] }
// layer types (all optional "where": region or [regions], "mask": another shape layer to intersect with):
//   fill                                  the region
//   split   curve [[u,v]..], side above|below        one side of a curve running along the car
//   cut     curve [[v,u]..], side front|back         one side of a curve running across the car (diagonals, noses)
//   chevron u0, k, vc, side front|back, width?       a V across the car: u = u0 + k|v - vc|  (k<0 points to the nose)
//   stripe  curve [[u,v]..], width (v units)          a band following the car
//   cstripe curve [[v,u]..], width (u units)          a band across the car
//   contour width px, offset px                        pin-line tracing the region's edges (outline the contours)
//   pattern kind chequer|dots|pinstripe|hex|carbon|scales, scale (x body height), angle, color2?
//   fade    axis u|v|pu|pv, from, to                   opacity ramp

export const GROUPS = {
  body: ["body", "nose", "chassis", "cockpit", "sidepod", "engine_cover", "airbox", "tail", "headrest", "fin"],
  wings: ["front_wing", "rear_wing", "endplate"],
  all: null,
};
// where a part sits on cars that don't have one: [umin, umax, vmin, vmax] in the body frame
export const FALLBACK = {
  sidepod: [0.17, 0.47, -0.05, 1.01], engine_cover: [0.1, 0.47, -1.01, 0.02], airbox: [0.4, 0.5, -1.01, -0.35],
  cockpit: [0.47, 0.72, -1.01, 0.02], chassis: [0.5, 0.86, -0.05, 1.01], nose: [0.84, 1.01, -1.01, 1.01],
  tail: [-0.01, 0.14, -1.01, 1.01], rear_wing: [-0.01, 0.07, -1.01, 0.2], front_wing: [0.93, 1.01, 0.35, 1.01],
  headrest: [0.43, 0.5, -1.01, -0.2], fin: [0.05, 0.3, -1.01, -0.6],
};

const b64 = (s) => (typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(s, "base64")) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

export function loadTemplate(json) {
  const { meta, data } = json, n = meta.w * meta.h, d = {};
  const raw = (x) => (typeof x === "string" ? b64(x) : x);       // base64 (baked JSON) or bytes (packed season)
  for (const k of ["part", "cov", "pu", "pv", "dpart", "dsil", "shade", "spec", "line", "fix"]) if (data[k]) d[k] = raw(data[k]);
  for (const k of ["u", "v"]) { let b = raw(data[k]); if (b.byteOffset % 2) b = b.slice(); d[k] = new Uint16Array(b.buffer, b.byteOffset, n); }
  const T = { meta, ...d, n, w: meta.w, h: meta.h, regions: new Map(), dist: new Map() };
  T.U = new Float32Array(n); T.V = new Float32Array(n); T.PU = new Float32Array(n); T.PV = new Float32Array(n);
  for (let i = 0; i < n; i++) { T.U[i] = d.u[i] / 65535; T.V[i] = d.v[i] / 32767.5 - 1; T.PU[i] = d.pu[i] / 255; T.PV[i] = d.pv[i] / 255; }
  // anti-aliasing widths: how far u and v move per pixel here
  T.eu = new Float32Array(n); T.ev = new Float32Array(n);
  const { w, h } = T;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, xr = x < w - 1 ? i + 1 : i - 1, yd = y < h - 1 ? i + w : i - w;
    T.eu[i] = Math.max(1e-4, Math.abs(T.U[xr] - T.U[i]) + Math.abs(T.U[yd] - T.U[i]));
    const dv = Math.abs(T.V[yd] - T.V[i]) + Math.abs(T.V[xr] - T.V[i]);
    T.ev[i] = dv > 0.25 || dv < 1e-4 ? 0.04 : dv;
  }
  // body height (px, belt to floor and top to belt) for pattern scale
  T.bodyH = Math.max(12, ...Object.entries(meta.bbox).filter(([k]) => GROUPS.body.includes(k)).map(([, b]) => b[3] - b[1])) ;
  T.__region = (where) => region(T, where);
  return T;
}

/** 0/1 mask for a region name, group name or list, with fallbacks for parts the car lacks */
export function region(T, where) {
  const key = Array.isArray(where) ? where.join("+") : where ?? "all";
  if (T.regions.has(key)) return T.regions.get(key);
  const m = new Uint8Array(T.n), names = T.meta.parts;
  const list = Array.isArray(where) ? where : [where ?? "all"];
  for (const r of list) {
    if (r === "all") { for (let i = 0; i < T.n; i++) if (T.part[i]) m[i] = 1; continue; }
    if (GROUPS[r]) { const ids = new Set(GROUPS[r].map((p) => names.indexOf(p))); for (let i = 0; i < T.n; i++) if (ids.has(T.part[i])) m[i] = 1; continue; }
    const id = names.indexOf(r);
    if (T.meta.present.includes(r)) { for (let i = 0; i < T.n; i++) if (T.part[i] === id) m[i] = 1; }
    else if (FALLBACK[r]) {
      const [u0, u1, v0, v1] = FALLBACK[r], body = new Set(GROUPS.body.map((p) => names.indexOf(p)));
      for (let i = 0; i < T.n; i++) if (body.has(T.part[i]) && T.U[i] >= u0 && T.U[i] <= u1 && T.V[i] >= v0 && T.V[i] <= v1) m[i] = 1;
    }
  }
  T.regions.set(key, m);
  return m;
}

/** distance (px) to the edge of a region, inside it (two-pass chamfer, cached) */
function regionDist(T, where) {
  const key = Array.isArray(where) ? where.join("+") : where ?? "all";
  if (T.dist.has(key)) return T.dist.get(key);
  const m = region(T, where), { w, h } = T, D = new Float32Array(T.n), INF = 1e9, a = 1, b = Math.SQRT2;
  for (let i = 0; i < T.n; i++) D[i] = m[i] ? INF : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!D[i]) continue;
    let v = D[i];
    if (x > 0) v = Math.min(v, D[i - 1] + a); else v = Math.min(v, a);
    if (y > 0) { v = Math.min(v, D[i - w] + a); if (x > 0) v = Math.min(v, D[i - w - 1] + b); if (x < w - 1) v = Math.min(v, D[i - w + 1] + b); } else v = Math.min(v, a);
    D[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; if (!D[i]) continue;
    let v = D[i];
    if (x < w - 1) v = Math.min(v, D[i + 1] + a); else v = Math.min(v, a);
    if (y < h - 1) { v = Math.min(v, D[i + w] + a); if (x < w - 1) v = Math.min(v, D[i + w + 1] + b); if (x > 0) v = Math.min(v, D[i + w - 1] + b); } else v = Math.min(v, a);
    D[i] = v;
  }
  T.dist.set(key, D);
  return D;
}

// monotone piecewise-linear curve through points, sampled at x
function curveAt(pts, x) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let k = 1; k < pts.length; k++) if (x <= pts[k][0]) {
    const [x0, y0] = pts[k - 1], [x1, y1] = pts[k], t = (x - x0) / Math.max(1e-6, x1 - x0);
    const s = t * t * (3 - 2 * t);                          // smoothstep between knots: soft corners
    return y0 + (y1 - y0) * (0.5 * t + 0.5 * s);
  }
  return pts[pts.length - 1][1];
}
const step = (d, e) => clamp(d / e + 0.5);                  // anti-aliased step: d = signed distance in units of e

function shapeAlpha(L, T, i, x, y) {
  const u = T.U[i], v = T.V[i], eu = T.eu[i] * 1.2, ev = T.ev[i] * 1.2;
  switch (L.type) {
    case "fill": return 1;
    case "split": { const c = curveAt(L.curve, u), d = v - c; return step(L.side === "above" ? -d : d, ev); }
    case "cut": { const c = curveAt(L.curve, v), d = u - c; return step(L.side === "back" ? -d : d, eu); }
    case "chevron": {
      const c = L.u0 + L.k * Math.abs(v - (L.vc ?? 0.2)), d = L.side === "back" ? c - u : u - c;
      return L.width ? step(d, eu) * step(L.width - d, eu) : step(d, eu);
    }
    case "stripe": { const c = curveAt(L.curve, u), d = L.width / 2 - Math.abs(v - c); return step(d, ev); }
    case "cstripe": { const c = curveAt(L.curve, v), d = L.width / 2 - Math.abs(u - c); return step(d, eu); }
    case "contour": {
      const D = regionDist(T, L.where ?? "body")[i], o = L.offset ?? 0;
      return clamp(D - o + 0.5) * clamp(o + (L.width ?? 1.2) - D + 0.5);
    }
    case "fade": {
      const val = L.axis === "u" ? u : L.axis === "v" ? v : L.axis === "pu" ? T.PU[i] : T.PV[i];
      return clamp((val - L.from) / (L.to - L.from));
    }
    case "pattern": {
      const s = (L.scale ?? 0.12) * T.bodyH, an = ((L.angle ?? 0) * Math.PI) / 180;
      const X = (x * Math.cos(an) + y * Math.sin(an)) / s, Y = (-x * Math.sin(an) + y * Math.cos(an)) / s;
      switch (L.kind) {
        case "chequer": return (Math.floor(X) + Math.floor(Y)) & 1 ? 1 : 0;
        case "pinstripe": { const f = X - Math.floor(X); return f < (L.duty ?? 0.22) ? 1 : 0; }
        case "dots": { const fx = X - Math.round(X), fy = Y - Math.round(Y); return clamp(((L.r ?? 0.3) - Math.hypot(fx, fy)) * s + 0.5); }
        case "hex": { const q = X * 1.1547, r = Y - X * 0.57735, f = (a) => Math.abs(a - Math.round(a)); return Math.min(f(q), f(r), f(q + r)) < 0.08 ? 1 : 0; }
        case "carbon": { const a = (Math.floor(X * 2) + Math.floor(Y * 2)) & 1, t = a ? X * 2 - Math.floor(X * 2) : Y * 2 - Math.floor(Y * 2); return 0.25 + 0.5 * Math.sin(t * Math.PI); }
        case "scales": { const row = Math.floor(Y), ox = row & 1 ? 0.5 : 0, fx = X + ox - Math.floor(X + ox) - 0.5, fy = Y - row; return Math.hypot(fx, fy) > 0.5 && Math.hypot(fx, fy) < 0.62 ? 1 : 0; }
      }
      return 0;
    }
  }
  return 0;
}

function layerAlpha(L, T, i, x, y) {
  let a = shapeAlpha(L, T, i, x, y);
  if (a > 0 && L.mask) for (const M of [].concat(L.mask)) { a *= shapeAlpha(M, T, i, x, y) ; if (!a) break; }
  return a * (L.opacity ?? 1);
}

const FINISH = { gloss: [1.0, 0.75, 0], satin: [1.0, 0.35, 0], matte: [0.92, 0.08, 0], metallic: [1.12, 0.9, 1] };

/** render -> {w, h, rgba: Uint8ClampedArray}. opts.view: "paint" | "albedo" | "parts" | "shade" | "frame" */
export function render(T, lv, opts = {}) {
  const { w, h, n } = T, out = new Uint8ClampedArray(n * 4), view = opts.view ?? "paint";
  const col = (c) => hex(c?.startsWith?.("#") ? c : lv.colors[c] ?? "#ff00ff");
  const layers = (lv.layers ?? []).map((L) => ({ L, c: col(L.color), c2: L.color2 ? col(L.color2) : null, reg: L.where ? region(T, L.where) : null }));
  const [kd, ks, km] = FINISH[lv.finish ?? "gloss"];
  const alb = new Float32Array(n * 3);
  const base = col(lv.colors.a ? "a" : "#808080");
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!T.part[i]) continue;
    let r = base[0], g = base[1], b = base[2];
    for (const { L, c, c2, reg } of layers) {
      if (reg && !reg[i]) continue;
      let a = layerAlpha(L, T, i, x, y);
      if (L.type === "pattern" && c2) { const t = a; a = L.opacity ?? 1; const cc = [c2[0] + (c[0] - c2[0]) * t, c2[1] + (c[1] - c2[1]) * t, c2[2] + (c[2] - c2[2]) * t]; r += (cc[0] - r) * a; g += (cc[1] - g) * a; b += (cc[2] - b) * a; continue; }
      if (a > 0) { r += (c[0] - r) * a; g += (c[1] - g) * a; b += (c[2] - b) * a; }
    }
    alb[i * 3] = r; alb[i * 3 + 1] = g; alb[i * 3 + 2] = b;
  }
  const dcov = opts.decals && lv.decalOps?.length ? applyDecals(alb, T, lv.decalOps, opts.decals, col) : null;   // rigid, under the shading
  const PC = [[0,0,0],[200,200,200],[230,80,80],[240,150,60],[90,170,240],[240,220,90],[120,210,120],[200,120,230],[250,120,180],[120,230,220],[230,120,60],[160,120,240],[100,100,100],[180,180,90],[90,90,200],[200,90,140],[255,255,255]];
  for (let i = 0; i < n; i++) {
    const o = i * 4, f = T.fix, fa = f[o + 3] / 255, cov = T.part[i] ? T.cov[i] / 255 : 0;
    let r = f[o], g = f[o + 1], b = f[o + 2];
    if (cov > 0) {
      let pr = alb[i * 3], pg = alb[i * 3 + 1], pb = alb[i * 3 + 2];
      if (view === "parts") { const c = PC[T.part[i] % PC.length]; [pr, pg, pb] = c; }
      if (view === "frame") { pr = (Math.floor(T.U[i] * 20) & 1) ? 230 : 120; pg = 128 + T.V[i] * 120; pb = Math.abs(T.V[i]) < 0.03 ? 255 : 60; }
      if (view === "shade") { pr = pg = pb = 200; }
      if (view === "paint" || view === "shade" || view === "parts") {
        const sh = T.shade[i] / 128, sp = T.spec[i] / 255, ln = (T.line[i] / 255) * (dcov ? 1 - 0.9 * dcov[i] : 1);
        const lumA = (pr * 0.3 + pg * 0.59 + pb * 0.11) / 255;
        const D = kd * (1 + (sh - 1) * (1 + 0.6 * km));                       // metallic: stronger falloff
        const S = ks * sp * (km ? 0.6 + 0.4 * lumA : 1) * (0.55 + 0.45 * (1 - lumA * 0.5));
        const sc = km ? [pr, pg, pb].map((v) => v * 0.6 + 255 * 0.4) : [255, 255, 255];
        pr = pr * D * (1 - 0.8 * ln) + sc[0] * S * (1 - ln); pg = pg * D * (1 - 0.8 * ln) + sc[1] * S * (1 - ln); pb = pb * D * (1 - 0.8 * ln) + sc[2] * S * (1 - ln);
      }
      const ta = cov + fa * (1 - cov);
      r = (pr * cov + r * fa * (1 - cov)) / ta; g = (pg * cov + g * fa * (1 - cov)) / ta; b = (pb * cov + b * fa * (1 - cov)) / ta;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = ta * 255;
    } else { out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = f[o + 3]; }
  }
  return { w, h, rgba: out };
}

// ------------------------------------------------------------------ decal stage
const glyphCache = new Map();
function glyph(D, key) {
  if (!glyphCache.has(key)) { const g = D.decals[key]; glyphCache.set(key, g ? { w: g.w, h: g.h, a: b64(g.a) } : null); }
  return glyphCache.get(key);
}
function digitsBitmap(D, text, font) {
  const parts = [...text].map((ch) => glyph(D, `digit:${font}:${ch}`)).filter(Boolean);
  if (!parts.length) return null;
  const ov = 4, W = parts.reduce((a, p) => a + p.w, 0) - ov * (parts.length - 1), H = Math.max(...parts.map((p) => p.h)), a = new Uint8Array(W * H);
  let x0 = 0;
  for (const p of parts) { for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) { const i = y * W + x0 + x; a[i] = Math.max(a[i], p.a[y * p.w + x]); } x0 += p.w - ov; }
  return { w: W, h: H, a };
}
// custom layer shapes: a built-in silhouette or an uploaded image ({w, h, a}), optionally mirrored
const emblemCache = new Map();
function emblemBitmap(D, op) {
  const src = op.shape ? D.shapes?.[op.shape] : op.img;
  if (!src?.a) return null;
  const key = (op.shape ? `s:${op.shape}` : `i:${src.w}x${src.h}:${src.a.length}:${src.a.slice(0, 64)}:${src.a.slice(-64)}`) + (op.flip ? ":f" : "");
  if (!emblemCache.has(key)) {
    const a = b64(src.a), o = new Uint8Array(a.length);
    for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) o[y * src.w + x] = a[y * src.w + (op.flip ? src.w - 1 - x : x)];
    emblemCache.set(key, { w: src.w, h: src.h, a: o });
    if (emblemCache.size > 64) emblemCache.delete(emblemCache.keys().next().value);
  }
  return emblemCache.get(key);
}
function trim(g) {               // crop a bitmap to its ink so it fills the slot it is fitted to
  let x0 = g.w, y0 = g.h, x1 = -1, y1 = -1;
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (g.a[y * g.w + x] > 20) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 < 0) return g;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = g.a[(y + y0) * g.w + x + x0];
  return { w, h, a };
}
function stamp(alb, T, g, rect, c, fit = true, cov = null) {
  let [rx, ry, rw, rh] = rect;
  if (fit) { const k = Math.min(rw / g.w, rh / g.h), dw = g.w * k, dh = g.h * k; rx += (rw - dw) / 2; ry += (rh - dh) / 2; rw = dw; rh = dh; }
  const sx = g.w / rw, sy = g.h / rh;
  for (let y = Math.max(0, Math.floor(ry)); y < Math.min(T.h, Math.ceil(ry + rh)); y++) for (let x = Math.max(0, Math.floor(rx)); x < Math.min(T.w, Math.ceil(rx + rw)); x++) {
    const i = y * T.w + x; if (!T.part[i]) continue;
    // box-filtered sample of the glyph footprint under this pixel (glyphs are big, pixels small)
    const gx0 = (x - rx) * sx, gy0 = (y - ry) * sy; let acc = 0, cnt = 0;
    for (let yy = 0; yy < 3; yy++) for (let xx = 0; xx < 3; xx++) {
      const gx = Math.floor(gx0 + ((xx + 0.5) / 3) * sx), gy = Math.floor(gy0 + ((yy + 0.5) / 3) * sy);
      cnt++; if (gx >= 0 && gy >= 0 && gx < g.w && gy < g.h) acc += g.a[gy * g.w + gx];
    }
    const a = acc / cnt / 255; if (a <= 0) continue;
    if (cov) cov[i] = Math.max(cov[i], a);
    for (let k = 0; k < 3; k++) alb[i * 3 + k] += (c[k] - alb[i * 3 + k]) * a;
  }
}
function applyDecals(alb, T, ops, D, col) {
  const cov = new Float32Array(T.n);
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  for (const op of ops) {
    let c = col(op.color);
    if (op.kind === "digits" && op.contrast) {                  // bare digits: keep them readable on whatever paint is beneath
      const [rx, ry, rw, rh] = op.rect; let s = [0, 0, 0], m = 0;
      for (let y = Math.max(0, Math.floor(ry)); y < Math.min(T.h, ry + rh); y++) for (let x = Math.max(0, Math.floor(rx)); x < Math.min(T.w, rx + rw); x++) {
        const i = y * T.w + x; if (!T.part[i] || cov[i] > 0.5) continue; for (let k = 0; k < 3; k++) s[k] += alb[i * 3 + k]; m++;
      }
      if (m) {
        const L = lum(s.map((v) => v / m));
        if (Math.abs(lum(c) - L) < 70) {
          const opts = [op.contrast, "#f4f4f4", "#141414"].filter(Boolean).map(col);
          c = opts.reduce((a, b) => (Math.abs(lum(b) - L) > Math.abs(lum(a) - L) + 20 ? b : a));
        }
      }
    }
    if (op.kind === "panel") {
      const [rx, ry, rw, rh] = op.rect, cx = rx + rw / 2, cy = ry + rh / 2;
      for (let y = Math.max(0, Math.floor(ry - 1)); y < Math.min(T.h, ry + rh + 1); y++) for (let x = Math.max(0, Math.floor(rx - 1)); x < Math.min(T.w, rx + rw + 1); x++) {
        const i = y * T.w + x; if (!T.part[i]) continue;
        let d;                                                    // signed distance (px, + inside)
        const dx = Math.abs(x + 0.5 - cx), dy = Math.abs(y + 0.5 - cy);
        if (op.shape === "panel") { const r = Math.min(rw, rh) * 0.18, qx = dx - (rw / 2 - r), qy = dy - (rh / 2 - r); d = r - (Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0)); }
        else { const ex = rw / 2, ey = rh / 2, q = Math.hypot(dx / ex, dy / ey); d = (1 - q) * Math.min(ex, ey); if (op.shape === "ring") d = Math.min(d, q - 0.8 > 0 ? d : (q - 0.8) * Math.min(ex, ey)); }
        const a = clamp(d + 0.5); if (a <= 0) continue;
        cov[i] = Math.max(cov[i], a);
        for (let k = 0; k < 3; k++) alb[i * 3 + k] += (c[k] - alb[i * 3 + k]) * a;
      }
    } else if (op.kind === "digits") { const g = digitsBitmap(D, op.text, op.font); if (g) stamp(alb, T, trim(g), op.rect, c, true, cov); }
    else if (op.kind === "glyph") { const g = glyph(D, op.key); if (g) stamp(alb, T, trim(g), op.rect, c, true, cov); }
    else if (op.kind === "custom") { const g = emblemBitmap(D, op); if (g) stamp(alb, T, g, op.rect, c, true, cov); }
  }
  return cov;                                                    // decal coverage: panel lines fade underneath
}
