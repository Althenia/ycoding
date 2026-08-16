import { SessionMessage } from "@ycoding-ai/schema/session-message"
import { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import { SessionPending } from "@ycoding-ai/schema/session-pending"
import { PromptInput } from "@ycoding-ai/schema/prompt-input"
import { Session } from "@ycoding-ai/schema/session"
import { InstructionEntry } from "@ycoding-ai/schema/instruction-entry"
import { Project } from "@ycoding-ai/schema/project"
import { AbsolutePath, PositiveInt, RelativePath, statics } from "@ycoding-ai/schema/schema"
import { Event } from "@ycoding-ai/schema/event"
import { Workspace } from "@ycoding-ai/schema/workspace"
import { SessionOrchestration } from "@ycoding-ai/schema/session-orchestration"
import { SessionDelivery } from "@ycoding-ai/schema/session-delivery"
import { Context, Effect, Encoding, Result, Schema, SchemaGetter, Struct } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  ConflictError,
  CommandEvaluationError,
  CommandNotFoundError,
  InvalidCursorError,
  InvalidRequestError,
  MessageNotFoundError,
  ModelSwitchBlockedError,
  ServiceUnavailableError,
  SessionBusyError,
  SessionNotFoundError,
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

export const SessionAutonomyMode = Schema.Literals(["normal", "yolo", "goal"]).annotate({
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
export const SessionAutonomyState = Schema.Struct({
  mode: SessionAutonomyMode,
  goal: SessionAutonomyGoal.pipe(Schema.optional),
}).annotate({ identifier: "SessionAutonomyState" })
export const SessionAutonomySet = Schema.Union([
  Schema.Struct({ mode: Schema.Literals(["normal", "yolo"]) }),
  Schema.Struct({
    mode: Schema.Literal("goal"),
    goal: Schema.Trim.pipe(Schema.check(Schema.isNonEmpty())),
    maxNoProgress: PositiveInt.pipe(Schema.optional),
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

const SubagentPageLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(10))
export const SessionSubagentListQuery = Schema.Struct({
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(SubagentPageLimit), Schema.optional),
  cursor: SubagentCursor.pipe(Schema.optional),
}).annotate({ identifier: "SessionSubagentListQuery" })

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
          identifier: "v2.session.list",
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
          agent: Agent.ID.pipe(Schema.optional),
          model: Model.Ref.pipe(Schema.optional),
          location: Location.Ref.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: Session.Info }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.create",
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
          identifier: "v2.session.active",
          summary: "List active sessions",
          description:
            "Retrieve foreground Session drains currently owned by this YCoding process. Sessions absent from the result are inactive.",
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
            identifier: "v2.session.get",
            summary: "Get session",
            description: "Retrieve a session by ID.",
          }),
        ),
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
            identifier: "v2.session.diagnostics",
            summary: "Get session cache diagnostics",
            description:
              "Retrieve normalized context occupancy, provider cache usage, and the bounded latest cache invalidation reason for the latest assistant step after the last completed compaction.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.autonomy.get", "/api/session/:sessionID/autonomy", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: SessionAutonomyState }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.autonomy.get",
            summary: "Get session autonomy",
            description: "Retrieve the durable Normal, YOLO, or Goal execution mode for a session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.put("session.autonomy.set", "/api/session/:sessionID/autonomy", {
        params: { sessionID: Session.ID },
        payload: SessionAutonomySet,
        success: Schema.Struct({ data: SessionAutonomyState }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.autonomy.set",
            summary: "Set session autonomy",
            description: "Switch a session to Normal or YOLO mode, or activate an autonomous Goal.",
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
            identifier: "v2.session.remove",
            summary: "Delete session",
            description: "Delete a session and its child sessions.",
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
            identifier: "v2.session.subagent.list",
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
            identifier: "v2.session.subagent.launch",
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
        .annotateMerge(OpenApi.annotations({ identifier: "v2.session.subagent.message", summary: "Message subagent" })),
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
          OpenApi.annotations({ identifier: "v2.session.subagent.answer", summary: "Answer subagent question" }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.subagent.cancel", "/api/session/:parentID/subagent/:childID/cancel", {
        params: { parentID: Session.ID, childID: Session.ID },
        success: Schema.Struct({ data: SessionOrchestration.Task }),
        error: [SessionNotFoundError, ForbiddenError, ConflictError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.session.subagent.cancel", summary: "Cancel subagent" })),
    )
    .add(
      HttpApiEndpoint.post("session.subagent.resume", "/api/session/:parentID/subagent/:childID/resume", {
        params: { parentID: Session.ID, childID: Session.ID },
        success: Schema.Struct({ data: SessionOrchestration.Task }),
        error: [SessionNotFoundError, ForbiddenError, ConflictError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.session.subagent.resume", summary: "Resume subagent" })),
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
        error: [SessionNotFoundError, MessageNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.fork",
            summary: "Fork session",
            description:
              "Create a child session by copying projected history from the parent. When messageID is supplied, copy messages before that boundary.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchAgent", "/api/session/:sessionID/agent", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ agent: Agent.ID }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.switchAgent",
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
        error: [SessionNotFoundError, ModelSwitchBlockedError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.switchModel",
            summary: "Switch session model",
            description:
              "Switch the model used by subsequent provider turns. Refuses the switch when the current context cannot fit the target model.",
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
            identifier: "v2.session.rename",
            summary: "Rename session",
            description: "Update the session title.",
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
            identifier: "v2.session.move",
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
        }),
        success: Schema.Struct({ data: SessionPending.User }),
        error: [ConflictError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.prompt",
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
            identifier: "v2.session.command",
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
            identifier: "v2.session.skill",
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
            identifier: "v2.session.usage",
            summary: "Get durable session provider usage",
            description:
              "Retrieve provider-request usage and recorded or current-catalog-estimated spend after transcript compaction or when cache diagnostics are unavailable. Each priced model row identifies its cost provenance. Root sessions include their descendant subagent family; child sessions remain scoped to themselves.",
          }),
        ),
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
            identifier: "v2.session.skills",
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
            identifier: "v2.session.resolveSkillConflict",
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
            identifier: "v2.session.synthetic",
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
            identifier: "v2.session.shell",
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
        success: Schema.Struct({ data: SessionCompaction.Admission }),
        error: [ConflictError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.compact",
            summary: "Compact session",
            description: "Queue a durable session compaction request.",
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
            identifier: "v2.session.wait",
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
        error: [MessageNotFoundError, SessionNotFoundError, SessionBusyError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.revert.stage",
            summary: "Stage session revert",
            description: "Stage or move a reversible session boundary and optionally apply its file changes.",
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
        .annotateMerge(OpenApi.annotations({ identifier: "v2.session.revert.clear", summary: "Clear staged revert" })),
    )
    .add(
      HttpApiEndpoint.post("session.revert.commit", "/api/session/:sessionID/revert/commit", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, SessionBusyError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({ identifier: "v2.session.revert.commit", summary: "Commit staged revert" }),
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
            identifier: "v2.session.context",
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
            identifier: "v2.session.file-change.list",
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
            identifier: "v2.session.pending.list",
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
            identifier: "v2.session.instructions.entry.list",
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
            identifier: "v2.session.instructions.entry.put",
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
            identifier: "v2.session.instructions.entry.remove",
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
            identifier: "v2.session.generate",
            summary: "Generate text from session context",
            description: "Generate transient text from the current session context without mutating session history.",
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
          data: Schema.Union([SessionEvent.PublicDurable, EventLog.Synced]).annotate({ identifier: "SessionLogItem" }),
        }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.log",
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
            identifier: "v2.session.interrupt",
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
            identifier: "v2.session.background",
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
            identifier: "v2.session.message",
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
