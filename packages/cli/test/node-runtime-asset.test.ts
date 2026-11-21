import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runtimeAssetConfig, runtimeAssetKey, type RuntimeAsset } from "../script/runtime-asset"
import { nodeTarget } from "../src/node/target"

const runtimeAsset: RuntimeAsset = {
  path: "/cargo/target/release/ycoding-runtime",
  sha256: "ab".repeat(32),
  payloadSha256: "cd".repeat(32),
}

function runtimePlugin(config: ReturnType<typeof runtimeAssetConfig>) {
  return config.plugins.find((plugin) => plugin.name === "ycoding:runtime-asset")
}

test("Node target descriptions include both supported macOS architectures", () => {
  expect(nodeTarget("darwin", "x64")).toMatchObject({ platform: "darwin", arch: "x64" })
  expect(nodeTarget("darwin", "arm64")).toMatchObject({ platform: "darwin", arch: "arm64" })
  expect(nodeTarget("linux", "x64")).toMatchObject({ platform: "linux", arch: "x64" })
  expect(nodeTarget("win32", "x64")).toMatchObject({ platform: "win32", arch: "x64" })
})

test("runtime asset configuration has no runtime Vite or Solid imports", async () => {
  const result = await Bun.build({
    entrypoints: [path.resolve(import.meta.dir, "../script/runtime-asset.ts")],
    target: "bun",
    plugins: [
      {
        name: "reject-runtime-build-engine",
        setup(build) {
          build.onResolve({ filter: /^(vite|vite-plugin-solid)$/ }, () => {
            throw new Error("Runtime asset configuration must not load the build engine")
          })
        },
      },
    ],
  })
  expect(result.success, result.logs.map(String).join("\n")).toBe(true)
  expect(result.outputs).toHaveLength(1)
})

function hook(plugin: unknown, name: "resolveId" | "load", args: unknown[]) {
  const value = Reflect.get(Object(plugin), name)
  return Reflect.apply(typeof value === "function" ? value : value.handler, {}, args)
}

test("the Node build defines the runtime asset path and both digests without the payload", () => {
  const define = runtimeAssetConfig(runtimeAsset).define
  expect(define?.YCODING_RUNTIME_ASSET).toBe(JSON.stringify(runtimeAsset.path))
  expect(define?.YCODING_RUNTIME_SHA256).toBe(JSON.stringify(runtimeAsset.sha256))
  expect(define?.YCODING_RUNTIME_PAYLOAD_SHA256).toBe(JSON.stringify(runtimeAsset.payloadSha256))
  expect(define).not.toHaveProperty("YCODING_RUNTIME_PAYLOAD")
})

test("a Node bundle without a runtime leaves the asset defines undefined and registers no plugin", () => {
  const config = runtimeAssetConfig()
  expect(config.define?.YCODING_RUNTIME_ASSET).toBe("undefined")
  expect(config.define?.YCODING_RUNTIME_SHA256).toBe("undefined")
  expect(config.define?.YCODING_RUNTIME_PAYLOAD_SHA256).toBe("undefined")
  expect(runtimePlugin(config)).toBeUndefined()
})

test("only the runtime file import resolves to the staged asset module", () => {
  const plugin = runtimePlugin(runtimeAssetConfig(runtimeAsset))
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
  const plugin = runtimePlugin(runtimeAssetConfig(runtimeAsset))
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
