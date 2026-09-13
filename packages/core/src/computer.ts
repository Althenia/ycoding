export * as Computer from "./computer"

import { Context, Effect, Layer, Schema, Stream } from "effect"
import { makeGlobalNode, makeLocationNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { AppProcess } from "./process"
import { SessionEvent } from "./session/event"
import { SessionSchema } from "./session/schema"
import { MacOSComputer } from "./computer/macos"
import { NativeError, type Status } from "./computer/types"

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

const callKey = (sessionID: SessionSchema.ID, callID: string) => `${sessionID}\0${callID}`

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
    if (expectedRevision !== undefined && claim?.revision !== expectedRevision)
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
    request: NativeRequest,
    expectedRevision?: string,
  ) =>
    Effect.gen(function* () {
      const active = yield* begin(locationToken, input.sessionID, input.callID, input.target, expectedRevision)
      const result = yield* invoke(request, active.controller.signal).pipe(
        Effect.tap(() =>
          active.controller.signal.aborted
            ? Effect.fail(new OwnershipError({ message: "Computer call was cancelled; inspect the target again" }))
            : Effect.void,
        ),
        Effect.tap((result) =>
          Effect.sync(() => {
            if (activeCalls.get(callKey(active.sessionID, active.callID))?.token !== active.token) return
            if (request.action === "finder.move") claims.delete(active.targetKey)
            else
              claims.set(active.targetKey, {
                locationToken,
                sessionID: input.sessionID,
                revision: result.revision,
              })
          }),
        ),
        Effect.tapError((error) =>
          error instanceof OwnershipError ||
          error.outcome === "unknown" ||
          error.code === "stale_revision" ||
          error.code === "target_not_found"
            ? Effect.sync(() => claims.delete(active.targetKey))
            : Effect.void,
        ),
        Effect.ensuring(finish(active)),
      )
      return result
    })

  const releaseSession = Effect.fn("Computer.releaseSession")((sessionID: SessionSchema.ID) =>
    Effect.sync(() => {
      for (const [key, claim] of claims) if (claim.sessionID === sessionID) claims.delete(key)
      for (const active of activeCalls.values()) {
        if (active.sessionID !== sessionID) continue
        active.controller.abort(new Error("Computer control was revoked for this Session"))
        claims.delete(active.targetKey)
      }
    }),
  )

  const releaseLocation = Effect.fn("Computer.releaseLocation")((locationToken: object) =>
    Effect.sync(() => {
      for (const [key, claim] of claims) if (claim.locationToken === locationToken) claims.delete(key)
      for (const active of activeCalls.values()) {
        if (active.locationToken !== locationToken) continue
        active.controller.abort(new Error("Computer control was revoked for this Location"))
        claims.delete(active.targetKey)
      }
    }),
  )

  const service = (locationToken: object) =>
    Service.of({
      status: Effect.succeed({
        platform: platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform,
        state: platform === "darwin" ? "supported" : "unsupported",
        capabilities: platform === "darwin" ? MacOSComputer.capabilities : [],
      }),
      inspect: Effect.fn("Computer.inspect")((input) => {
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
    const coordinator = makeCoordinator(MacOSComputer.invokeWith(processes), process.platform)
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
