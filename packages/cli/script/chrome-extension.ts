import { copyFile, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { BrowserExtension } from "@ycoding-ai/core/browser/extension"

export const chromeExtensionSource = path.resolve(import.meta.dir, "../../../extensions/chrome")

const bundled = ["service-worker.js", "protocol.js", "popup.js", "popup.css"] as const

async function bundle(entry: string, external?: string[]) {
  const result = await Bun.build({
    entrypoints: [path.join(chromeExtensionSource, entry)],
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "none",
    ...(external ? { external } : {}),
  })
  if (!result.success) throw new AggregateError(result.logs, `Failed to bundle the Chrome extension entry ${entry}`)
  if (result.outputs.length !== 1)
    throw new Error(`Bundling the Chrome extension entry ${entry} produced ${result.outputs.length} outputs`)
  return result.outputs[0]
}

export async function copyChromeExtension(binDirectory: string, family: BrowserExtension.Family = "chrome") {
  const target = BrowserExtension.family(family)
  const destination = path.join(binDirectory, target.directory)
  await rm(destination, { recursive: true, force: true })
  await mkdir(path.join(destination, "icons"), { recursive: true })
  const [worker, protocol, popup, stylesheet] = await Promise.all([
    bundle("service-worker.js", [path.join(chromeExtensionSource, "protocol.js")]),
    bundle("protocol.js"),
    bundle("popup.js"),
    bundle("popup.css"),
  ])
  const license = /\/\*![\s\S]*?\*\//.exec(await Bun.file(path.join(chromeExtensionSource, "popup.css")).text())?.[0]
  if (!license) throw new Error("popup.css does not contain the font license required in the packaged extension")
  await Promise.all([
    Bun.write(path.join(destination, "service-worker.js"), worker),
    Bun.write(path.join(destination, "protocol.js"), protocol),
    Bun.write(path.join(destination, "popup.js"), popup),
    Bun.write(path.join(destination, "popup.css"), `${license}\n${await stylesheet.text()}`),
    ...BrowserExtension.files
      .filter((file) => !(bundled as readonly string[]).includes(file) && file !== "manifest.json")
      .map((file) => copyFile(path.join(chromeExtensionSource, file), path.join(destination, file))),
    writeManifest(destination, target.label),
  ])
}

async function writeManifest(destination: string, label: string) {
  const source = path.join(chromeExtensionSource, "manifest.json")
  if (label === "Chrome") return copyFile(source, path.join(destination, "manifest.json"))
  const manifest = JSON.parse(await Bun.file(source).text()) as Record<string, unknown>
  manifest.description = String(manifest.description ?? "").replace("Chrome", label)
  const action = manifest.action as Record<string, unknown> | undefined
  if (action && typeof action.default_title === "string")
    action.default_title = action.default_title.replace("Chrome", label)
  await Bun.write(path.join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
}

if (import.meta.main) {
  const binDirectory = process.argv[2]
  const family = process.argv[3] ?? "chrome"
  if (!binDirectory || !["chrome", "edge", "brave", "all"].includes(family)) {
    console.error("usage: bun packages/cli/script/chrome-extension.ts <bin-directory> [chrome|edge|brave|all]")
    process.exit(2)
  }
  const resolved = path.resolve(binDirectory)
  const targets = family === "all" ? BrowserExtension.families : [BrowserExtension.family(family as BrowserExtension.Family)]
  for (const target of targets) {
    await copyChromeExtension(resolved, target.id)
    console.log(path.join(resolved, target.directory))
  }
}
