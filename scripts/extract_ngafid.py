#!/usr/bin/env python3
"""
Extract a demo fleet from the NGAFID Aviation Maintenance Dataset.

Dataset: https://doi.org/10.5281/zenodo.6624956  (or Kaggle: hooong/aviation-maintenance-dataset-from-the-ngafid)
Download all_flights.tar.gz, extract it, then run:

    pip install pandas pyarrow
    python scripts/extract_ngafid.py --data /path/to/all_flights --out data/ngafid

What it does:
  * Reads flight_header.csv (one row per flight: before_after, date_diff, label, flight_length)
  * Groups flights into maintenance events (a run of flights around one recorded repair)
  * Picks "repair case" aircraft: real flights BEFORE an unplanned repair (+ a few after, hidden as "what happened next")
  * Picks "healthy" aircraft: real flights AFTER a repair (engine freshly fixed)
  * Pulls only those flights out of the 4 GB parquet set, downsamples, and writes small CSVs + manifest.json

Next step: node scripts/build_seed.mjs data/ngafid  ->  seed/seed.sql
"""
import argparse
import json
import os
import sys
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq

SENSORS = ["volt1", "volt2", "amp1", "amp2", "FQtyL", "FQtyR", "E1 FFlow", "E1 OilT", "E1 OilP", "E1 RPM",
           "E1 CHT1", "E1 CHT2", "E1 CHT3", "E1 CHT4", "E1 EGT1", "E1 EGT2", "E1 EGT3", "E1 EGT4",
           "OAT", "IAS", "VSpd", "NormAc", "AltMSL"]

# Engine-related maintenance labels are the most convincing demo cases.
ENGINE_KEYWORDS = ["valve", "cylinder", "gasket", "intake", "exhaust", "oil", "baffle", "spark", "plug", "magneto",
                   "ignition", "injector", "fuel", "cht", "egt", "compression", "engine", "alternator", "induction"]


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def group_events(h: pd.DataFrame) -> pd.DataFrame:
    """Assign an event id: new event when the label changes, or when date_diff jumps from after back to before."""
    h = h.sort_index().copy()
    event, prev_label, prev_dd = 0, None, None
    ids = []
    for _, r in h.iterrows():
        if prev_label is not None and (r["label"] != prev_label or (prev_dd is not None and prev_dd > 0 and r["date_diff"] < 0)):
            event += 1
        ids.append(event)
        prev_label, prev_dd = r["label"], r["date_diff"]
    h["event"] = ids
    return h


def engine_priority(label: str) -> int:
    l = str(label).lower()
    return 0 if any(k in l for k in ENGINE_KEYWORDS) else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="extracted all_flights folder (has flight_header.csv and one_parq/)")
    ap.add_argument("--out", default="data/ngafid")
    ap.add_argument("--candidates", type=int, default=12, help="repair cases to extract (build_seed keeps the strongest)")
    ap.add_argument("--healthy", type=int, default=7)
    ap.add_argument("--before", type=int, default=15, help="max flights before the repair per case")
    ap.add_argument("--after", type=int, default=4, help="flights after the repair to keep as 'what happened next'")
    ap.add_argument("--healthy-flights", type=int, default=15)
    ap.add_argument("--min-length", type=int, default=1800, help="min flight length in samples (~seconds)")
    ap.add_argument("--step", type=int, default=4, help="keep every Nth second (smaller CSVs)")
    args = ap.parse_args()

    data = Path(args.data)
    header_path = data / "flight_header.csv"
    parq_path = data / "one_parq"
    if not header_path.exists() or not parq_path.exists():
        sys.exit(f"Expected {header_path} and {parq_path}. Point --data at the extracted all_flights folder.")

    h = pd.read_csv(header_path, index_col="Master Index")
    log(f"Header: {len(h):,} flights, {h['label'].nunique()} maintenance labels")
    h = group_events(h)
    long = h[h["flight_length"] >= args.min_length]

    # ---- pick repair cases ----
    stats = []
    for ev, g in long.groupby("event"):
        before = g[g["date_diff"] < 0]
        after = g[g["date_diff"] > 0]
        stats.append({"event": ev, "label": g["label"].iloc[0], "n_before": len(before), "n_after": len(after)})
    st = pd.DataFrame(stats)
    st["prio"] = st["label"].map(engine_priority)

    cases = st[(st.n_before >= 6) & (st.n_after >= 1)].sort_values(["prio", "n_before"], ascending=[True, False])
    cases = cases.drop_duplicates("label").head(args.candidates)  # variety of failure types
    if cases.empty:
        sys.exit("No events with enough before-repair flights. Try --min-length 900.")

    used = set(cases.event)
    healthy = st[(~st.event.isin(used)) & (st.n_after >= max(6, args.healthy_flights // 2))].sort_values("n_after", ascending=False).head(args.healthy)

    aircraft, wanted = [], {}
    for i, c in enumerate(cases.itertuples(), 1):
        g = long[long.event == c.event]
        before = g[g.date_diff < 0].sort_values(["date_diff"]).tail(args.before)
        after = g[g.date_diff > 0].sort_values(["date_diff"]).head(args.after)
        flights = [(idx, r, False) for idx, r in before.iterrows()] + [(idx, r, True) for idx, r in after.iterrows()]
        aircraft.append({"key": f"case{i:02d}", "role": "repair-case", "label": c.label, "event": int(c.event), "flights": flights})
    for i, c in enumerate(healthy.itertuples(), 1):
        g = long[(long.event == c.event) & (long.date_diff > 0)].sort_values("date_diff").head(args.healthy_flights)
        aircraft.append({"key": f"healthy{i:02d}", "role": "healthy", "label": c.label, "event": int(c.event),
                         "flights": [(idx, r, False) for idx, r in g.iterrows()]})

    for a in aircraft:
        for idx, _, _ in a["flights"]:
            wanted[int(idx)] = True
    log(f"Selected {len(cases)} repair cases + {len(healthy)} healthy aircraft = {len(wanted)} flights. Scanning parquet...")

    # ---- pull just those flights from the parquet partitions ----
    out = Path(args.out)
    (out / "flights").mkdir(parents=True, exist_ok=True)
    found = {}
    files = sorted(p for p in parq_path.rglob("*.parquet"))
    for n, f in enumerate(files, 1):
        pf = pq.ParquetFile(f)
        cols = [c for c in pf.schema_arrow.names if c in SENSORS or c in ("timestep", "Master Index", "__index_level_0__")]
        df = pf.read(columns=cols).to_pandas()
        if "Master Index" in df.columns:
            df = df.set_index("Master Index")
        elif "__index_level_0__" in df.columns:
            df = df.set_index("__index_level_0__")
        hit = df[df.index.isin(wanted.keys())]
        for idx, g in hit.groupby(level=0):
            g = g.sort_values("timestep")
            # Peak vertical load is a 1-second event, so measure it on the full-resolution data before downsampling.
            meta = ""
            if "NormAc" in g.columns and "IAS" in g.columns:
                air = g[g["IAS"] > 30]["NormAc"].dropna()
                if len(air) >= 30:
                    meta = f", g_peak={float((air - air.median()).abs().max()):.3f}"
            g = g.iloc[:: args.step]
            with open(out / "flights" / f"{int(idx)}.csv", "w", newline="") as fh:
                fh.write(f"# step_seconds={args.step}{meta}, source=NGAFID master_index={int(idx)}\n")
                g[[c for c in SENSORS if c in g.columns]].to_csv(fh, index=False, float_format="%.2f")
            found[int(idx)] = len(g)
        if n % 25 == 0 or n == len(files):
            log(f"  {n}/{len(files)} partitions, {len(found)}/{len(wanted)} flights found")
        if len(found) == len(wanted):
            break

    manifest = {"source": "NGAFID Aviation Maintenance Dataset (doi:10.5281/zenodo.6624956)", "step_seconds": args.step, "aircraft": []}
    for a in aircraft:
        fl = []
        for idx, r, fut in a["flights"]:
            if int(idx) not in found:
                continue
            fl.append({"master_index": int(idx), "csv": f"flights/{int(idx)}.csv", "before_after": r["before_after"],
                       "date_diff": int(r["date_diff"]), "label": r["label"], "is_future": fut})
        if len([f for f in fl if not f["is_future"]]) >= 5:
            manifest["aircraft"].append({"key": a["key"], "role": a["role"], "label": a["label"], "event": a["event"], "flights": fl})
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    log(f"Wrote {out/'manifest.json'} with {len(manifest['aircraft'])} aircraft. Next: node scripts/build_seed.mjs {out}")


if __name__ == "__main__":
    main()
