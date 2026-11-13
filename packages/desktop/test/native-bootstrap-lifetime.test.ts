import { expect, spyOn, test } from "bun:test"
import { YCoding, type YCodingEvent } from "@ycoding-ai/client"
import * as ChildProcess from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { PassThrough } from "node:stream"
import { BackendController } from "../src/backend-controller"
import type { ConnectionState } from "../src/contract"
import * as NativeClient from "../src/native-client"

const task = process.env.YCODING_DESKTOP_TEST_TASK
if (!task || !path.isAbsolute(task)) throw new Error("A private native-bootstrap test Task is required")
const health = { healthy: true as const, version: "1.0.0", pid: 1, sourceEpoch: "synthetic" }
const connected: YCodingEvent = { id: "evt_synthetic", sourceEpoch: health.sourceEpoch, type: "server.connected", data: {} }
const endpoint = { pid: 1, url: "http://127.0.0.1:1/", auth: { type: "basic", username: "fixture", password: "synthetic" } }

function control(holdClose = false) {
  const child = new ChildProcess.ChildProcess()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  Object.defineProperties(child, { pid: { value: 2345 }, stdin: { value: stdin }, stdout: { value: stdout }, stderr: { value: new PassThrough() }, kill: { value: () => true } })
  let closed = false
  let retired = false
  const retire = () => {
    if (retired) return
    retired = true
    stdout.write(JSON.stringify({ type: "desktop.retired", pid: 1 }) + "\n")
  }
  const close = () => {
    if (closed) return
    closed = true
    retire()
    child.emit("close", 0, null)
  }
  stdin.once("finish", () => { if (!holdClose) close() })
  child.on("newListener", (name) => {
    if (name === "close") queueMicrotask(() => {
      child.emit("spawn")
      stdout.write(JSON.stringify({ type: "desktop.endpoint", version: "1.0.0", endpoint }) + "\n")
    })
  })
  return { child, close, retire }
}

for (const kind of ["own first-event gate", "own same-turn acquisition", "shared first-event gate", "own retirement interval"] as const) {
  test(`native bootstrap ${kind} joins acquisition and native close before replacement`, async () => {
    const root = await fs.mkdtemp(path.join(task!, "bootstrap-"))
    await fs.mkdir(path.join(root, "backend"))
    const executable = path.join(root, "backend/ycoding")
    await fs.copyFile("/usr/bin/true", executable)
    const sha256 = createHash("sha256").update(await fs.readFile(executable)).digest("hex")
    await fs.writeFile(path.join(root, "backend.json"), JSON.stringify({ version: "1.0.0", executable: "backend/ycoding", files: [{ path: "backend/ycoding", sha256 }] }), { flag: "wx", mode: 0o600 })
    const own = kind !== "shared first-event gate"
    const sameTurn = kind === "own same-turn acquisition"
    const retirementInterval = kind === "own retirement interval"
    const first = control(retirementInterval)
    const second = control()
    const spawn = spyOn(ChildProcess, "spawn").mockReturnValue(second.child).mockReturnValueOnce(first.child)
    const admitted = Promise.withResolvers<void>()
    const eventGate = Promise.withResolvers<void>()
    const closeEntered = Promise.withResolvers<void>()
    const closeGate = Promise.withResolvers<void>()
    const firstNativeClosed = Promise.withResolvers<void>()
    const nativeGate = Promise.withResolvers<Awaited<ReturnType<typeof NativeClient.connectNative>>>()
    const states: ConnectionState[] = []
    const events: string[] = []
    const closes: number[] = []
    let firstCloseComplete = false
    let firstTransportClosed = false
    let firstOptions: Parameters<typeof NativeClient.connectNative>[1] | undefined
    let acquisitions = 0
    let requests = 0
    let launches = 0
    const launchAfterClose: boolean[] = []
    const transport: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init)
      expect(request.headers.get("authorization")).toBe("Basic " + Buffer.from("fixture:synthetic").toString("base64"))
      if (new URL(request.url).pathname === "/api/health") return Response.json(health)
      expect(new URL(request.url).pathname).toBe("/api/event")
      const firstStream = ++requests === 1
      return new Response(new ReadableStream<Uint8Array>({
        start(stream) {
          let ended = false
          const abort = () => {
            if (ended) return
            ended = true
            request.signal.removeEventListener("abort", abort)
            if (firstStream) firstTransportClosed = true
            stream.close()
          }
          request.signal.addEventListener("abort", abort, { once: true })
          stream.enqueue(new TextEncoder().encode("data: " + JSON.stringify(connected) + "\n\n"))
          if (request.signal.aborted) abort()
        },
      }), { headers: { "content-type": "text/event-stream" } })
    }, fetch)
    const realNative = NativeClient.connectNative
    const instrument = (native: Awaited<ReturnType<typeof NativeClient.connectNative>>, index: number) => {
      const close = native.close
      let calls = 0
      closes[index] = 0
      native.close = async () => {
        closes[index] = ++calls
        if (index === 0) { closeEntered.resolve(); await closeGate.promise }
        await close()
        if (index === 0) { firstCloseComplete = true; firstNativeClosed.resolve() }
      }
      return native
    }
    const native = spyOn(NativeClient, "connectNative").mockImplementation((value, options) => {
      const index = acquisitions++
      if (index === 0) firstOptions = options
      if (sameTurn && index === 0) { admitted.resolve(); return nativeGate.promise }
      return realNative(value, options).then((handle) => instrument(handle, index))
    })
    const controller = new BackendController(root, {
      fetch: transport,
      onState: (state) => { states.push(state) },
      onEvent: (event) => {
        events.push(event.type)
        if (!sameTurn && events.length === 1) { admitted.resolve(); return eventGate.promise }
      },
      launch: (command) => {
        if (++launches > 2) launchAfterClose.push(firstCloseComplete)
        return command[1] === "--version" ? [process.execPath, "-e", 'process.stdout.write("ycoding v1.0.0\\n")'] : command
      },
    })
    let settled = false
    const starting = controller.connect({ mode: own ? "own" : "shared" }).then((state) => { settled = true; return { state, error: undefined } }, (error: unknown) => { settled = true; return { state: undefined, error } })
    let replacement: Promise<ConnectionState> | undefined
    try {
      await admitted.promise
      const beforeEvents = [...events]
      if (sameTurn) nativeGate.resolve(instrument({ health, api: YCoding.make({ baseUrl: endpoint.url, fetch: transport }), close: async () => {} }, 0))
      if (retirementInterval) first.retire()
      else first.close()
      if (sameTurn) {
        await firstOptions?.onEvent?.(connected)
      }
      eventGate.resolve()
      if (!own) {
        expect((await starting).state?.status).toBe("connected")
        expect(firstOptions?.signal.aborted).toBe(false)
        expect(firstTransportClosed).toBe(false)
        closeGate.resolve()
        await controller.disconnect()
        expect(firstCloseComplete).toBe(true)
        expect(firstTransportClosed).toBe(true)
        expect(closes).toEqual([1])
        return
      }
      const admission = await Promise.race([closeEntered.promise.then(() => "closing"), starting.then(() => "settled")])
      firstOptions?.onStatus?.({ status: "reconnecting" })
      expect(states.filter((state) => state.status === "connected" || state.status === "reconnecting")).toEqual([])
      expect(admission).toBe("closing")
      await firstOptions?.onEvent?.(connected)
      expect(events).toEqual(beforeEvents)
      expect(settled).toBe(false)
      expect(firstCloseComplete).toBe(false)
      expect(closes).toEqual([1])
      replacement = controller.connect({ mode: "own" })
      expect(launches).toBe(2)
      closeGate.resolve()
      if (retirementInterval) {
        await firstNativeClosed.promise
        expect(launches).toBe(2)
        expect(settled).toBe(false)
        first.close()
      }
      expect((await starting).error).toBeInstanceOf(Error)
      expect((await replacement).status).toBe("connected")
      expect(firstCloseComplete).toBe(true)
      expect(launchAfterClose).toEqual([true, true])
      await controller.disconnect()
      expect(closes).toEqual([1, 1])
      expect(controller.state().status).toBe("idle")
    } finally {
      eventGate.resolve()
      closeGate.resolve()
      first.close()
      second.close()
      await starting
      await replacement?.catch(() => undefined)
      await controller.disconnect().catch(() => undefined)
      native.mockRestore()
      spawn.mockRestore()
    }
  })
}
