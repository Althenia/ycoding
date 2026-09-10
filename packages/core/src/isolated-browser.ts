export * as IsolatedBrowser from "./isolated-browser"

import { Browser } from "@ycoding-ai/schema/browser"
import { IsolatedBrowser } from "@ycoding-ai/schema/isolated-browser"
import { Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Schema, Stream, Types } from "effect"
import { BrowserAdmission } from "./browser/admission"
import { IsolatedBrowserExecutor } from "./browser/isolated-executor"
import { makeLocationNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { Location } from "./location"
import { SessionErrors } from "./session/error"
import { SessionEvent } from "./session/event"
import { SessionStore } from "./session/store"

export { IsolatedBrowser as Schema }
export const InstanceID = IsolatedBrowser.InstanceID
export const Status = IsolatedBrowser.Status
export const StartInput = IsolatedBrowser.StartInput
export const Observation = IsolatedBrowser.Observation
export const ObserveInput = IsolatedBrowser.ObserveInput
export const ActionInput = IsolatedBrowser.ActionInput
export const ActionResult = IsolatedBrowser.ActionResult
export const ControlInput = IsolatedBrowser.ControlInput

export type Status = IsolatedBrowser.Status
export type StartInput = IsolatedBrowser.StartInput
export type Observation = IsolatedBrowser.Observation
export type ObserveInput = IsolatedBrowser.ObserveInput
export type ActionInput = IsolatedBrowser.ActionInput
export type ActionResult = IsolatedBrowser.ActionResult

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("IsolatedBrowser.UnavailableError", {
  message: Schema.String,
}) {}
export class OwnershipError extends Schema.TaggedErrorClass<OwnershipError>()("IsolatedBrowser.OwnershipError", {
  message: Schema.String,
}) {}
export class FenceError extends Schema.TaggedErrorClass<FenceError>()("IsolatedBrowser.FenceError", {
  message: Schema.String,
}) {}
export class BusyError extends Schema.TaggedErrorClass<BusyError>()("IsolatedBrowser.BusyError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly status: (sessionID: Browser.Tab["sessionID"]) => Effect.Effect<Status, SessionErrors.NotFoundError>
  readonly start: (
    sessionID: Browser.Tab["sessionID"],
    input: StartInput,
  ) => Effect.Effect<Status, SessionErrors.NotFoundError | BusyError | UnavailableError>
  readonly list: (sessionID: Browser.Tab["sessionID"]) => Effect.Effect<ReadonlyArray<Browser.Tab>, SessionErrors.NotFoundError>
  readonly observe: (
    input: ObserveInput,
  ) => Effect.Effect<Observation, SessionErrors.NotFoundError | OwnershipError | FenceError | BusyError | UnavailableError>
  readonly action: (
    input: ActionInput,
  ) => Effect.Effect<ActionResult, SessionErrors.NotFoundError | OwnershipError | FenceError | BusyError | UnavailableError>
  readonly control: (
    sessionID: Browser.Tab["sessionID"],
    input: IsolatedBrowser.ControlInput,
  ) => Effect.Effect<Status, SessionErrors.NotFoundError | OwnershipError | FenceError | UnavailableError>
  readonly stop: (
    sessionID: Browser.Tab["sessionID"],
  ) => Effect.Effect<void, SessionErrors.NotFoundError | OwnershipError>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/IsolatedBrowser") {}

export interface Options {
  readonly operationTimeout?: Duration.Input
  readonly settlementLimit?: number
}

const DEFAULT_OPERATION_TIMEOUT = Duration.seconds(30)
const DEFAULT_SETTLEMENT_LIMIT = 256

type MutableTab = Types.DeepMutable<Browser.Tab> & { elements: Map<string, Browser.Element> }
type Settlement = { readonly fingerprint: string; readonly result: ActionResult }
type PendingAction = {
  readonly callID: string
  readonly fingerprint: string
  readonly mutation: boolean
  readonly deferred: Deferred.Deferred<ActionResult>
  fiber?: Fiber.Fiber<void>
}
type Instance = {
  readonly sessionID: Browser.Tab["sessionID"]
  readonly instanceID: IsolatedBrowser.InstanceID
  readonly tab: MutableTab
  readonly settlements: Map<string, Settlement>
  state: "unavailable" | "starting" | "ready" | "paused"
  runtime?: IsolatedBrowserExecutor.Runtime
  pending?: PendingAction
  watcher?: Fiber.Fiber<void>
  reason?: string
}

export const layer = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const location = yield* Location.Service
      const sessions = yield* SessionStore.Service
      const admission = yield* BrowserAdmission.Service
      const executor = yield* IsolatedBrowserExecutor.Service
      const events = yield* EventV2.Service
      const operationTimeout = options.operationTimeout ?? DEFAULT_OPERATION_TIMEOUT
      const settlementLimit = options.settlementLimit ?? DEFAULT_SETTLEMENT_LIMIT
      const instances = new Map<Browser.Tab["sessionID"], Instance>()

      const assertSession = Effect.fn("IsolatedBrowser.assertSession")(function* (
        sessionID: Browser.Tab["sessionID"],
      ) {
        const session = yield* sessions.get(sessionID)
        if (!session || session.time.archived) return yield* new SessionErrors.NotFoundError({ sessionID })
        if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
          return yield* new SessionErrors.NotFoundError({ sessionID })
        return undefined
      })

      const publicTab = (tab: MutableTab): Browser.Tab => {
        const { elements: _elements, ...result } = tab
        return result
      }

      const publicStatus = (instance: Instance): Status => ({
        mode: "isolated",
        state: instance.state,
        instanceID: instance.instanceID,
        tab: publicTab(instance.tab),
        reason: instance.reason,
      })

      const requireInstance = Effect.fn("IsolatedBrowser.requireInstance")(function* (
        sessionID: Browser.Tab["sessionID"],
        instanceID?: IsolatedBrowser.InstanceID,
      ) {
        yield* assertSession(sessionID)
        const instance = instances.get(sessionID)
        if (!instance) return yield* new UnavailableError({ message: "No isolated browser is active for this Session" })
        if (instanceID !== undefined && instance.instanceID !== instanceID)
          return yield* new OwnershipError({ message: "Isolated browser instance is stale or belongs to another Session" })
        return instance
      })

      const status = Effect.fn("IsolatedBrowser.status")(function* (sessionID: Browser.Tab["sessionID"]) {
        yield* assertSession(sessionID)
        const instance = instances.get(sessionID)
        if (instance) return publicStatus(instance)
        const available = yield* executor.availability
        return available.available
          ? ({ mode: "isolated", state: "stopped" } as const)
          : ({ mode: "isolated", state: "unavailable", reason: available.reason } as const)
      })

      const start = Effect.fn("IsolatedBrowser.start")(function* (
        sessionID: Browser.Tab["sessionID"],
        input: StartInput,
      ) {
        yield* assertSession(sessionID)
        if (instances.has(sessionID))
          return yield* new BusyError({ message: "Stop the current isolated browser before starting another" })
        const available = yield* executor.availability
        if (!available.available)
          return yield* new UnavailableError({ message: available.reason ?? "Isolated Chrome is unavailable" })
        const page = yield* parsePage(input.url)
        if (!admission.claim(sessionID, "isolated"))
          return yield* new BusyError({ message: "Stop selected-tab browser control before starting an isolated browser" })
        const instanceID = IsolatedBrowser.InstanceID.create()
        const tabID = Browser.TabID.create()
        const instance: Instance = {
          sessionID,
          instanceID,
          state: "starting",
          settlements: new Map(),
          tab: {
            id: tabID,
            sessionID,
            title: "",
            page,
            status: "unavailable",
            generation: 1,
            documentGeneration: 1,
            observationRevision: 0,
            elements: new Map(),
          },
        }
        instances.set(sessionID, instance)
        const runtime = yield* executor
          .launch({ instanceID, tabID, url: input.url })
          .pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? Effect.sync(() => {
                    if (instances.get(sessionID) !== instance) return
                    instances.delete(sessionID)
                    admission.release(sessionID, "isolated")
                  })
                : Effect.void,
            ),
            Effect.mapError((error) => new UnavailableError({ message: error.message })),
          )
        if (instances.get(sessionID) !== instance) {
          yield* runtime.close
          return yield* new UnavailableError({ message: "Isolated browser startup was stopped" })
        }
        instance.runtime = runtime
        const observed = yield* runtime.observe.pipe(
          Effect.timeoutOrElse({
            duration: operationTimeout,
            orElse: () =>
              Effect.fail(
                new IsolatedBrowserExecutor.Error({
                  message: "Isolated browser startup observation timed out",
                  phase: "predispatch",
                }),
              ),
          }),
          Effect.onExit((exit) => (Exit.isFailure(exit) ? runtime.close : Effect.void)),
          Effect.mapError((error) => new UnavailableError({ message: error.message })),
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Effect.sync(() => {
                  if (instances.get(sessionID) !== instance) return
                  instances.delete(sessionID)
                  admission.release(sessionID, "isolated")
                })
              : Effect.void,
          ),
        )
        if (instances.get(sessionID) !== instance) {
          yield* runtime.close
          return yield* new UnavailableError({ message: "Isolated browser startup was stopped" })
        }
        applyObservation(instance, observed)
        instance.state = "ready"
        instance.tab.status = "shared"
        instance.watcher = Effect.runFork(
          runtime.closed.pipe(
            Effect.andThen(
              Effect.gen(function* () {
                if (instances.get(sessionID) !== instance) return
                instance.state = "unavailable"
                instance.reason = "Isolated Chrome disconnected"
                instance.tab.status = "unavailable"
                instance.tab.pauseReason = "disconnected"
                instance.tab.elements.clear()
                const pending = instance.pending
                if (pending) {
                  const result: ActionResult = {
                    mode: "isolated",
                    instanceID: instance.instanceID,
                    callID: pending.callID,
                    tab: publicTab(instance.tab),
                    status: pending.mutation ? "uncertain" : "rejected",
                    message: pending.mutation
                      ? "Isolated Chrome disconnected while a mutation was settling"
                      : "Isolated Chrome disconnected before the action settled",
                  }
                  settlePending(instance, pending, result)
                  if (pending.fiber) yield* Fiber.interrupt(pending.fiber)
                }
                yield* runtime.close
              }),
            ),
          ),
        )
        return publicStatus(instance)
      })

      const list = Effect.fn("IsolatedBrowser.list")(function* (sessionID: Browser.Tab["sessionID"]) {
        yield* assertSession(sessionID)
        const instance = instances.get(sessionID)
        return instance ? [publicTab(instance.tab)] : []
      })

      const observe = Effect.fn("IsolatedBrowser.observe")(function* (input: ObserveInput) {
        const instance = yield* requireInstance(input.sessionID, input.instanceID)
        if (instance.pending) return yield* new BusyError({ message: "An isolated browser action is still settling" })
        if (instance.state !== "ready" || !instance.runtime)
          return yield* new FenceError({ message: "Isolated browser control is paused" })
        if (instance.tab.id !== input.tabID)
          return yield* new OwnershipError({ message: "Isolated browser tab is stale or belongs to another Session" })
        if (instance.tab.generation !== input.generation)
          return yield* new FenceError({ message: "Isolated browser generation is stale" })
        const observed = yield* instance.runtime.observe.pipe(
          Effect.timeoutOrElse({
            duration: operationTimeout,
            orElse: () =>
              Effect.fail(
                new IsolatedBrowserExecutor.Error({
                  message: "Isolated browser observation timed out",
                  phase: "predispatch",
                }),
              ),
          }),
          Effect.mapError((error) => new UnavailableError({ message: error.message })),
        )
        applyObservation(instance, observed)
        return {
          mode: "isolated" as const,
          instanceID: instance.instanceID,
          tabID: instance.tab.id,
          generation: instance.tab.generation,
          documentGeneration: instance.tab.documentGeneration,
          revision: instance.tab.observationRevision,
          title: instance.tab.title,
          page: instance.tab.page,
          elements: [...instance.tab.elements.values()],
          truncated: observed.truncated,
        }
      })

      const action = Effect.fn("IsolatedBrowser.action")(function* (input: ActionInput) {
        const instance = yield* requireInstance(input.sessionID, input.instanceID)
        if (instance.tab.id !== input.tabID)
          return yield* new OwnershipError({ message: "Isolated browser tab is stale or belongs to another Session" })
        const fingerprint = actionFingerprint(input)
        const settled = instance.settlements.get(input.callID)
        if (settled) {
          if (settled.fingerprint !== fingerprint)
            return yield* new FenceError({ message: "Isolated browser call ID was already used for another action" })
          return settled.result
        }
        if (instance.settlements.size >= settlementLimit)
          return yield* new BusyError({ message: "Isolated browser call identity capacity is exhausted; stop it before continuing" })
        if (instance.pending) return yield* new BusyError({ message: "An isolated browser action is still settling" })
        if (instance.state !== "ready" || !instance.runtime)
          return yield* new FenceError({ message: "Isolated browser control is paused" })
        if (
          instance.tab.generation !== input.generation ||
          instance.tab.documentGeneration !== input.documentGeneration ||
          instance.tab.observationRevision !== input.observationRevision
        )
          return yield* new FenceError({ message: "Isolated browser observation is stale; observe again" })
        const element =
          input.action.type === "click" || input.action.type === "type"
            ? instance.tab.elements.get(input.action.ref)
            : undefined
        if ((input.action.type === "click" || input.action.type === "type") && !element)
          return yield* new FenceError({ message: "Semantic element reference is stale" })
        if (element?.disabled) return yield* new FenceError({ message: "Semantic element is disabled" })
        const destination = yield* destinationPage(input.action, element)
        const allowedOrigins = [...new Set([instance.tab.page.origin, ...(destination ? [destination.origin] : [])])]
        const mutation = ["navigate", "click", "type"].includes(input.action.type)
        const deferred = yield* Deferred.make<ActionResult>()
        const pending: PendingAction = { callID: input.callID, fingerprint, mutation, deferred }
        instance.pending = pending
        const runtime = instance.runtime
        const settle = (result: ActionResult) =>
          Effect.sync(() => {
            if (!instance.settlements.has(input.callID)) instance.settlements.set(input.callID, { fingerprint, result })
            if (instance.pending === pending) instance.pending = undefined
            Deferred.doneUnsafe(deferred, Effect.succeed(instance.settlements.get(input.callID)?.result ?? result))
          })
        pending.fiber = Effect.runFork(runtime
          .action(input.action, allowedOrigins)
          .pipe(
            Effect.timeoutOrElse({
              duration: operationTimeout,
              orElse: () =>
                Effect.fail(
                  new IsolatedBrowserExecutor.Error({
                    message: "Isolated browser action timed out",
                    phase: mutation ? "postdispatch" : "predispatch",
                  }),
                ),
            }),
            Effect.matchEffect({
              onSuccess: (output) => {
                if (instance.pending !== pending || instance.settlements.has(input.callID)) return Effect.void
                applySnapshot(instance, output.snapshot)
                const result: ActionResult = {
                  mode: "isolated",
                  instanceID: instance.instanceID,
                  callID: input.callID,
                  tab: publicTab(instance.tab),
                  status: output.rejected ? "rejected" : "completed",
                  message: output.rejected,
                  capture: output.capture,
                }
                return settle(result)
              },
              onFailure: (error) => {
                const uncertain = error.phase === "postdispatch" && mutation
                if (uncertain) {
                  instance.state = "paused"
                  instance.reason = "A dispatched browser mutation did not settle"
                  instance.tab.status = "paused"
                  instance.tab.pauseReason = "uncertain"
                  instance.tab.uncertainCallID = input.callID
                }
                const result: ActionResult = {
                  mode: "isolated",
                  instanceID: instance.instanceID,
                  callID: input.callID,
                  tab: publicTab(instance.tab),
                  status: uncertain ? "uncertain" : "rejected",
                  message: bounded(error.message, 1024),
                }
                return settle(result).pipe(Effect.andThen(uncertain ? runtime.close : Effect.void))
              },
            }),
          ))
        return yield* Deferred.await(deferred).pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              if (instance.pending !== pending || instance.settlements.has(input.callID)) return
              if (mutation) {
                instance.state = "paused"
                instance.reason = "A browser mutation was canceled before settlement"
                instance.tab.status = "paused"
                instance.tab.pauseReason = "uncertain"
                instance.tab.uncertainCallID = input.callID
              }
              const result: ActionResult = {
                mode: "isolated",
                instanceID: instance.instanceID,
                callID: input.callID,
                tab: publicTab(instance.tab),
                status: mutation ? "uncertain" : "rejected",
                message: mutation
                  ? "The browser action caller canceled while mutation completion was unknown"
                  : "The browser action caller canceled before settlement",
              }
              settlePending(instance, pending, result)
              if (pending.fiber) yield* Fiber.interrupt(pending.fiber)
              if (mutation) yield* runtime.close
            }),
          ),
        )
      })

      const control = Effect.fn("IsolatedBrowser.control")(function* (
        sessionID: Browser.Tab["sessionID"],
        input: IsolatedBrowser.ControlInput,
      ) {
        const instance = yield* requireInstance(sessionID)
        if (!instance.runtime) return yield* new UnavailableError({ message: "Isolated Chrome is unavailable" })
        if (instance.pending)
          return yield* new FenceError({ message: "Cannot change control while an isolated browser action is settling" })
        if (input.action === "pause") {
          yield* instance.runtime.pause
          instance.state = "paused"
          instance.reason = undefined
          instance.tab.status = "paused"
          instance.tab.pauseReason = "requested"
          return publicStatus(instance)
        }
        yield* instance.runtime.resume.pipe(Effect.mapError((error) => new UnavailableError({ message: error.message })))
        instance.state = "ready"
        instance.reason = undefined
        instance.tab.status = "shared"
        instance.tab.observationRevision = 0
        instance.tab.elements.clear()
        delete instance.tab.pauseReason
        delete instance.tab.uncertainCallID
        return publicStatus(instance)
      })

      const releaseSession = Effect.fn("IsolatedBrowser.releaseSession")(function* (
        sessionID: Browser.Tab["sessionID"],
        message: string,
      ) {
        const instance = instances.get(sessionID)
        if (!instance) {
          admission.release(sessionID, "isolated")
          return
        }
        if (instance.pending) {
          const pending = instance.pending
          const result: ActionResult = {
            mode: "isolated",
            instanceID: instance.instanceID,
            callID: pending.callID,
            tab: publicTab(instance.tab),
            status: pending.mutation ? "uncertain" : "rejected",
            message: pending.mutation
              ? `The isolated browser ${message} while a mutation was settling`
              : `The isolated browser ${message} before the action settled`,
          }
          settlePending(instance, pending, result)
          if (pending.fiber) yield* Fiber.interrupt(pending.fiber)
        }
        instances.delete(sessionID)
        admission.release(sessionID, "isolated")
        if (instance.watcher) yield* Fiber.interrupt(instance.watcher)
        if (instance.runtime) yield* instance.runtime.close
      })

      const stop = Effect.fn("IsolatedBrowser.stop")(function* (sessionID: Browser.Tab["sessionID"]) {
        yield* assertSession(sessionID)
        yield* releaseSession(sessionID, "was stopped")
      })

      yield* events.subscribe([SessionEvent.Moved, SessionEvent.Deleted, SessionEvent.Archived]).pipe(
        Stream.runForEach((event) =>
          releaseSession(event.data.sessionID, `ownership ended because the Session was ${event.type.slice("session.".length)}`),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          [...instances.keys()],
          (sessionID) => releaseSession(sessionID, "service stopped"),
          { discard: true },
        ).pipe(Effect.ensuring(Effect.sync(() => instances.clear()))),
      )

      return Service.of({ status, start, list, observe, action, control, stop })
    }),
  )

export const node = makeLocationNode({
  service: Service,
  layer: layer(),
  deps: [BrowserAdmission.node, EventV2.node, IsolatedBrowserExecutor.node, Location.node, SessionStore.node],
})

function applyObservation(instance: Instance, observed: IsolatedBrowserExecutor.Snapshot) {
  applySnapshot(instance, observed)
  instance.tab.observationRevision = observed.revision
  instance.tab.elements = new Map(observed.elements.map((element) => [element.ref, element]))
}

function settlePending(instance: Instance, pending: PendingAction, result: ActionResult) {
  if (!instance.settlements.has(pending.callID))
    instance.settlements.set(pending.callID, { fingerprint: pending.fingerprint, result })
  if (instance.pending === pending) instance.pending = undefined
  Deferred.doneUnsafe(pending.deferred, Effect.succeed(instance.settlements.get(pending.callID)?.result ?? result))
}

function applySnapshot(instance: Instance, snapshot: Omit<IsolatedBrowserExecutor.Snapshot, "elements" | "truncated">) {
  const page = parsePageSync(snapshot.url)
  instance.tab.title = bounded(snapshot.title, Browser.MAX_TITLE_LENGTH)
  instance.tab.page = page
  instance.tab.documentGeneration = snapshot.documentGeneration
  instance.tab.observationRevision = snapshot.revision
  instance.tab.elements.clear()
}

function destinationPage(action: Browser.Action, element: Browser.Element | undefined) {
  return Effect.try({
    try: () =>
      action.type === "navigate" ? parsePageSync(action.url) : action.type === "click" ? element?.destination : undefined,
    catch: () => new FenceError({ message: "Only credential-free HTTP and HTTPS navigation is supported" }),
  })
}

function parsePage(input: string) {
  return Effect.try({
    try: () => parsePageSync(input),
    catch: () => new UnavailableError({ message: "Only credential-free HTTP and HTTPS navigation is supported" }),
  })
}

function parsePageSync(input: string): Browser.Page {
  const url = new URL(input)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Only credential-free HTTP and HTTPS navigation is supported")
  return { origin: url.origin, path: url.pathname || "/" }
}

function actionFingerprint(input: ActionInput) {
  const fence = [
    input.sessionID,
    input.instanceID,
    input.tabID,
    input.generation,
    input.documentGeneration,
    input.observationRevision,
  ]
  if (input.action.type === "navigate") return JSON.stringify([...fence, "navigate", input.action.url])
  if (input.action.type === "click") return JSON.stringify([...fence, "click", input.action.ref])
  if (input.action.type === "type") return JSON.stringify([...fence, "type", input.action.ref, input.action.text])
  if (input.action.type === "scroll") return JSON.stringify([...fence, "scroll", input.action.deltaY])
  return JSON.stringify([...fence, "capture"])
}

function bounded(input: string, length: number) {
  return input.length <= length ? input : input.slice(0, length)
}
