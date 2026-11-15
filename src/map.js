// High-DPI Canvas World Map, Pan/Zoom, Solar Daylight/Summer Column & Seismic Wave Visualizer

const DEG2RAD = Math.PI / 180;

export function getDepthColor(depth, alpha = 1) {
  if (depth < 70) return `rgba(255, 107, 53, ${alpha})`;   // Shallow: Magma Coral
  if (depth < 300) return `rgba(247, 184, 1, ${alpha})`;   // Mid: Amber Gold
  return `rgba(56, 189, 248, ${alpha})`;                    // Deep: Abyssal Cyan
}

/**
 * Computes true subsolar longitude & latitude (solar declination) in degrees from UTC time,
 * accounting for Earth's 23.439° axial tilt and the Equation of Time.
 */
export function getSubsolarPoint(date = new Date()) {
  // Days since J2000.0 (2000-01-01 12:00:00 UTC)
  const j2000Ms = Date.UTC(2000, 0, 1, 12, 0, 0);
  const d = (date.getTime() - j2000Ms) / 86400000;

  // Mean anomaly & mean longitude of the Sun (degrees)
  const g = (357.529 + 0.98560028 * d) * DEG2RAD;
  const q = 280.459 + 0.98564736 * d;

  // Ecliptic longitude of the Sun (degrees)
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG2RAD;

  // Obliquity of the ecliptic (Earth's axial tilt, ~23.439°)
  const eps = (23.439 - 0.00000036 * d) * DEG2RAD;

  // Solar declination (subsolar latitude)
  const lat = Math.asin(Math.sin(eps) * Math.sin(L)) / DEG2RAD;

  // Right ascension (RA) in degrees for Equation of Time
  const ra = Math.atan2(Math.cos(eps) * Math.sin(L), Math.cos(L)) / DEG2RAD;
  let eotDeg = ((q % 360) + 360) % 360 - ((ra % 360) + 360) % 360;
  if (eotDeg > 180) eotDeg -= 360;
  if (eotDeg < -180) eotDeg += 360;

  const utcHours =
    date.getUTCHours() +
    date.getUTCMinutes() / 60 +
    date.getUTCSeconds() / 3600 +
    date.getUTCMilliseconds() / 3600000;

  // True subsolar longitude incorporating Equation of Time
  let lon = (12 - utcHours) * 15 - eotDeg;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;

  return { lon, lat };
}

export class SeismicMap {
  constructor(canvas, onHover, onClickQuake, onShiftClickMap, onZoomChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onHover = onHover;
    this.onClickQuake = onClickQuake;
    this.onShiftClickMap = onShiftClickMap;
    this.onZoomChange = onZoomChange;

    this.landFeatures = [];
    this.plateFeatures = [];
    this.showPlates = true;

    this.quakes = [];
    this.activeWaves = []; // Expanding P-wave / S-wave rings
    this.audioTimeMs = null;
    this.hoveredQuake = null;
    this.selectedQuakeId = null;

    this.width = 0;
    this.height = 0;
    this.dpr = window.devicePixelRatio || 1;
    this.bounds = { x: 0, y: 0, w: 0, h: 0 };

    // Pan & Zoom state
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.isDragging = false;
    this.dragMoved = false;
    this.lastMouseX = 0;
    this.lastMouseY = 0;
    this.lastUserNavTime = performance.now();
    this.autoCenterLon = null;
    this._autoTransitionActive = false;
    this._transStartTime = 0;
    this._transDuration = 300;
    this._transStartZoom = 1;
    this._transStartPanX = 0;
    this._transStartPanY = 0;
    this._transDeltaPanX = 0;

    // Offscreen solar illumination buffer (1° resolution)
    this._solarCanvas = document.createElement('canvas');
    this._solarCanvas.width = 360;
    this._solarCanvas.height = 180;
    this._solarCtx = this._solarCanvas.getContext('2d');
    this.solarTimeMs = Date.now();
    this._lastSolarModelTime = 0;

    this._bindEvents();
    this.resize();
  }

  async loadGeoData() {
    try {
      const [landRes, platesRes] = await Promise.all([
        fetch('data/land-110m.geojson'),
        fetch('data/tectonic-plates.geojson'),
      ]);
      if (landRes.ok) {
        const landJson = await landRes.json();
        this.landFeatures = landJson.features || [];
      }
      if (platesRes.ok) {
        const platesJson = await platesRes.json();
        this.plateFeatures = platesJson.features || [];
      }
    } catch (err) {
      console.warn('Could not load local GeoJSON layers:', err);
    }
  }

  setShowPlates(flag) {
    this.showPlates = flag;
  }

  setQuakes(quakes) {
    this.quakes = quakes;
  }

  setSelectedQuake(id) {
    this.selectedQuakeId = id;
  }

  canAutoTransition(now = performance.now()) {
    return !this.isDragging && now - this.lastUserNavTime >= 5000 && this.bounds.w > 0;
  }

  setAutoCenterLon(lon, durationMs = 600) {
    if (!Number.isFinite(lon)) return;
    this.autoCenterLon = lon;
    const now = performance.now();
    if (this.canAutoTransition(now)) {
      this._transStartTime = now;
      this._transDuration = Math.max(80, durationMs);
      this._transStartZoom = this.zoom;
      this._transStartPanX = this.panX;
      this._transStartPanY = this.panY;

      // Target panX at zoom = 1.0x centered on lon
      const baseW = this.bounds.w;
      let targetPanX = -(lon / 360) * baseW;
      targetPanX = ((((targetPanX + baseW / 2) % baseW) + baseW) % baseW) - baseW / 2;

      let dx = targetPanX - this.panX;
      dx = ((((dx + baseW / 2) % baseW) + baseW) % baseW) - baseW / 2;
      this._transDeltaPanX = dx;
      this._autoTransitionActive = true;
    }
  }

  resetView() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.lastUserNavTime = performance.now();
    this._autoTransitionActive = false;
    this.onZoomChange?.(this.zoom);
  }

  setAudioTimeMs(ms) {
    this.audioTimeMs = Number.isFinite(ms) ? ms : null;
  }

  _getWaveElapsed(w, now) {
    if (w.startAudioTimeMs !== null && this.audioTimeMs !== null) {
      return this.audioTimeMs - (w.startAudioTimeMs + w.latencyMs);
    }
    return now - w.bornAt;
  }

  spawnWave(quake, voice = null) {
    const mag = Math.max(0.5, quake.mag ?? 1.5);
    const maxRadius = 22 + Math.pow(mag, 1.85) * 7.5;
    const seed = Math.random() * Math.PI * 2;
    const latencyMs = voice?.latencyMs ?? 0;
    this.activeWaves.push({
      id: quake.id,
      lon: quake.lon,
      lat: quake.lat,
      depth: quake.depth ?? 10,
      mag,
      maxRadius,
      bornAt: performance.now() + latencyMs,
      duration: voice?.durationMs ?? (2400 + mag * 520),
      attackMs: voice?.attackMs ?? 80,
      sDelayMs: voice?.sDelayMs ?? 0,
      timbre: voice?.timbre ?? 'tectonic',
      freq: voice?.freq ?? 36.7,
      startAudioTimeMs: voice?.startAudioTimeMs ?? null,
      latencyMs,
      phaseA: seed,
      phaseB: seed * 1.7 + 1.1,
      phaseC: seed * 2.3 + 2.4,
      wobbleAmp: 0.032 + Math.random() * 0.024,
    });
  }

  /** Shift internal animation timestamps forward so waves pause cleanly. */
  shiftTimers(deltaMs) {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
    this.lastUserNavTime += deltaMs;
    for (const w of this.activeWaves) {
      w.bornAt += deltaMs;
    }
  }

  getActiveWaveStates(now = performance.now()) {
    const states = [];
    for (const w of this.activeWaves) {
      if (!w.id) continue;
      const elapsed = this._getWaveElapsed(w, now);
      if (elapsed < 0 || elapsed >= w.duration) continue;

      const t = Math.min(1, elapsed / w.duration);
      const attackFrac = Math.max(0.015, Math.min(0.45, (w.attackMs || 80) / w.duration));
      const riseTime = Math.max(0.05, attackFrac * 0.85);
      const rise = Math.min(1, t / riseTime);
      const alpha = rise * Math.pow(1 - t, 2.15);
      states.push({ id: w.id, progress: t, alpha });
    }
    return states;
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);

    // Fill full viewport height while preserving 2:1 equirectangular aspect ratio
    // (horizontal tiling in render() fills any remaining width)
    const mapH = this.height;
    const mapW = mapH * 2;
    this.bounds = {
      x: (this.width - mapW) / 2,
      y: 0,
      w: mapW,
      h: mapH,
    };
    this._clampPan();
  }

  _clampPan() {
    const worldW = this.bounds.w * this.zoom;
    if (worldW > 0) {
      // Wrap panX continuously modulo worldW so horizontal panning is infinite
      this.panX = ((((this.panX + worldW / 2) % worldW) + worldW) % worldW) - worldW / 2;
    }

    if (this.zoom <= 1) {
      this.panY = 0;
      return;
    }
    const maxPanY = (this.bounds.h * (this.zoom - 1)) / 2 + 80;
    this.panY = Math.max(-maxPanY, Math.min(maxPanY, this.panY));
  }

  project(lon, lat) {
    const bx = this.bounds.x + ((lon + 180) / 360) * this.bounds.w;
    const by = this.bounds.y + ((90 - lat) / 180) * this.bounds.h;
    const cx = this.width / 2;
    const cy = this.height / 2;
    const x = (bx - cx) * this.zoom + cx + this.panX;
    const y = (by - cy) * this.zoom + cy + this.panY;
    return [x, y];
  }

  unproject(px, py) {
    const cx = this.width / 2;
    const cy = this.height / 2;
    const bx = (px - cx - this.panX) / this.zoom + cx;
    const by = (py - cy - this.panY) / this.zoom + cy;
    let lon = ((bx - this.bounds.x) / this.bounds.w) * 360 - 180;
    // Wrap longitude into [-180, 180] across repeated world tiles
    lon = ((((lon + 180) % 360) + 360) % 360) - 180;
    const lat = 90 - ((by - this.bounds.y) / this.bounds.h) * 180;
    return [
      lon,
      Math.max(-85, Math.min(85, lat)),
    ];
  }

  _getVisibleTileRange() {
    const worldW = this.bounds.w * this.zoom;
    if (worldW <= 0) return [0, 0];
    const [xLeft0] = this.project(-180, 0);
    const kMin = Math.floor(-xLeft0 / worldW);
    const kMax = Math.floor((this.width - xLeft0) / worldW);
    return [kMin, kMax];
  }

  /**
   * Computes stereo pan (-0.85..+0.85) for a geographic coordinate relative to
   * the viewer window's horizontal center, using the nearest wrapped world tile.
   */
  getStereoPan(lon, lat = 0) {
    if (this.width <= 0) {
      return Math.max(-0.85, Math.min(0.85, (lon || 0) / 180));
    }
    const halfW = this.width / 2;
    const [baseX] = this.project(lon || 0, lat || 0);
    const worldW = this.bounds.w * this.zoom;

    let nearestX = baseX;
    if (worldW > 0) {
      const k = Math.round((halfW - baseX) / worldW);
      nearestX = baseX + k * worldW;
    }

    const normX = Math.max(-1, Math.min(1, (nearestX - halfW) / halfW));
    return normX * 0.85;
  }

  _bindEvents() {
    window.addEventListener('resize', () => this.resize());

    // Wheel zoom centered on cursor
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.lastUserNavTime = performance.now();
      this._autoTransitionActive = false;
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      const newZoom = Math.max(1, Math.min(12, this.zoom * factor));
      if (newZoom === this.zoom) return;

      const cx = this.width / 2;
      const cy = this.height / 2;
      const scaleRatio = newZoom / this.zoom;

      // Keep point under cursor stationary
      this.panX = mx - cx - (mx - cx - this.panX) * scaleRatio;
      this.panY = my - cy - (my - cy - this.panY) * scaleRatio;
      this.zoom = newZoom;
      this._clampPan();
      this.onZoomChange?.(this.zoom);
    }, { passive: false });

    // Drag to pan
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this.isDragging = true;
      this.dragMoved = false;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDragging) {
        const dx = e.clientX - this.lastMouseX;
        const dy = e.clientY - this.lastMouseY;
        if (Math.hypot(dx, dy) > 3) {
          this.dragMoved = true;
          this.lastUserNavTime = performance.now();
          this._autoTransitionActive = false;
        }
        this.panX += dx;
        this.panY += dy;
        this._clampPan();
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
        this.canvas.style.cursor = 'grabbing';
        this.onHover?.(null, 0, 0);
        return;
      }
    });

    window.addEventListener('mouseup', () => {
      if (this.isDragging) {
        this.isDragging = false;
        this.canvas.style.cursor = this.hoveredQuake ? 'pointer' : 'grab';
      }
    });

    this.canvas.addEventListener('mousemove', (e) => {
      if (this.isDragging) return;
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      let closest = null;
      let bestDist = 14;
      const worldW = this.bounds.w * this.zoom;
      const [kMin, kMax] = this._getVisibleTileRange();
      for (let i = this.quakes.length - 1; i >= 0; i--) {
        const q = this.quakes[i];
        const [qxBase, qy] = this.project(q.lon, q.lat);
        for (let k = kMin; k <= kMax; k++) {
          const d = Math.hypot(mx - (qxBase + k * worldW), my - qy);
          if (d < bestDist) {
            bestDist = d;
            closest = q;
          }
        }
      }

      this.hoveredQuake = closest;
      this.canvas.style.cursor = closest ? 'pointer' : 'grab';
      this.onHover?.(closest, e.clientX, e.clientY);
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.hoveredQuake = null;
      this.onHover?.(null, 0, 0);
    });

    this.canvas.addEventListener('click', (e) => {
      if (this.dragMoved) {
        this.dragMoved = false;
        return;
      }
      if (e.shiftKey) {
        const rect = this.canvas.getBoundingClientRect();
        const [lon, lat] = this.unproject(e.clientX - rect.left, e.clientY - rect.top);
        this.onShiftClickMap?.(lon, lat);
        return;
      }
      if (this.hoveredQuake) {
        this.onClickQuake?.(this.hoveredQuake);
      }
    });
  }

  setSolarTime(ms) {
    if (Number.isFinite(ms)) {
      this.solarTimeMs = ms;
    }
  }

  /**
   * Returns screen-space metrics for aligning external UI (e.g. the solar dial)
   * with the Sun's current longitude and the map's pan/zoom state.
   */
  getSolarDialMetrics() {
    const { lon: sunLon } = getSubsolarPoint(new Date(this.solarTimeMs));
    const [sunScreenX] = this.project(sunLon, 0);
    return {
      sunScreenX,
      worldW: this.bounds.w * this.zoom,
      sunLon,
    };
  }

  _updateSolarTexture() {
    if (
      this._lastSolarModelTime !== 0 &&
      Math.abs(this.solarTimeMs - this._lastSolarModelTime) < 60000
    ) {
      return;
    }
    this._lastSolarModelTime = this.solarTimeMs;

    const { lon: sunLon, lat: sunLat } = getSubsolarPoint(new Date(this.solarTimeMs));
    const sunLatRad = sunLat * DEG2RAD;
    const sinDecl = Math.sin(sunLatRad);
    const cosDecl = Math.cos(sunLatRad);

    const w = this._solarCanvas.width;
    const h = this._solarCanvas.height;
    const img = this._solarCtx.createImageData(w, h);
    const data = img.data;

    for (let py = 0; py < h; py++) {
      const lat = 90 - ((py + 0.5) / h) * 180;
      const latRad = lat * DEG2RAD;
      const sinLat = Math.sin(latRad);
      const cosLat = Math.cos(latRad);

      for (let px = 0; px < w; px++) {
        const lon = ((px + 0.5) / w) * 360 - 180;
        const dLon = (lon - sunLon) * DEG2RAD;

        // Exact spherical Earth curvature & axial tilt solar zenith cosine:
        // cos(theta_z) = sin(lat)*sin(decl) + cos(lat)*cos(decl)*cos(lon - sunLon)
        const cosZ = sinLat * sinDecl + cosLat * cosDecl * Math.cos(dLon);

        // Atmospheric twilight dispersion (-10.5 deg solar elevation ~ cosZ = -0.18)
        // smoothly transitioning to direct Lambertian irradiance (cosZ > 0)
        const idx = (py * w + px) * 4;
        if (cosZ <= -0.18) {
          data[idx + 3] = 0;
          continue;
        }

        let intensity;
        let warmth;
        if (cosZ < 0) {
          // Civil/nautical twilight band along the curved terminator
          const tw = (cosZ + 0.18) / 0.18;
          intensity = Math.pow(tw, 2.0) * 0.22;
          warmth = 0;
        } else {
          // True radial solar irradiance on curved Earth (cosZ in 0..1)
          intensity = 0.22 + 0.78 * Math.pow(cosZ, 0.68);
          warmth = Math.pow(cosZ, 0.85);
        }

        // Golden-amber twilight near terminator -> bright warm-white sunlight near subsolar point
        data[idx] = 255;
        data[idx + 1] = Math.round(175 + 72 * warmth);
        data[idx + 2] = Math.round(75 + 135 * warmth);
        data[idx + 3] = Math.round(intensity * 78);
      }
    }

    this._solarCtx.putImageData(img, 0, 0);
  }

  _updateAutoCamera(now) {
    if (!this._autoTransitionActive || this.isDragging) return;
    if (now - this.lastUserNavTime < 5000) {
      this._autoTransitionActive = false;
      return;
    }

    const rawT = Math.min(1, Math.max(0, (now - this._transStartTime) / this._transDuration));
    // Smooth cubic ease-in-out respective to transition time
    const easeT =
      rawT < 0.5
        ? 4 * rawT * rawT * rawT
        : 1 - Math.pow(-2 * rawT + 2, 3) / 2;

    const prevZoom = this.zoom;
    this.zoom = this._transStartZoom + (1 - this._transStartZoom) * easeT;
    this.panY = this._transStartPanY * (1 - easeT);
    this.panX = this._transStartPanX + this._transDeltaPanX * easeT;

    if (Math.abs(this.zoom - prevZoom) > 0.001 || rawT >= 1) {
      this.onZoomChange?.(this.zoom);
    }

    this._clampPan();
    if (rawT >= 1) {
      this.zoom = 1;
      this.panY = 0;
      this._clampPan();
      this.onZoomChange?.(1);
      this._autoTransitionActive = false;
    }
  }

  render(now) {
    this._updateAutoCamera(now);
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    // Background radial obsidian glow
    const bgGrad = ctx.createRadialGradient(
      this.width * 0.5, this.height * 0.5, 40,
      this.width * 0.5, this.height * 0.5, Math.max(this.width, this.height) * 0.75
    );
    bgGrad.addColorStop(0, '#0b121e');
    bgGrad.addColorStop(1, '#04070c');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, this.width, this.height);

    // Prune expired waves & refresh solar texture once per frame before drawing tiled copies
    this.activeWaves = this.activeWaves.filter((w) => this._getWaveElapsed(w, now) < w.duration);
    this._updateSolarTexture();

    const worldW = this.bounds.w * this.zoom;
    const [kMin, kMax] = this._getVisibleTileRange();

    for (let k = kMin; k <= kMax; k++) {
      ctx.save();
      ctx.translate(k * worldW, 0);
      this._drawGraticule(ctx);
      this._drawLand(ctx);
      this._drawSolarColumn(ctx);
      if (this.showPlates) {
        this._drawPlates(ctx);
      }
      this._drawQuakes(ctx);
      this._drawWaves(ctx, now);
      ctx.restore();
    }

    ctx.restore();
  }

  _drawSolarColumn(ctx) {
    const [x1, y1] = this.project(-180, 90);
    const [x2, y2] = this.project(180, -90);

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this._solarCanvas, x1, y1, x2 - x1, y2 - y1);

    // Subtle subsolar point & summer hemisphere indicator
    const { lon: sunLon, lat: sunLat } = getSubsolarPoint(new Date(this.solarTimeMs));
    const [sx, sy] = this.project(sunLon, sunLat);

    const sunGlow = ctx.createRadialGradient(sx, sy, 2, sx, sy, 42 * Math.min(2, this.zoom));
    sunGlow.addColorStop(0, 'rgba(255, 232, 160, 0.55)');
    sunGlow.addColorStop(0.35, 'rgba(255, 195, 85, 0.18)');
    sunGlow.addColorStop(1, 'rgba(255, 180, 60, 0)');
    ctx.fillStyle = sunGlow;
    ctx.beginPath();
    ctx.arc(sx, sy, 42 * Math.min(2, this.zoom), 0, Math.PI * 2);
    ctx.fill();

    // Small crisp sun reticle
    ctx.strokeStyle = 'rgba(255, 224, 130, 0.65)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 224, 130, 0.72)';
    ctx.font = '600 9px "JetBrains Mono", monospace';
    const hemi = sunLat >= 0 ? 'N. SUMMER' : 'S. SUMMER';
    ctx.fillText(`☀ ${hemi}`, sx + 9, sy + 3);

    ctx.restore();
  }

  _drawGraticule(ctx) {
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.06)';
    ctx.lineWidth = 1;

    for (let lon = -180; lon <= 180; lon += 30) {
      const [x, y1] = this.project(lon, 90);
      const [, y2] = this.project(lon, -90);
      ctx.beginPath();
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
      ctx.stroke();
    }

    for (let lat = -60; lat <= 60; lat += 30) {
      const [x1, y] = this.project(-180, lat);
      const [x2] = this.project(180, lat);
      ctx.beginPath();
      ctx.strokeStyle = lat === 0 ? 'rgba(148, 163, 184, 0.13)' : 'rgba(148, 163, 184, 0.06)';
      ctx.moveTo(x1, y);
      ctx.lineTo(x2, y);
      ctx.stroke();
    }
  }

  _drawLand(ctx) {
    if (!this.landFeatures.length) return;
    ctx.fillStyle = '#0f1724';
    ctx.strokeStyle = '#1e2d42';
    ctx.lineWidth = 1;

    for (const feature of this.landFeatures) {
      const geom = feature.geometry;
      if (!geom) continue;
      const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
      for (const poly of polys) {
        ctx.beginPath();
        for (const ring of poly) {
          for (let i = 0; i < ring.length; i++) {
            const [x, y] = this.project(ring[i][0], ring[i][1]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.closePath();
        }
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  _drawPlates(ctx) {
    if (!this.plateFeatures.length) return;
    ctx.strokeStyle = 'rgba(255, 107, 53, 0.24)';
    ctx.lineWidth = 1.1;

    for (const feature of this.plateFeatures) {
      const geom = feature.geometry;
      if (!geom) continue;
      const lines = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;
      for (const line of lines) {
        ctx.beginPath();
        let prevLon = null;
        for (let i = 0; i < line.length; i++) {
          const [lon, lat] = line[i];
          const [x, y] = this.project(lon, lat);
          if (i === 0 || (prevLon !== null && Math.abs(lon - prevLon) > 180)) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
          prevLon = lon;
        }
        ctx.stroke();
      }
    }
  }

  _drawQuakes(ctx) {
    for (const q of this.quakes) {
      const [x, y] = this.project(q.lon, q.lat);
      const mag = Math.max(0.4, q.mag ?? 1);
      const r = 2.0 + Math.pow(mag, 1.35) * 1.15;
      const isSelected = q.id === this.selectedQuakeId || q === this.hoveredQuake;

      ctx.beginPath();
      ctx.arc(x, y, isSelected ? r + 2.5 : r, 0, Math.PI * 2);
      ctx.fillStyle = getDepthColor(q.depth ?? 10, isSelected ? 0.95 : 0.55);
      ctx.fill();

      if (isSelected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  _traceOrganicRipplePath(ctx, cx, cy, radius, rt, w, ringIndex) {
    const segments = Math.max(40, Math.min(84, Math.round(radius * 1.15)));
    const phaseA = w.phaseA ?? 0;
    const phaseB = w.phaseB ?? 1.1;
    const phaseC = w.phaseC ?? 2.4;
    const wobbleAmp = w.wobbleAmp ?? 0.038;
    const freqScale = Math.max(0.65, Math.min(2.2, (w.freq || 36.7) / 36.7));
    const drift = rt * (2.0 + freqScale * 1.0) + ringIndex * 0.95;
    const radialSpread = 0.35 + 0.65 * rt;

    ctx.beginPath();
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const harmonic =
        Math.sin(theta * 3 + phaseA + drift) * 0.52 +
        Math.sin(theta * 5 - phaseB - drift * 0.72) * 0.3 +
        Math.cos(theta * 2 + phaseC + drift * 0.41) * 0.18;
      const r = Math.max(0.5, radius * (1 + harmonic * wobbleAmp * radialSpread));
      const px = cx + Math.cos(theta) * r;
      const py = cy + Math.sin(theta) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  _drawWaves(ctx, now) {
    if (!this.activeWaves.length) return;

    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    for (const w of this.activeWaves) {
      const elapsed = this._getWaveElapsed(w, now);
      if (elapsed < 0 || elapsed >= w.duration) continue;

      const t = Math.min(1, elapsed / w.duration);
      const [x, y] = this.project(w.lon, w.lat);
      const sDelayFrac = Math.min(0.35, (w.sDelayMs || 0) / w.duration);
      const attackFrac = Math.max(0.015, Math.min(0.45, (w.attackMs || 80) / w.duration));

      // Soft water-drop source meniscus & bloom at impact (synced to P-wave onset / attack)
      const bloomWindow = Math.max(0.35, attackFrac + 0.25);
      if (t < bloomWindow) {
        const dropT = t / bloomWindow;
        const dropRise = w.timbre === 'abyssal'
          ? Math.min(1, t / Math.max(0.05, attackFrac))
          : 1;
        const dropAlpha = dropRise * Math.pow(1 - dropT, 2);
        const dropRadius = 5 + w.mag * 1.8 + Math.sin(dropT * Math.PI) * 3.5;
        const grad = ctx.createRadialGradient(x, y, 0.5, x, y, dropRadius);
        grad.addColorStop(0, `rgba(240, 250, 255, ${dropAlpha * 0.78})`);
        grad.addColorStop(0.45, getDepthColor(w.depth, dropAlpha * 0.45));
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.beginPath();
        ctx.arc(x, y, dropRadius, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }

      // Concentric water-source ripple train (leading crest launches on S-wave onset)
      const ringCount = w.mag >= 3.5 ? 4 : 3;
      for (let i = 0; i < ringCount; i++) {
        const delay = sDelayFrac + i * 0.11;
        if (t <= delay || delay >= 1) continue;

        const rt = Math.min(1, (t - delay) / (1 - delay));
        // Decelerating radial expansion (r ~ t^0.58) like a surface water wave
        const ease = Math.pow(rt, 0.58);
        const ringMax = w.maxRadius * (1 - i * 0.15);
        const radius = Math.max(1.5, 2.5 + ease * ringMax);

        // Envelope matched to voice attack & exponential audio decay
        const riseTime = Math.max(0.05, attackFrac * 0.85);
        const rise = Math.min(1, rt / riseTime);
        const envelope = rise * Math.pow(1 - rt, 2.15);
        const weight = 1 - i * 0.22;
        const alpha = envelope * weight;
        if (alpha <= 0.008) continue;

        this._traceOrganicRipplePath(ctx, x, y, radius, rt, w, i);

        // Soft translucent wake around the crest
        ctx.strokeStyle = getDepthColor(w.depth, alpha * 0.24);
        ctx.lineWidth = (3.4 + w.mag * 0.55) * (1 - rt * 0.45) * weight;
        ctx.stroke();

        // Primary depth-tinted liquid crest
        ctx.strokeStyle = getDepthColor(w.depth, alpha * 0.72);
        ctx.lineWidth = (1.25 + w.mag * 0.2) * (1 - rt * 0.35);
        ctx.stroke();

        // Delicate specular water-surface highlight on leading crests
        if (i < 2) {
          ctx.strokeStyle = `rgba(232, 248, 255, ${alpha * (i === 0 ? 0.45 : 0.24)})`;
          ctx.lineWidth = 0.75;
          ctx.stroke();
        }
      }
    }

    ctx.restore();
  }
}
