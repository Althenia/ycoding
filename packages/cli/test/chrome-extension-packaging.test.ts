import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { chromeExtensionSource, copyChromeExtension } from "../script/chrome-extension"
import { interactionExtensionFiles } from "../src/update/interaction-layout"

test("packages the Interaction extension with a self-contained Chromium worker", async () => {
  const bin = await mkdtemp(path.join(os.tmpdir(), "ycoding-extension-package-"))
  try {
    const extension = await copyChromeExtension(bin)
    expect(path.dirname(extension)).toBe(bin)
    expect(path.basename(extension)).toBe("ycoding-chrome-extension")
    expect((await readdir(extension, { recursive: true })).sort()).toEqual([
      "icons", "icons/active-16.png", "icons/active-32.png", "icons/idle-128.png", "icons/idle-16.png", "icons/idle-32.png", "icons/idle-48.png",
      "manifest.json", "panel.css", "panel.html", "panel.js", "popup.css", "popup.html", "popup.js", "service-worker.js",
    ])
    for (const file of interactionExtensionFiles.filter((name) => name !== "service-worker.js")) {
      expect(await Bun.file(path.join(extension, file)).text()).toBe(
        await Bun.file(path.join(chromeExtensionSource, file)).text(),
      )
    }
    const manifest = await Bun.file(path.join(extension, "manifest.json")).json()
    expect(manifest.name).toBe("YCoding Interaction")
    expect(manifest.background).toEqual({ service_worker: "service-worker.js", type: "module" })
    const referenced = [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon), manifest.action.default_popup]
    for (const file of referenced) expect(interactionExtensionFiles).toContain(file)
    const worker = await Bun.file(path.join(extension, manifest.background.service_worker)).text()
  expect(worker).not.toMatch(/^import[ \t]/m)
    expect(worker).toContain("runtime.onMessage.addListener")
    expect(worker).toContain("ycoding-script-")
    expect(worker).toContain("Runtime.terminateExecution")
  } finally {
    await rm(bin, { recursive: true, force: true })
  }
})
