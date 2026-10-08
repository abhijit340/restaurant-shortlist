// Service worker: makes the app installable and lets it open with no signal.
//
// The app's own files are fetched from the network first, so updates show up
// immediately; a copy is kept and used when the network fails, or when it hasn't
// answered within a few seconds (a weak signal, where waiting could take minutes).
// Requests to other sites (Google Maps, the Sheet's script, map tiles) go
// straight to the network without passing through here.
const CACHE = "nearby-eats-v1";
const WAIT_MS = 3000; // how long to wait for the network before using the saved copy

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  const fresh = fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  });
  // ignoreSearch: "/?anything" still finds the saved page.
  const saved = () => caches.match(request, { ignoreSearch: true });
  const tooSlow = new Promise((resolve) => setTimeout(resolve, WAIT_MS));

  event.respondWith(
    // Whichever comes first: the network's answer, or nothing (it failed or was too slow).
    Promise.race([fresh.catch(() => undefined), tooSlow])
      // Nothing: use the saved copy, or with no saved copy keep waiting for the network.
      .then((response) => response || saved().then((copy) => copy || fresh))
  );
  // Even when the saved copy was shown, let the download finish so the next open is up to date.
  event.waitUntil(fresh.catch(() => {}));
});
