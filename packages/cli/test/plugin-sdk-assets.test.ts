import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { mergeConfig } from "vite"
import { PluginSDKAsset } from "../script/plugin-sdk"
import { pluginSDKAssetConfig, pluginSDKAssetKey, runtimeAssetConfig } from "../script/runtime-asset"

const root = path.resolve(import.meta.dirname, "../../..")

test("builds one audited portable SDK module with all public runtime exports", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-sdk-asset-test-"))
  try {
    await writeFile(path.join(directory, "keep.txt"), "retained")
    const asset = await PluginSDKAsset.build(root, directory)
    expect(Object.keys(asset).sort()).toEqual(["digest", "path"])
    expect(path.relative(directory, asset.path)).not.toStartWith("..")
    expect(path.extname(asset.path)).toBe(".mjs")
    const bytes = await readFile(asset.path)
    expect(asset.digest).toBe(createHash("sha256").update(bytes).digest("hex"))
    expect(await readdir(path.dirname(asset.path))).toEqual([path.basename(asset.path)])
    expect(await readFile(path.join(directory, "keep.txt"), "utf8")).toBe("retained")
    const sdk = await import(pathToFileURL(asset.path).href)
    expect(Object.keys(sdk).sort()).toEqual(["effect", "promise", "runtime", "tool"])
    const originals = await Promise.all([
      import("@ycoding-ai/plugin"),
      import("@ycoding-ai/plugin/effect"),
      import("@ycoding-ai/plugin/tool"),
      import("effect"),
    ])
    for (const [index, name] of ["promise", "effect", "tool", "runtime"].entries())
      expect(Object.keys(sdk[name]).sort()).toEqual(Object.keys(originals[index]).sort())
    const promise = { id: "authored.promise", setup: async () => {} }
    expect(sdk.promise.Plugin.define(promise)).toBe(promise)
    const effect = { id: "authored.effect", effect: () => sdk.runtime.Effect.void }
    expect(sdk.effect.Plugin.define(effect)).toBe(effect)
    const typed = sdk.tool.Tool.make({
      description: "Synthetic typed tool",
      input: sdk.runtime.Schema.Struct({ count: sdk.runtime.Schema.Number }),
      output: sdk.runtime.Schema.Number,
      execute: ({ count }: { count: number }) => sdk.runtime.Effect.succeed(count + 1),
    })
    expect(typeof typed).toBe("object")
    const second = await PluginSDKAsset.build(root, directory)
    expect(second.path).not.toBe(asset.path)
    expect(second.digest).toBe(asset.digest)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

async function fixture(entry: string, files: Record<string, string> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-sdk-source-test-"))
  const workspace = path.join(directory, "workspace")
  for (const [name, source] of Object.entries({
    "package.json": JSON.stringify({ type: "module" }),
    "packages/cli/script/plugin-sdk-entry.ts": entry,
    ...files,
  })) {
    await mkdir(path.dirname(path.join(workspace, name)), { recursive: true })
    await writeFile(path.join(workspace, name), source)
  }
  return { directory, workspace, output: path.join(directory, "output") }
}

for (const owner of ["ai", "core", "server"]) {
  test(`rejects ${owner} runtime modules before publishing an SDK payload`, async () => {
    const input = await fixture(
      `export { value as promise, value as effect, value as tool, value as runtime } from "../../${owner}/src/index.ts"`,
      { [`packages/${owner}/src/index.ts`]: "export const value = { forbidden: true }" },
    )
    try {
      await expect(PluginSDKAsset.build(input.workspace, input.output)).rejects.toThrow(`@ycoding-ai/${owner}`)
      expect(await readdir(input.output)).toEqual([])
    } finally {
      await rm(input.directory, { recursive: true, force: true })
    }
  })
}

test("rejects unresolved package imports instead of publishing an external dependency", async () => {
  const input = await fixture('export { value as promise } from "ycoding-unresolved-sdk-fixture"')
  try {
    await expect(PluginSDKAsset.build(input.workspace, input.output)).rejects.toThrow()
    expect(await readdir(input.output)).toEqual([])
  } finally {
    await rm(input.directory, { recursive: true, force: true })
  }
})

test("permits Node builtins but rejects non-Node runtime externals", async () => {
  const allowed = await fixture(
    'import path from "node:path"; export const promise = path.sep; export const effect = {}; export const tool = {}; export const runtime = {}',
  )
  const rejected = await fixture('export { file as promise } from "bun"')
  try {
    const asset = await PluginSDKAsset.build(allowed.workspace, allowed.output)
    expect((await import(pathToFileURL(asset.path).href)).promise).toBe(path.sep)
    await expect(PluginSDKAsset.build(rejected.workspace, rejected.output)).rejects.toThrow("bun")
    expect(await readdir(rejected.output)).toEqual([])
  } finally {
    await Promise.all([
      rm(allowed.directory, { recursive: true, force: true }),
      rm(rejected.directory, { recursive: true, force: true }),
    ])
  }
})

test("keeps the SDK build out of the parent Bun.build capture", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-sdk-subprocess-test-"))
  try {
    const file = path.join(directory, "parent.ts")
    await writeFile(
      file,
      `import { PluginSDKAsset } from ${JSON.stringify(path.join(root, "packages/cli/script/plugin-sdk.ts"))}
      Bun.build = async () => { throw new Error("Parent build capture must not build the SDK") }
      const asset = await PluginSDKAsset.build(${JSON.stringify(root)}, ${JSON.stringify(directory)})
      console.log(JSON.stringify(asset))`,
    )
    const child = Bun.spawn([process.execPath, file], { stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout).digest).toMatch(/^[a-f0-9]{64}$/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

const sdkAsset = { path: "/synthetic/plugin-sdk.mjs", digest: "ab".repeat(32) }
const runtimeAsset = {
  path: "/synthetic/ycoding-runtime",
  sha256: "cd".repeat(32),
  payloadSha256: "ef".repeat(32),
}

function hook(plugin: unknown, name: "resolveId" | "load", args: unknown[]) {
  const value = Reflect.get(Object(plugin), name)
  return Reflect.apply(typeof value === "function" ? value : value.handler, {}, args)
}

test("maps only the exact SDK raw file to its Node asset key without replacing runtime defines", () => {
  expect(pluginSDKAssetKey).toBe("plugin/sdk.mjs")
  const config = mergeConfig(runtimeAssetConfig(runtimeAsset), pluginSDKAssetConfig(sdkAsset))
  expect(config.define).toMatchObject({
    YCODING_RUNTIME_ASSET: JSON.stringify(runtimeAsset.path),
    YCODING_RUNTIME_SHA256: JSON.stringify(runtimeAsset.sha256),
    YCODING_RUNTIME_PAYLOAD_SHA256: JSON.stringify(runtimeAsset.payloadSha256),
    YCODING_PLUGIN_SDK_ASSET: JSON.stringify(sdkAsset.path),
    YCODING_PLUGIN_SDK_SHA256: JSON.stringify(sdkAsset.digest),
  })
  const plugin = config.plugins?.find(
    (plugin: unknown) => Reflect.get(Object(plugin), "name") === "ycoding:plugin-sdk-asset",
  )
  expect(plugin).toBeDefined()
  const id = hook(plugin, "resolveId", [sdkAsset.path, "/loader.ts", { attributes: { type: "file" } }])
  expect(typeof id).toBe("string")
  expect(hook(plugin, "resolveId", [sdkAsset.path, "/loader.ts", { attributes: {} }])).toBeUndefined()
  expect(hook(plugin, "resolveId", ["/other.mjs", "/loader.ts", { attributes: { type: "file" } }])).toBeUndefined()
  expect(hook(plugin, "load", [id])).toContain("YCODING_NODE_ASSETS_DIR")
  expect(hook(plugin, "load", [id])).toContain(JSON.stringify(pluginSDKAssetKey))
  expect(hook(plugin, "load", ["/other.mjs"])).toBeUndefined()
  expect(pluginSDKAssetConfig().define).toEqual({
    YCODING_PLUGIN_SDK_ASSET: "undefined",
    YCODING_PLUGIN_SDK_SHA256: "undefined",
  })
  expect(pluginSDKAssetConfig().plugins).toEqual([])
})

async function captureBuild(kind: "bun" | "node") {
  if (kind === "node") return captureNodeBuild()
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-sdk-build-options-test-"))
  try {
    const preload = path.join(directory, "capture.ts")
    const sdk = { ...sdkAsset, path: path.join(directory, "sdk", "plugin-sdk.mjs") }
    await writeFile(
      preload,
      `import { mock } from "bun:test"
      const sdkCalls = []
      mock.module(${JSON.stringify(path.join(root, "packages/cli/script/plugin-sdk.ts"))}, () => ({
        PluginSDKAsset: { build: async (...args) => { sdkCalls.push(args); return ${JSON.stringify(sdk)} } }
      }))
      mock.module(${JSON.stringify(path.join(root, "packages/cli/script/runtime.ts"))}, () => ({
        buildRuntime: async () => ({ ...${JSON.stringify(runtimeAsset)}, dispose: async () => {} })
      }))
      const print = (value) => { console.log("CAPTURE=" + JSON.stringify({ ...value, sdkCalls, sdkAsset: ${JSON.stringify(sdk)} })); process.exit(0) }
      Bun.build = async (options) => print({ define: options.define })`,
    )
    const script = path.join(root, "packages/cli/script/build.ts")
    const child = Bun.spawn(
      [process.execPath, "--preload", preload, script, "--single", `--outdir=${path.join(directory, "output")}`],
      {
        cwd: path.join(root, "packages/cli"),
        env: { ...process.env, YCODING_CHANNEL: "test", YCODING_VERSION: "0.0.0-test-1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    const captured = stdout.split("\n").find((line) => line.startsWith("CAPTURE="))
    expect(captured, stdout).toBeDefined()
    return JSON.parse(captured!.slice("CAPTURE=".length))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function captureNodeBuild() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "ycoding-sdk-node-options-test-")))
  try {
    const scripts = path.join(directory, "packages/cli/script")
    await mkdir(scripts, { recursive: true })
    const sdk = { ...sdkAsset, path: path.join(directory, "sdk", "plugin-sdk.mjs") }
    const substitutions: Record<string, string> = {
      vite: path.join(scripts, "fixture-vite.ts"),
      "./plugin-sdk": path.join(scripts, "fixture-sdk.ts"),
      "./runtime": path.join(scripts, "fixture-runtime.ts"),
      "./node-assets": path.join(scripts, "fixture-assets.ts"),
    }
    const original = path.join(root, "packages/cli/script/build-node.ts")
    const source = (await readFile(original, "utf8")).replace(/from "([^"\n]+)"/g, (_match, specifier: string) => {
      const replacement =
        substitutions[specifier] ??
        (specifier.startsWith(".")
          ? path.resolve(path.dirname(original), specifier)
          : Bun.resolveSync(specifier, path.dirname(original)))
      return `from ${JSON.stringify(replacement)}`
    }).replace('import("./plugin-sdk")', `import(${JSON.stringify(substitutions["./plugin-sdk"])})`)
    await writeFile(path.join(scripts, "build-node.ts"), source)
    await writeFile(
      substitutions.vite,
      `
      export { mergeConfig } from ${JSON.stringify(Bun.resolveSync("vite", path.join(root, "packages/cli")))}
      let config
      export const current = () => config
      export const build = async (value) => { config = value }
    `,
    )
    await writeFile(
      substitutions["./plugin-sdk"],
      `
      export const calls = []
      export const PluginSDKAsset = { build: async (...args) => { calls.push(args); return ${JSON.stringify(sdk)} } }
    `,
    )
    await writeFile(
      substitutions["./runtime"],
      `
      export const buildRuntime = async () => ({ ...${JSON.stringify(runtimeAsset)}, dispose: async () => {} })
    `,
    )
    await writeFile(
      substitutions["./node-assets"],
      `
      import { current } from "./fixture-vite.ts"
      import { calls } from "./fixture-sdk.ts"
      let hashed
      export const collectNodeAssets = async () => []
      export const hashNodeAssets = async (assets) => { hashed = assets; return "authored-hash" }
      export const copyNodeAssets = async (assets) => { console.log("CAPTURE=" + JSON.stringify({
        assets, hashed, define: current().define, sdkCalls: calls, sdkAsset: ${JSON.stringify(sdk)}
      })); process.exit(0) }
      export const seaAssetMap = async () => ({})
    `,
    )
    const preload = path.join(directory, "preload.ts")
    await writeFile(preload, `
      import { mock } from "bun:test"
      import * as child from "node:child_process"
      mock.module("node:child_process", () => ({ ...child, spawnSync: () => ({ status: 0, stdout: JSON.stringify({ version: "26.4.0", path: process.execPath }) }) }))
      globalThis.fetch = async () => { throw new Error("Unexpected network request") }
    `)
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        path.join(scripts, "build-node.ts"),
        "--bundle-only",
        "--skip-install",
        `--outdir=${path.join(directory, "output")}`,
      ],
      {
        cwd: directory,
        env: { ...process.env, YCODING_CHANNEL: "test", YCODING_VERSION: "0.0.0-test-1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    const captured = stdout.split("\n").find((line) => line.startsWith("CAPTURE="))
    expect(captured, stdout).toBeDefined()
    return { ...JSON.parse(captured!.slice("CAPTURE=".length)), root: directory }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("native compilation embeds the SDK file and digest without embedding source in a define", async () => {
  const result = await captureBuild("bun")
  expect(result.define).toMatchObject({
    YCODING_PLUGIN_SDK_ASSET: JSON.stringify(result.sdkAsset.path),
    YCODING_PLUGIN_SDK_SHA256: JSON.stringify(sdkAsset.digest),
  })
  expect(result.sdkCalls).toHaveLength(1)
  expect(result.sdkCalls[0][0]).toBe(root)
  expect(Object.keys(result.define)).not.toContain("YCODING_PLUGIN_SDK_SOURCE")
}, 60_000)

test("Node compilation stages the same SDK file and keeps the runtime asset selectors", async () => {
  const result = await captureBuild("node")
  expect(result.assets).toContainEqual({ key: pluginSDKAssetKey, source: result.sdkAsset.path })
  expect(result.assets).toContainEqual({ key: "runtime/ycoding-runtime", source: runtimeAsset.path })
  expect(result.hashed).toEqual(result.assets)
  expect(result.define).toMatchObject({
    YCODING_PLUGIN_SDK_ASSET: JSON.stringify(result.sdkAsset.path),
    YCODING_PLUGIN_SDK_SHA256: JSON.stringify(sdkAsset.digest),
    YCODING_RUNTIME_ASSET: JSON.stringify(runtimeAsset.path),
    YCODING_RUNTIME_SHA256: JSON.stringify(runtimeAsset.sha256),
    YCODING_RUNTIME_PAYLOAD_SHA256: JSON.stringify(runtimeAsset.payloadSha256),
  })
  expect(result.sdkCalls).toHaveLength(1)
  expect(result.sdkCalls[0][0]).toBe(result.root)
}, 60_000)
