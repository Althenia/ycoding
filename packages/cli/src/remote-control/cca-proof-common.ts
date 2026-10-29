import { createHash } from "node:crypto"
import { safeExecutorSummary, type CcaExperimentState } from "./cca-executor-registration"
import type { CcaExecutorCredential, WebSocketLike } from "./cca-executor-transport"

export type CcaConnectProofErrorCode =
  | "state_not_completed"
  | "state_missing_executor"
  | "account_mismatch"
  | "aborted"
  | "transport_failed"
  | "channel_required"

const errorMessages: Record<CcaConnectProofErrorCode, string> = {
  state_not_completed: "CCA connect proof state is not completed",
  state_missing_executor: "CCA connect proof state is missing an executor",
  account_mismatch: "CCA connect proof credential does not match the registration state",
  aborted: "CCA connect proof was aborted",
  transport_failed: "CCA connect proof transport failed",
  channel_required: "CCA connect proof ended without an established channel",
}

export class CcaConnectProofError extends Error {
  readonly code: CcaConnectProofErrorCode

  constructor(code: CcaConnectProofErrorCode) {
    super(errorMessages[code])
    this.name = "CcaConnectProofError"
    this.code = code
  }
}

export function validateCcaProofState(state: CcaExperimentState, credential: CcaExecutorCredential): string {
  if (state.status !== "completed") throw new CcaConnectProofError("state_not_completed")
  const executorID = state.executorID?.trim()
  if (!executorID) throw new CcaConnectProofError("state_missing_executor")
  const accountHash = createHash("sha256").update(credential.accountID).digest("hex")
  if (accountHash !== state.accountHash) throw new CcaConnectProofError("account_mismatch")
  return executorID
}

export function emitCcaProofPreamble(onStatus: (line: string) => void, executorID: string) {
  const summary = safeExecutorSummary(executorID)
  onStatus(
    `cca-connect: state=completed executor_prefix=${summary.prefix} executor_sha256=${summary.sha256} executor_length=${summary.length}`,
  )
  onStatus("cca-connect: credential=resolved")
  onStatus("cca-connect: identity=ready")
}

export function ccaRelayRegisteredLine(socketOpened: boolean) {
  return socketOpened ? "cca-connect: relay=registered socket=open" : "cca-connect: relay=registered"
}

export function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

export type CcaWebSocketConnector = (
  url: string,
  headers: Record<string, string>,
) => WebSocketLike | Promise<WebSocketLike>

type OpenAwareSocket = WebSocketLike & {
  readonly readyState?: number
  off?(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
  removeEventListener?(event: string, listener: (...args: unknown[]) => void): void
}

export async function awaitWebSocketOpen(
  connect: CcaWebSocketConnector,
  url: string,
  headers: Record<string, string>,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<WebSocketLike> {
  const timeoutMs = options.timeoutMs ?? 15_000
  let socket: OpenAwareSocket | undefined
  return new Promise<WebSocketLike>((resolve, reject) => {
    let settled = false
    const onOpen = () => succeed()
    const onFailure = () => fail("transport_failed")
    const onAbort = () => fail("aborted")
    const timer = setTimeout(() => fail("transport_failed"), timeoutMs)
    timer.unref?.()

    function detach() {
      if (!socket) return
      const remove = socket.off ?? socket.removeListener ?? socket.removeEventListener
      if (!remove) return
      remove.call(socket, "open", onOpen)
      remove.call(socket, "error", onFailure)
      remove.call(socket, "close", onFailure)
    }
    function cleanup() {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      detach()
    }
    function succeed() {
      if (settled || !socket) return
      settled = true
      cleanup()
      resolve(socket)
    }
    function fail(code: CcaConnectProofErrorCode) {
      if (settled) return
      settled = true
      cleanup()
      try {
        socket?.close()
      } catch {}
      reject(new CcaConnectProofError(code))
    }

    if (options.signal?.aborted) {
      fail("aborted")
      return
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })

    void (async () => {
      try {
        socket = (await connect(url, headers)) as OpenAwareSocket
        if (settled) {
          try {
            socket.close()
          } catch {}
          return
        }
        if (socket.readyState === 1) {
          succeed()
          return
        }
        const attach = socket.on ?? socket.addEventListener
        if (!attach) {
          fail("transport_failed")
          return
        }
        attach.call(socket, "open", onOpen)
        attach.call(socket, "error", onFailure)
        attach.call(socket, "close", onFailure)
        if (socket.readyState === 1) succeed()
        else if (socket.readyState === 3) fail("transport_failed")
      } catch {
        fail(options.signal?.aborted ? "aborted" : "transport_failed")
      }
    })()
  })
}

export function trackCcaSocketOpen(
  connector: CcaWebSocketConnector | undefined,
  options: {
    readonly signal: AbortSignal
    readonly timeoutMs?: number
    readonly onOpen: () => void
  },
): CcaWebSocketConnector | undefined {
  if (!connector) return undefined
  return async (url, headers) => {
    const socket = await awaitWebSocketOpen(connector, url, headers, {
      signal: options.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
    options.onOpen()
    return socket
  }
}
