// Squawk detection engine.
// Pure JS, no Cloudflare APIs, so the Worker and the Node seed builder share it.
// Input format: Garmin G1000 / NGAFID style columns ("E1 CHT1", "E1 EGT1", "E1 OilP", ...).
// Every check below is computed only from channels the log actually records. If a channel is
// missing or empty for a flight, that check returns null and is reported as "not recorded".

export const CYLS = [1, 2, 3, 4];

const COLS = {
  rpm: "E1 RPM",
  ff: "E1 FFlow",
  oilp: "E1 OilP",
  oilt: "E1 OilT",
  volt1: "volt1",
  volt2: "volt2",
  amp1: "amp1",
  amp2: "amp2",
  fqL: "FQtyL",
  fqR: "FQtyR",
  ias: "IAS",
  vspd: "VSpd",
  normac: "NormAc",
  alt: "AltMSL",
  oat: "OAT",
  cht: CYLS.map((c) => `E1 CHT${c}`),
  egt: CYLS.map((c) => `E1 EGT${c}`),
};

// ---------- CSV parsing ----------

// Accepts NGAFID exports and raw G1000 logs (skips "#" preamble lines and the units row).
export function parseFlightCsv(text, maxRows = 3000) {
  // Optional "# step_seconds=4" comment (written by extract_ngafid.py) = seconds between rows. Raw G1000 logs are 1 Hz.
  const stepMatch = text.slice(0, 2000).match(/#\s*step_seconds\s*=\s*([\d.]+)/);
  const secondsPerRow = stepMatch ? parseFloat(stepMatch[1]) : 1;
  // Optional "g_peak=0.42" (measured by the extractor on full-resolution data before downsampling).
  const gMatch = text.slice(0, 2000).match(/#[^\n]*g_peak\s*=\s*([\d.]+)/);
  const meta = gMatch ? { g_peak: parseFloat(gMatch[1]) } : {};
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  if (!lines.length) throw new Error("Empty CSV");
  const headerIdx = lines.findIndex((l) => l.includes("E1 RPM") || l.includes("E1 EGT1"));
  if (headerIdx < 0) throw new Error("Could not find engine columns (expected 'E1 RPM', 'E1 EGT1', ...)");
  const header = splitCsv(lines[headerIdx]).map((h) => h.trim());
  let body = lines.slice(headerIdx + 1);
  // G1000 has a units row right after the header in some exports; drop non-numeric first row.
  if (body.length && isNaN(parseFloat(splitCsv(body[0])[header.indexOf("E1 RPM")]))) body = body.slice(1);

  const step = Math.max(1, Math.ceil(body.length / maxRows)); // downsample long flights
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const rows = [];
  for (let i = 0; i < body.length; i += step) {
    const cells = splitCsv(body[i]);
    const row = {};
    for (const key of Object.keys(idx)) {
      const v = parseFloat(cells[idx[key]]);
      row[key] = Number.isFinite(v) ? v : null;
    }
    rows.push(row);
  }
  // sampleStep = seconds between kept rows (for time-scaled features)
  return { header, rows, sampleStep: step * secondsPerRow, totalRows: body.length, meta };
}

function splitCsv(line) {
  if (!line.includes('"')) return line.split(",");
  const out = [];
  let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// ---------- helpers ----------

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const col = (rows, key) => rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
const round = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const has = (rows, key, min = 10) => col(rows, key).length >= min;

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Roughness: mean absolute change between samples, scaled to "per 10 seconds"
// so it's comparable across different sampling steps. A sticking exhaust valve shows up as EGT oscillation.
function roughness(values, secondsPerSample) {
  if (values.length < 3) return null;
  let s = 0;
  for (let i = 1; i < values.length; i++) s += Math.abs(values[i] - values[i - 1]);
  return (s / (values.length - 1)) * Math.sqrt(10 / Math.max(1, secondsPerSample));
}

// ---------- Per-flight features ----------

export function computeFeatures(rows, secondsPerSample = 1, meta = {}) {
  // Cruise filter: engine at power and aircraft flying. Falls back on short/odd flights.
  let cruise = rows.filter((r) => (r[COLS.rpm] ?? 0) >= 2000 && (r[COLS.ias] ?? 0) >= 60);
  if (cruise.length < 30) cruise = rows.filter((r) => (r[COLS.rpm] ?? 0) >= 1500);
  if (cruise.length < 10) cruise = rows;
  // Level cruise: no big climb or descent (for speed-per-power).
  const level = cruise.filter((r) => r[COLS.vspd] !== null && Math.abs(r[COLS.vspd]) < 150);
  // Full-power climb segment.
  const climb = rows.filter((r) => (r[COLS.rpm] ?? 0) >= 2250 && (r[COLS.vspd] ?? 0) > 200 && (r[COLS.ias] ?? 0) > 50);
  // Engine running (for fuel used).
  const running = rows.filter((r) => (r[COLS.rpm] ?? 0) >= 1500);
  const airborne = rows.filter((r) => (r[COLS.ias] ?? 0) > 30);

  const cht = COLS.cht.map((k) => mean(col(cruise, k)));
  const egt = COLS.egt.map((k) => mean(col(cruise, k)));
  const okCht = cht.filter((v) => v !== null);
  const okEgt = egt.filter((v) => v !== null);
  const chtAvg = mean(okCht);
  const egtAvg = mean(okEgt);
  const rpm = mean(col(cruise, COLS.rpm));
  const ff = mean(col(cruise, COLS.ff));

  // Peak CHT over the whole flight (climb is usually the hottest part).
  const allCht = COLS.cht.flatMap((k) => col(rows, k));

  // Fuel used according to the tank gauges vs fuel used according to the fuel flow reading.
  let fuelRatio = null;
  if (running.length >= 60 && has(running, COLS.fqL, 30) && has(running, COLS.fqR, 30) && has(running, COLS.ff, 30)) {
    const n = Math.min(20, Math.floor(running.length / 5));
    const qty = (r) => (r[COLS.fqL] ?? NaN) + (r[COLS.fqR] ?? NaN);
    const start = mean(running.slice(0, n).map(qty).filter(Number.isFinite));
    const end = mean(running.slice(-n).map(qty).filter(Number.isFinite));
    const hours = (running.length * secondsPerSample) / 3600;
    const flowGph = mean(col(running, COLS.ff));
    if (start !== null && end !== null && hours >= 0.3 && flowGph > 0) {
      const gaugeGph = (start - end) / hours;
      fuelRatio = gaugeGph / flowGph;
    }
  }

  // Tank imbalance in cruise.
  const imb = cruise.map((r) => (r[COLS.fqL] !== null && r[COLS.fqR] !== null ? Math.abs(r[COLS.fqL] - r[COLS.fqR]) : null)).filter((v) => v !== null);

  // Peak vertical load: largest swing from the flight's normal reading (works whether the log stores 1 g or 0 g as level).
  const g = col(airborne, COLS.normac);
  const gMed = median(g);
  const gPeak = g.length >= 30 ? Math.max(...g.map((v) => Math.abs(v - gMed))) : null;

  const levelRpm = mean(col(level, COLS.rpm));
  const levelIas = mean(col(level, COLS.ias));

  const f = {
    cruise_samples: cruise.length,
    duration_min: round((rows.length * secondsPerSample) / 60, 1),
    oat_mean: has(cruise, COLS.oat) ? round(mean(col(cruise, COLS.oat)), 1) : null,
    rpm_mean: round(rpm, 0),
    rpm_rough: round(roughness(col(cruise, COLS.rpm), secondsPerSample)),
    ff_mean: round(ff),
    ff_per_krpm: rpm && ff ? round((ff / rpm) * 1000, 3) : null,
    oilp_mean: has(cruise, COLS.oilp) ? round(mean(col(cruise, COLS.oilp))) : null,
    oilp_rough: has(cruise, COLS.oilp, 30) ? round(roughness(col(cruise, COLS.oilp), secondsPerSample)) : null,
    oilt_mean: has(cruise, COLS.oilt) ? round(mean(col(cruise, COLS.oilt))) : null,
    volt_mean: has(cruise, COLS.volt1) ? round(mean(col(cruise, COLS.volt1))) : null,
    volt2_mean: has(cruise, COLS.volt2) ? round(mean(col(cruise, COLS.volt2))) : null,
    amp1_mean: has(cruise, COLS.amp1) ? round(mean(col(cruise, COLS.amp1))) : null,
    amp2_mean: has(cruise, COLS.amp2) ? round(mean(col(cruise, COLS.amp2))) : null,
    cht_spread: okCht.length >= 2 ? round(Math.max(...okCht) - Math.min(...okCht), 1) : null,
    egt_spread: okEgt.length >= 2 ? round(Math.max(...okEgt) - Math.min(...okEgt), 1) : null,
    cht_peak: allCht.length >= 10 ? round(Math.max(...allCht), 1) : null,
    fuel_burn_ratio: round(fuelRatio, 3),
    fuel_imbalance: imb.length >= 10 ? round(mean(imb), 2) : null,
    ias_per_krpm: level.length >= 30 && levelRpm ? round((levelIas / levelRpm) * 1000, 2) : null,
    climb_fpm: climb.length >= 15 ? round(mean(col(climb, COLS.vspd)), 0) : null,
    g_peak: round(meta.g_peak ?? gPeak, 3),
  };
  CYLS.forEach((c, i) => {
    f[`cht${c}_dev`] = cht[i] !== null && chtAvg !== null ? round(cht[i] - chtAvg, 1) : null;
    f[`egt${c}_dev`] = egt[i] !== null && egtAvg !== null ? round(egt[i] - egtAvg, 1) : null;
    f[`egt${c}_rough`] = round(roughness(col(cruise, COLS.egt[i]), secondsPerSample));
  });
  return f;
}

// ---------- Checks ----------
// dir: "high" = only too-high is bad, "low" = only too-low is bad, "both" = either.
// mode: "trend" (default) = median of recent flights; "event" = worst recent flight (one hard landing matters).
// oat: true = reading is corrected for outside air temperature before comparing.

export const GROUPS = ["Cylinders and valves", "Combustion", "Oil system", "Electrical", "Fuel system", "Performance", "Structure"];

export const CHECKS = [
  { key: "cht_spread", label: "CHT spread across cylinders", unit: "°F", dir: "high", system: "cylinders", group: "Cylinders and valves" },
  ...CYLS.map((c) => ({ key: `cht${c}_dev`, label: `Cylinder ${c} CHT vs engine average`, unit: "°F", dir: "both", system: "cylinders", group: "Cylinders and valves", cyl: c })),
  { key: "cht_peak", label: "Hottest cylinder head temperature", unit: "°F", dir: "high", system: "cylinders", group: "Cylinders and valves", oat: true },
  ...CYLS.map((c) => ({ key: `egt${c}_rough`, label: `Cylinder ${c} EGT oscillation`, unit: "°F", dir: "high", system: "valves", group: "Cylinders and valves", cyl: c })),
  { key: "egt_spread", label: "EGT spread across cylinders", unit: "°F", dir: "high", system: "fuel/ignition", group: "Combustion" },
  ...CYLS.map((c) => ({ key: `egt${c}_dev`, label: `Cylinder ${c} EGT vs engine average`, unit: "°F", dir: "both", system: "fuel/ignition", group: "Combustion", cyl: c })),
  { key: "ff_per_krpm", label: "Fuel flow per 1000 RPM", unit: "gph", dir: "both", system: "fuel/induction", group: "Combustion" },
  { key: "rpm_rough", label: "RPM roughness", unit: "rpm", dir: "high", system: "ignition", group: "Combustion" },
  { key: "oilp_mean", label: "Oil pressure in cruise", unit: "psi", dir: "low", system: "oil", group: "Oil system" },
  { key: "oilp_rough", label: "Oil pressure fluctuation", unit: "psi", dir: "high", system: "oil", group: "Oil system" },
  { key: "oilt_mean", label: "Oil temperature in cruise", unit: "°F", dir: "high", system: "oil", group: "Oil system", oat: true },
  { key: "volt_mean", label: "Main bus voltage", unit: "V", dir: "low", system: "electrical", group: "Electrical" },
  { key: "amp1_mean", label: "Main charging current", unit: "A", dir: "both", system: "electrical", group: "Electrical" },
  { key: "volt2_mean", label: "Second bus voltage", unit: "V", dir: "low", system: "electrical", group: "Electrical" },
  { key: "amp2_mean", label: "Second charging current", unit: "A", dir: "both", system: "electrical", group: "Electrical" },
  { key: "fuel_burn_ratio", label: "Fuel used by tank gauges vs fuel flow reading", unit: "×", dir: "both", system: "fuel system", group: "Fuel system" },
  { key: "fuel_imbalance", label: "Left/right tank imbalance", unit: "gal", dir: "high", system: "fuel system", group: "Fuel system" },
  { key: "ias_per_krpm", label: "Cruise speed for the power set", unit: "kt per 1000 rpm", dir: "low", system: "performance", group: "Performance" },
  { key: "climb_fpm", label: "Climb rate at full power", unit: "fpm", dir: "low", system: "performance", group: "Performance" },
  { key: "g_peak", label: "Peak vertical load", unit: "g", dir: "high", system: "structure", group: "Structure", mode: "event" },
];

export const CHECK_BY_KEY = Object.fromEntries(CHECKS.map((c) => [c.key, c]));

// What engine-monitor logs can't tell you. Listed so nobody assumes Squawk covers it.
export const NOT_COVERED = ["Propeller", "Flight controls and rigging", "Landing gear, brakes and tires", "Avionics and instruments", "Corrosion and airframe condition", "Required inspections and airworthiness directives"];

// ---------- Outside air temperature adjustment ----------
// Learns, from the fleet's own flights, how much each temperature reading moves per degree of
// outside air temperature (least-squares slope). Only used when the link is clear in the data (|r| ≥ 0.3, n ≥ 15).

export function oatModel(featuresList) {
  const oats = featuresList.map((f) => f.oat_mean).filter((v) => v !== null && v !== undefined);
  const model = { ref: median(oats), slopes: {} };
  for (const chk of CHECKS.filter((c) => c.oat)) {
    const pairs = featuresList.filter((f) => f.oat_mean !== null && f.oat_mean !== undefined && f[chk.key] !== null && f[chk.key] !== undefined).map((f) => [f.oat_mean, f[chk.key]]);
    if (pairs.length < 15) { model.slopes[chk.key] = { slope: 0, r: null, n: pairs.length, used: false }; continue; }
    const mx = mean(pairs.map((p) => p[0])), my = mean(pairs.map((p) => p[1]));
    let sxy = 0, sxx = 0, syy = 0;
    for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
    const slope = sxx ? sxy / sxx : 0;
    const r = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
    const used = Math.abs(r) >= 0.3;
    model.slopes[chk.key] = { slope: round(used ? slope : 0, 3), r: round(r, 2), n: pairs.length, used };
  }
  return model;
}

export function oatAdjust(features, model) {
  if (!model || model.ref === null) return features;
  const out = { ...features };
  for (const [key, s] of Object.entries(model.slopes)) {
    if (!s.used || out[key] === null || out[key] === undefined || out.oat_mean === null || out.oat_mean === undefined) continue;
    out[key] = round(out[key] - s.slope * (out.oat_mean - model.ref), 1);
  }
  return out;
}

// ---------- Fleet baseline (robust: median + MAD) ----------

export function fleetBaseline(allFeatures) {
  const base = {};
  for (const chk of CHECKS) {
    const vals = allFeatures.map((f) => f[chk.key]).filter((v) => v !== null && v !== undefined);
    const med = median(vals);
    const mad = median(vals.map((v) => Math.abs(v - med)));
    // 1.4826 * MAD ~ std for normal data; floor avoids divide-by-tiny on very consistent signals.
    const scale = Math.max((mad ?? 0) * 1.4826, minScale(chk.key));
    base[chk.key] = { median: med, scale, n: vals.length };
  }
  return base;
}

function minScale(key) {
  const fixed = { oilp_mean: 1.5, oilp_rough: 0.3, oilt_mean: 3, ff_per_krpm: 0.05, volt_mean: 0.15, volt2_mean: 0.15, amp1_mean: 0.5, amp2_mean: 0.5,
    cht_peak: 5, fuel_burn_ratio: 0.05, fuel_imbalance: 1, ias_per_krpm: 0.5, climb_fpm: 40, g_peak: 0.05 };
  if (key in fixed) return fixed[key];
  if (key.includes("rough")) return 0.5;
  if (key.includes("dev") || key.includes("spread")) return 4;
  return 1;
}

// Signed "badness" z-score: positive means worse in the direction that matters.
function badZ(chk, value, base) {
  if (value === null || value === undefined || base.median === null) return null;
  const z = (value - base.median) / base.scale;
  if (chk.dir === "high") return z;
  if (chk.dir === "low") return -z;
  return Math.abs(z);
}

// ---------- Trend forecast ----------
// Straight-line fit through the last TREND_WINDOW flights. Only reports a forecast when the line fits well
// (R² ≥ 0.5) and is heading toward the threshold. It's "if the current trend continues", not a promise.

export const TREND_WINDOW = 8;
const TREND_MIN = 5, TREND_R2 = 0.5, TREND_MAX_FLIGHTS = 30;

export function trendFor(chk, flights, base) {
  const vals = flights.map((f) => f.features[chk.key]).filter((v) => v !== null && v !== undefined).slice(-TREND_WINDOW);
  const b = base[chk.key];
  if (vals.length < TREND_MIN || !b || b.median === null) return null;
  const n = vals.length, xs = vals.map((_, i) => i);
  const mx = mean(xs), my = mean(vals);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (vals[i] - my); sxx += (xs[i] - mx) ** 2; syy += (vals[i] - my) ** 2; }
  const slope = sxx ? sxy / sxx : 0;
  const r2 = sxx && syy ? (sxy * sxy) / (sxx * syy) : 0;
  const fitLast = my + slope * (n - 1 - mx);
  let side = chk.dir === "high" ? 1 : chk.dir === "low" ? -1 : Math.sign(fitLast - b.median) || Math.sign(slope) || 1;
  const caution = b.median + side * 2.25 * b.scale, limit = b.median + side * 3.5 * b.scale;
  const toward = slope * side > 0;
  const steps = (target) => {
    if ((fitLast - target) * side >= 0) return 0; // already past it
    if (!toward || r2 < TREND_R2) return null;
    const k = Math.ceil((target - fitLast) / slope);
    return k > TREND_MAX_FLIGHTS ? null : k;
  };
  return {
    slope: round(slope, 3),
    fit_last: round(fitLast, 2),
    r2: round(r2, 2),
    n,
    side,
    direction: Math.abs(slope) < 1e-9 ? "flat" : toward ? "worse" : "better",
    to_caution: steps(caution),
    to_limit: steps(limit),
    limit_value: round(limit, 2),
    caution_value: round(caution, 2),
  };
}

// ---------- Aircraft assessment ----------

export const THRESHOLDS = { red: 3.5, yellow: 2.25 };
const RECENT = 5;

// flights: [{seq, features}] sorted by seq, excluding "future" flights. Features should already be OAT-adjusted.
export function assessAircraft(flights, base) {
  if (!flights.length) return { status: "unknown", score: 0, findings: [], early: [], all: [] };
  const recent = flights.slice(-RECENT);
  const early = flights.slice(0, Math.min(RECENT, Math.max(1, flights.length - RECENT)));

  const all = [];
  for (const chk of CHECKS) {
    const zs = recent.map((f) => badZ(chk, f.features[chk.key], base[chk.key])).filter((z) => z !== null);
    if (zs.length < 2) {
      all.push({ key: chk.key, label: chk.label, group: chk.group, recorded: false });
      continue;
    }
    // Trend checks use the median of recent flights so one noisy flight can't trigger an alert.
    // Event checks (hard landing) use the worst recent flight, because one event is what matters.
    const zRecent = chk.mode === "event" ? Math.max(...zs) : median(zs);
    const recentVals = recent.map((f) => f.features[chk.key]).filter((v) => v !== null);
    const earlyVals = early.map((f) => f.features[chk.key]).filter((v) => v !== null);
    const recentMean = chk.mode === "event" ? Math.max(...recentVals) : mean(recentVals);
    const earlyMean = earlyVals.length ? mean(earlyVals) : null;
    const persist = zs.filter((z) => z >= THRESHOLDS.yellow).length / zs.length;
    all.push({
      key: chk.key,
      label: chk.label,
      system: chk.system,
      group: chk.group,
      mode: chk.mode || "trend",
      cyl: chk.cyl ?? null,
      unit: chk.unit,
      recorded: true,
      z: round(zRecent),
      level: zRecent >= THRESHOLDS.red ? "red" : zRecent >= THRESHOLDS.yellow ? "yellow" : "green",
      persistence: round(persist),
      recent_value: round(recentMean),
      fleet_typical: round(base[chk.key].median),
      early_value: earlyMean === null ? null : round(earlyMean),
      change: earlyMean === null ? null : round(recentMean - earlyMean),
      flights_considered: zs.length,
      trend: chk.mode === "event" ? null : trendFor(chk, flights, base),
    });
  }
  const scored = all.filter((f) => f.recorded).sort((a, b) => b.z - a.z);
  const findings = scored.filter((f) => f.z >= THRESHOLDS.yellow);
  // Early warnings: still normal, but a well-fitting trend reaches caution within 10 flights.
  // "Cylinder N vs engine average" readings move together: if one cylinder is flagged, the others shift by
  // construction (the average moved). Don't report those echoes as separate early warnings.
  const flaggedDevKinds = new Set(findings.filter((f) => /^(cht|egt)\d_dev$/.test(f.key)).map((f) => f.key.slice(0, 3)));
  const earlyWarn = scored
    .filter((f) => !(/^(cht|egt)\d_dev$/.test(f.key) && flaggedDevKinds.has(f.key.slice(0, 3))))
    .filter((f) => f.z < THRESHOLDS.yellow && f.trend && f.trend.to_caution !== null && f.trend.to_caution > 0 && f.trend.to_caution <= 10)
    .sort((a, b) => a.trend.to_caution - b.trend.to_caution);
  const score = scored.length ? Math.max(0, scored[0].z) : 0;
  const status = score >= THRESHOLDS.red ? "red" : score >= THRESHOLDS.yellow ? "yellow" : "green";
  return { status, score: round(score), findings: findings.slice(0, 6), early: earlyWarn.slice(0, 4), all };
}

export function describeFinding(f) {
  const dirWord = f.z > 0 && CHECK_BY_KEY[f.key]?.dir === "low" ? "below" : "above";
  const trend = f.change === null ? "" : `, ${f.change >= 0 ? "up" : "down"} ${Math.abs(f.change)} ${f.unit} vs this aircraft's earlier flights`;
  const fc = f.trend && f.trend.to_limit > 0 ? ` If the current trend continues it reaches the limit in about ${f.trend.to_limit} flights.` : "";
  const ev = f.mode === "event" ? " (worst single recent flight)" : ` over the last ${f.flights_considered} flights`;
  return `${f.label}: ${f.recent_value} ${f.unit} (fleet typical ${f.fleet_typical} ${f.unit}), ${f.z}σ ${dirWord} normal${ev}${trend}.${fc}`;
}

// ---------- Fleet scoring (shared by the Worker and the seed builder) ----------
// planes: [{ id, flights: [{ seq, features (raw), is_future }] }]
export function scoreFleet(planes) {
  const currentRaw = planes.flatMap((p) => p.flights.filter((f) => !f.is_future).map((f) => f.features));
  const oat = oatModel(currentRaw);
  for (const p of planes) for (const f of p.flights) { f.raw = f.features; f.features = oatAdjust(f.features, oat); }
  const base = fleetBaseline(planes.flatMap((p) => p.flights.filter((f) => !f.is_future).map((f) => f.features)));
  const results = {};
  for (const p of planes) results[p.id] = assessAircraft(p.flights.filter((f) => !f.is_future), base);
  return { oat, base, results };
}

// ---------- Status history (for the timeline + replay) ----------
// Re-runs the exact same check after each flight, using only the data that existed at that point:
// this aircraft's flights so far + the other aircraft's flights (raw, re-adjusted each step).
export const MIN_FLIGHTS = 3;

export function statusHistory(ownRaw, otherRaw) {
  const out = [];
  for (let k = 1; k <= ownRaw.length; k++) {
    if (k < MIN_FLIGHTS) {
      out.push({ seq: ownRaw[k - 1].seq, status: "learning", score: 0, top: null });
      continue;
    }
    const prefix = ownRaw.slice(0, k);
    const oat = oatModel([...otherRaw, ...prefix.map((f) => f.features)]);
    const adjOthers = otherRaw.map((f) => oatAdjust(f, oat));
    const adjPrefix = prefix.map((f) => ({ seq: f.seq, features: oatAdjust(f.features, oat) }));
    const base = fleetBaseline([...adjOthers, ...adjPrefix.map((f) => f.features)]);
    const as = assessAircraft(adjPrefix, base);
    const t = as.findings[0];
    // What Squawk would have forecast at this point (top finding, or the leading early warning).
    const fsrc = (t && t.trend) ? t : as.early[0];
    const forecast = fsrc && fsrc.trend ? { key: fsrc.key, label: fsrc.label, ...fsrc.trend } : null;
    out.push({ seq: ownRaw[k - 1].seq, status: as.status, score: as.score, top: t ? { key: t.key, label: t.label, z: t.z } : null, forecast });
  }
  return out;
}

// ---------- Fleet-history prediction ("what did similar planes do next?") ----------
// For one reading: take this plane's last PRED_WINDOW flights, then search every other plane's history (and this
// plane's own earlier flights) for stretches of the same length that look similar: same level and same shape,
// measured in units of the fleet's normal variation. The best match per plane is kept, and what happened over its
// next flights is applied to this plane's latest value. Nothing is shown unless at least PRED_MIN_MATCHES stretches
// are close enough (average distance ≤ PRED_MAX_DIST σ).
export const PRED_WINDOW = 4, PRED_HORIZON = 6, PRED_MIN_MATCHES = 3, PRED_MAX_DIST = 1.5;

const seqVals = (flights, key) => flights.map((f) => ({ seq: f.seq, v: f.features[key] })).filter((x) => x.v !== null && x.v !== undefined);

export function fleetPrecedent(chk, ownFlights, others, base) {
  const b = base[chk.key];
  const own = seqVals(ownFlights, chk.key);
  if (!b || b.median === null || own.length < PRED_WINDOW) return null;
  const target = own.slice(-PRED_WINDOW).map((x) => x.v);
  const last = target[target.length - 1];
  // candidate sources: other planes + this plane's own earlier flights (not overlapping the current window)
  const sources = [...others.map((o) => ({ id: o.id, vals: seqVals(o.flights, chk.key), self: false })),
    { id: "self", vals: own.slice(0, own.length - PRED_WINDOW), self: true }];
  const matches = [];
  for (const src of sources) {
    let best = null;
    for (let j = PRED_WINDOW - 1; j < src.vals.length - 1; j++) {
      const win = src.vals.slice(j - PRED_WINDOW + 1, j + 1).map((x) => x.v);
      const dist = win.reduce((s, v, i) => s + Math.abs(v - target[i]), 0) / PRED_WINDOW / b.scale;
      if (dist <= PRED_MAX_DIST && (!best || dist < best.dist)) {
        const next = [];
        for (let h = 1; h <= PRED_HORIZON && j + h < src.vals.length; h++) next.push(src.vals[j + h].v - src.vals[j].v);
        best = { id: src.id, self: src.self, end_seq: src.vals[j].seq, dist: round(dist, 2), next };
      }
    }
    if (best) matches.push(best);
  }
  matches.sort((a, b2) => a.dist - b2.dist);
  const used = matches.slice(0, 6);
  if (used.length < PRED_MIN_MATCHES) return { matches: used.length, path: [] };
  const path = [];
  for (let h = 1; h <= PRED_HORIZON; h++) {
    const vals = used.filter((m) => m.next.length >= h).map((m) => last + m.next[h - 1]).sort((a, b2) => a - b2);
    if (vals.length < PRED_MIN_MATCHES) break;
    const q = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))];
    path.push({ h, median: round(median(vals), 2), lo: round(q(0.1), 2), hi: round(q(0.9), 2), n: vals.length });
  }
  return {
    matches: used.length,
    planes: new Set(used.filter((m) => !m.self).map((m) => m.id)).size,
    self_matches: used.filter((m) => m.self).length,
    sources: used.map((m) => ({ aircraft: m.self ? null : m.id, self: m.self, end_seq: m.end_seq, dist: m.dist })),
    path,
  };
}

// Both predictions for every recorded reading of one aircraft.
export function predictionsFor(ownFlights, others, base, assessed) {
  const out = {};
  for (const c of assessed.all) {
    if (!c.recorded || c.mode === "event") continue;
    const chk = CHECK_BY_KEY[c.key];
    out[c.key] = { trend: c.trend || null, precedent: fleetPrecedent(chk, ownFlights, others, base) };
  }
  return out;
}
