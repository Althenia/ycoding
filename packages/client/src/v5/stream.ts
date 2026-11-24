import { V5ClientError } from "./error.js"

export class DeliveryStream<A> implements AsyncIterableIterator<A> {
  private queue: { values: IterableIterator<A>; remaining: number; release: () => void }[] = []
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
      values: values.values(),
      remaining: values.length,
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
    this.error ??= error
    this.discard()
    this.deliver()
  }

  invalidate(error: unknown) {
    this.error ??= error
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
    this.ended = true
    this.discard()
    this.deliver()
    const cleanup = this.cleanup
    this.cleanup = undefined
    await cleanup?.()
    return { done: true, value: undefined }
  }

  private discard() {
    const queue = this.queue
    this.queue = []
    this.count = 0
    queue.forEach((entry) => entry.release())
  }

  private deliver() {
    if (!this.waiting) return
    const entry = this.queue[0]
    const item = entry?.values.next()
    if (entry && item && !item.done) {
      this.count--
      if (--entry.remaining === 0) {
        this.queue.shift()
        entry.release()
      }
      const waiting = this.waiting
      this.waiting = undefined
      waiting.resolve(item)
      return
    }
    if (this.error !== undefined) {
      const waiting = this.waiting
      this.waiting = undefined
      waiting.reject(this.error)
      return
    }
    if (this.ended) {
      const waiting = this.waiting
      this.waiting = undefined
      waiting.resolve({ done: true, value: undefined })
    }
  }
}
