export * as Coordination from "./coordination.js"

import { Schema } from "effect"
import { Agent } from "./agent.js"
import { ascending } from "./identifier.js"
import { Model } from "./model.js"
import { durable, ephemeral, inventory, ID } from "./event.js"
import { Location } from "./location.js"
import { Money } from "./money.js"
import { NonNegativeInt, PositiveInt, optional, statics } from "./schema.js"
import { SessionID } from "./session-id.js"
import { SessionMessage } from "./session-message.js"

const boundedId = (prefix: string, identifier: string) =>
  Schema.String.check(Schema.isStartsWith(prefix), Schema.isMinLength(prefix.length + 1), Schema.isMaxLength(96)).pipe(
    Schema.brand(identifier),
    Schema.annotate({ identifier }),
    statics((schema) => ({ create: () => schema.make(prefix + ascending()) })),
  )

export const GroupID = boundedId("cgrp_", "Coordination.GroupID")
export type GroupID = typeof GroupID.Type

export const DispatchID = boundedId("cdsp_", "Coordination.DispatchID")
export type DispatchID = typeof DispatchID.Type

export const WaitID = boundedId("cwait_", "Coordination.WaitID")
export type WaitID = typeof WaitID.Type

export const ReceiptID = boundedId("crcpt_", "Coordination.ReceiptID")
export type ReceiptID = typeof ReceiptID.Type

export const Revision = NonNegativeInt.pipe(
  Schema.brand("Coordination.Revision"),
  Schema.annotate({ identifier: "Coordination.Revision" }),
)
export type Revision = typeof Revision.Type

export const Role = Schema.Literals(["coordinator", "worker", "observer"]).annotate({ identifier: "Coordination.Role" })
export type Role = typeof Role.Type

export const GroupStatus = Schema.Literals(["disarmed", "armed", "waiting", "stopped", "completed", "needs-rearm"]).annotate({
  identifier: "Coordination.GroupStatus",
})
export type GroupStatus = typeof GroupStatus.Type

export const DispatchStatus = Schema.Literals(["queued", "pending", "admitted", "failed", "cancelled", "completed"]).annotate({
  identifier: "Coordination.DispatchStatus",
})
export type DispatchStatus = typeof DispatchStatus.Type

export const WaitStatus = Schema.Literals(["active", "cancelled", "expired"]).annotate({ identifier: "Coordination.WaitStatus" })
export type WaitStatus = typeof WaitStatus.Type

export const ClaimStatus = Schema.Literals(["active", "released", "revoked", "expired"]).annotate({
  identifier: "Coordination.ClaimStatus",
})
export type ClaimStatus = typeof ClaimStatus.Type

export const QueueReason = Schema.Literals(["capacity", "hard-limit", "dependency", "budget"]).annotate({
  identifier: "Coordination.QueueReason",
})
export type QueueReason = typeof QueueReason.Type

const ToolName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
const ScopeText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
export const maxAllowedTools = 64
export const maxResourceScopes = 32
export const maxMembers = 64
export const maxQueueCapacity = 1000
export const maxDispatchTextLength = 32000
export const maxDependencies = 32
export const maxWaitTargets = 64
export const maxWaitBatch = 200
export const maxWaitTimeoutMs = 300000

const AllowedTools = Schema.Array(ToolName).check(Schema.isMaxLength(maxAllowedTools))
const ResourceScopes = Schema.Array(ScopeText).check(Schema.isMaxLength(maxResourceScopes))

export interface DelegatedDecisions extends Schema.Schema.Type<typeof DelegatedDecisions> {}
export const DelegatedDecisions = Schema.Struct({
  categories: Schema.Array(Schema.Literals(["question", "permission", "review"])).check(Schema.isMaxLength(3)),
  actions: Schema.Array(ScopeText).check(Schema.isMaxLength(32)).pipe(optional),
  resources: Schema.Array(ScopeText).check(Schema.isMaxLength(32)).pipe(optional),
  expiresAt: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "Coordination.DelegatedDecisions" })

export interface Settings extends Schema.Schema.Type<typeof Settings> {}
export const Settings = Schema.Struct({
  enabled: Schema.Boolean,
  categories: Schema.Array(Schema.Literals(["question", "permission", "review"])).check(Schema.isMaxLength(3)),
  actions: Schema.Array(ScopeText).check(Schema.isMaxLength(32)).pipe(optional),
  resources: Schema.Array(ScopeText).check(Schema.isMaxLength(32)).pipe(optional),
  expiresAt: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "Coordination.Settings" })

export interface Policy extends Schema.Schema.Type<typeof Policy> {}
export const Policy = Schema.Struct({
  concurrency: Schema.NullOr(PositiveInt),
  queueCapacity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(maxQueueCapacity)),
  budget: Money.USD.check(Schema.isGreaterThan(0)).pipe(optional),
  delegatedDecisions: DelegatedDecisions.pipe(optional),
}).annotate({ identifier: "Coordination.Policy" })

export interface MemberInput extends Schema.Schema.Type<typeof MemberInput> {}
export const MemberInput = Schema.Struct({
  sessionID: SessionID,
  role: Role,
  allowedTools: AllowedTools.pipe(optional),
  resourceScopes: ResourceScopes.pipe(optional),
}).annotate({ identifier: "Coordination.MemberInput" })

export interface Member extends Schema.Schema.Type<typeof Member> {}
export const Member = Schema.Struct({
  sessionID: SessionID,
  role: Role,
  allowedTools: AllowedTools.pipe(optional),
  resourceScopes: ResourceScopes.pipe(optional),
  location: Location.Ref,
}).annotate({ identifier: "Coordination.Member" })

export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}
export const CreateInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  policy: Policy,
  members: Schema.Array(MemberInput).check(Schema.isMinLength(1), Schema.isMaxLength(maxMembers)),
}).annotate({ identifier: "Coordination.CreateInput" })

const Time = Schema.Struct({ created: NonNegativeInt, updated: NonNegativeInt })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: GroupID,
  name: Schema.String,
  status: GroupStatus,
  revision: Revision,
  policy: Policy,
  fencingGeneration: NonNegativeInt,
  members: Schema.Array(Member),
  time: Time,
}).annotate({ identifier: "Coordination.Info" })

export interface GroupSummary extends Schema.Schema.Type<typeof GroupSummary> {}
export const GroupSummary = Schema.Struct({
  id: GroupID,
  name: Schema.String,
  status: GroupStatus,
  revision: Revision,
  policy: Policy,
  fencingGeneration: NonNegativeInt,
  memberCount: NonNegativeInt,
  time: Time,
}).annotate({ identifier: "Coordination.GroupSummary" })

export interface ClaimInfo extends Schema.Schema.Type<typeof ClaimInfo> {}
export const ClaimInfo = Schema.Struct({
  groupID: GroupID,
  targetSessionID: SessionID,
  holderSessionID: SessionID,
  generation: PositiveInt,
  status: ClaimStatus,
  leaseExpiresAt: NonNegativeInt,
}).annotate({ identifier: "Coordination.ClaimInfo" })

export interface DispatchSelection extends Schema.Schema.Type<typeof DispatchSelection> {}
export const DispatchSelection = Schema.Struct({
  agent: Agent.ID,
  model: Model.Ref,
  reason: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(500),
    Schema.isPattern(/^(?=.*\S)[^\r\n\u2028\u2029]+$/),
  ),
}).annotate({ identifier: "Coordination.DispatchSelection" })

export interface DispatchInput extends Schema.Schema.Type<typeof DispatchInput> {}
export const DispatchInput = Schema.Struct({
  dispatchID: DispatchID.pipe(optional),
  targetSessionID: SessionID,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maxDispatchTextLength)),
  selection: DispatchSelection,
  dependsOn: Schema.Array(DispatchID).check(Schema.isMaxLength(maxDependencies)).pipe(optional),
  resourceScope: ScopeText.pipe(optional),
  allowedTools: AllowedTools.pipe(optional),
}).annotate({ identifier: "Coordination.DispatchInput" })

export interface DispatchInfo extends Schema.Schema.Type<typeof DispatchInfo> {}
export const DispatchInfo = Schema.Struct({
  id: DispatchID,
  groupID: GroupID,
  targetSessionID: SessionID,
  coordinatorSessionID: SessionID,
  generation: PositiveInt,
  status: DispatchStatus,
  reason: QueueReason.pipe(optional),
  text: Schema.String,
  selection: DispatchSelection,
  dependsOn: Schema.Array(DispatchID).pipe(optional),
  resourceScope: ScopeText.pipe(optional),
  allowedTools: AllowedTools.pipe(optional),
  messageID: SessionMessage.ID.pipe(optional),
  time: Time,
}).annotate({ identifier: "Coordination.DispatchInfo" })

export interface WaitInput extends Schema.Schema.Type<typeof WaitInput> {}
export const WaitInput = Schema.Struct({
  waitID: WaitID.pipe(optional),
  targets: Schema.Array(SessionID).check(Schema.isMaxLength(maxWaitTargets)).pipe(optional),
  timeoutMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(maxWaitTimeoutMs)).pipe(optional),
  batch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(maxWaitBatch)).pipe(optional),
}).annotate({ identifier: "Coordination.WaitInput" })

export interface Observation extends Schema.Schema.Type<typeof Observation> {}
export const Observation = Schema.Struct({
  sessionID: SessionID,
  eventID: ID.pipe(optional),
  seq: NonNegativeInt,
  type: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  time: NonNegativeInt,
  gap: Schema.Literal(true).pipe(optional),
}).annotate({ identifier: "Coordination.Observation" })

export interface WaitResult extends Schema.Schema.Type<typeof WaitResult> {}
export const WaitResult = Schema.Struct({
  waitID: WaitID,
  groupID: GroupID,
  status: WaitStatus,
  observations: Schema.Array(Observation),
  cursors: Schema.Record(Schema.String, NonNegativeInt),
}).annotate({ identifier: "Coordination.WaitResult" })

export interface Capacity extends Schema.Schema.Type<typeof Capacity> {}
export const Capacity = Schema.Struct({
  groupID: GroupID,
  concurrency: Schema.NullOr(PositiveInt),
  hardLimit: Schema.NullOr(PositiveInt),
  effectiveLimit: Schema.NullOr(PositiveInt),
  active: NonNegativeInt,
  waiting: NonNegativeInt,
  queued: NonNegativeInt,
  queueCapacity: NonNegativeInt,
  available: Schema.NullOr(NonNegativeInt),
  runtimeUsed: NonNegativeInt.pipe(optional),
  budget: Money.USD.pipe(optional),
  spent: Money.USD,
  budgetRemaining: Money.USD.pipe(optional),
}).annotate({ identifier: "Coordination.Capacity" })

export interface Receipt extends Schema.Schema.Type<typeof Receipt> {}
export const Receipt = Schema.Struct({
  id: ReceiptID,
  groupID: GroupID,
  dispatchID: DispatchID.pipe(optional),
  kind: Schema.Literals(["dispatched", "admitted", "failed", "cancelled", "completed"]),
  sessionID: SessionID,
  messageID: SessionMessage.ID.pipe(optional),
  generation: PositiveInt.pipe(optional),
  selection: DispatchSelection,
  time: NonNegativeInt,
  detail: Schema.String.check(Schema.isMaxLength(500)).pipe(optional),
}).annotate({ identifier: "Coordination.Receipt" })

export interface RoleAccess extends Schema.Schema.Type<typeof RoleAccess> {}
export const RoleAccess = Schema.Struct({
  groupID: GroupID,
  revision: Revision,
  status: GroupStatus,
  role: Role,
  allowedTools: AllowedTools.pipe(optional),
  resourceScopes: ResourceScopes.pipe(optional),
  fencingGeneration: NonNegativeInt,
  delegatedDecisions: DelegatedDecisions.pipe(optional),
}).annotate({ identifier: "Coordination.RoleAccess" })

export interface AssignmentAccess extends Schema.Schema.Type<typeof AssignmentAccess> {}
export const AssignmentAccess = Schema.Struct({
  groupID: GroupID,
  revision: Revision,
  status: GroupStatus,
  role: Schema.Literal("worker"),
  dispatchID: DispatchID,
  coordinatorSessionID: SessionID,
  generation: PositiveInt,
  selection: DispatchSelection,
  allowedTools: AllowedTools.pipe(optional),
  resourceScopes: ResourceScopes.pipe(optional),
  assignmentResourceScope: ScopeText.pipe(optional),
}).annotate({ identifier: "Coordination.AssignmentAccess" })

const groupEvent = { durable: { aggregate: "groupID", version: 1 } } as const
const Base = { groupID: GroupID, revision: Revision }

export namespace Event {
  export const Updated = ephemeral({
    type: "coordination.updated",
    identifier: "Coordination.Event.Updated",
    schema: { groupID: GroupID, revision: Revision },
  })
  export type Updated = typeof Updated.Type

  export const Created = durable({
    type: "coordination.group.created",
    identifier: "Coordination.Event.Created",
    ...groupEvent,
    schema: {
      ...Base,
      name: Schema.String,
      policy: Policy,
      members: Schema.Array(MemberInput),
    },
  })
  export type Created = typeof Created.Type

  export const RosterUpdated = durable({
    type: "coordination.group.roster-updated",
    identifier: "Coordination.Event.RosterUpdated",
    ...groupEvent,
    schema: {
      ...Base,
      policy: Policy,
      members: Schema.Array(MemberInput),
      name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)).pipe(optional),
    },
  })
  export type RosterUpdated = typeof RosterUpdated.Type

  export const Armed = durable({
    type: "coordination.group.armed",
    identifier: "Coordination.Event.Armed",
    ...groupEvent,
    schema: { ...Base },
  })
  export type Armed = typeof Armed.Type

  export const Stopped = durable({
    type: "coordination.group.stopped",
    identifier: "Coordination.Event.Stopped",
    ...groupEvent,
    schema: { ...Base },
  })
  export type Stopped = typeof Stopped.Type

  export const Completed = durable({
    type: "coordination.group.completed",
    identifier: "Coordination.Event.Completed",
    ...groupEvent,
    schema: { ...Base },
  })
  export type Completed = typeof Completed.Type

  export const NeedsRearm = durable({
    type: "coordination.group.needs-rearm",
    identifier: "Coordination.Event.NeedsRearm",
    ...groupEvent,
    schema: { ...Base },
  })
  export type NeedsRearm = typeof NeedsRearm.Type

  export const ClaimAcquired = durable({
    type: "coordination.claim.acquired",
    identifier: "Coordination.Event.ClaimAcquired",
    ...groupEvent,
    schema: {
      ...Base,
      targetSessionID: SessionID,
      holderSessionID: SessionID,
      generation: PositiveInt,
      leaseExpiresAt: NonNegativeInt,
    },
  })
  export type ClaimAcquired = typeof ClaimAcquired.Type

  export const ClaimReleased = durable({
    type: "coordination.claim.released",
    identifier: "Coordination.Event.ClaimReleased",
    ...groupEvent,
    schema: { ...Base, targetSessionID: SessionID, generation: PositiveInt },
  })
  export type ClaimReleased = typeof ClaimReleased.Type

  export const ClaimRevoked = durable({
    type: "coordination.claim.revoked",
    identifier: "Coordination.Event.ClaimRevoked",
    ...groupEvent,
    schema: { ...Base, targetSessionID: SessionID, generation: PositiveInt },
  })
  export type ClaimRevoked = typeof ClaimRevoked.Type

  export const DispatchRecorded = durable({
    type: "coordination.dispatch.recorded",
    identifier: "Coordination.Event.DispatchRecorded",
    ...groupEvent,
    schema: {
      ...Base,
      dispatchID: DispatchID,
      targetSessionID: SessionID,
      coordinatorSessionID: SessionID,
      generation: PositiveInt,
      status: Schema.Literals(["queued", "pending"]),
      reason: QueueReason.pipe(optional),
      text: Schema.String,
      selection: DispatchSelection,
      dependsOn: Schema.Array(DispatchID).pipe(optional),
      resourceScope: ScopeText.pipe(optional),
      allowedTools: AllowedTools.pipe(optional),
    },
  })
  export type DispatchRecorded = typeof DispatchRecorded.Type

  export const DispatchAdvanced = durable({
    type: "coordination.dispatch.advanced",
    identifier: "Coordination.Event.DispatchAdvanced",
    ...groupEvent,
    schema: { ...Base, dispatchID: DispatchID },
  })
  export type DispatchAdvanced = typeof DispatchAdvanced.Type

  export const DispatchSettled = durable({
    type: "coordination.dispatch.settled",
    identifier: "Coordination.Event.DispatchSettled",
    ...groupEvent,
    schema: {
      ...Base,
      dispatchID: DispatchID,
      outcome: Schema.Literals(["completed", "failed", "cancelled"]),
      detail: Schema.String.check(Schema.isMaxLength(500)).pipe(optional),
    },
  })
  export type DispatchSettled = typeof DispatchSettled.Type

  export const WaitStarted = durable({
    type: "coordination.wait.started",
    identifier: "Coordination.Event.WaitStarted",
    ...groupEvent,
    schema: {
      ...Base,
      waitID: WaitID,
      coordinatorSessionID: SessionID,
      targets: Schema.Array(SessionID),
      expiresAt: NonNegativeInt,
    },
  })
  export type WaitStarted = typeof WaitStarted.Type

  export const WaitCancelled = durable({
    type: "coordination.wait.cancelled",
    identifier: "Coordination.Event.WaitCancelled",
    ...groupEvent,
    schema: { ...Base, waitID: WaitID },
  })
  export type WaitCancelled = typeof WaitCancelled.Type

  export const WaitExpired = durable({
    type: "coordination.wait.expired",
    identifier: "Coordination.Event.WaitExpired",
    ...groupEvent,
    schema: { ...Base, waitID: WaitID },
  })
  export type WaitExpired = typeof WaitExpired.Type
}

export const DurableDefinitions = inventory(
  Event.Created,
  Event.RosterUpdated,
  Event.Armed,
  Event.Stopped,
  Event.Completed,
  Event.NeedsRearm,
  Event.ClaimAcquired,
  Event.ClaimReleased,
  Event.ClaimRevoked,
  Event.DispatchRecorded,
  Event.DispatchAdvanced,
  Event.DispatchSettled,
  Event.WaitStarted,
  Event.WaitCancelled,
  Event.WaitExpired,
)
