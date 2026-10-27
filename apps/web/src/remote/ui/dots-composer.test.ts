import { expect, test } from "bun:test"
import { submission } from "./composer-logic"

test("the obsolete Dots slash action is refused", () => {
  expect(submission("/dots hello", [], undefined, "steer")).toEqual({ kind: "invalid", message: "This slash action is unavailable in the web composer." })
})
