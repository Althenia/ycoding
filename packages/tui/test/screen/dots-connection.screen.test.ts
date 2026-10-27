import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import type { Dots } from "@ycoding-ai/schema/dots"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_dots_global"
const directory = "/workspace/dots-global"
const location = { directory, project: { id: "proj_dots_global", directory } }
const session = { id: sessionID, title: "Global Dots", projectID: location.project.id, location: { directory }, agent: "build", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 2 } }
const initial = (enabled = false): Dots.NativeStatus => ({ access: { enabled, revision: 2 }, configuration: { ready: true, profile: "fixture-profile" }, connection: { state: enabled ? "connected" : "off", hostname: "fixture-computer" } })

async function fixture(place: "landing" | "root" | "child", value = initial(), controls: {
  read?: (value: Dots.NativeStatus, index: number) => Promise<Dots.NativeStatus>
  write?: (input: { enabled: boolean; expectedRevision: number }) => Promise<Response>
} = {}) {
  const selected = { ...session, ...(place === "child" ? { parentID: "ses_root" } : {}) }
  const root = { ...session, id: "ses_root", title: "Root family" }
  const requests: { path: string; method: string }[] = []
  const writes: unknown[] = []
  let current = value
  let reads = 0
  const screen = await renderScreen({
    width: 90, height: 36, kittyKeyboard: true,
    args: place === "landing" ? {} : { sessionID }, sessionReady: place !== "landing",
    settle: place === "child" ? "Root family" : "Message YCoding…",
    config: { animations: false, session: { sidebar: "hide" } },
    route: async (url, request) => {
      requests.push({ path: url.pathname, method: request.method })
      if (url.pathname === "/api/dots") {
        if (request.method === "PUT") {
          const input = await request.json()
          writes.push(input)
          if (controls.write) return controls.write(input)
          current = { ...current, access: { enabled: input.enabled, revision: current.access.revision + 1 }, connection: { ...current.connection, state: input.enabled ? "connecting" : "off" } }
        }
        return json({ data: controls.read ? await controls.read(current, reads++) : current })
      }
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: place === "child" ? [root, selected] : [selected], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: selected })
      if (url.pathname === "/api/session/ses_root") return json({ data: root })
      if (url.pathname === `/api/session/${sessionID}/snapshot`) return sessionSnapshot(sessionID, [], { session: selected })
      if (url.pathname === "/api/session/ses_root/snapshot") return sessionSnapshot(root.id, [], { session: root })
      return undefined
    },
  })
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000
    while (!predicate() && Date.now() < deadline) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      await screen.renderOnce()
    }
    expect(predicate(), screen.frame()).toBe(true)
  }
  const open = async () => {
    screen.input.pressKey("p", { ctrl: true })
    await wait(() => screen.frame().includes("Commands") && screen.renderer.currentFocusedEditor instanceof InputRenderable)
    await screen.input.typeText("Dots")
    await wait(() => screen.frame().includes("Dots connection"))
    expect(screen.frame().match(/Dots connection/g)).toHaveLength(1)
    expect(screen.frame()).not.toContain("Dots access ·")
    screen.input.pressEnter()
    await wait(() => screen.frame().includes("All existing and future eligible Sessions"))
  }
  return { screen, writes, requests, wait, open, update: (value: Dots.NativeStatus) => { current = value } }
}

for (const place of ["landing", "root", "child"] as const) {
  test(`${place} opens one global Dots control and writes an exact revision`, async () => {
    const view = await fixture(place)
    try {
      expect(view.requests.some((request) => request.path === "/api/dots")).toBe(false)
      await view.open()
      await view.wait(() => view.screen.frame().includes("Connection: Off"))
      for (const text of ["Connect", "Access: Off", "Configuration: Ready", "Profile: fixture-profile", "Computer: fixture-computer"])
        expect(view.screen.frame()).toContain(text)
      view.screen.input.pressEnter()
      await view.wait(() => view.screen.frame().includes("Connection: Connecting") && view.screen.frame().includes("enter disconnect"))
      expect(view.writes).toEqual([{ enabled: true, expectedRevision: 2 }])
      expect(view.screen.frame()).toContain("Access: On")
      expect(view.screen.frame()).not.toContain("Connection: Connected")
      view.screen.input.pressEnter()
      await view.wait(() => view.writes.length === 2 && view.screen.frame().includes("Connection: Off"))
      expect(view.writes[1]).toEqual({ enabled: false, expectedRevision: 3 })
      expect(view.requests.filter((request) => /\/dots(?:\/|$)/.test(request.path)).every((request) => request.path === "/api/dots")).toBe(true)
      view.screen.input.pressEscape()
      await view.wait(() => !view.screen.frame().includes("All existing and future eligible Sessions"))
    } finally { await view.screen.dispose() }
  }, 30000)
}

for (const connection of ["connected", "connecting", "error", "unavailable"] as const) {
  test(`reported ${connection} is independent of global permission and permits Disconnect`, async () => {
    const value = { ...initial(true), configuration: { ready: connection !== "unavailable", profile: "fixture-profile", message: connection === "unavailable" ? "Configure the global Dots profile" : undefined }, connection: { state: connection, hostname: "fixture-computer", message: connection === "error" ? "Channel failed" : undefined } }
    const view = await fixture("landing", value)
    try {
      await view.open()
      const word = connection[0].toUpperCase() + connection.slice(1)
      await view.wait(() => view.screen.frame().includes(`Connection: ${word}`))
      expect(view.screen.frame()).toContain("Access: On")
      expect(view.screen.frame()).toContain("Disconnect")
      if (connection === "error") expect(view.screen.frame()).toContain("Channel failed")
      if (connection === "unavailable") expect(view.screen.frame()).toContain("Configure the global Dots profile")
      view.screen.input.pressEnter()
      await view.wait(() => view.writes.length === 1)
      expect(view.writes).toEqual([{ enabled: false, expectedRevision: 2 }])
    } finally { await view.screen.dispose() }
  }, 30000)
}

test("unconfigured Off reports unavailable and never starts a connection", async () => {
  const view = await fixture("landing", { access: { enabled: false, revision: 0 }, configuration: { ready: false, message: "Configure the global Dots profile" }, connection: { state: "unavailable" } })
  try {
    await view.open()
    await view.wait(() => view.screen.frame().includes("Configuration: Not ready"))
    expect(view.screen.frame()).toContain("Connection: Unavailable")
    expect(view.screen.frame()).toContain("Computer: Unreported")
    view.screen.input.pressEnter()
    await view.screen.renderOnce()
    expect(view.writes).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test("slash command opens global information without changing access", async () => {
  const view = await fixture("landing")
  try {
    await view.screen.input.typeText("/dots")
    view.screen.input.pressEnter()
    await view.wait(() => view.screen.frame().includes("Profile: fixture-profile"))
    expect(view.writes).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test("closing a pending read and reopening rejects its stale connection report", async () => {
  let finish!: (value: Dots.NativeStatus) => void
  const stale = new Promise<Dots.NativeStatus>((resolve) => { finish = resolve })
  const view = await fixture("landing", initial(), { read: async (value, index) => index === 0 ? stale : value })
  try {
    await view.open()
    await view.wait(() => view.requests.some((request) => request.path === "/api/dots"))
    view.screen.input.pressEscape()
    await view.wait(() => !view.screen.frame().includes("All existing and future eligible Sessions"))
    view.update({ ...initial(true), access: { enabled: true, revision: 5 } })
    await view.open()
    await view.wait(() => view.screen.frame().includes("Connection: Connected"))
    finish(initial())
    await new Promise<void>((resolve) => setImmediate(resolve))
    await view.screen.renderOnce()
    expect(view.screen.frame()).toContain("Access: On")
    expect(view.screen.frame()).not.toContain("Connection: Off")
    expect(view.writes).toEqual([])
  } finally { finish(initial()); await view.screen.dispose() }
}, 30000)

test("a pending conflict stays serialized across close and reopen, then uses the reconciled revision", async () => {
  let finish!: (value: Response) => void
  const response = new Promise<Response>((resolve) => { finish = resolve })
  let count = 0
  const view = await fixture("root", initial(true), {
    write: async () => ++count === 1 ? response : json({ data: { ...initial(), access: { enabled: false, revision: 8 } } }),
  })
  try {
    await view.open()
    await view.wait(() => view.screen.frame().includes("Connection: Connected"))
    view.screen.input.pressEnter()
    await view.wait(() => view.screen.frame().includes("Updating access") && view.writes.length === 1)
    view.screen.input.pressEnter()
    expect(view.screen.frame()).toContain("Access: On")
    view.screen.input.pressEscape()
    await view.wait(() => !view.screen.frame().includes("All existing and future eligible Sessions"))
    await view.open()
    view.screen.input.pressEnter()
    await view.screen.renderOnce()
    expect(view.writes).toHaveLength(1)
    view.update({ ...initial(true), access: { enabled: true, revision: 7 } })
    finish(new Response(JSON.stringify({ _tag: "ConflictError", message: "Stale Dots access" }), { status: 409, headers: { "content-type": "application/json" } }))
    await view.wait(() => view.screen.frame().includes("enter disconnect"))
    view.screen.input.pressEnter()
    await view.wait(() => view.writes.length === 2)
    expect(view.writes[1]).toEqual({ enabled: false, expectedRevision: 7 })
  } finally { finish(json({ data: initial(true) })); await view.screen.dispose() }
}, 30000)
