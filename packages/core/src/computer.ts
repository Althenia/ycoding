export * as Computer from "./computer"

import { Context, Effect, Exit, Layer, Schema, Semaphore, Stream } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { makeGlobalNode, makeLocationNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { AppProcess } from "./process"
import { SessionEvent } from "./session/event"
import { SessionSchema } from "./session/schema"
import { MacOSComputer } from "./computer/macos"
import { NativeError, type AgentDisplay, type ComputerFrame, type Status } from "./computer/types"

export { NativeError } from "./computer/types"
export type Target = MacOSComputer.Target
export type Action = MacOSComputer.Action
export type NativeRequest = MacOSComputer.Request
export type NativeSuccess = MacOSComputer.Success
export type InvokeNative = MacOSComputer.Invoke

export class OwnershipError extends Schema.TaggedErrorClass<OwnershipError>()("Computer.OwnershipError", {
  message: Schema.String,
}) {}

export type Error = NativeError | OwnershipError

export interface Interface {
  readonly status: Effect.Effect<Status>
  readonly list: (input: { readonly sessionID: SessionSchema.ID; readonly callID: string }) => Effect.Effect<NativeSuccess, Error>
  readonly launch: (input: { readonly sessionID: SessionSchema.ID; readonly callID: string; readonly bundleID: string; readonly remoteDebugging?: boolean }) => Effect.Effect<NativeSuccess, Error>
  readonly quit: (input: { readonly sessionID: SessionSchema.ID; readonly callID: string; readonly bundleID: string; readonly pid: number }) => Effect.Effect<NativeSuccess, Error>
  readonly browserTabs: (input: { readonly sessionID: SessionSchema.ID; readonly callID: string; readonly bundleID: MacOSComputer.BrowserTarget["bundleID"] }) => Effect.Effect<NativeSuccess, Error>
  readonly browserAct: (input: { readonly sessionID: SessionSchema.ID; readonly callID: string; readonly target: MacOSComputer.BrowserTarget; readonly expectedRevision: string; readonly action: MacOSComputer.BrowserAction }) => Effect.Effect<NativeSuccess, Error>
  readonly stage: (input: { readonly sessionID: SessionSchema.ID; readonly callID: string; readonly target: MacOSComputer.DesktopTarget; readonly expectedRevision: string }) => Effect.Effect<NativeSuccess, Error>
  readonly unstage: (input: { readonly sessionID: SessionSchema.ID; readonly callID: string; readonly target: MacOSComputer.DesktopTarget }) => Effect.Effect<NativeSuccess, Error>
  readonly inspect: (input: {
    readonly sessionID: SessionSchema.ID
    readonly callID: string
    readonly target: Target
  }) => Effect.Effect<NativeSuccess, Error>
  readonly act: (input: {
    readonly sessionID: SessionSchema.ID
    readonly callID: string
    readonly target: Target
    readonly expectedRevision: string
    readonly action: Action
  }) => Effect.Effect<NativeSuccess, Error>
  readonly capture: (input: {
    readonly sessionID: SessionSchema.ID
    readonly callID: string
    readonly target: MacOSComputer.DesktopTarget
  }) => Effect.Effect<NativeSuccess, Error>
  readonly cancel: (input: { readonly sessionID: SessionSchema.ID; readonly callID: string }) => Effect.Effect<boolean>
  readonly releaseSession: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

interface Claim {
  readonly locationToken: object
  readonly sessionID: SessionSchema.ID
  readonly revision: string
}

interface Active {
  readonly locationToken: object
  readonly token: object
  readonly sessionID: SessionSchema.ID
  readonly callID: string
  readonly targetKey: string
  readonly controller: AbortController
}

interface DisplayOwner {
  readonly controlDirectory: string
  readonly display: AgentDisplay
}

interface StagedWindow {
  readonly sessionID: SessionSchema.ID
  readonly target: MacOSComputer.DesktopTarget
  readonly originalFrame: ComputerFrame
}

const callKey = (sessionID: SessionSchema.ID, callID: string) => `${sessionID}\0${callID}`

const desktopMutation = (request: NativeRequest) =>
  request.action.startsWith("desktop.") &&
  request.action !== "desktop.inspect" &&
  request.action !== "desktop.capture" &&
  request.action !== "desktop.list" &&
  request.action !== "desktop.launch"

interface Coordinator {
  readonly service: (locationToken: object) => Interface
  readonly releaseSession: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly releaseLocation: (locationToken: object) => Effect.Effect<void>
}

export function make(invoke: InvokeNative, platform: NodeJS.Platform = process.platform): Interface {
  return makeCoordinator(invoke, platform).service({})
}

function makeCoordinator(invoke: InvokeNative, platform: NodeJS.Platform): Coordinator {
  const claims = new Map<string, Claim>()
  const activeCalls = new Map<string, Active>()
  const activeTargets = new Map<string, Active>()
  const displayOwners = new Map<object, DisplayOwner>()
  const stagedWindows = new Map<object, Map<string, StagedWindow>>()
  const desktopInput = Semaphore.makeUnsafe(1)

  const begin = Effect.fnUntraced(function* (
    locationToken: object,
    sessionID: SessionSchema.ID,
    callID: string,
    target: Target,
    expectedRevision?: string,
  ) {
    const key = MacOSComputer.targetKey(target)
    const invocationKey = callKey(sessionID, callID)
    if (activeCalls.has(invocationKey))
      return yield* new OwnershipError({ message: "This Session already has an active computer call with that ID" })
    if (activeTargets.has(key))
      return yield* new OwnershipError({ message: "Target already has an active computer call" })
    const claim = claims.get(key)
    if (claim && claim.sessionID !== sessionID)
      return yield* new OwnershipError({ message: "Target is owned by another Session" })
    if (expectedRevision !== undefined && !claim)
      return yield* new OwnershipError({ message: "Target must be inspected by this Session before mutation" })
    if (
      expectedRevision !== undefined &&
      (claim?.revision !== expectedRevision || claim.locationToken !== locationToken)
    )
      return yield* new OwnershipError({ message: "Target revision is stale; inspect it again before mutation" })
    const active = {
      locationToken,
      token: {},
      sessionID,
      callID,
      targetKey: key,
      controller: new AbortController(),
    }
    activeCalls.set(invocationKey, active)
    activeTargets.set(key, active)
    return active
  })

  const finish = (active: Active) =>
    Effect.sync(() => {
      const invocationKey = callKey(active.sessionID, active.callID)
      if (activeCalls.get(invocationKey)?.token === active.token) activeCalls.delete(invocationKey)
      if (activeTargets.get(active.targetKey)?.token === active.token) activeTargets.delete(active.targetKey)
    })

  const run = (
    locationToken: object,
    input: { readonly sessionID: SessionSchema.ID; readonly callID: string; readonly target: Target },
    request: NativeRequest | ((signal: AbortSignal) => Effect.Effect<NativeRequest, Error>),
    expectedRevision?: string,
    onSuccess?: (result: NativeSuccess) => Effect.Effect<void, Error>,
    onFailure?: (error: Error) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const active = yield* begin(locationToken, input.sessionID, input.callID, input.target, expectedRevision)
      const perform = Effect.gen(function* () {
        const nativeRequest = typeof request === "function" ? yield* request(active.controller.signal) : request
        if (active.controller.signal.aborted)
          return yield* new OwnershipError({ message: "Computer call was cancelled; inspect the target again" })
        return yield* invoke(nativeRequest, active.controller.signal).pipe(
          Effect.tap((result) => Effect.gen(function* () {
            if (onSuccess) yield* onSuccess(result)
            if (active.controller.signal.aborted || activeCalls.get(callKey(active.sessionID, active.callID))?.token !== active.token) return
            if (nativeRequest.action === "finder.move") claims.delete(active.targetKey)
            else claims.set(active.targetKey, { locationToken, sessionID: input.sessionID, revision: result.revision })
          })),
          Effect.tap(() => active.controller.signal.aborted
            ? Effect.fail(new OwnershipError({ message: "Computer call was cancelled; inspect the target again" }))
            : Effect.void),
        )
      }).pipe(
        Effect.tapError((error) => Effect.gen(function* () {
          if (error instanceof OwnershipError || (error instanceof NativeError && (error.outcome === "unknown" || error.code === "stale_revision" || error.code === "target_not_found")))
            claims.delete(active.targetKey)
          if (onFailure) yield* onFailure(error)
        })),
      )
      // Raw desktop input briefly moves the user's key focus and restores it; overlapping calls on different
      // windows would each save the other's target as the user's focus, so desktop mutations run one at a time.
      return yield* (typeof request === "function" || desktopMutation(request) ? desktopInput.withPermit(perform) : perform).pipe(
        Effect.ensuring(finish(active)),
      )
    })

  const runUnclaimed = (
    locationToken: object,
    input: { readonly sessionID: SessionSchema.ID; readonly callID: string },
    request: NativeRequest,
  ) => Effect.gen(function* () {
    const invocationKey = callKey(input.sessionID, input.callID)
    if (activeCalls.has(invocationKey))
      return yield* new OwnershipError({ message: "This Session already has an active computer call with that ID" })
    const active: Active = { locationToken, token: {}, sessionID: input.sessionID, callID: input.callID,
      targetKey: `unclaimed\0${invocationKey}`, controller: new AbortController() }
    activeCalls.set(invocationKey, active)
    const dispatch = invoke(request, active.controller.signal)
    return yield* (request.action === "desktop.quit" || (request.action === "desktop.launch" && request.remoteDebugging)
      ? desktopInput.withPermit(dispatch) : dispatch).pipe(
      Effect.tap(() => active.controller.signal.aborted
        ? Effect.fail(new OwnershipError({ message: "Computer call was cancelled" })) : Effect.void),
      Effect.ensuring(finish(active)),
    )
  })

  const stopDisplayOwner = (locationToken: object) => {
    const owner = displayOwners.get(locationToken)
    if (!owner) return Effect.void
    return Effect.promise(() => writeFile(path.join(owner.controlDirectory, "stop"), "")).pipe(
      Effect.tap(() => Effect.sync(() => displayOwners.delete(locationToken))),
    )
  }

  const stopDisplayOwnerWhenEmpty = (locationToken: object) =>
    stagedWindows.get(locationToken)?.size ? Effect.void : stopDisplayOwner(locationToken)

  const removeStagedWindow = (locationToken: object, key: string) =>
    Effect.sync(() => {
      const windows = stagedWindows.get(locationToken)
      windows?.delete(key)
      if (windows?.size === 0) stagedWindows.delete(locationToken)
    })

  const startDisplayOwner = (
    locationToken: object,
    input: { readonly sessionID: SessionSchema.ID; readonly callID: string },
    signal: AbortSignal,
  ) => Effect.gen(function* () {
    const controlDirectory = yield* Effect.tryPromise({
      try: () => mkdtemp(path.join(os.tmpdir(), "ycoding-agent-display-")),
      catch: () => new NativeError({ code: "background_unavailable", message: "Could not create the agent display control directory", outcome: "not_started" }),
    })
    const response = yield* invoke(
      MacOSComputer.displayHoldRequest(
        { sessionID: input.sessionID, callID: `${input.callID}:display-owner` },
        controlDirectory,
        process.pid,
      ),
      signal,
    ).pipe(Effect.tapError((error) => Effect.promise(() =>
      error.code === "background_unavailable"
        ? rm(controlDirectory, { recursive: true, force: true })
        : writeFile(path.join(controlDirectory, "stop"), ""),
    )))
    if (!response.display || response.display.id <= 0 || response.display.width <= 0 || response.display.height <= 0) {
      yield* Effect.promise(() => writeFile(path.join(controlDirectory, "stop"), ""))
      return yield* new NativeError({ code: "background_unavailable", message: "The agent display owner returned no usable display bounds", outcome: "not_started" })
    }
    const owner = { controlDirectory, display: response.display }
    displayOwners.set(locationToken, owner)
    return owner
  })

  const unstageWindow = (locationToken: object, window: StagedWindow, callID: string) =>
    run(
      locationToken,
      { sessionID: window.sessionID, callID, target: window.target },
      MacOSComputer.unstageRequest({ sessionID: window.sessionID, callID }, window.target, window.originalFrame),
      undefined,
      () => Effect.gen(function* () {
        yield* removeStagedWindow(locationToken, MacOSComputer.targetKey(window.target))
        yield* stopDisplayOwnerWhenEmpty(locationToken)
      }),
      (error) => error instanceof NativeError && error.code === "target_not_found"
        ? removeStagedWindow(locationToken, MacOSComputer.targetKey(window.target)).pipe(Effect.flatMap(() => stopDisplayOwnerWhenEmpty(locationToken)))
        : Effect.void,
    )

  const restoreStaged = (locationToken: object, sessionID?: SessionSchema.ID) => Effect.gen(function* () {
    const windows = yield* desktopInput.withPermit(Effect.sync(() =>
      [...(stagedWindows.get(locationToken)?.values() ?? [])].filter((window) => sessionID === undefined || window.sessionID === sessionID),
    ))
    const results = yield* Effect.forEach(windows, (window) =>
      unstageWindow(locationToken, window, `display-restore-${crypto.randomUUID()}`).pipe(Effect.exit),
      { concurrency: 1 },
    )
    const failure = results.find(Exit.isFailure)
    if (failure && Exit.isFailure(failure)) yield* Effect.failCause(failure.cause)
  })

  const releaseSession = Effect.fn("Computer.releaseSession")((sessionID: SessionSchema.ID) =>
    Effect.gen(function* () {
      const locations = new Set<object>([
        ...[...stagedWindows.entries()].filter(([, windows]) => [...windows.values()].some((window) => window.sessionID === sessionID)).map(([locationToken]) => locationToken),
        ...[...activeCalls.values()].filter((active) => active.sessionID === sessionID).map((active) => active.locationToken),
      ])
      yield* Effect.sync(() => {
        for (const [key, claim] of claims) if (claim.sessionID === sessionID) claims.delete(key)
        for (const active of activeCalls.values()) {
          if (active.sessionID !== sessionID) continue
          active.controller.abort(new Error("Computer control was revoked for this Session"))
          claims.delete(active.targetKey)
        }
      })
      const results = yield* Effect.forEach(locations, (locationToken) => restoreStaged(locationToken, sessionID).pipe(Effect.exit), { concurrency: 1 })
      yield* Effect.forEach(results, (result) => Exit.isFailure(result) ? Effect.logError(result.cause) : Effect.void)
    }),
  )

  const releaseLocation = Effect.fn("Computer.releaseLocation")((locationToken: object) =>
    Effect.gen(function* () {
      for (const [key, claim] of claims) if (claim.locationToken === locationToken) claims.delete(key)
      for (const active of activeCalls.values()) {
        if (active.locationToken !== locationToken) continue
        active.controller.abort(new Error("Computer control was revoked for this Location"))
        claims.delete(active.targetKey)
      }
      const restored = yield* restoreStaged(locationToken).pipe(Effect.exit)
      stagedWindows.delete(locationToken)
      yield* stopDisplayOwner(locationToken)
      if (Exit.isFailure(restored)) yield* Effect.logError(restored.cause)
    }),
  )

  const service = (locationToken: object) =>
    Service.of({
      status: Effect.succeed({
        platform: platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform,
        state: platform === "darwin" ? "supported" : "unsupported",
        capabilities: platform === "darwin" ? MacOSComputer.capabilities : [],
      }),
      list: Effect.fn("Computer.list")((input) =>
        platform === "darwin"
          ? runUnclaimed(locationToken, input, MacOSComputer.listRequest({ sessionID: input.sessionID, callID: input.callID }))
          : Effect.fail(new NativeError({ code: "unsupported_platform", message: `Native computer use has no provider for ${platform}`, outcome: "not_started" })),
      ),
      launch: Effect.fn("Computer.launch")((input) =>
        platform === "darwin"
          ? runUnclaimed(locationToken, input, MacOSComputer.launchRequest({ sessionID: input.sessionID, callID: input.callID }, input.bundleID, input.remoteDebugging)).pipe(
              Effect.ensuring(Effect.sync(() => {
                if (input.remoteDebugging) for (const key of claims.keys())
                  if (key.startsWith(`macos\0desktop\0${input.bundleID}\0`)) claims.delete(key)
              })),
            )
          : Effect.fail(new NativeError({ code: "unsupported_platform", message: `Native computer use has no provider for ${platform}`, outcome: "not_started" })),
      ),
      quit: Effect.fn("Computer.quit")((input) =>
        platform === "darwin"
          ? runUnclaimed(locationToken, input, MacOSComputer.quitRequest({ sessionID: input.sessionID, callID: input.callID }, input.bundleID, input.pid)).pipe(
              Effect.ensuring(Effect.sync(() => {
                for (const key of claims.keys()) if (key.startsWith(`macos\0desktop\0${input.bundleID}\0${input.pid}\0`)) claims.delete(key)
              })),
            )
          : Effect.fail(new NativeError({ code: "unsupported_platform", message: `Native computer use has no provider for ${platform}`, outcome: "not_started" })),
      ),
      browserTabs: Effect.fn("Computer.browserTabs")((input) =>
        platform !== "darwin"
          ? Effect.fail(new NativeError({ code: "unsupported_platform", message: `Native computer use has no provider for ${platform}`, outcome: "not_started" }))
          : runUnclaimed(locationToken, input, MacOSComputer.browserTabsRequest({ sessionID: input.sessionID, callID: input.callID }, input.bundleID)).pipe(
              Effect.flatMap((result) => Effect.gen(function* () {
                const windows = result.browserWindows ?? []
                const targets = windows.map((window) => ({ platform: "macos" as const, application: "webbrowser" as const, bundleID: input.bundleID, windowID: window.window_id, tabIndex: 1 }))
                for (const target of targets) {
                  const claim = claims.get(MacOSComputer.targetKey(target))
                  if (claim && (claim.sessionID !== input.sessionID || claim.locationToken !== locationToken))
                    return yield* new OwnershipError({ message: "Browser window is owned by another Session or Location" })
                }
                for (const [key, claim] of claims) {
                  if (claim.sessionID === input.sessionID && key.startsWith(`macos\0webbrowser\0${input.bundleID}\0`)) claims.delete(key)
                }
                for (const [index, target] of targets.entries()) claims.set(MacOSComputer.targetKey(target), { locationToken, sessionID: input.sessionID, revision: windows[index].revision })
                return result
              })),
            ),
      ),
      browserAct: Effect.fn("Computer.browserAct")((input) => {
        if (platform !== "darwin") return Effect.fail(new NativeError({ code: "unsupported_platform", message: `Native computer use has no provider for ${platform}`, outcome: "not_started" }))
        const request = MacOSComputer.browserActionRequest({ sessionID: input.sessionID, callID: input.callID }, input.target, input.expectedRevision, input.action)
        return run(locationToken, input, request, input.expectedRevision)
      }),
      stage: Effect.fn("Computer.stage")((input) => {
        if (platform !== "darwin")
          return Effect.fail(new NativeError({ code: "unsupported_platform", message: `Native computer use has no provider for ${platform}`, outcome: "not_started" }))
        const key = MacOSComputer.targetKey(input.target)
        const existing = stagedWindows.get(locationToken)?.get(key)
        if (existing && existing.sessionID !== input.sessionID)
          return Effect.fail(new OwnershipError({ message: "Window is staged by another Session" }))
        if (existing) return Effect.gen(function* () {
          const active = yield* begin(locationToken, input.sessionID, input.callID, input.target, input.expectedRevision)
          const revision = claims.get(key)?.revision ?? input.expectedRevision
          return yield* Effect.succeed({ status: "ok" as const, action: "desktop.stage" as const, revision, originalFrame: existing.originalFrame })
            .pipe(Effect.ensuring(finish(active)))
        })
        return run(
          locationToken,
          input,
          (signal) => Effect.gen(function* () {
            const owner = displayOwners.get(locationToken) ?? (yield* startDisplayOwner(locationToken, input, signal))
            if (signal.aborted) return yield* new OwnershipError({ message: "Computer call was cancelled; inspect the target again" })
            return MacOSComputer.stageRequest({ sessionID: input.sessionID, callID: input.callID }, input.target, input.expectedRevision, {
              x: owner.display.x,
              y: owner.display.y,
              width: owner.display.width,
              height: owner.display.height,
            })
          }),
          input.expectedRevision,
          (result) => {
            const originalFrame = result.originalFrame
            if (!originalFrame)
              return Effect.fail(new NativeError({ code: "invalid_response", message: "The native stage response omitted the original window frame", outcome: "unknown" }))
            return Effect.sync(() => {
              const windows = stagedWindows.get(locationToken) ?? new Map<string, StagedWindow>()
              windows.set(key, { sessionID: input.sessionID, target: input.target, originalFrame })
              stagedWindows.set(locationToken, windows)
            })
          },
          () => stopDisplayOwnerWhenEmpty(locationToken),
        )
      }),
      unstage: Effect.fn("Computer.unstage")((input) => {
        if (platform !== "darwin")
          return Effect.fail(new NativeError({ code: "unsupported_platform", message: `Native computer use has no provider for ${platform}`, outcome: "not_started" }))
        const window = stagedWindows.get(locationToken)?.get(MacOSComputer.targetKey(input.target))
        if (!window) return Effect.fail(new NativeError({ code: "target_not_found", message: "Window is not staged in this Location", outcome: "not_started" }))
        if (window.sessionID !== input.sessionID) return Effect.fail(new OwnershipError({ message: "Window is staged by another Session" }))
        return unstageWindow(locationToken, window, input.callID)
      }),
      inspect: Effect.fn("Computer.inspect")((input) => {
        if (input.target.application === "webbrowser")
          return Effect.fail(new NativeError({ code: "invalid_request", message: "Use browserTabs to inspect browser windows and tabs", outcome: "not_started" }))
        if (platform !== "darwin")
          return Effect.fail(
            new NativeError({
              code: "unsupported_platform",
              message: `Native computer use has no provider for ${platform}`,
              outcome: "not_started",
            }),
          )
        return run(
          locationToken,
          input,
          MacOSComputer.inspectRequest({ sessionID: input.sessionID, callID: input.callID }, input.target),
        )
      }),
      act: Effect.fn("Computer.act")((input) => {
        if (platform !== "darwin")
          return Effect.fail(
            new NativeError({
              code: "unsupported_platform",
              message: `Native computer use has no provider for ${platform}`,
              outcome: "not_started",
            }),
          )
        const request = MacOSComputer.matches(input.target, input.action)
          ? MacOSComputer.actionRequest(
              { sessionID: input.sessionID, callID: input.callID },
              input.target,
              input.expectedRevision,
              input.action,
            )
          : undefined
        if (!request)
          return Effect.fail(
            new NativeError({
              code: "invalid_request",
              message: "The macOS action does not match the target application",
              outcome: "not_started",
            }),
          )
        return run(locationToken, input, request, input.expectedRevision)
      }),
      capture: Effect.fn("Computer.capture")((input) => {
        if (platform !== "darwin")
          return Effect.fail(
            new NativeError({
              code: "unsupported_platform",
              message: `Native computer use has no provider for ${platform}`,
              outcome: "not_started",
            }),
          )
        return run(
          locationToken,
          input,
          MacOSComputer.captureRequest({ sessionID: input.sessionID, callID: input.callID }, input.target),
        )
      }),
      cancel: Effect.fn("Computer.cancel")((input) =>
        Effect.sync(() => {
          const active = activeCalls.get(callKey(input.sessionID, input.callID))
          if (!active || active.locationToken !== locationToken) return false
          active.controller.abort(new Error("Computer call cancelled"))
          claims.delete(active.targetKey)
          return true
        }),
      ),
      releaseSession,
    })

  return {
    service,
    releaseSession,
    releaseLocation,
  }
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/Computer") {}

class CoordinatorService extends Context.Service<CoordinatorService, Coordinator>()(
  "@ycoding/v2/ComputerCoordinator",
) {}

const coordinatorLayer = Layer.effect(
  CoordinatorService,
  Effect.gen(function* () {
    const processes = yield* AppProcess.Service
    const events = yield* EventV2.Service
    const coordinator = makeCoordinator(MacOSComputer.invokeWithBridge(processes), process.platform)
    yield* events.subscribe([SessionEvent.Moved, SessionEvent.Deleted, SessionEvent.Archived]).pipe(
      Stream.runForEach((event) => coordinator.releaseSession(event.data.sessionID)),
      Effect.forkScoped({ startImmediately: true }),
    )
    return coordinator
  }),
)

const coordinatorNode = makeGlobalNode({
  service: CoordinatorService,
  layer: coordinatorLayer,
  deps: [AppProcess.node, EventV2.node],
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const coordinator = yield* CoordinatorService
    const locationToken = {}
    yield* Effect.addFinalizer(() => coordinator.releaseLocation(locationToken))
    return coordinator.service(locationToken)
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [coordinatorNode] })
