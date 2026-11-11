/**
 * Pure map logic for the browser and Node: Timeline parsing, city-level
 * aggregation and SVG rendering. No DOM access, no dependencies.
 *
 * This mirrors worldmap.py exactly; tests/parity.mjs checks that both produce
 * byte-identical SVGs from the same places.json.
 */

export const PLACES_SCHEMA = "worldmap-places/v1";
export const DEFAULT_MAX_CITY_KM = 75;
export const DEFAULT_MAX_PATH_KM = 25;

export const THEMES = {
  light: {
    ocean: "#aadaff",
    land: "#f2efe9",
    coast: "#c9c3b4",
    border: "#ddd8cb",
    dot: "#e8453c",
    dot_edge: "#ffffff",
    glow: "#ff5a3c",
    halo: "#e8453c",
    ocean_hi: "#c6e7ff",
    ocean_lo: "#7cc3ef",
    globe_land: "#f2efe9",
  },
  dark: {
    ocean: "#0b1a2a",
    land: "#1b2a3a",
    coast: "#3d5268",
    border: "#2b3d51",
    dot: "#ff6b5e",
    dot_edge: "#0b1a2a",
    glow: "#ff8f6b",
    halo: "#ff6b5e",
    ocean_hi: "#173855",
    ocean_lo: "#06121d",
    globe_land: "#24405a",
  },
};

// cities.json rows: [name, region, country, iso2, population, lat, lon]
export const CITY_NAME = 0;
export const CITY_REGION = 1;
export const CITY_COUNTRY = 2;
export const CITY_ISO2 = 3;
export const CITY_POP = 4;
export const CITY_LAT = 5;
export const CITY_LON = 6;

const MAX_MERCATOR_LAT = 85.0;

// ---------------------------------------------------------------------------
// Coordinates

const NUMBER_RE = /-?\d+(?:\.\d+)?/g;

export function parseLatLng(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const nums = value.match(NUMBER_RE);
    if (nums && nums.length >= 2) {
      const lat = parseFloat(nums[0]);
      const lon = parseFloat(nums[1]);
      if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        return [lat, lon];
      }
    }
    return null;
  }
  if (typeof value === "object") {
    if (Array.isArray(value)) return null;
    for (const key of ["latLng", "LatLng", "latlng"]) {
      if (key in value) return parseLatLng(value[key]);
    }
    if ("latitudeE7" in value && "longitudeE7" in value) {
      return [value.latitudeE7 / 1e7, value.longitudeE7 / 1e7];
    }
    if ("latitude" in value && "longitude" in value) {
      return [Number(value.latitude), Number(value.longitude)];
    }
    for (const key of ["location", "point", "latLng"]) {
      if (key in value) {
        const parsed = parseLatLng(value[key]);
        if (parsed) return parsed;
      }
    }
  }
  return null;
}

function fromEpoch(number) {
  if (number > 1e14) return new Date(number / 1e3); // microseconds
  if (number > 1e11) return new Date(number); // milliseconds
  return new Date(number * 1e3); // seconds
}

const YEAR_RE = /(\d{4})/;

export function yearOf(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return yearOf(Number(trimmed));
    const match = YEAR_RE.exec(trimmed);
    return match ? Number(match[1]) : null;
  }
  if (typeof value === "number") {
    const date = fromEpoch(value);
    return Number.isNaN(date.getTime()) ? null : date.getUTCFullYear();
  }
  return null;
}

export function dayOf(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const date = fromEpoch(Number(trimmed));
    return Number.isNaN(date.getTime())
      ? null
      : date.toISOString().slice(0, 10);
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  return match ? match[1] : null;
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const radius = 6371.0088;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dphi = p2 - p1;
  const dlambda = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dphi / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dlambda / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------------------------------------------------------------------------
// Export parsing

class Sample {
  constructor(lat, lon, kind, year, day) {
    this.lat = lat;
    this.lon = lon;
    this.kind = kind; // visit | transit | path | raw
    this.year = year ?? null;
    this.day = day ?? null;
  }
}

function visitPoints(visit) {
  if (!visit || typeof visit !== "object") return [];
  const top = visit.topCandidate || {};
  for (const candidate of [
    top.placeLocation,
    top.location,
    visit.location,
    visit.placeLocation,
  ]) {
    const parsed = parseLatLng(candidate);
    if (parsed) return [parsed];
  }
  return [];
}

function activityPoints(activity) {
  if (!activity || typeof activity !== "object") return [];
  const points = [];
  for (const key of ["start", "end"]) {
    const parsed = parseLatLng(activity[key]);
    if (parsed) points.push(parsed);
  }
  return points;
}

function pathPoints(timelinePath) {
  if (!Array.isArray(timelinePath)) return [];
  const points = [];
  for (const point of timelinePath) {
    const parsed = parseLatLng(point);
    if (parsed) points.push(parsed);
  }
  return points;
}

function into(gen, document) {
  const stamp = (obj) =>
    obj ? obj.startTime || obj.endTime || obj.timestamp : null;
  const push = (lat, lon, kind, value) => {
    gen.push(new Sample(lat, lon, kind, yearOf(value), dayOf(value)));
  };

  if (Array.isArray(document)) {
    // iPhone location-history.json
    for (const entry of document) {
      if (!entry || typeof entry !== "object") continue;
      const when = stamp(entry);
      for (const [lat, lon] of visitPoints(entry.visit))
        push(lat, lon, "visit", when);
      for (const [lat, lon] of activityPoints(entry.activity))
        push(lat, lon, "transit", when);
      for (const [lat, lon] of pathPoints(entry.timelinePath))
        push(lat, lon, "path", when);
    }
    return;
  }

  if (!document || typeof document !== "object") return;

  if ("semanticSegments" in document) {
    for (const segment of document.semanticSegments || []) {
      if (!segment || typeof segment !== "object") continue;
      const when = stamp(segment);
      for (const [lat, lon] of visitPoints(segment.visit))
        push(lat, lon, "visit", when);
      for (const [lat, lon] of activityPoints(segment.activity))
        push(lat, lon, "transit", when);
      for (const [lat, lon] of pathPoints(segment.timelinePath))
        push(lat, lon, "path", when);
    }
    for (const signal of document.rawSignals || []) {
      if (!signal || typeof signal !== "object") continue;
      const position = signal.position;
      if (!position || typeof position !== "object") continue;
      const parsed = parseLatLng(position);
      if (!parsed) continue;
      push(
        parsed[0],
        parsed[1],
        "raw",
        position.timestamp || signal.timestamp || position.time,
      );
    }
    return;
  }

  if ("locations" in document) {
    // Legacy Takeout Records.json / Location History.json
    for (const record of document.locations || []) {
      const parsed = parseLatLng(record);
      if (!parsed) continue;
      push(
        parsed[0],
        parsed[1],
        "raw",
        record.timestampMs || record.timestamp,
      );
    }
    return;
  }

  if ("timelineObjects" in document) {
    // Legacy Takeout Semantic Location History
    for (const obj of document.timelineObjects || []) {
      if (!obj || typeof obj !== "object") continue;
      const visit = obj.placeVisit || {};
      const duration = visit.duration || {};
      const when = duration.startTimestampMs || duration.startTimestamp;
      for (const [lat, lon] of visitPoints(visit)) push(lat, lon, "visit", when);
      const segment = obj.activitySegment || {};
      const segDuration = segment.duration || {};
      const segWhen =
        segDuration.startTimestampMs || segDuration.startTimestamp;
      for (const key of ["startLocation", "endLocation"]) {
        const parsed = parseLatLng(segment[key]);
        if (parsed) push(parsed[0], parsed[1], "transit", segWhen);
      }
    }
  }
}

export function samplesFromDocument(document) {
  const out = [];
  into(out, document);
  return out;
}

/** Split a file that may contain several concatenated JSON documents. */
export function splitJsonDocuments(text) {
  try {
    return [JSON.parse(text)];
  } catch {
    // Android exports can concatenate one object per year with no separator.
  }
  const docs = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (index >= text.length) break;
    const start = index;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; index < text.length; index += 1) {
      const ch = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
    }
    const slice = text.slice(start, index);
    try {
      docs.push(JSON.parse(slice));
    } catch {
      throw new Error(
        `invalid JSON at offset ${start}; re-export Timeline from the phone`,
      );
    }
  }
  return docs;
}

export function iterSamples(text) {
  const samples = [];
  for (const document of splitJsonDocuments(text)) {
    into(samples, document);
  }
  return samples;
}

// ---------------------------------------------------------------------------
// City lookup

export class CityIndex {
  constructor(rows) {
    this.rows = rows;
    this.cells = new Map();
    rows.forEach((row, index) => {
      const key = `${Math.floor(row[CITY_LAT])},${Math.floor(row[CITY_LON])}`;
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(index);
      else this.cells.set(key, [index]);
    });
    this.cache = new Map();
  }

  nearest(lat, lon, maxKm) {
    const key = `${Math.round(lat * 20)},${Math.round(lon * 20)},${maxKm}`;
    if (this.cache.has(key)) {
      const row = this.cache.get(key);
      if (!row) return null;
      const km = haversineKm(lat, lon, row[CITY_LAT], row[CITY_LON]);
      return km > maxKm ? null : [row, km];
    }

    let best = null;
    let bestKm = Infinity;
    const baseLat = Math.floor(lat);
    const baseLon = Math.floor(lon);
    const latSpan = Math.trunc(maxKm / 111.0) + 1;
    const cosLat = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
    const lonSpan = Math.trunc(maxKm / (111.0 * cosLat)) + 1;
    for (let dlat = -latSpan; dlat <= latSpan; dlat += 1) {
      if (best !== null && (Math.abs(dlat) - 1) * 111.0 > bestKm) continue;
      for (let dlon = -lonSpan; dlon <= lonSpan; dlon += 1) {
        const cellLon = (((baseLon + dlon + 180) % 360) + 360) % 360 - 180;
        const bucket = this.cells.get(`${baseLat + dlat},${cellLon}`);
        if (!bucket) continue;
        for (const index of bucket) {
          const row = this.rows[index];
          const km = haversineKm(lat, lon, row[CITY_LAT], row[CITY_LON]);
          if (km < bestKm) {
            best = row;
            bestKm = km;
          }
        }
      }
    }
    this.cache.set(key, best);
    return best === null || bestKm > maxKm ? null : [best, bestKm];
  }
}

// ---------------------------------------------------------------------------
// Aggregation

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function formatG(value) {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(6)));
}

export function buildPlaces(samples, cityIndex, options = {}) {
  const maxKm = options.maxKm ?? DEFAULT_MAX_CITY_KM;
  const minVisits = options.minVisits ?? 1;
  const maxPathKm = options.maxPathKm ?? DEFAULT_MAX_PATH_KM;

  const aggregates = new Map();
  let resolved = 0;
  let skipped = 0;
  for (const sample of samples) {
    if (
      !(sample.lat >= -90 && sample.lat <= 90) ||
      !(sample.lon >= -180 && sample.lon <= 180)
    ) {
      continue;
    }
    const limit = sample.kind === "path" || sample.kind === "raw" ? maxPathKm : maxKm;
    const match = cityIndex.nearest(sample.lat, sample.lon, limit);
    if (!match) {
      skipped += 1;
      continue;
    }
    const row = match[0];
    const key = JSON.stringify([
      row[CITY_NAME],
      row[CITY_REGION],
      row[CITY_ISO2],
      row[CITY_LAT],
      row[CITY_LON],
    ]);
    let aggregate = aggregates.get(key);
    if (!aggregate) {
      aggregate = {
        row,
        visits: 0,
        days: new Set(),
        firstYear: null,
        lastYear: null,
      };
      aggregates.set(key, aggregate);
    }
    const newDay = Boolean(sample.day) && !aggregate.days.has(sample.day);
    if (sample.kind === "visit" || sample.kind === "transit") {
      aggregate.visits += 1;
    } else if (newDay) {
      aggregate.visits += 1;
    }
    if (sample.day) aggregate.days.add(sample.day);
    if (sample.year != null) {
      if (aggregate.firstYear === null || sample.year < aggregate.firstYear) {
        aggregate.firstYear = sample.year;
      }
      if (aggregate.lastYear === null || sample.year > aggregate.lastYear) {
        aggregate.lastYear = sample.year;
      }
    }
    resolved += 1;
  }

  const cities = [];
  for (const aggregate of aggregates.values()) {
    if (aggregate.visits < minVisits) continue;
    const row = aggregate.row;
    cities.push({
      city: row[CITY_NAME],
      region: row[CITY_REGION],
      country: row[CITY_COUNTRY],
      country_code: row[CITY_ISO2],
      lat: Math.round(row[CITY_LAT] * 100) / 100,
      lon: Math.round(row[CITY_LON] * 100) / 100,
      visits: aggregate.visits,
      days: aggregate.days.size,
      first_year: aggregate.firstYear,
      last_year: aggregate.lastYear,
    });
  }
  cities.sort((a, b) =>
    compareKeys(
      [a.country, a.region, a.city, a.lon],
      [b.country, b.region, b.city, b.lon],
    ),
  );
  return {
    document: {
      schema: PLACES_SCHEMA,
      note:
        "City-level only, generated by worldmap.py from a private Google " +
        "Timeline export. Raw positions, addresses and place names are " +
        "discarded at import time; coordinates are gazetteer city centres, not " +
        `the original samples (visit cutoff ${formatG(maxKm)} km, path cutoff ` +
        `${formatG(maxPathKm)} km).`,
      max_city_km: maxKm,
      max_path_km: maxPathKm,
      stats: { samples: resolved + skipped, resolved, unmatched: skipped },
      cities,
    },
    stats: { samples: resolved + skipped, resolved, unmatched: skipped },
  };
}

// ---------------------------------------------------------------------------
// Rendering

function mercatorY(lat) {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

export class Projection {
  constructor(width, west = -180, east = 180, south = -58, north = 78) {
    this.width = width;
    this.west = west;
    this.east = east;
    this.southLat = south;
    this.northLat = north;
    this.north = mercatorY(north);
    this.south = mercatorY(south);
    this.height = round2((width * (this.north - this.south)) / (2 * Math.PI));
  }

  point(lat, lon) {
    const x = ((lon - this.west) / (this.east - this.west)) * this.width;
    const y =
      ((this.north - mercatorY(lat)) / (this.north - this.south)) * this.height;
    return [x, y];
  }
}

const f1 = (value) => value.toFixed(1);
const f2 = (value) => value.toFixed(2);

function ringPath(ring, projection) {
  const subpaths = [];
  let current = [];
  let previousLon = null;
  for (const [lon, lat] of ring) {
    if (previousLon !== null && Math.abs(lon - previousLon) > 180) {
      if (current.length) subpaths.push(current);
      current = [];
    }
    current.push(projection.point(lat, lon));
    previousLon = lon;
  }
  if (current.length) subpaths.push(current);

  const parts = [];
  for (const subpath of subpaths) {
    if (subpath.length < 3) continue;
    parts.push(
      "M " + subpath.map(([x, y]) => `${f1(x)} ${f1(y)}`).join(" L ") + " Z",
    );
  }
  return parts.join(" ");
}

function landPaths(land, projection) {
  const paths = [];
  for (const polygon of land.coordinates) {
    const segments = [];
    for (const ring of polygon) {
      if (!ring.length) continue;
      let minLon = Infinity;
      let maxLon = -Infinity;
      let minLat = Infinity;
      let maxLat = -Infinity;
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      if (maxLon < projection.west || minLon > projection.east) continue;
      if (maxLat < projection.southLat || minLat > projection.northLat) continue;
      const path = ringPath(ring, projection);
      if (path) segments.push(path);
    }
    if (segments.length) paths.push(segments.join(" "));
  }
  return paths;
}

function linesPath(lines, projection) {
  const parts = [];
  for (const line of lines) {
    let current = [];
    let previousLon = null;
    for (const [lon, lat] of line) {
      if (previousLon !== null && Math.abs(lon - previousLon) > 180) {
        if (current.length >= 2) {
          parts.push(
            "M " + current.map(([x, y]) => `${f1(x)} ${f1(y)}`).join(" L "),
          );
        }
        current = [];
      }
      current.push(projection.point(lat, lon));
      previousLon = lon;
    }
    if (current.length >= 2) {
      parts.push("M " + current.map(([x, y]) => `${f1(x)} ${f1(y)}`).join(" L "));
    }
  }
  return parts.join(" ");
}

function flatLayers(cities, land, projection, theme, borders) {
  const paths = landPaths(land, projection).join(" ");
  const borderPath = linesPath(borders, projection);
  const dots = cities
    .slice()
    .sort((a, b) => a.lat - b.lat || a.lon - b.lon)
    .map((city) => {
      const [x, y] = projection.point(city.lat, city.lon);
      return `<circle cx="${f1(x)}" cy="${f1(y)}" r="4.2" fill="${theme.dot}" stroke="${theme.dot_edge}" stroke-width="1.2"/>`;
    });
  return (
    `  <g fill="${theme.land}" stroke="${theme.coast}" stroke-width="0.7" fill-rule="evenodd">\n` +
    `    <path d="${paths}"/>\n` +
    "  </g>\n" +
    `  <g fill="none" stroke="${theme.border}" stroke-width="0.6">\n` +
    `    <path d="${borderPath}"/>\n` +
    "  </g>\n" +
    `  <g>\n    ${dots.join("\n    ")}\n  </g>\n`
  );
}

function svgOpen(width, height, title, description) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${f2(height)}" ` +
    `viewBox="0 0 ${width} ${f2(height)}" role="img" aria-labelledby="map-title map-desc">\n` +
    `  <title id="map-title">${title}</title>\n` +
    `  <desc id="map-desc">${description}</desc>\n`
  );
}

export function renderSvg(cities, land, themeName = "light", options = {}) {
  const theme = THEMES[themeName];
  const width = options.width ?? 1280;
  const borders = options.borders ?? [];
  const projection = new Projection(width);
  const height = projection.height;
  const title = "Travel map";
  const description =
    "World map with red dots marking cities the owner has lived in, visited " +
    "or transited through, generated at city level.";
  return (
    svgOpen(width, height, title, description) +
    `  <rect width="${width}" height="${f2(height)}" fill="${theme.ocean}"/>\n` +
    flatLayers(cities, land, projection, theme, borders) +
    "</svg>\n"
  );
}

// ---------------------------------------------------------------------------
// Drift rendering

export function renderDriftSvg(cities, land, themeName = "light", options = {}) {
  const theme = THEMES[themeName];
  const width = options.width ?? 1280;
  const borders = options.borders ?? [];
  const duration = options.duration ?? 60;
  const projection = new Projection(width);
  const height = projection.height;
  const layer = flatLayers(cities, land, projection, theme, borders);
  const style =
    "<style>\n" +
    "@media (prefers-reduced-motion:no-preference){\n" +
    `.drift{animation:drift ${duration.toFixed(1)}s linear infinite}\n` +
    `@keyframes drift{from{transform:translateX(0)}to{transform:translateX(-${width}px)}}\n` +
    "}\n" +
    "</style>\n";
  const title = "Travel map";
  const description =
    "World map with red dots marking cities lived in, visited or transited " +
    "through, slowly panning eastward.";
  const body =
    '  <g class="drift">\n' +
    layer +
    `    <g transform="translate(${width},0)">\n` +
    layer +
    "    </g>\n" +
    "  </g>\n";
  return (
    svgOpen(width, height, title, description) +
    style +
    `  <rect width="${width}" height="${f2(height)}" fill="${theme.ocean}"/>\n` +
    body +
    "</svg>\n"
  );
}

// ---------------------------------------------------------------------------
// Globe rendering

export const GLOBE_TILT = 20;

export function spherePoint(lat, lon, lon0, lat0 = GLOBE_TILT) {
  const phi = (lat * Math.PI) / 180;
  const lam = ((lon - lon0) * Math.PI) / 180;
  const phi0 = (lat0 * Math.PI) / 180;
  const x = Math.cos(phi) * Math.sin(lam);
  const y =
    Math.cos(phi0) * Math.sin(phi) -
    Math.sin(phi0) * Math.cos(phi) * Math.cos(lam);
  const z =
    Math.sin(phi0) * Math.sin(phi) +
    Math.cos(phi0) * Math.cos(phi) * Math.cos(lam);
  return [x, y, z];
}

export function limbPoint(a, b) {
  const t = a[2] / (a[2] - b[2]);
  const x = a[0] + t * (b[0] - a[0]);
  const y = a[1] + t * (b[1] - a[1]);
  const norm = Math.hypot(x, y) || 1;
  return [x / norm, y / norm];
}

export function limbArc(exitPoint, entryPoint, radius, cx, cy) {
  const a0 = Math.atan2(exitPoint[1], exitPoint[0]);
  const a1 = Math.atan2(entryPoint[1], entryPoint[0]);
  const delta = (((a1 - a0 + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  const steps = Math.max(1, Math.trunc(Math.abs(delta) / 0.12));
  const points = [];
  for (let index = 1; index < steps; index += 1) {
    const angle = a0 + (delta * index) / steps;
    points.push([cx + radius * Math.cos(angle), cy - radius * Math.sin(angle)]);
  }
  return points;
}

export function globeRing(ring, lon0, lat0, radius, cx, cy) {
  const pts = ring.map(([lon, lat]) => spherePoint(lat, lon, lon0, lat0));
  const visible = pts.map((p) => p[2] > 0);
  const n = pts.length;
  if (!visible.some(Boolean)) return [];
  if (visible.every(Boolean)) {
    return [pts.map(([x, y]) => [cx + radius * x, cy - radius * y])];
  }
  let start = 0;
  for (let i = 0; i < n; i += 1) {
    if (visible[i] && !visible[(i - 1 + n) % n]) {
      start = i;
      break;
    }
  }
  const runs = [];
  let current = [];
  for (let k = 0; k < n; k += 1) {
    const i = (start + k) % n;
    const prev = (i - 1 + n) % n;
    if (visible[i]) {
      if (!visible[prev]) {
        const [bx, by] = limbPoint(pts[prev], pts[i]);
        current.push([cx + radius * bx, cy - radius * by]);
      }
      current.push([cx + radius * pts[i][0], cy - radius * pts[i][1]]);
    } else if (visible[prev]) {
      const [bx, by] = limbPoint(pts[prev], pts[i]);
      current.push([cx + radius * bx, cy - radius * by]);
      runs.push(current);
      current = [];
    }
  }
  if (current.length) runs.push(current);
  if (!runs.length) return [];
  return runs.map((run) => {
    const exitPoint = [(run[run.length - 1][0] - cx) / radius, -(run[run.length - 1][1] - cy) / radius];
    const entryPoint = [(run[0][0] - cx) / radius, -(run[0][1] - cy) / radius];
    return run.concat(limbArc(exitPoint, entryPoint, radius, cx, cy));
  });
}

export function globeLine(line, lon0, lat0, radius, cx, cy) {
  const runs = [];
  let current = [];
  for (const [lon, lat] of line) {
    const [x, y, z] = spherePoint(lat, lon, lon0, lat0);
    if (z > 0) {
      current.push([cx + radius * x, cy - radius * y]);
    } else {
      if (current.length >= 2) runs.push(current);
      current = [];
    }
  }
  if (current.length >= 2) runs.push(current);
  return runs;
}

function pathFromRuns(runs, close, precision = 0) {
  const parts = [];
  for (const run of runs) {
    if (run.length < (close ? 3 : 2)) continue;
    parts.push(
      "M " +
        run.map(([x, y]) => `${x.toFixed(precision)} ${y.toFixed(precision)}`).join(" L ") +
        (close ? " Z" : ""),
    );
  }
  return parts.join(" ");
}

export function renderGlobeSvg(cities, land, themeName = "dark", options = {}) {
  const theme = THEMES[themeName];
  const width = options.width ?? 640;
  const borders = options.borders ?? [];
  const frames = options.frames ?? 24;
  const duration = options.duration ?? 24;
  const height = round2(width * 1.05);
  const radius = width * 0.44;
  const cx = width / 2;
  const cy = height / 2;
  const ordered = routeOrder(cities);
  const routeLinesData = routeLines(ordered);
  const { segments, total } = routeSegments(ordered);

  const framesMarkup = [];
  const frameRules = [];
  const keyframes = [];
  for (let frame = 0; frame < frames; frame += 1) {
    const progress = frames > 1 ? frame / (frames - 1) : 0;
    const camera = cameraAt(segments, total, progress);
    const [lon0, lat0] = camera ?? [0, GLOBE_TILT];
    const landRuns = [];
    for (const polygon of land.coordinates) {
      for (const ring of polygon) {
        landRuns.push(...globeRing(ring, lon0, lat0, radius, cx, cy));
      }
    }
    const borderRuns = [];
    for (const line of borders) {
      borderRuns.push(...globeLine(line, lon0, lat0, radius, cx, cy));
    }
    const routeRuns = [];
    for (const line of routeLinesData) {
      routeRuns.push(...globeLine(line, lon0, lat0, radius, cx, cy));
    }
    const dots = [];
    for (const city of cities) {
      const [x, y, z] = spherePoint(city.lat, city.lon, lon0, lat0);
      if (z > 0) {
        dots.push(
          `<circle cx="${(cx + radius * x).toFixed(0)}" cy="${(cy - radius * y).toFixed(0)}" r="3.2" fill="${theme.dot}" stroke="${theme.dot_edge}" stroke-width="1"/>`,
        );
      }
    }
    framesMarkup.push(
      `  <g class="gf gf${frame}">\n` +
        `    <path d="${pathFromRuns(landRuns, true)}" fill="${theme.globe_land ?? theme.land}" stroke="${theme.coast}" stroke-width="0.5" fill-rule="evenodd"/>\n` +
        `    <path d="${pathFromRuns(borderRuns, false)}" fill="none" stroke="${theme.border}" stroke-width="0.5"/>\n` +
        `    <path d="${pathFromRuns(routeRuns, false)}" fill="none" stroke="${theme.glow}" stroke-opacity="0.6" stroke-width="1.2"/>\n` +
        `    ${dots.join("\n    ")}\n` +
        "  </g>\n",
    );
    const startForward = frame / (2 * frames);
    const endForward = (frame + 1) / (2 * frames);
    const startBack = 1 - (frame + 1) / (2 * frames);
    const endBack = 1 - frame / (2 * frames);
    frameRules.push(
      `.gf${frame}{animation:g${frame} ${duration}s steps(1,end) infinite}`,
    );
    keyframes.push(
      `@keyframes g${frame}{0%,${fmtPercent(startForward)}%{opacity:0}` +
        `${fmtPercent(startForward)}%,${fmtPercent(endForward)}%{opacity:1}` +
        `${fmtPercent(endForward)}%,${fmtPercent(startBack)}%{opacity:0}` +
        `${fmtPercent(startBack)}%,${fmtPercent(endBack)}%{opacity:1}` +
        `${fmtPercent(endBack)}%,100%{opacity:0}}`,
    );
  }

  const style =
    "<style>\n" +
    ".gf{opacity:0}\n" +
    ".gf0{opacity:1}\n" +
    "@media (prefers-reduced-motion:no-preference){\n" +
    ".gf0{opacity:0}\n" +
    frameRules.join("\n") +
    "\n" +
    keyframes.join("\n") +
    "\n}\n" +
    "</style>\n";

  const title = "Travel globe";
  const description =
    "Rotating globe that follows a route of great-circle arcs between the " +
    "cities lived in, visited or transited through, in chronological order.";
  return (
    svgOpen(width, height, title, description) +
    style +
    "  <defs>\n" +
    '    <radialGradient id="globe-ocean" cx="35%" cy="30%" r="75%">\n' +
    `      <stop offset="0%" stop-color="${theme.ocean_hi}"/>\n` +
    `      <stop offset="100%" stop-color="${theme.ocean_lo}"/>\n` +
    "    </radialGradient>\n" +
    "  </defs>\n" +
    `  <circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${radius.toFixed(0)}" fill="url(#globe-ocean)" stroke="${theme.coast}" stroke-width="0.8"/>\n` +
    framesMarkup.join("") +
    "</svg>\n"
  );
}

// ---------------------------------------------------------------------------
// Animated rendering

export function arcPoints(start, end, stepKm = 180) {
  const [lat1d, lon1d] = start;
  const [lat2d, lon2d] = end;
  const lat1 = (lat1d * Math.PI) / 180;
  const lon1 = (lon1d * Math.PI) / 180;
  const lat2 = (lat2d * Math.PI) / 180;
  const lon2 = (lon2d * Math.PI) / 180;
  const x1 = Math.cos(lat1) * Math.cos(lon1);
  const y1 = Math.cos(lat1) * Math.sin(lon1);
  const z1 = Math.sin(lat1);
  const x2 = Math.cos(lat2) * Math.cos(lon2);
  const y2 = Math.cos(lat2) * Math.sin(lon2);
  const z2 = Math.sin(lat2);
  const dot = Math.max(-1, Math.min(1, x1 * x2 + y1 * y2 + z1 * z2));
  const angle = Math.acos(dot);
  if (angle < 1e-9) return [start, end];
  const distanceKm = angle * 6371.0088;
  const steps = Math.max(2, Math.min(600, Math.trunc(distanceKm / stepKm) + 1));
  const points = [];
  const sinAngle = Math.sin(angle);
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const a = Math.sin((1 - t) * angle) / sinAngle;
    const b = Math.sin(t * angle) / sinAngle;
    const x = a * x1 + b * x2;
    const y = a * y1 + b * y2;
    const z = a * z1 + b * z2;
    const norm = Math.sqrt(x * x + y * y + z * z) || 1;
    points.push([
      (Math.asin(Math.max(-1, Math.min(1, z / norm))) * 180) / Math.PI,
      (Math.atan2(y, x) * 180) / Math.PI,
    ]);
  }
  return points;
}

function routeLines(cities) {
  const lines = [];
  for (let i = 0; i < cities.length - 1; i += 1) {
    lines.push(
      arcPoints(
        [cities[i].lat, cities[i].lon],
        [cities[i + 1].lat, cities[i + 1].lon],
      ).map(([lat, lon]) => [lon, lat]),
    );
  }
  return lines;
}

export function routeSegments(cities) {
  const segments = [];
  let total = 0;
  for (let i = 0; i < cities.length - 1; i += 1) {
    const points = arcPoints(
      [cities[i].lat, cities[i].lon],
      [cities[i + 1].lat, cities[i + 1].lon],
    );
    let distance = 0;
    for (let j = 1; j < points.length; j += 1) {
      distance += haversineKm(
        points[j - 1][0],
        points[j - 1][1],
        points[j][0],
        points[j][1],
      );
    }
    segments.push({ points, distance });
    total += distance;
  }
  return { segments, total };
}

export function routePointAt(segments, total, progress) {
  if (!segments.length || total <= 0) return null;
  let target = progress * total;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const last = index === segments.length - 1;
    if (target <= segment.distance || last) {
      const fraction = segment.distance ? Math.min(1, target / segment.distance) : 0;
      const step = Math.round(fraction * (segment.points.length - 1));
      return segment.points[Math.min(segment.points.length - 1, step)];
    }
    target -= segment.distance;
  }
  return null;
}

export function cameraAt(segments, total, progress) {
  if (!segments.length || total <= 0) return null;
  let target = progress * total;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const last = index === segments.length - 1;
    if (target <= segment.distance || last) {
      const fraction = segment.distance ? Math.min(1, target / segment.distance) : 0;
      const step = Math.round(fraction * (segment.points.length - 1));
      const [lat, lon] = segment.points[Math.min(segment.points.length - 1, step)];
      return [lon, Math.max(-38, Math.min(38, lat))];
    }
    target -= segment.distance;
  }
  return null;
}

export function routeOrder(cities) {
  return cities.slice().sort((a, b) => {
    const ay = a.first_year == null ? 9999 : a.first_year;
    const by = b.first_year == null ? 9999 : b.first_year;
    return compareKeys(
      [ay, -(a.visits || 0), a.country_code, a.city, a.lon],
      [by, -(b.visits || 0), b.country_code, b.city, b.lon],
    );
  });
}

function routeLegs(cities, projection) {
  const legs = [];
  for (let i = 0; i < cities.length - 1; i += 1) {
    const points = arcPoints(
      [cities[i].lat, cities[i].lon],
      [cities[i + 1].lat, cities[i + 1].lon],
    );
    const subpaths = [];
    let current = [];
    let previousLon = null;
    for (const [lat, lon] of points) {
      if (previousLon !== null && Math.abs(lon - previousLon) > 180) {
        if (current.length >= 2) subpaths.push(current);
        current = [];
      }
      current.push(projection.point(lat, lon));
      previousLon = lon;
    }
    if (current.length >= 2) subpaths.push(current);

    for (const subpath of subpaths) {
      const path =
        "M " + subpath.map(([x, y]) => `${f1(x)} ${f1(y)}`).join(" L ");
      let length = 0;
      for (let j = 1; j < subpath.length; j += 1) {
        const [x1, y1] = subpath[j - 1];
        const [x2, y2] = subpath[j];
        length += Math.hypot(x2 - x1, y2 - y1);
      }
      if (length > 4) legs.push([path, length]);
    }
  }
  return legs;
}

export function fmtPercent(fraction) {
  const text = (fraction * 100).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return text || "0";
}

function legKeyframes(index, legs, dashes) {
  const length = legs[index][1];
  const dash = dashes[index];
  const n = Math.max(1, legs.length);
  const park = Math.trunc(dash + 1);
  const end = Math.trunc(-(length + 1));
  const times = [
    0,
    index / (2 * n),
    (index + 1) / (2 * n),
    0.5 + (n - 1 - index) / (2 * n),
    0.5 + (n - index) / (2 * n),
    1,
  ];
  const values = [park, park, end, end, park, park];
  const steps = times
    .map((time, i) => `${fmtPercent(time)}%{stroke-dashoffset:${values[i]}}`)
    .join("");
  return `@keyframes leg${index}{${steps}}`;
}

export function renderAnimatedSvg(
  cities,
  land,
  themeName = "dark",
  options = {},
) {
  const theme = THEMES[themeName];
  const width = options.width ?? 1280;
  const borders = options.borders ?? [];
  const duration = options.duration ?? 90;
  const projection = new Projection(width);
  const height = projection.height;

  const landPathData = landPaths(land, projection).join(" ");
  const borderPath = linesPath(borders, projection);
  const ordered = routeOrder(cities);
  const route = linesPath(routeLines(ordered), projection);
  const legs = routeLegs(ordered, projection);

  const halos = [];
  const dots = [];
  const total = Math.max(1, ordered.length - 1);
  const half = duration / 2;
  ordered.forEach((city, index) => {
    const [x, y] = projection.point(city.lat, city.lon);
    const delay = ((index / total) * half) % 4.5;
    halos.push(
      `<circle class="halo" cx="${f1(x)}" cy="${f1(y)}" r="12" fill="${theme.halo}" style="animation-delay:${delay.toFixed(2)}s"/>`,
    );
    dots.push(
      `<circle cx="${f1(x)}" cy="${f1(y)}" r="4.2" fill="${theme.dot}" stroke="${theme.dot_edge}" stroke-width="1.2"/>`,
    );
  });

  const legMarkup = [];
  legs.forEach(([path], index) => {
    legMarkup.push(`<path class="leg leg${index} glow" d="${path}"/>`);
    legMarkup.push(`<path class="leg leg${index}" d="${path}"/>`);
  });

  const dashes = legs.map(([, length]) => Math.max(20, Math.min(46, length * 0.35)));
  const keyframes = legs
    .map((_, index) => legKeyframes(index, legs, dashes))
    .join("");
  const legNames = legs
    .map(
      ([, length], index) =>
        `.leg${index}{animation-name:leg${index};stroke-dasharray:${Math.trunc(dashes[index])} ${Math.trunc(length + dashes[index])};stroke-dashoffset:${Math.trunc(dashes[index] + 1)}}`,
    )
    .join("");
  const style =
    "<style>\n" +
    `.leg{fill:none;stroke:${theme.glow};stroke-width:2.2;stroke-linecap:round}\n` +
    ".leg.glow{stroke-width:7;opacity:.5;filter:url(#soft)}\n" +
    ".halo{opacity:.10}\n" +
    "@media (prefers-reduced-motion:no-preference){\n" +
    `.leg{animation-duration:${duration.toFixed(1)}s;animation-timing-function:linear;animation-iteration-count:infinite}\n` +
    `${legNames}\n` +
    ".halo{animation:twinkle 4.5s ease-in-out infinite}\n" +
    `${keyframes}\n` +
    "@keyframes twinkle{0%,100%{opacity:.10}50%{opacity:.5}}\n" +
    "}\n" +
    "</style>\n";

  const title = "Travel map";
  const description =
    "World map of cities the owner has lived in, visited or transited " +
    "through, with glowing route lines that travel through them in " +
    "chronological order and back.";
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${f2(height)}" ` +
    `viewBox="0 0 ${width} ${f2(height)}" role="img" aria-labelledby="map-title map-desc">\n` +
    `  <title id="map-title">${title}</title>\n` +
    `  <desc id="map-desc">${description}</desc>\n` +
    `  ${style}` +
    "  <defs>\n" +
    '    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">\n' +
    '      <feGaussianBlur stdDeviation="3.2"/>\n' +
    "    </filter>\n" +
    "  </defs>\n" +
    `  <rect width="${width}" height="${f2(height)}" fill="${theme.ocean}"/>\n` +
    `  <g fill="${theme.land}" stroke="${theme.coast}" stroke-width="0.7" fill-rule="evenodd">\n` +
    `    <path d="${landPathData}"/>\n` +
    "  </g>\n" +
    `  <g fill="none" stroke="${theme.border}" stroke-width="0.6">\n` +
    `    <path d="${borderPath}"/>\n` +
    "  </g>\n" +
    `  <g fill="none" stroke="${theme.glow}" stroke-opacity="0.18" stroke-width="1.2">\n` +
    `    <path d="${route}"/>\n` +
    "  </g>\n" +
    `  <g>\n    ${halos.join("\n    ")}\n  </g>\n` +
    `  <g>\n    ${legMarkup.join("\n    ")}\n  </g>\n` +
    `  <g>\n    ${dots.join("\n    ")}\n  </g>\n` +
    "</svg>\n"
  );
}
