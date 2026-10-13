import { V5ClientError } from "./error.js"

export class DeliveryStream<A> implements AsyncIterableIterator<A> {
  private queue: { values: A[]; index: number; release: () => void }[] = []
  private waiting?: { resolve: (value: IteratorResult<A>) => void; reject: (error: unknown) => void }
  private ended = false
  private error?: unknown
  private count = 0
  private bytes = 0
  private cleanup?: () => Promise<void>
  subscriptionID?: string

  constructor(
    readonly maxCount: number,
    readonly maxBytes: number,
  ) {}

  [Symbol.asyncIterator]() {
    return this
  }

  get capacity() {
    return { count: this.maxCount - this.count, bytes: this.maxBytes - this.bytes }
  }

  push(values: A[], bytes: number, release: () => void) {
    if (!values.length) {
      release()
      return
    }
    if (this.ended || this.error !== undefined) {
      release()
      return
    }
    if (values.length > this.capacity.count || bytes > this.capacity.bytes) {
      release()
      throw new V5ClientError("resync", undefined, "Event buffer limit")
    }
    this.count += values.length
    this.bytes += bytes
    this.queue.push({
      values,
      index: 0,
      release: () => {
        this.bytes -= bytes
        release()
      },
    })
    this.deliver()
  }

  onReturn(cleanup: () => Promise<void>) {
    this.cleanup = cleanup
  }

  end() {
    this.ended = true
    this.deliver()
  }

  fail(error: unknown) {
    if (this.error !== undefined) return
    this.error = error
    this.queue.forEach((entry) => entry.release())
    this.queue = []
    this.count = 0
    this.deliver()
  }

  next(): Promise<IteratorResult<A>> {
    if (this.waiting) return Promise.reject(new V5ClientError("unavailable", undefined, "One stream reader is allowed"))
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject }
      this.deliver()
    })
  }

  async return(): Promise<IteratorResult<A>> {
    this.queue.forEach((entry) => entry.release())
    this.queue = []
    this.count = 0
    this.ended = true
    this.deliver()
    const cleanup = this.cleanup
    this.cleanup = undefined
    await cleanup?.()
    return { done: true, value: undefined }
  }

  private deliver() {
    if (!this.waiting) return
    if (this.error !== undefined) {
      const waiting = this.waiting
      this.waiting = undefined
      waiting.reject(this.error)
      return
    }
    const entry = this.queue[0]
    if (entry && entry.index < entry.values.length) {
      const value = entry.values[entry.index++]
      this.count--
      if (entry.index === entry.values.length) {
        this.queue.shift()
        entry.release()
      }
      const waiting = this.waiting
      this.waiting = undefined
      waiting.resolve({ done: false, value })
      return
    }
    if (this.ended) {
      const waiting = this.waiting
      this.waiting = undefined
      waiting.resolve({ done: true, value: undefined })
    }
  }
}
