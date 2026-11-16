# Seismic Resonance — Offline & In-Browser Stream Recorder

Record a complete 1-cycle (e.g. 24-hour All Quakes) **Seismic Resonance** time-lapse stream with stereo sub-bass audio into a local `.mp4` or `.webm` video file—either directly inside the browser or unattended via Python + Playwright + bundled FFmpeg.

---

## 1. Quick Setup (Python CLI)

Requires Python 3.10+ (no global FFmpeg installation needed—`imageio-ffmpeg` bundles it automatically):

```bash
pip install -r recorder/requirements.txt
playwright install chromium
```

---

## 2. Common CLI Examples

### Record Yesterday's 24H All-Quakes Stream (Default: 1080p, 30 FPS, Clean Cinema Mode)
```bash
python recorder/record.py
```

### Record a Specific Day or Date Range with Magnitude & Synth Filters
```bash
python recorder/record.py --start-date 2026-11-10 --end-date 2026-11-12 --min-mag 2.5 --max-mag 8.0 --speed 900 --timbre abyssal --scale phrygian --drone
```

### Record in 4K or 8K UHD
```bash
python recorder/record.py --date yesterday --resolution 4k --fps 60 --quality high
python recorder/record.py --date yesterday --resolution 8k --fps 30 --quality high
```

### Air-Gapped / 100% Offline Replay from a Local `.geojson` File
```bash
python recorder/record.py --geojson path/to/events.geojson --speed 360 --out recorder/output/offline_demo.mp4
```

### Show Side Panels (Full UI) Instead of Clean Cinema Mode
```bash
python recorder/record.py --date yesterday --show-asides
```

---

## 3. Scheduling & Cron Jobs

### Print or Install a Daily Cron Job (Linux/macOS) or Task Scheduler Job (Windows)
```bash
# Preview the exact command for 02:00 AM daily
python recorder/record.py --print-schedule "0 2 * * *"

# Install it automatically
python recorder/record.py --install-cron "0 2 * * *"
```

### Cross-Platform Python Interval Loop
```bash
python recorder/record.py --run-mode interval --every-hours 24
```

---

## 4. In-Browser Recorder (Zero Python Dependencies)

1. Start the app (`python local.py`) and open it in your browser.
2. Click the **REC** button in the top-left header bar.
3. Choose **Single Local Day**, **Custom Date Range**, **Current Loaded Feed**, or upload a **Local `.geojson` File**.
4. Configure Magnitude, Speed, Synth/Map aside options, Resolution (`720p`, `1080p`, `4K`, `8K`, or Custom), FPS, Quality, and Filename.
5. Click **Start 1-Cycle Recording**—the recording automatically stops at the end of the stream cycle and downloads the video.
