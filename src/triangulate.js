// Ear-clipping polygon triangulation (with Eberly hole bridging) and spherical subdivision
// for smooth 2D <-> 3D morphing of GeoJSON land polygons.

function signedArea(ring) {
  let area = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    area += (x1 * y2 - x2 * y1);
  }
  return area * 0.5;
}

function cleanRing(ring) {
  if (!ring || ring.length < 3) return [];
  const pts = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    if (pts.length > 0) {
      const prev = pts[pts.length - 1];
      if (Math.abs(p[0] - prev[0]) < 1e-7 && Math.abs(p[1] - prev[1]) < 1e-7) continue;
    }
    pts.push([p[0], p[1]]);
  }
  if (pts.length > 1) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.abs(first[0] - last[0]) < 1e-7 && Math.abs(first[1] - last[1]) < 1e-7) {
      pts.pop();
    }
  }
  return pts;
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  // Ignore duplicate bridge vertices coincident with triangle corners
  if (
    (Math.abs(px - ax) < 1e-9 && Math.abs(py - ay) < 1e-9) ||
    (Math.abs(px - bx) < 1e-9 && Math.abs(py - by) < 1e-9) ||
    (Math.abs(px - cx) < 1e-9 && Math.abs(py - cy) < 1e-9)
  ) {
    return false;
  }
  const v0x = cx - ax, v0y = cy - ay;
  const v1x = bx - ax, v1y = by - ay;
  const v2x = px - ax, v2y = py - ay;
  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;
  const denom = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(denom) < 1e-12) return false;
  const inv = 1 / denom;
  const u = (dot11 * dot02 - dot01 * dot12) * inv;
  const v = (dot00 * dot12 - dot01 * dot02) * inv;
  return u >= 0 && v >= 0 && u + v <= 1;
}

function bridgeHole(outer, hole) {
  // Eberly's algorithm: find rightmost vertex H of hole, cast +X ray to outer ring
  let hIdx = 0;
  for (let i = 1; i < hole.length; i++) {
    if (hole[i][0] > hole[hIdx][0]) hIdx = i;
  }
  const [hx, hy] = hole[hIdx];

  let bestIx = Infinity;
  let bestEdgeIdx = -1;
  const n = outer.length;

  for (let i = 0; i < n; i++) {
    const [ax, ay] = outer[i];
    const [bx, by] = outer[(i + 1) % n];
    if ((ay <= hy && by >= hy) || (by <= hy && ay >= hy)) {
      if (Math.abs(by - ay) < 1e-12) continue;
      const t = (hy - ay) / (by - ay);
      const ix = ax + t * (bx - ax);
      if (ix >= hx - 1e-9 && ix < bestIx) {
        bestIx = ix;
        bestEdgeIdx = i;
      }
    }
  }

  let bestIdx = 0;
  if (bestEdgeIdx !== -1) {
    const iA = bestEdgeIdx;
    const iB = (bestEdgeIdx + 1) % n;
    const pIdx = outer[iA][0] >= outer[iB][0] ? iA : iB;
    const [px, py] = outer[pIdx];

    if (Math.abs(px - bestIx) < 1e-9 && Math.abs(py - hy) < 1e-9) {
      bestIdx = pIdx;
    } else {
      // Check if any reflex vertex of outer lies inside triangle (H, I, P)
      let minAngle = Infinity;
      let minDist = Infinity;
      let candidate = pIdx;

      for (let i = 0; i < n; i++) {
        if (i === pIdx) continue;
        const [rx, ry] = outer[i];
        if (rx < hx - 1e-9) continue;

        const [ax, ay] = outer[(i - 1 + n) % n];
        const [bx, by] = outer[(i + 1) % n];
        const cross = (rx - ax) * (by - ry) - (ry - ay) * (bx - rx);
        if (cross >= 0) continue; // only reflex vertices

        if (pointInTriangle(rx, ry, hx, hy, bestIx, hy, px, py)) {
          const ang = Math.abs(Math.atan2(ry - hy, rx - hx));
          const dist = Math.hypot(rx - hx, ry - hy);
          if (ang < minAngle - 1e-9 || (Math.abs(ang - minAngle) < 1e-9 && dist < minDist)) {
            minAngle = ang;
            minDist = dist;
            candidate = i;
          }
        }
      }
      bestIdx = candidate;
    }
  }

  const merged = [];
  for (let i = 0; i <= bestIdx; i++) merged.push(outer[i]);
  for (let i = 0; i < hole.length; i++) merged.push(hole[(hIdx + i) % hole.length]);
  merged.push(hole[hIdx]);
  for (let i = bestIdx; i < outer.length; i++) merged.push(outer[i]);
  return merged;
}

function earClip(ring) {
  const pts = ring.slice();
  if (pts.length < 3) return [];
  if (signedArea(pts) < 0) pts.reverse();

  const indices = pts.map((_, i) => i);
  const tris = [];
  let i = 0;
  let noProgressCount = 0;

  while (indices.length > 3) {
    const n = indices.length;
    const prevIdx = indices[(i - 1 + n) % n];
    const currIdx = indices[i % n];
    const nextIdx = indices[(i + 1) % n];

    const [ax, ay] = pts[prevIdx];
    const [bx, by] = pts[currIdx];
    const [cx, cy] = pts[nextIdx];

    const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const allowDegenerate = noProgressCount >= n;

    if (cross > (allowDegenerate ? -1e-7 : 1e-10)) {
      let contains = false;
      if (!allowDegenerate) {
        for (let j = 0; j < n; j++) {
          const testIdx = indices[j];
          if (testIdx === prevIdx || testIdx === currIdx || testIdx === nextIdx) continue;
          const [px, py] = pts[testIdx];
          if (pointInTriangle(px, py, ax, ay, bx, by, cx, cy)) {
            contains = true;
            break;
          }
        }
      }
      if (!contains) {
        tris.push([pts[prevIdx], pts[currIdx], pts[nextIdx]]);
        indices.splice(i % n, 1);
        i = i % indices.length;
        noProgressCount = 0;
        continue;
      }
    }

    i = (i + 1) % n;
    noProgressCount++;
    if (noProgressCount > n * 2 + 4) {
      // Force-clip current vertex to avoid infinite loop on malformed geometry
      tris.push([pts[prevIdx], pts[currIdx], pts[nextIdx]]);
      indices.splice(i % n, 1);
      i = i % indices.length;
      noProgressCount = 0;
    }
  }

  if (indices.length === 3) {
    tris.push([pts[indices[0]], pts[indices[1]], pts[indices[2]]]);
  }
  return tris;
}

function subdivideTriangle(a, b, c, maxDeg, out, depth = 0) {
  const dAB = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const dBC = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const dCA = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const maxEdge = Math.max(dAB, dBC, dCA);

  if (maxEdge <= maxDeg || depth >= 4) {
    out.push(a[0], a[1], b[0], b[1], c[0], c[1]);
    return;
  }

  const mAB = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
  const mBC = [(b[0] + c[0]) * 0.5, (b[1] + c[1]) * 0.5];
  const mCA = [(c[0] + a[0]) * 0.5, (c[1] + a[1]) * 0.5];

  subdivideTriangle(a, mAB, mCA, maxDeg, out, depth + 1);
  subdivideTriangle(mAB, b, mBC, maxDeg, out, depth + 1);
  subdivideTriangle(mCA, mBC, c, maxDeg, out, depth + 1);
  subdivideTriangle(mAB, mBC, mCA, maxDeg, out, depth + 1);
}

/**
 * Triangulates a GeoJSON Polygon's rings (outer + holes) in (lon, lat) space
 * and subdivides triangles exceeding `maxEdgeDeg` so they wrap smoothly onto a 3D sphere.
 * Returns a flat array of [lon0, lat0, lon1, lat1, lon2, lat2, ...].
 */
export function triangulateGeoPolygon(rings, maxEdgeDeg = 6.5) {
  if (!rings || !rings.length) return [];
  let outer = cleanRing(rings[0]);
  if (outer.length < 3) return [];
  if (signedArea(outer) < 0) outer.reverse();

  // Sort holes by rightmost X descending for deterministic bridging
  const holes = [];
  for (let h = 1; h < rings.length; h++) {
    const hole = cleanRing(rings[h]);
    if (hole.length < 3) continue;
    if (signedArea(hole) > 0) hole.reverse();
    let maxX = -Infinity;
    for (const p of hole) if (p[0] > maxX) maxX = p[0];
    holes.push({ hole, maxX });
  }
  holes.sort((a, b) => b.maxX - a.maxX);

  for (const { hole } of holes) {
    outer = bridgeHole(outer, hole);
  }

  const tris = earClip(outer);
  const out = [];
  for (let i = 0; i < tris.length; i++) {
    subdivideTriangle(tris[i][0], tris[i][1], tris[i][2], maxEdgeDeg, out);
  }
  return out;
}
