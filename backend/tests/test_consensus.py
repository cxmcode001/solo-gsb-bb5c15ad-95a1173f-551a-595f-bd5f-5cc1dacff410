"""Unit tests for interval conflict + weighted consensus logic."""
from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.consensus import PickLike, build_report, interval_gap  # noqa: E402

T0 = datetime(2026, 9, 22, 8, 0, 0, tzinfo=timezone.utc)


def pk(id_: int, t: float, u: float, status: str = "pending",
       sta: str = "S1", phase: str = "P", author: str = "") -> PickLike:
    return PickLike(
        id=id_, station=sta, phase=phase,
        time=T0 + timedelta(seconds=t),
        uncertainty=u, author=author or f"a{id_}", status=status,
    )


def group(report, sta="S1", phase="P"):
    return next(g for g in report["groups"] if g["station"] == sta and g["phase"] == phase)


def test_touching_endpoints_overlap() -> None:
    a, b = pk(1, 0.0, 0.1), pk(2, 0.2, 0.1)
    assert abs(interval_gap(a, b)) < 1e-6
    r = build_report([a, b])
    assert r["conflicts"] == []
    assert group(r)["consistent"] is True


def test_disjoint_intervals_conflict() -> None:
    a, b = pk(1, 0.0, 0.1), pk(2, 0.5, 0.1)
    r = build_report([a, b])
    assert len(r["conflicts"]) == 1
    assert r["conflicts"][0]["gap"] == 0.3
    assert group(r)["consistent"] is False


def test_weighted_mean_and_inner_sigma() -> None:
    # u=0.1 -> w=100 ; u=0.2 -> w=25 ; mean = (100*0 + 25*0.1)/125 = 0.02
    a, b = pk(1, 0.0, 0.1), pk(2, 0.1, 0.2)
    r = build_report([a, b])
    g = group(r)
    assert g["time"] == T0 + timedelta(seconds=0.02)
    # sigma_inner = 1/sqrt(125) = 0.08944...
    assert abs(g["uncertaintyInner"] - 1 / 125 ** 0.5) < 1e-6
    weights = {m["pickId"]: round(m["weight"], 4) for m in g["members"]}
    assert weights == {1: 0.8, 2: 0.2}


def test_birge_inflation() -> None:
    # Scatter far exceeds stated windows -> R > 1 inflates uncertainty.
    a, b = pk(1, 0.0, 0.01), pk(2, 0.5, 0.01)
    g = group(build_report([a, b]))
    assert g["birgeFactor"] > 5
    assert g["uncertainty"] > g["uncertaintyInner"]


def test_accepted_picks_define_basis() -> None:
    a = pk(1, 0.0, 0.1, "accepted")
    b = pk(2, 0.5, 0.1, "pending")   # disjoint, but not in basis
    r = build_report([a, b])
    g = group(r)
    assert g["nBasis"] == 1 and g["nTotal"] == 2
    # conflict still listed, but not basis-only; group stays consistent
    assert r["conflicts"][0]["basisOnly"] is False
    assert g["consistent"] is True
    non_basis = next(m for m in g["members"] if m["pickId"] == 2)
    assert non_basis["inBasis"] is False and non_basis["weight"] == 0.0


def test_rejected_picks_excluded_entirely() -> None:
    a = pk(1, 0.0, 0.1, "pending")
    b = pk(2, 5.0, 0.1, "rejected")
    r = build_report([a, b])
    assert r["conflicts"] == []
    assert len(group(r)["members"]) == 1


def test_single_pick_uses_its_own_uncertainty() -> None:
    g = group(build_report([pk(1, 1.0, 0.25)]))
    assert g["uncertaintyInner"] == 0.25
    assert g["uncertainty"] == 0.25
    assert g["birgeFactor"] == 1.0
    assert g["consistent"] is True


def test_zero_uncertainty_gets_finite_weight() -> None:
    a, b = pk(1, 0.0, 0.0), pk(2, 0.001, 0.0)
    r = build_report([a, b])
    g = group(r)
    assert g["uncertaintyInner"] > 0
    assert abs(g["time"] - (T0 + timedelta(seconds=0.0005))) < timedelta(milliseconds=1)


def test_groups_are_keyed_per_station_and_phase() -> None:
    picks = [
        pk(1, 0.0, 0.1, sta="S1", phase="P"),
        pk(2, 0.9, 0.1, sta="S1", phase="P"),  # conflict S1 P
        pk(3, 0.0, 0.1, sta="S1", phase="S"),
        pk(4, 0.0, 0.1, sta="S2", phase="P"),
    ]
    r = build_report(picks)
    assert len(r["groups"]) == 3
    assert len(r["conflicts"]) == 1
    assert group(r, "S1", "S")["consistent"] is True
    assert group(r, "S2", "P")["consistent"] is True


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"PASS {fn.__name__}")
    print(f"\n{len(fns)} tests passed")
