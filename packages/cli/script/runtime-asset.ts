import type { Plugin } from "vite"

export const runtimeAssetKey = "runtime/ycoding-runtime"
export const pluginSDKAssetKey = "plugin/sdk.mjs"

export type RuntimeAsset = { readonly path: string; readonly sha256: string; readonly payloadSha256: string }

export function runtimeAssetConfig(runtimeAsset?: RuntimeAsset, relative = false) {
  return {
    define: {
      YCODING_RUNTIME_ASSET: runtimeAsset === undefined ? "undefined" : JSON.stringify(runtimeAsset.path),
      YCODING_RUNTIME_SHA256: runtimeAsset === undefined ? "undefined" : JSON.stringify(runtimeAsset.sha256),
      YCODING_RUNTIME_PAYLOAD_SHA256:
        runtimeAsset === undefined ? "undefined" : JSON.stringify(runtimeAsset.payloadSha256),
    },
    plugins:
      runtimeAsset === undefined
        ? []
        : [fileAssetPlugin(runtimeAsset.path, runtimeAssetKey, "ycoding:runtime-asset", relative)],
  }
}

export function pluginSDKAssetConfig(asset?: { readonly path: string; readonly digest: string }, relative = false) {
  return {
    define: {
      YCODING_PLUGIN_SDK_ASSET: asset === undefined ? "undefined" : JSON.stringify(asset.path),
      YCODING_PLUGIN_SDK_SHA256: asset === undefined ? "undefined" : JSON.stringify(asset.digest),
    },
    plugins:
      asset === undefined ? [] : [fileAssetPlugin(asset.path, pluginSDKAssetKey, "ycoding:plugin-sdk-asset", relative)],
  }
}

function fileAssetPlugin(asset: string, key: string, name: string, relative: boolean): Plugin {
  const virtual = `\0${name.replace(":", "-")}.js`
  return {
    name,
    enforce: "pre",
    resolveId(source, _importer, options) {
      return options.attributes?.type === "file" && source === asset ? virtual : undefined
    },
    load(id) {
      if (id !== virtual) return undefined
      if (relative)
        return `import { fileURLToPath } from "node:url"\nexport default fileURLToPath(new URL(${JSON.stringify("./assets/" + key)}, import.meta.url))`
      return `import path from "node:path"\nexport default path.join(process.env.YCODING_NODE_ASSETS_DIR, ${JSON.stringify(key)})`
    },
  }
}
