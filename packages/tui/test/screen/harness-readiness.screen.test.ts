import { expect, test } from "bun:test"
import type { useData } from "../../src/context/data"
import { useRoute } from "../../src/context/route"
import { sessionHistoryFixture } from "../fixture/session-history"
import { renderScreen } from "./harness"

test("opt-in Session readiness holds a generic composer frame until canonical bootstrap settles", async () => {
  const fixture = sessionHistoryFixture(0)
  const rechecked = Promise.withResolvers<void>()
  let data: ReturnType<typeof useData> | undefined
  let route: ReturnType<typeof useRoute> | undefined
  let callbacks = 0
  let loadingFrames = 0
  let returned = false
  const pending = renderScreen({
    width: 100,
    height: 30,
    args: { sessionID: fixture.sessionID },
    sessionReady: true,
    route: fixture.route,
    data: (value) => {
      data = value
      route = useRoute()
      callbacks++
    },
    settle: (screen) => {
      const frame = screen.captureCharFrame()
      if (frame.includes("Loading session") && frame.includes("Message YCoding") && ++loadingFrames === 2)
        rechecked.resolve()
      return (
        frame.includes("Message YCoding") &&
        (frame.includes("Loading session") || data?.session.message.history(fixture.sessionID)?.status === "ready")
      )
    },
  }).then((screen) => {
    returned = true
    return screen
  })
  try {
    await rechecked.promise
    await Promise.resolve()
    expect(returned).toBe(false)
    fixture.release()
    const screen = await pending
    expect(route?.data).toMatchObject({ type: "session", sessionID: fixture.sessionID })
    expect(data?.session.message.history(fixture.sessionID)?.status).toBe("ready")
    expect(data?.location.info(data.session.get(fixture.sessionID)!.location)).toBeDefined()
    expect(screen.scrollbox()).toBeDefined()
    expect(screen.frame()).not.toContain("Loading session")
    expect(screen.frame()).toContain("Message YCoding")
    expect(fixture.snapshotQueries).toHaveLength(1)
    expect(callbacks).toBe(1)
  } finally {
    fixture.release()
    await (await pending).dispose()
  }
}, 30_000)

test("default frame settling still returns an intentionally gated loading Session", async () => {
  const fixture = sessionHistoryFixture(0)
  const screen = await renderScreen({
    width: 100,
    height: 30,
    args: { sessionID: fixture.sessionID },
    route: fixture.route,
    settle: "Loading session",
  })
  try {
    expect(screen.frame()).toContain("Loading session")
    expect(screen.frame()).toContain("Message YCoding")
    expect(fixture.snapshotQueries).toHaveLength(1)
  } finally {
    fixture.release()
    await screen.dispose()
  }
}, 30_000)
