import { expect, test } from "bun:test"
import { isProviderAuthorizationURL, remoteDescriptors } from "../src/index"
import { PeerRole } from "@ycoding-ai/protocol/v5"

test("provider authorization uses six generated operations with backend-resolved targets", () => {
  const descriptors = remoteDescriptors.filter((item) => item.diagnosticName.startsWith("provider.auth."))
  expect(descriptors.map((item) => item.diagnosticName)).toEqual([
    "provider.auth.list",
    "provider.auth.key",
    "provider.auth.begin",
    "provider.auth.status",
    "provider.auth.complete",
    "provider.auth.cancel",
  ])
  expect(descriptors.every((item) => item.roles.includes(PeerRole.RELAY))).toBe(true)
})

test("provider authorization links admit HTTPS without embedded credentials or loopback hosts", () => {
  expect(isProviderAuthorizationURL("https://example.com/authorize?code=synthetic")).toBe(true)
  for (const url of [
    "http://example.com/authorize",
    "https://user:secret@example.com/authorize",
    "https://localhost/",
    "https://auth.localhost/",
    "https://127.0.0.2/",
    "https://127.1/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "javascript:alert(1)",
  ])
    expect(isProviderAuthorizationURL(url)).toBe(false)
})
