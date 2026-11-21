import { expect, test } from "bun:test"
import { Schema } from "effect"
import path from "node:path"

const Receipt = Schema.Struct({ failed: Schema.Boolean, message: Schema.String, calls: Schema.Number })

test.each(["meeting", "serve"])("Node Meeting restriction covers %s before native spawn", async (mode) => {
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dirname, "fixture/node-meeting-boundary.ts"), mode],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
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
  const receipt = Schema.decodeUnknownSync(Receipt)(JSON.parse(stdout.trim().split("\n").at(-1)!))
  expect(receipt.failed).toBe(true)
  expect(receipt.message).toContain(
    "Meeting requires the native ycoding executable; it is not supported by the Node CLI.",
  )
  expect(receipt.calls).toBe(0)
})
