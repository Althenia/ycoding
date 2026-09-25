import { describe, expect, test } from "bun:test"
import { BrowserExtension } from "@ycoding-ai/core/browser/extension"
import path from "node:path"

const source = path.resolve(import.meta.dir, "../../../extensions/chrome")

describe("Chrome extension location", () => {
  test("uses the checkout extension from source and the sibling folder from a packaged executable", () => {
    expect(BrowserExtension.location("/opt/homebrew/bin/bun")).toBe(source)
    expect(BrowserExtension.location("/opt/ycoding/bin/ycoding")).toBe("/opt/ycoding/bin/ycoding-chrome-extension")
  })

  test("ships every extension runtime file and no tests", async () => {
    const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: source })))
      .filter((file) => !file.startsWith("test/"))
      .sort()
    expect(files).toEqual([...BrowserExtension.files])
  })
})
