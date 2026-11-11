/**
 * Browser front-end: file input (JSON or zip), client-side parsing, preview and
 * downloads. All parsing and rendering happens in this tab via js/worldmap.js.
 */

import {
  arcPoints,
  buildPlaces,
  CityIndex,
  GLOBE_TILT,
  globeLine,
  globeRing,
  haversineKm,
  iterSamples,
  renderAnimatedSvg,
  renderDriftSvg,
  renderGlobeSvg,
  renderSvg,
  routeOrder,
  spherePoint,
  THEMES,
} from "./worldmap.js";

const $ = (id) => document.getElementById(id);

const state = {
  land: null,
  coarse: null,
  borders: null,
  cities: null,
  urls: [],
  places: null,
  mode: "flat",
  globe: {
    lon0: 0,
    speed: 14,
    paused: false,
    dragging: false,
    lastX: 0,
    raf: null,
    last: 0,
    ordered: null,
    segments: null,
    total: 0,
  },
};

const SNIPPET = `<picture>
  <source media="(prefers-color-scheme: dark)" srcset="worldmap-animated-dark.svg">
  <img alt="World map of places lived, visited and transited through" src="worldmap-animated-light.svg" width="100%">
</picture>`;

// ---------------------------------------------------------------------------
// Boot

async function loadData() {
  const base = new URL("../data/", import.meta.url);
  const [cities, land, coarse, borders] = await Promise.all([
    fetch(new URL("cities.json", base)).then((r) => r.json()),
    fetch(new URL("world-land.json", base)).then((r) => r.json()),
    fetch(new URL("world-land-coarse.json", base)).then((r) => r.json()),
    fetch(new URL("world-borders.json", base)).then((r) => r.json()),
  ]);
  state.cities = new CityIndex(cities);
  state.land = land;
  state.coarse = coarse;
  state.borders = borders;
}

// ---------------------------------------------------------------------------
// Input

function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function readExport(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".zip") || file.type === "application/zip") {
    return readZip(await file.arrayBuffer());
  }
  return file.text();
}

/** Minimal zip reader: enough for the Maps app's export archive. */
async function readZip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= floor; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This file is not a readable .zip archive.");

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  let fallback = null;

  for (let entry = 0; entry < count; entry += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    offset += 46 + nameLength + extraLength + commentLength;

    if (!name.toLowerCase().endsWith(".json")) continue;
    if (view.getUint32(localOffset, true) !== 0x04034b50) continue;
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + compressedSize);

    let text;
    if (method === 0) {
      text = new TextDecoder().decode(data);
    } else if (method === 8) {
      if (typeof DecompressionStream === "undefined") {
        throw new Error(
          "This browser cannot unzip. Unzip the file first, then choose the .json inside.",
        );
      }
      const stream = new Blob([data])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw"));
      text = await new Response(stream).text();
    } else {
      continue;
    }

    if (/timeline|location-history|records|semantic/i.test(name)) return text;
    if (fallback === null) fallback = text;
  }
  if (fallback !== null) return fallback;
  throw new Error("No JSON file was found inside the zip.");
}

// ---------------------------------------------------------------------------
// Generate

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resetDownloads() {
  for (const url of state.urls) URL.revokeObjectURL(url);
  state.urls = [];
  $("downloads").replaceChildren();
}

function addDownload(name, text, label, type = "image/svg+xml") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  state.urls.push(url);
  const li = document.createElement("li");
  const left = document.createElement("span");
  left.className = "name";
  left.textContent = name;
  const size = document.createElement("span");
  size.className = "size";
  size.textContent = formatBytes(blob.size);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.textContent = label || "Download";
  li.append(left, size, link);
  $("downloads").append(li);
}

function themeForPreview() {
  const choice = $("theme").value;
  if (choice === "light" || choice === "dark") return choice;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function showPreview() {
  const theme = themeForPreview();
  const svg =
    theme === "dark" ? state.svgAnimatedDark : state.svgAnimatedLight;
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  state.urls.push(url);
  $("preview").src = url;
}

async function generate(file) {
  if (!state.cities) {
    setStatus("Loading basemap data…");
    await loadData();
  }
  setStatus(`Reading ${file.name}…`);
  await nextTick();

  const text = await readExport(file);
  if (!text || !text.trim()) throw new Error("The file is empty.");

  setStatus("Parsing export and snapping to cities…");
  await nextTick();
  const samples = iterSamples(text);
  if (!samples.length) {
    throw new Error(
      "No location samples found. Is this a Timeline export from the Maps app?",
    );
  }

  const { document: places } = buildPlaces(samples, state.cities);
  if (!places.cities.length) {
    throw new Error("No cities resolved from this export.");
  }

  setStatus(`Drawing ${places.cities.length} cities…`);
  await nextTick();
  const svgLight = renderSvg(places.cities, state.land, "light", {
    borders: state.borders,
  });
  const svgDark = renderSvg(places.cities, state.land, "dark", {
    borders: state.borders,
  });
  const svgAnimatedLight = renderAnimatedSvg(
    places.cities,
    state.land,
    "light",
    { borders: state.borders },
  );
  const svgAnimatedDark = renderAnimatedSvg(
    places.cities,
    state.land,
    "dark",
    { borders: state.borders },
  );

  state.places = places;
  state.svgAnimatedLight = svgAnimatedLight;
  state.svgAnimatedDark = svgAnimatedDark;
  buildGlobeRoute(places.cities);

  resetDownloads();
  addDownload("worldmap-animated-light.svg", svgAnimatedLight);
  addDownload("worldmap-animated-dark.svg", svgAnimatedDark);
  addDownload("worldmap-light.svg", svgLight);
  addDownload("worldmap-dark.svg", svgDark);
  const previewTheme = themeForPreview();
  addDownload(
    `worldmap-drift-${previewTheme}.svg`,
    renderDriftSvg(places.cities, state.land, previewTheme, {
      borders: state.borders,
    }),
  );
  addDownload(
    `worldmap-globe-${previewTheme}.svg`,
    renderGlobeSvg(places.cities, state.coarse, previewTheme, {
      borders: state.borders,
    }),
  );
  addDownload(
    "places.json",
    JSON.stringify(places, null, 2) + "\n",
    "Download",
    "application/json",
  );

  const years = places.cities
    .map((city) => city.first_year)
    .filter((year) => year != null);
  const range = years.length
    ? `${Math.min(...years)}–${Math.max(...years)}`
    : "years unknown";
  const countries = new Set(places.cities.map((city) => city.country)).size;
  $("summary").textContent =
    `${places.cities.length} cities in ${countries} countries · ${range} · ` +
    `${samples.length.toLocaleString()} samples reduced to city level. ` +
    `Raw coordinates are not in any file below.`;

  showPreview();
  $("result").hidden = false;
  setStatus("Done. Preview and downloads below.");
  $("result").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------------------------------------------------------------------------
// Interactive globe (canvas preview)

function buildGlobeRoute(cities) {
  const ordered = routeOrder(cities);
  const segments = [];
  let total = 0;
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const points = arcPoints(
      [ordered[i].lat, ordered[i].lon],
      [ordered[i + 1].lat, ordered[i + 1].lon],
    );
    let dist = 0;
    for (let j = 1; j < points.length; j += 1) {
      dist += haversineKm(
        points[j - 1][0],
        points[j - 1][1],
        points[j][0],
        points[j][1],
      );
    }
    segments.push({ points, dist });
    total += dist;
  }
  Object.assign(state.globe, { ordered, segments, total });
}

function cometPosition(now) {
  const g = state.globe;
  if (!g.total || !g.segments.length) return null;
  const cycle = 46; // seconds for one one-way pass
  const phase = (now / 1000) % (cycle * 2);
  const t = phase <= cycle ? phase / cycle : 2 - phase / cycle;
  let remaining = t * g.total;
  for (const segment of g.segments) {
    if (remaining <= segment.dist || segment === g.segments[g.segments.length - 1]) {
      const fraction = segment.dist ? Math.min(1, remaining / segment.dist) : 0;
      const index = Math.min(
        segment.points.length - 1,
        Math.round(fraction * (segment.points.length - 1)),
      );
      return segment.points[index];
    }
    remaining -= segment.dist;
  }
  return null;
}

function traceRuns(ctx, runs) {
  for (const run of runs) {
    run.forEach(([x, y], index) => {
      if (index) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.closePath();
  }
}

function drawGlobe(now) {
  const canvas = $("globe");
  if (!state.places || !state.coarse) return;
  const cssWidth = canvas.clientWidth || 640;
  const cssHeight = cssWidth * 1.05;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(cssWidth * dpr)) {
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const theme = THEMES[themeForPreview()];
  const radius = cssWidth * 0.44;
  const cx = cssWidth / 2;
  const cy = cssHeight / 2;
  const g = state.globe;

  const ocean = ctx.createRadialGradient(
    cx - radius * 0.3,
    cy - radius * 0.35,
    radius * 0.1,
    cx,
    cy,
    radius,
  );
  ocean.addColorStop(0, theme.ocean_hi);
  ocean.addColorStop(1, theme.ocean_lo);
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = ocean;
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();

  ctx.beginPath();
  for (const polygon of state.coarse.coordinates) {
    for (const ring of polygon) {
      traceRuns(ctx, globeRing(ring, g.lon0, GLOBE_TILT, radius, cx, cy));
    }
  }
  ctx.fillStyle = theme.globe_land || theme.land;
  ctx.fill("evenodd");
  ctx.strokeStyle = theme.coast;
  ctx.lineWidth = 0.6;
  ctx.stroke();

  ctx.beginPath();
  for (const line of state.borders) {
    for (const run of globeLine(line, g.lon0, GLOBE_TILT, radius, cx, cy)) {
      run.forEach(([x, y], index) => {
        if (index) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
    }
  }
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 0.5;
  ctx.stroke();

  ctx.beginPath();
  for (const segment of g.segments) {
    const line = segment.points.map(([lat, lon]) => [lon, lat]);
    for (const run of globeLine(line, g.lon0, GLOBE_TILT, radius, cx, cy)) {
      run.forEach(([x, y], index) => {
        if (index) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
    }
  }
  ctx.strokeStyle = theme.glow;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1.3;
  ctx.stroke();
  ctx.globalAlpha = 1;

  for (const city of state.places.cities) {
    const [x, y, z] = spherePoint(city.lat, city.lon, g.lon0, GLOBE_TILT);
    if (z <= 0) continue;
    ctx.beginPath();
    ctx.arc(cx + radius * x, cy - radius * y, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = theme.dot;
    ctx.fill();
    ctx.strokeStyle = theme.dot_edge;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  const comet = cometPosition(now);
  if (comet) {
    const [x, y, z] = spherePoint(comet[0], comet[1], g.lon0, GLOBE_TILT);
    if (z > 0) {
      ctx.save();
      ctx.shadowColor = theme.glow;
      ctx.shadowBlur = 16;
      ctx.fillStyle = theme.glow;
      ctx.beginPath();
      ctx.arc(cx + radius * x, cy - radius * y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
  ctx.restore();
}

function globeTick(now) {
  const g = state.globe;
  const dt = g.last ? Math.min(0.05, (now - g.last) / 1000) : 0;
  g.last = now;
  if (!g.paused && !g.dragging) g.lon0 = (g.lon0 + g.speed * dt) % 360;
  drawGlobe(now);
  g.raf = requestAnimationFrame(globeTick);
}

function startGlobe() {
  if (!state.globe.raf) {
    state.globe.last = 0;
    state.globe.raf = requestAnimationFrame(globeTick);
  }
}

function stopGlobe() {
  if (state.globe.raf) {
    cancelAnimationFrame(state.globe.raf);
    state.globe.raf = null;
  }
}

function setMode(mode) {
  state.mode = mode;
  for (const button of document.querySelectorAll(".mode")) {
    button.setAttribute("aria-selected", String(button.dataset.mode === mode));
  }
  $("flat-preview").hidden = mode !== "flat";
  $("globe-preview").hidden = mode !== "globe";
  if (mode === "globe") {
    startGlobe();
    drawGlobe(performance.now());
  } else {
    stopGlobe();
  }
}

// ---------------------------------------------------------------------------
// Wiring

const picker = $("picker");
const fileInput = $("file");

fileInput.addEventListener("change", async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  try {
    await generate(file);
  } catch (error) {
    console.error(error);
    setStatus(error.message || String(error), true);
  }
});

for (const event of ["dragenter", "dragover"]) {
  picker.addEventListener(event, (e) => {
    e.preventDefault();
    picker.classList.add("dragging");
  });
}
for (const event of ["dragleave", "drop"]) {
  picker.addEventListener(event, (e) => {
    e.preventDefault();
    picker.classList.remove("dragging");
  });
}
picker.addEventListener("drop", async (e) => {
  const file = e.dataTransfer && e.dataTransfer.files[0];
  if (!file) return;
  try {
    await generate(file);
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
});

$("theme").addEventListener("change", () => {
  if (state.places) showPreview();
});

$("snippet").textContent = SNIPPET;
$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(SNIPPET);
    $("copy").textContent = "Copied";
    setTimeout(() => {
      $("copy").textContent = "Copy snippet";
    }, 1500);
  } catch {
    $("copy").textContent = "Select the snippet and copy it";
  }
});

const repoInput = $("repo");
const uploadLink = $("upload");
const savedRepo = localStorage.getItem("gmap-repo");
if (savedRepo) repoInput.value = savedRepo;

function updateUploadLink() {
  const repo = repoInput.value.trim().replace(/^https?:\/\/github\.com\//, "");
  if (!repo) {
    uploadLink.hidden = true;
    return;
  }
  localStorage.setItem("gmap-repo", repo);
  uploadLink.href = `https://github.com/${repo}/upload/main`;
  uploadLink.textContent = `Open github.com/${repo} upload page`;
  uploadLink.hidden = false;
}
repoInput.addEventListener("input", updateUploadLink);
updateUploadLink();

for (const button of document.querySelectorAll(".mode")) {
  button.addEventListener("click", () => setMode(button.dataset.mode));
}

const globeCanvas = $("globe");
$("globe-toggle").addEventListener("click", () => {
  const g = state.globe;
  g.paused = !g.paused;
  $("globe-toggle").textContent = g.paused ? "Resume spin" : "Pause spin";
});
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  state.globe.paused = true;
  $("globe-toggle").textContent = "Resume spin";
}
globeCanvas.addEventListener("pointerdown", (event) => {
  state.globe.dragging = true;
  state.globe.lastX = event.clientX;
  globeCanvas.setPointerCapture(event.pointerId);
});
globeCanvas.addEventListener("pointermove", (event) => {
  if (!state.globe.dragging) return;
  const dx = event.clientX - state.globe.lastX;
  state.globe.lastX = event.clientX;
  state.globe.lon0 = (state.globe.lon0 - dx * 0.3) % 360;
});
for (const event of ["pointerup", "pointercancel"]) {
  globeCanvas.addEventListener(event, () => {
    state.globe.dragging = false;
  });
}

// Warm the basemap data so the first run feels instant.
loadData().catch(() => {
  setStatus(
    "Could not load basemap data. Open this page from GitHub Pages rather than a local file.",
    true,
  );
});
