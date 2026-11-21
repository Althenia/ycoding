import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer, type Socket } from "node:net"
import { createInterface } from "node:readline"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { decodeRegexValue, regexProcessSource, REGEX_PROCESS_MARKER } from "../../codemode/src/internal/regex-process"
import { runtimeExecutable } from "../src/runtime-executable"

type Request = { method: string; pattern: string; flags: string; input: string; lastIndex: unknown; replacement?: string; limit?: number }

async function worker(args = ["-e", regexProcessSource, "--", REGEX_PROCESS_MARKER], bound = true) {
  const token = randomBytes(32).toString("hex")
  const sockets = new Set<Socket>()
  let lease: Socket | undefined
  const owner = createServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    let line = ""
    socket.on("error", () => undefined)
    socket.on("data", (bytes) => {
      line += bytes.toString()
      if (line.length > 65 || (line.includes("\n") && line !== token + "\n")) { socket.destroy(); return }
      if (line === token + "\n") {
        lease = socket
        socket.removeAllListeners("data")
        socket.write("ok\n")
      }
    })
  })
  let child: ReturnType<typeof spawn> | undefined
  let closed: Promise<number | null> | undefined
  let lines: ReturnType<typeof createInterface> | undefined
  let forced = false
  async function close() {
    const failures: unknown[] = []
    try {
      if (child && closed) {
        child.stdin!.end()
        try { await deadline(closed, "native process cleanup", 3_000) }
        catch (cause) {
          forced = true
          child.kill("SIGKILL")
          failures.push(cause)
          await deadline(closed, "forced native process cleanup", 3_000)
        }
      }
    } catch (cause) { failures.push(cause) }
    lines?.close()
    for (const socket of sockets) socket.destroy()
    try {
      if (owner.listening) await deadline(new Promise<void>((resolve, reject) => owner.close((error) => error ? reject(error) : resolve())), "owner listener cleanup", 3_000)
    } catch (cause) { failures.push(cause) }
    if (forced) failures.push(new Error("Native fixture required forced cleanup"))
    if (failures.length) throw new AggregateError(failures, "Native regex fixture cleanup failed")
  }
  try {
    owner.listen(0, "127.0.0.1")
    await deadline(once(owner, "listening"), "owner listener acquisition")
    const address = owner.address()
    if (!address || typeof address === "string") throw new Error("Owner lease has no address")
    const launched = spawn(await runtimeExecutable(), args, {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("YCODING_REGEX_"))),
      ...(bound ? { YCODING_REGEX_OWNER: `127.0.0.1:${address.port}`, YCODING_REGEX_TOKEN: token } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  })
    child = launched
    let spawnError: unknown
    child.once("error", (cause) => { spawnError = cause })
    child.stdin!.on("error", (cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EPIPE" && cause.code !== "ERR_STREAM_DESTROYED") spawnError ??= cause
    })
    closed = new Promise<number | null>((resolve, reject) => child!.once("close", (code) => spawnError ? reject(spawnError) : resolve(code)))
    void closed.catch(() => undefined)
    let stderr = ""
    let stdout = ""
    child.stderr!.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    child.stdout!.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
    lines = createInterface({ input: child.stdout! })
    const iterator = lines[Symbol.asyncIterator]()
    return {
    child: launched,
    get closed() { return deadline(closed!, "native process exit") },
    errors: () => stderr,
    output: () => stdout,
    loseOwner: () => { if (!lease) throw new Error("No authenticated owner lease"); lease.destroy() },
    async read() {
      const line = await deadline(iterator.next(), "native response frame")
      if (line.done) throw new Error(`Native worker exited without a frame (${stderr})`)
      return JSON.parse(line.value)
    },
    close,
  }
  } catch (cause) {
    try { await close() } catch (cleanup) { throw new AggregateError([cause, cleanup], "Native fixture acquisition and cleanup failed", { cause: cleanup }) }
    throw cause
  }
}

async function deadline<A>(operation: Promise<A>, name: string, timeout = 10_000): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${name} exceeded its fixture bound`)), timeout)
    })])
  } finally { clearTimeout(timer) }
}

async function cleanup(run: Awaited<ReturnType<typeof worker>>, cause?: unknown) {
  try { await run.close() } catch (failure) {
    if (cause !== undefined) throw new AggregateError([cause, failure], "Native regex body and cleanup failed", { cause: failure })
    throw failure
  }
}

async function usingWorker(run: Awaited<ReturnType<typeof worker>>, body: () => Promise<void>) {
  let failure: unknown
  try { await body() } catch (cause) { failure = cause }
  await cleanup(run, failure)
  if (failure !== undefined) throw failure
}

function nativePID(text: string) {
  const value: unknown = JSON.parse(text)
  if (typeof value !== "object" || value === null || !("pid" in value) || typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error("Invalid owned native PID record")
  return value.pid
}

const cases: Array<{ request: Request; result: unknown; lastIndex: unknown }> = [
  { request: { method: "exec", pattern: "a+", flags: "g", input: "baab", lastIndex: 1 }, result: Object.assign(["aa"], { index: 1, groups: undefined }), lastIndex: 3 },
  { request: { method: "test", pattern: "a+", flags: "y", input: "baab", lastIndex: 0 }, result: false, lastIndex: 0 },
  { request: { method: "match", pattern: "a", flags: "g", input: "aba", lastIndex: 2 }, result: ["a", "a"], lastIndex: 0 },
  { request: { method: "matchAll", pattern: ".", flags: "gu", input: "😀a", lastIndex: 0 }, result: [Object.assign(["😀"], { index: 0, groups: undefined }), Object.assign(["a"], { index: 2, groups: undefined })], lastIndex: 0 },
  { request: { method: "search", pattern: "a", flags: "g", input: "ba", lastIndex: "7" }, result: 1, lastIndex: "7" },
  { request: { method: "split", pattern: "(a)|(b)", flags: "", input: "xa", lastIndex: 4, limit: 4 }, result: ["x", "a", undefined, ""], lastIndex: 4 },
  { request: { method: "replace", pattern: "(?<x>a)", flags: "", input: "ba", lastIndex: 0, replacement: "$<x>-$`-$'-$&-$$" }, result: "ba-b--a-$", lastIndex: 0 },
  { request: { method: "replaceAll", pattern: "a", flags: "g", input: "aba", lastIndex: 2, replacement: "x" }, result: "xbx", lastIndex: 0 },
  { request: { method: "collect", pattern: "(?<x>a)(b)?", flags: "g", input: "aba", lastIndex: 4 }, result: [["ab", "a", "b", 0, { x: "a" }], ["a", "a", undefined, 2, { x: "a" }]], lastIndex: 0 },
]

test.each(cases)("native regex worker preserves $request.method transport semantics", async ({ request, result, lastIndex }) => {
  const run = await worker()
  await usingWorker(run, async () => {
    expect(await run.read()).toEqual({ ready: true })
    run.child.stdin.end(JSON.stringify(request) + "\n")
    const reply = await run.read()
    expect(decodeRegexValue(reply.result)).toEqual(result)
    expect(reply.lastIndex).toEqual(lastIndex)
    expect(await run.closed).toBe(0)
    expect(run.errors()).toBe("")
  })
}, 30_000)

test("native regex worker validates exact recipe and requires its owner lease before readiness", async () => {
  for (const [args, bound] of [
    [["-e", "throw new Error('not executable')", "--", REGEX_PROCESS_MARKER], true],
    [["-e", regexProcessSource, "invalid", REGEX_PROCESS_MARKER], true],
    [["-e", regexProcessSource, "--", "invalid"], true],
    [["-e", regexProcessSource, "--", REGEX_PROCESS_MARKER, "extra"], true],
    [["-e", regexProcessSource, "--", REGEX_PROCESS_MARKER], false],
  ] as const) {
    const run = await worker([...args], bound)
    await usingWorker(run, async () => {
      expect(await run.closed).not.toBe(0)
      expect(run.output()).toBe("")
      expect(run.errors()).not.toContain("throw new Error")
    })
  }
}, 40_000)

test("native regex operation errors stay framed and malformed JSON exits without an invented reply", async () => {
  const run = await worker()
  await usingWorker(run, async () => {
    expect(await run.read()).toEqual({ ready: true })
    for (const request of [
      { pattern: "(", flags: "", lastIndex: 0, method: "test", input: "a" },
      { pattern: "a", flags: "", lastIndex: 0, method: "replaceAll", input: "a", replacement: "x" },
    ]) {
      run.child.stdin.write(JSON.stringify(request) + "\n")
      expect((await run.read()).error.name).toBe(request.method === "test" ? "SyntaxError" : "TypeError")
    }
    run.child.stdin.end("{invalid\n")
    expect(await run.closed).toBe(1)
    expect(run.errors()).toBe("")
  })
}, 30_000)

test("native regex creator loss terminates idle worker while stdin remains open", async () => {
  const run = await worker()
  await usingWorker(run, async () => {
    expect(await run.read()).toEqual({ ready: true })
    run.loseOwner()
    expect(await run.closed).toBe(1)
    expect(run.child.signalCode).toBeNull()
    expect(run.errors()).toBe("")
  })
}, 30_000)

test.each(["idle", "computing"])("creator SIGKILL terminates native regex process while %s with its stdin held open", async (state) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-regex-creator-"))
  const report = path.join(directory, "pid.json")
  let child: ReturnType<typeof spawn> | undefined
  let closed: Promise<void> | undefined
  let lines: ReturnType<typeof createInterface> | undefined
  let nativePid: number | undefined
  let stderr = ""
  let failure: unknown
  try {
    const executable = await runtimeExecutable()
    child = spawn(process.execPath, [path.join(import.meta.dirname, "fixture/native-regex-creator.ts"), report], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, YCODING_RUNTIME_EXECUTABLE: executable },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let spawnFailure: unknown
    child.on("error", (cause) => { spawnFailure = cause })
    child.stdin!.on("error", (cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EPIPE" && cause.code !== "ERR_STREAM_DESTROYED") spawnFailure ??= cause
    })
    closed = new Promise<void>((resolve, reject) => child!.once("close", () => spawnFailure ? reject(spawnFailure) : resolve()))
    void closed.catch(() => undefined)
    lines = createInterface({ input: child.stdout! })
    child.stderr!.on("data", (bytes) => { stderr += bytes.toString() })
    const first = await deadline(lines[Symbol.asyncIterator]().next(), "creator readiness")
    expect(first.done, stderr).toBe(false)
    expect(JSON.parse(first.value!)).toEqual({ ready: true })
    nativePid = nativePID(await readFile(report, "utf8"))
    if (state === "computing") await deadline(new Promise<void>((resolve, reject) => child!.stdin!.write(JSON.stringify({
      pattern: "(a+)+$", flags: "", input: "a".repeat(32) + "!", lastIndex: 0, method: "test",
    }) + "\n", (cause) => cause ? reject(cause) : resolve())), "creator request write")
    expect(child.stdin!.writableEnded).toBe(false)
    child.kill("SIGKILL")
    await deadline(closed, "creator and inherited native pipes exit")
    expect(child.signalCode).toBe("SIGKILL")
    expect(() => process.kill(nativePid!, 0)).toThrow()
    expect(stderr).toBe("")
  } catch (cause) { failure = cause }
  const failures: unknown[] = failure === undefined ? [] : [failure]
  try {
    if (child && closed) {
      if (child.exitCode === null && child.signalCode === null) {
        failures.push(new Error("Creator fixture required forced cleanup"))
        child.kill("SIGKILL")
      }
      nativePid ??= await readFile(report, "utf8").then(nativePID,
        (cause: NodeJS.ErrnoException) => { if (cause.code === "ENOENT") return undefined; throw cause })
      if (nativePid !== undefined) {
        try {
          process.kill(nativePid, 0)
          failures.push(new Error("Native regex child survived its creator"))
          process.kill(nativePid, "SIGKILL")
        } catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) failures.push(cause) }
      }
      try { await deadline(closed, "creator forced cleanup", 3_000) } catch (cause) { failures.push(cause) }
    }
  } catch (cause) { failures.push(cause) }
  child?.stdin?.destroy()
  lines?.close()
  try { await rm(directory, { recursive: true, force: true }) } catch (cause) { failures.push(cause) }
  if (failures.length) {
    throw new AggregateError(failures, "Creator-lifetime body and cleanup failed")
  }
}, 40_000)
