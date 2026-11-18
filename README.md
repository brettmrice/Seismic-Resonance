# Seismic Resonance — Real-Time Earthquake Sonification

An interactive global earthquake map and real-time sub-bass sonification instrument built with the Web Audio API, HTML5 Canvas, and live USGS GeoJSON feeds—transforming tectonic activity into a spatial low-frequency soundscape with stereo spectrum analyzers, tectonic plate overlays, and time-lapse replay

[Watch & Listen](https://www.brettmrice.com/Seismic-Resonance/)

## Inspiration & Credits

- **Inspiration:** Inspired by Google DeepMind's [Introducing Gemini 4 Hydrogen](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-hydrogen/) announcement and the real-time global phenomenon sonification example shown in [this YouTube video](https://youtu.be/wRdIl5dnqUY)
- **Built With:** [Google Antigravity](https://antigravity.google/) was used to build this web application
- **Data Sources:** Live earthquake data from the [USGS Earthquake Hazards Program](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php) GeoJSON feeds, paired with world landmass and tectonic plate boundary GeoJSON datasets

## What This Web App Is

**Seismic Resonance** transforms global tectonic activity into a tactile, spatial low-frequency soundscape (24 Hz–420 Hz, visualized on a 20 Hz–450 Hz stereo spectrum). As earthquakes occur—or replay in a continuous time-lapse stream—each tremor is rendered as an expanding seismic wave on a full-bleed world map and synthesized in real time using a custom Web Audio sub-bass engine

### Key Features

- **Live USGS Seismic Feeds:** Switch between *Past Hour (All Quakes)*, *Past 24 Hours (All Quakes)*, *Past 24 Hours (M2.5+)*, and *Past 7 Days (M4.5+)*, with automatic background polling every 30 seconds.
- **Time-Lapse Stream & Live Mode:** Replay recent global activity at `60×`, `180×`, `360×`, or `900×` speed, or switch to *Live Only* to listen strictly for newly arriving earthquakes.
- **Low-Frequency Sub-Bass Synthesizer:**
  - **Voice Timbres:** *Tectonic Rumble (Sub + Noise)*, *Sub-Bass Pulse (Pure Deep)*, and *Abyssal Pad (Slow Swell)*.
  - **Harmonic Scales:** *Deep Dorian*, *Phrygian Dominant*, *Minor Pentatonic*, and *Just Intonation Drone*.
  - **Adjustable Root & Drone:** Tune the root frequency (`27.5 Hz`–`65.4 Hz`), adjust master volume, and toggle a continuous **41 Hz Earth Drone**.
- **Spatial & Depth Mapping:**
  - **Depth → Color & Register:** Shallow (`< 70 km`, Magma Coral), Mid (`70–300 km`, Amber Gold), and Deep (`≥ 300 km`, Abyssal Cyan).
  - **Longitude → Stereo Pan:** Earthquakes pan dynamically across the stereo field relative to the map viewport, visualized on dual left/right sub-bass spectrum analyzers.
- **Interactive Map:** Pan and zoom across the globe, toggle tectonic plate boundaries, click any earthquake to audition its sound, or `Shift + Click` anywhere on the map to trigger a synthetic tremor.

## Running Locally

Start the built-in local development server (requires Python 3):

```bash
python local.py
```