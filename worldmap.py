#!/usr/bin/env python3
"""Regenerate the profile travel map from a Google Maps Timeline export.

Google retired Timeline in the cloud, so the only source is the on-device
export (Maps app -> Settings -> Location & privacy -> Location services ->
Timeline -> Export timeline data). That file is private and must never be
committed. This script turns it into two things that are safe to publish:

  places.json           city-level only: city name, region, country and the
                        city centre's coordinates. Nearest-city lookups come
                        from a vendored Natural Earth populated-places list.
                        Raw positions, addresses, place names/IDs and the
                        original timestamps never reach this file.
  worldmap-*.svg        the README map (static and animated, light and dark),
                        drawn from places.json only.

Usage:
    python3 -I -B worldmap.py import ~/Downloads/Timeline.json
    python3 -I -B worldmap.py render
    python3 -I -B worldmap.py all ~/Downloads/Timeline.json

The export can be a file or a directory (Takeout archives are searched
recursively). Supported shapes:

  * Android on-device Timeline.json (semanticSegments / rawSignals)
  * iPhone location-history.json (bare array of visit/activity/timelinePath)
  * Legacy Takeout Records.json / "Location History.json" (locations[])
  * Legacy Takeout Semantic Location History JSON (timelineObjects[])

No third-party packages are required.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import math
import pathlib
import re
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parent
MAPDATA_DIR = REPO_ROOT / "data"

PLACES_SCHEMA = "worldmap-places/v1"
DEFAULT_DATA = pathlib.Path("places.json")
DEFAULT_MAX_CITY_KM = 75.0
DEFAULT_MAX_PATH_KM = 25.0

# cities.json rows: [name, region, country, iso2, population, lat, lon]
CITY_NAME, CITY_REGION, CITY_COUNTRY, CITY_ISO2, CITY_POP, CITY_LAT, CITY_LON = range(7)

_GEORE = re.compile(r"(-?\d+(?:\.\d+)?)")
_YEAR = re.compile(r"(\d{4})")


# ---------------------------------------------------------------------------
# Coordinate helpers


def parse_latlng(value):
    """Return (lat, lon) from any coordinate shape Google exports use.

    Accepts "geo:37.4,-122.0", "50.05°, 14.34°", {"latLng": ...},
    {"latitudeE7": int, "longitudeE7": int} and {"latitude": .., "longitude": ..}.
    """
    if value is None:
        return None
    if isinstance(value, str):
        nums = _GEORE.findall(value)
        if len(nums) >= 2:
            lat, lon = float(nums[0]), float(nums[1])
            if -90 <= lat <= 90 and -180 <= lon <= 180:
                return lat, lon
        return None
    if isinstance(value, dict):
        for key in ("latLng", "LatLng", "latlng"):
            if key in value:
                return parse_latlng(value[key])
        if "latitudeE7" in value and "longitudeE7" in value:
            return value["latitudeE7"] / 1e7, value["longitudeE7"] / 1e7
        if "latitude" in value and "longitude" in value:
            return float(value["latitude"]), float(value["longitude"])
        for key in ("location", "point", "latLng"):
            if key in value:
                parsed = parse_latlng(value[key])
                if parsed:
                    return parsed
    return None


def year_of(value):
    """Extract a 4-digit year from an ISO string, epoch millis or seconds."""
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.isdigit():
            return year_of(int(stripped))
        match = _YEAR.search(stripped)
        return int(match.group(1)) if match else None
    if isinstance(value, (int, float)):
        if value > 1e14:  # microseconds
            seconds = value / 1e6
        elif value > 1e11:  # milliseconds
            seconds = value / 1e3
        else:
            seconds = value
        try:
            return _dt.datetime.fromtimestamp(seconds, tz=_dt.timezone.utc).year
        except (OverflowError, OSError, ValueError):
            return None
    return None


def day_of(value):
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.isdigit():
            number = int(stripped)
            if number > 10**14:  # microseconds
                number /= 10**6
            elif number > 10**11:  # milliseconds
                number /= 10**3
            stamp = _dt.datetime.fromtimestamp(number, tz=_dt.timezone.utc)
            return stamp.strftime("%Y-%m-%d")
        match = re.match(r"(\d{4}-\d{2}-\d{2})", stripped)
        if match:
            return match.group(1)
    return None


def haversine_km(lat1, lon1, lat2, lon2):
    radius = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * radius * math.asin(min(1.0, math.sqrt(a)))


# ---------------------------------------------------------------------------
# Export parsing


class Sample:
    """One observed position, reduced to what aggregation needs."""

    __slots__ = ("lat", "lon", "kind", "year", "day")

    def __init__(self, lat, lon, kind, year=None, day=None):
        self.lat = lat
        self.lon = lon
        self.kind = kind  # "visit" | "transit" | "path" | "raw"
        self.year = year
        self.day = day


def _load_documents(path):
    """Yield every JSON document in a file or directory.

    The Android export concatenates one object per year with no separator, so
    a plain json.load is not enough; raw_decode lets us read them in sequence.
    """
    path = pathlib.Path(path).expanduser()
    if path.is_dir():
        files = sorted(p for p in path.rglob("*.json") if p.is_file())
    else:
        files = [path]
    for file in files:
        text = file.read_text(encoding="utf-8-sig", errors="replace")
        decoder = json.JSONDecoder()
        index = 0
        length = len(text)
        while index < length:
            while index < length and text[index].isspace():
                index += 1
            if index >= length:
                break
            try:
                document, index = decoder.raw_decode(text, index)
            except json.JSONDecodeError as error:
                # A truncated or corrupt export would otherwise silently
                # publish a partial history; refuse instead of guessing.
                raise SystemExit(
                    f"{file}: invalid JSON at offset {index} ({error.msg}); "
                    "re-export Timeline from the phone"
                ) from None
            yield document


def _visit_points(visit):
    """Yield the coordinate candidates inside a visit object."""
    if not isinstance(visit, dict):
        return
    top = visit.get("topCandidate") or {}
    candidates = [
        top.get("placeLocation"),
        top.get("location"),
        visit.get("location"),
        visit.get("placeLocation"),
    ]
    for candidate in candidates:
        parsed = parse_latlng(candidate)
        if parsed:
            yield parsed
            return


def _activity_points(activity):
    if not isinstance(activity, dict):
        return
    for key in ("start", "end"):
        parsed = parse_latlng(activity.get(key))
        if parsed:
            yield parsed


def _path_points(timeline_path):
    if not isinstance(timeline_path, list):
        return
    for point in timeline_path:
        parsed = parse_latlng(point)
        if parsed:
            yield parsed


def samples_from_document(document):
    """Yield Samples from any supported export document."""
    if isinstance(document, list):
        # iPhone location-history.json
        for entry in document:
            if not isinstance(entry, dict):
                continue
            year = year_of(entry.get("startTime") or entry.get("endTime"))
            day = day_of(entry.get("startTime") or entry.get("endTime"))
            for lat, lon in _visit_points(entry.get("visit")):
                yield Sample(lat, lon, "visit", year, day)
            for lat, lon in _activity_points(entry.get("activity")):
                yield Sample(lat, lon, "transit", year, day)
            for lat, lon in _path_points(entry.get("timelinePath")):
                yield Sample(lat, lon, "path", year, day)
        return

    if not isinstance(document, dict):
        return

    if "semanticSegments" in document:
        # Android on-device export
        for segment in document.get("semanticSegments") or []:
            if not isinstance(segment, dict):
                continue
            year = year_of(segment.get("startTime") or segment.get("endTime"))
            day = day_of(segment.get("startTime") or segment.get("endTime"))
            for lat, lon in _visit_points(segment.get("visit")):
                yield Sample(lat, lon, "visit", year, day)
            for lat, lon in _activity_points(segment.get("activity")):
                yield Sample(lat, lon, "transit", year, day)
            for lat, lon in _path_points(segment.get("timelinePath")):
                yield Sample(lat, lon, "path", year, day)
        # rawSignals adds position fixes the semantic pass skipped; they are
        # subject to the tighter path cutoff, so they only add cities the phone
        # was actually near.
        for signal in document.get("rawSignals") or []:
            if not isinstance(signal, dict):
                continue
            position = signal.get("position")
            if not isinstance(position, dict):
                continue
            parsed = parse_latlng(position)
            if not parsed:
                continue
            stamp = (
                position.get("timestamp")
                or signal.get("timestamp")
                or position.get("time")
            )
            yield Sample(*parsed, "raw", year_of(stamp), day_of(stamp))
        return

    if "locations" in document:
        # Legacy Takeout Records.json / Location History.json
        for record in document.get("locations") or []:
            parsed = parse_latlng(record)
            if not parsed:
                continue
            stamp = record.get("timestampMs") or record.get("timestamp")
            yield Sample(*parsed, "raw", year_of(stamp), day_of(stamp))
        return

    if "timelineObjects" in document:
        # Legacy Takeout Semantic Location History
        for obj in document.get("timelineObjects") or []:
            if not isinstance(obj, dict):
                continue
            visit = obj.get("placeVisit") or {}
            duration = visit.get("duration") or {}
            stamp = duration.get("startTimestampMs") or duration.get("startTimestamp")
            year, day = year_of(stamp), day_of(stamp)
            for lat, lon in _visit_points(visit):
                yield Sample(lat, lon, "visit", year, day)
            segment = obj.get("activitySegment") or {}
            seg_duration = segment.get("duration") or {}
            stamp = seg_duration.get("startTimestampMs") or seg_duration.get(
                "startTimestamp"
            )
            year, day = year_of(stamp), day_of(stamp)
            for key in ("startLocation", "endLocation"):
                parsed = parse_latlng(segment.get(key))
                if parsed:
                    yield Sample(*parsed, "transit", year, day)


def iter_samples(path):
    for document in _load_documents(path):
        yield from samples_from_document(document)


# ---------------------------------------------------------------------------
# City lookup


class CityIndex:
    """Nearest-city lookup over the vendored Natural Earth populated places."""

    def __init__(self, rows):
        self.rows = rows
        self.cells = {}
        for index, row in enumerate(rows):
            self.cells.setdefault(self._cell(row[CITY_LAT], row[CITY_LON]), []).append(
                index
            )
        self._cache = {}

    @staticmethod
    def _cell(lat, lon):
        return int(math.floor(lat)), int(math.floor(lon))

    def nearest(self, lat, lon, max_km):
        """Return (row, distance_km) or None when nothing is close enough."""
        # The cached answer depends on the search radius, so both go in the key.
        key = (round(lat * 20), round(lon * 20), max_km)
        if key in self._cache:
            row = self._cache[key]
            if row is None:
                return None
            # Recompute the distance for this exact point; the cached cell is
            # only ~5 km wide, but a shared distance could flip the cutoff.
            km = haversine_km(lat, lon, row[CITY_LAT], row[CITY_LON])
            return None if km > max_km else (row, km)

        best = None
        best_km = float("inf")
        base_lat, base_lon = self._cell(lat, lon)
        # A degree of latitude is ~111 km everywhere, but a degree of longitude
        # shrinks with cos(latitude); without that, high-latitude searches miss
        # cities to the east and west.
        lat_span = int(max_km / 111.0) + 1
        cos_lat = max(0.15, math.cos(math.radians(lat)))
        lon_span = int(max_km / (111.0 * cos_lat)) + 1
        for dlat in range(-lat_span, lat_span + 1):
            # The nearest point of this row of cells is at least this far away.
            if best is not None and (abs(dlat) - 1) * 111.0 > best_km:
                continue
            for dlon in range(-lon_span, lon_span + 1):
                # Longitude cells wrap at the antimeridian, so a city just
                # across +/-180 is still found.
                cell_lon = ((base_lon + dlon + 180) % 360) - 180
                for index in self.cells.get((base_lat + dlat, cell_lon), ()):
                    row = self.rows[index]
                    km = haversine_km(lat, lon, row[CITY_LAT], row[CITY_LON])
                    if km < best_km:
                        best, best_km = row, km
        self._cache[key] = best
        return None if best is None or best_km > max_km else (best, best_km)


def load_cities(index_path=None):
    path = pathlib.Path(index_path) if index_path else MAPDATA_DIR / "cities.json"
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


# ---------------------------------------------------------------------------
# Aggregation


class CityAggregate:
    __slots__ = ("row", "visits", "days", "first_year", "last_year")

    def __init__(self, row):
        self.row = row
        self.visits = 0
        self.days = set()
        self.first_year = None
        self.last_year = None

    def add(self, sample):
        new_day = bool(sample.day) and sample.day not in self.days
        if sample.kind in ("visit", "transit"):
            self.visits += 1
        elif new_day:
            # Raw position/path samples count once per city per day, so a long
            # stay does not outweigh a single airport connection.
            self.visits += 1
        if sample.day:
            self.days.add(sample.day)
        if sample.year:
            if self.first_year is None or sample.year < self.first_year:
                self.first_year = sample.year
            if self.last_year is None or sample.year > self.last_year:
                self.last_year = sample.year


def build_places(
    samples,
    city_index,
    max_km=DEFAULT_MAX_CITY_KM,
    min_visits=1,
    max_path_km=DEFAULT_MAX_PATH_KM,
):
    aggregates = {}
    resolved = skipped = 0
    for sample in samples:
        if not (-90 <= sample.lat <= 90 and -180 <= sample.lon <= 180):
            continue
        # Path/raw samples are dense; a looser cutoff would snap every rural
        # point to some distant town and invent stops along every highway.
        limit = max_path_km if sample.kind in ("path", "raw") else max_km
        match = city_index.nearest(sample.lat, sample.lon, limit)
        if not match:
            skipped += 1
            continue
        row = match[0]
        # Same-name cities in one country (Portland OR/ME, Springfield...) are
        # different rows; the coordinates keep them apart.
        key = (row[CITY_NAME], row[CITY_REGION], row[CITY_ISO2], row[CITY_LAT], row[CITY_LON])
        aggregate = aggregates.get(key)
        if aggregate is None:
            aggregate = aggregates[key] = CityAggregate(row)
        aggregate.add(sample)
        resolved += 1

    cities = []
    for aggregate in aggregates.values():
        if aggregate.visits < min_visits:
            continue
        row = aggregate.row
        cities.append(
            {
                "city": row[CITY_NAME],
                "region": row[CITY_REGION],
                "country": row[CITY_COUNTRY],
                "country_code": row[CITY_ISO2],
                # City centre from the gazetteer, rounded to ~1 km. The input
                # coordinate that produced this hit is never stored.
                "lat": round(row[CITY_LAT], 2),
                "lon": round(row[CITY_LON], 2),
                "visits": aggregate.visits,
                "days": len(aggregate.days),
                "first_year": aggregate.first_year,
                "last_year": aggregate.last_year,
            }
        )
    cities.sort(key=lambda c: (c["country"], c["region"], c["city"], c["lon"]))
    stats = {"samples": resolved + skipped, "resolved": resolved, "unmatched": skipped}
    return cities, stats


def write_places(cities, stats, output_path, max_km, max_path_km):
    document = {
        "schema": PLACES_SCHEMA,
        "note": (
            "City-level only, generated by worldmap.py from a "
            "private Google Timeline export. Raw positions, addresses and place "
            "names are discarded at import time; coordinates are gazetteer city "
            "centres, not the original samples (visit cutoff %g km, path cutoff "
            "%g km)." % (max_km, max_path_km)
        ),
        "max_city_km": max_km,
        "max_path_km": max_path_km,
        "stats": stats,
        "cities": cities,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# Rendering

THEMES = {
    "light": {
        "ocean": "#aadaff",
        "land": "#f2efe9",
        "coast": "#c9c3b4",
        "border": "#ddd8cb",
        "dot": "#e8453c",
        "dot_edge": "#ffffff",
        "glow": "#ff5a3c",
        "halo": "#e8453c",
        "ocean_hi": "#c6e7ff",
        "ocean_lo": "#7cc3ef",
        "globe_land": "#f2efe9",
    },
    "dark": {
        "ocean": "#0b1a2a",
        "land": "#1b2a3a",
        "coast": "#3d5268",
        "border": "#2b3d51",
        "dot": "#ff6b5e",
        "dot_edge": "#0b1a2a",
        "glow": "#ff8f6b",
        "halo": "#ff6b5e",
        "ocean_hi": "#173855",
        "ocean_lo": "#06121d",
        "globe_land": "#24405a",
    },
}

MAX_MERCATOR_LAT = 85.0


def _mercator_y(lat):
    lat = max(-MAX_MERCATOR_LAT, min(MAX_MERCATOR_LAT, lat))
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def load_land(path=None):
    land_path = pathlib.Path(path) if path else MAPDATA_DIR / "world-land.json"
    with land_path.open(encoding="utf-8") as handle:
        return json.load(handle)


def load_land_coarse(path=None):
    coarse_path = (
        pathlib.Path(path) if path else MAPDATA_DIR / "world-land-coarse.json"
    )
    with coarse_path.open(encoding="utf-8") as handle:
        return json.load(handle)


def load_borders(path=None):
    borders_path = pathlib.Path(path) if path else MAPDATA_DIR / "world-borders.json"
    if not borders_path.exists():
        return []
    with borders_path.open(encoding="utf-8") as handle:
        return json.load(handle)


class Projection:
    def __init__(self, width, west=-180.0, east=180.0, south=-58.0, north=78.0):
        self.width = width
        self.west = west
        self.east = east
        self.south_lat = south
        self.north_lat = north
        self.north = _mercator_y(north)
        self.south = _mercator_y(south)
        self.height = round(width * (self.north - self.south) / (2 * math.pi), 2)

    def point(self, lat, lon):
        x = (lon - self.west) / (self.east - self.west) * self.width
        y = (self.north - _mercator_y(lat)) / (self.north - self.south) * self.height
        return x, y


def _ring_path(ring, projection):
    """Project one ring of [lon, lat] pairs, splitting at the antimeridian."""
    subpaths = []
    current = []
    previous_lon = None
    for lon, lat in ring:
        if previous_lon is not None and abs(lon - previous_lon) > 180:
            if current:
                subpaths.append(current)
            current = []
        x, y = projection.point(lat, lon)
        current.append((x, y))
        previous_lon = lon
    if current:
        subpaths.append(current)

    parts = []
    for subpath in subpaths:
        if len(subpath) < 3:
            continue
        parts.append(
            "M "
            + " L ".join("%.1f %.1f" % (x, y) for x, y in subpath)
            + " Z"
        )
    return " ".join(parts)


def _land_paths(land, projection):
    """Yield SVG path data per polygon, clipped to the projection bounds."""
    west, east = projection.west, projection.east
    south, north = projection.south_lat, projection.north_lat
    for polygon in land["coordinates"]:
        segments = []
        for ring in polygon:
            if not ring:
                continue
            lons = [pt[0] for pt in ring]
            lats = [pt[1] for pt in ring]
            if max(lons) < west or min(lons) > east:
                continue
            if max(lats) < south or min(lats) > north:
                continue
            path = _ring_path(ring, projection)
            if path:
                segments.append(path)
        if segments:
            yield " ".join(segments)


def _lines_path(lines, projection):
    """Project border polylines, splitting at the antimeridian."""
    parts = []
    for line in lines:
        current = []
        previous_lon = None
        for lon, lat in line:
            if previous_lon is not None and abs(lon - previous_lon) > 180:
                if len(current) >= 2:
                    parts.append(
                        "M " + " L ".join("%.1f %.1f" % (x, y) for x, y in current)
                    )
                current = []
            current.append(projection.point(lat, lon))
            previous_lon = lon
        if len(current) >= 2:
            parts.append("M " + " L ".join("%.1f %.1f" % (x, y) for x, y in current))
    return " ".join(parts)


def _flat_layers(cities, land, projection, theme, borders):
    """Land, borders and city dots for the flat map, as SVG fragments."""
    paths = " ".join(_land_paths(land, projection))
    border_path = _lines_path(borders or [], projection)
    dots = []
    for city in sorted(cities, key=lambda c: (c["lat"], c["lon"])):
        x, y = projection.point(city["lat"], city["lon"])
        dots.append(
            '<circle cx="%.1f" cy="%.1f" r="4.2" fill="%s" stroke="%s" stroke-width="1.2"/>'
            % (x, y, theme["dot"], theme["dot_edge"])
        )
    return (
        '  <g fill="%s" stroke="%s" stroke-width="0.7" fill-rule="evenodd">\n'
        "    <path d=\"%s\"/>\n"
        "  </g>\n"
        '  <g fill="none" stroke="%s" stroke-width="0.6">\n'
        "    <path d=\"%s\"/>\n"
        "  </g>\n"
        "  <g>\n    %s\n  </g>\n"
        % (
            theme["land"],
            theme["coast"],
            paths,
            theme["border"],
            border_path,
            "\n    ".join(dots),
        )
    )


def _svg_open(width, height, title, description):
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%.2f" '
        'viewBox="0 0 %d %.2f" role="img" aria-labelledby="map-title map-desc">\n'
        "  <title id=\"map-title\">%s</title>\n"
        "  <desc id=\"map-desc\">%s</desc>\n"
        % (width, height, width, height, title, description)
    )


def render_svg(cities, land, theme_name="light", width=1280, borders=None):
    theme = THEMES[theme_name]
    projection = Projection(width)
    height = projection.height
    title = "Travel map"
    description = (
        "World map with red dots marking cities the owner has lived in, visited "
        "or transited through, generated at city level."
    )
    return (
        _svg_open(width, height, title, description)
        + '  <rect width="%d" height="%.2f" fill="%s"/>\n'
        % (width, height, theme["ocean"])
        + _flat_layers(cities, land, projection, theme, borders)
        + "</svg>\n"
    )


def _arc_points(start, end, step_km=180.0):
    """Interpolate a great-circle arc between two (lat, lon) points.

    Straight Mercator lines between distant cities cut across continents; a
    geodesic reads as a flight path and looks right on a travel map.
    """
    lat1, lon1 = map(math.radians, start)
    lat2, lon2 = map(math.radians, end)
    x1, y1, z1 = (
        math.cos(lat1) * math.cos(lon1),
        math.cos(lat1) * math.sin(lon1),
        math.sin(lat1),
    )
    x2, y2, z2 = (
        math.cos(lat2) * math.cos(lon2),
        math.cos(lat2) * math.sin(lon2),
        math.sin(lat2),
    )
    dot = max(-1.0, min(1.0, x1 * x2 + y1 * y2 + z1 * z2))
    angle = math.acos(dot)
    if angle < 1e-9:
        return [start, end]
    distance_km = angle * 6371.0088
    steps = max(2, min(600, int(distance_km / step_km) + 1))
    points = []
    sin_angle = math.sin(angle)
    for index in range(steps + 1):
        t = index / steps
        a = math.sin((1 - t) * angle) / sin_angle
        b = math.sin(t * angle) / sin_angle
        x, y, z = (a * x1 + b * x2, a * y1 + b * y2, a * z1 + b * z2)
        norm = math.sqrt(x * x + y * y + z * z) or 1.0
        points.append(
            (
                math.degrees(math.asin(max(-1.0, min(1.0, z / norm)))),
                math.degrees(math.atan2(y, x)),
            )
        )
    return points


def _route_lines(cities):
    """Projected-agnostic polylines for consecutive cities in route order."""
    lines = []
    for start, end in zip(cities, cities[1:]):
        lines.append(
            _arc_points(
                (start["lat"], start["lon"]),
                (end["lat"], end["lon"]),
            )
        )
    return [[(lon, lat) for lat, lon in line] for line in lines]


def _route_segments(cities):
    """Great-circle arcs between consecutive cities, with lengths in km."""
    segments = []
    total = 0.0
    for start, end in zip(cities, cities[1:]):
        points = _arc_points((start["lat"], start["lon"]), (end["lat"], end["lon"]))
        distance = 0.0
        for (lat1, lon1), (lat2, lon2) in zip(points, points[1:]):
            distance += haversine_km(lat1, lon1, lat2, lon2)
        segments.append((points, distance))
        total += distance
    return segments, total


def _route_point_at(segments, total, progress):
    """Interpolated (lat, lon) at a fraction of the route's total length."""
    if not segments or total <= 0:
        return None
    target = progress * total
    for index, (points, distance) in enumerate(segments):
        last = index == len(segments) - 1
        if target <= distance or last:
            fraction = min(1.0, target / distance) if distance else 0.0
            step = int(fraction * (len(points) - 1) + 0.5)
            return points[min(len(points) - 1, step)]
        target -= distance
    return None


def _camera_at(segments, total, progress):
    """Camera rotation for a point along the route, so the globe follows it."""
    point = _route_point_at(segments, total, progress)
    if point is None:
        return None
    lat, lon = point
    return lon, max(-38.0, min(38.0, lat))


def _route_order(cities):
    """Chronological order for the animated route; unknown years go last."""
    return sorted(
        cities,
        key=lambda c: (
            c["first_year"] if c.get("first_year") is not None else 9999,
            -(c.get("visits") or 0),
            c["country_code"],
            c["city"],
            c["lon"],
        ),
    )


def _route_legs(cities, projection):
    """One (path, length_px) pair per drawn arc segment.

    A leg that crosses the antimeridian is split into separate legs, because SVG
    restarts the dash pattern at each subpath and a single path with two ``M``
    commands would show two comets at once. Lengths are in projected user units
    because browsers apply stroke-dasharray in user units.
    """
    legs = []
    for start, end in zip(cities, cities[1:]):
        points = _arc_points((start["lat"], start["lon"]), (end["lat"], end["lon"]))
        subpaths = []
        current = []
        previous_lon = None
        for lat, lon in points:
            if previous_lon is not None and abs(lon - previous_lon) > 180:
                if len(current) >= 2:
                    subpaths.append(current)
                current = []
            current.append(projection.point(lat, lon))
            previous_lon = lon
        if len(current) >= 2:
            subpaths.append(current)

        for subpath in subpaths:
            path = "M " + " L ".join("%.1f %.1f" % (x, y) for x, y in subpath)
            length = sum(
                math.hypot(x2 - x1, y2 - y1)
                for (x1, y1), (x2, y2) in zip(subpath, subpath[1:])
            )
            if length > 4:
                legs.append((path, length))
    return legs


def _fmt_percent(fraction):
    text = ("%.4f" % (fraction * 100.0)).rstrip("0").rstrip(".")
    return text or "0"


def _leg_keyframes(index, legs, dashes):
    """One ping-pong pass of the comet along a single leg.

    The dash is parked just past either end of the leg so each leg is dark
    except during its own slot: forward in the first half of the cycle,
    backward in the second half.
    """
    length = legs[index][1]
    dash = dashes[index]
    n = max(1, len(legs))
    park = int(dash + 1)
    end = int(-(length + 1))
    times = (
        0.0,
        index / (2 * n),
        (index + 1) / (2 * n),
        0.5 + (n - 1 - index) / (2 * n),
        0.5 + (n - index) / (2 * n),
        1.0,
    )
    values = (park, park, end, end, park, park)
    steps = "".join(
        "%s%%{stroke-dashoffset:%d}" % (_fmt_percent(t), v)
        for t, v in zip(times, values)
    )
    return "@keyframes leg%d{%s}" % (index, steps)


def render_animated_svg(
    cities, land, theme_name="dark", width=1280, borders=None, duration=90.0
):
    """Animated map: glowing dashes ping-pong along the chronological route.

    Everything is inline (CSS keyframes plus an SVG blur) so the file still works
    as an <img> in a README: no scripts, no external references. Motion lives
    inside prefers-reduced-motion: no-preference, so the still route and dots are
    the fallback, and the file is byte-for-byte deterministic.
    """
    theme = THEMES[theme_name]
    projection = Projection(width)
    height = projection.height

    land_paths = " ".join(_land_paths(land, projection))
    border_path = _lines_path(borders or [], projection)
    ordered = _route_order(cities)
    route = _lines_path(_route_lines(ordered), projection)
    legs = _route_legs(ordered, projection)

    halos, dots = [], []
    total = max(1, len(ordered) - 1)
    half = duration / 2.0
    for index, city in enumerate(ordered):
        x, y = projection.point(city["lat"], city["lon"])
        # Flare each halo roughly when the comet reaches its city.
        delay = ((index / total) * half) % 4.5
        halos.append(
            '<circle class="halo" cx="%.1f" cy="%.1f" r="12" fill="%s" '
            'style="animation-delay:%.2fs"/>'
            % (x, y, theme["halo"], delay)
        )
        dots.append(
            '<circle cx="%.1f" cy="%.1f" r="4.2" fill="%s" stroke="%s" stroke-width="1.2"/>'
            % (x, y, theme["dot"], theme["dot_edge"])
        )

    leg_markup = []
    for index, (leg, _length) in enumerate(legs):
        leg_markup.append(
            '<path class="leg leg%d glow" d="%s"/>' % (index, leg)
        )
        leg_markup.append('<path class="leg leg%d" d="%s"/>' % (index, leg))

    dash = [max(20.0, min(46.0, length * 0.35)) for _path, length in legs]
    keyframes = "".join(_leg_keyframes(i, legs, dash) for i in range(len(legs)))
    leg_names = "".join(
        ".leg%d{animation-name:leg%d;stroke-dasharray:%d %d;stroke-dashoffset:%d}"
        % (i, i, dash[i], int(length + dash[i]), int(dash[i] + 1))
        for i, (_path, length) in enumerate(legs)
    )
    style = (
        "<style>\n"
        ".leg{fill:none;stroke:%(glow)s;stroke-width:2.2;stroke-linecap:round}\n"
        ".leg.glow{stroke-width:7;opacity:.5;filter:url(#soft)}\n"
        ".halo{opacity:.10}\n"
        "@media (prefers-reduced-motion:no-preference){\n"
        ".leg{animation-duration:%(duration).1fs;animation-timing-function:linear;"
        "animation-iteration-count:infinite}\n"
        "%(leg_names)s\n"
        ".halo{animation:twinkle 4.5s ease-in-out infinite}\n"
        "%(keyframes)s\n"
        "@keyframes twinkle{0%%,100%%{opacity:.10}50%%{opacity:.5}}\n"
        "}\n"
        "</style>\n"
    ) % {
        "glow": theme["glow"],
        "duration": duration,
        "leg_names": leg_names,
        "keyframes": keyframes,
    }

    title = "Travel map"
    description = (
        "World map of cities the owner has lived in, visited or transited "
        "through, with glowing route lines that travel through them in "
        "chronological order and back."
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%.2f" '
        'viewBox="0 0 %d %.2f" role="img" aria-labelledby="map-title map-desc">\n'
        "  <title id=\"map-title\">%s</title>\n"
        "  <desc id=\"map-desc\">%s</desc>\n"
        "  %s"
        "  <defs>\n"
        '    <filter id="soft" x="-30%%" y="-30%%" width="160%%" height="160%%">\n'
        '      <feGaussianBlur stdDeviation="3.2"/>\n'
        "    </filter>\n"
        "  </defs>\n"
        '  <rect width="%d" height="%.2f" fill="%s"/>\n'
        '  <g fill="%s" stroke="%s" stroke-width="0.7" fill-rule="evenodd">\n'
        "    <path d=\"%s\"/>\n"
        "  </g>\n"
        '  <g fill="none" stroke="%s" stroke-width="0.6">\n'
        "    <path d=\"%s\"/>\n"
        "  </g>\n"
        '  <g fill="none" stroke="%s" stroke-opacity="0.18" stroke-width="1.2">\n'
        "    <path d=\"%s\"/>\n"
        "  </g>\n"
        "  <g>\n    %s\n  </g>\n"
        "  <g>\n    %s\n  </g>\n"
        "  <g>\n    %s\n  </g>\n"
        "</svg>\n"
        % (
            width,
            height,
            width,
            height,
            title,
            description,
            style,
            width,
            height,
            theme["ocean"],
            theme["land"],
            theme["coast"],
            land_paths,
            theme["border"],
            border_path,
            theme["glow"],
            route,
            "\n    ".join(halos),
            "\n    ".join(leg_markup),
            "\n    ".join(dots),
        )
    )





GLOBE_TILT = 20.0


def _sphere_point(lat, lon, lon0, lat0):
    """Unit-sphere coordinates after rotating the globe to lon0/lat0."""
    phi = math.radians(lat)
    lam = math.radians(lon - lon0)
    phi0 = math.radians(lat0)
    x = math.cos(phi) * math.sin(lam)
    y = math.cos(phi0) * math.sin(phi) - math.sin(phi0) * math.cos(phi) * math.cos(lam)
    z = math.sin(phi0) * math.sin(phi) + math.cos(phi0) * math.cos(phi) * math.cos(lam)
    return x, y, z


def _limb_point(a, b):
    """Where the chord between two sphere points crosses the visible limb (z=0)."""
    t = a[2] / (a[2] - b[2])
    x = a[0] + t * (b[0] - a[0])
    y = a[1] + t * (b[1] - a[1])
    norm = math.hypot(x, y) or 1.0
    return x / norm, y / norm


def _limb_arc(exit_point, entry_point, radius, cx, cy):
    """Limb arc from a run's exit back to its own entry, the short way."""
    a0 = math.atan2(exit_point[1], exit_point[0])
    a1 = math.atan2(entry_point[1], entry_point[0])
    delta = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
    steps = max(1, int(abs(delta) / 0.12))
    points = []
    for index in range(1, steps):
        angle = a0 + delta * index / steps
        points.append((cx + radius * math.cos(angle), cy - radius * math.sin(angle)))
    return points


def _globe_ring(ring, lon0, lat0, radius, cx, cy):
    """Visible runs of a closed ring, each closed along the limb."""
    pts = [_sphere_point(lat, lon, lon0, lat0) for lon, lat in ring]
    visible = [p[2] > 0 for p in pts]
    n = len(pts)
    if not any(visible):
        return []
    if all(visible):
        return [[(cx + radius * x, cy - radius * y) for x, y, _z in pts]]

    start = next(i for i in range(n) if visible[i] and not visible[i - 1])
    runs = []
    current = []
    for k in range(n):
        i = (start + k) % n
        prev = (i - 1) % n
        if visible[i]:
            if not visible[prev]:
                bx, by = _limb_point(pts[prev], pts[i])
                current.append((cx + radius * bx, cy - radius * by))
            current.append((cx + radius * pts[i][0], cy - radius * pts[i][1]))
        elif visible[prev]:
            bx, by = _limb_point(pts[prev], pts[i])
            current.append((cx + radius * bx, cy - radius * by))
            runs.append(current)
            current = []
    if current:
        runs.append(current)
    if not runs:
        return []

    closed = []
    for run in runs:
        exit_point = ((run[-1][0] - cx) / radius, -(run[-1][1] - cy) / radius)
        entry_point = ((run[0][0] - cx) / radius, -(run[0][1] - cy) / radius)
        closed.append(run + _limb_arc(exit_point, entry_point, radius, cx, cy))
    return closed


def _globe_line(line, lon0, lat0, radius, cx, cy):
    """Visible runs of an open polyline (no limb closure)."""
    runs = []
    current = []
    for lon, lat in line:
        x, y, z = _sphere_point(lat, lon, lon0, lat0)
        if z > 0:
            current.append((cx + radius * x, cy - radius * y))
        else:
            if len(current) >= 2:
                runs.append(current)
            current = []
    if len(current) >= 2:
        runs.append(current)
    return runs


def _path_from_runs(runs, close, precision=0):
    """Path data for globe runs; whole pixels keep the baked frames small."""
    pattern = "%." + str(precision) + "f %." + str(precision) + "f"
    parts = []
    for run in runs:
        if len(run) < (3 if close else 2):
            continue
        parts.append(
            "M "
            + " L ".join(pattern % (x, y) for x, y in run)
            + (" Z" if close else "")
        )
    return " ".join(parts)


def render_drift_svg(
    cities, land, theme_name="light", width=1280, borders=None, duration=60.0
):
    """Flat map that slowly pans across one full width, then repeats."""
    theme = THEMES[theme_name]
    projection = Projection(width)
    height = projection.height
    layer = _flat_layers(cities, land, projection, theme, borders)
    style = (
        "<style>\n"
        "@media (prefers-reduced-motion:no-preference){\n"
        ".drift{animation:drift %(duration).1fs linear infinite}\n"
        "@keyframes drift{from{transform:translateX(0)}to{transform:translateX(-%(width)dpx)}}\n"
        "}\n"
        "</style>\n"
    ) % {"duration": duration, "width": width}
    title = "Travel map"
    description = (
        "World map with red dots marking cities lived in, visited or transited "
        "through, slowly panning eastward."
    )
    body = (
        '  <g class="drift">\n'
        + layer
        + '    <g transform="translate(%d,0)">\n' % width
        + layer
        + "    </g>\n"
        "  </g>\n"
    )
    return (
        _svg_open(width, height, title, description)
        + style
        + '  <rect width="%d" height="%.2f" fill="%s"/>\n'
        % (width, height, theme["ocean"])
        + body
        + "</svg>\n"
    )


def render_globe_svg(
    cities,
    land,
    theme_name="dark",
    width=640,
    borders=None,
    frames=24,
    duration=24.0,
):
    """Rotating globe that follows the route, baked into frames.

    The camera rotates so the moving point on the route stays centred (within a
    latitude clamp), which keeps the visited dots on screen instead of spinning
    past empty ocean. Frames play forward and then backward, so the loop returns
    to the first city without a jump. Reduced-motion readers see frame 0.
    """
    theme = THEMES[theme_name]
    height = round(width * 1.05, 2)
    radius = width * 0.44
    cx = width / 2.0
    cy = height / 2.0
    ordered = _route_order(cities)
    segments, total = _route_segments(ordered)

    frames_markup = []
    frame_rules = []
    keyframes = []
    for frame in range(frames):
        progress = frame / (frames - 1) if frames > 1 else 0.0
        camera = _camera_at(segments, total, progress)
        lon0, lat0 = camera if camera else (0.0, GLOBE_TILT)

        land_runs = []
        for polygon in land["coordinates"]:
            for ring in polygon:
                land_runs.extend(_globe_ring(ring, lon0, lat0, radius, cx, cy))
        border_runs = []
        for line in borders or []:
            border_runs.extend(_globe_line(line, lon0, lat0, radius, cx, cy))
        route_runs = []
        for line in _route_lines(ordered):
            route_runs.extend(_globe_line(line, lon0, lat0, radius, cx, cy))

        dots = []
        for city in cities:
            x, y, z = _sphere_point(city["lat"], city["lon"], lon0, lat0)
            if z > 0:
                dots.append(
                    '<circle cx="%.0f" cy="%.0f" r="3.2" fill="%s" stroke="%s" stroke-width="1"/>'
                    % (cx + radius * x, cy - radius * y, theme["dot"], theme["dot_edge"])
                )

        frames_markup.append(
            '  <g class="gf gf%d">\n'
            '    <path d="%s" fill="%s" stroke="%s" stroke-width="0.5" fill-rule="evenodd"/>\n'
            '    <path d="%s" fill="none" stroke="%s" stroke-width="0.5"/>\n'
            '    <path d="%s" fill="none" stroke="%s" stroke-opacity="0.6" stroke-width="1.2"/>\n'
            "    %s\n"
            "  </g>\n"
            % (
                frame,
                _path_from_runs(land_runs, True),
                theme.get("globe_land", theme["land"]),
                theme["coast"],
                _path_from_runs(border_runs, False),
                theme["border"],
                _path_from_runs(route_runs, False),
                theme["glow"],
                "\n    ".join(dots),
            )
        )

        # Each frame shows twice: forward at the start of the cycle and backward
        # at the end, so the route ping-pongs.
        start_forward = frame / (2.0 * frames)
        end_forward = (frame + 1) / (2.0 * frames)
        start_back = 1.0 - (frame + 1) / (2.0 * frames)
        end_back = 1.0 - frame / (2.0 * frames)
        frame_rules.append(
            ".gf%d{animation:g%d %gs steps(1,end) infinite}" % (frame, frame, duration)
        )
        keyframes.append(
            "@keyframes g%d{0%%,%s%%{opacity:0}%s%%,%s%%{opacity:1}"
            "%s%%,%s%%{opacity:0}%s%%,%s%%{opacity:1}%s%%,100%%{opacity:0}}"
            % (
                frame,
                _fmt_percent(start_forward),
                _fmt_percent(start_forward),
                _fmt_percent(end_forward),
                _fmt_percent(end_forward),
                _fmt_percent(start_back),
                _fmt_percent(start_back),
                _fmt_percent(end_back),
                _fmt_percent(end_back),
            )
        )

    style = (
        "<style>\n"
        ".gf{opacity:0}\n"
        ".gf0{opacity:1}\n"
        "@media (prefers-reduced-motion:no-preference){\n"
        ".gf0{opacity:0}\n"
        + "\n".join(frame_rules)
        + "\n"
        + "\n".join(keyframes)
        + "\n}\n"
        "</style>\n"
    )

    title = "Travel globe"
    description = (
        "Rotating globe that follows a route of great-circle arcs between the "
        "cities lived in, visited or transited through, in chronological order."
    )
    return (
        _svg_open(width, height, title, description)
        + style
        + "  <defs>\n"
        '    <radialGradient id="globe-ocean" cx="35%%" cy="30%%" r="75%%">\n'
        '      <stop offset="0%%" stop-color="%s"/>\n'
        '      <stop offset="100%%" stop-color="%s"/>\n'
        "    </radialGradient>\n"
        "  </defs>\n"
        '  <circle cx="%.0f" cy="%.0f" r="%.0f" fill="url(#globe-ocean)" '
        'stroke="%s" stroke-width="0.8"/>\n'
        % (theme["ocean_hi"], theme["ocean_lo"], cx, cy, radius, theme["coast"])
        + "".join(frames_markup)
        + "</svg>\n"
    )


def render_globe_gif(
    cities,
    land,
    theme_name="dark",
    width=720,
    fps=12.0,
    duration=24.0,
    borders=None,
    supersample=2,
    colors=128,
):
    """Write a ping-pong animated GIF of the following globe.

    Pillow is optional: only this command needs it. Frames are drawn with the
    same projection as the SVG globe, supersampled for antialiasing, and the
    loop plays the route forward then backward.
    """
    try:
        from PIL import Image, ImageDraw
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise SystemExit(
            "GIF export needs Pillow: python3 -m pip install pillow"
        ) from exc

    theme = THEMES[theme_name]
    scale = max(1, int(supersample))
    out_width = int(width)
    out_height = int(round(out_width * 1.05))
    box_width = out_width * scale
    box_height = out_height * scale
    radius = box_width * 0.44
    cx = box_width / 2.0
    cy = box_height / 2.0
    background = (246, 244, 239) if theme_name == "light" else (11, 26, 42)
    dot_radius = 3.2 * (out_width / 640.0) * scale

    ordered = _route_order(cities)
    segments, total = _route_segments(ordered)
    route_lines = _route_lines(ordered)
    per_direction = max(2, int(round(fps * duration / 2.0)))
    mask = Image.new("L", (box_width, box_height), 0)
    ImageDraw.Draw(mask).ellipse(
        [cx - radius, cy - radius, cx + radius, cy + radius], fill=255
    )

    def render_frame(progress):
        point = _route_point_at(segments, total, progress)
        camera = _camera_at(segments, total, progress)
        lon0, lat0 = camera if camera else (0.0, GLOBE_TILT)

        globe = Image.new("RGB", (box_width, box_height), theme["ocean_hi"])
        draw = ImageDraw.Draw(globe)
        for polygon in land["coordinates"]:
            for ring_index, ring in enumerate(polygon):
                colour = (
                    theme.get("globe_land", theme["land"])
                    if ring_index == 0
                    else theme["ocean_hi"]
                )
                for run in _globe_ring(ring, lon0, lat0, radius, cx, cy):
                    if len(run) >= 3:
                        draw.polygon([(x, y) for x, y in run], fill=colour)

        line_width = max(1, scale)
        for line in borders or []:
            for run in _globe_line(line, lon0, lat0, radius, cx, cy):
                if len(run) >= 2:
                    draw.line([(x, y) for x, y in run], fill=theme["border"], width=line_width)
        for line in route_lines:
            for run in _globe_line(line, lon0, lat0, radius, cx, cy):
                if len(run) >= 2:
                    draw.line([(x, y) for x, y in run], fill=theme["glow"], width=line_width)

        for city in cities:
            x, y, z = _sphere_point(city["lat"], city["lon"], lon0, lat0)
            if z > 0:
                px, py = cx + radius * x, cy - radius * y
                draw.ellipse(
                    [px - dot_radius, py - dot_radius, px + dot_radius, py + dot_radius],
                    fill=theme["dot"],
                    outline=theme["dot_edge"],
                    width=max(1, scale),
                )

        if point is not None:
            lat, lon = point
            x, y, z = _sphere_point(lat, lon, lon0, lat0)
            if z > 0:
                px, py = cx + radius * x, cy - radius * y
                glow = dot_radius * 2.6
                draw.ellipse(
                    [px - glow, py - glow, px + glow, py + glow],
                    fill=theme["halo"],
                )
                draw.ellipse(
                    [px - dot_radius, py - dot_radius, px + dot_radius, py + dot_radius],
                    fill=theme["glow"],
                )

        frame = Image.new("RGB", (box_width, box_height), background)
        frame.paste(globe, (0, 0), mask)
        ImageDraw.Draw(frame).ellipse(
            [cx - radius, cy - radius, cx + radius, cy + radius],
            outline=theme["coast"],
            width=max(1, scale),
        )
        return frame.resize((out_width, out_height), Image.LANCZOS)

    # One shared palette across frames keeps GIF delta compression effective.
    first = render_frame(0.0)
    palette = first.quantize(colors=colors, method=Image.MEDIANCUT)
    forward = [first.quantize(palette=palette, dither=Image.NONE)] + [
        render_frame(index / (per_direction - 1)).quantize(
            palette=palette, dither=Image.NONE
        )
        for index in range(1, per_direction)
    ]
    return forward + forward[-2:0:-1]


def _read_places(path):
    with pathlib.Path(path).open(encoding="utf-8") as handle:
        document = json.load(handle)
    if document.get("schema") != PLACES_SCHEMA:
        raise SystemExit(f"{path}: not a {PLACES_SCHEMA} document")
    return document


def command_import(args):
    index = CityIndex(load_cities(args.cities))
    samples = iter_samples(args.input)
    cities, stats = build_places(
        samples,
        index,
        max_km=args.max_city_km,
        min_visits=args.min_visits,
        max_path_km=args.max_path_km,
    )
    if not cities:
        raise SystemExit(
            "no cities resolved - is this a Timeline export, and is --max-city-km large enough?"
        )
    write_places(
        cities, stats, pathlib.Path(args.out), args.max_city_km, args.max_path_km
    )
    print(
        "wrote %s: %d cities from %d samples (%d unmatched, dropped)"
        % (args.out, len(cities), stats["samples"], stats["unmatched"]),
        file=sys.stderr,
    )
    return 0


def command_render(args):
    document = _read_places(args.data)
    cities = document["cities"]
    land = load_land()
    coarse = load_land_coarse()
    borders = load_borders()
    out_dir = pathlib.Path(args.out_dir)
    themes = ["light", "dark"] if args.theme == "both" else [args.theme]
    for theme in themes:
        svg = render_svg(cities, land, theme, width=args.width, borders=borders)
        out = out_dir / f"worldmap-{theme}.svg"
        out.write_text(svg, encoding="utf-8")
        print(f"wrote {out} ({len(cities)} cities, {len(svg)} bytes)", file=sys.stderr)
        if args.animated:
            animated = render_animated_svg(
                cities,
                land,
                theme,
                width=args.width,
                borders=borders,
                duration=args.duration,
            )
            out = out_dir / f"worldmap-animated-{theme}.svg"
            out.write_text(animated, encoding="utf-8")
            print(
                f"wrote {out} ({len(cities)} cities, {len(animated)} bytes)",
                file=sys.stderr,
            )
        if args.drift:
            drift = render_drift_svg(
                cities, land, theme, width=args.width, borders=borders
            )
            out = out_dir / f"worldmap-drift-{theme}.svg"
            out.write_text(drift, encoding="utf-8")
            print(
                f"wrote {out} ({len(cities)} cities, {len(drift)} bytes)",
                file=sys.stderr,
            )
        if args.globe:
            frames = args.globe_frames
            if getattr(args, "globe_fps", None):
                frames = max(2, int(round(args.globe_fps * args.globe_duration / 2.0)))
            globe = render_globe_svg(
                cities,
                coarse,
                theme,
                width=args.globe_width,
                borders=borders,
                frames=frames,
                duration=args.globe_duration,
            )
            out = out_dir / f"worldmap-globe-{theme}.svg"
            out.write_text(globe, encoding="utf-8")
            print(
                f"wrote {out} ({len(cities)} cities, {len(globe)} bytes)",
                file=sys.stderr,
            )
    return 0


def command_gif(args):
    document = _read_places(args.data)
    cities = document["cities"]
    land = load_land_coarse()
    borders = load_borders()
    frames = render_globe_gif(
        cities,
        land,
        args.theme,
        width=args.width,
        fps=args.fps,
        duration=args.duration,
        borders=borders,
        supersample=args.supersample,
        colors=args.colors,
    )
    out = pathlib.Path(args.out)
    frames[0].save(
        out,
        save_all=True,
        append_images=frames[1:],
        duration=max(20, int(round(1000.0 / args.fps))),
        loop=0,
        optimize=True,
        disposal=2,
    )
    print(
        "wrote %s (%d frames, %d bytes)" % (out, len(frames), out.stat().st_size),
        file=sys.stderr,
    )
    return 0


def command_all(args):
    args.out = str(pathlib.Path(args.data_dir) / "places.json")
    command_import(args)
    args.data = args.out
    command_render(args)
    return 0


def build_parser():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def import_options(p):
        p.add_argument("input", help="Timeline export file or directory")
        p.add_argument(
            "--out", default=str(DEFAULT_DATA), help="city-level JSON to write"
        )
        p.add_argument(
            "--max-city-km",
            type=float,
            default=DEFAULT_MAX_CITY_KM,
            help="drop visit samples farther than this from a populated place",
        )
        p.add_argument(
            "--max-path-km",
            type=float,
            default=DEFAULT_MAX_PATH_KM,
            help=(
                "drop position/path samples farther than this from a populated "
                "place (keeps highway noise out; default %(default)s)"
            ),
        )
        p.add_argument(
            "--min-visits",
            type=int,
            default=1,
            help="drop cities with fewer visits (default: 1)",
        )
        p.add_argument("--cities", help="override the vendored city gazetteer")

    def render_options(p):
        p.add_argument(
            "data", nargs="?", default=str(DEFAULT_DATA), help="city-level JSON to draw"
        )
        p.add_argument("--out-dir", default=str(REPO_ROOT), help="where SVGs go")
        p.add_argument("--theme", choices=["light", "dark", "both"], default="both")
        p.add_argument("--width", type=int, default=1280)
        p.add_argument(
            "--animated",
            action=argparse.BooleanOptionalAction,
            default=True,
            help="also write worldmap-animated-<theme>.svg (default: yes)",
        )
        p.add_argument(
            "--duration",
            type=float,
            default=90.0,
            help="seconds for one ping-pong cycle of the animated map",
        )
        p.add_argument(
            "--drift",
            action=argparse.BooleanOptionalAction,
            default=True,
            help="also write worldmap-drift-<theme>.svg (default: yes)",
        )
        p.add_argument(
            "--globe",
            action=argparse.BooleanOptionalAction,
            default=True,
            help="also write worldmap-globe-<theme>.svg (default: yes)",
        )
        p.add_argument("--globe-width", type=int, default=640)
        p.add_argument("--globe-frames", type=int, default=24)
        p.add_argument("--globe-duration", type=float, default=24.0)
        p.add_argument(
            "--globe-fps",
            type=float,
            help="derive globe frames from this fps and --globe-duration",
        )

    p_import = sub.add_parser("import", help="export -> data/places.json (PII-stripped)")
    import_options(p_import)
    p_import.set_defaults(func=command_import)

    p_render = sub.add_parser("render", help="data/places.json -> worldmap-*.svg")
    render_options(p_render)
    p_render.set_defaults(func=command_render)

    p_gif = sub.add_parser("gif", help="places.json -> animated GIF of the globe")
    p_gif.add_argument(
        "data", nargs="?", default=str(DEFAULT_DATA), help="city-level JSON to draw"
    )
    p_gif.add_argument("--out", default="worldmap-globe.gif")
    p_gif.add_argument("--width", type=int, default=720, help="output width in px")
    p_gif.add_argument("--fps", type=float, default=12.0)
    p_gif.add_argument(
        "--duration", type=float, default=24.0, help="seconds per forward+back cycle"
    )
    p_gif.add_argument("--theme", choices=["light", "dark"], default="dark")
    p_gif.add_argument("--supersample", type=int, default=2)
    p_gif.add_argument("--colors", type=int, default=128, help="GIF palette size")
    p_gif.set_defaults(func=command_gif)

    p_all = sub.add_parser("all", help="import then render")
    import_options(p_all)
    p_all.add_argument(
        "--data-dir", default=str(DEFAULT_DATA.parent), help="where places.json goes"
    )
    p_all.add_argument("--out-dir", default=str(REPO_ROOT), help="where SVGs go")
    p_all.add_argument("--theme", choices=["light", "dark", "both"], default="both")
    p_all.add_argument("--width", type=int, default=1280)
    p_all.add_argument(
        "--animated",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="also write worldmap-animated-<theme>.svg (default: yes)",
    )
    p_all.add_argument(
        "--duration",
        type=float,
        default=90.0,
        help="seconds for one ping-pong cycle of the animated map",
    )
    p_all.add_argument(
            "--drift",
            action=argparse.BooleanOptionalAction,
            default=True,
            help="also write worldmap-drift-<theme>.svg (default: yes)",
        )
    p_all.add_argument(
            "--globe",
            action=argparse.BooleanOptionalAction,
            default=True,
            help="also write worldmap-globe-<theme>.svg (default: yes)",
        )
    p_all.add_argument("--globe-width", type=int, default=640)
    p_all.add_argument("--globe-frames", type=int, default=24)
    p_all.add_argument("--globe-duration", type=float, default=24.0)
    p_all.add_argument(
            "--globe-fps",
            type=float,
            help="derive globe frames from this fps and --globe-duration",
        )
    p_all.set_defaults(func=command_all)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
