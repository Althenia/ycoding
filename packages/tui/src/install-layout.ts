export * as BrowserExtension from "./install-layout"
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
export const location = (
  executable = process.execPath,
  checkout = path.resolve(import.meta.dir, "../../../extensions/chrome"),
) => (path.parse(executable).name === "bun" ? checkout : path.join(path.dirname(executable), directory))
