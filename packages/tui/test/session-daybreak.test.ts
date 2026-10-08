import { expect, test } from "bun:test"
import { daybreakPlan, modelDaybreak } from "../src/util/session-daybreak"

const model = {
  daybreak: ["daybreak_blue"] as const,
  profiles: [
    { name: "Work", daybreak: ["daybreak_blue"] as const },
    { name: "Personal" },
  ],
}

test("uses profile-specific Daybreak programs instead of model-wide programs", () => {
  expect(modelDaybreak({ model, selection: { profile: "Work" } })).toEqual(["daybreak_blue"])
  expect(modelDaybreak({ model, selection: { profile: "Personal" } })).toEqual([])
  expect(modelDaybreak({ model })).toEqual(["daybreak_blue"])
  expect(daybreakPlan({ advertised: modelDaybreak({ model, selection: { profile: "Personal" } }), argument: "blue" })).toEqual({
    type: "reject",
    message: "Daybreak blue is not available for this model",
  })
})
