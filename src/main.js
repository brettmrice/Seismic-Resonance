import { SeismicAudioEngine } from './audio.js';
import {
  fetchEarthquakes,
  fetchEarthquakesByRange,
  fetchEarthquakesFromUrl,
  parseGeoJsonPayload,
} from './usgs.js';
import { SeismicMap } from './map.js';
import { SeismicRecorder, RESOLUTION_PRESETS, encodeWavBlob } from './recorder.js';

const SPEED_OPTIONS = [60, 180, 360, 480, 900];
const POLL_INTERVAL_MS = 30000;
const ASIDE_IDLE_MS = 10000;
const TOP_BAR_IDLE_MS = 10000;
const HUD_CARD_LINGER_MS = 1500;
const HUD_CARD_FADE_MS = 650;
const DATASET_WINDOW_LABELS = {
  all_hour: '1H (All)',
  all_day: '24H (All)',
  '2.5_day': '24H (M2.5+)',
  '4.5_week': '7D (M4.5+)',
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function freqToNote(hz) {
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function getShortTimeZone(date) {
  const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(date);
  return parts.find((p) => p.type === 'timeZoneName')?.value || '';
}

function formatLocalTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '-- --- --:--';
  const day = String(d.getDate()).padStart(2, '0');
  const mth = MONTHS_SHORT[d.getMonth()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const tz = getShortTimeZone(d);
  return tz ? `${day} ${mth} ${hh}:${mm} ${tz}` : `${day} ${mth} ${hh}:${mm}`;
}

function formatLocalDateInput(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatUtcDayMonth(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '-- ---';
  const day = String(d.getUTCDate()).padStart(2, '0');
  const mth = MONTHS_SHORT[d.getUTCMonth()];
  return `${day} ${mth}`;
}

function depthClass(depth) {
  if (depth < 70) return 'mag-shallow';
  if (depth < 300) return 'mag-mid';
  return 'mag-deep';
}

function depthColorRGB(depth) {
  if (depth < 70) return [255, 107, 53];  // Shallow: Magma Coral
  if (depth < 300) return [247, 184, 1];  // Mid: Amber Gold
  return [56, 189, 248];                  // Deep: Abyssal Cyan
}

function formatSpeedLabel(multiplier) {
  const hours = multiplier / 60;
  return `${multiplier}× | 1 min = ${hours}h`;
}

class App {
  constructor() {
    this.audio = new SeismicAudioEngine();
    this.allQuakes = [];
    this.filteredQuakes = [];
    this.seenIds = new Set();

    this.feedKey = 'all_day';
    this.mode = 'stream'; // 'stream' | 'live'
    this.speedMultiplier = 360;
    this.minMag = 0;
    this.maxMag = 10;
    this.dateRange = null;
    this.localGeoJsonUrl = null;
    this.cleanUI = false;
    this.recorder = new SeismicRecorder(this);

    // Stream replay state
    this.streamCursorTime = 0;
    this.streamIdx = 0;
    this.lastTriggeredId = null;
    this.eventCardById = new Map();
    this.ripplingCardIds = new Set();
    this.hudCardsById = new Map();
    this.lastFrameTime = performance.now();
    this.isPaused = false;
    this.isStreamPaused = false;
    this.isReadmeOpen = false;
    this.isRecorderOpen = false;
    this._urlCleanUI = false;
    this._prePauseFeedStatus = null;
    this.pauseStartedAt = 0;
    this.wasAudioRunning = false;
    this._rafId = null;

    // Smoothly transitioning L/R spectrum fill colors (matching map dot depth colors)
    this.spectrumColorL = [255, 107, 53];
    this.spectrumColorR = [255, 107, 53];
    this.spectrumTargetL = [255, 107, 53];
    this.spectrumTargetR = [255, 107, 53];

    this._initElements();
    this._initMap();
    this._bindControls();
    this._bindRecorderModal();
    this._initIdleAsides();
    this._applyUrlOverrides();
    this._exposeRecorderAPI();
    this._start();
  }

  _initElements() {
    this.mapCanvas = document.getElementById('map-canvas');
    this.audioCanvasLeft = document.getElementById('audio-canvas-left');
    this.audioCtxLeft = this.audioCanvasLeft.getContext('2d');
    this.audioCanvasRight = document.getElementById('audio-canvas-right');
    this.audioCtxRight = this.audioCanvasRight.getContext('2d');
    this.solarDialCanvas = document.getElementById('solar-dial-canvas');
    this.solarDialCtx = this.solarDialCanvas.getContext('2d');
    this.solarDialReadout = document.getElementById('solar-dial-readout');
    this.solarDialHoverX = null;
    this.depthLegendCanvas = document.getElementById('depth-legend-canvas');
    this.depthLegendCtx = this.depthLegendCanvas?.getContext('2d') || null;
    this.tooltip = document.getElementById('map-tooltip');

    this.btnAudio = document.getElementById('btn-audio-toggle');
    this.liveIndicator = document.getElementById('live-indicator');

    this.statFeedStatus = document.getElementById('stat-feed-status');
    this.statDatetimeEl = document.getElementById('stat-datetime');
    this.statDatasetValue = document.getElementById('stat-dataset-value');
    this.statEventCount = document.getElementById('stat-event-count');
    this.eventListEl = document.getElementById('event-list');
    this.hudEventListEl = document.getElementById('hud-event-list');

    if (this.statDatasetValue) {
      this.statDatasetValue.textContent = DATASET_WINDOW_LABELS[this.feedKey] || '24H (All)';
    }

    this.selectFeed = document.getElementById('select-feed');
    this.modeButtons = document.querySelectorAll('#mode-toggle button');
    this.speedField = document.getElementById('speed-field');
    this.rangeSpeed = document.getElementById('range-speed');
    this.valSpeed = document.getElementById('val-speed');
    this.rangeMinMag = document.getElementById('range-min-mag');
    this.valMinMag = document.getElementById('val-min-mag');

    this.selectTimbre = document.getElementById('select-timbre');
    this.selectScale = document.getElementById('select-scale');
    this.rangeRootFreq = document.getElementById('range-root-freq');
    this.valRootFreq = document.getElementById('val-root-freq');
    this.rangeVolume = document.getElementById('range-volume');
    this.valVolume = document.getElementById('val-volume');
    this.toggleDrone = document.getElementById('toggle-drone');
    this.selectChannels = document.getElementById('select-channels');
    this.channelLayoutNote = document.getElementById('channel-layout-note');
    this.togglePlates = document.getElementById('toggle-plates');
    this.btnTriggerLatest = document.getElementById('btn-trigger-latest');
    this.btnResetZoom = document.getElementById('btn-reset-zoom');
    this.mapModeToggle = document.getElementById('map-mode-toggle');

    this.btnStreamToggle = document.getElementById('btn-stream-toggle');
    this.btnReadme = document.getElementById('btn-readme');
    this.readmeBackdrop = document.getElementById('readme-modal-backdrop');
    this.btnReadmeClose = document.getElementById('btn-readme-close');
  }

  _initMap() {
    this.map = new SeismicMap(
      this.mapCanvas,
      (quake, cx, cy) => this._handleHover(quake, cx, cy),
      (quake) => this.triggerEvent(quake),
      (lon, lat) => {
        const synthetic = {
          id: `synth-${Date.now()}`,
          mag: 4.8,
          place: `Synthetic Tremor (${lat.toFixed(1)}°, ${lon.toFixed(1)}°)`,
          time: Date.now(),
          lon,
          lat,
          depth: 25,
        };
        this.triggerEvent(synthetic);
      },
      (zoom) => {
        if (this.btnResetZoom) {
          const isZoomed = Math.abs(zoom - 1) > 0.01;
          this.btnResetZoom.classList.toggle('visible', isZoomed);
          this.btnResetZoom.title = `Reset Zoom (${zoom.toFixed(1)}×)`;
          this.btnResetZoom.setAttribute('aria-label', `Reset Zoom (${zoom.toFixed(1)}×)`);
        }
      }
    );

    let savedMapMode = '3d';
    try {
      const stored = localStorage.getItem('seismic_map_mode');
      if (stored === '2d' || stored === '3d') savedMapMode = stored;
    } catch {
      // Ignore storage errors
    }
    this.map.setMapMode(savedMapMode, { animate: false });
    this._syncMapModeUI(savedMapMode);
  }

  _syncMapModeUI(mode) {
    if (!this.mapModeToggle) return;
    this.mapModeToggle.querySelectorAll('button[data-map-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mapMode === mode);
    });
  }

  _bindControls() {
    this.btnAudio.addEventListener('click', async () => {
      if (!this.audio.ctx || !this.audio.enabled) {
        await this.audio.init();
        this.audio.setEnabled(true);
        this._syncChannelLayoutUI();
        document.body.classList.add('audio-active');
        this.btnAudio.classList.add('active');
        this.btnAudio.title = 'Mute Audio';
        this.btnAudio.setAttribute('aria-label', 'Mute Audio');
        this.liveIndicator.classList.add('live');

        if (this.isPaused && this.audio.ctx && this.audio.ctx.state === 'running') {
          this.wasAudioRunning = true;
          try {
            await this.audio.ctx.suspend();
          } catch {
            // Ignore suspend errors
          }
        } else if (!this.isPaused && this.filteredQuakes.length > 0) {
          // Immediately audition the most recent quake on activation
          this.triggerEvent(this.filteredQuakes[this.filteredQuakes.length - 1]);
        }
      } else {
        this.audio.setEnabled(false);
        this.wasAudioRunning = false;
        document.body.classList.remove('audio-active');
        this.btnAudio.classList.remove('active');
        this.btnAudio.title = 'Start Audio';
        this.btnAudio.setAttribute('aria-label', 'Start Audio');
        this.liveIndicator.classList.remove('live');
      }
    });

    this.selectFeed.addEventListener('change', (e) => {
      this.feedKey = e.target.value;
      if (this.statDatasetValue) {
        this.statDatasetValue.textContent = DATASET_WINDOW_LABELS[this.feedKey] || '24H (All)';
      }
      this.seenIds.clear();
      this.loadFeed(true);
    });

    this.modeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.modeButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.mode = btn.dataset.mode;
        this.speedField.style.display = this.mode === 'stream' ? 'flex' : 'none';
        if (this.mode === 'stream') {
          this._resetStreamCursor();
        } else {
          this.map.stopAutoFollow();
          this.eventListEl.scrollTop = 0;
        }
      });
    });

    const onSpeedChange = (e) => {
      const idx = Number(e.target.value) - 1;
      this.speedMultiplier = SPEED_OPTIONS[idx] || 360;
      this.valSpeed.textContent = formatSpeedLabel(this.speedMultiplier);
      this._preCenteredId = null; // Recalculate glide speed for remaining delay
    };
    this.rangeSpeed.addEventListener('input', onSpeedChange);
    this.rangeSpeed.addEventListener('change', onSpeedChange);

    const onMinMagChange = (e) => {
      this.minMag = Number(e.target.value);
      this.valMinMag.textContent = `M${this.minMag.toFixed(1)}+`;
      this._applyFilters();
    };
    this.rangeMinMag.addEventListener('input', onMinMagChange);
    this.rangeMinMag.addEventListener('change', onMinMagChange);

    this.selectTimbre.addEventListener('change', (e) => {
      this.audio.setTimbre(e.target.value);
    });

    this.selectScale.addEventListener('change', (e) => {
      this.audio.setScale(e.target.value);
    });

    this.selectChannels?.addEventListener('change', (e) => {
      this.audio.setChannelCount(Number(e.target.value));
      if (this.audio.ctx) {
        this._syncChannelLayoutUI();
      }
    });

    const onRootFreqChange = (e) => {
      const hz = Number(e.target.value);
      this.audio.setRootFreq(hz);
      this.valRootFreq.textContent = `${hz.toFixed(1)} Hz (${freqToNote(hz)})`;
    };
    this.rangeRootFreq.addEventListener('input', onRootFreqChange);
    this.rangeRootFreq.addEventListener('change', onRootFreqChange);

    const onVolumeChange = (e) => {
      const pct = Number(e.target.value);
      this.audio.setVolume(pct / 100);
      this.valVolume.textContent = `${pct}%`;
    };
    this.rangeVolume.addEventListener('input', onVolumeChange);
    this.rangeVolume.addEventListener('change', onVolumeChange);

    this.btnResetZoom?.addEventListener('click', () => {
      this._resetViewToCurrentPosition();
    });

    this.mapModeToggle?.querySelectorAll('button[data-map-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mapMode === '2d' ? '2d' : '3d';
        this._syncMapModeUI(mode);
        this.map.setMapMode(mode, { animate: true });
        try {
          localStorage.setItem('seismic_map_mode', mode);
        } catch {
          // Ignore storage errors
        }
      });
    });

    this.solarDialCanvas.addEventListener('mousemove', (e) => {
      const rect = this.solarDialCanvas.getBoundingClientRect();
      this.solarDialHoverX = e.clientX - rect.left;
    });

    this.solarDialCanvas.addEventListener('mouseleave', () => {
      this.solarDialHoverX = null;
      this.solarDialReadout.classList.add('hidden');
    });

    window.addEventListener('resize', () => this._drawDepthLegend());
    document.fonts?.ready?.then(() => this._drawDepthLegend());
    this._drawDepthLegend();

    this.toggleDrone.addEventListener('change', (e) => {
      this.audio.setDrone(e.target.checked);
    });

    this.togglePlates.addEventListener('change', (e) => {
      this.map.setShowPlates(e.target.checked);
    });

    this.btnTriggerLatest.addEventListener('click', async () => {
      if (!this.audio.ctx || !this.audio.enabled) {
        await this.audio.init();
        this.audio.setEnabled(true);
        this._syncChannelLayoutUI();
        document.body.classList.add('audio-active');
        this.btnAudio.classList.add('active');
        this.btnAudio.title = 'Mute Audio';
        this.btnAudio.setAttribute('aria-label', 'Mute Audio');
        this.liveIndicator.classList.add('live');
      }
      if (this.filteredQuakes.length > 0) {
        this.triggerEvent(this.filteredQuakes[this.filteredQuakes.length - 1]);
      }
    });

    this.btnStreamToggle?.addEventListener('click', () => {
      this.toggleStreamActive();
    });

    this.btnReadme?.addEventListener('click', () => {
      this.openReadmeModal();
    });

    this.btnReadmeClose?.addEventListener('click', () => {
      this.closeReadmeModal();
    });

    this.readmeBackdrop?.addEventListener('click', (e) => {
      if (e.target === this.readmeBackdrop) {
        this.closeReadmeModal();
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isReadmeOpen) {
        this.closeReadmeModal();
      }
    });
  }

  _syncChannelLayoutUI() {
    if (!this.selectChannels || !this.audio.ctx) return;
    const maxCh = this.audio.getMaxChannelCount();
    let hasDisabled = false;
    for (const opt of this.selectChannels.options) {
      const ch = Number(opt.value);
      const unsupported = ch > maxCh;
      opt.disabled = unsupported;
      if (unsupported) hasDisabled = true;
    }
    this.selectChannels.value = String(this.audio.channelCount);
    if (this.channelLayoutNote) {
      const lfeActive = this.audio.channelCount >= 6 ? ' · LFE sub-bass active' : '';
      this.channelLayoutNote.textContent = hasDisabled
        ? `Device max: ${maxCh} ch (options above ${maxCh} ch disabled)${lfeActive}`
        : `Device max: ${maxCh} ch${lfeActive}`;
    }
  }

  /**
   * Slides the left and right aside panels out after ASIDE_IDLE_MS of no page/mouse
   * interaction, then slides the top bar up and out after an additional
   * TOP_BAR_IDLE_MS of inactivity, restoring both on the next interaction.
   */
  _initIdleAsides() {
    this._idleTimer = null;
    this._topBarIdleTimer = null;
    const resetIdleTimer = () => {
      if (this.cleanUI) return;
      document.body.classList.remove('asides-hidden', 'top-bar-hidden');
      this.map?.setAutoZoomEnabled(false);
      if (this._idleTimer !== null) {
        clearTimeout(this._idleTimer);
      }
      if (this._topBarIdleTimer !== null) {
        clearTimeout(this._topBarIdleTimer);
        this._topBarIdleTimer = null;
      }
      this._idleTimer = setTimeout(() => {
        if (!this.isPaused && !this.cleanUI && !this.isRecorderOpen) {
          document.body.classList.add('asides-hidden');
          if (this.map?._manualNavHold || Math.abs((this.map?.zoom ?? 1) - 1) > 0.01) {
            this._resetViewToCurrentPosition();
          }
          this._topBarIdleTimer = setTimeout(() => {
            if (!this.isPaused && !this.cleanUI && !this.isRecorderOpen) {
              document.body.classList.add('top-bar-hidden');
              this.map?.setAutoZoomEnabled(true);
              if (this.map?.canAutoTransition()) {
                if (this.mode === 'stream') {
                  this._updateStreamAutoCenter();
                } else if (this.filteredQuakes.length > 0) {
                  const selected = this.map.selectedQuakeId
                    ? this.filteredQuakes.find((q) => q.id === this.map.selectedQuakeId)
                    : null;
                  const currentQuake = selected || this.filteredQuakes[this.filteredQuakes.length - 1];
                  this._updateAutoCenterForQuake(currentQuake, 900);
                }
              }
            }
          }, TOP_BAR_IDLE_MS);
        }
      }, ASIDE_IDLE_MS);
    };

    const interactionEvents = [
      'mousemove',
      'mousedown',
      'mouseup',
      'wheel',
      'click',
      'pointermove',
      'pointerdown',
      'touchstart',
      'keydown',
    ];
    for (const evt of interactionEvents) {
      window.addEventListener(evt, resetIdleTimer, { passive: true });
    }

    this._resetIdleTimer = resetIdleTimer;
    resetIdleTimer();
  }

  async _enterPausedState() {
    if (this.isPaused) return;
    this.isPaused = true;
    this.pauseStartedAt = performance.now();

    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    if (this.audio.ctx && this.audio.ctx.state === 'running') {
      this.wasAudioRunning = true;
      try {
        await this.audio.ctx.suspend();
      } catch {
        // Ignore suspend errors if context state changed concurrently
      }
    } else {
      this.wasAudioRunning = false;
    }
  }

  async _exitPausedState() {
    if (!this.isPaused) return;
    this.isPaused = false;

    const pauseDelta = performance.now() - this.pauseStartedAt;
    this.lastFrameTime = performance.now();
    this.map.shiftTimers(pauseDelta);
    for (const entry of this.hudCardsById.values()) {
      entry.expiresAt += pauseDelta;
      if (entry.rippleEndedAt !== null) {
        entry.rippleEndedAt += pauseDelta;
      }
    }

    if (this.wasAudioRunning && this.audio.enabled && this.audio.ctx && this.audio.ctx.state === 'suspended') {
      try {
        await this.audio.ctx.resume();
      } catch {
        // Ignore resume errors if user revoked audio permissions
      }
    }
    this.wasAudioRunning = false;

    this._rafId = requestAnimationFrame((t) => this._loop(t));
  }

  async _syncPausedState() {
    const shouldPause = this.isStreamPaused || this.isReadmeOpen || Boolean(this._offlineRender?.active);
    if (shouldPause && !this.isPaused) {
      await this._enterPausedState();
    } else if (!shouldPause && this.isPaused) {
      await this._exitPausedState();
    }
  }

  _syncStreamToggleUI() {
    const paused = this.isStreamPaused;
    if (this.btnStreamToggle) {
      this.btnStreamToggle.classList.toggle('paused', paused);
      this.btnStreamToggle.setAttribute('aria-pressed', paused ? 'true' : 'false');
      const label = paused ? 'Resume Live / Stream' : 'Pause Live / Stream';
      this.btnStreamToggle.title = label;
      this.btnStreamToggle.setAttribute('aria-label', label);
    }
    this.liveIndicator?.classList.toggle('paused', paused);
    if (this.statFeedStatus) {
      if (paused) {
        if (this.statFeedStatus.textContent !== 'Paused') {
          this._prePauseFeedStatus = this.statFeedStatus.textContent;
          this.statFeedStatus.textContent = 'Paused';
        }
      } else if (this.statFeedStatus.textContent === 'Paused' && this._prePauseFeedStatus) {
        this.statFeedStatus.textContent = this._prePauseFeedStatus;
        this._prePauseFeedStatus = null;
      }
    }
  }

  async toggleStreamActive() {
    this.isStreamPaused = !this.isStreamPaused;
    this._syncStreamToggleUI();
    await this._syncPausedState();
  }

  async openReadmeModal() {
    if (this.isReadmeOpen) return;
    this.isReadmeOpen = true;
    await this._syncPausedState();

    if (this.readmeBackdrop) {
      this.readmeBackdrop.classList.remove('hidden');
    }
    this.btnReadme?.setAttribute('aria-expanded', 'true');
    this.btnReadmeClose?.focus();
  }

  async closeReadmeModal() {
    if (!this.isReadmeOpen) return;
    this.isReadmeOpen = false;

    if (this.readmeBackdrop) {
      this.readmeBackdrop.classList.add('hidden');
    }
    this.btnReadme?.setAttribute('aria-expanded', 'false');

    await this._syncPausedState();
    this.btnReadme?.focus();
  }

  async _start() {
    await this.map.loadGeoData();
    await this.loadFeed(true);
    setInterval(() => {
      if (!this.isPaused && !this.dateRange && !this.localGeoJsonUrl && !this.recorder.isRecording) {
        this.loadFeed(false);
      }
    }, POLL_INTERVAL_MS);
    this._rafId = requestAnimationFrame((t) => this._loop(t));
  }

  async loadFeed(isInitial = false) {
    try {
      this.statFeedStatus.textContent = 'Syncing…';
      let result;
      if (this.localGeoJsonUrl) {
        result = await fetchEarthquakesFromUrl(this.localGeoJsonUrl);
      } else if (this.dateRange?.startDate) {
        result = await fetchEarthquakesByRange({
          startDate: this.dateRange.startDate,
          endDate: this.dateRange.endDate,
          minMag: this.minMag,
          maxMag: this.maxMag,
        });
      } else {
        result = await fetchEarthquakes(this.feedKey);
      }
      const { events } = result;
      const newlyArrived = [];

      for (const q of events) {
        if (!this.seenIds.has(q.id)) {
          this.seenIds.add(q.id);
          if (!isInitial) {
            newlyArrived.push(q);
          }
        }
      }

      this.allQuakes = events;
      this._applyFilters(isInitial);
      if (isInitial && this.filteredQuakes.length > 0 && this.map.canAutoTransition()) {
        const currentQuake =
          this.mode === 'stream'
            ? this.filteredQuakes[0]
            : this.filteredQuakes[this.filteredQuakes.length - 1];
        if (currentQuake) {
          this.map.centerOn(currentQuake.lon, currentQuake.lat);
          if (this.mode === 'stream') {
            this.map.setSolarTime(this.streamCursorTime);
            this._setDatetimeDisplay(this.streamCursorTime);
          }
        }
      }
      this.statFeedStatus.textContent = this.localGeoJsonUrl
        ? 'Offline GeoJSON'
        : this.dateRange?.startDate
          ? 'USGS Archive'
          : 'USGS Live';

      // Trigger real-time incoming earthquakes
      if (!isInitial && newlyArrived.length > 0) {
        newlyArrived
          .filter((q) => q.mag >= this.minMag && q.mag <= this.maxMag)
          .slice(-5)
          .forEach((q, i) => {
            setTimeout(() => this.triggerEvent(q), i * 240);
          });
      }
    } catch (err) {
      console.error(err);
      this.statFeedStatus.textContent = 'Feed Error';
    }
  }

  _applyFilters(resetStream = false) {
    this.filteredQuakes = this.allQuakes.filter(
      (q) => q.mag >= this.minMag && q.mag <= this.maxMag
    );
    this.map.setQuakes(this.filteredQuakes);

    this.statEventCount.textContent = String(this.filteredQuakes.length);

    this._renderEventList();
    if (resetStream) {
      this._resetStreamCursor();
    }
  }

  _resetStreamCursor() {
    this._preCenteredId = null;
    if (!this.filteredQuakes.length) {
      this.streamCursorTime = Date.now();
      this.streamIdx = 0;
      return;
    }
    this.streamCursorTime = this.filteredQuakes[0].time - 1000;
    this.streamIdx = 0;
    if (this.mode === 'stream' && this.eventListEl) {
      // Stream starts at the oldest event (bottom of the newest-first list)
      this.eventListEl.scrollTop = this.eventListEl.scrollHeight;
    }
  }

  _scrollEventCardToCenter(card) {
    if (!card || !this.eventListEl) return;
    const viewH = this.eventListEl.clientHeight;
    if (viewH <= 0) return;

    const listRect = this.eventListEl.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const cardTop = cardRect.top - listRect.top + this.eventListEl.scrollTop;
    const cardCenter = cardTop + cardRect.height / 2;

    const maxScrollTop = Math.max(0, this.eventListEl.scrollHeight - viewH);
    const targetScrollTop = Math.max(0, Math.min(maxScrollTop, cardCenter - viewH / 2));
    this.eventListEl.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
  }

  /**
   * Builds a DOM card element for a seismic event.
   */
  _createEventCard(q, { interactive = true } = {}) {
    const depth = q.depth ?? 10;
    const card = document.createElement('div');
    card.className = 'event-card';
    card.dataset.id = q.id;
    card.style.setProperty('--depth-rgb', depthColorRGB(depth).join(', '));
    card.innerHTML = `
      <div class="mag-badge ${depthClass(depth)}">${q.mag.toFixed(1)}</div>
      <div class="event-info">
        <div class="event-place" title="${q.place}">${q.place}</div>
        <div class="event-meta" title="${new Date(q.time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' })}"><span>${depth.toFixed(1)} km</span><span class="event-time">${formatLocalTime(q.time)}</span></div>
      </div>
    `;
    if (interactive) {
      card.addEventListener('click', () => this.triggerEvent(q));
    }
    return card;
  }

  _renderEventList() {
    this.eventCardById.clear();
    this.ripplingCardIds.clear();
    const recent = [...this.filteredQuakes].reverse();
    if (!recent.length) {
      this.eventListEl.innerHTML = '<div class="empty-state">No earthquakes match filter.</div>';
      return;
    }

    this.eventListEl.innerHTML = '';
    const fragment = document.createDocumentFragment();
    for (const q of recent) {
      const card = this._createEventCard(q, { interactive: true });
      if (q.id === this.lastTriggeredId) {
        card.classList.add('triggered');
      }
      this.eventCardById.set(q.id, card);
      fragment.appendChild(card);
    }
    this.eventListEl.appendChild(fragment);

    if (this.lastTriggeredId) {
      const activeCard = this.eventCardById.get(this.lastTriggeredId);
      if (activeCard) {
        this._scrollEventCardToCenter(activeCard);
      }
    }
  }

  /**
   * Prepends a fired event card to the top of the idle/hidden HUD feed.
   */
  _pushHudEventCard(quake, voice = null) {
    if (!this.hudEventListEl || !quake?.id) return;
    const existing = this.hudCardsById.get(quake.id);
    if (existing) {
      existing.card.remove();
    }

    const card = this._createEventCard(quake, { interactive: false });
    card.classList.add('rippling');
    card.style.setProperty('--wave-progress', '0');
    card.style.setProperty('--wave-alpha', '0.9');
    card.style.setProperty('--hud-opacity', '1');
    this.hudEventListEl.prepend(card);

    const mag = Math.max(0.5, quake.mag ?? 1.5);
    const durationMs = voice?.durationMs ?? (2400 + mag * 520);
    const latencyMs = voice?.latencyMs ?? 0;
    this.hudCardsById.set(quake.id, {
      card,
      hasRippled: false,
      rippleEndedAt: null,
      expiresAt: performance.now() + latencyMs + durationMs + 500,
    });
  }

  _quakePullWeight(quake) {
    // Earthquake magnitude is logarithmic (base 10): +1.0 mag = ~3.16x pull (+2.0 mag = 10x)
    const mag = Math.max(0, quake?.mag ?? 2.5);
    return Math.pow(10, 0.5 * (mag - 2.5));
  }

  _resetViewToCurrentPosition() {
    if (this.filteredQuakes.length > 0) {
      this.map.resetView({ preservePosition: true });
      if (this.mode === 'stream') {
        this._updateStreamAutoCenter();
      } else {
        const selected = this.map.selectedQuakeId
          ? this.filteredQuakes.find((q) => q.id === this.map.selectedQuakeId)
          : null;
        const currentQuake = selected || this.filteredQuakes[this.filteredQuakes.length - 1];
        this._updateAutoCenterForQuake(currentQuake, 600);
      }
    } else {
      this.map.resetView();
    }
  }

  _magToAutoZoom(mag) {
    // Zoom in on low magnitudes (~2.75x at M1.0) and zoom out on high magnitudes (~0.78x at M7.5+)
    const m = Number.isFinite(mag) ? mag : 4.5;
    const t = Math.max(0, Math.min(1, (m - 1.0) / 6.5));
    const minZoom = 0.78;
    const maxZoom = 2.75;
    return maxZoom * Math.pow(minZoom / maxZoom, t);
  }

  _updateAutoCenterForQuake(quake, durationMs = 300) {
    if (!quake) return;
    const list = this.filteredQuakes;
    const idx = list.findIndex((q) => q.id === quake.id);
    const windowQuakes =
      idx === -1
        ? [quake]
        : list.slice(Math.max(0, idx - 2), Math.min(list.length, idx + 3));

    if (!windowQuakes.length) return;
    const DEG2RAD = Math.PI / 180;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let magNum = 0;
    let magDen = 0;
    for (const q of windowQuakes) {
      const w = this._quakePullWeight(q);
      const lonRad = (q.lon || 0) * DEG2RAD;
      const latRad = (q.lat || 0) * DEG2RAD;
      const cosLat = Math.cos(latRad);
      sx += w * cosLat * Math.cos(lonRad);
      sy += w * cosLat * Math.sin(lonRad);
      sz += w * Math.sin(latRad);
      magNum += w * Math.max(0, q.mag ?? 2.5);
      magDen += w;
    }
    const avgLon = Math.atan2(sy, sx) / DEG2RAD;
    const avgLat = Math.atan2(sz, Math.hypot(sx, sy)) / DEG2RAD;
    const effectiveMag = magDen > 0 ? magNum / magDen : (quake.mag ?? 2.5);
    const targetZoom = this._magToAutoZoom(effectiveMag);
    this.map.setAutoCenterLon(avgLon, durationMs, avgLat, targetZoom);
  }

  _updateStreamAutoCenter() {
    const list = this.filteredQuakes;
    if (!list.length) return;

    const idx = Math.max(0, Math.min(list.length, this.streamIdx));
    const prevQuake = idx > 0 ? list[idx - 1] : null;
    const nextQuake = idx < list.length ? list[idx] : null;

    let gapProgress = 1;
    if (prevQuake && nextQuake) {
      const span = Math.max(1, nextQuake.time - prevQuake.time);
      gapProgress = Math.max(0, Math.min(1, (this.streamCursorTime - prevQuake.time) / span));
    }

    const start = Math.max(0, idx - 3);
    const end = Math.min(list.length, idx + 4);
    const sigmaSec = 1.8;
    const DEG2RAD = Math.PI / 180;

    let sx = 0;
    let sy = 0;
    let sz = 0;
    let magNum = 0;
    let magDen = 0;

    for (let i = start; i < end; i++) {
      const q = list[i];
      const dtSec = (q.time - this.streamCursorTime) / (1000 * this.speedMultiplier);
      let wTime = Math.exp(-0.5 * (dtSec / sigmaSec) * (dtSec / sigmaSec));

      // Smoothly bridge wide time gaps between prevQuake and nextQuake
      if (q === prevQuake) wTime = Math.max(wTime, 0.08 * (1 - gapProgress));
      if (q === nextQuake) wTime = Math.max(wTime, 0.08 * (prevQuake ? gapProgress : 1));

      if (wTime < 1e-4) continue;

      const mag = Math.max(0, q.mag ?? 2.5);
      const w = wTime * this._quakePullWeight(q);
      const lonRad = (q.lon || 0) * DEG2RAD;
      const latRad = (q.lat || 0) * DEG2RAD;
      const cosLat = Math.cos(latRad);
      sx += w * cosLat * Math.cos(lonRad);
      sy += w * cosLat * Math.sin(lonRad);
      sz += w * Math.sin(latRad);
      magNum += w * mag;
      magDen += w;
    }

    const effectiveMag = magDen > 0 ? magNum / magDen : 2.5;
    const targetZoom = this._magToAutoZoom(effectiveMag);
    const pullBoost = Math.max(0, Math.min(1, (effectiveMag - 3.5) / 4.5));
    const smoothTimeSec = 1.45 - 0.55 * pullBoost;

    if (Math.hypot(sx, sy, sz) > 1e-4) {
      const avgLon = Math.atan2(sy, sx) / DEG2RAD;
      const avgLat = Math.atan2(sz, Math.hypot(sx, sy)) / DEG2RAD;
      this.map.setAutoCenterTarget(avgLon, avgLat, smoothTimeSec, targetZoom);
    } else if (nextQuake) {
      this.map.setAutoCenterTarget(nextQuake.lon, nextQuake.lat, smoothTimeSec, targetZoom);
    } else if (prevQuake) {
      this.map.setAutoCenterTarget(prevQuake.lon, prevQuake.lat, smoothTimeSec, targetZoom);
    }
  }

  triggerEvent(quake, { syncStream = true } = {}) {
    if (syncStream && this.mode === 'stream') {
      const idx = this.filteredQuakes.findIndex((q) => q.id === quake.id);
      if (idx !== -1) {
        this.streamCursorTime = quake.time;
        this.streamIdx = idx + 1;
        this._preCenteredId = null;
        this.map.setSolarTime(this.streamCursorTime);
        this._setDatetimeDisplay(this.streamCursorTime);
      }
    }

    this.map.setSelectedQuake(quake.id);
    if (this.mode !== 'stream') {
      this._updateAutoCenterForQuake(quake, 600);
    }

    const spatial = this.map.getSolarSpatialPan(quake.lon, quake.lat);
    if (this._offlineRender?.active) {
      this._offlineRender.audioEvents.push({
        timeSec: this._offlineRender.clockMs / 1000,
        quake,
        spatial,
      });
    }
    const voice = this.audio.triggerQuake(quake, spatial);
    this.map.spawnWave(quake, voice);
    this._pushHudEventCard(quake, voice);

    const pan = spatial.x * 0.85;
    const rgb = depthColorRGB(quake.depth ?? 10);
    const wL = Math.max(0.15, Math.min(1, (1 - pan) * 0.55));
    const wR = Math.max(0.15, Math.min(1, (1 + pan) * 0.55));
    for (let i = 0; i < 3; i++) {
      this.spectrumTargetL[i] += (rgb[i] - this.spectrumTargetL[i]) * wL;
      this.spectrumTargetR[i] += (rgb[i] - this.spectrumTargetR[i]) * wR;
    }

    // Highlight in right-hand list if present
    this.lastTriggeredId = quake.id;
    const prev = this.eventListEl.querySelector('.event-card.triggered');
    if (prev) prev.classList.remove('triggered');
    const card = this.eventListEl.querySelector(`.event-card[data-id="${CSS.escape(quake.id)}"]`);
    if (card) {
      card.classList.add('triggered');
      this._scrollEventCardToCenter(card);
    }
  }

  _handleHover(quake, cx, cy) {
    if (!quake) {
      this.tooltip.classList.add('hidden');
      return;
    }
    this.tooltip.innerHTML = `
      <strong>M ${quake.mag.toFixed(1)}</strong> — ${quake.place}<br/>
      <span class="mono muted">Depth: ${quake.depth.toFixed(1)} km · ${formatLocalTime(quake.time)}</span>
    `;
    this.tooltip.style.left = `${Math.min(window.innerWidth - 260, cx + 14)}px`;
    this.tooltip.style.top = `${Math.min(window.innerHeight - 90, cy + 14)}px`;
    this.tooltip.classList.remove('hidden');
  }

  _setDatetimeDisplay(ts) {
    const formatted = formatLocalTime(ts);
    if (this.statDatetimeEl) this.statDatetimeEl.textContent = formatted;
  }

  _stepStream(dtMs) {
    if (this.mode !== 'stream' || !this.filteredQuakes.length) {
      const nowMs = Date.now();
      this.map.setSolarTime(nowMs);
      this._setDatetimeDisplay(nowMs);
      return;
    }

    this.streamCursorTime += dtMs * this.speedMultiplier;
    const lastTime = this.filteredQuakes[this.filteredQuakes.length - 1].time;

    while (
      this.streamIdx < this.filteredQuakes.length &&
      this.filteredQuakes[this.streamIdx].time <= this.streamCursorTime
    ) {
      this.triggerEvent(this.filteredQuakes[this.streamIdx], { syncStream: false });
      this.streamIdx++;
    }

    // Continuously update the time-weighted target for the critically damped auto-camera
    if (this.map.canAutoTransition()) {
      this._updateStreamAutoCenter();
    }

    if (this.streamCursorTime > lastTime + 60000) {
      if (this._offlineRender?.active) {
        this._offlineRender.cycleComplete = true;
      } else {
        this._preCenteredId = null;
        this.recorder.handleStreamCycleComplete();
        window.dispatchEvent(new CustomEvent('seismic-cycle-complete'));
        this._resetStreamCursor();
      }
    }

    this.map.setSolarTime(this.streamCursorTime);
    this._setDatetimeDisplay(this.streamCursorTime);
  }

  _computeOfflineSpectrum(dtMs = 16) {
    const st = this._offlineRender;
    const tSec = st.clockMs / 1000;
    const numBins = st.specBinsL.length;
    const minFreq = 20;
    const maxFreq = 450;
    const logMin = Math.log(minFreq);
    const logMax = Math.log(maxFreq);
    const logSpan = logMax - logMin;

    const instL = new Float32Array(numBins);
    const instR = new Float32Array(numBins);
    const instDrone = new Float32Array(numBins);

    const waveLen = 256;
    const waveL = new Float32Array(waveLen);
    const waveR = new Float32Array(waveLen);
    const droneWave = st.droneEnabled ? new Float32Array(waveLen) : null;

    const addPeak = (arr, freq, amp, sigma = 0.045) => {
      if (freq < minFreq * 0.8 || freq > maxFreq * 1.2 || amp <= 0.001) return;
      const center = (Math.log(Math.max(minFreq, Math.min(maxFreq, freq))) - logMin) / logSpan;
      const halfSpan = Math.ceil(sigma * 3.2 * numBins);
      const cIdx = Math.round(center * (numBins - 1));
      const i0 = Math.max(0, cIdx - halfSpan);
      const i1 = Math.min(numBins - 1, cIdx + halfSpan);
      for (let i = i0; i <= i1; i++) {
        const d = (i / (numBins - 1) - center) / sigma;
        arr[i] += amp * Math.exp(-d * d);
      }
    };

    const timbre = this.audio.timbre || 'tectonic';
    const vol = this.audio.volume ?? 0.8;
    const events = st.audioEvents;
    const windowSec = 0.08;

    // Advance cursor past events whose envelope + tail have fully decayed
    while (st.specEventStartIdx < events.length) {
      const ev = events[st.specEventStartIdx];
      const mag = Math.max(0.2, ev.quake.mag ?? 1.5);
      const magNorm = Math.min(1, Math.max(0, (mag - 0.5) / 6.0));
      const dur = 1.1 + magNorm * 5.1;
      const maxEnd = ev.timeSec + dur + 1.6;
      if (maxEnd < tSec) {
        st.specEventStartIdx += 1;
      } else {
        break;
      }
    }

    let activeCount = 0;
    for (let idx = st.specEventStartIdx; idx < events.length; idx++) {
      const ev = events[idx];
      if (ev.timeSec > tSec) break;
      const dt = tSec - ev.timeSec;
      const mag = Math.max(0.2, ev.quake.mag ?? 1.5);
      const magNorm = Math.min(1, Math.max(0, (mag - 0.5) / 6.0));
      const depth = Math.max(0, Math.min(650, ev.quake.depth ?? 10));
      const depthNorm = 1 - depth / 650;
      const duration = 1.1 + magNorm * 5.1;
      const isAbyssal = timbre === 'abyssal';
      const isSubpulse = timbre === 'subpulse';
      const sDelay = !isAbyssal && !isSubpulse ? 0.06 + (1 - depthNorm) * 0.07 : 0;
      const attack = isAbyssal ? 0.38 + magNorm * 0.55 : isSubpulse ? 0.025 : sDelay + 0.055;
      const totalDuration = isAbyssal ? duration + 1.4 : sDelay + duration;
      if (dt > totalDuration) continue;

      activeCount += 1;
      const polyScale = Math.max(0.32, 1 / Math.sqrt(activeCount));
      const gainLevel = (0.14 + magNorm * 0.46) * polyScale * vol;

      let env = 0;
      if (dt < attack) {
        env = dt / Math.max(0.005, attack);
      } else {
        const rel = (dt - attack) / Math.max(0.1, totalDuration - attack);
        env = Math.pow(0.008, rel);
      }
      if (env <= 0.002) continue;

      const freq = this.audio.computeFrequency(ev.quake);
      const pan = Math.max(-0.85, Math.min(0.85, ev.spatial?.x || 0));
      const theta = (pan + 1) * Math.PI * 0.25;
      const gL = Math.cos(theta);
      const gR = Math.sin(theta);
      const subTheta = (pan * 0.45 + 1) * Math.PI * 0.25;
      const subGL = Math.cos(subTheta);
      const subGR = Math.sin(subTheta);

      const amp = Math.min(1.0, gainLevel * env * 2.1);
      addPeak(instL, freq, amp * subGL, 0.042);
      addPeak(instR, freq, amp * subGR, 0.042);

      if (isSubpulse) {
        const subF = Math.max(24, freq * 0.5);
        addPeak(instL, subF, amp * 0.7 * subGL, 0.045);
        addPeak(instR, subF, amp * 0.7 * subGR, 0.045);
      } else if (isAbyssal) {
        const subF = Math.max(24, freq * 0.5);
        addPeak(instL, subF, amp * 0.5 * subGL, 0.045);
        addPeak(instR, subF, amp * 0.5 * subGR, 0.045);
        addPeak(instL, freq * 2, amp * 0.35 * gL, 0.04);
        addPeak(instR, freq * 2, amp * 0.35 * gR, 0.04);
        addPeak(instL, freq * 3, amp * 0.2 * gL, 0.038);
        addPeak(instR, freq * 3, amp * 0.2 * gR, 0.038);
      } else {
        const bodyF = magNorm > 0.55 ? Math.max(24, freq * 0.5) : freq * 1.5;
        addPeak(instL, bodyF, amp * 0.55 * gL, 0.045);
        addPeak(instR, bodyF, amp * 0.55 * gR, 0.045);
        if (dt < 0.18) {
          const pEnv = 1 - dt / 0.18;
          addPeak(instL, freq * 2.1, amp * 0.45 * pEnv * gL, 0.04);
          addPeak(instR, freq * 2.1, amp * 0.45 * pEnv * gR, 0.04);
        }
      }

      for (let i = 0; i < waveLen; i++) {
        const wt = tSec + (i / waveLen) * windowSec;
        const s = Math.sin(2 * Math.PI * freq * wt) * amp * 0.55;
        waveL[i] += s * subGL;
        waveR[i] += s * subGR;
      }
    }

    if (st.droneEnabled && droneWave) {
      const rootF = this.audio.rootFreq || 36.7;
      const lfo = 0.65 + 0.35 * Math.sin(2 * Math.PI * 0.07 * tSec);
      const dAmp = 0.32 * vol * lfo;
      addPeak(instDrone, rootF, dAmp, 0.05);
      addPeak(instDrone, rootF * 1.5, dAmp * 0.55, 0.045);
      for (let i = 0; i < waveLen; i++) {
        const wt = tSec + (i / waveLen) * windowSec;
        droneWave[i] = (Math.sin(2 * Math.PI * rootF * wt) + 0.4 * Math.sin(2 * Math.PI * rootF * 1.5 * wt)) * dAmp * 0.5;
      }
    }

    // Match AnalyserNode smoothingTimeConstant (0.82 at 60fps)
    const decay = Math.pow(0.82, Math.max(0.25, dtMs / 16.67));
    const rise = 1 - decay;
    for (let i = 0; i < numBins; i++) {
      const tL = Math.min(1, instL[i]);
      const tR = Math.min(1, instR[i]);
      const tD = Math.min(1, instDrone[i]);
      st.specBinsL[i] = st.specBinsL[i] * decay + tL * rise;
      st.specBinsR[i] = st.specBinsR[i] * decay + tR * rise;
      st.specDroneBins[i] = st.specDroneBins[i] * decay + tD * rise;
    }

    return {
      left: { freqBins: st.specBinsL, wave: waveL, droneBins: st.droneEnabled ? st.specDroneBins : null, droneWave },
      right: { freqBins: st.specBinsR, wave: waveR, droneBins: st.droneEnabled ? st.specDroneBins : null, droneWave },
    };
  }

  _drawAudioSpectrum(dtMs = 16) {
    const colorBlend = 1 - Math.exp(-dtMs * 0.008);
    for (let i = 0; i < 3; i++) {
      this.spectrumColorL[i] += (this.spectrumTargetL[i] - this.spectrumColorL[i]) * colorBlend;
      this.spectrumColorR[i] += (this.spectrumTargetR[i] - this.spectrumColorR[i]) * colorBlend;
    }

    const offlineSpec = this._offlineRender?.active ? this._computeOfflineSpectrum(dtMs) : null;
    const enabled = Boolean(this.audio.analyserLeft && this.audio.analyserRight && this.audio.enabled);
    const droneAnalyser = enabled ? this.audio.droneAnalyser : null;

    this._drawSpectrumChannel(
      this.audioCanvasLeft,
      this.audioCtxLeft,
      -1,
      enabled ? this.audio.analyserLeft : null,
      droneAnalyser,
      this.spectrumColorL,
      offlineSpec?.left ?? null,
    );
    this._drawSpectrumChannel(
      this.audioCanvasRight,
      this.audioCtxRight,
      1,
      enabled ? this.audio.analyserRight : null,
      droneAnalyser,
      this.spectrumColorR,
      offlineSpec?.right ?? null,
    );
  }

  _drawSpectrumChannel(canvas, ctx, dir, analyser, droneAnalyser, rgb, offlineSpec = null) {
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width;
    const cssH = rect.height;
    if (cssW <= 0 || cssH <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.round(cssW * dpr);
    const targetH = Math.round(cssH * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const minFreq = 20;
    const maxFreq = 450;
    const logRatio = Math.log(maxFreq / minFreq);
    const specTop = 4;
    const axisY = Math.round(cssH - 6);
    const specH = Math.max(8, axisY - specTop);
    const labelY = axisY - 4;
    const minorFreqs = [30, 40, 70, 150, 300];
    const majorFreqs = [50, 100, 200, 450];
    const lowEdgeX = dir < 0 ? cssW : 0;
    const freqToX = (f) => {
      const t = Math.log(f / minFreq) / logRatio;
      return dir < 0 ? cssW - t * cssW : t * cssW;
    };

    // Draw axis labels above the axis and behind any spectrum bars
    ctx.textBaseline = 'bottom';
    ctx.font = '600 10px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(241, 245, 249, 0.92)';
    ctx.textAlign = dir < 0 ? 'right' : 'left';
    ctx.fillText('20 Hz', dir < 0 ? cssW - 6 : 6, labelY);

    ctx.fillStyle = 'rgba(241, 245, 249, 0.88)';
    for (const f of majorFreqs) {
      if (f === maxFreq) {
        ctx.textAlign = dir < 0 ? 'left' : 'right';
        ctx.fillText(`${f}`, dir < 0 ? 6 : cssW - 6, labelY);
      } else {
        ctx.textAlign = 'center';
        ctx.fillText(`${f}`, freqToX(f), labelY);
      }
    }

    if (analyser || offlineSpec) {
      const sampleRate = this.audio.ctx?.sampleRate || 48000;
      const spanW = Math.ceil(cssW);

      const fillSpectrumArea = (sourceAnalyser, offlineBins, fillStyle) => {
        const freqData = sourceAnalyser ? new Uint8Array(sourceAnalyser.frequencyBinCount) : null;
        if (sourceAnalyser) sourceAnalyser.getByteFrequencyData(freqData);
        const binHz = sourceAnalyser ? sampleRate / sourceAnalyser.fftSize : 1;
        const maxBin = freqData ? freqData.length - 1 : 0;
        const offMax = offlineBins ? offlineBins.length - 1 : 0;

        ctx.fillStyle = fillStyle;
        ctx.beginPath();
        ctx.moveTo(lowEdgeX, axisY);
        for (let offset = 0; offset <= spanW; offset += 1) {
          const t = Math.min(1, offset / cssW);
          let v = 0;
          if (offlineBins) {
            const idxF = t * offMax;
            const i0 = Math.floor(idxF);
            const i1 = Math.min(offMax, i0 + 1);
            const frac = idxF - i0;
            v = offlineBins[i0] * (1 - frac) + offlineBins[i1] * frac;
          } else {
            const freq = minFreq * Math.pow(maxFreq / minFreq, t);
            const binFloat = freq / binHz;
            const b0 = Math.min(maxBin, Math.floor(binFloat));
            const b1 = Math.min(maxBin, b0 + 1);
            const frac = binFloat - b0;
            v = (freqData[b0] * (1 - frac) + freqData[b1] * frac) / 255;
          }

          const barH = v * (specH - 2);
          const x = dir < 0 ? cssW - offset : offset;
          ctx.lineTo(x, axisY - barH);
        }
        ctx.lineTo(dir < 0 ? cssW - spanW : spanW, axisY);
        ctx.closePath();
        ctx.fill();
      };

      // Draw Earth Drone spectrum behind the event spectrum in translucent blue
      if (droneAnalyser || offlineSpec?.droneBins) {
        fillSpectrumArea(droneAnalyser, offlineSpec?.droneBins ?? null, 'rgba(56, 189, 248, 0.28)');
      }

      const r = Math.round(rgb[0]);
      const g = Math.round(rgb[1]);
      const b = Math.round(rgb[2]);
      const rHi = Math.min(255, r + 42);
      const gHi = Math.min(255, g + 42);
      const bHi = Math.min(255, b + 32);

      const grad = ctx.createLinearGradient(0, axisY, 0, specTop);
      grad.addColorStop(0, `rgb(${r}, ${g}, ${b})`);
      grad.addColorStop(1, `rgb(${rHi}, ${gHi}, ${bHi})`);
      fillSpectrumArea(analyser, offlineSpec?.freqBins ?? null, grad);

      const midY = specTop + specH / 2;
      const width = Math.floor(cssW);
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.65)';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      if (offlineSpec) {
        const wData = offlineSpec.wave;
        const dData = offlineSpec.droneWave;
        const wMax = wData.length - 1;
        for (let i = 0; i < width; i++) {
          const idx = Math.min(wMax, Math.floor((i / Math.max(1, width - 1)) * wMax));
          let v = wData[idx];
          if (dData) v += dData[idx];
          const y = midY + Math.max(-1, Math.min(1, v)) * (specH * 0.42);
          if (i === 0) ctx.moveTo(i, y);
          else ctx.lineTo(i, y);
        }
      } else {
        const timeData = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(timeData);
        let droneTimeData = null;
        if (droneAnalyser) {
          droneTimeData = new Uint8Array(droneAnalyser.fftSize);
          droneAnalyser.getByteTimeDomainData(droneTimeData);
        }
        const step = Math.max(1, Math.floor(timeData.length / Math.max(1, width)));
        for (let i = 0; i < width; i++) {
          const idx = Math.min(timeData.length - 1, i * step);
          let v = timeData[idx] / 128.0 - 1.0;
          if (droneTimeData) {
            v += droneTimeData[idx] / 128.0 - 1.0;
          }
          const y = midY + v * (specH * 0.42);
          if (i === 0) ctx.moveTo(i, y);
          else ctx.lineTo(i, y);
        }
      }
      ctx.stroke();
    } else {
      const midY = specTop + specH / 2;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, midY);
      ctx.lineTo(cssW, midY);
      ctx.stroke();
    }

    // Horizontal frequency axis beneath the spectrum
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, axisY);
    ctx.lineTo(cssW, axisY);
    ctx.stroke();

    // Minor ticks (unlabeled)
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.lineWidth = 1;
    for (const f of minorFreqs) {
      const x = freqToX(f);
      ctx.beginPath();
      ctx.moveTo(x, axisY);
      ctx.lineTo(x, axisY + 3);
      ctx.stroke();
    }

    // Major ticks
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.72)';
    ctx.lineWidth = 1.25;
    for (const f of majorFreqs) {
      const x = freqToX(f);
      ctx.beginPath();
      ctx.moveTo(x, axisY);
      ctx.lineTo(x, axisY + 4);
      ctx.stroke();
    }

    ctx.restore();
  }

  _drawSolarDial() {
    const canvas = this.solarDialCanvas;
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width;
    const cssH = rect.height;
    if (cssW <= 0 || cssH <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.round(cssW * dpr);
    const targetH = Math.round(cssH * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const ctx = this.solarDialCtx;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const { sunScreenX, worldW, sunLon } = this.map.getSolarDialMetrics();
    if (!Number.isFinite(worldW) || worldW <= 0) {
      ctx.restore();
      return;
    }

    const sunLocalX = sunScreenX - rect.left;
    const pxPerHour = worldW / 24;

    // Determine tile range k so the 24h dial wraps seamlessly across the visible bar
    const kMin = Math.floor((-sunLocalX - worldW) / worldW);
    const kMax = Math.ceil((cssW - sunLocalX + worldW) / worldW);

    const axisY = Math.round(cssH * 0.30);
    const labelY = axisY + 6;
    const dateY = labelY + 15;

    // Horizontal dial axis spanning the bar
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, axisY);
    ctx.lineTo(cssW, axisY);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '600 10px "JetBrains Mono", monospace';

    let midnightX = null;
    let midnightTileK = 0;

    for (let k = kMin; k <= kMax; k++) {
      const tileSunX = sunLocalX + k * worldW;
      for (let h = 0; h < 24; h++) {
        const x = tileSunX + (h - 12) * pxPerHour;
        if (x < -30 || x > cssW + 30) continue;

        const isMajor = h % 3 === 0;
        const isNoon = h === 12;
        if (h === 0 && x >= 0 && x <= cssW) {
          midnightX = x;
          midnightTileK = k;
        }

        if (isNoon) {
          // Sun-aligned 1200 marker
          ctx.strokeStyle = 'rgba(255, 224, 130, 0.95)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x, axisY - 9);
          ctx.lineTo(x, axisY + 3);
          ctx.stroke();

          // Small sun alignment pip above the noon tick
          ctx.fillStyle = '#ffe082';
          ctx.beginPath();
          ctx.moveTo(x, axisY - 12);
          ctx.lineTo(x - 3, axisY - 8);
          ctx.lineTo(x + 3, axisY - 8);
          ctx.closePath();
          ctx.fill();

          ctx.fillStyle = '#ffe082';
          ctx.fillText('1200', x, labelY);
        } else if (isMajor) {
          ctx.strokeStyle = 'rgba(226, 232, 240, 0.78)';
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          ctx.moveTo(x, axisY - 7);
          ctx.lineTo(x, axisY + 3);
          ctx.stroke();

          const label = `${String(h).padStart(2, '0')}00`;
          ctx.fillStyle = 'rgba(241, 245, 249, 0.92)';
          ctx.fillText(label, x, labelY);
        } else {
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.38)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, axisY - 4);
          ctx.lineTo(x, axisY + 2);
          ctx.stroke();
        }
      }
    }

    // "## Mth" date row aligned with solar midnight & stream time
    const streamMs = Number.isFinite(this.map.solarTimeMs) ? this.map.solarTimeMs : Date.now();
    const solarNoonMs = streamMs + (sunLon / 15) * 3600000;
    const centerX = cssW / 2;
    const markerPad = 8;

    ctx.font = '600 10px "JetBrains Mono", monospace';
    ctx.textBaseline = 'top';

    if (midnightX !== null) {
      const currDayLabel = formatUtcDayMonth(solarNoonMs + midnightTileK * 86400000);
      const prevDayLabel = formatUtcDayMonth(solarNoonMs + (midnightTileK - 1) * 86400000);

      // Vertical marker under 0000
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.78)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(midnightX, dateY - 2);
      ctx.lineTo(midnightX, dateY + 11);
      ctx.stroke();

      // Previous day on the left of 0000, centered when 0000 is right of center
      const prevW = ctx.measureText(prevDayLabel).width;
      const prevCenterX = Math.min(centerX, midnightX - markerPad - prevW / 2);
      ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
      ctx.textAlign = 'center';
      ctx.fillText(prevDayLabel, prevCenterX, dateY);

      // Current day on the right of 0000, centered when 0000 is left of center
      const currW = ctx.measureText(currDayLabel).width;
      const currCenterX = Math.max(centerX, midnightX + markerPad + currW / 2);
      ctx.fillStyle = 'rgba(241, 245, 249, 0.92)';
      ctx.textAlign = 'center';
      ctx.fillText(currDayLabel, currCenterX, dateY);
    } else {
      const centerSolarMs = solarNoonMs + ((centerX - sunLocalX) / pxPerHour) * 3600000;
      const centerDayLabel = formatUtcDayMonth(centerSolarMs);
      ctx.fillStyle = 'rgba(241, 245, 249, 0.92)';
      ctx.textAlign = 'center';
      ctx.fillText(centerDayLabel, centerX, dateY);
    }

    // Hover cursor & exact local solar time readout
    if (this.solarDialHoverX !== null && this.solarDialHoverX >= 0 && this.solarDialHoverX <= cssW) {
      const hx = this.solarDialHoverX;
      ctx.strokeStyle = 'rgba(247, 184, 1, 0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, 0);
      ctx.lineTo(hx, cssH);
      ctx.stroke();

      const hoursOffset = (hx - sunLocalX) / pxPerHour;
      const totalMinutes = (((12 + hoursOffset) * 60) % 1440 + 1440) % 1440;
      const hh = Math.floor(totalMinutes / 60);
      const mm = Math.floor(totalMinutes % 60);
      const timeStr = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} SOLAR`;

      this.solarDialReadout.textContent = timeStr;
      this.solarDialReadout.style.left = `${Math.max(44, Math.min(cssW - 44, hx))}px`;
      this.solarDialReadout.classList.remove('hidden');
    }

    ctx.restore();
  }

  _drawDepthLegend() {
    const canvas = this.depthLegendCanvas;
    const ctx = this.depthLegendCtx;
    if (!canvas || !ctx) return;

    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width;
    const cssH = rect.height;
    if (cssW <= 0 || cssH <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.round(cssW * dpr);
    const targetH = Math.round(cssH * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const maxDepth = 700;
    const axisY = Math.round(cssH - 20);
    const labelY = axisY + 5;
    const barH = 7;
    const barY = axisY - barH - 2;

    const x70 = (70 / maxDepth) * cssW;
    const x300 = (300 / maxDepth) * cssW;

    // Horizontal depth color bar (Shallow <70, Mid 70-300, Deep >300 km)
    ctx.save();
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(0, barY, cssW, barH, 3);
    } else {
      ctx.rect(0, barY, cssW, barH);
    }
    ctx.clip();

    ctx.fillStyle = 'rgba(255, 107, 53, 0.92)';
    ctx.fillRect(0, barY, x70, barH);

    ctx.fillStyle = 'rgba(247, 184, 1, 0.92)';
    ctx.fillRect(x70, barY, x300 - x70, barH);

    ctx.fillStyle = 'rgba(56, 189, 248, 0.92)';
    ctx.fillRect(x300, barY, cssW - x300, barH);
    ctx.restore();

    // Horizontal axis line matching time and spectrum axes
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, axisY);
    ctx.lineTo(cssW, axisY);
    ctx.stroke();

    // Minor ticks (unlabeled)
    const minorDepths = [100, 200, 400, 500, 600];
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.lineWidth = 1;
    for (const d of minorDepths) {
      const x = (d / maxDepth) * cssW;
      ctx.beginPath();
      ctx.moveTo(x, axisY);
      ctx.lineTo(x, axisY + 3);
      ctx.stroke();
    }

    // Major ticks & labels matching time and spectrum axes
    const majorTicks = [
      { depth: 0, label: '0', align: 'left' },
      { depth: 70, label: '70', align: 'center' },
      { depth: 300, label: '300', align: 'center' },
      { depth: 700, label: '700 km', align: 'right' },
    ];

    ctx.textBaseline = 'top';
    ctx.font = '600 10px "JetBrains Mono", monospace';

    for (const tick of majorTicks) {
      const rawX = (tick.depth / maxDepth) * cssW;
      const tickX = Math.max(0.75, Math.min(cssW - 0.75, rawX));

      ctx.strokeStyle = 'rgba(226, 232, 240, 0.72)';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(tickX, axisY);
      ctx.lineTo(tickX, axisY + 4);
      ctx.stroke();

      ctx.fillStyle = 'rgba(241, 245, 249, 0.88)';
      ctx.textAlign = tick.align;
      const textX = tick.align === 'left' ? 0 : tick.align === 'right' ? cssW : tickX;
      ctx.fillText(tick.label, textX, labelY);
    }

    ctx.restore();
  }

  _updateEventCardWaves(now) {
    const waveStates = this.map.getActiveWaveStates(now);
    const merged = new Map();
    for (const s of waveStates) {
      const prev = merged.get(s.id);
      if (!prev || s.alpha > prev.alpha) {
        merged.set(s.id, s);
      }
    }

    const nextIds = new Set();
    for (const [id, s] of merged) {
      const card = this.eventCardById.get(id);
      if (!card) continue;
      nextIds.add(id);
      card.classList.add('rippling');
      card.style.setProperty('--wave-progress', s.progress.toFixed(4));
      card.style.setProperty('--wave-alpha', s.alpha.toFixed(4));
    }

    for (const id of this.ripplingCardIds) {
      if (nextIds.has(id)) continue;
      const card = this.eventCardById.get(id);
      if (!card) continue;
      card.classList.remove('rippling');
      card.style.removeProperty('--wave-progress');
      card.style.removeProperty('--wave-alpha');
    }

    this.ripplingCardIds = nextIds;

    // Sync active HUD cards (in hidden/idle mode) with wave/audio envelope.
    // Iterate bottom-up (oldest to newest) so newer cards never fade out before older ones below them.
    if (this.hudEventListEl) {
      const hudCards = Array.from(this.hudEventListEl.children);
      let hasOlderBelow = false;
      let maxOpacityBelow = 0;

      for (let i = hudCards.length - 1; i >= 0; i--) {
        const card = hudCards[i];
        const id = card.dataset.id;
        const entry = this.hudCardsById.get(id);
        if (!entry) {
          card.remove();
          continue;
        }

        const s = merged.get(id);
        let naturalOpacity = 0;
        if (s) {
          entry.hasRippled = true;
          entry.rippleEndedAt = null;
          card.classList.add('rippling');
          card.style.setProperty('--wave-progress', s.progress.toFixed(4));
          card.style.setProperty('--wave-alpha', s.alpha.toFixed(4));
          naturalOpacity = 1;
        } else if (!entry.hasRippled && now < entry.expiresAt) {
          naturalOpacity = 1;
        } else {
          card.classList.remove('rippling');
          card.style.removeProperty('--wave-progress');
          card.style.removeProperty('--wave-alpha');
          if (entry.hasRippled) {
            if (entry.rippleEndedAt === null) {
              entry.rippleEndedAt = now;
            }
            const lingerElapsed = now - entry.rippleEndedAt;
            if (lingerElapsed < HUD_CARD_LINGER_MS) {
              naturalOpacity = 1;
            } else {
              const fadeElapsed = lingerElapsed - HUD_CARD_LINGER_MS;
              naturalOpacity = Math.max(0, 1 - fadeElapsed / HUD_CARD_FADE_MS);
            }
          }
        }

        if (!hasOlderBelow && naturalOpacity <= 0) {
          card.remove();
          this.hudCardsById.delete(id);
        } else {
          const effectiveOpacity = Math.max(naturalOpacity, maxOpacityBelow);
          card.style.setProperty('--hud-opacity', effectiveOpacity.toFixed(4));
          maxOpacityBelow = effectiveOpacity;
          hasOlderBelow = true;
        }
      }
    }
  }

  _syncAudioUI(active) {
    document.body.classList.toggle('audio-active', Boolean(active));
    if (this.btnAudio) {
      this.btnAudio.classList.toggle('active', Boolean(active));
      this.btnAudio.title = active ? 'Mute Audio' : 'Start Audio';
      this.btnAudio.setAttribute('aria-label', active ? 'Mute Audio' : 'Start Audio');
    }
  }

  async ensureAudioStartedForRecording(channels, audioQuality) {
    if (audioQuality) {
      this.audio.setAudioQuality(audioQuality);
    }
    if (!this.audio.ctx || !this.audio.enabled) {
      await this.audio.init();
      this.audio.setVolume(Number(this.rangeVolume?.value ?? 80) / 100);
      this.audio.setTimbre(this.selectTimbre?.value || 'tectonic');
      this.audio.setScale(this.selectScale?.value || 'dorian');
      this.audio.setRootFreq(Number(this.rangeRootFreq?.value ?? 36.7));
      this.audio.setDrone(Boolean(this.toggleDrone?.checked));
      this._syncAudioUI(true);
    }
    if (channels != null) {
      this.audio.setRecordingChannelCount(channels);
    }
  }

  getStreamProgress() {
    if (!this.filteredQuakes.length) {
      return { percent: 0, currentIndex: 0, totalEvents: 0 };
    }
    const first = this.filteredQuakes[0].time - 1000;
    const last = this.filteredQuakes[this.filteredQuakes.length - 1].time + 60000;
    const span = Math.max(1, last - first);
    const pct = Math.max(0, Math.min(100, ((this.streamCursorTime - first) / span) * 100));
    return {
      percent: pct,
      currentIndex: this.streamIdx,
      totalEvents: this.filteredQuakes.length,
      cursorTime: this.streamCursorTime,
    };
  }

  setCleanUI(enabled) {
    this.cleanUI = Boolean(enabled);
    document.body.classList.toggle('asides-hidden', this.cleanUI);
    document.body.classList.toggle('recorder-clean-ui', this.cleanUI);
  }

  async applyRecorderSettings(settings = {}) {
    if (settings.feed && this.selectFeed) {
      this.feedKey = settings.feed;
      this.selectFeed.value = settings.feed;
      if (this.statDatasetValue && DATASET_WINDOW_LABELS[settings.feed]) {
        this.statDatasetValue.textContent = DATASET_WINDOW_LABELS[settings.feed];
      }
    }
    if (settings.geojsonUrl) {
      this.localGeoJsonUrl = settings.geojsonUrl;
      this.dateRange = null;
      if (this.statDatasetValue) this.statDatasetValue.textContent = 'Offline File';
    } else if (settings.startDate) {
      this.localGeoJsonUrl = null;
      this.dateRange = {
        startDate: settings.startDate,
        endDate: settings.endDate || settings.startDate,
      };
      if (this.statDatasetValue) {
        this.statDatasetValue.textContent =
          this.dateRange.startDate === this.dateRange.endDate
            ? this.dateRange.startDate
            : `${this.dateRange.startDate}..${this.dateRange.endDate}`;
      }
    } else if (settings.resetSource) {
      this.localGeoJsonUrl = null;
      this.dateRange = null;
    }

    if (typeof settings.minMag === 'number') {
      this.minMag = settings.minMag;
      if (this.rangeMinMag) this.rangeMinMag.value = String(this.minMag);
      if (this.valMinMag) this.valMinMag.textContent = `M${this.minMag.toFixed(1)}+`;
    }
    if (typeof settings.maxMag === 'number') {
      this.maxMag = settings.maxMag;
    }
    if (typeof settings.speed === 'number' && settings.speed > 0) {
      this.speedMultiplier = settings.speed;
      const idx = SPEED_OPTIONS.indexOf(settings.speed);
      if (idx >= 0 && this.rangeSpeed) {
        this.rangeSpeed.value = String(idx + 1);
      }
      if (this.valSpeed) {
        this.valSpeed.textContent = formatSpeedLabel(this.speedMultiplier);
      }
      this._preCenteredId = null;
    }
    if (settings.timbre && this.selectTimbre) {
      this.selectTimbre.value = settings.timbre;
      this.audio.setTimbre(settings.timbre);
    }
    if (settings.scale && this.selectScale) {
      this.selectScale.value = settings.scale;
      this.audio.setScale(settings.scale);
    }
    if (typeof settings.rootFreq === 'number' && this.rangeRootFreq) {
      this.rangeRootFreq.value = String(settings.rootFreq);
      this.audio.setRootFreq(settings.rootFreq);
      if (this.valRootFreq) {
        this.valRootFreq.textContent = `${settings.rootFreq.toFixed(1)} Hz (${freqToNote(settings.rootFreq)})`;
      }
    }
    if (typeof settings.volume === 'number' && this.rangeVolume) {
      this.rangeVolume.value = String(settings.volume);
      this.audio.setVolume(settings.volume / 100);
      if (this.valVolume) this.valVolume.textContent = `${Math.round(settings.volume)}%`;
    }
    if (typeof settings.channels === 'number' && !Number.isNaN(settings.channels)) {
      this.audio.setChannelCount(settings.channels);
      this.audio.setRecordingChannelCount(settings.channels);
      this._syncChannelLayoutUI();
    }
    if (settings.audioQuality) {
      this.audio.setAudioQuality(settings.audioQuality);
    }
    if (typeof settings.drone === 'boolean' && this.toggleDrone) {
      this.toggleDrone.checked = settings.drone;
      this.audio.setDrone(settings.drone);
    }
    if (typeof settings.plates === 'boolean' && this.togglePlates) {
      this.togglePlates.checked = settings.plates;
      this.map.setShowPlates(settings.plates);
    }
    if (typeof settings.cleanUI === 'boolean') {
      this.setCleanUI(settings.cleanUI);
    }

    if (settings.reloadFeed) {
      await this.loadFeed(true);
    } else {
      this._applyFilters(true);
    }
  }

  _applyUrlOverrides() {
    const params = new URLSearchParams(window.location.search);
    if (!params.toString()) return;

    const overrides = {};
    if (params.has('feed')) overrides.feed = params.get('feed');
    if (params.has('geojson')) overrides.geojsonUrl = params.get('geojson');
    if (params.has('date')) {
      overrides.startDate = params.get('date');
      overrides.endDate = params.get('date');
    }
    if (params.has('startDate')) overrides.startDate = params.get('startDate');
    if (params.has('endDate')) overrides.endDate = params.get('endDate');
    if (params.has('minMag')) overrides.minMag = Number(params.get('minMag'));
    if (params.has('maxMag')) overrides.maxMag = Number(params.get('maxMag'));
    if (params.has('speed')) overrides.speed = Number(params.get('speed'));
    if (params.has('timbre')) overrides.timbre = params.get('timbre');
    if (params.has('scale')) overrides.scale = params.get('scale');
    if (params.has('rootFreq')) overrides.rootFreq = Number(params.get('rootFreq'));
    if (params.has('volume')) overrides.volume = Number(params.get('volume'));
    if (params.has('channels')) overrides.channels = Number(params.get('channels'));
    if (params.has('audioQuality')) overrides.audioQuality = params.get('audioQuality');
    if (params.has('drone')) overrides.drone = params.get('drone') === '1' || params.get('drone') === 'true';
    if (params.has('plates')) overrides.plates = params.get('plates') === '1' || params.get('plates') === 'true';
    if (params.has('cleanUI')) {
      overrides.cleanUI = params.get('cleanUI') === '1' || params.get('cleanUI') === 'true';
      this._urlCleanUI = overrides.cleanUI;
    }

    this.applyRecorderSettings(overrides);
  }

  _exposeRecorderAPI() {
    window.__SEISMIC_RECORDER__ = {
      getState: () => ({
        isRecording: this.recorder.isRecording,
        eventCount: this.filteredQuakes.length,
        totalRawCount: this.allQuakes.length,
        speed: this.speedMultiplier,
        ...this.getStreamProgress(),
      }),
      applySettings: (s) => this.applyRecorderSettings(s),
      startRecording: (opts) => this.recorder.start(opts),
      stopRecording: () => this.recorder.stop(),
      prepareOfflineRender: async (opts = {}) => {
        if (this._rafId) {
          cancelAnimationFrame(this._rafId);
          this._rafId = null;
        }
        this.isPaused = true;
        this.audio.enabled = false;

        const width = Math.max(320, Math.round((Number(opts.width) || 1920) / 2) * 2);
        const height = Math.max(240, Math.round((Number(opts.height) || 1080) / 2) * 2);
        const fps = Math.max(1, Math.min(240, Number(opts.fps) || 30));

        if (!this._origPerfNow) {
          this._origPerfNow = performance.now.bind(performance);
        }
        this._offlineRender = {
          active: true,
          clockMs: 0,
          fps,
          width,
          height,
          frameIndex: 0,
          audioEvents: [],
          cycleComplete: false,
          droneEnabled: Boolean(opts.drone ?? this.droneEnabled),
          frameFormat: opts.frameFormat === 'png' ? 'png' : 'jpeg',
          specBinsL: new Float32Array(256),
          specBinsR: new Float32Array(256),
          specDroneBins: new Float32Array(256),
          specEventStartIdx: 0,
        };
        performance.now = () => (this._offlineRender ? this._offlineRender.clockMs : this._origPerfNow());

        this.mode = 'stream';
        this._resetStreamCursor();
        this.map.lastUserNavTime = 0;

        this.recorder.compositeCanvas = document.createElement('canvas');
        this.recorder.compositeCanvas.width = width;
        this.recorder.compositeCanvas.height = height;
        this.recorder.compositeCtx = this.recorder.compositeCanvas.getContext('2d', {
          alpha: false,
        });
        this.recorder.compositeCtx.imageSmoothingEnabled = true;
        this.recorder.compositeCtx.imageSmoothingQuality = 'high';

        return {
          width,
          height,
          fps,
          totalEvents: this.filteredQuakes.length,
        };
      },
      _renderOfflineFrame: async () => {
        const st = this._offlineRender;
        if (!st || !st.active) throw new Error('Offline render not prepared');

        const dtMs = 1000 / st.fps;
        if (st.frameIndex > 0) {
          st.clockMs += dtMs;
          this._stepStream(dtMs);
        }
        const now = st.clockMs;
        this.map.setAudioTimeMs(now);
        this.map.render(now);
        this._updateEventCardWaves(now);
        this._drawAudioSpectrum(dtMs);
        this._drawSolarDial();
        this.recorder._drawCompositeFrame();

        const mime = st.frameFormat === 'png' ? 'image/png' : 'image/jpeg';
        let frameBlob = await Promise.race([
          new Promise((resolve) => {
            if (mime === 'image/png') {
              this.recorder.compositeCanvas.toBlob(resolve, 'image/png');
            } else {
              this.recorder.compositeCanvas.toBlob(resolve, 'image/jpeg', 0.94);
            }
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('toBlob timed out after 30s')), 30000)),
        ]);
        if (!frameBlob) throw new Error('Failed to encode composite frame');
        const frameBuf = await frameBlob.arrayBuffer();
        frameBlob = null;
        const frameIdx = st.frameIndex;
        st.frameIndex += 1;
        return { frameIdx, frameBuf, now };
      },
      _postOfflineFrame: async (frameEndpoint, frameIdx, frameBuf) => {
        let res = null;
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const contentType = this._offlineRender?.frameFormat === 'png' ? 'image/png' : 'image/jpeg';
            res = await fetch(frameEndpoint, {
              method: 'POST',
              headers: {
                'Content-Type': contentType,
                'X-Frame-Index': String(frameIdx),
                'X-Chunk-Final': '1',
              },
              body: frameBuf,
              signal: AbortSignal.timeout(120000),
            });
            if (res.ok) {
              await res.arrayBuffer();
              break;
            }
            await res.body?.cancel().catch(() => {});
            lastErr = new Error(`Frame upload failed: HTTP ${res.status}`);
          } catch (err) {
            lastErr = err;
            if (attempt < 2) await new Promise((r) => setTimeout(r, 50));
          }
        }
        if (!res || !res.ok) throw lastErr || new Error('Frame upload failed');
      },
      stepAndPostFrame: async (frameEndpoint = '/__recorder_frame') => {
        const st = this._offlineRender;
        const api = window.__SEISMIC_RECORDER__;
        const { frameIdx, frameBuf, now } = await api._renderOfflineFrame();
        await api._postOfflineFrame(frameEndpoint, frameIdx, frameBuf);
        const progress = this.getStreamProgress();
        return {
          done: st.cycleComplete,
          frameIndex: st.frameIndex,
          clockMs: now,
          ...progress,
        };
      },
      stepAndPostFrames: async (count = 30, frameEndpoint = '/__recorder_frame') => {
        const st = this._offlineRender;
        const api = window.__SEISMIC_RECORDER__;
        const n = Math.max(1, Number(count) || 1);
        let pendingPost = null;
        let lastClockMs = st ? st.clockMs : 0;

        for (let i = 0; i < n; i++) {
          const { frameIdx, frameBuf, now } = await api._renderOfflineFrame();
          lastClockMs = now;
          if (pendingPost) await pendingPost;
          pendingPost = api._postOfflineFrame(frameEndpoint, frameIdx, frameBuf);
          if (st.cycleComplete) break;
        }
        if (pendingPost) await pendingPost;

        const progress = this.getStreamProgress();
        return {
          done: st.cycleComplete,
          frameIndex: st.frameIndex,
          clockMs: lastClockMs,
          ...progress,
        };
      },
      renderOfflineAudioAndUpload: async (opts = {}, audioEndpoint = '/__recorder_audio') => {
        const st = this._offlineRender;
        if (!st) throw new Error('Offline render not prepared');
        const durationSec = Math.max(0.5, st.clockMs / 1000 + 1.5);
        const channels = Number(opts.channels ?? this.audio.recordingChannelCount ?? this.audio.channelCount ?? 2);
        const audioQuality = opts.audioQuality || this.audio.audioQuality || 'high';

        const rendered = await SeismicAudioEngine.renderOffline({
          events: st.audioEvents,
          durationSec,
          channels,
          audioQuality,
          droneEnabled: Boolean(opts.drone ?? this.droneEnabled),
          volume: this.audio.volume,
          timbre: this.audio.timbre,
          scale: this.audio.scale,
          rootFreq: this.audio.rootFreq,
        });
        const wavBlob = encodeWavBlob(
          rendered.chunks,
          rendered.sampleRate,
          rendered.channels,
          rendered.bitDepth
        );

        const CHUNK_SIZE = 32 * 1024 * 1024;
        const totalBytes = wavBlob.size;
        for (let offset = 0, chunkIdx = 0; offset < totalBytes; offset += CHUNK_SIZE, chunkIdx += 1) {
          const end = Math.min(totalBytes, offset + CHUNK_SIZE);
          const slice = wavBlob.slice(offset, end);
          const isFinal = end >= totalBytes;
          const res = await fetch(audioEndpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'audio/wav',
              'X-Audio-Channels': String(rendered.channels),
              'X-Audio-Sample-Rate': String(rendered.sampleRate),
              'X-Audio-Bit-Depth': String(rendered.bitDepth),
              'X-Audio-Duration': String(rendered.durationSec),
              'X-Chunk-Index': String(chunkIdx),
              'X-Chunk-Final': isFinal ? '1' : '0',
            },
            body: slice,
          });
          if (!res.ok) throw new Error(`Audio upload failed: HTTP ${res.status}`);
          await res.arrayBuffer();
        }

        st.active = false;
        this._offlineRender = null;
        if (this._origPerfNow) {
          performance.now = this._origPerfNow;
        }
        return {
          ok: true,
          sizeBytes: wavBlob.size,
          channels: rendered.channels,
          sampleRate: rendered.sampleRate,
          bitDepth: rendered.bitDepth,
          durationSec: rendered.durationSec,
        };
      },
      startAndUpload: async (opts, uploadEndpoint = '/__recorder_upload') => {
        return new Promise((resolve, reject) => {
          this.recorder.onError = (err) => reject(err);
          this.recorder.onComplete = async (blob, meta) => {
            try {
              const res = await fetch(uploadEndpoint, {
                method: 'POST',
                headers: {
                  'Content-Type': meta.mimeType || 'video/webm',
                  'X-Recorder-Filename': meta.filename || 'recording.webm',
                  'X-Recorder-Events': String(this.filteredQuakes.length),
                },
                body: blob,
              });
              if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`);
              resolve({ ok: true, sizeBytes: blob.size, mimeType: meta.mimeType, meta });
            } catch (err) {
              reject(err);
            }
          };
          this.recorder.start({ ...opts, autoDownload: false }).catch(reject);
        });
      },
    };
  }

  _bindRecorderModal() {
    const btnOpen = document.getElementById('btn-recorder-open');
    const backdrop = document.getElementById('recorder-modal-backdrop');
    const btnClose = document.getElementById('btn-recorder-close');
    const btnStart = document.getElementById('btn-rec-start');
    const btnStop = document.getElementById('btn-rec-stop');
    const btnDownload = document.getElementById('btn-rec-download');
    const sourceSelect = document.getElementById('rec-source');
    const dateRow = document.getElementById('rec-date-row');
    const rangeRow = document.getElementById('rec-range-row');
    const geojsonRow = document.getElementById('rec-geojson-row');
    const geojsonInput = document.getElementById('rec-geojson-file');
    const resSelect = document.getElementById('rec-resolution');
    const customResRow = document.getElementById('rec-custom-res-row');
    const widthInput = document.getElementById('rec-width');
    const heightInput = document.getElementById('rec-height');
    const fpsSelect = document.getElementById('rec-fps');
    const offlineNotice = document.getElementById('rec-offline-notice');
    const statusText = document.getElementById('rec-status-text');
    const progressBar = document.getElementById('rec-progress-bar');
    const channelsSelect = document.getElementById('rec-channels');
    const audioQualitySelect = document.getElementById('rec-audio-quality');
    const multichannelNote = document.getElementById('rec-multichannel-note');
    const filenameInput = document.getElementById('rec-filename');
    const recToast = document.getElementById('rec-toast');
    const recToastText = document.getElementById('rec-toast-text');
    const recToastClose = document.getElementById('rec-toast-close');
    let toastTimer = null;

    const showRecToast = (msg) => {
      if (!recToast || !recToastText) return;
      recToastText.textContent = msg;
      recToast.classList.remove('hidden');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => recToast.classList.add('hidden'), 12000);
    };
    recToastClose?.addEventListener('click', () => recToast?.classList.add('hidden'));

    const syncMultichannelNote = () => {
      if (!multichannelNote) return;
      const ch = Number(channelsSelect?.value || 2);
      const aq = audioQualitySelect?.value || 'high';
      if (ch > 2) {
        multichannelNote.innerHTML = 'Browser video capture only encodes 2.0 (Stereo) Opus. A separate discrete multichannel <strong>.wav</strong> audio file will also be downloaded.';
        multichannelNote.classList.remove('hidden');
      } else if (aq === 'ultra') {
        multichannelNote.innerHTML = 'Ultra Hi-Fi mode will also download a lossless <strong>32-bit float .wav</strong> master audio file.';
        multichannelNote.classList.remove('hidden');
      } else {
        multichannelNote.classList.add('hidden');
      }
    };
    channelsSelect?.addEventListener('change', syncMultichannelNote);
    audioQualitySelect?.addEventListener('change', syncMultichannelNote);

    if (!btnOpen || !backdrop) return;

    const now = new Date();
    const todayStr = formatLocalDateInput(now);
    const yesterdayStr = formatLocalDateInput(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
    const singleDateEl = document.getElementById('rec-date');
    const startDateEl = document.getElementById('rec-start-date');
    const endDateEl = document.getElementById('rec-end-date');
    if (singleDateEl && !singleDateEl.value) singleDateEl.value = yesterdayStr;
    if (startDateEl && !startDateEl.value) startDateEl.value = yesterdayStr;
    if (endDateEl && !endDateEl.value) endDateEl.value = todayStr;

    const syncSourceRows = () => {
      const mode = sourceSelect?.value || 'current';
      if (dateRow) dateRow.classList.toggle('hidden', mode !== 'day');
      if (rangeRow) rangeRow.classList.toggle('hidden', mode !== 'range');
      if (geojsonRow) geojsonRow.classList.toggle('hidden', mode !== 'geojson');
    };
    sourceSelect?.addEventListener('change', syncSourceRows);
    syncSourceRows();

    const isAboveBrowserLimits = () => {
      const resKey = resSelect?.value || '1080p';
      let width = 1920;
      let height = 1080;
      if (resKey === 'custom') {
        width = Number(widthInput?.value) || 1920;
        height = Number(heightInput?.value) || 1080;
      } else if (RESOLUTION_PRESETS[resKey]) {
        width = RESOLUTION_PRESETS[resKey].width;
        height = RESOLUTION_PRESETS[resKey].height;
      }
      const fps = Number(fpsSelect?.value ?? 30);
      const hdrMode = document.getElementById('rec-hdr')?.value || 'off';
      const resExceeded = width > 1920 || height > 1080;
      const fpsExceeded = fps > 60;
      const hdrExceeded = hdrMode !== 'off';
      return {
        exceeded: resExceeded || fpsExceeded || hdrExceeded,
        resExceeded,
        fpsExceeded,
        hdrExceeded,
        width,
        height,
        fps,
      };
    };

    const syncBrowserLimitNotice = () => {
      if (!offlineNotice) return;
      const { exceeded } = isAboveBrowserLimits();
      offlineNotice.classList.toggle('hidden', !exceeded);
    };

    const hdrSelect = document.getElementById('rec-hdr');
    resSelect?.addEventListener('change', () => {
      if (customResRow) customResRow.classList.toggle('hidden', resSelect.value !== 'custom');
      syncBrowserLimitNotice();
    });
    fpsSelect?.addEventListener('change', syncBrowserLimitNotice);
    hdrSelect?.addEventListener('change', syncBrowserLimitNotice);
    widthInput?.addEventListener('input', syncBrowserLimitNotice);
    heightInput?.addEventListener('input', syncBrowserLimitNotice);
    syncBrowserLimitNotice();

    const btnCopyCmd = document.getElementById('btn-rec-copy-cmd');
    const btnExportCfg = document.getElementById('btn-rec-export-cfg');

    const buildOfflinePythonConfig = () => {
      const srcMode = sourceSelect?.value || 'current';
      const minMag = Number(document.getElementById('rec-min-mag')?.value ?? 0);
      const maxMag = Number(document.getElementById('rec-max-mag')?.value ?? 10);
      const speed = Number(document.getElementById('rec-speed')?.value ?? 480);
      const timbre = document.getElementById('rec-timbre')?.value || this.selectTimbre?.value || 'tectonic';
      const scale = document.getElementById('rec-scale')?.value || this.selectScale?.value || 'dorian';
      const rootFreq = Number(document.getElementById('rec-root-freq')?.value ?? this.audio.rootFreq ?? 36.7);
      const channels = Number(document.getElementById('rec-channels')?.value ?? this.audio.channelCount ?? 2);
      const drone = Boolean(document.getElementById('rec-drone')?.checked);
      const plates = Boolean(document.getElementById('rec-plates')?.checked);
      const cleanUI = Boolean(document.getElementById('rec-clean-ui')?.checked);
      const quality = document.getElementById('rec-quality')?.value || 'medium';
      const hdr = document.getElementById('rec-hdr')?.value || 'off';
      const audioQuality = document.getElementById('rec-audio-quality')?.value || 'standard';

      const resolution = resSelect?.value || '1080p';
      let width = 1920;
      let height = 1080;
      const fps = Number(fpsSelect?.value ?? 30);

      if (resolution === 'custom') {
        width = Number(widthInput?.value) || 1920;
        height = Number(heightInput?.value) || 1080;
      } else if (RESOLUTION_PRESETS[resolution]) {
        width = RESOLUTION_PRESETS[resolution].width;
        height = RESOLUTION_PRESETS[resolution].height;
      }

      const cfg = {
        date: srcMode === 'day' ? singleDateEl?.value || 'yesterday' : 'yesterday',
        start_date: srcMode === 'range' ? startDateEl?.value || null : null,
        end_date: srcMode === 'range' ? endDateEl?.value || null : null,
        feed: null,
        geojson: null,
        offline: false,
        min_mag: minMag,
        max_mag: maxMag,
        speed,
        timbre,
        scale,
        root_freq: rootFreq,
        volume: Math.round((this.audio?.volume ?? 0.8) * 100),
        channels,
        drone,
        plates,
        clean_ui: cleanUI,
        resolution,
        width,
        height,
        fps,
        quality,
        hdr,
        audio_quality: audioQuality,
        format: 'mkv',
        output_dir: 'videos',
        filename_template: 'seismic_{date}_{speed}x_{res}.{ext}',
        max_duration: 3600,
        headful: false,
      };
      if (srcMode === 'range' && cfg.start_date && cfg.end_date) {
        cfg.date = null;
      } else if (srcMode === 'current' && this.dateRange?.start && this.dateRange?.end) {
        cfg.date = null;
        cfg.start_date = this.dateRange.start;
        cfg.end_date = this.dateRange.end;
      }
      return cfg;
    };

    const buildOfflinePythonCmd = (cfg) => {
      const parts = ['python', 'recorder/record.py'];
      if (cfg.start_date && cfg.end_date) {
        parts.push('--start-date', cfg.start_date, '--end-date', cfg.end_date);
      } else if (cfg.date) {
        parts.push('--date', cfg.date);
      }
      parts.push(
        '--min-mag', String(cfg.min_mag),
        '--max-mag', String(cfg.max_mag),
        '--speed', String(cfg.speed),
        '--timbre', cfg.timbre,
        '--scale', cfg.scale,
        '--root-freq', String(cfg.root_freq),
        '--channels', String(cfg.channels)
      );
      if (cfg.resolution === 'custom') {
        parts.push('--width', String(cfg.width), '--height', String(cfg.height));
      } else {
        parts.push('--resolution', cfg.resolution);
      }
      parts.push(
        '--fps', String(cfg.fps),
        '--quality', cfg.quality,
        '--audio-quality', cfg.audio_quality,
        '--format', cfg.format,
        '--output-dir', cfg.output_dir
      );
      if (cfg.hdr && cfg.hdr !== 'off') parts.push('--hdr', cfg.hdr);
      if (cfg.drone) parts.push('--drone');
      if (!cfg.plates) parts.push('--no-plates');
      if (!cfg.clean_ui) parts.push('--no-clean-ui');
      return parts.join(' ');
    };

    btnCopyCmd?.addEventListener('click', async () => {
      const cmd = buildOfflinePythonCmd(buildOfflinePythonConfig());
      try {
        await navigator.clipboard.writeText(cmd);
        showRecToast(`Copied offline Python command:\n${cmd}`);
      } catch {
        showRecToast(`Run in terminal:\n${cmd}`);
      }
    });

    btnExportCfg?.addEventListener('click', () => {
      const cfg = buildOfflinePythonConfig();
      const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
      triggerBlobDownload(blob, 'seismic_config.json');
      showRecToast('Exported seismic_config.json — run: python recorder/record.py --config seismic_config.json');
    });

    let lastRecording = null;
    let lastStartCapped = false;
    let preRecordCleanUI = this.cleanUI;

    const restoreCleanUI = () => {
      if (this.cleanUI !== preRecordCleanUI && !this._urlCleanUI) {
        this.setCleanUI(preRecordCleanUI);
        this._resetIdleTimer?.();
      }
    };

    const triggerBlobDownload = (blob, filename) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    };

    const openModal = () => {
      this.isRecorderOpen = true;
      const recChannelsEl = document.getElementById('rec-channels');
      if (recChannelsEl && this.audio && !this.recorder.isRecording) {
        recChannelsEl.value = String(this.audio.recordingChannelCount ?? this.audio.channelCount ?? 2);
      }
      syncMultichannelNote();
      syncBrowserLimitNotice();
      btnStart?.classList.toggle('hidden', this.recorder.isRecording);
      btnStop?.classList.toggle('hidden', !this.recorder.isRecording);
      btnDownload?.classList.toggle('hidden', this.recorder.isRecording || !lastRecording);
      backdrop.classList.remove('hidden');
      this._resetIdleTimer?.();
    };
    const closeModal = () => {
      this.isRecorderOpen = false;
      backdrop.classList.add('hidden');
      if (!this.recorder.isRecording && this.cleanUI && !this._urlCleanUI) {
        this.setCleanUI(false);
      }
      this._resetIdleTimer?.();
      btnOpen.focus();
    };

    btnOpen.addEventListener('click', openModal);
    btnClose?.addEventListener('click', closeModal);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModal();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !backdrop.classList.contains('hidden')) {
        closeModal();
      }
    });

    filenameInput?.addEventListener('keydown', (e) => {
      if (
        e.key === 'Tab' &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        !filenameInput.value &&
        filenameInput.placeholder
      ) {
        e.preventDefault();
        filenameInput.value = filenameInput.placeholder;
      }
    });

    let uploadedGeoJsonData = null;
    geojsonInput?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        uploadedGeoJsonData = JSON.parse(text);
        if (statusText) statusText.textContent = `Loaded ${file.name}`;
      } catch (err) {
        if (statusText) statusText.textContent = `Invalid GeoJSON: ${err.message}`;
      }
    });

    this.recorder.onProgress = ({ percent, currentIndex, totalEvents, elapsedMs }) => {
      if (progressBar) progressBar.style.width = `${percent.toFixed(1)}%`;
      const secs = Math.floor(elapsedMs / 1000);
      if (statusText) {
        statusText.textContent = `Recording… ${percent.toFixed(1)}% (${currentIndex}/${totalEvents} events · ${secs}s)`;
      }
    };

    this.recorder.onComplete = (blob, meta) => {
      restoreCleanUI();
      btnStart?.classList.remove('hidden');
      btnStop?.classList.add('hidden');
      btnOpen.classList.remove('recording');
      btnOpen.title = 'Offline Stream Recorder';
      if (blob && blob.size > 0) {
        const ext = (meta.mimeType || '').includes('mp4') ? '.mp4' : '.webm';
        const safeVideoName = (meta.filename || 'recording.webm').replace(/\.(mp4|webm)$/i, '') + ext;
        lastRecording = {
          blob,
          filename: safeVideoName,
          wavBlob: meta.wavBlob || null,
          wavFilename: meta.wavFilename || null,
        };
        btnDownload?.classList.remove('hidden');
      }
      if (progressBar) progressBar.style.width = '100%';
      const mb = (blob.size / (1024 * 1024)).toFixed(2);
      let msg = `Saved ${meta.filename} (${mb} MB)`;
      if (meta.wavFilename && meta.wavSizeBytes > 0) {
        const wavMb = (meta.wavSizeBytes / (1024 * 1024)).toFixed(2);
        const khz = meta.wavSampleRate ? ` @ ${(meta.wavSampleRate / 1000).toFixed(meta.wavSampleRate % 1000 === 0 ? 0 : 1)}kHz` : '';
        const bits = meta.wavBitDepth ? `${meta.wavBitDepth}-bit` : 'PCM';
        msg += ` + additional ${meta.wavChannels}ch ${bits}${khz} audio: ${meta.wavFilename} (${wavMb} MB)`;
      }
      if (lastStartCapped) {
        msg += ' — Capped at max browser settings (1080p / 60 FPS); use Python (recorder/record.py) for true capture.';
      }
      if (statusText) {
        statusText.textContent = msg;
      }
      showRecToast(msg);
    };

    this.recorder.onError = (err) => {
      restoreCleanUI();
      btnStart?.classList.remove('hidden');
      btnStop?.classList.add('hidden');
      btnOpen.classList.remove('recording');
      btnOpen.title = 'Offline Stream Recorder';
      if (statusText) statusText.textContent = `Error: ${err.message}`;
    };

    btnStart?.addEventListener('click', async () => {
      try {
        btnStart.disabled = true;
        if (statusText) statusText.textContent = 'Preparing stream & audio…';

        const srcMode = sourceSelect?.value || 'current';
        const minMag = Number(document.getElementById('rec-min-mag')?.value ?? 0);
        const maxMag = Number(document.getElementById('rec-max-mag')?.value ?? 10);
        const speed = Number(document.getElementById('rec-speed')?.value ?? 480);
        const timbre = document.getElementById('rec-timbre')?.value || this.selectTimbre?.value;
        const scale = document.getElementById('rec-scale')?.value || this.selectScale?.value;
        const rootFreq = Number(document.getElementById('rec-root-freq')?.value ?? this.audio.rootFreq);
        const channels = Number(document.getElementById('rec-channels')?.value ?? this.audio.channelCount ?? 2);
        const drone = Boolean(document.getElementById('rec-drone')?.checked);
        const plates = Boolean(document.getElementById('rec-plates')?.checked);
        const cleanUI = Boolean(document.getElementById('rec-clean-ui')?.checked);
        const captureMode = document.getElementById('rec-capture-mode')?.value || 'canvas';
        const limits = isAboveBrowserLimits();
        const fps = Math.min(60, Math.max(15, limits.fps));
        const quality = document.getElementById('rec-quality')?.value || 'medium';
        const audioQuality = document.getElementById('rec-audio-quality')?.value || 'standard';
        const filename = document.getElementById('rec-filename')?.value?.trim() || undefined;

        const width = Math.min(1920, Math.max(320, limits.width));
        const height = Math.min(1080, Math.max(240, limits.height));
        lastStartCapped = limits.exceeded;
        if (limits.exceeded) {
          showRecToast('Browser output is limited to 1080p / 60 FPS — recording with max browser settings. Use Python (recorder/record.py) for true capture.');
        }

        const settings = {
          minMag,
          maxMag,
          speed,
          timbre,
          scale,
          rootFreq,
          channels,
          audioQuality,
          drone,
          plates,
          cleanUI,
          reloadFeed: false,
        };

        if (srcMode === 'day') {
          settings.startDate = singleDateEl?.value || yesterdayStr;
          settings.endDate = settings.startDate;
          settings.reloadFeed = true;
        } else if (srcMode === 'range') {
          settings.startDate = startDateEl?.value || yesterdayStr;
          settings.endDate = endDateEl?.value || todayStr;
          settings.reloadFeed = true;
        } else if (srcMode === 'geojson' && uploadedGeoJsonData) {
          const parsed = parseGeoJsonPayload(uploadedGeoJsonData);
          this.allQuakes = parsed.events;
          this.localGeoJsonUrl = null;
          this.dateRange = null;
        } else {
          settings.resetSource = true;
          settings.reloadFeed = false;
        }

        preRecordCleanUI = this.cleanUI;
        await this.applyRecorderSettings(settings);

        lastRecording = null;
        btnDownload?.classList.add('hidden');
        btnStart.classList.add('hidden');
        btnStop?.classList.remove('hidden');
        btnOpen.classList.add('recording');
        btnOpen.title = 'Recording in progress — Click to open Recorder / Stop & Save';
        if (progressBar) progressBar.style.width = '0%';

        await this.recorder.start({
          width,
          height,
          fps,
          quality,
          audioQuality,
          channels,
          captureMode,
          filename,
          autoDownload: true,
          stopOnCycleEnd: true,
        });
      } catch (err) {
        console.error(err);
        restoreCleanUI();
        btnStart.classList.remove('hidden');
        btnStop?.classList.add('hidden');
        btnOpen.classList.remove('recording');
        btnOpen.title = 'Offline Stream Recorder';
        if (statusText) statusText.textContent = `Error: ${err.message}`;
      } finally {
        btnStart.disabled = false;
      }
    });

    btnStop?.addEventListener('click', async () => {
      btnStop.disabled = true;
      await this.recorder.stop();
      btnStop.disabled = false;
    });

    btnDownload?.addEventListener('click', () => {
      if (!lastRecording) return;
      if (lastRecording.blob && lastRecording.blob.size > 0) {
        triggerBlobDownload(lastRecording.blob, lastRecording.filename);
      }
      if (lastRecording.wavBlob && lastRecording.wavBlob.size > 0 && lastRecording.wavFilename) {
        setTimeout(() => triggerBlobDownload(lastRecording.wavBlob, lastRecording.wavFilename), 250);
      }
    });
  }

  _loop(now) {
    if (this.isPaused || this._offlineRender?.active) return;

    const dt = Math.min(100, now - this.lastFrameTime);
    this.lastFrameTime = now;

    this._stepStream(dt);
    this.map.setAudioTimeMs(this.audio.getAudioTimeMs());
    this.map.render(now);
    this._updateEventCardWaves(now);
    this.audio.updatePanning((lon, lat) => this.map.getSolarSpatialPan(lon, lat));
    this._drawAudioSpectrum(dt);
    this._drawSolarDial();

    this._rafId = requestAnimationFrame((t) => this._loop(t));
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new App();
});
