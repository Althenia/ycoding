import { expect, test } from "bun:test"
import { BrowserExtension } from "@ycoding-ai/core/browser/extension"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { chromeExtensionSource, copyChromeExtension } from "../script/chrome-extension"

test("copies the Chrome extension runtime files beside a built executable", async () => {
  const bin = await mkdtemp(path.join(os.tmpdir(), "ycoding-extension-package-"))
  try {
    await copyChromeExtension(bin)
    const extension = path.join(bin, "ycoding-chrome-extension")
    const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: extension }))).sort()
    expect(files).toEqual([...BrowserExtension.files])
    expect(await readFile(path.join(extension, "manifest.json"), "utf8")).toBe(
      await readFile(path.join(chromeExtensionSource, "manifest.json"), "utf8"),
    )
  } finally {
    await rm(bin, { recursive: true, force: true })
  }
})
