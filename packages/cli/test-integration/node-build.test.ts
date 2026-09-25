import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const macTest = process.platform === "darwin" && process.arch === "arm64" ? test : test.skip

macTest("builds and smokes a macOS Node CLI with its complete signed computer app", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-node-build-"))
  try {
    const build = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "../script/build-node.ts"), "--single", "--skip-install", `--outdir=${directory}`],
      { cwd: path.join(import.meta.dir, ".."), env: { ...process.env, NODE_ENV: "production" }, stdout: "ignore", stderr: "pipe" },
    )
    const [status, error] = await Promise.all([build.exited, new Response(build.stderr).text()])
    expect(status, error.slice(-2048)).toBe(0)
    expect(
      await Bun.file(
        path.join(directory, "cli-node-darwin-arm64/bin/ycoding-computer-helper.app/Contents/Resources/YCoding.icns"),
      ).exists(),
    ).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 180_000)
