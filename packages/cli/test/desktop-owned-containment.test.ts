import { expect, spyOn, test } from "bun:test"
import { Effect, Option } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@ycoding-ai/core/global"
import path from "node:path"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import handler from "../src/commands/handlers/desktop-host"
import { ServerConnection } from "../src/services/server-connection"
import { Standalone } from "../src/services/standalone"

const root = process.env.YCODING_DESKTOP_TEST_TASK
if (!root) throw new Error("A private containment-test Task is required")
const run = (input: Parameters<typeof handler>[0]) => Effect.runPromiseExit(handler(input).pipe(
  Effect.provide(Global.layerWith({ data: path.join(root, "data"), config: path.join(root, "config"), state: path.join(root, "state") })),
  Effect.provide(NodeFileSystem.layer),
))

test("desktop own server requests a non-detached private backend", async () => {
  const stop = new Error("synthetic resolution stop")
  const resolve = spyOn(ServerConnection, "resolve").mockImplementation(() => Effect.fail(stop))
  try {
    await run({ backend: "/synthetic/ycoding", mode: "own", server: Option.none() })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0]?.[0].privateServer).toEqual({ command: ["/synthetic/ycoding", "serve"], detached: false })
  } finally {
    resolve.mockRestore()
  }
})

test("desktop terminal observation follows the owned connection scope release", async () => {
  const ended = Object.getOwnPropertyDescriptor(process.stdin, "readableEnded")
  Object.defineProperty(process.stdin, "readableEnded", { configurable: true, get: () => false })
  let released = false
  const records: unknown[] = []
  const resolve = spyOn(ServerConnection, "resolve").mockImplementation(() => Effect.acquireRelease(
    Effect.succeed({ endpoint: { url: "http://127.0.0.1:1", pid: ChildProcessSpawner.ProcessId(123), auth: { type: "basic" as const, username: "fixture", password: "synthetic" } }, exited: Effect.void }),
    () => Effect.sync(() => { released = true }),
  ))
  const write = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    const record: unknown = JSON.parse(String(chunk))
    records.push(record)
    if (typeof record === "object" && record !== null && "type" in record && record.type === "desktop.retired") expect(released).toBe(true)
    const done = typeof encoding === "function" ? encoding : callback
    done?.()
    return true
  })
  try {
    const result = await run({ backend: "/synthetic/ycoding", mode: "own", server: Option.none() })
    expect(result._tag).toBe("Failure")
    expect(records.at(-1)).toEqual({ type: "desktop.retired", pid: 123 })
  } finally {
    write.mockRestore(); resolve.mockRestore()
    if (ended) Object.defineProperty(process.stdin, "readableEnded", ended)
    else Reflect.deleteProperty(process.stdin, "readableEnded")
  }
})

for (const detached of [undefined, false]) {
  test(`Standalone forwards ${detached === undefined ? "the existing default" : "explicit non-detached mode"} without changing its stdin lease`, async () => {
    const make = ChildProcess.make
    const calls: ChildProcess.CommandOptions[] = []
    function intercept(file: string, options?: ChildProcess.CommandOptions): ChildProcess.StandardCommand
    function intercept(file: string, args: readonly string[], options?: ChildProcess.CommandOptions): ChildProcess.StandardCommand
    function intercept(options: ChildProcess.CommandOptions): (template: TemplateStringsArray, ...expressions: readonly ChildProcess.TemplateExpression[]) => ChildProcess.StandardCommand
    function intercept(template: TemplateStringsArray, ...expressions: readonly ChildProcess.TemplateExpression[]): ChildProcess.StandardCommand
    function intercept(...values: readonly unknown[]): unknown {
      const options = values[2]
      if (typeof values[0] !== "string" || !Array.isArray(values[1]) || (options !== undefined && (typeof options !== "object" || options === null)))
        throw new Error("Expected an explicit private executable and command options")
      calls.push(options ?? {})
      return make("/synthetic/missing-owned-child", [], { ...options, env: { HOME: process.env.HOME!, PATH: process.env.PATH! }, extendEnv: false })
    }
    const command = spyOn(ChildProcess, "make").mockImplementation(intercept)
    try {
      await Effect.runPromiseExit(Effect.scoped(Standalone.owned({ command: ["/synthetic/ycoding", "serve"], ...(detached === undefined ? {} : { detached }) })))
      expect(calls).toHaveLength(1)
      expect(calls[0]?.detached).toBe(detached)
      expect(calls[0]?.stdin).toBe("pipe")
      expect(calls[0]?.forceKillAfter).toBe("3 seconds")
    } finally { command.mockRestore() }
  })
}

for (const phase of ["unstarted", "pending", "failed-release"] as const) {
  test(`desktop pre-readiness retirement distinguishes ${phase} acquisition from finalization`, async () => {
    const ended = Object.getOwnPropertyDescriptor(process.stdin, "readableEnded")
    Object.defineProperty(process.stdin, "readableEnded", { configurable: true, get: () => phase === "unstarted" })
    const entered = Promise.withResolvers<void>()
    const records: unknown[] = []
    let live = false
    const resolve = spyOn(ServerConnection, "resolve").mockImplementation(() => Effect.acquireRelease(
      Effect.sync(() => { live = true; entered.resolve() }),
      () => Effect.sync(() => { live = false }).pipe(Effect.andThen(phase === "failed-release" ? Effect.die(new Error("synthetic finalization failure")) : Effect.void)),
    ).pipe(Effect.andThen(Effect.never)))
    const write = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      records.push(JSON.parse(String(chunk)))
      expect(live).toBe(false)
      const done = typeof encoding === "function" ? encoding : callback
      done?.()
      return true
    })
    try {
      const completed = run({ backend: "/synthetic/ycoding", mode: "own", server: Option.none() })
      if (phase !== "unstarted") { await entered.promise; process.stdin.emit("end") }
      const result = await completed
      expect(live).toBe(false)
      expect(result._tag).toBe(phase === "failed-release" ? "Failure" : "Success")
      expect(records).toEqual(phase === "failed-release" ? [] : [{ type: "desktop.retired" }])
      if (phase === "unstarted") expect(resolve).not.toHaveBeenCalled()
    } finally {
      write.mockRestore(); resolve.mockRestore()
      if (ended) Object.defineProperty(process.stdin, "readableEnded", ended)
      else Reflect.deleteProperty(process.stdin, "readableEnded")
    }
  })
}
