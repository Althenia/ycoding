import type { NativeDots } from "@ycoding-ai/core/dots/native"
import type { Dots } from "@ycoding-ai/schema/dots"
import { createHash } from "node:crypto"
import { RemoteLimits } from "@ycoding-ai/remote"
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
  "target-changed",
] as const

export type CcaComputerProblem = (typeof ccaComputerProblems)[number]

export interface CcaComputerStatus {
  readonly state: "attached" | "detached" | "unavailable"
  readonly problem?: CcaComputerProblem
  readonly name?: string
  readonly target?: Dots.ComputerTarget
}

export interface CcaComputerControl {
  readonly computer: () => Promise<CcaComputerStatus>
  readonly attach: (expectedTarget?: Dots.ComputerTarget) => Promise<CcaComputerStatus>
}

export interface CcaComputerControlDeps {
  readonly native: Pick<NativeDots.Host, "configuration" | "credential">
  readonly statePath: string
  readonly fetch?: CcaFetch
  readonly now?: () => number
  readonly observeMs?: number
  readonly onDiagnostic?: (message: string) => void
}

type EnabledConfiguration = Extract<NativeDots.Configuration, { readonly enabled: true }>
type Target = {
  readonly credential: RemoteControlCredential.Resolved
  readonly dotID: string
  readonly threadID: string
  readonly environmentID: string
}
type Binding = { readonly key: string; readonly credential: RemoteControlCredential.Resolved; readonly environmentID: string }
type Observation = { readonly status: CcaComputerStatus; readonly target?: Target }

class Problem extends Error {
  constructor(readonly problem: CcaComputerProblem) {
    super(problem)
  }
}

const unavailable = (problem: CcaComputerProblem): CcaComputerStatus => ({ state: "unavailable", problem })
const sameTarget = (left: Dots.ComputerTarget | undefined, right: Dots.ComputerTarget | undefined) =>
  left?.dotID === right?.dotID && left?.threadID === right?.threadID && left?.environmentID === right?.environmentID && left?.revision === right?.revision

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
  const observeMs = deps.observeMs ?? RemoteLimits.dotsComputerObserveMs
  let generation = 0
  let cache: { readonly key: string; readonly at: number; readonly status: CcaComputerStatus } | undefined
  let latestKey: string | undefined
  let refreshing: { readonly key: string; readonly generation: number; readonly promise: Promise<CcaComputerStatus> } | undefined
  const attaching = new Map<string, Promise<CcaComputerStatus>>()

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

  async function enrollment(accountID: string) {
    const state = await loadCcaExperimentState(deps.statePath).catch(() => {
      throw new Problem("enrollment")
    })
    const id = typeof state.executorID === "string" ? state.executorID.trim() : ""
    if (state.status !== "completed" || state.accountHash !== accountHash(accountID) || !id) throw new Problem("enrollment")
    if (typeof state.installationID !== "string" || !state.installationID) throw new Problem("enrollment")
    return { executorID: id, installationID: state.installationID, accountHash: state.accountHash, status: state.status }
  }

  async function binding(): Promise<Binding> {
    const current = await configuration()
    if (!current) throw new Problem("configuration")
    const resolved = await credential(current)
    const enrolled = await enrollment(resolved.accountID)
    const latest = await configuration()
    if (JSON.stringify(latest) !== JSON.stringify(current)) throw new Problem("configuration")
    return { credential: resolved, environmentID: enrolled.executorID,
      key: JSON.stringify([current, enrolled]) }
  }

  async function validate(owner: Binding) {
    const latest = await binding()
    if (latest.key !== owner.key) throw new Problem("target-changed")
    return latest
  }

  function receipt(owner: Binding, target: Target): Dots.ComputerTarget {
    const tuple = { dotID: target.dotID, threadID: target.threadID, environmentID: target.environmentID }
    return { ...tuple, revision: createHash("sha256").update(JSON.stringify([owner.key, tuple])).digest("hex") }
  }

  function send(method: "GET" | "POST", path: string, query: Record<string, string | undefined>, resolved: RemoteControlCredential.Resolved, signal: AbortSignal) {
    const search = new URLSearchParams()
    for (const [name, value] of Object.entries(query)) if (value !== undefined) search.set(name, value)
    const suffix = search.size ? `?${search}` : ""
    return fetchFn(`${ccaComputerBaseURL}${path}${suffix}`, {
      method,
      headers: buildCcaHeaders({ access: resolved.access, accountID: resolved.accountID }),
      redirect: "error",
      signal,
    })
  }

  async function get(path: string, query: Record<string, string | undefined>, resolved: RemoteControlCredential.Resolved, deadline: AbortSignal) {
    const response = await send("GET", path, query, resolved, AbortSignal.any([AbortSignal.timeout(defaultTimeoutMs), deadline])).catch(() => {
      throw new Problem("connection")
    })
    if (response.status === 401 || response.status === 403) throw new Problem("authentication")
    if (!response.ok) throw new Problem("connection")
    return record(await response.json().catch(() => undefined))
  }

  async function dot(resolved: RemoteControlCredential.Resolved, deadline: AbortSignal) {
    const active: string[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < maxDotPages; page++) {
      const body = await get("/tbo", { cursor, limit: String(dotPageLimit), include_room_preview: "false" }, resolved, deadline)
      if (!Array.isArray(body.items)) throw new Problem("connection")
      for (const item of body.items) {
        const fields = record(item)
        if (fields.status === "active") active.push(identity(fields.id))
      }
      if (body.cursor === undefined || body.cursor === null) {
        if (active.length === 1) return active[0]!
        if (active.length === 0) throw new Problem("dot-unavailable")
        const primary = await get("/tbo/primary", {}, resolved, deadline)
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

  async function read(owner: Binding, deadline: AbortSignal): Promise<Observation> {
    try {
      const resolved = owner.credential
      const environmentID = owner.environmentID
      const dotID = await dot(resolved, deadline)
      const root = await get(`/tbo/${encodeURIComponent(dotID)}/root-thread`, {}, resolved, deadline)
      if (root.root_thread_id === undefined || root.root_thread_id === null) throw new Problem("dot-unavailable")
      const threadID = identity(root.root_thread_id)
      const list = await get(`/tbo/${encodeURIComponent(dotID)}/computers`, { expected_thread_id: threadID }, resolved, deadline)
      if (typeof list.thread_id !== "string") throw new Problem("connection")
      if (list.thread_id !== threadID) throw new Problem("dot-unavailable")
      if (!Array.isArray(list.computers)) throw new Problem("connection")
      const row = list.computers.map(record).find((item) => item.environment_id === environmentID)
      await validate(owner)
      if (row === undefined) return { status: unavailable("not-listed") }
      const target = { credential: resolved, dotID, threadID, environmentID }
      const name = typeof row.display_name === "string" ? row.display_name.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 256) : undefined
      const details = { target: receipt(owner, target), ...(name ? { name } : {}) }
      if (row.is_attached === true) return { status: { state: "attached", ...details } }
      if (list.local_computer_access_disabled_by_admin === true) return { status: { state: "detached", problem: "admin-disabled", ...details } }
      if (row.can_connect !== true) return { status: { state: "detached", problem: "not-connectable", ...details } }
      return { status: { state: "detached", ...details }, target }
    } catch (error) {
      if (error instanceof Problem) return { status: unavailable(error.problem) }
      return { status: unavailable("connection") }
    }
  }

  async function observe(owner: Binding): Promise<Observation> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<Observation>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve({ status: unavailable("connection") })
      }, observeMs)
    })
    try {
      return await Promise.race([read(owner, controller.signal), expired])
    } finally {
      clearTimeout(timer)
    }
  }

  async function connect(target: Target): Promise<"ok" | "rejected" | "uncertain"> {
    const path = `/tbo/${encodeURIComponent(target.dotID)}/computers/${encodeURIComponent(target.environmentID)}/connect-and-replace`
    const response = await send("POST", path, { expected_thread_id: target.threadID }, target.credential, AbortSignal.timeout(RemoteLimits.dotsConnectMs)).catch(() => undefined)
    if (response === undefined) return "uncertain"
    await response.body?.cancel().catch(() => {})
    if (response.ok) return "ok"
    if (response.status === 408 || response.status === 429 || response.status >= 500) return "uncertain"
    return "rejected"
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

  function refresh(owner: Binding, key: string) {
    if (refreshing?.key === key && refreshing.generation === generation) return refreshing.promise
    const started = generation
    const promise = observe(owner).then(({ status }) => (started === generation ? store(key, status) : status))
    const entry = { key, generation: started, promise }
    refreshing = entry
    void promise.finally(() => {
      if (refreshing === entry) refreshing = undefined
    })
    return promise
  }

  async function computer() {
    try {
      const current = await binding()
      const key = current.key
      latestKey = key
      if (cache !== undefined && cache.key !== key) cache = undefined
      if (cache === undefined) return refresh(current, key)
      if (now() - cache.at >= ccaComputerCacheMs) void refresh(current, key)
      return cache.status
    } catch (error) {
      cache = undefined
      return unavailable(error instanceof Problem ? error.problem : "connection")
    }
  }

  async function reconcile(owner: Binding, before: CcaComputerStatus, outcome: "ok" | "rejected" | "uncertain"): Promise<CcaComputerStatus> {
    const unresolved = () => unavailable(outcome === "rejected" ? "rejected" : "unconfirmed")
    try {
      const current = await validate(owner)
      const after = await observe(current)
      if (!sameTarget(after.status.target, before.target) || after.status.state === "unavailable") return unresolved()
      if (after.status.state === "attached") return after.status
      return { ...after.status, problem: outcome === "rejected" ? "rejected" : "unconfirmed" }
    } catch {
      return unresolved()
    }
  }

  async function attachOnce(owner: Binding, expectedTarget?: Dots.ComputerTarget): Promise<CcaComputerStatus> {
    const key = owner.key
    latestKey = key
    generation++
    const before = await observe(owner)
    if (expectedTarget && !sameTarget(expectedTarget, before.status.target)) return unavailable("target-changed")
    if (before.target === undefined) {
      generation++
      store(key, before.status)
      return before.status
    }
    const current = await validate(owner)
    const outcome = await connect({ ...before.target, credential: current.credential })
    const result = await reconcile(owner, before.status, outcome)
    generation++
    store(key, result)
    return result
  }

  return {
    computer,
    attach: async (expectedTarget) => {
      try {
        const owner = await binding()
        const key = JSON.stringify([owner.key, expectedTarget === undefined ? null : [expectedTarget.dotID, expectedTarget.threadID, expectedTarget.environmentID, expectedTarget.revision]])
        const existing = attaching.get(key)
        if (existing) return existing
        const pending = attachOnce(owner, expectedTarget).catch((error: unknown) => unavailable(error instanceof Problem ? error.problem : "connection"))
        attaching.set(key, pending)
        void pending.finally(() => { if (attaching.get(key) === pending) attaching.delete(key) })
        return pending
      } catch (error) {
        return unavailable(error instanceof Problem ? error.problem : "connection")
      }
    },
  }
}
