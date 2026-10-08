import { expect, test } from "bun:test"
import { Form } from "@ycoding-ai/schema/form"
import { Schema } from "effect"
import { formInitialValues, formSelected, formDisplayValue } from "../src/util/form"

test("Schema-native question defaults preselect an option and permit a different answer", () => {
  const field = {
    key: "q0",
    type: "string" as const,
    title: "Plan",
    description: "Which rollout plan fits the user's request to avoid downtime?",
    custom: true,
    default: "Careful",
    options: [
      { value: "Fast", label: "Fast", description: "Deploy everything at once" },
      {
        value: "Careful",
        label: "Careful",
        description:
          "Roll out gradually with health checks (Suggested by the decision helper: model confidence 0.90, uncalibrated)",
      },
    ],
  }
  expect(Schema.decodeUnknownSync(Form.StringField)(field)).toEqual(field)
  expect(formInitialValues([field])).toEqual({ answers: { q0: "Careful" }, custom: {} })
  expect(formSelected(field, formInitialValues([field]).answers.q0)).toBe(1)
  expect(formSelected(field, "Fast")).toBe(0)
  expect(formDisplayValue(field, "Fast", "None")).toBe("Fast")
  const { default: suggestion, ...unchanged } = field
  expect(suggestion).toBe("Careful")
  expect(formInitialValues([unchanged])).toEqual({ answers: {}, custom: {} })
})
