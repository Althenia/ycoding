import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { Runtime } from "./framework/runtime"
import { Updater } from "./services/updater"
import { Config } from "./config"
import { FrontendPaths } from "./paths"

type Program = ReturnType<typeof Runtime.run>

export function main(program: Program) {
  program.pipe(
    Effect.annotateLogs({ role: "cli" }),
    Effect.provide(Config.layer),
    Effect.provide(Updater.layer),
    Effect.provide(FrontendPaths.layer),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
    Effect.tap(() => Effect.sync(() => process.exit(process.exitCode ?? 0))),
    NodeRuntime.runMain,
  )
}
