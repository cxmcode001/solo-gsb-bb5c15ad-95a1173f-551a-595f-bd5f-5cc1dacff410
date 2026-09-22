"""Generate a deterministic demo waveform dataset with pre-seeded picks.

Run:  python scripts/generate_sample.py
Output: samples/sample_review.json

The synthetic trace is a Ricker wavelet (P on vertical, S on horizontals)
plus smoothed random noise.  Seeded picks include overlapping consensus
picks, a real interval conflict and a rejected outlier so every review
feature is visible immediately after import.
"""
from __future__ import annotations

import json
import math
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "samples" / "sample_review.json"

T0 = datetime(2026, 9, 22, 8, 0, 0, tzinfo=timezone.utc)
DURATION = 12.0
SAMPLE_RATE = 100.0
N = int(DURATION * SAMPLE_RATE) + 1

# station code -> epicentral distance (km). Arrival moveout follows a
# constant-velocity model (vp=6.0 km/s, vs=3.5 km/s, origin at t=2 s).
VP, VS, ORIGIN = 6.0, 3.5, 2.0
STATIONS = ["STA01", "STA02", "STA03", "STA04"]
DIST = {"STA01": 12.0, "STA02": 30.0, "STA03": 48.0, "STA04": 66.0}
CHANNELS = ["BHZ", "BHN", "BHE"]

# phase -> (dominant frequency Hz, relative amplitude per channel)
PHASE_STYLE = {
    "P": (5.0, {"BHZ": 1.0, "BHN": 0.35, "BHE": 0.30}),
    "S": (2.6, {"BHZ": 0.45, "BHN": 1.0, "BHE": 0.9}),
}
POLARITY = {  # per (station, channel) wavelet sign
    "BHZ": 1.0,
    "BHN": 1.0,
    "BHE": -1.0,
}


def ricker(t: float, t_arr: float, freq: float) -> float:
    x = math.pi * freq * (t - t_arr)
    return (1.0 - 2.0 * x * x) * math.exp(-(x * x))


def build_trace(station: str, channel: str, tp: float, ts: float) -> list[float]:
    rng = random.Random(hash((station, channel)) & 0xFFFFFFFF)
    decay = 1.0 / (1.0 + DIST[station] / 30.0)
    fp, amp_p = PHASE_STYLE["P"]
    fs, amp_s = PHASE_STYLE["S"]
    pol = POLARITY[channel]

    values: list[float] = []
    noise = 0.0
    for i in range(N):
        t = i / SAMPLE_RATE
        sig = (
            pol * decay * amp_p[channel] * ricker(t, tp, fp)
            + pol * decay * 0.9 * amp_s[channel] * ricker(t, ts, fs)
        )
        # low-passed white noise -> realistic microseismic texture
        noise = 0.82 * noise + 0.18 * rng.gauss(0.0, 0.12)
        values.append(round(sig + noise, 4))
    return values


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def at(sec: float) -> str:
    return iso(T0 + timedelta(seconds=sec))


def main() -> None:
    arrivals = {}
    channels = []
    for sta in STATIONS:
        tp = ORIGIN + DIST[sta] / VP
        ts = ORIGIN + DIST[sta] / VS
        arrivals[sta] = (tp, ts)
        for cha in CHANNELS:
            channels.append(
                {
                    "station": sta,
                    "channel": cha,
                    "startTime": iso(T0),
                    "sampleRate": SAMPLE_RATE,
                    "samples": build_trace(sta, cha, tp, ts),
                }
            )

    picks = []

    def add(sta, phase, dt, unc, author, status="pending", channel=None):
        picks.append(
            {
                "station": sta,
                "channel": channel,
                "phase": phase,
                "time": at(dt),
                "uncertainty": unc,
                "author": author,
                "status": status,
            }
        )

    for sta in STATIONS:
        tp, ts = arrivals[sta]
        if sta == "STA01":
            # P: auto + analyst overlap cleanly -> strong consensus.
            add(sta, "P", tp + 0.02, 0.15, "STA/LTA-auto")
            add(sta, "P", tp - 0.01, 0.05, "reviewer-li", "accepted", "BHZ")
            # S: uncertainty windows are disjoint -> conflict.
            add(sta, "S", ts + 0.45, 0.15, "STA/LTA-auto")
            add(sta, "S", ts, 0.10, "reviewer-li", "pending", "BHN")
        elif sta == "STA02":
            add(sta, "P", tp + 0.01, 0.20, "STA/LTA-auto")
            add(sta, "P", tp - 0.05, 0.10, "reviewer-li", "accepted", "BHZ")
            add(sta, "S", ts + 0.10, 0.30, "STA/LTA-auto")
        elif sta == "STA03":
            # No accepted picks: two pending P picks disagree -> pending-basis conflict.
            add(sta, "P", tp + 0.30, 0.10, "STA/LTA-auto")
            add(sta, "P", tp - 0.02, 0.08, "reviewer-wang", "pending", "BHZ")
            add(sta, "S", ts + 0.10, 0.20, "STA/LTA-auto")
        else:  # STA04
            # Accepted analyst pick; an auto outlier has been rejected.
            add(sta, "P", tp - 1.00, 0.20, "STA/LTA-auto", "rejected")
            add(sta, "P", tp, 0.10, "reviewer-wang", "accepted", "BHZ")
            add(sta, "S", ts + 0.20, 0.25, "STA/LTA-auto")
            add(sta, "S", ts + 0.05, 0.15, "reviewer-wang", "pending", "BHN")

    payload = {
        "name": "Demo event 2026-09-22T08:00Z (4 stations)",
        "source": "synthetic ricker wavelets, scripts/generate_sample.py",
        "startTime": iso(T0),
        "channels": channels,
        "picks": picks,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size/1024:.1f} KiB)")


if __name__ == "__main__":
    main()
