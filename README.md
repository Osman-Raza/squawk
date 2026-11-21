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
- Aircraft get anonymized IDs (`SQK-01`, ...). Say this honestly if judges ask.

## 3. Demo flow (60 seconds)
1. Fleet view: 3 red, 7 green, ranked by risk.
2. Click the top red aircraft: the finding list plus the trend chart climbing out of the green "fleet normal" band.
3. Click **Generate diagnosis + work order** (Workers AI writes it in a few seconds).
4. Tick **Show what actually happened next**: the REPAIR line appears with the real maintenance label from NGAFID, and the readings drop back to normal after it.
5. Optional: upload `samples/example_flight_ngafid_format.csv` to show a new log being parsed and scored live.

Before the pitch: generate the work orders once so they're cached, in case the Wi-Fi is bad.

## How detection works
- **Per flight** (`computeFeatures`): cruise-only averages of CHT/EGT per cylinder, each cylinder's deviation from the engine average, EGT oscillation (sticking valve signature), oil pressure/temperature, fuel flow per 1000 RPM, RPM roughness, bus voltage.
- **Fleet baseline:** median + MAD of each feature across every current flight in the fleet (robust to the bad flights).
- **Aircraft risk:** for each check, the median z-score of the last 5 flights in the direction that matters (low oil pressure is bad, high is not). One noisy flight can't trigger an alert. ≥2.25σ = Watch, ≥3.5σ = Action needed.
- **AI:** findings + matching known patterns → Llama 3.3 70B → structured JSON (title, summary, causes, actions, parts, urgency). If the model fails or returns junk, the rule-based diagnosis from `knowledge.js` is used and the UI says so.

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
