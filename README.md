# gmap-timeline-replaysvg

Turn a Google Maps **Timeline** export into a **city-level world map SVG** you can
put in a profile README. Four looks, all from the same city-level data:

| Mode | What it does |
| --- | --- |
| **static** | dots on a world map |
| **animated** | a glowing dash ping-pongs along great-circle arcs, one hop at a time |
| **drift** | the flat map slowly pans a full width and repeats |
| **globe** | an orthographic globe rotates one full turn, routes drawn on the sphere |

Everything runs locally. The only thing the tool ever writes is a small JSON
file of **city names and gazetteer city centres** plus the SVGs drawn from it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="examples/worldmap-animated-dark.svg">
  <img alt="Animated world map of a fictional tour: Bangkok, Invercargill, Raleigh, San Francisco, London, Berlin, Dubai, Singapore, Tokyo, Sydney, New York" src="examples/worldmap-animated-light.svg" width="100%">
</picture>

<sub>[Example data](examples/demo-places.json) is a fictional tour, not a real
person's history. More variants: [static light](examples/worldmap-light.svg) ·
[static dark](examples/worldmap-dark.svg) ·
[drift](examples/worldmap-drift-light.svg) ·
[rotating globe](examples/worldmap-globe-light.svg) ·
[globe, dark](examples/worldmap-globe-dark.svg).</sub>

## Use it on your phone

Open **https://github.tig.pw/gmap-timeline-replaysvg/**
(also **https://kaovilai.github.io/gmap-timeline-replaysvg/**).

1. Export Timeline from the Maps app (steps below) and keep the `.json` or
   `.zip` in your phone's Files app.
2. Tap **Choose Timeline export** and pick it. Parsing and drawing happen in the
   browser; the file never leaves the device.
3. Switch between **Flat map** and **Globe** to preview both; the globe is
   interactive (drag to spin) but preview-only. Download any of the SVGs — they
   land in Files.
4. Upload them to your profile repo from GitHub's mobile site, then paste the
   README snippet the page gives you.

The page uses the same JavaScript renderer that is verified byte-for-byte
against the Python CLI in CI (`tests/parity.mjs`), so a map produced on the
phone is identical to one produced on a laptop.

## Why

Google retired the cloud copy of Timeline in 2024; the history now lives on the
phone and is only available through the export inside the Maps app. This tool
consumes that export directly and reduces it to city level before anything is
published, so the map stays useful without publishing precise locations,
addresses or place names.

## Get your export

**Android** (Google Maps app): profile picture → **Settings** → **Location &
privacy** → **Location services** → **Timeline** → **Export timeline data**.
Save the `.zip`, unzip it; the file is `Timeline.json`.

**iPhone** (Google Maps app): **Settings** → **Location & privacy** → **Location
services** → **Timeline** → **Export timeline data**. The file is
`location-history.json`.

Older Google Takeout archives work too: `Records.json`, `Location History.json`
and `Semantic Location History/YYYY/*.json`.

> [!IMPORTANT]
> Never commit the raw export. The `.gitignore` here covers the usual filenames,
> but keep the file outside any repository anyway.

## Quick start

No third-party packages are required (Python 3.8+):

```sh
python3 -I -B worldmap.py all ~/Downloads/Timeline.json
```

This writes `places.json` and eight SVGs (each mode in light and dark) into the
current directory:

- `worldmap-light.svg`, `worldmap-dark.svg` — static
- `worldmap-animated-*.svg` — animated
- `worldmap-drift-*.svg` — drifting pan
- `worldmap-globe-*.svg` — baked rotating globe

Then point your profile README at the animated pair:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="worldmap-animated-dark.svg">
  <img alt="World map of places lived, visited and transited through" src="worldmap-animated-light.svg" width="100%">
</picture>
```

Generating directly into an existing profile checkout:

```sh
python3 -I -B path/to/worldmap.py all ~/Downloads/Timeline.json \
  --data-dir path/to/profile/data \
  --out-dir path/to/profile
```

## What "city level" means

Every sample in the export — visit, activity endpoint, path point or raw signal —
is resolved to the nearest populated place in a vendored Natural Earth gazetteer
(7,342 places worldwide). `places.json` then stores only:

- gazetteer city name, region, country and ISO code;
- the **city centre** coordinates from the gazetteer, rounded to ~1 km — never
  the original sample;
- visit count, distinct days, and first/last year.

Raw coordinates, addresses, place names/IDs and exact timestamps are discarded
during import and never written to disk. The test suite asserts that none of
them can appear in the output.

Samples farther than `--max-city-km` (default 75 km) from any populated place
are dropped; position/path samples use the tighter `--max-path-km` (default
25 km) so a highway drive does not snap to a town 70 km away.

## The animated variant

- Faint **great-circle arcs** connect cities in chronological order (by first
  visit year), so the route reads as travel rather than straight map lines.
- A glowing dash **ping-pongs** along the arcs, one hop at a time: forward
  through the years, then backward. Each city's halo flares as the comet
  arrives.
- Pure inline CSS and SVG filters — no scripts, no external references — so it
  animates as an `<img>` in a README.
- All motion is inside `@media (prefers-reduced-motion: no-preference)`;
  reduced-motion readers get the still map.
- Output is deterministic: the same `places.json` renders byte-identical SVGs.

The drift variant tiles the map twice so the pan has no seam, and the globe
bakes 24 frames (one every 15°) into a single SVG — a README image cannot run
scripts, so the rotation has to be pre-rendered. At 640 px the globe file is
about 750 kB; lower `--globe-frames` or `--globe-width` to shrink it.

Tuning: `--duration 120` slows the animated cycle (default 90 s), `--no-animated`,
`--no-drift` and `--no-globe` skip variants, `--theme dark` renders one theme.

## Commands and flags

```sh
# import only: export -> places.json (PII stripped)
python3 -I -B worldmap.py import ~/Downloads/Timeline.json

# render only: places.json -> SVGs
python3 -I -B worldmap.py render places.json

# both
python3 -I -B worldmap.py all ~/Downloads/Timeline.json
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--out` | `places.json` | where `import` writes the city-level JSON |
| `--data-dir` | `.` | where `all` writes `places.json` |
| `--out-dir` | `.` | where SVGs are written |
| `--max-city-km` | `75` | visit cutoff from the nearest populated place |
| `--max-path-km` | `25` | cutoff for dense position/path samples |
| `--min-visits` | `1` | drop cities with fewer visits |
| `--theme` | `both` | `light`, `dark` or `both` |
| `--width` | `1280` | SVG width in pixels |
| `--duration` | `90` | seconds per ping-pong cycle |
| `--no-animated` | off | skip animated variants |
| `--no-drift` | off | skip drift variants |
| `--no-globe` | off | skip globe variants |
| `--globe-width` | `640` | globe SVG width |
| `--globe-frames` | `24` | baked rotation frames |
| `--globe-duration` | `18` | seconds per globe rotation |

## Basemap data

`data/` holds public-domain [Natural Earth](https://www.naturalearthdata.com/)
data: a simplified 1:50m coastline (1:110m for the globe), country borders, and
populated places used for city lookup. Refresh it with:

```sh
python3 -I -B build-mapdata.py
```

## Tests

```sh
python3 -I -B tests/test_worldmap.py
```

They cover every supported export shape, coordinate parsing, PII stripping,
same-name cities, high-latitude/antimeridian lookups, deterministic rendering,
the animated/globe files being self-contained, and staleness between
`examples/demo-places.json` and the committed example SVGs.

`node tests/parity.mjs` renders all eight examples with the browser module and
asserts the bytes match the Python CLI, so a map made on the phone is identical
to one made on a laptop. CI runs both suites on every push.

## License

Code and generated examples: CC BY 4.0, see [LICENSE](LICENSE). Natural Earth
data is public domain.
