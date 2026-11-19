#!/usr/bin/env python3
"""
usgs_db.py - Local SQLite database builder & explorer for the USGS Earthquake Catalog.

Features:
  - Resumable, adaptive-chunked sync of the full USGS FDSN Event catalog (1900-present, all magnitudes).
  - Automatic window bisection when a time chunk approaches USGS's 20,000-event per-request cap.
  - Incremental `update` mode to pull newly arrived or revised events since the last sync.
  - Fast indexed SQLite storage (`data/usgs_quakes.db` by default) with WAL mode.
  - CLI exploration (`status`, `query`, `sql`) and GeoJSON/JSON/CSV/table export.
  - Reusable Python API consumed by `local.py` for Seismic Resonance's local endpoints.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import csv
from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
import random
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT_DIR = Path(__file__).resolve().parent
DEFAULT_DB_PATH = ROOT_DIR / "data" / "usgs_quakes.db"

USGS_QUERY_URL = "https://earthquake.usgs.gov/fdsnws/event/1/query"
USGS_COUNT_URL = "https://earthquake.usgs.gov/fdsnws/event/1/count"
USER_AGENT = "SeismicResonanceLocalDB/1.0"

MAX_EVENTS_PER_REQUEST = 20000
BISECT_THRESHOLD = 19500
MIN_CHUNK_SECONDS = 3600  # 1 hour minimum bisection window

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS earthquakes (
    id TEXT PRIMARY KEY,
    time_ms INTEGER NOT NULL,
    time_iso TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    depth REAL,
    mag REAL,
    mag_type TEXT,
    place TEXT,
    event_type TEXT,
    status TEXT,
    tsunami INTEGER DEFAULT 0,
    sig INTEGER,
    felt INTEGER,
    cdi REAL,
    mmi REAL,
    alert TEXT,
    nst INTEGER,
    dmin REAL,
    rms REAL,
    gap REAL,
    net TEXT,
    code TEXT,
    updated_ms INTEGER,
    url TEXT,
    title TEXT
);

CREATE INDEX IF NOT EXISTS idx_quakes_time ON earthquakes(time_ms);
CREATE INDEX IF NOT EXISTS idx_quakes_mag ON earthquakes(mag);
CREATE INDEX IF NOT EXISTS idx_quakes_time_mag ON earthquakes(time_ms, mag);
CREATE INDEX IF NOT EXISTS idx_quakes_lat_lon ON earthquakes(lat, lon);
CREATE INDEX IF NOT EXISTS idx_quakes_depth ON earthquakes(depth);
CREATE INDEX IF NOT EXISTS idx_quakes_type ON earthquakes(event_type);

CREATE TABLE IF NOT EXISTS sync_chunks (
    chunk_key TEXT PRIMARY KEY,
    start_iso TEXT NOT NULL,
    end_iso TEXT NOT NULL,
    min_mag REAL,
    status TEXT NOT NULL,
    event_count INTEGER DEFAULT 0,
    fetched_at TEXT,
    error_msg TEXT
);

CREATE TABLE IF NOT EXISTS sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def _connect(db_path: Path, readonly: bool = False) -> sqlite3.Connection:
    """Opens a SQLite connection with appropriate pragmas."""
    if readonly:
        uri = f"file:{db_path.resolve()}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=30.0)
        conn.row_factory = sqlite3.Row
        return conn

    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=60.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA temp_store=MEMORY;")
    conn.execute("PRAGMA cache_size=-65536;")  # ~64 MB page cache
    return conn


def init_db(db_path: Path = DEFAULT_DB_PATH) -> sqlite3.Connection:
    """Initializes the SQLite database schema and returns an open connection."""
    conn = _connect(db_path)
    conn.executescript(SCHEMA_SQL)
    conn.execute(
        "INSERT OR IGNORE INTO sync_meta(key, value) VALUES ('schema_version', '1')"
    )
    conn.commit()
    return conn


EPOCH_UTC = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _ms_to_dt(ms: int | float) -> datetime:
    return EPOCH_UTC + timedelta(milliseconds=float(ms))


def _ms_to_iso(ms: int | float | None) -> str:
    if ms is None:
        return ""
    dt = _ms_to_dt(ms)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def parse_time_bound(value: str | int | float | None, is_end: bool = False) -> int | None:
    """
    Parses a date/time string ('YYYY-MM-DD', ISO-8601, or epoch ms) into UTC epoch ms.
    For date-only strings, `is_end=True` resolves to 23:59:59.999 UTC of that day.
    """
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    if s.lstrip("-").isdigit():
        return int(s)
    if len(s) == 10 and s[4] == "-" and s[7] == "-":
        dt = datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        if is_end:
            dt = dt + timedelta(days=1) - timedelta(milliseconds=1)
        return int(dt.timestamp() * 1000)
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _retry_delay(attempt: int, err: Exception | None = None, cap: float = 60.0) -> float:
    """Computes jittered exponential backoff, honoring Retry-After headers on HTTP errors."""
    delay = min(cap, (2.0 ** (attempt + 1)) + random.uniform(0.25, 1.25))
    if isinstance(err, urllib.error.HTTPError) and err.headers:
        retry_after = err.headers.get("Retry-After")
        if retry_after:
            try:
                delay = max(delay, min(120.0, float(retry_after)))
            except ValueError:
                pass
    return delay


def _http_get_bytes(url: str, timeout: int = 45, max_retries: int = 6) -> bytes:
    """Fetches raw bytes from a URL with jittered backoff and Retry-After support."""
    last_err: Exception | None = None
    for attempt in range(max_retries):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code == 400:
                # Bad request (often >20,000 events limit) - do not retry blindly
                raise
            last_err = e
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(_retry_delay(attempt, e))
                continue
            raise
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_err = e
            time.sleep(_retry_delay(attempt, e, cap=30.0))
    raise RuntimeError(f"Failed after {max_retries} attempts: {url} ({last_err})")


def _http_get_json(url: str, timeout: int = 45, max_retries: int = 6) -> dict:
    """Fetches JSON from a URL with exponential backoff for transient errors."""
    last_err: Exception | None = None
    for attempt in range(max_retries):
        try:
            raw = _http_get_bytes(url, timeout=timeout, max_retries=max_retries)
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as e:
            last_err = e
            time.sleep(_retry_delay(attempt, e, cap=30.0))
    raise RuntimeError(f"Failed after {max_retries} attempts: {url} ({last_err})")


def _http_get_text(url: str, timeout: int = 30, max_retries: int = 4) -> str:
    """Fetches UTF-8 text from a URL with exponential backoff for transient errors."""
    return _http_get_bytes(url, timeout=timeout, max_retries=max_retries).decode("utf-8").strip()


def _build_usgs_params(
    start_iso: str,
    end_iso: str,
    min_mag: float | None = None,
    max_mag: float | None = None,
    fmt: str = "geojson",
) -> str:
    params: dict[str, str] = {
        "format": fmt,
        "starttime": start_iso,
        "endtime": end_iso,
    }
    if fmt == "geojson":
        params["orderby"] = "time-asc"
        params["limit"] = str(MAX_EVENTS_PER_REQUEST)
    if min_mag is not None:
        params["minmagnitude"] = str(min_mag)
    if max_mag is not None:
        params["maxmagnitude"] = str(max_mag)
    return urllib.parse.urlencode(params)


def fetch_usgs_window_recursive(
    start_dt: datetime,
    end_dt: datetime,
    min_mag: float | None = None,
    max_mag: float | None = None,
) -> list[dict]:
    """
    Fetches all USGS GeoJSON features in [start_dt, end_dt), automatically bisecting
    the time window if the event count approaches or exceeds USGS's 20,000 limit.
    """
    start_iso = start_dt.strftime("%Y-%m-%dT%H:%M:%S")
    end_iso = end_dt.strftime("%Y-%m-%dT%H:%M:%S")
    span_seconds = (end_dt - start_dt).total_seconds()

    # Check count first for windows larger than 1 day or if we want safe splitting
    query_url = f"{USGS_QUERY_URL}?{_build_usgs_params(start_iso, end_iso, min_mag, max_mag, 'geojson')}"
    try:
        payload = _http_get_json(query_url)
        features = payload.get("features") or []
        if len(features) >= BISECT_THRESHOLD and span_seconds > MIN_CHUNK_SECONDS:
            mid_dt = start_dt + (end_dt - start_dt) / 2
            return fetch_usgs_window_recursive(start_dt, mid_dt, min_mag, max_mag) + \
                   fetch_usgs_window_recursive(mid_dt, end_dt, min_mag, max_mag)
        return features
    except urllib.error.HTTPError as e:
        if e.code == 400 and span_seconds > MIN_CHUNK_SECONDS:
            # Almost certainly exceeded 20,000 events; bisect and retry
            mid_dt = start_dt + (end_dt - start_dt) / 2
            return fetch_usgs_window_recursive(start_dt, mid_dt, min_mag, max_mag) + \
                   fetch_usgs_window_recursive(mid_dt, end_dt, min_mag, max_mag)
        if e.code == 204:
            return []
        raise


def feature_to_row(feature: dict) -> tuple | None:
    """Converts a USGS GeoJSON Feature into a tuple matching the `earthquakes` table."""
    event_id = feature.get("id")
    if not event_id:
        return None
    coords = (feature.get("geometry") or {}).get("coordinates") or []
    if len(coords) < 2:
        return None
    lon, lat = coords[0], coords[1]
    depth = coords[2] if len(coords) > 2 else None
    if lon is None or lat is None:
        return None

    props = feature.get("properties") or {}
    time_ms = props.get("time")
    if time_ms is None:
        return None
    time_ms = int(time_ms)
    time_iso = _ms_to_iso(time_ms)

    return (
        str(event_id),
        time_ms,
        time_iso,
        float(lat),
        float(lon),
        float(depth) if depth is not None else None,
        float(props["mag"]) if props.get("mag") is not None else None,
        props.get("magType"),
        props.get("place"),
        props.get("type"),
        props.get("status"),
        int(props.get("tsunami") or 0),
        int(props["sig"]) if props.get("sig") is not None else None,
        int(props["felt"]) if props.get("felt") is not None else None,
        float(props["cdi"]) if props.get("cdi") is not None else None,
        float(props["mmi"]) if props.get("mmi") is not None else None,
        props.get("alert"),
        int(props["nst"]) if props.get("nst") is not None else None,
        float(props["dmin"]) if props.get("dmin") is not None else None,
        float(props["rms"]) if props.get("rms") is not None else None,
        float(props["gap"]) if props.get("gap") is not None else None,
        props.get("net"),
        props.get("code"),
        int(props["updated"]) if props.get("updated") is not None else None,
        props.get("url"),
        props.get("title"),
    )


INSERT_SQL = """
INSERT OR REPLACE INTO earthquakes (
    id, time_ms, time_iso, lat, lon, depth, mag, mag_type, place,
    event_type, status, tsunami, sig, felt, cdi, mmi, alert,
    nst, dmin, rms, gap, net, code, updated_ms, url, title
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


def upsert_features(conn: sqlite3.Connection, features: list[dict]) -> int:
    """Inserts or replaces a batch of GeoJSON features into `earthquakes`."""
    rows = []
    for f in features:
        row = feature_to_row(f)
        if row is not None:
            rows.append(row)
    if not rows:
        return 0
    conn.executemany(INSERT_SQL, rows)
    return len(rows)


def generate_chunks(start_dt: datetime, end_dt: datetime) -> list[tuple[datetime, datetime]]:
    """
    Generates adaptive time chunks between `start_dt` and `end_dt`:
      - Before 1970: 365-day chunks
      - 1970-1999: 90-day chunks
      - 2000-present: 14-day chunks
    """
    chunks: list[tuple[datetime, datetime]] = []
    cur = start_dt
    while cur < end_dt:
        if cur.year < 1970:
            step = timedelta(days=365)
        elif cur.year < 2000:
            step = timedelta(days=90)
        else:
            step = timedelta(days=14)
        nxt = min(end_dt, cur + step)
        chunks.append((cur, nxt))
        cur = nxt
    return chunks


def sync_catalog(
    db_path: Path = DEFAULT_DB_PATH,
    start_date: str = "1900-01-01",
    end_date: str | None = None,
    min_mag: float | None = None,
    max_mag: float | None = None,
    workers: int = 3,
    force: bool = False,
) -> dict:
    """
    Performs a resumable, chunked sync of the USGS earthquake catalog into SQLite.
    """
    start_ms = parse_time_bound(start_date, is_end=False)
    assert start_ms is not None
    start_dt = _ms_to_dt(start_ms)

    if end_date:
        end_ms = parse_time_bound(end_date, is_end=True)
        assert end_ms is not None
        end_dt = _ms_to_dt(end_ms)
    else:
        end_dt = datetime.now(timezone.utc)

    conn = init_db(db_path)
    chunks = generate_chunks(start_dt, end_dt)

    # Filter out already-completed chunks unless force=True
    done_keys: set[str] = set()
    if not force:
        cur = conn.execute("SELECT chunk_key FROM sync_chunks WHERE status = 'done'")
        done_keys = {row[0] for row in cur.fetchall()}

    pending: list[tuple[str, datetime, datetime]] = []
    for c_start, c_end in chunks:
        s_iso = c_start.strftime("%Y-%m-%dT%H:%M:%S")
        e_iso = c_end.strftime("%Y-%m-%dT%H:%M:%S")
        key = f"{s_iso}..{e_iso}|min={min_mag}|max={max_mag}"
        if key not in done_keys:
            pending.append((key, c_start, c_end))

    total_chunks = len(chunks)
    already_done = total_chunks - len(pending)
    print(f"[*] Database     : {db_path}")
    print(f"[*] Range        : {start_dt.strftime('%Y-%m-%d')} -> {end_dt.strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"[*] Total chunks : {total_chunks} (already done: {already_done}, remaining: {len(pending)})")

    if not pending:
        print("[+] All chunks in this range are already synced.")
        conn.close()
        return {"chunks_processed": 0, "events_upserted": 0}

    processed = 0
    total_inserted = 0
    errors = 0
    t0 = time.time()

    def _worker(item: tuple[str, datetime, datetime]) -> tuple[str, datetime, datetime, list[dict], str | None]:
        key, c_start, c_end = item
        try:
            features = fetch_usgs_window_recursive(c_start, c_end, min_mag=min_mag, max_mag=max_mag)
            return (key, c_start, c_end, features, None)
        except Exception as exc:
            return (key, c_start, c_end, [], str(exc))

    try:
        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            futures = [pool.submit(_worker, item) for item in pending]
            for fut in as_completed(futures):
                key, c_start, c_end, features, err = fut.result()
                processed += 1
                if err:
                    errors += 1
                    with conn:
                        conn.execute(
                            """
                            INSERT OR REPLACE INTO sync_chunks
                            (chunk_key, start_iso, end_iso, min_mag, status, event_count, fetched_at, error_msg)
                            VALUES (?, ?, ?, ?, 'error', 0, ?, ?)
                            """,
                            (
                                key,
                                c_start.strftime("%Y-%m-%dT%H:%M:%S"),
                                c_end.strftime("%Y-%m-%dT%H:%M:%S"),
                                min_mag,
                                datetime.now(timezone.utc).isoformat(),
                                err,
                            ),
                        )
                    print(f"[!] Chunk {c_start:%Y-%m-%d}..{c_end:%Y-%m-%d} ERROR: {err}")
                else:
                    with conn:
                        count = upsert_features(conn, features)
                        conn.execute(
                            """
                            INSERT OR REPLACE INTO sync_chunks
                            (chunk_key, start_iso, end_iso, min_mag, status, event_count, fetched_at, error_msg)
                            VALUES (?, ?, ?, ?, 'done', ?, ?, NULL)
                            """,
                            (
                                key,
                                c_start.strftime("%Y-%m-%dT%H:%M:%S"),
                                c_end.strftime("%Y-%m-%dT%H:%M:%S"),
                                min_mag,
                                count,
                                datetime.now(timezone.utc).isoformat(),
                            ),
                        )
                    total_inserted += count
                    elapsed = max(0.1, time.time() - t0)
                    rate = processed / elapsed
                    eta_s = int((len(pending) - processed) / rate) if rate > 0 else 0
                    print(
                        f"[{processed}/{len(pending)}] {c_start:%Y-%m-%d}..{c_end:%Y-%m-%d} "
                        f"+{count:,} events (total +{total_inserted:,}, ETA ~{eta_s}s)"
                    )
    finally:
        conn.execute(
            "INSERT OR REPLACE INTO sync_meta(key, value) VALUES ('last_sync_iso', ?)",
            (datetime.now(timezone.utc).isoformat(),),
        )
        conn.commit()
        conn.close()

    print(f"[+] Sync finished: {processed} chunks, +{total_inserted:,} events, {errors} errors.")
    return {"chunks_processed": processed, "events_upserted": total_inserted, "errors": errors}


def update_catalog(db_path: Path = DEFAULT_DB_PATH, lookback_hours: int = 2) -> dict:
    """Incrementally fetches events from (max_time_ms - lookback_hours) to now."""
    if not db_path.exists():
        print("[!] Database does not exist yet. Running initial recent 30-day sync or use `sync` for full history.")
        start_dt = datetime.now(timezone.utc) - timedelta(days=30)
        return sync_catalog(db_path=db_path, start_date=start_dt.strftime("%Y-%m-%dT%H:%M:%S"))

    conn = init_db(db_path)
    row = conn.execute("SELECT MAX(time_ms) FROM earthquakes").fetchone()
    max_ms = row[0] if row else None
    conn.close()

    if max_ms is None:
        start_dt = datetime.now(timezone.utc) - timedelta(days=30)
    else:
        start_dt = _ms_to_dt(max_ms) - timedelta(hours=lookback_hours)

    return sync_catalog(
        db_path=db_path,
        start_date=start_dt.strftime("%Y-%m-%dT%H:%M:%S"),
        force=True,
    )


def get_db_status(db_path: Path = DEFAULT_DB_PATH) -> dict:
    """Returns summary metadata and statistics for the local SQLite database."""
    if not db_path.exists():
        return {
            "available": False,
            "db_path": str(db_path),
            "db_size_bytes": 0,
            "total_events": 0,
            "min_time_ms": None,
            "max_time_ms": None,
            "min_time_iso": None,
            "max_time_iso": None,
            "chunks_done": 0,
            "chunks_error": 0,
            "last_sync_iso": None,
        }

    conn = _connect(db_path, readonly=True)
    try:
        agg = conn.execute(
            "SELECT COUNT(*), MIN(time_ms), MAX(time_ms), MIN(mag), MAX(mag) FROM earthquakes"
        ).fetchone()
        total = int(agg[0] or 0)
        min_ms = agg[1]
        max_ms = agg[2]
        min_mag = agg[3]
        max_mag = agg[4]

        chunks_done = conn.execute(
            "SELECT COUNT(*) FROM sync_chunks WHERE status = 'done'"
        ).fetchone()[0]
        chunks_error = conn.execute(
            "SELECT COUNT(*) FROM sync_chunks WHERE status = 'error'"
        ).fetchone()[0]
        meta_row = conn.execute(
            "SELECT value FROM sync_meta WHERE key = 'last_sync_iso'"
        ).fetchone()
        last_sync = meta_row[0] if meta_row else None
    except sqlite3.Error:
        return {
            "available": False,
            "db_path": str(db_path),
            "db_size_bytes": db_path.stat().st_size,
            "total_events": 0,
        }
    finally:
        conn.close()

    return {
        "available": total > 0,
        "db_path": str(db_path),
        "db_size_bytes": db_path.stat().st_size,
        "total_events": total,
        "min_time_ms": min_ms,
        "max_time_ms": max_ms,
        "min_time_iso": _ms_to_iso(min_ms) if min_ms is not None else None,
        "max_time_iso": _ms_to_iso(max_ms) if max_ms is not None else None,
        "min_mag": min_mag,
        "max_mag": max_mag,
        "chunks_done": int(chunks_done),
        "chunks_error": int(chunks_error),
        "last_sync_iso": last_sync,
    }


def query_events(
    db_path: Path = DEFAULT_DB_PATH,
    start: str | int | None = None,
    end: str | int | None = None,
    min_mag: float | None = None,
    max_mag: float | None = None,
    min_depth: float | None = None,
    max_depth: float | None = None,
    bbox: tuple[float, float, float, float] | None = None,
    place: str | None = None,
    event_type: str | None = None,
    tsunami: int | None = None,
    limit: int = 20000,
    order: str = "asc",
) -> list[dict]:
    """Queries earthquakes from the local SQLite database with flexible filters."""
    if not db_path.exists():
        return []

    clauses: list[str] = []
    params: list = []

    start_ms = parse_time_bound(start, is_end=False)
    if start_ms is not None:
        clauses.append("time_ms >= ?")
        params.append(start_ms)

    end_ms = parse_time_bound(end, is_end=True)
    if end_ms is not None:
        clauses.append("time_ms <= ?")
        params.append(end_ms)

    if min_mag is not None:
        clauses.append("mag >= ?")
        params.append(float(min_mag))

    if max_mag is not None:
        clauses.append("mag <= ?")
        params.append(float(max_mag))

    if min_depth is not None:
        clauses.append("depth >= ?")
        params.append(float(min_depth))

    if max_depth is not None:
        clauses.append("depth <= ?")
        params.append(float(max_depth))

    if bbox is not None:
        min_lon, min_lat, max_lon, max_lat = bbox
        clauses.append("lon >= ? AND lon <= ? AND lat >= ? AND lat <= ?")
        params.extend([float(min_lon), float(max_lon), float(min_lat), float(max_lat)])

    if place:
        clauses.append("place LIKE ?")
        params.append(f"%{place}%")

    if event_type:
        clauses.append("event_type = ?")
        params.append(event_type)

    if tsunami is not None:
        clauses.append("tsunami = ?")
        params.append(int(tsunami))

    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    order_dir = "DESC" if str(order).lower() == "desc" else "ASC"
    safe_limit = max(1, min(int(limit), 200000))

    sql = f"""
        SELECT id, time_ms, time_iso, lat, lon, depth, mag, mag_type, place,
               event_type, status, tsunami, sig, felt, cdi, mmi, alert,
               nst, dmin, rms, gap, net, code, updated_ms, url, title
        FROM earthquakes
        {where_sql}
        ORDER BY time_ms {order_dir}
        LIMIT ?
    """
    params.append(safe_limit)

    conn = _connect(db_path, readonly=True)
    try:
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def rows_to_geojson(rows: list[dict], title: str = "USGS Local SQLite Catalog") -> dict:
    """Converts database rows into a USGS-compatible GeoJSON FeatureCollection."""
    features = []
    for r in rows:
        features.append({
            "type": "Feature",
            "id": r["id"],
            "properties": {
                "mag": r["mag"],
                "place": r["place"],
                "time": r["time_ms"],
                "updated": r["updated_ms"],
                "url": r["url"] or "",
                "tsunami": r["tsunami"] or 0,
                "sig": r["sig"],
                "magType": r["mag_type"],
                "type": r["event_type"],
                "status": r["status"],
                "title": r["title"],
                "alert": r["alert"],
            },
            "geometry": {
                "type": "Point",
                "coordinates": [
                    r["lon"],
                    r["lat"],
                    r["depth"] if r["depth"] is not None else 10.0,
                ],
            },
        })
    return {
        "type": "FeatureCollection",
        "metadata": {
            "generated": int(time.time() * 1000),
            "title": title,
            "status": 200,
            "count": len(features),
            "source": "local-sqlite",
        },
        "features": features,
    }


def get_summary(
    db_path: Path = DEFAULT_DB_PATH,
    start: str | int | None = None,
    end: str | int | None = None,
) -> dict:
    """Computes magnitude-bin and depth-bin summary statistics for a time window."""
    if not db_path.exists():
        return {"total": 0, "magnitude_bins": [], "depth_bins": []}

    clauses: list[str] = []
    params: list = []
    start_ms = parse_time_bound(start, is_end=False)
    if start_ms is not None:
        clauses.append("time_ms >= ?")
        params.append(start_ms)
    end_ms = parse_time_bound(end, is_end=True)
    if end_ms is not None:
        clauses.append("time_ms <= ?")
        params.append(end_ms)
    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    conn = _connect(db_path, readonly=True)
    try:
        total = conn.execute(f"SELECT COUNT(*) FROM earthquakes {where_sql}", params).fetchone()[0]
        mag_rows = conn.execute(
            f"""
            SELECT
                CASE
                    WHEN mag IS NULL THEN 'unknown'
                    WHEN mag < 2.0 THEN '<2.0'
                    WHEN mag < 4.0 THEN '2.0-3.9'
                    WHEN mag < 6.0 THEN '4.0-5.9'
                    WHEN mag < 7.0 THEN '6.0-6.9'
                    ELSE '7.0+'
                END AS bin,
                COUNT(*) AS cnt
            FROM earthquakes {where_sql}
            GROUP BY bin
            """,
            params,
        ).fetchall()
        depth_rows = conn.execute(
            f"""
            SELECT
                CASE
                    WHEN depth IS NULL THEN 'unknown'
                    WHEN depth < 70 THEN 'shallow (<70km)'
                    WHEN depth < 300 THEN 'mid (70-300km)'
                    ELSE 'deep (>=300km)'
                END AS bin,
                COUNT(*) AS cnt
            FROM earthquakes {where_sql}
            GROUP BY bin
            """,
            params,
        ).fetchall()
        return {
            "total": int(total),
            "magnitude_bins": {r["bin"]: r["cnt"] for r in mag_rows},
            "depth_bins": {r["bin"]: r["cnt"] for r in depth_rows},
        }
    finally:
        conn.close()


def _format_table(rows: list[dict], columns: list[str] | None = None) -> str:
    if not rows:
        return "(0 rows)"
    cols = columns or list(rows[0].keys())
    widths = {c: len(c) for c in cols}
    str_rows = []
    for r in rows:
        sr = {}
        for c in cols:
            val = r.get(c)
            s = "" if val is None else str(val)
            if len(s) > 48:
                s = s[:45] + "..."
            sr[c] = s
            widths[c] = max(widths[c], len(s))
        str_rows.append(sr)

    header = " | ".join(c.ljust(widths[c]) for c in cols)
    sep = "-+-".join("-" * widths[c] for c in cols)
    lines = [header, sep]
    for sr in str_rows:
        lines.append(" | ".join(sr[c].ljust(widths[c]) for c in cols))
    return "\n".join(lines)


def _format_csv(rows: list[dict], columns: list[str] | None = None) -> str:
    if not rows:
        return ""
    cols = columns or list(rows[0].keys())
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue()


def main():
    parser = argparse.ArgumentParser(
        description="Local SQLite database builder and explorer for USGS Earthquake data.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH, help="Path to SQLite database file.")
    sub = parser.add_subparsers(dest="command", required=True)

    # sync
    p_sync = sub.add_parser("sync", help="Resumable full or windowed sync from USGS FDSN Event API.")
    p_sync.add_argument("--start-date", default="1900-01-01", help="Start date (YYYY-MM-DD or ISO-8601).")
    p_sync.add_argument("--end-date", default=None, help="End date (defaults to current UTC time).")
    p_sync.add_argument("--min-mag", type=float, default=None, help="Minimum magnitude filter.")
    p_sync.add_argument("--max-mag", type=float, default=None, help="Maximum magnitude filter.")
    p_sync.add_argument("--workers", type=int, default=3, help="Concurrent HTTP fetch workers.")
    p_sync.add_argument("--force", action="store_true", help="Re-fetch chunks even if marked done.")

    # update
    p_upd = sub.add_parser("update", help="Incremental update from latest event in DB to now.")
    p_upd.add_argument("--lookback-hours", type=int, default=2, help="Overlap hours to catch revised events.")

    # status
    sub.add_parser("status", help="Show local database statistics and sync progress.")

    # query
    p_q = sub.add_parser("query", help="Query events from the local database.")
    p_q.add_argument("--start-date", default=None, help="Start date/time (YYYY-MM-DD or ISO).")
    p_q.add_argument("--end-date", default=None, help="End date/time (YYYY-MM-DD or ISO).")
    p_q.add_argument("--min-mag", type=float, default=None, help="Minimum magnitude.")
    p_q.add_argument("--max-mag", type=float, default=None, help="Maximum magnitude.")
    p_q.add_argument("--min-depth", type=float, default=None, help="Minimum depth (km).")
    p_q.add_argument("--max-depth", type=float, default=None, help="Maximum depth (km).")
    p_q.add_argument("--bbox", default=None, help="Bounding box: minlon,minlat,maxlon,maxlat.")
    p_q.add_argument("--place", default=None, help="Substring match on place.")
    p_q.add_argument("--type", dest="event_type", default=None, help="Event type (e.g. earthquake).")
    p_q.add_argument("--limit", type=int, default=25, help="Max events to return.")
    p_q.add_argument("--order", choices=["asc", "desc"], default="desc", help="Sort order by time.")
    p_q.add_argument("--format", choices=["table", "json", "geojson", "csv"], default="table", help="Output format.")
    p_q.add_argument("--out", type=Path, default=None, help="Optional file path to write output.")

    # sql
    p_sql = sub.add_parser("sql", help="Run a read-only SQL SELECT query against the local database.")
    p_sql.add_argument("statement", help="SQL query (read-only).")
    p_sql.add_argument("--format", choices=["table", "json", "csv"], default="table", help="Output format.")

    args = parser.parse_args()

    if args.command == "sync":
        sync_catalog(
            db_path=args.db,
            start_date=args.start_date,
            end_date=args.end_date,
            min_mag=args.min_mag,
            max_mag=args.max_mag,
            workers=args.workers,
            force=args.force,
        )
    elif args.command == "update":
        update_catalog(db_path=args.db, lookback_hours=args.lookback_hours)
    elif args.command == "status":
        st = get_db_status(args.db)
        print(json.dumps(st, indent=2))
        if st.get("available"):
            summary = get_summary(args.db)
            print("\nSummary:")
            print(json.dumps(summary, indent=2))
    elif args.command == "query":
        bbox_tuple = None
        if args.bbox:
            parts = [float(x.strip()) for x in args.bbox.split(",")]
            if len(parts) != 4:
                parser.error("--bbox must be minlon,minlat,maxlon,maxlat")
            bbox_tuple = (parts[0], parts[1], parts[2], parts[3])

        rows = query_events(
            db_path=args.db,
            start=args.start_date,
            end=args.end_date,
            min_mag=args.min_mag,
            max_mag=args.max_mag,
            min_depth=args.min_depth,
            max_depth=args.max_depth,
            bbox=bbox_tuple,
            place=args.place,
            event_type=args.event_type,
            limit=args.limit,
            order=args.order,
        )
        if args.format == "geojson":
            output = json.dumps(rows_to_geojson(rows), indent=2)
        elif args.format == "json":
            output = json.dumps(rows, indent=2)
        elif args.format == "csv":
            output = _format_csv(rows)
        else:
            output = _format_table(rows, ["id", "time_iso", "mag", "depth", "lat", "lon", "place"])

        if args.out:
            args.out.write_text(output, encoding="utf-8")
            print(f"[+] Wrote {len(rows)} rows to {args.out}")
        else:
            print(output)
    elif args.command == "sql":
        if not args.db.exists():
            print(f"[!] Database not found: {args.db}", file=sys.stderr)
            sys.exit(1)
        conn = _connect(args.db, readonly=True)
        try:
            rows = [dict(r) for r in conn.execute(args.statement).fetchall()]
        finally:
            conn.close()
        if args.format == "json":
            print(json.dumps(rows, indent=2))
        elif args.format == "csv":
            print(_format_csv(rows))
        else:
            print(_format_table(rows))


if __name__ == "__main__":
    main()
