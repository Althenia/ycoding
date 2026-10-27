import { expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { eq } from "drizzle-orm"
import { Statement } from "effect/unstable/sql"
import { TestClock } from "effect/testing"
import { SessionReview } from "@ycoding-ai/schema/session-review"
import { SessionMessage } from "@ycoding-ai/schema/session-message"
import { Model } from "@ycoding-ai/schema/model"
import { SessionOrchestration } from "@ycoding-ai/schema/session-orchestration"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { EventTable } from "../src/event/sql"
import { SessionMcpEvents } from "../src/mcp-events/index"
import { makeSecretBox } from "../src/mcp-events/secret-box"
import { McpEventOutboxTable } from "../src/mcp-events/sql"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionEvent } from "../src/session/event"
import { SessionSchema } from "../src/session/schema"
import { SessionStore } from "../src/session/store"
import { SessionTable, SessionTaskTable } from "../src/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, SessionStore.node, EventRuntime.node]), []))
const sent: string[] = []
const make = Effect.gen(function* () {
  const database = yield* Database.Service
  const store = yield* SessionStore.Service
  return yield* SessionMcpEvents.make({
    db: database.db,
    authorization: {
      capabilities: Effect.succeed(true),
      resolve: () => Effect.succeed({ grantID: "grant_fixture", expiresAt: 86_400_000 }),
      check: () => Effect.succeed({ expiresAt: 86_400_000 }),
    },
    transport: { send: (input) => Effect.sync(() => {
      const body = JSON.parse(input.body) as { type?: string; challenge?: string }
      if (body.type === "verification") return { status: 200, body: JSON.stringify({ challenge: body.challenge }) }
      sent.push(input.body)
      return { status: 204, body: "" }
    }) },
    secretBox: makeSecretBox(Buffer.alloc(32, 4)),
    session: (id) => store.get(SessionSchema.ID.make(id)).pipe(Effect.map((info) => info === undefined ? undefined : { id: String(info.id), parentID: info.parentID })),
  })
})
const seed = Effect.gen(function* () {
  sent.length = 0
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
  const parent = SessionSchema.ID.make("ses_reconcile_parent")
  const child = SessionSchema.ID.make("ses_reconcile_child")
  yield* database.db.insert(SessionTable).values([
    { id: parent, project_id: Project.ID.global, directory: "/project", title: "Parent" },
    { id: child, parent_id: parent, project_id: Project.ID.global, directory: "/project", title: "Child" },
  ]).run().pipe(Effect.orDie)
  yield* database.db.insert(SessionTaskTable).values({
    session_id: child, parent_id: parent, parent_assistant_message_id: SessionMessage.ID.make("msg_parent"), tool_call_id: "call_child", input_id: SessionMessage.ID.make("msg_child"),
    description: "Fixture", agent: "fixture", model: Model.Ref.parse("fixture/fixture"), prompt_digest: "fixture", background: true, delivery: "steer", state: "running",
  }).run().pipe(Effect.orDie)
  return { database, events, parent, child }
})
const subscribe = (svc: SessionMcpEvents.TestInterface, sessionID: SessionSchema.ID, name: "session.question.changed" | "session.progress" = "session.question.changed") => svc.subscribe({
  context: { requestID: "req_fixture", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" }, epoch: "epoch_fixture" },
  subscription: { name, arguments: { session_id: sessionID, include_descendants: true }, delivery: { mode: "webhook", url: "https://receiver.example.test/cb", secret: "whsec_" + Buffer.alloc(32, 7).toString("base64") } },
})

it.effect("subscribe reads already-open durable recovery and child questions without replaying settled blockers", () => Effect.gen(function* () {
  const { database, events, parent, child } = yield* seed
  const recovery = SessionReview.ID.create()
  const settled = SessionReview.ID.create()
  for (const itemID of [recovery, settled]) yield* events.publish(SessionEvent.Review.Deferred, {
    sessionID: child, itemID, kind: "recovery", reason: "restart", origin: { requestID: "recovery_fixture" },
    payload: { type: "recovery", tools: [{ messageID: SessionMessage.ID.make("msg_fixture"), callID: "call_fixture", name: "shell" }] },
  })
  yield* events.publish(SessionEvent.Review.Decided, { sessionID: child, itemID: settled, decision: { kind: "recovery", choice: "stop" } })
  yield* events.publish(SessionEvent.Task.Updated, { sessionID: child, change: { type: "question_asked", question: { id: SessionOrchestration.QuestionID.make("qst_fixture"), text: "Private question", time: 0 } } })
  yield* TestClock.adjust("1 second")
  const svc = yield* make
  const first = yield* subscribe(svc, parent)
  expect((yield* subscribe(svc, parent)).id).toBe(first.id)
  const rows = yield* database.db.select().from(McpEventOutboxTable).all().pipe(Effect.orDie)
  expect(rows.map((row) => [row.item_id, row.request_id, row.attention?.kind])).toEqual([
    [recovery, "recovery_fixture", "recovery"], [null, "qst_fixture", "subagent_question"],
  ])
  expect(rows.every((row) => row.attention !== null && row.attention.actions.includes("respond") && !("human_required" in row.attention))).toBe(true)
  const restarted = yield* make
  yield* restarted.dispatchOnce()
  expect(sent).toHaveLength(2)
  expect(sent.join(" ")).not.toMatch(/Private|shell|msg_fixture|call_fixture/)
  expect((yield* database.db.select().from(McpEventOutboxTable).all().pipe(Effect.orDie)).some((row) => row.state === "cancelled")).toBe(false)
}))

it.effect("startup and refresh reconcile missed durable progress in order with occurrence timestamps and event dedupe", () => Effect.gen(function* () {
  const { database, events, parent, child } = yield* seed
  const svc = yield* make
  const subscription = yield* subscribe(svc, parent, "session.progress")
  const first = yield* events.publish(SessionEvent.Task.Updated, { sessionID: child, change: { type: "progressed", progress: { text: "Private first", time: 0 } } })
  const second = yield* events.publish(SessionEvent.Task.Updated, { sessionID: child, change: { type: "progressed", progress: { text: "Private second", time: 0 } } })
  yield* TestClock.adjust("1 second")
  const restarted = yield* make
  expect((yield* subscribe(restarted, parent, "session.progress")).id).toBe(subscription.id)
  const rows = yield* database.db.select().from(McpEventOutboxTable).all().pipe(Effect.orDie)
  expect(rows).toHaveLength(2)
  expect(rows.map((row) => row.dedupe_key)).toEqual([
    `${subscription.id}:session.progress:${first.id}:running`, `${subscription.id}:session.progress:${second.id}:running`,
  ])
  expect(rows.map((row) => row.time_created)).toEqual([0, 0])
  yield* restarted.dispatchOnce()
  expect(sent).toHaveLength(2)
  expect(sent.join(" ")).not.toContain("Private")
  yield* events.publish(SessionEvent.Task.Updated, { sessionID: child, change: { type: "progressed", progress: { text: "Private third", time: 1000 } } })
  yield* subscribe(restarted, parent, "session.progress")
  yield* restarted.dispatchOnce()
  expect(sent).toHaveLength(3)
}))

it.effect("descendant restore merges interleaved sibling occurrences and preserves each aggregate sequence", () => Effect.gen(function* () {
  const { database, events, parent, child } = yield* seed
  const sibling = SessionSchema.ID.make("ses_reconcile_sibling")
  yield* database.db.insert(SessionTable).values({ id: sibling, parent_id: parent, project_id: Project.ID.global, directory: "/project", title: "Sibling" }).run().pipe(Effect.orDie)
  const svc = yield* make
  const sub = yield* subscribe(svc, parent, "session.progress")
  const source = []
  yield* TestClock.adjust("1 second")
  for (const sessionID of [sibling, child, parent, sibling, child]) {
    source.push(yield* events.publish(SessionEvent.Execution.Started, { sessionID }))
    yield* TestClock.adjust("1 second")
  }
  const restored = yield* make
  yield* subscribe(restored, parent, "session.progress")
  const rows = yield* database.db.select().from(McpEventOutboxTable).all().pipe(Effect.orDie)
  expect(rows.map((row) => row.dedupe_key)).toEqual(source.map((event) => `${sub.id}:session.progress:${event.id}:running`))
  yield* database.db.delete(McpEventOutboxTable).run().pipe(Effect.orDie)
  yield* database.db.update(EventTable).set({ created: 500 }).where(eq(EventTable.id, source[3]!.id)).run().pipe(Effect.orDie)
  yield* make
  expect((yield* database.db.select().from(McpEventOutboxTable).all().pipe(Effect.orDie)).map((row) => row.dedupe_key))
    .toEqual([source[0], source[3], source[1], source[2], source[4]].map((event) => `${sub.id}:session.progress:${event!.id}:running`))
}))

for (const mode of ["startup", "refresh"] as const) it.effect(`${mode} historical reads release the writer and bound old pending source pages`, () => Effect.gen(function* () {
  const { database, events, parent, child } = yield* seed
  for (let index = 0; index < 101; index++) yield* events.publish(SessionEvent.Review.Deferred, {
    sessionID: child, itemID: SessionReview.ID.create(), kind: "recovery", reason: "restart", origin: { requestID: `recovery_${index}` },
    payload: { type: "recovery", tools: [{ messageID: SessionMessage.ID.make("msg_fixture"), callID: "call_fixture", name: "shell" }] },
  })
  yield* TestClock.adjust("1 second")
  const svc = yield* make
  yield* subscribe(svc, parent)
  yield* database.db.delete(McpEventOutboxTable).run().pipe(Effect.orDie)
  let reads = 0
  const restore = Effect.gen(function* () {
    if (mode === "startup") return yield* make.pipe(Effect.asVoid)
    yield* subscribe(svc, parent)
  })
  yield* restore.pipe(Effect.provideService(Statement.CurrentTransformer, (statement) => Effect.gen(function* () {
    const query = statement.compile()[0]
    if (query.startsWith('select "id", "aggregate_id", "seq", "created", "type", "data" from "event"')) {
      reads++
      expect((yield* Effect.serviceOption(database.db.$client.transactionService))._tag).toBe("None")
      expect(query).toContain("limit")
      const writer = yield* database.db.update(SessionTable).set({ title: "Concurrent write" }).where(eq(SessionTable.id, parent)).run().pipe(Effect.orDie, Effect.forkChild)
      yield* Fiber.join(writer)
    }
    return statement
  })))
  expect(reads).toBeGreaterThan(1)
  expect((yield* database.db.select().from(McpEventOutboxTable).all().pipe(Effect.orDie))).toHaveLength(101)
}))

it.effect("a partial reconciliation fails the response and an exact subscription retry fills only missing sources", () => Effect.gen(function* () {
  const { database, events, parent, child } = yield* seed
  for (const requestID of ["recovery_first", "recovery_second"]) yield* events.publish(SessionEvent.Review.Deferred, {
    sessionID: child, itemID: SessionReview.ID.create(), kind: "recovery", reason: "restart", origin: { requestID },
    payload: { type: "recovery", tools: [{ messageID: SessionMessage.ID.make("msg_fixture"), callID: "call_fixture", name: "shell" }] },
  })
  yield* TestClock.adjust("1 second")
  const svc = yield* make
  let writes = 0
  const failed = yield* subscribe(svc, parent).pipe(
    Effect.provideService(Statement.CurrentTransformer, (statement) => statement.compile()[0].startsWith('insert into "mcp_event_outbox"') && ++writes === 2
      ? Effect.die(new Error("Synthetic reconciliation failure")) : Effect.succeed(statement)),
    Effect.exit,
  )
  expect(failed._tag).toBe("Failure")
  expect(yield* svc.rows()).toMatchObject({ subscriptions: 1, outbox: 1 })
  const retried = yield* subscribe(svc, parent)
  const rows = yield* database.db.select().from(McpEventOutboxTable).all().pipe(Effect.orDie)
  expect(rows.map((row) => row.request_id)).toEqual(["recovery_first", "recovery_second"])
  expect(rows.every((row) => row.subscription_id === retried.id)).toBe(true)
}))
