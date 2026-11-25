import { expect, test } from "bun:test"
import { parseClientMessage, remoteOperationAccess } from "../src/index"

test("MCP App view accepts only an exact tool result within a shared Session", () => {
  const operation = "mcp.app.view"
  const input = { messageID: "msg_tool", callID: "call_summary" }
  const parse = (fields: unknown, sessionID?: string, name = operation) =>
    parseClientMessage(JSON.stringify({ type: "request", id: "app-view", operation: name, sessionID, input: fields }))
  const session = "ses_app"
  expect(parse(input, session).ok).toBe(true)
  expect(Reflect.get(remoteOperationAccess, operation)).toBe("read")
  expect(parse(input).ok).toBe(false)
  expect(parse(input, "invalid").ok).toBe(false)
  expect(parse({ ...input, messageID: "ses_other" }, session).ok).toBe(false)
  for (const key of ["uri", "server", "tool", "directory", "workspace", "sessionID"]) {
    expect(parse({ ...input, [key]: "other" }, session).ok).toBe(false)
  }
  expect(parse({ ...input, callID: "" }, session).ok).toBe(false)
  expect(parse(input, session, "mcp.app.call").ok).toBe(false)
})
