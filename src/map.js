// High-DPI Canvas Dual 2D/3D Map & Orthographic Globe with Organic Wrap/Unfold Transition

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

function normalizeLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
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
    this.cx = 0;
    this.cy = 0;
    this.baseRadius = 200;
    this.bounds = { x: 0, y: 0, w: 0, h: 0 };

    // Map projection mode ('2d' | '3d') & organic wrap/unfold morph state
    this.mapMode = '3d';
    this.morphT = 1; // 0 = 2D flat map, 1 = 3D globe
    this._morphActive = false;
    this._morphStartT = 1;
    this._morphTargetT = 1;
    this._morphStartTime = 0;
    this._morphDuration = 900;

    // 2D Pan & Zoom state
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;

    // 3D Globe Rotation state
    this.rotLon = 0;
    this.rotLat = 0;

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
    this._transStartLon = 0;
    this._transStartLat = 0;
    this._transDeltaLon = 0;
    this._transDeltaLat = 0;

    // Offscreen 2D equirectangular solar illumination buffer (1° resolution)
    this._solar2DCanvas = document.createElement('canvas');
    this._solar2DCanvas.width = 360;
    this._solar2DCanvas.height = 180;
    this._solar2DCtx = this._solar2DCanvas.getContext('2d');
    this._lastSolar2DTime = 0;

    // Offscreen 3D solar illumination sphere buffer
    this._solar3DCanvas = document.createElement('canvas');
    this._solar3DCanvas.width = 180;
    this._solar3DCanvas.height = 180;
    this._solar3DCtx = this._solar3DCanvas.getContext('2d');
    this._lastSolar3DKey = '';

    this.solarTimeMs = Date.now();

    this._bindEvents();
    this.resize();
  }

  get radius() {
    return this.baseRadius * this.zoom;
  }

  setMapMode(mode, { animate = true } = {}) {
    const nextMode = mode === '2d' ? '2d' : '3d';
    if (nextMode === this.mapMode && !this._morphActive && animate) return;

    const prevMode = this.mapMode;
    this.mapMode = nextMode;
    this._autoTransitionActive = false;

    // Preserve center longitude & zoom across the 2D <-> 3D transition
    if (nextMode === '3d' && prevMode === '2d') {
      const [centerLon, centerLat] = this._unproject2D(this.cx, this.cy);
      this.rotLon = centerLon;
      this.rotLat = Math.max(-85, Math.min(85, centerLat));
      this.zoom = Math.max(1, Math.min(10, this.zoom));
      this.onZoomChange?.(this.zoom);
    } else if (nextMode === '2d' && prevMode === '3d') {
      const worldW = this.bounds.w * this.zoom;
      if (worldW > 0) {
        this.panX = -(this.rotLon / 360) * worldW;
        this.panY = (this.rotLat / 180) * (this.bounds.h * this.zoom);
        this._clampPan();
      }
    }

    const targetT = nextMode === '3d' ? 1 : 0;
    if (!animate) {
      this.morphT = targetT;
      this._morphActive = false;
      return;
    }

    this._morphStartT = this.morphT;
    this._morphTargetT = targetT;
    this._morphStartTime = performance.now();
    this._morphDuration = 900;
    this._morphActive = true;
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
    return !this.isDragging && !this._morphActive && now - this.lastUserNavTime >= 5000 && this.baseRadius > 0;
  }

  setAutoCenterLon(lon, durationMs = 600, lat = null) {
    if (!Number.isFinite(lon)) return;
    this.autoCenterLon = lon;
    const targetLat = Number.isFinite(lat) ? Math.max(-85, Math.min(85, lat)) : 0;
    const now = performance.now();
    if (this.canAutoTransition(now)) {
      this._transStartTime = now;
      this._transDuration = Math.max(80, durationMs);
      this._transStartZoom = this.zoom;

      if (this.mapMode === '3d') {
        this._transStartLon = this.rotLon;
        this._transStartLat = this.rotLat;
        this._transDeltaLon = normalizeLon(lon - this.rotLon);
        this._transDeltaLat = targetLat - this.rotLat;
      } else {
        this._transStartPanX = this.panX;
        this._transStartPanY = this.panY;
        const baseW = this.bounds.w;
        let targetPanX = -(lon / 360) * baseW;
        targetPanX = ((((targetPanX + baseW / 2) % baseW) + baseW) % baseW) - baseW / 2;
        let dx = targetPanX - this.panX;
        dx = ((((dx + baseW / 2) % baseW) + baseW) % baseW) - baseW / 2;
        this._transDeltaPanX = dx;
      }
      this._autoTransitionActive = true;
    }
  }

  resetView() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.rotLon = 0;
    this.rotLat = 0;
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

    this.cx = this.width / 2;
    this.cy = this.height / 2;
    this.baseRadius = Math.max(80, Math.min(this.width, this.height) * 0.42);

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
      this.panX = ((((this.panX + worldW / 2) % worldW) + worldW) % worldW) - worldW / 2;
    }
    if (this.zoom <= 1) {
      this.panY = 0;
      return;
    }
    const maxPanY = (this.bounds.h * (this.zoom - 1)) / 2 + 80;
    this.panY = Math.max(-maxPanY, Math.min(maxPanY, this.panY));
  }

  _clampRotation() {
    this.rotLon = normalizeLon(this.rotLon);
    this.rotLat = Math.max(-85, Math.min(85, this.rotLat));
  }

  _project2D(lon, lat) {
    const bx = this.bounds.x + ((lon + 180) / 360) * this.bounds.w;
    const by = this.bounds.y + ((90 - lat) / 180) * this.bounds.h;
    const x = (bx - this.cx) * this.zoom + this.cx + this.panX;
    const y = (by - this.cy) * this.zoom + this.cy + this.panY;
    return [x, y];
  }

  _unproject2D(px, py) {
    const bx = (px - this.cx - this.panX) / this.zoom + this.cx;
    const by = (py - this.cy - this.panY) / this.zoom + this.cy;
    const lon = normalizeLon(((bx - this.bounds.x) / this.bounds.w) * 360 - 180);
    const lat = 90 - ((by - this.bounds.y) / this.bounds.h) * 180;
    return [lon, Math.max(-85, Math.min(85, lat))];
  }

  _getVisibleTileRange() {
    const worldW = this.bounds.w * this.zoom;
    if (worldW <= 0) return [0, 0];
    const [xLeft0] = this._project2D(-180, 0);
    const kMin = Math.floor(-xLeft0 / worldW);
    const kMax = Math.floor((this.width - xLeft0) / worldW);
    return [kMin, kMax];
  }

  /**
   * Projects (lon, lat) in degrees to camera-space unit sphere & screen coordinates.
   * Returns { x, y, nx, ny, nz } where nz >= 0 is on the visible front hemisphere.
   */
  _project3D(lon, lat) {
    const lam0 = this.rotLon * DEG2RAD;
    const phi0 = this.rotLat * DEG2RAD;
    const sinPhi0 = Math.sin(phi0);
    const cosPhi0 = Math.cos(phi0);

    const lam = lon * DEG2RAD;
    const phi = lat * DEG2RAD;
    const dLam = lam - lam0;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const cosDLam = Math.cos(dLam);

    const nx = cosPhi * Math.sin(dLam);
    const ny = cosPhi0 * sinPhi - sinPhi0 * cosPhi * cosDLam;
    const nz = sinPhi0 * sinPhi + cosPhi0 * cosPhi * cosDLam;

    const r = this.radius;
    return {
      x: this.cx + r * nx,
      y: this.cy - r * ny,
      nx,
      ny,
      nz,
    };
  }

  _projectUnitVec(vx, vy, vz, sinPhi0, cosPhi0, sinLam0, cosLam0, r) {
    const rx = vx * cosLam0 + vy * sinLam0;
    const ry = -vx * sinLam0 + vy * cosLam0;
    const rz = vz;

    const nx = ry;
    const ny = cosPhi0 * rz - sinPhi0 * rx;
    const nz = sinPhi0 * rz + cosPhi0 * rx;

    return {
      x: this.cx + r * nx,
      y: this.cy - r * ny,
      nx,
      ny,
      nz,
    };
  }

  /**
   * Projects (lon, lat) during an organic wrap/unfold morph (0 < morphT < 1),
   * wrapping longitudes relative to rotLon so edges curl smoothly around the sphere.
   */
  _projectMorph(lon, lat, m) {
    const dLon = normalizeLon(lon - this.rotLon);
    const x2 = this.cx + (dLon / 360) * (this.bounds.w * this.zoom);
    const y2 = this.cy + (((-lat) / 180) * (this.bounds.h * this.zoom)) + this.panY * (1 - m);

    const p3 = this._project3D(lon, lat);
    let x3 = p3.x;
    let y3 = p3.y;
    if (p3.nz < 0) {
      const len = Math.hypot(p3.nx, p3.ny) || 1;
      const limbX = this.cx + (p3.nx / len) * this.radius;
      const limbY = this.cy - (p3.ny / len) * this.radius;
      const curl = Math.min(1, m * 1.15);
      x3 = x3 + (limbX - x3) * curl;
      y3 = y3 + (limbY - y3) * curl;
    }

    return {
      x: x2 + (x3 - x2) * m,
      y: y2 + (y3 - y2) * m,
      nz: (1 - m) + p3.nz * m,
      rawNz: p3.nz,
    };
  }

  _unproject3D(px, py) {
    const r = this.radius;
    if (r <= 0) return [this.rotLon, this.rotLat];
    let nx = (px - this.cx) / r;
    let ny = (this.cy - py) / r;
    let rho = Math.hypot(nx, ny);
    if (rho < 1e-9) {
      return [this.rotLon, this.rotLat];
    }
    if (rho > 1) {
      nx /= rho;
      ny /= rho;
      rho = 1;
    }

    const lam0 = this.rotLon * DEG2RAD;
    const phi0 = this.rotLat * DEG2RAD;
    const sinPhi0 = Math.sin(phi0);
    const cosPhi0 = Math.cos(phi0);

    const c = Math.asin(Math.min(1, rho));
    const cosC = Math.cos(c);
    const sinC = Math.sin(c);

    const phi = Math.asin(
      Math.max(-1, Math.min(1, cosC * sinPhi0 + (ny * sinC * cosPhi0) / rho))
    );
    const lam = lam0 + Math.atan2(nx * sinC, rho * cosPhi0 * cosC - ny * sinPhi0 * sinC);

    return [
      normalizeLon(lam / DEG2RAD),
      Math.max(-90, Math.min(90, phi / DEG2RAD)),
    ];
  }

  project(lon, lat) {
    if (this.morphT <= 0.001) {
      return this._project2D(lon, lat);
    }
    if (this.morphT >= 0.999) {
      const p = this._project3D(lon, lat);
      return [p.x, p.y, p.nz];
    }
    const p = this._projectMorph(lon, lat, this.morphT);
    return [p.x, p.y, p.nz];
  }

  unproject(px, py) {
    if (this.morphT < 0.5) {
      return this._unproject2D(px, py);
    }
    return this._unproject3D(px, py);
  }

  getSolarSpatialPan(lon, lat = 0) {
    const { lon: sunLon, lat: sunLat } = getSubsolarPoint(new Date(this.solarTimeMs));
    const dLon = ((((lon || 0) - sunLon + 540) % 360) - 180) * DEG2RAD;
    const latRad = Math.max(-90, Math.min(90, lat || 0)) * DEG2RAD;
    const sunLatRad = sunLat * DEG2RAD;

    const x = Math.max(-1, Math.min(1, Math.cos(latRad) * Math.sin(dLon)));
    const y = Math.max(
      -1,
      Math.min(
        1,
        Math.sin(latRad) * Math.sin(sunLatRad) +
          Math.cos(latRad) * Math.cos(sunLatRad) * Math.cos(dLon)
      )
    );
    return { x, y };
  }

  getStereoPan(lon, lat = 0) {
    return this.getSolarSpatialPan(lon, lat).x * 0.85;
  }

  _bindEvents() {
    window.addEventListener('resize', () => this.resize());

    // Wheel zoom
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.lastUserNavTime = performance.now();
      this._autoTransitionActive = false;

      if (this.mapMode === '2d') {
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        const newZoom = Math.max(1, Math.min(12, this.zoom * factor));
        if (newZoom === this.zoom) return;

        const scaleRatio = newZoom / this.zoom;
        this.panX = mx - this.cx - (mx - this.cx - this.panX) * scaleRatio;
        this.panY = my - this.cy - (my - this.cy - this.panY) * scaleRatio;
        this.zoom = newZoom;
        this._clampPan();
        this.onZoomChange?.(this.zoom);
      } else {
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const newZoom = Math.max(1, Math.min(10, this.zoom * factor));
        if (newZoom === this.zoom) return;

        this.zoom = newZoom;
        this.onZoomChange?.(this.zoom);
      }
    }, { passive: false });

    // Drag to pan (2D) or rotate (3D)
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

        if (this.mapMode === '2d') {
          this.panX += dx;
          this.panY += dy;
          this._clampPan();
        } else {
          const r = Math.max(80, this.radius);
          const degPerPx = (180 / Math.PI) / r;
          const cosLatFactor = Math.max(0.35, Math.cos(this.rotLat * DEG2RAD));
          this.rotLon -= (dx * degPerPx) / cosLatFactor;
          this.rotLat += dy * degPerPx;
          this._clampRotation();
        }

        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
        this.canvas.style.cursor = 'grabbing';
        this.onHover?.(null, 0, 0);
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

      if (this.morphT < 0.5) {
        const worldW = this.bounds.w * this.zoom;
        const [kMin, kMax] = this._getVisibleTileRange();
        for (let i = this.quakes.length - 1; i >= 0; i--) {
          const q = this.quakes[i];
          const [qxBase, qy] = this._project2D(q.lon, q.lat);
          for (let k = kMin; k <= kMax; k++) {
            const d = Math.hypot(mx - (qxBase + k * worldW), my - qy);
            if (d < bestDist) {
              bestDist = d;
              closest = q;
            }
          }
        }
      } else {
        for (let i = this.quakes.length - 1; i >= 0; i--) {
          const q = this.quakes[i];
          const p = this._project3D(q.lon, q.lat);
          if (p.nz < 0) continue;
          const d = Math.hypot(mx - p.x, my - p.y);
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

  getSolarDialMetrics() {
    const { lon: sunLon } = getSubsolarPoint(new Date(this.solarTimeMs));
    if (this.morphT < 0.5) {
      const [sunScreenX] = this._project2D(sunLon, 0);
      return {
        sunScreenX,
        worldW: this.bounds.w * this.zoom,
        sunLon,
      };
    }
    const worldW = Math.max(this.width, Math.PI * 2 * this.radius);
    const dLon = normalizeLon(sunLon - this.rotLon);
    const sunScreenX = this.cx + (dLon / 360) * worldW;
    return {
      sunScreenX,
      worldW,
      sunLon,
    };
  }

  _updateSolar2DTexture() {
    if (
      this._lastSolar2DTime !== 0 &&
      Math.abs(this.solarTimeMs - this._lastSolar2DTime) < 60000
    ) {
      return;
    }
    this._lastSolar2DTime = this.solarTimeMs;

    const { lon: sunLon, lat: sunLat } = getSubsolarPoint(new Date(this.solarTimeMs));
    const sunLatRad = sunLat * DEG2RAD;
    const sinDecl = Math.sin(sunLatRad);
    const cosDecl = Math.cos(sunLatRad);

    const w = this._solar2DCanvas.width;
    const h = this._solar2DCanvas.height;
    const img = this._solar2DCtx.createImageData(w, h);
    const data = img.data;

    for (let py = 0; py < h; py++) {
      const lat = 90 - ((py + 0.5) / h) * 180;
      const latRad = lat * DEG2RAD;
      const sinLat = Math.sin(latRad);
      const cosLat = Math.cos(latRad);

      for (let px = 0; px < w; px++) {
        const lon = ((px + 0.5) / w) * 360 - 180;
        const dLon = (lon - sunLon) * DEG2RAD;
        const cosZ = sinLat * sinDecl + cosLat * cosDecl * Math.cos(dLon);

        const idx = (py * w + px) * 4;
        if (cosZ <= -0.18) {
          data[idx + 3] = 0;
          continue;
        }

        let intensity;
        let warmth;
        if (cosZ < 0) {
          const tw = (cosZ + 0.18) / 0.18;
          intensity = Math.pow(tw, 2.0) * 0.22;
          warmth = 0;
        } else {
          intensity = 0.22 + 0.78 * Math.pow(cosZ, 0.68);
          warmth = Math.pow(cosZ, 0.85);
        }

        data[idx] = 255;
        data[idx + 1] = Math.round(175 + 72 * warmth);
        data[idx + 2] = Math.round(75 + 135 * warmth);
        data[idx + 3] = Math.round(intensity * 78);
      }
    }

    this._solar2DCtx.putImageData(img, 0, 0);
  }

  _updateSolar3DTexture(sunCamX, sunCamY, sunCamZ) {
    const key = `${sunCamX.toFixed(3)},${sunCamY.toFixed(3)},${sunCamZ.toFixed(3)}`;
    if (key === this._lastSolar3DKey) return;
    this._lastSolar3DKey = key;

    const size = this._solar3DCanvas.width;
    const half = size / 2;
    const img = this._solar3DCtx.createImageData(size, size);
    const data = img.data;

    for (let py = 0; py < size; py++) {
      const ny = (half - (py + 0.5)) / half;
      const ny2 = ny * ny;

      for (let px = 0; px < size; px++) {
        const nx = (px + 0.5 - half) / half;
        const r2 = nx * nx + ny2;
        const idx = (py * size + px) * 4;

        if (r2 >= 1) {
          data[idx + 3] = 0;
          continue;
        }

        const nz = Math.sqrt(1 - r2);
        const cosZ = nx * sunCamX + ny * sunCamY + nz * sunCamZ;

        if (cosZ <= -0.18) {
          data[idx + 3] = 0;
          continue;
        }

        let intensity;
        let warmth;
        if (cosZ < 0) {
          const tw = (cosZ + 0.18) / 0.18;
          intensity = Math.pow(tw, 2.0) * 0.22;
          warmth = 0;
        } else {
          intensity = 0.22 + 0.78 * Math.pow(cosZ, 0.68);
          warmth = Math.pow(cosZ, 0.85);
        }

        data[idx] = 255;
        data[idx + 1] = Math.round(175 + 72 * warmth);
        data[idx + 2] = Math.round(75 + 135 * warmth);
        data[idx + 3] = Math.round(intensity * 82);
      }
    }

    this._solar3DCtx.putImageData(img, 0, 0);
  }

  _updateMorph(now) {
    if (!this._morphActive) return;
    const rawT = Math.min(1, Math.max(0, (now - this._morphStartTime) / this._morphDuration));
    const easeT = easeInOutCubic(rawT);
    this.morphT = this._morphStartT + (this._morphTargetT - this._morphStartT) * easeT;

    if (rawT >= 1) {
      this.morphT = this._morphTargetT;
      this._morphActive = false;
    }
  }

  _updateAutoCamera(now) {
    if (!this._autoTransitionActive || this.isDragging || this._morphActive) return;
    if (now - this.lastUserNavTime < 5000) {
      this._autoTransitionActive = false;
      return;
    }

    const rawT = Math.min(1, Math.max(0, (now - this._transStartTime) / this._transDuration));
    const easeT = easeInOutCubic(rawT);

    const prevZoom = this.zoom;
    this.zoom = this._transStartZoom + (1 - this._transStartZoom) * easeT;

    if (this.mapMode === '3d') {
      this.rotLon = this._transStartLon + this._transDeltaLon * easeT;
      this.rotLat = this._transStartLat + this._transDeltaLat * easeT;
      this._clampRotation();
    } else {
      this.panY = this._transStartPanY * (1 - easeT);
      this.panX = this._transStartPanX + this._transDeltaPanX * easeT;
      this._clampPan();
    }

    if (Math.abs(this.zoom - prevZoom) > 0.001 || rawT >= 1) {
      this.onZoomChange?.(this.zoom);
    }

    if (rawT >= 1) {
      this.zoom = 1;
      if (this.mapMode === '3d') {
        this.rotLon = normalizeLon(this._transStartLon + this._transDeltaLon);
        this.rotLat = Math.max(-85, Math.min(85, this._transStartLat + this._transDeltaLat));
      } else {
        this.panY = 0;
        this._clampPan();
      }
      this.onZoomChange?.(1);
      this._autoTransitionActive = false;
    }
  }

  render(now) {
    this._updateMorph(now);
    this._updateAutoCamera(now);

    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    const m = this.morphT;
    if (m <= 0.001) {
      this._render2D(ctx, now);
    } else if (m >= 0.999) {
      this._render3D(ctx, now);
    } else {
      this._renderMorph(ctx, now, m);
    }

    ctx.restore();
  }

  // ==================== 2D RENDER PATH ====================

  _render2D(ctx, now) {
    ctx.fillStyle = '#06090f';
    ctx.fillRect(0, 0, this.width, this.height);

    this._updateSolar2DTexture();

    const worldW = this.bounds.w * this.zoom;
    const [kMin, kMax] = this._getVisibleTileRange();

    for (let k = kMin; k <= kMax; k++) {
      ctx.save();
      ctx.translate(k * worldW, 0);
      this._drawGraticule2D(ctx);
      this._drawLand2D(ctx);
      if (this.showPlates) {
        this._drawPlates2D(ctx);
      }
      this._drawSolar2D(ctx);
      this._drawQuakes2D(ctx);
      ctx.restore();
    }

    this._drawWaves2D(ctx, now, kMin, kMax, worldW);
  }

  _drawSolar2D(ctx) {
    const [x1, y1] = this._project2D(-180, 90);
    const [x2, y2] = this._project2D(180, -90);

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this._solar2DCanvas, x1, y1, x2 - x1, y2 - y1);

    const { lon: sunLon, lat: sunLat } = getSubsolarPoint(new Date(this.solarTimeMs));
    const [sx, sy] = this._project2D(sunLon, sunLat);
    this._drawSunReticle(ctx, sx, sy, sunLat, 1);
    ctx.restore();
  }

  _drawSunReticle(ctx, sx, sy, sunLat, alphaScale = 1) {
    const sunGlow = ctx.createRadialGradient(sx, sy, 2, sx, sy, 42 * Math.min(2, this.zoom));
    sunGlow.addColorStop(0, `rgba(255, 232, 160, ${0.55 * alphaScale})`);
    sunGlow.addColorStop(0.35, `rgba(255, 195, 85, ${0.18 * alphaScale})`);
    sunGlow.addColorStop(1, 'rgba(255, 180, 60, 0)');
    ctx.fillStyle = sunGlow;
    ctx.beginPath();
    ctx.arc(sx, sy, 42 * Math.min(2, this.zoom), 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = `rgba(255, 224, 130, ${0.65 * alphaScale})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = `rgba(255, 224, 130, ${0.72 * alphaScale})`;
    ctx.font = '600 9px "JetBrains Mono", monospace';
    const hemi = sunLat >= 0 ? 'N. SUMMER' : 'S. SUMMER';
    ctx.fillText(`☀ ${hemi}`, sx + 9, sy + 3);
  }

  _drawGraticule2D(ctx) {
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.06)';
    ctx.lineWidth = 1;

    for (let lon = -180; lon <= 180; lon += 30) {
      const [x, y1] = this._project2D(lon, 90);
      const [, y2] = this._project2D(lon, -90);
      ctx.beginPath();
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
      ctx.stroke();
    }

    for (let lat = -60; lat <= 60; lat += 30) {
      const [x1, y] = this._project2D(-180, lat);
      const [x2] = this._project2D(180, lat);
      ctx.beginPath();
      ctx.strokeStyle = lat === 0 ? 'rgba(148, 163, 184, 0.13)' : 'rgba(148, 163, 184, 0.06)';
      ctx.moveTo(x1, y);
      ctx.lineTo(x2, y);
      ctx.stroke();
    }
  }

  _drawLand2D(ctx) {
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
            const [x, y] = this._project2D(ring[i][0], ring[i][1]);
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

  _drawPlates2D(ctx) {
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
          const [x, y] = this._project2D(lon, lat);
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

  _drawQuakes2D(ctx) {
    for (const q of this.quakes) {
      const [x, y] = this._project2D(q.lon, q.lat);
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

  _drawWaves2D(ctx, now, kMin, kMax, worldW) {
    if (!this.activeWaves.length) return;

    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    for (const w of this.activeWaves) {
      const elapsed = this._getWaveElapsed(w, now);
      if (elapsed < 0 || elapsed >= w.duration) continue;

      const t = Math.min(1, elapsed / w.duration);
      const [xBase, y] = this._project2D(w.lon, w.lat);
      const sDelayFrac = Math.min(0.35, (w.sDelayMs || 0) / w.duration);
      const attackFrac = Math.max(0.015, Math.min(0.45, (w.attackMs || 80) / w.duration));
      const bloomWindow = Math.max(0.35, attackFrac + 0.25);

      for (let k = kMin; k <= kMax; k++) {
        const x = xBase + k * worldW;
        if (x < -250 || x > this.width + 250) continue;

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

        const ringCount = w.mag >= 3.5 ? 4 : 3;
        for (let i = 0; i < ringCount; i++) {
          const delay = sDelayFrac + i * 0.11;
          if (t <= delay || delay >= 1) continue;

          const rt = Math.min(1, (t - delay) / (1 - delay));
          const ease = Math.pow(rt, 0.58);
          const ringMax = w.maxRadius * (1 - i * 0.15);
          const radius = Math.max(1.5, 2.5 + ease * ringMax);

          const riseTime = Math.max(0.05, attackFrac * 0.85);
          const rise = Math.min(1, rt / riseTime);
          const envelope = rise * Math.pow(1 - rt, 2.15);
          const weight = 1 - i * 0.22;
          const alpha = envelope * weight;
          if (alpha <= 0.008) continue;

          this._traceOrganicRipplePath(ctx, x, y, radius, rt, w, i);
          this._strokeWaveCrest(ctx, w, rt, alpha, weight, i);
        }
      }
    }

    ctx.restore();
  }

  // ==================== 3D GLOBE RENDER PATH ====================

  _render3D(ctx, now) {
    ctx.fillStyle = '#05080e';
    ctx.fillRect(0, 0, this.width, this.height);

    const cx = this.cx;
    const cy = this.cy;
    const r = this.radius;

    // Outer atmospheric glow around the globe limb
    const atmoGrad = ctx.createRadialGradient(cx, cy, r * 0.92, cx, cy, r * 1.18);
    atmoGrad.addColorStop(0, 'rgba(56, 189, 248, 0.14)');
    atmoGrad.addColorStop(0.55, 'rgba(56, 189, 248, 0.04)');
    atmoGrad.addColorStop(1, 'rgba(5, 8, 14, 0)');
    ctx.fillStyle = atmoGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.18, 0, Math.PI * 2);
    ctx.fill();

    // Clip all globe surface layers to the sphere silhouette
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();

    const oceanGrad = ctx.createRadialGradient(
      cx - r * 0.18,
      cy - r * 0.18,
      r * 0.08,
      cx,
      cy,
      r
    );
    oceanGrad.addColorStop(0, '#0c1524');
    oceanGrad.addColorStop(0.7, '#070c16');
    oceanGrad.addColorStop(1, '#04070d');
    ctx.fillStyle = oceanGrad;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

    this._drawGraticule3D(ctx);
    this._drawLand3D(ctx);
    if (this.showPlates) {
      this._drawPlates3D(ctx);
    }
    this._drawSolar3D(ctx, 1);
    this._drawQuakes3D(ctx);
    this._drawWaves3D(ctx, now);

    ctx.restore();

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  _drawSolar3D(ctx, alphaScale = 1) {
    const { lon: sunLon, lat: sunLat } = getSubsolarPoint(new Date(this.solarTimeMs));
    const sunProj = this._project3D(sunLon, sunLat);

    this._updateSolar3DTexture(sunProj.nx, sunProj.ny, sunProj.nz);

    const r = this.radius;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = alphaScale;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this._solar3DCanvas, this.cx - r, this.cy - r, r * 2, r * 2);

    if (sunProj.nz > 0) {
      this._drawSunReticle(ctx, sunProj.x, sunProj.y, sunLat, alphaScale);
    }

    ctx.restore();
  }

  _drawCurveSegment3D(ctx, pts) {
    let penDown = false;
    let prev = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.nz >= 0) {
        if (!penDown) {
          if (prev && prev.nz < 0) {
            const t = -prev.nz / (p.nz - prev.nz);
            const ix = prev.nx + (p.nx - prev.nx) * t;
            const iy = prev.ny + (p.ny - prev.ny) * t;
            const len = Math.hypot(ix, iy) || 1;
            ctx.moveTo(this.cx + (ix / len) * this.radius, this.cy - (iy / len) * this.radius);
          } else {
            ctx.moveTo(p.x, p.y);
          }
          penDown = true;
        }
        ctx.lineTo(p.x, p.y);
      } else if (penDown && prev && prev.nz >= 0) {
        const t = prev.nz / (prev.nz - p.nz);
        const ix = prev.nx + (p.nx - prev.nx) * t;
        const iy = prev.ny + (p.ny - prev.ny) * t;
        const len = Math.hypot(ix, iy) || 1;
        ctx.lineTo(this.cx + (ix / len) * this.radius, this.cy - (iy / len) * this.radius);
        penDown = false;
      } else {
        penDown = false;
      }
      prev = p;
    }
  }

  _drawGraticule3D(ctx) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
    for (let lon = -180; lon < 180; lon += 30) {
      const pts = [];
      for (let lat = -90; lat <= 90; lat += 4) {
        pts.push(this._project3D(lon, lat));
      }
      ctx.beginPath();
      this._drawCurveSegment3D(ctx, pts);
      ctx.stroke();
    }

    for (let lat = -60; lat <= 60; lat += 30) {
      const pts = [];
      for (let lon = -180; lon <= 180; lon += 4) {
        pts.push(this._project3D(lon, lat));
      }
      ctx.beginPath();
      ctx.strokeStyle = lat === 0 ? 'rgba(148, 163, 184, 0.16)' : 'rgba(148, 163, 184, 0.08)';
      this._drawCurveSegment3D(ctx, pts);
      ctx.stroke();
    }
  }

  _drawLand3D(ctx) {
    if (!this.landFeatures.length) return;
    ctx.fillStyle = '#0f1724';
    ctx.strokeStyle = '#1e2d42';
    ctx.lineWidth = 1;

    const r = this.radius;
    const cx = this.cx;
    const cy = this.cy;

    for (const feature of this.landFeatures) {
      const geom = feature.geometry;
      if (!geom) continue;
      const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
      for (const poly of polys) {
        let anyFront = false;
        const projectedRings = [];
        for (const ring of poly) {
          const pRing = new Array(ring.length);
          for (let i = 0; i < ring.length; i++) {
            const p = this._project3D(ring[i][0], ring[i][1]);
            if (p.nz > -0.15) anyFront = true;
            pRing[i] = p;
          }
          projectedRings.push(pRing);
        }
        if (!anyFront) continue;

        ctx.beginPath();
        for (const pRing of projectedRings) {
          for (let i = 0; i < pRing.length; i++) {
            const p = pRing[i];
            let sx = p.x;
            let sy = p.y;
            if (p.nz < 0) {
              const len = Math.hypot(p.nx, p.ny) || 1;
              sx = cx + (p.nx / len) * r;
              sy = cy - (p.ny / len) * r;
            }
            if (i === 0) ctx.moveTo(sx, sy);
            else ctx.lineTo(sx, sy);
          }
          ctx.closePath();
        }
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  _drawPlates3D(ctx) {
    if (!this.plateFeatures.length) return;
    ctx.strokeStyle = 'rgba(255, 107, 53, 0.28)';
    ctx.lineWidth = 1.1;

    for (const feature of this.plateFeatures) {
      const geom = feature.geometry;
      if (!geom) continue;
      const lines = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;
      for (const line of lines) {
        const pts = new Array(line.length);
        for (let i = 0; i < line.length; i++) {
          pts[i] = this._project3D(line[i][0], line[i][1]);
        }
        ctx.beginPath();
        this._drawCurveSegment3D(ctx, pts);
        ctx.stroke();
      }
    }
  }

  _drawQuakes3D(ctx) {
    for (const q of this.quakes) {
      const p = this._project3D(q.lon, q.lat);
      if (p.nz < 0) continue;

      const mag = Math.max(0.4, q.mag ?? 1);
      const r = 2.0 + Math.pow(mag, 1.35) * 1.15;
      const isSelected = q.id === this.selectedQuakeId || q === this.hoveredQuake;

      ctx.beginPath();
      ctx.arc(p.x, p.y, isSelected ? r + 2.5 : r, 0, Math.PI * 2);
      ctx.fillStyle = getDepthColor(q.depth ?? 10, isSelected ? 0.95 : 0.58);
      ctx.fill();

      if (isSelected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  _traceGeodesicRipplePath(ctx, ex, ey, ez, ux, uy, uz, vx, vy, vz, angRadius, rt, w, ringIndex, sinPhi0, cosPhi0, sinLam0, cosLam0, r) {
    const pixelRadius = angRadius * r;
    const segments = Math.max(40, Math.min(96, Math.round(pixelRadius * 1.15)));
    const phaseA = w.phaseA ?? 0;
    const phaseB = w.phaseB ?? 1.1;
    const phaseC = w.phaseC ?? 2.4;
    const wobbleAmp = w.wobbleAmp ?? 0.038;
    const freqScale = Math.max(0.65, Math.min(2.2, (w.freq || 36.7) / 36.7));
    const drift = rt * (2.0 + freqScale * 1.0) + ringIndex * 0.95;
    const radialSpread = 0.35 + 0.65 * rt;

    const pts = new Array(segments + 1);
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const harmonic =
        Math.sin(theta * 3 + phaseA + drift) * 0.52 +
        Math.sin(theta * 5 - phaseB - drift * 0.72) * 0.3 +
        Math.cos(theta * 2 + phaseC + drift * 0.41) * 0.18;
      const rad = Math.max(0.002, angRadius * (1 + harmonic * wobbleAmp * radialSpread));
      const cosR = Math.cos(rad);
      const sinR = Math.sin(rad);
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);

      const px = cosR * ex + sinR * (cosT * ux + sinT * vx);
      const py = cosR * ey + sinR * (cosT * uy + sinT * vy);
      const pz = cosR * ez + sinR * (cosT * uz + sinT * vz);

      pts[i] = this._projectUnitVec(px, py, pz, sinPhi0, cosPhi0, sinLam0, cosLam0, r);
    }

    ctx.beginPath();
    this._drawCurveSegment3D(ctx, pts);
  }

  _drawWaves3D(ctx, now) {
    if (!this.activeWaves.length) return;

    const lam0 = this.rotLon * DEG2RAD;
    const phi0 = this.rotLat * DEG2RAD;
    const sinPhi0 = Math.sin(phi0);
    const cosPhi0 = Math.cos(phi0);
    const sinLam0 = Math.sin(lam0);
    const cosLam0 = Math.cos(lam0);
    const r = this.radius;

    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    for (const w of this.activeWaves) {
      const elapsed = this._getWaveElapsed(w, now);
      if (elapsed < 0 || elapsed >= w.duration) continue;

      const t = Math.min(1, elapsed / w.duration);
      const epi = this._project3D(w.lon, w.lat);
      const sDelayFrac = Math.min(0.35, (w.sDelayMs || 0) / w.duration);
      const attackFrac = Math.max(0.015, Math.min(0.45, (w.attackMs || 80) / w.duration));
      const bloomWindow = Math.max(0.35, attackFrac + 0.25);

      if (t < bloomWindow && epi.nz >= -0.05) {
        const dropT = t / bloomWindow;
        const dropRise = w.timbre === 'abyssal'
          ? Math.min(1, t / Math.max(0.05, attackFrac))
          : 1;
        const dropAlpha = dropRise * Math.pow(1 - dropT, 2);
        const dropRadius = (5 + w.mag * 1.8 + Math.sin(dropT * Math.PI) * 3.5) * Math.min(2.2, Math.sqrt(this.zoom));
        const grad = ctx.createRadialGradient(epi.x, epi.y, 0.5, epi.x, epi.y, dropRadius);
        grad.addColorStop(0, `rgba(240, 250, 255, ${dropAlpha * 0.78})`);
        grad.addColorStop(0.45, getDepthColor(w.depth, dropAlpha * 0.45));
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.beginPath();
        ctx.arc(epi.x, epi.y, dropRadius, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }

      const eLon = w.lon * DEG2RAD;
      const eLat = w.lat * DEG2RAD;
      const cosELat = Math.cos(eLat);
      const sinELat = Math.sin(eLat);
      const cosELon = Math.cos(eLon);
      const sinELon = Math.sin(eLon);

      const ex = cosELat * cosELon;
      const ey = cosELat * sinELon;
      const ez = sinELat;
      const ux = -sinELon;
      const uy = cosELon;
      const uz = 0;
      const vx = -sinELat * cosELon;
      const vy = -sinELat * sinELon;
      const vz = cosELat;

      const ringCount = w.mag >= 3.5 ? 4 : 3;
      const maxAngRadius = Math.min(Math.PI * 0.65, w.maxRadius / Math.max(120, this.baseRadius));

      for (let i = 0; i < ringCount; i++) {
        const delay = sDelayFrac + i * 0.11;
        if (t <= delay || delay >= 1) continue;

        const rt = Math.min(1, (t - delay) / (1 - delay));
        const ease = Math.pow(rt, 0.58);
        const ringMaxAng = maxAngRadius * (1 - i * 0.15);
        const angRadius = 0.008 + ease * ringMaxAng;

        const riseTime = Math.max(0.05, attackFrac * 0.85);
        const rise = Math.min(1, rt / riseTime);
        const envelope = rise * Math.pow(1 - rt, 2.15);
        const weight = 1 - i * 0.22;
        const alpha = envelope * weight;
        if (alpha <= 0.008) continue;

        this._traceGeodesicRipplePath(
          ctx,
          ex, ey, ez,
          ux, uy, uz,
          vx, vy, vz,
          angRadius,
          rt,
          w,
          i,
          sinPhi0, cosPhi0,
          sinLam0, cosLam0,
          r
        );
        this._strokeWaveCrest(ctx, w, rt, alpha, weight, i);
      }
    }

    ctx.restore();
  }

  _strokeWaveCrest(ctx, w, rt, alpha, weight, i) {
    ctx.strokeStyle = getDepthColor(w.depth, alpha * 0.24);
    ctx.lineWidth = (3.4 + w.mag * 0.55) * (1 - rt * 0.45) * weight;
    ctx.stroke();

    ctx.strokeStyle = getDepthColor(w.depth, alpha * 0.72);
    ctx.lineWidth = (1.25 + w.mag * 0.2) * (1 - rt * 0.35);
    ctx.stroke();

    if (i < 2) {
      ctx.strokeStyle = `rgba(232, 248, 255, ${alpha * (i === 0 ? 0.45 : 0.24)})`;
      ctx.lineWidth = 0.75;
      ctx.stroke();
    }
  }

  // ==================== ORGANIC WRAP / UNFOLD MORPH PATH ====================

  _renderMorph(ctx, now, m) {
    ctx.fillStyle = '#05080e';
    ctx.fillRect(0, 0, this.width, this.height);

    const cx = this.cx;
    const cy = this.cy;
    const r = this.radius;
    const maxScreenR = Math.hypot(this.width, this.height);
    const clipR = r + (maxScreenR - r) * Math.pow(1 - m, 2.2);

    // Fade in outer atmospheric glow as globe wraps
    const atmoGrad = ctx.createRadialGradient(cx, cy, clipR * 0.92, cx, cy, clipR * 1.18);
    atmoGrad.addColorStop(0, `rgba(56, 189, 248, ${0.14 * m})`);
    atmoGrad.addColorStop(0.55, `rgba(56, 189, 248, ${0.04 * m})`);
    atmoGrad.addColorStop(1, 'rgba(5, 8, 14, 0)');
    ctx.fillStyle = atmoGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, clipR * 1.18, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, clipR, 0, Math.PI * 2);
    ctx.clip();

    // Blend ocean background from flat 2D dark to 3D radial sphere
    ctx.fillStyle = '#06090f';
    ctx.fillRect(0, 0, this.width, this.height);

    if (m > 0.01) {
      ctx.save();
      ctx.globalAlpha = m;
      const oceanGrad = ctx.createRadialGradient(
        cx - r * 0.18,
        cy - r * 0.18,
        r * 0.08,
        cx,
        cy,
        r
      );
      oceanGrad.addColorStop(0, '#0c1524');
      oceanGrad.addColorStop(0.7, '#070c16');
      oceanGrad.addColorStop(1, '#04070d');
      ctx.fillStyle = oceanGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, clipR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    this._drawGraticuleMorph(ctx, m);
    this._drawLandMorph(ctx, m);
    if (this.showPlates) {
      this._drawPlatesMorph(ctx, m);
    }

    // Crossfade 2D solar canvas and 3D solar sphere
    this._updateSolar2DTexture();
    if (1 - m > 0.02) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = 1 - m;
      const worldW = this.bounds.w * this.zoom;
      const xStart = this.cx - worldW / 2;
      const [, y1] = this._project2D(-180, 90);
      const [, y2] = this._project2D(180, -90);
      ctx.drawImage(this._solar2DCanvas, xStart, y1, worldW, y2 - y1);
      ctx.restore();
    }
    this._drawSolar3D(ctx, m);

    this._drawQuakesMorph(ctx, m);
    this._drawWavesMorph(ctx, now, m);

    ctx.restore();

    if (m > 0.02) {
      ctx.strokeStyle = `rgba(148, 163, 184, ${0.22 * m})`;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.arc(cx, cy, clipR, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  _drawGraticuleMorph(ctx, m) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(148, 163, 184, ${0.06 + 0.02 * m})`;
    for (let lon = -180; lon < 180; lon += 30) {
      ctx.beginPath();
      for (let lat = -90; lat <= 90; lat += 6) {
        const p = this._projectMorph(lon, lat, m);
        if (lat === -90) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }

    for (let lat = -60; lat <= 60; lat += 30) {
      ctx.beginPath();
      ctx.strokeStyle = lat === 0
        ? `rgba(148, 163, 184, ${0.13 + 0.03 * m})`
        : `rgba(148, 163, 184, ${0.06 + 0.02 * m})`;
      let prevDLon = null;
      for (let lon = -180; lon <= 180; lon += 6) {
        const dLon = normalizeLon(lon - this.rotLon);
        const p = this._projectMorph(lon, lat, m);
        if (lon === -180 || (prevDLon !== null && Math.abs(dLon - prevDLon) > 180)) {
          ctx.moveTo(p.x, p.y);
        } else {
          ctx.lineTo(p.x, p.y);
        }
        prevDLon = dLon;
      }
      ctx.stroke();
    }
  }

  _drawLandMorph(ctx, m) {
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
          let prevDLon = null;
          for (let i = 0; i < ring.length; i++) {
            const [lon, lat] = ring[i];
            const dLon = normalizeLon(lon - this.rotLon);
            const p = this._projectMorph(lon, lat, m);
            if (i === 0 || (prevDLon !== null && Math.abs(dLon - prevDLon) > 180)) {
              ctx.moveTo(p.x, p.y);
            } else {
              ctx.lineTo(p.x, p.y);
            }
            prevDLon = dLon;
          }
          ctx.closePath();
        }
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  _drawPlatesMorph(ctx, m) {
    if (!this.plateFeatures.length) return;
    ctx.strokeStyle = `rgba(255, 107, 53, ${0.24 + 0.04 * m})`;
    ctx.lineWidth = 1.1;

    for (const feature of this.plateFeatures) {
      const geom = feature.geometry;
      if (!geom) continue;
      const lines = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;
      for (const line of lines) {
        ctx.beginPath();
        let prevDLon = null;
        for (let i = 0; i < line.length; i++) {
          const [lon, lat] = line[i];
          const dLon = normalizeLon(lon - this.rotLon);
          const p = this._projectMorph(lon, lat, m);
          if (i === 0 || (prevDLon !== null && Math.abs(dLon - prevDLon) > 180)) {
            ctx.moveTo(p.x, p.y);
          } else {
            ctx.lineTo(p.x, p.y);
          }
          prevDLon = dLon;
        }
        ctx.stroke();
      }
    }
  }

  _drawQuakesMorph(ctx, m) {
    for (const q of this.quakes) {
      const p = this._projectMorph(q.lon, q.lat, m);
      const vis = p.rawNz >= 0 ? 1 : Math.max(0, 1 - m * 1.25);
      if (vis <= 0.02) continue;

      const mag = Math.max(0.4, q.mag ?? 1);
      const r = 2.0 + Math.pow(mag, 1.35) * 1.15;
      const isSelected = q.id === this.selectedQuakeId || q === this.hoveredQuake;

      ctx.beginPath();
      ctx.arc(p.x, p.y, isSelected ? r + 2.5 : r, 0, Math.PI * 2);
      ctx.fillStyle = getDepthColor(q.depth ?? 10, (isSelected ? 0.95 : 0.56) * vis);
      ctx.fill();
    }
  }

  _drawWavesMorph(ctx, now, m) {
    if (!this.activeWaves.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    for (const w of this.activeWaves) {
      const elapsed = this._getWaveElapsed(w, now);
      if (elapsed < 0 || elapsed >= w.duration) continue;

      const t = Math.min(1, elapsed / w.duration);
      const epi = this._projectMorph(w.lon, w.lat, m);
      const vis = epi.rawNz >= 0 ? 1 : Math.max(0, 1 - m * 1.25);
      if (vis <= 0.02) continue;

      const sDelayFrac = Math.min(0.35, (w.sDelayMs || 0) / w.duration);
      const attackFrac = Math.max(0.015, Math.min(0.45, (w.attackMs || 80) / w.duration));
      const ringCount = w.mag >= 3.5 ? 4 : 3;

      for (let i = 0; i < ringCount; i++) {
        const delay = sDelayFrac + i * 0.11;
        if (t <= delay || delay >= 1) continue;

        const rt = Math.min(1, (t - delay) / (1 - delay));
        const ease = Math.pow(rt, 0.58);
        const ringMax = w.maxRadius * (1 - i * 0.15);
        const radius = Math.max(1.5, 2.5 + ease * ringMax);

        const riseTime = Math.max(0.05, attackFrac * 0.85);
        const rise = Math.min(1, rt / riseTime);
        const envelope = rise * Math.pow(1 - rt, 2.15);
        const weight = 1 - i * 0.22;
        const alpha = envelope * weight * vis;
        if (alpha <= 0.008) continue;

        this._traceOrganicRipplePath(ctx, epi.x, epi.y, radius, rt, w, i);
        this._strokeWaveCrest(ctx, w, rt, alpha, weight, i);
      }
    }

    ctx.restore();
  }
}
