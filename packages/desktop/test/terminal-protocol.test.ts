import { expect, test } from "bun:test"
import { PtyProtocol } from "../../core/src/pty/protocol"
import { decodeTerminalFrame, fromBase64, toBase64 } from "../src/terminal-protocol"

test("canonical PTY control and data frames decode to the same values", () => {
  const replay = { type: "replay", generation: 2, startOffset: 0, endOffset: 7, gap: false } as const
  const chunk = { type: "chunk", generation: 2, startOffset: 0, endOffset: 3 } as const
  const end = { type: "end", generation: 2, reason: "exit", exitCode: 0 } as const
  for (const control of [replay, chunk, end, { type: "end", generation: 1, reason: "overflow" } as const]) expect(decodeTerminalFrame(PtyProtocol.controlFrame(control))).toEqual({ type: "control", value: control })
  const data = new Uint8Array([0, 1, 27, 255])
  const decoded = decodeTerminalFrame(PtyProtocol.dataFrame(data))
  expect(decoded?.type).toBe("data")
  expect([...(decoded?.type === "data" ? decoded.value : [])]).toEqual([...data])
  expect(decodeTerminalFrame(new TextDecoder().decode(PtyProtocol.controlFrame(chunk)))).toEqual({ type: "control", value: chunk })
})

test("malformed or invalid frames decode to nothing", () => {
  const control = (value: unknown) => { const json = new TextEncoder().encode(JSON.stringify(value)); return new Uint8Array([0, ...json]) }
  for (const frame of [
    new Uint8Array([]),
    new Uint8Array([2, 1]),
    new Uint8Array([0, 123]),
    control({ type: "replay", generation: 0, startOffset: 0, endOffset: 0, gap: false }),
    control({ type: "replay", generation: 1, startOffset: 5, endOffset: 4, gap: false }),
    control({ type: "replay", generation: 1, startOffset: 0, endOffset: 4 }),
    control({ type: "chunk", generation: 1, startOffset: -1, endOffset: 4 }),
    control({ type: "end", generation: 1, reason: "crashed" }),
    control({ type: "end", generation: 1, reason: "exit", exitCode: 1.5 }),
    control({ type: "other", generation: 1 }),
  ]) expect(decodeTerminalFrame(frame)).toBeUndefined()
})

test("base64 conveys frame bytes losslessly", () => {
  const bytes = new Uint8Array(Array.from({ length: 256 }, (_, index) => index))
  expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes])
  expect(toBase64(new Uint8Array([]))).toBe("")
})
