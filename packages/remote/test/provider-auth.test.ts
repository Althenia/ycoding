import { expect, test } from "bun:test"
import { isProviderAuthorizationURL, parseClientMessage, parseRelayToAgentMessage } from "../src/index"

test("provider authentication admits only bounded explicit inputs and a backend-resolved target", () => {
  const target = { sessionID: "ses_existing" }
  const requests = [
    ["provider.auth.list", { target }],
    ["provider.auth.key", { target, integrationID: "openai", label: "Work", key: "synthetic-key" }],
    ["provider.auth.begin", { target: { workspace: "wsp_existing" }, integrationID: "openai", methodID: "headless", label: "Work", inputs: {} }],
    ["provider.auth.status", { target, integrationID: "openai", attemptID: "con_existing" }],
    ["provider.auth.complete", { target, integrationID: "anthropic", attemptID: "con_existing", code: "synthetic-code" }],
    ["provider.auth.cancel", { target, integrationID: "openai", attemptID: "con_existing" }],
  ] as const
  for (const [operation, input] of requests) {
    const frame = { type: "request", id: "req_auth", operation, input }
    expect(parseClientMessage(JSON.stringify(frame))).toMatchObject({ ok: true, value: frame })
    expect(parseRelayToAgentMessage(JSON.stringify(frame))).toMatchObject({ ok: true, value: frame })
    for (const fields of [{ ...input, directory: "/private" }, { ...input, target: { directory: "/private" } }, { ...input, target: { ...target, workspace: "wsp_other" } }])
      expect(parseClientMessage(JSON.stringify({ ...frame, input: fields })).ok).toBe(false)
    expect(parseClientMessage(JSON.stringify({ ...frame, sessionID: "ses_existing" })).ok).toBe(false)
  }
  for (const input of [{ target, integrationID: "openai", label: "", key: "synthetic" }, { target, integrationID: "openai", label: "Work", key: "" }, { target, integrationID: "openai", label: "Work", key: "x".repeat(8193) }])
    expect(parseClientMessage(JSON.stringify({ type: "request", id: "req_auth", operation: "provider.auth.key", input })).ok).toBe(false)
})

test("provider authorization links admit HTTPS without embedded credentials or loopback hosts", () => {
  expect(isProviderAuthorizationURL("https://example.com/authorize?code=synthetic")).toBe(true)
  for (const url of ["http://example.com/authorize", "https://user:secret@example.com/authorize", "https://localhost/", "https://auth.localhost/", "https://127.0.0.2/", "https://127.1/", "https://[::1]/", "https://[::ffff:127.0.0.1]/", "javascript:alert(1)"])
    expect(isProviderAuthorizationURL(url)).toBe(false)
})
