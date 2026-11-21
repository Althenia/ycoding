export * as FrontendLog from "./log"

import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem, Formatter, Layer, Logger } from "effect"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { FrontendPaths } from "./paths"
import { InstallationChannel, InstallationLocal } from "./version"

const run = randomUUID().slice(0, 8)

export function layer() {
  return Logger.layer(process.env.YCODING_PRINT_LOGS === "1" ? [fileLogger(), stderrLogger()] : [fileLogger()], {
    mergeWithExisting: false,
  }).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)
}

export function file() {
  if (!InstallationLocal) return path.join(FrontendPaths.Path.log, "ycoding.log")
  return path.join(FrontendPaths.Path.log, `ycoding-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.log`)
}

function fileLogger() {
  return Effect.gen(function* () {
    const target = file()
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(target), { recursive: true, mode: 0o700 })
    const logger = yield* Logger.toFile(formatter(), target, { flag: "a", mode: 0o600 })
    if (process.platform !== "win32") yield* fs.chmod(target, 0o600)
    return logger
  })
}

function stderrLogger() {
  const format = formatter()
  return Logger.make((options) => process.stderr.write(format.log(options) + "\n"))
}

function formatter() {
  return Logger.map(Logger.formatStructured, (output) => {
    const messages = Array.isArray(output.message) ? output.message : [output.message]
    return [
      ["timestamp", output.timestamp],
      ["level", output.level],
      ["run", run],
      ...messages.flatMap((value) => (plain(value) ? flatten(value) : [["message", value] as const])),
      ...(output.cause === undefined ? [] : [["cause", output.cause] as const]),
      ...flatten(output.spans),
      ...flatten(output.annotations),
    ]
      .map(([key, value]) => `${key}=${text(value)}`)
      .join(" ")
  })
}

function flatten(
  input: Record<string, unknown>,
  prefix = "",
  seen = new WeakSet<object>(),
): Array<readonly [string, unknown]> {
  if (seen.has(input)) return [[prefix, "[Circular]"]]
  seen.add(input)
  const entries = Object.entries(input)
  if (entries.length === 0 && prefix) return [[prefix, input]]
  return entries.flatMap(([key, value]) => {
    const name = prefix ? `${prefix}.${key}` : key
    return plain(value) ? flatten(value, name, seen) : [[name, value] as const]
  })
}

function plain(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function text(input: unknown) {
  const value = typeof input === "string" ? input : Formatter.format(input)
  return /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)
}
