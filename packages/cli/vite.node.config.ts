import path from "node:path"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { defineConfig, type Plugin, type UserConfig } from "vite"
import solid from "vite-plugin-solid"
import { nodeExecArgv, nodeTarget, type NodeTarget, photonWasmAsset } from "./src/node/target"
import { NODE_BINARY } from "./src/binary"

const dir = import.meta.dirname

const rawTextPrefix = "\0ycoding-raw-text:"

function rawTextPlugin(): Plugin {
  return {
    name: "ycoding:raw-text",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (options.attributes?.type !== "text") return
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      // A virtual id ending in .js keeps Vite's HTML and CSS plugins from processing the imported file.
      return resolved ? `${rawTextPrefix}${resolved.id}.js` : undefined
    },
    async load(id) {
      if (id.startsWith(rawTextPrefix))
        return `export default ${JSON.stringify(await readFile(id.slice(rawTextPrefix.length, -".js".length), "utf8"))}`
      if (!id.endsWith(".md")) return
      return `export default ${JSON.stringify(await readFile(id, "utf8"))}`
    },
  }
}

function runtimeRequirePlugin(): Plugin {
  return {
    name: "ycoding:runtime-require",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("turndown/lib/turndown.es.js")) return
      const transformed = code.replace("    var domino = require('@mixmark-io/domino');", "")
      if (transformed === code) this.error("Failed to rewrite Turndown's Domino require")
      return `import domino from "@mixmark-io/domino"\n${transformed}`
    },
  }
}

const resolve = {
  alias: [
    { find: /^solid-js\/store$/, replacement: "solid-js/store/dist/store.js" },
    { find: /^solid-js$/, replacement: "solid-js/dist/solid.js" },
    {
      find: /^ws$/,
      replacement: path.join(path.dirname(createRequire(import.meta.url).resolve("ws/package.json")), "wrapper.mjs"),
    },
  ],
  conditions: ["node"],
}

const output = (entryFileNames: string, banner?: string) => ({
  format: "esm" as const,
  entryFileNames,
  inlineDynamicImports: true,
  banner,
})

function nodePrelude(input: NodeBuildInput) {
  const nodePtySpawnHelper =
    input.target.platform === "darwin"
      ? `${input.target.nodePtyPackage}/prebuilds/darwin-${input.target.arch}/spawn-helper`
      : undefined
  return `#!/usr/bin/env -S node ${nodeExecArgv.join(" ")}
import __cjs_mod__ from "node:module"
import { chmodSync as __ocChmod, existsSync as __ocExists, lstatSync as __ocLstat, mkdirSync as __ocMkdir, renameSync as __ocRename, rmSync as __ocRm, writeFileSync as __ocWrite } from "node:fs"
import { tmpdir as __ocTmpdir } from "node:os"
import __ocPath from "node:path"
import { getAssetKeys as __ocAssetKeys, getRawAsset as __ocRawAsset, isSea as __ocIsSea } from "node:sea"
import { fileURLToPath as __ocFileURLToPath } from "node:url"
const __filename = import.meta.filename
const __dirname = import.meta.dirname
const require = __cjs_mod__.createRequire(import.meta.url)
const __ocUid = typeof process.getuid === "function" ? process.getuid() : undefined
const __ocCacheRoot = __ocPath.join(__ocTmpdir(), \`ycoding-node-\${__ocUid ?? "user"}\`)
if (__ocIsSea()) {
  try {
    __ocMkdir(__ocCacheRoot, { mode: 0o700 })
  } catch (__ocError) {
    if (!__ocExists(__ocCacheRoot)) throw __ocError
  }
  const __ocCacheInfo = __ocLstat(__ocCacheRoot)
  if (!__ocCacheInfo.isDirectory() || __ocCacheInfo.isSymbolicLink()) throw new Error("Unsafe Node asset cache path")
  if (__ocUid !== undefined && __ocCacheInfo.uid !== __ocUid) throw new Error("Node asset cache is owned by another user")
  if (__ocUid !== undefined) __ocChmod(__ocCacheRoot, 0o700)
}
const __ocAssetRoot = __ocIsSea()
  ? __ocPath.join(__ocCacheRoot, ${JSON.stringify(`${input.assetHash}-${input.target.platform}-${input.target.arch}`)})
  : __ocFileURLToPath(new URL("./assets/", import.meta.url))
if (__ocIsSea()) {
  for (const __ocKey of __ocAssetKeys()) {
    const __ocTarget = __ocPath.join(__ocAssetRoot, __ocKey)
    if (__ocExists(__ocTarget)) continue
    __ocMkdir(__ocPath.dirname(__ocTarget), { recursive: true })
    const __ocTemporary = \`${"${__ocTarget}"}.${"${process.pid}"}.${"${crypto.randomUUID()}"}.tmp\`
    __ocWrite(__ocTemporary, new Uint8Array(__ocRawAsset(__ocKey)))
    try {
      __ocRename(__ocTemporary, __ocTarget)
    } catch (__ocError) {
      __ocRm(__ocTemporary, { force: true })
      if (!__ocExists(__ocTarget)) throw __ocError
    }
  }
  const __ocPtySpawnHelper = ${JSON.stringify(nodePtySpawnHelper)}
  if (__ocPtySpawnHelper) __ocChmod(__ocPath.join(__ocAssetRoot, __ocPtySpawnHelper), 0o755)
}
process.env.YCODING_NODE_ASSETS_DIR = __ocAssetRoot
process.env.OTUI_ASSET_ROOT = __ocAssetRoot
process.env.YCODING_NODE_PTY_PATH = __ocPath.join(__ocAssetRoot, ${JSON.stringify(input.target.nodePtyEntryAsset)})
process.env.YCODING_PARCEL_WATCHER_PATH = __ocPath.join(__ocAssetRoot, ${JSON.stringify(input.target.parcelWatcherAsset)})
process.env.YCODING_PHOTON_WASM_PATH = __ocPath.join(__ocAssetRoot, ${JSON.stringify(photonWasmAsset)})
globalThis.__YCODING_PHOTON_WASM_PATH = process.env.YCODING_PHOTON_WASM_PATH
if (process.platform === "linux") process.env.OPENTUI_LIBC = "glibc"`
}

export type NodeBuildInput = {
  readonly version: string
  readonly channel: string
  readonly models: string
  readonly assetHash: string
  readonly target: NodeTarget
  readonly runtimePayload?: string
}

export function mainConfig(input: NodeBuildInput): UserConfig {
  return defineConfig({
    root: dir,
    plugins: [
      rawTextPlugin(),
      runtimeRequirePlugin(),
      solid({
        solid: {
          generate: "universal",
          moduleName: "@opentui/solid",
        },
      }),
    ],
    resolve,
    esbuild: { jsx: "automatic" },
    define: {
      YCODING_RUNTIME_PAYLOAD: input.runtimePayload === undefined ? "undefined" : JSON.stringify(input.runtimePayload),
      YCODING_VERSION: JSON.stringify(input.version),
      YCODING_CLI_NAME: JSON.stringify(NODE_BINARY),
      YCODING_MODELS_DEV: input.models,
      YCODING_CHANNEL: JSON.stringify(input.channel),
      YCODING_LIBC: input.target.platform === "linux" ? JSON.stringify("glibc") : "undefined",
      FFF_LIBC: input.target.platform === "linux" ? JSON.stringify("gnu") : "undefined",
    },
    ssr: { noExternal: true },
    build: {
      ssr: "src/node/index.ts",
      target: "node26",
      outDir: "dist-node",
      emptyOutDir: false,
      minify: true,
      rollupOptions: {
        external: [/^@ycoding-ai\/simulation(?:\/|$)/],
        output: output("ycoding.mjs", nodePrelude(input)),
      },
    },
  })
}

export default mainConfig({
  version: process.env.YCODING_VERSION ?? "local",
  channel: process.env.YCODING_CHANNEL ?? "local",
  models: "undefined",
  assetHash: "local",
  target: nodeTarget(process.platform, process.arch),
})
