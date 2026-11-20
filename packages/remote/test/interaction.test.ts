import { expect, test } from "bun:test"
import { parseClientMessage, remoteOperations } from "../src/index"

test("relay accepts only Session-scoped Interaction status, fenced preview and fenced Stop", () => {
  const id = "interaction-test"
  const sessionID = "ses_interaction_test"
  const generation = crypto.randomUUID()
  const parse = (operation: string, input?: unknown, owner?: string) => parseClientMessage(JSON.stringify({
    type: "request", id, operation, sessionID: owner, input,
  }))
  expect(remoteOperations.filter((operation) => operation.startsWith("session.interaction."))).toEqual([
    "session.interaction.status", "session.interaction.preview", "session.interaction.stop",
  ])
  expect(parse("session.interaction.status", undefined, sessionID).ok).toBe(true)
  for (const operation of ["session.interaction.preview", "session.interaction.stop"]) {
    expect(parse(operation, { generation }, sessionID).ok).toBe(true)
    expect(parse(operation, { generation }, undefined).ok).toBe(false)
    expect(parse(operation, { generation, consent: "fake" }, sessionID).ok).toBe(false)
    expect(parse(operation, { generation: "current" }, sessionID).ok).toBe(false)
  }
  expect(parse("session.interaction.approve", { generation }, sessionID).ok).toBe(false)
})
