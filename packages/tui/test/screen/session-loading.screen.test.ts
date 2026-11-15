import { expect, spyOn, test } from "bun:test"
import { sessionHistoryFixture } from "../fixture/session-history"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { renderScreen } from "./harness"
import type { useData } from "../../src/context/data"
import { useEditorContext } from "../../src/context/editor"
import { useRoute } from "../../src/context/route"
import { useToast } from "../../src/ui/toast"
import { activeGoal, autonomyView } from "../fixture/autonomy"

test("retains resident Session chrome and transcript identity while reconnect refresh is pending", async () => {
  const fixture = sessionHistoryFixture(2)
  fixture.release()
  const refresh = Promise.withResolvers<void>()
  const refreshing = Promise.withResolvers<void>()
  let snapshots = 0
  let recovering = false
  let data!: ReturnType<typeof useData>
  const screen = await renderScreen({
    width: 120,
    height: 36,
    args: { sessionID: fixture.sessionID },
    settle: "Synthetic response 1",
    sessionReady: true,
    config: { session: { sidebar: "hide" } },
    data: (value) => {
      data = value
    },
    route: async (url, request) => {
      if (url.pathname === `/api/session/${fixture.sessionID}/snapshot` && snapshots++ > 0) {
        refreshing.resolve()
        await refresh.promise
      }
      if (url.pathname === "/api/vcs/branch" && recovering) await refresh.promise
      if (url.pathname.endsWith("/autonomy")) {
        if (recovering) await refresh.promise
        return json({ data: autonomyView({ goal: activeGoal() }) })
      }
      return fixture.route(url, request)
    },
  })
  try {
    await screen.waitForEventStream()
    const deadline = Date.now() + 5000
    while (!screen.frame().includes("P Manual") && Date.now() < deadline) {
      await screen.renderOnce()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(screen.frame()).toContain("P Manual")
    const transcript = screen.scrollbox()
    const messages = data.session.message.list(fixture.sessionID)
    const resident = messages?.[1]
    const part = resident?.type === "assistant" ? resident.content[0] : undefined
    await screen.input.typeText("retained reconnect draft")
    recovering = true
    screen.events.disconnect()
    const reconnectDeadline = Date.now() + 5000
    while (!screen.frame().includes("Reconnecting") && Date.now() < reconnectDeadline) {
      await screen.renderOnce()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(screen.frame()).toContain("Reconnecting")
    expect(screen.frame()).toContain("workspace · main")
    expect(screen.frame()).toContain("P Manual")
    expect(screen.frame()).toContain("Synthetic response 1")
    await refreshing.promise
    await screen.waitForEventStream()
    await screen.renderOnce()
    expect(screen.frame()).not.toContain("Loading session")
    expect(screen.frame()).toContain("workspace · main")
    expect(screen.frame()).toContain("P Manual")
    expect(screen.frame()).not.toContain("unknown")
    expect(screen.frame()).toContain("Synthetic response 1")
    expect(screen.frame()).toContain("retained reconnect draft")
    expect(screen.scrollbox()).toBe(transcript)
    screen.input.pressKey("RETURN")
    expect(fixture.requests.filter((request) => request.startsWith("POST"))).toEqual([])
    refresh.resolve()
    await data.session.message.sync(fixture.sessionID)
    await screen.renderOnce()
    expect(data.session.message.list(fixture.sessionID)?.[1]).toBe(resident)
    expect(resident?.type === "assistant" ? resident.content[0] : undefined).toBe(part)
    expect(screen.scrollbox()).toBe(transcript)
    expect(screen.frame()).not.toContain("Loading session")
  } finally {
    refresh.resolve()
    await screen.dispose()
  }
}, 30000)

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
    expect(screen.frame()).toContain("Message YCoding")
    expect(screen.frame()).toContain("Loading session")
    expect(screen.frame()).not.toContain("Waiting for server")
    expect(screen.frame()).not.toContain("Synthetic response")
    await wait(() => screen.renderer.currentFocusedEditor !== null)
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

test("a disposed Session hydration cannot reconnect the editor after switching Sessions", async () => {
  const fixture = sessionHistoryFixture(2)
  fixture.release()
  const nextID = "ses_next_hydration"
  const nextSession = {
    id: nextID,
    title: "Next hydration session",
    projectID: "proj_performance",
    location: { directory: "/tmp/ycoding-tui-perf/workspace" },
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
  }
  const permission = Promise.withResolvers<void>()
  const requested = Promise.withResolvers<void>()
  const reconnected: (string | undefined)[] = []
  let data!: ReturnType<typeof useData>
  let router!: ReturnType<typeof useRoute>
  let restoreEditor = () => {}
  const screen = await renderScreen({
    width: 120,
    height: 36,
    args: { sessionID: fixture.sessionID },
    settle: "Synthetic response 1",
    state: "/tmp/ycoding-tui-perf/state",
    config: { session: { sidebar: "hide" } },
    data: (value) => {
      data = value
      router = useRoute()
      const reconnect = spyOn(useEditorContext(), "reconnect").mockImplementation((directory) => {
        reconnected.push(directory)
      })
      restoreEditor = () => reconnect.mockRestore()
    },
    route: async (url, request) => {
      if (url.pathname === `/api/session/${fixture.sessionID}/permission`) {
        requested.resolve()
        await permission.promise
        return json({ data: [] })
      }
      if (url.pathname === `/api/session/${nextID}`) return json({ data: nextSession })
      if (url.pathname === `/api/session/${nextID}/snapshot`) {
        return sessionSnapshot(nextID, [], { session: nextSession })
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
    await requested.promise
    const oldHydration = data.session.permission.sync(fixture.sessionID)
    expect(reconnected).toEqual([])
    router.navigate({ type: "session", sessionID: nextID })
    await wait(() => reconnected.length > 0 && data.session.message.history(nextID)?.status === "ready")
    expect(reconnected).toEqual(["/tmp/ycoding-tui-perf/workspace"])
    const editor = screen.renderer.currentFocusedEditor
    await screen.input.typeText("keep the next draft")
    permission.resolve()
    await oldHydration
    await new Promise<void>((resolve) => setImmediate(resolve))
    await screen.renderOnce()
    expect(router.data).toMatchObject({ type: "session", sessionID: nextID })
    expect(screen.renderer.currentFocusedEditor).toBe(editor)
    expect(screen.frame()).toContain("keep the next draft")
    expect(reconnected).toEqual(["/tmp/ycoding-tui-perf/workspace"])
  } finally {
    permission.resolve()
    await screen.dispose()
    restoreEditor()
  }
}, 30000)

for (const switched of [false, true]) {
  test(`hydration rejection ${switched ? "from a disposed Session does not affect the selected Session" : "reports the current Session error"}`, async () => {
    const fixture = sessionHistoryFixture(2)
    fixture.release()
    const nextID = "ses_next_rejection"
    const nextSession = {
      id: nextID,
      title: "Next rejection session",
      projectID: "proj_performance",
      location: { directory: "/tmp/ycoding-tui-perf/workspace" },
      agent: "build",
      model: { providerID: "fixture", id: "fixture" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
    }
    const review = Promise.withResolvers<void>()
    const requested = Promise.withResolvers<void>()
    let data!: ReturnType<typeof useData>
    let router!: ReturnType<typeof useRoute>
    let toast!: ReturnType<typeof useToast>
    const screen = await renderScreen({
      width: 120,
      height: 36,
      args: { sessionID: fixture.sessionID },
      settle: "Synthetic response 1",
      state: "/tmp/ycoding-tui-perf/state",
      config: { session: { sidebar: "hide" } },
      data: (value) => {
        data = value
        router = useRoute()
        toast = useToast()
      },
      route: async (url, request) => {
        if (url.pathname === `/api/session/${fixture.sessionID}/review`) {
          requested.resolve()
          await review.promise
          return json({ message: "Synthetic hydration unavailable" }, { status: 503 })
        }
        if (url.pathname === `/api/session/${nextID}`) return json({ data: nextSession })
        if (url.pathname === `/api/session/${nextID}/snapshot`) {
          return sessionSnapshot(nextID, [], { session: nextSession })
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
      await requested.promise
      const rejected = data.session.review.sync(fixture.sessionID).then(() => false, () => true)
      if (switched) {
        router.navigate({ type: "session", sessionID: nextID })
        await wait(() => data.session.message.history(nextID)?.status === "ready" && screen.renderer.currentFocusedEditor !== null)
      }
      expect(toast.currentToast).toBeNull()
      const editor = screen.renderer.currentFocusedEditor
      await screen.input.typeText("retain the selected draft")
      review.resolve()
      expect(await rejected).toBe(true)
      await new Promise<void>((resolve) => setImmediate(resolve))
      await screen.renderOnce()
      expect(router.data).toMatchObject({ type: "session", sessionID: switched ? nextID : fixture.sessionID })
      expect(screen.renderer.currentFocusedEditor).toBe(editor)
      expect(screen.frame()).toContain("retain the selected draft")
      if (switched) expect(toast.currentToast).toBeNull()
      else {
        expect(toast.currentToast?.variant).toBe("error")
        expect(toast.currentToast?.message.length).toBeGreaterThan(0)
        expect(screen.frame()).toContain("Error")
      }
    } finally {
      review.resolve()
      await screen.dispose()
    }
  }, 30000)
}

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
    let obsoleteSettled = false
    const obsolete = data.session.message.sync(fixture.sessionID).then(() => { obsoleteSettled = true })
    const connected = Promise.withResolvers<void>()
    const unsubscribe = data.on("server.connected", () => connected.resolve())
    screen.events.disconnect()
    await connected.promise
    unsubscribe()
    await wait(() => requests === 2 && screen.frame().includes("Loading session"))
    reads[0].resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await screen.renderOnce()
    expect(obsoleteSettled).toBe(false)
    expect(screen.frame()).toContain("Loading session")
    await screen.input.typeText("held after reconnect")
    screen.input.pressKey("RETURN")
    reads[1].resolve()
    await obsolete
    await wait(() => screen.frame().includes("Synthetic response 1"))
    expect(fixture.requests.filter((request) => request.startsWith("POST"))).toEqual([])
    expect(screen.frame()).toContain("held after reconnect")
    await screen.waitForEventStream()
  } finally {
    reads.forEach((read) => read.resolve())
    await screen.dispose()
  }
}, 30000)

test("reconnect hydrates the selected Session without waiting for an obsolete snapshot response", async () => {
  const fixture = sessionHistoryFixture(2)
  fixture.release()
  const obsolete = Promise.withResolvers<void>()
  const requested = Promise.withResolvers<void>()
  let requests = 0
  let data!: ReturnType<typeof useData>
  let toast!: ReturnType<typeof useToast>
  const screen = await renderScreen({
    width: 120,
    height: 36,
    args: { sessionID: fixture.sessionID },
    settle: "commands",
    state: "/tmp/ycoding-tui-perf/state",
    config: { session: { sidebar: "hide" } },
    data: (value) => {
      data = value
      toast = useToast()
    },
    route: async (url, request) => {
      if (url.pathname === `/api/session/${fixture.sessionID}/snapshot`) {
        requests++
        if (requests === 1) {
          requested.resolve()
          await obsolete.promise
        }
      }
      return fixture.route(url, request)
    },
  })
  let unsubscribe = () => {}
  try {
    await requested.promise
    await screen.waitForEventStream()
    expect(screen.frame()).toContain("Loading session")
    const connected = Promise.withResolvers<void>()
    unsubscribe = data.on("server.connected", () => connected.resolve())
    screen.events.disconnect()
    await connected.promise
    unsubscribe()
    const deadline = Date.now() + 5000
    while (!screen.frame().includes("Synthetic response 1") && Date.now() < deadline) {
      await screen.renderOnce()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(requests).toBe(2)
    expect(screen.frame()).toContain("Synthetic response 1")
    expect(screen.frame()).not.toContain("Loading session")
    expect(toast.currentToast).toBeNull()
  } finally {
    unsubscribe()
    obsolete.resolve()
    await screen.dispose()
  }
}, 30000)
