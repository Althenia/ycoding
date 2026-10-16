import { expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { startRelayDouble, type RelayRequestHandler } from "./relay-double"

async function harness(handler?: RelayRequestHandler) {
  const relay = await startRelayDouble({ handler, advertisedSessions: ["ses_a", "ses_b"] })
  const timers: { callback: () => void; ms: number }[] = []
  const schedule = (callback: () => void, ms = 0) => {
    const timer = { callback, ms }
    timers.push(timer)
    return () => {
      const index = timers.indexOf(timer)
      if (index >= 0) timers.splice(index, 1)
    }
  }
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) =>
      createRemoteTransport({ url: relay.wsURL(deviceID), handlers, schedule, createSocket: relay.createSocket }),
    schedule,
    now: () => 1_000,
  })
  const until = async (predicate: () => boolean) => {
    for (let index = 0; index < 200 && !predicate(); index++) {
      const ready = timers.filter((timer) => timer.ms < 100)
      for (const timer of ready) {
        timers.splice(timers.indexOf(timer), 1)
        timer.callback()
      }
      await Bun.sleep(5)
    }
    expect(predicate()).toBe(true)
  }
  const count = (operation: string) => relay.requests.filter((request) => request.operation === operation).length
  await store.load()
  await until(() => store.state().sessionListStatus === "ready")
  return {
    store,
    relay,
    timers,
    until,
    count,
    stop: async () => {
      store.dispose()
      await relay.stop()
    },
  }
}

test("opening reads overlap subscription admission without applying unadmitted state", async () => {
  const admission = Promise.withResolvers<void>()
  const fixture = await harness(async (request) => {
    if (request.operation === "event.subscribe") await admission.promise
    return "default" as const
  })
  try {
    const selecting = fixture.store.selectSession("ses_a")
    await fixture.until(() =>
      [
        "session.snapshot",
        "session.todo.list",
        "session.autonomy.get",
        "session.pending.list",
        "session.permission.list",
        "session.guardrail.request.list",
        "session.form.list",
      ].every((operation) => fixture.count(operation) === 1),
    )
    expect(fixture.store.state().history).toBeUndefined()
    expect(fixture.store.state().todos).toBeUndefined()
    expect(fixture.store.state().view?.autonomy).toBeUndefined()
    admission.resolve()
    await selecting
    await fixture.until(() => fixture.store.state().history?.status === "idle")
    fixture.relay.pushEvent("ses_a", {
      type: "session.renamed",
      data: { sessionID: "ses_a", title: "Live after parallel opening" },
    })
    await fixture.until(() => fixture.store.state().view?.title === "Live after parallel opening")
    expect(fixture.relay.requests.findIndex((request) => request.operation === "event.subscribe")).toBeLessThan(
      fixture.relay.requests.findIndex((request) => request.operation === "session.snapshot"),
    )
  } finally {
    admission.resolve()
    await fixture.stop()
  }
})

test("refused subscription discards every parallel Session result", async () => {
  const fixture = await harness((request) =>
    request.operation === "event.subscribe"
      ? { ok: false, code: "session_not_allowed", message: "refused" }
      : "default",
  )
  try {
    await fixture.store.selectSession("ses_a")
    expect(fixture.store.state().notice).toContain("not available")
    expect(fixture.store.state().history).toBeUndefined()
    expect(fixture.store.state().todos).toBeUndefined()
    expect(fixture.store.state().view?.autonomy).toBeUndefined()
    expect(fixture.store.state().view?.messages).toEqual([])
  } finally {
    await fixture.stop()
  }
})

test("inventory bursts retain visible rows and share one trailing 750ms read without reloading history", async () => {
  const fixture = await harness()
  try {
    await fixture.store.selectSession("ses_a")
    await fixture.until(() => fixture.count("session.log") === 1)
    const snapshots = fixture.count("session.snapshot")
    const lists = fixture.count("workspace.list")
    const states: string[] = []
    const unsubscribe = fixture.store.subscribe(() => states.push(fixture.store.state().sessionListStatus))
    fixture.relay.pushSessions(["ses_a"])
    await fixture.until(() => fixture.count("workspace.list") === lists + 1)
    fixture.relay.pushSessions(["ses_a"])
    fixture.relay.pushSessions(["ses_a"])
    await fixture.until(() => fixture.timers.some((timer) => timer.ms === 750))
    expect(fixture.count("workspace.list")).toBe(lists + 1)
    expect(fixture.store.state().sessions.length).toBeGreaterThan(0)
    const timer = fixture.timers.find((timer) => timer.ms === 750)!
    fixture.timers.splice(fixture.timers.indexOf(timer), 1)
    timer.callback()
    await fixture.until(() => fixture.count("workspace.list") === lists + 2)
    await fixture.until(() => fixture.store.state().sessionListStatus === "ready")
    expect(states).not.toContain("loading")
    expect(fixture.count("session.snapshot")).toBe(snapshots)
    expect(fixture.count("session.capturedChanges.list")).toBe(1)
    unsubscribe()
  } finally {
    await fixture.stop()
  }
})

test("opening reconciles one missed watermark then stops checking its replacement snapshot", async () => {
  const fixture = await harness((request) =>
    request.operation === "session.log"
      ? {
          ok: true,
          value: {
            data: [
              {
                type: "session.renamed",
                data: { sessionID: "ses_a", title: "Missed" },
                durable: { aggregateID: "ses_a", seq: 50, version: 1 },
              },
            ],
          },
        }
      : "default",
  )
  try {
    await fixture.store.selectSession("ses_a")
    await fixture.until(() => fixture.count("session.snapshot") === 2)
    expect(fixture.count("session.log")).toBe(1)
  } finally {
    await fixture.stop()
  }
})

test("inventory refresh shares an opening watermark check while its log is pending", async () => {
  const log = Promise.withResolvers<void>()
  const fixture = await harness(async (request) => {
    if (request.operation === "session.log") await log.promise
    return "default" as const
  })
  try {
    await fixture.store.selectSession("ses_a")
    await fixture.until(() => fixture.count("session.log") === 1)
    const lists = fixture.count("workspace.list")
    fixture.relay.pushSessions(["ses_a"])
    await fixture.until(() => fixture.count("workspace.list") > lists)
    expect(fixture.count("session.log")).toBe(1)
    log.resolve()
  } finally {
    log.resolve()
    await fixture.stop()
  }
})

test("captured refreshes share an in-flight read and throttle from its settlement", async () => {
  const capture = Promise.withResolvers<void>()
  let reads = 0
  const fixture = await harness(async (request) => {
    if (request.operation === "session.capturedChanges.list" && ++reads === 1) await capture.promise
    return "default" as const
  })
  try {
    await fixture.store.selectSession("ses_a")
    await fixture.until(() => fixture.count("session.capturedChanges.list") === 1)
    fixture.relay.pushEvent("ses_a", {
      type: "session.step.ended",
      data: { sessionID: "ses_a", assistantMessageID: "msg_reply" },
    })
    await fixture.until(() => (fixture.store.state().view?.watermark ?? 0) > 0)
    expect(fixture.count("session.capturedChanges.list")).toBe(1)
    const previous = new Set(fixture.timers)
    capture.resolve()
    await fixture.until(() => fixture.store.state().view?.capturedChanges !== undefined)
    await fixture.until(() => fixture.timers.some((timer) => !previous.has(timer) && timer.ms === 10_000))
    const timer = fixture.timers.find((timer) => !previous.has(timer) && timer.ms === 10_000)!
    fixture.timers.splice(fixture.timers.indexOf(timer), 1)
    timer.callback()
    await fixture.until(() => fixture.count("session.capturedChanges.list") === 2)
  } finally {
    capture.resolve()
    await fixture.stop()
  }
})
