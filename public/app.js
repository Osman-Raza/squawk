// Squawk dashboard (vanilla JS, no build step).
const app = document.getElementById("app");
const $toast = document.getElementById("toast");
let CHECKS = [];
let THRESHOLDS = { red: 3.5, yellow: 2.25 };
const GAUGE_MAX = 6;

const C = { ink: "#17202B", ink2: "#4A5563", ink3: "#6B7684", rule: "#D8DDE3", green: "#1F8A4C", amber: "#D69E00", red: "#C8322B", magenta: "#B3127A" };
const STATE = {
  red: { text: "Needs attention", color: C.red },
  yellow: { text: "Watch", color: C.amber },
  green: { text: "Normal", color: C.green },
  unknown: { text: "No data", color: C.ink3 },
};
const URGENCY = { monitor: "Monitor", next_inspection: "At next scheduled inspection", next_flight_check: "Check before next flight", ground_until_checked: "Ground until checked" };
const WO_STATUS = { open: "Open", in_progress: "In progress", done: "Done" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const levelOf = (z) => (z >= THRESHOLDS.red ? "red" : z >= THRESHOLDS.yellow ? "yellow" : "green");
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

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
  return `<circle cx="${cx}" cy="${cy}" r="${s * 0.8}" fill="${C.green}"/>`;
}
const stateLabel = (status) =>
  `<span class="state ${status}"><svg width="12" height="12" aria-hidden="true">${shape(status === "unknown" ? "green" : status, 6, 6, 5)}</svg>${STATE[status].text}</span>`;

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
  const hash = location.hash || "#/";
  const section = hash.startsWith("#/work-orders") ? "work-orders" : "fleet";
  document.querySelectorAll(".bar nav a").forEach((a) => (a.dataset.nav === section ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  try {
    if (hash.startsWith("#/aircraft/")) await renderAircraft(decodeURIComponent(hash.split("/")[2]));
    else if (section === "work-orders") await renderWorkOrders();
    else await renderFleet();
  } catch (e) {
    app.innerHTML = `<div class="error-panel"><h2>This page didn't load</h2><p class="muted">${esc(e.message)} Check that the Worker is running and the database is seeded, then try again.</p><button class="btn" id="retry">Try again</button></div>`;
    document.getElementById("retry").onclick = route;
  }
}
window.addEventListener("hashchange", () => route().then(() => { window.scrollTo(0, 0); app.focus({ preventScroll: true }); }));

// ---------- fleet ----------
async function renderFleet() {
  if (!app.querySelector(".board")) app.innerHTML = `<p class="loading">Loading the fleet…</p>`;
  const data = await api("/api/fleet");
  const { counts } = data;
  const total = data.aircraft.length;
  const headline = counts.red
    ? `${counts.red} of ${total} aircraft need attention.`
    : counts.yellow
    ? `${counts.yellow} of ${total} aircraft to watch. The rest look normal.`
    : `All ${total} aircraft look normal.`;
  const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  const groups = ["red", "yellow", "green", "unknown"].map((s) => [s, data.aircraft.filter((a) => a.status === s)]).filter(([, list]) => list.length);
  const rows = groups.map(([s, list]) => `
      <tr class="group-row"><td colspan="5">${STATE[s].text} (${list.length})</td></tr>
      ${list.map(row).join("")}`).join("");

  app.innerHTML = `
    <div class="head-row">
      <div>
        <h1>${headline}</h1>
        <p class="lede">Squawk compared ${data.total_flights} flights against each aircraft's own history and the rest of the fleet. Updated ${time}. <button class="link-btn" id="refresh">Refresh</button></p>
      </div>
    </div>
    <div class="board">
      <table>
        <thead><tr><th scope="col">Aircraft</th><th scope="col">Condition</th><th scope="col">Main issue</th><th scope="col" class="num">Flights</th><th scope="col">Work order</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5">No aircraft yet. Load the seed file to add the fleet (see README).</td></tr>`}</tbody>
      </table>
    </div>`;
  document.getElementById("refresh").onclick = async () => { await route(); toast("Fleet refreshed"); };
}

function row(a) {
  const issue = a.top_finding && a.status !== "green"
    ? `<td class="issue">${esc(a.top_finding.label)}${a.flagged > 1 ? `<span class="muted">, and ${a.flagged - 1} more</span>` : ""}</td>`
    : `<td class="issue none">Nothing unusual</td>`;
  return `<tr>
    <td class="ac"><a href="#/aircraft/${encodeURIComponent(a.id)}">${esc(a.name)}</a><span class="sub">${esc(a.model)}</span></td>
    <td class="cond">${gauge(a.score)}${stateLabel(a.status)}</td>
    ${issue}
    <td class="num">${a.flights}</td>
    <td class="wo">${a.open_work_order ? `<span class="wo-link">#${a.open_work_order.id} ${WO_STATUS[a.open_work_order.status].toLowerCase()}</span>` : ""}</td>
  </tr>`;
}

// ---------- aircraft ----------
const view = { reveal: false, key: null, id: null };

function verdict(d) {
  if (!d.findings.length) return "Every engine reading on recent flights is inside the fleet's normal range.";
  const f = d.findings[0];
  const chk = CHECKS.find((c) => c.key === f.key);
  const side = chk?.dir === "low" ? "below" : chk?.dir === "high" ? "above" : f.recent_value >= f.fleet_typical ? "above" : "below";
  const rest = d.findings.length - 1;
  return `${f.label} is ${side} the fleet's normal range on ${Math.round(f.persistence * 100)}% of the last ${f.flights_considered} flights${rest ? `, and ${rest} other reading${rest > 1 ? "s are" : " is"} off too` : ""}.`;
}

async function renderAircraft(id) {
  if (view.id !== id) app.innerHTML = `<p class="loading">Loading ${esc(id)}…</p>`;
  const d = await api(`/api/aircraft/${encodeURIComponent(id)}`);
  if (view.id !== id) { view.reveal = false; view.key = null; }
  view.key = view.key || d.findings[0]?.key || "egt_spread";
  view.id = id;
  const hasFuture = d.flights.some((f) => f.is_future);

  app.innerHTML = `
    <a class="crumb" href="#/">Back to fleet</a>
    <div class="ac-head">
      <div>
        <h1 class="ac-name">${esc(d.aircraft.name)}</h1>
        <p class="verdict">${esc(verdict(d))}</p>
        <p class="muted" style="margin:6px 0 0;font-size:14px">${esc(d.aircraft.model)}, ${d.flights.filter((f) => !f.is_future).length} flights on record</p>
      </div>
      <div class="big-gauge">${gauge(d.score, { width: 280, big: true })}${stateLabel(d.status)}<div class="cap">Deviation from fleet normal</div></div>
    </div>
    <div class="cols">
      <div>
        <h2>Readings out of range</h2>
        ${d.findings.length ? `<ul class="findings">${d.findings.map(findingItem).join("")}</ul>` : `<p class="no-findings">None. Pick any reading below to see its trend.</p>`}

        <section class="trend" aria-labelledby="h-trend">
          <div class="trend-head">
            <h2 id="h-trend">Trend over recent flights</h2>
            <label class="sr-only" for="metric">Reading</label>
            <select id="metric">${CHECKS.map((c) => `<option value="${c.key}" ${c.key === view.key ? "selected" : ""}>${esc(c.label)}</option>`).join("")}</select>
          </div>
          <div class="chart-wrap" id="chart"></div>
          <p class="chart-caption" id="caption" aria-live="polite"></p>
          ${hasFuture ? `<div class="reveal-row"><label class="toggle"><input type="checkbox" id="reveal" ${view.reveal ? "checked" : ""}/>Show what happened after these flights</label></div><div id="outcome"></div>` : ""}
          <details class="table"><summary>Show the numbers as a table</summary><div id="data-table"></div></details>
        </section>
      </div>
      <aside>
        <div class="sheet" id="wo"></div>
        <div class="upload">
          <h2>Add a flight</h2>
          <label class="drop" id="drop"><b>Choose an engine log</b> or drop it here. Garmin G1000 and NGAFID CSV files work.<input type="file" id="file" accept=".csv,text/csv" class="sr-only" /></label>
        </div>
      </aside>
    </div>`;

  const draw = () => {
    const chk = CHECKS.find((c) => c.key === view.key) || CHECKS[0];
    const out = chart(d, chk, view.reveal);
    document.getElementById("chart").innerHTML = out.svg;
    document.getElementById("caption").textContent = out.caption;
    document.getElementById("data-table").innerHTML = out.table;
    document.querySelectorAll(".finding").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.key === view.key)));
    const o = document.getElementById("outcome");
    if (o) o.innerHTML = view.reveal && d.repair ? `<div class="outcome">After these flights the aircraft went in for an unplanned repair, logged as “${esc(d.repair.label)}”. The magenta points are the flights after it. Source: NGAFID maintenance records.</div>` : "";
  };
  draw();
  document.getElementById("metric").onchange = (e) => { view.key = e.target.value; draw(); };
  document.querySelectorAll(".finding").forEach((b) => (b.onclick = () => { view.key = b.dataset.key; document.getElementById("metric").value = view.key; draw(); }));
  const rv = document.getElementById("reveal");
  if (rv) rv.onchange = (e) => { view.reveal = e.target.checked; draw(); };

  renderSheet(d);
  wireUpload(id);
}

function findingItem(f) {
  const change = f.change === null ? "" : `, ${f.change >= 0 ? "up" : "down"} ${Math.abs(f.change)} since earlier flights`;
  return `<li><button type="button" class="finding" data-key="${f.key}" aria-pressed="false">
    <span class="t">${esc(f.label)}</span>
    ${gauge(f.z, { width: 130 })}
    <span class="d"><span class="data">${f.recent_value} ${esc(f.unit)}</span> now, fleet normal <span class="data">${f.fleet_typical} ${esc(f.unit)}</span>${change}</span>
  </button></li>`;
}

function chart(d, chk, reveal) {
  const base = d.baseline[chk.key];
  const flights = d.flights.filter((f) => reveal || !f.is_future);
  const badZ = (v) => {
    const z = (v - base.median) / base.scale;
    return chk.dir === "high" ? z : chk.dir === "low" ? -z : Math.abs(z);
  };
  const pts = flights.map((f, i) => ({ i, v: f.features[chk.key], future: f.is_future, f })).filter((p) => p.v !== null && p.v !== undefined);
  if (!pts.length || !base || base.median === null) return { svg: `<p class="muted" style="padding:16px">No data recorded for this reading.</p>`, caption: "", table: "" };
  pts.forEach((p) => { p.z = badZ(p.v); p.level = p.future ? "after" : levelOf(p.z); });

  const W = 760, H = 300, L = 52, R = 24, T = 26, B = 36;
  const lo = base.median - THRESHOLDS.yellow * base.scale, hi = base.median + THRESHOLDS.yellow * base.scale;
  const limHi = base.median + THRESHOLDS.red * base.scale, limLo = base.median - THRESHOLDS.red * base.scale;
  const showHi = chk.dir !== "low", showLo = chk.dir !== "high";
  const vals = pts.map((p) => p.v).concat([lo, hi, showHi ? limHi : hi, showLo ? limLo : lo]);
  let ymin = Math.min(...vals), ymax = Math.max(...vals);
  const pad = (ymax - ymin) * 0.1 || 1;
  ymin -= pad; ymax += pad;
  const n = Math.max(flights.length, 2);
  const x = (i) => L + (i / (n - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - ymin) / (ymax - ymin)) * (H - T - B);
  const ticks = Array.from({ length: 4 }, (_, k) => ymin + ((ymax - ymin) * (k + 0.5)) / 4);
  const solid = pts.filter((p) => !p.future), fut = pts.filter((p) => p.future);
  const line = (arr) => arr.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const firstFuture = flights.findIndex((f) => f.is_future);
  const repairX = reveal && firstFuture > 0 ? (x(firstFuture - 1) + x(firstFuture)) / 2 : null;
  const worst = solid.reduce((m, p) => (p.z > (m?.z ?? -Infinity) ? p : m), null);
  const label = (tx, ty, text, anchor = "start", color = C.ink3, weight = 400) => `<text x="${tx}" y="${ty}" text-anchor="${anchor}" fill="${color}" font-size="12" font-weight="${weight}" font-family="Public Sans, sans-serif">${text}</text>`;

  const marker = (p) => {
    const tip = `<title>${esc(p.f.flown_at)}: ${p.v} ${esc(chk.unit)}${p.future ? ", after the repair" : ""}</title>`;
    const cx = x(p.i), cy = y(p.v);
    if (p.level === "after") return `<g>${tip}<circle cx="${cx}" cy="${cy}" r="4" fill="#fff" stroke="${C.magenta}" stroke-width="2"/></g>`;
    if (p.level === "green") return `<g>${tip}<circle cx="${cx}" cy="${cy}" r="3.5" fill="${C.ink2}"/></g>`;
    return `<g>${tip}${shape(p.level, cx, cy, 6)}</g>`;
  };
  const annot = worst && worst.level !== "green"
    ? (() => {
        const ax = x(worst.i), ay = y(worst.v), left = ax > L + 120;
        return `<text x="${left ? ax - 12 : ax + 12}" y="${ay - 6}" text-anchor="${left ? "end" : "start"}" fill="${C.ink}" font-size="13" font-weight="700" font-family="B612, sans-serif">${fmt(worst.v)} ${esc(chk.unit)}</text>`;
      })()
    : "";

  const svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="caption">
    ${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="#EEF1F4"/>${label(L - 8, y(t) + 4, fmt(t), "end")}`).join("")}
    <rect x="${L}" width="${W - L - R}" y="${y(hi)}" height="${Math.max(0, y(lo) - y(hi))}" fill="rgba(31,138,76,.10)"/>
    ${showHi ? `<line x1="${L}" x2="${W - R}" y1="${y(limHi)}" y2="${y(limHi)}" stroke="${C.red}" stroke-width="1.5"/>${label(W - R, y(limHi) - 6, "Limit", "end", C.red, 600)}` : ""}
    ${showLo ? `<line x1="${L}" x2="${W - R}" y1="${y(limLo)}" y2="${y(limLo)}" stroke="${C.red}" stroke-width="1.5"/>${showHi ? "" : label(W - R, y(limLo) + 15, "Limit", "end", C.red, 600)}` : ""}
    ${repairX ? `<line x1="${repairX}" x2="${repairX}" y1="${T - 8}" y2="${H - B}" stroke="${C.magenta}" stroke-width="2"/>${label(repairX + 6, T, "Repair", "start", C.magenta, 700)}` : ""}
    <path d="${line(solid)}" fill="none" stroke="${C.ink2}" stroke-width="1.75"/>
    ${fut.length ? `<path d="${line([solid[solid.length - 1], ...fut].filter(Boolean))}" fill="none" stroke="${C.magenta}" stroke-width="1.75" stroke-dasharray="5 4"/>` : ""}
    ${pts.map(marker).join("")}
    ${annot}
    ${label(L, H - 10, "Oldest flight")}
    ${label(W - R, H - 10, reveal && fut.length ? "Latest, after repair" : "Latest flight", "end")}
  </svg>`;

  const recent = solid.slice(-5);
  const out = recent.filter((p) => p.level !== "green").length;
  const caption = `${chk.label} in ${chk.unit}. The green band is the fleet's normal range and the red line is the limit. The fleet normally sits around ${fmt(base.median)}. ${out ? `${out} of the last ${recent.length} flights were outside the normal range` : `The last ${recent.length} flights were all inside the normal range`}${worst && worst.level !== "green" ? `, peaking at ${fmt(worst.v)}` : ""}.${reveal && fut.length ? ` After the repair: ${fut.map((p) => fmt(p.v)).join(", ")}.` : ""}`;
  const lvl = { red: "Past the limit", yellow: "Caution", green: "Normal", after: "After repair" };
  const table = `<table><thead><tr><th>Flight</th><th class="num">${esc(chk.unit)}</th><th>Reading</th></tr></thead><tbody>
    ${pts.map((p) => `<tr><td>${esc(p.f.flown_at)}</td><td class="num">${p.v}</td><td>${lvl[p.level]}</td></tr>`).join("")}</tbody></table>`;
  return { svg, caption, table };
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
      d.work_order = r.work_order;
      renderSheet(d);
    } catch (err) {
      toast(`Couldn't write the work order. ${err.message}`, true);
      b.disabled = false;
      b.innerHTML = orig;
    }
  };
}

function wireUpload(id) {
  const drop = document.getElementById("drop"), input = document.getElementById("file");
  const idle = drop.innerHTML;
  const send = async (file) => {
    if (!file) return;
    drop.innerHTML = `Reading <b>${esc(file.name)}</b>…`;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await api(`/api/aircraft/${encodeURIComponent(id)}/flights`, { method: "POST", body: fd });
      toast(`Flight added. ${r.rows_parsed.toLocaleString()} rows read, ${id} is now ${STATE[r.status].text.toLowerCase()}.`);
      route();
    } catch (e) {
      toast(`That file couldn't be read. ${e.message}`, true);
      drop.innerHTML = idle;
      wireUpload(id);
    }
  };
  document.getElementById("file").onchange = (e) => send(e.target.files[0]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); send(e.dataTransfer.files[0]); };
}

// ---------- work orders ----------
async function renderWorkOrders() {
  const { work_orders } = await api("/api/work-orders");
  const open = work_orders.filter((w) => w.status !== "done").length;
  app.innerHTML = `<h1>${work_orders.length ? `${open} open work order${open === 1 ? "" : "s"}` : "No work orders yet"}</h1>
    <p class="lede">${work_orders.length ? "Written by Squawk from the engine data, signed off by your mechanics." : "Open an aircraft that needs attention and choose Write work order."}</p>
    ${work_orders.length ? `<div class="board"><table class="wo-table"><thead><tr><th scope="col">No.</th><th scope="col">Aircraft</th><th scope="col">Discrepancy</th><th scope="col">Urgency</th><th scope="col">Status</th></tr></thead><tbody>
      ${work_orders.map((w) => `<tr>
        <td class="data">${w.id}</td>
        <td class="data"><a href="#/aircraft/${encodeURIComponent(w.aircraft_id)}">${esc(w.aircraft_name)}</a></td>
        <td>${esc(w.diagnosis.title)}</td>
        <td class="urg ${w.diagnosis.urgency}">${URGENCY[w.diagnosis.urgency] || ""}</td>
        <td>${WO_STATUS[w.status] || esc(w.status)}</td></tr>`).join("")}
    </tbody></table></div>` : ""}`;
}

// ---------- boot ----------
(async () => {
  try {
    const [c, h] = await Promise.all([api("/api/checks"), api("/api/health")]);
    CHECKS = c.checks;
    THRESHOLDS = c.thresholds;
    document.getElementById("sys").textContent = `Running on Cloudflare Workers, D1${h.r2 ? ", R2" : ""}${h.ai ? " and Workers AI" : ""}`;
  } catch {
    document.getElementById("sys").textContent = "Can't reach the API";
  }
  route();
})();
