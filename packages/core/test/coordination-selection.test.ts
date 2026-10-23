import { describe, expect, test } from "bun:test"
import { Effect, Layer, LayerMap } from "effect"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { Agent } from "../src/agent"
import { Catalog } from "../src/catalog"
import { CatalogModel } from "../src/model"
import { CoordinationDispatchSelection } from "../src/coordination/selection"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import type { Location } from "../src/location"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionSchema } from "../src/session/schema"
import { SessionTable } from "../src/session/sql"
import { testEffect } from "./lib/effect"

const providerID = Provider.ID.make("fixture")
const selection = (patch?: Partial<Coordination.DispatchSelection>): Coordination.DispatchSelection => ({
  agent: Agent.ID.make("occam"),
  model: Model.Ref.make({ providerID, id: Model.ID.make("model-a"), variant: Model.VariantID.make("medium") }),
  reason: "Bounded fixture work",
  ...(patch ?? {}),
})
const agentInfo = (patch?: Partial<Agent.Info>): Agent.Info => ({
  ...Agent.Info.empty(Agent.ID.make("occam")),
  mode: "subagent",
  hidden: false,
  ...(patch ?? {}),
})
const modelInfo = (variants: string[], profiles?: Model.Info["profiles"]): CatalogModel.Info =>
  ({
    ...CatalogModel.Info.empty(providerID, CatalogModel.ID.make("model-a")),
    variants: variants.map((id) => ({ id: Model.VariantID.make(id) })),
    ...(profiles === undefined ? {} : { profiles }),
  }) as CatalogModel.Info

describe("coordination dispatch selection checks", () => {
  test("accepts a configured subagent profile with an advertised variant", () => {
    expect(CoordinationDispatchSelection.check({ agent: agentInfo(), model: modelInfo(["low", "medium"]), selection: selection() })).toBeUndefined()
  })

  test("rejects missing, hidden, and special agents without inventing a fallback", () => {
    expect(CoordinationDispatchSelection.check({ agent: undefined, model: modelInfo(["medium"]), selection: selection() })).toContain("agent")
    expect(
      CoordinationDispatchSelection.check({ agent: agentInfo({ hidden: true }), model: modelInfo(["medium"]), selection: selection() }),
    ).toContain("agent")
    expect(
      CoordinationDispatchSelection.check({
        agent: agentInfo({ id: Agent.ID.make("btw") }),
        model: modelInfo(["medium"]),
        selection: selection({ agent: Agent.ID.make("btw") }),
      }),
    ).toContain("agent")
  })

  test("rejects missing or disabled models", () => {
    expect(CoordinationDispatchSelection.check({ agent: agentInfo(), model: undefined, selection: selection() })).toContain("model")
    expect(
      CoordinationDispatchSelection.check({
        agent: agentInfo(),
        model: { ...modelInfo(["medium"]), enabled: false } as CatalogModel.Info,
        selection: selection(),
      }),
    ).toContain("model")
  })

  test("requires an explicit advertised variant and rejects unadvertised ones", () => {
    const model = modelInfo(["low", "medium"])
    expect(
      CoordinationDispatchSelection.check({
        agent: agentInfo(),
        model,
        selection: selection({ model: Model.Ref.make({ providerID, id: Model.ID.make("model-a") }) }),
      }),
    ).toContain("variant")
    expect(
      CoordinationDispatchSelection.check({
        agent: agentInfo(),
        model,
        selection: selection({
          model: Model.Ref.make({ providerID, id: Model.ID.make("model-a"), variant: Model.VariantID.make("max") }),
        }),
      }),
    ).toContain("variant")
  })

  test("requires variant omission when the model advertises none", () => {
    const model = modelInfo([])
    expect(CoordinationDispatchSelection.check({ agent: agentInfo(), model, selection: selection() })).toContain("variant")
    expect(
      CoordinationDispatchSelection.check({
        agent: agentInfo(),
        model,
        selection: selection({ model: Model.Ref.make({ providerID, id: Model.ID.make("model-a") }) }),
      }),
    ).toBeUndefined()
  })

  test("validates variants against the selected profile advertisement", () => {
    const model = modelInfo(["low", "medium"], [
      { name: Model.ProfileName.make("work"), active: true, variants: [Model.VariantID.make("high")] },
    ])
    const withProfile = (variant: string) =>
      selection({
        model: Model.Ref.make({
          providerID,
          id: Model.ID.make("model-a"),
          profile: Model.ProfileName.make("work"),
          variant: Model.VariantID.make(variant),
        }),
      })
    expect(CoordinationDispatchSelection.check({ agent: agentInfo(), model, selection: withProfile("medium") })).toContain("variant")
    expect(CoordinationDispatchSelection.check({ agent: agentInfo(), model, selection: withProfile("high") })).toBeUndefined()
    expect(
      CoordinationDispatchSelection.check({
        agent: agentInfo(),
        model,
        selection: selection({
          model: Model.Ref.make({
            providerID,
            id: Model.ID.make("model-a"),
            profile: Model.ProfileName.make("missing"),
            variant: Model.VariantID.make("high"),
          }),
        }),
      }),
    ).toContain("profile")
  })
})

const agents = Layer.mock(Agent.Service)({
  get: (id) => Effect.succeed(id === "occam" ? agentInfo() : undefined),
})
const catalog = Layer.mock(Catalog.Service)({
  provider: {
    get: () => Effect.die("unused"),
    all: () => Effect.die("unused"),
    available: () => Effect.die("unused"),
  },
  model: {
    get: (provider, model) =>
      Effect.succeed(provider === providerID && model === "model-a" ? modelInfo(["low", "medium"]) : undefined),
    all: () => Effect.die("unused"),
    available: () => Effect.die("unused"),
    default: () => Effect.die("unused"),
    defaultSelection: () => Effect.die("unused"),
    forConnection: () => Effect.die("unused"),
    small: () => Effect.die("unused"),
  },
})
const locations = LayerMap.make(
  (_location: Location.Ref) => Layer.mergeAll(agents, catalog),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventRuntime.node])),
)

describe("coordination dispatch selection validation", () => {
  it.effect("resolves the target Session Location and validates against its agent and catalog", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const targetSessionID = SessionSchema.ID.make("ses_selection_target")
      yield* database.db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionTable)
        .values({ id: targetSessionID, project_id: Project.ID.global, directory: "/project", title: "Worker" })
        .run()
        .pipe(Effect.orDie)
      const service = CoordinationDispatchSelection.make({ db: database.db, locations: yield* locations })
      yield* service.validate(targetSessionID, selection())
      const missing = yield* service
        .validate(targetSessionID, selection({ agent: Agent.ID.make("missing") }))
        .pipe(Effect.flip)
      expect(missing).toBeInstanceOf(CoordinationDispatchSelection.InvalidSelectionError)
      const unknownSession = yield* service.validate(SessionSchema.ID.make("ses_missing"), selection()).pipe(Effect.flip)
      expect(unknownSession).toBeInstanceOf(CoordinationDispatchSelection.InvalidSelectionError)
    }),
  )
})
