export * as PluginOperations from "./operations"

import { Effect, Option } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import type { Config } from "../config"
import { ConfigCapabilities } from "../config/capabilities"
import type { ConfigPlugin } from "../config/plugin"
import { FSUtil } from "../fs-util"
import { Location } from "../location"

export type Operation =
  | {
      readonly type: "add"
      readonly target: string
      readonly options: Record<string, unknown>
      readonly mtime?: number
    }
  | {
      readonly type: "remove"
      readonly target: string
    }

function parse(input: ConfigPlugin.Plugin): Operation {
  if (typeof input !== "string") {
    return { type: "add", target: input.package, options: input.options ?? {} }
  }
  if (!input.startsWith("-")) return { type: "add", target: input, options: {} }
  if (input.length === 1) throw new Error("Plugin remove operation requires a target")
  return { type: "remove", target: input.slice(1) }
}

export const scan = Effect.fn("PluginOperations.scan")(function* (entries: readonly Config.Entry[]) {
  const fs = yield* FSUtil.Service
  const location = yield* Location.Service
  const discovered = yield* Effect.forEach(
    entries.filter((entry): entry is Config.Directory => entry.type === "directory"),
    (entry) => discoverDirectory(fs, entry.path),
  ).pipe(Effect.map((items) => items.flat()))
  const configured = entries
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) =>
      (entry.info.plugins ?? []).map(parse).map((operation) => {
        if (operation.type === "remove") return operation
        const directory = entry.path ? path.dirname(entry.path) : location.directory
        const target = operation.target.startsWith("file://")
          ? fileURLToPath(operation.target)
          : operation.target.startsWith("./") || operation.target.startsWith("../")
            ? path.resolve(directory, operation.target)
            : operation.target
        return { ...operation, target }
      }),
    )
  // Explicit config is applied last so it can remove auto-discovered packages.
  return yield* Effect.forEach([...discovered, ...configured], (operation) => {
    if (operation.type === "remove" || !path.isAbsolute(operation.target)) return Effect.succeed(operation)
    return fs.stat(operation.target).pipe(
      Effect.map((info) => ({
        ...operation,
        mtime: Option.getOrElse(info.mtime, () => new Date(0)).getTime(),
      })),
      Effect.catch(() => Effect.succeed(operation)),
    )
  })
})

export const resolve = Effect.fn("PluginOperations.resolve")(function* <P extends { readonly id: string }, E = never, R = never>(
  pre: readonly P[],
  post: readonly P[],
  operations: readonly Operation[],
  capabilities: ConfigCapabilities.Resolved,
  load?: (operation: Extract<Operation, { type: "add" }>) => Effect.Effect<P | undefined, E, R>,
) {
  const matches = (selector: string, target: string) =>
    selector === "*" || (selector.endsWith(".*") ? target.startsWith(selector.slice(0, -1)) : selector === target)
  const definitions = [...pre, ...post]
  const enabled = new Set(definitions.map((plugin) => plugin.id))
  const packages = new Map<string, P>()
  const plugins = () => [...definitions, ...packages.values()]

  const seen = new Set<string>()
  for (const operation of operations) {
    const signature = JSON.stringify(operation)
    if (seen.has(signature)) continue
    seen.add(signature)
    if (operation.type === "remove") {
      plugins()
        .filter((plugin) => matches(operation.target, plugin.id))
        .forEach((plugin) => enabled.delete(plugin.id))
      continue
    }

    const matched = plugins().filter((plugin) => matches(operation.target, plugin.id))
    const selectsPlugins =
      matched.length > 0 ||
      operation.target === "*" ||
      operation.target.endsWith(".*") ||
      operation.target.startsWith("ycoding.")
    if (selectsPlugins) {
      matched.forEach((plugin) => enabled.add(plugin.id))
      continue
    }

    if (!load || capabilities.plugins?.enabled === false) continue
    const plugin = yield* load(operation).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to load plugin", {
          target: operation.target,
          cause,
        }).pipe(Effect.as(undefined)),
      ),
    )
    if (!plugin) continue
    if (!ConfigCapabilities.allows(capabilities.plugins, plugin.id)) continue
    const previous = packages.get(operation.target)
    if (previous) enabled.delete(previous.id)
    packages.set(operation.target, plugin)
    enabled.add(plugin.id)
  }

  return [
    ...pre.filter((plugin) => enabled.has(plugin.id)),
    ...Array.from(packages.values()).filter((plugin) => enabled.has(plugin.id)),
    ...post.filter((plugin) => enabled.has(plugin.id)),
  ]
})

function discoverDirectory(fs: FSUtil.Interface, directory: string) {
  return Effect.gen(function* () {
    const files = yield* fs
      .scan("{plugin,plugins}/*.{ts,js}", {
        cwd: directory,
        absolute: true,
        include: "file",
        dot: true,
        symlink: true,
      })
      .pipe(Effect.orElseSucceed(() => []))
    return files.sort().map((target): Operation => ({ type: "add", target, options: {} }))
  })
}
