// The team livery editor (livery v2, gfx/livery2): element slots (main graphic, stripes, nose, tail, wings,
// pin-lines, pattern), number, sponsors, and an OKLCH colour picker with period swatch libraries. Pure functions
// over a design, like programme_ui.js: real_ui.js renders liveryHTML() and passes change/click events through
// liveryChange()/liveryAct(), which return the new design (or null when the event isn't theirs).
//
// ctx = { lv: design (v2), K: { kit, L } | null, year, role: "a".."d", thumb(year) -> data URL | "" }

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------- colour maths (OKLCH)
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4), toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const hx = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const toHex = (rgb) => "#" + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
export function hexToOklch(h) {
  const [r, g, b] = hx(h).map(toLin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}
function oklchToRgb(L, C, H) {
  const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(toSrgb);
}
const inGamut = (rgb) => rgb.every((v) => v >= -0.001 && v <= 1.001);
/** out-of-gamut colours keep lightness and hue and lose chroma */
export function oklchHex(L, C, H) {
  let lo = 0, hi = C;
  const rgb = oklchToRgb(L, C, H);
  if (inGamut(rgb)) return toHex(rgb);
  for (let k = 0; k < 18; k++) { const mid = (lo + hi) / 2; if (inGamut(oklchToRgb(L, mid, H))) lo = mid; else hi = mid; }
  return toHex(oklchToRgb(L, lo, H));
}
const relLum = (h) => { const [r, g, b] = hx(h).map(toLin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const x = relLum(a), y = relLum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const LIBS = [
  ["National racing colours", [["British racing green", "#0b3b24"], ["Rosso corsa", "#c8102e"], ["Bleu de France", "#1d4e9e"], ["German silver", "#c3c7cc"], ["German white", "#f2f2ee"], ["Belgian yellow", "#f2c300"], ["Dutch orange", "#f26a10"], ["American white & blue", "#1b3a8c"], ["Japanese ivory", "#f3efe4"], ["Hinomaru red", "#bc002d"], ["Swiss red", "#d52b1e"], ["Brazilian yellow", "#ffdf00"]]],
  ["Heritage paints", [["Powder blue", "#8fc3e6"], ["Tangerine", "#f07a1a"], ["Papaya", "#ff8000"], ["Old gold", "#c9a24a"], ["Ivory", "#efe9d8"], ["Navy", "#0b1f4b"], ["Racing teal", "#00a19b"], ["Cherry", "#a8122a"], ["Sky", "#2a8fd8"], ["Olive drab", "#55603a"], ["Cream", "#f4ead2"], ["Gunmetal", "#4a4f57"]]],
  ["Modern", [["Matte black", "#1b1d20"], ["Carbon grey", "#2d3035"], ["Volt", "#c6ff1a"], ["Flamingo", "#f59bc5"], ["Hot magenta", "#e0157a"], ["Ice", "#cfe9f5"], ["Electric blue", "#0057ff"], ["Lime", "#7ed321"], ["Ultraviolet", "#5b2bd6"], ["Copper", "#b5653a"], ["Signal red", "#ff2b2b"], ["Chalk", "#f5f5f2"]]],
];
function harmonies(h) {
  const [L, C, H] = hexToOklch(h), c = Math.max(C, 0.09);
  return [["Complement", oklchHex(Math.min(0.75, Math.max(0.45, L)), c, H + 180)], ["Analogous +", oklchHex(L, c, H + 32)], ["Analogous −", oklchHex(L, c, H - 32)],
    ["Triad", oklchHex(0.62, c, H + 120)], ["Triad", oklchHex(0.62, c, H + 240)], ["Split", oklchHex(0.6, c, H + 150)], ["Split", oklchHex(0.6, c, H + 210)]];
}
let recent = [];
try { recent = JSON.parse(globalThis.localStorage?.getItem("lv-recent") || "[]"); } catch { recent = []; }
const remember = (c) => { recent = [c, ...recent.filter((x) => x !== c)].slice(0, 12); try { globalThis.localStorage?.setItem("lv-recent", JSON.stringify(recent)); } catch {} };

// ---------------------------------------------------------------- the editor
export const ROLE_NAMES = { a: "Base", b: "Accent", c: "Trim", d: "Detail" };
const SLOT_LABEL = { body: "Main graphic", stripe: "Stripes", nose: "Nose", tail: "Tail", wings: "Wings", contour: "Pin-lines", pattern: "Pattern" };
const DEF_ROLE = { body: "b", stripe: "c", nose: "b", tail: "b", wings: "b", contour: "c", pattern: "c" };
const SPONSOR_SPOTS = ["sidepod", "engine_cover", "nose", "rear_wing", "chassis", "tail"];
export const PREVIEW_YEARS = [1925, 1955, 1967, 1978, 1988, 1998, 2010, 2024];

function roleBtns(lv, key, cur, extra = []) {
  return `<span class="lv-roles">${["a", "b", "c", "d", ...extra].map((r) => {
    const c = r.startsWith("#") ? r : lv.colors[r], name = r.startsWith("#") ? r : ROLE_NAMES[r];
    return `<button type="button" data-act="lvset" data-k="${key}" data-v="${r}" class="${r === cur ? "on" : ""}" style="background:${c};color:${contrast(c, "#000") > 7 ? "#000" : "#fff"}" title="${esc(name)}" aria-label="${esc(name)}">${r.startsWith("#") ? "" : r.toUpperCase()}</button>`;
  }).join("")}</span>`;
}

function pickerHTML(lv, role) {
  const cur = lv.colors[role], [L, C, H] = hexToOklch(cur);
  const track = (f) => `linear-gradient(90deg, ${Array.from({ length: 13 }, (_, k) => f(k / 12)).join(",")})`;
  const tracks = { L: track((t) => oklchHex(t, C, H)), C: track((t) => oklchHex(L, t * 0.37, H)), H: track((t) => oklchHex(L, Math.max(C, 0.05), t * 360)) };
  const shades = [0.22, 0.32, 0.42, 0.52, 0.62, 0.72, 0.82, 0.92].map((l) => oklchHex(l, C * (1 - Math.abs(l - 0.6) * 0.6), H));
  const sw = (list) => `<div class="lv-sw">${list.map(([n, c]) => `<button type="button" data-act="lvcolor" data-v="${c}" style="background:${c}" title="${esc(n)} ${c}" aria-label="${esc(n)} ${c}"></button>`).join("")}</div>`;
  const cr = contrast(cur, lv.colors.a);
  return `<div class="lv-roletabs" role="tablist">${Object.entries(ROLE_NAMES).map(([r, n]) => `<button type="button" role="tab" aria-selected="${r === role}" data-act="lvrole" data-v="${r}" class="${r === role ? "on" : ""}"><i style="background:${lv.colors[r]}"></i>${n}</button>`).join("")}</div>
    <div class="lv-sl"><b>L</b><input type="range" id="lvp-L" min="0" max="1" step="0.005" value="${L.toFixed(3)}" style="background:${tracks.L}" aria-label="Lightness"><output>${(L * 100).toFixed(0)}%</output></div>
    <div class="lv-sl"><b>C</b><input type="range" id="lvp-C" min="0" max="0.37" step="0.002" value="${C.toFixed(3)}" style="background:${tracks.C}" aria-label="Chroma"><output>${C.toFixed(3)}</output></div>
    <div class="lv-sl"><b>H</b><input type="range" id="lvp-H" min="0" max="360" step="1" value="${H.toFixed(0)}" style="background:${tracks.H}" aria-label="Hue"><output>${H.toFixed(0)}°</output></div>
    <div class="lv-hexrow"><label for="lvp-hex">Hex</label><input type="text" id="lvp-hex" value="${cur}" maxlength="7" spellcheck="false">
      <input type="color" id="lvp-native" value="${cur}" aria-label="System colour picker">
      ${role !== "a" ? `<span class="muted small" title="Contrast against the base colour; 3:1 or more reads well at speed">${cr.toFixed(1)}:1 on base${cr >= 3 ? "" : " · low contrast"}</span>` : ""}</div>
    <details class="lv-libs" open><summary>Swatches</summary>
      <h4>Shades of this colour</h4>${sw(shades.map((c) => ["Shade", c]))}
      <h4>Goes with ${esc(lv.colors.a)}</h4>${sw(harmonies(lv.colors.a))}
      ${LIBS.map(([n, list]) => `<h4>${n}</h4>${sw(list)}`).join("")}
      ${recent.length ? `<h4>Recent</h4>${sw(recent.map((c) => ["Recent", c]))}` : ""}</details>`;
}

function slotsHTML(lv, K) {
  const SL = K?.L?.SLOTS;
  let h = "";
  if (SL) for (const slot of Object.keys(SLOT_LABEL)) {
    const cfg = lv[slot] ?? { id: "none" }, opts = SL[slot], def = opts.find((o) => o.id === cfg.id) ?? opts[0];
    h += `<div class="lv-slot"><span class="lv-sname">${SLOT_LABEL[slot]}</span>
      <select id="lvs-${slot}" aria-label="${SLOT_LABEL[slot]}">${opts.map((o) => `<option value="${o.id}" ${o.id === def.id ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select>
      ${def.id !== "none" && def.id !== "match" ? roleBtns(lv, `${slot}.color`, cfg.color ?? DEF_ROLE[slot]) : ""}
      ${def.knobs.length ? `<div class="lv-knobs">${def.knobs.map(([k, label, mn, mx, stp, d]) => `<label>${esc(label)} <input type="range" id="lvk-${slot}-${k}" data-k="${slot}.${k}" min="${mn}" max="${mx}" step="${stp}" value="${cfg[k] ?? d}"></label>`).join("")}</div>` : ""}</div>`;
  }
  const N = lv.number ?? {};
  h += `<div class="lv-slot"><span class="lv-sname">Number</span>
    <input type="text" id="lvn-text" value="${esc(N.text ?? "")}" maxlength="2" style="width:48px" aria-label="Race number">
    <select id="lvn-style" aria-label="Number style">${[["roundel", "Roundel"], ["ring", "Ring"], ["panel", "Panel"], ["oval", "Oval"], ["plain", "Plain digits"]].map(([v, l]) => `<option value="${v}" ${v === (N.style ?? "roundel") ? "selected" : ""}>${l}</option>`).join("")}</select>
    <select id="lvn-font" aria-label="Digits">${["classic", "condensed", "modern"].map((v) => `<option ${v === (N.font ?? "classic") ? "selected" : ""}>${v}</option>`).join("")}</select>
    <div class="lv-knobs"><span>Panel ${roleBtns(lv, "number.panel", N.panel ?? "#f4f4f4", ["#f4f4f4", "#141414"])}</span>
    <span>Digits ${roleBtns(lv, "number.digits", N.digits ?? "#141414", ["#f4f4f4", "#141414"])}</span></div></div>`;
  h += emblemsHTML(lv, K);
  const sp = lv.sponsors ?? [], names = K?.kit?.decals?.sponsors ?? {}, ids = Object.keys(names).filter((k) => !k.endsWith("_box"));
  if (ids.length) {
    h += `<div class="lv-slot"><span class="lv-sname">Sponsors</span><div class="lv-sps">`;
    for (let i = 0; i < 3; i++) {
      const s = sp[i] ?? {};
      if (i > sp.length) break;
      h += `<div class="lv-sp"><select id="lvsp-${i}" aria-label="Sponsor ${i + 1}"><option value="">None</option>${ids.flatMap((k) => [k, k + "_box"]).map((k) => `<option value="${k}" ${k === s.id ? "selected" : ""}>${esc(names[k] ?? k)}${k.endsWith("_box") ? " (boxed)" : ""}</option>`).join("")}</select>
        ${s.id ? `<select id="lvspw-${i}" aria-label="Sponsor ${i + 1} position">${SPONSOR_SPOTS.map((r) => `<option value="${r}" ${r === (s.where ?? "sidepod") ? "selected" : ""}>${r.replace("_", " ")}</option>`).join("")}</select>${roleBtns(lv, `sponsors.${i}.color`, s.color ?? "#f4f4f4", ["#f4f4f4", "#141414"])}` : ""}</div>`;
    }
    h += `</div></div>`;
  }
  return h;
}

// ---------------------------------------------------------------- emblems (custom layer shapes)
const EMBLEM_SPOTS = ["sidepod", "engine_cover", "nose", "tail", "rear_wing", "chassis", "body"];
export const MAX_EMBLEMS = 3;
function emblemsHTML(lv, K) {
  const shapes = K?.kit?.decals?.shapes ?? {}, ems = lv.emblems ?? [];
  let h = `<div class="lv-slot"><span class="lv-sname">Emblems</span><div class="lv-sps">`;
  for (let i = 0; i <= Math.min(ems.length, MAX_EMBLEMS - 1); i++) {
    const e = ems[i] ?? {}, cur = e.shape ?? (e.img ? "__img" : "");
    h += `<div class="lv-sp"><select id="lvem-${i}" aria-label="Emblem ${i + 1}"><option value="">None</option>
        ${Object.entries(shapes).map(([k, v]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(v.name ?? k)}</option>`).join("")}
        ${e.img ? `<option value="__img" selected>Your image</option>` : ""}</select>
      <label class="btn lv-up" title="Any picture: its transparent or light parts are left out, the rest is painted in the emblem colour">Upload image…<input type="file" id="lvemf-${i}" accept="image/*" hidden></label>`;
    if (cur) {
      h += `${e.over ? "" : `<select id="lvemw-${i}" aria-label="Emblem ${i + 1} position">${EMBLEM_SPOTS.map((r) => `<option value="${r}" ${r === (e.where ?? "sidepod") ? "selected" : ""}>${r.replace("_", " ")}</option>`).join("")}</select>`}
        ${roleBtns(lv, `emblems.${i}.color`, e.color ?? "b", ["#f4f4f4", "#141414"])}
        <div class="lv-knobs"><label>Size <input type="range" id="lvems-${i}" min="0.2" max="1" step="0.05" value="${e.size ?? 0.85}"></label>
          ${e.over ? "" : `<label>Slide <input type="range" id="lvemx-${i}" min="-1" max="1" step="0.05" value="${e.dx ?? 0}"></label>`}
          <label><input type="checkbox" id="lvemr-${i}" ${e.flip ? "checked" : ""}> Mirror</label>
          ${i > 0 ? `<label><input type="checkbox" id="lvemo-${i}" ${e.over ? "checked" : ""}> On top of the one above</label>` : ""}</div>`;
    }
    h += `</div>`;
  }
  return h + `</div></div>`;
}

/** an image file -> an emblem mask {w, h, a}: its alpha if it has transparency, else its darkness (light = left out) */
export async function imageToMask(file, maxSide = 128) {
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const k = Math.min(1, maxSide / Math.max(im.naturalWidth, im.naturalHeight));
    const w = Math.max(1, Math.round(im.naturalWidth * k)), h = Math.max(1, Math.round(im.naturalHeight * k));
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const g = cv.getContext("2d", { willReadFrequently: true }); g.drawImage(im, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data, a = new Uint8Array(w * h);
    let transparent = 0;
    for (let i = 0; i < w * h; i++) if (px[i * 4 + 3] < 200) transparent++;
    const useAlpha = transparent > w * h * 0.05;
    let lo = 255, hi = 0;
    const lum = (i) => 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    if (!useAlpha) for (let i = 0; i < w * h; i++) { const l = lum(i); lo = Math.min(lo, l); hi = Math.max(hi, l); }
    for (let i = 0; i < w * h; i++) {
      a[i] = useAlpha ? px[i * 4 + 3] : Math.round(255 * Math.min(1, Math.max(0, (hi - lum(i)) / Math.max(1, hi - lo) * 1.15 - 0.08)));
    }
    let bin = ""; for (let i = 0; i < a.length; i++) bin += String.fromCharCode(a[i]);
    return { w, h, a: btoa(bin) };
  } finally { URL.revokeObjectURL(url); }
}

// a constructor's signature livery as a starting point (curated ones; the kit loads the list on first use)
function sigHTML(K, lv) {
  const S = K?.kit?.signatures;
  if (!S) { K?.L?.loadSignatures?.(K.kit).catch(() => {}); return ""; }
  const cur = S.filter((e) => e.source === "curated").sort((a, b) => a.name.localeCompare(b.name));
  return `<div class="lv-slot"><span class="lv-sname">Start from</span><select id="lvsig-0" aria-label="Start from a constructor's livery">
    <option value="">A constructor's livery…</option>${cur.map((e) => `<option value="${esc(e.key)}">${esc(e.name)} (${e.season})</option>`).join("")}</select>
    <span class="muted small">Keeps your number; colours and design come from that team's most characteristic season.</span></div>`;
}

/** the editor; without the kit (still loading) only the colours */
export function liveryHTML(ctx) {
  const { lv, K, year } = ctx, role = ctx.role ?? "a";
  const years = [...new Set([year, ...PREVIEW_YEARS])].sort((a, b) => a - b);
  const thumbs = K ? `<div class="rs-lvthumbs">${years.map((yy) => { const src = ctx.thumb(yy);
    return `<figure class="rs-lvf ${yy === year ? "on" : ""}">${src ? `<img alt="Your car in ${yy}" src="${src}">` : `<div class="rs-lvwait" aria-label="Painting the ${yy} car">…</div>`}<figcaption>${yy}</figcaption></figure>`; }).join("")}</div>` : "";
  return `<div class="rs-lv">${thumbs}
    <div class="lv-ed">
      <div class="lv-col"><h4>Colours</h4>${pickerHTML(lv, role)}</div>
      <div class="lv-col"><h4>Design</h4>${K ? slotsHTML(lv, K) : `<span class="muted small">The livery painter is still loading; until then the car is drawn in its base colour.</span>`}
        ${sigHTML(K, lv)}
        <div class="su-bar"><button class="btn" data-act="lvrandom" title="A period-correct livery for ${year}">Random period livery</button>
          <button class="btn" data-act="lvrandomkeep" title="A period design in your current colours">Random design, my colours</button></div>
        <span class="muted small">One livery follows your team through every era: the season picks the car, and the elements follow its shape.</span></div>
    </div></div>`;
}

function setPath(lv, path, val) {
  const ks = path.split("."); let o = lv;
  for (let i = 0; i < ks.length - 1; i++) { const k = /^\d+$/.test(ks[i]) ? +ks[i] : ks[i]; o[k] ??= /^\d+$/.test(ks[i + 1]) ? [] : {}; o = o[k]; }
  o[ks.at(-1)] = val;
}
const setColour = (lv, role, c) => { const d = clone(lv); d.colors[role] = c; remember(c); return d; };

/** a change event inside the editor -> the new design, or null if it isn't ours */
export function liveryChange(ctx, el) {
  const id = el.id ?? "", lv = ctx.lv, role = ctx.role ?? "a";
  if (!/^lv[a-z]*-/.test(id)) return null;
  if (id === "lvp-hex" || id === "lvp-native") { const v = el.value.trim().toLowerCase(); return /^#[0-9a-f]{6}$/.test(v) ? setColour(lv, role, v) : lv; }
  if (id.startsWith("lvp-")) {
    const root = el.closest?.(".lv-col") ?? el.parentElement?.parentElement, val = (k) => +(root?.querySelector?.(`#lvp-${k}`)?.value ?? 0);
    return setColour(lv, role, oklchHex(val("L"), val("C"), val("H")));
  }
  const d = clone(lv);
  if (id.startsWith("lvs-")) { const s = id.slice(4); d[s] = { id: el.value, ...(lv[s]?.color ? { color: lv[s].color } : {}) }; return d; }
  if (id.startsWith("lvk-")) { setPath(d, el.dataset.k, +el.value); return d; }
  if (id === "lvn-text") { const t = el.value.replace(/[^0-9]/g, "").slice(0, 2); d.number = { ...(d.number ?? {}), text: t }; return d; }
  if (id === "lvn-style") { d.number = { ...(d.number ?? {}), style: el.value }; return d; }
  if (id === "lvn-font") { d.number = { ...(d.number ?? {}), font: el.value }; return d; }
  if (id.startsWith("lvsp-")) {
    const i = +id.slice(5); d.sponsors ??= [];
    if (!el.value) d.sponsors.splice(i, 1); else d.sponsors[i] = { where: "sidepod", color: "#f4f4f4", ...(d.sponsors[i] ?? {}), id: el.value };
    d.sponsors = d.sponsors.filter(Boolean); return d;
  }
  if (id.startsWith("lvspw-")) { const i = +id.slice(6); if (d.sponsors?.[i]) d.sponsors[i].where = el.value; return d; }
  if (id === "lvsig-0") {
    const e = el.value && ctx.K?.L?.signatureOf?.(ctx.K.kit, el.value); if (!e) return null;
    const n = clone(e.livery); n.number = { ...(n.number ?? {}), ...(lv.number?.text ? { text: lv.number.text } : {}) };
    return n;
  }
  if (id.startsWith("lvemf-")) {                                   // uploaded image: async (a promise of the design)
    const i = +id.slice(6), f = el.files?.[0]; if (!f) return null;
    return imageToMask(f).then((img) => { const e = clone(lv); e.emblems ??= []; const old = e.emblems[i] ?? {};
      e.emblems[i] = { where: "sidepod", color: "b", size: 0.85, ...old, img }; delete e.emblems[i].shape; e.emblems = e.emblems.filter(Boolean); return e; })
      .catch(() => null);
  }
  const em = (i) => { d.emblems ??= []; return (d.emblems[i] ??= { where: "sidepod", color: "b", size: 0.85 }); };
  if (id.startsWith("lvem-")) {
    const i = +id.slice(5);
    if (!el.value) { d.emblems?.splice(i, 1); return d; }
    if (el.value === "__img") return lv;
    const e = em(i); e.shape = el.value; delete e.img; return d;
  }
  if (id.startsWith("lvemw-")) { em(+id.slice(6)).where = el.value; return d; }
  if (id.startsWith("lvems-")) { em(+id.slice(6)).size = +el.value; return d; }
  if (id.startsWith("lvemx-")) { em(+id.slice(6)).dx = +el.value; return d; }
  if (id.startsWith("lvemr-")) { em(+id.slice(6)).flip = !!el.checked; return d; }
  if (id.startsWith("lvemo-")) { em(+id.slice(6)).over = !!el.checked; return d; }
  return null;
}

/** a click on a data-act button in the editor -> {lv?, role?} or null */
export function liveryAct(ctx, a, ds) {
  if (a === "lvrole") return { role: ds.v };
  if (a === "lvcolor") return { lv: setColour(ctx.lv, ctx.role ?? "a", ds.v) };
  if (a === "lvset") { const d = clone(ctx.lv); setPath(d, ds.k, ds.v); return { lv: d }; }
  return null;
}
