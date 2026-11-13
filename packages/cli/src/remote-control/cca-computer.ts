import type { NativeDots } from "@ycoding-ai/core/dots/native"
import type { Dots } from "@ycoding-ai/schema/dots"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { RemoteLimits } from "@ycoding-ai/remote"
import type { RemoteControlCredential } from "@ycoding-ai/core/remote-control/credential"
import { buildCcaHeaders, defaultTimeoutMs, loadCcaExperimentState, markCcaExecutorRemoved, type CcaFetch } from "./cca-executor-registration"
import { defaultRegistryBaseURL } from "./cca-executor-transport"
import { accountHash } from "./state"

export const ccaComputerBaseURL = "https://chatgpt.com/backend-api"
export const ccaComputerCacheMs = 15_000
const dotPageLimit = 25
const maxDotPages = 40
const supplementMs = 5_000
const maxCapabilities = 16
const identifierPattern = /^[a-z][a-z0-9_-]{0,63}$/
const readinessStates = ["connected", "offline", "unknown"] as const

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
  "not-disconnectable",
  "not-deletable",
] as const

export type CcaComputerProblem = (typeof ccaComputerProblems)[number]

export interface CcaComputerStatus {
  readonly state: "attached" | "detached" | "unavailable" | "removed"
  readonly problem?: CcaComputerProblem
  readonly name?: string
  readonly target?: Dots.ComputerTarget
  readonly readiness?: (typeof readinessStates)[number]
  readonly usableForTasks?: boolean
  readonly dotEnvironment?: Dots.DotEnvironment
}

export interface CcaComputerControl {
  readonly computer: () => Promise<CcaComputerStatus>
  readonly attach: (input: Dots.ComputerAttach) => Promise<CcaComputerStatus>
  readonly detach: (input: Dots.ComputerDetach) => Promise<CcaComputerStatus>
  readonly remove: (input: Dots.ComputerRemove) => Promise<CcaComputerStatus>
}

export interface CcaComputerControlDeps {
  readonly native: Pick<NativeDots.Host, "configuration" | "credential">
  readonly statePath: string
  readonly fetch?: CcaFetch
  readonly now?: () => number
  readonly observeMs?: number
  readonly registryBaseURL?: string
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
type Observation = {
  readonly status: CcaComputerStatus
  readonly target?: Target
  readonly disconnect?: Target
  readonly delete?: Target
}
type Outcome = "ok" | "rejected" | "uncertain"

export class CcaComputerFailure extends Error {
  constructor(readonly problem: CcaComputerProblem) {
    super(problem)
  }
}

const unavailable = (problem: CcaComputerProblem): CcaComputerStatus => ({ state: "unavailable", problem })
const sameTarget = (left: Dots.ComputerTarget | undefined, right: Dots.ComputerTarget | undefined) =>
  left?.dotID === right?.dotID && left?.threadID === right?.threadID && left?.environmentID === right?.environmentID && left?.revision === right?.revision

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new CcaComputerFailure("connection")
  return value
}

function identity(value: unknown) {
  if (typeof value !== "string" || !value) throw new CcaComputerFailure("connection")
  return value
}

export function ccaRestSend(fetchFn: CcaFetch, method: "GET" | "POST" | "DELETE", path: string, query: Record<string, string | undefined>, resolved: RemoteControlCredential.Resolved, signal: AbortSignal, base = ccaComputerBaseURL, headers: Record<string, string> = {}) {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(query)) if (value !== undefined) search.set(name, value)
  const suffix = search.size ? `?${search}` : ""
  return fetchFn(`${base}${path}${suffix}`, {
    method,
    headers: { ...buildCcaHeaders({ access: resolved.access, accountID: resolved.accountID }), ...headers },
    redirect: "error",
    signal,
  })
}

const decodeJson = Schema.decodeUnknownPromise(Schema.fromJsonString(Schema.Unknown))

async function cappedJson(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) throw new CcaComputerFailure("connection")
  const reader = response.body?.getReader()
  if (!reader) throw new CcaComputerFailure("connection")
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new CcaComputerFailure("connection")
    }
    chunks.push(value)
  }
  return decodeJson(Buffer.concat(chunks).toString("utf8"))
}

export async function ccaRestGet(fetchFn: CcaFetch, path: string, query: Record<string, string | undefined>, resolved: RemoteControlCredential.Resolved, deadline: AbortSignal, base = ccaComputerBaseURL, options: { readonly headers?: Record<string, string>; readonly maxBytes?: number } = {}) {
  const response = await ccaRestSend(fetchFn, "GET", path, query, resolved, AbortSignal.any([AbortSignal.timeout(defaultTimeoutMs), deadline]), base, options.headers).catch(() => {
    throw new CcaComputerFailure("connection")
  })
  if (response.status === 401 || response.status === 403) throw new CcaComputerFailure("authentication")
  if (!response.ok) throw new CcaComputerFailure("connection")
  const body = options.maxBytes === undefined ? await response.json().catch(() => undefined) : await cappedJson(response, options.maxBytes).catch((error: unknown) => {
    if (error instanceof CcaComputerFailure) throw error
    return undefined
  })
  return record(body)
}

export async function ccaResolveDot(fetchFn: CcaFetch, resolved: RemoteControlCredential.Resolved, deadline: AbortSignal) {
  const active: string[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < maxDotPages; page++) {
    const body = await ccaRestGet(fetchFn, "/tbo", { cursor, limit: String(dotPageLimit), include_room_preview: "false" }, resolved, deadline)
    if (!Array.isArray(body.items)) throw new CcaComputerFailure("connection")
    for (const item of body.items) {
      const fields = record(item)
      if (fields.status === "active") active.push(identity(fields.id))
    }
    if (body.cursor === undefined || body.cursor === null) {
      if (active.length === 1) return active[0]!
      if (active.length === 0) throw new CcaComputerFailure("dot-unavailable")
      const primary = await ccaRestGet(fetchFn, "/tbo/primary", {}, resolved, deadline)
      const profile = primary.profile === undefined || primary.profile === null ? undefined : record(primary.profile)
      const id = profile === undefined ? undefined : identity(profile.id)
      if (id === undefined || !active.includes(id)) throw new CcaComputerFailure("dot-unavailable")
      return id
    }
    cursor = identity(body.cursor)
    if (cursors.has(cursor)) throw new CcaComputerFailure("connection")
    cursors.add(cursor)
  }
  throw new CcaComputerFailure("connection")
}

export async function ccaPinnedCredential(native: Pick<NativeDots.Host, "configuration" | "credential">) {
  const current = await native.configuration().catch(() => undefined)
  if (!current?.enabled) throw new CcaComputerFailure("configuration")
  const resolved = await native.credential(current.profile).catch(() => undefined)
  if (
    resolved === undefined ||
    resolved.accountID !== current.accountID ||
    resolved.credentialID !== current.credentialID ||
    resolved.accountGeneration !== current.accountGeneration
  )
    throw new CcaComputerFailure("authentication")
  return { configuration: current, credential: resolved }
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
  const detaching = new Map<string, Promise<CcaComputerStatus>>()
  const removing = new Map<string, Promise<CcaComputerStatus>>()
  const registryBaseURL = (deps.registryBaseURL ?? defaultRegistryBaseURL).replace(/\/+$/, "")

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
      throw new CcaComputerFailure("authentication")
    return resolved
  }

  async function enrollment(accountID: string) {
    const state = await loadCcaExperimentState(deps.statePath).catch(() => {
      throw new CcaComputerFailure("enrollment")
    })
    const id = typeof state.executorID === "string" ? state.executorID.trim() : ""
    if (state.status !== "completed" || state.accountHash !== accountHash(accountID) || !id) throw new CcaComputerFailure("enrollment")
    if (typeof state.installationID !== "string" || !state.installationID) throw new CcaComputerFailure("enrollment")
    return { executorID: id, installationID: state.installationID, accountHash: state.accountHash, status: state.status }
  }

  async function binding(): Promise<Binding> {
    const current = await configuration()
    if (!current) throw new CcaComputerFailure("configuration")
    const resolved = await credential(current)
    const enrolled = await enrollment(resolved.accountID)
    const latest = await configuration()
    if (JSON.stringify(latest) !== JSON.stringify(current)) throw new CcaComputerFailure("configuration")
    return { credential: resolved, environmentID: enrolled.executorID,
      key: JSON.stringify([current, enrolled]) }
  }

  async function validate(owner: Binding) {
    const latest = await binding()
    if (latest.key !== owner.key) throw new CcaComputerFailure("target-changed")
    return latest
  }

  function receipt(owner: Binding, target: Target): Dots.ComputerTarget {
    const tuple = { dotID: target.dotID, threadID: target.threadID, environmentID: target.environmentID }
    return { ...tuple, revision: createHash("sha256").update(JSON.stringify([owner.key, tuple])).digest("hex") }
  }

  const send = (method: "GET" | "POST" | "DELETE", path: string, query: Record<string, string | undefined>, resolved: RemoteControlCredential.Resolved, signal: AbortSignal) =>
    ccaRestSend(fetchFn, method, path, query, resolved, signal)
  const get = (path: string, query: Record<string, string | undefined>, resolved: RemoteControlCredential.Resolved, deadline: AbortSignal, base = ccaComputerBaseURL) =>
    ccaRestGet(fetchFn, path, query, resolved, deadline, base)
  const dot = (resolved: RemoteControlCredential.Resolved, deadline: AbortSignal) => ccaResolveDot(fetchFn, resolved, deadline)

  async function readiness(owner: Binding, deadline: AbortSignal): Promise<CcaComputerStatus["readiness"]> {
    const body = await get(`/cloud/environment/${encodeURIComponent(owner.environmentID)}/status`, {}, owner.credential, deadline, registryBaseURL)
    const status = readinessStates.find((state) => state === body.status)
    return body.environment_id === owner.environmentID ? status : undefined
  }

  async function dotEnvironment(target: Target, deadline: AbortSignal): Promise<Dots.DotEnvironment | undefined> {
    const body = await get(`/tbo/${encodeURIComponent(target.dotID)}/environment/status`, { thread_id: target.threadID }, target.credential, deadline)
    if (body.environmentId !== undefined && body.environmentId !== null && typeof body.environmentId !== "string") return undefined
    if (typeof body.status !== "string" || !identifierPattern.test(body.status)) return undefined
    if (!Array.isArray(body.capabilities) || body.capabilities.length > maxCapabilities) return undefined
    const capabilities: { type: string; status: string }[] = []
    for (const item of body.capabilities) {
      if (!isRecord(item)) return undefined
      const { type, status } = item
      if (typeof type !== "string" || typeof status !== "string" || !identifierPattern.test(type) || !identifierPattern.test(status)) return undefined
      capabilities.push({ type, status })
    }
    return { status: body.status, capabilities }
  }

  async function supplements(owner: Binding, target: Target, row: Record<string, unknown>, deadline: AbortSignal) {
    const bounded = AbortSignal.any([deadline, AbortSignal.timeout(supplementMs)])
    const [ready, environment] = await Promise.all([
      readiness(owner, bounded).catch(() => undefined),
      dotEnvironment(target, bounded).catch(() => undefined),
    ])
    return {
      ...(ready === undefined ? {} : { readiness: ready }),
      ...(typeof row.can_use_for_tasks === "boolean" ? { usableForTasks: row.can_use_for_tasks } : {}),
      ...(environment === undefined ? {} : { dotEnvironment: environment }),
    }
  }

  async function read(owner: Binding, deadline: AbortSignal): Promise<Observation> {
    try {
      const resolved = owner.credential
      const environmentID = owner.environmentID
      const dotID = await dot(resolved, deadline)
      const root = await get(`/tbo/${encodeURIComponent(dotID)}/root-thread`, {}, resolved, deadline)
      if (root.root_thread_id === undefined || root.root_thread_id === null) throw new CcaComputerFailure("dot-unavailable")
      const threadID = identity(root.root_thread_id)
      const list = await get(`/tbo/${encodeURIComponent(dotID)}/computers`, { expected_thread_id: threadID }, resolved, deadline)
      if (typeof list.thread_id !== "string") throw new CcaComputerFailure("connection")
      if (list.thread_id !== threadID) throw new CcaComputerFailure("dot-unavailable")
      if (!Array.isArray(list.computers)) throw new CcaComputerFailure("connection")
      const row = list.computers.map(record).find((item) => item.environment_id === environmentID)
      const target = { credential: resolved, dotID, threadID, environmentID }
      const extra = row === undefined ? {} : await supplements(owner, target, row, deadline)
      await validate(owner)
      if (row === undefined) return { status: unavailable("not-listed") }
      const name = typeof row.display_name === "string" ? row.display_name.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 256) : undefined
      const details = { target: receipt(owner, target), ...(name ? { name } : {}), ...extra }
      const deletable = row.can_delete === true ? { delete: target } : {}
      if (row.is_attached === true) {
        if (row.can_disconnect !== true) return { status: { state: "attached", problem: "not-disconnectable", ...details }, ...deletable }
        return { status: { state: "attached", ...details }, disconnect: target, ...deletable }
      }
      if (list.local_computer_access_disabled_by_admin === true) return { status: { state: "detached", problem: "admin-disabled", ...details }, ...deletable }
      if (row.can_connect !== true) return { status: { state: "detached", problem: "not-connectable", ...details }, ...deletable }
      return { status: { state: "detached", ...details }, target, ...deletable }
    } catch (error) {
      if (error instanceof CcaComputerFailure) return { status: unavailable(error.problem) }
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

  async function dispatch(method: "POST" | "DELETE", path: string, query: Record<string, string | undefined>, credential: RemoteControlCredential.Resolved): Promise<Outcome> {
    const response = await send(method, path, query, credential, AbortSignal.timeout(RemoteLimits.dotsConnectMs)).catch(() => undefined)
    if (response === undefined) return "uncertain"
    await response.body?.cancel().catch(() => {})
    if (response.ok) return "ok"
    if (response.status === 408 || response.status === 429 || response.status >= 500) return "uncertain"
    return "rejected"
  }

  function connect(target: Target, replaceOthers: boolean) {
    const grant = replaceOthers ? "connect-and-replace" : "connect"
    return dispatch("POST", `/tbo/${encodeURIComponent(target.dotID)}/computers/${encodeURIComponent(target.environmentID)}/${grant}`, { expected_thread_id: target.threadID }, target.credential)
  }

  function disconnect(target: Target) {
    return dispatch("POST", `/tbo/${encodeURIComponent(target.dotID)}/computers/${encodeURIComponent(target.environmentID)}/disconnect`, { expected_thread_id: target.threadID }, target.credential)
  }

  function destroy(target: Target) {
    return dispatch("DELETE", `/computers/${encodeURIComponent(target.environmentID)}`, {}, target.credential)
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
      return unavailable(error instanceof CcaComputerFailure ? error.problem : "connection")
    }
  }

  async function reconcile(owner: Binding, before: CcaComputerStatus, outcome: Outcome, goal: "attached" | "detached"): Promise<CcaComputerStatus> {
    const unresolved = () => unavailable(outcome === "rejected" ? "rejected" : "unconfirmed")
    try {
      const current = await validate(owner)
      const after = await observe(current)
      if (!sameTarget(after.status.target, before.target) || after.status.state === "unavailable") return unresolved()
      if (after.status.state === goal) return after.status
      return { ...after.status, problem: outcome === "rejected" ? "rejected" : "unconfirmed" }
    } catch {
      return unresolved()
    }
  }

  async function attachOnce(owner: Binding, replaceOthers: boolean, expectedTarget?: Dots.ComputerTarget): Promise<CcaComputerStatus> {
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
    const outcome = await connect({ ...before.target, credential: current.credential }, replaceOthers)
    const result = await reconcile(owner, before.status, outcome, "attached")
    generation++
    store(key, result)
    return result
  }

  async function detachOnce(owner: Binding, expectedTarget?: Dots.ComputerTarget): Promise<CcaComputerStatus> {
    const key = owner.key
    latestKey = key
    generation++
    const before = await observe(owner)
    if (expectedTarget && !sameTarget(expectedTarget, before.status.target)) return unavailable("target-changed")
    if (before.disconnect === undefined) {
      generation++
      store(key, before.status)
      return before.status
    }
    const current = await validate(owner)
    const outcome = await disconnect({ ...before.disconnect, credential: current.credential })
    const result = await reconcile(owner, before.status, outcome, "detached")
    generation++
    store(key, result)
    return result
  }

  async function removeOnce(owner: Binding, expectedTarget?: Dots.ComputerTarget): Promise<CcaComputerStatus> {
    const key = owner.key
    latestKey = key
    generation++
    const before = await observe(owner)
    if (expectedTarget && !sameTarget(expectedTarget, before.status.target)) return unavailable("target-changed")
    if (before.status.state === "unavailable") {
      generation++
      store(key, before.status)
      return before.status
    }
    if (before.delete === undefined) return { ...before.status, problem: "not-deletable" }
    const current = await validate(owner)
    const outcome = await destroy({ ...before.delete, credential: current.credential })
    generation++
    try {
      const after = await observe(await validate(owner))
      if (after.status.problem === "not-listed") {
        await markCcaExecutorRemoved(deps.statePath, owner.environmentID).catch(() => deps.onDiagnostic?.("CCA computer removal-state-unrecorded"))
        cache = undefined
        return { state: "removed" }
      }
      if (!sameTarget(after.status.target, before.status.target) || after.status.state === "unavailable") return unavailable(outcome === "rejected" ? "rejected" : "unconfirmed")
      return { ...after.status, problem: outcome === "rejected" ? "rejected" : "unconfirmed" }
    } catch {
      return unavailable(outcome === "rejected" ? "rejected" : "unconfirmed")
    }
  }

  function coalesce(pending: Map<string, Promise<CcaComputerStatus>>, key: string, run: () => Promise<CcaComputerStatus>) {
    const existing = pending.get(key)
    if (existing) return existing
    const attempt = run().catch((error: unknown) => unavailable(error instanceof CcaComputerFailure ? error.problem : "connection"))
    pending.set(key, attempt)
    void attempt.finally(() => { if (pending.get(key) === attempt) pending.delete(key) })
    return attempt
  }

  const receiptKey = (target: Dots.ComputerTarget | undefined) => target === undefined ? null : [target.dotID, target.threadID, target.environmentID, target.revision]

  async function change(pending: Map<string, Promise<CcaComputerStatus>>, scope: unknown, run: (owner: Binding) => Promise<CcaComputerStatus>) {
    try {
      const owner = await binding()
      return coalesce(pending, JSON.stringify([owner.key, scope]), () => run(owner))
    } catch (error) {
      return unavailable(error instanceof CcaComputerFailure ? error.problem : "connection")
    }
  }

  return {
    computer,
    attach: (input) => change(attaching, [input.replaceOthers, receiptKey(input.expectedTarget)], (owner) => attachOnce(owner, input.replaceOthers, input.expectedTarget)),
    detach: (input) => change(detaching, receiptKey(input.expectedTarget), (owner) => detachOnce(owner, input.expectedTarget)),
    remove: (input) => change(removing, receiptKey(input.expectedTarget), (owner) => removeOnce(owner, input.expectedTarget)),
  }
}
