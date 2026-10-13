import { NodeFileSystem } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FrontendPaths } from "../src/paths"
import { ServiceConfig } from "../src/services/service-config"

test("managed service ports are stable and namespaced to YCoding", () => {
  expect(ServiceConfig.defaultPort("latest")).toBe(43_094)
  expect(ServiceConfig.defaultPort("local")).toBe(26_378)
  expect(ServiceConfig.defaultPort("main")).toBe(29_706)
  expect(ServiceConfig.defaultPort("preview-a")).toBe(ServiceConfig.defaultPort("preview-a"))
  expect(ServiceConfig.defaultPort("preview-a")).not.toBe(ServiceConfig.defaultPort("preview-b"))
  expect(ServiceConfig.defaultPort("main")).not.toBe(45_430)
})

test("local channel stores service config with the local service filename", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-service-"))
  try {
    await Effect.runPromise(
      ServiceConfig.set("hostname", "127.0.0.2").pipe(
        Effect.provide(
          FrontendPaths.layerWith({
            data: path.join(root, "data"),
            config: path.join(root, "config"),
            state: path.join(root, "state"),
          }),
        ),
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(await Bun.file(path.join(root, "config/service-local.json")).json()).toEqual({ hostname: "127.0.0.2" })
    expect(await Bun.file(path.join(root, "config/service.json")).exists()).toBe(false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("service filenames isolate installation channels", () => {
  expect(ServiceConfig.filename("latest")).toBe("service.json")
  expect(ServiceConfig.filename("local")).toBe("service-local.json")
  expect(ServiceConfig.filename("beta")).toBe("service-a295e0bdde1938d1fbfd343e5a3e569e868e1465.json")
  expect(ServiceConfig.filename("preview-a")).not.toBe(ServiceConfig.filename("preview-b"))
  expect(ServiceConfig.filename("preview-a")).not.toBe(ServiceConfig.filename("latest"))
  for (const version of ["0.0.0-preview-a-1234", "0.0.0-preview-a-1234.2", "0.0.0-preview-a-20260721094210123"])
    expect(ServiceConfig.versionBelongsToChannel(version, "preview-a")).toBe(true)
  expect(ServiceConfig.versionBelongsToChannel("0.0.0-preview-a-other-1234", "preview-a")).toBe(false)
  expect(ServiceConfig.versionBelongsToChannel("1.2.3", "preview-a")).toBe(false)
})

test("preview registration migration preserves stable and current discovery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-service-migration-"))
  const legacy = path.join(root, "service.json")
  const target = path.join(root, ServiceConfig.filename("preview-a"))
  const migrate = () =>
    Effect.runPromise(
      ServiceConfig.migrateRegistration(legacy, target, "preview-a", "0.0.0-preview-a-5678").pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    )
  try {
    await fs.writeFile(
      legacy,
      JSON.stringify({ id: "old-preview", version: "0.0.0-preview-a-1234", url: "http://localhost:4096", pid: 1 }),
    )
    await migrate()
    expect(await Bun.file(legacy).exists()).toBe(true)
    expect(await Bun.file(target).json()).toMatchObject({ id: "old-preview" })
    await fs.rm(target)
    await fs.writeFile(legacy, JSON.stringify({ id: "stable", version: "1.2.3", url: "http://localhost:4096", pid: 1 }))
    await migrate()
    expect(await Bun.file(legacy).exists()).toBe(true)
    expect(await Bun.file(target).exists()).toBe(false)
    await fs.writeFile(
      legacy,
      JSON.stringify({ id: "old-preview", version: "0.0.0-preview-a-1234", url: "http://localhost:4096", pid: 1 }),
    )
    await fs.writeFile(target, JSON.stringify({ id: "current-preview" }))
    await migrate()
    expect(await Bun.file(legacy).exists()).toBe(true)
    expect(await Bun.file(target).json()).toMatchObject({ id: "current-preview" })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("CLI preserves the Rust Store and actionable backend startup refusal without database recovery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-cli-refusal-"))
  const store = path.join(root, "data/ycoding/ycoding.redb")
  const diagnostic = path.join(root, "startup-error")
  await fs.mkdir(path.dirname(store), { recursive: true })
  await fs.writeFile(store, "not a YCoding Store")
  const child = Bun.spawn(
    [process.execPath, path.resolve(import.meta.dirname, "../src/index.ts"), "serve", "--service", "--port", "0"],
    {
      env: {
        ...process.env,
        HOME: root,
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_STATE_HOME: path.join(root, "state"),
        YCODING_CONFIG_DIR: undefined,
        YCODING_SERVICE_STARTUP_ERROR_FILE: diagnostic,
        YCODING_DISABLE_MODELS_FETCH: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code).toBe(1)
    expect(stdout + stderr).toContain("unreadable or uses an unsupported format")
    expect(await fs.readFile(diagnostic, "utf8")).toContain("unreadable or uses an unsupported format")
    expect(await fs.readFile(store, "utf8")).toBe("not a YCoding Store")
    expect(await Bun.file(path.join(root, "data/ycoding/ycoding.db")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "state/ycoding/service-local.json")).exists()).toBe(false)
  } finally {
    child.kill()
    await child.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)
