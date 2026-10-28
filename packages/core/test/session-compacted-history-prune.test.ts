import { describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import { Model } from "@ycoding-ai/ai"
import { OpenAIChat } from "@ycoding-ai/ai/protocols"
import { Money } from "@ycoding-ai/schema/money"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import { eq, sql } from "drizzle-orm"
import { Clock, DateTime, Duration, Effect, Exit, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Agent } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import type { LocationServices } from "@ycoding-ai/core/location-services"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Project } from "@ycoding-ai/core/project"
import { Provider } from "@ycoding-ai/core/provider"
import { AbsolutePath, RelativePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionCompactionExecution } from "@ycoding-ai/core/session/compaction-execution"
import { SessionCompactionJob } from "@ycoding-ai/core/session/compaction-job"
import { ContextManifest } from "@ycoding-ai/core/session/context-manifest"
import { SessionContextState } from "@ycoding-ai/core/session/context-state"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionHistory } from "@ycoding-ai/core/session/history"
import { SessionLiveState } from "@ycoding-ai/core/session/live-state"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionHistoryPruning } from "@ycoding-ai/core/session/history-pruning"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionStore } from "@ycoding-ai/core/session/store"
import {
  InstructionStateTable,
  SessionContextStateTable,
  SessionMessageTable,
  SessionTable,
} from "@ycoding-ai/core/session/sql"
import { Snapshot } from "@ycoding-ai/core/snapshot"
import { testEffect } from "./lib/effect"
import { fixedLocations } from "./fixture/location-map"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const model = Model.make({
  id: "summary-model",
  provider: "test",
  route: OpenAIChat.route.with({ limits: { context: 10_000, output: 1_000 } }),
})
const ref = CatalogModel.Ref.make({ providerID: Provider.ID.make("test"), id: CatalogModel.ID.make("summary-model") })
const agent = Agent.ID.make("build")
const usage = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }

const active = new Set<Session.ID>()
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => active),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
    awaitIdle: () => Effect.void,
    withTransition: (_sessionID, effect) => effect,
  }),
)
const projects = Layer.succeed(
  Project.Service,
  Project.Service.of({
    list: () => Effect.succeed([]),
    resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
    directories: () => Effect.succeed([]),
    recordOpened: () => Effect.void,
    commit: () => Effect.void,
  }),
)
const locations = Layer.effect(
  LocationServiceMap.Service,
  fixedLocations(
    () =>
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      Layer.mergeAll(
        Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) }),
        SessionRunnerModel.layerWith(() => Effect.succeed(SessionRunnerModel.resolved(model))),
        Snapshot.noopLayer,
      ) as unknown as Layer.Layer<LocationServices>,
  ),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventRuntime.node,
      SessionCompactionExecution.node,
      SessionCompactionJob.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
    ]),
    [
      [LocationServiceMap.node, locations],
      [Project.node, projects],
      [SessionExecution.node, execution],
    ],
  ),
)

const pruning = Database.Service.pipe(
  Effect.map((database) => {
    const history = SessionHistoryPruning.make(
      database.db,
      Effect.sync(() => active),
    )
    return { prune: history.prune, pruneHistory: history.sweep }
  }),
)

const user = (sessionID: Session.ID, text: string) =>
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const inputID = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.InputAdmitted, {
      sessionID,
      inputID,
      input: { type: "user", data: { text }, delivery: "steer" },
    })
    yield* events.publish(SessionEvent.InputPromoted, { sessionID, inputID })
    yield* events.publish(SessionEvent.InputConsumed, { sessionID, inputIDs: [inputID] })
    return inputID
  })

const assistant = (sessionID: Session.ID, text: string, outcome: "ended" | "failed" = "ended") =>
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const assistantMessageID = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, agent, model: ref })
    yield* events.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
    yield* events.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text })
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID,
      assistantMessageID,
      callID: "call",
      name: "read",
    })
    yield* events.publish(SessionEvent.Tool.Called, {
      sessionID,
      assistantMessageID,
      callID: "call",
      input: { path: "README.md" },
      executed: true,
    })
    if (outcome === "failed") {
      yield* events.publish(SessionEvent.Tool.Failed, {
        sessionID,
        assistantMessageID,
        callID: "call",
        error: { type: "aborted", message: "Tool failed" },
        executed: true,
      })
      yield* events.publish(SessionEvent.Step.Failed, {
        sessionID,
        assistantMessageID,
        error: { type: "provider.failed", message: "Step failed" },
      })
      return assistantMessageID
    }
    yield* events.publish(SessionEvent.Tool.Success, {
      sessionID,
      assistantMessageID,
      callID: "call",
      structured: {},
      content: [{ type: "text", text: "file contents" }],
      executed: true,
    })
    yield* events.publish(SessionEvent.Step.Ended, {
      sessionID,
      assistantMessageID,
      finish: "stop",
      cost: Money.USD.make(0.5),
      tokens: usage,
    })
    return assistantMessageID
  })

const run = (sessionID: Session.ID, text: string, outcome: "succeeded" | "failed" = "succeeded") =>
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    yield* events.publish(SessionEvent.Execution.Started, { sessionID })
    const messageID = yield* assistant(sessionID, text, outcome === "failed" ? "failed" : "ended")
    if (outcome === "failed")
      yield* events.publish(SessionEvent.Execution.Failed, {
        sessionID,
        error: { type: "provider.failed", message: "Execution failed" },
      })
    if (outcome === "succeeded") yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID })
    return messageID
  })

const compaction = (
  sessionID: Session.ID,
  input: { readonly boundary: SessionMessage.ID; readonly status: "ended" | "failed"; readonly remote?: boolean },
) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventRuntime.Service
    const now = yield* Clock.currentTimeMillis
    const boundary = (yield* db
      .select({ seq: SessionMessageTable.seq, data: SessionMessageTable.data })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, input.boundary))
      .get()
      .pipe(Effect.orDie))!
    if (!Schema.is(Schema.Json)(boundary.data)) return yield* Effect.die("boundary message data is not JSON")
    const state = (yield* db
      .select()
      .from(SessionContextStateTable)
      .where(eq(SessionContextStateTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie))!
    const content: Schema.Json = input.remote
      ? {
          remote: {
            provider: "openai",
            modelID: "gpt-5.6",
            digest: "a".repeat(64),
            itemID: "item_remote",
            retained: [],
          },
        }
      : {
          summary: {
            text: "Checkpoint summary of the covered conversation.",
            coveredThrough: { messageID: input.boundary, seq: boundary.seq },
            digest: ContextManifest.payloadDigest(boundary.data),
          },
        }
    const digest = ContextManifest.payloadDigest(content)
    const jobID = SessionCompaction.ID.create()
    const revision = state.revision + 1
    if (input.status === "ended") {
      yield* db.run(
        sql`INSERT INTO compaction_manifest_blob (digest, schema_version, content, input_tokens, retained_tokens, time_created)
          VALUES (${digest}, 1, ${JSON.stringify(content)}, 1000, 100, ${now})`,
      )
      yield* db.run(
        sql`INSERT INTO session_context_revision (session_id, revision, parent_revision, manifest_digest, covered_through_message_id, covered_through_seq, time_created)
          VALUES (${sessionID}, ${revision}, ${state.revision}, ${digest}, ${input.boundary}, ${boundary.seq}, ${now})`,
      )
    }
    yield* db.run(
      sql`INSERT INTO session_compaction_job (id, session_id, trigger, requested_through_message_id, requested_through_seq, base_context_revision, target_max_input_tokens, config_digest, status, attempts, manifest_digest, error_code, error_message, time_created, time_started, time_ended)
        VALUES (${jobID}, ${sessionID}, 'manual', ${input.boundary}, ${boundary.seq}, ${state.revision}, 1000, ${"0".repeat(64)}, ${input.status}, 1,
          ${input.status === "ended" ? digest : null}, ${input.status === "failed" ? "provider_failed" : null},
          ${input.status === "failed" ? "Provider failed" : null}, ${now}, ${now}, ${now})`,
    )
    yield* events.publish(SessionEvent.Compaction.Admitted, { sessionID, jobID })
    yield* events.publish(SessionEvent.Compaction.Started, { sessionID, jobID })
    if (input.status === "failed") {
      yield* events.publish(SessionEvent.Compaction.Failed, {
        sessionID,
        jobID,
        code: "provider_failed",
        error: { type: "provider.failed", message: "Compaction failed" },
      })
      return jobID
    }
    const ended = yield* events.publish(SessionEvent.Compaction.Ended, {
      sessionID,
      jobID,
      revision,
      boundary: { messageID: input.boundary, seq: boundary.seq },
      metrics: { excludedMessages: 3, excludedParts: 0, inputTokens: 1000, retainedTokens: 100 },
    })
    yield* db
      .update(SessionContextStateTable)
      .set({
        revision,
        manifest_digest: digest,
        covered_through_message_id: input.boundary,
        covered_through_seq: boundary.seq,
        activated_event_id: ended.id,
        time_activated: now,
      })
      .where(eq(SessionContextStateTable.session_id, sessionID))
      .run()
      .pipe(Effect.orDie)
    return jobID
  })

const scenario = Effect.gen(function* () {
  const session = yield* Session.Service
  const events = yield* EventRuntime.Service
  const created = yield* session.create({ location, model: ref })
  const sessionID = created.id
  yield* session.pin(sessionID)
  const firstUser = yield* user(sessionID, "First request")
  const firstAnswer = yield* run(sessionID, "First answer")
  yield* events.publish(SessionEvent.ContextObserved, { sessionID, source: "session-state", text: "state before" })
  yield* events.publish(SessionEvent.ContextObserved, { sessionID, source: "team-view", text: "team before" })
  yield* events.publish(SessionEvent.Synthetic, { sessionID, text: "Covered synthetic note" })
  const failedJob = yield* compaction(sessionID, { boundary: firstAnswer, status: "failed" })
  const forkTarget = yield* user(sessionID, "Second request")
  const failedAnswer = yield* run(sessionID, "Failed answer", "failed")
  const fork = yield* session.fork({ sessionID, messageID: forkTarget })
  yield* session.pin(fork.id)
  const coveredUser = yield* user(sessionID, "Third request")
  const boundary = yield* run(sessionID, "Boundary answer")
  const job = yield* compaction(sessionID, { boundary, status: "ended" })
  yield* events.publish(SessionEvent.ContextObserved, { sessionID, source: "session-state", text: "state after" })
  const tailUser = yield* user(sessionID, "Fourth request")
  const tailAnswer = yield* run(sessionID, "Fourth answer")
  const failedTail = yield* run(sessionID, "Failed tail", "failed")
  yield* compaction(sessionID, { boundary: tailAnswer, status: "failed" })
  const { db } = yield* Database.Service
  const seq = (id: SessionMessage.ID) =>
    db
      .select({ seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, id))
      .get()
      .pipe(
        Effect.orDie,
        Effect.map((row) => row!.seq),
      )
  return {
    sessionID,
    fork: fork.id,
    job,
    failedJob,
    ids: { firstUser, firstAnswer, forkTarget, failedAnswer, coveredUser, boundary, tailUser, tailAnswer, failedTail },
    through: yield* seq(boundary),
  }
})

const messageIDs = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ id: SessionMessageTable.id, type: SessionMessageTable.type, seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID))
      .orderBy(SessionMessageTable.seq)
      .all()
      .pipe(Effect.orDie)
  })

const eventTypesBefore = (sessionID: Session.ID, through: number) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return (yield* db
      .all<{ type: string; source: string | null }>(
        sql`SELECT type, json_extract(data, '$.source') AS source FROM event
          WHERE aggregate_id = ${sessionID} AND seq < ${through} ORDER BY seq`,
      )
      .pipe(Effect.orDie)).map((row) => (row.source ? `${row.type}:${row.source}` : row.type))
  })

const counts = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .get<{ messages: number; events: number }>(
        sql`SELECT (SELECT count(*) FROM session_message WHERE session_id = ${sessionID}) AS messages,
          (SELECT count(*) FROM event WHERE aggregate_id = ${sessionID}) AS events`,
      )
      .pipe(Effect.orDie)
  })

const coveredErrorTypes = ["session.tool.failed.1", "session.step.failed.1", "session.execution.failed.1"]
const retainedHistoryTypes = [
  "session.compaction.failed.2",
  "session.created.2",
  "session.pinned.1",
  "session.input.admitted.1",
  "session.input.promoted.1",
  "session.input.consumed.1",
  "session.context.observed.1:team-view",
  "session.compaction.admitted.2",
  "session.compaction.started.2",
]

describe("compacted history pruning", () => {
  it.effect("deletes history covered by an ended local checkpoint and keeps required rows", () =>
    Effect.gen(function* () {
      const retention = yield* pruning
      const session = yield* Session.Service
      const fixture = yield* scenario
      const before = yield* counts(fixture.sessionID)
      const historyBefore = yield* session.compactionHistory(fixture.sessionID)

      const pruned = yield* retention.prune(fixture.sessionID)
      const after = yield* counts(fixture.sessionID)
      expect(pruned.messages).toBe(before!.messages - after!.messages)
      expect(pruned.events).toBe(before!.events - after!.events)
      expect(pruned.messages).toBeGreaterThan(0)

      const remaining = yield* messageIDs(fixture.sessionID)
      expect(remaining.filter((row) => row.seq < fixture.through).map((row) => row.id)).toEqual([
        fixture.ids.firstUser,
        remaining.find((row) => row.type === "compaction" && row.seq < fixture.through)!.id,
        fixture.ids.forkTarget,
      ])
      expect(remaining.filter((row) => row.seq < fixture.through).map((row) => row.type)).toEqual([
        "user",
        "compaction",
        "user",
      ])
      expect(remaining.map((row) => row.id)).toContain(fixture.ids.boundary)
      expect(remaining.map((row) => row.id)).toEqual(
        expect.arrayContaining([fixture.ids.tailUser, fixture.ids.tailAnswer, fixture.ids.failedTail]),
      )
      expect(remaining.filter((row) => row.type === "compaction")).toHaveLength(3)

      const types = yield* eventTypesBefore(fixture.sessionID, fixture.through)
      expect([...new Set(types)].toSorted()).toEqual(retainedHistoryTypes.toSorted())
      expect(types.filter((type) => type === "session.input.consumed.1")).toHaveLength(2)
      expect(types.filter((type) => type === "session.input.promoted.1")).toHaveLength(3)

      const history = yield* session.compactionHistory(fixture.sessionID)
      expect(history).toEqual(historyBefore)
      expect(history.totalSavedTokens).toBe(900)
      expect(history.completedCount).toBe(1)
      expect(history.data.map((job) => job.status)).toEqual(["failed", "completed", "failed"])

      expect(yield* retention.prune(fixture.sessionID)).toEqual({ messages: 0, events: 0, images: 0 })
      expect(yield* counts(fixture.sessionID)).toEqual(after)
    }),
  )

  it.effect("keeps usage totals and the provider request ledger", () =>
    Effect.gen(function* () {
      const retention = yield* pruning
      const { db } = yield* Database.Service
      const fixture = yield* scenario
      const totals = () =>
        db
          .select({ cost: SessionTable.cost, input: SessionTable.tokens_input, output: SessionTable.tokens_output })
          .from(SessionTable)
          .where(eq(SessionTable.id, fixture.sessionID))
          .get()
          .pipe(Effect.orDie)
      yield* db.run(
        sql`INSERT INTO session_provider_request (id, session_id, input_id, assistant_message_id, source, agent, model, route_id, prompt_cache_key, system_digest, tool_digest, request, attempts, invalidation, continuation, tokens, cost, time_created)
          VALUES ('preq_covered', ${fixture.sessionID}, ${fixture.ids.firstUser}, ${fixture.ids.firstAnswer}, 'step', 'build', ${JSON.stringify(ref)}, 'openai-chat', 'key', 'system', 'tools', 1, 1, 'none', 'full', ${JSON.stringify(usage)}, 0.5, 0)`,
      )
      const ledger = () =>
        db.all(sql`SELECT * FROM session_provider_request WHERE session_id = ${fixture.sessionID}`).pipe(Effect.orDie)
      const usageBefore = yield* totals()
      const ledgerBefore = yield* ledger()
      const session = yield* Session.Service
      const costsBefore = yield* session.promptCosts({ sessionID: fixture.sessionID, inputIDs: [fixture.ids.firstUser] })
      expect(costsBefore.units[0]!.total.cost.known).toBe(Money.USD.make(0.5))
      expect(usageBefore?.cost).toBeGreaterThan(0)
      expect(ledgerBefore).toHaveLength(1)
      expect((yield* retention.prune(fixture.sessionID)).messages).toBeGreaterThan(0)
      expect(yield* totals()).toEqual(usageBefore)
      expect(yield* ledger()).toEqual(ledgerBefore)
      expect(yield* session.promptCosts({ sessionID: fixture.sessionID, inputIDs: [fixture.ids.firstUser] })).toEqual(costsBefore)
    }),
  )

  it.effect("deletes covered error events with the rest of the covered history", () =>
    Effect.gen(function* () {
      const retention = yield* pruning
      const fixture = yield* scenario
      const errors = () =>
        eventTypesBefore(fixture.sessionID, fixture.through).pipe(
          Effect.map((types) => types.filter((type) => coveredErrorTypes.includes(type))),
        )
      expect([...new Set(yield* errors())].toSorted()).toEqual(coveredErrorTypes.toSorted())
      yield* retention.prune(fixture.sessionID)
      expect(yield* errors()).toEqual([])
      const types = yield* eventTypesBefore(fixture.sessionID, fixture.through)
      expect([...new Set(types)].toSorted()).toEqual(retainedHistoryTypes.toSorted())
      expect(yield* retention.prune(fixture.sessionID)).toEqual({ messages: 0, events: 0, images: 0 })
    }),
  )

  it.effect("leaves the next model-visible history and runtime state unchanged", () =>
    Effect.gen(function* () {
      const retention = yield* pruning
      const { db } = yield* Database.Service
      const fixture = yield* scenario
      yield* db
        .insert(InstructionStateTable)
        .values({
          session_id: fixture.sessionID,
          epoch_start: 0,
          through_seq: 0,
          initial_values: {},
          current_values: {},
        })
        .run()
        .pipe(Effect.orDie)
      const observed = () =>
        db
          .all<{ source: string }>(
            sql`SELECT DISTINCT json_extract(data, '$.source') AS source FROM event
              WHERE aggregate_id = ${fixture.sessionID} AND type = 'session.context.observed.1' ORDER BY source`,
          )
          .pipe(Effect.orDie)
      const state = Effect.gen(function* () {
        const observation = yield* SessionHistory.observationState(db, fixture.sessionID)
        return JSON.stringify({
          history: yield* SessionHistory.entriesForRunner(db, fixture.sessionID, []),
          live: yield* SessionLiveState.captureDatabase(db, fixture.sessionID),
          observation: { latest: [...observation.latest], present: [...observation.present] },
          observed: yield* observed(),
          latest: yield* SessionHistory.latest(db, fixture.sessionID, "assistant"),
          recent: yield* SessionHistory.recent(db, fixture.sessionID, 12),
          first: (yield* SessionHistory.firstUserMessageIfOnly(db, fixture.sessionID)) ?? null,
        })
      })
      const before = yield* state
      expect(before).toContain("conversation-checkpoint")
      expect((yield* retention.prune(fixture.sessionID)).messages).toBeGreaterThan(0)
      expect(yield* state).toBe(before)
    }),
  )

  it.effect("returns retained history with the checkpoint first and stops paging there", () =>
    Effect.gen(function* () {
      const retention = yield* pruning
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const fixture = yield* scenario
      const read = Effect.gen(function* () {
        const transcript = yield* SessionHistory.transcript(db, fixture.sessionID)
        const listed = yield* session.messages({ sessionID: fixture.sessionID, order: "asc", retained: true })
        const pages: SessionMessage.Info[][] = []
        let before: string | undefined
        while (true) {
          const page = yield* session.snapshot(fixture.sessionID, { limit: 2, before })
          pages.unshift(page.messages)
          if (!page.before) break
          before = page.before
        }
        return { transcript, listed, paged: pages.flat() }
      })
      const unpruned = yield* read
      expect((yield* retention.prune(fixture.sessionID)).messages).toBeGreaterThan(0)
      const pruned = yield* read
      expect(pruned).toEqual(unpruned)

      const retained = new Set(
        (yield* messageIDs(fixture.sessionID)).filter((row) => row.seq > fixture.through).map((row) => row.id),
      )
      for (const messages of [pruned.transcript, pruned.listed, pruned.paged]) {
        const head = messages[0]
        expect(head?.type).toBe("synthetic")
        expect(head?.type === "synthetic" && head.text).toContain("Checkpoint summary of the covered conversation.")
        expect(head?.type === "synthetic" && head.description).toBe("Compaction checkpoint")
        expect(head?.metadata?.compactionCheckpoint).toEqual({
          manifestDigest: expect.any(String),
          through: fixture.through,
        })
        expect(messages.slice(1).every((message) => retained.has(message.id))).toBe(true)
      }
      expect(pruned.listed.map((message) => message.id)).toEqual([pruned.listed[0].id, ...retained])

      const owner = createHash("sha256").update(fixture.sessionID).digest("hex").slice(0, 16)
      const cursor = (seq: number) => Buffer.from(`${owner}:${seq}`).toString("base64url")
      const atFloor = yield* session.snapshot(fixture.sessionID, { limit: 2, before: cursor(fixture.through + 1) })
      expect(atFloor.messages.map((message) => message.id)).toEqual([pruned.listed[0].id])
      expect(atFloor.before).toBeUndefined()
      const covered = yield* session.snapshot(fixture.sessionID, { limit: 2, before: cursor(1) })
      expect(covered.messages).toEqual([])
      expect(covered.before).toBeUndefined()

      const raw = yield* session.messages({ sessionID: fixture.sessionID, order: "asc" })
      expect(raw[0]?.id).toBe(fixture.ids.firstUser)
    }),
  )

  it.effect("rejects fork and revert targets outside retained history without changing state", () =>
    Effect.gen(function* () {
      const retention = yield* pruning
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const fixture = yield* scenario
      yield* retention.prune(fixture.sessionID)
      const sessions = () => db.get<{ count: number }>(sql`SELECT count(*) AS count FROM session`).pipe(Effect.orDie)
      const before = { sessions: yield* sessions(), rows: yield* counts(fixture.sessionID) }

      for (const messageID of [
        fixture.ids.firstAnswer,
        fixture.ids.boundary,
        fixture.ids.forkTarget,
        SessionMessage.ID.create(),
      ]) {
        const fork = yield* session.fork({ sessionID: fixture.sessionID, messageID }).pipe(Effect.exit)
        expect(Exit.isFailure(fork) && fork.cause.toString()).toContain("Session.HistoryPrunedError")
        const revert = yield* session.revert.stage({ sessionID: fixture.sessionID, messageID }).pipe(Effect.exit)
        expect(Exit.isFailure(revert) && revert.cause.toString()).toContain("Session.HistoryPrunedError")
      }
      expect({ sessions: yield* sessions(), rows: yield* counts(fixture.sessionID) }).toEqual(before)
      expect((yield* session.get(fixture.sessionID)).revert).toBeUndefined()

      const other = yield* session
        .fork({ sessionID: fixture.sessionID, messageID: fixture.ids.firstUser })
        .pipe(Effect.flip)
      expect(other._tag).toBe("Session.HistoryPrunedError")

      const parentRows = yield* messageIDs(fixture.sessionID)
      const forkSeq = parentRows.find((row) => row.id === fixture.ids.tailAnswer)!.seq
      const child = yield* session.fork({ sessionID: fixture.sessionID, messageID: fixture.ids.tailAnswer })
      const childRows = yield* messageIDs(child.id)
      expect(childRows.map((row) => [row.seq, row.type])).toEqual([
        [fixture.through, "synthetic"],
        ...parentRows.filter((row) => row.seq > fixture.through && row.seq < forkSeq).map((row) => [row.seq, row.type]),
      ])
      const parentModel = yield* SessionHistory.forModel(db, fixture.sessionID)
      const childModel = yield* SessionHistory.forModel(db, child.id)
      expect(parentModel[0]).toMatchObject({ type: "synthetic" })
      expect(childModel[0]).toMatchObject({
        type: "synthetic",
        text: parentModel[0]?.type === "synthetic" ? parentModel[0].text : "",
      })
      expect(JSON.stringify(childModel[0])).toContain("conversation-checkpoint")
      expect(childRows.filter((row) => row.type === "user")).toHaveLength(1)
      expect(yield* SessionHistory.firstUserMessageIfOnly(db, child.id)).toBeUndefined()

      const staged = yield* session.revert.stage({ sessionID: fixture.sessionID, messageID: fixture.ids.tailUser })
      expect(staged.messageID).toBe(fixture.ids.tailUser)
    }),
  )

  it.effect(
    "preserves checkpoint reads, paging, and fork/revert boundaries while pruning and rewriting tail images",
    () =>
      Effect.gen(function* () {
        const retention = yield* pruning
        const session = yield* Session.Service
        const events = yield* EventRuntime.Service
        const { db } = yield* Database.Service
        const fixture = yield* scenario
        for (const assistantMessageID of [fixture.ids.boundary, fixture.ids.tailAnswer]) {
          yield* events.publish(SessionEvent.Tool.Input.Started, {
            sessionID: fixture.sessionID,
            assistantMessageID,
            callID: "image-call",
            name: "snapshot",
          })
          yield* events.publish(SessionEvent.Tool.Called, {
            sessionID: fixture.sessionID,
            assistantMessageID,
            callID: "image-call",
            input: {},
            executed: true,
          })
          yield* events.publish(SessionEvent.Tool.Success, {
            sessionID: fixture.sessionID,
            assistantMessageID,
            callID: "image-call",
            structured: {},
            executed: true,
            content: [
              { type: "text", text: "captured" },
              { type: "file", mime: "image/png", uri: pixel },
            ],
          })
        }
        yield* compaction(fixture.sessionID, { boundary: fixture.ids.boundary, status: "ended" })
        yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID: fixture.sessionID })
        const checkpoint = yield* SessionContextState.checkpoint(db, fixture.sessionID)
        expect(checkpoint).toBeDefined()
        const boundary = (yield* messageRows(fixture.sessionID)).find((row) => row.id === fixture.ids.boundary)
        expect(boundary?.data).toContain(pixel)
        const paged = Effect.gen(function* () {
          const messages: SessionMessage.Info[][] = []
          let before: string | undefined
          while (true) {
            const page = yield* session.snapshot(fixture.sessionID, { limit: 2, before })
            messages.unshift(page.messages)
            if (!page.before) return messages.flat()
            before = page.before
          }
        })
        const before = { model: yield* SessionHistory.forModel(db, fixture.sessionID), paged: yield* paged }
        expect(JSON.stringify(before.model)).toContain(pixel)
        yield* TestClock.adjust(SessionHistoryPruning.IMAGE_IDLE)
        const pruned = yield* retention.prune(fixture.sessionID)
        expect(pruned.messages).toBeGreaterThan(0)
        expect(pruned.events).toBeGreaterThan(0)
        expect(pruned.images).toBe(1)
        expect(yield* SessionContextState.checkpoint(db, fixture.sessionID)).toEqual(checkpoint)
        expect((yield* messageRows(fixture.sessionID)).find((row) => row.id === fixture.ids.boundary)).toEqual(boundary)
        const after = { model: yield* SessionHistory.forModel(db, fixture.sessionID), paged: yield* paged }
        expect(after.model.filter((message) => message.id !== fixture.ids.tailAnswer)).toEqual(
          before.model.filter((message) => message.id !== fixture.ids.tailAnswer),
        )
        expect(after.paged.filter((message) => message.id !== fixture.ids.tailAnswer)).toEqual(
          before.paged.filter((message) => message.id !== fixture.ids.tailAnswer),
        )
        expect(after.paged.map((message) => message.id)).toEqual(before.paged.map((message) => message.id))
        expect(JSON.stringify(after.model)).toContain("conversation-checkpoint")
        expect(JSON.stringify(after.model)).not.toContain(pixel)
        expect((yield* toolPart(fixture.sessionID, fixture.ids.tailAnswer, "image-call")).content).toEqual([
          { type: "text", text: "captured" },
          { type: "text", text: "[Image removed from stored history: image/png, 2.9 KiB]" },
        ])
        expect(after.paged).toEqual(
          yield* session.messages({ sessionID: fixture.sessionID, order: "asc", retained: true }),
        )
        const owner = createHash("sha256").update(fixture.sessionID).digest("hex").slice(0, 16)
        const floor = yield* session.snapshot(fixture.sessionID, {
          limit: 2,
          before: Buffer.from(`${owner}:${fixture.through + 1}`).toString("base64url"),
        })
        expect(floor.messages).toEqual([after.paged[0]])
        expect(floor.before).toBeUndefined()

        const sessions = () => db.get<{ count: number }>(sql`SELECT count(*) AS count FROM session`).pipe(Effect.orDie)
        const unchanged = { sessions: yield* sessions(), messages: yield* messageRows(fixture.sessionID) }
        for (const messageID of [fixture.ids.firstAnswer, fixture.ids.boundary]) {
          expect((yield* session.fork({ sessionID: fixture.sessionID, messageID }).pipe(Effect.flip))._tag).toBe(
            "Session.HistoryPrunedError",
          )
          expect(
            (yield* session.revert.stage({ sessionID: fixture.sessionID, messageID }).pipe(Effect.flip))._tag,
          ).toBe("Session.HistoryPrunedError")
        }
        expect({ sessions: yield* sessions(), messages: yield* messageRows(fixture.sessionID) }).toEqual(unchanged)
        expect((yield* session.get(fixture.sessionID)).revert).toBeUndefined()
        const child = yield* session.fork({ sessionID: fixture.sessionID, messageID: fixture.ids.failedTail })
        const childModel = yield* SessionHistory.forModel(db, child.id)
        expect(childModel[0]).toMatchObject({
          type: "synthetic",
          text: after.model[0]?.type === "synthetic" ? after.model[0].text : "",
        })
        expect(JSON.stringify(childModel)).toContain("[Image removed from stored history: image/png, 2.9 KiB]")
        expect(JSON.stringify(childModel)).not.toContain(pixel)
        const staged = yield* session.revert.stage({ sessionID: fixture.sessionID, messageID: fixture.ids.tailAnswer })
        expect(staged.messageID).toBe(fixture.ids.tailAnswer)
        expect(yield* SessionContextState.checkpoint(db, fixture.sessionID)).toEqual(checkpoint)
      }),
  )

  it.effect("returns the first admission when a pruned prompt ID is sent again", () =>
    Effect.gen(function* () {
      const retention = yield* pruning
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const fixture = yield* scenario
      const admittedSeq = (yield* db
        .get<{ seq: number }>(
          sql`SELECT seq FROM event WHERE aggregate_id = ${fixture.sessionID} AND type = 'session.input.admitted.1'
            AND json_extract(data, '$.inputID') = ${fixture.ids.coveredUser}`,
        )
        .pipe(Effect.orDie))!.seq
      expect((yield* retention.prune(fixture.sessionID)).messages).toBeGreaterThan(0)
      const row = () =>
        db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, fixture.ids.coveredUser))
          .get()
          .pipe(Effect.orDie)
      expect(yield* row()).toBeUndefined()
      const before = yield* counts(fixture.sessionID)

      const resent = yield* session.prompt({
        sessionID: fixture.sessionID,
        id: fixture.ids.coveredUser,
        text: "Changed text",
        resume: false,
      })
      expect(resent).toMatchObject({
        id: fixture.ids.coveredUser,
        sessionID: fixture.sessionID,
        type: "user",
        admittedSeq,
        data: { text: "Third request" },
      })
      expect(yield* session.pending(fixture.sessionID)).toEqual([])
      expect(yield* row()).toBeUndefined()
      expect(yield* counts(fixture.sessionID)).toEqual(before)

      const synthetic = yield* session
        .synthetic({
          sessionID: fixture.sessionID,
          id: fixture.ids.coveredUser,
          text: "Synthetic reuse",
          resume: false,
        })
        .pipe(Effect.flip)
      expect(synthetic._tag).toBe("Session.SyntheticConflictError")
      expect(yield* counts(fixture.sessionID)).toEqual(before)
    }),
  )

  it.effect("returns MessageNotFoundError for messages of another Session", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const fixture = yield* scenario
      const other = yield* session.create({ location, model: ref })
      const error = yield* session.fork({ sessionID: other.id, messageID: fixture.ids.tailUser }).pipe(Effect.flip)
      expect(error._tag).toBe("Session.MessageNotFoundError")
    }),
  )

  it.effect("leaves sessions without an eligible ended local checkpoint untouched", () =>
    Effect.gen(function* () {
      const retention = yield* pruning
      const session = yield* Session.Service
      const { db } = yield* Database.Service

      const failedOnly = (yield* session.create({ location, model: ref })).id
      yield* user(failedOnly, "Only request")
      const failedBoundary = yield* run(failedOnly, "Only answer")
      yield* compaction(failedOnly, { boundary: failedBoundary, status: "failed" })
      yield* user(failedOnly, "Later request")

      const remote = (yield* session.create({ location, model: ref })).id
      yield* user(remote, "Remote request")
      const remoteBoundary = yield* run(remote, "Remote answer")
      yield* compaction(remote, { boundary: remoteBoundary, status: "ended", remote: true })
      yield* user(remote, "Remote later request")

      const pending = (yield* scenario).sessionID
      yield* db.run(
        sql`INSERT INTO session_compaction_job (id, session_id, trigger, requested_through_message_id, requested_through_seq, base_context_revision, target_max_input_tokens, config_digest, status, attempts, time_created)
          SELECT ${SessionCompaction.ID.create()}, session_id, 'manual', covered_through_message_id, covered_through_seq, revision, 1000, ${"0".repeat(64)}, 'pending', 0, 0
          FROM session_context_state WHERE session_id = ${pending}`,
      )
      const staged = yield* scenario
      yield* session.revert.stage({ sessionID: staged.sessionID, messageID: staged.ids.tailUser })
      const running = yield* scenario
      active.add(running.sessionID)

      const ids = [failedOnly, remote, pending, staged.sessionID, running.sessionID]
      const before = yield* Effect.forEach(ids, counts)
      const swept = yield* retention.pruneHistory()
      expect(yield* Effect.forEach(ids, counts)).toEqual(before)
      expect(swept).toEqual({ messages: 0, events: 0, images: 0 })

      active.delete(running.sessionID)
      const resumed = yield* retention.pruneHistory()
      expect(resumed.messages).toBeGreaterThan(0)
      expect((yield* counts(running.sessionID))!.messages).toBeLessThan(before[4]!.messages)
      expect(yield* Effect.forEach(ids.slice(0, 4), counts)).toEqual(before.slice(0, 4))
    }),
  )

  it.effect("backfills existing ended compactions on the first sweep and is idempotent", () =>
    Effect.gen(function* () {
      const retention = yield* pruning
      const first = yield* scenario
      const second = yield* scenario
      const before = [yield* counts(first.sessionID), yield* counts(second.sessionID)]
      const swept = yield* retention.pruneHistory()
      const after = [yield* counts(first.sessionID), yield* counts(second.sessionID)]
      expect(swept.messages).toBe(before[0]!.messages - after[0]!.messages + before[1]!.messages - after[1]!.messages)
      expect(after[0]!.messages).toBeLessThan(before[0]!.messages)
      expect(after[1]!.messages).toBeLessThan(before[1]!.messages)
      expect(yield* retention.pruneHistory()).toEqual({ messages: 0, events: 0, images: 0 })
    }),
  )
})

const grace = Duration.toMillis(SessionHistoryPruning.SETTLED_GRACE)
const idle = Duration.toMillis(SessionHistoryPruning.IMAGE_IDLE)
const screenshot = Buffer.alloc(60_000, 9).toString("base64")
const pixel = `data:image/png;base64,${Buffer.alloc(3_000, 7).toString("base64")}`

const settledScenario = (input: { readonly image?: boolean; readonly retries?: number } = {}) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const events = yield* EventRuntime.Service
    const sessionID = (yield* session.create({ location, model: ref })).id
    const userID = yield* user(sessionID, "Inspect the screen")
    yield* events.publish(SessionEvent.Execution.Started, { sessionID })
    const toolStep = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: toolStep, agent, model: ref })
    yield* events.publish(SessionEvent.Reasoning.Started, {
      sessionID,
      assistantMessageID: toolStep,
      ordinal: 0,
      state: { reasoningEncryptedContent: "encrypted-start" },
    })
    yield* events.publish(SessionEvent.Reasoning.Ended, {
      sessionID,
      assistantMessageID: toolStep,
      ordinal: 0,
      text: "Plan the capture",
      state: { reasoningEncryptedContent: "encrypted-final", signature: "sig_reasoning" },
    })
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID,
      assistantMessageID: toolStep,
      callID: "call_screen",
      name: "computer",
    })
    yield* events.publish(SessionEvent.Tool.Input.Ended, {
      sessionID,
      assistantMessageID: toolStep,
      callID: "call_screen",
      text: '{"action":"capture"}',
    })
    yield* events.publish(SessionEvent.Tool.Called, {
      sessionID,
      assistantMessageID: toolStep,
      callID: "call_screen",
      input: { action: "capture" },
      executed: false,
      state: { itemId: "fc_screen" },
    })
    for (let attempt = 1; attempt <= (input.retries ?? 0); attempt++)
      yield* events.publish(SessionEvent.RetryScheduled, {
        sessionID,
        assistantMessageID: toolStep,
        attempt,
        at: attempt,
        error: { type: "provider.failed", message: "Retry" },
      })
    yield* events.publish(SessionEvent.Tool.Success, {
      sessionID,
      assistantMessageID: toolStep,
      callID: "call_screen",
      structured: { type: "result", image: screenshot, width: 4, height: 3 },
      content: [
        { type: "text", text: "captured" },
        ...(input.image ? [{ type: "file" as const, uri: pixel, mime: "image/png", name: "screen.png" }] : []),
      ],
      executed: false,
      resultState: { itemId: "fco_screen" },
    })
    yield* events.publish(SessionEvent.FileChange.Recorded, {
      sessionID,
      change: { path: RelativePath.make("notes.txt"), patch: "@@ -0,0 +1 @@\n+note\n", additions: 1, deletions: 0 },
    })
    yield* events.publish(SessionEvent.ProviderRequestRecorded, {
      id: ProviderRequest.ID.make("prq_settled"),
      sessionID,
      inputID: userID,
      assistantMessageID: toolStep,
      connectionIdentityDigest: "c".repeat(64),
      source: "step",
      agent,
      model: ref,
      routeID: "openai-chat",
      promptCacheKey: "key",
      systemDigest: "system",
      toolDigest: "tools",
      request: 1,
      attempts: 1,
      invalidation: "first-request",
      continuation: "full",
      tokens: usage,
      cost: Money.USD.make(0.25),
      time: DateTime.makeUnsafe(0),
    })
    yield* events.publish(SessionEvent.Step.Ended, {
      sessionID,
      assistantMessageID: toolStep,
      finish: "tool-calls",
      cost: Money.USD.make(0.25),
      tokens: usage,
    })
    const finalStep = yield* assistant(sessionID, "Final answer")
    yield* events.publish(SessionEvent.ContextObserved, { sessionID, source: "session-state", text: "settled state" })
    yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID })
    yield* events.publish(SessionEvent.UsageRecorded, {
      sessionID,
      source: "title",
      cost: Money.USD.make(0.01),
      tokens: usage,
    })
    return { sessionID, userID, toolStep, finalStep }
  })

const eventTypes = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return (yield* db
      .all<{ type: string }>(sql`SELECT type FROM event WHERE aggregate_id = ${sessionID} ORDER BY seq`)
      .pipe(Effect.orDie)).map((row) => row.type)
  })

const messageRows = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .all<{
        id: string
        type: string
        seq: number
        data: string
      }>(sql`SELECT id, type, seq, data FROM session_message WHERE session_id = ${sessionID} ORDER BY seq`)
      .pipe(Effect.orDie)
  })

const toolPart = (sessionID: Session.ID, messageID: SessionMessage.ID, callID?: string) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const message = (yield* session.messages({ sessionID, order: "asc" })).find((item) => item.id === messageID)
    if (message?.type !== "assistant") return yield* Effect.die("missing assistant message")
    const part = message.content.find((item) => item.type === "tool" && (callID === undefined || item.id === callID))
    if (part?.type !== "tool" || part.state.status !== "completed") return yield* Effect.die("missing completed tool")
    return part.state
  })

const settledDroppedTypes = [
  "session.input.consumed.1",
  "session.reasoning.started.1",
  "session.reasoning.ended.1",
  "session.text.started.1",
  "session.text.ended.1",
  "session.tool.input.started.1",
  "session.tool.input.ended.1",
  "session.tool.called.1",
  "session.tool.success.1",
  "session.file-change.recorded.1",
  "session.provider.request.recorded.1",
]
const settledRetainedTypes = [
  "session.created.2",
  "session.input.admitted.1",
  "session.input.promoted.1",
  "session.execution.started.1",
  "session.step.started.1",
  "session.step.ended.1",
  "session.context.observed.1",
  "session.execution.succeeded.1",
  "session.usage.recorded.1",
]

describe("settled execution pruning", () => {
  it.effect("drops message-only events after the grace and keeps the projection, reads, and kept events", () =>
    Effect.gen(function* () {
      const retention = yield* pruning
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const fixture = yield* settledScenario()
      const before = yield* eventTypes(fixture.sessionID)
      expect(before).toEqual(expect.arrayContaining(settledDroppedTypes))
      yield* db
        .insert(InstructionStateTable)
        .values({
          session_id: fixture.sessionID,
          epoch_start: 0,
          through_seq: 0,
          initial_values: {},
          current_values: {},
        })
        .run()
        .pipe(Effect.orDie)
      const read = Effect.gen(function* () {
        const observation = yield* SessionHistory.observationState(db, fixture.sessionID)
        const pages: SessionMessage.Info[][] = []
        let cursor: string | undefined
        while (true) {
          const page = yield* session.snapshot(fixture.sessionID, { limit: 2, before: cursor })
          pages.unshift(page.messages)
          if (!page.before) break
          cursor = page.before
        }
        return {
          rows: yield* messageRows(fixture.sessionID),
          paged: pages.flat(),
          history: yield* SessionHistory.entriesForRunner(db, fixture.sessionID, []),
          live: yield* SessionLiveState.captureDatabase(db, fixture.sessionID),
          observation: { latest: [...observation.latest], present: [...observation.present] },
          usage: yield* session.usageReportAll({ group: "model" }),
          totals: yield* db
            .all(sql`SELECT cost, tokens_input, tokens_output FROM session WHERE id = ${fixture.sessionID}`)
            .pipe(Effect.orDie),
          ledger: yield* db
            .all(sql`SELECT * FROM session_provider_request WHERE session_id = ${fixture.sessionID}`)
            .pipe(Effect.orDie),
          fileChanges: yield* session.fileChanges(fixture.sessionID),
        }
      })
      const unpruned = yield* read
      expect(unpruned.ledger).toHaveLength(1)
      expect(unpruned.fileChanges).toHaveLength(1)

      yield* TestClock.adjust(Duration.millis(grace - 1))
      expect(yield* retention.prune(fixture.sessionID)).toEqual({ messages: 0, events: 0, images: 0 })
      expect(yield* eventTypes(fixture.sessionID)).toEqual(before)

      yield* TestClock.adjust(Duration.millis(1))
      const pruned = yield* retention.prune(fixture.sessionID)
      const after = yield* eventTypes(fixture.sessionID)
      expect(pruned).toEqual({ messages: 0, events: before.length - after.length, images: 0 })
      expect(after).toEqual(settledRetainedTypes)
      expect(yield* read).toEqual(unpruned)
      expect(JSON.stringify(unpruned.history)).toContain("encrypted-final")
      expect(JSON.stringify(unpruned.history)).toContain("fco_screen")
      expect(yield* retention.prune(fixture.sessionID)).toEqual({ messages: 0, events: 0, images: 0 })
    }),
  )

  it.effect("forks and reverts a pruned settled Session", () =>
    Effect.gen(function* () {
      const retention = yield* pruning
      const session = yield* Session.Service
      const fixture = yield* settledScenario()
      yield* TestClock.adjust(Duration.millis(grace))
      expect((yield* retention.prune(fixture.sessionID)).events).toBeGreaterThan(0)

      const parent = yield* messageRows(fixture.sessionID)
      const forkSeq = parent.find((row) => row.id === fixture.finalStep)!.seq
      const child = yield* session.fork({ sessionID: fixture.sessionID, messageID: fixture.finalStep })
      expect((yield* messageRows(child.id)).map((row) => [row.seq, row.type, row.data])).toEqual(
        parent.filter((row) => row.seq < forkSeq).map((row) => [row.seq, row.type, row.data]),
      )
      const staged = yield* session.revert.stage({ sessionID: fixture.sessionID, messageID: fixture.toolStep })
      expect(staged.messageID).toBe(fixture.toolStep)
      yield* session.revert.commit(fixture.sessionID)
      const remaining = (yield* messageRows(fixture.sessionID)).map((row) => row.id)
      expect(remaining).toContain(fixture.userID)
      expect(remaining).not.toContain(fixture.toolStep)
      expect(remaining).not.toContain(fixture.finalStep)
    }),
  )

  it.effect("skips running, active, reverting, compacting, and remote-manifest Sessions", () =>
    Effect.gen(function* () {
      const retention = yield* pruning
      const session = yield* Session.Service
      const events = yield* EventRuntime.Service
      const { db } = yield* Database.Service
      const running = (yield* settledScenario()).sessionID
      yield* events.publish(SessionEvent.Execution.Started, { sessionID: running })
      const executing = (yield* settledScenario()).sessionID
      active.add(executing)
      const reverting = yield* settledScenario()
      yield* session.revert.stage({ sessionID: reverting.sessionID, messageID: reverting.finalStep })
      const compacting = (yield* settledScenario()).sessionID
      yield* db.run(
        sql`INSERT INTO session_compaction_job (id, session_id, trigger, requested_through_message_id, requested_through_seq, base_context_revision, target_max_input_tokens, config_digest, status, attempts, time_created)
          VALUES (${SessionCompaction.ID.create()}, ${compacting}, 'manual', ${"msg_x"}, 1, 0, 1000, ${"0".repeat(64)}, 'pending', 0, 0)`,
      )
      const remote = yield* settledScenario()
      yield* compaction(remote.sessionID, { boundary: remote.finalStep, status: "ended", remote: true })
      const ids = [running, executing, reverting.sessionID, compacting, remote.sessionID]
      const before = yield* Effect.forEach(ids, eventTypes)
      yield* TestClock.adjust(Duration.millis(idle))
      expect(yield* retention.pruneHistory()).toEqual({ messages: 0, events: 0, images: 0 })
      expect(yield* Effect.forEach(ids, eventTypes)).toEqual(before)

      active.delete(executing)
      expect((yield* retention.pruneHistory()).events).toBeGreaterThan(0)
      expect(yield* eventTypes(executing)).toEqual(settledRetainedTypes)
    }),
  )

  it.effect("keeps image tool results for 24 idle hours and then replaces them with placeholders", () =>
    Effect.gen(function* () {
      const retention = yield* pruning
      const fixture = yield* settledScenario({ image: true })
      const original = yield* toolPart(fixture.sessionID, fixture.toolStep)
      yield* TestClock.adjust(Duration.millis(grace))
      expect((yield* retention.prune(fixture.sessionID)).images).toBe(0)
      expect((yield* eventTypes(fixture.sessionID)).filter((type) => type === "session.tool.success.1")).toHaveLength(1)
      expect(yield* toolPart(fixture.sessionID, fixture.toolStep)).toEqual(original)

      active.add(fixture.sessionID)
      yield* TestClock.adjust(Duration.millis(idle))
      expect(yield* retention.prune(fixture.sessionID)).toEqual({ messages: 0, events: 0, images: 0 })
      expect(yield* toolPart(fixture.sessionID, fixture.toolStep)).toEqual(original)
      active.delete(fixture.sessionID)

      expect(yield* retention.prune(fixture.sessionID)).toEqual({ messages: 0, events: 1, images: 1 })
      const replaced = yield* toolPart(fixture.sessionID, fixture.toolStep)
      expect(replaced.content).toEqual([
        { type: "text", text: "captured" },
        { type: "text", text: "[Image removed from stored history: image/png, 2.9 KiB]" },
      ])
      expect(replaced.structured).toEqual({
        type: "result",
        image: "[80000 bytes of base64 data omitted]",
        width: 4,
        height: 3,
      })
      expect(replaced.input).toEqual(original.input)
      expect(yield* eventTypes(fixture.sessionID)).toEqual(settledRetainedTypes)
      expect(yield* retention.prune(fixture.sessionID)).toEqual({ messages: 0, events: 0, images: 0 })
    }),
  )

  it.effect("replaces inherited images after the fork's own execution has been idle for 24 hours", () =>
    Effect.gen(function* () {
      const retention = yield* pruning
      const session = yield* Session.Service
      const events = yield* EventRuntime.Service
      const fixture = yield* settledScenario({ image: true })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID: fixture.sessionID,
        assistantMessageID: fixture.toolStep,
        callID: "metadata",
        name: "read",
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID: fixture.sessionID,
        assistantMessageID: fixture.toolStep,
        callID: "metadata",
        input: {},
        executed: true,
      })
      yield* events.publish(SessionEvent.Tool.Success, {
        sessionID: fixture.sessionID,
        assistantMessageID: fixture.toolStep,
        callID: "metadata",
        executed: true,
        structured: { text: screenshot },
        content: [],
      })
      const original = yield* toolPart(fixture.sessionID, fixture.toolStep)
      const child = yield* session.fork({ sessionID: fixture.sessionID, messageID: fixture.finalStep })
      const inherited = (yield* messageRows(child.id)).find((row) => row.type === "assistant")!
      const inheritedID = SessionMessage.ID.make(inherited.id)
      expect(yield* toolPart(child.id, inheritedID)).toEqual(original)
      expect(yield* eventTypes(child.id)).not.toContain("session.tool.success.1")
      yield* TestClock.adjust(Duration.millis(idle))
      expect((yield* retention.prune(child.id)).images).toBe(0)
      yield* run(child.id, "Child answer")
      yield* TestClock.adjust(Duration.millis(idle - 1))
      expect((yield* retention.prune(child.id)).images).toBe(0)
      expect(yield* toolPart(child.id, inheritedID)).toEqual(original)
      yield* TestClock.adjust(Duration.millis(1))
      expect((yield* retention.prune(child.id)).images).toBe(1)
      const replaced = yield* toolPart(child.id, inheritedID)
      expect(replaced.content).toEqual([
        { type: "text", text: "captured" },
        { type: "text", text: "[Image removed from stored history: image/png, 2.9 KiB]" },
      ])
      expect(replaced.input).toEqual(original.input)
      expect((yield* messageRows(child.id)).find((row) => row.id === inherited.id)?.data).toContain(screenshot)
      expect(yield* toolPart(fixture.sessionID, fixture.toolStep)).toEqual(original)
      expect(yield* retention.prune(child.id)).toEqual({ messages: 0, events: 0, images: 0 })
    }),
  )

  it.effect("deletes in batches of at most 100 events, re-checks each batch, and resumes after interruption", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const fixture = yield* settledScenario({ retries: 1_200 })
      yield* TestClock.adjust(Duration.millis(grace))
      let checks = 0
      const interrupted = SessionHistoryPruning.make(
        db,
        Effect.sync(() => (checks++ >= 2 ? new Set([fixture.sessionID]) : new Set<Session.ID>())),
      )
      const before = (yield* eventTypes(fixture.sessionID)).length
      expect((yield* interrupted.prune(fixture.sessionID)).events).toBe(100)
      expect(yield* eventTypes(fixture.sessionID)).toHaveLength(before - 100)

      const retention = yield* pruning
      const resumed = yield* retention.prune(fixture.sessionID)
      expect(resumed.events).toBe(before - 100 - settledRetainedTypes.length)
      expect(yield* eventTypes(fixture.sessionID)).toEqual(settledRetainedTypes)
      expect(yield* retention.prune(fixture.sessionID)).toEqual({ messages: 0, events: 0, images: 0 })
    }),
  )

  it.effect("bounds each delete batch by row bytes, always taking at least one row", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const events = yield* EventRuntime.Service
      const { db } = yield* Database.Service
      const sessionID = (yield* session.create({ location, model: ref })).id
      yield* events.publish(SessionEvent.Execution.Started, { sessionID })
      for (const text of ["a", "b", "c"].map((letter) => letter.repeat(1_500_000)))
        yield* events.publish(SessionEvent.Synthetic, { sessionID, text })
      yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID })
      yield* TestClock.adjust(Duration.millis(grace))
      let checks = 0
      const interrupted = SessionHistoryPruning.make(
        db,
        Effect.sync(() => (checks++ >= 2 ? new Set([sessionID]) : new Set<Session.ID>())),
      )
      expect((yield* interrupted.prune(sessionID)).events).toBe(1)
      expect((yield* eventTypes(sessionID)).filter((type) => type === "session.synthetic.1")).toHaveLength(2)
      const retention = yield* pruning
      expect((yield* retention.prune(sessionID)).events).toBe(2)
      expect((yield* eventTypes(sessionID)).filter((type) => type === "session.synthetic.1")).toEqual([])
    }),
  )

  it.effect("deletes stored legacy tool progress up to the newest terminal event even in a skipped Session", () =>
    Effect.gen(function* () {
      const retention = yield* pruning
      const session = yield* Session.Service
      const events = yield* EventRuntime.Service
      const { db } = yield* Database.Service
      const sessionID = (yield* session.create({ location, model: ref })).id
      const storedProgress = Effect.gen(function* () {
        const next =
          (yield* db
            .get<{ seq: number }>(sql`SELECT seq FROM event_sequence WHERE aggregate_id = ${sessionID}`)
            .pipe(Effect.orDie))!.seq + 1
        yield* db.run(
          sql`INSERT INTO event (id, aggregate_id, seq, created, type, data)
            VALUES (${`evt_stored_progress_${next}`}, ${sessionID}, ${next}, 0, 'session.tool.progress.1',
              ${JSON.stringify({ sessionID, assistantMessageID: "msg_x", callID: "call", structured: {}, content: [] })})`,
        )
        yield* db.run(sql`UPDATE event_sequence SET seq = ${next} WHERE aggregate_id = ${sessionID}`)
        return next
      }).pipe(Effect.orDie)
      yield* events.publish(SessionEvent.Execution.Started, { sessionID })
      const settled = yield* storedProgress
      yield* events.publish(SessionEvent.Synthetic, { sessionID, text: "Settled note" })
      yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID })
      yield* events.publish(SessionEvent.Execution.Started, { sessionID })
      const running = yield* storedProgress
      active.add(sessionID)
      const progress = () =>
        db
          .all<{
            seq: number
          }>(
            sql`SELECT seq FROM event WHERE aggregate_id = ${sessionID} AND type = 'session.tool.progress.1' ORDER BY seq`,
          )
          .pipe(Effect.orDie)
      expect((yield* progress()).map((row) => row.seq)).toEqual([settled, running])

      expect(yield* retention.prune(sessionID)).toEqual({ messages: 0, events: 1, images: 0 })
      expect((yield* progress()).map((row) => row.seq)).toEqual([running])
      expect(yield* eventTypes(sessionID)).toContain("session.synthetic.1")
      active.delete(sessionID)
    }),
  )

  it.effect("refuses to delete anything when the backup is unavailable", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const fixture = yield* settledScenario({ image: true })
      yield* TestClock.adjust(Duration.millis(idle))
      const refused = SessionHistoryPruning.make(db, Effect.succeed(new Set()), Effect.succeed(false))
      const before = { events: yield* eventTypes(fixture.sessionID), rows: yield* messageRows(fixture.sessionID) }
      const error = yield* refused.prune(fixture.sessionID).pipe(Effect.flip)
      expect(error._tag).toBe("SessionHistoryPruning.BackupUnavailableError")
      expect(yield* refused.sweep()).toEqual({ messages: 0, events: 0, images: 0 })
      expect({ events: yield* eventTypes(fixture.sessionID), rows: yield* messageRows(fixture.sessionID) }).toEqual(
        before,
      )
    }),
  )
})
