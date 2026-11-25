/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { Keymap } from "../src/context/keymap"
import { RouteProvider } from "../src/context/route"
import { ThemeProvider } from "../src/context/theme"
import { createApi, createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const project = { id: "proj_test", directory }

test("startup lists the active project once and pages only pinned roots", async () => {
  const world = createWorld({ pinned: ["ses_pin_a", "ses_pin_b", "ses_pin_c"] })
  const mounted = await mount(world)
  try {
    await waitFor(() => mounted.data().session.get("ses_pin_c") !== undefined && mounted.data().session.get("ses_recent") !== undefined)
    await Bun.sleep(300)
    const pinned = world.lists.filter((url) => url.searchParams.get("pinned") === "true")
    const recent = world.lists.filter((url) => url.searchParams.get("project") === project.id)
    expect(pinned.map((url) => url.searchParams.get("cursor"))).toEqual([null, "p1", "p2"])
    expect(recent).toHaveLength(1)
    expect(recent[0]!.searchParams.get("limit")).toBe("50")
    expect(recent[0]!.searchParams.get("pinned")).toBe("false")
    expect(recent[0]!.searchParams.get("parentID")).toBe("null")
    expect(recent[0]!.searchParams.get("background")).toBe("exclude")
    expect(world.lists).toHaveLength(pinned.length + recent.length)
    expect(mounted.data().session.get("ses_unrelated")).toBeUndefined()
  } finally {
    mounted.destroy()
  }
})

test("a combined pinned and recent batch keeps the newest unprotected roots resident", async () => {
  const world = createWorld({ pinned: ["ses_pin_a"], recent: 60 })
  const mounted = await mount(world)
  try {
    await waitFor(() => mounted.data().session.get("ses_recent_59") !== undefined || mounted.data().session.get("ses_recent_0") !== undefined)
    await Bun.sleep(300)
    const resident = (id: string) => mounted.data().session.get(id) !== undefined
    expect(resident("ses_pin_a")).toBe(true)
    expect(Array.from({ length: 50 }, (_, index) => resident(`ses_recent_${index}`)).every(Boolean)).toBe(true)
    expect(resident("ses_recent_59")).toBe(false)
  } finally {
    mounted.destroy()
  }
})

test("every pin stays resident beyond the recent limit, with overlapping pinned pages deduplicated", async () => {
  const pins = Array.from({ length: 60 }, (_, index) => `ses_pin_p${index}`)
  const world = createWorld({ pinned: pins, recent: 50, pageSize: 25, overlap: 2 })
  const mounted = await mount(world)
  try {
    await waitFor(() => mounted.data().session.get("ses_recent_49") !== undefined && mounted.data().session.get("ses_pin_p59") !== undefined)
    await Bun.sleep(300)
    const resident = (id: string) => mounted.data().session.get(id) !== undefined
    expect(pins.every(resident)).toBe(true)
    expect(Array.from({ length: 50 }, (_, index) => resident(`ses_recent_${index}`)).every(Boolean)).toBe(true)
    const listed = mounted.data().session.list().map((session) => session.id)
    expect(new Set(listed).size).toBe(listed.length)
    expect(listed).toHaveLength(110)
    const pinned = world.lists.filter((url) => url.searchParams.get("pinned") === "true")
    expect(pinned.map((url) => url.searchParams.get("cursor"))).toEqual([null, "p25", "p50"])
    const recent = world.lists.filter((url) => url.searchParams.get("project") === project.id)
    expect(recent.map((url) => url.searchParams.get("pinned"))).toEqual(["false"])
  } finally {
    mounted.destroy()
  }
})

test("without a project identity only pinned roots are listed", async () => {
  const world = createWorld({ pinned: ["ses_pin_a"], location: "fail" })
  const mounted = await mount(world)
  try {
    await waitFor(() => mounted.data().session.get("ses_pin_a") !== undefined)
    await mounted.data().session.syncRoots()
    await Bun.sleep(200)
    expect(world.lists.every((url) => url.searchParams.get("pinned") === "true")).toBe(true)
    expect(world.lists.length).toBeGreaterThan(0)
  } finally {
    mounted.destroy()
  }
})

test("a resident root unpinned elsewhere is refreshed instead of staying pinned", async () => {
  const world = createWorld({ pinned: ["ses_pin_a", "ses_pin_b"] })
  const mounted = await mount(world)
  try {
    await waitFor(() => mounted.data().session.get("ses_pin_b")?.time.pinned !== undefined)
    world.pinned.delete("ses_pin_b")
    await mounted.data().session.syncRoots({ directory, project })
    await waitFor(() => mounted.data().session.get("ses_pin_b")?.time.pinned === undefined)
    expect(mounted.data().session.get("ses_pin_a")?.time.pinned).toBeDefined()
    expect(world.details).toContain("ses_pin_b")
    expect(world.details).not.toContain("ses_pin_a")
  } finally {
    mounted.destroy()
  }
})

test("a root sync superseded by a reconnect does not write its stale snapshot", async () => {
  const gate = Promise.withResolvers<void>()
  const world = createWorld({ pinned: ["ses_pin_stale"], hold: gate.promise })
  const mounted = await mount(world)
  try {
    await waitFor(() => world.held > 0)
    world.pinned.clear()
    world.pinned.add("ses_pin_fresh")
    mounted.events.disconnect()
    await waitFor(() => mounted.events.subscriptions() > 0)
    gate.resolve()
    await waitFor(() => mounted.data().session.get("ses_pin_fresh") !== undefined)
    await Bun.sleep(200)
    expect(mounted.data().session.get("ses_pin_stale")).toBeUndefined()
  } finally {
    gate.resolve()
    mounted.destroy()
  }
})

function createWorld(input: { pinned: string[]; location?: "fail"; hold?: Promise<void>; recent?: number; pageSize?: number; overlap?: number }) {
  const pinned = new Set(input.pinned)
  const lists: URL[] = []
  const details: string[] = []
  const world = { pinned, lists, details, held: 0 }
  const info = (id: string, updated = 1) => ({
    id,
    projectID: id === "ses_recent" || id.startsWith("ses_pin_p") ? project.id : "proj_other",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated, ...(pinned.has(id) ? { pinned: 10 } : {}) },
    title: id,
    location: { directory },
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
  })
  const fetch = async (url: URL) => {
    if (url.pathname === "/api/location" && input.location === "fail") return new Response("boom", { status: 500 })
    if (url.pathname === "/api/session") {
      lists.push(url)
      const held = input.hold && lists.length === 1
      const snapshot = url.searchParams.get("pinned") === "true" ? [...pinned] : []
      if (held) {
        world.held++
        await input.hold
      }
      if (url.searchParams.get("pinned") === "true") {
        const size = input.pageSize ?? 1
        const offset = Number((url.searchParams.get("cursor") ?? "p0").slice(1))
        const page = snapshot.slice(Math.max(0, offset - (offset > 0 ? (input.overlap ?? 0) : 0)), offset + size)
        return json({
          data: page.map((id) => info(id)),
          cursor: offset + size < snapshot.length ? { next: `p${offset + size}` } : {},
        })
      }
      if (url.searchParams.get("project") === project.id) {
        const count = input.recent ?? 0
        if (count > 0)
          return json({
            data: Array.from({ length: count }, (_, index) => ({ ...info(`ses_recent_${index}`, 10_000 - index), projectID: project.id })),
            cursor: {},
          })
        return json({ data: [info("ses_recent")], cursor: {} })
      }
      return json({ data: [info("ses_unrelated")], cursor: {} })
    }
    const detail = /^\/api\/session\/(ses_[a-z_]+)$/.exec(url.pathname)?.[1]
    if (detail && detail !== "active") {
      details.push(detail)
      return json({ data: info(detail) })
    }
    return undefined
  }
  return Object.assign(world, { fetch })
}

async function mount(world: ReturnType<typeof createWorld>) {
  const events = createEventStream()
  const calls = createFetch((url) => world.fetch(url), events)
  let data!: ReturnType<typeof useData>
  function Fixture() {
    data = useData()
    return <box />
  }
  const config = createTuiResolvedConfig()
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <Keymap.Provider config={config}>
              <RouteProvider initialRoute={{ type: "home" }}>
                <ClientProvider api={createApi(calls.fetch)}>
                  <DataProvider>
                    <Fixture />
                  </DataProvider>
                </ClientProvider>
              </RouteProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 4 },
  )
  app.renderer.start()
  await waitFor(() => data !== undefined)
  return {
    data: () => data,
    events,
    destroy() {
      app.renderer.destroy()
      events.disconnect()
    },
  }
}

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (condition()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out waiting for condition")
}
