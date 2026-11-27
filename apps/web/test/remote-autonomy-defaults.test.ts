import { expect, test } from "bun:test"
import type { RemoteErrorCode } from "@ycoding-ai/remote"
import type { AutonomyModes } from "../src/remote/autonomy"
import type {
  RemoteRequestOutcome,
  RemoteTransport,
  RemoteTransportHandlers,
  RemoteTransportRequest,
} from "../src/remote/transport"
import { createRemoteHttp } from "../src/remote/http"
import { remoteKeys } from "../src/remote/queries"
import { createRemoteStore } from "../src/remote/store"
import { queriesOf } from "./remote-queries"
import { waitFor } from "./relay-double"

type Call = { readonly operation: string; readonly request?: RemoteTransportRequest }

const defaults = (change: Partial<AutonomyModes> = {}): RemoteRequestOutcome => ({
  status: "ok",
  value: { data: { permissions: "manual", guardrails: "manual", answers: "manual", ...change } },
})
const failed = (code: RemoteErrorCode, message: string): RemoteRequestOutcome => ({ status: "failed", error: { code, message } })
const unanswered: RemoteRequestOutcome = { status: "unknown", error: { code: "outcome_unknown", message: "The machine did not answer in time." } }

function machine(answer: (operation: string, request: RemoteTransportRequest | undefined) => RemoteRequestOutcome | undefined) {
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
          calls.push({ operation, request })
          return answer(operation, request) ?? { status: "ok", value: { data: [] } }
        },
      }
    },
  })
  const count = (operation: string) => calls.filter((call) => call.operation === operation).length
  return { store, calls, count, ...queriesOf(store) }
}

type Machine = ReturnType<typeof machine>

const load = (test: Machine) => test.store.queryClient.fetchQuery({ ...test.queries.autonomyDefaults(test.scope(), true), staleTime: 0 })
const saved = (test: Machine) => test.cached<AutonomyModes>(remoteKeys.autonomyDefaults(test.scope()))?.state.data
const watch = async (test: Machine) => {
  const watching = test.observe(test.queries.autonomyDefaults(test.scope(), true))
  await waitFor(() => saved(test) !== undefined)
  return watching.stop
}
const sent = (test: Machine) => test.calls.filter((call) => call.operation === "autonomyDefaults.set").map((call) => call.request)

test("reads the machine's saved defaults once with no Session or input", async () => {
  const test = machine((operation) => (operation === "autonomyDefaults.get" ? defaults({ answers: "auto" }) : undefined))
  try {
    test.store.connect("dev_1")
    expect(await load(test)).toEqual({ permissions: "manual", guardrails: "manual", answers: "auto" })
    const read = test.calls.find((call) => call.operation === "autonomyDefaults.get")
    expect(test.count("autonomyDefaults.get")).toBe(1)
    expect(read?.request?.sessionID).toBeUndefined()
    expect(read?.request?.input).toBeUndefined()
  } finally {
    test.store.dispose()
  }
})

test("a failed, silent, or unreadable read never reads as Manual", async () => {
  for (const outcome of [failed("internal_error", "Defaults exploded"), unanswered, { status: "ok", value: { data: { permissions: "sometimes" } } } as RemoteRequestOutcome]) {
    const test = machine((operation) => (operation === "autonomyDefaults.get" ? outcome : undefined))
    try {
      test.store.connect("dev_1")
      await expect(load(test)).rejects.toThrow()
      expect(saved(test)).toBeUndefined()
    } finally {
      test.store.dispose()
    }
  }
})

test("saving a non-YOLO default sends only that category without acceptance, then refreshes the read", async () => {
  let current = defaults()
  const test = machine((operation, request) => {
    if (operation === "autonomyDefaults.set") current = defaults({ guardrails: request?.input?.guardrails === "auto" ? "auto" : "manual" })
    return operation === "autonomyDefaults.get" || operation === "autonomyDefaults.set" ? current : undefined
  })
  try {
    test.store.connect("dev_1")
    const stop = await watch(test)
    expect(await test.queries.saveAutonomyDefaults(test.scope(), { guardrails: "auto" }, false)).toEqual({ reached: true })
    expect(sent(test).map((request) => request?.input)).toEqual([{ guardrails: "auto" }])
    expect(sent(test)[0]?.sessionID).toBeUndefined()
    await waitFor(() => test.count("autonomyDefaults.get") === 2 && saved(test)?.guardrails === "auto")
    stop()
    expect(saved(test)).toEqual({ permissions: "manual", guardrails: "auto", answers: "manual" })
  } finally {
    test.store.dispose()
  }
})

test("a confirmed YOLO default sends acceptYolo true with its category", async () => {
  const test = machine((operation) => (operation === "autonomyDefaults.get" || operation === "autonomyDefaults.set" ? defaults({ permissions: "yolo" }) : undefined))
  try {
    test.store.connect("dev_1")
    const stop = await watch(test)
    expect((await test.queries.saveAutonomyDefaults(test.scope(), { permissions: "yolo" }, true)).reached).toBe(true)
    expect(sent(test).map((request) => request?.input)).toEqual([{ permissions: "yolo", acceptYolo: true }])
    stop()
  } finally {
    test.store.dispose()
  }
})

test("resetting a default sends Manual for that category alone", async () => {
  let current = defaults({ answers: "yolo" })
  const test = machine((operation) => {
    if (operation === "autonomyDefaults.set") current = defaults()
    return operation === "autonomyDefaults.get" || operation === "autonomyDefaults.set" ? current : undefined
  })
  try {
    test.store.connect("dev_1")
    const stop = await watch(test)
    expect(saved(test)?.answers).toBe("yolo")
    expect((await test.queries.saveAutonomyDefaults(test.scope(), { answers: "manual" }, false)).reached).toBe(true)
    expect(sent(test).map((request) => request?.input)).toEqual([{ answers: "manual" }])
    await waitFor(() => saved(test)?.answers === "manual")
    stop()
  } finally {
    test.store.dispose()
  }
})

test("a refused save reports the machine's reason and keeps the saved defaults", async () => {
  const test = machine((operation) => {
    if (operation === "autonomyDefaults.set") return failed("invalid_message", "Saving a YOLO default requires explicit risk acceptance")
    return operation === "autonomyDefaults.get" ? defaults() : undefined
  })
  try {
    test.store.connect("dev_1")
    const stop = await watch(test)
    const result = await test.queries.saveAutonomyDefaults(test.scope(), { permissions: "yolo" }, false)
    stop()
    expect(result.reached).toBe(false)
    expect(result.message).toContain("requires explicit risk acceptance")
    expect(saved(test)).toEqual({ permissions: "manual", guardrails: "manual", answers: "manual" })
  } finally {
    test.store.dispose()
  }
})

test("an unanswered save is reported unconfirmed, re-read once, and never replayed", async () => {
  const test = machine((operation) => (operation === "autonomyDefaults.set" ? unanswered : operation === "autonomyDefaults.get" ? defaults() : undefined))
  try {
    test.store.connect("dev_1")
    const stop = await watch(test)
    const result = await test.queries.saveAutonomyDefaults(test.scope(), { guardrails: "auto" }, false)
    expect(result.reached).toBe(false)
    expect(result.message).toMatch(/unconfirmed/i)
    await waitFor(() => test.count("autonomyDefaults.get") === 2)
    stop()
    expect(test.count("autonomyDefaults.set")).toBe(1)
  } finally {
    test.store.dispose()
  }
})

test("nothing is sent without an open machine connection", async () => {
  const test = machine(() => undefined)
  try {
    const result = await test.queries.saveAutonomyDefaults(test.scope(), { permissions: "auto" }, false)
    expect(result.reached).toBe(false)
    expect(result.message).toBeTruthy()
    expect(test.calls).toHaveLength(0)
  } finally {
    test.store.dispose()
  }
})
