// Seeded PRNG (mulberry32) with the draws the race sim needs. Deterministic for a given seed.
export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const normal = (mu = 0, sd = 1) => {
    if (spare !== null) { const z = spare; spare = null; return mu + sd * z; }
    let x, y, s;
    do { x = 2 * u() - 1; y = 2 * u() - 1; s = x * x + y * y; } while (s >= 1 || s === 0);
    const f = Math.sqrt(-2 * Math.log(s) / s);
    spare = y * f;
    return mu + sd * x * f;
  };
  const exp = (mean) => -mean * Math.log(1 - u());
  const poisson = (lam) => {
    if (lam <= 0) return 0;
    const L = Math.exp(-lam); let k = 0, p = 1;
    do { k++; p *= u(); } while (p > L);
    return k - 1;
  };
  const pick = (weights) => {          // index drawn proportional to weights
    let tot = 0; for (const w of weights) tot += w;
    let r = u() * tot;
    for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
    return weights.length - 1;
  };
  return { u, normal, exp, poisson, pick };
}
