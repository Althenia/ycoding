import { describe, expect, test } from "bun:test"
import { BrowserAdmission } from "@ycoding-ai/core/browser/admission"
import { EventV2 } from "@ycoding-ai/core/event"
import { IsolatedBrowserExecutor } from "@ycoding-ai/core/browser/isolated-executor"
import { IsolatedBrowser } from "@ycoding-ai/core/isolated-browser"
import { Location } from "@ycoding-ai/core/location"
import { Money } from "@ycoding-ai/schema/money"
import { ProjectV2 } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { Cause, DateTime, Effect, Exit, Fiber, Layer, PubSub, Schema, Scope, Stream } from "effect"
import { location } from "../fixture/location"

const directory = AbsolutePath.make("/isolated-browser-fixture")
const sessionID = SessionSchema.ID.make("ses_isolated_owner")
const otherSessionID = SessionSchema.ID.make("ses_isolated_other")
const lifecycleEvents = Effect.runSync(PubSub.unbounded<EventV2.Payload>())
const eventLayer = Layer.mock(EventV2.Service, { subscribe: () => Stream.fromPubSub(lifecycleEvents) })

const lifecycleEvent = (definition: typeof SessionEvent.Moved | typeof SessionEvent.Deleted | typeof SessionEvent.Archived) =>
  Schema.decodeUnknownSync(definition)({
    id: EventV2.ID.create(),
    created: 1,
    type: definition.type,
    durable: {
      aggregateID: sessionID,
      seq: 0,
      version: definition.durable.version,
    },
    data: definition === SessionEvent.Moved ? { sessionID, location: { directory } } : { sessionID },
  })

const session = (id: SessionSchema.ID, archived = false) =>
  SessionSchema.Info.make({
    id,
    projectID: ProjectV2.ID.global,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: {
      created: DateTime.makeUnsafe(1),
      updated: DateTime.makeUnsafe(1),
      ...(archived ? { archived: DateTime.makeUnsafe(2) } : {}),
    },
    title: "Isolated browser fixture",
    location: { directory },
  })

const dependencies = (executor: IsolatedBrowserExecutor.Interface, archived = false) =>
  Layer.mergeAll(
    Layer.succeed(Location.Service, Location.Service.of(location({ directory }))),
    Layer.mock(SessionStore.Service, {
      get: (id) => Effect.succeed([sessionID, otherSessionID].includes(id) ? session(id, archived) : undefined),
    }),
    BrowserAdmission.layer,
    Layer.succeed(IsolatedBrowserExecutor.Service, IsolatedBrowserExecutor.Service.of(executor)),
    eventLayer,
  )

function run<A, E>(
  executor: IsolatedBrowserExecutor.Interface,
  effect: Effect.Effect<A, E, IsolatedBrowser.Service | BrowserAdmission.Service | Scope.Scope>,
  options: IsolatedBrowser.Options = {},
  archived = false,
) {
  const services = dependencies(executor, archived)
  return Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          Layer.merge(services, IsolatedBrowser.layer(options).pipe(Layer.provide(services))),
        ),
      ),
    ),
  )
}

function fixtureRuntime(options: {
  readonly actions?: Array<string>
  readonly action?: IsolatedBrowserExecutor.Runtime["action"]
  readonly close?: () => void
  readonly closed?: Effect.Effect<void>
  readonly observe?: IsolatedBrowserExecutor.Runtime["observe"]
} = {}): IsolatedBrowserExecutor.Runtime {
  const snapshot = {
    title: "Fixture",
    url: "https://example.test/form?secret=not-projected",
    documentGeneration: 1,
    revision: 1,
    elements: [{ ref: "b1", role: "button", name: "Submit" }],
    truncated: false,
  }
  return {
    observe: options.observe ?? Effect.succeed(snapshot),
    action:
      options.action ??
      ((action) =>
        Effect.sync(() => {
          options.actions?.push(action.type)
          return {
            snapshot: { title: "Fixture", url: snapshot.url, documentGeneration: 1, revision: 0 },
          }
        })),
    pause: Effect.void,
    resume: Effect.void,
    close: Effect.sync(() => options.close?.()),
    closed: options.closed ?? Effect.never,
  }
}

function fixtureExecutor(runtime = fixtureRuntime()): IsolatedBrowserExecutor.Interface {
  return {
    availability: Effect.succeed({ available: true }),
    launch: () => Effect.succeed(runtime),
  }
}

describe("isolated browser service", () => {
  test("settles pending mutations and releases owned resources on Session moved, deleted, and archived events", async () => {
    for (const definition of [SessionEvent.Moved, SessionEvent.Deleted, SessionEvent.Archived]) {
      const actionStarted = Promise.withResolvers<void>()
      let closed = 0
      const runtime = fixtureRuntime({
        action: () =>
          Effect.promise(() => {
            actionStarted.resolve()
            return new Promise<never>(() => {})
          }),
        close: () => closed++,
      })
      await run(fixtureExecutor(runtime),
        Effect.gen(function* () {
          const admission = yield* BrowserAdmission.Service
          const isolated = yield* IsolatedBrowser.Service
          const started = yield* isolated.start(sessionID, { url: "https://example.test/form" })
          const pending = yield* isolated
            .action({
              sessionID,
              instanceID: started.instanceID!,
              tabID: started.tab!.id,
              generation: started.tab!.generation,
              documentGeneration: started.tab!.documentGeneration,
              observationRevision: started.tab!.observationRevision,
              callID: "lifecycle-mutation",
              action: { type: "click", ref: "b1" },
            })
            .pipe(Effect.forkScoped)
          yield* Effect.promise(() => actionStarted.promise)
          yield* PubSub.publish(lifecycleEvents, lifecycleEvent(definition))
          const result = yield* Fiber.join(pending).pipe(
            Effect.timeoutOrElse({
              duration: "500 millis",
              orElse: () => Effect.die(new Error(`Session ${definition.type} did not settle isolated work`)),
            }),
          )
          expect(result).toMatchObject({ status: "uncertain", callID: "lifecycle-mutation" })
          expect(closed).toBeGreaterThanOrEqual(1)
          expect(yield* isolated.list(sessionID)).toEqual([])
          expect(admission.claim(sessionID, "selected")).toBe(true)
        }),
      )
    }
  })

  test("rejects archived Session restart before claiming admission or launching Chrome", async () => {
    let launches = 0
    const executor: IsolatedBrowserExecutor.Interface = {
      availability: Effect.succeed({ available: true }),
      launch: () => {
        launches++
        return Effect.succeed(fixtureRuntime())
      },
    }
    await run(executor,
      Effect.gen(function* () {
        const admission = yield* BrowserAdmission.Service
        const isolated = yield* IsolatedBrowser.Service
        const result = yield* isolated
          .start(sessionID, { url: "https://example.test/form" })
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result))
          expect(Cause.squash(result.cause)).toMatchObject({ _tag: "Session.NotFoundError" })
        expect(launches).toBe(0)
        expect(admission.claim(sessionID, "selected")).toBe(true)
      }),
      {},
      true,
    )
  })

  test("stops a delayed start, closes its late runtime, and never publishes it as ready", async () => {
    const launchStarted = Promise.withResolvers<void>()
    const releaseLaunch = Promise.withResolvers<void>()
    let closed = 0
    const runtime = fixtureRuntime({ close: () => closed++ })
    const executor: IsolatedBrowserExecutor.Interface = {
      availability: Effect.succeed({ available: true }),
      launch: () =>
        Effect.promise(async () => {
          launchStarted.resolve()
          await releaseLaunch.promise
          return runtime
        }),
    }
    await run(executor,
      Effect.gen(function* () {
        const admission = yield* BrowserAdmission.Service
        const isolated = yield* IsolatedBrowser.Service
        const starting = yield* isolated
          .start(sessionID, { url: "https://example.test/form" })
          .pipe(Effect.forkScoped)
        yield* Effect.promise(() => launchStarted.promise)
        yield* isolated.stop(sessionID)
        releaseLaunch.resolve()
        const exit = yield* Fiber.await(starting)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "IsolatedBrowser.UnavailableError" })
        expect(closed).toBe(1)
        expect(yield* isolated.status(sessionID)).toEqual({ mode: "isolated", state: "stopped" })
        expect(admission.claim(sessionID, "selected")).toBe(true)
      }),
    )
  })

  test("does not publish ready when stop races the initial observation", async () => {
    const observationStarted = Promise.withResolvers<void>()
    const releaseObservation = Promise.withResolvers<void>()
    let closed = 0
    const observed = {
      title: "Late observation",
      url: "https://example.test/late",
      documentGeneration: 1,
      revision: 1,
      elements: [],
      truncated: false,
    }
    const runtime = fixtureRuntime({
      close: () => closed++,
      observe: Effect.promise(async () => {
        observationStarted.resolve()
        await releaseObservation.promise
        return observed
      }),
    })
    await run(fixtureExecutor(runtime),
      Effect.gen(function* () {
        const isolated = yield* IsolatedBrowser.Service
        const starting = yield* isolated
          .start(sessionID, { url: "https://example.test/form" })
          .pipe(Effect.forkScoped)
        yield* Effect.promise(() => observationStarted.promise)
        yield* isolated.stop(sessionID)
        releaseObservation.resolve()
        const exit = yield* Fiber.await(starting)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(closed).toBeGreaterThanOrEqual(1)
        expect(yield* isolated.status(sessionID)).toEqual({ mode: "isolated", state: "stopped" })
      }),
    )
  })

  test("reports missing and incompatible Chrome without dispatching launch", async () => {
    for (const reason of [
      "Installed Google Chrome is unavailable",
      "Installed Google Chrome major 151 is unsupported; major 152 is required",
    ]) {
      let launches = 0
      const executor: IsolatedBrowserExecutor.Interface = {
        availability: Effect.succeed({ available: false, reason }),
        launch: () => {
          launches++
          return Effect.fail(
            new IsolatedBrowserExecutor.Error({ message: reason, phase: "predispatch" }),
          )
        },
      }
      await run(executor,
        Effect.gen(function* () {
          const isolated = yield* IsolatedBrowser.Service
          expect(yield* isolated.status(sessionID)).toEqual({ mode: "isolated", state: "unavailable", reason })
          const started = yield* isolated.start(sessionID, { url: "https://example.test/form" }).pipe(Effect.exit)
          expect(Exit.isFailure(started)).toBe(true)
          if (Exit.isFailure(started))
            expect(Cause.squash(started.cause)).toMatchObject({
              _tag: "IsolatedBrowser.UnavailableError",
              message: reason,
            })
          expect(launches).toBe(0)
        }),
      )
    }
  })

  test("admits one concurrent start and launches only one owned runtime", async () => {
    let launches = 0
    const executor: IsolatedBrowserExecutor.Interface = {
      availability: Effect.succeed({ available: true }),
      launch: () =>
        Effect.sleep("20 millis").pipe(
          Effect.andThen(
            Effect.sync(() => {
              launches++
              return fixtureRuntime()
            }),
          ),
        ),
    }
    await run(executor,
      Effect.gen(function* () {
        const isolated = yield* IsolatedBrowser.Service
        const results = yield* Effect.all(
          [
            isolated.start(sessionID, { url: "https://example.test/one" }).pipe(Effect.exit),
            isolated.start(sessionID, { url: "https://example.test/two" }).pipe(Effect.exit),
          ],
          { concurrency: "unbounded" },
        )
        expect(results.filter(Exit.isSuccess)).toHaveLength(1)
        expect(results.filter(Exit.isFailure)).toHaveLength(1)
        expect(launches).toBe(1)
      }),
    )
  })

  test("owns one explicit temporary instance and requires stop before a same-Session mode switch", async () => {
    await run(fixtureExecutor(),
      Effect.gen(function* () {
        const admission = yield* BrowserAdmission.Service
        const isolated = yield* IsolatedBrowser.Service
        expect(admission.claim(sessionID, "selected")).toBe(true)
        const blocked = yield* isolated.start(sessionID, { url: "https://example.test/form" }).pipe(Effect.exit)
        expect(Exit.isFailure(blocked)).toBe(true)
        if (Exit.isFailure(blocked))
          expect(Cause.squash(blocked.cause)).toMatchObject({ _tag: "IsolatedBrowser.BusyError" })
        admission.release(sessionID, "selected")
        const started = yield* isolated.start(sessionID, { url: "https://example.test/form" })
        expect(started).toMatchObject({ mode: "isolated", state: "ready", tab: { sessionID } })
        const duplicate = yield* isolated.start(sessionID, { url: "https://example.test/other" }).pipe(Effect.exit)
        expect(Exit.isFailure(duplicate)).toBe(true)
        expect(yield* isolated.control(sessionID, { action: "pause" })).toMatchObject({
          mode: "isolated",
          state: "paused",
          tab: { status: "paused", pauseReason: "requested" },
        })
        expect(yield* isolated.control(sessionID, { action: "resume" })).toMatchObject({
          mode: "isolated",
          state: "ready",
          tab: { status: "shared", observationRevision: 0 },
        })
        yield* isolated.stop(sessionID)
        expect(yield* isolated.status(sessionID)).toEqual({ mode: "isolated", state: "stopped" })
      }),
    )
  })

  test("fences ownership, instance, tab, generation, and observation revision", async () => {
    await run(fixtureExecutor(),
      Effect.gen(function* () {
        const isolated = yield* IsolatedBrowser.Service
        const started = yield* isolated.start(sessionID, { url: "https://example.test/form" })
        const tab = started.tab!
        const stale = yield* isolated
          .observe({
            sessionID,
            instanceID: IsolatedBrowser.InstanceID.make("ibrowser_stale"),
            tabID: tab.id,
            generation: tab.generation,
            callID: "observe-stale",
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(stale)).toBe(true)
        const crossSession = yield* isolated
          .observe({
            sessionID: otherSessionID,
            instanceID: started.instanceID!,
            tabID: tab.id,
            generation: tab.generation,
            callID: "observe-cross-session",
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(crossSession)).toBe(true)
        const observation = yield* isolated.observe({
          sessionID,
          instanceID: started.instanceID!,
          tabID: tab.id,
          generation: tab.generation,
          callID: "observe-current",
        })
        expect(observation).toMatchObject({
          mode: "isolated",
          instanceID: started.instanceID,
          page: { origin: "https://example.test", path: "/form" },
        })
      }),
    )
  })

  test("reconciles exact action retries, rejects conflicting call IDs, and never evicts replay identity", async () => {
    const actions: string[] = []
    await run(fixtureExecutor(fixtureRuntime({ actions })),
      Effect.gen(function* () {
        const isolated = yield* IsolatedBrowser.Service
        const started = yield* isolated.start(sessionID, { url: "https://example.test/form" })
        const input = {
          sessionID,
          instanceID: started.instanceID!,
          tabID: started.tab!.id,
          generation: 1,
          documentGeneration: 1,
          observationRevision: 1,
          callID: "call-once",
          action: { type: "click" as const, ref: "b1" },
        }
        expect((yield* isolated.action(input)).status).toBe("completed")
        expect((yield* isolated.action(input)).status).toBe("completed")
        expect(actions).toEqual(["click"])
        const conflict = yield* isolated
          .action({ ...input, action: { type: "navigate", url: "https://example.test/next" } })
          .pipe(Effect.exit)
        expect(Exit.isFailure(conflict)).toBe(true)
        const atCapacity = yield* isolated
          .action({ ...input, callID: "call-two", action: { type: "capture" } })
          .pipe(Effect.exit)
        expect(Exit.isFailure(atCapacity)).toBe(true)
        expect((yield* isolated.action(input)).status).toBe("completed")
        expect(actions).toEqual(["click"])
      }),
      { settlementLimit: 1 },
    )
  })

  test("distinguishes predispatch rejection from postdispatch uncertainty and closes uncertain ownership", async () => {
    let closed = 0
    const predispatch = fixtureRuntime({
      action: () =>
        Effect.fail(
          new IsolatedBrowserExecutor.Error({ message: "guard rejected", phase: "predispatch" }),
        ),
      close: () => closed++,
    })
    await run(fixtureExecutor(predispatch),
      Effect.gen(function* () {
        const isolated = yield* IsolatedBrowser.Service
        const started = yield* isolated.start(sessionID, { url: "https://example.test/form" })
        const result = yield* isolated.action({
          sessionID,
          instanceID: started.instanceID!,
          tabID: started.tab!.id,
          generation: 1,
          documentGeneration: 1,
          observationRevision: 1,
          callID: "predispatch",
          action: { type: "click", ref: "b1" },
        })
        expect(result).toMatchObject({ status: "rejected", tab: { status: "shared" } })
      }),
    )
    expect(closed).toBe(1)

    closed = 0
    const postdispatch = fixtureRuntime({
      action: () =>
        Effect.fail(
          new IsolatedBrowserExecutor.Error({ message: "controller disconnected", phase: "postdispatch" }),
        ),
      close: () => closed++,
    })
    await run(fixtureExecutor(postdispatch),
      Effect.gen(function* () {
        const isolated = yield* IsolatedBrowser.Service
        const started = yield* isolated.start(sessionID, { url: "https://example.test/form" })
        const result = yield* isolated.action({
          sessionID,
          instanceID: started.instanceID!,
          tabID: started.tab!.id,
          generation: 1,
          documentGeneration: 1,
          observationRevision: 1,
          callID: "postdispatch",
          action: { type: "click", ref: "b1" },
        })
        expect(result).toMatchObject({
          status: "uncertain",
          tab: { status: "paused", pauseReason: "uncertain", uncertainCallID: "postdispatch" },
        })
      }),
    )
    expect(closed).toBe(2)
  })

  test("tears down after an injected popup-containment command failure and blocks further dispatch", async () => {
    let actions = 0
    let closed = 0
    const runtime = fixtureRuntime({
      action: () => {
        actions++
        return Effect.fail(
          new IsolatedBrowserExecutor.Error({
            message: "An unexpected browser target could not be contained",
            phase: "postdispatch",
          }),
        )
      },
      close: () => closed++,
    })
    await run(fixtureExecutor(runtime),
      Effect.gen(function* () {
        const isolated = yield* IsolatedBrowser.Service
        const started = yield* isolated.start(sessionID, { url: "https://example.test/form" })
        const first = yield* isolated.action({
          sessionID,
          instanceID: started.instanceID!,
          tabID: started.tab!.id,
          generation: 1,
          documentGeneration: 1,
          observationRevision: 1,
          callID: "popup-containment-failed",
          action: { type: "click", ref: "b1" },
        })
        expect(first).toMatchObject({
          status: "uncertain",
          message: "An unexpected browser target could not be contained",
          tab: { status: "paused", pauseReason: "uncertain" },
        })
        const second = yield* isolated
          .action({
            sessionID,
            instanceID: started.instanceID!,
            tabID: started.tab!.id,
            generation: 1,
            documentGeneration: 1,
            observationRevision: 1,
            callID: "must-not-dispatch",
            action: { type: "click", ref: "b1" },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(second)).toBe(true)
        if (Exit.isFailure(second))
          expect(Cause.squash(second.cause)).toMatchObject({ _tag: "IsolatedBrowser.FenceError" })
        expect(actions).toBe(1)
        expect(closed).toBeGreaterThanOrEqual(1)
      }),
    )
  })

  test("settles and cancels an in-flight mutation before stop destroys the owned runtime", async () => {
    let closed = 0
    await run(fixtureExecutor(fixtureRuntime({ action: () => Effect.never, close: () => closed++ })),
      Effect.gen(function* () {
        const isolated = yield* IsolatedBrowser.Service
        const started = yield* isolated.start(sessionID, { url: "https://example.test/form" })
        const running = yield* isolated
          .action({
            sessionID,
            instanceID: started.instanceID!,
            tabID: started.tab!.id,
            generation: 1,
            documentGeneration: 1,
            observationRevision: 1,
            callID: "stopped-action",
            action: { type: "click", ref: "b1" },
          })
          .pipe(Effect.forkScoped)
        yield* Effect.sleep("5 millis")
        yield* isolated.stop(sessionID)
        expect(yield* Fiber.join(running)).toMatchObject({ status: "uncertain", callID: "stopped-action" })
      }),
    )
    expect(closed).toBe(1)
  })

  test("settles caller cancellation once and ignores a late executor result", async () => {
    const late = Promise.withResolvers<IsolatedBrowserExecutor.ActionOutput>()
    const actions: string[] = []
    let closed = 0
    await run(fixtureExecutor(fixtureRuntime({
      actions,
      action: (action) =>
        Effect.promise(() => {
          actions.push(action.type)
          return late.promise
        }),
      close: () => closed++,
    })),
      Effect.gen(function* () {
        const isolated = yield* IsolatedBrowser.Service
        const started = yield* isolated.start(sessionID, { url: "https://example.test/form" })
        const input = {
          sessionID,
          instanceID: started.instanceID!,
          tabID: started.tab!.id,
          generation: 1,
          documentGeneration: 1,
          observationRevision: 1,
          callID: "caller-canceled",
          action: { type: "click" as const, ref: "b1" },
        }
        const running = yield* isolated.action(input).pipe(Effect.forkScoped)
        yield* Effect.sleep("5 millis")
        yield* Fiber.interrupt(running)
        const retry = yield* isolated.action(input)
        expect(retry).toMatchObject({
          status: "uncertain",
          callID: "caller-canceled",
          tab: { status: "paused", pauseReason: "uncertain", uncertainCallID: "caller-canceled" },
        })
        late.resolve({
          snapshot: {
            title: "Late",
            url: "https://example.test/late",
            documentGeneration: 2,
            revision: 0,
          },
        })
        yield* Effect.sleep("5 millis")
        expect(yield* isolated.action(input)).toEqual(retry)
        expect(actions).toEqual(["click"])
        expect(closed).toBeGreaterThanOrEqual(1)
      }),
    )
  })

  test("settles pending work and starts cleanup when the runtime closes spontaneously", async () => {
    const lost = Promise.withResolvers<void>()
    let closed = 0
    await run(fixtureExecutor(fixtureRuntime({
      action: () => Effect.never,
      close: () => closed++,
      closed: Effect.promise(() => lost.promise),
    })),
      Effect.gen(function* () {
        const isolated = yield* IsolatedBrowser.Service
        const started = yield* isolated.start(sessionID, { url: "https://example.test/form" })
        const running = yield* isolated
          .action({
            sessionID,
            instanceID: started.instanceID!,
            tabID: started.tab!.id,
            generation: 1,
            documentGeneration: 1,
            observationRevision: 1,
            callID: "runtime-lost",
            action: { type: "click", ref: "b1" },
          })
          .pipe(Effect.forkScoped)
        yield* Effect.sleep("5 millis")
        lost.resolve()
        yield* Effect.sleep("10 millis")
        const settledBeforeStop = running.pollUnsafe() !== undefined
        const settlement = settledBeforeStop ? yield* Fiber.join(running) : undefined
        const status = yield* isolated.status(sessionID)
        const cleanupStarted = closed
        yield* isolated.stop(sessionID)
        expect(settledBeforeStop).toBe(true)
        expect(settlement).toMatchObject({ status: "uncertain", callID: "runtime-lost" })
        expect(status).toMatchObject({ mode: "isolated", state: "unavailable" })
        expect(cleanupStarted).toBeGreaterThanOrEqual(1)
      }),
      { operationTimeout: "5 seconds" },
    )
  })

  test("closes the owned runtime when the Location-scoped service is disposed", async () => {
    let closed = 0
    await run(fixtureExecutor(fixtureRuntime({ close: () => closed++ })),
      Effect.gen(function* () {
        const isolated = yield* IsolatedBrowser.Service
        yield* isolated.start(sessionID, { url: "https://example.test/form" })
      }),
    )
    expect(closed).toBe(1)
  })

  test("interrupts pending executor work when the Location-scoped service is disposed", async () => {
    const actionStarted = Promise.withResolvers<void>()
    const late = Promise.withResolvers<IsolatedBrowserExecutor.ActionOutput>()
    let interrupted = 0
    let closed = 0
    const runtime = fixtureRuntime({
      action: () =>
        Effect.promise(() => {
          actionStarted.resolve()
          return late.promise
        }).pipe(Effect.ensuring(Effect.sync(() => interrupted++))),
      close: () => closed++,
    })
    await run(fixtureExecutor(runtime),
      Effect.gen(function* () {
        const isolated = yield* IsolatedBrowser.Service
        const started = yield* isolated.start(sessionID, { url: "https://example.test/form" })
        Effect.runFork(
          isolated.action({
            sessionID,
            instanceID: started.instanceID!,
            tabID: started.tab!.id,
            generation: 1,
            documentGeneration: 1,
            observationRevision: 1,
            callID: "location-disposed",
            action: { type: "click", ref: "b1" },
          }),
        )
        yield* Effect.promise(() => actionStarted.promise)
      }),
    )
    expect(interrupted).toBe(1)
    expect(closed).toBe(1)
    late.resolve({
      snapshot: {
        title: "Late",
        url: "https://example.test/late",
        documentGeneration: 2,
        revision: 0,
      },
    })
    await Bun.sleep(5)
    expect(interrupted).toBe(1)
  })

  test("fails closed when startup guards cannot be configured and releases mode admission", async () => {
    const executor: IsolatedBrowserExecutor.Interface = {
      availability: Effect.succeed({ available: true }),
      launch: () =>
        Effect.fail(
          new IsolatedBrowserExecutor.Error({
            message: "Required Chrome safety guards are unavailable",
            phase: "predispatch",
          }),
        ),
    }
    await run(executor,
      Effect.gen(function* () {
        const admission = yield* BrowserAdmission.Service
        const isolated = yield* IsolatedBrowser.Service
        const failed = yield* isolated.start(sessionID, { url: "https://example.test/form" }).pipe(Effect.exit)
        expect(Exit.isFailure(failed)).toBe(true)
        if (Exit.isFailure(failed))
          expect(Cause.squash(failed.cause)).toMatchObject({ _tag: "IsolatedBrowser.UnavailableError" })
        expect(admission.claim(sessionID, "selected")).toBe(true)
      }),
    )
  })

  test("marks a timed-out mutation uncertain and invalidates old instance references after restart", async () => {
    let launchCount = 0
    const executor: IsolatedBrowserExecutor.Interface = {
      availability: Effect.succeed({ available: true }),
      launch: () => {
        launchCount++
        return Effect.succeed(
          launchCount === 1 ? fixtureRuntime({ action: () => Effect.never }) : fixtureRuntime(),
        )
      },
    }
    await run(executor,
      Effect.gen(function* () {
        const isolated = yield* IsolatedBrowser.Service
        const first = yield* isolated.start(sessionID, { url: "https://example.test/form" })
        const timedOut = yield* isolated.action({
          sessionID,
          instanceID: first.instanceID!,
          tabID: first.tab!.id,
          generation: 1,
          documentGeneration: 1,
          observationRevision: 1,
          callID: "timeout-action",
          action: { type: "click", ref: "b1" },
        })
        expect(timedOut.status).toBe("uncertain")
        yield* isolated.stop(sessionID)
        const second = yield* isolated.start(sessionID, { url: "https://example.test/form" })
        expect(second.instanceID).not.toBe(first.instanceID)
        const stale = yield* isolated
          .observe({
            sessionID,
            instanceID: first.instanceID!,
            tabID: first.tab!.id,
            generation: 1,
            callID: "old-instance",
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(stale)).toBe(true)
      }),
      { operationTimeout: "10 millis" },
    )
  })
})
