import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { InputRenderable, ScrollBoxRenderable, TextareaRenderable, type Renderable } from "@opentui/core"
import { Effect, FileSystem } from "effect"
import { createComponent, onCleanup } from "solid-js"
import { make } from "@ycoding-ai/client/v5"
import { Service } from "@ycoding-ai/client/service"
import { fixture } from "../../../rust/crates/runtime/tests/support/launcher-client"
import { FrontendPaths } from "../src/frontend-paths"
import { useClient } from "../src/context/client"
import { saveCustomEndpoint } from "../src/custom-endpoint-save"

test("an empty Rust Session resumes with an editable draft and no admitted input", async () => {
  const binary = process.env.YCODING_TEST_RUST_RUNTIME
  if (!binary) throw new Error("YCODING_TEST_RUST_RUNTIME must name the built Rust runtime")
  const runtime = await fixture(binary)
  const endpoint = await Service.ensure({ file: runtime.file, command: runtime.command("view-resume") })
  const client = make({ endpoint, location: { directory: runtime.configDir } })
  const screen = await createTestRenderer({ width: 120, height: 36, useThread: false, kittyKeyboard: true })
  let task: Promise<void> | undefined
  try {
    const session = await client.session.create({ location: { directory: runtime.configDir } })
    await client.server.telemetry.consent.set({ enabled: false, noticeVersion: 1 })
    expect((await client.session.snapshot({ sessionID: session.id })).messages).toEqual([])
    const { run } = await import("../src/app")
    task = Effect.runPromise(
      run({
        server: { endpoint },
        args: { sessionID: session.id },
        config: { get: async () => ({ animations: false, session: { sidebar: "hide" } }), update: async () => ({}) },
        packages: { resolve: async () => undefined },
        terminalHandoff: async () => ({ renderer: screen.renderer, mode: "dark", complete: () => {} }),
        log: () => {},
      }).pipe(
        Effect.provide(FrontendPaths.layerWith({ state: runtime.configDir + "/tui-state" })),
        Effect.provide(FileSystem.layerNoop({})),
      ),
    )
    const deadline = Date.now() + 10_000
    while (
      Date.now() < deadline &&
      !(
        screen.renderer.currentFocusedEditor instanceof TextareaRenderable &&
        screen.captureCharFrame().includes("ready")
      )
    ) {
      await screen.renderOnce()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(screen.renderer.currentFocusedEditor).toBeInstanceOf(TextareaRenderable)
    expect(screen.captureCharFrame()).toContain("ready")
    await screen.mockInput.typeText("retained empty-session draft")
    await screen.renderOnce()
    expect(screen.captureCharFrame()).toContain("retained empty-session draft")
    expect(await client.session.pending.list({ sessionID: session.id })).toEqual([])
    expect((await client.session.snapshot({ sessionID: session.id })).messages).toEqual([])
  } finally {
    screen.renderer.destroy()
    await task
    client.transport.close()
    await runtime.dispose()
  }
}, 30_000)

test("Rust history renders opaque pages, preserves Timeline identity, and copies canonical history across restart", async () => {
  const binary = process.env.YCODING_TEST_RUST_RUNTIME
  if (!binary) throw new Error("YCODING_TEST_RUST_RUNTIME must name the built Rust runtime")
  const runtime = await fixture(binary)
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname.endsWith("/models"))
        return Response.json({ object: "list", data: [{ id: "view-model" }] })
      return new Response(
        'data: {"id":"view-reply","choices":[{"index":0,"delta":{"content":"Run the focused tests"},"finish_reason":null}]}\n\ndata: {"id":"view-reply","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const endpoint = await Service.ensure({ file: runtime.file, command: runtime.command("view-history") })
  const client = make({ endpoint, location: { directory: runtime.configDir } })
  const screen = await createTestRenderer({ width: 120, height: 36, useThread: false, kittyKeyboard: true })
  screen.renderer.start()
  const clipboard = await import("../src/context/clipboard")
  const originalClipboard = { ...clipboard }
  const copied: string[] = []
  await mock.module("../src/context/clipboard", () => ({
    ...originalClipboard,
    ClipboardProvider: (props: Parameters<typeof clipboard.ClipboardProvider>[0]) => props.children,
    useClipboard: () => ({
      write: async (text: string) => {
        copied.push(text)
      },
    }),
  }))
  const dataModule = await import("../src/context/data")
  const originalData = { ...dataModule }
  const snapshots: { before?: string; next?: string; count: number }[] = []
  let data!: ReturnType<typeof dataModule.useData>
  function Probe() {
    data = originalData.useData()
    const connection = useClient()
    const clients = new WeakSet<ReturnType<typeof make>>()
    const observe = () => {
      const api = connection.api
      if (clients.has(api)) return
      clients.add(api)
      const snapshot = api.session.snapshot
      api.session.snapshot = async (input, options) => {
        const observed: (typeof snapshots)[number] = { before: input.before, count: 0 }
        snapshots.push(observed)
        const result = await snapshot(input, options)
        observed.next = result.before ?? undefined
        observed.count = result.messages.length
        return result
      }
    }
    observe()
    onCleanup(connection.event.on("server.connected", observe))
    return null
  }
  await mock.module("../src/context/data", () => ({
    ...originalData,
    DataProvider: (props: Parameters<typeof dataModule.DataProvider>[0]) => {
      let content: Array<typeof props.children> | undefined
      return createComponent(originalData.DataProvider, {
        get recordTelemetry() {
          return props.recordTelemetry
        },
        get selectedSessionID() {
          return props.selectedSessionID
        },
        get children() {
          return (content ??= [createComponent(Probe, {}), props.children])
        },
      })
    },
  }))
  const { run } = await import("../src/app")
  let restarted: ReturnType<typeof make> | undefined
  let connections = 0
  let task: Promise<void> | undefined
  try {
    await saveCustomEndpoint(
      {
        provider: "view-provider",
        baseURL: provider.url.href + "v1",
        api: "chat",
        apiKey: "synthetic-view-key",
        profile: "view-profile",
        catalog: "openai-models",
        models: [{ id: "view-model" }],
      },
      {
        configure: (input) => client.provider.configure(input),
        connectKey: (input) => client.integration.connect.key(input),
        activate: (credentialID) => client.credential.activate({ credentialID }),
        refresh: () => client.model.list(),
      },
      { directory: runtime.configDir },
    )
    await client.server.telemetry.consent.set({ enabled: false, noticeVersion: 1 })
    const session = await client.session.create({
      location: { directory: runtime.configDir },
      model: { providerID: "view-provider", id: "view-model" },
    })
    for (const batch of [0, 25, 50, 75, 100]) {
      const producer = make({ endpoint, location: { directory: runtime.configDir } })
      try {
        for (let index = batch; index < Math.min(105, batch + 25); index++) {
          await producer.session.prompt({
            sessionID: session.id,
            id: `msg_view_${index}`,
            text: `History prompt ${index}`,
          })
          await producer.session.wait({ sessionID: session.id })
        }
      } finally {
        producer.transport.close()
      }
    }
    const newest = await client.session.snapshot({ sessionID: session.id, limit: 100 })
    expect(newest.messages).toHaveLength(100)
    expect(newest.before).toBeTruthy()
    expect(newest.messages.filter((message) => message.type === "user").map((message) => message.text)).toEqual(
      Array.from({ length: 50 }, (_, index) => `History prompt ${55 + index}`),
    )
    expect(newest.messages.filter((message) => message.type === "assistant").at(-1)?.content).toEqual([
      { type: "text", text: "Run the focused tests" },
    ])
    const older = await client.session.snapshot({
      sessionID: session.id,
      limit: 100,
      before: newest.before ?? undefined,
    })
    expect(older.messages).toHaveLength(100)
    expect(older.messages[0].id).toBe("msg_view_5")
    expect(older.before).toBeTruthy()
    expect(older.before).not.toBe(newest.before)
    task = Effect.runPromise(
      run({
        server: {
          endpoint,
          service: {
            async reconnect() {
              connections++
              const endpoint = await Service.ensure({ file: runtime.file, command: runtime.command("view-history") })
              return endpoint
            },
            restart: () => Service.stop({ file: runtime.file }),
          },
        },
        args: { sessionID: session.id },
        config: { get: async () => ({ animations: false, session: { sidebar: "hide" } }), update: async () => ({}) },
        packages: { resolve: async () => undefined },
        terminalHandoff: async () => ({ renderer: screen.renderer, mode: "dark", complete: () => {} }),
        log: () => {},
      }).pipe(
        Effect.provide(FrontendPaths.layerWith({ state: runtime.configDir + "/tui-state" })),
        Effect.provide(FileSystem.layerNoop({})),
      ),
    )
    const wait = async (ready: () => boolean) => {
      const deadline = Date.now() + 10_000
      while (!ready() && Date.now() < deadline && !screen.renderer.isDestroyed) {
        await screen.renderOnce()
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      if (!ready()) {
        throw new Error(
          `Rust history frame did not settle for ${ready.toString()}:\n${JSON.stringify(snapshots)}\n${JSON.stringify(data.session.message.history(session.id))}\n${data.session.message.list(session.id).length} messages\n${screen.captureCharFrame()}`,
        )
      }
    }
    const command = async (text: string) => {
      await wait(() => screen.renderer.currentFocusedEditor instanceof TextareaRenderable)
      await screen.mockInput.typeText(text)
      screen.mockInput.pressEnter()
    }
    const timeline = async () => {
      await command("/timeline")
      await wait(
        () =>
          screen.captureCharFrame().includes("Session timeline") &&
          screen.renderer.currentFocusedEditor instanceof InputRenderable,
      )
    }
    const nodes = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(nodes)]
    const resident = (id: string) => nodes(screen.renderer.root).some((node) => node.id === id)
    await wait(
      () =>
        screen.captureCharFrame().includes("History prompt 104") &&
        screen.captureCharFrame().includes("Run the focused tests"),
    )
    expect(screen.captureCharFrame()).toContain("Run the focused tests")
    expect(screen.captureCharFrame()).not.toContain("History prompt 0")
    expect(resident("msg_view_55")).toBe(true)
    expect(resident("msg_view_54")).toBe(false)
    await command("/copy")
    await wait(() => copied.length === 1)
    expect(copied[0]).toContain("History prompt 0")
    expect(copied[0]).toContain("History prompt 104")
    expect(resident("msg_view_54")).toBe(false)
    expect(data.session.message.list(session.id)).toHaveLength(100)
    await command("/export")
    await wait(() => screen.captureCharFrame().includes("Export"))
    screen.mockInput.pressKey("TAB")
    screen.mockInput.pressEnter()
    screen.mockInput.pressKey("TAB")
    screen.mockInput.pressKey("TAB")
    screen.mockInput.pressEnter()
    await wait(() => copied.length === 2)
    const canonical = await client.message.list({ sessionID: session.id })
    expect(JSON.parse(copied[1]).messages.map((message: { id: string }) => message.id)).toEqual(
      canonical.map((message) => message.id),
    )
    expect(resident("msg_view_54")).toBe(false)
    expect(data.session.message.list(session.id)).toHaveLength(100)
    await wait(() => screen.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const scroll = nodes(screen.renderer.root).find((node) => node instanceof ScrollBoxRenderable)
    expect(scroll).toBeDefined()
    scroll?.scrollTo(0)
    await wait(() => data.session.message.list(session.id).length === 200 && !!scroll && scroll.scrollTop > 0)
    expect(data.session.message.list(session.id)[0].id).toBe("msg_view_5")
    expect(snapshots.some((snapshot) => snapshot.before !== undefined)).toBe(true)
    scroll?.scrollTo(0)
    await wait(() => data.session.message.history(session.id)?.before === undefined)
    expect(data.session.message.list(session.id).map((message) => message.id)).toEqual(
      canonical.map((message) => message.id),
    )
    expect(data.session.message.history(session.id)?.before).toBeUndefined()
    screen.mockInput.pressKey("g", { ctrl: true })
    await wait(() => screen.captureCharFrame().includes("History prompt 0"))
    await timeline()
    expect(screen.captureCharFrame()).toContain("History prompt 104")
    screen.mockInput.pressArrow("down")
    await screen.renderOnce()
    await client.session.prompt({ sessionID: session.id, id: "msg_view_105", text: "History prompt 105" })
    await client.session.wait({ sessionID: session.id })
    await wait(() => screen.captureCharFrame().includes("History prompt 105"))
    screen.mockInput.pressEnter()
    await wait(
      () =>
        screen.captureCharFrame().includes("Message actions") &&
        screen.renderer.currentFocusedEditor instanceof InputRenderable,
    )
    screen.mockInput.pressEnter()
    await wait(() => copied.length === 3)
    expect(copied[2]).toBe("History prompt 103")
    await wait(() => screen.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const editor = screen.renderer.currentFocusedEditor
    const newestReads = snapshots.filter((snapshot) => snapshot.before === undefined && snapshot.count === 100).length
    await screen.mockInput.typeText("draft survives backend restart")
    await Service.stop({ file: runtime.file })
    await wait(
      () =>
        connections > 0 &&
        snapshots.filter((snapshot) => snapshot.before === undefined && snapshot.count === 100).length > newestReads &&
        screen.captureCharFrame().includes("ready") &&
        !screen.captureCharFrame().includes("Reconnecting"),
    )
    expect(screen.renderer.currentFocusedEditor).toBe(editor)
    expect(screen.captureCharFrame()).toContain("draft survives backend restart")
    expect(
      snapshots.filter((snapshot) => snapshot.before === undefined && snapshot.count === 100).length,
    ).toBeGreaterThan(newestReads)
    const nextEndpoint = await Service.ensure({ file: runtime.file, command: runtime.command("view-history") })
    restarted = make({ endpoint: nextEndpoint, location: { directory: runtime.configDir } })
    expect(
      (await restarted.message.list({ sessionID: session.id })).filter((message) => message.type === "user"),
    ).toHaveLength(106)
    expect(await restarted.session.pending.list({ sessionID: session.id })).toEqual([])
  } finally {
    screen.renderer.destroy()
    await task
    client.transport.close()
    restarted?.transport.close()
    await runtime.dispose()
    await provider.stop(true)
    await mock.module("../src/context/clipboard", () => originalClipboard)
    await mock.module("../src/context/data", () => originalData)
  }
}, 120_000)
