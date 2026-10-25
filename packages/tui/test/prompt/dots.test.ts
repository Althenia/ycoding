import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createDotsCapability, dotsInput } from "../../src/prompt/dots"

describe("Dots composer admission", () => {
  test("bare slash command selects a destination without a send payload", () => {
    expect(dotsInput("/dots", [], "message-1")).toEqual({ kind: "select" })
    expect(dotsInput("/dots \n", [], "message-1")).toEqual({ kind: "select" })
  })

  test("extracts only explicit text and chosen attachments", () => {
    const files = [{ uri: "data:text/plain;base64,eA==", name: "chosen.txt" }]
    expect(dotsInput("/dots hello\nworld", files, "message-1")).toEqual({
      kind: "send",
      input: { id: "message-1", text: "hello\nworld", files },
    })
  })

  test("an explicitly pasted image is an attachment-only payload", () => {
    const files = [{ uri: "data:image/png;base64,eA==", name: "pasted.png" }]
    expect(dotsInput("/dots", files, "message-1")).toEqual({
      kind: "send",
      input: { id: "message-1", text: "", files },
    })
  })

  test("preserves the current pasted text without reading ambient sources", () => {
    expect(dotsInput("/dots pasted text\nmore text", [], "message-1")).toEqual({
      kind: "send",
      input: { id: "message-1", text: "pasted text\nmore text" },
    })
  })

  test("does not introduce an at-mention alias or consume another command", () => {
    expect(dotsInput("@dots hello", [], "message-1")).toBeUndefined()
    expect(dotsInput("/dots-other hello", [], "message-1")).toBeUndefined()
    expect(dotsInput("/suggest hello", [], "message-1")).toBeUndefined()
  })
})

function capabilityFixture(initial: { session?: string; connected?: boolean } = {}) {
  const [session, setSession] = createSignal<string | undefined>("session" in initial ? initial.session : "ses_a")
  const [connected, setConnected] = createSignal(initial.connected ?? true)
  const reads: { sessionID: string; signal: AbortSignal; settle: (value: boolean | Error) => void }[] = []
  let resets = 0
  let dispose!: () => void
  const capability = createRoot((release) => {
    dispose = release
    return createDotsCapability({
      sessionID: session,
      connected,
      read: (sessionID, signal) =>
        new Promise<boolean>((resolve, reject) => {
          reads.push({ sessionID, signal, settle: (value) => (value instanceof Error ? reject(value) : resolve(value)) })
        }),
      reset: () => { resets++ },
    })
  })
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
  return { capability, reads, setSession, setConnected, flush, dispose, resets: () => resets }
}

describe("Dots capability", () => {
  test("stays hidden until the selected Session's backend reports enabled", async () => {
    const view = capabilityFixture()
    expect(view.capability.enabled()).toBe(false)
    expect(view.reads.map((read) => read.sessionID)).toEqual(["ses_a"])
    view.reads[0]!.settle(true)
    await view.flush()
    expect(view.capability.enabled()).toBe(true)
    expect(view.reads).toHaveLength(1)
    view.dispose()
  })

  test.each([["a disabled", false], ["a failed", new Error("unavailable")]] as const)("%s read keeps the feature hidden", async (_name, outcome) => {
    const view = capabilityFixture()
    view.reads[0]!.settle(outcome)
    await view.flush()
    expect(view.capability.enabled()).toBe(false)
    view.dispose()
  })

  test("a late result from the previous Session cannot enable the new Session", async () => {
    const view = capabilityFixture()
    view.setSession("ses_b")
    expect(view.reads.map((read) => read.sessionID)).toEqual(["ses_a", "ses_b"])
    expect(view.reads[0]!.signal.aborted).toBe(true)
    view.reads[0]!.settle(true)
    await view.flush()
    expect(view.capability.enabled()).toBe(false)
    view.reads[1]!.settle(true)
    await view.flush()
    expect(view.capability.enabled()).toBe(true)
    view.dispose()
  })

  test("a Session switch hides and resets an enabled capability before the next read settles", async () => {
    const view = capabilityFixture()
    view.reads[0]!.settle(true)
    await view.flush()
    const before = view.resets()
    view.setSession("ses_b")
    expect(view.capability.enabled()).toBe(false)
    expect(view.resets()).toBeGreaterThan(before)
    view.dispose()
  })

  test("a connection loss hides the capability and a late result is ignored; reconnect reads once", async () => {
    const view = capabilityFixture()
    view.setConnected(false)
    view.reads[0]!.settle(true)
    await view.flush()
    expect(view.capability.enabled()).toBe(false)
    expect(view.reads).toHaveLength(1)
    view.setConnected(true)
    expect(view.reads.map((read) => read.sessionID)).toEqual(["ses_a", "ses_a"])
    view.reads[1]!.settle(true)
    await view.flush()
    expect(view.capability.enabled()).toBe(true)
    view.dispose()
  })

  test("no Session reads nothing", () => {
    const view = capabilityFixture({ session: undefined })
    expect(view.reads).toEqual([])
    expect(view.capability.enabled()).toBe(false)
    view.dispose()
  })

  test("disable hides an enabled capability and invalidates an obsolete fence", async () => {
    const view = capabilityFixture()
    view.reads[0]!.settle(true)
    await view.flush()
    const fence = view.capability.fence()
    view.capability.disable()
    expect(view.capability.enabled()).toBe(false)
    expect(view.capability.fence()).not.toBe(fence)
    view.dispose()
  })

  test("disposal aborts an in-flight read and drops its result", async () => {
    const view = capabilityFixture()
    view.dispose()
    expect(view.reads[0]!.signal.aborted).toBe(true)
    view.reads[0]!.settle(true)
    await view.flush()
    expect(view.capability.enabled()).toBe(false)
  })
})
