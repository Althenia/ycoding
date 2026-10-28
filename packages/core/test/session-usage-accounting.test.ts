import { expect, test } from "bun:test"
import { DateTime, Deferred, Effect, Fiber, Layer } from "effect"
import { sql } from "drizzle-orm"
import { tmpdir } from "node:os"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventRuntime } from "../src/event"
import { Session } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionPending } from "../src/session/pending"
import { SessionProviderRequest } from "../src/session/provider-request"
import { SessionUsageAttribution } from "../src/session/usage-attribution"
import { SessionUsageRead } from "../src/session/usage-read"
import { SessionUsageCleanup } from "../src/session/usage-cleanup"
import { RetentionSettings } from "../src/retention-settings"
import { SessionOrchestration } from "../src/session/orchestration"
import { Agent } from "@ycoding-ai/schema/agent"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { UsageAccounting } from "@ycoding-ai/schema/usage-accounting"
import { UsageAnchor } from "@ycoding-ai/schema/usage-anchor"
import { SessionMessage } from "@ycoding-ai/schema/session-message"
import { AbsolutePath } from "@ycoding-ai/schema/schema"
import { Money } from "@ycoding-ai/schema/money"
import { Schema } from "effect"

let recordsDays = 7
const runtime = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    EventRuntime.node,
    Session.node,
    SessionProviderRequest.node,
    SessionOrchestration.node,
    SessionUsageCleanup.node,
  ]),
  [
    [SessionExecution.node, SessionExecution.noopLayer],
    [
      RetentionSettings.node,
      Layer.succeed(RetentionSettings.Service, {
        read: () => Effect.succeed({ recordsDays, usageDays: 30, latencyDays: 30, incidentDays: 30 }),
      }),
    ],
  ],
)
const model = Model.Ref.make({ providerID: Provider.ID.make("p"), id: Model.ID.make("m") })
const tokens = { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }

for (const kind of ["prompt", "task"] as const)
  test(
    `raising retention preserves ${kind} pruning gaps after resumed work`,
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const database = yield* Database.Service
          const cleanup = yield* SessionUsageCleanup.Service
          const root = yield* sessions.create({ location: { directory: AbsolutePath.make(tmpdir()) } })
          const anchor = yield* user(root.id, "work")
          const owner = kind === "task" ? yield* child(root.id, anchor, "pruned_task") : root
          const past = Date.now() - 2 * 86_400_000
          yield* database.db.run(
            sql`UPDATE session SET time_created = ${past}, time_updated = ${past} WHERE id IN (${root.id},${owner.id})`,
          )
          yield* database.db.run(sql`UPDATE session_message SET time_created = ${past} WHERE id = ${anchor.inputID}`)
          if (kind === "task")
            yield* database.db.run(sql`UPDATE session_task SET time_created = ${past} WHERE session_id = ${owner.id}`)
          yield* complete(yield* begin(owner.id), 10)
          recordsDays = 1
          expect(yield* cleanup.cleanup()).toBe(1)
          recordsDays = 7
          yield* complete(yield* begin(owner.id), 1)
          const prompt = (yield* sessions.promptCosts({ sessionID: root.id, inputIDs: [anchor.inputID] })).units[0]!
          expect(prompt.history).toBe("partial")
          expect(prompt.total.cost).toMatchObject({ known: 1, pricedRequests: 1, unpricedRequests: 0 })
          expect(prompt.total.cost.total).toBeUndefined()
          if (kind === "task") {
            const task = (yield* sessions.taskCosts({ sessionID: root.id, sessionIDs: [owner.id] })).tasks[0]!
            expect(task.history).toBe("partial")
            expect(task.total.cost).toMatchObject({ known: 1, pricedRequests: 1, unpricedRequests: 0 })
            expect(task.total.cost.total).toBeUndefined()
          }
          if (kind === "prompt") {
            const mark = (yield* database.db.get<{ cutoff: number }>(
              sql`SELECT usage_pruned_through AS cutoff FROM session WHERE id = ${root.id}`,
            ))!.cutoff
            yield* database.db.run(sql`UPDATE session_message SET time_created = ${mark} WHERE id = ${anchor.inputID}`)
            expect(
              (yield* sessions.promptCosts({ sessionID: root.id, inputIDs: [anchor.inputID] })).units[0]!.history,
            ).toBe("partial")
            const fresh = yield* user(root.id, "fresh work")
            yield* complete(yield* begin(root.id), 2)
            const unit = (yield* sessions.promptCosts({ sessionID: root.id, inputIDs: [fresh.inputID] })).units[0]!
            expect(unit.history).toBe("retained")
            expect(unit.total.cost).toMatchObject({ total: 2, pricedRequests: 1, unpricedRequests: 0 })
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              recordsDays = 7
            }),
          ),
          Effect.provide(runtime),
          Effect.scoped,
        ),
      ),
    30_000,
  )
const begin = (sessionID: Session.ID, source: ProviderRequest.Source = "step", inputID?: SessionMessage.ID) =>
  Effect.gen(function* () {
    const ledger = yield* SessionProviderRequest.Service
    return yield* ledger.next({
      sessionID,
      source,
      inputID,
      agent: Agent.ID.make("build"),
      model,
      routeID: "route",
      promptCacheKey: "cache",
      systemDigest: "system",
      toolDigest: "tools",
    })
  })
const complete = (tracker: SessionProviderRequest.Tracker, cost: number) =>
  tracker.complete({ outcome: "completed", cost: Money.USD.make(cost), tokens, continuation: "full" })

const user = (sessionID: Session.ID, text: string, delivery: "steer" | "queue" = "steer") =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const input = yield* session.prompt({
      sessionID,
      text,
      delivery,
      resume: false,
      metadata: { usageAnchor: { sessionID: "ses_untrusted", inputID: "msg_untrusted" } },
    })
    const database = yield* Database.Service
    const events = yield* EventRuntime.Service
    if (delivery === "steer") yield* SessionPending.promoteSteers(database.db, events, sessionID)
    return { sessionID, inputID: input.id }
  })

const child = (parentID: Session.ID, anchor: UsageAnchor.Ref, name: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const events = yield* EventRuntime.Service
    const database = yield* Database.Service
    const session = yield* sessions.create({ parentID, model })
    const inputID = SessionMessage.ID.make(`msg_child_${name}`)
    yield* events.publish(SessionEvent.Task.Updated, {
      sessionID: session.id,
      change: {
        type: "launched",
        parentID,
        parentAssistantMessageID: SessionMessage.ID.make(`msg_parent_${name}`),
        toolCallID: `call_${name}`,
        inputID,
        description: name,
        agent: Agent.ID.make("build"),
        model,
        promptDigest: "digest",
        background: true,
        delivery: "steer",
        usageAnchor: anchor,
      },
    })
    yield* sessions.prompt({
      id: inputID,
      sessionID: session.id,
      text: name,
      causedBy: anchor,
      origin: "subagent",
      resume: false,
    })
    yield* SessionPending.promoteSteers(database.db, events, session.id)
    yield* events.publish(SessionEvent.Task.Updated, { sessionID: session.id, change: { type: "started" } })
    return session
  })

test(
  "prompt and recursive task costs follow dispatch across queued input, child re-tasking, delayed helpers and pruning",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const database = yield* Database.Service
        const events = yield* EventRuntime.Service
        const orchestration = yield* SessionOrchestration.Service
        const root = yield* sessions.create({ location: { directory: AbsolutePath.make(tmpdir()) } })
        const first = yield* user(root.id, "first")
        yield* complete(yield* begin(root.id), 1)
        const subagent = yield* child(root.id, first, "child")
        const nested = yield* child(subagent.id, first, "nested")
        const outstanding = yield* begin(subagent.id)
        const helperStarted = yield* Deferred.make<void>()
        const helperContinue = yield* Deferred.make<void>()
        const helper = yield* SessionUsageAttribution.withAnchor(
          subagent.id,
          first,
          Effect.gen(function* () {
            yield* Deferred.succeed(helperStarted, undefined)
            yield* Deferred.await(helperContinue)
            yield* complete(yield* begin(subagent.id, "title"), 4)
          }),
        ).pipe(Effect.forkChild)
        yield* Deferred.await(helperStarted)
        const second = yield* user(root.id, "second", "queue")
        const beforeQueue = yield* begin(root.id)
        expect(beforeQueue.usageAnchor).toEqual(first)
        yield* complete(beforeQueue, 0)
        yield* SessionPending.promoteNextQueued(database.db, events, root.id)
        yield* complete(outstanding, 2)
        yield* complete(yield* begin(nested.id), 5)
        yield* events.publish(SessionEvent.Task.Updated, { sessionID: nested.id, change: { type: "completed" } })
        yield* orchestration.send({
          parentID: root.id,
          childID: subagent.id,
          messageID: SessionMessage.ID.make("msg_retask"),
          text: "continue",
          delivery: "steer",
        })
        yield* SessionPending.promoteSteers(database.db, events, subagent.id)
        const retasked = yield* begin(subagent.id).pipe(Effect.provideService(SessionUsageAttribution.Current, first))
        expect(retasked.usageAnchor).toEqual(second)
        yield* complete(retasked, 3)
        const running = yield* sessions.promptCosts({ sessionID: root.id, inputIDs: [first.inputID, second.inputID] })
        expect(running.units.find((unit) => unit.anchor.inputID === first.inputID)?.status).toBe("so-far")
        yield* Deferred.succeed(helperContinue, undefined)
        yield* Fiber.join(helper)
        yield* events.publish(SessionEvent.Task.Updated, { sessionID: subagent.id, change: { type: "completed" } })
        const prompts = yield* sessions.promptCosts({ sessionID: root.id, inputIDs: [first.inputID, second.inputID] })
        expect(prompts.units[0]).toMatchObject({
          anchor: first,
          status: "settled",
          attribution: "complete",
          history: "retained",
          total: { requests: 5, cost: { total: 12, known: 12, pricedRequests: 5, unpricedRequests: 0 } },
          main: { cost: { total: 1 } },
          children: { cost: { total: 11 } },
          helpers: [{ source: "title", cost: { total: 4 } }],
        })
        expect(prompts.units[1]).toMatchObject({ anchor: second, total: { requests: 1, cost: { total: 3 } } })
        expect(prompts.unattributed.requests).toBe(0)
        expect(Schema.decodeUnknownSync(UsageAccounting.PromptCosts)(prompts)).toEqual(prompts)
        const tasks = yield* sessions.taskCosts({ sessionID: root.id, sessionIDs: [subagent.id, nested.id] })
        expect(tasks.tasks[0]).toMatchObject({
          total: { requests: 4, cost: { total: 14 } },
          main: { cost: { total: 9 } },
          children: { cost: { total: 5 } },
        })
        expect(tasks.tasks[1]).toMatchObject({ total: { requests: 1, cost: { total: 5 } } })
        expect(tasks.total).toMatchObject({ requests: 4, cost: { total: 14 } })
        const report = yield* sessions.usageReport({ sessionID: subagent.id, group: "task" })
        expect(report.total).toMatchObject({ logical: 4, cost: 14 })
        expect(
          report.rows.find((row) => row.dimensions?.group === "task" && row.dimensions.sessionID === subagent.id)?.cost,
        ).toBe(Money.USD.make(14))
        yield* database.db.run(
          sql`DELETE FROM event WHERE type = ${EventRuntime.versionedType(SessionEvent.ProviderRequestRecorded.type, SessionEvent.ProviderRequestRecorded.durable.version)}`,
        )
        yield* database.db.run(sql`DELETE FROM session_message WHERE type = 'user'`)
        expect(yield* sessions.promptCosts({ sessionID: root.id, inputIDs: [first.inputID, second.inputID] })).toEqual(
          prompts,
        )
        expect(yield* sessions.taskCosts({ sessionID: root.id, sessionIDs: [subagent.id, nested.id] })).toEqual(tasks)
      }).pipe(Effect.provide(runtime), Effect.scoped),
    ),
  30_000,
)

test(
  "concurrent helpers and steps allocate distinct ledger requests and settle idempotently",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ location: { directory: AbsolutePath.make(tmpdir()) } })
        const anchor = yield* user(root.id, "work")
        const step = yield* begin(root.id)
        const helper = yield* begin(root.id, "decision")
        yield* complete(helper, 0)
        yield* complete(step, 1)
        yield* complete(step, 99)
        const report = yield* sessions.promptCosts({ sessionID: root.id, inputIDs: [anchor.inputID] })
        expect(report.units[0]).toMatchObject({
          total: { requests: 2, cost: { total: 1, pricedRequests: 2 } },
          helpers: [{ source: "decision", cost: { total: 0 } }],
        })
      }).pipe(Effect.provide(runtime), Effect.scoped),
    ),
  30_000,
)

test(
  "a later parent answer owns future child requests without moving an already started request",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const database = yield* Database.Service
        const orchestration = yield* SessionOrchestration.Service
        const events = yield* EventRuntime.Service
        const root = yield* sessions.create({ location: { directory: AbsolutePath.make(tmpdir()) } })
        const first = yield* user(root.id, "first")
        const subagent = yield* child(root.id, first, "answer")
        const existing = yield* begin(subagent.id)
        const waiting = yield* orchestration.question(subagent.id, "Which option?")
        const second = yield* user(root.id, "second")
        yield* orchestration.answer({
          parentID: root.id,
          childID: subagent.id,
          questionID: waiting.question!.id,
          text: "Continue",
        })
        yield* complete(existing, 2)
        yield* SessionPending.promoteSteers(database.db, events, subagent.id)
        const next = yield* begin(subagent.id)
        expect(next.usageAnchor).toEqual(second)
        yield* complete(next, 3)
        const costs = yield* sessions.promptCosts({ sessionID: root.id, inputIDs: [first.inputID, second.inputID] })
        expect(costs.units.map((unit) => unit.total.cost.known)).toEqual([Money.USD.make(2), Money.USD.make(3)])
        expect((yield* sessions.taskCosts({ sessionID: root.id, sessionIDs: [subagent.id] })).total.cost.known).toBe(
          Money.USD.make(5),
        )
      }).pipe(Effect.provide(runtime), Effect.scoped),
    ),
  30_000,
)

test(
  "forks and committed reverts leave backend analytics unchanged while new fork work receives its own user anchor",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ location: { directory: AbsolutePath.make(tmpdir()) } })
        const first = yield* user(root.id, "first")
        yield* complete(yield* begin(root.id, "step", first.inputID), 1)
        const second = yield* user(root.id, "second")
        yield* complete(yield* begin(root.id, "step", second.inputID), 2)
        const before = yield* sessions.usageReportAll({ group: "provider-model" })
        const fork = yield* sessions.fork({ sessionID: root.id, messageID: second.inputID })
        expect(yield* sessions.usageReportAll({ group: "provider-model" })).toEqual(before)
        yield* sessions.revert.stage({ sessionID: root.id, messageID: second.inputID, files: false })
        yield* sessions.revert.commit(root.id)
        expect(yield* sessions.usageReportAll({ group: "provider-model" })).toEqual(before)
        const forkInput = yield* user(fork.id, "fork work")
        const request = yield* begin(fork.id)
        expect(request.usageAnchor).toEqual(forkInput)
        yield* complete(request, 4)
        expect((yield* sessions.usageReportAll({ group: "provider-model" })).total).toMatchObject({
          logical: 3,
          cost: 7,
        })
      }).pipe(Effect.provide(runtime), Effect.scoped),
    ),
  30_000,
)

test(
  "interrupted nested helpers retain partial costs and their request-start task ancestry",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ location: { directory: AbsolutePath.make(tmpdir()) } })
        const anchor = yield* user(root.id, "work")
        const parent = yield* child(root.id, anchor, "cancel_parent")
        const nested = yield* child(parent.id, anchor, "cancel_nested")
        const tracker = yield* begin(nested.id, "prediction")
        const entered = yield* Deferred.make<void>()
        const fiber = yield* Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(complete(tracker, 6)),
          Effect.forkChild,
        )
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
        const prompts = yield* sessions.promptCosts({ sessionID: root.id, inputIDs: [anchor.inputID] })
        expect(prompts.units[0]).toMatchObject({
          total: { requests: 1, cost: { known: 6 } },
          helpers: [{ source: "prediction", cost: { known: 6 } }],
        })
        const tasks = yield* sessions.taskCosts({ sessionID: root.id, sessionIDs: [parent.id, nested.id] })
        expect(tasks.tasks.map((task) => task.total.cost.known)).toEqual([Money.USD.make(6), Money.USD.make(6)])
        expect(tasks.total).toMatchObject({ requests: 1, cost: { known: 6 } })
        const report = yield* sessions.usageReportAll({ group: "task" })
        expect(report.total).toMatchObject({ logical: 1, cost: 6 })
        expect(report.rows.map((row) => row.cost)).toEqual([Money.USD.make(6), Money.USD.make(6)])
      }).pipe(Effect.provide(runtime), Effect.scoped),
    ),
  30_000,
)

test(
  "compaction in a non-task helper Session retains its owner's task ancestry",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ location: { directory: AbsolutePath.make(tmpdir()) } })
        const anchor = yield* user(root.id, "work")
        const owner = yield* child(root.id, anchor, "compaction_owner")
        const helper = yield* sessions.create({ parentID: owner.id })
        const tracker = yield* SessionUsageAttribution.withAnchor(helper.id, anchor, begin(helper.id, "compaction"))
        yield* complete(tracker, 3)
        yield* complete(yield* begin(owner.id), 0)
        expect((yield* sessions.taskCosts({ sessionID: root.id, sessionIDs: [owner.id] })).total).toMatchObject({
          requests: 2,
          cost: { known: 3 },
        })
        for (const report of [
          yield* sessions.usageReportAll({ group: "task" }),
          yield* sessions.usageReport({ sessionID: root.id, group: "task" }),
        ]) {
          expect(report.total).toMatchObject({ logical: 2, cost: 3 })
          expect(report.rows).toHaveLength(1)
          expect(report.rows[0]?.logical).toBe(2)
          expect(report.rows.map((row) => row.cost)).toEqual([Money.USD.make(3)])
        }
      }).pipe(Effect.provide(runtime), Effect.scoped),
    ),
  30_000,
)

test(
  "a helper completing after movement keeps its request-start analytics Location",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const database = yield* Database.Service
        const root = yield* sessions.create({ location: { directory: AbsolutePath.make(tmpdir()) } })
        yield* user(root.id, "work")
        const tracker = yield* begin(root.id, "prediction")
        yield* database.db.run(sql`UPDATE session SET directory = '/during-request' WHERE id = ${root.id}`)
        yield* complete(tracker, 1)
        const range = { from: Date.now() - 3_600_000, to: Date.now() + 1 }
        const before = yield* SessionUsageRead.localUsage(database, {
          ...range,
          scope: { type: "location", location: root.location },
        })
        const moved = yield* SessionUsageRead.localUsage(database, {
          ...range,
          scope: { type: "location", location: { directory: AbsolutePath.make("/during-request") } },
        })
        expect(before.reduce((total, bin) => total + bin.requests, 0)).toBe(1)
        expect(moved).toEqual([])
      }).pipe(Effect.provide(runtime), Effect.scoped),
    ),
  30_000,
)

test(
  "new dimensions aggregate selected efforts and separate weighted speed, exact request percentiles and pricing coverage",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const events = yield* EventRuntime.Service
        const root = yield* sessions.create({ location: { directory: AbsolutePath.make(tmpdir()) } })
        const anchor = yield* user(root.id, "statistics")
        const timing = [
          { generatedTokens: 10, generationDurationNs: 1_000_000_000 },
          { generatedTokens: 40, observedGenerationDurationNs: 2_000_000_000 },
          { generatedTokens: 100, generationDurationNs: 1_000_000_000 },
          { estimatedTokens: 999999, estimatedGenerationDurationNs: 1_000_000_000 },
        ]
        for (const [index, profile] of ["Work", "Work", "Work", "Work", "Personal", undefined].entries()) {
          const ref = Model.Ref.make({
            providerID: Provider.ID.make(index === 5 ? "q" : "p"),
            id: Model.ID.make("m"),
            profile,
            variant: Model.VariantID.make(index === 1 || index === 2 ? "high" : "low"),
          })
          yield* events.publish(SessionEvent.ProviderRequestRecorded, {
            id: ProviderRequest.ID.make(`prq_statistics_${index}`),
            sessionID: root.id,
            usageAnchor: anchor,
            inputID: anchor.inputID,
            agent: Agent.ID.make("build"),
            source: "step",
            model: ref,
            routeID: "route",
            promptCacheKey: "cache",
            systemDigest: "system",
            toolDigest: "tools",
            request: index + 1,
            attempts: 1,
            continuation: "full",
            invalidation: "first-request",
            tokens,
            time: DateTime.makeUnsafe(Date.now()),
            ...(index === 2 ? {} : { cost: Money.USD.make(index >= 4 ? index - 2 : index === 1 ? 1 : 0) }),
            ...(timing[index] ? { timing: timing[index] } : {}),
          })
        }
        const report = yield* sessions.usageReportAll({ group: "provider-model" })
        expect(report.rows).toHaveLength(2)
        expect(report.rows[0]).toMatchObject({
          dimensions: { group: "provider-model", providerID: "p", modelID: "m" },
          logical: 5,
          tokens: { input: 5, output: 10, reasoning: 15, cache: { read: 20, write: 25 } },
          cost: 3,
          costCoverage: { pricedRequests: 4, unpricedRequests: 1 },
          speed: {
            samples: 0,
            generationSamples: 3,
            providerTimedSamples: 2,
            observedSamples: 1,
            outputTokensPerSecond: 37.5,
            generationP50TokensPerSecond: 20,
            generationP90TokensPerSecond: 100,
          },
        })
        expect(report.rows[0]).not.toHaveProperty("model")
        expect(Schema.decodeUnknownSync(ProviderRequest.Report)(report)).toEqual(report)
        const filtered = yield* sessions.usageReportAll({
          group: "provider-profile-model",
          providerID: Provider.ID.make("p"),
          profile: "Work",
          selectedEffort: "high",
        })
        expect(filtered.rows).toHaveLength(1)
        expect(filtered.rows[0]).toMatchObject({
          logical: 2,
          dimensions: {
            group: "provider-profile-model",
            providerID: "p",
            modelID: "m",
            profile: "Work",
            profileState: "recorded",
          },
        })
        expect((yield* sessions.usageReportAll({ group: "model-id" })).rows).toHaveLength(1)
        const old = yield* sessions.usageReportAll({ group: "model" })
        expect(old.rows.every((row) => row.model !== undefined)).toBe(true)
        const prompt = (yield* sessions.promptCosts({ sessionID: root.id, inputIDs: [anchor.inputID] })).units[0]!
        expect(prompt.total.cost).toMatchObject({ known: 6, pricedRequests: 5, unpricedRequests: 1 })
        expect(prompt.total.cost).not.toHaveProperty("total")
      }).pipe(Effect.provide(runtime), Effect.scoped),
    ),
  30_000,
)

test(
  "unprovable historical ownership stays separate and never prices a newer user unit as complete",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const events = yield* EventRuntime.Service
        const root = yield* sessions.create({ location: { directory: AbsolutePath.make(tmpdir()) } })
        yield* events.publish(SessionEvent.ProviderRequestRecorded, {
          id: ProviderRequest.ID.make("prq_historical_unknown"),
          sessionID: root.id,
          agent: Agent.ID.make("build"),
          source: "title",
          model,
          routeID: "route",
          promptCacheKey: "cache",
          systemDigest: "system",
          toolDigest: "tools",
          request: 1,
          attempts: 1,
          continuation: "full",
          invalidation: "first-request",
          tokens,
          cost: Money.USD.make(7),
          time: DateTime.makeUnsafe(Date.now()),
        })
        const anchor = yield* user(root.id, "new")
        yield* complete(yield* begin(root.id), 0)
        const report = yield* sessions.promptCosts({ sessionID: root.id, inputIDs: [anchor.inputID] })
        expect(report.unattributed).toMatchObject({ requests: 1, cost: { known: 7 } })
        expect(report.units[0]).toMatchObject({ attribution: "partial", total: { requests: 1, cost: { known: 0 } } })
        expect(report.units[0]!.total.cost).not.toHaveProperty("total")
        const stranger = yield* sessions.create({ location: root.location })
        expect(
          (yield* sessions.taskCosts({ sessionID: root.id, sessionIDs: [stranger.id] }).pipe(Effect.exit))._tag,
        ).toBe("Failure")
      }).pipe(Effect.provide(runtime), Effect.scoped),
    ),
  30_000,
)
