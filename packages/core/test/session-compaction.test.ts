import { expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMRequest } from "@ycoding-ai/ai"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { OpenAIChat } from "@ycoding-ai/ai/protocols"
import { Config } from "@ycoding-ai/core/config"
import { ConfigCompaction } from "@ycoding-ai/core/config/compaction"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { llmClient } from "@ycoding-ai/core/effect/app-node-platform"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { EventSequenceTable, EventTable } from "@ycoding-ai/core/event/sql"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import type { LocationServices } from "@ycoding-ai/core/location-services"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionCompaction } from "@ycoding-ai/core/session/compaction"
import { SessionCompactionJob } from "@ycoding-ai/core/session/compaction-job"
import { ContextManifest } from "@ycoding-ai/core/session/context-manifest"
import { SessionContextState } from "@ycoding-ai/core/session/context-state"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionHelperPolicy, localGoal, localTitle } from "@ycoding-ai/core/session/helper-policy"
import { SessionHistory } from "@ycoding-ai/core/session/history"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionProviderRequest } from "@ycoding-ai/core/session/provider-request"
import { SessionCacheRuntime } from "@ycoding-ai/core/session/runner/cache-runtime"
import { SessionRunnerCache } from "@ycoding-ai/core/session/runner/cache"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionSummaryToon } from "@ycoding-ai/core/session/summary-toon"
import { SessionMessageTable, SessionProviderRequestTable, SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { Token } from "@ycoding-ai/core/util/token"
import { ID } from "@ycoding-ai/schema/session-compaction"
import { DateTime, Effect, Layer, LayerMap, Schema, Stream } from "effect"
import { asc, eq, inArray } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const model = Model.make({
  id: "manifest-model",
  provider: "test",
  route: OpenAIChat.route.with({ limits: { context: 10_000, output: 1_000 } }),
})

let requests: LLMRequest[] = []
let responseForRequest: ((request: LLMRequest) => string) | undefined
let beforeResponse = Effect.void

const client = Layer.mock(LLMClient.Service)({
  prepare: () => Effect.die("unused"),
  stream: (request) => {
    requests.push(request)
    const text = responseForRequest?.(request)
    if (text === undefined) return Stream.make(LLMEvent.providerError({ message: "Missing manifest response" }))
    return Stream.unwrap(beforeResponse.pipe(Effect.as(Stream.make(LLMEvent.textDelta({ id: "manifest", text })))))
  },
  generate: () => Effect.die("unused"),
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
const unavailableHelpers = Layer.succeed(
  SessionHelperPolicy.Service,
  SessionHelperPolicy.Service.of({
    settings: { titleMode: "local", goalMode: "local", models: {}, compactionScopes: {} },
    localTitle,
    localGoal,
    resolveModel: () => Effect.succeed(undefined),
  }),
)
const guardrailSnapshots = new Map<SessionSchema.ID, SessionGuardrail.Snapshot>()
const guardrails = Layer.mock(SessionGuardrail.Service, {
  withSnapshot: (sessionID, use) =>
    use(guardrailSnapshots.get(sessionID) ?? { sequence: 0, digest: ContextManifest.payloadDigest(null) }),
})
const contextLocations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    () =>
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      guardrails as unknown as Layer.Layer<LocationServices>,
  ),
)

const configLayer = (compaction: ConfigCompaction.Info) =>
  Layer.mock(Config.Service)({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({ compaction }),
        }),
      ]),
  })

const testWithConfig = (
  compaction = new ConfigCompaction.Info({ keep_recent_messages: 1 }),
  helperPolicy = helpers,
) =>
  testEffect(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        EventV2.node,
        SessionStore.node,
        SessionProviderRequest.node,
        SessionHelperPolicy.node,
        SessionCompaction.node,
        SessionContextState.node,
      ]),
      [
        [llmClient, client],
        [Config.node, configLayer(compaction)],
        [SessionCacheRuntime.node, cacheRuntime],
        [SessionRunnerModel.node, models],
        [SessionHelperPolicy.node, helperPolicy],
        [LocationServiceMap.node, contextLocations],
      ],
    ),
  )

const it = testWithConfig()
const itWithTwoPasses = testWithConfig(new ConfigCompaction.Info({ keep_recent_messages: 1, max_internal_passes: 2 }))
const itWithTinyManifest = testWithConfig(
  new ConfigCompaction.Info({ keep_recent_messages: 1, max_manifest_bytes: 1, max_internal_passes: 1 }),
)
const itWithoutHelper = testWithConfig(new ConfigCompaction.Info({ keep_recent_messages: 1 }), unavailableHelpers)

const decodeJSON = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)

const promptText = (request: LLMRequest) =>
  request.messages
    .flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))
    .join("\n")

const insertMessage = Effect.fnUntraced(function* (
  sessionID: SessionSchema.ID,
  id: SessionMessage.ID,
  seq: number,
  text: string,
  created = 1,
) {
  const encoded = Schema.encodeSync(SessionMessage.Info)(
    SessionMessage.User.make({
      id,
      type: "user",
      text,
      time: { created: DateTime.toUtc(DateTime.makeUnsafe(created)) },
    }),
  )
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
      type: EventV2.versionedType(SessionEvent.InputPromoted.type, SessionEvent.InputPromoted.durable.version),
      data: { sessionID, inputID: id },
    })
    .run()
    .pipe(Effect.orDie)
})

const seedSession = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, sequence: number) {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "Manifest test" })
    .run()
    .pipe(Effect.orDie)
  yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: sequence }).run().pipe(Effect.orDie)
})

function manifestJob(
  sessionID: SessionSchema.ID,
  boundary: SessionCompactionJob.Job["requestedThrough"],
  targetMaxInputTokens = 4_096,
  mode: Pick<SessionCompactionJob.Job, "trigger" | "admissionMode"> = {
    trigger: "manual",
    admissionMode: "background",
  },
): SessionCompactionJob.Job {
  return {
    id: ID.make(`cmp_manifest_${sessionID}`),
    sessionID,
    ...mode,
    requestedThrough: boundary,
    baseContextRevision: 0,
    targetMaxInputTokens,
    configDigest: "a".repeat(64),
    status: "running",
    attempts: 1,
    timeCreated: 0,
  }
}

const generateManifest = Effect.fnUntraced(function* (job: SessionCompactionJob.Job) {
  const compaction = yield* SessionCompaction.Service
  return yield* compaction.manifest(job)
})

const reset = () => {
  requests = []
  responseForRequest = undefined
  beforeResponse = Effect.void
  guardrailSnapshots.clear()
}

function checkpoint(through: number, currentState = "Continue from the compacted conversation") {
  return SessionSummaryToon.encode({
    version: 1,
    through_sequence: through,
    objective: "Continue the current session",
    current_state: currentState,
    facts: [],
    decisions: [],
    preferences: [],
    constraints: [],
    completed: [],
    pending: [],
    blockers: [],
    unresolved: [],
    important_identifiers: [],
    continuation: "Use the checkpoint and retained messages",
  })
}

const validateGeneratedManifest = Effect.fnUntraced(function* (
  sessionID: SessionSchema.ID,
  manifest: ContextManifest.Manifest,
  recentTailCount: number,
) {
  const rows = yield* (yield* Database.Service).db
    .select({
      id: SessionMessageTable.id,
      seq: SessionMessageTable.seq,
      type: SessionMessageTable.type,
      data: SessionMessageTable.data,
    })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, sessionID))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const items = rows.flatMap((row, position): ReadonlyArray<ContextManifest.ContextItem> => {
    if (!Schema.is(Schema.Json)(row.data)) return []
    return [
      {
        kind: "message",
        messageID: row.id,
        position,
        terminalSeq: EventV2.Seq.make(row.seq),
        inputKind: row.type,
        payload: row.data,
        tokens: Token.estimate(JSON.stringify(row.data)),
      },
    ]
  })
  return ContextManifest.validate({
    candidate: ContextManifest.decodeCandidate(
      JSON.stringify({
        schemaVersion: manifest.schemaVersion,
        baseContextRevision: manifest.baseContextRevision,
        coveredThrough: manifest.coveredThrough,
        protectedState: manifest.protectedState,
        exclusions: [],
      }),
    ),
    summary: manifest.summary,
    evidence: {
      baseContextRevision: manifest.baseContextRevision,
      coveredThrough: manifest.coveredThrough,
      items,
      settlements: [],
      authorities: [],
      resourceAuthorities: [],
      toolResults: [],
      recentTail: recentTailCount === 0 ? [] : items.slice(-recentTailCount).map(ContextManifest.selector),
      protectedTargets: [],
      providerLinks: [],
      protectedState: manifest.protectedState,
    },
  })
})

function expectStrictFrozenSummary(manifest: ContextManifest.Manifest) {
  expect(Object.isFrozen(manifest)).toBe(true)
  expect(manifest.summary).toBeDefined()
  expect(Object.isFrozen(manifest.summary)).toBe(true)
  const summary = manifest.summary!
  const parsed = SessionSummaryToon.parse(summary.text, {
    throughSequence: summary.coveredThrough.seq,
    maxSummaryBytes: Buffer.byteLength(summary.text, "utf8"),
  })
  expect("_tag" in parsed).toBe(false)
  if ("_tag" in parsed) throw parsed
  expect(SessionSummaryToon.encode(parsed)).toBe(summary.text)
}

function selectedTokens(messages: ReadonlyArray<SessionMessage.Info>) {
  const encode = Schema.encodeSync(SessionMessage.Info)
  return Token.estimate(JSON.stringify(messages.map((message) => encode(message))))
}

function retainManifestGuardrail(sessionID: SessionSchema.ID, manifest: ContextManifest.Manifest) {
  const guardrail = manifest.protectedState.find((entry) => entry.source === "guardrails")!
  guardrailSnapshots.set(sessionID, { sequence: guardrail.revision, digest: guardrail.digest })
}

it.effect("exposes one required manifest worker and no obsolete summarization members", () =>
  Effect.gen(function* () {
    expect(Object.keys(yield* SessionCompaction.Service)).toEqual(["manifest"])
  }),
)

it.effect("uses bounded checkpoint TOON requests without asking the model to author manifest JSON", () =>
  Effect.gen(function* () {
    reset()
    const sessionID = SessionSchema.ID.make("ses_manifest_batches")
    const messageIDs = Array.from({ length: 6 }, (_, index) => SessionMessage.ID.make(`msg_manifest_batch_${index}`))
    yield* seedSession(sessionID, messageIDs.length)
    yield* Effect.forEach(
      messageIDs,
      (id, index) => insertMessage(sessionID, id, index + 1, `unique checkpoint material ${index} `.repeat(120)),
      { discard: true },
    )
    responseForRequest = (request) => {
      const match = promptText(request).match(/up to and including (\d+)/)
      return checkpoint(Number(match?.[1]), "Model-authored checkpoint")
    }
    const budget = 4_096

    const manifest = yield* generateManifest(
      manifestJob(sessionID, { messageID: messageIDs.at(-1)!, seq: messageIDs.length }, budget),
    )

    expect(requests.length).toBeGreaterThan(1)
    expect(
      requests.every(
        (request) =>
          request.providerOptions?.openai?.promptCacheKey ===
          SessionRunnerCache.promptCacheNamespace({
            scope: "compaction",
            projectID: Project.ID.global,
            directory: "/project",
            providerID: model.provider,
            modelID: model.id,
            variant: "default",
            policyRevision: CACHE_POLICY_REVISION,
            permissions: [],
            system: request.system,
            tools: request.tools,
          }),
      ),
    ).toBe(true)
    expect(requests.every((request) => Token.estimate(promptText(request)) <= budget)).toBe(true)
    expect(requests.every((request) => promptText(request).includes("conversation_memory"))).toBe(true)
    expect(requests.some((request) => promptText(request).includes("strict JSON ContextManifest"))).toBe(false)
    expect(manifest.exclusions).toEqual([])
    expectStrictFrozenSummary(manifest)
    expect(manifest.retainedTokens).toBeLessThan(manifest.inputTokens)
  }),
)

itWithTwoPasses.effect("falls back to a local canonical checkpoint for malformed helper JSON and TOON", () =>
  Effect.gen(function* () {
    reset()
    const sessionID = SessionSchema.ID.make("ses_manifest_repair")
    const firstID = SessionMessage.ID.make("msg_manifest_repair_first")
    const boundaryID = SessionMessage.ID.make("msg_manifest_repair_boundary")
    yield* seedSession(sessionID, 2)
    yield* insertMessage(sessionID, firstID, 1, "first malformed fallback source ".repeat(200))
    yield* insertMessage(sessionID, boundaryID, 2, "retained boundary")
    responseForRequest = () => '{"schemaVersion":1}'

    const manifest = yield* generateManifest(manifestJob(sessionID, { messageID: boundaryID, seq: 2 }))

    expect(requests).toHaveLength(1)
    expectStrictFrozenSummary(manifest)
    expect((yield* validateGeneratedManifest(sessionID, manifest, 1)).valid).toBe(true)
  }),
)

it.effect("falls back to a local canonical checkpoint when the helper provider fails", () =>
  Effect.gen(function* () {
    reset()
    const sessionID = SessionSchema.ID.make("ses_manifest_provider_failure")
    const firstID = SessionMessage.ID.make("msg_manifest_provider_failure_first")
    const boundaryID = SessionMessage.ID.make("msg_manifest_provider_failure_boundary")
    yield* seedSession(sessionID, 2)
    yield* insertMessage(sessionID, firstID, 1, "provider fallback source ".repeat(200))
    yield* insertMessage(sessionID, boundaryID, 2, "retained boundary")

    const manifest = yield* generateManifest(manifestJob(sessionID, { messageID: boundaryID, seq: 2 }))

    expect(requests).toHaveLength(1)
    expectStrictFrozenSummary(manifest)
    expect((yield* validateGeneratedManifest(sessionID, manifest, 1)).valid).toBe(true)
  }),
)

itWithoutHelper.effect("uses a local canonical checkpoint without provider traffic when no helper model resolves", () =>
  Effect.gen(function* () {
    reset()
    const sessionID = SessionSchema.ID.make("ses_manifest_no_helper")
    const firstID = SessionMessage.ID.make("msg_manifest_no_helper_first")
    const boundaryID = SessionMessage.ID.make("msg_manifest_no_helper_boundary")
    yield* seedSession(sessionID, 2)
    yield* insertMessage(sessionID, firstID, 1, "local checkpoint source ".repeat(200))
    yield* insertMessage(sessionID, boundaryID, 2, "retained boundary")

    const manifest = yield* generateManifest(manifestJob(sessionID, { messageID: boundaryID, seq: 2 }, 2_048))
    const providerRows = yield* (yield* Database.Service).db
      .select()
      .from(SessionProviderRequestTable)
      .where(eq(SessionProviderRequestTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)

    expect(requests).toEqual([])
    expect(providerRows).toEqual([])
    expectStrictFrozenSummary(manifest)
    expect(manifest.retainedTokens).toBeLessThan(manifest.inputTokens)
  }),
)

it.effect("falls back to a validated rolling summary for unique history while retaining the recent tail", () =>
  Effect.gen(function* () {
    reset()
    const sessionID = SessionSchema.ID.make("ses_manifest_no_reduction")
    const firstID = SessionMessage.ID.make("msg_manifest_no_reduction_first")
    const boundaryID = SessionMessage.ID.make("msg_manifest_no_reduction_boundary")
    yield* seedSession(sessionID, 2)
    yield* insertMessage(sessionID, firstID, 1, "first unique message ".repeat(200))
    yield* insertMessage(sessionID, boundaryID, 2, "second unique message")
    const summary = SessionSummaryToon.encode({
      version: 1,
      through_sequence: 1,
      objective: "Preserve the first unique request",
      current_state: "The earlier request is recorded",
      facts: [],
      decisions: [],
      preferences: [],
      constraints: [],
      completed: [],
      pending: [],
      blockers: [],
      unresolved: [],
      important_identifiers: [],
      continuation: "Continue with the retained recent message",
    })
    responseForRequest = () => summary

    const manifest = yield* generateManifest(manifestJob(sessionID, { messageID: boundaryID, seq: 2 }))

    expect(decodeJSON(ContextManifest.manifestJSON(manifest))).toMatchObject({
      summary: {
        text: summary,
        coveredThrough: { messageID: firstID, seq: 1 },
      },
    })
    expect(manifest.exclusions.some((exclusion) => exclusion.target.messageID === boundaryID)).toBe(false)
    expect(requests.every((request) => promptText(request).includes("conversation_memory"))).toBe(true)
    expect(requests.some((request) => promptText(request).includes("strict JSON ContextManifest"))).toBe(false)
    expect(manifest.retainedTokens).toBeLessThan(manifest.inputTokens)
  }),
)

itWithTinyManifest.effect("falls back to the minimal local checkpoint when helper output exceeds max_manifest_bytes", () =>
  Effect.gen(function* () {
    reset()
    const sessionID = SessionSchema.ID.make("ses_manifest_oversized")
    const firstID = SessionMessage.ID.make("msg_manifest_oversized_first")
    const boundaryID = SessionMessage.ID.make("msg_manifest_oversized_boundary")
    yield* seedSession(sessionID, 2)
    yield* insertMessage(sessionID, firstID, 1, "oversized fallback source ".repeat(300))
    yield* insertMessage(sessionID, boundaryID, 2, "retained boundary")
    responseForRequest = () => checkpoint(1, "x".repeat(2_000))

    const manifest = yield* generateManifest(manifestJob(sessionID, { messageID: boundaryID, seq: 2 }))

    expect(requests).toHaveLength(1)
    expectStrictFrozenSummary(manifest)
    expect((yield* validateGeneratedManifest(sessionID, manifest, 1)).valid).toBe(true)
  }),
)

const itMandatory = testWithConfig(new ConfigCompaction.Info({ keep_recent_messages: 0 }))

itMandatory.effect("allows mandatory compaction to checkpoint through the full job boundary", () =>
  Effect.gen(function* () {
    reset()
    const sessionID = SessionSchema.ID.make("ses_manifest_full_boundary")
    const firstID = SessionMessage.ID.make("msg_manifest_full_boundary_first")
    const boundaryID = SessionMessage.ID.make("msg_manifest_full_boundary_boundary")
    yield* seedSession(sessionID, 2)
    yield* insertMessage(sessionID, firstID, 1, "mandatory earlier source ".repeat(200))
    yield* insertMessage(sessionID, boundaryID, 2, "mandatory job boundary ".repeat(200))
    responseForRequest = () => checkpoint(2, "The mandatory boundary is covered")

    const manifest = yield* generateManifest(
      manifestJob(sessionID, { messageID: boundaryID, seq: 2 }, 4_096, {
        trigger: "mandatory",
        admissionMode: "mandatory",
      }),
    )

    expect(manifest.summary?.coveredThrough.seq).toBe(manifest.coveredThrough.seq)
    expect(manifest.retainedTokens).toBeLessThan(manifest.inputTokens)
    expectStrictFrozenSummary(manifest)
    expect((yield* validateGeneratedManifest(sessionID, manifest, 0)).valid).toBe(true)
  }),
)

itMandatory.effect("requires sequential compaction to reduce the current model-visible checkpoint history", () =>
  Effect.gen(function* () {
    reset()
    const db = (yield* Database.Service).db
    const context = yield* SessionContextState.Service
    const sessionID = SessionSchema.ID.make("ses_manifest_sequential_reduction")
    const firstID = SessionMessage.ID.make("msg_manifest_sequential_first")
    const laterID = SessionMessage.ID.make("msg_manifest_sequential_later")
    const boundaryID = SessionMessage.ID.make("msg_manifest_sequential_boundary")
    yield* seedSession(sessionID, 1)
    yield* SessionContextState.initialize(db, sessionID, 0)
    yield* insertMessage(sessionID, firstID, 1, "large canonical first context ".repeat(400))
    responseForRequest = () => checkpoint(1, "Small first checkpoint")

    const first = yield* generateManifest(
      manifestJob(sessionID, { messageID: firstID, seq: 1 }, 4_096, {
        trigger: "mandatory",
        admissionMode: "mandatory",
      }),
    )
    retainManifestGuardrail(sessionID, first)
    yield* context.activate({ sessionID, manifest: first })

    yield* insertMessage(sessionID, laterID, 10, "later material remains useful ".repeat(35))
    yield* insertMessage(sessionID, boundaryID, 11, "second boundary material ".repeat(35))
    yield* db
      .update(EventSequenceTable)
      .set({ seq: 11 })
      .where(eq(EventSequenceTable.aggregate_id, sessionID))
      .run()
      .pipe(Effect.orDie)
    const before = yield* SessionHistory.forModel(db, sessionID)
    const beforeTokens = selectedTokens(before)
    responseForRequest = () => checkpoint(11, "helper checkpoint growth ".repeat(260))

    const second = yield* generateManifest({
      ...manifestJob(sessionID, { messageID: boundaryID, seq: 11 }, 4_096, {
        trigger: "mandatory",
        admissionMode: "mandatory",
      }),
      baseContextRevision: 1,
    })
    retainManifestGuardrail(sessionID, second)
    yield* context.activate({ sessionID, manifest: second })
    const after = yield* SessionHistory.forModel(db, sessionID)
    const afterTokens = selectedTokens(after)

    expect(afterTokens).toBeLessThan(beforeTokens)
    expect(second.inputTokens).toBe(beforeTokens)
    expect(second.retainedTokens).toBe(afterTokens)
  }),
)

it.effect("rejects the combined candidate when protected state changes during generation", () =>
  Effect.gen(function* () {
    reset()
    const sessionID = SessionSchema.ID.make("ses_manifest_protected_change")
    const firstID = SessionMessage.ID.make("msg_manifest_protected_change_first")
    const boundaryID = SessionMessage.ID.make("msg_manifest_protected_change_boundary")
    yield* seedSession(sessionID, 2)
    yield* insertMessage(sessionID, firstID, 1, "immutable compacted source ".repeat(200))
    yield* insertMessage(sessionID, boundaryID, 2, "retained boundary")
    responseForRequest = () => checkpoint(1)
    beforeResponse = (yield* Database.Service).db
      .update(SessionTable)
      .set({ autonomy_revision: 1 })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie, Effect.asVoid)

    const error = yield* generateManifest(manifestJob(sessionID, { messageID: boundaryID, seq: 2 })).pipe(Effect.flip)

    expect(error.code).toBe("protected_state_changed")
    expect(requests).toHaveLength(1)
  }),
)

it.effect("leaves canonical message and source-event rows immutable", () =>
  Effect.gen(function* () {
    reset()
    const db = (yield* Database.Service).db
    const sessionID = SessionSchema.ID.make("ses_manifest_immutable")
    const firstID = SessionMessage.ID.make("msg_manifest_immutable_first")
    const boundaryID = SessionMessage.ID.make("msg_manifest_immutable_boundary")
    const eventIDs = [EventV2.ID.make(`evt_${sessionID}_1`), EventV2.ID.make(`evt_${sessionID}_2`)]
    yield* seedSession(sessionID, 2)
    yield* insertMessage(sessionID, firstID, 1, "immutable compacted source ".repeat(200))
    yield* insertMessage(sessionID, boundaryID, 2, "retained boundary")
    const beforeMessages = yield* db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)
    const beforeEvents = yield* db
      .select()
      .from(EventTable)
      .where(inArray(EventTable.id, eventIDs))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    responseForRequest = () => checkpoint(1)

    yield* generateManifest(manifestJob(sessionID, { messageID: boundaryID, seq: 2 }))

    expect(
      yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie),
    ).toEqual(beforeMessages)
    expect(
      yield* db
        .select()
        .from(EventTable)
        .where(inArray(EventTable.id, eventIDs))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie),
    ).toEqual(beforeEvents)
  }),
)
