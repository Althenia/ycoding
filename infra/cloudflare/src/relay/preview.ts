import {
  RemoteLimits,
  parseAgentMessage,
  parsePreviewAllocate,
  parsePreviewLease,
  parsePreviewRequest,
  parsePreviewResult,
  parsePreviewRevoke,
  parsePreviewState,
  previewOperation,
  sameOrigins,
  serializeCancel,
  type PreviewAllocate,
  type PreviewInput,
  type PreviewLease,
  type PreviewResult,
  type PreviewRevoke,
  type PreviewState,
  type RemoteResponse,
} from "../../../../packages/remote/src/index"

export type PreviewAgent = { readonly agentID: string; readonly ownerID: string; readonly deviceID: string }
export type PreviewDevice = { readonly ownerID: string; readonly deviceID: string }
export type PreviewDirectoryClient = {
  readonly allocate: (input: PreviewDevice & { readonly registration: string; readonly expiresAt: number; readonly origins: readonly string[] }) => Promise<
    { readonly state: "allocated"; readonly origin: string } | { readonly state: "exhausted" } | { readonly state: "rejected" }>
  readonly register: (input: PreviewDevice & { readonly ticketHash: string; readonly origin: string; readonly expiresAt: number; readonly leaseTag: string; readonly registration: string }) => Promise<boolean>
  readonly revoke: (input: PreviewDevice & { readonly ticketHash?: string; readonly registration?: string }) => Promise<void>
}
export type PreviewRelayDeps = {
  readonly origins: readonly string[]
  readonly directory?: PreviewDirectoryClient
  readonly send: (agentID: string, frame: string) => void
  readonly persist: (agentID: string, enabled: boolean) => void
  readonly authorizeDevice: (agent: PreviewAgent) => Promise<boolean>
  readonly now?: () => number
  readonly newID?: () => string
  readonly timeoutMs?: number
}
export type PreviewRoute = "handled" | "invalid" | "violation" | "core"

export class PreviewRelayError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "PreviewRelayError"
    this.status = status
  }
}

type AgentState = {
  readonly info: PreviewAgent
  readonly generation: number
  enabled: boolean
  windowStart: number
  windowCount: number
}

type Entry = {
  readonly relayID: string
  readonly generation: number
  readonly resolve: (value: PreviewResult) => void
  readonly reject: (error: PreviewRelayError) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly detach: () => void
  chunks: string[]
  chars: number
}

const maxPending = RemoteLimits.maxPendingRequestsPerClient
const maxResponseChars = RemoteLimits.maxAgentMessageChars * RemoteLimits.maxChunksPerResponse

export function createPreviewRelay(deps: PreviewRelayDeps) {
  const now = deps.now ?? Date.now
  const newID = deps.newID ?? (() => crypto.randomUUID().replaceAll("-", ""))
  const timeoutMs = deps.timeoutMs ?? 30_000
  const pool = deps.directory === undefined ? [] : deps.origins
  const pending = new Map<string, Entry>()
  let agent: AgentState | undefined
  let generation = 0
  let turn: Promise<unknown> = Promise.resolve()

  const trySend = (agentID: string, frame: string) => {
    try {
      deps.send(agentID, frame)
      return true
    } catch {
      return false
    }
  }

  const settle = (entry: Entry, outcome: PreviewResult | PreviewRelayError) => {
    if (pending.get(entry.relayID) !== entry) return
    pending.delete(entry.relayID)
    clearTimeout(entry.timer)
    entry.detach()
    if (outcome instanceof PreviewRelayError) entry.reject(outcome)
    else entry.resolve(outcome)
  }

  const cancel = (entry: Entry, status: number, message: string) => {
    if (agent !== undefined && agent.generation === entry.generation) trySend(agent.info.agentID, serializeCancel(entry.relayID))
    settle(entry, new PreviewRelayError(status, message))
  }

  const failGeneration = (target: number, message: string) => {
    for (const entry of Array.from(pending.values())) if (entry.generation === target) settle(entry, new PreviewRelayError(503, message))
  }

  const ordered = <Value>(operation: () => Promise<Value>) => {
    const next = turn.then(operation, operation)
    turn = next
    return next
  }

  const current = (agentID: string) => agent !== undefined && agent.info.agentID === agentID ? agent : undefined

  const withinRate = (state: AgentState) => {
    const time = now()
    if (time - state.windowStart >= RemoteLimits.clientRateWindowMs) {
      state.windowStart = time
      state.windowCount = 0
    }
    state.windowCount += 1
    return state.windowCount <= RemoteLimits.maxClientRequestsPerWindow
  }

  const handleState = (state: AgentState, frame: PreviewState) => ordered(async () => {
    const accepted = pool.length > 0 && sameOrigins(frame.origins, pool) &&
      await deps.directory!.revoke({ ownerID: state.info.ownerID, deviceID: state.info.deviceID }).then(() => true, () => false)
    if (agent !== state) return
    state.enabled = accepted
    deps.persist(state.info.agentID, accepted)
    trySend(state.info.agentID, JSON.stringify({ type: "preview.state.ack", id: frame.id, enabled: accepted }))
  })

  const handleAllocate = (state: AgentState, frame: PreviewAllocate) => ordered(async () => {
    const result = state.enabled
      ? await deps.directory!.allocate({ ownerID: state.info.ownerID, deviceID: state.info.deviceID, registration: frame.registration, expiresAt: frame.expiresAt, origins: pool })
        .then((value) => value, () => ({ state: "rejected" as const }))
      : { state: "rejected" as const }
    if (agent !== state) return
    trySend(state.info.agentID, JSON.stringify(result.state === "allocated"
      ? { type: "preview.allocate.ack", id: frame.id, origin: result.origin }
      : { type: "preview.allocate.ack", id: frame.id, reason: result.state }))
  })

  const handleLease = (state: AgentState, frame: PreviewLease) => ordered(async () => {
    const ok = state.enabled && pool.includes(frame.origin) && frame.expiresAt > now() &&
      await deps.directory!.register({ ticketHash: frame.ticketHash, ownerID: state.info.ownerID, deviceID: state.info.deviceID, origin: frame.origin,
        expiresAt: frame.expiresAt, leaseTag: frame.leaseTag, registration: frame.registration }).then((value) => value, () => false)
    if (agent !== state) return
    trySend(state.info.agentID, JSON.stringify({ type: "preview.lease.ack", id: frame.id, ok }))
  })

  const handleRevoke = (state: AgentState, frame: PreviewRevoke) => ordered(async () => {
    if (!state.enabled) return
    await deps.directory!.revoke({ ownerID: state.info.ownerID, deviceID: state.info.deviceID,
      ...(frame.ticketHash === undefined ? {} : { ticketHash: frame.ticketHash }), ...(frame.registration === undefined ? {} : { registration: frame.registration }) })
      .catch(() => undefined)
  })

  const complete = (entry: Entry, value: unknown) => {
    const result = parsePreviewResult(value)
    if (result === undefined) {
      cancel(entry, 502, "Agent returned an invalid preview response")
      return "violation" as const
    }
    settle(entry, result)
    return "handled" as const
  }

  const handleResponse = (state: AgentState, response: RemoteResponse): PreviewRoute => {
    const entry = pending.get(response.id)
    if (entry === undefined || entry.generation !== state.generation) return "core"
    if (!response.ok) {
      settle(entry, new PreviewRelayError(502, "Agent could not answer the preview request"))
      return "handled"
    }
    if (response.chunk === undefined) {
      if (entry.chunks.length > 0) {
        cancel(entry, 502, "Agent mixed chunked and unchunked preview responses")
        return "violation"
      }
      return complete(entry, response.value)
    }
    if (typeof response.value !== "string" || response.chunk.index !== entry.chunks.length || entry.chars + response.value.length > maxResponseChars) {
      cancel(entry, 502, "Agent sent an invalid preview response chunk")
      return "violation"
    }
    entry.chunks.push(response.value)
    entry.chars += response.value.length
    if (!response.chunk.last) return "handled"
    return complete(entry, parseJson(entry.chunks.join("")))
  }

  return {
    enabled: () => pool.length > 0,

    setAgent(info: PreviewAgent, advertised = false) {
      if (agent !== undefined) failGeneration(agent.generation, "Agent was replaced")
      agent = { info, generation: (generation += 1), enabled: advertised && pool.length > 0, windowStart: now(), windowCount: 0 }
    },

    clearAgent(agentID: string): PreviewAgent | undefined {
      const state = current(agentID)
      if (state === undefined) return undefined
      failGeneration(state.generation, "Agent disconnected")
      agent = undefined
      return state.info
    },

    purge(device: PreviewDevice): Promise<void> {
      if (pool.length === 0) return Promise.resolve()
      return ordered(() => deps.directory!.revoke({ ownerID: device.ownerID, deviceID: device.deviceID }))
    },

    async route(agentID: string, raw: string): Promise<PreviewRoute> {
      if (raw.length > RemoteLimits.maxAgentMessageChars || (pending.size === 0 && !raw.includes('"preview.'))) return "core"
      const type = frameType(raw)
      const state = current(agentID)
      if (type === "preview.state" || type === "preview.allocate" || type === "preview.lease" || type === "preview.revoke") {
        const frame = type === "preview.state" ? parsePreviewState(raw) : type === "preview.allocate" ? parsePreviewAllocate(raw)
          : type === "preview.lease" ? parsePreviewLease(raw) : parsePreviewRevoke(raw)
        if (frame === undefined || state === undefined) return "invalid"
        if (!withinRate(state)) return "violation"
        if (frame.type === "preview.state") await handleState(state, frame)
        else if (frame.type === "preview.allocate") await handleAllocate(state, frame)
        else if (frame.type === "preview.lease") await handleLease(state, frame)
        else await handleRevoke(state, frame)
        return "handled"
      }
      if (type !== "response" || state === undefined || pending.size === 0) return "core"
      const parsed = parseAgentMessage(raw)
      if (!parsed.ok || parsed.value.type !== "response") return "core"
      return handleResponse(state, parsed.value)
    },

    request(input: PreviewDevice & { readonly input: PreviewInput; readonly signal?: AbortSignal }): Promise<PreviewResult> {
      return new Promise<PreviewResult>((resolve, reject) => {
        const state = agent
        if (state === undefined) return reject(new PreviewRelayError(503, "No local agent is connected"))
        if (state.info.ownerID !== input.ownerID || state.info.deviceID !== input.deviceID) return reject(new PreviewRelayError(403, "Lease does not belong to this device"))
        if (!state.enabled) return reject(new PreviewRelayError(503, "The connected agent does not serve previews"))
        if (!pool.includes(input.input.origin)) return reject(new PreviewRelayError(403, "Lease origin is not a configured preview origin"))
        if (input.signal?.aborted) return reject(new PreviewRelayError(503, "Request was cancelled"))
        if (pending.size >= maxPending) return reject(new PreviewRelayError(503, "Too many preview requests"))
        const relayID = newID()
        const frame = JSON.stringify({ type: "request", id: relayID, operation: previewOperation, input: input.input })
        if (parsePreviewRequest(frame) === undefined) return reject(new PreviewRelayError(400, "Preview request is invalid"))
        const signal = input.signal
        const entry: Entry = {
          relayID,
          generation: state.generation,
          resolve,
          reject,
          timer: setTimeout(() => cancel(entry, 504, "Preview request timed out"), timeoutMs),
          detach: () => signal?.removeEventListener("abort", onAbort),
          chunks: [],
          chars: 0,
        }
        const onAbort = () => cancel(entry, 503, "Request was cancelled")
        signal?.addEventListener("abort", onAbort, { once: true })
        pending.set(relayID, entry)
        void deps.authorizeDevice(state.info).then((allowed) => allowed, () => false).then((allowed) => {
          if (pending.get(relayID) !== entry) return
          if (!allowed) return settle(entry, new PreviewRelayError(403, "Device is no longer authorized"))
          if (agent !== state) return settle(entry, new PreviewRelayError(503, "Agent was replaced"))
          if (!trySend(state.info.agentID, frame)) settle(entry, new PreviewRelayError(503, "Agent could not be reached"))
        })
      })
    },
  }
}

export type PreviewRelay = ReturnType<typeof createPreviewRelay>

function frameType(raw: string) {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === "object" && value !== null && !Array.isArray(value) && "type" in value && typeof value.type === "string" ? value.type : undefined
  } catch {
    return undefined
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
