import { expect, test } from "bun:test"
import { WireLimit } from "@ycoding-ai/protocol/v5"
import path from "node:path"
import { desktopFrames } from "../src/desktop-bridge"
import { frame } from "@ycoding-ai/protocol/v5/framing"
import { Schema } from "effect"

const Receipt = Schema.Struct({
  ok: Schema.Boolean,
  attempts: Schema.optional(Schema.Number),
  calls: Schema.optional(Schema.Array(Schema.Unknown)),
  failure: Schema.optional(Schema.String),
  reads: Schema.optional(Schema.Number),
})

async function rejects(operation: Promise<unknown>, message: string) {
  const failure = await operation.then(
    () => undefined,
    (cause: unknown) => cause,
  )
  expect(failure).toBeInstanceOf(Error)
  expect(failure instanceof Error ? failure.message : String(failure)).toContain(message)
}

async function chunks(values: Uint8Array[]) {
  return Array.fromAsync(
    desktopFrames(
      (async function* () {
        yield* values
      })(),
    ),
  )
}

test("desktop framing preserves split headers, split bodies and coalesced frames", async () => {
  const first = new Uint8Array([1, 2, 3])
  const second = new Uint8Array([4, 5])
  const bytes = new Uint8Array([...frame(first), ...frame(second)])
  expect(await chunks([bytes.slice(0, 1), bytes.slice(1, 5), bytes.slice(5)])).toEqual([first, second])
})

test.each([0, WireLimit.CLIENT_FRAME_BYTES + 1, 0xffffffff])(
  "desktop inbound length %s rejects before requesting body bytes",
  async (length) => {
    const header = new Uint8Array(4)
    new DataView(header.buffer).setUint32(0, length, true)
    let bodyRequested = false
    const input = (async function* () {
      yield header
      bodyRequested = true
      throw new Error("Body must not be requested")
    })()
    await rejects(Array.fromAsync(desktopFrames(input)), "frame size")
    expect(bodyRequested).toBe(false)
  },
)

test("desktop framing accepts the exact client bound and rejects partial EOF", async () => {
  const payload = new Uint8Array(WireLimit.CLIENT_FRAME_BYTES)
  expect(await chunks([frame(payload)])).toEqual([payload])
  await rejects(chunks([new Uint8Array([1])]), "Truncated")
  await rejects(chunks([frame(new Uint8Array([1, 2])).slice(0, 5)]), "Truncated")
})

async function fixture(mode: string) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dirname, "fixture/desktop-bridge.ts"), mode], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, stderr).toBe(0)
  expect(stderr).toBe("")
  return Schema.decodeUnknownSync(Receipt)(JSON.parse(stdout))
}

test.each(["managed", "external", "private"])(
  "desktop handler blocks %s resolution without verified caller authority",
  async (mode) => {
    const result = await fixture(mode)
    expect(result.ok).toBe(false)
    expect(result.failure).toContain("Desktop bridge is unavailable: authenticated caller binding is not supported")
    expect(result.calls).toEqual([])
    expect(result.attempts).toBe(0)
  },
)

test.each(["generic", "cleared", "malformed", "native-task", "claimed-human", "claimed-app"])(
  "desktop command denies unverified %s admission and forged identity frames before discovery",
  async (mode) => {
    const result = await fixture(`admission-${mode}`)
    expect(result.ok).toBe(false)
    expect(result.failure).toContain("Desktop bridge is unavailable: authenticated caller binding is not supported")
    expect(result.calls).toEqual([])
    expect(result.attempts).toBe(0)
    expect(result.reads).toBe(0)
  },
)

test("desktop handler rejects missing stdio before resolving a backend", async () => {
  const result = await fixture("no-stdio")
  expect(result.ok).toBe(false)
  expect(result.calls).toEqual([])
})

test.each(["index", "node", "tui"])(
  "real %s entry parses the desktop bridge command without backend activation",
  async (entry) => {
    const result = await fixture(`entry-${entry}`)
    expect(result.ok).toBe(true)
    expect(result.calls).toEqual([{ stdio: true, standalone: false, server: { _id: "Option", _tag: "None" } }])
  },
)

test.each(["index", "node", "tui"])(
  "real %s entry rejects desktop admission before discovery or transport",
  async (entry) => {
    const result = await fixture(`entry-admission-${entry}`)
    expect(result.ok).toBe(false)
    expect(result.failure).toContain("Desktop bridge is unavailable: authenticated caller binding is not supported")
    expect(result.calls).toEqual([])
    expect(result.attempts).toBe(0)
    expect(result.reads).toBe(0)
  },
)
