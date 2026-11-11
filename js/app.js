/**
 * Browser front-end: file input (JSON or zip), client-side parsing, preview and
 * downloads. All parsing and rendering happens in this tab via js/worldmap.js.
 */

import { buildPalette, createGifWriter, indexFrame } from "./gif.js";
import {
  arcPoints,
  buildPlaces,
  cameraAt,
  CityIndex,
  globeLine,
  globeRing,
  haversineKm,
  iterSamples,
  renderAnimatedSvg,
  renderDriftSvg,
  renderGlobeSvg,
  renderSvg,
  routeOrder,
  routePointAt,
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
  file: null,
  globe: {
    lon0: 0,
    lat0: 20,
    time: 0,
    paused: false,
    dragging: false,
    lastX: 0,
    lastInteraction: 0,
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
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.textContent = name.split(".").pop().toUpperCase();
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
  li.append(chip, left, size, link);
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
  state.file = file;
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

  const { document: places } = buildPlaces(samples, state.cities, {
    dates: $("dates").value,
  });
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

  const days = places.cities
    .map((city) => city.first_day)
    .filter((day) => day != null)
    .sort();
  const years = places.cities
    .map((city) => city.first_year)
    .filter((year) => year != null);
  let range;
  if (days.length) {
    range = `${days[0]}–${days[days.length - 1]} · anonymized dates`;
  } else if (years.length) {
    range = `${Math.min(...years)}–${Math.max(...years)}`;
  } else {
    range = "dates removed";
  }
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

function drawGlobeScene(ctx, width, height, lon0, lat0, cities, options = {}) {
  const theme = options.theme || THEMES[themeForPreview()];
  const comet = options.comet || null;
  const scale = width / 640;
  const radius = width * 0.44;
  const cx = width / 2;
  const cy = height / 2;

  ctx.clearRect(0, 0, width, height);
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
      traceRuns(ctx, globeRing(ring, lon0, lat0, radius, cx, cy));
    }
  }
  ctx.fillStyle = theme.globe_land || theme.land;
  ctx.fill("evenodd");
  ctx.strokeStyle = theme.coast;
  ctx.lineWidth = Math.max(0.6, 0.6 * scale);
  ctx.stroke();

  ctx.beginPath();
  for (const line of state.borders) {
    for (const run of globeLine(line, lon0, lat0, radius, cx, cy)) {
      run.forEach(([x, y], index) => {
        if (index) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
    }
  }
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = Math.max(0.5, 0.5 * scale);
  ctx.stroke();

  ctx.beginPath();
  for (const segment of state.globe.segments) {
    const line = segment.points.map(([lat, lon]) => [lon, lat]);
    for (const run of globeLine(line, lon0, lat0, radius, cx, cy)) {
      run.forEach(([x, y], index) => {
        if (index) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
    }
  }
  ctx.strokeStyle = theme.glow;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = Math.max(1.2, 1.3 * scale);
  ctx.stroke();
  ctx.globalAlpha = 1;

  for (const city of cities) {
    const [x, y, z] = spherePoint(city.lat, city.lon, lon0, lat0);
    if (z <= 0) continue;
    ctx.beginPath();
    ctx.arc(cx + radius * x, cy - radius * y, Math.max(3, 3.2 * scale), 0, Math.PI * 2);
    ctx.fillStyle = theme.dot;
    ctx.fill();
    ctx.strokeStyle = theme.dot_edge;
    ctx.lineWidth = Math.max(1, scale);
    ctx.stroke();
  }

  if (comet) {
    const [x, y, z] = spherePoint(comet[0], comet[1], lon0, lat0);
    if (z > 0) {
      ctx.save();
      ctx.shadowColor = theme.glow;
      ctx.shadowBlur = 16 * scale;
      ctx.fillStyle = theme.glow;
      ctx.beginPath();
      ctx.arc(cx + radius * x, cy - radius * y, Math.max(4, 4.5 * scale), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
  ctx.restore();
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
  drawGlobeScene(ctx, cssWidth, cssHeight, state.globe.lon0, state.globe.lat0, state.places.cities, {
    comet: cometPosition(state.globe.time),
  });
}

async function exportGif() {
  if (!state.places || !state.globe.segments) return;
  const width = Number($("gif-width").value) || 480;
  const requestedFps = Number($("gif-fps").value) || 12;
  // GIF stores hundredths of a second; below 2 cs browsers clamp to 10 fps.
  const fps = Math.min(50, requestedFps);
  const duration = Number($("gif-duration").value) || 16;
  const colors = Number($("gif-colors").value) || 256;
  const dither = $("gif-dither").checked;
  const perDirection = Math.max(2, Math.round((fps * duration) / 2));
  const height = Math.round(width * 1.05);
  const supersample = 2;
  const big = document.createElement("canvas");
  big.width = width * supersample;
  big.height = height * supersample;
  const bigCtx = big.getContext("2d");
  const small = document.createElement("canvas");
  small.width = width;
  small.height = height;
  const smallCtx = small.getContext("2d");
  const button = $("gif-export");
  const status = $("gif-status");
  const progressEl = $("gif-progress");
  const theme = THEMES[themeForPreview()];
  button.disabled = true;
  progressEl.hidden = false;
  progressEl.value = 0;
  let palette = null;
  const cache = new Map();
  const forward = [];
  try {
    for (let index = 0; index < perDirection; index += 1) {
      const progress = perDirection > 1 ? index / (perDirection - 1) : 0;
      const camera =
        cameraAt(state.globe.segments, state.globe.total, progress) ?? [0, 20];
      const point = routePointAt(state.globe.segments, state.globe.total, progress);
      bigCtx.setTransform(1, 0, 0, 1, 0, 0);
      drawGlobeScene(
        bigCtx,
        big.width,
        big.height,
        camera[0],
        camera[1],
        state.places.cities,
        { comet: point, theme },
      );
      smallCtx.clearRect(0, 0, width, height);
      smallCtx.drawImage(big, 0, 0, width, height);
      const rgba = smallCtx.getImageData(0, 0, width, height).data;
      if (!palette) palette = buildPalette(rgba, colors);
      forward.push(indexFrame(rgba, palette, cache, { dither, width }));
      status.textContent =
        `Rendering ${index + 1}/${perDirection}…` +
        (requestedFps > 50 ? " (GIF caps at 50 fps)" : "");
      progressEl.value = (index + 1) / perDirection;
      if (index % 3 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    status.textContent = "Encoding GIF…";
    await new Promise((resolve) => setTimeout(resolve, 0));
    const writer = createGifWriter({
      width,
      height,
      palette,
      delayMs: 1000 / fps,
    });
    for (const frame of forward) writer.addFrame(frame);
    for (let index = forward.length - 2; index > 0; index -= 1) {
      writer.addFrame(forward[index]);
    }
    const bytes = writer.finish();
    const blob = new Blob([bytes], { type: "image/gif" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `worldmap-globe-${width}-${fps}fps.gif`;
    link.click();
    status.textContent =
      `GIF ready · ${(blob.size / 1048576).toFixed(1)} MB · ` +
      `${forward.length * 2 - 1} frames · ${fps} fps`;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    status.textContent = `GIF failed: ${error.message}`;
  } finally {
    button.disabled = false;
    progressEl.hidden = true;
    progressEl.value = 0;
  }
}

function pickVideoMime() {
  if (typeof window.MediaRecorder === "undefined") return null;
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

async function exportVideo() {
  if (!state.places || !state.globe.segments) return;
  const mime = pickVideoMime();
  const button = $("video-export");
  const status = $("video-status");
  if (!mime) {
    status.textContent = "This browser cannot record video; use the GIF export.";
    return;
  }
  const width = Number($("video-width").value) || 1080;
  const height = Math.round(width * 1.05);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const theme = THEMES[themeForPreview()];

  let stream;
  try {
    stream = canvas.captureStream(60);
  } catch (error) {
    status.textContent = "This browser cannot capture the canvas.";
    return;
  }
  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 8_000_000,
  });
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size) chunks.push(event.data);
  };
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });

  button.disabled = true;
  recorder.start(250);
  const total = 16;
  const start = performance.now();
  await new Promise((resolve) => {
    function tick(now) {
      const elapsed = Math.min(total, (now - start) / 1000);
      const phase = (elapsed % (total * 2)) / total;
      const progress = phase <= 1 ? phase : 2 - phase;
      const camera =
        cameraAt(state.globe.segments, state.globe.total, progress) ?? [0, 20];
      const point = routePointAt(state.globe.segments, state.globe.total, progress);
      drawGlobeScene(ctx, width, height, camera[0], camera[1], state.places.cities, {
        comet: point,
        theme,
      });
      status.textContent = `Recording ${elapsed.toFixed(1)}s / ${total}s…`;
      if (elapsed >= total) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
  recorder.stop();
  await stopped;

  const blob = new Blob(chunks, { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `worldmap-globe-${width}-60fps.webm`;
  link.click();
  status.textContent =
    `Video ready · ${(blob.size / 1048576).toFixed(1)} MB · ${mime.split(";")[0]}`;
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  button.disabled = false;
}

function followCamera(dt) {
  const g = state.globe;
  const comet = cometPosition(g.time);
  if (!comet) return;
  const targetLat = Math.max(-38, Math.min(38, comet[0]));
  const targetLon = comet[1];
  const delta = ((targetLon - g.lon0 + 540) % 360) - 180;
  const factor = 1 - Math.exp(-dt * 2.6);
  g.lon0 = ((g.lon0 + delta * factor + 540) % 360) - 180;
  g.lat0 += (targetLat - g.lat0) * factor;
}

function globeTick(now) {
  const g = state.globe;
  const dt = g.last ? Math.min(0.05, (now - g.last) / 1000) : 0;
  g.last = now;
  if (!g.paused && !g.dragging) {
    g.time += dt * 1000;
    // The camera chases the comet; after a drag it waits a moment, then eases
    // back onto the route.
    if (performance.now() - g.lastInteraction > 1200) followCamera(dt);
  }
  drawGlobe(g.time);
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

$("dates").addEventListener("change", async () => {
  if (!state.file) return;
  try {
    await generate(state.file);
  } catch (error) {
    console.error(error);
    setStatus(error.message || String(error), true);
  }
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

// comgooglemaps:// only works on iOS; hide it elsewhere.
if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
  $("open-maps-ios").hidden = false;
}

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

$("gif-export").addEventListener("click", exportGif);
$("video-export").addEventListener("click", exportVideo);

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
  state.globe.lastInteraction = performance.now();
  globeCanvas.setPointerCapture(event.pointerId);
});
globeCanvas.addEventListener("pointermove", (event) => {
  if (!state.globe.dragging) return;
  const dx = event.clientX - state.globe.lastX;
  state.globe.lastX = event.clientX;
  state.globe.lastInteraction = performance.now();
  state.globe.lon0 = (state.globe.lon0 - dx * 0.3) % 360;
});
for (const event of ["pointerup", "pointercancel"]) {
  globeCanvas.addEventListener(event, () => {
    state.globe.dragging = false;
    state.globe.lastInteraction = performance.now();
  });
}

// ---------------------------------------------------------------------------
// Preferences: control values only, never travel data.

const SETTING_IDS = [
  "theme",
  "gif-width",
  "gif-fps",
  "gif-duration",
  "gif-colors",
  "gif-dither",
  "video-width",
  "dates",
];
const SETTINGS_KEY = "gmap-settings";

function loadSettings() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    return;
  }
  for (const id of SETTING_IDS) {
    const el = $(id);
    if (!el || !(id in saved)) continue;
    if (el.type === "checkbox") el.checked = Boolean(saved[id]);
    else el.value = saved[id];
  }
}

function saveSettings() {
  const out = {};
  for (const id of SETTING_IDS) {
    const el = $(id);
    if (!el) continue;
    out[id] = el.type === "checkbox" ? el.checked : el.value;
  }
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(out));
  } catch {
    // Private mode can refuse writes; preferences just stay per-visit.
  }
}

document.addEventListener("change", (event) => {
  const id = event.target && event.target.id;
  if (id && SETTING_IDS.includes(id)) saveSettings();
});
loadSettings();

// ---------------------------------------------------------------------------
// PWA: install prompt, service worker, and an update banner.

function setupPwa() {
  const install = $("install");
  let installEvent = null;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installEvent = event;
    install.hidden = false;
  });
  install.addEventListener("click", async () => {
    if (!installEvent) return;
    installEvent.prompt();
    const choice = await installEvent.userChoice.catch(() => null);
    if (choice && choice.outcome === "accepted") install.hidden = true;
    installEvent = null;
  });
  window.addEventListener("appinstalled", () => {
    install.hidden = true;
  });

  if (!("serviceWorker" in navigator)) return;
  const toast = $("update-toast");
  $("update-dismiss").addEventListener("click", () => {
    toast.hidden = true;
  });
  $("update-reload").addEventListener("click", () => location.reload());
  navigator.serviceWorker
    .register("./sw.js")
    .then((registration) => {
      registration.addEventListener("updatefound", () => {
        const next = registration.installing;
        if (!next) return;
        next.addEventListener("statechange", () => {
          // Only announce once the page itself is controlled; the first
          // install also reaches "installed" and must stay quiet.
          if (next.state === "installed" && navigator.serviceWorker.controller) {
            toast.hidden = false;
          }
        });
      });
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) registration.update().catch(() => {});
      });
    })
    .catch(() => {
      // No service worker (file:// or an old browser): the app still works.
    });
}
setupPwa();

// Warm the basemap data so the first run feels instant.
loadData().catch(() => {
  setStatus(
    "Could not load basemap data. Open this page from GitHub Pages rather than a local file.",
    true,
  );
});
