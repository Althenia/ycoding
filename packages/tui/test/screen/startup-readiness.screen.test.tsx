import { expect, spyOn, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sessionHistoryFixture } from "../fixture/session-history"
import { startupPluginFixture } from "../fixture/startup-plugin"
import { directory, json } from "../fixture/tui-client"
import { renderScreen } from "./harness"
import type { useData } from "../../src/context/data"
import { useToast, type ToastContext } from "../../src/ui/toast"

async function until(screen: Awaited<ReturnType<typeof renderScreen>>, ready: () => boolean) {
  const deadline = Date.now() + 5000
  while (!ready() && Date.now() < deadline) {
    await screen.renderOnce()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  if (!ready()) console.log(screen.frame())
  expect(ready()).toBe(true)
}

async function openStatus(screen: Awaited<ReturnType<typeof renderScreen>>) {
  screen.input.pressKey("p", { ctrl: true })
  await until(
    screen,
    () => screen.frame().includes("Commands") && screen.renderer.currentFocusedEditor instanceof InputRenderable,
  )
  const palette = screen.renderer.currentFocusedEditor
  await screen.input.typeText("View status")
  await until(screen, () => screen.frame().includes("View status") && !screen.frame().includes("No results found"))
  screen.input.pressEnter()
  await until(
    screen,
    () =>
      screen.frame().includes("   Status") &&
      screen.renderer.currentFocusedEditor instanceof InputRenderable &&
      screen.renderer.currentFocusedEditor !== palette,
  )
}

for (const width of [80, 120]) {
  for (const view of ["home", "session"] as const) {
    test(`${view} shell, editor and built-in commands precede optional setup at ${width} columns`, async () => {
      const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-startup-"))
      const plugin = startupPluginFixture()
      const fixture = sessionHistoryFixture(2)
      fixture.release()
      const screen = await renderScreen({
        width,
        height: width === 80 ? 24 : 36,
        state,
        settle: "",
        args: view === "session" ? { sessionID: fixture.sessionID } : {},
        config: { plugins: ["startup-fixture"], attention: { enabled: false }, session: { sidebar: "hide" } },
        packages: { resolve: async () => new URL("../fixture/startup-plugin.tsx", import.meta.url).href },
        route: view === "session" ? fixture.route : undefined,
      })
      try {
        await plugin.entered.promise
        await until(
          screen,
          () => screen.frame().includes("Message YCoding") && screen.renderer.currentFocusedEditor !== null,
        )
        const editor = screen.renderer.currentFocusedEditor
        await screen.input.typeText("retained startup draft")
        await screen.renderOnce()
        expect(screen.frame()).toContain("retained startup draft")
        expect(screen.frame()).toContain("commands")
        expect(screen.frame()).not.toContain("Loading plugins")
        expect(screen.frame()).not.toContain("Finishing startup")
        if (view === "session" && width === 80) {
          await screen.waitForEventStream()
          screen.events.disconnect()
          await until(screen, () => screen.frame().includes("Reconnecting"))
          expect(screen.renderer.currentFocusedEditor).toBe(editor)
          expect(screen.frame()).toContain("retained startup draft")
          screen.input.pressEnter()
          expect(fixture.requests.filter((request) => request.startsWith("POST"))).toEqual([])
          await until(screen, () => !screen.frame().includes("Reconnecting"))
          expect(screen.frame()).not.toContain("Loading plugins")
        }
        screen.input.pressKey("p", { ctrl: true })
        await until(
          screen,
          () => screen.frame().includes("Commands") && screen.renderer.currentFocusedEditor instanceof InputRenderable,
        )
        await screen.input.typeText("Open diff viewer")
        await until(screen, () => screen.frame().includes("Open diff viewer"))
        screen.input.pressKey("ESCAPE")
        plugin.gate.resolve()
        await until(screen, () => screen.frame().includes("retained startup draft"))
        expect(screen.renderer.currentFocusedEditor).toBe(editor)
        expect(screen.frame()).not.toContain("Finishing startup")
      } finally {
        plugin.gate.resolve()
        await screen.dispose()
        await rm(state, { recursive: true, force: true })
      }
    }, 15000)
  }
}

test("a registered plugin route is pending rather than falsely missing during setup", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-startup-route-"))
  const plugin = startupPluginFixture()
  plugin.navigate = true
  const screen = await renderScreen({
    width: 80,
    height: 24,
    state,
    settle: "",
    config: { plugins: ["startup-fixture"], attention: { enabled: false } },
    packages: { resolve: async () => new URL("../fixture/startup-plugin.tsx", import.meta.url).href },
  })
  try {
    await plugin.entered.promise
    await until(screen, () => screen.frame().includes("Loading extension"))
    expect(screen.frame()).not.toContain("Unknown plugin route")
    plugin.gate.resolve()
    await until(screen, () => screen.frame().includes("Fixture extension page"))
  } finally {
    plugin.gate.resolve()
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 15000)

test("built-in routes open before optional setup completes", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-startup-builtins-"))
  const plugin = startupPluginFixture()
  const screen = await renderScreen({
    width: 80,
    height: 24,
    state,
    settle: "",
    config: { plugins: ["startup-fixture"], attention: { enabled: false } },
    packages: { resolve: async () => new URL("../fixture/startup-plugin.tsx", import.meta.url).href },
  })
  try {
    await plugin.entered.promise
    await until(screen, () => screen.frame().includes("Message YCoding"))
    screen.input.pressKey("p", { ctrl: true })
    await until(
      screen,
      () => screen.frame().includes("Commands") && screen.renderer.currentFocusedEditor instanceof InputRenderable,
    )
    await screen.input.typeText("Open scrap screen")
    await until(
      screen,
      () => screen.frame().includes("Open scrap screen") && !screen.frame().includes("No results found"),
    )
    screen.input.pressEnter()
    await until(screen, () => screen.frame().includes("esc home"))
    expect(screen.frame()).not.toContain("Loading extension")
  } finally {
    plugin.gate.resolve()
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 15000)

test("optional module failure leaves the core composer and diagnostic available", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-startup-failure-"))
  const screen = await renderScreen({
    width: 120,
    height: 36,
    state,
    settle: "",
    config: { plugins: ["broken-startup-fixture"], attention: { enabled: false } },
    packages: {
      resolve: async () => {
        throw new Error("Fixture optional module failed")
      },
    },
  })
  try {
    await until(
      screen,
      () => screen.frame().includes("Message YCoding") && screen.renderer.currentFocusedEditor !== null,
    )
    await screen.input.typeText("usable after optional failure")
    await openStatus(screen)
    await screen.input.typeText("Plugins")
    await until(screen, () => screen.frame().includes("broken-startup-fixture"))
    expect(screen.frame()).toContain("Failed")
    screen.input.pressKey("ESCAPE")
    await until(
      screen,
      () =>
        screen.renderer.currentFocusedEditor !== null &&
        !(screen.renderer.currentFocusedEditor instanceof InputRenderable),
    )
    await openStatus(screen)
    await screen.input.typeText("broken-startup-fixture")
    await until(screen, () => screen.frame().includes("Fixture optional module failed"))
    expect(screen.frame()).toContain("failed")
    screen.input.pressKey("ESCAPE")
    await until(screen, () => screen.frame().includes("usable after optional failure"))
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 15000)

test("required built-in failure shows an actionable error instead of a permanently blank shell", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-startup-core-error-"))
  const screen = await renderScreen({
    width: 120,
    height: 36,
    state,
    settle: "",
    config: { attention: { enabled: false } },
    builtins: [
      {
        id: "fixture.broken-core",
        setup: () => {
          throw new Error("Fixture required registration failed")
        },
      },
    ],
  })
  try {
    await until(screen, () => screen.frame().includes("Message YCoding"))
    expect(screen.frame()).toContain("YCoding startup failed")
    await openStatus(screen)
    await screen.input.typeText("Built-in startup")
    await until(screen, () => screen.frame().includes("Fixture required registration failed"))
    expect(screen.frame()).toContain("failed")
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 15000)

test("initial MCP authentication stays in Status, later failures alert once and recovery rearms", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-startup-mcp-"))
  let status: "needs_auth" | "connected" | "failed" = "needs_auth"
  let data!: ReturnType<typeof useData>
  let toast!: ToastContext
  const screen = await renderScreen({
    width: 80,
    height: 36,
    state,
    settle: "",
    data: (value) => {
      data = value
      toast = useToast()
    },
    config: { attention: { enabled: false } },
    route: (url) =>
      url.pathname === "/api/mcp"
        ? json({
            location: { directory, project: { id: "proj_test", directory } },
            data: [
              {
                name: "fixture-mcp",
                status: status === "failed" ? { status, error: "Fixture connection failed" } : { status },
              },
            ],
          })
        : undefined,
  })
  const refresh = async () => {
    data.location.mcp.server.invalidate()
    await data.location.mcp.server.sync()
    await screen.renderOnce()
  }
  await until(screen, () => toast !== undefined)
  const alerts = spyOn(toast, "show")
  try {
    await until(
      screen,
      () =>
        data?.location.mcp.server.list()?.[0]?.status.status === "needs_auth" &&
        screen.frame().includes("Message YCoding"),
    )
    await data.location.sync()
    await screen.renderOnce()
    expect(screen.frame()).not.toContain("MCP server needs authentication")
    await openStatus(screen)
    await screen.input.typeText("fixture-mcp")
    await until(screen, () => screen.frame().includes("fixture-mcp") && screen.frame().includes("Authorize"))
    const statusEditor = screen.renderer.currentFocusedEditor
    screen.input.pressEnter()
    await until(
      screen,
      () =>
        screen.frame().includes("MCP servers") &&
        screen.renderer.currentFocusedEditor instanceof InputRenderable &&
        screen.renderer.currentFocusedEditor !== statusEditor,
    )
    expect(screen.frame()).toContain("Authorize")
    screen.input.pressKey("ESCAPE")
    await until(screen, () => screen.frame().includes("Message YCoding") && !screen.frame().includes("enter or space"))
    status = "connected"
    await refresh()
    status = "failed"
    await refresh()
    expect(screen.frame()).toContain("MCP server failed: fixture-mcp")
    await refresh()
    expect(alerts.mock.calls.filter(([options]) => options.title === "MCP server failed: fixture-mcp")).toHaveLength(1)
    await openStatus(screen)
    await screen.input.typeText("fixture-mcp")
    await until(screen, () => screen.frame().includes("fixture-mcp") && screen.frame().includes("Failed"))
    screen.input.pressKey("ESCAPE")
    status = "connected"
    await refresh()
    status = "failed"
    await refresh()
    expect(screen.frame()).toContain("MCP server failed: fixture-mcp")
    expect(alerts.mock.calls.filter(([options]) => options.title === "MCP server failed: fixture-mcp")).toHaveLength(2)
    await screen.waitForEventStream()
    const reconnected = Promise.withResolvers<void>()
    const unsubscribe = data.on("server.connected", () => reconnected.resolve())
    screen.events.disconnect()
    await reconnected.promise
    unsubscribe()
    await refresh()
    expect(alerts.mock.calls.filter(([options]) => options.title === "MCP server failed: fixture-mcp")).toHaveLength(2)
  } finally {
    alerts.mockRestore()
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 15000)

for (const initial of ["needs_auth", "failed"] as const) {
  test(`cold pending MCP settling as ${initial} is quiet and actionable`, async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-startup-pending-"))
    let status: "pending" | "needs_auth" | "failed" = "pending"
    let data!: ReturnType<typeof useData>
    const screen = await renderScreen({
      width: 120,
      height: 36,
      state,
      settle: "",
      data: (value) => {
        data = value
      },
      config: { attention: { enabled: false } },
      route: (url) =>
        url.pathname === "/api/mcp"
          ? json({
              location: { directory, project: { id: "proj_test", directory } },
              data: [
                {
                  name: "fixture-mcp",
                  status: status === "failed" ? { status, error: "Fixture startup failure" } : { status },
                },
              ],
            })
          : undefined,
    })
    try {
      await until(
        screen,
        () =>
          data?.location.mcp.server.list()?.[0]?.status.status === "pending" &&
          screen.frame().includes("Message YCoding"),
      )
      await data.location.sync()
      status = initial
      data.location.mcp.server.invalidate()
      await data.location.mcp.server.sync()
      await screen.renderOnce()
      expect(screen.frame()).not.toContain("MCP server failed:")
      expect(screen.frame()).not.toContain("MCP server needs authentication")
      await openStatus(screen)
      await screen.input.typeText("fixture-mcp")
      await until(screen, () => screen.frame().includes(initial === "failed" ? "Failed" : "Authorize"))
    } finally {
      await screen.dispose()
      await rm(state, { recursive: true, force: true })
    }
  }, 15000)
}

test("ordered built-in directives precede an earlier held optional plugin", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-startup-selectors-"))
  const plugin = startupPluginFixture()
  const screen = await renderScreen({
    width: 120,
    height: 36,
    state,
    settle: "",
    config: { plugins: ["startup-fixture", "-diff-viewer", "*", "-ycoding.scrap"], attention: { enabled: false } },
    packages: { resolve: async () => new URL("../fixture/startup-plugin.tsx", import.meta.url).href },
  })
  try {
    await plugin.entered.promise
    await until(screen, () => screen.frame().includes("Message YCoding"))
    screen.input.pressKey("p", { ctrl: true })
    await until(
      screen,
      () => screen.frame().includes("Commands") && screen.renderer.currentFocusedEditor instanceof InputRenderable,
    )
    await screen.input.typeText("Open scrap screen")
    await until(screen, () => screen.frame().includes("No results found"))
    screen.input.pressKey("ESCAPE")
    await until(
      screen,
      () => screen.frame().includes("Message YCoding") && !screen.frame().includes("No results found"),
    )
    screen.input.pressKey("p", { ctrl: true })
    await until(
      screen,
      () => screen.frame().includes("Commands") && screen.renderer.currentFocusedEditor instanceof InputRenderable,
    )
    await screen.input.typeText("Open diff viewer")
    await until(screen, () => screen.frame().includes("Open diff viewer"))
  } finally {
    plugin.gate.resolve()
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 15000)

test("shutdown does not await optional setup and disposes its late cleanup exactly once", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-startup-dispose-"))
  const plugin = startupPluginFixture()
  const screen = await renderScreen({
    width: 80,
    height: 24,
    state,
    settle: "",
    config: { plugins: ["startup-fixture"], attention: { enabled: false } },
    packages: { resolve: async () => new URL("../fixture/startup-plugin.tsx", import.meta.url).href },
  })
  let disposing: Promise<void> | undefined
  try {
    await plugin.entered.promise
    await until(screen, () => screen.frame().includes("Message YCoding"))
    disposing = screen.dispose()
    const done = Promise.withResolvers<boolean>()
    const timeout = setTimeout(() => done.resolve(false), 1000)
    void disposing.then(() => done.resolve(true))
    const settled = await done.promise
    clearTimeout(timeout)
    expect(settled).toBe(true)
    plugin.gate.resolve()
    const deadline = Date.now() + 5000
    while (plugin.cleanups !== 1 && Date.now() < deadline) await new Promise<void>((resolve) => setImmediate(resolve))
    expect(plugin.cleanups).toBe(1)
    expect(() => plugin.context!.ui.router.register({ name: "late", render: () => null })).toThrow(
      "TUI plugin is disposed",
    )
  } finally {
    plugin.gate.resolve()
    await (disposing ?? screen.dispose())
    await rm(state, { recursive: true, force: true })
  }
}, 15000)
