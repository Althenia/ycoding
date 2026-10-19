import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { mainConfig, runtimeAssetKey, type NodeBuildInput } from "../vite.node.config"
import { nodeTarget } from "../src/node/target"

const runtimeAsset = { path: "/cargo/target/release/ycoding-runtime", sha256: "ab".repeat(32) }
const input: NodeBuildInput = {
  version: "1.2.3",
  channel: "test",
  models: "undefined",
  assetHash: "hash",
  target: nodeTarget(process.platform, process.arch),
}

function runtimePlugin(config: ReturnType<typeof mainConfig>) {
  return (config.plugins ?? [])
    .flat(10)
    .find(
      (plugin) =>
        typeof plugin === "object" && plugin !== null && "name" in plugin && plugin.name === "ycoding:runtime-asset",
    )
}

test("Node build targets reject unsupported Intel Macs without excluding other platforms", () => {
  expect(() => nodeTarget("darwin", "x64")).toThrow("Unsupported Node executable target")
  expect(nodeTarget("darwin", "arm64")).toMatchObject({ platform: "darwin", arch: "arm64" })
  expect(nodeTarget("linux", "x64")).toMatchObject({ platform: "linux", arch: "x64" })
  expect(nodeTarget("win32", "x64")).toMatchObject({ platform: "win32", arch: "x64" })
})

function hook(plugin: unknown, name: "resolveId" | "load", args: unknown[]) {
  const value = Reflect.get(Object(plugin), name)
  return Reflect.apply(typeof value === "function" ? value : value.handler, {}, args)
}

test("the Node build defines the runtime asset path and digest without the raw payload", () => {
  const define = mainConfig({ ...input, runtimeAsset }).define
  expect(define?.YCODING_RUNTIME_ASSET).toBe(JSON.stringify(runtimeAsset.path))
  expect(define?.YCODING_RUNTIME_SHA256).toBe(JSON.stringify(runtimeAsset.sha256))
  expect(define).not.toHaveProperty("YCODING_RUNTIME_PAYLOAD")
})

test("a Node bundle without a runtime leaves the asset defines undefined and registers no plugin", () => {
  const config = mainConfig(input)
  expect(config.define?.YCODING_RUNTIME_ASSET).toBe("undefined")
  expect(config.define?.YCODING_RUNTIME_SHA256).toBe("undefined")
  expect(runtimePlugin(config)).toBeUndefined()
})

test("only the runtime file import resolves to the staged asset module", () => {
  const plugin = runtimePlugin(mainConfig({ ...input, runtimeAsset }))
  expect(plugin).toBeDefined()
  const id = hook(plugin, "resolveId", [
    runtimeAsset.path,
    "/src/runtime-executable.ts",
    { attributes: { type: "file" } },
  ])
  expect(typeof id).toBe("string")
  expect(id).toStartWith("\0")
  expect(id).toEndWith(".js")
  expect(
    hook(plugin, "resolveId", [runtimeAsset.path, "/src/runtime-executable.ts", { attributes: {} }]),
  ).toBeUndefined()
  expect(
    hook(plugin, "resolveId", ["/cargo/other-file", "/src/runtime-executable.ts", { attributes: { type: "file" } }]),
  ).toBeUndefined()
  expect(hook(plugin, "load", ["/some/other/module.ts"])).toBeUndefined()
})

test("the staged asset module exports the extracted runtime path under the Node asset directory", async () => {
  const plugin = runtimePlugin(mainConfig({ ...input, runtimeAsset }))
  const id = hook(plugin, "resolveId", [runtimeAsset.path, undefined, { attributes: { type: "file" } }])
  const code = hook(plugin, "load", [id])
  if (typeof code !== "string") throw new Error("Runtime asset module did not produce JavaScript")
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-runtime-asset-"))
  const previous = process.env.YCODING_NODE_ASSETS_DIR
  process.env.YCODING_NODE_ASSETS_DIR = path.join(root, "assets")
  try {
    const file = path.join(root, "asset.mjs")
    await writeFile(file, code)
    expect((await import(file)).default).toBe(path.join(root, "assets", runtimeAssetKey))
  } finally {
    if (previous === undefined) delete process.env.YCODING_NODE_ASSETS_DIR
    else process.env.YCODING_NODE_ASSETS_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
