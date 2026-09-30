export * as RemoteScheduler from "./remote-scheduler"

import { RemoteLimits, serializeEvents } from "@ycoding-ai/remote"

// Multiplexes every outbound agent frame over one paced connection. Frames fall
// into three delivery classes: control always goes first; event batches and bulk
// response slices then alternate two to one in favour of events when both wait,
// and either proceeds alone. Events rotate across sessions and bulk slices across
// in-flight responses, so no session or response starves another, while order
// within one session or one response is never changed.

const bulkBufferLimit = 256 * 1024

type Entry = {
  readonly frame: string
  readonly live: () => boolean
  readonly events: number
  readonly settle: (sent: boolean) => void
}

type Batch = {
  readonly sessionID: string
  readonly epoch: unknown
  readonly live: () => boolean
  readonly events: unknown[]
  size: number
  dueAt: number
  timer: ReturnType<typeof setTimeout>
}

export type Options = {
  readonly intervalMs: number
  readonly now: () => number
  /** Sends one frame and reports whether it was delivered. */
  readonly transmit: (frame: string) => Promise<boolean>
  readonly bufferedAmount: () => number | undefined
}

/** Length of an `events` frame carrying one event of `eventChars` serialized characters. */
export function eventsFrameLength(sessionID: string, eventChars: number) {
  return serializeEvents({ type: "events", sessionID, events: [] }).length + eventChars
}

export class Scheduler {
  private readonly controlQueue: Entry[] = []
  private readonly eventQueues = new Map<string, Entry[]>()
  private readonly bulkQueues = new Map<unknown, Entry[]>()
  private readonly open = new Map<string, Batch>()
  private eventTurns = 0
  private nextSendAt = 0
  private pumping = false
  private retry?: ReturnType<typeof setTimeout>
  private wake?: () => void
  private queued = 0

  constructor(private readonly options: Options) {}

  /** Events accepted but not yet sent, including those in an open batch. */
  get queuedEvents() {
    return this.queued
  }

  control(frame: string, live: () => boolean) {
    return new Promise<boolean>((settle) => {
      this.controlQueue.push({ frame, live, events: 0, settle })
      void this.pump()
    })
  }

  /** Queues one slice of the response identified by `stream`; slices of one stream keep their order. */
  bulk(stream: unknown, frame: string, live: () => boolean) {
    return new Promise<boolean>((settle) => {
      const entry = { frame, live, events: 0, settle }
      const queue = this.bulkQueues.get(stream)
      if (queue === undefined) this.bulkQueues.set(stream, [entry])
      else queue.push(entry)
      void this.pump()
    })
  }

  /** Adds `event`, of `chars` serialized characters, to the session's open batch. */
  event(sessionID: string, event: unknown, chars: number, epoch: unknown, live: () => boolean, windowMs: number) {
    let batch = this.open.get(sessionID)
    if (batch !== undefined && (batch.epoch !== epoch || !this.fits(batch, chars))) {
      this.flush(batch)
      batch = undefined
    }
    if (batch === undefined) batch = this.begin(sessionID, epoch, live, windowMs)
    batch.size += chars + (batch.events.length > 0 ? 1 : 0)
    batch.events.push(event)
    this.queued++
    if (batch.events.length >= RemoteLimits.maxEventBatch) this.flush(batch)
  }

  /** Shortens the wait of open batches whose session now has a shorter window. */
  retime(windowFor: (sessionID: string) => number) {
    for (const batch of this.open.values()) {
      const windowMs = windowFor(batch.sessionID)
      const dueAt = this.options.now() + windowMs
      if (dueAt >= batch.dueAt) continue
      clearTimeout(batch.timer)
      batch.dueAt = dueAt
      batch.timer = setTimeout(() => this.flush(batch), windowMs)
    }
  }

  /** Drops every queued frame and open batch; queued control and bulk senders observe `false`. */
  reset() {
    const dropped = [...this.controlQueue.splice(0), ...[...this.eventQueues.values()].flat(), ...[...this.bulkQueues.values()].flat()]
    this.eventQueues.clear()
    this.bulkQueues.clear()
    for (const batch of this.open.values()) clearTimeout(batch.timer)
    this.open.clear()
    clearTimeout(this.retry)
    this.retry = undefined
    this.queued = 0
    this.eventTurns = 0
    this.nextSendAt = 0
    this.wake?.()
    for (const entry of dropped) entry.settle(false)
  }

  private begin(sessionID: string, epoch: unknown, live: () => boolean, windowMs: number) {
    const batch: Batch = {
      sessionID,
      epoch,
      live,
      events: [],
      size: eventsFrameLength(sessionID, 0),
      dueAt: this.options.now() + windowMs,
      timer: setTimeout(() => this.flush(batch), windowMs),
    }
    this.open.set(sessionID, batch)
    return batch
  }

  private fits(batch: Batch, chars: number) {
    return batch.size + chars + 1 <= RemoteLimits.maxAgentMessageChars
  }

  private flush(batch: Batch) {
    if (this.open.get(batch.sessionID) !== batch) return
    clearTimeout(batch.timer)
    this.open.delete(batch.sessionID)
    const entry = {
      frame: serializeEvents({ type: "events", sessionID: batch.sessionID, events: batch.events }),
      live: batch.live,
      events: batch.events.length,
      settle: () => {},
    }
    const queue = this.eventQueues.get(batch.sessionID)
    if (queue === undefined) this.eventQueues.set(batch.sessionID, [entry])
    else queue.push(entry)
    void this.pump()
  }

  private async pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      for (;;) {
        if (!this.sendable()) {
          if (this.bulkQueues.size > 0 && this.retry === undefined)
            this.retry = setTimeout(() => {
              this.retry = undefined
              void this.pump()
            }, this.options.intervalMs)
          return
        }
        const delay = this.nextSendAt - this.options.now()
        if (delay > 0) await this.sleep(delay)
        const entry = this.take()
        if (entry === undefined) continue
        this.queued -= entry.events
        if (!entry.live()) {
          entry.settle(false)
          continue
        }
        const sent = await this.options.transmit(entry.frame)
        if (sent) this.nextSendAt = this.options.now() + this.options.intervalMs
        entry.settle(sent)
      }
    } finally {
      this.pumping = false
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms)
      this.wake = done
      function done() {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  private bulkReady() {
    return this.bulkQueues.size > 0 && (this.options.bufferedAmount() ?? 0) <= bulkBufferLimit
  }

  private sendable() {
    return this.controlQueue.length > 0 || this.eventQueues.size > 0 || this.bulkReady()
  }

  private take() {
    const control = this.controlQueue.shift()
    if (control !== undefined) return control
    if (this.eventQueues.size === 0) return this.bulkReady() ? rotate(this.bulkQueues) : undefined
    if (!this.bulkReady()) return rotate(this.eventQueues)
    if (this.eventTurns < 2) {
      this.eventTurns++
      return rotate(this.eventQueues)
    }
    this.eventTurns = 0
    return rotate(this.bulkQueues)
  }
}

function rotate<Key>(queues: Map<Key, Entry[]>) {
  for (const [key, queue] of queues) {
    const entry = queue.shift()
    queues.delete(key)
    if (queue.length > 0) queues.set(key, queue)
    return entry
  }
  return undefined
}
