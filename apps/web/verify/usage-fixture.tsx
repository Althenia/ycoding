import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { RemoteProvider } from "../src/remote/context"
import type { RemoteStore, RemoteStoreState } from "../src/remote/store"
import { UsagePage } from "../src/remote/ui/usage"
import { reportKey, type UsageProvider, type UsageReportInput, type UsageReportRow } from "../src/remote/ui/usage-model"
import "../src/styles/tokens.css"
import "../src/styles/base.css"

const today = Math.floor(Date.now() / 86_400_000) * 86_400_000
const old = new URLSearchParams(location.search).has("old")
const offline = new URLSearchParams(location.search).has("offline")
const providers: UsageProvider[] = [
  { providerID: "openai", label: "Codex", profile: "Personal", status: "available", source: "provider_api", stability: "stable", updatedAt: Date.now(), windows: [
    { id: "session", label: "Session allowance", unit: "percent", used: 38, resetAt: Date.now() + 2 * 3600_000, periodSeconds: 5 * 3600 },
    { id: "week", label: "Weekly allowance", unit: "percent", used: 72, resetAt: Date.now() + 3 * 86_400_000, periodSeconds: 7 * 86_400 },
  ] },
  { providerID: "anthropic", label: "Claude", profile: "Max · Personal", status: "available", source: "provider_api", stability: "best_effort", updatedAt: Date.now(), windows: [
    { id: "session", label: "Current session", unit: "percent", used: 23, resetAt: Date.now() + 3 * 3600_000, periodSeconds: 5 * 3600 },
    { id: "weekly", label: "Weekly allowance", unit: "percent", used: 64, resetAt: Date.now() + 4 * 86_400_000, periodSeconds: 7 * 86_400 },
    { id: "extra", label: "Extra usage", unit: "usd", used: 14.8, limit: 50, remaining: 35.2 },
  ] },
  { providerID: "github-copilot", label: "Copilot", status: "stale", source: "local_client_rpc", stability: "client_contract", updatedAt: Date.now() - 3600_000, windows: [
    { id: "credits", label: "AI credits", unit: "percent", used: 38, resetAt: Date.now() + 13 * 86_400_000, periodSeconds: 30 * 86_400 },
    { id: "extra-usage", label: "Extra usage", unit: "count", used: 12 },
    { id: "org-credits", label: "Org credits", unit: "count", used: 384, limit: 1000, remaining: 616 },
    { id: "org-spend", label: "Org spend", unit: "usd", used: 4.4 },
    { id: "chat", label: "Chat", unit: "percent", used: 19 },
    { id: "completions", label: "Completions", unit: "percent", used: 42 },
  ] },
  { providerID: "openrouter", label: "OpenRouter · Pay as you go", status: "available", source: "provider_api", stability: "stable", updatedAt: Date.now(), windows: [
    { id: "balance", label: "Balance", unit: "usd", remaining: 38.42 },
    { id: "credits", label: "Credits", unit: "usd", used: 30, limit: 100, remaining: 70 },
    { id: "daily", label: "Today", unit: "usd", used: 0 },
    { id: "weekly", label: "This Week", unit: "usd", used: 8.21 },
    { id: "monthly", label: "This Month", unit: "usd", used: 27.65 },
    { id: "key", label: "Key Limit", unit: "usd", used: 12, limit: 50, remaining: 38 },
  ] },
  { providerID: "other", label: "Other provider", status: "unsupported", source: "local_session", stability: "best_effort", updatedAt: Date.now(), windows: [] },
]
const tokens = { input: 12_400, output: 3_200, reasoning: 1_440, cache: { read: 5_600, write: 320 } }
const rows: UsageReportRow[] = Array.from({ length: 30 }, (_, index) => ({
  key: new Date(today - (29 - index) * 86_400_000).toISOString().slice(0, 10),
  label: new Date(today - (29 - index) * 86_400_000).toISOString().slice(0, 10),
  logical: index + 1, physical: index + 2, helpers: 0, continued: 0, fallback: 0,
  cost: index % 6 === 0 ? undefined : (index + 1) * 0.18,
  costProvenance: index % 6 === 0 ? undefined : index % 3 === 0 ? "current_catalog" : "recorded", tokens,
}))
const sample = ["GPT-6 Sol", "Claude Opus", "Gemini Pro", "DeepSeek V3", "Llama 4", "Qwen 3"]
const entries = (input: UsageReportInput): UsageReportRow[] => input.group === "day" ? rows : Array.from({ length: 41 }, (_, index) => ({
  ...rows[index % 30]!, key: `${input.group}-${index}`, label: input.group === "model" ? `${sample[index % sample.length]} ${index + 1}` : `${input.group === "session" ? "Session" : input.group === "project" ? "Project" : "Agent"} ${index + 1}`,
  physical: 41 - index, cost: (41 - index) * 0.45, costProvenance: index % 3 === 0 ? "current_catalog" : "recorded",
}))
const requests: { operation: string; input?: UsageReportInput | { refresh: boolean } }[] = []
const [state, setState] = createSignal({
  connection: offline ? { kind: "connecting" } : { kind: "connected", deviceName: "Studio Mac" }, transport: offline ? { kind: "connecting" } : { kind: "open" },
  usage: { providers: { status: "idle" }, summary: { status: "idle" }, reports: {} },
} as RemoteStoreState)
const listeners = new Set<() => void>()
const update = (usage: RemoteStoreState["usage"]) => { setState({ ...state(), usage }); listeners.forEach((listener) => listener()) }
const store = {
  state, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  load: async () => {}, dispose: () => {},
  loadUsage: async (options?: { refresh?: boolean }) => {
    requests.push({ operation: "usage.providers", ...(options?.refresh ? { input: { refresh: true } } : {}) })
    requests.push({ operation: "usage.summary" })
    update({ ...state().usage, providers: old ? { status: "unsupported" } : { status: "ready", data: providers }, summary: old ? { status: "unsupported" } : {
      status: "ready", data: { logical: 980, physical: 1084, helpers: 0, continued: 0, fallback: 0, tokens, cost: 104.32 },
    } })
  },
  loadUsageReport: async (input: UsageReportInput) => {
    requests.push({ operation: "usage.report", input })
    const all = entries(input)
    const sorted = input.group === "day" ? all : [...all].sort((a, b) => {
      const first = input.sort === "key" ? a.label : input.sort === "steps" ? a.physical : input.sort === "tokens" || input.sort === "input" ? a.tokens.input : input.sort === "output" ? a.tokens.output : input.sort === "reasoning" ? a.tokens.reasoning : a.cost ?? 0
      const second = input.sort === "key" ? b.label : input.sort === "steps" ? b.physical : input.sort === "tokens" || input.sort === "input" ? b.tokens.input : input.sort === "output" ? b.tokens.output : input.sort === "reasoning" ? b.tokens.reasoning : b.cost ?? 0
      return (first < second ? -1 : first > second ? 1 : 0) * (input.order === "asc" ? 1 : -1)
    })
    const offset = input.offset ?? 0
    const result = { group: input.group, rows: sorted.slice(offset, offset + (input.limit ?? 25)), total: {
      logical: 980, physical: 1084, helpers: 0, continued: 0, fallback: 0, cost: 104.32, costProvenance: "current_catalog" as const, tokens,
    }, rowCount: all.length, ...((offset + (input.limit ?? 25)) < all.length ? { nextOffset: offset + (input.limit ?? 25) } : {}) }
    update({ ...state().usage, reports: { ...state().usage.reports, [reportKey(input)]: old ? { status: "unsupported" } : { status: "ready", data: result } } })
  },
} as unknown as RemoteStore
Object.assign(window, { usageRequests: () => requests, usageConnect: () => {
  setState({ ...state(), connection: { kind: "connected", deviceName: "Studio Mac" }, transport: { kind: "open" } })
  listeners.forEach((listener) => listener())
} })

render(() => <RemoteProvider createStore={() => store}><main><UsagePage /></main></RemoteProvider>, document.getElementById("app")!)
