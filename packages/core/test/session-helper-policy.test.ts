import { expect, test } from "bun:test"
import { LLM, LLMClient, Model } from "@ycoding-ai/ai"
import { OpenAIChat } from "@ycoding-ai/ai/protocols"
import { Agent } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Project } from "@ycoding-ai/core/project"
import { Provider } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { localTitle, make, selectHelperModel, settings } from "@ycoding-ai/core/session/helper-policy"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { Money } from "@ycoding-ai/schema/money"
import { DateTime, Effect, Schema } from "effect"

const ref = (providerID: string, id: string, variant?: string, profile?: string) =>
  CatalogModel.Ref.make({
    providerID: Provider.ID.make(providerID),
    id: CatalogModel.ID.make(id),
    ...(variant === undefined ? {} : { variant: CatalogModel.VariantID.make(variant) }),
    ...(profile === undefined ? {} : { profile }),
  })

test("local title produces one terminal-safe line without a provider call", () => {
  expect(localTitle("  # Fix the migration\nIgnore this line  ")).toBe("Fix the migration")
  expect(localTitle("\u0000>   Repair   the   build\u0007")).toBe("Repair the build")
  expect(localTitle("\u001b[31m## Repair migration\u001b[0m")).toBe("Repair migration")
  expect(localTitle("   ")).toBe("New session")
  expect(localTitle("界".repeat(60))).toBe(`${"界".repeat(47)}...`)
})

test("helper settings carry no goal mode because goal synthesis is always model-based", () => {
  const info = Schema.decodeUnknownSync(Config.Info)({ efficiency: { title: "local" } })
  expect(settings([new Config.Document({ type: "document", info })])).toEqual({
    titleMode: "local",
    models: {},
    compactionScopes: {},
  })
  expect(settings([])).toEqual({ titleMode: "local", models: {}, compactionScopes: {} })
})

test("helper model precedence is agent override, role model, then session model", () => {
  const agent = ref("anthropic", "claude-sonnet", "high", "Agent account")
  const helper = ref("openai", "gpt-5-mini", "low", "Helper account")
  const session = ref("openrouter", "openai/gpt-5.6", "medium", "Session account")

  expect(selectHelperModel({ roleModel: helper, sessionModel: session, agentModel: agent })).toEqual(agent)
  expect(selectHelperModel({ roleModel: helper, sessionModel: session })).toEqual(helper)
  expect(selectHelperModel({ roleModel: "session", sessionModel: session })).toEqual(session)
  expect(selectHelperModel({ sessionModel: session })).toEqual(session)
  expect(selectHelperModel({})).toBeUndefined()
  expect(selectHelperModel({ roleModel: ref("openai", "gpt-5-mini"), sessionModel: session })).toEqual(
    ref("openai", "gpt-5-mini"),
  )
})

test("helper policy reads independent role models", () => {
  const info = Schema.decodeUnknownSync(Config.Info)({
    efficiency: {
      helper_models: {
        title: "openai/gpt-5-mini#low",
        goal: "session",
        compaction: { main: "anthropic/claude-opus-5" },
      },
    },
  })

  expect(settings([new Config.Document({ type: "document", info })])).toMatchObject({
    models: {
      title: ref("openai", "gpt-5-mini", "low"),
      goal: "session",
    },
    compactionScopes: {
      main: ref("anthropic", "claude-opus-5"),
    },
  })
})

test("decision helper settings retain model variants and the explicit session selection", () => {
  for (const selected of ["openai/decision-model#low", { providerID: "openai", model: "decision-model", variant: "low" }, "session"]) {
    const info = Schema.decodeUnknownSync(Config.Info)({ efficiency: { helper_models: { decision: selected } } })
    expect(settings([new Config.Document({ type: "document", info })]).models).toEqual({
      decision: selected === "session" ? "session" : ref("openai", "decision-model", "low"),
    })
    expect(Schema.encodeSync(Config.Info)(info)).toMatchObject({ efficiency: { helper_models: {
      decision: selected === "session" ? "session" : { providerID: "openai", model: "decision-model", variant: "low" },
    } } })
  }
  expect(() => Schema.decodeUnknownSync(Config.Info)({ efficiency: { helper_models: { decision: 42 } } })).toThrow()
})

test("prediction helper selection preserves session inheritance, profile and agent precedence", async () => {
  const selected = "Personal#openai/prediction-model#low"
  const info = Schema.decodeUnknownSync(Config.Info)({ efficiency: { helper_models: { prediction: selected } } })
  expect(settings([new Config.Document({ type: "document", info })]).models.prediction).toEqual(ref("openai", "prediction-model", "low", "Personal"))
  const session = SessionSchema.Info.make({ id: SessionSchema.ID.make("ses_prediction_model"), projectID: Project.ID.global,
    location: { directory: AbsolutePath.make("/project") }, title: "Prediction", time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) }, cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, model: ref("fixture", "owner", "medium", "Owner") })
  const seen: Array<SessionSchema.Info["model"]> = []
  const models: SessionRunnerModel.Interface = { resolve: input => Effect.sync(() => { seen.push(input.model); return SessionRunnerModel.resolved(Model.make({ id: "prediction-helper", provider: "fixture", route: OpenAIChat.route })) }) }
  const agent = { ...Agent.Info.empty(Agent.ID.make("prediction")), model: ref("fixture", "pinned", "high") }
  await Effect.runPromise(make(settings([new Config.Document({ type: "document", info })]), models).resolveModel(session, "prediction", agent))
  await Effect.runPromise(make(settings([new Config.Document({ type: "document", info })]), models).resolveModel(session, "prediction"))
  await Effect.runPromise(make(settings([]), models).resolveModel(session, "prediction"))
  expect(seen).toEqual([agent.model, ref("openai", "prediction-model", "low", "Personal"), session.model])
})

test("decision helper resolution preserves agent, configured, session, and default model precedence with native routes", async () => {
  const pinned = ref("fixture", "pinned", "high")
  const configured = ref("fixture", "configured", "low")
  const owner = ref("fixture", "owner", "medium")
  const defaultModel = ref("fixture", "default")
  const session = SessionSchema.Info.make({
    id: SessionSchema.ID.make("ses_decision_owner"),
    projectID: Project.ID.global,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
    title: "Decision owner",
    location: { directory: AbsolutePath.make("/project") },
  })
  const agent = Agent.Info.make({ ...Agent.Info.empty(Agent.ID.make("decision")), hidden: true, mode: "primary", model: pinned })
  for (const scenario of [
    { configured, owner, agent, expected: pinned },
    { configured: "session" as const, owner, agent, expected: pinned },
    { configured, owner, expected: configured },
    { configured: "session" as const, owner, expected: owner },
    { owner, expected: owner },
    { configured: "session" as const, expected: defaultModel },
    { expected: defaultModel },
  ]) {
    const policy = make({ titleMode: "local", models: { decision: scenario.configured } }, {
      resolve: (selected) => Effect.gen(function* () {
        const identity = selected.model ?? defaultModel
        const catalog = CatalogModel.Info.make({
          id: identity.id, providerID: identity.providerID, modelID: CatalogModel.ID.make(`api-${identity.id}`),
          name: "Decision fixture", package: "@ycoding-ai/ai/providers/openai", settings: { apiKey: "fixture-key" }, headers: {}, body: {},
          capabilities: { tools: false, input: ["text"], output: ["text"] },
          variants: ["high", "low", "medium"].map((variant) => ({ id: CatalogModel.VariantID.make(variant), body: { reasoning: { effort: variant } } })),
          time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 100, output: 20 },
        })
        const model = yield* SessionRunnerModel.resolve(selected, catalog)
        return { ...SessionRunnerModel.resolved(model, identity.variant), ref: identity }
      }),
    })
    const resolved = await Effect.runPromise(policy.resolveModel({ ...session, model: scenario.owner }, "decision", scenario.agent))
    expect(resolved?.ref).toEqual(scenario.expected)
    expect(String(resolved?.model.id)).toBe(`api-${scenario.expected.id}`)
    expect(resolved?.model.route.id).toBe("openai-responses")
    if (!resolved) throw new Error("expected a resolved decision model")
    const prepared = await Effect.runPromise(LLMClient.prepare(LLM.request({ model: resolved.model, prompt: "Evaluate the supplied decision state." })))
    expect(prepared.body).toMatchObject({ model: `api-${scenario.expected.id}` })
    expect(resolved.model.route.defaults.http?.body?.reasoning).toEqual(scenario.expected.variant ? { effort: scenario.expected.variant } : undefined)
  }
})

test("compaction model selection uses the owner Session scope before the hidden helper child exists", async () => {
  const main = ref("openai", "gpt-5.6-main", "high")
  const subagent = ref("openai", "gpt-5.6-subagent", "low")
  const pinned = ref("openai", "claude-pinned")
  const ownerModel = ref("openai", "owner", undefined, "Owner account")
  const selected: CatalogModel.Ref[] = []
  const policy = make(
    {
      titleMode: "local",
      models: {},
      compactionScopes: { main, subagent },
    },
    {
      resolve: (session) =>
        Effect.gen(function* () {
          if (session.model) selected.push(session.model)
          return yield* new SessionRunnerModel.ModelNotSelectedError({ sessionID: session.id })
        }),
    },
  )
  const rootID = SessionSchema.ID.make("ses_compaction_owner_root")
  const session = (id: SessionSchema.ID, parentID?: SessionSchema.ID) =>
    SessionSchema.Info.make({
      id,
      projectID: Project.ID.global,
      cost: Money.USD.zero,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
      title: "Compaction owner",
      location: { directory: AbsolutePath.make("/project") },
      model: ownerModel,
      ...(parentID === undefined ? {} : { parentID }),
    })
  const agent = Agent.Info.make({
    ...Agent.Info.empty(Agent.ID.make("compaction")),
    mode: "primary",
    hidden: true,
    model: pinned,
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* policy.resolveModel(session(rootID), "compaction", agent)
      yield* policy.resolveModel(
        session(SessionSchema.ID.make("ses_compaction_owner_child"), rootID),
        "compaction",
        agent,
      )
    }),
  )

  expect(selected).toEqual([main, subagent])
})
