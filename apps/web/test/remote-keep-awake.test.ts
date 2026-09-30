import { expect, test } from "bun:test"
import type { RemoteErrorCode } from "@ycoding-ai/remote"
import type {
  RemoteRequestOutcome,
  RemoteTransport,
  RemoteTransportHandlers,
  RemoteTransportRequest,
} from "../src/remote/transport"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { waitFor } from "./relay-double"

type Answer = RemoteRequestOutcome | Promise<RemoteRequestOutcome>
type Call = { readonly operation: string; readonly request?: RemoteTransportRequest; readonly deviceID: string }

const ok = (state: "off" | "on" | "unsupported" | "error", message?: string): RemoteRequestOutcome => ({
  status: "ok",
  value: { data: { state, ...(message === undefined ? {} : { message }) } },
})
const failed = (code: RemoteErrorCode, message: string): RemoteRequestOutcome => ({
  status: "failed",
  error: { code, message },
})
const unanswered: RemoteRequestOutcome = {
  status: "unknown",
  error: { code: "outcome_unknown", message: "The machine did not answer in time." },
}

function machine(
  answer: (operation: string, request: RemoteTransportRequest | undefined, deviceID: string) => Answer | undefined,
) {
  const calls: Call[] = []
  const handlers = new Map<string, RemoteTransportHandlers>()
  const store = createRemoteStore({
    http: createRemoteHttp(),
    createTransport: (deviceID, callbacks): RemoteTransport => {
      handlers.set(deviceID, callbacks)
      return {
        connect: () => callbacks.onStatus?.({ kind: "open" }),
        close: () => {},
        status: () => ({ kind: "open" }),
        request: async (operation, request) => {
          calls.push({ operation, request, deviceID })
          if (operation === "session.snapshot")
            return {
              status: "ok",
              value: {
                sourceEpoch: "epoch_1",
                session: { id: "ses_a", title: "Root", time: { created: 1, updated: 1 } },
                messages: [],
                watermark: { type: "log.synced", aggregateID: "ses_a", seq: 0 },
              },
            }
          return answer(operation, request, deviceID) ?? { status: "ok", value: { data: [] } }
        },
      }
    },
  })
  const count = (operation: string) => calls.filter((call) => call.operation === operation).length
  return { store, calls, count, handlers }
}

const keepAwake = (test: ReturnType<typeof machine>) => test.store.state().keepAwake

test("reads the machine's state once with no Session or input, and reports what it answered", async () => {
  const test = machine((operation) => (operation === "machine.keepAwake.get" ? ok("on") : undefined))
  try {
    test.store.connect("dev_1")
    expect(keepAwake(test)).toEqual({ read: "idle" })
    await test.store.loadKeepAwake()
    expect(keepAwake(test)).toEqual({ read: "ready", status: { state: "on" } })
    const read = test.calls.find((call) => call.operation === "machine.keepAwake.get")
    expect(read?.request?.sessionID).toBeUndefined()
    expect(read?.request?.input).toBeUndefined()
  } finally {
    test.store.dispose()
  }
})

test("an older, silent, or failing machine never reads as Off", async () => {
  for (const [outcome, read] of [
    [failed("unknown_operation", "Unknown operation"), "outdated"],
    [unanswered, "unanswered"],
    [failed("internal_error", "Keep awake exploded"), "error"],
    [{ status: "ok", value: { data: { state: "sleeping" } } } as RemoteRequestOutcome, "error"],
  ] as const) {
    const test = machine((operation) => (operation === "machine.keepAwake.get" ? outcome : undefined))
    try {
      test.store.connect("dev_1")
      await test.store.loadKeepAwake()
      expect(keepAwake(test).read).toBe(read)
      expect(keepAwake(test).status).toBeUndefined()
      if (read === "error") expect(keepAwake(test).message).toBeTruthy()
    } finally {
      test.store.dispose()
    }
  }
})

test("nothing is requested until a machine connection is open", async () => {
  const test = machine(() => undefined)
  try {
    await test.store.loadKeepAwake()
    expect(test.count("machine.keepAwake.get")).toBe(0)
    expect(keepAwake(test)).toEqual({ read: "idle" })
    expect(await test.store.setKeepAwake(true)).toBe(false)
    expect(test.count("machine.keepAwake.set")).toBe(0)
  } finally {
    test.store.dispose()
  }
})

test("a change needs a settled supported read, sends exactly the requested flag, and applies the machine's answer", async () => {
  let current: "off" | "on" = "off"
  const held = Promise.withResolvers<RemoteRequestOutcome>()
  const test = machine((operation, request) => {
    if (operation === "machine.keepAwake.get") return ok(current)
    if (operation === "machine.keepAwake.set") {
      current = request?.input?.enabled === true ? "on" : "off"
      return held.promise
    }
    return undefined
  })
  try {
    test.store.connect("dev_1")
    expect(await test.store.setKeepAwake(true)).toBe(false)
    await test.store.loadKeepAwake()
    const changing = test.store.setKeepAwake(true)
    await waitFor(() => keepAwake(test).change?.state === "sending")
    expect(keepAwake(test).change).toEqual({ state: "sending", enabled: true })
    expect(await test.store.setKeepAwake(false)).toBe(false)
    held.resolve(ok("on"))
    expect(await changing).toBe(true)
    expect(test.count("machine.keepAwake.set")).toBe(1)
    const sent = test.calls.find((call) => call.operation === "machine.keepAwake.set")
    expect(sent?.request?.sessionID).toBeUndefined()
    expect(sent?.request?.input).toEqual({ enabled: true })
    expect(keepAwake(test)).toEqual({ read: "ready", status: { state: "on" } })
  } finally {
    held.resolve(ok("off"))
    test.store.dispose()
  }
})

test("an unsupported machine cannot be changed", async () => {
  const test = machine((operation) =>
    operation === "machine.keepAwake.get" ? ok("unsupported", "Only macOS can hold this.") : undefined,
  )
  try {
    test.store.connect("dev_1")
    await test.store.loadKeepAwake()
    expect(keepAwake(test).status).toEqual({ state: "unsupported", message: "Only macOS can hold this." })
    expect(await test.store.setKeepAwake(true)).toBe(false)
    expect(test.count("machine.keepAwake.set")).toBe(0)
  } finally {
    test.store.dispose()
  }
})

test("a refused change keeps the machine's state and shows the failure; a mismatched answer reports what the machine says", async () => {
  let outcome: RemoteRequestOutcome = failed("forbidden", "Not allowed on this machine")
  const test = machine((operation) =>
    operation === "machine.keepAwake.get" ? ok("off") : operation === "machine.keepAwake.set" ? outcome : undefined,
  )
  try {
    test.store.connect("dev_1")
    await test.store.loadKeepAwake()
    expect(await test.store.setKeepAwake(true)).toBe(false)
    expect(keepAwake(test)).toMatchObject({
      read: "ready",
      status: { state: "off" },
      change: { state: "failed", enabled: true },
    })
    expect(keepAwake(test).change?.message).toContain("Not allowed on this machine")
    outcome = ok("off")
    expect(await test.store.setKeepAwake(true)).toBe(false)
    expect(keepAwake(test)).toMatchObject({ read: "ready", status: { state: "off" }, change: { state: "failed" } })
    expect(keepAwake(test).change?.message).toMatch(/reports it is Off/i)
    outcome = failed("unknown_operation", "Unknown operation")
    expect(await test.store.setKeepAwake(true)).toBe(false)
    expect(keepAwake(test).read).toBe("outdated")
  } finally {
    test.store.dispose()
  }
})

test("an unknown outcome is reconciled by exactly one fresh read, is never replayed, and never claims confirmation", async () => {
  const reads: RemoteRequestOutcome[] = [ok("off"), ok("on")]
  const test = machine((operation) =>
    operation === "machine.keepAwake.get"
      ? (reads.shift() ?? ok("on"))
      : operation === "machine.keepAwake.set"
        ? unanswered
        : undefined,
  )
  try {
    test.store.connect("dev_1")
    await test.store.loadKeepAwake()
    expect(await test.store.setKeepAwake(true)).toBe(false)
    await waitFor(() => test.count("machine.keepAwake.get") === 2 && keepAwake(test).status?.state === "on")
    expect(test.count("machine.keepAwake.set")).toBe(1)
    expect(test.count("machine.keepAwake.get")).toBe(2)
    expect(keepAwake(test)).toMatchObject({
      read: "ready",
      status: { state: "on" },
      change: { state: "unknown", enabled: true },
    })
    expect(keepAwake(test).change?.message).toMatch(/unconfirmed/i)
    expect(keepAwake(test).change?.message).not.toMatch(/turned on|is now on|confirmed on/i)
  } finally {
    test.store.dispose()
  }
})

test("concurrent reads share one request and a read cannot supersede a sending change", async () => {
  const first = Promise.withResolvers<RemoteRequestOutcome>()
  const changing = Promise.withResolvers<RemoteRequestOutcome>()
  const test = machine((operation) =>
    operation === "machine.keepAwake.get"
      ? first.promise
      : operation === "machine.keepAwake.set"
        ? changing.promise
        : undefined,
  )
  try {
    test.store.connect("dev_1")
    const reads = [test.store.loadKeepAwake(), test.store.loadKeepAwake()]
    expect(test.count("machine.keepAwake.get")).toBe(1)
    first.resolve(ok("off"))
    await Promise.all(reads)
    const setting = test.store.setKeepAwake(true)
    await test.store.loadKeepAwake()
    expect(test.count("machine.keepAwake.get")).toBe(1)
    changing.resolve(ok("on"))
    expect(await setting).toBe(true)
  } finally {
    first.resolve(ok("off"))
    changing.resolve(ok("on"))
    test.store.dispose()
  }
})

test("same-machine replacement fences both old reads and old changes from the new connection", async () => {
  for (const operation of ["machine.keepAwake.get", "machine.keepAwake.set"] as const) {
    const late = Promise.withResolvers<RemoteRequestOutcome>()
    let hold = false
    const test = machine((requested) =>
      requested === operation && hold ? late.promise : requested === "machine.keepAwake.get" ? ok("off") : undefined,
    )
    try {
      test.store.connect("dev_1")
      await test.store.loadKeepAwake()
      hold = true
      const stale = operation === "machine.keepAwake.get" ? test.store.loadKeepAwake() : test.store.setKeepAwake(true)
      const old = test.handlers.get("dev_1")
      test.store.connect("dev_1")
      expect(keepAwake(test).read).toBe("idle")
      if (operation === "machine.keepAwake.set") expect(keepAwake(test).change?.state).toBe("unknown")
      hold = false
      await test.store.loadKeepAwake()
      old?.onStatus?.({ kind: "closed", code: 1006, reason: "old socket", retryable: true })
      late.resolve(ok("on"))
      await stale
      expect(keepAwake(test)).toMatchObject({ read: "ready", status: { state: "off" } })
      expect(keepAwake(test).change?.state).toBe(operation === "machine.keepAwake.set" ? "unknown" : undefined)
    } finally {
      late.resolve(ok("on"))
      test.store.dispose()
    }
  }
})

test("same-transport reconnect fences a lost change even when its late answer follows the new read", async () => {
  const late = Promise.withResolvers<RemoteRequestOutcome>()
  const test = machine((operation) =>
    operation === "machine.keepAwake.get"
      ? ok("off")
      : operation === "machine.keepAwake.set"
        ? late.promise
        : undefined,
  )
  try {
    test.store.connect("dev_1")
    await test.store.loadKeepAwake()
    const setting = test.store.setKeepAwake(true)
    test.handlers.get("dev_1")?.onStatus?.({ kind: "reconnecting", attempt: 1, delayMs: 50 })
    expect(keepAwake(test)).toMatchObject({ read: "idle", change: { state: "unknown" } })
    test.handlers.get("dev_1")?.onStatus?.({ kind: "open" })
    await test.store.loadKeepAwake()
    late.resolve(ok("on"))
    expect(await setting).toBe(false)
    expect(keepAwake(test)).toMatchObject({ read: "ready", status: { state: "off" }, change: { state: "unknown" } })
    expect(test.count("machine.keepAwake.set")).toBe(1)
  } finally {
    late.resolve(ok("on"))
    test.store.dispose()
  }
})

test("explicit disconnect invalidates reads and changes and does not rearm on connect", async () => {
  for (const operation of ["machine.keepAwake.get", "machine.keepAwake.set"] as const) {
    const late = Promise.withResolvers<RemoteRequestOutcome>()
    let hold = false
    const test = machine((requested) =>
      requested === operation && hold ? late.promise : requested === "machine.keepAwake.get" ? ok("off") : undefined,
    )
    try {
      test.store.connect("dev_1")
      await test.store.loadKeepAwake()
      hold = true
      const stale = operation === "machine.keepAwake.get" ? test.store.loadKeepAwake() : test.store.setKeepAwake(true)
      test.store.disconnect()
      expect(keepAwake(test)).toEqual({ read: "idle" })
      late.resolve(ok("on"))
      await stale
      expect(keepAwake(test)).toEqual({ read: "idle" })
      test.store.connect("dev_1")
      expect(test.count("machine.keepAwake.set")).toBe(operation === "machine.keepAwake.set" ? 1 : 0)
    } finally {
      late.resolve(ok("on"))
      test.store.dispose()
    }
  }
})

test("a read that started before a change cannot overwrite the change's result", async () => {
  const slowRead = Promise.withResolvers<RemoteRequestOutcome>()
  let reads = 0
  const test = machine((operation) => {
    if (operation === "machine.keepAwake.get") return ++reads === 1 ? ok("off") : slowRead.promise
    if (operation === "machine.keepAwake.set") return ok("on")
    return undefined
  })
  try {
    test.store.connect("dev_1")
    await test.store.loadKeepAwake()
    const refreshing = test.store.loadKeepAwake()
    await waitFor(() => reads === 2)
    expect(await test.store.setKeepAwake(true)).toBe(true)
    slowRead.resolve(ok("off"))
    await refreshing
    expect(keepAwake(test)).toEqual({ read: "ready", status: { state: "on" } })
  } finally {
    slowRead.resolve(ok("off"))
    test.store.dispose()
  }
})

test("a new read after a change never joins the read superseded by that change", async () => {
  const late = Promise.withResolvers<RemoteRequestOutcome>()
  let reads = 0
  const test = machine((operation) => {
    if (operation === "machine.keepAwake.get") return ++reads === 2 ? late.promise : ok("off")
    if (operation === "machine.keepAwake.set") return ok("on")
    return undefined
  })
  try {
    test.store.connect("dev_1")
    await test.store.loadKeepAwake()
    const stale = test.store.loadKeepAwake()
    expect(await test.store.setKeepAwake(true)).toBe(true)
    const fresh = test.store.loadKeepAwake()
    expect(test.count("machine.keepAwake.get")).toBe(3)
    await fresh
    expect(keepAwake(test).status?.state).toBe("off")
    late.resolve(ok("on"))
    await stale
    expect(keepAwake(test).status?.state).toBe("off")
  } finally {
    late.resolve(ok("on"))
    test.store.dispose()
  }
})

test("a refresh of a ready machine keeps showing its state and never flashes checking", async () => {
  const slow = Promise.withResolvers<RemoteRequestOutcome>()
  let reads = 0
  const test = machine((operation) =>
    operation === "machine.keepAwake.get" ? (++reads === 1 ? ok("on") : slow.promise) : undefined,
  )
  const seen: string[] = []
  try {
    test.store.connect("dev_1")
    await test.store.loadKeepAwake()
    test.store.subscribe(() => seen.push(keepAwake(test).read))
    const refreshing = test.store.loadKeepAwake()
    await waitFor(() => reads === 2)
    expect(keepAwake(test)).toEqual({ read: "ready", status: { state: "on" } })
    slow.resolve(ok("off"))
    await refreshing
    expect(keepAwake(test).status?.state).toBe("off")
    expect(seen.every((read) => read === "ready")).toBe(true)
  } finally {
    slow.resolve(ok("off"))
    test.store.dispose()
  }
})

test("a lost connection drops the reading and ignores an answer that arrives afterwards", async () => {
  const late = Promise.withResolvers<RemoteRequestOutcome>()
  const test = machine((operation) => (operation === "machine.keepAwake.get" ? late.promise : undefined))
  try {
    test.store.connect("dev_1")
    const reading = test.store.loadKeepAwake()
    await waitFor(() => keepAwake(test).read === "loading")
    test.handlers.get("dev_1")?.onStatus?.({ kind: "closed", code: 1006, reason: "", retryable: true })
    expect(keepAwake(test).read).toBe("idle")
    late.resolve(ok("on"))
    await reading
    expect(keepAwake(test)).toEqual({ read: "idle" })
  } finally {
    late.resolve(ok("on"))
    test.store.dispose()
  }
})

test("a change interrupted by a lost connection comes back as an unconfirmed change after the fresh read", async () => {
  const lost = Promise.withResolvers<RemoteRequestOutcome>()
  const test = machine((operation) =>
    operation === "machine.keepAwake.get"
      ? ok("off")
      : operation === "machine.keepAwake.set"
        ? lost.promise
        : undefined,
  )
  try {
    test.store.connect("dev_1")
    await test.store.loadKeepAwake()
    const changing = test.store.setKeepAwake(true)
    await waitFor(() => keepAwake(test).change?.state === "sending")
    test.handlers.get("dev_1")?.onStatus?.({ kind: "closed", code: 1006, reason: "", retryable: true })
    lost.resolve(unanswered)
    expect(await changing).toBe(false)
    expect(keepAwake(test)).toMatchObject({ read: "idle", change: { state: "unknown", enabled: true } })
    test.handlers.get("dev_1")?.onStatus?.({ kind: "open" })
    await test.store.loadKeepAwake()
    expect(keepAwake(test)).toMatchObject({ read: "ready", status: { state: "off" }, change: { state: "unknown" } })
    expect(test.count("machine.keepAwake.set")).toBe(1)
  } finally {
    lost.resolve(unanswered)
    test.store.dispose()
  }
})

test("switching machines drops the previous machine's reading and its late answer", async () => {
  const first = Promise.withResolvers<RemoteRequestOutcome>()
  const test = machine((operation, _request, deviceID) =>
    operation === "machine.keepAwake.get" ? (deviceID === "dev_1" ? first.promise : ok("off")) : undefined,
  )
  try {
    test.store.connect("dev_1")
    const stale = test.store.loadKeepAwake()
    await waitFor(() => keepAwake(test).read === "loading")
    test.store.connect("dev_2")
    expect(keepAwake(test)).toEqual({ read: "idle" })
    await test.store.loadKeepAwake()
    expect(keepAwake(test)).toEqual({ read: "ready", status: { state: "off" } })
    first.resolve(ok("on"))
    await stale
    expect(keepAwake(test)).toEqual({ read: "ready", status: { state: "off" } })
    expect(
      test.calls.filter((call) => call.operation === "machine.keepAwake.get").map((call) => call.deviceID),
    ).toEqual(["dev_1", "dev_2"])
  } finally {
    first.resolve(ok("on"))
    test.store.dispose()
  }
})

test("disposal ends the reading and a late change result changes nothing", async () => {
  const late = Promise.withResolvers<RemoteRequestOutcome>()
  const test = machine((operation) =>
    operation === "machine.keepAwake.get"
      ? ok("off")
      : operation === "machine.keepAwake.set"
        ? late.promise
        : undefined,
  )
  test.store.connect("dev_1")
  await test.store.loadKeepAwake()
  const changing = test.store.setKeepAwake(true)
  await waitFor(() => keepAwake(test).change?.state === "sending")
  test.store.dispose()
  expect(keepAwake(test)).toEqual({ read: "idle" })
  late.resolve(ok("on"))
  await changing
  expect(keepAwake(test)).toEqual({ read: "idle" })
})
