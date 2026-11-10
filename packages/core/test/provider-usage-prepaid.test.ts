import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ProviderUsageRuntime } from "@ycoding-ai/core/provider-usage"
import { Provider } from "@ycoding-ai/core/provider"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { accountIdentityDigest } from "@ycoding-ai/core/provider-usage/service"

test("OpenAI key reports the provider's USD credit balance without an admin key", async () => {
  const requests: Array<{ url: string; authorization: string | undefined }> = []
  const http = HttpClient.make((request) => Effect.sync(() => {
    requests.push({ url: request.url, authorization: request.headers.authorization })
    return HttpClientResponse.fromWeb(request, Response.json({ total_granted: 100, total_used: 25, total_available: 75 }))
  }))
  const providerID = Provider.ID.make("openai")
  const snapshot = await Effect.runPromise(ProviderUsageRuntime.openAI(http, {
    providerID, label: "OpenAI", updatedAt: 100,
    credential: new Credential.Info({ id: Credential.ID.make("cred_key"), integrationID: Integration.ID.make("openai"),
      label: "Test", value: Credential.Key.make({ type: "key", key: "synthetic-key" }) }),
  }, { snapshot: () => Effect.die("not an OAuth account") }))
  expect(requests).toEqual([{ url: "https://api.openai.com/v1/dashboard/billing/credit_grants", authorization: "Bearer synthetic-key" }])
  expect(snapshot).toMatchObject({ status: "available", source: "provider_internal_api", stability: "best_effort",
    windows: [{ id: "api-credit-balance", unit: "usd", remaining: 75 }] })
  expect(JSON.stringify(snapshot)).not.toContain("synthetic-key")
})

test("Claude OAuth obtains organization for the same token and preserves subscription quota with prepaid balance", async () => {
  const requests: Array<{ url: string; authorization: string | undefined; organization: string | undefined }> = []
  const http = HttpClient.make((request) => Effect.sync(() => {
    requests.push({ url: request.url, authorization: request.headers.authorization, organization: request.headers["x-organization-uuid"] })
    const body = request.url.endsWith("/api/oauth/usage") ? { five_hour: { utilization: 23 } }
      : request.url.endsWith("/api/oauth/profile") ? { organization: { uuid: "00000000-0000-4000-8000-000000000001" } }
      : { amount: 1250, currency: "USD" }
    return HttpClientResponse.fromWeb(request, Response.json(body))
  }))
  const account = { accessToken: "synthetic-token", refreshToken: "synthetic-refresh", expiresAt: 1000000 }
  const store = { resolve: async () => account, refresh: async () => account, reload: async () => account, accounts: async () => [] }
  const providerID = Provider.ID.make("anthropic")
  const snapshot = await Effect.runPromise(ProviderUsageRuntime.claudeOAuth(http, store, {
    providerID, label: "Claude", updatedAt: 100,
    credential: new Credential.Info({ id: Credential.ID.make("cred_claude"), integrationID: Integration.ID.make("anthropic"),
      label: "Test", value: Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("claude-code"),
        access: "synthetic-source", refresh: "", expires: 1000000,
        metadata: { authKind: "claude-code", managed: true, source: "synthetic-source" } }) }),
  }))
  expect(requests.map((request) => request.url)).toEqual([
    "https://api.anthropic.com/api/oauth/usage", "https://api.anthropic.com/api/oauth/profile",
    "https://api.anthropic.com/api/oauth/organizations/00000000-0000-4000-8000-000000000001/prepaid/credits",
  ])
  expect(requests.every((request) => request.authorization === "Bearer synthetic-token")).toBe(true)
  expect(requests[2]?.organization).toBe("00000000-0000-4000-8000-000000000001")
  expect(snapshot.windows).toMatchObject([{ id: "five-hour", used: 23 }, { id: "prepaid-balance", unit: "usd", remaining: 12.5 }])
  expect(JSON.stringify(snapshot)).not.toContain("synthetic-token")
})

test("OpenAI missing and denied balances are not reported as zero", async () => {
  const providerID = Provider.ID.make("openai")
  const credential = new Credential.Info({ id: Credential.ID.make("cred_key"), integrationID: Integration.ID.make("openai"),
    label: "Test", value: Credential.Key.make({ type: "key", key: "synthetic-key" }) })
  for (const [status, body, expected] of [[200, {}, "error"], [403, {}, "unauthorized"], [200, { total_available: 0 }, "available"]] as const) {
    const http = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))))
    const service = ProviderUsageRuntime.make({ credentials: { all: () => Effect.succeed([credential]) },
      providers: { available: () => Effect.succeed([{ id: providerID }]) },
      adapters: { openai: (input) => ProviderUsageRuntime.openAI(http, input, { snapshot: () => Effect.die("unused") }) } })
    const snapshot = await Effect.runPromise(service.get({ providerID, refresh: true }))
    expect(snapshot.status).toBe(expected)
    if (expected === "available") expect(snapshot.windows).toMatchObject([{ id: "api-credit-balance", remaining: 0 }])
    else expect(snapshot.windows).toEqual([])
  }
})

test("Claude retains quota when profile or prepaid reporting is unavailable or currency is not USD", async () => {
  for (const failure of ["profile", "balance", "currency"]) {
    const urls: string[] = []
    const http = HttpClient.make((request) => Effect.sync(() => {
      urls.push(request.url)
      if (request.url.endsWith("/usage")) return HttpClientResponse.fromWeb(request, Response.json({ five_hour: { utilization: 23 } }))
      if (request.url.endsWith("/profile")) return HttpClientResponse.fromWeb(request, failure === "profile"
        ? Response.json({}, { status: 403 }) : Response.json({ organization: { uuid: "00000000-0000-4000-8000-000000000001" } }))
      return HttpClientResponse.fromWeb(request, failure === "balance" ? Response.json({}, { status: 403 })
        : Response.json({ amount: 100, currency: "EUR" }))
    }))
    const account = { accessToken: "synthetic-token", refreshToken: "synthetic-refresh", expiresAt: 1000000 }
    const store = { resolve: async () => account, refresh: async () => account, reload: async () => account, accounts: async () => [] }
    const snapshot = await Effect.runPromise(ProviderUsageRuntime.claudeOAuth(http, store, {
      providerID: Provider.ID.make("anthropic"), label: "Claude", updatedAt: 100,
      credential: new Credential.Info({ id: Credential.ID.make("cred_claude"), integrationID: Integration.ID.make("anthropic"),
        label: "Test", value: Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("claude-code"),
          access: "synthetic-source", refresh: "", expires: 1000000,
          metadata: { authKind: "claude-code", managed: true, source: "synthetic-source" } }) }),
    }))
    expect(snapshot).toMatchObject({ status: "available", message: "Prepaid balance unavailable", windows: [{ id: "five-hour", used: 23 }] })
    expect(urls.length).toBe(failure === "profile" ? 2 : 3)
  }
})

test("OpenAI admin usage failure does not hide a separately available API credit balance", async () => {
  const http = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request,
    request.url.includes("credit_grants") ? Response.json({ total_available: 5 }) : Response.json({}, { status: 403 }))))
  const snapshot = await Effect.runPromise(ProviderUsageRuntime.openAI(http, {
    providerID: Provider.ID.make("openai"), label: "OpenAI", updatedAt: 100,
    credential: new Credential.Info({ id: Credential.ID.make("cred_admin"), integrationID: Integration.ID.make("openai"),
      label: "Admin", value: Credential.Key.make({ type: "key", key: "synthetic-key", metadata: { usageAdmin: true } }) }),
  }, { snapshot: () => Effect.die("unused") }))
  expect(snapshot).toMatchObject({ status: "available", message: "Organization usage unavailable",
    windows: [{ id: "api-credit-balance", remaining: 5 }] })
})

test("Claude never requests a balance after the profile token changes", async () => {
  const urls: string[] = []
  const http = HttpClient.make((request) => Effect.sync(() => {
    urls.push(request.url)
    return HttpClientResponse.fromWeb(request, Response.json(request.url.endsWith("/usage")
      ? { five_hour: { utilization: 10 } } : { organization: { uuid: "00000000-0000-4000-8000-000000000001" } }))
  }))
  const first = { accessToken: "synthetic-first", refreshToken: "synthetic-refresh", expiresAt: 1000000 }
  const next = { ...first, accessToken: "synthetic-next" }
  const store = { resolve: async () => first, refresh: async () => first,
    reload: async () => next, accounts: async () => [] }
  const snapshot = await Effect.runPromise(ProviderUsageRuntime.claudeOAuth(http, store, {
    providerID: Provider.ID.make("anthropic"), label: "Claude", updatedAt: 100,
    credential: new Credential.Info({ id: Credential.ID.make("cred_claude"), integrationID: Integration.ID.make("anthropic"),
      label: "Test", value: Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("claude-code"),
        access: "synthetic-source", refresh: "", expires: 1000000,
        metadata: { authKind: "claude-code", managed: true, source: "synthetic-source" } }) }),
  }))
  expect(urls).toEqual(["https://api.anthropic.com/api/oauth/usage", "https://api.anthropic.com/api/oauth/profile"])
  expect(snapshot).toMatchObject({ windows: [{ id: "five-hour", used: 10 }], message: "Prepaid balance unavailable" })
})

test("a fresh Claude header observation keeps the same account's cached prepaid balance", async () => {
  const providerID = Provider.ID.make("anthropic")
  const credential = new Credential.Info({ id: Credential.ID.make("cred_claude"), integrationID: Integration.ID.make("anthropic"),
    label: "Test", value: Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("claude-code"),
      access: "synthetic-source", refresh: "", expires: 1000000,
      metadata: { authKind: "claude-code", managed: true, source: "synthetic-source" } }) })
  let instant = 100
  const service = ProviderUsageRuntime.make({ credentials: { all: () => Effect.succeed([credential]) },
    providers: { available: () => Effect.succeed([{ id: providerID }]) }, now: () => instant,
    adapters: { anthropic: () => Effect.succeed(new ProviderUsage.Snapshot({ providerID, label: "Claude", status: "available",
      source: "provider_internal_api", stability: "best_effort", updatedAt: 100,
      windows: [new ProviderUsage.Window({ id: "prepaid-balance", label: "Prepaid balance", unit: "usd", remaining: 4 })] })) } })
  await Effect.runPromise(service.get({ providerID, refresh: true }))
  await Effect.runPromise(service.observe(new ProviderUsage.Observation({ providerID, label: "Claude",
    source: "response_headers", stability: "observed", observedAt: 200,
    windows: [new ProviderUsage.Window({ id: "five-hour", label: "Session", unit: "percent", used: 20 })] }), accountIdentityDigest(credential)))
  const snapshot = await Effect.runPromise(service.get({ providerID }))
  expect(snapshot.source).toBe("provider_internal_api")
  expect(snapshot.windows).toMatchObject([{ id: "five-hour", used: 20 }, { id: "prepaid-balance", remaining: 4 }])
})

test.each(["cold", "expired"])("Claude header observations do not prevent %s balance reads", async (state) => {
  const providerID = Provider.ID.make("anthropic")
  const credential = new Credential.Info({ id: Credential.ID.make("cred_claude"), integrationID: Integration.ID.make("anthropic"),
    label: "Test", value: Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("claude-code"),
      access: "synthetic-source", refresh: "", expires: 1000000,
      metadata: { authKind: "claude-code", managed: true, source: "synthetic-source" } }) })
  let instant = 100
  let reads = 0
  const service = ProviderUsageRuntime.make({ credentials: { all: () => Effect.succeed([credential]) },
    providers: { available: () => Effect.succeed([{ id: providerID }]) }, now: () => instant,
    adapters: { anthropic: () => Effect.sync(() => new ProviderUsage.Snapshot({ providerID, label: "Claude", status: "available",
      source: "provider_internal_api", stability: "best_effort", updatedAt: instant,
      windows: [new ProviderUsage.Window({ id: "prepaid-balance", label: "Prepaid balance", unit: "usd", remaining: ++reads })] })) } })
  if (state === "expired") await Effect.runPromise(service.get({ providerID, refresh: true }))
  await Effect.runPromise(service.observe(new ProviderUsage.Observation({ providerID, label: "Claude",
    source: "response_headers", stability: "observed", observedAt: 100,
    windows: [new ProviderUsage.Window({ id: "five-hour", label: "Session", unit: "percent", used: 20 })] }), accountIdentityDigest(credential)))
  if (state === "expired") instant = 60_100
  const first = await Effect.runPromise(service.get({ providerID }))
  const expected = state === "expired" ? 2 : 1
  expect(first.status).toBe("available")
  expect(first.windows.find((window) => window.id === "prepaid-balance")?.remaining).toBe(expected)
  expect(reads).toBe(expected)
  await Effect.runPromise(service.get({ providerID }))
  expect(reads).toBe(expected)
})

test("failed cold Claude balance read retains observed quota and reports the failure", async () => {
  const providerID = Provider.ID.make("anthropic")
  const credential = new Credential.Info({ id: Credential.ID.make("cred_claude"), integrationID: Integration.ID.make("anthropic"),
    label: "Test", value: Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("claude-code"),
      access: "synthetic-source", refresh: "", expires: 1000000,
      metadata: { authKind: "claude-code", managed: true, source: "synthetic-source" } }) })
  const service = ProviderUsageRuntime.make({ credentials: { all: () => Effect.succeed([credential]) },
    providers: { available: () => Effect.succeed([{ id: providerID }]) }, now: () => 200,
    adapters: { anthropic: () => Effect.fail(new Error("synthetic failure")) } })
  await Effect.runPromise(service.observe(new ProviderUsage.Observation({ providerID, label: "Claude",
    source: "response_headers", stability: "observed", observedAt: 100,
    windows: [new ProviderUsage.Window({ id: "five-hour", label: "Session", unit: "percent", used: 20 })] }), accountIdentityDigest(credential)))
  const snapshot = await Effect.runPromise(service.get({ providerID }))
  expect(snapshot).toMatchObject({ status: "available", source: "response_headers", message: "Provider usage refresh failed",
    windows: [{ id: "five-hour", used: 20 }] })
})
