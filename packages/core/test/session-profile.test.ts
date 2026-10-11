import { describe, expect } from "bun:test"
import { LLM, Message } from "@ycoding-ai/ai"
import { LLMClient, RequestExecutor } from "@ycoding-ai/ai/route"
import { Context, DateTime, Deferred, Effect, Fiber, Layer, LayerMap } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Money } from "@ycoding-ai/schema/money"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { makeGlobalNode } from "@ycoding-ai/core/effect/app-node"
import { Config } from "@ycoding-ai/core/config"
import { Database } from "@ycoding-ai/core/database/database"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { Project } from "@ycoding-ai/core/project"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import type { LocationServices } from "@ycoding-ai/core/location-services"
import { Session } from "@ycoding-ai/core/session"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionProviderRequest } from "@ycoding-ai/core/session/provider-request"
import { SessionProviderState } from "@ycoding-ai/core/session/provider-state"
import { SessionHistory } from "@ycoding-ai/core/session/history"
import { toLLMMessages } from "@ycoding-ai/core/session/runner/to-llm-message"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { EventRuntime } from "@ycoding-ai/core/event"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { eq } from "drizzle-orm"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionRunnerCache } from "@ycoding-ai/core/session/runner/cache"
import { SessionModelRequest } from "@ycoding-ai/core/session/model-request"
import { SessionLiveState } from "@ycoding-ai/core/session/live-state"
import { Agent } from "@ycoding-ai/core/agent"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SessionRunnerModel.node, Credential.node, Integration.node, Catalog.node]), [
    [Location.node, Location.boundNode({ directory: AbsolutePath.make("/fixture") })],
  ]),
)
const configuration = Layer.succeed(
  Config.Service,
  Config.Service.of({ diagnostics: () => Effect.succeed([]), entries: () => Effect.succeed([]), reload: () => Effect.void }),
)
const placements = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const database = yield* Database.Service
      const events = yield* EventRuntime.Service
      return yield* LayerMap.make(
        (location: Location.Ref) =>
          AppNodeBuilder.build(
            LayerNode.group([SessionRunnerModel.node, Catalog.node, Config.node, Integration.node]),
            [
              [Location.node, Location.boundNode(location)],
              [Credential.node, Layer.succeed(Credential.Service, credentials)],
              [Database.node, Layer.succeed(Database.Service, database)],
              [EventRuntime.node, Layer.succeed(EventRuntime.Service, events)],
              [Config.node, configuration],
            ],
          ) as unknown as Layer.Layer<LocationServices>,
      )
    }),
  ),
  deps: [Credential.node, Database.node, EventRuntime.node],
})
const runtimeIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      LocationServiceMap.node,
      SessionModelRequest.node,
      SessionLiveState.node,
      SessionProviderRequest.node,
      SessionProviderState.node,
      Database.node,
      EventRuntime.node,
      SessionStore.node,
      SessionRunnerModel.node,
      Credential.node,
      Integration.node,
      Catalog.node,
    ]),
    [
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/fixture") })],
      [LocationServiceMap.node, placements],
      [Config.node, configuration],
      [SessionExecution.node, SessionExecution.noopLayer],
      [
        Project.node,
        Layer.succeed(
          Project.Service,
          Project.Service.of({
            list: () => Effect.succeed([]),
            resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
            directories: () => Effect.succeed([]),
            recordOpened: () => Effect.void,
            commit: () => Effect.void,
          }),
        ),
      ],
    ],
  ),
)
const providerID = Provider.ID.make("openai")
const modelID = CatalogModel.ID.make("gpt-6.1")
const session = (profile?: string) =>
  SessionSchema.Info.make({
    id: SessionSchema.ID.create(),
    projectID: Project.ID.global,
    title: "profile fixture",
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: { directory: AbsolutePath.make("/fixture") },
    model: CatalogModel.Ref.make({ providerID, id: modelID, ...(profile === undefined ? {} : { profile }) }),
  })
const setup = Effect.gen(function* () {
  const catalog = yield* Catalog.Service
  const credentials = yield* Credential.Service
  const integrations = yield* Integration.Service
  yield* integrations.transform((draft) =>
    draft.update(Integration.ID.make(providerID), (item) => {
      item.name = "OpenAI"
    }),
  )
  yield* catalog.transform((draft) => {
    draft.provider.update(providerID, (item) => {
      item.package = Provider.aisdk("@ai-sdk/openai")
    })
    draft.model.update(providerID, modelID, (item) => {
      item.enabled = true
      item.limit = { context: 200000, output: 1000 }
    })
  })
  const profiles = yield* Effect.forEach(["Work", "Personal"], (label) =>
    credentials.create({
      integrationID: Integration.ID.make(providerID),
      label,
      value: Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("chatgpt-browser"),
        access: `fixture-${label}`,
        refresh: `refresh-${label}`,
        expires: 1000000,
        metadata: { accountID: `account-${label}` },
      }),
    }),
  )
  return { credentials, integrations, profiles, models: yield* SessionRunnerModel.Service }
})
const runtimeSetup = Effect.gen(function* () {
  const locations = yield* LocationServiceMap.Service
  return yield* setup.pipe(Effect.provide(locations.get(session().location)))
})
const namespace = (resolved: SessionRunnerModel.Resolved) =>
  SessionRunnerCache.promptCacheNamespace({
    projectID: "fixture",
    directory: "/fixture",
    providerID,
    modelID,
    policyRevision: "fixture",
    permissions: [],
    system: [],
    tools: [],
    accountIdentityDigest: resolved.accountIdentityDigest,
  })

describe("per-session profiles", () => {
  it.effect("resolves account-exclusive models and keeps implicit defaults on the active account", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const catalog = yield* Catalog.Service
      const work = CatalogModel.Info.make({
        ...CatalogModel.Info.empty(providerID, CatalogModel.ID.make("work-only")),
        package: Provider.aisdk("@ai-sdk/openai"),
        limit: { context: 100000, output: 1000 },
        variants: [{ id: CatalogModel.VariantID.make("high") }],
      })
      const personal = CatalogModel.Info.make({
        ...work,
        id: CatalogModel.ID.make("personal-only"),
        variants: [{ id: CatalogModel.VariantID.make("low") }],
      })
      yield* catalog.transform((draft) => {
        draft.model.account.update(fixture.profiles[0]!, providerID, [work])
        draft.model.account.update(fixture.profiles[1]!, providerID, [personal])
      })
      expect((yield* catalog.model.get(providerID, work.id, "Work"))?.id).toBe(work.id)
      expect((yield* catalog.model.get(providerID, work.id, "Work"))?.profiles).toEqual([
        { name: "Work", active: false, variants: [CatalogModel.VariantID.make("high")] },
      ])
      expect(yield* catalog.model.get(providerID, work.id, "Personal")).toBeUndefined()
      expect((yield* catalog.model.default())?.id).toBe(personal.id)
      const selected = yield* fixture.models.resolve({
        ...session("Work"),
        model: CatalogModel.Ref.make({
          providerID,
          id: work.id,
          profile: "Work",
          variant: CatalogModel.VariantID.make("high"),
        }),
      })
      expect(selected.ref).toMatchObject({ id: work.id, profile: "Work", variant: "high" })
      yield* catalog.transform((draft) =>
        draft.model.default.set(providerID, work.id, { profile: "Work", variant: CatalogModel.VariantID.make("high") }),
      )
      expect((yield* catalog.model.default())?.id).toBe(work.id)
      expect(yield* catalog.model.defaultSelection()).toMatchObject({ id: work.id, profile: "Work", variant: "high" })
      yield* catalog.transform((draft) => draft.model.default.set(providerID, work.id, { profile: "Missing" }))
      expect(yield* catalog.model.default()).toBeUndefined()
    }),
  )

  runtimeIt.effect(
    "keeps exact environment authentication replay stable and fences key replacement without exposing auth",
    () =>
      Effect.gen(function* () {
        const fixture = yield* runtimeSetup
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const previous = process.env.YCODING_FIXTURE_ACCOUNT_KEY
            process.env.YCODING_FIXTURE_ACCOUNT_KEY = "fixture-env-key-one"
            return previous
          }),
          (previous) =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env.YCODING_FIXTURE_ACCOUNT_KEY
              else process.env.YCODING_FIXTURE_ACCOUNT_KEY = previous
            }),
        )
        yield* Effect.forEach(fixture.profiles, (profile) => fixture.credentials.remove(profile.id))
        yield* fixture.integrations.transform((draft) =>
          draft.method.update({
            integrationID: Integration.ID.make(providerID),
            method: { type: "env", names: ["YCODING_FIXTURE_ACCOUNT_KEY"] },
          }),
        )
        const sessions = yield* Session.Service
        const root = yield* sessions.create({
          location: { directory: AbsolutePath.make("/fixture") },
          model: session().model,
        })
        const first = yield* fixture.models.resolve(root)
        expect(first.accountIdentityDigest).toMatch(/^[0-9a-f]{64}$/)
        const events = yield* EventRuntime.Service
        const messageID = SessionMessage.ID.create()
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID: root.id,
          assistantMessageID: messageID,
          agent: Agent.defaultID,
          model: first.ref,
        })
        const state = { itemId: "rs_fixture", reasoningEncryptedContent: "fixture-ciphertext" }
        yield* events.publish(SessionEvent.Reasoning.Started, {
          sessionID: root.id,
          assistantMessageID: messageID,
          ordinal: 0,
          state,
        })
        yield* events.publish(SessionEvent.Reasoning.Ended, {
          sessionID: root.id,
          assistantMessageID: messageID,
          ordinal: 0,
          text: "ordinary reasoning",
          state,
        })
        const tokens = { input: 1, output: 1, reasoning: 1, cache: { read: 0, write: 0 } }
        yield* events.publish(SessionEvent.Step.Ended, {
          sessionID: root.id,
          assistantMessageID: messageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens,
        })
        const tracker = yield* (yield* SessionProviderRequest.Service).next({
          sessionID: root.id,
          source: "step",
          agent: Agent.defaultID,
          model: first.ref,
          routeID: first.model.route.id,
          connectionIdentityDigest: first.accountIdentityDigest,
          promptCacheKey: namespace(first),
          systemDigest: "fixture",
          toolDigest: "fixture",
        })
        yield* tracker.complete({ assistantMessageID: messageID, continuation: "full", tokens })
        const second = yield* fixture.models.resolve(yield* sessions.get(root.id))
        expect(second.accountIdentityDigest).toBe(first.accountIdentityDigest)
        expect(namespace(second)).toBe(namespace(first))
        const providerState = yield* SessionProviderState.Service
        const db = (yield* Database.Service).db
        const history = yield* SessionHistory.forModel(db, root.id, second.ref, second.accountIdentityDigest)
        const materialized = yield* providerState.materialize({
          sessionID: root.id,
          provider: providerID,
          modelID,
          stateless: true,
          accountIdentityDigest: second.accountIdentityDigest,
        })
        const body = yield* LLMClient.prepare(
          LLM.request({
            model: second.model,
            messages: toLLMMessages(
              history,
              second.ref,
              "openai",
              materialized,
              undefined,
              second.accountIdentityDigest,
            ),
          }),
        )
        expect(JSON.stringify(body.body)).toContain("fixture-ciphertext")
        process.env.YCODING_FIXTURE_ACCOUNT_KEY = "fixture-env-key-two"
        const replacement = yield* fixture.models.resolve(yield* sessions.get(root.id))
        expect(replacement.accountIdentityDigest).not.toBe(first.accountIdentityDigest)
        expect(replacement.connectionIdentityDigest).not.toBe(first.connectionIdentityDigest)
        expect(namespace(replacement)).not.toBe(namespace(first))
        const replay = toLLMMessages(
          history,
          replacement.ref,
          "openai",
          materialized,
          undefined,
          replacement.accountIdentityDigest,
        )
        expect(JSON.stringify(replay)).toContain("ordinary reasoning")
        expect(JSON.stringify(replay)).not.toContain("fixture-ciphertext")
        expect(JSON.stringify(yield* (yield* SessionProviderRequest.Service).list(root.id))).not.toContain(
          "fixture-env-key",
        )
        expect(JSON.stringify(root)).not.toContain("fixture-env-key")
      }),
  )

  it.effect("fingerprints captured configured keys and leaves opaque authentication provenance unknown", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((draft) => {
        draft.provider.update(providerID, (provider) => {
          provider.package = Provider.aisdk("@ai-sdk/openai")
          provider.settings = { apiKey: "fixture-config-key-one" }
        })
        draft.model.update(providerID, modelID, (model) => {
          model.enabled = true
        })
      })
      const models = yield* SessionRunnerModel.Service
      const first = yield* models.resolve(session())
      expect((yield* models.resolve(session())).accountIdentityDigest).toBe(first.accountIdentityDigest)
      expect(first.accountIdentityDigest).toMatch(/^[0-9a-f]{64}$/)
      yield* catalog.transform((draft) =>
        draft.provider.update(providerID, (provider) => {
          provider.settings = { apiKey: "fixture-config-key-two" }
        }),
      )
      const second = yield* models.resolve(session())
      expect(second.accountIdentityDigest).not.toBe(first.accountIdentityDigest)
      expect(second.connectionIdentityDigest).not.toBe(first.connectionIdentityDigest)
      const anonymous = yield* SessionRunnerModel.fromCatalogModel(
        CatalogModel.Info.make({
          ...CatalogModel.Info.empty(providerID, modelID),
          package: Provider.aisdk("@ai-sdk/openai"),
        }),
      )
      expect(
        SessionRunnerModel.exactAuthIdentityDigest(CatalogModel.Info.empty(providerID, modelID), anonymous),
      ).toBeUndefined()
    }),
  )

  it.effect(
    "shares credential refresh across independent Location registries without changing account namespaces",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup
        const registry = yield* Layer.build(
          AppNodeBuilder.build(LayerNode.group([Integration.node, Location.node]), [
            [Credential.node, Layer.succeed(Credential.Service, fixture.credentials)],
            [Location.node, Location.boundNode({ directory: AbsolutePath.make("/other-location") })],
          ]),
        )
        const second = Context.get(registry, Integration.Service)
        const work = fixture.profiles[0]!
        const expired = Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("fixture-refresh"),
          access: "old",
          refresh: "old-refresh",
          expires: 0,
          metadata: { accountID: "account-Work" },
        })
        const stored = yield* fixture.credentials.create({
          integrationID: work.integrationID,
          label: work.label,
          value: expired,
        })
        const before = yield* fixture.models.resolve(session("Work"))
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let refreshes = 0
        const implementation: Integration.OAuthImplementation = {
          integrationID: work.integrationID,
          method: { type: "oauth", id: expired.methodID, label: "Fixture refresh" },
          authorize: () => Effect.die("No live authorization"),
          refresh: (value) =>
            Effect.gen(function* () {
              refreshes += 1
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return Credential.OAuth.make({ ...value, access: "refreshed", refresh: "rotated", expires: 1000000 })
            }),
        }
        yield* fixture.integrations.transform((draft) => draft.method.update(implementation))
        yield* second.transform((draft) => draft.method.update(implementation))
        const connection = { type: "credential" as const, id: stored.id, label: stored.label, active: stored.active }
        const first = yield* fixture.integrations.connection.snapshot(connection).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        const other = yield* second.connection.snapshot(connection).pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        yield* Deferred.succeed(release, undefined)
        const snapshots = yield* Effect.all([Fiber.join(first), Fiber.join(other)])
        expect(refreshes).toBe(1)
        expect(snapshots[0].credential).toEqual(snapshots[1].credential)
        expect(snapshots[0].value).toMatchObject({ access: "refreshed", refresh: "rotated" })
        const after = yield* fixture.models.resolve(session("Work"), { binding: before.profileBinding })
        expect(after.accountIdentityDigest).toBe(before.accountIdentityDigest)
        expect(namespace(after)).toBe(namespace(before))
        expect(after.connectionIdentityDigest).not.toBe(before.connectionIdentityDigest)
      }),
  )

  for (const promoted of [false, true])
    runtimeIt.effect(
      `adopts the existing binding and reconciles ${promoted ? "promoted" : "pending"} admission before new profile side effects`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* runtimeSetup
          const sessions = yield* Session.Service
          const database = yield* Database.Service
          const events = yield* EventRuntime.Service
          const root = yield* sessions.create({
            location: { directory: AbsolutePath.make("/fixture") },
            model: session("Work").model,
          })
          const first = yield* sessions.prompt({
            sessionID: root.id,
            id: SessionMessage.ID.create(),
            text: "First admission wins",
            resume: false,
          })
          if (promoted) yield* SessionPending.promoteSteers(database.db, events, root.id)
          const existing = yield* sessions.get(root.id)
          const before = yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, root.id)).all()
          const binding = (yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, root.id)).get())
            ?.profile_binding
          const work = fixture.profiles[0]!
          yield* fixture.credentials.create({ integrationID: work.integrationID, label: work.label, value: work.value })
          expect(
            yield* sessions.create({
              id: root.id,
              parentID: SessionSchema.ID.create(),
              title: "Ignored retry fields",
              model: session("Missing").model,
            }),
          ).toEqual(existing)
          expect(
            yield* sessions.prompt({
              sessionID: root.id,
              id: first.id,
              text: "$missing-skill different retry",
              resume: false,
            }),
          ).toEqual(first)
          expect(
            yield* sessions.command({
              sessionID: root.id,
              id: first.id,
              command: "missing-command",
              arguments: "ignored",
              model: session("Personal").model,
              resume: false,
            }),
          ).toEqual(first)
          expect(
            (yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, root.id)).get())?.profile_binding,
          ).toEqual(binding)
          expect(
            yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, root.id)).all(),
          ).toEqual(before)
          expect((yield* fixture.models.resolve(yield* sessions.get(root.id)).pipe(Effect.flip))._tag).toBe(
            "SessionRunnerModel.ProfileUnavailableError",
          )
          expect(yield* sessions.switchModel({ sessionID: root.id, model: session("Work").model! })).toEqual({
            status: "switched",
          })
          expect((yield* fixture.models.resolve(yield* sessions.get(root.id))).profileBinding?.accountGeneration).toBe(
            1,
          )
        }),
    )

  runtimeIt.effect(
    "pins durable selection, switches profiles, and explicitly rebinds an identical ref after replacement",
    () =>
      Effect.gen(function* () {
        const fixture = yield* runtimeSetup
        const sessions = yield* Session.Service
        const db = (yield* Database.Service).db
        const root = yield* sessions.create({
          location: { directory: AbsolutePath.make("/fixture") },
          model: session("Work").model,
        })
        const persisted = yield* db.select().from(SessionTable).where(eq(SessionTable.id, root.id)).get()
        expect(persisted?.profile_binding).toMatchObject({
          credentialID: fixture.profiles[0]!.id,
          accountGeneration: 0,
          profile: "Work",
        })
        expect(JSON.stringify(root)).not.toContain("credentialID")
        const events = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, root.id)).all()
        expect(events.map((event) => [event.type, event.seq])).toEqual([
          [EventRuntime.versionedType(SessionEvent.Created.type, SessionEvent.Created.durable.version), 0],
          ["session.profile.bound.1", 1],
        ])
        const restoredID = SessionSchema.ID.create()
        yield* (yield* EventRuntime.Service).replayAll(
          events.map((event) => ({
            id: EventRuntime.ID.create(),
            aggregateID: restoredID,
            seq: event.seq,
            type: event.type,
            data: { ...event.data, sessionID: restoredID },
          })),
        )
        const restored = yield* sessions.get(restoredID)
        expect(restored.model?.profile).toBe("Work")
        expect((yield* fixture.models.resolve(restored)).profileBinding).toEqual(
          persisted?.profile_binding ?? undefined,
        )
        const personal = session("Personal").model!
        expect(yield* sessions.switchModel({ sessionID: root.id, model: personal })).toEqual({ status: "switched" })
        const selected = yield* sessions.get(root.id)
        expect(selected.model?.profile).toBe("Personal")
        const original = yield* fixture.models.resolve(selected)
        const fork = yield* sessions.fork({ sessionID: root.id })
        expect((yield* fixture.models.resolve(fork)).profileBinding).toEqual(original.profileBinding)
        expect(
          (yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, fork.id)).all()).some(
            (event) => event.type === "session.profile.bound.1",
          ),
        ).toBe(true)
        const credential = fixture.profiles[1]!
        yield* fixture.credentials.create({
          integrationID: credential.integrationID,
          label: credential.label,
          value: Credential.OAuth.make({
            ...credential.value,
            type: "oauth",
            methodID: Integration.MethodID.make("chatgpt-browser"),
            access: "replacement",
            refresh: "replacement-refresh",
            expires: 1000000,
          }),
        })
        expect((yield* fixture.models.resolve(yield* sessions.get(root.id)).pipe(Effect.flip))._tag).toBe(
          "SessionRunnerModel.ProfileUnavailableError",
        )
        expect(yield* sessions.switchModel({ sessionID: root.id, model: personal })).toEqual({ status: "switched" })
        const rehydrated = yield* (yield* SessionStore.Service).get(root.id)
        const rebound = yield* fixture.models.resolve(rehydrated!)
        expect(rebound.profileBinding?.accountGeneration).toBe(1)
        expect(rebound.accountIdentityDigest).not.toBe(original.accountIdentityDigest)
        expect(
          (yield* db.select().from(SessionTable).where(eq(SessionTable.id, root.id)).get())?.profile_binding,
        ).toEqual(rebound.profileBinding)
        const locations = yield* LocationServiceMap.Service
        yield* locations.invalidate(rehydrated!.location)
        const restarted = yield* Effect.gen(function* () {
          const catalog = yield* Catalog.Service
          yield* catalog.transform((draft) => {
            draft.provider.update(providerID, (provider) => {
              provider.package = Provider.aisdk("@ai-sdk/openai")
            })
            draft.model.update(providerID, modelID, (model) => {
              model.enabled = true
              model.limit = { context: 200000, output: 1000 }
            })
          })
          return yield* (yield* SessionRunnerModel.Service).resolve(rehydrated!)
        }).pipe(Effect.provide(locations.get(rehydrated!.location)))
        expect(restarted.accountIdentityDigest).toBe(rebound.accountIdentityDigest)
        expect(restarted.profileBinding).toEqual(rebound.profileBinding)
        yield* sessions.switchModel({ sessionID: root.id, model: session().model! })
        expect(
          (yield* db.select().from(SessionTable).where(eq(SessionTable.id, root.id)).get())?.profile_binding,
        ).toBeNull()
      }),
  )

  runtimeIt.effect(
    "uses the provider default for an explicitly selected child model without a profile",
    () =>
      Effect.gen(function* () {
        const fixture = yield* runtimeSetup
        const sessions = yield* Session.Service
        const root = yield* sessions.create({
          location: { directory: AbsolutePath.make("/fixture") },
          model: session("Work").model,
        })
        const child = yield* sessions.create({ parentID: root.id, model: session().model })
        expect(child.model?.profile).toBeUndefined()
        expect((yield* fixture.models.resolve(child)).profileBinding).not.toEqual(
          (yield* fixture.models.resolve(root)).profileBinding,
        )
        const work = fixture.profiles[0]!
        yield* fixture.credentials.create({ integrationID: work.integrationID, label: work.label, value: work.value })
        expect((yield* sessions.create({ parentID: root.id, model: session().model })).model?.profile).toBeUndefined()
      }),
  )

  runtimeIt.effect(
    "captures concurrent same-model durable Sessions through request preparation despite global activation",
    () =>
      Effect.gen(function* () {
        const fixture = yield* runtimeSetup
        const sessions = yield* Session.Service
        const selected = yield* Effect.forEach(["Work", "Personal"], (profile) =>
          sessions.create({ location: { directory: AbsolutePath.make("/fixture") }, model: session(profile).model }),
        )
        const resolved = yield* Effect.forEach(selected, (session) => fixture.models.resolve(session), {
          concurrency: "unbounded",
        })
        const requestsService = yield* SessionModelRequest.Service
        const liveState = yield* SessionLiveState.Service
        const prepared = yield* Effect.forEach(selected, (session, index) =>
          Effect.gen(function* () {
            const agent = Agent.Info.empty(Agent.ID.make("fixture"))
            return yield* requestsService.prepare({
              step: 1,
              terminalResponseRecovery: true,
              messages: [Message.user("Hello")],
              context: {
                session,
                model: resolved[index]!,
                agent: { id: agent.id, info: agent },
                initial: "Stable fixture instructions",
                contextRevision: 0,
                messages: [],
                liveState: yield* liveState.load(session.id),
              },
            })
          }),
        )
        const gate = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const requests: { authorization?: string; account?: string; body: unknown }[] = []
        const fibers = yield* Effect.forEach(prepared, (item) =>
          LLMClient.generate(item.request).pipe(
            Effect.provide(LLMClient.configured()),
            Effect.provideService(RequestExecutor.Service, {
              execute: (request) =>
                Effect.gen(function* () {
                  if (request.body._tag !== "Uint8Array") return yield* Effect.die(new Error("Expected JSON request"))
                  requests.push({
                    authorization: request.headers.authorization,
                    account: request.headers["chatgpt-account-id"],
                    body: JSON.parse(new TextDecoder().decode(request.body.body)),
                  })
                  if (requests.length === 2) yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(gate)
                  return HttpClientResponse.fromWeb(request, new Response("fixture", { status: 400 }))
                }),
            }),
            Effect.exit,
            Effect.forkScoped,
          ),
        )
        yield* Deferred.await(entered)
        yield* fixture.credentials.activate(fixture.profiles[0]!.id)
        yield* Deferred.succeed(gate, undefined)
        yield* Effect.forEach(fibers, Fiber.join)
        expect(requests).toHaveLength(2)
        expect(requests.map((request) => request.authorization).toSorted()).toEqual([
          "Bearer fixture-Personal",
          "Bearer fixture-Work",
        ])
        expect(requests.map((request) => request.account).toSorted()).toEqual(["account-Personal", "account-Work"])
        expect(prepared[0]!.cache.promptCacheKey).not.toBe(prepared[1]!.cache.promptCacheKey)
        expect(requests[0]?.body).toMatchObject({
          model: modelID,
          prompt_cache_key: prepared[0]!.request.providerOptions?.openai?.promptCacheKey,
        })
        expect(requests[1]?.body).toMatchObject({
          model: modelID,
          prompt_cache_key: prepared[1]!.request.providerOptions?.openai?.promptCacheKey,
        })
      }),
  )

  it.effect("fails closed for missing, renamed, deleted or replaced bound profiles", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      expect((yield* fixture.models.resolve(session("Missing")).pipe(Effect.flip))._tag).toBe(
        "SessionRunnerModel.ProfileUnavailableError",
      )
      const selected = session("Work")
      const bound = yield* fixture.models.resolve(selected)
      const work = fixture.profiles[0]!
      yield* fixture.credentials.update(work.id, { label: "Renamed" })
      expect((yield* fixture.models.resolve(selected, { binding: bound.profileBinding }).pipe(Effect.flip))._tag).toBe(
        "SessionRunnerModel.ProfileUnavailableError",
      )
      yield* fixture.credentials.update(work.id, { label: "Work" })
      yield* fixture.credentials.create({ integrationID: work.integrationID, label: work.label, value: work.value })
      expect((yield* fixture.models.resolve(selected, { binding: bound.profileBinding }).pipe(Effect.flip))._tag).toBe(
        "SessionRunnerModel.ProfileUnavailableError",
      )
      const rebound = yield* fixture.models.resolve(selected, { rebind: true })
      expect(rebound.accountIdentityDigest).not.toBe(bound.accountIdentityDigest)
      expect(rebound.connectionIdentityDigest).not.toBe(bound.connectionIdentityDigest)
      yield* fixture.credentials.remove(work.id)
      expect(
        (yield* fixture.models.resolve(selected, { binding: rebound.profileBinding }).pipe(Effect.flip))._tag,
      ).toBe("SessionRunnerModel.ProfileUnavailableError")
    }),
  )
})
