import { expect, test } from "bun:test"
import { WireLimit } from "../src/generated/v5/index.js"
import { frame, FrameReader } from "@ycoding-ai/protocol/v5/framing"

const header = (size: number) => {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, size, true)
  return bytes
}

test("framing encodes little-endian lengths and applies direction limits", () => {
  expect(frame(new Uint8Array([7, 8, 9]))).toEqual(new Uint8Array([3, 0, 0, 0, 7, 8, 9]))
  expect(frame(new Uint8Array(WireLimit.SERVER_FRAME_BYTES)).length).toBe(WireLimit.SERVER_FRAME_BYTES + 4)
  expect(() => frame(new Uint8Array(0))).toThrow()
  expect(() => frame(new Uint8Array(WireLimit.SERVER_FRAME_BYTES + 1))).toThrow()
  expect(frame(new Uint8Array(WireLimit.CLIENT_FRAME_BYTES), WireLimit.CLIENT_FRAME_BYTES).length).toBe(
    WireLimit.CLIENT_FRAME_BYTES + 4,
  )
  expect(() => frame(new Uint8Array(WireLimit.CLIENT_FRAME_BYTES + 1), WireLimit.CLIENT_FRAME_BYTES)).toThrow()
})

test("framing rejects invalid configured maximums", () => {
  for (const max of [0, -1, 1.5, NaN, Infinity, WireLimit.SERVER_FRAME_BYTES + 1]) {
    expect(() => new FrameReader(max)).toThrow()
    expect(() => frame(new Uint8Array([1]), max)).toThrow()
  }
})

test("framing reads fragmented and coalesced frames using both interfaces", () => {
  const bytes = new Uint8Array([1, 0, 0, 0, 42, 2, 0, 0, 0, 8, 9])
  const reader = new FrameReader()
  expect(reader.push(bytes.subarray(0, 2))).toEqual([])
  expect([...reader.read(bytes.subarray(2, 6))]).toEqual([new Uint8Array([42])])
  expect(reader.push(bytes.subarray(6))).toEqual([new Uint8Array([8, 9])])
  reader.finish()
  const coalesced = new FrameReader()
  expect(coalesced.push(bytes)).toEqual([new Uint8Array([42]), new Uint8Array([8, 9])])
  coalesced.finish()
})

test("framing rejects zero and oversized split headers before receiving bodies", () => {
  for (const size of [0, WireLimit.CLIENT_FRAME_BYTES + 1]) {
    const reader = new FrameReader(WireLimit.CLIENT_FRAME_BYTES)
    const bytes = header(size)
    expect(reader.push(bytes.subarray(0, 3))).toEqual([])
    expect(() => reader.push(bytes.subarray(3))).toThrow("Invalid channel frame size")
  }
  const valid = new FrameReader(WireLimit.CLIENT_FRAME_BYTES)
  expect(valid.push(header(WireLimit.CLIENT_FRAME_BYTES))).toEqual([])
  expect(valid.push(new Uint8Array(WireLimit.CLIENT_FRAME_BYTES))).toHaveLength(1)
  valid.finish()
  expect(() => new FrameReader().push(header(WireLimit.SERVER_FRAME_BYTES + 1))).toThrow("Invalid channel frame size")
})

test("framing detects partial header and body at EOF", () => {
  for (const bytes of [new Uint8Array([2, 0]), new Uint8Array([2, 0, 0, 0, 1])]) {
    const reader = new FrameReader()
    reader.push(bytes)
    expect(() => reader.finish()).toThrow("Truncated channel frame")
  }
  new FrameReader().finish()
})

test("framing iterator serializes access and fails closed on abandoned input", () => {
  const reader = new FrameReader()
  const iterator = reader.read(new Uint8Array([1, 0, 0, 0, 42, 1, 0, 0, 0, 9]))
  expect(iterator.next().value).toEqual(new Uint8Array([42]))
  expect(() => reader.read(new Uint8Array())).toThrow()
  expect(() => reader.push(new Uint8Array())).toThrow()
  expect(() => reader.finish()).toThrow()
  iterator.return?.()
  expect(() => reader.push(new Uint8Array())).toThrow()
  expect(() => reader.finish()).toThrow()
  const unopened = new FrameReader()
  unopened.read(new Uint8Array([1])).return?.()
  expect(() => unopened.finish()).toThrow()
  const sequential = new FrameReader()
  const finished = sequential.read(new Uint8Array())
  expect(finished.next().done).toBe(true)
  const current = sequential.read(new Uint8Array([1, 0, 0, 0, 9]))
  finished.return?.()
  expect(() => sequential.read(new Uint8Array())).toThrow()
  expect([...current]).toEqual([new Uint8Array([9])])
  sequential.finish()
})
