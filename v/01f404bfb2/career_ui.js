// Career dialog: new career (team or driver), your team (upgrades) or your driver (skills), standings by tier,
// driver market (offers out, or offers to you), drivers, calendar, history, saves. The engine is career.js; races are watched in the main viewer through hooks.watch().
import * as K from "./career.js";
import { layoutFor } from "./sim/db.js";
import { carThumb, helmetThumb } from "./thumbs.js";
import { unpackCareer, importArchive, tally, sortTable, driverCols, seasonGrid, cellHTML } from "./archive.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const fmtM = (x) => `$${(Math.round(x * 10) / 10).toFixed(1)}M`;
const TABS = [["overview", "Overview"], ["standings", "Standings"], ["market", "Market"], ["drivers", "Drivers"],
  ["calendar", "Calendar"], ["history", "History"], ["save", "Save / load"]];

export class CareerUI {
  // hooks: { store, trackFor(circuit, layout) -> Promise<track>, watch(cfg) }
  constructor(db, hooks) {
    this.db = db; this.h = hooks; this.ix = K.index(db);
    this.C = null;
    try { const t = hooks.store.get("career"); if (t) this.C = K.deserialize(db, t); } catch { this.C = null; }
    this.tab = "overview"; this.tier = 0; this.mseat = null; this.myears = 3; this.filter = ""; this.pick = null;
    this.newSeed = 1 + Math.floor(Math.random() * 99999); this.newRules = 2016; this.newCal = "fixed";
    this.newMode = "team"; this.newName = ""; this.newCode = ""; this.hel = { src: null, out: null, mirror: false, bg: true };
    this.helmetHook();
    this.trk = new Map();
    const dlg = $("career");
    dlg.addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (b && !b.disabled) this.act(b.dataset.act, b.dataset, e); });
    dlg.addEventListener("change", (e) => this.change(e));
    // helmet pictures: drop anywhere on the dialog while a helmet picker is shown, or paste one
    const picker = () => dlg.querySelector?.(".cr-hdrop");
    dlg.addEventListener("dragover", (e) => { if (picker()) { e.preventDefault(); picker().classList.add("over"); } });
    dlg.addEventListener("dragleave", (e) => { if (e.target === picker()) picker().classList.remove("over"); });
    dlg.addEventListener("drop", (e) => {
      if (!picker()) return;
      e.preventDefault(); picker().classList.remove("over");
      const f = [...(e.dataTransfer?.files ?? [])].find((x) => /^image\//.test(x.type)) ?? e.dataTransfer?.files?.[0];
      if (f) this.loadHelmet(f); else this.msg("Drop a picture file (PNG, JPG, WebP...).");
    });
    dlg.addEventListener("paste", (e) => {
      if (!picker() || e.target.closest?.("input[type=text], input:not([type]), textarea")) return;
      const it = [...(e.clipboardData?.items ?? [])].find((x) => x.type.startsWith("image/"));
      if (it) { e.preventDefault(); this.loadHelmet(it.getAsFile()); }
    });
    dlg.addEventListener("input", (e) => {
      if (e.target.id === "cr-filter") { this.filter = e.target.value; this.renderBody(true); }
      else if (e.target.id === "cr-name") { this.newName = e.target.value; const b = dlg.querySelector('[data-act="startdrv"]'); if (b) b.disabled = !this.newName.trim(); }
      else if (e.target.id === "cr-code") this.newCode = e.target.value;
    });
  }
  // destructive actions take a second click within 6 s (window.confirm is blocked in the artifact frame)
  armed(key, prompt) {
    if (this.arm && this.arm.key === key && Date.now() - this.arm.at < 6000) { this.arm = null; return true; }
    this.arm = { key, at: Date.now() };
    this.render(); this.msg(prompt);
    return false;
  }
  armLabel(key, label) { return this.arm && this.arm.key === key && Date.now() - this.arm.at < 6000 ? "Click again to confirm" : label; }
  open(msg) { this.render(); if (!$("career").open) $("career").showModal(); if (msg) this.msg(msg); }
  msg(t) { $("cr-msg").textContent = t ?? ""; }
  save() { if (this.C) this.h.store.set("career", K.serialize(this.C)); }
  dn(d) { return this.ix.drivers.get(d)?.name ?? "—"; }
  rating(d) { return this.ix.peaks.get(d)?.rating ?? 0; }
  peak(d) { return this.ix.peaks.get(d)?.year ?? ""; }
  pairLabel(p) { const pr = this.C.pairs[p]; return `${this.C.teams[pr.ref].name} ${pr.dec}`; }
  carIdOf(p) { try { return K.modelId(this.db, this.C.pairs[p]); } catch { return null; } }
  hn(d) { return `<span class="th-name">${helmetThumb(d)}${esc(this.dn(d))}</span>`; }   // helmet + name
  carLabel(p) { const pr = this.C.pairs[p]; return `${pr.model} ${this.C.teams[pr.ref].name}`; }
  carR(p) { return K.carRating(this.db, K.carPace(this.db, this.C.pairs[p])); }
  get drv() { return this.C?.mode === "driver"; }
  get me() { return this.C?.me?.id ?? null; }
  // team career: the player's entries; driver career: the entry the player drives (or has signed for)
  mine(p) { return this.drv ? this.seatDriver(p) === this.me : this.C.pairs[p].ref === this.C.player; }
  mineRow(x) { return this.drv ? x.d === this.me : this.mine(x.p); }
  helmetHook() { if (this.C?.mode === "driver" && this.C.me.helmet) this.h.setHelmet?.(K.ME_ID, this.C.me.helmet); }
  myPairs() { return this.C.pairs.map((_, p) => p).filter((p) => this.mine(p)).sort((a, b) => this.C.pairs[a].tier - this.C.pairs[b].tier); }
  // the driver in an entry (market: whoever holds the seat for next season)
  seatDriver(p) { return this.C.market ? K.seatHolder(this.C, p) : K.driverOf(this.C, p); }
  contractText(d) {
    if (!d) return "";
    const h = this.C.market?.held[d];
    if (h && !h.own) return `signing for ${h.years}`;
    const c = this.C.contracts[d];
    if (!c) return "free";
    return this.C.market ? `${c.left} season${c.left === 1 ? "" : "s"} left${c.left === 1 ? " (last year)" : ""}`
      : `${c.left} season${c.left === 1 ? "" : "s"} incl. this one`;
  }
  async tracks() {
    for (const cal of this.C.calendar) {
      const circ = this.ix.circuits.get(cal.circuit);
      const lay = circ.layouts.find((l) => l.key === cal.layout) ?? circ.layouts.find((l) => this.C.rulesYear >= l.years[0] && this.C.rulesYear <= l.years[1]) ?? circ.layouts.reduce((a, b) => (b.years[1] > a.years[1] ? b : a));
      const k = `${circ.ref}|${lay.key}`;
      if (!this.trk.has(k)) this.trk.set(k, await this.h.trackFor(circ.ref, lay.key));
    }
    return (c, l) => this.trk.get(`${c}|${l}`);
  }

  // ---------- actions ----------
  async act(a, ds) {
    const C = this.C, db = this.db;
    this.msg("");
    if (this.arm && !((a === "newcareer" && this.arm.key === "new") || (a === "slotdel" && this.arm.key === `del:${ds.n}`))) this.arm = null;
    switch (a) {
      case "tab": this.tab = ds.tab; break;
      case "hseason": this.hOpen = this.hOpen === Number(ds.s) ? null : Number(ds.s); break;
      case "htier": this.hTier = Number(ds.t); break;
      case "attoggle": this.atOpen = !this.atOpen; return;
      case "atsort": this.atSort = { ...this.atSort, [ds.t]: { k: ds.k, dir: Number(ds.dir) } }; break;
      case "tier": this.tier = Number(ds.t); break;
      case "pick": this.pick = ds.ref; break;
      case "reseed": this.newSeed = 1 + Math.floor(Math.random() * 99999); this.pick = null; break;
      case "newmode": this.newMode = ds.m; break;
      case "startdrv": {
        const name = this.newName.trim();
        if (!name) { this.msg("Choose your driver's name first."); return; }
        this.C = K.newCareer(db, { seed: this.newSeed, rulesYear: this.newRules, calMode: this.newCal,
          me: { name, code: (this.newCode || name.split(/\s+/).at(-1)).replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase(), helmet: this.hel.out } });
        this.helmetHook();
        this.tab = "overview";
        this.save(); this.msg(`Career started: ${name} is on the market. Spend your $${K.ME_START_MONEY}M on skills (pace is what teams scout on), then run the market and answer the offers.`);
        break;
      }
      case "skill": {
        const k = ds.s, ok = K.buySkill(db, C, k);
        this.msg(ok ? `${K.SKILL_UP[k].label} is now level ${C.me.lv[k]}.` : "Not enough money.");
        break;
      }
      case "maccept": {
        const o = C.market.myOffers[Number(ds.k)];
        if (o && K.acceptOffer(db, C, Number(ds.k))) this.msg(`Signed: ${this.pairLabel(o.pair)} for ${o.years} season${o.years === 1 ? "" : "s"}. Other teams can still come in with a better offer.`);
        break;
      }
      case "mdecline": K.declineOffer(C, Number(ds.k)); break;
      case "hclear": C.me.helmet = null; this.hel.src = this.hel.out = null; this.h.setHelmet?.(K.ME_ID, null); this.msg("Helmet picture removed."); break;
      case "start": {
        if (!this.pick) { this.msg("Pick a constructor first."); return; }
        this.C = K.newCareer(db, { seed: this.newSeed, rulesYear: this.newRules, player: this.pick, calMode: this.newCal });
        this.tab = "market"; this.mseat = K.userOpen(this.C)[0] ?? null;
        this.save(); this.msg(`Career started with ${this.C.teams[this.pick].name}. The market is open: sign a driver for each of your entries.`);
        break;
      }
      case "mround": case "mstaff": {
        if (this.drv && C.market.myOffers.length && !this.armed("lapse", "You have offers waiting: running the next round lets them lapse. Click again to go on.")) return;
        const nUser = Object.keys(C.market.userOffers).length;
        K.marketRound(db, C, { staff: a === "mstaff" });
        this.mseat = K.userOpen(C)[0] ?? null;
        if (this.drv) { this.msg(this.drvMarketMsg()); break; }
        this.msg(C.market.done ? "Every seat is filled: the market is closed. Start the season when you're ready." :
          `Round ${C.market.round} done${nUser ? `: ${nUser} offer${nUser === 1 ? "" : "s"} from you` : ""}. ${C.market.open.length} seats still open (${K.userOpen(C).length} yours).`);
        break;
      }
      case "mrun": {
        if (this.drv && C.market.myOffers.length && !this.armed("lapse", "You have offers waiting: running the market lets them lapse. Click again to go on.")) return;
        if (this.drv) { const M = C.market; M.myOffers.forEach((o) => { if (!o.ext) (M.rejected[this.me] ??= []).push(o.pair); }); M.myOffers = []; }
        K.runMarket(db, C);
        if (this.drv) { this.msg(this.drvMarketMsg()); break; }
        this.mseat = K.userOpen(C)[0] ?? null;
        this.msg(C.market.done ? "Market closed." : `The other teams are done (round ${C.market.round}). Your open seats: ${K.userOpen(C).length}.`);
        break;
      }
      case "seat": this.mseat = Number(ds.p); break;
      case "offer": {
        if (this.mseat === null) { this.msg("Choose one of your open seats first."); return; }
        C.market.userOffers[this.mseat] = { driver: ds.d, years: this.myears };
        this.msg(`Offer ready: ${this.dn(ds.d)} to ${this.pairLabel(this.mseat)} for ${this.myears} seasons. It goes out with the next round.`);
        const next = K.userOpen(C).find((p) => !C.market.userOffers[p]);
        if (next !== undefined) this.mseat = next;
        break;
      }
      case "unoffer": delete C.market.userOffers[ds.p]; break;
      case "extend": {
        const h = C.market.held[ds.d];
        if (h) { C.market.held[ds.d] = { pair: h.pair, years: this.myears, ext: true }; this.msg(`${this.dn(ds.d)} extends for ${this.myears} seasons (unless a better car comes along).`); }
        break;
      }
      case "calroll": case "calrandom": {
        if (C.phase !== "market") return;
        const keep = C.calMode;
        C.calRolls = (C.calRolls ?? 0) + 1;
        C.calMode = a === "calroll" ? "shuffle" : keep === "iconic" ? "iconic" : "random";
        K.rollCalendar(db, C, C.calRolls);
        C.calMode = keep;
        this.trk.clear(); this.save(); this.render();
        this.msg(a === "calroll" ? "Calendar shuffled." : "New venues drawn for this season.");
        return;
      }
      case "startseason": {
        if (!C.market.done) { this.msg("Fill every seat first."); return; }
        K.startSeason(db, C); this.tab = "overview";
        this.msg(`Season ${C.season} starts.`);
        break;
      }
      case "play": {
        const tf = await this.tracks();
        const todo = K.playRound(db, C, tf);
        this.save();
        if (todo.length) { this.render(); this.watch(todo[0]); return; }
        this.msg(`Round ${C.round} done (no races of yours to watch).`);
        break;
      }
      case "watch": this.watch(Number(ds.t)); return;
      case "simpend": {
        const tf = await this.tracks();
        K.simTier(db, C, C.pending.round, Number(ds.t), tf);
        this.msg("Simulated.");
        break;
      }
      case "replay": {
        const cfg = C.replays?.[`${ds.r}:${ds.t}`];
        if (cfg) { $("career").close(); this.h.watch({ ...structuredClone(cfg), career: { ...cfg.career, replay: true } }); }
        return;
      }
      case "endseason": {
        const s = C.season;
        K.endSeason(db, C); this.tab = "history";
        this.mseat = K.userOpen(C)[0] ?? null;
        this.msg(`Season ${s} is over. Prize money is paid; promotions and relegations are done. The market is open.`);
        break;
      }
      case "buy": {
        const ok = K.buyUpgrade(C, Number(ds.p), ds.s);
        this.msg(ok ? `${K.UPGRADES[ds.s].label} upgrade fitted to ${this.pairLabel(Number(ds.p))}.` : "Not enough money.");
        break;
      }
      case "slotsave": {
        const n = ($("cr-slot").value || `Season ${C.season} ${this.drv ? C.me.name : C.teams[C.player].name}`).slice(0, 60);
        const all = this.h.store.get("careerSlots") ?? {};
        all[n] = K.serialize(C);
        this.msg(this.h.store.set("careerSlots", all) ? `Saved "${n}" in this browser.` : "This browser blocked storage: download a save file instead.");
        break;
      }
      case "slotload": {
        const all = this.h.store.get("careerSlots") ?? {};
        try { this.C = K.deserialize(db, all[ds.n]); this.helmetHook(); this.trk.clear(); this.tab = "overview"; this.msg(`Loaded "${ds.n}".`); } catch (e) { this.msg(`Could not load: ${e.message}`); }
        break;
      }
      case "slotdel": {
        if (!this.armed(`del:${ds.n}`, `Delete the save "${ds.n}"? Click Delete again to confirm.`)) return;
        const all = this.h.store.get("careerSlots") ?? {}; delete all[ds.n]; this.h.store.set("careerSlots", all);
        break;
      }
      case "download": await this.download(); return;
      case "newcareer": {
        if (this.C && !this.armed("new", "Start a new career? The current one is kept only in saves you made. Click New career again to confirm.")) return;
        this.C = null; this.h.store.set("career", null); this.pick = null; K.detachMe(db); break;
      }
      case "close": $("career").close(); return;
      default: return;
    }
    this.save(); this.render();
  }
  change(e) {
    const el = e.target, C = this.C;
    if (el.id === "cr-years") this.myears = Number(el.value);
    else if (el.id === "cr-name") this.newName = el.value;
    else if (el.id === "cr-code") this.newCode = el.value;
    else if (el.id === "cr-hfile") { const f = el.files?.[0]; if (f) this.loadHelmet(f); }
    else if (el.id === "cr-hmirror" || el.id === "cr-hbg") { this.hel[el.id === "cr-hmirror" ? "mirror" : "bg"] = el.checked; this.processHelmet(); }
    else if (el.id === "cr-seed") { this.newSeed = Math.max(1, Math.floor(Number(el.value) || 1)); this.pick = null; this.render(); }
    else if (el.id === "cr-calmode") { this.newCal = el.value; }
    else if (el.id === "cr-icpow") { if (K.setIconicPow(C, el.value)) { this.save(); this.render(); } }
    else if (el.id === "cr-calmode-c") {
      if (K.setCalMode(this.db, C, el.value)) { this.save(); this.render(); this.msg(el.value === "fixed" ? "The calendar stays as it is." : "From next offseason the calendar changes by itself; Re-draw now to change it for this season too."); }
    }
    else if (el.id === "cr-rules") { this.newRules = Math.min(2024, Math.max(1950, Number(el.value) || 2016)); }
    else if (el.id === "cr-autowatch") { C.autoWatch = el.checked; this.save(); this.render(); }
    else if (el.dataset.watchtier !== undefined) {
      const t = Number(el.dataset.watchtier), s = new Set(C.watchExtra ?? []);
      if (el.checked) s.add(t); else s.delete(t);
      C.watchExtra = [...s]; this.save();
    } else if (el.dataset.model !== undefined) {
      const p = Number(el.dataset.model);
      if (K.setModel(C, p, Number(el.value))) { this.save(); this.render(); this.msg(`${this.pairLabel(p)} will race the ${el.value} car.`); }
    } else if (el.dataset.cal !== undefined) {
      C.calendar[Number(el.dataset.cal)] = { circuit: el.value }; this.save(); this.render();
    } else if (el.dataset.callay !== undefined) {
      const c = C.calendar[Number(el.dataset.callay)];
      if (el.value) c.layout = el.value; else delete c.layout;
      this.trk.clear(); this.save(); this.render();
    } else if (el.id === "cr-arcfile") {
      const fs = [...(el.files ?? [])]; if (!fs.length || !C) return;
      Promise.all(fs.map((f) => f.text().then((t) => { try { return JSON.parse(t); } catch { return null; } }))).then((objs) => {
        const r = importArchive(C, objs.filter(Boolean), "fantasy-gp-career");
        this.save(); this.render();
        this.msg(r.filled.length || r.partial.length
          ? `Race results restored for season${r.filled.length + r.partial.length === 1 ? "" : "s"} ${[...r.filled, ...r.partial].sort((a, b) => a - b).join(", ")}${r.partial.length ? ` (partly: ${r.partial.join(", ")}, some rounds weren't in any save)` : ""}.${r.skipped ? ` ${r.skipped} file(s) were from other games.` : ""}`
          : `Nothing to restore from those files${r.skipped ? ` (${r.skipped} were from other games)` : ""}.`);
      });
    } else if (el.id === "cr-file") {
      const f = el.files?.[0]; if (!f) return;
      f.text().then((t) => {
        try { this.C = K.deserialize(this.db, t); this.helmetHook(); this.trk.clear(); this.tab = "overview"; this.save(); this.render(); this.msg(`Loaded ${f.name}.`); }
        catch (err) { this.msg(`Could not load that file: ${err.message}`); }
      });
    }
  }
  watch(t) {
    const C = this.C;
    const cfg = K.raceConfig(this.db, C, C.pending.round, t);
    $("career").close();
    this.h.watch(cfg);
  }
  // called by the viewer when a career race reaches the flag
  finished(cfg, out, calls) {
    const C = this.C;
    if (!C || !cfg.career || cfg.career.replay) return false;
    const ok = K.recordRace(this.db, C, cfg, out, calls ?? []);
    if (ok) this.save();
    return ok;
  }
  async download() {
    const text = K.serialize(this.C);
    const name = `fantasy-gp-career-s${this.C.season}.json`;
    try {
      const dl = globalThis.claude?.use ? await globalThis.claude.use("downloads") : null;
      if (dl) { await dl.save({ filename: name, data: text }); this.msg("Save file downloaded."); return; }
    } catch (e) { if (e?.code === "declined") { this.msg("Download cancelled."); return; } }
    try {                                                  // outside claude.ai: a normal browser download
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "application/json" })); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      this.msg("Save file downloaded.");
    } catch { $("cr-json").value = text; this.msg("Copy the text in the box and keep it as your save."); }
  }

  // ---------- render ----------
  render() {
    const C = this.C;
    $("cr-title").textContent = C ? `Career · ${this.drv ? C.me.name : C.teams[C.player].name} · Season ${C.season}` : "New career";
    $("cr-money").hidden = !C;
    if (C) $("cr-money").textContent = fmtM(this.drv ? C.me.money : C.teams[C.player].money);
    $("cr-tabs").innerHTML = C ? TABS.map(([k, l]) => `<button class="${this.tab === k ? "on" : ""}" data-act="tab" data-tab="${k}">${l}${k === "market" && C.market ? " ●" : ""}</button>`).join("") : "";
    $("cr-actions").innerHTML = C ? this.actions() : "";
    this.renderBody();
  }
  actions() {
    const C = this.C, b = (act, txt, cls = "", extra = "") => `<button class="btn ${cls}" data-act="${act}" ${extra}>${txt}</button>`;
    if (C.phase === "market") {
      if (C.market.done) return b("startseason", `Start season ${C.season}`, "primary");
      if (this.drv) return b("mrun", "Run the market", "primary", 'title="Rounds run until a team makes you an offer, or the market closes"') +
        b("mround", `Next round (${C.market.round + 1})`, "");
      const n = Object.keys(C.market.userOffers).length;
      return b("mround", `Send offers · round ${C.market.round + 1}${n ? ` (${n})` : ""}`, "primary") + b("mrun", "Run the market", "", 'title="Rounds run until only your seats are open"') +
        b("mstaff", "Staff fill my seats", "", 'title="Your staff make offers for your open seats this round"');
    }
    if (C.phase === "season") {
      if (C.pending) return C.pending.tiers.map((t) => b("watch", `Watch Tier ${t + 1}`, "primary", `data-t="${t}"`) + b("simpend", "Sim it", "", `data-t="${t}"`)).join("");
      const cal = C.calendar[C.round], circ = this.ix.circuits.get(cal.circuit);
      return b("play", `Round ${C.round + 1}: ${esc(circ.name)}`, "primary");
    }
    if (C.phase === "review") return b("endseason", "End season", "primary");
    return "";
  }
  renderBody(keepFocus = false) {
    const C = this.C;
    const body = $("cr-body");
    const fpos = keepFocus ? $("cr-filter")?.selectionStart : null;
    body.innerHTML = !C ? this.newView() : this[`${this.tab}View`]?.() ?? "";
    this.h.paint?.(body);
    if (keepFocus && $("cr-filter")) { $("cr-filter").focus(); $("cr-filter").setSelectionRange(fpos, fpos); }
  }

  newView() {
    const prev = K.newCareer(this.db, { seed: this.newSeed, rulesYear: this.newRules });
    const by = new Map();
    for (const [p, pr] of prev.pairs.entries()) (by.get(pr.ref) ?? by.set(pr.ref, []).get(pr.ref)).push(p);
    const cards = [...by.entries()].sort((a, b) => Math.min(...a[1].map((p) => prev.pairs[p].tier)) - Math.min(...b[1].map((p) => prev.pairs[p].tier))
      || b[1].length - a[1].length || prev.teams[a[0]].name.localeCompare(prev.teams[b[0]].name)).map(([ref, ps]) => {
      const t = prev.teams[ref];
      return `<button class="cr-team ${this.pick === ref ? "on" : ""}" data-act="pick" data-ref="${ref}" style="--tc:${t.colour}">
        <b>${esc(t.name)}</b><span>${ps.map((p) => `${prev.pairs[p].dec} <i>T${prev.pairs[p].tier + 1}</i>`).join(" · ")}</span></button>`;
    }).join("");
    const all = this.h.store.get("careerSlots") ?? {};
    const modes = `<nav class="cr-tabs sub"><button class="${this.newMode === "team" ? "on" : ""}" data-act="newmode" data-m="team">Run a team</button><button class="${this.newMode === "driver" ? "on" : ""}" data-act="newmode" data-m="driver">Be a driver</button></nav>`;
    const loads = `<h3>Or load a career</h3>
      <div class="su-bar">${Object.keys(all).map((n) => `<button class="btn" data-act="slotload" data-n="${esc(n)}">${esc(n)}</button>`).join("") || "<span class=\"muted\">No saves in this browser.</span>"}
        <label class="btn file" for="cr-file">Load save file<input type="file" id="cr-file" accept=".json,application/json" hidden></label></div>`;
    if (this.newMode === "driver") return modes + this.newDriverView() + `<div class="cr-new">${loads}</div>`;
    return modes + `<div class="cr-new">
      <p>Every constructor is a team with one car per decade it raced in. The ${prev.pairs.length} entries are split into tiers of 26, seeded by car strength; 6 go up and 6 go down each season. You start in the offseason, with every driver on the market.</p>
      <div class="su-bar">
        <label class="inline" for="cr-seed">Seed <input id="cr-seed" type="number" min="1" value="${this.newSeed}" style="width:90px"></label>
        <button class="btn" data-act="reseed">New seed</button>
        <label class="inline" for="cr-rules" title="Sets overtaking, pit stops, safety cars and reliability for every race">Rules year <input id="cr-rules" type="number" min="1950" max="2024" value="${this.newRules}" style="width:70px"></label>
        <label class="inline" for="cr-calmode" title="Fixed: you choose the venues. Shuffle: the same venues in a new order each offseason. Random: a new draw of venues each offseason. Iconic: a new draw each offseason, favouring iconic layouts (strength set in the Calendar tab)">Calendar <select id="cr-calmode">${K.CAL_MODES.map(([m, l]) => `<option value="${m}" ${m === this.newCal ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
        <span class="spacer"></span>
        <button class="btn primary" data-act="start" ${this.pick ? "" : "disabled"}>Start career${this.pick ? ` with ${esc(prev.teams[this.pick].name)}` : ""}</button>
      </div>
      <h3>Choose your constructor <small>(entries by decade, with their starting tier)</small></h3>
      <div class="cr-teams">${cards}</div>
      <h3>Or load a career</h3>
      <div class="su-bar">${Object.keys(all).map((n) => `<button class="btn" data-act="slotload" data-n="${esc(n)}">${esc(n)}</button>`).join("") || "<span class=\"muted\">No saves in this browser.</span>"}
        <label class="btn file" for="cr-file">Load save file<input type="file" id="cr-file" accept=".json,application/json" hidden></label></div>
    </div>`;
  }

  overviewView() {
    const C = this.C;
    let top = "";
    if (C.phase === "market") top = `<div class="cr-note">Offseason. ${C.market.done ? "The market is closed: start the season when ready." : `The driver market is open (round ${C.market.round}): ${K.userOpen(C).length} of your seats need a driver. Go to the Market tab.`} You can also change the calendar and buy upgrades now.</div>`;
    if (C.phase === "season") top = this.roundPanel();
    if (C.phase === "review") top = `<div class="cr-note">All ${K.roundsOf(C)} rounds are done. End the season to pay prizes, run promotion and relegation, and open the market.</div>`;
    if (this.drv) {
      if (C.phase === "market") top = `<div class="cr-note">Offseason. ${C.market.done ? "The market is closed: start the season when ready." : `The driver market is open (round ${C.market.round}). ${C.market.myOffers.length ? `<b>You have ${C.market.myOffers.length} offer${C.market.myOffers.length === 1 ? "" : "s"}</b>: see the Market tab.` : "Run the market from the Market tab."}`} Skills can be bought at any time.</div>`;
      const p = this.myPair();
      return top + `<div class="cr-cards">${this.meCard()}${p !== null ? this.pairCard(p) : ""}</div>`;
    }
    const cards = this.myPairs().map((p) => this.pairCard(p)).join("");
    return top + `<div class="cr-cards">${cards}</div>`;
  }
  roundPanel() {
    const C = this.C, r = C.pending ? C.pending.round : C.round;
    const circ = this.ix.circuits.get(C.calendar[r].circuit);
    const watch = K.watchTiers(C);
    const rows = [...Array(K.nTiers(C)).keys()].map((t) => {
      const res = C.results[r]?.[t];
      const mineIn = K.tierPairs(C, t).some((p) => this.mine(p));
      const win = res?.find((x) => x.pos === 1);
      const yours = res ? res.filter((x) => this.mineRow(x)).map((x) => `${this.pairLabel(x.p)} ${x.fin ? "P" + x.pos : "DNF"}${x.earn ? ` · ${fmtM(x.earn)}` : ""}`).join(", ") : "";
      const state = res ? `Winner ${esc(this.dn(win?.d))} (${esc(this.pairLabel(win?.p))})${yours ? ` · <b>${esc(yours)}</b>` : ""}`
        : C.pending?.tiers.includes(t) ? "<b>to watch</b>" : watch.includes(t) ? "will be shown" : "simulated";
      return `<tr><td>Tier ${t + 1}${mineIn ? " ★" : ""}</td><td>${state}</td><td>${res ? `<button class="btn" data-act="replay" data-r="${r}" data-t="${t}">Watch replay</button>` : C.pending?.tiers.includes(t) ? `<button class="btn primary" data-act="watch" data-t="${t}">Watch</button> <button class="btn" data-act="simpend" data-t="${t}">Sim</button>` : ""}</td>
        <td>${mineIn ? "" : `<label class="inline"><input type="checkbox" data-watchtier="${t}" ${C.watchExtra?.includes(t) ? "checked" : ""}> also watch</label>`}</td></tr>`;
    }).join("");
    return `<div class="cr-round"><h3>Round ${r + 1} of ${K.roundsOf(C)}: ${esc(circ.name)}</h3>
      <label class="inline"><input type="checkbox" id="cr-autowatch" ${C.autoWatch ? "checked" : ""}> Show the races ${this.drv ? "I race in" : "my cars are in"}</label>
      <table class="cr-t">${rows}</table></div>`;
  }
  pairCard(p) {
    const C = this.C, pr = C.pairs[p];
    const d = this.seatDriver(p);
    const st = K.standings(C, pr.tier), k = st.findIndex((x) => x.p === p);
    const pos = C.phase !== "market" && C.results.length ? `P${k + 1} · ${st[k].pts} pts` : "";
    const ups = Object.entries(K.UPGRADES).map(([s, u]) => {
      const cost = K.upgradeCost(pr, s);
      const eff = s === "pace" ? `${K.upgradeEffect(s, pr.up[s]).toFixed(2)}%` : `×${K.upgradeEffect(s, pr.up[s]).toFixed(2)}`;
      return `<div class="cr-up"><span>${u.label}</span><span class="lv">${"■".repeat(pr.up[s])}${"□".repeat(u.max - pr.up[s])}</span><span class="muted">${eff}</span>
        ${this.drv ? "" : cost === null ? "<span>max</span>" : `<button class="btn" data-act="buy" data-p="${p}" data-s="${s}" ${C.teams[pr.ref].money < cost ? "disabled" : ""}>+1 · ${fmtM(cost)}</button>`}</div>`;
    }).join("");
    return `<div class="cr-card"><header><b>${esc(this.pairLabel(p))}</b><span class="badge">Tier ${pr.tier + 1}</span><span class="muted">${pos}</span></header>
      <div>${this.modelPicker(p)} car · rating ${this.carR(p)} <span class="muted">(models ${pr.years[0]}–${pr.years.at(-1)})</span></div>
      <div>${d ? `${esc(this.dn(d))} · rating ${this.rating(d)} <span class="muted">(${this.peak(d)} form) · ${this.contractText(d)}</span>` : '<span class="bad">No driver: sign one in the market</span>'}</div>
      <div class="cr-ups">${ups}</div>
      <div class="muted small">${this.drv ? "Your entry. The team buys its own upgrades (CPU teams don't upgrade)." : "Upgrades are permanent and stay with this entry."}</div></div>`;
  }

  // the player's model: a choice of up to one year either way in the offseason, fixed during the season
  modelPicker(p) {
    const C = this.C, pr = C.pairs[p];
    const ch = K.modelChoices(C, p);
    if (C.phase !== "market" || this.drv || !this.mine(p) || ch.length < 2) return esc(this.carLabel(p));
    const name = C.teams[pr.ref].name;
    return `<select data-model="${p}" aria-label="Car model for ${esc(this.pairLabel(p))}" title="Move up to one model year from last season's car">${ch.map((y) => {
      const r = K.carRating(this.db, this.ix.carAt.get(`${pr.ref}|${y}`).pace + K.modOf(pr).pace);
      return `<option value="${y}" ${y === pr.model ? "selected" : ""}>${y} ${esc(name)} (${r})${y === pr.base ? " · current" : ""}</option>`;
    }).join("")}</select>`;
  }

  standingsView() {
    const C = this.C, T = K.nTiers(C);
    const tabs = [...Array(T).keys()].map((t) => `<button class="${this.tier === t ? "on" : ""}" data-act="tier" data-t="${t}">Tier ${t + 1}</button>`).join("");
    const st = K.standings(C, this.tier);
    const anyRes = C.results.some((r) => r?.[this.tier]);
    const rows = (anyRes ? st : [...st].sort((a, b) => K.carPace(this.db, C.pairs[a.p]) - K.carPace(this.db, C.pairs[b.p]))).map((s, k) => {
      const d = this.seatDriver(s.p), n = st.length;
      const zone = this.tier > 0 && k < K.MOVE ? "up" : this.tier < T - 1 && k >= n - K.MOVE ? "down" : "";
      return `<tr class="${zone} ${this.mine(s.p) ? "mine" : ""}"><td class="n">${k + 1}</td><td class="th-cell">${carThumb(this.carIdOf(s.p), d)}</td><td>${esc(this.pairLabel(s.p))}</td><td>${esc(this.carLabel(s.p))} <span class="muted">${this.carR(s.p)}</span></td>
        <td>${d ? this.hn(d) : "—"} <span class="muted">${d ? this.rating(d) : ""}</span></td><td class="n">${s.wins || ""}</td><td class="n">${s.pod || ""}</td><td class="n b">${s.pts}</td>
        <td class="form">${s.last.slice(-6).map((x) => `<i class="${x === 1 ? "w" : x === "R" ? "r" : x <= 3 ? "p" : ""}">${x}</i>`).join("")}</td></tr>`;
    }).join("");
    return `<nav class="cr-tabs sub">${tabs}</nav>
      <p class="muted small">${anyRes ? "" : "No races yet this season: sorted by car rating. "}Green: promoted (top ${K.MOVE}); red: relegated (bottom ${K.MOVE}). Points 25-18-15-12-10-8-6-4-2-1.</p>
      <table class="cr-t"><thead><tr><th>#</th><th></th><th>Entry</th><th>Car</th><th>Driver</th><th>W</th><th>Pod</th><th>Pts</th><th>Form</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  marketView() {
    const C = this.C, db = this.db, M = C.market;
    if (!M) return `<div class="cr-note">The driver market opens in the offseason. Drivers in the last year of their contract, or without one, can be approached then.</div>`;
    if (this.drv) return this.drvMarketView();
    const open = K.userOpen(C);
    if (this.mseat !== null && !open.includes(this.mseat)) this.mseat = open[0] ?? null;
    const seats = this.myPairs().map((p) => {
      const d = K.seatHolder(C, p), off = M.userOffers[p];
      const isOpen = open.includes(p);
      return `<div class="cr-seat ${this.mseat === p ? "on" : ""} ${isOpen ? "open" : ""}" ${isOpen ? `data-act="seat" data-p="${p}"` : ""}>
        ${carThumb(this.carIdOf(p), d)} <b>${esc(this.pairLabel(p))}</b> <span class="badge">T${C.pairs[p].tier + 1}</span> <span class="muted">${esc(this.carLabel(p))} · ${this.carR(p)}</span><br>
        ${d ? `${this.hn(d)} <span class="muted">${this.rating(d)} · ${this.contractText(d)}</span>` : off ? `Offer out: <b>${esc(this.dn(off.driver))}</b>, ${off.years} seasons <button class="btn x" data-act="unoffer" data-p="${p}">withdraw</button>` : '<span class="bad">Open seat</span>'}</div>`;
    }).join("");
    const lastYear = Object.entries(M.held).filter(([, h]) => h.own && this.mine(h.pair)).map(([d, h]) =>
      `<div>${esc(this.dn(d))} (${esc(this.pairLabel(h.pair))}) is in the last contract year. <button class="btn" data-act="extend" data-d="${d}">Extend for ${this.myears} seasons</button></div>`).join("");
    const f = this.filter.toLowerCase();
    const list = [...this.ix.drivers.keys()].filter((d) => (C.contracts[d]?.left ?? 0) < 2)
      .filter((d) => !f || this.dn(d).toLowerCase().includes(f))
      .sort((a, b) => this.ix.peaks.get(a).score - this.ix.peaks.get(b).score);
    const seat = this.mseat;
    const rows = list.slice(0, 150).map((d) => {
      const h = M.held[d];
      const status = !h ? "Free" : h.own ? `Last year at ${esc(this.pairLabel(h.pair))}` : `${h.ext ? "Extending" : "Agreed"}: ${esc(this.pairLabel(h.pair))} (T${C.pairs[h.pair].tier + 1})`;
      let interest = "";
      if (seat !== null) {
        const ok = K.wouldAccept(db, C, d, seat);
        interest = ok ? '<span class="ok">would sign</span>' : (M.rejected[d] ?? []).includes(seat) ? '<span class="bad">said no</span>' : '<span class="bad">prefers current deal</span>';
      }
      const offered = Object.values(M.userOffers).some((o) => o.driver === d);
      return `<tr class="${h && this.mine(h.pair) ? "mine" : ""}"><td>${this.hn(d)}</td><td class="n b">${this.rating(d)}</td><td class="n">${this.peak(d)}</td><td>${status}</td><td>${interest}</td>
        <td>${seat !== null && !offered && !(h && h.pair === seat) ? `<button class="btn" data-act="offer" data-d="${d}">Offer</button>` : offered ? "offered" : ""}</td></tr>`;
    }).join("");
    const log = M.log.slice(-40).reverse().map((l) => `<li class="${l.mine ? "mine" : ""}"><span class="muted">R${l.r}</span> ${esc(l.text)}</li>`).join("");
    return `<div class="cr-market">
      <div class="cr-mleft">
        <h3>Your entries</h3>${seats}
        <div class="su-bar"><label class="inline" for="cr-years">Contract length <select id="cr-years">${[2, 3, 4, 5, 6].map((y) => `<option ${y === this.myears ? "selected" : ""}>${y}</option>`).join("")}</select> seasons</label></div>
        ${lastYear ? `<h3>Contracts ending</h3>${lastYear}` : ""}
        <p class="muted small">Drivers sign for the best car they can get: the entry's expected pace (its model, the models it can drift to, upgrades) and its tier. Each round every driver keeps the best offer so far and turns the rest down. ${M.open.length} seats open in total.</p>
        <h3>Market news</h3><ol class="cr-log">${log || "<li class=\"muted\">No moves yet.</li>"}</ol>
      </div>
      <div class="cr-mright">
        <div class="su-bar"><b>${seat !== null ? `Offering for: ${esc(this.pairLabel(seat))}` : open.length ? "Pick one of your open seats" : "Your seats are filled"}</b><span class="spacer"></span>
          <input id="cr-filter" placeholder="Filter drivers" value="${esc(this.filter)}" aria-label="Filter drivers"></div>
        <table class="cr-t"><thead><tr><th>Driver</th><th>Rating</th><th>Peak</th><th>Status</th><th>For this seat</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      </div></div>`;
  }

  driversView() {
    const C = this.C, f = this.filter.toLowerCase();
    const list = [...this.ix.drivers.keys()].filter((d) => !f || this.dn(d).toLowerCase().includes(f))
      .sort((a, b) => this.ix.peaks.get(a).score - this.ix.peaks.get(b).score);
    const rows = list.map((d) => {
      const c = C.contracts[d], h = C.market?.held[d];
      const p = h && !h.own ? h.pair : c?.pair;
      return `<tr class="${p !== undefined && this.mine(p) ? "mine" : ""}"><td>${this.hn(d)}</td><td class="n b">${this.rating(d)}</td><td class="n">${this.peak(d)}</td>
        <td>${p !== undefined ? esc(this.pairLabel(p)) : '<span class="muted">unemployed</span>'}</td><td class="n">${p !== undefined ? "T" + (C.pairs[p].tier + 1) : ""}</td>
        <td>${this.contractText(d)}</td></tr>`;
    }).join("");
    return `<div class="su-bar"><input id="cr-filter" placeholder="Filter drivers" value="${esc(this.filter)}" aria-label="Filter drivers"><span class="muted small">Drivers race at their peak season's form and don't age.</span></div>
      <table class="cr-t"><thead><tr><th>Driver</th><th>Rating</th><th>Peak</th><th>Entry</th><th>Tier</th><th>Contract</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  calendarView() {
    const C = this.C, edit = C.phase === "market";
    const opts = [...this.db.circuits].sort((a, b) => a.name.localeCompare(b.name));
    const rows = C.calendar.map((cal, r) => {
      const circ = this.ix.circuits.get(cal.circuit);
      const res = C.results[r];
      const yours = res ? res.flat().filter((x) => x && this.mineRow(x)).map((x) => `${this.drv ? this.pairLabel(x.p) : this.C.pairs[x.p].dec} ${x.fin ? "P" + x.pos : "DNF"}`).join(", ") : "";
      const w1 = res?.[0]?.find((x) => x.pos === 1);
      const lays = circ.layouts.filter((l) => l.geo_id);
      const cur = layoutFor(circ, C.rulesYear, cal.layout);
      const layName = (l) => `${l.name} (${l.years[0]}${l.years[1] > l.years[0] ? "–" + l.years[1] : ""})`;
      const laySel = edit && lays.length > 1 ? ` <select data-callay="${r}" aria-label="Layout for round ${r + 1}">` +
        `<option value="" ${cal.layout ? "" : "selected"}>Layout of ${C.rulesYear}: ${esc(layName(layoutFor(circ, C.rulesYear)))}</option>` +
        lays.map((l) => `<option value="${esc(l.key)}" ${l.key === cal.layout ? "selected" : ""}>${esc(layName(l))}</option>`).join("") + `</select>`
        : ` <span class="muted small">${esc(layName(cur))}</span>`;
      const sel = (edit ? `<select data-cal="${r}" aria-label="Circuit for round ${r + 1}">${opts.map((c) => `<option value="${c.ref}" ${c.ref === cal.circuit ? "selected" : ""}>${esc(c.name)} (${esc(c.country ?? "")})</option>`).join("")}</select>` : esc(circ.name)) + laySel;
      return `<tr class="${C.phase === "season" && r === C.round ? "next" : ""}"><td class="n">${r + 1}</td><td>${sel}</td><td>${w1 ? esc(this.dn(w1.d)) : ""}</td><td>${esc(yours)}</td></tr>`;
    }).join("");
    const mode = C.calMode ?? "fixed";
    const modeBar = `<div class="su-bar"><label class="inline" for="cr-calmode-c">Calendar <select id="cr-calmode-c" ${edit ? "" : "disabled"}>${K.CAL_MODES.map(([m, l]) => `<option value="${m}" ${m === mode ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      ${mode === "iconic" ? `<label class="inline" for="cr-icpow" title="How strongly iconic layouts are favoured: a layout's weight is its iconic score (1-10) to this power. 0 = every layout equally likely; 2 = a 10/10 layout is 4x as likely as a 5/10; 5 = nearly only the classics">Iconic weighting <input id="cr-icpow" type="range" min="${K.ICONIC_POW.min}" max="${K.ICONIC_POW.max}" step="0.5" value="${C.iconicPow ?? K.ICONIC_POW.def}" ${edit ? "" : "disabled"}> <b>${C.iconicPow ?? K.ICONIC_POW.def}</b></label>` : ""}
      ${edit ? `<button class="btn" data-act="calroll" title="Shuffle the order now">Shuffle now</button> <button class="btn" data-act="calrandom" title="Draw new random venues and layouts for this season now (iconic mode: weighted)">Random venues now</button>` : ""}</div>`;
    return modeBar + `<p class="muted small">${edit ? "Offseason: you can change any venue." : "Venues can be changed in the offseason."} Each venue uses the layout of the rules year (${C.rulesYear}) unless you pick another.${mode !== "fixed" ? ` Mode “${esc(K.CAL_MODES.find(([m]) => m === mode)[1])}”: the calendar changes by itself at the end of each season.` : ""}</p>
      <table class="cr-t"><thead><tr><th>#</th><th>Venue</th><th>Tier 1 winner</th><th>Your results</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ---------- race-by-race history (archive.js) ----------
  seasonGridHTML(h) {
    const T = h.tables.length, t = Math.min(this.hTier ?? 0, T - 1);
    const tabs = T > 1 ? `<nav class="cr-tabs sub">${h.tables.map((_, k) => `<button class="${k === t ? "on" : ""}" data-act="htier" data-t="${k}">Tier ${k + 1}</button>`).join("")}</nav>` : "";
    const races = h.races.map((r) => unpackCareer(r.res)?.[t] ?? null), grid = seasonGrid(races, (x) => x.p);
    const model = new Map(h.tables[t].map((x) => [x.p, x.model]));
    const label = (p) => `${this.C.teams[this.C.pairs[p].ref].name} ${model.get(p) ?? ""}`;
    const head = h.races.map((r) => `<th class="rg-h" title="${esc(r.circuit)}">${esc(String(r.circuit ?? "").slice(0, 3).toUpperCase())}</th>`).join("");
    const body = grid.map((s, k) => {
      const ds = [...new Set(s.cells.filter(Boolean).map((x) => x.d))];
      return `<tr class="${(this.drv ? ds.includes(String(this.me)) : this.mine(s.k)) ? "mine" : ""}"><td class="n">${k + 1}</td><td>${esc(label(s.k))}</td><td>${ds.map((d) => this.hn(d)).join(" ")}</td>${h.races.map((r, i) => r.res ? cellHTML(s.cells[i]) : `<td class="rg-c na" title="not saved">·</td>`).join("")}<td class="n b">${s.pts}</td></tr>`;
    }).join("");
    const missing = h.races.filter((r) => !r.res).length;
    return `${tabs}<div class="rg-wrap"><table class="cr-t rg"><thead><tr><th>#</th><th>Entry</th><th>Driver</th>${head}<th>Pts</th></tr></thead><tbody>${body}</tbody></table></div>
      ${missing ? `<p class="muted small">${missing} round${missing === 1 ? "" : "s"} weren't in any save (·); the totals here leave them out.</p>` : ""}`;
  }
  allTimeHTML() {
    const C = this.C, titles = new Map();
    for (const h of C.history) { const d = h.tables[0]?.[0]?.d; if (d != null) titles.set(String(d), (titles.get(String(d)) ?? 0) + 1); }
    const top = (res) => unpackCareer(res)?.[0] ?? null;
    const races = [...C.history.flatMap((h) => (h.races ?? []).map((r) => top(r.res)).filter(Boolean)), ...C.results.map((r) => r?.[0]).filter(Boolean)];
    const withRaces = C.history.filter((h) => h.races?.some((r) => r.res)).length;
    const table = sortTable(tally(races, titles), driverCols((d) => this.hn(d), (d) => this.dn(d)), this.atSort?.d, { id: "d" });
    return `<details class="cr-hedit" ${this.atOpen ? "open" : ""}><summary data-act="attoggle">All-time records (Tier 1)</summary>
      <p class="muted small">Tier 1 races: ${races.length} (${withRaces} of ${C.history.length} finished seasons have race results${C.results.some(Boolean) ? ", plus this season so far" : ""}); titles = Tier 1 champions of every season. Click a column to sort by it.</p>
      ${table}</details>`;
  }
  historyView() {
    const C = this.C;
    if (!C.history.length) return `<div class="cr-note">No completed seasons yet.</div>` + this.newsList();
    const imp = `<div class="su-bar"><label class="btn file" for="cr-arcfile" title="Pick old save files of this game (you can select many at once, or a results archive). Seasons finished before race results were kept get their races back, from the save of that season with the most rounds.">Import past race results…<input type="file" id="cr-arcfile" accept=".json,application/json" multiple hidden></label>
      <span class="muted small">Seasons finished before v51 kept no race-by-race results: select this career's old save files to bring them back.</span></div>`;
    const seasons = [...C.history].reverse().map((h) => {
      const champs = h.tables.map((tb, t) => `<li>Tier ${t + 1}: <b>${esc(this.pairLabel(tb[0].p))}</b> · ${esc(this.dn(tb[0].d))} · ${tb[0].pts} pts</li>`).join("");
      const mine = h.tables.flatMap((tb, t) => tb.filter((x) => this.mineRow(x)).map((x) => `<li>${esc(this.pairLabel(x.p))}: Tier ${t + 1}, P${x.pos}, ${x.pts} pts, ${x.wins} wins · prize ${fmtM(x.prize)} · ${esc(this.dn(x.d))}</li>`)).join("");
      const mv = h.moves.filter((m) => (this.drv ? h.tables.some((tb) => tb.some((x) => x.p === m.p && x.d === this.me)) : this.mine(m.p))).map((m) => `<li>${esc(this.pairLabel(m.p))} ${m.to < m.from ? "promoted" : "relegated"} to Tier ${m.to + 1}</li>`).join("");
      const has = h.races?.some((r) => r.res), open = this.hOpen === h.season;
      return `<div class="cr-card"><header><b>Season ${h.season}</b> ${has ? `<button class="btn" data-act="hseason" data-s="${h.season}">${open ? "Hide results" : "Race results"}</button>` : `<span class="muted small">race results not saved</span>`}</header><div class="cr-cols"><div><h4>Champions</h4><ul>${champs}</ul></div><div><h4>${this.drv ? "Your season" : "Your entries"}</h4><ul>${mine}${mv}</ul></div></div>
        ${open && has ? this.seasonGridHTML(h) : ""}</div>`;
    }).join("");
    return this.allTimeHTML() + imp + seasons + this.newsList();
  }
  newsList() {
    const n = this.C.news.slice(-30).reverse();
    return n.length ? `<h3>News</h3><ul class="cr-log">${n.map((x) => `<li class="${x.mine ? "mine" : ""}"><span class="muted">S${x.season}</span> ${esc(x.text)}</li>`).join("")}</ul>` : "";
  }

  saveView() {
    const all = this.h.store.get("careerSlots") ?? {};
    const slots = Object.keys(all).sort().map((n) => `<tr><td>${esc(n)}</td><td><button class="btn" data-act="slotload" data-n="${esc(n)}">Load</button> <button class="btn" data-act="slotdel" data-n="${esc(n)}">${this.armLabel(`del:${n}`, "Delete")}</button></td></tr>`).join("");
    return `<p class="muted small">The career autosaves in this browser after every step. Browser saves can be lost if site data is cleared: download a save file to keep it for good.</p>
      <div class="su-bar"><input id="cr-slot" placeholder="Save name" aria-label="Save name"><button class="btn primary" data-act="slotsave">Save in this browser</button>
        <button class="btn" data-act="download">Download save file</button>
        <label class="btn file" for="cr-file">Load save file<input type="file" id="cr-file" accept=".json,application/json" hidden></label>
        <span class="spacer"></span><button class="btn" data-act="newcareer">${this.armLabel("new", "New career…")}</button></div>
      <table class="cr-t"><tbody>${slots || "<tr><td class=\"muted\">No saves in this browser yet.</td></tr>"}</tbody></table>
      <textarea id="cr-json" rows="3" spellcheck="false" aria-label="Save file text" placeholder="If downloads are blocked, the save appears here to copy."></textarea>`;
  }

  // ---------- driver career ----------
  // the entry the player drives this season (market: the one signed for next season, else this season's)
  myPair() {
    const C = this.C;
    if (C.market) { const h = C.market.held[this.me]; if (h) return h.pair; }
    return K.myPair(C);
  }
  helmetImg(size = 56) {
    const u = this.C?.me?.helmet ?? this.hel.out;
    return u ? `<img class="cr-helmet" src="${u}" alt="Your helmet" style="height:${size}px">` : `<span class="cr-helmet none" style="height:${size}px;width:${size}px" aria-label="No helmet picture"></span>`;
  }
  meCard() {
    const C = this.C, me = this.me, pk = this.ix.peaks.get(me);
    const c = C.contracts[me], h = C.market?.held[me];
    const rank = [...this.ix.peaks.values()].filter((x) => x.score < pk.score).length + 1;
    let seat = '<span class="bad">No seat yet</span>';
    if (h && !h.own) seat = `Signed for next season: <b>${esc(this.pairLabel(h.pair))}</b> (Tier ${C.pairs[h.pair].tier + 1}) · ${h.years} season${h.years === 1 ? "" : "s"} · ${fmtM(h.salary ?? 0)} a season`;
    else if (c) seat = `<b>${esc(this.pairLabel(c.pair))}</b> (Tier ${C.pairs[c.pair].tier + 1}) · ${esc(this.contractText(me))} · ${fmtM(c.salary ?? 0)} a season`;
    const skills = Object.entries(K.SKILL_UP).map(([k, u]) => {
      const L = C.me.lv[k] ?? 0, cost = K.skillCost(k, L);
      const pct = Math.round(100 * K.skillPct(L));
      return `<div class="cr-up" title="${esc(u.hint)}"><span>${u.label}</span><span class="lv">${"■".repeat(L)}${"□".repeat(K.SKILL_MAX - L)}</span><span class="muted" title="Better than this share of all drivers at their peak">top ${100 - pct}%</span>
        ${cost === null ? "<span>max</span>" : `<button class="btn" data-act="skill" data-s="${k}" ${C.me.money < cost ? "disabled" : ""}>+1 · ${fmtM(cost)}</button>`}</div>`;
    }).join("");
    return `<div class="cr-card cr-me"><header>${this.helmetImg(40)}<b>${esc(C.me.name)}</b><span class="badge">${esc(this.ix.drivers.get(me)?.code ?? "")}</span><span class="muted">rating ${pk.rating} · #${rank} of ${this.ix.peaks.size}</span></header>
      <div>${seat}</div>
      <div class="muted small">Earned so far ${fmtM(C.me.earned ?? 0)}: salary (paid race by race), result bonuses, and a quarter of your entry's season prize.</div>
      <div class="cr-ups">${skills}</div>
      <details class="cr-hedit" ${C.me.helmet ? "" : "open"}><summary>Helmet picture</summary>${this.helmetBox()}</details>
      <div class="muted small">Each level is measured against every driver in the game at their peak. Teams choose drivers on pace (your rating); the other skills win you places in the races.</div></div>`;
  }
  drvMarketMsg() {
    const C = this.C, M = C.market;
    if (M.done) return "The market is closed. Start the season when you're ready.";
    if (M.myOffers.length) return `${M.myOffers.length} offer${M.myOffers.length === 1 ? "" : "s"} for you (round ${M.round}). Accept one, or decline; unanswered offers lapse when the next round runs.`;
    return `Round ${M.round}: no offer for you this round. ${M.open.length} seats still open.`;
  }
  drvMarketView() {
    const C = this.C, M = C.market, me = this.me;
    const c = C.contracts[me], h = M.held[me];
    const firm = (c?.left ?? 0) >= 2;
    let status;
    if (firm) status = `You are under contract with <b>${esc(this.pairLabel(c.pair))}</b> for ${c.left - 1} more season${c.left === 2 ? "" : "s"} after this offseason: no team can approach you this year.`;
    else if (h && h.own) status = `Your contract with <b>${esc(this.pairLabel(h.pair))}</b> has one season left. Accept an offer to move (or to extend), or stay for the last year.`;
    else if (h) status = `You have agreed terms with <b>${esc(this.pairLabel(h.pair))}</b> (Tier ${C.pairs[h.pair].tier + 1}, ${h.years} season${h.years === 1 ? "" : "s"}, ${fmtM(h.salary ?? 0)} a season). A better offer can still come; accepting it means leaving this deal.`;
    else status = "You have no seat for next season. Teams make offers as the market runs; if nobody signs you by the end, the weakest signing in the lowest tier loses their drive to you for one season.";
    const cur = h ? h.pair : null;
    const offers = M.myOffers.map((o, k) => {
      const pr = C.pairs[o.pair], better = cur === null ? null : K.driverValue(this.db, C, o.pair) - K.driverValue(this.db, C, cur);
      return `<tr><td><b>${esc(this.pairLabel(o.pair))}</b>${o.ext ? ' <span class="badge">extension</span>' : ""}</td><td class="n">T${pr.tier + 1}</td><td>${esc(this.carLabel(o.pair))} <span class="muted">${this.carR(o.pair)}</span></td>
        <td class="n">${o.years}</td><td class="n b">${fmtM(o.salary)}</td><td>${better === null ? "" : better > 0 ? '<span class="ok">better car than your deal</span>' : '<span class="muted">not better than your deal</span>'}</td>
        <td><button class="btn primary" data-act="maccept" data-k="${k}">Accept</button> <button class="btn" data-act="mdecline" data-k="${k}">Decline</button></td></tr>`;
    }).join("");
    const log = M.log.slice(-40).reverse().map((l) => `<li class="${l.mine ? "mine" : ""}"><span class="muted">R${l.r}</span> ${esc(l.text)}</li>`).join("");
    return `<div class="cr-market"><div class="cr-mleft">
        <h3>Your situation</h3><div class="cr-note">${status}</div>
        <h3>Offers for you</h3>
        ${offers ? `<table class="cr-t"><thead><tr><th>Entry</th><th>Tier</th><th>Car</th><th>Seasons</th><th>Salary</th><th></th><th></th></tr></thead><tbody>${offers}</tbody></table>`
          : `<p class="muted">${firm ? "None: you are under contract." : M.done ? "The market is closed." : "No offers right now. Run the market: it stops as soon as a team makes you an offer."}</p>`}
        <p class="muted small">Teams pick drivers on pace (your rating) and their scouts' judgement, the best cars first. Salary depends on the tier and on how good you are. Contracts run from 1 to 6 seasons; while one has two or more seasons left, you can't move.</p>
      </div><div class="cr-mright"><h3>Market news</h3><ol class="cr-log">${log || "<li class=\"muted\">No moves yet.</li>"}</ol></div></div>`;
  }
  newDriverView() {
    const h = this.hel;
    return `<div class="cr-new">
      <p>Start as a driver on the market, with ${fmtM(K.ME_START_MONEY)} to spend on your skills. The 117 seats belong to every constructor's car in each decade; the drivers are everyone who raced from 1950 to 2024, at their peak. Teams sign you if you're quick enough; money from salary and results buys better skills.</p>
      <div class="cr-drvform">
        <div class="cr-drvfields">
          <label for="cr-name">Name <input id="cr-name" maxlength="40" value="${esc(this.newName)}" placeholder="Your driver's name" autocomplete="off"></label>
          <label for="cr-code">Code <input id="cr-code" maxlength="3" value="${esc(this.newCode)}" placeholder="ABC" style="width:60px;text-transform:uppercase" autocomplete="off"></label>
          <label for="cr-seed">Seed <input id="cr-seed" type="number" min="1" value="${this.newSeed}" style="width:90px"></label>
          <label for="cr-rules" title="Sets overtaking, pit stops, safety cars and reliability for every race">Rules year <input id="cr-rules" type="number" min="1950" max="2024" value="${this.newRules}" style="width:70px"></label>
          <label for="cr-calmode" title="Fixed: you choose the venues. Shuffle: the same venues in a new order each offseason. Random: a new draw of venues each offseason. Iconic: a new draw each offseason, favouring iconic layouts (strength set in the Calendar tab)">Calendar <select id="cr-calmode">${K.CAL_MODES.map(([m, l]) => `<option value="${m}" ${m === this.newCal ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
        </div>
        ${this.helmetBox()}
      </div>
      <div class="su-bar"><span class="spacer"></span><button class="btn primary" data-act="startdrv" ${this.newName.trim() ? "" : "disabled"}>Start driver career</button></div>
    </div>`;
  }
  // helmet picker: a drop zone (click to choose, drop a file, or paste) with the picture options
  helmetBox() {
    const h = this.hel, cur = this.C?.mode === "driver" ? this.C.me.helmet : h.out;
    return `<div class="cr-drvhelmet">
          <label class="cr-hdrop" for="cr-hfile" title="Click to choose a picture, or drop one here">
            ${cur ? `<img src="${cur}" alt="Your helmet">` : ""}
            <span class="small">${cur ? "Drop or click to change" : "<b>Drop a helmet picture here</b><br>or click to choose one (you can also paste it)"}</span>
            <input type="file" id="cr-hfile" accept="image/*" hidden></label>
          <div class="cr-hopts">
            <label class="inline"><input type="checkbox" id="cr-hbg" ${h.bg ? "checked" : ""}> Remove plain background</label>
            <label class="inline"><input type="checkbox" id="cr-hmirror" ${h.mirror ? "checked" : ""}> Mirror (the helmet should face right, like the cars)</label>
            <span class="muted small">A side view works best. It is cropped to the helmet and kept small (it's drawn on the car).${cur ? "" : " Without a picture you get a plain helmet in your team's colour."}</span>
            ${cur && this.C ? '<button class="btn" data-act="hclear">Remove picture</button>' : ""}
          </div>
        </div>`;
  }
  loadHelmet(file) {
    if (!file || !/^image\//.test(file.type || "image/")) { this.msg("That isn't a picture file."); return; }
    const r = new FileReader();
    r.onload = () => { this.hel.src = r.result; this.processHelmet(); };
    r.onerror = () => this.msg("Could not read that picture.");
    r.readAsDataURL(file);
  }
  // the uploaded picture -> a small PNG: optional plain-background removal (colour of the corners), cropped to
  // what's left, at most 128 px, optionally mirrored
  processHelmet() {
    const h = this.hel;
    if (!h.src) { this.render(); return; }
    const im = new Image();
    im.onload = () => {
      const s = Math.min(1, 512 / Math.max(im.naturalWidth, im.naturalHeight));
      const W = Math.max(1, Math.round(im.naturalWidth * s)), H = Math.max(1, Math.round(im.naturalHeight * s));
      const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
      const g = cv.getContext("2d");
      if (h.mirror) { g.translate(W, 0); g.scale(-1, 1); }
      g.drawImage(im, 0, 0, W, H);
      const px = g.getImageData(0, 0, W, H), a = px.data;
      if (h.bg) {
        const cs = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]].map(([x, y]) => (y * W + x) * 4).filter((i) => a[i + 3] > 200);
        if (cs.length) {
          const bg = [0, 1, 2].map((c) => cs.reduce((t, i) => t + a[i + c], 0) / cs.length);
          // flood from the edges through pixels close to the background colour (keeps a white visor inside the helmet)
          const near = (i) => a[i + 3] > 0 && Math.abs(a[i] - bg[0]) + Math.abs(a[i + 1] - bg[1]) + Math.abs(a[i + 2] - bg[2]) < 60;
          const seen = new Uint8Array(W * H), st = [];
          for (let x = 0; x < W; x++) st.push(x, (H - 1) * W + x);
          for (let y = 0; y < H; y++) st.push(y * W, y * W + W - 1);
          while (st.length) {
            const q = st.pop();
            if (seen[q]) continue; seen[q] = 1;
            if (!near(q * 4)) continue;
            a[q * 4 + 3] = 0;
            const x = q % W, y = (q / W) | 0;
            if (x > 0) st.push(q - 1); if (x < W - 1) st.push(q + 1); if (y > 0) st.push(q - W); if (y < H - 1) st.push(q + W);
          }
          g.putImageData(px, 0, 0);
        }
      }
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (a[(y * W + x) * 4 + 3] > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 < 0) { this.msg("Nothing was left after removing the background: try without it."); h.out = null; this.render(); return; }
      const cw = x1 - x0 + 1, ch = y1 - y0 + 1, k = Math.min(1, 128 / Math.max(cw, ch));
      const out = document.createElement("canvas"); out.width = Math.max(1, Math.round(cw * k)); out.height = Math.max(1, Math.round(ch * k));
      const o = out.getContext("2d"); o.imageSmoothingQuality = "high";
      o.drawImage(cv, x0, y0, cw, ch, 0, 0, out.width, out.height);
      h.out = out.toDataURL("image/png");
      if (this.C?.mode === "driver") {           // during a career: the new helmet applies straight away
        this.C.me.helmet = h.out; this.helmetHook(); this.save(); this.msg("Helmet updated.");
      }
      this.render();
    };
    im.onerror = () => this.msg("That file is not a picture the browser can read.");
    im.src = h.src;
  }
}
