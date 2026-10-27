import { expect } from "bun:test"
import { getEventListeners } from "node:events"
import { Effect, Layer, Logger } from "effect"
import { TestClock } from "effect/testing"
import { Form } from "../src/form"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Permission } from "@ycoding-ai/schema/permission"
import { Question } from "@ycoding-ai/schema/question"
import { SessionReview } from "@ycoding-ai/schema/session-review"
import { SessionMessage } from "@ycoding-ai/schema/session-message"
import { Model } from "@ycoding-ai/schema/model"
import { Database } from "../src/database/database"
import { Statement } from "effect/unstable/sql"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { EventTable } from "../src/event/sql"
import { Config } from "../src/config"
import { Decision } from "../src/decision"
import { SessionMcpEvents } from "../src/mcp-events/index"
import { McpEventsHttp } from "../src/mcp-events/protected-http"
import { McpEventsSecretBox } from "../src/mcp-events/secret-box"
import { McpEventOutboxTable } from "../src/mcp-events/sql"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionEvent } from "../src/session/event"
import { SessionSchema } from "../src/session/schema"
import { SessionTable, SessionTaskTable } from "../src/session/sql"
import { testEffect } from "./lib/effect"

const sent: string[] = []
const logs: unknown[] = []
let failTransport = false
let grantSignal = new AbortController().signal
const it = testEffect(AppNodeBuilder.build(LayerNode.group([SessionMcpEvents.node, Database.node, EventRuntime.node, Form.node]), [
  [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({}) })]) })],
  [Decision.node, Layer.mock(Decision.Service, { evaluate: () => Effect.die("Unexpected decision assessment") })],
  [SessionMcpEvents.Authorization.node, Layer.succeed(SessionMcpEvents.Authorization.Service, SessionMcpEvents.Authorization.Service.of({
    capabilities: Effect.succeed(true),
    resolve: () => Effect.succeed({ grantID: "grant_fixture", expiresAt: 86_400_000 }),
    check: () => Effect.succeed({ expiresAt: 86_400_000, signal: grantSignal }),
  }))],
  [McpEventsHttp.node, McpEventsHttp.layerWith({ send: (input) => Effect.sync(() => {
    if (failTransport) throw new Error("private-transport-secret")
    const body = JSON.parse(input.body) as { type?: string; challenge?: string }
    if (body.type === "verification") return { status: 200, body: JSON.stringify({ challenge: body.challenge }) }
    sent.push(input.body)
    return { status: 204, body: "" }
  }) })],
  [McpEventsSecretBox.node, McpEventsSecretBox.layerWith(McpEventsSecretBox.makeSecretBox(Buffer.alloc(32, 4)))],
]).pipe(Layer.provide(Logger.layer([Logger.make((entry) => { logs.push(entry.message) })], { mergeWithExisting: false }))))

const seed = Effect.gen(function* () {
  sent.length = 0
  logs.length = 0
  failTransport = false
  grantSignal = new AbortController().signal
  const database = yield* Database.Service
  const service = yield* SessionMcpEvents.Service
  yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
  const parent = SessionSchema.ID.make("ses_node_parent")
  const child = SessionSchema.ID.make("ses_node_child")
  yield* database.db.insert(SessionTable).values({ id: parent, project_id: Project.ID.global, directory: "/project", title: "Parent" }).run().pipe(Effect.orDie)
  yield* database.db.insert(SessionTable).values({ id: child, parent_id: parent, project_id: Project.ID.global, directory: "/project", title: "Child" }).run().pipe(Effect.orDie)
  for (const name of ["session.guardrail.changed", "session.permission.changed", "session.question.changed", "session.form.changed"] as const) {
    yield* service.subscribe({
      context: { requestID: "req_fixture", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" }, epoch: "epoch_fixture" },
      subscription: { name, arguments: { session_id: parent, include_descendants: true }, delivery: { mode: "webhook", url: "https://receiver.example.test/cb", secret: "whsec_" + Buffer.alloc(32, 7).toString("base64") } },
    })
  }
  return { database, events: yield* EventRuntime.Service, parent, child }
})

it.effect("eager node captures real ephemeral guardrail, permission, question and form events and dispatches only metadata", () => Effect.gen(function* () {
  const { database, events, parent, child } = yield* seed
  const requestID = Guardrail.RequestID.create("grq_node")
  yield* events.publish(Guardrail.Event.Asked, { id: requestID, rootSessionID: parent, sessionID: child, action: "shell", resources: ["private-command"], ruleIDs: ["standard.review.outside"], reason: "private-reason", standard: true })
  yield* events.publish(Guardrail.Event.Replied, { rootSessionID: parent, sessionID: child, requestID, reply: "reject" })
  for (const decision of ["allow", "deny", "cap_exceeded", "ask"] as const) {
    yield* events.publish(Guardrail.Event.Decided, { rootSessionID: parent, sessionID: child, action: "shell", ruleIDs: [], decision })
  }
  const permissionID = Permission.ID.create("per_node")
  yield* events.publish(Permission.Event.Asked, { id: permissionID, sessionID: child, action: "shell", resources: ["private-command"] })
  yield* events.publish(Permission.Event.Replied, { sessionID: child, requestID: permissionID, reply: "once" })
  const questionID = Question.ID.make("que_node")
  yield* events.publish(Question.Event.Asked, { id: questionID, sessionID: child, questions: [] })
  yield* events.publish(Question.Event.TimedOut, { sessionID: child, requestID: questionID })
  const formID = Form.ID.create("frm_node")
  yield* events.publish(Form.Event.Created, { form: { id: formID, sessionID: child, title: "private-title", fields: [{ key: "value", type: "string" }] } })
  yield* events.publish(Form.Event.Cancelled, { sessionID: child, id: formID })
  const rows = yield* database.db.select().from(McpEventOutboxTable).all().pipe(Effect.orDie)
  expect(rows.map((row) => [row.name, row.state, row.reason])).toEqual([
    ["session.guardrail.changed", "pending", null], ["session.guardrail.changed", "resolved", "reject"],
    ["session.guardrail.changed", "resolved", "allow"], ["session.guardrail.changed", "resolved", "deny"],
    ["session.guardrail.changed", "resolved", "cap_exceeded"], ["session.guardrail.changed", "pending", "ask"],
    ["session.permission.changed", "pending", null], ["session.permission.changed", "resolved", "once"],
    ["session.question.changed", "pending", null], ["session.question.changed", "cancelled", "timed_out"],
    ["session.form.changed", "pending", null], ["session.form.changed", "cancelled", null],
  ])
  expect(rows.every((row) => row.session_id === child && row.root_session_id === parent)).toBe(true)
  yield* TestClock.adjust("1 second")
  expect(sent).toHaveLength(12)
  expect(sent.join(" ")).not.toContain("private-")
}))

it.effect("durable review settlements resolve the stored child item and form kind without a family field", () => Effect.gen(function* () {
  const { database, events, child } = yield* seed
  const itemID = SessionReview.ID.create()
  const requestID = Guardrail.RequestID.create("grq_deferred")
  yield* events.publish(SessionEvent.Review.Deferred, { sessionID: child, itemID, kind: "guardrail", reason: "disabled", origin: { requestID }, payload: {
    type: "guardrail", action: "shell", resources: ["private-command"], ruleIDs: [], reason: "private-reason", hardReview: false, directories: [], fingerprint: SessionReview.Fingerprint.make("a".repeat(64)), requestID,
  } })
  yield* events.publish(Guardrail.Event.Deferred, { rootSessionID: SessionSchema.ID.make("ses_node_parent"), sessionID: child, requestID, itemID })
  yield* events.publish(SessionEvent.Review.Decided, { sessionID: child, itemID, decision: { kind: "guardrail", reply: "once" } })
  const formItem = SessionReview.ID.create()
  yield* events.publish(SessionEvent.Review.Deferred, { sessionID: child, itemID: formItem, kind: "question", reason: "free_text", origin: { requestID: "frm_deferred" }, payload: { type: "form", title: "private-title", fields: [{ key: "value", type: "string" }] } })
  yield* events.publish(SessionEvent.Review.Withdrawn, { sessionID: child, itemID: formItem, reason: "reverted" })
  yield* events.publish(SessionEvent.Review.Decided, { sessionID: child, itemID: SessionReview.ID.create(), decision: { kind: "guardrail", reply: "reject" } })
  const rows = yield* database.db.select().from(McpEventOutboxTable).all().pipe(Effect.orDie)
  expect(rows.map((row) => [row.name, row.state, row.request_id, row.item_id])).toEqual([
    ["session.guardrail.changed", "deferred", requestID, itemID],
    ["session.guardrail.changed", "deferred", requestID, itemID],
    ["session.guardrail.changed", "resolved", requestID, itemID],
    ["session.form.changed", "deferred", "frm_deferred", formItem],
    ["session.form.changed", "cancelled", "frm_deferred", formItem],
  ])
  expect(rows[0]!.dedupe_key).not.toBe(rows[1]!.dedupe_key)
  expect(rows.every((row) => row.session_id === child && row.root_session_id === "ses_node_parent")).toBe(true)
}))

it.effect("dispatch defects expose unavailable status with one safe diagnostic until recovery", () => Effect.gen(function* () {
  const { events, child } = yield* seed
  const service = yield* SessionMcpEvents.Service
  yield* events.publish(Permission.Event.Asked, { sessionID: child, id: Permission.ID.create("per_fault"), action: "read", resources: [] })
  failTransport = true
  yield* TestClock.adjust("2 seconds")
  expect(yield* service.status()).toEqual({ available: false })
  expect(logs).toEqual([["MCP Events dispatch failed"]])
  expect(JSON.stringify(logs)).not.toContain("private-transport-secret")
  expect(getEventListeners(grantSignal, "abort")).toHaveLength(0)
  failTransport = false
  yield* TestClock.adjust("1 second")
  expect(yield* service.status()).toEqual({ available: true })
  expect(sent).toHaveLength(1)
  expect(getEventListeners(grantSignal, "abort")).toHaveLength(0)
}))

it.effect("ephemeral deferrals preserve each domain's real request and review item fields", () => Effect.gen(function* () {
  const { database, events, child } = yield* seed
  const itemID = SessionReview.ID.create()
  const permissionID = Permission.ID.create("per_sleep")
  const questionID = Question.ID.make("que_sleep")
  const formID = Form.ID.create("frm_sleep")
  yield* events.publish(Permission.Event.Asked, { id: permissionID, sessionID: child, action: "read", resources: [] })
  yield* events.publish(Permission.Event.Deferred, { requestID: permissionID, sessionID: child, itemID })
  yield* events.publish(Question.Event.Asked, { id: questionID, sessionID: child, questions: [] })
  yield* events.publish(Question.Event.Deferred, { requestID: questionID, sessionID: child, itemID })
  yield* events.publish(Form.Event.Created, { form: { id: formID, sessionID: child, title: "private-title", fields: [{ key: "value", type: "string" }] } })
  yield* events.publish(Form.Event.Deferred, { id: formID, sessionID: child, itemID })
  const rows = yield* database.db.select().from(McpEventOutboxTable).all().pipe(Effect.orDie)
  expect(rows.map((row) => [row.name, row.state, row.request_id, row.item_id])).toEqual([
    ["session.permission.changed", "pending", permissionID, null], ["session.permission.changed", "deferred", permissionID, itemID],
    ["session.question.changed", "pending", questionID, null], ["session.question.changed", "deferred", questionID, itemID],
    ["session.form.changed", "pending", formID, null], ["session.form.changed", "deferred", formID, itemID],
  ])
}))

it.effect("durable blocker creation and outbox insertion commit together before publication returns", () => Effect.gen(function* () {
  const { database, events, child } = yield* seed
  const itemID = SessionReview.ID.create()
  const data = { sessionID: child, itemID, kind: "recovery" as const, reason: "restart" as const, origin: { requestID: "recovery_atomic" }, payload: {
    type: "recovery" as const, tools: [{ messageID: SessionMessage.ID.make("msg_atomic"), callID: "call_atomic", name: "shell" }],
  } }
  const failed = yield* events.publish(SessionEvent.Review.Deferred, data).pipe(
    Effect.provideService(Statement.CurrentTransformer, (statement) => statement.compile()[0].startsWith('insert into "mcp_event_outbox"')
      ? Effect.die(new Error("Synthetic outbox failure")) : Effect.succeed(statement)),
    Effect.exit,
  )
  expect(failed._tag).toBe("Failure")
  expect(yield* database.db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([])
  expect(yield* database.db.select().from(McpEventOutboxTable).all().pipe(Effect.orDie)).toEqual([])
  yield* events.publish(SessionEvent.Review.Deferred, data)
  expect((yield* database.db.select().from(McpEventOutboxTable).all().pipe(Effect.orDie)).map((row) => [row.state, row.attention?.kind])).toEqual([["deferred", "recovery"]])
}))

it.effect("each managed progress occurrence is durable immediately and raw progress text is excluded", () => Effect.gen(function* () {
  const { database, events, parent, child } = yield* seed
  yield* database.db.insert(SessionTaskTable).values({
    session_id: child, parent_id: parent, parent_assistant_message_id: SessionMessage.ID.make("msg_parent"), tool_call_id: "call_child", input_id: SessionMessage.ID.make("msg_child"),
    description: "Fixture", agent: "fixture", model: Model.Ref.parse("fixture/fixture"), prompt_digest: "fixture", background: true, delivery: "steer", state: "running",
  }).run().pipe(Effect.orDie)
  const service = yield* SessionMcpEvents.Service
  yield* service.subscribe({ context: { requestID: "req_progress", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" }, epoch: "epoch_fixture" }, subscription: {
    name: "session.progress", arguments: { session_id: parent, include_descendants: true }, delivery: { mode: "webhook", url: "https://receiver.example.test/cb", secret: "whsec_" + Buffer.alloc(32, 7).toString("base64") },
  } })
  for (const text of ["Private first", "Private second"]) yield* events.publish(SessionEvent.Task.Updated, { sessionID: child, change: { type: "progressed", progress: { text, time: 0 } } })
  const rows = yield* database.db.select().from(McpEventOutboxTable).all().pipe(Effect.orDie)
  expect(rows.map((row) => row.state)).toEqual(["running", "running"])
  expect(new Set(rows.map((row) => row.dedupe_key)).size).toBe(2)
  yield* TestClock.adjust("1 second")
  expect(sent).toHaveLength(2)
  expect(sent.join(" ")).not.toContain("Private")
}))

it.effect("composed node observes native Forms created before the first MCP subscription", () => Effect.gen(function* () {
  const database = yield* Database.Service
  const forms = yield* Form.Service
  yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
  const sessionID = SessionSchema.ID.make("ses_native_before_subscribe")
  yield* database.db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "Fixture" }).run().pipe(Effect.orDie)
  const pending = yield* forms.create({ sessionID, title: "Private pending", fields: [{ key: "value", type: "string" }] })
  const settled = yield* forms.create({ sessionID, title: "Private settled", fields: [{ key: "value", type: "string" }] })
  yield* forms.cancel(settled.id)
  const svc = yield* SessionMcpEvents.Service
  const input = { context: { requestID: "req_native", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" }, epoch: "epoch_fixture" }, subscription: {
    name: "session.form.changed" as const, arguments: { session_id: sessionID, include_descendants: false }, delivery: { mode: "webhook" as const, url: "https://receiver.example.test/cb", secret: "whsec_" + Buffer.alloc(32, 7).toString("base64") },
  } }
  yield* svc.subscribe(input)
  yield* svc.subscribe(input)
  expect((yield* database.db.select().from(McpEventOutboxTable).all().pipe(Effect.orDie)).map((row) => [row.request_id, row.state])).toEqual([[pending.id, "pending"]])
  yield* forms.cancel(pending.id)
  yield* svc.subscribe(input)
  expect((yield* database.db.select().from(McpEventOutboxTable).all().pipe(Effect.orDie)).map((row) => row.state)).toEqual(["pending", "cancelled"])
}))
