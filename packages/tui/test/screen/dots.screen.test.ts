import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { createStore } from "solid-js/store"
import { dotsPeerLabel } from "@ycoding-ai/client/dots-peer"
import type { DotsAccess, SessionMessageInfo } from "@ycoding-ai/client"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_dots_screen"
const directory = "/workspace/dots-screen"
const location = { directory, project: { id: "proj_dots_screen", directory } }
const session = {
  id: sessionID, title: "External access", projectID: location.project.id, location: { directory },
  agent: "build", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}

async function fixture(options: { enabled?: boolean; configured?: boolean; child?: boolean; messages?: SessionMessageInfo[] } = {}) {
  let access: DotsAccess = {
    sessionID, rootSessionID: options.child ? "ses_root" : sessionID,
    enabled: options.enabled ?? false, configured: options.configured ?? true,
    inherited: options.child ?? false, revision: 2,
  }
  const writes: unknown[] = []
  const paths: string[] = []
  const selected = { ...session, ...(options.child ? { parentID: "ses_root" } : {}) }
  const root = { ...session, id: "ses_root", title: "Root family" }
  const screen = await renderScreen({
    width: 120, height: 36, kittyKeyboard: true, args: { sessionID }, sessionReady: true,
    settle: options.child ? "Root family" : "Message YCoding…", config: { animations: false, session: { sidebar: "hide" } },
    route: async (url, request) => {
      paths.push(url.pathname)
      if (url.pathname === `/api/session/${sessionID}/dots/access`) {
        if (request.method === "POST") {
          const input = await request.json()
          writes.push(input)
          access = { ...access, enabled: input.enabled, revision: access.revision + 1 }
        }
        return json({ data: access })
      }
      if (options.child && url.pathname === "/api/session/ses_root/dots/access")
        return json({ data: { ...access, sessionID: root.id, inherited: false } })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: options.child ? [root, selected] : [selected], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: selected })
      if (options.child && url.pathname === "/api/session/ses_root") return json({ data: root })
      if (url.pathname === `/api/session/${sessionID}/snapshot`) return sessionSnapshot(sessionID, options.messages ?? [], { session: selected })
      if (options.child && url.pathname === "/api/session/ses_root/snapshot") return sessionSnapshot(root.id, [], { session: root })
      if (url.pathname.endsWith("/subagent")) return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
      return undefined
    },
  })
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000
    while (!predicate() && Date.now() < deadline) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      await screen.renderOnce()
    }
    expect(predicate(), `Requests: ${paths.slice(-20).join(", ")}\n${screen.frame()}`).toBe(true)
  }
  const palette = async () => {
    screen.input.pressKey("p", { ctrl: true })
    await wait(() => screen.frame().includes("Commands") && screen.renderer.currentFocusedEditor instanceof InputRenderable)
    await screen.input.typeText("Dots")
    await wait(() => screen.renderer.currentFocusedEditor instanceof InputRenderable && screen.renderer.currentFocusedEditor.plainText === "Dots")
  }
  return { screen, writes, paths, wait, palette }
}

for (const enabled of [false, true]) test(`root access ${enabled} toggles the exact revision with no room controls`, async () => {
  const view = await fixture({ enabled })
  try {
    await view.palette()
    await view.wait(() => view.screen.frame().includes(`Dots access · ${enabled ? "On" : "Off"}`))
    expect(view.screen.frame().match(/Dots access · (?:On|Off)/g), view.screen.frame()).toHaveLength(1)
    for (const label of ["destination", "Coordinator bindings", "Unbind", "profile"])
      expect(view.screen.frame()).not.toContain(label)
    view.screen.input.pressEnter()
    await view.wait(() => view.writes.length === 1)
    expect(view.writes).toEqual([{ enabled: !enabled, expectedRevision: 2 }])
    await view.palette()
    await view.wait(() => view.screen.frame().includes(`Dots access · ${enabled ? "Off" : "On"}`))
    expect(view.paths.filter((path) => /\/dots(\/|$)/.test(path)).every((path) => path.endsWith("/dots/access"))).toBe(true)
  } finally { await view.screen.dispose() }
}, 30000)

test.each([{ configured: false }, { child: true }])("no access action for %j", async (options) => {
  const view = await fixture(options)
  try {
    await view.palette()
    expect(view.screen.frame()).not.toContain("Dots access")
    expect(view.writes).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test("remote source attribution accepts resident reactive metadata", () => {
  const [metadata] = createStore({ inputOrigin: "plugin", remoteMcp: { requestID: "request_fixture", epoch: "epoch_fixture", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" } } })
  expect(dotsPeerLabel(metadata)).toBe("Remote MCP · external peer · client_fixture")
})

test("stored named exchanges retain external provenance and canonical source details", async () => {
  const view = await fixture({ messages: [{
    id: "msg_named_fixture", type: "user", text: "Inspect this module", time: { created: 1 },
    metadata: {
      inputOrigin: "plugin", remoteMcp: { requestID: "request_fixture", epoch: "epoch_fixture", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" } },
      dotsExchange: { sessionID: "ses_anchor", targetSessionID: "ses_target", exchangeID: "exchange_named", attachment: { profile: "fixture", dotID: "dot_named", threadID: "thread_named", generation: "generation_named", label: "V" } },
    },
  }] })
  try {
    await view.wait(() => view.screen.frame().includes("user-chosen name"))
    const frame = view.screen.frame().replace(/\s+/g, " ")
    expect(frame).toContain("V · external peer · Remote MCP · user-chosen name")
    for (const identity of ["client_fixture", "dot_named", "thread_named", "ses_target", "exchange_named", "Inspect this module"])
      expect(frame).toContain(identity)
    expect(view.writes).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)
