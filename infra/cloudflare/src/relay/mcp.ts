import { McpLimits, encodeMcpRequest, mcpHeaderNames, mcpScope } from "../../../../packages/remote/src/index"
import type { McpHeaders, McpPrincipal, McpResponse, RemoteErrorCode } from "../../../../packages/remote/src/index"
import type { McpStore } from "../auth/mcp/store"
import type {
  AuthorizationContext,
  AuthorizationRejection,
  AuthorizationRequest,
  AuthorizationResponse,
} from "./mcp-events"

export type McpAgent = { readonly agentID: string; readonly ownerID: string; readonly deviceID: string }
export type McpState = { readonly id: string; readonly enabled: boolean; readonly epoch: string }
export type McpGrant = {
  readonly grantID: string
  readonly epoch: string
  readonly resource: string
  readonly accessExpiresAt: number
  readonly principal: McpPrincipal
}
export type McpAuthority = { readonly ok: true } | { readonly ok: false; readonly reason: string }
export type McpGrantAuthorization =
  | { readonly ok: true; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: AuthorizationRejection }
export type McpRelayRequest = {
  readonly grant: McpGrant
  readonly body: string
  readonly headers: McpHeaders
  readonly signal?: AbortSignal
}
export type McpAgentPort = {
  readonly request: (payload: Uint8Array) => string | undefined
  readonly cancel: (requestID: string) => "unsent" | "unknown"
  readonly acknowledge: (state: McpState) => void
}
export type McpOutcome =
  | { readonly type: "response"; readonly response: McpResponse }
  | { readonly type: "error"; readonly code: RemoteErrorCode; readonly message: string }
  | { readonly type: "violation"; readonly code: RemoteErrorCode; readonly message: string }
export type McpControlResult = "acknowledged" | "superseded" | "stale" | "failed"
export type McpGateState = "unknown" | "off" | "enabling" | "open"

export type McpRelayDeps = {
  readonly now?: () => number
  readonly timeoutMs?: number
  readonly reservation: { readonly reserve: (bytes: number) => boolean; readonly release: (bytes: number) => void }
  readonly authorize: (grant: McpGrant) => Promise<McpAuthority>
  readonly authorizeDevice: (principal: McpPrincipal) => Promise<McpAuthority>
  readonly revokeGrants: (deviceID: string, keepEpoch?: string) => Promise<void>
  readonly persistState: (deviceID: string, state: McpState) => Promise<void>
  readonly authorizeGrant?: (input: {
    readonly grantID: string
    readonly principal: McpPrincipal
    readonly epoch: string
    readonly resource: string
  }) => Promise<McpGrantAuthorization>
}

export class McpRelayError extends Error {
  readonly code: RemoteErrorCode

  constructor(code: RemoteErrorCode, message: string) {
    super(message)
    this.name = "McpRelayError"
    this.code = code
  }
}

type Gate = { readonly state: Exclude<McpGateState, "open"> } | { readonly state: "open"; readonly epoch: string }

type AgentState = {
  readonly info: McpAgent
  readonly port: McpAgentPort
  readonly generation: number
  gate: Gate
  controlSeq: number
}

type Entry = {
  readonly generation: number
  readonly grant: McpGrant
  readonly bytes: number
  readonly clientKey: string
  readonly closed: Promise<void>
  readonly closeAdmission: () => void
  readonly resolve: (value: McpResponse) => void
  readonly reject: (error: McpRelayError) => void
  readonly detach: () => void
  requestID: string | undefined
  done: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}

const jsonContentType = /^application\/json(?:;[ \t]*charset=utf-8)?$/i
const unknownOutcomeSuffix = "; inspect the Session state before retrying"

export function createMcpRelay(deps: McpRelayDeps) {
  const now = deps.now ?? Date.now
  const timeoutMs = deps.timeoutMs ?? McpLimits.timeoutMs
  const entries = new Set<Entry>()
  const pending = new Map<string, Entry>()
  const inflight = new Map<string, number>()
  const rates = new Map<string, { windowStart: number; windowCount: number }>()
  let agent: AgentState | undefined
  let generation = 0
  let controls: Promise<unknown> = Promise.resolve()
  let admission: Promise<unknown> = Promise.resolve()

  const settle = (entry: Entry, outcome: McpResponse | McpRelayError) => {
    if (entry.done) return
    entry.done = true
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.detach()
    entries.delete(entry)
    deps.reservation.release(entry.bytes)
    if (entry.requestID !== undefined && pending.get(entry.requestID) === entry) pending.delete(entry.requestID)
    const remaining = (inflight.get(entry.clientKey) ?? 1) - 1
    if (remaining <= 0) inflight.delete(entry.clientKey)
    else inflight.set(entry.clientKey, remaining)
    entry.closeAdmission()
    if (outcome instanceof McpRelayError) entry.reject(outcome)
    else entry.resolve(outcome)
  }

  const current = (entry: Entry) => (agent !== undefined && agent.generation === entry.generation ? agent : undefined)

  const withdraw = (entry: Entry, code: RemoteErrorCode, message: string) => {
    if (entry.done) return
    const owner = current(entry)
    const status = entry.requestID === undefined ? "unsent" : owner ? owner.port.cancel(entry.requestID) : "unknown"
    settle(
      entry,
      status === "unsent"
        ? new McpRelayError(code, message)
        : new McpRelayError("outcome_unknown", `${message}${unknownOutcomeSuffix}`),
    )
  }

  const abandon = (generationID: number, message: string) => {
    for (const entry of [...entries].filter((item) => item.generation === generationID))
      settle(
        entry,
        entry.requestID === undefined
          ? new McpRelayError("agent_unavailable", message)
          : new McpRelayError("outcome_unknown", `${message}${unknownOutcomeSuffix}`),
      )
  }

  const refusal = (grant: McpGrant, fence?: number) => {
    if (agent === undefined) return new McpRelayError("agent_unavailable", "No local agent is connected")
    if (fence !== undefined && agent.generation !== fence)
      return new McpRelayError("agent_unavailable", "Agent was replaced")
    if (agent.info.ownerID !== grant.principal.ownerID || agent.info.deviceID !== grant.principal.deviceID)
      return new McpRelayError("forbidden", "Principal does not own this device")
    if (agent.gate.state === "off") return new McpRelayError("forbidden", "Relay MCP is off")
    if (agent.gate.state !== "open") return new McpRelayError("agent_unavailable", "Relay MCP is not ready")
    if (agent.gate.epoch !== grant.epoch) return new McpRelayError("unauthorized", "Grant is no longer current")
    if (now() >= grant.accessExpiresAt) return new McpRelayError("unauthorized", "Access credential expired")
    return undefined
  }

  const withinRate = (key: string) => {
    const time = now()
    if (rates.size > 1024)
      for (const [candidate, window] of rates)
        if (time - window.windowStart >= McpLimits.rateWindowMs) rates.delete(candidate)
    const existing = rates.get(key)
    const window =
      existing !== undefined && time - existing.windowStart < McpLimits.rateWindowMs
        ? existing
        : { windowStart: time, windowCount: 0 }
    rates.set(key, window)
    window.windowCount += 1
    return window.windowCount <= McpLimits.requestsPerWindow
  }

  const verify = async (grant: McpGrant) => {
    const authorized = await Promise.all([
      Promise.resolve()
        .then(() => deps.authorize(grant))
        .then(
          (value) => value,
          () => undefined,
        ),
      Promise.resolve()
        .then(() => deps.authorizeDevice(grant.principal))
        .then(
          (value) => value,
          () => undefined,
        ),
    ])
    if (authorized[0] === undefined || authorized[1] === undefined)
      return new McpRelayError("internal_error", "Authorization is unavailable")
    if (!authorized[0].ok) return new McpRelayError("unauthorized", "Grant is no longer authorized")
    if (!authorized[1].ok) return new McpRelayError("forbidden", "Device is no longer authorized")
    return null
  }

  const admit = async (entry: Entry, payload: Uint8Array, grant: McpGrant) => {
    if (entry.done) return
    const verdict = await Promise.race([verify(grant), entry.closed.then(() => undefined)])
    if (entry.done || verdict === undefined) return
    const blocked = verdict ?? refusal(grant, entry.generation)
    if (blocked !== undefined) return settle(entry, blocked)
    const owner = current(entry)
    if (owner === undefined) return settle(entry, new McpRelayError("agent_unavailable", "Agent was replaced"))
    const requestID = owner.port.request(payload)
    if (requestID === undefined)
      return settle(entry, new McpRelayError("agent_unavailable", "Agent could not be reached"))
    entry.requestID = requestID
    pending.set(requestID, entry)
  }

  const request = (input: McpRelayRequest) =>
    new Promise<McpResponse>((resolve, reject) => {
      const grant = input.grant
      const refused =
        input.signal?.aborted === true
          ? new McpRelayError("agent_unavailable", "Request was cancelled")
          : refusal(grant)
      if (refused !== undefined) return reject(refused)
      const clientKey = `${grant.principal.ownerID}\0${grant.principal.clientID}`
      if (!withinRate(clientKey)) return reject(new McpRelayError("rate_limited", "Too many requests"))
      if ((inflight.get(clientKey) ?? 0) >= McpLimits.pendingPerClient)
        return reject(new McpRelayError("rate_limited", "Too many in-flight requests"))
      const encoded = encodeMcpRequest({
        body: input.body,
        headers: Object.fromEntries(
          mcpHeaderNames.flatMap((name) => (input.headers[name] === undefined ? [] : [[name, input.headers[name]]])),
        ),
        principal: grant.principal,
        epoch: grant.epoch,
      })
      if (!encoded.ok) return reject(new McpRelayError(encoded.error.code, encoded.error.message))
      if (!deps.reservation.reserve(encoded.value.length))
        return reject(new McpRelayError("rate_limited", "Relay reservation is exhausted"))
      let closeAdmission!: () => void
      const closed = new Promise<void>((done) => {
        closeAdmission = done
      })
      const signal = input.signal
      const entry: Entry = {
        generation: agent?.generation ?? 0,
        grant,
        bytes: encoded.value.length,
        clientKey,
        closed,
        closeAdmission,
        resolve,
        reject,
        detach: () => signal?.removeEventListener("abort", onAbort),
        requestID: undefined,
        done: false,
        timer: undefined,
      }
      const onAbort = () => withdraw(entry, "agent_unavailable", "Request was cancelled")
      signal?.addEventListener("abort", onAbort, { once: true })
      entry.timer = setTimeout(() => withdraw(entry, "agent_unavailable", "Request timed out"), timeoutMs)
      entries.add(entry)
      inflight.set(clientKey, (inflight.get(clientKey) ?? 0) + 1)
      admission = admission.then(() => admit(entry, encoded.value, grant))
    })

  const persistControl = async (owner: AgentState, value: McpState, sequence: number): Promise<McpControlResult> => {
    if (agent !== owner || owner.controlSeq !== sequence) return "superseded"
    const failed = await Promise.resolve()
      .then(async () => {
        await deps.revokeGrants(owner.info.deviceID, value.enabled ? value.epoch : undefined)
        await deps.persistState(owner.info.deviceID, value)
      })
      .then(
        () => false,
        () => true,
      )
    if (failed) return "failed"
    if (agent !== owner || owner.controlSeq !== sequence) return "superseded"
    if (value.enabled) owner.gate = { state: "open", epoch: value.epoch }
    owner.port.acknowledge(value)
    return "acknowledged"
  }

  const authorizeEvent = async (
    trusted: AuthorizationContext,
    request: AuthorizationRequest,
  ): Promise<AuthorizationResponse> => {
    if (request.action === "capabilities") return { action: "capabilities", supported: true }
    const rejected = (reason: AuthorizationRejection): AuthorizationResponse => ({
      action: request.action,
      authorized: false,
      reason,
    })
    const checkGrant = deps.authorizeGrant
    if (checkGrant === undefined) return rejected("unavailable")
    const principal = request.principal
    if (principal.ownerID !== trusted.ownerID || principal.deviceID !== trusted.deviceID) return rejected("forbidden")
    if (request.action === "check") {
      const fresh = await Promise.resolve()
        .then(() =>
          checkGrant({ grantID: request.grantID, principal, epoch: request.epoch, resource: trusted.resource }),
        )
        .then(
          (value) => value,
          (): McpGrantAuthorization => ({ ok: false, reason: "unavailable" }),
        )
      if (!fresh.ok) return rejected(fresh.reason)
      if (!Number.isSafeInteger(fresh.expiresAt) || fresh.expiresAt <= now()) return rejected("unauthorized")
      return { action: "check", authorized: true, grantID: request.grantID, expiresAt: fresh.expiresAt }
    }
    const owner = agent
    if (owner === undefined) return rejected("unavailable")
    if (owner.info.ownerID !== trusted.ownerID || owner.info.deviceID !== trusted.deviceID) return rejected("forbidden")
    if (owner.gate.state === "off") return rejected("forbidden")
    if (owner.gate.state !== "open") return rejected("unavailable")
    if (owner.gate.epoch !== request.epoch) return rejected("unauthorized")
    const entry = pending.get(request.requestID)
    if (entry === undefined || entry.done) return rejected("not_found")
    if (entry.generation !== owner.generation) return rejected("unavailable")
    const bound = entry.grant.principal
    if (
      bound.ownerID !== principal.ownerID ||
      bound.deviceID !== principal.deviceID ||
      bound.clientID !== principal.clientID
    )
      return rejected("forbidden")
    if (entry.grant.epoch !== request.epoch || entry.grant.resource !== trusted.resource)
      return rejected("unauthorized")
    const sequence = owner.controlSeq
    const fresh = await Promise.race([
      Promise.resolve()
        .then(() =>
          checkGrant({
            grantID: entry.grant.grantID,
            principal: bound,
            epoch: entry.grant.epoch,
            resource: entry.grant.resource,
          }),
        )
        .then(
          (value) => value,
          (): McpGrantAuthorization => ({ ok: false, reason: "unavailable" }),
        ),
      entry.closed.then(() => undefined),
    ])
    if (entry.done || pending.get(request.requestID) !== entry) return rejected("not_found")
    if (agent !== owner || owner.controlSeq !== sequence || owner.gate.state !== "open") return rejected("unavailable")
    if (owner.gate.epoch !== request.epoch) return rejected("unauthorized")
    if (fresh === undefined) return rejected("not_found")
    if (!fresh.ok) return rejected(fresh.reason)
    if (!Number.isSafeInteger(fresh.expiresAt) || fresh.expiresAt <= now()) return rejected("unauthorized")
    return { action: "resolve", authorized: true, grantID: entry.grant.grantID, expiresAt: fresh.expiresAt }
  }

  return {
    request,
    authorizeEvent,

    gate: () =>
      agent === undefined
        ? undefined
        : {
            agentID: agent.info.agentID,
            generation: agent.generation,
            state: agent.gate.state,
            ...(agent.gate.state === "open" ? { epoch: agent.gate.epoch } : {}),
          },

    setAgent(info: McpAgent, port: McpAgentPort) {
      if (agent !== undefined) {
        agent.controlSeq += 1
        abandon(agent.generation, "Agent was replaced")
      }
      agent = { info, port, generation: (generation += 1), gate: { state: "unknown" }, controlSeq: 0 }
    },

    clearAgent(agentID: string) {
      const owner = agent
      if (owner === undefined || owner.info.agentID !== agentID) return false
      owner.controlSeq += 1
      agent = undefined
      abandon(owner.generation, "Agent disconnected")
      return true
    },

    owns(agentID: string, requestID: string) {
      const entry = pending.get(requestID)
      return agent !== undefined && agent.info.agentID === agentID && entry?.generation === agent.generation
    },

    handleState(agentID: string, value: McpState): Promise<McpControlResult> {
      const owner = agent
      if (owner === undefined || owner.info.agentID !== agentID) return Promise.resolve("stale")
      owner.controlSeq += 1
      const sequence = owner.controlSeq
      const previousEpoch = owner.gate.state === "open" ? owner.gate.epoch : undefined
      owner.gate = { state: value.enabled ? "enabling" : "off" }
      const ofAgent = [...entries].filter((entry) => entry.generation === owner.generation)
      if (!value.enabled) for (const entry of ofAgent) withdraw(entry, "forbidden", "Relay MCP is off")
      if (value.enabled && previousEpoch !== undefined && previousEpoch !== value.epoch)
        for (const entry of ofAgent) withdraw(entry, "unauthorized", "Relay MCP grants were retired")
      const turn = controls.then(() => persistControl(owner, value, sequence))
      controls = turn
      return turn
    },

    complete(agentID: string, requestID: string, outcome: McpOutcome) {
      const entry = pending.get(requestID)
      const owner = agent
      if (
        owner === undefined ||
        owner.info.agentID !== agentID ||
        entry === undefined ||
        entry.generation !== owner.generation
      )
        return false
      if (outcome.type === "violation") {
        owner.port.cancel(requestID)
        settle(entry, new McpRelayError(outcome.code, outcome.message))
        return true
      }
      if (outcome.type === "error") {
        settle(entry, new McpRelayError(outcome.code, outcome.message))
        return true
      }
      const response = outcome.response
      if (
        !Number.isInteger(response.status) ||
        response.status < 200 ||
        response.status > 599 ||
        !jsonContentType.test(response.contentType)
      ) {
        settle(entry, new McpRelayError("internal_error", "Agent returned an invalid MCP response"))
        return true
      }
      settle(entry, response)
      return true
    },
  }
}

export type McpRelay = ReturnType<typeof createMcpRelay>

const failureStatus: Partial<Record<RemoteErrorCode, number>> = {
  invalid_message: 400,
  unauthorized: 401,
  forbidden: 403,
  message_too_large: 413,
  rate_limited: 429,
  agent_unavailable: 503,
}

export function mcpFailureStatus(code: RemoteErrorCode) {
  return failureStatus[code] ?? 502
}

export async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string | undefined> {
  if (body === null) return ""
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let total = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) return chunks.join("") + decoder.decode()
    total += chunk.value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(decoder.decode(chunk.value, { stream: true }))
  }
}

export function parseMcpForward(
  headers: Headers,
): { readonly grant: McpGrant; readonly headers: McpHeaders } | undefined {
  const ownerID = headers.get("x-ycoding-mcp-owner")
  const deviceID = headers.get("x-ycoding-mcp-device")
  const clientID = headers.get("x-ycoding-mcp-client")
  const grantID = headers.get("x-ycoding-mcp-grant")
  const epoch = headers.get("x-ycoding-mcp-epoch")
  const resource = headers.get("x-ycoding-mcp-resource")
  const accessExpiresAt = Number(headers.get("x-ycoding-mcp-expires"))
  if (
    !ownerID ||
    !deviceID ||
    !clientID ||
    !grantID ||
    !epoch ||
    !resource ||
    !Number.isSafeInteger(accessExpiresAt) ||
    accessExpiresAt <= 0
  )
    return undefined
  return {
    grant: { grantID, epoch, resource, accessExpiresAt, principal: { ownerID, deviceID, clientID } },
    headers: Object.fromEntries(
      mcpHeaderNames.flatMap((name) => {
        const value = headers.get(name)
        return value === null ? [] : [[name, value]]
      }),
    ),
  }
}

export function createMcpAuthority(options: {
  readonly store: McpStore
  readonly authorizeDevice: (
    deviceID: string,
  ) => Promise<
    { readonly ok: true; readonly value: { readonly userID: string } } | { readonly ok: false; readonly reason: string }
  >
  readonly now?: () => number
}) {
  const now = options.now ?? Date.now

  return {
    authorizeDevice: async (principal: McpPrincipal): Promise<McpAuthority> => {
      const admitted = await options.authorizeDevice(principal.deviceID)
      if (!admitted.ok) return { ok: false, reason: admitted.reason }
      return admitted.value.userID === principal.ownerID ? { ok: true } : { ok: false, reason: "not_owner" }
    },

    authorize: async (grant: McpGrant): Promise<McpAuthority> => {
      const row = await options.store.findGrant(grant.grantID)
      if (row === undefined) return { ok: false, reason: "unknown_grant" }
      if (row.revokedAt !== undefined) return { ok: false, reason: "revoked_grant" }
      if (now() >= row.expiresAt) return { ok: false, reason: "expired_grant" }
      if (
        row.ownerID !== grant.principal.ownerID ||
        row.deviceID !== grant.principal.deviceID ||
        row.clientID !== grant.principal.clientID
      )
        return { ok: false, reason: "principal_mismatch" }
      if (row.resource !== grant.resource || row.scope !== mcpScope) return { ok: false, reason: "resource_mismatch" }
      if (row.epoch !== grant.epoch) return { ok: false, reason: "epoch_mismatch" }
      const device = await options.store.getDevice(row.deviceID)
      if (!device?.enabled) return { ok: false, reason: "mcp_disabled" }
      return device.epoch === grant.epoch ? { ok: true } : { ok: false, reason: "epoch_mismatch" }
    },

    authorizeGrant: async (input: {
      readonly grantID: string
      readonly principal: McpPrincipal
      readonly epoch: string
      readonly resource: string
    }): Promise<McpGrantAuthorization> => {
      const row = await options.store.findGrant(input.grantID)
      if (row === undefined) return { ok: false, reason: "not_found" }
      if (row.revokedAt !== undefined || now() >= row.expiresAt) return { ok: false, reason: "unauthorized" }
      if (
        row.ownerID !== input.principal.ownerID ||
        row.deviceID !== input.principal.deviceID ||
        row.clientID !== input.principal.clientID
      )
        return { ok: false, reason: "forbidden" }
      if (row.epoch !== input.epoch || row.scope !== mcpScope || row.resource !== input.resource)
        return { ok: false, reason: "unauthorized" }
      const admitted = await options.authorizeDevice(row.deviceID)
      if (!admitted.ok || admitted.value.userID !== row.ownerID) return { ok: false, reason: "forbidden" }
      const device = await options.store.getDevice(row.deviceID)
      if (!device?.enabled) return { ok: false, reason: "forbidden" }
      if (device.epoch !== input.epoch || now() >= row.expiresAt) return { ok: false, reason: "unauthorized" }
      return { ok: true, expiresAt: row.expiresAt }
    },

    revokeGrants: (deviceID: string, keepEpoch?: string) =>
      keepEpoch === undefined ? options.store.deleteDeviceGrants(deviceID) : Promise.resolve(),

    persistState: (deviceID: string, state: McpState) =>
      options.store.setDevice({ deviceID, enabled: state.enabled, epoch: state.epoch, now: now() }),
  }
}
