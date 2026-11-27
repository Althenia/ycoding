import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigCapabilities } from "../src/config/capabilities"

test("capabilities declare no project artifact switch", () => {
  expect(Object.keys(ConfigCapabilities.Info.fields)).not.toContain("project_artifacts")
  expect(Schema.decodeUnknownSync(ConfigCapabilities.BuiltinInstruction)("shell-memory")).toBe("shell-memory")
  expect(() => Schema.decodeUnknownSync(ConfigCapabilities.BuiltinInstruction)("project-artifact-authoring")).toThrow()
})

test("tool allowance has no project artifact special case", () => {
  expect(ConfigCapabilities.allowsTool({ tools: { allow: ["project_artifact"] } }, "project_artifact")).toBe(true)
  expect(ConfigCapabilities.allowsTool({ tools: { allow: ["read"] } }, "project_artifact")).toBe(false)
})
