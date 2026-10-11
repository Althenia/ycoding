import { describe, expect } from "bun:test"
import { Context, DateTime, Effect, Fiber, Layer, LayerMap, Schema, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import path from "path"
import { Message, SystemPart } from "@ycoding-ai/ai"
import type { SessionHooks } from "@ycoding-ai/plugin/effect/session"
import { Money } from "@ycoding-ai/schema/money"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { makeGlobalNode } from "@ycoding-ai/core/effect/app-node"
import { Database } from "@ycoding-ai/core/database/database"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { Location } from "@ycoding-ai/core/location"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Agent } from "@ycoding-ai/core/agent"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Job } from "@ycoding-ai/core/job"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Session } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionOrchestrationNotifier } from "@ycoding-ai/core/session/orchestration-notifier"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionOrchestrationIdentity } from "@ycoding-ai/core/session/orchestration-identity"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionTask } from "@ycoding-ai/core/session/task"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionRunner } from "@ycoding-ai/core/session/runner"
import { SessionCompactionExecution } from "@ycoding-ai/core/session/compaction-execution"
import { SessionGoal } from "@ycoding-ai/core/session/goal"
import { Shell } from "@ycoding-ai/core/shell"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { SessionPendingTable, SessionTable, SessionTaskNotificationTable, SessionTaskTable } from "@ycoding-ai/core/session/sql"
import { PluginRegistry } from "@ycoding-ai/core/plugin"
import { PluginHooks } from "@ycoding-ai/core/plugin/hooks"
import { PluginHost } from "@ycoding-ai/core/plugin/host"
import { PluginRuntime } from "@ycoding-ai/core/plugin/runtime"
import { Permission } from "@ycoding-ai/core/permission"
import { Question } from "@ycoding-ai/core/question"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { SubagentTool } from "@ycoding-ai/core/tool/subagent"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SubagentControlTool } from "@ycoding-ai/core/tool/subagent-control"
import { SubagentReportTool } from "@ycoding-ai/core/tool/subagent-report"
import { ToolHooks } from "@ycoding-ai/core/tool/hooks"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { Hash } from "@ycoding-ai/core/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, settleTool, toolIdentity, waitForTool } from "./lib/tool"
import { fixtureModels } from "./lib/models"
import { eq, sql } from "drizzle-orm"

const childText = "child final response"
const childModel = CatalogModel.Ref.make({ id: CatalogModel.ID.make("child"), providerID: Provider.ID.make("test") })
const parentModel = CatalogModel.Ref.make({ id: CatalogModel.ID.make("parent"), providerID: Provider.ID.make("test") })
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const executionWakes: Session.ID[] = []
const executionInterrupts: Session.ID[] = []
const notificationDeliveredOnWake: boolean[] = []

const outputSessionID = (value: unknown) => Schema.decodeUnknownSync(SubagentTool.Output)(value).sessionID

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const events = yield* EventRuntime.Service
      const store = yield* SessionStore.Service
      const db = (yield* Database.Service).db
      const completed = new Set<Session.ID>()
      const complete = Effect.fn("SubagentTest.complete")(function* (sessionID: Session.ID) {
        if (completed.has(sessionID)) return
        const session = yield* store.get(sessionID)
        if (session?.title.includes("fail")) {
          yield* new SessionRunnerModel.ModelNotSelectedError({ sessionID })
          return
        }
        if (session?.title.includes("hold")) return yield* Effect.never
        completed.add(sessionID)
        const assistantMessageID = SessionMessage.ID.create()
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: Agent.ID.make("reviewer"),
          model: childModel,
        })
        yield* events.publish(SessionEvent.Text.Started, {
          sessionID,
          assistantMessageID,
          ordinal: 0,
        })
        yield* events.publish(SessionEvent.Text.Ended, {
          sessionID,
          assistantMessageID,
          ordinal: 0,
          text: childText,
        })
        yield* events.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens,
        })
      })
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        resume: complete,
        wake: (sessionID) =>
          Effect.gen(function* () {
            executionWakes.push(sessionID)
            const rows = yield* db
              .select({ delivered: SessionTaskNotificationTable.delivered })
              .from(SessionTaskNotificationTable)
              .where(eq(SessionTaskNotificationTable.parent_id, sessionID))
              .all()
              .pipe(Effect.orDie)
            if (rows.length > 0) notificationDeliveredOnWake.push(rows.every((row) => row.delivered))
          }),
        interrupt: (sessionID) => Effect.sync(() => void executionInterrupts.push(sessionID)),
        awaitIdle: (sessionID) => complete(sessionID).pipe(Effect.exit, Effect.asVoid),
        withTransition: (_sessionID, effect) => effect,
      })
    }),
  ),
  deps: [Database.node, EventRuntime.node, SessionStore.node],
})

const subagentLayer = (database = Database.node) => AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    EventRuntime.node,
    SessionAutonomy.node,
    SessionStore.node,
    Job.node,
    ToolOutputStore.cleanupNode,
    Session.node,
    SessionExecution.node,
    SessionOrchestrationNotifier.node,
    PluginHooks.node,
    ToolHooks.node,
    PluginRuntime.node,
    PluginRuntime.providerNode,
    LocationServiceMap.node,
  ]),
  [[Database.node, database], [SessionExecution.node, executionNode], fixtureModels],
)

const layer = subagentLayer()
const it = testEffect(layer)

const jobStartupFailureNode = makeGlobalNode({
  service: Job.Service,
  layer: Layer.mock(Job.Service, {
    start: () => Effect.die(new Error("job startup failed")),
  }),
  deps: [],
})

const startupFailureIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventRuntime.node,
      Job.node,
      ToolOutputStore.cleanupNode,
      Session.node,
      SessionExecution.node,
      SessionOrchestrationNotifier.node,
      PluginHooks.node,
      ToolHooks.node,
      PluginRuntime.node,
      PluginRuntime.providerNode,
      LocationServiceMap.node,
    ]),
    [
      [SessionExecution.node, executionNode],
      [Job.node, jobStartupFailureNode],
      fixtureModels,
    ],
  ),
)

const withSubagent = (location: Location.Ref) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    yield* PluginSupervisor.Service.use((supervisor) => supervisor.flush).pipe(Effect.provide(locations.get(location)))
    yield* Agent.Service.use((agents) =>
      agents.transform((draft) => {
        // The caller identity used by executeTool; subagent permission asserts against it.
        draft.update(toolIdentity.agent, (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
        })
        draft.update(Agent.ID.make("reviewer"), (agent) => {
          agent.mode = "subagent"
          agent.model = childModel
        })
        draft.update(Agent.ID.make("fallback"), (agent) => {
          agent.mode = "subagent"
        })
        draft.update(Agent.ID.make("primary"), (agent) => {
          agent.mode = "primary"
        })
      }),
    ).pipe(Effect.provide(locations.get(location)))
    yield* Catalog.Service.use((catalog) =>
      catalog.transform((draft) => {
        draft.provider.update(Provider.ID.make("test"), (provider) => {
          provider.package = Provider.aisdk("@ai-sdk/openai")
        })
        draft.model.update(Provider.ID.make("test"), childModel.id, (model) => {
          model.variants.push({ id: CatalogModel.VariantID.make("high") })
        })
        draft.model.update(Provider.ID.make("test"), parentModel.id, () => {})
      }),
    ).pipe(Effect.provide(locations.get(location)))
  })

describe("SubagentTool", () => {
  it.live("preserves restart loss, queue reactivation, new launches, completion notices, and durable replay", () =>
    Effect.acquireRelease(Effect.promise(() => tmpdir()), (dir) => Effect.promise(() => dir[Symbol.asyncDispose]())).pipe(
      Effect.flatMap((dir) => Effect.gen(function* () {
        const boot = subagentLayer(Database.configured({ path: path.join(dir.path, "restart.db") }))
        const child = yield* Effect.gen(function* () {
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location: { directory: AbsolutePath.make(dir.path) }, model: parentModel })
          yield* withSubagent(parent.location)
          const prepared = yield* SessionOrchestration.preflight(parent, { agent: Agent.ID.make("reviewer"), caller: toolIdentity.agent })
            .pipe(Effect.provide((yield* LocationServiceMap.Service).get(parent.location)))
          const orchestration = (yield* PluginRuntime.Service).orchestration
          return yield* orchestration.launch({ parentID: parent.id, parentAssistantMessageID: SessionMessage.ID.make("msg_restart_parent"),
            toolCallID: "restart", agent: Agent.ID.make("reviewer"), description: "restart child", prompt: "initial", background: true, prepared })
        }).pipe(Effect.provide(boot.pipe(Layer.fresh)), Effect.scoped)
        const wakes = executionWakes.length

        yield* Effect.gen(function* () {
          const sessions = yield* Session.Service
          const db = (yield* Database.Service).db
          const events = yield* EventRuntime.Service
          const orchestration = (yield* PluginRuntime.Service).orchestration
          expect((yield* orchestration.get(child.parentID, child.sessionID)).state).toBe("lost")
          const notifier = yield* SessionOrchestrationNotifier.Service
          yield* notifier.dispatch
          expect(executionWakes.slice(wakes)).toEqual([])
          expect(yield* sessions.pending(child.parentID)).toEqual([])
          expect((yield* db.select().from(SessionTaskNotificationTable).all().pipe(Effect.orDie))).toMatchObject([{ type: "lost", delivered: false }])
          expect(yield* SessionTask.lostSessions(db)).toEqual(new Set([child.parentID]))
          const outstanding = yield* sessions.outstanding()
          expect(outstanding.sessions.has(child.parentID)).toBe(true)
          expect(outstanding.lost).toEqual(new Set([child.parentID]))
          expect((yield* db.select().from(EventTable).all().pipe(Effect.orDie)).filter((row) => row.type === "session.execution.started.1" || row.type === "session.provider.request.recorded.1")).toEqual([])
          const parent = yield* sessions.get(child.parentID)
          yield* withSubagent(parent.location)
          const sent = yield* orchestration.send({ parentID: parent.id, childID: child.sessionID,
            messageID: SessionMessage.ID.make("msg_restart_queue"), text: "finish", delivery: "queue" })
          expect(sent.state).toBe("running")
          yield* SessionTask.reconcileStaleTasks(db)
          expect((yield* orchestration.get(parent.id, child.sessionID)).state).toBe("running")
          const locations = yield* LocationServiceMap.Service
          yield* locations.invalidate(parent.location)
          yield* withSubagent(parent.location)
          expect((yield* orchestration.get(parent.id, child.sessionID)).state).toBe("running")
          const prepared = yield* SessionOrchestration.preflight(parent, { agent: Agent.ID.make("reviewer"), caller: toolIdentity.agent })
            .pipe(Effect.provide(locations.get(parent.location)))
          const fresh = yield* orchestration.launch({ parentID: parent.id, parentAssistantMessageID: SessionMessage.ID.make("msg_restart_fresh"),
            toolCallID: "fresh", agent: Agent.ID.make("reviewer"), description: "fresh child", prompt: "new", background: true, prepared })
          yield* SessionTask.reconcileStaleTasks(db)
          expect((yield* orchestration.get(parent.id, fresh.sessionID)).state).toBe("running")

          const runner = Layer.succeed(SessionRunner.Service, SessionRunner.Service.of({ drain: ({ sessionID }) => Effect.gen(function* () {
            yield* SessionPending.promoteSteers(db, events, sessionID)
            yield* SessionPending.promoteNextQueued(db, events, sessionID)
            const declarationID = SessionMessage.ID.create()
            yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: declarationID, agent: Agent.ID.make("reviewer"), model: childModel })
            yield* events.publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID: declarationID, callID: "complete", name: "task_complete" })
            yield* events.publish(SessionEvent.Tool.Called, { sessionID, assistantMessageID: declarationID, callID: "complete", input: {}, executed: false })
            const registry = yield* ToolRegistry.Service.pipe(Effect.provide(locations.get(parent.location)))
            const result = yield* settleTool(registry, { sessionID, ...toolIdentity,
              call: { type: "tool-call", id: "complete", name: "task_complete", input: {} } })
            expect(result.output?.structured).toEqual({ recorded: true })
            yield* events.publish(SessionEvent.Tool.Success, { sessionID, assistantMessageID: declarationID, callID: "complete", structured: { recorded: true }, content: [], executed: false })
            yield* events.publish(SessionEvent.Step.Ended, { sessionID, assistantMessageID: declarationID, finish: "tool-calls", tokens, cost: Money.USD.zero })
            const assistantMessageID = SessionMessage.ID.create()
            yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, agent: Agent.ID.make("reviewer"), model: childModel })
            yield* events.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
            yield* events.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text: childText })
            yield* events.publish(SessionEvent.Step.Ended, { sessionID, assistantMessageID, finish: "stop", tokens, cost: Money.USD.zero })
          }) }))
          const local = Layer.effect(LocationServiceMap.Service, LayerMap.make((ref: Location.Ref) => Layer.mergeAll(locations.get(ref), runner,
            Layer.mock(Shell.Service, { list: () => Effect.succeed([]) }),
            Layer.mock(SessionGoal.Service, { continuation: () => Effect.die("no goal") }))))
          const context = yield* Layer.build(SessionExecution.layer.pipe(
            Layer.provide(local), Layer.provide(Layer.succeed(Database.Service, yield* Database.Service)),
            Layer.provide(Layer.succeed(EventRuntime.Service, events)), Layer.provide(Layer.succeed(SessionStore.Service, yield* SessionStore.Service)),
            Layer.provide(Layer.succeed(SessionAutonomy.Service, yield* SessionAutonomy.Service)), Layer.provide(Layer.succeed(Job.Service, yield* Job.Service)),
            Layer.provide(Layer.mock(SessionCompactionExecution.Service, { start: () => Effect.die("unused"), run: () => Effect.die("unused") })),
          ))
          const execution = Context.get(context, SessionExecution.Service)
          yield* sessions.prompt({ sessionID: parent.id, text: "Inspect the interrupted task", resume: false })
          yield* execution.wake(parent.id)
          yield* execution.awaitIdle(parent.id)
          yield* notifier.dispatch
          expect(yield* SessionTask.lostSessions(db)).toEqual(new Set())
          expect((yield* sessions.outstanding()).lost).toEqual(new Set())
          const lossAdmissions = db.select().from(EventTable).where(eq(EventTable.type, "session.input.admitted.1")).all().pipe(Effect.orDie,
            Effect.map((rows) => rows.filter((row) => {
              const input = Schema.decodeUnknownSync(SessionEvent.InputAdmitted.data)(row.data).input
              return input.type === "synthetic" && input.data.metadata?.type === "lost"
            })))
          const losses = yield* lossAdmissions
          expect(losses).toHaveLength(1)
          expect((yield* (yield* SessionStore.Service).context(parent.id)).filter((message) => message.type === "synthetic" && message.metadata?.type === "lost")).toHaveLength(1)
          for (const task of [child, fresh]) {
            yield* execution.resume(task.sessionID)
            expect((yield* orchestration.get(parent.id, task.sessionID)).state).toBe("completed")
            yield* orchestration.settle(task.sessionID, { type: "completed", excerpt: childText })
          }
          yield* notifier.dispatch
          yield* notifier.dispatch
          expect(yield* lossAdmissions).toEqual(losses)
          const notices = (yield* sessions.pending(parent.id)).filter((input) => input.type === "synthetic" && input.data.metadata?.type === "completed")
          expect(notices).toHaveLength(2)
          expect(new Set(notices.map((input) => input.type === "synthetic" ? input.data.metadata?.childID : undefined))).toEqual(new Set([child.sessionID, fresh.sessionID]))
          const tasks = yield* db.select().from(SessionTaskTable).orderBy(SessionTaskTable.session_id).all().pipe(Effect.orDie)
          const history = yield* db.select().from(EventTable).orderBy(sql`rowid`).all().pipe(Effect.orDie)
          const projects = yield* db.select().from(ProjectTable).all().pipe(Effect.orDie)
          const rebuilt = yield* Effect.gen(function* () {
            const db = (yield* Database.Service).db
            const events = yield* EventRuntime.Service
            yield* db.insert(ProjectTable).values(projects).run().pipe(Effect.orDie)
            for (const row of history) yield* events.replay({ id: row.id, aggregateID: row.aggregate_id, seq: row.seq,
              type: row.type, created: DateTime.makeUnsafe(row.created), data: row.data })
            return yield* db.select().from(SessionTaskTable).orderBy(SessionTaskTable.session_id).all().pipe(Effect.orDie)
          }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node])).pipe(Layer.fresh)), Effect.scoped)
          expect(rebuilt).toEqual(tasks)
        }).pipe(Effect.provide(subagentLayer(Database.configured({ path: path.join(dir.path, "restart.db") })).pipe(Layer.fresh)), Effect.scoped)
      })),
    ),
  )

  it.effect("defines parent control and child report action unions", () =>
    Effect.sync(() => {
      expect(Schema.decodeUnknownSync(SubagentControlTool.Input)({ action: "list" })).toEqual({ action: "list" })
      expect(
        Schema.decodeUnknownSync(SubagentControlTool.Input)({
          action: "send",
          sessionID: Session.ID.make("ses_child"),
          text: "context",
          delivery: "steer",
        }),
      ).toMatchObject({ action: "send" })
      expect(Schema.decodeUnknownSync(SubagentReportTool.Input)({ action: "progress", text: "halfway" })).toEqual({
        action: "progress",
        text: "halfway",
      })
      expect(() =>
        Schema.decodeUnknownSync(SubagentTool.Input)({
          agent: "reviewer",
          description: "d".repeat(4 * 1024 + 1),
          prompt: "review",
        }),
      ).toThrow()
      expect(() =>
        Schema.decodeUnknownSync(SubagentTool.Input)({
          agent: "reviewer",
          description: "review",
          prompt: "p".repeat(64 * 1024 + 1),
        }),
      ).toThrow()
      expect(
        Schema.decodeUnknownSync(SubagentTool.Input)({
          agent: "reviewer",
          description: "review",
          prompt: "review",
          timeout: 1,
        }),
      ).toMatchObject({ timeout: 1 })
      expect(() =>
        Schema.decodeUnknownSync(SubagentTool.Input)({
          agent: "reviewer",
          description: "review",
          prompt: "review",
          timeout: 0,
        }),
      ).toThrow()
      expect(() =>
        Schema.decodeUnknownSync(SubagentTool.Input)({
          agent: "reviewer",
          description: "review",
          prompt: "review",
          timeout: SubagentTool.MAX_TIMEOUT_MS + 1,
        }),
      ).toThrow()
      expect(SubagentTool.DEFAULT_TIMEOUT_MS).toBeGreaterThan(0)
      expect(SubagentTool.DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(SubagentTool.MAX_TIMEOUT_MS)
      expect(SubagentTool.description).toContain("Do not mention subagent status unless the user explicitly asks")
      expect(SubagentTool.description).toContain("Choose the model variant that matches the task difficulty")
      expect(SubagentTool.description).toContain(
        "Completion notifications are delivered automatically. Do not poll status or wait with sleep or no-op commands.",
      )
      expect(SubagentTool.description).not.toContain("you will be notified when they finish")
    }),
  )

  it.live("registers globally while resolving agents from the caller location", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = yield* Session.Service
          const parent = yield* session.create({ location })
          yield* withSubagent(parent.location)

          const locations = yield* LocationServiceMap.Service
          const registry = yield* ToolRegistry.Service.pipe(Effect.provide(locations.get(parent.location)))
          yield* waitForTool(registry, SubagentTool.name)
          yield* waitForTool(registry, SubagentControlTool.name)
          yield* waitForTool(registry, SubagentReportTool.name)
          expect((yield* registry.materialize()).definitions.map((tool) => tool.name)).toEqual(
            expect.arrayContaining([SubagentTool.name, SubagentControlTool.name, SubagentReportTool.name]),
          )
          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-primary",
                name: SubagentTool.name,
                input: { agent: "primary", description: "primary", prompt: "should fail" },
              },
            }),
          ).toEqual({ type: "error", value: "Agent primary cannot run as a subagent" })
        }),
      ),
    ),
  )

  it.live("advertises only subagents allowed by the effective Session permission", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({
            location,
            model: parentModel,
            permissionCeiling: [{ action: "subagent", resource: "reviewer", effect: "deny" }],
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const available = yield* Effect.gen(function* () {
            const agents = yield* Agent.Service
            const permission = yield* Permission.Service
            return yield* SubagentTool.availableAgents({
              permission,
              sessionID: parent.id,
              agent: toolIdentity.agent,
              candidates: yield* agents.list(),
            })
          }).pipe(Effect.provide(locations.get(parent.location)))

          expect(available.map((agent) => agent.id)).toContain(Agent.ID.make("fallback"))
          expect(available.map((agent) => agent.id)).not.toContain(Agent.ID.make("reviewer"))
        }),
      ),
    ),
  )

  it.live("reports child-only identity for missing managed task operations", () =>
    Effect.gen(function* () {
      const orchestration = (yield* PluginRuntime.Service).orchestration
      const childID = Session.ID.make("ses_missing_managed_task")
      const errors = [
        yield* orchestration.progress(childID, "halfway").pipe(Effect.flip),
        yield* orchestration.question(childID, "Proceed?").pipe(Effect.flip),
        yield* orchestration.settle(childID, { type: "completed", excerpt: "done" }).pipe(Effect.flip),
        yield* orchestration.background(childID).pipe(Effect.flip),
      ]

      for (const error of errors) {
        expect(error).toMatchObject({
          _tag: "SessionOrchestration.TaskNotFoundError",
          childID,
        })
        expect(error).not.toHaveProperty("parentID")
      }
    }),
  )

  it.live("prevents subagents from launching subagents by default", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const root = yield* sessions.create({ location })
          const parent = yield* sessions.create({ parentID: root.id, title: "parent" })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* ToolRegistry.Service.pipe(Effect.provide(locations.get(parent.location)))
          yield* waitForTool(registry, SubagentTool.name)

          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-nested-subagent",
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "nested", prompt: "should fail" },
              },
            }),
          ).toEqual({ type: "error", value: expect.stringContaining("Subagent depth limit reached (1)") })
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(0)
        }),
      ),
    ),
  )

  it.live("allows nested subagents up to the configured depth", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(path.join(dir.path, "ycoding.json"), JSON.stringify({ experimental: { subagent_depth: 2 } })),
          )
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const root = yield* sessions.create({ location })
          const parent = yield* sessions.create({ parentID: root.id, title: "parent", model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* ToolRegistry.Service.pipe(Effect.provide(locations.get(parent.location)))
          yield* waitForTool(registry, SubagentTool.name)

          const settled = yield* settleTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-configured-nested-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "nested", prompt: "should run" },
            },
          })

          expect(settled.output?.structured).toMatchObject({ status: "running" })
          expect((yield* sessions.get(outputSessionID(settled.output?.structured))).parentID).toBe(parent.id)
        }),
      ),
    ),
  )

  it.live("returns immediately while a child runs in the background", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* ToolRegistry.Service.pipe(Effect.provide(locations.get(parent.location)))
          yield* waitForTool(registry, SubagentTool.name)
          const progress: ToolRegistry.Progress[] = []

          const settled = yield* settleTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            progress: (update) => Effect.sync(() => progress.push(update)),
            call: {
              type: "tool-call",
              id: "call-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "review", prompt: "review this" },
            },
          })

          expect(settled.output?.structured).toMatchObject({ status: "running" })
          expect(settled.output?.content[0]).toMatchObject({
            type: "text",
            text: expect.stringContaining(
              "Completion notifications are delivered automatically. Do not poll status or wait with sleep or no-op commands.",
            ),
          })
          const child = yield* sessions.get(outputSessionID(settled.output?.structured))
          expect(progress[0]?.structured).toEqual({ sessionID: child.id, status: "running" })
          expect(child).toMatchObject({
            parentID: parent.id,
            location: parent.location,
            agent: "reviewer",
            model: childModel,
          })

          const fallback = yield* settleTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-fallback",
              name: SubagentTool.name,
              input: { agent: "fallback", description: "fallback", prompt: "fallback" },
            },
          })
          const fallbackChild = yield* sessions.get(outputSessionID(fallback.output?.structured))
          expect(fallbackChild).toMatchObject({ parentID: parent.id, model: parentModel })
        }),
      ),
    ),
  )

  it.live("backgrounds a child even when the caller omits background", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* ToolRegistry.Service.pipe(Effect.provide(locations.get(parent.location)))
          yield* waitForTool(registry, SubagentTool.name)

          const settled = yield* settleTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-forced-background",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "review", prompt: "review this" },
            },
          })
          const childID = outputSessionID(settled.output?.structured)
          expect(settled.output?.structured).toMatchObject({ sessionID: childID, status: "running" })
          expect((yield* (yield* PluginRuntime.Service).orchestration.get(parent.id, childID)).background).toBe(true)
        }),
      ),
    ),
  )

  it.effect("stops ten-minute progress prompts when their owning scope closes", () =>
    Effect.gen(function* () {
      const prompts: string[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* SubagentTool.repeatProgress(
            Effect.sync(() => prompts.push(SubagentTool.progressPrompt)),
          ).pipe(Effect.forkScoped)
          yield* TestClock.adjust("10 minutes")
        }),
      )
      expect(prompts).toEqual(["Report current status, blockers, and ETA."])
      yield* TestClock.adjust("10 minutes")
      expect(prompts).toHaveLength(1)
    }),
  )

  it.live("interrupts and durably fails a child once when its bounded runtime expires", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* ToolRegistry.Service.pipe(Effect.provide(locations.get(parent.location)))
          yield* waitForTool(registry, SubagentTool.name)
          const events = yield* EventRuntime.Service
          const admitted = yield* events.subscribe(SessionEvent.InputAdmitted).pipe(
            Stream.filter((event) => event.data.sessionID === parent.id && event.data.input.type === "synthetic"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          )

          const settled = yield* settleTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-timeout",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "hold until timeout", prompt: "wait", timeout: 25 },
            },
          })
          const childID = outputSessionID(settled.output?.structured)
          const finished = yield* Job.Service.use((jobs) => jobs.wait({ id: childID }))

          expect(finished.info).toMatchObject({ status: "error", error: expect.stringContaining("timed out") })
          expect((yield* (yield* PluginRuntime.Service).orchestration.get(parent.id, childID)).state).toBe("failed")
          expect(executionInterrupts.filter((sessionID) => sessionID === childID)).toHaveLength(1)
          const notifications = yield* (yield* Database.Service).db
            .select()
            .from(SessionTaskNotificationTable)
            .where(eq(SessionTaskNotificationTable.task_session_id, childID))
            .all()
          expect(notifications).toEqual([expect.objectContaining({ type: "failed" })])
          expect(Array.from(yield* Fiber.join(admitted))).toHaveLength(1)
        }),
      ),
    ),
  )

  startupFailureIt.live("durably fails a launched child when background job startup fails", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* ToolRegistry.Service.pipe(Effect.provide(locations.get(parent.location)))
          yield* waitForTool(registry, SubagentTool.name)

          expect(
            yield* Effect.exit(
              settleTool(registry, {
                sessionID: parent.id,
                ...toolIdentity,
                call: {
                  type: "tool-call",
                  id: "call-subagent-startup-failure",
                  name: SubagentTool.name,
                  input: { agent: "reviewer", description: "startup failure", prompt: "review" },
                },
              }),
            ),
          ).toMatchObject({ _tag: "Failure" })

          const tasks = yield* (yield* PluginRuntime.Service).orchestration.list(parent.id)
          expect(tasks).toHaveLength(1)
          expect(tasks[0]?.state).toBe("failed")
          expect(
            yield* (yield* Database.Service).db
              .select()
              .from(SessionTaskNotificationTable)
              .where(eq(SessionTaskNotificationTable.task_session_id, tasks[0]!.sessionID))
              .all(),
          ).toEqual([expect.objectContaining({ type: "failed" })])
        }),
      ),
    ),
  )

  it.live("preflights explicit variants before persisting a child", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const source = {
            agent: toolIdentity.agent,
            messageID: SessionMessage.ID.make("msg_parent"),
            callID: "call_variant",
          }
          const valid = yield* SessionOrchestration.preflight(parent, {
            agent: Agent.ID.make("reviewer"),
            model: { ...childModel, variant: CatalogModel.VariantID.make("high") },
            caller: source.agent,
          }).pipe(Effect.provide((yield* LocationServiceMap.Service).get(parent.location)))
          expect(valid.resolved.ref.variant).toBe(CatalogModel.VariantID.make("high"))

          const invalid = yield* Effect.exit(
            SessionOrchestration.preflight(parent, {
              agent: Agent.ID.make("reviewer"),
              model: { ...childModel, variant: CatalogModel.VariantID.make("unknown") },
              caller: source.agent,
            }).pipe(Effect.provide((yield* LocationServiceMap.Service).get(parent.location))),
          )
          expect(invalid).toMatchObject({ _tag: "Failure" })
          expect((yield* sessions.list({ parentID: parent.id })).data).toEqual([])
          expect(yield* (yield* PluginRuntime.Service).orchestration.list(parent.id)).toEqual([])
        }),
      ),
    ),
  )

  it.live("reconciles exact and concurrent launch retries and rejects conflicting reuse", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const source = {
            agent: toolIdentity.agent,
            messageID: SessionMessage.ID.make("msg_retry_parent"),
            callID: "call_retry",
          }
          const prepared = yield* SessionOrchestration.preflight(parent, {
            agent: Agent.ID.make("reviewer"),
            caller: source.agent,
          }).pipe(Effect.provide((yield* LocationServiceMap.Service).get(parent.location)))
          const orchestration = (yield* PluginRuntime.Service).orchestration
          const input = {
            parentID: parent.id,
            parentAssistantMessageID: source.messageID,
            toolCallID: source.callID,
            agent: Agent.ID.make("reviewer"),
            description: "retry",
            prompt: "same prompt",
            background: true,
            prepared,
          }
          const launched = yield* Effect.all([orchestration.launch(input), orchestration.launch(input)], {
            concurrency: "unbounded",
          })
          expect(launched[0]?.sessionID).toBe(launched[1]?.sessionID)
          expect(yield* orchestration.list(parent.id)).toHaveLength(1)
          expect(yield* Effect.exit(orchestration.launch({ ...input, prompt: "different prompt" }))).toMatchObject({
            _tag: "Failure",
          })
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(1)

          const interruptedSource = {
            messageID: SessionMessage.ID.make("msg_interrupted_parent"),
            callID: "call_interrupted",
          }
          const interruptedIDs = SessionOrchestrationIdentity.launch(
            parent.id,
            interruptedSource.messageID,
            interruptedSource.callID,
          )
          yield* sessions.create({
            id: interruptedIDs.childID,
            parentID: parent.id,
            title: "interrupted launch",
            agent: prepared.target.id,
            model: prepared.resolved.ref,
          })
          yield* EventRuntime.Service.use((events) =>
            events.publish(
              SessionEvent.Task.Updated,
              {
                sessionID: interruptedIDs.childID,
                change: {
                  type: "launched",
                  parentID: parent.id,
                  parentAssistantMessageID: interruptedSource.messageID,
                  toolCallID: interruptedSource.callID,
                  inputID: interruptedIDs.inputID,
                  description: "interrupted launch",
                  agent: prepared.target.id,
                  model: prepared.resolved.ref,
                  promptDigest: Hash.sha256("recover prompt"),
                  background: true,
                  delivery: "steer",
                },
              },
              { id: EventRuntime.ID.make(interruptedIDs.launchEventID) },
            ),
          )
          expect((yield* orchestration.get(parent.id, interruptedIDs.childID)).state).toBe("starting")
          expect(yield* sessions.pending(interruptedIDs.childID)).toHaveLength(0)

          const reconciled = yield* orchestration.launch({
            ...input,
            parentAssistantMessageID: interruptedSource.messageID,
            toolCallID: interruptedSource.callID,
            description: "interrupted launch",
            prompt: "recover prompt",
          })
          expect(reconciled.state).toBe("running")
          expect(yield* sessions.pending(interruptedIDs.childID)).toHaveLength(1)
        }),
      ),
    ),
  )

  it.live("cancels a starting managed child", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const source = {
            messageID: SessionMessage.ID.make("msg_starting_cancel_parent"),
            callID: "call_starting_cancel",
          }
          const prepared = yield* SessionOrchestration.preflight(parent, {
            agent: Agent.ID.make("reviewer"),
            caller: toolIdentity.agent,
          }).pipe(Effect.provide((yield* LocationServiceMap.Service).get(parent.location)))
          const ids = SessionOrchestrationIdentity.launch(parent.id, source.messageID, source.callID)
          yield* sessions.create({
            id: ids.childID,
            parentID: parent.id,
            title: "starting cancellation",
            agent: prepared.target.id,
            model: prepared.resolved.ref,
          })
          const orchestration = (yield* PluginRuntime.Service).orchestration
          const events = yield* EventRuntime.Service
          yield* events.publish(SessionEvent.Task.Updated, {
            sessionID: ids.childID,
            change: {
              type: "launched",
              parentID: parent.id,
              parentAssistantMessageID: source.messageID,
              toolCallID: source.callID,
              inputID: ids.inputID,
              description: "starting cancellation",
              agent: prepared.target.id,
              model: prepared.resolved.ref,
              promptDigest: Hash.sha256("starting cancellation"),
              background: true,
              delivery: "steer",
            },
          })
          expect((yield* orchestration.get(parent.id, ids.childID)).state).toBe("starting")
          const transitions = yield* events.subscribe(SessionEvent.Task.Updated).pipe(
            Stream.filter((event) => event.data.sessionID === ids.childID),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          )

          const cancelled = yield* orchestration.cancel({ parentID: parent.id, childID: ids.childID })

          expect(cancelled.state).toBe("cancelled")
          expect(Array.from(yield* Fiber.join(transitions)).map((event) => event.data.change.type)).toEqual([
            "cancel_requested",
            "cancelled",
          ])
        }),
      ),
    ),
  )

  it.live("enforces direct-child ownership and lifecycle-gated mailbox controls", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          const unrelatedParent = yield* sessions.create({ location, model: parentModel })
          const unmanaged = yield* sessions.create({ parentID: parent.id })
          const fork = yield* sessions.fork({ sessionID: parent.id })
          yield* withSubagent(parent.location)
          const source = {
            agent: toolIdentity.agent,
            messageID: SessionMessage.ID.make("msg_control_parent"),
            callID: "call_control",
          }
          const prepared = yield* SessionOrchestration.preflight(parent, {
            agent: Agent.ID.make("reviewer"),
            caller: source.agent,
          }).pipe(Effect.provide((yield* LocationServiceMap.Service).get(parent.location)))
          const orchestration = (yield* PluginRuntime.Service).orchestration
          const child = yield* orchestration.launch({
            parentID: parent.id,
            parentAssistantMessageID: source.messageID,
            toolCallID: source.callID,
            agent: Agent.ID.make("reviewer"),
            description: "controls",
            prompt: "initial",
            background: true,
            prepared,
          })

          for (const [owner, target] of [
            [unrelatedParent.id, child.sessionID],
            [parent.id, unmanaged.id],
            [parent.id, fork.id],
          ] as const) {
            expect(yield* Effect.exit(orchestration.get(owner, target))).toMatchObject({ _tag: "Failure" })
          }

          yield* (yield* Database.Service).db
            .delete(SessionPendingTable)
            .where(eq(SessionPendingTable.session_id, child.sessionID))
            .run()
          expect(
            yield* Effect.exit(orchestration.resume({ parentID: parent.id, childID: child.sessionID })),
          ).toMatchObject({
            _tag: "Failure",
          })

          yield* orchestration.send({
            parentID: parent.id,
            childID: child.sessionID,
            messageID: SessionMessage.ID.make("msg_steer_1"),
            text: "steer",
            delivery: "steer",
          })
          yield* orchestration.send({
            parentID: parent.id,
            childID: child.sessionID,
            messageID: SessionMessage.ID.make("msg_steer_2"),
            text: "steer",
            delivery: "steer",
          })
          yield* orchestration.send({
            parentID: parent.id,
            childID: child.sessionID,
            messageID: SessionMessage.ID.make("msg_queue_1"),
            text: "queue",
            delivery: "queue",
          })
          expect(
            (yield* sessions.pending(child.sessionID)).map((item) => item.delivery),
          ).toEqual(["steer", "steer", "queue"])

          const question = yield* orchestration.question(child.sessionID, "Proceed?", { risk: "low" })
          expect(
            yield* Effect.exit(
              orchestration.send({
                parentID: parent.id,
                childID: child.sessionID,
                messageID: SessionMessage.ID.make("msg_late_steer"),
                text: "late",
                delivery: "steer",
              }),
            ),
          ).toMatchObject({ _tag: "Failure" })
          expect(
            yield* Effect.exit(orchestration.resume({ parentID: parent.id, childID: child.sessionID })),
          ).toMatchObject({
            _tag: "Failure",
          })
          yield* orchestration.answer({
            parentID: parent.id,
            childID: child.sessionID,
            questionID: question.question.id,
            text: "yes",
          })
          expect(
            yield* Effect.exit(
              orchestration.answer({
                parentID: parent.id,
                childID: child.sessionID,
                questionID: question.question.id,
                text: "again",
              }),
            ),
          ).toMatchObject({ _tag: "Failure" })

          const cancelled = yield* orchestration.cancel({ parentID: parent.id, childID: child.sessionID })
          expect(cancelled.state).toBe("cancelled")
          const messageID = SessionMessage.ID.make("msg_late_queue")
          const reactivated = yield* orchestration.send({
            parentID: parent.id,
            childID: child.sessionID,
            messageID,
            text: "late",
            delivery: "queue",
          })
          expect(reactivated.state).toBe("running")
          const pending = yield* sessions.pending(child.sessionID)
          yield* orchestration.send({
            parentID: parent.id,
            childID: child.sessionID,
            messageID,
            text: "late",
            delivery: "queue",
          })
          expect(yield* sessions.pending(child.sessionID)).toHaveLength(pending.length)
          expect((yield* orchestration.resume({ parentID: parent.id, childID: child.sessionID })).state).toBe("running")
          yield* orchestration.settle(child.sessionID, { type: "completed", excerpt: "done" })
          expect(
            (yield* orchestration.send({
              parentID: parent.id,
              childID: child.sessionID,
              messageID: SessionMessage.ID.make("msg_completed_reuse"),
              text: "completed",
              delivery: "steer",
            })).state,
          ).toBe("running")
          yield* orchestration.settle(child.sessionID, { type: "failed", error: "failed" })
          expect(
            (yield* orchestration.send({
              parentID: parent.id,
              childID: child.sessionID,
              messageID: SessionMessage.ID.make("msg_failed_reuse"),
              text: "failed",
              delivery: "steer",
            })).state,
          ).toBe("running")
          const notifier = yield* SessionOrchestrationNotifier.Service
          yield* notifier.dispatch
          const parentWakes = executionWakes.filter((id) => id === parent.id).length
          yield* orchestration.settle(child.sessionID, { type: "lost" })
          yield* notifier.dispatch
          expect(executionWakes.filter((id) => id === parent.id)).toHaveLength(parentWakes + 1)
          const db = (yield* Database.Service).db
          expect(yield* SessionTask.lostSessions(db)).toEqual(new Set())
          expect(
            (yield* orchestration.send({
              parentID: parent.id,
              childID: child.sessionID,
              messageID: SessionMessage.ID.make("msg_lost_reuse"),
              text: "lost",
              delivery: "steer",
            })).state,
          ).toBe("running")
        }),
      ),
    ),
  )

  it.live("reconciles outbox retry after parent admission before delivery marking", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const source = {
            agent: toolIdentity.agent,
            messageID: SessionMessage.ID.make("msg_outbox_parent"),
            callID: "call_outbox",
          }
          const prepared = yield* SessionOrchestration.preflight(parent, {
            agent: Agent.ID.make("reviewer"),
            caller: source.agent,
          }).pipe(Effect.provide((yield* LocationServiceMap.Service).get(parent.location)))
          const orchestration = (yield* PluginRuntime.Service).orchestration
          const child = yield* orchestration.launch({
            parentID: parent.id,
            parentAssistantMessageID: source.messageID,
            toolCallID: source.callID,
            agent: Agent.ID.make("reviewer"),
            description: "outbox",
            prompt: "initial",
            background: true,
            prepared,
          })
          const events = yield* EventRuntime.Service
          const admitted = yield* events.subscribe(SessionEvent.InputAdmitted).pipe(
            Stream.filter((event) => event.data.sessionID === parent.id && event.data.input.type === "synthetic"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* orchestration.settle(child.sessionID, { type: "completed", excerpt: "done" })
          yield* Fiber.join(admitted)
          expect(notificationDeliveredOnWake.at(-1)).toBe(false)

          const db = (yield* Database.Service).db
          const notification = yield* db.select().from(SessionTaskNotificationTable).get()
          if (!notification) return yield* Effect.die("Notification missing")
          expect(notification?.delivered).toBe(true)
          yield* db
            .update(SessionTaskNotificationTable)
            .set({ delivered: false, time_delivered: null })
            .where(eq(SessionTaskNotificationTable.id, notification.id))
            .run()
          yield* SessionOrchestrationNotifier.Service.use((notifier) => notifier.dispatch)

          expect((yield* sessions.pending(parent.id)).filter((item) => item.type === "synthetic")).toHaveLength(1)
          expect((yield* db.select().from(SessionTaskNotificationTable).get())?.delivered).toBe(true)
        }),
      ),
    ),
  )

  it.live("does not reactivate a terminal child when a promoted parent message is retried", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const orchestration = (yield* PluginRuntime.Service).orchestration
          const prepared = yield* SessionOrchestration.preflight(parent, {
            agent: Agent.ID.make("reviewer"),
            caller: toolIdentity.agent,
          }).pipe(Effect.provide(locations.get(parent.location)))
          const child = yield* orchestration.launch({
            parentID: parent.id,
            parentAssistantMessageID: SessionMessage.ID.make("msg_retry_parent"),
            toolCallID: "call_retry",
            agent: Agent.ID.make("reviewer"),
            description: "retry",
            prompt: "initial",
            background: true,
            prepared,
          })
          const db = (yield* Database.Service).db
          const events = yield* EventRuntime.Service
          yield* db.delete(SessionPendingTable).where(eq(SessionPendingTable.session_id, child.sessionID)).run()
          yield* orchestration.settle(child.sessionID, { type: "completed", excerpt: "done" })

          const messageID = SessionMessage.ID.make("msg_completed_retry")
          yield* orchestration.send({
            parentID: parent.id,
            childID: child.sessionID,
            messageID,
            text: "retry",
            delivery: "steer",
          })
          yield* SessionPending.promoteSteers(db, events, child.sessionID)
          yield* orchestration.settle(child.sessionID, { type: "completed", excerpt: "done" })

          const wakes = executionWakes.filter((id) => id === child.sessionID).length
          const task = yield* orchestration.send({
            parentID: parent.id,
            childID: child.sessionID,
            messageID,
            text: "retry",
            delivery: "steer",
          })
          expect(task.state).toBe("completed")
          expect(executionWakes.filter((id) => id === child.sessionID)).toHaveLength(wakes)
        }),
      ),
    ),
  )

  it.live("recovers only unstarted admitted work and marks an in-flight attempt lost", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const orchestration = (yield* PluginRuntime.Service).orchestration
          const prepare = (callID: string) =>
            SessionOrchestration.preflight(parent, {
              agent: Agent.ID.make("reviewer"),
              caller: toolIdentity.agent,
            }).pipe(Effect.provide(locations.get(parent.location)))
          const launch = Effect.fnUntraced(function* (callID: string) {
            return yield* orchestration.launch({
              parentID: parent.id,
              parentAssistantMessageID: SessionMessage.ID.make(`msg_${callID}`),
              toolCallID: callID,
              agent: Agent.ID.make("reviewer"),
              description: callID,
              prompt: "pending",
              background: true,
              prepared: yield* prepare(callID),
            })
          })

          const unstarted = yield* launch("recover_unstarted")
          expect(executionWakes.filter((id) => id === unstarted.sessionID)).toHaveLength(1)
          yield* orchestration.recover
          expect(executionWakes.filter((id) => id === unstarted.sessionID)).toHaveLength(2)

          const terminalPending = yield* launch("recover_terminal_pending")
          const db = (yield* Database.Service).db
          yield* db
            .delete(SessionPendingTable)
            .where(eq(SessionPendingTable.session_id, terminalPending.sessionID))
            .run()
          yield* orchestration.settle(terminalPending.sessionID, { type: "completed", excerpt: "done" })
          yield* sessions.synthetic({
            id: SessionMessage.ID.make("msg_recover_terminal_1"),
            sessionID: terminalPending.sessionID,
            text: "admitted before task reactivation",
            description: "Parent subagent message",
            metadata: {
              source: "subagent_parent",
              parentID: parent.id,
              childID: terminalPending.sessionID,
              kind: "message",
            },
            delivery: "steer",
            resume: false,
          })
          yield* sessions.synthetic({
            id: SessionMessage.ID.make("msg_recover_terminal_2"),
            sessionID: terminalPending.sessionID,
            text: "second admitted input",
            description: "Parent subagent message",
            metadata: {
              source: "subagent_parent",
              parentID: parent.id,
              childID: terminalPending.sessionID,
              kind: "message",
            },
            delivery: "queue",
            resume: false,
          })
          expect(executionWakes.filter((id) => id === terminalPending.sessionID)).toHaveLength(1)
          yield* orchestration.recover
          expect(executionWakes.filter((id) => id === terminalPending.sessionID)).toHaveLength(2)
          expect((yield* orchestration.get(parent.id, terminalPending.sessionID)).state).toBe("running")

          const inFlight = yield* launch("recover_inflight")
          const assistantMessageID = SessionMessage.ID.make("msg_inflight_assistant")
          yield* EventRuntime.Service.use((events) =>
            events.publish(SessionEvent.Step.Started, {
              sessionID: inFlight.sessionID,
              assistantMessageID,
              agent: Agent.ID.make("reviewer"),
              model: childModel,
            }),
          )
          expect(executionWakes.filter((id) => id === inFlight.sessionID)).toHaveLength(1)
          yield* orchestration.recover
          expect(executionWakes.filter((id) => id === inFlight.sessionID)).toHaveLength(1)
          expect((yield* orchestration.get(parent.id, inFlight.sessionID)).state).toBe("lost")

          const noPending = yield* launch("recover_no_pending")
          yield* (yield* Database.Service).db
            .delete(SessionPendingTable)
            .where(eq(SessionPendingTable.session_id, noPending.sessionID))
            .run()
          expect(executionWakes.filter((id) => id === noPending.sessionID)).toHaveLength(1)
          yield* orchestration.recover
          expect(executionWakes.filter((id) => id === noPending.sessionID)).toHaveLength(1)
          expect((yield* orchestration.get(parent.id, noPending.sessionID)).state).toBe("lost")

          const cancelling = yield* launch("recover_cancelling")
          yield* EventRuntime.Service.use((events) =>
            events.publish(SessionEvent.Task.Updated, {
              sessionID: cancelling.sessionID,
              change: { type: "cancel_requested" },
            }),
          )
          expect((yield* orchestration.get(parent.id, cancelling.sessionID)).state).toBe("cancelling")
          yield* orchestration.recover
          expect((yield* orchestration.get(parent.id, cancelling.sessionID)).state).toBe("cancelled")
        }),
      ),
    ),
  )

  it.live("inherits the caller and parent deny ceilings without inheriting allows", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({
            location,
            permissionCeiling: [{ action: "read", resource: "/secret/*", effect: "deny" }],
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          yield* Agent.Service.use((agents) =>
            agents.transform((draft) => {
              draft.update(toolIdentity.agent, (agent) => {
                agent.permissions = [
                  { action: "*", resource: "*", effect: "allow" },
                  { action: "shell", resource: "*", effect: "deny" },
                ]
              })
              draft.update(Agent.ID.make("reviewer"), (agent) => {
                agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
              })
            }),
          ).pipe(Effect.provide(locations.get(parent.location)))
          const registry = yield* ToolRegistry.Service.pipe(Effect.provide(locations.get(parent.location)))
          yield* waitForTool(registry, SubagentTool.name)

          const settled = yield* settleTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-ceiling",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "restricted", prompt: "review this" },
            },
          })
          const child = yield* sessions.get(outputSessionID(settled.output?.structured))
          expect(child.permissionCeiling).toEqual([
            { action: "read", resource: "/secret/*", effect: "deny" },
            { action: "shell", resource: "*", effect: "deny" },
          ])

          const permission = yield* Permission.Service.pipe(Effect.provide(locations.get(child.location)))
          expect(
            yield* permission.ask({
              sessionID: child.id,
              agent: Agent.ID.make("reviewer"),
              action: "shell",
              resources: ["pwd"],
            }),
          ).toMatchObject({ effect: "deny" })
          expect(
            yield* permission.ask({
              sessionID: child.id,
              agent: Agent.ID.make("reviewer"),
              action: "read",
              resources: ["/secret/token"],
            }),
          ).toMatchObject({ effect: "deny" })
          expect(
            yield* permission.ask({
              sessionID: child.id,
              agent: Agent.ID.make("reviewer"),
              action: "edit",
              resources: ["src/index.ts"],
            }),
          ).toMatchObject({ effect: "allow" })
        }),
      ),
    ),
  )

  it.live("auto handles child permissions and questions for yolo and goal roots without notifications", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({
            location,
            model: parentModel,
            permissionCeiling: [{ action: "delete", resource: "*", effect: "deny" }],
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          yield* Agent.Service.use((agents) =>
            agents.transform((draft) =>
              draft.update(Agent.ID.make("reviewer"), (agent) => {
                agent.permissions = [{ action: "*", resource: "*", effect: "ask" }]
              }),
            ),
          ).pipe(Effect.provide(locations.get(parent.location)))
          const orchestration = (yield* PluginRuntime.Service).orchestration
          const prepared = yield* SessionOrchestration.preflight(parent, {
            agent: Agent.ID.make("reviewer"),
            caller: toolIdentity.agent,
          }).pipe(Effect.provide(locations.get(parent.location)))
          const child = yield* orchestration.launch({
            parentID: parent.id,
            parentAssistantMessageID: SessionMessage.ID.make("msg_autonomous_parent"),
            toolCallID: "call_autonomous_child",
            agent: Agent.ID.make("reviewer"),
            description: "hold autonomous child",
            prompt: "continue safely",
            background: true,
            prepared,
          })
          const permission = yield* Permission.Service.pipe(Effect.provide(locations.get(parent.location)))
          const questions = yield* Question.Service.pipe(Effect.provide(locations.get(parent.location)))
          const forms = yield* Form.Service.pipe(Effect.provide(locations.get(parent.location)))
          const registry = yield* ToolRegistry.Service.pipe(Effect.provide(locations.get(parent.location)))
          const db = (yield* Database.Service).db

          const autonomy = yield* SessionAutonomy.Service.pipe(Effect.provide(locations.get(parent.location)))
          for (const yolo of [0, 1, 2, 3]) {
            yield* autonomy.setYolo({ sessionID: parent.id, yolo })
            expect(yield* autonomy.canAutoPermission(child.sessionID)).toBe(yolo >= 1)
            expect(yield* autonomy.canAutoGuardrail(child.sessionID)).toBe(yolo >= 1)
            expect(yield* autonomy.canAutoAnswer(child.sessionID)).toBe(yolo >= 2)
            if (yolo >= 2) continue
            const question = yield* orchestration.question(child.sessionID, `Manual question at YOLO ${yolo}`)
            expect(question.autoAnswered).toBe(false)
            expect(yield* orchestration.get(parent.id, child.sessionID)).toMatchObject({ state: "waiting", question: { id: question.question.id } })
            yield* orchestration.answer({ parentID: parent.id, childID: child.sessionID, questionID: question.question.id, text: "Human answer" })
          }

          for (const mode of [2, 3, "goal"] as const) {
            yield* db
              .update(SessionTable)
              .set({
                autonomy:
                  mode === "goal"
                    ? {
                        mode: "normal",
                        yolo: 0,
                        goal: {
                          text: "Finish the parent goal",
                          status: "active",
                          iteration: 0,
                          noProgress: 0,
                          maxNoProgress: 3,
                        },
                      }
                    : { mode: "normal", yolo: mode },
              })
              .where(eq(SessionTable.id, parent.id))
              .run()
              .pipe(Effect.orDie)

            expect(
              yield* permission.ask({
                id: Permission.ID.create(`per_child_${mode}`),
                sessionID: child.sessionID,
                agent: Agent.ID.make("reviewer"),
                action: "edit",
                resources: ["src/index.ts"],
              }),
            ).toMatchObject({ effect: "allow" })
            expect(
              yield* permission.ask({
                id: Permission.ID.create(`per_child_deny_${mode}`),
                sessionID: child.sessionID,
                agent: Agent.ID.make("reviewer"),
                action: "delete",
                resources: ["src/index.ts"],
              }),
            ).toMatchObject({ effect: "deny" })
            expect(
              yield* questions.ask({
                sessionID: child.sessionID,
                questions: [
                  {
                    question: "Which option?",
                    header: "Option",
                    options: [{ label: "Safest", description: "Use the safest option" }],
                  },
                ],
              }),
            ).toEqual([["Safest"]])
            expect(
              yield* forms.ask({
                sessionID: child.sessionID,
                title: `Choose for ${mode}`,
                fields: [
                  {
                    key: "choice",
                    type: "string",
                    required: true,
                    options: [{ value: "safe", label: "Safe" }],
                  },
                ],
              }),
            ).toMatchObject({ status: "answered", answer: { choice: "safe" } })

            expect(
              yield* executeTool(registry, {
                sessionID: child.sessionID,
                agent: Agent.ID.make("reviewer"),
                messageID: SessionMessage.ID.make(`msg_child_question_${mode}`),
                call: {
                  type: "tool-call",
                  id: `call_child_question_${mode}`,
                  name: SubagentReportTool.name,
                  input: { action: "question", text: `How should ${mode} continue?` },
                },
              }),
            ).toMatchObject({ type: "text" })
            expect(yield* orchestration.get(parent.id, child.sessionID)).toMatchObject({
              state: "running",
              question: undefined,
            })
          }

          expect(yield* permission.list()).toEqual([])
          expect(yield* questions.list()).toEqual([])
          expect(yield* forms.list({ sessionID: child.sessionID })).toEqual([])
          expect(
            (yield* db
              .select({ type: SessionTaskNotificationTable.type })
              .from(SessionTaskNotificationTable)
              .where(eq(SessionTaskNotificationTable.task_session_id, child.sessionID))
              .all()
              .pipe(Effect.orDie))
              .filter((item) => item.type === "question"),
          ).toHaveLength(2)
        }),
      ),
    ),
  )

  it.live("re-evaluates subagent permission for model-originated parent controls", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* ToolRegistry.Service.pipe(Effect.provide(locations.get(parent.location)))
          yield* waitForTool(registry, SubagentTool.name)
          yield* waitForTool(registry, SubagentControlTool.name)
          yield* waitForTool(registry, SubagentReportTool.name)
          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-parent-report",
                name: SubagentReportTool.name,
                input: { action: "progress", text: "not a managed child" },
              },
            }),
          ).toMatchObject({ type: "error" })
          const launched = yield* settleTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-control-launch",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "controlled", prompt: "wait", background: true },
            },
          })
          const childID = outputSessionID(launched.output?.structured)
          yield* Agent.Service.use((agents) =>
            agents.transform((draft) =>
              draft.update(toolIdentity.agent, (agent) => {
                agent.permissions = [{ action: "subagent", resource: "reviewer", effect: "deny" }]
              }),
            ),
          ).pipe(Effect.provide(locations.get(parent.location)))

          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-control-denied",
                name: SubagentControlTool.name,
                input: { action: "send", sessionID: childID, text: "repeat", delivery: "steer" },
              },
            }),
          ).toEqual({ type: "error", value: "Permission denied: subagent" })
        }),
      ),
    ),
  )

  it.live("backgrounds a held child immediately", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* ToolRegistry.Service.pipe(Effect.provide(locations.get(parent.location)))
          yield* waitForTool(registry, SubagentTool.name)
          const settled = yield* settleTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-foreground-background",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "hold child", prompt: "wait" },
            },
          })
          const childID = outputSessionID(settled.output?.structured)
          expect(settled.output?.structured).toMatchObject({ sessionID: childID, status: "running" })
          expect((yield* (yield* PluginRuntime.Service).orchestration.get(parent.id, childID)).background).toBe(true)
        }),
      ),
    ),
  )

  it.live("delivers a control send to the child under the ID derived from the parent's assistant message and call", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* ToolRegistry.Service.pipe(Effect.provide(locations.get(parent.location)))
          yield* waitForTool(registry, SubagentTool.name)
          yield* waitForTool(registry, SubagentControlTool.name)
          const launched = yield* settleTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-send-launch",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "held", prompt: "wait", background: true },
            },
          })
          const childID = outputSessionID(launched.output?.structured)
          const sent = yield* settleTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-send-control",
              name: SubagentControlTool.name,
              input: { action: "send", sessionID: childID, text: "continue", delivery: "steer" },
            },
          })
          expect(sent.output?.structured).toMatchObject({ action: "send", task: { sessionID: childID } })
          const delivered = (yield* sessions.pending(childID)).filter((item) => item.type === "synthetic")
          const expected = SessionOrchestrationIdentity.send(parent.id, toolIdentity.messageID, "call-send-control")
          expect(String(expected)).toBe(
            `msg_task_send_${Hash.sha256(`${parent.id}\0${toolIdentity.messageID}\0call-send-control`).slice(0, 24)}`,
          )
          expect(delivered.map((item) => item.id)).toContain(expected)
          expect(
            SessionOrchestrationIdentity.send(parent.id, toolIdentity.messageID, "call-other"),
          ).not.toBe(expected)
        }),
      ),
    ),
  )

  it.live("returns immediately when a background child later fails", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* ToolRegistry.Service.pipe(Effect.provide(locations.get(parent.location)))
          yield* waitForTool(registry, SubagentTool.name)

          const launch = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-failure",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "fail review", prompt: "please fail" },
            },
          })
          expect(launch).toMatchObject({ type: "text", value: expect.stringContaining("Subagent launched") })
          expect(launch).toMatchObject({ type: "text", value: expect.not.stringContaining("notify the user") })
        }),
      ),
    ),
  )

  it.live("does not inject a TeamView suffix into context messages", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          // PluginHooks is not part of LocationServices, so the plugin is hosted against the
          // ambient hooks instance the test can trigger directly.
          const plugins = yield* PluginRegistry.Service.pipe(Effect.provide(locations.get(parent.location)))
          const host = yield* PluginHost.make(plugins).pipe(Effect.provide(locations.get(parent.location)))
          yield* SubagentTool.Plugin.effect(host).pipe(Effect.provide(locations.get(parent.location)))
          const orchestration = (yield* PluginRuntime.Service).orchestration
          const prepared = yield* SessionOrchestration.preflight(parent, {
            agent: Agent.ID.make("reviewer"),
            caller: toolIdentity.agent,
          }).pipe(Effect.provide(locations.get(parent.location)))
          const child = yield* orchestration.launch({
            parentID: parent.id,
            parentAssistantMessageID: SessionMessage.ID.make("msg_team_view"),
            toolCallID: "call_team_view",
            agent: Agent.ID.make("reviewer"),
            description: "team view",
            prompt: "hold",
            background: true,
            prepared,
          })
          const team = yield* orchestration.teamView(parent.id)
          expect(team.text).toContain(child.sessionID)

          const hooks = yield* PluginHooks.Service
          const event: SessionHooks["context"] = {
            sessionID: parent.id,
            agent: toolIdentity.agent,
            model: parentModel,
            routeID: "openai-responses",
            system: [SystemPart.make("base system prompt")],
            messages: [Message.user("earlier history")],
            tools: { [SubagentTool.name]: { description: SubagentTool.description, input: { type: "object" } } },
          }

          yield* hooks.trigger("session", "context", event)

          expect(event.tools[SubagentTool.name]?.description).toContain("Available subagents:")
          expect(event.system.map((part) => part.text)).toEqual(["base system prompt"])
          expect(event.messages).toEqual([Message.user("earlier history")])

          const codexEvent: SessionHooks["context"] = {
            ...event,
            routeID: "openai-codex-responses",
            messages: [Message.user("codex history")],
          }
          yield* hooks.trigger("session", "context", codexEvent)
          expect(codexEvent.messages).toEqual([Message.user("codex history")])

          const codexWebSocketEvent: SessionHooks["context"] = {
            ...event,
            routeID: "openai-codex-websocket-responses",
            messages: [Message.user("codex websocket history")],
          }
          yield* hooks.trigger("session", "context", codexWebSocketEvent)
          expect(codexWebSocketEvent.messages).toEqual([Message.user("codex websocket history")])

          yield* orchestration.settle(child.sessionID, { type: "completed", excerpt: "done" })
          const terminalEvent: SessionHooks["context"] = {
            ...event,
            messages: [Message.user("later history")],
          }
          yield* hooks.trigger("session", "context", terminalEvent)
          expect(terminalEvent.messages).toEqual([Message.user("later history")])
        }),
      ),
    ),
  )

  it.live("notifies once when background work completes", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* ToolRegistry.Service.pipe(Effect.provide(locations.get(parent.location)))
          yield* waitForTool(registry, SubagentTool.name)
          const events = yield* EventRuntime.Service
          const admitted = yield* events.subscribe(SessionEvent.InputAdmitted).pipe(
            Stream.filter((event) => event.data.sessionID === parent.id && event.data.input.type === "synthetic"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          )

          const settled = yield* settleTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-background-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "background review", prompt: "review", background: true },
            },
          })
          const childID = outputSessionID(settled.output?.structured)
          expect(settled.output?.structured).toMatchObject({
            status: "running",
            output: expect.stringContaining(`id: ${childID}`),
          })

          const admission = Array.from(yield* Fiber.join(admitted))[0]
          expect(admission?.data.input.data.text).toContain("Subagent notification:")
          expect(admission?.data.input.data.text).toContain(`"childID":"${childID}"`)
          expect(admission?.data.input.data).toMatchObject({
            description: "Subagent notification",
            metadata: {
              source: "subagent_notification",
              childID,
              type: "completed",
            },
          })
          const database = yield* Database.Service
          yield* SessionPending.promoteSteers(database.db, events, parent.id)
          const synthetic = (yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")
          expect(synthetic).toHaveLength(1)
          expect(synthetic[0]?.text).toContain("Subagent notification:")
          expect(synthetic[0]?.text).toContain(`"childID":"${childID}"`)
          expect(synthetic[0]?.text).toContain(childText)
        }),
      ),
    ),
  )
})
