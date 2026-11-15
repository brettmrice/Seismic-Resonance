import { SeismicAudioEngine } from './audio.js';
import { fetchEarthquakes } from './usgs.js';
import { SeismicMap } from './map.js';

const SPEED_OPTIONS = [60, 180, 360, 900];
const POLL_INTERVAL_MS = 30000;
const ASIDE_IDLE_MS = 5000;
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

    // Stream replay state
    this.streamCursorTime = 0;
    this.streamIdx = 0;
    this.lastTriggeredId = null;
    this.eventCardById = new Map();
    this.ripplingCardIds = new Set();
    this.hudCardsById = new Map();
    this.lastFrameTime = performance.now();
    this.isPaused = false;
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
    this._initIdleAsides();
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
    this.mapTzPill = document.getElementById('map-tz-pill');
    this.mapLocalDatetimeEl = document.getElementById('map-local-datetime');
    this.bottomBarEl = document.querySelector('.bottom-bar');
    this.bottomBarLeftEl = document.querySelector('.bottom-bar-left');
    this.bottomBarRightEl = document.querySelector('.bottom-bar-right');
    this._lastMapTzX = null;
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
    this.togglePlates = document.getElementById('toggle-plates');
    this.btnTriggerLatest = document.getElementById('btn-trigger-latest');
    this.btnResetZoom = document.getElementById('btn-reset-zoom');

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
  }

  _bindControls() {
    this.btnAudio.addEventListener('click', async () => {
      if (!this.audio.ctx || !this.audio.enabled) {
        await this.audio.init();
        this.audio.setEnabled(true);
        document.body.classList.add('audio-active');
        this.btnAudio.classList.add('active');
        this.btnAudio.title = 'Mute Audio';
        this.btnAudio.setAttribute('aria-label', 'Mute Audio');
        this.liveIndicator.classList.add('live');

        // Immediately audition the most recent quake on activation
        if (this.filteredQuakes.length > 0) {
          this.triggerEvent(this.filteredQuakes[this.filteredQuakes.length - 1]);
        }
      } else {
        this.audio.setEnabled(false);
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
      this.map.resetView();
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
      if (e.key === 'Escape' && this.isPaused) {
        this.closeReadmeModal();
      }
    });
  }

  /**
   * Slides the left and right aside panels out after ASIDE_IDLE_MS of no mouse
   * interactions, and slides them back in as soon as the mouse interacts.
   */
  _initIdleAsides() {
    this._idleTimer = null;
    const resetIdleTimer = () => {
      document.body.classList.remove('asides-hidden');
      if (this._idleTimer !== null) {
        clearTimeout(this._idleTimer);
      }
      this._idleTimer = setTimeout(() => {
        if (!this.isPaused) {
          document.body.classList.add('asides-hidden');
        }
      }, ASIDE_IDLE_MS);
    };

    const mouseEvents = ['mousemove', 'mousedown', 'mouseup', 'wheel', 'click', 'pointermove', 'pointerdown'];
    for (const evt of mouseEvents) {
      window.addEventListener(evt, resetIdleTimer, { passive: true });
    }

    resetIdleTimer();
  }

  async openReadmeModal() {
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

    if (this.readmeBackdrop) {
      this.readmeBackdrop.classList.remove('hidden');
    }
    this.btnReadme?.setAttribute('aria-expanded', 'true');
    this.btnReadmeClose?.focus();
  }

  async closeReadmeModal() {
    if (!this.isPaused) return;
    this.isPaused = false;

    if (this.readmeBackdrop) {
      this.readmeBackdrop.classList.add('hidden');
    }
    this.btnReadme?.setAttribute('aria-expanded', 'false');

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
    this.btnReadme?.focus();
  }

  async _start() {
    await this.map.loadGeoData();
    await this.loadFeed(true);
    setInterval(() => {
      if (!this.isPaused) {
        this.loadFeed(false);
      }
    }, POLL_INTERVAL_MS);
    this._rafId = requestAnimationFrame((t) => this._loop(t));
  }

  async loadFeed(isInitial = false) {
    try {
      this.statFeedStatus.textContent = 'Syncing…';
      const { events } = await fetchEarthquakes(this.feedKey);
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
      this.statFeedStatus.textContent = 'USGS Live';

      // Trigger real-time incoming earthquakes
      if (!isInitial && newlyArrived.length > 0) {
        newlyArrived
          .filter((q) => q.mag >= this.minMag)
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
    this.filteredQuakes = this.allQuakes.filter((q) => q.mag >= this.minMag);
    this.map.setQuakes(this.filteredQuakes);

    this.statEventCount.textContent = String(this.filteredQuakes.length);

    this._renderEventList();
    if (resetStream) {
      this._resetStreamCursor();
    }
  }

  _resetStreamCursor() {
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
    let sinSum = 0;
    let cosSum = 0;
    for (const q of windowQuakes) {
      const rad = (q.lon || 0) * DEG2RAD;
      sinSum += Math.sin(rad);
      cosSum += Math.cos(rad);
    }
    const avgLon = Math.atan2(sinSum, cosSum) / DEG2RAD;
    this.map.setAutoCenterLon(avgLon, durationMs);
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

    const pan = this.map.getStereoPan(quake.lon, quake.lat);
    const voice = this.audio.triggerQuake(quake, pan);
    this.map.spawnWave(quake, voice);
    this._pushHudEventCard(quake, voice);

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
    if (this.mapLocalDatetimeEl) this.mapLocalDatetimeEl.textContent = formatted;
  }

  _updateMapTzPill() {
    if (!this.mapTzPill || !this.map || this.map.width <= 0) return;

    const ts = Number.isFinite(this.map.solarTimeMs) ? this.map.solarTimeMs : Date.now();
    const tzLon = (-new Date(ts).getTimezoneOffset() / 60) * 15;
    const [baseX] = this.map.project(tzLon, 0);
    const worldW = this.map.bounds.w * this.map.zoom;

    let targetX = baseX;
    if (worldW > 0) {
      const halfW = this.map.width / 2;
      const k = Math.round((halfW - baseX) / worldW);
      targetX = baseX + k * worldW;
    }

    const leftRect = this.bottomBarLeftEl?.getBoundingClientRect();
    const rightRect = this.bottomBarRightEl?.getBoundingClientRect();
    const barRect = this.bottomBarEl?.getBoundingClientRect();

    let minBound = 14;
    let maxBound = window.innerWidth - 14;
    if (leftRect && rightRect && leftRect.width > 0 && rightRect.width > 0) {
      minBound = leftRect.left;
      maxBound = rightRect.right;
    } else if (barRect && barRect.width > 0) {
      minBound = barRect.left;
      maxBound = barRect.right;
    }

    const halfPill = (this.mapTzPill.offsetWidth || 0) / 2;
    const minX = minBound + halfPill;
    const maxX = Math.max(minX, maxBound - halfPill);
    const clampedX = Math.max(minX, Math.min(maxX, targetX));

    if (this._lastMapTzX === null || Math.abs(clampedX - this._lastMapTzX) > 0.25) {
      this._lastMapTzX = clampedX;
      this.mapTzPill.style.left = `${clampedX.toFixed(1)}px`;
    }
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

    // Glide continuously between events toward the next event over the exact inter-event delay
    if (this.streamIdx < this.filteredQuakes.length) {
      const nextQuake = this.filteredQuakes[this.streamIdx];
      if (this._preCenteredId !== nextQuake.id && this.map.canAutoTransition()) {
        this._preCenteredId = nextQuake.id;
        const delayMs = Math.max(80, (nextQuake.time - this.streamCursorTime) / this.speedMultiplier);
        this._updateAutoCenterForQuake(nextQuake, delayMs);
      }
    }

    if (this.streamCursorTime > lastTime + 60000) {
      this._preCenteredId = null;
      this._resetStreamCursor();
    }

    this.map.setSolarTime(this.streamCursorTime);
    this._setDatetimeDisplay(this.streamCursorTime);
  }

  _drawAudioSpectrum(dtMs = 16) {
    const colorBlend = 1 - Math.exp(-dtMs * 0.008);
    for (let i = 0; i < 3; i++) {
      this.spectrumColorL[i] += (this.spectrumTargetL[i] - this.spectrumColorL[i]) * colorBlend;
      this.spectrumColorR[i] += (this.spectrumTargetR[i] - this.spectrumColorR[i]) * colorBlend;
    }

    const enabled = Boolean(this.audio.analyserLeft && this.audio.analyserRight && this.audio.enabled);
    const droneAnalyser = enabled ? this.audio.droneAnalyser : null;

    this._drawSpectrumChannel(
      this.audioCanvasLeft,
      this.audioCtxLeft,
      -1,
      enabled ? this.audio.analyserLeft : null,
      droneAnalyser,
      this.spectrumColorL,
    );
    this._drawSpectrumChannel(
      this.audioCanvasRight,
      this.audioCtxRight,
      1,
      enabled ? this.audio.analyserRight : null,
      droneAnalyser,
      this.spectrumColorR,
    );
  }

  _drawSpectrumChannel(canvas, ctx, dir, analyser, droneAnalyser, rgb) {
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

    if (analyser) {
      const sampleRate = this.audio.ctx.sampleRate;
      const spanW = Math.ceil(cssW);

      const fillSpectrumArea = (sourceAnalyser, fillStyle) => {
        const freqData = new Uint8Array(sourceAnalyser.frequencyBinCount);
        sourceAnalyser.getByteFrequencyData(freqData);
        const binHz = sampleRate / sourceAnalyser.fftSize;
        const maxBin = freqData.length - 1;

        ctx.fillStyle = fillStyle;
        ctx.beginPath();
        ctx.moveTo(lowEdgeX, axisY);
        for (let offset = 0; offset <= spanW; offset += 1) {
          const t = Math.min(1, offset / cssW);
          const freq = minFreq * Math.pow(maxFreq / minFreq, t);
          const binFloat = freq / binHz;
          const b0 = Math.min(maxBin, Math.floor(binFloat));
          const b1 = Math.min(maxBin, b0 + 1);
          const frac = binFloat - b0;
          const v = (freqData[b0] * (1 - frac) + freqData[b1] * frac) / 255;

          const barH = v * (specH - 2);
          const x = dir < 0 ? cssW - offset : offset;
          ctx.lineTo(x, axisY - barH);
        }
        ctx.lineTo(dir < 0 ? cssW - spanW : spanW, axisY);
        ctx.closePath();
        ctx.fill();
      };

      // Draw Earth Drone spectrum behind the event spectrum in translucent blue
      if (droneAnalyser) {
        fillSpectrumArea(droneAnalyser, 'rgba(56, 189, 248, 0.28)');
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
      fillSpectrumArea(analyser, grad);

      const timeData = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(timeData);
      let droneTimeData = null;
      if (droneAnalyser) {
        droneTimeData = new Uint8Array(droneAnalyser.fftSize);
        droneAnalyser.getByteTimeDomainData(droneTimeData);
      }
      const midY = specTop + specH / 2;
      const width = Math.floor(cssW);
      const step = Math.max(1, Math.floor(timeData.length / Math.max(1, width)));
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.65)';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
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

  _loop(now) {
    if (this.isPaused) return;

    const dt = Math.min(100, now - this.lastFrameTime);
    this.lastFrameTime = now;

    this._stepStream(dt);
    this.map.setAudioTimeMs(this.audio.getAudioTimeMs());
    this.map.render(now);
    this._updateEventCardWaves(now);
    this.audio.updatePanning((lon, lat) => this.map.getStereoPan(lon, lat));
    this._drawAudioSpectrum(dt);
    this._drawSolarDial();
    this._updateMapTzPill();

    this._rafId = requestAnimationFrame((t) => this._loop(t));
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new App();
});
