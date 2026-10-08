import { describe, expect } from "bun:test"
import { DateTime, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { Database } from "@ycoding-ai/core/database/database"
import { Agent } from "@ycoding-ai/core/agent"
import { Catalog } from "@ycoding-ai/core/catalog"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionProviderRequest } from "@ycoding-ai/core/session/provider-request"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { Money } from "@ycoding-ai/schema/money"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { testEffect } from "./lib/effect"
import { eq } from "drizzle-orm"

const projects = Layer.succeed(
  Project.Service,
  Project.Service.of({
    list: () =>
      Effect.succeed([
        {
          id: Project.ID.make("report-other"),
          worktree: "/report-other",
          name: "Report other",
          time: { created: 0, updated: 0 },
          sandboxes: [],
        },
        {
          id: Project.ID.make("usage-first"),
          worktree: "/usage-first",
          name: "Usage first",
          time: { created: 0, updated: 0 },
          sandboxes: [],
        },
        {
          id: Project.ID.make("usage-second"),
          worktree: "/usage-second",
          time: { created: 0, updated: 0 },
          sandboxes: [],
        },
      ]),
    resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
    directories: () => Effect.succeed([]),
    recordOpened: () => Effect.void,
    commit: () => Effect.void,
  }),
)
const catalog = Layer.mock(Catalog.Service, {
  provider: { get: () => Effect.succeed(undefined), all: () => Effect.succeed([]), available: () => Effect.succeed([]) },
  model: {
    defaultSelection: () => Effect.succeed(undefined),
    forConnection: (model) => Effect.succeed(model),
    get: (providerID, modelID) => {
      const cost =
        providerID === Provider.ID.make("openai") && modelID === CatalogModel.ID.make("provider-priced")
          ? 2
          :
              providerID === Provider.ID.openrouter &&
                ["anthropic/fallback-priced", "openai/provider-priced"].includes(modelID)
            ? 20
            : undefined
      return Effect.succeed(
        cost === undefined
          ? undefined
          : {
              ...CatalogModel.Info.empty(providerID, modelID),
              cost: [
                {
                  input: Money.USDPerMillionTokens.make(cost),
                  output: Money.USDPerMillionTokens.make(cost * 4),
                  cache: { read: Money.USDPerMillionTokens.zero, write: Money.USDPerMillionTokens.zero },
                },
              ],
            },
      )
    },
    all: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
    default: () => Effect.succeed(undefined),
    small: () => Effect.succeed(undefined),
  },
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node, SessionStore.node, SessionProviderRequest.node, Catalog.node, Session.node]),
    [
      [Project.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
      [Catalog.node, catalog],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })

describe("Session.log", () => {
  it.effect("reads durable provider usage through the Session service", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const events = yield* EventRuntime.Service
      const created = yield* session.create({ location })
      yield* events.publish(SessionEvent.ProviderRequestRecorded, {
        id: ProviderRequest.ID.make("prq_session_usage"),
        sessionID: created.id,
        source: "step",
        agent: Agent.ID.make("build"),
        model: CatalogModel.Ref.make({
          providerID: Provider.ID.make("openai"),
          id: CatalogModel.ID.make("gpt-5.6"),
        }),
        routeID: "openai-responses",
        promptCacheKey: "cache-key",
        systemDigest: "system-digest",
        toolDigest: "tool-digest",
        request: 1,
        attempts: 2,
        invalidation: "first-request",
        continuation: "full",
        cost: Money.USD.make(0.125),
        tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } },
        time: yield* DateTime.now,
      })

      expect(yield* session.usage(created.id)).toMatchObject({
        logical: 1,
        physical: 2,
        cost: Money.USD.make(0.125),
        tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } },
        latestInvalidation: "first-request",
        latestNamespace: "cache-ke",
      })
    }),
  )

  it.effect("aggregates root families and estimates missing costs from provider then OpenRouter catalogs", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const events = yield* EventRuntime.Service
      const root = yield* session.create({ location })
      const child = yield* session.create({ parentID: root.id })
      const grandchild = yield* session.create({ parentID: child.id })
      const record = Effect.fnUntraced(function* (sessionID: Session.ID, id: string, providerID: string, model: string) {
        yield* events.publish(SessionEvent.ProviderRequestRecorded, {
          id: ProviderRequest.ID.make(`prq_${id}`),
          sessionID,
          source: "step",
          agent: Agent.ID.make("build"),
          model: CatalogModel.Ref.make({ providerID: Provider.ID.make(providerID), id: CatalogModel.ID.make(model) }),
          routeID: "test",
          promptCacheKey: `${id}-cache-key`,
          systemDigest: "system",
          toolDigest: "tools",
          request: 1,
          attempts: 1,
          invalidation: "first-request",
          continuation: "full",
          tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
          time: yield* DateTime.now,
        })
      })
      yield* record(root.id, "provider", "openai", "provider-priced")
      yield* record(child.id, "fallback", "anthropic", "fallback-priced")
      yield* record(grandchild.id, "missing", "custom", "missing")

      const rootUsage = yield* session.usage(root.id)
      expect(rootUsage).toMatchObject({ logical: 3 })
      expect(rootUsage.models).toMatchObject([
        expect.objectContaining({
          model: { providerID: "anthropic", id: "fallback-priced" },
          cost: Money.USD.make(0.028),
          costProvenance: "current_catalog",
        }),
        expect.objectContaining({
          model: { providerID: "openai", id: "provider-priced" },
          cost: Money.USD.make(0.0028),
          costProvenance: "current_catalog",
        }),
        expect.objectContaining({ model: { providerID: "custom", id: "missing" } }),
      ])
      expect(rootUsage.models?.find((item) => item?.model?.providerID === "custom")).not.toHaveProperty("cost")
      expect(rootUsage.cost).toBe(Money.USD.make(0.0308))
      expect(yield* session.usage(child.id)).toMatchObject({
        logical: 1,
        cost: Money.USD.make(0.028),
        models: [{ costProvenance: "current_catalog" }],
      })
    }),
  )

  it.effect("decision requests remain unpriced even when a chat catalog model has the same identity", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const events = yield* EventRuntime.Service
      const created = yield* session.create({ location })
      yield* events.publish(SessionEvent.ProviderRequestRecorded, {
        id: ProviderRequest.ID.make("prq_decision_unpriced"), sessionID: created.id, source: "decision",
        agent: Agent.ID.make("build"), model: CatalogModel.Ref.make({ providerID: Provider.ID.make("openai"), id: CatalogModel.ID.make("provider-priced") }),
        routeID: "openai-decisions", promptCacheKey: "decision", systemDigest: "system", toolDigest: "tools",
        request: 1, attempts: 1, invalidation: "cache-disabled", continuation: "full",
        tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }, time: yield* DateTime.now,
      })
      const usage = yield* session.usage(created.id)
      expect(usage.logical).toBe(1)
      expect(usage.cost).toBeUndefined()
      expect(usage.models?.[0].cost).toBeUndefined()
      const report = yield* session.usageReport({ sessionID: created.id, group: "model" })
      expect(report.total.cost).toBeUndefined()
      expect(report.rows[0].cost).toBeUndefined()
    }),
  )

  it.effect("reports family usage by model, agent, session, and project without leaking ledger internals", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const events = yield* EventRuntime.Service
      const database = yield* Database.Service
      const root = yield* session.create({ location, title: "Root report" })
      const child = yield* session.create({ parentID: root.id, title: "Child report" })
      const grandchild = yield* session.create({ parentID: child.id, title: "Grandchild report" })
      const otherProject = Project.ID.make("report-other")
      yield* database.db
        .insert(ProjectTable)
        .values({ id: otherProject, worktree: AbsolutePath.make("/report-other"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .update(SessionTable)
        .set({ project_id: otherProject })
        .where(eq(SessionTable.id, child.id))
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .update(SessionTable)
        .set({ project_id: otherProject })
        .where(eq(SessionTable.id, grandchild.id))
        .run()
        .pipe(Effect.orDie)
      const record = Effect.fnUntraced(function* (input: {
        sessionID: Session.ID
        id: string
        source: ProviderRequest.Source
        agent: string
        providerID: string
        model: string
        attempts: number
        continuation: ProviderRequest.Continuation
        cacheReadReported: boolean
        cost?: Money.USD
        tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
        time: number
      }) {
        yield* events.publish(SessionEvent.ProviderRequestRecorded, {
          id: ProviderRequest.ID.make(`prq_${input.id}`),
          sessionID: input.sessionID,
          source: input.source,
          agent: Agent.ID.make(input.agent),
          model: CatalogModel.Ref.make({
            providerID: Provider.ID.make(input.providerID),
            id: CatalogModel.ID.make(input.model),
          }),
          routeID: `secret-route-${input.id}`,
          promptCacheKey: `secret-cache-${input.id}`,
          systemDigest: `secret-system-${input.id}`,
          toolDigest: `secret-tools-${input.id}`,
          request: 1,
          attempts: input.attempts,
          invalidation: "first-request",
          continuation: input.continuation,
          cacheReadReported: input.cacheReadReported,
          ...(input.cost === undefined ? {} : { cost: input.cost }),
          tokens: input.tokens ?? { input: 1_000, output: 100, reasoning: 25, cache: { read: 50, write: 10 } },
          time: DateTime.makeUnsafe(input.time),
        })
      })
      yield* record({
        sessionID: root.id,
        id: "root",
        source: "step",
        agent: "build",
        providerID: "openai",
        model: "recorded-priced",
        attempts: 2,
        continuation: "full",
        cacheReadReported: true,
        cost: Money.USD.make(0.1),
        tokens: { input: 3_000, output: 30, reasoning: 3, cache: { read: 1, write: 10 } },
        time: Date.UTC(2026, 0, 31, 23, 59, 59, 999),
      })
      yield* record({
        sessionID: child.id,
        id: "child",
        source: "goal",
        agent: "review",
        providerID: "openai",
        model: "provider-priced",
        attempts: 1,
        continuation: "continued",
        cacheReadReported: true,
        tokens: { input: 1_000, output: 10, reasoning: 1, cache: { read: 2, write: 20 } },
        time: Date.UTC(2026, 1, 1),
      })
      yield* record({
        sessionID: grandchild.id,
        id: "grandchild",
        source: "step",
        agent: "build",
        providerID: "custom",
        model: "missing",
        attempts: 3,
        continuation: "fallback",
        cacheReadReported: false,
        tokens: { input: 2_000, output: 20, reasoning: 2, cache: { read: 3, write: 30 } },
        time: Date.UTC(2026, 1, 1, 1),
      })

      const byModel = yield* session.usageReport({ sessionID: root.id, group: "model" })
      expect(byModel.rowCount).toBe(3)
      expect(byModel.rows.map((row) => row.key)).toEqual([
        "custom/missing",
        "openai/provider-priced",
        "openai/recorded-priced",
      ])
      expect(byModel.total).toMatchObject({
        logical: 3,
        physical: 6,
        helpers: 1,
        continued: 1,
        fallback: 1,
        cacheReadReported: false,
        tokens: { input: 6_000, output: 60, reasoning: 6, cache: { read: 6, write: 60 } },
      })
      expect(byModel.total.cost).toBeCloseTo(0.102088, 8)
      expect(byModel.total.costProvenance).toBe("current_catalog")
      expect(byModel.rows.find((row) => row.label.includes("recorded-priced"))).toMatchObject({
        cost: Money.USD.make(0.1),
        costProvenance: "recorded",
      })
      expect(byModel.rows.find((row) => row.label.includes("provider-priced"))).toMatchObject({
        cost: Money.USD.make(0.002088),
        costProvenance: "current_catalog",
      })
      expect(byModel.rows.find((row) => row.label.includes("missing"))).not.toHaveProperty("cost")
      for (const sort of ["steps", "input", "output", "reasoning", "cacheRead", "cacheWrite"] as const) {
        expect(
          (yield* session.usageReport({ sessionID: root.id, group: "agent", sort, order: "asc" })).rows.map((row) => row.key),
        ).toEqual(["review", "build"])
        expect(
          (yield* session.usageReport({ sessionID: root.id, group: "agent", sort, order: "desc" })).rows.map((row) => row.key),
        ).toEqual(["build", "review"])
      }
      expect(
        (yield* session.usageReport({ sessionID: root.id, group: "model", sort: "cost", order: "asc" })).rows.map(
          (row) => row.key,
        ),
      ).toEqual(["custom/missing", "openai/provider-priced", "openai/recorded-priced"])
      expect(
        (yield* session.usageReport({ sessionID: root.id, group: "model", sort: "cost", order: "desc" })).rows.map(
          (row) => row.key,
        ),
      ).toEqual(["openai/recorded-priced", "openai/provider-priced", "custom/missing"])
      const serialized = JSON.stringify(byModel)
      for (const secret of ["secret-route", "secret-cache", "secret-system", "secret-tools", '"models"'])
        expect(serialized).not.toContain(secret)

      expect(yield* session.usageReport({ sessionID: root.id, group: "agent" })).toMatchObject({
        rowCount: 2,
        rows: [{ key: "build" }, { key: "review" }],
      })
      expect((yield* session.usageReport({ sessionID: root.id, group: "agent" })).rows[0]).toMatchObject({
        key: "build",
        cost: Money.USD.make(0.1),
        costProvenance: "recorded",
      })
      expect(yield* session.usageReport({ sessionID: root.id, group: "session" })).toMatchObject({ rowCount: 3 })
      expect(yield* session.usageReport({ sessionID: root.id, group: "project" })).toMatchObject({
        rowCount: 2,
        rows: [
          { key: "global", label: "Global (no project)", logical: 1 },
          { key: "report-other", label: "Report other · /report-other", logical: 2 },
        ],
      })
      expect(yield* session.usageReport({ sessionID: child.id, group: "session" })).toMatchObject({
        rowCount: 1,
        total: { logical: 1 },
        rows: [{ key: child.id }],
      })
    }),
  )

  it.effect("uses UTC buckets, exclusive upper bounds, and page-independent totals", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const events = yield* EventRuntime.Service
      const created = yield* session.create({ location })
      const times = [
        Date.UTC(2026, 0, 31, 23, 59, 59, 999),
        Date.UTC(2026, 1, 1),
        Date.UTC(2026, 1, 1, 0, 59, 59, 999),
        Date.UTC(2026, 1, 1, 1),
      ]
      yield* Effect.forEach(times, (time, index) =>
        events.publish(SessionEvent.ProviderRequestRecorded, {
          id: ProviderRequest.ID.make(`prq_time_${index}`),
          sessionID: created.id,
          source: "step",
          agent: Agent.ID.make("build"),
          model: CatalogModel.Ref.make({ providerID: Provider.ID.make("custom"), id: CatalogModel.ID.make("missing") }),
          routeID: "private-route",
          promptCacheKey: "private-cache",
          systemDigest: "private-system",
          toolDigest: "private-tools",
          request: index + 1,
          attempts: 1,
          invalidation: "first-request",
          continuation: "full",
          cacheReadReported: true,
          tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
          time: DateTime.makeUnsafe(time),
        }),
      )

      expect(yield* session.usageReport({ sessionID: created.id, group: "day" })).toMatchObject({
        rows: [{ key: "2026-01-31", logical: 1 }, { key: "2026-02-01", logical: 3 }],
      })
      expect(yield* session.usageReport({ sessionID: created.id, group: "month" })).toMatchObject({
        rows: [{ key: "2026-01", logical: 1 }, { key: "2026-02", logical: 3 }],
      })
      const page = yield* session.usageReport({ sessionID: created.id, group: "hour", offset: 1, limit: 1 })
      expect(page).toMatchObject({
        rowCount: 3,
        nextOffset: 2,
        rows: [{ key: "2026-02-01T00:00:00.000Z", logical: 2 }],
        total: { logical: 4, cacheReadReported: true },
      })
      expect(page.total).not.toHaveProperty("cost")
      expect(
        (yield* session.usageReport({
          sessionID: created.id,
          group: "hour",
          sort: "tokens",
          order: "desc",
          limit: 2,
        })),
      ).toMatchObject({
        rowCount: 3,
        nextOffset: 2,
        rows: [{ key: "2026-02-01T00:00:00.000Z" }, { key: "2026-01-31T23:00:00.000Z" }],
        total: { logical: 4 },
      })
      expect(
        (yield* session.usageReport({
          sessionID: created.id,
          group: "hour",
          sort: "tokens",
          order: "asc",
          limit: 2,
        })).rows.map((row) => row.key),
      ).toEqual(["2026-01-31T23:00:00.000Z", "2026-02-01T01:00:00.000Z"])
      expect(yield* session.usageReport({
        sessionID: created.id,
        group: "hour",
        from: Date.UTC(2026, 1, 1),
        to: Date.UTC(2026, 1, 1, 1),
      })).toMatchObject({
        rowCount: 1,
        rows: [{ key: "2026-02-01T00:00:00.000Z", logical: 2 }],
        total: { logical: 2 },
      })
    }),
  )

  it.effect("reports retained usage across independent roots, children, projects, locations, and archives", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const events = yield* EventRuntime.Service
      const database = yield* Database.Service
      const secondLocation = Location.Ref.make({ directory: AbsolutePath.make(`${process.cwd()}/..`) })
      const firstRoot = yield* session.create({ location, title: "First root" })
      const child = yield* session.create({ parentID: firstRoot.id, title: "Archived child" })
      const secondRoot = yield* session.create({ location: secondLocation, title: "Second root" })
      const firstProject = Project.ID.make("usage-first")
      const secondProject = Project.ID.make("usage-second")
      yield* database.db
        .insert(ProjectTable)
        .values([
          { id: firstProject, worktree: AbsolutePath.make("/usage-first"), sandboxes: [] },
          { id: secondProject, worktree: AbsolutePath.make("/usage-second"), sandboxes: [] },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .update(SessionTable)
        .set({ project_id: firstProject })
        .where(eq(SessionTable.id, firstRoot.id))
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .update(SessionTable)
        .set({ project_id: firstProject })
        .where(eq(SessionTable.id, child.id))
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .update(SessionTable)
        .set({ project_id: secondProject })
        .where(eq(SessionTable.id, secondRoot.id))
        .run()
        .pipe(Effect.orDie)
      const times = [Date.UTC(2026, 2, 1), Date.UTC(2026, 2, 2), Date.UTC(2026, 2, 3)]
      yield* Effect.forEach(
        [
          { sessionID: firstRoot.id, id: "first", input: 10, time: times[0]!, cost: Money.USD.make(0.3) },
          { sessionID: child.id, id: "child", input: 30, time: times[1]!, cost: Money.USD.make(0.1) },
          { sessionID: secondRoot.id, id: "second", input: 20, time: times[2]!, cost: undefined },
        ],
        (item) =>
          events.publish(SessionEvent.ProviderRequestRecorded, {
            id: ProviderRequest.ID.make(`prq_global_${item.id}`),
            sessionID: item.sessionID,
            source: "step",
            agent: Agent.ID.make("build"),
            model: CatalogModel.Ref.make({
              providerID: Provider.ID.make("openai"),
              id: CatalogModel.ID.make("provider-priced"),
            }),
            routeID: "private-route",
            promptCacheKey: "private-cache",
            systemDigest: "private-system",
            toolDigest: "private-tools",
            request: 1,
            attempts: 1,
            invalidation: "first-request",
            continuation: "full",
            ...(item.cost === undefined ? {} : { cost: item.cost }),
            tokens: { input: item.input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: DateTime.makeUnsafe(item.time),
          }),
      )
      yield* session.archive(child.id)

      const requests = yield* SessionProviderRequest.Service
      expect((yield* requests.listAll({ from: times[1], to: times[2] })).map((record) => record.id)).toEqual([ProviderRequest.ID.make("prq_global_child")])

      expect(yield* session.usageAll()).toMatchObject({ logical: 3, physical: 3 })
      expect(yield* session.usageReportAll({ group: "project" })).toMatchObject({
        rowCount: 2,
        rows: [
          { key: firstProject, label: "Usage first · /usage-first", logical: 2 },
          { key: secondProject, label: "/usage-second", logical: 1, costProvenance: "current_catalog" },
        ],
        total: { logical: 3 },
      })
      expect(yield* session.usageReportAll({ group: "session", sort: "tokens", order: "desc", limit: 2 })).toMatchObject({
        rowCount: 3,
        nextOffset: 2,
        rows: [{ key: child.id }, { key: secondRoot.id }],
        total: { logical: 3, tokens: { input: 60 } },
      })
      expect(yield* session.usageReportAll({
        group: "day",
        from: times[1],
        to: times[2] + 1,
        offset: 1,
        limit: 1,
      })).toMatchObject({
        rowCount: 2,
        rows: [{ key: "2026-03-03" }],
        total: { logical: 2, tokens: { input: 50 } },
      })
    }),
  )

  it.effect("groups local usage through a DST transition and a non-hour-offset day and month boundary", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const events = yield* EventRuntime.Service
      const created = yield* session.create({ location })
      const times = [
        Date.UTC(2026, 2, 8, 4, 30), Date.UTC(2026, 2, 8, 5, 30),
        Date.UTC(2026, 2, 9, 3, 30), Date.UTC(2026, 2, 9, 4, 30),
        Date.UTC(2027, 2, 8, 18, 14), Date.UTC(2027, 2, 8, 18, 15),
        Date.UTC(2027, 3, 30, 18, 14), Date.UTC(2027, 3, 30, 18, 15),
        Date.UTC(2026, 9, 25, 0, 30), Date.UTC(2026, 9, 25, 1, 30),
      ]
      yield* Effect.forEach(times, (time, index) => events.publish(SessionEvent.ProviderRequestRecorded, {
        id: ProviderRequest.ID.make(`prq_zoned_${index}`),
        sessionID: created.id,
        source: "step",
        agent: Agent.ID.make("build"),
        model: CatalogModel.Ref.make({ providerID: Provider.ID.make("openai"), id: CatalogModel.ID.make("provider-priced") }),
        routeID: "test-route",
        promptCacheKey: "test-cache",
        systemDigest: "test-system",
        toolDigest: "test-tools",
        request: index + 1,
        attempts: 1,
        invalidation: "first-request",
        continuation: "full",
        tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: DateTime.makeUnsafe(time),
      }))

      const spring = { group: "day" as const, from: Date.UTC(2026, 2, 8, 5), to: Date.UTC(2026, 2, 9, 4) }
      expect(yield* session.usageAll()).toEqual(yield* session.usage(created.id))
      expect(yield* session.usageReportAll(spring)).toEqual(yield* session.usageReport({ sessionID: created.id, ...spring }))
      const berlin = { group: "hour" as const, timeZone: "Europe/Berlin", from: times[8], to: times[9]! + 1 }
      expect(yield* session.usageReportAll(berlin)).toEqual(yield* session.usageReport({ sessionID: created.id, ...berlin }))
      expect((yield* session.usageReportAll({ ...spring, timeZone: "America/New_York" })).rows.map((row) => [row.key, row.logical])).toEqual([["2026-03-08", 2]])
      expect((yield* session.usageReportAll(spring)).rows.map((row) => row.key)).toEqual(["2026-03-08", "2026-03-09"])
      expect((yield* session.usageReportAll({ group: "day", timeZone: "Asia/Kathmandu", from: times[4], to: times[5]! + 1 })).rows.map((row) => row.key)).toEqual(["2027-03-08", "2027-03-09"])
      expect((yield* session.usageReportAll({ group: "month", timeZone: "Asia/Kathmandu", from: times[6], to: times[7]! + 1 })).rows.map((row) => row.key)).toEqual(["2027-04", "2027-05"])
      expect((yield* session.usageReportAll(berlin)).rows.map((row) => row.key)).toEqual([
        "2026-10-25T02:00:00+02:00", "2026-10-25T02:00:00+01:00",
      ])
    }),
  )

  it.effect("replays public session events and marks synced at the aggregate watermark", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const events = yield* EventRuntime.Service
      const created = yield* session.create({ location })
      yield* events.publish(SessionEvent.ProviderRequestRecorded, {
        id: ProviderRequest.ID.make("prq_hidden_log_record"),
        sessionID: created.id,
        source: "step",
        agent: Agent.ID.make("build"),
        model: CatalogModel.Ref.make({
          providerID: Provider.ID.make("openai"),
          id: CatalogModel.ID.make("gpt-5.6"),
        }),
        routeID: "openai-responses",
        promptCacheKey: "prompt-cache-secret-that-must-not-reach-the-public-log",
        systemDigest: "system-secret",
        toolDigest: "tool-secret",
        request: 1,
        attempts: 1,
        invalidation: "first-request",
        continuation: "full",
        cost: Money.USD.zero,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        time: yield* DateTime.now,
      })
      yield* session.rename({ sessionID: created.id, title: "session.renamed" })

      const items = Array.from(yield* Stream.runCollect(session.log({ sessionID: created.id })))
      const watermark = (yield* events.sequences([created.id])).get(created.id)

      expect(items.map((item) => item.type)).toEqual(["session.created", "session.renamed", "log.synced"])
      expect(JSON.stringify(items)).not.toContain("prompt-cache-secret")
      expect(items.at(-1)).toEqual({ type: "log.synced", aggregateID: created.id, seq: watermark })
    }),
  )

  it.effect("continues with live public events when following", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ location })
      const fiber = yield* session
        .log({ sessionID: created.id, follow: true })
        .pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* session.rename({ sessionID: created.id, title: "renamed live" })

      const items = Array.from(yield* Fiber.join(fiber))
      expect(items.map((item) => item.type)).toEqual(["session.created", "log.synced", "session.renamed"])
    }),
  )

  it.effect("fails with NotFound for an unknown session", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const error = yield* Effect.flip(Stream.runCollect(session.log({ sessionID: Session.ID.create() })))
      expect(error._tag).toBe("Session.NotFoundError")
    }),
  )

  it.effect("reads across undecodable gaps in aggregate order and marks the true log position", () =>
    Effect.gen(function* () {
      const GapEvent = EventRuntime.durable({
        type: "test.session.log.gap",
        durable: { aggregate: "sessionID", version: 1 },
        schema: { sessionID: Session.ID, value: Schema.String },
      })
      const session = yield* Session.Service
      const events = yield* EventRuntime.Service
      const created = yield* session.create({ location })
      yield* session.switchAgent({ sessionID: created.id, agent: Agent.ID.make("one") })
      // Not in the durable manifest, so reads must skip it without failing.
      yield* events.publish(GapEvent, { sessionID: created.id, value: "filtered" })
      yield* session.switchAgent({ sessionID: created.id, agent: Agent.ID.make("two") })
      yield* session.switchAgent({ sessionID: created.id, agent: Agent.ID.make("three") })

      const items = Array.from(yield* Stream.runCollect(session.log({ sessionID: created.id, after: 1 })))

      expect(
        items.map((item): number | string | undefined => (EventRuntime.isSynced(item) ? item.type : item.durable?.seq)),
      ).toEqual([3, 4, "log.synced"])
      expect(items.at(-1)).toEqual({ type: "log.synced", aggregateID: created.id, seq: EventRuntime.Seq.make(4) })
    }),
  )

  it.effect("completes with a bare synced marker for a migrated Session with no event sequence", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const session = yield* Session.Service
      const sessionID = Session.ID.make("ses_empty_log")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          directory: "/project",
          title: "Empty log",
        })
        .run()

      const items = Array.from(yield* Stream.runCollect(session.log({ sessionID })))

      expect(items).toEqual([{ type: "log.synced", aggregateID: sessionID }])
    }),
  )
})
