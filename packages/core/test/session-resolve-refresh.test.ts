import { expect } from "bun:test"
import { Effect } from "effect"
import { DateTime } from "effect"
import { Money } from "@ycoding-ai/schema/money"
import { Agent } from "@ycoding-ai/core/agent"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Credential } from "@ycoding-ai/core/credential"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Integration } from "@ycoding-ai/core/integration"
import { Location } from "@ycoding-ai/core/location"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Project } from "@ycoding-ai/core/project"
import { Provider } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SessionRunnerModel.node, Credential.node, Integration.node, Catalog.node, Agent.node]), [
    [Location.node, Location.boundNode({ directory: AbsolutePath.make("/fixture") })],
  ]),
)
const providerID = Provider.ID.make("openai")
const modelID = CatalogModel.ID.make("gpt-6.1")
const methodID = Integration.MethodID.make("chatgpt-browser")
const session = (profile: string) =>
  SessionSchema.Info.make({
    id: SessionSchema.ID.create(),
    projectID: Project.ID.global,
    title: "refresh fixture",
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: { directory: AbsolutePath.make("/fixture") },
    model: CatalogModel.Ref.make({ providerID, id: modelID, profile }),
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
        methodID,
        access: `fixture-${label}`,
        refresh: `refresh-${label}`,
        expires: 1000,
        metadata: { accountID: `account-${label}` },
      }),
    }),
  )
  const refreshes: string[] = []
  const implementation: Integration.OAuthImplementation = {
    integrationID: Integration.ID.make(providerID),
    method: { type: "oauth", id: methodID, label: "Fixture refresh" },
    authorize: () => Effect.die("No live authorization"),
    refresh: (value) =>
      Effect.sync(() => {
        refreshes.push(value.access)
        return Credential.OAuth.make({ ...value, access: `${value.access}-refreshed`, expires: Date.now() + 3_600_000 })
      }),
  }
  yield* integrations.transform((draft) => draft.method.update(implementation))
  return { credentials, integrations, profiles, refreshes, models: yield* SessionRunnerModel.Service }
})

it.effect("a read-only resolution never refreshes a near-expiry account while normal resolution still does", () => Effect.gen(function* () {
  const fixture = yield* setup
  const work = fixture.profiles[0]!
  const before = (yield* fixture.credentials.get(work.id))!
  const readonly = yield* fixture.models.resolve(session("Work"), { refresh: false })
  expect(readonly.ref.profile).toBe("Work")
  expect(fixture.refreshes).toEqual([])
  expect((yield* fixture.credentials.get(work.id))!.value).toEqual(before.value)
  const normal = yield* fixture.models.resolve(session("Work"))
  expect(fixture.refreshes).toEqual(["fixture-Work"])
  expect(normal.accountIdentityDigest).toBe(readonly.accountIdentityDigest)
}))

it.effect("a read-only connection snapshot leaves the stored credential untouched and the default snapshot refreshes", () => Effect.gen(function* () {
  const fixture = yield* setup
  const personal = fixture.profiles[1]!
  const connection = { type: "credential" as const, id: personal.id, label: personal.label, active: personal.active }
  const readonly = yield* fixture.integrations.connection.snapshot(connection, { refresh: false })
  expect(readonly.value).toMatchObject({ access: "fixture-Personal" })
  expect(fixture.refreshes).toEqual([])
  const normal = yield* fixture.integrations.connection.snapshot(connection)
  expect(normal.value).toMatchObject({ access: "fixture-Personal-refreshed" })
  expect(fixture.refreshes).toEqual(["fixture-Personal"])
}))
