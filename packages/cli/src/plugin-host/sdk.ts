export * as PluginSDK from "./sdk"

import { createRequire } from "node:module"

const modules: typeof import("node:module") = createRequire(import.meta.url)("node:module")

export type Namespace = {
  readonly promise: Record<string, unknown>
  readonly effect: Record<string, unknown> & { readonly Plugin: Record<string, unknown> }
  readonly tool: Record<string, unknown>
  readonly runtime: typeof import("effect")
}

export let runtime: Namespace["runtime"]
let registered = false

export function initialize(value: Namespace["runtime"]) {
  runtime ??= value
}

export function register(namespace: Namespace, url: string) {
  if (registered) return
  const entries: Record<string, [Record<string, unknown>, string]> = {
    "@ycoding-ai/plugin": [namespace.promise, "promise"],
    "@ycoding-ai/plugin/effect": [namespace.effect, "effect"],
    "@ycoding-ai/plugin/effect/index": [namespace.effect, "effect"],
    "@ycoding-ai/plugin/effect/plugin": [namespace.effect.Plugin, "effect.Plugin"],
    "@ycoding-ai/plugin/tool": [namespace.tool, "tool"],
    "@ycoding-ai/plugin/effect/tool": [namespace.tool, "tool"],
    effect: [namespace.runtime, "runtime"],
  }
  if (typeof Bun !== "undefined" && typeof Bun.plugin === "function") {
    Bun.plugin({
      name: "ycoding-plugin-sdk",
      setup(builder) {
        for (const [name, [exports]] of Object.entries(entries))
          builder.module(name, () => ({ loader: "object", exports }))
      },
    })
    runtime = namespace.runtime
    registered = true
    return
  }
  if (typeof modules.registerHooks !== "function") throw new Error("Plugin host requires Node module hook support")
  modules.registerHooks({
    resolve(specifier, context, next) {
      if (Object.hasOwn(entries, specifier)) return { url: `ycoding-plugin-sdk:${specifier}`, shortCircuit: true }
      return next(specifier, context)
    },
    load(specifier, context, next) {
      if (!specifier.startsWith("ycoding-plugin-sdk:")) return next(specifier, context)
      const [exports, source] = entries[specifier.slice("ycoding-plugin-sdk:".length)]
      return {
        format: "module",
        shortCircuit: true,
        source: [
          `import { ${source.split(".")[0]} } from ${JSON.stringify(url)};`,
          ...Object.keys(exports).map((name) =>
            name === "default"
              ? `export default ${source}.default;`
              : `export const ${name} = ${source}[${JSON.stringify(name)}];`,
          ),
        ].join("\n"),
      }
    },
  })
  runtime = namespace.runtime
  registered = true
}
