import type { Plugin } from "@ycoding-ai/plugin/effect/plugin"
import type { AISDKHooks } from "@ycoding-ai/plugin/effect/aisdk"
import { Agent } from "@ycoding-ai/schema/agent"
import { Credential } from "@ycoding-ai/schema/credential"
import { Integration } from "@ycoding-ai/schema/integration"
import { AbsolutePath } from "@ycoding-ai/schema/schema"
import { Session } from "@ycoding-ai/schema/session"
import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Schema, Scope } from "effect"
import { Codec } from "../src/plugin-host/codec"
import { selectEvent } from "./fixtures/plugin-parent/events"
import { array, checked, object, start, type Context, type Frame } from "./fixtures/plugin-parent/harness"

test("PC18 parent evidence selection preserves the numeric offset and event kind", () => {
  const evidence = [{ kind: "oauth-authorize", authorization: 1 }, { kind: "oauth-close", authorization: 2 }, { kind: "oauth-authorize", authorization: 2 }]
  expect(selectEvent(evidence, "oauth-authorize", undefined, 1)).toBe(evidence[2])
})

test("PC18 parent evidence selection chooses the matching authorization instead of an earlier event", () => {
  const evidence = [{ kind: "oauth-authorize", authorization: 1 }, { kind: "oauth-authorize", authorization: 2 }]
  expect(selectEvent(evidence, "oauth-authorize", (item) => item.authorization === 2)).toBe(evidence[1])
})

test("PC18 parent evidence selection leaves a missing authorization unmatched", () => {
  const evidence = [{ kind: "oauth-authorize", authorization: 1 }, { kind: "oauth-close", authorization: 2 }]
  expect(selectEvent(evidence, "oauth-authorize", (item) => item.authorization === 2)).toBeUndefined()
})

test("PC16 concurrent integration transforms retain separate drafts when replies complete out of order", async () => {
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const host = start({
    id: "parent.concurrent-integration-drafts",
    effect: (ctx) => ctx.integration.transform(async (draft) => {
      const id = draft.list()[0]!.id
      const index = id === "first" ? 0 : 1
      entered[index]!.resolve()
      await release[index]!.promise
      draft.update(id, (reference) => { reference.name = `updated-${id}` })
    }).pipe(Effect.asVoid),
  })
  await checked(async () => {
    await host.ready()
    const first = host.transform(10, { items: [{ id: "first", name: "First", methods: [] }] }, 101)
    const second = host.transform(10, { items: [{ id: "second", name: "Second", methods: [] }] }, 102)
    await Promise.all(entered.map((item) => item.promise))
    release[1]!.resolve()
    expect(array(object(Codec.readValue((await second).draft)).items)).toEqual([{ id: "second", name: "updated-second", methods: [] }])
    release[0]!.resolve()
    expect(array(object(Codec.readValue((await first).draft)).items)).toEqual([{ id: "first", name: "updated-first", methods: [] }])
  }, () => { release.forEach((item) => item.resolve()) }, async () => { expect(await host.stop()).toEqual({ code: 0 }) })
})

test("PC17 disposing a shadowed tool registration removes only its own native owner once", async () => {
  const captured = Promise.withResolvers<Context>()
  const scopes = [Effect.runSync(Scope.make()), Effect.runSync(Scope.make())]
  const host = start({ id: "parent.shadowed-registration", effect: (ctx) => Effect.sync(() => captured.resolve(ctx)) })
  const tool = (value: string) => ({ description: "Scoped tool", jsonSchema: { type: "object" as const }, execute: () => Effect.succeed({ structured: value, content: [] }) })
  await checked(async () => {
    await host.ready()
    const ctx = await captured.promise
    const first = await Effect.runPromise(Scope.provide(scopes[0]!)(ctx.tool.transform((draft) => draft.add("shadowed", tool("first")))))
    const old = host.tools().findLast((entry) => entry.name === "shadowed")!
    await Effect.runPromise(Scope.provide(scopes[1]!)(ctx.tool.transform((draft) => draft.add("shadowed", tool("second")))))
    const current = host.tools().findLast((entry) => entry.name === "shadowed")!
    await Effect.runPromise(first.dispose)
    await Effect.runPromise(first.dispose)
    await host.next("registration_update", (update) => (update.remove as string[] | undefined)?.includes(`tool:${old.implementation}`) === true)
    expect(host.frames.filter((frame) => (object(frame.registration_update ?? {}).remove as string[] | undefined)?.includes(`tool:${old.implementation}`))).toHaveLength(1)
    const result = await host.execute("shadowed", 201, {}, current.implementation)
    expect(Codec.readValue(object(result.output).structured)).toBe("second")
  }, ...scopes.map((scope) => () => Effect.runPromise(Scope.close(scope, Exit.void))), async () => { expect(await host.stop()).toEqual({ code: 0 }) })
})

type Case = {
  readonly name: string
  readonly operation: string
  readonly input: Frame
  readonly run: (context: Context) => Effect.Effect<unknown, unknown>
  readonly reply: unknown
  readonly expected: unknown
}

for (const api of ["effect", "promise"] as const) {
  test(`PC15 original ${api} entrypoints retain their receiver, symbols and WeakMap identity`, async () => {
    const marker = Symbol("parent-original")
    const identity = new WeakMap<object, string>()
    const entered = Promise.withResolvers<{ readonly privateValue: string; readonly symbolValue: string; readonly identity: string | undefined }>()
    class Original {
      readonly id = "parent.original-receiver"
      readonly [marker] = "symbol-value"
      readonly #value = "private-value"
      capture() { entered.resolve({ privateValue: this.#value, symbolValue: this[marker], identity: identity.get(this) }) }
    }
    class OriginalEffect extends Original { effect() { return Effect.sync(() => this.capture()) } }
    class OriginalPromise extends Original { async setup() { this.capture() } }
    const plugin = api === "effect" ? new OriginalEffect() : new OriginalPromise()
    identity.set(plugin, "weakmap-value")
    const host = start(plugin)
    await checked(async () => {
      await host.ready()
      expect(await entered.promise).toEqual({ privateValue: "private-value", symbolValue: "symbol-value", identity: "weakmap-value" })
    }, async () => { expect(await host.stop()).toEqual({ code: 0 }) })
  })
}

test("PC14 tool path mappings retain one distinct supplied path for every registered tool", async () => {
  const host = start({
    id: "parent.multiple-tool-paths",
    effect: (ctx) => ctx.tool.transform((draft) => {
      const options = { namespace: "fixture", paths: { first: "fixture.files.one", second: "fixture.files.two" } }
      for (const name of ["first", "second"])
        draft.add(name, { description: name, jsonSchema: { type: "object" }, execute: () => Effect.succeed({ structured: name, content: [] }) }, options)
    }).pipe(Effect.asVoid),
  })
  await checked(async () => {
    await host.ready()
    expect(host.tools().map((tool) => ({ name: tool.name, path: Codec.readText(tool.path) }))).toEqual([
      { name: "first", path: "fixture.files.one" },
      { name: "second", path: "fixture.files.two" },
    ])
  }, async () => { expect(await host.stop()).toEqual({ code: 0 }) })
})

const location = { directory: "/synthetic/project" }
const attempt = { id: "attempt_parent", status: "pending" }
const connection = { type: "env" as const, name: "SYNTHETIC_PARENT_KEY" }
const credential = { type: "key", key: "synthetic-parent-value" }
const integrationID = Integration.ID.make("fixture")
const oauthMethodID = Integration.MethodID.make("browser")
const commandMethodID = Integration.MethodID.make("command")
const attemptID = Integration.AttemptID.make("attempt_parent")
const operations: readonly Case[] = [
  { name: "reload", operation: "integration_reload", input: {}, run: (ctx) => ctx.integration.reload(), reply: null, expected: undefined },
  { name: "key", operation: "integration_connect_key", input: { integration: "fixture", key: Codec.text("synthetic-key"), label: Codec.text("Fixture") }, run: (ctx) => ctx.integration.connect.key({ integrationID, key: "synthetic-key", label: "Fixture" }), reply: null, expected: undefined },
  { name: "oauth connect", operation: "integration_oauth_connect", input: { integration: "fixture", method: "browser", inputs: Codec.value({ region: "test" }), label: Codec.text("Fixture") }, run: (ctx) => ctx.integration.oauth.connect({ integrationID, methodID: oauthMethodID, inputs: { region: "test" }, label: "Fixture" }), reply: { location, data: attempt }, expected: { location, data: attempt } },
  { name: "oauth status", operation: "integration_oauth_status", input: { integration: "fixture", attempt: "attempt_parent" }, run: (ctx) => ctx.integration.oauth.status({ integrationID, attemptID }), reply: { location, data: attempt }, expected: { location, data: attempt } },
  { name: "oauth complete", operation: "integration_oauth_complete", input: { integration: "fixture", attempt: "attempt_parent", code: Codec.text("synthetic-code") }, run: (ctx) => ctx.integration.oauth.complete({ integrationID, attemptID, code: "synthetic-code" }), reply: null, expected: undefined },
  { name: "oauth cancel", operation: "integration_oauth_cancel", input: { integration: "fixture", attempt: "attempt_parent" }, run: (ctx) => ctx.integration.oauth.cancel({ integrationID, attemptID }), reply: null, expected: undefined },
  { name: "command connect", operation: "integration_command_connect", input: { integration: "fixture", method: "command", label: Codec.text("Fixture") }, run: (ctx) => ctx.integration.command.connect({ integrationID, methodID: commandMethodID, label: "Fixture" }), reply: { location, data: attempt }, expected: { location, data: attempt } },
  { name: "command status", operation: "integration_command_status", input: { integration: "fixture", attempt: "attempt_parent" }, run: (ctx) => ctx.integration.command.status({ integrationID, attemptID }), reply: { location, data: attempt }, expected: { location, data: attempt } },
  { name: "command cancel", operation: "integration_command_cancel", input: { integration: "fixture", attempt: "attempt_parent" }, run: (ctx) => ctx.integration.command.cancel({ integrationID, attemptID }), reply: null, expected: undefined },
  { name: "resolve", operation: "integration_connection_resolve", input: { connection: Codec.value(connection) }, run: (ctx) => ctx.integration.connection.resolve(connection), reply: credential, expected: credential },
]

for (const entry of operations) {
  test(`PC01 parent Context ${entry.name} crosses the checked SDK wire and preserves its result`, async () => {
    const completed = Promise.withResolvers<Exit.Exit<unknown, unknown>>()
    const plugin: Plugin = {
      id: "parent.context",
      effect: (ctx) => entry.run(ctx).pipe(Effect.exit, Effect.tap((exit) => Effect.sync(() => completed.resolve(exit))), Effect.asVoid),
    }
    const host = start(plugin, { reply: () => ({ value: entry.reply }) })
    try {
      await host.ready()
      const exit = await completed.promise
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value).toEqual(entry.expected)
      expect(host.requests).toEqual([{ operation: entry.operation, payload: entry.input, owner: "plugin" }])
    } finally {
      await host.stop()
    }
  })
}

test("PC02 parent Context retains a leaf refusal instead of reporting unsupported or retrying", async () => {
  const completed = Promise.withResolvers<Exit.Exit<unknown, unknown>>()
  const host = start({
    id: "parent.refused",
    effect: (ctx) => ctx.integration.connection.resolve(connection).pipe(Effect.exit, Effect.tap((exit) => Effect.sync(() => completed.resolve(exit))), Effect.asVoid),
  }, { reply: () => ({ failure: { code: 1, message: "synthetic leaf refusal" } }) })
  try {
    await host.ready()
    const exit = await completed.promise
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("synthetic leaf refusal")
    expect(host.requests.map((item) => item.operation)).toEqual(["integration_connection_resolve"])
  } finally {
    await host.stop()
  }
})

test("PC03 integration draft exposes complete ref and method edits without serializing callbacks", async () => {
  const completed = Promise.withResolvers<Exit.Exit<unknown, unknown>>()
  const observations: unknown[] = []
  const oauth = Schema.decodeUnknownSync(Credential.OAuth)({ type: "oauth", methodID: "browser", access: "synthetic-access", refresh: "synthetic-refresh", expires: 1234567890000 })
  const authorize = () => Effect.succeed({ mode: "auto" as const, url: "https://invalid.test/authorize", instructions: "Synthetic fixture", callback: Effect.succeed(oauth) })
  const refresh = () => Effect.succeed(oauth)
  const label = () => "Synthetic account"
  const host = start({
    id: "parent.integration-draft",
    effect: (ctx) => ctx.integration.transform((draft) => {
      observations.push(draft.list().map((item) => item.id), draft.get("missing"), structuredClone(draft.method.list("keep")))
      draft.update("keep", (item) => { item.name = "Updated" })
      draft.update("created", (item) => { item.name = "Created" })
      draft.remove("removed")
      draft.method.remove("keep", { type: "env", names: ["OLD_FIXTURE"] })
      draft.method.update({ integrationID: "keep", method: { type: "key", label: "Key" } })
      draft.method.update({ integrationID: "keep", method: { type: "env", names: ["NEW_FIXTURE"] } })
      draft.method.update({ integrationID: "keep", method: { type: "command", id: "command", label: "Command", command: ["synthetic-command"] } })
      draft.method.update({ integrationID: "keep", method: { type: "oauth", id: "browser", label: "Browser" }, authorize, refresh, label })
    }).pipe(Effect.exit, Effect.tap((exit) => Effect.sync(() => completed.resolve(exit))), Effect.asVoid),
  })
  try {
    await host.ready()
    expect(Exit.isSuccess(await completed.promise)).toBe(true)
    const reply = await host.transform(10, { items: [{ id: "keep", name: "Keep", methods: [{ type: "env", names: ["OLD_FIXTURE"] }] }, { id: "removed", name: "Removed", methods: [] }] })
    expect(reply.failure).toBeUndefined()
    const output = object(Codec.readValue(reply.draft))
    const items = array(output.items).map(object)
    expect(items.map((item) => [item.id, item.name])).toEqual([["keep", "Updated"], ["created", "Created"]])
    const methods = array(items[0]?.methods).map(object)
    expect(methods.map((item) => item.type)).toEqual(["key", "env", "command", "oauth"])
    expect(methods[1]).toEqual({ type: "env", names: ["NEW_FIXTURE"] })
    expect(observations).toEqual([["keep", "removed"], undefined, [{ type: "env", names: ["OLD_FIXTURE"] }]])
    expect(JSON.stringify(output)).not.toContain("synthetic-access")
    expect(JSON.stringify(output)).not.toContain("function")
  } finally {
    await host.stop()
  }
})

test("PC04 late scoped hooks register, dispose once, and stop affecting native drafts", async () => {
  const captured = Promise.withResolvers<Context>()
  let calls = 0
  const scope = Effect.runSync(Scope.make())
  const host = start({ id: "parent.late-hook", effect: (ctx) => Effect.sync(() => captured.resolve(ctx)) })
  try {
    await host.ready()
    const ctx = await captured.promise
    const added = await Effect.runPromiseExit(Scope.provide(scope)(ctx.tool.hook("execute.before", (event) => Effect.sync(() => {
      calls++
      event.input = { changed: calls }
    }))))
    expect(Exit.isSuccess(added)).toBe(true)
    const first = await host.transform(7, { tool: "fixture", input: {} }, 1)
    expect(object(Codec.readValue(first.draft)).input).toEqual({ changed: 1 })
    if (Exit.isSuccess(added)) {
      await Effect.runPromise(added.value.dispose)
      await Effect.runPromise(added.value.dispose)
    }
    const second = await host.transform(7, { tool: "fixture", input: {} }, 2)
    expect(object(Codec.readValue(second.draft)).input).toEqual({})
    expect(calls).toBe(1)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await host.stop()
  }
})

test("PC05 late tool batches preserve old function references and Scope-owned unregister", async () => {
  const captured = Promise.withResolvers<Context>()
  const firstScope = Effect.runSync(Scope.make())
  const secondScope = Effect.runSync(Scope.make())
  const host = start({ id: "parent.tool-references", effect: (ctx) => Effect.sync(() => captured.resolve(ctx)) })
  const tool = (value: string) => ({ description: "Retained function", jsonSchema: { type: "object" as const }, execute: () => Effect.succeed({ structured: value, content: [] }) })
  try {
    await host.ready()
    const ctx = await captured.promise
    const first = await Effect.runPromiseExit(Scope.provide(firstScope)(ctx.tool.transform((draft) => draft.add("retained", tool("first"), { codemode: false }))))
    expect(Exit.isSuccess(first)).toBe(true)
    const old = host.tools().findLast((item) => item.name === "retained")
    expect(old).toBeDefined()
    const second = await Effect.runPromiseExit(Scope.provide(secondScope)(ctx.tool.transform((draft) => draft.add("retained", tool("second"), { codemode: false }))))
    expect(Exit.isSuccess(second)).toBe(true)
    const current = host.tools().findLast((item) => item.name === "retained")
    const firstCall = await host.execute("retained", 1, {}, old?.implementation)
    const secondCall = await host.execute("retained", 2, {}, current?.implementation)
    expect(Codec.readValue(object(firstCall.output).structured)).toBe("first")
    expect(Codec.readValue(object(secondCall.output).structured)).toBe("second")
    if (Exit.isSuccess(second)) await Effect.runPromise(second.value.dispose)
    const stillScoped = await host.execute("retained", 3, {}, current?.implementation)
    expect(Codec.readValue(object(stillScoped.output).structured)).toBe("second")
    await Effect.runPromise(Scope.close(secondScope, Exit.void))
    const unregistered = await host.execute("retained", 4, {}, current?.implementation)
    expect(Codec.readValue(object(unregistered.output).structured)).toBe("second")
    const retained = await host.execute("retained", 5, {}, old?.implementation)
    expect(Codec.readValue(object(retained.output).structured)).toBe("first")
    host.send({ release: { implementations: [current?.implementation] } })
    const released = await host.execute("retained", 6, {}, current?.implementation)
    expect(released.output).toBeUndefined()
    expect(released.failure).toBeDefined()
  } finally {
    await Effect.runPromise(Scope.close(secondScope, Exit.void))
    await Effect.runPromise(Scope.close(firstScope, Exit.void))
    await host.stop()
  }
})

test("PC06 tool path options and outputPaths survive the parent wire without changing their owner", async () => {
  const host = start({
    id: "parent.paths",
    effect: (ctx) => Effect.gen(function* () {
      yield* ctx.tool.transform((draft) => draft.add("read", { description: "Read fixture", jsonSchema: { type: "object" }, execute: () => Effect.succeed({ structured: true, content: [] }) }, { namespace: "fixture", paths: { read: "fixture.files.read" }, codemode: true }))
      yield* ctx.tool.hook("execute.after", (event) => Effect.sync(() => { event.outputPaths = ["/synthetic/output.txt"] }))
    }),
  })
  try {
    await host.ready()
    expect(Codec.readText(host.tools().find((item) => item.name === "read")?.path)).toBe("fixture.files.read")
    const transformed = await host.transform(8, { tool: "fixture_read", input: {}, result: { type: "json", value: true }, outputPaths: ["/synthetic/old.txt"] })
    expect(object(Codec.readValue(transformed.draft)).outputPaths).toEqual(["/synthetic/output.txt"])
  } finally {
    await host.stop()
  }
})

test("PC07 session.create forwards an explicit Location instead of narrowing the public API", async () => {
  const completed = Promise.withResolvers<Exit.Exit<unknown, unknown>>()
  const other = { directory: AbsolutePath.make("/synthetic/other") }
  const host = start({
    id: "parent.session-location",
    effect: (ctx) => ctx.session.create({ id: Session.ID.make("ses_created"), location: other }).pipe(Effect.exit, Effect.tap((exit) => Effect.sync(() => completed.resolve(exit))), Effect.asVoid),
  }, { reply: () => ({ value: { id: "ses_created" } }) })
  try {
    await host.ready()
    const exit = await completed.promise
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(host.requests).toHaveLength(1)
    expect(host.requests[0]?.operation).toBe("session_create")
    expect(Codec.readValue(host.requests[0]?.payload.location)).toEqual(other)
  } finally {
    await host.stop()
  }
})

test("PC08 a retained Context rejects after retirement and emits no new request", async () => {
  const captured = Promise.withResolvers<Context>()
  const host = start({ id: "parent.retired-context", effect: (ctx) => Effect.sync(() => captured.resolve(ctx)) })
  await host.ready()
  const ctx = await captured.promise
  await host.stop()
  const before = host.frames.length
  const exit = await Effect.runPromiseExit(ctx.agent.list().pipe(Effect.timeout("1 second")))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    const failure = Cause.pretty(exit.cause)
    expect(failure).toMatch(/closed|retired|ended/i)
    expect(failure).not.toContain("Timeout")
  }
  expect(host.frames).toHaveLength(before)
})

type DraftCase = {
  readonly name: string
  readonly stage: number
  readonly register: (ctx: Context) => Effect.Effect<{ readonly dispose: Effect.Effect<void> }, never, Scope.Scope>
  readonly input: unknown
  readonly expected: unknown
}

const drafts: readonly DraftCase[] = [
  {
    name: "agent", stage: 1,
    register: (ctx) => ctx.agent.transform((draft) => {
      expect(draft.list().map((item) => item.id)).toEqual(["keep", "remove"])
      expect(draft.get("keep")?.name).toBe("Keep")
      draft.update("keep", (item) => { item.name = Agent.Name.make("Updated") })
      draft.update("created", (item) => { item.name = Agent.Name.make("Created") })
      draft.remove("remove")
      draft.default("created")
    }),
    input: { items: [{ id: "keep", name: "Keep" }, { id: "remove", name: "Remove" }], default: "keep" },
    expected: { items: [{ id: "keep", name: "Updated" }, { id: "created", name: "Created" }], default: "created" },
  },
  {
    name: "command", stage: 2,
    register: (ctx) => ctx.command.transform((draft) => {
      expect(draft.list().map((item) => item.name)).toEqual(["keep", "remove"])
      expect(draft.get("keep")?.description).toBe("Keep")
      draft.update("keep", (item) => { item.description = "Updated" })
      draft.update("created", (item) => { item.description = "Created" })
      draft.remove("remove")
    }),
    input: { items: [{ name: "keep", description: "Keep" }, { name: "remove", description: "Remove" }] },
    expected: { items: [{ name: "keep", description: "Updated" }, { name: "created", description: "Created" }] },
  },
  {
    name: "reference", stage: 3,
    register: (ctx) => ctx.reference.transform((draft) => {
      expect(draft.list().map(([name]) => name)).toEqual(["remove"])
      draft.remove("remove")
      draft.add("created", { type: "git", repository: "https://invalid.test/synthetic.git", branch: "fixture" })
    }),
    input: { items: [{ name: "remove", type: "git", repository: "https://invalid.test/removed.git" }] },
    expected: { items: [{ name: "created", type: "git", repository: "https://invalid.test/synthetic.git", branch: "fixture" }] },
  },
  {
    name: "skill", stage: 4,
    register: (ctx) => ctx.skill.transform((draft) => {
      expect(draft.list()).toEqual([{ type: "url", url: "https://invalid.test/first.zip" }])
      draft.source({ type: "url", url: "https://invalid.test/second.zip" })
    }),
    input: { items: [{ type: "url", url: "https://invalid.test/first.zip" }] },
    expected: { items: [{ type: "url", url: "https://invalid.test/first.zip" }, { type: "url", url: "https://invalid.test/second.zip" }] },
  },
  {
    name: "integration", stage: 10,
    register: (ctx) => ctx.integration.transform((draft) => {
      expect(draft.list()).toEqual([])
      draft.update("fixture", (item) => { item.name = "Late integration" })
      draft.method.update({ integrationID: "fixture", method: { type: "key", label: "Late key" } })
    }),
    input: { items: [] },
    expected: { items: [{ id: "fixture", name: "Late integration", methods: [{ type: "key", label: "Late key" }] }] },
  },
  {
    name: "catalog", stage: 5,
    register: (ctx) => ctx.catalog.transform((draft) => {
      expect(draft.provider.list().map((item) => item.provider.id)).toEqual(["keep", "remove"])
      expect(draft.provider.get("keep")?.models.get("model")?.name).toBe("Model")
      expect(draft.model.get("keep", "model")?.name).toBe("Model")
      expect(draft.model.default.get()).toEqual({ providerID: "keep", modelID: "model", variant: "old", profile: "old-profile" })
      draft.provider.update("keep", (item) => { item.name = "Updated" })
      draft.provider.update("created", (item) => { item.name = "Created" })
      draft.provider.remove("remove")
      draft.model.update("keep", "model", (item) => { item.name = "Updated model" })
      draft.model.update("keep", "created", (item) => { item.name = "Created model" })
      draft.model.remove("keep", "model")
      draft.model.default.set("keep", "created", { variant: "new", profile: "new-profile" })
    }),
    input: { items: [{ provider: { id: "keep", name: "Keep" }, models: [{ id: "model", providerID: "keep", name: "Model" }], environment: [] }, { provider: { id: "remove", name: "Remove" }, models: [], environment: [] }], default: { providerID: "keep", id: "model", variant: "old", profile: "old-profile" } },
    expected: { items: [{ provider: { id: "keep", name: "Updated" }, models: [{ id: "created", providerID: "keep", name: "Created model" }], environment: [] }, { provider: { id: "created", name: "Created" }, models: [], environment: [] }], default: { providerID: "keep", id: "created", variant: "new", profile: "new-profile" } },
  },
]

for (const entry of drafts) {
  test(`PC09 late ${entry.name} drafts retain the complete public edit surface and scoped disposal`, async () => {
    const captured = Promise.withResolvers<Context>()
    const scope = Effect.runSync(Scope.make())
    const host = start({ id: "parent.late-domain", effect: (ctx) => Effect.sync(() => captured.resolve(ctx)) })
    try {
      await host.ready()
      const ctx = await captured.promise
      const registered = await Effect.runPromiseExit(Scope.provide(scope)(entry.register(ctx)))
      expect(Exit.isSuccess(registered)).toBe(true)
      const changed = await host.transform(entry.stage, entry.input, 1)
      expect(changed.failure).toBeUndefined()
      expect(Codec.readValue(changed.draft)).toEqual(entry.expected)
      if (Exit.isSuccess(registered)) await Effect.runPromise(registered.value.dispose)
      const original = await host.transform(entry.stage, entry.input, 2)
      expect(original.failure).toBeUndefined()
      expect(Codec.readValue(original.draft)).toEqual(entry.input)
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await host.stop()
    }
  })
}

test("PC11 late session hooks use the native context draft and stop after disposal", async () => {
  const captured = Promise.withResolvers<Context>()
  const scope = Effect.runSync(Scope.make())
  let calls = 0
  const host = start({ id: "parent.late-session", effect: (ctx) => Effect.sync(() => captured.resolve(ctx)) })
  const input = { sessionID: "ses_fixture", agent: "build", model: { providerID: "fixture", id: "model" }, system: [], messages: [], tools: [] }
  try {
    await host.ready()
    const ctx = await captured.promise
    const registered = await Effect.runPromiseExit(Scope.provide(scope)(ctx.session.hook("context", (event) => Effect.sync(() => {
      calls++
      event.system.push({ type: "text", text: "late-session" })
    }))))
    expect(Exit.isSuccess(registered)).toBe(true)
    const changed = object(Codec.readValue((await host.transform(6, input, 1)).draft))
    expect(array(changed.system).map((item) => object(item).text)).toEqual(["late-session"])
    if (Exit.isSuccess(registered)) await Effect.runPromise(registered.value.dispose)
    const original = object(Codec.readValue((await host.transform(6, input, 2)).draft))
    expect(original.system).toEqual([])
    expect(calls).toBe(1)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await host.stop()
  }
})

test("PC12 late AI SDK hooks retain the actual SDK object and language override, then unregister", async () => {
  const captured = Promise.withResolvers<Context>()
  const scope = Effect.runSync(Scope.make())
  const events: string[] = []
  const language: NonNullable<AISDKHooks["language"]["language"]> = {
    specificationVersion: "v3",
    provider: "synthetic-sdk",
    modelId: "fixture",
    supportedUrls: {},
    doGenerate: async () => { throw new Error("Unexpected non-streaming parent fixture request") },
    doStream: async () => ({ stream: new ReadableStream<never>({ start(controller) { controller.close() } }) }),
  }
  const sdk = Object.freeze({ languageModel: () => language })
  const host = start({ id: "parent.late-sdk", effect: (ctx) => Effect.sync(() => captured.resolve(ctx)) })
  try {
    await host.ready()
    const ctx = await captured.promise
    const first = await Effect.runPromiseExit(Scope.provide(scope)(ctx.aisdk.hook("sdk", (event) => Effect.sync(() => {
      events.push("sdk")
      event.sdk = sdk
    }))))
    const second = await Effect.runPromiseExit(Scope.provide(scope)(ctx.aisdk.hook("language", (event) => Effect.sync(() => {
      events.push("language")
      expect(event.sdk).toBe(sdk)
      event.language = language
    }))))
    expect(Exit.isSuccess(first)).toBe(true)
    expect(Exit.isSuccess(second)).toBe(true)
    host.send({ language_resolve: { request: 1, package: "synthetic-sdk", model: Codec.value({ id: "first" }), options: Codec.value({}) } })
    expect((await host.next("language_resolved", (item) => item.request === 1)).handled).toBe(true)
    expect(events).toEqual(["sdk", "language"])
    if (Exit.isSuccess(second)) await Effect.runPromise(second.value.dispose)
    if (Exit.isSuccess(first)) await Effect.runPromise(first.value.dispose)
    host.send({ language_resolve: { request: 2, package: "synthetic-sdk", model: Codec.value({ id: "second" }), options: Codec.value({}) } })
    expect((await host.next("language_resolved", (item) => item.request === 2)).handled).toBe(false)
    expect(events).toEqual(["sdk", "language"])
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await host.stop()
  }
})

for (const mode of ["auto", "code"] as const) {
  test(`PC10 ${mode} OAuth uses pinned original functions, preserves its Scope, and refreshes/labels the original credential`, async () => {
    const events: string[] = []
    let revision = 0
    const oauth = Schema.decodeUnknownSync(Credential.OAuth)({ type: "oauth", methodID: "browser", access: "synthetic-access", refresh: "synthetic-refresh", expires: 1234567890000 })
    const host = start({
      id: "parent.oauth-functions",
      effect: (ctx) => ctx.integration.transform((draft) => {
        const version = ++revision
        const captured = Object.freeze({ version })
        const finish = () => Effect.sync(() => { events.push(`callback.${captured.version}`); return oauth })
        draft.update("fixture", (item) => { item.name = "Fixture" })
        draft.method.update({
          integrationID: "fixture",
          method: { type: "oauth", id: "browser", label: "Browser" },
          authorize: () => Effect.gen(function* () {
            events.push(`authorize.${captured.version}`)
            yield* Effect.addFinalizer(() => Effect.sync(() => { events.push(`close.${captured.version}`) }))
            const common = { url: `https://invalid.test/oauth/${captured.version}`, instructions: "Synthetic authorization" }
            if (mode === "auto") return { ...common, mode, callback: finish(), submitCode: (code: string) => Effect.sync(() => { events.push(`submit.${captured.version}.${code}`) }) }
            return { ...common, mode, callback: (code: string) => Effect.sync(() => { events.push(`code.${captured.version}.${code}`) }).pipe(Effect.andThen(finish())) }
          }),
          refresh: (value) => Effect.sync(() => { events.push(`refresh.${captured.version}`); return { ...value, access: `synthetic-refreshed-${captured.version}` } }),
          label: () => { events.push(`label.${captured.version}`); return `account-${captured.version}` },
        })
      }).pipe(Effect.asVoid),
    })
    try {
      await host.ready()
      const before = await host.transform(10, { items: [] }, 1)
      const after = await host.transform(10, { items: [] }, 2)
      const previous = array(before.oauth).map(object).find((item) => object(Codec.readValue(item.method)).id === "browser")
      const current = array(after.oauth).map(object).find((item) => object(Codec.readValue(item.method)).id === "browser")
      expect(previous?.implementation).not.toBe(current?.implementation)
      host.send({ auth: { request: 1, authorize: { integration: "fixture", method: "browser", implementation: previous?.implementation, inputs: Codec.value({}) } } })
      const grant = object((await host.next("auth_reply", (item) => item.request === 1)).authorization)
      expect(Codec.readText(grant.url)).toBe("https://invalid.test/oauth/1")
      expect(events).toEqual(["authorize.1"])
      if (mode === "auto") {
        expect(grant.manual_code).toBe(true)
        host.send({ auth: { request: 2, submit: { authorization: 1, code: Codec.text("fixture-submit") } } })
        expect((await host.next("auth_reply", (item) => item.request === 2)).done).toEqual({})
        expect(events).toEqual(["authorize.1", "submit.1.fixture-submit"])
      }
      host.send({ auth: { request: 3, callback: { authorization: 1, ...(mode === "code" ? { code: Codec.text("fixture-code") } : {}) } } })
      const completed = await host.next("auth_reply", (item) => item.request === 3)
      expect(Codec.readValue(completed.credential)).toEqual(oauth)
      expect(events.filter((item) => item === "close.1")).toHaveLength(1)
      host.send({ auth: { request: 4, label: { integration: "fixture", method: "browser", implementation: previous?.implementation, credential: Codec.value(oauth) } } })
      expect(Codec.readText((await host.next("auth_reply", (item) => item.request === 4)).label)).toBe("account-1")
      host.send({ auth: { request: 5, refresh: { integration: "fixture", method: "browser", implementation: previous?.implementation, credential: Codec.value(oauth) } } })
      expect(object(Codec.readValue((await host.next("auth_reply", (item) => item.request === 5)).credential)).access).toBe("synthetic-refreshed-1")
      host.send({ auth: { request: 6, authorize: { integration: "fixture", method: "browser", implementation: current?.implementation, inputs: Codec.value({}) } } })
      await host.next("auth_reply", (item) => item.request === 6)
      await host.stop()
      expect(events.filter((item) => item === "close.1")).toHaveLength(1)
      expect(events.filter((item) => item === "close.2")).toHaveLength(1)
      expect(events).toContain("callback.1")
      expect(events).toContain("refresh.1")
      expect(events).toContain("label.1")
      if (mode === "code") expect(events).toContain("code.1.fixture-code")
    } finally {
      await host.stop()
    }
  })
}

test("PC13 an ended tool call cannot resurrect its ambient authority as a generation call", async () => {
  const resume = Promise.withResolvers<void>()
  const completed = Promise.withResolvers<Exit.Exit<unknown, unknown>>()
  const host = start({
    id: "parent.retired-call",
    effect: (ctx) => ctx.tool.transform((draft) => draft.add("complete", {
      description: "Retain an ended call context",
      jsonSchema: { type: "object" },
      execute: () => Effect.sync(() => {
        void resume.promise.then(async () => completed.resolve(await Effect.runPromiseExit(
          ctx.mcp.callTool({ server: "fixture", name: "scoped", args: {} }).pipe(Effect.timeout("1 second")),
        )))
        return { structured: true, content: [] }
      }),
    }, { codemode: false })).pipe(Effect.asVoid),
  }, { reply: () => ({ value: { content: [] } }) })
  try {
    await host.ready()
    const result = await host.execute("complete")
    expect(result.failure).toBeUndefined()
    resume.resolve()
    const exit = await completed.promise
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toMatch(/owner|call|cancel|ended/i)
      expect(Cause.pretty(exit.cause)).not.toContain("Timeout")
    }
    expect(host.requests).toHaveLength(0)
  } finally {
    resume.resolve()
    await host.stop()
  }
})
