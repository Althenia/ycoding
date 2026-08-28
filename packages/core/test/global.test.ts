import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@ycoding-ai/core/global"

describe("global paths", () => {
  test("test preload redirects data to its XDG sandbox", () => {
    const root = process.env.YCODING_TEST_XDG_ROOT
    if (!root) throw new Error("YCODING_TEST_XDG_ROOT was not set by the test preload")

    expect(Global.Path.data).toBe(path.join(root, "data", "ycoding"))
  })

  test("tmp path is under the system temp directory", () => {
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), "ycoding"))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })

  test("log directory is private", async () => {
    if (process.platform === "win32") return
    expect((await fs.stat(Global.Path.log)).mode & 0o777).toBe(0o700)
  })
})
