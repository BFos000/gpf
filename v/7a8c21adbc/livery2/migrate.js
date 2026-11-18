// v1 livery specs (gfx/liveries: {scheme, colors: {base, c2, c3, wheel}, number, number_style, number_colors,
// digit_font, sponsors: [{decal, slot, color}]}) -> v2 element designs (elements.js). No dependencies, so the save
// code (game/web/real.js) can use it without the renderer. A v2 design ({v: 2, ...}) passes through unchanged.
// v1 scheme -> v2 slots (colour roles: v1 base/c2/c3 = v2 a/b/c)
const SCHEME_MAP = {
  solid: {},
  nose_band: { nose: { id: "band" } },
  radiator: { nose: { id: "whole" }, tail: { id: "cap" } },
  centre_stripe: { stripe: { id: "single", color: "b" } },
  top_stripe: { stripe: { id: "deck", color: "b" } },
  le_mans: { stripe: { id: "twin", color: "b" } },
  lower_split: { body: { id: "lower" } },
  front_rear: { body: { id: "front_half" } },
  arrow: { body: { id: "arrow" } },
  chevron_top: { nose: { id: "chevron" } },
  tri_stripe: { stripe: { id: "tricolore" } },
  coachline: { stripe: { id: "coachline", color: "c" } },
  nose_sash: { body: { id: "sash" } },
  three_tier: { body: { id: "upper" }, stripe: { id: "single", color: "c" } },
  swoosh: { body: { id: "swoosh" } },
  rising_sweep: { body: { id: "rising" } },
  chequer: { tail: { id: "chequer", color: "#151515" } },
};
const SLOT_MAP = { side: "sidepod", top: "engine_cover", tail: "tail", rear_wing: "rear_wing", nose: "nose" };
export const SCHEMES = Object.keys(SCHEME_MAP);

export function migrate(lv) {
  if (!lv) return null;
  if (lv.v === 2) return lv;
  const c = lv.colors ?? {}, a = c.base ?? "#2a7fff";
  const d = { v: 2, colors: { a, b: c.c2 ?? a, c: c.c3 ?? c.c2 ?? a, d: "#141414" }, finish: "gloss",
    ...structuredClone(SCHEME_MAP[lv.scheme] ?? {}) };
  if (lv.number) {
    const nc = lv.number_colors ?? ["#f4f4f4", "#141414"];
    d.number = { text: String(lv.number), style: lv.number_style ?? "roundel", panel: nc[0], digits: nc[1], font: lv.digit_font ?? "classic" };
  }
  d.sponsors = (lv.sponsors ?? []).filter((s) => s.decal).map((s) => ({ id: s.decal, where: SLOT_MAP[s.slot] ?? "sidepod", color: s.color ?? "#ffffff" }));
  return d;
}
/** the two team colours of a livery (either version) */
export const teamColours = (lv) => { const d = migrate(lv); return d ? [d.colors.a, d.colors.b ?? d.colors.a] : null; };

