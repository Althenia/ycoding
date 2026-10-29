import { expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { constants } from "node:fs"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { pathToFileURL } from "node:url"
import { WebSocketServer, type NodeWebSocket } from "ws"
import { decodeRelayMessageFrame, encodeRelayMessageFrame, frameMessage, MessageDecoder } from "../src/remote-control/cca-relay"

const reference = process.env.CCA_NOISE_REFERENCE_BIN ?? "/tmp/ycoding-cargo-target/release/cca-noise-reference"
const streamID = "550e8400-e29b-41d4-a716-446655440000"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid synthetic response")
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid synthetic text")
  return value
}

function lines(stream: Readable, consume: (value: unknown) => void, fail: (error: unknown) => void) {
  let buffered = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk: string) => {
    try {
      buffered += chunk
      if (buffered.length > 64 * 1024) throw new Error("Synthetic response exceeded bound")
      let end: number
      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        consume(JSON.parse(line))
      }
    } catch (error) { fail(error) }
  })
  stream.on("error", fail)
  stream.on("end", () => {
    if (buffered.length > 0) fail(new Error("Incomplete synthetic response"))
  })
}

async function bounded<T>(promise: Promise<T>, timeout = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("CCA lifetime parent guard expired")), timeout)
    })])
  } finally { clearTimeout(timer) }
}

function tracked(child: ChildProcess, label: "child" | "reference", events: string[], fail: (error: unknown) => void) {
  const stdout = child.stdout
  const stderr = child.stderr
  const stdin = child.stdin
  if (!stdout || !stderr || !stdin) throw new Error("Missing fixture process pipes")
  child.on("error", fail)
  let outputBytes = 0
  let errorBytes = 0
  stdout.on("data", (chunk: Buffer | string) => {
    outputBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length
    if (outputBytes > 256 * 1024) fail(new Error("Fixture stdout exceeded bound"))
  })
  stderr.on("data", (chunk: Buffer) => {
    errorBytes += chunk.length
    if (errorBytes > 256 * 1024) fail(new Error("Fixture stderr exceeded bound"))
  })
  stdout.on("error", fail)
  stderr.on("error", fail)
  const exited = once(child, "exit").then(([code, signal]) => {
    events.push(`${label}-exit`)
    return { code, signal }
  })
  const stdoutEOF = once(stdout, "end").then(() => events.push(`${label}-stdout-eof`))
  const stderrEOF = once(stderr, "end").then(() => events.push(`${label}-stderr-eof`))
  const completed = Promise.all([exited, stdoutEOF, stderrEOF]).then(([status]) => ({ ...status, errorBytes }))
  return { child, stdin, stdout, completed }
}

for (const mode of ["crypto", "runtime"] as const) {
  test(`genuine Noise ${mode} child completes work and exits naturally after cleanup`, async () => {
    await access(reference, constants.X_OK).catch(() => { throw new Error("CCA Noise reference executable is required") })
    const workspace = await mkdtemp(path.join(os.tmpdir(), "cca-lifetime-"))
    const root = path.join(workspace, "root")
    const home = path.join(workspace, "home")
    const processes: ChildProcess[] = []
    const peers = new Set<NodeWebSocket>()
    const completions: Promise<unknown>[] = []
    const failure = deferred<never>()
    const fail = (_error: unknown) => failure.reject(new Error("CCA lifetime fixture protocol failed"))
    const events: string[] = []
    const records: Record<string, unknown>[] = []
    let succeeded = false
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    const listening = new Promise<void>((resolve, reject) => {
      server.on("listening", resolve)
      server.on("error", reject)
    })
    const connected = deferred<NodeWebSocket>()
    server.on("connection", (socket) => { peers.add(socket); connected.resolve(socket) })
    server.on("error", fail)
    try {
      await Promise.all([mkdir(root), mkdir(home), bounded(listening)])
      await writeFile(path.join(root, "synthetic.txt"), "synthetic-lifetime-content\n")
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Missing loopback listener")
      const referenceChild = spawn(reference, [], { env: {}, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" })
      processes.push(referenceChild)
      const rust = tracked(referenceChild, "reference", events, fail)
      completions.push(rust.completed)
      const replies: ReturnType<typeof deferred<Record<string, unknown>>>[] = []
      lines(rust.stdout, (value) => {
        const reply = replies.shift()
        if (!reply) throw new Error("Unexpected reference response")
        const response = object(value)
        if (response.status !== "ok") throw new Error("Reference operation failed")
        reply.resolve(response)
      }, fail)
      const request = (command: Record<string, unknown>) => {
        const reply = deferred<Record<string, unknown>>()
        replies.push(reply)
        rust.stdin.write(JSON.stringify(command) + "\n")
        return reply.promise
      }
      const childProcess = spawn(process.execPath, [path.join(import.meta.dir, "fixture/cca-task-lifetime.ts"), mode, String(address.port), root, home], {
        cwd: path.join(import.meta.dir, ".."),
        env: {},
        stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      })
      processes.push(childProcess)
      const child = tracked(childProcess, "child", events, fail)
      completions.push(child.completed)
      const identityPipe = childProcess.stdio[3]
      if (!(identityPipe instanceof Readable)) throw new Error("Missing synthetic identity pipe")
      const identity = deferred<Record<string, unknown>>()
      lines(identityPipe, (value) => identity.resolve(object(value)), fail)
      const identityEOF = once(identityPipe, "end")
      completions.push(identityEOF)
      const diagnosticPipe = childProcess.stdio[4]
      if (!(diagnosticPipe instanceof Readable)) throw new Error("Missing lifetime diagnostic pipe")
      const diagnosticEOF = once(diagnosticPipe, "end").then(() => events.push("child-diagnostic-eof"))
      completions.push(diagnosticEOF)
      const ready = deferred<void>()
      const allowedEvents = new Set(["transport-ready", "socket-closed", "work-completed", "cleanup-completed", "main-returned", "before-exit"])
      lines(diagnosticPipe, (value) => {
        const entry = object(value)
        const event = text(entry.event)
        if (!allowedEvents.has(event)) throw new Error("Unexpected lifetime diagnostic")
        records.push(entry)
        events.push(event)
        if (event === "transport-ready") ready.resolve()
      }, fail)
      const flow = (async () => {
        const [peer, publicKey] = await Promise.all([connected.promise, identity.promise, ready.promise]).then(([socket, key]) => [socket, key] as const)
        const decoder = new MessageDecoder()
        const work = deferred<void>()
        let sequence = 0
        let incoming = Promise.resolve()
        let started = false
        let closed = false
        let readSent = false
        const send = async (value: unknown) => {
          const encrypted = await request({ command: "encrypt", plaintext_hex: Buffer.from(frameMessage(Buffer.from(JSON.stringify(value)))).toString("hex") })
          peer.send(encodeRelayMessageFrame({
            version: 1,
            stream_id: streamID,
            body: { kind: "data", data: { seq: sequence++, segment_index: 0, segment_count: 1, payload: Buffer.from(text(encrypted.ciphertext_hex), "hex") } },
          }))
        }
        const readProcess = async () => {
          if (!started || !closed || readSent) return
          readSent = true
          await send({ id: 4, method: "process/read", params: { processId: "synthetic-echo", afterSeq: 0, waitMs: 0 } })
        }
        peer.on("error", fail)
        peer.on("message", (data) => {
          incoming = incoming.then(async () => {
            const frame = decodeRelayMessageFrame(new Uint8Array(data))
            if (frame.body?.kind === "handshake") {
              await request({ command: "finish", response_hex: Buffer.from(frame.body.handshake.payload).toString("hex") })
              await send({ id: 1, method: "initialize", params: { clientName: "synthetic-lifetime-peer" } })
              return
            }
            if (frame.body?.kind !== "data") throw new Error("Unexpected lifetime frame")
            const decrypted = await request({ command: "decrypt", ciphertext_hex: Buffer.from(frame.body.data.payload).toString("hex") })
            for (const bytes of decoder.push(Buffer.from(text(decrypted.plaintext_hex), "hex"))) {
              const message = object(JSON.parse(Buffer.from(bytes).toString("utf8")))
              if (message.error !== undefined) throw new Error("Lifetime RPC rejected")
              if (message.id === 1) {
                expect(typeof object(message.result).sessionId).toBe("string")
                await send({ method: "initialized" })
                await send({ id: 2, method: "fs/readFile", params: { path: pathToFileURL(path.join(root, "synthetic.txt")).href } })
              } else if (message.id === 2) {
                expect(Buffer.from(text(object(message.result).dataBase64), "base64").toString("utf8")).toBe("synthetic-lifetime-content\n")
                await send({ id: 3, method: "process/start", params: { processId: "synthetic-echo", argv: ["/bin/echo", "synthetic-lifetime-echo"], cwd: pathToFileURL(root).href, env: {}, envPolicy: null } })
              } else if (message.id === 3) {
                expect(object(message.result).processId).toBe("synthetic-echo")
                started = true
                await readProcess()
              } else if (message.method === "process/closed") {
                expect(object(message.params).processId).toBe("synthetic-echo")
                closed = true
                await readProcess()
              } else if (message.id === 4) {
                const result = object(message.result)
                expect(result).toMatchObject({ exited: true, closed: true, exitCode: 0 })
                if (!Array.isArray(result.chunks)) throw new Error("Missing process output")
                const output = result.chunks.map((chunk: unknown) => object(chunk)).filter((chunk) => chunk.stream === "stdout").map((chunk) => Buffer.from(text(chunk.chunk), "base64").toString("utf8")).join("")
                expect(output).toBe("synthetic-lifetime-echo\n")
                work.resolve()
              } else if (message.method !== "process/output" && message.method !== "process/exited") {
                throw new Error("Unexpected lifetime RPC response")
              }
            }
          }).catch(fail)
        })
        const start = await request({ command: "start", responder_public_key: publicKey, environment_id: "synthetic-lifetime-environment", executor_registration_id: "synthetic-lifetime-registration", stream_id: streamID, payload_hex: Buffer.from("synthetic-authorization").toString("hex") })
        peer.send(encodeRelayMessageFrame({ version: 1, stream_id: streamID, body: { kind: "handshake", handshake: { payload: Buffer.from(text(start.request_hex), "hex") } } }))
        await work.promise
        await incoming
        rust.stdin.end()
        child.stdin.end("close\n")
        const [childResult, rustResult] = await Promise.all([child.completed, rust.completed, identityEOF, diagnosticEOF])
        expect(childResult).toEqual({ code: 0, signal: null, errorBytes: 0 })
        expect(rustResult).toEqual({ code: 0, signal: null, errorBytes: 0 })
      })()
      await bounded(Promise.race([flow, failure.promise]))
      const cleanup = records.find((entry) => entry.event === "cleanup-completed")
      expect(cleanup).toMatchObject({ channels: 1, requests: 5, responses: 4, acquired: 3, released: 3, socketClosed: true })
      expect(events).toContain("work-completed")
      expect(events).toContain("main-returned")
      expect(events).toContain("before-exit")
      expect(events).toContain("child-diagnostic-eof")
      expect(events.indexOf("socket-closed")).toBeLessThan(events.indexOf("cleanup-completed"))
      expect(events.indexOf("cleanup-completed")).toBeLessThan(events.indexOf("main-returned"))
      expect(events.indexOf("main-returned")).toBeLessThan(events.indexOf("before-exit"))
      for (const entry of records.filter((entry) => entry.event === "main-returned" || entry.event === "before-exit")) {
        expect(entry).toEqual({ event: entry.event, resourceStatus: "unavailable" })
      }
      console.info(JSON.stringify({ mode, events, childNaturalExit: true, referenceNaturalExit: true, childStdoutEOF: true, childStderrEOF: true, childDiagnosticEOF: true, referenceStdoutEOF: true, referenceStderrEOF: true }))
      succeeded = true
    } catch (error) {
      const tail = records.filter((entry) => entry.event === "main-returned" || entry.event === "before-exit").map((entry) => {
        const counts: Record<string, number> = {}
        for (const name of ["resourceTimers", "resourceSockets", "resourcePipes", "resourceProcesses", "resourceFilesystem", "resourceOther"]) {
          const value = entry[name]
          if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000) counts[name] = value
        }
        const resourceStatus = entry.resourceStatus === "available" || entry.resourceStatus === "unavailable" ? entry.resourceStatus : undefined
        return { event: entry.event, ...(resourceStatus === undefined ? {} : { resourceStatus }), ...counts }
      })
      console.info(JSON.stringify({ mode, events, tail, completed: false }))
      throw error
    } finally {
      const cleanupErrors: unknown[] = []
      if (!succeeded) for (const child of processes) {
        if (child.pid === undefined) continue
        try {
          if (process.platform === "win32") child.kill("SIGKILL")
          else process.kill(-child.pid, "SIGKILL")
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") cleanupErrors.push(error)
        }
      }
      for (const peer of peers) peer.terminate()
      try {
        await bounded(Promise.all(completions), 3_000)
      } finally {
        try {
          await bounded(new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())), 3_000)
        } finally {
          await rm(workspace, { recursive: true, force: true })
        }
      }
      if (cleanupErrors.length > 0) throw new Error("CCA lifetime test-owned process cleanup failed")
    }
  }, 25_000)
}
