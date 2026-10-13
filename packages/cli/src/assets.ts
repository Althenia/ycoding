export * as BrowserExtension from "./assets"

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
export const location = (executable = process.execPath) =>
  path.parse(executable).name === "bun"
    ? path.resolve(import.meta.dirname, "../../../extensions/chrome")
    : path.join(path.dirname(executable), directory)

export const helperBinary = "ycoding-computer-use"
export const helperApplication = "YCoding Computer Use.app"
export const applicationPath = (executable = process.execPath) =>
  path.parse(executable).name === "bun"
    ? path.resolve(import.meta.dirname, "../../core/.cache/computer-use", helperApplication)
    : path.join(path.dirname(executable), helperApplication)
