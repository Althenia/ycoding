import type { NativeDots } from "@ycoding-ai/core/dots/native"
import type { RemoteControlCredential } from "@ycoding-ai/core/remote-control/credential"
import { buildCcaHeaders, defaultTimeoutMs, loadCcaExperimentState, type CcaFetch } from "./cca-executor-registration"
import { accountHash } from "./state"

export const ccaComputerBaseURL = "https://chatgpt.com/backend-api"
export const ccaComputerCacheMs = 15_000
const dotPageLimit = 25
const maxDotPages = 40

export const ccaComputerProblems = [
  "configuration",
  "authentication",
  "enrollment",
  "dot-unavailable",
  "not-listed",
  "admin-disabled",
  "not-connectable",
  "rejected",
  "unconfirmed",
  "connection",
] as const

export type CcaComputerProblem = (typeof ccaComputerProblems)[number]

export interface CcaComputerStatus {
  readonly state: "attached" | "detached" | "unavailable"
  readonly problem?: CcaComputerProblem
}

export interface CcaComputerControl {
  readonly computer: () => Promise<CcaComputerStatus>
  readonly attach: () => Promise<CcaComputerStatus>
}

export interface CcaComputerControlDeps {
  readonly native: Pick<NativeDots.Host, "configuration" | "credential">
  readonly statePath: string
  readonly fetch?: CcaFetch
  readonly now?: () => number
  readonly onDiagnostic?: (message: string) => void
}

type EnabledConfiguration = Extract<NativeDots.Configuration, { readonly enabled: true }>
type Target = {
  readonly credential: RemoteControlCredential.Resolved
  readonly dotID: string
  readonly threadID: string
  readonly environmentID: string
}
type Observation = { readonly status: CcaComputerStatus; readonly target?: Target }

class Problem extends Error {
  constructor(readonly problem: CcaComputerProblem) {
    super(problem)
  }
}

const unavailable = (problem: CcaComputerProblem): CcaComputerStatus => ({ state: "unavailable", problem })

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Problem("connection")
  return value as Record<string, unknown>
}

function identity(value: unknown) {
  if (typeof value !== "string" || !value) throw new Problem("connection")
  return value
}

export function createCcaComputerControl(deps: CcaComputerControlDeps): CcaComputerControl {
  const fetchFn = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  let generation = 0
  let cache: { readonly key: string; readonly at: number; readonly status: CcaComputerStatus } | undefined
  let latestKey: string | undefined
  let refreshing: { readonly key: string; readonly generation: number; readonly promise: Promise<CcaComputerStatus> } | undefined
  let attaching: Promise<CcaComputerStatus> | undefined

  async function configuration(): Promise<EnabledConfiguration | undefined> {
    const current = await deps.native.configuration().catch(() => undefined)
    return current?.enabled ? current : undefined
  }

  async function credential(configuration: EnabledConfiguration) {
    const resolved = await deps.native.credential(configuration.profile).catch(() => undefined)
    if (
      resolved === undefined ||
      resolved.accountID !== configuration.accountID ||
      resolved.credentialID !== configuration.credentialID ||
      resolved.accountGeneration !== configuration.accountGeneration
    )
      throw new Problem("authentication")
    return resolved
  }

  async function executorID(accountID: string) {
    const state = await loadCcaExperimentState(deps.statePath).catch(() => {
      throw new Problem("enrollment")
    })
    const id = typeof state.executorID === "string" ? state.executorID.trim() : ""
    if (state.status !== "completed" || state.accountHash !== accountHash(accountID) || !id) throw new Problem("enrollment")
    return id
  }

  function send(method: "GET" | "POST", path: string, query: Record<string, string | undefined>, resolved: RemoteControlCredential.Resolved) {
    const search = new URLSearchParams()
    for (const [name, value] of Object.entries(query)) if (value !== undefined) search.set(name, value)
    const suffix = search.size ? `?${search}` : ""
    return fetchFn(`${ccaComputerBaseURL}${path}${suffix}`, {
      method,
      headers: buildCcaHeaders({ access: resolved.access, accountID: resolved.accountID }),
      redirect: "error",
      signal: AbortSignal.timeout(defaultTimeoutMs),
    })
  }

  async function get(path: string, query: Record<string, string | undefined>, resolved: RemoteControlCredential.Resolved) {
    const response = await send("GET", path, query, resolved).catch(() => {
      throw new Problem("connection")
    })
    if (response.status === 401 || response.status === 403) throw new Problem("authentication")
    if (!response.ok) throw new Problem("connection")
    return record(await response.json().catch(() => undefined))
  }

  async function dot(resolved: RemoteControlCredential.Resolved) {
    const active: string[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < maxDotPages; page++) {
      const body = await get("/tbo", { cursor, limit: String(dotPageLimit), include_room_preview: "false" }, resolved)
      if (!Array.isArray(body.items)) throw new Problem("connection")
      for (const item of body.items) {
        const fields = record(item)
        if (fields.status === "active") active.push(identity(fields.id))
      }
      if (body.cursor === undefined || body.cursor === null) {
        if (active.length === 1) return active[0]!
        if (active.length === 0) throw new Problem("dot-unavailable")
        const primary = await get("/tbo/primary", {}, resolved)
        const profile = primary.profile === undefined || primary.profile === null ? undefined : record(primary.profile)
        const id = profile === undefined ? undefined : identity(profile.id)
        if (id === undefined || !active.includes(id)) throw new Problem("dot-unavailable")
        return id
      }
      cursor = identity(body.cursor)
      if (cursors.has(cursor)) throw new Problem("connection")
      cursors.add(cursor)
    }
    throw new Problem("connection")
  }

  async function observe(configuration: EnabledConfiguration): Promise<Observation> {
    try {
      const resolved = await credential(configuration)
      const environmentID = await executorID(resolved.accountID)
      const dotID = await dot(resolved)
      const root = await get(`/tbo/${encodeURIComponent(dotID)}/root-thread`, {}, resolved)
      if (root.root_thread_id === undefined || root.root_thread_id === null) throw new Problem("dot-unavailable")
      const threadID = identity(root.root_thread_id)
      const list = await get(`/tbo/${encodeURIComponent(dotID)}/computers`, { expected_thread_id: threadID }, resolved)
      if (typeof list.thread_id !== "string") throw new Problem("connection")
      if (list.thread_id !== threadID) throw new Problem("dot-unavailable")
      if (!Array.isArray(list.computers)) throw new Problem("connection")
      const row = list.computers.map(record).find((item) => item.environment_id === environmentID)
      if (row === undefined) return { status: unavailable("not-listed") }
      if (row.is_attached === true) return { status: { state: "attached" } }
      if (list.local_computer_access_disabled_by_admin === true) return { status: { state: "detached", problem: "admin-disabled" } }
      if (row.can_connect !== true) return { status: { state: "detached", problem: "not-connectable" } }
      return { status: { state: "detached" }, target: { credential: resolved, dotID, threadID, environmentID } }
    } catch (error) {
      if (error instanceof Problem) return { status: unavailable(error.problem) }
      return { status: unavailable("connection") }
    }
  }

  async function connect(target: Target): Promise<"ok" | "rejected" | "uncertain"> {
    const path = `/tbo/${encodeURIComponent(target.dotID)}/computers/${encodeURIComponent(target.environmentID)}/connect-and-replace`
    const response = await send("POST", path, { expected_thread_id: target.threadID }, target.credential).catch(() => undefined)
    if (response === undefined) return "uncertain"
    await response.body?.cancel().catch(() => {})
    if (response.ok) return "ok"
    if (response.status === 408 || response.status === 429 || response.status >= 500) return "uncertain"
    return "rejected"
  }

  async function keyOf(current: EnabledConfiguration) {
    const executor = await loadCcaExperimentState(deps.statePath).then(
      (state) => (typeof state.executorID === "string" ? state.executorID.trim() : null),
      () => null,
    )
    return JSON.stringify([current, executor])
  }

  function store(key: string, status: CcaComputerStatus) {
    if (key !== latestKey) return status
    if (status.problem === "connection" && cache?.key === key) {
      cache = { ...cache, at: now() }
      deps.onDiagnostic?.("CCA computer refresh-failed problem=connection")
      return cache.status
    }
    cache = { key, at: now(), status }
    return status
  }

  function refresh(current: EnabledConfiguration, key: string) {
    if (refreshing?.key === key && refreshing.generation === generation) return refreshing.promise
    const started = generation
    const promise = observe(current).then(({ status }) => (started === generation ? store(key, status) : status))
    const entry = { key, generation: started, promise }
    refreshing = entry
    void promise.finally(() => {
      if (refreshing === entry) refreshing = undefined
    })
    return promise
  }

  async function computer() {
    const current = await configuration()
    if (current === undefined) return unavailable("configuration")
    const key = await keyOf(current)
    latestKey = key
    if (cache !== undefined && cache.key !== key) cache = undefined
    if (cache === undefined) return refresh(current, key)
    if (now() - cache.at >= ccaComputerCacheMs) void refresh(current, key)
    return cache.status
  }

  async function attachOnce(): Promise<CcaComputerStatus> {
    const current = await configuration()
    if (current === undefined) return unavailable("configuration")
    const key = await keyOf(current)
    latestKey = key
    generation++
    const before = await observe(current)
    if (before.target === undefined) {
      generation++
      store(key, before.status)
      return before.status
    }
    const outcome = await connect(before.target)
    const after = await observe(current)
    generation++
    store(key, after.status)
    if (after.status.state !== "detached" || after.status.problem !== undefined) return after.status
    return { state: "detached", problem: outcome === "rejected" ? "rejected" : "unconfirmed" }
  }

  return {
    computer,
    attach: () => {
      attaching ??= attachOnce().finally(() => {
        attaching = undefined
      })
      return attaching
    },
  }
}
