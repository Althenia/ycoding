import { copyFile, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { BrowserExtension } from "@ycoding-ai/core/browser/extension"

export const chromeExtensionSource = path.resolve(import.meta.dir, "../../../extensions/chrome")

export async function copyChromeExtension(binDirectory: string) {
  const destination = path.join(binDirectory, BrowserExtension.directory)
  await rm(destination, { recursive: true, force: true })
  await mkdir(path.join(destination, "icons"), { recursive: true })
  const worker = await Bun.build({
    entrypoints: [path.join(chromeExtensionSource, "service-worker.js")],
    target: "browser",
    format: "esm",
    external: [path.join(chromeExtensionSource, "protocol.js")],
  })
  if (!worker.success) throw new AggregateError(worker.logs, "Failed to bundle the Chrome extension service worker")
  await Promise.all([
    Bun.write(path.join(destination, "service-worker.js"), worker.outputs[0]),
    ...BrowserExtension.files
      .filter((file) => file !== "service-worker.js")
      .map((file) => copyFile(path.join(chromeExtensionSource, file), path.join(destination, file))),
  ])
}
