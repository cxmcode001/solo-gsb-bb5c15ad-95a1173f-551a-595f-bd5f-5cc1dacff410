"""SQLite connection management and schema initialisation."""
from __future__ import annotations

import sqlite3
from collections.abc import Iterator

from .config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS datasets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    source        TEXT,
    start_time    TEXT    NOT NULL,   -- ISO-8601 UTC, e.g. 2026-09-22T08:00:00Z
    end_time      TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS channels (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_id   INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    station      TEXT    NOT NULL,
    channel      TEXT    NOT NULL,
    start_time   TEXT    NOT NULL,
    sample_rate  REAL    NOT NULL,
    samples      TEXT    NOT NULL,    -- JSON array of floats
    UNIQUE (dataset_id, station, channel)
);

CREATE TABLE IF NOT EXISTS picks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_id   INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    station      TEXT    NOT NULL,
    channel      TEXT,
    phase        TEXT    NOT NULL CHECK (phase IN ('P','S')),
    time         TEXT    NOT NULL,    -- arrival time, ISO-8601 UTC
    uncertainty  REAL    NOT NULL CHECK (uncertainty >= 0),   -- +/- seconds
    author       TEXT    NOT NULL DEFAULT '',
    status       TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','accepted','rejected')),
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_channels_dataset ON channels(dataset_id);
CREATE INDEX IF NOT EXISTS idx_picks_dataset_station_phase
    ON picks(dataset_id, station, phase);
"""


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def get_conn() -> Iterator[sqlite3.Connection]:
    """FastAPI dependency: one transaction-scoped connection per request."""
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


init_db()
