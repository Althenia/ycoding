import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { createToastTimer } from "./toast-timer"

function observe(duration: number, exit: number) {
  const events: string[] = []
  const timer = createToastTimer({
    duration,
    exit,
    onChange: (state) => events.push(state.leaving ? "leaving" : state.paused ? "paused" : "running"),
    onDone: () => events.push("done"),
  })
  return { events, timer }
}

describe("toast timer", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test("starts leaving after the duration and finishes after the exit", () => {
    const { events } = observe(40, 30)
    jest.advanceTimersByTime(39)
    expect(events).toEqual([])
    jest.advanceTimersByTime(1)
    expect(events).toEqual(["leaving"])
    jest.advanceTimersByTime(29)
    expect(events).toEqual(["leaving"])
    jest.advanceTimersByTime(1)
    expect(events).toEqual(["leaving", "done"])
  })

  test("holds the remaining time while paused and spends only that remainder after resuming", () => {
    const { events, timer } = observe(200, 20)
    jest.advanceTimersByTime(80)
    timer.pause()
    jest.advanceTimersByTime(300)
    expect(events).toEqual(["paused"])
    timer.resume()
    jest.advanceTimersByTime(119)
    expect(events).toEqual(["paused", "running"])
    jest.advanceTimersByTime(1)
    expect(events).toEqual(["paused", "running", "leaving"])
    jest.advanceTimersByTime(20)
    expect(events).toEqual(["paused", "running", "leaving", "done"])
  })

  test("ignores repeated pause and resume", () => {
    const { events, timer } = observe(200, 20)
    timer.resume()
    timer.pause()
    timer.pause()
    timer.resume()
    timer.resume()
    expect(events).toEqual(["paused", "running"])
    timer.dispose()
  })

  test("a manual dismiss leaves at once, cannot be paused, and finishes once", () => {
    const { events, timer } = observe(1_000, 30)
    timer.dismiss()
    timer.dismiss()
    timer.pause()
    timer.resume()
    expect(events).toEqual(["leaving"])
    jest.advanceTimersByTime(30)
    expect(events).toEqual(["leaving", "done"])
    jest.advanceTimersByTime(1_000)
    expect(events).toEqual(["leaving", "done"])
  })

  test("dispose cancels both the expiry and the exit", () => {
    const expiring = observe(20, 20)
    expiring.timer.dispose()
    const leaving = observe(1_000, 40)
    leaving.timer.dismiss()
    leaving.timer.dispose()
    jest.advanceTimersByTime(2_000)
    expect(expiring.events).toEqual([])
    expect(leaving.events).toEqual(["leaving"])
  })
})
