const FRAME_BYTES = 1_048_576

function maximum(value: number) {
  if (!Number.isInteger(value) || value <= 0 || value > FRAME_BYTES) throw new Error("Invalid channel frame limit")
  return value
}

export function frame(payload: Uint8Array, maxBytes = FRAME_BYTES): Uint8Array {
  const limit = maximum(maxBytes)
  if (payload.length === 0 || payload.length > limit) throw new Error("Invalid channel frame size")
  const result = new Uint8Array(payload.length + 4)
  new DataView(result.buffer).setUint32(0, payload.length, true)
  result.set(payload, 4)
  return result
}

export class FrameReader {
  private readonly maxBytes: number
  private readonly header = new Uint8Array(4)
  private headerBytes = 0
  private body?: Uint8Array
  private bodyBytes = 0
  private active = false
  private failed = false

  constructor(maxBytes = FRAME_BYTES) {
    this.maxBytes = maximum(maxBytes)
  }

  push(chunk: Uint8Array): Uint8Array[] {
    return Array.from(this.read(chunk))
  }

  read(chunk: Uint8Array): IterableIterator<Uint8Array> {
    if (this.active || this.failed) throw new Error("Channel frame reader is unavailable")
    this.active = true
    const iterator = this.consume(chunk)
    let done = false
    return {
      next: () => {
        const result = iterator.next()
        done = !!result.done
        return result
      },
      return: () => {
        if (!done) {
          this.failed = true
          this.active = false
          done = true
        }
        return iterator.return(undefined)
      },
      throw: (error?: unknown) => {
        if (!done) {
          this.failed = true
          this.active = false
          done = true
        }
        return iterator.throw(error)
      },
      [Symbol.iterator]() {
        return this
      },
    }
  }

  private *consume(chunk: Uint8Array): Generator<Uint8Array, void, unknown> {
    let complete = false
    try {
      let offset = 0
      while (offset < chunk.length) {
        if (!this.body) {
          const count = Math.min(4 - this.headerBytes, chunk.length - offset)
          this.header.set(chunk.subarray(offset, offset + count), this.headerBytes)
          this.headerBytes += count
          offset += count
          if (this.headerBytes !== 4) continue
          const size = new DataView(this.header.buffer).getUint32(0, true)
          if (size === 0 || size > this.maxBytes) throw new Error("Invalid channel frame size")
          this.body = new Uint8Array(size)
          this.bodyBytes = 0
        }
        const count = Math.min(this.body.length - this.bodyBytes, chunk.length - offset)
        this.body.set(chunk.subarray(offset, offset + count), this.bodyBytes)
        this.bodyBytes += count
        offset += count
        if (this.bodyBytes !== this.body.length) continue
        const body = this.body
        this.body = undefined
        this.headerBytes = 0
        yield body
      }
      complete = true
    } finally {
      this.active = false
      if (!complete) this.failed = true
    }
  }

  finish() {
    if (this.active || this.failed) throw new Error("Channel frame reader is unavailable")
    if (this.headerBytes || this.body) throw new Error("Truncated channel frame")
  }
}
