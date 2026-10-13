import { WireLimit } from "../../generated/v5/index.js"

export const defaultBudgets = Object.freeze({
  clientFrameBytes: WireLimit.CLIENT_FRAME_BYTES,
  serverFrameBytes: WireLimit.SERVER_FRAME_BYTES,
  handshakeBytes: WireLimit.HANDSHAKE_BYTES,
  handshakeRetainedBytes: WireLimit.HANDSHAKE_RETAINED_BYTES,
  handshakeTimeoutMs: WireLimit.HANDSHAKE_TIMEOUT_MS,
  inlineBytes: WireLimit.INLINE_BODY_BYTES,
  pieceBytes: WireLimit.BULK_PIECE_BYTES,
  messageBytes: WireLimit.BULK_MESSAGE_BYTES,
  pieces: WireLimit.BULK_PIECES,
  transfers: WireLimit.BULK_TRANSFERS,
  eventBatchCount: WireLimit.EVENT_BATCH_COUNT,
  eventBatchBytes: WireLimit.EVENT_BATCH_BYTES,
  eventQueueCount: WireLimit.EVENT_QUEUE_COUNT,
  eventQueueBytes: WireLimit.EVENT_QUEUE_BYTES,
  eventWindowBytes: WireLimit.EVENT_WINDOW_BYTES,
  bulkWindowBytes: WireLimit.BULK_WINDOW_BYTES,
  normalWindowBytes: WireLimit.NORMAL_WINDOW_BYTES,
  normalQueueBytes: WireLimit.NORMAL_QUEUE_BYTES,
  tinyFrameBytes: WireLimit.TINY_FRAME_BYTES,
  tinyCount: WireLimit.TINY_QUEUE_COUNT,
  tinyBytes: WireLimit.TINY_QUEUE_BYTES,
  deliveryTimeoutMs: WireLimit.DELIVERY_TIMEOUT_MS,
  relayPeerBytes: WireLimit.RELAY_PEER_BYTES,
  pendingRequests: WireLimit.PENDING_REQUESTS,
  subscriptions: WireLimit.SUBSCRIPTIONS,
  clientRate: WireLimit.CLIENT_RATE,
  agentRate: WireLimit.AGENT_RATE,
  rateWindowMs: WireLimit.RATE_WINDOW_MS,
  tinyRate: WireLimit.TINY_RATE,
  tinyRateBytes: WireLimit.TINY_RATE_BYTES,
  creditBytes: 65536,
  creditDelayMs: 25,
  pingIntervalMs: 20000,
  interactiveCoalesceMs: 40,
  backgroundCoalesceMs: 750,
  eventToBulkRatio: 2,
})

export type Budgets = { [K in keyof typeof defaultBudgets]: number }
export type ConfigurableBudgets = Omit<
  Budgets,
  "clientFrameBytes" | "serverFrameBytes" | "handshakeBytes" | "handshakeRetainedBytes" | "handshakeTimeoutMs"
>

export class ReservationBudget {
  private retained = 0

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("reservation limit")
  }

  get used() {
    return this.retained
  }

  reserve(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit - this.retained) return false
    this.retained += bytes
    return true
  }

  release(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.retained) throw new Error("reservation release")
    this.retained -= bytes
  }
}
