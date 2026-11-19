// Three.js WebGL Multi-Plane 2D/3D Map & Concentric Depth Globe
// Layers (bottom -> top):
//   1. Lowest plane (R_OCEAN): Oceans, graticule, solar day/night, tectonic plate boundaries
//   2. Middle layer (R_OCEAN..R_LAND): Planar-parallel earthquake discs positioned by depth + organic rising waves
//   3. Top plane (R_LAND): Frosted/tinted transparent land map pieces with subtle coastline glow

import * as THREE from '../vendor/three.module.min.js';
import { triangulateGeoPolygon } from './triangulate.js';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

const R_OCEAN = 0.86;
const R_LAND = 1.0;
const DEPTH_MAX_KM = 700;

const W_2D = 4.0;
const H_2D = 2.0;
const FOV_DEG = 38;
const FOV_RAD = FOV_DEG * DEG2RAD;

export function getDepthColor(depth, alpha = 1) {
  if (depth < 70) return `rgba(255, 107, 53, ${alpha})`;   // Shallow: Magma Coral
  if (depth < 300) return `rgba(247, 184, 1, ${alpha})`;   // Mid: Amber Gold
  return `rgba(56, 189, 248, ${alpha})`;                   // Deep: Abyssal Cyan
}

function getDepthRGB(depth) {
  if (depth < 70) return [1.0, 107 / 255, 53 / 255];
  if (depth < 300) return [247 / 255, 184 / 255, 1 / 255];
  return [56 / 255, 189 / 255, 248 / 255];
}

/**
 * Geological depth mapping:
 * Shallowest (0 km) sits just beneath the top land plane (R_LAND),
 * Deepest (700+ km) sits just above the lowest ocean/plates plane (R_OCEAN).
 */
export function getEventRadius(depth) {
  const d = Math.max(0, Math.min(DEPTH_MAX_KM, Number.isFinite(depth) ? depth : 10));
  const norm = d / DEPTH_MAX_KM;
  return R_OCEAN + (R_LAND - R_OCEAN) * (0.975 - 0.925 * norm);
}

/**
 * Computes true subsolar longitude & latitude (solar declination) in degrees from UTC time,
 * accounting for Earth's 23.439° axial tilt and the Equation of Time.
 */
export function getSubsolarPoint(date = new Date()) {
  const j2000Ms = Date.UTC(2000, 0, 1, 12, 0, 0);
  const d = (date.getTime() - j2000Ms) / 86400000;

  const g = (357.529 + 0.98560028 * d) * DEG2RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG2RAD;
  const eps = (23.439 - 0.00000036 * d) * DEG2RAD;

  const lat = Math.asin(Math.sin(eps) * Math.sin(L)) / DEG2RAD;

  const ra = Math.atan2(Math.cos(eps) * Math.sin(L), Math.cos(L)) / DEG2RAD;
  let eotDeg = ((q % 360) + 360) % 360 - ((ra % 360) + 360) % 360;
  if (eotDeg > 180) eotDeg -= 360;
  if (eotDeg < -180) eotDeg += 360;

  const utcHours =
    date.getUTCHours() +
    date.getUTCMinutes() / 60 +
    date.getUTCSeconds() / 3600 +
    date.getUTCMilliseconds() / 3600000;

  let lon = (12 - utcHours) * 15 - eotDeg;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;

  return { lon, lat };
}

/**
 * Computes Greenwich Mean Sidereal Time (GMST) in degrees [0, 360) from UTC time.
 * Matches the J2000 epoch convention used by getSubsolarPoint().
 */
export function getGMSTDeg(date = new Date()) {
  const j2000Ms = Date.UTC(2000, 0, 1, 12, 0, 0);
  const d = (date.getTime() - j2000Ms) / 86400000;
  const gmst = 280.46061837 + 360.98564736629 * d;
  return ((gmst % 360) + 360) % 360;
}

function normalizeLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function smoothDamp(current, target, velocity, smoothTime, dt, maxSpeed = Infinity) {
  const safeSmooth = Math.max(0.0001, smoothTime);
  const omega = 2 / safeSmooth;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

  let change = current - target;
  const maxChange = maxSpeed * safeSmooth;
  change = Math.max(-maxChange, Math.min(maxChange, change));
  const clampedTarget = current - change;

  const temp = (velocity + omega * change) * dt;
  let nextVel = (velocity - omega * temp) * exp;
  let nextPos = clampedTarget + (change + temp) * exp;

  if ((target - current > 0) === (nextPos > target)) {
    nextPos = target;
    nextVel = 0;
  }

  return [nextPos, nextVel];
}

// Shared GLSL interleaved gradient noise (Jimenez 2014) to eliminate 8-bit color banding
const GLSL_DITHER_FN = /* glsl */ `
  float ignDither(vec2 coord) {
    vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
    return fract(magic.z * fract(dot(coord, magic.xy))) - 0.5;
  }
  vec3 dither8Bit(vec3 col, vec2 coord) {
    return max(col + ignDither(coord) / 255.0, 0.0);
  }
`;

// Shared GLSL vertex morph function: (lon, lat, rFrac) -> morphed 2D/3D position centered on view
const GLSL_MORPH_FN = /* glsl */ `
  const float DEG2RAD = 0.017453292519943295;
  const float R_LAND = 1.0;

  vec3 rotateGeo3D(vec3 v, vec2 rotDeg) {
    float phi0 = rotDeg.y * DEG2RAD;
    float cosP0 = cos(phi0);
    float sinP0 = sin(phi0);
    return vec3(
      v.x,
      v.y * cosP0 - v.z * sinP0,
      v.y * sinP0 + v.z * cosP0
    );
  }

  vec3 geoToMorphPos(vec3 geo, float morph, float tileOffsetX, vec2 rotDeg, vec2 pan2D) {
    float lon = geo.x;
    float lat = geo.y;
    float r = geo.z;

    vec3 p2 = vec3(
      (lon / 180.0) * 2.0 + tileOffsetX - pan2D.x,
      (lat / 90.0) * 1.0 - pan2D.y,
      r - R_LAND
    );

    float phi = lat * DEG2RAD;
    float dLam = (lon - rotDeg.x) * DEG2RAD;
    float cosPhi = cos(phi);
    vec3 p3Local = vec3(
      r * cosPhi * sin(dLam),
      r * sin(phi),
      r * cosPhi * cos(dLam)
    );
    vec3 p3 = rotateGeo3D(p3Local, rotDeg);

    return mix(p2, p3, morph);
  }

  vec3 geoToSphereNormal(vec2 lonLat, vec2 rotDeg) {
    float phi = lonLat.y * DEG2RAD;
    float dLam = (lonLat.x - rotDeg.x) * DEG2RAD;
    float cosPhi = cos(phi);
    vec3 nLocal = vec3(cosPhi * sin(dLam), sin(phi), cosPhi * cos(dLam));
    return normalize(rotateGeo3D(nLocal, rotDeg));
  }
`;

function morphPointCPU(lon, lat, rFrac, m, tileOffsetX, rotLon, rotLat, pan2DX, pan2DY, out = new THREE.Vector3()) {
  const x2 = (lon / 180) * 2.0 + tileOffsetX - pan2DX;
  const y2 = (lat / 90) * 1.0 - pan2DY;
  const z2 = rFrac - R_LAND;

  if (m <= 0.0001) {
    return out.set(x2, y2, z2);
  }

  const phi = lat * DEG2RAD;
  const dLam = (lon - rotLon) * DEG2RAD;
  const cosPhi = Math.cos(phi);
  const xa = rFrac * cosPhi * Math.sin(dLam);
  const ya = rFrac * Math.sin(phi);
  const za = rFrac * cosPhi * Math.cos(dLam);

  const phi0 = rotLat * DEG2RAD;
  const cosP0 = Math.cos(phi0);
  const sinP0 = Math.sin(phi0);
  const x3 = xa;
  const y3 = ya * cosP0 - za * sinP0;
  const z3 = ya * sinP0 + za * cosP0;

  if (m >= 0.9999) {
    return out.set(x3, y3, z3);
  }

  return out.set(
    x2 + (x3 - x2) * m,
    y2 + (y3 - y2) * m,
    z2 + (z3 - z2) * m
  );
}

function morphNormalCPU(lon, lat, m, rotLon, rotLat, out = new THREE.Vector3()) {
  if (m <= 0.0001) return out.set(0, 0, 1);
  const phi = lat * DEG2RAD;
  const dLam = (lon - rotLon) * DEG2RAD;
  const cosPhi = Math.cos(phi);
  const xa = cosPhi * Math.sin(dLam);
  const ya = Math.sin(phi);
  const za = cosPhi * Math.cos(dLam);

  const phi0 = rotLat * DEG2RAD;
  const cosP0 = Math.cos(phi0);
  const sinP0 = Math.sin(phi0);
  const nx = xa;
  const ny = ya * cosP0 - za * sinP0;
  const nz = ya * sinP0 + za * cosP0;

  if (m >= 0.9999) return out.set(nx, ny, nz).normalize();
  return out.set(nx * m, ny * m, (1 - m) + nz * m).normalize();
}

export class SeismicMap {
  constructor(canvas, onHover, onClickQuake, onShiftClickMap, onZoomChange) {
    this.canvas = canvas;
    this.onHover = onHover;
    this.onClickQuake = onClickQuake;
    this.onShiftClickMap = onShiftClickMap;
    this.onZoomChange = onZoomChange;

    this.landFeatures = [];
    this.plateFeatures = [];
    this.showPlates = true;
    this.showStars = true;
    this.showMilkyWay = true;

    this.quakes = [];
    this.activeWaves = [];
    this.audioTimeMs = null;
    this.hoveredQuake = null;
    this.selectedQuakeId = null;

    this.width = 0;
    this.height = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cx = 0;
    this.cy = 0;
    this.baseRadius = 200;
    this.bounds = { x: 0, y: 0, w: 0, h: 0 };

    // Map projection mode ('2d' | '3d') & smooth morph state
    this.mapMode = '3d';
    this.morphT = 1;
    this._morphActive = false;
    this._morphStartT = 1;
    this._morphTargetT = 1;
    this._morphStartTime = 0;
    this._morphDuration = 900;

    // 2D Pan, Zoom & 2.5D Tilt state
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.tilt2D = 0; // 0 = top-down, up to ~1.08 rad (~62°) for 2.5D plane inspection
    this.yaw2D = 0;

    // 3D Globe Rotation state
    this.rotLon = 0;
    this.rotLat = 0;

    this.isDragging = false;
    this.dragButton = 0;
    this.dragMoved = false;
    this.lastMouseX = 0;
    this.lastMouseY = 0;
    this.lastUserNavTime = -Infinity;
    this._manualNavHold = false;
    this.autoCenterLon = null;
    this._autoTransitionActive = false;
    this._transStartTime = 0;
    this._transDuration = 300;
    this._transStartZoom = 1;
    this._transStartPanX = 0;
    this._transStartPanY = 0;
    this._transDeltaPanX = 0;
    this._transDeltaPanY = 0;
    this._transStartLon = 0;
    this._transStartLat = 0;
    this._transDeltaLon = 0;
    this._transDeltaLat = 0;

    // Continuous critically-damped auto-follow state
    this._autoFollowActive = false;
    this._autoZoomEnabled = false;
    this._autoFollowTargetLon = 0;
    this._autoFollowTargetLat = 0;
    this._autoFollowTargetZoom = 1;
    this._autoFollowSmoothTime = 1.4;
    this._transTargetZoom = 1;
    this._lastAutoCamTime = null;
    this._camVelLon = 0;
    this._camVelLat = 0;
    this._camVelPanX = 0;
    this._camVelPanY = 0;
    this._camVelZoom = 0;

    this.solarTimeMs = Date.now();

    // Scratch vectors
    this._tmpVec = new THREE.Vector3();
    this._tmpNormal = new THREE.Vector3();
    this._tmpQuat = new THREE.Quaternion();
    this._tmpScale = new THREE.Vector3();
    this._tmpMat = new THREE.Matrix4();
    this._tmpColor = new THREE.Color();
    this._zAxis = new THREE.Vector3(0, 0, 1);
    this._raycaster = new THREE.Raycaster();

    this._initThree();
    this._bindEvents();
    this.resize();
  }

  get radius() {
    return this.baseRadius * this.zoom;
  }

  _initThree() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x05080e, 1);
    this.renderer.sortObjects = true;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.02, 200);

    this._sharedUniforms = {
      uMorph: { value: this.morphT },
      uSunDir: { value: new THREE.Vector3(0, 0, 1) },
      uCamPos: { value: new THREE.Vector3(0, 0, 5) },
      uRot: { value: new THREE.Vector2(0, 0) },
      uPan2D: { value: new THREE.Vector2(0, 0) },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uGmstRotLon: { value: 0 },
      uDpr: { value: 1 },
    };

    // 3 horizontal tile groups (-1, 0, +1) for seamless 2D wrap-around
    this._tileOffsets = [-W_2D, 0, W_2D];
    this._tileGroups = [];
    this._tileUniforms = [];

    for (let t = 0; t < 3; t++) {
      const grp = new THREE.Group();
      this.scene.add(grp);
      this._tileGroups.push(grp);
      this._tileUniforms.push({
        uTileOffsetX: { value: this._tileOffsets[t] },
        uTileAlpha: { value: t === 1 ? 1.0 : 0.0 },
      });
    }

    this._buildMilkyWayLayer();
    this._buildAtmosphereGlow();
    this._buildOceanLayer();
    this._buildGraticuleLayer();
    this._buildSunLight();
    this._buildQuakeDiscLayer();
    this._buildWavePool();
  }

  _buildMilkyWayLayer() {
    const geom = new THREE.SphereGeometry(115, 48, 32);
    this._milkyWayMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      uniforms: {
        uMorph: this._sharedUniforms.uMorph,
        uRot: this._sharedUniforms.uRot,
        uGmstRotLon: this._sharedUniforms.uGmstRotLon,
      },
      vertexShader: /* glsl */ `
        varying vec3 vDirView;
        void main() {
          vDirView = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uMorph;
        uniform vec2 uRot;
        uniform float uGmstRotLon;
        varying vec3 vDirView;
        ${GLSL_DITHER_FN}

        const float DEG2RAD = 0.017453292519943295;

        float hash31(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.yzx + 33.33);
          return fract((p.x + p.y) * p.z);
        }

        float noise3(vec3 x) {
          vec3 i = floor(x);
          vec3 f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(
              mix(hash31(i + vec3(0.0, 0.0, 0.0)), hash31(i + vec3(1.0, 0.0, 0.0)), f.x),
              mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), f.x),
              f.y
            ),
            mix(
              mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), f.x),
              mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0, 1.0, 1.0)), f.x),
              f.y
            ),
            f.z
          );
        }

        float fbm3(vec3 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) {
            v += a * noise3(p);
            p = p * 2.07 + vec3(13.1, 7.7, 5.3);
            a *= 0.5;
          }
          return v;
        }

        void main() {
          float vis = smoothstep(0.02, 0.35, uMorph);
          if (vis < 0.002) discard;

          vec3 dView = normalize(vDirView);

          // Inverse pitch by -rotLat around X
          float phi0 = uRot.y * DEG2RAD;
          float cosP0 = cos(phi0);
          float sinP0 = sin(phi0);
          vec3 dLocal = vec3(
            dView.x,
            dView.y * cosP0 + dView.z * sinP0,
           -dView.y * sinP0 + dView.z * cosP0
          );

          // Geographic view -> J2000 Equatorial Cartesian
          float gRad = uGmstRotLon * DEG2RAD;
          float cosG = cos(gRad);
          float sinG = sin(gRad);
          vec3 eq = vec3(
            dLocal.z * cosG - dLocal.x * sinG,
            dLocal.x * cosG + dLocal.z * sinG,
            dLocal.y
          );

          // Standard IAU J2000 Equatorial -> Galactic Cartesian
          vec3 gal = vec3(
            dot(eq, vec3(-0.0548755604, -0.8734370902, -0.4838350155)),
            dot(eq, vec3( 0.4941094279, -0.4448296300,  0.7469822445)),
            dot(eq, vec3(-0.8676661490, -0.1980763734,  0.4559837762))
          );

          float b = asin(clamp(gal.z, -1.0, 1.0));
          float absB = abs(b);
          float lonCos = clamp(gal.x / max(0.001, length(gal.xy)), -1.0, 1.0);

          // Galactic plane band + core bulge toward Sagittarius (gal.x > 0)
          float band = exp(-absB / 0.175);
          float halo = exp(-(b * b) / 0.095);
          float bulge = pow(max(0.0, lonCos), 2.2) * exp(-(b * b) / 0.055);

          float clouds = fbm3(gal * 5.2);
          float fine = fbm3(gal * 14.0 + vec3(2.4));

          // Great Rift dark dust lane along the galactic equator
          float riftMask = exp(-(b * b) / 0.0055) * smoothstep(-0.2, 0.85, lonCos * 0.7 + gal.y * 0.4);
          float dust = smoothstep(0.36, 0.68, clouds * 0.7 + fine * 0.3) * riftMask;

          float density = (band * (0.52 + 0.78 * clouds) + halo * 0.30 + bulge * 0.90) * (1.0 - 0.72 * dust);
          density *= smoothstep(0.06, 0.92, band + halo * 0.5);

          vec3 colOuter = vec3(0.14, 0.22, 0.38);
          vec3 colCore = vec3(0.42, 0.36, 0.31);
          vec3 col = mix(colOuter, colCore, clamp(bulge * 0.85, 0.0, 1.0));
          col *= density * 0.42 * vis;

          if (dot(col, vec3(1.0)) < 0.001) discard;
          col = dither8Bit(col, gl_FragCoord.xy);
          gl_FragColor = vec4(col, clamp(density * 0.95 * vis, 0.0, 1.0));
        }
      `,
    });

    this._milkyWayMesh = new THREE.Mesh(geom, this._milkyWayMat);
    this._milkyWayMesh.renderOrder = -2;
    this._milkyWayMesh.frustumCulled = false;
    this._milkyWayMesh.visible = this.showMilkyWay;
    this.scene.add(this._milkyWayMesh);
  }

  _buildStarfieldLayer(stars) {
    if (!Array.isArray(stars) || !stars.length) return;
    if (this._starMesh) {
      this.scene.remove(this._starMesh);
      this._starMesh.geometry.dispose();
      this._starMat.dispose();
    }

    const count = stars.length;
    const positions = new Float32Array(count * 3);
    const aRaDec = new Float32Array(count * 2);
    const aMagBv = new Float32Array(count * 2);

    for (let i = 0; i < count; i++) {
      const [raDeg, decDeg, vmag, bv] = stars[i];
      positions[i * 3] = 0;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = 0;
      aRaDec[i * 2] = raDeg;
      aRaDec[i * 2 + 1] = decDeg;
      aMagBv[i * 2] = vmag;
      aMagBv[i * 2 + 1] = bv;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aRaDec', new THREE.BufferAttribute(aRaDec, 2));
    geom.setAttribute('aMagBv', new THREE.BufferAttribute(aMagBv, 2));

    this._starMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uMorph: this._sharedUniforms.uMorph,
        uRot: this._sharedUniforms.uRot,
        uCamPos: this._sharedUniforms.uCamPos,
        uResolution: this._sharedUniforms.uResolution,
        uGmstRotLon: this._sharedUniforms.uGmstRotLon,
        uDpr: this._sharedUniforms.uDpr,
      },
      vertexShader: /* glsl */ `
        attribute vec2 aRaDec;
        attribute vec2 aMagBv;
        uniform float uMorph;
        uniform vec2 uRot;
        uniform vec3 uCamPos;
        uniform vec2 uResolution;
        uniform float uGmstRotLon;
        uniform float uDpr;
        varying float vAlpha;
        varying vec3 vColor;

        const float DEG2RAD = 0.017453292519943295;

        vec3 bvToRgb(float bv) {
          float t = clamp((bv + 0.35) / 2.25, 0.0, 1.0);
          vec3 blue = vec3(0.68, 0.80, 1.00);
          vec3 white = vec3(0.96, 0.97, 1.00);
          vec3 gold = vec3(1.00, 0.87, 0.68);
          vec3 orange = vec3(1.00, 0.68, 0.45);
          if (t < 0.32) return mix(blue, white, t / 0.32);
          if (t < 0.66) return mix(white, gold, (t - 0.32) / 0.34);
          return mix(gold, orange, (t - 0.66) / 0.34);
        }

        void main() {
          float phi = aRaDec.y * DEG2RAD;
          float dLam = (aRaDec.x - uGmstRotLon) * DEG2RAD;
          float cosPhi = cos(phi);
          vec3 dLocal = vec3(cosPhi * sin(dLam), sin(phi), cosPhi * cos(dLam));

          float phi0 = uRot.y * DEG2RAD;
          float cosP0 = cos(phi0);
          float sinP0 = sin(phi0);
          vec3 dView = vec3(
            dLocal.x,
            dLocal.y * cosP0 - dLocal.z * sinP0,
            dLocal.y * sinP0 + dLocal.z * cosP0
          );

          vec4 mvPos = modelViewMatrix * vec4(uCamPos + dView * 100.0, 1.0);
          gl_Position = projectionMatrix * mvPos;

          float mag = aMagBv.x;
          float flux = pow(2.511886, clamp(1.5 - mag, -5.5, 3.0));
          float resScale = max(0.85, (uResolution.y * uDpr) / 1080.0);

          gl_PointSize = clamp((1.65 + 2.8 * clamp((6.5 - mag) / 7.5, 0.0, 1.0)) * resScale, 1.4, 8.5 * resScale);
          vAlpha = clamp(0.24 + 0.78 * sqrt(flux * 0.68), 0.18, 0.98) * smoothstep(0.02, 0.35, uMorph);
          vColor = bvToRgb(aMagBv.y);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          if (vAlpha < 0.01) discard;
          vec2 uv = gl_PointCoord - 0.5;
          float r2 = dot(uv, uv) * 4.0;
          if (r2 > 1.0) discard;
          float core = exp(-r2 * 4.2);
          float halo = exp(-r2 * 1.6) * 0.35;
          float intensity = (core + halo) * vAlpha;
          gl_FragColor = vec4(vColor * intensity, intensity);
        }
      `,
    });

    this._starMesh = new THREE.Points(geom, this._starMat);
    this._starMesh.renderOrder = -1;
    this._starMesh.frustumCulled = false;
    this._starMesh.visible = this.showStars;
    this.scene.add(this._starMesh);
  }

  _buildAtmosphereGlow() {
    const geom = new THREE.PlaneGeometry(2.6, 2.6);
    this._atmoMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uMorph: this._sharedUniforms.uMorph,
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uMorph;
        varying vec2 vUv;
        ${GLSL_DITHER_FN}
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          float rim = smoothstep(0.58, 0.77, d) * (1.0 - smoothstep(0.77, 1.0, d));
          float alpha = rim * 0.24 * uMorph;
          if (alpha < 0.002) discard;
          alpha = max(alpha + ignDither(gl_FragCoord.xy) / 255.0, 0.0);
          gl_FragColor = vec4(0.22, 0.74, 0.97, alpha);
        }
      `,
    });
    this._atmoMesh = new THREE.Mesh(geom, this._atmoMat);
    this._atmoMesh.renderOrder = 0;
    this.scene.add(this._atmoMesh);
  }

  _buildOceanLayer() {
    const segLon = 128;
    const segLat = 64;
    const positions = [];
    const geos = [];
    const indices = [];

    for (let j = 0; j <= segLat; j++) {
      const lat = -90 + (j / segLat) * 180;
      for (let i = 0; i <= segLon; i++) {
        const lon = -180 + (i / segLon) * 360;
        positions.push(0, 0, 0);
        geos.push(lon, lat, R_OCEAN);
      }
    }

    const row = segLon + 1;
    for (let j = 0; j < segLat; j++) {
      for (let i = 0; i < segLon; i++) {
        const a = j * row + i;
        const b = a + 1;
        const c = a + row;
        const d = c + 1;
        indices.push(a, b, d, a, d, c);
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('aGeo', new THREE.Float32BufferAttribute(geos, 3));
    geom.setIndex(indices);

    for (let t = 0; t < 3; t++) {
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: true,
        side: THREE.DoubleSide,
        uniforms: {
          uMorph: this._sharedUniforms.uMorph,
          uSunDir: this._sharedUniforms.uSunDir,
          uCamPos: this._sharedUniforms.uCamPos,
          uRot: this._sharedUniforms.uRot,
          uPan2D: this._sharedUniforms.uPan2D,
          uTileOffsetX: this._tileUniforms[t].uTileOffsetX,
          uTileAlpha: this._tileUniforms[t].uTileAlpha,
        },
        vertexShader: /* glsl */ `
          attribute vec3 aGeo;
          uniform float uMorph;
          uniform float uTileOffsetX;
          uniform vec2 uRot;
          uniform vec2 uPan2D;
          varying vec3 vSphereNormal;
          varying vec3 vWorldPos;
          ${GLSL_MORPH_FN}
          void main() {
            vec3 pos = geoToMorphPos(aGeo, uMorph, uTileOffsetX, uRot, uPan2D);
            vSphereNormal = geoToSphereNormal(aGeo.xy, uRot);
            vec4 wp = modelMatrix * vec4(pos, 1.0);
            vWorldPos = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uMorph;
          uniform vec3 uSunDir;
          uniform vec3 uCamPos;
          uniform float uTileAlpha;
          varying vec3 vSphereNormal;
          varying vec3 vWorldPos;
          ${GLSL_DITHER_FN}

          void main() {
            if (uTileAlpha < 0.01) discard;
            vec3 n = normalize(vSphereNormal);
            vec3 viewDir = normalize(uCamPos - vWorldPos);
            float ndotv = clamp(dot(n, viewDir), 0.0, 1.0);

            // Deep abyssal ocean base
            vec3 base3D = mix(vec3(0.016, 0.027, 0.051), vec3(0.047, 0.082, 0.141), pow(ndotv, 0.65));
            vec3 base2D = vec3(0.024, 0.036, 0.062);
            vec3 col = mix(base2D, base3D, uMorph);

            // Real-time solar illumination
            vec3 sunDirN = normalize(uSunDir);
            float sunDot = dot(n, sunDirN);
            float dayFactor = clamp((sunDot + 0.08) / 1.08, 0.0, 1.0);

            col += vec3(0.14, 0.23, 0.36) * pow(dayFactor, 1.15) * 0.55;

            // Solar specular glint on the ocean:
            // In 2D mode, center on the true subsolar point (sunDirN) rather than
            // mixing globe-rotated sunDirN with 2D camera-space viewDir;
            // in 3D mode, use standard Blinn-Phong reflection toward the camera.
            vec3 sumVec = sunDirN + viewDir;
            vec3 halfVec3D = length(sumVec) > 0.0001 ? normalize(sumVec) : n;
            vec3 halfVec = normalize(mix(sunDirN, halfVec3D, uMorph));
            float specBroad = pow(max(dot(n, halfVec), 0.0), 28.0) * smoothstep(-0.05, 0.25, sunDot);
            float specTight = pow(max(dot(n, halfVec), 0.0), 160.0) * smoothstep(0.0, 0.2, sunDot);
            col += vec3(1.0, 0.88, 0.65) * (specBroad * 0.18 + specTight * 0.45);

            // 3D horizon rim (brighter on sunlit limb)
            float rim = pow(1.0 - ndotv, 3.2) * uMorph;
            col += vec3(0.12, 0.35, 0.55) * rim * (0.15 + 0.35 * dayFactor);

            col = dither8Bit(col, gl_FragCoord.xy);
            gl_FragColor = vec4(col, uTileAlpha);
          }
        `,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = 1;
      mesh.frustumCulled = false;
      this._tileGroups[t].add(mesh);
    }
  }

  _buildGraticuleLayer() {
    const geos = [];
    const isEq = [];

    for (let lon = -180; lon <= 180; lon += 30) {
      for (let lat = -90; lat < 90; lat += 5) {
        geos.push(lon, lat, R_OCEAN + 0.0012, lon, lat + 5, R_OCEAN + 0.0012);
        isEq.push(0, 0);
      }
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const eq = lat === 0 ? 1 : 0;
      for (let lon = -180; lon < 180; lon += 5) {
        geos.push(lon, lat, R_OCEAN + 0.0012, lon + 5, lat, R_OCEAN + 0.0012);
        isEq.push(eq, eq);
      }
    }

    const pos = new Float32Array((geos.length / 3) * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('aGeo', new THREE.Float32BufferAttribute(geos, 3));
    geom.setAttribute('aEq', new THREE.Float32BufferAttribute(isEq, 1));

    for (let t = 0; t < 3; t++) {
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          uMorph: this._sharedUniforms.uMorph,
          uRot: this._sharedUniforms.uRot,
          uPan2D: this._sharedUniforms.uPan2D,
          uTileOffsetX: this._tileUniforms[t].uTileOffsetX,
          uTileAlpha: this._tileUniforms[t].uTileAlpha,
        },
        vertexShader: /* glsl */ `
          attribute vec3 aGeo;
          attribute float aEq;
          uniform float uMorph;
          uniform float uTileOffsetX;
          uniform vec2 uRot;
          uniform vec2 uPan2D;
          varying float vEq;
          ${GLSL_MORPH_FN}
          void main() {
            vEq = aEq;
            vec3 p = geoToMorphPos(aGeo, uMorph, uTileOffsetX, uRot, uPan2D);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTileAlpha;
          varying float vEq;
          void main() {
            if (uTileAlpha < 0.01) discard;
            float a = (vEq > 0.5 ? 0.14 : 0.065) * uTileAlpha;
            gl_FragColor = vec4(0.58, 0.64, 0.72, a);
          }
        `,
      });
      const lines = new THREE.LineSegments(geom, mat);
      lines.renderOrder = 2;
      lines.frustumCulled = false;
      this._tileGroups[t].add(lines);
    }
  }

  _buildSunLight() {
    this._sunLight = new THREE.DirectionalLight(0xfff4d6, 1.0);
    this._sunLight.position.set(0, 0, 50);
    this._sunLight.target.position.set(0, 0, 0);
    this.scene.add(this._sunLight);
    this.scene.add(this._sunLight.target);

    // Visible distant Sun orb + additive corona anchored at the light source
    const orbGeom = new THREE.SphereGeometry(0.42, 32, 24);
    const orbMat = new THREE.MeshBasicMaterial({
      color: 0xfff8e1,
      depthWrite: true,
      depthTest: true,
    });
    this._sunOrb = new THREE.Mesh(orbGeom, orbMat);
    this._sunOrb.renderOrder = 3;
    this._sunLight.add(this._sunOrb);

    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const ctx = c.getContext('2d');
    const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255, 248, 220, 0.95)');
    grad.addColorStop(0.22, 'rgba(255, 220, 140, 0.55)');
    grad.addColorStop(0.55, 'rgba(255, 175, 70, 0.16)');
    grad.addColorStop(1, 'rgba(255, 150, 40, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);

    this._sunCoronaTex = new THREE.CanvasTexture(c);
    const coronaMat = new THREE.SpriteMaterial({
      map: this._sunCoronaTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });
    this._sunCorona = new THREE.Sprite(coronaMat);
    this._sunCorona.renderOrder = 3;
    this._sunLight.add(this._sunCorona);
  }

  _buildPlateLayer() {
    if (!this.plateFeatures.length) return;

    const splitAntimeridian = (coords) => {
      const chains = [];
      let cur = [];
      for (let i = 0; i < coords.length; i++) {
        const pt = coords[i];
        if (cur.length > 0 && Math.abs(pt[0] - cur[cur.length - 1][0]) > 180) {
          if (cur.length >= 2) chains.push(cur);
          cur = [pt];
        } else {
          cur.push(pt);
        }
      }
      if (cur.length >= 2) chains.push(cur);
      return chains;
    };

    const rdpSimplify = (pts, epsilon) => {
      if (pts.length <= 2) return pts;
      const keep = new Uint8Array(pts.length);
      keep[0] = 1;
      keep[pts.length - 1] = 1;
      const stack = [[0, pts.length - 1]];
      while (stack.length) {
        const [start, end] = stack.pop();
        if (end - start <= 1) continue;
        const [ax, ay] = pts[start];
        const [bx, by] = pts[end];
        const dx = bx - ax;
        const dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        let maxDist = 0;
        let maxIdx = -1;
        for (let i = start + 1; i < end; i++) {
          const [px, py] = pts[i];
          let dist;
          if (lenSq < 1e-12) {
            dist = Math.hypot(px - ax, py - ay);
          } else {
            const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
            dist = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
          }
          if (dist > maxDist) {
            maxDist = dist;
            maxIdx = i;
          }
        }
        if (maxDist > epsilon && maxIdx !== -1) {
          keep[maxIdx] = 1;
          stack.push([start, maxIdx], [maxIdx, end]);
        }
      }
      const out = [];
      for (let i = 0; i < pts.length; i++) {
        if (keep[i]) out.push(pts[i]);
      }
      return out;
    };

    const chaikinSmooth = (pts, iterations) => {
      if (pts.length <= 2) return pts;
      const first = pts[0];
      const last = pts[pts.length - 1];
      const isClosed = Math.hypot(last[0] - first[0], last[1] - first[1]) < 1e-4;
      let cur = pts;
      for (let it = 0; it < iterations; it++) {
        const next = [];
        if (isClosed) {
          const n = cur.length - 1;
          for (let i = 0; i < n; i++) {
            const p0 = cur[i];
            const p1 = cur[(i + 1) % n];
            next.push([p0[0] * 0.75 + p1[0] * 0.25, p0[1] * 0.75 + p1[1] * 0.25]);
            next.push([p0[0] * 0.25 + p1[0] * 0.75, p0[1] * 0.25 + p1[1] * 0.75]);
          }
          next.push([next[0][0], next[0][1]]);
        } else {
          // Pin endpoints so adjacent plate boundaries meet cleanly at junctions
          next.push(cur[0]);
          for (let i = 0; i < cur.length - 1; i++) {
            const p0 = cur[i];
            const p1 = cur[i + 1];
            next.push([p0[0] * 0.75 + p1[0] * 0.25, p0[1] * 0.75 + p1[1] * 0.25]);
            next.push([p0[0] * 0.25 + p1[0] * 0.75, p0[1] * 0.25 + p1[1] * 0.75]);
          }
          next.push(cur[cur.length - 1]);
        }
        cur = next;
      }
      return cur;
    };

    const subdivideChain = (pts, maxStepDeg) => {
      const out = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const [lon0, lat0] = pts[i];
        const [lon1, lat1] = pts[i + 1];
        const steps = Math.max(1, Math.ceil(Math.hypot(lon1 - lon0, lat1 - lat0) / maxStepDeg));
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          out.push([lon0 + (lon1 - lon0) * t, lat0 + (lat1 - lat0) * t]);
        }
      }
      return out;
    };

    const geos = [];
    const acrossArr = [];
    const alongArr = [];
    const tArr = [];
    const typeArr = [];
    const indices = [];
    let vertOffset = 0;

    const TYPE_CODE = {
      subduction: 0,
      divergent: 1,
      transform: 2,
      collision: 3,
    };

    const pushStrip = (pts, bType, overSideSign) => {
      const n = pts.length;
      if (n < 2) return;

      const cumDist = new Float32Array(n);
      for (let i = 1; i < n; i++) {
        const cosLat = Math.max(0.2, Math.cos(((pts[i][1] + pts[i - 1][1]) * 0.5) * DEG2RAD));
        const dl = (pts[i][0] - pts[i - 1][0]) * cosLat;
        const dp = pts[i][1] - pts[i - 1][1];
        cumDist[i] = cumDist[i - 1] + Math.hypot(dl, dp);
      }
      const totalDist = Math.max(cumDist[n - 1], 1e-4);

      // Slim architectural profiles anchored on the blue ocean globe (R_OCEAN):
      // Subduction: trench at R_OCEAN+0.003, overriding side rises gently to R_OCEAN+0.015
      // Collision: uplifted ridge peaking at R_OCEAN+0.018 with skirts at R_OCEAN+0.002
      // Divergent: recessed rift at R_OCEAN+0.002 with rims at R_OCEAN+0.006
      // Transform: flush dashed shear line at R_OCEAN+0.003
      let profile;
      if (bType === 0) {
        profile = [
          [-0.18 * overSideSign, R_OCEAN + 0.002, -0.15],
          [0.0, R_OCEAN + 0.003, 0.0],
          [0.65 * overSideSign, R_OCEAN + 0.009, 0.5],
          [1.3 * overSideSign, R_OCEAN + 0.015, 1.0],
        ];
      } else if (bType === 3) {
        profile = [
          [-0.32, R_OCEAN + 0.002, -1.0],
          [0.0, R_OCEAN + 0.018, 0.0],
          [0.32, R_OCEAN + 0.002, 1.0],
        ];
      } else if (bType === 1) {
        profile = [
          [-0.28, R_OCEAN + 0.006, -1.0],
          [0.0, R_OCEAN + 0.002, 0.0],
          [0.28, R_OCEAN + 0.006, 1.0],
        ];
      } else {
        profile = [
          [-0.24, R_OCEAN + 0.003, -1.0],
          [0.0, R_OCEAN + 0.003, 0.0],
          [0.24, R_OCEAN + 0.003, 1.0],
        ];
      }

      const cols = profile.length;
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const pPrev = pts[Math.max(0, i - 1)];
        const pNext = pts[Math.min(n - 1, i + 1)];

        const cosLat = Math.max(0.2, Math.cos(p[1] * DEG2RAD));
        const tx = (pNext[0] - pPrev[0]) * cosLat;
        const ty = pNext[1] - pPrev[1];
        const tLen = Math.hypot(tx, ty) || 1;
        const nLon = (-ty / tLen) / cosLat;
        const nLat = tx / tLen;
        const tNorm = cumDist[i] / totalDist;

        for (let c = 0; c < cols; c++) {
          const [offDeg, rad, across] = profile[c];
          const lon = p[0] + nLon * offDeg;
          const lat = Math.max(-89.5, Math.min(89.5, p[1] + nLat * offDeg));
          geos.push(lon, lat, rad);
          acrossArr.push(across);
          alongArr.push(cumDist[i]);
          tArr.push(tNorm);
          typeArr.push(bType);
        }

        if (i < n - 1) {
          const row0 = vertOffset + i * cols;
          const row1 = row0 + cols;
          for (let c = 0; c < cols - 1; c++) {
            indices.push(row0 + c, row0 + c + 1, row1 + c);
            indices.push(row0 + c + 1, row1 + c + 1, row1 + c);
          }
        }
      }
      vertOffset += n * cols;
    };

    for (const feature of this.plateFeatures) {
      const geom = feature.geometry;
      if (!geom) continue;
      const props = feature.properties || {};
      const bType = TYPE_CODE[props.Type] ?? 2;
      const overSideSign = props.OverridingSide === 'right' ? -1 : 1;

      const lines = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;
      for (const line of lines) {
        const chains = splitAntimeridian(line);
        for (const rawChain of chains) {
          const simplified = rdpSimplify(rawChain, 0.8);
          const smoothed = chaikinSmooth(simplified, 3);
          const pts = subdivideChain(smoothed, 2.5);
          pushStrip(pts, bType, overSideSign);
        }
      }
    }

    if (vertOffset === 0) return;

    const pos = new Float32Array((geos.length / 3) * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('aGeo', new THREE.Float32BufferAttribute(geos, 3));
    geom.setAttribute('aAcross', new THREE.Float32BufferAttribute(acrossArr, 1));
    geom.setAttribute('aAlong', new THREE.Float32BufferAttribute(alongArr, 1));
    geom.setAttribute('aT', new THREE.Float32BufferAttribute(tArr, 1));
    geom.setAttribute('aType', new THREE.Float32BufferAttribute(typeArr, 1));
    geom.setIndex(indices);

    this._plateMeshes = [];
    for (let t = 0; t < 3; t++) {
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          uMorph: this._sharedUniforms.uMorph,
          uRot: this._sharedUniforms.uRot,
          uPan2D: this._sharedUniforms.uPan2D,
          uTileOffsetX: this._tileUniforms[t].uTileOffsetX,
          uTileAlpha: this._tileUniforms[t].uTileAlpha,
        },
        vertexShader: /* glsl */ `
          attribute vec3 aGeo;
          attribute float aAcross;
          attribute float aAlong;
          attribute float aT;
          attribute float aType;
          uniform float uMorph;
          uniform float uTileOffsetX;
          uniform vec2 uRot;
          uniform vec2 uPan2D;
          varying float vAcross;
          varying float vAlong;
          varying float vT;
          varying float vType;
          ${GLSL_MORPH_FN}
          void main() {
            vec3 p = geoToMorphPos(aGeo, uMorph, uTileOffsetX, uRot, uPan2D);
            vAcross = aAcross;
            vAlong = aAlong;
            vT = aT;
            vType = aType;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTileAlpha;
          varying float vAcross;
          varying float vAlong;
          varying float vT;
          varying float vType;
          void main() {
            if (uTileAlpha < 0.01) discard;

            float endFade = smoothstep(0.0, 0.05, vT) * smoothstep(1.0, 0.95, vT);
            vec3 col;
            float alpha;

            if (vType < 0.5) {
              // Subduction: crisp trench line + subtle translucent dipping slab veil
              float trench = smoothstep(0.16, 0.0, abs(vAcross));
              float slabMask = smoothstep(-0.05, 0.08, vAcross) * smoothstep(1.0, 0.08, vAcross);
              vec3 trenchCol = vec3(0.92, 0.45, 0.98);
              vec3 slabCol = vec3(0.54, 0.20, 0.86);
              col = mix(slabCol, trenchCol, trench);
              alpha = (slabMask * 0.16 * endFade + trench * 0.55) * uTileAlpha;
            } else if (vType < 1.5) {
              // Divergent: slim cyan-teal recessed line
              float d = abs(vAcross);
              float core = smoothstep(0.45, 0.0, d);
              float halo = smoothstep(1.0, 0.2, d);
              col = mix(vec3(0.12, 0.72, 0.72), vec3(0.45, 0.96, 0.90), core);
              alpha = (halo * 0.14 + core * 0.48) * uTileAlpha;
            } else if (vType < 2.5) {
              // Transform: slim amber-gold dashed shear line
              float d = abs(vAcross);
              float core = smoothstep(0.6, 0.0, d);
              float dash = smoothstep(0.3, 0.65, sin(vAlong * 3.6) * 0.5 + 0.5);
              col = mix(vec3(0.86, 0.60, 0.14), vec3(1.0, 0.82, 0.36), core);
              alpha = core * (0.14 + 0.44 * dash) * uTileAlpha;
            } else {
              // Collision: slim crimson-orange uplifted crest
              float d = abs(vAcross);
              float crest = smoothstep(0.42, 0.0, d);
              float flank = smoothstep(1.0, 0.2, d);
              col = mix(vec3(0.88, 0.26, 0.22), vec3(1.0, 0.56, 0.32), crest);
              alpha = (flank * 0.14 + crest * 0.52) * uTileAlpha;
            }

            gl_FragColor = vec4(col, alpha);
          }
        `,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = 3;
      mesh.frustumCulled = false;
      mesh.visible = this.showPlates;
      this._tileGroups[t].add(mesh);
      this._plateMeshes.push(mesh);
    }
  }

  _buildLandLayer() {
    if (!this.landFeatures.length) return;

    const fillGeos = [];
    const edgeGeos = [];

    for (const feature of this.landFeatures) {
      const geom = feature.geometry;
      if (!geom) continue;
      const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
      for (const poly of polys) {
        const tris = triangulateGeoPolygon(poly, 6.0);
        for (let i = 0; i < tris.length; i += 2) {
          fillGeos.push(tris[i], tris[i + 1], R_LAND);
        }

        // Coastline outline (subdivided for smooth 3D curvature)
        for (const ring of poly) {
          for (let i = 0; i < ring.length; i++) {
            const [lon0, lat0] = ring[i];
            const [lon1, lat1] = ring[(i + 1) % ring.length];
            if (Math.abs(lon1 - lon0) > 180) continue;
            const steps = Math.max(1, Math.ceil(Math.hypot(lon1 - lon0, lat1 - lat0) / 5));
            for (let s = 0; s < steps; s++) {
              const t0 = s / steps;
              const t1 = (s + 1) / steps;
              edgeGeos.push(
                lon0 + (lon1 - lon0) * t0,
                lat0 + (lat1 - lat0) * t0,
                R_LAND + 0.0015,
                lon0 + (lon1 - lon0) * t1,
                lat0 + (lat1 - lat0) * t1,
                R_LAND + 0.0015
              );
            }
          }
        }
      }
    }

    const fillGeom = new THREE.BufferGeometry();
    fillGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(fillGeos.length), 3));
    fillGeom.setAttribute('aGeo', new THREE.Float32BufferAttribute(fillGeos, 3));

    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(edgeGeos.length), 3));
    edgeGeom.setAttribute('aGeo', new THREE.Float32BufferAttribute(edgeGeos, 3));

    for (let t = 0; t < 3; t++) {
      // Top layer: Frosted / tinted glass look (~0.55 opacity)
      const fillMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        uniforms: {
          uMorph: this._sharedUniforms.uMorph,
          uSunDir: this._sharedUniforms.uSunDir,
          uCamPos: this._sharedUniforms.uCamPos,
          uRot: this._sharedUniforms.uRot,
          uPan2D: this._sharedUniforms.uPan2D,
          uTileOffsetX: this._tileUniforms[t].uTileOffsetX,
          uTileAlpha: this._tileUniforms[t].uTileAlpha,
        },
        vertexShader: /* glsl */ `
          attribute vec3 aGeo;
          uniform float uMorph;
          uniform float uTileOffsetX;
          uniform vec2 uRot;
          uniform vec2 uPan2D;
          varying vec3 vNormal;
          varying vec3 vWorldPos;
          ${GLSL_MORPH_FN}
          void main() {
            vec3 pos = geoToMorphPos(aGeo, uMorph, uTileOffsetX, uRot, uPan2D);
            vec3 n3 = geoToSphereNormal(aGeo.xy, uRot);
            vNormal = normalize(mix(vec3(0.0, 0.0, 1.0), n3, uMorph));
            vec4 wp = modelMatrix * vec4(pos, 1.0);
            vWorldPos = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uSunDir;
          uniform vec3 uCamPos;
          uniform float uTileAlpha;
          varying vec3 vNormal;
          varying vec3 vWorldPos;
          ${GLSL_DITHER_FN}
          void main() {
            if (uTileAlpha < 0.01) discard;
            vec3 n = normalize(vNormal);
            vec3 viewDir = normalize(uCamPos - vWorldPos);
            float ndotv = abs(dot(n, viewDir));
            float fresnel = pow(1.0 - clamp(ndotv, 0.0, 1.0), 2.2);

            // Frosted forest-green glass tint + subtle solar & rim frost
            vec3 glassBase = vec3(0.065, 0.195, 0.115);
            vec3 frostHighlight = vec3(0.18, 0.46, 0.28);
            float sunDot = clamp(dot(n, normalize(uSunDir)), 0.0, 1.0);
            vec3 col = mix(glassBase, frostHighlight, fresnel * 0.42 + sunDot * 0.14);

            float alpha = clamp(0.52 + fresnel * 0.16, 0.48, 0.68) * uTileAlpha;
            col = dither8Bit(col, gl_FragCoord.xy);
            gl_FragColor = vec4(col, alpha);
          }
        `,
      });
      const fillMesh = new THREE.Mesh(fillGeom, fillMat);
      fillMesh.renderOrder = 20;
      fillMesh.frustumCulled = false;
      this._tileGroups[t].add(fillMesh);

      // Subtle coastline glow
      const edgeMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uMorph: this._sharedUniforms.uMorph,
          uRot: this._sharedUniforms.uRot,
          uPan2D: this._sharedUniforms.uPan2D,
          uTileOffsetX: this._tileUniforms[t].uTileOffsetX,
          uTileAlpha: this._tileUniforms[t].uTileAlpha,
        },
        vertexShader: /* glsl */ `
          attribute vec3 aGeo;
          uniform float uMorph;
          uniform float uTileOffsetX;
          uniform vec2 uRot;
          uniform vec2 uPan2D;
          ${GLSL_MORPH_FN}
          void main() {
            vec3 p = geoToMorphPos(aGeo, uMorph, uTileOffsetX, uRot, uPan2D);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTileAlpha;
          void main() {
            if (uTileAlpha < 0.01) discard;
            gl_FragColor = vec4(0.24, 0.68, 0.42, 0.42 * uTileAlpha);
          }
        `,
      });
      const edgeLines = new THREE.LineSegments(edgeGeom, edgeMat);
      edgeLines.renderOrder = 21;
      edgeLines.frustumCulled = false;
      this._tileGroups[t].add(edgeLines);
    }
  }

  _buildQuakeDiscLayer() {
    this._maxDiscCapacity = 4096;
    const discGeo = new THREE.CircleGeometry(1, 28);
    this._discMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });
    this._discMesh = new THREE.InstancedMesh(discGeo, this._discMat, this._maxDiscCapacity);
    this._discMesh.count = 0;
    this._discMesh.renderOrder = 10;
    this._discMesh.frustumCulled = false;
    this.scene.add(this._discMesh);

    // Crisp white selection/hover ring for active/selected/hovered quake
    const ringGeo = new THREE.RingGeometry(0.88, 1.12, 36);
    this._selRingMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });
    this._selRingMeshes = [];
    for (let t = 0; t < 3; t++) {
      const m = new THREE.Mesh(ringGeo, this._selRingMat);
      m.visible = false;
      m.renderOrder = 11;
      this.scene.add(m);
      this._selRingMeshes.push(m);
    }
  }

  _buildWavePool() {
    this._waveSegments = 64;
    this._rippleRadialSegments = 12;
    this._wavePool = [];
    this._ripplePool = [];
  }

  _getPooledRippleMesh(idx) {
    while (this._ripplePool.length <= idx) {
      const segs = this._waveSegments;
      const radialSegs = this._rippleRadialSegments;
      const ringStride = radialSegs + 1;
      const vertCount = (segs + 1) * ringStride;
      const pts = new Float32Array(vertCount * 3);
      const uvs = new Float32Array(vertCount * 2);
      const indices = [];

      for (let s = 0; s <= segs; s++) {
        const u = s / segs;
        for (let r = 0; r <= radialSegs; r++) {
          const v = r / radialSegs;
          const vIdx = s * ringStride + r;
          uvs[vIdx * 2] = u;
          uvs[vIdx * 2 + 1] = v;

          if (s < segs && r < radialSegs) {
            const a = s * ringStride + r;
            const b = a + 1;
            const c = a + ringStride;
            const d = c + 1;
            indices.push(a, b, c, b, d, c);
          }
        }
      }

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      geom.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3));
      geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geom.setIndex(indices);

      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(0xff6b35) },
          uAlpha: { value: 0 },
          uPhase: { value: 0 },
          uProgress: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        blending: THREE.NormalBlending,
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          varying vec3 vViewNormal;
          varying vec3 vViewDir;
          void main() {
            vUv = uv;
            vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
            float nLen = length(normal);
            vec3 safeN = nLen > 1e-5 ? normal / nLen : vec3(0.0, 0.0, 1.0);
            vViewNormal = normalize(normalMatrix * safeN);
            vViewDir = normalize(-mvPos.xyz);
            gl_Position = projectionMatrix * mvPos;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          uniform float uAlpha;
          uniform float uPhase;
          uniform float uProgress;
          varying vec2 vUv;
          varying vec3 vViewNormal;
          varying vec3 vViewDir;

          void main() {
            // Feather outer boundary where the soap bubble meets the event depth disc
            float outerFade = smoothstep(1.0, 0.90, vUv.y);

            // Soap-bubble Fresnel rim: transparent center, luminous grazing walls
            float ndotv = abs(dot(normalize(vViewNormal), normalize(vViewDir)));
            float fresnel = pow(1.0 - ndotv, 2.2);

            // Subtle thin-film iridescence + concentric rim band
            float filmPhase = (1.0 - ndotv) * 7.5 + vUv.y * 3.0 + vUv.x * 12.56637 + uPhase - uProgress * 3.5;
            vec3 irid = 0.5 + 0.5 * cos(filmPhase + vec3(0.0, 2.094, 4.188));
            float rimBand = smoothstep(0.55, 0.93, vUv.y) * smoothstep(1.0, 0.94, vUv.y);
            float shimmer = 0.88 + 0.12 * sin(vUv.x * 12.56637 + uPhase - uProgress * 4.0);

            float body = (0.08 + 0.68 * fresnel + 0.34 * rimBand) * outerFade;
            float alpha = clamp(body * uAlpha * shimmer, 0.0, 0.44);
            if (alpha < 0.003) discard;

            vec3 bubbleTint = mix(uColor, irid, 0.42 * fresnel + 0.12);
            vec3 spec = vec3(0.85, 0.96, 1.0) * (pow(fresnel, 3.5) * 0.55);
            vec3 col = bubbleTint + spec;
            gl_FragColor = vec4(col, alpha);
          }
        `,
      });

      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = 11;
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.scene.add(mesh);
      this._ripplePool.push(mesh);
    }
    return this._ripplePool[idx];
  }

  _getPooledWaveLine(idx) {
    while (this._wavePool.length <= idx) {
      const pts = new Float32Array((this._waveSegments + 1) * 3);
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      const mat = new THREE.LineBasicMaterial({
        color: 0xff6b35,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
      });
      const line = new THREE.Line(geom, mat);
      line.renderOrder = 12;
      line.frustumCulled = false;
      line.visible = false;
      this.scene.add(line);
      this._wavePool.push(line);
    }
    return this._wavePool[idx];
  }

  setMapMode(mode, { animate = true } = {}) {
    const nextMode = mode === '2d' ? '2d' : '3d';
    if (nextMode === this.mapMode && !this._morphActive && animate) return;

    const prevMode = this.mapMode;
    this.mapMode = nextMode;
    this._autoTransitionActive = false;
    this._autoFollowActive = false;
    this._resetAutoCameraVelocities();

    if (nextMode === '3d' && prevMode === '2d') {
      const [centerLon, centerLat] = this._unproject2D(this.cx, this.cy);
      this.rotLon = centerLon;
      this.rotLat = Math.max(-85, Math.min(85, centerLat));
      this.zoom = Math.max(1, Math.min(10, this.zoom));
      this.onZoomChange?.(this.zoom);
    } else if (nextMode === '2d' && prevMode === '3d') {
      this.zoom = Math.max(1, Math.min(12, this.zoom));
      this.onZoomChange?.(this.zoom);
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
    this._morphDuration = Math.max(180, 900 * Math.abs(targetT - this.morphT));
    this._morphActive = true;
  }

  async loadGeoData() {
    try {
      const [landRes, platesRes, starsRes] = await Promise.all([
        fetch('data/land-110m.geojson'),
        fetch('data/tectonic-plates.geojson'),
        fetch('data/stars.json'),
      ]);
      if (landRes.ok) {
        const landJson = await landRes.json();
        this.landFeatures = landJson.features || [];
        this._buildLandLayer();
      }
      if (platesRes.ok) {
        const platesJson = await platesRes.json();
        this.plateFeatures = platesJson.features || [];
        this._buildPlateLayer();
      }
      if (starsRes.ok) {
        const stars = await starsRes.json();
        this._buildStarfieldLayer(stars);
      }
    } catch (err) {
      console.warn('Could not load local GeoJSON layers:', err);
    }
  }

  setShowPlates(flag) {
    this.showPlates = flag;
    if (this._plateMeshes) {
      for (const m of this._plateMeshes) m.visible = !!flag;
    }
  }

  setShowStars(flag) {
    this.showStars = !!flag;
    if (this._starMesh) {
      this._starMesh.visible = this.showStars;
    }
  }

  setShowMilkyWay(flag) {
    this.showMilkyWay = !!flag;
    if (this._milkyWayMesh) {
      this._milkyWayMesh.visible = this.showMilkyWay;
    }
  }

  setQuakes(quakes) {
    this.quakes = quakes;
  }

  setSelectedQuake(id) {
    this.selectedQuakeId = id;
  }

  canAutoTransition(now = performance.now()) {
    return (
      !this.isDragging &&
      !this._morphActive &&
      !this._manualNavHold &&
      now - this.lastUserNavTime >= 5000 &&
      this.baseRadius > 0
    );
  }

  _resetAutoCameraVelocities() {
    this._camVelLon = 0;
    this._camVelLat = 0;
    this._camVelPanX = 0;
    this._camVelPanY = 0;
    this._camVelZoom = 0;
    this._lastAutoCamTime = null;
  }

  centerOn(lon, lat = 0) {
    if (!Number.isFinite(lon)) return;
    const targetLon = normalizeLon(lon);
    const targetLat = Number.isFinite(lat) ? Math.max(-85, Math.min(85, lat)) : 0;
    this.autoCenterLon = targetLon;
    this._autoTransitionActive = false;
    this._autoFollowActive = false;
    this._resetAutoCameraVelocities();

    if (this.mapMode === '3d') {
      this.rotLon = targetLon;
      this.rotLat = targetLat;
      this._clampRotation();
    } else {
      const worldW = this.bounds.w * this.zoom;
      if (worldW > 0) {
        this.panX = -(targetLon / 360) * worldW;
        this.panY = (targetLat / 180) * (this.bounds.h * this.zoom);
        this._clampPan();
      }
    }
  }

  setAutoZoomEnabled(enabled) {
    const next = Boolean(enabled);
    if (this._autoZoomEnabled === next) return;
    this._autoZoomEnabled = next;
    if (!next) {
      this._autoFollowTargetZoom = 1;
      this._transTargetZoom = 1;
    }
  }

  setAutoCenterTarget(lon, lat = 0, smoothTimeSec = 1.4, targetZoom = 1) {
    if (!Number.isFinite(lon)) return;
    const targetLon = normalizeLon(lon);
    const targetLat = Number.isFinite(lat) ? Math.max(-85, Math.min(85, lat)) : 0;
    this.autoCenterLon = targetLon;
    this._autoFollowTargetLon = targetLon;
    this._autoFollowTargetLat = targetLat;
    this._autoFollowTargetZoom = this._autoZoomEnabled && Number.isFinite(targetZoom)
      ? Math.max(0.5, Math.min(10, targetZoom))
      : 1;
    this._autoFollowSmoothTime = Math.max(0.15, smoothTimeSec);
    this._autoFollowActive = true;
    this._autoTransitionActive = false;
  }

  stopAutoFollow() {
    this._autoFollowActive = false;
    this._resetAutoCameraVelocities();
  }

  setAutoCenterLon(lon, durationMs = 600, lat = null, targetZoom = 1) {
    if (!Number.isFinite(lon)) return;
    this.autoCenterLon = lon;
    this._autoFollowActive = false;
    this._resetAutoCameraVelocities();
    const targetLat = Number.isFinite(lat) ? Math.max(-85, Math.min(85, lat)) : 0;
    const now = performance.now();
    if (this.canAutoTransition(now)) {
      this._transStartTime = now;
      this._transDuration = Math.max(80, durationMs);
      this._transStartZoom = this.zoom;
      this._transTargetZoom = this._autoZoomEnabled && Number.isFinite(targetZoom)
        ? Math.max(0.5, Math.min(10, targetZoom))
        : 1;

      if (this.mapMode === '3d') {
        this._transStartLon = this.rotLon;
        this._transStartLat = this.rotLat;
        this._transDeltaLon = normalizeLon(lon - this.rotLon);
        this._transDeltaLat = targetLat - this.rotLat;
      } else {
        const startZoom = this.zoom || 1;
        this._transStartPanX = this.panX / startZoom;
        this._transStartPanY = this.panY / startZoom;
        const baseW = this.bounds.w;
        const baseH = this.bounds.h;
        if (baseW > 0 && baseH > 0) {
          let targetPanX = -(lon / 360) * baseW;
          targetPanX = ((((targetPanX + baseW / 2) % baseW) + baseW) % baseW) - baseW / 2;
          let dx = targetPanX - this._transStartPanX;
          dx = ((((dx + baseW / 2) % baseW) + baseW) % baseW) - baseW / 2;
          this._transDeltaPanX = dx;
          const targetPanY = (targetLat / 180) * baseH;
          this._transDeltaPanY = targetPanY - this._transStartPanY;
        } else {
          this._transDeltaPanX = 0;
          this._transDeltaPanY = 0;
        }
      }
      this._autoTransitionActive = true;
    }
  }

  resetView({ preservePosition = false } = {}) {
    const prevZoom = this.zoom || 1;
    this.zoom = 1;
    this.tilt2D = 0;
    this.yaw2D = 0;
    if (preservePosition) {
      if (prevZoom !== 1) {
        this.panX /= prevZoom;
        this.panY /= prevZoom;
      }
      this._clampPan();
      this._clampRotation();
    } else {
      this.panX = 0;
      this.panY = 0;
      this.rotLon = 0;
      this.rotLat = 0;
    }
    this.lastUserNavTime = -Infinity;
    this._manualNavHold = false;
    this._autoTransitionActive = false;
    this._autoFollowActive = false;
    this._resetAutoCameraVelocities();
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
    this.cx = this.width * 0.5;
    this.cy = this.height * 0.5;

    const availW = this.width * 0.88;
    const availH = this.height * 0.82;
    let mapW = availW;
    let mapH = mapW / 2;
    if (mapH > availH) {
      mapH = availH;
      mapW = mapH * 2;
    }
    this.bounds = {
      x: (this.width - mapW) * 0.5,
      y: (this.height - mapH) * 0.5,
      w: mapW,
      h: mapH,
    };

    this.baseRadius = Math.min(this.width, this.height) * 0.37;

    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(this.width, this.height, false);
    this._sharedUniforms.uDpr.value = this.dpr;
    this._sharedUniforms.uResolution.value.set(
      Math.max(1, this.width),
      Math.max(1, this.height)
    );
    this.camera.aspect = Math.max(0.1, this.width / Math.max(1, this.height));
    this.camera.updateProjectionMatrix();
    this._clampPan();
  }

  _clampPan() {
    const worldW = this.bounds.w * this.zoom;
    const worldH = this.bounds.h * this.zoom;
    if (worldW > 0) {
      this.panX = ((((this.panX + worldW / 2) % worldW) + worldW) % worldW) - worldW / 2;
    }
    const maxPanY = Math.max(0, (worldH - this.height * 0.7) * 0.5);
    this.panY = Math.max(-maxPanY, Math.min(maxPanY, this.panY));
  }

  _clampRotation() {
    this.rotLon = normalizeLon(this.rotLon);
    this.rotLat = Math.max(-85, Math.min(85, this.rotLat));
  }

  _project2D(lon, lat) {
    const worldW = this.bounds.w * this.zoom;
    const worldH = this.bounds.h * this.zoom;
    const x = this.cx + (lon / 360) * worldW + this.panX;
    const y = this.cy + (-lat / 180) * worldH + this.panY;
    return [x, y];
  }

  _unproject2D(px, py) {
    const worldW = this.bounds.w * this.zoom;
    const worldH = this.bounds.h * this.zoom;
    if (worldW <= 0 || worldH <= 0) return [0, 0];
    const lon = normalizeLon(((px - this.cx - this.panX) / worldW) * 360);
    const lat = Math.max(-90, Math.min(90, -((py - this.cy - this.panY) / worldH) * 180));
    return [lon, lat];
  }

  _getPan2D() {
    const worldW = Math.max(1, this.bounds.w * this.zoom);
    const worldH = Math.max(1, this.bounds.h * this.zoom);
    return [
      -(this.panX / worldW) * W_2D,
      (this.panY / worldH) * H_2D,
    ];
  }

  unproject(px, py) {
    const ndcX = (px / Math.max(1, this.width)) * 2 - 1;
    const ndcY = -(py / Math.max(1, this.height)) * 2 + 1;
    this._raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);

    if (this.morphT < 0.5) {
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
      const hit = new THREE.Vector3();
      if (this._raycaster.ray.intersectPlane(plane, hit)) {
        const [pan2DX, pan2DY] = this._getPan2D();
        const lon = normalizeLon(((hit.x + pan2DX) / 2.0) * 180);
        const lat = Math.max(-90, Math.min(90, (hit.y + pan2DY) * 90));
        return [lon, lat];
      }
      return this._unproject2D(px, py);
    }

    const sphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), R_LAND);
    const hit = new THREE.Vector3();
    if (this._raycaster.ray.intersectSphere(sphere, hit)) {
      // Inverse rotate by -rotLat around X, then +rotLon around Y
      const phi0 = this.rotLat * DEG2RAD;
      const cosP0 = Math.cos(phi0);
      const sinP0 = Math.sin(phi0);
      const xa = hit.x;
      const ya = hit.y * cosP0 + hit.z * sinP0;
      const za = -hit.y * sinP0 + hit.z * cosP0;
      const lat = Math.asin(Math.max(-1, Math.min(1, ya / R_LAND))) * RAD2DEG;
      const lon = normalizeLon(this.rotLon + Math.atan2(xa, za) * RAD2DEG);
      return [lon, lat];
    }
    return [this.rotLon, this.rotLat];
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

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

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
        this._manualNavHold = true;
        this._autoFollowActive = false;
        this._clampPan();
        this.onZoomChange?.(this.zoom);
      } else {
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const newZoom = Math.max(0.45, Math.min(10, this.zoom * factor));
        if (newZoom === this.zoom) return;

        this.zoom = newZoom;
        this._manualNavHold = true;
        this._autoFollowActive = false;
        this.onZoomChange?.(this.zoom);
      }
    }, { passive: false });

    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      this.isDragging = true;
      this.dragButton = e.button;
      this.dragMoved = false;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.lastMouseX;
      const dy = e.clientY - this.lastMouseY;
      if (Math.hypot(dx, dy) > 3) {
        this.dragMoved = true;
        this.lastUserNavTime = performance.now();
        this._manualNavHold = true;
        this._autoTransitionActive = false;
        this._autoFollowActive = false;
      }

      if (this.mapMode === '2d') {
        if (this.dragButton === 2 || e.ctrlKey) {
          // 2.5D tilt & yaw inspection of the three parallel planes
          this.tilt2D = Math.max(0, Math.min(1.08, this.tilt2D - dy * 0.0055));
          this.yaw2D = Math.max(-0.65, Math.min(0.65, this.yaw2D + dx * 0.0045));
        } else {
          this.panX += dx;
          this.panY += dy;
          this._clampPan();
        }
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
      let bestDist = 16;

      const m = this.morphT;
      const tiles = m < 0.85 ? this._tileOffsets : [0];
      const [pan2DX, pan2DY] = this._getPan2D();
      const camDir = this._tmpNormal.copy(this.camera.position).normalize();

      for (let i = this.quakes.length - 1; i >= 0; i--) {
        const q = this.quakes[i];
        const rEvent = getEventRadius(q.depth);
        for (let t = 0; t < tiles.length; t++) {
          morphPointCPU(q.lon, q.lat, rEvent, m, tiles[t], this.rotLon, this.rotLat, pan2DX, pan2DY, this._tmpVec);
          if (m >= 0.5 && this._tmpVec.dot(camDir) < -0.05) continue;

          this._tmpVec.project(this.camera);
          if (this._tmpVec.z > 1) continue;
          const sx = (this._tmpVec.x * 0.5 + 0.5) * this.width;
          const sy = (-this._tmpVec.y * 0.5 + 0.5) * this.height;
          const d = Math.hypot(mx - sx, my - sy);
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

  _updateMorph(now) {
    if (!this._morphActive) return;
    const elapsed = now - this._morphStartTime;
    const t = Math.min(1, Math.max(0, elapsed / this._morphDuration));
    const eased = easeInOutCubic(t);
    this.morphT = this._morphStartT + (this._morphTargetT - this._morphStartT) * eased;
    if (t >= 1) {
      this.morphT = this._morphTargetT;
      this._morphActive = false;
    }
  }

  _rescalePanForZoom(prevZoom) {
    if (!prevZoom || this.zoom === prevZoom) return;
    const scaleRatio = this.zoom / prevZoom;
    this.panX *= scaleRatio;
    this.panY *= scaleRatio;
    this._camVelPanX *= scaleRatio;
    this._camVelPanY *= scaleRatio;
    this._clampPan();
  }

  _updateAutoCamera(now) {
    if (this._autoFollowActive && !this.isDragging && !this._morphActive && this.canAutoTransition(now)) {
      const dt = this._lastAutoCamTime !== null
        ? Math.min(0.1, Math.max(0.001, (now - this._lastAutoCamTime) / 1000))
        : 1 / 60;
      this._lastAutoCamTime = now;

      const prevZoom = this.zoom || 1;
      const targetZoom = this._autoZoomEnabled ? this._autoFollowTargetZoom : 1;
      if (Math.abs(this.zoom - targetZoom) > 0.003) {
        const [nextZoom, nextZoomVel] = smoothDamp(
          this.zoom, targetZoom, this._camVelZoom, this._autoFollowSmoothTime * 0.95, dt
        );
        this.zoom = Math.max(0.5, Math.min(10, nextZoom));
        this._camVelZoom = nextZoomVel;
        this._rescalePanForZoom(prevZoom);
        this.onZoomChange?.(this.zoom);
      } else {
        if (this.zoom !== targetZoom) {
          this.zoom = targetZoom;
          this._rescalePanForZoom(prevZoom);
          this.onZoomChange?.(this.zoom);
        }
        this._camVelZoom = 0;
      }

      if (this.mapMode === '3d') {
        const deltaLon = normalizeLon(this._autoFollowTargetLon - this.rotLon);
        const [nextLon, nextVelLon] = smoothDamp(
          this.rotLon, this.rotLon + deltaLon, this._camVelLon, this._autoFollowSmoothTime, dt
        );
        const [nextLat, nextVelLat] = smoothDamp(
          this.rotLat, this._autoFollowTargetLat, this._camVelLat, this._autoFollowSmoothTime * 1.1, dt
        );
        this.rotLon = normalizeLon(nextLon);
        this.rotLat = Math.max(-85, Math.min(85, nextLat));
        this._camVelLon = nextVelLon;
        this._camVelLat = nextVelLat;
      } else {
        const worldW = this.bounds.w * this.zoom;
        const worldH = this.bounds.h * this.zoom;
        if (worldW > 0 && worldH > 0) {
          let targetPanX = -(this._autoFollowTargetLon / 360) * worldW;
          targetPanX = ((((targetPanX + worldW / 2) % worldW) + worldW) % worldW) - worldW / 2;
          let dx = targetPanX - this.panX;
          dx = ((((dx + worldW / 2) % worldW) + worldW) % worldW) - worldW / 2;

          const [nextPanX, nextVelPanX] = smoothDamp(
            this.panX, this.panX + dx, this._camVelPanX, this._autoFollowSmoothTime, dt
          );
          const targetPanY = (this._autoFollowTargetLat / 180) * worldH;
          const [nextPanY, nextVelPanY] = smoothDamp(
            this.panY, targetPanY, this._camVelPanY, this._autoFollowSmoothTime * 1.1, dt
          );
          this.panX = nextPanX;
          this.panY = nextPanY;
          this._camVelPanX = nextVelPanX;
          this._camVelPanY = nextVelPanY;
          this._clampPan();
        }
      }
      return;
    }

    if (!this._autoTransitionActive) {
      if (!this._autoZoomEnabled && Math.abs(this.zoom - 1) > 0.003 && this.canAutoTransition(now)) {
        const dt = this._lastAutoCamTime !== null
          ? Math.min(0.1, Math.max(0.001, (now - this._lastAutoCamTime) / 1000))
          : 1 / 60;
        this._lastAutoCamTime = now;
        const prevZoom = this.zoom || 1;
        const [nextZoom, nextZoomVel] = smoothDamp(
          this.zoom, 1, this._camVelZoom, 0.45, dt
        );
        this.zoom = Math.abs(nextZoom - 1) <= 0.003 ? 1 : Math.max(0.5, Math.min(10, nextZoom));
        this._camVelZoom = this.zoom === 1 ? 0 : nextZoomVel;
        this._rescalePanForZoom(prevZoom);
        this.onZoomChange?.(this.zoom);
      } else {
        this._lastAutoCamTime = null;
      }
      return;
    }
    this._lastAutoCamTime = null;

    const elapsed = now - this._transStartTime;
    const t = Math.min(1, Math.max(0, elapsed / this._transDuration));
    const eased = easeInOutCubic(t);

    const targetZoom = this._autoZoomEnabled ? this._transTargetZoom : 1;
    this.zoom = this._transStartZoom + (targetZoom - this._transStartZoom) * eased;
    if (this.mapMode === '3d') {
      this.rotLon = normalizeLon(this._transStartLon + this._transDeltaLon * eased);
      this.rotLat = this._transStartLat + this._transDeltaLat * eased;
      this._clampRotation();
    } else {
      this.panX = (this._transStartPanX + this._transDeltaPanX * eased) * this.zoom;
      this.panY = (this._transStartPanY + this._transDeltaPanY * eased) * this.zoom;
      this._clampPan();
    }
    this.onZoomChange?.(this.zoom);

    if (t >= 1) {
      this._autoTransitionActive = false;
    }
  }

  _updateCamera(m) {
    const halfH2 = (this.height / Math.max(1, this.bounds.h)) * (H_2D * 0.5);
    const camDist2 = halfH2 / (Math.tan(FOV_RAD * 0.5) * this.zoom);
    const tilt = this.tilt2D * (1 - m);
    const yaw = this.yaw2D * (1 - m);

    const camPos2 = new THREE.Vector3(
      camDist2 * Math.sin(tilt) * Math.sin(yaw),
      -camDist2 * Math.sin(tilt) * Math.cos(yaw),
      camDist2 * Math.cos(tilt)
    );

    const halfH3 = R_LAND * (this.height / Math.max(1, 2 * this.baseRadius));
    const camDist3 = halfH3 / (Math.tan(FOV_RAD * 0.5) * this.zoom);
    const camPos3 = new THREE.Vector3(0, 0, camDist3);

    this.camera.position.lerpVectors(camPos2, camPos3, m);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
    this._sharedUniforms.uCamPos.value.copy(this.camera.position);

    // Position 3D atmosphere billboard behind globe
    this._atmoMesh.position.set(0, 0, -0.15);
    this._atmoMesh.quaternion.copy(this.camera.quaternion);
    this._atmoMesh.visible = m > 0.02;
  }

  _updateQuakeDiscs(m) {
    const tiles = m < 0.85 ? this._tileOffsets : [0];
    const [pan2DX, pan2DY] = this._getPan2D();
    const needed = this.quakes.length * tiles.length;
    if (needed > this._maxDiscCapacity) {
      this.scene.remove(this._discMesh);
      this._maxDiscCapacity = Math.max(needed + 512, this._maxDiscCapacity * 2);
      this._discMesh = new THREE.InstancedMesh(
        this._discMesh.geometry,
        this._discMat,
        this._maxDiscCapacity
      );
      this._discMesh.renderOrder = 10;
      this._discMesh.frustumCulled = false;
      this.scene.add(this._discMesh);
    }

    const worldPerPx = m < 0.5
      ? W_2D / Math.max(1, this.bounds.w * this.zoom)
      : 1 / Math.max(1, this.radius);

    let count = 0;
    let selectedQuake = null;

    for (let i = 0; i < this.quakes.length; i++) {
      const q = this.quakes[i];
      const mag = Math.max(0.4, q.mag ?? 1);
      const pxR = 2.0 + Math.pow(mag, 1.35) * 1.15;
      const isSelected = q.id === this.selectedQuakeId || q === this.hoveredQuake;
      if (isSelected) selectedQuake = q;

      const worldR = (isSelected ? pxR + 2.5 : pxR) * worldPerPx;
      const rEvent = getEventRadius(q.depth);
      const [cr, cg, cb] = getDepthRGB(q.depth ?? 10);

      morphNormalCPU(q.lon, q.lat, m, this.rotLon, this.rotLat, this._tmpNormal);
      this._tmpQuat.setFromUnitVectors(this._zAxis, this._tmpNormal);
      this._tmpScale.set(worldR, worldR, 1);

      for (let t = 0; t < tiles.length; t++) {
        morphPointCPU(q.lon, q.lat, rEvent, m, tiles[t], this.rotLon, this.rotLat, pan2DX, pan2DY, this._tmpVec);
        this._tmpMat.compose(this._tmpVec, this._tmpQuat, this._tmpScale);
        this._discMesh.setMatrixAt(count, this._tmpMat);
        this._tmpColor.setRGB(cr, cg, cb);
        this._discMesh.setColorAt(count, this._tmpColor);
        count++;
      }
    }

    this._discMesh.count = count;
    this._discMesh.instanceMatrix.needsUpdate = true;
    if (this._discMesh.instanceColor) this._discMesh.instanceColor.needsUpdate = true;

    // Selection/hover highlight ring
    for (let t = 0; t < 3; t++) {
      const ring = this._selRingMeshes[t];
      if (!selectedQuake || (t !== 1 && m >= 0.85)) {
        ring.visible = false;
        continue;
      }
      const mag = Math.max(0.4, selectedQuake.mag ?? 1);
      const pxR = 2.0 + Math.pow(mag, 1.35) * 1.15 + 2.5;
      const worldR = pxR * worldPerPx;
      const rEvent = getEventRadius(selectedQuake.depth);
      morphPointCPU(
        selectedQuake.lon, selectedQuake.lat, rEvent + 0.0006, m,
        this._tileOffsets[t], this.rotLon, this.rotLat, pan2DX, pan2DY, ring.position
      );
      morphNormalCPU(selectedQuake.lon, selectedQuake.lat, m, this.rotLon, this.rotLat, this._tmpNormal);
      ring.quaternion.setFromUnitVectors(this._zAxis, this._tmpNormal);
      ring.scale.set(worldR, worldR, 1);
      ring.visible = true;
    }
  }

  _updateWaves(now, m) {
    const alive = [];
    let poolIdx = 0;
    let rippleIdx = 0;
    const tiles = m < 0.85 ? this._tileOffsets : [0];
    const [pan2DX, pan2DY] = this._getPan2D();
    const segs = this._waveSegments;

    const worldPerPx = m < 0.5
      ? W_2D / Math.max(1, this.bounds.w * this.zoom)
      : 1 / Math.max(1, this.radius);

    for (const w of this.activeWaves) {
      const elapsed = this._getWaveElapsed(w, now);
      if (elapsed < 0) {
        alive.push(w);
        continue;
      }
      if (elapsed >= w.duration) continue;
      alive.push(w);

      const t = elapsed / w.duration;
      const attackFrac = Math.max(0.015, Math.min(0.45, (w.attackMs || 80) / w.duration));
      const riseTime = Math.max(0.05, attackFrac * 0.85);
      const rise = Math.min(1, t / riseTime);
      const envelope = rise * Math.pow(1 - t, 2.15);

      const [cr, cg, cb] = getDepthRGB(w.depth ?? 10);
      const rStart = getEventRadius(w.depth);

      // Local tangent basis on sphere / 2D plane around (w.lon, w.lat)
      const phi = w.lat * DEG2RAD;
      const lam = w.lon * DEG2RAD;
      const cosPhi = Math.cos(phi);
      const sinPhi = Math.sin(phi);
      const cosLam = Math.cos(lam);
      const sinLam = Math.sin(lam);

      // East & North unit vectors in (lon, lat) degrees per world unit
      const degScaleLat = 90; // 1 world unit in 2D Y = 90 deg lat
      const degScaleLon = 90 / Math.max(0.18, cosPhi);

      const ringCount = w.timbre === 'subduction' ? 4 : 3;
      const baseMaxWorldR = w.maxRadius * worldPerPx * 1.15;

      for (let i = 0; i < ringCount; i++) {
        const ringDelay = i * 0.14;
        if (t <= ringDelay) continue;
        const rt = Math.min(1, (t - ringDelay) / (1 - ringDelay));
        const ringFade = Math.pow(1 - rt, 1.3) * envelope;
        const alpha = (0.72 - i * 0.14) * ringFade;
        if (alpha <= 0.01) continue;

        // Expand outward along event depth rStart and bulge upward toward R_LAND as a soap-bubble cap
        const radialEase = 1 - Math.pow(1 - rt, 2.2);
        const radiusWorld = baseMaxWorldR * radialEase;
        const hMax = Math.max(0.002, R_LAND - rStart);
        const hTarget = hMax * Math.pow(rt, 0.72);
        const hCap = Math.min(hTarget, radiusWorld * 0.85);

        const phaseA = w.phaseA ?? 0;
        const phaseB = w.phaseB ?? 1.1;
        const phaseC = w.phaseC ?? 2.4;
        const wobbleAmp = w.wobbleAmp ?? 0.038;
        const freqScale = Math.max(0.65, Math.min(2.2, (w.freq || 36.7) / 36.7));
        const drift = rt * (2.0 + freqScale * 1.0) + i * 0.95;
        const radialSpread = 0.35 + 0.65 * rt;

        const radialSegs = this._rippleRadialSegments;
        const ringStride = radialSegs + 1;

        for (let tileIdx = 0; tileIdx < tiles.length; tileIdx++) {
          const tileOffset = tiles[tileIdx];
          const line = this._getPooledWaveLine(poolIdx++);
          const posAttr = line.geometry.getAttribute('position');
          const arr = posAttr.array;

          const ripple = this._getPooledRippleMesh(rippleIdx++);
          const ripPosAttr = ripple.geometry.getAttribute('position');
          const ripArr = ripPosAttr.array;

          for (let s = 0; s <= segs; s++) {
            const theta = (s / segs) * Math.PI * 2;
            const harmonic =
              Math.sin(theta * 3 + phaseA + drift) * 0.52 +
              Math.sin(theta * 5 - phaseB - drift * 0.72) * 0.3 +
              Math.cos(theta * 2 + phaseC + drift * 0.41) * 0.18;
            const rad = Math.max(0.002, radiusWorld * (1 + harmonic * wobbleAmp * radialSpread));
            const cosT = Math.cos(theta);
            const sinT = Math.sin(theta);

            // Convert world radial offset to (lon, lat) offset at base intersection (r = rStart)
            const dLonBase = cosT * rad * degScaleLon;
            const dLatBase = sinT * rad * degScaleLat;
            const pLonBase = w.lon + dLonBase;
            const pLatBase = Math.max(-89.5, Math.min(89.5, w.lat + dLatBase));

            morphPointCPU(pLonBase, pLatBase, rStart, m, tileOffset, this.rotLon, this.rotLat, pan2DX, pan2DY, this._tmpVec);
            arr[s * 3] = this._tmpVec.x;
            arr[s * 3 + 1] = this._tmpVec.y;
            arr[s * 3 + 2] = this._tmpVec.z;

            // Top spherical cap of sphere with radius Rs intersected by event depth rStart:
            // Rs = (a^2 + h^2) / (2h), d = Rs - h, dr(v) = sqrt(Rs^2 - (v*a)^2) - d
            const hasCap = hCap > 1e-6;
            const rSphere = hasCap ? (rad * rad + hCap * hCap) / (2 * hCap) : 0;
            const dCenter = rSphere - hCap;

            for (let r = 0; r <= radialSegs; r++) {
              const v = r / radialSegs;
              const rho = rad * v;
              const deltaR = hasCap
                ? Math.max(0, Math.sqrt(Math.max(0, rSphere * rSphere - rho * rho)) - dCenter)
                : 0;
              const pLon = w.lon + cosT * rho * degScaleLon;
              const pLat = Math.max(-89.5, Math.min(89.5, w.lat + sinT * rho * degScaleLat));

              morphPointCPU(
                pLon, pLat, rStart + deltaR, m, tileOffset,
                this.rotLon, this.rotLat, pan2DX, pan2DY, this._tmpVec
              );
              const vIdx = (s * ringStride + r) * 3;
              ripArr[vIdx] = this._tmpVec.x;
              ripArr[vIdx + 1] = this._tmpVec.y;
              ripArr[vIdx + 2] = this._tmpVec.z;
            }
          }

          posAttr.needsUpdate = true;
          line.material.color.setRGB(cr, cg, cb);
          line.material.opacity = Math.min(1, alpha);
          line.visible = true;

          ripPosAttr.needsUpdate = true;
          ripple.geometry.computeVertexNormals();
          ripple.material.uniforms.uColor.value.setRGB(cr, cg, cb);
          ripple.material.uniforms.uAlpha.value = Math.min(1, alpha) * 0.55;
          ripple.material.uniforms.uPhase.value = phaseA + i * 1.3;
          ripple.material.uniforms.uProgress.value = rt;
          ripple.visible = true;
        }
      }
    }

    for (let i = poolIdx; i < this._wavePool.length; i++) {
      this._wavePool[i].visible = false;
    }
    for (let i = rippleIdx; i < this._ripplePool.length; i++) {
      this._ripplePool[i].visible = false;
    }

    this.activeWaves = alive;
  }

  render(now) {
    this._updateMorph(now);
    this._updateAutoCamera(now);

    const m = this.morphT;
    const [pan2DX, pan2DY] = this._getPan2D();
    this._sharedUniforms.uMorph.value = m;
    this._sharedUniforms.uRot.value.set(this.rotLon, this.rotLat);
    this._sharedUniforms.uPan2D.value.set(pan2DX, pan2DY);

    // Tile visibility: side tiles curl onto the exact same sphere and fade smoothly
    const sideTileAlpha = m < 0.85 ? Math.max(0, 1.0 - Math.max(0, (m - 0.1) / 0.75)) : 0.0;
    this._tileUniforms[0].uTileAlpha.value = sideTileAlpha;
    this._tileUniforms[1].uTileAlpha.value = 1.0;
    this._tileUniforms[2].uTileAlpha.value = sideTileAlpha;

    // Solar direction rotated into camera/globe-view space
    const solarDate = new Date(this.solarTimeMs);
    const { lon: sunLon, lat: sunLat } = getSubsolarPoint(solarDate);
    const gmstDeg = getGMSTDeg(solarDate);
    this._sharedUniforms.uGmstRotLon.value = gmstDeg + this.rotLon;
    const sPhi = sunLat * DEG2RAD;
    const sDLam = (sunLon - this.rotLon) * DEG2RAD;
    const sxa = Math.cos(sPhi) * Math.sin(sDLam);
    const sya = Math.sin(sPhi);
    const sza = Math.cos(sPhi) * Math.cos(sDLam);
    const phi0 = this.rotLat * DEG2RAD;
    const cosP0 = Math.cos(phi0);
    const sinP0 = Math.sin(phi0);
    this._sharedUniforms.uSunDir.value.set(
      sxa,
      sya * cosP0 - sza * sinP0,
      sya * sinP0 + sza * cosP0
    );

    this._updateCamera(m);

    if (this._milkyWayMesh) {
      this._milkyWayMesh.visible = this.showMilkyWay && m > 0.02;
      if (this._milkyWayMesh.visible) {
        this._milkyWayMesh.position.copy(this.camera.position);
      }
    }
    if (this._starMesh) {
      this._starMesh.visible = this.showStars && m > 0.02;
    }

    // Position directional sun light beyond the camera, geosynced to true subsolar direction
    const sunDist = Math.max(25, this.camera.position.length() * 3);
    this._sunLight.position.copy(this._sharedUniforms.uSunDir.value).multiplyScalar(sunDist);
    const sunScale = sunDist / 25;
    const showSun3D = m > 0.02;
    this._sunOrb.visible = showSun3D;
    this._sunCorona.visible = showSun3D;
    if (showSun3D) {
      this._sunOrb.scale.setScalar(sunScale);
      this._sunCorona.scale.set(3.8 * sunScale, 3.8 * sunScale, 1);
    }

    this._updateQuakeDiscs(m);
    this._updateWaves(now, m);

    this.renderer.render(this.scene, this.camera);
  }
}
