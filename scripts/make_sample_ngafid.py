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
    ("baffle damage - cylinder 4", "cht4_hot"),
    ("oil pressure fluctuation", "oilp_low"),
    ("spark plug fouled", "none"),       # weak signal: should get dropped by build_seed
    ("alternator", "none"),
    ("brake pad worn", "none"),
    ("tire replaced", "none"),
    ("nav light inop", "none"),
    ("seat rail", "none"),
    ("door seal", "none"),
    ("strobe inop", "none"),
]


def flight(fault, severity, length):
    t = np.arange(length)
    climb = np.clip(t / 400, 0, 1)
    rpm = 2350 + 50 * climb + rng.normal(0, 8, length)
    rpm[: 120] = 1000
    ias = np.where(t < 120, 10, 70 + 40 * climb) + rng.normal(0, 1.5, length)
    egt_base = [1320, 1335, 1310, 1328]
    cht_base = [360, 372, 365, 355]
    egt = [b + rng.normal(0, 4, length) for b in egt_base]
    cht = [b + rng.normal(0, 2, length) for b in cht_base]
    oilp = 80 + rng.normal(0, 0.6, length)
    oilt = 185 + rng.normal(0, 1, length)
    ff = 9.6 + rng.normal(0, 0.1, length)
    volt = 28.2 + rng.normal(0, 0.05, length)
    if fault == "egt2_hot":
        egt[1] += 45 * severity
    if fault == "egt3_osc":
        egt[2] += 30 * severity * np.sin(t / 9) + rng.normal(0, 6 * severity, length)
    if fault == "cht4_hot":
        cht[3] += 35 * severity
    if fault == "oilp_low":
        oilp -= 9 * severity
    df = pd.DataFrame({
        "volt1": volt, "volt2": np.nan, "amp1": 0.8 + rng.normal(0, 0.1, length), "amp2": np.nan,
        "FQtyL": np.linspace(48, 38, length), "FQtyR": np.linspace(44, 35, length),
        "E1 FFlow": ff, "E1 OilT": oilt, "E1 OilP": oilp, "E1 RPM": rpm,
        "E1 CHT1": cht[0], "E1 CHT2": cht[1], "E1 CHT3": cht[2], "E1 CHT4": cht[3],
        "E1 EGT1": egt[0], "E1 EGT2": egt[1], "E1 EGT3": egt[2], "E1 EGT4": egt[3],
        "OAT": 12 + rng.normal(0, 0.3, length), "IAS": ias, "VSpd": rng.normal(0, 50, length),
        "NormAc": rng.normal(0, 0.02, length), "AltMSL": 1200 + 3000 * climb,
    }).round(2)
    df["timestep"] = t[::-1]  # NGAFID partitions aren't time-ordered; extractor must sort
    return df


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/sample_all_flights")
    args = ap.parse_args()
    out = Path(args.out)
    (out / "one_parq").mkdir(parents=True, exist_ok=True)

    headers, frames, idx = [], [], 0
    for label, fault in EVENTS:
        for dd in list(range(-14, 0)) + [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]:
            idx += 1
            length = int(rng.integers(2400, 4200))
            ba = "before" if dd < 0 else "same" if dd == 0 else "after"
            # fault grows as the repair approaches, gone after the repair
            sev = 0 if dd >= 0 else (1 - (abs(dd) - 1) / 14) ** 1.3
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
