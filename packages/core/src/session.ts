export * as SessionV2 from "./session"
export * from "./session/schema"

import { DateTime, Effect, Layer, Schema, Context, Stream, Scope } from "effect"
import { ListAnchor } from "@ycoding-ai/schema/session"
import { ID, type Admission, type Result } from "@ycoding-ai/schema/session-compaction"
import { and, asc, desc, eq, gt, isNull, like, lt, or, type SQL } from "drizzle-orm"
import { ProjectV2 } from "./project"
import { WorkspaceV2 } from "./workspace"
import { ModelV2 } from "./model"
import { ProviderV2 } from "./provider"
import { Location } from "./location"
import { SessionMessage } from "./session/message"
import { InstructionState } from "./session/instruction-state"
import { SessionCacheDiagnostics } from "./session/cache-diagnostics"
import { SessionPermissionCeiling } from "./session/permission-ceiling"
import { SessionProviderRequest } from "./session/provider-request"
import { SessionUsage } from "./session/usage"
import type { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { SessionAutonomy } from "./session/autonomy"
import { SessionCompactionJob } from "./session/compaction-job"
import { SessionCompactionExecution } from "./session/compaction-execution"
import { SessionCompaction } from "./session/compaction"
import { SessionContextState } from "./session/context-state"
import { Info, list } from "./session/skill-status"
import { SessionGoal } from "./session/goal"
import { SessionGuardrail } from "./session/guardrail"
import { Base64, FileAttachment, Prompt } from "@ycoding-ai/schema/prompt"
import { PromptInput } from "@ycoding-ai/schema/prompt-input"
import { EventV2 } from "./event"
import { Database } from "./database/database"
import { SessionProjector } from "./session/projector"
import { SessionContextExclusionCleanup } from "./session/context-exclusion-cleanup"
import { SessionFileChangeCleanup } from "./session/file-change-cleanup"
import { SessionUsageCleanup } from "./session/usage-cleanup"
import { SessionFileChangeTable, SessionMessageTable, SessionTable, SessionTaskTable } from "./session/sql"
import { SessionSchema } from "./session/schema"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema"
import { AgentV2 } from "./agent"
import { ProjectTable } from "./project/sql"
import path from "path"
import { fromRow } from "./session/info"
import { SessionRunner } from "./session/runner/index"
import { SessionStore } from "./session/store"
import { SessionExecution } from "./session/execution"
import { AgentNotFoundError, MessageDecodeError, NotFoundError } from "./session/error"
import { makeGlobalNode } from "./effect/app-node"
import { LocationServiceMap } from "./location-service-map"
import { SessionEvent } from "./session/event"
import { SessionPending } from "./session/pending"
import { SessionGenerate } from "./session/generate"
import { Snapshot } from "./snapshot"
import { SessionRevert } from "./session/revert"
import { Session } from "@ycoding-ai/schema/session"
import { FSUtil } from "./fs-util"
import { Image } from "./image"
import { InstructionDiscovery } from "./instruction-discovery"
import { Instructions } from "./instructions"
import { Mime } from "./mime"
import type { EventLog } from "@ycoding-ai/schema/event-log"
import { SkillV2 } from "./skill"
import { Job } from "./job"
import { CommandV2 } from "./command"
import { Shell } from "./shell"
import { ShellSandbox } from "./shell-sandbox"
import { Global } from "./global"
import type { Info as ShellInfo } from "@ycoding-ai/schema/shell"
import { KeyedMutex } from "./effect/keyed-mutex"
import { fileURLToPath } from "url"
import { randomUUID } from "crypto"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { ProjectArtifactAccounting } from "./project-artifact/accounting"
import { ProjectArtifactStore } from "./project-artifact"
import { ProjectArtifactSource } from "./project-artifact/source"
import { SessionModelSwitch } from "./session/model-switch"
import { SessionHistory } from "./session/history"
import { SessionContextBudget } from "./session/context-budget"
import { SessionRunnerModel } from "./session/runner/model"
import { Catalog } from "./catalog"
import { Config } from "./config"
import { ConfigCompaction } from "./config/compaction"
import { AttachmentStore } from "./attachment-store"

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
  workspaceID: WorkspaceV2.ID.pipe(Schema.optional),
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
  project: ProjectV2.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

type CreateBaseInput = {
  id?: SessionSchema.ID
  title?: string
  agent?: AgentV2.ID
  model?: ModelV2.Ref
  permissionCeiling?: SessionSchema.Info["permissionCeiling"]
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
  yolo?: number | boolean
  goal?: string | null
  maxNoProgress?: number
  mode?: "normal" | "yolo" | "goal"
}

export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "Session.OperationUnavailableError",
  {
    operation: Schema.Literals(["move", "skill", "switchAgent", "compact"]),
  },
) {}

export { MessageDecodeError, NotFoundError }

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
  skill: SkillV2.ID,
}) {}
export class SkillConflictNotFoundError extends Schema.TaggedErrorClass<SkillConflictNotFoundError>()(
  "Session.SkillConflictNotFoundError",
  {
    winner: SkillV2.ID,
    loser: SkillV2.ID,
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
  | CommandV2.NotFoundError
  | CommandV2.EvaluationError
  | MessageNotFoundError
  | SessionGenerate.Error

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<{
    readonly data: SessionSchema.Info[]
  }>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly fork: (input: ForkInput) => Effect.Effect<SessionSchema.Info, NotFoundError | MessageNotFoundError>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly snapshot: (sessionID: SessionSchema.ID) => Effect.Effect<
    {
      readonly session: SessionSchema.Info
      readonly messages: SessionMessage.Info[]
      readonly watermark: EventLog.Synced
    },
    NotFoundError | MessageDecodeError
  >
  readonly remove: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly messages: (input: {
    sessionID: SessionSchema.ID
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      direction: "previous" | "next"
    }
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
    agent: AgentV2.ID
  }) => Effect.Effect<void, NotFoundError>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: ModelV2.Ref
  }) => Effect.Effect<SessionModelSwitch.Outcome, NotFoundError | MessageDecodeError>
  readonly rename: (input: { sessionID: SessionSchema.ID; title: string }) => Effect.Effect<void, NotFoundError>
  readonly move: (input: {
    sessionID: SessionSchema.ID
    directory: AbsolutePath
    workspaceID?: Location.Ref["workspaceID"]
  }) => Effect.Effect<void, NotFoundError | DestinationNotFoundError | DestinationNotDirectoryError>
  readonly prompt: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    text: string
    files?: PromptInput.Prompt["files"]
    agents?: PromptInput.Prompt["agents"]
    metadata?: Record<string, unknown>
    delivery?: SessionPending.Delivery
    resume?: boolean
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
  readonly autonomy: {
    readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionAutonomy.State, NotFoundError>
    readonly set: (input: AutonomyInput) => Effect.Effect<SessionAutonomy.State, NotFoundError>
  }
  readonly command: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    command: string
    arguments?: string
    agent?: AgentV2.ID
    model?: ModelV2.Ref
    files?: PromptInput.Prompt["files"]
    agents?: PromptInput.Prompt["agents"]
    delivery?: SessionPending.Delivery
    resume?: boolean
  }) => Effect.Effect<
    SessionPending.User,
    NotFoundError | PromptConflictError | AttachmentError | CommandV2.NotFoundError | CommandV2.EvaluationError
  >
  readonly shell: (input: {
    id?: EventV2.ID
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
    skill: SkillV2.ID
    resume?: boolean
  }) => Effect.Effect<void, NotFoundError | SkillNotFoundError>
  readonly resolveSkillConflict: (input: {
    sessionID: SessionSchema.ID
    winner: SkillV2.ID
    loser: SkillV2.ID
  }) => Effect.Effect<void, NotFoundError | AgentNotFoundError | MessageDecodeError | SkillConflictNotFoundError>
  readonly compact: Compact
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
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
  }) => Effect.Effect<SessionPending.Synthetic, NotFoundError | SyntheticConflictError>
  readonly revert: {
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<Session.Revert, NotFoundError | MessageNotFoundError | BusyError | Snapshot.Error>
    readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | BusyError | Snapshot.Error>
    readonly commit: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | BusyError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/Session") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const global = yield* Global.Service
    const execution = yield* SessionExecution.Service
    const autonomy = yield* SessionAutonomy.Service
    const compactionJobs = yield* SessionCompactionJob.Service
    const compactionExecution = yield* SessionCompactionExecution.Service
    const contextState = yield* SessionContextState.Service
    const store = yield* SessionStore.Service
    const providerRequests = yield* SessionProviderRequest.Service
    const locations = yield* LocationServiceMap.Service
    const fs = yield* FSUtil.Service
    const attachments = yield* AttachmentStore.Service
    const jobs = yield* Job.Service
    const projectArtifactAccounting = yield* ProjectArtifactAccounting.Service
    const projectArtifactStore = yield* ProjectArtifactStore.Service
    const scope = yield* Scope.Scope
    const activeShells = new Set<SessionSchema.ID>()
    const shellLocks = KeyedMutex.makeUnsafe<SessionSchema.ID>()
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Info)
    const isPublicDurableSessionEvent = Schema.is(SessionEvent.PublicDurable)
    const projectArtifactSource = Effect.fnUntraced(function* (location: Location.Ref) {
      return yield* ProjectArtifactSource.Service.pipe(
        Effect.map((source): ProjectArtifactSource.Interface | undefined => source),
        Effect.provide(locations.get(location)),
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
    })
    // Context validation for a model switch resolves the target in the Session's
    // Location-scoped registry. The transcript read below is durable database work.
    const checkModelSwitch = Effect.fnUntraced(function* (session: SessionSchema.Info, targetModel: ModelV2.Ref) {
      const resolution = yield* Effect.gen(function* () {
        const catalog = yield* Catalog.Service.pipe(Effect.provide(locations.get(session.location)))
        const config = yield* Config.Service.pipe(Effect.provide(locations.get(session.location)))
        const compaction = ConfigCompaction.resolve(
          (yield* config.entries())
            .filter((entry): entry is Config.Document => entry.type === "document")
            .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : [])),
        )
        return {
          target: SessionContextBudget.resolveCapabilities(
            yield* catalog.model.available(),
            targetModel.providerID,
            targetModel.id,
            {
              safetyMarginTokens: compaction.contextSafetyMarginTokens,
            },
          ),
          keepRecentMessages: compaction.keepRecentMessages,
        }
      })
      const messages = yield* SessionHistory.forModel(db, session.id)
      return SessionModelSwitch.decide({
        currentModel: session.model,
        targetModel,
        messages,
        model: session.model ?? targetModel,
        target: resolution.target,
        keepRecentMessages: resolution.keepRecentMessages,
      })
    })
    const family = Effect.fnUntraced(function* (session: SessionSchema.Info) {
      if (session.parentID) return [session]
      const sessions = [session]
      for (const current of sessions) {
        const children = yield* result.list({ parentID: current.id })
        sessions.push(...children.data)
      }
      return sessions
    })
    const estimated = Effect.fnUntraced(function* (
      session: SessionSchema.Info,
      records: ReadonlyArray<ProviderRequest.Record>,
    ) {
      const catalog = yield* Catalog.Service.pipe(Effect.provide(locations.get(session.location)))
      return yield* Effect.forEach(records, (record) => {
        if (record.cost !== undefined) return Effect.succeed(record)
        return Effect.gen(function* () {
          const provider = yield* catalog.model.get(record.model.providerID, record.model.id)
          const openrouter = yield* catalog.model.get(
            ProviderV2.ID.openrouter,
            ModelV2.ID.make(
              record.model.providerID === ProviderV2.ID.openrouter
                ? record.model.id
                : `${record.model.providerID}/${record.model.id}`,
            ),
          )
          const cost = SessionUsage.estimatedCatalogCost(provider?.cost ?? [], openrouter?.cost ?? [], record.tokens)
          return cost === undefined ? record : { ...record, cost: cost.cost, costProvenance: "current_catalog" }
        })
      })
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

    const result = Service.of({
      create: Effect.fn("V2Session.create")(function* (input) {
        const sessionID = input.id ?? SessionSchema.ID.create()
        const recorded = yield* store.get(sessionID)
        if (recorded) return recorded
        const parent = input.parentID ? yield* store.get(input.parentID) : undefined
        if (input.parentID && parent === undefined) return yield* new NotFoundError({ sessionID: input.parentID })
        const location = parent?.location ?? input.location
        if (location === undefined)
          return yield* Effect.die(new Error("V2Session.create requires either location or an existing parentID"))
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
        const projected = yield* events
          .publish(
            SessionEvent.Created,
            {
              sessionID,
              projectID: project.id,
              location,
              parentID: input.parentID,
              agent: input.agent,
              model: input.model,
              permissionCeiling: permissionCeiling.length > 0 ? permissionCeiling : undefined,
              title: input.title ?? `New session - ${new Date(now).toISOString()}`,
              subpath: relative.length > 0 ? RelativePath.make(relative) : undefined,
              created: now,
            },
            { location },
          )
          .pipe(
            Effect.as({ type: "created" } as const),
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
      fork: Effect.fn("V2Session.fork")(function* (input) {
        const parent = yield* result.get(input.sessionID)
        const boundary = input.messageID
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.messageID)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.messageID && !boundary)
          return yield* new MessageNotFoundError({ sessionID: input.sessionID, messageID: input.messageID })
        const sessionID = SessionSchema.ID.create()
        const parentSeq = boundary ? boundary.seq - 1 : yield* EventV2.latestSequence(db, parent.id)
        yield* events.publish(SessionEvent.Forked, {
          sessionID,
          parentID: parent.id,
          parentSeq,
          from: input.messageID,
        })
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      get: Effect.fn("V2Session.get")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        return session
      }),
      snapshot: Effect.fn("V2Session.snapshot")(function* (sessionID) {
        return yield* db
          .transaction(() =>
            Effect.gen(function* () {
              const session = yield* result.get(sessionID)
              const messages = yield* SessionHistory.load(db, sessionID)
              const sequence = yield* EventV2.latestSequence(db, sessionID)
              const watermark: EventLog.Synced = {
                type: "log.synced",
                aggregateID: sessionID,
                ...(sequence < 0 ? {} : { seq: EventV2.Seq.make(sequence) }),
              }
              return {
                session,
                messages,
                watermark,
              }
            }),
          )
          .pipe(Effect.orDie)
      }),
      diagnostics: Effect.fn("V2Session.diagnostics")(function* (sessionID) {
        const session = yield* result.get(sessionID)
        const diagnostics = SessionCacheDiagnostics.fromMessages(
          yield* store.context(sessionID),
          session.revert?.messageID,
        )
        if (!diagnostics) return diagnostics
        return { ...diagnostics, requests: yield* providerRequests.summary(sessionID) }
      }),
      usage: Effect.fn("V2Session.usage")(function* (sessionID) {
        const session = yield* result.get(sessionID)
        const records = yield* Effect.forEach(yield* family(session), (item) =>
          providerRequests.list(item.id).pipe(Effect.flatMap((records) => estimated(item, records))),
        )
        return SessionProviderRequest.summarize(
          records
            .flat()
            .toSorted((left, right) => DateTime.toEpochMillis(left.time) - DateTime.toEpochMillis(right.time)),
        )
      }),
      autonomy: {
        get: Effect.fn("V2Session.autonomy.get")(function* (sessionID) {
          yield* result.get(sessionID)
          return yield* autonomy
            .get(sessionID)
            .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.fail(new NotFoundError({ sessionID }))))
        }),
        set: Effect.fn("V2Session.autonomy.set")(function* (input) {
          const session = yield* result.get(input.sessionID)
          let yolo = input.yolo
          let goal: string | null | undefined = input.goal as string | null | undefined
          if (input.mode !== undefined) {
            if (input.mode === "yolo") yolo = yolo ?? true
            else if (input.mode === "normal") yolo = yolo ?? false
            else if (input.mode === "goal" && goal === undefined) goal = (input as { goal?: string }).goal ?? undefined
          }
          if (typeof goal === "string") {
            const rawText = goal.trim()
            const goals = yield* SessionGoal.Service.pipe(Effect.provide(locations.get(session.location)))
            const synthesized = yield* goals.synthesize({ session, text: rawText })
            const state = yield* autonomy
              .set({
                sessionID: input.sessionID,
                yolo,
                goal: synthesized ?? rawText,
                rawText,
                maxNoProgress: input.maxNoProgress,
              })
              .pipe(
                Effect.catchTag("SessionAutonomy.NotFound", () =>
                  Effect.fail(new NotFoundError({ sessionID: input.sessionID })),
                ),
              )
            if (state.goal?.status === "active") {
              const startText = SessionAutonomy.continuationPrompt(state.goal)
              const startID = SessionMessage.ID.make(
                `msg_goal_${(yield* Effect.sync(() => randomUUID())).slice(0, 24)}`,
              )
              const startInput = SessionPending.Message.make({
                type: "synthetic",
                data: {
                  text: startText,
                  description: "Autonomous goal start",
                  metadata: { autonomy: { yolo: state.yolo, goal: true, iteration: state.goal.iteration } },
                },
                delivery: "steer",
              })
              yield* SessionPending.admit(db, events, { id: startID, sessionID: input.sessionID, input: startInput }).pipe(
                Effect.catchDefect((defect) =>
                  defect instanceof SessionPending.LifecycleConflict ? Effect.void : Effect.die(defect),
                ),
              )
              if (state.goal) yield* execution.wake(input.sessionID).pipe(Effect.orDie)
            }
            return state
          }
          return yield* autonomy
            .set({
              sessionID: input.sessionID,
              yolo,
              goal,
              maxNoProgress: input.maxNoProgress,
            })
            .pipe(
              Effect.catchTag("SessionAutonomy.NotFound", () =>
                Effect.fail(new NotFoundError({ sessionID: input.sessionID })),
              ),
            )
        }),
      },
      remove: Effect.fn("V2Session.remove")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.interrupt(sessionID)
        yield* execution.awaitIdle(sessionID)
        const children = yield* result.list({ parentID: sessionID })
        yield* Effect.forEach(children.data, (child) => result.remove(child.id), { concurrency: 1, discard: true })
        yield* events.publish(SessionEvent.Deleted, { sessionID })
        yield* events.remove(sessionID)
      }),
      list: Effect.fn("V2Session.list")(function* (input = {}) {
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
      messages: Effect.fn("V2Session.messages")(function* (input) {
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
        const boundary = anchor
          ? order === "asc"
            ? gt(SessionMessageTable.seq, anchor.seq)
            : lt(SessionMessageTable.seq, anchor.seq)
          : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)
        const query = db
          .select()
          .from(SessionMessageTable)
          .where(where)
          .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return yield* Effect.forEach(direction === "previous" ? rows.toReversed() : rows, decode)
      }),
      message: Effect.fn("V2Session.message")(function* (input) {
        const stored = yield* store.message(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      context: Effect.fn("V2Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      fileChanges: Effect.fn("V2Session.fileChanges")(function* (sessionID) {
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
      skills: Effect.fn("V2Session.skills")(function* (sessionID) {
        const session = yield* result.get(sessionID)
        const rows = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .orderBy(asc(SessionMessageTable.seq))
          .all()
          .pipe(Effect.orDie)
        const messages = yield* Effect.forEach(rows, decode)
        const contextModule = yield* Effect.promise<typeof import("./session/context")>(
          () => import("./session/" + "context"),
        )
        const context = yield* contextModule.SessionContext.Service.pipe(
          Effect.provide(locations.get(session.location)),
        )
        const selection = yield* context.select(sessionID)
        const keys = yield* InstructionState.activeKeys(db, selection.instructions, sessionID)
        return list(messages, keys)
      }),
      pending: Effect.fn("V2Session.pending")(function* (sessionID) {
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
              EventV2.isSynced(item) || isPublicDurableSessionEvent(item),
          ),
        ),
      prompt: Effect.fn("V2Session.prompt")((input) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const session = yield* result.get(input.sessionID)
            // A staged revert must be committed before admitting new input so the prompt
            // continues from the reverted boundary rather than stale post-boundary history.
            if (session.revert)
              yield* SessionRevert.commit(session).pipe(Effect.provideService(EventV2.Service, events))
            // Resolved lazily so prompt admission only boots location services when an
            // image attachment actually needs the resizer.
            const image = Image.Service.pipe(Effect.provide(locations.get(session.location)))
            const prompt = yield* resolvePrompt(
              { text: input.text, files: input.files, agents: input.agents },
              image,
              attachments,
            ).pipe(Effect.provideService(FSUtil.Service, fs))
            const messageID = input.id ?? SessionMessage.ID.create()
            const activeGoal = (yield* autonomy.get(input.sessionID).pipe(Effect.orDie)).goal?.status === "active"
            const alreadyAdmitted =
              activeGoal &&
              ((yield* SessionPending.find(db, messageID)) !== undefined ||
                (yield* SessionHistory.load(db, input.sessionID).pipe(Effect.orDie)).some(
                  (message) => message.id === messageID,
                ))
            const admittedInput = SessionPending.Message.make({
              type: "user",
              data: { ...prompt, metadata: input.metadata },
              delivery: input.delivery ?? "steer",
            })
            const admitted = yield* SessionPending.admit(db, events, {
              id: messageID,
              sessionID: input.sessionID,
              input: admittedInput,
            }).pipe(
              Effect.catchDefect((defect) =>
                defect instanceof SessionPending.LifecycleConflict
                  ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                  : Effect.die(defect),
              ),
            )
            if (
              admitted.type !== "user" ||
              !SessionPending.equivalent(admitted, { sessionID: input.sessionID, input: admittedInput })
            )
              return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
            if (activeGoal && !alreadyAdmitted) {
              const goals = yield* SessionGoal.Service.pipe(Effect.provide(locations.get(session.location)))
              const rawText = admitted.data.text.trim()
              const synthesized = yield* goals.synthesize({ session, text: rawText })
              yield* autonomy.set({
                sessionID: input.sessionID,
                goal: synthesized ?? rawText,
                rawText,
              }).pipe(Effect.orDie)
            }
            if (input.resume !== false) {
              if (activeShells.has(admitted.sessionID)) {
                // Admit-only during an active shell strands the prompt until
                // the shell's ensuring wake fires; name it so "pending but
                // idle" is diagnosable (TUI also shows a queued notice).
                yield* Effect.logWarning("Session prompt queued during active shell; wake deferred", {
                  inputID: admitted.id,
                }).pipe(Effect.annotateLogs({ sessionID: admitted.sessionID }))
                return admitted
              }
              yield* execution.wake(admitted.sessionID)
            }
            return admitted
          }),
        ),
      ),
      generate: Effect.fn("V2Session.generate")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const generate = yield* SessionGenerate.Service.pipe(Effect.provide(locations.get(session.location)))
        return yield* generate.generate(input)
      }),
      command: Effect.fn("V2Session.command")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const commands = yield* CommandV2.Service.pipe(Effect.provide(locations.get(session.location)))
        const source = yield* projectArtifactSource(session.location)
        const command = yield* commands.get(input.command)
        if (!command)
          return yield* new CommandV2.NotFoundError({
            command: input.command,
            message: `Command not found: ${input.command}`,
          })
        const evaluated = yield* commands.evaluate({ name: input.command, arguments: input.arguments })

        // TODO(v2 commands): decide whether command-level subtask/background execution belongs in v2 commands.
        const agent = command.agent ?? input.agent
        const commandAgent = yield* Effect.gen(function* () {
          if (!command.agent) return undefined
          const agents = yield* AgentV2.Service.pipe(Effect.provide(locations.get(session.location)))
          return yield* agents.get(AgentV2.ID.make(command.agent))
        })
        const model = command.model ?? commandAgent?.model ?? input.model
        if (agent !== undefined && session.agent !== AgentV2.ID.make(agent))
          yield* result.switchAgent({ sessionID: input.sessionID, agent: AgentV2.ID.make(agent) })
        // A blocked switch is advisory for command execution: the command still runs on the
        // current model rather than failing the whole command. Transcript corruption is a
        // defect and fails loudly for both the switch and the following prompt.
        if (model !== undefined)
          yield* result
            .switchModel({ sessionID: input.sessionID, model })
            .pipe(Effect.asVoid, Effect.catchTag("Session.MessageDecodeError", Effect.die))
        const provenance = source ? yield* source.provenance("command", input.command) : undefined

        const admitted = yield* result.prompt({
          id: input.id,
          sessionID: input.sessionID,
          text: evaluated.text,
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
              boundarySeq: ProjectArtifact.Revision.make(0),
              messageID: admitted.id,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("project artifact command activation failed", { cause, sessionID: input.sessionID }),
              ),
            )
        return admitted
      }),
      shell: Effect.fn("V2Session.shell")(function* (input) {
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
      skill: Effect.fn("V2Session.skill")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const skills = yield* SkillV2.Service.pipe(Effect.provide(locations.get(session.location)))
        const source = yield* projectArtifactSource(session.location)
        const skill = (yield* skills.list()).find((item) => item.id === input.skill)
        if (!skill) return yield* new SkillNotFoundError({ skill: input.skill })
        const provenance = source ? yield* source.provenance("skill", skill.id) : undefined
        yield* events.publish(
          SessionEvent.Skill.Activated,
          {
            sessionID: input.sessionID,
            id: skill.id,
            name: skill.name,
            text: skill.content,
            conflicts: skill.conflicts,
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
            id: input.id ? EventV2.ID.make(input.id.replace(/^msg_/, "evt_")) : undefined,
            commit: provenance
              ? (seq) =>
                  projectArtifactAccounting
                    .activate(
                      ProjectArtifact.Activation.make({
                        id: ProjectArtifact.ActivationID.make(`paa_${randomUUID()}`),
                        artifact: {
                          scopeID: provenance.scopeID,
                          kind: provenance.kind,
                          id: provenance.id,
                          versionID: provenance.versionID,
                        },
                        projectID: session.projectID,
                        sessionID: input.sessionID,
                        agentID: session.agent,
                        source: "session-skill",
                        messageID: input.id,
                        boundarySeq: ProjectArtifact.Revision.make(seq),
                        activatedAt: ProjectArtifact.TimestampMillis.make(Date.now()),
                      }),
                    )
                    .pipe(Effect.asVoid, Effect.orDie)
              : undefined,
          },
        )
        if (input.resume !== false)
          yield* execution
            .resume(input.sessionID)
            .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
      }),
      resolveSkillConflict: Effect.fn("V2Session.resolveSkillConflict")(function* (input) {
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
      switchAgent: Effect.fn("V2Session.switchAgent")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const source = yield* projectArtifactSource(session.location)
        const provenance = source ? yield* source.provenance("agent", input.agent) : undefined
        const activatedAt = ProjectArtifact.TimestampMillis.make(Date.now())
        yield* events.publish(
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
      }),
      switchModel: Effect.fn("V2Session.switchModel")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if (
          session.model?.providerID === input.model.providerID &&
          session.model.id === input.model.id &&
          (session.model.variant ?? "default") === (input.model.variant ?? "default")
        )
          return { status: "switched" }
        const checked = yield* checkModelSwitch(session, input.model)
        if (checked.status === "blocked") return checked
        yield* events.publish(SessionEvent.ModelSelected, {
          sessionID: session.id,
          model: input.model,
        })
        return { status: "switched" }
      }),
      rename: Effect.fn("V2Session.rename")(function* (input) {
        yield* result.get(input.sessionID)
        yield* events.publish(SessionEvent.Renamed, {
          sessionID: input.sessionID,
          title: input.title,
        })
      }),
      move: Effect.fn("V2Session.move")(function* (input) {
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
          const destinationAgent = yield* AgentV2.Service.pipe(
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
      compact: Effect.fn("V2Session.compact")(function* (input: CompactInput) {
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
        const hardInputCap = (limits?.context ?? 0) - (limits?.output ?? 0) - policy.contextSafetyMarginTokens
        if (hardInputCap <= 0)
          return yield* new CompactionConflictError({
            sessionID: input.sessionID,
            jobID,
            message: "Selected model has no positive compaction input budget",
          })
        const targetMaxInputTokens = policy.advisory
          ? Math.floor((hardInputCap * policy.advisory.considerPercent) / 100)
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
                yield* compactionExecution.run({ jobID: admitted.id, manifest })
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
      wait: Effect.fn("V2Session.wait")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.awaitIdle(sessionID)
      }),
      active: execution.active,
      background: Effect.fn("V2Session.background")(function* (sessionID) {
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
      resume: Effect.fn("V2Session.resume")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.resume(sessionID)
      }),
      synthetic: Effect.fn("V2Session.synthetic")((input) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* result.get(input.sessionID)
            const inputID = input.id ?? SessionMessage.ID.create()
            const admittedInput = SessionPending.Message.make({
              type: "synthetic",
              data: {
                text: input.text,
                description: input.description,
                metadata: input.metadata,
              },
              delivery: input.delivery ?? "steer",
            })
            const admitted = yield* SessionPending.admit(db, events, {
              id: inputID,
              sessionID: input.sessionID,
              input: admittedInput,
            }).pipe(
              Effect.catchDefect((defect) =>
                defect instanceof SessionPending.LifecycleConflict
                  ? new SyntheticConflictError({ sessionID: input.sessionID, inputID })
                  : Effect.die(defect),
              ),
            )
            if (
              admitted.type !== "synthetic" ||
              !SessionPending.equivalent(admitted, { sessionID: input.sessionID, input: admittedInput })
            )
              return yield* new SyntheticConflictError({ sessionID: input.sessionID, inputID })
            if (input.resume !== false && !(yield* result.get(input.sessionID)).revert)
              yield* execution.wake(input.sessionID)
            return admitted
          }),
        ),
      ),
      interrupt: Effect.fn("V2Session.interrupt")((sessionID) =>
        Effect.uninterruptible(execution.interrupt(sessionID)),
      ),
      revert: {
        stage: Effect.fn("V2Session.revert.stage")(function* (input) {
          const session = yield* result.get(input.sessionID)
          if ((yield* execution.active).has(input.sessionID))
            return yield* new BusyError({ sessionID: input.sessionID })
          return yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
        }),
        clear: Effect.fn("V2Session.revert.clear")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          if ((yield* execution.active).has(sessionID)) return yield* new BusyError({ sessionID })
          const revert = yield* SessionRevert.clear(session).pipe(
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
          yield* execution.wake(sessionID)
          return revert
        }),
        commit: Effect.fn("V2Session.revert.commit")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          if ((yield* execution.active).has(sessionID)) return yield* new BusyError({ sessionID })
          return yield* SessionRevert.commit(session).pipe(Effect.provideService(EventV2.Service, events))
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

const resolvePrompt = Effect.fn("V2Session.resolvePrompt")(function* (
  input: PromptInput.Prompt,
  image: Effect.Effect<Image.Interface>,
  attachments: AttachmentStore.Interface,
) {
  const fs = yield* FSUtil.Service
  const files = input.files
    ? yield* Effect.forEach(input.files, (file) => materializeAttachment(fs, file, image, attachments), {
        concurrency: 8,
      })
    : undefined
  return Prompt.make({ text: input.text, agents: input.agents, files })
})

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

const materializeAttachment = Effect.fn("V2Session.materializeAttachment")(function* (
  fs: FSUtil.Interface,
  input: PromptInput.FileAttachment,
  image: Effect.Effect<Image.Interface>,
  attachments: AttachmentStore.Interface,
) {
  if (input.uri.startsWith("ycoding-attachment://")) {
    const content = yield* attachments
      .resolveURI(input.uri)
      .pipe(Effect.mapError((error) => new AttachmentError({ uri: input.uri, message: error.message })))
    const bytes = yield* attachments
      .read(content)
      .pipe(Effect.mapError((error) => new AttachmentError({ uri: input.uri, message: error.message })))
    return FileAttachment.create({
      content,
      mime: Mime.detect(bytes),
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

const normalizeImageAttachment = Effect.fn("V2Session.normalizeImageAttachment")(function* (
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

const readFileAttachment = Effect.fn("V2Session.readFileAttachment")(function* (fs: FSUtil.Interface, uri: string) {
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
  return data.status === "completed" || data.status === "failed"
}

function hasTime(data: unknown, key: string) {
  if (!isRecord(data) || !isRecord(data.time)) return false
  return typeof data.time[key] === "number"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

// Mirrors the shell tool's in-memory preview safety limit.
const SHELL_MAX_CAPTURE_BYTES = 1024 * 1024

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [
    Job.node,
    Database.node,
    EventV2.node,
    ProjectV2.node,
    SessionExecution.node,
    SessionAutonomy.node,
    SessionCompactionJob.node,
    SessionCompactionExecution.node,
    SessionContextState.node,
    SessionStore.node,
    SessionProviderRequest.node,
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
