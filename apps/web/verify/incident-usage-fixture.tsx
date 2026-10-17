import { render } from "solid-js/web"
import { RemoteProvider } from "../src/remote/context"
import type { RemoteHttp } from "../src/remote/http"
import { createRemoteQueries } from "../src/remote/queries"
import { createRemoteStore } from "../src/remote/store"
import type { RemoteRequestOutcome, RemoteTransportRequest } from "../src/remote/transport"
import type { IncidentGuidance, IncidentItem, IncidentRecentInput, IncidentReport, IncidentReportInput, IncidentRow } from "../src/remote/ui/model-incident-model"
import { UsagePage } from "../src/remote/ui/usage"
import "../src/styles/tokens.css"
import "../src/styles/base.css"
import "../src/styles/remote.css"

const params = new URLSearchParams(location.search)
const mode = params.get("mode") ?? "default"
const day = 86_400_000
const now = Date.now()
const paged = mode === "paged"
const recentRows: IncidentRow[] = [
  { providerID: "openai", modelID: "gpt-6-sol", fallbacks: 1234, escalated: 5, rejected: 2, last: now - day },
  { providerID: "anthropic", modelID: "claude-opus", fallbacks: 0, escalated: 3, rejected: 0, last: now - 3 * day },
  { providerID: "openrouter", modelID: "deepseek-v4", fallbacks: 7, escalated: 0, rejected: 1, last: now - 20 * day },
]
const agentRows: IncidentRow[] = [
  { providerID: "openai", modelID: "gpt-6-sol", agent: "build", fallbacks: 1000, escalated: 5, rejected: 0, last: now - day },
  { providerID: "openai", modelID: "gpt-6-sol", agent: "plan", fallbacks: 234, escalated: 0, rejected: 2, last: now - 2 * day },
  { providerID: "anthropic", modelID: "claude-opus", agent: "build", fallbacks: 0, escalated: 3, rejected: 0, last: now - 3 * day },
]
const many = (agent: boolean): IncidentRow[] => Array.from({ length: 60 }, (_, index) => ({ providerID: "openai", modelID: `model-${String(index + 1).padStart(2, "0")}`, ...(agent ? { agent: "build" } : {}), fallbacks: 60 - index, escalated: 0, rejected: 0, last: now - index * 60_000 }))
const kinds = ["fallback", "guardrail-escalated", "guardrail-rejected"] as const
const guidanceText = "<model-guidance>\nPast guardrail reviews stopped some of this model's actions:\n- Destructive Git (standard.review.git-destructive): Prefer reversible Git commands and retain required approval checks.\n</model-guidance>"
const target = { providerID: "anthropic", id: "claude-opus" }
const recentItems = (input: IncidentRecentInput): IncidentItem[] => Array.from({ length: Math.min(input.limit ?? 20, 25) }, (_, index) => ({
  id: `inc_${String(index + 1).padStart(3, "0")}`, time: now - (index + 1) * 3_600_000, kind: kinds[index % 3]!, category: index % 3 === 0 ? "fallback" : "standard.review.git-destructive",
  ruleIDs: index % 3 === 0 ? [] : ["standard.review.git-destructive", "custom"], agent: input.agent ?? (index % 2 === 0 ? "build" : "plan"),
  ...(index === 0 ? { variant: "high", profile: "work", target } : {}), ...(index % 3 === 0 ? { target } : { decidedBy: index % 2 === 0 ? "decision-model" as const : "human" as const }),
}))

const requests: { readonly operation: string; readonly input: unknown; readonly sessionID?: string }[] = []
let guidance: IncidentGuidance = { enabled: mode !== "disabled", ...(mode === "no-guidance" ? {} : { text: guidanceText }) }
let releaseReport: (() => void) | undefined
const reportGate = mode === "loading" ? new Promise<void>((resolve) => { releaseReport = resolve }) : undefined
let reportFailing = mode === "error"
let detailFailing = mode === "detail-error"

const read = (input: IncidentReportInput): IncidentReport => {
  const all = paged ? many(input.group === "agent") : input.group === "agent" ? agentRows : recentRows
  const filtered = all.filter((row) => (input.from === undefined || row.last >= input.from) && (input.to === undefined || row.last < input.to))
  const offset = input.offset ?? 0
  return { rows: filtered.slice(offset, offset + (input.limit ?? 25)), groups: filtered.length }
}
const ok = (data: unknown): RemoteRequestOutcome => ({ status: "ok", value: { data } })
const failed = (code: "unknown_operation" | "internal_error", message: string): RemoteRequestOutcome => ({ status: "failed", error: { code, message } })
const answer = async (operation: string, request?: RemoteTransportRequest): Promise<RemoteRequestOutcome> => {
  if (!operation.startsWith("incident.")) return failed("unknown_operation", "Unknown operation")
  requests.push({ operation, input: request?.input, ...(request?.sessionID === undefined ? {} : { sessionID: request.sessionID }) })
  if (mode === "old") return failed("unknown_operation", "Unknown operation")
  if (operation === "incident.report") {
    if (reportGate) await reportGate
    if (reportFailing) return failed("internal_error", "Incident report could not be loaded.")
    return ok(mode === "empty" ? { rows: [], groups: 0 } : read(request!.input as IncidentReportInput))
  }
  if (operation === "incident.recent") {
    if (detailFailing) return failed("internal_error", "Recent incidents could not be loaded.")
    return ok({ items: mode === "no-recent" ? [] : recentItems(request!.input as IncidentRecentInput) })
  }
  if (operation === "incident.guidance.get") {
    if (detailFailing) return failed("internal_error", "Guidance could not be loaded.")
    return ok(guidance)
  }
  return failed("unknown_operation", "Unknown operation")
}

const http: RemoteHttp = {
  me: async () => ({ ok: true, value: { user: { id: "user_fixture" }, session: { expiresAt: Date.now() + 60_000 }, devices: [{ id: "dev_fixture", name: "Studio Mac", createdAt: 1, status: "active", online: true }] } }),
  devices: async () => ({ ok: true, value: [{ id: "dev_fixture", name: "Studio Mac", createdAt: 1, status: "active", online: true }] }),
  createEnrollment: async () => ({ ok: false, status: 503, message: "Not available in this fixture", kind: "http" }),
  revokeDevice: async () => ({ ok: true, value: undefined }),
  removeRevokedDevices: async () => ({ ok: true, value: undefined }),
  logout: async () => ({ ok: true, value: undefined }),
}
const store = createRemoteStore({
  http,
  deviceName: () => "Studio Mac",
  createTransport: (deviceID, callbacks) => ({
    connect: () => { if (deviceID === "dev_fixture" && mode !== "offline") callbacks.onStatus?.({ kind: "open" }) },
    close: () => {},
    setPriority: () => {},
    status: () => ({ kind: "open" }),
    request: answer,
  }),
})
const session = { store, queries: createRemoteQueries(store.link, store.queryClient) }

Object.assign(window, {
  incidentRequests: () => requests,
  incidentRelease: () => { releaseReport?.(); releaseReport = undefined },
  incidentRecover: () => { reportFailing = false; detailFailing = false },
})

store.connect("dev_fixture")
queueMicrotask(() => store.container.setState((state) => ({ ...state, activeSessionID: "ses_fixture" })))
render(() => <RemoteProvider session={session}><main style={{ padding: "0 var(--yc-gutter)" }}><UsagePage /></main></RemoteProvider>, document.getElementById("app")!)
