// Minimal service worker: it makes the app installable, but always fetches
// from the network so every update shows up immediately while we're building.
// Offline caching comes in step 9.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  // Only the app's own files. Requests to other sites (Google Maps, the Sheet's
  // script, map tiles) go straight to the network without passing through here.
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request));
});
