import { afterAll, afterEach, describe, expect, mock } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { AppProcess } from "@ycoding-ai/core/process"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Config } from "@ycoding-ai/core/config"
import { EventV2 } from "@ycoding-ai/core/event"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Shell } from "@ycoding-ai/core/shell"
import { ShellSandbox } from "@ycoding-ai/core/shell-sandbox"
import { Shell as ShellSchema } from "@ycoding-ai/schema/shell"
import { Duration, Effect, Fiber, Layer } from "effect"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

// The capture reader is mocked so a test can hold one read in flight while the capture settles.
// The delegate is captured from `node:fs` before the mock is installed, and only delivery is
// delayed: the read range, the bytes, and the settle path stay real.
const fsModule = await import("node:fs")
const realCreateReadStream = fsModule.createReadStream

type ReadGate = { readonly released: Promise<void>; readonly release: () => void }
let readGate: ReadGate | undefined

/** Holds the next capture read until `release`, so the caller's promise stays pending. */
function armReadGate() {
  const released = Promise.withResolvers<void>()
  const gate: ReadGate = {
    released: released.promise,
    release: () => {
      if (readGate === gate) readGate = undefined
      released.resolve()
    },
  }
  readGate = gate
  return gate
}

// A failing assertion must not leave a later test's capture read held.
afterEach(() => readGate?.release())

const gatedCreateReadStream = (...args: Parameters<typeof realCreateReadStream>) => {
  const stream = realCreateReadStream(...args)
  const gate = readGate
  if (!gate) return stream
  const delivery = new PassThrough()
  const chunks: Buffer[] = []
  let ended = false
  let released = false
  const deliver = () => {
    if (!ended || !released) return
    for (const chunk of chunks) delivery.write(chunk)
    delivery.end()
  }
  stream.on("data", (chunk: string | Buffer) => chunks.push(Buffer.from(chunk)))
  stream.on("end", () => {
    ended = true
    deliver()
  })
  stream.on("error", (error) => delivery.destroy(error))
  gate.released.then(() => {
    released = true
    deliver()
  })
  return delivery
}

mock.module("fs", () => ({ ...fsModule, createReadStream: gatedCreateReadStream }))

const workspace = await mkdtemp(join(tmpdir(), "ycoding-shell-output-"))
afterAll(() => rm(workspace, { recursive: true, force: true }))

const testLocation = location({ directory: AbsolutePath.make(workspace) })

const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({ shell: "/bin/sh", shell_sandbox: "disabled" }),
        }),
      ]),
  }),
)

const layer = AppNodeBuilder.build(
  LayerNode.group([
    AppProcess.node,
    Config.node,
    EventV2.node,
    Global.node,
    Location.node,
    ShellSandbox.node,
    Shell.node,
  ]),
  [
    [Config.node, config],
    [Global.node, Global.layerWith({ data: join(workspace, "data") })],
    [Location.node, Layer.succeed(Location.Service, Location.Service.of(testLocation))],
  ],
)

const it = testEffect(layer)

/**
 * Real captures are read through POSIX commands; the byte-exact cases have no Windows
 * equivalent here, while the cursor and zero-budget cases run everywhere.
 */
const posixIt = process.platform === "win32" ? it.live.skip : it.live

const replacement = "\uFFFD"

/**
 * Bytes a page can end inside: valid 2/3/4-byte characters, ill-formed sequences in every
 * position, and a three-byte character split across two parts.
 */
function boundaryFixture() {
  return Buffer.concat([
    Buffer.from("line one\n"),
    Buffer.from("é€😀", "utf8"),
    // A 3-byte lead whose continuation is ASCII. Trusting the lead width consumes the
    // following valid 2-byte character, corrupting both it and the ASCII byte.
    Buffer.from([0xe2, 0x41, 0xc3, 0xa9]),
    Buffer.from([0xe2, 0x82]),
    Buffer.from([0xac]),
    Buffer.from([0xf0, 0x9f, 0x41, 0xf0, 0x90, 0x80, 0x80]),
    Buffer.from([0x80, 0xc0, 0xaf, 0xed, 0xa0, 0x80, 0xf5, 0x80, 0x80, 0x80, 0x80]),
    Buffer.from([0xe0, 0x80, 0xaf, 0xc1, 0xbf, 0xef, 0xbf, 0xbd]),
    Buffer.from("done\n"),
  ])
}

function pseudoRandomBytes(length: number) {
  const bytes = Buffer.alloc(length)
  let state = 0x9e3779b9
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    bytes[index] = state >>> 24
  }
  return bytes
}

/** A valid 2/3/4-byte character with `phase` of its bytes before the 65536-byte page end. */
function straddlingBytes(width: 2 | 3 | 4, phase: number) {
  const character = width === 2 ? "é" : width === 3 ? "€" : "😀"
  return Buffer.from("a".repeat(65_536 - phase) + character + character.repeat(50) + "\n", "utf8")
}

/** Fails with the first divergence instead of printing a whole capture. */
function expectSameOutput(actual: string, expected: string, label: string) {
  if (actual === expected) return
  const shortest = Math.min(actual.length, expected.length)
  let at = 0
  while (at < shortest && actual[at] === expected[at]) at += 1
  throw new Error(
    `${label} differs at character ${at} of ${expected.length}: ` +
      `${JSON.stringify(actual.slice(at, at + 12))} instead of ${JSON.stringify(expected.slice(at, at + 12))}`,
  )
}

async function fixture(name: string, bytes: Buffer) {
  const file = join(workspace, name)
  await writeFile(file, bytes)
  return file
}

const createShell = (command: string) =>
  Effect.gen(function* () {
    const shell = yield* Shell.Service
    const prepared = yield* shell.prepare({ command, timeout: 0 })
    const info = yield* shell.create(prepared)
    return { shell, info }
  })

/** Pages from `start` to the captured end. Fails when a page does not advance. */
const readAll = (id: ShellSchema.ID, input: { readonly limit?: number; readonly start?: number } = {}) =>
  Effect.gen(function* () {
    const shell = yield* Shell.Service
    const pages: ShellSchema.Output[] = []
    let cursor = input.start ?? 0
    for (;;) {
      const page = yield* shell.output(id, { cursor, ...(input.limit === undefined ? {} : { limit: input.limit }) })
      pages.push(page)
      expect(page.cursor).toBeLessThanOrEqual(page.size)
      if (page.cursor >= page.size) return pages
      if (page.cursor <= cursor) throw new Error(`page did not advance: cursor ${page.cursor} size ${page.size}`)
      if (pages.length >= 8_192) throw new Error("paging did not terminate")
      cursor = page.cursor
    }
  })

const joined = (pages: readonly ShellSchema.Output[]) => pages.map((page) => page.output).join("")

/** Waits until the capture file holds `size` bytes, i.e. the running command's output is on disk. */
const waitForCapturedBytes = (file: string, size: number) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 15_000
    while ((yield* Effect.promise(() => stat(file))).size < size) {
      if (Date.now() >= deadline) return yield* Effect.die(new Error(`capture file never reached ${size} bytes`))
      yield* Effect.sleep(Duration.millis(20))
    }
  })

describe("Shell output", () => {
  posixIt("joins every page to the standard decoding of the captured bytes", () =>
    Effect.gen(function* () {
      const bytes = boundaryFixture()
      const file = yield* Effect.promise(() => fixture("boundary.bin", bytes))
      const { shell, info } = yield* createShell(`cat '${file}'`)
      yield* shell.wait(info.id)

      for (const limit of [...Array.from({ length: 32 }, (_, index) => index + 1), 65_536]) {
        const pages = yield* readAll(info.id, { limit })
        expect(pages.at(-1)?.size).toBe(bytes.length)
        expect(pages.at(-1)?.cursor).toBe(bytes.length)
        expectSameOutput(joined(pages), bytes.toString("utf8"), `limit=${limit}`)
      }
    }),
  )

  posixIt("keeps the bytes after a malformed sequence when a page ends inside it", () =>
    Effect.gen(function* () {
      const bytes = Buffer.concat([
        Buffer.from("a".repeat(10)),
        Buffer.from([0xe2, 0x41, 0xc3, 0xa9]),
        Buffer.from("z"),
      ])
      const file = yield* Effect.promise(() => fixture("malformed-then-valid.bin", bytes))
      const { shell, info } = yield* createShell(`cat '${file}'`)
      yield* shell.wait(info.id)

      for (const limit of [11, 12, 13]) {
        const output = joined(yield* readAll(info.id, { limit }))
        expectSameOutput(output, bytes.toString("utf8"), `limit=${limit}`)
        expect(output).toContain("Aéz")
      }
    }),
  )

  posixIt("pages a capture larger than the default limit without corrupting either region", () =>
    Effect.gen(function* () {
      const bytes = Buffer.concat([
        Buffer.from("é€😀x".repeat(4_000), "utf8"),
        boundaryFixture(),
        pseudoRandomBytes(24_000),
      ])
      const file = yield* Effect.promise(() => fixture("bulk.bin", bytes))
      const { shell, info } = yield* createShell(`cat '${file}'`)
      yield* shell.wait(info.id)

      for (const limit of [65_536, 4_096, 13]) {
        const pages = yield* readAll(info.id, { limit })
        expect(pages.at(-1)?.size).toBe(bytes.length)
        expectSameOutput(joined(pages), bytes.toString("utf8"), `limit=${limit}`)
      }
    }),
  )

  posixIt("completes a character that straddles the default page limit", () =>
    Effect.gen(function* () {
      for (const width of [2, 3, 4] as const) {
        for (let phase = 1; phase < width; phase += 1) {
          const bytes = straddlingBytes(width, phase)
          const file = yield* Effect.promise(() => fixture(`straddle-${width}-${phase}.bin`, bytes))
          const { shell, info } = yield* createShell(`cat '${file}'`)
          yield* shell.wait(info.id)
          const pages = yield* readAll(info.id)
          expect(pages.at(-1)?.size).toBe(bytes.length)
          // The page ends on the boundary the straddling character completes on, inside
          // the three-byte completion allowance.
          expect(pages[0]?.cursor).toBe(65_536 + (width - phase))
          expectSameOutput(joined(pages), bytes.toString("utf8"), `width=${width} phase=${phase}`)
        }
      }
    }),
  )

  posixIt("holds an incomplete live character without advancing until it completes", () =>
    Effect.gen(function* () {
      const shell = yield* Shell.Service
      const first = Buffer.concat([Buffer.from("live-"), Buffer.from([0xc3])])
      const second = Buffer.concat([Buffer.from([0xa9]), Buffer.from("-done\n")])
      const firstFile = yield* Effect.promise(() => fixture("live-first.bin", first))
      const secondFile = yield* Effect.promise(() => fixture("live-second.bin", second))
      const prepared = yield* shell.prepare({
        command: `cat '${firstFile}'; sleep 2; cat '${secondFile}'`,
        timeout: 0,
      })
      const info = yield* shell.create(prepared)

      const page = yield* Effect.gen(function* () {
        const deadline = Date.now() + 15_000
        for (;;) {
          const status = yield* Effect.map(shell.get(info.id), (current) => current.status)
          const current = yield* shell.output(info.id, { cursor: 0 })
          if (current.size === first.length && current.output === "live-") return current
          if (status !== "running") throw new Error("the live capture settled before its held page was read")
          if (Date.now() >= deadline) throw new Error("the live capture never served the held page")
          yield* Effect.sleep(Duration.millis(20))
        }
      })

      // The trailing lead byte is held back, so the page ends on the last complete
      // character. Re-reading at the held cursor returns nothing and does not advance
      // until the continuation bytes arrive.
      expect(page).toEqual({ output: "live-", cursor: 5, size: 6, truncated: false })
      expect(yield* shell.output(info.id, { cursor: page.cursor })).toEqual({
        output: "",
        cursor: page.cursor,
        size: 6,
        truncated: false,
      })

      yield* shell.wait(info.id)
      const rest = yield* readAll(info.id, { start: page.cursor })
      expect([page, ...rest].map((item) => item.output).join("")).toBe("live-é-done\n")
    }),
  )

  posixIt("keeps a completable trailing prefix when the capture settles during the read", () =>
    Effect.gen(function* () {
      const shell = yield* Shell.Service
      const prefix = Buffer.from("ready-")
      const lead = Buffer.from([0xc3])
      const tail = Buffer.from([0xa9, 0x64, 0x6f, 0x6e, 0x65, 0x0a])
      const bytes = Buffer.concat([prefix, lead, tail])
      const snapshot = prefix.length + lead.length
      const prefixFile = yield* Effect.promise(() => fixture("settle-prefix.bin", prefix))
      const leadFile = yield* Effect.promise(() => fixture("settle-lead.bin", lead))
      const tailFile = yield* Effect.promise(() => fixture("settle-tail.bin", tail))
      const gateFile = join(workspace, "settle-gate")

      // The command emits the prefix and a lead byte, then blocks: the capture is running with a
      // trailing incomplete character until the gate file appears.
      const prepared = yield* shell.prepare({
        command: `cat '${prefixFile}' '${leadFile}'; while [ ! -f '${gateFile}' ]; do sleep 0.05; done; cat '${tailFile}'`,
        timeout: 0,
      })
      const info = yield* shell.create(prepared)
      yield* waitForCapturedBytes(info.file, snapshot)

      const gate = armReadGate()
      const read = yield* Effect.forkScoped(shell.output(info.id, { cursor: 0, limit: snapshot }))
      // Release the command while the read is still outstanding, so the capture settles with
      // bytes beyond the read's size snapshot.
      yield* Effect.promise(() => writeFile(gateFile, ""))
      yield* shell.wait(info.id)
      expect(read.pollUnsafe()).toBeUndefined()
      expect((yield* shell.output(info.id, { cursor: 0, limit: 0 })).size).toBe(bytes.length)

      gate.release()
      const page = yield* Fiber.join(read)
      const pages = [page, ...(yield* readAll(info.id, { start: page.cursor, limit: snapshot }))]
      expect(pages.at(-1)?.cursor).toBe(bytes.length)
      expectSameOutput(joined(pages), bytes.toString("utf8"), "settled during read")
    }),
  )

  posixIt("decodes an incomplete trailing sequence once the capture has settled", () =>
    Effect.gen(function* () {
      const tails = [
        Buffer.concat([Buffer.from("ok\n"), Buffer.from([0xc3])]),
        Buffer.concat([Buffer.from("ok\n"), Buffer.from([0xf0, 0x9f, 0x98])]),
        Buffer.from([0x80]),
      ]
      for (const [index, bytes] of tails.entries()) {
        const file = yield* Effect.promise(() => fixture(`tail-${index}.bin`, bytes))
        const { shell, info } = yield* createShell(`cat '${file}'`)
        yield* shell.wait(info.id)
        const pages = yield* readAll(info.id, { limit: 8 })
        expect(pages.at(-1)?.cursor).toBe(bytes.length)
        expect({ index, output: joined(pages) }).toEqual({ index, output: bytes.toString("utf8") })
      }
    }),
  )

  posixIt("returns pages of exactly the requested budget when it lands on a boundary", () =>
    Effect.gen(function* () {
      const bytes = Buffer.from("x".repeat(64))
      const file = yield* Effect.promise(() => fixture("budget.bin", bytes))
      const { shell, info } = yield* createShell(`cat '${file}'`)
      yield* shell.wait(info.id)

      for (const limit of [1, 7, 13, 64]) {
        const first = yield* shell.output(info.id, { cursor: 0, limit })
        expect({ limit, output: first.output, cursor: first.cursor }).toEqual({
          limit,
          output: "x".repeat(limit),
          cursor: limit,
        })
      }
    }),
  )

  it.live("reads nothing for a zero limit and clamps a cursor at or past the captured end", () =>
    Effect.gen(function* () {
      const { shell, info } = yield* createShell("echo ycoding")
      yield* shell.wait(info.id)
      const size = yield* Effect.promise(async () => (await Bun.file(info.file).arrayBuffer()).byteLength)
      expect(size).toBeGreaterThan(0)

      expect(yield* shell.output(info.id, { cursor: 0, limit: 0 })).toEqual({
        output: "",
        cursor: 0,
        size,
        truncated: false,
      })
      expect(yield* shell.output(info.id, { cursor: 3, limit: 0 })).toEqual({
        output: "",
        cursor: 3,
        size,
        truncated: false,
      })
      expect(yield* shell.output(info.id, { cursor: size })).toEqual({
        output: "",
        cursor: size,
        size,
        truncated: false,
      })
      expect(yield* shell.output(info.id, { cursor: size + 10 })).toEqual({
        output: "",
        cursor: size,
        size,
        truncated: false,
      })
    }),
  )

  posixIt("advances from an arbitrary mid-character cursor with replacement characters", () =>
    Effect.gen(function* () {
      const bytes = Buffer.from("€x€", "utf8")
      const file = yield* Effect.promise(() => fixture("mid-character.bin", bytes))
      const { shell, info } = yield* createShell(`cat '${file}'`)
      yield* shell.wait(info.id)

      const mid = yield* shell.output(info.id, { cursor: 1 })
      expect(mid.size).toBe(bytes.length)
      expect(mid.cursor).toBeGreaterThan(1)
      expect(mid.output).toContain(replacement)
      const pages = yield* readAll(info.id, { start: mid.cursor, limit: 1 })
      expect(pages.at(-1)?.cursor).toBe(bytes.length)
    }),
  )
})
