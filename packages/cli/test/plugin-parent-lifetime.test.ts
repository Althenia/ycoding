import type { Plugin } from "@ycoding-ai/plugin/effect/plugin"
import type { AISDKHooks } from "@ycoding-ai/plugin/effect/aisdk"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Codec } from "../src/plugin-host/codec"
import { call, checked, failures, start } from "./fixtures/plugin-parent/harness"

test("PL01 EOF interrupts an admitted tool and joins its actual finalizer before host settlement", async () => {
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const cleanup = Promise.withResolvers<void>()
  const cleaned = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const events: string[] = []
  const host = start({
    id: "parent.tool-owner",
    effect: (ctx) => ctx.tool.transform((draft) => draft.add("held", {
      description: "Owned asynchronous tool",
      jsonSchema: { type: "object" },
      execute: () => Effect.scoped(Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.promise(async () => {
          events.push("cleanup.start")
          cleanup.resolve()
          await release.promise
          events.push("cleanup.end")
          cleaned.resolve()
        }))
        entered.resolve()
        yield* Effect.promise(() => finish.promise)
        return { structured: true, content: [] }
      })),
    }, { codemode: false })).pipe(Effect.asVoid),
  })
  void host.outcome.then(() => events.push("host.closed"))
  try {
    await host.ready()
    const result = host.execute("held")
    void result.catch(() => undefined)
    await entered.promise
    host.end()
    const first = await Promise.race([cleanup.promise.then(() => "cleanup"), host.outcome.then(() => "closed")])
    expect(first).toBe("cleanup")
    release.resolve()
    const outcome = await host.outcome
    expect("error" in outcome || outcome.code !== 0).toBe(true)
    expect(events).toEqual(["cleanup.start", "cleanup.end", "host.closed"])
    expect(host.frames.filter((frame) => frame.result)).toHaveLength(0)
  } finally {
    finish.resolve()
    release.resolve()
    await cleaned.promise
    await host.stop()
  }
})

test("PL02 shutdown joins an executing hook before stopped and never emits a late transformed result", async () => {
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const cleanup = Promise.withResolvers<void>()
  const cleaned = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const events: string[] = []
  const host = start({
    id: "parent.hook-owner",
    effect: (ctx) => ctx.tool.hook("execute.before", () => Effect.scoped(Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.promise(async () => {
        events.push("hook.cleanup.start")
        cleanup.resolve()
        await release.promise
        events.push("hook.cleanup.end")
        cleaned.resolve()
      }))
      entered.resolve()
      yield* Effect.promise(() => finish.promise)
    }))).pipe(Effect.asVoid),
  }, { write: async (frame) => { if (frame.stopped) events.push("stopped") } })
  try {
    await host.ready()
    const transformed = host.transform(7, { tool: "held", input: {} })
    void transformed.catch(() => undefined)
    await entered.promise
    host.send({ shutdown: {} })
    const first = await Promise.race([cleanup.promise.then(() => "cleanup"), host.outcome.then(() => "closed")])
    expect(first).toBe("cleanup")
    release.resolve()
    expect(await host.outcome).toEqual({ code: 0 })
    expect(events).toEqual(["hook.cleanup.start", "hook.cleanup.end", "stopped"])
    expect(host.frames.filter((frame) => frame.transformed)).toHaveLength(0)
    expect(host.frames.filter((frame) => frame.cleanup)).toHaveLength(1)
  } finally {
    finish.resolve()
    release.resolve()
    await cleaned.promise
    await host.stop()
  }
})

test("PL03 EOF joins Plugin.effect setup instead of allowing it to register after closure", async () => {
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const exited = Promise.withResolvers<void>()
  let finalizers = 0
  const host = start({
    id: "parent.setup-owner",
    effect: () => Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => { finalizers++ }))
      entered.resolve()
      yield* Effect.promise(() => finish.promise)
    }).pipe(Effect.onExit(() => Effect.sync(() => exited.resolve()))),
  })
  try {
    await entered.promise
    host.end()
    const first = await Promise.race([exited.promise.then(() => "setup.exited"), host.outcome.then(() => "host.closed")])
    expect(first).toBe("setup.exited")
    const outcome = await host.outcome
    expect("error" in outcome || outcome.code !== 0).toBe(true)
    expect(finalizers).toBe(1)
    expect(host.frames.some((frame) => frame.register_tools)).toBe(false)
  } finally {
    finish.resolve()
    await exited.promise
    await host.stop()
  }
})

test("PL04 EOF interrupts and joins an AI SDK hook with a live scoped resource", async () => {
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const cleaned = Promise.withResolvers<void>()
  let closes = 0
  const host = start({
    id: "parent.sdk-hook-owner",
    effect: (ctx) => ctx.aisdk.hook("sdk", () => Effect.scoped(Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => { closes++; cleaned.resolve() }))
      entered.resolve()
      yield* Effect.promise(() => finish.promise)
    }))).pipe(Effect.asVoid),
  })
  try {
    await host.ready()
    host.send({ language_resolve: { request: 1, package: "synthetic-sdk", model: Codec.value({ id: "fixture" }), options: Codec.value({}) } })
    await entered.promise
    host.end()
    const first = await Promise.race([cleaned.promise.then(() => "cleaned"), host.outcome.then(() => "closed")])
    expect(first).toBe("cleaned")
    await host.outcome
    expect(closes).toBe(1)
    expect(host.frames.filter((frame) => frame.language_resolved)).toHaveLength(0)
  } finally {
    finish.resolve()
    await cleaned.promise
    await host.stop()
  }
})

test("PL05 EOF joins a late doStream producer and its stream cancellation before returning", async () => {
  const entered = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const produce = Promise.withResolvers<void>()
  const cancel = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const cleaned = Promise.withResolvers<void>()
  const events: string[] = []
  const plugin: Plugin = {
    id: "parent.stream-owner",
    effect: (ctx) => ctx.aisdk.hook("sdk", (event) => Effect.sync(() => {
      event.sdk = {
        languageModel: (): NonNullable<AISDKHooks["language"]["language"]> => ({
          specificationVersion: "v3",
          provider: "synthetic-sdk",
          modelId: "fixture",
          supportedUrls: {},
          doGenerate: async () => { throw new Error("Unexpected non-streaming parent lifetime request") },
          doStream: async (options) => {
            if (!options.abortSignal) throw new Error("Parent lifetime request has no abort signal")
            options.abortSignal.addEventListener("abort", () => aborted.resolve(), { once: true })
            entered.resolve()
            await produce.promise
            return { stream: new ReadableStream<never>({
              async cancel() {
                events.push("stream.cancel.start")
                cancel.resolve()
                await release.promise
                events.push("stream.cancel.end")
                cleaned.resolve()
              },
            }) }
          },
        }),
      }
    })).pipe(Effect.asVoid),
  }
  const host = start(plugin)
  void host.outcome.then(() => events.push("host.closed"))
  try {
    await host.ready()
    host.send({ language_attempt: { request: 1, package: "synthetic-sdk", model: Codec.value({ id: "fixture" }), options: Codec.value({}), body: Codec.value({}) } })
    await entered.promise
    host.end()
    await aborted.promise
    produce.resolve()
    const first = await Promise.race([cancel.promise.then(() => "cancel"), host.outcome.then(() => "closed")])
    expect(first).toBe("cancel")
    release.resolve()
    await host.outcome
    expect(events).toEqual(["stream.cancel.start", "stream.cancel.end", "host.closed"])
    expect(host.frames.filter((frame) => frame.language_result)).toHaveLength(1)
  } finally {
    produce.resolve()
    release.resolve()
    await cleaned.promise
    await host.stop()
  }
})

test("PL06 original setup and cleanup failures both survive host settlement", async () => {
  let cleanups = 0
  const host = start({
    id: "parent.two-failures",
    effect: () => Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => { cleanups++ }).pipe(Effect.andThen(Effect.die(new Error("synthetic cleanup origin")))))
      yield* Effect.die(new Error("synthetic setup origin"))
    }),
  })
  const outcome = await host.outcome
  expect(cleanups).toBe(1)
  expect("error" in outcome).toBe(true)
  if ("error" in outcome) {
    expect(failures(outcome.error)).toContain("synthetic setup origin")
    expect(failures(outcome.error)).toContain("synthetic cleanup origin")
  }
  await host.stop()
})

test("PL07 a repeated invocation cannot replace or detach its original owner", async () => {
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const cleaned = Promise.withResolvers<void>()
  let starts = 0
  let closes = 0
  const host = start({
    id: "parent.duplicate-call",
    effect: (ctx) => ctx.tool.transform((draft) => draft.add("held", {
      description: "Invocation identity fixture",
      jsonSchema: { type: "object" },
      execute: () => Effect.scoped(Effect.gen(function* () {
        starts++
        yield* Effect.addFinalizer(() => Effect.sync(() => { closes++; if (closes === starts) cleaned.resolve() }))
        entered.resolve()
        yield* Effect.promise(() => finish.promise)
        return { structured: true, content: [] }
      })),
    }, { codemode: false })).pipe(Effect.asVoid),
  })
  try {
    await host.ready()
    host.send({ execute: { call: call(1), namespace: "", tool: "held", input: Codec.value({}) } })
    await entered.promise
    host.send({ execute: { call: call(1), namespace: "", tool: "held", input: Codec.value({}) } })
    host.end()
    const outcome = await host.outcome
    expect("error" in outcome || outcome.code !== 0).toBe(true)
    expect(starts).toBe(1)
    expect(closes).toBe(1)
    expect(host.frames.filter((frame) => frame.result || frame.cleanup)).toHaveLength(1)
  } finally {
    finish.resolve()
    await cleaned.promise
    await host.stop()
  }
})

for (const fault of ["truncated", "foreign-generation"] as const) {
  test(`PL08 ${fault} input fails closed and still joins the generation Scope`, async () => {
    let closed = 0
    const host = start({ id: "parent.fault", effect: () => Effect.addFinalizer(() => Effect.sync(() => { closed++ })) })
    await host.ready()
    if (fault === "truncated") host.sendBytes(Codec.frame(new Uint8Array([0x80])).slice(0, -1))
    else host.send({ shutdown: {} }, "ext_foreign")
    host.end()
    const outcome = await host.outcome
    expect("error" in outcome || outcome.code !== 0).toBe(true)
    expect(closed).toBe(1)
    expect(host.frames.filter((frame) => frame.stopped)).toHaveLength(0)
    await host.stop()
  })
}

test("PL09 stopping releases the owned input iterator instead of leaving its producer open", async () => {
  const host = start({ id: "parent.input-owner", effect: () => Effect.void })
  await host.ready()
  expect(await host.stop()).toEqual({ code: 0 })
  expect(host.returned()).toBe(1)
  expect(host.frames.filter((frame) => frame.stopped)).toHaveLength(1)
})

test("PL10 retiring pending setup IO settles its caller once and never sends a successful registration", async () => {
  const exited = Promise.withResolvers<void>()
  let completions = 0
  let finalizers = 0
  const host = start({
    id: "parent.pending-setup",
    effect: (ctx) => Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => { finalizers++ }))
      yield* ctx.mcp.servers()
    }).pipe(Effect.onExit(() => Effect.sync(() => { completions++; exited.resolve() })), Effect.orDie),
  })
  await host.next("plugin_call")
  host.end()
  await host.outcome
  await exited.promise
  expect(completions).toBe(1)
  expect(finalizers).toBe(1)
  expect(host.frames.filter((frame) => frame.register_tools)).toHaveLength(0)
  expect(host.frames.filter((frame) => frame.stopped)).toHaveLength(0)
  await host.stop()
})

test("PL11 interrupted original Promise setup retains its returned cleanup until it joins", async () => {
  const cleanup = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let setupSettled = false
  let cleaned = 0
  const host = start({
    id: "parent.promise-setup-owner",
    setup: async (ctx) => {
      try { await ctx.mcp.servers() } catch {}
      setupSettled = true
      return async () => { cleanup.resolve(); await release.promise; cleaned++ }
    },
  })
  await checked(async () => {
    await host.next("plugin_call")
    host.end()
    expect(await Promise.race([cleanup.promise.then(() => "cleanup"), host.outcome.then(() => "closed")])).toBe("cleanup")
    expect(setupSettled).toBe(true)
    expect(cleaned).toBe(0)
    release.resolve()
    await host.outcome
    expect(cleaned).toBe(1)
    expect(host.frames.filter((frame) => frame.stopped)).toHaveLength(0)
  }, () => release.resolve(), () => host.stop())
})
