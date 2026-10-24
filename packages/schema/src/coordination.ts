export * as Coordination from "./coordination.js"

import { Schema } from "effect"
import { ascending } from "./identifier.js"
import { durable, ephemeral, inventory } from "./event.js"
import { Location } from "./location.js"
import { NonNegativeInt, PositiveInt, optional, statics } from "./schema.js"
import { SessionID } from "./session-id.js"

const boundedId = (prefix: string, identifier: string) =>
  Schema.String.check(Schema.isStartsWith(prefix), Schema.isMinLength(prefix.length + 1), Schema.isMaxLength(96)).pipe(
    Schema.brand(identifier),
    Schema.annotate({ identifier }),
    statics((schema) => ({ create: () => schema.make(prefix + ascending()) })),
  )

export const GroupID = boundedId("cgrp_", "Coordination.GroupID")
export type GroupID = typeof GroupID.Type

export const Revision = NonNegativeInt.pipe(
  Schema.brand("Coordination.Revision"),
  Schema.annotate({ identifier: "Coordination.Revision" }),
)
export type Revision = typeof Revision.Type

const ScopeText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
export const maxMembers = 64
export const maxPending = 50

export const RequestKind = Schema.Literals(["question", "permission", "review"]).annotate({
  identifier: "Coordination.RequestKind",
})
export type RequestKind = typeof RequestKind.Type

export const maxEscalationReasons = 4

export interface EscalationReason extends Schema.Schema.Type<typeof EscalationReason> {}
export const EscalationReason = Schema.Struct({
  sessionID: SessionID,
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isPattern(/\S/)),
}).annotate({ identifier: "Coordination.EscalationReason" })

export interface Escalation extends Schema.Schema.Type<typeof Escalation> {}
export const Escalation = Schema.Struct({
  reasons: Schema.Array(EscalationReason).check(Schema.isMinLength(1), Schema.isMaxLength(maxEscalationReasons)),
}).annotate({ identifier: "Coordination.Escalation" })

export const MemberState = Schema.Literals(["idle", "running", "waiting", "failed"]).annotate({
  identifier: "Coordination.MemberState",
})
export type MemberState = typeof MemberState.Type

export const PausedReason = Schema.Literals(["interrupted", "restart"]).annotate({ identifier: "Coordination.PausedReason" })
export type PausedReason = typeof PausedReason.Type

export interface DelegatedDecisions extends Schema.Schema.Type<typeof DelegatedDecisions> {}
export const DelegatedDecisions = Schema.Struct({
  categories: Schema.Array(RequestKind).check(Schema.isMaxLength(3)),
  actions: Schema.Array(ScopeText).check(Schema.isMaxLength(32)).pipe(optional),
  resources: Schema.Array(ScopeText).check(Schema.isMaxLength(32)).pipe(optional),
  expiresAt: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "Coordination.DelegatedDecisions" })

export interface Settings extends Schema.Schema.Type<typeof Settings> {}
export const Settings = Schema.Struct({
  enabled: Schema.Boolean,
  categories: Schema.Array(RequestKind).check(Schema.isMaxLength(3)),
  actions: Schema.Array(ScopeText).check(Schema.isMaxLength(32)).pipe(optional),
  resources: Schema.Array(ScopeText).check(Schema.isMaxLength(32)).pipe(optional),
  expiresAt: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "Coordination.Settings" })

export interface GroupSettings extends Schema.Schema.Type<typeof GroupSettings> {}
export const GroupSettings = Schema.Struct({
  concurrency: Schema.NullOr(PositiveInt),
  delegatedDecisions: DelegatedDecisions.pipe(optional),
}).annotate({ identifier: "Coordination.GroupSettings" })

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))
const MemberSessionIDs = Schema.Array(SessionID).check(Schema.isMaxLength(maxMembers))

export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}
export const CreateInput = Schema.Struct({
  name: Name,
  masterSessionID: SessionID,
  memberSessionIDs: MemberSessionIDs,
}).annotate({ identifier: "Coordination.CreateInput" })

export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}
export const UpdateInput = Schema.Struct({
  revision: Revision,
  name: Name.pipe(optional),
  masterSessionID: SessionID.pipe(optional),
  memberSessionIDs: MemberSessionIDs.pipe(optional),
  settings: GroupSettings.pipe(optional),
}).annotate({ identifier: "Coordination.UpdateInput" })

export interface PendingRequest extends Schema.Schema.Type<typeof PendingRequest> {}
export const PendingRequest = Schema.Struct({
  kind: RequestKind,
  requestID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  fingerprint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  summary: Schema.String.check(Schema.isMaxLength(500)),
}).annotate({ identifier: "Coordination.PendingRequest" })

export interface Participant extends Schema.Schema.Type<typeof Participant> {}
export const Participant = Schema.Struct({
  sessionID: SessionID,
  title: Schema.String,
  location: Location.Ref,
  state: MemberState,
  lastActivity: NonNegativeInt,
  pending: Schema.Array(PendingRequest).check(Schema.isMaxLength(maxPending)),
  drivenBy: Schema.Struct({ sessionID: SessionID, title: Schema.String }).pipe(optional),
}).annotate({ identifier: "Coordination.Participant" })

const Time = Schema.Struct({ created: NonNegativeInt, updated: NonNegativeInt })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: GroupID,
  name: Schema.String,
  revision: Revision,
  active: Schema.Boolean,
  pausedReason: PausedReason.pipe(optional),
  master: Participant,
  members: Schema.Array(Participant),
  settings: GroupSettings,
  time: Time,
}).annotate({ identifier: "Coordination.Info" })

export interface GroupSummary extends Schema.Schema.Type<typeof GroupSummary> {}
export const GroupSummary = Schema.Struct({
  id: GroupID,
  name: Schema.String,
  revision: Revision,
  active: Schema.Boolean,
  pausedReason: PausedReason.pipe(optional),
  masterSessionID: SessionID,
  memberCount: NonNegativeInt,
  settings: GroupSettings,
  time: Time,
}).annotate({ identifier: "Coordination.GroupSummary" })

const groupEvent = { durable: { aggregate: "groupID", version: 1 } } as const
const Base = { groupID: GroupID, revision: Revision }
const Snapshot = {
  ...Base,
  name: Name,
  masterSessionID: SessionID,
  memberSessionIDs: MemberSessionIDs,
  settings: GroupSettings,
}

export namespace Event {
  export const Updated = ephemeral({
    type: "coordination.updated",
    identifier: "Coordination.Event.Updated",
    schema: { groupID: GroupID, revision: Revision },
  })
  export type Updated = typeof Updated.Type

  export const RequestEscalated = ephemeral({
    type: "coordination.request.escalated",
    identifier: "Coordination.Event.RequestEscalated",
    schema: {
      sessionID: SessionID,
      rootSessionID: SessionID.pipe(optional),
      kind: RequestKind,
      requestID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      coordinationEscalation: Escalation,
    },
  })
  export type RequestEscalated = typeof RequestEscalated.Type

  export const Created = durable({
    type: "coordination.group.created",
    identifier: "Coordination.Event.Created",
    durable: { aggregate: "groupID", version: 2 },
    schema: Snapshot,
  })
  export type Created = typeof Created.Type

  export const Changed = durable({
    type: "coordination.group.changed",
    identifier: "Coordination.Event.Changed",
    ...groupEvent,
    schema: Snapshot,
  })
  export type Changed = typeof Changed.Type

  export const Deleted = durable({
    type: "coordination.group.deleted",
    identifier: "Coordination.Event.Deleted",
    ...groupEvent,
    schema: { ...Base },
  })
  export type Deleted = typeof Deleted.Type
}

export const DurableDefinitions = inventory(Event.Created, Event.Changed, Event.Deleted)
