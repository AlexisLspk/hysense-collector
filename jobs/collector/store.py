"""Storage for the collector: Turso (libSQL over HTTP) in production, a local SQLite file otherwise.

Set TURSO_DATABASE_URL (libsql://... or https://...) and TURSO_AUTH_TOKEN to use Turso.
Without them, data goes to LOCAL_DB_PATH (default: <repo>/.data/hysense.db).
"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any, Iterable, Sequence

import requests

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_LOCAL_DB = REPO_ROOT / ".data" / "hysense.db"

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS snapshots (
        kind TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )""",
    # One row per asset per UTC day; points is a JSON array of
    # [epoch_seconds, score, mentions, upvotes, rank_change_24h].
    """CREATE TABLE IF NOT EXISTS history (
        type TEXT NOT NULL,
        symbol TEXT NOT NULL,
        day TEXT NOT NULL,
        points TEXT NOT NULL,
        PRIMARY KEY (type, symbol, day)
    ) WITHOUT ROWID""",
    """CREATE TABLE IF NOT EXISTS sentiment (
        type TEXT NOT NULL,
        symbol TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (type, symbol)
    ) WITHOUT ROWID""",
    """CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )""",
]

Statement = tuple[str, Sequence[Any]]


def _encode(value: Any) -> dict[str, Any]:
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "integer", "value": str(int(value))}
    if isinstance(value, int):
        return {"type": "integer", "value": str(value)}
    if isinstance(value, float):
        return {"type": "float", "value": value}
    return {"type": "text", "value": str(value)}


def _decode(cell: dict[str, Any]) -> Any:
    kind = cell.get("type")
    if kind == "null":
        return None
    if kind == "integer":
        return int(cell["value"])
    if kind == "float":
        return float(cell["value"])
    return cell.get("value")


class Store:
    def __init__(self) -> None:
        url = os.environ.get("TURSO_DATABASE_URL", "").strip()
        self.remote = url.startswith(("libsql://", "https://"))
        if not self.remote and os.environ.get("GITHUB_ACTIONS") == "true":
            raise RuntimeError("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN secrets are missing in GitHub Actions")
        if self.remote:
            self.endpoint = url.replace("libsql://", "https://", 1).rstrip("/") + "/v2/pipeline"
            self.session = requests.Session()
            self.session.headers["Authorization"] = f"Bearer {os.environ['TURSO_AUTH_TOKEN']}"
        else:
            path = Path(os.environ.get("LOCAL_DB_PATH", DEFAULT_LOCAL_DB))
            path.parent.mkdir(parents=True, exist_ok=True)
            self.conn = sqlite3.connect(path)
        self.batch([(sql, ()) for sql in SCHEMA])

    def describe(self) -> str:
        return "turso" if self.remote else "local sqlite"

    def _pipeline(self, statements: Iterable[Statement]) -> list[dict[str, Any]]:
        requests_payload = [
            {"type": "execute", "stmt": {"sql": sql, "args": [_encode(a) for a in args]}}
            for sql, args in statements
        ]
        requests_payload.append({"type": "close"})
        res = self.session.post(self.endpoint, json={"requests": requests_payload}, timeout=60)
        res.raise_for_status()
        results = res.json()["results"]
        for r in results:
            if r.get("type") == "error":
                raise RuntimeError(f"Turso error: {r['error'].get('message')}")
        return results[:-1]

    def query(self, sql: str, args: Sequence[Any] = ()) -> list[dict[str, Any]]:
        if self.remote:
            result = self._pipeline([(sql, args)])[0]["response"]["result"]
            cols = [c["name"] for c in result["cols"]]
            return [dict(zip(cols, (_decode(c) for c in row))) for row in result["rows"]]
        cur = self.conn.execute(sql, args)
        cols = [d[0] for d in cur.description or []]
        return [dict(zip(cols, row)) for row in cur.fetchall()]

    def batch(self, statements: list[Statement], chunk_size: int = 500) -> None:
        """Run statements atomically per chunk (one HTTP request per chunk on Turso)."""
        for i in range(0, len(statements), chunk_size):
            chunk = statements[i : i + chunk_size]
            if self.remote:
                self._pipeline([("BEGIN", ()), *chunk, ("COMMIT", ())])
            else:
                with self.conn:
                    for sql, args in chunk:
                        self.conn.execute(sql, args)

    # Convenience helpers

    def get_json(self, table: str, key_col: str, key: str, value_col: str) -> Any:
        rows = self.query(f"SELECT {value_col} AS v FROM {table} WHERE {key_col} = ?", (key,))
        return json.loads(rows[0]["v"]) if rows else None

    @staticmethod
    def put_snapshot(kind: str, payload: Any, updated_at: str) -> Statement:
        return (
            "INSERT INTO snapshots (kind, payload, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
            (kind, json.dumps(payload, separators=(",", ":")), updated_at),
        )

    @staticmethod
    def put_meta(key: str, value: Any) -> Statement:
        return (
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value, separators=(",", ":"))),
        )

    @staticmethod
    def put_sentiment(asset_type: str, symbol: str, payload: Any, updated_at: int) -> Statement:
        return (
            "INSERT INTO sentiment (type, symbol, payload, updated_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(type, symbol) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
            (asset_type, symbol, json.dumps(payload, separators=(",", ":")), updated_at),
        )

    @staticmethod
    def append_point(asset_type: str, symbol: str, day: str, point: list[Any]) -> Statement:
        p = json.dumps(point, separators=(",", ":"))
        return (
            "INSERT INTO history (type, symbol, day, points) VALUES (?, ?, ?, json_array(json(?))) "
            "ON CONFLICT(type, symbol, day) DO UPDATE SET points = json_insert(points, '$[#]', json(?))",
            (asset_type, symbol, day, p, p),
        )
