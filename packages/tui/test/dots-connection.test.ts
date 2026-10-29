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
  const attaches: { input: { replaceOthers: true }; result: ReturnType<typeof deferred<Dots.NativeStatus>> }[] = []
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
      attach: (input) => {
        const result = deferred<Dots.NativeStatus>()
        attaches.push({ input, result })
        return result.promise
      },
      error: (error) => errors.push(error),
    })
  })
  return { state, reads, writes, attaches, errors, dispose, setConnected, setOwner }
}

const withComputer = (computer: Dots.NativeStatus["computer"], enabled = true, revision = 2): Dots.NativeStatus => ({ ...status(enabled, revision), computer })

async function opened(computer: Dots.NativeStatus["computer"], enabled = true) {
  const view = fixture()
  view.state.open()
  view.reads[0].result.resolve(withComputer(computer, enabled))
  await flush()
  return view
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

  test.each([
    ["detached with access on", { state: "detached" as const }, true, true],
    ["attached", { state: "attached" as const }, true, false],
    ["unavailable", { state: "unavailable" as const, message: "No executor" }, true, false],
    ["unreported", undefined, true, false],
    ["detached with access off", { state: "detached" as const }, false, false],
  ])("offers computer attachment only when access is on and the computer is detached: %s", async (_name, computer, enabled, offered) => {
    const view = await opened(computer, enabled)
    try {
      expect(view.state.canAttach()).toBe(offered)
      view.state.requestAttach()
      expect(view.state.confirmingAttach()).toBe(offered)
      void view.state.attach()
      expect(view.attaches).toHaveLength(offered ? 1 : 0)
    } finally { view.dispose() }
  })

  test("attachment requires confirmation and cancelling sends nothing", async () => {
    const view = await opened({ state: "detached" })
    try {
      await view.state.attach()
      expect(view.attaches).toHaveLength(0)
      view.state.requestAttach()
      expect(view.state.confirmingAttach()).toBe(true)
      view.state.cancelAttach()
      expect(view.state.confirmingAttach()).toBe(false)
      await view.state.attach()
      expect(view.attaches).toHaveLength(0)
    } finally { view.dispose() }
  })

  test("a confirmed attachment posts replaceOthers once, serializes through settlement, and refreshes", async () => {
    const view = await opened({ state: "detached" })
    try {
      view.state.requestAttach()
      const attach = view.state.attach()
      await view.state.attach()
      view.state.requestAttach()
      await view.state.toggle()
      expect(view.attaches.map((item) => item.input)).toEqual([{ replaceOthers: true }])
      expect(view.writes).toHaveLength(0)
      expect(view.state.pending()).toBe(true)
      expect(view.state.confirmingAttach()).toBe(false)
      expect(view.state.canAttach()).toBe(false)
      view.attaches[0].result.resolve(withComputer({ state: "attached" }))
      await flush()
      expect(view.reads).toHaveLength(2)
      view.reads[1].result.resolve(withComputer({ state: "attached" }))
      await attach
      expect(view.state.status()?.computer).toEqual({ state: "attached" })
      expect(view.state.pending()).toBe(false)
      expect(view.state.canAttach()).toBe(false)
      expect(view.attaches).toHaveLength(1)
    } finally { view.dispose() }
  })

  test("a failed attachment reports the error once without replaying and reconciles by reading", async () => {
    const view = await opened({ state: "detached" })
    try {
      view.state.requestAttach()
      const attach = view.state.attach()
      view.attaches[0].result.reject(new Error("executor refused"))
      await flush()
      expect(view.errors).toHaveLength(1)
      expect(view.state.attachFailure()).toContain("executor refused")
      expect(view.reads).toHaveLength(2)
      view.reads[1].result.resolve(withComputer({ state: "detached" }))
      await attach
      expect(view.attaches).toHaveLength(1)
      expect(view.reads).toHaveLength(2)
      expect(view.state.attachFailure()).toContain("executor refused")
      expect(view.state.pending()).toBe(false)
      view.state.requestAttach()
      expect(view.state.attachFailure()).toBeUndefined()
    } finally { view.dispose() }
  })

  test("a pending confirmation is dropped when the computer attaches elsewhere, access turns off, or the dialog closes", async () => {
    const view = await opened({ state: "detached" })
    try {
      view.state.requestAttach()
      const read = view.state.refresh()
      view.reads[1].result.resolve(withComputer({ state: "attached" }, true, 3))
      await read
      expect(view.state.confirmingAttach()).toBe(false)
      const next = view.state.refresh()
      view.reads[2].result.resolve(withComputer({ state: "detached" }, true, 4))
      await next
      view.state.requestAttach()
      expect(view.state.confirmingAttach()).toBe(true)
      view.state.close()
      expect(view.state.confirmingAttach()).toBe(false)
      view.state.open()
      view.state.requestAttach()
      const off = view.state.refresh()
      view.reads[3].result.resolve(withComputer({ state: "detached" }, false, 5))
      await off
      expect(view.state.confirmingAttach()).toBe(false)
      await view.state.attach()
      expect(view.attaches).toHaveLength(0)
    } finally { view.dispose() }
  })

  test("a stale attachment result is ignored after API replacement", async () => {
    const view = await opened({ state: "detached" })
    try {
      view.state.requestAttach()
      const attach = view.state.attach()
      view.setOwner({})
      expect(view.state.status()).toBeUndefined()
      view.attaches[0].result.resolve(withComputer({ state: "attached" }, true, 9))
      await flush()
      view.reads[1].result.resolve(withComputer({ state: "detached" }, true, 0))
      await attach
      expect(view.state.status()?.computer).toEqual({ state: "detached" })
    } finally { view.dispose() }
  })

  test("disposal ignores a late attachment error", async () => {
    const view = await opened({ state: "detached" })
    view.state.requestAttach()
    const attach = view.state.attach()
    view.dispose()
    view.attaches[0].result.reject(new Error("late attach"))
    await attach
    expect(view.errors).toHaveLength(0)
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
