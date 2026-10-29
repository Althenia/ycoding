import {
  CcaChannelRpcError,
  runCcaChannelRpc,
  type CcaChannelEnvironmentInfo,
} from "./cca-channel-rpc"
import type {
  CcaConnectProofAcceptHandshake,
  CcaConnectProofStartTransport,
} from "./cca-connect-proof"
import type { CcaExperimentState } from "./cca-executor-registration"
import {
  CcaConnectProofError,
  ccaRelayRegisteredLine,
  emitCcaProofPreamble,
  trackCcaSocketOpen,
  validateCcaProofState,
  waitForAbort,
  type CcaWebSocketConnector,
} from "./cca-proof-common"
import type { CcaRpcHandler } from "./cca-executor-rpc"
import {
  CcaProofJournalError,
  type CcaProofJournalObserver,
  type CcaProofJournalRecordInput,
} from "./cca-proof-journal"
import {
  startCcaExecutorTransport,
  type CcaChannel,
  type CcaExecutorCredential,
  type CcaNoiseIdentity,
} from "./cca-executor-transport"

export type CcaTaskProofHandler = CcaRpcHandler & { readonly close?: () => Promise<void> }

export interface RunCcaTaskProofInput<Identity extends CcaNoiseIdentity> {
  readonly state: CcaExperimentState
  readonly credential: CcaExecutorCredential
  readonly identity: Identity
  readonly acceptHandshake: CcaConnectProofAcceptHandshake<Identity>
  readonly handler: CcaTaskProofHandler
  readonly environmentInfo: CcaChannelEnvironmentInfo
  readonly startTransport?: CcaConnectProofStartTransport
  readonly connectWebSocket?: CcaWebSocketConnector
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>
  readonly signal: AbortSignal
  readonly requireChannel?: boolean
  readonly onStatus: (line: string) => void
  readonly onPhase?: CcaProofJournalObserver
  readonly socketOpenTimeoutMs?: number
}

export interface CcaTaskProofResult {
  readonly channels: number
  readonly requests: number
  readonly responses: number
  readonly notifications: number
}

export async function runCcaTaskProof<Identity extends CcaNoiseIdentity>(
  input: RunCcaTaskProofInput<Identity>,
): Promise<CcaTaskProofResult> {
  const executorID = validateCcaProofState(input.state, input.credential)
  if (input.signal.aborted) throw new CcaConnectProofError("aborted")

  emitCcaProofPreamble(input.onStatus, executorID)

  let observerFailed = false
  const observe = (record: CcaProofJournalRecordInput) => {
    try {
      input.onPhase?.(record)
    } catch {
      observerFailed = true
    }
  }
  let channels = 0
  let requests = 0
  let responses = 0
  let notifications = 0
  let socketOpened = false
  let stopping = false
  const bridges = new Set<Promise<void>>()

  const onChannel = (channel: CcaChannel) => {
    if (stopping) return
    channels++
    const channelNumber = channels
    input.onStatus(`cca-task: channel=established channels=${channels}`)
    observe({ phase: "channel-established", event: "observed", channels })
    const bridge = (async () => {
      try {
        const counts = await runCcaChannelRpc({
          channel,
          environmentInfo: input.environmentInfo,
          handler: input.handler,
          signal: input.signal,
          ...(input.onPhase === undefined
            ? {}
            : { onDiagnostic: (record: CcaProofJournalRecordInput) => observe({ ...record, channels: channelNumber }) }),
        })
        requests += counts.requests
        responses += counts.responses
        notifications += counts.notifications
      } catch (error) {
        const code = error instanceof CcaChannelRpcError ? error.code : "channel_send_failed"
        input.onStatus(`cca-task: channel=closed code=${code}`)
      }
    })()
    bridges.add(bridge)
    void bridge.finally(() => bridges.delete(bridge))
  }

  const connectWebSocket = trackCcaSocketOpen(input.connectWebSocket, {
    signal: input.signal,
    ...(input.socketOpenTimeoutMs === undefined ? {} : { timeoutMs: input.socketOpenTimeoutMs }),
    onOpen: () => {
      socketOpened = true
      observe({ phase: "transport-open", event: "completed" })
    },
  })

  const start = input.startTransport ?? startCcaExecutorTransport
  let handle: { close(): Promise<void> } | undefined
  let transportClosed = false
  let closeFailed = false
  const closeTransport = async () => {
    if (transportClosed || !handle) return
    transportClosed = true
    try {
      await handle.close()
    } catch {
      closeFailed = true
    }
  }
  let handlerClosed = false
  const closeHandler = async () => {
    if (handlerClosed) return
    handlerClosed = true
    try {
      await input.handler.close?.()
    } catch {
      closeFailed = true
    }
  }

  let failure: CcaConnectProofError | undefined
  try {
    observe({ phase: "transport-start", event: "started" })
    try {
      handle = await start({
        environmentID: executorID,
        credential: input.credential,
        identity: input.identity,
        signal: input.signal,
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
        ...(connectWebSocket === undefined ? {} : { connectWebSocket }),
        acceptHandshake: (handshake) => input.acceptHandshake({ ...handshake, identity: input.identity }),
        onChannel,
      })
    } catch {
      failure = new CcaConnectProofError(input.signal.aborted ? "aborted" : "transport_failed")
      observe({ phase: "transport-start", event: "failed" })
    }
    if (handle) {
      observe({ phase: "transport-start", event: "completed" })
      input.onStatus(ccaRelayRegisteredLine(socketOpened))
      await waitForAbort(input.signal)
      observe({ phase: "abort-observed", event: "observed" })
    }
  } finally {
    stopping = true
    if (handle) {
      const transportCloseFailedBefore = closeFailed
      observe({ phase: "transport-close", event: "started" })
      await closeTransport()
      observe({
        phase: "transport-close",
        event: closeFailed && !transportCloseFailedBefore ? "failed" : "completed",
      })
    } else {
      await closeTransport()
    }
    observe({ phase: "bridge-drain", event: "started", bridges: bridges.size })
    await Promise.allSettled([...bridges])
    observe({ phase: "bridge-drain", event: "completed", bridges: 0 })
    const handlerCloseFailedBefore = closeFailed
    observe({ phase: "handler-close", event: "started" })
    await closeHandler()
    observe({
      phase: "handler-close",
      event: closeFailed && !handlerCloseFailedBefore ? "failed" : "completed",
    })
    await closeTransport()
  }

  if (!failure && !closeFailed && !observerFailed) {
    input.onStatus(
      `cca-task: channel=rpc requests=${requests} responses=${responses} notifications=${notifications}`,
    )
    input.onStatus(`cca-task: shutdown=clean channels=${channels}`)
  }
  if (failure) throw failure
  if (closeFailed) throw new CcaConnectProofError("transport_failed")
  if (input.requireChannel && channels === 0) throw new CcaConnectProofError("channel_required")
  if (observerFailed) throw new CcaProofJournalError()
  return { channels, requests, responses, notifications }
}
