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
    expect(await Bun.file(path.join(root, "config", "service-local.json")).json()).toEqual({
      hostname: "127.0.0.2",
    })
    expect(await Bun.file(path.join(root, "config", "service.json")).exists()).toBe(false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("service filenames isolate installation channels", () => {
  expect(ServiceConfig.filename("latest")).toBe("service.json")
  expect(ServiceConfig.filename("local")).toBe("service-local.json")
  expect(ServiceConfig.filename("preview-a")).not.toBe(ServiceConfig.filename("preview-b"))
  expect(ServiceConfig.filename("preview-a")).not.toBe(ServiceConfig.filename("latest"))
  expect(ServiceConfig.versionBelongsToChannel("0.0.0-preview-a-1234", "preview-a")).toBe(true)
  expect(ServiceConfig.versionBelongsToChannel("0.0.0-preview-a-1234.2", "preview-a")).toBe(true)
  expect(ServiceConfig.versionBelongsToChannel("0.0.0-preview-a-20260721094210123", "preview-a")).toBe(true)
  expect(ServiceConfig.versionBelongsToChannel("0.0.0-preview-a-other-1234", "preview-a")).toBe(false)
  expect(ServiceConfig.versionBelongsToChannel("1.2.3", "preview-a")).toBe(false)
})

test("preview registration migration never moves stable discovery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-service-migration-"))
  const legacy = path.join(root, "service.json")
  const target = path.join(root, ServiceConfig.filename("preview-a"))
  try {
    await fs.writeFile(
      legacy,
      JSON.stringify({ id: "old-preview", version: "0.0.0-preview-a-1234", url: "http://localhost:4096", pid: 1 }),
    )
    await Effect.runPromise(
      ServiceConfig.migrateRegistration(legacy, target, "preview-a", "0.0.0-preview-a-5678").pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(await Bun.file(legacy).exists()).toBe(true)
    expect(await Bun.file(target).json()).toMatchObject({ id: "old-preview" })

    await fs.rm(target)
    await fs.writeFile(legacy, JSON.stringify({ id: "stable", version: "1.2.3", url: "http://localhost:4096", pid: 1 }))
    await Effect.runPromise(
      ServiceConfig.migrateRegistration(legacy, target, "preview-a", "0.0.0-preview-a-5678").pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(await Bun.file(legacy).exists()).toBe(true)
    expect(await Bun.file(target).exists()).toBe(false)

    await fs.writeFile(
      legacy,
      JSON.stringify({ id: "old-preview", version: "0.0.0-preview-a-1234", url: "http://localhost:4096", pid: 1 }),
    )
    await fs.writeFile(target, JSON.stringify({ id: "current-preview" }))
    await Effect.runPromise(
      ServiceConfig.migrateRegistration(legacy, target, "preview-a", "0.0.0-preview-a-5678").pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(await Bun.file(legacy).exists()).toBe(true)
    expect(await Bun.file(target).json()).toMatchObject({ id: "current-preview" })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
