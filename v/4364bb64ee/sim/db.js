// Game database helpers: indexes, era lookups, population skill means.
export const SKILLS = ["pace", "quali", "starts", "deg", "consistency", "wet", "errors", "attack", "defence"];
const SYNTH_ERAS = [["turbo_1982_1993", 1900, 1993], ["refuel_1994_2009", 1994, 2009], ["modern_2010_2024", 2010, 2100]];

export function indexDb(db) {
  if (db._ix) return db;
  const drivers = new Map(db.drivers.map((d) => [d.id, d]));
  const cars = new Map(db.cars.map((c) => [c.id, c]));
  const circuits = new Map(db.circuits.map((c) => [c.ref, c]));
  const races = new Map(db.races.map((r) => [r.id, r]));
  // population mean of each skill over all driver-seasons: an average driver gets the era default
  const pop = {};
  for (const k of SKILLS) {
    let s = 0, n = 0;
    for (const d of db.drivers) for (const ss of Object.values(d.seasons)) {
      const v = ss.skills[k]; if (v) { s += v[0]; n++; }
    }
    pop[k] = n ? s / n : 0;
  }
  db._ix = { drivers, cars, circuits, races, pop };
  return db;
}

export function synthEra(db, year) {
  const e = (SYNTH_ERAS.find(([, lo, hi]) => year >= lo && year <= hi)              // before 1950: the earliest era
    ?? [...SYNTH_ERAS].sort((a, b) => a[1] - b[1])[year < 1950 ? 0 : SYNTH_ERAS.length - 1])[0];
  return db.eras.synth[e];
}

export function overtakingEra(db, year) {
  const ot = db.eras.overtaking;
  // before 1950 (pre-war races): the earliest era's passing model
  const name = (Object.entries(ot.bounds).find(([, [lo, hi]]) => year >= lo && year <= hi)
    ?? Object.entries(ot.bounds).sort((x, y) => x[1][0] - y[1][0])[0])[0];
  return { ...ot.eras[name], b_gap: ot.b_gap, gap_ref: ot.gap_ref, min_gap: ot.min_gap[name] ?? 0.3,
           attack_gap: ot.attack_gap, name };
}

export function layoutFor(circuit, year, key) {
  if (key) { const l = circuit.layouts.find((x) => x.key === key); if (l) return l; }
  const inYear = circuit.layouts.find((x) => year >= x.years[0] && year <= x.years[1]);
  if (inYear) return inYear;
  return circuit.layouts.reduce((a, b) => (b.years[1] > a.years[1] ? b : a));   // latest layout
}

// nearest year present in a {year: value} map (for stop distributions / speed years)
export function nearestYear(map, year) {
  const ys = Object.keys(map).map(Number);
  return ys.reduce((a, b) => (Math.abs(b - year) < Math.abs(a - year) ? b : a));
}
