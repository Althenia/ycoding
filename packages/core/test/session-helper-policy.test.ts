import { expect, test } from "bun:test"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { ModelV2 } from "@ycoding-ai/core/model"
import { ProjectV2 } from "@ycoding-ai/core/project"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { localGoal, localTitle, make, selectHelperModel, settings } from "@ycoding-ai/core/session/helper-policy"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { Money } from "@ycoding-ai/schema/money"
import { DateTime, Effect, Schema } from "effect"

const ref = (providerID: string, id: string, variant?: string) =>
  ModelV2.Ref.make({
    providerID: ProviderV2.ID.make(providerID),
    id: ModelV2.ID.make(id),
    ...(variant === undefined ? {} : { variant: ModelV2.VariantID.make(variant) }),
  })

test("local title produces one terminal-safe line without a provider call", () => {
  expect(localTitle("  # Fix the migration\nIgnore this line  ")).toBe("Fix the migration")
  expect(localTitle("\u0000>   Repair   the   build\u0007")).toBe("Repair the build")
  expect(localTitle("\u001b[31m## Repair migration\u001b[0m")).toBe("Repair migration")
  expect(localTitle("   ")).toBe("New session")
  expect(localTitle("界".repeat(60))).toBe(`${"界".repeat(47)}...`)
})

test("local goal preserves meaning while normalizing whitespace", () => {
  expect(localGoal("  Fix\n the\tmigration and   run tests. ")).toBe("Fix the migration and run tests.")
  expect(localGoal("   ")).toBe("")
})

test("helper model precedence is agent override, role model, then session model", () => {
  const agent = ref("anthropic", "claude-sonnet", "high")
  const helper = ref("openai", "gpt-5-mini", "low")
  const session = ref("openrouter", "openai/gpt-5.6", "medium")

  expect(selectHelperModel({ roleModel: helper, sessionModel: session, agentModel: agent })).toEqual(agent)
  expect(selectHelperModel({ roleModel: helper, sessionModel: session })).toEqual(helper)
  expect(selectHelperModel({ roleModel: "session", sessionModel: session })).toEqual(session)
  expect(selectHelperModel({ sessionModel: session })).toEqual(session)
  expect(selectHelperModel({})).toBeUndefined()
})

test("helper policy reads independent role models", () => {
  const info = Schema.decodeUnknownSync(Config.Info)({
    efficiency: {
      helper_models: {
        title: "openai/gpt-5-mini#low",
        compaction: { main: "anthropic/claude-opus-5" },
      },
    },
  })

  expect(settings([new Config.Document({ type: "document", info })])).toMatchObject({
    models: {
      title: ref("openai", "gpt-5-mini", "low"),
    },
    compactionScopes: {
      main: ref("anthropic", "claude-opus-5"),
    },
  })
})

test("compaction model selection uses the owner Session scope before the hidden helper child exists", async () => {
  const main = ref("openai", "gpt-5.6-main", "high")
  const subagent = ref("openai", "gpt-5.6-subagent", "low")
  const pinned = ref("anthropic", "claude-pinned")
  const selected: ModelV2.Ref[] = []
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
      projectID: ProjectV2.ID.global,
      cost: Money.USD.zero,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
      title: "Compaction owner",
      location: { directory: AbsolutePath.make("/project") },
      ...(parentID === undefined ? {} : { parentID }),
    })
  const agent = AgentV2.Info.make({
    ...AgentV2.Info.empty(AgentV2.ID.make("compaction")),
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
