"""Runtime configuration, overridable via environment variables."""
from __future__ import annotations

import os
from pathlib import Path

# Directory holding the SQLite database. In Docker this is the mounted volume.
DATA_DIR = Path(os.environ.get("PICKER_DATA_DIR", "/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = Path(os.environ.get("PICKER_DB_PATH", str(DATA_DIR / "picker.db")))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

# Directory of built-in demo datasets.
SAMPLES_DIR = Path(
    os.environ.get("PICKER_SAMPLES_DIR", str(Path(__file__).resolve().parents[2] / "samples"))
)

# Directory of the compiled frontend (TypeScript -> static assets).
STATIC_DIR = Path(
    os.environ.get("PICKER_STATIC_DIR", str(Path(__file__).resolve().parents[2] / "frontend" / "dist"))
)
