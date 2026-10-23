import { Coordination } from "@ycoding-ai/schema/coordination"
import { Session } from "@ycoding-ai/schema/session"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export class CoordinationError extends Schema.TaggedErrorClass<CoordinationError>()("CoordinationError", {
  reason: Schema.String,
  message: Schema.String,
}) {}

export const RevisionInput = Schema.Struct({ revision: Coordination.Revision })
export const Detail = Schema.Struct({ ...Coordination.Info.fields, claims: Schema.Array(Coordination.ClaimInfo), dispatches: Schema.Array(Coordination.DispatchInfo) })
export const MembersInput = Schema.Struct({ revision: Coordination.Revision, name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)).pipe(Schema.optional), members: Schema.Array(Coordination.MemberInput).check(Schema.isMinLength(1), Schema.isMaxLength(64)), policy: Coordination.Policy.pipe(Schema.optional) })
export const ClaimInput = Schema.Struct({
  revision: Coordination.Revision,
  targetSessionID: Session.ID,
  holderSessionID: Session.ID,
  leaseMs: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 300000 })),
})
export const ReleaseInput = Schema.Struct({ revision: Coordination.Revision, targetSessionID: Session.ID, holderSessionID: Session.ID, generation: Coordination.Revision })
export const DispatchInput = Schema.Struct({ ...Coordination.DispatchInput.fields, revision: Coordination.Revision, holderSessionID: Session.ID, generation: Coordination.Revision })
export const WaitInput = Schema.Struct({ ...Coordination.WaitInput.fields, revision: Coordination.Revision, holderSessionID: Session.ID })
export const CancelWaitInput = Schema.Struct({ revision: Coordination.Revision, waitID: Coordination.WaitID, holderSessionID: Session.ID })

const root = "/api/coordination"
const params = { groupID: Coordination.GroupID }
const failure = CoordinationError.annotate({ httpApiStatus: 409 })

export const CoordinationGroup = HttpApiGroup.make("server.coordination")
  .add(HttpApiEndpoint.get("coordination.settings", `${root}/settings`, { success: Schema.Struct({ data: Coordination.Settings }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.settings" })))
  .add(HttpApiEndpoint.get("coordination.list", root, { success: Schema.Struct({ data: Schema.Array(Coordination.GroupSummary) }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.list" })))
  .add(HttpApiEndpoint.post("coordination.create", root, { payload: Coordination.CreateInput, success: Schema.Struct({ data: Coordination.Info }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.create" })))
  .add(HttpApiEndpoint.get("coordination.get", `${root}/:groupID`, { params, success: Schema.Struct({ data: Detail }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.get" })))
  .add(HttpApiEndpoint.put("coordination.members", `${root}/:groupID/members`, { params, payload: MembersInput, success: Schema.Struct({ data: Coordination.Info }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.members" })))
  .add(HttpApiEndpoint.post("coordination.arm", `${root}/:groupID/arm`, { params, payload: RevisionInput, success: Schema.Struct({ data: Coordination.Info }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.arm" })))
  .add(HttpApiEndpoint.post("coordination.stop", `${root}/:groupID/stop`, { params, payload: RevisionInput, success: Schema.Struct({ data: Coordination.Info }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.stop" })))
  .add(HttpApiEndpoint.post("coordination.complete", `${root}/:groupID/complete`, { params, payload: RevisionInput, success: Schema.Struct({ data: Coordination.Info }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.complete" })))
  .add(HttpApiEndpoint.post("coordination.claim", `${root}/:groupID/claim`, { params, payload: ClaimInput, success: Schema.Struct({ data: Coordination.ClaimInfo }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.claim" })))
  .add(HttpApiEndpoint.post("coordination.release", `${root}/:groupID/release`, { params, payload: ReleaseInput, success: Schema.Struct({ data: Coordination.ClaimInfo }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.release" })))
  .add(HttpApiEndpoint.post("coordination.dispatch", `${root}/:groupID/dispatch`, { params, payload: DispatchInput, success: Schema.Struct({ data: Coordination.DispatchInfo }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.dispatch" })))
  .add(HttpApiEndpoint.get("coordination.receipts", `${root}/:groupID/receipts`, { params, success: Schema.Struct({ data: Schema.Array(Coordination.Receipt) }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.receipts" })))
  .add(HttpApiEndpoint.post("coordination.wait", `${root}/:groupID/wait`, { params, payload: WaitInput, success: Schema.Struct({ data: Coordination.WaitResult }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.wait" })))
  .add(HttpApiEndpoint.post("coordination.cancelWait", `${root}/:groupID/wait/cancel`, { params, payload: CancelWaitInput, success: Schema.Struct({ data: Coordination.WaitResult }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.cancelWait" })))
  .add(HttpApiEndpoint.get("coordination.capacity", `${root}/:groupID/capacity`, { params, success: Schema.Struct({ data: Coordination.Capacity }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.capacity" })))
  .annotateMerge(OpenApi.annotations({ title: "coordination", description: "Owner-authenticated local coordination groups; Session Locations are resolved by the backend." }))
