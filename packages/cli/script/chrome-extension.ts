import { copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { interactionExtensionDirectory, interactionExtensionFiles } from "../src/update/interaction-layout"

export const chromeExtensionSource = path.resolve(import.meta.dir, "../../../extensions/interaction-chrome")

export async function copyChromeExtension(binDirectory: string) {
  const destination = path.resolve(binDirectory, interactionExtensionDirectory)
  const bundle = await Bun.build({
    entrypoints: [path.join(chromeExtensionSource, "service-worker.js")],
    target: "browser",
    format: "esm",
  })
  if (!bundle.success || bundle.outputs.length !== 1) throw new Error("Could not bundle the Interaction service worker")
  await mkdir(binDirectory, { recursive: true })
  await mkdir(path.join(destination, "icons"), { recursive: true })
  await Promise.all(interactionExtensionFiles.map((file) => file === "service-worker.js"
    ? Bun.write(path.join(destination, file), bundle.outputs[0]!)
    : copyFile(path.join(chromeExtensionSource, file), path.join(destination, file))))
  return destination
}

if (import.meta.main) {
  const destination = process.argv[2]
  if (!destination || process.argv.length !== 3) throw new Error("Usage: chrome-extension.ts <bin-directory>")
  console.log(await copyChromeExtension(destination))
}
