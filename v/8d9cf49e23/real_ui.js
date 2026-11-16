// Real Seasons dialog: new game (a real team, your own team, a real driver or your own driver), overview (your
// team's upgrades or your driver's skills), standings, driver market, drivers, calendar, history, saves.
// The engine is real.js; races are watched in the main viewer through hooks.watch().
import * as R from "./real.js";
import { UPGRADES, upgradeEffect, SKILL_UP, skillCost, carRating, index as kIndex, iconicOf, SKILL_MAX } from "./career.js";
import { simulateRace } from "./sim/race.js";
import { carThumb, helmetThumb } from "./thumbs.js";
import { unpackReal, importArchive, tally, seasonGrid, cellHTML } from "./archive.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const TABS = [["overview", "Overview"], ["standings", "Standings"], ["market", "Market"], ["drivers", "Drivers"],
  ["calendar", "Calendar"], ["history", "History"], ["save", "Save / load"]];
const NEW_MODES = [["team", "Run a real team"], ["custom", "Your own team"], ["rdriver", "Be a real driver"], ["me", "Your own driver"]];
const STORE_KEY = "realSeasons";

export class RealUI {
  // hooks: { store, trackFor(circuit, layout) -> Promise<track>, watch(cfg), setHelmet(id, url) }
  constructor(db, hooks) {
    this.db = db; this.h = hooks; this.S = null;
    try { const t = hooks.store.get(STORE_KEY); if (t && db.realSeasons) this.S = R.deserialize(db, t); } catch { this.S = null; }
    this.tab = "overview"; this.filter = ""; this.offerYears = 2;
    const ys = db.realSeasons ? R.seasonYears(db) : [];
    this.n = { mode: "team", year: ys[0] ?? 1950, maxRounds: 0, seed: 1 + Math.floor(Math.random() * 99999), team: null, driver: null,
               births: "real", name: "", code: "", tname: "", livery: R.defaultLivery(["#2a7fff", "#ffffff"]) };
    this.lvThumbs = new Map();
    this.trk = new Map();
    const dlg = $("real");
    dlg.addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (b && !b.disabled) this.act(b.dataset.act, b.dataset); });
    dlg.addEventListener("change", (e) => this.change(e));
    dlg.addEventListener("input", (e) => {
      const id = e.target.id;
      if (id === "rs-filter") { this.filter = e.target.value; this.renderBody(true); }
      else if (id === "rs-name") this.n.name = e.target.value;
      else if (id === "rs-code") this.n.code = e.target.value;
      else if (id === "rs-tname") this.n.tname = e.target.value;
    });
  }
  open(msg) {
    if (!this.db.realSeasons) { alert("The real season data did not load."); return; }
    this.render(); if (!$("real").open) $("real").showModal(); if (msg) this.msg(msg);
    this.checkResults();
  }
  // once per season and session: re-run the recorded rounds; any that differ are offered on the Calendar tab
  // (a bug before v47 could record the previous race's result for a watched round)
  async checkResults() {
    const S = this.S;
    if (!S || this.checkedYear === S.year || !S.results.some(Boolean) || this.checking) return;
    this.checking = true;
    try {
      this.fixes = await R.checkResults(this.db, S, this.h.trackFor, simulateRace);
      this.checkedYear = S.year;
      if (this.fixes.length) { this.render(); this.msg(`${this.fixes.length} recorded result${this.fixes.length === 1 ? " differs" : "s differ"} from a re-run of the race: see the Calendar tab.`); }
    } catch (e) { console.warn("result check", e); } finally { this.checking = false; }
  }
  msg(t) { $("rs-msg").textContent = t ?? ""; }
  save() { if (this.S) this.h.store.set(STORE_KEY, R.serialize(this.S)); }
  // ---------- helpers ----------
  dn(d) { return Number(d) === R.ME_RS ? this.S?.me?.name ?? "You" : R.driverName(this.db, d); }
  tn(ref) { return R.teamOf(this.S, ref)?.name ?? ref; }
  age(d, y = this.S.year) { if (Number(d) === R.ME_RS) return ""; const a = R.ageIn(this.db, d, y, this.S); return a == null ? "" : Math.floor(a); }
  form(d, y = this.S?.year ?? this.n.year) {
    const ix = kIndex(this.db), p = R.paceOf(this.db, this.S ?? { me: null }, d, y);
    return Math.max(1, Math.round(99 - (p - ix.sMin) * 18));
  }
  carOf(ref) { return this.S?.teams.find((t) => t.ref === ref)?.car ?? null; }
  hn(d) { return `<span class="th-name">${helmetThumb(d)}${esc(this.dn(d))}</span>`; }   // helmet + name
  carR(ref) { return carRating(this.db, R.carPace(this.db, this.S, ref)); }
  get team() { return this.S?.mode === "team" ? this.S.player.team : null; }
  get myDriver() { return this.S?.mode === "driver" ? String(this.S.player.driver) : null; }
  get myTeamNow() { return this.team ?? (this.S.contracts[this.myDriver]?.team ?? this.S.market?.held[this.myDriver]?.team ?? null); }
  money() { return this.S.mode === "team" ? this.S.money : this.S.me ? this.S.me.money : null; }

  // ---------- actions ----------
  act(a, ds) {
    const S = this.S, db = this.db;
    switch (a) {
      case "close": $("real").close(); return;
      case "tab": this.tab = ds.tab; break;
      case "newmode": this.n.mode = ds.m; break;
      case "lvtoggle": this.lvOpen = !this.lvOpen; return;
      case "attoggle": this.atOpen = !this.atOpen; return;
      case "hseason": this.hOpen = this.hOpen === Number(ds.y) ? null : Number(ds.y); break;
      case "fixres": case "keepres": {
        const k = (this.fixes ?? []).findIndex((x) => x.r === Number(ds.r));
        if (k < 0) return;
        const [f] = this.fixes.splice(k, 1);
        if (a === "fixres") { R.applyResult(S, f.r, f.rows); this.save(); this.msg(`${S.calendar[f.r].name}: re-run result used; standings updated.`); }
        break;
      }
      case "pickteam": this.n.team = ds.ref; break;
      case "pickdrv": this.n.driver = Number(ds.d); break;
      case "reseed": this.n.seed = 1 + Math.floor(Math.random() * 99999); this.n.driver = null; break;
      case "start": {
        const n = this.n, o = { seed: n.seed, startYear: n.year, maxRounds: n.maxRounds, births: n.births };
        try {
          if (n.mode === "team") { if (!n.team) return this.msg("Pick a team first."); this.S = R.newGame(db, { ...o, mode: "team", team: n.team }); }
          else if (n.mode === "custom") this.S = R.newGame(db, { ...o, mode: "team", team: R.CUSTOM, custom: { name: n.tname.trim() || "My Team", livery: n.livery } });
          else if (n.mode === "rdriver") { if (!n.driver) return this.msg("Pick a driver first."); this.S = R.newGame(db, { ...o, mode: "driver", driver: n.driver }); }
          else { if (!n.name.trim()) return this.msg("Choose your driver's name first."); this.S = R.newGame(db, { ...o, mode: "driver", me: { name: n.name.trim(), code: n.code } }); }
        } catch (e) { return this.msg(e.message); }
        this.tab = this.S.mode === "team" && R.openSeats(this.S, this.team) > 0 ? "market" : "overview";
        this.save();
        this.msg(`${this.S.year}: the offseason market is open.` + (this.S.mode === "team" ? " Sign drivers for any open seats (or let your staff do it), then start the season." : " Run the market and answer the offers."));
        break;
      }
      case "quit": if (!this.armed("quit", "Click again to end this game (it is not saved unless you downloaded it).")) return; this.S = null; this.h.store.set(STORE_KEY, null); R.detachMe(db); R.detachCustomCar(db); break;
      case "mround": R.marketRound(db, S); break;
      case "mrun": R.runMarket(db, S); if (S.market.myOffers.length) this.tab = "market"; break;
      case "mstaff": R.marketRound(db, S, { staff: true }); break;
      case "offer": S.market.userOffers[ds.d] = this.offerYears; this.msg(`Offer ready for ${this.dn(ds.d)} (${this.offerYears} seasons): it goes out with the next round.`); break;
      case "unoffer": delete S.market.userOffers[ds.d]; break;
      case "maccept": R.acceptOffer(db, S, Number(ds.k)); break;
      case "mdecline": R.declineOffer(S, Number(ds.k)); break;
      case "startseason": {
        if (!R.startSeason(db, S)) return this.msg("Sign drivers for your open seats first (or press Staff fill my seats).");
        this.tab = "overview"; this.msg(`${S.year} season: ${S.calendar.length} rounds.`); break;
      }
      case "watch": { this.save(); const cfg = R.raceConfig(db, S, S.round); $("real").close(); this.h.watch(cfg); return; }
      case "sim": {
        this.msg("Simulating…");
        const cfg = R.raceConfig(db, S, S.round);
        this.h.trackFor(cfg.circuit, cfg.layout).then((trk) => {
          const out = simulateRace(db, { ...cfg, calls: [] }, trk);
          R.recordRace(db, S, cfg, out, []);
          this.save(); this.render();
          const w = S.results[S.round - 1]?.find((x) => x.pos === 1);
          this.msg(w ? `${cfg.name}: won by ${this.dn(w.d)} (${this.tn(w.team)}).` : "");
        });
        return;
      }
      case "simall": {
        this.msg("Simulating the rest of the season…");
        const step = () => {
          if (S.phase !== "season") { this.save(); this.render(); this.msg("Season complete."); return; }
          const cfg = R.raceConfig(db, S, S.round);
          this.h.trackFor(cfg.circuit, cfg.layout).then((trk) => { R.recordRace(db, S, cfg, simulateRace(db, { ...cfg, calls: [] }, trk), []); this.renderBody(); setTimeout(step, 0); });
        };
        step(); return;
      }
      case "replay": { const c = S.replays?.[Number(ds.r)]; if (c) { $("real").close(); this.h.watch({ ...c, real: { ...c.real, replay: true } }); } return; }
      case "endseason": {
        const y = S.year; R.endSeason(db, S);
        this.tab = "overview";
        this.msg(S.phase === "done" ? "That was the last season." : `${y} is done. The ${S.year} offseason market is open.`);
        break;
      }
      case "up": this.msg(R.buyUpgrade(db, S, ds.s) ? `${UPGRADES[ds.s].label} is now level ${S.up[ds.s]}.` : "Not enough money."); break;
      case "skill": this.msg(R.buySkill(db, S, ds.s) ? `${SKILL_UP[ds.s].label} is now level ${S.me.lv[ds.s]}.` : "Not enough money."); break;
      case "download": this.download(); return;
      case "lvrandom": {
        const K = this.h.livery?.(); if (!K) return this.msg("The livery kit is still loading.");
        this.setLv(K.L.randomLivery(K.kit, this.lvYear(), 1 + Math.floor(Math.random() * 1e9))); return;
      }
      case "lvnosp": this.setLv({ ...this.curLv(), sponsors: [] }); return;
    }
    this.save(); this.render();
  }
  change(e) {
    const el = e.target, n = this.n;
    if (el.id === "rs-year") { n.year = Number(el.value); n.team = null; n.driver = null; }
    else if (el.id === "rs-cmaxr") {
      const now = R.setMaxRounds(this.db, this.S, el.value); this.save(); this.render();
      this.msg(now ? `The ${this.S.year} calendar now has ${this.S.calendar.length} rounds.` : `From the next offseason, seasons are cut to ${this.S.maxRounds || "the full calendar"}${this.S.maxRounds ? " rounds" : ""}.`);
      return;
    }
    else if (el.id === "rs-maxr") n.maxRounds = Math.max(0, Math.min(40, Math.floor(Number(el.value) || 0)));
    else if (el.id === "rs-seed") { n.seed = Math.max(1, Math.floor(Number(el.value) || 1)); n.driver = null; }
    else if (el.id === "rs-births") { n.births = el.value; n.driver = null; }
    else if (el.id?.startsWith("lv-")) {
      const lv = JSON.parse(JSON.stringify(this.curLv())), k = el.id.slice(3);
      if (["base", "c2", "c3"].includes(k)) lv.colors[k] = el.value;
      else if (k === "harmony") { const K = this.h.livery?.(); if (K && el.value) Object.assign(lv.colors, K.L.harmony(lv.colors.base, el.value)); }
      else if (k === "number") lv.number = el.value.replace(/[^0-9]/g, "").slice(0, 2) || "1";
      else if (k === "scheme" || k === "number_style" || k === "digit_font") lv[k] = el.value;
      this.setLv(lv); return;
    }
    else if (el.id === "rs-oyears") { this.offerYears = Number(el.value); return; }
    else if (el.id === "rs-only") { this.onlyYes = el.checked; this.renderBody(); return; }
    else if (el.id === "rs-arcfile") {
      const fs = [...(el.files ?? [])]; if (!fs.length || !this.S) return;
      Promise.all(fs.map((f) => f.text().then((t) => { try { return JSON.parse(t); } catch { return null; } }))).then((objs) => {
        const r = importArchive(this.S, objs.filter(Boolean), R.KIND);
        this.save(); this.render();
        const yrs = (a) => a.join(", ");
        this.msg(r.filled.length || r.partial.length
          ? `Race results restored: ${yrs(r.filled) || "none complete"}${r.partial.length ? `; partly (some rounds weren't in any save): ${yrs(r.partial)}` : ""}.${r.skipped ? ` ${r.skipped} file(s) were from other games.` : ""}`
          : `Nothing to restore from those files${r.skipped ? ` (${r.skipped} were from other games)` : ""}.`);
      });
      return;
    }
    else if (el.id === "rs-file") {
      const f = el.files?.[0]; if (!f) return;
      f.text().then((t) => {
        try { this.S = R.deserialize(this.db, t); this.tab = "overview"; this.save(); this.render(); this.msg(`Loaded ${f.name}.`); }
        catch (err) { this.msg(`Could not load that file: ${err.message}`); }
      });
      return;
    } else return;
    this.render();
  }
  armed(key, prompt) {
    if (this.arm && this.arm.key === key && Date.now() - this.arm.at < 6000) { this.arm = null; return true; }
    this.arm = { key, at: Date.now() }; this.msg(prompt); return false;
  }
  // called by the viewer when a Real Seasons race reaches the flag
  finished(cfg, out, calls) {
    if (!this.S || !cfg.real || cfg.real.replay) return false;
    const ok = R.recordRace(this.db, this.S, cfg, out, calls ?? []);
    if (ok) this.save();
    return ok;
  }
  async download() {
    const text = R.serialize(this.S), name = `fantasy-gp-real-${this.S.year}.json`;
    try {
      const dl = globalThis.claude?.use ? await globalThis.claude.use("downloads") : null;
      if (dl) { await dl.save({ filename: name, data: text }); this.msg("Save file downloaded."); return; }
    } catch (e) { if (e?.code === "declined") { this.msg("Download cancelled."); return; } }
    try {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "application/json" })); a.download = name;
      document.body.appendChild(a); a.click(); a.remove(); this.msg("Save file downloaded.");
    } catch { this.msg("Could not download the save."); }
  }

  // ---------- render ----------
  render() {
    const S = this.S;
    $("rs-title").textContent = S ? `Real Seasons · ${S.mode === "team" ? this.tn(this.team) : this.dn(this.myDriver)} · ${S.year}` : "Real Seasons";
    const m = S ? this.money() : null;
    $("rs-money").hidden = m == null; if (m != null) $("rs-money").textContent = R.fmtM(m);
    $("rs-tabs").innerHTML = S ? TABS.map(([k, l]) => `<button class="${this.tab === k ? "on" : ""}" data-act="tab" data-tab="${k}">${l}${k === "market" && S.market ? " ●" : ""}</button>`).join("") : "";
    $("rs-actions").innerHTML = S ? this.actions() : "";
    this.renderBody();
  }
  actions() {
    const S = this.S, b = (act, txt, cls = "", extra = "") => `<button class="btn ${cls}" data-act="${act}" ${extra}>${txt}</button>`;
    if (S.phase === "market") {
      const start = b("startseason", `Start ${S.year} season`, S.market.done ? "primary" : "", 'title="Runs the rest of the market first"');
      if (S.mode === "driver") return b("mrun", "Run the market", S.market.done ? "" : "primary", 'title="Rounds run until a team makes you an offer, or the market closes"') + b("mround", `Next round (${S.market.round + 1})`) + start;
      const n = Object.keys(S.market.userOffers).length;
      return b("mround", `Send offers · round ${S.market.round + 1}${n ? ` (${n})` : ""}`, S.market.done ? "" : "primary") + b("mrun", "Run the market", "", 'title="Rounds run until only your seats are open"') +
        b("mstaff", "Staff fill my seats", "", 'title="Your staff make offers for your open seats this round"') + start;
    }
    if (S.phase === "season") {
      const c = S.calendar[S.round];
      return b("watch", `Watch R${S.round + 1}: ${esc(c.name)}`, "primary") + b("sim", "Sim it") + b("simall", "Sim the rest");
    }
    if (S.phase === "review") return b("endseason", `End ${S.year} season`, "primary");
    return "";
  }
  renderBody(keepFocus = false) {
    const body = $("rs-body"), fpos = keepFocus ? $("rs-filter")?.selectionStart : null;
    body.innerHTML = !this.S ? this.newView() : this[`${this.tab}View`]?.() ?? "";
    this.h.paint?.(body);
    if (keepFocus && $("rs-filter")) { $("rs-filter").focus(); $("rs-filter").setSelectionRange(fpos, fpos); }
  }

  newView() {
    const db = this.db, n = this.n, ys = R.seasonYears(db), sea = db.realSeasons.seasons[n.year];
    const modes = `<nav class="cr-tabs sub">${NEW_MODES.map(([m, l]) => `<button class="${n.mode === m ? "on" : ""}" data-act="newmode" data-m="${m}">${l}</button>`).join("")}</nav>`;
    const opts = `<div class="su-bar">
      <label class="inline" for="rs-year">Start season <select id="rs-year">${ys.map((y) => `<option value="${y}" ${y === n.year ? "selected" : ""}>${y}${y === ys[0] ? " (earliest)" : ""}</option>`).join("")}</select></label>
      <label class="inline" for="rs-maxr" title="0 = the full real calendar. Otherwise longer seasons are cut down to this many rounds, dropping the least iconic venues first">Max rounds a season <input id="rs-maxr" type="number" min="0" max="40" value="${n.maxRounds}" style="width:60px"></label>
      <label class="inline" for="rs-births" title="Real: every driver is born when they really were and makes their debut in their real rookie year. Shuffled: everyone gets another driver's birth year (the seed decides), and their whole career moves with it, at the same ages; the first season starts with every seat open">Birth years <select id="rs-births"><option value="real" ${n.births === "real" ? "selected" : ""}>Real</option><option value="shuffled" ${n.births === "shuffled" ? "selected" : ""}>Shuffled</option></select></label>
      <label class="inline" for="rs-seed">Seed <input id="rs-seed" type="number" min="1" value="${n.seed}" style="width:90px"></label>
      <button class="btn" data-act="reseed">New seed</button>
      <span class="spacer"></span>
      <button class="btn primary" data-act="start">Start</button></div>`;
    const intro = `<p>Every real season in order from ${n.year}: the real teams and their real cars, the real calendar (${sea.rounds.length} rounds in ${n.year}), the real points system. Drivers age; after their real careers they carry on along the age curve until they retire. The driver market is open every offseason. CPU teams don't upgrade their cars; yours can.</p>`;
    let pick = "";
    if (n.mode === "team") {
      pick = `<h3>Choose a ${n.year} team</h3><div class="cr-teams">${sea.teams.map((t) => {
        const car = db._ix?.cars.get(t.car) ?? db.cars.find((c) => c.id === t.car);
        return `<button class="cr-team ${n.team === t.ref ? "on" : ""}" data-act="pickteam" data-ref="${esc(t.ref)}" style="--tc:${car?.colours?.[0] ?? "#888"}">
          ${carThumb(t.car, t.drivers[0], 96, 30)}<b>${esc(t.name)}</b><span>Car ${carRating(db, car?.pace ?? 9)} · ${t.seats} seat${t.seats === 1 ? "" : "s"} · ${t.drivers.slice(0, t.seats).map((d) => esc(R.driverName(db, d))).join(", ")}</span></button>`;
      }).join("")}</div>`;
    } else if (n.mode === "custom") {
      pick = `<div class="cr-drvform"><div class="cr-drvfields">
        <label for="rs-tname">Team name <input id="rs-tname" maxlength="30" value="${esc(n.tname)}" placeholder="My Team"></label>
        </div><div class="cr-note" style="max-width:520px">Your team starts with two empty seats and ${R.fmtM(R.START_MONEY.custom)}. Its car starts a little slower than the usual slowest car of each season and, fully upgraded, is as dominant as the best cars in history were in theirs.</div></div>
        <h3>Livery</h3>${this.liveryEditor()}`;
    } else if (n.mode === "rdriver") {
      const f = this.filter.toLowerCase();
      const S0 = { me: null, retired: {}, contracts: {}, year: n.year, shift: n.births === "shuffled" ? this.previewShift() : {} };
      this.S0 = S0;
      const list = R.pool(db, S0).map(Number).filter((d) => !f || R.driverName(db, d).toLowerCase().includes(f))
        .map((d) => [d, R.paceOf(db, S0, d, n.year)]).sort((a, b) => a[1] - b[1]).slice(0, 80);
      pick = `<h3>Choose a driver <small>(everyone who has made their debut by ${n.year}, fastest first)</small></h3>
        <input id="rs-filter" placeholder="Filter by name" value="${esc(this.filter)}" style="max-width:260px">
        <table class="cr-t"><thead><tr><th></th><th>Driver</th><th>Born</th><th>Age</th><th>Form</th><th>${n.births === "shuffled" ? "Debut" : `Real ${n.year} team`}</th></tr></thead><tbody>${list.map(([d]) => {
          const a = R.ageIn(db, d, n.year, S0), team = sea.teams.find((t) => t.drivers.includes(d));
          return `<tr class="${n.driver === d ? "mine" : ""}"><td><button class="btn" data-act="pickdrv" data-d="${d}">${n.driver === d ? "✓" : "Pick"}</button></td><td><span class="th-name">${helmetThumb(d)}${esc(R.driverName(db, d))}</span></td><td class="n">${Math.floor(R.birthOf(db, S0, d))}</td><td class="n">${a == null ? "" : Math.floor(a)}</td><td class="n">${this.formOfNew(d)}</td><td>${n.births === "shuffled" ? R.debutOf(db, S0, d) : esc(team?.name ?? "")}</td></tr>`;
        }).join("")}</tbody></table>`;
    } else {
      pick = `<div class="cr-drvform"><div class="cr-drvfields">
        <label for="rs-name">Name <input id="rs-name" maxlength="40" value="${esc(n.name)}"></label>
        <label for="rs-code">Code <input id="rs-code" maxlength="3" value="${esc(n.code)}" style="width:60px"></label></div>
        <div class="cr-note" style="max-width:520px">As in the career: your driver starts with every skill at the bottom and ${R.fmtM(R.START_MONEY.driver)} to spend; salary and results pay for more. Teams scout you like anyone else; if nobody signs you, the slowest team gives you a one-season drive.</div></div>`;
    }
    const loads = `<h3>Or load a game</h3><div class="su-bar"><label class="btn file" for="rs-file">Load save file<input type="file" id="rs-file" accept=".json,application/json" hidden></label></div>`;
    return modes + `<div class="cr-new">${intro}${opts}${pick}${loads}</div>`;
  }
  // ---------- livery (own team; session -18's livery kit) ----------
  curLv() { return this.S?.custom ? this.S.custom.livery ?? R.defaultLivery(this.S.custom.colours) : this.n.livery; }
  lvYear() { return this.S ? this.S.year : this.n.year; }
  setLv(lv) {
    if (this.S?.custom) { R.setLivery(this.db, this.S, lv); this.save(); }
    else this.n.livery = lv;
    this.render();
  }
  lvThumb(K, year, lv) {
    const key = `${K.L.seasonFor(K.kit, year)}|${JSON.stringify(lv)}`;
    if (!this.lvThumbs.has(key)) {
      try { this.lvThumbs.set(key, K.L.renderLivery(K.kit, K.L.seasonFor(K.kit, year), lv).toDataURL()); } catch { this.lvThumbs.set(key, ""); }
      if (this.lvThumbs.size > 120) this.lvThumbs.delete(this.lvThumbs.keys().next().value);
    }
    return this.lvThumbs.get(key);
  }
  liveryEditor() {
    const lv = this.curLv(), K = this.h.livery?.(), y = this.lvYear();
    const col = (k, l) => `<label for="lv-${k}">${l} <input id="lv-${k}" type="color" value="${esc(lv.colors[k] ?? "#888888")}"></label>`;
    if (!K) return `<div class="cr-drvfields">${col("base", "Main colour")}${col("c2", "Second colour")}${col("c3", "Trim")}
      <span class="muted small">The livery painter is still loading; until then the car is drawn in these colours.</span></div>`;
    const era = K.kit.meta.shapes[K.L.seasonFor(K.kit, y)].era, inEra = new Set(K.L.eraSchemes(K.kit, era));
    const sel = (k, opts, cur) => `<select id="lv-${k}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const years = [...new Set([y, 1925, 1955, 1965, 1978, 1992, 2008, 2024])].sort((a, b) => a - b);
    const thumbs = years.map((yy) => `<figure class="rs-lvf ${yy === y ? "on" : ""}"><img alt="Your car in ${yy}" src="${this.lvThumb(K, yy, lv)}"><figcaption>${yy}</figcaption></figure>`).join("");
    return `<div class="rs-lv"><div class="rs-lvthumbs">${thumbs}</div><div class="cr-drvfields">
      <label for="lv-scheme">Scheme ${sel("scheme", K.kit.meta.schemes.map((x) => [x.id, x.name + (inEra.has(x.id) ? "" : " (other eras)")]), lv.scheme)}</label>
      ${col("base", "Main colour")}${col("c2", "Second colour")}${col("c3", "Trim")}
      <label for="lv-harmony">Suggest colours ${sel("harmony", [["", "from the main colour"], ...Object.entries(K.L.HARMONIES)], "")}</label>
      <label for="lv-number">Number <input id="lv-number" value="${esc(lv.number)}" maxlength="2" style="width:50px"></label>
      <label for="lv-number_style">Number style ${sel("number_style", ["roundel", "ring", "panel", "oval", "plain"].map((v) => [v, v]), lv.number_style)}</label>
      <label for="lv-digit_font">Digits ${sel("digit_font", ["classic", "condensed", "modern"].map((v) => [v, v]), lv.digit_font)}</label>
      <div class="su-bar"><button class="btn" data-act="lvrandom" title="A period-correct livery for ${y}">Random period livery</button>
        ${lv.sponsors?.length ? `<button class="btn" data-act="lvnosp">Remove sponsors (${lv.sponsors.length})</button>` : ""}</div>
      <span class="muted small">One livery follows your team through every era: the season picks the car's shape.</span></div></div>`;
  }
  previewShift() {
    if (this.shiftKey !== this.n.seed) { this.shiftKey = this.n.seed; this.shiftPrev = R.shuffledShift(this.db, this.n.seed); }
    return this.shiftPrev;
  }
  formOfNew(d) { const ix = kIndex(this.db), p = R.paceOf(this.db, { me: null, shift: this.n.births === "shuffled" ? this.previewShift() : {} }, d, this.n.year); return Math.max(1, Math.round(99 - (p - ix.sMin) * 18)); }

  overviewView() {
    const S = this.S, db = this.db;
    const phase = S.phase === "market" ? `Offseason before ${S.year}: the driver market is ${S.market.done ? "closed — start the season when ready" : "open"}.`
      : S.phase === "season" ? `${S.year}: round ${S.round + 1} of ${S.calendar.length} next (${esc(S.calendar[S.round].name)}).`
      : S.phase === "review" ? `${S.year} is complete.` : "The last season with real data is done.";
    let card = "";
    if (S.mode === "team") {
      const ref = this.team, t = R.teamOf(S, ref), ds = R.driversOf(S, ref), held = S.market ? R.heldBy(S, ref) : [];
      const ups = Object.entries(UPGRADES).map(([k, u]) => {
        const lv = S.up[k], cost = R.upgradeCost(S, k);
        const eff = k === "pace" ? (ref === R.CUSTOM ? `car ${this.carR(ref)}` : `${upgradeEffect("pace", lv).toFixed(2)}%`) : `x${upgradeEffect(k, lv).toFixed(2)}`;
        return `<div class="cr-up"><span>${u.label}</span><span class="lv">${"■".repeat(lv)}${"□".repeat(u.max - lv)}</span><span class="n">${eff}</span>
          ${cost === null ? "<span class=\"muted\">max</span>" : `<button class="btn" data-act="up" data-s="${k}" ${S.money < cost ? "disabled" : ""}>+1 · ${R.fmtM(cost)}</button>`}</div>`;
      }).join("");
      card = `<div class="cr-card"><header><b>${esc(t?.name ?? "")}</b><span class="chip">Car ${t ? this.carR(ref) : "—"}</span><span class="muted">${esc(t?.car ?? "")}</span></header>
        <div>Drivers: ${[...ds, ...held].map((d) => `${esc(this.dn(d))} (${this.age(d)}, form ${this.form(d)})`).join(", ") || "<span class=\"muted\">none yet</span>"}</div>
        <div class="cr-ups">${ups}</div>
        ${ref === R.CUSTOM ? `<details class="cr-hedit" ${this.lvOpen ? "open" : ""}><summary data-act="lvtoggle">Livery</summary>${this.liveryEditor()}</details>` : ""}
        <div class="muted small">${ref === R.CUSTOM ? "Pace upgrades move your car from a little behind the usual slowest car of the season (level 0) to as dominant as the best cars ever (level 10)." : "Pace upgrades take a share off your real car's lap time; CPU teams don't upgrade."}</div></div>`;
    } else {
      const d = this.myDriver, team = this.myTeamNow;
      const skills = S.me ? `<div class="cr-ups">${Object.entries(SKILL_UP).map(([k, u]) => {
        const lv = S.me.lv[k] ?? 0, cost = skillCost(k, lv);
        return `<div class="cr-up"><span>${u.label}</span><span class="lv">${"■".repeat(lv)}${"□".repeat(SKILL_MAX - lv)}</span><span class="n">${lv}</span>
          ${cost === null ? "<span class=\"muted\">max</span>" : `<button class="btn" data-act="skill" data-s="${k}" ${S.me.money < cost ? "disabled" : ""}>+1 · ${R.fmtM(cost)}</button>`}</div>`;
      }).join("")}</div>` : `<div class="muted small">Age ${this.age(d)}. Form follows the real seasons, then the age curve.</div>`;
      card = `<div class="cr-card cr-me"><header><b>${esc(this.dn(d))}</b><span class="chip">Form ${this.form(d)}</span></header>
        <div>${team ? `Driving for ${esc(this.tn(team))} (car ${this.carR(team)})${S.contracts[d] ? `, ${S.contracts[d].left} season${S.contracts[d].left === 1 ? "" : "s"} left` : ""}` : "No drive yet."}</div>${skills}</div>`;
    }
    const st = R.driverStandings(S).slice(0, 5);
    const lead = S.results.length ? `<div class="cr-card"><header><b>Championship</b></header>${st.map((s, k) => `<div>${k + 1}. ${esc(this.dn(s.d))} <span class="muted">${esc(this.tn(s.team))}</span> · ${s.pts}</div>`).join("")}</div>` : "";
    const news = S.news.slice(-12).reverse().map((x) => `<li class="${x.mine ? "mine" : ""}">${x.year}: ${esc(x.text)}</li>`).join("");
    return `<div class="cr-note">${phase}</div><div class="cr-cards">${card}${lead}</div><h3>News</h3><ul class="cr-log">${news || "<li class=\"muted\">Nothing yet.</li>"}</ul>
      <div class="su-bar"><button class="btn" data-act="quit">${"End this game"}</button></div>`;
  }
  standingsView() {
    const S = this.S, ds = R.driverStandings(S), ts = R.teamStandings(S);
    if (!ds.length) return `<div class="cr-note">No races yet this season.</div>`;
    const mineD = (d) => d === this.myDriver, mineT = (t) => t === this.myTeamNow;
    return `<div class="cr-cols"><div><h4>Drivers ${S.year}</h4><table class="cr-t"><thead><tr><th>#</th><th></th><th>Driver</th><th>Team</th><th>Pts</th><th>Wins</th></tr></thead><tbody>${ds.map((s, k) =>
      `<tr class="${mineD(s.d) || mineT(s.team) ? "mine" : ""}"><td class="n">${k + 1}</td><td class="th-cell">${carThumb(this.carOf(s.team), s.d)}</td><td>${esc(this.dn(s.d))}</td><td>${esc(this.tn(s.team))}</td><td class="n b">${s.pts}</td><td class="n">${s.wins}</td></tr>`).join("")}</tbody></table></div>
      <div><h4>Constructors</h4><table class="cr-t"><thead><tr><th>#</th><th></th><th>Team</th><th>Pts</th><th>Wins</th></tr></thead><tbody>${ts.map((s, k) =>
      `<tr class="${mineT(s.team) ? "mine" : ""}"><td class="n">${k + 1}</td><td class="th-cell">${carThumb(this.carOf(s.team), ds.find((x) => x.team === s.team)?.d)}</td><td>${esc(this.tn(s.team))}</td><td class="n b">${s.pts}</td><td class="n">${s.wins}</td></tr>`).join("")}</tbody></table>
      <p class="muted small">Points: ${R.pointsFor(S.year).join("-")} (the ${S.year} system${S.year < 1950 ? ", as 1950" : ""}).</p></div></div>`;
  }
  marketView() {
    const S = this.S, db = this.db, M = S.market;
    if (!M) return `<div class="cr-note">The market opens after the season.</div>`;
    const logs = M.log.slice(-40).reverse().map((x) => `<li class="${x.mine ? "mine" : ""}">R${x.r}: ${esc(x.text)}</li>`).join("");
    if (S.mode === "driver") {
      const offers = M.myOffers.map((o, k) => `<div class="cr-seat">${carThumb(this.carOf(o.team), this.myDriver)} <b>${esc(this.tn(o.team))}</b> · car ${this.carR(o.team)} · ${o.years} season${o.years === 1 ? "" : "s"} · ${R.fmtM(o.salary)}/season
        <button class="btn primary" data-act="maccept" data-k="${k}">Accept</button> <button class="btn" data-act="mdecline" data-k="${k}">Decline</button></div>`).join("");
      const held = M.held[this.myDriver];
      return `<div class="cr-market"><div class="cr-mleft"><h3>Offers to you</h3>${offers || `<div class="muted">${held ? `Signed with ${esc(this.tn(held.team))}. A better offer can still come.` : "None yet: run the market."}</div>`}</div>
        <div><h3>Market log</h3><ul class="cr-log">${logs}</ul></div></div>`;
    }
    const ref = this.team, open = R.openSeats(S, ref), f = this.filter.toLowerCase();
    const cands = R.pool(db, S).filter((d) => (!f || this.dn(d).toLowerCase().includes(f)) && (!this.onlyYes || R.wouldSign(db, S, d, ref)))
      .map((d) => [d, R.paceOf(db, S, d, S.year)]).sort((a, b) => a[1] - b[1]).slice(0, 60);
    const heldMine = R.heldBy(S, ref), firm = R.driversOf(S, ref);
    const left = `<h3>Your seats <small>${open > 0 ? `${open} open` : "all filled"}</small></h3>
      ${firm.map((d) => `<div class="cr-seat">${this.hn(d)} · form ${this.form(d)} · contract ${S.contracts[d].left} more</div>`).join("")}
      ${heldMine.map((d) => `<div class="cr-seat">${this.hn(d)} · form ${this.form(d)} · signed (${M.held[d].years} seasons)</div>`).join("")}
      ${Object.keys(M.userOffers).length ? `<h3>Offers going out next round</h3>${Object.entries(M.userOffers).map(([d, y]) => `<div class="cr-seat">${esc(this.dn(d))} · ${y} seasons <button class="btn x" data-act="unoffer" data-d="${d}">✕</button></div>`).join("")}` : ""}
      <label class="inline" for="rs-oyears">Contract length <select id="rs-oyears">${[1, 2, 3, 4].map((y) => `<option ${y === this.offerYears ? "selected" : ""}>${y}</option>`).join("")}</select></label>
      <h3>Market log</h3><ul class="cr-log">${logs}</ul>`;
    const rows = cands.map(([d]) => {
      const h = M.held[d], rej = (M.rejected[d] ?? []).includes(ref), yes = R.wouldSign(db, S, d, ref);
      return `<tr><td>${this.hn(d)}</td><td class="n">${this.age(d)}</td><td class="n b">${this.form(d)}</td><td>${h ? `signed: ${esc(this.tn(h.team))}` : "free"}</td>
        <td>${rej ? "<span class=\"muted\">turned you down</span>" : M.userOffers[d] ? "offered" : !yes ? `<span class="muted">prefers ${esc(this.tn(h.team))}'s car</span>` : open > 0 ? `<button class="btn" data-act="offer" data-d="${d}">Offer</button>` : ""}</td></tr>`;
    }).join("");
    return `<div class="cr-market"><div class="cr-mleft">${left}</div><div><h3>Drivers available <small>(not under contract; a driver signs for the fastest car offered — a driver already signed elsewhere only moves for a faster car)</small></h3>
      <label class="inline"><input type="checkbox" id="rs-only" ${this.onlyYes ? "checked" : ""}> Only drivers who would sign for you</label>
      <input id="rs-filter" placeholder="Filter by name" value="${esc(this.filter)}" style="max-width:260px">
      <table class="cr-t"><thead><tr><th>Driver</th><th>Age</th><th>Form</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }
  driversView() {
    const S = this.S;
    const rows = [...S.teams].sort((a, b) => R.carPace(this.db, S, a.ref) - R.carPace(this.db, S, b.ref)).map((t) => {
      const ds = [...R.driversOf(S, t.ref), ...(S.market ? R.heldBy(S, t.ref) : [])];
      return `<tr class="${t.ref === this.myTeamNow ? "mine" : ""}"><td class="th-cell">${carThumb(t.car, ds[0])}</td><td><b>${esc(t.name)}</b></td><td class="n">${this.carR(t.ref)}</td><td>${ds.map((d) =>
        `${this.hn(d)} <span class="muted">${this.age(d)} · ${this.form(d)}${S.contracts[d] ? ` · ${S.contracts[d].left}y` : ""}</span>`).join("<br>") || "<span class=\"muted\">—</span>"}</td><td class="n">${t.seats}</td></tr>`;
    }).join("");
    return `<p class="muted small">Teams by car (fastest first). Driver: age · form · seasons left on the contract.</p>
      <table class="cr-t"><thead><tr><th></th><th>Team</th><th>Car</th><th>Drivers</th><th>Seats</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  calendarView() {
    const S = this.S, db = this.db, full = db.realSeasons.seasons[S.year].rounds.length;
    const rows = S.calendar.map((c, r) => {
      const res = S.results[r], w = res?.find((x) => x.pos === 1), mine = res?.filter((x) => x.d === this.myDriver || x.team === this.myTeamNow);
      return `<tr class="${S.phase === "season" && r === S.round ? "next" : ""}"><td class="n">${r + 1}</td><td>${esc(c.name)}</td><td class="muted">${esc(c.layout)} · iconic ${iconicOf(db, c.layout)}</td>
        <td>${w ? this.hn(w.d) : ""}</td><td>${mine?.length ? mine.map((x) => x.fin ? `P${x.pos}` : "DNF").join(", ") : ""}</td><td>${S.replays?.[r] ? `<button class="btn" data-act="replay" data-r="${r}">Replay</button>` : ""}</td></tr>`;
    }).join("");
    const fixes = (this.fixes ?? []).filter((f) => S.results[f.r]).map((f) => {
      const win = (rows) => rows.find((x) => x.pos === 1), mineOf = (rows) => rows.filter((x) => x.d === this.myDriver || x.team === this.myTeamNow).map((x) => x.fin ? `P${x.pos}` : "DNF").join(", ") || "—";
      return `<div class="cr-seat">R${f.r + 1} ${esc(S.calendar[f.r].name)}: recorded winner <b>${esc(this.dn(win(S.results[f.r])?.d))}</b> (yours ${mineOf(S.results[f.r])}); re-run winner <b>${esc(this.dn(win(f.rows)?.d))}</b> (yours ${mineOf(f.rows)})
        <button class="btn primary" data-act="fixres" data-r="${f.r}">Use the re-run</button> <button class="btn" data-act="keepres" data-r="${f.r}">Keep the recorded one</button></div>`;
    }).join("");
    const lim = `<div class="su-bar"><label class="inline" for="rs-cmaxr" title="0 = the full real calendar. Longer seasons are cut down to this many rounds, least iconic venues first. You can change it in any offseason; mid-season it applies from the next one">Max rounds a season <input id="rs-cmaxr" type="number" min="0" max="40" value="${S.maxRounds ?? 0}" style="width:60px"></label>
      <span class="muted small">${S.phase === "market" ? `Applies to the ${S.year} season.` : "Takes effect from the next offseason."} 0 = the full real calendar (${full} rounds in ${S.year}).</span></div>`;
    return `${lim}${fixes ? `<div class="cr-note"><b>Check these results.</b> Before v47 a watched race could be recorded with the result of the race watched before it. These rounds come out differently when re-run. If the recorded one isn't what you saw, use the re-run (it is the same race, but data updates since, or strategy calls you made, can still change it a little).</div>${fixes}` : ""}
      <p class="muted small">The real ${S.year} calendar${S.calendar.length < full ? `, cut from ${full} to ${S.calendar.length} rounds (least iconic venues dropped)` : ""}.</p>
      <table class="cr-t"><thead><tr><th>#</th><th>Race</th><th>Layout</th><th>Winner</th><th>Yours</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  // ---------- race-by-race history (archive.js) ----------
  seasonGridHTML(h) {
    const races = h.races.map((r) => unpackReal(r.res)), grid = seasonGrid(races);
    const tname = (ref) => h.teamNames?.[ref] ?? this.tn(ref);
    const head = h.races.map((r) => `<th class="rg-h" title="${esc(r.name ?? r.circuit)}">${esc(String(r.circuit ?? "").replace(/^pw_/, "").slice(0, 3).toUpperCase())}</th>`).join("");
    const body = grid.map((s, k) => `<tr class="${s.k === this.myDriver || s.x.team === this.myTeamNow ? "mine" : ""}"><td class="n">${k + 1}</td><td>${this.hn(s.k)}</td><td class="muted">${esc(tname(s.x.team))}</td>${h.races.map((r, i) => r.res ? cellHTML(s.cells[i]) : `<td class="rg-c na" title="not saved">·</td>`).join("")}<td class="n b">${s.pts}</td></tr>`).join("");
    const missing = h.races.filter((r) => !r.res).length;
    return `<div class="rg-wrap"><table class="cr-t rg"><thead><tr><th>#</th><th>Driver</th><th>Team</th>${head}<th>Pts</th></tr></thead><tbody>${body}</tbody></table></div>
      ${missing ? `<p class="muted small">${missing} round${missing === 1 ? "" : "s"} of this season weren't in any save (·); the totals here leave them out.</p>` : ""}`;
  }
  allTimeHTML() {
    const S = this.S, titles = new Map();
    for (const h of S.history) if (h.champion) titles.set(h.champion.d, (titles.get(h.champion.d) ?? 0) + 1);
    const races = [...S.history.flatMap((h) => (h.races ?? []).map((r) => unpackReal(r.res)).filter(Boolean)), ...S.results.filter(Boolean)];
    const st = tally(races, titles).slice(0, 40), withRaces = S.history.filter((h) => h.races?.some((r) => r.res)).length;
    return `<details class="cr-hedit" ${this.atOpen ? "open" : ""}><summary data-act="attoggle">All-time records</summary>
      <p class="muted small">${races.length} races (${withRaces} of ${S.history.length} finished seasons have race results${S.results.some(Boolean) ? ", plus this season so far" : ""}); titles from every season.</p>
      <table class="cr-t"><thead><tr><th>#</th><th>Driver</th><th>Titles</th><th>Wins</th><th>Podiums</th><th>Poles</th><th>Starts</th><th>Points</th></tr></thead><tbody>${st.map((s, k) =>
        `<tr class="${s.d === this.myDriver ? "mine" : ""}"><td class="n">${k + 1}</td><td>${this.hn(s.d)}</td><td class="n b">${s.titles || ""}</td><td class="n">${s.wins || ""}</td><td class="n">${s.podiums || ""}</td><td class="n">${s.poles || ""}</td><td class="n">${s.starts}</td><td class="n">${s.pts}</td></tr>`).join("")}</tbody></table></details>`;
  }
  historyView() {
    const S = this.S;
    const imp = `<div class="su-bar"><label class="btn file" for="rs-arcfile" title="Pick old save files of this game (you can select many at once, or a results archive). Seasons finished before race results were kept get their races back, from the save of that season with the most rounds.">Import past race results…<input type="file" id="rs-arcfile" accept=".json,application/json" multiple hidden></label>
      <span class="muted small">Seasons finished before v51 kept no race-by-race results: select this game's old save files to bring them back.</span></div>`;
    if (!S.history.length) return `<div class="cr-note">No completed seasons yet.</div>`;
    return `${this.allTimeHTML()}${imp}<table class="cr-t"><thead><tr><th></th><th>Season</th><th>Champion</th><th>Constructors'</th><th>You</th><th>Races</th></tr></thead><tbody>${[...S.history].reverse().map((h) =>
      `<tr><td class="th-cell">${h.champion ? carThumb(h.champion.car ?? R.carIn(this.db, h.champion.team, h.year), h.champion.d) : ""}</td><td class="n">${h.year}</td><td>${h.champion ? `${this.hn(h.champion.d)} <span class="muted">${esc(h.table[0]?.teamName ?? "")} · ${h.champion.pts}</span>` : ""}</td><td><span class="th-name">${h.teams ? carThumb(h.teams.car ?? R.carIn(this.db, h.teams.team, h.year), h.table?.find((x) => x.team === h.teams.team)?.d) : ""}${esc(h.teams?.name ?? "")}</span></td><td class="n">${h.mine ? `P${h.mine}` : "—"}</td>
      <td>${h.races?.some((r) => r.res) ? `<button class="btn" data-act="hseason" data-y="${h.year}">${this.hOpen === h.year ? "Hide" : "Results"}</button>` : `<span class="muted small">not saved</span>`}</td></tr>
      ${this.hOpen === h.year && h.races ? `<tr class="rg-row"><td colspan="6">${this.seasonGridHTML(h)}</td></tr>` : ""}`).join("")}</tbody></table>`;
  }
  saveView() {
    return `<div class="cr-note">Real Seasons saves itself in this browser after every action (one game at a time, separate from the career). Download a save file to keep it or move it.</div>
      <div class="su-bar"><button class="btn primary" data-act="download">Download save file</button>
      <label class="btn file" for="rs-file">Load save file<input type="file" id="rs-file" accept=".json,application/json" hidden></label></div>`;
  }
}
