import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Cause, Effect, Exit, Schema, Stream } from "effect"
import { Codec } from "../src/plugin-host/codec"
import { PluginHost } from "../src/plugin-host/host"
import { PluginLoader } from "../src/plugin-host/loader"

const root = path.resolve(import.meta.dir, "../../..")
const proto = path.join(root, "protocol/ycoding/extension/v5/extension.proto")
const fixtures = path.join(import.meta.dir, "fixtures/plugin-host")
let sdkCache = ""

beforeAll(async () => {
  sdkCache = await mkdtemp(path.join(tmpdir(), "plugin-host-shared-"))
  await PluginLoader.load({ target: path.join(fixtures, "promise-plugin.ts"), options: {}, cache: sdkCache })
}, 30_000)

afterAll(async () => {
  await rm(sdkCache, { recursive: true, force: true })
})

type Frame = Record<string, unknown>
type Progress = { readonly structured: Record<string, unknown> }
type ToolInput = Record<string, unknown>
type FixtureTool = {
  readonly name: string
  readonly description: string
  readonly jsonSchema: Record<string, unknown>
  readonly execute: (
    input: ToolInput,
    context: { readonly progress: (update: Progress) => Promise<void> },
  ) => Promise<unknown>
}
type HookEvent = { input: unknown; readonly sessionID: string; system: Array<{ text: string }> }
type FixtureContext = {
  readonly options: unknown
  readonly tool: {
    readonly transform: (callback: (draft: { add: (tool: FixtureTool) => void }) => void) => Promise<unknown>
    readonly hook: (name: string, callback: (event: HookEvent) => void) => Promise<unknown>
  }
  readonly session: {
    readonly get: (input: { sessionID: string }) => Promise<unknown>
    readonly hook: (name: string, callback: (event: HookEvent) => void) => Promise<unknown>
  }
  readonly mcp: { readonly servers: () => Promise<unknown> }
  readonly aisdk: { readonly hook: (name: string, callback: (event: SdkEvent) => void) => Promise<unknown> }
}
type StreamOptions = { readonly abortSignal: AbortSignal; readonly prompt?: unknown }
type SdkEvent = {
  readonly package: string
  readonly model: { readonly id: string }
  sdk?: {
    readonly languageModel: (id: string) => {
      readonly doStream: (options: StreamOptions) => Promise<{ stream: ReadableStream<unknown> }>
    }
  }
}
type FixturePlugin = { readonly id: string; readonly setup: (context: FixtureContext) => Promise<unknown> }
type HeldOperation = (input?: unknown) => Promise<unknown>
type HeldIntegrationContext = {
  readonly integration: {
    readonly connect: { readonly key: HeldOperation }
    readonly oauth: Record<"connect" | "status" | "complete" | "cancel", HeldOperation>
    readonly command: Record<"connect" | "status" | "cancel", HeldOperation>
    readonly connection: { readonly resolve: HeldOperation }
    readonly transform: HeldOperation
    readonly reload: HeldOperation
  }
}
type HeldEffectContext = {
  readonly integration: {
    readonly transform: (callback: () => void) => Effect.Effect<unknown>
    readonly connection: { readonly resolve: (connection: { type: "env"; name: string }) => Effect.Effect<unknown> }
  }
}

function at(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>(
    (current, key) => (current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined),
    value,
  )
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected a list")
  return value
}

function channel(admit = true) {
  const queue: Uint8Array[] = []
  const waiting: Array<(chunk: IteratorResult<Uint8Array>) => void> = []
  let closed = false
  const input: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const chunk = queue.shift()
        if (chunk) return Promise.resolve({ value: chunk, done: false })
        if (closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => waiting.push(resolve))
      },
    }),
  }
  const deliver = (body: Record<string, unknown>, generation = "ext_test") => {
    const bytes = Codec.frame(Codec.encode("HostFrame", { generation, ...body }))
    const resolve = waiting.shift()
    if (resolve) resolve({ value: bytes, done: false })
    else queue.push(bytes)
  }
  const frames: Frame[] = []
  const observers: Array<() => void> = []
  const reader = new Codec.FrameReader()
  return {
    input,
    send(body: Record<string, unknown>, generation = "ext_test") {
      deliver(body, generation)
      if (body.language_attempt)
        deliver({ language_credit: { request: at(body.language_attempt, "request") } }, generation)
    },
    close() {
      closed = true
      waiting.splice(0).forEach((resolve) => resolve({ value: undefined, done: true }))
    },
    write: async (bytes: Uint8Array) => {
      reader.push(bytes).forEach((payload) => {
        const frame = Codec.decode("ChildFrame", payload)
        frames.push(frame)
        if (admit && frame.declared) deliver({ setup: {} })
        if (frame.language_parts && list(at(frame, "language_parts", "parts")).length > 0)
          deliver({ language_credit: { request: at(frame, "language_parts", "request") } })
      })
      observers.splice(0).forEach((observe) => observe())
    },
    frames,
    async next(key: string, from = 0): Promise<unknown> {
      for (;;) {
        const found = frames.slice(from).find((frame) => key in frame)
        if (found) return found[key]
        await new Promise<void>((resolve) => observers.push(resolve))
      }
    },
  }
}

const call = (invocation: number) => ({
  invocation,
  session_id: "ses_fixture",
  message_id: "msg_fixture",
  call_id: Codec.text("call_fixture"),
  agent: "build",
})

function hello(target: string, options: Record<string, unknown>, modelPackage = false) {
  return {
    hello: {
      revision: 5,
      identity: "plugin.fixture",
      generation: "ext_test",
      grants: [],
      registration_order: 0,
      plugin: {
        target: Codec.text(target),
        options: Codec.value(options),
        cache: Codec.text(sdkCache),
        model_package: modelPackage,
      },
    },
  }
}

function start(plugin: unknown, options: Record<string, unknown> = {}) {
  const io = channel()
  const exit = PluginHost.serve({ input: io.input, write: io.write }, async () => plugin)
  io.send(hello("/fixture/plugin.ts", options))
  return { io, exit }
}

function startHeld(plugin: unknown, events: string[]) {
  const io = channel(false)
  const exit = PluginHost.serve({ input: io.input, write: io.write }, async () => {
    events.push("load")
    return plugin
  })
  io.send(hello("/fixture/plugin.ts", {}))
  return { io, exit }
}

async function declaration(io: ReturnType<typeof channel>) {
  await Promise.race([io.next("declared"), io.next("register_tools")])
  return io.frames.find((frame) => "declared" in frame || "register_tools" in frame)
}

function startTarget(target: string, options: Record<string, unknown>) {
  const io = channel()
  const exit = PluginHost.serve({ input: io.input, write: io.write }, PluginLoader.load)
  io.send(hello(target, options))
  return { io, exit }
}

async function stop(io: ReturnType<typeof channel>, exit: Promise<number>) {
  io.send({ shutdown: {} })
  await io.next("stopped")
  io.close()
  expect(await exit).toBe(0)
}

function execute(invocation: number, tool: string, input: unknown, namespace = "") {
  return { execute: { call: call(invocation), namespace, tool, input: Codec.value(input) } }
}

describe("plugin host channel codec", () => {
  test("message table matches the Core-owned extension descriptor", async () => {
    const declared = parseProto(await Bun.file(proto).text())
    expect(Object.keys(Codec.messages).sort()).toEqual(Object.keys(declared).sort())
    for (const [name, fields] of Object.entries(declared))
      expect(Codec.messages[name]?.map((field) => [field.tag, field.name, field.type, field.label])).toEqual(fields)
  })

  test("integration metadata reads take the next free HostCall and PluginCall tags", async () => {
    const declared = parseProto(await Bun.file(proto).text())
    const reads = [
      ["integrations_list", "DomainList"],
      ["integration_get", "DomainGet"],
      ["integration_active", "DomainGet"],
      ["integration_reload", "DomainReload"],
      ["integration_connect_key", "IntegrationKey"],
      ["integration_oauth_connect", "IntegrationConnect"],
      ["integration_oauth_status", "IntegrationAttempt"],
      ["integration_oauth_complete", "IntegrationAttempt"],
      ["integration_oauth_cancel", "IntegrationAttempt"],
      ["integration_command_connect", "IntegrationConnect"],
      ["integration_command_status", "IntegrationAttempt"],
      ["integration_command_cancel", "IntegrationAttempt"],
      ["integration_connection_resolve", "IntegrationResolve"],
    ] as const
    for (const [message, first] of [
      ["HostCall", 30],
      ["PluginCall", 29],
    ] as const) {
      const expected = reads.map(([name, type], index): [number, string, string, string] => [
        first + index,
        name,
        type,
        "optional",
      ])
      expect(declared[message]?.filter((field) => field[0] >= first)).toEqual(expected)
      expect(
        Codec.messages[message]
          ?.filter((field) => field.tag >= first)
          .map((field) => [field.tag, field.name, field.type, field.label]),
      ).toEqual(expected)
    }
  })

  test("frames round-trip canonical values, lone surrogates and required empty messages", () => {
    const value = { a: [1, null, true, "x"], b: { "\ud800": "\udc00" } }
    const bytes = Codec.encode("ChildFrame", {
      generation: "g",
      result: { call: call(1), output: { structured: Codec.value(value), content: [{ text: Codec.text("t") }] } },
    })
    const decoded = Codec.decode("ChildFrame", bytes)
    expect(Codec.readValue(at(decoded, "result", "output", "structured"))).toEqual(value)
    expect(Codec.encode("ChildFrame", decoded)).toEqual(bytes)
    expect(Codec.text("\ud800")).toEqual({ utf16_le: new Uint8Array([0x00, 0xd8]) })
    expect(Codec.readText(Codec.text("plain"))).toBe("plain")
    const empty = Codec.encode("HostFrame", { generation: "g", shutdown: {} })
    expect(Codec.decode("HostFrame", empty)).toEqual({ generation: "g", shutdown: {} })
  })
})

describe("plugin host lifecycle", () => {
  test("promise plugin registers tools and hooks, executes with progress and returns failure messages", async () => {
    const seen: unknown[] = []
    const plugin: FixturePlugin = {
      id: "fixture",
      setup: async (context) => {
        seen.push(context.options)
        await context.tool.transform((draft) =>
          draft.add({
            name: "echo",
            description: "Echo input",
            jsonSchema: { type: "object", properties: { text: { type: "string" } } },
            execute: async (input, toolContext) => {
              await toolContext.progress({ structured: { step: 1 } })
              if (input.text === "fail") throw new Error("fixture failure")
              return { structured: { text: input.text }, content: [{ type: "text", text: String(input.text) }] }
            },
          }),
        )
        await context.tool.hook("execute.before", (event) => {
          event.input = { ...(event.input as ToolInput), hooked: event.sessionID }
        })
        await context.session.hook("context", (event) => {
          event.system.push({ text: "fixture system" })
        })
      },
    }
    const { io, exit } = start(plugin, { label: "fixture" })
    expect(await io.next("ready")).toEqual({ revision: 5, identity: "plugin.fixture", generation: "ext_test" })
    const registered = await io.next("register_tools")
    expect(seen).toEqual([{ label: "fixture" }])
    expect(
      list(at(registered, "tools")).map((tool) =>
        ["namespace", "name", "permission", "code_mode", "direct"].map((key) => at(tool, key)),
      ),
    ).toEqual([["", "echo", "echo", true, false]])
    const transforms = list(at(registered, "transforms"))
    expect(transforms.map((item) => at(item, "stage"))).toEqual([7, 6])

    io.send(execute(2, "echo", { text: "hi" }))
    expect(Codec.readValue(at(await io.next("progress"), "output", "structured"))).toEqual({ step: 1 })
    expect(Codec.readValue(at(await io.next("result"), "output", "structured"))).toEqual({ text: "hi" })

    const index = io.frames.length
    io.send(execute(3, "echo", { text: "fail" }))
    const failed = await io.next("result", index)
    expect(at(failed, "failure", "code")).toBe(2)
    expect(Codec.readText(at(failed, "failure", "message"))).toContain("fixture failure")

    io.send({
      transform: {
        call: call(4),
        registration: at(transforms[0], "id"),
        stage: 7,
        revision: 0,
        draft: Codec.value({ tool: "echo", input: { text: "x" } }),
      },
    })
    expect(Codec.readValue(at(await io.next("transformed"), "draft"))).toEqual({
      tool: "echo",
      input: { text: "x", hooked: "ses_fixture" },
    })
    await stop(io, exit)
  })

  test("cancellation answers with cleanup and a later settlement never produces a result", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<unknown>()
    const finished = Promise.withResolvers<void>()
    const plugin: FixturePlugin = {
      id: "fixture",
      setup: async (context) => {
        await context.tool.transform((draft) =>
          draft.add({
            name: "wait",
            description: "Wait",
            jsonSchema: { type: "object" },
            execute: async () => {
              started.resolve()
              const value = await release.promise
              finished.resolve()
              return value
            },
          }),
        )
      },
    }
    const { io, exit } = start(plugin)
    await io.next("register_tools")
    io.send(execute(9, "wait", {}))
    await started.promise
    io.send({ cancel: { call: call(9) } })
    expect(await io.next("cleanup")).toEqual({ call: call(9) })
    release.resolve({ structured: {}, content: [] })
    await finished.promise
    await stop(io, exit)
    expect(io.frames.some((frame) => "result" in frame)).toBe(false)
  })

  test("setup-time SDK calls use generation-scoped plugin calls and in-call SDK calls carry their owner", async () => {
    const outcomes: unknown[] = []
    const plugin: FixturePlugin = {
      id: "fixture",
      setup: async (context) => {
        outcomes.push(await context.session.get({ sessionID: "ses_other" }))
        await context.tool.transform((draft) =>
          draft.add({
            name: "servers",
            description: "List MCP servers",
            jsonSchema: { type: "object" },
            execute: async () => ({ structured: { servers: await context.mcp.servers() }, content: [] }),
          }),
        )
      },
    }
    const { io, exit } = start(plugin)
    await io.next("ready")
    const outOfCall = await io.next("plugin_call")
    expect(at(outOfCall, "session_get")).toEqual({ session: "ses_other" })
    io.send({ plugin_reply: { request: at(outOfCall, "request"), value: Codec.value({ id: "ses_other" }) } })
    await io.next("register_tools")
    expect(outcomes).toEqual([{ id: "ses_other" }])

    io.send(execute(5, "servers", {}))
    const inCall = await io.next("host_call")
    expect(at(inCall, "call")).toEqual(call(5))
    expect(at(inCall, "servers")).toEqual({})
    io.send({
      host_reply: {
        call: call(5),
        request: at(inCall, "request"),
        value: Codec.value([{ name: "docs", status: "connected" }]),
      },
    })
    expect(Codec.readValue(at(await io.next("result"), "output", "structured"))).toEqual({
      servers: [{ name: "docs", status: "connected" }],
    })
    await stop(io, exit)
  })

  test("Effect plugins run scoped finalizers on shutdown", async () => {
    const events: string[] = []
    const { io, exit } = start({
      id: "fixture",
      effect: () =>
        Effect.addFinalizer(() => Effect.sync(() => events.push("closed"))).pipe(
          Effect.andThen(Effect.sync(() => events.push("started"))),
        ),
    })
    await io.next("register_tools")
    expect(events).toEqual(["started"])
    await stop(io, exit)
    expect(events).toEqual(["started", "closed"])
  })

  test("Effect Schema tools publish JSON Schema, decode input and reject invalid input with a message", async () => {
    const { io, exit } = start({
      id: "fixture",
      effect: (context: {
        readonly tool: {
          readonly transform: (
            callback: (draft: { add: (...args: unknown[]) => void }) => void,
          ) => Effect.Effect<unknown>
        }
      }) =>
        context.tool.transform((draft) =>
          draft.add(
            "typed",
            {
              description: "Typed",
              input: Schema.Struct({ count: Schema.Number }),
              output: Schema.String,
              execute: (input: { readonly count: number }) => Effect.succeed(`count ${input.count}`),
            },
            { namespace: "fixture", codemode: false },
          ),
        ),
    })
    const tool = list(at(await io.next("register_tools"), "tools"))[0]
    expect(["namespace", "name", "direct", "code_mode", "permission"].map((key) => at(tool, key))).toEqual([
      "fixture",
      "typed",
      true,
      false,
      "fixture_typed",
    ])
    expect(Codec.readValue(at(tool, "input_schema"))).toMatchObject({ type: "object", required: ["count"] })
    io.send(execute(6, "typed", { count: 2 }, "fixture"))
    const result = await io.next("result")
    expect(Codec.readValue(at(result, "output", "structured"))).toBe("count 2")
    expect(list(at(result, "output", "content")).map((item) => Codec.readText(at(item, "text")))).toEqual(["count 2"])
    const index = io.frames.length
    io.send(execute(7, "typed", { count: "x" }, "fixture"))
    expect(Codec.readText(at(await io.next("result", index), "failure", "message"))).toContain("Invalid tool input")
    await stop(io, exit)
  })

  test("invalid exports fail setup visibly without registering", async () => {
    const { io, exit } = start({ nope: true })
    const rejected = expect(exit).rejects.toThrow("Invalid plugin export")
    await io.next("ready")
    await rejected
    expect(io.frames.some((frame) => "register_tools" in frame)).toBe(false)
    io.close()
  })

  test("the declared id is reported after import and setup runs only after admission", async () => {
    const events: string[] = []
    const { io, exit } = startHeld({ id: "fixture.declared", setup: async () => void events.push("setup") }, events)
    expect(at(await declaration(io), "declared")).toEqual({ id: { utf8: "fixture.declared" } })
    expect(events).toEqual(["load"])
    io.send({ setup: {} })
    await io.next("register_tools")
    expect(events).toEqual(["load", "setup"])
    await stop(io, exit)
  })

  test("shutdown in place of admission skips setup and registers nothing", async () => {
    const events: string[] = []
    const { io, exit } = startHeld({ id: "fixture.excluded", setup: async () => void events.push("setup") }, events)
    expect(at(await declaration(io), "declared")).toEqual({ id: { utf8: "fixture.excluded" } })
    await stop(io, exit)
    expect(events).toEqual(["load"])
    expect(io.frames.some((frame) => "register_tools" in frame)).toBe(false)
  })
})

describe("plugin host server events", () => {
  const soon = <T>(value: Promise<T>) => Promise.race([value, Bun.sleep(1_000).then(() => undefined)])

  test("promise event.subscribe delivers server events, receipts deliveries and unsubscribes on return", async () => {
    const seen: unknown[] = []
    const received = Promise.withResolvers<void>()
    let iterator: AsyncIterator<unknown> | undefined
    const plugin: FixturePlugin = {
      id: "fixture",
      setup: async (context) => {
        const events = (context as unknown as { event: { subscribe: () => AsyncIterable<unknown> } }).event.subscribe()
        iterator = events[Symbol.asyncIterator]()
        void (async () => {
          for (;;) {
            const next = await iterator!.next()
            if (next.done) return
            seen.push(next.value)
            received.resolve()
          }
        })()
      },
    }
    const { io, exit } = start(plugin)
    await io.next("register_tools")
    const subscription = await soon(io.next("subscribe"))
    expect(at(subscription, "families")).toEqual(["*"])
    const id = at(subscription, "id")
    io.send({
      event: {
        delivery: 41,
        subscription: id,
        family: "config.updated",
        envelope: Codec.value({ id: "evt_1", type: "config.updated", created: 1, data: {} }),
      },
    })
    expect(await soon(io.next("event_receipt"))).toEqual({ delivery: 41 })
    await soon(received.promise)
    expect(seen).toEqual([{ id: "evt_1", type: "config.updated", created: 1, data: {} }])
    await iterator!.return!()
    expect(await soon(io.next("unsubscribe"))).toEqual({ subscription: id })
    await stop(io, exit)
  })

  test("effect event.subscribe streams server events and unsubscribes when the stream completes", async () => {
    const seen: unknown[] = []
    const received = Promise.withResolvers<void>()
    const { io, exit } = start({
      id: "fixture",
      effect: (context: { readonly event: { readonly subscribe: () => Stream.Stream<unknown> } }) =>
        context.event.subscribe().pipe(
          Stream.take(1),
          Stream.runForEach((event) =>
            Effect.sync(() => {
              seen.push(event)
              received.resolve()
            }),
          ),
          Effect.forkScoped,
          Effect.asVoid,
        ),
    })
    await io.next("register_tools")
    const subscription = await soon(io.next("subscribe"))
    expect(at(subscription, "families")).toEqual(["*"])
    const id = at(subscription, "id")
    io.send({
      event: {
        delivery: 7,
        subscription: id,
        family: "agent.updated",
        envelope: Codec.value({ id: "evt_2", type: "agent.updated", created: 2, data: {} }),
      },
    })
    expect(await soon(io.next("event_receipt"))).toEqual({ delivery: 7 })
    await soon(received.promise)
    expect(seen).toEqual([{ id: "evt_2", type: "agent.updated", created: 2, data: {} }])
    expect(await soon(io.next("unsubscribe"))).toEqual({ subscription: id })
    await stop(io, exit)
  })

  test("plugin shutdown ends an open event subscription without a result frame", async () => {
    const ended = Promise.withResolvers<boolean>()
    const plugin: FixturePlugin = {
      id: "fixture",
      setup: async (context) => {
        const events = (context as unknown as { event: { subscribe: () => AsyncIterable<unknown> } }).event.subscribe()
        void (async () => {
          const next = await events[Symbol.asyncIterator]().next()
          ended.resolve(next.done === true)
        })()
      },
    }
    const { io, exit } = start(plugin)
    await io.next("register_tools")
    expect(at(await soon(io.next("subscribe")), "families")).toEqual(["*"])
    await stop(io, exit)
    expect(await soon(ended.promise)).toBe(true)
  })
})

describe("plugin host domain reads", () => {
  test("promise domain reads use plugin calls with Main-shaped results", async () => {
    const results: Record<string, unknown> = {}
    const plugin: FixturePlugin = {
      id: "fixture",
      setup: async (context) => {
        const ctx = context as unknown as Record<string, any>
        results.agents = await ctx.agent.list()
        results.otherAgents = await ctx.agent.list({ location: { directory: "/other" } })
        results.agent = await ctx.agent.get("build")
        results.missing = String(await ctx.agent.get("missing"))
        results.commands = await ctx.command.list()
        results.references = await ctx.reference.list()
        results.skills = await ctx.skill.list()
        results.providers = await ctx.catalog.provider.list()
        results.provider = await ctx.catalog.provider.get({ providerID: "p1" })
        results.models = await ctx.catalog.model.list()
        results.model = await ctx.catalog.model.get("p1", "m1")
        results.default = await ctx.catalog.model.default()
        results.plugins = await ctx.plugin.list()
        results.integrations = await ctx.integration.list()
        results.otherIntegrations = await ctx.integration.list({ location: { directory: "/other" } })
        results.integration = await ctx.integration.get({ integrationID: "github" })
        results.missingIntegration = await ctx.integration.get({
          integrationID: "missing",
          location: { directory: "/other" },
        })
        results.activeConnection = await ctx.integration.connection.active("github")
        results.missingConnection = String(await ctx.integration.connection.active("missing"))
        await ctx.agent.reload()
        await ctx.command.reload()
        await ctx.reference.reload()
        await ctx.skill.reload()
        await ctx.catalog.reload()
        results.reloaded = true
      },
    }
    const { io, exit } = start(plugin)
    await io.next("ready")
    const location = { directory: "/fixture" }
    const credential = { type: "credential", id: "cred_work", label: "Work", active: true }
    const github = {
      id: "github",
      name: "GitHub",
      methods: [
        { type: "key", label: "Token" },
        { type: "env", names: ["GITHUB_TOKEN"] },
      ],
      connections: [credential, { type: "env", name: "GITHUB_TOKEN" }],
    }
    const replies: Record<string, unknown> = {
      agents_list: [
        { location, data: [{ id: "build" }] },
        { location: { directory: "/other" }, data: [{ id: "neighbor" }] },
      ],
      agent_get: [{ id: "build" }, null],
      commands_list: { location, data: [{ name: "init" }] },
      references_list: { location, data: [{ name: "docs" }] },
      skills_list: { location, data: [{ id: "ycoding" }] },
      providers_list: { location, data: [{ id: "p1" }] },
      provider_get: { location, data: { id: "p1" } },
      models_list: { location, data: [{ id: "m1", providerID: "p1" }] },
      model_get: { id: "m1", providerID: "p1" },
      model_default: { location },
      plugins_list: { location, data: [{ id: "fixture" }] },
      integrations_list: [
        { location, data: [github] },
        { location, data: [github] },
      ],
      integration_get: [
        { location, data: github },
        { location, data: null },
      ],
      integration_active: [credential, null],
      agent_reload: null,
      command_reload: null,
      reference_reload: null,
      skill_reload: null,
      catalog_reload: null,
    }
    const seen: string[] = []
    let from = 0
    while (!io.frames.some((frame) => "register_tools" in frame)) {
      const call = (await Promise.race([
        io.next("plugin_call", from),
        io.next("register_tools", from).then(() => undefined),
        Bun.sleep(2_000).then(() => {
          throw new Error(`timed out waiting for a plugin read call after ${seen.join(",")}`)
        }),
      ])) as Record<string, unknown> | undefined
      if (!call) break
      from = io.frames.length
      const operation = Object.keys(replies).find((name) => name in call) ?? Object.keys(call).join(",")
      seen.push(operation)
      const reply = Array.isArray(replies[operation]) ? replies[operation].shift() : replies[operation]
      if (operation === "agents_list" && seen.filter((name) => name === "agents_list").length === 2)
        expect(at(call, "agents_list")).toEqual({ directory: { utf8: "/other" } })
      if (operation === "agent_get") expect(["build", "missing"]).toContain(at(call, "agent_get", "id") as string)
      if (operation === "provider_get") expect(at(call, "provider_get")).toEqual({ id: "p1" })
      if (operation === "model_get") expect(at(call, "model_get")).toEqual({ provider: "p1", model: "m1" })
      if (operation === "integrations_list") expect(at(call, "integrations_list")).toEqual({})
      if (operation === "integration_get")
        expect(at(call, "integration_get")).toEqual({
          id: seen.filter((name) => name === "integration_get").length === 1 ? "github" : "missing",
        })
      if (operation === "integration_active")
        expect(at(call, "integration_active")).toEqual({
          id: seen.filter((name) => name === "integration_active").length === 1 ? "github" : "missing",
        })
      io.send({ plugin_reply: { request: at(call, "request"), value: Codec.value(reply ?? null) } })
    }
    await io.next("register_tools")
    expect(seen).toEqual([
      "agents_list",
      "agents_list",
      "agent_get",
      "agent_get",
      "commands_list",
      "references_list",
      "skills_list",
      "providers_list",
      "provider_get",
      "models_list",
      "model_get",
      "model_default",
      "plugins_list",
      "integrations_list",
      "integrations_list",
      "integration_get",
      "integration_get",
      "integration_active",
      "integration_active",
      "agent_reload",
      "command_reload",
      "reference_reload",
      "skill_reload",
      "catalog_reload",
    ])
    expect(results).toEqual({
      agents: { location, data: [{ id: "build" }] },
      otherAgents: { location: { directory: "/other" }, data: [{ id: "neighbor" }] },
      agent: { id: "build" },
      missing: "undefined",
      commands: { location, data: [{ name: "init" }] },
      references: { location, data: [{ name: "docs" }] },
      skills: { location, data: [{ id: "ycoding" }] },
      providers: { location, data: [{ id: "p1" }] },
      provider: { location, data: { id: "p1" } },
      models: { location, data: [{ id: "m1", providerID: "p1" }] },
      model: { id: "m1", providerID: "p1" },
      default: { location, data: null },
      plugins: { location, data: [{ id: "fixture" }] },
      integrations: { location, data: [github] },
      otherIntegrations: { location, data: [github] },
      integration: { location, data: github },
      missingIntegration: { location, data: null },
      activeConnection: credential,
      missingConnection: "undefined",
      reloaded: true,
    })
    await stop(io, exit)
  })

  test("effect domain reads settle through the same plugin calls", async () => {
    const seen: unknown[] = []
    const { io, exit } = start({
      id: "fixture",
      effect: (context: any) =>
        Effect.gen(function* () {
          seen.push(yield* context.agent.list())
          seen.push(yield* context.catalog.model.get("p1", "m1"))
          seen.push(yield* context.integration.list())
          seen.push(yield* context.integration.get({ integrationID: "missing" }))
          seen.push(yield* context.integration.connection.active("missing"))
          yield* context.skill.reload()
          seen.push("reloaded")
        }),
    })
    await io.next("ready")
    const replies: Record<string, unknown> = {
      agents_list: { location: { directory: "/fixture" }, data: [{ id: "build" }] },
      model_get: { id: "m1", providerID: "p1" },
      integrations_list: { location: { directory: "/fixture" }, data: [] },
      integration_get: { location: { directory: "/fixture" }, data: null },
      integration_active: null,
      skill_reload: null,
    }
    let from = 0
    while (!io.frames.some((frame) => "register_tools" in frame)) {
      const call = (await Promise.race([
        io.next("plugin_call", from),
        io.next("register_tools", from).then(() => undefined),
        Bun.sleep(2_000).then(() => {
          throw new Error("timed out waiting for an effect plugin read call")
        }),
      ])) as Record<string, unknown> | undefined
      if (!call) break
      from = io.frames.length
      const operation = Object.keys(replies).find((name) => name in call) ?? ""
      io.send({ plugin_reply: { request: at(call, "request"), value: Codec.value(replies[operation] ?? null) } })
    }
    await io.next("register_tools")
    expect(seen).toEqual([
      { location: { directory: "/fixture" }, data: [{ id: "build" }] },
      { id: "m1", providerID: "p1" },
      { location: { directory: "/fixture" }, data: [] },
      { location: { directory: "/fixture" }, data: null },
      undefined,
      "reloaded",
    ])
    await stop(io, exit)
  })

  test("integration operations beyond the metadata reads reject without any plugin call", async () => {
    const outcomes: Record<string, string> = {}
    const { io, exit } = start({
      id: "fixture",
      setup: async ({ integration }: HeldIntegrationContext) => {
        const held: Record<string, HeldOperation> = {
          "integration.connect.key": integration.connect.key,
          "integration.oauth.connect": integration.oauth.connect,
          "integration.oauth.status": integration.oauth.status,
          "integration.oauth.complete": integration.oauth.complete,
          "integration.oauth.cancel": integration.oauth.cancel,
          "integration.command.connect": integration.command.connect,
          "integration.command.status": integration.command.status,
          "integration.command.cancel": integration.command.cancel,
          "integration.connection.resolve": integration.connection.resolve,
          "integration.transform": integration.transform,
          "integration.reload": integration.reload,
        }
        for (const [name, run] of Object.entries(held))
          outcomes[name] = await run({ integrationID: "github" }).then(
            () => "resolved",
            (error: Error) => error.message,
          )
      },
    })
    try {
      await io.next("ready")
      await io.next("register_tools")
      expect(outcomes).toEqual(
        Object.fromEntries(
          [
            "integration.connect.key",
            "integration.oauth.connect",
            "integration.oauth.status",
            "integration.oauth.complete",
            "integration.oauth.cancel",
            "integration.command.connect",
            "integration.command.status",
            "integration.command.cancel",
            "integration.connection.resolve",
            "integration.transform",
            "integration.reload",
          ].map((name) => [name, `Plugin API ${name} is not supported by this runtime`]),
        ),
      )
      expect(io.frames.filter((frame) => "plugin_call" in frame)).toEqual([])
    } finally {
      await stop(io, exit)
    }
  })

  test("effect integration transform and credential resolution stay unsupported", async () => {
    const failures: string[] = []
    const { io, exit } = start({
      id: "fixture",
      effect: ({ integration }: HeldEffectContext) =>
        Effect.gen(function* () {
          for (const run of [
            () => integration.transform(() => undefined),
            () => integration.connection.resolve({ type: "env", name: "GITHUB_TOKEN" }),
          ]) {
            const outcome = yield* Effect.exit(run())
            failures.push(Exit.isFailure(outcome) ? Cause.pretty(outcome.cause) : "resolved")
          }
        }),
    })
    try {
      await io.next("ready")
      await io.next("register_tools")
      expect(failures).toHaveLength(2)
      expect(failures[0]).toContain("Plugin API integration.transform is not supported by this runtime")
      expect(failures[1]).toContain("Plugin API integration.connection.resolve is not supported by this runtime")
      expect(io.frames.filter((frame) => "plugin_call" in frame)).toEqual([])
    } finally {
      await stop(io, exit)
    }
  })
})

describe("plugin host AI SDK language bridge", () => {
  test("configured sdk hooks claim only their packages and stream parts incrementally to one terminal result", async () => {
    const second = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const prompts: unknown[] = []
    const plugin: FixturePlugin = {
      id: "fixture",
      setup: (context) =>
        context.aisdk.hook("sdk", (event) => {
          if (event.package !== "fixture-sdk") return
          event.sdk = {
            languageModel: (id) => ({
              doStream: async (options) => {
                prompts.push(options.prompt)
                if (id === "broken") throw new Error("fixture startup failure")
                options.abortSignal.addEventListener("abort", () => aborted.resolve())
                return {
                  stream: new ReadableStream<unknown>({
                    async start(controller) {
                      controller.enqueue({ type: "text-delta", id: "t", delta: id })
                      if (id === "endless") return
                      await second.promise
                      controller.enqueue({ type: "finish", finishReason: "stop" })
                      controller.close()
                    },
                  }),
                }
              },
            }),
          }
        }),
    }
    const { io, exit } = start(plugin)
    await io.next("register_tools")
    const resolve = (request: number, pkg: string, id: string) =>
      io.send({
        language_resolve: {
          request,
          package: pkg,
          model: Codec.value({ id }),
          options: Codec.value({ apiKey: "synthetic" }),
        },
      })
    const attempt = (request: number, id: string) =>
      io.send({
        language_attempt: {
          request,
          package: "fixture-sdk",
          model: Codec.value({ id }),
          options: Codec.value({ apiKey: "synthetic" }),
          body: Codec.value({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
        },
      })
    const resolved = async (request: number) => {
      for (;;) {
        const found = io.frames.find((frame) => at(frame, "language_resolved", "request") === request)
        if (found) return at(found, "language_resolved", "handled")
        await io.next("language_resolved", io.frames.length)
      }
    }
    resolve(1, "fixture-sdk", "model")
    expect(await resolved(1)).toBe(true)
    resolve(2, "native-package", "model")
    expect(await resolved(2)).toBe(false)

    const partsFor = (request: number) =>
      io.frames
        .filter((frame) => at(frame, "language_parts", "request") === request)
        .flatMap((frame) => list(at(frame, "language_parts", "parts")).map(Codec.readValue))
    const resultFor = (request: number) =>
      io.frames
        .filter((frame) => at(frame, "language_result", "request") === request)
        .map((frame) => frame.language_result)
    const until = async (check: () => boolean) => {
      while (!check()) await io.next("language_parts", io.frames.length).catch(() => undefined)
    }

    attempt(3, "model")
    await until(() => partsFor(3).length === 1)
    expect(partsFor(3)).toEqual([{ type: "text-delta", id: "t", delta: "model" }])
    expect(resultFor(3)).toEqual([])
    second.resolve()
    while (resultFor(3).length === 0) await io.next("language_result", io.frames.length)
    expect(partsFor(3)).toEqual([
      { type: "text-delta", id: "t", delta: "model" },
      { type: "finish", finishReason: "stop" },
    ])
    expect(resultFor(3)).toEqual([{ request: 3, done: {} }])
    expect(prompts[0]).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }])

    attempt(4, "endless")
    await until(() => partsFor(4).length === 1)
    io.send({ language_cancel: { request: 4 } })
    await aborted.promise
    while (resultFor(4).length === 0) await io.next("language_result", io.frames.length)
    expect(resultFor(4)).toHaveLength(1)

    attempt(5, "broken")
    while (resultFor(5).length === 0) await io.next("language_result", io.frames.length)
    expect(partsFor(5)).toEqual([])
    expect(Codec.readText(at(resultFor(5)[0], "failure", "message"))).toContain("fixture startup failure")
    await stop(io, exit)
  })

  test("file:// model packages import the provider module directly without installing it", async () => {
    const cache = await mkdtemp(path.join(tmpdir(), "plugin-host-file-model-"))
    try {
      const target = pathToFileURL(path.join(fixtures, "model-package.js")).href
      const io = channel()
      const exit = PluginHost.serve({ input: io.input, write: io.write }, PluginLoader.load)
      const greeting = hello(target, {}, true)
      greeting.hello.plugin.cache = Codec.text(cache)
      io.send(greeting)
      await io.next("register_tools")
      io.send({
        language_attempt: {
          request: 1,
          package: target,
          model: Codec.value({ id: "local" }),
          options: Codec.value({ label: "file" }),
          body: Codec.value({ prompt: [] }),
        },
      })
      expect(await io.next("language_result")).toEqual({ request: 1, done: {} })
      const parts = io.frames.flatMap((frame) =>
        frame.language_parts ? list(at(frame, "language_parts", "parts")).map(Codec.readValue) : [],
      )
      expect(at(parts[0], "rawValue", "id")).toBe("local")
      expect(at(parts[0], "rawValue", "options", "label")).toBe("file")
      expect(["packages", "npm"].filter((entry) => existsSync(path.join(cache, entry)))).toEqual([])
      await stop(io, exit)
    } finally {
      await rm(cache, { recursive: true, force: true })
    }
  })
})

describe("plugin host with the public plugin SDK", () => {
  for (const [file, tool, input, output] of [
    ["promise-plugin.ts", "promise_echo", { text: "hi" }, { text: "hi", label: "authored" }],
    ["effect-plugin.ts", "effect_echo", { text: "hi" }, "effect hi"],
  ] as const) {
    test(`${file} loads through Plugin.define, executes and runs its cleanup`, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "plugin-host-sdk-"))
      const marker = path.join(directory, "closed")
      const { io, exit } = startTarget(path.join(fixtures, file), { marker, label: "authored" })
      const registered = list(at(await io.next("register_tools"), "tools"))
      expect(registered.map((item) => [at(item, "name"), at(item, "direct")])).toEqual([[tool, true]])
      io.send(execute(1, tool, input))
      expect(Codec.readValue(at(await io.next("result"), "output", "structured"))).toEqual(output)
      await stop(io, exit)
      expect(await Bun.file(marker).text()).toBe("closed")
      await rm(directory, { recursive: true, force: true })
    })
  }

  test("public SDK fixtures and the host graph load no Core, Server or storage runtime", async () => {
    for (const entrypoint of [
      path.join(fixtures, "promise-plugin.ts"),
      path.join(fixtures, "effect-plugin.ts"),
      path.join(root, "packages/cli/src/plugin-host/main.ts"),
    ]) {
      const inputs = await bundleInputs(entrypoint)
      expect(inputs.some((input) => input.includes("packages/plugin/") || input.includes("plugin-host/"))).toBe(true)
      expect(
        inputs.filter((input) =>
          /packages\/(?:core|server|meeting|codemode|effect-sqlite-node|effect-drizzle-sqlite)\/|sqlite|drizzle|node-pty/.test(
            input,
          ),
        ),
      ).toEqual([])
      if (entrypoint.endsWith("plugin-host/main.ts"))
        expect(inputs.filter((input) => /(?:packages\/plugin\/|node_modules\/.*effect(?:@|\/))/.test(input))).toEqual(
          [],
        )
    }
  }, 60_000)

  test("npm targets resolve an authored cached package without running lifecycle scripts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "plugin-host-npm-"))
    const cache = path.join(directory, "cache")
    const source = path.join(cache, "packages/fixture-plugin/node_modules/fixture-plugin")
    await mkdir(path.join(source, "dist"), { recursive: true })
    await writeFile(
      path.join(source, "package.json"),
      JSON.stringify({
        name: "fixture-plugin",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./dist/index.js", "./server": "./dist/server.js" },
        scripts: { postinstall: "touch ../scripts-ran" },
      }),
    )
    await writeFile(path.join(source, "dist/index.js"), 'export default { id: "root" }\n')
    await writeFile(path.join(source, "dist/server.js"), 'export default { id: "server" }\n')
    const plugin = await PluginLoader.load({ target: "fixture-plugin", options: {}, cache })
    expect(at(plugin, "id")).toBe("server")
    expect(await Bun.file(path.join(directory, "scripts-ran")).exists()).toBe(false)
    const installed = Array.from(
      new Bun.Glob("packages/*/node_modules/fixture-plugin/package.json").scanSync({
        cwd: cache,
        followSymlinks: true,
      }),
    )
    expect(installed).toHaveLength(1)
    await rm(directory, { recursive: true, force: true })
  }, 60_000)

  test("public SDK imports resolve for a configured file outside the workspace", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "plugin-host-external-"))
    try {
      for (const [file, tool, output] of [
        ["promise-plugin.ts", "promise_echo", { text: "external", label: "authored" }],
        ["effect-plugin.ts", "effect_echo", "effect external"],
      ] as const) {
        const target = path.join(directory, file)
        await writeFile(target, await Bun.file(path.join(fixtures, file)).text())
        const { io, exit } = startTarget(target, { marker: path.join(directory, "closed"), label: "authored" })
        await io.next("register_tools")
        io.send(execute(1, tool, { text: "external" }))
        expect(Codec.readValue(at(await io.next("result"), "output", "structured"))).toEqual(output)
        await stop(io, exit)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("the Node host shares its runtime with external public SDK plugins", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "plugin-host-node-"))
    const { PluginSDKAsset } = await import("../script/plugin-sdk")
    const asset = await PluginSDKAsset.build(root, directory)
    const build = await buildNodeHost(directory, asset)
    expect(build.success).toBe(true)
    try {
      for (const [file, tool, expected] of [
        ["promise-plugin.ts", "promise_echo", { text: "node", label: "authored" }],
        ["effect-plugin.ts", "effect_echo", "effect node"],
        ["cached-package", "promise_echo", { text: "node", label: "authored" }],
        ["model-package", "", {}],
      ] as const) {
        const target =
          file === "cached-package"
            ? "fixture-node-plugin"
            : file === "model-package"
              ? "fixture-node-model"
              : path.join(directory, file.replace(".ts", ".mjs"))
        if (file === "cached-package" || file === "model-package") {
          const installed = path.join(directory, `cache/packages/${target}/node_modules/${target}`)
          await mkdir(installed, { recursive: true })
          await writeFile(
            path.join(installed, "package.json"),
            JSON.stringify({
              name: target,
              version: "1.0.0",
              type: "module",
              exports: { ".": { import: "./index.mjs" } },
            }),
          )
          await writeFile(
            path.join(installed, "index.mjs"),
            await Bun.file(
              path.join(fixtures, file === "model-package" ? "model-package.js" : "promise-plugin.ts"),
            ).text(),
          )
        } else {
          await writeFile(target, await Bun.file(path.join(fixtures, file)).text())
        }
        const child = Bun.spawn(
          [
            "node",
            "--input-type=module",
            "-e",
            `const { run } = await import(${JSON.stringify(build.outputs[0].path)}); await run()`,
          ],
          {
            cwd: directory,
            env: { PATH: process.env.PATH ?? "", HOME: directory },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const reader = child.stdout.getReader()
        const decoder = new Codec.FrameReader()
        const received: Frame[] = []
        const errors = new Response(child.stderr).text()
        const send = async (body: Frame) => {
          child.stdin.write(Codec.frame(Codec.encode("HostFrame", { generation: "ext_test", ...body })))
          await child.stdin.flush()
        }
        const next = async (key: string) => {
          for (;;) {
            const found = received.find((frame) => key in frame)
            if (found) return found[key]
            const chunk = await reader.read()
            if (chunk.done) throw new Error(`Node host closed before ${key}: ${await errors}`)
            const frames = decoder.push(chunk.value).map((bytes) => Codec.decode("ChildFrame", bytes))
            received.push(...frames)
            for (const frame of frames) {
              if (frame.declared) await send({ setup: {} })
              if (frame.language_parts && list(at(frame, "language_parts", "parts")).length > 0)
                await send({ language_credit: { request: at(frame, "language_parts", "request") } })
            }
          }
        }
        try {
          const greeting = hello(
            target,
            { label: "authored", marker: path.join(directory, "closed") },
            file === "model-package",
          )
          greeting.hello.plugin.cache = Codec.text(path.join(directory, "cache"))
          await send(greeting)
          await next("register_tools")
          if (file === "model-package") {
            await send({
              language_attempt: {
                request: 1,
                package: target,
                model: Codec.value({ id: "node" }),
                options: Codec.value({}),
                body: Codec.value({ prompt: [] }),
              },
            })
            await send({ language_credit: { request: 1 } })
            expect(at(await next("language_result"), "done")).toEqual({})
            const parts = received.flatMap((frame) =>
              frame.language_parts ? list(at(frame, "language_parts", "parts")).map(Codec.readValue) : [],
            )
            expect(at(parts[0], "rawValue", "id")).toBe("node")
            expect(at(parts[1], "type")).toBe("finish")
          } else {
            await send(execute(1, tool, { text: "node" }))
            expect(Codec.readValue(at(await next("result"), "output", "structured"))).toEqual(expected)
          }
          await send({ shutdown: {} })
          await next("stopped")
          expect(await child.exited).toBe(0)
        } finally {
          if (child.exitCode === null) child.kill("SIGTERM")
          await child.exited
          reader.releaseLock()
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test("the Node host rejects a mismatched SDK digest before loading a plugin", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "plugin-host-integrity-"))
    try {
      const { PluginSDKAsset } = await import("../script/plugin-sdk")
      const asset = await PluginSDKAsset.build(root, directory)
      const build = await buildNodeHost(directory, { ...asset, digest: "0".repeat(64) })
      expect(build.success).toBe(true)
      const child = Bun.spawn(
        [
          "node",
          "--input-type=module",
          "-e",
          `const { run } = await import(${JSON.stringify(build.outputs[0].path)}); await run()`,
        ],
        {
          cwd: directory,
          env: { PATH: process.env.PATH ?? "", HOME: directory },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const errors = new Response(child.stderr).text()
      const output = new Response(child.stdout).arrayBuffer()
      try {
        const greeting = hello(path.join(fixtures, "promise-plugin.ts"), { marker: path.join(directory, "closed") })
        greeting.hello.plugin.cache = Codec.text(path.join(directory, "cache"))
        child.stdin.write(Codec.frame(Codec.encode("HostFrame", { generation: "ext_test", ...greeting })))
        await child.stdin.flush()
        expect(await child.exited).toBe(1)
        expect(await errors).toContain("Plugin SDK asset does not match its embedded digest")
        const reader = new Codec.FrameReader()
        const frames = reader.push(new Uint8Array(await output)).map((frame) => Codec.decode("ChildFrame", frame))
        expect(frames.some((frame) => "register_tools" in frame)).toBe(false)
        expect(await Bun.file(path.join(directory, "closed")).exists()).toBe(false)
      } finally {
        if (child.exitCode === null) child.kill("SIGTERM")
        await child.exited
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})

function buildNodeHost(directory: string, asset: { path: string; digest: string }) {
  return Bun.build({
    entrypoints: [path.join(root, "packages/cli/src/plugin-host/main.ts")],
    outdir: path.join(directory, "host"),
    target: "node",
    format: "esm",
    define: {
      YCODING_PLUGIN_SDK_ASSET: JSON.stringify("ycoding-test-sdk-asset"),
      YCODING_PLUGIN_SDK_SHA256: JSON.stringify(asset.digest),
    },
    plugins: [
      {
        name: "fixture-sdk-file-asset",
        setup(builder) {
          builder.onResolve({ filter: /^ycoding-test-sdk-asset$/ }, () => ({ path: "sdk", namespace: "fixture-sdk" }))
          builder.onLoad({ filter: /.*/, namespace: "fixture-sdk" }, () => ({
            contents: `export default ${JSON.stringify(asset.path)}`,
            loader: "js",
          }))
        },
      },
    ],
  })
}

async function bundleInputs(entrypoint: string) {
  const temporary = await mkdtemp(path.join(tmpdir(), "plugin-host-graph-"))
  const metafile = path.join(temporary, "meta.json")
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      entrypoint,
      "--target=bun",
      "--format=esm",
      "--packages=bundle",
      `--metafile=${metafile}`,
      `--outdir=${path.join(temporary, "out")}`,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(stdout + stderr)
  const metadata: unknown = await Bun.file(metafile).json()
  await rm(temporary, { recursive: true, force: true })
  return Object.keys((at(metadata, "inputs") as Record<string, unknown>) ?? {})
}

function parseProto(source: string) {
  const types = new Set(["string", "bytes", "bool", "uint32", "uint64", "double"])
  const enums = new Set([...source.matchAll(/enum (\w+)/g)].map((match) => match[1]))
  const result: Record<string, Array<[number, string, string, string]>> = {}
  for (const match of source.matchAll(/message (\w+) \{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
    const fields: Array<[number, string, string, string]> = []
    for (const field of match[2].matchAll(/(required|optional|repeated)?\s*(\w+) (\w+) = (\d+);/g)) {
      const type = types.has(field[2]) ? field[2] : enums.has(field[2]) ? "enum" : field[2]
      fields.push([Number(field[4]), field[3], type, field[1] ?? "optional"])
    }
    result[match[1]] = fields.sort((left, right) => left[0] - right[0])
  }
  return result
}
