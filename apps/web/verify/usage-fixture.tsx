import { render } from "solid-js/web"
import { RemoteProvider } from "../src/remote/context"
import type { RemoteHttp } from "../src/remote/http"
import { remoteKeys } from "../src/remote/queries"
import { createRemoteStore } from "../src/remote/store"
import type { RemoteRequestOutcome, RemoteTransportHandlers, RemoteTransportRequest } from "../src/remote/transport"
import { UsagePage } from "../src/remote/ui/usage"
import { type UsageProvider, type UsageReportInput, type UsageReportRow } from "../src/remote/ui/usage-model"
import "../src/styles/tokens.css"
import "../src/styles/base.css"

const today = Math.floor(Date.now() / 86_400_000) * 86_400_000
const old = new URLSearchParams(location.search).has("old")
let oldZone = new URLSearchParams(location.search).has("old-zone")
const offline = new URLSearchParams(location.search).has("offline")
const none = new URLSearchParams(location.search).has("none")
const paged = new URLSearchParams(location.search).has("paged")
const pageError = new URLSearchParams(location.search).has("page-error")
const refreshCycle = new URLSearchParams(location.search).has("refresh-cycle")
const initialLoading = new URLSearchParams(location.search).has("initial-loading")
const oldGroups = new URLSearchParams(location.search).has("old-groups")
const forecastMode = new URLSearchParams(location.search).get("forecast")
const largeValues = new URLSearchParams(location.search).has("large-values")
const unknownUsage = new URLSearchParams(location.search).has("unknown-usage")
const longDistribution = new URLSearchParams(location.search).has("distribution-long-values")
const creditsMode = new URLSearchParams(location.search).get("credits")
const credits = creditsMode !== null
const museMode = new URLSearchParams(location.search).get("provider") === "muse"
const states = forecastMode === "states"
const providers: UsageProvider[] = [
  {
    providerID: "openai",
    label: longDistribution ? "Provider with a long descriptive name and a shared workspace plan" : "Codex",
    profile: "Personal",
    status: "available",
    source: "provider_api",
    stability: "stable",
    updatedAt: Date.now(),
    windows: [
      {
        id: "session",
        label: "Session allowance",
        unit: "percent",
        used: 38,
        resetAt: Date.now() + 2 * 3600_000,
        periodSeconds: 5 * 3600,
      },
      {
        id: "week",
        label: "Weekly allowance",
        unit: "percent",
        used: states ? 100 : 72,
        resetAt: Date.now() + 3 * 86_400_000,
        periodSeconds: 7 * 86_400,
      },
    ],
  },
  {
    providerID: "anthropic",
    label: "Claude",
    profile: "Max · Personal",
    status: "available",
    source: "provider_api",
    stability: "best_effort",
    updatedAt: Date.now(),
    windows: [
      {
        id: "session",
        label: "Current session",
        unit: "percent",
        used: 23,
        resetAt: Date.now() + 3 * 3600_000,
        periodSeconds: 5 * 3600,
      },
      {
        id: "weekly",
        label: "Weekly allowance",
        unit: "percent",
        used: 64,
        resetAt: Date.now() + 4 * 86_400_000,
        periodSeconds: 7 * 86_400,
      },
      { id: "extra", label: "Extra usage", unit: "usd", used: 14.8, limit: 50, remaining: 35.2 },
    ],
  },
  {
    providerID: "cursor",
    label: "Cursor",
    status: "stale",
    source: "local_client_rpc",
    stability: "client_contract",
    updatedAt: Date.now() - 3600_000,
    windows: [
      {
        id: "credits",
        label: "AI credits",
        unit: "percent",
        used: 38,
        resetAt: Date.now() + 13 * 86_400_000,
        periodSeconds: 30 * 86_400,
      },
      { id: "extra-usage", label: "Extra usage", unit: "count", used: 12 },
      { id: "org-credits", label: "Org credits", unit: "count", used: 384, limit: 1000, remaining: 616 },
      { id: "org-spend", label: "Org spend", unit: "usd", used: 4.4 },
      { id: "chat", label: "Chat", unit: "percent", used: 19 },
      { id: "completions", label: "Completions", unit: "percent", used: 42 },
    ],
  },
  {
    providerID: "openrouter",
    label: "OpenRouter · Pay as you go",
    status: "available",
    source: "provider_api",
    stability: "stable",
    updatedAt: Date.now(),
    windows: [
      { id: "balance", label: "Balance", unit: "usd", remaining: 38.42 },
      { id: "credits", label: "Credits", unit: "usd", used: 30, limit: 100, remaining: 70 },
      { id: "daily", label: "Today", unit: "usd", used: 0 },
      { id: "weekly", label: "This Week", unit: "usd", used: 8.21 },
      { id: "monthly", label: "This Month", unit: "usd", used: 27.65 },
      { id: "key", label: "Key Limit", unit: "usd", used: 12, limit: 50, remaining: 38 },
    ],
  },
  {
    providerID: "other",
    label: "Other provider",
    status: "unsupported",
    source: "local_session",
    stability: "best_effort",
    updatedAt: Date.now(),
    windows: [],
  },
  {
    providerID: "disconnected",
    label: "Disconnected provider",
    status: "unauthorized",
    source: "provider_api",
    stability: "stable",
    updatedAt: Date.now(),
    windows: [{ id: "old", label: "Old allowance", unit: "percent", used: 10 }],
  },
  {
    providerID: "empty",
    label: "Empty provider",
    status: "available",
    source: "provider_api",
    stability: "stable",
    updatedAt: Date.now(),
    windows: [],
  },
  {
    providerID: "failed",
    label: "Provider with an error",
    status: "error",
    source: "provider_api",
    stability: "best_effort",
    updatedAt: Date.now(),
    windows: [],
    message: "Quota refresh failed.",
  },
]
const museProvider: UsageProvider = {
  providerID: "muse",
  label: "Muse (Meta)",
  profile: "Muse",
  status: "available",
  source: "response_stream",
  stability: "observed",
  updatedAt: Date.now(),
  windows: [
    {
      id: "window",
      label: "5-hour window",
      unit: "percent",
      used: 35,
      resetAt: Date.now() + 2 * 3600_000,
      periodSeconds: 18_000,
    },
    {
      id: "weekly",
      label: "Weekly",
      unit: "percent",
      used: 64,
      resetAt: Date.now() + 4 * 86_400_000,
      periodSeconds: 604_800,
    },
  ],
}
const tokens = longDistribution
  ? { input: 1_000_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  : { input: 12_400, output: 3_200, reasoning: 1_440, cache: { read: 5_600, write: 320 } }
const rows: UsageReportRow[] = Array.from({ length: 30 }, (_, index) => ({
  key: new Date(today - (29 - index) * 86_400_000).toISOString().slice(0, 10),
  label: new Date(today - (29 - index) * 86_400_000).toISOString().slice(0, 10),
  logical: index + 1,
  physical: index + 2,
  helpers: 0,
  continued: 0,
  fallback: 0,
  cost: credits
    ? creditsMode === "tiny"
      ? index === 5
        ? 1000
        : index === 10
          ? -0.004
          : 0
      : creditsMode === "negative"
        ? index % 2 === 0
          ? 0
          : -(index + 1) * 0.1
        : index === 3
          ? -0.004
          : index % 2 === 0
            ? (index + 1) * 0.5
            : -(index + 1) * 0.25
    : index % 6 === 0
      ? undefined
      : (index + 1) * 0.18,
  costProvenance: credits ? "recorded" : index % 6 === 0 ? undefined : index % 3 === 0 ? "current_catalog" : "recorded",
  costCoverage: credits
    ? { pricedRequests: 1, unpricedRequests: 0 }
    : {
        pricedRequests: index % 6 === 0 ? 0 : index + 1,
        unpricedRequests: index % 6 === 0 ? index + 1 : 0,
      },
  tokens,
}))
const monthlyRows: UsageReportRow[] = [
  {
    ...rows[1]!,
    key: "openai/gpt-6-sol",
    label: "openai/gpt-6-sol",
    cost: longDistribution ? 12_000_000 : 6,
    costProvenance: "recorded",
  },
  {
    ...rows[2]!,
    key: "openai/gpt-5",
    label: "openai/gpt-5",
    cost: longDistribution ? 3_000_000 : 4,
    costProvenance: "current_catalog",
  },
  {
    ...rows[3]!,
    key: "openrouter/deepseek-v4",
    label: "openrouter/deepseek-v4",
    cost: longDistribution ? 5_000_000 : credits ? -2 : 5,
    costProvenance: "recorded",
  },
  {
    ...rows[0]!,
    key: "cursor/gpt-4o",
    label: "cursor/gpt-4o",
    cost: undefined,
    costProvenance: undefined,
  },
]
const sample = ["GPT-6 Sol", "Claude Opus", "Gemini Pro", "DeepSeek V3", "Llama 4", "Qwen 3"]
const entries = (input: UsageReportInput): UsageReportRow[] =>
  input.group === "day"
    ? input.timeZone === undefined
      ? rows
      : rows.map((row, index) => {
          const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: input.timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).formatToParts(Date.now())
          const value = (type: string) => Number(parts.find((part) => part.type === type)?.value)
          const key = new Date(Date.UTC(value("year"), value("month") - 1, value("day")) - (29 - index) * 86_400_000)
            .toISOString()
            .slice(0, 10)
          return { ...row, key, label: key }
        })
    : Array.from({ length: 41 }, (_, index) => ({
        ...rows[index % 30]!,
        key:
          input.group === "model"
            ? `${["openai", "anthropic", "openrouter", "cursor"][index % 4]}/${encodeURIComponent(sample[index % sample.length]!.toLowerCase().replaceAll(" ", "-"))}-${index + 1}`
            : `${input.group}-${index}`,
        label:
          input.group === "model"
            ? `${sample[index % sample.length]} ${index + 1}`
            : `${input.group === "session" ? "Session" : input.group === "project" ? "Project" : "Agent"} ${index + 1}`,
        logical: 41 - index,
        physical: 41 - index,
        cost: (41 - index) * 0.45,
        costProvenance: index % 3 === 0 ? "current_catalog" : "recorded",
        costCoverage: { pricedRequests: 41 - index, unpricedRequests: 0 },
      }))
const insufficient = (reason: string) => ({ state: "insufficient" as const, evidence: "insufficient" as const, reason })
const stateFor = (providerID: string, windowID: string, asOf: number) => {
  if (providerID === "openai" && windowID === "session")
    return {
      state: "estimated" as const,
      evidence: "low" as const,
      method: "quota-delta-ema" as const,
      ratePerHour: 10.25,
      exhaustionAt: asOf + 7_200_000,
      projectedUsedAtReset: 83.5,
      observedFrom: asOf - 3_600_000,
      observedTo: asOf,
    }
  if (providerID === "openai" && windowID === "week")
    return { state: "exhausted" as const, evidence: "medium" as const }
  if (providerID === "anthropic" && windowID === "session") return insufficient("Quota observations are stale")
  if (providerID === "anthropic" && windowID === "weekly") return insufficient("Quota window has expired")
  if (providerID === "anthropic") return insufficient("No increase observed")
  return insufficient("Warming up after restart")
}
const localRates = [
  {
    providerID: "openai",
    profile: "Personal",
    modelID: "gpt-6-sol",
    observedFrom: 1_700_000_000_000,
    observedTo: 1_700_003_600_000,
    tokensPerMinute: 12_345.678,
    tokensPerMinute5: 15_000.25,
    tokensPerMinute60: 9_876.5,
    estimatedUSDPerHour: 1.23456,
    coverage: { pricedRequests: 40, unpricedRequests: 0 },
  },
  {
    providerID: "provider-with-an-extremely-long-identifier-that-must-wrap-inside-its-row",
    modelID: "model-with-an-extremely-long-identifier-v2-20260101-preview-extra-long-suffix",
    observedFrom: 1_700_000_000_000,
    observedTo: 1_700_003_600_000,
    tokensPerMinute: 0.4,
    coverage: { pricedRequests: 0, unpricedRequests: 7 },
  },
  {
    providerID: "anthropic",
    profile: "Max · Personal",
    modelID: "claude-opus",
    observedFrom: 1_700_000_000_000,
    observedTo: 1_700_003_600_000,
    tokensPerMinute: 0,
    tokensPerMinute5: 0,
    estimatedUSDPerHour: 0.0042,
    coverage: { pricedRequests: 3, unpricedRequests: 2 },
  },
]
const museRate = [
  {
    providerID: "muse",
    profile: "Muse",
    modelID: "muse-model",
    observedFrom: 1_700_000_000_000,
    observedTo: 1_700_003_600_000,
    tokensPerMinute: 120,
    tokensPerMinute5: 180,
    tokensPerMinute60: 120,
    coverage: { pricedRequests: 0, unpricedRequests: 3 },
  },
]
const requests: { operation: string; input?: UsageReportInput | { refresh: boolean } }[] = []
let releasePage: (() => void) | undefined
let releaseReload: (() => void) | undefined
let pendingReload: Promise<void> | undefined
let releaseInitial: (() => void) | undefined
const pendingInitial = initialLoading
  ? new Promise<void>((resolve) => {
      releaseInitial = resolve
    })
  : undefined
let revision = 0
let retryFailure = false
let outage = false
let handlers: RemoteTransportHandlers | undefined
const beginReload = () => {
  revision += 1
  pendingReload = new Promise<void>((resolve) => {
    releaseReload = resolve
  })
}
const refreshedProviders = () =>
  providers.map((provider) => ({
    ...provider,
    updatedAt: Date.now(),
    windows: provider.windows.map((window) => ({
      ...window,
      ...(window.used === undefined ? {} : { used: window.used + revision }),
    })),
  }))
const failure = (
  code: "unknown_operation" | "invalid_message" | "internal_error",
  message: string,
): RemoteRequestOutcome => ({ status: "failed", error: { code, message } })
const ok = (data: unknown): RemoteRequestOutcome => ({ status: "ok", value: { data } })
const unknown: RemoteRequestOutcome = {
  status: "unknown",
  error: { code: "outcome_unknown", message: "Agent disconnected before settling this request" },
}

const report = (input: UsageReportInput) => {
  if (input.group === "model" && input.limit === 200)
    return {
      group: "model",
      rows: refreshCycle
        ? monthlyRows.map((row) => ({ ...row, cost: row.cost === undefined ? undefined : row.cost + revision }))
        : monthlyRows,
      total: {
        logical: 10,
        physical: 14,
        helpers: 0,
        continued: 0,
        fallback: 0,
        costCoverage: { pricedRequests: 9, unpricedRequests: 1 },
        cost: (longDistribution ? 20_000_000 : credits ? 8 : 15) + (refreshCycle ? 3 * revision : 0),
        costProvenance: "current_catalog",
        tokens: {
          input: tokens.input * 4,
          output: tokens.output * 4,
          reasoning: tokens.reasoning * 4,
          cache: { read: tokens.cache.read * 4, write: tokens.cache.write * 4 },
        },
      },
      rowCount: monthlyRows.length,
    }
  const all = entries(input).map((row, index) => ({
    ...row,
    ...(refreshCycle && revision > 0 && input.group === "day"
      ? {
          cost: (row.cost ?? 0) + revision,
          costProvenance: "current_catalog" as const,
          costCoverage: { pricedRequests: row.logical, unpricedRequests: 0 },
        }
      : {}),
    ...(largeValues && input.group === "day" && index === 29
      ? { physical: 7_720, tokens: { input: 2_267_963_225, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
      : {}),
  }))
  const sorted =
    input.group === "day"
      ? all
      : [...all].sort((a, b) => {
          const value = (row: UsageReportRow) =>
            input.sort === "key"
              ? row.label
              : input.sort === "steps"
                ? row.physical
                : input.sort === "tokens" || input.sort === "input"
                  ? row.tokens.input
                  : input.sort === "output"
                    ? row.tokens.output
                    : input.sort === "reasoning"
                      ? row.tokens.reasoning
                      : input.sort === "cacheRead"
                        ? row.tokens.cache.read
                        : (row.cost ?? 0)
          const first = value(a)
          const second = value(b)
          return (first < second ? -1 : first > second ? 1 : 0) * (input.order === "asc" ? 1 : -1)
        })
  const offset = input.offset ?? 0
  return {
    group: input.group,
    rows: sorted.slice(offset, offset + (input.limit ?? 25)),
    total: {
      logical: all.reduce((sum, row) => sum + row.logical, 0),
      physical: all.reduce((sum, row) => sum + row.physical, 0),
      helpers: 0,
      continued: 0,
      fallback: 0,
      cost: all.some((row) => row.cost !== undefined) ? all.reduce((sum, row) => sum + (row.cost ?? 0), 0) : undefined,
      costProvenance: "current_catalog" as const,
      costCoverage: {
        pricedRequests: all.reduce((sum, row) => sum + (row.costCoverage?.pricedRequests ?? 0), 0),
        unpricedRequests: all.reduce((sum, row) => sum + (row.costCoverage?.unpricedRequests ?? 0), 0),
      },
      tokens: {
        input: all.reduce((sum, row) => sum + row.tokens.input, 0),
        output: all.reduce((sum, row) => sum + row.tokens.output, 0),
        reasoning: all.reduce((sum, row) => sum + row.tokens.reasoning, 0),
        cache: {
          read: all.reduce((sum, row) => sum + row.tokens.cache.read, 0),
          write: all.reduce((sum, row) => sum + row.tokens.cache.write, 0),
        },
      },
    },
    rowCount: all.length,
    ...(offset + (input.limit ?? 25) < all.length ? { nextOffset: offset + (input.limit ?? 25) } : {}),
  }
}

let quotaSnapshots: readonly UsageProvider[] = providers
const answer = async (operation: string, request?: RemoteTransportRequest): Promise<RemoteRequestOutcome> => {
  if (!operation.startsWith("usage.") && operation !== "providerUsage.list" && operation !== "providerUsage.forecast")
    return ok([])
  const input = request?.input as UsageReportInput | undefined
  if (operation === "providerUsage.list" && refreshCycle && input && "refresh" in input && !pendingReload) beginReload()
  requests.push({ operation, ...(operation === "usage.get" || input === undefined ? {} : { input }) })
  if (releaseInitial && pendingInitial) await pendingInitial
  if (outage) return unknown
  if (old) return failure("unknown_operation", "Unknown operation")
  if (unknownUsage && retryFailure)
    return failure(
      "internal_error",
      operation === "providerUsage.list"
        ? "Quota retry failed."
        : operation === "usage.get"
          ? "Summary retry failed."
          : "Report retry failed.",
    )
  if (operation === "usage.report" && oldZone && input?.timeZone !== undefined)
    return failure("invalid_message", "Unknown usage report field")
  if (
    operation === "usage.report" &&
    oldGroups &&
    input &&
    !["model", "hour", "day", "month", "session", "project", "agent"].includes(input.group)
  )
    return failure("invalid_message", "Unknown usage report group")
  if (refreshCycle && pendingReload) await pendingReload
  if (operation === "providerUsage.list") {
    quotaSnapshots = museMode ? [museProvider, ...providers] : none ? providers.slice(-4, -1) : refreshCycle ? refreshedProviders() : providers
    return {
      status: "ok",
      value: {
        location: { directory: "/work", project: { id: "prj_fixture", directory: "/work" } },
        data: quotaSnapshots,
      },
    }
  }
  if (operation === "providerUsage.forecast") {
    const asOf = Date.now()
    const quotas = quotaSnapshots.flatMap((provider) =>
      provider.windows.map((window) => ({
        providerID: provider.providerID,
        ...(provider.profile === undefined ? {} : { profile: provider.profile }),
        windowID: window.id,
        unit: window.unit,
        source: provider.source,
        stability: provider.stability,
        updatedAt: provider.updatedAt,
        ...(museMode && provider.providerID === "muse"
          ? {
              state: "insufficient" as const,
              evidence: "insufficient" as const,
              reason: "Muse quota observations are warming up",
            }
          : forecastMode === "past"
            ? {
                state: "estimated" as const,
                evidence: "medium" as const,
                method: "quota-delta-ema" as const,
                ratePerHour: 10,
                exhaustionAt: asOf - 60_000,
              }
            : states
              ? stateFor(provider.providerID, window.id, asOf)
              : {
                  state: "insufficient" as const,
                  evidence: "insufficient" as const,
                  reason: "Warming up after restart",
                }),
      })),
    )
    return {
      status: "ok",
      value: {
        location: { directory: "/work", project: { id: "prj_fixture", directory: "/work" } },
        data: {
          asOf,
          localScope: "backend",
          ...(forecastMode === "rates-absent" ? {} : { localRates: museMode ? [...museRate, ...localRates] : states ? localRates : [] }),
          ...(forecastMode === "quotas-absent" ? {} : { quotas }),
        },
      },
    }
  }
  if (operation === "usage.get")
    return ok({ logical: 980, physical: 1084, helpers: 0, continued: 0, fallback: 0, tokens, cost: 104.32 })
  if (input === undefined) return failure("internal_error", "Missing report input")
  if (
    paged &&
    input.group !== "day" &&
    input.limit !== 200 &&
    ((input.offset ?? 0) > 0 || input.group !== "model" || input.order === "asc")
  ) {
    await new Promise<void>((resolve) => {
      releasePage = resolve
    })
    releasePage = undefined
    if (pageError) return failure("internal_error", "The usage page could not be loaded.")
  }
  return ok(report(input))
}

const devices = [{ id: "dev_fixture", name: "Studio Mac", createdAt: 1, status: "active" as const, online: true }]
const http: RemoteHttp = {
  me: async () => ({
    ok: true,
    value: { user: { id: "user_fixture" }, session: { expiresAt: Date.now() + 60_000 }, devices },
  }),
  devices: async () => ({ ok: true, value: devices }),
  createEnrollment: async () => ({ ok: false, status: 503, message: "Not available in this fixture", kind: "http" }),
  revokeDevice: async () => ({ ok: true, value: undefined }),
  removeRevokedDevices: async () => ({ ok: true, value: undefined }),
  logout: async () => ({ ok: true, value: undefined }),
}
const store = createRemoteStore({
  http,
  deviceName: () => "Studio Mac",
  createTransport: (deviceID, callbacks) => {
    handlers = callbacks
    return {
      connect: () => {
        if (!offline && deviceID === "dev_fixture") callbacks.onStatus?.({ kind: "open" })
      },
      close: () => {},
      setPriority: () => {},
      status: () => ({ kind: "open" }),
      request: answer,
    }
  },
})
const reopen = (status: "reconnecting" | "connecting") => {
  handlers?.onStatus?.(
    status === "reconnecting" ? { kind: "reconnecting", attempt: 1, delayMs: 0 } : { kind: "connecting", attempt: 1 },
  )
  queueMicrotask(() => handlers?.onStatus?.({ kind: "open" }))
}
const refetchAll = () => {
  const scope = { deviceID: store.state().activeDeviceID ?? "", generation: store.state().generation }
  void store.queryClient.refetchQueries({ queryKey: remoteKeys.usage(scope), type: "all" })
}
Object.assign(window, {
  usageRequests: () => requests,
  usageReleaseInitial: () => {
    releaseInitial?.()
    releaseInitial = undefined
  },
  usageReleasePage: () => releasePage?.(),
  usageReleaseReload: () => {
    const release = releaseReload
    pendingReload = undefined
    releaseReload = undefined
    release?.()
  },
  usageOutage: () => {
    outage = true
    refetchAll()
  },
  usageAgentBack: (fail: boolean) => {
    retryFailure = fail
    outage = false
    handlers?.onSessionStatus?.({ running: [], attention: [] })
  },
  usageReconnect: () => {
    beginReload()
    reopen("reconnecting")
  },
  usageDowngrade: () => {
    oldZone = true
    reopen("reconnecting")
  },
  usageSwitchDevice: () => {
    store.connect("dev_other")
  },
  usageDisconnect: () => {
    store.disconnect()
  },
  usageSignOut: () => {
    void store.logout()
  },
  usageConnect: () => {
    handlers?.onStatus?.({ kind: "open" })
  },
})

store.connect("dev_fixture")
render(
  () => (
    <RemoteProvider createStore={() => store}>
      <main style={{ padding: "0 var(--yc-gutter)" }}>
        <UsagePage />
      </main>
    </RemoteProvider>
  ),
  document.getElementById("app")!,
)
