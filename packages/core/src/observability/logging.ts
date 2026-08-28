import { Effect, FileSystem, Formatter, Logger, type LogLevel } from "effect"
import path from "path"
import { Global } from "../global"
import { InstallationChannel, InstallationLocal } from "../installation/version"
import { runID } from "./shared"

function formatter(id: string = runID) {
  return Logger.map(Logger.formatStructured, (output) => {
    const messages = Array.isArray(output.message) ? output.message : [output.message]
    return [
      ["timestamp", output.timestamp],
      ["level", output.level],
      ["run", id],
      ...messages.flatMap((value) => (plain(value) ? flatten(value) : [["message", value] as const])),
      ...(output.cause === undefined ? [] : [["cause", output.cause] as const]),
      ...flatten(output.spans),
      ...flatten(output.annotations),
    ]
      .map(([key, value]) => `${key}=${format(value)}`)
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
    const path = prefix ? `${prefix}.${key}` : key
    return plain(value) ? flatten(value, path, seen) : [[path, value] as const]
  })
}

function plain(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function format(input: unknown) {
  const value = typeof input === "string" ? input : Formatter.format(input)
  return /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)
}

export function file(local = InstallationLocal, channel = InstallationChannel) {
  if (!local) return path.join(Global.Path.log, "ycoding.log")
  return path.join(Global.Path.log, `ycoding-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.log`)
}

export function fileLogger(target = file(), id: string = runID) {
  // Do not set batchWindow to 0; it causes high idle CPU usage.
  return Effect.gen(function* () {
    const logger = yield* Logger.toFile(formatter(id), target, { flag: "a", mode: 0o600 })
    if (process.platform === "win32") return logger
    const fs = yield* FileSystem.FileSystem
    yield* fs.chmod(target, 0o600)
    return logger
  })
}

const stderrLogger = Logger.make((options) => process.stderr.write(formatter().log(options) + "\n"))

export function minimumLogLevel() {
  const value = process.env.YCODING_LOG_LEVEL?.toUpperCase()
  const levels = {
    DEBUG: "Debug",
    INFO: "Info",
    WARN: "Warn",
    ERROR: "Error",
  } as const satisfies Record<string, LogLevel.LogLevel>
  return value && value in levels ? levels[value as keyof typeof levels] : levels.INFO
}

export function loggers() {
  return process.env.YCODING_PRINT_LOGS === "1" ? [fileLogger(), stderrLogger] : [fileLogger()]
}

export * as Logging from "./logging"
