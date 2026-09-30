import { MutationObserver } from "@tanstack/solid-query"
import { expect, test } from "bun:test"
import type { RemoteErrorCode } from "@ycoding-ai/remote"
import type {
  RemoteRequestOutcome,
  RemoteTransport,
  RemoteTransportHandlers,
  RemoteTransportRequest,
} from "../src/remote/transport"
import { createRemoteHttp } from "../src/remote/http"
import { keepAwakeState, remoteKeys } from "../src/remote/queries"
import type { KeepAwakeState } from "../src/remote/keep-awake"
import { createRemoteStore } from "../src/remote/store"
import { queriesOf } from "./remote-queries"
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
        setPriority: () => {},
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
  return { store, calls, count, handlers, ...queriesOf(store) }
}

type Machine = ReturnType<typeof machine>

const key = (test: Machine) => remoteKeys.keepAwake(test.scope())
const keepAwake = (test: Machine): KeepAwakeState => {
  const query = test.cached<KeepAwakeState>(key(test))
  return keepAwakeState({ status: query?.state.status ?? "pending", fetchStatus: query?.state.fetchStatus ?? "idle", data: query?.state.data, error: query?.state.error ?? null })
}
const load = (test: Machine) => test.store.queryClient.fetchQuery({ ...test.queries.keepAwake(test.scope(), true), staleTime: 0 })
const change = (test: Machine, enabled: boolean) => new MutationObserver(test.store.queryClient, test.queries.keepAwakeMutation(test.scope())).mutate(enabled)

test("reads the machine's state once with no Session or input, and reports what it answered", async () => {
  const test = machine((operation) => (operation === "machine.keepAwake.get" ? ok("on") : undefined))
  try {
    test.store.connect("dev_1")
    expect(keepAwake(test)).toEqual({ read: "idle" })
    await load(test)
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
      await load(test)
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
    await load(test)
    expect(test.count("machine.keepAwake.get")).toBe(0)
    expect(await change(test, true)).toEqual({ reached: false, reload: false })
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
    expect((await change(test, true)).reached).toBe(false)
    await load(test)
    const changing = change(test, true)
    await waitFor(() => keepAwake(test).change?.state === "sending")
    expect(keepAwake(test).change).toEqual({ state: "sending", enabled: true })
    expect((await change(test, false)).reached).toBe(false)
    held.resolve(ok("on"))
    expect((await changing).reached).toBe(true)
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
    await load(test)
    expect(keepAwake(test).status).toEqual({ state: "unsupported", message: "Only macOS can hold this." })
    expect((await change(test, true)).reached).toBe(false)
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
    await load(test)
    expect((await change(test, true)).reached).toBe(false)
    expect(keepAwake(test)).toMatchObject({ read: "ready", status: { state: "off" }, change: { state: "failed", enabled: true } })
    expect(keepAwake(test).change?.message).toContain("Not allowed on this machine")
    outcome = ok("off")
    expect((await change(test, true)).reached).toBe(false)
    expect(keepAwake(test)).toMatchObject({ read: "ready", status: { state: "off" }, change: { state: "failed" } })
    expect(keepAwake(test).change?.message).toMatch(/reports it is Off/i)
    outcome = failed("unknown_operation", "Unknown operation")
    expect((await change(test, true)).reached).toBe(false)
    expect(keepAwake(test).read).toBe("outdated")
  } finally {
    test.store.dispose()
  }
})

test("an unknown outcome is reconciled by exactly one fresh read, is never replayed, and never claims confirmation", async () => {
  const reads: RemoteRequestOutcome[] = [ok("off"), ok("on")]
  const test = machine((operation) =>
    operation === "machine.keepAwake.get" ? (reads.shift() ?? ok("on")) : operation === "machine.keepAwake.set" ? unanswered : undefined,
  )
  try {
    test.store.connect("dev_1")
    const watching = test.observe(test.queries.keepAwake(test.scope(), true))
    await waitFor(() => keepAwake(test).read === "ready")
    expect((await change(test, true)).reached).toBe(false)
    await waitFor(() => test.count("machine.keepAwake.get") === 2 && keepAwake(test).status?.state === "on")
    expect(test.count("machine.keepAwake.set")).toBe(1)
    expect(keepAwake(test)).toMatchObject({ read: "ready", status: { state: "on" }, change: { state: "unknown", enabled: true } })
    expect(keepAwake(test).change?.message).toMatch(/unconfirmed/i)
    expect(keepAwake(test).change?.message).not.toMatch(/turned on|is now on|confirmed on/i)
    watching.stop()
  } finally {
    test.store.dispose()
  }
})

test("concurrent reads share one request and a read cannot supersede a sending change", async () => {
  const first = Promise.withResolvers<RemoteRequestOutcome>()
  const changing = Promise.withResolvers<RemoteRequestOutcome>()
  const test = machine((operation) =>
    operation === "machine.keepAwake.get" ? first.promise : operation === "machine.keepAwake.set" ? changing.promise : undefined,
  )
  try {
    test.store.connect("dev_1")
    const reads = [load(test), load(test)]
    expect(test.count("machine.keepAwake.get")).toBe(1)
    first.resolve(ok("off"))
    await Promise.all(reads)
    const setting = change(test, true)
    await waitFor(() => keepAwake(test).change?.state === "sending")
    await load(test)
    expect(test.count("machine.keepAwake.get")).toBe(1)
    changing.resolve(ok("on"))
    expect((await setting).reached).toBe(true)
  } finally {
    first.resolve(ok("off"))
    changing.resolve(ok("on"))
    test.store.dispose()
  }
})

test("a machine replacement fences old reads and old changes from the new connection", async () => {
  for (const [operation, next] of [["machine.keepAwake.get", "dev_1"], ["machine.keepAwake.set", "dev_1"], ["machine.keepAwake.get", "dev_2"]] as const) {
    const late = Promise.withResolvers<RemoteRequestOutcome>()
    let hold = false
    const test = machine((requested) =>
      requested === operation && hold ? late.promise : requested === "machine.keepAwake.get" ? ok("off") : undefined,
    )
    try {
      test.store.connect("dev_1")
      await load(test)
      hold = true
      const stale = operation === "machine.keepAwake.get" ? load(test).catch(() => undefined) : change(test, true)
      const old = test.handlers.get("dev_1")
      const before = test.store.state().generation
      test.store.connect(next)
      hold = false
      expect(test.store.state().generation).toBe(before + 1)
      expect(keepAwake(test).read).toBe("idle")
      late.resolve(ok("on"))
      await stale
      expect(test.cached(remoteKeys.keepAwake(test.scope()))).toBeUndefined()
      expect(test.scoped()).toHaveLength(0)
      old?.onStatus?.({ kind: "open" })
      expect(test.store.state().activeDeviceID).toBe(next)
    } finally {
      late.resolve(ok("off"))
      test.store.dispose()
    }
  }
})

test("a connection lost during a change reports it unconfirmed and the reconnect reads the machine again", async () => {
  const held = Promise.withResolvers<RemoteRequestOutcome>()
  const reads: RemoteRequestOutcome[] = [ok("off"), ok("on")]
  const test = machine((operation) =>
    operation === "machine.keepAwake.get" ? (reads.shift() ?? ok("on")) : operation === "machine.keepAwake.set" ? held.promise : undefined,
  )
  try {
    test.store.connect("dev_1")
    const watching = test.observe(test.queries.keepAwake(test.scope(), true))
    await waitFor(() => keepAwake(test).read === "ready")
    const changing = change(test, true)
    await waitFor(() => keepAwake(test).change?.state === "sending")
    test.handlers.get("dev_1")?.onStatus?.({ kind: "reconnecting", attempt: 1, delayMs: 10 })
    held.resolve(unanswered)
    expect((await changing).reached).toBe(false)
    expect(keepAwake(test)).toMatchObject({ change: { state: "unknown", enabled: true } })
    test.handlers.get("dev_1")?.onStatus?.({ kind: "open" })
    await waitFor(() => keepAwake(test).status?.state === "on")
    expect(keepAwake(test).change?.state).toBe("unknown")
    expect(test.count("machine.keepAwake.set")).toBe(1)
    watching.stop()
  } finally {
    held.resolve(unanswered)
    test.store.dispose()
  }
})

test("explicit disconnect removes the reading, ignores late results, and does not rearm on connect", async () => {
  const late = Promise.withResolvers<RemoteRequestOutcome>()
  const test = machine((operation) => (operation === "machine.keepAwake.set" ? late.promise : ok("off")))
  try {
    test.store.connect("dev_1")
    await load(test)
    const changing = change(test, true)
    await waitFor(() => keepAwake(test).change?.state === "sending")
    test.store.disconnect()
    late.resolve(ok("on"))
    expect((await changing).reached).toBe(false)
    expect(test.scoped()).toHaveLength(0)
    test.store.connect("dev_1")
    expect(test.scoped()).toHaveLength(0)
    expect(test.count("machine.keepAwake.get")).toBe(1)
  } finally {
    late.resolve(ok("off"))
    test.store.dispose()
  }
})

test("a read that started before a change cannot overwrite the change's result", async () => {
  const stale = Promise.withResolvers<RemoteRequestOutcome>()
  let reads = 0
  const test = machine((operation) => {
    if (operation === "machine.keepAwake.get") return ++reads === 2 ? stale.promise : ok("off")
    return operation === "machine.keepAwake.set" ? ok("on") : undefined
  })
  try {
    test.store.connect("dev_1")
    await load(test)
    const reading = load(test).catch(() => undefined)
    await waitFor(() => reads === 2)
    expect((await change(test, true)).reached).toBe(true)
    stale.resolve(ok("off"))
    await reading
    expect(keepAwake(test)).toEqual({ read: "ready", status: { state: "on" } })
  } finally {
    stale.resolve(ok("off"))
    test.store.dispose()
  }
})

test("a refresh of a ready machine keeps showing its state and never flashes checking", async () => {
  const refresh = Promise.withResolvers<RemoteRequestOutcome>()
  let reads = 0
  const test = machine((operation) => (operation === "machine.keepAwake.get" ? (++reads === 2 ? refresh.promise : ok("on")) : undefined))
  try {
    test.store.connect("dev_1")
    await load(test)
    const refreshing = load(test)
    await waitFor(() => reads === 2)
    expect(keepAwake(test)).toEqual({ read: "ready", status: { state: "on" } })
    refresh.resolve(ok("off"))
    await refreshing
    expect(keepAwake(test).status?.state).toBe("off")
  } finally {
    refresh.resolve(ok("off"))
    test.store.dispose()
  }
})

test("disposal ends the reading and a late change result changes nothing", async () => {
  const late = Promise.withResolvers<RemoteRequestOutcome>()
  const test = machine((operation) => (operation === "machine.keepAwake.set" ? late.promise : ok("off")))
  try {
    test.store.connect("dev_1")
    const scope = test.scope()
    await load(test)
    const changing = change(test, true)
    await waitFor(() => keepAwake(test).change?.state === "sending")
    test.store.dispose()
    late.resolve(ok("on"))
    expect((await changing).reached).toBe(false)
    expect(test.cached(remoteKeys.keepAwake(scope))).toBeUndefined()
  } finally {
    late.resolve(ok("off"))
  }
})
