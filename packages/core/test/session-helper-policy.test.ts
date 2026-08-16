import { expect, test } from "bun:test"
import { Config } from "@ycoding-ai/core/config"
import { ModelV2 } from "@ycoding-ai/core/model"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { localGoal, localTitle, selectHelperModel, settings } from "@ycoding-ai/core/session/helper-policy"
import { Schema } from "effect"

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
