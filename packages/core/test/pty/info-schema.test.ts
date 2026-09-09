import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Pty } from "@ycoding-ai/core/pty"

const sample = (pid: number) => ({
  id: "pty_01J5Y5H0AH4Q4NXJ6P4C3P5V2K",
  title: "demo",
  command: "cmd.exe",
  args: [],
  cwd: "C:\\",
  sessionID: "ses_test",
  status: "running",
  pid,
  generation: 1,
  size: { rows: 24, cols: 80 },
  control: { owner: "agent", fence: 1 },
  output: { startOffset: 0, endOffset: 0, truncated: false },
  limits: { maxRuntimeSeconds: 300, maxRetainedBytes: Pty.MAX_RETAINED_BYTES, maxInputBytes: Pty.MAX_INPUT_BYTES },
})

describe("Pty.Info", () => {
  test("accepts pid 0 (Windows ConPTY assigns the pid asynchronously)", () => {
    expect(Schema.decodeUnknownSync(Pty.Info)(sample(0)).pid).toBe(0)
  })

  test("accepts a positive pid", () => {
    expect(Schema.decodeUnknownSync(Pty.Info)(sample(48012)).pid).toBe(48012)
  })

  test("rejects a negative pid", () => {
    expect(() => Schema.decodeUnknownSync(Pty.Info)(sample(-1))).toThrow()
  })

  test("accepts an exit code for retained exited sessions", () => {
    const info = Schema.decodeUnknownSync(Pty.Info)({ ...sample(48012), status: "exited", exitCode: 4 })
    expect(info.exitCode).toBe(4)
  })
})
