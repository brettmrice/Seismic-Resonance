#!/usr/bin/env python3
"""
recorder/record.py - Offline & Scheduled Stream Recorder for Seismic Resonance.

Records a 1-cycle time-lapse pass (default: yesterday's 24H All Quakes stream)
with stereo sub-bass Web Audio synthesis using headless Chromium (Playwright)
and bundled FFmpeg (imageio-ffmpeg), outputting a local .mp4 or .webm video.
"""

from __future__ import annotations

import argparse
from collections import deque
from datetime import datetime, timedelta, timezone
import http.server
import json
import os
from pathlib import Path
import platform
import queue
import shutil
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

RECORDER_DIR = Path(__file__).resolve().parent
REPO_ROOT = RECORDER_DIR.parent
DEFAULT_CONFIG_PATH = RECORDER_DIR / "config.default.json"
CACHE_DIR = RECORDER_DIR / "cache"

# Ensure repo root is importable so we can reuse local.py's HTTP handler
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from local import DevHTTPRequestHandler  # noqa: E402

RESOLUTION_PRESETS = {
    "720p": (1280, 720),
    "1080p": (1920, 1080),
    "4k": (3840, 2160),
    "8k": (7680, 4320),
}

QUALITY_CRF = {
    "low": "28",
    "medium": "23",
    "high": "18",
    "lossless": "12",
}


def resolve_date_range(date_arg: str | None, start_date: str | None, end_date: str | None) -> tuple[str, str]:
    """Resolves 'yesterday', 'today', or explicit local YYYY-MM-DD strings into (start_date, end_date)."""
    if start_date:
        return start_date, end_date or start_date

    now_local = datetime.now().astimezone().date()
    token = (date_arg or "yesterday").strip().lower()
    if token == "yesterday":
        d = (now_local - timedelta(days=1)).isoformat()
        return d, d
    if token == "today":
        d = now_local.isoformat()
        return d, d
    return date_arg, date_arg  # type: ignore[return-value]


def local_date_boundary_to_iso(date_str: str, is_end: bool = False) -> str:
    """Converts a local YYYY-MM-DD date string to a UTC ISO-8601 timestamp for USGS queries."""
    if "T" in date_str:
        return date_str
    local_tz = datetime.now().astimezone().tzinfo
    y, m, d = (int(part) for part in date_str.split("-"))
    dt = datetime(y, m, d, 23 if is_end else 0, 59 if is_end else 0, 59 if is_end else 0, tzinfo=local_tz)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_output_path(cfg: dict, resolved_start: str, resolved_end: str) -> Path:
    """Computes the final output file path from --out or --output-dir + --name template."""
    if cfg.get("out"):
        p = Path(cfg["out"])
        if not p.is_absolute():
            p = REPO_ROOT / p
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    out_dir = Path(cfg.get("output_dir") or "recorder/output")
    if not out_dir.is_absolute():
        out_dir = REPO_ROOT / out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    date_label = resolved_start if resolved_start == resolved_end else f"{resolved_start}_to_{resolved_end}"
    res_label = f"{cfg['width']}x{cfg['height']}"
    ext = (cfg.get("format") or "mp4").lower().lstrip(".")
    tmpl = cfg.get("filename_template") or "seismic_{date}_{speed}x_{res}.{ext}"
    filename = tmpl.format(
        date=date_label,
        speed=cfg.get("speed", 360),
        res=res_label,
        fps=cfg.get("fps", 30),
        ext=ext,
    )
    if not filename.lower().endswith(f".{ext}"):
        filename = f"{Path(filename).stem}.{ext}"
    return out_dir / filename


def fetch_or_load_geojson(
    start_date: str,
    end_date: str,
    min_mag: float,
    max_mag: float,
    geojson_path: str | None = None,
    feed: str | None = None,
    offline: bool = False,
) -> Path:
    """
    Returns a local .geojson file path inside the repo so the browser can load it
    completely locally during recording.
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    if geojson_path:
        src = Path(geojson_path)
        if not src.is_absolute():
            src = REPO_ROOT / src
        if not src.exists():
            raise FileNotFoundError(f"GeoJSON file not found: {src}")
        dest = CACHE_DIR / f"custom_{src.name}"
        if src.resolve() != dest.resolve():
            shutil.copy2(src, dest)
        return dest

    if feed:
        cache_file = CACHE_DIR / f"feed_{feed}.geojson"
        if offline:
            if not cache_file.exists():
                raise FileNotFoundError(f"Offline mode requested, but cached feed missing: {cache_file}")
            return cache_file
        url = f"https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/{feed}.geojson"
    else:
        tag = f"{start_date}_{end_date}_m{min_mag:.1f}-{max_mag:.1f}"
        cache_file = CACHE_DIR / f"usgs_{tag}.geojson"
        if offline:
            if not cache_file.exists():
                raise FileNotFoundError(f"Offline mode requested, but cached dataset missing: {cache_file}")
            return cache_file
        params = {
            "format": "geojson",
            "starttime": local_date_boundary_to_iso(start_date, is_end=False),
            "endtime": local_date_boundary_to_iso(end_date, is_end=True),
            "orderby": "time-asc",
            "limit": "20000",
        }
        if min_mag > 0:
            params["minmagnitude"] = str(min_mag)
        if max_mag < 10:
            params["maxmagnitude"] = str(max_mag)
        url = f"https://earthquake.usgs.gov/fdsnws/event/1/query?{urllib.parse.urlencode(params)}"

    print(f"[*] Fetching seismic dataset: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "SeismicResonanceRecorder/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read()
    # Validate JSON before writing cache
    parsed = json.loads(raw.decode("utf-8"))
    count = len(parsed.get("features", []))
    cache_file.write_bytes(raw)
    print(f"[+] Cached {count} events to {cache_file.relative_to(REPO_ROOT)}")
    return cache_file


class FramePipeWriter:
    """Bounded async queue + writer thread to decouple HTTP frame uploads from FFmpeg stdin backpressure."""

    def __init__(self, sink, max_queued: int = 12):
        self._sink = sink
        self._queue: queue.Queue[bytes | None] = queue.Queue(maxsize=max_queued)
        self._closed = False
        self.error: BaseException | None = None
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        try:
            while True:
                item = self._queue.get()
                if item is None:
                    break
                self._sink.write(item)
        except BaseException as exc:
            self.error = exc
        finally:
            # Drain any remaining items so producers never block on a full queue
            while not self._queue.empty():
                try:
                    self._queue.get_nowait()
                except queue.Empty:
                    break

    def enqueue(self, data: bytes, timeout: float = 120.0):
        if self.error is not None:
            raise RuntimeError(f"FFmpeg pipe writer failed: {self.error}") from self.error
        if self._closed:
            raise RuntimeError("FramePipeWriter is already closed")
        deadline = time.monotonic() + timeout
        while True:
            if self.error is not None:
                raise RuntimeError(f"FFmpeg pipe writer failed: {self.error}") from self.error
            try:
                self._queue.put(data, timeout=0.25)
                return
            except queue.Full:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Timed out waiting for FFmpeg pipe writer")

    def close(self):
        if self._closed:
            return
        self._closed = True
        try:
            self._queue.put(None, timeout=5.0)
        except queue.Full:
            pass
        self._thread.join(timeout=10.0)


class RecorderHTTPServer:
    """Ephemeral local static server with offline frame, audio, and upload endpoints."""

    def __init__(self, upload_dest: Path, audio_dest: Path | None = None):
        self.upload_dest = upload_dest
        self.audio_dest = audio_dest
        self.upload_done = threading.Event()
        self.audio_done = threading.Event()
        self.upload_meta: dict = {}
        self.audio_meta: dict = {}
        self.frame_writer: FramePipeWriter | None = None
        self.frame_count = 0
        self._count_lock = threading.Lock()
        self.port = self._find_free_port()
        self.httpd: socketserver.TCPServer | None = None
        self.thread: threading.Thread | None = None

    @staticmethod
    def _find_free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            return int(s.getsockname()[1])

    def start(self) -> str:
        parent = self

        class Handler(DevHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def setup(self):
                super().setup()
                self.request.settimeout(120)

            def log_message(self, format, *args):
                pass  # Quiet during headless capture

            def _send_ok_json(self):
                payload = b'{"ok":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                if self.path == "/__recorder_frame":
                    if parent.frame_writer is None:
                        self.send_error(503, "Frame writer not ready")
                        return
                    body = self.rfile.read(length)
                    if len(body) != length:
                        self.send_error(400, "Incomplete frame body")
                        return
                    try:
                        parent.frame_writer.enqueue(body)
                    except Exception as exc:
                        self.send_error(500, f"Frame sink error: {exc}")
                        return
                    if self.headers.get("X-Chunk-Final", "1") == "1":
                        with parent._count_lock:
                            parent.frame_count += 1
                    self._send_ok_json()
                    return

                if self.path == "/__recorder_audio":
                    chunk_index = int(self.headers.get("X-Chunk-Index", "0") or 0)
                    is_final = self.headers.get("X-Chunk-Final", "1") == "1"
                    if parent.audio_dest is not None:
                        parent.audio_dest.parent.mkdir(parents=True, exist_ok=True)
                        mode = "wb" if chunk_index == 0 else "ab"
                        with open(parent.audio_dest, mode) as f:
                            remaining = length
                            while remaining > 0:
                                chunk = self.rfile.read(min(remaining, 4 * 1024 * 1024))
                                if not chunk:
                                    break
                                f.write(chunk)
                                remaining -= len(chunk)
                    else:
                        remaining = length
                        while remaining > 0:
                            chunk = self.rfile.read(min(remaining, 4 * 1024 * 1024))
                            if not chunk:
                                break
                            remaining -= len(chunk)
                    if is_final:
                        total_bytes = parent.audio_dest.stat().st_size if parent.audio_dest and parent.audio_dest.exists() else length
                        parent.audio_meta = {
                            "channels": int(self.headers.get("X-Audio-Channels", "2") or 2),
                            "sample_rate": int(self.headers.get("X-Audio-Sample-Rate", "48000") or 48000),
                            "bit_depth": int(self.headers.get("X-Audio-Bit-Depth", "16") or 16),
                            "bytes": total_bytes,
                        }
                        parent.audio_done.set()
                    self._send_ok_json()
                    return

                if self.path == "/__recorder_upload":
                    body = self.rfile.read(length)
                    parent.upload_dest.parent.mkdir(parents=True, exist_ok=True)
                    parent.upload_dest.write_bytes(body)
                    parent.upload_meta = {
                        "content_type": self.headers.get("Content-Type", "video/webm"),
                        "events": int(self.headers.get("X-Recorder-Events", "0") or 0),
                        "bytes": len(body),
                    }
                    parent.upload_done.set()
                    self._send_ok_json()
                    return

                self.send_error(404)

        class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
            allow_reuse_address = True
            daemon_threads = True
            request_queue_size = 64

        self.httpd = Server(("127.0.0.1", self.port), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        return f"http://127.0.0.1:{self.port}"

    def stop(self):
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()


def transcode_to_mp4(raw_path: Path, out_path: Path, width: int, height: int, fps: int, quality: str, channels: int = 2, audio_quality: str = "high"):
    """Transcodes and scales raw browser MediaRecorder capture into H.264 + AAC .mp4."""
    import imageio_ffmpeg

    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    crf = QUALITY_CRF.get(quality, "18")
    if audio_quality == "ultra":
        audio_bitrate = "320k" if channels <= 2 else "640k" if channels <= 6 else "768k"
    elif audio_quality == "high":
        audio_bitrate = "192k" if channels <= 1 else "320k" if channels <= 2 else "512k" if channels <= 6 else "640k"
    else:
        audio_bitrate = "128k" if channels <= 1 else "192k" if channels <= 2 else "384k" if channels <= 6 else "512k"

    cmd = [
        ffmpeg_exe,
        "-y",
        "-i",
        str(raw_path),
        "-vf",
        f"scale={width}:{height}:flags=lanczos",
        "-r",
        str(fps),
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        crf,
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ac",
        str(channels),
        "-b:a",
        audio_bitrate,
        "-movflags",
        "+faststart",
        str(out_path),
    ]
    print(f"[*] Encoding final MP4 ({width}x{height} @ {fps}fps, {channels}ch audio, CRF={crf})...")
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg failed ({proc.returncode}):\n{proc.stderr[-1000:]}")


def select_h264_encoder_args(ffmpeg_exe: str, crf: str, high_res_pixels: int, allow_hw: bool = True) -> list[str]:
    """Selects the fastest working H.264 encoder (probing GPU hardware encoders first, then libx264)."""
    if allow_hw:
        hw_candidates = [
            ("h264_nvenc", ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", crf, "-pix_fmt", "yuv420p"]),
            ("h264_qsv", ["-c:v", "h264_qsv", "-preset", "faster", "-global_quality", crf, "-pix_fmt", "yuv420p"]),
            ("h264_amf", ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", crf, "-qp_p", crf, "-pix_fmt", "yuv420p"]),
        ]
        for enc_name, enc_args in hw_candidates:
            try:
                probe = subprocess.run(
                    [
                        ffmpeg_exe, "-hide_banner", "-loglevel", "error",
                        "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.04",
                        "-frames:v", "1", *enc_args, "-f", "null", "-",
                    ],
                    capture_output=True,
                    timeout=4,
                )
                if probe.returncode == 0:
                    print(f"[*] Using hardware H.264 encoder: {enc_name}")
                    return enc_args
            except Exception:
                continue

    args = ["-c:v", "libx264", "-preset", "faster", "-crf", crf, "-pix_fmt", "yuv420p"]
    # Bound lookahead, ref frames, and thread frame pools at 4K/8K to prevent multi-GB encoder RAM usage
    if high_res_pixels > 3840 * 2160:
        args.extend(["-threads", "4", "-x264-params", "rc-lookahead=8:ref=1:bframes=2"])
    elif high_res_pixels > 1920 * 1080:
        args.extend(["-threads", "4", "-x264-params", "rc-lookahead=12:ref=2:bframes=2"])
    return args


def select_hevc_hdr_encoder_args(
    ffmpeg_exe: str, crf: str, high_res_pixels: int, allow_hw: bool = True
) -> tuple[list[str], str]:
    """Selects a 10-bit HEVC encoder for HDR10/HLG and returns (encoder_args, pix_fmt)."""
    if allow_hw:
        hw_candidates = [
            ("hevc_nvenc", ["-c:v", "hevc_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", crf, "-pix_fmt", "p010le"], "p010le"),
            ("hevc_qsv", ["-c:v", "hevc_qsv", "-preset", "faster", "-global_quality", crf, "-pix_fmt", "p010le"], "p010le"),
            ("hevc_amf", ["-c:v", "hevc_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", crf, "-qp_p", crf, "-pix_fmt", "p010le"], "p010le"),
        ]
        for enc_name, enc_args, pix_fmt in hw_candidates:
            try:
                probe = subprocess.run(
                    [
                        ffmpeg_exe, "-hide_banner", "-loglevel", "error",
                        "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.04",
                        "-frames:v", "1", *enc_args, "-f", "null", "-",
                    ],
                    capture_output=True,
                    timeout=4,
                )
                if probe.returncode == 0:
                    print(f"[*] Using hardware 10-bit HEVC HDR encoder: {enc_name}")
                    return enc_args, pix_fmt
            except Exception:
                continue

    args = ["-c:v", "libx265", "-preset", "faster", "-crf", crf, "-pix_fmt", "yuv420p10le"]
    if high_res_pixels > 1920 * 1080:
        args.extend(["-x265-params", "rc-lookahead=12:ref=2:bframes=2"])
    return args, "yuv420p10le"


def run_single_recording(cfg: dict) -> Path:
    """Executes one complete recording cycle and returns the output video Path."""
    from playwright.sync_api import sync_playwright

    start_date, end_date = resolve_date_range(cfg.get("date"), cfg.get("start_date"), cfg.get("end_date"))
    min_mag = float(cfg.get("min_mag", 0.0))
    max_mag = float(cfg.get("max_mag", 10.0))
    width = int(cfg.get("width", 1920))
    height = int(cfg.get("height", 1080))
    fps = int(cfg.get("fps", 30))
    quality = cfg.get("quality", "high")
    raw_hdr = cfg.get("hdr", "off")
    if isinstance(raw_hdr, bool):
        hdr_mode = "pq" if raw_hdr else "off"
    else:
        hdr_mode = str(raw_hdr or "off").strip().lower()
    if hdr_mode not in ("off", "pq", "hlg"):
        hdr_mode = "off"
    is_hdr = hdr_mode in ("pq", "hlg")
    audio_quality = cfg.get("audio_quality", "high")
    channels = int(cfg.get("channels", 2))
    fmt = (cfg.get("format") or "mp4").lower().lstrip(".")

    geojson_file = fetch_or_load_geojson(
        start_date=start_date,
        end_date=end_date,
        min_mag=min_mag,
        max_mag=max_mag,
        geojson_path=cfg.get("geojson"),
        feed=cfg.get("feed"),
        offline=bool(cfg.get("offline", False)),
    )
    rel_geojson = "/" + geojson_file.relative_to(REPO_ROOT).as_posix()
    out_path = build_output_path(cfg, start_date, end_date)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    raw_video_ext = "webm" if fmt == "webm" else "mp4"
    raw_video_path = out_path.with_name(f"{out_path.stem}.video.{raw_video_ext}")
    wav_tag = f"{channels}ch" if channels > 2 else "hifi"
    wav_path = out_path.with_name(f"{out_path.stem}_{wav_tag}.wav")

    server = RecorderHTTPServer(raw_video_path, audio_dest=wav_path)
    base_url = server.start()

    # Cap browser DOM viewport at 4K for stability while compositeCanvas renders at full target width x height (up to 8K)
    vp_w = min(width, 3840)
    vp_h = min(height, 2160)

    query = urllib.parse.urlencode(
        {
            "geojson": rel_geojson,
            "minMag": min_mag,
            "maxMag": max_mag,
            "speed": cfg.get("speed", 360),
            "timbre": cfg.get("timbre", "tectonic"),
            "scale": cfg.get("scale", "dorian"),
            "rootFreq": cfg.get("root_freq", 36.7),
            "volume": cfg.get("volume", 80),
            "channels": channels,
            "audioQuality": audio_quality,
            "drone": "1" if cfg.get("drone") else "0",
            "plates": "1" if cfg.get("plates", True) else "0",
            "cleanUI": "1" if cfg.get("clean_ui", True) else "0",
        }
    )
    target_url = f"{base_url}/index.html?{query}"

    stop_requested = threading.Event()
    prev_sigint = signal.getsignal(signal.SIGINT)
    prev_sigterm = signal.getsignal(signal.SIGTERM)

    def _on_signal(signum, _frame):
        print(f"\n[!] Signal {signum} received — finalizing recording cleanly...")
        stop_requested.set()

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    import imageio_ffmpeg

    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    crf = QUALITY_CRF.get(quality, "18")
    enc_w = (width // 2) * 2
    enc_h = (height // 2) * 2

    ffmpeg_cmd = [
        ffmpeg_exe,
        "-y",
        "-f",
        "image2pipe",
        "-vcodec",
        "png" if is_hdr else "mjpeg",
        "-r",
        str(fps),
        "-i",
        "pipe:0",
        "-an",
    ]
    high_res_pixels = enc_w * enc_h
    if is_hdr:
        hdr_trc = "smpte2084" if hdr_mode == "pq" else "arib-std-b67"
        if fmt == "webm":
            hdr_pix_fmt = "yuv420p10le"
            v_enc_args = [
                "-c:v", "libvpx-vp9", "-profile:v", "2", "-crf", crf, "-b:v", "0",
                "-pix_fmt", hdr_pix_fmt, "-row-mt", "1",
            ]
            if high_res_pixels > 1920 * 1080:
                v_enc_args.extend(["-threads", "4", "-lag-in-frames", "8"])
        else:
            v_enc_args, hdr_pix_fmt = select_hevc_hdr_encoder_args(ffmpeg_exe, crf, high_res_pixels)
            if fmt == "mp4":
                v_enc_args = [*v_enc_args, "-tag:v", "hvc1"]
        ffmpeg_cmd.extend([
            "-vf",
            f"zscale=pin=bt709:tin=iec61966-2-1:min=gbr:rin=full:p=bt2020:t={hdr_trc}:m=bt2020nc:r=limited:npl=203,format={hdr_pix_fmt}",
            *v_enc_args,
            "-color_primaries", "bt2020",
            "-color_trc", hdr_trc,
            "-colorspace", "bt2020nc",
            "-color_range", "tv",
        ])
        if fmt == "mp4":
            ffmpeg_cmd.extend(["-movflags", "+faststart"])
    elif fmt == "webm":
        ffmpeg_cmd.extend(["-c:v", "libvpx-vp9", "-crf", crf, "-b:v", "0", "-pix_fmt", "yuv420p", "-row-mt", "1"])
        if high_res_pixels > 1920 * 1080:
            ffmpeg_cmd.extend(["-threads", "4", "-lag-in-frames", "8"])
    else:
        ffmpeg_cmd.extend(select_h264_encoder_args(ffmpeg_exe, crf, high_res_pixels))
        if fmt == "mp4":
            ffmpeg_cmd.extend(["-movflags", "+faststart"])
    ffmpeg_cmd.append(str(raw_video_path))

    # Scale V8 heap limit for 4K/8K canvases and multi-channel OfflineAudioContext buffers
    v8_heap_mb = 4096 if (high_res_pixels > 1920 * 1080 or channels > 2) else 2048
    chromium_args = [
        "--autoplay-policy=no-user-gesture-required",
        "--use-gl=angle",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-dev-shm-usage",
        f"--js-flags=--max-old-space-size={v8_heap_mb}",
    ]
    if os.name == "nt":
        chromium_args.extend(["--use-angle=d3d11", "--disable-gpu-vsync"])

    ffmpeg_proc = None
    ffmpeg_stderr_tail: deque[str] = deque(maxlen=100)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=not bool(cfg.get("headful", False)),
                args=chromium_args,
            )
            context = browser.new_context(viewport={"width": vp_w, "height": vp_h}, device_scale_factor=1)
            page = context.new_page()
            cdp = context.new_cdp_session(page)
            cdp.send("Network.enable", {"maxTotalBufferSize": 0, "maxResourceBufferSize": 0, "maxPostDataSize": 0})
            cdp.send("Network.setCacheDisabled", {"cacheDisabled": True})
            page.on("requestfailed", lambda req: print(f"[!] Request failed: {req.url} ({req.failure})"))
            page.on("crash", lambda: print("[!] Chromium page crashed!"))
            page.on("pageerror", lambda err: print(f"[!] Page JS error: {err}"))
            print(f"[*] Loading {target_url}")
            page.goto(target_url, wait_until="networkidle")
            page.wait_for_function("() => Boolean(window.__SEISMIC_RECORDER__)", timeout=30000)

            # Wait briefly for initial feed parse
            page.wait_for_timeout(1200)
            state = page.evaluate("() => window.__SEISMIC_RECORDER__.getState()")
            print(f"[*] Stream ready: {state['eventCount']} events @ {state['speed']}x")
            if state["eventCount"] == 0:
                raise RuntimeError("No earthquake events matched the selected filters/date range.")

            rec_opts = {
                "width": enc_w,
                "height": enc_h,
                "fps": fps,
                "quality": quality,
                "hdr": hdr_mode,
                "frameFormat": "png" if is_hdr else "jpeg",
                "audioQuality": audio_quality,
                "channels": channels,
                "drone": bool(cfg.get("drone", False)),
                "plates": bool(cfg.get("plates", True)),
                "cleanUI": bool(cfg.get("clean_ui", True)),
            }

            hdr_label = f", HDR={hdr_mode.upper()}" if is_hdr else ""
            print(f"[*] Starting deterministic offline capture ({enc_w}x{enc_h} @ {fps}fps{hdr_label}, {channels}ch {audio_quality} audio)...")
            popen_kwargs = {
                "stdin": subprocess.PIPE,
                "stdout": subprocess.DEVNULL,
                "stderr": subprocess.PIPE,
            }
            if os.name == "nt":
                popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            ffmpeg_proc = subprocess.Popen(ffmpeg_cmd, **popen_kwargs)

            def _drain_ffmpeg_stderr(pipe, tail):
                try:
                    for raw_line in iter(pipe.readline, b""):
                        tail.append(raw_line.decode(errors="replace").rstrip())
                finally:
                    pipe.close()

            stderr_thread = threading.Thread(
                target=_drain_ffmpeg_stderr,
                args=(ffmpeg_proc.stderr, ffmpeg_stderr_tail),
                daemon=True,
            )
            stderr_thread.start()
            server.frame_writer = FramePipeWriter(ffmpeg_proc.stdin, max_queued=12)

            page.evaluate("(opts) => window.__SEISMIC_RECORDER__.prepareOfflineRender(opts)", rec_opts)
            has_batch_api = page.evaluate("() => typeof window.__SEISMIC_RECORDER__.stepAndPostFrames === 'function'")
            batch_size = min(max(fps, 1), 10) if has_batch_api else 1

            max_dur = float(cfg.get("max_duration", 3600))
            started = time.monotonic()
            last_log = 0.0

            while True:
                if stop_requested.is_set() or (time.monotonic() - started) >= max_dur:
                    print("[*] Stopping offline capture early...")
                    break

                try:
                    if has_batch_api:
                        st = page.evaluate("(n) => window.__SEISMIC_RECORDER__.stepAndPostFrames(n)", batch_size)
                    else:
                        st = page.evaluate("() => window.__SEISMIC_RECORDER__.stepAndPostFrame()")
                except Exception as exc:
                    ff_rc = ffmpeg_proc.poll()
                    ff_tail = "\n".join(ffmpeg_stderr_tail)
                    raise RuntimeError(
                        f"Capture stalled/failed at frame {server.frame_count} "
                        f"(ffmpeg_rc={ff_rc}): {exc}\n{ff_tail}"
                    ) from exc
                now = time.monotonic()
                if now - last_log >= 2.0 or st.get("done"):
                    print(
                        f"    Frame {st['frameIndex']} ({st['percent']:.1f}% · "
                        f"{st['currentIndex']}/{st['totalEvents']} events · {int(now - started)}s elapsed)"
                    )
                    last_log = now
                if st.get("done"):
                    break

            server.frame_writer.close()
            if server.frame_writer.error is not None:
                raise RuntimeError(f"FFmpeg pipe write failed: {server.frame_writer.error}")
            server.frame_writer = None
            ffmpeg_proc.stdin.close()
            ffmpeg_proc.stdin = None
            ffmpeg_proc.wait()
            stderr_thread.join(timeout=5)
            if ffmpeg_proc.returncode != 0:
                raise RuntimeError(f"FFmpeg video encode failed ({ffmpeg_proc.returncode}):\n" + "\n".join(ffmpeg_stderr_tail))
            ffmpeg_proc = None

            print("[*] Rendering deterministic OfflineAudioContext WAV...")
            audio_res = page.evaluate("(opts) => window.__SEISMIC_RECORDER__.renderOfflineAudioAndUpload(opts)", rec_opts)
            server.audio_done.wait(timeout=120)
            print(
                f"[*] Audio rendered: {audio_res['channels']}ch @ {audio_res['sampleRate']}Hz "
                f"{audio_res['bitDepth']}-bit ({audio_res['durationSec']:.2f}s)"
            )

            browser.close()

        if not raw_video_path.exists() or raw_video_path.stat().st_size == 0:
            raise RuntimeError("Captured video file is empty or missing.")
        if not wav_path.exists() or wav_path.stat().st_size == 0:
            raise RuntimeError("Captured WAV audio file is empty or missing.")

        if str(REPO_ROOT) not in sys.path:
            sys.path.insert(0, str(REPO_ROOT))
        from remux import remux_pair

        remux_pair(
            ffmpeg_exe=ffmpeg_exe,
            video_path=raw_video_path,
            audio_path=wav_path,
            out_path=out_path,
            fmt=fmt,
            overwrite=True,
        )

        meta_path = out_path.with_suffix(".json")
        meta_path.write_text(
            json.dumps(
                {
                    "output": str(out_path),
                    "raw_video": str(raw_video_path),
                    "raw_wav": str(wav_path),
                    "start_date": start_date,
                    "end_date": end_date,
                    "min_mag": min_mag,
                    "max_mag": max_mag,
                    "speed": cfg.get("speed", 360),
                    "width": enc_w,
                    "height": enc_h,
                    "fps": fps,
                    "frames": server.frame_count,
                    "quality": quality,
                    "hdr": hdr_mode,
                    "audio_quality": audio_quality,
                    "channels": channels,
                    "events": state.get("eventCount", 0),
                    "recorded_at_utc": datetime.now(timezone.utc).isoformat(),
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"[+] Saved recording: {out_path} ({out_path.stat().st_size / (1024*1024):.2f} MB)")
        print(f"[+] Separate raw video: {raw_video_path}")
        print(f"[+] Separate raw WAV:   {wav_path}")
        return out_path
    finally:
        if server.frame_writer is not None:
            try:
                server.frame_writer.close()
            except Exception:
                pass
            server.frame_writer = None
        if ffmpeg_proc is not None and ffmpeg_proc.poll() is None:
            try:
                if ffmpeg_proc.stdin:
                    ffmpeg_proc.stdin.close()
            except Exception:
                pass
            ffmpeg_proc.terminate()
        signal.signal(signal.SIGINT, prev_sigint)
        signal.signal(signal.SIGTERM, prev_sigterm)
        server.stop()


def generate_schedule_command(cron_expr: str, extra_args: list[str]) -> str:
    """Builds a platform-appropriate cron or Windows Task Scheduler command."""
    py_exe = sys.executable
    script_path = Path(__file__).resolve()
    args_str = " ".join(extra_args) if extra_args else "--date yesterday"

    if platform.system().lower() == "windows":
        parts = cron_expr.strip().split()
        minute = parts[0] if len(parts) > 0 and parts[0].isdigit() else "0"
        hour = parts[1] if len(parts) > 1 and parts[1].isdigit() else "2"
        hhmm = f"{int(hour):02d}:{int(minute):02d}"
        tr = f'"{py_exe}" "{script_path}" {args_str}'
        return f'schtasks /Create /TN "SeismicResonanceRecorder" /TR "{tr}" /SC DAILY /ST {hhmm} /F'
    return f'{cron_expr} cd "{REPO_ROOT}" && "{py_exe}" "{script_path}" {args_str} >> "{RECORDER_DIR / "recorder.log"}" 2>&1'


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Seismic Resonance Offline Stream Recorder")
    p.add_argument("--config", type=str, default=str(DEFAULT_CONFIG_PATH), help="Path to JSON config file")
    p.add_argument("--date", type=str, help="Local date (YYYY-MM-DD, 'yesterday', or 'today')")
    p.add_argument("--start-date", type=str, help="Range start local date (YYYY-MM-DD)")
    p.add_argument("--end-date", type=str, help="Range end local date (YYYY-MM-DD)")
    p.add_argument("--feed", choices=["all_hour", "all_day", "2.5_day", "4.5_week"], help="USGS live feed key")
    p.add_argument("--geojson", type=str, help="Local .geojson file for air-gapped offline replay")
    p.add_argument("--offline", action="store_true", help="Strictly use cached GeoJSON without network calls")

    p.add_argument("--min-mag", type=float, help="Minimum magnitude filter")
    p.add_argument("--max-mag", type=float, help="Maximum magnitude filter")
    p.add_argument("--speed", type=int, help="Stream speed multiplier (e.g. 60, 180, 360, 900)")
    p.add_argument("--timbre", choices=["tectonic", "subpulse", "abyssal"], help="Synth voice timbre")
    p.add_argument("--scale", choices=["dorian", "phrygian", "pentatonic", "just"], help="Harmonic scale")
    p.add_argument("--root-freq", type=float, help="Root frequency in Hz (27.5 - 65.4)")
    p.add_argument("--volume", type=int, help="Master volume (0 - 100)")
    p.add_argument("--channels", type=int, choices=[1, 2, 4, 6, 8], help="Audio channel layout: 1 (Mono), 2 (Stereo), 4 (Quad), 6 (5.1), 8 (7.1)")
    p.add_argument("--drone", dest="drone", action="store_true", default=None, help="Enable 41 Hz Earth Drone")
    p.add_argument("--no-drone", dest="drone", action="store_false", help="Disable 41 Hz Earth Drone")
    p.add_argument("--plates", dest="plates", action="store_true", default=None, help="Show tectonic plates")
    p.add_argument("--no-plates", dest="plates", action="store_false", help="Hide tectonic plates")
    p.add_argument("--clean-ui", dest="clean_ui", action="store_true", default=None, help="Hide side asides (default)")
    p.add_argument("--show-asides", "--no-clean-ui", dest="clean_ui", action="store_false", help="Show left/right side panels")

    p.add_argument("--resolution", choices=list(RESOLUTION_PRESETS.keys()), help="Resolution preset (720p, 1080p, 4k, 8k)")
    p.add_argument("--width", type=int, help="Custom video width")
    p.add_argument("--height", type=int, help="Custom video height")
    p.add_argument("--fps", type=int, help="Frame rate (e.g. 30, 60, 120, or 240)")
    p.add_argument("--quality", choices=list(QUALITY_CRF.keys()), help="Encoding quality preset")
    p.add_argument("--hdr", choices=["off", "pq", "hlg"], help="Dynamic range: off (8-bit SDR), pq (HDR10 10-bit Rec.2020 PQ), hlg (10-bit Rec.2020 HLG)")
    p.add_argument("--audio-quality", choices=["standard", "high", "ultra"], help="Audio output quality (standard, high, ultra)")
    p.add_argument("--format", choices=["mp4", "mkv", "webm"], help="Output container format")
    p.add_argument("--output-dir", type=str, help="Output directory")
    p.add_argument("--name", dest="filename_template", type=str, help="Output filename or template")
    p.add_argument("--out", type=str, help="Explicit output file path (overrides --output-dir and --name)")
    p.add_argument("--max-duration", type=int, help="Safety max recording duration in seconds")
    p.add_argument("--headful", action="store_true", help="Show Chromium window for debugging")

    p.add_argument("--run-mode", choices=["single", "interval"], default="single", help="Run once or loop on interval")
    p.add_argument("--every-hours", type=float, default=24.0, help="Hours between runs when --run-mode interval")
    p.add_argument("--print-schedule", type=str, metavar="CRON", help="Print cron / Task Scheduler command and exit")
    p.add_argument("--install-cron", type=str, metavar="CRON", help="Install cron / Task Scheduler job and exit")
    return p.parse_args(argv)


def merge_config(args: argparse.Namespace) -> dict:
    cfg = {}
    cfg_path = Path(args.config)
    if cfg_path.exists():
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))

    override_keys = [
        "date", "start_date", "end_date", "feed", "geojson", "offline",
        "min_mag", "max_mag", "speed", "timbre", "scale", "root_freq",
        "volume", "channels", "drone", "plates", "clean_ui", "resolution", "width",
        "height", "fps", "quality", "hdr", "audio_quality", "format", "output_dir",
        "filename_template", "out", "max_duration", "headful",
    ]
    for key in override_keys:
        val = getattr(args, key, None)
        if val is not None and val is not False:
            cfg[key] = val
        elif key in ("drone", "plates", "clean_ui") and val is False:
            cfg[key] = False

    if args.resolution and args.resolution in RESOLUTION_PRESETS and not args.width and not args.height:
        cfg["width"], cfg["height"] = RESOLUTION_PRESETS[args.resolution]
    elif cfg.get("resolution") in RESOLUTION_PRESETS and not args.width and not args.height:
        if "width" not in cfg or "height" not in cfg:
            cfg["width"], cfg["height"] = RESOLUTION_PRESETS[cfg["resolution"]]

    return cfg


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if args.print_schedule or args.install_cron:
        cron_expr = args.print_schedule or args.install_cron
        cmd = generate_schedule_command(cron_expr, ["--date", args.date or "yesterday"])
        print(cmd)
        if args.install_cron:
            if platform.system().lower() == "windows":
                res = subprocess.run(cmd, shell=True)
                return res.returncode
            existing = subprocess.run(["crontab", "-l"], capture_output=True, text=True).stdout
            new_cron = (existing.rstrip() + "\n" + cmd + "\n").lstrip()
            proc = subprocess.run(["crontab", "-"], input=new_cron, text=True)
            return proc.returncode
        return 0

    cfg = merge_config(args)

    if args.run_mode == "interval":
        interval_sec = max(60.0, float(args.every_hours) * 3600.0)
        print(f"[*] Interval mode active: recording every {args.every_hours}h")
        while True:
            try:
                run_single_recording(cfg)
            except Exception as exc:
                print(f"[!] Recording run failed: {exc}", file=sys.stderr)
            print(f"[*] Sleeping {interval_sec:.0f}s until next scheduled run...")
            time.sleep(interval_sec)
    else:
        run_single_recording(cfg)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
