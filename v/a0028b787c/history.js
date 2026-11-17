// Historical race reconstructions (docs/GAME_PLAN.md section 17): a real race record (output/gamedb/history/<id>.json,
// built by f1rank/history) turned into a sim config whose laps are forced from the record (race.js config.replay).
// A strategy call at lap L ends the replay at L - 1 (the take-over); the sim races on from there.
// Pure functions: run in the browser and in Node (game/tools/history_check.mjs).

/** the record's cars as sim entries, in grid order (pit-lane starters, grid 0, at the back). Returns
 *  { entries, idx } with idx[k] = the entry index of record car k (null when the game db lacks the driver / car) */
export function historyEntries(db, race, rec) {
  db = withExtras(db, rec);
  const carOf = new Map((race?.grid ?? []).map(([d, car]) => [String(d), car]));
  for (const c of rec.cars) if (c.car) carOf.set(String(c.d), c.car);            // the record's own car ids win
  const drivers = new Map(db.drivers.map((d) => [String(d.id), d]));
  const order = rec.cars.map((c, k) => k).sort((a, b) => (rec.cars[a].grid || 99) - (rec.cars[b].grid || 99) || rec.cars[a].pos - rec.cars[b].pos);
  const entries = [], idx = rec.cars.map(() => null), missing = [];
  for (const k of order) {
    const c = rec.cars[k], car = carOf.get(String(c.d));
    if (!car || !drivers.get(String(c.d))) { missing.push(c.d); continue; }
    idx[k] = entries.length;
    entries.push({ driver: c.d, season: rec.year, car });
  }
  return { entries, idx, missing };
}

/** the game db with a record's extra drivers and cars (entries the game db lacks: 1950s privateers), cached per
 *  record; the base db is returned untouched when there are none */
const extrasCache = new WeakMap();
export function withExtras(db, rec) {
  const x = rec?.x;
  if (!x || !(x.drivers?.length || x.cars?.length)) return db;
  const hit = extrasCache.get(rec);
  if (hit?.base === db) return hit.db;
  const have = new Set(db.drivers.map((d) => String(d.id))), haveC = new Set(db.cars.map((c) => c.id));
  const out = { ...db, drivers: [...db.drivers, ...(x.drivers ?? []).filter((d) => !have.has(String(d.id)))],
                cars: [...db.cars, ...(x.cars ?? []).filter((c) => !haveC.has(c.id))], _ix: undefined };
  extrasCache.set(rec, { base: db, db: out });
  return out;
}

/** the race's own typical lap (s): the median lap of the record, opening lap left out */
export function recordLap(rec) {
  const xs = [];
  for (const t of rec.t) for (let l = 1; l < t.length; l++) xs.push((t[l] - t[l - 1]) / 1000);
  xs.sort((a, b) => a - b);
  return xs.length ? xs[Math.floor(xs.length / 2)] : null;
}

/** config.replay for simulateRace: the record in entry order, forced through lap `until` (default: all of it) */
export function replayOf(rec, idx, nEntries, until = Infinity) {
  const t = Array.from({ length: nEntries }, () => []), pit = Array.from({ length: nEntries }, () => []);
  const fin = new Array(nEntries).fill(false), cause = new Array(nEntries).fill("mechanical"), why = new Array(nEntries).fill(null);
  rec.cars.forEach((c, k) => {
    const i = idx[k];
    if (i == null) return;
    t[i] = rec.t[k].map((ms) => ms / 1000);
    pit[i] = rec.pit[k] ?? [];
    fin[i] = c.cat === "finished";
    cause[i] = c.cat === "mechanical" ? "mechanical" : c.cat === "finished" ? null : "incident";
    why[i] = c.cat === "finished" ? null : c.st;
  });
  // narration (record `nar`: [{lap, text, c?: record car, q?: a quote, src?}]): terse factual lines or report quotes
  const nar = (rec.nar ?? []).map((x) => ({ lap: x.lap, text: x.text, q: !!x.q, src: x.src ?? null, c: x.c != null ? idx[x.c] ?? null : null }));
  return { until, t, pit, fin, cause, why, sc: rec.sc, vsc: rec.vsc, red: rec.red ?? [], baseLap: recordLap(rec), nar };
}

/** the replay cut by the player's calls: forced up to the lap before the first call */
export function untilFor(calls) {
  const ls = (calls ?? []).map((c) => c.lap).filter((l) => l != null);
  return ls.length ? Math.min(...ls) - 1 : Infinity;
}

/** a full replay's result in the official order (penalties after the flag, etc.): positions from the record */
export function officialResult(out, rec, idx) {
  // (unclassified cars, pos null: after the classified, in the record's order: laps run; classes running together
  // share positions: the record's order breaks the tie)
  const posOf = new Map(rec.cars.map((c, k) => [idx[k], { ...c, key: (c.pos ?? 1000) * 1000 + k }]).filter(([i]) => i != null));
  const res = [...out.result].sort((a, b) => (posOf.get(a.c)?.key ?? 9999) - (posOf.get(b.c)?.key ?? 9999));
  res.forEach((r, p) => {
    const c = posOf.get(r.c);
    r.pos = p + 1;
    if (c) { r.official = c.st; if (c.cat !== "finished") r.status = "retired"; }
  });
  out.result = res;
  return out;
}

/** the sim config for a real race (the record is attached at run time, not stored in the config) */
export function historyConfig(db, race, rec, seed = 1) {
  const { entries } = historyEntries(db, race, rec);
  const wet = race?.weather ? Math.min(1, (race.weather.rain_mm ?? 0) / 3) : 0;
  return { name: `${rec.year} ${rec.name}`, history: { id: rec.id }, raceId: race?.id, year: rec.year, circuit: race.circuit,
           layout: race.layout, laps: rec.laps, wet, grid: "fixed", mode: "relative", seed, entries };
}
