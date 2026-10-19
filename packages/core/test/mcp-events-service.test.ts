import { expect } from "bun:test"
import { createHmac } from "node:crypto"
import { Cause, Deferred, Effect, Fiber, Logger } from "effect"
import { Statement } from "effect/unstable/sql"
import { TestClock } from "effect/testing"
import { McpEvents } from "@ycoding-ai/schema/mcp-events"
import { AbsolutePath } from "../src/schema"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { SessionSchema } from "../src/session/schema"
import { SessionStore } from "../src/session/store"
import { SessionTable } from "../src/session/sql"
import { SessionMcpEvents } from "../src/mcp-events/index"
import { McpEventsHttp } from "../src/mcp-events/protected-http"
import { makeSecretBox } from "../src/mcp-events/secret-box"
import { McpEventOutboxTable, McpEventSubscriptionTable } from "../src/mcp-events/sql"
import { testEffect } from "./lib/effect"

const DAY = 86_400_000
const secretBytes = Buffer.alloc(32, 7)
const secret = "whsec_" + secretBytes.toString("base64")
const rotatedBytes = Buffer.alloc(32, 9)
const rotatedSecret = "whsec_" + rotatedBytes.toString("base64")
const url = "https://receiver.example.test/cb"
const context = { requestID: "req_1", principal: { ownerID: "own_1", deviceID: "dev_1", clientID: "cli_1" }, epoch: "epoch_1" }
const otherContext = { requestID: "req_2", principal: { ownerID: "own_1", deviceID: "dev_2", clientID: "cli_1" }, epoch: "epoch_1" }

interface Sent { url: string; body: string; headers: Record<string, string> }
const sent: Sent[] = []
let statuses: number[] = []
let challengeEcho = true
let verificationBody: string | undefined
let transportFailure: McpEvents.Failure | undefined
let transportDefect = false
let cannotDecrypt = false
let revokeDuringVerification = false
let verificationGate: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined
const grant = { id: "grt_1", expiresAt: 30 * DAY, revoked: false, available: true, signal: undefined as AbortSignal | undefined }

const authorization: SessionMcpEvents.AuthorizationInterface = {
  capabilities: Effect.sync(() => grant.available),
  resolve: () => grant.revoked
    ? Effect.fail(new McpEvents.Failure({ category: "unauthorized", reason: "grant_revoked" }))
    : Effect.succeed({ grantID: grant.id, expiresAt: grant.expiresAt }),
  check: (principal) => grant.revoked || principal.grantID !== grant.id
    ? Effect.fail(new McpEvents.Failure({ category: "unauthorized", reason: "grant_revoked" }))
    : Effect.succeed({ expiresAt: grant.expiresAt, ...(grant.signal === undefined ? {} : { signal: grant.signal }) }),
}
const transport: McpEventsHttp.Interface = {
  send: (request) => Effect.gen(function* () {
    if (transportDefect) return yield* Effect.die(new Error(`private transport cause ${url} ${secret}`))
    if (transportFailure) return yield* transportFailure
    sent.push(request)
    const parsed = JSON.parse(request.body) as Record<string, unknown>
    if (parsed.type === "verification") {
      if (verificationGate) {
        yield* Deferred.succeed(verificationGate.entered, undefined)
        yield* Deferred.await(verificationGate.release)
      }
      if (revokeDuringVerification) grant.revoked = true
      return { status: 200, body: verificationBody ?? JSON.stringify({ challenge: challengeEcho ? parsed.challenge : "wrong" }) }
    }
    return { status: statuses.shift() ?? 200, body: "" }
  }),
}
const box = makeSecretBox(Buffer.alloc(32, 3))
const diagnostics: unknown[] = []
const diagnosticLogger = Logger.layer([Logger.make((entry) => { diagnostics.push(entry.message) })], { mergeWithExisting: false })

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, SessionStore.node]), []))

const make = Effect.gen(function* () {
  const database = yield* Database.Service
  const store = yield* SessionStore.Service
  return yield* SessionMcpEvents.make({
    db: database.db,
    authorization,
    transport,
    secretBox: { ...box, decrypt: (value) => cannotDecrypt ? undefined : box.decrypt(value) },
    session: (id) => store.get(id as never).pipe(Effect.map((info) => info === undefined ? undefined : { id: String(info.id), parentID: info.parentID === undefined ? undefined : String(info.parentID) })),
  })
})

const seed = (prefix: string) => Effect.gen(function* () {
  sent.length = 0
  diagnostics.length = 0
  statuses = []
  challengeEcho = true
  verificationBody = undefined
  transportFailure = undefined
  transportDefect = false
  cannotDecrypt = false
  revokeDuringVerification = false
  verificationGate = undefined
  grant.id = "grt_1"
  grant.expiresAt = 30 * DAY
  grant.revoked = false
  grant.available = true
  grant.signal = undefined
  const database = yield* Database.Service
  yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
  const parent = SessionSchema.ID.make(`ses_${prefix}_parent`)
  const child = SessionSchema.ID.make(`ses_${prefix}_child`)
  yield* database.db.insert(SessionTable).values({ id: parent, project_id: Project.ID.global, directory: "/project", title: "Parent" }).run().pipe(Effect.orDie)
  yield* database.db.insert(SessionTable).values({ id: child, project_id: Project.ID.global, directory: "/project", title: "Child", parent_id: parent }).run().pipe(Effect.orDie)
  return { parent, child }
})

const subscribe = (svc: SessionMcpEvents.TestInterface, sessionID: SessionSchema.ID, name: McpEvents.Name = "session.permission.changed", extra: object = {}) =>
  svc.subscribe({ context, subscription: {
    name, arguments: { session_id: sessionID }, delivery: { mode: "webhook", url, secret }, cursor: null, ...extra,
  } as never })

const deliveries = () => sent.filter((item) => (JSON.parse(item.body) as Record<string, unknown>).type !== "verification")
const payloads = () => deliveries().map((item) => JSON.parse(item.body) as { eventId: string; name: string; data: Record<string, unknown>; cursor: unknown })
const verifySignature = (item: Sent, keys = [secretBytes]) => {
  const expected = keys.map((key) => "v1," + createHmac("sha256", key).update(`${item.headers["webhook-id"]}.${item.headers["webhook-timestamp"]}.${item.body}`).digest("base64")).join(" ")
  expect(item.headers["webhook-signature"]).toBe(expected)
}

for (const name of ["session.permission.changed", "session.progress"] as const) {
  it.effect(`subscription settlement rolls back a metadata failure for ${name} and retries once by identity`, () => Effect.gen(function* () {
    const { parent } = yield* seed(`settlement_${name}`)
    const svc = yield* make
    const failure = new Error("Synthetic subscription metadata failure")
    const result = yield* subscribe(svc, parent, name).pipe(
      Effect.provideService(Statement.CurrentTransformer, (statement) =>
        statement.compile()[0].startsWith('select "pruned_through" from "mcp_event_subscription"')
          ? Effect.die(failure) : Effect.succeed(statement)),
      Effect.exit,
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(Cause.squash(result.cause)).toBe(failure)
    expect(yield* svc.rows()).toMatchObject({ subscriptions: 0 })
    const retried = yield* Effect.forEach([0, 1], () => subscribe(svc, parent, name), { concurrency: 2 })
    expect(retried[1].id).toBe(retried[0].id)
    expect(yield* svc.rows()).toMatchObject({ subscriptions: 1, activeSubscriptions: 1 })
  }))
}

it.effect("subscription settlement rolls back secret rotation and replay resets on metadata failure", () => Effect.gen(function* () {
  const { parent } = yield* seed("settlement_replay")
  const svc = yield* make
  const initial = yield* subscribe(svc, parent, "session.progress")
  yield* svc.capture({ type: "session.execution.started", id: "settlement_replay_event", data: { sessionID: parent } })
  yield* svc.dispatchOnce()
  const database = yield* Database.Service
  const before = {
    subscriptions: yield* database.db.select().from(McpEventSubscriptionTable).all().pipe(Effect.orDie),
    outbox: yield* database.db.select().from(McpEventOutboxTable).all().pipe(Effect.orDie),
  }
  yield* TestClock.adjust("31 seconds")
  const failure = new Error("Synthetic replay metadata failure")
  const result = yield* subscribe(svc, parent, "session.progress", {
    cursor: initial.cursor, delivery: { mode: "webhook", url, secret: rotatedSecret },
  }).pipe(
    Effect.provideService(Statement.CurrentTransformer, (statement) =>
      statement.compile()[0].startsWith('select "pruned_through" from "mcp_event_subscription"')
        ? Effect.die(failure) : Effect.succeed(statement)),
    Effect.exit,
  )
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(Cause.squash(result.cause)).toBe(failure)
  expect({
    subscriptions: yield* database.db.select().from(McpEventSubscriptionTable).all().pipe(Effect.orDie),
    outbox: yield* database.db.select().from(McpEventOutboxTable).all().pipe(Effect.orDie),
  }).toEqual(before)
  expect((yield* subscribe(svc, parent, "session.progress", {
    cursor: initial.cursor, delivery: { mode: "webhook", url, secret: rotatedSecret },
  })).id).toBe(initial.id)
  yield* svc.dispatchOnce()
  expect(payloads()).toHaveLength(2)
  expect(payloads()[1].eventId).toBe(payloads()[0].eventId)
  verifySignature(deliveries()[1], [rotatedBytes, secretBytes])
}))

it.effect("subscription settlement interruption rolls back insertion and releases the mutation lane", () => Effect.gen(function* () {
  const { parent } = yield* seed("settlement_interrupt")
  const svc = yield* make
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const subscribing = yield* subscribe(svc, parent).pipe(
    Effect.provideService(Statement.CurrentTransformer, (statement) =>
      statement.compile()[0].startsWith('select "pruned_through" from "mcp_event_subscription"')
        ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(statement))
        : Effect.succeed(statement)),
    Effect.forkChild,
  )
  yield* Deferred.await(entered)
  yield* Fiber.interrupt(subscribing)
  expect(yield* svc.rows()).toMatchObject({ subscriptions: 0 })
  yield* subscribe(svc, parent)
  expect(yield* svc.rows()).toMatchObject({ subscriptions: 1, activeSubscriptions: 1 })
}))

for (const reason of ["authorization_unavailable", "grant_expired"] as const) {
  it.effect(`subscription settlement refuses ${reason} during metadata assembly`, () => Effect.gen(function* () {
    const { parent } = yield* seed(`settlement_${reason}`)
    const svc = yield* make
    const controller = new AbortController()
    grant.signal = controller.signal
    grant.expiresAt = 60_000
    const result = yield* subscribe(svc, parent).pipe(
      Effect.provideService(Statement.CurrentTransformer, (statement) => Effect.gen(function* () {
        if (statement.compile()[0].startsWith('select "pruned_through" from "mcp_event_subscription"')) {
          if (reason === "authorization_unavailable") controller.abort()
          if (reason === "grant_expired") yield* TestClock.adjust("60 seconds")
        }
        return statement
      })),
      Effect.result,
    )
    expect(result).toMatchObject({ _tag: "Failure", failure: {
      category: reason === "grant_expired" ? "unauthorized" : "unavailable", reason,
    } })
    expect(yield* svc.rows()).toMatchObject({ subscriptions: 0 })
    grant.signal = undefined
    grant.expiresAt = 30 * DAY
    yield* subscribe(svc, parent)
    expect(yield* svc.rows()).toMatchObject({ subscriptions: 1, activeSubscriptions: 1 })
  }))
}

it.effect("subscription settlement preserves disabled rows and rejects revoked or unavailable refreshes", () => Effect.gen(function* () {
  const { parent } = yield* seed("settlement_disabled")
  const svc = yield* make
  const active = yield* subscribe(svc, parent, "session.progress")
  for (const scope of ["revoked", "unavailable", "aborted", "expired"] as const) {
    grant.revoked = scope === "revoked"
    grant.available = scope !== "unavailable"
    grant.signal = scope === "aborted" ? AbortSignal.abort() : undefined
    grant.expiresAt = scope === "expired" ? 0 : 30 * DAY
    expect((yield* subscribe(svc, parent, "session.progress").pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* svc.rows()).toMatchObject({ subscriptions: 1, activeSubscriptions: 1 })
  }
  grant.revoked = false
  grant.available = true
  grant.signal = undefined
  grant.expiresAt = 30 * DAY
  expect((yield* subscribe(svc, parent, "session.progress")).id).toBe(active.id)
  yield* svc.unsubscribe({ context, subscription: {
    name: "session.progress", arguments: { session_id: parent, include_descendants: false }, delivery: { mode: "webhook", url },
  } })
  const database = yield* Database.Service
  const before = yield* database.db.select().from(McpEventSubscriptionTable).all().pipe(Effect.orDie)
  expect((yield* subscribe(svc, parent, "session.progress").pipe(Effect.exit))._tag).toBe("Failure")
  expect(yield* database.db.select().from(McpEventSubscriptionTable).all().pipe(Effect.orDie)).toEqual(before)
  expect(yield* svc.rows()).toMatchObject({ subscriptions: 1, activeSubscriptions: 0 })
  grant.id = "grt_replacement"
  expect((yield* subscribe(svc, parent, "session.progress")).id).not.toBe(active.id)
  expect(yield* svc.rows()).toMatchObject({ subscriptions: 2, activeSubscriptions: 1 })
}))

it.effect("subscription settlement isolates callback URLs and every exact authorization dimension", () => Effect.gen(function* () {
  const { parent } = yield* seed("settlement_scopes")
  const svc = yield* make
  const scopes = [
    { context, url, grantID: "grt_1" },
    { context, url: `${url}/distinct`, grantID: "grt_1" },
    { context: { ...context, principal: { ...context.principal, ownerID: "own_distinct" } }, url, grantID: "grt_1" },
    { context: { ...context, principal: { ...context.principal, deviceID: "dev_distinct" } }, url, grantID: "grt_1" },
    { context: { ...context, principal: { ...context.principal, clientID: "cli_distinct" } }, url, grantID: "grt_1" },
    { context: { ...context, epoch: "epoch_distinct" }, url, grantID: "grt_1" },
    { context, url, grantID: "grt_distinct" },
  ]
  const subscriptions = yield* Effect.forEach(scopes, (scope) => Effect.gen(function* () {
    grant.id = scope.grantID
    const input = { context: scope.context, subscription: {
      name: "session.progress" as const, arguments: { session_id: parent, include_descendants: false },
      delivery: { mode: "webhook" as const, url: scope.url, secret },
    } }
    const first = yield* svc.subscribe(input)
    expect((yield* svc.subscribe({ ...input, context: { ...input.context, requestID: "req_retry" } })).id).toBe(first.id)
    return first
  }))
  expect(new Set(subscriptions.map((item) => item.id)).size).toBe(scopes.length)
  expect(yield* svc.rows()).toMatchObject({ subscriptions: scopes.length, activeSubscriptions: scopes.length })
}))

it.effect("a partial fourteen-subscription attempt reconciles by identity and records safe outcomes", () => Effect.gen(function* () {
  const { parent, child } = yield* seed("partial_batch")
  const svc = yield* make
  const requested = McpEvents.Names.flatMap((name) => [parent, child].map((sessionID) => ({ name, sessionID })))
  const admitted = yield* Effect.forEach(requested.slice(0, 9), (item) => subscribe(svc, item.sessionID, item.name, {
    arguments: { session_id: item.sessionID, include_descendants: true },
  }))
  yield* TestClock.adjust("5 minutes")
  transportFailure = new McpEvents.Failure({ category: "callback_endpoint", reason: "timeout" })
  const failed = yield* subscribe(svc, requested[9].sessionID, requested[9].name, {
    arguments: { session_id: requested[9].sessionID, include_descendants: true },
  }).pipe(Effect.result)
  expect(failed).toMatchObject({ _tag: "Failure", failure: { category: "callback_endpoint", reason: "timeout" } })
  expect(yield* svc.rows()).toMatchObject({ subscriptions: 9, activeSubscriptions: 9 })
  transportFailure = undefined
  const reconciled = yield* Effect.forEach(requested, (item) => subscribe(svc, item.sessionID, item.name, {
    arguments: { include_descendants: true, session_id: item.sessionID },
  }))
  expect(reconciled.slice(0, 9).map((item) => item.id)).toEqual(admitted.map((item) => item.id))
  expect(new Set(reconciled.map((item) => item.id)).size).toBe(14)
  expect(yield* svc.rows()).toMatchObject({ subscriptions: 14, activeSubscriptions: 14 })
  for (const item of requested) {
    yield* svc.unsubscribe({ context, subscription: {
      name: item.name, arguments: { session_id: item.sessionID, include_descendants: true }, delivery: { mode: "webhook", url },
    } })
  }
  expect(yield* svc.rows()).toMatchObject({ subscriptions: 14, activeSubscriptions: 0 })
  const recorded = JSON.stringify(diagnostics)
  expect(recorded).toContain("MCP Events subscription active")
  expect(recorded).toContain(admitted[0].id)
  expect(recorded).toContain("MCP Events subscription failed")
  expect(recorded).toContain('"category":"callback_endpoint"')
  expect(recorded).toContain('"reason":"timeout"')
  expect(recorded).not.toContain(url)
  expect(recorded).not.toContain(secret)
}).pipe(Effect.provide(diagnosticLogger)))

it.effect("a rejected exact grant disables delivery with a safe reason and no implicit reactivation", () => Effect.gen(function* () {
  const { parent } = yield* seed("delivery_diagnostic")
  const svc = yield* make
  const subscription = yield* subscribe(svc, parent)
  yield* svc.capture({ type: "permission.asked", id: "diagnostic_source", data: { id: "per_diagnostic", sessionID: parent, action: "shell" } })
  grant.revoked = true
  yield* svc.dispatchOnce()
  grant.revoked = false
  yield* svc.dispatchOnce()
  expect(deliveries()).toEqual([])
  expect(yield* svc.rows()).toMatchObject({ subscriptions: 1, activeSubscriptions: 0 })
  const recorded = JSON.stringify(diagnostics)
  expect(recorded).toContain("MCP Events subscription disabled")
  expect(recorded).toContain(subscription.id)
  expect(recorded).toContain('"reason":"grant_revoked"')
  expect(recorded).not.toContain(url)
  expect(recorded).not.toContain(secret)
}).pipe(Effect.provide(diagnosticLogger)))

it.effect("an unexpected subscribe failure preserves its cause but records only a safe diagnostic", () => Effect.gen(function* () {
  const { parent } = yield* seed("unexpected_diagnostic")
  const svc = yield* make
  transportDefect = true
  const result = yield* svc.subscribe({ context: { ...context, requestID: `${url}?secret=${secret}` }, subscription: {
    name: "session.completed", arguments: { session_id: parent, include_descendants: true }, delivery: { mode: "webhook", url, secret },
  } }).pipe(Effect.exit)
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(Cause.squash(result.cause)).toBeInstanceOf(Error)
  expect(yield* svc.rows()).toMatchObject({ subscriptions: 0 })
  const recorded = JSON.stringify(diagnostics)
  expect(recorded).toContain("MCP Events subscription failed")
  expect(recorded).toContain('"reason":"service_unavailable"')
  expect(recorded).not.toContain("private transport cause")
  expect(recorded).not.toContain(url)
  expect(recorded).not.toContain(secret)
}).pipe(Effect.provide(diagnosticLogger)))

it.effect("every authorization or storage disable path records a safe terminal reason", () => Effect.gen(function* () {
  for (const reason of ["authorization_unavailable", "grant_expired", "secure_storage_unavailable"] as const) {
    const { parent } = yield* seed(`disable_${reason}`)
    const svc = yield* make
    const subscription = yield* subscribe(svc, parent)
    yield* svc.capture({ type: "permission.asked", id: `source_${reason}`, data: { id: `per_${reason}`, sessionID: parent, action: "shell" } })
    if (reason === "authorization_unavailable") {
      const controller = new AbortController()
      controller.abort()
      grant.signal = controller.signal
    }
    if (reason === "grant_expired") grant.expiresAt = 0
    if (reason === "secure_storage_unavailable") cannotDecrypt = true
    yield* svc.dispatchOnce()
    expect(deliveries()).toEqual([])
    expect(yield* svc.rows()).toMatchObject({ activeSubscriptions: 0 })
    const recorded = JSON.stringify(diagnostics)
    expect(recorded).toContain("MCP Events subscription disabled")
    expect(recorded).toContain(subscription.id)
    expect(recorded).toContain(`"reason":"${reason}"`)
    expect(recorded).not.toContain(url)
    expect(recorded).not.toContain(secret)
  }
}).pipe(Effect.provide(diagnosticLogger)))

it.effect("webhook failures record safe HTTP or transport outcomes without claiming a host wake", () => Effect.gen(function* () {
  const { parent } = yield* seed("http_diagnostic")
  const svc = yield* make
  const subscription = yield* subscribe(svc, parent)
  yield* svc.capture({ type: "permission.asked", id: "source_http_diagnostic", data: { id: "per_http_diagnostic", sessionID: parent, action: "shell" } })
  statuses = [503]
  yield* svc.dispatchOnce()
  expect(payloads()).toHaveLength(1)
  const recorded = JSON.stringify(diagnostics)
  expect(recorded).toContain("MCP Events webhook failed")
  expect(recorded).toContain(subscription.id)
  expect(recorded).toContain(payloads()[0].eventId)
  expect(recorded).toContain('"httpStatus":503')
  expect(recorded).toContain('"attempt":1')
  expect(recorded).not.toContain(url)
  expect(recorded).not.toContain(secret)
  expect(recorded).not.toContain("host woke")
}).pipe(Effect.provide(diagnosticLogger)))

it.effect("question-tool Forms keep native form IDs and do not synthesize question notifications", () => Effect.gen(function* () {
  const { parent } = yield* seed("question_form")
  const svc = yield* make
  yield* subscribe(svc, parent, "session.form.changed")
  yield* subscribe(svc, parent, "session.question.changed")
  yield* svc.capture({ type: "form.created", id: "form_source_created", data: {
    form: { id: "frm_question_fixture", sessionID: parent, metadata: { kind: "question" }, title: "private question", fields: [] },
  } })
  yield* svc.capture({ type: "form.replied", id: "form_source_replied", data: {
    id: "frm_question_fixture", sessionID: parent, answer: { q0: "private answer" },
  } })
  yield* svc.dispatchOnce()
  yield* svc.dispatchOnce()
  expect(payloads().map((item) => [item.name, item.data.state, item.data.request_id])).toEqual([
    ["session.form.changed", "pending", "frm_question_fixture"],
    ["session.form.changed", "resolved", "frm_question_fixture"],
  ])
  expect(JSON.stringify(payloads())).not.toContain("private question")
  expect(JSON.stringify(payloads())).not.toContain("private answer")
}))

it.effect("malformed callback verification responses fail with a safe challenge error", () => Effect.gen(function* () {
  const { parent } = yield* seed("malformed_challenge")
  const svc = yield* make
  for (const body of ["null", "[]", '"text"', "not-json", "{}", '{"challenge":42}']) {
    verificationBody = body
    const result = yield* subscribe(svc, parent).pipe(Effect.exit)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(Cause.squash(result.cause)).toMatchObject({ category: "callback_endpoint", reason: "challenge_failed" })
  }
  expect(yield* svc.rows()).toMatchObject({ subscriptions: 0 })
}))

it.effect("a grant revoked during callback verification cannot activate a subscription", () => Effect.gen(function* () {
  const { parent } = yield* seed("verification_revoked")
  const svc = yield* make
  revokeDuringVerification = true
  const result = yield* subscribe(svc, parent).pipe(Effect.result)
  expect(result).toMatchObject({ _tag: "Failure", failure: { category: "unauthorized", reason: "grant_revoked" } })
  expect(yield* svc.rows()).toMatchObject({ activeSubscriptions: 0 })
}))

it.effect("a delayed retry precedes later events from the same subscription", () => Effect.gen(function* () {
  const { parent } = yield* seed("retry_order")
  const svc = yield* make
  yield* subscribe(svc, parent)
  yield* svc.capture({ type: "permission.asked", id: "order_first", data: { id: "per_order", sessionID: parent, action: "read" } })
  statuses = [500]
  yield* svc.dispatchOnce()
  yield* svc.capture({ type: "permission.replied", id: "order_second", data: { requestID: "per_order", sessionID: parent, reply: "once" } })
  yield* svc.dispatchOnce()
  expect(payloads()).toHaveLength(1)
  yield* TestClock.adjust("5 seconds")
  yield* svc.dispatchOnce()
  yield* svc.dispatchOnce()
  expect(payloads().map((payload) => payload.data.state)).toEqual(["pending", "pending", "resolved"])
  expect(payloads()[0].eventId).toBe(payloads()[1].eventId)
}))

it.effect("unsubscribe ordered after admission cannot be undone by a slow verification", () => Effect.gen(function* () {
  const { parent } = yield* seed("unsubscribe_order")
  const svc = yield* make
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  verificationGate = { entered, release }
  const subscribing = yield* subscribe(svc, parent).pipe(Effect.forkChild)
  yield* Deferred.await(entered)
  const unsubscribing = yield* svc.unsubscribe({ context, subscription: {
    name: "session.permission.changed", arguments: { session_id: parent, include_descendants: false }, delivery: { mode: "webhook", url },
  } }).pipe(Effect.forkChild)
  yield* Effect.yieldNow
  yield* Deferred.succeed(release, undefined)
  yield* Fiber.join(subscribing)
  yield* Fiber.join(unsubscribing)
  expect(yield* svc.rows()).toMatchObject({ activeSubscriptions: 0 })
}))

it.effect("subscribe verifies once, is idempotent, and grants a finite 24h default capped by grant rules", () => Effect.gen(function* () {
  const { parent } = yield* seed("sub")
  const svc = yield* make
  expect(yield* svc.status()).toEqual({ available: true })
  expect((yield* svc.list()).events).toHaveLength(7)
  const first = yield* subscribe(svc, parent)
  expect(first.id).toMatch(/^sub_/)
  expect(first.refreshBefore).toBe(new Date(DAY).toISOString())
  expect(first.cursor).toBeNull()
  expect(first.truncated).toBe(false)
  expect(sent).toHaveLength(1)
  expect(JSON.parse(sent[0].body)).toMatchObject({ type: "verification" })
  expect(sent[0].headers["X-MCP-Subscription-Id"]).toBe(first.id)
  verifySignature(sent[0])
  const again = yield* svc.subscribe({ context, subscription: {
    name: "session.permission.changed", arguments: { include_descendants: false, session_id: parent }, delivery: { mode: "webhook", url, secret },
  } as never })
  expect(again.id).toBe(first.id)
  expect(sent).toHaveLength(1)
  expect(yield* svc.rows()).toMatchObject({ subscriptions: 1 })
  grant.expiresAt = 3_600_000
  expect((yield* subscribe(svc, parent, "session.progress")).refreshBefore).toBe(new Date(3_600_000).toISOString())
  grant.expiresAt = 30 * DAY
  expect((yield* subscribe(svc, parent, "session.completed", { ttlMs: 1_000 })).refreshBefore).toBe(new Date(60_000).toISOString())
  expect((yield* subscribe(svc, parent, "session.error", { ttlMs: null })).refreshBefore).toBe(new Date(DAY).toISOString())
}))

it.effect("validation and authorization run before any callback", () => Effect.gen(function* () {
  const { parent } = yield* seed("val")
  const svc = yield* make
  for (const subscription of [
    { name: "session.progress", arguments: { session_id: parent }, delivery: { mode: "webhook", url, secret: "whsec_" + Buffer.alloc(8).toString("base64") } },
    { name: "session.progress", arguments: { session_id: parent }, delivery: { mode: "webhook", url: "http://receiver.example.test/cb", secret } },
    { name: "session.progress", arguments: { session_id: "ses_missing" }, delivery: { mode: "webhook", url, secret } },
    { name: "nope", arguments: { session_id: parent }, delivery: { mode: "webhook", url, secret } },
  ]) {
    const exit = yield* svc.subscribe({ context, subscription } as never).pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.squash(exit.cause)).toMatchObject({ category: "invalid_params" })
  }
  challengeEcho = false
  const challenged = yield* subscribe(svc, parent).pipe(Effect.exit)
  expect(challenged._tag).toBe("Failure")
  if (challenged._tag === "Failure") expect(Cause.squash(challenged.cause)).toMatchObject({ category: "callback_endpoint", reason: "challenge_failed" })
  challengeEcho = true
  transportFailure = new McpEvents.Failure({ category: "callback_endpoint", reason: "timeout" })
  const timedOut = yield* subscribe(svc, parent).pipe(Effect.exit)
  if (timedOut._tag === "Failure") expect(Cause.squash(timedOut.cause)).toMatchObject({ reason: "timeout" })
  transportFailure = undefined
  grant.available = false
  expect(yield* svc.status()).toEqual({ available: false })
  const unavailable = yield* subscribe(svc, parent).pipe(Effect.exit)
  if (unavailable._tag === "Failure") expect(Cause.squash(unavailable.cause)).toMatchObject({ category: "unavailable" })
  expect(yield* svc.rows()).toMatchObject({ subscriptions: 0 })
  expect(deliveries()).toHaveLength(0)
}))

it.effect("delivers signed metadata with a stable event id, fresh attempt signatures, retries transient failures, and stops on 410/413", () => Effect.gen(function* () {
  const { parent } = yield* seed("deliver")
  const svc = yield* make
  yield* subscribe(svc, parent)
  statuses = [500]
  yield* svc.capture({ type: "permission.asked", id: "src_1", data: { id: "per_1", sessionID: parent, action: "shell", resources: ["private"] } })
  yield* svc.dispatchOnce()
  expect(deliveries()).toHaveLength(1)
  const firstAttempt = deliveries()[0]
  yield* svc.dispatchOnce()
  expect(deliveries()).toHaveLength(1)
  yield* TestClock.adjust("5 seconds")
  yield* svc.dispatchOnce()
  expect(deliveries()).toHaveLength(2)
  expect(payloads()[1].eventId).toBe(payloads()[0].eventId)
  expect(deliveries()[1].headers["webhook-timestamp"]).not.toBe(firstAttempt.headers["webhook-timestamp"])
  verifySignature(deliveries()[1])
  expect(payloads()[0]).toMatchObject({ name: "session.permission.changed", cursor: null, data: { session_id: parent, root_session_id: parent, state: "pending", request_id: "per_1" } })
  expect(JSON.stringify(payloads()[0])).not.toContain("private")

  for (const status of [410, 413]) {
    statuses = [status]
    yield* svc.capture({ type: "permission.asked", id: `src_${status}`, data: { id: `per_${status}`, sessionID: parent, action: "read" } })
    const before = deliveries().length
    yield* svc.dispatchOnce()
    yield* TestClock.adjust("1 hour")
    yield* svc.dispatchOnce()
    expect(deliveries()).toHaveLength(before + 1)
  }
}))

it.effect("each delivery rechecks the grant, aborts on an aborted signal, and disables on revocation or unsubscribe", () => Effect.gen(function* () {
  const { parent } = yield* seed("grant")
  const svc = yield* make
  yield* subscribe(svc, parent)
  yield* svc.capture({ type: "permission.asked", id: "src_g1", data: { id: "per_g1", sessionID: parent, action: "read" } })
  grant.signal = AbortSignal.abort()
  yield* svc.dispatchOnce()
  expect(deliveries()).toHaveLength(0)
  grant.signal = undefined
  grant.revoked = true
  yield* svc.dispatchOnce()
  expect(deliveries()).toHaveLength(0)
  expect(yield* svc.rows()).toMatchObject({ subscriptions: 1, activeSubscriptions: 0 })

  grant.revoked = false
  const other = yield* svc.subscribe({ context: otherContext, subscription: {
    name: "session.permission.changed", arguments: { session_id: parent }, delivery: { mode: "webhook", url, secret },
  } as never })
  expect(other.id).not.toBe("")
  yield* svc.unsubscribe({ context, subscription: { name: "session.permission.changed", arguments: { session_id: parent }, delivery: { mode: "webhook", url } } as never })
  yield* svc.capture({ type: "permission.asked", id: "src_g2", data: { id: "per_g2", sessionID: parent, action: "read" } })
  yield* svc.dispatchOnce()
  expect(deliveries()).toHaveLength(1)
  yield* svc.unsubscribe({ context: otherContext, subscription: { name: "session.permission.changed", arguments: { session_id: parent }, delivery: { mode: "webhook", url } } as never })
  yield* svc.capture({ type: "permission.asked", id: "src_g3", data: { id: "per_g3", sessionID: parent, action: "read" } })
  yield* svc.dispatchOnce()
  expect(deliveries()).toHaveLength(1)
}))

it.effect("descendant filtering uses the backend session tree and progress coalesces with dedupe", () => Effect.gen(function* () {
  const { parent, child } = yield* seed("tree")
  const svc = yield* make
  yield* subscribe(svc, parent, "session.progress")
  yield* svc.subscribe({ context, subscription: {
    name: "session.completed", arguments: { session_id: parent, include_descendants: true }, delivery: { mode: "webhook", url, secret },
  } as never })
  yield* svc.capture({ type: "session.execution.started", id: "exec_child", data: { sessionID: child } })
  yield* svc.capture({ type: "session.execution.started", id: "exec_child", data: { sessionID: child } })
  yield* svc.capture({ type: "session.work.completed", id: "work_child", data: { sessionID: child } })
  yield* svc.dispatchOnce()
  expect(payloads().map((payload) => payload.name)).toEqual(["session.completed"])
  expect(payloads()[0].data).toMatchObject({ session_id: child, root_session_id: parent, state: "completed" })

  yield* svc.capture({ type: "session.execution.started", id: "exec_p1", data: { sessionID: parent } })
  yield* svc.capture({ type: "session.execution.started", id: "exec_p2", data: { sessionID: parent } })
  yield* svc.dispatchOnce()
  expect(payloads().filter((payload) => payload.name === "session.progress")).toHaveLength(1)
  yield* TestClock.adjust("31 seconds")
  yield* svc.capture({ type: "session.execution.started", id: "exec_p3", data: { sessionID: parent } })
  yield* svc.dispatchOnce()
  expect(payloads().filter((payload) => payload.name === "session.progress")).toHaveLength(2)
}))

it.effect("replayable cursors resume without skipping, restart redelivers pending rows, and rotated secrets dual-sign", () => Effect.gen(function* () {
  const { parent } = yield* seed("replay")
  const svc = yield* make
  yield* subscribe(svc, parent, "session.progress")
  yield* svc.capture({ type: "session.execution.started", id: "exec_1", data: { sessionID: parent } })
  yield* svc.dispatchOnce()
  const cursor = payloads()[0].cursor
  expect(typeof cursor).toBe("string")
  yield* TestClock.adjust("31 seconds")
  yield* svc.capture({ type: "session.execution.started", id: "exec_2", data: { sessionID: parent } })
  const restarted = yield* make
  yield* restarted.dispatchOnce()
  expect(payloads()).toHaveLength(2)
  const secondId = payloads()[1].eventId
  const refreshed = yield* restarted.subscribe({ context, subscription: {
    name: "session.progress", arguments: { session_id: parent }, delivery: { mode: "webhook", url, secret: rotatedSecret }, cursor,
  } as never })
  expect(refreshed.truncated).toBe(false)
  sent.length = 0
  yield* restarted.dispatchOnce()
  expect(payloads()).toHaveLength(1)
  expect(payloads()[0].eventId).toBe(secondId)
  verifySignature(deliveries()[0], [rotatedBytes, secretBytes])

  const tampered = yield* restarted.subscribe({ context, subscription: {
    name: "session.progress", arguments: { session_id: parent }, delivery: { mode: "webhook", url, secret: rotatedSecret }, cursor: "cur_forged",
  } as never }).pipe(Effect.exit)
  expect(tampered._tag).toBe("Failure")
  if (tampered._tag === "Failure") expect(Cause.squash(tampered.cause)).toMatchObject({ category: "invalid_params", reason: "invalid_cursor" })
}))

it.effect("replay truncation follows pruned subscription history rather than global sequence gaps", () => Effect.gen(function* () {
  const { parent } = yield* seed("cursor_gap")
  const svc = yield* make
  const start = yield* subscribe(svc, parent, "session.progress", { ttlMs: 7 * DAY })
  yield* svc.capture({ type: "session.execution.started", id: "gap_start", data: { sessionID: parent } })
  yield* svc.dispatchOnce()
  const acknowledged = payloads()[0].cursor
  yield* TestClock.adjust("6 days")
  yield* subscribe(svc, parent, "session.error", { ttlMs: 7 * DAY })
  yield* svc.capture({ type: "session.execution.failed", id: "gap_other", data: { sessionID: parent } })
  yield* svc.dispatchOnce()
  yield* svc.capture({ type: "session.execution.succeeded", id: "gap_complete", data: { sessionID: parent } })
  yield* svc.dispatchOnce()
  yield* TestClock.adjust("2 days")
  yield* svc.dispatchOnce()
  expect((yield* subscribe(svc, parent, "session.progress", { cursor: acknowledged })).truncated).toBe(false)
  expect((yield* subscribe(svc, parent, "session.progress", { cursor: start.cursor })).truncated).toBe(true)
}))

it.effect("refresh preserves the acknowledged cursor after all outbox history is pruned", () => Effect.gen(function* () {
  const { parent } = yield* seed("cursor_empty")
  const svc = yield* make
  yield* subscribe(svc, parent, "session.progress", { ttlMs: 7 * DAY })
  yield* svc.capture({ type: "session.execution.started", id: "empty_start", data: { sessionID: parent } })
  yield* svc.dispatchOnce()
  const acknowledged = payloads()[0].cursor
  if (typeof acknowledged !== "string") throw new Error("Missing replay cursor")
  yield* TestClock.adjust("8 days")
  yield* svc.dispatchOnce()
  const refreshed = yield* subscribe(svc, parent, "session.progress", { cursor: acknowledged })
  expect(refreshed.truncated).toBe(false)
  expect(refreshed.cursor).toBe(acknowledged)
  expect((yield* subscribe(svc, parent, "session.progress", { cursor: refreshed.cursor })).truncated).toBe(false)
}))

it.effect("restart reconciles queued ephemeral pending attention to cancelled and expiry stops capture", () => Effect.gen(function* () {
  const { parent } = yield* seed("restart")
  const svc = yield* make
  yield* subscribe(svc, parent)
  yield* svc.capture({ type: "permission.asked", id: "src_r1", data: { id: "per_r1", sessionID: parent, action: "read" } })
  const restarted = yield* make
  yield* restarted.dispatchOnce()
  expect(payloads().map((payload) => payload.data.state)).toEqual(["pending", "cancelled"])
  yield* TestClock.adjust("25 hours")
  yield* restarted.capture({ type: "permission.asked", id: "src_r2", data: { id: "per_r2", sessionID: parent, action: "read" } })
  yield* restarted.dispatchOnce()
  expect(payloads()).toHaveLength(2)
}))

it.effect("restart cancels only the latest unresolved ephemeral attention, including delivered guardrails", () => Effect.gen(function* () {
  const { parent } = yield* seed("restart_states")
  const svc = yield* make
  yield* subscribe(svc, parent, "session.guardrail.changed")
  yield* subscribe(svc, parent)
  for (const id of ["grq_pending", "grq_done", "grq_deferred"]) {
    yield* svc.capture({ type: "guardrail.asked", id: `src_${id}`, data: { id, sessionID: parent } })
  }
  yield* svc.capture({ type: "guardrail.replied", id: "src_done", data: { requestID: "grq_done", sessionID: parent, reply: "once" } })
  yield* svc.capture({ type: "guardrail.deferred", id: "src_deferred", data: { requestID: "grq_deferred", sessionID: parent, itemID: "rev_guardrail" } })
  yield* svc.capture({ type: "permission.asked", id: "src_permission", data: { id: "per_deferred", sessionID: parent } })
  yield* svc.capture({ type: "permission.deferred", id: "src_per_deferred", data: { requestID: "per_deferred", sessionID: parent, itemID: "rev_permission" } })
  yield* svc.dispatchOnce()
  const before = deliveries().length
  const restarted = yield* make
  yield* restarted.dispatchOnce()
  expect(payloads().slice(before).map((row) => row.data)).toEqual([
    { session_id: parent, root_session_id: parent, state: "cancelled", request_id: "grq_pending", reason: "restart" },
  ])
  const again = yield* make
  yield* again.dispatchOnce()
  expect(deliveries()).toHaveLength(before + 1)
}))
