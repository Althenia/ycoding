import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { ShellSandbox } from "@ycoding-ai/core/shell-sandbox"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(ShellSandbox.node))

it.effect("fails explicitly when no enforceable backend is installed", () =>
  Effect.gen(function* () {
    const sandbox = yield* ShellSandbox.Service
    const result = yield* sandbox.prepare(ChildProcess.make("sh", ["-c", "pwd"])).pipe(Effect.exit)

    expect(Exit.isFailure(result)).toBe(true)
    expect(Exit.findErrorOption(result)).toMatchObject({
      _tag: "Some",
      value: {
        _tag: "ShellSandbox.Unavailable",
        message: "No enforceable shell sandbox backend is available on this runtime.",
      },
    })
  }),
)
