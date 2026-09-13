import { expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMRequest } from "@ycoding-ai/ai"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { OpenAIChat } from "@ycoding-ai/ai/protocols"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { ConfigCompaction } from "@ycoding-ai/core/config/compaction"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { llmClient } from "@ycoding-ai/core/effect/app-node-platform"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { EventSequenceTable, EventTable } from "@ycoding-ai/core/event/sql"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import type { LocationServices } from "@ycoding-ai/core/location-services"
import { ModelV2 } from "@ycoding-ai/core/model"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionCompaction } from "@ycoding-ai/core/session/compaction"
import { SessionCompactionExecution } from "@ycoding-ai/core/session/compaction-execution"
import { SessionCompactionJob } from "@ycoding-ai/core/session/compaction-job"
import { ContextManifest } from "@ycoding-ai/core/session/context-manifest"
import { SessionContextState } from "@ycoding-ai/core/session/context-state"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionHelperPolicy, localGoal, localTitle } from "@ycoding-ai/core/session/helper-policy"
import { SessionHistory } from "@ycoding-ai/core/session/history"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionProviderRequest } from "@ycoding-ai/core/session/provider-request"
import { SessionCacheRuntime } from "@ycoding-ai/core/session/runner/cache-runtime"
import { SessionRunnerCache } from "@ycoding-ai/core/session/runner/cache"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionSummaryToon } from "@ycoding-ai/core/session/summary-toon"
import {
  SessionMessageTable,
  SessionProviderRequestTable,
  SessionTable,
  SessionTaskTable,
} from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SkillV2 } from "@ycoding-ai/core/skill"
import { Token } from "@ycoding-ai/core/util/token"
import { ID } from "@ycoding-ai/schema/session-compaction"
import { DateTime, Effect, Fiber, Layer, LayerMap, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { and, asc, eq, inArray } from "drizzle-orm"
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
    generation: () => Effect.succeed(0),
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
const projects = Layer.mock(Project.Service, {
  resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
})

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

const testWithConfig = (compaction = new ConfigCompaction.Info({ keep_recent_messages: 1 }), helperPolicy = helpers) =>
  testEffect(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        EventV2.node,
        SessionProjector.node,
        SessionStore.node,
        SessionProviderRequest.node,
        SessionHelperPolicy.node,
        SessionCompaction.node,
        SessionCompactionExecution.node,
        SessionCompactionJob.node,
        SessionContextState.node,
      ]),
      [
        [llmClient, client],
        [Config.node, configLayer(compaction)],
        [SessionCacheRuntime.node, cacheRuntime],
        [SessionRunnerModel.node, models],
        [SessionHelperPolicy.node, helperPolicy],
        [Project.node, projects],
        [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
        [LocationServiceMap.node, contextLocations],
      ],
    ),
  )

const it = testWithConfig()
const itWithTwoPasses = testWithConfig(new ConfigCompaction.Info({ keep_recent_messages: 1, max_internal_passes: 2 }))
const itWithTinyManifest = testWithConfig(
  new ConfigCompaction.Info({ keep_recent_messages: 1, max_manifest_bytes: 1, max_internal_passes: 1 }),
)
const itWithBoundedManifest = testWithConfig(
  new ConfigCompaction.Info({ keep_recent_messages: 0, max_manifest_bytes: 4_096, max_internal_passes: 1 }),
)
const itWithTotalTimeout = testWithConfig(
  new ConfigCompaction.Info({ keep_recent_messages: 1, timeout_seconds: 60, max_internal_passes: 8 }),
)
const itWithTargetEnforcement = testWithConfig(
  new ConfigCompaction.Info({ keep_recent_messages: 0, max_internal_passes: 8 }),
)
const itWithoutHelper = testWithConfig(new ConfigCompaction.Info({ keep_recent_messages: 1 }), unavailableHelpers)
const itWithoutHelperMandatory = testWithConfig(
  new ConfigCompaction.Info({ keep_recent_messages: 0 }),
  unavailableHelpers,
)
const itWithOnePass = testWithConfig(new ConfigCompaction.Info({ keep_recent_messages: 0, max_internal_passes: 1 }))
const itWithHollowLimit = testWithConfig(
  new ConfigCompaction.Info({ keep_recent_messages: 0, max_manifest_bytes: 1_024, max_internal_passes: 1 }),
)

const decodeJSON = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)

const promptText = (request: LLMRequest) =>
  request.messages
    .flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))
    .join("\n")

const systemText = (request: LLMRequest) => request.system.map((part) => part.text).join("\n")

const helperInputText = (request: LLMRequest) => [systemText(request), promptText(request)].join("\n\n")

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

const insertAssistant = Effect.fnUntraced(function* (
  sessionID: SessionSchema.ID,
  id: SessionMessage.ID,
  seq: number,
  text: string,
) {
  const time = DateTime.makeUnsafe(seq)
  const encoded = Schema.encodeSync(SessionMessage.Info)(
    SessionMessage.Assistant.make({
      id,
      type: "assistant",
      agent: AgentV2.defaultID,
      model: ModelV2.Ref.make({ id: ModelV2.ID.make("manifest-model"), providerID: ProviderV2.ID.make("test") }),
      content: [SessionMessage.AssistantText.make({ type: "text", text })],
      finish: "stop",
      time: { created: time, completed: time },
    }),
  )
  const { id: encodedID, type, ...data } = encoded
  yield* (yield* Database.Service).db
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

const insertAssistantTool = Effect.fnUntraced(function* (
  sessionID: SessionSchema.ID,
  id: SessionMessage.ID,
  seq: number,
  text: string,
) {
  const time = DateTime.makeUnsafe(seq)
  const encoded = Schema.encodeSync(SessionMessage.Info)(
    SessionMessage.Assistant.make({
      id,
      type: "assistant",
      agent: AgentV2.defaultID,
      model: ModelV2.Ref.make({ id: ModelV2.ID.make("manifest-model"), providerID: ProviderV2.ID.make("test") }),
      content: [
        SessionMessage.AssistantText.make({ type: "text", text: "The evidence collection step completed." }),
        SessionMessage.AssistantTool.make({
          type: "tool",
          id: `call_${id}`,
          name: "inspect_artifact",
          state: SessionMessage.ToolStateCompleted.make({
            status: "completed",
            input: { path: "/workspace/report.json" },
            content: [
              { type: "text", text },
              { type: "file", uri: `data:image/png;base64,${"A".repeat(20_000)}`, mime: "image/png" },
            ],
            structured: { result: text, binary: `data:image/png;base64,${"B".repeat(20_000)}` },
          }),
          time: { created: time, completed: time },
        }),
      ],
      finish: "stop",
      time: { created: time, completed: time },
    }),
  )
  const { id: encodedID, type, ...data } = encoded
  yield* (yield* Database.Service).db
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

const insertSkill = Effect.fnUntraced(function* (
  sessionID: SessionSchema.ID,
  id: SessionMessage.ID,
  seq: number,
  text: string,
) {
  const encoded = Schema.encodeSync(SessionMessage.Info)(
    SessionMessage.Skill.make({
      id,
      type: "skill",
      skill: SkillV2.ID.make("semantic-state-skill"),
      name: SkillV2.Name.make("Semantic State Skill"),
      text,
      conflicts: { skills: [], instructions: [] },
      time: { created: DateTime.makeUnsafe(seq) },
    }),
  )
  const { id: encodedID, type, ...data } = encoded
  yield* (yield* Database.Service).db
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

const seedCoveragePressure = Effect.fnUntraced(function* (name: string) {
  const sessionID = SessionSchema.ID.make(`ses_manifest_coverage_pressure_${name}`)
  const messageIDs = Array.from({ length: 176 }, (_, index) =>
    SessionMessage.ID.make(`msg_manifest_coverage_pressure_${name}_${index}`),
  )
  yield* seedSession(sessionID, messageIDs.length)
  yield* Effect.forEach(
    messageIDs,
    (id, index) =>
      insertAssistant(
        sessionID,
        id,
        index + 1,
        [
          `Objective: recover ${name} pressure while preserving OBJECTIVE-${index}.`,
          "Requirement: helper failure must not stop compaction or the Session.",
          "Acceptance criteria: a canonical reducing TOON checkpoint is activated.",
          "Progress: deterministic local recovery remains in progress.",
          "Pending: continue the ordinary chat after compaction.",
          "Accepted decision: coalesce model-visible source provenance.",
          "Blocker: helper output and summary size are soft diagnostics.",
          Array.from({ length: 48 }, (_, word) => `${name}_${index}_unique_${word}`).join(" "),
        ].join(" "),
      ),
    { discard: true },
  )
  return {
    sessionID,
    boundary: { messageID: messageIDs.at(-1)!, seq: messageIDs.length },
  }
})

function expectBestEffortCoverage(manifest: ContextManifest.Manifest) {
  if (!manifest.summary) throw new Error("Expected best-effort checkpoint")
  const memory = SessionSummaryToon.parse(manifest.summary.text, {
    throughSequence: manifest.summary.coveredThrough.seq,
    maxSummaryBytes: Number.MAX_SAFE_INTEGER,
  })
  if ("_tag" in memory) throw memory
  expect(manifest.retainedTokens).toBeLessThan(manifest.inputTokens)
  expect(memory.objective).toContain("OBJECTIVE-")
  expect(memory.requirements).not.toHaveLength(0)
  expect(memory.acceptance_criteria).not.toHaveLength(0)
  expect(memory.in_progress).not.toHaveLength(0)
  expect(memory.pending).not.toHaveLength(0)
  expect(memory.decision).not.toHaveLength(0)
  expect(memory.blocked).not.toHaveLength(0)
}

function manifestJob(
  sessionID: SessionSchema.ID,
  boundary: SessionCompactionJob.Job["requestedThrough"],
  targetMaxInputTokens = 4_096,
  trigger: SessionCompactionJob.Job["trigger"] = "manual",
): SessionCompactionJob.Job {
  return {
    id: ID.make(`cmp_manifest_${sessionID}`),
    sessionID,
    trigger,
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
  return SessionSummaryToon.encode(checkpointMemory(through, currentState))
}

function checkpointMemory(through: number, currentState = "Continue from the compacted conversation") {
  return {
    version: 2,
    through_sequence: through,
    objective: "Continue the current session",
    in_progress: [],
    pending: [],
    blocked: [],
    decision: [],
    current_state: currentState,
    facts: [],
    preferences: [],
    constraints: [],
    completed: [],
    unresolved: [],
    important_identifiers: [],
    continuation: "Use the checkpoint and retained messages",
  } satisfies Parameters<typeof SessionSummaryToon.encode>[0]
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
      (id, index) => insertAssistant(sessionID, id, index + 1, `unique checkpoint material ${index} `.repeat(120)),
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
    expect(requests.every((request) => systemText(request).length > 0)).toBe(true)
    expect(new Set(requests.map(systemText)).size).toBe(1)
    expect(new Set(requests.map(promptText)).size).toBe(requests.length)
    expect(
      requests.every(
        (request) =>
          request.providerOptions?.openai?.promptCacheKey ===
          SessionRunnerCache.promptCacheNamespace({
            scope: "compaction",
            routeID: model.route.id,
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
    expect(requests.every((request) => Token.estimate(helperInputText(request)) <= budget)).toBe(true)
    expect(requests.every((request) => systemText(request).includes("conversation_memory"))).toBe(true)
    expect(requests.every((request) => !promptText(request).includes("Output exactly one TOON document"))).toBe(true)
    expect(requests.some((request) => promptText(request).includes("strict JSON ContextManifest"))).toBe(false)
    expect(manifest.exclusions).toEqual([])
    expectStrictFrozenSummary(manifest)
    expect(manifest.retainedTokens).toBeLessThan(manifest.inputTokens)
  }),
)

it.effect("uses one deterministic hidden child Session for compaction provider traffic", () =>
  Effect.gen(function* () {
    reset()
    const db = (yield* Database.Service).db
    const sessionID = SessionSchema.ID.make("ses_manifest_hidden_child")
    const firstID = SessionMessage.ID.make("msg_manifest_hidden_child_first")
    const boundaryID = SessionMessage.ID.make("msg_manifest_hidden_child_boundary")
    const job = manifestJob(sessionID, { messageID: boundaryID, seq: 2 })
    yield* seedSession(sessionID, 2)
    yield* insertAssistant(sessionID, firstID, 1, "hidden child compaction source ".repeat(200))
    yield* insertMessage(sessionID, boundaryID, 2, "Compaction boundary")
    responseForRequest = () => checkpoint(2, "Hidden child checkpoint")

    yield* generateManifest(job)
    yield* generateManifest(job)

    const children = yield* db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.parent_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    expect(children).toHaveLength(1)
    const child = children[0]
    expect(child.id).toMatch(/^ses_compaction_/)
    expect(child.parent_id).toBe(sessionID)
    expect(child.agent).toBe("compaction")
    expect(child.model).toEqual({ providerID: "test", id: "manifest-model" })
    const childID = SessionSchema.ID.make(child.id)
    expect(
      yield* db
        .select()
        .from(SessionTaskTable)
        .where(eq(SessionTaskTable.session_id, childID))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([])
    expect(
      yield* db
        .select()
        .from(SessionProviderRequestTable)
        .where(eq(SessionProviderRequestTable.session_id, childID))
        .all()
        .pipe(Effect.orDie),
    ).toHaveLength(2)
    expect(
      yield* db
        .select()
        .from(SessionProviderRequestTable)
        .where(eq(SessionProviderRequestTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([])
  }),
)

itWithBoundedManifest.effect(
  "drops arbitrary covered payload while retaining compact continuity fields and current active skills",
  () =>
    Effect.gen(function* () {
      reset()
      const db = (yield* Database.Service).db
      const context = yield* SessionContextState.Service
      const sessionID = SessionSchema.ID.make("ses_manifest_semantic_retention")
      const arbitrary = "ARBITRARY_COVERED_PAYLOAD_4f7d9b ".repeat(4_000)
      const sentinel = [
        "Active skill: semantic-retention; active because this compaction task requires it; route only compaction checkpoints.",
        "Objective: preserve mandatory semantic state.",
        "Requirement: fail closed when mandatory state cannot fit.",
        "Accepted decision: use existing TOON v1 fields.",
        "Todo [in_progress]: implement deterministic repair.",
        "Todo [pending]: run focused validation.",
        "Next action: repair the helper checkpoint.",
      ].join("\n")
      const messageIDs = Array.from({ length: 22 }, (_, index) =>
        SessionMessage.ID.make(`msg_manifest_semantic_retention_${index}`),
      )
      const skillText =
        "Use for semantic checkpoints. Trigger only for compaction; do not route ordinary implementation."
      yield* seedSession(sessionID, messageIDs.length + 1)
      yield* SessionContextState.initialize(db, sessionID, 0)
      yield* insertSkill(sessionID, SessionMessage.ID.make("msg_manifest_semantic_skill"), 2, skillText)
      yield* Effect.forEach(
        messageIDs,
        (id, index) =>
          insertMessage(
            sessionID,
            id,
            index === 0 ? 1 : index + 2,
            index === 0 ? arbitrary : index === 1 ? sentinel : `covered user text ${index}`,
          ),
        { discard: true },
      )
      responseForRequest = (request) => {
        const match = promptText(request).match(/up to and including (\d+)/)
        return checkpoint(Number(match?.[1]), "Continue the conversation")
      }

      const manifest = yield* generateManifest(
        manifestJob(sessionID, { messageID: messageIDs.at(-1)!, seq: messageIDs.length + 1 }),
      )
      retainManifestGuardrail(sessionID, manifest)
      yield* context.activate({ sessionID, manifest })

      if (!manifest.summary) throw new Error("Expected retained summary")
      const parsed = SessionSummaryToon.parse(manifest.summary.text, {
        throughSequence: manifest.summary.coveredThrough.seq,
        maxSummaryBytes: Buffer.byteLength(manifest.summary.text, "utf8"),
      })
      if ("_tag" in parsed) throw parsed
      expect(parsed.skill).toHaveLength(1)
      expect(parsed.skill[0]).toContain("Active skill: Semantic State Skill")
      expect(manifest.summary.text).toContain(
        "Active skill: semantic-retention; active because this compaction task requires it; route only compaction checkpoints.",
      )
      expect(parsed.requirements).toContain("Requirement: fail closed when mandatory state cannot fit.")
      expect(parsed.decision).toContainEqual({
        text: "Accepted decision: use existing TOON v1 fields.",
        status: "accepted",
      })
      expect(parsed.in_progress).toContain("Todo [in_progress]: implement deterministic repair.")
      expect(parsed.pending).toContain("Todo [pending]: run focused validation.")
      expect(parsed.pending).toContain("Next action: repair the helper checkpoint.")
      expect(manifest.summary.text).toContain("Semantic State Skill")
      expect(manifest.summary.text).toContain(skillText)
      const modelHistory = JSON.stringify(yield* SessionHistory.forModel(db, sessionID))
      expect(modelHistory).not.toContain("ARBITRARY_COVERED_PAYLOAD_4f7d9b")
      expect(modelHistory).toContain("Accepted decision: use existing TOON v1 fields")
      expect(modelHistory).toContain("Todo [in_progress]: implement deterministic repair")
    }),
)

itWithTwoPasses.effect("falls back to a local canonical checkpoint for malformed helper JSON and TOON", () =>
  Effect.gen(function* () {
    reset()
    const sessionID = SessionSchema.ID.make("ses_manifest_repair")
    const firstID = SessionMessage.ID.make("msg_manifest_repair_first")
    const boundaryID = SessionMessage.ID.make("msg_manifest_repair_boundary")
    yield* seedSession(sessionID, 2)
    yield* insertAssistant(sessionID, firstID, 1, "first malformed fallback source ".repeat(200))
    yield* insertMessage(sessionID, boundaryID, 2, "retained boundary")
    responseForRequest = () => '{"schemaVersion":1}'

    const manifest = yield* generateManifest(manifestJob(sessionID, { messageID: boundaryID, seq: 2 }))

    expect(requests).toHaveLength(1)
    expectStrictFrozenSummary(manifest)
    expect((yield* validateGeneratedManifest(sessionID, manifest, 1)).valid).toBe(true)
  }),
)

it.effect("stops later helper batches and falls back to a local canonical checkpoint when the provider fails", () =>
  Effect.gen(function* () {
    reset()
    const sessionID = SessionSchema.ID.make("ses_manifest_provider_failure")
    const messageIDs = Array.from({ length: 6 }, (_, index) =>
      SessionMessage.ID.make(`msg_manifest_provider_failure_${index}`),
    )
    yield* seedSession(sessionID, messageIDs.length)
    yield* Effect.forEach(
      messageIDs,
      (id, index) => insertAssistant(sessionID, id, index + 1, `provider fallback source ${index} `.repeat(120)),
      { discard: true },
    )

    const manifest = yield* generateManifest(
      manifestJob(sessionID, { messageID: messageIDs.at(-1)!, seq: messageIDs.length }, 4_096),
    )

    expect(requests).toHaveLength(1)
    expectStrictFrozenSummary(manifest)
    expect((yield* validateGeneratedManifest(sessionID, manifest, 1)).valid).toBe(true)
  }),
)

itWithTotalTimeout.effect("bounds all helper batches with one timeout and completes from the local checkpoint", () =>
  Effect.gen(function* () {
    reset()
    const sessionID = SessionSchema.ID.make("ses_manifest_total_timeout")
    const messageIDs = Array.from({ length: 6 }, (_, index) =>
      SessionMessage.ID.make(`msg_manifest_total_timeout_${index}`),
    )
    yield* seedSession(sessionID, messageIDs.length)
    yield* Effect.forEach(
      messageIDs,
      (id, index) => insertAssistant(sessionID, id, index + 1, `timeout checkpoint material ${index} `.repeat(120)),
      { discard: true },
    )
    responseForRequest = (request) => {
      const match = promptText(request).match(/up to and including (\d+)/)
      return checkpoint(Number(match?.[1]), "Model-authored checkpoint")
    }
    beforeResponse = Effect.sleep("40 seconds")
    const compacting = yield* generateManifest(
      manifestJob(sessionID, { messageID: messageIDs.at(-1)!, seq: messageIDs.length }, 4_096),
    ).pipe(Effect.forkChild({ startImmediately: true }))

    while (requests.length < 1) yield* Effect.yieldNow
    yield* TestClock.adjust("40 seconds")
    while (requests.length < 2) yield* Effect.yieldNow
    yield* TestClock.adjust("21 seconds")

    const manifest = yield* Fiber.join(compacting)
    expect(requests).toHaveLength(2)
    expectStrictFrozenSummary(manifest)
    expect((yield* validateGeneratedManifest(sessionID, manifest, 1)).valid).toBe(true)
  }),
)

itWithTotalTimeout.effect("settles timeout fallback through execution and releases the durable lease", () =>
  Effect.gen(function* () {
    reset()
    const db = (yield* Database.Service).db
    const execution = yield* SessionCompactionExecution.Service
    const jobs = yield* SessionCompactionJob.Service
    const compaction = yield* SessionCompaction.Service
    const sessionID = SessionSchema.ID.make("ses_manifest_timeout_execution")
    const sourceID = SessionMessage.ID.make("msg_manifest_timeout_execution_source")
    const boundaryID = SessionMessage.ID.make("msg_manifest_timeout_execution_boundary")
    const jobID = ID.make("cmp_manifest_timeout_execution")
    yield* seedSession(sessionID, 2)
    yield* SessionContextState.initialize(db, sessionID, 0)
    yield* insertAssistant(sessionID, sourceID, 1, "timeout execution source ".repeat(200))
    yield* insertAssistant(sessionID, boundaryID, 2, "retained timeout boundary")
    yield* jobs.admit({
      id: jobID,
      sessionID,
      trigger: "manual",
      requestedThrough: { messageID: boundaryID, seq: 2 },
      baseContextRevision: 0,
      targetMaxInputTokens: 4_096,
      configDigest: "a".repeat(64),
    })
    beforeResponse = Effect.never
    const running = yield* execution
      .run({
        jobID,
        manifest: (job) =>
          compaction
            .manifest(job)
            .pipe(Effect.tap((manifest) => Effect.sync(() => retainManifestGuardrail(sessionID, manifest)))),
      })
      .pipe(Effect.forkChild({ startImmediately: true }))

    while (requests.length < 1) yield* Effect.yieldNow
    expect(yield* jobs.get(jobID)).toMatchObject({ status: "running", leaseOwner: expect.any(String) })
    yield* TestClock.adjust("61 seconds")

    expect(yield* Fiber.join(running)).toMatchObject({ id: jobID, status: "ended" })
    const settled = yield* jobs.get(jobID)
    expect(settled).toMatchObject({ status: "ended" })
    expect(settled?.leaseOwner).toBeUndefined()
    expect(settled?.leaseExpiresAt).toBeUndefined()
    const terminalEvents = yield* db
      .select({ data: EventTable.data })
      .from(EventTable)
      .where(
        and(
          eq(EventTable.aggregate_id, sessionID),
          eq(
            EventTable.type,
            EventV2.versionedType(SessionEvent.Compaction.Ended.type, SessionEvent.Compaction.Ended.durable.version),
          ),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    expect(terminalEvents).toHaveLength(1)
    expect(terminalEvents[0]?.data).toMatchObject({ jobID })
  }),
)

itWithoutHelperMandatory.effect(
  "preserves useful TOON continuity from ordinary user, assistant, and tool content when the helper is unavailable",
  () =>
    Effect.gen(function* () {
      reset()
      const sessionID = SessionSchema.ID.make("ses_manifest_semantic_fallback")
      const ids = Array.from({ length: 5 }, (_, index) =>
        SessionMessage.ID.make(`msg_manifest_semantic_fallback_${index}`),
      )
      yield* seedSession(sessionID, ids.length)
      yield* insertMessage(
        sessionID,
        ids[0]!,
        1,
        "Repair TASK-781 so compaction keeps the delivery evidence and never publishes external updates. The fix is accepted only when TEST-904 passes.",
      )
      yield* insertAssistant(
        sessionID,
        ids[1]!,
        2,
        `Investigation confirmed that the prior checkpoint omitted the requested artifact and broke continuation. ${"Detailed verification evidence. ".repeat(100)} Final conclusion LONG-RESULT-918 remains actionable.`,
      )
      yield* insertAssistantTool(
        sessionID,
        ids[2]!,
        3,
        "Artifact ARTIFACT-742 proves the Jenkins and Grafana checks passed for /workspace/report.json.",
      )
      yield* insertMessage(
        sessionID,
        ids[3]!,
        4,
        "We chose deterministic merging. Next, validate the package typecheck and prepare the preview without publishing it.",
      )
      yield* insertAssistant(
        sessionID,
        ids[4]!,
        5,
        "The implementation is still in progress and awaits focused validation.",
      )

      const manifest = yield* generateManifest(
        manifestJob(sessionID, { messageID: ids.at(-1)!, seq: ids.length }, 16_384, "mandatory"),
      )
      if (!manifest.summary) throw new Error("Expected semantic fallback checkpoint")
      const parsed = SessionSummaryToon.parse(manifest.summary.text, {
        throughSequence: manifest.summary.coveredThrough.seq,
        maxSummaryBytes: Buffer.byteLength(manifest.summary.text, "utf8"),
      })
      if ("_tag" in parsed) throw parsed

      expect(parsed.objective).toContain("TASK-781")
      expect(parsed.requirements.join("\n")).toContain("never publishes external updates")
      expect(parsed.acceptance_criteria.join("\n")).toContain("TEST-904")
      const longSourceFact = parsed.facts.find((fact) => fact.text.includes("source sequence=2"))?.text ?? ""
      expect(longSourceFact).toContain("Investigation confirmed")
      expect(longSourceFact).toContain("LONG-RESULT-918")
      expect(longSourceFact).toContain("sha256=")
      expect(Array.from(longSourceFact).length).toBeLessThanOrEqual(384)
      expect(parsed.facts.map((fact) => fact.text).join("\n")).toContain("ARTIFACT-742")
      expect(parsed.decision.map((decision) => decision.text).join("\n")).toContain("deterministic merging")
      expect(parsed.pending.join("\n")).toContain("package typecheck")
      expect(parsed.important_identifiers.join("\n")).toContain("/workspace/report.json")
      expect(parsed.current_state).toContain("in progress")
      expect(parsed.continuation).toContain("validate")
      expect(manifest.summary.text).not.toContain("data:image/png;base64")
      expect(manifest.retainedTokens).toBeLessThanOrEqual(16_384)
    }),
)

it.effect("merges later helper batches without erasing earlier semantic memory", () =>
  Effect.gen(function* () {
    reset()
    const sessionID = SessionSchema.ID.make("ses_manifest_batch_merge")
    const ids = Array.from({ length: 10 }, (_, index) => SessionMessage.ID.make(`msg_manifest_batch_merge_${index}`))
    yield* seedSession(sessionID, ids.length)
    yield* Effect.forEach(
      ids,
      (id, index) =>
        insertAssistant(sessionID, id, index + 1, `ordinary batch material ${index} ${"detail ".repeat(400)}`),
      { discard: true },
    )
    let call = 0
    responseForRequest = (request) => {
      call += 1
      const through = Number(promptText(request).match(/up to and including (\d+)/)?.[1])
      return call === 1
        ? SessionSummaryToon.encode({
            ...checkpointMemory(through),
            objective: "Preserve BATCH-OBJECTIVE-1",
            requirements: ["Keep BATCH-REQUIREMENT-1"],
          })
        : checkpoint(through, "Later helper output omitted the earlier memory")
    }

    const manifest = yield* generateManifest(
      manifestJob(sessionID, { messageID: ids.at(-1)!, seq: ids.length }, 4_096, "mandatory"),
    )

    expect(requests.length).toBeGreaterThan(1)
    expect(manifest.summary?.text).toContain("BATCH-OBJECTIVE-1")
    expect(manifest.summary?.text).toContain("BATCH-REQUIREMENT-1")
  }),
)

itWithOnePass.effect("keeps accumulated helper memory when the internal pass limit is exhausted", () =>
  Effect.gen(function* () {
    reset()
    const sessionID = SessionSchema.ID.make("ses_manifest_pass_exhaustion")
    const ids = Array.from({ length: 10 }, (_, index) =>
      SessionMessage.ID.make(`msg_manifest_pass_exhaustion_${index}`),
    )
    yield* seedSession(sessionID, ids.length)
    yield* Effect.forEach(
      ids,
      (id, index) =>
        insertAssistant(sessionID, id, index + 1, `pass exhaustion material ${index} ${"detail ".repeat(400)}`),
      { discard: true },
    )
    responseForRequest = (request) => {
      const through = Number(promptText(request).match(/up to and including (\d+)/)?.[1])
      return SessionSummaryToon.encode({
        ...checkpointMemory(through),
        objective: "Preserve PASS-OBJECTIVE-1",
        pending: ["Continue PASS-PENDING-1 after local batches"],
      })
    }

    const manifest = yield* generateManifest(
      manifestJob(sessionID, { messageID: ids.at(-1)!, seq: ids.length }, 4_096, "mandatory"),
    )

    expect(requests).toHaveLength(1)
    expect(manifest.summary?.text).toContain("PASS-OBJECTIVE-1")
    expect(manifest.summary?.text).toContain("PASS-PENDING-1")
  }),
)

itWithoutHelperMandatory.effect("does not accumulate inactive skill instructions across compactions", () =>
  Effect.gen(function* () {
    reset()
    const db = (yield* Database.Service).db
    const context = yield* SessionContextState.Service
    const sessionID = SessionSchema.ID.make("ses_manifest_skill_pruning")
    const firstSkillID = SessionMessage.ID.make("msg_manifest_skill_pruning_first_skill")
    const firstBoundaryID = SessionMessage.ID.make("msg_manifest_skill_pruning_first_boundary")
    yield* seedSession(sessionID, 2)
    yield* SessionContextState.initialize(db, sessionID, 0)
    yield* insertSkill(sessionID, firstSkillID, 1, "OLD-SKILL-INSTRUCTIONS should be inactive after compaction.")
    yield* insertAssistant(sessionID, firstBoundaryID, 2, `First boundary ${"context ".repeat(300)}`)

    const first = yield* generateManifest(
      manifestJob(sessionID, { messageID: firstBoundaryID, seq: 2 }, 4_096, "mandatory"),
    )
    retainManifestGuardrail(sessionID, first)
    yield* context.activate({ sessionID, manifest: first })

    const nextSkillID = SessionMessage.ID.make("msg_manifest_skill_pruning_next_skill")
    const nextBoundaryID = SessionMessage.ID.make("msg_manifest_skill_pruning_next_boundary")
    yield* insertSkill(sessionID, nextSkillID, 4, "NEW-SKILL-INSTRUCTIONS remain active for the next task.")
    yield* insertAssistant(sessionID, nextBoundaryID, 5, `Second boundary ${"context ".repeat(300)}`)
    yield* db
      .update(EventSequenceTable)
      .set({ seq: 5 })
      .where(eq(EventSequenceTable.aggregate_id, sessionID))
      .run()
      .pipe(Effect.orDie)

    const second = yield* generateManifest({
      ...manifestJob(sessionID, { messageID: nextBoundaryID, seq: 5 }, 4_096, "mandatory"),
      baseContextRevision: 1,
    })

    expect(second.summary?.text).toContain("NEW-SKILL-INSTRUCTIONS")
    expect(second.summary?.text).not.toContain("OLD-SKILL-INSTRUCTIONS")
  }),
)

itWithHollowLimit.effect(
  "does not activate a semantically hollow checkpoint that cannot represent its covered ranges",
  () =>
    Effect.gen(function* () {
      reset()
      const sessionID = SessionSchema.ID.make("ses_manifest_hollow_coverage")
      const ids = Array.from({ length: 30 }, (_, index) =>
        SessionMessage.ID.make(`msg_manifest_hollow_coverage_${index}`),
      )
      yield* seedSession(sessionID, ids.length)
      yield* Effect.forEach(
        ids,
        (id, index) =>
          insertMessage(sessionID, id, index + 1, `Distinct obligation RANGE-${index}: preserve result ID-${index}.`),
        { discard: true },
      )
      responseForRequest = (request) =>
        checkpoint(Number(promptText(request).match(/up to and including (\d+)/)?.[1]), "Generic hollow checkpoint")

      const error = yield* generateManifest(
        manifestJob(sessionID, { messageID: ids.at(-1)!, seq: ids.length }, 4_096, "mandatory"),
      ).pipe(Effect.flip)

      expect(error.code).toBe("context_limit_unresolved")
    }),
)

itWithBoundedManifest.effect("summarizes labeled continuity without exact-copying unrelated oversized payload", () =>
  Effect.gen(function* () {
    reset()
    const sessionID = SessionSchema.ID.make("ses_manifest_bounded_requirement")
    const firstID = SessionMessage.ID.make("msg_manifest_bounded_requirement_first")
    const boundaryID = SessionMessage.ID.make("msg_manifest_bounded_requirement_boundary")
    const requirement = "Requirement: preserve authentication behavior."
    yield* seedSession(sessionID, 2)
    yield* insertMessage(
      sessionID,
      firstID,
      1,
      `${requirement}\nARBITRARY_REQUIREMENT_PAYLOAD ${"payload ".repeat(4_000)}`,
    )
    yield* insertMessage(sessionID, boundaryID, 2, "Continue from the compact checkpoint.")

    const manifest = yield* generateManifest(manifestJob(sessionID, { messageID: boundaryID, seq: 2 }))

    if (!manifest.summary) throw new Error("Expected local fallback checkpoint")
    const parsed = SessionSummaryToon.parse(manifest.summary.text, {
      throughSequence: manifest.summary.coveredThrough.seq,
      maxSummaryBytes: Buffer.byteLength(manifest.summary.text, "utf8"),
    })
    if ("_tag" in parsed) throw parsed
    expect(parsed.requirements).toContain(requirement)
    expect(manifest.summary.text).not.toContain("ARBITRARY_REQUIREMENT_PAYLOAD")
    expect(manifest.retainedTokens).toBeLessThan(manifest.inputTokens)
  }),
)

itWithoutHelper.effect("uses a local canonical checkpoint without provider traffic when no helper model resolves", () =>
  Effect.gen(function* () {
    reset()
    const sessionID = SessionSchema.ID.make("ses_manifest_no_helper")
    const firstID = SessionMessage.ID.make("msg_manifest_no_helper_first")
    const boundaryID = SessionMessage.ID.make("msg_manifest_no_helper_boundary")
    yield* seedSession(sessionID, 2)
    yield* insertAssistant(sessionID, firstID, 1, "local checkpoint source ".repeat(200))
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

itWithoutHelper.effect("activates a canonical local checkpoint when the latest source contains a Markdown fence", () =>
  Effect.gen(function* () {
    reset()
    const db = (yield* Database.Service).db
    const execution = yield* SessionCompactionExecution.Service
    const jobs = yield* SessionCompactionJob.Service
    const compaction = yield* SessionCompaction.Service
    const context = yield* SessionContextState.Service
    const sessionID = SessionSchema.ID.make("ses_manifest_fenced_local_execution")
    const sourceID = SessionMessage.ID.make("msg_manifest_fenced_local_source")
    const boundaryID = SessionMessage.ID.make("msg_manifest_fenced_local_boundary")
    const jobID = ID.make("cmp_manifest_fenced_local_execution")
    const targetMaxInputTokens = 4_096
    yield* seedSession(sessionID, 2)
    yield* SessionContextState.initialize(db, sessionID, 0)
    yield* insertAssistant(sessionID, sourceID, 1, `Earlier source ${"context ".repeat(600)}`)
    yield* insertMessage(
      sessionID,
      boundaryID,
      2,
      "Requirement: preserve the literal ```ts fence``` for continuation.\nLatest source contains the fenced-source marker.",
    )
    yield* jobs.admit({
      id: jobID,
      sessionID,
      trigger: "mandatory",
      requestedThrough: { messageID: boundaryID, seq: 2 },
      baseContextRevision: 0,
      targetMaxInputTokens,
      configDigest: "a".repeat(64),
    })
    let generated: ContextManifest.Manifest | undefined

    const result = yield* execution.run({
      jobID,
      manifest: (job) =>
        compaction.manifest(job).pipe(
          Effect.tap((manifest) =>
            Effect.sync(() => {
              generated = manifest
              retainManifestGuardrail(sessionID, manifest)
            }),
          ),
        ),
    })

    expect(result.status).toBe("ended")
    expect(generated).toBeDefined()
    expectStrictFrozenSummary(generated!)
    expect(generated!.retainedTokens).toBeLessThanOrEqual(targetMaxInputTokens)
    expect(yield* context.current(sessionID)).toMatchObject({
      status: "active",
      revision: 1,
    })
  }),
)

itWithTargetEnforcement.effect("activates a reducing helper checkpoint above the advisory target", () =>
  Effect.gen(function* () {
    reset()
    const sessionID = SessionSchema.ID.make("ses_manifest_target_enforced")
    const messageIDs = Array.from({ length: 6 }, (_, index) =>
      SessionMessage.ID.make(`msg_manifest_target_enforced_${index}`),
    )
    yield* seedSession(sessionID, messageIDs.length)
    yield* Effect.forEach(
      messageIDs,
      (id, index) => insertAssistant(sessionID, id, index + 1, `large source ${index} ${"material ".repeat(1_000)}`),
      { discard: true },
    )
    responseForRequest = (request) => {
      const through = Number(promptText(request).match(/up to and including (\d+)/)?.[1])
      return checkpoint(
        through,
        through === messageIDs.length
          ? `HELPER_ABOVE_TARGET ${"expanded ".repeat(3_000)}`
          : `Small intermediate checkpoint through ${through}`,
      )
    }
    const targetMaxInputTokens = 4_096

    const manifest = yield* generateManifest(
      manifestJob(
        sessionID,
        { messageID: messageIDs.at(-1)!, seq: messageIDs.length },
        targetMaxInputTokens,
        "mandatory",
      ),
    )

    expect(requests.length).toBeGreaterThan(0)
    expect(manifest.summary?.text).toContain("HELPER_ABOVE_TARGET")
    expect(manifest.retainedTokens).toBeLessThan(manifest.inputTokens)
  }),
)

itWithoutHelper.effect("activates a reducing checkpoint when the requested target is too small", () =>
  Effect.gen(function* () {
    reset()
    const sessionID = SessionSchema.ID.make("ses_manifest_target_unresolved")
    const sourceID = SessionMessage.ID.make("msg_manifest_target_unresolved_source")
    yield* seedSession(sessionID, 1)
    yield* insertAssistant(sessionID, sourceID, 1, `irreducible target source ${"material ".repeat(600)}`)

    const manifest = yield* generateManifest(manifestJob(sessionID, { messageID: sourceID, seq: 1 }, 1, "mandatory"))

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
    yield* insertAssistant(sessionID, firstID, 1, "first unique message ".repeat(200))
    yield* insertMessage(sessionID, boundaryID, 2, "second unique message")
    const summary = SessionSummaryToon.encode({
      version: 2,
      through_sequence: 1,
      objective: "Preserve the first unique request",
      in_progress: [],
      pending: [],
      blocked: [],
      decision: [],
      current_state: "The earlier request is recorded",
      facts: [],
      preferences: [],
      constraints: [],
      completed: [],
      unresolved: [],
      important_identifiers: [],
      continuation: "Continue with the retained recent message",
    })
    responseForRequest = () => summary

    const manifest = yield* generateManifest(manifestJob(sessionID, { messageID: boundaryID, seq: 2 }))

    expect(decodeJSON(ContextManifest.manifestJSON(manifest))).toMatchObject({
      summary: {
        coveredThrough: { messageID: firstID, seq: 1 },
      },
    })
    expect(manifest.summary?.text).toContain("Preserve the first unique request")
    expect(manifest.exclusions.some((exclusion) => exclusion.target.messageID === boundaryID)).toBe(false)
    expect(requests.every((request) => systemText(request).includes("conversation_memory"))).toBe(true)
    expect(requests.some((request) => promptText(request).includes("strict JSON ContextManifest"))).toBe(false)
    expect(manifest.retainedTokens).toBeLessThan(manifest.inputTokens)
  }),
)

itWithTinyManifest.effect("activates a reducing checkpoint when max_manifest_bytes is too small", () =>
  Effect.gen(function* () {
    reset()
    const db = (yield* Database.Service).db
    const sessionID = SessionSchema.ID.make("ses_manifest_oversized")
    const firstID = SessionMessage.ID.make("msg_manifest_oversized_first")
    const boundaryID = SessionMessage.ID.make("msg_manifest_oversized_boundary")
    yield* seedSession(sessionID, 2)
    yield* insertMessage(sessionID, firstID, 1, "oversized fallback source ".repeat(300))
    yield* insertMessage(sessionID, boundaryID, 2, "retained boundary")
    responseForRequest = () => checkpoint(1, "x".repeat(2_000))

    const manifest = yield* generateManifest(manifestJob(sessionID, { messageID: boundaryID, seq: 2 }))

    expect(manifest.retainedTokens).toBeLessThan(manifest.inputTokens)
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(yield* SessionHistory.forModel(db, sessionID))).toContain("oversized fallback source")
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
    yield* insertAssistant(sessionID, firstID, 1, "mandatory earlier source ".repeat(200))
    yield* insertAssistant(sessionID, boundaryID, 2, "mandatory job boundary ".repeat(200))
    responseForRequest = () => checkpoint(2, "The mandatory boundary is covered")

    const manifest = yield* generateManifest(
      manifestJob(sessionID, { messageID: boundaryID, seq: 2 }, 4_096, "mandatory"),
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
    yield* insertAssistant(sessionID, firstID, 1, "large canonical first context ".repeat(400))
    responseForRequest = () =>
      SessionSummaryToon.encode({
        ...checkpointMemory(1, "Small first checkpoint"),
        objective: "Preserve the first objective",
      })

    const first = yield* generateManifest(manifestJob(sessionID, { messageID: firstID, seq: 1 }, 4_096, "mandatory"))
    expect(first.summary?.text).toContain("Small first checkpoint")
    retainManifestGuardrail(sessionID, first)
    yield* context.activate({ sessionID, manifest: first })

    yield* insertAssistant(
      sessionID,
      laterID,
      10,
      `Objective: Deliver the newer objective. ${"later material remains useful ".repeat(35)}`,
    )
    yield* insertAssistant(sessionID, boundaryID, 11, "second boundary material ".repeat(35))
    yield* db
      .update(EventSequenceTable)
      .set({ seq: 11 })
      .where(eq(EventSequenceTable.aggregate_id, sessionID))
      .run()
      .pipe(Effect.orDie)
    const before = yield* SessionHistory.forModel(db, sessionID)
    expect(JSON.stringify(before)).toContain("Small first checkpoint")
    const beforeTokens = selectedTokens(before)
    responseForRequest = () => checkpoint(11, "helper checkpoint growth ".repeat(260))

    const second = yield* generateManifest({
      ...manifestJob(sessionID, { messageID: boundaryID, seq: 11 }, 4_096, "mandatory"),
      baseContextRevision: 1,
    })
    retainManifestGuardrail(sessionID, second)
    yield* context.activate({ sessionID, manifest: second })
    const after = yield* SessionHistory.forModel(db, sessionID)
    const afterTokens = selectedTokens(after)

    expect(afterTokens).toBeLessThan(beforeTokens)
    expect(second.summary?.text).toContain("Small first checkpoint")
    if (!second.summary) throw new Error("Expected sequential summary")
    const parsed = SessionSummaryToon.parse(second.summary.text, {
      throughSequence: second.summary.coveredThrough.seq,
      maxSummaryBytes: Buffer.byteLength(second.summary.text, "utf8"),
    })
    if ("_tag" in parsed) throw parsed
    expect(parsed.objective).toContain("Preserve the first objective")
    expect(parsed.objective).toContain("Objective: Deliver the newer objective.")
    expect(second.inputTokens).toBe(beforeTokens)
    expect(second.retainedTokens).toBe(afterTokens)
  }),
)

itWithoutHelperMandatory.effect("coalesces sequential source coverage into a reducing canonical checkpoint", () =>
  Effect.gen(function* () {
    reset()
    const db = (yield* Database.Service).db
    const context = yield* SessionContextState.Service
    const sessionID = SessionSchema.ID.make("ses_manifest_sequential_capsule_rollover")
    const firstIDs = Array.from({ length: 88 }, (_, index) =>
      SessionMessage.ID.make(`msg_manifest_capsule_rollover_first_${index}`),
    )
    const secondIDs = Array.from({ length: 88 }, (_, index) =>
      SessionMessage.ID.make(`msg_manifest_capsule_rollover_second_${index}`),
    )
    const uniqueMaterial = (phase: string, index: number) =>
      [
        `Objective: preserve the ${phase} semantic objective OBJECTIVE-${index}.`,
        "Requirement: compaction must retain required semantic fields.",
        "Acceptance criteria: the canonical TOON checkpoint stays within its byte bound.",
        "Progress: source coverage is confirmed and validation remains in progress.",
        "Pending: continue the repaired Session without stopping the chat.",
        "Accepted decision: use deterministic bounded source coverage.",
        "Blocker: oversized historical provenance must not prevent useful reduction.",
        Array.from({ length: 48 }, (_, word) => `${phase}_${index}_distinct_${word}`).join(" "),
      ].join(" ")

    yield* seedSession(sessionID, firstIDs.length)
    yield* SessionContextState.initialize(db, sessionID, 0)
    yield* Effect.forEach(
      firstIDs,
      (id, index) => insertAssistant(sessionID, id, index + 1, uniqueMaterial("first", index)),
      { discard: true },
    )

    const first = yield* generateManifest(
      manifestJob(sessionID, { messageID: firstIDs.at(-1)!, seq: firstIDs.length }, 16_384, "mandatory"),
    )
    if (!first.summary) throw new Error("Expected first rolling checkpoint")
    const firstMemory = SessionSummaryToon.parse(first.summary.text, {
      throughSequence: first.summary.coveredThrough.seq,
      maxSummaryBytes: 65_536,
    })
    if ("_tag" in firstMemory) throw firstMemory
    expect(firstMemory.facts.filter((fact) => fact.text.startsWith("[source sequence="))).toHaveLength(88)
    retainManifestGuardrail(sessionID, first)
    yield* context.activate({ sessionID, manifest: first })

    yield* Effect.forEach(
      secondIDs,
      (id, index) => insertAssistant(sessionID, id, firstIDs.length + index + 1, uniqueMaterial("second", index)),
      { discard: true },
    )
    yield* db
      .update(EventSequenceTable)
      .set({ seq: firstIDs.length + secondIDs.length })
      .where(eq(EventSequenceTable.aggregate_id, sessionID))
      .run()
      .pipe(Effect.orDie)

    const second = yield* generateManifest({
      ...manifestJob(
        sessionID,
        {
          messageID: secondIDs.at(-1)!,
          seq: firstIDs.length + secondIDs.length,
        },
        16_384,
        "mandatory",
      ),
      baseContextRevision: 1,
    })
    if (!second.summary) throw new Error("Expected second rolling checkpoint")
    const secondMemory = SessionSummaryToon.parse(second.summary.text, {
      throughSequence: second.summary.coveredThrough.seq,
      maxSummaryBytes: Number.MAX_SAFE_INTEGER,
    })
    if ("_tag" in secondMemory) throw secondMemory

    expect(second.retainedTokens).toBeLessThan(second.inputTokens)
    expect(secondMemory.objective).toContain("OBJECTIVE-")
    expect(secondMemory.requirements).not.toHaveLength(0)
    expect(secondMemory.acceptance_criteria).not.toHaveLength(0)
    expect(secondMemory.in_progress).not.toHaveLength(0)
    expect(secondMemory.pending).not.toHaveLength(0)
    expect(secondMemory.decision).not.toHaveLength(0)
    expect(secondMemory.blocked).not.toHaveLength(0)
    expect(secondMemory.skill).toEqual([])
  }),
)

itMandatory.effect("recovers source pressure locally after a helper provider error", () =>
  Effect.gen(function* () {
    reset()
    const fixture = yield* seedCoveragePressure("provider_error")

    const manifest = yield* generateManifest(manifestJob(fixture.sessionID, fixture.boundary, 16_384, "mandatory"))

    expect(requests).toHaveLength(1)
    expectBestEffortCoverage(manifest)
  }),
)

itMandatory.effect("recovers source pressure locally after malformed helper TOON", () =>
  Effect.gen(function* () {
    reset()
    const fixture = yield* seedCoveragePressure("malformed")
    responseForRequest = () => '{"not":"toon"}'

    const manifest = yield* generateManifest(manifestJob(fixture.sessionID, fixture.boundary, 16_384, "mandatory"))

    expect(requests.length).toBeGreaterThan(0)
    expectBestEffortCoverage(manifest)
  }),
)

itWithOnePass.effect("recovers source pressure locally after oversized helper TOON", () =>
  Effect.gen(function* () {
    reset()
    const fixture = yield* seedCoveragePressure("oversized_helper")
    responseForRequest = (request) =>
      checkpoint(Number(promptText(request).match(/up to and including (\d+)/)?.[1]), "x".repeat(100_000))

    const manifest = yield* generateManifest(manifestJob(fixture.sessionID, fixture.boundary, 16_384, "mandatory"))

    expect(requests).toHaveLength(1)
    expectBestEffortCoverage(manifest)
  }),
)

itWithTotalTimeout.effect("recovers source pressure locally after the helper timeout", () =>
  Effect.gen(function* () {
    reset()
    const fixture = yield* seedCoveragePressure("timeout")
    responseForRequest = (request) =>
      checkpoint(Number(promptText(request).match(/up to and including (\d+)/)?.[1]), "helper response")
    beforeResponse = Effect.never
    const compacting = yield* generateManifest(
      manifestJob(fixture.sessionID, fixture.boundary, 16_384, "mandatory"),
    ).pipe(Effect.forkChild({ startImmediately: true }))

    while (requests.length < 1) yield* Effect.yieldNow
    yield* TestClock.adjust("61 seconds")

    expectBestEffortCoverage(yield* Fiber.join(compacting))
  }),
)

it.effect("rejects the combined candidate when protected state changes during generation", () =>
  Effect.gen(function* () {
    reset()
    const sessionID = SessionSchema.ID.make("ses_manifest_protected_change")
    const firstID = SessionMessage.ID.make("msg_manifest_protected_change_first")
    const boundaryID = SessionMessage.ID.make("msg_manifest_protected_change_boundary")
    yield* seedSession(sessionID, 2)
    yield* insertAssistant(sessionID, firstID, 1, "immutable compacted source ".repeat(200))
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
    yield* insertAssistant(sessionID, firstID, 1, "immutable compacted source ".repeat(200))
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
