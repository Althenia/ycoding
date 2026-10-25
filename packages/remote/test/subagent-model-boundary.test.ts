import { expect, test } from "bun:test"
import { remoteOperations } from "../src/index"

test("parent child-model selection is not a remote operation", () => {
  expect(remoteOperations).not.toContain("session.subagent.switchModel")
})
