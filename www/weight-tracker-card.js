/* weight-tracker-card: food log, barcode scan, water, weight, BP, notes, trends & settings.
   Backend: custom_components/weight_tracker (websocket weight_tracker/*). */
const WT_VERSION = "1.0.0";
const MEALS = ["breakfast", "lunch", "dinner", "snacks"];
const MEAL_LABEL = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snacks: "Snacks" };
const MEAL_ICON = { breakfast: "mdi:coffee", lunch: "mdi:food", dinner: "mdi:silverware-fork-knife", snacks: "mdi:cookie" };
const NUTS = [
  ["kcal", "Calories", "kcal"], ["protein", "Protein", "g"], ["carbs", "Carbs", "g"], ["fat", "Fat", "g"],
  ["sat_fat", "Saturated fat", "g"], ["fiber", "Fiber", "g"], ["sugar", "Sugar", "g"],
  ["sodium_mg", "Sodium", "mg"], ["chol_mg", "Cholesterol", "mg"],
];
const LIMITS = new Set(["sat_fat", "sugar", "sodium_mg", "chol_mg"]); // goal = upper limit
const REMINDERS = [
  ["breakfast", "Breakfast not logged"], ["lunch", "Lunch not logged"], ["dinner", "Dinner not logged"],
  ["weigh_in", "No weigh-in today"], ["water", "Behind on water"], ["summary", "Daily summary"],
];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v, d = 0) => (v == null || isNaN(v) ? "–" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return isoDate(d); };
const fmtDay = (iso, opts = { weekday: "short", month: "short", day: "numeric" }) => new Date(iso + "T12:00:00").toLocaleDateString(undefined, opts);
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "");

function upcEtoA(c) {
  if (!/^[01]\d{7}$/.test(c)) return c;
  const d = c.slice(1, 7), last = d[5];
  let m, p;
  if ("012".includes(last)) { m = d[0] + d[1] + last + "00"; p = "00" + d[2] + d[3] + d[4]; }
  else if (last === "3") { m = d.slice(0, 3) + "00"; p = "000" + d[3] + d[4]; }
  else if (last === "4") { m = d.slice(0, 4) + "0"; p = "0000" + d[4]; }
  else { m = d.slice(0, 5); p = "0000" + last; }
  return c[0] + m + p + c[7];
}

function portionsOf(food) {
  const out = [];
  const seen = new Set();
  for (const p of food.portions || []) {
    if (!p || !p.g || seen.has(p.label)) continue;
    seen.add(p.label); out.push({ label: p.label, g: +p.g });
  }
  if (food.serving_g && !out.some((p) => p.g === food.serving_g)) out.unshift({ label: food.serving_label || `${food.serving_g} ${food.unit || "g"}`, g: food.serving_g });
  const u = food.unit === "ml" ? "ml" : "g";
  if (!food.custom) out.push({ label: `100 ${u}`, g: 100 });
  out.push({ label: u === "ml" ? "ml" : "grams", g: 1 });
  return out;
}

class WeightTrackerCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    const hash = (location.hash || "").replace("#", "");
    this._tab = ["today", "trends", "health", "settings"].includes(hash) ? hash : this._config.tab || "today";
    this._date = null;
    this._range = 30;
    this._sheet = null;
  }
  getCardSize() { return 12; }
  getGridOptions() { return { columns: "full", rows: "auto" }; }

  set hass(h) {
    const first = !this._hass;
    this._hass = h;
    this._dark = !!h.themes?.darkMode;
    this.toggleAttribute("dark", this._dark);
    if (first) this._init();
  }

  connectedCallback() { if (this._hass && !this._unsub) this._subscribe(); }
  disconnectedCallback() {
    if (this._unsub) { this._unsub.then((u) => u && u()).catch(() => {}); this._unsub = null; }
    this._stopCamera();
  }

  async _init() {
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `<style>${this._css()}</style><div class="wrap"><nav class="tabs"></nav><div id="alerts"></div><main id="main"><div class="loading">Loading…</div></main></div><div id="sheet"></div><div id="tip" class="tip" hidden></div>`;
    this.shadowRoot.addEventListener("click", (e) => this._onClick(e));
    this.shadowRoot.addEventListener("change", (e) => this._onChange(e));
    this.shadowRoot.addEventListener("input", (e) => this._onInput(e));
    this.shadowRoot.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.dataset.enter) { e.preventDefault(); this._act(e.target.dataset.enter, e.target); } });
    this._subscribe();
    await this._load();
  }

  _subscribe() {
    try {
      this._unsub = this._hass.connection.subscribeMessage(() => {
        clearTimeout(this._subT);
        this._subT = setTimeout(() => this._load(true), 400);
      }, { type: "weight_tracker/subscribe" });
    } catch (e) { /* not loaded */ }
  }

  ws(type, data = {}) { return this._hass.callWS({ type: `weight_tracker/${type}`, ...data }); }

  async _load(fromPush = false) {
    try {
      if (this._tab === "settings") {
        if (fromPush) return;
        this._settings = await this.ws("settings/get");
      } else {
        const date = this._date || undefined;
        this._day = await this.ws("day", date ? { date } : {});
        if (!this._date) this._date = this._day.today;
        if (this._tab === "trends") await this._loadRange();
        if (this._tab === "health") {
          const [w, b, n] = await Promise.all([this.ws("history", { kind: "weights", limit: 30 }), this.ws("history", { kind: "bp", limit: 30 }), this.ws("history", { kind: "notes", limit: 30 })]);
          this._hist = { weights: w.rows, bp: b.rows, notes: n.rows };
          if (!this._settings) this._settings = await this.ws("settings/get");
        }
      }
      this._error = null;
    } catch (e) {
      this._error = e.message || String(e);
    }
    this._render();
  }

  async _loadRange() {
    const end = this._day?.today || isoDate(new Date());
    const start = addDays(end, -(this._range - 1));
    this._rangeData = await this.ws("range", { start, end });
    if (this._range < 7) this._week = this._rangeData;
    else this._week = await this.ws("range", { start: addDays(end, -6), end });
  }

  get _s() { return this._day?.settings || this._settings?.settings || {}; }

  // ------------------------------------------------------------------ render
  _render() {
    const root = this.shadowRoot;
    const tabs = [["today", "mdi:food-apple", "Today"], ["trends", "mdi:chart-line", "Trends"], ["health", "mdi:heart-pulse", "Health"], ["settings", "mdi:cog", "Settings"]];
    root.querySelector(".tabs").innerHTML = tabs.map(([k, i, l]) => `<button class="tab ${this._tab === k ? "on" : ""}" data-act="tab" data-v="${k}"><ha-icon icon="${i}"></ha-icon><span>${l}</span></button>`).join("");
    const alerts = (this._day?.alerts || []).filter(() => this._tab !== "settings");
    root.getElementById("alerts").innerHTML = alerts.map((a) => `<div class="alert"><ha-icon icon="mdi:bell-ring"></ha-icon><div><b>${esc(a.title)}</b><div>${esc(a.message)}</div></div><button class="icon-btn" data-act="dismiss" data-v="${esc(a.kind)}" aria-label="Dismiss"><ha-icon icon="mdi:close"></ha-icon></button></div>`).join("");
    const main = root.getElementById("main");
    if (this._error) { main.innerHTML = `<div class="card err"><b>Weight Tracker isn't responding.</b><div>${esc(this._error)}</div><button class="btn" data-act="reload">Try again</button></div>`; return; }
    if (this._tab === "today") main.innerHTML = this._renderToday();
    else if (this._tab === "trends") { main.innerHTML = this._renderTrends(); this._wireCharts(); }
    else if (this._tab === "health") main.innerHTML = this._renderHealth();
    else main.innerHTML = this._renderSettings();
  }

  _renderToday() {
    const d = this._day; if (!d) return `<div class="loading">Loading…</div>`;
    const s = this._s, t = d.totals || {}, goal = s.daily_kcal || 0, kcal = t.kcal || 0;
    const left = goal - kcal, pct = goal ? Math.min(kcal / goal, 1) : 0, over = left < 0;
    const C = 2 * Math.PI * 52;
    const isToday = d.date === d.today;
    const macro = (k, label) => {
      const g = s.goals?.[k] || 0, v = t[k] || 0, p = g ? Math.min(v / g, 1) * 100 : 0;
      return `<div class="macro"><div class="mrow"><span><i class="dot" style="background:var(--s-${k})"></i>${label}</span><span><b>${num(v)}</b> / ${num(g)} g</span></div><div class="bar"><div style="width:${p}%;background:var(--s-${k})"></div></div></div>`;
    };
    const sm = d.summary || {};
    const wgoal = s.water_goal_oz || 0, woz = d.water_oz || 0;
    let h = `<div class="datenav"><button class="icon-btn" data-act="day" data-v="-1" aria-label="Previous day"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
      <div class="dtitle">${isToday ? "Today" : fmtDay(d.date, { weekday: "long", month: "short", day: "numeric" })}${!isToday ? `<button class="link" data-act="today">Go to today</button>` : ""}</div>
      <button class="icon-btn" data-act="day" data-v="1" ${isToday ? "disabled" : ""} aria-label="Next day"><ha-icon icon="mdi:chevron-right"></ha-icon></button></div>`;
    h += `<section class="card hero"><div class="ring"><svg viewBox="0 0 120 120" role="img" aria-label="${num(kcal)} of ${num(goal)} calories">
        <circle cx="60" cy="60" r="52" class="track"/><circle cx="60" cy="60" r="52" class="prog ${over ? "over" : ""}" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}" transform="rotate(-90 60 60)"/></svg>
        <div class="ringtxt"><div class="big">${num(Math.abs(left))}</div><div class="sub">${over ? "kcal over" : "kcal left"}</div></div></div>
      <div class="herostats"><div class="eq"><div><b>${num(goal)}</b><span>Goal</span></div><div class="op">−</div><div><b>${num(kcal)}</b><span>Food</span></div><div class="op">=</div><div><b class="${over ? "crit" : ""}">${over ? "" : ""}${num(left)}</b><span>${over ? "⚠ Over" : "Left"}</span></div></div>
        ${macro("protein", "Protein")}${macro("carbs", "Carbs")}${macro("fat", "Fat")}</div></section>`;
    h += `<div class="grid2"><section class="card"><div class="ch"><ha-icon icon="mdi:cup-water"></ha-icon><b>Water</b><span class="muted">${num(woz, 1)} / ${num(wgoal)} oz</span></div>
        <div class="bar water"><div style="width:${wgoal ? Math.min(woz / wgoal, 1) * 100 : 0}%"></div></div>
        <div class="btnrow"><button class="chip" data-act="water" data-v="8">+8 oz</button><button class="chip" data-act="water" data-v="16">+16 oz</button><button class="chip" data-act="water" data-v="24">+24 oz</button><button class="chip" data-act="sheet" data-v="water">Other…</button>
        ${d.water?.length ? `<button class="chip ghost" data-act="undo-water" data-v="${d.water[d.water.length - 1].id}" aria-label="Undo last water">Undo</button>` : ""}</div></section>
      <section class="card"><div class="ch"><ha-icon icon="mdi:scale-bathroom"></ha-icon><b>Weight</b><button class="link r" data-act="sheet" data-v="weight">Log</button></div>
        ${sm.weight ? `<div class="wline"><span class="big2">${num(sm.weight, 1)}</span> lb ${sm.weight_change_7d != null ? `<span class="chg">${sm.weight_change_7d > 0 ? "▲" : sm.weight_change_7d < 0 ? "▼" : "■"} ${num(Math.abs(sm.weight_change_7d), 1)} lb in 7 days</span>` : ""}</div>
          <div class="muted small">${sm.goal_weight ? `${num(Math.max(sm.to_goal, 0), 1)} lb to goal (${num(sm.goal_weight, 1)})` : "Set a goal weight in Settings"}${sm.lost ? ` · ${num(sm.lost, 1)} lb lost` : ""}</div>
          ${sm.goal_weight && sm.start_weight && sm.start_weight > sm.goal_weight ? `<div class="bar"><div style="width:${Math.max(0, Math.min(1, (sm.start_weight - sm.weight) / (sm.start_weight - sm.goal_weight))) * 100}%;background:var(--s-protein)"></div></div>` : ""}
          <div class="muted small">Last: ${esc(new Date(sm.weight_ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}${d.bp?.length || sm.bp ? ` · BP ${sm.bp.systolic}/${sm.bp.diastolic}` : ""}</div>`
        : `<div class="muted">No weight yet. It comes from Apple Health (your smart scale) or tap Log.</div>`}</section></div>`;
    for (const m of MEALS) {
      const es = d.entries.filter((e) => e.meal === m);
      h += `<section class="card meal"><div class="ch"><ha-icon icon="${MEAL_ICON[m]}"></ha-icon><b>${MEAL_LABEL[m]}</b><span class="muted">${num(d.meal_kcal?.[m] || 0)} kcal</span>
        <button class="btn sm r" data-act="add" data-v="${m}"><ha-icon icon="mdi:plus"></ha-icon>Add</button></div>`;
      if (es.length) h += `<ul class="entries">${es.map((e) => `<li data-act="edit" data-v="${e.id}" tabindex="0"><div class="en"><div class="nm">${esc(e.name)}</div><div class="muted small">${esc(e.brand ? e.brand + " · " : "")}${e.portion_label ? `${num(e.amount, 2)} × ${esc(e.portion_label)}` : "Quick add"}</div></div><div class="kc">${num(e.kcal)}</div></li>`).join("")}</ul>`;
      else h += `<div class="empty"><button class="link" data-act="copy" data-v="${m}">Copy ${MEAL_LABEL[m].toLowerCase()} from the day before</button></div>`;
      h += `</section>`;
    }
    h += `<section class="card"><div class="ch"><ha-icon icon="mdi:nutrition"></ha-icon><b>Other nutrients</b></div><table class="nt"><tbody>${NUTS.slice(4).map(([k, l, u]) => {
      const g = s.goals?.[k], v = t[k];
      const flag = g && v != null && LIMITS.has(k) && v > g;
      return `<tr><td>${l}</td><td class="num">${num(v, k.endsWith("mg") ? 0 : 1)} ${u}</td><td class="num muted">${g ? `${LIMITS.has(k) ? "max " : "goal "}${num(g)} ${u}` : ""}</td><td>${flag ? `<span class="crit">⚠ over</span>` : ""}</td></tr>`;
    }).join("")}</tbody></table></section>`;
    h += `<section class="card"><div class="ch"><ha-icon icon="mdi:note-text"></ha-icon><b>Notes</b></div>
      ${d.notes.map((n) => `<div class="note"><div><span class="muted small">${fmtTime(n.ts)}</span> ${esc(n.text)}</div><button class="icon-btn" data-act="del" data-t="notes" data-v="${n.id}" aria-label="Delete note"><ha-icon icon="mdi:delete-outline"></ha-icon></button></div>`).join("")}
      <div class="row"><input id="note" placeholder="Add a note for ${isToday ? "today" : fmtDay(d.date)}…" data-enter="note"><button class="btn" data-act="note">Save</button></div></section>`;
    return h;
  }

  // ------------------------------------------------------------------ trends
  _renderTrends() {
    const r = this._rangeData; if (!r) return `<div class="loading">Loading…</div>`;
    const s = this._s, days = [];
    for (let i = this._range - 1; i >= 0; i--) days.push(addDays(r.end, -i));
    const byDay = Object.fromEntries(r.days.map((x) => [x.day, x]));
    const water = Object.fromEntries(r.water.map((x) => [x.day, x.oz]));
    const logged = r.days.filter((x) => x.kcal > 0 && x.day !== r.end);
    const avg = (arr, k) => (arr.length ? arr.reduce((a, x) => a + (x[k] || 0), 0) / arr.length : null);
    const onTarget = logged.filter((x) => x.kcal <= (s.daily_kcal || 0)).length;
    const ws = r.weights;
    const wchg = ws.length > 1 ? ws[ws.length - 1].weight - ws[0].weight : null;
    let h = `<div class="chips center">${[7, 30, 90, 365].map((n) => `<button class="chip ${this._range === n ? "on" : ""}" data-act="range" data-v="${n}">${n === 365 ? "1 year" : n + " days"}</button>`).join("")}</div>`;
    h += `<div class="tiles"><div class="tile"><span>Avg calories</span><b>${num(avg(logged, "kcal"))}</b><small>per logged day · goal ${num(s.daily_kcal)}</small></div>
      <div class="tile"><span>On target</span><b>${onTarget}/${logged.length}</b><small>days at or under goal</small></div>
      <div class="tile"><span>Weight change</span><b>${wchg == null ? "–" : (wchg > 0 ? "+" : "") + num(wchg, 1) + " lb"}</b><small>${ws.length ? `${num(ws[0].weight, 1)} → ${num(ws[ws.length - 1].weight, 1)}` : "no weigh-ins"}</small></div>
      <div class="tile"><span>Avg water</span><b>${num(r.water.length ? r.water.reduce((a, x) => a + x.oz, 0) / r.water.length : null)} oz</b><small>goal ${num(s.water_goal_oz)} oz</small></div></div>`;
    this._charts = {};
    const lab = days.map((d) => fmtDay(d, { month: "short", day: "numeric" }));
    this._charts.kcal = { labels: lab, unit: "kcal", goal: s.daily_kcal, goalLabel: "Goal", series: [{ name: "Calories", key: "kcal", type: "bar", values: days.map((d) => byDay[d]?.kcal ?? null) }] };
    const wdays = {}; for (const w of ws) wdays[w.day] = w.weight;
    this._charts.weight = { labels: lab, unit: "lb", goal: s.goal_weight, goalLabel: "Goal", dec: 1, series: [{ name: "Weight", key: "weight", type: "line", values: days.map((d) => wdays[d] ?? null) }] };
    this._charts.macros = { labels: lab, unit: "g", stacked: true, series: [["protein", "Protein"], ["carbs", "Carbs"], ["fat", "Fat"]].map(([k, n]) => ({ name: n, key: k, type: "bar", values: days.map((d) => byDay[d]?.[k] ?? null) })) };
    this._charts.water = { labels: lab, unit: "oz", goal: s.water_goal_oz, goalLabel: "Goal", series: [{ name: "Water", key: "water", type: "bar", values: days.map((d) => water[d] ?? null) }] };
    const bpd = {}; for (const b of r.bp) bpd[b.day] = b;
    this._charts.bp = { labels: lab, unit: "mmHg", series: [{ name: "Systolic", key: "sys", type: "line", values: days.map((d) => bpd[d]?.systolic ?? null) }, { name: "Diastolic", key: "dia", type: "line", values: days.map((d) => bpd[d]?.diastolic ?? null) }] };
    const box = (id, title, legend) => `<section class="card"><div class="ch"><b>${title}</b>${legend ? `<div class="legend r">${legend}</div>` : ""}</div><div class="chart" data-chart="${id}">${this._svg(this._charts[id])}</div></section>`;
    const lg = (items) => items.map(([k, n]) => `<span><i class="dot" style="background:var(--s-${k})"></i>${n}</span>`).join("");
    h += box("kcal", "Calories per day");
    h += box("weight", "Weight");
    h += box("macros", "Protein, carbs & fat (g)", lg([["protein", "Protein"], ["carbs", "Carbs"], ["fat", "Fat"]]));
    h += box("water", "Water (oz)");
    if (r.bp.length) h += box("bp", "Blood pressure", lg([["sys", "Systolic"], ["dia", "Diastolic"]]));
    const wk = this._week?.days || [];
    const wkLogged = wk.filter((x) => x.kcal > 0);
    h += `<section class="card"><div class="ch"><b>Nutrients</b><span class="muted small r">averages use days with food logged</span></div><table class="nt"><thead><tr><th></th><th class="num">Avg/day (${this._range === 365 ? "1 yr" : this._range + " d"})</th><th class="num">Last 7 days total</th><th class="num">Daily goal</th></tr></thead><tbody>
      ${NUTS.map(([k, l, u]) => { const g = k === "kcal" ? s.daily_kcal : s.goals?.[k]; return `<tr><td>${l}</td><td class="num">${num(avg(logged, k), k === "kcal" || u === "mg" ? 0 : 1)} ${u}</td><td class="num">${num(wkLogged.reduce((a, x) => a + (x[k] || 0), 0))} ${u}</td><td class="num muted">${g ? (LIMITS.has(k) ? "max " : "") + num(g) + " " + u : "–"}</td></tr>`; }).join("")}</tbody></table></section>`;
    if (r.notes.length) h += `<section class="card"><div class="ch"><b>Notes</b></div>${r.notes.slice(0, 20).map((n) => `<div class="note"><div><span class="muted small">${fmtDay(n.day)}</span> ${esc(n.text)}</div></div>`).join("")}</section>`;
    return h;
  }

  _svg(c) {
    const W = 640, H = 220, L = 44, R = 12, T = 14, B = 26, pw = W - L - R, ph = H - T - B;
    const n = c.labels.length;
    let vals = [];
    if (c.stacked) for (let i = 0; i < n; i++) vals.push(c.series.reduce((a, s) => a + (s.values[i] || 0), 0));
    else for (const s of c.series) vals = vals.concat(s.values.filter((v) => v != null));
    if (c.goal) vals.push(c.goal);
    const has = c.series.some((s) => s.values.some((v) => v != null));
    if (!has) return `<div class="nodata">Nothing logged in this period yet.</div>`;
    const isLine = c.series[0].type === "line";
    let lo = isLine ? Math.min(...vals) : 0, hi = Math.max(...vals, 1);
    if (isLine) { const pad = Math.max((hi - lo) * 0.15, 2); lo = Math.floor(lo - pad); hi = Math.ceil(hi + pad); }
    const nice = (x) => { const p = Math.pow(10, Math.floor(Math.log10(x))); const m = x / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };
    const step = nice((hi - lo) / 4 || 1);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const y = (v) => T + ph - ((v - lo) / (hi - lo || 1)) * ph;
    const bw = pw / n, x = (i) => L + bw * i + bw / 2;
    let g = "";
    for (let v = lo; v <= hi + 1e-9; v += step) g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${num(v)}</text>`;
    const every = Math.ceil(n / 7);
    for (let i = 0; i < n; i += every) g += `<text class="ax" x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(c.labels[i])}</text>`;
    const barW = Math.max(2, Math.min(28, bw - 2));
    if (c.stacked) {
      for (let i = 0; i < n; i++) {
        let acc = 0;
        c.series.forEach((s, si) => {
          const v = s.values[i] || 0; if (!v) return;
          const y0 = y(acc), y1 = y(acc + v); acc += v;
          const hgt = Math.max(0, y0 - y1 - (si ? 2 : 0));
          g += `<rect x="${x(i) - barW / 2}" y="${y1}" width="${barW}" height="${hgt}" rx="${si === c.series.length - 1 || !c.series.slice(si + 1).some((z) => z.values[i]) ? 3 : 0}" style="fill:var(--s-${s.key})"/>`;
        });
      }
    } else {
      for (const s of c.series) {
        if (s.type === "bar") {
          s.values.forEach((v, i) => { if (v == null || v <= 0) return; const hgt = Math.max(1, y(lo) - y(v)); g += `<path d="M${x(i) - barW / 2},${y(lo)} v${-(hgt - 3)} q0,-3 3,-3 h${barW - 6} q3,0 3,3 v${hgt - 3} z" style="fill:var(--s-${s.key})"/>`; });
        } else {
          const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)])).filter(Boolean);
          if (pts.length > 1) g += `<polyline fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" style="stroke:var(--s-${s.key})" points="${pts.map((p) => p.join(",")).join(" ")}"/>`;
          if (pts.length <= 40) for (const p of pts) g += `<circle cx="${p[0]}" cy="${p[1]}" r="4" style="fill:var(--s-${s.key});stroke:var(--surface)" stroke-width="2"/>`;
        }
      }
    }
    if (c.goal && c.goal >= lo && c.goal <= hi) g += `<line class="goal" x1="${L}" x2="${W - R}" y1="${y(c.goal)}" y2="${y(c.goal)}"/><text class="ax goalt" x="${W - R}" y="${y(c.goal) - 5}" text-anchor="end">${c.goalLabel} ${num(c.goal, c.dec || 0)}</text>`;
    g += `<line class="xh" x1="0" x2="0" y1="${T}" y2="${T + ph}" visibility="hidden"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="chart" data-l="${L}" data-pw="${pw}" data-n="${n}">${g}</svg>`;
  }

  _wireCharts() {
    const tip = this.shadowRoot.getElementById("tip");
    this.shadowRoot.querySelectorAll(".chart[data-chart]").forEach((el) => {
      const c = this._charts[el.dataset.chart], svg = el.querySelector("svg"); if (!svg) return;
      const xh = svg.querySelector(".xh");
      const move = (ev) => {
        const r = svg.getBoundingClientRect(), vb = 640 / r.width;
        const px = (ev.clientX - r.left) * vb, L = +svg.dataset.l, pw = +svg.dataset.pw, n = +svg.dataset.n;
        const i = Math.max(0, Math.min(n - 1, Math.floor(((px - L) / pw) * n)));
        const cx = L + (pw / n) * (i + 0.5);
        xh.setAttribute("x1", cx); xh.setAttribute("x2", cx); xh.setAttribute("visibility", "visible");
        const rows = c.series.map((s) => `<div><i class="dot" style="background:var(--s-${s.key})"></i>${s.name}: <b>${s.values[i] == null ? "–" : num(s.values[i], c.dec || 0)}</b> ${c.unit}</div>`).join("");
        const tot = c.stacked ? `<div class="muted">Total ${num(c.series.reduce((a, s) => a + (s.values[i] || 0), 0))} g</div>` : "";
        const gl = c.goal && c.series.length === 1 && c.series[0].values[i] != null ? `<div class="muted">${c.series[0].values[i] > c.goal ? "Over" : "Under"} goal by ${num(Math.abs(c.series[0].values[i] - c.goal), c.dec || 0)}</div>` : "";
        tip.innerHTML = `<b>${esc(c.labels[i])}</b>${rows}${tot}${gl}`;
        tip.hidden = false;
        const host = this.getBoundingClientRect();
        let left = ev.clientX - host.left + 12; if (left > host.width - 180) left = ev.clientX - host.left - 190;
        tip.style.left = left + "px"; tip.style.top = ev.clientY - host.top - 10 + "px";
      };
      const leave = () => { tip.hidden = true; xh.setAttribute("visibility", "hidden"); };
      svg.addEventListener("pointermove", move); svg.addEventListener("pointerdown", move); svg.addEventListener("pointerleave", leave);
    });
  }

  // ------------------------------------------------------------------ health
  _renderHealth() {
    const hs = this._hist || { weights: [], bp: [], notes: [] };
    const today = this._day?.today || isoDate(new Date());
    const st = this._settings || {};
    let h = `<section class="card"><div class="ch"><ha-icon icon="mdi:scale-bathroom"></ha-icon><b>Log weight</b></div>
      <div class="form3"><label>Weight (lb)<input id="w_val" type="number" step="0.1" inputmode="decimal"></label><label>Body fat % <span class="muted">(optional)</span><input id="w_bf" type="number" step="0.1" inputmode="decimal"></label><label>Date<input id="w_date" type="date" value="${today}" max="${today}"></label></div>
      <button class="btn" data-act="log-weight">Save weight</button>
      <table class="nt hist"><tbody>${hs.weights.map((w) => `<tr><td>${fmtDay(w.day)} <span class="muted small">${fmtTime(w.ts)}</span></td><td class="num"><b>${num(w.weight, 1)}</b> lb${w.body_fat ? ` · ${num(w.body_fat, 1)}%` : ""}</td><td class="muted small">${esc(w.source === "apple_health" ? "Apple Health" : w.source)}</td><td><button class="icon-btn" data-act="del" data-t="weights" data-v="${w.id}" aria-label="Delete"><ha-icon icon="mdi:delete-outline"></ha-icon></button></td></tr>`).join("") || `<tr><td class="muted">No weights yet</td></tr>`}</tbody></table></section>`;
    h += `<section class="card"><div class="ch"><ha-icon icon="mdi:heart-pulse"></ha-icon><b>Log blood pressure</b></div>
      <div class="form3"><label>Systolic<input id="bp_s" type="number" inputmode="numeric" placeholder="120"></label><label>Diastolic<input id="bp_d" type="number" inputmode="numeric" placeholder="80"></label><label>Pulse <span class="muted">(optional)</span><input id="bp_p" type="number" inputmode="numeric"></label></div>
      <div class="form3"><label class="span2">Note <span class="muted">(optional)</span><input id="bp_n" placeholder="e.g. after coffee"></label><label>Date<input id="bp_date" type="date" value="${today}" max="${today}"></label></div>
      <button class="btn" data-act="log-bp">Save blood pressure</button>
      <table class="nt hist"><tbody>${hs.bp.map((b) => `<tr><td>${fmtDay(b.day)} <span class="muted small">${fmtTime(b.ts)}</span></td><td class="num"><b>${b.systolic}/${b.diastolic}</b>${b.pulse ? ` · ${b.pulse} bpm` : ""}</td><td class="muted small">${esc(b.note || (b.source === "apple_health" ? "Apple Health" : ""))}</td><td><button class="icon-btn" data-act="del" data-t="bp" data-v="${b.id}" aria-label="Delete"><ha-icon icon="mdi:delete-outline"></ha-icon></button></td></tr>`).join("") || `<tr><td class="muted">No readings yet</td></tr>`}</tbody></table></section>`;
    h += `<section class="card"><div class="ch"><ha-icon icon="mdi:apple"></ha-icon><b>Apple Health sync</b></div>
      <p class="small">If your smart scale or blood-pressure cuff saves to Apple Health, an iPhone Shortcut sends new weight and blood-pressure readings here, and can write your daily calories and water back to Health.</p>
      ${st.webhook_url ? `<label class="small">Shortcut URL (keep it private; anyone with it can add readings)<div class="row"><input readonly value="${esc(st.webhook_url)}" id="hook"><button class="btn" data-act="copy-hook">Copy</button></div></label>` : ""}
      <details><summary>How to set up the Shortcut</summary><ol class="small steps">
        <li>In your scale's app, turn on writing weight (and body fat) to Apple Health.</li>
        <li>In Shortcuts, create <b>"Sync Health to Home"</b>: <b>Find Health Samples</b> where Type is Weight, Start Date is in the last 1 day, sorted latest first, limit 5.</li>
        <li>Add <b>Find Health Samples</b> for Blood Pressure Systolic and for Diastolic (last 1 day).</li>
        <li><b>Get Contents of URL</b>: the URL above, Method POST, Request Body JSON with keys <code>weight</code>, <code>weight_date</code> (Start Date of the weight samples), <code>systolic</code>, <code>diastolic</code>, <code>bp_date</code>.</li>
        <li>Optional, to write back: from the reply, get <code>kcal</code> and <code>water_oz</code> and use <b>Log Health Sample</b> (Dietary Energy, Water). Run that part once a day at night so totals aren't counted twice.</li>
        <li>In Shortcuts → Automation, run it daily (e.g. 8:00 and 21:00) and on <b>When [your scale app] is closed</b>, set to <b>Run Immediately</b>.</li></ol>
        <p class="small muted">Readings are de-duplicated by time, so syncing the same sample twice is harmless.</p></details></section>`;
    h += `<section class="card"><div class="ch"><ha-icon icon="mdi:note-text"></ha-icon><b>Recent notes</b></div>${hs.notes.map((n) => `<div class="note"><div><span class="muted small">${fmtDay(n.day)} ${fmtTime(n.ts)}</span> ${esc(n.text)}</div><button class="icon-btn" data-act="del" data-t="notes" data-v="${n.id}" aria-label="Delete"><ha-icon icon="mdi:delete-outline"></ha-icon></button></div>`).join("") || `<div class="muted">No notes yet. Add one from the Today tab.</div>`}</section>`;
    return h;
  }

  // ------------------------------------------------------------------ settings
  _renderSettings() {
    const st = this._settings; if (!st) return `<div class="loading">Loading…</div>`;
    const s = st.settings, g = s.goals || {};
    const inp = (id, label, v, extra = "") => `<label>${label}<input id="${id}" type="number" inputmode="decimal" value="${v ?? ""}" ${extra}></label>`;
    const tgt = s.notify_target;
    const fdb = st.food_db || {};
    let h = `<section class="card"><div class="ch"><ha-icon icon="mdi:flag-checkered"></ha-icon><b>Goals</b></div>
      <div class="form3">${inp("s_start", "Starting weight (lb)", s.start_weight, 'step="0.1"')}${inp("s_goal", "Goal weight (lb)", s.goal_weight, 'step="0.1"')}${inp("s_height", "Height (inches)", s.height_in, 'step="0.5"')}</div>
      <div class="form3">${inp("s_kcal", "Daily calories", s.daily_kcal, 'step="10"')}${inp("s_water", "Water goal (oz)", s.water_goal_oz)}</div>
      <details><summary>Suggest a calorie goal</summary><div class="form3">
        <label>Sex<select id="c_sex"><option value="m">Male</option><option value="f">Female</option></select></label>${inp("c_age", "Age", "")}
        <label>Activity<select id="c_act"><option value="1.2">Mostly sitting</option><option value="1.375" selected>Light (1–3 workouts/wk)</option><option value="1.55">Moderate (3–5/wk)</option><option value="1.725">Very active</option></select></label>
        <label>Lose per week<select id="c_rate"><option value="0.5">0.5 lb</option><option value="1" selected>1 lb</option><option value="1.5">1.5 lb</option><option value="2">2 lb</option></select></label></div>
        <button class="btn ghost" data-act="calc">Calculate</button> <span id="calc_out" class="small"></span></details></section>`;
    h += `<section class="card"><div class="ch"><ha-icon icon="mdi:nutrition"></ha-icon><b>Nutrient goals</b><span class="muted small r">per day</span></div><div class="form3">
      ${inp("g_protein", "Protein (g)", g.protein)}${inp("g_carbs", "Carbs (g)", g.carbs)}${inp("g_fat", "Fat (g)", g.fat)}
      ${inp("g_fiber", "Fiber (g)", g.fiber)}${inp("g_sugar", "Sugar max (g)", g.sugar)}${inp("g_sat_fat", "Sat. fat max (g)", g.sat_fat)}
      ${inp("g_sodium_mg", "Sodium max (mg)", g.sodium_mg)}${inp("g_chol_mg", "Cholesterol max (mg)", g.chol_mg)}</div></section>`;
    h += `<section class="card"><div class="ch"><ha-icon icon="mdi:bell"></ha-icon><b>Notifications</b></div>
      <div class="seg" role="radiogroup">${[["off", "Off"], ["dashboard", "Dashboard"], ["app", "Phone app"], ["both", "Both"]].map(([k, l]) => `<button class="${tgt === k ? "on" : ""}" data-act="target" data-v="${k}" role="radio" aria-checked="${tgt === k}">${l}</button>`).join("")}</div>
      <p class="small muted">Dashboard shows a banner here and in Home Assistant's notification bell. Phone app sends a push that opens this dashboard.</p>
      <label>Send app notifications to<select id="s_notify">${(st.notify_services.length ? st.notify_services : [s.notify_service]).map((n) => `<option value="${esc(n)}" ${n === s.notify_service ? "selected" : ""}>${esc(n.replace("mobile_app_", "").replace(/_/g, " "))}</option>`).join("")}</select></label>
      <div class="rem"><label class="tog"><input type="checkbox" id="s_over" ${s.over_goal_alert ? "checked" : ""}> Alert when I go over my calorie goal</label></div>
      ${REMINDERS.map(([k, l]) => { const r = s.reminders?.[k] || {}; return `<div class="rem"><label class="tog"><input type="checkbox" id="r_${k}_on" ${r.enabled ? "checked" : ""}> ${l}</label><input type="time" id="r_${k}_t" value="${esc(r.time || "")}"></div>`; }).join("")}
      <p class="small muted">Meal, weigh-in and water reminders are only sent if that thing hasn't been logged yet.</p>
      <button class="btn ghost" data-act="test-notify">Send a test</button></section>`;
    h += `<div class="savebar"><button class="btn big" data-act="save-settings">Save settings</button><span id="saved" class="small muted"></span></div>`;
    const c = fdb.counts || {}, m = fdb.meta || {};
    const when = (t) => (t ? new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "–");
    h += `<section class="card"><div class="ch"><ha-icon icon="mdi:database"></ha-icon><b>Food database</b></div>
      ${fdb.ok ? `<table class="nt"><tbody><tr><td>Open Food Facts (US)</td><td class="num">${num(c.off)} products</td></tr><tr><td>USDA FoodData Central</td><td class="num">${num(c.usda)} foods</td></tr>
      <tr><td>Last full rebuild</td><td class="num">${when(+m.built)}</td></tr><tr><td>Last nightly update</td><td class="num">${when(+m.nightly || +m.built)}</td></tr></tbody></table>
      <p class="small muted">Updates every night at 3:15 AM (full rebuild on Sundays). Products that aren't in the database are looked up live on Open Food Facts.</p>`
      : `<div class="muted">The food database isn't ready yet${fdb.error ? ` (${esc(fdb.error)})` : ""}. The first build takes about an hour; barcode lookups fall back to Open Food Facts online until then.</div>`}</section>`;
    return h;
  }

  _readSettings() {
    const $ = (id) => this.shadowRoot.getElementById(id);
    const n = (id) => { const v = $(id)?.value; return v === "" || v == null ? null : Number(v); };
    const goals = {}; for (const k of ["protein", "carbs", "fat", "fiber", "sugar", "sat_fat", "sodium_mg", "chol_mg"]) goals[k] = n("g_" + k);
    const reminders = {}; for (const [k] of REMINDERS) reminders[k] = { enabled: $(`r_${k}_on`).checked, time: $(`r_${k}_t`).value };
    return {
      start_weight: n("s_start"), goal_weight: n("s_goal"), height_in: n("s_height"), daily_kcal: n("s_kcal") || 2000, water_goal_oz: n("s_water") || 64,
      goals, notify_target: this._settings.settings.notify_target, notify_service: $("s_notify").value, over_goal_alert: $("s_over").checked, reminders,
    };
  }

  // ------------------------------------------------------------------ sheet (modal)
  _openSheet(sheet) { this._sheet = sheet; this._renderSheet(); }
  _closeSheet() { this._stopCamera(); this._sheet = null; this.shadowRoot.getElementById("sheet").innerHTML = ""; }

  _renderSheet() {
    const el = this.shadowRoot.getElementById("sheet"), sh = this._sheet;
    if (!sh) { el.innerHTML = ""; return; }
    let body = "", title = "";
    const mealChips = (cur) => `<div class="chips">${MEALS.map((m) => `<button class="chip ${cur === m ? "on" : ""}" data-act="sheet-meal" data-v="${m}">${MEAL_LABEL[m]}</button>`).join("")}</div>`;
    if (sh.mode === "add") {
      title = `Add food`;
      body = `${mealChips(sh.meal)}<div class="btnrow wide"><button class="btn" data-act="scan"><ha-icon icon="mdi:barcode-scan"></ha-icon>Scan barcode</button><button class="btn ghost" data-act="quick"><ha-icon icon="mdi:lightning-bolt"></ha-icon>Quick add</button><button class="btn ghost" data-act="custom"><ha-icon icon="mdi:pencil-plus"></ha-icon>New food</button></div>
        <div class="search"><ha-icon icon="mdi:magnify"></ha-icon><input id="q" type="search" placeholder="Search foods or type a barcode" value="${esc(sh.q || "")}" autocomplete="off" data-enter="search"></div>
        ${sh.msg ? `<div class="msg">${esc(sh.msg)}</div>` : ""}<div id="results">${this._resultsHtml()}</div>`;
    } else if (sh.mode === "camera") {
      title = "Scan barcode";
      body = `<div class="cam"><video id="vid" playsinline muted></video><div class="aim"></div></div><div class="muted small center">${esc(sh.camMsg || "Point the camera at the barcode.")}</div>
        <div class="row"><input id="manual_code" inputmode="numeric" placeholder="Or type the barcode number" data-enter="manual-code"><button class="btn" data-act="manual-code">Look up</button></div>`;
    } else if (sh.mode === "detail") {
      const f = sh.food, ps = portionsOf(f), p = ps[sh.pi] || ps[0], g = (sh.amount || 0) * p.g;
      const val = (k) => (f.per100?.[k] == null ? null : (f.per100[k] * g) / 100);
      title = sh.entry ? "Edit entry" : "Add food";
      body = `${mealChips(sh.meal)}<div class="food-h">${f.image ? `<img src="${esc(f.image)}" alt="" referrerpolicy="no-referrer">` : ""}<div><div class="nm big3">${esc(f.name)}</div><div class="muted">${esc(f.brand || "")}${f.code ? ` · ${esc(f.code)}` : ""}</div><div class="muted small">${esc({ usda: "USDA", off: "Open Food Facts", "off-live": "Open Food Facts (online)", custom: "My food" }[f.source] || f.source || "")}</div></div>
        ${f.id ? `<button class="icon-btn r" data-act="fav" aria-label="Favorite"><ha-icon icon="${f.favorite ? "mdi:star" : "mdi:star-outline"}"></ha-icon></button>` : ""}</div>
        <div class="amt"><button class="icon-btn" data-act="amt" data-v="-1" aria-label="Less"><ha-icon icon="mdi:minus"></ha-icon></button><input id="amount" type="number" inputmode="decimal" step="any" value="${sh.amount}"><button class="icon-btn" data-act="amt" data-v="1" aria-label="More"><ha-icon icon="mdi:plus"></ha-icon></button>
        <select id="portion">${ps.map((x, i) => `<option value="${i}" ${i === sh.pi ? "selected" : ""}>${esc(x.label)}${x.g !== 1 && !/\b(g|ml|grams)\b/.test(x.label) ? ` (${num(x.g, 1)} ${f.unit === "ml" ? "ml" : "g"})` : ""}</option>`).join("")}</select></div>
        <div class="kbig"><b>${num(val("kcal"))}</b> kcal</div>
        <div class="mac3">${[["protein", "Protein"], ["carbs", "Carbs"], ["fat", "Fat"]].map(([k, l]) => `<div><i class="dot" style="background:var(--s-${k})"></i><b>${num(val(k), 1)} g</b><span>${l}</span></div>`).join("")}</div>
        <table class="nt"><tbody>${NUTS.slice(4).map(([k, l, u]) => `<tr><td>${l}</td><td class="num">${val(k) == null ? "–" : num(val(k), u === "mg" ? 0 : 1) + " " + u}</td></tr>`).join("")}</tbody></table>
        ${sh.others?.length ? `<details><summary class="small">Other matches for this barcode (${sh.others.length})</summary>${sh.others.map((o, i) => `<div class="res" data-act="pick-other" data-v="${i}"><div class="en"><div class="nm">${esc(o.name)}</div><div class="muted small">${esc(o.brand || "")} · ${esc(o.source)}</div></div></div>`).join("")}</details>` : ""}
        <div class="btnrow wide">${sh.entry ? `<button class="btn danger" data-act="del-entry"><ha-icon icon="mdi:delete"></ha-icon>Delete</button>` : `<button class="btn ghost" data-act="back">Back</button>`}<button class="btn big" data-act="${sh.entry ? "save-entry" : "add-entry"}">${sh.entry ? "Save" : "Add to " + MEAL_LABEL[sh.meal]}</button></div>`;
    } else if (sh.mode === "edit-quick") {
      const e = sh.entry;
      title = "Edit entry";
      body = `${mealChips(sh.meal)}<div class="nm big3">${esc(e.name || "Quick add")}</div><div class="form3"><label>Calories<input id="qk_kcal" type="number" inputmode="decimal" value="${e.kcal ?? ""}"></label><label>Protein (g)<input id="qk_protein" type="number" inputmode="decimal" value="${e.protein ?? ""}"></label><label>Carbs (g)<input id="qk_carbs" type="number" inputmode="decimal" value="${e.carbs ?? ""}"></label><label>Fat (g)<input id="qk_fat" type="number" inputmode="decimal" value="${e.fat ?? ""}"></label></div>
        <div class="btnrow wide"><button class="btn danger" data-act="del-entry"><ha-icon icon="mdi:delete"></ha-icon>Delete</button><button class="btn big" data-act="save-quick-edit">Save</button></div>`;
    } else if (sh.mode === "quick") {
      title = "Quick add";
      body = `${mealChips(sh.meal)}<div class="form3"><label class="span2">Name <span class="muted">(optional)</span><input id="qk_name" placeholder="e.g. Restaurant lunch"></label><label>Calories<input id="qk_kcal" type="number" inputmode="decimal"></label>
        <label>Protein (g)<input id="qk_protein" type="number" inputmode="decimal"></label><label>Carbs (g)<input id="qk_carbs" type="number" inputmode="decimal"></label><label>Fat (g)<input id="qk_fat" type="number" inputmode="decimal"></label></div>
        <div class="btnrow wide"><button class="btn ghost" data-act="back">Back</button><button class="btn big" data-act="save-quick">Add to ${MEAL_LABEL[sh.meal]}</button></div>`;
    } else if (sh.mode === "custom") {
      title = "New food";
      const f = sh.food || {};
      body = `${sh.msg ? `<div class="msg">${esc(sh.msg)}</div>` : ""}<p class="small muted">Enter it from the Nutrition Facts label. It's saved, so next time it comes up in search and scans.</p>
        <div class="form3"><label class="span2">Name<input id="cf_name" value="${esc(f.name || "")}"></label><label>Brand<input id="cf_brand" value="${esc(f.brand || "")}"></label>
        <label>Barcode<input id="cf_code" inputmode="numeric" value="${esc(sh.code || f.code || "")}"></label><label class="span2">Serving size<input id="cf_serv" placeholder="e.g. 1 bar (40 g)" value="${esc(f.serving_label || "")}"></label></div>
        <div class="small muted">Per serving:</div><div class="form3">${NUTS.map(([k, l, u]) => `<label>${l} (${u})<input id="cf_${k}" type="number" inputmode="decimal" value="${f.per100?.[k] ?? ""}"></label>`).join("")}</div>
        <div class="btnrow wide"><button class="btn ghost" data-act="back">Back</button><button class="btn big" data-act="save-custom">Save food</button></div>`;
    } else if (sh.mode === "water") {
      title = "Add water";
      body = `<div class="form3"><label>Ounces<input id="wa_oz" type="number" inputmode="decimal" value="12"></label></div><div class="btnrow wide"><button class="btn big" data-act="save-water">Add</button></div>`;
    } else if (sh.mode === "weight") {
      title = "Log weight";
      body = `<div class="form3"><label>Weight (lb)<input id="w_val2" type="number" step="0.1" inputmode="decimal" value="${this._day?.summary?.weight ?? ""}"></label><label>Body fat % <span class="muted">(optional)</span><input id="w_bf2" type="number" step="0.1" inputmode="decimal"></label></div><div class="btnrow wide"><button class="btn big" data-act="save-weight2">Save</button></div>`;
    }
    el.innerHTML = `<div class="backdrop" data-act="close"></div><div class="panel" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="ph"><b>${esc(title)}</b><button class="icon-btn" data-act="close" aria-label="Close"><ha-icon icon="mdi:close"></ha-icon></button></div><div class="pb">${body}</div></div>`;
    if (sh.mode === "camera") this._startCamera();
    const q = el.querySelector("#q"); if (q && sh.focus) { q.focus(); sh.focus = false; }
  }

  _resultsHtml() {
    const sh = this._sheet;
    if (sh.loading) return `<div class="muted center pad">Searching…</div>`;
    const list = sh.results ?? sh.recent ?? [];
    const head = sh.results ? "" : list.length ? `<div class="small muted pad">Favorites & recent</div>` : `<div class="muted center pad">Search the food database, or scan a barcode.</div>`;
    if (sh.results && !list.length) return `<div class="muted center pad">No matches. Try fewer words, or <button class="link" data-act="custom">create the food</button>.</div>`;
    return head + list.map((f, i) => {
      const p = portionsOf(f)[0], k = f.per100?.kcal != null ? (f.per100.kcal * p.g) / 100 : null;
      return `<div class="res" data-act="pick" data-v="${i}" tabindex="0">${f.image ? `<img src="${esc(f.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="ph-img"><ha-icon icon="${f.generic ? "mdi:food-apple" : f.custom ? "mdi:account" : "mdi:barcode"}"></ha-icon></div>`}
        <div class="en"><div class="nm">${f.favorite ? "★ " : ""}${esc(f.name)}</div><div class="muted small">${esc(f.brand ? f.brand + " · " : "")}${esc(p.label)}</div></div><div class="kc">${num(k)}<small>kcal</small></div></div>`;
    }).join("");
  }

  _updateResults() { const r = this.shadowRoot.getElementById("results"); if (r) r.innerHTML = this._resultsHtml(); }

  async _openAdd(meal) {
    this._openSheet({ mode: "add", meal, q: "", focus: false });
    try { const r = await this.ws("food/recent", { limit: 40 }); if (this._sheet?.mode === "add") { this._sheet.recent = r.products; this._updateResults(); } } catch (e) { /* ignore */ }
  }

  _openFood(food, others) {
    const sh = this._sheet;
    const ps = portionsOf(food);
    let pi = 0, amount = 1;
    if (food.last_portion) { const j = ps.findIndex((p) => p.label === food.last_portion); if (j >= 0) { pi = j; amount = food.last_amount || 1; } }
    this._openSheet({ mode: "detail", meal: sh?.meal || "snacks", food, pi, amount, others, back: sh });
  }

  async _search(q) {
    const sh = this._sheet; if (!sh) return;
    q = q.trim(); sh.q = q;
    if (!q) { sh.results = null; this._updateResults(); return; }
    if (/^\d{8,14}$/.test(q)) return this._lookup(q);
    sh.loading = true; this._updateResults();
    const my = (this._seq = (this._seq || 0) + 1);
    try {
      const r = await this.ws("food/search", { q });
      if (my !== this._seq || this._sheet !== sh) return;
      sh.results = r.products; sh.msg = r.food_db_ok ? "" : "Food database is offline, showing only your foods.";
    } catch (e) { sh.results = []; sh.msg = e.message; }
    sh.loading = false;
    if (sh.mode === "add") { const m = this.shadowRoot.querySelector(".msg"); if (!m && sh.msg) this._renderSheet(); else this._updateResults(); }
  }

  async _lookup(code) {
    this._stopCamera();
    const base = this._sheet?.mode === "detail" ? this._sheet.back : this._sheet;
    const meal = base?.meal || this._sheet?.meal || "snacks";
    this._sheet = { mode: "add", meal, q: code, loading: true, results: null, msg: `Looking up ${code}…` };
    this._renderSheet();
    try {
      const r = await this.ws("food/barcode", { code });
      if (r.products.length) { this._sheet.loading = false; this._sheet.msg = ""; return this._openFood(r.products[0], r.products.slice(1)); }
      this._openSheet({ mode: "custom", meal, code: r.code, msg: `Barcode ${r.code} isn't in the food databases yet. Add it once from the label and it'll scan next time.` });
    } catch (e) { this._sheet.loading = false; this._sheet.msg = e.message; this._renderSheet(); }
  }

  // ------------------------------------------------------------------ barcode scanning
  _scan() {
    const ext = this._hass.auth?.external;
    if (ext && ext.config?.hasBarCodeScanner && typeof ext.fireMessage === "function") return this._scanNative(ext);
    this._sheet.mode = "camera"; this._renderSheet();
  }

  _scanNative(ext) {
    const orig = ext._commandHandler;
    const restore = () => { ext._commandHandler = orig; };
    ext._commandHandler = (msg) => {
      if (msg.command === "bar_code/scan_result") {
        restore();
        try { ext.fireMessage({ type: "bar_code/close" }); } catch (e) { /* ignore */ }
        let code = String(msg.payload.rawValue || "").replace(/\D/g, "");
        if (msg.payload.format === "upc_e" || (code.length === 8 && msg.payload.format !== "ean_8")) code = upcEtoA(code);
        if (code) this._lookup(code);
        return true;
      }
      if (msg.command === "bar_code/aborted") {
        restore();
        if (msg.payload?.reason === "alternative_options") { this._sheet.mode = "camera"; this._renderSheet(); }
        return true;
      }
      return orig ? orig(msg) : false;
    };
    ext.fireMessage({ type: "bar_code/scan", payload: { title: "Scan food barcode", description: "Point at the barcode on the package", alternative_option_label: "Type the number instead" } });
  }

  async _startCamera() {
    if (this._stream) return;
    const sh = this._sheet, vid = this.shadowRoot.getElementById("vid");
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false });
      vid.srcObject = this._stream; await vid.play();
      let detect;
      if ("BarcodeDetector" in window) {
        const bd = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
        detect = async () => { const r = await bd.detect(vid); return r[0] && { text: r[0].rawValue, format: r[0].format }; };
      } else {
        if (!window.ZXing) await new Promise((ok, bad) => { const s = document.createElement("script"); s.src = "/local/weight-tracker/zxing.min.js"; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
        const Z = window.ZXing, hints = new Map();
        hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E]);
        hints.set(Z.DecodeHintType.TRY_HARDER, true);
        const reader = new Z.MultiFormatReader(); reader.setHints(hints);
        const cv = document.createElement("canvas"), ctx = cv.getContext("2d", { willReadFrequently: true });
        detect = async () => {
          if (!vid.videoWidth) return null;
          cv.width = vid.videoWidth; cv.height = vid.videoHeight; ctx.drawImage(vid, 0, 0);
          try {
            const lum = new Z.HTMLCanvasElementLuminanceSource(cv), bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(lum));
            const r = reader.decode(bmp); return r && { text: r.getText(), format: r.getBarcodeFormat() === Z.BarcodeFormat.UPC_E ? "upc_e" : "" };
          } catch (e) { return null; }
        };
      }
      const loop = async () => {
        if (!this._stream || this._sheet !== sh) return;
        const r = await detect().catch(() => null);
        if (r && r.text) {
          let code = r.text.replace(/\D/g, ""); if (r.format === "upc_e") code = upcEtoA(code);
          navigator.vibrate?.(60); return this._lookup(code);
        }
        this._camT = setTimeout(loop, 250);
      };
      loop();
    } catch (e) {
      sh.camMsg = "Camera isn't available here (it needs the Home Assistant app or a secure https page). Type the barcode number below.";
      const m = this.shadowRoot.querySelector(".cam + .muted"); if (m) m.textContent = sh.camMsg;
      this._stopCamera();
    }
  }

  _stopCamera() { clearTimeout(this._camT); if (this._stream) { this._stream.getTracks().forEach((t) => t.stop()); this._stream = null; } }

  // ------------------------------------------------------------------ events
  _onInput(e) {
    if (e.target.id === "q") { clearTimeout(this._qT); const v = e.target.value; this._qT = setTimeout(() => this._search(v), 350); }
    if (e.target.id === "amount" && this._sheet?.mode === "detail") { this._sheet.amount = parseFloat(e.target.value) || 0; this._refreshDetail(); }
  }
  _onChange(e) {
    if (e.target.id === "portion" && this._sheet?.mode === "detail") {
      const sh = this._sheet, ps = portionsOf(sh.food), old = ps[sh.pi], nw = ps[+e.target.value];
      if (nw.g === 1 && old.g !== 1) sh.amount = Math.round(sh.amount * old.g); else if (old.g === 1 && nw.g !== 1) sh.amount = 1;
      sh.pi = +e.target.value; this._renderSheet();
    }
  }
  _refreshDetail() {
    const sh = this._sheet, root = this.shadowRoot, ps = portionsOf(sh.food), g = (sh.amount || 0) * ps[sh.pi].g;
    const val = (k) => (sh.food.per100?.[k] == null ? null : (sh.food.per100[k] * g) / 100);
    root.querySelector(".kbig b").textContent = num(val("kcal"));
    root.querySelectorAll(".mac3 b").forEach((b, i) => (b.textContent = num(val(["protein", "carbs", "fat"][i]), 1) + " g"));
    root.querySelectorAll(".panel .nt td.num").forEach((td, i) => { const [k, , u] = NUTS[4 + i]; td.textContent = val(k) == null ? "–" : num(val(k), u === "mg" ? 0 : 1) + " " + u; });
  }

  _onClick(e) {
    const t = e.target.closest("[data-act]"); if (!t) return;
    this._act(t.dataset.act, t).catch?.((err) => this._toast(err.message || String(err)));
  }

  _toast(msg) {
    let el = this.shadowRoot.querySelector(".toast");
    if (!el) { el = document.createElement("div"); el.className = "toast"; this.shadowRoot.appendChild(el); }
    el.textContent = msg; el.classList.add("show"); clearTimeout(this._toastT); this._toastT = setTimeout(() => el.classList.remove("show"), 2600);
  }

  async _act(act, t) {
    const v = t.dataset?.v, $ = (id) => this.shadowRoot.getElementById(id), sh = this._sheet;
    const date = this._date;
    switch (act) {
      case "tab": this._tab = v; this._render(); return this._load();
      case "reload": return this._load();
      case "day": this._date = addDays(this._date, +v); return this._load();
      case "today": this._date = this._day.today; return this._load();
      case "range": this._range = +v; await this._loadRange(); return this._render();
      case "dismiss": return this.ws("alerts/dismiss", { kind: v });
      case "water": await this.ws("water/add", { oz: +v, date }); return this._toast(`Added ${v} oz`);
      case "undo-water": return this.ws("delete", { table: "water", row_id: +v });
      case "note": { const x = $("note").value.trim(); if (!x) return; await this.ws("note/add", { text: x, date }); return this._toast("Note saved"); }
      case "del": if (!confirm("Delete this?")) return; return this.ws("delete", { table: t.dataset.t, row_id: +v });
      case "copy": { const r = await this.ws("entry/copy_meal", { from_date: addDays(date, -1), meal: v, to_date: date }); return this._toast(r.copied ? `Copied ${r.copied} item${r.copied > 1 ? "s" : ""}` : `Nothing logged for ${MEAL_LABEL[v].toLowerCase()} the day before`); }
      case "add": return this._openAdd(v);
      case "sheet": return this._openSheet({ mode: v, meal: "snacks" });
      case "close": return this._closeSheet();
      case "sheet-meal": sh.meal = v; return this._renderSheet();
      case "search": return this._search($("q").value);
      case "scan": return this._scan();
      case "manual-code": { const c = $("manual_code").value.replace(/\D/g, ""); if (c.length >= 6) return this._lookup(c); return; }
      case "quick": return this._openSheet({ mode: "quick", meal: sh.meal, back: sh });
      case "custom": return this._openSheet({ mode: "custom", meal: sh.meal, code: /^\d+$/.test(sh.q || "") ? sh.q : "", back: sh });
      case "back": this._stopCamera(); if (sh.back) { this._sheet = sh.back; this._sheet.meal = sh.meal; return this._renderSheet(); } return this._openAdd(sh.meal);
      case "pick": { const list = sh.results ?? sh.recent ?? []; return this._openFood(list[+v]); }
      case "pick-other": { const o = sh.others[+v], rest = [sh.food, ...sh.others.filter((_, i) => i !== +v)]; return this._openFood(o, rest); }
      case "amt": { const ps = portionsOf(sh.food), step = ps[sh.pi].g === 1 ? 10 : sh.amount < 1 || (sh.amount === 1 && +v < 0) ? 0.25 : 0.5; sh.amount = Math.max(0, Math.round((sh.amount + step * +v) * 100) / 100); $("amount").value = sh.amount; return this._refreshDetail(); }
      case "fav": sh.food.favorite = !sh.food.favorite; await this.ws("food/favorite", { food: sh.food, favorite: sh.food.favorite }); return this._renderSheet();
      case "add-entry": {
        const p = portionsOf(sh.food)[sh.pi]; if (!(sh.amount > 0)) return this._toast("Enter an amount");
        const food = { ...sh.food }; delete food.last_amount; delete food.last_portion; delete food.use_count;
        await this.ws("entry/add", { date, meal: sh.meal, food, amount: sh.amount, portion_label: p.label, portion_g: p.g });
        this._toast(`Added to ${MEAL_LABEL[sh.meal]}`); return this._closeSheet();
      }
      case "edit": {
        const e = this._day.entries.find((x) => x.id === +v); if (!e) return;
        if (!e.per100) return this._openSheet({ mode: "edit-quick", meal: e.meal, entry: e });
        const food = { id: e.food_id, name: e.name, brand: e.brand, per100: e.per100, portions: e.portion_g ? [{ label: e.portion_label, g: e.portion_g }] : [], unit: "g", custom: true };
        return this._openSheet({ mode: "detail", meal: e.meal, food, pi: 0, amount: e.amount, entry: e });
      }
      case "save-entry": { const p = portionsOf(sh.food)[sh.pi]; await this.ws("entry/update", { entry_id: sh.entry.id, amount: sh.amount, portion_label: p.label, portion_g: p.g, meal: sh.meal }); this._toast("Saved"); return this._closeSheet(); }
      case "save-quick-edit": { const d = {}; for (const k of ["kcal", "protein", "carbs", "fat"]) { const x = $("qk_" + k).value; d[k] = x === "" ? null : +x; } await this.ws("entry/update", { entry_id: sh.entry.id, meal: sh.meal, amount: 1, direct: d }); this._toast("Saved"); return this._closeSheet(); }
      case "del-entry": if (!confirm(`Remove ${sh.entry.name || "this entry"}?`)) return; await this.ws("entry/delete", { entry_id: sh.entry.id }); return this._closeSheet();
      case "save-quick": {
        const k = parseFloat($("qk_kcal").value); if (!(k >= 0)) return this._toast("Enter calories");
        const d = { name: $("qk_name").value.trim() || "Quick add", kcal: k }; for (const x of ["protein", "carbs", "fat"]) { const y = $("qk_" + x).value; if (y !== "") d[x] = +y; }
        await this.ws("entry/add", { date, meal: sh.meal, direct: d, amount: 1 }); this._toast(`Added to ${MEAL_LABEL[sh.meal]}`); return this._closeSheet();
      }
      case "save-custom": {
        const name = $("cf_name").value.trim(); if (!name) return this._toast("Enter a name");
        const per = {}; for (const [k] of NUTS) { const y = $("cf_" + k).value; per[k] = y === "" ? null : +y; }
        if (per.kcal == null) return this._toast("Enter calories");
        const serv = $("cf_serv").value.trim() || "1 serving", code = $("cf_code").value.replace(/\D/g, "");
        const food = { ...(sh.food?.custom ? sh.food : {}), name, brand: $("cf_brand").value.trim(), code: code ? (code.length === 12 ? "0" + code : code) : null, serving_label: serv, serving_g: 100, unit: "g", portions: [{ label: serv, g: 100 }], per100: per, custom: true };
        const r = await this.ws("food/save", { food });
        this._sheet = { mode: "add", meal: sh.meal }; return this._openFood(r.food);
      }
      case "save-water": { const oz = parseFloat($("wa_oz").value); if (oz > 0) { await this.ws("water/add", { oz, date }); this._toast(`Added ${oz} oz`); } return this._closeSheet(); }
      case "save-weight2": { const w = parseFloat($("w_val2").value); if (!(w > 50)) return this._toast("Enter your weight"); const bf = $("w_bf2").value; await this.ws("weight/add", { weight: w, body_fat: bf ? +bf : null, date }); this._toast("Weight saved"); return this._closeSheet(); }
      case "log-weight": { const w = parseFloat($("w_val").value); if (!(w > 50)) return this._toast("Enter your weight"); const bf = $("w_bf").value; await this.ws("weight/add", { weight: w, body_fat: bf ? +bf : null, date: $("w_date").value }); return this._toast("Weight saved"); }
      case "log-bp": { const s = parseInt($("bp_s").value), d = parseInt($("bp_d").value); if (!(s > 50 && d > 30)) return this._toast("Enter both numbers"); const p = $("bp_p").value; await this.ws("bp/add", { systolic: s, diastolic: d, pulse: p ? +p : null, note: $("bp_n").value || null, date: $("bp_date").value }); return this._toast("Blood pressure saved"); }
      case "copy-hook": { const i = $("hook"); i.select(); try { await navigator.clipboard.writeText(i.value); } catch (e) { document.execCommand?.("copy"); } return this._toast("Copied"); }
      case "target": this._settings.settings.notify_target = v; this.shadowRoot.querySelectorAll(".seg button").forEach((b) => { b.classList.toggle("on", b.dataset.v === v); b.setAttribute("aria-checked", b.dataset.v === v); }); return;
      case "calc": {
        const w = parseFloat($("s_start").value) || this._day?.summary?.weight, h = parseFloat($("s_height").value), age = parseFloat($("c_age").value);
        if (!w || !h || !age) { $("calc_out").textContent = "Needs your weight, height and age."; return; }
        const bmr = 10 * (w / 2.20462) + 6.25 * (h * 2.54) - 5 * age + ($("c_sex").value === "m" ? 5 : -161);
        const tdee = bmr * +$("c_act").value, kcal = Math.round((tdee - +$("c_rate").value * 500) / 10) * 10;
        const floor = $("c_sex").value === "m" ? 1500 : 1200;
        $("calc_out").innerHTML = `Maintenance ≈ ${num(tdee)} kcal. Suggested goal: <b>${num(Math.max(kcal, floor))}</b> kcal/day. <button class="link" data-act="use-calc" data-v="${Math.max(kcal, floor)}">Use it</button>`;
        return;
      }
      case "use-calc": $("s_kcal").value = v; return;
      case "save-settings": { const s = this._readSettings(); const r = await this.ws("settings/set", { settings: s }); this._settings.settings = r.settings; $("saved").textContent = "Saved"; this._day = null; return this._toast("Settings saved"); }
      case "test-notify": { await this.ws("settings/set", { settings: this._readSettings() }); await this.ws("notify/test"); return this._toast("Test sent"); }
    }
  }

  // ------------------------------------------------------------------ styles
  _css() {
    return `
:host{display:block;--surface:var(--card-background-color,#fff);--ink:var(--primary-text-color);--ink2:var(--secondary-text-color);--line:var(--divider-color,rgba(127,127,127,.25));--acc:var(--primary-color,#2a78d6);
 --s-kcal:#2a78d6;--s-weight:#2a78d6;--s-water:#2a78d6;--s-protein:#2a78d6;--s-carbs:#eb6834;--s-fat:#1baf7a;--s-sys:#2a78d6;--s-dia:#eb6834;--crit:#d03b3b;--good:#0ca30c;font-size:15px;color:var(--ink)}

:host([dark]){--s-kcal:#3987e5;--s-weight:#3987e5;--s-water:#3987e5;--s-protein:#3987e5;--s-carbs:#d95926;--s-fat:#199e70;--s-sys:#3987e5;--s-dia:#d95926}
*{box-sizing:border-box}
.wrap{max-width:760px;margin:0 auto;padding:8px 12px 80px}
.tabs{display:flex;gap:4px;position:sticky;top:0;z-index:3;background:var(--primary-background-color,var(--surface));padding:6px 0 8px}
.tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px 4px;border:0;border-radius:12px;background:transparent;color:var(--ink2);font:inherit;font-size:12px;cursor:pointer}
.tab.on{background:var(--surface);color:var(--acc);box-shadow:0 1px 3px rgba(0,0,0,.12)}
.card{background:var(--surface);border-radius:16px;padding:14px 16px;margin:10px 0;box-shadow:var(--ha-card-box-shadow,0 1px 3px rgba(0,0,0,.1));border:1px solid var(--line)}
.ch{display:flex;align-items:center;gap:8px;margin-bottom:8px}.ch ha-icon{color:var(--acc);--mdc-icon-size:20px}.r{margin-left:auto}
.muted{color:var(--ink2)}.small{font-size:13px}.center{text-align:center}.pad{padding:12px 4px}
.loading{padding:40px;text-align:center;color:var(--ink2)}
.datenav{display:flex;align-items:center;justify-content:space-between;margin-top:4px}.dtitle{font-size:18px;font-weight:600;text-align:center}.dtitle .link{display:block;margin:2px auto 0;font-size:12px}
.icon-btn{background:none;border:0;color:var(--ink2);padding:6px;border-radius:50%;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;min-width:36px;min-height:36px}.icon-btn:disabled{opacity:.3}.icon-btn:hover{background:var(--line)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;background:var(--acc);color:var(--text-primary-color,#fff);border:0;border-radius:10px;padding:10px 14px;font:inherit;font-weight:600;cursor:pointer;min-height:40px}
.btn.sm{padding:6px 10px;min-height:32px;font-size:13px}.btn.sm ha-icon{--mdc-icon-size:16px}.btn.ghost{background:transparent;color:var(--acc);border:1px solid var(--line)}.btn.danger{background:transparent;color:var(--crit);border:1px solid var(--line)}.btn.big{flex:1;min-height:46px}
.link{background:none;border:0;color:var(--acc);font:inherit;cursor:pointer;padding:0;text-decoration:underline}
.chip{border:1px solid var(--line);background:transparent;color:var(--ink);border-radius:999px;padding:7px 12px;font:inherit;font-size:13px;cursor:pointer}.chip.on{background:var(--acc);color:var(--text-primary-color,#fff);border-color:var(--acc)}.chip.ghost{color:var(--ink2)}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 10px}.chips.center{justify-content:center}
.btnrow{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.btnrow.wide{margin:12px 0}.btnrow.wide .btn{flex:1}
.hero{display:flex;gap:18px;align-items:center;flex-wrap:wrap}
.ring{position:relative;width:132px;height:132px;flex:none}.ring svg{width:100%;height:100%}.track{fill:none;stroke:var(--line);stroke-width:10}.prog{fill:none;stroke:var(--s-kcal);stroke-width:10;stroke-linecap:round;transition:stroke-dashoffset .5s}.prog.over{stroke:var(--crit)}
.ringtxt{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}.big{font-size:28px;font-weight:700;line-height:1}.sub{font-size:12px;color:var(--ink2)}
.herostats{flex:1;min-width:220px}.eq{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;text-align:center}.eq b{display:block;font-size:17px}.eq span{font-size:11px;color:var(--ink2)}.op{color:var(--ink2)}
.crit{color:var(--crit)}
.macro{margin:6px 0}.mrow{display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px}.mrow span:last-child{color:var(--ink2)}.mrow b{color:var(--ink)}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle}
.bar{height:8px;border-radius:4px;background:var(--line);overflow:hidden;margin:6px 0}.bar>div{height:100%;border-radius:4px;transition:width .4s}.bar.water>div{background:var(--s-water)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.grid2 .card{margin:0}@media(max-width:560px){.grid2{grid-template-columns:1fr}}
.grid2+.card{margin-top:10px}
.wline{margin:2px 0}.big2{font-size:24px;font-weight:700}.chg{font-size:12px;color:var(--ink2);margin-left:6px}
.entries{list-style:none;margin:0;padding:0}.entries li{display:flex;align-items:center;gap:10px;padding:9px 2px;border-top:1px solid var(--line);cursor:pointer}.entries li:hover{background:var(--line)}
.en{flex:1;min-width:0}.nm{font-weight:500;overflow:hidden;text-overflow:ellipsis}.kc{font-weight:600;text-align:right;white-space:nowrap}.kc small{display:block;font-size:10px;color:var(--ink2);font-weight:400}
.empty{border-top:1px dashed var(--line);padding:8px 2px 0;font-size:13px}.empty .link{color:var(--ink2)}
table.nt{width:100%;border-collapse:collapse;font-size:14px}.nt td,.nt th{padding:6px 4px;border-top:1px solid var(--line)}.nt th{font-size:12px;color:var(--ink2);font-weight:500;border-top:0}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.nt.hist{margin-top:12px}
.note{display:flex;align-items:flex-start;justify-content:space-between;gap:6px;padding:6px 0;border-top:1px solid var(--line)}
.row{display:flex;gap:8px;margin-top:8px;align-items:center}.row input{flex:1}
input,select,textarea{font:inherit;font-size:16px;color:var(--ink);background:var(--secondary-background-color,transparent);border:1px solid var(--line);border-radius:10px;padding:9px 10px;min-height:40px;width:100%}
label{display:block;font-size:13px;color:var(--ink2)}label>input,label>select,label>.row{margin-top:4px}.form3{align-items:end}
.form3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:8px 0}.span2{grid-column:span 2}@media(max-width:520px){.form3{grid-template-columns:1fr 1fr}.span2{grid-column:1/-1}}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:10px 0}@media(max-width:620px){.tiles{grid-template-columns:1fr 1fr}}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:10px 12px}.tile span{font-size:12px;color:var(--ink2)}.tile b{display:block;font-size:22px;margin:2px 0}.tile small{font-size:11px;color:var(--ink2)}
.legend{display:flex;gap:12px;font-size:12px;color:var(--ink2)}
.chart svg{width:100%;height:auto;display:block;touch-action:pan-y}.chart .grid{stroke:var(--line);stroke-width:1}.chart .ax{fill:var(--ink2);font-size:13px}.chart .goal{stroke:var(--ink2);stroke-dasharray:5 4;stroke-width:1.5}.chart .goalt{font-weight:600}.chart .xh{stroke:var(--ink2);stroke-width:1}
.nodata{padding:30px;text-align:center;color:var(--ink2)}
.tip{position:absolute;z-index:20;pointer-events:none;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.2);min-width:150px}
:host{position:relative}
.alert{display:flex;gap:10px;align-items:flex-start;background:var(--surface);border:1px solid var(--acc);border-radius:14px;padding:10px 12px;margin:8px 0;font-size:14px}.alert ha-icon{color:var(--acc)}.alert>div{flex:1}
.seg{display:flex;border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:4px 0 6px}.seg button{flex:1;border:0;background:transparent;color:var(--ink);padding:9px 4px;font:inherit;font-size:13px;cursor:pointer}.seg button.on{background:var(--acc);color:var(--text-primary-color,#fff)}
.rem{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-top:1px solid var(--line)}.rem input[type=time]{width:130px}
.tog{display:flex;flex-direction:row;align-items:center;gap:8px;color:var(--ink);font-size:14px}.tog input{width:20px;height:20px;min-height:0}
.savebar{position:sticky;bottom:8px;display:flex;align-items:center;gap:10px;z-index:2}.savebar .btn{font-size:16px}
details{margin-top:8px}summary{cursor:pointer;color:var(--acc);font-size:14px;padding:4px 0}.steps li{margin:6px 0}
code{font-size:12px;background:var(--line);padding:1px 4px;border-radius:4px}
.err{border-color:var(--crit)}
#sheet .backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:30}
#sheet .panel{position:fixed;z-index:31;left:50%;transform:translateX(-50%);bottom:0;width:min(640px,100%);max-height:92vh;display:flex;flex-direction:column;background:var(--surface);border-radius:18px 18px 0 0;box-shadow:0 -6px 30px rgba(0,0,0,.3);padding-bottom:env(safe-area-inset-bottom)}
@media(min-width:700px){#sheet .panel{bottom:auto;top:50%;transform:translate(-50%,-50%);border-radius:18px}}
.ph{display:flex;align-items:center;justify-content:space-between;padding:12px 14px 6px 18px;font-size:17px}.pb{overflow:auto;padding:0 16px 14px}
.search{display:flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:12px;padding:0 10px;margin:6px 0}.search input{border:0;background:transparent;padding-left:0}.search ha-icon{color:var(--ink2)}
.msg{background:var(--line);border-radius:10px;padding:8px 10px;font-size:13px;margin:6px 0}
.res{display:flex;align-items:center;gap:10px;padding:9px 2px;border-top:1px solid var(--line);cursor:pointer}.res:hover{background:var(--line)}
.res img,.ph-img{width:40px;height:40px;border-radius:8px;object-fit:cover;flex:none;background:var(--line);display:flex;align-items:center;justify-content:center;color:var(--ink2)}
.food-h{display:flex;gap:12px;align-items:flex-start;margin:4px 0 10px}.food-h img{width:64px;height:64px;border-radius:10px;object-fit:cover}.big3{font-size:18px;font-weight:600}
.amt{display:flex;align-items:center;gap:6px}.amt input{width:90px;text-align:center;flex:none}.amt select{flex:1}
.kbig{text-align:center;margin:12px 0 4px}.kbig b{font-size:34px}
.mac3{display:grid;grid-template-columns:repeat(3,1fr);text-align:center;margin-bottom:8px}.mac3 b{display:block}.mac3 span{font-size:12px;color:var(--ink2)}
.cam{position:relative;border-radius:14px;overflow:hidden;background:#000;aspect-ratio:4/3;margin:6px 0}.cam video{width:100%;height:100%;object-fit:cover}.aim{position:absolute;left:10%;right:10%;top:38%;bottom:38%;border:2px solid rgba(255,255,255,.8);border-radius:10px}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(20px);background:var(--ink);color:var(--surface);padding:10px 16px;border-radius:12px;font-size:14px;opacity:0;transition:.25s;z-index:40;pointer-events:none}.toast.show{opacity:1;transform:translateX(-50%)}
`;
  }
}

customElements.define("weight-tracker-card", WeightTrackerCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "weight-tracker-card", name: "Weight Tracker", description: "Food log with barcode scanning, water, weight, blood pressure, notes and trends." });
console.info(`%c WEIGHT-TRACKER-CARD %c ${WT_VERSION} `, "background:#2a78d6;color:#fff", "");
