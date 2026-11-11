/**
 * Offline shell for the Timeline replay map.
 *
 * Strategy: network-first with a cache fallback, for every same-origin GET.
 * Network-first means a newly posted version is what the next load gets —
 * no version bump required — while the cache keeps the app usable offline
 * after the first visit. A changed sw.js itself triggers the in-page
 * "update available" toast via skipWaiting + controllerchange.
 */

const CACHE = "timeline-replay-v2";
const CORE = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.webmanifest",
  "./js/app.js",
  "./js/worldmap.js",
  "./js/gif.js",
  "./data/world-land-coarse.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(CORE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    // "reload" makes the request bypass the browser HTTP cache and revalidate
    // at the origin, so a deploy is picked up on the very next load instead of
    // waiting out GitHub Pages' max-age (10 minutes).
    fetch(request, { cache: "reload" })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches
          .match(request, { ignoreSearch: true })
          .then((cached) => cached || caches.match("./index.html")),
      ),
  );
});
