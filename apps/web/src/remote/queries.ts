import { QueryClient, queryOptions } from "@tanstack/solid-query"
import type {
  RemoteIncidentGuidance,
  RemoteIncidentGuidanceInput,
  RemoteIncidentRecent,
  RemoteIncidentRecentInput,
  RemoteIncidentReport,
  RemoteIncidentReportInput,
  RemoteOperation,
  RemoteWorkspaceInfo,
  RemoteUsageDashboard,
  RemoteUsageDashboardInput,
  RemoteUsageForecast,
  RemoteUsageMetrics,
  RemoteUsageTokens,
} from "@ycoding-ai/remote"
import { readCentralPolicy, readProject, readProjects, readSessionCandidates, type CentralPolicy, type ProjectBundle, type SessionCandidate } from "./coordination"
import { readUsageForecast } from "./usage-read"
import { keepAwakeAnswer, readKeepAwakeStatus, type KeepAwakeState } from "./keep-awake"
import { describeOutcome } from "./outcome"
import { readSnapshot } from "./projection"
import { readTeamChildren } from "./team-read"
import type { RemoteRequestOutcome, RemoteTransportRequest } from "./transport"
import { reportKey, reportNeedsNewerConnector, type UsageProvider, type UsageReport, type UsageReportInput, type UsageSummary } from "./ui/usage-model"

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
  usageForecast: (scope: QueryScope) => [...remoteKeys.usage(scope), "forecast", "backend"] as const,
  usageDashboard: (scope: QueryScope, input: DashboardInput) =>
    [...remoteKeys.usage(scope), "dashboard", ...dashboardSlots.flatMap((slot) => { const report = input[slot]; return report === undefined ? [] : [slot, reportKey(report)] })] as const,
  usageReport: (scope: QueryScope, input: UsageReportInput) => [...remoteKeys.usage(scope), "report", reportKey(input)] as const,
  incident: (scope: QueryScope) => [...remoteKeys.scope(scope), "incident"] as const,
  incidentReport: (scope: QueryScope, input: RemoteIncidentReportInput) =>
    [...remoteKeys.incident(scope), "report", JSON.stringify({ group: input.group, from: input.from, to: input.to, offset: input.offset, limit: input.limit })] as const,
  incidentRecent: (scope: QueryScope, input: RemoteIncidentRecentInput) =>
    [...remoteKeys.incident(scope), "recent", JSON.stringify({ provider: input.provider, model: input.model, agent: input.agent, limit: input.limit })] as const,
  incidentGuidanceModel: (scope: QueryScope, input: RemoteIncidentGuidanceInput) =>
    [...remoteKeys.incident(scope), "guidance", input.provider, input.model] as const,
  incidentGuidance: (scope: QueryScope, input: IncidentGuidanceQueryInput) =>
    [...remoteKeys.incidentGuidanceModel(scope, input), input.sessionID ?? ""] as const,
  keepAwake: (scope: QueryScope) => [...remoteKeys.scope(scope), "keepAwake"] as const,
  dots: (scope: QueryScope) => [...remoteKeys.scope(scope), "dots"] as const,
  workspaces: (scope: QueryScope) => [...remoteKeys.scope(scope), "workspaces"] as const,
  coordination: (scope: QueryScope) => [...remoteKeys.scope(scope), "coordination"] as const,
  projectCandidates: (scope: QueryScope, search: string) => [...remoteKeys.scope(scope), "project-candidates", search] as const,
  childSnapshot: (scope: QueryScope, sessionID: string, revision: number) => [...remoteKeys.scope(scope), "child-snapshot", sessionID, revision] as const,
  childTeam: (scope: QueryScope, familyID: string, parentID: string, cursor?: string) => [...remoteKeys.scope(scope), "child-team", familyID, parentID, cursor ?? ""] as const,
}

export type CoordinationOverview =
  | { readonly status: "ready"; readonly groups: readonly ProjectBundle[]; readonly central: CentralPolicy | undefined }
  | { readonly status: "unsupported" }
export type CoordinationOperation = "coordination.create" | "coordination.update" | "coordination.delete" | "coordination.attach" | "coordination.detach"
export type CoordinationFailure = { readonly reached: false; readonly message: string; readonly unconfirmed?: true }
export type CoordinationChange = { readonly reached: true } | CoordinationFailure

export type IncidentGuidanceQueryInput = RemoteIncidentGuidanceInput & { readonly sessionID?: string }

type DashboardInput = RemoteUsageDashboardInput
const dashboardSlots = ["daily", "monthly", "breakdown"] as const
const dashboardPollMs = 1_000
const liveDashboardPollMs = 2_000

export function dashboardPollInterval(data: RemoteUsageDashboard): number | false {
  if (data.status === "preparing" || data.status === "ready" && data.quota.status === "preparing") return dashboardPollMs
  return data.status === "ready" && data.live.active > 0 ? liveDashboardPollMs : false
}

export const dashboardSettled = (data: RemoteUsageDashboard) => data.status === "ready" && data.quota.status !== "preparing" && data.live.active === 0

export const dashboardSuperseded = (previous: RemoteUsageDashboard, next: RemoteUsageDashboard) =>
  previous.status === "ready" && next.status === "ready" && next.asOf < previous.asOf

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
    readonly settled?: (data: T) => boolean
    readonly poll?: (data: T) => number | false
    readonly superseded?: (previous: T, next: T) => boolean
  }) => {
    const scope = input.scope ?? idleScope
    const queryKey = input.key(scope)
    const settled = input.settled
    const poll = input.poll
    return queryOptions({
      queryKey,
      enabled: input.scope !== undefined && input.enabled,
      staleTime: settled === undefined ? 60_000 : (query: { readonly state: { readonly data: UsageResult<T> | undefined } }) =>
        query.state.data?.status === "ready" && !settled(query.state.data.data) ? 0 : 60_000,
      refetchInterval: poll === undefined ? undefined : (query: { readonly state: { readonly status: string; readonly data: UsageResult<T> | undefined } }) =>
        query.state.status === "success" && query.state.data?.status === "ready" ? poll(query.state.data.data) : false,
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
        if (data !== undefined) {
          const previous = client.getQueryData<UsageResult<T>>(queryKey)
          if (!refresh && previous?.status === "ready" && input.superseded?.(previous.data, data) === true) return previous
          return { status: "ready", data }
        }
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

  const usageForecast = (scope: QueryScope | undefined, enabled: boolean) => usageQuery<RemoteUsageForecast>({
    scope, enabled, key: remoteKeys.usageForecast, operation: "usage.forecast", request: () => ({ input: { localScope: "backend" } }),
    read: readUsageForecast, unsupported: unknownOperation, label: "Usage forecast", unreadable: "The device returned an unreadable usage forecast.",
  })

  const usageReport = (scope: QueryScope | undefined, enabled: boolean, report: UsageReportInput) => usageQuery<UsageReport>({
    scope, enabled: enabled && (report.limit === undefined || Number.isInteger(report.limit) && report.limit >= 1 && report.limit <= 200),
    key: (current) => remoteKeys.usageReport(current, report), operation: "usage.report", request: () => ({ input: report }),
    read: (raw) => readUsageReport(raw, report.group),
    unsupported: (outcome) => outcome.status === "failed" && (outcome.error.code === "unknown_operation" || reportNeedsNewerConnector(report) && outcome.error.code === "invalid_message"),
    label: "Usage report", unreadable: "The device returned an unreadable usage report.",
  })

  const usageDashboard = (scope: QueryScope | undefined, enabled: boolean, dashboard: DashboardInput) => usageQuery<RemoteUsageDashboard>({
    scope, enabled: enabled && dashboardSlots.every((slot) => {
      const limit = dashboard[slot]?.limit
      return limit === undefined || Number.isInteger(limit) && limit >= 1 && limit <= 200
    }),
    key: (current) => remoteKeys.usageDashboard(current, dashboard), operation: "usage.dashboard",
    request: (refresh) => ({ input: { ...Object.fromEntries(dashboardSlots.flatMap((slot) => dashboard[slot] === undefined ? [] : [[slot, dashboard[slot]]])), ...(refresh ? { refresh: true } : {}) } }),
    read: (raw) => readUsageDashboard(raw, dashboard), settled: dashboardSettled,
    poll: dashboardPollInterval, superseded: dashboardSuperseded,
    unsupported: unknownOperation, label: "Usage", unreadable: "The device returned unreadable usage data.",
  })

  const incidentReport = (scope: QueryScope | undefined, enabled: boolean, input: RemoteIncidentReportInput) => usageQuery<RemoteIncidentReport["data"]>({
    scope, enabled: enabled && validIncidentReport(input), key: (current) => remoteKeys.incidentReport(current, input),
    operation: "incident.report", request: () => ({ input: reportInput(input) }),
    read: (raw) => readIncidentReport(raw, input.group), unsupported: unknownOperation,
    label: "Incident report", unreadable: "The device returned an unreadable incident report.",
  })

  const incidentRecent = (scope: QueryScope | undefined, enabled: boolean, input: RemoteIncidentRecentInput) => usageQuery<RemoteIncidentRecent["data"]>({
    scope, enabled: enabled && validIncidentRecent(input), key: (current) => remoteKeys.incidentRecent(current, input),
    operation: "incident.recent", request: () => ({ input: recentInput(input) }),
    read: readIncidentRecent, unsupported: unknownOperation,
    label: "Recent incidents", unreadable: "The device returned unreadable incident data.",
  })

  const incidentGuidance = (scope: QueryScope | undefined, enabled: boolean, input: IncidentGuidanceQueryInput) => usageQuery<RemoteIncidentGuidance["data"]>({
    scope, enabled: enabled && validModelPair(input) && (input.sessionID === undefined || input.sessionID.length > 0),
    key: (current) => remoteKeys.incidentGuidance(current, input),
    operation: "incident.guidance", request: () => guidanceRequest(input),
    read: readIncidentGuidance, unsupported: unknownOperation,
    label: "Model guidance", unreadable: "The device returned unreadable model guidance.",
  })

  const clearIncidentGuidance = async (scope: QueryScope, input: IncidentGuidanceQueryInput): Promise<RemoteIncidentGuidance["data"]> => {
    const outcome = await link.request(scope, "incident.guidance.clear", guidanceRequest(input))
    if (outcome.status !== "ok") throw new Error(describeOutcome(outcome, "Clear model guidance"))
    const guidance = readIncidentGuidance(typeof outcome.value === "object" && outcome.value !== null ? Reflect.get(outcome.value, "data") : undefined)
    if (guidance === undefined) throw new Error("The device returned unreadable model guidance.")
    await client.invalidateQueries({ queryKey: remoteKeys.incidentGuidanceModel(scope, input) }, { cancelRefetch: false })
    return guidance
  }

  /** Explicit refresh or retry: the next read of each key sends any refresh flag, skips an exhausted error, and replaces a read in flight. */
  const refetchFresh = async (keys: readonly (readonly unknown[])[]) => {
    keys.forEach((key) => refreshing.add(JSON.stringify(key)))
    await Promise.all(keys.map((queryKey) => client.refetchQueries({ queryKey, type: "all" })))
  }

  const refreshUsage = async (scope: QueryScope) => {
    await Promise.all([
      refetchFresh([remoteKeys.usageSummary(scope), remoteKeys.usageForecast(scope)]),
      refetchFresh([remoteKeys.usageProviders(scope)]).then(() => refetchFresh([remoteKeys.usageForecast(scope)])),
    ])
  }

  const refreshUsageDashboard = (scope: QueryScope, input: DashboardInput) => refetchFresh([remoteKeys.usageDashboard(scope, input)])

  const retryUsageReport = (scope: QueryScope, input: UsageReportInput) => refetchFresh([remoteKeys.usageReport(scope, input)])
  const retryIncidentReport = (scope: QueryScope, input: RemoteIncidentReportInput) => refetchFresh([remoteKeys.incidentReport(scope, input)])
  const retryIncidentRecent = (scope: QueryScope, input: RemoteIncidentRecentInput) => refetchFresh([remoteKeys.incidentRecent(scope, input)])
  const retryIncidentGuidance = (scope: QueryScope, input: IncidentGuidanceQueryInput) => refetchFresh([remoteKeys.incidentGuidance(scope, input)])

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
          const heldByDefer = !enabled && answered.state === "on" && answered.deferHold === true
          const reached = answered.manual === undefined
            ? heldByDefer || answered.state === (enabled ? "on" : "off")
            : answered.manual === enabled
          const mismatch = (answered.state === "on" || answered.state === "off") && !reached
          write({
            read: "ready",
            status: answered,
            ...(mismatch
              ? {
                  change: {
                    state: "failed" as const,
                    enabled,
                  message: answered.manual === undefined
                    ? `The machine reports it is ${answered.state === "on" ? "On" : "Off"}.`
                    : `The machine reports its manual preference is ${answered.manual ? "On" : "Off"}.`,
                  },
                }
              : {}),
          })
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

  const toggleKeepAwake = async (scope: QueryScope): Promise<{ readonly reached: boolean; readonly message?: string }> => {
    const state = await client.fetchQuery(keepAwake(scope, true))
    if (state.read === "outdated") return { reached: false, message: "Update YCoding on this machine to keep it awake from here." }
    if (state.read !== "ready" || state.status === undefined) return { reached: false, message: state.message ?? "Keep machine awake could not be read." }
    if (state.status.state === "unsupported") return { reached: false, message: state.status.message ?? "This machine cannot be kept awake from YCoding." }
    const mutation = keepAwakeMutation(scope)
    const result = await mutation.mutationFn(!(state.status.manual ?? state.status.state === "on"))
    await mutation.onSettled(result)
    return { reached: result.reached }
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

  const coordination = (scope: QueryScope | undefined, enabled: boolean) => {
    const current = scope ?? idleScope
    const unreadable = new Error("The device returned an unreadable project answer.")
    return queryOptions({
      queryKey: remoteKeys.coordination(current),
      enabled: scope !== undefined && enabled,
      staleTime: 15_000,
      refetchOnMount: "always",
      refetchInterval: 5_000,
      retry: false,
      queryFn: async (): Promise<CoordinationOverview> => {
        const listed = await link.request(current, "coordination.list", { timeoutMs: 10_000 })
        if (unknownOperation(listed)) return { status: "unsupported" }
        if (listed.status !== "ok") throw new Error(describeOutcome(listed, "Projects"))
        const summaries = readProjects(listed.value)
        if (summaries === undefined) throw unreadable
        const groups: ProjectBundle[] = []
        for (let start = 0; start < summaries.length; start += 3) {
          groups.push(...await Promise.all(summaries.slice(start, start + 3).map(async (summary) => {
            const outcome = await link.request(current, "coordination.get", { input: { groupID: summary.id }, timeoutMs: 10_000 })
            if (outcome.status !== "ok") throw new Error(describeOutcome(outcome, "Projects"))
            const detail = readProject(outcome.value)
            if (detail === undefined) throw unreadable
            return { summary, detail }
          })))
        }
        const settings = await link.request(current, "coordination.settings", { timeoutMs: 10_000 })
        return { status: "ready", groups, central: settings.status === "ok" ? readCentralPolicy(settings.value) : undefined }
      },
    })
  }

  const refreshCoordination = (scope: QueryScope) => refetchFresh([remoteKeys.coordination(scope)])

  const settleCoordination = async (scope: QueryScope, outcome: RemoteRequestOutcome): Promise<CoordinationChange> => {
    const reread = () => client.refetchQueries({ queryKey: remoteKeys.coordination(scope), type: "all" }).catch(() => undefined)
    if (outcome.status === "ok") {
      await reread()
      return { reached: true }
    }
    if (unknownOperation(outcome)) return { reached: false, message: "Update YCoding on this machine to manage Projects from here." }
    if (outcome.status === "unknown") {
      await reread()
      return { reached: false, unconfirmed: true, message: `${describeOutcome(outcome, "Projects")}. The result is unconfirmed and was not sent again; the list below shows what the machine reports now.` }
    }
    if (outcome.status === "failed") await reread()
    return { reached: false, message: describeOutcome(outcome, "Projects") }
  }

  const changeCoordination = async (scope: QueryScope, operation: CoordinationOperation, input: Readonly<Record<string, unknown>>): Promise<CoordinationChange> =>
    settleCoordination(scope, await link.request(scope, operation, { input }))

  const deleteProjectSession = async (scope: QueryScope, sessionID: string): Promise<CoordinationChange> =>
    settleCoordination(scope, await link.request(scope, "session.delete", { sessionID }))

  const createProjectSession = async (scope: QueryScope, target: { readonly workspace: string } | { readonly directory: string }, id = `ses_${crypto.randomUUID().replaceAll("-", "")}`, title?: string): Promise<{ readonly reached: true; readonly sessionID: string } | CoordinationFailure> => {
    const outcome = await link.request(scope, "session.create", { input: { id, ...target, ...(title === undefined ? {} : { title }) } })
    if (outcome.status === "ok") {
      const data = typeof outcome.value === "object" && outcome.value !== null ? Reflect.get(outcome.value, "data") : undefined
      const echoed = typeof data === "object" && data !== null ? Reflect.get(data, "id") : undefined
      return echoed === id ? { reached: true, sessionID: id } : { reached: false, message: "The device returned a different Session than the one requested. Check Sessions before trying again." }
    }
    if (outcome.status === "unknown") return { reached: false, unconfirmed: true, message: `${describeOutcome(outcome, "Session creation")}. The Session may already exist; it was not created again.` }
    return { reached: false, message: describeOutcome(outcome, "Session creation") }
  }

  const projectCandidates = (scope: QueryScope | undefined, enabled: boolean, search: string) => {
    const current = scope ?? idleScope
    const needle = search.trim()
    return queryOptions({
      queryKey: remoteKeys.projectCandidates(current, needle),
      enabled: scope !== undefined && enabled,
      staleTime: 10_000,
      retry: false,
      queryFn: async (): Promise<readonly SessionCandidate[]> => {
        const outcome = await link.request(current, "session.list", { input: { limit: 25, order: "active", parentID: null, background: "exclude", searchFields: "summary", ...(needle === "" ? {} : { search: needle }) }, timeoutMs: 10_000 })
        if (outcome.status !== "ok") throw new Error(describeOutcome(outcome, "Sessions"))
        return readSessionCandidates(outcome.value)
      },
    })
  }

  const childSnapshot = (scope: QueryScope | undefined, enabled: boolean, sessionID: string, revision: number) => {
    const current = scope ?? idleScope
    return queryOptions({
      queryKey: remoteKeys.childSnapshot(current, sessionID, revision),
      enabled: scope !== undefined && enabled && sessionID.length > 0,
      staleTime: Infinity,
      retry: false,
      queryFn: async () => {
        const outcome = await link.request(current, "session.snapshot", { sessionID, input: { limit: 40 } })
        if (outcome.status !== "ok") throw new Error(describeOutcome(outcome, "Child conversation"))
        const snapshot = readSnapshot(outcome.value)
        if (snapshot?.sessionID !== sessionID || snapshot.watermarkSessionID !== undefined && snapshot.watermarkSessionID !== sessionID) throw new Error("The device returned a different or unreadable child conversation.")
        return snapshot
      },
    })
  }

  const childTeam = (scope: QueryScope | undefined, enabled: boolean, familyID: string, parentID: string, cursor?: string) => {
    const current = scope ?? idleScope
    return queryOptions({
      queryKey: remoteKeys.childTeam(current, familyID, parentID, cursor),
      enabled: scope !== undefined && enabled && parentID.length > 0,
      staleTime: 15_000,
      retry: false,
      queryFn: async () => {
        const outcome = await link.request(current, "session.subagent.list", { sessionID: parentID, ...(cursor === undefined ? {} : { input: { cursor } }) })
        if (outcome.status !== "ok") throw new Error(describeOutcome(outcome, "Child subagents"))
        const page = readTeamChildren(outcome.value, parentID)
        if (!page || page.next !== undefined && page.next === cursor || page.tasks.some(task => task.sessionID === familyID)) throw new Error("The device returned an unreadable or unrelated child list.")
        return page
      },
    })
  }

  return {
    coordination, refreshCoordination, changeCoordination, deleteProjectSession, createProjectSession, projectCandidates, childSnapshot, childTeam,
    usageProviders, usageSummary, usageForecast, usageReport, usageDashboard, refreshUsage, refreshUsageDashboard, retryUsageReport,
    incidentReport, incidentRecent, incidentGuidance, clearIncidentGuidance, retryIncidentReport, retryIncidentRecent, retryIncidentGuidance,
    keepAwake, keepAwakeMutation, toggleKeepAwake, workspaces,
  }
}

export type RemoteQueries = ReturnType<typeof createRemoteQueries>

const integerIn = (value: unknown, minimum: number, maximum: number) =>
  value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum)
const name = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const validModelPair = (input: RemoteIncidentGuidanceInput) => name(input.provider) && name(input.model)

const validIncidentReport = (input: RemoteIncidentReportInput) =>
  (input.group === "model" || input.group === "agent") && integerIn(input.from, 0, Number.MAX_SAFE_INTEGER) && integerIn(input.to, 0, Number.MAX_SAFE_INTEGER) &&
  integerIn(input.offset, 0, Number.MAX_SAFE_INTEGER) && integerIn(input.limit, 1, 200) &&
  (input.from === undefined || input.to === undefined || input.from <= input.to)

const validIncidentRecent = (input: RemoteIncidentRecentInput) =>
  validModelPair(input) && (input.agent === undefined || name(input.agent)) && integerIn(input.limit, 1, 50)

const reportInput = (input: RemoteIncidentReportInput): RemoteIncidentReportInput => ({
  group: input.group,
  ...(input.from === undefined ? {} : { from: input.from }),
  ...(input.to === undefined ? {} : { to: input.to }),
  ...(input.offset === undefined ? {} : { offset: input.offset }),
  ...(input.limit === undefined ? {} : { limit: input.limit }),
})

const recentInput = (input: RemoteIncidentRecentInput): RemoteIncidentRecentInput => ({
  provider: input.provider,
  model: input.model,
  ...(input.agent === undefined ? {} : { agent: input.agent }),
  ...(input.limit === undefined ? {} : { limit: input.limit }),
})

const guidanceRequest = (input: IncidentGuidanceQueryInput): RemoteTransportRequest => ({
  input: { provider: input.provider, model: input.model },
  ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
})

export function readIncidentReport(value: unknown, group: RemoteIncidentReportInput["group"]): RemoteIncidentReport["data"] | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const raw: unknown = Reflect.get(value, "rows")
  const groups: unknown = Reflect.get(value, "groups")
  if (!Array.isArray(raw) || !count(groups)) return undefined
  const rows = raw.flatMap((row: unknown) => {
    if (typeof row !== "object" || row === null) return []
    const agent = Reflect.get(row, "agent")
    const providerID = Reflect.get(row, "providerID")
    const modelID = Reflect.get(row, "modelID")
    const fallbacks = Reflect.get(row, "fallbacks")
    const escalated = Reflect.get(row, "escalated")
    const rejected = Reflect.get(row, "rejected")
    const last = Reflect.get(row, "last")
    if (!name(providerID) || !name(modelID) || (group === "agent") !== (agent !== undefined) || (agent !== undefined && !name(agent)) ||
      !count(fallbacks) || !count(escalated) || !count(rejected) || !count(last)) return []
    return [{ providerID, modelID, ...(agent === undefined ? {} : { agent }), fallbacks, escalated, rejected, last }]
  })
  if (rows.length !== raw.length || rows.length > groups) return undefined
  return { rows, groups }
}

const incidentKinds = ["fallback", "guardrail-escalated", "guardrail-rejected"] as const

function readModelRef(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined
  const id = Reflect.get(value, "id")
  const providerID = Reflect.get(value, "providerID")
  const variant = Reflect.get(value, "variant")
  const profile = Reflect.get(value, "profile")
  if (!name(id) || !name(providerID) || (variant !== undefined && !name(variant)) || (profile !== undefined && !name(profile))) return undefined
  return { id, providerID, ...(variant === undefined ? {} : { variant }), ...(profile === undefined ? {} : { profile }) }
}

export function readIncidentRecent(value: unknown): RemoteIncidentRecent["data"] | undefined {
  const items = typeof value === "object" && value !== null ? Reflect.get(value, "items") : undefined
  if (!Array.isArray(items)) return undefined
  const read = items.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return []
    const id = Reflect.get(item, "id")
    const time = Reflect.get(item, "time")
    const kind = Reflect.get(item, "kind")
    const category = Reflect.get(item, "category")
    const ruleIDs = Reflect.get(item, "ruleIDs")
    const agent = Reflect.get(item, "agent")
    const variant = Reflect.get(item, "variant")
    const profile = Reflect.get(item, "profile")
    const decidedBy = Reflect.get(item, "decidedBy")
    const target = Reflect.get(item, "target") === undefined ? undefined : readModelRef(Reflect.get(item, "target"))
    if (!name(id) || !count(time) || !incidentKinds.includes(kind) || typeof category !== "string" || category.length > 128 ||
      !Array.isArray(ruleIDs) || !ruleIDs.every((rule) => typeof rule === "string" && rule.length <= 128) || !name(agent) ||
      (variant !== undefined && !name(variant)) || (profile !== undefined && !name(profile)) ||
      (decidedBy !== undefined && decidedBy !== "decision-model" && decidedBy !== "client") ||
      (Reflect.get(item, "target") !== undefined && target === undefined)) return []
    return [{ id, time, kind, category, ruleIDs: [...ruleIDs], agent,
      ...(variant === undefined ? {} : { variant }), ...(profile === undefined ? {} : { profile }),
      ...(target === undefined ? {} : { target }), ...(decidedBy === undefined ? {} : { decidedBy }) }]
  })
  return read.length === items.length ? { items: read } : undefined
}

export function readIncidentGuidance(value: unknown): RemoteIncidentGuidance["data"] | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const enabled = Reflect.get(value, "enabled")
  const text = Reflect.get(value, "text")
  const clearedAt = Reflect.get(value, "clearedAt")
  if (typeof enabled !== "boolean" || (text !== undefined && (typeof text !== "string" || text.length > 4_096)) || (clearedAt !== undefined && !count(clearedAt))) return undefined
  return { enabled, ...(text === undefined ? {} : { text }), ...(clearedAt === undefined ? {} : { clearedAt }) }
}

function readUsageProviders(value: unknown): readonly UsageProvider[] | undefined {
  return Array.isArray(value) && value.every(validUsageProvider) ? value : undefined
}

const usageRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const usageNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const usageAmount = (value: unknown): value is number => usageNumber(value) && value >= 0
const usageLiteral = <const T extends string>(value: unknown, values: readonly T[]): value is T => values.some((literal) => literal === value)

function validUsageProvider(value: unknown): value is UsageProvider {
  return usageRecord(value) && typeof value.providerID === "string" && typeof value.label === "string" &&
    usageLiteral(value.status, ["available", "stale", "unsupported", "unauthorized", "error"]) &&
    usageLiteral(value.source, ["provider_api", "local_client_rpc", "response_headers", "response_stream", "provider_internal_api", "local_session"]) &&
    usageLiteral(value.stability, ["stable", "client_contract", "observed", "best_effort"]) &&
    usageNumber(value.updatedAt) && !Number.isNaN(new Date(value.updatedAt).getTime()) &&
    (value.profile === undefined || typeof value.profile === "string") && (value.message === undefined || typeof value.message === "string") &&
    Array.isArray(value.windows) && value.windows.every((window: unknown) => usageRecord(window) &&
      typeof window.id === "string" && typeof window.label === "string" && (window.group === undefined || typeof window.group === "string" && window.group !== "") &&
      usageLiteral(window.unit, ["percent", "usd", "requests", "tokens", "count"]) &&
      [window.used, window.limit, window.remaining, window.resetAt, window.periodSeconds].every((amount) => amount === undefined || usageAmount(amount)) &&
      (window.unlimited === undefined || typeof window.unlimited === "boolean"))
}

function validOutcomes(value: unknown) {
  return value === undefined || typeof value === "object" && value !== null && ["completed", "failed", "cancelled"].every((key) => count(Reflect.get(value, key)))
}

const speedAmounts = ["generationP50TokensPerSecond", "generationP90TokensPerSecond", "generationP95TokensPerSecond", "meanTokensPerSecond", "firstOutputP50Ms", "firstOutputP95Ms", "firstOutputP99Ms", "totalP50Ms", "totalP95Ms", "totalP99Ms", "outputTokensPerSecond"]

function validSpeed(speed: unknown): speed is UsageReport["speed"] {
  return speed === undefined || usageRecord(speed) &&
    ["generationSamples", "providerTimedSamples", "observedSamples", "samples"].every((key) => count(speed[key])) &&
    speedAmounts.every((key) => speed[key] === undefined || usageAmount(speed[key]))
}

function readUsageMetrics(value: unknown): UsageSummary | undefined {
  return validUsageSummary(value) ? value : undefined
}

function validUsageTokens(value: unknown): value is RemoteUsageTokens {
  return usageRecord(value) && [value.input, value.output, value.reasoning].every(usageNumber) &&
    usageRecord(value.cache) && [value.cache.read, value.cache.write].every(usageNumber)
}

function validUsageMetrics(value: unknown): value is RemoteUsageMetrics & Record<string, unknown> {
  return usageRecord(value) && [value.logical, value.physical, value.helpers, value.continued, value.fallback].every(usageAmount) &&
    validUsageTokens(value.tokens) && (value.cost === undefined || usageAmount(value.cost)) &&
    (value.costProvenance === undefined || usageLiteral(value.costProvenance, ["recorded", "current_catalog"])) &&
    (value.cacheReadReported === undefined || typeof value.cacheReadReported === "boolean") && validOutcomes(value.outcomes) &&
    (value.costCoverage === undefined || usageRecord(value.costCoverage) && count(value.costCoverage.pricedRequests) && count(value.costCoverage.unpricedRequests))
}

function validUsageModel(value: unknown): value is NonNullable<UsageSummary["models"]>[number]["model"] & Record<string, unknown> {
  return usageRecord(value) && typeof value.providerID === "string" && typeof value.id === "string" &&
    (value.variant === undefined || typeof value.variant === "string")
}

function validUsageSummary(value: unknown): value is UsageSummary {
  return usageRecord(value) && validUsageMetrics(value) &&
    (value.latestInvalidation === undefined || typeof value.latestInvalidation === "string") &&
    (value.latestNamespace === undefined || typeof value.latestNamespace === "string") &&
    (value.latestTiming === undefined || usageRecord(value.latestTiming) &&
      [value.latestTiming.promptEvalDurationNs, value.latestTiming.generationDurationNs, value.latestTiming.loadDurationNs].every((amount) => amount === undefined || usageNumber(amount))) &&
    (value.models === undefined || Array.isArray(value.models) && value.models.every((model: unknown) => usageRecord(model) &&
      validUsageModel(model.model) && count(model.requests) && validUsageTokens(model.tokens) &&
      (model.cacheReadReported === undefined || typeof model.cacheReadReported === "boolean") &&
      (model.cost === undefined || usageAmount(model.cost)) &&
      (model.costProvenance === undefined || usageLiteral(model.costProvenance, ["recorded", "current_catalog"])) &&
      (model.cost === undefined) === (model.costProvenance === undefined)))
}

function readUsageDashboard(value: unknown, input: DashboardInput): RemoteUsageDashboard | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const status = Reflect.get(value, "status")
  if (status === "preparing") return { status }
  if (status === "error") {
    const message = Reflect.get(value, "message")
    return typeof message === "string" ? { status, message } : undefined
  }
  const asOf = Reflect.get(value, "asOf")
  const revision = Reflect.get(value, "revision")
  if (status !== "ready" || !count(asOf) || typeof revision !== "string") return undefined
  const summary = readUsageMetrics(Reflect.get(value, "summary"))
  const quota = readDashboardQuota(Reflect.get(value, "quota"))
  const live = readDashboardLive(Reflect.get(value, "live"))
  if (summary === undefined || quota === undefined || live === undefined) return undefined
  const reports: Partial<Record<(typeof dashboardSlots)[number], UsageReport>> = {}
  for (const slot of dashboardSlots) {
    const raw = Reflect.get(value, slot)
    const requested = input[slot]
    if (requested === undefined) {
      if (raw !== undefined) return undefined
      continue
    }
    const report = readUsageReport(raw, requested.group)
    if (report === undefined) return undefined
    reports[slot] = report
  }
  return { status, asOf, revision, summary, quota, live, ...reports }
}

const liveRate = (value: unknown) => value === undefined || typeof value === "number" && Number.isFinite(value) && value >= 0

function readDashboardLive(value: unknown): Extract<RemoteUsageDashboard, { readonly status: "ready" }>["live"] | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const asOf = Reflect.get(value, "asOf")
  const active = Reflect.get(value, "active")
  const streaming = Reflect.get(value, "streaming")
  const rate = Reflect.get(value, "outputTokensPerSecond")
  const models = Reflect.get(value, "models")
  const history = Reflect.get(value, "history")
  if (!count(asOf) || !count(active) || !count(streaming) || !liveRate(rate) || !Array.isArray(models) || models.length > 50 || !Array.isArray(history) || history.length > 120) return undefined
  const readModels = models.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return []
    const model = readModelRef(Reflect.get(entry, "model"))
    const modelActive = Reflect.get(entry, "active")
    const modelStreaming = Reflect.get(entry, "streaming")
    const modelRate = Reflect.get(entry, "outputTokensPerSecond")
    if (model === undefined || !count(modelActive) || !count(modelStreaming) || !liveRate(modelRate)) return []
    return [{ model, active: modelActive, streaming: modelStreaming, ...(modelRate === undefined ? {} : { outputTokensPerSecond: modelRate }) }]
  })
  const readHistory = history.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return []
    const at = Reflect.get(entry, "at")
    const pointActive = Reflect.get(entry, "active")
    const pointRate = Reflect.get(entry, "outputTokensPerSecond")
    if (!count(at) || !count(pointActive) || !liveRate(pointRate)) return []
    return [{ at, active: pointActive, ...(pointRate === undefined ? {} : { outputTokensPerSecond: pointRate }) }]
  })
  if (readModels.length !== models.length || readHistory.length !== history.length) return undefined
  return { asOf, active, streaming, ...(rate === undefined ? {} : { outputTokensPerSecond: rate }), models: readModels, history: readHistory }
}

function readDashboardQuota(value: unknown): Extract<RemoteUsageDashboard, { readonly status: "ready" }>["quota"] | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const status = Reflect.get(value, "status")
  if (status === "preparing") return { status }
  if (status === "error") {
    const message = Reflect.get(value, "message")
    return typeof message === "string" ? { status, message } : undefined
  }
  if (status !== "ready") return undefined
  const providers = readUsageProviders(Reflect.get(value, "providers"))
  const forecast = readUsageForecast(Reflect.get(value, "forecast"))
  return providers === undefined || forecast === undefined ? undefined : { status, providers, forecast }
}

export function readUsageReport(value: unknown, group: UsageReportInput["group"]): UsageReport | undefined {
  return validUsageReport(value, group) ? value : undefined
}

function validUsageReport(value: unknown, group: UsageReportInput["group"]): value is UsageReport {
  if (!usageRecord(value) || value.group !== group || !Array.isArray(value.rows) ||
    !Number.isInteger(value.rowCount) || !usageAmount(value.rowCount) ||
    (value.nextOffset !== undefined && (!Number.isInteger(value.nextOffset) || !usageAmount(value.nextOffset))) ||
    !validUsageMetrics(value.total) || !validSpeed(value.speed)) return false
  const typed = ["provider", "provider-profile-model", "provider-model", "model-id", "profile", "prompt", "task"].includes(group)
  return value.rows.every((row: unknown) => usageRecord(row) && typeof row.key === "string" && typeof row.label === "string" &&
    validUsageMetrics(row) && (row.cost === undefined) === (row.costProvenance === undefined) &&
    validSpeed(row.speed) && (row.concurrency === undefined || usageAmount(row.concurrency)) &&
    (row.model === undefined || usageRecord(row.model) && validUsageModel(row.model) && (row.model.profile === undefined || typeof row.model.profile === "string")) &&
    (row.dimensions === undefined || validUsageDimensions(row.dimensions)) &&
    (!typed || row.model === undefined && usageRecord(row.dimensions) && row.dimensions.group === group))
}

function validUsageDimensions(value: unknown): value is NonNullable<UsageReport["rows"][number]["dimensions"]> {
  if (!usageRecord(value)) return false
  if (value.group === "provider") return typeof value.providerID === "string"
  if (value.group === "model-id") return typeof value.modelID === "string"
  if (value.group === "provider-model") return typeof value.providerID === "string" && typeof value.modelID === "string"
  if (value.group === "profile" || value.group === "provider-profile-model") return typeof value.providerID === "string" &&
    (value.group === "profile" || typeof value.modelID === "string") &&
    usageLiteral(value.profileState, ["recorded", "provider-default"]) &&
    (value.profile === undefined || typeof value.profile === "string") && (value.profileState === "recorded") === (typeof value.profile === "string")
  if (value.group === "prompt") return usageLiteral(value.attribution, ["complete", "partial", "unattributed"]) &&
    (value.anchor === undefined || usageRecord(value.anchor) && typeof value.anchor.sessionID === "string" && typeof value.anchor.inputID === "string")
  if (value.group === "task") return usageLiteral(value.attribution, ["complete", "partial", "unattributed"]) &&
    (value.sessionID === undefined || typeof value.sessionID === "string")
  return false
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
