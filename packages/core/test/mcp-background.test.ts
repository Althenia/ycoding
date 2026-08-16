import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { Image } from "@ycoding-ai/core/image"
import { Job } from "@ycoding-ai/core/job"
import { MCP } from "@ycoding-ai/core/mcp/index"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { PluginRuntime } from "@ycoding-ai/core/plugin/runtime"
import { SessionV2 } from "@ycoding-ai/core/session"
import { McpTool } from "@ycoding-ai/core/tool/mcp"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { DateTime, Deferred, Effect, Fiber, Layer, Scope, Stream } from "effect"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { settleTool, toolDefinitions, toolIdentity, waitForTool } from "./lib/tool"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionPending } from "@ycoding-ai/core/session/pending"

const sessionID = SessionV2.ID.make("ses_mcp_background")

const state: {
  latch?: Deferred.Deferred<void>
  notification?: Deferred.Deferred<{ text: string; description?: string }>
  calls: Array<{ name: string; args?: Record<string, unknown> }>
} = { calls: [] }

const reset = () => {
  state.latch = undefined
  state.notification = undefined
  state.calls.length = 0
}

const mcp = Layer.mock(MCP.Service, {
  tools: () =>
    Effect.succeed([
      new MCP.Tool({
        server: MCP.ServerName.make("lean-ctx"),
        name: "ctx_shell",
        description: "Run a shell command",
        codemode: false,
        inputSchema: { type: "object", properties: { command: { type: "string" }, token: { type: "string" } } },
      }),
      new MCP.Tool({
        server: MCP.ServerName.make("chrome"),
        name: "get_console_message",
        description: "Returns a running console message",
        codemode: false,
        inputSchema: { type: "object", properties: {} },
      }),
      new MCP.Tool({
        server: MCP.ServerName.make("penpot"),
        name: "execute_code",
        description: "Evaluates plugin code",
        codemode: false,
        inputSchema: { type: "object", properties: {} },
      }),
      new MCP.Tool({
        server: MCP.ServerName.make("lookup"),
        name: "search",
        description: "Find indexed files",
        codemode: false,
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      }),
    ]),
  callTool: (input) =>
    Effect.gen(function* () {
      state.calls.push({ name: input.name, args: input.args })
      if (input.name === "ctx_shell" && state.latch) yield* Deferred.await(state.latch)
      return new MCP.ToolResult({
        server: MCP.ServerName.make(input.server),
        tool: input.name,
        isError: false,
        structured: { complete: true },
        content: [{ type: "text", text: "full MCP output" }],
      })
    }),
})

const runtime = Layer.effect(
  PluginRuntime.Service,
  Effect.gen(function* () {
    const jobs = yield* Job.Service
    const unavailable = () => Effect.die(new Error("unused plugin runtime operation"))
    const synthetic = SessionPending.Synthetic.make({
      admittedSeq: 1,
      id: SessionMessage.ID.make("msg_mcp_background"),
      sessionID,
      timeCreated: DateTime.makeUnsafe(0),
      type: "synthetic",
      data: { text: "MCP tool completed" },
      delivery: "steer",
    })
    return PluginRuntime.Service.of({
      session: {
        get: unavailable,
        create: unavailable,
        messages: unavailable,
        prompt: unavailable,
        generate: unavailable,
        command: unavailable,
        resume: unavailable,
        interrupt: unavailable,
        synthetic: (input) =>
          state.notification
            ? Deferred.succeed(state.notification, { text: input.text, description: input.description }).pipe(
                Effect.as(synthetic),
              )
            : Effect.succeed(synthetic),
      },
      job: jobs,
      orchestration: {
        managed: unavailable,
        get: unavailable,
        launch: unavailable,
        list: unavailable,
        send: unavailable,
        answer: unavailable,
        cancel: unavailable,
        resume: unavailable,
        progress: unavailable,
        question: unavailable,
        settle: unavailable,
        background: unavailable,
        teamView: unavailable,
        recover: unavailable(),
      },
      location: { agent: { list: unavailable } },
    })
  }),
)

const permissions = Layer.mock(PermissionV2.Service, { assert: () => Effect.void })
const events = Layer.mock(EventV2.Service, { subscribe: () => Stream.never })
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, Job.node, McpTool.node]),
    [
      [MCP.node, mcp],
      [PermissionV2.node, permissions],
      [EventV2.node, events],
      [PluginRuntime.node, runtime],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Image.node, imagePassthrough],
    ],
  ),
)

const call = (name: string, input: Record<string, unknown>, id = "call_mcp_background") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name, input },
})

const backgroundWhenReady = (jobs: Job.Interface, remaining = 1_000): Effect.Effect<Job.Info[], Error> =>
  Effect.gen(function* () {
    const backgrounded = yield* jobs.backgroundAll({ sessionID })
    if (backgrounded.length > 0) return backgrounded
    if (remaining === 0) return yield* Effect.fail(new Error("Timed out waiting for foreground MCP job"))
    yield* Effect.promise(() => Bun.sleep(1))
    return yield* backgroundWhenReady(jobs, remaining - 1)
  })

describe("MCP tool backgrounding", () => {
  it.live("returns immediately, strips injected input, and notifies after an explicit background request", () =>
    Effect.gen(function* () {
      reset()
      state.latch = yield* Deferred.make<void>()
      state.notification = yield* Deferred.make<{ text: string; description?: string }>()
      const jobs = yield* Job.Service
      const registry = yield* ToolRegistry.Service
      yield* waitForTool(registry, "lean-ctx_ctx_shell")
      const definition = (yield* toolDefinitions(registry)).find((tool) => tool.name === "lean-ctx_ctx_shell")
      const schema = definition?.inputSchema as { readonly properties?: Record<string, unknown> } | undefined

      expect(schema?.properties?.background).toEqual(expect.any(Object))
      expect(definition?.description).toContain("must not be polled")

      const settlement = yield* settleTool(
        registry,
        call("lean-ctx_ctx_shell", { command: "sleep", token: "secret-token-value", background: true }),
      )
      expect(settlement.output?.content).toEqual([{ type: "text", text: "The MCP tool was moved to the background." }])
      expect(state.calls).toEqual([{ name: "ctx_shell", args: { command: "sleep", token: "secret-token-value" } }])
      expect((yield* jobs.get("call_mcp_background"))?.title).toBe("ctx_shell (command, token)")

      yield* Deferred.succeed(state.latch, undefined)
      expect(yield* Deferred.await(state.notification)).toMatchObject({
        description: "ctx_shell",
        text: expect.stringContaining('<mcp id="call_mcp_background" state="completed" tool="lean-ctx_ctx_shell">'),
      })
    }),
  )

  it.effect("does not advertise background input for non-execution MCP tools", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      yield* waitForTool(registry, "lookup_search")
      yield* waitForTool(registry, "chrome_get_console_message")
      yield* waitForTool(registry, "penpot_execute_code")
      const definition = (yield* toolDefinitions(registry)).find((tool) => tool.name === "lookup_search")
      const schema = definition?.inputSchema as { readonly properties?: Record<string, unknown> } | undefined
      const consoleDefinition = (yield* toolDefinitions(registry)).find((tool) => tool.name === "chrome_get_console_message")
      const consoleSchema = consoleDefinition?.inputSchema as { readonly properties?: Record<string, unknown> } | undefined
      const executeDefinition = (yield* toolDefinitions(registry)).find((tool) => tool.name === "penpot_execute_code")
      const executeSchema = executeDefinition?.inputSchema as { readonly properties?: Record<string, unknown> } | undefined

      expect(schema?.properties?.background).toBeUndefined()
      expect(consoleSchema?.properties?.background).toBeUndefined()
      expect(executeSchema?.properties?.background).toEqual(expect.any(Object))
    }),
  )

  it.effect("preserves full structured content for foreground MCP calls", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      yield* waitForTool(registry, "lean-ctx_ctx_shell")

      const settlement = yield* settleTool(registry, call("lean-ctx_ctx_shell", { command: "echo full" }))
      expect(settlement.output).toEqual({
        structured: { complete: true },
        content: [{ type: "text", text: "full MCP output" }],
      })
    }),
  )

  it.live("returns a background result when a foreground MCP job is backgrounded mid-flight", () =>
    Effect.gen(function* () {
      reset()
      state.latch = yield* Deferred.make<void>()
      state.notification = yield* Deferred.make<{ text: string; description?: string }>()
      const jobs = yield* Job.Service
      const registry = yield* ToolRegistry.Service
      const scope = yield* Scope.Scope
      yield* waitForTool(registry, "lean-ctx_ctx_shell")

      const waiting = yield* settleTool(registry, call("lean-ctx_ctx_shell", { command: "sleep" }, "call_mcp_midflight")).pipe(
        Effect.forkIn(scope, { startImmediately: true }),
      )
      expect(yield* backgroundWhenReady(jobs)).toMatchObject([{ id: "call_mcp_midflight", type: "lean-ctx_ctx_shell" }])
      expect((yield* Fiber.join(waiting)).output?.content).toEqual([
        { type: "text", text: "The MCP tool was moved to the background." },
      ])

      yield* Deferred.succeed(state.latch, undefined)
      expect(yield* Deferred.await(state.notification)).toMatchObject({
        text: expect.stringContaining('<mcp id="call_mcp_midflight" state="completed" tool="lean-ctx_ctx_shell">'),
      })
    }),
  )
})
