import { Cause, DateTime, Effect, Layer, Option, Schema, Context, Stream, Scope } from "effect"
import { ListAnchor } from "@ycoding-ai/schema/session"
import { History } from "@ycoding-ai/schema/session-compaction"
import { Event } from "@ycoding-ai/schema/event"
import type { Model } from "@ycoding-ai/schema/model"
import { Money } from "@ycoding-ai/schema/money"
import { ID, type Admission, type Result } from "@ycoding-ai/schema/session-compaction"
import { and, asc, desc, eq, gt, gte, inArray, isNull, like, lt, or, sql, type SQL } from "drizzle-orm"
import { Project } from "../project"
import { CoordinationService } from "../coordination/index"
import { Workspace } from "../workspace"
import { CatalogModel } from "../model"
import { Provider } from "../provider"
import { Location } from "../location"
import { SessionMessage } from "./message"
import { InstructionState } from "./instruction-state"
import { SessionPermissionCeiling } from "./permission-ceiling"
import { SessionProviderRequest } from "./provider-request"
import { SessionUsage } from "./usage"
import { SessionCacheDiagnostics } from "./cache-diagnostics"
import { SessionUsageRead, type Aggregate, type PricingRef } from "./usage-read"
import { SessionUsagePricing } from "./usage-pricing"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import type { UsageAccounting } from "@ycoding-ai/schema/usage-accounting"
import type { UsageAnchor } from "@ycoding-ai/schema/usage-anchor"
import { SessionUsageAttribution } from "./usage-attribution"
import { RetentionSettings } from "../retention-settings"
import { SqlError } from "effect/unstable/sql/SqlError"
import { SessionAutonomy } from "./autonomy"
import type { DecisionMode } from "@ycoding-ai/schema/session-autonomy"
import { SessionCompactionJob } from "./compaction-job"
import { SessionCompactionExecution } from "./compaction-execution"
import { SessionCompaction } from "./compaction"
import { SessionContextState } from "./context-state"
import { Info } from "./skill-status"
import { SessionGoal } from "./goal"
import { SessionGuardrail } from "./guardrail"
import { Base64, FileAttachment, ManagedAttachmentContent, Prompt } from "@ycoding-ai/schema/prompt"
import { PromptInput } from "@ycoding-ai/schema/prompt-input"
import { EventRuntime } from "../event"
import { EventTable } from "../event/sql"
import { Database } from "../database/database"
import { SessionProjector } from "./projector"
import { SessionContextExclusionCleanup } from "./context-exclusion-cleanup"
import { SessionFileChangeCleanup } from "./file-change-cleanup"
import { SessionUsageCleanup } from "./usage-cleanup"
import {
  SessionFileChangeTable,
  SessionMessageTable,
  SessionPendingTable,
  SessionTable,
  SessionTaskNotificationTable,
  SessionTaskTable,
} from "./sql"
import { SessionSchema } from "./schema"
import { AbsolutePath, PositiveInt, RelativePath } from "../schema"
import { Agent } from "../agent"
import { ProjectTable } from "../project/sql"
import path from "path"
import { fromRow } from "./info"
import { SessionRunner } from "./runner/index"
import { SessionStore } from "./store"
import { SessionExecution } from "./execution"
import {
  AgentNotFoundError,
  AgentNotSelectableError,
  AttachmentReadError,
  HistoryPrunedError,
  InvalidCursorError,
  MessageDecodeError,
  NotFoundError,
} from "./error"
import { makeGlobalNode } from "../effect/app-node"
import { KeepAwake } from "../keep-awake"
import { LocationServiceMap } from "../location-service-map"
import { SessionEvent } from "./event"
import { SessionPending } from "./pending"
import { SessionSharedContext } from "./shared-context"
import { SessionGenerate } from "./generate"
import { Snapshot } from "../snapshot"
import { SessionRevert } from "./revert"
import { Session } from "@ycoding-ai/schema/session"
import { FSUtil } from "../fs-util"
import { Image } from "../image"
import { InstructionDiscovery } from "../instruction-discovery"
import { Instructions } from "../instructions"
import { Mime } from "../mime"
import type { EventLog } from "@ycoding-ai/schema/event-log"
import { Skill } from "../skill"
import { SessionSkill } from "./skill"
import { Permission } from "../permission"
import { Job } from "../job"
import { SessionCompletion } from "./completion"
import { Command } from "../command"
import { Shell } from "../shell"
import { ShellLedger } from "../shell/ledger"
import { SessionTask } from "./task"
import { ShellSandbox } from "../shell-sandbox"
import { Global } from "../global"
import type { Info as ShellInfo } from "@ycoding-ai/schema/shell"
import { KeyedMutex } from "../effect/keyed-mutex"
import { fileURLToPath } from "url"
import { randomUUID } from "crypto"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { ProjectArtifactAccounting } from "../project-artifact/accounting"
import { ProjectArtifactStore } from "../project-artifact"
import { ProjectArtifactSource } from "../project-artifact/source"
import { SessionModelSwitch } from "./model-switch"
import { SessionHistory } from "./history"
import { SessionContextBudget } from "./context-budget"
import { SessionRunnerModel } from "./runner/model"
import { Catalog } from "../catalog"
import { Config } from "../config"
import { ConfigCompaction } from "../config/compaction"
import { AttachmentStore } from "../attachment-store"
import { Form } from "../form"
import { Question } from "../question"
import { SessionReviewFold } from "./review-fold"
import { SessionOrchestration } from "@ycoding-ai/schema/session-orchestration"

export const RevertState = Session.Revert
export type RevertState = Session.Revert

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export { ListAnchor }

const ListInputBase = {
  workspaceID: Workspace.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  parentID: Schema.NullOr(SessionSchema.ID).pipe(Schema.optional),
  anchor: ListAnchor.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: Project.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

type CreateBaseInput = {
  id?: SessionSchema.ID
  title?: string
  agent?: Agent.ID
  model?: CatalogModel.Ref
  profileBinding?: SessionEvent.ProfileBinding
  permissionCeiling?: SessionSchema.Info["permissionCeiling"]
  native?: { readonly validate: () => Effect.Effect<boolean> }
}
type CreateInput = CreateBaseInput &
  ({ location: Location.Ref; parentID?: never } | { parentID: SessionSchema.ID; location?: never })

type CompactBaseInput = {
  id?: ID
  sessionID: SessionSchema.ID
}
export type AdvisorCompactInput = CompactBaseInput & {
  trigger: "consider" | "advised"
  estimatedInputTokens?: number
}
export type ManualCompactInput = CompactBaseInput & { trigger?: never }
type CompactInput = AdvisorCompactInput | ManualCompactInput

interface Compact {
  (input: AdvisorCompactInput): Effect.Effect<Admission | undefined, NotFoundError | CompactionConflictError>
  (input: ManualCompactInput): Effect.Effect<Result, NotFoundError | CompactionConflictError>
}

type ForkInput = {
  sessionID: SessionSchema.ID
  messageID?: SessionMessage.ID
}

type AutonomyInput = {
  sessionID: SessionSchema.ID
  permissions?: DecisionMode
  guardrails?: DecisionMode
  answers?: DecisionMode
  /** A string calculates and replaces the objective; true resumes the retained one; null stops it. */
  goal?: string | null | true
  maxNoProgress?: number
  sleep?: boolean
}

export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "Session.OperationUnavailableError",
  {
    operation: Schema.Literals(["move", "skill", "switchAgent", "compact"]),
  },
) {}

export { AttachmentReadError, HistoryPrunedError, InvalidCursorError, MessageDecodeError, NotFoundError }

const decisionAgents: ReadonlySet<Agent.ID> = new Set(["decision", "yolo-permission", "yolo-guardrail", "yolo-answer"].map((id) => Agent.ID.make(id)))

export const MaxAttachmentReadBytes = 10 * 1024 * 1024
const CompactionHistoryLimit = 100

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {
  override get message() {
    return `Prompt message ID conflicts with an existing durable record: ${this.messageID} (retry with a fresh ID; your draft is preserved in the composer)`
  }
}
export class SyntheticConflictError extends Schema.TaggedErrorClass<SyntheticConflictError>()(
  "Session.SyntheticConflictError",
  {
    sessionID: SessionSchema.ID,
    inputID: SessionMessage.ID,
  },
) {
  override get message() {
    return `Synthetic input conflicts with an existing durable record: ${this.inputID} (retry with a fresh ID)`
  }
}
export class AttachmentError extends Schema.TaggedErrorClass<AttachmentError>()("Session.AttachmentError", {
  uri: Schema.String,
  message: Schema.String,
}) {}
export class CompactionConflictError extends Schema.TaggedErrorClass<CompactionConflictError>()(
  "Session.CompactionConflictError",
  {
    sessionID: SessionSchema.ID,
    jobID: ID,
    message: Schema.String,
  },
) {}
export class BusyError extends Schema.TaggedErrorClass<BusyError>()("Session.BusyError", {
  sessionID: SessionSchema.ID,
}) {}
export class SkillNotFoundError extends Schema.TaggedErrorClass<SkillNotFoundError>()("Session.SkillNotFoundError", {
  skill: Skill.ID,
}) {}
export class SkillConflictNotFoundError extends Schema.TaggedErrorClass<SkillConflictNotFoundError>()(
  "Session.SkillConflictNotFoundError",
  {
    winner: Skill.ID,
    loser: Skill.ID,
  },
) {}

export class DestinationNotFoundError extends Schema.TaggedErrorClass<DestinationNotFoundError>()(
  "Session.DestinationNotFoundError",
  { directory: AbsolutePath },
) {}

export class DestinationNotDirectoryError extends Schema.TaggedErrorClass<DestinationNotDirectoryError>()(
  "Session.DestinationNotDirectoryError",
  { directory: AbsolutePath },
) {}
export const MessageNotFoundError = SessionRevert.MessageNotFoundError
export type MessageNotFoundError = SessionRevert.MessageNotFoundError

export type Error =
  | NotFoundError
  | AgentNotFoundError
  | AgentNotSelectableError
  | MessageDecodeError
  | OperationUnavailableError
  | PromptConflictError
  | SyntheticConflictError
  | AttachmentError
  | CompactionConflictError
  | BusyError
  | SkillNotFoundError
  | SkillConflictNotFoundError
  | DestinationNotFoundError
  | DestinationNotDirectoryError
  | Command.NotFoundError
  | Command.EvaluationError
  | MessageNotFoundError
  | HistoryPrunedError
  | SessionGenerate.Error

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<{
    readonly data: SessionSchema.Info[]
  }>
  readonly create: (
    input: CreateInput,
  ) => Effect.Effect<SessionSchema.Info, NotFoundError | AgentNotSelectableError | SessionRunnerModel.Error>
  readonly fork: (
    input: ForkInput,
  ) => Effect.Effect<SessionSchema.Info, NotFoundError | MessageNotFoundError | HistoryPrunedError>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly snapshot: (
    sessionID: SessionSchema.ID,
    options?: { readonly limit?: number; readonly before?: string },
  ) => Effect.Effect<
    {
      readonly session: SessionSchema.Info
      readonly messages: SessionMessage.Info[]
      readonly watermark: EventLog.Synced
      readonly before?: string
      readonly generationSpeed?: NonNullable<Session.CacheDiagnostics["generationSpeed"]>
    },
    NotFoundError | MessageDecodeError | InvalidCursorError
  >
  readonly attachmentRead: (
    sessionID: SessionSchema.ID,
    digest: string,
  ) => Effect.Effect<
    { readonly mime: string; readonly bytes: number; readonly data: string },
    NotFoundError | AttachmentReadError
  >
  readonly compactionHistory: (sessionID: SessionSchema.ID) => Effect.Effect<History, NotFoundError>
  readonly remove: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly archive: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly unarchive: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly pin: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly unpin: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly messages: (input: {
    sessionID: SessionSchema.ID
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      direction: "previous" | "next"
    }
    retained?: boolean
  }) => Effect.Effect<SessionMessage.Info[], NotFoundError | MessageDecodeError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Info | undefined>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Info[], NotFoundError | MessageDecodeError>
  readonly fileChanges: (sessionID: SessionSchema.ID) => Effect.Effect<SessionEvent.FileChange.Info[], NotFoundError>
  readonly skills: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<Info[], NotFoundError | AgentNotFoundError | MessageDecodeError>
  /**
   * Durable admitted session work not yet visible in projected history,
   * ordered by admission. Includes unpromoted user and synthetic inputs and
   * unhandled compaction barriers.
   */
  readonly pending: (sessionID: SessionSchema.ID) => Effect.Effect<SessionPending.Info[], NotFoundError>
  /**
   * Durable, ordered session log read. Replays durable session events after
   * the exclusive `after` cursor, emits a `Synced` marker at the captured
   * replay watermark, then continues live when `follow` is set.
   * The marker's seq may exceed the last emitted event because other durable
   * events share the aggregate's sequence space.
   */
  readonly log: (input: {
    sessionID: SessionSchema.ID
    after?: number
    follow?: boolean
  }) => Stream.Stream<SessionEvent.PublicDurableEvent | EventLog.Synced, NotFoundError>
  readonly switchAgent: (input: {
    sessionID: SessionSchema.ID
    agent: Agent.ID
  }) => Effect.Effect<void, NotFoundError | AgentNotSelectableError>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: CatalogModel.Ref
  }) => Effect.Effect<
    SessionModelSwitch.Outcome,
    NotFoundError | MessageDecodeError | SessionRunnerModel.Error | CompactionConflictError
  >
  readonly selectModelAtBoundary: (input: {
    sessionID: SessionSchema.ID
    expectedModel: CatalogModel.Ref
    model: CatalogModel.Ref
    connectionIdentityDigest: string
    targetBinding?: SessionEvent.ProfileBinding
    expectedBinding?: SessionEvent.ProfileBinding | null
    guard: Effect.Effect<boolean>
  }) => Effect.Effect<
    SessionModelSwitch.Outcome | { readonly status: "conflict" },
    NotFoundError | MessageDecodeError | SessionRunnerModel.Error | CompactionConflictError
  >
  readonly rename: (input: { sessionID: SessionSchema.ID; title: string }) => Effect.Effect<void, NotFoundError>
  readonly daybreak: {
    readonly set: (input: {
      sessionID: SessionSchema.ID
      daybreak: Model.Daybreak | null
    }) => Effect.Effect<SessionSchema.Info, NotFoundError>
  }
  readonly move: (input: {
    sessionID: SessionSchema.ID
    directory: AbsolutePath
    workspaceID?: Location.Ref["workspaceID"]
  }) => Effect.Effect<void, NotFoundError | DestinationNotFoundError | DestinationNotDirectoryError>
  readonly prompt: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    text: string
    origin?: "subagent" | "plugin" | "review"
    files?: PromptInput.Prompt["files"]
    agents?: PromptInput.Prompt["agents"]
    metadata?: Record<string, unknown>
    sharedContext?: SessionSharedContext.Snapshot
    delivery?: SessionPending.Delivery
    resume?: boolean
    causedBy?: UsageAnchor.Ref
    native?: { readonly source: Form.NativeReplySource; readonly validate: () => Effect.Effect<boolean> }
  }) => Effect.Effect<SessionPending.User, NotFoundError | PromptConflictError | AttachmentError>
  /** Generates text from current Session context without admitting input or mutating history. */
  readonly generate: (input: {
    sessionID: SessionSchema.ID
    prompt: string
  }) => Effect.Effect<string, NotFoundError | SessionGenerate.Error>
  readonly diagnostics: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<Session.CacheDiagnostics | undefined, NotFoundError | MessageDecodeError>
  readonly usage: (sessionID: SessionSchema.ID) => Effect.Effect<ProviderRequest.Summary, NotFoundError>
  readonly usageReport: (
    input: ProviderRequest.ReportInput & { readonly sessionID: SessionSchema.ID },
  ) => Effect.Effect<ProviderRequest.Report, NotFoundError>
  readonly usageAll: () => Effect.Effect<ProviderRequest.Summary>
  readonly usageReportAll: (input: ProviderRequest.ReportInput) => Effect.Effect<ProviderRequest.Report>
  readonly promptCosts: (
    input: UsageAccounting.PromptInput & { readonly sessionID: SessionSchema.ID },
  ) => Effect.Effect<UsageAccounting.PromptCosts, NotFoundError>
  readonly taskCosts: (
    input: UsageAccounting.TaskInput & { readonly sessionID: SessionSchema.ID },
  ) => Effect.Effect<UsageAccounting.TaskCosts, NotFoundError>
  readonly autonomy: {
    readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionAutonomy.State, NotFoundError>
    readonly set: (input: AutonomyInput) => Effect.Effect<SessionAutonomy.State, NotFoundError | SessionGoal.Error>
    readonly effective: (sessionID: SessionSchema.ID) => Effect.Effect<SessionAutonomy.Effective, NotFoundError>
  }
  readonly command: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    command: string
    arguments?: string
    origin?: "subagent" | "plugin"
    agent?: Agent.ID
    model?: CatalogModel.Ref
    files?: PromptInput.Prompt["files"]
    agents?: PromptInput.Prompt["agents"]
    delivery?: SessionPending.Delivery
    resume?: boolean
  }) => Effect.Effect<
    SessionPending.User,
    NotFoundError | PromptConflictError | AttachmentError | Command.NotFoundError | Command.EvaluationError
  >
  readonly shell: (input: {
    id?: EventRuntime.ID
    sessionID: SessionSchema.ID
    command: string
  }) => Effect.Effect<
    void,
    | NotFoundError
    | ShellSandbox.Unavailable
    | Shell.MemoryLimitUnavailable
    | Shell.SpawnError
    | SessionGuardrail.AssertError
  >
  readonly skill: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    skill: Skill.ID
    resume?: boolean
  }) => Effect.Effect<void, NotFoundError | SkillNotFoundError>
  readonly resolveSkillConflict: (input: {
    sessionID: SessionSchema.ID
    winner: Skill.ID
    loser: Skill.ID
  }) => Effect.Effect<void, NotFoundError | AgentNotFoundError | MessageDecodeError | SkillConflictNotFoundError>
  readonly compact: Compact
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly completions: (input: {
    readonly after?: SessionSchema.ID
    readonly limit: number
  }) => Effect.Effect<Effect.Success<ReturnType<typeof SessionCompletion.latest>>>
  readonly outstanding: (includeFailures?: boolean) => Effect.Effect<{
    readonly sessions: ReadonlySet<SessionSchema.ID>
    readonly running: ReadonlySet<SessionSchema.ID>
    readonly failed: ReadonlySet<SessionSchema.ID>
    readonly lost: ReadonlySet<SessionSchema.ID>
  }>
  readonly background: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly synthetic: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    text: string
    description?: string
    metadata?: Record<string, unknown>
    delivery?: SessionPending.Delivery
    resume?: boolean
    causedBy?: UsageAnchor.Ref
  }) => Effect.Effect<SessionPending.Synthetic, NotFoundError | SyntheticConflictError>
  readonly revert: {
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<
      Session.Revert,
      NotFoundError | MessageNotFoundError | HistoryPrunedError | BusyError | Snapshot.Error
    >
    readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | BusyError | Snapshot.Error>
    readonly commit: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | BusyError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/Session") {}

function usageReportGroup(
  group: ProviderRequest.ReportGroup,
  item: {
    readonly record: Pick<SessionProviderRequest.CostedRecord, "model" | "agent" | "time" | "usageAnchor">
    readonly session: Pick<SessionSchema.Info, "id" | "title" | "projectID">
    readonly taskID?: SessionSchema.ID
  },
  projects: ReadonlyArray<Project.Info>,
  formatter?: Intl.DateTimeFormat,
) {
  if (group === "provider")
    return { key: JSON.stringify([group, item.record.model.providerID]), label: item.record.model.providerID }
  if (group === "provider-profile-model")
    return {
      key: JSON.stringify([
        group,
        item.record.model.providerID,
        item.record.model.profile ?? null,
        item.record.model.id,
      ]),
      label: `${item.record.model.providerID}/${item.record.model.id} · ${item.record.model.profile ?? "Provider default"}`,
    }
  if (group === "provider-model")
    return {
      key: JSON.stringify([group, item.record.model.providerID, item.record.model.id]),
      label: `${item.record.model.providerID}/${item.record.model.id}`,
    }
  if (group === "model-id") return { key: JSON.stringify([group, item.record.model.id]), label: item.record.model.id }
  if (group === "profile")
    return {
      key: JSON.stringify([group, item.record.model.providerID, item.record.model.profile ?? null]),
      label: `${item.record.model.providerID} · ${item.record.model.profile ?? "Provider default"}`,
    }
  if (group === "prompt")
    return {
      key: JSON.stringify([
        group,
        item.record.usageAnchor?.sessionID ?? null,
        item.record.usageAnchor?.inputID ?? null,
      ]),
      label: item.record.usageAnchor?.inputID ?? "Unattributed",
    }
  if (group === "task")
    return { key: JSON.stringify([group, item.taskID ?? null]), label: item.taskID ?? "Main Session / unattributed" }
  if (group === "model") {
    const variant = item.record.model.variant
    return {
      key: [item.record.model.providerID, item.record.model.id, variant, item.record.model.profile]
        .flatMap((part) => (part === undefined ? [] : [part]))
        .map((part) => encodeURIComponent(part))
        .join("/"),
      label: `${item.record.model.providerID}/${item.record.model.id}${variant ? ` (${variant})` : ""}${item.record.model.profile ? ` · ${item.record.model.profile}` : ""}`,
    }
  }
  if (group === "session") return { key: item.session.id, label: item.session.title }
  if (group === "project") {
    if (item.session.projectID === Project.ID.global)
      return { key: item.session.projectID, label: "Global (no project)" }
    const project = projects.find((project) => project.id === item.session.projectID)
    return {
      key: item.session.projectID,
      label: project
        ? project.name
          ? `${project.name} · ${project.worktree}`
          : project.worktree
        : item.session.projectID,
    }
  }
  if (group === "agent") return { key: item.record.agent, label: item.record.agent }
  const iso = new Date(DateTime.toEpochMillis(item.record.time)).toISOString()
  if (formatter) {
    const parts = formatter.formatToParts(DateTime.toEpochMillis(item.record.time))
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? ""
    const date = `${part("year")}-${part("month")}-${part("day")}`
    if (group === "day") return { key: date, label: date }
    if (group === "month") return { key: date.slice(0, 7), label: date.slice(0, 7) }
    const offset = part("timeZoneName").replace("GMT", "") || "+00:00"
    return { key: `${date}T${part("hour")}:00:00${offset}`, label: `${date}T${part("hour")}:00 ${offset}` }
  }
  if (group === "hour") return { key: `${iso.slice(0, 13)}:00:00.000Z`, label: `${iso.slice(0, 13)}:00 UTC` }
  if (group === "day") return { key: iso.slice(0, 10), label: iso.slice(0, 10) }
  return { key: iso.slice(0, 7), label: iso.slice(0, 7) }
}

function combineUsage(
  left: ProviderRequest.ReportMetrics,
  right: ProviderRequest.ReportMetrics,
): ProviderRequest.ReportMetrics {
  return {
    logical: left.logical + right.logical,
    physical: left.physical + right.physical,
    helpers: left.helpers + right.helpers,
    continued: left.continued + right.continued,
    fallback: left.fallback + right.fallback,
    tokens: {
      input: left.tokens.input + right.tokens.input,
      output: left.tokens.output + right.tokens.output,
      reasoning: left.tokens.reasoning + right.tokens.reasoning,
      cache: {
        read: left.tokens.cache.read + right.tokens.cache.read,
        write: left.tokens.cache.write + right.tokens.cache.write,
      },
    },
    ...(left.cost === undefined && right.cost === undefined
      ? {}
      : {
          cost: Money.USD.make((left.cost ?? 0) + (right.cost ?? 0)),
          costProvenance:
            left.costProvenance === "current_catalog" || right.costProvenance === "current_catalog"
              ? "current_catalog"
              : "recorded",
        }),
    ...(left.logical + right.logical === 0
      ? {}
      : {
          cacheReadReported:
            (left.logical === 0 || left.cacheReadReported === true) &&
            (right.logical === 0 || right.cacheReadReported === true),
        }),
  }
}

function usageMetrics(item: Aggregate): ProviderRequest.ReportMetrics {
  return {
    costCoverage: { pricedRequests: item.priced, unpricedRequests: item.logical - item.priced },
    logical: item.logical,
    physical: item.physical,
    helpers: item.helpers,
    continued: item.continued,
    fallback: item.fallback,
    tokens: {
      input: item.input,
      output: item.output,
      reasoning: item.reasoning,
      cache: { read: item.cacheRead, write: item.cacheWrite },
    },
    ...(item.logical === 0 ? {} : { cacheReadReported: item.cacheReadReported === 1 }),
    ...(item.priced === 0
      ? {}
      : { cost: Money.USD.make(item.cost), costProvenance: item.currentCatalog ? "current_catalog" : "recorded" }),
  }
}

function correctedUsage(
  metrics: ProviderRequest.ReportMetrics,
  cost: number,
  requests: number,
): ProviderRequest.ReportMetrics {
  if (requests === 0) return metrics
  return {
    ...metrics,
    cost: Money.USD.make((metrics.cost ?? 0) + cost),
    costProvenance: "current_catalog",
    ...(metrics.costCoverage
      ? {
          costCoverage: {
            pricedRequests: metrics.costCoverage.pricedRequests + requests,
            unpricedRequests: metrics.costCoverage.unpricedRequests - requests,
          },
        }
      : {}),
  }
}

function reportDimensions(
  group: ProviderRequest.ReportGroup,
  key: string,
): ProviderRequest.ReportDimensions | undefined {
  if (
    !["provider", "provider-profile-model", "provider-model", "model-id", "profile", "prompt", "task"].includes(group)
  )
    return undefined
  const parts = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))))(key)
  const providerID = Provider.ID.make(parts[1] ?? "")
  if (group === "provider") return { group, providerID }
  if (group === "provider-model") return { group, providerID, modelID: CatalogModel.ID.make(parts[2]!) }
  if (group === "model-id") return { group, modelID: CatalogModel.ID.make(parts[1]!) }
  const profile = {
    providerID,
    ...(parts[2] === null
      ? { profileState: "provider-default" as const }
      : { profile: parts[2]!, profileState: "recorded" as const }),
  }
  if (group === "profile") return { group, ...profile }
  if (group === "provider-profile-model") return { group, ...profile, modelID: CatalogModel.ID.make(parts[3]!) }
  if (group === "prompt")
    return parts[1] === null
      ? { group, attribution: "unattributed" }
      : {
          group,
          attribution: "complete",
          anchor: { sessionID: SessionSchema.ID.make(parts[1]!), inputID: SessionMessage.ID.make(parts[2]!) },
        }
  return parts[1] === null
    ? { group: "task", attribution: "unattributed" }
    : { group: "task", attribution: "complete", sessionID: SessionSchema.ID.make(parts[1]!) }
}

function dimensionLabel(dimensions: ProviderRequest.ReportDimensions) {
  if (dimensions.group === "provider") return dimensions.providerID
  if (dimensions.group === "model-id") return dimensions.modelID
  if (dimensions.group === "provider-model") return `${dimensions.providerID}/${dimensions.modelID}`
  if (dimensions.group === "profile") return `${dimensions.providerID} · ${dimensions.profile ?? "Provider default"}`
  if (dimensions.group === "provider-profile-model")
    return `${dimensions.providerID}/${dimensions.modelID} · ${dimensions.profile ?? "Provider default"}`
  if (dimensions.group === "prompt") return dimensions.anchor?.inputID ?? "Unattributed"
  return dimensions.sessionID ?? "Main Session / unattributed"
}

function accountingBucket() {
  return {
    requests: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    known: 0,
    priced: 0,
    unpriced: 0,
    catalog: false,
  }
}

function addAccounting(
  bucket: ReturnType<typeof accountingBucket>,
  record: Parameters<typeof usagePrice>[1]["record"],
  cost: number | undefined,
  catalog: boolean,
) {
  bucket.requests += 1
  bucket.tokens.input += record.tokens.input
  bucket.tokens.output += record.tokens.output
  bucket.tokens.reasoning += record.tokens.reasoning
  bucket.tokens.cache.read += record.tokens.cache.read
  bucket.tokens.cache.write += record.tokens.cache.write
  if (cost === undefined) {
    bucket.unpriced += 1
    return
  }
  bucket.known += cost
  bucket.priced += 1
  bucket.catalog ||= catalog
}

function accountingBreakdown(
  bucket: ReturnType<typeof accountingBucket>,
  complete: boolean,
): UsageAccounting.Breakdown {
  return {
    requests: bucket.requests,
    tokens: bucket.tokens,
    cost: {
      pricedRequests: bucket.priced,
      unpricedRequests: bucket.unpriced,
      ...(bucket.priced === 0
        ? {}
        : {
            known: Money.USD.make(bucket.known),
            provenance: bucket.catalog ? ("current_catalog" as const) : ("recorded" as const),
            ...(complete && bucket.unpriced === 0 ? { total: Money.USD.make(bucket.known) } : {}),
          }),
    },
  }
}

function accountingUnit() {
  return {
    total: accountingBucket(),
    main: accountingBucket(),
    children: accountingBucket(),
    helpers: new Map<ProviderRequest.Source, ReturnType<typeof accountingBucket>>(),
  }
}

function addUnit(
  unit: ReturnType<typeof accountingUnit>,
  row: Parameters<typeof usagePrice>[1] & { readonly record: { readonly source: ProviderRequest.Source } },
  main: boolean,
  cost: number | undefined,
) {
  const catalog = cost !== undefined && !("cost" in row.record && row.record.cost !== null)
  addAccounting(unit.total, row.record, cost, catalog)
  addAccounting(main ? unit.main : unit.children, row.record, cost, catalog)
  if (row.record.source === "step") return
  const helper = unit.helpers.get(row.record.source) ?? accountingBucket()
  unit.helpers.set(row.record.source, helper)
  addAccounting(helper, row.record, cost, catalog)
}

function unitBreakdown(unit: ReturnType<typeof accountingUnit>, complete: boolean) {
  return {
    total: accountingBreakdown(unit.total, complete),
    main: accountingBreakdown(unit.main, complete),
    children: accountingBreakdown(unit.children, complete),
    helpers: [...unit.helpers]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([source, value]) => ({ source, ...accountingBreakdown(value, complete) })),
  }
}

type UsagePricing = SessionUsagePricing.Snapshot

function usagePrice(
  pricing: UsagePricing,
  item: Pick<
    Effect.Success<ReturnType<typeof SessionUsageRead.unpriced>>["rows"][number],
    "directory" | "workspaceID"
  > & {
    readonly record: Pick<
      Effect.Success<ReturnType<typeof SessionUsageRead.unpriced>>["rows"][number]["record"],
      "model" | "tokens"
    >
  },
) {
  const record = item.record
  const options = pricing.get(
    JSON.stringify([
      item.directory,
      item.workspaceID,
      record.model.providerID,
      record.model.id,
      record.model.profile ?? null,
    ]),
  )
  return options ? SessionUsage.estimatedCatalogCost(options.provider, options.router, record.tokens)?.cost : undefined
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const usageDb = database.reader ?? db
    const events = yield* EventRuntime.Service
    const projects = yield* Project.Service
    const coordination = yield* CoordinationService.Service
    const global = yield* Global.Service
    const execution = yield* SessionExecution.Service
    const autonomy = yield* SessionAutonomy.Service
    const keepAwake = yield* KeepAwake.Service
    const compactionJobs = yield* SessionCompactionJob.Service
    const compactionExecution = yield* SessionCompactionExecution.Service
    const contextState = yield* SessionContextState.Service
    const store = yield* SessionStore.Service
    const providerRequests = yield* SessionProviderRequest.Service
    const overlayGeneration = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      diagnostics: Session.CacheDiagnostics | undefined,
      historical: boolean,
    ) {
      if (historical) return diagnostics
      const active = yield* providerRequests.generation(sessionID)
      if (!active) return diagnostics
      const history = diagnostics?.generationSpeed
      const same = history?.model?.providerID === active.model.providerID && history.model.id === active.model.id
      const generationSpeed = same && history
        ? { ...history, model: active.model, live: active.live }
        : { ...SessionCacheDiagnostics.generationSpeed(yield* providerRequests.recentSteps(sessionID, active.model), { model: active.model })!, live: active.live }
      const base = diagnostics ?? SessionCacheDiagnostics.calculate({
        model: active.model, tokens: SessionUsage.tokens(undefined), estimatedCost: Money.USD.zero,
      })
      return { ...base, generationSpeed }
    })
    const retentionSettings = yield* RetentionSettings.Service
    const locations = yield* LocationServiceMap.Service
    const fs = yield* FSUtil.Service
    const attachments = yield* AttachmentStore.Service
    const jobs = yield* Job.Service
    const projectArtifactAccounting = yield* ProjectArtifactAccounting.Service
    const projectArtifactStore = yield* ProjectArtifactStore.Service
    const scope = yield* Scope.Scope
    yield* Effect.gen(function* () {
      const rows = yield* db
        .select({ id: SessionTable.id, autonomy: SessionTable.autonomy })
        .from(SessionTable)
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        if (SessionAutonomy.read(row.autonomy).sleep) yield* keepAwake.hold(row.id)
      }
    })
    const familyAutonomyLocks = KeyedMutex.makeUnsafe<SessionSchema.ID>()
    const activeShells = new Set<SessionSchema.ID>()
    const shellLocks = KeyedMutex.makeUnsafe<SessionSchema.ID>()
    const commandLocks = KeyedMutex.makeUnsafe<SessionMessage.ID>()
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Info)
    const isPublicDurableSessionEvent = Schema.is(SessionEvent.PublicDurable)
    const projectArtifactSource = Effect.fnUntraced(function* (location: Location.Ref) {
      return yield* ProjectArtifactSource.Service.pipe(
        Effect.map((source): ProjectArtifactSource.Interface | undefined => source),
        Effect.provide(locations.get(location)),
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
    })
    const sameModel = (current: CatalogModel.Ref | undefined, target: CatalogModel.Ref) =>
      current?.providerID === target.providerID &&
      current.id === target.id &&
      current.variant === target.variant &&
      current.profile === target.profile
    const compactionPolicy = Effect.fnUntraced(function* (session: SessionSchema.Info) {
      return yield* Config.Service.pipe(
        Effect.provide(locations.get(session.location)),
        Effect.flatMap((config) => config.entries()),
        Effect.map((entries) =>
          ConfigCompaction.resolve(
            entries
              .filter((entry): entry is Config.Document => entry.type === "document")
              .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : [])),
          ),
        ),
      )
    })
    // Context validation for a model switch resolves the target in the Session's
    // Location-scoped registry. The transcript read below is durable database work.
    const checkModelSwitch = Effect.fnUntraced(function* (session: SessionSchema.Info, targetModel: CatalogModel.Ref) {
      const resolution = yield* Effect.gen(function* () {
        const catalog = yield* Catalog.Service.pipe(Effect.provide(locations.get(session.location)))
        const compactions = (yield* Config.Service.pipe(
          Effect.provide(locations.get(session.location)),
          Effect.flatMap((config) => config.entries()),
        ))
          .filter((entry): entry is Config.Document => entry.type === "document")
          .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
        const compaction = ConfigCompaction.resolve(compactions)
        return {
          target: SessionContextBudget.resolveCapabilities(
            yield* catalog.model.available(),
            targetModel.providerID,
            targetModel.id,
            {
              safetyMarginTokens: compaction.contextSafetyMarginTokens,
            },
          ),
          keepRecentMessages: compactions
            .flatMap((info) => (info.keep_recent_messages === undefined ? [] : [info.keep_recent_messages]))
            .at(-1),
        }
      })
      const messages = yield* SessionHistory.forModel(db, session.id)
      return SessionModelSwitch.decide({
        currentModel: session.model,
        targetModel,
        messages,
        // The switch decision must lower history exactly as the target model's request would,
        // including model-specific phase/tool/media lowering.
        model: targetModel,
        target: resolution.target,
        keepRecentMessages: resolution.keepRecentMessages,
      })
    })
    // A switch validates the target through the same Location-scoped resolver the runner uses,
    // before it interrupts anything: an unresolvable target must not cancel valid work. The
    // resolver also applies configured helper-model selection, which the switch never changes.
    const validateModelSwitchTarget = Effect.fnUntraced(function* (
      session: SessionSchema.Info,
      targetModel: CatalogModel.Ref,
    ) {
      return yield* SessionRunnerModel.Service.pipe(
        Effect.provide(locations.get(session.location)),
        Effect.flatMap((models) => models.resolve({ ...session, model: targetModel }, { rebind: true })),
      )
    })
    // The target's safe input budget is catalog data, so it can be checked before any
    // interruption; a nonpositive budget is refused instead of forcing an oversized request.
    const modelSwitchTargetBudget = Effect.fnUntraced(function* (
      session: SessionSchema.Info,
      targetModel: CatalogModel.Ref,
    ) {
      const policy = yield* compactionPolicy(session)
      const catalog = yield* Catalog.Service.pipe(Effect.provide(locations.get(session.location)))
      const target = SessionContextBudget.resolveCapabilities(
        yield* catalog.model.available(),
        targetModel.providerID,
        targetModel.id,
        { safetyMarginTokens: policy.contextSafetyMarginTokens },
      )
      return target === undefined ? undefined : SessionContextBudget.safeInputBudget(target)
    })
    const compactionManifest = (session: SessionSchema.Info) => (job: SessionCompactionJob.Job) =>
      Effect.gen(function* () {
        const compaction = yield* SessionCompaction.Service
        return yield* compaction.manifest(job)
      }).pipe(Effect.provide(locations.get(session.location)))
    // Compaction to fit a smaller switch target. It joins an already-admitted compaction, then
    // admits at most one `mandatory` job at the target safe budget. A mandatory job protects no
    // recent tail, so a first-time switch needs no prior summary. Compaction reduces the context;
    // the switch itself refuses selection afterward unless the reloaded history fits the target.
    const compactForModelSwitch = Effect.fnUntraced(function* (
      session: SessionSchema.Info,
      targetModel: CatalogModel.Ref,
      targetSafeInputTokens: number,
    ) {
      const policy = yield* compactionPolicy(session)
      const configDigest = ConfigCompaction.admissionDigest(policy)
      const manifest = compactionManifest(session)
      return yield* compactionJobs
        .withAdmissionGate(session.id, (admit) =>
          Effect.gen(function* () {
            let admitted = false
            while (true) {
              const active = (yield* compactionJobs.pending(session.id))[0]
              if (active) {
                const settled = yield* compactionExecution.run({ jobID: active.id, manifest })
                if (settled.status !== "ended") return false
              } else {
                if (admitted) return false
                const boundary = yield* latestCompleteBoundary(db, session.id)
                if (!boundary) return false
                const current = yield* contextState.current(session.id)
                if (
                  yield* compactionJobs.hasUnchangedDeterministicFailure({
                    sessionID: session.id,
                    requestedThrough: boundary,
                    baseContextRevision: current.revision,
                    targetMaxInputTokens: targetSafeInputTokens,
                    configDigest,
                  })
                )
                  return false
                const job = yield* admit({
                  sessionID: session.id,
                  trigger: "mandatory",
                  requestedThrough: boundary,
                  baseContextRevision: current.revision,
                  targetMaxInputTokens: targetSafeInputTokens,
                  configDigest,
                })
                admitted = true
                const settled = yield* compactionExecution.run({ jobID: job.id, manifest })
                if (settled.status !== "ended") return false
              }
              const reloaded = yield* result.get(session.id)
              if ((yield* checkModelSwitch(reloaded, targetModel)).status === "switched") return true
            }
          }),
        )
        .pipe(
          Effect.mapError(
            (error) =>
              new CompactionConflictError({ sessionID: session.id, jobID: ID.create(), message: error.message }),
          ),
        )
    })
    const usageRoot = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const session = yield* usageDb
        .select({ id: SessionTable.id, parentID: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!session) return yield* new NotFoundError({ sessionID })
      return session
    })
    const usageFamily = Effect.fnUntraced(function* (
      session: Effect.Success<ReturnType<typeof usageRoot>>,
      recursive = false,
    ) {
      if (session.parentID && !recursive) return [session.id]
      const sessions = [session.id]
      const seen = new Set<SessionSchema.ID>([session.id])
      for (const current of sessions) {
        let cursor: { id: SessionSchema.ID; updated: number } | undefined
        while (true) {
          const children = yield* usageDb
            .select({ id: SessionTable.id, updated: SessionTable.time_updated })
            .from(SessionTable)
            .where(
              and(
                eq(SessionTable.parent_id, current),
                cursor
                  ? or(
                      lt(SessionTable.time_updated, cursor.updated),
                      and(eq(SessionTable.time_updated, cursor.updated), lt(SessionTable.id, cursor.id)),
                    )
                  : undefined,
              ),
            )
            .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
            .limit(200)
            .all()
            .pipe(Effect.orDie)
          children
            .filter((child) => !seen.has(child.id))
            .forEach((child) => {
              seen.add(child.id)
              sessions.push(child.id)
            })
          if (children.length < 200) break
          cursor = children.at(-1)!
          yield* Effect.yieldNow
        }
        yield* Effect.yieldNow
      }
      return sessions
    })
    const usageScope = Effect.fnUntraced(function* (
      session?: Effect.Success<ReturnType<typeof usageRoot>>,
      range: Partial<ProviderRequest.ReportInput> = {},
      recursive = false,
    ) {
      const sessions = session ? yield* usageFamily(session, recursive) : undefined
      return {
        sessions,
        where: SessionUsageRead.usageWhere(range, sessions),
        range: { from: range.from, to: range.to },
      }
    })
    const pricingCache = SessionUsagePricing.make()
    yield* Effect.acquireRelease(
      events.listen((event) =>
        Effect.sync(() => {
          if (event.type !== Catalog.Event.Updated.type) return
          pricingCache.invalidate(
            event.location ? JSON.stringify([event.location.directory, event.location.workspaceID ?? null]) : undefined,
          )
        }),
      ),
      (unsubscribe) => unsubscribe,
    )
    const pricingSnapshot = <A, E>(
      scope: ReturnType<typeof usageScope>,
      read: (pricing: UsagePricing, selection: Effect.Success<ReturnType<typeof usageScope>>) => Effect.Effect<A, E>,
    ) =>
      Effect.gen(function* () {
        const resolved = new Map<string, SessionUsagePricing.Entry | undefined>()
        const catalogs = new Map<string, Catalog.Interface | undefined>()
        while (true) {
          const pricing = new Map(resolved)
          const settled = yield* usageDb
            .transaction(() =>
              Effect.gen(function* () {
                const selection = yield* scope
                const missing = new Map<string, PricingRef>()
                for (const sessionID of selection.sessions ?? [undefined]) {
                  let after: string | undefined
                  while (true) {
                    const page = yield* SessionUsageRead.pricingRefs(
                      usageDb,
                      selection.where,
                      after,
                      sessionID,
                      selection.range,
                    )
                    page.refs.filter((ref) => !pricing.has(ref.key)).forEach((ref) => missing.set(ref.key, ref))
                    if (page.after === undefined) break
                    after = page.after
                  }
                }
                if (missing.size > 0) return { type: "prepare" as const, refs: missing }
                return { type: "complete" as const, value: yield* read(pricing, selection) }
              }),
            )
            .pipe(Effect.catchIf((error): error is SqlError => error instanceof SqlError, Effect.die))
          if (settled.type === "complete") return settled.value
          const byLocation = Map.groupBy(settled.refs.values(), (ref) => JSON.stringify([ref.directory, ref.workspaceID]))
          yield* Effect.forEach(
            byLocation,
            ([identity, refs]) =>
              Effect.gen(function* () {
                if (!catalogs.has(identity)) {
                  const context = yield* locations
                    .contextEffect(
                      Location.Ref.make({
                        directory: AbsolutePath.make(refs[0].directory),
                        workspaceID: refs[0].workspaceID ? Workspace.ID.make(refs[0].workspaceID) : undefined,
                      }),
                    )
                    .pipe(
                      Effect.catchCause((cause) =>
                        isMissingLocation(Cause.squash(cause)) ? Effect.succeed(undefined) : Effect.failCause(cause),
                      ),
                    )
                  catalogs.set(identity, context ? Context.get(context, Catalog.Service) : undefined)
                }
                const catalog = catalogs.get(identity)
                if (!catalog) {
                  refs.forEach((ref) => resolved.set(ref.key, undefined))
                  return
                }
                const cache = pricingCache.location(identity, catalog)
                for (const ref of refs) {
                  const cached = cache.get(ref.key)
                  if (cached) {
                    resolved.set(ref.key, cached)
                    continue
                  }
                  const provider = yield* catalog.model.get(
                    Provider.ID.make(ref.provider),
                    CatalogModel.ID.make(ref.model),
                    ref.profile ?? undefined,
                  )
                  const router = yield* catalog.model.get(
                    Provider.ID.openrouter,
                    CatalogModel.ID.make(
                      ref.provider === Provider.ID.openrouter ? ref.model : `${ref.provider}/${ref.model}`,
                    ),
                  )
                  const entry = { provider: provider?.cost ?? [], router: router?.cost ?? [] }
                  resolved.set(ref.key, entry)
                  cache.store(ref.key, entry)
                }
              }),
            { concurrency: 4, discard: true },
          )
        }
      }).pipe(Effect.scoped)
    const readUsageReport: (
      input: ProviderRequest.ReportInput,
      projectInfos: ReadonlyArray<Project.Info>,
      pricing: UsagePricing,
      sessions?: ReadonlyArray<SessionSchema.ID>,
    ) => Effect.Effect<ProviderRequest.Report> = Effect.fnUntraced(function* (input, projectInfos, pricing, sessions) {
      const where = SessionUsageRead.usageWhere(input, sessions)
      const formatter =
        input.timeZone && ["hour", "day", "month"].includes(input.group)
          ? new Intl.DateTimeFormat("en-US", {
              timeZone: input.timeZone,
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              hourCycle: "h23",
              timeZoneName: "longOffset",
            })
          : undefined
      const corrections = new Map<string, { cost: number; requests: number }>()
      let correctedCost = 0
      let correctedRequests = 0
      for (const sessionID of sessions ?? [undefined]) {
        let after: string | undefined
        while (true) {
          const page: Effect.Success<ReturnType<typeof SessionUsageRead.unpriced>> = yield* SessionUsageRead.unpriced(
            usageDb,
            where,
            after,
            sessionID,
            { from: input.from, to: input.to },
          )
          for (const item of page.rows) {
            const anchor =
              item.record.usage_anchor ??
              (sessions && item.inputID
                ? yield* SessionUsageAttribution.resolve(usageDb, { sessionID: item.sessionID, inputID: item.inputID })
                : undefined)
            const record = { ...item.record, usageAnchor: anchor, time: DateTime.makeUnsafe(item.record.time_created) }
            const session = {
              id: item.sessionID,
              title: item.title,
              projectID: Project.ID.make(item.projectID),
            }
            const cost = usagePrice(pricing, item)
            if (cost === undefined) continue
            const tasks =
              input.group === "task"
                ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(SessionSchema.ID)))(item.taskPath)
                : []
            for (const taskID of tasks.length === 0 ? [undefined] : tasks) {
              const group = usageReportGroup(input.group, { record, session, taskID }, projectInfos, formatter)
              const current = corrections.get(group.key)
              corrections.set(group.key, { cost: (current?.cost ?? 0) + cost, requests: (current?.requests ?? 0) + 1 })
            }
            correctedCost += cost
            correctedRequests += 1
          }
          if (page.after === undefined) break
          after = page.after
          yield* Effect.yieldNow
        }
      }
      const metric =
        input.sort === "cost"
          ? sql`cost`
          : input.sort === "tokens"
            ? sql`input + output + reasoning + cacheRead + cacheWrite`
            : input.sort === "steps"
              ? sql`logical`
              : input.sort === "input"
                ? sql`input`
                : input.sort === "output"
                  ? sql`output`
                  : input.sort === "reasoning"
                    ? sql`reasoning`
                    : input.sort === "cacheRead"
                      ? sql`cacheRead`
                      : input.sort === "cacheWrite"
                        ? sql`cacheWrite`
                        : input.group === "hour" && input.timeZone
                          ? sql`strftime('%s', key)`
                          : sql`key`
      const order = sql`${metric} ${input.order === "desc" ? sql`DESC` : sql`ASC`} ${input.sort && input.sort !== "key" ? sql`, key ASC` : sql``}`
      const offset = input.offset ?? 0
      const page = yield* SessionUsageRead.report(usageDb, {
        where,
        group: input.group,
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
        ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
        order,
        offset,
        limit: input.limit ?? 100,
        corrections: Object.fromEntries(corrections),
        sessions,
      })
      const totals = usageMetrics(page.total)
      const total = correctedUsage(totals, correctedCost, correctedRequests)
      const rows = page.rows.map((item) => {
        const model = Schema.decodeUnknownSync(Schema.fromJsonString(CatalogModel.Ref))(item.model)
        const group = usageReportGroup(
          input.group,
          {
            record: {
              model,
              agent: Agent.ID.make(item.agent),
              time: DateTime.makeUnsafe(item.time),
            },
            session: {
              id: SessionSchema.ID.make(item.sessionID),
              title: item.title,
              projectID: Project.ID.make(item.projectID),
            },
          },
          projectInfos,
          formatter,
        )
        const dimensions = reportDimensions(input.group, item.key)
        return {
          key: item.key,
          label: dimensions ? dimensionLabel(dimensions) : group.label,
          ...(input.group === "model" ? { model } : {}),
          ...(dimensions ? { dimensions } : {}),
          ...usageMetrics(item),
          ...(item.speed === undefined ? {} : { speed: item.speed }),
        }
      })
      return {
        group: input.group,
        rows,
        total,
        rowCount: page.rowCount,
        ...(offset + rows.length < page.rowCount ? { nextOffset: offset + rows.length } : {}),
      }
    })
    const readUsageSummary: (
      pricing: UsagePricing,
      sessions?: ReadonlyArray<SessionSchema.ID>,
    ) => Effect.Effect<ProviderRequest.Summary> = Effect.fnUntraced(function* (pricing, sessions) {
      const where = sessions ? sql`r.session_id IN (SELECT value FROM json_each(${JSON.stringify(sessions)}))` : sql`1`
      const groups = new Map<
        string,
        { metrics: ProviderRequest.ReportMetrics; model: ProviderRequest.Record["model"] }
      >()
      const decodeModel = Schema.decodeUnknownSync(Schema.fromJsonString(CatalogModel.Ref))
      let total = SessionProviderRequest.reportMetrics([])
      for (const item of yield* SessionUsageRead.models(usageDb, where, sessions)) {
        const model = decodeModel(item.model)
        const metrics = usageMetrics(item)
        total = combineUsage(total, metrics)
        groups.set(item.key, { metrics, model })
      }
      for (const sessionID of sessions ?? [undefined]) {
        let unpricedAfter: string | undefined
        while (true) {
          const page: Effect.Success<ReturnType<typeof SessionUsageRead.unpriced>> = yield* SessionUsageRead.unpriced(
            usageDb,
            where,
            unpricedAfter,
            sessionID,
          )
          for (const item of page.rows) {
            const record = item.record
            const cost = usagePrice(pricing, item)
            if (cost === undefined) continue
            const identity = JSON.stringify([
              record.model.providerID,
              record.model.id,
              record.model.variant ?? null,
              record.model.profile ?? null,
            ])
            const current = groups.get(identity)!
            total = correctedUsage(total, cost, 1)
            groups.set(identity, { ...current, metrics: correctedUsage(current.metrics, cost, 1) })
          }
          if (page.after === undefined) break
          unpricedAfter = page.after
          yield* Effect.yieldNow
        }
      }
      const models = [...groups.values()]
        .map((group) => ({
          model: group.model,
          requests: group.metrics.logical,
          tokens: group.metrics.tokens,
          cacheReadReported: group.metrics.cacheReadReported,
          ...(group.metrics.cost === undefined
            ? {}
            : { cost: group.metrics.cost, costProvenance: group.metrics.costProvenance }),
        }))
        .sort(
          (left, right) =>
            (left.cost === undefined
              ? right.cost === undefined
                ? 0
                : 1
              : right.cost === undefined
                ? -1
                : right.cost - left.cost) ||
            left.model.providerID.localeCompare(right.model.providerID) ||
            left.model.id.localeCompare(right.model.id) ||
            (left.model.variant ?? "").localeCompare(right.model.variant ?? "") ||
            (left.model.profile ?? "").localeCompare(right.model.profile ?? ""),
        )
      const latest = yield* SessionUsageRead.latest(usageDb, where, sessions)
      return {
        logical: total.logical,
        physical: total.physical,
        helpers: total.helpers,
        continued: total.continued,
        fallback: total.fallback,
        tokens: total.tokens,
        ...(total.cacheReadReported === undefined ? {} : { cacheReadReported: total.cacheReadReported }),
        ...(total.cost === undefined ? {} : { cost: total.cost }),
        ...(models.length === 0 ? {} : { models }),
        ...(latest
          ? {
              latestInvalidation: latest.invalidation,
              latestNamespace: latest.namespace,
              ...(latest.timing === null
                ? {}
                : {
                    latestTiming: Schema.decodeUnknownSync(Schema.fromJsonString(ProviderRequest.Timing))(
                      latest.timing,
                    ),
                  }),
            }
          : {}),
      }
    })
    const accountingActivity = Effect.fnUntraced(function* (sessions: ReadonlyArray<SessionSchema.ID>) {
      const active = new Set(yield* execution.active)
      const anchors = [
        ...(yield* providerRequests.activeRequests).flatMap((request) =>
          request.usageAnchor ? [request.usageAnchor] : [],
        ),
      ]
      const contributors = yield* SessionUsageAttribution.active
      for (const contributor of contributors) {
        active.add(contributor.sessionID)
        if (contributor.anchor) anchors.push(contributor.anchor)
      }
      for (const sessionID of sessions) {
        const task = yield* usageDb
          .get<{ state: string }>(sql`SELECT state FROM session_task WHERE session_id = ${sessionID}`)
          .pipe(Effect.orDie)
        if (task && ["starting", "running", "waiting", "cancelling"].includes(task.state)) active.add(sessionID)
        if (active.has(sessionID)) {
          const anchor = yield* SessionUsageAttribution.current(usageDb, sessionID)
          if (anchor) anchors.push(anchor)
        }
        yield* Effect.yieldNow
      }
      return { active, anchors: new Set(anchors.map((anchor) => JSON.stringify([anchor.sessionID, anchor.inputID]))) }
    })
    const accountingHistory = Effect.fnUntraced(function* (sessions: ReadonlyArray<SessionSchema.ID>, days: number) {
      const cutoff = Date.now() - days * 86_400_000
      let since = cutoff
      let oldest = Infinity
      for (const sessionID of sessions) {
        const row = yield* usageDb
          .get<{
            created: number
            prunedThrough: number | null
          }>(sql`SELECT time_created AS created, usage_pruned_through AS prunedThrough FROM session WHERE id = ${sessionID}`)
          .pipe(Effect.orDie)
        if (!row) return { since: Infinity, history: "partial" as const }
        oldest = Math.min(oldest, row.created)
        if (row.prunedThrough !== null) since = Math.max(since, row.prunedThrough + 1)
        yield* Effect.yieldNow
      }
      return { since, history: oldest < since ? ("partial" as const) : ("retained" as const) }
    })
    const readPromptCosts = Effect.fnUntraced(function* (
      input: UsageAccounting.PromptInput & { readonly sessionID: SessionSchema.ID },
      pricing: UsagePricing,
      sessions: ReadonlyArray<SessionSchema.ID>,
      days: number,
    ): Effect.fn.Return<UsageAccounting.PromptCosts> {
      const units = new Map<
        string,
        { anchor: UsageAnchor.Ref; valid: boolean; started?: number; value: ReturnType<typeof accountingUnit> }
      >()
      for (const inputID of input.inputIDs) {
        const anchor = yield* SessionUsageAttribution.resolve(usageDb, { sessionID: input.sessionID, inputID })
        if (anchor && (anchor.sessionID !== input.sessionID || anchor.inputID !== inputID)) continue
        const reference = anchor ?? { sessionID: input.sessionID, inputID }
        const message = yield* usageDb
          .get<{
            created: number
          }>(sql`SELECT time_created AS created FROM session_message WHERE session_id = ${reference.sessionID} AND id = ${reference.inputID}`)
          .pipe(Effect.orDie)
        const started =
          message?.created ??
          (yield* SessionUsageAttribution.admitted(usageDb, reference.sessionID, reference.inputID))?.timeCreated
        units.set(JSON.stringify([reference.sessionID, reference.inputID]), {
          anchor: reference,
          valid: anchor !== undefined,
          started,
          value: accountingUnit(),
        })
      }
      const unattributed = accountingBucket()
      yield* SessionUsageRead.each(usageDb, sessions, (row) =>
        Effect.gen(function* () {
          const anchor =
            row.record.usage_anchor ??
            (row.record.input_id
              ? yield* SessionUsageAttribution.resolve(usageDb, {
                  sessionID: row.sessionID,
                  inputID: row.record.input_id,
                })
              : undefined)
          const cost = row.record.cost ?? (row.record.source === "decision" ? undefined : usagePrice(pricing, row))
          if (!anchor) {
            addAccounting(unattributed, row.record, cost, row.record.cost === null && cost !== undefined)
            return
          }
          const unit = units.get(JSON.stringify([anchor.sessionID, anchor.inputID]))
          if (unit) addUnit(unit.value, row, row.sessionID === anchor.sessionID, cost)
        }),
      )
      const history = yield* accountingHistory(sessions, days)
      const activity = yield* accountingActivity(sessions)
      return {
        history: history.history,
        unattributed: accountingBreakdown(unattributed, false),
        units: [...units].map(([key, unit]) => {
          const coverage =
            unit.valid && unit.started !== undefined && unit.started >= history.since
              ? ("retained" as const)
              : ("partial" as const)
          const attribution = !unit.valid
            ? ("unattributed" as const)
            : unattributed.requests > 0
              ? ("partial" as const)
              : ("complete" as const)
          return {
            anchor: unit.anchor,
            status: activity.anchors.has(key) ? ("so-far" as const) : ("settled" as const),
            attribution,
            history: coverage,
            ...unitBreakdown(unit.value, unit.valid && attribution === "complete" && coverage === "retained"),
          }
        }),
      }
    })
    const readTaskCosts = Effect.fnUntraced(function* (
      input: UsageAccounting.TaskInput & { readonly sessionID: SessionSchema.ID },
      pricing: UsagePricing,
      family: ReadonlyArray<SessionSchema.ID>,
      days: number,
    ): Effect.fn.Return<UsageAccounting.TaskCosts, NotFoundError> {
      const units = new Map<
        SessionSchema.ID,
        {
          anchor?: UsageAnchor.Ref
          started: number
          sessions: ReadonlySet<SessionSchema.ID>
          value: ReturnType<typeof accountingUnit>
        }
      >()
      for (const sessionID of input.sessionIDs) {
        if (!family.includes(sessionID)) return yield* new NotFoundError({ sessionID })
        const task = yield* usageDb
          .select()
          .from(SessionTaskTable)
          .where(eq(SessionTaskTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!task) return yield* new NotFoundError({ sessionID })
        const sessions = yield* usageFamily({ id: sessionID, parentID: task.parent_id }, true)
        const anchor =
          task.usage_anchor ?? (yield* SessionUsageAttribution.resolve(usageDb, { sessionID, inputID: task.input_id }))
        units.set(sessionID, {
          anchor,
          started: task.time_created,
          sessions: new Set(sessions),
          value: accountingUnit(),
        })
      }
      const selected = [...new Set([...units.values()].flatMap((unit) => [...unit.sessions]))]
      const total = accountingBucket()
      yield* SessionUsageRead.each(usageDb, selected, (row) =>
        Effect.sync(() => {
          const cost = row.record.cost ?? (row.record.source === "decision" ? undefined : usagePrice(pricing, row))
          addAccounting(total, row.record, cost, row.record.cost === null && cost !== undefined)
          for (const [sessionID, unit] of units)
            if (unit.sessions.has(row.sessionID)) addUnit(unit.value, row, row.sessionID === sessionID, cost)
        }),
      )
      const activity = yield* accountingActivity(selected)
      const history = yield* accountingHistory(selected, days)
      const tasks: UsageAccounting.TaskCost[] = []
      for (const [sessionID, unit] of units) {
        const coverage = yield* accountingHistory([...unit.sessions], days)
        const history = unit.started >= coverage.since ? ("retained" as const) : ("partial" as const)
        tasks.push({
          sessionID,
          ...(unit.anchor ? { usageAnchor: unit.anchor } : {}),
          history,
          attribution: "complete",
          status: [...unit.sessions].some((id) => activity.active.has(id)) ? "so-far" : "settled",
          ...unitBreakdown(unit.value, history === "retained"),
        })
      }
      return { tasks, history: history.history, total: accountingBreakdown(total, history.history === "retained") }
    })
    const decode = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
        Effect.mapError(
          () =>
            new MessageDecodeError({
              sessionID: SessionSchema.ID.make(row.session_id),
              messageID: SessionMessage.ID.make(row.id),
            }),
        ),
      )

    const admitGoalContinuation = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      state: SessionAutonomy.State,
      text: string,
    ) {
      const goal = state.goal
      if (!goal || goal.status !== "active") return state
      const startID = SessionMessage.ID.make(`msg_goal_${(yield* Effect.sync(() => randomUUID())).slice(0, 24)}`)
      const startInput = SessionPending.Message.make({
        type: "synthetic",
        data: {
          text,
          description: "Goal · steer",
          metadata: { autonomy: { goal: true, iteration: goal.iteration } },
        },
        delivery: "steer",
      })
      yield* SessionPending.admit(db, events, { id: startID, sessionID, input: startInput }).pipe(
        Effect.catchDefect((defect) =>
          defect instanceof SessionPending.LifecycleConflict ? Effect.void : Effect.die(defect),
        ),
      )
      yield* execution.wake(sessionID).pipe(Effect.orDie)
      return state
    })

    const applyFamilySleep = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      asleep: boolean,
    ): Effect.fn.Return<void> {
      if (asleep) yield* Effect.gen(function* () {
        const session = yield* result.get(sessionID)
        const located = locations.get(session.location)
        const convert = <E>(kind: string, effect: Effect.Effect<void, E>) => effect.pipe(
          Effect.catchCause(() => Effect.logWarning("Unable to defer pending requests for sleeping Session", { sessionID, kind })),
        )
        const guardrail = yield* SessionGuardrail.Service.pipe(Effect.provide(located))
        yield* convert("guardrail", guardrail.deferPending(sessionID))
        const forms = yield* Form.Service.pipe(Effect.provide(located))
        yield* convert("form", forms.deferPending(sessionID))
        const questions = yield* Question.Service.pipe(Effect.provide(located))
        yield* convert("question", questions.deferPending(sessionID))
        const permission = yield* Permission.Service.pipe(Effect.provide(located))
        yield* convert("permission", permission.deferPending(sessionID))
        const task = yield* db
          .select()
          .from(SessionTaskTable)
          .where(eq(SessionTaskTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (task?.state === "waiting" && task.question_id && task.question) {
          if (!(yield* SessionReviewFold.ownsQuestion(db, sessionID, task.question_id)))
            yield* SessionReviewFold.open(db, events, {
              sessionID,
              kind: "subagent_question",
              reason: "sleep_entry",
              origin: { questionID: task.question_id },
              payload: {
                type: "subagent_question",
                text: SessionOrchestration.QuestionText.make(task.question),
                ...(task.question_data === null ? {} : { data: task.question_data }),
              },
              limit: 16,
              conversion: true,
            }).pipe(Effect.orDie)
        }
      }).pipe(Effect.catchCause(() => Effect.logWarning("Unable to defer pending reviews for sleeping Session", { sessionID })))
      const awake = yield* keepAwake.get
      yield* events.publish(SessionEvent.ContextObserved, {
        sessionID,
        source: "session-state",
        text: asleep
          ? `The user is asleep and cannot interact. Make decisions independently, do not wait for user input, and keep working until the task is done. Confident decision-model choices apply automatically; anything it cannot settle is deferred to the user's review box and decided after the user wakes. Keep-awake: idle ${awake.state}, lid ${awake.lid === "held" ? "held by another YCoding process" : awake.lid ?? "unreported"}. On battery this drains the battery and a closed lid traps heat.`
          : "The user is back. Sleep mode is off; questions, forms, and guardrail reviews return to the user unless other autonomy settings apply. Items in the review box stay there until the user decides them.",
      }).pipe(Effect.catchCause((cause) => asleep
        ? Effect.logWarning("Unable to record family sleep notice", { sessionID }) : Effect.failCause(cause)))
      const children = yield* result.list({ parentID: sessionID })
      yield* Effect.forEach(children.data, (child) => applyFamilySleep(child.id, asleep), { discard: true })
    })

    const applySleepTransition = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      before: SessionAutonomy.State,
      after: SessionAutonomy.State,
    ) {
      if (!before.sleep && after.sleep) {
        yield* keepAwake.hold(sessionID)
        yield* applyFamilySleep(sessionID, true)
      }
      if (before.sleep && !after.sleep) {
        yield* keepAwake.release(sessionID)
        yield* applyFamilySleep(sessionID, false)
      }
    })

    const rootSessionID = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      let current = yield* store.get(sessionID)
      while (current?.parentID) {
        const parent = yield* store.get(current.parentID)
        if (!parent) break
        current = parent
      }
      return current?.id ?? sessionID
    })

    const wakeIfAsleep = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const rootID = yield* rootSessionID(sessionID)
      yield* familyAutonomyLocks.withLock(rootID)(
        Effect.gen(function* () {
          const before = yield* autonomy
            .get(rootID)
            .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(undefined)))
          if (!before?.sleep) return
          const after = yield* autonomy
            .set({ sessionID: rootID, sleep: false })
            .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(undefined)))
          if (after) yield* applySleepTransition(rootID, before, after)
        }).pipe(Effect.uninterruptible),
      )
    })

    const staleQuestionReviews = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const answers = yield* autonomy
        .decisionMode(sessionID, "answers")
        .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed("manual" as const)))
      if (answers !== "yolo") return undefined
      const folded = yield* SessionReviewFold.fold(db, [sessionID])
      return folded.filter((item) => SessionReviewFold.isOpen(item) && item.kind === "question").map((item) => item.itemID)
    })

    const supersedeQuestionWaits = Effect.fnUntraced(function* (
      session: SessionSchema.Info,
      sessionID: SessionSchema.ID,
      stale: ReadonlyArray<SessionReviewFold.ID>,
    ): Effect.fn.Return<void> {
      const located = locations.get(session.location)
      const forms = yield* Form.Service.pipe(Effect.provide(located))
      yield* forms.cancelPending(sessionID)
      const questions = yield* Question.Service.pipe(Effect.provide(located))
      yield* questions.cancelPending(sessionID)
      const rootID = yield* SessionReviewFold.rootOf(db, sessionID)
      if (rootID === undefined || stale.length === 0) return
      yield* SessionReviewFold.withFamilyLock(rootID)(
        Effect.gen(function* () {
          const open = (yield* SessionReviewFold.fold(db, [sessionID])).filter(
            (item) => SessionReviewFold.isOpen(item) && stale.includes(item.itemID),
          )
          yield* Effect.forEach(open, (item) => SessionReviewFold.withdrawItem(events, sessionID, item.itemID, "task_closed"), {
            discard: true,
          })
        }),
      )
    })

    const result = Service.of({
      create: Effect.fn("Session.create")(function* (input) {
        const sessionID = input.id ?? SessionSchema.ID.create()
        if (input.native && (input.parentID !== undefined || !(yield* input.native.validate())))
          return yield* new NotFoundError({ sessionID })
        const recorded = yield* store.get(sessionID)
        if (recorded) return recorded
        if (input.agent && decisionAgents.has(input.agent)) return yield* new AgentNotSelectableError({ agent: input.agent })
        const parent = input.parentID ? yield* store.get(input.parentID) : undefined
        if (input.parentID && parent === undefined) return yield* new NotFoundError({ sessionID: input.parentID })
        const location = parent?.location ?? input.location
        if (location === undefined)
          return yield* Effect.die(new Error("Session.create requires either location or an existing parentID"))
        const project = yield* projects.resolve(location.directory)
        yield* db
          .insert(ProjectTable)
          .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const now = Date.now()
        const permissionCeiling = SessionPermissionCeiling.inherit(parent?.permissionCeiling, input.permissionCeiling)
        const relative = path.relative(project.directory, location.directory).replaceAll("\\", "/")
        const chosen = input.model ?? parent?.model
        const selection =
          chosen ??
          (yield* Catalog.Service.pipe(
            Effect.provide(locations.get(location)),
            Effect.flatMap((catalog) => catalog.model.defaultSelection()),
          ))
        const inheritedBinding =
          input.profileBinding ??
          (parent &&
          input.model === undefined &&
          selection?.providerID === parent.model?.providerID &&
          selection?.profile === parent.model?.profile
            ? ((yield* db
                .select({ binding: SessionTable.profile_binding })
                .from(SessionTable)
                .where(eq(SessionTable.id, parent.id))
                .get()
                .pipe(Effect.orDie))?.binding ?? undefined)
            : undefined)
        const bound =
          selection?.profile === undefined
            ? undefined
            : yield* SessionRunnerModel.Service.pipe(
                Effect.provide(locations.get(location)),
                Effect.flatMap((models) =>
                  models.resolve(
                    SessionSchema.Info.make({
                      id: sessionID,
                      projectID: project.id,
                      title: input.title ?? "New session",
                      model: selection,
                      location,
                      cost: Money.USD.zero,
                      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                      time: { created: DateTime.makeUnsafe(now), updated: DateTime.makeUnsafe(now) },
                    }),
                    { binding: inheritedBinding },
                  ),
                ),
              )
        const projected = yield* events
          .publishBatch([
            {
              definition: SessionEvent.Created,
              data: {
                sessionID,
                projectID: project.id,
                location,
                parentID: input.parentID,
                agent: input.agent,
                model: bound?.ref ?? chosen,
                permissionCeiling: permissionCeiling.length > 0 ? permissionCeiling : undefined,
                title: input.title ?? `New session - ${new Date(now).toISOString()}`,
                subpath: relative.length > 0 ? RelativePath.make(relative) : undefined,
                created: now,
              },
              options: { location },
            },
            ...(bound?.profileBinding
              ? [
                  {
                    definition: SessionEvent.ProfileBound,
                    data: { sessionID, binding: bound.profileBinding },
                    options: { location },
                  },
                ]
              : []),
          ], input.native ? { when: input.native.validate() } : undefined)
          .pipe(
            Effect.flatMap((committed) => committed.length > 0 ? Effect.succeed({ type: "created" } as const) : new NotFoundError({ sessionID })),
            Effect.catchDefect((defect) => {
              if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) {
                return Effect.die(defect)
              }
              // Concurrent creation lost the projection race. The existing Session identity wins.
              return store
                .get(sessionID)
                .pipe(
                  Effect.flatMap((session) =>
                    session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                  ),
                )
            }),
          )
        if (projected.type === "existing") return projected.session
        // TODO: Restore recorded sessions onto replacement synchronized workspaces in a future API slice.
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      fork: Effect.fn("Session.fork")(function* (input) {
        const parent = yield* result.get(input.sessionID)
        const boundary = input.messageID
          ? yield* SessionRevert.boundary(db, { sessionID: input.sessionID, messageID: input.messageID })
          : undefined
        const sessionID = SessionSchema.ID.create()
        const parentSeq = boundary === undefined ? yield* EventRuntime.latestSequence(db, parent.id) : boundary - 1
        const binding =
          (yield* db
            .select({ binding: SessionTable.profile_binding })
            .from(SessionTable)
            .where(eq(SessionTable.id, parent.id))
            .get()
            .pipe(Effect.orDie))?.binding ?? undefined
        yield* events
          .publishBatch([
            {
              definition: SessionEvent.Forked,
              data: { sessionID, parentID: parent.id, parentSeq, from: input.messageID },
            },
            ...(binding ? [{ definition: SessionEvent.ProfileBound, data: { sessionID, binding } }] : []),
          ])
          .pipe(
            Effect.catchDefect((defect) =>
              defect instanceof HistoryPrunedError ? Effect.fail(defect) : Effect.die(defect),
            ),
          )
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      get: Effect.fn("Session.get")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        return session
      }),
      snapshot: Effect.fn("Session.snapshot")(function* (sessionID, options) {
        if (
          options?.limit !== undefined &&
          (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200)
        )
          return yield* new InvalidCursorError()
        if (options?.before !== undefined && options.limit === undefined) return yield* new InvalidCursorError()
        const before =
          options?.before === undefined ? undefined : yield* SessionHistory.snapshotCursor(sessionID, options.before)
        return yield* db
          .transaction(() =>
            Effect.gen(function* () {
              const session = yield* result.get(sessionID)
              const history =
                options?.limit === undefined
                  ? { messages: yield* SessionHistory.transcript(db, sessionID) }
                  : yield* SessionHistory.snapshotWindow(db, sessionID, options.limit, before)
              const sequence = yield* EventRuntime.latestSequence(db, sessionID)
              const watermark: EventLog.Synced = {
                type: "log.synced",
                aggregateID: sessionID,
                ...(sequence < 0 ? {} : { seq: EventRuntime.Seq.make(sequence) }),
              }
              const generationSpeed = (yield* overlayGeneration(sessionID,
                yield* store.diagnostics(sessionID, session.revert?.messageID),
                session.revert?.messageID !== undefined || before !== undefined))?.generationSpeed
              return {
                session,
                ...history,
                watermark,
                ...(generationSpeed === undefined ? {} : { generationSpeed }),
              }
            }),
          )
          .pipe(Effect.orDie)
      }),
      attachmentRead: Effect.fn("Session.attachmentRead")(function* (sessionID, digest) {
        if (!/^[0-9a-f]{64}$/.test(digest)) return yield* new AttachmentReadError({ reason: "invalid" })
        yield* result.get(sessionID)
        const reference = yield* db
          .get<{ mime: unknown; bytes: unknown; path: unknown }>(
            sql`
          SELECT json_extract(file.value, '$.mime') AS mime,
                 json_extract(file.value, '$.content.bytes') AS bytes,
                 json_extract(file.value, '$.content.path') AS path
          FROM session_message AS message, json_each(message.data, '$.files') AS file
          WHERE message.session_id = ${sessionID} AND message.type = 'user'
            AND json_extract(file.value, '$.content.type') = 'managed'
            AND json_extract(file.value, '$.content.digest') = ${digest}
          UNION ALL
          SELECT json_extract(file.value, '$.mime') AS mime,
                 json_extract(file.value, '$.content.bytes') AS bytes,
                 json_extract(file.value, '$.content.path') AS path
          FROM session_pending AS pending, json_each(pending.data, '$.files') AS file
          WHERE pending.session_id = ${sessionID} AND pending.type = 'user'
            AND json_extract(file.value, '$.content.type') = 'managed'
            AND json_extract(file.value, '$.content.digest') = ${digest}
          LIMIT 1
        `,
          )
          .pipe(Effect.orDie)
        if (!reference) return yield* new AttachmentReadError({ reason: "not-found" })
        const content = yield* Schema.decodeUnknownEffect(ManagedAttachmentContent)({
          type: "managed",
          digest,
          bytes: reference.bytes,
          path: reference.path,
        }).pipe(Effect.orDie)
        const mime = yield* Schema.decodeUnknownEffect(Schema.String)(reference.mime).pipe(Effect.orDie)
        if (content.bytes > MaxAttachmentReadBytes) return yield* new AttachmentReadError({ reason: "too-large" })
        const bytes = yield* attachments.read(content).pipe(
          Effect.catchTag("AttachmentStore.Error", (error) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("Managed Session attachment unavailable", { reason: error.reason })
              return yield* new AttachmentReadError({ reason: "not-found" })
            }),
          ),
        )
        return { mime, bytes: bytes.byteLength, data: Buffer.from(bytes).toString("base64") }
      }),
      compactionHistory: Effect.fn("Session.compactionHistory")(function* (sessionID) {
        yield* result.get(sessionID)
        const scope = sql`session_id = ${sessionID} AND type = 'compaction' AND json_extract(data, '$.jobID') IS NOT NULL`
        const history = yield* db
          .transaction(() =>
            Effect.gen(function* () {
              const window = yield* db.all<{
                jobID: unknown
                trigger: unknown
                status: unknown
                created: unknown
                code: unknown
                excludedMessages: unknown
                excludedParts: unknown
                inputTokens: unknown
                retainedTokens: unknown
              }>(sql`
                SELECT json_extract(data, '$.jobID') AS jobID, json_extract(data, '$.trigger') AS trigger,
                       json_extract(data, '$.status') AS status, json_extract(data, '$.time.created') AS created, json_extract(data, '$.code') AS code,
                       json_extract(data, '$.metrics.excludedMessages') AS excludedMessages,
                       json_extract(data, '$.metrics.excludedParts') AS excludedParts,
                       json_extract(data, '$.metrics.inputTokens') AS inputTokens,
                       json_extract(data, '$.metrics.retainedTokens') AS retainedTokens
                FROM session_message WHERE ${scope}
                ORDER BY created DESC, jobID DESC LIMIT ${CompactionHistoryLimit}
              `)
              const totals = yield* db.get<{ total: number; completed: number; saved: number }>(sql`
                SELECT count(*) AS total,
                       coalesce(sum(json_extract(data, '$.status') = 'completed'), 0) AS completed,
                       coalesce(sum(CASE WHEN json_extract(data, '$.status') = 'completed'
                         THEN json_extract(data, '$.metrics.inputTokens') - json_extract(data, '$.metrics.retainedTokens') END), 0) AS saved
                FROM session_message WHERE ${scope}
              `)
              return { window, totals }
            }),
          )
          .pipe(Effect.orDie)
        const jobs = history.window.toReversed().map((row) => ({
          jobID: row.jobID,
          trigger: row.trigger,
          status: row.status,
          created: row.created,
          ...(row.status === "completed"
            ? {
                metrics: {
                  excludedMessages: row.excludedMessages,
                  excludedParts: row.excludedParts,
                  inputTokens: row.inputTokens,
                  retainedTokens: row.retainedTokens,
                },
              }
            : {}),
          ...(row.status === "failed" ? { code: row.code } : {}),
        }))
        const totals = history.totals ?? { total: 0, completed: 0, saved: 0 }
        return yield* Schema.decodeUnknownEffect(History)({
          data: jobs,
          truncated: totals.total > CompactionHistoryLimit,
          completedBefore: totals.completed - jobs.filter((job) => job.status === "completed").length,
          completedCount: totals.completed,
          totalSavedTokens: totals.saved,
        }).pipe(Effect.orDie)
      }),
      diagnostics: Effect.fn("Session.diagnostics")(function* (sessionID) {
        const session = yield* result.get(sessionID)
        const diagnostics = yield* overlayGeneration(sessionID,
          yield* store.diagnostics(sessionID, session.revert?.messageID), session.revert?.messageID !== undefined)
        if (!diagnostics) return diagnostics
        return {
          ...diagnostics,
          requests: yield* providerRequests.summary(sessionID),
        }
      }),
      usage: Effect.fn("Session.usage")(function* (sessionID) {
        const session = yield* usageRoot(sessionID)
        return yield* pricingSnapshot(usageScope(session), (pricing, selection) =>
          readUsageSummary(pricing, selection.sessions),
        )
      }),
      usageReport: Effect.fn("Session.usageReport")(function* (input) {
        const session = yield* usageRoot(input.sessionID)
        const projectInfos = input.group === "project" ? yield* projects.list() : []
        return yield* pricingSnapshot(
          usageScope(session, input, input.group === "prompt" || input.group === "task"),
          (pricing, selection) => readUsageReport(input, projectInfos, pricing, selection.sessions),
        )
      }),
      usageAll: Effect.fn("Session.usageAll")(function* () {
        return yield* pricingSnapshot(usageScope(), (pricing) => readUsageSummary(pricing))
      }),
      usageReportAll: Effect.fn("Session.usageReportAll")(function* (input) {
        const projectInfos = input.group === "project" ? yield* projects.list() : []
        return yield* pricingSnapshot(usageScope(undefined, input), (pricing) =>
          readUsageReport(input, projectInfos, pricing),
        )
      }),
      promptCosts: Effect.fn("Session.promptCosts")(function* (input) {
        const session = yield* usageRoot(input.sessionID)
        const days = (yield* retentionSettings.read()).recordsDays
        return yield* pricingSnapshot(usageScope(session, {}, true), (pricing, selection) =>
          readPromptCosts(input, pricing, selection.sessions!, days),
        )
      }),
      taskCosts: Effect.fn("Session.taskCosts")(function* (input) {
        const session = yield* usageRoot(input.sessionID)
        const days = (yield* retentionSettings.read()).recordsDays
        return yield* pricingSnapshot(usageScope(session, {}, true), (pricing, selection) =>
          readTaskCosts(input, pricing, selection.sessions!, days),
        )
      }),
      autonomy: {
        get: Effect.fn("Session.autonomy.get")(function* (sessionID) {
          yield* result.get(sessionID)
          return yield* autonomy
            .get(sessionID)
            .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.fail(new NotFoundError({ sessionID }))))
        }),
        effective: Effect.fn("Session.autonomy.effective")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          const notFound = <A, R>(effect: Effect.Effect<A, SessionAutonomy.NotFoundError, R>) =>
            effect.pipe(
              Effect.catchTag("SessionAutonomy.NotFound", (error) =>
                Effect.fail(new NotFoundError({ sessionID: error.sessionID })),
              ),
            )
          const decisions = yield* autonomy.effectiveDecisions(sessionID).pipe(notFound)
          const asleep = yield* autonomy.isAsleep(sessionID).pipe(notFound)
          const guardrail = yield* SessionGuardrail.Service.pipe(Effect.provide(locations.get(session.location)))
          return { ...decisions, asleep, guardrailsEnabled: guardrail.reviewPolicy.enabled }
        }),
        set: Effect.fn("Session.autonomy.set")(function* (input) {
          const session = yield* result.get(input.sessionID)
          const goal = input.goal
          const notFound = <A, R>(effect: Effect.Effect<A, SessionAutonomy.NotFoundError, R>) =>
            effect.pipe(
              Effect.catchTag("SessionAutonomy.NotFound", (error) =>
                Effect.fail(new NotFoundError({ sessionID: error.sessionID })),
              ),
            )
          if (typeof goal === "string") {
            const rawText = goal.trim()
            // Capture the durable revision before the paid calculation. A concurrent user stop or
            // replacement must win over this late result instead of being overwritten by it.
            const snapshot = yield* autonomy.snapshot(input.sessionID).pipe(notFound)
            const goals = yield* SessionGoal.Service.pipe(Effect.provide(locations.get(session.location)))
            const synthesized = yield* goals.synthesize({ session, text: rawText })
            const candidate = SessionAutonomy.makeGoal({
              text: synthesized,
              rawText,
              maxNoProgress: input.maxNoProgress,
            })
            const steer = yield* goals.steer({ session, goal: candidate, phase: "start" })
            const applied = yield* autonomy
              .setGoalIfCurrent({
                sessionID: input.sessionID,
                expectedSequence: snapshot.sequence,
                text: synthesized,
                rawText,
                maxNoProgress: input.maxNoProgress,
              })
              .pipe(notFound)
            if (!applied.applied) return yield* new SessionGoal.Error({ code: "goal.stale_calculation" })
            return yield* admitGoalContinuation(input.sessionID, applied.state, steer)
          }
          if (goal === true) {
            const snapshot = yield* autonomy.snapshot(input.sessionID).pipe(notFound)
            if (!snapshot.state.goal) return yield* new SessionGoal.Error({ code: "goal.no_retained_goal" })
            const goals = yield* SessionGoal.Service.pipe(Effect.provide(locations.get(session.location)))
            const steer = yield* goals.steer({
              session,
              goal: { ...snapshot.state.goal, status: "active" },
              phase: "start",
            })
            const resumed = yield* autonomy
              .resumeGoalIfCurrent({ sessionID: input.sessionID, expectedSequence: snapshot.sequence })
              .pipe(notFound)
            if (!resumed.applied) return yield* new SessionGoal.Error({ code: "goal.stale_calculation" })
            return yield* admitGoalContinuation(input.sessionID, resumed.state, steer)
          }
          if (input.sleep !== undefined) {
            const rootID = yield* rootSessionID(input.sessionID)
            yield* familyAutonomyLocks.withLock(rootID)(
              Effect.gen(function* () {
                const before = yield* autonomy.get(rootID).pipe(notFound)
                const after = yield* autonomy.set({ sessionID: rootID, sleep: input.sleep }).pipe(notFound)
                yield* applySleepTransition(rootID, before, after)
              }).pipe(Effect.uninterruptible),
            )
          }
          return yield* familyAutonomyLocks.withLock(input.sessionID)(
            autonomy
              .set({
                sessionID: input.sessionID,
                permissions: input.permissions,
                guardrails: input.guardrails,
                answers: input.answers,
                goal,
                maxNoProgress: input.maxNoProgress,
              })
              .pipe(Effect.andThen(autonomy.get(input.sessionID)), notFound, Effect.uninterruptible),
          )
        }),
      },
      remove: Effect.fn("Session.remove")(function* (sessionID) {
        yield* result.get(sessionID)
        const removedAutonomy = yield* autonomy
          .get(sessionID)
          .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(undefined)))
        if (removedAutonomy?.sleep) yield* keepAwake.release(sessionID)
        yield* execution.interrupt(sessionID)
        yield* execution.awaitIdle(sessionID)
        const children = yield* result.list({ parentID: sessionID })
        yield* Effect.forEach(children.data, (child) => result.remove(child.id), { concurrency: 1, discard: true })
        yield* events.publish(SessionEvent.Deleted, { sessionID })
        yield* events.remove(sessionID)
      }),
      archive: Effect.fn("Session.archive")(function* (sessionID) {
        const session = yield* result.get(sessionID)
        if (!session.parentID) yield* wakeIfAsleep(sessionID)
        yield* db
          .transaction(
            () =>
              Effect.gen(function* () {
                const session = yield* result.get(sessionID)
                if (session.time.archived) return
                yield* events.publish(SessionEvent.Archived, { sessionID })
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.catch((error) => (error instanceof NotFoundError ? Effect.fail(error) : Effect.die(error))))
      }),
      unarchive: Effect.fn("Session.unarchive")((sessionID) =>
        db
          .transaction(
            () =>
              Effect.gen(function* () {
                const session = yield* result.get(sessionID)
                if (!session.time.archived) return
                yield* events.publish(SessionEvent.Unarchived, { sessionID })
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.catch((error) => (error instanceof NotFoundError ? Effect.fail(error) : Effect.die(error)))),
      ),
      pin: Effect.fn("Session.pin")((sessionID) =>
        db
          .transaction(
            () =>
              Effect.gen(function* () {
                const session = yield* result.get(sessionID)
                if (session.time.pinned) return
                yield* events.publish(SessionEvent.Pinned, { sessionID })
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.catch((error) => (error instanceof NotFoundError ? Effect.fail(error) : Effect.die(error)))),
      ),
      unpin: Effect.fn("Session.unpin")((sessionID) =>
        db
          .transaction(
            () =>
              Effect.gen(function* () {
                const session = yield* result.get(sessionID)
                if (!session.time.pinned) return
                yield* events.publish(SessionEvent.Unpinned, { sessionID })
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.catch((error) => (error instanceof NotFoundError ? Effect.fail(error) : Effect.die(error)))),
      ),
      list: Effect.fn("Session.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_updated
        const conditions: SQL[] = []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (input.parentID !== undefined)
          conditions.push(
            input.parentID === null ? isNull(SessionTable.parent_id) : eq(SessionTable.parent_id, input.parentID),
          )
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return { data: (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row)) }
      }),
      messages: Effect.fn("Session.messages")(function* (input) {
        yield* result.get(input.sessionID)
        const direction = input.cursor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const anchor = input.cursor
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.cursor && !anchor) return []
        const floor = input.retained ? yield* SessionHistory.retainedFloor(db, input.sessionID) : undefined
        const boundary = anchor
          ? order === "asc"
            ? gt(SessionMessageTable.seq, anchor.seq)
            : lt(SessionMessageTable.seq, anchor.seq)
          : undefined
        const where = and(
          eq(SessionMessageTable.session_id, input.sessionID),
          boundary,
          floor ? gte(SessionMessageTable.seq, floor.seq) : undefined,
        )
        const query = db
          .select()
          .from(SessionMessageTable)
          .where(where)
          .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        const messages = yield* Effect.forEach(rows, decode)
        const head = floor?.checkpoint ? SessionHistory.checkpointMessage(floor.checkpoint).message : undefined
        const page = !head
          ? messages
          : order === "asc"
            ? anchor
              ? messages
              : [head, ...messages].slice(0, input.limit)
            : input.limit === undefined || messages.length < input.limit
              ? [...messages, head]
              : messages
        return direction === "previous" ? page.toReversed() : page
      }),
      message: Effect.fn("Session.message")(function* (input) {
        const stored = yield* store.message(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      context: Effect.fn("Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      fileChanges: Effect.fn("Session.fileChanges")(function* (sessionID) {
        yield* result.get(sessionID)
        const rows = yield* db
          .select({
            path: SessionFileChangeTable.path,
            patch: SessionFileChangeTable.patch,
            additions: SessionFileChangeTable.additions,
            deletions: SessionFileChangeTable.deletions,
          })
          .from(SessionFileChangeTable)
          .leftJoin(SessionTaskTable, eq(SessionTaskTable.session_id, SessionFileChangeTable.session_id))
          .where(
            or(
              eq(SessionFileChangeTable.session_id, sessionID),
              and(eq(SessionTaskTable.parent_id, sessionID), eq(SessionTaskTable.state, "completed")),
            ),
          )
          .orderBy(asc(SessionFileChangeTable.path), asc(SessionFileChangeTable.session_id))
          .all()
          .pipe(Effect.orDie)
        return rows.map((row) => SessionEvent.FileChange.Info.make(row))
      }),
      skills: Effect.fn("Session.skills")(function* (sessionID) {
        const session = yield* result.get(sessionID)
        const contextModule = yield* Effect.promise<typeof import("./context")>(() => import("./" + "context"))
        const context = yield* contextModule.SessionContext.Service.pipe(
          Effect.provide(locations.get(session.location)),
        )
        const selection = yield* context.select(sessionID)
        const keys = yield* InstructionState.activeKeys(db, selection.instructions, sessionID)
        return yield* store.skills(sessionID, keys)
      }),
      pending: Effect.fn("Session.pending")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* SessionPending.list(db, sessionID)
      }),
      log: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(events.log({ aggregateID: input.sessionID, after: input.after, follow: input.follow }))),
        ).pipe(
          Stream.filter(
            (item): item is SessionEvent.PublicDurableEvent | EventLog.Synced =>
              EventRuntime.isSynced(item) || isPublicDurableSessionEvent(item),
          ),
        ),
      prompt: Effect.fn("Session.prompt")((input) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (input.native && !(yield* input.native.validate())) return yield* new NotFoundError({ sessionID: input.sessionID })
            const session = yield* result.get(input.sessionID)
            // A staged revert must be committed before admitting new input so the prompt
            // continues from the reverted boundary rather than stale post-boundary history.
            if (session.revert) {
              yield* SessionRevert.commit(session).pipe(Effect.provideService(Database.Service, database), Effect.provideService(EventRuntime.Service, events))
            }
            const messageID = input.id ?? SessionMessage.ID.create()
            // A reused prompt message ID is the same input: return the durable record and
            // wake without re-resolving attachments, whose re-derived shape can differ from
            // the admitted record (a directory attachment's derived mime, for example).
            const prior = yield* SessionPending.lookup(db, input.sessionID, messageID).pipe(
              Effect.catchDefect((defect) =>
                defect instanceof SessionPending.LifecycleConflict
                  ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                  : Effect.die(defect),
              ),
            )
            let freshlyAdmitted = false
            const supersedable =
              prior === undefined && input.origin === undefined && input.delivery !== "queue" && input.resume !== false
            const stale = supersedable ? yield* staleQuestionReviews(input.sessionID) : undefined
            const admitted =
              prior?.type === "user" && prior.sessionID === input.sessionID
                ? prior
                : yield* Effect.gen(function* () {
                    // Resolved lazily so prompt admission only boots location services when an
                    // image attachment actually needs the resizer.
                    const image = Image.Service.pipe(Effect.provide(locations.get(session.location)))
                    const prompt = yield* resolvePrompt(
                      { text: input.text, files: input.files, agents: input.agents },
                      image,
                      attachments,
                      db,
                    ).pipe(Effect.provideService(FSUtil.Service, fs))
                    const skillMentions = input.text.includes("$")
                      ? yield* Effect.gen(function* () {
                          const pluginModule = yield* Effect.promise<typeof import("../plugin/supervisor")>(
                            () => import("../plugin/supervisor"),
                          )
                          const plugins = yield* pluginModule.PluginSupervisor.Service.pipe(
                            Effect.provide(locations.get(session.location)),
                          )
                          yield* plugins.flush
                          const skills = yield* Skill.Service.pipe(Effect.provide(locations.get(session.location)))
                          return SessionSkill.mentions(input.text, yield* skills.list())
                        })
                      : []
                    const shared = input.sharedContext
                      ? SessionSharedContext.compose(prompt.text, input.sharedContext)
                      : undefined
                    const metadata = {
                      ...(shared
                        ? { ...Object.fromEntries(Object.entries(input.metadata ?? {}).filter(([key]) => key !== "remoteMcp" && key !== "nativeSource")), sharedContext: shared.sharedContext }
                        : Object.fromEntries(
                            Object.entries(input.metadata ?? {}).filter(([key]) => key !== "sharedContext" && key !== "remoteMcp" && key !== "nativeSource"),
                          )),
                      inputOrigin: input.origin ?? "direct",
                      ...(input.native ? { nativeSource: input.native.source } : {}),
                    }
                    const admitted = yield* Effect.gen(function* () {
                      const existing = yield* SessionPending.lookup(db, input.sessionID, messageID)
                      if (existing !== undefined) return existing
                      const created = yield* SessionPending.admit(db, events, {
                        id: messageID,
                        sessionID: input.sessionID,
                        causedBy: input.causedBy,
                        input: SessionPending.Message.make({
                          type: "user",
                          data: {
                            ...prompt,
                            ...(shared ? { text: shared.text } : {}),
                            metadata: skillMentions.length
                              ? {
                                  ...metadata,
                                  skills: [
                                    ...(Array.isArray(input.metadata?.skills) ? input.metadata.skills : []),
                                    ...skillMentions.filter(
                                      (skill) => !SessionSkill.selected(input.metadata).includes(Skill.ID.make(skill.id)),
                                    ),
                                  ],
                                }
                              : metadata,
                          },
                          delivery: input.delivery ?? "steer",
                        }),
                      }, input.native ? { when: input.native.validate() } : undefined)
                      freshlyAdmitted = true
                      // Waking under the inbox lock keeps the runner from promoting this input
                      // while the family still sleeps; a reused ID never wakes.
                      if (input.origin === undefined && created.type === "user" && created.sessionID === input.sessionID)
                        yield* wakeIfAsleep(input.sessionID)
                      return created
                    }).pipe(
                      Effect.catchDefect((defect) =>
                        defect instanceof SessionPending.LifecycleConflict
                          ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                          : Effect.die(defect),
                      ),
                      SessionPending.withInboxLock(input.sessionID),
                    )
                    if (admitted.type !== "user" || admitted.sessionID !== input.sessionID)
                      return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
                    return admitted
                  })
            const wakeAdmitted = Effect.suspend(() =>
              input.resume === false
                ? Effect.void
                : activeShells.has(admitted.sessionID)
                  ? // Admit-only during an active shell strands the prompt until
                    // the shell's ensuring wake fires; name it so "pending but
                    // idle" is diagnosable (TUI also shows a queued notice).
                    Effect.logWarning("Session prompt queued during active shell; wake deferred", {
                      inputID: admitted.id,
                    }).pipe(Effect.annotateLogs({ sessionID: admitted.sessionID }))
                  : execution.wake(admitted.sessionID),
            )
            yield* (
              freshlyAdmitted && stale !== undefined
                ? supersedeQuestionWaits(session, admitted.sessionID, stale)
                : Effect.void
            ).pipe(
              Effect.ensuring(wakeAdmitted),
            )
            return admitted
          }),
        ),
      ),
      generate: Effect.fn("Session.generate")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const generate = yield* SessionGenerate.Service.pipe(Effect.provide(locations.get(session.location)))
        return yield* generate.generate(input)
      }),
      command: Effect.fn("Session.command")(
        function* (input) {
          const session = yield* result.get(input.sessionID)
          if (input.id !== undefined) {
            const messageID = input.id
            const prior = yield* SessionPending.lookup(db, input.sessionID, messageID).pipe(
              Effect.catchDefect((defect) =>
                defect instanceof SessionPending.LifecycleConflict
                  ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                  : Effect.die(defect),
              ),
            )
            if (prior) {
              if (prior.type !== "user" || prior.sessionID !== input.sessionID)
                return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
              return yield* result.prompt({
                sessionID: input.sessionID,
                id: prior.id,
                text: prior.data.text,
                resume: input.resume,
              })
            }
          }
          const commands = yield* Command.Service.pipe(Effect.provide(locations.get(session.location)))
          const source = yield* projectArtifactSource(session.location)
          const command = yield* commands.get(input.command)
          if (!command)
            return yield* new Command.NotFoundError({
              command: input.command,
              message: `Command not found: ${input.command}`,
            })
          // TODO(v2 commands): decide whether command-level subtask/background execution belongs in v2 commands.
          const agent = command.agent ?? input.agent
          if (agent && decisionAgents.has(agent))
            return yield* new Command.EvaluationError({
              command: input.command,
              message: new AgentNotSelectableError({ agent }).message,
            })
          const evaluated = yield* commands.evaluate({ name: input.command, arguments: input.arguments })
          const commandAgent = yield* Effect.gen(function* () {
            if (!command.agent) return undefined
            const agents = yield* Agent.Service.pipe(Effect.provide(locations.get(session.location)))
            return yield* agents.get(Agent.ID.make(command.agent))
          })
          const model = command.model ?? commandAgent?.model ?? input.model
          if (agent !== undefined && session.agent !== Agent.ID.make(agent))
            yield* result
              .switchAgent({ sessionID: input.sessionID, agent: Agent.ID.make(agent) })
              .pipe(
                Effect.catchTag("Session.AgentNotSelectableError", (error) =>
                  Effect.fail(new Command.EvaluationError({ command: input.command, message: error.message })),
                ),
              )
          // A requested command model must be selected before the command is admitted. A failed
          // selection is an explicit command evaluation failure rather than a silent run on the
          // previous model. Transcript corruption is a defect and fails loudly.
          if (model !== undefined)
            yield* result.switchModel({ sessionID: input.sessionID, model }).pipe(
              Effect.catchTag("Session.MessageDecodeError", Effect.die),
              Effect.mapError(
                (error) => new Command.EvaluationError({ command: input.command, message: error.message }),
              ),
            )
          const provenance = source ? yield* source.provenance("command", input.command) : undefined

          const admitted = yield* result.prompt({
            id: input.id,
            sessionID: input.sessionID,
            text: evaluated.text,
            origin: input.origin,
            files: input.files,
            agents: input.agents,
            metadata: provenance
              ? {
                  projectArtifact: {
                    scopeID: provenance.scopeID,
                    versionID: provenance.versionID,
                    kind: provenance.kind,
                    id: provenance.id,
                    sourceScope: provenance.scope,
                  },
                }
              : undefined,
            delivery: input.delivery,
            resume: input.resume,
          })
          if (provenance && source)
            yield* source
              .activate({
                kind: "command",
                id: input.command,
                sessionID: input.sessionID,
                agentID: session.agent,
                source: "command",
                messageID: admitted.id,
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("project artifact command activation failed", {
                    cause,
                    sessionID: input.sessionID,
                  }),
                ),
              )
          return admitted
        },
        (effect, input) => (input.id === undefined ? effect : commandLocks.withLock(input.id)(effect)),
      ),
      shell: Effect.fn("Session.shell")(function* (input) {
        const session = yield* result.get(input.sessionID)
        yield* shellLocks.withLock(input.sessionID)(
          Effect.gen(function* () {
            activeShells.add(input.sessionID)
            yield* execution.awaitIdle(input.sessionID)
            const started = yield* Effect.gen(function* () {
              const shell = yield* Shell.Service
              const guardrail = yield* SessionGuardrail.Service
              const reservation = yield* guardrail.assert({
                sessionID: input.sessionID,
                action: "shell",
                resources: [input.command],
                metadata: { workdir: session.location.directory, source: "session.shell" },
              })
              const prepared = yield* shell.prepare({
                command: input.command,
                cwd: session.location.directory,
                timeout: 0,
                // Records the owning Session so a scoped reader can prove ownership before paging output.
                metadata: { sessionID: input.sessionID },
              })
              const info = yield* shell.create(prepared).pipe(Effect.onError(() => reservation.release))
              return { info, warnings: prepared.warnings, reservation }
            }).pipe(Effect.provide(locations.get(session.location)))
            yield* Effect.gen(function* () {
              yield* events.publish(
                SessionEvent.Shell.Started,
                {
                  sessionID: input.sessionID,
                  shell: started.info,
                },
                {
                  id: input.id,
                  metadata: started.warnings.length === 0 ? undefined : { sandboxWarnings: started.warnings },
                },
              )
              const completed = yield* Effect.gen(function* () {
                const shell = yield* Shell.Service
                const terminal = yield* shell.wait(started.info.id).pipe(
                  Effect.map((info) => ({ info, retained: true as const })),
                  Effect.catchTag("Shell.NotFoundError", () =>
                    Effect.succeed({ info: synthesizeTerminalShellInfo(started.info), retained: false as const }),
                  ),
                )
                const output = terminal.retained
                  ? yield* shell
                      .output(started.info.id, { limit: SHELL_MAX_CAPTURE_BYTES })
                      .pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.succeed(missingShellOutput())))
                  : missingShellOutput()
                return { shell: terminal.info, output }
              }).pipe(Effect.provide(locations.get(session.location)))
              yield* events.publish(SessionEvent.Shell.Ended, {
                sessionID: input.sessionID,
                shell: completed.shell,
                output: completed.output,
              })
            }).pipe(Effect.ensuring(started.reservation.release))
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                activeShells.delete(input.sessionID)
                yield* execution.wake(input.sessionID)
              }),
            ),
          ),
        )
      }),
      skill: Effect.fn("Session.skill")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const permission = yield* Permission.Service.pipe(Effect.provide(locations.get(session.location)))
        const access = yield* permission.evaluateEffective({
          sessionID: session.id,
          agent: session.agent,
          action: "skill",
          resource: input.skill,
        })
        if (access === "deny") return yield* new SkillNotFoundError({ skill: input.skill })
        const skills = yield* Skill.Service.pipe(Effect.provide(locations.get(session.location)))
        const source = yield* projectArtifactSource(session.location)
        const skill = (yield* skills.list()).find((item) => item.id === input.skill)
        if (!skill) return yield* new SkillNotFoundError({ skill: input.skill })
        const provenance = source ? yield* source.provenance("skill", skill.id) : undefined
        yield* SessionSkill.activate(
          { events, store, accounting: projectArtifactAccounting, fs },
          { session, skill, id: input.id, provenance },
        ).pipe(Effect.orDie)
        if (input.resume !== false)
          yield* execution
            .resume(input.sessionID)
            .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
      }),
      resolveSkillConflict: Effect.fn("Session.resolveSkillConflict")(function* (input) {
        const statuses = yield* result.skills(input.sessionID)
        const winner = statuses.find((status) => status.id === input.winner && status.state === "active")
        const loser = statuses.find((status) => status.id === input.loser && status.state === "active")
        if (
          !winner ||
          !loser ||
          !loser.conflicts.some((conflict) => conflict.type === "skill" && conflict.id === winner.id)
        )
          return yield* new SkillConflictNotFoundError({ winner: input.winner, loser: input.loser })
        yield* events.publish(SessionEvent.Skill.Deactivated, {
          sessionID: input.sessionID,
          id: loser.id,
          activationMessageID: loser.activationMessageID,
          reason: "conflict_resolved",
        })
      }),
      switchAgent: Effect.fn("Session.switchAgent")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if (input.agent && decisionAgents.has(input.agent)) return yield* new AgentNotSelectableError({ agent: input.agent })
        const source = yield* projectArtifactSource(session.location)
        const provenance = source ? yield* source.provenance("agent", input.agent) : undefined
        const activatedAt = ProjectArtifact.TimestampMillis.make(Date.now())
        return yield* events
          .publish(
            SessionEvent.AgentSelected,
            {
              sessionID: input.sessionID,
              agent: input.agent,
              artifact: provenance
                ? {
                    scopeID: provenance.scopeID,
                    versionID: provenance.versionID,
                    kind: provenance.kind,
                    id: provenance.id,
                    sourceScope: provenance.scope,
                  }
                : undefined,
            },
            {
              commit:
                provenance && source
                  ? (seq) =>
                      source
                        .activate({
                          kind: "agent",
                          id: input.agent,
                          sessionID: input.sessionID,
                          agentID: input.agent,
                          source: "agent-selected",
                          boundarySeq: ProjectArtifact.Revision.make(seq),
                          activatedAt,
                        })
                        .pipe(Effect.orDie)
                  : undefined,
            },
          )
          .pipe(Effect.asVoid)
      }),
      selectModelAtBoundary: Effect.fn("Session.selectModelAtBoundary")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if (!sameModel(session.model, input.expectedModel)) return { status: "conflict" } as const
        if (input.model.profile !== undefined && (!input.targetBinding || input.targetBinding.providerID !== input.model.providerID || input.targetBinding.profile !== input.model.profile))
          return yield* new SessionRunnerModel.ProfileUnavailableError({ providerID: input.model.providerID, profile: input.model.profile })
        const models = yield* SessionRunnerModel.Service.pipe(Effect.provide(locations.get(session.location)))
        const resolved = yield* models.resolve({ ...session, model: input.model }, { binding: input.targetBinding, refresh: false })
        if (resolved.connectionIdentityDigest !== input.connectionIdentityDigest) return { status: "conflict" } as const
        const catalog = yield* Catalog.Service.pipe(Effect.provide(locations.get(session.location)))
        const target = yield* catalog.model.get(input.model.providerID, input.model.id, input.model.profile)
        const policy = yield* compactionPolicy(session)
        const capabilities = SessionContextBudget.resolveCapabilities(target ? [target] : [], input.model.providerID, input.model.id, { safetyMarginTokens: policy.contextSafetyMarginTokens })
        if (capabilities === undefined || SessionContextBudget.safeInputBudget(capabilities) <= 0)
          return yield* new CompactionConflictError({ sessionID: session.id, jobID: ID.create(), message: "Target model has no positive input budget" })
        const checked = SessionModelSwitch.decide({ currentModel: session.model, targetModel: input.model, model: input.model, target: capabilities,
          messages: yield* SessionHistory.forModel(db, session.id), keepRecentMessages: policy.keepRecentMessages })
        if (checked.status === "blocked") return checked
        const unchanged = Effect.gen(function* () {
          if (!(yield* input.guard)) return false
          const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
          return row !== undefined && row.time_archived === null && row.directory === session.location.directory &&
            (row.workspace_id ?? undefined) === session.location.workspaceID && sameModel(row.model ?? undefined, input.expectedModel) &&
            JSON.stringify(row.profile_binding ?? undefined) === JSON.stringify(input.expectedBinding ?? undefined)
        })
        if (sameModel(session.model, input.model) && input.model.profile === undefined && !input.expectedBinding)
          return { status: (yield* unchanged) ? "switched" : "conflict" } as const
        const committed = yield* events.publishBatch([
          { definition: SessionEvent.ModelSelected, data: { sessionID: session.id, model: input.model } },
          ...(input.targetBinding || input.expectedBinding
            ? [{ definition: SessionEvent.ProfileBound, data: { sessionID: session.id, binding: input.targetBinding } }]
            : []),
        ], { when: unchanged })
        if (committed.length === 0) return { status: "conflict" } as const
        return { status: "switched" } as const
      }),
      switchModel: Effect.fn("Session.switchModel")(function* (input) {
        return yield* execution.withTransition(
          input.sessionID,
          Effect.gen(function* () {
            const current = yield* result.get(input.sessionID)
            if (sameModel(current.model, input.model) && input.model.profile === undefined)
              return { status: "switched" } as const
            // Validate the target before cancelling any work: an invalid target must leave the
            // active drain, the selected model, and every durable row untouched. The target
            // budget is validated unconditionally, including when the transcript is empty, so a
            // zero or unresolved budget can never be selected.
            const resolved = yield* validateModelSwitchTarget(current, input.model)
            const targetBudget = yield* modelSwitchTargetBudget(current, input.model)
            if (targetBudget === undefined || targetBudget <= 0)
              return yield* new CompactionConflictError({
                sessionID: input.sessionID,
                jobID: ID.create(),
                message: "Target model has no positive compaction input budget",
              })
            if ((yield* execution.active).has(input.sessionID)) {
              yield* execution.interrupt(input.sessionID)
              yield* execution.awaitIdle(input.sessionID)
            }
            const session = yield* result.get(input.sessionID)
            if (sameModel(session.model, input.model) && input.model.profile === undefined)
              return { status: "switched" } as const
            const checked = yield* checkModelSwitch(session, input.model)
            if (checked.status === "switched") {
              yield* events.publishBatch([
                { definition: SessionEvent.ModelSelected, data: { sessionID: session.id, model: input.model } },
                ...(resolved.profileBinding || session.model?.profile
                  ? [
                      {
                        definition: SessionEvent.ProfileBound,
                        data: { sessionID: session.id, binding: resolved.profileBinding },
                      },
                    ]
                  : []),
              ])
              const diagnostics = yield* store.diagnostics(session.id)
              if (diagnostics) yield* events.publish(SessionEvent.DiagnosticsUpdated, { sessionID: session.id, diagnostics })
              return { status: "switched" } as const
            }
            const compacted = yield* compactForModelSwitch(session, input.model, targetBudget)
            if (!compacted) return checked
            const reloaded = yield* result.get(input.sessionID)
            const fitted = yield* checkModelSwitch(reloaded, input.model)
            if (fitted.status === "blocked") return fitted
            yield* events.publishBatch([
              { definition: SessionEvent.ModelSelected, data: { sessionID: reloaded.id, model: input.model } },
              ...(resolved.profileBinding || reloaded.model?.profile
                ? [
                    {
                      definition: SessionEvent.ProfileBound,
                      data: { sessionID: reloaded.id, binding: resolved.profileBinding },
                    },
                  ]
                : []),
            ])
            const diagnostics = yield* store.diagnostics(reloaded.id)
            if (diagnostics) yield* events.publish(SessionEvent.DiagnosticsUpdated, { sessionID: reloaded.id, diagnostics })
            return { status: "switched" } as const
          }),
        )
      }),
      rename: Effect.fn("Session.rename")(function* (input) {
        yield* result.get(input.sessionID)
        yield* events.publish(SessionEvent.Renamed, {
          sessionID: input.sessionID,
          title: input.title,
        })
      }),
      daybreak: {
        set: Effect.fn("Session.daybreakSet")(function* (input) {
          yield* result.get(input.sessionID)
          yield* events.publish(SessionEvent.DaybreakSet, {
            sessionID: input.sessionID,
            ...(input.daybreak ? { daybreak: input.daybreak } : {}),
          })
          return yield* result.get(input.sessionID)
        }),
      },
      move: Effect.fn("Session.move")(function* (input) {
        const current = yield* result.get(input.sessionID)
        const value = input.directory.trim()
        const expanded =
          value === "~" ? global.home : value.startsWith("~/") ? path.join(global.home, value.slice(2)) : value
        const directory = AbsolutePath.make(path.resolve(current.location.directory, expanded))
        const info = yield* fs.stat(directory).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!info) return yield* new DestinationNotFoundError({ directory })
        if (info.type !== "Directory") return yield* new DestinationNotDirectoryError({ directory })
        if (current.location.directory === directory && current.location.workspaceID === input.workspaceID) return
        const project = yield* projects.resolve(directory)
        yield* db
          .insert(ProjectTable)
          .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        if (project.previous !== undefined && project.previous !== project.id) {
          const adoption = yield* db
            .transaction((tx) =>
              projectArtifactStore
                .adoptProject({ previousProjectID: project.previous!, projectID: project.id }, tx)
                .pipe(Effect.orDie),
            )
            .pipe(Effect.orDie)
          yield* adoption.postCommit.pipe(Effect.orDie)
        }
        if ((yield* execution.active).has(input.sessionID)) {
          yield* execution.interrupt(input.sessionID)
          yield* execution.awaitIdle(input.sessionID)
        }
        if (current.projectID !== project.id) {
          const destination = Location.Ref.make({ directory, workspaceID: input.workspaceID })
          yield* locations.invalidate(destination)
          const destinationServices = locations.get(destination)
          const oldSource = yield* projectArtifactSource(current.location)
          const oldAgent = current.agent && oldSource ? yield* oldSource.provenance("agent", current.agent) : undefined
          const destinationAgent = yield* Agent.Service.pipe(
            Effect.provide(destinationServices),
            Effect.flatMap((agents) => agents.default()),
          )
          const deactivatedAt = ProjectArtifact.TimestampMillis.make(Date.now())
          yield* events.publish(
            SessionEvent.ProjectArtifactsEnded,
            {
              sessionID: input.sessionID,
              oldProjectID: current.projectID,
              newProjectID: project.id,
            },
            {
              commit: (seq) =>
                projectArtifactAccounting
                  .deactivateProject({
                    sessionID: input.sessionID,
                    projectID: current.projectID,
                    boundarySeq: ProjectArtifact.Revision.make(seq),
                    deactivatedAt,
                  })
                  .pipe(Effect.asVoid),
            },
          )
          if (oldAgent?.scope === "project" && oldAgent.scopeID && destinationAgent) {
            yield* events.publish(SessionEvent.AgentSelected, {
              sessionID: input.sessionID,
              agent: destinationAgent.id,
            })
          }
        }
        yield* events.publish(SessionEvent.Moved, {
          sessionID: input.sessionID,
          location: Location.Ref.make({ directory, workspaceID: input.workspaceID }),
          projectID: project.id,
          subpath: RelativePath.make(path.relative(project.directory, directory).replaceAll("\\", "/")),
        })
      }),
      compact: Effect.fn("Session.compact")(function* (input: CompactInput) {
        const session = yield* result.get(input.sessionID)
        const jobID = input.id ?? ID.create()
        const boundary = yield* latestCompleteBoundary(db, input.sessionID)
        if (!boundary)
          return yield* new CompactionConflictError({
            sessionID: input.sessionID,
            jobID,
            message: "Session has no completed message boundary to compact",
          })
        const policy = yield* Config.Service.pipe(
          Effect.provide(locations.get(session.location)),
          Effect.flatMap((config) => config.entries()),
          Effect.map((entries) =>
            ConfigCompaction.resolve(
              entries
                .filter((entry): entry is Config.Document => entry.type === "document")
                .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : [])),
            ),
          ),
        )
        const resolved = yield* SessionRunnerModel.Service.pipe(
          Effect.provide(locations.get(session.location)),
          Effect.flatMap((models) => models.resolve(session)),
          Effect.mapError(
            (error) => new CompactionConflictError({ sessionID: input.sessionID, jobID, message: error.message }),
          ),
        )
        const limits = resolved.model.route.defaults.limits
        const contextWindowTokens = limits?.context ?? 0
        const hardInputCap = contextWindowTokens - policy.contextSafetyMarginTokens
        if (hardInputCap <= 0)
          return yield* new CompactionConflictError({
            sessionID: input.sessionID,
            jobID,
            message: "Selected model has no positive compaction input budget",
          })
        const targetMaxInputTokens = policy.advisory
          ? Math.floor((contextWindowTokens * policy.advisory.considerPercent) / 100)
          : hardInputCap
        const trigger = input.trigger ?? "manual"
        const configDigest = ConfigCompaction.admissionDigest(policy)
        const manifest = (job: SessionCompactionJob.Job) =>
          Effect.gen(function* () {
            const compaction = yield* SessionCompaction.Service
            return yield* compaction.manifest(job)
          }).pipe(Effect.provide(locations.get(session.location)))
        return yield* compactionJobs
          .withAdmissionGate(input.sessionID, (admit) =>
            Effect.gen(function* () {
              if (trigger === "consider" || trigger === "advised") {
                const current = yield* contextState.current(input.sessionID)
                const admission = {
                  id: jobID,
                  sessionID: input.sessionID,
                  trigger,
                  requestedThrough: boundary,
                  baseContextRevision: current.revision,
                  targetMaxInputTokens,
                  configDigest,
                  ...(((input as any).estimatedInputTokens as number | undefined) === undefined
                    ? {}
                    : {
                        pressure: {
                          estimatedInputTokens: (input as any).estimatedInputTokens as number,
                          safeInputTokens: hardInputCap,
                        },
                      }),
                } as const
                if (yield* compactionJobs.hasUnchangedDeterministicFailure(admission)) return undefined
                const admitted = yield* admit(admission)
                yield* compactionExecution.start({ jobID: admitted.id, manifest })
                return admitted
              }
              const active = (yield* compactionJobs.pending(input.sessionID))[0]
              if (active) return yield* compactionExecution.run({ jobID: active.id, manifest })
              const current = yield* contextState.current(input.sessionID)
              const admitted = yield* admit({
                id: jobID,
                sessionID: input.sessionID,
                trigger: "manual",
                requestedThrough: boundary,
                baseContextRevision: current.revision,
                targetMaxInputTokens,
                configDigest,
              })
              return yield* compactionExecution.run({ jobID: admitted.id, manifest })
            }),
          )
          .pipe(
            Effect.mapError(
              (error) => new CompactionConflictError({ sessionID: input.sessionID, jobID, message: error.message }),
            ),
          )
      }) as Compact,
      wait: Effect.fn("Session.wait")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.awaitIdle(sessionID)
      }),
      active: execution.active,
      completions: (input) => SessionCompletion.latest(db, input),
      outstanding: Effect.fn("Session.outstanding")(function* (includeFailures = false) {
        const tasks = yield* db
          .select({ sessionID: SessionTaskTable.parent_id })
          .from(SessionTaskTable)
          .where(inArray(SessionTaskTable.state, ["starting", "running", "waiting", "cancelling"]))
          .all()
          .pipe(Effect.orDie)
        const notices = yield* db
          .select({ sessionID: SessionTaskNotificationTable.parent_id })
          .from(SessionTaskNotificationTable)
          .where(eq(SessionTaskNotificationTable.delivered, false))
          .all()
          .pipe(Effect.orDie)
        const goals = yield* db
          .select({ sessionID: SessionTable.id })
          .from(SessionTable)
          .where(sql`json_extract(${SessionTable.autonomy}, '$.goal.status') = 'active'`)
          .all()
          .pipe(Effect.orDie)
        const shellJobs = yield* jobs.outstandingSessions()
        const pending = yield* db
          .select({ sessionID: SessionPendingTable.session_id })
          .from(SessionPendingTable)
          .groupBy(SessionPendingTable.session_id)
          .all()
          .pipe(Effect.orDie)
        const active = yield* execution.active
        const running = new Set([
          ...active,
          ...(yield* jobs.list()).flatMap((job) => {
            const sessionID = job.metadata?.sessionID
            return job.type === "shell" && job.status === "running" && Schema.is(SessionSchema.ID)(sessionID)
              ? [sessionID]
              : []
          }),
        ])
        const sessions = new Set(
          [...tasks, ...notices, ...goals, ...pending].map((row) => row.sessionID).concat([...shellJobs, ...active]),
        )
        const lost = new Set([...(yield* ShellLedger.lostSessions(db)), ...(yield* SessionTask.lostSessions(db))])
        if (!includeFailures) return { sessions, running, failed: new Set<SessionSchema.ID>(), lost }
        const startedType = Event.versionedType(
          SessionEvent.Execution.Started.type,
          SessionEvent.Execution.Started.durable.version,
        )
        const failedType = Event.versionedType(
          SessionEvent.Execution.Failed.type,
          SessionEvent.Execution.Failed.durable.version,
        )
        const latest = (type: string) =>
          sql`(select max(latest.seq) from ${EventTable} as latest
            where latest.aggregate_id = ${SessionTable.id} and latest.type = ${type})`
        const history = yield* db
          .select({
            aggregateID: EventTable.aggregate_id,
            type: EventTable.type,
            created: EventTable.created,
            id: EventTable.id,
          })
          .from(SessionTable)
          .crossJoin(EventTable)
          .where(
            and(
              eq(EventTable.aggregate_id, SessionTable.id),
              eq(EventTable.seq, sql`max(coalesce(${latest(startedType)}, -1), coalesce(${latest(failedType)}, -1))`),
            ),
          )
          .orderBy(asc(EventTable.created), asc(EventTable.id))
          .all()
          .pipe(Effect.orDie)
        const rows = yield* db
          .select({ id: SessionTable.id, parentID: SessionTable.parent_id })
          .from(SessionTable)
          .all()
          .pipe(Effect.orDie)
        const parents = new Map(rows.map((row) => [row.id, row.parentID]))
        const failed = new Set<SessionSchema.ID>()
        for (const event of history) {
          const seen = new Set<SessionSchema.ID>()
          let root = SessionSchema.ID.make(event.aggregateID)
          while (parents.get(root) && !seen.has(root)) {
            seen.add(root)
            root = parents.get(root)!
          }
          if (!parents.has(root) || seen.has(root)) continue
          if (event.type === failedType) failed.add(root)
          else failed.delete(root)
        }
        return { sessions, running, failed, lost }
      }),
      background: Effect.fn("Session.background")(function* (sessionID) {
        yield* result.get(sessionID)
        const backgrounded = yield* jobs.backgroundAll({ sessionID })
        if (backgrounded.length === 0) return
        yield* result
          .synthetic({
            sessionID,
            text: [
              "User requested that active blocking work be moved to the background.",
              "",
              "Backgrounded work:",
              ...backgrounded.map((job) => `- ${job.type}: ${job.title && job.title.length > 0 ? job.title : job.id}`),
              "",
              "The backgrounded work is still unfinished. Move on to other work if you can. If there is nothing else useful to do, finish your response. Do not wait, sleep, poll, or report the backgrounded work as complete until a later completion notification is added to the conversation.",
            ].join("\n"),
          })
          .pipe(Effect.catchTag("Session.SyntheticConflictError", Effect.die))
      }),
      resume: Effect.fn("Session.resume")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.resume(sessionID)
      }),
      synthetic: Effect.fn("Session.synthetic")((input) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* result.get(input.sessionID)
            const inputID = input.id ?? SessionMessage.ID.create()
            // A reused input ID is the same input: return the durable record and wake without
            // re-deriving content, matching prompt admission's idempotent retry semantics.
            const prior = yield* SessionPending.lookup(db, input.sessionID, inputID).pipe(
              Effect.catchDefect((defect) =>
                defect instanceof SessionPending.LifecycleConflict
                  ? new SyntheticConflictError({ sessionID: input.sessionID, inputID })
                  : Effect.die(defect),
              ),
            )
            const admitted =
              prior?.type === "synthetic" && prior.sessionID === input.sessionID
                ? prior
                : yield* Effect.gen(function* () {
                    const admitted = yield* SessionPending.admit(db, events, {
                      id: inputID,
                      sessionID: input.sessionID,
                      causedBy: input.causedBy,
                      input: SessionPending.Message.make({
                        type: "synthetic",
                        data: {
                          text: input.text,
                          description: input.description,
                          metadata: input.metadata,
                        },
                        delivery: input.delivery ?? "steer",
                      }),
                    }).pipe(
                      Effect.catchDefect((defect) =>
                        defect instanceof SessionPending.LifecycleConflict
                          ? new SyntheticConflictError({ sessionID: input.sessionID, inputID })
                          : Effect.die(defect),
                      ),
                    )
                    if (admitted.type !== "synthetic" || admitted.sessionID !== input.sessionID)
                      return yield* new SyntheticConflictError({ sessionID: input.sessionID, inputID })
                    return admitted
                  })
            if (input.resume !== false && !(yield* result.get(input.sessionID)).revert)
              yield* execution.wake(input.sessionID)
            return admitted
          }),
        ),
      ),
      interrupt: Effect.fn("Session.interrupt")((sessionID) => Effect.uninterruptible(Effect.gen(function* () {
        const project = yield* coordination.scopeOf(sessionID)
        if (project?.masterSessionID === sessionID) yield* coordination.pause(project.groupID)
        yield* execution.interrupt(sessionID)
      }))),
      revert: {
        stage: Effect.fn("Session.revert.stage")(function* (input) {
          const session = yield* result.get(input.sessionID)
          if ((yield* execution.active).has(input.sessionID))
            return yield* new BusyError({ sessionID: input.sessionID })
          return yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(EventRuntime.Service, events),
            Effect.provide(locations.get(session.location)),
          )
        }),
        clear: Effect.fn("Session.revert.clear")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          if ((yield* execution.active).has(sessionID)) return yield* new BusyError({ sessionID })
          const revert = yield* SessionRevert.clear(session).pipe(
            Effect.provideService(EventRuntime.Service, events),
            Effect.provide(locations.get(session.location)),
          )
          yield* execution.wake(sessionID)
          return revert
        }),
        commit: Effect.fn("Session.revert.commit")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          if ((yield* execution.active).has(sessionID)) return yield* new BusyError({ sessionID })
          const committed = yield* SessionRevert.commit(session).pipe(Effect.provideService(Database.Service, database), Effect.provideService(EventRuntime.Service, events))
          return committed
        }),
      },
    })

    return result
  }),
)

function missingShellOutput() {
  const output = "Shell command output is no longer available."
  return {
    output,
    cursor: Buffer.byteLength(output),
    size: Buffer.byteLength(output),
    truncated: false,
  }
}

function synthesizeTerminalShellInfo(started: ShellInfo): ShellInfo {
  return {
    ...started,
    // The Shell record was removed before waiters could observe it; publish a terminal
    // boundary instead of leaving the Session shell message permanently running.
    status: "killed",
    time: { ...started.time, completed: Date.now() },
  }
}

const resolvePrompt = Effect.fn("Session.resolvePrompt")(function* (
  input: PromptInput.Prompt,
  image: Effect.Effect<Image.Interface>,
  attachments: AttachmentStore.Interface,
  db: Database.Interface["db"],
) {
  const fs = yield* FSUtil.Service
  const files = input.files
    ? yield* Effect.forEach(input.files, (file) => materializeAttachment(fs, file, image, attachments, db), {
        concurrency: 8,
      })
    : undefined
  return Prompt.make({ text: input.text, agents: input.agents, files })
})

const RecordedAttachment = Schema.Struct({ content: ManagedAttachmentContent, mime: Schema.String })
const decodeRecordedAttachment = Schema.decodeUnknownOption(RecordedAttachment)

const recordedAttachment = Effect.fnUntraced(function* (db: Database.Interface["db"], uri: string) {
  const digest = AttachmentStore.managedDigest(uri)
  if (digest === undefined) return undefined
  const row = yield* db
    .get<{ bytes: unknown; path: unknown; mime: unknown }>(
      sql`
      SELECT json_extract(file.value, '$.content.bytes') AS bytes,
             json_extract(file.value, '$.content.path') AS path,
             json_extract(file.value, '$.mime') AS mime
      FROM event, json_each(event.data, '$.input.data.files') AS file
      WHERE event.type = 'session.input.admitted.1'
        AND json_extract(file.value, '$.content.type') = 'managed'
        AND json_extract(file.value, '$.content.digest') = ${digest}
      LIMIT 1
    `,
    )
    .pipe(Effect.orDie)
  if (!row) return undefined
  return Option.getOrUndefined(
    decodeRecordedAttachment({
      content: { type: "managed", digest, bytes: row.bytes, path: row.path },
      mime: row.mime,
    }),
  )
})

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

const materializeAttachment = Effect.fn("Session.materializeAttachment")(function* (
  fs: FSUtil.Interface,
  input: PromptInput.FileAttachment,
  image: Effect.Effect<Image.Interface>,
  attachments: AttachmentStore.Interface,
  db: Database.Interface["db"],
) {
  if (input.uri.startsWith("ycoding-attachment://")) {
    const stored = yield* attachments.resolveURI(input.uri).pipe(
      Effect.flatMap((content) =>
        attachments.read(content).pipe(Effect.map((bytes) => ({ content, mime: Mime.detect(bytes) }))),
      ),
      Effect.catchTag("AttachmentStore.Error", (error) =>
        Effect.gen(function* () {
          const recorded = yield* recordedAttachment(db, input.uri)
          if (!recorded) return yield* new AttachmentError({ uri: input.uri, message: error.message })
          yield* Effect.logWarning("Admitting a recorded attachment whose stored copy is unavailable", {
            digest: recorded.content.digest,
            reason: error.reason,
          })
          return recorded
        }),
      ),
    )
    return FileAttachment.create({
      content: stored.content,
      mime: stored.mime,
      name: input.name,
      description: input.description,
      mention: input.mention,
    })
  }
  const resolved = input.uri.startsWith("data:")
    ? {
        bytes: yield* decodeDataURL(input.uri),
        source: { type: "inline" as const },
        start: undefined,
        end: undefined,
        name: undefined,
        mime: undefined,
      }
    : yield* readFileAttachment(fs, input.uri)
  if (resolved.bytes.byteLength > MAX_ATTACHMENT_BYTES)
    return yield* new AttachmentError({
      uri: input.uri,
      message: `Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit: ${input.uri}`,
    })

  const mime = resolved.mime ?? Mime.detect(resolved.bytes)
  const content =
    mime === "text/plain" && resolved.start !== undefined
      ? Buffer.from(
          Buffer.from(resolved.bytes)
            .toString("utf8")
            .split("\n")
            .slice(resolved.start - 1, resolved.end)
            .join("\n"),
        )
      : resolved.bytes
  const normalized = yield* normalizeImageAttachment(input, content, mime, image)
  return FileAttachment.create({
    content: yield* attachments
      .import(normalized.bytes)
      .pipe(Effect.mapError((error) => new AttachmentError({ uri: input.uri, message: error.message }))),
    mime: normalized.mime,
    name: input.name ?? resolved.name,
    description: input.description,
    mention: input.mention,
  })
})

const normalizeImageAttachment = Effect.fn("Session.normalizeImageAttachment")(function* (
  input: PromptInput.FileAttachment,
  bytes: Uint8Array,
  mime: string,
  image: Effect.Effect<Image.Interface>,
) {
  if (!mime.startsWith("image/")) return { bytes, mime }
  const service = yield* image
  const label = input.name ?? (input.uri.startsWith("data:") ? "inline attachment" : input.uri)
  const content = {
    uri: label,
    content: Base64.make(Buffer.from(bytes).toString("base64")),
    encoding: "base64" as const,
    mime,
  }
  const normalized = yield* service.normalize(label, content).pipe(
    Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(content)),
    Effect.mapError((error) => new AttachmentError({ uri: label, message: error.message })),
  )
  return { bytes: Buffer.from(normalized.content, "base64"), mime: normalized.mime }
})

const readFileAttachment = Effect.fn("Session.readFileAttachment")(function* (fs: FSUtil.Interface, uri: string) {
  const url = yield* Effect.try({
    try: () => new URL(uri),
    catch: () => new AttachmentError({ uri, message: `Invalid attachment URI: ${uri}` }),
  })
  if (url.protocol !== "file:")
    return yield* new AttachmentError({ uri, message: `Unsupported attachment URI: ${uri}` })
  const start = positiveInt(url.searchParams.get("start"))
  const end = positiveInt(url.searchParams.get("end"))
  const target = yield* Effect.try({
    try: () => {
      url.search = ""
      url.hash = ""
      return fileURLToPath(url)
    },
    catch: () => new AttachmentError({ uri, message: `Invalid file URI: ${uri}` }),
  })
  const info = yield* fs
    .stat(target)
    .pipe(Effect.mapError(() => new AttachmentError({ uri, message: `Unable to read attachment: ${uri}` })))
  if (info.type === "Directory") {
    const entries = yield* fs
      .readDirectoryEntries(target)
      .pipe(Effect.mapError(() => new AttachmentError({ uri, message: `Unable to read attachment: ${uri}` })))
    return {
      bytes: Buffer.from(
        entries
          .filter((entry) => entry.type === "file" || entry.type === "directory")
          .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1))
          .map((entry) => entry.name + (entry.type === "directory" ? path.sep : ""))
          .join("\n"),
      ),
      source: { type: "uri" as const, uri },
      start: undefined,
      end: undefined,
      name: path.basename(target),
      mime: "application/x-directory",
    }
  }
  if (info.type !== "File") return yield* new AttachmentError({ uri, message: `Attachment is not a file: ${uri}` })
  if (Number(info.size) > MAX_ATTACHMENT_BYTES)
    return yield* new AttachmentError({
      uri,
      message: `Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit: ${uri}`,
    })
  const bytes = yield* fs
    .readFile(target)
    .pipe(Effect.mapError(() => new AttachmentError({ uri, message: `Unable to read attachment: ${uri}` })))
  return { bytes, source: { type: "uri" as const, uri }, start, end, name: path.basename(target), mime: undefined }
})

function decodeDataURL(uri: string) {
  return Effect.try({
    try: () => {
      const comma = uri.indexOf(",")
      if (comma === -1) throw new Error("Invalid data URL")
      const metadata = uri.slice(5, comma)
      const payload = uri.slice(comma + 1)
      if (!metadata.split(";").some((part) => part.toLowerCase() === "base64"))
        return Buffer.from(decodeURIComponent(payload))
      const bytes = Buffer.from(payload, "base64")
      if (bytes.toString("base64") !== payload) throw new Error("Non-canonical base64")
      return bytes
    },
    catch: () => new AttachmentError({ uri, message: "Invalid attachment data URL" }),
  })
}

function positiveInt(value: string | null) {
  if (value === null) return
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

const latestCompleteBoundary = Effect.fnUntraced(function* (db: Database.Interface["db"], sessionID: SessionSchema.ID) {
  const rows = yield* db
    .select({
      id: SessionMessageTable.id,
      seq: SessionMessageTable.seq,
      type: SessionMessageTable.type,
      data: SessionMessageTable.data,
    })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, sessionID))
    .orderBy(desc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const boundary = rows.find((row) => isCompleteMessage(row.type, row.data))
  if (!boundary) return undefined
  return { messageID: boundary.id, seq: boundary.seq }
})

function isCompleteMessage(type: SessionMessage.Type, data: unknown) {
  if (type === "user") return hasTime(data, "consumed")
  if (type === "assistant" || type === "shell") return hasTime(data, "completed")
  if (type !== "compaction") return true
  if (!isRecord(data)) return false
  return data.status === "completed"
}

function hasTime(data: unknown, key: string) {
  if (!isRecord(data) || !isRecord(data.time)) return false
  return typeof data.time[key] === "number"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isMissingLocation(value: unknown) {
  return isRecord(value) && value._tag === "PlatformError" && isRecord(value.reason) && value.reason._tag === "NotFound"
}

// Mirrors the shell tool's in-memory preview safety limit.
const SHELL_MAX_CAPTURE_BYTES = 1024 * 1024

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [
    Job.node,
    Database.node,
    EventRuntime.node,
    Project.node,
    CoordinationService.node,
    SessionExecution.node,
    SessionAutonomy.node,
    KeepAwake.node,
    SessionCompactionJob.node,
    SessionCompactionExecution.node,
    SessionContextState.node,
    SessionStore.node,
    SessionProviderRequest.node,
    RetentionSettings.node,
    LocationServiceMap.node,
    SessionProjector.node,
    SessionContextExclusionCleanup.node,
    SessionFileChangeCleanup.node,
    SessionUsageCleanup.node,
    FSUtil.node,
    Global.node,
    ProjectArtifactAccounting.node,
    ProjectArtifactStore.node,
    AttachmentStore.node,
  ],
})
