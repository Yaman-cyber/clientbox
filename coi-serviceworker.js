/*!
 * COOP/COEP Service Worker — enables cross-origin isolation (SharedArrayBuffer)
 * on static sites that can't set response headers (e.g. GitHub Pages, python -m http.server).
 *
 * Based on gzuidhof/coi-serviceworker (MIT). Trimmed to only what clientbox needs.
 *
 * Uses COEP: credentialless so cross-origin CDN scripts (Pyodide, CheerpJ, .NET WASM)
 * load without requiring CORP headers from the origin server.
 */

if (typeof window === "undefined") {
  // Service worker context
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener("message", (ev) => {
    if (ev.data && ev.data.type === "deregister") {
      self.registration
        .unregister()
        .then(() => self.clients.matchAll())
        .then((clients) => clients.forEach((c) => c.navigate(c.url)));
    }
  });

  self.addEventListener("fetch", (event) => {
    const r = event.request;
    if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;

    event.respondWith(
      fetch(r)
        .then((response) => {
          if (response.status === 0) return response;
          const headers = new Headers(response.headers);
          headers.set("Cross-Origin-Embedder-Policy", "credentialless");
          headers.set("Cross-Origin-Opener-Policy", "same-origin");
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        })
        .catch((e) => console.error(e))
    );
  });
} else {
  // Page context — registration script
  (() => {
    if (window.crossOriginIsolated) return;
    if (!window.isSecureContext) return;
    if (!navigator.serviceWorker) return;

    const swUrl = document.currentScript && document.currentScript.src;
    if (!swUrl) return;

    navigator.serviceWorker.register(swUrl).then(
      (registration) => {
        registration.addEventListener("updatefound", () => window.location.reload());
        if (registration.active && !navigator.serviceWorker.controller) {
          window.location.reload();
        }
      },
      (err) => console.warn("[coi-sw] registration failed:", err)
    );
  })();
}
