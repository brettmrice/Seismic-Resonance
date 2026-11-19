#!/usr/bin/env python3
"""
local.py - Local development server and testing suite for Seismic Resonance.

Features:
  - Local HTTP static file server with correct MIME types for ES modules & GeoJSON.
  - Development headers: Disables browser caching to ensure live edits load instantly.
  - Auto-opens web browser on startup (can be disabled with --no-browser).
  - Built-in test suite (--test) to verify files, data integrity, HTTP serving, and USGS feeds.
"""

from __future__ import annotations

import argparse
import http.server
import json
import mimetypes
from pathlib import Path
import socket
import socketserver
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

import usgs_db

# Project root directory (location of local.py)
ROOT_DIR = Path(__file__).resolve().parent

# Ensure correct MIME type mappings, especially on Windows
mimetypes.init()
CUSTOM_MIMETYPES = {
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".geojson": "application/json",
    ".css": "text/css",
    ".html": "text/html; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}
for ext, mime in CUSTOM_MIMETYPES.items():
    mimetypes.add_type(mime, ext)


class DevHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    """
    HTTP Request Handler tailored for local frontend development:
      - Serves from ROOT_DIR
      - Enforces proper MIME types (ES modules, GeoJSON)
      - Disables browser caching for instantaneous reloading
      - Sets CORS headers for flexible local testing
    """

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        **CUSTOM_MIMETYPES,
    }
    db_path: Path = usgs_db.DEFAULT_DB_PATH

    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def _send_json(self, payload: dict | list, status_code: int = 200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/usgs/"):
            self._handle_usgs_api(parsed)
            return
        super().do_GET()

    def _handle_usgs_api(self, parsed: urllib.parse.ParseResult):
        qs = urllib.parse.parse_qs(parsed.query)

        def _arg(name: str, default: str | None = None) -> str | None:
            vals = qs.get(name)
            return vals[0] if vals and vals[0] != "" else default

        def _float_arg(name: str) -> float | None:
            v = _arg(name)
            return float(v) if v is not None else None

        def _int_arg(name: str, default: int) -> int:
            v = _arg(name)
            return int(v) if v is not None else default

        try:
            if parsed.path == "/api/usgs/status":
                self._send_json(usgs_db.get_db_status(self.db_path))
                return

            if parsed.path == "/api/usgs/summary":
                self._send_json(
                    usgs_db.get_summary(
                        self.db_path,
                        start=_arg("start"),
                        end=_arg("end"),
                    )
                )
                return

            if parsed.path == "/api/usgs/events":
                bbox_val = _arg("bbox")
                bbox_tuple = None
                if bbox_val:
                    parts = [float(x.strip()) for x in bbox_val.split(",")]
                    if len(parts) != 4:
                        self._send_json({"error": "bbox must be minlon,minlat,maxlon,maxlat"}, 400)
                        return
                    bbox_tuple = (parts[0], parts[1], parts[2], parts[3])

                rows = usgs_db.query_events(
                    self.db_path,
                    start=_arg("start"),
                    end=_arg("end"),
                    min_mag=_float_arg("minmag"),
                    max_mag=_float_arg("maxmag"),
                    min_depth=_float_arg("mindepth"),
                    max_depth=_float_arg("maxdepth"),
                    bbox=bbox_tuple,
                    place=_arg("place"),
                    event_type=_arg("type"),
                    limit=_int_arg("limit", 20000),
                    order=_arg("order", "asc") or "asc",
                )
                fmt = (_arg("format", "geojson") or "geojson").lower()
                if fmt == "json":
                    self._send_json({"count": len(rows), "events": rows})
                else:
                    self._send_json(usgs_db.rows_to_geojson(rows))
                return

            self._send_json({"error": f"Unknown endpoint: {parsed.path}"}, 404)
        except ValueError as exc:
            self._send_json({"error": f"Invalid query parameter: {exc}"}, 400)
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)

    def end_headers(self):
        # Disable caching during development
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        # Local CORS support
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, format, *args):
        # Clean logging format with timestamp
        timestamp = time.strftime("%H:%M:%S")
        sys.stderr.write(f"[{timestamp}] {self.address_string()} - {format % args}\n")


class ThreadedTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def find_available_port(host: str, start_port: int, max_attempts: int = 50) -> int:
    """Finds an open port starting from start_port."""
    for port in range(start_port, start_port + max_attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No available port found between {start_port} and {start_port + max_attempts - 1}")


def start_server(host: str = "127.0.0.1", port: int = 8000, open_browser: bool = True):
    """Starts the local development server."""
    actual_port = find_available_port(host, port)
    if actual_port != port:
        print(f"[!] Port {port} is in use. Using port {actual_port} instead.")

    server_url = f"http://{host}:{actual_port}/"

    with ThreadedTCPServer((host, actual_port), DevHTTPRequestHandler) as httpd:
        print("=" * 64)
        print("  ⚡ SEISMIC RESONANCE — Local Development Server")
        print("=" * 64)
        print(f"  Root Directory : {ROOT_DIR}")
        print(f"  Local URL      : {server_url}")
        print("  Press Ctrl+C to stop the server.")
        print("=" * 64)

        if open_browser:
            def _open():
                time.sleep(0.4)
                print(f"[>] Opening browser: {server_url}")
                webbrowser.open(server_url)

            threading.Thread(target=_open, daemon=True).start()

        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n[*] Server shutdown requested by user.")
        finally:
            httpd.server_close()
            print("[*] Server stopped cleanly.")


# ============================================================================
# Test Suite
# ============================================================================

class TestWorkspaceIntegrity(unittest.TestCase):
    """Verifies that all required files and assets exist and are valid."""

    def test_essential_files_exist(self):
        required_files = [
            "index.html",
            "styles.css",
            "src/main.js",
            "src/audio.js",
            "src/map.js",
            "src/usgs.js",
            "data/land-110m.geojson",
            "data/tectonic-plates.geojson",
        ]
        for rel_path in required_files:
            file_path = ROOT_DIR / rel_path
            self.assertTrue(file_path.is_file(), f"Missing required file: {rel_path}")
            self.assertGreater(file_path.stat().st_size, 0, f"File is empty: {rel_path}")

    def test_geojson_validity(self):
        geojson_files = [
            "data/land-110m.geojson",
            "data/tectonic-plates.geojson",
        ]
        for rel_path in geojson_files:
            file_path = ROOT_DIR / rel_path
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self.assertIn("type", data, f"GeoJSON {rel_path} missing 'type' key")
            self.assertEqual(data["type"], "FeatureCollection", f"{rel_path} should be FeatureCollection")
            self.assertIn("features", data, f"GeoJSON {rel_path} missing 'features' array")
            self.assertGreater(len(data["features"]), 0, f"{rel_path} has 0 features")

    def test_index_html_references(self):
        html_path = ROOT_DIR / "index.html"
        content = html_path.read_text(encoding="utf-8")
        self.assertIn('href="styles.css"', content)
        self.assertIn('src="src/main.js"', content)
        self.assertIn('id="map-canvas"', content)
        self.assertIn('id="audio-canvas-left"', content)
        self.assertIn('id="audio-canvas-right"', content)


class TestHTTPServer(unittest.TestCase):
    """Spins up a temporary background server instance and tests HTTP responses."""

    server: ThreadedTCPServer | None = None
    server_thread: threading.Thread | None = None
    base_url: str = ""

    @classmethod
    def setUpClass(cls):
        port = find_available_port("127.0.0.1", 9000)
        cls.server = ThreadedTCPServer(("127.0.0.1", port), DevHTTPRequestHandler)
        cls.base_url = f"http://127.0.0.1:{port}"
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        time.sleep(0.2)  # Give server brief moment to listen

    @classmethod
    def tearDownClass(cls):
        if cls.server:
            cls.server.shutdown()
            cls.server.server_close()

    def _fetch(self, path: str):
        url = f"{self.base_url}{path}"
        req = urllib.request.Request(url, headers={"User-Agent": "SeismicTestRunner/1.0"})
        return urllib.request.urlopen(req, timeout=5)

    def test_root_index_html(self):
        with self._fetch("/") as res:
            self.assertEqual(res.status, 200)
            ct = res.headers.get("Content-Type", "")
            self.assertIn("text/html", ct)
            body = res.read().decode("utf-8")
            self.assertIn("SEISMIC RESONANCE", body)

    def test_styles_css(self):
        with self._fetch("/styles.css") as res:
            self.assertEqual(res.status, 200)
            ct = res.headers.get("Content-Type", "")
            self.assertIn("text/css", ct)

    def test_javascript_mimetypes(self):
        js_files = ["/src/main.js", "/src/audio.js", "/src/map.js", "/src/usgs.js"]
        for js_path in js_files:
            with self._fetch(js_path) as res:
                self.assertEqual(res.status, 200)
                ct = res.headers.get("Content-Type", "")
                self.assertTrue(
                    "javascript" in ct or "text/javascript" in ct,
                    f"Unexpected Content-Type for {js_path}: {ct}",
                )

    def test_geojson_mimetypes(self):
        geo_files = ["/data/land-110m.geojson", "/data/tectonic-plates.geojson"]
        for geo_path in geo_files:
            with self._fetch(geo_path) as res:
                self.assertEqual(res.status, 200)
                ct = res.headers.get("Content-Type", "")
                self.assertIn("application/json", ct)
                data = json.loads(res.read().decode("utf-8"))
                self.assertEqual(data.get("type"), "FeatureCollection")

    def test_cache_control_headers(self):
        with self._fetch("/src/main.js") as res:
            cc = res.headers.get("Cache-Control", "")
            self.assertIn("no-cache", cc)
            self.assertIn("no-store", cc)

    def test_not_found(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self._fetch("/non_existent_file_xyz123.tmp")
        self.assertEqual(ctx.exception.code, 404)


class TestUSGSFeedConnectivity(unittest.TestCase):
    """Verifies that the USGS earthquake feeds are reachable online."""

    def test_usgs_feed_online(self):
        feed_url = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson"
        try:
            req = urllib.request.Request(feed_url, headers={"User-Agent": "SeismicResonanceDev/1.0"})
            with urllib.request.urlopen(req, timeout=5) as res:
                self.assertEqual(res.status, 200)
                payload = json.loads(res.read().decode("utf-8"))
                self.assertIn("features", payload)
                self.assertIn("metadata", payload)
        except (urllib.error.URLError, TimeoutError, socket.timeout) as e:
            self.skipTest(f"USGS network endpoint unreachable (offline or restricted environment): {e}")


class TestLocalUSGSDatabase(unittest.TestCase):
    """Tests local SQLite USGS database operations and /api/usgs/* HTTP endpoints."""

    def test_db_lifecycle_and_http_api(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = Path(tmpdir) / "test_usgs.db"
            conn = usgs_db.init_db(db_file)
            sample_features = [
                {
                    "type": "Feature",
                    "id": "us_test_1",
                    "properties": {
                        "mag": 5.4,
                        "place": "12 km SE of Tokyo, Japan",
                        "time": 1700000000000,
                        "updated": 1700000500000,
                        "url": "https://earthquake.usgs.gov/earthquakes/eventpage/us_test_1",
                        "tsunami": 0,
                        "sig": 450,
                        "magType": "mww",
                        "type": "earthquake",
                        "status": "reviewed",
                        "title": "M 5.4 - 12 km SE of Tokyo, Japan",
                    },
                    "geometry": {"type": "Point", "coordinates": [139.8, 35.6, 42.5]},
                },
                {
                    "type": "Feature",
                    "id": "us_test_2",
                    "properties": {
                        "mag": 2.1,
                        "place": "5 km NW of Ridgecrest, CA",
                        "time": 1700003600000,
                        "updated": 1700003900000,
                        "url": "https://earthquake.usgs.gov/earthquakes/eventpage/us_test_2",
                        "tsunami": 0,
                        "sig": 68,
                        "magType": "ml",
                        "type": "earthquake",
                        "status": "automatic",
                        "title": "M 2.1 - 5 km NW of Ridgecrest, CA",
                    },
                    "geometry": {"type": "Point", "coordinates": [-117.7, 35.65, 8.2]},
                },
            ]
            with conn:
                inserted = usgs_db.upsert_features(conn, sample_features)
            conn.close()
            self.assertEqual(inserted, 2)

            status = usgs_db.get_db_status(db_file)
            self.assertTrue(status["available"])
            self.assertEqual(status["total_events"], 2)

            filtered = usgs_db.query_events(db_file, min_mag=4.0, place="Tokyo")
            self.assertEqual(len(filtered), 1)
            self.assertEqual(filtered[0]["id"], "us_test_1")

            # Spin up a temporary HTTP handler pointed at db_file
            class TestDBHandler(DevHTTPRequestHandler):
                db_path = db_file

            port = find_available_port("127.0.0.1", 9100)
            srv = ThreadedTCPServer(("127.0.0.1", port), TestDBHandler)
            t = threading.Thread(target=srv.serve_forever, daemon=True)
            t.start()
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/usgs/status", timeout=5) as res:
                    self.assertEqual(res.status, 200)
                    st_json = json.loads(res.read().decode("utf-8"))
                    self.assertEqual(st_json["total_events"], 2)

                with urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/api/usgs/events?minmag=4.0&format=geojson",
                    timeout=5,
                ) as res:
                    self.assertEqual(res.status, 200)
                    gj = json.loads(res.read().decode("utf-8"))
                    self.assertEqual(gj["type"], "FeatureCollection")
                    self.assertEqual(len(gj["features"]), 1)
                    self.assertEqual(gj["features"][0]["id"], "us_test_1")

                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/usgs/summary", timeout=5) as res:
                    self.assertEqual(res.status, 200)
                    sm = json.loads(res.read().decode("utf-8"))
                    self.assertEqual(sm["total"], 2)
            finally:
                srv.shutdown()
                srv.server_close()


def run_tests() -> bool:
    """Runs test suite and returns True if all passed."""
    print("=" * 64)
    print("  🧪 Running Seismic Resonance Test Suite...")
    print("=" * 64)

    suite = unittest.TestSuite()
    loader = unittest.TestLoader()
    suite.addTests(loader.loadTestsFromTestCase(TestWorkspaceIntegrity))
    suite.addTests(loader.loadTestsFromTestCase(TestHTTPServer))
    suite.addTests(loader.loadTestsFromTestCase(TestLocalUSGSDatabase))
    suite.addTests(loader.loadTestsFromTestCase(TestUSGSFeedConnectivity))

    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return result.wasSuccessful()


# ============================================================================
# CLI Entry Point
# ============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="Local server and testing suite for Seismic Resonance.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "-p", "--port",
        type=int,
        default=8000,
        help="Port number to bind the server to.",
    )
    parser.add_argument(
        "-b", "--bind",
        type=str,
        default="127.0.0.1",
        help="Host address to bind the server to.",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Do not automatically launch web browser on start.",
    )
    parser.add_argument(
        "-t", "--test",
        action="store_true",
        help="Run integrity and server unit tests, then exit.",
    )

    args = parser.parse_args()

    if args.test:
        success = run_tests()
        sys.exit(0 if success else 1)

    start_server(host=args.bind, port=args.port, open_browser=not args.no_browser)


if __name__ == "__main__":
    main()
