import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { attentionSoundAssets } from "../src/node/target"
import { NODE_BINARY } from "../src/binary"
import { runtimeAssetKey } from "../vite.node.config"

const macTest = process.platform === "darwin" && process.arch === "arm64" ? test : test.skip

macTest(
  "builds and smokes a macOS Node CLI with its complete signed computer app",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-node-build-"))
    try {
      const build = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "../script/build-node.ts"),
          "--single",
          "--skip-install",
          `--outdir=${directory}`,
        ],
        {
          cwd: path.join(import.meta.dir, ".."),
          env: { ...process.env, NODE_ENV: "production" },
          stdout: "ignore",
          stderr: "pipe",
        },
      )
      const [status, error] = await Promise.all([build.exited, new Response(build.stderr).text()])
      expect(status, error.slice(-2048)).toBe(0)
      const assets = JSON.parse(await readFile(path.join(import.meta.dir, "../dist-node/sea.json"), "utf8"))
        .assets as Record<string, string>
      expect(Object.keys(assets).filter((key) => key === runtimeAssetKey)).toEqual([runtimeAssetKey])
      const payload = await readFile(assets[runtimeAssetKey])
      const executable = await readFile(path.join(directory, "cli-node-darwin-arm64/bin", NODE_BINARY))
      const offset = executable.indexOf(payload)
      expect(offset).toBeGreaterThanOrEqual(0)
      expect(executable.indexOf(payload, offset + payload.length)).toBe(-1)
      expect(executable.includes(payload.toString("base64"))).toBe(false)
      const temporary = path.join(directory, "node-temp")
      await mkdir(temporary, { mode: 0o700 })
      const env = {
        ...process.env,
        TMPDIR: temporary,
        TMP: temporary,
        TEMP: temporary,
        XDG_CONFIG_HOME: path.join(directory, "config"),
        XDG_DATA_HOME: path.join(directory, "data"),
        XDG_STATE_HOME: path.join(directory, "state"),
        XDG_CACHE_HOME: path.join(directory, "cache"),
        YCODING_DISABLE_MODELS_FETCH: "1",
        YCODING_CONFIG_PROJECT_DISABLE: "1",
        YCODING_RUNTIME_EXECUTABLE: path.join(directory, "unavailable-source-runtime"),
      }
      const binary = path.join(directory, "cli-node-darwin-arm64/bin", NODE_BINARY)
      const warm = spawnSync(binary, ["--version"], { env, encoding: "utf8", timeout: 10_000 })
      expect(warm.status, warm.stderr).toBe(0)
      const started = spawnSync(binary, ["remote", "status", "--standalone"], {
        cwd: directory,
        env,
        encoding: "utf8",
        timeout: 10_000,
      })
      expect(started.status, started.stdout + started.stderr).toBe(0)
      expect(started.stdout).toContain("Not enrolled")
      const cache = path.join(temporary, `ycoding-node-${process.getuid?.() ?? "user"}`)
      const directories = (await readdir(cache, { withFileTypes: true })).filter((entry) => entry.isDirectory())
      expect(directories).toHaveLength(1)
      await writeFile(path.join(cache, directories[0].name, runtimeAssetKey), "corrupt")
      const corrupt = spawnSync(binary, ["remote", "status", "--standalone"], {
        env,
        encoding: "utf8",
        timeout: 10_000,
      })
      expect(corrupt.error).toBeUndefined()
      expect(corrupt.status).not.toBe(0)
      expect(corrupt.stdout + corrupt.stderr).toContain("Packaged runtime does not match its embedded digest")
      expect(
        await Bun.file(
          path.join(directory, "cli-node-darwin-arm64/bin/YCoding Computer Use.app/Contents/Resources/YCoding.icns"),
        ).exists(),
      ).toBe(true)
      expect(
        await Bun.file(
          path.join(directory, "cli-node-darwin-arm64/bin/ycoding-chrome-extension/manifest.json"),
        ).exists(),
      ).toBe(true)
      expect(
        await Promise.all(
          attentionSoundAssets.map((key) => Bun.file(path.join(import.meta.dir, "../dist-node/assets", key)).exists()),
        ),
      ).toEqual(attentionSoundAssets.map(() => true))
      for (const args of [
        ["meeting", directory, "--no-open"],
        ["serve", "--meeting"],
      ]) {
        const result = spawnSync(path.join(directory, "cli-node-darwin-arm64/bin", NODE_BINARY), args, {
          cwd: directory,
          env: { ...process.env, XDG_DATA_HOME: path.join(directory, "data"), YCODING_DISABLE_MODELS_FETCH: "1" },
          encoding: "utf8",
          timeout: 10_000,
        })
        expect(result.error).toBeUndefined()
        expect(result.status, result.stdout + result.stderr).toBe(1)
        expect(result.stdout).toContain(
          "Meeting requires the native ycoding executable; it is not supported by the Node CLI.",
        )
        expect(result.stdout).not.toContain("Live page:")
      }
      await expect(stat(path.join(directory, "data/ycoding/meeting"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  180_000,
)
