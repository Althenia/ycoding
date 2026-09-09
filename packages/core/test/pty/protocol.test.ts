import { describe, expect, test } from "bun:test"
import { PtyProtocol } from "@ycoding-ai/core/pty/protocol"

describe("pty protocol", () => {
  test("drops invalid binary input frames and decodes valid ones", () => {
    expect(PtyProtocol.decodeInput("ready")).toBe("ready")
    expect(PtyProtocol.decodeInput(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeUndefined()
    expect(PtyProtocol.decodeInput(new TextEncoder().encode("hello"))).toBe("hello")
    expect(PtyProtocol.decodeInput(new TextEncoder().encode("hello").buffer)).toBe("hello")
  })

  test("encodes replay metadata as a 0x00-prefixed JSON control frame", () => {
    const frame = PtyProtocol.controlFrame({
      type: "replay",
      generation: 2,
      startOffset: 10,
      endOffset: 42,
      gap: false,
    })
    expect(frame[0]).toBe(0)
    expect(PtyProtocol.decodeServerFrame(frame)).toEqual({
      type: "control",
      value: { type: "replay", generation: 2, startOffset: 10, endOffset: 42, gap: false },
    })
  })

  test("frames output bytes unambiguously and splits replay into bounded chunks", () => {
    expect(PtyProtocol.chunks(new Uint8Array(), 0)).toEqual([])
    const big = new Uint8Array(PtyProtocol.REPLAY_CHUNK + 1).fill(120)
    const frames = PtyProtocol.chunks(big, 10)
    expect(frames.length).toBe(2)
    const first = frames[0]
    if (!first) throw new Error("Expected first replay frame")
    expect(first.startOffset).toBe(10)
    expect(first.endOffset).toBe(10 + PtyProtocol.REPLAY_CHUNK)
    const encoded = PtyProtocol.dataFrame(first.data)
    expect(PtyProtocol.decodeServerFrame(encoded)).toEqual({ type: "data", value: first.data })
  })

  test("rejects malformed and oversized frames", () => {
    expect(PtyProtocol.decodeInput("x".repeat(PtyProtocol.MAX_INPUT_BYTES + 1))).toBeUndefined()
    expect(PtyProtocol.decodeServerFrame(new Uint8Array([0, 123]))).toBeUndefined()
    expect(PtyProtocol.decodeServerFrame(new Uint8Array([2, 1]))).toBeUndefined()
  })
})
