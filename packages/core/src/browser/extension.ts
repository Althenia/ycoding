export * as BrowserExtension from "./extension"

import path from "node:path"

export const directory = "ycoding-chrome-extension"

export const files = [
  "icons/ycoding-128.png",
  "icons/ycoding-16.png",
  "icons/ycoding-32.png",
  "icons/ycoding-48.png",
  "manifest.json",
  "popup.css",
  "popup.html",
  "popup.js",
  "protocol.js",
  "service-worker.js",
] as const

// import.meta.dir exists only under Bun, so the checkout path is resolved only for Bun source runs.
export const location = (executable = process.execPath) =>
  path.parse(executable).name === "bun"
    ? path.resolve(import.meta.dir, "../../../../extensions/chrome")
    : path.join(path.dirname(executable), directory)
