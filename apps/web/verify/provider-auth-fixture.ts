import type { RemoteRequestOutcome } from "../src/remote/transport"

export function createProviderAuthFixture() {
  let acceptedKey = false
  let acceptedCode = false
  let status: "pending" | "complete" = "pending"
  let readFailed = false
  let keyUnknown = false
  const profiles: { name: string; active: boolean }[] = [{ name: "Work", active: true }]
  const time = { created: Date.now(), expires: Date.now() + 600000 }
  return {
    report: () => ({ acceptedKey, acceptedCode, profiles }),
    failRead: () => { readFailed = true },
    unknownKey: () => { keyUnknown = true },
    request(operation: string, input: Readonly<Record<string, unknown>> = {}): RemoteRequestOutcome {
      if (operation === "provider.auth.list") return { status: "ok", value: { data: [{ id: "openai", name: "OpenAI", providers: ["openai"], profiles,
        methods: [{ type: "key", label: "API key", available: true }, { type: "oauth", id: "device", label: "Device authorization", available: true }, { type: "oauth", id: "manual", label: "CLI account", available: true }, { type: "oauth", id: "local", label: "Local browser", available: false, reason: "Sign in on the backend machine using /connect." }] }, { id: "environment", name: "Environment provider", providers: ["environment"], profiles: [], methods: [] }] } }
      if (operation === "provider.auth.key") {
        acceptedKey = input.key === "synthetic-test-key"
        if (keyUnknown) { keyUnknown = false; return { status: "unknown", error: { code: "outcome_unknown", message: "Unconfirmed" } } }
        profiles.forEach((profile) => { profile.active = false })
        profiles.push({ name: String(input.label), active: true })
        return { status: "ok", value: { data: { status: "complete" } } }
      }
      if (operation === "provider.auth.begin") { status = "pending"; return { status: "ok", value: { data: { type: "oauth", attemptID: "con_fixture", mode: "auto", url: "https://example.com/authorize", instructions: "Enter code ABCD-EFGH", ...(input.methodID === "manual" ? { manualCode: true } : {}), time } } } }
      if (operation === "provider.auth.status") {
        if (readFailed) { readFailed = false; return { status: "failed", error: { code: "internal_error", message: "synthetic-private-diagnostic" } } }
        return { status: "ok", value: { data: { status, time } } }
      }
      if (operation === "provider.auth.complete") { acceptedCode = input.code === "synthetic-test-code"; status = "complete"; return { status: "ok", value: { data: { status: "submitted" } } } }
      return { status: "ok", value: { data: { status: "cancelled" } } }
    },
  }
}
