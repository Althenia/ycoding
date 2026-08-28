import { expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { Database } from "@ycoding-ai/core/database/database"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { ProjectV2 } from "@ycoding-ai/core/project"
import { SessionContinuation } from "@ycoding-ai/core/session/runner/continuation"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionContextRevisionTable, SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { testEffect } from "./lib/effect"

const sessionID = SessionSchema.ID.make("ses_continuation")
const otherSessionID = SessionSchema.ID.make("ses_continuation_other")
const representedMessageID = SessionMessage.ID.make("msg_represented")
const completeMessageIDs = [
  SessionMessage.ID.make("msg_first"),
  SessionMessage.ID.make("msg_second"),
  representedMessageID,
]
const digest = (value: string) => value.repeat(64).slice(0, 64)
const fingerprint = {
  sessionID,
  routeID: "openai-responses",
  provider: "openai",
  modelID: "gpt-5.6",
  contextRevision: 0,
  continuationGeneration: 0,
  connectionIdentityDigest: digest("1"),
  representedThroughMessageID: representedMessageID,
  representedMessageCount: 3,
  promptCacheKey: "cache-key",
  instructionsDigest: digest("2"),
  toolsDigest: digest("3"),
  optionsDigest: digest("4"),
  volatileContextDigest: digest("5"),
}
const state = { ...fingerprint, responseID: "resp_1" }

const it = testEffect(Database.layer({ path: ":memory:" })).effect

it("survives a new service instance backed by the same SQLite database", () =>
  Effect.gen(function* () {
    yield* seedSessions()
    const first = yield* makeContinuation()
    yield* first.remember(state)

    const restarted = yield* makeContinuation()
    expect(yield* restarted.select(selectInput({ ...fingerprint, mode: "auto", store: true }))).toEqual(state)
  }),
)

it("allows only the two direct OpenAI Responses routes", () =>
  Effect.gen(function* () {
    yield* seedSessions()
    const continuation = yield* makeContinuation()

    for (const routeID of ["openai-responses", "openai-responses-websocket"]) {
      const routeState = { ...state, routeID, responseID: `resp_${routeID}` }
      yield* continuation.remember(routeState)
      expect(yield* continuation.select(selectInput({ ...routeState, mode: "on", store: true }))).toEqual(routeState)
    }

    for (const routeID of [
      "openai-chat",
      "openai-codex-responses",
      "openai-codex-websocket-responses",
      "github-copilot-responses",
      "ai-sdk:@ai-sdk/github-copilot",
    ]) {
      const routeState = { ...state, routeID, responseID: `resp_${routeID}` }
      yield* continuation.remember(routeState)
      expect(yield* continuation.select(selectInput({ ...routeState, mode: "on", store: true }))).toBeUndefined()
    }
  }),
)

it("does not reuse state when storage or continuation reuse is disabled", () =>
  Effect.gen(function* () {
    yield* seedSessions()
    const continuation = yield* makeContinuation()

    yield* continuation.remember(state)
    expect(yield* continuation.select(selectInput({ ...fingerprint, mode: "off", store: true }))).toBeUndefined()

    yield* continuation.remember({ ...state, continuationGeneration: 1 })
    expect(
      yield* continuation.select(
        selectInput({ ...fingerprint, continuationGeneration: 1, mode: "on", store: false }),
      ),
    ).toBeUndefined()
  }),
)

it("rejects every request fingerprint mismatch", () =>
  Effect.gen(function* () {
    yield* seedSessions()
    const mismatches = [
      { connectionIdentityDigest: digest("6") },
      { routeID: "openai-responses-websocket" },
      { modelID: "gpt-5.5" },
      { contextRevision: 1 },
      { promptCacheKey: "other-cache" },
      { instructionsDigest: digest("7") },
      { toolsDigest: digest("8") },
      { optionsDigest: digest("9") },
    ]

    for (const mismatch of mismatches) {
      const continuation = yield* makeContinuation()
      yield* continuation.remember(state)
      expect(
        yield* continuation.select(selectInput({ ...fingerprint, ...mismatch, mode: "on", store: true })),
      ).toBeUndefined()
    }
  }),
)

it("fingerprints every stable Codex socket identity field while leaving transcript extension to the transport", () =>
  Effect.sync(() => {
    const baseline = SessionContinuation.transportFingerprint(fingerprint)
    const mismatches: ReadonlyArray<Partial<SessionContinuation.Fingerprint>> = [
      { sessionID: otherSessionID },
      { contextRevision: 1 },
      { continuationGeneration: 1 },
      { provider: "other" },
      { routeID: "openai-responses-websocket" },
      { modelID: "gpt-5.5" },
      { variant: "high" },
      { connectionIdentityDigest: digest("6") },
      { promptCacheKey: "other-cache" },
      { instructionsDigest: digest("7") },
      { toolsDigest: digest("8") },
      { optionsDigest: digest("9") },
    ]

    for (const mismatch of mismatches)
      expect(SessionContinuation.transportFingerprint({ ...fingerprint, ...mismatch })).not.toBe(baseline)
    expect(
      SessionContinuation.transportFingerprint({
        ...fingerprint,
        representedThroughMessageID: SessionMessage.ID.make("msg_next"),
        representedMessageCount: 4,
        volatileContextDigest: digest("a"),
      }),
    ).toBe(baseline)
  }),
)

it("tolerates volatile context digest churn for stored Responses continuation", () =>
  Effect.gen(function* () {
    yield* seedSessions()
    const continuation = yield* makeContinuation()
    yield* continuation.remember(state)
    expect(
      yield* continuation.select(selectInput({ ...fingerprint, volatileContextDigest: digest("a"), mode: "on", store: true })),
    ).toEqual(state)
  }),
)

it("rejects a continuation whose complete-message boundary no longer matches", () =>
  Effect.gen(function* () {
    yield* seedSessions()
    const continuation = yield* makeContinuation()
    yield* continuation.remember(state)

    expect(
      yield* continuation.select({
        ...fingerprint,
        mode: "on",
        store: true,
        completeMessageIDs: [
          completeMessageIDs[0]!,
          representedMessageID,
          completeMessageIDs[1]!,
        ],
      }),
    ).toBeUndefined()
  }),
)

it("durably fences a stale settlement after context invalidation", () =>
  Effect.gen(function* () {
    yield* seedSessions()
    const beforeInvalidation = yield* makeContinuation()
    yield* beforeInvalidation.remember(state)
    yield* insertContextRevision(1)

    const invalidator = yield* makeContinuation()
    yield* invalidator.invalidateForContextRevision(sessionID, 1)

    const staleSettlement = yield* makeContinuation()
    yield* staleSettlement.remember({ ...state, responseID: "resp_stale" })

    const afterRestart = yield* makeContinuation()
    expect(
      yield* afterRestart.select(selectInput({
        ...fingerprint,
        contextRevision: 1,
        continuationGeneration: 1,
        mode: "on",
        store: true,
      })),
    ).toBeUndefined()

    const fresh = {
      ...state,
      contextRevision: 1,
      continuationGeneration: 1,
      responseID: "resp_fresh",
    }
    yield* afterRestart.remember(fresh)
    expect(yield* afterRestart.select(selectInput({ ...fresh, mode: "on", store: true }))).toEqual(fresh)
  }),
)

it("clear removes only the selected Session and fences its in-flight state", () =>
  Effect.gen(function* () {
    yield* seedSessions()
    const continuation = yield* makeContinuation()
    const other = { ...state, sessionID: otherSessionID, responseID: "resp_2" }
    yield* continuation.remember(state)
    yield* continuation.remember(other)
    yield* continuation.clear(sessionID)
    yield* continuation.remember({ ...state, responseID: "resp_stale" })

    expect(
      yield* continuation.select(
        selectInput({ ...fingerprint, continuationGeneration: 1, mode: "on", store: true }),
      ),
    ).toBeUndefined()
    expect(yield* continuation.select(selectInput({ ...other, mode: "on", store: true }))).toEqual(other)
  }),
)

function makeContinuation() {
  return Layer.build(SessionContinuation.layer()).pipe(
    Effect.map((context) => Context.get(context, SessionContinuation.Service)),
  )
}

function seedSessions() {
  return Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const projectID = ProjectV2.ID.make("project-continuation")
    yield* db.insert(ProjectTable).values([{ id: projectID, worktree: AbsolutePath.make("/tmp"), sandboxes: [] }])
    yield* db.insert(SessionTable).values([
      { id: sessionID, project_id: projectID, directory: "/tmp", title: "Continuation" },
      { id: otherSessionID, project_id: projectID, directory: "/tmp", title: "Other" },
    ])
    yield* db.insert(SessionContextRevisionTable).values([
      { session_id: sessionID, revision: 0, time_created: 0 },
      { session_id: otherSessionID, revision: 0, time_created: 0 },
    ])
  })
}

function selectInput<T extends SessionContinuation.Fingerprint & { readonly mode: "auto" | "on" | "off"; readonly store: boolean }>(
  input: T,
) {
  return { ...input, completeMessageIDs }
}

function insertContextRevision(revision: number) {
  return Database.Service.use(({ db }) =>
    db.insert(SessionContextRevisionTable).values({
      session_id: sessionID,
      revision,
      parent_revision: revision - 1,
      time_created: revision,
    }),
  )
}
