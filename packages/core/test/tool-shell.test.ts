import fs from "fs/promises"
import { realpathSync } from "node:fs"
import path from "path"
import { describe, expect, test } from "bun:test"
import { DateTime, Deferred, Duration, Effect, Fiber, Layer, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { ChildProcess } from "effect/unstable/process"
import { Money } from "@ycoding-ai/schema/money"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { makeGlobalNode, makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { filesystem } from "@ycoding-ai/core/effect/app-node-platform"
import { Config } from "@ycoding-ai/core/config"
import { Database } from "@ycoding-ai/core/database/database"
import { EventV2 } from "@ycoding-ai/core/event"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { ModelV2 } from "@ycoding-ai/core/model"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { Job } from "@ycoding-ai/core/job"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { PluginRuntime } from "@ycoding-ai/core/plugin/runtime"
import { Shell } from "@ycoding-ai/core/shell"
import { ShellSandbox } from "@ycoding-ai/core/shell-sandbox"
import { Shell as ShellSchema } from "@ycoding-ai/schema/shell"
import { ShellTool } from "@ycoding-ai/core/tool/shell"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions, waitForTool } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_shell_tool_test")
const sessionModel = ModelV2.Ref.make({ id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") })
const testShell = process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh"
const configDocument = (shellSandbox?: "disabled" | "optional" | "required", shellMemoryLimitMb?: number) =>
  new Config.Document({
    type: "document",
    info: new Config.Info({
      shell: testShell,
      shell_sandbox: shellSandbox,
      shell_memory_limit_mb: shellMemoryLimitMb,
    }),
  })
const assertions: PermissionV2.AssertInput[] = []
let configEntries: Config.Entry[] = [configDocument()]
let denyAction: string | undefined
let afterPermission = (_input: PermissionV2.AssertInput): Effect.Effect<void> => Effect.void
let sandboxPrepare: ShellSandbox.Interface["prepare"] = () =>
  Effect.fail(new ShellSandbox.Unavailable({ message: "No enforceable shell sandbox backend" }))
const fakeShellState: {
  creates: number
  removes: number
  prepared: ShellSchema.CreateInput[]
  timeoutUpdates: number[]
  output: string
  info?: ShellSchema.Info
  complete?: (output?: string) => Effect.Effect<void>
} = {
  creates: 0,
  removes: 0,
  prepared: [],
  timeoutUpdates: [],
  output: "partial output",
}

const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed(configEntries) }))

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    evaluateEffective: () => Effect.die(new Error("unused PermissionV2.evaluateEffective")),
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(Effect.suspend(() => afterPermission(input))),
        Effect.andThen(
          input.action === denyAction
            ? Effect.fail(
                new PermissionV2.BlockedError({
                  rules: [],
                  permission: input.action,
                  resources: input.resources,
                }),
              )
            : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const reset = () => {
  assertions.length = 0
  denyAction = undefined
  afterPermission = () => Effect.void
  configEntries = [configDocument()]
  sandboxPrepare = () => Effect.fail(new ShellSandbox.Unavailable({ message: "No enforceable shell sandbox backend" }))
  fakeShellState.creates = 0
  fakeShellState.removes = 0
  fakeShellState.prepared.length = 0
  fakeShellState.timeoutUpdates.length = 0
  fakeShellState.output = "partial output"
  fakeShellState.info = undefined
  fakeShellState.complete = undefined
}

const sandboxNode = makeGlobalNode({
  service: ShellSandbox.Service,
  layer: Layer.succeed(
    ShellSandbox.Service,
    ShellSandbox.Service.of({ prepare: (command) => sandboxPrepare(command) }),
  ),
  deps: [],
})

const fakeShellNode = makeLocationNode({
  service: Shell.Service,
  layer: Layer.effect(
    Shell.Service,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const preparations = new WeakMap<Shell.Prepared, ShellSchema.CreateInput>()
      let done: Deferred.Deferred<ShellSchema.Info, Shell.NotFoundError> | undefined
      let timeoutFiber: Fiber.Fiber<void> | undefined

      const finish = Effect.fn("ShellTest.finish")(function* (status: ShellSchema.Status, exit?: number) {
        const current = fakeShellState.info
        if (!current || current.status !== "running" || !done) return
        const timer = timeoutFiber
        timeoutFiber = undefined
        fakeShellState.info = {
          ...current,
          status,
          exit,
          time: { ...current.time, completed: 300_000 },
        }
        yield* Deferred.succeed(done, fakeShellState.info)
        if (timer) yield* Fiber.interrupt(timer)
      })

      const armTimeout = Effect.fn("ShellTest.armTimeout")(function* (duration: number) {
        if (timeoutFiber) yield* Fiber.interrupt(timeoutFiber)
        timeoutFiber = undefined
        if (duration === 0 || fakeShellState.info?.status !== "running") return
        timeoutFiber = yield* Effect.sleep(Duration.millis(duration)).pipe(
          Effect.andThen(finish("timeout")),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      const prepare: Shell.Interface["prepare"] = (input) =>
        Effect.sync(() => {
          fakeShellState.prepared.push(input)
          const prepared = Object.freeze({ warnings: Object.freeze([]) })
          preparations.set(prepared, input)
          return prepared
        })

      const create: Shell.Interface["create"] = Effect.fn("ShellTest.create")(function* (prepared) {
        const input = preparations.get(prepared)
        if (!input) return yield* Effect.die(new Error("Invalid fake shell preparation"))
        fakeShellState.creates++
        done = yield* Deferred.make<ShellSchema.Info, Shell.NotFoundError>()
        fakeShellState.info = {
          id: ShellSchema.ID.make(`sh_fake_${fakeShellState.creates}`),
          status: "running",
          command: input.command,
          cwd: input.cwd ?? "/workspace",
          shell: testShell,
          file: `/tmp/sh_fake_${fakeShellState.creates}.out`,
          metadata: input.metadata ?? {},
          ...(typeof input.metadata?.toolCallID === "string" ? { toolCallID: input.metadata.toolCallID } : {}),
          time: { started: 0 },
        }
        fakeShellState.complete = (output = "complete output") =>
          Effect.sync(() => {
            fakeShellState.output = output
          }).pipe(Effect.andThen(finish("exited", 0)))
        yield* armTimeout(input.timeout)
        return fakeShellState.info
      })

      const requireInfo = (id: ShellSchema.ID): Effect.Effect<ShellSchema.Info, Shell.NotFoundError> => {
        const info = fakeShellState.info
        return info?.id === id ? Effect.succeed(info) : Effect.fail(new Shell.NotFoundError({ id }))
      }

      return Shell.Service.of({
        prepare,
        create,
        list: () => Effect.succeed(fakeShellState.info?.status === "running" ? [fakeShellState.info] : []),
        get: requireInfo,
        wait: (id) =>
          requireInfo(id).pipe(
            Effect.andThen(() => (done ? Deferred.await(done) : Effect.fail(new Shell.NotFoundError({ id })))),
          ),
        timeout: (id, duration) =>
          requireInfo(id).pipe(
            Effect.andThen(
              Effect.sync(() => fakeShellState.timeoutUpdates.push(duration)).pipe(
                Effect.andThen(armTimeout(duration)),
              ),
            ),
            Effect.andThen(() => requireInfo(id)),
          ),
        output: (id, input) =>
          requireInfo(id).pipe(
            Effect.map(() => {
              const cursor = input?.cursor ?? 0
              const limit = input?.limit ?? 65_536
              const output = fakeShellState.output.slice(cursor, cursor + limit)
              return {
                output,
                cursor: cursor + output.length,
                size: fakeShellState.output.length,
                truncated: false,
              }
            }),
          ),
        remove: (id) =>
          requireInfo(id).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                fakeShellState.removes++
                if (timeoutFiber) yield* Fiber.interrupt(timeoutFiber)
                const current = fakeShellState.info
                if (!current) return yield* new Shell.NotFoundError({ id })
                fakeShellState.info = {
                  ...current,
                  status: "killed",
                  time: { ...current.time, completed: 300_000 },
                }
                if (done) yield* Deferred.fail(done, new Shell.NotFoundError({ id })).pipe(Effect.ignore)
              }),
            ),
          ),
      })
    }),
  ),
  deps: [],
})

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const store = yield* SessionStore.Service
      const complete = Effect.fn("ShellTest.complete")(function* (id: SessionV2.ID) {
        const session = yield* store.get(id)
        if (!session) return
        const assistantMessageID = SessionMessage.ID.create()
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID: id,
          assistantMessageID,
          agent: session.agent ?? AgentV2.ID.make("code"),
          model: sessionModel,
        })
        yield* events.publish(SessionEvent.Text.Started, {
          sessionID: id,
          assistantMessageID,
          ordinal: 0,
        })
        yield* events.publish(SessionEvent.Text.Ended, {
          sessionID: id,
          assistantMessageID,
          ordinal: 0,
          text: "ok",
        })
        yield* events.publish(SessionEvent.Step.Ended, {
          sessionID: id,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
      })
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        resume: complete,
        wake: () => Effect.void,
        interrupt: () => Effect.void,
        awaitIdle: (id) => complete(id).pipe(Effect.exit, Effect.asVoid),
      })
    }),
  ),
  deps: [EventV2.node, SessionStore.node],
})

const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    EventV2.node,
    Job.node,
    ToolOutputStore.cleanupNode,
    SessionV2.node,
    SessionExecution.node,
    PluginRuntime.providerNode,
    LocationServiceMap.node,
    filesystem,
    FSUtil.node,
    Global.node,
    ShellSandbox.node,
  ]),
  [
    [SessionExecution.node, executionNode],
    [Config.node, config],
    [PermissionV2.node, permission],
    [ShellSandbox.node, sandboxNode],
  ],
)

const fakeLayer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    EventV2.node,
    Job.node,
    ToolOutputStore.cleanupNode,
    SessionV2.node,
    SessionExecution.node,
    PluginRuntime.providerNode,
    LocationServiceMap.node,
    filesystem,
    FSUtil.node,
    Global.node,
    ShellSandbox.node,
  ]),
  [
    [SessionExecution.node, executionNode],
    [Config.node, config],
    [PermissionV2.node, permission],
    [Shell.node, fakeShellNode],
    [ShellSandbox.node, sandboxNode],
  ],
)

const it = testEffect(layer)
const fakeIt = testEffect(fakeLayer)

const call = (input: typeof ShellTool.Input.Type, id = "call-shell", owner = sessionID) => ({
  sessionID: owner,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "shell", input },
})

const isWindows = process.platform === "win32"
const cwdCommand = isWindows ? "(Get-Location).Path; Start-Sleep -Milliseconds 100" : "pwd"
const helloCommand = isWindows ? "[Console]::Out.Write('hello'); Start-Sleep -Milliseconds 100" : "printf hello"
const stderrCommand = isWindows
  ? "[Console]::Error.Write('stderr only'); Start-Sleep -Milliseconds 100"
  : "printf 'stderr only' >&2"
const mixedOutputCommand = isWindows
  ? "[Console]::Out.Write('stdout'); Start-Sleep -Milliseconds 50; [Console]::Error.Write('stderr'); Start-Sleep -Milliseconds 100"
  : "printf stdout; sleep 0.05; printf stderr >&2"
const idleCommand = isWindows ? "Start-Sleep -Seconds 60" : "sleep 60"
const memoryHogCommand = [
  `"${process.execPath}" -e 'const retained = [Buffer.alloc(48 * 1024 * 1024, 1)]; setInterval(() => void retained.length, 1000)' &`,
  `"${process.execPath}" -e 'const retained = [Buffer.alloc(48 * 1024 * 1024, 1)]; setInterval(() => void retained.length, 1000)' &`,
  "wait",
].join(" ")
const bodyExitCommand = isWindows
  ? "[Console]::Out.Write('body'); Start-Sleep -Milliseconds 100; exit 7"
  : "printf body && exit 7"
const overflowCommand = (bytes: number) =>
  isWindows
    ? `[Console]::Out.Write(('x' * ${bytes})); Start-Sleep -Milliseconds 100`
    : `head -c ${bytes} /dev/zero | tr '\\0' 'x'`
const progressOverflowCommand = (bytes: number, release: string) =>
  isWindows
    ? `[Console]::Out.Write(('x' * ${bytes})); while (!(Test-Path -LiteralPath '${release}')) { Start-Sleep -Milliseconds 50 }`
    : `head -c ${bytes} /dev/zero | tr '\\0' 'x'; while [ ! -e '${release}' ]; do sleep 0.05; done`

const withSession = <A, E, R>(
  directory: string,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
  owner = sessionID,
) =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
    yield* sessions.create({
      id: owner,
      title: "shell test",
      location,
      model: sessionModel,
    })
    const locations = yield* LocationServiceMap.Service
    const locationLayer = locations.get(location)
    return yield* Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* waitForTool(registry, ShellTool.name)
      return yield* body(registry)
    }).pipe(Effect.provide(locationLayer), Effect.ensuring(locations.invalidate(location)))
  })

const waitForJob = (jobs: Job.Interface, id: string): Effect.Effect<Job.Info> =>
  jobs
    .get(id)
    .pipe(
      Effect.flatMap((info) =>
        info ? Effect.succeed(info) : Effect.yieldNow.pipe(Effect.andThen(waitForJob(jobs, id))),
      ),
    )

describe("ShellTool", () => {
  it.live("fails closed before approval or spawn when sandboxing is required but unavailable", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        configEntries = [configDocument("required")]
        return withSession(tmp.path, (registry) =>
          executeTool(registry, call({ command: helloCommand })).pipe(
            Effect.tap((output) =>
              Effect.sync(() => {
                expect(output).toEqual({
                  type: "error",
                  value: "Shell sandboxing is required, but no enforceable backend is available.",
                })
                expect(assertions).toEqual([])
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("runs with an explicit warning when optional sandboxing is unavailable", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        configEntries = [configDocument("optional")]
        return withSession(tmp.path, (registry) =>
          settleTool(registry, call({ command: helloCommand })).pipe(
            Effect.tap((settled) =>
              Effect.sync(() => {
                expect(assertions.map((input) => input.action)).toEqual(["shell"])
                expect(settled.output?.content[1]).toMatchObject({
                  type: "text",
                  text: expect.stringContaining("No enforceable shell sandbox backend was available"),
                })
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("delegates the process command to an enforceable sandbox backend", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        let prepared = 0
        sandboxPrepare = (command) =>
          Effect.sync(() => {
            prepared++
            expect(command._tag).toBe("StandardCommand")
            return command
          })
        configEntries = [configDocument("required")]
        return withSession(tmp.path, (registry) =>
          settleTool(registry, call({ command: helloCommand })).pipe(
            Effect.tap((settled) =>
              Effect.sync(() => {
                expect(prepared).toBe(1)
                expect(assertions.map((input) => input.action)).toEqual(["shell"])
                expect(settled.output?.content[0]).toEqual({ type: "text", text: "hello" })
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("does not consult the sandbox backend when sandboxing is disabled", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        sandboxPrepare = () => Effect.die("sandbox backend must not be called")
        configEntries = [configDocument("disabled")]
        return withSession(tmp.path, (registry) =>
          settleTool(registry, call({ command: helloCommand })).pipe(
            Effect.tap((settled) =>
              Effect.sync(() => {
                expect(settled.output?.content[0]).toEqual({ type: "text", text: "hello" })
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects forged prepared commands instead of bypassing sandbox policy", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, () =>
          Effect.gen(function* () {
            const shell = yield* Shell.Service
            const rejected = yield* shell
              .create(Object.freeze({ warnings: [] }) as Shell.Prepared)
              .pipe(Effect.catchDefect(Effect.succeed))
            expect(rejected).toBeInstanceOf(Error)
            expect((rejected as Error).message).toBe("Invalid shell preparation capability")
            expect(yield* shell.list()).toEqual([])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("settles a prepared spawn failure instead of hanging forever", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        configEntries = [configDocument("required")]
        sandboxPrepare = () => Effect.succeed(ChildProcess.make("ycoding-missing-shell", [], { cwd: tmp.path }))
        return withSession(tmp.path, () =>
          Effect.gen(function* () {
            const shell = yield* Shell.Service
            const prepared = yield* shell.prepare({ command: helloCommand, cwd: tmp.path, timeout: 50 })
            const result = yield* Effect.raceFirst(
              shell.create(prepared).pipe(
                Effect.exit,
                Effect.map((exit) => ({ type: "settled" as const, exit })),
              ),
              Effect.sleep("250 millis").pipe(Effect.as({ type: "hung" as const })),
            )
            expect(result.type).toBe("settled")
            if (result.type === "settled") expect(result.exit).toMatchObject({ _tag: "Failure" })
            expect(yield* shell.list()).toEqual([])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  fakeIt.effect("rejects catastrophic commands before shell creation", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          executeTool(registry, call({ command: "rm -rf /" })).pipe(
            Effect.tap((output) =>
              Effect.sync(() => {
                expect(output).toMatchObject({ type: "error" })
                expect(output.type === "error" ? output.value : "").toContain(
                  "Session guardrail rejected shell command",
                )
                expect(fakeShellState.creates).toBe(0)
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  fakeIt.effect("passes an explicit memory limit to shell preparation", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const settling = yield* settleTool(
              registry,
              call({ command: "fake memory-bound command", memory_limit_mb: 768 }, "call-memory-override"),
            ).pipe(Effect.forkChild)
            while (!fakeShellState.complete) yield* Effect.yieldNow
            expect(fakeShellState.prepared).toMatchObject([{ memoryLimitMb: 768 }])
            yield* fakeShellState.complete()
            yield* Fiber.join(settling)
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("applies the configured memory default and accepts an unlimited override", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        configEntries = [configDocument(undefined, 512)]
        return withSession(tmp.path, () =>
          Effect.gen(function* () {
            const shell = yield* Shell.Service
            expect((yield* shell.prepare({ command: helloCommand, timeout: 0 })).memoryLimitMb).toBe(512)
            expect(
              (yield* shell.prepare({ command: helloCommand, timeout: 0, memoryLimitMb: 0 })).memoryLimitMb,
            ).toBeUndefined()
            expect(
              (yield* shell.prepare({ command: helloCommand, timeout: 0, memoryLimitMb: 256 })).memoryLimitMb,
            ).toBe(256)
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  if (!isWindows)
    it.live("supplies matching Go and Node runtime memory hints", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          const command = 'printf \'%s|%s\' "$GOMEMLIMIT" "$NODE_OPTIONS"'
          return withSession(tmp.path, (registry) =>
            settleTool(registry, call({ command, memory_limit_mb: 512 }, "call-memory-runtime-hints")).pipe(
              Effect.tap((settled) =>
                Effect.sync(() => {
                  const content = settled.output?.content[0]
                  expect(content?.type).toBe("text")
                  if (content?.type !== "text") return
                  expect(content.text).toContain("512MiB|")
                  expect(content.text).toContain("--max-old-space-size=512")
                }),
              ),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    )

  if (!isWindows)
    it.live(
      "terminates a command process tree after it exceeds the memory limit",
      () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => {
            reset()
            return withSession(tmp.path, (registry) =>
              settleTool(
                registry,
                call({ command: memoryHogCommand, memory_limit_mb: 128, timeout: 10_000 }, "call-memory-limit"),
              ).pipe(
                Effect.tap((settled) =>
                  Effect.sync(() => {
                    expect(settled.output?.structured).toMatchObject({ memoryLimit: true, truncated: false })
                    expect(settled.output?.content[0]).toMatchObject({
                      type: "text",
                      text: "Command was terminated by the 128 MiB memory limit.",
                    })
                    expect(settled.output?.content[1]).toMatchObject({
                      type: "text",
                      text: expect.stringContaining("exceeded its memory limit"),
                    })
                  }),
                ),
              ),
            )
          },
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
        ),
      { timeout: 15_000 },
    )

  it.live("registers and returns real successful output from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const definitions = yield* toolDefinitions(registry)
            const shell = definitions.find((tool) => tool.name === "shell")
            expect(shell).toBeDefined()
            expect(shell?.outputSchema).not.toHaveProperty("properties.output")
            expect(
              (yield* toolDefinitions(registry, [{ action: "shell", resource: "*", effect: "deny" }])).map(
                (tool) => tool.name,
              ),
            ).not.toContain("shell")

            const settled = yield* settleTool(registry, call({ command: helloCommand }))
            expect(settled.output?.structured).toMatchObject({ exit: 0, truncated: false })
            expect(settled.output?.content[0]).toEqual({ type: "text", text: "hello" })
            expect(settled.output?.content[1]).toMatchObject({
              type: "text",
              text: expect.stringContaining("Command exited with code 0."),
            })
            expect(assertions).toMatchObject([{ sessionID, action: "shell", resources: [helloCommand] }])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("resolves a relative workdir from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.mkdir(path.join(tmp.path, "src"))).pipe(
          Effect.andThen(
            withSession(tmp.path, (registry) => settleTool(registry, call({ command: cwdCommand, workdir: "src" }))),
          ),
          Effect.andThen((settled) =>
            Effect.sync(() =>
              expect(settled.output?.content[0]).toMatchObject({
                type: "text",
                text: expect.stringContaining(realpathSync(path.join(tmp.path, "src"))),
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("captures stderr-only and mixed stdout/stderr output", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const stderr = yield* settleTool(registry, call({ command: stderrCommand }, "call-stderr"))
            expect(stderr.output?.structured).toMatchObject({ exit: 0, truncated: false })
            expect(stderr.output?.content[0]).toEqual({ type: "text", text: "stderr only" })

            const mixed = yield* settleTool(registry, call({ command: mixedOutputCommand }, "call-mixed"))
            expect(mixed.output?.structured).toMatchObject({ exit: 0, truncated: false })
            const output = mixed.output?.content[0]?.type === "text" ? mixed.output.content[0].text : ""
            expect(output).toContain("stdout")
            expect(output).toContain("stderr")
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("rejects a workdir that stops being a directory during approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const workdir = path.join(tmp.path, "src")
        afterPermission = (input) =>
          input.action === "shell"
            ? Effect.promise(async () => {
                await fs.rm(workdir, { recursive: true })
                await fs.writeFile(workdir, "not a directory")
              }).pipe(Effect.orDie)
            : Effect.void
        return Effect.promise(() => fs.mkdir(workdir)).pipe(
          Effect.andThen(
            withSession(tmp.path, (registry) => executeTool(registry, call({ command: cwdCommand, workdir: "src" }))),
          ),
          Effect.andThen(Effect.sync(() => expect(assertions.map((input) => input.action)).toEqual(["shell"]))),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("approves an explicit external workdir before shell execution", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        return withSession(active.path, (registry) =>
          executeTool(registry, call({ command: cwdCommand, workdir: outside.path })),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["external_directory", "shell"])
              expect(assertions[0]).toMatchObject({
                resources: [path.join(realpathSync(outside.path), "*").replaceAll("\\", "/")],
              })
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("does not execute after external-directory or shell denial", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          reset()
          denyAction = "external_directory"
          yield* withSession(active.path, (registry) =>
            executeTool(registry, call({ command: cwdCommand, workdir: outside.path })),
          )
          expect(assertions.map((item) => item.action)).toEqual(["external_directory"])

          reset()
          denyAction = "shell"
          yield* withSession(active.path, (registry) => executeTool(registry, call({ command: cwdCommand })))
          expect(assertions.map((item) => item.action)).toEqual(["shell"])
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("reports external command arguments as advisory warnings without enforcing approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        denyAction = "external_directory"
        const target = path.join(outside.path, "secret.txt")
        return withSession(active.path, (registry) => settleTool(registry, call({ command: `cat ${target}` }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["shell"])
              expect(settled.output?.structured).not.toHaveProperty("warnings")
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Warnings:"),
              })
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("keeps non-zero exits useful", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          settleTool(registry, call({ command: bodyExitCommand }, "call-nonzero")),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.structured).toMatchObject({ exit: 7, truncated: false })
              expect(settled.output?.content[0]).toEqual({ type: "text", text: "body" })
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Command exited with code 7"),
              })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("truncates the model view and points at the saved output file when output overflows", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const bytes = ShellTool.MAX_CAPTURE_BYTES + 1024
        return withSession(tmp.path, (registry) =>
          settleTool(registry, call({ command: overflowCommand(bytes) }, "call-overflow")),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.structured).toMatchObject({ exit: 0, truncated: true })
              expect(settled.output?.content[0]).toMatchObject({
                type: "text",
                text: expect.stringContaining("output truncated; full output saved to:"),
              })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live(
    "reports bounded output progress for a running command",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          const release = "shell-progress-release"
          const releasePath = path.join(tmp.path, release)
          return withSession(tmp.path, (registry) =>
            Effect.gen(function* () {
              const observed = yield* Deferred.make<ToolRegistry.Progress>()
              yield* settleTool(registry, {
                ...call(
                  { command: progressOverflowCommand(ShellTool.MAX_CAPTURE_BYTES + 1024, release) },
                  "call-progress",
                ),
                progress: (update) =>
                  Effect.gen(function* () {
                    if (update.structured.truncated !== true) return
                    const content = update.content[0]
                    if (content?.type !== "text") return
                    if (
                      content.text.indexOf("\n\n[output truncated; full output saved to:") !==
                      ShellTool.MAX_CAPTURE_BYTES
                    )
                      return
                    yield* Deferred.succeed(observed, update)
                    yield* Effect.promise(() => fs.writeFile(releasePath, ""))
                  }),
              })

              const progress = yield* Deferred.await(observed)
              expect(progress.structured).toEqual({ truncated: true })
              const content = progress.content[0]
              expect(content?.type).toBe("text")
              if (content?.type !== "text") return
              expect(content.text.indexOf("\n\n[output truncated; full output saved to:")).toBe(
                ShellTool.MAX_CAPTURE_BYTES,
              )
            }).pipe(Effect.ensuring(Effect.promise(() => fs.writeFile(releasePath, "")).pipe(Effect.ignore))),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    { timeout: 15_000 },
  )

  it.live("returns a useful timeout settlement", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          settleTool(registry, call({ command: idleCommand, timeout: 50 })),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.structured).toMatchObject({ timeout: true, truncated: false })
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Command timed out"),
              })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("returns the shell id for a background command", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const events = yield* EventV2.Service
            const admitted = yield* events.subscribe(SessionEvent.InputAdmitted).pipe(
              Stream.filter((event) => event.data.sessionID === sessionID && event.data.input.type === "synthetic"),
              Stream.runHead,
              Effect.forkScoped({ startImmediately: true }),
            )
            const settled = yield* settleTool(registry, call({ command: idleCommand, timeout: 50, background: true }))
            const structured = settled.output?.structured as Record<string, unknown> | undefined
            const shellID = typeof structured?.shellID === "string" ? structured.shellID : undefined
            expect(settled.output?.structured).toMatchObject({ truncated: false })
            expect(shellID).toStartWith("sh_")

            const shell = yield* Shell.Service
            if (!shellID) return
            const id = ShellSchema.ID.make(shellID)
            expect((yield* shell.list()).map((info) => info.id)).toContain(id)
            expect((yield* shell.wait(id)).status).toBe("timeout")
            expect((yield* Fiber.join(admitted)).valueOrUndefined?.data.input.data).toMatchObject({
              description: idleCommand,
              metadata: {
                source: "shell",
                state: "completed",
              },
            })
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("updates and clears a running shell timeout", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const shell = yield* Shell.Service
            const timed = yield* settleTool(
              registry,
              call({ command: idleCommand, background: true }, "call-updated-timeout"),
            )
            const timedID = (timed.output?.structured as Record<string, unknown> | undefined)?.shellID
            expect(typeof timedID).toBe("string")
            if (typeof timedID !== "string") return
            const timedShellID = ShellSchema.ID.make(timedID)
            yield* shell.timeout(timedShellID, 50)
            expect((yield* shell.wait(timedShellID)).status).toBe("timeout")

            const cleared = yield* settleTool(
              registry,
              call({ command: idleCommand, timeout: 50, background: true }, "call-cleared-timeout"),
            )
            const clearedID = (cleared.output?.structured as Record<string, unknown> | undefined)?.shellID
            expect(typeof clearedID).toBe("string")
            if (typeof clearedID !== "string") return
            const clearedShellID = ShellSchema.ID.make(clearedID)
            yield* shell.timeout(clearedShellID, 0)
            yield* Effect.sleep(Duration.millis(100))
            expect((yield* shell.get(clearedShellID)).status).toBe("running")
            yield* shell.remove(clearedShellID)
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("backgrounds a foreground command when the session is signaled", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const jobs = yield* Job.Service
            const scope = yield* Scope.Scope
            const waiting = yield* settleTool(
              registry,
              call({ command: idleCommand, timeout: 0 }, "call-background-signal"),
            ).pipe(Effect.forkIn(scope, { startImmediately: true }))

            const backgroundWhenReady = (remaining = 1000): Effect.Effect<Job.Info[], Error> =>
              Effect.gen(function* () {
                const backgrounded = yield* jobs.backgroundAll({ sessionID })
                if (backgrounded.length > 0) return backgrounded
                if (remaining <= 0) return yield* Effect.fail(new Error("Timed out waiting for foreground shell job"))
                yield* Effect.promise(() => Bun.sleep(1))
                return yield* backgroundWhenReady(remaining - 1)
              })
            expect(yield* backgroundWhenReady()).toMatchObject([{ id: "call-background-signal", type: "shell" }])
            const settled = yield* Fiber.join(waiting)
            const structured = settled.output?.structured as Record<string, unknown> | undefined
            const shellID = typeof structured?.shellID === "string" ? structured.shellID : undefined
            expect(settled.output?.structured).toMatchObject({ truncated: false })
            expect(settled.output?.content[0]).toEqual({
              type: "text",
              text: "The command was moved to the background.",
            })
            expect(settled.output?.content[1]).toMatchObject({
              type: "text",
              text: expect.stringContaining("DO NOT sleep, poll"),
            })
            expect(shellID).toStartWith("sh_")

            const shell = yield* Shell.Service
            if (!shellID) return
            const id = ShellSchema.ID.make(shellID)
            yield* Effect.sleep(Duration.millis(100))
            expect((yield* shell.get(id)).status).toBe("running")
            expect((yield* shell.list()).map((info) => info.id)).toContain(id)
            yield* shell.remove(id)
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )
  ;[sessionID, SessionV2.ID.make("ses_shell_tool_child_test")].forEach((owner) =>
    fakeIt.effect(`automatically backgrounds one unchanged shell for ${owner}`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          const callID = `call-auto-${owner}`
          return withSession(
            tmp.path,
            (registry) =>
              Effect.gen(function* () {
                const events = yield* EventV2.Service
                const jobs = yield* Job.Service
                const shell = yield* Shell.Service
                const scope = yield* Scope.Scope
                const admitted = yield* events.subscribe(SessionEvent.InputAdmitted).pipe(
                  Stream.filter((event) => event.data.sessionID === owner && event.data.input.type === "synthetic"),
                  Stream.runHead,
                  Effect.forkIn(scope, { startImmediately: true }),
                )
                const waiting = yield* settleTool(registry, call({ command: "fake long command" }, callID, owner)).pipe(
                  Effect.forkIn(scope, { startImmediately: true }),
                )

                yield* waitForJob(jobs, callID)
                yield* Effect.yieldNow
                expect(fakeShellState.prepared).toMatchObject([
                  { timeout: 0, metadata: { sessionID: owner, toolCallID: callID } },
                ])
                expect(fakeShellState.creates).toBe(1)

                yield* TestClock.adjust("299999 millis")
                expect(waiting.pollUnsafe()).toBeUndefined()
                fakeShellState.output = "partial output continued"

                yield* TestClock.adjust("1 millis")
                const exit = waiting.pollUnsafe()
                expect(exit).toBeDefined()
                if (!exit) return
                const settled = yield* Fiber.join(waiting)
                expect(settled.output?.structured).toMatchObject({ shellID: "sh_fake_1", truncated: false })
                expect(settled.output?.content[0]).toEqual({
                  type: "text",
                  text: "The command was moved to the background.",
                })
                expect(fakeShellState.creates).toBe(1)
                expect(fakeShellState.removes).toBe(0)
                expect(fakeShellState.info).toMatchObject({
                  id: "sh_fake_1",
                  status: "running",
                  toolCallID: callID,
                })
                expect(yield* shell.output(ShellSchema.ID.make("sh_fake_1"))).toMatchObject({
                  output: "partial output continued",
                })

                const automatic = (yield* Fiber.join(admitted)).valueOrUndefined
                expect(automatic?.data).toMatchObject({
                  sessionID: owner,
                  input: {
                    type: "synthetic",
                    delivery: "steer",
                    data: { description: undefined },
                  },
                })
                if (automatic?.data.input.type === "synthetic") {
                  expect(automatic.data.input.data.text.length).toBeLessThanOrEqual(256)
                  expect(automatic.data.input.data.text).toContain("moved to the background")
                }

                const completed = yield* events.subscribe(SessionEvent.InputAdmitted).pipe(
                  Stream.filter(
                    (event) =>
                      event.data.sessionID === owner &&
                      event.data.input.type === "synthetic" &&
                      event.data.input.data.description === "fake long command",
                  ),
                  Stream.runHead,
                  Effect.forkIn(scope, { startImmediately: true }),
                )
                yield* fakeShellState.complete?.("complete output") ?? Effect.die("fake shell completion unavailable")
                expect((yield* Fiber.join(completed)).valueOrUndefined?.data.input.data).toMatchObject({
                  description: "fake long command",
                  metadata: { source: "shell", state: "completed" },
                })
              }),
            owner,
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
      ),
    ),
  )

  fakeIt.effect("keeps explicit background immediate without an automatic steer", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const events = yield* EventV2.Service
            const scope = yield* Scope.Scope
            const admitted = yield* events.subscribe(SessionEvent.InputAdmitted).pipe(
              Stream.filter((event) => event.data.sessionID === sessionID && event.data.input.type === "synthetic"),
              Stream.runHead,
              Effect.forkIn(scope, { startImmediately: true }),
            )
            const settled = yield* settleTool(
              registry,
              call({ command: "fake explicit background", background: true }, "call-explicit-background"),
            )
            expect(settled.output?.structured).toMatchObject({ shellID: "sh_fake_1", truncated: false })
            expect(fakeShellState.prepared).toMatchObject([{ timeout: 0 }])

            yield* TestClock.adjust(300_000)
            expect(admitted.pollUnsafe()).toBeUndefined()
            expect(fakeShellState.info?.status).toBe("running")
            expect(fakeShellState.removes).toBe(0)
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  fakeIt.effect("lets a short explicit timeout win without detaching", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const events = yield* EventV2.Service
            const jobs = yield* Job.Service
            const scope = yield* Scope.Scope
            const admitted = yield* events.subscribe(SessionEvent.InputAdmitted).pipe(
              Stream.filter((event) => event.data.sessionID === sessionID && event.data.input.type === "synthetic"),
              Stream.runHead,
              Effect.forkIn(scope, { startImmediately: true }),
            )
            const waiting = yield* settleTool(
              registry,
              call({ command: "fake short timeout", timeout: 50 }, "call-short-timeout"),
            ).pipe(Effect.forkIn(scope, { startImmediately: true }))
            yield* waitForJob(jobs, "call-short-timeout")
            yield* Effect.yieldNow

            yield* TestClock.adjust("49 millis")
            expect(waiting.pollUnsafe()).toBeUndefined()
            yield* TestClock.adjust("1 millis")
            const settled = yield* Fiber.join(waiting)
            expect(settled.output?.structured).toMatchObject({ timeout: true, truncated: false })
            expect(fakeShellState.prepared).toMatchObject([{ timeout: 50 }])
            expect(admitted.pollUnsafe()).toBeUndefined()
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  fakeIt.effect("retains a long explicit process timeout after automatic backgrounding", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const jobs = yield* Job.Service
            const scope = yield* Scope.Scope
            const waiting = yield* settleTool(
              registry,
              call({ command: "fake long timeout", timeout: 600_000 }, "call-long-timeout"),
            ).pipe(Effect.forkIn(scope, { startImmediately: true }))
            yield* waitForJob(jobs, "call-long-timeout")
            yield* Effect.yieldNow

            yield* TestClock.adjust(300_000)
            const exit = waiting.pollUnsafe()
            expect(exit).toBeDefined()
            if (!exit) return
            expect((yield* Fiber.join(waiting)).output?.structured).toMatchObject({ shellID: "sh_fake_1" })
            expect(fakeShellState.prepared).toMatchObject([{ timeout: 600_000 }])
            expect(fakeShellState.timeoutUpdates).toEqual([])
            expect(fakeShellState.info?.status).toBe("running")
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  fakeIt.effect("interrupts foreground ownership once and cancels its deadline", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const events = yield* EventV2.Service
            const jobs = yield* Job.Service
            const scope = yield* Scope.Scope
            const admitted = yield* events.subscribe(SessionEvent.InputAdmitted).pipe(
              Stream.filter((event) => event.data.sessionID === sessionID && event.data.input.type === "synthetic"),
              Stream.runHead,
              Effect.forkIn(scope, { startImmediately: true }),
            )
            const waiting = yield* settleTool(
              registry,
              call({ command: "fake interrupted", timeout: 0 }, "call-interrupted"),
            ).pipe(Effect.forkIn(scope, { startImmediately: true }))
            yield* waitForJob(jobs, "call-interrupted")
            yield* Effect.yieldNow

            yield* Fiber.interrupt(waiting)
            expect(fakeShellState.removes).toBe(1)
            yield* TestClock.adjust(300_000)
            expect(fakeShellState.removes).toBe(1)
            expect(admitted.pollUnsafe()).toBeUndefined()
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )
})

test("keeps locked deferred parity TODOs visible", async () => {
  const source = await fs.readFile(new URL("../src/tool/shell.ts", import.meta.url), "utf8")
  for (const todo of [
    "Port tree-sitter bash / PowerShell parser-based approval reduction.",
    "Port BashArity reusable command-prefix approvals.",
    "Replace token-based command-argument external-directory advisories with parser-based detection.",
    "Restore PowerShell and cmd-specific invocation/path handling on Windows.",
    "Add plugin shell.env environment augmentation once V2 plugin hooks exist.",
    "Persist job status and define restart recovery before exposing remote observation.",
    "Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it.",
    "Revisit binary output handling if stdout/stderr decoding is text-only.",
    "Stream full shell output into managed storage while retaining only a bounded in-memory preview.",
  ]) {
    expect(source).toContain(`TODO: ${todo}`)
  }
})
