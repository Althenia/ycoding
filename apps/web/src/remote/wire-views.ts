import {
  RemoteLimits,
  WireLimit,
  type RemoteNotice,
  type RemoteAlertDetail,
  type ParseResult,
} from "@ycoding-ai/remote"
import type { LatencySample } from "./latency"
import { prepareRemoteRequest } from "./wire"

export type OperationName = string
export type NoticeOperationName = "notice.subscribe" | "notice.list" | "notice.read" | "notice.readAll"
export type RelayRequestView = {
  readonly id: string
  readonly operation: string
  readonly sessionID?: string
  readonly workspaceID?: string
  readonly input?: Readonly<Record<string, unknown>>
}
export type NoticeRequestView = {
  readonly id: string
  readonly operation: NoticeOperationName
  readonly input?: { readonly ids: readonly string[] } | { readonly before: string }
}
export type SessionStatusView = {
  readonly running: readonly string[]
  readonly attention: readonly string[]
  readonly outstanding?: readonly string[]
  readonly failed?: readonly string[]
  readonly lost?: readonly string[]
  readonly details?: readonly {
    readonly sessionID: string
    readonly title?: string
    readonly need?: "permission" | "question" | "review"
  }[]
}
export type ProviderAuthOperationName =
  | "provider.auth.list"
  | "provider.auth.key"
  | "provider.auth.begin"
  | "provider.auth.status"
  | "provider.auth.complete"
  | "provider.auth.cancel"
export type WorkspaceView = {
  readonly id: string
  readonly projectID: string
  readonly directory: string
  readonly workspaceID?: string
  readonly name?: string
}
export type FamilyActivityView = {
  readonly sessionID: string
  readonly executing: boolean
  readonly activity?: {
    readonly kind: "tool" | "thinking" | "replying"
    readonly room: "research" | "qa" | "meeting" | "developer" | "hold"
    readonly text: string
  }
}
export type TelemetryConsentView = { readonly enabled: boolean; readonly noticeVersion: 1; readonly decidedAt: number }
export type TelemetryConsentStateView = { readonly noticeVersion: 1; readonly consent?: TelemetryConsentView }
export type LatencySampleView = LatencySample
export type CapturedChangesView = {
  readonly data: readonly {
    readonly placementMessageID: string
    readonly path: string
    readonly additions: number
    readonly deletions: number
    readonly status: "created" | "deleted" | "modified"
    readonly files: readonly {
      readonly diff: string
      readonly path: string
      readonly additions: number
      readonly deletions: number
      readonly status: "created" | "deleted" | "modified"
      readonly unavailable?: boolean
    }[]
  }[]
  readonly cursor?: { readonly next?: string }
}
export type CompactionHistoryView = {
  readonly data: readonly {
    readonly jobID: string
    readonly trigger: string
    readonly status: "pending" | "running" | "completed" | "failed"
    readonly metrics?: {
      readonly excludedMessages: number
      readonly excludedParts: number
      readonly inputTokens: number
      readonly retainedTokens: number
    }
    readonly created: number
    readonly code?: string
  }[]
  readonly truncated: boolean
  readonly completedBefore: number
  readonly completedCount: number
  readonly totalSavedTokens: number
}
export type UsageTokensView = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}
export type QuotaProviderView = {
  readonly providerID: string
  readonly label: string
  readonly profile?: string
  readonly status: "available" | "stale" | "unsupported" | "unauthorized" | "error"
  readonly source:
    | "provider_api"
    | "local_client_rpc"
    | "response_headers"
    | "response_stream"
    | "provider_internal_api"
    | "local_session"
  readonly stability: "stable" | "client_contract" | "observed" | "best_effort"
  readonly updatedAt: number
  readonly windows: readonly {
    readonly id: string
    readonly label: string
    readonly unit: "percent" | "usd" | "requests" | "tokens" | "count"
    readonly used?: number
    readonly limit?: number
    readonly remaining?: number
    readonly unlimited?: boolean
    readonly resetAt?: number
    readonly periodSeconds?: number
  }[]
  readonly message?: string
}
export type UsageCostCoverageView = { readonly pricedRequests: number; readonly unpricedRequests: number }
export type UsageSpeedView = {
  readonly generationSamples: number
  readonly generationP50TokensPerSecond?: number
  readonly generationP90TokensPerSecond?: number
  readonly providerTimedSamples: number
  readonly observedSamples: number
  readonly firstOutputP50Ms?: number
  readonly firstOutputP95Ms?: number
  readonly totalP50Ms?: number
  readonly totalP95Ms?: number
  readonly outputTokensPerSecond?: number
  readonly samples: number
}
export type UsageMetricsView = {
  readonly logical: number
  readonly physical: number
  readonly helpers: number
  readonly continued: number
  readonly fallback: number
  readonly tokens: UsageTokensView
  readonly cost?: number
  readonly costProvenance?: "recorded" | "current_catalog"
  readonly costCoverage?: UsageCostCoverageView
  readonly cacheReadReported?: boolean
}
export type UsageCostView = UsageCostCoverageView & {
  readonly total?: number
  readonly known?: number
  readonly provenance?: "recorded" | "current_catalog"
}
export type UsageBreakdownView = {
  readonly requests: number
  readonly tokens: UsageTokensView
  readonly cost: UsageCostView
}
export type UsageHelperView = UsageBreakdownView & {
  readonly source: "step" | "title" | "goal" | "compaction" | "decision" | "prediction" | "prompt"
}
type UsageUnitCostView = {
  readonly status: "settled" | "so-far"
  readonly attribution: "complete" | "partial" | "unattributed"
  readonly history: "retained" | "partial"
  readonly total: UsageBreakdownView
  readonly main: UsageBreakdownView
  readonly children: UsageBreakdownView
  readonly helpers: readonly UsageHelperView[]
}
export type UsagePromptCostView = UsageUnitCostView & {
  readonly anchor: { readonly sessionID: string; readonly inputID: string }
}
export type UsageTaskCostView = UsageUnitCostView & {
  readonly sessionID: string
  readonly usageAnchor?: { readonly sessionID: string; readonly inputID: string }
}
export type UsagePromptCostsView = {
  readonly units: readonly UsagePromptCostView[]
  readonly unattributed: UsageBreakdownView
  readonly history: "retained" | "partial"
}
export type UsageTaskCostsView = {
  readonly tasks: readonly UsageTaskCostView[]
  readonly total: UsageBreakdownView
  readonly history: "retained" | "partial"
}
export type UsageForecastRateView = {
  readonly providerID: string
  readonly profile?: string
  readonly modelID?: string
  readonly observedFrom: number
  readonly observedTo: number
  readonly tokensPerMinute: number
  readonly tokensPerMinute5?: number
  readonly tokensPerMinute60?: number
  readonly estimatedUSDPerHour?: number
  readonly coverage: UsageCostCoverageView
}
export type UsageForecastQuotaView = {
  readonly providerID: string
  readonly profile?: string
  readonly windowID: string
  readonly unit: "percent" | "usd" | "requests" | "tokens" | "count"
  readonly source: QuotaProviderView["source"]
  readonly stability: QuotaProviderView["stability"]
  readonly updatedAt: number
  readonly state: "estimated" | "insufficient" | "exhausted" | "unlimited"
  readonly method?: "quota-delta-ema" | "window-mean"
  readonly evidence: "low" | "medium" | "insufficient"
  readonly reason?: string
  readonly observedFrom?: number
  readonly observedTo?: number
  readonly ratePerHour?: number
  readonly exhaustionAt?: number
  readonly projectedUsedAtReset?: number
}
export type UsageForecastView = {
  readonly asOf: number
  readonly localScope: "backend" | "location"
  readonly localRates?: readonly UsageForecastRateView[]
  readonly quotas?: readonly UsageForecastQuotaView[]
}
export type UsageSummaryValueView = {
  readonly data: UsageMetricsView & {
    readonly models?: readonly {
      readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string }
      readonly requests: number
      readonly tokens: UsageTokensView
      readonly cacheReadReported?: boolean
      readonly cost?: number
      readonly costProvenance?: "recorded" | "current_catalog"
    }[]
    readonly latestInvalidation?: string
    readonly latestNamespace?: string
    readonly latestTiming?: {
      readonly promptEvalDurationNs?: number
      readonly generationDurationNs?: number
      readonly loadDurationNs?: number
    }
  }
}
export type UsageGroupView =
  | "model"
  | "hour"
  | "day"
  | "month"
  | "session"
  | "project"
  | "agent"
  | "provider"
  | "provider-profile-model"
  | "provider-model"
  | "model-id"
  | "profile"
  | "prompt"
  | "task"
export type UsageReportDimensionsView =
  | { readonly group: "provider"; readonly providerID: string }
  | {
      readonly group: "provider-profile-model"
      readonly providerID: string
      readonly profile?: string
      readonly profileState: "recorded" | "provider-default"
      readonly modelID: string
    }
  | { readonly group: "provider-model"; readonly providerID: string; readonly modelID: string }
  | { readonly group: "model-id"; readonly modelID: string }
  | {
      readonly group: "profile"
      readonly providerID: string
      readonly profile?: string
      readonly profileState: "recorded" | "provider-default"
    }
  | {
      readonly group: "prompt"
      readonly anchor?: { readonly sessionID: string; readonly inputID: string }
      readonly attribution: "complete" | "partial" | "unattributed"
    }
  | {
      readonly group: "task"
      readonly sessionID?: string
      readonly attribution: "complete" | "partial" | "unattributed"
    }
export type UsageReportInputView = {
  readonly group: UsageGroupView
  readonly providerID?: string
  readonly profile?: string
  readonly modelID?: string
  readonly selectedEffort?: string
  readonly timeZone?: string
  readonly from?: number
  readonly to?: number
  readonly offset?: number
  readonly limit?: number
  readonly sort?: "key" | "tokens" | "cost" | "steps" | "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite"
  readonly order?: "asc" | "desc"
}
export type UsageReportValueView = {
  readonly data: {
    readonly group: UsageGroupView
    readonly rows: readonly (UsageMetricsView & {
      readonly key: string
      readonly label: string
      readonly model?: { readonly providerID: string; readonly id: string; readonly variant?: string; readonly profile?: string }
      readonly dimensions?: UsageReportDimensionsView
      readonly speed?: UsageSpeedView
    })[]
    readonly total: UsageMetricsView
    readonly rowCount: number
    readonly nextOffset?: number
  }
}
export type IncidentKindView = "fallback" | "guardrail-escalated" | "guardrail-rejected"
export type IncidentModelRefView = {
  readonly id: string
  readonly providerID: string
  readonly variant?: string
  readonly profile?: string
}
export type IncidentReportInputView = {
  readonly group: "model" | "agent"
  readonly from?: number
  readonly to?: number
  readonly offset?: number
  readonly limit?: number
}
export type IncidentReportRowView = {
  readonly providerID: string
  readonly modelID: string
  readonly agent?: string
  readonly fallbacks: number
  readonly escalated: number
  readonly rejected: number
  readonly last: number
}
export type IncidentReportView = {
  readonly data: { readonly rows: readonly IncidentReportRowView[]; readonly groups: number }
}
export type IncidentRecentInputView = {
  readonly provider: string
  readonly model: string
  readonly agent?: string
  readonly limit?: number
}
export type IncidentItemView = {
  readonly id: string
  readonly time: number
  readonly kind: IncidentKindView
  readonly category: string
  readonly ruleIDs: readonly string[]
  readonly agent: string
  readonly variant?: string
  readonly profile?: string
  readonly target?: IncidentModelRefView
  readonly decidedBy?: "decision-model" | "human"
}
export type IncidentRecentView = { readonly data: { readonly items: readonly IncidentItemView[] } }
export type IncidentGuidanceInputView = { readonly provider: string; readonly model: string }
export type IncidentGuidanceView = {
  readonly data: { readonly text?: string; readonly clearedAt?: number; readonly enabled: boolean }
}

export type AuthPromptView =
  | {
      readonly type: "text"
      readonly key: string
      readonly message: string
      readonly placeholder?: string
      readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }
    }
  | {
      readonly type: "select"
      readonly key: string
      readonly message: string
      readonly options: readonly { readonly label: string; readonly value: string; readonly hint?: string }[]
      readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }
    }
export type AuthIntegrationView = {
  readonly id: string
  readonly name: string
  readonly providers: readonly string[]
  readonly profiles: readonly { readonly name: string; readonly active: boolean }[]
  readonly methods: readonly {
    readonly type: "key" | "oauth" | "command"
    readonly id?: string
    readonly label: string
    readonly available: boolean
    readonly reason?: string
    readonly prompts?: readonly AuthPromptView[]
  }[]
}
export type AuthAttemptView = {
  readonly attemptID: string
  readonly type: "oauth" | "command"
  readonly time: { readonly created: number; readonly expires: number }
  readonly url?: string
  readonly instructions?: string
  readonly mode?: "auto" | "code"
  readonly manualCode?: boolean
}
export type AuthStatusView = {
  readonly status: "pending" | "complete" | "failed" | "expired"
  readonly message?: string
  readonly time: { readonly created: number; readonly expires: number }
}
export type NoticePresentationView =
  | { readonly kind: "notice"; readonly notice: RemoteNotice; readonly detail?: RemoteAlertDetail }
  | { readonly kind: "offline"; readonly at: number }
export type NoticePageView = {
  readonly notices: readonly RemoteNotice[]
  readonly total: number
  readonly next?: string
  readonly unavailable: boolean
}
export type NoticeFrame =
  | { readonly type: "notice.added"; readonly notices: readonly RemoteNotice[]; readonly total: number }
  | { readonly type: "notice.removed"; readonly ids: readonly string[]; readonly total: number }
  | { readonly type: "notice.cleared" }
  | { readonly type: "notice.unavailable" }
  | { readonly type: "notice.offline"; readonly at: number }
  | { readonly type: "notice.present"; readonly items: readonly NoticePresentationView[] }

export function validReviewItemID(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^rvw_[A-Za-z0-9_-]+$/.test(value)
}

export const WebLimits = {
  ...RemoteLimits,
  maxAttachmentBytes: 20 * 1024 * 1024,
  maxConnectionAttachmentBytes: 40 * 1024 * 1024,
  uploadChunkBytes: 21000,
  maxPromptSkills: 200,
  attachmentTtlMs: 10 * 60_000,
  maxFamilyMembers: 16,
  maxCompactionHistory: 100,
  maxLatencyBatch: 20,
  maxLatencyPage: 200,
  goalSetTimeoutMs: 5 * 60_000,
  compactionTimeoutMs: 5 * 60_000,
  maxSessionListPage: 200,
  clientRateWindowMs: WireLimit.RATE_WINDOW_MS,
  maxClientRequestsPerWindow: WireLimit.CLIENT_RATE,
  maxPendingRequestsPerClient: WireLimit.PENDING_REQUESTS,
} as const

export function validBase64(value: string) {
  if (value.length % 4 !== 0) return false
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  for (let index = 0; index < value.length - padding; index++) {
    const code = value.charCodeAt(index)
    if (
      !(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47
      )
    )
      return false
  }
  return true
}

export function validAlertTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    Array.from(value).length <= 120 &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)
  )
}
export function validLatencySample(value: unknown): value is LatencySampleView {
  if (typeof value !== "object" || value === null) return false
  const sample = value as Record<string, unknown>
  if (
    typeof sample.at !== "string" ||
    sample.at.length !== 24 ||
    !Number.isFinite(Date.parse(sample.at)) ||
    new Date(sample.at).toISOString() !== sample.at
  )
    return false
  const duration = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 600_000
  if (sample.kind === "long-task")
    return (
      Object.keys(sample).every((key) => ["kind", "at", "durationMs"].includes(key)) &&
      duration(sample.durationMs) &&
      Number(sample.durationMs) >= 50
    )
  if (sample.kind === "client")
    return (
      Object.keys(sample).every((key) => ["kind", "at", "surface", "metric", "durationMs"].includes(key)) &&
      sample.surface === "web" &&
      ["prompt.admit", "stream.delay", "transcript.load"].includes(String(sample.metric)) &&
      duration(sample.durationMs)
    )
  if (
    sample.kind !== "request" ||
    typeof sample.operation !== "string" ||
    !["ok", "failed", "unknown", "unavailable"].includes(String(sample.outcome)) ||
    !duration(sample.queueMs) ||
    !duration(sample.totalMs) ||
    (sample.settlementMs !== undefined && !duration(sample.settlementMs)) ||
    Object.keys(sample).some(
      (key) => !["kind", "at", "operation", "outcome", "reason", "queueMs", "settlementMs", "totalMs"].includes(key),
    )
  )
    return false
  if (
    sample.outcome === "unavailable"
      ? sample.reason !== undefined &&
        !["not-connected", "in-flight-limit", "request-limit", "cancelled"].includes(String(sample.reason))
      : sample.reason !== undefined
  )
    return false
  if (
    sample.settlementMs === undefined
      ? sample.queueMs !== sample.totalMs
      : Number(sample.queueMs) + Number(sample.settlementMs) !== sample.totalMs
  )
    return false
  try {
    prepareRemoteRequest("telemetry.append", { input: { samples: [sample] } })
    return true
  } catch {
    return false
  }
}

export function telemetryOperation(operation: string) {
  const labels: Readonly<Record<string, string>> = {
    "event.subscribe": "session.subscribe",
    "event.unsubscribe": "session.unsubscribe",
    "session.message": "session.message.stream",
    "shell.output": "session.shell.output",
    "session.guardrail.request.reply": "session.guardrail.reply",
    "catalog.get": "session.catalog",
    "fs.find": "session.file.find",
    "providerUsage.list": "usage.providers",
    "providerUsage.forecast": "usage.forecast",
    "usage.get": "usage.summary",
    "keepAwake.get": "machine.keepAwake.get",
    "keepAwake.set": "machine.keepAwake.set",
  }
  return labels[operation] ?? operation
}

export function readNoticePageView(value: unknown): ParseResult<NoticePageView> {
  if (typeof value !== "object" || value === null)
    return { ok: false, error: { code: "invalid_message", message: "Invalid notice page" } }
  const page = value as Record<string, unknown>
  if (
    !Array.isArray(page.notices) ||
    typeof page.total !== "number" ||
    !Number.isSafeInteger(page.total) ||
    page.total < 0 ||
    typeof page.unavailable !== "boolean" ||
    (page.next !== undefined && typeof page.next !== "string")
  )
    return { ok: false, error: { code: "invalid_message", message: "Invalid notice page" } }
  const notices = page.notices as RemoteNotice[]
  if (
    !notices.every(
      (notice) =>
        typeof notice.id === "string" &&
        typeof notice.sessionID === "string" &&
        (notice.category === "agent-completed" || notice.category === "approval-requested") &&
        typeof notice.createdAt === "number",
    )
  )
    return { ok: false, error: { code: "invalid_message", message: "Invalid notice record" } }
  return {
    ok: true,
    value: {
      notices,
      total: page.total,
      unavailable: page.unavailable,
      ...(typeof page.next === "string" ? { next: page.next } : {}),
    },
  }
}
