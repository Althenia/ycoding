import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import type { YCodingEvent } from "@ycoding-ai/client"
import type { useData } from "../../src/context/data"
import { sessionHistoryFixture } from "../fixture/session-history"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { renderScreen } from "./harness"

test("first and last navigation reveal both ends of loaded history beyond the 400-row render window", async () => {
  const fixture = sessionHistoryFixture(600)
  fixture.release()
  fixture.messages.forEach((message) => {
    if (message.type === "assistant")
      message.content = [{ type: "text", text: `Synthetic response ${Number(message.id.slice(-6))}` }]
  })
  let data!: ReturnType<typeof useData>
  const screen = await renderScreen({
    width: 120,
    height: 36,
    args: { sessionID: fixture.sessionID },
    settle: "Synthetic response 599",
    route: fixture.route,
    state: "/tmp/ycoding-tui-perf/state",
    config: { session: { sidebar: "hide" } },
    data: (value) => {
      data = value
    },
  })
  const wait = async (ready: () => boolean) => {
    const end = performance.now() + 5000
    while (!ready() && performance.now() < end) {
      await screen.renderOnce()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    if (!ready())
      throw new Error(
        `Viewport condition failed; loaded ${data.session.message.list(fixture.sessionID).length}; reads ${fixture.snapshotQueries.join(",")}:\n${screen.frame()}`,
      )
    expect(ready()).toBe(true)
  }
  const command = async (text: string) => {
    screen.input.pressKey("p", { ctrl: true })
    await wait(() => screen.frame().includes("Commands"))
    await wait(() => screen.renderer.currentFocusedEditor instanceof InputRenderable)
    await screen.input.typeText(text)
    expect((screen.renderer.currentFocusedEditor as InputRenderable).value).toBe(text)
    await screen.renderOnce()
    screen.input.pressKey("RETURN")
  }
  try {
    await command("First message")
    await wait(() => screen.frame().includes("Inspect synthetic module 0"))
    expect(data.session.message.list(fixture.sessionID)).toHaveLength(600)
    expect(screen.scrollbox()!.getRenderable("msg_000000")).toBeDefined()
    expect(screen.scrollbox()!.getRenderable("msg_000599")).toBeUndefined()
    await command("Last message")
    await wait(() => screen.frame().includes("Synthetic response 599"))
    expect(screen.scrollbox()!.getRenderable("msg_000599")).toBeDefined()
    expect(screen.scrollbox()!.getRenderable("msg_000000")).toBeUndefined()
  } finally {
    await screen.dispose()
  }
}, 30000)

test("an initial history failure keeps the editor and offers a keyboard retry without admitting the draft", async () => {
  const fixture = sessionHistoryFixture(200)
  fixture.release()
  let failed = true
  const screen = await renderScreen({
    width: 120,
    height: 36,
    args: { sessionID: fixture.sessionID },
    settle: "Retry history",
    state: "/tmp/ycoding-tui-perf/state",
    config: { session: { sidebar: "hide" } },
    route: (url, request) => {
      if (url.pathname.endsWith("/snapshot") && failed) return json({ message: "History unavailable" }, { status: 503 })
      return fixture.route(url, request)
    },
  })
  const wait = async (ready: () => boolean) => {
    const end = performance.now() + 5000
    while (!ready() && performance.now() < end) {
      await screen.renderOnce()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(ready()).toBe(true)
  }
  try {
    const editor = screen.renderer.currentFocusedEditor
    await screen.input.typeText("Keep this draft")
    screen.input.pressKey("RETURN")
    await screen.renderOnce()
    expect(screen.renderer.currentFocusedEditor).toBe(editor)
    expect(fixture.requests.some((request) => request.startsWith("POST"))).toBe(false)
    failed = false
    screen.input.pressKey("p", { ctrl: true })
    await wait(() => screen.renderer.currentFocusedEditor instanceof InputRenderable)
    await screen.input.typeText("Retry history")
    await screen.renderOnce()
    screen.input.pressKey("RETURN")
    await wait(() => screen.frame().includes("Synthetic response 199"))
    expect(screen.frame()).toContain("Keep this draft")
    expect(fixture.snapshotQueries).toEqual(["?limit=100"])
  } finally {
    await screen.dispose()
  }
}, 30000)

test("opens the newest window and keeps the visible message anchored when top scrolling pages older history", async () => {
  const fixture = sessionHistoryFixture(2000)
  fixture.release()
  const requested = Promise.withResolvers<void>()
  const older = Promise.withResolvers<void>()
  let data!: ReturnType<typeof useData>
  const screen = await renderScreen({
    width: 120,
    height: 36,
    args: { sessionID: fixture.sessionID },
    settle: "Synthetic response 1999",
    state: "/tmp/ycoding-tui-perf/state",
    config: { session: { sidebar: "hide" } },
    data: (value) => {
      data = value
    },
    route: async (url, request) => {
      if (url.pathname.endsWith("/snapshot") && url.searchParams.has("before")) {
        requested.resolve()
        await older.promise
      }
      return fixture.route(url, request)
    },
  })
  const wait = async (ready: () => boolean) => {
    const end = performance.now() + 5000
    while (!ready() && performance.now() < end) {
      await screen.renderOnce()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(ready()).toBe(true)
  }
  try {
    await wait(
      () =>
        !!screen.scrollbox() &&
        screen.scrollbox()!.scrollTop ===
          Math.max(0, screen.scrollbox()!.scrollHeight - screen.scrollbox()!.viewport.height),
    )
    expect(data.session.message.list(fixture.sessionID)).toHaveLength(100)
    expect(fixture.requests).not.toContain(`GET /api/session/${fixture.sessionID}/message`)
    const scroll = screen.scrollbox()!
    scroll.stickyScroll = false
    scroll.scrollTo(0)
    await screen.renderOnce()
    const anchor = scroll.getRenderable("msg_001900")!
    expect(anchor).toBeDefined()
    const y = anchor.y
    await wait(() => data.session.message.history(fixture.sessionID)?.status === "paging")
    await requested.promise
    expect(screen.frame()).toContain("Loading older history")
    older.resolve()
    await wait(
      () => data.session.message.list(fixture.sessionID).length === 200 && scroll.getRenderable("msg_001900")?.y === y,
    )
    expect(scroll.getRenderable("msg_001900") === anchor).toBe(true)
    expect(fixture.snapshotQueries).toEqual(["?limit=100", "?limit=100&before=fixture_cursor_1900"])
    expect(data.session.message.get(fixture.sessionID, "msg_001800")).toBeDefined()
    expect(data.session.message.get(fixture.sessionID, "msg_001700")).toBeUndefined()
  } finally {
    older.resolve()
    await screen.dispose()
  }
}, 30000)

test("enables backward paging when Location hydration mounts the viewport after history settles", async () => {
  const fixture = sessionHistoryFixture(200)
  fixture.release()
  const location = Promise.withResolvers<void>()
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
      if (url.pathname === "/api/location") {
        if (url.searchParams.get("location[directory]") !== "/tmp/ycoding-tui-perf/workspace") return undefined
        await location.promise
      }
      return fixture.route(url, request)
    },
  })
  const wait = async (ready: () => boolean) => {
    const deadline = performance.now() + 5000
    while (!ready() && performance.now() < deadline) {
      await screen.renderOnce()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(ready()).toBe(true)
  }
  try {
    await wait(() => data.session.message.history(fixture.sessionID)?.status === "ready")
    expect(data.session.message.list(fixture.sessionID)).toHaveLength(100)
    expect(screen.scrollbox()).toBeUndefined()
    await screen.renderOnce()
    await screen.renderOnce()
    location.resolve()
    await wait(() => screen.frame().includes("Synthetic response 199"))
    const scroll = screen.scrollbox()!
    await screen.renderOnce()
    await screen.renderOnce()
    scroll.stickyScroll = false
    scroll.scrollTo(0)
    await wait(() => data.session.message.list(fixture.sessionID).length === 200)
    expect(fixture.snapshotQueries).toEqual(["?limit=100", "?limit=100&before=fixture_cursor_100"])
    expect(scroll.getRenderable("msg_000000")).toBeDefined()
    expect(fixture.requests).not.toContain(`GET /api/session/${fixture.sessionID}/message`)
  } finally {
    location.resolve()
    await screen.dispose()
  }
}, 30000)

test("preserves top-of-viewport paging intent while the newest window refreshes", async () => {
  const fixture = sessionHistoryFixture(200)
  fixture.release()
  const latest = Promise.withResolvers<void>()
  let refreshing = false
  let data!: ReturnType<typeof useData>
  const screen = await renderScreen({
    width: 120,
    height: 36,
    args: { sessionID: fixture.sessionID },
    settle: "Synthetic response 199",
    state: "/tmp/ycoding-tui-perf/state",
    config: { session: { sidebar: "hide" } },
    data: (value) => {
      data = value
    },
    route: async (url, request) => {
      if (refreshing && url.pathname.endsWith("/snapshot") && !url.searchParams.has("before")) await latest.promise
      return fixture.route(url, request)
    },
  })
  const wait = async (ready: () => boolean) => {
    const deadline = performance.now() + 5000
    while (!ready() && performance.now() < deadline) {
      await screen.renderOnce()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(ready()).toBe(true)
  }
  try {
    await screen.renderOnce()
    await screen.renderOnce()
    refreshing = true
    data.session.message.invalidate(fixture.sessionID)
    const refresh = data.session.message.sync(fixture.sessionID)
    await wait(() => data.session.message.history(fixture.sessionID)?.status === "loading")
    const scroll = screen.scrollbox()!
    scroll.stickyScroll = false
    scroll.scrollTo(0)
    await screen.renderOnce()
    await screen.renderOnce()
    expect(data.session.message.list(fixture.sessionID)).toHaveLength(100)
    latest.resolve()
    await refresh
    await wait(() => data.session.message.list(fixture.sessionID).length === 200)
    expect(fixture.snapshotQueries).toEqual(["?limit=100", "?limit=100", "?limit=100&before=fixture_cursor_100"])
  } finally {
    latest.resolve()
    await screen.dispose()
  }
}, 30000)

function appendedAssistant(sessionID: string, id: string, text: string, seq: number): YCodingEvent[] {
  const envelope = {
    created: 100 + seq,
    durable: { aggregateID: sessionID, seq, version: 1 },
    location: { directory: "/tmp/ycoding-tui-perf/workspace" },
  }
  return [
    {
      id: `evt_${id}_step`,
      type: "session.step.started",
      ...envelope,
      data: { sessionID, assistantMessageID: id, agent: "build", model: { providerID: "fixture", id: "fixture" } },
    },
    {
      id: `evt_${id}_text_started`,
      type: "session.text.started",
      ...envelope,
      data: { sessionID, assistantMessageID: id, ordinal: 0 },
    },
    {
      id: `evt_${id}_text_delta`,
      type: "session.text.delta",
      created: envelope.created,
      location: envelope.location,
      data: { sessionID, assistantMessageID: id, ordinal: 0, delta: text },
    },
    {
      id: `evt_${id}_step_ended`,
      type: "session.step.ended",
      ...envelope,
      data: {
        sessionID,
        assistantMessageID: id,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    },
  ] as YCodingEvent[]
}

test("a short session keeps rows appended after an automatic older page mounted", async () => {
  const fixture = sessionHistoryFixture(150)
  fixture.release()
  let data!: ReturnType<typeof useData>
  const screen = await renderScreen({
    width: 120,
    height: 36,
    args: { sessionID: fixture.sessionID },
    settle: "Synthetic response 149",
    route: fixture.route,
    state: "/tmp/ycoding-tui-perf/state",
    config: { session: { sidebar: "hide" } },
    data: (value) => {
      data = value
    },
  })
  const wait = async (ready: () => boolean) => {
    const end = performance.now() + 5000
    while (!ready() && performance.now() < end) {
      await screen.renderOnce()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    if (!ready())
      throw new Error(
        `Viewport condition failed; loaded ${data.session.message.list(fixture.sessionID).length}:\n${screen.frame()}`,
      )
  }
  try {
    await wait(() => data.session.message.list(fixture.sessionID).length === 100)
    const scroll = screen.scrollbox()!
    scroll.stickyScroll = false
    scroll.scrollTo(0)
    await wait(() => data.session.message.list(fixture.sessionID).length === 150)
    await wait(() => data.session.message.history(fixture.sessionID)?.status === "ready")
    for (const event of appendedAssistant(
      fixture.sessionID,
      "msg_appended_auto",
      "Appended after automatic older page",
      1,
    ))
      screen.events.emit(event)
    await wait(() => screen.scrollbox()!.getRenderable("msg_appended_auto") !== undefined)
  } finally {
    await screen.dispose()
  }
}, 30000)

test("a short session keeps rows appended after revealing the first message mounted", async () => {
  const fixture = sessionHistoryFixture(150)
  fixture.release()
  let data!: ReturnType<typeof useData>
  const screen = await renderScreen({
    width: 120,
    height: 36,
    args: { sessionID: fixture.sessionID },
    settle: "Synthetic response 149",
    route: fixture.route,
    state: "/tmp/ycoding-tui-perf/state",
    config: { session: { sidebar: "hide" } },
    data: (value) => {
      data = value
    },
  })
  const wait = async (ready: () => boolean) => {
    const end = performance.now() + 5000
    while (!ready() && performance.now() < end) {
      await screen.renderOnce()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    if (!ready())
      throw new Error(
        `Viewport condition failed; loaded ${data.session.message.list(fixture.sessionID).length}:\n${screen.frame()}`,
      )
  }
  try {
    await wait(() => data.session.message.list(fixture.sessionID).length === 100)
    screen.input.pressKey("p", { ctrl: true })
    await wait(() => screen.frame().includes("Commands"))
    await wait(() => screen.renderer.currentFocusedEditor instanceof InputRenderable)
    await screen.input.typeText("First message")
    await screen.renderOnce()
    screen.input.pressKey("RETURN")
    await wait(() => data.session.message.list(fixture.sessionID).length === 150)
    await wait(() => screen.scrollbox()!.getRenderable("msg_000000") !== undefined)
    for (const event of appendedAssistant(
      fixture.sessionID,
      "msg_appended_reveal",
      "Appended after revealing first message",
      2,
    ))
      screen.events.emit(event)
    await wait(() => screen.scrollbox()!.getRenderable("msg_appended_reveal") !== undefined)
    screen.scrollbox()!.scrollTo(screen.scrollbox()!.scrollHeight)
    await wait(() => screen.frame().includes("Appended after revealing first message"))
    await wait(() => screen.scrollbox()!.getRenderable("msg_appended_reveal") !== undefined)
  } finally {
    await screen.dispose()
  }
}, 30000)

test("content that shrinks to fit the viewport at the bottom does not page older history and keeps following", async () => {
  const fixture = sessionHistoryFixture(150)
  fixture.release()
  let compacted = false
  let data!: ReturnType<typeof useData>
  const screen = await renderScreen({
    width: 120,
    height: 36,
    args: { sessionID: fixture.sessionID },
    settle: "Synthetic response 149",
    state: "/tmp/ycoding-tui-perf/state",
    config: { session: { sidebar: "hide" } },
    data: (value) => {
      data = value
    },
    route: async (url, request) => {
      if (
        compacted &&
        url.pathname === `/api/session/${fixture.sessionID}/snapshot` &&
        !url.searchParams.has("before")
      ) {
        const current = await fixture.route(new URL(`/api/session/${fixture.sessionID}`, url), request)
        return sessionSnapshot(
          fixture.sessionID,
          [{ id: "msg_short_kept", type: "user", text: "Short kept", time: { created: 1 } }],
          { before: "fixture_cursor_147", session: (await current!.json()).data },
        )
      }
      return fixture.route(url, request)
    },
  })
  const wait = async (ready: () => boolean) => {
    const end = performance.now() + 5000
    while (!ready() && performance.now() < end) {
      await screen.renderOnce()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    if (!ready())
      throw new Error(
        `Viewport condition failed; loaded ${data.session.message.list(fixture.sessionID).length}:\n${screen.frame()}`,
      )
  }
  try {
    await wait(
      () =>
        data.session.message.list(fixture.sessionID).length === 100 &&
        screen.scrollbox()!.scrollTop ===
          Math.max(0, screen.scrollbox()!.scrollHeight - screen.scrollbox()!.viewport.height),
    )
    const queriesBeforeCompaction = fixture.snapshotQueries.length
    compacted = true
    await data.session.message.invalidate(fixture.sessionID)
    await data.session.message.sync(fixture.sessionID)
    await wait(
      () =>
        data.session.message.list(fixture.sessionID).length === 1 && (screen.scrollbox()?.scrollTop ?? Infinity) <= 8,
    )
    for (let frame = 0; frame < 30; frame++) {
      await screen.renderOnce()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(fixture.snapshotQueries.slice(queriesBeforeCompaction)).toEqual([])
    expect(data.session.message.history(fixture.sessionID)?.status).toBe("ready")
    for (const event of appendedAssistant(
      fixture.sessionID,
      "msg_appended_compacted",
      "Appended after compaction fit",
      3,
    ))
      screen.events.emit(event)
    await wait(() => screen.frame().includes("Appended after compaction fit"))
    expect(fixture.snapshotQueries.slice(queriesBeforeCompaction)).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30000)
