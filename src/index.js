// Squawk Worker: API + static dashboard (served from ./public via Workers Assets).
import { parseFlightCsv, computeFeatures, scoreFleet, statusHistory, predictionsFor, CHECKS, GROUPS, NOT_COVERED, THRESHOLDS, MIN_FLIGHTS, TREND_WINDOW } from "./engine.js";
import { diagnose } from "./ai.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (message, status = 400) => json({ error: message }, status);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/health") return json({ ok: true, ai: !!env.AI, r2: !!env.LOGS, db: !!env.DB });
      if (path === "/api/checks") return json({ checks: CHECKS, thresholds: THRESHOLDS, groups: GROUPS, not_covered: NOT_COVERED });
      if (path === "/api/fleet" && request.method === "GET") return json(await fleet(env));
      if (path === "/api/aircraft" && request.method === "POST") return addAircraft(env, request);

      let m;
      if ((m = path.match(/^\/api\/aircraft\/([\w-]+)$/)) && request.method === "GET") return aircraftDetail(env, m[1]);
      if ((m = path.match(/^\/api\/aircraft\/([\w-]+)\/diagnose$/)) && request.method === "POST") return runDiagnosis(env, m[1]);
      if ((m = path.match(/^\/api\/aircraft\/([\w-]+)\/flights$/)) && request.method === "POST") return uploadFlight(env, m[1], request);
      if ((m = path.match(/^\/api\/work-orders\/(\d+)$/)) && request.method === "GET") return getWorkOrder(env, +m[1]);
      if ((m = path.match(/^\/api\/work-orders\/(\d+)$/)) && request.method === "PATCH") return updateWorkOrder(env, +m[1], request);
      if (path === "/api/work-orders" && request.method === "GET") return listWorkOrders(env);

      if (path.startsWith("/api/")) return err("Not found", 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(e);
      return err(e.message || "Server error", 500);
    }
  },
};

// ---------- Fleet scoring ----------

async function loadFleet(env) {
  const [{ results: aircraft }, { results: flights }] = await Promise.all([
    env.DB.prepare("SELECT * FROM aircraft ORDER BY id").all(),
    env.DB.prepare("SELECT id, aircraft_id, seq, flown_at, features, is_future, source, ngafid_before_after, ngafid_date_diff, ngafid_label FROM flights ORDER BY aircraft_id, seq").all(),
  ]);
  for (const f of flights) f.features = JSON.parse(f.features);
  const byAircraft = {};
  for (const f of flights) (byAircraft[f.aircraft_id] ??= []).push(f);
  // scoreFleet adjusts temperatures for outside air temp (keeping raw values in f.raw), builds the baseline and scores every aircraft.
  const { oat, base, results } = scoreFleet(aircraft.map((a) => ({ id: a.id, flights: byAircraft[a.id] || [] })));
  return { aircraft, byAircraft, base, oat, results };
}

async function fleet(env) {
  const { aircraft, byAircraft, results } = await loadFleet(env);
  const { results: wos } = await env.DB.prepare(
    "SELECT aircraft_id, id, status, created_at FROM work_orders WHERE status != 'done' ORDER BY created_at DESC"
  ).all();
  const openWo = {};
  for (const w of wos) openWo[w.aircraft_id] ??= w;

  const list = aircraft.map((a) => {
    const flights = (byAircraft[a.id] || []).filter((f) => !f.is_future);
    const as = results[a.id];
    const e = as.early[0];
    const learning = flights.length < MIN_FLIGHTS;
    return {
      id: a.id, name: a.name, model: a.model, role: a.role,
      status: learning ? "learning" : as.status, score: learning ? 0 : as.score,
      needs_flights: learning ? MIN_FLIGHTS - flights.length : 0,
      flights: flights.length,
      top_finding: as.findings[0] ? { key: as.findings[0].key, label: as.findings[0].label, z: as.findings[0].z, to_limit: as.findings[0].trend?.to_limit ?? null } : null,
      early_warning: e ? { key: e.key, label: e.label, to_caution: e.trend.to_caution } : null,
      flagged: as.findings.length,
      open_work_order: openWo[a.id] || null,
    };
  });
  const rank = { red: 0, yellow: 1, green: 2, learning: 3, unknown: 4 };
  list.sort((x, y) => rank[x.status] - rank[y.status] || y.score - x.score);
  const counts = { red: 0, yellow: 0, green: 0, learning: 0 };
  for (const a of list) if (counts[a.status] !== undefined) counts[a.status]++;
  return { aircraft: list, counts, total_flights: Object.values(byAircraft).flat().filter((f) => !f.is_future).length };
}

async function aircraftDetail(env, id) {
  const { aircraft, byAircraft, base, oat, results } = await loadFleet(env);
  const a = aircraft.find((x) => x.id === id);
  if (!a) return err("Aircraft not found", 404);
  const all = byAircraft[id] || [];
  const current = all.filter((f) => !f.is_future);
  const as = results[id];
  const otherRaw = Object.entries(byAircraft).filter(([k]) => k !== id).flatMap(([, fl]) => fl.filter((f) => !f.is_future).map((f) => f.raw));
  const history = statusHistory(current.map((f) => ({ seq: f.seq, features: f.raw })), otherRaw);
  const samples = current.map((f) => f.features.cruise_samples || 0);
  const explain = {
    flights: current.length,
    checks: CHECKS.length,
    checks_recorded: as.all.filter((c) => c.recorded).length,
    groups: GROUPS,
    not_covered: NOT_COVERED,
    avg_cruise_samples: samples.length ? Math.round(samples.reduce((s, x) => s + x, 0) / samples.length) : 0,
    baseline_flights: otherRaw.length + current.length,
    fleet_aircraft: aircraft.length,
    recent_window: 5,
    trend_window: TREND_WINDOW,
    min_flights: MIN_FLIGHTS,
    r2: !!env.LOGS,
  };
  const wo = await env.DB.prepare("SELECT * FROM work_orders WHERE aircraft_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").bind(id).first();
  const learning = current.length < MIN_FLIGHTS;
  const others = aircraft.filter((x) => x.id !== id).map((x) => ({ id: x.name, flights: (byAircraft[x.id] || []).filter((f) => !f.is_future) }));
  const predictions = learning ? {} : predictionsFor(current, others, base, as);
  return json({
    aircraft: a,
    status: learning ? "learning" : as.status,
    score: learning ? 0 : as.score,
    findings: as.findings,
    early: as.early,
    predictions,
    all_checks: as.all,
    baseline: base,
    oat_model: oat,
    flights: all.map((f) => ({ id: f.id, seq: f.seq, flown_at: f.flown_at, is_future: !!f.is_future, source: f.source, before_after: f.ngafid_before_after, date_diff: f.ngafid_date_diff, features: f.features, raw: f.raw })),
    repair: all.find((f) => f.ngafid_label) ? { label: all.find((f) => f.ngafid_label).ngafid_label } : null,
    history,
    explain,
    work_order: wo ? parseWo(wo) : null,
  });
}

// ---------- AI diagnosis + work order ----------

async function runDiagnosis(env, id) {
  const { aircraft, results } = await loadFleet(env);
  const a = aircraft.find((x) => x.id === id);
  if (!a) return err("Aircraft not found", 404);
  const as = results[id];
  const dx = await diagnose(env, a, as);
  const row = await env.DB.prepare(
    "INSERT INTO work_orders (aircraft_id, status, risk_status, risk_score, diagnosis, findings) VALUES (?, 'open', ?, ?, ?, ?) RETURNING *"
  ).bind(id, as.status, as.score, JSON.stringify(dx), JSON.stringify(as.findings)).first();
  return json({ work_order: parseWo(row) });
}

async function listWorkOrders(env) {
  const { results } = await env.DB.prepare(
    "SELECT w.*, a.name AS aircraft_name FROM work_orders w JOIN aircraft a ON a.id = w.aircraft_id ORDER BY w.created_at DESC, w.id DESC LIMIT 100"
  ).all();
  return json({ work_orders: results.map(parseWo) });
}

// ---------- Add an aircraft ----------
async function addAircraft(env, request) {
  const body = await request.json().catch(() => ({}));
  const reg = String(body.registration || "").trim().toUpperCase();
  const model = String(body.model || "").trim();
  if (!/^[A-Z0-9][A-Z0-9-]{1,9}$/.test(reg)) return err("Enter a registration using letters, numbers and dashes, like C-FABC.");
  if (!model || model.length > 60) return err("Enter the aircraft model, like Cessna 172.");
  const exists = await env.DB.prepare("SELECT id FROM aircraft WHERE id = ?").bind(reg).first();
  if (exists) return err(`${reg} is already in the fleet.`, 409);
  await env.DB.prepare("INSERT INTO aircraft (id, name, model, role, source_note) VALUES (?, ?, ?, 'customer', 'Added in the dashboard')").bind(reg, reg, model).run();
  return json({ aircraft: { id: reg, name: reg, model } }, 201);
}

async function getWorkOrder(env, id) {
  const row = await env.DB.prepare(
    "SELECT w.*, a.name AS aircraft_name, a.model AS aircraft_model FROM work_orders w JOIN aircraft a ON a.id = w.aircraft_id WHERE w.id = ?"
  ).bind(id).first();
  if (!row) return err("Work order not found", 404);
  return json({ work_order: parseWo(row) });
}

async function updateWorkOrder(env, id, request) {
  const body = await request.json().catch(() => ({}));
  if (!["open", "in_progress", "done"].includes(body.status)) return err("status must be open, in_progress or done");
  const row = await env.DB.prepare("UPDATE work_orders SET status = ?, updated_at = datetime('now') WHERE id = ? RETURNING *").bind(body.status, id).first();
  if (!row) return err("Work order not found", 404);
  return json({ work_order: parseWo(row) });
}

function parseWo(w) {
  return { ...w, diagnosis: JSON.parse(w.diagnosis), findings: JSON.parse(w.findings) };
}

// ---------- Upload a new flight log ----------

async function uploadFlight(env, id, request) {
  const a = await env.DB.prepare("SELECT * FROM aircraft WHERE id = ?").bind(id).first();
  if (!a) return err("Aircraft not found", 404);

  let text, filename = "flight.csv";
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return err("Missing file field");
    filename = file.name || filename;
    text = await file.text();
  } else {
    text = await request.text();
  }
  if (text.length > 25_000_000) return err("File too large (25 MB max)");

  const parsed = parseFlightCsv(text, 2500);
  const features = computeFeatures(parsed.rows, parsed.sampleStep, parsed.meta);

  let r2Key = null;
  if (env.LOGS) {
    r2Key = `${id}/${Date.now()}-${filename.replace(/[^\w.-]/g, "_")}`;
    await env.LOGS.put(r2Key, text, { httpMetadata: { contentType: "text/csv" } });
  }

  const last = await env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM flights WHERE aircraft_id = ? AND is_future = 0").bind(id).first();
  const seq = last.s + 1;
  // New uploads become the latest flight; push any "future" (post-repair) flights after it.
  await env.DB.prepare("UPDATE flights SET seq = seq + 1 WHERE aircraft_id = ? AND is_future = 1").bind(id).run();
  await env.DB.prepare(
    "INSERT INTO flights (aircraft_id, seq, flown_at, features, is_future, source, r2_key) VALUES (?, ?, ?, ?, 0, 'upload', ?)"
  ).bind(id, seq, `Uploaded ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, JSON.stringify(features), r2Key).run();

  const { results } = await loadFleet(env);
  const as = results[id];
  return json({ ok: true, seq, rows_parsed: parsed.totalRows, features, status: as.status, score: as.score, findings: as.findings, r2_key: r2Key });
}
