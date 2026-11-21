// Squawk detection engine.
// Pure JS, no Cloudflare APIs, so the Worker and the Node seed builder share it.
// Input format: Garmin G1000 / NGAFID style columns ("E1 CHT1", "E1 EGT1", "E1 OilP", ...).

export const CYLS = [1, 2, 3, 4];

const COLS = {
  rpm: "E1 RPM",
  ff: "E1 FFlow",
  oilp: "E1 OilP",
  oilt: "E1 OilT",
  volt: "volt1",
  amp: "amp1",
  ias: "IAS",
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
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  if (!lines.length) throw new Error("Empty CSV");
  let headerIdx = lines.findIndex((l) => l.includes("E1 RPM") || l.includes("E1 EGT1"));
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
  return { header, rows, sampleStep: step * secondsPerRow, totalRows: body.length };
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

// ---------- Per-flight features ----------

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const std = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const col = (rows, key) => rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
const round = (x, d = 2) => (x === null || x === undefined ? null : Math.round(x * 10 ** d) / 10 ** d);

// Roughness: mean absolute change between samples, scaled to "per 10 seconds"
// so it's comparable across different sampling steps. A sticking exhaust valve shows up as EGT oscillation.
function roughness(values, secondsPerSample) {
  if (values.length < 3) return null;
  let s = 0;
  for (let i = 1; i < values.length; i++) s += Math.abs(values[i] - values[i - 1]);
  return (s / (values.length - 1)) * Math.sqrt(10 / Math.max(1, secondsPerSample));
}

export function computeFeatures(rows, secondsPerSample = 1) {
  // Cruise filter: engine at power and aircraft flying. Falls back to all rows on short/odd flights.
  let cruise = rows.filter((r) => (r[COLS.rpm] ?? 0) >= 2000 && (r[COLS.ias] ?? 0) >= 60);
  if (cruise.length < 30) cruise = rows.filter((r) => (r[COLS.rpm] ?? 0) >= 1500);
  if (cruise.length < 10) cruise = rows;

  const cht = COLS.cht.map((k) => mean(col(cruise, k)));
  const egt = COLS.egt.map((k) => mean(col(cruise, k)));
  const okCht = cht.filter((v) => v !== null);
  const okEgt = egt.filter((v) => v !== null);
  const chtAvg = mean(okCht);
  const egtAvg = mean(okEgt);
  const rpm = mean(col(cruise, COLS.rpm));
  const ff = mean(col(cruise, COLS.ff));

  const f = {
    cruise_samples: cruise.length,
    duration_min: round((rows.length * secondsPerSample) / 60, 1),
    rpm_mean: round(rpm, 0),
    rpm_rough: round(roughness(col(cruise, COLS.rpm), secondsPerSample)),
    ff_mean: round(ff),
    ff_per_krpm: rpm && ff ? round((ff / rpm) * 1000, 3) : null,
    oilp_mean: round(mean(col(cruise, COLS.oilp))),
    oilt_mean: round(mean(col(cruise, COLS.oilt))),
    volt_mean: round(mean(col(cruise, COLS.volt))),
    oat_mean: round(mean(col(cruise, COLS.oat)), 1),
    cht_spread: okCht.length >= 2 ? round(Math.max(...okCht) - Math.min(...okCht), 1) : null,
    egt_spread: okEgt.length >= 2 ? round(Math.max(...okEgt) - Math.min(...okEgt), 1) : null,
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

export const CHECKS = [
  { key: "cht_spread", label: "CHT spread across cylinders", unit: "°F", dir: "high", system: "cylinders" },
  { key: "egt_spread", label: "EGT spread across cylinders", unit: "°F", dir: "high", system: "fuel/ignition" },
  ...CYLS.map((c) => ({ key: `cht${c}_dev`, label: `Cylinder ${c} CHT vs engine average`, unit: "°F", dir: "both", system: "cylinders", cyl: c })),
  ...CYLS.map((c) => ({ key: `egt${c}_dev`, label: `Cylinder ${c} EGT vs engine average`, unit: "°F", dir: "both", system: "fuel/ignition", cyl: c })),
  ...CYLS.map((c) => ({ key: `egt${c}_rough`, label: `Cylinder ${c} EGT oscillation`, unit: "°F", dir: "high", system: "valves", cyl: c })),
  { key: "oilp_mean", label: "Oil pressure in cruise", unit: "psi", dir: "low", system: "oil" },
  { key: "oilt_mean", label: "Oil temperature in cruise", unit: "°F", dir: "high", system: "oil" },
  { key: "ff_per_krpm", label: "Fuel flow per 1000 RPM", unit: "gph", dir: "both", system: "fuel/induction" },
  { key: "rpm_rough", label: "RPM roughness", unit: "rpm", dir: "high", system: "ignition" },
  { key: "volt_mean", label: "Bus voltage", unit: "V", dir: "low", system: "electrical" },
];

export const CHECK_BY_KEY = Object.fromEntries(CHECKS.map((c) => [c.key, c]));

// ---------- Fleet baseline (robust: median + MAD) ----------

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

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
  if (key.includes("rough")) return 0.5;
  if (key.includes("dev") || key.includes("spread")) return 4;
  if (key === "oilp_mean") return 1.5;
  if (key === "oilt_mean") return 3;
  if (key === "ff_per_krpm") return 0.05;
  if (key === "volt_mean") return 0.15;
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

// ---------- Aircraft assessment ----------

export const THRESHOLDS = { red: 3.5, yellow: 2.25 };
const RECENT = 5;

// flights: [{seq, features}] sorted by seq, excluding "future" flights.
export function assessAircraft(flights, base) {
  if (!flights.length) return { status: "unknown", score: 0, findings: [] };
  const recent = flights.slice(-RECENT);
  const early = flights.slice(0, Math.min(RECENT, Math.max(1, flights.length - RECENT)));

  const findings = [];
  for (const chk of CHECKS) {
    const zs = recent.map((f) => badZ(chk, f.features[chk.key], base[chk.key])).filter((z) => z !== null);
    if (zs.length < 2) continue;
    // Use the median of recent flights so one noisy flight can't trigger an alert.
    const zRecent = median(zs);
    const recentVals = recent.map((f) => f.features[chk.key]).filter((v) => v !== null);
    const earlyVals = early.map((f) => f.features[chk.key]).filter((v) => v !== null);
    const recentMean = mean(recentVals);
    const earlyMean = earlyVals.length ? mean(earlyVals) : null;
    const persist = zs.filter((z) => z >= THRESHOLDS.yellow).length / zs.length;
    findings.push({
      key: chk.key,
      label: chk.label,
      system: chk.system,
      cyl: chk.cyl ?? null,
      unit: chk.unit,
      z: round(zRecent),
      persistence: round(persist),
      recent_value: round(recentMean),
      fleet_typical: round(base[chk.key].median),
      early_value: earlyMean === null ? null : round(earlyMean),
      change: earlyMean === null ? null : round(recentMean - earlyMean),
      flights_considered: zs.length,
    });
  }
  findings.sort((a, b) => b.z - a.z);
  const flagged = findings.filter((f) => f.z >= THRESHOLDS.yellow);
  const score = findings.length ? findings[0].z : 0;
  const status = score >= THRESHOLDS.red ? "red" : score >= THRESHOLDS.yellow ? "yellow" : "green";
  return { status, score: round(Math.max(0, score)), findings: flagged.slice(0, 5), all: findings };
}

export function describeFinding(f) {
  const dirWord = f.z > 0 && CHECK_BY_KEY[f.key]?.dir === "low" ? "below" : "above";
  const trend = f.change === null ? "" : `, ${f.change >= 0 ? "up" : "down"} ${Math.abs(f.change)} ${f.unit} vs this aircraft's earlier flights`;
  return `${f.label}: ${f.recent_value} ${f.unit} (fleet typical ${f.fleet_typical} ${f.unit}), ${f.z}σ ${dirWord} normal over the last ${f.flights_considered} flights${trend}.`;
}
