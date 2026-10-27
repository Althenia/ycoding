import { describe, expect } from "bun:test"
import { Tool } from "@ycoding-ai/core/tool/tool"
import { Agent } from "@ycoding-ai/core/agent"
import type { Permission } from "@ycoding-ai/core/permission"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Image } from "@ycoding-ai/core/image"
import { Session } from "@ycoding-ai/core/session"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionContext } from "@ycoding-ai/core/session/context"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { ToolHooks } from "@ycoding-ai/core/tool/hooks"
import type { ConfigCapabilities } from "@ycoding-ai/core/config/capabilities"
import { executeTool, settleTool, toolDefinitions } from "./lib/tool"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, SchemaGetter, SchemaIssue, Scope } from "effect"
import { testEffect } from "./lib/effect"

const bounds: ToolOutputStore.BoundInput[] = []
const retentionFailure = new ToolOutputStore.StorageError({ operation: "write", cause: new Error("disk full") })
const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => {
    if (input.callID === "call-retention-failure") return Effect.fail(retentionFailure)
    return Effect.sync(() => bounds.push(input)).pipe(
      Effect.as(
        input.callID === "call-bounded"
          ? {
              output: { structured: {}, content: [{ type: "text" as const, text: "bounded reference" }] },
              outputPaths: ["/managed/generic"],
            }
          : { output: input.output, outputPaths: [] },
      ),
    )
  },
})
const imageStore = Layer.mock(Image.Service, {
  normalize: (resource, content) => {
    if (resource === "corrupt.png") return Effect.fail(new Image.DecodeError({ resource }))
    if (resource === "too-large.png")
      return Effect.fail(
        new Image.SizeError({
          resource,
          width: 9_000,
          height: 9_000,
          bytes: content.content.length,
          maxWidth: 2_000,
          maxHeight: 2_000,
          maxBytes: 5,
        }),
      )
    return Effect.succeed({ ...content, content: "bm9ybWFsaXplZA==", mime: "image/jpeg" })
  },
})
const registryLayer = AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolHooks.node]), [
  [ToolOutputStore.node, outputStore],
  [Image.node, imageStore],
])
const it = testEffect(registryLayer)
const identity = {
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_registry"),
}
const sessionID = Session.ID.make("ses_registry")
const call = (name: string, id = `call-${name}`): ToolRegistry.ExecuteInput => ({
  sessionID,
  ...identity,
  call: { type: "tool-call", id, name, input: { text: name } },
})

const make = (permission?: string) => {
  const tool = Tool.make({
    description: "Echo text",
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: ({ text }) => Effect.succeed({ text }),
    toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
  })
  return permission ? Tool.withPermission(tool, permission) : tool
}

const constant = (text: string) =>
  Tool.make({
    description: "Return text",
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: () => Effect.succeed({ text }),
    toModelOutput: ({ output }) => [{ type: "text" as const, text: output.text }],
  })

describe("ToolRegistry", () => {
  it.effect("derives stable invocation identity from the complete outer identity", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const seen: string[] = []
      yield* service.register({
        echo: Tool.make({
          description: "echo",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: (_, context) =>
            Effect.sync(() => {
              if (context.invocationID) seen.push(context.invocationID)
              return {}
            }),
        }),
      })
      const request = yield* service.materialize()
      const input = {
        ...call("execute"),
        call: {
          type: "tool-call" as const,
          id: "stable",
          name: "execute",
          input: { code: "return await tools.echo({})" },
        },
      }
      yield* request.settle(input)
      yield* request.settle(input)
      yield* request.settle({ ...input, messageID: SessionMessage.ID.make("msg_other") })
      yield* request.settle({ ...input, sessionID: Session.ID.make("ses_other") })
      expect(seen).toHaveLength(4)
      expect(seen[0]).toBe(seen[1])
      expect(new Set([seen[0], seen[2], seen[3]]).size).toBe(3)
    }),
  )
  it.effect("distinguishes global discovery from a tool named search", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ search: make() })
      const result = yield* settleTool(service, {
        ...call("execute"),
        call: {
          type: "tool-call",
          id: "both-searches",
          name: "execute",
          input: { code: 'await search({query:"search"}); return await tools.search({text:"found"})' },
        },
      })
      expect(result.output?.structured).toEqual({
        toolCalls: [
          { tool: "search", status: "completed", input: { query: "search" } },
          {
            tool: "search",
            name: "search",
            id: expect.any(String),
            index: 0,
            input: { text: "found" },
            status: "completed",
            structured: { text: "found" },
          },
        ],
      })
    }),
  )
  it.effect("retains successful receipts when a later leaf fails", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({
        echo: make(),
        fail: Tool.make({
          description: "fail",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.fail(new Tool.Failure({ message: "refused" })),
        }),
      })
      const result = yield* settleTool(service, {
        ...call("execute"),
        call: {
          type: "tool-call",
          id: "later-error",
          name: "execute",
          input: { code: 'await tools.echo({text:"saved"}); return await tools.fail({})' },
        },
      })
      expect(result.output?.structured).toMatchObject({
        error: true,
        toolCalls: [
          { id: expect.any(String), name: "echo", status: "completed", structured: { text: "saved" } },
          { id: expect.any(String), name: "fail", status: "error" },
        ],
      })
      expect(result.result).toMatchObject({ type: "text", value: expect.not.stringContaining("saved") })
    }),
  )
  it.effect("publishes nested receipts before subsequent calls without exposing intermediate output to the model", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const contexts: Tool.Context[] = []
      const progress: ToolRegistry.Progress[] = []
      yield* service.register({
        echo: Tool.make({
          description: "echo",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          execute: (input, context) =>
            Effect.gen(function* () {
              contexts.push(context)
              yield* context.progress({ structured: { intermediate: "ignored" } })
              return input
            }),
        }),
      })
      const result = yield* settleTool(service, {
        ...call("execute"),
        call: {
          type: "tool-call",
          id: "receipt",
          name: "execute",
          input: { code: 'await tools.echo({text:"private"}); await tools.echo({text:"second"}); return "aggregate"' },
        },
        progress: (update) =>
          Effect.sync(() => {
            progress.push(update)
          }),
      })
      expect(contexts.map((item) => item.callID)).toEqual(["receipt", "receipt"])
      expect(contexts[0]?.invocationID).toEqual(expect.any(String))
      expect(contexts[0]?.invocationID).not.toBe(contexts[1]?.invocationID)
      expect(progress.some((item) => JSON.stringify(item.structured).includes('"structured":{"text":"private"}'))).toBe(
        true,
      )
      expect(progress.every((item) => !JSON.stringify(item.structured).includes('"intermediate"'))).toBe(true)
      expect(result.result).toEqual({ type: "text", value: "aggregate" })
      expect(result.output?.structured).toMatchObject({
        toolCalls: [
          { id: contexts[0]?.invocationID, name: "echo", input: { text: "private" }, structured: { text: "private" } },
          { id: contexts[1]?.invocationID, name: "echo", input: { text: "second" }, structured: { text: "second" } },
        ],
      })
    }),
  )
  it.effect("interrupts a nested before hook without invoking the leaf", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const hooks = yield* ToolHooks.Service
      const started = yield* Deferred.make<void>()
      let executed = false
      yield* hooks.hook.before((event) =>
        event.tool === "echo" ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)) : Effect.void,
      )
      yield* service.register({
        echo: Tool.make({
          description: "echo",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Effect.sync(() => {
              executed = true
              return {}
            }),
        }),
      })
      const fiber = yield* settleTool(service, {
        ...call("execute"),
        call: {
          type: "tool-call",
          id: "hook-interrupt",
          name: "execute",
          input: { code: "return await tools.echo({})" },
        },
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      expect(executed).toBe(false)
    }),
  )

  it.effect("preserves the full validated output in completed edit receipts", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({
        edit: Tool.make({
          description: "edit",
          input: Schema.Struct({}),
          output: Schema.Struct({
            files: Schema.Array(
              Schema.Struct({ file: Schema.String, patch: Schema.String, status: Schema.String, extra: Schema.String }),
            ),
          }),
          execute: () =>
            Effect.succeed({ files: [{ file: "example.txt", patch: "+x", status: "updated", extra: "private" }] }),
        }),
      })
      const result = yield* settleTool(service, {
        ...call("execute"),
        call: {
          type: "tool-call",
          id: "edit",
          name: "execute",
          input: { code: 'await search({query:"edit"}); return await tools.edit({})' },
        },
      })
      expect(result.output?.structured).toEqual({
        toolCalls: [
          { tool: "search", status: "completed", input: { query: "edit" } },
          {
            tool: "edit",
            name: "edit",
            id: expect.any(String),
            index: 0,
            input: {},
            status: "completed",
            structured: { files: [{ file: "example.txt", patch: "+x", status: "updated", extra: "private" }] },
          },
        ],
      })
    }),
  )
  it.effect("rejects more than one thousand nested calls by default", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo: make() })
      const result = yield* settleTool(service, {
        ...call("execute"),
        call: {
          type: "tool-call",
          id: "limit",
          name: "execute",
          input: { code: 'for (let i = 0; i < 1001; i++) { await tools.echo({text:"x"}) } return "done"' },
        },
      })
      expect(result.result).toMatchObject({ type: "text", value: expect.stringContaining("tool-call limit of 1000") })
      expect(result.output?.structured).toMatchObject({ error: true })
    }),
  )
  it.effect("bounds the execute result to the default output budget", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo: make() })
      const result = yield* settleTool(service, {
        ...call("execute"),
        call: { type: "tool-call", id: "output-limit", name: "execute", input: { code: 'return "x".repeat(1048577)' } },
      })
      expect(result.result).toMatchObject({ type: "text", value: expect.stringContaining("result truncated") })
    }),
  )
  it.effect("exposes direct registrations through execute as well", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo: make() }, { codemode: false })
      const request = yield* service.materialize()
      expect(request.definitions.map((item) => item.name)).toEqual(["echo", "execute"])
      expect((yield* request.settle(call("echo"))).result).toEqual({ type: "text", value: "echo" })
      const nested = yield* request.settle({
        ...call("execute"),
        call: {
          type: "tool-call",
          id: "dual",
          name: "execute",
          input: { code: 'return await tools.echo({text:"nested"})' },
        },
      })
      expect(nested.result).toMatchObject({ type: "text", value: expect.stringContaining("nested") })
    }),
  )

  it.effect("does not invoke the leaf after a nested before-hook defect", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const hooks = yield* ToolHooks.Service
      let executed = false
      let hookInvoked = false
      yield* hooks.hook.before((event) => {
        if (event.tool === "echo") {
          hookInvoked = true
          return Effect.die("private hook failure")
        }
      })
      yield* service.register({
        echo: Tool.make({
          description: "echo",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Effect.sync(() => {
              executed = true
              return {}
            }),
        }),
      })
      const result = yield* settleTool(service, {
        ...call("execute"),
        call: { type: "tool-call", id: "hook-defect", name: "execute", input: { code: "return await tools.echo({})" } },
      })
      expect(hookInvoked).toBe(true)
      expect(executed).toBe(false)
      expect(result.output?.structured).toMatchObject({ error: true })
      expect(JSON.stringify(result.result)).not.toContain("private hook failure")
    }),
  )
  it.effect("runs nested hooks around the leaf and applies input mutation", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const hooks = yield* ToolHooks.Service
      const events: string[] = []
      yield* hooks.hook.before((event) => {
        events.push(`before:${event.tool}`)
        if (event.tool === "demo_echo" && typeof event.input === "object" && event.input !== null)
          Object.assign(event.input, { text: "changed" })
      })
      yield* hooks.hook.after((event) => {
        events.push(`after:${event.tool}:${event.result.type === "text" ? event.result.value : ""}`)
      })
      yield* service.register({ echo: make() }, { namespace: "demo" })
      const result = yield* settleTool(service, {
        ...call("execute"),
        call: {
          type: "tool-call",
          id: "nested",
          name: "execute",
          input: { code: 'return await tools.demo.echo({text:"nested"})' },
        },
      })
      expect(result.result).toMatchObject({ type: "text", value: expect.stringContaining("changed") })
      expect(result.output?.structured).toMatchObject({
        toolCalls: [{ input: { text: "nested" }, structured: { text: "changed" } }],
      })
      expect(events).toEqual([
        "before:execute",
        "before:demo_echo",
        "after:demo_echo:changed",
        'after:execute:{\n  "text": "changed"\n}',
      ])
    }),
  )
  it.effect("captures request-local tools without exposing them to another request", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const first = yield* service.materialize([], {}, [
        { tools: { connector: constant("profile-a") }, options: { codemode: false } },
      ])
      const second = yield* service.materialize([], {}, [
        { tools: { connector: constant("profile-b") }, options: { codemode: false } },
      ])
      expect(first.definitions.map((tool) => tool.name)).toEqual(["connector", "execute"])
      expect((yield* first.settle(call("connector"))).result).toEqual({ type: "text", value: "profile-a" })
      expect((yield* second.settle(call("connector"))).result).toEqual({ type: "text", value: "profile-b" })
      expect((yield* service.materialize()).definitions).toEqual([])
    }),
  )

  it.effect("applies permissions and capabilities to request-local CodeMode tools", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const registrations = [{ tools: { echo: make() }, options: { namespace: "chatgpt_mail" } }]
      expect(
        (yield* service.materialize(
          [{ action: "chatgpt_mail_echo", resource: "*", effect: "deny" }],
          {},
          registrations,
        )).definitions,
      ).toEqual([])
      expect(
        (yield* service.materialize([], { tools: { deny: ["chatgpt_mail_echo"] } }, registrations)).definitions,
      ).toEqual([])
      const request = yield* service.materialize([], {}, registrations)
      const result = yield* request.settle({
        ...call("execute"),
        call: {
          type: "tool-call",
          id: "call-local",
          name: "execute",
          input: { code: 'return await tools.chatgpt_mail.echo({ text: "isolated" })' },
        },
      })
      expect(JSON.stringify(result.result)).toContain("isolated")
      expect((yield* service.available()).size).toBe(0)
    }),
  )

  it.effect("rejects invalid dotted namespaces", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const error = yield* service.register({ echo: make() }, { namespace: "slack..admin" }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(Tool.RegistrationError)
      expect(error.message).toBe('Invalid tool namespace: "slack..admin"')
      expect((yield* service.materialize()).definitions).toEqual([])
    }),
  )

  it.effect("validates a registration batch before installing any tools", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const error = yield* service
        .registerBatch([
          { tools: { first: make() }, options: { codemode: false } },
          { tools: { second: make() }, options: { namespace: "invalid..namespace", codemode: false } },
        ])
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(Tool.RegistrationError)
      expect((yield* service.materialize()).definitions).toEqual([])
    }),
  )

  it.effect("materializes definitions in lexical order regardless of registration order", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ zeta: make(), alpha: make(), middle: make() }, { codemode: false })

      expect((yield* toolDefinitions(service)).map((tool) => tool.name)).toEqual(["alpha", "middle", "zeta", "execute"])
    }),
  )

  it.effect("filters disabled tools with edit aliases and ordered wildcard precedence", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register(
        {
          question: make(),
          bash: make(),
          edit: make("edit"),
          write: make("edit"),
        },
        { codemode: false },
      )
      const names = (permissions: Permission.Ruleset) =>
        toolDefinitions(service, permissions).pipe(Effect.map((definitions) => definitions.map((tool) => tool.name)))

      expect(yield* names([{ action: "question", resource: "*", effect: "deny" }])).toEqual([
        "bash",
        "edit",
        "write",
        "execute",
      ])
      expect(
        yield* names([
          { action: "*", resource: "*", effect: "deny" },
          { action: "question", resource: "private", effect: "allow" },
        ]),
      ).toEqual(["question"])
      expect(
        yield* names([
          { action: "question", resource: "private", effect: "allow" },
          { action: "*", resource: "*", effect: "deny" },
        ]),
      ).toEqual([])
      expect(yield* names([{ action: "edit", resource: "*", effect: "deny" }])).toEqual(["bash", "question", "execute"])
    }),
  )

  it.effect("materializes registered subagent tools except denied capabilities", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register(
        {
          shell: make(),
          read: make(),
          edit: make(),
          subagent: make(),
          subagent_control: make(),
        },
        { codemode: false },
      )
      const permissions = SessionContext.toolPermissions(
        {
          mode: "subagent",
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
        },
        [{ action: "edit", resource: "*", effect: "deny" }],
      )

      expect((yield* service.materialize(permissions)).definitions.map((tool) => tool.name)).toEqual([
        "read",
        "shell",
        "execute",
      ])
    }),
  )

  it.effect("hides tools excluded by capability toggles from direct and CodeMode catalogs", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register(
        { read: make(), shell: make(), skill: make(), project_artifact: make() },
        { codemode: false },
      )
      yield* service.register({ search: make(), fetch: make() }, { namespace: "web" })
      const visible = (capabilities: ConfigCapabilities.Resolved) =>
        Effect.gen(function* () {
          const materialized = yield* service.materialize([], capabilities)
          return {
            direct: materialized.definitions.map((tool) => tool.name),
            available: [...(yield* service.available([], capabilities))].toSorted(),
          }
        })

      expect(yield* visible({})).toEqual({
        direct: ["project_artifact", "read", "shell", "skill", "execute"],
        available: ["project_artifact", "read", "shell", "skill", "web_fetch", "web_search"],
      })
      expect(yield* visible({ tools: { deny: ["shell", "web_*"] } })).toEqual({
        direct: ["project_artifact", "read", "skill", "execute"],
        available: ["project_artifact", "read", "skill"],
      })
      expect(yield* visible({ tools: { allow: ["read", "web_search"] } })).toEqual({
        direct: ["read", "execute"],
        available: ["read", "web_search"],
      })
      expect(yield* visible({ tools: { deny: ["execute"] } })).toEqual({
        direct: ["project_artifact", "read", "shell", "skill"],
        available: ["project_artifact", "read", "shell", "skill"],
      })
      expect(yield* visible({ tools: { enabled: false } })).toEqual({ direct: [], available: [] })
      expect(yield* visible({ skills: { enabled: false }, project_artifacts: false })).toEqual({
        direct: ["read", "shell", "execute"],
        available: ["read", "shell", "web_fetch", "web_search"],
      })
      const settled = yield* (yield* service.materialize([], { tools: { deny: ["shell"] } })).settle(call("shell"))
      expect(settled.error?.type).toBe("tool.unknown")
    }),
  )

  it.effect("keeps permission decoration isolated between registrations", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const shared = make()
      yield* service.register({ first: shared }, { codemode: false })
      yield* service.register({ second: Tool.withPermission(shared, "edit") }, { codemode: false })
      Tool.withPermission(shared, "question")

      expect(
        (yield* toolDefinitions(service, [{ action: "edit", resource: "*", effect: "deny" }])).map(
          (definition) => definition.name,
        ),
      ).toEqual(["first", "execute"])
    }),
  )

  it.effect("removes a scoped registration", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      yield* service.register({ echo: make() }, { codemode: false }).pipe(Scope.provide(scope))
      expect((yield* toolDefinitions(service)).map((tool) => tool.name)).toEqual(["echo", "execute"])
      yield* Scope.close(scope, Exit.void)
      expect(yield* toolDefinitions(service)).toEqual([])
    }),
  )

  it.effect("preserves an interrupted registration until its scope closes", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      const registered = yield* Deferred.make<void>()
      const fiber = yield* service
        .register({ echo: make() }, { codemode: false })
        .pipe(
          Effect.andThen(Deferred.succeed(registered, undefined)),
          Effect.andThen(Effect.never),
          Scope.provide(scope),
          Effect.forkChild,
        )
      yield* Deferred.await(registered)
      yield* Fiber.interrupt(fiber)

      expect((yield* toolDefinitions(service)).map((tool) => tool.name)).toEqual(["echo", "execute"])
      yield* Scope.close(scope, Exit.void)
      expect(yield* toolDefinitions(service)).toEqual([])
    }),
  )

  it.effect("returns model errors without swallowing interruption or defects", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register(
        {
          failed: Tool.make({
            description: "Failed",
            input: Schema.Struct({}),
            output: Schema.Struct({ ok: Schema.Boolean }),
            execute: () => Effect.fail(new Tool.Failure({ message: "Denied" })),
          }),
        },
        { codemode: false },
      )
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "failed", name: "failed", input: {} },
        }),
      ).toEqual({ type: "error", value: "Denied" })
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "missing", name: "missing", input: {} },
        }),
      ).toEqual({ type: "error", value: "Unknown tool: missing" })

      yield* service.register(
        {
          defect: Tool.make({
            description: "Defect",
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            execute: () => Effect.die("unexpected executor defect"),
          }),
        },
        { codemode: false },
      )
      expect(
        yield* service.materialize().pipe(
          Effect.flatMap((materialized) =>
            materialized.settle({
              sessionID,
              ...identity,
              call: { type: "tool-call", id: "defect", name: "defect", input: {} },
            }),
          ),
          Effect.catchDefect(Effect.succeed),
        ),
      ).toBe("unexpected executor defect")
    }),
  )

  it.effect("propagates retention failures through settlement", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo: make() }, { codemode: false })
      const materialized = yield* service.materialize()
      const exit = yield* materialized.settle(call("echo", "call-retention-failure")).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe(retentionFailure)
      expect(retentionFailure.message).toBe("Failed to write tool output: disk full")
    }),
  )

  it.effect("passes complete invocation identity to the canonical handler", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const contexts: Tool.Context[] = []
      yield* service.register(
        {
          context: Tool.make({
            description: "Context",
            input: Schema.Struct({}),
            output: Schema.Struct({ ok: Schema.Boolean }),
            execute: (_, context) => Effect.sync(() => contexts.push(context)).pipe(Effect.as({ ok: true })),
          }),
        },
        { codemode: false },
      )
      yield* executeTool(service, {
        sessionID,
        ...identity,
        call: { type: "tool-call", id: "call-context", name: "context", input: {} },
      })
      expect(contexts).toEqual([{ sessionID, ...identity, callID: "call-context", progress: expect.any(Function) }])
    }),
  )

  it.effect("encodes output and applies generic settlement bounding", () =>
    Effect.gen(function* () {
      bounds.length = 0
      const service = yield* ToolRegistry.Service
      yield* service.register({ bounded: make() }, { codemode: false })
      expect(
        yield* settleTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "call-bounded", name: "bounded", input: { text: "complete" } },
        }),
      ).toEqual({
        result: { type: "text", value: "bounded reference" },
        output: { structured: {}, content: [{ type: "text", text: "bounded reference" }] },
        outputPaths: ["/managed/generic"],
      })
      expect(bounds).toHaveLength(1)
    }),
  )

  it.effect("normalizes image tool output at settlement and drops unresizable images", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register(
        {
          snapshot: Tool.make({
            description: "Return images",
            input: Schema.Struct({ text: Schema.String }),
            output: Schema.Struct({ text: Schema.String }),
            execute: ({ text }) => Effect.succeed({ text }),
            toModelOutput: ({ output }) => [
              { type: "file", data: "aW1hZ2U=", mime: "image/png", name: "frame.png" },
              { type: "file", data: "aW1hZ2U=", mime: "image/png", name: "too-large.png" },
              { type: "file", data: "aW1hZ2U=", mime: "image/png", name: "corrupt.png" },
              { type: "text", text: output.text },
            ],
          }),
        },
        { codemode: false },
      )

      const settlement = yield* settleTool(service, call("snapshot"))
      expect(settlement.output?.content).toEqual([
        { type: "file", uri: "data:image/jpeg;base64,bm9ybWFsaXplZA==", mime: "image/jpeg", name: "frame.png" },
        { type: "text", text: "snapshot" },
        { type: "text", text: "[1 image omitted: could not be decoded.]" },
        { type: "text", text: "[1 image omitted: could not be resized below the image size limit.]" },
      ])
    }),
  )

  it.effect("normalizes image progress content before it is published", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register(
        {
          progressive: Tool.make({
            description: "Emit image progress",
            input: Schema.Struct({ text: Schema.String }),
            output: Schema.Struct({ text: Schema.String }),
            execute: ({ text }, context) =>
              context
                .progress({
                  structured: { stage: "capture" },
                  content: [
                    { type: "file", data: "aW1hZ2U=", mime: "image/png", name: "frame.png" },
                    { type: "file", data: "aW1hZ2U=", mime: "image/png", name: "too-large.png" },
                  ],
                })
                .pipe(Effect.as({ text })),
          }),
        },
        { codemode: false },
      )

      const updates: ToolRegistry.Progress[] = []
      yield* settleTool(service, {
        ...call("progressive"),
        progress: (update) =>
          Effect.sync(() => {
            updates.push(update)
          }),
      })
      expect(updates).toEqual([
        {
          structured: { stage: "capture" },
          content: [
            { type: "file", uri: "data:image/jpeg;base64,bm9ybWFsaXplZA==", mime: "image/jpeg", name: "frame.png" },
            { type: "text", text: "[1 image omitted: could not be resized below the image size limit.]" },
          ],
        },
      ])
    }),
  )

  it.effect("enforces transformed codecs at execution and projection boundaries", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const executed: string[] = []
      const Transformed = Schema.Boolean.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transform((value) => (value ? "yes" : "no")),
          encode: SchemaGetter.transform((value) => value === "yes"),
        }),
      )
      yield* service.register(
        {
          transformed: Tool.make({
            description: "Transform values",
            input: Schema.Struct({ value: Transformed }),
            output: Schema.Struct({ value: Transformed }),
            execute: ({ value }) => Effect.sync(() => executed.push(value)).pipe(Effect.as({ value })),
            toModelOutput: ({ output }) => [{ type: "text", text: String(output.value) }],
          }),
        },
        { codemode: false },
      )

      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "transformed", name: "transformed", input: { value: true } },
        }),
      ).toEqual({ type: "text", value: "true" })
      expect(executed).toEqual(["yes"])
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "invalid-input", name: "transformed", input: { value: "yes" } },
        }),
      ).toMatchObject({ type: "error", value: expect.stringContaining("Invalid tool input") })
      expect(executed).toEqual(["yes"])

      yield* service.register(
        {
          invalid_output: Tool.make({
            description: "Return invalid output",
            input: Schema.Struct({}),
            output: Schema.Struct({
              value: Schema.Boolean.pipe(
                Schema.decodeTo(Schema.String, {
                  decode: SchemaGetter.transform((value) => String(value)),
                  encode: SchemaGetter.transformOrFail((value) =>
                    value === "valid"
                      ? Effect.succeed(true)
                      : Effect.fail(new SchemaIssue.InvalidValue(Option.some(value), { message: "invalid output" })),
                  ),
                }),
              ),
            }),
            execute: () => Effect.succeed({ value: "invalid" }),
          }),
        },
        { codemode: false },
      )
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "invalid-output", name: "invalid_output", input: {} },
        }),
      ).toMatchObject({ type: "error", value: expect.stringContaining("invalid value for its output schema") })
    }),
  )

  it.effect("executes the tool advertised in a model request", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      yield* service.register({ echo: constant("advertised") }, { codemode: false }).pipe(Scope.provide(scope))
      const request = yield* service.materialize()
      yield* Scope.close(scope, Exit.void)
      yield* service.register({ echo: constant("replacement") }, { codemode: false })

      expect((yield* request.settle(call("echo"))).result).toEqual({ type: "text", value: "advertised" })
      expect(yield* executeTool(service, call("echo"))).toEqual({ type: "text", value: "replacement" })
    }),
  )

  it.effect("reveals the previous registration after an overlay closes", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ echo: constant("base") }, { codemode: false })
      const overlay = yield* Scope.make()
      yield* service.register({ echo: constant("overlay") }, { codemode: false }).pipe(Scope.provide(overlay))

      expect(yield* executeTool(service, call("echo"))).toEqual({ type: "text", value: "overlay" })
      yield* Scope.close(overlay, Exit.void)
      expect(yield* executeTool(service, call("echo"))).toEqual({ type: "text", value: "base" })
    }),
  )

  it.effect("executes codemode tools advertised in a model request", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const executed: string[] = []
      const scope = yield* Scope.make()
      yield* service
        .register({
          echo: Tool.make({
            description: "Echo text",
            input: Schema.Struct({ text: Schema.String }),
            output: Schema.Struct({ text: Schema.String }),
            execute: ({ text }) => Effect.sync(() => executed.push(`old:${text}`)).pipe(Effect.as({ text })),
          }),
        })
        .pipe(Scope.provide(scope))
      const materialized = yield* service.materialize()
      yield* Scope.close(scope, Exit.void)
      yield* service.register({
        echo: Tool.make({
          description: "Echo text",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          execute: ({ text }) => Effect.sync(() => executed.push(`new:${text}`)).pipe(Effect.as({ text })),
        }),
      })

      const settlement = yield* materialized.settle({
        ...call("execute"),
        call: {
          type: "tool-call",
          id: "call-execute",
          name: "execute",
          input: { code: 'return await tools.echo({ text: "request" })' },
        },
      })

      expect(settlement.result).toMatchObject({ type: "text" })
      expect(executed).toEqual(["old:request"])
    }),
  )
})
