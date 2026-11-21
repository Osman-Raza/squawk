// Squawk dashboard (vanilla JS, no build step).
const app = document.getElementById("app");
const $toast = document.getElementById("toast");
let CHECKS = [];
let THRESHOLDS = { red: 3.5, yellow: 2.25 };
let GROUPS = [];
let NOT_COVERED = [];
const GAUGE_MAX = 6;

const C = { ink: "#17202B", ink2: "#4A5563", ink3: "#6B7684", rule: "#D8DDE3", green: "#1F8A4C", amber: "#D69E00", red: "#C8322B", magenta: "#B3127A" };
const STATE = {
  red: { text: "Needs attention", color: C.red },
  yellow: { text: "Watch", color: C.amber },
  green: { text: "Normal", color: C.green },
  learning: { text: "Learning", color: C.ink3 },
  unknown: { text: "No data", color: C.ink3 },
};
const URGENCY = { monitor: "Monitor", next_inspection: "At next scheduled inspection", next_flight_check: "Check before next flight", ground_until_checked: "Ground until checked" };
const WO_STATUS = { open: "Open", in_progress: "In progress", done: "Done" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const levelOf = (z) => (z >= THRESHOLDS.red ? "red" : z >= THRESHOLDS.yellow ? "yellow" : "green");
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Plain-English forecast from the engine's trend fit. Never claims more than the fit supports.
function trendText(f) {
  const t = f.trend;
  if (f.mode === "event") return "Worst single recent flight.";
  if (!t) return "Not enough flights yet to read a trend.";
  if (t.to_limit === 0) return "The latest flights are already past the limit.";
  if (t.to_limit) return `If this trend continues, it reaches the limit in about ${plural(t.to_limit, "flight")}.`;
  if (t.to_caution === 0) return t.direction === "worse" ? "The latest flights are in caution and still getting worse, but too uneven to forecast the limit." : "The latest flights are in caution, but not getting worse.";
  if (t.to_caution) return `If this trend continues, it reaches caution in about ${plural(t.to_caution, "flight")}.`;
  if (t.direction === "worse") return "Drifting the wrong way, but too uneven to forecast.";
  return "Steady or improving.";
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `The server returned ${r.status}.`);
  return data;
}
function toast(msg, error = false) {
  $toast.textContent = msg;
  $toast.className = `toast${error ? " error" : ""}`;
  $toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($toast.hidden = true), error ? 6000 : 4000);
}

// Shape markers so state never depends on color alone: diamond = needs attention, triangle = watch, circle = normal.
function shape(level, cx, cy, s = 5) {
  if (level === "red") return `<path d="M${cx} ${cy - s} L${cx + s} ${cy} L${cx} ${cy + s} L${cx - s} ${cy}Z" fill="${C.red}"/>`;
  if (level === "yellow") return `<path d="M${cx} ${cy - s} L${cx + s} ${cy + s * 0.8} L${cx - s} ${cy + s * 0.8}Z" fill="${C.amber}"/>`;
  if (level === "learning" || level === "unknown") return `<circle cx="${cx}" cy="${cy}" r="${s * 0.8}" fill="none" stroke="${C.ink3}" stroke-width="1.5"/>`;
  return `<circle cx="${cx}" cy="${cy}" r="${s * 0.8}" fill="${C.green}"/>`;
}
const stateLabel = (status) =>
  `<span class="state ${status}"><svg width="12" height="12" aria-hidden="true">${shape(status, 6, 6, 5)}</svg>${STATE[status].text}</span>`;

// Engine-instrument style gauge: green range, yellow caution, red limit line, pointer at the deviation.
function gauge(score, { width = 200, big = false } = {}) {
  const h = big ? 46 : 22, band = big ? 10 : 6, padX = 6;
  const W = width - padX * 2;
  const x = (v) => padX + (Math.min(v, GAUGE_MAX) / GAUGE_MAX) * W;
  const by = h - band;
  const s = Math.max(0, score);
  const px = x(s);
  const tri = big ? 7 : 5;
  return `<svg class="gauge" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" role="img" aria-label="Deviation ${s} on a scale where ${THRESHOLDS.yellow} starts caution and ${THRESHOLDS.red} is the limit">
    <rect x="${x(0)}" y="${by}" width="${x(THRESHOLDS.yellow) - x(0) - 1}" height="${band}" fill="${C.green}"/>
    <rect x="${x(THRESHOLDS.yellow)}" y="${by}" width="${x(THRESHOLDS.red) - x(THRESHOLDS.yellow) - 1}" height="${band}" fill="${C.amber}"/>
    <rect x="${x(THRESHOLDS.red)}" y="${by}" width="${x(GAUGE_MAX) - x(THRESHOLDS.red)}" height="${band}" fill="#E9B7B4"/>
    <rect x="${x(THRESHOLDS.red) - 1}" y="${by - (big ? 6 : 4)}" width="${big ? 3 : 2}" height="${band + (big ? 6 : 4)}" fill="${C.red}"/>
    <path d="M${px - tri} ${by - tri * 1.5 - 1} L${px + tri} ${by - tri * 1.5 - 1} L${px} ${by - 1}Z" fill="${C.ink}"/>
    ${big ? `<text x="${Math.min(Math.max(px, 24), width - 24)}" y="12" text-anchor="middle" font-family="B612, sans-serif" font-weight="700" font-size="13" fill="${C.ink}">${s}σ</text>` : ""}
  </svg>`;
}

// ---------- routing ----------
async function route() {
  stopReplay();
  const hash = location.hash || "#/";
  const section = hash.startsWith("#/work-orders") ? "work-orders" : "fleet";
  document.querySelectorAll(".bar nav a").forEach((a) => (a.dataset.nav === section ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  try {
    if (hash.startsWith("#/aircraft/")) await renderAircraft(decodeURIComponent(hash.split("/")[2]), hash.split("/")[3]);
    else if (hash.startsWith("#/work-orders/")) await renderWorkOrderPage(+hash.split("/")[2]);
    else if (section === "work-orders") await renderWorkOrders();
    else await renderFleet();
  } catch (e) {
    app.innerHTML = `<div class="error-panel"><h2>This page didn't load</h2><p class="muted">${esc(e.message)} Check that the Worker is running and the database is seeded, then try again.</p><button class="btn" id="retry">Try again</button></div>`;
    document.getElementById("retry").onclick = route;
  }
}
window.addEventListener("hashchange", () => route().then(() => { window.scrollTo(0, 0); app.focus({ preventScroll: true }); }));

// ---------- fleet ----------
let fleetCache = null;
const fleetUi = { filter: "all", q: "" };

async function loadFleetList(force = false) {
  if (!fleetCache || force) fleetCache = await api("/api/fleet");
  return fleetCache;
}

async function renderFleet() {
  if (!app.querySelector(".board")) app.innerHTML = `<p class="loading">Loading the fleet…</p>`;
  const data = await loadFleetList(true);
  const { counts } = data;
  const total = data.aircraft.length;
  const headline = counts.red
    ? `${counts.red} of ${total} aircraft need attention.`
    : counts.yellow
    ? `${counts.yellow} of ${total} aircraft to watch. The rest look normal.`
    : `All ${total} aircraft look normal.`;
  const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const chips = [["all", "All", total], ["red", STATE.red.text, counts.red], ["yellow", STATE.yellow.text, counts.yellow], ["green", STATE.green.text, counts.green]];

  app.innerHTML = `
    <div class="head-row">
      <div>
        <h1>${headline}</h1>
        <p class="lede">Squawk checks every new flight against each aircraft's own history and the rest of the fleet. ${data.total_flights} flights checked so far. Updated ${time}. <button class="link-btn" id="refresh">Refresh</button></p>
      </div>
    </div>
    <div class="toolbar">
      <div class="chips" role="group" aria-label="Show aircraft by status">
        ${chips.map(([k, label, n]) => `<button type="button" class="chip" data-f="${k}" aria-pressed="${fleetUi.filter === k}" ${n === 0 && k !== "all" ? "disabled" : ""}>${label} <span class="data">${n}</span></button>`).join("")}
      </div>
      <div class="toolbar-right">
        <label class="search"><span class="sr-only">Find an aircraft</span>
          <input id="q" type="search" placeholder="Find a registration, e.g. C-G" value="${esc(fleetUi.q)}" autocomplete="off" />
        </label>
        <button type="button" class="btn primary" id="add-open" aria-expanded="false" aria-controls="add-panel">Add aircraft</button>
      </div>
    </div>
    <section class="add-panel" id="add-panel" hidden aria-labelledby="h-add">
      <h2 id="h-add">Add an aircraft</h2>
      <p class="muted add-note">Enter the registration and model, then upload its engine logs (Garmin G1000 or NGAFID CSV, one file per flight). Squawk needs at least 3 flights before it rates an aircraft.</p>
      <form id="add-form" novalidate>
        <div class="add-grid">
          <label class="field-l"><span>Registration</span><input name="registration" placeholder="C-FABC" autocomplete="off" required /></label>
          <label class="field-l"><span>Model</span><input name="model" value="Cessna 172" required /></label>
          <label class="field-l files"><span>Engine logs (optional now, you can add more later)</span><input name="files" type="file" accept=".csv,text/csv" multiple /></label>
        </div>
        <p class="form-error" id="add-error" role="alert" hidden></p>
        <div class="add-actions"><button type="submit" class="btn primary" id="add-submit">Add aircraft</button><button type="button" class="btn" id="add-cancel">Cancel</button></div>
      </form>
    </section>
    <div class="board">
      <table>
        <thead><tr><th scope="col">Aircraft</th><th scope="col">Condition</th><th scope="col">Main issue</th><th scope="col" class="num">Flights</th><th scope="col">Work order</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <p class="footnote">The demo fleet's registrations are fictional, made up for this demo. ${data.aircraft.some((a) => /synthetic/i.test(a.model)) ? "This fleet is synthetic sample data for testing." : "Flight and maintenance data comes from the NGAFID aviation maintenance dataset (Cessna 172s at one flight school)."}</p>`;

  const draw = () => {
    const q = fleetUi.q.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    const list = data.aircraft.filter((a) => (fleetUi.filter === "all" || a.status === fleetUi.filter) && (!q || a.name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(q)));
    const groups = ["red", "yellow", "green", "learning", "unknown"].map((s) => [s, list.filter((a) => a.status === s)]).filter(([, l]) => l.length);
    document.getElementById("rows").innerHTML = groups.length
      ? groups.map(([s, l]) => `<tr class="group-row"><td colspan="5">${STATE[s].text} (${l.length})</td></tr>${l.map(row).join("")}`).join("")
      : `<tr><td colspan="5" class="empty-row">${total ? `No aircraft match. <button class="link-btn" id="clear">Show all aircraft</button>` : "No aircraft yet. Load the seed file to add the fleet (see README)."}</td></tr>`;
    document.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.f === fleetUi.filter)));
    // Whole row is clickable; the registration link inside stays for keyboard users.
    document.querySelectorAll("#rows tr[data-id]").forEach((tr) => (tr.onclick = (e) => {
      if (e.target.closest("a, button")) return;
      location.hash = `#/aircraft/${encodeURIComponent(tr.dataset.id)}`;
    }));
    const clear = document.getElementById("clear");
    if (clear) clear.onclick = () => { fleetUi.filter = "all"; fleetUi.q = ""; document.getElementById("q").value = ""; draw(); };
  };
  draw();
  document.querySelectorAll(".chip").forEach((c) => (c.onclick = () => { fleetUi.filter = c.dataset.f; draw(); }));
  document.getElementById("q").oninput = (e) => { fleetUi.q = e.target.value; draw(); };
  wireAddAircraft();
  document.getElementById("refresh").onclick = async () => { await route(); toast("Fleet refreshed"); };
}

function row(a) {
  const fc = a.top_finding?.to_limit > 0 ? `<span class="forecast">Limit in about ${plural(a.top_finding.to_limit, "flight")} at this rate</span>` : "";
  const issue = a.top_finding && a.status !== "green"
    ? `<td class="issue">${esc(a.top_finding.label)}${a.flagged > 1 ? `<span class="muted">, and ${a.flagged - 1} more</span>` : ""}${fc}</td>`
    : a.status === "learning"
    ? `<td class="issue none">Needs ${plural(a.needs_flights, "more flight")} before it can be rated</td>`
    : a.early_warning
    ? `<td class="issue"><span class="muted">Nothing unusual yet.</span><span class="forecast">${esc(a.early_warning.label)} reaches caution in about ${plural(a.early_warning.to_caution, "flight")} at this rate</span></td>`
    : `<td class="issue none">Nothing unusual</td>`;
  return `<tr data-id="${esc(a.id)}">
    <td class="ac"><a href="#/aircraft/${encodeURIComponent(a.id)}">${esc(a.name)}</a><span class="sub">${esc(a.model)}</span></td>
    <td class="cond">${gauge(a.score)}${stateLabel(a.status)}</td>
    ${issue}
    <td class="num">${a.flights}</td>
    <td class="wo">${a.open_work_order ? `<span class="wo-link">#${a.open_work_order.id} ${WO_STATUS[a.open_work_order.status].toLowerCase()}</span>` : ""}</td>
  </tr>`;
}

// Upload flight logs one at a time, oldest file name first. Returns the last response.
async function uploadFlights(id, files, onProgress) {
  const list = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  let last = null;
  const failed = [];
  for (let i = 0; i < list.length; i++) {
    onProgress?.(i + 1, list.length, list[i].name);
    const fd = new FormData();
    fd.append("file", list[i]);
    try { last = await api(`/api/aircraft/${encodeURIComponent(id)}/flights`, { method: "POST", body: fd }); }
    catch (e) { failed.push(`${list[i].name}: ${e.message}`); }
  }
  fleetCache = null;
  return { last, failed, total: list.length };
}

function wireAddAircraft() {
  const panel = document.getElementById("add-panel"), openBtn = document.getElementById("add-open");
  const form = document.getElementById("add-form"), errEl = document.getElementById("add-error"), submit = document.getElementById("add-submit");
  const show = (on) => { panel.hidden = !on; openBtn.setAttribute("aria-expanded", String(on)); if (on) form.registration.focus(); };
  openBtn.onclick = () => show(panel.hidden);
  document.getElementById("add-cancel").onclick = () => { form.reset(); errEl.hidden = true; show(false); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    const registration = form.registration.value.trim(), model = form.model.value.trim();
    if (!registration) { errEl.textContent = "Enter a registration, like C-FABC."; errEl.hidden = false; form.registration.focus(); return; }
    submit.disabled = true;
    submit.textContent = "Adding…";
    try {
      const { aircraft } = await api("/api/aircraft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ registration, model }) });
      const files = form.files.files;
      if (files.length) {
        const r = await uploadFlights(aircraft.id, files, (i, n) => (submit.textContent = `Reading log ${i} of ${n}…`));
        toast(r.failed.length ? `${aircraft.name} added. ${r.total - r.failed.length} of ${r.total} logs read. ${r.failed[0]}` : `${aircraft.name} added with ${plural(r.total, "flight")}.`, r.failed.length > 0);
      } else toast(`${aircraft.name} added. Upload its engine logs to start checking it.`);
      fleetCache = null;
      location.hash = `#/aircraft/${encodeURIComponent(aircraft.id)}`;
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
      submit.disabled = false;
      submit.textContent = "Add aircraft";
    }
  };
}

// ---------- aircraft ----------
const view = { reveal: false, key: null, id: null, upto: null, timer: null, d: null, tab: "overview" };
const TABS = [["overview", "Overview"], ["checks", "All checks"], ["how", "How Squawk decided"]];

function stopReplay() {
  if (view.timer) clearInterval(view.timer);
  view.timer = null;
}

// Soonest predicted limit crossing for one reading (fleet history first, then own trend). null if none.
function predictedCross(d, key) {
  const p = d.predictions?.[key], b = d.baseline?.[key], chk = CHECKS.find((c) => c.key === key);
  if (!p || !b || !chk) return null;
  const lastF = [...d.flights].filter((f) => !f.is_future).pop();
  const lastV = lastF?.features?.[key];
  if (lastV === null || lastV === undefined) return null;
  const up = chk.dir === "high" || (chk.dir === "both" && lastV >= b.median);
  const lim = b.median + (up ? 1 : -1) * THRESHOLDS.red * b.scale;
  const past = (v) => (up ? v >= lim : v <= lim);
  if (past(lastV)) return null;
  const k = p.precedent?.path?.findIndex((x) => past(x.median));
  const fromFleet = k !== undefined && k >= 0 ? k + 1 : null;
  const fromOwn = p.trend && p.trend.r2 >= 0.5 && p.trend.to_limit > 0 ? p.trend.to_limit : null;
  const flights = Math.min(fromFleet ?? Infinity, fromOwn ?? Infinity);
  return Number.isFinite(flights) ? { key, label: chk.label, flights, source: fromFleet !== null && fromFleet <= (fromOwn ?? Infinity) ? "fleet" : "own" } : null;
}
function soonestPrediction(d) {
  return Object.keys(d.predictions || {}).map((k) => predictedCross(d, k)).filter(Boolean).sort((a, b) => a.flights - b.flights)[0] || null;
}

function verdict(d) {
  const n = d.flights.filter((f) => !f.is_future).length;
  if (d.status === "learning") return n ? `Squawk is still learning this aircraft: ${plural(n, "flight")} so far, it needs ${d.explain.min_flights} before rating it.` : "No flights yet. Upload this aircraft's engine logs to start checking it.";
  if (!d.findings.length) {
    const sp = soonestPrediction(d);
    return sp
      ? `Normal right now, but ${sp.label.charAt(0).toLowerCase() + sp.label.slice(1)} is predicted to reach the limit in about ${plural(sp.flights, "flight")}, based on ${sp.source === "fleet" ? "what similar planes in the fleet did next" : "this plane's own trend"}.`
      : "Every engine reading on recent flights is inside the fleet's normal range.";
  }
  const f = d.findings[0];
  const chk = CHECKS.find((c) => c.key === f.key);
  const side = chk?.dir === "low" ? "below" : chk?.dir === "high" ? "above" : f.recent_value >= f.fleet_typical ? "above" : "below";
  const rest = d.findings.length - 1;
  return `${f.label} is ${side} the fleet's normal range on ${Math.round(f.persistence * 100)}% of the last ${f.flights_considered} flights${rest ? `, and ${rest} other reading${rest > 1 ? "s are" : " is"} off too` : ""}.`;
}

// First flight where Squawk said Watch / Needs attention, and when the real repair happened.
function milestones(d) {
  const h = d.history || [];
  const firstWatch = h.find((x) => x.status === "yellow" || x.status === "red");
  const firstRed = h.find((x) => x.status === "red");
  const lastFlight = h.length ? h[h.length - 1].seq : null;
  return { firstWatch, firstRed, lastFlight, repair: d.repair ? lastFlight : null };
}

function setTab(tab, focus = false) {
  view.tab = tab;
  document.querySelectorAll('[role="tab"]').forEach((t) => {
    const on = t.dataset.tab === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    if (on && focus) t.focus();
  });
  document.querySelectorAll('[role="tabpanel"]').forEach((p) => (p.hidden = p.dataset.tab !== tab));
  history.replaceState(null, "", `#/aircraft/${encodeURIComponent(view.id)}${tab === "overview" ? "" : `/${tab}`}`);
}

async function renderAircraft(id, tab = "overview") {
  if (view.id !== id) app.innerHTML = `<p class="loading">Loading ${esc(id)}…</p>`;
  const [d, fleet] = await Promise.all([api(`/api/aircraft/${encodeURIComponent(id)}`), loadFleetList()]);
  if (view.id !== id) { view.reveal = false; view.key = null; }
  view.key = view.key || d.findings[0]?.key || soonestPrediction(d)?.key || "egt_spread";
  view.id = id;
  view.upto = null;
  view.d = d;
  view.tab = TABS.some(([k]) => k === tab) ? tab : "overview";
  const current = d.flights.filter((f) => !f.is_future);
  const hasFuture = d.flights.some((f) => f.is_future);
  const order = fleet.aircraft.map((a) => a.id);
  const pos = order.indexOf(id);
  const prev = pos > 0 ? fleet.aircraft[pos - 1] : null;
  const next = pos >= 0 && pos < order.length - 1 ? fleet.aircraft[pos + 1] : null;

  app.innerHTML = `
    <nav class="ac-nav" aria-label="Aircraft">
      <a class="crumb" href="#/">Fleet</a><span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-here">${esc(d.aircraft.name)}</span>
      <div class="switcher">
        ${prev ? `<a class="btn sm" href="#/aircraft/${encodeURIComponent(prev.id)}" title="Previous: ${esc(prev.name)}">‹ ${esc(prev.name)}</a>` : ""}
        <label class="sr-only" for="jump">Go to aircraft</label>
        <select id="jump">${fleet.aircraft.map((a) => `<option value="${esc(a.id)}" ${a.id === id ? "selected" : ""}>${esc(a.name)}: ${STATE[a.status].text}</option>`).join("")}</select>
        ${next ? `<a class="btn sm" href="#/aircraft/${encodeURIComponent(next.id)}" title="Next: ${esc(next.name)}">${esc(next.name)} ›</a>` : ""}
      </div>
    </nav>
    <div class="ac-head">
      <div>
        <h1 class="ac-name">${esc(d.aircraft.name)}</h1>
        <p class="verdict" id="verdict">${esc(verdict(d))}</p>
        <p class="muted" style="margin:6px 0 0;font-size:14px">${esc(d.aircraft.model)}, ${current.length} flights on record</p>
      </div>
      <div class="big-gauge" id="big"></div>
    </div>

    <div class="tabs" role="tablist" aria-label="Aircraft sections">
      ${TABS.map(([k, label]) => `<button type="button" role="tab" id="tab-${k}" data-tab="${k}" aria-controls="panel-${k}" aria-selected="${view.tab === k}" tabindex="${view.tab === k ? 0 : -1}">${label}${k === "checks" ? ` <span class="tab-count data">${d.all_checks.filter((c) => c.recorded).length}</span>` : ""}</button>`).join("")}
    </div>

    <div class="cols">
      <div>
        <section role="tabpanel" id="panel-overview" data-tab="overview" aria-labelledby="tab-overview" ${view.tab === "overview" ? "" : "hidden"}>
          <section class="history" aria-labelledby="h-hist">
            <div class="history-head">
              <h2 id="h-hist">Status after each flight</h2>
              <button class="btn" id="replay" type="button">Replay flights</button>
            </div>
            <div class="timeline" id="timeline"></div>
            <p class="milestones" id="milestones" aria-live="polite"></p>
          </section>

          <h2 class="sec-h">Readings out of range</h2>
          ${d.findings.length ? `<ul class="findings">${d.findings.map(findingItem).join("")}</ul>` : `<p class="no-findings">None. Pick any reading below to see its trend.</p>`}
          ${d.early?.length ? `<h2 class="early-h">Trending toward caution</h2><p class="muted early-note">Still in the normal range, but the last flights form a steady line heading the wrong way.</p><ul class="findings">${d.early.map(findingItem).join("")}</ul>` : ""}

          <section class="trend" aria-labelledby="h-trend">
            <div class="trend-head">
              <h2 id="h-trend">Trend over recent flights</h2>
              <label class="sr-only" for="metric">Reading</label>
              <select id="metric">${(GROUPS.length ? GROUPS : [...new Set(CHECKS.map((c) => c.group))]).map((g) => `<optgroup label="${esc(g)}">${CHECKS.filter((c) => c.group === g).map((c) => `<option value="${c.key}" ${c.key === view.key ? "selected" : ""}>${esc(c.label)}</option>`).join("")}</optgroup>`).join("")}</select>
            </div>
            <div class="chart-wrap" id="chart"></div>
            <p class="chart-caption" id="caption" aria-live="polite"></p>
            ${hasFuture ? `<div class="reveal-row"><label class="toggle"><input type="checkbox" id="reveal" ${view.reveal ? "checked" : ""}/>Show what happened after these flights</label></div><div id="outcome"></div>` : ""}
            <details class="table"><summary>Show the numbers as a table</summary><div id="data-table"></div></details>
          </section>
        </section>

        <section role="tabpanel" id="panel-checks" data-tab="checks" aria-labelledby="tab-checks" ${view.tab === "checks" ? "" : "hidden"}>
          <h2 class="sr-only">All checks</h2>
          ${coverage(d)}
        </section>

        <section role="tabpanel" id="panel-how" data-tab="how" aria-labelledby="tab-how" ${view.tab === "how" ? "" : "hidden"}>
          <h2 class="sr-only">How Squawk decided</h2>
          ${howItDecided(d)}
        </section>
      </div>
      <aside>
        ${detailsBox(d)}
        <div class="sheet" id="wo"></div>
        <div class="upload">
          <h2>Add a flight</h2>
          <label class="drop" id="drop"><b>Choose engine logs</b> or drop them here. Garmin G1000 and NGAFID CSV files work, one file per flight.<input type="file" id="file" accept=".csv,text/csv" multiple class="sr-only" /></label>
        </div>
      </aside>
    </div>`;

  drawAll();
  // tabs: click + arrow keys
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.forEach((t, i) => {
    t.onclick = () => setTab(t.dataset.tab);
    t.onkeydown = (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      setTab(n.dataset.tab, true);
    };
  });
  // clicking a reading anywhere jumps to its trend on the overview tab
  const openTrend = (key) => {
    view.key = key;
    document.getElementById("metric").value = key;
    if (view.tab !== "overview") setTab("overview");
    drawAll();
    document.getElementById("h-trend").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  };
  document.querySelectorAll(".finding").forEach((b) => (b.onclick = () => { view.key = b.dataset.key; document.getElementById("metric").value = view.key; drawAll(); }));
  document.querySelectorAll("[data-open-trend]").forEach((b) => (b.onclick = () => openTrend(b.dataset.openTrend)));
  document.getElementById("metric").onchange = (e) => { view.key = e.target.value; drawAll(); };
  document.getElementById("jump").onchange = (e) => { location.hash = `#/aircraft/${encodeURIComponent(e.target.value)}`; };
  const rv = document.getElementById("reveal");
  if (rv) rv.onchange = (e) => { view.reveal = e.target.checked; drawAll(); };
  document.getElementById("replay").onclick = toggleReplay;

  renderSheet(d);
  wireUpload(id);
}

// Draws everything that depends on "how far into the history we are" (normal view = all flights).
function drawAll() {
  const d = view.d;
  const current = d.flights.filter((f) => !f.is_future);
  const upto = view.upto ?? current.length;
  const replaying = view.upto !== null;
  const h = d.history || [];
  const now = replaying ? h[upto - 1] : { status: d.status, score: d.score };

  // gauge
  document.getElementById("big").innerHTML = `${gauge(now?.score ?? 0, { width: 280, big: true })}${stateLabel(now?.status ?? "unknown")}<div class="cap">${replaying ? `After flight ${upto} of ${current.length}` : "Deviation from fleet normal"}</div>`;
  if (replaying) {
    document.getElementById("verdict").textContent = now.status === "learning"
      ? `Flight ${upto} logged. Squawk is still learning this aircraft's normal (needs ${d.explain.min_flights} flights).`
      : now.top && now.status !== "green"
      ? `Flight ${upto} logged. ${now.top.label} is ${now.top.z}σ from fleet normal.`
      : `Flight ${upto} logged. Everything inside normal range.`;
  } else {
    document.getElementById("verdict").textContent = verdict(d);
  }

  // timeline
  const showRepair = view.reveal && d.repair && !replaying;
  document.getElementById("timeline").innerHTML = h.map((x, i) => {
    const future = replaying && i >= upto;
    return `<span class="tl s-${x.status}${future ? " pending" : ""}${replaying && i === upto - 1 ? " now" : ""}" title="Flight ${x.seq}: ${future ? "not flown yet" : STATE[x.status].text}${x.top && !future ? `, ${esc(x.top.label)} ${x.top.z}σ` : ""}"></span>`;
  }).join("") + (showRepair ? `<span class="tl-repair" title="Real repair">Repair</span>` : "");
  const m = milestones(d);
  const ms = [];
  if (!h.length) ms.push("No flights yet.");
  else if (!m.firstWatch) ms.push(`No warnings across all ${h.length} flights.`);
  else {
    ms.push(`First flagged after flight ${m.firstWatch.seq}${m.firstWatch.top ? ` (${esc(m.firstWatch.top.label)})` : ""}.`);
    if (m.firstRed) ms.push(`Needs attention from flight ${m.firstRed.seq}.`);
    const fw = m.firstWatch.forecast;
    if (fw && fw.to_limit > 0 && m.firstRed && m.firstRed.seq > m.firstWatch.seq) {
      ms.push(`When it was first flagged, Squawk forecast the limit in about ${plural(fw.to_limit, "flight")}; it got there ${plural(m.firstRed.seq - m.firstWatch.seq, "flight")} later.`);
    }
    if (showRepair) ms.push(`<b>The real repair came after flight ${m.repair}, ${plural(m.repair - m.firstWatch.seq, "flight")} after Squawk first flagged it.</b>`);
  }
  document.getElementById("milestones").innerHTML = replaying ? `Replaying flight ${upto} of ${current.length}…` : ms.join(" ");

  // chart
  const chk = CHECKS.find((c) => c.key === view.key) || CHECKS[0];
  const shown = replaying ? current.slice(0, upto) : d.flights.filter((f) => view.reveal || !f.is_future);
  const slots = replaying || !view.reveal ? current.length : d.flights.length;
  // Predictions only in the normal view (not during replay or the after-repair reveal).
  const pred = replaying || view.reveal ? null : d.predictions?.[chk.key] || null;
  const out = chart(d, chk, shown, slots, pred);
  document.getElementById("chart").innerHTML = out.svg;
  document.getElementById("caption").textContent = out.caption;
  document.getElementById("data-table").innerHTML = out.table;
  document.querySelectorAll(".finding").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.key === view.key)));
  const o = document.getElementById("outcome");
  if (o) o.innerHTML = view.reveal && d.repair && !replaying ? `<div class="outcome">After these flights the aircraft went in for an unplanned repair, logged as “${esc(d.repair.label)}”. The magenta points are the flights after it. Source: NGAFID maintenance records.</div>` : "";
}

function toggleReplay() {
  const btn = document.getElementById("replay");
  if (view.timer) {
    stopReplay();
    view.upto = null;
    btn.textContent = "Replay flights";
    drawAll();
    return;
  }
  const d = view.d;
  const n = d.flights.filter((f) => !f.is_future).length;
  const hasFuture = d.flights.some((f) => f.is_future);
  view.reveal = false;
  const rv = document.getElementById("reveal");
  if (rv) rv.checked = false;
  view.upto = 1;
  btn.textContent = "Stop replay";
  drawAll();
  const step = matchMedia("(prefers-reduced-motion: reduce)").matches ? 1100 : 650;
  view.timer = setInterval(() => {
    if (view.upto < n) {
      view.upto++;
      drawAll();
      return;
    }
    stopReplay();
    view.upto = null;
    btn.textContent = "Replay flights";
    if (hasFuture) {
      view.reveal = true;
      if (rv) rv.checked = true;
    }
    drawAll();
  }, step);
}

function howItDecided(d) {
  const e = d.explain;
  const f = d.findings[0];
  const chk = f ? CHECKS.find((c) => c.key === f.key) : null;
  const steps = [
    `<b>Collect.</b> Each flight's engine log is uploaded after landing. This aircraft has ${plural(e.flights, "flight")} on record, about ${e.avg_cruise_samples.toLocaleString()} cruise samples each. ${e.r2 ? "Raw logs are kept in R2 and the results in D1." : "The results are stored in D1."}`,
    `<b>Measure.</b> Every flight is boiled down to up to ${e.checks} health readings across ${e.groups.length} systems: ${e.groups.join(", ").toLowerCase()}. ${e.checks_recorded} of them have data for this aircraft. Engine and oil temperatures are corrected for outside air temperature when the fleet's data shows a clear link.`,
    f
      ? `<b>Compare to its own past.</b> ${esc(f.label)} was ${f.early_value ?? "unknown"} ${esc(f.unit)} on this aircraft's first flights and is ${f.recent_value} ${esc(f.unit)} now.`
      : `<b>Compare to its own past.</b> Recent flights look like this aircraft's earlier flights.`,
    f
      ? `<b>Compare to the fleet.</b> Across ${e.baseline_flights} flights from ${e.fleet_aircraft} aircraft, this reading is normally ${f.fleet_typical} ${esc(f.unit)}. Squawk measures each flight's distance from that in units of the fleet's normal variation (σ). Caution starts at ${THRESHOLDS.yellow}σ and the limit is ${THRESHOLDS.red}σ.`
      : `<b>Compare to the fleet.</b> Across ${e.baseline_flights} flights from ${e.fleet_aircraft} aircraft, every reading on this aircraft is within ${THRESHOLDS.yellow}σ of the fleet's normal.`,
    f
      ? `<b>Decide.</b> Squawk uses the middle value of the last ${e.recent_window} flights, so one odd flight can't trigger an alert. Here that's ${f.z}σ, with ${Math.round(f.persistence * 100)}% of those flights past caution, so the status is ${STATE[d.status].text.toLowerCase()}.`
      : `<b>Decide.</b> Squawk uses the middle value of the last ${e.recent_window} flights, so one odd flight can't trigger an alert. Nothing crosses caution, so the status is normal.`,
    f && f.trend
      ? `<b>Forecast.</b> Squawk fits a straight line through the last ${e.trend_window} flights. ${esc(f.label)}: ${esc(trendText(f))} Forecasts only appear when the line fits well (R² at least 0.5), and they assume the trend continues.`
      : `<b>Forecast.</b> Squawk fits a straight line through each reading's last ${e.trend_window} flights and warns when a steady trend will reach caution within 10 flights.${d.early?.length ? ` On this aircraft: ${esc(d.early[0].label)}, ${esc(trendText(d.early[0]).toLowerCase())}` : " Nothing on this aircraft is trending toward caution."}`,
    `<b>Write it up.</b> The findings and matching known failure patterns${chk ? ` (for this one: ${esc(chk.system)})` : ""} go to Workers AI (Llama 3.3 70B), which writes the work order. If the AI is unavailable, Squawk's built-in rules write it instead. A mechanic signs off.`,
  ];
  return `<ol class="how-steps">${steps.map((s) => `<li>${s}</li>`).join("")}</ol>
    <p class="muted how-note">Every new flight reruns steps 2 to 6 for the whole fleet, so statuses always reflect the latest data.</p>`;
}

function detailsBox(d) {
  const current = d.flights.filter((f) => !f.is_future);
  const minutes = current.reduce((s, f) => s + (f.features.duration_min || 0), 0);
  const src = current[0]?.source;
  const source = src === "ngafid" ? "NGAFID maintenance dataset" : src === "sample" ? "Synthetic sample data" : src === "upload" ? "Uploaded logs" : "Unknown";
  const uploads = current.filter((f) => f.source === "upload").length;
  return `<section class="details" aria-labelledby="h-det"><h2 id="h-det" class="sr-only">Aircraft details</h2><dl>
    <div class="row2"><dt>Registration</dt><dd class="data">${esc(d.aircraft.name)}${d.aircraft.role === "customer" ? "" : ` <span class="muted" style="font-family:var(--text);font-weight:400">(fictional)</span>`}</dd></div>
    <div class="row2"><dt>Model</dt><dd>${esc(d.aircraft.model.replace(/\s*\(.*\)$/, ""))}</dd></div>
    <div class="row2"><dt>Flights on record</dt><dd class="data">${current.length}${uploads ? ` (${uploads} uploaded)` : ""}</dd></div>
    <div class="row2"><dt>Time in these logs</dt><dd class="data">${(minutes / 60).toFixed(1)} h</dd></div>
    <div class="row2"><dt>Checks with data</dt><dd class="data">${d.all_checks.filter((c) => c.recorded).length} of ${d.all_checks.length}</dd></div>
    <div class="row2"><dt>Data source</dt><dd>${source}</dd></div>
  </dl></section>`;
}

function coverage(d) {
  const byGroup = {};
  for (const c of d.all_checks || []) (byGroup[c.group] ??= []).push(c);
  const lvl = { red: "Needs attention", yellow: "Watch", green: "Normal" };
  const groups = (GROUPS.length ? GROUPS : Object.keys(byGroup)).filter((g) => byGroup[g]);
  const rows = groups.map((g) => `
    <tr class="cov-group"><th colspan="3" scope="colgroup">${esc(g)}</th></tr>
    ${byGroup[g].map((c) => `<tr>
      <td>${c.recorded ? `<button type="button" class="link-btn cov-link" data-open-trend="${c.key}">${esc(c.label)}</button>` : esc(c.label)}</td>
      <td>${c.recorded ? `<span class="state ${c.level}"><svg width="12" height="12" aria-hidden="true">${shape(c.level, 6, 6, 5)}</svg>${lvl[c.level]}</span>` : `<span class="muted">Not recorded on this aircraft</span>`}</td>
      <td class="num">${c.recorded ? `${Math.max(0, c.z)}σ` : ""}</td>
    </tr>`).join("")}`).join("");
  const recorded = (d.all_checks || []).filter((c) => c.recorded).length;
  return `<p class="muted cov-note">${recorded} of ${(d.all_checks || []).length} checks have data in this aircraft's logs. Checks with no data are skipped, never guessed.</p>
    <div class="cov-wrap"><table class="cov"><thead><tr><th scope="col">Check</th><th scope="col">Result</th><th scope="col" class="num">From normal</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="cov-out"><b>Not in engine-monitor logs, so Squawk can't check them:</b> ${NOT_COVERED.map(esc).join(", ")}. These still need normal inspections.</p>`;
}

function findingItem(f) {
  const change = f.change === null ? "" : `, ${f.change >= 0 ? "up" : "down"} ${Math.abs(f.change)} since earlier flights`;
  return `<li><button type="button" class="finding" data-key="${f.key}" aria-pressed="false">
    <span class="t">${esc(f.label)}</span>
    ${gauge(f.z, { width: 130 })}
    <span class="d"><span class="data">${f.recent_value} ${esc(f.unit)}</span> ${f.mode === "event" ? "worst recent" : "now"}, fleet normal <span class="data">${f.fleet_typical} ${esc(f.unit)}</span>${f.mode === "event" ? "" : change}${CHECKS.find((c) => c.key === f.key)?.oat ? ", adjusted for outside temperature" : ""}</span>
    <span class="d trend-line">${esc(trendText(f))}</span>
  </button></li>`;
}

// flights = which flights to draw; slots = total x positions for real flights (keeps the axis fixed during replay).
// pred = { trend, precedent } for this reading, or null. Predictions are drawn to the right of a "Now" line.
function chart(d, chk, flights, slots, pred = null) {
  const base = d.baseline[chk.key];
  const badZ = (v) => {
    const z = (v - base.median) / base.scale;
    return chk.dir === "high" ? z : chk.dir === "low" ? -z : Math.abs(z);
  };
  const pts = flights.map((f, i) => ({ i, v: f.features[chk.key], future: f.is_future, f })).filter((p) => p.v !== null && p.v !== undefined);
  if (!pts.length || !base || base.median === null) return { svg: `<p class="muted" style="padding:16px">No data recorded for this reading.</p>`, caption: "", table: "" };
  pts.forEach((p) => { p.z = badZ(p.v); p.level = p.future ? "after" : levelOf(p.z); });
  const solid = pts.filter((p) => !p.future), fut = pts.filter((p) => p.future);
  const last = solid[solid.length - 1];

  // ---- predictions (only when we're looking at the latest flights, not the after-repair reveal) ----
  const showPred = pred && !fut.length && last && last.i === flights.length - 1;
  const prec = showPred && pred.precedent && pred.precedent.path?.length ? pred.precedent : null;
  const tr = showPred && pred.trend && pred.trend.r2 >= 0.5 && pred.trend.n >= 5 && pred.trend.direction !== "flat" ? pred.trend : null;
  const H = Math.max(prec ? prec.path.length : 0, tr ? 6 : 0);
  const trPts = tr ? Array.from({ length: H }, (_, j) => ({ i: last.i + j + 1, v: tr.fit_last + tr.slope * (j + 1) })) : [];
  const precPts = prec ? prec.path.map((p) => ({ i: last.i + p.h, v: p.median, lo: p.lo, hi: p.hi })) : [];

  const W = 760, H2 = 320, L = 52, R = 24, T = 30, B = 40;
  const lo = base.median - THRESHOLDS.yellow * base.scale, hi = base.median + THRESHOLDS.yellow * base.scale;
  const limHi = base.median + THRESHOLDS.red * base.scale, limLo = base.median - THRESHOLDS.red * base.scale;
  const showHi = chk.dir !== "low", showLo = chk.dir !== "high";
  const allVals = d.flights.map((f) => f.features[chk.key]).filter((v) => v !== null && v !== undefined);
  const predVals = [...trPts.map((p) => p.v), ...precPts.flatMap((p) => [p.lo, p.hi])];
  const vals = allVals.concat(predVals, [lo, hi, showHi ? limHi : hi, showLo ? limLo : lo]);
  let ymin = Math.min(...vals), ymax = Math.max(...vals);
  const pad = (ymax - ymin) * 0.1 || 1;
  ymin -= pad; ymax += pad;
  const n = Math.max(slots + H, 2);
  const x = (i) => L + (i / (n - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - ymin) / (ymax - ymin)) * (H2 - T - B);
  const ticks = Array.from({ length: 4 }, (_, k) => ymin + ((ymax - ymin) * (k + 0.5)) / 4);
  const line = (arr) => arr.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const firstFuture = flights.findIndex((f) => f.is_future);
  const repairX = firstFuture > 0 ? (x(firstFuture - 1) + x(firstFuture)) / 2 : null;
  const worst = solid.reduce((m, p) => (p.z > (m?.z ?? -Infinity) ? p : m), null);
  const label = (tx, ty, text, anchor = "start", color = C.ink3, weight = 400, size = 12) => `<text x="${tx}" y="${ty}" text-anchor="${anchor}" fill="${color}" font-size="${size}" font-weight="${weight}" font-family="Public Sans, sans-serif">${text}</text>`;
  const BLUE = "#2F6DB5";

  // when does each prediction cross the limit (in flights from now)?
  const limitV = showHi && (!showLo || (last && last.v >= base.median)) ? limHi : limLo;
  const crosses = (arr) => { const k = arr.findIndex((p) => (limitV >= base.median ? p.v >= limitV : p.v <= limitV)); return k < 0 ? null : k + 1; };
  const precCross = prec && last && !(limitV >= base.median ? last.v >= limitV : last.v <= limitV) ? crosses(precPts) : null;
  const trCross = tr && last && !(limitV >= base.median ? last.v >= limitV : last.v <= limitV) ? crosses(trPts) : null;

  const marker = (p) => {
    const tip = `<title>${esc(p.f.flown_at)}: ${p.v} ${esc(chk.unit)}${p.future ? ", after the repair" : ""}</title>`;
    const cx = x(p.i), cy = y(p.v);
    if (p.level === "after") return `<g>${tip}<circle cx="${cx}" cy="${cy}" r="4" fill="#fff" stroke="${C.magenta}" stroke-width="2"/></g>`;
    if (p.level === "green") return `<g>${tip}<circle cx="${cx}" cy="${cy}" r="3.5" fill="${C.ink2}"/></g>`;
    return `<g>${tip}${shape(p.level, cx, cy, 6)}</g>`;
  };
  const annot = worst && worst.level !== "green" && !H
    ? (() => {
        const ax = x(worst.i), ay = y(worst.v), left = ax > L + 120;
        return `<text x="${left ? ax - 12 : ax + 12}" y="${ay - 6}" text-anchor="${left ? "end" : "start"}" fill="${C.ink}" font-size="13" font-weight="700" font-family="B612, sans-serif">${fmt(worst.v)} ${esc(chk.unit)}</text>`;
      })()
    : "";

  const nowX = H && last ? x(last.i) + (x(last.i + 1) - x(last.i)) / 2 : null;
  const band = prec ? `<path d="M${x(last.i)},${y(last.v)} ${precPts.map((p) => `L${x(p.i).toFixed(1)},${y(p.hi).toFixed(1)}`).join(" ")} ${[...precPts].reverse().map((p) => `L${x(p.i).toFixed(1)},${y(p.lo).toFixed(1)}`).join(" ")} Z" fill="rgba(47,109,181,.14)"/>` : "";

  const svg = `<svg class="chart" viewBox="0 0 ${W} ${H2}" role="img" aria-labelledby="caption">
    ${nowX ? `<rect x="${nowX}" y="${T - 14}" width="${W - R - nowX}" height="${H2 - B - T + 14}" fill="#F4F6F9"/>` : ""}
    ${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="#EEF1F4"/>${label(L - 8, y(t) + 4, fmt(t), "end")}`).join("")}
    <rect x="${L}" width="${W - L - R}" y="${y(hi)}" height="${Math.max(0, y(lo) - y(hi))}" fill="rgba(31,138,76,.10)"/>
    ${showHi ? `<line x1="${L}" x2="${W - R}" y1="${y(limHi)}" y2="${y(limHi)}" stroke="${C.red}" stroke-width="1.5"/>${label(L + 6, y(limHi) - 6, "Limit", "start", C.red, 600)}` : ""}
    ${showLo ? `<line x1="${L}" x2="${W - R}" y1="${y(limLo)}" y2="${y(limLo)}" stroke="${C.red}" stroke-width="1.5"/>${showHi ? "" : label(L + 6, y(limLo) + 15, "Limit", "start", C.red, 600)}` : ""}
    ${nowX ? `<line x1="${nowX}" x2="${nowX}" y1="${T - 14}" y2="${H2 - B}" stroke="${C.ink}" stroke-width="1.5"/>${label(nowX - 6, T - 2, "Now", "end", C.ink, 700)}${label(nowX + 8, T - 2, "Predicted", "start", C.ink2, 700)}` : ""}
    ${repairX ? `<line x1="${repairX}" x2="${repairX}" y1="${T - 8}" y2="${H2 - B}" stroke="${C.magenta}" stroke-width="2"/>${label(repairX + 6, T, "Repair", "start", C.magenta, 700)}` : ""}
    ${band}
    ${prec ? `<path d="M${x(last.i)},${y(last.v)} ${precPts.map((p) => `L${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}" fill="none" stroke="${BLUE}" stroke-width="2.25" stroke-dasharray="7 4"/>
      ${precPts.map((p) => `<circle cx="${x(p.i)}" cy="${y(p.v)}" r="3.5" fill="#fff" stroke="${BLUE}" stroke-width="2"><title>${p.i - last.i} flight(s) ahead: likely ${fmt(p.v)} ${esc(chk.unit)} (range ${fmt(p.lo)} to ${fmt(p.hi)})</title></circle>`).join("")}` : ""}
    ${tr ? `<path d="M${x(last.i)},${y(tr.fit_last)} ${trPts.map((p) => `L${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}" fill="none" stroke="${C.ink3}" stroke-width="2" stroke-dasharray="2 4" stroke-linecap="round"/>` : ""}
    <path d="${line(solid)}" fill="none" stroke="${C.ink2}" stroke-width="1.75"/>
    ${fut.length ? `<path d="${line([solid[solid.length - 1], ...fut].filter(Boolean))}" fill="none" stroke="${C.magenta}" stroke-width="1.75" stroke-dasharray="5 4"/>` : ""}
    ${pts.map(marker).join("")}
    ${annot}
    ${precCross ? (() => { const p = precPts[precCross - 1]; return `<circle cx="${x(p.i)}" cy="${y(p.v)}" r="7" fill="none" stroke="${C.red}" stroke-width="2"/>${label(x(p.i), y(p.v) + (limitV >= base.median ? -14 : 22), `Limit in ~${precCross}`, "middle", C.red, 700)}`; })() : ""}
    ${label(L, H2 - 12, "Oldest flight")}
    ${nowX ? label(nowX - 6, H2 - 12, "Latest flight", "end") + label(W - R, H2 - 12, `+${H} flights`, "end") : label(W - R, H2 - 12, fut.length ? "Latest, after repair" : "Latest flight", "end")}
  </svg>`;

  // ---- legend + plain-English caption ----
  const legend = H ? `<div class="pred-legend">
      <span><svg width="26" height="12" aria-hidden="true"><line x1="0" x2="26" y1="6" y2="6" stroke="${C.ink2}" stroke-width="2"/><circle cx="13" cy="6" r="3.5" fill="${C.ink2}"/></svg>Actual flights</span>
      ${prec ? `<span><svg width="26" height="12" aria-hidden="true"><rect x="0" y="1" width="26" height="10" fill="rgba(47,109,181,.14)"/><line x1="0" x2="26" y1="6" y2="6" stroke="${BLUE}" stroke-width="2" stroke-dasharray="6 3"/></svg>Fleet history: what similar planes did next</span>` : ""}
      ${tr ? `<span><svg width="26" height="12" aria-hidden="true"><line x1="0" x2="26" y1="6" y2="6" stroke="${C.ink3}" stroke-width="2" stroke-dasharray="2 4" stroke-linecap="round"/></svg>This plane's own trend</span>` : ""}
    </div>` : "";

  const recent = solid.slice(-5);
  const out = recent.filter((p) => p.level !== "green").length;
  const oatS = chk.oat && d.oat_model?.slopes?.[chk.key];
  const oatNote = oatS?.used ? ` Adjusted for outside air temperature (about ${oatS.slope} ${chk.unit} per °C, learned from the fleet).` : "";
  let predNote = "";
  if (showPred) {
    const pc = pred.precedent;
    if (prec) {
      const who = [pc.planes ? `${plural(pc.planes, "other plane")} in this fleet` : "", pc.self_matches ? "this plane's own earlier flights" : ""].filter(Boolean).join(" and ");
      const endV = precPts[precPts.length - 1];
      predNote += ` Prediction: Squawk found ${pc.matches} ${pc.matches === 1 ? "stretch" : "stretches"} of flights from ${who} where this reading looked like this plane's last ${4} flights. Based on what happened next, it's likely around ${fmt(endV.v)} ${chk.unit} in ${plural(endV.i - last.i, "flight")} (range ${fmt(endV.lo)} to ${fmt(endV.hi)}).`;
      if (precCross) predNote += ` That reaches the limit in about ${plural(precCross, "flight")}.`;
    } else {
      predNote += ` Fleet history: ${pc && pc.matches ? `only ${pc.matches} similar ${pc.matches === 1 ? "stretch" : "stretches"} found in the fleet, not enough to predict from (needs 3)` : "no other plane in the fleet has had this reading at this level, so there's nothing to compare against"}.`;
    }
    if (tr) predNote += ` This plane's own straight-line trend over its last ${tr.n} flights (fit R² ${tr.r2})${trCross ? ` reaches the limit in about ${plural(trCross, "flight")}` : " is shown dotted"}.`;
    else if (pred.trend) predNote += " Its own recent flights don't form a steady enough line to project.";
    predNote += " Predictions assume nothing changes, like no maintenance in between.";
  }
  const caption = `${chk.label} in ${chk.unit}. Green band: the fleet's normal range. Red line: the limit. ${out ? `${out} of the last ${recent.length} flights were outside the normal range` : `The last ${recent.length} flights were inside the normal range`}${worst && worst.level !== "green" ? `, peaking at ${fmt(worst.v)}` : ""}.${fut.length ? ` After the repair: ${fut.map((p) => fmt(p.v)).join(", ")}.` : ""}${oatNote}${predNote}`;

  const lvl = { red: "Past the limit", yellow: "Caution", green: "Normal", after: "After repair" };
  const table = `<table><thead><tr><th>Flight</th><th class="num">${esc(chk.unit)}</th><th>Reading</th></tr></thead><tbody>
    ${pts.map((p) => `<tr><td>${esc(p.f.flown_at)}</td><td class="num">${p.v}</td><td>${lvl[p.level]}</td></tr>`).join("")}
    ${precPts.map((p) => `<tr><td>Predicted, ${plural(p.i - last.i, "flight")} ahead</td><td class="num">${fmt(p.v)} (${fmt(p.lo)} to ${fmt(p.hi)})</td><td>Fleet history</td></tr>`).join("")}</tbody></table>`;
  return { svg: svg + legend, caption, table };
}

function renderSheet(d) {
  const el = document.getElementById("wo");
  const wo = d.work_order;
  if (!wo) {
    el.innerHTML = `<div class="sheet-head"><h2>Work order</h2></div>
      <div class="empty-sheet"><p>${d.status === "green" ? "Nothing needs fixing right now. You can still have Squawk review this aircraft." : "Squawk can explain these readings and write the work order for your mechanic."}</p>
      <button class="btn primary" id="dx" style="width:100%">Write work order</button></div>`;
  } else {
    const dx = wo.diagnosis;
    const by = dx.source === "workers-ai" ? "Squawk AI (Workers AI, Llama 3.3 70B)" : "Squawk rules (AI unavailable)";
    el.innerHTML = `<div class="sheet-head"><h2>Work order ${wo.id}</h2><span class="data muted" style="font-size:14px">${esc(d.aircraft.name)}</span></div>
      <div class="sheet-body">
        <div class="field"><div class="k">Discrepancy</div><div class="v"><b>${esc(dx.title)}</b><br/>${esc(dx.summary)}</div></div>
        ${dx.likely_causes?.length ? `<div class="field"><div class="k">Likely cause</div>${dx.likely_causes.map((c) => `<div class="cause v">${esc(c.cause)} <span class="conf">(${esc(c.confidence)} confidence)</span></div>`).join("")}</div>` : ""}
        ${dx.actions?.length ? `<div class="field"><div class="k">Corrective action</div><ol class="v">${dx.actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ol></div>` : ""}
        ${dx.parts?.length ? `<div class="field"><div class="k">Parts that may be needed</div><ul class="v">${dx.parts.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>` : ""}
        <div class="field"><div class="k">Urgency</div><div class="v urg ${dx.urgency}">${URGENCY[dx.urgency] || esc(dx.urgency)}</div></div>
        <div class="field"><div class="k">Prepared by</div><div class="v">${by}, ${esc(wo.created_at)} UTC</div></div>
        <div class="signoff"><div>Mechanic signature</div><div>Date</div></div>
        <div class="status-set" role="group" aria-label="Work order status">${Object.entries(WO_STATUS).map(([k, v]) => `<button type="button" data-s="${k}" aria-pressed="${wo.status === k}">${v}</button>`).join("")}</div>
        <div class="sheet-foot"><span>Advisory. The mechanic makes the call.</span><button class="link-btn" id="dx">Rewrite</button></div>
      </div>`;
    el.querySelectorAll("[data-s]").forEach((b) => (b.onclick = async () => {
      try {
        await api(`/api/work-orders/${wo.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: b.dataset.s }) });
        wo.status = b.dataset.s;
        renderSheet(d);
        toast(`Work order ${wo.id} marked ${WO_STATUS[wo.status].toLowerCase()}`);
      } catch (err) { toast(`Couldn't update the work order. ${err.message}`, true); }
    }));
  }
  document.getElementById("dx").onclick = async (e) => {
    const b = e.currentTarget, orig = b.innerHTML;
    b.disabled = true;
    b.innerHTML = b.classList.contains("primary") ? `<span class="spinner"></span>Writing work order…` : "Rewriting…";
    try {
      const r = await api(`/api/aircraft/${encodeURIComponent(d.aircraft.id)}/diagnose`, { method: "POST" });
      if (d.standalone) { location.hash = `#/work-orders/${r.work_order.id}`; return; }
      d.work_order = r.work_order;
      fleetCache = null;
      renderSheet(d);
    } catch (err) {
      toast(`Couldn't write the work order. ${err.message}`, true);
      b.disabled = false;
      b.innerHTML = orig;
    }
  };
}

function wireUpload(id) {
  const drop = document.getElementById("drop");
  const idle = drop.innerHTML;
  const send = async (files) => {
    if (!files || !files.length) return;
    const r = await uploadFlights(id, files, (i, n, name) => (drop.innerHTML = `Reading <b>${esc(name)}</b> (${i} of ${n})…`));
    if (!r.last) {
      toast(`Those files couldn't be read. ${r.failed[0] || ""}`, true);
      drop.innerHTML = idle;
      wireUpload(id);
      return;
    }
    const st = STATE[r.last.status]?.text.toLowerCase() || r.last.status;
    toast(r.failed.length ? `${r.total - r.failed.length} of ${r.total} logs added. ${r.failed[0]}` : `${plural(r.total, "flight")} added. ${id} is now ${st}.`, r.failed.length > 0);
    route();
  };
  document.getElementById("file").onchange = (e) => send(e.target.files);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); send(e.dataTransfer.files); };
}

// ---------- work orders ----------
async function renderWorkOrders() {
  const { work_orders } = await api("/api/work-orders");
  const open = work_orders.filter((w) => w.status !== "done").length;
  app.innerHTML = `<h1>${work_orders.length ? `${open} open work order${open === 1 ? "" : "s"}` : "No work orders yet"}</h1>
    <p class="lede">${work_orders.length ? "Written by Squawk from the engine data, signed off by your mechanics." : "Open an aircraft that needs attention and choose Write work order."}</p>
    ${work_orders.length ? `<div class="board"><table class="wo-table"><thead><tr><th scope="col">No.</th><th scope="col">Aircraft</th><th scope="col">Discrepancy</th><th scope="col">Urgency</th><th scope="col">Status</th></tr></thead><tbody>
      ${work_orders.map((w) => `<tr data-wo="${w.id}">
        <td class="data"><a href="#/work-orders/${w.id}">${w.id}</a></td>
        <td class="data"><a href="#/aircraft/${encodeURIComponent(w.aircraft_id)}">${esc(w.aircraft_name)}</a></td>
        <td><a href="#/work-orders/${w.id}">${esc(w.diagnosis.title)}</a></td>
        <td class="urg ${w.diagnosis.urgency}">${URGENCY[w.diagnosis.urgency] || ""}</td>
        <td>${WO_STATUS[w.status] || esc(w.status)}</td></tr>`).join("")}
    </tbody></table></div>` : ""}`;
  // Whole row opens the work order; the registration link still goes to the aircraft.
  document.querySelectorAll(".wo-table tr[data-wo]").forEach((tr) => (tr.onclick = (e) => {
    if (e.target.closest("a, button")) return;
    location.hash = `#/work-orders/${tr.dataset.wo}`;
  }));
}

async function renderWorkOrderPage(id) {
  app.innerHTML = `<p class="loading">Loading work order ${id}…</p>`;
  const { work_order: wo } = await api(`/api/work-orders/${id}`);
  const d = { aircraft: { id: wo.aircraft_id, name: wo.aircraft_name }, status: wo.risk_status, work_order: wo, standalone: true };
  const lvl = { red: "Needs attention", yellow: "Watch", green: "Normal" };
  app.innerHTML = `
    <nav class="ac-nav" aria-label="Breadcrumb">
      <a class="crumb" href="#/work-orders">Work orders</a><span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-here">No. ${wo.id}</span>
      <div class="switcher"><a class="btn sm" href="#/aircraft/${encodeURIComponent(wo.aircraft_id)}">Open ${esc(wo.aircraft_name)}</a></div>
    </nav>
    <h1>${esc(wo.diagnosis.title)}</h1>
    <p class="lede">For ${esc(wo.aircraft_name)}, a ${esc((wo.aircraft_model || "").replace(/\s*\(.*\)$/, ""))}. Written ${esc(wo.created_at)} UTC when the aircraft was rated ${esc((lvl[wo.risk_status] || wo.risk_status || "").toLowerCase())}.</p>
    <div class="cols">
      <div>
        <h2>Readings it was based on</h2>
        ${wo.findings?.length ? `<ul class="findings">${wo.findings.map((f) => `<li><div class="finding" style="cursor:default">
          <span class="t">${esc(f.label)}</span>${gauge(f.z, { width: 130 })}
          <span class="d"><span class="data">${f.recent_value} ${esc(f.unit)}</span> then, fleet normal <span class="data">${f.fleet_typical} ${esc(f.unit)}</span></span>
        </div></li>`).join("")}</ul>` : `<p class="no-findings">Nothing was out of range when this was written.</p>`}
        <p class="muted" style="font-size:14px;margin-top:12px">These are the readings at the time the work order was written. The aircraft page shows the latest.</p>
      </div>
      <aside><div class="sheet" id="wo"></div></aside>
    </div>`;
  renderSheet(d);
}

// ---------- boot ----------
(async () => {
  try {
    const [c, h] = await Promise.all([api("/api/checks"), api("/api/health")]);
    CHECKS = c.checks;
    THRESHOLDS = c.thresholds;
    GROUPS = c.groups || [];
    NOT_COVERED = c.not_covered || [];
    document.getElementById("sys").textContent = `Running on Cloudflare Workers, D1${h.r2 ? ", R2" : ""}${h.ai ? " and Workers AI" : ""}`;
  } catch {
    document.getElementById("sys").textContent = "Can't reach the API";
  }
  route();
})();
