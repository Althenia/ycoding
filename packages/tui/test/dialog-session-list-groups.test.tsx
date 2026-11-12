/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { InputRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { createEffect, onMount, type JSX } from "solid-js"
import type { YCodingEvent } from "@ycoding-ai/client"
import { DialogSessionList } from "../src/component/dialog-session-list"
import { ArgsProvider } from "../src/context/args"
import { ClientProvider } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { Keymap } from "../src/context/keymap"
import { LocalProvider, useLocal } from "../src/context/local"
import { LocationProvider, useLocation } from "../src/context/location"
import { RouteProvider, useRoute } from "../src/context/route"
import { ThemeProvider, useTheme } from "../src/context/theme"
import { SPINNER_FRAMES } from "../src/component/spinner-frames"
import { readableForeground } from "../src/theme/component"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { Toast, ToastProvider } from "../src/ui/toast"
import { ConfigProvider } from "../src/config"
import { createApi, createEventStream, createFetch, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const state = "/tmp/ycoding/dialog-session-list-groups"
const location = { directory: "/tmp/ycoding/packages/tui", project: { id: "proj_test", directory: "/tmp/ycoding" } }
const now = 1_800_000_000_000
let renderCount = 0
let liveDecisions: ReturnType<typeof decision>[] = []
let liveRunning: string[] = []
let liveOutstanding: string[] = []
let taskWaitState: "waiting" | "running" = "waiting"
let liveArchived = new Set<string>()
let liveUnpinned = new Set<string>()
let livePinnedAt = new Map<string, number>()
let liveTitles = new Map<string, string>()

test("groups global pinned, waiting and running sessions above current-project recent without duplicates", async () => {
  const { app } = await renderGroups()
  try {
    await app.waitForFrame((frame) => frame.includes("Waiting for action") && frame.includes("Pinned old remote"))
    const frame = app.captureCharFrame()
    const pinned = frame.indexOf("Pinned")
    const waiting = frame.indexOf("Waiting for action")
    const running = frame.indexOf("Running")
    const recent = frame.indexOf("Recent")
    expect(pinned).toBeGreaterThanOrEqual(0)
    expect(pinned).toBeLessThan(waiting)
    expect(waiting).toBeLessThan(running)
    expect(running).toBeLessThan(recent)

    for (const title of [
      "Pinned local",
      "Pinned remote",
      "Pinned old remote",
      "Pinned waiting remote",
      "Waiting remote",
      "Waiting parent remote",
      "Waiting running remote",
      "Task waiting remote",
      "Running remote",
      "Running local",
      "Recent local",
    ])
      expect(frame.split(title).length - 1, title).toBe(1)

    expect(frame.indexOf("Pinned waiting remote")).toBeLessThan(waiting)
    expect(frame.indexOf("Waiting running remote")).toBeLessThan(running)
    expect(frame.indexOf("Running local")).toBeLessThan(recent)
    expect(frame.indexOf("Recent local")).toBeGreaterThan(recent)
    expect(frame).not.toContain("Idle remote")
    expect(frame).toContain("otherproj")
  } finally {
    app.renderer.destroy()
  }
})

test("search filters the global groups by title while recent stays in the current project", async () => {
  const { app } = await renderGroups()
  try {
    await app.waitForFrame((frame) => frame.includes("Waiting for action"))
    await app.mockInput.typeText("remote")
    await app.waitForFrame(
      (frame) => frame.includes("Running remote") && !frame.includes("Recent local") && !frame.includes("Pinned local"),
    )
    const frame = app.captureCharFrame()
    expect(frame).toContain("Pinned remote")
    expect(frame).toContain("Waiting remote")
    expect(frame).not.toContain("Idle remote")
    expect(frame).not.toContain("Running local")
  } finally {
    app.renderer.destroy()
  }
})

test("activity events move a recent session into the running then waiting groups", async () => {
  const { app, events } = await renderGroups()
  try {
    await app.waitForFrame((frame) => frame.includes("Movable local"))
    const before = app.captureCharFrame()
    expect(before.indexOf("Movable local")).toBeGreaterThan(before.indexOf("Recent"))

    events.emit({
      id: "evt_movable_started",
      created: now,
      type: "session.execution.started",
      durable: { aggregateID: "ses_movable", seq: 2, version: 1 },
      data: { sessionID: "ses_movable" },
      location: { directory: location.directory },
    } satisfies YCodingEvent)
    await app.waitForFrame((frame) => {
      const running = frame.indexOf("Running")
      const recent = frame.indexOf("Recent")
      const movable = frame.indexOf("Movable local")
      return running >= 0 && movable > running && movable < recent
    })

    events.emit({
      id: "evt_movable_permission",
      created: now,
      type: "permission.asked",
      data: { id: "per_movable", sessionID: "ses_movable", action: "shell", resources: [location.directory] },
      location: { directory: location.directory },
    } satisfies YCodingEvent)
    await app.waitForFrame((frame) => {
      const waiting = frame.indexOf("Waiting for action")
      const running = frame.indexOf("Running")
      const movable = frame.indexOf("Movable local")
      return waiting >= 0 && movable > waiting && movable < running
    })
  } finally {
    app.renderer.destroy()
  }
})

test("selecting a cross-workspace pinned session opens it", async () => {
  const opened: string[] = []
  const { app } = await renderGroups({ onOpen: (sessionID) => opened.push(sessionID) })
  try {
    await app.waitForFrame((frame) => frame.includes("Pinned remote"))
    app.mockInput.pressEnter()
    await app.waitFor(() => opened.length === 1)
    expect(opened).toEqual(["ses_pin_remote"])
  } finally {
    app.renderer.destroy()
  }
})

test("pin toggle unpins a cross-workspace pinned session that is not resident", async () => {
  const requests: string[] = []
  const { app, keymap } = await renderGroups({
    sessionID: "ses_pin_remote",
    onRequest: (url, request) => {
      if (url.pathname.endsWith("/pin")) {
        requests.push(`${request.method} ${url.pathname}`)
        return new Response(null, { status: 204 })
      }
      return undefined
    },
  })
  try {
    await app.waitForFrame((frame) => frame.includes("Pinned remote"))
    keymap.dispatch("session.pin.toggle")
    await app.waitFor(() => requests.length === 1)
    expect(requests).toEqual(["DELETE /api/session/ses_pin_remote/pin"])
  } finally {
    app.renderer.destroy()
  }
})

test("a resolved cross-workspace decision clears the waiting row while the palette stays open", async () => {
  const { app, events } = await renderGroups()
  try {
    await app.waitForFrame((frame) => frame.includes("Waiting remote"))
    liveDecisions = liveDecisions.filter((item) => item.sessionID !== "ses_wait_remote")
    events.emit({
      id: "evt_wait_remote_replied",
      created: now,
      type: "permission.replied",
      data: { sessionID: "ses_wait_remote", requestID: "per_ses_wait_remote", reply: "once" },
      location: { directory: "/tmp/otherproj" },
    } satisfies YCodingEvent)
    await app.waitForFrame((frame) => frame.includes("Waiting parent remote") && !frame.includes("Waiting remote"))
  } finally {
    app.renderer.destroy()
  }
})

test("a settled cross-workspace run clears the running row while the palette stays open", async () => {
  const { app, events } = await renderGroups()
  try {
    await app.waitForFrame((frame) => frame.includes("Running remote"))
    liveRunning = liveRunning.filter((id) => id !== "ses_run_remote")
    liveOutstanding = liveOutstanding.filter((id) => id !== "ses_run_remote")
    events.emit({
      id: "evt_run_remote_done",
      created: now,
      type: "session.execution.succeeded",
      durable: { aggregateID: "ses_run_remote", seq: 3, version: 1 },
      data: { sessionID: "ses_run_remote" },
      location: { directory: "/tmp/otherproj" },
    } satisfies YCodingEvent)
    await app.waitForFrame((frame) => frame.includes("Running local") && !frame.includes("Running remote"))
  } finally {
    app.renderer.destroy()
  }
})

test("a nonresident root with a waiting subagent task waits, then moves to running when the task resumes", async () => {
  const { app, events } = await renderGroups()
  try {
    await app.waitForFrame((frame) => {
      const waiting = frame.indexOf("Waiting for action")
      const running = frame.indexOf("Running")
      const row = frame.indexOf("Task waiting remote")
      return waiting >= 0 && row > waiting && row < running
    })
    const waitingRow = app
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("Waiting running remote"))
    expect(waitingRow).toContain("?")

    taskWaitState = "running"
    liveRunning = [...liveRunning, "ses_task_wait"]
    events.emit({
      id: "evt_task_wait_started",
      created: now,
      type: "session.execution.started",
      durable: { aggregateID: "ses_task_wait", seq: 2, version: 1 },
      data: { sessionID: "ses_task_wait" },
      location: { directory: "/tmp/otherproj" },
    } satisfies YCodingEvent)
    await app.waitForFrame((frame) => {
      const running = frame.indexOf("Running")
      const recent = frame.indexOf("Recent")
      const row = frame.indexOf("Task waiting remote")
      return running >= 0 && row > running && row < recent
    })
  } finally {
    app.renderer.destroy()
  }
})

test("unpinning an idle cross-workspace session removes it instead of leaking into recent", async () => {
  const requests: string[] = []
  const { app, events, keymap } = await renderGroups({
    sessionID: "ses_pin_remote",
    onRequest: (url, request) => {
      if (url.pathname.endsWith("/pin")) {
        requests.push(`${request.method} ${url.pathname}`)
        return new Response(null, { status: 204 })
      }
      return undefined
    },
  })
  try {
    await app.waitForFrame((frame) => frame.includes("Pinned remote"))
    keymap.dispatch("session.pin.toggle")
    await app.waitFor(() => requests.length === 1)
    events.emit({
      id: "evt_unpin_remote",
      created: now,
      type: "session.unpinned",
      durable: { aggregateID: "ses_pin_remote", seq: 4, version: 1 },
      data: { sessionID: "ses_pin_remote" },
      location: { directory: "/tmp/otherproj" },
    })
    await app.waitForFrame((frame) => frame.includes("Recent local") && !frame.includes("Pinned remote"))
  } finally {
    app.renderer.destroy()
  }
})

test("archiving a cross-workspace pinned session keeps one archived pinned row", async () => {
  const requests: string[] = []
  const { app, events, keymap } = await renderGroups({
    sessionID: "ses_pin_remote",
    onRequest: (url, request) => {
      if (url.pathname === "/api/session/ses_pin_remote/archive" && request.method === "POST") {
        requests.push(`${request.method} ${url.pathname}`)
        return new Response(null, { status: 204 })
      }
      return undefined
    },
  })
  try {
    await app.waitForFrame((frame) => frame.includes("Pinned remote"))
    keymap.dispatch("session.archive")
    await app.waitForFrame((frame) => frame.includes("Archive session"))
    app.mockInput.pressEnter()
    await app.waitFor(() => requests.length === 1)
    events.emit({
      id: "evt_archive_remote",
      created: now,
      type: "session.archived",
      durable: { aggregateID: "ses_pin_remote", seq: 5, version: 2 },
      data: { sessionID: "ses_pin_remote" },
      location: { directory: "/tmp/otherproj" },
    })
    await app.waitForFrame((frame) => frame.includes("Archived"))
    const frame = app.captureCharFrame()
    expect(frame.split("Pinned remote").length - 1).toBe(1)
    expect(frame.indexOf("Pinned remote")).toBeLessThan(frame.indexOf("Waiting for action"))
  } finally {
    app.renderer.destroy()
  }
})

test("a live rename updates a cross-workspace pinned row title", async () => {
  const { app, events } = await renderGroups()
  try {
    await app.waitForFrame((frame) => frame.includes("Pinned old remote"))
    liveTitles.set("ses_pin_old", "Renamed old remote")
    events.emit({
      id: "evt_rename_old",
      created: now,
      type: "session.renamed",
      durable: { aggregateID: "ses_pin_old", seq: 6, version: 1 },
      data: { sessionID: "ses_pin_old", title: "Renamed old remote" },
      location: { directory: "/tmp/otherproj" },
    })
    await app.waitForFrame((frame) => frame.includes("Renamed old remote") && !frame.includes("Pinned old remote"))
  } finally {
    app.renderer.destroy()
  }
})

test("quick-switch slots follow global pin order and open their sessions", async () => {
  const opened: string[] = []
  const { app, slots, quickSwitch } = await renderGroups({ onOpen: (sessionID) => opened.push(sessionID) })
  try {
    await app.waitForFrame((frame) => frame.includes("Pinned old remote"))
    expect(slots()).toEqual(["ses_pin_remote", "ses_both", "ses_pin_local", "ses_pin_old"])
    const firstRow = app
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("Pinned remote"))
    expect(firstRow?.trimStart().startsWith("1")).toBe(true)
    quickSwitch(2)
    await app.waitFor(() => opened.length === 1)
    expect(opened).toEqual(["ses_both"])
  } finally {
    app.renderer.destroy()
  }
})

test("waiting row glyph keeps warning ink unselected and readable ink on the selected and delete-armed bands", async () => {
  const { app, keymap, theme } = await renderGroups()
  try {
    await app.waitForFrame((frame) => frame.includes("Waiting remote") && frame.includes("Pinned old remote"))
    const elevated = theme().contextual("elevated").theme
    const glyph = () =>
      app
        .captureSpans()
        .lines.find((line) => line.spans.some((span) => span.text.includes("Waiting remote")))
        ?.spans.find((span) => span.text.includes("?"))

    expect(glyph()?.fg.toInts()).toEqual(elevated.text.feedback.warning.default.toInts())
    expect(glyph()?.fg.toInts()).not.toEqual(elevated.text.action.primary.focused.toInts())

    Array.from({ length: 4 }).forEach(() => app.mockInput.pressArrow("down"))
    await app.waitFor(() => glyph()?.fg.toInts().join() === elevated.text.action.primary.focused.toInts().join())
    expect(glyph()?.fg.toInts()).not.toEqual(elevated.text.feedback.warning.default.toInts())

    keymap.dispatch("session.delete")
    await app.waitForFrame((frame) => frame.includes("again to confirm"))
    const armed = app
      .captureSpans()
      .lines.find((line) => line.spans.some((span) => span.text.includes("again to confirm")))
      ?.spans.find((span) => span.text.includes("?"))
    const plain = theme().theme
    expect(armed?.fg.toInts()).toEqual(
      readableForeground(plain.text.action.destructive.default, plain.background.action.destructive.default).toInts(),
    )
  } finally {
    app.renderer.destroy()
  }
})

test("an outstanding payload without running still groups waiting roots without errors", async () => {
  const errors: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => errors.push(args)
  const { app } = await renderGroups({
    onRequest: (url) =>
      url.pathname === "/api/session/outstanding" ? json({ data: ["ses_task_wait"] }) : undefined,
  })
  try {
    await app.waitForFrame((frame) => {
      const waiting = frame.indexOf("Waiting for action")
      const row = frame.indexOf("Task waiting remote")
      return waiting >= 0 && row > waiting && frame.includes("Recent")
    })
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("Running remote")
    expect(errors.map((args) => args.map(String).join(" ")).filter((text) => text.includes("TypeError"))).toEqual([])
  } finally {
    app.renderer.destroy()
    console.error = original
  }
})

test("a running root known only from outstanding work spins in its gutter", async () => {
  const { app } = await renderGroups()
  try {
    await app.waitForFrame((frame) => frame.includes("Running remote"))
    await app.waitFor(() =>
      SPINNER_FRAMES.some((spinner) =>
        app
          .captureCharFrame()
          .split("\n")
          .find((line) => line.includes("Running remote"))
          ?.includes(spinner),
      ),
    )
  } finally {
    app.renderer.destroy()
  }
})

test("switching workspace rescopes recent and directory hints to the active project", async () => {
  const { app, setLocation } = await renderGroups()
  try {
    await app.waitForFrame((frame) => frame.includes("Recent local") && frame.includes("otherproj"))
    setLocation({ directory: "/tmp/otherproj" })
    await app.waitForFrame(
      (frame) => frame.includes("Idle remote") && !frame.includes("Recent local") && !frame.includes("otherproj"),
    )
    const frame = app.captureCharFrame()
    expect(frame.indexOf("Idle remote")).toBeGreaterThan(frame.indexOf("Recent"))
  } finally {
    app.renderer.destroy()
  }
})

test("many newer and older foreign idle roots neither evict nor leak into the current project's groups", async () => {
  const foreign = Array.from({ length: 70 }, (_, index) =>
    row(`ses_foreign_${index}`, `Foreign idle ${index}`, index < 10 ? 100 + index : 20_000 + index, remote),
  )
  let decisionReads = 0
  const { app, events } = await renderGroups({
    onRequest: (url) => {
      if (url.pathname === "/api/decision") decisionReads++
      if (url.pathname !== "/api/session" || url.searchParams.get("project") || url.searchParams.get("search") !== null)
        return undefined
      const all = [...foreign, ...sessions.map(withLive)].toSorted((a, b) => b.time.updated - a.time.updated)
      if (url.searchParams.get("cursor") === "foreign2") return json({ data: all.slice(40), cursor: {} })
      return json({ data: all.slice(0, 40), cursor: { next: "foreign2" } })
    },
  })
  const settled = (frame: string) => {
    const waiting = frame.indexOf("Waiting for action")
    const running = frame.indexOf("Running")
    const recent = frame.indexOf("Recent")
    const waitingRow = frame.indexOf("Waiting remote")
    return (
      waiting >= 0 &&
      waitingRow > waiting &&
      waitingRow < running &&
      frame.indexOf("Recent local") > recent &&
      frame.indexOf("Movable local") > recent &&
      recent > running &&
      !frame.includes("Foreign idle")
    )
  }
  try {
    await app.waitForFrame(settled)
    const reads = decisionReads
    events.emit({
      id: "evt_rename_unrelated",
      created: now,
      type: "session.renamed",
      durable: { aggregateID: "ses_foreign_3", seq: 7, version: 1 },
      data: { sessionID: "ses_foreign_3", title: "Foreign idle 3" },
      location: { directory: "/tmp/otherproj" },
    })
    await app.waitFor(() => decisionReads > reads)
    await app.waitForFrame(settled)
  } finally {
    app.renderer.destroy()
  }
})

test("a failed decision or outstanding refresh keeps the last waiting or running groups", async () => {
  let failDecision = false
  let failOutstanding = false
  const { app, events } = await renderGroups({
    onRequest: (url) => {
      if (url.pathname === "/api/decision" && failDecision) return new Response("boom", { status: 500 })
      if (url.pathname === "/api/session/outstanding" && failOutstanding) return new Response("boom", { status: 500 })
      return undefined
    },
  })
  const refresh = (id: string) =>
    events.emit({
      id,
      created: now,
      type: "session.renamed",
      durable: { aggregateID: "ses_movable", seq: 8, version: 1 },
      data: { sessionID: "ses_movable", title: "Movable local" },
      location: { directory: location.directory },
    })
  const between = (frame: string, title: string, start: string, end: string) => {
    const row = frame.indexOf(title)
    return frame.indexOf(start) >= 0 && row > frame.indexOf(start) && row < frame.indexOf(end)
  }
  try {
    await app.waitForFrame((frame) => frame.includes("Waiting remote") && frame.includes("Running remote"))

    failDecision = true
    liveRunning = [...liveRunning, "ses_idle_remote"]
    liveOutstanding = [...liveOutstanding, "ses_idle_remote"]
    refresh("evt_refresh_decision_failed")
    await app.waitForFrame(
      (frame) =>
        between(frame, "Idle remote", "Running", "Recent") &&
        between(frame, "Waiting remote", "Waiting for action", "Running"),
    )

    failDecision = false
    failOutstanding = true
    liveDecisions = liveDecisions.filter((item) => item.sessionID !== "ses_wait_remote")
    refresh("evt_refresh_outstanding_failed")
    await app.waitForFrame(
      (frame) =>
        !frame.includes("Waiting remote") &&
        between(frame, "Running remote", "Running", "Recent") &&
        between(frame, "Idle remote", "Running", "Recent"),
    )
  } finally {
    app.renderer.destroy()
  }
})

test("an unresolved project shows global groups without leaking foreign roots into recent", async () => {
  const gate = Promise.withResolvers<void>()
  const { app } = await renderGroups({
    onRequest: (url) => (url.pathname === "/api/location" ? gate.promise.then(() => json(location)) : undefined),
  })
  try {
    await app.waitForFrame((frame) => frame.includes("Pinned remote") && frame.includes("Waiting remote"))
    const before = app.captureCharFrame()
    expect(before.indexOf("Pinned remote")).toBeGreaterThan(before.indexOf("Pinned"))
    expect(before.includes("Idle remote")).toBe(false)
    expect(before.includes("Recent")).toBe(false)

    gate.resolve()
    await app.waitForFrame(
      (frame) => frame.includes("Recent") && frame.indexOf("Recent local") > frame.indexOf("Recent"),
    )
    expect(app.captureCharFrame()).not.toContain("Idle remote")
  } finally {
    app.renderer.destroy()
  }
})

async function renderGroups(
  options: {
    sessionID?: string
    onOpen?: (sessionID: string) => void
    onRequest?: (url: URL, request: Request) => Response | undefined | Promise<Response>
  } = {},
) {
  const sessionState = `${state}/${renderCount++}`
  await mkdir(sessionState, { recursive: true })
  liveDecisions = [...decisions]
  liveRunning = ["ses_run_remote", "ses_wait_run", "ses_run_local"]
  liveOutstanding = [...liveRunning, "ses_task_wait"]
  taskWaitState = "waiting"
  liveArchived = new Set()
  liveUnpinned = new Set()
  livePinnedAt = new Map()
  liveTitles = new Map()
  const events = createEventStream()
  let keymap!: ReturnType<typeof Keymap.use>
  let themeRead!: ReturnType<typeof useTheme>
  let slotsRead: () => readonly string[] = () => []
  let quickSwitchRun: (slot: number) => void = () => {}
  let setLocationRun: (next: { directory: string }) => void = () => {}
  const transport = createFetch((url, request) => {
    const pin = /^\/api\/session\/(ses_[a-z_]+)\/pin$/.exec(url.pathname)?.[1]
    if (pin && request.method === "POST") {
      liveUnpinned.delete(pin)
      livePinnedAt.set(pin, now)
    }
    if (pin && request.method === "DELETE") liveUnpinned.add(pin)
    const archive = /^\/api\/session\/(ses_[a-z_]+)\/archive$/.exec(url.pathname)?.[1]
    if (archive && request.method === "POST") liveArchived.add(archive)
    if (archive && request.method === "DELETE") liveArchived.delete(archive)
    const handled = options.onRequest?.(url, request)
    if (handled) return handled
    if (pin || archive) return new Response(null, { status: 204 })
    if (url.pathname === "/api/location") {
      if (url.searchParams.get("location[directory]") === "/tmp/otherproj")
        return json({ directory: "/tmp/otherproj", project: { id: "proj_other", directory: "/tmp/otherproj" } })
      return json(location)
    }
    if (url.pathname === "/api/session") {
      const live = sessions.map(withLive)
      const search = url.searchParams.get("search")?.toLowerCase()
      if (search !== null && search !== undefined)
        return json({
          data: live.filter(
            (session) =>
              session.projectID === url.searchParams.get("project") && session.title.toLowerCase().includes(search),
          ),
          cursor: {},
        })
      if (url.searchParams.get("project"))
        return json({
          data: live.filter((session) => session.projectID === url.searchParams.get("project")),
          cursor: {},
        })
      if (url.searchParams.get("cursor") === "page2")
        return json({ data: live.filter((session) => session.id === "ses_pin_old"), cursor: {} })
      return json({ data: live.filter((session) => session.id !== "ses_pin_old"), cursor: { next: "page2" } })
    }
    if (url.pathname === "/api/session/active") return json({ data: {} })
    if (url.pathname === "/api/session/outstanding")
      return json({ data: liveOutstanding, running: liveRunning, failed: [], lost: [] })
    if (url.pathname === "/api/decision") return json({ data: liveDecisions })
    if (url.pathname === "/api/session/ses_task_wait/subagent")
      return json({
        data: [{ sessionID: "ses_task_child", parentID: "ses_task_wait", state: taskWaitState }],
        summary: { total: 1, active: 1, running: taskWaitState === "running" ? 1 : 0, waiting: taskWaitState === "waiting" ? 1 : 0 },
        cursor: {},
      })
    if (url.pathname === "/api/session/ses_child") return json({ data: child })
    const detail = /^\/api\/session\/(ses_[a-z_]+)$/.exec(url.pathname)
    const found = detail ? sessions.find((session) => session.id === detail[1]) : undefined
    if (found) return json({ data: withLive(found) })
    return undefined
  }, events)
  const app = await testRender(
    () => (
      <Providers api={createApi(transport.fetch)} state={sessionState} sessionID={options.sessionID}>
        <Fixture
          onKeymap={(value) => (keymap = value)}
          onTheme={(value) => (themeRead = value)}
          onOpen={options.onOpen}
          onLocal={(read, run) => {
            slotsRead = read
            quickSwitchRun = run
          }}
          onLocation={(run) => (setLocationRun = run)}
        />
      </Providers>
    ),
    { width: 140, height: 80, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
  return {
    app,
    events,
    keymap,
    theme: () => themeRead,
    slots: () => slotsRead(),
    quickSwitch: (slot: number) => quickSwitchRun(slot),
    setLocation: (next: { directory: string }) => setLocationRun(next),
  }
}

function withLive(session: (typeof sessions)[number]) {
  return {
    ...session,
    title: liveTitles.get(session.id) ?? session.title,
    time: {
      ...session.time,
      ...(liveArchived.has(session.id) ? { archived: now - 1_000 } : {}),
      pinned: liveUnpinned.has(session.id) ? undefined : (livePinnedAt.get(session.id) ?? session.time.pinned),
    },
  }
}

function Fixture(props: {
  onKeymap: (keymap: ReturnType<typeof Keymap.use>) => void
  onTheme: (theme: ReturnType<typeof useTheme>) => void
  onOpen?: (sessionID: string) => void
  onLocal: (slots: () => readonly string[], quickSwitch: (slot: number) => void) => void
  onLocation: (set: (next: { directory: string }) => void) => void
}) {
  const dialog = useDialog()
  const keymap = Keymap.use()
  const theme = useTheme()
  const route = useRoute()
  const local = useLocal()
  const location = useLocation()
  createEffect(() => {
    if (route.data.type === "session") props.onOpen?.(route.data.sessionID)
  })
  onMount(() => {
    props.onKeymap(keymap)
    props.onTheme(theme)
    props.onLocal(
      () => local.session.slots(),
      (slot) => local.session.quickSwitch(slot),
    )
    props.onLocation((next) => location.set(next))
    dialog.replace(() => <DialogSessionList now={now} />)
  })
  return <SyncLocation />
}

function SyncLocation() {
  const data = useData()
  const route = useLocation()
  createEffect(() => route.set(data.location.default()))
  return null
}

function Providers(props: {
  api: ReturnType<typeof createApi>
  children: JSX.Element
  state: string
  sessionID?: string
}) {
  return (
    <TestTuiContexts paths={{ state: props.state }}>
      <ArgsProvider>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ToastProvider>
              <RouteProvider
                initialRoute={props.sessionID ? { type: "session", sessionID: props.sessionID } : { type: "home" }}
              >
                <ClientProvider api={props.api}>
                  <DataProvider>
                    <LocationProvider>
                      <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                        <LocalProvider>
                          <DialogProvider>{props.children}</DialogProvider>
                          <Toast />
                        </LocalProvider>
                      </ThemeProvider>
                    </LocationProvider>
                  </DataProvider>
                </ClientProvider>
              </RouteProvider>
            </ToastProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </ArgsProvider>
    </TestTuiContexts>
  )
}

const base = {
  projectID: "proj_test",
  location: { directory: location.directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
}
const remote = { projectID: "proj_other", location: { directory: "/tmp/otherproj" } }
const row = (
  id: string,
  title: string,
  age: number,
  extra: Record<string, unknown> = {},
  time: { pinned?: number; archived?: number } = {},
) => ({ ...base, ...extra, id, title, time: { created: now - age - 60_000, updated: now - age, ...time } })

const sessions = [
  row("ses_recent", "Recent local", 1_000),
  row("ses_movable", "Movable local", 2_000),
  row("ses_run_local", "Running local", 3_000),
  row("ses_pin_local", "Pinned local", 4_000, {}, { pinned: now - 10_000 }),
  row("ses_pin_remote", "Pinned remote", 5_000, remote, { pinned: now - 20_000 }),
  row("ses_both", "Pinned waiting remote", 6_000, remote, { pinned: now - 15_000 }),
  row("ses_wait_remote", "Waiting remote", 7_000, remote),
  row("ses_wait_parent", "Waiting parent remote", 8_000, remote),
  row("ses_wait_run", "Waiting running remote", 9_000, remote),
  row("ses_task_wait", "Task waiting remote", 9_500, remote),
  row("ses_run_remote", "Running remote", 10_000, remote),
  row("ses_idle_remote", "Idle remote", 11_000, remote),
  row("ses_pin_old", "Pinned old remote", 12_000, remote, { pinned: now - 5_000 }),
]

const child = row("ses_child", "Waiting child", 7_500, { ...remote, parentID: "ses_wait_parent" })

const decision = (sessionID: string) => ({
  kind: "permission",
  sessionID,
  sessionTitle: sessionID,
  directory: "/tmp/otherproj",
  id: `per_${sessionID}`,
  summary: "shell: ls",
  decide: [],
})
const decisions = [decision("ses_wait_remote"), decision("ses_child"), decision("ses_both"), decision("ses_wait_run")]
