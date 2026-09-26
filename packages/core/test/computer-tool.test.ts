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
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { registerToolPlugin, settleTool, toolIdentity, waitForTool } from "./lib/tool"

const calls: string[] = []
const actions: Computer.Action[] = []
const sessionID = SessionV2.ID.make("ses_computer_tool")

const computer = Layer.mock(Computer.Service, {
  status: Effect.succeed({ platform: "macos", state: "supported" as const, capabilities: [] }),
  list: () => { calls.push("native:desktop.list"); return Effect.succeed({ status: "ok" as const, action: "desktop.list" as const, revision: "rev-list", apps: [] }) },
  launch: () => { calls.push("native:desktop.launch"); return Effect.succeed({ status: "ok" as const, action: "desktop.launch" as const, revision: "rev-launch", pid: 451, windows: [] }) },
  quit: () => { calls.push("native:desktop.quit"); return Effect.succeed({ status: "ok" as const, action: "desktop.quit" as const, revision: "", exited: false }) },
  inspect: (input) => {
    calls.push(`inspect:${input.target.application}`)
    return Effect.succeed({
      status: "ok" as const,
      action: `${input.target.application}.inspect` as const,
      revision: "rev-1",
      ...(input.target.application === "desktop" ? { accessible: false, elements: [] } : {}),
    })
  },
  act: (input) => {
    actions.push(input.action)
    if (input.action.type.startsWith("desktop.")) {
      calls.push(`native:${input.action.type}`)
      return Effect.succeed({ status: "ok" as const, action: input.action.type, revision: "rev-2", effect: "unchanged" as const })
    }
    if (input.action.type === "finder.move") {
      calls.push("native:finder.move")
      return Effect.succeed({ status: "ok" as const, action: "finder.move" as const, revision: "rev-2" })
    }
    calls.push("native:iterm.send_text")
    return Effect.succeed({ status: "ok" as const, action: "iterm.send_text" as const, revision: "rev-2" })
  },
  capture: () => {
    calls.push("native:desktop.capture")
    return Effect.succeed({
      status: "ok" as const,
      action: "desktop.capture" as const,
      revision: "rev-1",
      image: "base64",
      width: 320, height: 240, scale: 1,
    })
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
    calls.push(`guardrail:${input.action}:${input.resources.join(",")}:${input.skipReview}`)
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
  it.effect("uses separate permission resources for opt-in debugging and graceful quit", () =>
    Effect.gen(function* () {
      calls.length = 0
      const registry = yield* ToolRegistry.Service
      yield* waitForTool(registry, "computer")
      yield* settleTool(registry, call({ action: "desktop.launch", platform: "macos", bundle_id: "com.example.fixture", remote_debugging: true }, "debug-launch"))
      expect(calls).toEqual([
        "permission:computer:macos.bundle_id/com.example.fixture/remote_debugging",
        "guardrail:computer:macos.bundle_id/com.example.fixture/remote_debugging:true",
        "native:desktop.launch", "guardrail:release",
      ])
      calls.length = 0
      const settlement = yield* settleTool(registry, call({ action: "desktop.quit", platform: "macos", bundle_id: "com.example.fixture", pid: "451" }, "graceful-quit"))
      expect(calls).toEqual([
        "permission:computer:macos.bundle_id/com.example.fixture/quit",
        "guardrail:computer:macos.bundle_id/com.example.fixture/quit:true",
        "native:desktop.quit", "guardrail:release",
      ])
      expect(settlement.output?.content).toEqual([{ type: "text", text: JSON.stringify({ type: "result", action: "desktop.quit", revision: "", exited: false }) }])
    }),
  )
  it.effect("shows unchanged pointer effect so a caller does not repeat a dropped pixel click", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* waitForTool(registry, "computer")
      const settlement = yield* settleTool(registry, call({ action: "desktop.click", platform: "macos", bundle_id: "com.example.fixture", pid: 451, window_id: 73, expected_revision: "rev-1", x: 34, y: 319, count: 2 }, "unchanged-click"))
      expect(settlement.output?.content).toEqual([{ type: "text", text: JSON.stringify({ type: "result", action: "desktop.click", revision: "rev-2", effect: "unchanged" }) }])
    }),
  )
  it.effect("exposes an AX-inaccessible window state rather than hiding its pixels", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* waitForTool(registry, "computer")
      const settlement = yield* settleTool(registry, call({ action: "desktop.inspect", platform: "macos", bundle_id: "com.example.fixture", pid: 451, window_id: 73 }, "ax-inaccessible"))
      expect(settlement.output?.content).toEqual([{ type: "text", text: JSON.stringify({ type: "result", action: "desktop.inspect", revision: "rev-1", accessible: false, elements: [] }) }])
    }),
  )
  it.effect("lists apps without a target claim and launches with bundle-scoped permission", () =>
    Effect.gen(function* () {
      calls.length = 0
      const registry = yield* ToolRegistry.Service
      yield* waitForTool(registry, "computer")
      yield* settleTool(registry, call({ action: "desktop.list", platform: "macos" }, "list"))
      expect(calls).toEqual(["permission:computer:macos.desktop/list", "guardrail:computer:macos.desktop/list:true", "native:desktop.list", "guardrail:release"])
      calls.length = 0
      yield* settleTool(registry, call({ action: "desktop.launch", platform: "macos", bundle_id: "com.example.fixture" }, "launch"))
      expect(calls).toEqual([
        "permission:computer:macos.bundle_id/com.example.fixture/launch",
        "guardrail:computer:macos.bundle_id/com.example.fixture/launch:true",
        "native:desktop.launch",
        "guardrail:release",
      ])
    }),
  )

  it.effect("maps coordinate and keyboard actions to native requests without guessing an element", () =>
    Effect.gen(function* () {
      actions.length = 0
      const registry = yield* ToolRegistry.Service
      yield* waitForTool(registry, "computer")
      for (const [index, fields] of [
        { action: "desktop.click", x: 15, y: 22, button: "right", count: 2 },
        { action: "desktop.drag", from_x: 1, from_y: 2, to_x: 30, to_y: 40 },
        { action: "desktop.scroll", x: 15, y: 22, delta_x: -3, delta_y: 6 },
        { action: "desktop.type", text: "hello" },
        { action: "desktop.key", key: "a", modifiers: ["command"] },
      ].entries()) {
        yield* settleTool(registry, call({ ...fields, platform: "macos", bundle_id: "com.example.fixture", pid: 451, window_id: 73, expected_revision: "rev-1" }, `mapping-${index}`))
      }
      expect(actions).toEqual([
        { type: "desktop.click", x: 15, y: 22, button: "right", count: 2 },
        { type: "desktop.drag", fromX: 1, fromY: 2, toX: 30, toY: 40 },
        { type: "desktop.scroll", x: 15, y: 22, deltaX: -3, deltaY: 6 },
        { type: "desktop.type", text: "hello" },
        { type: "desktop.key", key: "a", modifiers: ["command"] },
      ])
    }),
  )

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
        "guardrail:shell:printf safe:true",
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
        "guardrail:file_mutation:/workspace/fixture/old.txt,/workspace/moved/old.txt:true",
        "native:finder.move",
        "guardrail:release",
      ])
    }),
  )

  it.effect("reviews an explicit desktop click before dispatch", () =>
    Effect.gen(function* () {
      calls.length = 0
      const registry = yield* ToolRegistry.Service
      yield* waitForTool(registry, "computer")
      yield* settleTool(
        registry,
        call(
          {
            action: "desktop.click",
            platform: "macos",
            bundle_id: "com.example.fixture",
            pid: 451,
            window_id: 73,
            element: [0],
            expected_revision: "rev-1",
          },
          "desktop-click",
        ),
      )
      expect(calls).toEqual([
        "permission:computer:macos.bundle_id/com.example.fixture/451/73",
        "guardrail:computer:macos.bundle_id/com.example.fixture/451/73,element/0:true",
        "native:desktop.click",
        "guardrail:release",
      ])
    }),
  )

  it.effect("reviews a desktop screenshot and sends it as an image instead of base64 text", () =>
    Effect.gen(function* () {
      calls.length = 0
      const registry = yield* ToolRegistry.Service
      yield* waitForTool(registry, "computer")
      const settlement = yield* settleTool(
        registry,
        call(
          { action: "desktop.capture", platform: "macos", bundle_id: "com.example.fixture", pid: 451, window_id: 73 },
          "desktop-capture",
        ),
      )
      expect(calls).toEqual([
        "permission:computer:macos.bundle_id/com.example.fixture/451/73",
        "guardrail:computer:macos.bundle_id/com.example.fixture/451/73:true",
        "native:desktop.capture",
        "guardrail:release",
      ])
      expect(settlement.output?.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({ type: "result", action: "desktop.capture", revision: "rev-1", image: "image/jpeg", width: 320, height: 240, scale: 1 }),
        },
        { type: "file", uri: "data:image/jpeg;base64,base64", mime: "image/jpeg", name: "desktop-window.jpg" },
      ])
    }),
  )

  it.effect("shows desktop text content and element path in the human review before native input", () =>
    Effect.gen(function* () {
      calls.length = 0
      const registry = yield* ToolRegistry.Service
      yield* waitForTool(registry, "computer")
      yield* settleTool(
        registry,
        call(
          {
            action: "desktop.type",
            platform: "macos",
            bundle_id: "com.example.fixture",
            pid: 451,
            window_id: 73,
            element: [1, 2],
            expected_revision: "rev-1",
            text: "safe input",
          },
          "desktop-type",
        ),
      )
      expect(calls).toEqual([
        "permission:computer:macos.bundle_id/com.example.fixture/451/73",
        "guardrail:computer:macos.bundle_id/com.example.fixture/451/73,element/1/2,safe input:true",
        "native:desktop.type",
        "guardrail:release",
      ])
    }),
  )
})

describe("computer tool input", () => {
  const decode = Schema.decodeUnknownSync(ComputerTool.Input)
  it.effect("accepts integer-valued numeric strings in every integer field", () =>
    Effect.sync(() => {
      expect(decode({ action: "desktop.click", platform: "macos", bundle_id: "com.example.fixture", pid: "451", window_id: "73", x: "12", y: "13", count: "2", expected_revision: "rev" })).toMatchObject({ pid: 451, window_id: 73, x: 12, y: 13, count: 2 })
      expect(decode({ action: "desktop.click", platform: "macos", bundle_id: "com.example.fixture", pid: "451", window_id: "73", element: ["0", "11"], expected_revision: "rev" })).toMatchObject({ element: [0, 11] })
      expect(decode({ action: "iterm.inspect", platform: "macos", window_id: "41", tab_index: "2", session_id: "id" })).toMatchObject({ window_id: 41, tab_index: 2 })
      expect(decode({ action: "desktop.drag", platform: "macos", bundle_id: "x", pid: "1", window_id: "2", expected_revision: "rev", from_x: "3", from_y: "4", to_x: "5", to_y: "6" })).toMatchObject({ from_x: 3, from_y: 4, to_x: 5, to_y: 6 })
      expect(decode({ action: "desktop.scroll", platform: "macos", bundle_id: "x", pid: "1", window_id: "2", expected_revision: "rev", x: "3", y: "4", delta_x: "-5", delta_y: "6" })).toMatchObject({ delta_x: -5, delta_y: 6 })
      for (const value of ["-1", "1.2", "invalid"]) expect(() => decode({ action: "desktop.inspect", platform: "macos", bundle_id: "com.example.fixture", pid: value, window_id: 73 })).toThrow()
      expect(() => decode({ action: "desktop.drag", platform: "macos", bundle_id: "x", pid: 1, window_id: 2, expected_revision: "rev", from_x: "-1", from_y: 0, to_x: 1, to_y: 1 })).toThrow()
    }),
  )
})
