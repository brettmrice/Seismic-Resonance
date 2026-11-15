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

export async function fetchEarthquakes(feedKey = 'all_day') {
  const url = FEED_URLS[feedKey] || FEED_URLS.all_day;
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`USGS feed error: HTTP ${response.status}`);
  }
  const data = await response.json();
  const events = (data.features || [])
    .map(normalizeFeature)
    .filter((q) => Number.isFinite(q.lat) && Number.isFinite(q.lon))
    .sort((a, b) => a.time - b.time); // Chronological oldest -> newest

  return {
    events,
    generated: data.metadata?.generated || Date.now(),
    title: data.metadata?.title || 'USGS Earthquakes',
  };
}
