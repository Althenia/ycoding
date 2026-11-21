import { expect, test } from "bun:test"
import { Schema } from "effect"
import path from "node:path"

const Receipt = Schema.Struct({
  settled: Schema.Boolean,
  ok: Schema.Boolean,
  cancelled: Schema.Boolean,
  incomplete: Schema.Boolean,
  writeFailed: Schema.Boolean,
  ownerError: Schema.Boolean,
  inputDestroyed: Schema.Boolean,
  outputDestroyed: Schema.Boolean,
  socketClosed: Schema.Boolean,
  listeners: Schema.Number,
  attempts: Schema.Number,
})

test.each(["eof", "abort", "flushed", "error", "late-error"])(
  "desktop stdout settles on %s without taking ownership of output",
  async (mode) => {
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dirname, "fixture/desktop-bridge-lifetime.ts"), mode],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(stderr).toBe("")
    const result = Schema.decodeUnknownSync(Receipt)(JSON.parse(stdout))
    expect(result).toMatchObject({
      settled: true,
      ok: mode === "flushed",
      cancelled: mode === "abort",
      incomplete: mode === "eof" || mode === "late-error",
      writeFailed: mode === "error",
      ownerError: mode === "error" || mode === "late-error",
      inputDestroyed: true,
      outputDestroyed: false,
      socketClosed: true,
      listeners: 0,
      attempts: 1,
    })
  },
)
