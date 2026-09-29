import { describe, expect, test } from "bun:test"
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
  test("starts leaving after the duration and finishes after the exit", async () => {
    const { events } = observe(40, 30)
    await Bun.sleep(20)
    expect(events).toEqual([])
    await Bun.sleep(40)
    expect(events).toEqual(["leaving"])
    await Bun.sleep(60)
    expect(events).toEqual(["leaving", "done"])
  })

  test("holds the remaining time while paused and spends only that remainder after resuming", async () => {
    const { events, timer } = observe(200, 20)
    await Bun.sleep(80)
    timer.pause()
    await Bun.sleep(300)
    expect(events).toEqual(["paused"])
    timer.resume()
    await Bun.sleep(60)
    expect(events).toEqual(["paused", "running"])
    await Bun.sleep(180)
    expect(events).toEqual(["paused", "running", "leaving", "done"])
  })

  test("ignores repeated pause and resume", async () => {
    const { events, timer } = observe(200, 20)
    timer.resume()
    timer.pause()
    timer.pause()
    timer.resume()
    timer.resume()
    expect(events).toEqual(["paused", "running"])
    timer.dispose()
  })

  test("a manual dismiss leaves at once, cannot be paused, and finishes once", async () => {
    const { events, timer } = observe(1_000, 30)
    timer.dismiss()
    timer.dismiss()
    timer.pause()
    timer.resume()
    expect(events).toEqual(["leaving"])
    await Bun.sleep(80)
    expect(events).toEqual(["leaving", "done"])
  })

  test("dispose cancels both the expiry and the exit", async () => {
    const expiring = observe(20, 20)
    expiring.timer.dispose()
    const leaving = observe(1_000, 40)
    leaving.timer.dismiss()
    leaving.timer.dispose()
    await Bun.sleep(100)
    expect(expiring.events).toEqual([])
    expect(leaving.events).toEqual(["leaving"])
  })
})
