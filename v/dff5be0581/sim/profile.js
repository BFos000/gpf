// A track's speed profile for the race's era (docs/GAME_PLAN.md section 17): where along the lap a car is at a given
// fraction of its lap time. The track files carry a point-mass lap with modern constants (f1rank/gamedb/tracks.py);
// here it is recomputed with the period's grip, braking, top speed and power, and the gradient where the track has
// heights (climbs slow a car that is power-limited, descents lengthen its braking). Only the SHAPE is used: the
// sim scales it to the lap time. The sim (sectors, passing zones), the playback (position on the map) and the map
// (sector ticks) all take the same era track, so they agree.
//   eraTrack(track, year) -> a track copy with v, t, sectors, zones for that year (memoised; idempotent)

const G = 9.81;
// [year, lateral grip g, braking g, top speed m/s, low-speed acceleration m/s^2] (period cars, rough)
const ERA = [
  [1900, 0.70, 0.40, 36, 1.6],
  [1906, 0.75, 0.45, 42, 2.0],
  [1914, 0.80, 0.50, 47, 2.5],
  [1925, 0.90, 0.55, 56, 3.0],
  [1934, 1.00, 0.60, 75, 4.0],
  [1939, 1.05, 0.65, 80, 5.0],
  [1950, 1.05, 0.70, 72, 4.5],
  [1958, 1.15, 0.90, 75, 5.0],
  [1966, 1.40, 1.10, 80, 7.0],
  [1970, 1.80, 1.40, 83, 8.0],
  [1978, 2.60, 2.50, 85, 9.0],
  [1983, 3.00, 3.50, 88, 11.0],
  [1990, 3.20, 4.00, 90, 12.0],
  [2005, 3.80, 4.50, 92, 14.0],
];
const MIN_R = 12;                       // radii below this are digitising noise

export function eraParams(year) {
  const y = Math.max(ERA[0][0], Math.min(ERA.at(-1)[0], year ?? ERA.at(-1)[0]));
  let k = 0;
  while (k < ERA.length - 2 && ERA[k + 1][0] <= y) k++;
  const a = ERA[k], b = ERA[k + 1], w = Math.min(1, Math.max(0, (y - a[0]) / (b[0] - a[0])));
  const m = (j) => a[j] + (b[j] - a[j]) * w;
  return { lat: m(1) * G, brake: m(2) * G, vmax: m(3), a0: m(4) };
}

/** relative speed at each sample: grip-limited cornering, power/drag-limited acceleration less the climb, braking
 *  limit plus the climb (periodic lap) */
export function speedProfile(k, step, p, z = null) {
  const n = k.length;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = Math.min(Math.sqrt(p.lat * Math.max(1 / Math.max(Math.abs(k[i]), 1e-9), MIN_R)), p.vmax);
  const slope = (a, b) => (z ? (z[b] - z[a]) / step : 0);          // rise over run from sample a to b
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < 2 * n; i++) {                                // acceleration (forward)
      const a = (i - 1) % n, b = i % n;
      const acc = p.a0 * Math.max(1 - v[a] / p.vmax, 0) - G * slope(a, b);
      v[b] = Math.min(v[b], Math.sqrt(Math.max(1, v[a] ** 2 + 2 * acc * step)));
    }
    for (let i = 2 * n - 1; i > 0; i--) {                            // braking (backward)
      const a = i % n, b = (i - 1) % n;
      const dec = Math.max(0.2 * p.brake, p.brake + G * slope(b, a));
      v[b] = Math.min(v[b], Math.sqrt(v[a] ** 2 + 2 * dec * step));
    }
  }
  return v;
}

/** local speed minima after a drop of at least minDrop m/s: where passes are placed */
export function brakingZones(v, minDrop) {
  const n = v.length, zones = [];
  for (let i = 0; i < n; i++) {
    const prev = v[(i - 1 + n) % n], next = v[(i + 1) % n];
    if (v[i] <= prev && v[i] < next) {
      let j = i;
      while (v[((j - 1) % n + n) % n] > v[((j % n) + n) % n] && i - j < n) j--;
      const drop = v[((j % n) + n) % n] - v[i];
      if (drop >= minDrop) zones.push({ start: ((j % n) + n) % n, apex: i, drop: Math.round(drop * 10) / 10 });
    }
  }
  return zones;
}

const cache = new WeakMap();
export function eraTrack(track, year) {
  if (!track || !track.k?.length || track._era === year) return track;
  let byYear = cache.get(track);
  if (!byYear) cache.set(track, (byYear = new Map()));
  if (byYear.has(year)) return byYear.get(year);
  const p = eraParams(year);
  const n = track.k.length, step = track.step_m;
  const z = Array.isArray(track.z) && track.z.length === n ? track.z : null;
  const v = speedProfile(track.k, step, p, z);
  const t = new Array(n);
  let acc = 0, tot = 0;
  for (let i = 0; i < n; i++) tot += step / v[i];
  for (let i = 0; i < n; i++) { t[i] = acc / tot; acc += step / v[i]; }
  const sec = [1 / 3, 2 / 3].map((f) => { let i = 0; while (i < n - 1 && t[i] < f) i++; return i; });
  const vmax = Math.max(...v);
  const zones = brakingZones(v, 0.089 * p.vmax);
  // (an oval or a flat-out lap has no braking zone of that size: keep the file's, so passes have their places)
  const out = { ...track, v: Array.from(v, (x) => x / vmax), t, sectors: sec, zones: zones.length ? zones : track.zones,
                sim_lap_s: tot, _era: year };
  byYear.set(year, out);
  return out;
}
