import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { DotsAccess } from "@ycoding-ai/client"
import { createDotsAccess, dotsAccessCommand } from "../../src/prompt/dots-access"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const access = (overrides: Partial<DotsAccess> = {}): DotsAccess => ({
  sessionID: "ses_root", rootSessionID: "ses_root", enabled: false, revision: 0,
  inherited: false, configured: true, ...overrides,
})
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function fixture() {
  const [sessionID, setSessionID] = createSignal<string | undefined>("ses_root")
  const [location, setLocation] = createSignal("location-a")
  const [connected, setConnected] = createSignal(true)
  const [paletteOpen, setPaletteOpen] = createSignal(false)
  const [owner, setOwner] = createSignal<object>({})
  const reads: ReturnType<typeof deferred<DotsAccess>>[] = []
  const signals: AbortSignal[] = []
  const writes: { input: { sessionID: string; enabled: boolean; expectedRevision: number }; result: ReturnType<typeof deferred<DotsAccess>> }[] = []
  const errors: unknown[] = []
  let dispose!: () => void
  const state = createRoot((release) => {
    dispose = release
    return createDotsAccess({
      sessionID, location, connected, paletteOpen, owner,
      rootSessionID: () => "ses_root",
      get: (_sessionID, signal) => { const read = deferred<DotsAccess>(); signals.push(signal); reads.push(read); return read.promise },
      set: (input) => { const result = deferred<DotsAccess>(); writes.push({ input, result }); return result.promise },
      error: (error) => errors.push(error),
    })
  })
  return { state, reads, signals, writes, errors, dispose, setSessionID, setLocation, setConnected, setPaletteOpen, setOwner }
}

describe("Dots access permission", () => {
  test.each([false, true])("renders reported root access %s and writes its exact revision once", async (enabled) => {
    const view = fixture()
    try {
      expect(dotsAccessCommand(view.state).palette).toBe(false)
      expect(view.state.label()).toBe("Checking")
      view.reads[0]!.resolve(access({ enabled, revision: 4 }))
      await flush()
      expect(dotsAccessCommand(view.state).title).toBe(`Dots access · ${enabled ? "On" : "Off"}`)
      const pending = view.state.toggle()
      await view.state.toggle()
      expect(view.writes.map((write) => write.input)).toEqual([{ sessionID: "ses_root", enabled: !enabled, expectedRevision: 4 }])
      expect(view.state.label()).toBe(enabled ? "On" : "Off")
      expect(dotsAccessCommand(view.state).description).toBe("Updating access…")
      view.writes[0]!.result.resolve(access({ enabled: !enabled, revision: 5 }))
      await pending
      expect(view.state.label()).toBe(enabled ? "Off" : "On")
    } finally { view.dispose() }
  })

  test.each([{ configured: false }, { inherited: true }, { rootSessionID: "ses_other" }])("never exposes a mutation for %j", async (overrides) => {
    const view = fixture()
    try {
      view.reads[0]!.resolve(access(overrides))
      await flush()
      expect(dotsAccessCommand(view.state).palette).toBe(false)
      await view.state.toggle()
      expect(view.writes).toHaveLength(0)
    } finally { view.dispose() }
  })

  test("a failed read is unavailable, never Off, and palette reopen retries only a read", async () => {
    const view = fixture()
    try {
      view.reads[0]!.reject(new Error("read failed"))
      await flush()
      expect(view.state.label()).toBe("Unavailable")
      expect(dotsAccessCommand(view.state).palette).toBe(false)
      expect(view.errors).toHaveLength(1)
      view.setPaletteOpen(true)
      expect(view.reads).toHaveLength(2)
      view.reads[1]!.resolve(access({ enabled: true }))
      await flush()
      expect(view.state.label()).toBe("On")
      expect(view.writes).toHaveLength(0)
    } finally { view.dispose() }
  })

  test.each(["unknown outcome", "409 stale revision"])("%s retains the report and reconciles without write replay", async (message) => {
    const view = fixture()
    try {
      view.reads[0]!.resolve(access({ enabled: true, revision: 7 }))
      await flush()
      const pending = view.state.toggle()
      view.writes[0]!.result.reject(new Error(message))
      await flush()
      expect(view.state.label()).toBe("On")
      expect(view.errors).toHaveLength(1)
      await view.state.toggle()
      expect(view.writes).toHaveLength(1)
      view.reads[1]!.resolve(access({ enabled: false, revision: 8 }))
      await pending
      expect(view.state.label()).toBe("Off")
      expect(view.writes).toHaveLength(1)
    } finally { view.dispose() }
  })

  test.each(["session", "location", "connection", "owner"])("a changed %s rejects late reads and writes", async (change) => {
    const view = fixture()
    try {
      view.reads[0]!.resolve(access({ enabled: true }))
      await flush()
      const pending = view.state.toggle()
      if (change === "session") view.setSessionID("ses_next")
      if (change === "location") view.setLocation("location-b")
      if (change === "connection") { view.setConnected(false); view.setConnected(true) }
      if (change === "owner") view.setOwner({})
      expect(view.state.label()).toBe("Checking")
      view.writes[0]!.result.resolve(access({ enabled: true, revision: 100 }))
      await pending
      expect(view.state.label()).toBe("Checking")
      const sessionID = change === "session" ? "ses_next" : "ses_root"
      view.reads.at(-1)!.resolve(access({ sessionID, rootSessionID: sessionID }))
      await flush()
      expect(view.state.label()).toBe("Off")
      const oldRead = view.state.refresh()
      view.setLocation("location-c")
      view.reads.at(-2)!.resolve(access({ sessionID, rootSessionID: sessionID, enabled: true, revision: 101 }))
      await oldRead
      expect(view.state.label()).toBe("Checking")
    } finally { view.dispose() }
  })

  test("root events invalidate older reads and writes, not another family's state", async () => {
    const view = fixture()
    try {
      view.reads[0]!.resolve(access({ enabled: true, revision: 2 }))
      await flush()
      view.state.changed({ sessionID: "ses_other", enabled: false, revision: 20 })
      expect(view.reads).toHaveLength(1)
      const pending = view.state.toggle()
      view.state.changed({ sessionID: "ses_root", enabled: false, revision: 4 })
      expect(view.reads).toHaveLength(2)
      view.writes[0]!.result.resolve(access({ enabled: true, revision: 3 }))
      await pending
      view.reads[1]!.resolve(access({ enabled: false, revision: 4 }))
      await flush()
      expect(view.state.label()).toBe("Off")
      view.state.changed({ sessionID: "ses_root", enabled: true, revision: 3 })
      expect(view.reads).toHaveLength(2)
      const read = view.state.refresh()
      view.reads[2]!.resolve(access({ enabled: true, revision: 3 }))
      await read
      expect(view.state.label()).toBe("Off")
      expect(view.state.ready()).toBe(false)
      expect(view.errors).toHaveLength(1)
    } finally { view.dispose() }
  })

  test("selection reads coalesce with palette open, then each reopen reads fresh", async () => {
    const view = fixture()
    try {
      view.setPaletteOpen(true)
      expect(view.reads).toHaveLength(1)
      view.reads[0]!.resolve(access())
      await flush()
      view.setPaletteOpen(false)
      view.setPaletteOpen(true)
      expect(view.reads).toHaveLength(2)
      await view.state.toggle()
      expect(view.writes).toHaveLength(0)
    } finally { view.dispose() }
  })

  test("unmount suppresses late success and failure feedback", async () => {
    const view = fixture()
    view.dispose()
    expect(view.signals[0]?.aborted).toBe(true)
    view.reads[0]!.reject(new Error("late failure"))
    await flush()
    expect(view.errors).toHaveLength(0)
    expect(view.writes).toHaveLength(0)
  })

  test("landing and disconnected selection do not read or mutate access", async () => {
    const view = fixture()
    try {
      view.setSessionID(undefined)
      view.setPaletteOpen(true)
      await view.state.toggle()
      view.reads[0]!.resolve(access({ enabled: true }))
      await flush()
      expect(view.state.value()).toBeUndefined()
      expect(view.reads).toHaveLength(1)
      view.setConnected(false)
      view.setSessionID("ses_root")
      await view.state.toggle()
      expect(view.reads).toHaveLength(1)
      expect(view.writes).toHaveLength(0)
    } finally { view.dispose() }
  })

  test("failed reconciliation leaves a reported On state non-actionable until a fresh read", async () => {
    const view = fixture()
    try {
      view.reads[0]!.resolve(access({ enabled: true }))
      await flush()
      const pending = view.state.toggle()
      view.writes[0]!.result.reject(new Error("unknown outcome"))
      await flush()
      view.reads[1]!.reject(new Error("reconciliation unavailable"))
      await pending
      expect(view.state.label()).toBe("On")
      expect(view.state.pending()).toBe(false)
      expect(dotsAccessCommand(view.state).palette).toBe(false)
      await view.state.toggle()
      expect(view.writes).toHaveLength(1)
      expect(view.errors).toHaveLength(2)
      view.setPaletteOpen(true)
      view.reads[2]!.resolve(access({ enabled: false, revision: 1 }))
      await flush()
      expect(view.state.label()).toBe("Off")
      expect(dotsAccessCommand(view.state).palette).toBe(true)
      expect(view.writes).toHaveLength(1)
    } finally { view.dispose() }
  })
})
