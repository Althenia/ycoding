export * as McpTool from "./mcp"

import { ToolFailure } from "@ycoding-ai/ai"
import { McpEvent } from "@ycoding-ai/schema/mcp-event"
import { Effect, Exit, type JsonSchema, Layer, Ref, Scope, Semaphore, Stream } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Job } from "../job"

import { MCP } from "../mcp"
import { PermissionV2 } from "../permission"
import { PluginRuntime } from "../plugin/runtime"
import { SessionGuardrail } from "../session/guardrail"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { ToolRegistry } from "./registry"

/**
 * Registry namespace and permission action names for MCP tools.
 */
export const namespace = (server: string) => server.replace(/[^a-zA-Z0-9_-]/g, "_")
export const name = (server: string, tool: string) => `${namespace(server)}_${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const tools = yield* Tools.Service
    const events = yield* EventV2.Service
    const permission = yield* PermissionV2.Service
    const guardrail = yield* SessionGuardrail.Service
    const plugin = yield* PluginRuntime.Service
    const runtime = { job: yield* Job.Service, session: plugin.session }
    const scope = yield* Scope.Scope
    const lock = Semaphore.makeUnsafe(1)
    let current: Scope.Closeable | undefined

    // Register the current tool set under a fresh child scope, then close the previous one so the
    // registry never has a gap where MCP tools disappear mid-swap.
    const reconcile = lock.withPermit(
      Effect.gen(function* () {
        const groups = new Map<string, { tools: Record<string, Tool.AnyTool>; codemode: boolean }>()
        for (const tool of yield* mcp.tools()) {
          const group = groups.get(tool.server) ?? { tools: {}, codemode: tool.codemode !== false }
          const schema = (tool.inputSchema ?? {}) as JsonSchema.JsonSchema
          const backgroundable = /(^|[_-])(shell|bash|exec|execute|command|cmd|terminal|run|spawn|process)([_-]|$)/i.test(
            tool.name,
          )
          group.tools[tool.name] = Tool.withPermission(
            Tool.make({
              description: `${tool.description ?? ""}${
                backgroundable
                  ? " Background mode (background=true) returns immediately, notifies you on completion, and must not be polled."
                  : ""
              }`,
              jsonSchema: {
                ...schema,
                type: "object",
                properties: {
                  ...(typeof schema.properties === "object" && schema.properties ? schema.properties : {}),
                  ...(backgroundable
                    ? {
                        background: {
                          type: "boolean",
                          description:
                            "Run in the background and return immediately. You will be notified when it completes. Do not poll its progress.",
                        },
                      }
                    : {}),
                },
                additionalProperties: false,
              },
              outputSchema: tool.outputSchema as JsonSchema.JsonSchema | undefined,
              execute: (input, context) =>
                Effect.gen(function* () {
                  yield* permission.assert({
                    action: name(tool.server, tool.name),
                    resources: ["*"],
                    save: ["*"],
                    metadata: {},
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: {
                      type: "tool",
                      messageID: context.messageID,
                      callID: context.callID,
                    },
                  })
                  const requestedBackground = (input as Record<string, unknown> | undefined)?.background === true
                  const args = Object.fromEntries(
                    Object.entries((input ?? {}) as Record<string, unknown>).filter(([key]) => key !== "background"),
                  )
                  const reservation = backgroundable
                    ? yield* guardrail.assert({
                        sessionID: context.sessionID,
                        action: "mcp_execute",
                        resources: [`${tool.server}/${tool.name}`],
                        metadata: { arguments: Object.keys(args) },
                      })
                    : { release: Effect.void }
                  const resultRef = yield* Ref.make<MCP.ToolResult | undefined>(undefined)
                  const title = `${tool.name}${Object.keys(args).length ? ` (${Object.keys(args).join(", ")})` : ""}`
                  const job = yield* runtime.job
                    .start({
                      id: context.callID,
                      type: name(tool.server, tool.name),
                      title,
                      metadata: { sessionID: context.sessionID },
                      run: mcp
                        .callTool({ server: tool.server, name: tool.name, args })
                        .pipe(
                          Effect.tap((result) => Ref.set(resultRef, result)),
                          Effect.map((result) =>
                            result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
                          ),
                          Effect.catchTags({
                            "MCP.NotFoundError": (error) =>
                              new ToolFailure({ message: `MCP server "${error.server}" is not available` }),
                            "MCP.ToolCallError": (error) => new ToolFailure({ message: error.message }),
                          }),
                          Effect.ensuring(reservation.release),
                        ),
                    })
                    .pipe(Effect.onError(() => reservation.release))
                  const notifyWhenDone = Effect.fn("McpTool.notifyWhenDone")(function* () {
                    yield* runtime.job.wait({ id: context.callID }).pipe(
                      Effect.flatMap((result) => {
                        const state =
                          result.info?.status === "completed"
                            ? "completed"
                            : result.info?.status === "error"
                              ? "error"
                              : result.info?.status === "cancelled"
                                ? "cancelled"
                                : undefined
                        if (state === undefined) return Effect.void
                        const text =
                          state === "completed"
                            ? (result.info!.output ?? "")
                            : state === "error"
                              ? (result.info!.error ?? "MCP tool failed")
                              : "MCP tool cancelled"
                        return runtime.session.synthetic({
                          sessionID: context.sessionID,
                          text: `<mcp id="${context.callID}" state="${state}" tool="${name(tool.server, tool.name)}">\n${text}\n</mcp>`,
                          description: tool.name,
                          metadata: { source: "mcp", state },
                        })
                      }),
                      Effect.forkIn(scope, { startImmediately: true }),
                    )
                  })
                  if (requestedBackground) yield* runtime.job.background(job.id)
                  const blocked = requestedBackground
                    ? undefined
                    : yield* runtime.job.block({ id: job.id, sessionID: context.sessionID }).pipe(
                        Effect.onInterrupt(() => runtime.job.cancel(job.id).pipe(Effect.ignore)),
                      )
                  if (requestedBackground || blocked?.type === "backgrounded") {
                    yield* notifyWhenDone()
                    return {
                      structured: null,
                      content: [{ type: "text" as const, text: "The MCP tool was moved to the background." }],
                    }
                  }
                  if (blocked?.info.status === "error")
                    return yield* new ToolFailure({ message: blocked.info.error ?? "MCP tool failed" })
                  if (blocked?.info.status === "cancelled") return yield* new ToolFailure({ message: "MCP tool cancelled" })
                  const result = yield* Ref.get(resultRef)
                  if (!result) return yield* new ToolFailure({ message: "MCP tool completed without a result" })
                  if (result.isError)
                    return yield* new ToolFailure({
                      message:
                        result.content
                          .flatMap((part) => (part.type === "text" ? [part.text] : []))
                          .join("\n")
                          .trim() || "MCP tool returned an error",
                    })
                  const content = result.content.map((part) =>
                    part.type === "text"
                      ? { type: "text" as const, text: part.text }
                      : { type: "file" as const, data: part.data, mime: part.mimeType },
                  )
                  const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
                  return {
                    structured: result.structured ?? (text === "" ? null : text),
                    content,
                  }
                }).pipe(
                  Effect.mapError((error) =>
                    error instanceof ToolFailure
                      ? error
                      : new ToolFailure({ message: `Unable to execute ${name(tool.server, tool.name)}` }),
                  ),
                ),
            }),
            name(tool.server, tool.name),
          )
          groups.set(tool.server, group)
        }
        const next = yield* Scope.fork(scope)
        yield* Effect.forEach(
          groups,
          ([server, group]) => tools.register(group.tools, { namespace: namespace(server), codemode: group.codemode }),
          {
            discard: true,
          },
        ).pipe(Scope.provide(next), Effect.orDie)
        if (current) yield* Scope.close(current, Exit.void)
        current = next
      }),
    )

    yield* reconcile.pipe(Effect.forkScoped)
    yield* events.subscribe(McpEvent.ToolsChanged).pipe(
      Stream.runForEach(() => reconcile),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
)

export const node = makeLocationNode({
  name: "mcp-tools",
  layer,
  deps: [
    ToolRegistry.toolsNode,
    MCP.node,
    EventV2.node,
    Job.node,
    PermissionV2.node,
    SessionGuardrail.node,
    PluginRuntime.node,
  ],
})
