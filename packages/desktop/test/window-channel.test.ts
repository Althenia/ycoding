import { expect, test } from "bun:test"
import { windowChannel, type AppChannel, type ChannelOptions, type Failure } from "./window-channel"

const RESOURCES = "/synthetic/Fixture.app/Contents/Resources"
const OPEN = `${JSON.stringify({ type: "desktop.channel", state: "open", resources: RESOURCES })}\n`
const CLOSED = `${JSON.stringify({ type: "desktop.channel", state: "closed" })}\n`
const T = { start: 30_000, grace: 20_000, kill: 5_000, pump: 2_000, write: 10_000 }
const encoder = new TextEncoder()
const never = () => new Promise<void>(() => undefined)

function gate() {
  const open = new Set<number>()
  const waiting = new Map<number, (() => void)[]>()
  const requested: number[] = []
  return {
    requested,
    wait: (ms: number) => {
      requested.push(ms)
      return open.has(ms) ? Promise.resolve() : new Promise<void>((resolve) => { waiting.set(ms, [...(waiting.get(ms) ?? []), resolve]) })
    },
    release: (...values: number[]) => {
      for (const ms of values) {
        open.add(ms)
        for (const resolve of waiting.get(ms) ?? []) resolve()
        waiting.delete(ms)
      }
    },
  }
}

function fakeApp(options: { exitOnEnd?: boolean; stuck?: boolean; failWrite?: boolean; stall?: boolean; end?: "never" | "throw" } = {}) {
  const lines = new TransformStream<Uint8Array, Uint8Array>()
  const writer = lines.writable.getWriter()
  const exit = Promise.withResolvers<number>()
  const calls = { written: [] as string[], ended: 0, killed: 0 }
  const app: AppChannel = {
    stdin: {
      write: async (chunk) => {
        if (options.stall) return never()
        if (options.failWrite) throw new Error("synthetic write failure")
        calls.written.push(new TextDecoder().decode(chunk))
      },
      flush: async () => undefined,
      end: () => {
        calls.ended++
        if (options.end === "throw") throw new Error("synthetic end failure")
        if (options.end === "never") return never()
        if (options.exitOnEnd) exit.resolve(0)
        return Promise.resolve()
      },
    },
    stdout: lines.readable,
    exited: exit.promise,
    kill: () => { calls.killed++; if (!options.stuck) exit.resolve(137) },
  }
  return {
    app,
    calls,
    exit,
    send: (data: string | Uint8Array) => writer.write(typeof data === "string" ? encoder.encode(data) : data),
    eof: () => writer.close(),
  }
}

async function read(stream: NodeJS.ReadableStream) {
  let text = ""
  for await (const chunk of stream) text += String(chunk)
  return text
}

function put(channel: ReturnType<typeof windowChannel>, text: string) {
  return new Promise<boolean>((resolve) => { channel.output.write(text, (error) => resolve(error !== null && error !== undefined)) })
}

function open(app: AppChannel, wait: (ms: number) => Promise<void> = never, options: Omit<ChannelOptions, "resources"> = {}) {
  return windowChannel(app, { resources: RESOURCES, wait, ...options })
}

test("forwards valid frames, never forwards or counts markers, ends app input once on the closed marker", async () => {
  const fake = fakeApp({ exitOnEnd: true })
  const channel = open(fake.app)
  const collected = read(channel.input)
  await fake.send(OPEN)
  await fake.send('{"id":1,"operation":"state"}\n{"id":2,"oper')
  await fake.send('ation":"prompt","input":{}}\n')
  await fake.send(CLOSED)
  expect(await collected).toBe('{"id":1,"operation":"state"}\n{"id":2,"operation":"prompt","input":{}}\n')
  await fake.eof()
  await channel.close()
  expect(fake.calls).toMatchObject({ ended: 1, killed: 0 })
  expect(channel.result()).toEqual({ operations: { state: 1, prompt: 1 }, prompts: 1, failure: undefined, appExit: 0, killed: false })
})

test("a missing, late or non-open first line is a startup failure and the wrong resources are an identity failure", async () => {
  const wrong = `${JSON.stringify({ type: "desktop.channel", state: "open", resources: "/elsewhere/Resources" })}\n`
  const extra = `${JSON.stringify({ type: "desktop.channel", state: "open", resources: RESOURCES, extra: true })}\n`
  const cases: [string | undefined, Failure][] = [
    [undefined, "startup"],
    ['{"id":1,"operation":"state"}\n', "startup"],
    ["not json\n", "startup"],
    [CLOSED, "startup"],
    [extra, "startup"],
    [wrong, "resource-identity"],
  ]
  for (const [first, category] of cases) {
    const g = gate()
    g.release(T.pump, ...(first === undefined ? [T.start] : []))
    const fake = fakeApp({ exitOnEnd: true })
    const channel = open(fake.app, g.wait)
    const collected = read(channel.input)
    if (first !== undefined) await fake.send(first)
    await channel.settled
    expect(await collected).toBe("")
    expect(channel.result().failure).toBe(category)
  }
})

test("a second open marker or an unknown marker after open is a request-shape failure", async () => {
  for (const bad of [OPEN, `${JSON.stringify({ type: "desktop.channel", state: "paused" })}\n`]) {
    const g = gate()
    g.release(T.pump)
    const fake = fakeApp({ exitOnEnd: true })
    const channel = open(fake.app, g.wait)
    await fake.send(OPEN)
    await fake.send(bad)
    await channel.settled
    expect(channel.result().failure).toBe("request-shape")
  }
})

test("after the closed marker the app is still drained, later lines are discarded and the first failure code is kept", async () => {
  const fake = fakeApp({ exitOnEnd: true })
  const channel = open(fake.app)
  const collected = read(channel.input)
  await fake.send(OPEN)
  await fake.send(CLOSED)
  for (const line of [CLOSED, '{"id":1,"operation":"state"}\n', "not json\n"]) await fake.send(line)
  await fake.eof()
  expect(await collected).toBe("")
  await channel.close()
  expect(fake.calls.ended).toBe(1)
  expect(channel.result()).toMatchObject({ failure: undefined, operations: {}, appExit: 0 })
})

test("keeps consuming app output after a failure without forwarding and keeps the first failure", async () => {
  const fake = fakeApp({ exitOnEnd: true })
  const channel = open(fake.app)
  const collected = read(channel.input)
  await fake.send(OPEN)
  await fake.send("not json\n")
  for (let index = 0; index < 5; index++) await fake.send(`{"id":${index},"operation":"state"}\n`)
  await fake.send("a".repeat(200_000))
  await fake.eof()
  await channel.settled
  expect(await collected).toBe("")
  expect(channel.result()).toMatchObject({ failure: "request-shape", operations: {} })
})

test("refuses invalid JSON, extra keys, unsafe ids, non-string operations, invalid UTF-8 and empty frames after open", async () => {
  const frames: (string | Uint8Array)[] = [
    "not json\n",
    '{"id":1,"operation":"state","extra":true}\n',
    '{"id":9007199254740992,"operation":"state"}\n',
    '{"id":1.5,"operation":"state"}\n',
    '{"id":1,"operation":7}\n',
    '{"operation":"state"}\n',
    "[]\n",
    "\n",
    new Uint8Array([0xff, 0x0a]),
  ]
  for (const frame of frames) {
    const fake = fakeApp({ exitOnEnd: true })
    const channel = open(fake.app)
    const collected = read(channel.input)
    await fake.send(OPEN)
    await fake.send(frame)
    await fake.eof()
    await channel.settled
    expect(await collected).toBe("")
    expect(channel.result().failure).toBe("request-shape")
    expect(channel.result().operations).toEqual({})
  }
})

test("refuses complete and partial lines over the limit after open", async () => {
  for (const data of [`{"id":1,"operation":"state","input":"${"a".repeat(300)}"}\n`, "a".repeat(1_000)]) {
    const fake = fakeApp({ exitOnEnd: true })
    const channel = open(fake.app, never, { limit: 200 })
    const collected = read(channel.input)
    await fake.send(OPEN)
    await fake.send(data)
    await fake.eof()
    await channel.settled
    expect(await collected).toBe("")
    expect(channel.result().failure).toBe("line-limit")
  }
})

test("forwards valid worker replies and refuses credential keys, secret text and unknown reply types", async () => {
  const g = gate()
  g.release(T.pump)
  const good = fakeApp({ exitOnEnd: true })
  const accepted = open(good.app, g.wait)
  expect(await put(accepted, '{"type":"reply","id":1,"data":null}\n')).toBe(false)
  expect(good.calls.written).toEqual(['{"type":"reply","id":1,"data":null}\n'])
  await accepted.finish()

  const cases: [string, Failure][] = [
    ['{"type":"event","data":{"nested":[{"PassWord":"x"}]}}\n', "credential"],
    ['{"type":"state","data":{"Authorization":"x"}}\n', "credential"],
    ['{"type":"reply","id":1,"data":{"auth":{}}}\n', "credential"],
    ['{"type":"reply","id":1,"data":"synthetic-secret-value"}\n', "credential"],
    ['{"type":"surprise"}\n', "response-shape"],
    ['{"id":1}\n', "response-shape"],
    ["not json\n", "response-shape"],
  ]
  for (const [text, category] of cases) {
    const fake = fakeApp({ exitOnEnd: true })
    const channel = open(fake.app, g.wait, { secrets: ["synthetic-secret-value"] })
    expect(await put(channel, text)).toBe(true)
    await channel.settled
    expect(fake.calls.written).toEqual([])
    expect(channel.result().failure).toBe(category)
  }
})

test("a sink write failure is a write failure and later writes are refused", async () => {
  const g = gate()
  g.release(T.pump)
  const fake = fakeApp({ exitOnEnd: true, failWrite: true })
  const channel = open(fake.app, g.wait)
  expect(await put(channel, '{"type":"reply","id":1,"data":null}\n')).toBe(true)
  await channel.settled
  expect(channel.result().failure).toBe("write")
  expect(await put(channel, "{}\n")).toBe(true)
})

test("a stalled stdin write times out after the write bound with an in-flight callback error", async () => {
  const g = gate()
  g.release(T.write, T.pump)
  const fake = fakeApp({ exitOnEnd: true, stall: true })
  const channel = open(fake.app, g.wait)
  expect(await put(channel, '{"type":"reply","id":1,"data":null}\n')).toBe(true)
  await channel.settled
  expect(channel.result().failure).toBe("write")
  expect(g.requested).toContain(T.write)
})

test("close rejects a held write callback exactly once without recording a failure", async () => {
  const fake = fakeApp({ exitOnEnd: true, stall: true })
  const channel = open(fake.app)
  const held = put(channel, '{"type":"reply","id":1,"data":null}\n')
  await fake.eof()
  await channel.close()
  expect(await held).toBe(true)
  expect(channel.result().failure).toBeUndefined()
})

test("applies the default start, grace, kill, pump and write bounds", async () => {
  const g = gate()
  g.release(T.grace, T.kill, T.pump)
  const fake = fakeApp()
  const channel = open(fake.app, g.wait)
  await fake.send(OPEN)
  await fake.send(CLOSED)
  await fake.eof()
  await put(channel, '{"type":"reply","id":1,"data":null}\n')
  await channel.close()
  expect(g.requested).toEqual(expect.arrayContaining([T.start, T.grace, T.kill, T.pump]))
  expect(fake.calls.killed).toBe(1)
  expect(channel.result()).toMatchObject({ failure: "app-unresponsive", killed: true, appExit: 137 })
})

test("app exit without stdout EOF ends the worker input and reports a held stdout", async () => {
  const g = gate()
  g.release(T.pump)
  const fake = fakeApp({ exitOnEnd: true })
  const channel = open(fake.app, g.wait)
  const collected = read(channel.input)
  await fake.send(OPEN)
  fake.exit.resolve(0)
  await channel.settled
  expect(await collected).toBe("")
  expect(channel.result()).toMatchObject({ failure: "stdout-held", appExit: 0, killed: false })
})

test("a hung exit is killed after the grace bound and the result records the kill", async () => {
  const g = gate()
  g.release(T.grace, T.kill, T.pump)
  const fake = fakeApp()
  const channel = open(fake.app, g.wait)
  await channel.close()
  expect(fake.calls.killed).toBe(1)
  expect(channel.result()).toMatchObject({ failure: "app-unresponsive", killed: true, appExit: 137 })
})

test("close settles even when the app ignores the kill and records no exit", async () => {
  const g = gate()
  g.release(T.grace, T.kill, T.pump)
  const fake = fakeApp({ stuck: true })
  const channel = open(fake.app, g.wait)
  await channel.close()
  expect(channel.result()).toMatchObject({ failure: "app-unresponsive", killed: true, appExit: undefined })
})

test("close cancels a backpressure wait when the worker never reads its input", async () => {
  const fake = fakeApp({ exitOnEnd: true })
  const channel = open(fake.app)
  await fake.send(OPEN)
  await fake.send(`{"id":1,"operation":"state","input":"${"a".repeat(200_000)}"}\n`)
  await fake.eof()
  await channel.close()
  expect(channel.result()).toMatchObject({ failure: undefined, killed: false, appExit: 0 })
})

test("a normal exit is not killed and app input ends once however many closes race", async () => {
  const fake = fakeApp()
  const channel = open(fake.app)
  const collected = read(channel.input)
  await fake.send(OPEN)
  await fake.eof()
  expect(await collected).toBe("")
  fake.exit.resolve(0)
  await Promise.all([channel.close(), channel.close()])
  await channel.close()
  expect(fake.calls).toMatchObject({ ended: 1, killed: 0 })
  expect(channel.result()).toMatchObject({ failure: undefined, killed: false, appExit: 0 })
})

test("worker output finishing ends app input exactly once and finishing again or after close returns", async () => {
  const g = gate()
  g.release(T.pump)
  const fake = fakeApp({ exitOnEnd: true })
  const channel = open(fake.app, g.wait)
  await channel.finish()
  await channel.finish()
  await channel.close()
  expect(fake.calls).toMatchObject({ ended: 1, killed: 0 })
  expect(channel.result().appExit).toBe(0)

  const later = fakeApp({ exitOnEnd: true })
  const closed = open(later.app, g.wait)
  await closed.close()
  await closed.finish()
  expect(later.calls.ended).toBe(1)
})

const yielded = () => new Promise<void>((resolve) => { setImmediate(resolve) })

async function flush() {
  for (let index = 0; index < 20; index++) await Promise.resolve()
}

async function unhandled(run: () => Promise<void>) {
  const seen: unknown[] = []
  const listener = (reason: unknown) => { seen.push(reason) }
  process.on("unhandledRejection", listener)
  try {
    await run()
    await yielded()
  } finally {
    process.off("unhandledRejection", listener)
  }
  return seen
}

test("an app exit after open closes the channel at once and discards everything the app sends afterwards", async () => {
  const fake = fakeApp({ exitOnEnd: true })
  const channel = open(fake.app)
  const collected = read(channel.input)
  await fake.send(OPEN)
  await yielded()
  fake.exit.resolve(0)
  await flush()
  await fake.send('{"id":1,"operation":"prompt","input":{}}\n')
  await fake.eof()
  await channel.settled
  expect(await collected).toBe("")
  expect(channel.result()).toEqual({ operations: {}, prompts: 0, failure: undefined, appExit: 0, killed: false })
  expect(await put(channel, '{"type":"reply","id":1,"data":null}\n')).toBe(true)
  expect(fake.calls.written).toEqual([])
})

test("an app exit before the open marker is a startup failure that settles the channel", async () => {
  const g = gate()
  g.release(T.pump)
  const fake = fakeApp()
  const channel = open(fake.app, g.wait)
  fake.exit.resolve(0)
  await channel.settled
  expect(channel.result()).toMatchObject({ failure: "startup", appExit: 0, killed: false })
})

test("a never-ending app input end is bounded by the write bound for close and for finish", async () => {
  for (const method of ["close", "finish"] as const) {
    const g = gate()
    g.release(T.write, T.grace, T.kill, T.pump)
    const fake = fakeApp({ end: "never" })
    const channel = open(fake.app, g.wait)
    await fake.eof()
    await channel[method]()
    expect(channel.result()).toMatchObject({ failure: "write", killed: true, appExit: 137 })
    expect(fake.calls).toMatchObject({ ended: 1, killed: 1 })
  }
})

test("a synchronous app input end failure is a write failure and neither close nor finish rejects", async () => {
  for (const method of ["close", "finish"] as const) {
    const g = gate()
    g.release(T.grace, T.kill, T.pump)
    const fake = fakeApp({ end: "throw" })
    const channel = open(fake.app, g.wait)
    await fake.eof()
    const seen = await unhandled(async () => { await channel[method]() })
    expect(seen).toEqual([])
    expect(channel.result()).toMatchObject({ failure: "write", killed: true, appExit: 137 })
  }
})

test("a stdout iterator that throws on creation fails the channel as held stdout without a rejection", async () => {
  const g = gate()
  g.release(T.grace, T.kill, T.pump)
  const fake = fakeApp({ exitOnEnd: true })
  const broken: AppChannel = { ...fake.app, stdout: { [Symbol.asyncIterator]: () => { throw new Error("synthetic iterator failure") } } }
  const seen = await unhandled(async () => {
    const channel = open(broken, g.wait)
    await channel.close()
    expect(channel.result().failure).toBe("stdout-held")
  })
  expect(seen).toEqual([])
})
