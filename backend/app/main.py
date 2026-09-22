"""FastAPI application: dataset/pick/consensus/export endpoints + static UI."""
from __future__ import annotations

import csv
import io
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from . import schemas
from .config import DB_PATH, SAMPLES_DIR, STATIC_DIR
from .consensus import PickLike, build_report
from .db import get_conn, init_db

app = FastAPI(
    title="Seismic Pick Review Workbench",
    version="1.0.0",
    description="Review P/S arrival picks on timestamped waveform JSON.",
)


# --------------------------------------------------------------------------- #
# Row mappers
# --------------------------------------------------------------------------- #
def _pick_out(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "datasetId": row["dataset_id"],
        "station": row["station"],
        "channel": row["channel"],
        "phase": row["phase"],
        "time": row["time"],
        "uncertainty": row["uncertainty"],
        "author": row["author"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _channel_out(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "station": row["station"],
        "channel": row["channel"],
        "startTime": row["start_time"],
        "sampleRate": row["sample_rate"],
        "nSamples": len(json.loads(row["samples"])),
        "samples": json.loads(row["samples"]),
    }


def _dataset_summary(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    stations = {
        r["station"]
        for r in conn.execute(
            "SELECT station FROM channels WHERE dataset_id = ?", (row["id"],)
        )
    }
    n_picks = conn.execute(
        "SELECT COUNT(*) FROM picks WHERE dataset_id = ?", (row["id"],)
    ).fetchone()[0]
    return {
        "id": row["id"],
        "name": row["name"],
        "source": row["source"],
        "startTime": row["start_time"],
        "endTime": row["end_time"],
        "nStations": len(stations),
        "nPicks": n_picks,
        "createdAt": row["created_at"],
    }


def _get_dataset_or_404(conn: sqlite3.Connection, dataset_id: int) -> sqlite3.Row:
    row = conn.execute(
        "SELECT * FROM datasets WHERE id = ?", (dataset_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    return row


def _get_pick_or_404(conn: sqlite3.Connection, pick_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM picks WHERE id = ?", (pick_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="pick not found")
    return row


def _all_picks(conn: sqlite3.Connection, dataset_id: int) -> list[PickLike]:
    rows = conn.execute(
        "SELECT * FROM picks WHERE dataset_id = ? ORDER BY id", (dataset_id,)
    ).fetchall()
    return [
        PickLike(
            id=r["id"],
            station=r["station"],
            phase=r["phase"],
            time=datetime.fromisoformat(
                r["time"][:-1] + "+00:00" if r["time"].endswith("Z") else r["time"]
            ),
            uncertainty=r["uncertainty"],
            author=r["author"],
            status=r["status"],
        )
        for r in rows
    ]


# --------------------------------------------------------------------------- #
# Health / meta
# --------------------------------------------------------------------------- #
@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "db": str(DB_PATH)}


@app.get("/api/samples")
def list_samples() -> list[dict]:
    """Built-in demo datasets shipped under /samples."""
    if not SAMPLES_DIR.is_dir():
        return []
    out = []
    for path in sorted(SAMPLES_DIR.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            out.append(
                {
                    "file": path.name,
                    "name": payload.get("name", path.stem),
                    "source": payload.get("source"),
                    "nChannels": len(payload.get("channels", [])),
                    "nPicks": len(payload.get("picks", [])),
                }
            )
        except (json.JSONDecodeError, OSError):
            continue
    return out


@app.post("/api/samples/{file_name}/import", status_code=201)
def import_sample(file_name: str, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
    # Guard against path traversal: basename only, *.json.
    safe = Path(file_name).name
    path = SAMPLES_DIR / safe
    if not path.is_file() or path.suffix != ".json":
        raise HTTPException(status_code=404, detail="sample not found")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise HTTPException(status_code=400, detail=f"invalid sample file: {exc}")
    return _import_payload(conn, payload)


# --------------------------------------------------------------------------- #
# Datasets
# --------------------------------------------------------------------------- #
@app.get("/api/datasets")
def list_datasets(conn: sqlite3.Connection = Depends(get_conn)) -> list[dict]:
    rows = conn.execute("SELECT * FROM datasets ORDER BY id DESC").fetchall()
    return [_dataset_summary(conn, r) for r in rows]


@app.post("/api/datasets/import", status_code=201)
def import_dataset(
    payload: schemas.DatasetImport, conn: sqlite3.Connection = Depends(get_conn)
) -> dict:
    return _import_payload(conn, payload.model_dump(by_alias=False))


def _import_payload(conn: sqlite3.Connection, payload: dict) -> dict:
    """Shared import used by JSON upload and built-in sample files.

    Accepts both camelCase (Pydantic-wired) and snake_case keys.
    """
    channels_raw = payload.get("channels") or []
    if not channels_raw:
        raise HTTPException(status_code=422, detail="at least one channel is required")

    def cc(d: dict, camel: str, snake: str):
        return d.get(camel, d.get(snake))

    def parse_dt(v) -> datetime:
        if isinstance(v, datetime):
            return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
        try:
            dt = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=f"bad timestamp: {v}") from exc
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)

    top_start = payload.get("startTime", payload.get("start_time"))
    if top_start is not None:
        anchor = parse_dt(top_start)
    else:
        anchor = min(parse_dt(cc(c, "startTime", "start_time")) for c in channels_raw)

    end_times = []
    seen: set[tuple[str, str]] = set()
    parsed_channels = []
    stations = set()
    for c in channels_raw:
        station = (cc(c, "station", "station") or "").strip()
        channel = (cc(c, "channel", "channel") or "").strip()
        if not station or not channel:
            raise HTTPException(status_code=422, detail="station/channel must be set")
        if (station, channel) in seen:
            raise HTTPException(
                status_code=422, detail=f"duplicate channel: {station}.{channel}"
            )
        seen.add((station, channel))
        stations.add(station)

        samples = c.get("samples") or []
        if len(samples) < 2:
            raise HTTPException(
                status_code=422, detail=f"{station}.{channel}: need >= 2 samples"
            )
        rate = float(cc(c, "sampleRate", "sample_rate") or 0)
        if rate <= 0:
            raise HTTPException(status_code=422, detail="sampleRate must be > 0")
        start = parse_dt(cc(c, "startTime", "start_time"))
        duration = (len(samples) - 1) / rate
        end_times.append(start.timestamp() + duration)
        parsed_channels.append((station, channel, start, rate, samples))

    name = (payload.get("name") or "untitled").strip()
    source = payload.get("source")
    end_time = datetime.fromtimestamp(max(end_times), tz=timezone.utc)

    cur = conn.execute(
        "INSERT INTO datasets (name, source, start_time, end_time) VALUES (?,?,?,?)",
        (
            name,
            source,
            anchor.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            end_time.isoformat().replace("+00:00", "Z"),
        ),
    )
    dataset_id = cur.lastrowid

    for station, channel, start, rate, samples in parsed_channels:
        conn.execute(
            """INSERT INTO channels
                   (dataset_id, station, channel, start_time, sample_rate, samples)
               VALUES (?,?,?,?,?,?)""",
            (
                dataset_id,
                station,
                channel,
                start.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                rate,
                json.dumps([float(x) for x in samples]),
            ),
        )

    imported_picks = []
    for p in payload.get("picks") or []:
        station = (cc(p, "station", "station") or "").strip()
        if station not in stations:
            raise HTTPException(
                status_code=422,
                detail=f"pick station {station!r} has no matching channel",
            )
        phase = p.get("phase")
        if phase not in ("P", "S"):
            raise HTTPException(status_code=422, detail="phase must be P or S")
        t = parse_dt(p.get("time"))
        unc = float(p.get("uncertainty", 0))
        if unc < 0:
            raise HTTPException(status_code=422, detail="uncertainty must be >= 0")
        author = str(p.get("author") or "")
        status = p.get("status", "pending")
        if status not in ("pending", "accepted", "rejected"):
            status = "pending"
        channel_name = p.get("channel")
        cur2 = conn.execute(
            """INSERT INTO picks
                   (dataset_id, station, channel, phase, time, uncertainty,
                    author, status)
               VALUES (?,?,?,?,?,?,?,?)""",
            (
                dataset_id,
                station,
                channel_name,
                phase,
                t.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                unc,
                author,
                status,
            ),
        )
        imported_picks.append(cur2.lastrowid)

    return {"id": dataset_id, "nChannels": len(parsed_channels), "nPicks": len(imported_picks)}


@app.get("/api/datasets/{dataset_id}")
def get_dataset(
    dataset_id: int, conn: sqlite3.Connection = Depends(get_conn)
) -> dict:
    ds = _get_dataset_or_404(conn, dataset_id)
    channel_rows = conn.execute(
        "SELECT * FROM channels WHERE dataset_id = ? ORDER BY station, channel",
        (dataset_id,),
    ).fetchall()
    pick_rows = conn.execute(
        "SELECT * FROM picks WHERE dataset_id = ? ORDER BY id", (dataset_id,)
    ).fetchall()
    return {
        **_dataset_summary(conn, ds),
        "channels": [_channel_out(conn, r) for r in channel_rows],
        "picks": [_pick_out(r) for r in pick_rows],
    }


@app.delete("/api/datasets/{dataset_id}", status_code=204)
def delete_dataset(
    dataset_id: int, conn: sqlite3.Connection = Depends(get_conn)
) -> Response:
    _get_dataset_or_404(conn, dataset_id)
    conn.execute("DELETE FROM datasets WHERE id = ?", (dataset_id,))
    return Response(status_code=204)


# --------------------------------------------------------------------------- #
# Picks
# --------------------------------------------------------------------------- #
@app.post("/api/datasets/{dataset_id}/picks", status_code=201)
def create_pick(
    dataset_id: int,
    body: schemas.PickCreate,
    conn: sqlite3.Connection = Depends(get_conn),
) -> dict:
    _get_dataset_or_404(conn, dataset_id)
    stations = {
        r["station"]
        for r in conn.execute(
            "SELECT DISTINCT station FROM channels WHERE dataset_id = ?",
            (dataset_id,),
        )
    }
    if body.station not in stations:
        raise HTTPException(status_code=422, detail="unknown station for dataset")
    t = body.time if body.time.tzinfo else body.time.replace(tzinfo=timezone.utc)
    cur = conn.execute(
        """INSERT INTO picks
               (dataset_id, station, channel, phase, time, uncertainty, author)
           VALUES (?,?,?,?,?,?,?)""",
        (
            dataset_id,
            body.station,
            body.channel,
            body.phase,
            t.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            body.uncertainty,
            body.author,
        ),
    )
    return _pick_out(_get_pick_or_404(conn, cur.lastrowid))


@app.patch("/api/picks/{pick_id}")
def update_pick(
    pick_id: int,
    body: schemas.PickUpdate,
    conn: sqlite3.Connection = Depends(get_conn),
) -> dict:
    row = _get_pick_or_404(conn, pick_id)
    fields, values = [], []
    if body.time is not None:
        t = body.time if body.time.tzinfo else body.time.replace(tzinfo=timezone.utc)
        fields.append("time = ?")
        values.append(t.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"))
    if body.uncertainty is not None:
        fields.append("uncertainty = ?")
        values.append(body.uncertainty)
    if body.phase is not None:
        fields.append("phase = ?")
        values.append(body.phase)
    if body.channel is not None:
        fields.append("channel = ?")
        values.append(body.channel)
    if body.author is not None:
        fields.append("author = ?")
        values.append(body.author)
    if body.status is not None:
        fields.append("status = ?")
        values.append(body.status)
    if not fields:
        raise HTTPException(status_code=400, detail="no updatable fields supplied")
    fields.append("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')")
    values.append(pick_id)
    conn.execute(f"UPDATE picks SET {', '.join(fields)} WHERE id = ?", values)
    return _pick_out(_get_pick_or_404(conn, pick_id))


@app.delete("/api/picks/{pick_id}", status_code=204)
def delete_pick(
    pick_id: int, conn: sqlite3.Connection = Depends(get_conn)
) -> Response:
    _get_pick_or_404(conn, pick_id)
    conn.execute("DELETE FROM picks WHERE id = ?", (pick_id,))
    return Response(status_code=204)


# --------------------------------------------------------------------------- #
# Consensus
# --------------------------------------------------------------------------- #
@app.get("/api/datasets/{dataset_id}/consensus")
def consensus(
    dataset_id: int, conn: sqlite3.Connection = Depends(get_conn)
) -> dict:
    _get_dataset_or_404(conn, dataset_id)
    report = build_report(_all_picks(conn, dataset_id))
    return {"datasetId": dataset_id, **report}


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #
def _report_by_key(report: dict) -> tuple[dict, set[str], set[int]]:
    groups = {(g["station"], g["phase"]): g for g in report["groups"]}
    conflict_pairs = {(c["pickA"], c["pickB"]) for c in report["conflicts"]}
    conflicted_picks = {pid for pair in conflict_pairs for pid in pair}
    return groups, conflict_pairs, conflicted_picks


def _serializable_groups(groups: list[dict]) -> list[dict]:
    out = []
    for g in groups:
        gg = dict(g)
        if isinstance(gg.get("time"), datetime):
            gg["time"] = gg["time"].isoformat().replace("+00:00", "Z")
        out.append(gg)
    return out


@app.get("/api/datasets/{dataset_id}/export")
def export_dataset(
    dataset_id: int,
    format: str = "json",
    conn: sqlite3.Connection = Depends(get_conn),
):
    ds = _get_dataset_or_404(conn, dataset_id)
    pick_rows = conn.execute(
        "SELECT * FROM picks WHERE dataset_id = ? ORDER BY station, phase, id",
        (dataset_id,),
    ).fetchall()
    report = build_report(_all_picks(conn, dataset_id))
    groups, conflict_pairs, conflicted_picks = _report_by_key(report)

    def enrich(row: sqlite3.Row) -> dict:
        g = groups.get((row["station"], row["phase"]))
        member = None
        if g:
            member = next(
                (m for m in g["members"] if m["pickId"] == row["id"]), None
            )
        return {
            "id": row["id"],
            "station": row["station"],
            "channel": row["channel"],
            "phase": row["phase"],
            "time": row["time"],
            "uncertainty": row["uncertainty"],
            "author": row["author"],
            "status": row["status"],
            "weight": round(member["weight"], 6) if member else None,
            "inBasis": member["inBasis"] if member else None,
            "inConflict": row["id"] in conflicted_picks
            if row["status"] != "rejected"
            else False,
        }

    active = [enrich(r) for r in pick_rows if r["status"] != "rejected"]
    rejected = [enrich(r) for r in pick_rows if r["status"] == "rejected"]

    if format == "csv":
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(
            [
                "dataset_id", "station", "channel", "phase", "time", "uncertainty_s",
                "author", "status", "in_basis", "weight", "in_conflict",
                "consensus_time", "consensus_uncertainty_s",
            ]
        )
        for p in active + rejected:
            g = groups.get((p["station"], p["phase"]))
            ct = g["time"].isoformat().replace("+00:00", "Z") if g and g["time"] else ""
            cu = g["uncertainty"] if g else ""
            writer.writerow(
                [
                    dataset_id, p["station"], p["channel"] or "", p["phase"],
                    p["time"], p["uncertainty"], p["author"], p["status"],
                    "" if p["inBasis"] is None else str(p["inBasis"]).lower(),
                    "" if p["weight"] is None else p["weight"],
                    str(p["inConflict"]).lower(), ct, cu,
                ]
            )
        return Response(
            content=buf.getvalue(),
            media_type="text/csv; charset=utf-8",
            headers={
                "Content-Disposition": f'attachment; filename="dataset-{dataset_id}-review.csv"'
            },
        )

    payload = {
        "datasetId": dataset_id,
        "name": ds["name"],
        "source": ds["source"],
        "startTime": ds["start_time"],
        "endTime": ds["end_time"],
        "exportedAt": datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z"),
        "picks": active,
        "rejectedPicks": rejected,
        "consensus": _serializable_groups(report["groups"]),
        "conflicts": report["conflicts"],
    }
    return JSONResponse(
        payload,
        headers={
            "Content-Disposition": f'attachment; filename="dataset-{dataset_id}-review.json"'
        },
    )


# --------------------------------------------------------------------------- #
# Static frontend (mounted last; /api routes take priority)
# --------------------------------------------------------------------------- #
if STATIC_DIR.is_dir():
    app.mount(
        "/assets",
        StaticFiles(directory=STATIC_DIR / "assets"),
        name="assets",
    )

    @app.get("/", include_in_schema=False)
    def index() -> RedirectResponse:
        return RedirectResponse(url="/index.html")

    @app.get("/index.html", include_in_schema=False)
    def index_html() -> Response:
        return Response(
            content=(STATIC_DIR / "index.html").read_text(encoding="utf-8"),
            media_type="text/html",
        )
