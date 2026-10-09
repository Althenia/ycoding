import { copyFile, mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const files = [
  "manifest.json",
  "service-worker.js",
  "coordinator.js",
  "protocol.js",
  "call-observer.js",
  "offscreen.html",
  "offscreen.js",
  "capture.js",
  "delivery.js",
  "worklet.js",
  "popup.html",
  "popup.js",
  "popup.css",
]
export async function buildCompanion() {
  const directory = new URL(".build/", import.meta.url)
  await mkdir(new URL("fonts/", directory), { recursive: true })
  await mkdir(new URL("icons/", directory), { recursive: true })
  await Promise.all(files.map((file) => copyFile(new URL(file, import.meta.url), new URL(file, directory))))
  await Promise.all(
    ["Geist.woff2", "GeistMono.woff2", "OFL.txt"].map((file) =>
      copyFile(new URL(`../../../assets/brand/fonts/${file}`, import.meta.url), new URL(`fonts/${file}`, directory)),
    ),
  )
  await Promise.all(
    [16, 32, 48, 128].map((size) =>
      copyFile(
        new URL(`../../chrome/icons/ycoding-${size}.png`, import.meta.url),
        new URL(`icons/ycoding-${size}.png`, directory),
      ),
    ),
  )
  return fileURLToPath(directory)
}
if (import.meta.main) console.log(await buildCompanion())
