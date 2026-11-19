// Real-time USGS Earthquake GeoJSON Feed Client

const FEED_URLS = {
  all_hour: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson',
  all_day: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
  '2.5_day': 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
  '4.5_week': 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson',
};

export function normalizeFeature(feature) {
  const [lon, lat, depth] = feature.geometry?.coordinates || [0, 0, 10];
  const props = feature.properties || {};
  return {
    id: feature.id,
    mag: typeof props.mag === 'number' ? props.mag : 0,
    place: props.place || 'Unknown location',
    time: props.time || Date.now(),
    url: props.url || '',
    tsunami: props.tsunami || 0,
    lon,
    lat,
    depth: typeof depth === 'number' ? depth : 10,
  };
}

export function parseGeoJsonPayload(data) {
  const events = (data?.features || [])
    .map(normalizeFeature)
    .filter((q) => Number.isFinite(q.lat) && Number.isFinite(q.lon))
    .sort((a, b) => a.time - b.time); // Chronological oldest -> newest

  return {
    events,
    generated: data?.metadata?.generated || Date.now(),
    title: data?.metadata?.title || 'USGS Earthquakes',
  };
}

export async function fetchEarthquakesFromUrl(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`USGS feed error: HTTP ${response.status}`);
  }
  const data = await response.json();
  return parseGeoJsonPayload(data);
}

export async function fetchEarthquakes(feedKey = 'all_day') {
  const url = FEED_URLS[feedKey] || FEED_URLS.all_day;
  return fetchEarthquakesFromUrl(url);
}

/**
 * Converts a local YYYY-MM-DD date string to an ISO-8601 UTC timestamp for the
 * start (00:00:00.000) or end (23:59:59.999) of that local calendar day.
 * Explicit timestamps containing 'T' are returned unchanged.
 */
function localDateBoundaryToIso(dateStr, isEnd = false) {
  if (dateStr.includes('T')) return dateStr;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = isEnd
    ? new Date(y, m - 1, d, 23, 59, 59, 999)
    : new Date(y, m - 1, d, 0, 0, 0, 0);
  return dt.toISOString();
}

/**
 * Fetches earthquakes for an explicit local date or date range via the USGS FDSN Event API.
 * @param {object} opts
 * @param {string} opts.startDate Local date ('YYYY-MM-DD') or ISO timestamp
 * @param {string} [opts.endDate] Local date ('YYYY-MM-DD') or ISO timestamp (defaults to end of startDate local day)
 * @param {number} [opts.minMag]
 * @param {number} [opts.maxMag]
 */
export async function fetchEarthquakesByRange({ startDate, endDate, minMag, maxMag } = {}) {
  if (!startDate) {
    return fetchEarthquakes('all_day');
  }
  const startIso = localDateBoundaryToIso(startDate, false);
  const effectiveEnd = endDate || startDate;
  const endIso = localDateBoundaryToIso(effectiveEnd, true);

  const params = new URLSearchParams({
    format: 'geojson',
    starttime: startIso,
    endtime: endIso,
    orderby: 'time-asc',
    limit: '20000',
  });
  if (typeof minMag === 'number' && Number.isFinite(minMag) && minMag > 0) {
    params.set('minmagnitude', String(minMag));
  }
  if (typeof maxMag === 'number' && Number.isFinite(maxMag) && maxMag < 10) {
    params.set('maxmagnitude', String(maxMag));
  }

  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?${params.toString()}`;
  return fetchEarthquakesFromUrl(url);
}

/**
 * Probes the local SQLite API served by local.py.
 * Returns null if not running locally or if the endpoint is unavailable.
 */
export async function fetchLocalDbStatus() {
  try {
    const response = await fetch('/api/usgs/status', { cache: 'no-store' });
    if (!response.ok) return null;
    const ct = response.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Queries earthquakes from the local SQLite database via /api/usgs/events.
 */
export async function fetchLocalDbEvents({
  startDate,
  endDate,
  minMag,
  maxMag,
  place,
  limit = 5000,
  order = 'asc',
} = {}) {
  const params = new URLSearchParams({
    format: 'geojson',
    order,
    limit: String(limit),
  });
  if (startDate) params.set('start', localDateBoundaryToIso(startDate, false));
  if (endDate) {
    params.set('end', localDateBoundaryToIso(endDate, true));
  } else if (startDate) {
    params.set('end', localDateBoundaryToIso(startDate, true));
  }
  if (typeof minMag === 'number' && Number.isFinite(minMag) && minMag > 0) {
    params.set('minmag', String(minMag));
  }
  if (typeof maxMag === 'number' && Number.isFinite(maxMag) && maxMag < 10) {
    params.set('maxmag', String(maxMag));
  }
  if (place && place.trim()) {
    params.set('place', place.trim());
  }

  return fetchEarthquakesFromUrl(`/api/usgs/events?${params.toString()}`);
}
