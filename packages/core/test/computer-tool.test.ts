import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Computer } from "@ycoding-ai/core/computer"
import { LocationMutation } from "@ycoding-ai/core/location-mutation"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionV2 } from "@ycoding-ai/core/session"
import { ComputerTool } from "@ycoding-ai/core/tool/computer"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { Image } from "@ycoding-ai/core/image"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { registerToolPlugin, settleTool, toolIdentity, waitForTool } from "./lib/tool"

const calls: string[] = []
const sessionID = SessionV2.ID.make("ses_computer_tool")

const computer = Layer.mock(Computer.Service, {
  status: Effect.succeed({ platform: "macos", state: "supported" as const, capabilities: [] }),
  inspect: (input) => {
    calls.push(`inspect:${input.target.application}`)
    return Effect.succeed({
      status: "ok" as const,
      action: `${input.target.application}.inspect` as const,
      revision: "rev-1",
    })
  },
  act: (input) => {
    if (input.action.type === "finder.move") {
      calls.push("native:finder.move")
      return Effect.succeed({ status: "ok" as const, action: "finder.move" as const, revision: "rev-2" })
    }
    calls.push("native:iterm.send_text")
    return Effect.succeed({ status: "ok" as const, action: "iterm.send_text" as const, revision: "rev-2" })
  },
  cancel: () => Effect.succeed(false),
  releaseSession: () => Effect.void,
})
const permission = Layer.mock(PermissionV2.Service, {
  assert: (input) => {
    calls.push(`permission:${input.action}:${input.resources.join(",")}`)
    return Effect.void
  },
})
const guardrail = Layer.mock(SessionGuardrail.Service, {
  assert: (input) => {
    calls.push(`guardrail:${input.action}:${input.resources.join(",")}`)
    return Effect.succeed({ release: Effect.sync(() => calls.push("guardrail:release")) })
  },
})
const location = Layer.mock(LocationMutation.Service, {
  resolve: (input) => {
    const canonical = input.path.startsWith("/workspace/") ? input.path : `/workspace/${input.path}`
    return Effect.succeed({
      canonical,
      resource: canonical.slice("/workspace/".length),
    })
  },
})

const computerToolNode = makeLocationNode({
  name: "test/computer-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(ComputerTool.Plugin)),
  deps: [ToolRegistry.toolsNode, Computer.node, PermissionV2.node, SessionGuardrail.node, LocationMutation.node],
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, computerToolNode]), [
    [Computer.node, computer],
    [PermissionV2.node, permission],
    [SessionGuardrail.node, guardrail],
    [LocationMutation.node, location],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [Image.node, imagePassthrough],
  ]),
)

const call = (input: Record<string, unknown>, id: string) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "computer", input },
})

describe("computer tool policy ordering", () => {
  it.effect("reports filtered provider status without a permission or native call", () =>
    Effect.gen(function* () {
      calls.length = 0
      const registry = yield* ToolRegistry.Service
      yield* waitForTool(registry, "computer")
      yield* settleTool(registry, call({ action: "status" }, "call-status"))
      expect(calls).toEqual([])
    }),
  )

  it.effect("checks computer permission and shell guardrails before an iTerm write", () =>
    Effect.gen(function* () {
      calls.length = 0
      const registry = yield* ToolRegistry.Service
      yield* waitForTool(registry, "computer")
      yield* settleTool(
        registry,
        call(
          {
            action: "iterm.send_text",
            platform: "macos",
            window_id: 41,
            tab_index: 2,
            session_id: "iterm-session-guid",
            expected_revision: "rev-1",
            text: "printf safe",
            newline: true,
          },
          "call-iterm",
        ),
      )
      expect(calls).toEqual([
        "permission:computer:macos.bundle_id/com.googlecode.iterm2/41/2/iterm-session-guid",
        "guardrail:shell:printf safe",
        "native:iterm.send_text",
        "guardrail:release",
      ])
    }),
  )

  it.effect("canonicalizes both Finder move paths before mutation", () =>
    Effect.gen(function* () {
      calls.length = 0
      const registry = yield* ToolRegistry.Service
      yield* waitForTool(registry, "computer")
      yield* settleTool(
        registry,
        call(
          {
            action: "finder.move",
            platform: "macos",
            path: "fixture/old.txt",
            destination_directory: "moved",
            expected_revision: "rev-1",
          },
          "call-finder",
        ),
      )
      expect(calls).toEqual([
        "permission:computer:fixture/old.txt,moved/old.txt",
        "guardrail:file_mutation:/workspace/fixture/old.txt,/workspace/moved/old.txt",
        "native:finder.move",
        "guardrail:release",
      ])
    }),
  )
})
