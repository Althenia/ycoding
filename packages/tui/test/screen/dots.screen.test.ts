import { expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { dotsPeerLabel } from "@ycoding-ai/client/dots-peer"
import type { SessionMessageInfo } from "@ycoding-ai/client"
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

async function fixture(options: { messages?: SessionMessageInfo[] } = {}) {
  const writes: unknown[] = []
  const paths: string[] = []
  const selected = session
  const screen = await renderScreen({
    width: 120, height: 36, kittyKeyboard: true, args: { sessionID }, sessionReady: true,
    settle: "Message YCoding…", config: { animations: false, session: { sidebar: "hide" } },
    route: async (url, request) => {
      paths.push(url.pathname)
      if (request.method !== "GET") writes.push({ method: request.method, path: url.pathname })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [selected], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: selected })
      if (url.pathname === `/api/session/${sessionID}/snapshot`) return sessionSnapshot(sessionID, options.messages ?? [], { session: selected })
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
  return { screen, writes, paths, wait }
}

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
