export const runDesktopWorker: typeof import("@ycoding-ai/desktop/worker").runDesktopWorker = () =>
  Promise.reject(
    new Error("Desktop client requires the native ycoding executable; it is not supported by the Node CLI."),
  )
