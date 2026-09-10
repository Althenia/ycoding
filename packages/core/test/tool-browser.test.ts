import { describe, expect } from "bun:test"
import { Browser } from "@ycoding-ai/core/browser"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { Image } from "@ycoding-ai/core/image"
import { IsolatedBrowser } from "@ycoding-ai/core/isolated-browser"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { BrowserTool } from "@ycoding-ai/core/tool/browser"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { Effect, Layer } from "effect"
import { imagePassthrough } from "./lib/image"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"
import { testEffect } from "./lib/effect"

const sessionID = SessionV2.ID.make("ses_browser_tool")
const tabID = Browser.TabID.make("btab_browser_tool")
const sequence: string[] = []

const tab: Browser.Tab = {
  id: tabID,
  sessionID,
  title: "Fixture",
  page: { origin: "https://example.test", path: "/form" },
  status: "shared",
  generation: 1,
  documentGeneration: 1,
  observationRevision: 1,
}
const isolatedInstanceID = IsolatedBrowser.InstanceID.make("ibrowser_tool")

const browser = Layer.mock(Browser.Service, {
  status: () => Effect.succeed({ state: "unavailable" }),
  list: () => Effect.succeed([tab]),
  action: (input) =>
    Effect.sync(() => {
      sequence.push(`action:${input.callID}`)
      return { callID: input.callID, tab, status: "completed" as const }
    }),
})
const isolatedBrowser = Layer.mock(IsolatedBrowser.Service, {
  status: () => Effect.succeed({ mode: "isolated", state: "ready", instanceID: isolatedInstanceID, tab }),
  control: () => Effect.succeed({ mode: "isolated", state: "paused", instanceID: isolatedInstanceID, tab }),
  list: () => Effect.succeed([tab]),
  action: (input) =>
    Effect.sync(() => {
      sequence.push(`isolated-action:${input.callID}:${input.instanceID}`)
      return {
        mode: "isolated" as const,
        instanceID: input.instanceID,
        callID: input.callID,
        tab,
        status: "completed" as const,
      }
    }),
})
const permission = Layer.mock(PermissionV2.Service, {
  assert: (input) => Effect.sync(() => sequence.push(`permission:${input.action}:${input.resources[0]}`)),
})
const guardrail = Layer.mock(SessionGuardrail.Service, {
  assert: (input) =>
    Effect.sync(() => {
      sequence.push(`guardrail:${input.action}:${input.resources[0]}`)
      return { release: Effect.sync(() => sequence.push("release")) }
    }),
})
const browserToolNode = makeLocationNode({
  name: "test/browser-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(BrowserTool.Plugin)),
  deps: [ToolRegistry.toolsNode, Browser.node, IsolatedBrowser.node, PermissionV2.node, SessionGuardrail.node],
})
const browserTests = (permissionLayer: typeof permission) =>
  testEffect(
    AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, browserToolNode]), [
      [Browser.node, browser],
      [IsolatedBrowser.node, isolatedBrowser],
      [PermissionV2.node, permissionLayer],
      [SessionGuardrail.node, guardrail],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Image.node, imagePassthrough],
    ]),
  )
const it = browserTests(permission)
const denied = browserTests(
  Layer.mock(PermissionV2.Service, {
    assert: (input) =>
      input.action === "browser_read"
        ? Effect.fail(new PermissionV2.CorrectedError({ feedback: "Browser metadata access denied" }))
        : Effect.void,
  }),
)

describe("BrowserTool", () => {
  for (const input of [
    { operation: "status", mode: "isolated" },
    { operation: "control", mode: "isolated", action: "pause" },
  ]) {
    denied.effect(`does not expose isolated ${input.operation} metadata when read permission is denied`, () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const result = yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: `call-denied-${input.operation}`, name: "browser", input },
        })
        expect(result).toMatchObject({ type: "error" })
        expect(JSON.stringify(result)).not.toContain("example.test")
        expect(JSON.stringify(result)).not.toContain(tabID)
      }),
    )
  }
  it.effect("enforces permission then guardrail at the leaf before a semantic mutation", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-browser-mutation",
          name: "browser",
          input: {
            operation: "action",
            tabID,
            generation: 1,
            documentGeneration: 1,
            observationRevision: 1,
            action: { type: "click", ref: "b1" },
          },
        },
      })
      expect(result).toEqual({
        type: "text",
        value: JSON.stringify({
          type: "action",
          result: { callID: "call-browser-mutation", tab, status: "completed" },
        }),
      })
      expect(sequence).toEqual([
        "permission:browser_interact:https://example.test/form",
        "guardrail:browser_mutation:https://example.test/form",
        "action:call-browser-mutation",
        "release",
      ])
    }),
  )

  it.effect("reports unavailable bridge status without fabricating a browser action", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-browser-status", name: "browser", input: { operation: "status" } },
        }),
      ).toEqual({
        type: "text",
        value: JSON.stringify({ type: "status", status: { state: "unavailable" } }),
      })
      expect(sequence).toEqual([])
    }),
  )

  it.effect("authorizes shared-tab metadata before exposing it to the model", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-browser-tabs", name: "browser", input: { operation: "tabs" } },
        }),
      ).toEqual({ type: "text", value: JSON.stringify({ type: "tabs", tabs: [tab] }) })
      expect(sequence).toEqual(["permission:browser_read:https://example.test/form"])
    }),
  )

  it.effect("authorizes isolated status page metadata before exposing it to the model", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-isolated-status",
            name: "browser",
            input: { operation: "status", mode: "isolated" },
          },
        }),
      ).toEqual({
        type: "text",
        value: JSON.stringify({
          type: "status",
          status: { mode: "isolated", state: "ready", instanceID: isolatedInstanceID, tab },
        }),
      })
      expect(sequence).toEqual(["permission:browser_read:https://example.test/form"])
    }),
  )

  it.effect("authorizes page metadata returned by isolated control independently of control permission", () =>
    Effect.gen(function* () {
      sequence.length = 0
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-isolated-control",
          name: "browser",
          input: { operation: "control", mode: "isolated", action: "pause" },
        },
      })
      expect(result).toEqual({
        type: "text",
        value: JSON.stringify({
          type: "status",
          status: { mode: "isolated", state: "paused", instanceID: isolatedInstanceID, tab },
        }),
      })
      expect(sequence).toEqual([
        "permission:browser_control:pause",
        "permission:browser_read:https://example.test/form",
      ])
    }),
  )

  it.effect(
    "routes explicit isolated mode with its mandatory instance fence through the same permission and guardrail order",
    () =>
      Effect.gen(function* () {
        sequence.length = 0
        const registry = yield* ToolRegistry.Service
        const result = yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-isolated-mutation",
            name: "browser",
            input: {
              operation: "action",
              mode: "isolated",
              instanceID: isolatedInstanceID,
              tabID,
              generation: 1,
              documentGeneration: 1,
              observationRevision: 1,
              action: { type: "click", ref: "b1" },
            },
          },
        })
        expect(result).toEqual({
          type: "text",
          value: JSON.stringify({
            type: "action",
            result: {
              mode: "isolated",
              instanceID: isolatedInstanceID,
              callID: "call-isolated-mutation",
              tab,
              status: "completed",
            },
          }),
        })
        expect(sequence).toEqual([
          "permission:browser_interact:https://example.test/form",
          "guardrail:browser_mutation:https://example.test/form",
          `isolated-action:call-isolated-mutation:${isolatedInstanceID}`,
          "release",
        ])
      }),
  )
})
