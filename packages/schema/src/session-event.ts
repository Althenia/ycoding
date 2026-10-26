export * as SessionEvent from "./session-event.js"

import { Schema } from "effect"
import { optional } from "./schema.js"
import { Event } from "./event.js"
import { ToolContent } from "./llm.js"
import { FinishReason } from "./llm.js"
import { Model } from "./model.js"
import { NonNegativeInt, PositiveInt, RelativePath } from "./schema.js"
import { FileAttachment } from "./prompt.js"
import { SessionID } from "./session-id.js"
import { Location } from "./location.js"
import { SessionMessage } from "./session-message.js"
import { Revert } from "./session-revert.js"
import { Shell as ShellSchema } from "./shell.js"
import { SessionError } from "./session-error.js"
import { SessionCacheDiagnostics } from "./session-cache-diagnostics.js"
import { Instruction } from "./instruction.js"
import { Agent } from "./agent.js"
import { Skill as SkillSchema } from "./skill.js"
import { Money } from "./money.js"
import { Snapshot } from "./snapshot.js"
import { TokenUsage } from "./token-usage.js"
import { SessionPending } from "./session-pending.js"
import { Project } from "./project.js"
import { ProviderRequest } from "./provider-request.js"
import { UsageAnchor } from "./usage-anchor.js"
import { SessionOrchestration } from "./session-orchestration.js"
import { Permission } from "./permission.js"
import { SessionCompaction } from "./session-compaction.js"
import { Credential } from "./credential.js"
import { Integration } from "./integration.js"
import { Provider } from "./provider.js"
import { Guardrail } from "./guardrail.js"
import { SessionReview } from "./session-review.js"
import { DecisionFailure } from "./decision-failure.js"
import { Dots } from "./dots.js"
import { Form } from "./form.js"

export { FileAttachment }

export const Source = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
  text: Schema.String,
}).annotate({
  identifier: "Session.Event.Source",
})
export interface Source extends Schema.Schema.Type<typeof Source> {}

const Base = {
  sessionID: SessionID,
}

export const ArtifactProvenance = SessionMessage.ArtifactProvenance.annotate({
  identifier: "Session.Event.ArtifactProvenance",
})
export type ArtifactProvenance = typeof ArtifactProvenance.Type

export const Created = Event.durable({
  type: "session.created",
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
  schema: {
    ...Base,
    projectID: Project.ID,
    location: Location.Ref,
    parentID: SessionID.pipe(optional),
    agent: Agent.ID.pipe(optional),
    model: Model.Ref.pipe(optional),
    permissionCeiling: Permission.Ruleset.pipe(optional),
    title: Schema.String,
    subpath: RelativePath.pipe(optional),
    created: NonNegativeInt,
  },
})
export type Created = typeof Created.Type

const options = {
  durable: {
    aggregate: "sessionID",
    version: 1,
  },
} as const
export const AgentSelected = Event.durable({
  type: "session.agent.selected",
  ...options,
  schema: {
    ...Base,
    agent: Agent.ID,
    artifact: ArtifactProvenance.pipe(optional),
  },
})
export type AgentSelected = typeof AgentSelected.Type

export const ModelSelected = Event.durable({
  type: "session.model.selected",
  ...options,
  schema: {
    ...Base,
    model: Model.Ref,
  },
})
export type ModelSelected = typeof ModelSelected.Type

export interface ProfileBinding extends Schema.Schema.Type<typeof ProfileBinding> {}
export const ProfileBinding = Schema.Struct({
  providerID: Provider.ID,
  integrationID: Integration.ID,
  profile: Model.ProfileName,
  credentialID: Credential.ID,
  accountGeneration: NonNegativeInt,
}).annotate({ identifier: "Session.ProfileBinding" })

export const ProfileBound = Event.durable({
  type: "session.profile.bound",
  ...options,
  schema: {
    ...Base,
    binding: ProfileBinding.pipe(optional),
  },
})
export type ProfileBound = typeof ProfileBound.Type

export const GuardrailApproved = Event.durable({
  type: "session.guardrail.approved",
  ...options,
  schema: {
    ...Base,
    directories: Schema.Array(Schema.String),
  },
})
export type GuardrailApproved = typeof GuardrailApproved.Type

export namespace Review {
  export const Deferred = Event.durable({
    type: "session.review.deferred",
    ...options,
    schema: { ...Base, ...SessionReview.Deferral.fields },
  })
  export type Deferred = typeof Deferred.Type
  export const Decided = Event.durable({
    type: "session.review.decided",
    ...options,
    schema: { ...Base, itemID: SessionReview.ID, decision: SessionReview.Decision },
  })
  export type Decided = typeof Decided.Type
  export const Withdrawn = Event.durable({
    type: "session.review.withdrawn",
    ...options,
    schema: { ...Base, itemID: SessionReview.ID, reason: Schema.Literals(["reverted", "task_closed"]) },
  })
  export type Withdrawn = typeof Withdrawn.Type
  export const Consumed = Event.durable({
    type: "session.review.consumed",
    ...options,
    schema: { ...Base, itemID: SessionReview.ID },
  })
  export type Consumed = typeof Consumed.Type
}

export const GuardrailDecided = Event.durable({
  type: "session.guardrail.decided",
  ...options,
  schema: {
    ...Base,
    reviewSessionID: SessionID,
    requestID: Schema.String,
    reply: Guardrail.Reply,
    authority: Guardrail.Authority.pipe(optional),
    choice: Guardrail.DecisionChoice.pipe(optional),
    grades: Schema.Array(Guardrail.Grade).pipe(optional),
    confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(optional),
    ruleIDs: Schema.Array(Schema.String).pipe(optional),
    source: Guardrail.Source.pipe(optional),
    actor: Schema.Literal("coordinator").pipe(optional),
    coordinatorSessionID: SessionID.pipe(optional),
    groupID: Schema.String.pipe(optional),
    rationale: Schema.String.check(Schema.isMaxLength(500), Schema.isPattern(/\S/)).pipe(optional),
  },
})
export type GuardrailDecided = typeof GuardrailDecided.Type

export const GuardrailEscalated = Event.durable({
  type: "session.guardrail.escalated",
  ...options,
  schema: {
    ...Base,
    requestID: Schema.String,
    ...Guardrail.Escalation.fields,
    ruleIDs: Schema.Array(Schema.String).pipe(optional),
    source: Guardrail.Source.pipe(optional),
  },
})
export type GuardrailEscalated = typeof GuardrailEscalated.Type

export const GuardrailDismissed = Event.durable({
  type: "session.guardrail.dismissed",
  ...options,
  schema: {
    ...Base,
    reviewSessionID: SessionID,
    ruleID: Schema.String.check(Schema.isPattern(/^standard\.review\./)),
    confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0.9, maximum: 1 })),
    source: Guardrail.Source.pipe(optional),
  },
})
export type GuardrailDismissed = typeof GuardrailDismissed.Type

export const DecisionAuditedAnswer = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(64)),
  type: Schema.Literals(["predicate", "choice", "score", "text", "refusal"]),
  confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  answer: Schema.Boolean.pipe(optional),
  choice: Schema.Union([Schema.String.check(Schema.isMaxLength(200)), Schema.Boolean]).pipe(optional),
  score: NonNegativeInt.pipe(optional),
  length: NonNegativeInt.pipe(optional),
})

export const DecisionAudited = Event.durable({
  type: "session.decision.audited",
  ...options,
  schema: {
    ...Base,
    purpose: Schema.Literals(["permission", "guardrail", "answer", "advisory"]),
    authority: Guardrail.Authority.pipe(optional),
    agent: Agent.ID,
    model: Model.Ref.pipe(optional),
    route: Schema.String.check(Schema.isMaxLength(128)).pipe(optional),
    outcome: Schema.Literals(["succeeded", "failed", "cancelled"]),
    reason: DecisionFailure.Reason.pipe(optional),
    fingerprint: Schema.String,
    invocationKey: Schema.String.pipe(optional),
    attempts: NonNegativeInt,
    answers: Schema.Array(DecisionAuditedAnswer).check(Schema.isMaxLength(32)).pipe(optional),
  },
})
export type DecisionAudited = typeof DecisionAudited.Type

export const PermissionAssessed = Event.durable({
  type: "session.permission.assessed",
  ...options,
  schema: {
    ...Base,
    requestID: Schema.String,
    outcome: Schema.Literals(["allow", "deny", "escalate"]),
    via: Schema.Literals(["auto-permission", "baseline", "yolo", "coordination"]),
    reply: Permission.Reply.pipe(optional),
    ...Guardrail.Escalation.fields,
    source: Guardrail.Source.pipe(optional),
    actor: Schema.Literal("coordinator").pipe(optional),
    coordinatorSessionID: SessionID.pipe(optional),
    groupID: Schema.String.pipe(optional),
    rationale: Schema.String.check(Schema.isMaxLength(500), Schema.isPattern(/\S/)).pipe(optional),
  },
})
export type PermissionAssessed = typeof PermissionAssessed.Type

export const DaybreakSet = Event.durable({
  type: "session.daybreak.set",
  ...options,
  schema: {
    ...Base,
    daybreak: Model.Daybreak.pipe(optional),
  },
})
export type DaybreakSet = typeof DaybreakSet.Type

export const ProjectArtifactsEnded = Event.durable({
  type: "session.project-artifacts-ended",
  ...options,
  schema: {
    ...Base,
    oldProjectID: Project.ID,
    newProjectID: Project.ID,
  },
})
export type ProjectArtifactsEnded = typeof ProjectArtifactsEnded.Type

export const Moved = Event.durable({
  type: "session.moved",
  ...options,
  schema: {
    ...Base,
    location: Location.Ref,
    projectID: Project.ID.pipe(optional),
    subpath: RelativePath.pipe(optional),
  },
})
export type Moved = typeof Moved.Type

export const Renamed = Event.durable({
  type: "session.renamed",
  ...options,
  schema: {
    ...Base,
    title: Schema.String,
  },
})
export type Renamed = typeof Renamed.Type

export const UsageRecorded = Event.durable({
  type: "session.usage.recorded",
  ...options,
  schema: {
    ...Base,
    source: Schema.Literals(["title", "compaction", "goal", "decision", "prediction", "prompt"]),
    cost: Money.USD,
    tokens: TokenUsage.Info,
  },
})
export type UsageRecorded = typeof UsageRecorded.Type

export const ProviderRequestRecorded = Event.durable({
  type: "session.provider.request.recorded",
  ...options,
  schema: ProviderRequest.Record.fields,
})
export type ProviderRequestRecorded = typeof ProviderRequestRecorded.Type

export const UsageUpdated = Event.ephemeral({
  type: "session.usage.updated",
  schema: {
    ...Base,
    cost: Money.USD,
    tokens: TokenUsage.Info,
  },
})
export type UsageUpdated = typeof UsageUpdated.Type

export const PredictionUpdated = Event.ephemeral({
  type: "session.prediction.updated",
  schema: { ...Base, sourceMessageID: SessionMessage.ID, text: Schema.String },
})
export type PredictionUpdated = typeof PredictionUpdated.Type

export const DiagnosticsUpdated = Event.ephemeral({
  type: "session.diagnostics.updated",
  schema: {
    ...Base,
    diagnostics: SessionCacheDiagnostics.Info,
  },
})
export type DiagnosticsUpdated = typeof DiagnosticsUpdated.Type

export const Deleted = Event.durable({
  type: "session.deleted",
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
  schema: Base,
})
export type Deleted = typeof Deleted.Type

export const Archived = Event.durable({
  type: "session.archived",
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
  schema: Base,
})
export type Archived = typeof Archived.Type

export const Unarchived = Event.durable({
  type: "session.unarchived",
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
  schema: Base,
})
export type Unarchived = typeof Unarchived.Type

export const Pinned = Event.durable({
  type: "session.pinned",
  durable: {
    aggregate: "sessionID",
    version: 1,
  },
  schema: Base,
})
export type Pinned = typeof Pinned.Type

export const Unpinned = Event.durable({
  type: "session.unpinned",
  durable: {
    aggregate: "sessionID",
    version: 1,
  },
  schema: Base,
})
export type Unpinned = typeof Unpinned.Type

export const Forked = Event.durable({
  type: "session.forked",
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
  schema: {
    ...Base,
    parentID: SessionID,
    parentSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1)),
    from: SessionMessage.ID.pipe(optional),
  },
})
export type Forked = typeof Forked.Type

export const InputPromoted = Event.durable({
  type: "session.input.promoted",
  ...options,
  schema: {
    sessionID: SessionID,
    inputID: SessionMessage.ID,
  },
})
export type InputPromoted = typeof InputPromoted.Type

export const InputAdmitted = Event.durable({
  type: "session.input.admitted",
  ...options,
  schema: {
    ...Base,
    inputID: SessionMessage.ID,
    input: SessionPending.Message,
    causedBy: UsageAnchor.Ref.pipe(optional),
  },
})
export type InputAdmitted = typeof InputAdmitted.Type

export const InputConsumed = Event.durable({
  type: "session.input.consumed",
  ...options,
  schema: {
    ...Base,
    inputIDs: Schema.NonEmptyArray(SessionMessage.ID),
  },
})
export type InputConsumed = typeof InputConsumed.Type

export const DotsExchangeCreated = Event.durable({
  type: "session.dots.exchange.created",
  ...options,
  schema: Dots.ExchangeRecord.fields,
})
export type DotsExchangeCreated = typeof DotsExchangeCreated.Type

export const DotsInstructionRejected = Event.durable({
  type: "session.dots.instruction.rejected",
  ...options,
  schema: { sessionID: SessionID, inputID: SessionMessage.ID, anchorSessionID: SessionID,
    exchangeID: Dots.ExchangeRead.fields.exchangeID, delegationID: Dots.DelegationRef.fields.id,
    reason: Schema.Literal("delegation_invalid"),
  },
})
export type DotsInstructionRejected = typeof DotsInstructionRejected.Type

export const DotsDecisionSettled = Event.durable({
  type: "session.dots.decision.settled",
  ...options,
  schema: {
    ...Base,
    source: Form.DelegatedReplySource,
    target: Dots.DecisionTarget,
    reply: Schema.Literals(["once", "reject"]).pipe(optional),
  },
})
export type DotsDecisionSettled = typeof DotsDecisionSettled.Type

export const DotsReportRecorded = Event.durable({
  type: "session.dots.report.recorded",
  ...options,
  schema: { ...Base, ...Dots.ExchangeOutput.fields, callID: Schema.String },
})
export type DotsReportRecorded = typeof DotsReportRecorded.Type

export namespace Execution {
  export const Started = Event.durable({ type: "session.execution.started", ...options, schema: Base })
  export type Started = typeof Started.Type

  export const Succeeded = Event.durable({ type: "session.execution.succeeded", ...options, schema: Base })
  export type Succeeded = typeof Succeeded.Type

  export const Failed = Event.durable({
    type: "session.execution.failed",
    ...options,
    schema: { ...Base, error: SessionError.Error },
  })
  export type Failed = typeof Failed.Type

  export const Interrupted = Event.durable({
    type: "session.execution.interrupted",
    ...options,
    schema: { ...Base, reason: Schema.Literals(["user", "shutdown", "superseded"]) },
  })
  export type Interrupted = typeof Interrupted.Type
}

export namespace Work {
  export const Completed = Event.durable({
    type: "session.work.completed",
    ...options,
    schema: { ...Base, inputID: SessionMessage.ID, assistantMessageID: SessionMessage.ID },
  })
  export type Completed = typeof Completed.Type
}

export const InstructionsUpdated = Event.durable({
  type: "session.instructions.updated",
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
  schema: {
    ...Base,
    delta: Instruction.Delta,
  },
})
export type InstructionsUpdated = typeof InstructionsUpdated.Type

export const ContextObserved = Event.durable({
  type: "session.context.observed",
  ...options,
  schema: {
    ...Base,
    source: Schema.Literals(["session-state", "team-view", "step-limit", "dots"]),
    text: Schema.String,
    dots: Dots.CoordinationContext.pipe(optional),
  },
})
export type ContextObserved = typeof ContextObserved.Type

export namespace Task {
  export const Updated = Event.durable({
    type: "session.task.updated",
    ...options,
    schema: {
      sessionID: SessionID,
      change: SessionOrchestration.Change.mapMembers(([launched, ...rest]) => [
        Schema.Struct({ ...launched.fields, usageAnchor: UsageAnchor.Ref.pipe(optional) }),
        ...rest,
      ]).pipe(Schema.toTaggedUnion("type")),
    },
  })
  export type Updated = typeof Updated.Type
}

export const Synthetic = Event.durable({
  type: "session.synthetic",
  ...options,
  schema: {
    ...Base,
    text: Schema.String,
    description: Schema.String.pipe(optional),
    metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
  },
})
export type Synthetic = typeof Synthetic.Type

export namespace Skill {
  export const Activated = Event.durable({
    type: "session.skill.activated",
    ...options,
    schema: {
      ...Base,
      id: SkillSchema.ID,
      name: SkillSchema.Name,
      text: Schema.String,
      conflicts: SkillSchema.Conflicts.pipe(optional),
      artifact: ArtifactProvenance.pipe(optional),
    },
  })
  export type Activated = typeof Activated.Type

  export const Deactivated = Event.durable({
    type: "session.skill.deactivated",
    ...options,
    schema: {
      ...Base,
      id: SkillSchema.ID,
      activationMessageID: SessionMessage.ID,
      reason: Schema.Literal("conflict_resolved"),
    },
  })
  export type Deactivated = typeof Deactivated.Type
}

export namespace Shell {
  export const Started = Event.durable({
    type: "session.shell.started",
    ...options,
    schema: {
      ...Base,
      shell: ShellSchema.Info,
    },
  })
  export type Started = typeof Started.Type

  export const Ended = Event.durable({
    type: "session.shell.ended",
    ...options,
    schema: {
      ...Base,
      shell: ShellSchema.Info,
      output: ShellSchema.Output,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Step {
  export const Started = Event.durable({
    type: "session.step.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      agent: Agent.ID,
      model: Model.Ref,
      snapshot: Snapshot.ID.pipe(optional),
    },
  })
  export type Started = typeof Started.Type

  export const Ended = Event.durable({
    type: "session.step.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      finish: FinishReason,
      cost: Money.USD,
      tokens: TokenUsage.Info,
      contextLimit: NonNegativeInt.pipe(optional),
      contextBreakdown: SessionCacheDiagnostics.ContextBreakdown.pipe(optional),
      providerCache: SessionCacheDiagnostics.ProviderCache.pipe(optional),
      snapshot: Snapshot.ID.pipe(optional),
      files: Schema.Array(RelativePath).pipe(optional),
    },
  })
  export type Ended = typeof Ended.Type

  export const Failed = Event.durable({
    type: "session.step.failed",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      error: SessionError.Error,
      cost: Money.USD.pipe(optional),
      tokens: TokenUsage.Info.pipe(optional),
      contextLimit: NonNegativeInt.pipe(optional),
      contextBreakdown: SessionCacheDiagnostics.ContextBreakdown.pipe(optional),
      providerCache: SessionCacheDiagnostics.ProviderCache.pipe(optional),
      snapshot: Snapshot.ID.pipe(optional),
      files: Schema.Array(RelativePath).pipe(optional),
    },
  })
  export type Failed = typeof Failed.Type

  export const Rerouted = Event.durable({
    type: "session.step.rerouted",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      model: Model.Ref,
      error: SessionError.Error,
    },
  })
  export type Rerouted = typeof Rerouted.Type
}

export namespace Text {
  export const Started = Event.durable({
    type: "session.text.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      ordinal: NonNegativeInt,
      phase: Schema.Literals(["commentary", "final_answer"]).pipe(optional),
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Text.Ended is the replayable full-value boundary.
  export const Delta = Event.ephemeral({
    type: "session.text.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      ordinal: NonNegativeInt,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.durable({
    type: "session.text.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      ordinal: NonNegativeInt,
      text: Schema.String,
      breaks: Schema.Array(SessionMessage.TextBreak).pipe(optional),
      phase: Schema.Literals(["commentary", "final_answer"]).pipe(optional),
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Reasoning {
  export const Started = Event.durable({
    type: "session.reasoning.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      ordinal: NonNegativeInt,
      state: SessionMessage.ProviderState.pipe(optional),
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Reasoning.Ended is the replayable full-value boundary.
  export const Delta = Event.ephemeral({
    type: "session.reasoning.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      ordinal: NonNegativeInt,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.durable({
    type: "session.reasoning.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      ordinal: NonNegativeInt,
      text: Schema.String,
      state: SessionMessage.ProviderState.pipe(optional),
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Tool {
  const ToolBase = {
    ...Base,
    assistantMessageID: SessionMessage.ID,
    callID: Schema.String,
  }

  export namespace Input {
    export const Started = Event.durable({
      type: "session.tool.input.started",
      ...options,
      schema: {
        ...ToolBase,
        name: Schema.String,
      },
    })
    export type Started = typeof Started.Type

    // Stream fragments are live-only; Input.Ended is the replayable raw-input boundary.
    export const Delta = Event.ephemeral({
      type: "session.tool.input.delta",
      schema: {
        ...ToolBase,
        delta: Schema.String,
      },
    })
    export type Delta = typeof Delta.Type

    export const Ended = Event.durable({
      type: "session.tool.input.ended",
      ...options,
      schema: {
        ...ToolBase,
        text: Schema.String,
      },
    })
    export type Ended = typeof Ended.Type
  }

  export const Called = Event.durable({
    type: "session.tool.called",
    ...options,
    schema: {
      ...ToolBase,
      input: Schema.Record(Schema.String, Schema.Unknown),
      executed: Schema.Boolean,
      state: SessionMessage.ProviderState.pipe(optional),
    },
  })
  export type Called = typeof Called.Type

  // Running-tool state is live-only; Success and Failed are the replayable settlement boundary.
  export const Progress = Event.ephemeral({
    type: "session.tool.progress",
    schema: {
      ...ToolBase,
      structured: Schema.Record(Schema.String, Schema.Unknown),
      content: Schema.Array(ToolContent),
    },
  })
  export type Progress = typeof Progress.Type

  export const Success = Event.durable({
    type: "session.tool.success",
    ...options,
    schema: {
      ...ToolBase,
      structured: Schema.Record(Schema.String, Schema.Unknown),
      content: Schema.Array(ToolContent),
      result: Schema.Unknown.pipe(optional),
      executed: Schema.Boolean,
      resultState: SessionMessage.ProviderState.pipe(optional),
    },
  })
  export type Success = typeof Success.Type

  export const Failed = Event.durable({
    type: "session.tool.failed",
    ...options,
    schema: {
      ...ToolBase,
      error: SessionError.Error,
      result: Schema.Unknown.pipe(optional),
      executed: Schema.Boolean,
      resultState: SessionMessage.ProviderState.pipe(optional),
    },
  })
  export type Failed = typeof Failed.Type
}

export namespace FileChange {
  export interface Info extends Schema.Schema.Type<typeof Info> {}
  export const Info = Schema.Struct({
    path: RelativePath,
    patch: Schema.String,
    additions: NonNegativeInt,
    deletions: NonNegativeInt,
  }).annotate({ identifier: "Session.Event.FileChange.Info" })

  export const Recorded = Event.durable({
    type: "session.file-change.recorded",
    ...options,
    schema: {
      ...Base,
      change: Info,
    },
  })
  export type Recorded = typeof Recorded.Type
}

export const RetryScheduled = Event.durable({
  type: "session.retry.scheduled",
  ...options,
  schema: {
    ...Base,
    assistantMessageID: SessionMessage.ID,
    attempt: PositiveInt,
    at: NonNegativeInt,
    error: SessionError.Error,
  },
})
export type RetryScheduled = typeof RetryScheduled.Type

export namespace Compaction {
  export const AdmittedV1 = Event.durable({
    type: "session.compaction.admitted",
    ...options,
    schema: {
      ...Base,
      inputID: SessionMessage.ID,
    },
  })
  export type AdmittedV1 = typeof AdmittedV1.Type

  export const StartedV1 = Event.durable({
    type: "session.compaction.started",
    ...options,
    schema: {
      ...Base,
      reason: Schema.Literals(["auto", "manual"]),
      recent: Schema.String,
      inputID: SessionMessage.ID.pipe(optional),
    },
  })
  export type StartedV1 = typeof StartedV1.Type

  export const Delta = Event.ephemeral({
    type: "session.compaction.delta",
    schema: {
      ...Base,
      text: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const EndedV1 = Event.durable({
    type: "session.compaction.ended",
    ...options,
    schema: {
      ...Base,
      reason: StartedV1.data.fields.reason,
      text: Schema.String,
      recent: Schema.String,
      messages: NonNegativeInt.pipe(optional),
      tokens: TokenUsage.Info.pipe(optional),
    },
  })
  export type EndedV1 = typeof EndedV1.Type

  /** Signals that compaction replaced canonical history without producing another message row. */
  export const Replaced = Event.durable({
    type: "session.compaction.replaced",
    ...options,
    schema: {
      ...Base,
      summaryMessageID: SessionMessage.ID,
      through: NonNegativeInt,
      summaryRevision: NonNegativeInt,
      deletedMessageCount: NonNegativeInt,
      remainingMessageCount: NonNegativeInt,
    },
  })
  export type Replaced = typeof Replaced.Type

  export const FailedV1 = Event.durable({
    type: "session.compaction.failed",
    ...options,
    schema: {
      ...Base,
      reason: StartedV1.data.fields.reason,
      error: SessionError.Error,
      inputID: SessionMessage.ID.pipe(optional),
    },
  })
  export type FailedV1 = typeof FailedV1.Type

  const current = {
    durable: {
      aggregate: "sessionID",
      version: 2,
    },
  } as const

  export const Admitted = Event.durable({
    type: "session.compaction.admitted",
    ...current,
    schema: { ...Base, jobID: SessionCompaction.ID, pressure: SessionCompaction.Pressure.pipe(optional), usageAnchor: UsageAnchor.Ref.pipe(optional) },
  })
  export type Admitted = typeof Admitted.Type

  export const Started = Event.durable({
    type: "session.compaction.started",
    ...current,
    schema: { ...Base, jobID: SessionCompaction.ID },
  })
  export type Started = typeof Started.Type

  export const Ended = Event.durable({
    type: "session.compaction.ended",
    ...current,
    schema: {
      ...Base,
      jobID: SessionCompaction.ID,
      revision: NonNegativeInt,
      boundary: SessionCompaction.Boundary,
      metrics: SessionCompaction.Metrics,
    },
  })
  export type Ended = typeof Ended.Type

  export const Failed = Event.durable({
    type: "session.compaction.failed",
    ...current,
    schema: {
      ...Base,
      jobID: SessionCompaction.ID,
      code: SessionCompaction.FailureCode,
      error: SessionError.Error,
    },
  })
  export type Failed = typeof Failed.Type

  export const DurableDefinitions = Event.inventory(
    AdmittedV1,
    StartedV1,
    EndedV1,
    Replaced,
    FailedV1,
    Admitted,
    Started,
    Ended,
    Failed,
  )

  export const LegacyDurableDefinitions = Event.inventory(AdmittedV1, StartedV1, EndedV1, Replaced, FailedV1)
}

export namespace RevertEvent {
  export const Staged = Event.durable({
    type: "session.revert.staged",
    ...options,
    schema: { ...Base, revert: Revert },
  })
  export const Cleared = Event.durable({ type: "session.revert.cleared", ...options, schema: Base })
  export const Committed = Event.durable({
    type: "session.revert.committed",
    ...options,
    schema: { ...Base, to: SessionMessage.ID },
  })
}

export const Definitions = Event.inventory(
  Created,
  AgentSelected,
  ModelSelected,
  DaybreakSet,
  ProjectArtifactsEnded,
  GuardrailDismissed,
  GuardrailEscalated,
  GuardrailDecided,
  DecisionAudited,
  PermissionAssessed,
  Review.Deferred,
  Review.Decided,
  Review.Withdrawn,
  Review.Consumed,
  Moved,
  Renamed,
  UsageUpdated,
  PredictionUpdated,
  DiagnosticsUpdated,
  Deleted,
  Archived,
  Unarchived,
  Pinned,
  Unpinned,
  Forked,
  InputPromoted,
  InputAdmitted,
  InputConsumed,
  DotsExchangeCreated,
  DotsDecisionSettled,
  DotsInstructionRejected,
  DotsReportRecorded,
  Execution.Started,
  Execution.Succeeded,
  Execution.Failed,
  Execution.Interrupted,
  Work.Completed,
  InstructionsUpdated,
  ContextObserved,
  Task.Updated,
  Synthetic,
  Skill.Activated,
  Skill.Deactivated,
  Shell.Started,
  Shell.Ended,
  Step.Started,
  Step.Ended,
  Step.Failed,
  Step.Rerouted,
  Text.Started,
  Text.Delta,
  Text.Ended,
  Reasoning.Started,
  Reasoning.Delta,
  Reasoning.Ended,
  Tool.Input.Started,
  Tool.Input.Delta,
  Tool.Input.Ended,
  Tool.Called,
  Tool.Progress,
  Tool.Success,
  Tool.Failed,
  FileChange.Recorded,
  RetryScheduled,
  Compaction.Admitted,
  Compaction.Started,
  Compaction.Delta,
  Compaction.Ended,
  Compaction.Failed,
  RevertEvent.Staged,
  RevertEvent.Cleared,
  RevertEvent.Committed,
)

export const PublicDurableDefinitions = Event.inventory(
  ...Definitions.filter((definition) => definition.durability === "durable"),
)

export const PublicDurable = Schema.Union(PublicDurableDefinitions, { mode: "oneOf" })
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Session.Event.PublicDurable" })
export type PublicDurableEvent = typeof PublicDurable.Type

// UsageRecorded and ProviderRequestRecorded remain durable for replay/projectors but are excluded from public logs.
export const DurableDefinitions = Event.inventory(
  ...PublicDurableDefinitions,
  ...Compaction.LegacyDurableDefinitions,
  UsageRecorded,
  ProviderRequestRecorded,
  ProfileBound,
  GuardrailApproved,
)

// Durable replay accepts legacy and current payloads for the same event type.
// They are distinguished by the persisted durable version rather than `type`.
export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" }).annotate({
  identifier: "Session.Event.Durable",
})
export type DurableEvent = typeof Durable.Type

const Public = Schema.Union(Definitions, { mode: "oneOf" })
export const All = Schema.Union([Public, UsageRecorded, ProviderRequestRecorded, ProfileBound, GuardrailApproved], {
  mode: "oneOf",
})
export type Event = typeof All.Type
export type Type = Event["type"]

export function match<Output>(event: Event, cases: MatchCases<Output>) {
  return (cases[event.type] as (event: Event) => Output)(event)
}

type MatchCases<Output> = {
  readonly [EventType in Type]: (event: Extract<Event, { readonly type: EventType }>) => Output
}
