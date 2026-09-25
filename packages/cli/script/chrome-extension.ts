import { copyFile, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { BrowserExtension } from "@ycoding-ai/core/browser/extension"

export const chromeExtensionSource = path.resolve(import.meta.dir, "../../../extensions/chrome")

export async function copyChromeExtension(binDirectory: string) {
  const destination = path.join(binDirectory, BrowserExtension.directory)
  await rm(destination, { recursive: true, force: true })
  await mkdir(path.join(destination, "icons"), { recursive: true })
  await Promise.all(
    BrowserExtension.files.map((file) => copyFile(path.join(chromeExtensionSource, file), path.join(destination, file))),
  )
}
