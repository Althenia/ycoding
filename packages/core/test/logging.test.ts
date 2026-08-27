import { afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, Logger } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@ycoding-ai/core/global"
import { Logging } from "@ycoding-ai/core/observability/logging"

describe("Logging", () => {
  const temporary: string[] = []

  afterEach(async () => {
    await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
  })

  test("uses a local-specific log file for local installs", () => {
    expect(Logging.file(true, "local")).toBe(path.join(Global.Path.log, "ycoding-local.log"))
  })

  test("keeps non-local installs on the default log file", () => {
    expect(Logging.file(false, "next")).toBe(path.join(Global.Path.log, "ycoding.log"))
  })

  test("creates and tightens log files for the current user only", async () => {
    if (process.platform === "win32") return
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-log-permission-test-"))
    temporary.push(dir)
    const file = path.join(dir, "ycoding.log")
    await fs.writeFile(file, "existing\n", { mode: 0o644 })

    await Effect.logInfo("secure").pipe(
      Effect.provide(
        Logger.layer([Logging.fileLogger(file, "test-run")]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie),
      ),
      Effect.scoped,
      Effect.runPromise,
    )

    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  })
})
