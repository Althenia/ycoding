import { expect, test } from "bun:test"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import path from "node:path"
import { WebSocketServer, type NodeWebSocket } from "ws"
import { decodeRelayMessageFrame, encodeRelayMessageFrame, frameMessage, MessageDecoder } from "../src/remote-control/cca-relay"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("CCA close fixture exceeded its guard")), 5_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test("transport cleanup waits for actual socket closure after a completed channel exchange", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  const listening = new Promise<void>((resolve, reject) => {
    server.on("listening", resolve)
    server.on("error", reject)
  })
  const connected = deferred<NodeWebSocket>()
  const ready = deferred<void>()
  const exchanged = deferred<void>()
  const failed = deferred<never>()
  const events: string[] = []
  const records: Array<Record<string, unknown>> = []
  const peers = new Set<NodeWebSocket>()
  let child: ChildProcessWithoutNullStreams | undefined
  let exited: Promise<unknown> | undefined
  let stderr = ""
  let handshakeCompleted = false
  let initialized = false
  let peerPaused = false
  server.on("error", failed.reject)
  server.on("connection", (peer) => {
    peers.add(peer)
    peer.on("error", failed.reject)
    connected.resolve(peer)
    const decoder = new MessageDecoder()
    let sequence = 0
    const send = (value: unknown) => peer.send(encodeRelayMessageFrame({
      version: 1,
      stream_id: "550e8400-e29b-41d4-a716-446655440000",
      body: {
        kind: "data",
        data: {
          seq: sequence++,
          segment_index: 0,
          segment_count: 1,
          payload: frameMessage(new TextEncoder().encode(JSON.stringify(value))),
        },
      },
    }))
    peer.on("message", (data) => {
      try {
        const frame = decodeRelayMessageFrame(new Uint8Array(data))
        if (frame.body?.kind === "handshake") {
          handshakeCompleted = true
          send({ id: 1, method: "initialize", params: { clientName: "synthetic-close-peer" } })
          return
        }
        if (frame.body?.kind !== "data") throw new Error("Unexpected fixture frame")
        for (const bytes of decoder.push(frame.body.data.payload)) {
          const response = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
          if (response.error !== undefined) throw new Error("Fixture RPC rejected")
          if (response.id === 1) {
            initialized = true
            send({ method: "initialized" })
            send({ id: 2, method: "environment/info" })
          } else if (response.id === 2) {
            peer.pause()
            peerPaused = peer.isPaused
            exchanged.resolve()
          } else {
            throw new Error("Unexpected fixture RPC response")
          }
        }
      } catch (error) {
        failed.reject(error)
      }
    })
  })
  try {
    await bounded(listening)
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("Missing loopback address")
    const processHandle = spawn(process.execPath, [path.join(import.meta.dir, "fixture/cca-transport-close.ts"), String(address.port)], {
      cwd: path.join(import.meta.dir, ".."),
      stdio: ["pipe", "pipe", "pipe"],
    })
    child = processHandle
    processHandle.on("error", failed.reject)
    let buffered = ""
    processHandle.stdout.setEncoding("utf8")
    processHandle.stdout.on("data", (chunk: string) => {
      try {
        buffered += chunk
        if (buffered.length > 16_384) throw new Error("Fixture output exceeded its bound")
        let newline: number
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newline)
          buffered = buffered.slice(newline + 1)
          const record = JSON.parse(line) as Record<string, unknown>
          records.push(record)
          events.push(String(record.event))
          if (record.event === "transport-ready") ready.resolve()
        }
      } catch (error) {
        failed.reject(error)
      }
    })
    processHandle.stderr.setEncoding("utf8")
    processHandle.stderr.on("data", (chunk: string) => {
      stderr += chunk
      if (stderr.length > 16_384) failed.reject(new Error("Fixture stderr exceeded its bound"))
    })
    const processExited = once(processHandle, "exit").then(([code, signal]) => {
      events.push("child-exit")
      return { code, signal }
    })
    exited = processExited
    const stdoutEnded = once(processHandle.stdout, "end").then(() => events.push("stdout-eof"))
    const stderrEnded = once(processHandle.stderr, "end").then(() => events.push("stderr-eof"))
    const result = await bounded(Promise.race([
      (async () => {
        const [peer] = await Promise.all([connected.promise, ready.promise])
        peer.send(encodeRelayMessageFrame({
          version: 1,
          stream_id: "550e8400-e29b-41d4-a716-446655440000",
          body: { kind: "handshake", handshake: { payload: new Uint8Array([1]) } },
        }))
        await exchanged.promise
        processHandle.stdin.end("close\n")
        const [status] = await Promise.all([processExited, stdoutEnded, stderrEnded])
        return status
      })(),
      failed.promise,
    ]))
    expect(result).toEqual({ code: 0, signal: null })
    expect(stderr).toBe("")
    expect(handshakeCompleted).toBe(true)
    expect(initialized).toBe(true)
    expect(peerPaused).toBe(true)
    const cleanup = records.find((record) => record.event === "cleanup-resolved")
    expect(cleanup).toMatchObject({ channels: 1, requests: 3, responses: 2, notifications: 0 })
    expect(events).toContain("socket-closed")
    expect(events).toContain("child-exit")
    expect(events).toContain("stdout-eof")
    expect(events).toContain("stderr-eof")
    console.info(JSON.stringify({
      handshakeCompleted,
      initialized,
      peerPaused,
      naturalExit: true,
      socketClosedAtCleanup: cleanup?.socketClosed,
      events,
    }))
    expect(cleanup).toMatchObject({ socketClosed: true })
    expect(events.indexOf("socket-closed")).toBeLessThan(events.indexOf("cleanup-resolved"))
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL")
      await bounded(exited ?? once(child, "exit"))
    }
    for (const peer of peers) peer.terminate()
    await bounded(new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  }
}, 10_000)
