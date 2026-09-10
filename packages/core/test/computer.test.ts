import { describe, expect, test } from "bun:test"
import { Computer } from "@ycoding-ai/core/computer"
import { MacOSComputer } from "@ycoding-ai/core/computer/macos"
import { Node } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { AppProcess } from "@ycoding-ai/core/process"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { Cause, Context, DateTime, Effect, Exit, Fiber, Layer, PubSub, Schema, Scope, Stream } from "effect"
import path from "node:path"

const owner = SessionV2.ID.make("ses_computer_owner")
const other = SessionV2.ID.make("ses_computer_other")
const target = {
  platform: "macos" as const,
  application: "iterm" as const,
  windowID: 41,
  tabIndex: 2,
  sessionID: "iterm-session-guid",
}

describe("native computer helper resolution", () => {
  test("uses the explicit source-development build instead of writing beside Bun", () => {
    expect(MacOSComputer.helperPath("/opt/homebrew/bin/bun")).toBe(
      path.resolve(import.meta.dir, "../.cache/computer-helper/ycoding-computer-helper"),
    )
    expect(MacOSComputer.helperPath("/opt/homebrew/bin/bun.exe")).toBe(
      path.resolve(import.meta.dir, "../.cache/computer-helper/ycoding-computer-helper"),
    )
    expect(MacOSComputer.helperPath("/opt/ycoding/bin/ycoding")).toBe("/opt/ycoding/bin/ycoding-computer-helper")
  })
})

describe("native computer target ownership", () => {
  test("fences one host target across distinct Location service instances", async () => {
    const started = Promise.withResolvers<void>()
    const settled = Promise.withResolvers<Computer.NativeSuccess>()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const locations = yield* makeLocationComputers((request) => {
            if (request.owner.callID !== "call-active")
              return Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-other" })
            return Effect.promise(() => {
              started.resolve()
              return settled.promise
            })
          })
          const active = Effect.runPromiseExit(
            locations.first.inspect({ sessionID: owner, callID: "call-active", target }),
          )
          yield* Effect.promise(() => started.promise)

          const concurrent = yield* locations.second
            .inspect({ sessionID: other, callID: "call-concurrent", target })
            .pipe(Effect.exit)
          expect(Exit.isFailure(concurrent)).toBe(true)

          settled.resolve({ status: "ok", action: "iterm.inspect", revision: "rev-owner" })
          expect(Exit.isSuccess(yield* Effect.promise(() => active))).toBe(true)
          yield* locations.close
        }),
      ),
    )
  })

  test("releases only the disposed Location and releases moved Sessions", async () => {
    const lifecycleEvents = yieldPubSub()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const locations = yield* makeLocationComputers(
            (request) =>
              Effect.succeed({ status: "ok" as const, action: request.action, revision: request.owner.callID }),
            Stream.fromPubSub(lifecycleEvents),
          )
          yield* locations.first.inspect({ sessionID: owner, callID: "first-claim", target })
          yield* Scope.close(locations.firstScope, Exit.void)
          yield* locations.second.inspect({ sessionID: other, callID: "second-claim", target })

          const third = yield* locations.acquire()
          yield* Scope.close(third.scope, Exit.void)
          const stillOwned = yield* locations
            .acquire()
            .pipe(
              Effect.flatMap((service) =>
                service.computer
                  .inspect({ sessionID: owner, callID: "after-unrelated-dispose", target })
                  .pipe(Effect.ensuring(Scope.close(service.scope, Exit.void)), Effect.exit),
              ),
            )
          expect(Exit.isFailure(stillOwned)).toBe(true)

          yield* PubSub.publish(lifecycleEvents, {
            id: EventV2.ID.create(),
            type: SessionEvent.Moved.type,
            created: DateTime.makeUnsafe(0),
            durable: {
              aggregateID: other,
              seq: EventV2.Seq.make(0),
              version: EventV2.Version.make(SessionEvent.Moved.durable.version),
            },
            data: { sessionID: other, location: { directory: AbsolutePath.make("/tmp/computer-moved") } },
          } satisfies EventV2.Payload<typeof SessionEvent.Moved>)
          yield* Effect.yieldNow
          const afterMove = yield* locations
            .acquire()
            .pipe(
              Effect.flatMap((service) =>
                service.computer
                  .inspect({ sessionID: owner, callID: "after-move", target })
                  .pipe(Effect.ensuring(Scope.close(service.scope, Exit.void))),
              ),
            )
          expect(afterMove.revision).toBe("after-move")
          yield* locations.close
        }),
      ),
    )
  })

  test.each(["cancel", "release"] as const)(
    "keeps a native target fenced after %s until settlement and discards late success",
    async (operation) => {
      const started = Promise.withResolvers<void>()
      const settled = Promise.withResolvers<Computer.NativeSuccess>()
      const computer = Computer.make((request) => {
        if (request.owner.callID !== "call-active")
          return Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-1" })
        return Effect.promise(() => {
          started.resolve()
          return settled.promise
        })
      }, "darwin")
      const active = Effect.runPromiseExit(computer.inspect({ sessionID: owner, callID: "call-active", target }))
      await started.promise
      await Effect.runPromise(
        operation === "cancel"
          ? computer.cancel({ sessionID: owner, callID: "call-active" }).pipe(Effect.asVoid)
          : computer.releaseSession(owner),
      )
      const concurrent = await Effect.runPromiseExit(
        computer.inspect({ sessionID: other, callID: "call-concurrent", target }),
      )
      settled.resolve({ status: "ok", action: "iterm.inspect", revision: "late-revision" })
      const cancelled = await active
      expect(Exit.isFailure(concurrent)).toBe(true)
      expect(Exit.isFailure(cancelled)).toBe(true)
      const stale = await Effect.runPromiseExit(
        computer.act({
          sessionID: owner,
          callID: "call-stale",
          target,
          expectedRevision: "late-revision",
          action: { type: "iterm.send_text", text: "safe", newline: false },
        }),
      )
      expect(Exit.isFailure(stale)).toBe(true)
      expect(
        await Effect.runPromise(computer.inspect({ sessionID: other, callID: "call-next", target })),
      ).toMatchObject({ revision: "rev-1" })
    },
  )

  test("requires the observing Session to own a target and match its revision", async () => {
    const requests: Computer.NativeRequest[] = []
    const computer = Computer.make((request) => {
      requests.push(request)
      return Effect.succeed({
        status: "ok" as const,
        action: request.action,
        revision: request.action === "iterm.send_text" ? "rev-2" : "rev-1",
      })
    })

    expect(
      await Effect.runPromise(computer.inspect({ sessionID: owner, callID: "call-inspect", target })),
    ).toMatchObject({ revision: "rev-1" })

    const crossSession = await Effect.runPromiseExit(
      computer.inspect({ sessionID: other, callID: "call-other", target }),
    )
    expect(Exit.isFailure(crossSession)).toBe(true)
    if (Exit.isFailure(crossSession))
      expect(crossSession.cause.toString()).toContain("Target is owned by another Session")

    const stale = await Effect.runPromiseExit(
      computer.act({
        sessionID: owner,
        callID: "call-stale",
        target,
        expectedRevision: "stale",
        action: { type: "iterm.send_text", text: "printf safe", newline: true },
      }),
    )
    expect(Exit.isFailure(stale)).toBe(true)
    expect(requests).toHaveLength(1)

    expect(
      await Effect.runPromise(
        computer.act({
          sessionID: owner,
          callID: "call-send",
          target,
          expectedRevision: "rev-1",
          action: { type: "iterm.send_text", text: "printf safe", newline: true },
        }),
      ),
    ).toMatchObject({ revision: "rev-2" })
    expect(requests.at(-1)).toMatchObject({
      action: "iterm.send_text",
      owner: { sessionID: owner, callID: "call-send" },
      expectedRevision: "rev-1",
    })
  })

  test("invalidates a claim after an uncertain native result", async () => {
    const computer = Computer.make((request) =>
      request.action === "iterm.inspect"
        ? Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-1" })
        : Effect.fail(
            new Computer.NativeError({
              code: "unknown_outcome",
              message: "The native command may have been accepted",
              outcome: "unknown",
            }),
          ),
    )

    await Effect.runPromise(computer.inspect({ sessionID: owner, callID: "call-inspect", target }))
    const uncertain = await Effect.runPromiseExit(
      computer.act({
        sessionID: owner,
        callID: "call-send",
        target,
        expectedRevision: "rev-1",
        action: { type: "iterm.send_text", text: "printf safe", newline: true },
      }),
    )
    expect(Exit.isFailure(uncertain)).toBe(true)
    if (Exit.isFailure(uncertain)) expect(uncertain.cause.toString()).toContain("may have been accepted")

    const replay = await Effect.runPromiseExit(
      computer.act({
        sessionID: owner,
        callID: "call-replay",
        target,
        expectedRevision: "rev-1",
        action: { type: "iterm.send_text", text: "printf safe", newline: true },
      }),
    )
    expect(Exit.isFailure(replay)).toBe(true)
    if (Exit.isFailure(replay)) expect(replay.cause.toString()).toContain("must be inspected")
  })

  test("filters capabilities and fails safely before native invocation on unsupported platforms", async () => {
    let invoked = false
    const computer = Computer.make((request) => {
      invoked = true
      return Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-1" })
    }, "linux")

    expect(await Effect.runPromise(computer.status)).toEqual({
      platform: "linux",
      state: "unsupported",
      capabilities: [],
    })
    const unsupported = await Effect.runPromiseExit(
      computer.inspect({ sessionID: owner, callID: "call-unsupported", target }),
    )
    expect(Exit.isFailure(unsupported)).toBe(true)
    if (Exit.isFailure(unsupported))
      expect(Cause.squash(unsupported.cause)).toMatchObject({ code: "unsupported_platform" })
    expect(invoked).toBe(false)

    const supported = Computer.make(
      (request) => Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-1" }),
      "darwin",
    )
    const supportedStatus = await Effect.runPromise(supported.status)
    expect(supportedStatus.platform).toBe("macos")
    expect(supportedStatus.capabilities).toEqual([
      {
        platform: "macos",
        application: "iterm",
        identity: { kind: "macos.bundle_id", value: "com.googlecode.iterm2" },
        operations: ["inspect", "send_text"],
      },
      {
        platform: "macos",
        application: "finder",
        identity: { kind: "macos.bundle_id", value: "com.apple.finder" },
        operations: ["inspect", "move"],
      },
    ])
  })

  test("revokes stale ownership and aborts an active call", async () => {
    let signal: AbortSignal | undefined
    const started = Promise.withResolvers<void>()
    const computer = Computer.make((request, inputSignal) =>
      request.action === "iterm.inspect" && request.owner.callID === "call-active"
        ? Effect.tryPromise({
            try: () =>
              new Promise<Computer.NativeSuccess>((_resolve, reject) => {
                signal = inputSignal
                started.resolve()
                inputSignal.addEventListener("abort", () => reject(inputSignal.reason), { once: true })
              }),
            catch: () =>
              new Computer.NativeError({
                code: "helper_unavailable",
                message: "cancelled",
                outcome: "not_started",
              }),
          })
        : Effect.succeed({ status: "ok" as const, action: request.action, revision: "rev-1" }),
    )

    const fiber = Effect.runFork(computer.inspect({ sessionID: owner, callID: "call-active", target }))
    await started.promise
    expect(await Effect.runPromise(computer.cancel({ sessionID: owner, callID: "call-active" }))).toBe(true)
    expect(signal?.aborted).toBe(true)
    expect(Exit.isFailure(await Effect.runPromise(Fiber.await(fiber)))).toBe(true)

    await Effect.runPromise(computer.inspect({ sessionID: owner, callID: "call-inspect", target }))
    await Effect.runPromise(computer.releaseSession(owner))
    const revoked = await Effect.runPromiseExit(
      computer.act({
        sessionID: owner,
        callID: "call-revoked",
        target,
        expectedRevision: "rev-1",
        action: { type: "iterm.send_text", text: "printf safe", newline: true },
      }),
    )
    expect(Exit.isFailure(revoked)).toBe(true)
    if (Exit.isFailure(revoked)) expect(revoked.cause.toString()).toContain("must be inspected")
  })
})

function yieldPubSub() {
  return Effect.runSync(PubSub.unbounded<EventV2.Payload>())
}

const fixtureRequest = Schema.Struct({
  action: Schema.Literals(["iterm.inspect", "iterm.send_text", "finder.inspect", "finder.move"]),
  owner: Schema.Struct({ callID: Schema.String }),
})
const decodeFixtureRequest = Schema.decodeUnknownSync(Schema.fromJsonString(fixtureRequest))

function makeLocationComputers(
  invoke: (
    request: typeof fixtureRequest.Type,
    signal: AbortSignal,
  ) => Effect.Effect<Computer.NativeSuccess, Computer.NativeError>,
  events: Stream.Stream<EventV2.Payload> = Stream.never,
) {
  const processLayer = Layer.mock(AppProcess.Service, {
    run: (_command, options) => {
      if (typeof options?.stdin !== "string" || !options.signal)
        return Effect.die(new Error("Computer fixture requires JSON stdin and an AbortSignal"))
      const request = decodeFixtureRequest(options.stdin)
      return invoke(request, options.signal).pipe(
        Effect.map((result) => ({
          command: "computer-fixture",
          exitCode: 0,
          stdout: Buffer.from(JSON.stringify(result)),
          stderr: Buffer.alloc(0),
          stdoutTruncated: false,
          stderrTruncated: false,
        })),
        Effect.mapError((error) => new AppProcess.AppProcessError({ command: "computer-fixture", cause: error })),
      )
    },
  })
  const split = LayerNode.hoist(Computer.node, Node.tags.values.global, [
    [AppProcess.node, processLayer],
    [EventV2.node, Layer.mock(EventV2.Service, { subscribe: () => events })],
  ])

  return Effect.gen(function* () {
    const globals = yield* Layer.build(LayerNode.compile(split.hoisted))
    const location = LayerNode.compile(split.node).pipe(Layer.provide(Layer.succeedContext(globals)), Layer.fresh)
    const acquire = Effect.fnUntraced(function* () {
      const scope = yield* Scope.make()
      const computer = Context.get(yield* Layer.buildWithScope(location, scope), Computer.Service)
      return { computer, scope }
    })
    const first = yield* acquire()
    const second = yield* acquire()
    return {
      first: first.computer,
      firstScope: first.scope,
      second: second.computer,
      acquire,
      close: Scope.close(first.scope, Exit.void).pipe(Effect.andThen(Scope.close(second.scope, Exit.void))),
    }
  })
}
