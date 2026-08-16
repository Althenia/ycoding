export * as SessionMessage from "./session-message.js"

import { Schema } from "effect"
import { optional } from "./schema.js"
import { ToolContent } from "./llm.js"
import { Model } from "./model.js"
import { Prompt } from "./prompt.js"
import { DateTimeUtcFromMillis, NonNegativeInt, PositiveInt, RelativePath } from "./schema.js"
import { ID as SessionMessageID } from "./session-message-id.js"
import { Shell as ShellSchema } from "./shell.js"
import { FinishReason } from "./llm.js"
import { SessionError } from "./session-error.js"
import { SessionCacheDiagnostics } from "./session-cache-diagnostics.js"
import { Agent } from "./agent.js"
import { Skill as SkillSchema } from "./skill.js"
import { Money } from "./money.js"
import { Snapshot } from "./snapshot.js"
import { TokenUsage } from "./token-usage.js"
import { SessionCompaction } from "./session-compaction.js"

export const ID = SessionMessageID
export type ID = typeof ID.Type

const Base = {
  id: ID,
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
  time: Schema.Struct({ created: DateTimeUtcFromMillis }),
}

const projectArtifactScopeBrand: string = "ProjectArtifact.ScopeID"
const projectArtifactVersionBrand: string = "ProjectArtifact.VersionID"
const projectArtifactIDBrand: string = "ProjectArtifact.ID"
const ArtifactScopeID = Schema.String.check(Schema.isPattern(/^pas_[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/)).pipe(
  Schema.brand(projectArtifactScopeBrand),
)
const ArtifactVersionID = Schema.String.check(Schema.isPattern(/^pav_[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/)).pipe(
  Schema.brand(projectArtifactVersionBrand),
)
const ArtifactID = Schema.String.check(
  Schema.isPattern(/^(?!(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)$)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
).pipe(Schema.brand(projectArtifactIDBrand))

export const ArtifactProvenance = Schema.Struct({
  scopeID: ArtifactScopeID,
  versionID: ArtifactVersionID,
  kind: Schema.Literals(["skill", "command", "agent", "plugin"]),
  id: ArtifactID,
  sourceScope: Schema.Literals(["project", "global"]),
}).annotate({ identifier: "Session.Message.ArtifactProvenance" })
export type ArtifactProvenance = typeof ArtifactProvenance.Type

export const ProviderState = Schema.Record(Schema.String, Schema.Unknown).annotate({
  identifier: "Session.Message.ProviderState",
})
export type ProviderState = typeof ProviderState.Type

export interface AgentSelected extends Schema.Schema.Type<typeof AgentSelected> {}
export const AgentSelected = Schema.Struct({
  ...Base,
  type: Schema.tag("agent-switched"),
  agent: Agent.ID,
  artifact: ArtifactProvenance.pipe(optional),
}).annotate({ identifier: "Session.Message.AgentSelected" })

export interface ModelSelected extends Schema.Schema.Type<typeof ModelSelected> {}
export const ModelSelected = Schema.Struct({
  ...Base,
  type: Schema.tag("model-switched"),
  model: Model.Ref,
  previous: Model.Ref.pipe(optional),
}).annotate({ identifier: "Session.Message.ModelSelected" })

export interface User extends Schema.Schema.Type<typeof User> {}
export const User = Schema.Struct({
  ...Base,
  text: Prompt.fields.text,
  files: Prompt.fields.files,
  agents: Prompt.fields.agents,
  type: Schema.tag("user"),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    consumed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Session.Message.User" })

export interface Synthetic extends Schema.Schema.Type<typeof Synthetic> {}
export const Synthetic = Schema.Struct({
  ...Base,
  text: Schema.String,
  description: Schema.String.pipe(optional),
  type: Schema.tag("synthetic"),
}).annotate({ identifier: "Session.Message.Synthetic" })

export interface System extends Schema.Schema.Type<typeof System> {}
export const System = Schema.Struct({
  ...Base,
  type: Schema.tag("system"),
  text: Schema.String,
}).annotate({ identifier: "Session.Message.System" })

export interface SkillDeactivation extends Schema.Schema.Type<typeof SkillDeactivation> {}
export const SkillDeactivation = Schema.Struct({
  skill: SkillSchema.ID,
  reason: Schema.Literal("conflict_resolved"),
}).annotate({ identifier: "Session.Message.SkillDeactivation" })

export interface Skill extends Schema.Schema.Type<typeof Skill> {}
export const Skill = Schema.Struct({
  ...Base,
  type: Schema.tag("skill"),
  skill: SkillSchema.ID,
  name: SkillSchema.Name,
  text: Schema.String,
  conflicts: SkillSchema.Conflicts.pipe(optional),
  skillDeactivations: Schema.Array(SkillDeactivation).pipe(optional),
  artifact: ArtifactProvenance.pipe(optional),
}).annotate({ identifier: "Session.Message.Skill" })

export interface Shell extends Schema.Schema.Type<typeof Shell> {}
export const Shell = Schema.Struct({
  ...Base,
  type: Schema.tag("shell"),
  shellID: ShellSchema.ID,
  command: Schema.String,
  status: ShellSchema.Status,
  exit: Schema.Number.pipe(optional),
  output: ShellSchema.Output.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Session.Message.Shell" })

export interface ToolStateStreaming extends Schema.Schema.Type<typeof ToolStateStreaming> {}
export const ToolStateStreaming = Schema.Struct({
  status: Schema.tag("streaming"),
  input: Schema.String,
}).annotate({ identifier: "Session.Message.ToolState.Streaming" })

export interface ToolStateRunning extends Schema.Schema.Type<typeof ToolStateRunning> {}
export const ToolStateRunning = Schema.Struct({
  status: Schema.tag("running"),
  input: Schema.Record(Schema.String, Schema.Unknown),
  structured: Schema.Record(Schema.String, Schema.Unknown),
  content: ToolContent.pipe(Schema.Array),
}).annotate({ identifier: "Session.Message.ToolState.Running" })

export interface ToolStateCompleted extends Schema.Schema.Type<typeof ToolStateCompleted> {}
export const ToolStateCompleted = Schema.Struct({
  status: Schema.tag("completed"),
  input: Schema.Record(Schema.String, Schema.Unknown),
  content: ToolContent.pipe(Schema.Array),
  structured: Schema.Record(Schema.String, Schema.Unknown),
  result: Schema.Unknown.pipe(optional),
}).annotate({ identifier: "Session.Message.ToolState.Completed" })

export interface ToolStateError extends Schema.Schema.Type<typeof ToolStateError> {}
export const ToolStateError = Schema.Struct({
  status: Schema.tag("error"),
  input: Schema.Record(Schema.String, Schema.Unknown),
  content: ToolContent.pipe(Schema.Array),
  structured: Schema.Record(Schema.String, Schema.Unknown),
  error: SessionError.Error,
  result: Schema.Unknown.pipe(optional),
}).annotate({ identifier: "Session.Message.ToolState.Error" })

export const ToolState = Schema.Union([ToolStateStreaming, ToolStateRunning, ToolStateCompleted, ToolStateError]).pipe(
  Schema.toTaggedUnion("status"),
)
export type ToolState = ToolStateStreaming | ToolStateRunning | ToolStateCompleted | ToolStateError

export interface AssistantTool extends Schema.Schema.Type<typeof AssistantTool> {}
export const AssistantTool = Schema.Struct({
  type: Schema.tag("tool"),
  id: Schema.String,
  name: Schema.String,
  executed: Schema.Boolean.pipe(optional),
  providerState: ProviderState.pipe(optional),
  providerResultState: ProviderState.pipe(optional),
  state: ToolState,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    ran: DateTimeUtcFromMillis.pipe(optional),
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Session.Message.Assistant.Tool" })

export interface AssistantText extends Schema.Schema.Type<typeof AssistantText> {}
export const AssistantText = Schema.Struct({
  type: Schema.tag("text"),
  text: Schema.String,
  phase: Schema.Literals(["commentary", "final_answer"]).pipe(optional),
}).annotate({ identifier: "Session.Message.Assistant.Text" })

export interface AssistantReasoning extends Schema.Schema.Type<typeof AssistantReasoning> {}
export const AssistantReasoning = Schema.Struct({
  type: Schema.tag("reasoning"),
  text: Schema.String,
  state: ProviderState.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }).pipe(optional),
}).annotate({ identifier: "Session.Message.Assistant.Reasoning" })

export const AssistantContent = Schema.Union([AssistantText, AssistantReasoning, AssistantTool]).pipe(
  Schema.toTaggedUnion("type"),
)
export type AssistantContent = AssistantText | AssistantReasoning | AssistantTool

export interface AssistantRetry extends Schema.Schema.Type<typeof AssistantRetry> {}
export const AssistantRetry = Schema.Struct({
  attempt: PositiveInt,
  at: DateTimeUtcFromMillis,
  error: SessionError.Error,
}).annotate({ identifier: "Session.Message.Assistant.Retry" })

export interface Assistant extends Schema.Schema.Type<typeof Assistant> {}
export const Assistant = Schema.Struct({
  ...Base,
  type: Schema.tag("assistant"),
  agent: Agent.ID,
  model: Model.Ref,
  content: AssistantContent.pipe(Schema.Array),
  skillDeactivations: Schema.Array(SkillDeactivation).pipe(optional),
  snapshot: Schema.Struct({
    start: Snapshot.ID.pipe(optional),
    end: Snapshot.ID.pipe(optional),
    files: Schema.Array(RelativePath).pipe(optional),
  }).pipe(optional),
  finish: FinishReason.pipe(optional),
  cost: Money.USD.pipe(optional),
  tokens: TokenUsage.Info.pipe(optional),
  diagnostics: Schema.Struct({
    contextLimit: NonNegativeInt.pipe(optional),
    providerCache: SessionCacheDiagnostics.ProviderCache.pipe(optional),
  }).pipe(optional),
  error: SessionError.Error.pipe(optional),
  retry: AssistantRetry.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Session.Message.Assistant" })

const CompactionBase = { type: Schema.tag("compaction"), ...Base }

const CompactionCurrent = {
  jobID: SessionCompaction.ID,
  trigger: SessionCompaction.Trigger,
}

const CompactionLegacy = {
  reason: Schema.Literals(["auto", "manual"]),
}

export interface CompactionRunningV1 extends Schema.Schema.Type<typeof CompactionRunningV1> {}
export const CompactionRunningV1 = Schema.Struct({
  ...CompactionBase,
  ...CompactionLegacy,
  status: Schema.tag("running"),
  summary: Schema.String,
  recent: Schema.String,
}).annotate({ identifier: "Session.Message.Compaction.RunningV1" })

export interface CompactionCompletedV1 extends Schema.Schema.Type<typeof CompactionCompletedV1> {}
export const CompactionCompletedV1 = Schema.Struct({
  ...CompactionBase,
  ...CompactionLegacy,
  status: Schema.tag("completed"),
  summary: Schema.String,
  recent: Schema.String,
  messages: NonNegativeInt.pipe(optional),
  tokens: TokenUsage.Info.pipe(optional),
}).annotate({ identifier: "Session.Message.Compaction.CompletedV1" })

export interface CompactionFailedV1 extends Schema.Schema.Type<typeof CompactionFailedV1> {}
export const CompactionFailedV1 = Schema.Struct({
  ...CompactionBase,
  ...CompactionLegacy,
  status: Schema.tag("failed"),
  error: SessionError.Error,
}).annotate({ identifier: "Session.Message.Compaction.FailedV1" })

export interface CompactionPending extends Schema.Schema.Type<typeof CompactionPending> {}
export const CompactionPending = Schema.Struct({
  ...CompactionBase,
  ...CompactionCurrent,
  status: Schema.tag("pending"),
  summary: Schema.String.pipe(optional),
  recent: Schema.String.pipe(optional),
}).annotate({ identifier: "Session.Message.Compaction.Pending" })

export interface CompactionRunningCurrent extends Schema.Schema.Type<typeof CompactionRunningCurrent> {}
export const CompactionRunningCurrent = Schema.Struct({
  ...CompactionBase,
  ...CompactionCurrent,
  status: Schema.tag("running"),
  summary: Schema.String.pipe(optional),
  recent: Schema.String.pipe(optional),
}).annotate({ identifier: "Session.Message.Compaction.Running" })

export const CompactionRunning = Schema.Union([CompactionRunningV1, CompactionRunningCurrent], { mode: "oneOf" })
export type CompactionRunning = typeof CompactionRunning.Type

export interface CompactionCompletedCurrent extends Schema.Schema.Type<typeof CompactionCompletedCurrent> {}
export const CompactionCompletedCurrent = Schema.Struct({
  ...CompactionBase,
  ...CompactionCurrent,
  status: Schema.tag("completed"),
  revision: NonNegativeInt,
  boundary: SessionCompaction.Boundary,
  metrics: SessionCompaction.Metrics,
  summary: Schema.String.pipe(optional),
  recent: Schema.String.pipe(optional),
}).annotate({ identifier: "Session.Message.Compaction.Completed" })

export const CompactionCompleted = Schema.Union([CompactionCompletedV1, CompactionCompletedCurrent], { mode: "oneOf" })
export type CompactionCompleted = typeof CompactionCompleted.Type

export interface CompactionFailedCurrent extends Schema.Schema.Type<typeof CompactionFailedCurrent> {}
export const CompactionFailedCurrent = Schema.Struct({
  ...CompactionBase,
  ...CompactionCurrent,
  status: Schema.tag("failed"),
  code: SessionCompaction.FailureCode,
  error: SessionError.Error,
  summary: Schema.String.pipe(optional),
  recent: Schema.String.pipe(optional),
}).annotate({ identifier: "Session.Message.Compaction.Failed" })

export const CompactionFailed = Schema.Union([CompactionFailedV1, CompactionFailedCurrent], { mode: "oneOf" })
export type CompactionFailed = typeof CompactionFailed.Type

export const Compaction = Schema.Union([CompactionPending, CompactionRunning, CompactionCompleted, CompactionFailed]).pipe(
  Schema.annotate({ identifier: "Session.Message.Compaction" }),
)
export type Compaction = typeof Compaction.Type

export const Info = Schema.Union([
  AgentSelected,
  ModelSelected,
  User,
  Synthetic,
  System,
  Skill,
  Shell,
  Assistant,
  Compaction,
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Session.Message.Info" })
export type Info = AgentSelected | ModelSelected | User | Synthetic | System | Skill | Shell | Assistant | Compaction
export type Type = Info["type"]
