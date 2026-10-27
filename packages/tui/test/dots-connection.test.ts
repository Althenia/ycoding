import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { Dots } from "@ycoding-ai/schema/dots"
import { createDotsConnection } from "../src/dots-connection"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const status = (enabled = false, revision = 2): Dots.NativeStatus => ({
  access: { enabled, revision },
  configuration: { ready: true, profile: "fixture-profile" },
  connection: { state: enabled ? "connected" : "off", hostname: "fixture-computer" },
})
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function fixture() {
  const [connected, setConnected] = createSignal(true)
  const [owner, setOwner] = createSignal<object>({})
  const reads: { result: ReturnType<typeof deferred<Dots.NativeStatus>>; signal: AbortSignal }[] = []
  const writes: { input: { enabled: boolean; expectedRevision: number }; result: ReturnType<typeof deferred<Dots.NativeStatus>> }[] = []
  const errors: unknown[] = []
  let dispose!: () => void
  const state = createRoot((release) => {
    dispose = release
    return createDotsConnection({
      connected, owner,
      get: (signal) => {
        const result = deferred<Dots.NativeStatus>()
        reads.push({ result, signal })
        return result.promise
      },
      set: (input) => {
        const result = deferred<Dots.NativeStatus>()
        writes.push({ input, result })
        return result.promise
      },
      error: (error) => errors.push(error),
    })
  })
  return { state, reads, writes, errors, dispose, setConnected, setOwner }
}

describe("global Dots connection", () => {
  test("reads only while open, coalesces refreshes, and aborts closed reads", async () => {
    const view = fixture()
    try {
      await view.state.refresh()
      expect(view.reads).toHaveLength(0)
      view.state.open()
      void view.state.refresh()
      expect(view.reads).toHaveLength(1)
      expect(view.state.canToggle()).toBe(false)
      view.state.close()
      expect(view.reads[0].signal.aborted).toBe(true)
      view.reads[0].result.resolve(status(true))
      await flush()
      expect(view.state.status()).toBeUndefined()
      await view.state.refresh()
      expect(view.reads).toHaveLength(1)
    } finally { view.dispose() }
  })

  test.each([false, true])("serializes exact-revision writes from reported access %s through settlement", async (enabled) => {
    const view = fixture()
    try {
      view.state.open()
      view.reads[0].result.resolve(status(enabled))
      await flush()
      const write = view.state.toggle()
      await view.state.toggle()
      expect(view.writes.map((item) => item.input)).toEqual([{ enabled: !enabled, expectedRevision: 2 }])
      expect(view.state.status()?.access.enabled).toBe(enabled)
      expect(view.state.pending()).toBe(true)
      view.state.close()
      view.state.open()
      await view.state.toggle()
      expect(view.writes).toHaveLength(1)
      view.writes[0].result.resolve(status(!enabled, 3))
      await flush()
      expect(view.reads).toHaveLength(2)
      view.reads[1].result.resolve(status(!enabled, 3))
      await write
      expect(view.state.status()?.access.enabled).toBe(!enabled)
      expect(view.state.pending()).toBe(false)
      expect(view.state.canToggle()).toBe(true)
    } finally { view.dispose() }
  })

  test.each(["conflict", "unknown outcome"])("reconciles %s without replaying a write", async (reason) => {
    const view = fixture()
    try {
      view.state.open()
      view.reads[0].result.resolve(status(true, 4))
      await flush()
      const write = view.state.toggle()
      view.writes[0].result.reject(new Error(reason))
      await flush()
      expect(view.state.status()?.access.enabled).toBe(true)
      expect(view.state.canToggle()).toBe(false)
      expect(view.errors).toHaveLength(1)
      view.reads[1].result.resolve(status(false, 5))
      await write
      expect(view.state.status()?.access).toEqual({ enabled: false, revision: 5 })
      expect(view.writes).toHaveLength(1)
    } finally { view.dispose() }
  })

  test("unready configuration prevents Connect but permits Disconnect", async () => {
    const view = fixture()
    try {
      view.state.open()
      view.reads[0].result.resolve({ ...status(), configuration: { ready: false }, connection: { state: "unavailable" } })
      await flush()
      await view.state.toggle()
      expect(view.writes).toHaveLength(0)
      const read = view.state.refresh()
      view.reads[1].result.resolve({ ...status(true), configuration: { ready: false }, connection: { state: "unavailable" } })
      await read
      expect(view.state.canToggle()).toBe(true)
      const write = view.state.toggle()
      expect(view.writes[0].input.enabled).toBe(false)
      view.writes[0].result.resolve(status(false, 3))
      await flush()
      view.reads[2].result.resolve(status(false, 3))
      await write
    } finally { view.dispose() }
  })

  test("reconnect and API replacement reject late reads and stale write results", async () => {
    const view = fixture()
    try {
      view.state.open()
      view.setConnected(false)
      expect(view.reads[0].signal.aborted).toBe(true)
      view.setConnected(true)
      view.reads[1].result.resolve(status(false, 8))
      await flush()
      view.reads[0].result.resolve(status(true, 9))
      await flush()
      expect(view.state.status()?.access.enabled).toBe(false)
      const write = view.state.toggle()
      view.setOwner({})
      expect(view.state.status()).toBeUndefined()
      view.writes[0].result.resolve(status(true, 9))
      await flush()
      view.reads[2].result.resolve(status(false, 0))
      await write
      expect(view.state.status()?.access).toEqual({ enabled: false, revision: 0 })
    } finally { view.dispose() }
  })

  test("lower revisions and read failures keep actions unavailable, not Off", async () => {
    const view = fixture()
    try {
      view.state.open()
      view.reads[0].result.resolve(status(true, 8))
      await flush()
      const read = view.state.refresh()
      view.reads[1].result.resolve(status(false, 7))
      await read
      expect(view.state.status()?.access.enabled).toBe(true)
      expect(view.state.canToggle()).toBe(false)
      expect(view.state.failure()).toBeTruthy()
      const failed = view.state.refresh()
      view.reads[2].result.reject(new Error("read unavailable"))
      await failed
      expect(view.state.failure()).toContain("read unavailable")
      expect(view.writes).toHaveLength(0)
    } finally { view.dispose() }
  })

  test("disposal aborts reads and ignores late mutation errors", async () => {
    const view = fixture()
    view.state.open()
    view.reads[0].result.resolve(status())
    await flush()
    const write = view.state.toggle()
    view.dispose()
    view.writes[0].result.reject(new Error("late write"))
    await write
    expect(view.errors).toHaveLength(0)
    await view.state.refresh()
    expect(view.reads).toHaveLength(1)
  })
})
