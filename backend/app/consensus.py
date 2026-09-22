"""Interval-overlap conflict detection and inverse-variance weighted consensus.

For every ``(station, phase)`` group in a dataset the consensus is computed
from the *basis* set:

* if at least one **accepted** pick exists, only accepted picks form the basis;
* otherwise the non-rejected (i.e. pending) picks form the basis;
* rejected picks never contribute.

Each basis pick defines a symmetric uncertainty interval
``[time - u, time + u]``. Two picks are in **conflict** when their intervals
are disjoint (``|t1 - t2| > u1 + u2``); touching endpoints count as overlap.

The consensus time is the inverse-variance weighted mean
(``w = 1 / max(u, EPSILON)^2``). The reported uncertainty is the weighted
standard error expanded by the Birge ratio when the pick scatter is larger
than the stated uncertainties suggest:

    sigma_inner = 1 / sqrt(sum w)
    chi2        = sum w * (ti - t_mean)^2
    R           = sqrt(chi2 / (n - 1))
    sigma       = sigma_inner * max(1, R)
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone

EPSILON = 1e-3  # seconds; floor so zero-uncertainty picks get finite weight
GAP_TOL = 1e-6  # seconds; endpoints touching within this still count as overlap
               # (epoch seconds near 2026 have ~2e-7 s double-precision ulp)


def epoch(dt: datetime) -> float:
    """Convert a datetime to POSIX seconds (aware datetimes -> UTC)."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


@dataclass
class PickLike:
    id: int
    station: str
    phase: str
    time: datetime
    uncertainty: float
    author: str
    status: str

    @property
    def t(self) -> float:
        return epoch(self.time)

    @property
    def weight(self) -> float:
        return 1.0 / max(self.uncertainty, EPSILON) ** 2


def interval_gap(a: PickLike, b: PickLike) -> float:
    """Positive (beyond float tolerance) when the two windows are disjoint."""
    return abs(a.t - b.t) - (a.uncertainty + b.uncertainty)


def _basis(picks: list[PickLike]) -> list[PickLike]:
    accepted = [p for p in picks if p.status == "accepted"]
    if accepted:
        return accepted
    pending = [p for p in picks if p.status != "rejected"]
    return pending


def _weighted_consensus(basis: list[PickLike]) -> tuple[float, float, float, float]:
    """Return (mean_time, sigma_inner, birge_factor, sigma_reported)."""
    weights = [p.weight for p in basis]
    w_sum = sum(weights)
    times = [p.t for p in basis]
    mean = sum(w * t for w, t in zip(weights, times)) / w_sum
    sigma_inner = 1.0 / math.sqrt(w_sum)

    if len(basis) > 1:
        chi2 = sum(w * (t - mean) ** 2 for w, t in zip(weights, times))
        dof = len(basis) - 1
        birge = math.sqrt(chi2 / dof)
        sigma = sigma_inner * max(1.0, birge)
    else:
        birge = 1.0
        sigma = sigma_inner
    return mean, sigma_inner, birge, sigma


def build_report(picks: list[PickLike]) -> dict:
    """Compute groups + pairwise conflicts for all non-rejected picks."""
    groups_raw: dict[tuple[str, str], list[PickLike]] = defaultdict(list)
    for p in picks:
        if p.status != "rejected":
            groups_raw[(p.station, p.phase)].append(p)

    groups_out = []
    conflicts_out = []

    for (station, phase), members in sorted(groups_raw.items()):
        members.sort(key=lambda p: p.id)
        basis = _basis(members)
        basis_ids = {p.id for p in basis}

        # All pairwise conflicts among non-rejected picks.
        for i, a in enumerate(members):
            for b in members[i + 1 :]:
                gap = interval_gap(a, b)
                if gap > GAP_TOL:
                    conflicts_out.append(
                        {
                            "station": station,
                            "phase": phase,
                            "pickA": a.id,
                            "pickB": b.id,
                            "gap": round(gap, 6),
                            "basisOnly": a.id in basis_ids and b.id in basis_ids,
                        }
                    )

        mean, sigma_inner, birge, sigma = _weighted_consensus(basis)
        w_total = sum(p.weight for p in basis)

        members_out = []
        for p in members:
            in_basis = p.id in basis_ids
            members_out.append(
                {
                    "pickId": p.id,
                    "author": p.author,
                    "status": p.status,
                    "inBasis": in_basis,
                    "weight": (p.weight / w_total) if in_basis else 0.0,
                    "distance": round(p.t - mean, 6),
                }
            )

        basis_conflict = any(
            c["pickA"] in basis_ids and c["pickB"] in basis_ids
            for c in conflicts_out
            if c["station"] == station and c["phase"] == phase
        )

        groups_out.append(
            {
                "station": station,
                "phase": phase,
                "time": datetime.fromtimestamp(mean, tz=timezone.utc),
                "uncertainty": round(sigma, 6),
                "uncertaintyInner": round(sigma_inner, 6),
                "birgeFactor": round(birge, 6),
                "nTotal": len(members),
                "nBasis": len(basis),
                "consistent": not basis_conflict,
                "members": members_out,
            }
        )

    conflicts_out.sort(key=lambda c: (c["station"], c["phase"], c["pickA"], c["pickB"]))
    return {"groups": groups_out, "conflicts": conflicts_out}
