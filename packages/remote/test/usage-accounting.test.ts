import { expect, test } from "bun:test"
import { parseClientMessage, remoteOperationAccess } from "../src/index"

const request = (operation: string, input?: unknown, sessionID?: string) =>
  parseClientMessage(JSON.stringify({ type: "request", id: "req_usage", operation, input, sessionID }))

test("new accounting operations are closed read operations with mandatory Session scope", () => {
  for (const [operation, input] of [
    ["session.usageReport", { group: "prompt", selectedEffort: "high", profile: "work" }],
    ["session.promptCosts", { inputIDs: ["msg_1"] }],
    ["session.taskCosts", { sessionIDs: ["ses_child"] }],
  ] as const) {
    expect(remoteOperationAccess[operation]).toBe("read")
    expect(request(operation, input, "ses_root").ok).toBe(true)
    expect(request(operation, input).ok).toBe(false)
    expect(request(operation, { ...input, directory: "/untrusted" }, "ses_root").ok).toBe(false)
  }
})

test("remote report dimensions and effort filters match Schema without arbitrary keys", () => {
  for (const group of ["provider", "provider-profile-model", "provider-model", "model-id", "profile", "prompt", "task"])
    expect(request("usage.report", { group, providerID: "openai", modelID: "m", profile: "work", selectedEffort: "high" }).ok).toBe(true)
  expect(request("usage.report", { group: "profile", accountDigest: "private" }).ok).toBe(false)
  expect(request("usage.report", { group: "provider", selectedEffort: "" }).ok).toBe(false)
})

test("remote prompt and task batches reject duplicate, empty, oversized and malformed identities", () => {
  for (const [operation, key, prefix] of [["session.promptCosts", "inputIDs", "msg"], ["session.taskCosts", "sessionIDs", "ses"]] as const) {
    expect(request(operation, { [key]: Array.from({ length: 100 }, (_, index) => `${prefix}_${index}`) }, "ses_root").ok).toBe(true)
    for (const ids of [[], ["bad"], [`${prefix}_1`, `${prefix}_1`], Array.from({ length: 101 }, (_, index) => `${prefix}_${index}`)])
      expect(request(operation, { [key]: ids }, "ses_root").ok).toBe(false)
  }
})

test("forecast uses explicit local scope with optional backend-resolved Session Location", () => {
  expect(remoteOperationAccess["usage.forecast"]).toBe("read")
  expect(request("usage.forecast", { localScope: "backend" }).ok).toBe(true)
  expect(request("usage.forecast", { localScope: "location" }, "ses_root").ok).toBe(true)
  expect(request("usage.forecast", { localScope: "location" }).ok).toBe(false)
  expect(request("usage.forecast", { localScope: "backend" }, "ses_root").ok).toBe(false)
  for (const input of [{}, { localScope: "account" }, { localScope: "backend", refresh: true }, { localScope: "location", directory: "/untrusted" }])
    expect(request("usage.forecast", input, "ses_root").ok).toBe(false)
})
