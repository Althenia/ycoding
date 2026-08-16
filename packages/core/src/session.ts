export * as SessionV2 from "./session"
export * from "./session/schema"

import { Effect, Layer, Schema, Context, Stream, Scope } from "effect"
import { ListAnchor } from "@ycoding-ai/schema/session"
import { and, asc, desc, eq, gt, isNull, like, lt, or, type SQL } from "drizzle-orm"
import { ProjectV2 } from "./project"
import { WorkspaceV2 } from "./workspace"
import { ModelV2 } from "./model"
import { Location } from "./location"
import { SessionMessage } from "./session/message"
import { InstructionState } from "./session/instruction-state"
import { SessionCacheDiagnostics } from "./session/cache-diagnostics"
import { SessionPermissionCeiling } from "./session/permission-ceiling"
import { SessionProviderRequest } from "./session/provider-request"
import { SessionAutonomy } from "./session/autonomy"
import { Info, list } from "./session/skill-status"
import { SessionGoal } from "./session/goal"
import { SessionGuardrail } from "./session/guardrail"
import { Base64, FileAttachment, Prompt } from "@ycoding-ai/schema/prompt"
import { PromptInput } from "@ycoding-ai/schema/prompt-input"
import { EventV2 } from "./event"
import { Database } from "./database/database"
import { SessionProjector } from "./session/projector"
import { SessionMessageTable, SessionTable } from "./session/sql"
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

type CompactInput = {
  id?: SessionMessage.ID
  sessionID: SessionSchema.ID
}

type ForkInput = {
  sessionID: SessionSchema.ID
  messageID?: SessionMessage.ID
}

type AutonomyInput =
  | { sessionID: SessionSchema.ID; mode: "normal" | "yolo" }
  | {
      sessionID: SessionSchema.ID
      mode: "goal"
      goal: string
      maxNoProgress?: number
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
}) {}
export class SyntheticConflictError extends Schema.TaggedErrorClass<SyntheticConflictError>()(
  "Session.SyntheticConflictError",
  {
    sessionID: SessionSchema.ID,
    inputID: SessionMessage.ID,
  },
) {}
export class AttachmentError extends Schema.TaggedErrorClass<AttachmentError>()("Session.AttachmentError", {
  uri: Schema.String,
  message: Schema.String,
}) {}
export class CompactionConflictError extends Schema.TaggedErrorClass<CompactionConflictError>()(
  "Session.CompactionConflictError",
  {
    sessionID: SessionSchema.ID,
    inputID: SessionMessage.ID,
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
  }) => Effect.Effect<void, NotFoundError>
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
    NotFoundError | ShellSandbox.Unavailable | Shell.SpawnError | SessionGuardrail.AssertError
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
  readonly compact: (
    input: CompactInput,
  ) => Effect.Effect<SessionPending.Compaction, NotFoundError | CompactionConflictError>
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
    const store = yield* SessionStore.Service
    const providerRequests = yield* SessionProviderRequest.Service
    const locations = yield* LocationServiceMap.Service
    const fs = yield* FSUtil.Service
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
        const permissionCeiling = SessionPermissionCeiling.inherit(
          parent?.permissionCeiling,
          input.permissionCeiling,
        )
        const relative = path.relative(project.directory, location.directory).replaceAll("\\", "/")
        const projected = yield* events.publish(
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
        ).pipe(
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
      diagnostics: Effect.fn("V2Session.diagnostics")(function* (sessionID) {
        const session = yield* result.get(sessionID)
        const diagnostics = SessionCacheDiagnostics.fromMessages(
          yield* store.context(sessionID),
          session.revert?.messageID,
        )
        if (!diagnostics) return diagnostics
        return { ...diagnostics, requests: yield* providerRequests.summary(sessionID) }
      }),
      autonomy: {
        get: Effect.fn("V2Session.autonomy.get")(function* (sessionID) {
          yield* result.get(sessionID)
          return yield* autonomy.get(sessionID).pipe(
            Effect.catchTag("SessionAutonomy.NotFound", () => Effect.fail(new NotFoundError({ sessionID }))),
          )
        }),
        set: Effect.fn("V2Session.autonomy.set")(function* (input) {
          const session = yield* result.get(input.sessionID)
          if (input.mode !== "goal")
            return yield* autonomy.setMode({ sessionID: input.sessionID, mode: input.mode }).pipe(
              Effect.catchTag("SessionAutonomy.NotFound", () =>
                Effect.fail(new NotFoundError({ sessionID: input.sessionID })),
              ),
            )
          const rawText = input.goal.trim()
          const goals = yield* SessionGoal.Service.pipe(Effect.provide(locations.get(session.location)))
          const synthesized = yield* goals.synthesize({ session, text: rawText })
          return yield* autonomy.setGoal({
            sessionID: input.sessionID,
            text: synthesized ?? rawText,
            rawText,
            maxNoProgress: input.maxNoProgress,
          }).pipe(
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
        const contextModule = yield* Effect.promise<typeof import("./session/context")>(() => import("./session/" + "context"))
        const context = yield* contextModule.SessionContext.Service.pipe(Effect.provide(locations.get(session.location)))
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
            ).pipe(Effect.provideService(FSUtil.Service, fs))
            const messageID = input.id ?? SessionMessage.ID.create()
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
            if (input.resume !== false) {
              if (activeShells.has(admitted.sessionID)) return admitted
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
        if (model !== undefined) yield* result.switchModel({ sessionID: input.sessionID, model })
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
            commit: provenance && source
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
          return
        yield* events.publish(SessionEvent.ModelSelected, {
          sessionID: input.sessionID,
          model: input.model,
        })
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
        if (
          current.location.directory === directory &&
          current.location.workspaceID === input.workspaceID
        )
          return
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
      compact: Effect.fn("V2Session.compact")(function* (input) {
        yield* result.get(input.sessionID)
        const inputID = input.id ?? SessionMessage.ID.create()
        const admitted = yield* SessionPending.admitCompaction(db, events, {
          id: inputID,
          sessionID: input.sessionID,
        }).pipe(
          Effect.catchDefect((defect) =>
            defect instanceof SessionPending.LifecycleConflict
              ? new CompactionConflictError({ sessionID: input.sessionID, inputID })
              : Effect.die(defect),
          ),
        )
        yield* execution.wake(input.sessionID)
        return admitted
      }),
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
) {
  const fs = yield* FSUtil.Service
  const files = input.files
    ? yield* Effect.forEach(input.files, (file) => materializeAttachment(fs, file, image), { concurrency: 8 })
    : undefined
  return Prompt.make({ text: input.text, agents: input.agents, files })
})

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

const materializeAttachment = Effect.fn("V2Session.materializeAttachment")(function* (
  fs: FSUtil.Interface,
  input: PromptInput.FileAttachment,
  image: Effect.Effect<Image.Interface>,
) {
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
  const normalized = yield* normalizeImageAttachment(
    input,
    Base64.make(Buffer.from(content).toString("base64")),
    mime,
    image,
  )
  return FileAttachment.create({
    data: normalized.data,
    mime: normalized.mime,
    source: resolved.source,
    name: input.name ?? resolved.name,
    description: input.description,
    mention: input.mention,
  })
})

const normalizeImageAttachment = Effect.fn("V2Session.normalizeImageAttachment")(function* (
  input: PromptInput.FileAttachment,
  data: Base64,
  mime: string,
  image: Effect.Effect<Image.Interface>,
) {
  if (!mime.startsWith("image/")) return { data, mime }
  const service = yield* image
  const label = input.name ?? (input.uri.startsWith("data:") ? "inline attachment" : input.uri)
  const content = { uri: label, content: data, encoding: "base64" as const, mime }
  const normalized = yield* service.normalize(label, content).pipe(
    Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(content)),
    Effect.mapError((error) => new AttachmentError({ uri: label, message: error.message })),
  )
  return { data: Base64.make(normalized.content), mime: normalized.mime }
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
    SessionStore.node,
    SessionProviderRequest.node,
    LocationServiceMap.node,
    SessionProjector.node,
    FSUtil.node,
    Global.node,
    ProjectArtifactAccounting.node,
    ProjectArtifactStore.node,
  ],
})
