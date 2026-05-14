/*!
 * COOP/COEP Service Worker — enables cross-origin isolation (SharedArrayBuffer)
 * on static sites that can't set response headers (e.g. GitHub Pages, python -m http.server).
 *
 * Based on gzuidhof/coi-serviceworker (MIT). Trimmed to only what clientbox needs.
 *
 * Uses COEP: require-corp (supported by all browsers including Safari) and injects
 * Cross-Origin-Resource-Policy: cross-origin on all non-opaque subresource responses
 * so CDN scripts (Pyodide, CheerpJ, .NET WASM) load without server-side CORP headers.
 */

if (typeof window === "undefined") {
  // Service worker context
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) =>
    event.waitUntil(self.clients.claim()),
  );

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

    if (r.mode === "navigate") {
      // Navigation (document): inject COOP + COEP.
      // require-corp works in all browsers (including Safari < 17 which does not
      // recognise the newer "credentialless" value).
      event.respondWith(
        fetch(r)
          .then((response) => {
            if (response.status === 0) return response;
            const headers = new Headers(response.headers);
            headers.set("Cross-Origin-Embedder-Policy", "require-corp");
            headers.set("Cross-Origin-Opener-Policy", "same-origin");
            return new Response(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          })
          .catch((e) => {
            console.error("[coi-sw] navigation fetch failed:", e);
            return fetch(r);
          }),
      );
    } else {
      // Subresources: add Cross-Origin-Resource-Policy: cross-origin so they
      // satisfy require-corp without the origin server needing to set the header.
      // Opaque responses (no CORS) are passed through unchanged — the browser
      // will block them under require-corp regardless, but they're typically
      // not needed (all major CDNs used by clientbox are CORS-enabled).
      event.respondWith(
        fetch(r)
          .then((response) => {
            if (response.type === "opaque" || response.type === "error") {
              return response;
            }
            const headers = new Headers(response.headers);
            if (!headers.has("Cross-Origin-Resource-Policy")) {
              headers.set("Cross-Origin-Resource-Policy", "cross-origin");
            }
            return new Response(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          })
          .catch(() => fetch(r)),
      );
    }
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
        registration.addEventListener("updatefound", () =>
          window.location.reload(),
        );
        if (registration.active && !navigator.serviceWorker.controller) {
          window.location.reload();
        }
      },
      (err) => console.warn("[coi-sw] registration failed:", err),
    );
  })();
}
