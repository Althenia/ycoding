import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { attentionSoundAssets } from "../src/node/target"
import { NODE_BINARY } from "../src/binary"

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
        path.join(directory, "cli-node-darwin-arm64/bin/YCoding Computer Use.app/Contents/Resources/YCoding.icns"),
      ).exists(),
    ).toBe(true)
    expect(await Bun.file(path.join(directory, "cli-node-darwin-arm64/bin/ycoding-chrome-extension/manifest.json")).exists()).toBe(true)
    expect(
      await Promise.all(
        attentionSoundAssets.map((key) => Bun.file(path.join(import.meta.dir, "../dist-node/assets", key)).exists()),
      ),
    ).toEqual(attentionSoundAssets.map(() => true))
    for (const args of [["meeting", directory, "--no-open"], ["serve", "--meeting"]]) {
      const result = spawnSync(path.join(directory, "cli-node-darwin-arm64/bin", NODE_BINARY), args, {
        cwd: directory,
        env: { ...process.env, XDG_DATA_HOME: path.join(directory, "data"), YCODING_DISABLE_MODELS_FETCH: "1" },
        encoding: "utf8",
        timeout: 10_000,
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stdout + result.stderr).toBe(1)
      expect(result.stdout).toContain("Meeting requires the native ycoding executable; it is not supported by the Node CLI.")
      expect(result.stdout).not.toContain("Live page:")
    }
    await expect(stat(path.join(directory, "data/ycoding/meeting"))).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 180_000)
