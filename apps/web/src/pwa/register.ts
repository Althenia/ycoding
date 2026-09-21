/**
 * Registers the service worker in production builds only. The worker caches the
 * static shell and never touches API, authentication, or socket traffic.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return
  if (!("serviceWorker" in navigator)) return
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { type: "module" }).catch(() => {
      // A failed registration only means the shell cannot be served offline.
    })
  })
}
