import childProcess, { type ChildProcess } from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import path from "node:path"
import type { Plugin } from "@ycoding-ai/plugin/effect/plugin"
import type { Tool } from "@ycoding-ai/plugin/effect/tool"
import { Credential } from "@ycoding-ai/schema/credential"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { Effect, Exit, Schema, Stream } from "effect"
import { Codec } from "../../../src/plugin-host/codec"

const emit = (value: Record<string, unknown>): void => { process.send?.(value) }
const mode = process.env.YCODING_TEST_PARENT_MODE ?? "normal"
const nativeExecutable = process.env.YCODING_RUNTIME_EXECUTABLE
const release = Promise.withResolvers<void>()
const setupRelease = Promise.withResolvers<void>()
const originalSpawn = childProcess.spawn
let native: ChildProcess | undefined
let setup = 0
let calls = 0
let hooks = 0
let agentRebuilds = 0
let closes = 0
let injected = false
let observedContext: Parameters<Plugin["effect"]>[0] | undefined
let cleanupStarted = false
const contexts: Array<Parameters<Plugin["effect"]>[0]> = []
const retiredProbes: Array<() => Effect.Effect<unknown, unknown>> = []

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a carrier object")
  return value as Record<string, unknown>
}

function text(error: unknown): string {
  if (error instanceof AggregateError) return [error.message, ...error.errors.map(text)].join("\n")
  if (error instanceof Error) return [error.message, text(error.cause)].join("\n")
  return error === undefined ? "" : String(error)
}

const trackedSpawn = (command: string, ...parameters: unknown[]) => {
  const owned = nativeExecutable !== undefined && path.resolve(command) === path.resolve(nativeExecutable)
  if (owned && Array.isArray(parameters[0])) {
    const args = parameters[0].map(String)
    const data = args.indexOf("--plugin-parent-fd")
    const cleanup = args.indexOf("--plugin-parent-cleanup-fd")
    if (mode === "invalid-descriptor" || mode === "aliased-descriptor") {
      if (data < 0 || cleanup < 0) emit({ kind: "fixture-prerequisite", detail: "explicit parent descriptors absent" })
      else {
        args[cleanup + 1] = mode === "invalid-descriptor" ? "99" : String(args[data + 1])
        injected = true
        emit({ kind: "injected", fault: mode })
      }
    }
    parameters[0] = args
  }
  const child = Reflect.apply(originalSpawn, childProcess, [command, ...parameters]) as ChildProcess
  if (!owned) return child
  native = child
  emit({ kind: "native", pid: child.pid })
  child.once("exit", (code, signal) => emit({ kind: "native-exit", pid: child.pid, code, signal, cleanupStarted, closes }))
  const pipe = child.stdio[3]
  if ((mode === "foreign-binding" || mode === "foreign-generation") && pipe && "write" in pipe) {
    const write = pipe.write
    const reader = new Codec.FrameReader()
    const rewrite = (chunk: Uint8Array, ...rest: unknown[]) => {
      const payloads = reader.push(chunk)
      if (payloads.length !== 1) throw new Error("Carrier fixture requires one complete frame per write")
      const frame = Codec.decode("ParentFrame", payloads[0]!)
      if (!injected && mode === "foreign-binding" && frame.manifest) {
        object(frame.manifest).pid = process.pid
        injected = true
      }
      if (!injected && mode === "foreign-generation" && frame.data) {
        object(frame.data).generation = "ext_foreign_fixture"
        injected = true
      }
      if (injected) emit({ kind: "injected", fault: mode })
      return Reflect.apply(write, pipe, [Codec.frame(Codec.encode("ParentFrame", frame)), ...rest])
    }
    Object.defineProperty(pipe, "write", { configurable: true, writable: true, value: rewrite })
  }
  return child
}

Object.defineProperty(childProcess, "spawn", { configurable: true, writable: true, value: trackedSpawn })
syncBuiltinESMExports()

const controls = (message: unknown) => {
  const command = object(message).command
  if (command === "release-cleanup") release.resolve()
  if (command === "release-setup") setupRelease.resolve()
  if (command === "post-reload") {
    const context = observedContext
    if (!context) emit({ kind: "fixture-prerequisite", detail: "published Context is not prepared" })
    else {
      const before = agentRebuilds
      void Effect.runPromiseExit(context.agent.reload()).then((exit) => emit({ kind: "post-reload", accepted: Exit.isSuccess(exit), before, after: agentRebuilds }))
    }
  }
  if (command === "probe-retired") {
    const probe = retiredProbes[0]
    if (!probe) emit({ kind: "fixture-prerequisite", detail: "retired generation probe is not prepared" })
    else void Effect.runPromiseExit(probe()).then((exit) => emit({ kind: "retired-generation", rejected: Exit.isFailure(exit) }))
  }
  if (command === "break-data") {
    const pipe = native?.stdio[3]
    if (!pipe) emit({ kind: "fixture-prerequisite", detail: "native fd3 is not exposed by the actual process owner" })
    else {
      injected = true
      emit({ kind: "injected", fault: "data" })
      pipe.destroy(new Error("synthetic parent data failure"))
    }
  }
  if (command === "force-stop") {
    const signalled = native?.kill(object(message).signal === "SIGKILL" ? "SIGKILL" : "SIGTERM") ?? false
    emit({ kind: "force-stop", pid: native?.pid, signalled })
  }
}
process.on("message", controls)
emit({ kind: "embedding", pid: process.pid })

const superseded: Plugin = { id: "parent.shared", effect: () => Effect.sync(() => emit({ kind: "superseded" })) }
const stable: Plugin = { id: "parent.stable", effect: () => Effect.sync(() => emit({ kind: "setup", plugin: "stable", pid: process.pid })) }
const witness = new WeakMap<object, string>()
const identity = Object.freeze({ label: "original-object" })
witness.set(identity, "retained")
const winner: Plugin = {
  id: "parent.shared",
  effect: (ctx) => Effect.gen(function* () {
    const current = ++setup
    let local = 0
    contexts.push(ctx)
    observedContext = ctx
    emit({ kind: "setup", plugin: "winner", pid: process.pid, setup: current, witness: witness.get(identity) === "retained" })
    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      cleanupStarted = true
      emit({ kind: "cleanup-start", setup: current, pid: process.pid })
      if (mode === "held-cleanup" || mode === "broken-data" || mode === "failed-setup") await release.promise
      closes++
      emit({ kind: "cleanup-end", setup: current, pid: process.pid, closes })
      if (mode === "failed-setup") throw new Error("synthetic cleanup origin")
    }))
    yield* ctx.session.hook("context", (event) => Effect.sync(() => {
      hooks++
      event.system.push({ type: "text", text: "parent-original-context" })
      emit({ kind: "hook", pid: process.pid, setup: current, hooks, sessionID: event.sessionID })
    }))
    yield* ctx.tool.transform((draft) => draft.add(mode === "invalid-tool-name" ? "123counter" : "parent_counter", {
      description: "Return the original parent closure state",
      jsonSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: (_input: unknown, context: Tool.Context) => Effect.sync(() => {
        calls++
        local++
        const value = { pid: process.pid, setup: current, count: calls, local, witness: witness.get(identity) === "retained" }
        emit({ kind: "tool", ...value, callID: context.callID, sessionID: context.sessionID })
        return { structured: value, content: [{ type: "text" as const, text: JSON.stringify(value) }] }
      }),
    }, { codemode: false, namespace: mode === "invalid-tool-namespace" ? "fixture.1invalid" : undefined, paths: mode === "invalid-tool-path" ? { parent_counter: "fixture.1invalid.read" } : undefined }))
    yield* ctx.event.subscribe().pipe(
      Stream.take(1),
      Stream.runForEach(() => Effect.sync(() => emit({ kind: "event", pid: process.pid, setup: current }))),
      Effect.forkScoped,
    )
    if (mode === "post-reload") yield* ctx.agent.transform(() => { agentRebuilds++; emit({ kind: "agent-rebuilt", count: agentRebuilds, setup: current }) })
    if (mode === "oauth") {
      const oauth = Schema.decodeUnknownSync(Credential.OAuth)({ type: "oauth", methodID: "browser", access: "synthetic-parent-access", refresh: "synthetic-parent-refresh", expires: 4102444800000 })
      let authorizations = 0
      yield* ctx.integration.transform((draft) => {
        draft.update("parent-oauth", (entry) => { entry.name = "Synthetic parent OAuth" })
        draft.method.update({
          integrationID: "parent-oauth", method: { type: "oauth", id: "browser", label: "Synthetic browser" },
          authorize: () => Effect.gen(function* () {
            const authorization = ++authorizations
            emit({ kind: "oauth-authorize", authorization, setup: current, pid: process.pid, witness: witness.get(identity) === "retained" })
            yield* Effect.addFinalizer(() => Effect.sync(() => emit({ kind: "oauth-close", authorization, setup: current })))
            return { url: "https://invalid.test/parent-oauth", instructions: "Synthetic local authorization", mode: "code" as const,
              callback: (code: string) => Effect.sync(() => {
                emit({ kind: "oauth-callback", authorization, code, setup: current, witness: witness.get(identity) === "retained" })
                return oauth
              }),
            }
          }),
          refresh: (value) => Effect.succeed({ ...value, access: "synthetic-parent-refreshed" }),
          label: () => "Synthetic parent account",
        })
      })
    }
    if (mode === "setup-session" || mode === "refresh") {
      const session = yield* ctx.session.create({ model: { providerID: Provider.ID.make("parent-fixture"), id: Model.ID.make("parent-model") } })
      retiredProbes.push(() => ctx.session.generate({ sessionID: session.id, prompt: "parent-retired-generation" }))
      const generated = yield* ctx.session.generate({ sessionID: session.id, prompt: "parent-setup-generation" })
      const admitted = yield* ctx.session.prompt({ sessionID: session.id, text: "Use $fixture", resume: false })
      emit({ kind: "setup-session", setup: current, generated: generated.text, admitted })
      yield* ctx.agent.reload()
      emit({ kind: "reload-queued", setup: current })
    }
    if (mode === "setup-runner") {
      const session = yield* ctx.session.create({ model: { providerID: Provider.ID.make("parent-fixture"), id: Model.ID.make("parent-model") } })
      const admitted = yield* ctx.session.prompt({ sessionID: session.id, text: "parent-setup-runner", resume: true })
      emit({ kind: "setup-runner", setup: current, sessionID: session.id, admitted })
      yield* Effect.promise(() => setupRelease.promise)
      emit({ kind: "setup-runner-released", setup: current, sessionID: session.id })
    }
    if (mode === "failed-setup") yield* Effect.die(new Error("synthetic setup origin"))
  }).pipe(Effect.orDie),
}

try {
  if (process.argv.includes("plugin-host")) throw new Error("Embedding entrypoint replayed as a module host")
  const { ServerProcess } = await import("../../../src/server-process")
  await Effect.runPromise(ServerProcess.run({ mode: "stdio", hostname: "127.0.0.1", port: 0, plugins: mode === "ambient" ? [] : [superseded, stable, winner] }))
  if (observedContext) {
    const retired = await Effect.runPromiseExit(observedContext.agent.list().pipe(Effect.timeout("1 second")))
    emit({ kind: "retired", rejected: Exit.isFailure(retired) })
  }
  emit({ kind: "done", pid: process.pid, setup, calls, hooks, closes, contexts: contexts.length, injected })
} catch (error) {
  const message = text(error)
  emit({ kind: "error", original: message.includes("synthetic setup origin"), cleanup: message.includes("synthetic cleanup origin"), boundary: /parent|generation|descriptor|binding/i.test(message), injected, setup, closes })
  process.exitCode = 1
} finally {
  Object.defineProperty(childProcess, "spawn", { configurable: true, writable: true, value: originalSpawn })
  syncBuiltinESMExports()
  process.off("message", controls)
  process.disconnect?.()
}
