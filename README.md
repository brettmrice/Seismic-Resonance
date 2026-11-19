# Seismic Resonance — Real-Time Earthquake Sonification

An interactive 3D/2D WebGL global earthquake visualization and real-time sub-bass sonification instrument built with Three.js, the Web Audio API, live USGS GeoJSON feeds, and an optional local SQLite catalog—transforming tectonic activity into a spatial low-frequency soundscape with dual stereo spectrum analyzers, 3D tectonic plate boundary overlays, solar day/night lighting, and an offline/in-browser stream recorder.

[Watch & Listen](https://www.brettmrice.com/Seismic-Resonance/)

## Inspiration & Credits

- **Inspiration:** Inspired by Google DeepMind's [Introducing Gemini 4 Hydrogen](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-hydrogen/) announcement and the real-time global phenomenon sonification example shown in [this YouTube video](https://youtu.be/wRdIl5dnqUY)
- **Built With:** [Google Antigravity](https://antigravity.google/) was used to build this web application
- **Data Sources:** Live earthquake data from the [USGS Earthquake Hazards Program](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php) GeoJSON feeds and [USGS FDSN Event Web Service](https://earthquake.usgs.gov/fdsnws/event/1/), paired with world landmass and classified tectonic plate boundary GeoJSON datasets

## What This Web App Is

**Seismic Resonance** transforms global tectonic activity into a tactile, spatial low-frequency soundscape (`24 Hz–420 Hz`, visualized on a `20 Hz–450 Hz` stereo spectrum). As earthquakes occur—or replay in a continuous time-lapse stream—each tremor is rendered as an expanding seismic wave within a concentric-depth 3D globe (or 2D projection) and synthesized in real time using a custom Web Audio sub-bass engine.

### Key Features

- **3D Concentric Depth Globe & 2D Multi-Plane Map (`src/map.js`):**
  - Switch seamlessly between **3D Globe** and **2D Projection** modes from the top bar.
  - **Layered Depth Architecture:** Oceans, graticule, true solar day/night terminator lighting (computed from the subsolar point with Earth's `23.439°` axial tilt), and tectonic plate boundaries form the base layer; earthquakes sit at radial depths proportional to hypocenter depth (`0–700 km`) with rising seismic waves; frosted/tinted land masses with coastline glow float on top.
  - **Classified Tectonic Plate Boundaries:** Toggleable plate overlay with distinct 3D geometry and legend for **Subduction** (dips under), **Divergent** (rift), **Transform** (shear), and **Collision** (uplift) boundaries.
  - **Local Solar Time Dial:** Radial time-of-day dial along the bottom edge aligned with the sun's position.
  - **Interactive Controls:** Drag to rotate/pan, scroll to zoom, reset view via the **Zoom** button, click any quake to audition its sound, or `Shift + Click` anywhere on the globe/map to trigger a synthetic tremor.
- **Live USGS Feeds & Local SQLite Catalog (`usgs_db.py`, `local.py`):**
  - Switch between *Past Hour (All Quakes)*, *Past 24 Hours (All Quakes)*, *Past 24 Hours (M2.5+)*, and *Past 7 Days (M4.5+)*, with automatic background polling every 30 seconds.
  - **Local SQLite DB (`data/usgs_quakes.db`):** Sync the full historical USGS catalog (`1900–present`) locally and query it directly from the UI by date range, region/place name, and event limit.
- **Time-Lapse Stream, Live Mode & Cinema Mode:**
  - Replay global activity at `60×`, `180×`, `360×`, `480×`, or `900×` speed, pause/resume the stream from the header, or switch to *Live Only* to listen strictly for newly arriving earthquakes.
  - **Cinema Mode & Idle UI Hiding:** Side panels and top controls automatically fade away after 10 seconds of inactivity (or enter **Cinema Mode** / **Fullscreen** manually) with magnitude-based auto-zoom tracking active earthquakes.
- **Low-Frequency Sub-Bass & Surround Synthesizer (`src/audio.js`):**
  - **Voice Timbres:** *Tectonic Rumble (Sub + Noise)*, *Sub-Bass Pulse (Pure Deep)*, and *Abyssal Pad (Slow Swell)*.
  - **Harmonic Scales:** *Deep Dorian*, *Phrygian Dominant*, *Minor Pentatonic*, and *Just Intonation Drone*.
  - **Speaker Layouts:** `1.0 (Mono)`, `2.0 (Stereo)`, `4.0 (Quad)`, `5.1 (Surround + LFE)`, and `7.1 (Surround + LFE)` with dedicated LFE sub-bass routing.
  - **Adjustable Root & Drone:** Tune the root frequency (`27.5 Hz–65.4 Hz`), adjust master volume, and toggle a continuous **41 Hz Earth Drone**.
- **Spatial & Depth Mapping:**
  - **Depth → Color & Register:** Shallow (`< 70 km`, Magma Coral), Mid (`70–300 km`, Amber Gold), and Deep (`≥ 300 km`, Abyssal Cyan).
  - **Longitude → Spatial Pan:** Earthquakes pan dynamically across the stereo or surround field relative to the viewport, visualized on dual left/right sub-bass spectrum analyzers.
- **In-Browser & Offline Stream Recorder (`src/recorder.js`, `recorder/record.py`, `remux.py`):**
  - **In-Browser (`REC`):** Record a 1-cycle time-lapse pass from the current feed, a single local day, a custom date range, or a local `.geojson` file, with clean cinema capture and discrete multichannel `.wav` export for `4.0`/`5.1`/`7.1` layouts.
  - **Offline Python Recorder:** Deterministic headless capture via Playwright + bundled FFmpeg supporting up to **4K/8K UHD**, up to **240 FPS**, **10-bit HDR** (HDR10 PQ / HLG), and scheduled cron/Task Scheduler runs. See [`recorder/README.md`](recorder/README.md) for details.
  - **Remux Utility (`remux.py`):** Auto-pairs recorded video files with companion multichannel or hi-fi `.wav` audio (`*_8ch.wav`, `*_hifi.wav`) into `.mkv`, `.webm`, `.mp4`, or `.mov`.

## Running Locally

Start the built-in local development server (requires Python 3):

```bash
python local.py
```

Useful server options:

```bash
python local.py --port 8080 --no-browser
python local.py --test   # Run file, GeoJSON, HTTP, and USGS feed integrity tests
```

## Local USGS SQLite Database (`usgs_db.py`)

To enable the **Local SQLite DB** dataset in the UI and query historical earthquakes offline:

```bash
# Resumable sync of the USGS catalog into data/usgs_quakes.db
python usgs_db.py sync

# Pull newly arrived or revised events since the last sync
python usgs_db.py update

# Inspect sync progress, query events, or run read-only SQL
python usgs_db.py status
python usgs_db.py query --start 2026-11-01 --min-mag 4.5
python usgs_db.py sql "SELECT COUNT(*) FROM earthquakes WHERE mag >= 6.0"
```

## Stream Recording & Remuxing

1. **In-Browser:** Click **REC** in the top bar to record directly in your browser (up to `1080p` / `60 FPS` / 8-bit SDR, plus separate multichannel `.wav` when surround is selected).
2. **Offline High-Res / HDR (`recorder/record.py`):**
   ```bash
   pip install -r recorder/requirements.txt
   playwright install chromium
   python recorder/record.py --date yesterday --resolution 4k --fps 60 --quality high
   ```
3. **Remux Video + Multichannel Audio (`remux.py`):**
   ```bash
   # Auto-pair and remux all recordings in ./videos to lossless MKV
   python remux.py

   # Remux a specific folder to MP4 (H.264 + AAC)
   python remux.py videos/ --format mp4
   ```

## Project Structure

- [`index.html`](index.html) & [`styles.css`](styles.css) — Full-bleed UI, controls, modals, and responsive HUD styling
- [`src/main.js`](src/main.js) — App state, stream playback, cinema/idle HUD, solar dial, and local DB integration
- [`src/map.js`](src/map.js) & [`src/triangulate.js`](src/triangulate.js) — Three.js WebGL 3D/2D globe, solar lighting, depth layers, and 3D tectonic plate geometry
- [`src/audio.js`](src/audio.js) — Web Audio sub-bass synthesizer, harmonic scales, 41 Hz drone, and mono/stereo/surround routing
- [`src/usgs.js`](src/usgs.js) — Live USGS GeoJSON feed client and local DB API client
- [`src/recorder.js`](src/recorder.js) — In-browser `MediaRecorder` / multichannel WAV capture and offline CLI command builder
- [`local.py`](local.py) — Local Python HTTP server, `/api/usgs/*` endpoints, and `--test` verification suite
- [`usgs_db.py`](usgs_db.py) — Resumable USGS FDSN catalog syncer and SQLite CLI explorer
- [`recorder/`](recorder/README.md) — Headless Playwright + FFmpeg stream recorder (`record.py`)
- [`remux.py`](remux.py) — FFmpeg video + multichannel/hi-fi audio remuxing utility
- [`data/`](data/) — Landmass (`land-110m.geojson`), classified tectonic plates (`tectonic-plates.geojson`), and local SQLite DB (`usgs_quakes.db`)
