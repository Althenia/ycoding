import { SessionMessage } from "@ycoding-ai/schema/session-message"
import { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import { SessionPending } from "@ycoding-ai/schema/session-pending"
import { PromptInput } from "@ycoding-ai/schema/prompt-input"
import { AttachmentDigest, Base64 } from "@ycoding-ai/schema/prompt"
import { Session } from "@ycoding-ai/schema/session"
import { SessionAutonomy } from "@ycoding-ai/schema/session-autonomy"
import { SessionCacheDiagnostics } from "@ycoding-ai/schema/session-cache-diagnostics"
import { InstructionEntry } from "@ycoding-ai/schema/instruction-entry"
import { Project } from "@ycoding-ai/schema/project"
import { AbsolutePath, NonNegativeInt, PositiveInt, RelativePath, statics } from "@ycoding-ai/schema/schema"
import { Event } from "@ycoding-ai/schema/event"
import { Workspace } from "@ycoding-ai/schema/workspace"
import { SessionOrchestration } from "@ycoding-ai/schema/session-orchestration"
import { SessionDelivery } from "@ycoding-ai/schema/session-delivery"
import { Context, Effect, Encoding, Result, Schema, SchemaGetter, Struct, Tuple } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  ConflictError,
  CommandEvaluationError,
  CommandNotFoundError,
  HistoryPrunedError,
  InvalidCursorError,
  InvalidRequestError,
  MessageNotFoundError,
  ModelSwitchBlockedError,
  ServiceUnavailableError,
  SessionBusyError,
  SessionNotFoundError,
  AttachmentNotFoundError,
  AttachmentTooLargeError,
  SkillConflictNotFoundError,
  SkillNotFoundError,
  UnknownError,
  ForbiddenError,
  QuestionNotFoundError,
} from "../errors.js"
import { Agent } from "@ycoding-ai/schema/agent"
import { Skill } from "@ycoding-ai/schema/skill"
import { Model } from "@ycoding-ai/schema/model"
import { Location } from "@ycoding-ai/schema/location"
import { SessionEvent } from "@ycoding-ai/schema/session-event"
import { SessionTodo } from "@ycoding-ai/schema/session-todo"
import { EventLog } from "@ycoding-ai/schema/event-log"
import { SessionSkillStatus } from "@ycoding-ai/schema/session-skill-status"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { UsageAccounting } from "@ycoding-ai/schema/usage-accounting"
import { SourceEpoch } from "@ycoding-ai/schema/source-epoch"
import { SessionWorkCompletion } from "@ycoding-ai/schema/session-work-completion"

const ParentIDFilter = Schema.Union([
  Session.ID,
  Schema.Null.pipe(
    Schema.encodeTo(Schema.Literal("null"), {
      decode: SchemaGetter.transform(() => null),
      encode: SchemaGetter.transform(() => "null" as const),
    }),
  ),
]).annotate({
  description: "Filter by parent session. Use null to return only root sessions.",
})

export const SessionCompletionsQuery = Schema.Struct({
  after: Session.ID.pipe(Schema.optional),
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt.check(Schema.isLessThanOrEqualTo(200))), Schema.optional),
})

const SessionsQueryFields = {
  workspace: Workspace.ID.pipe(Schema.optional),
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional).annotate({
    description: "Maximum number of sessions to return. Defaults to the newest 50 sessions.",
  }),
  order: Schema.optional(Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")])).annotate({
    description: "Session order for the first page. Use desc for newest first or asc for oldest first.",
  }),
  search: Schema.optional(Schema.String),
  parentID: ParentIDFilter.pipe(Schema.optional),
}

const SessionsDirectoryQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath,
})

const SessionsProjectQuery = Schema.Struct({
  ...SessionsQueryFields,
  project: Project.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const SessionsAllQuery = Schema.Struct(SessionsQueryFields)

const withCursor = <Fields extends Schema.Struct.Fields>(schema: Schema.Struct<Fields>) =>
  schema.mapFields((fields) => ({
    ...Struct.omit(fields, ["limit"]),
    anchor: Session.ListAnchor,
  }))

const SessionsCursorInput = Schema.Union([
  withCursor(SessionsDirectoryQuery),
  withCursor(SessionsProjectQuery),
  withCursor(SessionsAllQuery),
])
const SessionsCursorJson = Schema.fromJsonString(SessionsCursorInput)
const encodeSessionsCursor = Schema.encodeSync(SessionsCursorJson)
const decodeSessionsCursor = Schema.decodeUnknownEffect(SessionsCursorJson)
const invalidCursor = "Invalid cursor" as const

export const SessionsCursor = Schema.String.pipe(
  Schema.brand("SessionsCursor"),
  statics((schema) => {
    const make = schema.make.bind(schema)
    return {
      make: (input: typeof SessionsCursorInput.Type) => make(Encoding.encodeBase64Url(encodeSessionsCursor(input))),
      parse: (input: string) =>
        Effect.suspend(() => {
          const result = Encoding.decodeBase64UrlString(input)
          return Result.isFailure(result)
            ? Effect.fail(invalidCursor)
            : decodeSessionsCursor(result.success).pipe(Effect.mapError(() => invalidCursor))
        }),
    }
  }),
)
export type SessionsCursor = typeof SessionsCursor.Type

const SubagentCursorInput = Schema.Struct({
  parentID: Session.ID,
  anchor: SessionOrchestration.ListAnchor,
})
const SubagentCursorJson = Schema.fromJsonString(SubagentCursorInput)
const encodeSubagentCursor = Schema.encodeSync(SubagentCursorJson)
const decodeSubagentCursor = Schema.decodeUnknownEffect(SubagentCursorJson)

export const SubagentCursor = Schema.String.pipe(
  Schema.brand("SubagentCursor"),
  statics((schema) => {
    const make = schema.make.bind(schema)
    return {
      make: (input: typeof SubagentCursorInput.Type) => make(Encoding.encodeBase64Url(encodeSubagentCursor(input))),
      parse: (input: string) =>
        Effect.suspend(() => {
          const result = Encoding.decodeBase64UrlString(input)
          return Result.isFailure(result)
            ? Effect.fail(invalidCursor)
            : decodeSubagentCursor(result.success).pipe(Effect.mapError(() => invalidCursor))
        }),
    }
  }),
)
export type SubagentCursor = typeof SubagentCursor.Type

const SessionActive = Schema.Struct({
  type: Schema.Literal("running"),
}).annotate({ identifier: "SessionActive" })

const BooleanFromString = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === "true"),
    encode: SchemaGetter.transform((value): "true" | "false" => (value ? "true" : "false")),
  }),
)

export const SessionOutstandingQuery = Schema.Struct({ failures: BooleanFromString.pipe(Schema.optional) })

export const SessionAutonomyMode = Schema.Literals(["normal"]).annotate({
  identifier: "SessionAutonomyMode",
})
export const SessionAutonomyGoalStatus = Schema.Literals(["active", "completed", "stopped", "exhausted"]).annotate({
  identifier: "SessionAutonomyGoalStatus",
})
export const SessionAutonomyGoal = Schema.Struct({
  text: Schema.String,
  status: SessionAutonomyGoalStatus,
  iteration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  noProgress: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  maxNoProgress: PositiveInt,
  lastProgressDigest: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "SessionAutonomyGoal" })
export const SessionAutonomySleep = Schema.Struct({}).pipe(Schema.decodeTo(Schema.Struct({}), {
  decode: SchemaGetter.transform(() => ({})),
  encode: SchemaGetter.transform(() => ({})),
})).annotate({ identifier: "SessionAutonomySleep" })
export const SessionAutonomyState = Schema.Struct({
  mode: SessionAutonomyMode,
  ...SessionAutonomy.Decisions.fields,
  goal: SessionAutonomyGoal.pipe(Schema.optional),
  sleep: SessionAutonomySleep.pipe(Schema.optional),
}).annotate({ identifier: "SessionAutonomyState" })
export const SessionAutonomyEffective = Schema.Struct({
  ...SessionAutonomy.Decisions.fields,
  inherited: Schema.Struct({
    permissions: Session.ID.pipe(Schema.optional),
    guardrails: Session.ID.pipe(Schema.optional),
    answers: Session.ID.pipe(Schema.optional),
  }),
  asleep: Schema.Boolean,
  guardrailsEnabled: Schema.Boolean,
}).annotate({ identifier: "SessionAutonomyEffective" })
export const SessionAutonomyView = Schema.Struct({
  ...SessionAutonomyState.fields,
  effective: SessionAutonomyEffective,
}).annotate({ identifier: "SessionAutonomyView" })
const AutonomyControlsAbsent = {
  yolo: Schema.Never.pipe(Schema.optional),
  autoPermission: Schema.Never.pipe(Schema.optional),
  autoGuardrail: Schema.Never.pipe(Schema.optional),
  autoAnswer: Schema.Never.pipe(Schema.optional),
  permissions: Schema.Never.pipe(Schema.optional),
  guardrails: Schema.Never.pipe(Schema.optional),
  answers: Schema.Never.pipe(Schema.optional),
  sleep: Schema.Never.pipe(Schema.optional),
  goal: Schema.Never.pipe(Schema.optional),
  maxNoProgress: Schema.Never.pipe(Schema.optional),
}
export const SessionAutonomySet = Schema.Union([
  Schema.Struct({
    ...AutonomyControlsAbsent,
    goal: Schema.Union([Schema.Trim.pipe(Schema.check(Schema.isNonEmpty())), Schema.Literal(true), Schema.Null]),
    maxNoProgress: PositiveInt.pipe(Schema.optional),
  }),
  Schema.Struct({
    ...AutonomyControlsAbsent,
    permissions: SessionAutonomy.DecisionMode,
    guardrails: SessionAutonomy.DecisionMode.pipe(Schema.optional),
    answers: SessionAutonomy.DecisionMode.pipe(Schema.optional),
  }),
  Schema.Struct({
    ...AutonomyControlsAbsent,
    sleep: Schema.Boolean,
  }),
  Schema.Struct({
    ...AutonomyControlsAbsent,
    permissions: SessionAutonomy.DecisionMode.pipe(Schema.optional),
    guardrails: SessionAutonomy.DecisionMode,
    answers: SessionAutonomy.DecisionMode.pipe(Schema.optional),
  }),
  Schema.Struct({
    ...AutonomyControlsAbsent,
    permissions: SessionAutonomy.DecisionMode.pipe(Schema.optional),
    guardrails: SessionAutonomy.DecisionMode.pipe(Schema.optional),
    answers: SessionAutonomy.DecisionMode,
  }),
]).annotate({ identifier: "SessionAutonomySet" })

export const SessionSubagentLaunch = Schema.Struct({
  parentAssistantMessageID: SessionMessage.ID,
  toolCallID: SessionOrchestration.ToolCallID,
  agent: Agent.ID,
  description: SessionOrchestration.DescriptionText,
  prompt: SessionOrchestration.PromptText,
  background: Schema.Boolean.pipe(Schema.optional),
  model: Model.Ref.pipe(Schema.optional),
}).annotate({ identifier: "SessionSubagentLaunch" })

export const SessionSubagentMessage = Schema.Struct({
  messageID: SessionMessage.ID,
  text: SessionOrchestration.ControlText,
  delivery: SessionDelivery.Delivery,
}).annotate({ identifier: "SessionSubagentMessage" })

export const SessionSubagentAnswer = Schema.Struct({
  text: SessionOrchestration.ControlText.pipe(Schema.optional),
  data: SessionOrchestration.AnswerData.pipe(Schema.optional),
}).annotate({ identifier: "SessionSubagentAnswer" })

export const SessionSubagentModel = Schema.Struct({
  expectedModel: Model.Ref,
  model: Model.Ref,
}).annotate({ identifier: "SessionSubagentModel" })

const SubagentPageLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(10))
export const SessionSubagentListQuery = Schema.Struct({
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(SubagentPageLimit), Schema.optional),
  cursor: SubagentCursor.pipe(Schema.optional),
}).annotate({ identifier: "SessionSubagentListQuery" })

export const SessionUsageReportQuery = Schema.Struct({
  group: ProviderRequest.ReportGroup,
  providerID: ProviderRequest.ReportInput.fields.providerID,
  profile: ProviderRequest.ReportInput.fields.profile,
  modelID: ProviderRequest.ReportInput.fields.modelID,
  selectedEffort: ProviderRequest.ReportInput.fields.selectedEffort,
  timeZone: Schema.String.pipe(Schema.optional),
  from: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
  to: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
  offset: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional),
  sort: ProviderRequest.ReportSort.pipe(Schema.optional),
  order: ProviderRequest.ReportOrder.pipe(Schema.optional),
})
  .pipe(Schema.decodeTo(ProviderRequest.ReportInput))
  .annotate({ identifier: "SessionUsageReportQuery" })

const SessionsQueryCursor = SessionsCursor.annotate({
  description: "Opaque pagination cursor returned as cursor.previous or cursor.next in the previous response.",
})

export const SessionSkillConflictResolve = Schema.Struct({
  winner: Skill.ID,
  loser: Skill.ID,
})

export const SessionsQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath.pipe(Schema.optional),
  project: Project.ID.pipe(Schema.optional),
  subpath: RelativePath.pipe(Schema.optional),
  cursor: SessionsQueryCursor.pipe(Schema.optional),
}).annotate({ identifier: "SessionsQuery" })

export const SessionProjection = Schema.Struct({
  sourceEpoch: SourceEpoch,
  session: Session.Info,
  messages: Schema.Array(SessionMessage.Info),
  watermark: EventLog.Synced,
  generationSpeed: SessionCacheDiagnostics.GenerationSpeedHistory.pipe(Schema.optional),
  before: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).pipe(Schema.optional),
}).annotate({ identifier: "SessionProjection" })
export type SessionProjection = typeof SessionProjection.Type

export const SessionSnapshotQuery = Schema.Struct({
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt.check(Schema.isLessThanOrEqualTo(200))), Schema.optional),
  before: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).pipe(Schema.optional),
}).annotate({ identifier: "SessionSnapshotQuery" })

export const SessionLogItem = Schema.Union([...SessionEvent.PublicDurable.members, EventLog.Synced])
  .mapMembers(Tuple.map(Schema.fieldsAssign({ sourceEpoch: SourceEpoch })))
  .annotate({ identifier: "SessionLogItem" })
export type SessionLogItem = typeof SessionLogItem.Type

export const makeSessionGroup = <I extends HttpApiMiddleware.AnyId, S>(sessionLocationMiddleware: Context.Key<I, S>) =>
  HttpApiGroup.make("server.session")
    .add(
      HttpApiEndpoint.get("session.list", "/api/session", {
        query: SessionsQuery,
        success: Schema.Struct({
          data: Schema.Array(Session.Info),
          cursor: Schema.Struct({
            previous: SessionsCursor.pipe(Schema.optional),
            next: SessionsCursor.pipe(Schema.optional),
          }),
        }).annotate({ identifier: "SessionsResponse" }),
        error: [InvalidCursorError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.list",
          summary: "List sessions",
          description:
            "Retrieve sessions in the requested order. Items keep that order across pages; use cursor.next or cursor.previous to move through the ordered list.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.create", "/api/session", {
        payload: Schema.Struct({
          id: Session.ID.pipe(Schema.optional),
          parentID: Session.ID.pipe(Schema.optional),
          title: Schema.String.pipe(Schema.optional),
          agent: Agent.ID.pipe(Schema.optional),
          model: Model.Ref.pipe(Schema.optional),
          location: Location.Ref.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: Session.Info }),
        error: [SessionNotFoundError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.create",
          summary: "Create session",
          description: "Create a root session at the requested location or a child session under an existing parent.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.active", "/api/session/active", {
        success: Schema.Struct({ data: Schema.Record(Session.ID, SessionActive) }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.active",
          summary: "List active sessions",
          description:
            "Retrieve foreground Session drains currently owned by this YCoding process. Sessions absent from the result are inactive.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.outstanding", "/api/session/outstanding", {
        query: SessionOutstandingQuery,
        success: Schema.Struct({ data: Schema.Array(Session.ID), running: Schema.Array(Session.ID), failed: Schema.Array(Session.ID), lost: Schema.Array(Session.ID) }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.outstanding",
          summary: "List outstanding Session work",
          description: "List Sessions with executing drains, admitted inputs, background shell notices, active subagent tasks or notices, or active goals in this process. Separately report Sessions with executing drains or live shell jobs as running; a settled shell awaiting notification is outstanding but not running. Optionally include roots whose latest execution failed until their family next starts. `lost` lists Sessions whose background shell completion notice a server restart lost, until that Session next starts an execution; loss is attention, not failed or outstanding work.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.completions", "/api/session/completions", {
        query: SessionCompletionsQuery,
        success: SessionWorkCompletion.Page,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.completions",
          summary: "List accepted root work completions",
          description: "Return the latest accepted durable completion receipt per root Session, ordered by Session ID with an exclusive after cursor. Limit defaults to 200 and must be between 1 and 200. Receipt sequence numbers belong to their own Session, not a global event cursor.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.get", "/api/session/:sessionID", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Session.Info }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.get",
            summary: "Get session",
            description: "Retrieve a session by ID.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.snapshot", "/api/session/:sessionID/snapshot", {
        params: { sessionID: Session.ID },
        query: SessionSnapshotQuery,
        success: SessionProjection,
        error: [SessionNotFoundError, InvalidCursorError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.snapshot",
            summary: "Get a session synchronization snapshot",
            description:
              "Atomically retrieve the canonical projected messages and exact durable event watermark for one server process epoch. Optional limit and before page backward through projected messages. When the session has a completed compaction checkpoint, paging stops at the checkpoint: the oldest page begins with the synthetic checkpoint message and no cursor addresses history before it.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.attachment.read", "/api/session/:sessionID/attachment/:digest", {
        params: { sessionID: Session.ID, digest: AttachmentDigest },
        success: Schema.Struct({ mime: Schema.String, bytes: NonNegativeInt, data: Base64 }),
        error: [SessionNotFoundError, AttachmentNotFoundError, AttachmentTooLargeError, InvalidRequestError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({
          identifier: "session.attachment.read",
          summary: "Read a Session's managed user attachment",
          description: "Return bounded base64 content only for a managed file referenced by this Session's projected user messages.",
        })),
    )
    .add(
      HttpApiEndpoint.get("session.diagnostics", "/api/session/:sessionID/diagnostics", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Session.CacheDiagnostics.pipe(Schema.optional) }),
        error: [SessionNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.diagnostics",
            summary: "Get session cache diagnostics",
            description:
              "Retrieve normalized context occupancy, provider cache usage, and the bounded latest cache invalidation reason for the latest assistant step after the last completed compaction.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.autonomy.get", "/api/session/:sessionID/autonomy", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: SessionAutonomyView }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.autonomy.get",
            summary: "Get session autonomy",
            description: "Retrieve Session approval, auto-answer, goal and sleep state with effective approval and review policy.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.put("session.autonomy.set", "/api/session/:sessionID/autonomy", {
        params: { sessionID: Session.ID },
        payload: SessionAutonomySet,
        success: Schema.Struct({ data: SessionAutonomyView }),
        error: [SessionNotFoundError, InvalidRequestError, ConflictError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.autonomy.set",
            summary: "Set session autonomy",
            description: "Set YOLO level; calculate and activate a user-supplied goal string, resume the retained goal with true without recalculating its objective, or stop it with null.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.delete("session.remove", "/api/session/:sessionID", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.remove",
            summary: "Delete session",
            description: "Delete a session and its child sessions.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.archive", "/api/session/:sessionID/archive", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.archive",
            summary: "Archive session",
            description: "Archive a session without deleting its durable history.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.delete("session.unarchive", "/api/session/:sessionID/archive", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.unarchive",
            summary: "Unarchive session",
            description: "Restore an archived session before retention cleanup deletes it.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.pin", "/api/session/:sessionID/pin", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.pin",
            summary: "Pin session",
            description: "Pin a session so every client lists it with the pinned sessions.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.delete("session.unpin", "/api/session/:sessionID/pin", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.unpin",
            summary: "Unpin session",
            description: "Remove a session from the pinned sessions.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.subagent.list", "/api/session/:parentID/subagent", {
        params: { parentID: Session.ID },
        query: SessionSubagentListQuery,
        success: SessionOrchestration.Page,
        error: [SessionNotFoundError, InvalidCursorError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.subagent.list",
            summary: "List direct subagents",
            description: "List one bounded page of durable task records for direct managed child Sessions.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.subagent.launch", "/api/session/:parentID/subagent", {
        params: { parentID: Session.ID },
        payload: SessionSubagentLaunch,
        success: Schema.Struct({ data: SessionOrchestration.Task }),
        error: [SessionNotFoundError, InvalidRequestError, ConflictError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.subagent.launch",
            summary: "Launch subagent",
            description: "Preflight and durably launch one direct child Session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.subagent.message", "/api/session/:parentID/subagent/:childID/message", {
        params: { parentID: Session.ID, childID: Session.ID },
        payload: SessionSubagentMessage,
        success: Schema.Struct({ data: SessionOrchestration.Task }),
        error: [SessionNotFoundError, ForbiddenError, ConflictError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "session.subagent.message", summary: "Message subagent" })),
    )
    .add(
      HttpApiEndpoint.post(
        "session.subagent.answer",
        "/api/session/:parentID/subagent/:childID/question/:questionID/answer",
        {
          params: { parentID: Session.ID, childID: Session.ID, questionID: SessionOrchestration.QuestionID },
          payload: SessionSubagentAnswer,
          success: Schema.Struct({ data: SessionOrchestration.Task }),
          error: [SessionNotFoundError, QuestionNotFoundError, ForbiddenError, ConflictError, InvalidRequestError],
        },
      )
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({ identifier: "session.subagent.answer", summary: "Answer subagent question" }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.subagent.cancel", "/api/session/:parentID/subagent/:childID/cancel", {
        params: { parentID: Session.ID, childID: Session.ID },
        success: Schema.Struct({ data: SessionOrchestration.Task }),
        error: [SessionNotFoundError, ForbiddenError, ConflictError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "session.subagent.cancel", summary: "Cancel subagent" })),
    )
    .add(
      HttpApiEndpoint.post("session.subagent.switchModel", "/api/session/:parentID/subagent/:childID/model", {
        params: { parentID: Session.ID, childID: Session.ID },
        payload: SessionSubagentModel,
        success: Schema.Struct({ data: SessionOrchestration.Task }),
        error: [SessionNotFoundError, ForbiddenError, ConflictError, InvalidRequestError, ModelSwitchBlockedError, UnknownError],
      }).annotateMerge(OpenApi.annotations({
        identifier: "session.subagent.switchModel",
        summary: "Select a direct managed child's model",
        description: "Native parent-only selection at the next logical-Step boundary. Compare expectedModel, preserve the existing profile binding, and refuse incompatible model, variant, profile or context without interrupting or waking the child. The response reports the committed selection, not an executing request. Remote and Dots callers have no access.",
      })),
    )
    .add(
      HttpApiEndpoint.post("session.subagent.resume", "/api/session/:parentID/subagent/:childID/resume", {
        params: { parentID: Session.ID, childID: Session.ID },
        success: Schema.Struct({ data: SessionOrchestration.Task }),
        error: [SessionNotFoundError, ForbiddenError, ConflictError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "session.subagent.resume", summary: "Resume subagent" })),
    )
    .add(
      HttpApiEndpoint.get("session.todo.list", "/api/session/:sessionID/todo", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(SessionTodo.Info) }),
        error: SessionNotFoundError,
      }).middleware(sessionLocationMiddleware),
    )
    .add(
      HttpApiEndpoint.put("session.todo.update", "/api/session/:sessionID/todo", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ todos: Schema.Array(SessionTodo.Info) }),
        success: Schema.Struct({ data: Schema.Array(SessionTodo.Info) }),
        error: SessionNotFoundError,
      }).middleware(sessionLocationMiddleware),
    )
    .add(
      HttpApiEndpoint.post("session.fork", "/api/session/:sessionID/fork", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ messageID: SessionMessage.ID.pipe(Schema.optional) }),
        success: Schema.Struct({ data: Session.Info }),
        error: [SessionNotFoundError, MessageNotFoundError, HistoryPrunedError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.fork",
            summary: "Fork session",
            description:
              "Create a child session by copying retained history from the parent. When messageID is supplied, copy messages before that boundary. A parent with a completed compaction checkpoint contributes a copy of its checkpoint message followed by the retained messages after it; a messageID that is not in that retained history fails with HistoryPrunedError (410).",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchAgent", "/api/session/:sessionID/agent", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ agent: Agent.ID }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, InvalidRequestError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.switchAgent",
            summary: "Switch session agent",
            description: "Switch the agent used by subsequent provider turns.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchModel", "/api/session/:sessionID/model", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ model: Model.Ref }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, ModelSwitchBlockedError, UnknownError, InvalidRequestError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.switchModel",
            summary: "Switch session model",
            description:
              "Validate the target, interrupt active execution and await settlement, compact model-visible context if needed, then switch in the same Session. Preserve raw history and do not replay interrupted work. Refuse selection if context still cannot fit the target model.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.rename", "/api/session/:sessionID/rename", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ title: Schema.String }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.rename",
            summary: "Rename session",
            description: "Update the session title.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.daybreak.set", "/api/session/:sessionID/daybreak", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ daybreak: Model.Daybreak.pipe(Schema.NullOr) }),
        success: Schema.Struct({ data: Session.Info }),
        error: [SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.daybreak.set",
            summary: "Set Daybreak",
            description:
              "Set or clear the Session's Daybreak cyber access program (daybreak_blue or daybreak_red; null clears). ChatGPT-authenticated OpenAI requests then include access_programs.cyber only for models whose advertised daybreak list contains that program.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.move", "/api/session/:sessionID/move", {
        params: { sessionID: Session.ID },
        payload: Location.Ref,
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, InvalidRequestError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.move",
            summary: "Move session",
            description: "Move a session to another project directory, optionally transferring local changes.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.prompt", "/api/session/:sessionID/prompt", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional),
          ...PromptInput.Prompt.fields,
          metadata: SessionPending.UserData.fields.metadata,
          delivery: SessionPending.Delivery.pipe(Schema.optional),
          resume: Schema.Boolean.pipe(Schema.optional),
        }).annotate({ parseOptions: { onExcessProperty: "error" } }),
        success: Schema.Struct({ data: SessionPending.User }),
        error: [ConflictError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt",
            summary: "Send message",
            description: "Durably admit one session input and schedule agent-loop execution unless resume is false.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.command", "/api/session/:sessionID/command", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional),
          command: Schema.String,
          arguments: Schema.String.pipe(Schema.optional),
          agent: Agent.ID.pipe(Schema.optional),
          model: Model.Ref.pipe(Schema.optional),
          files: PromptInput.Prompt.fields.files,
          agents: PromptInput.Prompt.fields.agents,
          delivery: SessionPending.Delivery.pipe(Schema.optional),
          resume: Schema.Boolean.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: SessionPending.User }),
        error: [ConflictError, InvalidRequestError, SessionNotFoundError, CommandNotFoundError, CommandEvaluationError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.command",
            summary: "Run command",
            description:
              "Resolve a slash command into prompt input, admit it durably, and schedule execution unless resume is false.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.skill", "/api/session/:sessionID/skill", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional),
          skill: Skill.ID,
          resume: Schema.Boolean.pipe(Schema.optional),
        }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, SkillNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.skill",
            summary: "Activate skill",
            description: "Activate a skill for a session by appending a skill message and resuming execution.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.usage", "/api/session/:sessionID/usage", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: ProviderRequest.Summary }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.usage",
            summary: "Get durable session provider usage",
            description:
              "Retrieve provider-request usage and recorded or current-catalog-estimated spend after transcript compaction or when cache diagnostics are unavailable. Each priced model row identifies its cost provenance. Root sessions include their descendant subagent family; child sessions remain scoped to themselves.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.usageReport", "/api/session/:sessionID/usage/report", {
        params: { sessionID: Session.ID },
        query: SessionUsageReportQuery,
        success: Schema.Struct({ data: ProviderRequest.Report }),
        error: [SessionNotFoundError, InvalidRequestError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.usageReport",
            summary: "Report durable session provider usage",
            description:
              "Group and sort retained provider-request usage for a Session or root Session family before bounded pagination without exposing request routing, cache namespaces, digests, or raw provider payloads. Sorting defaults to ascending row key.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.promptCosts", "/api/session/:sessionID/usage/prompts", {
        params: { sessionID: Session.ID },
        query: UsageAccounting.PromptInput,
        success: Schema.Struct({ data: UsageAccounting.PromptCosts }),
        error: [SessionNotFoundError, InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "session.promptCosts", summary: "Read retained prompt costs" })),
    )
    .add(
      HttpApiEndpoint.get("session.taskCosts", "/api/session/:sessionID/usage/tasks", {
        params: { sessionID: Session.ID },
        query: UsageAccounting.TaskInput,
        success: Schema.Struct({ data: UsageAccounting.TaskCosts }),
        error: [SessionNotFoundError, InvalidRequestError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "session.taskCosts", summary: "Read recursive retained task costs" })),
    )
    .add(
      HttpApiEndpoint.get("session.skills", "/api/session/:sessionID/skills", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(SessionSkillStatus.Info) }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.skills",
            summary: "List session skills",
            description: "Retrieve the active and inactive skills for a session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.resolveSkillConflict", "/api/session/:sessionID/skill/resolve", {
        params: { sessionID: Session.ID },
        payload: SessionSkillConflictResolve,
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, SkillConflictNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.resolveSkillConflict",
            summary: "Resolve skill conflict",
            description: "Resolve an active skill conflict by keeping the winner and durably deactivating the loser.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.synthetic", "/api/session/:sessionID/synthetic", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional),
          text: Schema.String,
          description: Schema.String.pipe(Schema.optional),
          metadata: SessionMessage.Synthetic.fields.metadata,
          delivery: SessionPending.Delivery.pipe(Schema.optional),
          resume: Schema.Boolean.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: SessionPending.Synthetic }),
        error: [ConflictError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.synthetic",
            summary: "Add synthetic message",
            description: "Durably admit synthetic session input and schedule execution unless resume is false.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.shell", "/api/session/:sessionID/shell", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: Event.ID.pipe(Schema.optional),
          command: Schema.String,
        }),
        success: HttpApiSchema.NoContent,
        error: [InvalidRequestError, ServiceUnavailableError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.shell",
            summary: "Run shell command",
            description:
              "Execute one shell command in the session's working directory. Emits a shell.started event before execution and a shell.ended event with the merged output after.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.compact", "/api/session/:sessionID/compact", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ id: SessionCompaction.ID.pipe(Schema.optional) }),
        success: Schema.Struct({ data: SessionCompaction.Result }),
        error: [ConflictError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.compact",
            summary: "Compact session",
            description: "Perform durable session compaction and return after it settles.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.compaction.list", "/api/session/:sessionID/compaction", {
        params: { sessionID: Session.ID },
        success: SessionCompaction.History,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.compaction.list",
            summary: "List session compactions",
            description:
              "Return the newest 100 job-keyed compaction jobs of the Session ordered by creation time then job ID, with truncated, the completed jobs before that window, and the cumulative completed count and saved tokens across the full history.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.wait", "/api/session/:sessionID/wait", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.wait",
            summary: "Wait for session",
            description: "Wait for a session agent loop to become idle.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.revert.stage", "/api/session/:sessionID/revert/stage", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ messageID: SessionMessage.ID, files: Schema.Boolean.pipe(Schema.optional) }),
        success: Schema.Struct({ data: Session.Revert }),
        error: [MessageNotFoundError, HistoryPrunedError, SessionNotFoundError, SessionBusyError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.revert.stage",
            summary: "Stage session revert",
            description:
              "Stage or move a reversible session boundary and optionally apply its file changes. A messageID that is not in the retained history after the session's completed compaction checkpoint fails with HistoryPrunedError (410).",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.revert.clear", "/api/session/:sessionID/revert/clear", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, SessionBusyError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "session.revert.clear", summary: "Clear staged revert" })),
    )
    .add(
      HttpApiEndpoint.post("session.revert.commit", "/api/session/:sessionID/revert/commit", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, SessionBusyError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({ identifier: "session.revert.commit", summary: "Commit staged revert" }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.context", "/api/session/:sessionID/context", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(SessionMessage.Info) }),
        error: [SessionNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.context",
            summary: "Get session context",
            description: "Retrieve the active context messages for a session (all messages after the last compaction).",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.fileChange.list", "/api/session/:sessionID/file-change", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(SessionEvent.FileChange.Info) }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.file-change.list",
            summary: "List captured file changes",
            description: "Retrieve durable current file changes for a session and its completed direct children.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.pending.list", "/api/session/:sessionID/pending", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(SessionPending.Info) }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.pending.list",
            summary: "List pending session work",
            description:
              "List durable admitted session work not yet visible in projected history, ordered by admission. Includes unpromoted user and synthetic inputs and unhandled compaction barriers. The runner owns consumption; items disappear once promoted or handled.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.instructions.entry.list", "/api/session/:sessionID/instructions/entries", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(InstructionEntry.Info) }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.instructions.entry.list",
            summary: "List instruction entries",
            description: "List API-managed instruction entries attached to the session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.put("session.instructions.entry.put", "/api/session/:sessionID/instructions/entries/:key", {
        params: { sessionID: Session.ID, key: InstructionEntry.Key },
        payload: Schema.Struct({ value: Schema.Json }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, InstructionEntry.ValueTooLargeError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.instructions.entry.put",
            summary: "Put instruction entry",
            description:
              "Attach or replace one durable instruction entry. Changes announce as updates at the next step boundary.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.delete("session.instructions.entry.remove", "/api/session/:sessionID/instructions/entries/:key", {
        params: { sessionID: Session.ID, key: InstructionEntry.Key },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.instructions.entry.remove",
            summary: "Remove instruction entry",
            description:
              "Remove one instruction entry; the removal is announced to the model at the next step boundary.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.generate", "/api/session/:sessionID/generate", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ prompt: Schema.String }),
        success: Schema.Struct({
          data: Schema.Struct({ text: Schema.String }),
        }).annotate({ identifier: "SessionGenerateResponse" }),
        error: [SessionNotFoundError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.generate",
            summary: "Generate text from session context",
            description: "Generate transient text from the current session context without mutating session history.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.prediction", "/api/session/:sessionID/prediction", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          memory: Schema.Array(Schema.Literals(["repository", "knowledge"])),
          hint: Schema.String.check(Schema.isMaxLength(2000)).pipe(Schema.optional),
        }),
        success: Schema.Struct({
          data: Schema.Union([
            Schema.Struct({ status: Schema.Literal("suggested"), text: Schema.String }),
            Schema.Struct({ status: Schema.Literal("unavailable") }),
          ]),
        }).annotate({ identifier: "SessionPredictionResponse" }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.prediction",
            summary: "Suggest the next user message",
            description:
              "Generate one next-message suggestion for an idle root Session's latest completed reply, optionally guided by a hint and selected memory scopes. A new request cancels an earlier one for the Session. Publishes session.prediction.updated with the accepted suggestion.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.promptGenerate", "/api/session/:sessionID/prompt-generate", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          mode: Schema.Literals(["start", "steer", "queue", "goal"]),
          intent: Schema.String.check(Schema.isMaxLength(4000), Schema.isPattern(/\S/)),
          memory: Schema.Array(Schema.Literals(["repository", "knowledge"])),
        }),
        success: Schema.Struct({
          data: Schema.Union([
            Schema.Struct({ status: Schema.Literal("generated"), text: Schema.String }),
            Schema.Struct({ status: Schema.Literal("unavailable") }),
          ]),
        }).annotate({ identifier: "SessionPromptGenerateResponse" }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.promptGenerate",
            summary: "Draft a prompt from an intent",
            description:
              "Generates one draft prompt for the mode from the intent, bounded recent conversation and selected memory. Nothing is admitted or sent. A new request cancels an earlier in-flight one for the Session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.log", "/api/experimental/session/:sessionID/log", {
        params: { sessionID: Session.ID },
        query: {
          after: Schema.NumberFromString.pipe(Schema.decodeTo(Event.Seq), Schema.optional),
          follow: BooleanFromString.pipe(Schema.optional),
        },
        success: HttpApiSchema.StreamSse({
          data: SessionLogItem,
        }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.log",
            summary: "Read the session log",
            description:
              "Experimental durable session event log. Reads events after an exclusive aggregate sequence and continues with live events when follow=true.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.interrupt", "/api/session/:sessionID/interrupt", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.interrupt",
            summary: "Interrupt session execution",
            description: "Interrupt active execution owned by this YCoding process. Idle interruption is a no-op.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.background", "/api/session/:sessionID/background", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.background",
            summary: "Background blocking session tools",
            description:
              "Move active foreground backgroundable tools for this session into background observation. Idle requests are a no-op.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.message", "/api/session/:sessionID/message/:messageID", {
        params: { sessionID: Session.ID, messageID: SessionMessage.ID },
        success: Schema.Struct({ data: SessionMessage.Info }),
        error: [SessionNotFoundError, MessageNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.message",
            summary: "Get session message",
            description: "Retrieve one projected message owned by the Session.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "session",
        description: "Experimental session routes.",
      }),
    )
