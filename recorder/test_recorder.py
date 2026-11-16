#!/usr/bin/env python3
"""Unit tests for recorder/record.py configuration, filtering, and scheduling."""

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest

RECORDER_DIR = Path(__file__).resolve().parent
REPO_ROOT = RECORDER_DIR.parent
sys.path.insert(0, str(RECORDER_DIR))

import record  # noqa: E402


class TestRecorderCLI(unittest.TestCase):
    def test_resolve_yesterday_and_explicit_range(self):
        expected_yest = (datetime.now().astimezone().date() - timedelta(days=1)).isoformat()
        self.assertEqual(record.resolve_date_range("yesterday", None, None), (expected_yest, expected_yest))
        self.assertEqual(record.resolve_date_range(None, "2026-11-01", "2026-11-05"), ("2026-11-01", "2026-11-05"))

    def test_local_date_boundary_to_iso(self):
        start_iso = record.local_date_boundary_to_iso("2026-11-14", is_end=False)
        end_iso = record.local_date_boundary_to_iso("2026-11-14", is_end=True)
        local_tz = datetime.now().astimezone().tzinfo
        expected_start = datetime(2026, 11, 14, 0, 0, 0, tzinfo=local_tz).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        expected_end = datetime(2026, 11, 14, 23, 59, 59, tzinfo=local_tz).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.assertEqual(start_iso, expected_start)
        self.assertEqual(end_iso, expected_end)
        self.assertEqual(record.local_date_boundary_to_iso("2026-11-14T12:00:00Z"), "2026-11-14T12:00:00Z")

    def test_resolution_presets_include_8k(self):
        args = record.parse_args(["--resolution", "8k"])
        cfg = record.merge_config(args)
        self.assertEqual(cfg["width"], 7680)
        self.assertEqual(cfg["height"], 4320)

    def test_channels_config_default_and_override(self):
        default_cfg = record.merge_config(record.parse_args([]))
        self.assertEqual(default_cfg["channels"], 2)
        for ch in (1, 2, 4, 6, 8):
            cfg = record.merge_config(record.parse_args(["--channels", str(ch)]))
            self.assertEqual(cfg["channels"], ch)

    def test_high_fps_overrides(self):
        for fps in (120, 240):
            cfg = record.merge_config(record.parse_args(["--fps", str(fps)]))
            self.assertEqual(cfg["fps"], fps)

    def test_audio_quality_default_and_override(self):
        default_cfg = record.merge_config(record.parse_args([]))
        self.assertEqual(default_cfg["audio_quality"], "standard")
        for aq in ("standard", "high", "ultra"):
            cfg = record.merge_config(record.parse_args(["--audio-quality", aq]))
            self.assertEqual(cfg["audio_quality"], aq)

    def test_aside_flags_override_defaults(self):
        args = record.parse_args(["--show-asides", "--drone", "--no-plates", "--min-mag", "2.5", "--speed", "900"])
        cfg = record.merge_config(args)
        self.assertFalse(cfg["clean_ui"])
        self.assertTrue(cfg["drone"])
        self.assertFalse(cfg["plates"])
        self.assertEqual(cfg["min_mag"], 2.5)
        self.assertEqual(cfg["speed"], 900)

    def test_build_output_path_template(self):
        cfg = {
            "width": 3840,
            "height": 2160,
            "speed": 360,
            "fps": 60,
            "format": "mp4",
            "output_dir": "recorder/output",
            "filename_template": "seismic_{date}_{speed}x_{res}.{ext}",
        }
        p = record.build_output_path(cfg, "2026-11-14", "2026-11-14")
        self.assertEqual(p.name, "seismic_2026-11-14_360x_3840x2160.mp4")

    def test_offline_geojson_loading(self):
        sample = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "id": "test1",
                    "properties": {"mag": 3.2, "place": "Test Quake", "time": 1700000000000},
                    "geometry": {"type": "Point", "coordinates": [-120.0, 35.0, 10.0]},
                }
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "sample.geojson"
            src.write_text(json.dumps(sample), encoding="utf-8")
            cached = record.fetch_or_load_geojson(
                "2026-11-14", "2026-11-14", 0.0, 10.0, geojson_path=str(src), offline=True
            )
            self.assertTrue(cached.exists())
            loaded = json.loads(cached.read_text(encoding="utf-8"))
            self.assertEqual(len(loaded["features"]), 1)
            cached.unlink(missing_ok=True)

    def test_schedule_command_generation(self):
        cmd = record.generate_schedule_command("0 2 * * *", ["--date", "yesterday"])
        self.assertTrue("SeismicResonanceRecorder" in cmd or "record.py" in cmd)

    def test_frame_pipe_writer_writes_and_propagates_broken_pipe(self):
        import io

        buf = io.BytesIO()
        writer = record.FramePipeWriter(buf, max_queued=4)
        writer.enqueue(b"frame1")
        writer.enqueue(b"frame2")
        writer.close()
        self.assertIsNone(writer.error)
        self.assertEqual(buf.getvalue(), b"frame1frame2")

        class BrokenSink:
            def write(self, _data):
                raise BrokenPipeError("pipe closed")

        failing = record.FramePipeWriter(BrokenSink(), max_queued=2)
        failing.enqueue(b"frame1")
        # Give background thread a moment to hit BrokenPipeError
        import time

        deadline = time.monotonic() + 2.0
        while failing.error is None and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertIsInstance(failing.error, BrokenPipeError)
        with self.assertRaises(RuntimeError):
            failing.enqueue(b"frame2")
        failing.close()

    def test_select_h264_encoder_args_software_fallback(self):
        args = record.select_h264_encoder_args("ffmpeg", "18", 3840 * 2160, allow_hw=False)
        self.assertIn("libx264", args)
        self.assertIn("faster", args)
        self.assertIn("-x264-params", args)

    def test_hdr_config_default_and_override(self):
        default_cfg = record.merge_config(record.parse_args([]))
        self.assertEqual(default_cfg["hdr"], "off")
        for mode in ("off", "pq", "hlg"):
            cfg = record.merge_config(record.parse_args(["--hdr", mode]))
            self.assertEqual(cfg["hdr"], mode)

    def test_select_hevc_hdr_encoder_args_software_fallback(self):
        args, pix_fmt = record.select_hevc_hdr_encoder_args("ffmpeg", "18", 3840 * 2160, allow_hw=False)
        self.assertIn("libx265", args)
        self.assertEqual(pix_fmt, "yuv420p10le")
        self.assertIn("-x265-params", args)


if __name__ == "__main__":
    unittest.main(verbosity=2)
