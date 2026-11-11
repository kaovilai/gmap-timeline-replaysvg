/** Guards the service worker's precache list: every CORE path must exist. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sw = readFileSync(join(root, "sw.js"), "utf8");

const listMatch = /const CORE = \[([\s\S]*?)\];/.exec(sw);
assert.ok(listMatch, "sw.js must declare a CORE array");
const paths = [...listMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
assert.ok(paths.length > 0, "CORE must not be empty");

for (const path of paths) {
  const target = path === "./" ? join(root, "index.html") : join(root, path);
  assert.ok(existsSync(target), `sw.js CORE path missing on disk: ${path}`);
}

for (const required of ["./index.html", "./js/app.js", "./js/worldmap.js"]) {
  assert.ok(paths.includes(required), `CORE must include ${required}`);
}

// The manifest must be valid JSON and reference icons that exist.
const manifest = JSON.parse(
  readFileSync(join(root, "manifest.webmanifest"), "utf8"),
);
assert.ok(manifest.name && manifest.start_url, "manifest needs name and start_url");
assert.equal(manifest.display, "standalone");
assert.ok(manifest.icons.length >= 2, "manifest needs install icons");
for (const icon of manifest.icons) {
  assert.ok(existsSync(join(root, icon.src)), `manifest icon missing: ${icon.src}`);
}

console.log(`pwa: ${paths.length} precached paths and ${manifest.icons.length} icons verified`);
