import { QueryClient, queryOptions } from "@tanstack/solid-query"
import type { RemoteOperation, RemoteWorkspaceInfo } from "@ycoding-ai/remote"
import { keepAwakeAnswer, readKeepAwakeStatus, type KeepAwakeState } from "./keep-awake"
import { describeOutcome } from "./outcome"
import type { RemoteRequestOutcome, RemoteTransportRequest } from "./transport"
import { reportKey, type UsageProvider, type UsageReport, type UsageReportInput, type UsageSummary } from "./ui/usage-model"

/** One device connection: a device switch, disconnect, or rejected credential starts a new generation. */
export type QueryScope = { readonly deviceID: string; readonly generation: number }

export type RemoteLink = {
  readonly request: (scope: QueryScope, operation: RemoteOperation, request?: RemoteTransportRequest) => Promise<RemoteRequestOutcome>
  readonly recoveries: () => number
  /** Settles true at the next recovery signal after `since`, or false when the scope ends first. */
  readonly recovered: (scope: QueryScope, since: number) => Promise<boolean>
}

/** Reads ride the relay transport, not the browser network, so offline detection must not pause them. */
export const createRemoteQueryClient = () => new QueryClient({
  defaultOptions: { queries: { networkMode: "always", refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { networkMode: "always" } },
})

const idleScope: QueryScope = { deviceID: "", generation: 0 }

export const remoteKeys = {
  root: ["remote"] as const,
  scope: (scope: QueryScope) => ["remote", scope.deviceID, scope.generation] as const,
  usage: (scope: QueryScope) => [...remoteKeys.scope(scope), "usage"] as const,
  usageProviders: (scope: QueryScope) => [...remoteKeys.usage(scope), "providers"] as const,
  usageSummary: (scope: QueryScope) => [...remoteKeys.usage(scope), "summary"] as const,
  usageReport: (scope: QueryScope, input: UsageReportInput) => [...remoteKeys.usage(scope), "report", reportKey(input)] as const,
  keepAwake: (scope: QueryScope) => [...remoteKeys.scope(scope), "keepAwake"] as const,
  workspaces: (scope: QueryScope) => [...remoteKeys.scope(scope), "workspaces"] as const,
}

export type UsageResult<T> = { readonly status: "ready"; readonly data: T } | { readonly status: "unsupported" }

export type UsageRead<T> = { readonly status: "idle" | "loading" | "ready" | "unsupported" | "error"; readonly data?: T; readonly message?: string }

type QueryView<T> = { readonly status: "pending" | "error" | "success"; readonly fetchStatus: "fetching" | "paused" | "idle"; readonly data: T | undefined; readonly error: Error | null }

/** Reading `data` of a pending Solid query suspends its nearest boundary, so every read helper settles the status first. */
export function usageRead<T>(query: QueryView<UsageResult<T>>): UsageRead<T> {
  if (query.status === "pending") return { status: query.fetchStatus === "fetching" ? "loading" : "idle" }
  const data = query.data?.status === "ready" ? query.data.data : undefined
  const kept = data === undefined ? {} : { data }
  if (query.fetchStatus === "fetching") return { status: "loading", ...kept }
  if (query.status === "error") return { status: "error", ...kept, message: query.error?.message ?? "Usage could not be loaded." }
  return query.data?.status === "unsupported" ? { status: "unsupported" } : { status: "ready", ...kept }
}

export function keepAwakeState(query: QueryView<KeepAwakeState>): KeepAwakeState {
  if (query.status === "pending") return { read: query.fetchStatus === "fetching" ? "loading" : "idle" }
  if (query.data?.read === "ready") return query.data
  if (query.fetchStatus === "fetching") return { read: "loading", ...(query.data?.change === undefined ? {} : { change: query.data.change }) }
  return query.data ?? { read: "idle" }
}

const isUnknown = (outcome: RemoteRequestOutcome) => (outcome.status === "failed" || outcome.status === "unknown") && outcome.error.code === "outcome_unknown"

export function createRemoteQueries(link: RemoteLink, client: QueryClient) {
  const refreshing = new Set<string>()
  /** A read whose one automatic retry after an unknown outcome also failed replays nothing until an explicit refresh; the failed query object carries the mark. */
  const exhausted = new WeakMap<object, Error>()

  const usageQuery = <T>(input: {
    readonly scope: QueryScope | undefined
    readonly enabled: boolean
    readonly key: (scope: QueryScope) => readonly unknown[]
    readonly operation: RemoteOperation
    readonly request: (refresh: boolean) => RemoteTransportRequest
    readonly read: (raw: unknown) => T | undefined
    readonly unsupported: (outcome: RemoteRequestOutcome) => boolean
    readonly label: string
    readonly unreadable: string
  }) => {
    const scope = input.scope ?? idleScope
    const queryKey = input.key(scope)
    return queryOptions({
      queryKey,
      enabled: input.scope !== undefined && input.enabled,
      staleTime: 60_000,
      retry: false,
      queryFn: async (): Promise<UsageResult<T>> => {
        const refresh = refreshing.delete(JSON.stringify(queryKey))
        const query = client.getQueryCache().find({ queryKey, exact: true })
        const failure = query === undefined ? undefined : exhausted.get(query)
        if (!refresh && failure !== undefined) throw failure
        if (query !== undefined) exhausted.delete(query)
        const since = link.recoveries()
        let outcome = await link.request(scope, input.operation, input.request(refresh))
        const retried = isUnknown(outcome)
        if (retried) {
          if (!await link.recovered(scope, since)) throw new Error(describeOutcome({ status: "unavailable", reason: "cancelled" }, input.label))
          outcome = await link.request(scope, input.operation, input.request(refresh))
        }
        if (input.unsupported(outcome)) return { status: "unsupported" }
        const raw = outcome.status === "ok" && typeof outcome.value === "object" && outcome.value !== null ? Reflect.get(outcome.value, "data") : undefined
        const data = input.read(raw)
        if (data !== undefined) return { status: "ready", data }
        const error = new Error(outcome.status === "ok" ? input.unreadable : describeOutcome(outcome, input.label))
        const failed = client.getQueryCache().find({ queryKey, exact: true })
        if (retried && failed !== undefined) exhausted.set(failed, error)
        throw error
      },
    })
  }

  const unknownOperation = (outcome: RemoteRequestOutcome) => outcome.status === "failed" && outcome.error.code === "unknown_operation"

  const usageProviders = (scope: QueryScope | undefined, enabled: boolean) => usageQuery<readonly UsageProvider[]>({
    scope, enabled, key: remoteKeys.usageProviders, operation: "usage.providers",
    request: (refresh) => refresh ? { input: { refresh: true } } : {},
    read: readUsageProviders, unsupported: unknownOperation, label: "Usage", unreadable: "The device returned unreadable usage data.",
  })

  const usageSummary = (scope: QueryScope | undefined, enabled: boolean) => usageQuery<UsageSummary>({
    scope, enabled, key: remoteKeys.usageSummary, operation: "usage.summary", request: () => ({}),
    read: readUsageMetrics, unsupported: unknownOperation, label: "Usage", unreadable: "The device returned unreadable usage data.",
  })

  const usageReport = (scope: QueryScope | undefined, enabled: boolean, report: UsageReportInput) => usageQuery<UsageReport>({
    scope, enabled: enabled && (report.limit === undefined || Number.isInteger(report.limit) && report.limit >= 1 && report.limit <= 200),
    key: (current) => remoteKeys.usageReport(current, report), operation: "usage.report", request: () => ({ input: report }),
    read: (raw) => readUsageReport(raw, report.group),
    unsupported: (outcome) => outcome.status === "failed" && (outcome.error.code === "unknown_operation" || report.timeZone !== undefined && outcome.error.code === "invalid_message"),
    label: "Usage report", unreadable: "The device returned an unreadable usage report.",
  })

  /** Explicit refresh or retry: the next read of each key sends any refresh flag, skips an exhausted error, and replaces a read in flight. */
  const refetchFresh = async (keys: readonly (readonly unknown[])[]) => {
    keys.forEach((key) => refreshing.add(JSON.stringify(key)))
    await Promise.all(keys.map((queryKey) => client.refetchQueries({ queryKey, type: "all" })))
  }

  const refreshUsage = (scope: QueryScope) => refetchFresh([remoteKeys.usageProviders(scope), remoteKeys.usageSummary(scope)])

  const retryUsageReport = (scope: QueryScope, input: UsageReportInput) => refetchFresh([remoteKeys.usageReport(scope, input)])

  const keepAwake = (scope: QueryScope | undefined, enabled: boolean) => {
    const current = scope ?? idleScope
    const queryKey = remoteKeys.keepAwake(current)
    return queryOptions({
      queryKey,
      enabled: scope !== undefined && enabled,
      staleTime: 15_000,
      refetchOnMount: "always",
      retry: false,
      queryFn: async (): Promise<KeepAwakeState> => {
        const prior = client.getQueryData<KeepAwakeState>(queryKey)
        if (prior?.change?.state === "sending") return prior
        const outcome = await link.request(current, "machine.keepAwake.get", { timeoutMs: 5_000 })
        return keepAwakeAnswer(outcome, prior?.change?.state === "unknown" ? { change: prior.change } : {})
      },
    })
  }

  const keepAwakeMutation = (scope: QueryScope | undefined) => {
    const current = scope ?? idleScope
    const queryKey = remoteKeys.keepAwake(current)
    return {
      mutationKey: [...queryKey, "set"] as const,
      mutationFn: async (enabled: boolean): Promise<{ readonly reached: boolean; readonly reload: boolean }> => {
        const prior = client.getQueryData<KeepAwakeState>(queryKey)
        if (prior?.read !== "ready" || prior.status === undefined || prior.status.state === "unsupported" || prior.change?.state === "sending")
          return { reached: false, reload: false }
        const status = prior.status
        await client.cancelQueries({ queryKey })
        client.setQueryData<KeepAwakeState>(queryKey, { read: "ready", status, change: { state: "sending", enabled } })
        const outcome = await link.request(current, "machine.keepAwake.set", { input: { enabled } })
        if (client.getQueryData(queryKey) === undefined) return { reached: false, reload: false }
        const write = (next: KeepAwakeState) => client.setQueryData<KeepAwakeState>(queryKey, next)
        const unconfirmed = (message: string) => write({ read: "ready", status, change: { state: "unknown", enabled, message } })
        const verb = enabled ? "on" : "off"
        if (outcome.status === "ok") {
          const answered = readKeepAwakeStatus(outcome.value)
          if (answered === undefined) {
            unconfirmed(`The machine answered unreadably, so the result of turning it ${verb} is unconfirmed. The state shown is what it last reported.`)
            return { reached: false, reload: true }
          }
          const reached = answered.state === (enabled ? "on" : "off")
          const mismatch = (answered.state === "on" || answered.state === "off") && !reached
          write({ read: "ready", status: answered,
            ...(mismatch ? { change: { state: "failed" as const, enabled, message: `The machine reports it is ${answered.state === "on" ? "On" : "Off"}.` } } : {}) })
          return { reached, reload: false }
        }
        if (unknownOperation(outcome)) {
          write({ read: "outdated" })
          return { reached: false, reload: false }
        }
        if (outcome.status === "unknown") {
          unconfirmed(`The result of turning it ${verb} is unconfirmed. The state shown is what the machine reports now; nothing was sent again.`)
          return { reached: false, reload: true }
        }
        write({ read: "ready", status, change: { state: "failed", enabled, message: describeOutcome(outcome, "Keep machine awake") } })
        return { reached: false, reload: false }
      },
      onSettled: async (result: { readonly reload: boolean } | undefined) => {
        if (result?.reload) await client.invalidateQueries({ queryKey }, { cancelRefetch: false })
      },
    }
  }

  const workspaces = (scope: QueryScope | undefined, enabled: boolean) => {
    const current = scope ?? idleScope
    return queryOptions({
      queryKey: remoteKeys.workspaces(current),
      enabled: scope !== undefined && enabled,
      staleTime: 60_000,
      retry: false,
      queryFn: async (): Promise<readonly RemoteWorkspaceInfo[]> => {
        const outcome = await link.request(current, "workspace.list")
        if (outcome.status !== "ok") throw new Error(describeOutcome(outcome, "Workspaces"))
        const listed = readWorkspaces(outcome.value)
        if (listed === undefined) throw new Error("The device returned an unreadable workspace list.")
        return listed
      },
    })
  }

  return { usageProviders, usageSummary, usageReport, refreshUsage, retryUsageReport, keepAwake, keepAwakeMutation, workspaces }
}

export type RemoteQueries = ReturnType<typeof createRemoteQueries>

function readUsageProviders(value: unknown): readonly UsageProvider[] | undefined {
  if (!Array.isArray(value)) return undefined
  const statuses = ["available", "stale", "unsupported", "unauthorized", "error"]
  const units = ["percent", "usd", "requests", "tokens", "count"]
  if (!value.every((item) => typeof item === "object" && item !== null && typeof item.providerID === "string" &&
    typeof item.label === "string" && statuses.includes(item.status) && typeof item.source === "string" &&
    typeof item.stability === "string" && Number.isFinite(item.updatedAt) && !Number.isNaN(new Date(item.updatedAt).getTime()) &&
    (item.profile === undefined || typeof item.profile === "string") && (item.message === undefined || typeof item.message === "string") &&
    Array.isArray(item.windows) && item.windows.every((window: Record<string, unknown>) =>
      typeof window.id === "string" && typeof window.label === "string" && units.includes(String(window.unit)) &&
      [window.used, window.limit, window.remaining, window.resetAt, window.periodSeconds].every((n) => n === undefined || typeof n === "number" && Number.isFinite(n) && n >= 0) &&
      (window.unlimited === undefined || typeof window.unlimited === "boolean")))) return undefined
  return value as UsageProvider[]
}

function readUsageMetrics(value: unknown): UsageSummary | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const fields = ["logical", "physical", "helpers", "continued", "fallback"]
  const tokens = Reflect.get(value, "tokens")
  if (fields.some((field) => !Number.isFinite(Reflect.get(value, field)) || Reflect.get(value, field) < 0) ||
    typeof tokens !== "object" || tokens === null ||
    ["input", "output", "reasoning"].some((field) => !Number.isFinite(Reflect.get(tokens, field))) ||
    typeof Reflect.get(tokens, "cache") !== "object" || Reflect.get(tokens, "cache") === null ||
    ["read", "write"].some((field) => !Number.isFinite(Reflect.get(Reflect.get(tokens, "cache"), field))) ||
    (Reflect.get(value, "cost") !== undefined && (!Number.isFinite(Reflect.get(value, "cost")) || Reflect.get(value, "cost") < 0)) ||
    (Reflect.get(value, "costProvenance") !== undefined && !["recorded", "current_catalog"].includes(Reflect.get(value, "costProvenance")))) return undefined
  return value as UsageSummary
}

function readUsageReport(value: unknown, group: UsageReportInput["group"]): UsageReport | undefined {
  if (typeof value !== "object" || value === null || Reflect.get(value, "group") !== group || !Array.isArray(Reflect.get(value, "rows")) ||
    !Number.isInteger(Reflect.get(value, "rowCount")) || Reflect.get(value, "rowCount") < 0 ||
    (Reflect.get(value, "nextOffset") !== undefined && (!Number.isInteger(Reflect.get(value, "nextOffset")) || Reflect.get(value, "nextOffset") < 0)) ||
    readUsageMetrics(Reflect.get(value, "total")) === undefined) return undefined
  const rows: unknown[] = Reflect.get(value, "rows")
  if (!rows.every((row) => typeof row === "object" && row !== null && typeof Reflect.get(row, "key") === "string" &&
    typeof Reflect.get(row, "label") === "string" && readUsageMetrics(row) !== undefined &&
    ((Reflect.get(row, "cost") === undefined) === (Reflect.get(row, "costProvenance") === undefined)))) return undefined
  return value as UsageReport
}

export function readWorkspaces(payload: unknown): readonly RemoteWorkspaceInfo[] | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const data = Reflect.get(payload, "data")
  if (!Array.isArray(data)) return undefined
  const workspaces = data.flatMap((value: unknown) => {
    if (typeof value !== "object" || value === null) return []
    const id = Reflect.get(value, "id")
    const projectID = Reflect.get(value, "projectID")
    const directory = Reflect.get(value, "directory")
    const name = Reflect.get(value, "name")
    const workspaceID = Reflect.get(value, "workspaceID")
    if (typeof id !== "string" || id.length === 0 || typeof projectID !== "string" || projectID.length === 0 || typeof directory !== "string" || directory.length === 0 || (name !== undefined && typeof name !== "string") || (workspaceID !== undefined && typeof workspaceID !== "string")) return []
    return [{ id, projectID, directory, ...(workspaceID === undefined ? {} : { workspaceID }), ...(name === undefined ? {} : { name }) }]
  })
  if (workspaces.length !== data.length || new Set(workspaces.map((workspace) => workspace.id)).size !== workspaces.length) return undefined
  return workspaces
}
