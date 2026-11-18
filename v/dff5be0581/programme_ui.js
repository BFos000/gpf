// Constructor programme screens (shared by Real Seasons and the Career): departments and people, the car (this year's
// and next year's in the works), money and credit. The engine is programme.js; money is shown in period money (money.js).
// ctx: { P, db, y (season year), ny (next season or null), phase: "off" | "season", round, nRounds, f (fieldOf), cap
//        (powerCap), sub (screen: depts | car | money) }
import * as G from "./programme.js";
import * as M from "./money.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const SUBS = [["depts", "Departments"], ["car", "The car"], ["money", "Money"]];
const NAT = { gb: "GB", it: "IT", fr: "FR", de: "DE", us: "US", jp: "JP", at: "AT", br: "BR", nl: "NL", ch: "CH" };
const DI = Object.fromEntries(G.DK.map((k, i) => [k, i]));
const leanWord = (d, l) => (d === "engine" || d === "aero" || d === "design" ? (l > 0.25 ? "power" : l < -0.25 ? "agility" : "balanced") : "");
const pct = (x) => `${Math.round(100 * x)}%`;

// a normal curve over 0-100 with the expected value marked (and a second marker, e.g. the real best car)
function curve(mu, sd, mark = null, w = 150, h = 26, label = "") {
  const xs = [], pts = [];
  const sx = (v) => (v / 100) * w, peak = 1 / Math.max(sd, 1.5);
  for (let v = 0; v <= 100; v += 2) { const d = Math.exp(-0.5 * ((v - mu) / Math.max(sd, 1.5)) ** 2) / Math.max(sd, 1.5); pts.push(`${sx(v).toFixed(1)},${(h - 2 - (h - 6) * d / peak).toFixed(1)}`); xs.push(v); }
  const lo = Math.max(0, mu - 1.64 * sd), hi = Math.min(100, mu + 1.64 * sd);
  return `<svg class="pg-curve" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label || `Expected ${Math.round(mu)}, likely ${Math.round(lo)} to ${Math.round(hi)}`)}">
    <rect x="${sx(lo)}" y="2" width="${sx(hi) - sx(lo)}" height="${h - 4}" class="pg-band"/>
    <polyline points="${pts.join(" ")}" class="pg-line"/><line x1="${sx(mu)}" x2="${sx(mu)}" y1="2" y2="${h - 2}" class="pg-mu"/>
    ${mark != null ? `<line x1="${sx(Math.min(100, mark))}" x2="${sx(Math.min(100, mark))}" y1="0" y2="${h}" class="pg-mark"/>` : ""}</svg>`;
}
const range = (p) => { const [a, b] = G.ratingRange(p); return a === b ? `${a}` : `${a}–${b}`; };

export function progView(ctx) {
  const { P, y } = ctx, sub = ctx.sub ?? "depts";
  const head = summary(ctx);
  const nav = `<nav class="cr-tabs sub">${SUBS.map(([k, l]) => `<button class="${sub === k ? "on" : ""}" data-act="pgsub" data-sub="${k}">${l}</button>`).join("")}</nav>`;
  const body = sub === "car" ? carView(ctx) : sub === "money" ? moneyView(ctx) : deptsView(ctx);
  return `${head}${nav}${body}`;
}

function summary(ctx) {
  const { P, y } = ctx, m = (v) => M.fmt(v, y);
  const inc = G.expectedIncome(P, y), out = G.spending(P, y, ctx.nRounds).reduce((a, [, v]) => a + v, 0);
  const net = inc - out;
  const cr = `<span class="pg-credit c${P.credit}" title="${esc(G.CREDIT_NAME[P.credit])}">${G.CREDIT[P.credit]}</span>`;
  return `<div class="pg-sum">
    <div><span class="muted">Cash</span><b>${m(P.cash)}</b></div>
    <div><span class="muted">Debt</span><b>${m(P.debt)}</b></div>
    <div><span class="muted">Credit</span><b>${cr} ${esc(G.CREDIT_NAME[P.credit])}</b></div>
    <div><span class="muted">Reputation</span><b>${Math.round(P.rep)}</b></div>
    <div><span class="muted">Season forecast</span><b class="${net < 0 ? "bad" : ""}">${M.fmt(net, y, true)}</b></div>
    ${M.isEstimate(y) ? `<div class="muted small" style="align-self:end">Period money for ${y} is an estimate: no sourced team budget near this year.</div>` : ""}
    ${ctx.label ? `<div class="muted small" style="align-self:end">Money in ${y} terms (the rules year).</div>` : ""}
  </div>`;
}

// ---------- departments ----------
function deptsView(ctx) {
  const { P, y, phase } = ctx, off = phase === "off", m = (v) => M.fmt(v, y);
  const proj = G.projection(P, y);
  const rows = G.DEPTS.map((D, k) => {
    const d = P.depts[k], h = d.head, o = proj.depts[k], w = o.w;
    const search = P.searches.find((s) => s.dept === D.key), offers = P.offers[D.key];
    const lw = leanWord(D.key, h.lean);
    const headCell = `<b>${esc(h.name)}</b>${h.legend ? ' <span class="pg-star" title="A real legend">★</span>' : ""}
      <div class="muted small">${NAT[h.nat] ?? ""} · ${h.age} · ${h.years > 0 ? `${h.years} season${h.years === 1 ? "" : "s"} left` : "contract ending"} · ${m(h.salary)}/season${lw ? ` · style: ${lw}` : ""}</div>
      ${off ? `<label class="inline small" for="pg-pay-${D.key}">New deal <select id="pg-pay-${D.key}" data-pg="pay" data-d="${D.key}">
        <option value="">—</option>${[0.9, 1, 1.15, 1.3, 1.5].map((x) => `<option value="${x}">${Math.round(x * 100)}% of market, 3 seasons (${m(G.marketSalary(h.rating) * x)})</option>`).join("")}</select></label>` : ""}`;
    const mt = d.mentee;
    const menteeCell = mt ? `${esc(mt.name)} <span class="muted small">${mt.age} · rated ${range(mt)} · ${G.menteeHint(mt)}</span>
        ${off ? `<button class="btn small" data-act="pgpromote" data-d="${D.key}" title="${esc(mt.name)} replaces ${esc(h.name)}, who leaves">Promote</button>` : ""}`
      : off ? `<button class="btn small" data-act="pgmentee" data-d="${D.key}">Take on a mentee</button>` : '<span class="muted">—</span>';
    const searchCell = search ? `<span class="muted small">Search running (${search.size}${search.urgent ? ", urgent" : ""})</span> <button class="btn small" data-act="pgcancel" data-d="${D.key}">Stop</button>`
      : `<select id="pg-ss-${D.key}" aria-label="Search size for ${esc(D.head)}">${G.SEARCH_SIZES.map((s) => `<option value="${s}">${s} · ${m(G.searchCost(s, !off))}</option>`).join("")}</select>
         <button class="btn small" data-act="pgsearch" data-d="${D.key}" title="${off ? "The shortlist comes back at once: 1-3 candidates, better with a bigger search and a better reputation" : "Urgent: reports after four races, at double the cost"}">${off ? "Search" : "Urgent search"}</button>`;
    const offerRows = offers?.length ? `<tr class="pg-offers"><td></td><td colspan="7"><div class="pg-cands">${offers.map((c, i) => `<div class="pg-cand">
        <b>${esc(c.name)}</b>${c.legend ? ' <span class="pg-star">★</span>' : ""} <span class="muted small">${NAT[c.nat] ?? ""} · ${c.age}</span>
        <div>Rated ${range(c)} <span class="muted small">(now: ${range(h)})</span></div>
        <div class="muted small">${leanWord(D.key, c.lean) ? `style: ${leanWord(D.key, c.lean)} · ` : ""}asks ${m(c.salary)}/season</div>
        <button class="btn small primary" data-act="pghire" data-d="${D.key}" data-i="${i}">Hire</button></div>`).join("")}
        <button class="btn small" data-act="pgdismiss" data-d="${D.key}">Keep ${esc(h.name)}</button></div></td></tr>` : "";
    const bud = off ? `<input type="range" min="0" max="40" step="0.5" value="${d.budget}" data-pg="budget" data-d="${D.key}" aria-label="${esc(D.name)} running budget"> ${m(d.budget)}`
      : m(d.budget);
    const inv = off ? `<input type="range" min="0" max="10" step="0.25" value="${d.invest}" data-pg="invest" data-d="${D.key}" aria-label="${esc(D.name)} facilities spend" ${G.covenants(P).facilities ? "" : "disabled title=\"Lenders block facilities spending below a B rating\""}> ${m(d.invest)}`
      : m(d.invest);
    return `<tr><th scope="row">${esc(D.name)}<div class="muted small">weight ${pct(w)} in ${y}</div></th>
      <td>${headCell}<div class="small">Rated ${range(h)}</div></td><td>${menteeCell}</td>
      <td>${bud}<div class="muted small">depth ${Math.round(o.depth)}</div></td><td>${inv}</td>
      <td class="n">${Math.round(d.fac)}</td><td class="n">${Math.round(d.know)}</td>
      <td>${curve(o.mu, o.sd, null, 120, 24, `${D.name}: expected output ${Math.round(o.mu)}`)}<div class="muted small">${Math.round(o.mu)} ± ${Math.round(1.64 * o.sd)}</div></td>
      <td>${searchCell}</td></tr>${offerRows}`;
  }).join("");
  const capR = G.capRoom(P, y);
  return `${off ? "" : '<p class="cr-note">Budgets, facilities, contracts and mentees are set in the offseason. During the season you can run urgent searches and move effort to next year\'s car (The car).</p>'}
    <div class="rg-wrap"><table class="cr-t pg-depts"><thead><tr><th>Department</th><th>Head</th><th>Mentee</th><th>Running budget</th><th>Facilities spend</th><th>Facilities</th><th>Know-how</th><th>Next car's output</th><th>Search</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    ${capR != null ? `<p class="${capR < 0 ? "bad" : "muted"} small">Cost cap: ${capR < 0 ? `over by ${m(-capR)}: budgets are cut to fit when the season starts.` : `${m(capR)} of room.`}</p>` : ""}
    ${off ? `<div class="su-bar"><button class="btn" data-act="pgauto">Split the budget by era weights</button><span class="muted small">Spends about 55% of the expected income on running budgets.</span></div>` : ""}
    ${logHTML(ctx)}`;
}
function logHTML(ctx) {
  const L = ctx.P.log.slice(-14).reverse();
  return L.length ? `<h4>Programme news</h4><ul class="cr-log">${L.map((x) => `<li>${x.season != null ? `S${x.season}` : x.year}: ${esc(x.text)}</li>`).join("")}</ul>` : "";
}

// ---------- the car ----------
function carView(ctx) {
  const { P, y, ny, phase, f } = ctx, off = phase === "off", c = P.car;
  const best = f.bestIndex, real = best != null, gap = (i) => ((real ? best : 50) - i) / 25 * f.spread;
  const L = ctx.label ?? `${y}`, LN = ctx.nextLabel ?? `${ny}`;
  const gapTxt = (i) => {
    const g = gap(i);
    if (!real) return Math.abs(g) < 0.05 ? "the same as the models as they raced" : g > 0 ? `≈${g.toFixed(2)}% a lap slower than the models as they raced` : `≈${(-g).toFixed(2)}% a lap quicker than the models as they raced`;
    return Math.abs(g) < 0.05 ? "level with the best real car" : g > 0 ? `≈${g.toFixed(2)}% a lap behind the best real car` : `≈${(-g).toFixed(2)}% a lap ahead of the best real car`;
  };
  let now;
  if (c) {
    const idx = G.indexAt(P, ctx.round, ctx.nRounds);
    now = `<div class="cr-card"><header><b>${L} car</b><span class="chip">Index ${idx.toFixed(1)}</span></header>
      <div>${gapTxt(idx)}${real ? ` (best real car: index ${best.toFixed(0)})` : ""}.</div>
      <div class="muted small">Launch ${c.launch.toFixed(1)} · upgrade packages ${c.got?.length ?? 0} of ${c.packages} arrived</div>
      <table class="cr-t small"><tbody>${G.DEPTS.map((D, k) => `<tr><td>${esc(D.name)}</td><td class="n">${Math.round(c.out[k])}</td><td><span class="pg-bar" style="--v:${c.out[k]}%"></span></td></tr>`).join("")}</tbody></table></div>`;
  } else {
    const pr = G.projection(P, y);
    now = `<div class="cr-card"><header><b>${L} car</b><span class="chip">Projected ${pr.mu.toFixed(1)}</span></header>
      ${curve(pr.mu, pr.sd, real ? best : null, 260, 40, `Projected index ${Math.round(pr.mu)}`)}
      <div>${gapTxt(pr.mu)} if it comes out as expected; 90% likely between ${Math.round(pr.mu - 1.64 * pr.sd)} and ${Math.round(pr.mu + 1.64 * pr.sd)}.</div>
      <div class="muted small">${real ? `The yellow line is the best real car of ${y}. ` : "Index 50 leaves each entry's model as it raced. "}The car is built when the season starts.</div></div>`;
  }
  // next year's car
  let next = "";
  if (ny) {
    const share = G.nextShare(P), prog = c ? Math.min(0.9, (ctx.round / Math.max(1, ctx.nRounds)) * (0.3 + 1.4 * share)) : 0;
    const pr = G.projection(P, ny, prog), reg = ctx.nextReg ?? G.regAt(ny), fN = ctx.fNext;
    next = `<div class="cr-card"><header><b>${LN} car (in the works)</b><span class="chip">Projected ${pr.mu.toFixed(1)}</span></header>
      ${curve(pr.mu, pr.sd, fN?.bestIndex ?? null, 260, 40, `Next year's projected index ${Math.round(pr.mu)}`)}
      <div class="muted small">${reg ? `<b class="bad">New rules for ${LN}:</b> ${Math.round(reg * 100)}% of the know-how stops applying; effort put into that car now carries part of it over. ` : ""}
      The range narrows as the season goes on, faster with more effort on it. At today's budgets and staff.</div></div>`;
  }
  const split = `<div class="cr-card"><header><b>This year ↔ next year</b></header>
    <label for="pg-next" class="small">Effort on the ${ny ? LN : "next"} car: <b>${pct(P.next)}</b></label>
    <input id="pg-next" type="range" min="0" max="1" step="0.05" value="${P.next}" data-pg="next" ${ny ? "" : "disabled"}>
    <div class="muted small">Upgrades still to come this season shrink as effort moves; next year's car gains know-how and, before a rule change, keeps more of it. Season average so far: ${pct(G.nextShare(P))}.</div></div>`;
  const pc = ctx.cap, swing = (pc * (ctx.db?.meta?.power?.span_sd ?? 3)).toFixed(2);
  const prof = (k, l, r, help, dis) => `<div class="pg-prof"><span>${l}</span><input type="range" min="-1" max="1" step="0.1" value="${P.profile[k]}" data-pg="prof" data-k="${k}" aria-label="${esc(l)} to ${esc(r)}" ${dis ? "disabled" : ""}><span>${r}</span><div class="muted small">${help}</div></div>`;
  const profile = `<div class="cr-card"><header><b>Car profile</b>${off ? "" : '<span class="muted small">set before the car is built</span>'}</header>
    ${prof("pa", "Agility", "Power", `Full lean: up to ${swing}% of lap time between the twisty and the fast circuits in ${y}. Leaning against a head's style costs that department.`, !off)}
    ${prof("sr", "Speed", "Reliability", "Up to 4 index points of pace traded for fewer failures, or the reverse.", !off)}
    ${prof("qt", "One lap", "Tyre life", "Qualifying pace against tyre wear in the race.", !off)}</div>`;
  const eng = P.engine;
  const engine = `<div class="cr-card"><header><b>Engines</b><span class="chip">${eng.mode === "build" ? "Own engines" : `Customer, tier ${eng.tier + 1}`}</span></header>
    ${off ? `<label class="inline" for="pg-eng">Supply <select id="pg-eng" data-pg="engine">
      <option value="build" ${eng.mode === "build" ? "selected" : ""}>Build our own (Engine department output)</option>
      ${G.ENGINE_TIERS.map((t) => `<option value="c${t.tier}" ${eng.mode === "customer" && eng.tier === t.tier ? "selected" : ""}>Buy from a tier ${t.tier + 1} supplier: output ${t.output}, ${M.fmt(t.fee, y)}/season</option>`).join("")}</select></label>` : ""}
    <div class="muted small">Starting your own engine programme resets the Engine department's know-how to 15. A works engine department rated 70+ also sells engines.</div></div>`;
  return `<div class="cr-cards">${now}${next}${split}${profile}${engine}</div>`;
}

// ---------- money ----------
function moneyView(ctx) {
  const { P, y, phase } = ctx, m = (v) => M.fmt(v, y);
  const inc = G.income(P, y, { prize: G.prizeGuess(P) }), out = G.spending(P, y, ctx.nRounds);
  const tIn = inc.reduce((a, [, v]) => a + v, 0), tOut = out.reduce((a, [, v]) => a + v, 0);
  const lines = (L) => L.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${m(v)}</td></tr>`).join("");
  const cv = G.covenants(P);
  const cov = [!cv.facilities && "no facilities spending", !cv.searches && "no searches", cv.shortlistCut && "shorter shortlists", cv.askMore > 1 && "candidates ask 20% more",
    cv.leaveMult > 1 && "staff twice as likely to leave", P.credit >= 3 && "sponsors pay 15% less", P.credit >= 4 && "facilities sold off 10% a season, cheapest engine supplier only"].filter(Boolean);
  const ledger = [...P.ledger].reverse().slice(0, 30).map((L) => `<tr><td class="n">${L.season != null ? `S${L.season}` : L.year}</td><td class="n">${M.fmt(L.income.reduce((a, [, v]) => a + v, 0), L.year)}</td>
    <td class="n">${M.fmt(L.spending.reduce((a, [, v]) => a + v, 0), L.year)}</td><td class="n ${L.net < 0 ? "bad" : ""}">${M.fmt(L.net, L.year, true)}</td><td class="n">${M.fmt(L.debt, L.year)}</td></tr>`).join("");
  return `<div class="cr-cols"><div>
      <h4>${ctx.label ?? y} forecast</h4>
      <table class="cr-t"><thead><tr><th>Income</th><th class="n"></th></tr></thead><tbody>${lines(inc)}<tr class="b"><td>Total</td><td class="n">${m(tIn)}</td></tr></tbody></table>
      <table class="cr-t"><thead><tr><th>Spending</th><th class="n"></th></tr></thead><tbody>${lines(out)}<tr class="b"><td>Total</td><td class="n">${m(tOut)}</td></tr></tbody></table>
      <p class="${tIn - tOut < 0 ? "bad" : "muted"}">Net: ${M.fmt(tIn - tOut, y, true)}. Prize money is last season's (a guess from your reputation in the first); the real figure follows your results. A shortfall at the end of the season is added to the debt.</p>
    </div><div>
      <h4>Debt and credit</h4>
      <p>Rating <span class="pg-credit c${P.credit}">${G.CREDIT[P.credit]}</span> ${esc(G.CREDIT_NAME[P.credit])} · interest ${G.interestRate(P)}% a season${P.debt ? ` (${m(P.debt * G.interestRate(P) / 100)})` : ""}.</p>
      <p class="muted small">The rating follows debt against income. It falls at once and recovers one notch for every two clean seasons. You never lose the team, but in default the lenders run it.${cov.length ? ` Now: ${esc(cov.join("; "))}.` : ""}</p>
      <div class="su-bar"><label class="inline" for="pg-amt">Amount <select id="pg-amt">${[2, 5, 10, 20, 40].map((v) => `<option value="${v}">${m(v)}</option>`).join("")}</select></label>
        <button class="btn" data-act="pgborrow" ${P.credit >= 4 ? "disabled title=\"In default: nobody lends\"" : ""}>Borrow</button>
        <button class="btn" data-act="pgrepay" ${P.debt > 0 && P.cash > 0 ? "" : "disabled"}>Repay</button></div>
      <h4>Ledger</h4>
      ${ledger ? `<table class="cr-t"><thead><tr><th>Season</th><th class="n">Income</th><th class="n">Spending</th><th class="n">Net</th><th class="n">Debt</th></tr></thead><tbody>${ledger}</tbody></table>` : '<p class="muted">No seasons yet.</p>'}
      <p class="muted small">Money is shown in period terms: 100 budget points = a top team's season budget in that year (${m(100)} in ${y}).</p>
    </div></div>`;
}

// ---------- actions ----------
// returns a message for the player (or "" when the screen just needs a redraw); null = not a programme action
export function progAct(ctx, a, ds, root) {
  const { P, y, phase } = ctx, off = phase === "off";
  switch (a) {
    case "pgsub": ctx.setSub(ds.sub); return "";
    case "pgmentee": return G.takeMentee(P, ds.d, y) ? "" : "There is already a mentee there.";
    case "pgpromote": { const n = P.depts[DI[ds.d]].mentee?.name; return G.promoteMentee(P, ds.d) ? `${n} is promoted.` : ""; }
    case "pgsearch": {
      const size = root.querySelector(`#pg-ss-${ds.d}`)?.value ?? "medium";
      const r = G.startSearch(P, ds.d, size, y, !off);
      if (!r.ok) return r.why;
      if (off) { const s = P.searches.find((q) => q.dept === ds.d); const n = G.resolveSearch(P, s, y).length; return `The search (${M.fmt(r.cost, y)}) brings back ${n} candidate${n === 1 ? "" : "s"}.`; }
      return `Urgent search started (${M.fmt(r.cost, y)}): it reports after four races.`;
    }
    case "pgcancel": G.cancelSearch(P, ds.d); return "Search stopped (the money is spent).";
    case "pghire": { const c = P.offers[ds.d]?.[Number(ds.i)]; return G.hire(P, ds.d, Number(ds.i)) ? `${c.name} joins.` : ""; }
    case "pgdismiss": delete P.offers[ds.d]; return "";
    case "pgauto": G.defaultBudgets(P, y); return "";
    case "pgborrow": { const v = Number(root.querySelector("#pg-amt")?.value ?? 5); G.borrow(P, v); return `Borrowed ${M.fmt(v, y)}.`; }
    case "pgrepay": { const v = Number(root.querySelector("#pg-amt")?.value ?? 5); G.repay(P, v); return ""; }
  }
  return null;
}
// inputs (data-pg): returns true when handled
export function progInput(ctx, el) {
  const { P, y } = ctx, k = el.dataset.pg; if (!k) return false;
  const d = el.dataset.d != null ? P.depts[DI[el.dataset.d]] : null;
  if (k === "budget") d.budget = Number(el.value);
  else if (k === "invest") d.invest = Number(el.value);
  else if (k === "next") P.next = Number(el.value);
  else if (k === "prof") P.profile[el.dataset.k] = Number(el.value);
  else if (k === "pay") { if (el.value) G.setContract(P, el.dataset.d, G.marketSalary(d.head.rating) * Number(el.value), 3); }
  else if (k === "engine") { if (el.value === "build") G.setEngine(P, "build"); else G.setEngine(P, "customer", Number(el.value.slice(1))); }
  else return false;
  return true;
}

// ---------- new-team setup (stature and backing, every value editable) ----------
export const SETUP_FIELDS = [
  ["rep", "Reputation", 0, 100, 1, "Sets sponsorship and who answers your searches."],
  ["staff", "Heads of department (average rating)", 10, 95, 1, ""],
  ["fac", "Facilities", 0, 100, 1, ""],
  ["know", "Know-how", 0, 100, 1, ""],
  ["debt", "Starting debt (budget points)", 0, 150, 1, "100 = a top team's season budget."],
];
export function setupHTML(cfg, y, prefix = "pg-new") {
  const f = (k, l, lo, hi, st, help) => `<label for="${prefix}-${k}">${esc(l)} <input id="${prefix}-${k}" data-pgnew="${k}" type="number" min="${lo}" max="${hi}" step="${st}" value="${Math.round(cfg[k] ?? 0)}" style="width:70px">${help ? `<span class="muted small"> ${esc(help)}</span>` : ""}</label>`;
  return `<div class="pg-setup">
    <div class="su-bar">${["privateer", "midfield", "bigname"].map((p) => `<button class="btn ${cfg.preset === p ? "on" : ""}" data-act="pgpreset" data-p="${p}">${{ privateer: "Privateer", midfield: "Midfield", bigname: "Big name" }[p]}</button>`).join("")}
      ${cfg.target != null ? `<button class="btn ${cfg.preset === "real" ? "on" : ""}" data-act="pgpreset" data-p="real">As the real team</button>` : ""}</div>
    <div class="cr-drvfields">${SETUP_FIELDS.map((x) => f(...x)).join("")}
      <label for="${prefix}-backing">Manufacturer backing <select id="${prefix}-backing" data-pgnew="backing">${[["none", "None"], ["partial", "Partial"], ["works", "Full works team"]].map(([v, l]) => `<option value="${v}" ${cfg.backing === v ? "selected" : ""}>${l} (${M.fmt(G.BACKING[v], y)}/season)</option>`).join("")}</select></label>
      <label for="${prefix}-patience">Board patience <input id="${prefix}-patience" data-pgnew="patience" type="number" min="1" max="6" value="${cfg.patience ?? 2}" style="width:60px"><span class="muted small"> poor seasons before the backing is halved</span></label>
      <label for="${prefix}-engine">Engines <select id="${prefix}-engine" data-pgnew="engine"><option value="build" ${cfg.engine === "build" ? "selected" : ""}>Build our own</option>${G.ENGINE_TIERS.map((t) => `<option value="c${t.tier}" ${cfg.engine === "customer" && cfg.tier === t.tier ? "selected" : ""}>Customer, tier ${t.tier + 1}</option>`).join("")}</select></label>
      <label for="${prefix}-mentees"><input id="${prefix}-mentees" data-pgnew="mentees" type="checkbox" ${cfg.mentees === false ? "" : "checked"}> Some departments start with a mentee</label>
    </div></div>`;
}
export function setupInput(cfg, el) {
  const k = el.dataset.pgnew; if (!k) return false;
  if (k === "engine") { if (el.value === "build") cfg.engine = "build"; else { cfg.engine = "customer"; cfg.tier = Number(el.value.slice(1)); } }
  else if (k === "backing") cfg.backing = el.value;
  else if (k === "mentees") cfg.mentees = el.checked;
  else cfg[k] = Number(el.value);
  cfg.preset = "custom";
  return true;
}
