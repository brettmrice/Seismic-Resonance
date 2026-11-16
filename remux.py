#!/usr/bin/env python3
"""
Local video + audio remuxing utility for Seismic Resonance recordings.

Pairs recorded video files (e.g. .webm / .mp4) with companion high-res or
multichannel audio files (e.g. *_8ch.wav, *_hifi.wav) and muxes them using
FFmpeg (system PATH or bundled imageio-ffmpeg).

Examples:
    # Auto-pair and remux everything in ./videos (lossless MKV by default)
    python remux.py

    # Auto-pair and remux a specific folder
    python remux.py "C:\\path\\to\\videos"

    # Remux an explicit video + audio pair
    python remux.py videos\\seismic_2026-11-14_360x_ultra.webm videos\\seismic_2026-11-14_360x_ultra_8ch.wav

    # Remux to WebM (Opus audio) or MP4 (H.264 + AAC)
    python remux.py videos\\ --format webm
    python remux.py videos\\ --format mp4
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

VIDEO_EXTS = {".webm", ".mp4", ".mkv", ".mov", ".avi"}
AUDIO_EXTS = {".wav", ".flac", ".aac", ".m4a", ".opus", ".ogg", ".mp3"}
AUDIO_SUFFIX_RE = re.compile(r"^(?P<stem>.+?)_(?P<tag>\d+ch|hifi)$", re.IGNORECASE)


def find_ffmpeg() -> str:
    """Return path to an ffmpeg executable from PATH or imageio-ffmpeg."""
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError as exc:
        raise RuntimeError(
            "FFmpeg not found on PATH and 'imageio-ffmpeg' is not installed.\n"
            "Install it with: pip install imageio-ffmpeg"
        ) from exc


def probe_media(ffmpeg_exe: str, path: Path) -> dict[str, str | int | None]:
    """Inspect basic video/audio codec and channel count using `ffmpeg -i`."""
    proc = subprocess.run(
        [ffmpeg_exe, "-hide_banner", "-i", str(path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    info = proc.stderr
    vcodec = None
    acodec = None
    channels = None

    v_match = re.search(r"Stream #\d+:\d+.*?: Video:\s*([a-zA-Z0-9_]+)", info)
    if v_match:
        vcodec = v_match.group(1).lower()

    a_match = re.search(
        r"Stream #\d+:\d+.*?: Audio:\s*([a-zA-Z0-9_]+)(?:\s*\([^)]*\))?,\s*\d+\s*Hz,\s*([^,\r\n]+)",
        info,
    )
    if a_match:
        acodec = a_match.group(1).lower()
        ch_desc = a_match.group(2).strip().lower()
        if ch_desc == "mono":
            channels = 1
        elif ch_desc == "stereo":
            channels = 2
        elif ch_desc in ("5.1", "5.1(side)"):
            channels = 6
        elif ch_desc in ("7.1", "7.1(wide)"):
            channels = 8
        else:
            m_ch = re.search(r"(\d+)\s*channels?", ch_desc)
            if m_ch:
                channels = int(m_ch.group(1))

    return {"vcodec": vcodec, "acodec": acodec, "channels": channels}


def find_pairs_in_dir(directory: Path) -> list[tuple[Path, Path]]:
    """Find matching (video, audio) pairs inside a directory."""
    if not directory.is_dir():
        raise FileNotFoundError(f"Directory not found: {directory}")

    videos: list[Path] = []
    audios_by_stem: dict[str, list[Path]] = {}

    for entry in sorted(directory.iterdir()):
        if not entry.is_file():
            continue
        ext = entry.suffix.lower()
        stem = entry.stem
        if ext in VIDEO_EXTS:
            if stem.endswith("_remux"):
                continue
            videos.append(entry)
        elif ext in AUDIO_EXTS:
            m = AUDIO_SUFFIX_RE.match(stem)
            base_stem = m.group("stem") if m else stem
            audios_by_stem.setdefault(base_stem, []).append(entry)

    pairs: list[tuple[Path, Path]] = []
    for video in videos:
        candidates = audios_by_stem.get(video.stem, [])
        if not candidates:
            continue
        # Prefer multichannel/hifi WAVs over other extensions
        candidates.sort(
            key=lambda p: (
                0 if p.suffix.lower() == ".wav" else 1,
                0 if AUDIO_SUFFIX_RE.match(p.stem) else 1,
                p.name,
            )
        )
        pairs.append((video, candidates[0]))

    return pairs


def resolve_codecs(
    fmt: str,
    vcodec_arg: str,
    acodec_arg: str,
    v_info: dict[str, str | int | None],
    a_info: dict[str, str | int | None],
    audio_bitrate: str | None,
) -> tuple[list[str], list[str], list[str]]:
    """Determine FFmpeg video, audio, and container flags for the target format."""
    fmt = fmt.lower().lstrip(".")
    src_vcodec = v_info.get("vcodec")
    channels = a_info.get("channels") or 2

    # Video codec selection
    if vcodec_arg == "auto":
        if fmt in ("mp4", "mov") and src_vcodec == "vp8":
            # MP4/MOV containers do not support VP8; transcode to H.264
            v_args = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"]
        else:
            v_args = ["-c:v", "copy"]
    elif vcodec_arg == "copy":
        v_args = ["-c:v", "copy"]
    elif vcodec_arg == "libx264":
        v_args = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"]
    elif vcodec_arg == "libx265":
        v_args = ["-c:v", "libx265", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p"]
    else:
        v_args = ["-c:v", vcodec_arg]

    # Audio codec selection
    src_acodec = a_info.get("acodec")
    if acodec_arg == "auto":
        if fmt == "mkv":
            # Many desktop players (e.g. Windows Media Player) play 32-bit float PCM in MKV silently;
            # FLAC preserves lossless multichannel high-sample-rate audio with broad playback support.
            acodec = "flac" if src_acodec == "pcm_f32le" else "copy"
        elif fmt == "mov":
            acodec = "pcm_s24le" if src_acodec == "pcm_f32le" else "copy"
        elif fmt == "webm":
            acodec = "libopus"
        elif fmt == "mp4":
            acodec = "aac"
        else:
            acodec = "copy"
    else:
        acodec = acodec_arg

    a_args = ["-c:a", acodec]
    if acodec == "libopus":
        if isinstance(channels, int) and channels > 2:
            a_args.extend(["-mapping_family", "1"])
        br = audio_bitrate or ("192k" if isinstance(channels, int) and channels <= 2 else "512k")
        a_args.extend(["-b:a", br])
    elif acodec == "aac":
        br = audio_bitrate or ("320k" if isinstance(channels, int) and channels <= 2 else "640k")
        a_args.extend(["-b:a", br])

    extra_args: list[str] = []
    if fmt == "mp4":
        extra_args.extend(["-movflags", "+faststart"])

    return v_args, a_args, extra_args


def remux_pair(
    ffmpeg_exe: str,
    video_path: Path,
    audio_path: Path,
    out_path: Path,
    fmt: str,
    vcodec: str = "auto",
    acodec: str = "auto",
    audio_bitrate: str | None = None,
    keep_original_audio: bool = False,
    shortest: bool = False,
    overwrite: bool = False,
    dry_run: bool = False,
) -> Path:
    """Remux a single video + audio pair into `out_path`."""
    if out_path.exists() and not overwrite and not dry_run:
        print(f"[skip] Output already exists (use --overwrite to replace): {out_path}")
        return out_path

    v_info = probe_media(ffmpeg_exe, video_path)
    a_info = probe_media(ffmpeg_exe, audio_path)
    v_args, a_args, extra_args = resolve_codecs(
        fmt=fmt,
        vcodec_arg=vcodec,
        acodec_arg=acodec,
        v_info=v_info,
        a_info=a_info,
        audio_bitrate=audio_bitrate,
    )

    cmd = [
        ffmpeg_exe,
        "-hide_banner",
        "-y" if overwrite else "-n",
        "-i",
        str(video_path),
        "-i",
        str(audio_path),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
    ]

    if keep_original_audio:
        cmd.extend(["-map", "0:a?", "-disposition:a:0", "default", "-disposition:a:1", "0"])

    cmd.extend(v_args)
    cmd.extend(a_args)
    if shortest:
        cmd.append("-shortest")
    cmd.extend(extra_args)
    cmd.append(str(out_path))

    print(f"[remux] {video_path.name} + {audio_path.name} -> {out_path.name}")
    if dry_run:
        print("  CMD:", subprocess.list2cmdline(cmd))
        return out_path

    out_path.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg failed ({proc.returncode}):\n{proc.stderr[-1500:]}")

    size_mb = out_path.stat().st_size / (1024 * 1024)
    print(f"[done]  {out_path} ({size_mb:.2f} MB)")
    return out_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Remux video and audio files (e.g. WebM + multichannel WAV) using FFmpeg."
    )
    parser.add_argument(
        "inputs",
        nargs="*",
        help=(
            "Either <video> <audio>, or one/more directories to auto-pair. "
            "Defaults to './videos' if omitted."
        ),
    )
    parser.add_argument(
        "-o",
        "--output",
        help="Output file path (for a single video+audio pair) or output directory (for batch mode).",
    )
    parser.add_argument(
        "-f",
        "--format",
        default="mkv",
        choices=["mkv", "webm", "mp4", "mov"],
        help="Output container format (default: mkv, lossless copy for VP8/VP9 + PCM WAV).",
    )
    parser.add_argument(
        "--video-codec",
        default="auto",
        help="Video codec (default: auto -> 'copy', or libx264 if muxing VP8 into MP4/MOV).",
    )
    parser.add_argument(
        "--audio-codec",
        default="auto",
        help="Audio codec (default: auto -> 'copy' for mkv/mov, 'libopus' for webm, 'aac' for mp4).",
    )
    parser.add_argument(
        "--audio-bitrate",
        default=None,
        help="Audio bitrate when transcoding (e.g. 512k, 640k).",
    )
    parser.add_argument(
        "--keep-original-audio",
        action="store_true",
        help="Keep the video's original audio track as a secondary stream.",
    )
    parser.add_argument(
        "--shortest",
        action="store_true",
        help="Trim output to the shorter of the video or audio stream.",
    )
    parser.add_argument(
        "-y",
        "--overwrite",
        action="store_true",
        help="Overwrite existing output files.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the FFmpeg commands without running them.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    ffmpeg_exe = find_ffmpeg()
    fmt = args.format.lower().lstrip(".")

    raw_inputs = [Path(p) for p in args.inputs] if args.inputs else [Path("videos")]

    # Mode 1: Explicit <video> <audio> pair
    if len(raw_inputs) == 2 and raw_inputs[0].is_file() and raw_inputs[1].is_file():
        video_path, audio_path = raw_inputs
        if args.output:
            out_candidate = Path(args.output)
            if out_candidate.is_dir():
                out_path = out_candidate / f"{video_path.stem}_remux.{fmt}"
            else:
                out_path = out_candidate
                fmt = out_path.suffix.lower().lstrip(".") or fmt
        else:
            out_path = video_path.with_name(f"{video_path.stem}_remux.{fmt}")

        remux_pair(
            ffmpeg_exe=ffmpeg_exe,
            video_path=video_path,
            audio_path=audio_path,
            out_path=out_path,
            fmt=fmt,
            vcodec=args.video_codec,
            acodec=args.audio_codec,
            audio_bitrate=args.audio_bitrate,
            keep_original_audio=args.keep_original_audio,
            shortest=args.shortest,
            overwrite=args.overwrite,
            dry_run=args.dry_run,
        )
        return 0

    # Mode 2: Directory batch auto-pairing
    pairs: list[tuple[Path, Path]] = []
    for item in raw_inputs:
        if item.is_dir():
            pairs.extend(find_pairs_in_dir(item))
        else:
            parser.error(
                f"Expected a directory or a <video> <audio> file pair; got: {item}"
            )

    if not pairs:
        print("[info] No matching video + audio pairs found.")
        return 0

    out_dir = Path(args.output) if args.output else None
    for video_path, audio_path in pairs:
        target_dir = out_dir if out_dir else video_path.parent
        out_path = target_dir / f"{video_path.stem}_remux.{fmt}"
        remux_pair(
            ffmpeg_exe=ffmpeg_exe,
            video_path=video_path,
            audio_path=audio_path,
            out_path=out_path,
            fmt=fmt,
            vcodec=args.video_codec,
            acodec=args.audio_codec,
            audio_bitrate=args.audio_bitrate,
            keep_original_audio=args.keep_original_audio,
            shortest=args.shortest,
            overwrite=args.overwrite,
            dry_run=args.dry_run,
        )

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"[error] {exc}", file=sys.stderr)
        raise SystemExit(1)
