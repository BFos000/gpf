// Race-by-race history for both modes (Real Seasons and the career), kept in each season's history entry:
//   h.races = [{ circuit, layout, name?, res }]   res: Real Seasons rows [d, team, pos, fin, pts, grid]
//                                                       career: per tier, rows [p, d, pos, fin, pts, grid]
//   null res = the round's result wasn't saved (seasons played before v51, rebuilt from old save files)
// and the import that rebuilds it from old save files of the same game.

export const packReal = (rows) => rows ? rows.map((x) => [x.d, x.team, x.pos, x.fin, x.pts, x.grid ?? null]) : null;
export const unpackReal = (res) => res ? res.map(([d, team, pos, fin, pts, grid]) => ({ d: String(d), team, pos, fin, pts, grid })) : null;
export const packCareer = (tiers) => tiers ? tiers.map((rows) => rows ? rows.map((x) => [x.p, x.d, x.pos, x.fin, x.pts, x.grid ?? null]) : null) : null;
export const unpackCareer = (tiers) => tiers ? tiers.map((rows) => rows ? rows.map(([p, d, pos, fin, pts, grid]) => ({ p, d: String(d), pos, fin, pts, grid })) : null) : null;

// ---------- import: old save files (or an exported archive) of the same game ----------
// A save holds its own season's results only. For every past season of `S` without race results, take the save
// of that season (same game: kind + seed + start) with the most recorded rounds; the later one on a tie.
function sameGame(S, x, kind) {
  if (!x || x.kind !== kind || x.seed !== S.seed) return false;
  if (kind === "fantasy-gp-real") return x.startYear === S.startYear && x.mode === S.mode;
  return (x.mode ?? "team") === (S.mode ?? "team") && x.player === S.player;
}
const seasonOf = (x) => (x.kind === "fantasy-gp-real" ? x.year : x.season);
const histKey = (h) => h.year ?? h.season;
const nRounds = (x) => (x.results ?? []).filter(Boolean).length;

/** files: parsed JSON objects (saves, or {kind: "fantasy-gp-archive", ...}). Returns {filled: [season], partial: [season], skipped} */
export function importArchive(S, files, kind = S.kind) {
  const real = kind === "fantasy-gp-real";
  const best = new Map();                                 // season -> {races, teamNames, cars, n, at}
  const consider = (season, entry) => {
    const cur = best.get(season);
    if (!cur || entry.n > cur.n || (entry.n === cur.n && entry.at >= cur.at)) best.set(season, entry);
  };
  let skipped = 0;
  files.forEach((x, at) => {
    if (x?.kind === "fantasy-gp-archive") {               // an archive file: its game must match too
      if (!sameGame(S, x.game, kind)) { skipped++; return; }
      for (const h of x.seasons ?? []) consider(histKey(h), { races: h.races, teamNames: h.teamNames, cars: h.cars, n: h.races.filter((r) => r.res).length, at: 1e9 + at });
      return;
    }
    if (!sameGame(S, x, kind)) { skipped++; return; }
    for (const h of x.history ?? []) if (h.races) consider(histKey(h), { races: h.races, teamNames: h.teamNames, cars: h.cars, n: h.races.filter((r) => r.res).length, at: 1e9 + at });
    if (!nRounds(x)) return;
    const races = (x.calendar ?? []).map((c, r) => ({ circuit: c.circuit, layout: c.layout ?? null, ...(c.name ? { name: c.name } : {}),
      res: real ? packReal(x.results[r]) : packCareer(x.results[r]) }));
    consider(seasonOf(x), { races, n: nRounds(x), at,
      ...(real ? { teamNames: Object.fromEntries((x.teams ?? []).map((t) => [t.ref, t.name])), cars: Object.fromEntries((x.teams ?? []).map((t) => [t.ref, t.car])) } : {}) });
  });
  const filled = [], partial = [];
  for (const h of S.history) {
    const k = histKey(h), b = best.get(k);
    if (!b || (h.races && h.races.every((r) => r.res))) continue;
    if (h.races && h.races.filter((r) => r.res).length >= b.n) continue;
    h.races = b.races;
    if (b.teamNames) h.teamNames = b.teamNames;
    if (b.cars) h.cars = b.cars;
    (h.races.every((r) => r.res) ? filled : partial).push(k);
  }
  return { filled, partial, skipped };
}
/** an archive file of this game's race history (to keep, or to import into another copy of the save) */
export function exportArchive(S, kind = S.kind) {
  const real = kind === "fantasy-gp-real";
  return { kind: "fantasy-gp-archive", game: { kind, seed: S.seed, ...(real ? { startYear: S.startYear, mode: S.mode } : { mode: S.mode ?? "team", player: S.player }) },
           seasons: S.history.filter((h) => h.races).map((h) => ({ [real ? "year" : "season"]: histKey(h), races: h.races, ...(h.teamNames ? { teamNames: h.teamNames, cars: h.cars } : {}) })) };
}

// ---------- all-time records ----------
/** rows: iterable of race result rows {d, pos, fin, pts, grid}; titles: Map d -> count. Returns sorted stats. */
export function tally(races, titles = new Map()) {
  const m = new Map();
  const get = (d) => m.get(d) ?? m.set(d, { d, starts: 0, wins: 0, podiums: 0, poles: 0, pts: 0, titles: 0, best: 99 }).get(d);
  for (const rows of races) for (const x of rows) {
    const s = get(x.d); s.starts++; s.pts += x.pts ?? 0;
    if (x.fin && x.pos === 1) s.wins++;
    if (x.fin && x.pos <= 3) s.podiums++;
    if (x.grid === 1) s.poles++;
    if (x.fin) s.best = Math.min(s.best, x.pos);
  }
  for (const [d, n] of titles) get(d).titles += n;
  return [...m.values()].sort((a, b) => b.titles - a.titles || b.wins - a.wins || b.podiums - a.podiums || b.pts - a.pts);
}
/** constructors from Real Seasons rows {team, pos, fin, pts, grid}; titles: Map team -> count. Races = rounds the team
 *  started, 1-2 = its cars first and second (finishers), the rest summed over its cars */
export function tallyTeams(races, titles = new Map()) {
  const m = new Map();
  const get = (t) => m.get(t) ?? m.set(t, { t, races: 0, wins: 0, onetwo: 0, podiums: 0, poles: 0, pts: 0, titles: 0 }).get(t);
  for (const rows of races) {
    const seen = new Set();
    for (const x of rows) {
      const s = get(x.team);
      if (!seen.has(x.team)) { seen.add(x.team); s.races++; }
      s.pts += x.pts ?? 0;
      if (x.fin && x.pos === 1) s.wins++;
      if (x.fin && x.pos <= 3) s.podiums++;
      if (x.grid === 1) s.poles++;
    }
    const p1 = rows.find((x) => x.fin && x.pos === 1), p2 = rows.find((x) => x.fin && x.pos === 2);
    if (p1 && p2 && p1.team === p2.team) get(p1.team).onetwo++;
  }
  for (const [t, n] of titles) get(t).titles += n;
  return [...m.values()].sort((a, b) => b.titles - a.titles || b.wins - a.wins || b.podiums - a.podiums || b.pts - a.pts);
}
/** a table sortable by any column. rows: already in the default order. cols: [{k, label, cell(s) -> td html,
 *  val?(s) (sort key, default s[k]), text? (sorts A to Z first)}]. sort: {k, dir} or null (the default order).
 *  Header clicks fire data-act="atsort" with data-t = id, data-k = the column, data-dir = the order to switch to. */
export function sortTable(rows, cols, sort, { id, rowCls = () => "", limit = 40 } = {}) {
  const col = sort && cols.find((c) => c.k === sort.k);
  let list = rows;
  if (col) {
    const v = col.val ?? ((s) => s[col.k]);
    list = rows.map((s, i) => [s, v(s), i]).sort((a, b) => {
      const c = col.text ? String(a[1]).localeCompare(String(b[1])) : a[1] - b[1];
      return c * sort.dir || a[2] - b[2];                      // ties keep the default order
    }).map((x) => x[0]);
  }
  const head = cols.map((c) => {
    const on = col === c, next = on ? -sort.dir : (c.text ? 1 : -1);
    const arrow = on ? (sort.dir > 0 ? " ▲" : " ▼") : "";
    return `<th class="srt${on ? " on" : ""}" data-act="atsort" data-t="${id}" data-k="${c.k}" data-dir="${next}" title="Sort by ${c.label.toLowerCase()}">${c.label}${arrow}</th>`;
  }).join("");
  const body = list.slice(0, limit).map((s, k) => `<tr class="${rowCls(s)}"><td class="n">${k + 1}</td>${cols.map((c) => c.cell(s)).join("")}</tr>`).join("");
  const more = list.length > limit ? `<p class="muted small">Top ${limit} of ${list.length} by this column.</p>` : "";
  return `<table class="cr-t"><thead><tr><th>#</th>${head}</tr></thead><tbody>${body}</tbody></table>${more}`;
}
/** the driver records' columns (both modes); name(d) -> html, text(d) -> plain name for sorting */
export const driverCols = (name, text) => [
  { k: "d", label: "Driver", text: true, val: (s) => text(s.d), cell: (s) => `<td>${name(s.d)}</td>` },
  { k: "titles", label: "Titles", cell: (s) => `<td class="n b">${s.titles || ""}</td>` },
  { k: "wins", label: "Wins", cell: (s) => `<td class="n">${s.wins || ""}</td>` },
  { k: "podiums", label: "Podiums", cell: (s) => `<td class="n">${s.podiums || ""}</td>` },
  { k: "poles", label: "Poles", cell: (s) => `<td class="n">${s.poles || ""}</td>` },
  { k: "starts", label: "Starts", cell: (s) => `<td class="n">${s.starts}</td>` },
  { k: "pts", label: "Points", cell: (s) => `<td class="n">${s.pts}</td>` },
];
/** a season's results grid: drivers (or entries) by points, one cell per round */
export function seasonGrid(races, keyOf = (x) => x.d) {
  const m = new Map();
  races.forEach((rows, r) => {
    for (const x of rows ?? []) {
      const k = keyOf(x), s = m.get(k) ?? m.set(k, { k, x, pts: 0, wins: 0, cells: [] }).get(k);
      s.pts += x.pts ?? 0; if (x.fin && x.pos === 1) s.wins++;
      s.cells[r] = x;
    }
  });
  return [...m.values()].sort((a, b) => b.pts - a.pts || b.wins - a.wins);
}
/** a cell: position, "R" for a retirement; classes for the podium */
export const cellHTML = (x) => !x ? `<td class="rg-c"></td>`
  : `<td class="rg-c ${x.fin ? (x.pos === 1 ? "g" : x.pos === 2 ? "s" : x.pos === 3 ? "b" : x.pts > 0 ? "pts" : "") : "r"}" title="${x.fin ? `P${x.pos}` : "retired"}${x.grid ? ` · grid ${x.grid}` : ""}${x.pts ? ` · ${x.pts} pts` : ""}">${x.fin ? x.pos : "R"}</td>`;
