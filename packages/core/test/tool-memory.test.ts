import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LLM } from "@ycoding-ai/ai"
import { OpenAIChat, OpenAIResponses } from "@ycoding-ai/ai/protocols"
import { Auth, LLMClient } from "@ycoding-ai/ai/route"
import { MemoryTool } from "@ycoding-ai/core/tool/memory"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Memory } from "@ycoding-ai/core/memory"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionV2 } from "@ycoding-ai/core/session"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { Image } from "@ycoding-ai/core/image"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { executeTool, registerToolPlugin, toolDefinitions, toolIdentity } from "./lib/tool"
import { imagePassthrough } from "./lib/image"
import { memoryFixture, note } from "./lib/memory"

test("R5-F exposes on-demand memory and enforces permissions/guardrail lifetime across a real store flow", async () => {
  await using f = await memoryFixture()
  const state = { denied: false, catalogDenied: false, guardDenied: false, redirect: false, reads: 0, reservations: 0, releases: 0, actions: [] as string[] }
  const permissions = Layer.mock(PermissionV2.Service, {
    evaluateEffective: () => Effect.succeed(state.catalogDenied ? "deny" as const : "ask" as const),
    assert: (input) => Effect.gen(function* () {
      state.actions.push(input.action)
      if (state.denied) return yield* new PermissionV2.BlockedError({ rules: [], permission: input.action, resources: input.resources })
      if (state.redirect) f.settings.path = "redirected"
    }),
  })
  const guardrails = Layer.mock(SessionGuardrail.Service, {
    assert: () => Effect.gen(function* () {
      if (state.guardDenied) return yield* new SessionGuardrail.DeclinedError({ requestID: Guardrail.RequestID.make("grq_memory_test") })
      state.reservations++
      return { release: Effect.sync(() => { state.releases++ }) }
    }),
  })
  const plugin = makeLocationNode({
    name: "test/memory-tool-plugin", layer: Layer.effectDiscard(registerToolPlugin(MemoryTool.Plugin)),
    deps: [Memory.node, ToolRegistry.toolsNode, PermissionV2.node, SessionGuardrail.node],
  })
  const layer = AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, plugin]), [
    [Memory.node, Layer.succeed(Memory.Service, {
      ...f.store,
      read: (input, expectedRoot) => Effect.suspend(() => { state.reads++; return f.store.read(input, expectedRoot) }),
    })],
    [PermissionV2.node, permissions], [SessionGuardrail.node, guardrails],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig], [Image.node, imagePassthrough],
  ])
  await Effect.runPromise(Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const definitions = yield* toolDefinitions(registry)
    expect(definitions.map((definition) => definition.name)).toContain("memory")
    const chat = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
      LLM.request({
        model: OpenAIChat.route.with({ auth: Auth.bearer("test") }).model({ id: "tool-schema-fixture" }),
        prompt: "Search repository memory.",
        tools: definitions,
      }),
    )
    const responses = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
      LLM.request({
        model: OpenAIResponses.route.with({ auth: Auth.bearer("test") }).model({ id: "gpt-5" }),
        prompt: "Search repository memory.",
        tools: definitions,
      }),
    )
    const responseTool = responses.body.tools
      ?.filter((tool) => tool.type === "function")
      .find((tool) => tool.name === "memory")
    for (const parameters of [
      chat.body.tools?.find((tool) => tool.function.name === "memory")?.function.parameters,
      responseTool?.parameters,
    ]) {
      expect(parameters).toMatchObject({
        type: "object",
        required: ["action"],
        properties: {
          action: {
            anyOf: [
              "status", "list", "search", "read", "trash", "vacuum", "graph", "write", "delete", "restore", "purge",
            ].map((action) => ({ type: "string", enum: [action] })),
          },
          scope: { type: "string", enum: ["repository", "knowledge"] },
          query: { type: "string" },
          content: { type: "string" },
        },
      })
      expect(parameters).not.toHaveProperty("anyOf")
    }
    const call = (input: Record<string, unknown>) => executeTool(registry, {
      sessionID: SessionV2.ID.make("ses_memory_test"), ...toolIdentity,
      call: { type: "tool-call", id: `call-${state.actions.length}`, name: "memory", input },
    })
    expect((yield* call({ query: "build" })).type).toBe("error")
    expect((yield* call({ action: "write", id: "guide" })).type).toBe("error")
    expect(state.actions).toEqual([])
    state.catalogDenied = true
    expect((yield* call({ action: "write", id: "guide", content: note() })).type).toBe("error")
    expect(state.actions).toEqual([])
    state.catalogDenied = false
    state.denied = true
    expect((yield* call({ action: "write", id: "guide", content: note() })).type).toBe("error")
    expect((yield* call({ action: "read", id: "guide" })).type).toBe("error")
    expect(yield* Effect.promise(() => fs.stat(path.join(f.directory, "data")).then(() => true, () => false))).toBe(false)
    state.denied = false
    state.guardDenied = true
    expect((yield* call({ action: "write", id: "guide", content: note() })).type).toBe("error")
    expect(yield* Effect.promise(() => fs.stat(path.join(f.directory, "data")).then(() => true, () => false))).toBe(false)
    state.guardDenied = false
    expect((yield* call({ action: "write", id: "guide", content: note() })).type).toBe("text")
    expect((yield* call({ action: "search", query: "build" }))).toMatchObject({ type: "text", value: expect.stringContaining("guide") })
    expect((yield* call({ action: "read", id: "guide" }))).toMatchObject({ type: "text", value: expect.stringContaining("local build") })
    expect(state.reads).toBe(1)
    state.denied = true
    expect((yield* call({ action: "read", id: "guide" })).type).toBe("error")
    expect(state.reads).toBe(1)
    state.denied = false
    expect((yield* call({ action: "graph" }))).toMatchObject({ type: "text", value: expect.stringContaining("graph.html") })
    expect((yield* call({ action: "write", id: "guide", content: note("different") })).type).toBe("error")
    expect(state.actions).toContain("memory_read")
    expect(state.actions).toContain("memory_write")
    expect(state.reservations).toBe(3)
    expect(state.releases).toBe(state.reservations)
    state.redirect = true
    expect((yield* call({ action: "write", id: "redirected", content: note() }))).toMatchObject({ type: "error", value: expect.stringContaining("location changed") })
    expect(yield* Effect.promise(() => fs.stat(path.join(f.workspace, "redirected")).then(() => true, () => false))).toBe(false)
    expect(state.reservations).toBe(4)
    expect(state.releases).toBe(state.reservations)
    state.redirect = false
    f.settings.path = undefined
    f.settings.enabled = false
    expect((yield* call({ action: "read", id: "guide" })).type).toBe("error")
    expect((yield* call({ action: "write", id: "disabled", content: note() })).type).toBe("error")
    expect(state.reads).toBe(1)
    expect(state.reservations).toBe(4)
    f.settings.enabled = true
    expect((yield* f.store.read({ id: "guide" })).content).toBe(note())
    expect((yield* f.store.list({})).concepts.map(concept => concept.id)).toEqual(["guide"])
  }).pipe(Effect.provide(layer), Effect.scoped))
})
