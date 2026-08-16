export * as ProjectArtifact from "./project-artifact.js"

import { Schema } from "effect"
import { Agent } from "./agent.js"
import { Permission } from "./permission.js"
import { Project } from "./project.js"
import { RelativePath, optional } from "./schema.js"
import { Session } from "./session.js"

const utf8 = new TextEncoder()
const boundedText = (identifier: string, maximumScalars: number, maximumBytes: number) =>
  Schema.String.check(
    Schema.makeFilter<string>(
      (value) => Array.from(value).length <= maximumScalars && utf8.encode(value).byteLength <= maximumBytes,
      {
        expected: `at most ${maximumScalars} Unicode scalars and ${maximumBytes} UTF-8 bytes`,
        meta: { _tag: "isMaxLength", maxLength: maximumBytes },
        arbitrary: { constraint: { maxLength: maximumBytes } },
      },
    ),
  ).annotate({ identifier })

const safeID = (identifier: string, prefix?: string) =>
  Schema.String.check(
    Schema.isPattern(
      prefix === undefined
        ? /^(?!(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)$)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
        : new RegExp(`^${prefix}_[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$`),
    ),
  ).pipe(Schema.brand(identifier))

export const ID = safeID("ProjectArtifact.ID")
export type ID = typeof ID.Type
export const ScopeID = safeID("ProjectArtifact.ScopeID", "pas")
export type ScopeID = typeof ScopeID.Type
export const VersionID = safeID("ProjectArtifact.VersionID", "pav")
export type VersionID = typeof VersionID.Type
export const DeletionID = safeID("ProjectArtifact.DeletionID", "pad")
export type DeletionID = typeof DeletionID.Type
export const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
  identifier: "ProjectArtifact.Revision",
})
export type Revision = typeof Revision.Type
export const TimestampMillis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
  identifier: "ProjectArtifact.TimestampMillis",
})
export type TimestampMillis = typeof TimestampMillis.Type
export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(Schema.brand("ProjectArtifact.Digest"))
export type Digest = typeof Digest.Type
export const StorageID = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
).pipe(Schema.brand("ProjectArtifact.StorageID"))
export type StorageID = typeof StorageID.Type
export const DisplayName = boundedText("ProjectArtifact.DisplayName", 128, 512)
export type DisplayName = typeof DisplayName.Type
export const Description = boundedText("ProjectArtifact.Description", 512, 2048)
export type Description = typeof Description.Type
export const SkillContent = boundedText("ProjectArtifact.SkillContent", 24 * 1024, 24 * 1024)
export type SkillContent = typeof SkillContent.Type
export const CommandTemplate = boundedText("ProjectArtifact.CommandTemplate", 16 * 1024, 16 * 1024)
export type CommandTemplate = typeof CommandTemplate.Type
export const AgentSystem = boundedText("ProjectArtifact.AgentSystem", 16 * 1024, 16 * 1024)
export type AgentSystem = typeof AgentSystem.Type
export const PluginDraft = boundedText("ProjectArtifact.PluginDraft", 32 * 1024, 32 * 1024)
export type PluginDraft = typeof PluginDraft.Type
export const ContentRelpath = RelativePath.check(
  Schema.isPattern(/^(?!\/|~(?:\/|$)|[A-Za-z]:|\\\\)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*$/),
).annotate({ identifier: "ProjectArtifact.ContentRelpath" })
export type ContentRelpath = typeof ContentRelpath.Type
export const ConfirmationToken = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,512}$/),
).annotate({ identifier: "ProjectArtifact.ConfirmationToken" })
export type ConfirmationToken = typeof ConfirmationToken.Type
export const RenderedContent = boundedText("ProjectArtifact.RenderedContent", 32 * 1024, 32 * 1024).check(
  Schema.isNonEmpty(),
)
export type RenderedContent = typeof RenderedContent.Type

export const Kind = Schema.Literals(["skill", "command", "agent", "plugin"]).annotate({
  identifier: "ProjectArtifact.Kind",
})
export type Kind = typeof Kind.Type
export const Stage = Schema.Literals(["trial", "active", "degraded", "disabled", "quarantine"]).annotate({
  identifier: "ProjectArtifact.Stage",
})
export type Stage = typeof Stage.Type
export const Source = Schema.Literals(["agent", "user", "promotion", "fork", "restore"]).annotate({
  identifier: "ProjectArtifact.Source",
})
export type Source = typeof Source.Type

export const ProjectScope = Schema.Struct({
  type: Schema.Literal("project"),
  id: ScopeID,
  projectID: Project.ID,
  storageID: StorageID,
}).annotate({ identifier: "ProjectArtifact.ProjectScope" })
export type ProjectScope = typeof ProjectScope.Type
export const GlobalScope = Schema.Struct({
  type: Schema.Literal("global"),
  id: ScopeID,
  storageID: StorageID,
}).annotate({ identifier: "ProjectArtifact.GlobalScope" })
export type GlobalScope = typeof GlobalScope.Type
export const Scope = Schema.Union([ProjectScope, GlobalScope])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "ProjectArtifact.Scope" })
export type Scope = typeof Scope.Type
export const ProjectScopeSelector = Schema.Struct({
  type: Schema.Literal("project"),
}).annotate({ identifier: "ProjectArtifact.ProjectScopeSelector" })
export type ProjectScopeSelector = typeof ProjectScopeSelector.Type
export const GlobalScopeSelector = Schema.Struct({
  type: Schema.Literal("global"),
}).annotate({ identifier: "ProjectArtifact.GlobalScopeSelector" })
export type GlobalScopeSelector = typeof GlobalScopeSelector.Type
export const ScopeSelector = Schema.Union([ProjectScopeSelector, GlobalScopeSelector])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "ProjectArtifact.ScopeSelector" })
export type ScopeSelector = typeof ScopeSelector.Type

export const SkillDefinition = Schema.Struct({
  kind: Schema.Literal("skill"),
  name: DisplayName,
  description: Description,
  content: SkillContent,
}).annotate({ identifier: "ProjectArtifact.SkillDefinition" })
export type SkillDefinition = typeof SkillDefinition.Type
export const CommandDefinition = Schema.Struct({
  kind: Schema.Literal("command"),
  name: DisplayName,
  description: Description,
  template: CommandTemplate,
  subtask: Schema.Literal(false),
}).annotate({ identifier: "ProjectArtifact.CommandDefinition" })
export type CommandDefinition = typeof CommandDefinition.Type
export const AgentDefinition = Schema.Struct({
  kind: Schema.Literal("agent"),
  name: DisplayName,
  description: Description,
  system: AgentSystem,
  mode: Schema.Literal("subagent"),
  permissions: Permission.Ruleset,
}).annotate({ identifier: "ProjectArtifact.AgentDefinition" })
export type AgentDefinition = typeof AgentDefinition.Type
export const PluginDefinition = Schema.Struct({
  kind: Schema.Literal("plugin"),
  name: DisplayName,
  description: Description,
  draft: PluginDraft,
}).annotate({ identifier: "ProjectArtifact.PluginDefinition" })
export type PluginDefinition = typeof PluginDefinition.Type
export const Definition = Schema.Union([SkillDefinition, CommandDefinition, AgentDefinition, PluginDefinition])
  .pipe(Schema.toTaggedUnion("kind"))
  .annotate({ identifier: "ProjectArtifact.Definition" })
export type Definition = typeof Definition.Type

export const ArtifactKey = Schema.Struct({
  scope: ScopeSelector,
  kind: Kind,
  id: ID,
}).annotate({ identifier: "ProjectArtifact.ArtifactKey" })
export type ArtifactKey = typeof ArtifactKey.Type
export const ProjectArtifactKey = Schema.Struct({
  scope: ProjectScopeSelector,
  kind: Kind,
  id: ID,
}).annotate({ identifier: "ProjectArtifact.ProjectArtifactKey" })
export type ProjectArtifactKey = typeof ProjectArtifactKey.Type
export const ArtifactIdentity = Schema.Struct({
  scopeID: ScopeID,
  kind: Kind,
  id: ID,
}).annotate({ identifier: "ProjectArtifact.ArtifactIdentity" })
export type ArtifactIdentity = typeof ArtifactIdentity.Type
export const ArtifactVersionIdentity = Schema.Struct({
  ...ArtifactIdentity.fields,
  versionID: VersionID,
}).annotate({ identifier: "ProjectArtifact.ArtifactVersionIdentity" })
export type ArtifactVersionIdentity = typeof ArtifactVersionIdentity.Type

export const Provenance = Schema.Struct({
  source: Source,
  creatorAgentID: Agent.ID.pipe(optional),
  creatorSessionID: Session.ID.pipe(optional),
  insightDigest: Digest.pipe(optional),
  originScopeID: ScopeID.pipe(optional),
  originVersionID: VersionID.pipe(optional),
  originEvidenceDigest: Digest.pipe(optional),
}).annotate({ identifier: "ProjectArtifact.Provenance" })
export type Provenance = typeof Provenance.Type
export const VersionState = Schema.Literals(["trial", "active", "degraded", "disabled", "quarantine", "superseded"]).annotate({
  identifier: "ProjectArtifact.VersionState",
})
export type VersionState = typeof VersionState.Type
export const Version = Schema.Struct({
  id: VersionID,
  parentVersionID: VersionID.pipe(optional),
  state: VersionState,
  contentDigest: Digest,
  contentRelpath: ContentRelpath,
  provenance: Provenance,
  timeCreated: TimestampMillis,
  timeStateChanged: TimestampMillis,
}).annotate({ identifier: "ProjectArtifact.Version" })
export type Version = typeof Version.Type
export const Artifact = Schema.Struct({
  scope: Scope,
  kind: Kind,
  id: ID,
  revision: Revision,
  stage: Stage,
  currentVersionID: VersionID,
  fallbackVersionID: VersionID.pipe(optional),
  shadowedScopeID: ScopeID.pipe(optional),
  lastUsedAt: TimestampMillis.pipe(optional),
  timeCreated: TimestampMillis,
  timeUpdated: TimestampMillis,
}).annotate({ identifier: "ProjectArtifact.Artifact" })
export type Artifact = typeof Artifact.Type
export const ArtifactSummary = Schema.Struct({
  scope: Scope,
  kind: Kind,
  id: ID,
  name: DisplayName,
  description: Description,
  stage: Stage,
  revision: Revision,
  currentVersionID: VersionID,
  currentDigest: Digest,
  lastUsedAt: TimestampMillis.pipe(optional),
  timeUpdated: TimestampMillis,
}).annotate({ identifier: "ProjectArtifact.ArtifactSummary" })
export type ArtifactSummary = typeof ArtifactSummary.Type
export const CollisionDiagnostic = Schema.Struct({
  type: Schema.Literals(["existing-source", "cross-scope", "project-over-global-shadow"]),
  kind: Kind,
  id: ID,
  scopeID: ScopeID.pipe(optional),
  message: Description,
}).annotate({ identifier: "ProjectArtifact.CollisionDiagnostic" })
export type CollisionDiagnostic = typeof CollisionDiagnostic.Type
export const ArtifactDetails = Schema.Struct({
  artifact: Artifact,
  definition: Definition,
  currentVersion: Version,
  versions: Schema.Array(Version),
  diagnostics: Schema.Array(CollisionDiagnostic),
}).annotate({ identifier: "ProjectArtifact.ArtifactDetails" })
export type ArtifactDetails = typeof ArtifactDetails.Type

export const Confidence = Schema.Struct({
  sampleCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  successCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lowerBound: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  upperBound: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  eligible: Schema.Boolean,
})
  .check(
    Schema.makeFilter(
      (value) => value.successCount <= value.sampleCount && value.lowerBound <= value.upperBound,
      {
        expected: "consistent confidence counts and bounds",
        meta: { _tag: "isMaxProperties", maxProperties: 5 },
        arbitrary: { constraint: { maxLength: 5 } },
      },
    ),
  )
  .annotate({ identifier: "ProjectArtifact.Confidence" })
export type Confidence = typeof Confidence.Type
export const Metrics = Schema.Struct({
  score: Schema.Number.check(Schema.isBetween({ minimum: -1, maximum: 1 })),
  confidence: Confidence,
  rewardUnits: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  penaltyUnits: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  lastUsedAt: TimestampMillis.pipe(optional),
}).annotate({ identifier: "ProjectArtifact.Metrics" })
export type Metrics = typeof Metrics.Type
export const Trash = Schema.Struct({
  deletionID: DeletionID,
  scope: Scope,
  kind: Kind,
  id: ID,
  priorStage: Stage,
  priorVersionID: VersionID,
  deletedAt: TimestampMillis,
  purgeAfter: TimestampMillis,
}).check(Schema.makeFilter((value) => value.purgeAfter === value.deletedAt + 30 * 86_400_000, {
  expected: "a purge timestamp exactly 30 days after deletion",
  meta: { _tag: "isMaxProperties", maxProperties: 8 },
  arbitrary: { constraint: { maxLength: 8 } },
})).annotate({
  identifier: "ProjectArtifact.Trash",
})
export type Trash = typeof Trash.Type

export const ActivationID = safeID("ProjectArtifact.ActivationID", "paa")
export type ActivationID = typeof ActivationID.Type
export const ObservationID = safeID("ProjectArtifact.ObservationID", "pao")
export type ObservationID = typeof ObservationID.Type
export const ActivationSource = Schema.Literals([
  "skill-tool",
  "session-skill",
  "command",
  "agent-selected",
  "subagent-launch",
  "manual",
]).annotate({ identifier: "ProjectArtifact.ActivationSource" })
export type ActivationSource = typeof ActivationSource.Type
export const Activation = Schema.Struct({
  id: ActivationID,
  artifact: ArtifactVersionIdentity,
  projectID: Project.ID.pipe(optional),
  sessionID: Session.ID.pipe(optional),
  agentID: Agent.ID.pipe(optional),
  source: ActivationSource,
  messageID: Schema.NonEmptyString.pipe(optional),
  callID: Schema.NonEmptyString.pipe(optional),
  boundarySeq: Revision,
  activatedAt: TimestampMillis,
  deactivatedAt: TimestampMillis.pipe(optional),
}).annotate({ identifier: "ProjectArtifact.Activation" })
export type Activation = typeof Activation.Type
export const TerminalOutcome = Schema.Literals(["succeeded", "failed", "interrupted"]).annotate({
  identifier: "ProjectArtifact.TerminalOutcome",
})
export type TerminalOutcome = typeof TerminalOutcome.Type
export const GoalStatus = Schema.Literals(["none", "completed", "stopped", "exhausted"]).annotate({
  identifier: "ProjectArtifact.GoalStatus",
})
export type GoalStatus = typeof GoalStatus.Type
export const Observation = Schema.Struct({
  id: ObservationID,
  artifact: ArtifactVersionIdentity,
  projectID: Project.ID.pipe(optional),
  sessionID: Session.ID.pipe(optional),
  activationSetDigest: Digest,
  activeArtifactCount: Revision,
  externalConfounded: Schema.Boolean,
  eligible: Schema.Boolean,
  terminalOutcome: TerminalOutcome,
  goalStatus: GoalStatus,
  repeatFix: Schema.Boolean,
  latencyMs: TimestampMillis.pipe(optional),
  inputTokens: Revision.pipe(optional),
  outputTokens: Revision.pipe(optional),
  cacheReadTokens: Revision.pipe(optional),
  completedToolCount: Revision.pipe(optional),
  failedToolCount: Revision.pipe(optional),
  terminalMessageID: Schema.NonEmptyString.pipe(optional),
  observedAt: TimestampMillis,
}).annotate({ identifier: "ProjectArtifact.Observation" })
export type Observation = typeof Observation.Type
export const FeedbackAction = Schema.Literals(["disable", "delete", "revert", "restore", "enable", "promote"]).annotate({
  identifier: "ProjectArtifact.FeedbackAction",
})
export type FeedbackAction = typeof FeedbackAction.Type
export const FeedbackActor = Schema.Literals(["user", "automatic-governor"]).annotate({
  identifier: "ProjectArtifact.FeedbackActor",
})
export type FeedbackActor = typeof FeedbackActor.Type
export const Feedback = Schema.Struct({
  artifact: ArtifactVersionIdentity,
  action: FeedbackAction,
  actor: FeedbackActor,
  timeCreated: TimestampMillis,
}).annotate({ identifier: "ProjectArtifact.Feedback" })
export type Feedback = typeof Feedback.Type
export const AutomaticWriteOperation = Schema.Literals(["create", "update", "reconcile"]).annotate({
  identifier: "ProjectArtifact.AutomaticWriteOperation",
})
export type AutomaticWriteOperation = typeof AutomaticWriteOperation.Type
export const AutomaticWriteResult = Schema.Literals(["created", "updated", "reconciled"]).annotate({
  identifier: "ProjectArtifact.AutomaticWriteResult",
})
export type AutomaticWriteResult = typeof AutomaticWriteResult.Type
export const AutomaticWrite = Schema.Struct({
  scopeID: ScopeID,
  sessionID: Session.ID,
  insightDigest: Digest,
  operation: AutomaticWriteOperation,
  result: AutomaticWriteResult,
  versionID: VersionID,
  contentDigest: Digest,
  timeCreated: TimestampMillis,
}).annotate({ identifier: "ProjectArtifact.AutomaticWrite" })
export type AutomaticWrite = typeof AutomaticWrite.Type

const MutationExpectation = {
  expectedRevision: Revision,
  expectedVersionID: VersionID,
  expectedDigest: Digest,
}
export const CreateRequest = Schema.Struct({
  key: ArtifactKey,
  definition: Definition,
})
  .check(Schema.makeFilter((value) => value.key.kind === value.definition.kind, {
    expected: "matching key and definition kinds",
    meta: { _tag: "isMaxProperties", maxProperties: 2 },
    arbitrary: { constraint: { maxLength: 2 } },
  }))
  .annotate({ identifier: "ProjectArtifact.CreateRequest" })
export const UpdateRequest = Schema.Struct({
  key: ArtifactKey,
  definition: Definition,
  ...MutationExpectation,
})
  .check(Schema.makeFilter((value) => value.key.kind === value.definition.kind, {
    expected: "matching key and definition kinds",
    meta: { _tag: "isMaxProperties", maxProperties: 5 },
    arbitrary: { constraint: { maxLength: 5 } },
  }))
  .annotate({ identifier: "ProjectArtifact.UpdateRequest" })
export type UpdateRequest = typeof UpdateRequest.Type
export const DeleteRequest = Schema.Struct({
  key: ArtifactKey,
  ...MutationExpectation,
}).annotate({ identifier: "ProjectArtifact.DeleteRequest" })
export type DeleteRequest = typeof DeleteRequest.Type
export const RestoreRequest = Schema.Struct({
  deletionID: DeletionID,
}).annotate({ identifier: "ProjectArtifact.RestoreRequest" })
export type RestoreRequest = typeof RestoreRequest.Type
export const ListRequest = Schema.Struct({
  scope: ScopeSelector,
  kind: Kind.pipe(optional),
  stage: Stage.pipe(optional),
}).annotate({ identifier: "ProjectArtifact.ListRequest" })
export type ListRequest = typeof ListRequest.Type
export const PromotionPreviewRequest = Schema.Struct({
  key: ProjectArtifactKey,
  ...MutationExpectation,
}).annotate({ identifier: "ProjectArtifact.PromotionPreviewRequest" })
export type PromotionPreviewRequest = typeof PromotionPreviewRequest.Type
export const PromotionConfirmRequest = Schema.Struct({
  token: ConfirmationToken,
}).annotate({ identifier: "ProjectArtifact.PromotionConfirmRequest" })
export type PromotionConfirmRequest = typeof PromotionConfirmRequest.Type
export const PromotionPreview = Schema.Struct({
  artifact: ArtifactSummary,
  metrics: Metrics,
  destination: GlobalScope,
  risk: Schema.Literals(["declarative", "executable"]),
  renderedContent: RenderedContent,
  collision: CollisionDiagnostic.pipe(optional),
  token: ConfirmationToken,
  expiresAt: TimestampMillis,
}).annotate({ identifier: "ProjectArtifact.PromotionPreview" })
export type PromotionPreview = typeof PromotionPreview.Type

export const ErrorCode = Schema.Literals([
  "ProjectIdentityUnavailable",
  "InvalidArtifact",
  "UnsafeContent",
  "UnsupportedKind",
  "InvalidScope",
  "ArtifactNotFound",
  "VersionNotFound",
  "DeletionNotFound",
  "ArtifactCollision",
  "ScopeCollision",
  "VersionConflict",
  "OwnershipMismatch",
  "DestinationExists",
  "ProjectAdoptionConflict",
  "ConfirmationExpired",
  "TrashExpired",
  "ContentTooLarge",
  "ScopeQuotaExceeded",
  "WriteRateExceeded",
  "ArtifactCooldown",
  "StorageUnavailable",
  "LockTimeout",
  "ReconciliationRequired",
]).annotate({ identifier: "ProjectArtifact.ErrorCode" })
export type ErrorCode = typeof ErrorCode.Type
export const ValidationError = Schema.Struct({
  code: ErrorCode,
  message: Description,
  field: Schema.NonEmptyString.pipe(optional),
}).annotate({ identifier: "ProjectArtifact.ValidationError" })
export type ValidationError = typeof ValidationError.Type
export const UnsupportedKindError = Schema.Struct({
  code: Schema.Literal("UnsupportedKind"),
  kind: Kind,
  message: Description,
}).annotate({ identifier: "ProjectArtifact.UnsupportedKindError" })
export type UnsupportedKindError = typeof UnsupportedKindError.Type
