# Squawk: OBD2 for aircraft fleets

Squawk reads the engine data aircraft already record on every flight, flags aircraft that are drifting away from normal, and uses Workers AI to write the diagnosis and work order for the mechanic.

Everything runs on Cloudflare: **Workers** (API + detection engine), **Workers Assets** (dashboard), **D1** (fleet database), **Workers AI** (Llama 3.3 70B diagnosis), **R2** (optional raw log storage).

```
public/              dashboard (vanilla JS, no build step; engine-gauge design, B612 + Public Sans)
src/index.js         Worker: API routes
src/engine.js        detection engine: CSV parsing, per-flight features, fleet baseline, risk scoring
src/knowledge.js     known failure patterns (grounds the AI + fallback when AI is unavailable)
src/ai.js            Workers AI diagnosis + work order
schema.sql           D1 tables
scripts/extract_ngafid.py   pulls a demo fleet out of the real NGAFID dataset
scripts/build_seed.mjs      scores it with the same engine and writes seed/seed.sql
scripts/make_sample_ngafid.py  synthetic data in NGAFID format (testing only)
seed/sample_seed.sql  SYNTHETIC sample fleet so you can deploy right away
samples/             example flight CSVs for the upload button
```

---

## 1. Deploy (15 min)

```bash
npm install
npx wrangler login
npx wrangler d1 create squawk-db
```
Copy the `database_id` it prints into `wrangler.jsonc` (replace `REPLACE_WITH_YOUR_D1_ID`).

```bash
npm run db:schema                     # create tables
npx wrangler d1 execute squawk-db --remote --file=seed/sample_seed.sql   # synthetic fleet, to check it works
npm run deploy                        # prints your live URL: https://squawk.<you>.workers.dev
```

Local dev: `npx wrangler dev` (Workers AI always calls Cloudflare, so stay logged in).

Optional R2: `npx wrangler r2 bucket create squawk-logs`, then uncomment the `r2_buckets` block in `wrangler.jsonc` and redeploy. Uploaded logs get stored there.

## 2. Load the REAL NGAFID data (do this before the hackathon)

1. Download `all_flights.tar.gz` (~4.3 GB) from https://doi.org/10.5281/zenodo.6624956 (or Kaggle: `hooong/aviation-maintenance-dataset-from-the-ngafid`).
2. Extract it: `tar -xzf all_flights.tar.gz` (gives `all_flights/flight_header.csv` and `all_flights/one_parq/`).
3. Run:
```bash
pip install pandas pyarrow
python scripts/extract_ngafid.py --data /path/to/all_flights --out data/ngafid
node scripts/build_seed.mjs data/ngafid --keep 3
npm run db:schema && npm run db:seed
```

`build_seed` prints a table of every aircraft, its status and the real repair it went in for. It keeps the 3 repair cases with the strongest real signal (`--keep N` to change). If nothing goes red, try `--candidates 25` on the extract step to search more repair events, or pick different cases.

### How the NGAFID data becomes a "fleet"
The dataset doesn't publish tail numbers. It's organized around ~2,100 real unplanned maintenance events, with each flight labeled by how many days before/after the repair it happened.
- **Repair-case aircraft:** the real flights *before* a repair are its history. The flights *after* the repair are hidden and only shown with the "Show what actually happened next" toggle.
- **Healthy aircraft:** real flights *after* a completed repair.
- Aircraft get fictional Canadian-format registrations (`C-GKWA`, `C-FTRX`, ...), and the dashboard labels them as fictional. Say this honestly if judges ask.

## 3. Demo flow (60 seconds)
1. Fleet view: 3 red, 7 green, ranked by risk.
2. Click the top red aircraft: the finding list plus the trend chart climbing out of the green "fleet normal" band.
3. Click **Generate diagnosis + work order** (Workers AI writes it in a few seconds).
4. Tick **Show what actually happened next**: the REPAIR line appears with the real maintenance label from NGAFID, and the readings drop back to normal after it.
5. Optional: upload `samples/example_flight_ngafid_format.csv` to show a new log being parsed and scored live.

Before the pitch: generate the work orders once so they're cached, in case the Wi-Fi is bad.

## How detection works
- **Per flight** (`computeFeatures`): up to 29 readings across 7 systems, using only channels the log records. Cylinders and valves (CHT per cylinder vs average, peak CHT, EGT oscillation), combustion (EGT spread and per-cylinder deviation, fuel flow per 1000 RPM, RPM roughness), oil (pressure, pressure fluctuation, temperature), electrical (both buses' voltage and current), fuel system (tank-gauge burn vs fuel flow reading, left/right imbalance), performance (cruise speed for the power set, full-power climb rate) and structure (peak vertical load). A channel that's missing or empty is reported as "not recorded", never estimated.
- **Outside air temperature:** the fleet's own data is used to learn how much peak CHT and oil temperature rise per °C outside (least-squares slope). The correction is only applied when the link is clear (|r| ≥ 0.3, at least 15 flights).
- **Fleet baseline:** median + MAD of each reading across every current flight in the fleet (robust to the bad flights).
- **Aircraft risk:** for each check, the median z-score of the last 5 flights in the direction that matters (low oil pressure is bad, high is not). One noisy flight can't trigger an alert. Peak vertical load uses the worst recent flight instead, because one hard landing is what matters. ≥2.25σ = Watch, ≥3.5σ = Needs attention.
- **Forecast:** a straight-line fit through each reading's last 8 flights. A forecast ("reaches the limit in about N flights") only appears when the fit is good (R² ≥ 0.5), it's heading toward the threshold, and the threshold is within 30 flights. Readings still in the normal range that will hit caution within 10 flights show up as early warnings.
- **Prediction in the chart:** past the last real flight, the chart shows a "Predicted" zone with two forecasts. *Fleet history* (shaded band): Squawk takes this plane's last 4 flights for that reading, finds the most similar 4-flight stretches in other planes' histories (and this plane's own earlier flights), within 1.5σ, at most one per plane, and applies what happened over their next 6 flights. It needs at least 3 matches or it says so instead of guessing. *Own trend* (dotted): the straight-line fit described above. If a plane is normal but predicted to hit a limit, its page opens on that reading and the verdict says so.
- **History:** the status strip and replay rerun the exact same check after each flight, using only the data that existed at that point.
- **AI:** findings, early warnings and matching known patterns go to Llama 3.3 70B, which writes a structured work order. It's told not to invent readings or causes. If the model fails or returns junk, the rule-based diagnosis from `knowledge.js` is used and the UI says so.
- **Not covered:** engine-monitor logs say nothing about the propeller, flight controls, landing gear, avionics, corrosion or required inspections. The dashboard lists these so nobody assumes they're checked.

After pulling these changes, rebuild and reload the seed (`node scripts/build_seed.mjs data/ngafid` then `npm run db:schema && npm run db:seed`), because the new readings are computed when the seed is built.

Advisory only: a licensed mechanic makes the final call.

## API
| Method | Path | |
|---|---|---|
| GET | `/api/fleet` | all aircraft with status, score, top finding |
| GET | `/api/aircraft/:id` | findings, per-flight features, baseline, latest work order |
| POST | `/api/aircraft/:id/diagnose` | Workers AI diagnosis → new work order |
| POST | `/api/aircraft/:id/flights` | upload a flight CSV (multipart `file`, G1000 or NGAFID columns) |
| GET | `/api/work-orders` | all work orders |
| PATCH | `/api/work-orders/:id` | `{ "status": "open" | "in_progress" | "done" }` |
