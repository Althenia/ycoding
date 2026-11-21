import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Effect, References, Runtime } from "effect"
import { InstallationChannel, InstallationVersion, InstallationLocal } from "./version"
import { FrontendLog } from "./log"
import { FrontendPaths } from "./paths"
import type { run } from "./framework/runtime"
import { Updater } from "./services/updater"
import { Config } from "./config"

type Program = ReturnType<typeof run>

export function main(program: Program) {
  Effect.logInfo("cli starting", {
    version: InstallationVersion,
    channel: InstallationChannel,
    local: InstallationLocal,
    args: process.argv.slice(2),
  }).pipe(
    Effect.flatMap(() => program),
    Effect.annotateLogs({ role: "cli" }),
    Effect.provide(Config.layer),
    Effect.provide(Updater.layer),
    Effect.provide(FrontendPaths.layer),
    Effect.provide(FrontendLog.layer()),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
    Effect.tap(() =>
      Effect.promise(() =>
        Promise.all(
          [process.stdout, process.stderr].map(
            (stream) => new Promise<void>((resolve) => stream.end(() => resolve())),
          ),
        ),
      ),
    ),
    Effect.tap(() => Effect.sync(() => process.exit(process.exitCode ?? 0))),
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause) || !Runtime.getErrorReported(Cause.squash(cause))
        ? Effect.void
        : Effect.logError(cause).pipe(Effect.provideService(References.LogToStderr, true)),
    ),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  )
}
