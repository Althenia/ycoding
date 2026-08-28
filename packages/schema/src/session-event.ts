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
import { SessionOrchestration } from "./session-orchestration.js"
import { Permission } from "./permission.js"
import { SessionCompaction } from "./session-compaction.js"

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
    source: Schema.Literals(["title", "compaction", "goal"]),
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

export namespace Task {
  export const Updated = Event.durable({
    type: "session.task.updated",
    ...options,
    schema: { sessionID: SessionID, change: SessionOrchestration.Change },
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
      providerCache: SessionCacheDiagnostics.ProviderCache.pipe(optional),
      snapshot: Snapshot.ID.pipe(optional),
      files: Schema.Array(RelativePath).pipe(optional),
    },
  })
  export type Failed = typeof Failed.Type
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

  /**
   * Replayable bounded running-tool state. Tools should checkpoint semantic
   * transitions or at a bounded cadence, not persist every stdout/stderr chunk.
   */
  export const Progress = Event.durable({
    type: "session.tool.progress",
    ...options,
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
    schema: { ...Base, jobID: SessionCompaction.ID, pressure: SessionCompaction.Pressure.pipe(optional) },
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
  ProjectArtifactsEnded,
  Moved,
  Renamed,
  UsageUpdated,
  DiagnosticsUpdated,
  Deleted,
  Forked,
  InputPromoted,
  InputAdmitted,
  InputConsumed,
  Execution.Started,
  Execution.Succeeded,
  Execution.Failed,
  Execution.Interrupted,
  InstructionsUpdated,
  Task.Updated,
  Synthetic,
  Skill.Activated,
  Skill.Deactivated,
  Shell.Started,
  Shell.Ended,
  Step.Started,
  Step.Ended,
  Step.Failed,
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
)

// Durable replay accepts legacy and current payloads for the same event type.
// They are distinguished by the persisted durable version rather than `type`.
export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" }).annotate({
  identifier: "Session.Event.Durable",
})
export type DurableEvent = typeof Durable.Type

const Public = Schema.Union(Definitions, { mode: "oneOf" })
export const All = Schema.Union([Public, UsageRecorded, ProviderRequestRecorded], { mode: "oneOf" })
export type Event = typeof All.Type
export type Type = Event["type"]

export function match<Output>(event: Event, cases: MatchCases<Output>) {
  return (cases[event.type] as (event: Event) => Output)(event)
}

type MatchCases<Output> = {
  readonly [EventType in Type]: (event: Extract<Event, { readonly type: EventType }>) => Output
}
