/**
 * Browser front-end: file input (JSON or zip), client-side parsing, preview and
 * downloads. All parsing and rendering happens in this tab via js/worldmap.js.
 */

import {
  buildPlaces,
  CityIndex,
  iterSamples,
  renderAnimatedSvg,
  renderSvg,
} from "./worldmap.js";

const $ = (id) => document.getElementById(id);

const state = {
  land: null,
  borders: null,
  cities: null,
  urls: [],
  places: null,
};

const SNIPPET = `<picture>
  <source media="(prefers-color-scheme: dark)" srcset="worldmap-animated-dark.svg">
  <img alt="World map of places lived, visited and transited through" src="worldmap-animated-light.svg" width="100%">
</picture>`;

// ---------------------------------------------------------------------------
// Boot

async function loadData() {
  const base = new URL("../data/", import.meta.url);
  const [cities, land, borders] = await Promise.all([
    fetch(new URL("cities.json", base)).then((r) => r.json()),
    fetch(new URL("world-land.json", base)).then((r) => r.json()),
    fetch(new URL("world-borders.json", base)).then((r) => r.json()),
  ]);
  state.cities = new CityIndex(cities);
  state.land = land;
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

  resetDownloads();
  addDownload("worldmap-animated-light.svg", svgAnimatedLight);
  addDownload("worldmap-animated-dark.svg", svgAnimatedDark);
  addDownload("worldmap-light.svg", svgLight);
  addDownload("worldmap-dark.svg", svgDark);
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

// Warm the basemap data so the first run feels instant.
loadData().catch(() => {
  setStatus(
    "Could not load basemap data. Open this page from GitHub Pages rather than a local file.",
    true,
  );
});
