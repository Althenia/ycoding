import { describe, expect, test } from "bun:test"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { Provider } from "@ycoding-ai/core/provider"
import { ProviderUsageRuntime } from "@ycoding-ai/core/provider-usage"
import { AntigravityUsage } from "@ycoding-ai/core/provider-usage/antigravity"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

const connectionFor = (credential: Credential.Info) => ({
  snapshot: () =>
    Effect.succeed({
      connection: { type: "credential" as const, id: credential.id, label: credential.label, active: true },
      credential,
      value: credential.value,
    }),
})
const credentialInfo = (metadata?: Record<string, unknown>) =>
  new Credential.Info({
    id: Credential.ID.make("cred_antigravity"),
    integrationID: Integration.ID.make("antigravity"),
    label: "Google account",
    value: Credential.OAuth.make({
      type: "oauth",
      methodID: Integration.MethodID.make("google"),
      access: "google-access",
      refresh: "google-refresh",
      expires: 0,
      ...(metadata ? { metadata } : {}),
    }),
  })
const payload = {
  models: {
    "gemini-fixture": {
      displayName: "Gemini Fixture",
      quotaInfo: { remainingFraction: 0.75, resetTime: "2026-10-25T00:00:00Z" },
    },
    "claude-fixture": {
      displayName: "Claude Fixture",
      quotaInfo: { remainingFraction: 0, resetTime: "2026-10-26T00:00:00Z" },
    },
    "unreported-fixture": { displayName: "Unreported Fixture" },
    "invalid-fixture": { displayName: "Invalid Fixture", quotaInfo: { remainingFraction: 1.5 } },
  },
}

describe("AntigravityUsage", () => {
  test("normalizes per-model remaining fractions into percent windows", () => {
    const snapshot = AntigravityUsage.normalize(payload, 1_800_000_000_000)
    expect(snapshot).toBeDefined()
    expect(snapshot?.providerID).toBe(Provider.ID.make("antigravity"))
    expect(snapshot?.label).toBe("Antigravity")
    expect(snapshot?.status).toBe("available")
    expect(snapshot?.source).toBe("provider_internal_api")
    expect(snapshot?.stability).toBe("client_contract")
    expect(snapshot?.windows.map((window) => window.id)).toEqual(["claude-fixture", "gemini-fixture"])
    const gemini = snapshot?.windows.find((window) => window.id === "gemini-fixture")
    expect(gemini?.label).toBe("Gemini Fixture")
    expect(gemini?.unit).toBe("percent")
    expect(gemini?.used).toBe(25)
    expect(gemini?.resetAt).toBe(Date.parse("2026-10-25T00:00:00Z"))
    const claude = snapshot?.windows.find((window) => window.id === "claude-fixture")
    expect(claude?.used).toBe(100)
  })

  test("returns undefined for payloads without a models record", () => {
    expect(AntigravityUsage.normalize(undefined, 0)).toBeUndefined()
    expect(AntigravityUsage.normalize({}, 0)).toBeUndefined()
    expect(AntigravityUsage.normalize({ models: [] }, 0)).toBeUndefined()
  })

  test("adapter fetches available models with the account bearer and stored project", async () => {
    let seen: HttpClientRequest.HttpClientRequest | undefined
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        seen = request
        return HttpClientResponse.fromWeb(request, Response.json(payload))
      }),
    )
    const credential = credentialInfo({ projectID: "project-1" })
    const snapshot = await Effect.runPromise(
      ProviderUsageRuntime.antigravity(client, {
        providerID: Provider.ID.make("antigravity"),
        label: "Antigravity",
        credential,
        updatedAt: 1_800_000_000_000,
      }, connectionFor(credential)),
    )
    expect(seen?.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels")
    expect(seen?.headers.authorization).toBe("Bearer google-access")
    expect(seen?.headers["user-agent"]).toStartWith("antigravity/hub/2.26.0")
    if (seen?.body._tag !== "Uint8Array") throw new Error("Expected encoded body")
    expect(JSON.parse(new TextDecoder().decode(seen.body.body))).toEqual({ project: "project-1" })
    expect(snapshot.windows.map((window) => window.id)).toEqual(["claude-fixture", "gemini-fixture"])
  })

  test("adapter surfaces unauthorized responses as request errors", async () => {
    const client = HttpClient.make((request) =>
      Effect.sync(() => HttpClientResponse.fromWeb(request, new Response("denied", { status: 401 }))),
    )
    const credential = credentialInfo()
    const error = await Effect.runPromise(
      ProviderUsageRuntime.antigravity(client, {
        providerID: Provider.ID.make("antigravity"),
        label: "Antigravity",
        credential,
        updatedAt: 0,
      }, connectionFor(credential)).pipe(Effect.flip),
    )
    expect(error).toMatchObject({ _tag: "ProviderUsage.RequestError", status: 401 })
  })
})
