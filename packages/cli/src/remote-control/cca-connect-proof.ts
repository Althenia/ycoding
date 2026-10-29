import type { CcaExperimentState } from "./cca-executor-registration"
import {
  startCcaExecutorTransport,
  type CcaChannel,
  type CcaExecutorCredential,
  type CcaNoiseAcceptHandshakeInput,
  type CcaNoiseIdentity,
  type CcaNoiseTransport,
  type StartCcaExecutorTransportOptions,
} from "./cca-executor-transport"
import {
  CcaConnectProofError,
  ccaRelayRegisteredLine,
  emitCcaProofPreamble,
  trackCcaSocketOpen,
  validateCcaProofState,
  waitForAbort,
  type CcaWebSocketConnector,
} from "./cca-proof-common"

export { awaitWebSocketOpen, CcaConnectProofError } from "./cca-proof-common"
export type { CcaConnectProofErrorCode, CcaWebSocketConnector } from "./cca-proof-common"

export type CcaConnectProofResult = {
  readonly channels: number
  readonly messages: number
  readonly bytes: number
}

export type CcaConnectProofHandshakeInput<Identity extends CcaNoiseIdentity> = Omit<
  CcaNoiseAcceptHandshakeInput,
  "identity"
> & { readonly identity: Identity }

export type CcaConnectProofAcceptHandshake<Identity extends CcaNoiseIdentity> = (
  input: CcaConnectProofHandshakeInput<Identity>,
) => Promise<{ readonly response: Uint8Array; readonly transport: CcaNoiseTransport }>

export type CcaConnectProofStartTransport = (
  options: StartCcaExecutorTransportOptions,
) => Promise<{ close(): Promise<void> }>

export type RunCcaConnectProofInput<Identity extends CcaNoiseIdentity> = {
  readonly state: CcaExperimentState
  readonly credential: CcaExecutorCredential
  readonly identity: Identity
  readonly acceptHandshake: CcaConnectProofAcceptHandshake<Identity>
  readonly startTransport?: CcaConnectProofStartTransport
  readonly connectWebSocket?: CcaWebSocketConnector
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>
  readonly signal: AbortSignal
  readonly requireChannel: boolean
  readonly onStatus: (line: string) => void
  readonly socketOpenTimeoutMs?: number
}

export async function runCcaConnectProof<Identity extends CcaNoiseIdentity>(
  input: RunCcaConnectProofInput<Identity>,
): Promise<CcaConnectProofResult> {
  const executorID = validateCcaProofState(input.state, input.credential)
  if (input.signal.aborted) throw new CcaConnectProofError("aborted")

  emitCcaProofPreamble(input.onStatus, executorID)

  let channels = 0
  let messages = 0
  let bytes = 0
  let socketOpened = false
  const drains = new Set<Promise<void>>()

  const onChannel = (channel: CcaChannel) => {
    channels++
    input.onStatus(`cca-connect: channel=established channels=${channels}`)
    const drain = (async () => {
      try {
        for await (const message of channel.messages) {
          messages++
          bytes += message.byteLength
        }
      } catch {}
    })()
    drains.add(drain)
    void drain.finally(() => drains.delete(drain))
  }

  const connectWebSocket = trackCcaSocketOpen(input.connectWebSocket, {
    signal: input.signal,
    ...(input.socketOpenTimeoutMs === undefined ? {} : { timeoutMs: input.socketOpenTimeoutMs }),
    onOpen: () => {
      socketOpened = true
    },
  })

  const start = input.startTransport ?? startCcaExecutorTransport
  let handle: { close(): Promise<void> }
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
    throw new CcaConnectProofError(input.signal.aborted ? "aborted" : "transport_failed")
  }
  input.onStatus(ccaRelayRegisteredLine(socketOpened))

  let closed = false
  let closeFailed = false
  try {
    await waitForAbort(input.signal)
  } finally {
    if (!closed) {
      closed = true
      try {
        await handle.close()
      } catch {
        closeFailed = true
      }
    }
  }
  await Promise.allSettled([...drains])
  input.onStatus(`cca-connect: shutdown=clean channels=${channels} messages=${messages} bytes=${bytes}`)
  if (closeFailed) throw new CcaConnectProofError("transport_failed")
  if (input.requireChannel && channels === 0) throw new CcaConnectProofError("channel_required")
  return { channels, messages, bytes }
}
