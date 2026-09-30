// Minimal service worker: it makes the app installable, but always fetches
// from the network so every update shows up immediately while we're building.
// Offline caching comes in step 9.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => event.respondWith(fetch(event.request)));
