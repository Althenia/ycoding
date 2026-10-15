import { expect, test } from "bun:test"
import { sessionHistoryFixture } from "../fixture/session-history"
import { renderScreen } from "./harness"
import type { useData } from "../../src/context/data"

test("keeps Session chrome and composer mounted before sync and across disconnect", async () => {
  const fixture = sessionHistoryFixture(2)
  const screen = await renderScreen({
    width: 120,
    height: 36,
    args: { sessionID: fixture.sessionID },
    route: fixture.route,
    settle: "",
    config: { session: { sidebar: "hide" } },
    state: "/tmp/ycoding-tui-perf/state",
  })
  const wait = async (ready: () => boolean) => {
    const deadline = Date.now() + 5000
    while (!ready() && Date.now() < deadline) {
      await screen.renderOnce()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(ready()).toBe(true)
  }
  try {
    await wait(() => fixture.requests.includes(`GET /api/session/${fixture.sessionID}/snapshot`))
    await screen.renderOnce()
    expect(screen.frame()).toContain("commands")
    expect(screen.frame()).toContain("Loading session")
    expect(screen.frame()).not.toContain("Waiting for server")
    expect(screen.frame()).not.toContain("Synthetic response")
    await wait(() => screen.renderer.currentFocusedEditor !== null && screen.frame().includes("Message YCoding"))
    expect(screen.frame()).toContain("Message YCoding")
    const editor = screen.renderer.currentFocusedEditor
    await screen.input.typeText("retained draft")
    screen.input.pressKey("RETURN")
    expect(fixture.requests.filter((request) => request.startsWith("POST"))).toEqual([])
    fixture.release()
    await wait(() => screen.frame().includes("Synthetic response 1"))
    expect(screen.renderer.currentFocusedEditor === editor).toBe(true)
    const transcript = screen.scrollbox()
    await screen.waitForEventStream()
    screen.events.disconnect()
    await wait(() => screen.frame().includes("Reconnecting"))
    expect(screen.scrollbox() === transcript).toBe(true)
    expect(screen.renderer.currentFocusedEditor === editor).toBe(true)
    expect(screen.frame()).toContain("retained draft")
    expect(screen.frame()).toContain("Synthetic response 1")
    screen.input.pressKey("RETURN")
    expect(fixture.requests.filter((request) => request.startsWith("POST"))).toEqual([])
    await wait(() => !screen.frame().includes("Reconnecting"))
    await screen.waitForEventStream()
    expect(screen.scrollbox() === transcript).toBe(true)
    expect(screen.frame()).not.toContain("Waiting for background service")
  } finally {
    fixture.release()
    await screen.dispose()
  }
}, 30000)

test("an obsolete transcript read cannot enable submission after reconnect", async () => {
  const fixture = sessionHistoryFixture(2)
  fixture.release()
  const reads = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  let requests = 0
  let data!: ReturnType<typeof useData>
  const screen = await renderScreen({
    width: 120,
    height: 36,
    args: { sessionID: fixture.sessionID },
    settle: "commands",
    state: "/tmp/ycoding-tui-perf/state",
    config: { session: { sidebar: "hide" } },
    data: (value) => {
      data = value
    },
    route: async (url, request) => {
      if (url.pathname === `/api/session/${fixture.sessionID}/snapshot`) {
        const index = requests++
        await reads[index]?.promise
      }
      return fixture.route(url, request)
    },
  })
  const wait = async (ready: () => boolean) => {
    const deadline = Date.now() + 5000
    while (!ready() && Date.now() < deadline) {
      await screen.renderOnce()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(ready()).toBe(true)
  }
  try {
    await screen.waitForEventStream()
    const obsolete = data.session.message.sync(fixture.sessionID)
    const connected = Promise.withResolvers<void>()
    const unsubscribe = data.on("server.connected", () => connected.resolve())
    screen.events.disconnect()
    await connected.promise
    unsubscribe()
    await screen.renderOnce()
    expect(requests).toBe(1)
    reads[0].resolve()
    await obsolete
    await wait(() => requests === 2 && screen.frame().includes("Loading session"))
    await screen.renderOnce()
    expect(screen.frame()).toContain("Loading session")
    await screen.input.typeText("held after reconnect")
    screen.input.pressKey("RETURN")
    reads[1].resolve()
    await wait(() => screen.frame().includes("Synthetic response 1"))
    expect(fixture.requests.filter((request) => request.startsWith("POST"))).toEqual([])
    expect(screen.frame()).toContain("held after reconnect")
    await screen.waitForEventStream()
  } finally {
    reads.forEach((read) => read.resolve())
    await screen.dispose()
  }
}, 30000)
