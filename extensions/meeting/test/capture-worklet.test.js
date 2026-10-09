import { expect, test } from "bun:test"
import { createContext, runInContext } from "node:vm"
import { observeCallConnection } from "../companion/call-observer.js"

test("worklet averages mono, emits bounded sequential timestamps, transfers packets and flushes the tail", async () => {
  const packets = []
  const processors = []
  const context = createContext({
    AudioWorkletProcessor: class { port = { postMessage: (message) => packets.push(message) } },
    sampleRate: 8000,
    registerProcessor: (_, processor) => processors.push(processor),
  })
  runInContext(await Bun.file(new URL("../companion/worklet.js", import.meta.url)).text(), context)
  const processor = new processors[0]({ processorOptions: { source: "remote" } })
  const output = [[new Float32Array(128)]]
  for (let frame = 0; frame < 32; frame++) processor.process([[new Float32Array(128).fill(1), new Float32Array(128).fill(-1)]], output)
  expect(packets).toHaveLength(2)
  expect(packets.map((packet) => packet.sequence)).toEqual([0, 1])
  expect(packets.map((packet) => packet.startMs)).toEqual([0, 250])
  expect(new Float32Array(packets[0].samples)).toHaveLength(2000)
  expect(new Float32Array(packets[0].samples).every((sample) => sample === 0)).toBe(true)
  expect(output[0][0].every((sample) => sample === 0)).toBe(true)
  processor.port.onmessage({ data: { type: "flush" } })
  expect(packets[2].sequence).toBe(2)
  expect(packets[2].startMs).toBe(500)
  expect(new Float32Array(packets[2].samples)).toHaveLength(96)
  expect(packets.at(-1).type).toBe("flushed")
  expect(processor.process([[]], output)).toBe(false)
})

test("scoped standard WebRTC close observer handles an existing connection and restores the original method", () => {
  class Connection { close() { this.closed = true } }
  const existing = new Connection()
  const original = Connection.prototype.close
  const document = new EventTarget()
  let signalled = 0
  document.addEventListener("ycoding-meeting-connection-ended", () => signalled++)
  const context = createContext({ RTCPeerConnection: Connection, document, Event })
  runInContext(`(${observeCallConnection.toString()})()`, context)
  existing.close()
  expect(existing.closed).toBe(true)
  expect(signalled).toBe(1)
  document.dispatchEvent(new Event("ycoding-meeting-observer-remove"))
  expect(Connection.prototype.close).toBe(original)
  existing.close()
  expect(signalled).toBe(1)
})
