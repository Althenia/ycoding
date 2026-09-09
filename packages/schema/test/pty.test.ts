import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Pty } from "../src/pty.js"

const running = {
  id: "pty_contract",
  sessionID: "ses_contract",
  title: "Owned terminal",
  command: "/bin/sh",
  args: [],
  cwd: "/tmp",
  status: "running",
  pid: 42,
  generation: 1,
  size: { rows: 24, cols: 80 },
  control: { owner: "agent", fence: 1 },
  output: { startOffset: 0, endOffset: 0, truncated: false },
  limits: {
    maxRuntimeSeconds: 300,
    maxRetainedBytes: Pty.MAX_RETAINED_BYTES,
    maxInputBytes: Pty.MAX_INPUT_BYTES,
  },
}

describe("Pty owned terminal contract", () => {
  test("requires Session ownership and exposes generation, fencing, geometry, retention, and limits", () => {
    expect(Schema.decodeUnknownSync(Pty.Info)(running as unknown) as unknown).toEqual(running)
    expect(() => Schema.decodeUnknownSync(Pty.Info)({ ...running, sessionID: undefined } as unknown)).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Pty.Info)({ ...running, size: { rows: 24, cols: Pty.MAX_COLS + 1 } } as unknown),
    ).toThrow()
  })

  test("requires ownership on create and bounds requested lifetime and geometry", () => {
    const decoded: unknown = Schema.decodeUnknownSync(Pty.CreateInput)({
      sessionID: "ses_contract",
      size: { rows: 40, cols: 120 },
      maxRuntimeSeconds: 60,
    } as unknown)
    expect(decoded).toEqual({ sessionID: "ses_contract", size: { rows: 40, cols: 120 }, maxRuntimeSeconds: 60 })
    expect(() => Schema.decodeUnknownSync(Pty.CreateInput)({})).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Pty.CreateInput)({
        sessionID: "ses_contract",
        maxRuntimeSeconds: Pty.MAX_RUNTIME_SECONDS + 1,
      } as unknown),
    ).toThrow()
  })

  test("models explicit user control and fenced mutations", () => {
    const decoded: unknown = Schema.decodeUnknownSync(Pty.ControlInput)({
      sessionID: "ses_contract",
      generation: 1,
      expectedFence: 1,
      action: "take",
    } as unknown)
    expect(decoded).toEqual({ sessionID: "ses_contract", generation: 1, expectedFence: 1, action: "take" })
    expect(
      Schema.decodeUnknownSync(Pty.UpdateInput)({
        sessionID: "ses_contract",
        generation: 1,
        expectedFence: 2,
        actor: "user",
        size: { rows: 40, cols: 120 },
      } as unknown),
    ).toMatchObject({ actor: "user", expectedFence: 2 })
  })
})
