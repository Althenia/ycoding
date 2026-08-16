import { expect, test } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMRequest } from "@ycoding-ai/ai"
import { OpenAIChat } from "@ycoding-ai/ai/protocols"
import { Config } from "@ycoding-ai/core/config"
import { ConfigCompaction } from "@ycoding-ai/core/config/compaction"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { llmClient } from "@ycoding-ai/core/effect/app-node-platform"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { EventSequenceTable, EventTable } from "@ycoding-ai/core/event/sql"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { ModelV2 } from "@ycoding-ai/core/model"
import { SessionCompaction } from "@ycoding-ai/core/session/compaction"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import {
  SessionHelperPolicy,
  localGoal,
  localTitle,
  selectHelperModel,
} from "@ycoding-ai/core/session/helper-policy"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionProviderRequest } from "@ycoding-ai/core/session/provider-request"
import { SessionRunnerCache } from "@ycoding-ai/core/session/runner/cache"
import { SessionCacheRuntime } from "@ycoding-ai/core/session/runner/cache-runtime"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { toLLMMessages } from "@ycoding-ai/core/session/runner/to-llm-message"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionMessageTable, SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionSummaryToon } from "@ycoding-ai/core/session/summary-toon"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { asc, eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const model = Model.make({
  id: "summary-model",
  provider: "test",
  route: OpenAIChat.route.with({ limits: { context: 10_000, output: 1_000 } }),
})

const memory = (through_sequence: number) =>
  SessionSummaryToon.encode({
    version: 1,
    through_sequence,
    objective: "Preserve the explicit summary contract",
    current_state: "Testing",
    facts: [],
    decisions: [],
    preferences: [],
    constraints: [],
    completed: [],
    pending: [],
    blockers: [],
    unresolved: [],
    important_identifiers: [],
    continuation: "Continue safely",
  })

let requests: LLMRequest[] = []
let summary = memory(2)
let beforeSummary = Effect.void
let summaryFailure: string | undefined
const client = Layer.mock(LLMClient.Service)({
  prepare: () => Effect.die("unused"),
  stream: (request) => {
    requests.push(request)
    const events: Stream.Stream<LLMEvent> = summaryFailure
      ? Stream.make(LLMEvent.providerError({ message: summaryFailure }))
      : Stream.make(LLMEvent.textDelta({ id: "summary", text: summary }))
    return Stream.unwrap(beforeSummary.pipe(Effect.as(events)))
  },
  generate: () => Effect.die("unused"),
})
const config = Layer.mock(Config.Service)({
  entries: () =>
    Effect.succeed([
      new Config.Document({
        type: "document",
        info: new Config.Info({ compaction: new ConfigCompaction.Info({ keep_recent_messages: 1 }) }),
      }),
    ]),
})
const cacheRuntime = Layer.succeed(
  SessionCacheRuntime.Service,
  SessionCacheRuntime.Service.of({
    policy: () => Effect.succeed({ ttlSeconds: 300, promoted: false }),
    observe: () => Effect.void,
  }),
)
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: () => Effect.succeed(SessionRunnerModel.resolved(model)),
})
const helpers = Layer.succeed(
  SessionHelperPolicy.Service,
  SessionHelperPolicy.Service.of({
    settings: { titleMode: "local", goalMode: "local", models: {}, compactionScopes: {} },
    localTitle,
    localGoal,
    resolveModel: () => Effect.succeed(SessionRunnerModel.resolved(model)),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      SessionProviderRequest.node,
      SessionHelperPolicy.node,
      SessionCompaction.node,
    ]),
    [
      [llmClient, client],
      [Config.node, config],
      [SessionCacheRuntime.node, cacheRuntime],
      [SessionRunnerModel.node, models],
      [SessionHelperPolicy.node, helpers],
    ],
  ),
)

const insertMessage = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, id: SessionMessage.ID, seq: number) {
  const message = SessionMessage.User.make({
    id,
    type: "user",
    text: `message ${seq}`,
    time: { created: DateTime.makeUnsafe(seq) },
  })
  const encoded = Schema.encodeSync(SessionMessage.Info)(message)
  const { id: encodedID, type, ...data } = encoded
  const db = (yield* Database.Service).db
  yield* db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(encodedID),
      session_id: sessionID,
      type,
      seq,
      time_created: seq,
      time_updated: seq,
      data,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(EventTable)
    .values({
      id: EventV2.ID.make(`evt_${sessionID}_${seq}`),
      aggregate_id: sessionID,
      seq,
      created: seq,
      type: EventV2.versionedType(SessionEvent.InputPromoted.type, 1),
      data: { sessionID, inputID: id },
    })
    .run()
    .pipe(Effect.orDie)
})

const insertSystemMessage = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, id: SessionMessage.ID, seq: number) {
  const message = SessionMessage.System.make({
    id,
    type: "system",
    text: `system ${seq}`,
    time: { created: DateTime.makeUnsafe(seq) },
  })
  const encoded = Schema.encodeSync(SessionMessage.Info)(message)
  const { id: encodedID, type, ...data } = encoded
  const db = (yield* Database.Service).db
  yield* db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(encodedID),
      session_id: sessionID,
      type,
      seq,
      time_created: seq,
      time_updated: seq,
      data,
    })
    .run()
    .pipe(Effect.orDie)
})

const insertCompletedSummary = Effect.fnUntraced(function* (
  sessionID: SessionSchema.ID,
  id: SessionMessage.ID,
  seq: number,
  revision: number,
) {
  const message = SessionMessage.CompactionCompleted.make({
    id,
    type: "compaction",
    status: "completed",
    reason: "manual",
    summary: memory(seq),
    recent: "",
    messages: 1,
    time: { created: DateTime.makeUnsafe(seq) },
    metadata: { summary_revision: revision },
  })
  const encoded = Schema.encodeSync(SessionMessage.Info)(message)
  const { id: encodedID, type, ...data } = encoded
  const db = (yield* Database.Service).db
  yield* db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(encodedID),
      session_id: sessionID,
      type,
      seq,
      time_created: seq,
      time_updated: seq,
      data,
    })
    .run()
    .pipe(Effect.orDie)
})

const insertEvent = Effect.fnUntraced(function* (
  sessionID: SessionSchema.ID,
  seq: number,
  id: string,
  type: string,
  data: Record<string, unknown>,
) {
  const db = (yield* Database.Service).db
  yield* db
    .insert(EventTable)
    .values({ id: EventV2.ID.make(id), aggregate_id: sessionID, seq, created: seq, type, data })
    .run()
    .pipe(Effect.orDie)
})

const insertProtectedEvent = Effect.fnUntraced(function* (
  sessionID: SessionSchema.ID,
  seq: number,
  id: string,
  definition: { readonly type: string; readonly durable?: { readonly version: number } },
) {
  yield* insertEvent(
    sessionID,
    seq,
    id,
    EventV2.versionedType(definition.type, definition.durable!.version),
    { sessionID },
  )
})

const seedSession = Effect.fnUntraced(function* (input: {
  readonly id: SessionSchema.ID
  readonly sequence: number
  readonly parentID?: SessionSchema.ID
  readonly model?: SessionSchema.Info["model"]
}) {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: input.id,
      project_id: Project.ID.global,
      directory: "/project",
      title: "Summary test",
      ...(input.parentID === undefined ? {} : { parent_id: input.parentID }),
      ...(input.model === undefined ? {} : { model: input.model }),
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(EventSequenceTable)
    .values({ aggregate_id: input.id, seq: input.sequence })
    .run()
    .pipe(Effect.orDie)
})

const resetSummaryStream = () => {
  requests = []
  summary = memory(2)
  beforeSummary = Effect.void
  summaryFailure = undefined
}

const decodeSessionMessage = Schema.decodeUnknownSync(SessionMessage.Info)
const decodeProjection = (row: typeof SessionMessageTable.$inferSelect): SessionMessage.Info =>
  decodeSessionMessage({ ...row.data, id: row.id, type: row.type })

it.effect("summarizes only on the explicit service call and replaces covered message rows", () =>
  Effect.gen(function* () {
    requests = []
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const sessionID = SessionSchema.ID.make("ses_explicit_summary")
    const boundaryID = SessionMessage.ID.make("msg_explicit_boundary")
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "Explicit summary" })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(EventSequenceTable)
      .values({ aggregate_id: sessionID, seq: 3 })
      .run()
      .pipe(Effect.orDie)
    yield* insertMessage(sessionID, SessionMessage.ID.make("msg_explicit_first"), 1)
    yield* insertMessage(sessionID, boundaryID, 2)
    yield* insertMessage(sessionID, SessionMessage.ID.make("msg_explicit_recent"), 3)

    const result = yield* compaction.summarize({ sessionID, boundaryMessageID: boundaryID })

    expect(requests).toHaveLength(1)
    expect(result).toMatchObject({ through: 2, deletedMessageCount: 2, remainingMessageCount: 2, summaryRevision: 1 })
    expect(
      yield* db
        .select({ id: SessionMessageTable.id, type: SessionMessageTable.type, seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([
      { id: result.summaryMessageID, type: "compaction", seq: 2 },
      { id: SessionMessage.ID.make("msg_explicit_recent"), type: "user", seq: 3 },
    ])
  }),
)

test("builds a versioned TOON summary prompt", () => {
  const prompt = SessionCompaction.buildSummarizePrompt({ context: ["history"], through: 2 })
  expect(prompt).toContain("Output exactly one TOON document")
  expect(prompt).toContain("version: 1")
  expect(prompt).toContain("through_sequence")
})

it.effect("preserves protected events while deleting each covered message event and projection once", () =>
  Effect.gen(function* () {
    resetSummaryStream()
    summary = memory(6)
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const sessionID = SessionSchema.ID.make("ses_protected_events")
    const firstID = SessionMessage.ID.make("msg_protected_first")
    const coveredID = SessionMessage.ID.make("msg_protected_covered")
    const boundaryID = SessionMessage.ID.make("msg_protected_boundary")
    const recentID = SessionMessage.ID.make("msg_protected_recent")
    yield* seedSession({ id: sessionID, sequence: 7 })
    yield* insertMessage(sessionID, firstID, 1)
    yield* insertProtectedEvent(sessionID, 2, "evt_protected_instructions", SessionEvent.InstructionsUpdated)
    yield* insertProtectedEvent(sessionID, 3, "evt_protected_task", SessionEvent.Task.Updated)
    yield* insertProtectedEvent(sessionID, 4, "evt_protected_provider", SessionEvent.ProviderRequestRecorded)
    yield* insertMessage(sessionID, coveredID, 5)
    yield* insertMessage(sessionID, boundaryID, 6)
    yield* insertMessage(sessionID, recentID, 7)

    const result = yield* compaction.summarize({ sessionID, boundaryMessageID: boundaryID })
    const events = yield* db
      .select({ id: EventTable.id, seq: EventTable.seq, type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    const rows = yield* db
      .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq, type: SessionMessageTable.type })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)

    expect(result.deletedMessageCount).toBe(3)
    expect(events).toContainEqual({
      id: EventV2.ID.make("evt_protected_instructions"),
      seq: 2,
      type: EventV2.versionedType(SessionEvent.InstructionsUpdated.type, SessionEvent.InstructionsUpdated.durable.version),
    })
    expect(events).toContainEqual({
      id: EventV2.ID.make("evt_protected_task"),
      seq: 3,
      type: EventV2.versionedType(SessionEvent.Task.Updated.type, SessionEvent.Task.Updated.durable.version),
    })
    expect(events).toContainEqual({
      id: EventV2.ID.make("evt_protected_provider"),
      seq: 4,
      type: EventV2.versionedType(
        SessionEvent.ProviderRequestRecorded.type,
        SessionEvent.ProviderRequestRecorded.durable.version,
      ),
    })
    expect(events).toContainEqual({
      id: EventV2.ID.make(`evt_${sessionID}_7`),
      seq: 7,
      type: EventV2.versionedType(SessionEvent.InputPromoted.type, SessionEvent.InputPromoted.durable.version),
    })
    expect(events.some((event) => event.seq === 1 || event.seq === 5 || event.seq === 6)).toBe(false)
    expect(rows).toEqual([
      { id: result.summaryMessageID, seq: 6, type: "compaction" },
      { id: recentID, seq: 7, type: "user" },
    ])
    expect(rows.map((row) => row.id)).not.toContain(firstID)
    expect(rows.map((row) => row.id)).not.toContain(coveredID)
    expect(rows.map((row) => row.id)).not.toContain(boundaryID)
  }),
)

it.effect("preserves event and projection sequence gaps and appends above the deleted range", () =>
  Effect.gen(function* () {
    resetSummaryStream()
    summary = memory(2)
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const compaction = yield* SessionCompaction.Service
    const sessionID = SessionSchema.ID.make("ses_sequence_gap")
    const boundaryID = SessionMessage.ID.make("msg_sequence_boundary")
    const recentID = SessionMessage.ID.make("msg_sequence_recent")
    yield* seedSession({ id: sessionID, sequence: 4 })
    yield* insertMessage(sessionID, SessionMessage.ID.make("msg_sequence_first"), 1)
    yield* insertMessage(sessionID, boundaryID, 2)
    yield* insertMessage(sessionID, recentID, 4)

    yield* compaction.summarize({ sessionID, boundaryMessageID: boundaryID })

    expect(
      yield* db
        .select({ seq: EventSequenceTable.seq })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, sessionID))
        .get()
        .pipe(Effect.orDie),
    ).toEqual({ seq: 5 })
    expect(
      yield* db
        .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([
      { id: expect.any(String), seq: 2 },
      { id: recentID, seq: 4 },
    ])

    yield* events.publish(SessionEvent.InputPromoted, {
      sessionID,
      inputID: SessionMessage.ID.make("msg_sequence_append"),
    })

    expect(
      yield* db
        .select({ seq: EventSequenceTable.seq })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, sessionID))
        .get()
        .pipe(Effect.orDie),
    ).toEqual({ seq: 6 })
    expect(
      yield* db
        .select({ seq: EventTable.seq })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([{ seq: 4 }, { seq: 5 }, { seq: 6 }])
  }),
)

it.effect("replaces the previous summary and covered source rows exactly once", () =>
  Effect.gen(function* () {
    resetSummaryStream()
    summary = memory(3)
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const sessionID = SessionSchema.ID.make("ses_replace_previous")
    const previousID = SessionMessage.ID.make("msg_replace_previous")
    const boundaryID = SessionMessage.ID.make("msg_replace_boundary")
    const recentID = SessionMessage.ID.make("msg_replace_recent")
    yield* seedSession({ id: sessionID, sequence: 4 })
    yield* insertCompletedSummary(sessionID, previousID, 1, 1)
    yield* insertMessage(sessionID, SessionMessage.ID.make("msg_replace_first"), 2)
    yield* insertMessage(sessionID, boundaryID, 3)
    yield* insertMessage(sessionID, recentID, 4)

    const result = yield* compaction.summarize({ sessionID, boundaryMessageID: boundaryID })

    expect(result).toMatchObject({ deletedMessageCount: 3, summaryRevision: 2 })
    expect(
      yield* db
        .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq, type: SessionMessageTable.type })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([
      { id: result.summaryMessageID, seq: 3, type: "compaction" },
      { id: recentID, seq: 4, type: "user" },
    ])
    expect(
      yield* db
        .select({ seq: EventTable.seq })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([{ seq: 4 }, { seq: 5 }])
  }),
)

it.effect("keeps all source rows intact when the summarizer model fails", () =>
  Effect.gen(function* () {
    resetSummaryStream()
    summaryFailure = "summary provider unavailable"
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const sessionID = SessionSchema.ID.make("ses_model_failure")
    const boundaryID = SessionMessage.ID.make("msg_model_failure_boundary")
    const previousID = SessionMessage.ID.make("msg_model_failure_previous")
    yield* seedSession({ id: sessionID, sequence: 4 })
    yield* insertCompletedSummary(sessionID, previousID, 1, 1)
    yield* insertMessage(sessionID, SessionMessage.ID.make("msg_model_failure_first"), 2)
    yield* insertMessage(sessionID, boundaryID, 3)
    yield* insertMessage(sessionID, SessionMessage.ID.make("msg_model_failure_recent"), 4)

    const failure = yield* compaction
      .summarize({ sessionID, boundaryMessageID: boundaryID })
      .pipe(Effect.flip, Effect.ensuring(Effect.sync(resetSummaryStream)))

    expect(failure).toMatchObject({ type: "summarize.failed", message: "summary provider unavailable" })
    expect(
      yield* db
        .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([
      { id: previousID, seq: 1 },
      { id: SessionMessage.ID.make("msg_model_failure_first"), seq: 2 },
      { id: boundaryID, seq: 3 },
      { id: SessionMessage.ID.make("msg_model_failure_recent"), seq: 4 },
    ])
    expect(
      yield* db
        .select({ seq: EventTable.seq })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie),
    ).toHaveLength(4)
  }),
)

it.effect("keeps all source rows intact when TOON validation rejects the model output", () =>
  Effect.gen(function* () {
    resetSummaryStream()
    summary = memory(1)
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const sessionID = SessionSchema.ID.make("ses_invalid_toon")
    const boundaryID = SessionMessage.ID.make("msg_invalid_toon_boundary")
    const previousID = SessionMessage.ID.make("msg_invalid_toon_previous")
    yield* seedSession({ id: sessionID, sequence: 4 })
    yield* insertCompletedSummary(sessionID, previousID, 1, 1)
    yield* insertMessage(sessionID, SessionMessage.ID.make("msg_invalid_toon_first"), 2)
    yield* insertMessage(sessionID, boundaryID, 3)
    yield* insertMessage(sessionID, SessionMessage.ID.make("msg_invalid_toon_recent"), 4)

    const failure = yield* compaction
      .summarize({ sessionID, boundaryMessageID: boundaryID })
      .pipe(Effect.flip, Effect.ensuring(Effect.sync(resetSummaryStream)))

    expect(failure).toMatchObject({ type: "summarize.invalid-toon", message: expect.stringContaining("mismatch") })
    expect(
      yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie),
    ).toHaveLength(4)
    expect(
      yield* db
        .select({ id: EventTable.id })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie),
    ).toHaveLength(4)
  }),
)

it.effect("rolls back without deletion when the covered range changes before commit", () =>
  Effect.gen(function* () {
    resetSummaryStream()
    summary = memory(2)
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const sessionID = SessionSchema.ID.make("ses_summary_conflict")
    const boundaryID = SessionMessage.ID.make("msg_summary_conflict_boundary")
    yield* seedSession({ id: sessionID, sequence: 3 })
    yield* insertMessage(sessionID, SessionMessage.ID.make("msg_summary_conflict_first"), 1)
    yield* insertMessage(sessionID, boundaryID, 2)
    yield* insertMessage(sessionID, SessionMessage.ID.make("msg_summary_conflict_recent"), 3)
    beforeSummary = db
      .update(SessionMessageTable)
      .set({ seq: 99 })
      .where(eq(SessionMessageTable.id, boundaryID))
      .run()
      .pipe(Effect.orDie, Effect.asVoid)

    const failure = yield* compaction
      .summarize({ sessionID, boundaryMessageID: boundaryID })
      .pipe(Effect.flip, Effect.ensuring(Effect.sync(resetSummaryStream)))

    expect(failure).toMatchObject({ type: "summarize.conflict", message: "The boundary changed" })
    expect(
      yield* db
        .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([
      { id: SessionMessage.ID.make("msg_summary_conflict_first"), seq: 1 },
      { id: SessionMessage.ID.make("msg_summary_conflict_recent"), seq: 3 },
      { id: boundaryID, seq: 99 },
    ])
    expect(
      yield* db
        .select({ seq: EventTable.seq })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }])
  }),
)

it.effect("rejects unsafe, unknown, cross-session, covered, and empty boundaries before deletion", () =>
  Effect.gen(function* () {
    resetSummaryStream()
    const compaction = yield* SessionCompaction.Service

    const floorSession = SessionSchema.ID.make("ses_floor_boundary")
    const floorBoundary = SessionMessage.ID.make("msg_floor_boundary")
    yield* seedSession({ id: floorSession, sequence: 2 })
    yield* insertMessage(floorSession, SessionMessage.ID.make("msg_floor_first"), 1)
    yield* insertMessage(floorSession, floorBoundary, 2)
    const floor = yield* compaction.summarize({ sessionID: floorSession, boundaryMessageID: floorBoundary }).pipe(Effect.flip)
    expect(floor).toMatchObject({ type: "summarize.keep-recent-floor" })

    const unknown = yield* compaction
      .summarize({ sessionID: floorSession, boundaryMessageID: SessionMessage.ID.make("msg_unknown_boundary") })
      .pipe(Effect.flip)
    expect(unknown).toMatchObject({ type: "summarize.unknown-boundary" })

    const firstSession = SessionSchema.ID.make("ses_cross_first")
    const secondSession = SessionSchema.ID.make("ses_cross_second")
    const crossBoundary = SessionMessage.ID.make("msg_cross_boundary")
    yield* seedSession({ id: firstSession, sequence: 1 })
    yield* seedSession({ id: secondSession, sequence: 2 })
    yield* insertMessage(secondSession, SessionMessage.ID.make("msg_cross_first"), 1)
    yield* insertMessage(secondSession, crossBoundary, 2)
    const cross = yield* compaction
      .summarize({ sessionID: firstSession, boundaryMessageID: crossBoundary })
      .pipe(Effect.flip)
    expect(cross).toMatchObject({ type: "summarize.cross-session" })

    const coveredSession = SessionSchema.ID.make("ses_already_covered")
    const coveredBoundary = SessionMessage.ID.make("msg_already_covered")
    yield* seedSession({ id: coveredSession, sequence: 2 })
    yield* insertMessage(coveredSession, SessionMessage.ID.make("msg_already_covered_first"), 1)
    yield* insertMessage(coveredSession, coveredBoundary, 2)
    summary = memory(1)
    const firstSummary = yield* compaction.summarize({
      sessionID: coveredSession,
      boundaryMessageID: SessionMessage.ID.make("msg_already_covered_first"),
    })
    const covered = yield* compaction
      .summarize({ sessionID: coveredSession, boundaryMessageID: firstSummary.summaryMessageID })
      .pipe(Effect.flip)
    expect(covered).toMatchObject({ type: "summarize.already-covered" })

    const emptySession = SessionSchema.ID.make("ses_empty_range")
    const emptyBoundary = SessionMessage.ID.make("msg_empty_boundary")
    yield* seedSession({ id: emptySession, sequence: 2 })
    yield* insertSystemMessage(emptySession, emptyBoundary, 1)
    yield* insertMessage(emptySession, SessionMessage.ID.make("msg_empty_recent"), 2)
    const empty = yield* compaction.summarize({ sessionID: emptySession, boundaryMessageID: emptyBoundary }).pipe(Effect.flip)
    expect(empty).toMatchObject({ type: "summarize.empty-range" })
  }),
)

it.effect("rebuilds context from one checkpoint and surviving messages without adding an assistant", () =>
  Effect.gen(function* () {
    resetSummaryStream()
    summary = memory(2)
    const db = (yield* Database.Service).db
    const store = yield* SessionStore.Service
    const compaction = yield* SessionCompaction.Service
    const sessionID = SessionSchema.ID.make("ses_rebuilt_context")
    const boundaryID = SessionMessage.ID.make("msg_rebuilt_boundary")
    yield* seedSession({ id: sessionID, sequence: 4 })
    yield* insertMessage(sessionID, SessionMessage.ID.make("msg_rebuilt_deleted"), 1)
    yield* insertMessage(sessionID, boundaryID, 2)
    yield* insertMessage(sessionID, SessionMessage.ID.make("msg_rebuilt_survives"), 4)

    yield* compaction.summarize({ sessionID, boundaryMessageID: boundaryID })

    const history = (
      yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
    ).map(decodeProjection)
    const lowered = toLLMMessages(history, SessionRunnerModel.resolved(model).ref)
    const assembled = JSON.stringify(lowered)

    expect(assembled.match(/message 4/g)).toHaveLength(1)
    expect(assembled).not.toContain("message 1")
    expect((yield* store.get(sessionID))?.id).toBe(sessionID)
    expect(
      yield* db
        .select({ total: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.type, "assistant"))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([])
  }),
)

it.effect("resolves compaction models by chat scope without changing title or goal precedence", () =>
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const mainModel = SessionRunnerModel.resolved(model).ref
    const parentModel = { ...mainModel, id: ModelV2.ID.make("parent-model") }
    const subagentModel = { ...mainModel, id: ModelV2.ID.make("subagent-model") }
    const agentModel = { ...mainModel, id: ModelV2.ID.make("agent-model") }
    const parentID = SessionSchema.ID.make("ses_policy_parent")
    const mainID = SessionSchema.ID.make("ses_policy_main")
    const subagentID = SessionSchema.ID.make("ses_policy_subagent")
    yield* seedSession({ id: parentID, sequence: 0, model: parentModel })
    yield* seedSession({ id: mainID, sequence: 0, model: mainModel })
    yield* seedSession({ id: subagentID, sequence: 0, parentID, model: subagentModel })
    const main = yield* store.get(mainID)
    const subagent = yield* store.get(subagentID)
    if (!main || !subagent) return yield* Effect.die("seeded sessions must be readable")
    const selected: SessionSchema.Info[] = []
    const resolver = {
      resolve: (session: SessionSchema.Info) =>
        Effect.sync(() => {
          selected.push(session)
          return SessionRunnerModel.resolved(model)
        }),
    }
    const policy = SessionHelperPolicy.make(
      SessionHelperPolicy.settings([
        new Config.Document({
          type: "document",
          info: Schema.decodeUnknownSync(Config.Info)({
            efficiency: {
              helper_models: {
                title: "test/title-configured",
                goal: "test/goal-configured",
                compaction: { main: "test/main-configured", subagent: "test/subagent-configured" },
              },
            },
          }),
        }),
      ]),
      resolver,
    )
    const agent = { ...AgentV2.Info.empty(AgentV2.ID.make("policy-agent")), model: agentModel }

    yield* policy.resolveModel(main, "compaction", agent)
    yield* policy.resolveModel(subagent, "compaction", agent)
    expect(selected.map((session) => session.model?.id)).toEqual([
      ModelV2.ID.make("main-configured"),
      ModelV2.ID.make("subagent-configured"),
    ])

    const ownModelPolicy = SessionHelperPolicy.make(
      SessionHelperPolicy.settings([
        new Config.Document({
          type: "document",
          info: Schema.decodeUnknownSync(Config.Info)({ efficiency: { helper_models: { compaction: { subagent: "session" } } } }),
        }),
      ]),
      resolver,
    )
    yield* ownModelPolicy.resolveModel(subagent, "compaction")
    yield* SessionHelperPolicy.make({ titleMode: "local", goalMode: "local", models: {} }, resolver).resolveModel(
      subagent,
      "compaction",
    )
    expect(selected.slice(-2).map((session) => session.model?.id)).toEqual([
      ModelV2.ID.make("subagent-model"),
      ModelV2.ID.make("subagent-model"),
    ])
    expect(
      selectHelperModel({
        agentModel,
        roleModel: { ...mainModel, id: ModelV2.ID.make("title-role") },
        sessionModel: mainModel,
      }),
    ).toEqual(agentModel)
    expect(
      selectHelperModel({
        agentModel,
        roleModel: { ...mainModel, id: ModelV2.ID.make("goal-role") },
        sessionModel: mainModel,
      }),
    ).toEqual(agentModel)
  }),
)

it.effect("does not start summaries from automatic, overflow, or legacy-manual entry points", () =>
  Effect.gen(function* () {
    resetSummaryStream()
    const db = (yield* Database.Service).db
    const store = yield* SessionStore.Service
    const compaction = yield* SessionCompaction.Service
    const sessionID = SessionSchema.ID.make("ses_no_automatic_summary")
    yield* seedSession({ id: sessionID, sequence: 0 })
    const session = yield* store.get(sessionID)
    if (!session) return yield* Effect.die("seeded session must be readable")

    expect(compaction.required({ session, messages: [], model, cost: [], system: [] })).toBe(false)
    expect(yield* compaction.compact({ session, messages: [], model, cost: [], system: [] })).toMatchObject({
      status: "failed",
      error: { type: "compaction.unavailable", message: "Automatic compaction is disabled" },
    })
    expect(
      yield* compaction.compactManual({
        session,
        messages: [],
        inputID: SessionMessage.ID.make("msg_no_automatic_manual"),
      }),
    ).toMatchObject({
      status: "failed",
      error: { type: "compaction.unavailable", message: "Manual compaction must use the conversation_summarize tool" },
    })
    expect(requests).toEqual([])
    expect(
      yield* db
        .select({ type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([
      {
        type: EventV2.versionedType(SessionEvent.Compaction.Failed.type, 1),
        data: expect.objectContaining({ inputID: SessionMessage.ID.make("msg_no_automatic_manual") }),
      },
    ])
  }),
)
