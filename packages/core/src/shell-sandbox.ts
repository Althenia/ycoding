export * as ShellSandbox from "./shell-sandbox"

import { Context, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { makeGlobalNode } from "./effect/app-node"

export class Unavailable extends Schema.TaggedErrorClass<Unavailable>()("ShellSandbox.Unavailable", {
  message: Schema.String,
}) {}

export interface Interface {
  /**
   * Return an enforceably sandboxed command without spawning it.
   * Implementations must fail with Unavailable when they cannot provide the
   * promised process, filesystem, and network isolation for this command.
   */
  readonly prepare: (command: ChildProcess.Command) => Effect.Effect<ChildProcess.Command, Unavailable>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/ShellSandbox") {}

const layer = Layer.succeed(
  Service,
  Service.of({
    prepare: () =>
      Effect.fail(
        new Unavailable({
          message: "No enforceable shell sandbox backend is available on this runtime.",
        }),
      ),
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
