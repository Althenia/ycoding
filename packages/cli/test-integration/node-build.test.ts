import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Schema } from "effect"
import { Service } from "@ycoding-ai/client/effect/service"
import { DatabaseFormat } from "@ycoding-ai/core/database/format"
import { Script } from "@ycoding-ai/script"
import * as ServiceConfig from "../src/services/service-config"
import { attentionSoundAssets, nodeExecArgv } from "../src/node/target"
import { NODE_BINARY } from "../src/binary"

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
        ["desktop-client", "--resources", directory, "--preferences", path.join(directory, "preferences.json")],
      ]) {
        const result = spawnSync(path.join(directory, "cli-node-darwin-arm64/bin", NODE_BINARY), args, {
          cwd: directory,
          env: { ...process.env, XDG_DATA_HOME: path.join(directory, "data"), YCODING_DISABLE_MODELS_FETCH: "1" },
          encoding: "utf8",
          timeout: 10_000,
        })
        expect(result.error).toBeUndefined()
        expect(result.status, result.stdout + result.stderr).toBe(1)
        expect(result.stderr).toContain(
          args[0] === "desktop-client"
            ? "Desktop client requires the native ycoding executable; it is not supported by the Node CLI."
            : "Meeting requires the native ycoding executable; it is not supported by the Node CLI.",
        )
        expect(result.stdout).not.toContain("Live page:")
      }
      await expect(stat(path.join(directory, "data/ycoding/meeting"))).rejects.toMatchObject({ code: "ENOENT" })
      await assert.rejects(stat(path.join(directory, "preferences.json")), { code: "ENOENT" })
      await checkNodeRecovery(directory)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  180_000,
)

async function checkNodeRecovery(directory: string) {
  if (!process.env.NODE_BIN) throw new Error("NODE_BIN must identify the installed Node 26.4.0 runtime")
  const version = spawnSync(process.env.NODE_BIN, ["-p", "process.versions.node"], { encoding: "utf8" })
  expect(version.status).toBe(0)
  expect(version.stdout.trim()).toBe("26.4.0")
  const root = path.join(directory, "recovery")
  const data = path.join(root, "data", "ycoding")
  const config = path.join(root, "config", "ycoding")
  await mkdir(data, { recursive: true })
  await mkdir(config, { recursive: true })
  const filename = path.join(data, "ycoding.db")
  const seed = new DatabaseSync(filename)
  seed.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('preserved')")
  seed.close()
  const portOwner = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = portOwner.port
  await portOwner.stop(true)
  if (!port) throw new Error("Synthetic service port is unavailable")
  const registration = ServiceConfig.filename(Script.channel)
  await writeFile(path.join(config, registration), JSON.stringify({ port }))
  const owner = Bun.spawn(
    [
      process.env.NODE_BIN,
      ...nodeExecArgv,
      path.join(import.meta.dir, "../dist-node/ycoding.mjs"),
      "serve",
      "--service",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        YCODING_TEST_HOME: root,
        YCODING_DB: undefined,
        YCODING_DISABLE_CHANNEL_DB: "1",
        YCODING_DISABLE_MODELS_FETCH: "1",
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_STATE_HOME: path.join(root, "state"),
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  )
  const errors = new Response(owner.stderr).text()
  try {
    let ready = false
    for (let attempt = 0; attempt < 400; attempt++) {
      if (owner.exitCode !== null) throw new Error(await errors)
      const record = await readFile(path.join(root, "state/ycoding", registration), "utf8").catch((error: unknown) => {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
        throw error
      })
      if (record) {
        const info = Schema.decodeUnknownSync(Service.Info)(JSON.parse(record))
        const response = await fetch(new URL("/api/health", info.url), {
          headers: { authorization: "Basic " + btoa(`ycoding:${info.password}`) },
        })
        expect(response.status).not.toBe(500)
        if (response.status === 200) {
          ready = true
          break
        }
      }
      await Bun.sleep(50)
    }
    if (!ready) {
      owner.kill("SIGTERM")
      await owner.exited
      throw new Error(`Node service did not become ready: ${await errors}`)
    }
    const backups = await readdir(path.join(data, "unsupported"))
    expect(backups).toHaveLength(1)
    const preserved = new DatabaseSync(path.join(data, "unsupported", backups[0], "ycoding.db"), { readOnly: true })
    const current = new DatabaseSync(filename, { readOnly: true })
    try {
      expect(preserved.prepare("SELECT value FROM sentinel").get()?.value).toBe("preserved")
      expect(current.prepare("SELECT id FROM database_format").get()?.id).toBe(DatabaseFormat.CurrentID)
    } finally {
      preserved.close()
      current.close()
    }
  } finally {
    if (owner.exitCode === null) owner.kill("SIGTERM")
    await owner.exited
    await errors
  }
}
