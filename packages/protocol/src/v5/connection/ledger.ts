import { LedgerClass } from "../../generated/v5/index.js"
import type { Scope } from "../../generated/v5/index.js"
import type { Budgets } from "./budgets.js"

export type Delivery = {
  ordinal: bigint
  bytes: number
  charge: number
  time: number
  consumed: boolean
  key?: string
  ticket?: bigint
  resyncScope?: Scope
}

export class Ledger {
  readonly sent: Delivery[] = []
  readonly received: Delivery[] = []
  sentOrdinal = 0n
  receivedOrdinal = 0n
  credited = 0n
  consumed = 0n
  grantSent = 0n
  grantBytes = 0
  grantTime?: number

  constructor(
    readonly kind: LedgerClass,
    public window: number,
  ) {}

  get handedBytes() {
    return this.sent.reduce((total, record) => total + record.bytes, 0)
  }
  get receivedBytes() {
    return this.received.reduce((total, record) => total + record.bytes, 0)
  }
  get outstandingBytes() {
    return this.received.reduce((total, record) => total + record.charge, 0)
  }

  credit(through: bigint, duplicate: boolean) {
    if (through < this.credited || through > this.sentOrdinal || (!duplicate && through === this.credited))
      return undefined
    if (through === this.credited) return 0
    const count = this.sent.findIndex((record) => record.ordinal === through)
    if (count < 0) return undefined
    const freed = this.sent.splice(0, count + 1).reduce((total, record) => total + record.bytes, 0)
    this.credited = through
    return freed
  }

  consume(ordinal: bigint, now: number) {
    const record = this.received.find((record) => record.ordinal === ordinal)
    if (!record || record.consumed) return undefined
    record.consumed = true
    const bytes = record.bytes
    record.bytes = 0
    const count = this.received.findIndex((record) => !record.consumed)
    const consumed = this.received.splice(0, count < 0 ? this.received.length : count)
    if (consumed.length) this.consumed = consumed[consumed.length - 1].ordinal
    if (bytes && this.kind !== LedgerClass.TINY) {
      this.grantBytes += bytes
      this.grantTime ??= now
    }
    return bytes
  }

  stalled(now: number, budgets: Budgets) {
    return !!this.sent.length && now - this.sent[0].time >= budgets.deliveryTimeoutMs
  }
}
