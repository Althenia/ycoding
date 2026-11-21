import { expect, test } from "bun:test"
import { Schema } from "effect"
import path from "node:path"

const Receipt = Schema.Struct({
  ok: Schema.Boolean,
  sent: Schema.optional(Schema.Number),
  frames: Schema.optional(Schema.Number),
  exact: Schema.optional(Schema.Boolean),
  privateAuth: Schema.optional(Schema.Boolean),
  backpressuredWrites: Schema.optional(Schema.Number),
  drains: Schema.optional(Schema.Number),
  attempts: Schema.optional(Schema.Number),
})

async function fixture(mode: string) {
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dirname, "../test/fixture/desktop-bridge.ts"), mode],
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
  return Schema.decodeUnknownSync(Receipt)(JSON.parse(stdout))
}

test("desktop bridge forwards only unchanged strict v5 frames and retains backpressure without leaking auth", async () => {
  const result = await fixture("forward")
  expect(result).toMatchObject({ ok: true, sent: 1, frames: 1, exact: true, privateAuth: true, attempts: 1 })
  expect(result.backpressuredWrites).toBeGreaterThan(0)
  expect(result.drains).toBeGreaterThan(0)
})

test.each(["connect-error", "malformed", "text"])(
  "desktop bridge %s fails without reconnect or replay",
  async (mode) => {
    const result = await fixture(mode)
    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(1)
    expect(result.sent).toBeLessThanOrEqual(1)
  },
)
