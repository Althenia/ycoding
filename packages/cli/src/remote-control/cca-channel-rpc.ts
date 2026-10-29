import { MAX_NOISE_JSONRPC_MESSAGE_LEN, type CcaChannel } from "./cca-relay"
import {
  CcaProofJournalError,
  ccaProofRpcMethods,
  type CcaProofJournalObserver,
  type CcaProofJournalRecordInput,
  type CcaProofRpcMethod,
  type CcaProofRpcOutcome,
} from "./cca-proof-journal"
import {
  createCcaRpcSession,
  type CcaEnvironmentInfo,
  type CcaRpcHandler,
} from "./cca-executor-rpc"

export type { CcaChannel }

export type CcaChannelRpcErrorCode = "channel_send_failed" | "aborted"

const errorMessages: Record<CcaChannelRpcErrorCode, string> = {
  channel_send_failed: "CCA channel RPC send failed",
  aborted: "CCA channel RPC was aborted",
}

export class CcaChannelRpcError extends Error {
  readonly code: CcaChannelRpcErrorCode

  constructor(code: CcaChannelRpcErrorCode) {
    super(errorMessages[code])
    this.name = "CcaChannelRpcError"
    this.code = code
  }
}

export type CcaChannelEnvironmentInfo =
  | CcaEnvironmentInfo
  | (() => CcaEnvironmentInfo | Promise<CcaEnvironmentInfo>)

export interface RunCcaChannelRpcInput {
  readonly channel: CcaChannel
  readonly environmentInfo: CcaChannelEnvironmentInfo
  readonly handler: CcaRpcHandler
  readonly signal?: AbortSignal
  readonly onDiagnostic?: CcaProofJournalObserver
}

export interface CcaChannelRpcResult {
  readonly requests: number
  readonly responses: number
  readonly notifications: number
}

const MAX_ORDINARY_IN_FLIGHT = 64
const MAX_CONTROL_IN_FLIGHT = 64

const CONTROL_METHODS: ReadonlySet<string> = new Set([
  "process/signal",
  "process/terminate",
  "environment/info",
  "environment/status",
])

function isControlFrame(bytes: Uint8Array): boolean {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return false
  }
  let mentionsControl = false
  for (const controlMethod of CONTROL_METHODS) {
    if (text.includes(controlMethod)) {
      mentionsControl = true
      break
    }
  }
  if (!mentionsControl) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false
  const msg = parsed as Record<string, unknown>
  if (msg.id === undefined) return false
  if (!((typeof msg.id === "string" && msg.id.length <= 256) || Number.isSafeInteger(msg.id))) return false
  return typeof msg.method === "string" && CONTROL_METHODS.has(msg.method)
}

const DIAGNOSTIC_METHODS: ReadonlySet<string> = new Set(ccaProofRpcMethods)

const ERROR_OUTCOMES: ReadonlyMap<unknown, CcaProofRpcOutcome> = new Map<unknown, CcaProofRpcOutcome>([
  [-32600, "invalid_request"],
  [-32601, "method_not_found"],
  [-32602, "invalid_params"],
  [-32603, "internal_error"],
  [-32001, "permission_denied"],
])

function diagnosticMethod(value: unknown): CcaProofRpcMethod {
  return typeof value === "string" && DIAGNOSTIC_METHODS.has(value) ? (value as CcaProofRpcMethod) : "other"
}

function parseDiagnosticFrame(bytes: Uint8Array): Record<string, unknown> | undefined {
  if (bytes.byteLength > MAX_NOISE_JSONRPC_MESSAGE_LEN) return undefined
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function classifyRequest(bytes: Uint8Array): { method: CcaProofRpcMethod; resumeRequested?: boolean } {
  const message = parseDiagnosticFrame(bytes)
  const method = diagnosticMethod(message?.method)
  if (method !== "initialize") return { method }
  const params = message?.params
  const resume =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>).resumeSessionId
      : undefined
  return { method, resumeRequested: resume !== undefined && resume !== null }
}

function responseOutcome(bytes: Uint8Array): CcaProofRpcOutcome {
  const message = parseDiagnosticFrame(bytes)
  if (!message) return "other_error"
  if (message.error === undefined) return "result" in message ? "result" : "other_error"
  const error = message.error
  const code = error && typeof error === "object" ? (error as Record<string, unknown>).code : undefined
  return ERROR_OUTCOMES.get(code) ?? "other_error"
}

export async function runCcaChannelRpc(input: RunCcaChannelRpcInput): Promise<CcaChannelRpcResult> {
  const { channel, handler } = input

  const combined = new AbortController()
  const removers: (() => void)[] = []
  const forward = (signal: AbortSignal | undefined) => {
    if (!signal) return
    if (signal.aborted) {
      combined.abort()
      return
    }
    const onAbort = () => combined.abort()
    signal.addEventListener("abort", onAbort, { once: true })
    removers.push(() => signal.removeEventListener("abort", onAbort))
  }
  forward(channel.signal)
  forward(input.signal)

  let notifyAborted: () => void = () => {}
  const aborted = new Promise<void>((resolve) => {
    notifyAborted = resolve
  })
  if (combined.signal.aborted) notifyAborted()
  else combined.signal.addEventListener("abort", () => notifyAborted(), { once: true })

  let requests = 0
  let responses = 0
  let notifications = 0

  const observer = input.onDiagnostic
  let diagnosticsOpen = observer !== undefined
  let diagnosticFailed = false
  const emit = (record: CcaProofJournalRecordInput) => {
    if (!diagnosticsOpen || diagnosticFailed) return
    try {
      observer?.(record)
    } catch {
      diagnosticFailed = true
    }
  }
  const failedOutcome = (): CcaProofRpcOutcome => (input.signal?.aborted ? "aborted" : "send_failed")

  let outbound: Promise<void> = Promise.resolve()
  const enqueueSend = (bytes: Uint8Array): Promise<void> => {
    const run = outbound.then(() => channel.send(bytes))
    outbound = run.catch(() => {})
    return run
  }

  const session = createCcaRpcSession({
    environmentInfo:
      typeof input.environmentInfo === "function"
        ? input.environmentInfo
        : () => input.environmentInfo as CcaEnvironmentInfo,
    handler,
    signal: combined.signal,
    sendFrame: async (bytes) => {
      await enqueueSend(bytes)
      responses++
    },
    sendNotification: async (method, params) => {
      try {
        await enqueueSend(new TextEncoder().encode(JSON.stringify({ method, params })))
      } catch (error) {
        if (diagnosticsOpen) {
          emit({ phase: "rpc-notification", event: "failed", method: diagnosticMethod(method), outcome: failedOutcome() })
        }
        throw error
      }
      if (diagnosticsOpen) {
        emit({ phase: "rpc-notification", event: "completed", method: diagnosticMethod(method), outcome: "notification" })
      }
      notifications++
    },
  })

  const iterator = channel.messages[Symbol.asyncIterator]()
  let failure: CcaChannelRpcError | undefined
  let stopRequested = false

  let resolveFailed: () => void = () => {}
  const failed = new Promise<void>((resolve) => {
    resolveFailed = resolve
  })
  let resolveChanged: () => void = () => {}
  let changed = new Promise<void>((resolve) => {
    resolveChanged = resolve
  })
  const notifyChanged = () => {
    const resolve = resolveChanged
    changed = new Promise<void>((nextResolve) => {
      resolveChanged = nextResolve
    })
    resolve()
  }
  const recordFailure = () => {
    if (failure || combined.signal.aborted) return
    failure = new CcaChannelRpcError(input.signal?.aborted ? "aborted" : "channel_send_failed")
    resolveFailed()
    notifyChanged()
  }

  const tasks = new Set<Promise<void>>()
  let ordinaryInFlight = 0
  let controlInFlight = 0

  const spawn = (
    bytes: Uint8Array,
    control: boolean,
    diagnostic: { readonly method: CcaProofRpcMethod; readonly requests: number } | undefined,
  ) => {
    if (control) controlInFlight++
    else ordinaryInFlight++
    const task = (async () => {
      try {
        const out = await session.receive(bytes)
        for (const frame of out) {
          try {
            await enqueueSend(frame)
          } catch (error) {
            if (diagnostic) {
              emit({ phase: "rpc-response", event: "failed", method: diagnostic.method, outcome: failedOutcome(), requests: diagnostic.requests })
            }
            throw error
          }
          if (diagnostic) {
            emit({
              phase: "rpc-response",
              event: "completed",
              method: diagnostic.method,
              outcome: responseOutcome(frame),
              requests: diagnostic.requests,
            })
          }
          responses++
        }
      } catch {
        recordFailure()
      }
    })()
    tasks.add(task)
    void task.then(() => {
      tasks.delete(task)
      if (control) controlInFlight--
      else ordinaryInFlight--
      notifyChanged()
    })
  }

  const drainTasks = async () => {
    while (tasks.size > 0) {
      const settled = await Promise.allSettled([...tasks])
      for (const outcome of settled) {
        if (outcome.status === "rejected") recordFailure()
      }
    }
  }

  const returnIterator = () => {
    try {
      void Promise.resolve(iterator.return?.()).catch(() => {})
    } catch {}
  }

  try {
    outer: while (true) {
      if (combined.signal.aborted || failure) {
        stopRequested = true
        break
      }
      let step: IteratorResult<Uint8Array> | "aborted" | "failed"
      try {
        step = await Promise.race([
          iterator.next(),
          aborted.then(() => "aborted" as const),
          failed.then(() => "failed" as const),
        ])
      } catch {
        if (!channel.signal.aborted) {
          failure = new CcaChannelRpcError(input.signal?.aborted ? "aborted" : "channel_send_failed")
        }
        stopRequested = true
        break
      }
      if (step === "aborted" || step === "failed") {
        returnIterator()
        stopRequested = true
        break
      }
      if (step.done) break
      requests++
      const frameRequests = requests
      const request = observer ? classifyRequest(step.value) : undefined
      if (request) emit({ phase: "rpc-received", event: "observed", ...request, requests: frameRequests })
      const control = isControlFrame(step.value)
      while (control ? controlInFlight >= MAX_CONTROL_IN_FLIGHT : ordinaryInFlight >= MAX_ORDINARY_IN_FLIGHT) {
        const waited = await Promise.race([
          changed.then(() => "changed" as const),
          aborted.then(() => "aborted" as const),
          failed.then(() => "failed" as const),
        ])
        if (waited !== "changed" || combined.signal.aborted || failure) {
          returnIterator()
          stopRequested = true
          break outer
        }
      }
      if (combined.signal.aborted || failure) {
        stopRequested = true
        break
      }
      spawn(step.value, control, request && { method: request.method, requests: frameRequests })
    }
  } finally {
    if (stopRequested || combined.signal.aborted || failure) {
      const closing = session.close().catch(() => {})
      await drainTasks()
      await closing
    } else {
      await drainTasks()
      try {
        await session.close()
      } catch {}
    }
    await outbound
    diagnosticsOpen = false
    for (const remove of removers) remove()
  }

  if (failure) throw failure
  if (input.signal?.aborted && !channel.signal.aborted) throw new CcaChannelRpcError("aborted")
  if (diagnosticFailed) throw new CcaProofJournalError()
  return { requests, responses, notifications }
}
