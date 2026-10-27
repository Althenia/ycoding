import { expect, test } from "bun:test"
import { parseClientMessage, remoteOperationAccess, remoteOperations } from "../src/index"

const parse = (operation: string, input?: unknown, sessionID: string | null = "ses_test") =>
  parseClientMessage(JSON.stringify({ type: "request", id: "req_test", operation, sessionID, input }))

test("remote access controls are closed, revision fenced, and Session scoped", () => {
  expect(parse("session.dots.access.get").ok).toBe(true)
  expect(parse("session.dots.access.get", undefined, null).ok).toBe(false)
  expect(parse("session.dots.access.set", { enabled: true, expectedRevision: 0 }).ok).toBe(true)
  for (const input of [{ enabled: true }, { enabled: true, expectedRevision: -1 }, { enabled: true, expectedRevision: 1.5 }, { enabled: true, expectedRevision: 0, source: {} }])
    expect(parse("session.dots.access.set", input).ok).toBe(false)
  expect(remoteOperationAccess["session.dots.access.get"]).toBe("read")
  expect(remoteOperationAccess["session.dots.access.set"]).toBe("mutation")
})

test("remote access projection rejects malformed values instead of inventing defaults", async () => {
  const { readDotsAccess } = await import("../src/index")
  const access = { sessionID: "ses_test", rootSessionID: "ses_test", enabled: false, revision: 0, inherited: false, configured: true }
  expect(readDotsAccess(access)).toEqual(access)
  for (const value of [{ ...access, revision: -1 }, { ...access, revision: 1.5 }, { ...access, enabled: "false" }, { ...access, configured: undefined }])
    expect(readDotsAccess(value)).toBeUndefined()
})

test("remote exposes only access administration for Dots", () => {
  expect(remoteOperations.filter((operation) => operation.startsWith("session.dots."))).toEqual([
    "session.dots.access.get", "session.dots.access.set",
  ])
  for (const operation of ["session.dots.bind", "session.dots.exchange.create", "local.app.open", "artifact.demo.preview", "mcp.request"])
    expect(parse(operation).ok).toBe(false)
})
