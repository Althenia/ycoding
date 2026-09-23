import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { SessionV2 } from "@ycoding-ai/core/session"
import { TaskCompleteTool } from "@ycoding-ai/core/tool/task-complete"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { Image } from "@ycoding-ai/core/image"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { executeTool, registerToolPlugin, toolDefinitions, toolIdentity } from "./lib/tool"

const plugin = makeLocationNode({
  name: "test/task-complete-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(TaskCompleteTool.Plugin)),
  deps: [ToolRegistry.toolsNode],
})
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, plugin]), [
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [Image.node, imagePassthrough],
  ]),
)

describe("TaskCompleteTool", () => {
  it.effect("records explicit local completion without remote notification configuration", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const definitions = yield* toolDefinitions(registry)
      expect(definitions.map((item) => item.name)).toContain("task_complete")
      expect(definitions.find((item) => item.name === "task_complete")?.description).toContain("verified")
      expect(
        yield* executeTool(registry, {
          sessionID: SessionV2.ID.make("ses_complete_test"),
          ...toolIdentity,
          call: { type: "tool-call", id: "call-complete", name: "task_complete", input: {} },
        }),
      ).toEqual({ type: "text", value: "Task completion recorded." })
    }),
  )
})
