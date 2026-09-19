import { Global } from "@ycoding-ai/core/global"
import {
  InstallationChannel,
  InstallationLocal,
  InstallationVersion,
} from "@ycoding-ai/core/installation/version"
import { Context, Effect, FileSystem, Layer } from "effect"
import { parse, type ParseError } from "jsonc-parser"
import path from "node:path"
import semver from "semver"
import { installRelease, latestRelease, type Fetch } from "../update/update"

export type Policy = boolean | "notify"
export type Action = "none" | "upgrade"

export interface Interface {
  readonly check: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/cli/Updater") {}

export function decodePolicy(text: string): Policy | undefined {
  // The CLI only projects this host-level preference instead of initializing
  // the location-scoped server configuration graph.
  const errors: ParseError[] = []
  const input: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || typeof input !== "object" || input === null || !("autoupdate" in input)) return
  const value = input.autoupdate
  if (typeof value === "boolean" || value === "notify") return value
}

export function action(current: string, latest: string, policy: Policy): Action {
  if (policy === false) return "none"
  if (!semver.valid(current) || !semver.valid(latest) || semver.eq(latest, current)) return "none"
  // Major upgrades are never installed automatically.
  if (semver.major(latest) !== semver.major(current)) return "none"
  return "upgrade"
}

export type UpdateCheckSkipReason = "local-install" | "disabled" | "preview-build"

export function updateCheckSkipReason(input: {
  readonly local: boolean
  readonly disabled: boolean
  readonly version: string
}): UpdateCheckSkipReason | undefined {
  if (input.local) return "local-install"
  if (input.disabled) return "disabled"
  if (input.version.startsWith("0.0.0-")) return "preview-build"
}

export type Options = {
  readonly fetch?: Fetch
  readonly executable?: string
  readonly platform?: string
  readonly arch?: string
  readonly local?: boolean
  readonly version?: string
}

export const layerWith = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const global = yield* Global.Service
      const local = options.local ?? InstallationLocal
      const version = options.version ?? InstallationVersion
      const disabled = ["1", "true"].includes(process.env.YCODING_DISABLE_AUTOUPDATE?.toLowerCase() ?? "")
      const executable = options.executable ?? process.execPath
      const platform = options.platform ?? process.platform
      const arch = options.arch ?? process.arch

      const readPolicy = Effect.fnUntraced(function* () {
        const values = yield* Effect.forEach(["config.json", "ycoding.json", "ycoding.jsonc"], (name) =>
          fs
            .readFileString(path.join(global.config, name))
            .pipe(Effect.map(decodePolicy), Effect.catch(() => Effect.succeed(undefined))),
        )
        return values.findLast((value) => value !== undefined) ?? true
      })

      const latest = Effect.fnUntraced(function* () {
        return yield* Effect.tryPromise({
          try: () => latestRelease(options.fetch),
          catch: (cause) => new Error("Failed to check for updates", { cause }),
        })
      })

      const upgrade = Effect.fnUntraced(function* (version: string) {
        yield* Effect.tryPromise({
          try: () => installRelease({ version, executable, platform, arch, fetch: options.fetch }),
          catch: (cause) => new Error("Failed to install the update", { cause }),
        })
      })

      const check = Effect.fn("cli.updater.check")(function* () {
        const reason = updateCheckSkipReason({ local, disabled, version })
        if (reason)
          return yield* Effect.logInfo("update check skipped", {
            reason,
            version,
            channel: InstallationChannel,
          })
        const policy = yield* readPolicy()
        if (policy === false) return yield* Effect.logInfo("update check skipped", { reason: "policy-disabled" })

        return yield* Effect.gen(function* () {
          const latestVersion = yield* latest()
          yield* Effect.logInfo("update check", {
            current: version,
            latest: latestVersion,
          })
          const next = action(version, latestVersion, policy)
          if (next === "none") return yield* Effect.logInfo("update check done", { action: "up-to-date" })
          yield* upgrade(latestVersion)
          yield* Effect.logInfo("updated YCoding", { from: version, to: latestVersion })
        })
      }, Effect.catchCause((cause) => Effect.logWarning("automatic update failed", { cause })))

      return Service.of({ check })
    }),
  )

export const layer = layerWith()

export * as Updater from "./updater"
