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
import threading
import time
import unittest
import urllib.error
import urllib.request
import webbrowser

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

    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

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


def run_tests() -> bool:
    """Runs test suite and returns True if all passed."""
    print("=" * 64)
    print("  🧪 Running Seismic Resonance Test Suite...")
    print("=" * 64)

    suite = unittest.TestSuite()
    loader = unittest.TestLoader()
    suite.addTests(loader.loadTestsFromTestCase(TestWorkspaceIntegrity))
    suite.addTests(loader.loadTestsFromTestCase(TestHTTPServer))
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
