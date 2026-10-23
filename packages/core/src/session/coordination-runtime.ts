export * as CoordinationRuntime from "./coordination-runtime"

import { Coordination } from "@ycoding-ai/schema/coordination"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { CoordinationService } from "../coordination/index"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventRuntime } from "../event"
import { SessionExecution } from "./execution"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionPending } from "./pending"
import { SessionSchema } from "./schema"

export class AdmissionError extends Schema.TaggedErrorClass<AdmissionError>()("Coordination.AdmissionError", { message: Schema.String }) {}

export function make(options: {
  readonly db: Database.Interface["db"]
  readonly events: EventRuntime.Interface
  readonly coordination: Pick<CoordinationService.Interface, "prepareAdmission" | "get" | "dispatches" | "claims" | "settleDispatch">
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}) {
  const staleClaim = Effect.fnUntraced(function* (dispatch: Coordination.DispatchInfo) {
    const group = yield* options.coordination.get(dispatch.groupID)
    if (group.status !== "armed" && group.status !== "waiting") return undefined
    const pending = yield* options.coordination.dispatches({ groupID: dispatch.groupID, status: "pending", limit: 500 })
    if (!pending.some((entry) => entry.id === dispatch.id)) return undefined
    const claim = (yield* options.coordination.claims({ groupID: dispatch.groupID, limit: 500 }))
      .find((entry) => entry.targetSessionID === dispatch.targetSessionID)
    if (
      claim !== undefined &&
      claim.status === "active" &&
      claim.generation === dispatch.generation &&
      claim.holderSessionID === dispatch.coordinatorSessionID
    )
      return undefined
    return `Coordination claim for ${dispatch.targetSessionID} is ${claim?.status ?? "missing"} for generation ${dispatch.generation}; the dispatch was not admitted`
  })

  const prepare = (dispatch: Coordination.DispatchInfo, messageID: SessionMessage.ID) =>
    options.coordination.prepareAdmission({ kind: "system" }, { groupID: dispatch.groupID, dispatchID: dispatch.id, messageID }).pipe(
      Effect.map((prepared) => ({ type: "prepared" as const, prepared })),
      Effect.catchTag("Coordination.InvalidSelectionError", (error) => Effect.succeed({ type: "inadmissible" as const, detail: error.message })),
      Effect.catchTag("Coordination.ConflictError", (error) =>
        staleClaim(dispatch).pipe(
          Effect.flatMap((detail) => (detail === undefined ? Effect.fail(error) : Effect.succeed({ type: "inadmissible" as const, detail }))),
        ),
      ),
    )

  const admit = Effect.fn("CoordinationRuntime.admit")(function* (dispatch: Coordination.DispatchInfo) {
    if (dispatch.status !== "pending") return dispatch
    const messageID = SessionMessage.ID.make(`msg_coord_${dispatch.id}`)
    return yield* SessionPending.withInboxLock(dispatch.targetSessionID)(Effect.gen(function* () {
      const existing = yield* SessionPending.lookup(options.db, dispatch.targetSessionID, messageID)
      if (existing) {
        if (existing.sessionID !== dispatch.targetSessionID || existing.type !== "user" || existing.data.metadata?.inputOrigin !== "coordination")
          return yield* new AdmissionError({ message: "Coordination input identity conflicts with an existing admission" })
        return { ...dispatch, status: "admitted" as const, messageID }
      }
      const admission = yield* prepare(dispatch, messageID)
      if (admission.type === "inadmissible")
        return yield* options.coordination.settleDispatch({ kind: "system" }, {
          groupID: dispatch.groupID, dispatchID: dispatch.id, outcome: "failed", detail: admission.detail.slice(0, 500),
        })
      const prepared = admission.prepared
      yield* options.events.publish(SessionEvent.InputAdmitted, {
        sessionID: prepared.snapshot.targetSessionID,
        inputID: messageID,
        input: {
          type: "user", delivery: "steer", data: {
            text: dispatch.text,
            metadata: { inputOrigin: "coordination", coordination: { groupID: dispatch.groupID, dispatchID: dispatch.id,
              coordinatorSessionID: dispatch.coordinatorSessionID, generation: prepared.snapshot.generation } },
          },
        },
      }, { commit: prepared.commit })
      const group = yield* options.coordination.get(dispatch.groupID)
      yield* options.events.publish(Coordination.Event.Updated, { groupID: group.id, revision: group.revision })
      yield* options.wake(prepared.snapshot.targetSessionID)
      return { ...dispatch, status: "admitted" as const, messageID }
    }))
  })
  return { admit }
}

export interface Interface {
  readonly admit: ReturnType<typeof make>["admit"]
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/CoordinationRuntime") {}

const layer = Layer.effect(Service, Effect.gen(function* () {
  const coordination = yield* CoordinationService.Service
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  const execution = yield* SessionExecution.Service
  const runtime = make({ db: database.db, events, coordination, wake: execution.wake })
  const locks = KeyedMutex.makeUnsafe<string>()
  const flush = Effect.fn("CoordinationRuntime.flush")(function* (groupID: Coordination.GroupID) {
    const group = yield* coordination.get(groupID)
    if (group.status !== "armed" && group.status !== "waiting") return
    yield* coordination.advance({ kind: "system" }, { groupID })
    const pending = yield* coordination.dispatches({ groupID, status: "pending", limit: 100 })
    for (const dispatch of pending) yield* runtime.admit(dispatch)
  })
  yield* events.subscribe().pipe(Stream.runForEach((event) => Effect.gen(function* () {
    if (event.type.startsWith("coordination.")) {
      const groupID = event.durable?.aggregateID
      if (groupID && Schema.is(Coordination.GroupID)(groupID)) yield* locks.withLock(groupID)(flush(groupID))
      return
    }
    if (event.type === SessionEvent.Work.Completed.type) {
      const data = Schema.decodeUnknownSync(SessionEvent.Work.Completed.data)(event.data)
      const dispatch = yield* coordination.dispatchForInput({ messageID: data.inputID })
      if (dispatch) yield* coordination.settleDispatch({ kind: "system" }, { groupID: dispatch.groupID, dispatchID: dispatch.id, outcome: "completed" })
      return
    }
    if (event.type !== SessionEvent.Execution.Failed.type && event.type !== SessionEvent.Execution.Interrupted.type) return
    const data = Schema.decodeUnknownOption(Schema.Struct({ sessionID: SessionSchema.ID }))(event.data)
    if (Option.isNone(data)) return
    const admitted = yield* coordination.admittedFor({ targetSessionID: data.value.sessionID })
    for (const dispatch of admitted) {
      if (dispatch.messageID && (yield* SessionPending.find(database.db, dispatch.messageID)) === undefined)
        yield* coordination.settleDispatch({ kind: "system" }, { groupID: dispatch.groupID, dispatchID: dispatch.id,
          outcome: event.type === SessionEvent.Execution.Failed.type ? "failed" : "cancelled" })
    }
  }).pipe(Effect.catch((error) => Effect.logWarning("Coordination event reconciliation did not settle", { reason: error._tag })))), Effect.forkScoped)
  return Service.of(runtime)
}))

export const node = makeGlobalNode({ service: Service, layer, deps: [CoordinationService.node, Database.node, EventRuntime.node, SessionExecution.node] })
