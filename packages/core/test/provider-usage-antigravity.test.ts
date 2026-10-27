import { describe, expect, test } from "bun:test"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { Provider } from "@ycoding-ai/core/provider"
import { ProviderUsageRuntime } from "@ycoding-ai/core/provider-usage"
import { AntigravityUsage } from "@ycoding-ai/core/provider-usage/antigravity"
import { Effect } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

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
const summaryPayload = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        {
          bucketId: "gemini-5h",
          displayName: "Five Hour Limit Remaining",
          window: "5h",
          remainingFraction: 0,
          resetTime: "2026-10-27T05:00:00Z",
          description: "Resets every five hours",
        },
        {
          bucketId: "gemini-weekly",
          displayName: "Weekly Limit Remaining",
          window: "weekly",
          remainingFraction: 0.75,
          resetTime: "2026-10-30T00:00:00Z",
        },
        { bucketId: "gemini-monthly", displayName: "Monthly Pool", window: "monthly", remainingFraction: 0.5 },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [
        { bucketId: "3p-weekly", displayName: "Weekly Limit Remaining", window: "weekly", remainingFraction: 0.4, resetTime: "2026-10-31T00:00:00Z" },
        { bucketId: "3p-5h", displayName: "Five Hour Limit Remaining", window: "5h", disabled: true, remainingFraction: 0.5 },
      ],
    },
    {
      displayName: "Gemini Models",
      buckets: [{ bucketId: "gemini-extra", displayName: "Extra pool", remainingFraction: 0.2 }],
    },
    {
      displayName: "Gemini 4 Argon",
      buckets: [
        { bucketId: "gemini-argon-wtu-weekly", displayName: "Gemini 4 Argon Weekly Limit", window: "weekly", remainingFraction: 1 },
      ],
    },
  ],
  buckets: [{ bucketId: "overall", displayName: "Overall limit", remainingFraction: 0.5 }],
}

const input = (credential: Credential.Info, updatedAt = 0) => ({
  providerID: Provider.ID.make("antigravity"),
  label: "Antigravity",
  credential,
  updatedAt,
})
const summaryURL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"

describe("AntigravityUsage", () => {
  test("pivots buckets into ordered group and window-kind rows with stable ids", () => {
    const snapshot = AntigravityUsage.normalize(summaryPayload, 1_800_000_000_000)
    expect(snapshot?.providerID).toBe(Provider.ID.make("antigravity"))
    expect(snapshot?.label).toBe("Antigravity")
    expect(snapshot?.status).toBe("available")
    expect(snapshot?.source).toBe("provider_internal_api")
    expect(snapshot?.stability).toBe("client_contract")
    expect(
      snapshot?.windows.map((window) => [window.group, window.label, window.id, window.used, window.periodSeconds]),
    ).toEqual([
      [undefined, "Overall limit", "overall", 50, undefined],
      ["Gemini Models", "Weekly limit", "Gemini Models/weekly", 25, 604_800],
      ["Gemini Models", "Five hour limit", "Gemini Models/five-hour", 100, 18_000],
      ["Gemini Models", "Monthly Pool", "Gemini Models/gemini-monthly", 50, undefined],
      ["Gemini Models", "Extra pool", "Gemini Models/gemini-extra", 80, undefined],
      ["Claude and GPT models", "Weekly limit", "Claude and GPT models/weekly", 60, 604_800],
      ["Gemini 4 Argon", "Weekly limit", "Gemini 4 Argon/weekly", 0, 604_800],
    ])
    const weekly = snapshot?.windows.find((window) => window.id === "Gemini Models/weekly")
    expect(weekly?.unit).toBe("percent")
    expect(weekly?.resetAt).toBe(Date.parse("2026-10-30T00:00:00Z"))
    expect(AntigravityUsage.normalize(summaryPayload, 0)?.windows.map((window) => window.id)).toEqual(
      snapshot?.windows.map((window) => window.id),
    )
  })

  test("orders weekly before five hour regardless of the reported order and merges split groups", () => {
    const snapshot = AntigravityUsage.normalize(
      {
        groups: [
          { displayName: "B", buckets: [{ bucketId: "b5", displayName: "Five hour limit", remainingFraction: 0.5 }] },
          { displayName: "A", buckets: [{ bucketId: "a5", displayName: "Five hour limit", remainingFraction: 0.5 }] },
          { displayName: "B", buckets: [{ bucketId: "bw", displayName: "Weekly limit", remainingFraction: 0.5 }] },
          { displayName: "A", buckets: [{ bucketId: "aw", displayName: "Weekly limit", remainingFraction: 0.5 }] },
        ],
      },
      0,
    )
    expect(snapshot?.windows.map((window) => window.id)).toEqual(["B/weekly", "B/five-hour", "A/weekly", "A/five-hour"])
  })

  test("a second bucket of the same window kind keeps its reported name instead of replacing the first", () => {
    const snapshot = AntigravityUsage.normalize(
      {
        groups: [
          {
            displayName: "G",
            buckets: [
              { bucketId: "w1", displayName: "Weekly limit", remainingFraction: 0.5 },
              { bucketId: "w2", displayName: "Weekly overflow", remainingFraction: 0.25 },
            ],
          },
        ],
      },
      0,
    )
    expect(snapshot?.windows.map((window) => [window.id, window.label, window.periodSeconds])).toEqual([
      ["G/weekly", "Weekly limit", 604_800],
      ["G/w2", "Weekly overflow", undefined],
    ])
  })

  test("derives period only from an unambiguous weekly or five hour window, id, or name", () => {
    const bucket = (fields: Record<string, unknown>) => ({ remainingFraction: 0.5, ...fields })
    const period = (fields: Record<string, unknown>) =>
      AntigravityUsage.normalize({ buckets: [bucket(fields)] }, 0)?.windows[0]?.periodSeconds
    const cases: [Record<string, unknown>, number | undefined][] = [
      [{ bucketId: "a", displayName: "A", window: 604_800 }, 604_800],
      [{ bucketId: "b", displayName: "B", window: "18000s" }, 18_000],
      [{ bucketId: "c", displayName: "C", window: "WINDOW_FIVE_HOUR" }, 18_000],
      [{ bucketId: "i", displayName: "I", window: "5-hour" }, 18_000],
      [{ bucketId: "j", displayName: "J", window: "five_hour" }, 18_000],
      [{ bucketId: "k", displayName: "K", window: "5H" }, 18_000],
      [{ bucketId: "l", displayName: "L", window: "Weekly" }, 604_800],
      [{ bucketId: "3p-5h", displayName: "M" }, 18_000],
      [{ bucketId: "gemini-argon-wtu-weekly", displayName: "Gemini 4 Argon Weekly Limit" }, 604_800],
      [{ bucketId: "d", displayName: "Weekly limit", window: 3 }, 604_800],
      [{ bucketId: "e", displayName: "E", window: 3 }, undefined],
      [{ bucketId: "f", displayName: "Weekly five hour limit" }, undefined],
      [{ bucketId: "g", displayName: "Daily limit", window: 86_400 }, undefined],
      [{ bucketId: "h", displayName: "H", window: { seconds: 18_000 } }, undefined],
    ]
    for (const [fields, expected] of cases) expect(period(fields)).toBe(expected)
  })

  test("skips disabled buckets and buckets without a reported fraction", () => {
    const snapshot = AntigravityUsage.normalize(
      {
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              { bucketId: "disabled", displayName: "Disabled", remainingFraction: 0.5, disabled: true },
              { bucketId: "amount", displayName: "Amount", remainingAmount: 5 },
              { bucketId: "bare", displayName: "Bare" },
              { bucketId: "invalid", displayName: "Invalid", remainingFraction: 1.5 },
              { bucketId: "ok", displayName: "Okay", remainingFraction: 1 },
            ],
          },
          { displayName: "Empty group", buckets: [{ bucketId: "x", displayName: "X" }] },
        ],
      },
      0,
    )
    expect(snapshot?.windows.map((window) => [window.id, window.used])).toEqual([["Gemini Models/ok", 0]])
  })

  test("returns undefined unless the payload carries a bucket or group list", () => {
    expect(AntigravityUsage.normalize(undefined, 0)).toBeUndefined()
    expect(AntigravityUsage.normalize([], 0)).toBeUndefined()
    expect(AntigravityUsage.normalize({}, 0)).toBeUndefined()
    expect(AntigravityUsage.normalize({ response: {} }, 0)).toBeUndefined()
    expect(AntigravityUsage.normalize({ models: { a: { quotaInfo: { remainingFraction: 0.5 } } } }, 0)).toBeUndefined()
  })

  test("a parsed summary without usable buckets reports no windows", () => {
    for (const payload of [
      { buckets: [], groups: [] },
      { groups: [{ displayName: "G", buckets: [{ bucketId: "a", disabled: true, remainingFraction: 0.5 }] }] },
      { groups: [{ displayName: "Gemini 4 Argon", buckets: [{ bucketId: "gemini-argon-wtu-weekly" }] }] },
    ])
      expect(AntigravityUsage.normalize(payload, 5)).toMatchObject({ status: "available", updatedAt: 5, windows: [] })
  })

  test("decodes wrapped payloads and nested remaining fractions, leaving a missing reset unset", () => {
    const snapshot = AntigravityUsage.normalize(
      {
        response: {
          groups: [
            {
              displayName: "Gemini Models",
              buckets: [
                { bucketId: "gemini-5h", window: "5h", remaining: { remainingFraction: 0.5 } },
                { bucketId: "gemini-weekly", window: "weekly", remaining: { remainingFraction: 0.25 }, remainingFraction: 0.75 },
              ],
            },
          ],
        },
      },
      0,
    )
    expect(snapshot?.windows.map((window) => [window.id, window.used, window.resetAt])).toEqual([
      ["Gemini Models/weekly", 25, undefined],
      ["Gemini Models/five-hour", 50, undefined],
    ])
  })

  test("buckets of a group without a display name render ungrouped", () => {
    const snapshot = AntigravityUsage.normalize(
      { groups: [{ buckets: [{ bucketId: "solo", displayName: "Solo", remainingFraction: 0.5 }] }] },
      0,
    )
    expect(snapshot?.windows.map((window) => [window.id, window.group])).toEqual([["solo", undefined]])
  })

  test("adapter reads only the quota summary with the account bearer and stored project", async () => {
    const seen: HttpClientRequest.HttpClientRequest[] = []
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        seen.push(request)
        return HttpClientResponse.fromWeb(request, Response.json(summaryPayload))
      }),
    )
    const credential = credentialInfo({ projectID: "project-1" })
    const snapshot = await Effect.runPromise(
      ProviderUsageRuntime.antigravity(client, input(credential, 1_800_000_000_000), connectionFor(credential)),
    )
    expect(seen.map((request) => request.url)).toEqual([summaryURL])
    expect(seen[0]?.headers.authorization).toBe("Bearer google-access")
    expect(seen[0]?.headers["user-agent"]).toStartWith("antigravity/hub/2.26.0")
    if (seen[0]?.body._tag !== "Uint8Array") throw new Error("Expected encoded body")
    expect(JSON.parse(new TextDecoder().decode(seen[0].body.body))).toEqual({ project: "project-1" })
    expect(snapshot.windows.map((window) => window.group)).toEqual([
      undefined,
      "Gemini Models",
      "Gemini Models",
      "Gemini Models",
      "Gemini Models",
      "Claude and GPT models",
      "Gemini 4 Argon",
    ])
  })

  test.each([
    ["a server error", () => new Response("unavailable", { status: 500 }), 500],
    ["a missing method", () => new Response("missing", { status: 404 }), 404],
    ["malformed JSON", () => new Response("not json", { status: 200 }), 200],
    ["a payload without bucket lists", () => Response.json({ response: {} }), 200],
    ["a per-model payload", () => Response.json({ models: { a: { quotaInfo: { remainingFraction: 0.5 } } } }), 200],
  ])("adapter surfaces %s as a request error without another request", async (_name, summary, status) => {
    const seen: string[] = []
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        seen.push(request.url)
        return HttpClientResponse.fromWeb(request, summary())
      }),
    )
    const credential = credentialInfo()
    const error = await Effect.runPromise(
      ProviderUsageRuntime.antigravity(client, input(credential), connectionFor(credential)).pipe(Effect.flip),
    )
    expect(error).toMatchObject({ _tag: "ProviderUsage.RequestError", status })
    expect(seen).toEqual([summaryURL])
  })

  test("adapter surfaces a transport failure as a request error", async () => {
    const client = HttpClient.make((request) =>
      Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request }) })),
    )
    const credential = credentialInfo()
    const error = await Effect.runPromise(
      ProviderUsageRuntime.antigravity(client, input(credential), connectionFor(credential)).pipe(Effect.flip),
    )
    expect(error).toMatchObject({ _tag: "ProviderUsage.RequestError" })
  })

  test("adapter surfaces unauthorized responses as request errors", async () => {
    const client = HttpClient.make((request) =>
      Effect.sync(() => HttpClientResponse.fromWeb(request, new Response("denied", { status: 401 }))),
    )
    const credential = credentialInfo()
    const error = await Effect.runPromise(
      ProviderUsageRuntime.antigravity(client, input(credential), connectionFor(credential)).pipe(Effect.flip),
    )
    expect(error).toMatchObject({ _tag: "ProviderUsage.RequestError", status: 401 })
  })
})
