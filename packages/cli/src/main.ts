import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Global } from "@ycoding-ai/core/global"
import { AppProcess } from "@ycoding-ai/core/process"
import { Npm } from "@ycoding-ai/core/npm"
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
    Effect.provide(
      LayerNode.compile(LayerNode.group([Global.node, AppProcess.node, Npm.node]), [
        [
          Global.node,
          Global.layerWith(process.env.YCODING_CONFIG_DIR ? { config: process.env.YCODING_CONFIG_DIR } : {}),
        ],
      ]),
    ),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
    Effect.tap(() => Effect.sync(() => process.exit(process.exitCode ?? 0))),
    NodeRuntime.runMain,
  )
}
