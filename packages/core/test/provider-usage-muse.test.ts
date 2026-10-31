import { describe, expect, test } from "bun:test"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { ProviderUsageRuntime } from "@ycoding-ai/core/provider-usage"
import { MuseUsage } from "@ycoding-ai/core/provider-usage/muse"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { Provider } from "@ycoding-ai/core/provider"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { observeMuseUsage } from "@ycoding-ai/core/plugin/provider/muse"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

const event = {
  subscription: {
    tier: "27681527378179523",
    weekly: { resets_at: 1792368000, used_percent: 0 },
    window: { resets_at: 1791876076, used_percent: 0, window_duration_mins: 300 },
  },
  type: "response.subscription_usage",
}

describe("MuseUsage", () => {
  test("accepts overages and nullable optional fields without showing opaque tiers", () => {
    const snapshot = MuseUsage.normalize(
      {
        type: event.type,
        subscription: {
          tier: null,
          window: { used_percent: 125.5, resets_at: null, window_duration_mins: null },
          weekly: { used_percent: 101, resets_at: null },
        },
      },
      12.9,
      " Plus ",
    )
    expect(snapshot).toMatchObject({
      label: "Muse (Meta) · Plus",
      updatedAt: 12,
      windows: [{ used: 125.5 }, { used: 101 }],
    })
    expect(
      MuseUsage.normalize({ type: event.type, subscription: { tier: null, window: null, weekly: null } }, 0)?.windows,
    ).toEqual([])
    expect(MuseUsage.normalizeSubscription({ tier: "opaque", weekly: { used_percent: null } }, -1, " ")).toMatchObject({
      label: "Muse (Meta)",
      updatedAt: 0,
    })
  })

  test("refresh reports unauthorized for rejected and expired OAuth accounts", async () => {
    const credential = new Credential.Info({
      id: Credential.ID.make("cred_muse_unauthorized"),
      integrationID: Integration.ID.make("muse"),
      label: "Muse",
      value: Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("device"),
        access: "fixture",
        refresh: "",
        expires: 0,
      }),
    })
    let calls = 0
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        calls++
        return HttpClientResponse.fromWeb(request, Response.json({}, { status: 401 }))
      }),
    )
    const adapter = ProviderUsageRuntime.createMuseUsageAdapter(client)
    const input = { providerID: Provider.ID.make("muse"), label: "Muse", credential, updatedAt: 100, refresh: true }
    expect(await Effect.runPromise(Effect.flip(adapter(input)))).toMatchObject({ status: 401 })
    const expired = new Credential.Info({
      id: credential.id,
      integrationID: credential.integrationID,
      label: credential.label,
      value: Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("device"),
        access: "fixture",
        refresh: "",
        expires: 100,
      }),
    })
    expect(await Effect.runPromise(Effect.flip(adapter({ ...input, credential: expired })))).toMatchObject({
      status: 401,
    })
    expect(calls).toBe(1)
  })

  test("coalesces concurrent refreshes for the same account", async () => {
    const credential = new Credential.Info({
      id: Credential.ID.make("cred_muse_concurrent"),
      integrationID: Integration.ID.make("muse"),
      label: "Muse",
      value: Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("device"),
        access: "fixture",
        refresh: "",
        expires: 0,
      }),
    })
    let calls = 0
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        calls++
        yield* Effect.yieldNow
        return HttpClientResponse.fromWeb(request, Response.json({ subs_usage: { weekly: { used_percent: 10 } } }))
      }),
    )
    const adapter = ProviderUsageRuntime.createMuseUsageAdapter(client)
    const input = { providerID: Provider.ID.make("muse"), label: "Muse", credential, updatedAt: 100, refresh: true }
    const result = await Effect.runPromise(Effect.all([adapter(input), adapter(input)], { concurrency: "unbounded" }))
    expect(result).toMatchObject([{ windows: [{ used: 10 }] }, { windows: [{ used: 10 }] }])
    expect(calls).toBe(1)
  })

  test("refreshes OAuth usage at most once per account per minute", async () => {
    const providerID = Provider.ID.make("muse")
    const oauth = new Credential.Info({
      id: Credential.ID.make("cred_muse_oauth"),
      integrationID: Integration.ID.make("muse"),
      label: "Muse",
      value: Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("device"),
        access: "fixture",
        refresh: "",
        expires: 0,
      }),
    })
    const key = new Credential.Info({
      id: oauth.id,
      integrationID: oauth.integrationID,
      label: oauth.label,
      value: Credential.Key.make({ type: "key", key: "fixture" }),
    })
    let calls = 0
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        calls++
        expect(request.url).toBe("https://api.meta.ai/muse-code/key")
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ subs_tier_name: "Plus", subs_usage: { weekly: { used_percent: 101 } } }),
        )
      }),
    )
    const adapter = ProviderUsageRuntime.createMuseUsageAdapter(client)
    const input = { providerID, label: "Muse", credential: oauth, updatedAt: 100_000 }
    expect(await Effect.runPromise(adapter(input))).toMatchObject({ status: "unsupported" })
    expect(await Effect.runPromise(adapter({ ...input, credential: key, refresh: true }))).toMatchObject({
      status: "unsupported",
    })
    expect(calls).toBe(0)
    expect(await Effect.runPromise(adapter({ ...input, refresh: true }))).toMatchObject({
      label: "Muse (Meta) · Plus",
      windows: [{ used: 101 }],
    })
    await Effect.runPromise(adapter({ ...input, updatedAt: 159_999, refresh: true }))
    expect(calls).toBe(1)
    await Effect.runPromise(adapter({ ...input, updatedAt: 160_000, refresh: true }))
    expect(calls).toBe(2)
  })

  for (const [payload, expected] of [
    [{ is_subs_active: false }, { status: "unsupported", message: "Muse subscription/payment setup is required" }],
    [
      { subs_tier_name: "Plus" },
      { status: "unsupported", label: "Muse (Meta) · Plus", message: "Quota is reported after the next Muse response" },
    ],
  ] as const)
    test(`refresh handles subscription state ${JSON.stringify(payload)}`, async () => {
      const credential = new Credential.Info({
        id: Credential.ID.make("cred_muse_state"),
        integrationID: Integration.ID.make("muse"),
        label: "Muse",
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("device"),
          access: "fixture",
          refresh: "",
          expires: 0,
        }),
      })
      const client = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(payload))),
      )
      const adapter = ProviderUsageRuntime.createMuseUsageAdapter(client)
      expect(
        await Effect.runPromise(
          adapter({ providerID: Provider.ID.make("muse"), label: "Muse", credential, updatedAt: 100, refresh: true }),
        ),
      ).toMatchObject(expected)
    })

  test("shares streamed account quota across Location readers without crossing profiles or replacement accounts", async () => {
    const providerID = Provider.ID.make("muse")
    const personal = new Credential.Info({
      id: Credential.ID.make("cred_muse_personal"),
      integrationID: Integration.ID.make("muse"),
      label: "Personal",
      value: Credential.Key.make({ type: "key", key: "fixture-personal" }),
      active: true,
    })
    const work = new Credential.Info({
      id: Credential.ID.make("cred_muse_work"),
      integrationID: Integration.ID.make("muse"),
      label: "Work",
      value: Credential.Key.make({ type: "key", key: "fixture-work" }),
    })
    let credentials = [personal, work]
    const accountObservations = new Map<string, ProviderUsage.Snapshot>()
    const input = {
      credentials: { all: () => Effect.succeed(credentials) },
      providers: { available: () => Effect.succeed([{ id: providerID }]) },
      adapters: { muse: ProviderUsageRuntime.muse },
      accountObservations,
    }
    const inference = ProviderUsageRuntime.make(input)
    const reader = ProviderUsageRuntime.make(input)
    expect(await Effect.runPromise(reader.get({ providerID, refresh: true }))).toMatchObject({
      status: "unsupported",
      windows: [],
      message: "Quota is reported after the next Muse response",
    })
    const data = `data: ${JSON.stringify(event)}\n\n`
    expect(
      await observeMuseUsage(
        new Response(data, { headers: { "content-type": "text/event-stream" } }),
        inference,
        SessionRunnerModel.accountIdentityDigest(personal),
      ).text(),
    ).toBe(data)
    expect(await Effect.runPromise(reader.list({ refresh: true }))).toMatchObject([
      { profile: "Personal", status: "available", source: "response_stream", windows: [{ used: 0 }, { used: 0 }] },
      { profile: "Work", status: "unsupported", windows: [] },
    ])
    const otherBackend = ProviderUsageRuntime.make({ ...input, accountObservations: new Map() })
    expect(await Effect.runPromise(otherBackend.get({ providerID }))).toMatchObject({
      status: "unsupported",
      windows: [],
    })
    credentials = [new Credential.Info({ ...personal, accountGeneration: 1 }), work]
    expect(await Effect.runPromise(reader.get({ providerID, refresh: true }))).toMatchObject({
      status: "unsupported",
      windows: [],
    })
  })

  test("keeps environment observations local even when account observations are shared", async () => {
    const providerID = Provider.ID.make("muse")
    const input = {
      credentials: { all: () => Effect.succeed([]) },
      providers: { available: () => Effect.succeed([{ id: providerID }]) },
      adapters: { muse: ProviderUsageRuntime.muse },
      accountObservations: new Map<string, ProviderUsage.Snapshot>(),
    }
    const inference = ProviderUsageRuntime.make(input)
    const reader = ProviderUsageRuntime.make(input)
    await observeMuseUsage(
      new Response(`data: ${JSON.stringify(event)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
      inference,
    ).text()
    expect(await Effect.runPromise(inference.get({ providerID }))).toMatchObject({
      status: "available",
      windows: [{ used: 0 }, { used: 0 }],
    })
    expect(await Effect.runPromise(reader.get({ providerID }))).toMatchObject({ status: "unsupported", windows: [] })
  })

  test("normalizes live subscription windows with reported zeros and millisecond resets", () => {
    expect(MuseUsage.normalize(event, 100)).toMatchObject({
      providerID: "muse",
      label: "Muse (Meta)",
      status: "available",
      source: "response_stream",
      stability: "observed",
      updatedAt: 100,
      windows: [
        {
          id: "window",
          label: "5-hour window",
          unit: "percent",
          used: 0,
          resetAt: 1791876076000,
          periodSeconds: 18000,
        },
        { id: "weekly", label: "Weekly", unit: "percent", used: 0, resetAt: 1792368000000, periodSeconds: 604800 },
      ],
    })
  })

  test("omits absent metrics, preserves fractional percentages, and labels shorter windows", () => {
    const snapshot = MuseUsage.normalize(
      {
        type: event.type,
        subscription: { window: { window_duration_mins: 30, resets_at: 1791876076 }, weekly: { used_percent: 0.5 } },
      },
      100,
    )
    expect(snapshot?.windows[0]).toMatchObject({
      label: "30-minute window",
      resetAt: 1791876076000,
      periodSeconds: 1800,
    })
    expect(snapshot?.windows[0]?.used).toBeUndefined()
    expect(snapshot?.windows[1]).toMatchObject({ used: 0.5, periodSeconds: 604800 })
    expect(snapshot?.windows[1]?.resetAt).toBeUndefined()
    expect(MuseUsage.normalize({ type: event.type, subscription: {} }, 100)?.windows).toEqual([])
  })

  for (const payload of [
    undefined,
    {},
    { type: event.type, subscription: "invalid" },
    { type: event.type, subscription: { window: { used_percent: -1 } } },
    { type: event.type, subscription: { weekly: { used_percent: NaN } } },
    { type: event.type, subscription: { weekly: { used_percent: Infinity } } },
    { type: event.type, subscription: { window: { resets_at: "1791876076" } } },
    { type: event.type, subscription: { window: { window_duration_mins: 0 } } },
  ])
    test(`rejects malformed subscription metrics (${JSON.stringify(payload)})`, () => {
      expect(MuseUsage.normalize(payload, 100)).toBeUndefined()
    })

  test("refresh returns the observed quota instead of the unsupported placeholder for a stored credential", async () => {
    const providerID = Provider.ID.make("muse")
    const credential = new Credential.Info({
      id: Credential.ID.make("cred_muse_refresh"),
      integrationID: Integration.ID.make("muse"),
      label: "Muse",
      value: Credential.Key.make({ type: "key", key: "fixture" }),
    })
    let now = 100
    const service = ProviderUsageRuntime.make({
      credentials: { all: () => Effect.succeed([credential]) },
      providers: { available: () => Effect.succeed([{ id: providerID }]) },
      adapters: { muse: ProviderUsageRuntime.muse },
      now: () => now,
    })

    expect(await Effect.runPromise(service.get({ providerID, refresh: true }))).toMatchObject({
      status: "unsupported",
      windows: [],
    })

    const snapshot = MuseUsage.normalize(
      {
        type: event.type,
        subscription: {
          weekly: { resets_at: 1792368000, used_percent: 10 },
          window: { resets_at: 1791876076, used_percent: 42, window_duration_mins: 300 },
        },
      },
      200,
    )
    if (!snapshot) throw new Error("expected Muse observation snapshot")
    await Effect.runPromise(
      service.observe(
        new ProviderUsage.Observation({
          providerID: snapshot.providerID,
          label: snapshot.label,
          source: snapshot.source,
          stability: snapshot.stability,
          observedAt: snapshot.updatedAt,
          windows: snapshot.windows,
        }),
        SessionRunnerModel.accountIdentityDigest(credential),
      ),
    )

    now = 300
    const expected = {
      providerID: "muse",
      label: "Muse (Meta)",
      status: "available",
      source: "response_stream",
      stability: "observed",
      updatedAt: 200,
      windows: [
        { id: "window", label: "5-hour window", unit: "percent", used: 42 },
        { id: "weekly", label: "Weekly", unit: "percent", used: 10 },
      ],
    }
    expect(await Effect.runPromise(service.get({ providerID, refresh: true }))).toMatchObject(expected)
    expect(await Effect.runPromise(service.list({ refresh: true }))).toMatchObject([expected])
  })

  test("refresh returns an unbound observed quota when no credential is selected", async () => {
    const providerID = Provider.ID.make("muse")
    let now = 100
    const service = ProviderUsageRuntime.make({
      credentials: { all: () => Effect.succeed([]) },
      providers: { available: () => Effect.succeed([{ id: providerID }]) },
      adapters: { muse: ProviderUsageRuntime.muse },
      now: () => now,
    })

    expect(await Effect.runPromise(service.get({ providerID, refresh: true }))).toMatchObject({
      status: "unsupported",
      windows: [],
    })

    await Effect.runPromise(
      service.observe(
        new ProviderUsage.Observation({
          providerID,
          label: "Muse (Meta)",
          source: "response_stream",
          stability: "observed",
          observedAt: 200,
          windows: [new ProviderUsage.Window({ id: "window", label: "5-hour window", unit: "percent", used: 42 })],
        }),
      ),
    )

    now = 300
    const expected = {
      providerID: "muse",
      status: "available",
      source: "response_stream",
      updatedAt: 200,
      windows: [{ id: "window", used: 42 }],
    }
    expect(await Effect.runPromise(service.get({ providerID, refresh: true }))).toMatchObject(expected)
    expect(await Effect.runPromise(service.list({ refresh: true }))).toMatchObject([expected])
  })

  test("returns an explicit no-data snapshot without a network request", async () => {
    const providerID = Provider.ID.make("muse")
    const credential = new Credential.Info({
      id: Credential.ID.make("cred_muse_usage"),
      integrationID: Integration.ID.make("muse"),
      label: "Muse",
      value: Credential.Key.make({ type: "key", key: "fixture" }),
    })
    expect(
      await Effect.runPromise(
        ProviderUsageRuntime.muse({ providerID, label: "Muse (Meta)", credential, updatedAt: 100 }),
      ),
    ).toMatchObject({
      providerID,
      label: "Muse (Meta)",
      status: "unsupported",
      source: "response_stream",
      stability: "observed",
      updatedAt: 100,
      windows: [],
      message: "Quota is reported after the next Muse response",
    })
  })
})
