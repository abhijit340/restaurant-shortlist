// Service worker: makes the app installable and lets it open with no signal.
//
// The app's own files are always fetched from the network first, so updates
// show up immediately; a copy is kept and used only when the network fails.
// Requests to other sites (Google Maps, the Sheet's script, map tiles) go
// straight to the network without passing through here.
const CACHE = "nearby-eats-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      // ignoreSearch: "/?anything" still finds the saved page.
      .catch(() => caches.match(request, { ignoreSearch: true }))
  );
});
