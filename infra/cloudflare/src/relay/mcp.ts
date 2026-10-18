import {
  RemoteLimits,
  mcpHeaderNames,
  mcpScope,
  parseAgentMessage,
  parseMcpRequest,
  parseMcpState,
  serializeCancel,
  type McpHeaders,
  type McpPrincipal,
  type McpResponse,
  type McpState,
  type RemoteErrorCode,
  type RemoteResponse,
} from "../../../../packages/remote/src/index"
import type { McpStore } from "../auth/mcp/store"

export type McpAgent = { readonly agentID: string; readonly ownerID: string; readonly deviceID: string }
export type McpAttachment = { readonly enabled: boolean; readonly epoch: string }
export type McpGrant = {
  readonly grantID: string
  readonly epoch: string
  readonly resource: string
  readonly accessExpiresAt: number
  readonly principal: McpPrincipal
}
export type McpAuthority = { readonly ok: true } | { readonly ok: false; readonly reason: string }
export type McpRelayRequest = { readonly grant: McpGrant; readonly body: string; readonly headers: McpHeaders; readonly signal?: AbortSignal }
export type McpControlResult = "acknowledged" | "superseded" | "stale" | "failed"
export type McpResponseResult = "accepted" | "ignored" | "violation"
export type McpGateState = "unknown" | "off" | "enabling" | "open"

export type McpRelayDeps = {
  readonly now?: () => number
  readonly newID?: () => string
  readonly timeoutMs?: number
  readonly send: (agentID: string, frame: string) => void
  readonly authorize: (grant: McpGrant) => Promise<McpAuthority>
  readonly authorizeDevice: (principal: McpPrincipal) => Promise<McpAuthority>
  readonly validateGate: (input: { readonly agent: McpAgent; readonly epoch: string }) => Promise<boolean>
  readonly revokeGrants: (deviceID: string, keepEpoch?: string) => Promise<void>
  readonly persistState: (agentID: string, state: McpState) => Promise<void>
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
  readonly generation: number
  gate: Gate
  controlSeq: number
}

type Entry = {
  readonly relayID: string
  readonly generation: number
  readonly deviceID: string
  readonly grantID: string
  readonly clientKey: string
  readonly closed: Promise<void>
  readonly closeAdmission: () => void
  readonly resolve: (value: McpResponse) => void
  readonly reject: (error: McpRelayError) => void
  sent: boolean
  done: boolean
  chunks: string[]
  chars: number
  timer: ReturnType<typeof setTimeout> | undefined
  detach: () => void
}

const maxResponseChars = RemoteLimits.maxAgentMessageChars * RemoteLimits.maxChunksPerResponse
const jsonContentType = /^application\/json(?:;[ \t]*charset=utf-8)?$/i
const unknownOutcomeSuffix = "; inspect the Session state before retrying"

export function createMcpRelay(deps: McpRelayDeps) {
  const now = deps.now ?? Date.now
  const newID = deps.newID ?? (() => crypto.randomUUID())
  const timeoutMs = deps.timeoutMs ?? RemoteLimits.compactionTimeoutMs
  const entries = new Set<Entry>()
  const pending = new Map<string, Entry>()
  const inflight = new Map<string, number>()
  const rates = new Map<string, { windowStart: number; windowCount: number }>()
  let agent: AgentState | undefined
  let generation = 0
  let controls: Promise<unknown> = Promise.resolve()
  let admission: Promise<unknown> = Promise.resolve()

  const trySend = (agentID: string, frame: string) => {
    try {
      deps.send(agentID, frame)
      return true
    } catch {
      return false
    }
  }

  const cancelAtAgent = (entry: Entry) => {
    if (agent !== undefined && agent.generation === entry.generation) trySend(agent.info.agentID, serializeCancel(entry.relayID))
  }

  const settle = (entry: Entry, outcome: McpResponse | McpRelayError) => {
    if (entry.done) return
    entry.done = true
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.detach()
    entries.delete(entry)
    pending.delete(entry.relayID)
    const remaining = (inflight.get(entry.clientKey) ?? 1) - 1
    if (remaining <= 0) inflight.delete(entry.clientKey)
    else inflight.set(entry.clientKey, remaining)
    entry.closeAdmission()
    if (outcome instanceof McpRelayError) entry.reject(outcome)
    else entry.resolve(outcome)
  }

  const failEntry = (entry: Entry, code: RemoteErrorCode, message: string, cancel: boolean) => {
    if (entry.done) return false
    if (!entry.sent) {
      settle(entry, new McpRelayError(code, message))
      return true
    }
    if (cancel) cancelAtAgent(entry)
    settle(entry, new McpRelayError("outcome_unknown", `${message}${unknownOutcomeSuffix}`))
    return true
  }

  const failWhere = (matches: (entry: Entry) => boolean, code: RemoteErrorCode, message: string, cancel: boolean) =>
    Array.from(entries).filter(matches).filter((entry) => failEntry(entry, code, message, cancel)).length

  const violation = (entry: Entry, code: RemoteErrorCode, message: string): McpResponseResult => {
    cancelAtAgent(entry)
    settle(entry, new McpRelayError(code, message))
    return "violation"
  }

  const refusal = (grant: McpGrant, fence?: number) => {
    if (agent === undefined) return new McpRelayError("agent_unavailable", "No local agent is connected")
    if (fence !== undefined && agent.generation !== fence) return new McpRelayError("agent_unavailable", "Agent was replaced")
    if (agent.info.ownerID !== grant.principal.ownerID || agent.info.deviceID !== grant.principal.deviceID)
      return new McpRelayError("forbidden", "Principal does not own this device")
    if (agent.gate.state === "off") return new McpRelayError("forbidden", "Relay MCP is off")
    if (agent.gate.state !== "open") return new McpRelayError("agent_unavailable", "Relay MCP is not ready")
    if (agent.gate.epoch !== grant.epoch) return new McpRelayError("unauthorized", "Grant is no longer current")
    if (now() >= grant.accessExpiresAt) return new McpRelayError("unauthorized", "Access credential expired")
    return undefined
  }

  const withinRate = (key: string) => {
    const current = now()
    if (rates.size > 1024)
      for (const [candidate, window] of rates) if (current - window.windowStart >= RemoteLimits.clientRateWindowMs) rates.delete(candidate)
    const existing = rates.get(key)
    const window = existing !== undefined && current - existing.windowStart < RemoteLimits.clientRateWindowMs ? existing : { windowStart: current, windowCount: 0 }
    rates.set(key, window)
    window.windowCount += 1
    return window.windowCount <= RemoteLimits.maxClientRequestsPerWindow
  }

  const verify = async (grant: McpGrant) => {
    const authorized = await Promise.all([
      Promise.resolve().then(() => deps.authorize(grant)).then((value) => value, () => undefined),
      Promise.resolve().then(() => deps.authorizeDevice(grant.principal)).then((value) => value, () => undefined),
    ])
    if (authorized[0] === undefined || authorized[1] === undefined) return new McpRelayError("internal_error", "Authorization is unavailable")
    if (!authorized[0].ok) return new McpRelayError("unauthorized", "Grant is no longer authorized")
    if (!authorized[1].ok) return new McpRelayError("forbidden", "Device is no longer authorized")
    return null
  }

  const admit = async (entry: Entry, frame: string, grant: McpGrant) => {
    if (entry.done) return
    const verdict = await Promise.race([verify(grant), entry.closed.then(() => undefined)])
    if (entry.done || verdict === undefined) return
    const blocked = verdict ?? refusal(grant, entry.generation)
    if (blocked !== undefined) return settle(entry, blocked)
    if (agent === undefined) return
    entry.sent = true
    pending.set(entry.relayID, entry)
    if (trySend(agent.info.agentID, frame)) return
    entry.sent = false
    pending.delete(entry.relayID)
    settle(entry, new McpRelayError("agent_unavailable", "Agent could not be reached"))
  }

  const request = (input: McpRelayRequest) =>
    new Promise<McpResponse>((resolve, reject) => {
      const grant = input.grant
      const refused = input.signal?.aborted === true ? new McpRelayError("agent_unavailable", "Request was cancelled") : refusal(grant)
      if (refused !== undefined) return reject(refused)
      const clientKey = `${grant.principal.ownerID}\0${grant.principal.clientID}`
      if (!withinRate(clientKey)) return reject(new McpRelayError("rate_limited", "Too many requests"))
      if ((inflight.get(clientKey) ?? 0) >= RemoteLimits.maxPendingRequestsPerClient)
        return reject(new McpRelayError("rate_limited", "Too many in-flight requests"))
      const relayID = newID()
      const frame = JSON.stringify({
        type: "request",
        id: relayID,
        operation: "mcp.request",
        input: {
          body: input.body,
          headers: Object.fromEntries(mcpHeaderNames.flatMap((name) => (input.headers[name] === undefined ? [] : [[name, input.headers[name]]]))),
          principal: grant.principal,
          epoch: grant.epoch,
        },
      })
      if (frame.length > RemoteLimits.maxClientMessageChars) return reject(new McpRelayError("message_too_large", "Request exceeds the frame bound"))
      if (parseMcpRequest(frame) === undefined) return reject(new McpRelayError("invalid_message", "Request is not a valid MCP forward"))
      let closeAdmission!: () => void
      const closed = new Promise<void>((done) => { closeAdmission = done })
      const signal = input.signal
      const entry: Entry = {
        relayID,
        generation: agent?.generation ?? 0,
        deviceID: grant.principal.deviceID,
        grantID: grant.grantID,
        clientKey,
        closed,
        closeAdmission,
        resolve,
        reject,
        sent: false,
        done: false,
        chunks: [],
        chars: 0,
        timer: undefined,
        detach: () => signal?.removeEventListener("abort", onAbort),
      }
      const onAbort = () => failEntry(entry, "agent_unavailable", "Request was cancelled", true)
      signal?.addEventListener("abort", onAbort, { once: true })
      entry.timer = setTimeout(() => failEntry(entry, "agent_unavailable", "Request timed out", true), timeoutMs)
      entries.add(entry)
      inflight.set(clientKey, (inflight.get(clientKey) ?? 0) + 1)
      admission = admission.then(() => admit(entry, frame, grant))
    })

  const persistControl = async (current: AgentState, value: McpState, sequence: number): Promise<McpControlResult> => {
    if (agent !== current || current.controlSeq !== sequence) return "superseded"
    const failed = await Promise.resolve()
      .then(async () => {
        await deps.revokeGrants(current.info.deviceID, value.enabled ? value.epoch : undefined)
        await deps.persistState(current.info.agentID, value)
      })
      .then(() => false, () => true)
    if (failed) return "failed"
    if (agent !== current || current.controlSeq !== sequence) return "superseded"
    if (value.enabled) current.gate = { state: "open", epoch: value.epoch }
    trySend(current.info.agentID, JSON.stringify({ type: "mcp.state.ack", id: value.id, enabled: value.enabled, epoch: value.epoch }))
    return "acknowledged"
  }

  const parseResponse = (value: unknown): McpResponse | undefined => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
    const candidate = value as Record<string, unknown>
    if (Object.keys(candidate).some((key) => key !== "status" && key !== "contentType" && key !== "body")) return undefined
    if (typeof candidate.status !== "number" || !Number.isInteger(candidate.status) || candidate.status < 200 || candidate.status > 599) return undefined
    if (typeof candidate.contentType !== "string" || !jsonContentType.test(candidate.contentType) || typeof candidate.body !== "string") return undefined
    return { status: candidate.status, contentType: candidate.contentType, body: candidate.body }
  }

  const complete = (entry: Entry, value: unknown): McpResponseResult => {
    const parsed = parseResponse(value)
    if (parsed === undefined) return violation(entry, "internal_error", "Agent returned an invalid MCP response")
    settle(entry, parsed)
    return "accepted"
  }

  return {
    request,

    revoke: (input: { readonly deviceID: string; readonly grantID?: string }) =>
      failWhere(
        (entry) => entry.deviceID === input.deviceID && (input.grantID === undefined || entry.grantID === input.grantID),
        "unauthorized",
        "Grant was revoked",
        true,
      ),

    gate: () =>
      agent === undefined
        ? undefined
        : {
            agentID: agent.info.agentID,
            generation: agent.generation,
            state: agent.gate.state,
            open: agent.gate.state === "open",
            ...(agent.gate.state === "open" ? { epoch: agent.gate.epoch } : {}),
          },

    async setAgent(info: McpAgent, attachment?: McpAttachment) {
      if (agent !== undefined) failWhere((entry) => entry.generation === agent?.generation, "agent_unavailable", "Agent was replaced", false)
      const next: AgentState = { info, generation: (generation += 1), gate: { state: attachment === undefined ? "unknown" : "off" }, controlSeq: 0 }
      agent = next
      if (attachment === undefined || !attachment.enabled) return
      const valid = await Promise.resolve()
        .then(() => deps.validateGate({ agent: info, epoch: attachment.epoch }))
        .then((value) => value, () => false)
      if (agent !== next || next.controlSeq !== 0) return
      next.gate = valid ? { state: "open", epoch: attachment.epoch } : { state: "off" }
    },

    clearAgent(agentID: string) {
      const current = agent
      if (current === undefined || current.info.agentID !== agentID) return false
      failWhere((entry) => entry.generation === current.generation, "agent_unavailable", "Agent disconnected", false)
      current.controlSeq += 1
      agent = undefined
      return true
    },

    async handleState(agentID: string, value: McpState): Promise<McpControlResult> {
      const current = agent
      if (current === undefined || current.info.agentID !== agentID) return "stale"
      current.controlSeq += 1
      const sequence = current.controlSeq
      const previousEpoch = current.gate.state === "open" ? current.gate.epoch : undefined
      current.gate = { state: value.enabled ? "enabling" : "off" }
      const ofAgent = (entry: Entry) => entry.generation === current.generation
      if (!value.enabled) failWhere(ofAgent, "forbidden", "Relay MCP is off", true)
      else if (previousEpoch !== undefined && previousEpoch !== value.epoch) failWhere(ofAgent, "unauthorized", "Relay MCP grants were retired", true)
      const turn = controls.then(() => persistControl(current, value, sequence))
      controls = turn
      return turn
    },

    handleResponse(agentID: string, response: RemoteResponse): McpResponseResult {
      const entry = pending.get(response.id)
      if (agent === undefined || agent.info.agentID !== agentID || entry === undefined || entry.generation !== agent.generation) return "ignored"
      if (!response.ok) {
        if (entry.chunks.length > 0) return violation(entry, "internal_error", "Agent failed a chunked MCP response")
        settle(entry, new McpRelayError(response.error.code, response.error.message))
        return "accepted"
      }
      if (response.chunk === undefined) {
        if (entry.chunks.length > 0) return violation(entry, "internal_error", "Agent mixed chunked and unchunked MCP responses")
        return complete(entry, response.value)
      }
      if (typeof response.value !== "string" || response.chunk.index !== entry.chunks.length)
        return violation(entry, "internal_error", "Agent sent an out-of-order MCP response chunk")
      if (response.chunk.index >= RemoteLimits.maxChunksPerResponse || response.value.length > RemoteLimits.maxAgentMessageChars || entry.chars + response.value.length > maxResponseChars)
        return violation(entry, "message_too_large", "MCP response exceeds the relay bound")
      entry.chunks.push(response.value)
      entry.chars += response.value.length
      if (!response.chunk.last) return "accepted"
      return complete(entry, parseJson(entry.chunks.join("")))
    },
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const failureStatus: Partial<Record<RemoteErrorCode, number>> = {
  invalid_message: 400,
  unauthorized: 401,
  forbidden: 403,
  message_too_large: 413,
  rate_limited: 429,
  agent_unavailable: 503,
}

export type McpRelay = ReturnType<typeof createMcpRelay>

export async function routeMcpFrame(relay: Pick<McpRelay, "handleState" | "handleResponse">, agentID: string, raw: string): Promise<"handled" | "invalid" | "core"> {
  if (raw.length > RemoteLimits.maxAgentMessageChars) return "core"
  const type = frameType(raw)
  if (type === "mcp.state") {
    const state = parseMcpState(raw)
    if (state === undefined) return "invalid"
    await relay.handleState(agentID, state)
    return "handled"
  }
  if (type !== "response") return "core"
  const parsed = parseAgentMessage(raw)
  if (!parsed.ok || parsed.value.type !== "response") return "core"
  return relay.handleResponse(agentID, parsed.value) === "ignored" ? "core" : "handled"
}

export async function readBoundedText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string | undefined> {
  if (body === null) return ""
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let total = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) return text + decoder.decode()
    total += chunk.value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    text += decoder.decode(chunk.value, { stream: true })
  }
}

function frameType(raw: string) {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === "object" && value !== null && !Array.isArray(value) && "type" in value && typeof value.type === "string" ? value.type : undefined
  } catch {
    return undefined
  }
}

export function mcpFailureStatus(code: RemoteErrorCode) {
  return failureStatus[code] ?? 502
}

export function parseMcpForward(headers: Headers): { readonly grant: McpGrant; readonly headers: McpHeaders } | undefined {
  const ownerID = headers.get("x-ycoding-mcp-owner")
  const deviceID = headers.get("x-ycoding-mcp-device")
  const clientID = headers.get("x-ycoding-mcp-client")
  const grantID = headers.get("x-ycoding-mcp-grant")
  const epoch = headers.get("x-ycoding-mcp-epoch")
  const resource = headers.get("x-ycoding-mcp-resource")
  const accessExpiresAt = Number(headers.get("x-ycoding-mcp-expires"))
  if (!ownerID || !deviceID || !clientID || !grantID || !epoch || !resource || !Number.isSafeInteger(accessExpiresAt) || accessExpiresAt <= 0) return undefined
  return {
    grant: { grantID, epoch, resource, accessExpiresAt, principal: { ownerID, deviceID, clientID } },
    headers: Object.fromEntries(mcpHeaderNames.flatMap((name) => {
      const value = headers.get(name)
      return value === null ? [] : [[name, value]]
    })),
  }
}

export function createMcpAuthority(options: {
  readonly store: McpStore
  readonly authorizeDevice: (
    deviceID: string,
  ) => Promise<{ readonly ok: true; readonly value: { readonly userID: string } } | { readonly ok: false; readonly reason: string }>
  readonly now?: () => number
}) {
  const now = options.now ?? Date.now

  const deviceAuthority = async (deviceID: string, ownerID: string): Promise<McpAuthority> => {
    const admitted = await options.authorizeDevice(deviceID)
    if (!admitted.ok) return { ok: false, reason: admitted.reason }
    return admitted.value.userID === ownerID ? { ok: true } : { ok: false, reason: "not_owner" }
  }

  return {
    authorizeDevice: (principal: McpPrincipal) => deviceAuthority(principal.deviceID, principal.ownerID),

    authorize: async (grant: McpGrant): Promise<McpAuthority> => {
      const row = await options.store.findGrant(grant.grantID)
      if (row === undefined) return { ok: false, reason: "unknown_grant" }
      if (row.revokedAt !== undefined) return { ok: false, reason: "revoked_grant" }
      if (now() >= row.expiresAt) return { ok: false, reason: "expired_grant" }
      if (row.ownerID !== grant.principal.ownerID || row.deviceID !== grant.principal.deviceID || row.clientID !== grant.principal.clientID)
        return { ok: false, reason: "principal_mismatch" }
      if (row.resource !== grant.resource || row.scope !== mcpScope) return { ok: false, reason: "resource_mismatch" }
      if (row.epoch !== grant.epoch) return { ok: false, reason: "epoch_mismatch" }
      const device = await options.store.getDevice(row.deviceID)
      if (!device?.enabled) return { ok: false, reason: "mcp_disabled" }
      return device.epoch === grant.epoch ? { ok: true } : { ok: false, reason: "epoch_mismatch" }
    },

    validateGate: async (input: { readonly agent: McpAgent; readonly epoch: string }) => {
      const device = await options.store.getDevice(input.agent.deviceID)
      if (!device?.enabled || device.epoch !== input.epoch) return false
      return (await deviceAuthority(input.agent.deviceID, input.agent.ownerID)).ok
    },

    revokeGrants: (deviceID: string, keepEpoch?: string) =>
      keepEpoch === undefined ? options.store.deleteDeviceGrants(deviceID) : Promise.resolve(),

    persistState: (deviceID: string, state: McpState) =>
      options.store.setDevice({ deviceID, enabled: state.enabled, epoch: state.epoch, now: now() }),
  }
}
