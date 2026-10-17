import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@ycoding-ai/core/database/database"
import { Agent } from "@ycoding-ai/core/agent"
import { Catalog } from "@ycoding-ai/core/catalog"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { Project } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionProviderRequest } from "@ycoding-ai/core/session/provider-request"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { Money } from "@ycoding-ai/schema/money"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { SessionMessage } from "@ycoding-ai/schema/session-message"
import { testEffect } from "./lib/effect"

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
const catalog = Layer.mock(Catalog.Service, {
  provider: {
    get: () => Effect.succeed(undefined),
    all: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
  },
  model: {
    defaultSelection: () => Effect.succeed(undefined),
    forConnection: (model) => Effect.succeed(model),
    get: (providerID, modelID) =>
      Effect.succeed(
        providerID === Provider.ID.make("openai") && modelID === CatalogModel.ID.make("provider-priced")
          ? {
              ...CatalogModel.Info.empty(providerID, modelID),
              cost: [
                {
                  input: Money.USDPerMillionTokens.make(2),
                  output: Money.USDPerMillionTokens.make(8),
                  cache: { read: Money.USDPerMillionTokens.zero, write: Money.USDPerMillionTokens.zero },
                },
              ],
            }
          : undefined,
      ),
    all: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
    default: () => Effect.succeed(undefined),
    small: () => Effect.succeed(undefined),
  },
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventRuntime.node,
      SessionProjector.node,
      SessionStore.node,
      SessionProviderRequest.node,
      Catalog.node,
      Session.node,
    ]),
    [
      [Project.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
      [Catalog.node, catalog],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })
const tokens = { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }
const rootID = Session.ID.make("ses_dim_root")
const childID = Session.ID.make("ses_dim_child")
const nestedID = Session.ID.make("ses_dim_nested")
const helperID = Session.ID.make("ses_dim_helper")
const childInput = SessionMessage.ID.make("msg_dim_child_input")
const reply = SessionMessage.ID.make("msg_dim_reply")
const ref = (providerID: string, id: string, variant: string, profile?: string) =>
  CatalogModel.Ref.make({
    providerID: Provider.ID.make(providerID),
    id: CatalogModel.ID.make(id),
    variant: CatalogModel.VariantID.make(variant),
    ...(profile === undefined ? {} : { profile }),
  })
const launch = (sessionID: Session.ID, parentID: Session.ID, inputID: SessionMessage.ID) =>
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    yield* events.publish(SessionEvent.Task.Updated, {
      sessionID,
      change: {
        type: "launched",
        parentID,
        parentAssistantMessageID: reply,
        toolCallID: `call_${sessionID}`,
        inputID,
        description: sessionID,
        agent: Agent.ID.make("build"),
        model: ref("p", "m", "low"),
        promptDigest: "digest",
        background: true,
        delivery: "steer",
      },
    })
  })

const fixture = Effect.gen(function* () {
  const session = yield* Session.Service
  const events = yield* EventRuntime.Service
  const database = yield* Database.Service
  yield* session.create({ id: rootID, location })
  const first = yield* session.prompt({ sessionID: rootID, text: "first", resume: false })
  yield* SessionPending.promoteSteers(database.db, events, rootID)
  yield* database.db.run(sql`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    SELECT ${reply}, ${rootID}, 'assistant', max(seq) + 1, 0, 0, '{}' FROM session_message WHERE session_id = ${rootID}
  `)
  yield* session.create({ id: childID, parentID: rootID })
  yield* launch(childID, rootID, childInput)
  yield* session.create({ id: nestedID, parentID: childID })
  yield* launch(nestedID, childID, SessionMessage.ID.make("msg_dim_nested_input"))
  yield* session.create({ id: helperID, parentID: childID })
  const requests = [
    {
      sessionID: rootID,
      request: 1,
      inputID: first.id,
      model: ref("p", "m", "low", "Work"),
      cost: 0,
      timing: { firstOutputMs: 5, generatedTokens: 10, generationDurationNs: 1_000_000_000 },
    },
    {
      sessionID: rootID,
      request: 2,
      inputID: first.id,
      model: ref("p", "m", "high", "Work"),
      cost: 1,
      timing: { generatedTokens: 40, observedGenerationDurationNs: 2_000_000_000 },
    },
    {
      sessionID: childID,
      request: 1,
      inputID: childInput,
      model: ref("p", "m", "high", "Work"),
      timing: { generatedTokens: 100, generationDurationNs: 1_000_000_000 },
    },
    {
      sessionID: childID,
      request: 2,
      inputID: childInput,
      model: ref("p", "m", "low", "Work"),
      cost: 0,
      timing: { estimatedTokens: 999_999, estimatedGenerationDurationNs: 1_000_000_000 },
    },
    { sessionID: nestedID, request: 1, model: ref("p", "m", "low", "Personal"), cost: 2 },
    { sessionID: helperID, request: 1, source: "compaction" as const, model: ref("q", "m", "low"), cost: 3 },
    {
      sessionID: rootID,
      request: 3,
      source: "title" as const,
      model: CatalogModel.Ref.make({
        providerID: Provider.ID.make("openai"),
        id: CatalogModel.ID.make("provider-priced"),
      }),
    },
  ]
  for (const item of requests)
    yield* events.publish(SessionEvent.ProviderRequestRecorded, {
      id: ProviderRequest.ID.make(`prq_dim_${item.sessionID}_${item.request}`),
      sessionID: item.sessionID,
      ...("inputID" in item ? { inputID: item.inputID } : {}),
      source: item.source ?? "step",
      agent: Agent.ID.make("build"),
      model: item.model,
      routeID: "test",
      promptCacheKey: "cache",
      systemDigest: "system",
      toolDigest: "tools",
      request: item.request,
      attempts: 1,
      invalidation: "first-request",
      continuation: "full",
      tokens,
      ...(item.cost === undefined ? {} : { cost: Money.USD.make(item.cost) }),
      ...("timing" in item ? { timing: item.timing } : {}),
      time: DateTime.makeUnsafe(0),
    })
  return { first: first.id }
})

const shape = (report: ProviderRequest.Report) =>
  report.rows.map((row) => ({ key: row.key, label: row.label, dimensions: row.dimensions, logical: row.logical }))

const typed = (report: ProviderRequest.Report) => {
  expect(Schema.decodeUnknownSync(ProviderRequest.Report)(report)).toEqual(report)
  report.rows.forEach((row) => expect(row).not.toHaveProperty("model"))
  expect(report.rowCount).toBe(report.rows.length)
}

describe("Session usage dimensions", () => {
  it.effect("provider/model rows separate weighted speed, exact request percentiles, and pricing coverage", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      yield* fixture
      const report = yield* session.usageReportAll({ group: "provider-model" })
      typed(report)
      expect(report.rows.map((row) => row.key)).toEqual([
        JSON.stringify(["provider-model", "openai", "provider-priced"]),
        JSON.stringify(["provider-model", "p", "m"]),
        JSON.stringify(["provider-model", "q", "m"]),
      ])
      const priced = report.rows[0]!
      expect(priced).toMatchObject({
        label: "openai/provider-priced",
        dimensions: { group: "provider-model", providerID: "openai", modelID: "provider-priced" },
        logical: 1,
        costProvenance: "current_catalog",
        costCoverage: { pricedRequests: 1, unpricedRequests: 0 },
      })
      expect(priced.cost).toBeGreaterThan(0)
      expect(priced).not.toHaveProperty("speed")
      expect(report.rows[1]).toMatchObject({
        label: "p/m",
        dimensions: { group: "provider-model", providerID: "p", modelID: "m" },
        logical: 5,
        tokens: { input: 5, output: 10, reasoning: 15, cache: { read: 20, write: 25 } },
        cost: 3,
        costProvenance: "recorded",
        costCoverage: { pricedRequests: 4, unpricedRequests: 1 },
      })
      expect(report.rows[1]?.speed).toEqual({
        samples: 1,
        firstOutputP50Ms: 5,
        firstOutputP95Ms: 5,
        generationSamples: 3,
        providerTimedSamples: 2,
        observedSamples: 1,
        generationP50TokensPerSecond: 20,
        generationP90TokensPerSecond: 100,
        outputTokensPerSecond: 37.5,
      })
      expect(report.rows[2]).toMatchObject({
        label: "q/m",
        dimensions: { group: "provider-model", providerID: "q", modelID: "m" },
        logical: 1,
        cost: 3,
      })
      expect(report.total).toMatchObject({
        logical: 7,
        costProvenance: "current_catalog",
        costCoverage: { pricedRequests: 6, unpricedRequests: 1 },
      })
    }),
  )

  it.effect("provider, model ID, profile, and provider/profile/model rows carry typed dimensions and labels", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      yield* fixture
      const provider = yield* session.usageReportAll({ group: "provider" })
      typed(provider)
      expect<unknown>(shape(provider)).toEqual([
        {
          key: JSON.stringify(["provider", "openai"]),
          label: "openai",
          dimensions: { group: "provider", providerID: "openai" },
          logical: 1,
        },
        {
          key: JSON.stringify(["provider", "p"]),
          label: "p",
          dimensions: { group: "provider", providerID: "p" },
          logical: 5,
        },
        {
          key: JSON.stringify(["provider", "q"]),
          label: "q",
          dimensions: { group: "provider", providerID: "q" },
          logical: 1,
        },
      ])
      const modelID = yield* session.usageReportAll({ group: "model-id" })
      typed(modelID)
      expect<unknown>(shape(modelID)).toEqual([
        {
          key: JSON.stringify(["model-id", "m"]),
          label: "m",
          dimensions: { group: "model-id", modelID: "m" },
          logical: 6,
        },
        {
          key: JSON.stringify(["model-id", "provider-priced"]),
          label: "provider-priced",
          dimensions: { group: "model-id", modelID: "provider-priced" },
          logical: 1,
        },
      ])
      const profile = yield* session.usageReportAll({ group: "profile" })
      typed(profile)
      expect<unknown>(shape(profile)).toEqual([
        {
          key: JSON.stringify(["profile", "openai", null]),
          label: "openai · Provider default",
          dimensions: { group: "profile", providerID: "openai", profileState: "provider-default" },
          logical: 1,
        },
        {
          key: JSON.stringify(["profile", "p", "Personal"]),
          label: "p · Personal",
          dimensions: { group: "profile", providerID: "p", profile: "Personal", profileState: "recorded" },
          logical: 1,
        },
        {
          key: JSON.stringify(["profile", "p", "Work"]),
          label: "p · Work",
          dimensions: { group: "profile", providerID: "p", profile: "Work", profileState: "recorded" },
          logical: 4,
        },
        {
          key: JSON.stringify(["profile", "q", null]),
          label: "q · Provider default",
          dimensions: { group: "profile", providerID: "q", profileState: "provider-default" },
          logical: 1,
        },
      ])
      const combined = yield* session.usageReportAll({ group: "provider-profile-model" })
      typed(combined)
      expect<unknown>(shape(combined)).toEqual([
        {
          key: JSON.stringify(["provider-profile-model", "openai", null, "provider-priced"]),
          label: "openai/provider-priced · Provider default",
          dimensions: {
            group: "provider-profile-model",
            providerID: "openai",
            profileState: "provider-default",
            modelID: "provider-priced",
          },
          logical: 1,
        },
        {
          key: JSON.stringify(["provider-profile-model", "p", "Personal", "m"]),
          label: "p/m · Personal",
          dimensions: {
            group: "provider-profile-model",
            providerID: "p",
            profile: "Personal",
            profileState: "recorded",
            modelID: "m",
          },
          logical: 1,
        },
        {
          key: JSON.stringify(["provider-profile-model", "p", "Work", "m"]),
          label: "p/m · Work",
          dimensions: {
            group: "provider-profile-model",
            providerID: "p",
            profile: "Work",
            profileState: "recorded",
            modelID: "m",
          },
          logical: 4,
        },
        {
          key: JSON.stringify(["provider-profile-model", "q", null, "m"]),
          label: "q/m · Provider default",
          dimensions: {
            group: "provider-profile-model",
            providerID: "q",
            profileState: "provider-default",
            modelID: "m",
          },
          logical: 1,
        },
      ])
      const page = yield* session.usageReportAll({ group: "provider", offset: 1, limit: 1 })
      expect(page.rows.map((row) => row.key)).toEqual([JSON.stringify(["provider", "p"])])
      expect(page).toMatchObject({ rowCount: 3, nextOffset: 2, total: { logical: 7 } })
    }),
  )

  it.effect("provider, profile, model, and selected-effort filters apply before grouping, paging, and totals", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      yield* fixture
      const filtered = yield* session.usageReportAll({
        group: "provider-profile-model",
        providerID: Provider.ID.make("p"),
        profile: "Work",
        selectedEffort: "high",
      })
      typed(filtered)
      expect<unknown>(shape(filtered)).toEqual([
        {
          key: JSON.stringify(["provider-profile-model", "p", "Work", "m"]),
          label: "p/m · Work",
          dimensions: {
            group: "provider-profile-model",
            providerID: "p",
            profile: "Work",
            profileState: "recorded",
            modelID: "m",
          },
          logical: 2,
        },
      ])
      expect(filtered.total).toMatchObject({
        logical: 2,
        cost: 1,
        costCoverage: { pricedRequests: 1, unpricedRequests: 1 },
      })
      const model = yield* session.usageReportAll({
        group: "provider",
        modelID: CatalogModel.ID.make("provider-priced"),
      })
      expect<unknown>(shape(model)).toEqual([
        {
          key: JSON.stringify(["provider", "openai"]),
          label: "openai",
          dimensions: { group: "provider", providerID: "openai" },
          logical: 1,
        },
      ])
      expect(model.total.logical).toBe(1)
      const effort = yield* session.usageReportAll({ group: "model", selectedEffort: "low" })
      expect(effort.rows.map((row) => row.key)).toEqual(["p/m/low/Personal", "p/m/low/Work", "q/m/low"])
      expect(effort.rows.every((row) => row.model?.variant === "low")).toBe(true)
      expect(effort.rows[1]).toMatchObject({ logical: 2, costCoverage: { pricedRequests: 2, unpricedRequests: 0 } })
      expect(effort.total.logical).toBe(4)
      const scoped = yield* session.usageReport({
        sessionID: rootID,
        group: "provider",
        providerID: Provider.ID.make("q"),
      })
      expect(scoped.rows.map((row) => row.key)).toEqual([JSON.stringify(["provider", "q"])])
      expect(scoped.total).toMatchObject({ logical: 1, cost: 3 })
    }),
  )

  it.effect("task rows include every enclosing task across non-task Sessions while totals count requests once", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      yield* fixture
      const report = yield* session.usageReportAll({ group: "task" })
      typed(report)
      expect<unknown>(shape(report)).toEqual([
        {
          key: JSON.stringify(["task", childID]),
          label: childID,
          dimensions: { group: "task", attribution: "complete", sessionID: childID },
          logical: 4,
        },
        {
          key: JSON.stringify(["task", nestedID]),
          label: nestedID,
          dimensions: { group: "task", attribution: "complete", sessionID: nestedID },
          logical: 1,
        },
        {
          key: JSON.stringify(["task", null]),
          label: "Main Session / unattributed",
          dimensions: { group: "task", attribution: "unattributed" },
          logical: 3,
        },
      ])
      expect(report.rows[0]).toMatchObject({ cost: 5, costCoverage: { pricedRequests: 3, unpricedRequests: 1 } })
      expect(report.rows[0]?.speed).toEqual({
        samples: 0,
        generationSamples: 1,
        providerTimedSamples: 1,
        observedSamples: 0,
        generationP50TokensPerSecond: 100,
        generationP90TokensPerSecond: 100,
        outputTokensPerSecond: 100,
      })
      expect(report.rows[1]).toMatchObject({ cost: 2 })
      expect(report.rows[2]?.speed).toEqual({
        samples: 1,
        firstOutputP50Ms: 5,
        firstOutputP95Ms: 5,
        generationSamples: 2,
        providerTimedSamples: 1,
        observedSamples: 1,
        generationP50TokensPerSecond: 10,
        generationP90TokensPerSecond: 20,
        outputTokensPerSecond: 50 / 3,
      })
      expect(report.total).toMatchObject({ logical: 7, costCoverage: { pricedRequests: 6, unpricedRequests: 1 } })
      expect(yield* session.usageReport({ sessionID: rootID, group: "task" })).toEqual(report)
      const child = yield* session.usageReport({ sessionID: childID, group: "task" })
      typed(child)
      expect(shape(child)).toEqual(shape(report).slice(0, 2))
      expect(child.total).toMatchObject({ logical: 4, cost: 5 })
    }),
  )

  it.effect("prompt rows attribute admitted inputs only in Session scope and keep missing anchors unattributed", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { first } = yield* fixture
      const unattributed = {
        key: JSON.stringify(["prompt", null, null]),
        label: "Unattributed",
        dimensions: { group: "prompt", attribution: "unattributed" },
      }
      const global = yield* session.usageReportAll({ group: "prompt" })
      typed(global)
      expect<unknown>(shape(global)).toEqual([{ ...unattributed, logical: 7 }])
      const scoped = yield* session.usageReport({ sessionID: rootID, group: "prompt" })
      typed(scoped)
      expect<unknown>(shape(scoped)).toEqual([
        {
          key: JSON.stringify(["prompt", rootID, first]),
          label: first,
          dimensions: { group: "prompt", attribution: "complete", anchor: { sessionID: rootID, inputID: first } },
          logical: 4,
        },
        { ...unattributed, logical: 3 },
      ])
      expect(scoped.total.logical).toBe(7)
    }),
  )
})
