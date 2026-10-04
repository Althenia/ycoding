import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { RemoteLimits, parseAgentMessage } from "@ycoding-ai/remote"
import { RemoteScheduler } from "../src/remote-scheduler"

beforeEach(() => { jest.useFakeTimers() })
afterEach(() => { jest.useRealTimers() })

function scheduler(options: { buffered?: () => number | undefined } = {}) {
  const sent: string[] = []
  const waiting = new Map<number, () => void>()
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let first = true
  const instance = new RemoteScheduler.Scheduler({
    intervalMs: 0,
    now: Date.now,
    bufferedAmount: options.buffered ?? (() => undefined),
    transmit: async (frame) => {
      if (first) {
        first = false
        await gate
      }
      sent.push(frame)
      waiting.get(sent.length)?.()
      waiting.delete(sent.length)
      return true
    },
  })
  return {
    instance,
    sent,
    release,
    waitFor: (count: number) => sent.length >= count ? Promise.resolve() : new Promise<void>((resolve) => waiting.set(count, resolve)),
  }
}

const live = () => true
const label = (frame: string) => {
  const parsed = parseAgentMessage(frame)
  if (parsed.ok && parsed.value.type === "events") return `${parsed.value.sessionID}:${Reflect.get(parsed.value.events[0] as object, "tag")}`
  return frame
}
const fill = (instance: RemoteScheduler.Scheduler, sessionID: string, tag: string) => {
  for (let index = 0; index < RemoteLimits.maxEventBatch; index++)
    instance.event(sessionID, { tag: index === 0 ? tag : "", index }, 20, 0, live, 1_000)
}

describe("remote scheduler", () => {
  test("sends control first, then alternates events and bulk two to one, rotating sessions and responses", async () => {
    const test = scheduler()
    const gate = test.instance.control("gate", live)
    fill(test.instance, "ses_a", "e1")
    fill(test.instance, "ses_a", "e2")
    fill(test.instance, "ses_a", "e3")
    fill(test.instance, "ses_b", "f1")
    const bulk = [
      test.instance.bulk("a", "a0", live),
      test.instance.bulk("a", "a1", live),
      test.instance.bulk("b", "b0", live),
    ]
    const late = test.instance.control("late", live)
    test.release()
    await Promise.all([gate, late, ...bulk])
    await test.waitFor(9)

    expect(test.sent.map(label)).toEqual(["gate", "late", "ses_a:e1", "ses_b:f1", "a0", "ses_a:e2", "ses_a:e3", "b0", "a1"])
  })

  test("flushes at the batch bound and before the serialized frame would exceed the agent bound", async () => {
    const test = scheduler()
    const gate = test.instance.control("gate", live)
    test.release()
    await gate
    const total = RemoteLimits.maxEventBatch + 1
    for (let index = 0; index < total; index++) test.instance.event("ses_a", { index }, 12, 0, live, 20)
    const large = 100_000
    for (let index = 0; index < 3; index++) test.instance.event("ses_b", { index }, large, 0, live, 20)
    jest.advanceTimersByTime(20)
    await test.waitFor(5)

    const frames = test.sent.slice(1).map((frame) => {
      const parsed = parseAgentMessage(frame)
      if (!parsed.ok || parsed.value.type !== "events") throw new Error("expected an events frame")
      return { length: frame.length, sessionID: parsed.value.sessionID, indexes: parsed.value.events.map((event) => Reflect.get(event as object, "index")) }
    })
    expect(frames.filter((frame) => frame.sessionID === "ses_a").map((frame) => frame.indexes.length)).toEqual([RemoteLimits.maxEventBatch, 1])
    expect(frames.filter((frame) => frame.sessionID === "ses_a").flatMap((frame) => frame.indexes)).toEqual(Array.from({ length: total }, (_, index) => index))
    expect(frames.filter((frame) => frame.sessionID === "ses_b").map((frame) => frame.indexes)).toEqual([[0, 1], [2]])
  })

  test("reset drops every queued frame and open batch and settles queued senders as unsent", async () => {
    const test = scheduler()
    const gate = test.instance.control("gate", live)
    const control = test.instance.control("control", live)
    const bulk = test.instance.bulk("a", "a0", live)
    fill(test.instance, "ses_a", "ready")
    test.instance.event("ses_b", { tag: "open" }, 20, 0, live, 20)
    expect(test.instance.queuedEvents).toBe(RemoteLimits.maxEventBatch + 1)

    test.instance.reset()
    test.release()
    await gate
    expect(await control).toBe(false)
    expect(await bulk).toBe(false)
    expect(jest.getTimerCount()).toBe(0)
    jest.advanceTimersByTime(60)
    expect(test.sent).toEqual(["gate"])
    expect(test.instance.queuedEvents).toBe(0)
  })

  test("drops a queued frame whose fence has lapsed without sending it", async () => {
    const test = scheduler()
    const gate = test.instance.control("gate", live)
    let active = true
    const stale = test.instance.bulk("a", "stale", () => active)
    const kept = test.instance.bulk("b", "kept", live)
    active = false
    test.release()
    await gate
    expect(await stale).toBe(false)
    expect(await kept).toBe(true)
    expect(test.sent).toEqual(["gate", "kept"])
  })
})
