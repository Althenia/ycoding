/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { YCodingEvent, SessionMessageInfo, SessionMessageUser } from "@ycoding-ai/client"
import { testRender } from "@opentui/solid"
import { onMount, type Accessor } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { Keymap, type KeymapCommand } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogTimeline } from "../../../src/routes/session/dialog-timeline"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { createApi, createEventStream, createFetch, directory, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const sessionID = "ses_timeline_pages"

test("actual timeline dialog traverses canonical pages beyond page one and releases the traversed page", async () => {
  const hot = descending(951, 1000)
  const first = descending(751, 950)
  const second = descending(551, 750)
  const target = second.at(-1)!
  const cursors: string[] = []
  const events = createEventStream()
  const calls = createFetch((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    const cursor = url.searchParams.get("cursor")
    if (!cursor) return response(hot, "cursor-1")
    cursors.push(cursor)
    if (cursor === "cursor-1") return response(first, "cursor-2")
    if (cursor === "cursor-2") return response(second)
  }, events)
  const moved: string[] = []
  let data!: ReturnType<typeof useData>
  let commands!: Accessor<readonly KeymapCommand[]>

  function Fixture() {
    data = useData()
    commands = Keymap.useCommands()
    const dialog = useDialog()
    onMount(() => {
      void data.session.message.sync(sessionID).then(() =>
        dialog.replace(() => <DialogTimeline sessionID={sessionID} onMove={(messageID) => moved.push(messageID)} />),
      )
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ClientProvider api={createApi(calls.fetch)}>
                <DataProvider>
                  <ToastProvider>
                    <DialogProvider>
                      <Fixture />
                    </DialogProvider>
                  </ToastProvider>
                </DataProvider>
              </ClientProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()

  try {
    await app.waitForFrame((frame) => frame.includes("timeline target 1000"))
    commands().findLast((command) => command.id === "dialog.select.end")!.run()
    await app.waitForFrame((frame) => frame.includes("Load older messages"))
    commands().findLast((command) => command.id === "dialog.select.submit")!.run()
    await app.waitFor(() => data.session.message.page(sessionID).some((message) => message.id === first.at(-1)!.id))
    commands().findLast((command) => command.id === "dialog.select.end")!.run()
    commands().findLast((command) => command.id === "dialog.select.submit")!.run()
    await app.waitFor(() => data.session.message.page(sessionID).some((message) => message.id === target.id))
    commands().findLast((command) => command.id === "dialog.select.end")!.run()
    await app.waitFor(() => moved.includes(target.id))

    expect(cursors).toEqual(["cursor-1", "cursor-2"])
    expect(data.session.message.page(sessionID)).toHaveLength(200)
    expect(data.session.message.page(sessionID).some((message) => message.id === first[0]?.id)).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("actual timeline history control renders stable loading, error, and retry states", async () => {
  const hot = descending(951, 1000)
  const first = descending(751, 950)
  const events = createEventStream()
  let attempt = 0
  let settle!: (response: Response) => void
  let data!: ReturnType<typeof useData>
  let commands!: Accessor<readonly KeymapCommand[]>
  const calls = createFetch((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    if (!url.searchParams.get("cursor")) return response(hot, "cursor-1")
    attempt++
    return new Promise<Response>((resolve) => {
      settle = resolve
    })
  }, events)

  function Fixture() {
    data = useData()
    commands = Keymap.useCommands()
    const dialog = useDialog()
    onMount(() => {
      void data.session.message.sync(sessionID).then(() =>
        dialog.replace(() => <DialogTimeline sessionID={sessionID} onMove={() => {}} />),
      )
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ClientProvider api={createApi(calls.fetch)}>
                <DataProvider>
                  <ToastProvider>
                    <DialogProvider>
                      <Fixture />
                    </DialogProvider>
                  </ToastProvider>
                </DataProvider>
              </ClientProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()

  try {
    await app.waitForFrame((frame) => frame.includes("timeline target 1000"))
    commands().findLast((command) => command.id === "dialog.select.end")!.run()
    await app.waitForFrame((frame) => frame.includes("Load older messages"))
    commands().findLast((command) => command.id === "dialog.select.submit")!.run()
    await app.waitForFrame((frame) => frame.includes("Loading older messages"))
    settle(json({ message: "expired" }, { status: 500 }))
    await app.waitForFrame((frame) => frame.includes("Retry older messages"))
    commands().findLast((command) => command.id === "dialog.select.submit")!.run()
    await app.waitFor(() => attempt === 2)
    settle(response(first))
    await app.waitFor(() => data.session.message.page(sessionID).length === 200)
  } finally {
    app.renderer.destroy()
  }
})

test("actual timeline retains the final page across an empty continuation and retries missing targets canonically", async () => {
  const hot = descending(951, 1000)
  const final = descending(749, 750)
  const fresh = descending(549, 550)
  const cursors: string[] = []
  let newest = 0
  const events = createEventStream()
  const calls = createFetch((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    const cursor = url.searchParams.get("cursor")
    if (!cursor) {
      newest++
      return response(hot, newest === 1 ? "cursor-final" : "cursor-fresh")
    }
    cursors.push(cursor)
    if (cursor === "cursor-final") return response(final, "cursor-empty")
    if (cursor === "cursor-empty") return response([])
    if (cursor === "cursor-fresh") return response(fresh)
  }, events)
  const moved: string[] = []
  let data!: ReturnType<typeof useData>
  let commands!: Accessor<readonly KeymapCommand[]>

  function Fixture() {
    data = useData()
    commands = Keymap.useCommands()
    const dialog = useDialog()
    onMount(() => {
      void data.session.message.sync(sessionID).then(() =>
        dialog.replace(() => <DialogTimeline sessionID={sessionID} onMove={(messageID) => moved.push(messageID)} />),
      )
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ClientProvider api={createApi(calls.fetch)}>
                <DataProvider>
                  <ToastProvider>
                    <DialogProvider>
                      <Fixture />
                    </DialogProvider>
                  </ToastProvider>
                </DataProvider>
              </ClientProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()

  try {
    await app.waitForFrame((frame) => frame.includes("timeline target 1000"))
    commands().findLast((command) => command.id === "dialog.select.end")!.run()
    await app.waitForFrame((frame) => frame.includes("Load older messages"))
    commands().findLast((command) => command.id === "dialog.select.submit")!.run()
    await app.waitFor(() => data.session.message.page(sessionID).some((message) => message.id === final.at(-1)!.id))
    commands().findLast((command) => command.id === "dialog.select.end")!.run()
    commands().findLast((command) => command.id === "dialog.select.submit")!.run()
    await app.waitFor(
      () =>
        cursors.at(-1) === "cursor-empty" &&
        data.session.message.history(sessionID).length === 1 &&
        data.session.message.history(sessionID)[0]?.state === "expanded",
    )
    await app.waitForFrame((frame) => !frame.includes("Load older messages"))
    moved.length = 0
    commands().findLast((command) => command.id === "dialog.select.end")!.run()
    await app.waitFor(() => moved.includes(final.at(-1)!.id))

    expect(data.session.message.page(sessionID).map((message) => message.id)).toEqual(final.toReversed().map((item) => item.id))
    expect(await data.session.message.expand(sessionID)).toBe(false)
    expect(newest).toBe(1)
    expect(cursors).toEqual(["cursor-final", "cursor-empty"])

    expect(await data.session.message.find(sessionID, "msg_missing")).toBe(false)
    expect(data.session.message.page(sessionID)).toEqual([])
    expect(data.session.message.history(sessionID)).toEqual([{ sessionID, state: "error" }])
    commands().findLast((command) => command.id === "dialog.select.end")!.run()
    await Bun.sleep(0)
    commands().findLast((command) => command.id === "dialog.select.end")!.run()
    commands().findLast((command) => command.id === "dialog.select.submit")!.run()
    await app.waitFor(() => data.session.message.page(sessionID).some((message) => message.id === fresh.at(-1)!.id))

    expect(newest).toBe(2)
    expect(cursors).toEqual(["cursor-final", "cursor-empty", "cursor-final", "cursor-empty", "cursor-fresh"])
    expect(data.session.message.page(sessionID).map((message) => message.id)).toEqual(fresh.toReversed().map((item) => item.id))
  } finally {
    app.renderer.destroy()
  }
})

test("selecting the pending history row after new messages arrive never opens a different message", async () => {
  const hot = descending(951, 1000)
  const first = descending(751, 950)
  const events = createEventStream()
  let settle!: (response: Response) => void
  let data!: ReturnType<typeof useData>
  let commands!: Accessor<readonly KeymapCommand[]>
  const calls = createFetch((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    if (!url.searchParams.get("cursor")) return response(hot, "cursor-1")
    return new Promise<Response>((resolve) => {
      settle = resolve
    })
  }, events)

  function Fixture() {
    data = useData()
    commands = Keymap.useCommands()
    const dialog = useDialog()
    onMount(() => {
      void data.session.message.sync(sessionID).then(() =>
        dialog.replace(() => <DialogTimeline sessionID={sessionID} onMove={() => {}} />),
      )
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ClientProvider api={createApi(calls.fetch)}>
                <DataProvider>
                  <ToastProvider>
                    <DialogProvider>
                      <Fixture />
                    </DialogProvider>
                  </ToastProvider>
                </DataProvider>
              </ClientProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()

  try {
    await app.waitForFrame((frame) => frame.includes("timeline target 1000"))
    commands().findLast((command) => command.id === "dialog.select.end")!.run()
    await app.waitForFrame((frame) => frame.includes("Load older messages"))
    commands().findLast((command) => command.id === "dialog.select.submit")!.run()
    await app.waitForFrame((frame) => frame.includes("Loading older messages"))

    // A new message arrives while the history load is still pending, growing
    // and reordering the option list the same way data.session.message.expand
    // does when it mutates the same reactive data DialogTimeline reads.
    events.emit({
      id: "evt_new_during_load",
      created: 2000,
      type: "session.input.admitted",
      location: { directory },
      durable: { aggregateID: sessionID, seq: 1, version: 1 },
      data: {
        sessionID,
        inputID: "msg_new_during_load",
        input: { type: "user", data: { text: "arrived mid-load" }, delivery: "steer" },
      },
    } as unknown as YCodingEvent)
    // The new message sorts to the top of the (reversed) list, so it is scrolled
    // out of view here; wait on the underlying data instead of the frame.
    await app.waitFor(() => data.session.message.get(sessionID, "msg_new_during_load") !== undefined)
    // Let the reflow settle (scrollToSelection reschedules across two animation
    // frames) before submitting again, the same way real keyboard input would.
    await app.waitForFrame((frame) => frame.includes("Loading older messages"))

    // The pending row's onSelect is a no-op while loading, so submitting again
    // must keep the Timeline dialog open rather than opening the new message.
    commands().findLast((command) => command.id === "dialog.select.submit")!.run()
    await app.waitForFrame((frame) => frame.includes("Loading older messages"))

    settle(response(first))
    await app.waitFor(() => data.session.message.page(sessionID).length === 200)
  } finally {
    app.renderer.destroy()
  }
})

function descending(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, index): SessionMessageUser => {
    const value = to - index
    return {
      id: `msg_${value.toString().padStart(6, "0")}`,
      type: "user",
      text: `timeline target ${value}`,
      time: { created: value },
    }
  })
}

function response(data: SessionMessageInfo[], next?: string) {
  return json({ data, cursor: { next } })
}
