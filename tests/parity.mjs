/**
 * Ensures the browser implementation renders byte-identical SVGs to the Python
 * CLI (which produced the committed examples), and that the JS parser/aggregator
 * behaves like it.
 *
 * Run: node tests/parity.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPlaces,
  CityIndex,
  iterSamples,
  renderAnimatedSvg,
  renderSvg,
} from "../js/worldmap.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

const cities = JSON.parse(read("examples/demo-places.json")).cities;
const land = JSON.parse(read("data/world-land.json"));
const borders = JSON.parse(read("data/world-borders.json"));

let checked = 0;
for (const theme of ["light", "dark"]) {
  const variants = [
    [`worldmap-${theme}.svg`, renderSvg],
    [`worldmap-animated-${theme}.svg`, renderAnimatedSvg],
  ];
  for (const [name, render] of variants) {
    const expected = read(`examples/${name}`);
    const actual = render(cities, land, theme, { borders });
    if (actual !== expected) {
      let index = 0;
      while (
        index < Math.min(actual.length, expected.length) &&
        actual[index] === expected[index]
      ) {
        index += 1;
      }
      assert.fail(
        `${name} differs from the Python output at byte ${index}\n` +
          `  expected: ${JSON.stringify(expected.slice(index, index + 90))}\n` +
          `  actual:   ${JSON.stringify(actual.slice(index, index + 90))}`,
      );
    }
    checked += 1;
  }
}

// --- parser + aggregator -----------------------------------------------------

const fixture = JSON.stringify({
  semanticSegments: [
    {
      startTime: "2019-06-01T10:00:00.000-04:00",
      endTime: "2019-06-01T12:00:00.000-04:00",
      visit: {
        topCandidate: {
          placeId: "ChIJsecret",
          placeLocation: { latLng: "35.7796000°, -78.6382000°" },
        },
      },
    },
    {
      startTime: "2021-03-01T10:00:00.000+13:00",
      endTime: "2021-03-01T12:00:00.000+13:00",
      visit: { topCandidate: { placeLocation: "geo:-46.4132,168.3538" } },
    },
  ],
  rawSignals: [
    { position: { LatLng: "geo:35.7796,-78.6382", timestamp: "1559408400000" } },
  ],
});

const rows = JSON.parse(read("data/cities.json"));
const { document } = buildPlaces(iterSamples(fixture), new CityIndex(rows));
const byCity = new Map(document.cities.map((city) => [city.city, city]));
assert.equal(document.cities.length, 2);
assert.equal(byCity.get("Raleigh").visits, 1); // one visit; the same-day raw signal does not double count
assert.equal(byCity.get("Raleigh").first_year, 2019);
assert.equal(byCity.get("Invercargill").first_year, 2021);
assert.equal(byCity.get("Raleigh").lat, 35.77);

const serialized = JSON.stringify(document);
for (const leaked of ["35.7796", "-78.6382", "ChIJsecret", "168.3538"]) {
  assert.ok(!serialized.includes(leaked), `leaked ${leaked}`);
}

// Concatenated per-year documents, as Android exports produce.
const concatenated = `${fixture}\n${fixture}`;
assert.equal(iterSamples(concatenated).length, 6);

console.log(`parity: ${checked} SVGs byte-identical to the Python output`);
