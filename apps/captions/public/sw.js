/* The app is no longer an installable web app. A browser that still has the old service worker fetches this file
 * on its next update check: it clears the caches, unregisters itself and reloads its open pages. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) await caches.delete(key);
      await self.registration.unregister();
      for (const client of await self.clients.matchAll({ type: "window" })) client.navigate(client.url);
    })(),
  );
});
