#!/usr/bin/env python3
"""
Generates a SMALL SYNTHETIC dataset in the exact NGAFID all_flights format
(flight_header.csv + one_parq/*.parquet) so the pipeline can be tested without the 4 GB download.
This is NOT real data. Use the real NGAFID download for the demo.

    python scripts/make_sample_ngafid.py --out data/sample_all_flights
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd

rng = np.random.default_rng(7)

EVENTS = [
    # label, kind of fault planted in before-flights
    ("intake gasket leak/damage", "egt2_hot"),
    ("exhaust valve - cylinder 3 low compression", "egt3_osc"),
    ("exhaust valve - cylinder 3 burnt", "egt3_osc"),            # same problem on a second aircraft (fleet history)
    ("exhaust valve - cylinder 3 sticking", "egt3_osc", 12, 0.9),     # third aircraft with the same problem
    ("exhaust valve - cylinder 3 early stage", "egt3_osc", 9, 0.27),  # caught early: still developing at the last flight
    ("baffle damage - cylinder 4", "cht4_hot"),
    ("oil pressure fluctuation", "oilp_low"),
    ("spark plug fouled", "none"),       # weak signal: should get dropped by build_seed
    ("alternator", "charging"),
    ("brake pad worn", "none"),
    ("tire replaced", "none"),
    ("nav light inop", "none"),
    ("seat rail", "none"),
    ("door seal", "none"),
    ("strobe inop", "none"),
]


def flight(fault, severity, length):
    t = np.arange(length)
    oat = float(rng.uniform(-2, 30))                  # outside air temp (C), varies flight to flight
    heat = 1.1 * (oat - 12)                           # engine temps run warmer on hot days (synthetic)
    taxi, climb_end = 120, 520
    rpm = np.where(t < taxi, 1000, np.where(t < climb_end, 2450, 2350)) + rng.normal(0, 8, length)
    ias = np.where(t < taxi, 10, np.where(t < climb_end, 75, 105)) + rng.normal(0, 1.5, length)
    vspd = np.where((t >= taxi) & (t < climb_end), 650, 0) + rng.normal(0, 50, length)
    alt = 1200 + np.clip((t - taxi) * 650 / 60, 0, 4300)
    egt_base = [1320, 1335, 1310, 1328]
    cht_base = [360, 372, 365, 355]
    egt = [b + rng.normal(0, 4, length) for b in egt_base]
    cht = [b + heat + np.where((t >= taxi) & (t < climb_end), 25, 0) + rng.normal(0, 2, length) for b in cht_base]
    oilp = 80 + rng.normal(0, 0.6, length)
    oilt = 185 + heat + rng.normal(0, 1, length)
    ff = np.where(t < taxi, 3, np.where(t < climb_end, 12, 9.6)) + rng.normal(0, 0.1, length)
    used = np.cumsum(ff) / 3600.0
    fql, fqr = 24 - used / 2 + rng.normal(0, 0.15, length), 22 - used / 2 + rng.normal(0, 0.15, length)
    volt = 28.2 + rng.normal(0, 0.05, length)
    amp = 4.0 + rng.normal(0, 0.2, length)
    normac = rng.normal(0, 0.02, length)
    normac[-60] += float(rng.uniform(0.15, 0.35))     # touchdown
    if fault == "egt2_hot":
        egt[1] += 45 * severity
    if fault == "egt3_osc":
        egt[2] += 30 * severity * np.sin(t / 9) + rng.normal(0, 6 * severity, length)
    if fault == "cht4_hot":
        cht[3] += 35 * severity
    if fault == "oilp_low":
        oilp -= 9 * severity
    if fault == "charging":
        volt -= 0.9 * severity
        amp -= 3.0 * severity
    df = pd.DataFrame({
        "volt1": volt, "volt2": np.nan, "amp1": amp, "amp2": np.nan,
        "FQtyL": fql, "FQtyR": fqr,
        "E1 FFlow": ff, "E1 OilT": oilt, "E1 OilP": oilp, "E1 RPM": rpm,
        "E1 CHT1": cht[0], "E1 CHT2": cht[1], "E1 CHT3": cht[2], "E1 CHT4": cht[3],
        "E1 EGT1": egt[0], "E1 EGT2": egt[1], "E1 EGT3": egt[2], "E1 EGT4": egt[3],
        "OAT": oat + rng.normal(0, 0.3, length), "IAS": ias, "VSpd": vspd,
        "NormAc": normac, "AltMSL": alt,
    }).round(2)
    df["timestep"] = t
    return df.sample(frac=1, random_state=int(rng.integers(1e9)))  # NGAFID partitions aren't time-ordered; extractor must sort


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/sample_all_flights")
    args = ap.parse_args()
    out = Path(args.out)
    (out / "one_parq").mkdir(parents=True, exist_ok=True)

    headers, frames, idx = [], [], 0
    for ev in EVENTS:
        label, fault = ev[0], ev[1]
        ramp, cap = (ev[2], ev[3]) if len(ev) > 2 else (14, 1.0)
        for dd in list(range(-14, 0)) + [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]:
            idx += 1
            length = int(rng.integers(2400, 4200))
            ba = "before" if dd < 0 else "same" if dd == 0 else "after"
            # fault grows as the repair approaches, gone after the repair
            sev = 0 if dd >= 0 else cap * max(0.0, (ramp - (abs(dd) - 1)) / ramp) ** 1.3
            df = flight(fault, sev, length)
            df["cluster"] = "c_x"
            df.index = pd.Index([idx] * len(df), name="Master Index")
            frames.append(df)
            headers.append({"Master Index": idx, "before_after": ba, "date_diff": dd, "flight_length": float(length),
                            "label": label, "hierarchy": np.nan, "number_flights_before": 0})
    pd.DataFrame(headers).to_csv(out / "flight_header.csv", index=False)
    all_df = pd.concat(frames)
    for i, chunk in enumerate(np.array_split(np.arange(1, idx + 1), 6)):
        all_df[all_df.index.isin(chunk)].to_parquet(out / "one_parq" / f"part.{i}.parquet")
    print(f"Synthetic sample written to {out} ({idx} flights). NOT real data.")


if __name__ == "__main__":
    main()
