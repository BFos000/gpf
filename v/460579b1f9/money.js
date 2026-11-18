// Period money: the programme counts in budget points (100 = the top team's season budget in that era); the player
// sees the period amount. Anchors: sourced top-team budgets (docs/TEAM_PROGRAMME.md, "Period money"); between anchors
// the scale is interpolated on a log scale. est: no sourced full-season figure near that year.
// GBP to 1993, USD from 1994 (the era of quoted team budgets and the cost cap).
export const ANCHORS = [
  // [year, top budget, currency, est, note]
  [1906, 25e3, "£", true, "makers' costs unpublished; prizes ~45,000 F (≈£1,800) a race"],
  [1914, 40e3, "£", true, "estimate"],
  [1921, 80e3, "£", true, "Sunbeam-Talbot-Darracq: £50,000 for one race (1921 ACF GP)"],
  [1930, 70e3, "£", true, "estimate"],
  [1934, 180e3, "£", false, "Daimler-Benz / Auto Union racing departments ~2.2m RM (Reuss)"],
  [1937, 209e3, "£", false, "~£209,000 a year each (BIOS report, Motor Sport Jan 1949)"],
  [1951, 90e3, "£", true, "estimate (Alfa Romeo, Ferrari: no published figures)"],
  [1955, 120e3, "£", true, "Fiat paid Ferrari 50m lire a year from 1955; Mercedes far more"],
  [1960, 40e3, "£", true, "Cooper: ~£10,000 a season (1959), Esso £10,000 (1960)"],
  [1968, 100e3, "£", false, "Lotus: Gold Leaf £85,000 a year; Tyrrell £80,000"],
  [1974, 600e3, "£", false, "Tyrrell £600,000 (Ken Tyrrell)"],
  [1980, 2.2e6, "£", false, "Williams £2.2m, 50 staff (Motor Sport)"],
  [1989, 30e6, "£", false, "McLaren (≈£22m turnover 1990; £50m with Honda's share)"],
  [1992, 32e6, "£", false, "Williams £32m, Renault engines free"],
  [1994, 60e6, "$", false, "Benetton $43m (1995 estimate); McLaren ~$92m (1997)"],
  [1997, 92e6, "$", false, "McLaren International turnover"],
  [2005, 450e6, "$", false, "Toyota ~$499m, Ferrari ~$435m (with engines)"],
  [2008, 445e6, "$", false, "Toyota $445.6m (Formula Money)"],
  [2013, 300e6, "$", false, "Red Bull Racing £196m (chassis only)"],
  [2019, 430e6, "$", false, "Mercedes £333m (chassis only)"],
  [2021, 200e6, "$", false, "cost cap $145m plus items outside it"],
  [2026, 250e6, "$", false, "cost cap $215m (wider scope)"],
];
function at(y) {
  const A = ANCHORS;
  if (y <= A[0][0]) return { top: A[0][1], cur: A[0][2], est: A[0][3] };
  for (let i = 1; i < A.length; i++) {
    const [y1, v1, c1, e1] = A[i], [y0, v0, c0, e0] = A[i - 1];
    if (y > y1) continue;
    if (c0 !== c1) return { top: v1, cur: c1, est: e1 };   // currency switch: use the later anchor
    const f = (y - y0) / (y1 - y0);
    return { top: Math.exp(Math.log(v0) * (1 - f) + Math.log(v1) * f), cur: c1, est: e0 || e1 || y1 - y0 > 6 };
  }
  const L = A.at(-1); return { top: L[1], cur: L[2], est: L[3] };
}
export const topBudget = (y) => at(y);
export const isEstimate = (y) => at(y).est;
// budget points -> period amount
export function amount(points, y) { const a = at(y); return { v: points / 100 * a.top, cur: a.cur }; }
export function fmt(points, y, signed = false) {
  const { v, cur } = amount(points, y), s = v < 0 ? "−" : signed ? "+" : "", a = Math.abs(v);
  const n = a >= 1e9 ? `${(a / 1e9).toFixed(2)}bn` : a >= 1e6 ? `${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}m` : a >= 1e3 ? `${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k` : `${Math.round(a)}`;
  return `${s}${cur}${n}`;
}
