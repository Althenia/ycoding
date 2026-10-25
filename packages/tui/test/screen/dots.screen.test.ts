import { expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { createStore } from "solid-js/store"
import { dotsPeerLabel } from "@ycoding-ai/client/dots-peer"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { assertTestPaths } from "../preload"

async function withDotsScreen(
  status: (bound: boolean, target: unknown) => Response | undefined,
  run: (view: {
    screen: Awaited<ReturnType<Awaited<typeof import("./harness")>["renderScreen"]>>
    sent: unknown[]
    prompts: unknown[]
    requests: string[]
    target: Record<string, string>
    isBound: () => boolean
    wait: (predicate: () => boolean) => Promise<void>
  }) => Promise<void>,
  messages: Parameters<typeof sessionSnapshot>[1] = [],
) {
  const { renderScreen } = await import("./harness")
  const { Global } = await import("@ycoding-ai/core/global")
  assertTestPaths(Global.Path)
  const sessionID = "ses_dots_screen"
  const directory = "/tmp/ycoding/dots-screen"
  const location = { directory, project: { id: "proj_dots_screen", directory } }
  const model = { providerID: "openai", id: "synthetic" }
  const session = {
    id: sessionID,
    title: "External peer",
    projectID: location.project.id,
    location: { directory },
    agent: "build",
    model,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
  }
  const target = {
    profile: "fixture-profile",
    dotID: "dot-1",
    threadID: "thread-1",
    generation: "generation-1",
    label: "Fixture Dot / conversation",
  }
  const sent: unknown[] = []
  const prompts: unknown[] = []
  let bound = false
  const requests: string[] = []
  const screen = await renderScreen({
    width: 120,
    height: 36,
    kittyKeyboard: true,
    args: { sessionID },
    sessionReady: true,
    settle: "Message YCoding…",
    config: { animations: false, session: { sidebar: "hide" } },
    route: async (url, request) => {
      requests.push(`${request.method} ${url.pathname}`)
      if (url.pathname.endsWith("/wait")) return new Response(null, { status: 204 })
      if (url.pathname.endsWith("/dots/targets")) return json({ data: [target] })
      if (url.pathname.endsWith("/dots/bind")) {
        expect(await request.json()).toEqual(target)
        bound = true
        return json({ data: { enabled: true, state: "connected", target } })
      }
      if (url.pathname.endsWith("/dots/unbind")) {
        expect(await request.json()).toEqual({ expectedTarget: target })
        bound = false
        return json({ data: { enabled: true, state: "disconnected" } })
      }
      if (url.pathname.endsWith("/dots/send")) {
        const body = await request.json()
        sent.push(body)
        return json({ data: { messageID: body.id, status: "accepted", turnID: "turn-1" } })
      }
      if (url.pathname.endsWith("/dots")) return status(bound, target)
      if (request.method === "POST" && url.pathname.endsWith("/prompt")) {
        prompts.push(await request.json())
        return json({})
      }
      if (request.method === "POST") return json({})
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname.endsWith("/snapshot")) return sessionSnapshot(sessionID, messages, { session })
      if (url.pathname.endsWith("/subagent"))
        return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
      if (["pending", "permission", "todo", "skills"].some((part) => url.pathname.endsWith(`/${part}`)))
        return json({ data: [] })
      if (url.pathname === "/api/integration")
        return json({
          location,
          data: [
            {
              id: "openai",
              name: "OpenAI",
              methods: [],
              connections: [{ type: "credential", id: "cred_fixture", label: "fixture-profile", active: false }],
            },
          ],
        })
      if (url.pathname === "/api/integration/openai")
        return json({
          location,
          data: {
            id: "openai",
            name: "OpenAI",
            methods: [],
            connections: [{ type: "credential", id: "cred_fixture", label: "fixture-profile", active: false }],
          },
        })
      if (url.pathname === "/api/agent")
        return json({
          location,
          data: [
            {
              id: "build",
              name: "Build",
              request: { headers: {}, body: {} },
              mode: "primary",
              hidden: false,
              permissions: [],
            },
          ],
        })
      if (url.pathname === "/api/model" || url.pathname === "/api/model/default") {
        const info = {
          ...model,
          modelID: model.id,
          name: "Synthetic",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 200000, output: 32000 },
        }
        return json({ location, data: url.pathname.endsWith("default") ? { ...info, selection: model } : [info] })
      }
      return undefined
    },
  })
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    throw new Error(`Dots transition missing:\n${screen.frame()}`)
  }
  try {
    await run({ screen, sent, prompts, requests, target, isBound: () => bound, wait })
  } finally {
    await screen.dispose()
  }
}

const enabledStatus = (bound: boolean, target: unknown) =>
  json({ data: { enabled: true, state: "connected", ...(bound ? { target } : {}) } })

test("remote source attribution accepts resident reactive metadata", () => {
  const [metadata] = createStore({ inputOrigin: "plugin", remoteMcp: { requestID: "request_fixture", epoch: "epoch_fixture", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" } } })
  expect(dotsPeerLabel(metadata)).toBe("Remote MCP · external peer · client_fixture")
})

test("L10 named exchange renders the chosen name with non-human provenance and canonical source details", async () => {
  await withDotsScreen(enabledStatus, async ({ screen, wait, prompts }) => {
    await wait(() => screen.frame().includes("user-chosen name"))
    const frame = screen.frame().replace(/\s+/g, " ")
    expect(frame).toContain("V · external peer · Remote MCP · user-chosen name")
    for (const identity of ["client_fixture", "dot_named", "thread_named", "ses_target", "exchange_named"])
      expect(frame).toContain(identity)
    expect(frame).toContain("Inspect this module")
    expect(prompts).toEqual([])
  }, [{
    id: "msg_named_fixture", type: "user", text: "Inspect this module", time: { created: 1 },
    metadata: {
      inputOrigin: "plugin", remoteMcp: { requestID: "request_fixture", epoch: "epoch_fixture", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" } },
      dotsExchange: { sessionID: "ses_anchor", targetSessionID: "ses_target", exchangeID: "exchange_named", attachment: { profile: "fixture", dotID: "dot_named", threadID: "thread_named", generation: "generation_named", label: "V" } },
    },
  }])
}, 30_000)

test("L10 bound composer uses the chosen name without promoting raw IDs into its title", async () => {
  const named = { profile: "fixture-profile", dotID: "dot-1", threadID: "thread-1", generation: "generation-1", label: "V" }
  await withDotsScreen(() => json({ data: { enabled: true, state: "connected", target: named } }), async ({ screen, wait, sent, prompts }) => {
    await screen.mouse.click(3, screen.lines().findIndex((line) => line.includes("Message YCoding…")))
    const editor = screen.renderer.currentFocusedEditor
    if (!(editor instanceof TextareaRenderable)) throw new Error("Composer not focused")
    editor.setText("/dots ")
    screen.input.pressEnter()
    await wait(() => screen.frame().includes("Dots destination · V"))
    screen.input.pressEscape()
    await wait(() => screen.frame().includes("Dots · V"))
    const title = screen.frame().split("\n").find((line) => line.includes("Dots · V"))
    expect(title).not.toContain(named.dotID)
    expect(title).not.toContain(named.threadID)
    expect(sent).toEqual([])
    expect(prompts).toEqual([])
  })
}, 30_000)

test("named remote plugin task text renders with external source and exchange identity", async () => {
  await withDotsScreen(enabledStatus, async ({ screen, wait, prompts }) => {
    await wait(() => screen.frame().includes("Remote MCP"))
    expect(screen.frame()).toContain("external peer")
    expect(screen.frame()).toContain("client_fixture")
    expect(screen.frame()).toContain("exchange_fixture")
    expect(screen.frame()).toContain("Investigate the synthetic module")
    expect(prompts).toEqual([])
  }, [{
    id: "msg_remote_fixture", type: "user", text: "Investigate the synthetic module", time: { created: 1 },
    metadata: { inputOrigin: "plugin", remoteMcp: { requestID: "request_fixture", epoch: "epoch_fixture", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" } }, dotsExchange: { sessionID: "ses_anchor", targetSessionID: "ses_dots_screen", exchangeID: "exchange_fixture", attachment: { profile: "fixture", dotID: "dot_fixture", threadID: "thread_fixture", generation: "generation_fixture", label: "Fixture Dot" } } },
  }])
}, 30_000)

test("bare Dots command confirms an explicit destination and waits for a separate Send", async () => {
  await withDotsScreen(enabledStatus, async ({ screen, sent, prompts, target, isBound, wait }) => {
    await screen.mouse.click(
      3,
      screen.lines().findIndex((line) => line.includes("Message YCoding…")),
    )
    const editor = screen.renderer.currentFocusedEditor
    if (!(editor instanceof TextareaRenderable)) throw new Error("Composer not focused")
    await screen.input.typeText("/dots")
    await wait(() => screen.frame().includes("Select Dots destination"))
    expect(sent).toEqual([])
    screen.input.pressEnter()
    await wait(() => editor.plainText === "/dots ")
    expect(sent).toEqual([])
    screen.input.pressEnter()
    await wait(
      () =>
        !editor.focused &&
        screen.frame().includes("Select ChatGPT profile for Dots") &&
        screen.frame().includes("fixture-profile"),
    )
    screen.input.pressEnter()
    await wait(() => screen.frame().includes("Select Dot and conversation"))
    screen.input.pressEnter()
    await wait(() => screen.frame().includes("Confirm Dots destination"))
    expect(isBound()).toBe(false)
    expect(sent).toEqual([])
    screen.input.pressEnter()
    await wait(() => isBound() && screen.frame().includes("Dots · Fixture Dot / conversation"))
    expect(sent).toEqual([])
    editor.setText("/dots chosen message")
    editor.focus()
    screen.input.pressEnter()
    await wait(() => sent.length === 1)
    await wait(() => editor.plainText === "")
    expect(sent[0]).toMatchObject({ text: "chosen message", expectedTarget: target })
    expect(Object.keys(sent[0] as object).sort()).toEqual(["expectedTarget", "id", "text"])
    expect(prompts).toEqual([])
  })
}, 30000)

test("enabled Dots is offered in the command palette", async () => {
  await withDotsScreen(enabledStatus, async ({ screen, requests, wait }) => {
    await wait(() => requests.includes("GET /api/session/ses_dots_screen/dots"))
    await screen.renderOnce()
    screen.input.pressKey("p", { ctrl: true })
    await wait(() => screen.frame().includes("Search"))
    await screen.input.typeText("Dots dest")
    await wait(() => screen.frame().includes("Select Dots destination"))
  })
}, 30000)

test("native Unbind is discoverable and supports bind unbind rebind without sending", async () => {
  await withDotsScreen(enabledStatus, async ({ screen, sent, prompts, requests, isBound, wait }) => {
    for (let cycle = 0; cycle < 2; cycle++) {
      await screen.mouse.click(3, screen.lines().findIndex((line) => line.includes("Message YCoding…")))
      screen.input.pressKey("p", { ctrl: true })
      await wait(() => screen.frame().includes("Commands") && screen.renderer.currentFocusedEditor instanceof InputRenderable)
      await screen.input.typeText("Select Dots destination")
      await wait(() => screen.frame().includes("Select Dots destination") && !screen.frame().includes("Switch session"))
      screen.input.pressEnter()
      await wait(() => screen.frame().includes("Select ChatGPT profile for Dots"))
      screen.input.pressEnter()
      await wait(() => screen.frame().includes("Select Dot and conversation"))
      screen.input.pressEnter()
      await wait(() => screen.frame().includes("Confirm Dots destination"))
      screen.input.pressEnter()
      await wait(() => isBound() && screen.frame().includes("Dots · Fixture Dot / conversation"))
      if (cycle === 1) break
      screen.input.pressKey("p", { ctrl: true })
      await wait(() => screen.frame().includes("Commands") && screen.renderer.currentFocusedEditor instanceof InputRenderable)
      await screen.input.typeText("Unbind Dots destination")
      await wait(() => screen.frame().includes("Unbind Dots destination") && !screen.frame().includes("Switch session"))
      screen.input.pressEnter()
      await wait(() => screen.frame().includes("Unbind Dots destination") && screen.frame().includes("keeps running"))
      screen.input.pressEnter()
      await wait(() => !isBound() && !screen.frame().includes("Dots · Fixture Dot / conversation"))
    }
    expect(requests.filter((request) => request.endsWith("/dots/bind"))).toHaveLength(2)
    expect(requests.filter((request) => request.endsWith("/dots/unbind"))).toHaveLength(1)
    expect(sent).toEqual([])
    expect(prompts).toEqual([])
  })
}, 30000)

const disabledStatuses = {
  disabled: () => json({ data: { enabled: false, state: "disconnected" } }),
  omitted: () => json({ data: { state: "connected" } }),
  unavailable: () => new Response("unavailable", { status: 503 }),
}

test.each(Object.entries(disabledStatuses))(
  "Dots is absent from slash completion when the capability is %s",
  async (_name, status) => {
    await withDotsScreen(status, async ({ screen, requests, wait }) => {
      await screen.mouse.click(
        3,
        screen.lines().findIndex((line) => line.includes("Message YCoding…")),
      )
      await wait(() => requests.includes("GET /api/session/ses_dots_screen/dots"))
      await screen.input.typeText("/")
      await wait(() => screen.frame().includes("/compact"))
      await screen.input.typeText("dots")
      await screen.renderOnce()
      expect(screen.frame()).not.toContain("Select Dots destination")
    })
  },
  30000,
)

test.each(Object.entries(disabledStatuses))(
  "A typed /dots is refused without a model prompt or native call when the capability is %s",
  async (_name, status) => {
    await withDotsScreen(status, async ({ screen, sent, prompts, requests, wait }) => {
      await screen.mouse.click(
        3,
        screen.lines().findIndex((line) => line.includes("Message YCoding…")),
      )
      const editor = screen.renderer.currentFocusedEditor
      if (!(editor instanceof TextareaRenderable)) throw new Error("Composer not focused")
      const statusReads = () => requests.filter((request) => request === "GET /api/session/ses_dots_screen/dots").length
      await wait(() => statusReads() === 1)
      for (const character of "/dots hello") {
        await screen.input.typeText(character)
        await screen.renderOnce()
      }
      screen.input.pressEnter()
      await wait(() => screen.frame().includes("Dots is disabled"))
      expect(editor.plainText).toBe("/dots hello")
      expect(sent).toEqual([])
      expect(prompts).toEqual([])
      expect(statusReads()).toBe(1)
      expect(
        requests.filter(
          (request) =>
            request.includes("/dots/") || request.endsWith("/prompt") || request === "GET /api/integration/openai",
        ),
      ).toEqual([])
    })
  },
  30000,
)

test.each(Object.entries(disabledStatuses))(
  "Dots is absent from the command palette when the capability is %s",
  async (_name, status) => {
    await withDotsScreen(status, async ({ screen, requests, wait }) => {
      await wait(() => requests.includes("GET /api/session/ses_dots_screen/dots"))
      await screen.renderOnce()
      screen.input.pressKey("p", { ctrl: true })
      await wait(() => screen.frame().includes("Search"))
      await screen.input.typeText("Dots dest")
      await screen.renderOnce()
      expect(screen.frame()).not.toContain("Select Dots destination")
    })
  },
  30000,
)
