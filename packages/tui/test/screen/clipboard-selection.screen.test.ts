import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { json } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_clipboard_selection"
const directory = "/tmp/ycoding/clipboard-selection"
const location = { directory, project: { id: "proj_clipboard_selection", directory } }
const model = { providerID: "openai", id: "fixture" }
const session = {
  id: sessionID,
  title: "Clipboard selection",
  projectID: location.project.id,
  location: { directory },
  agent: "build",
  model,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}

async function route(url: URL) {
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/message`)
    return json({
      data: [
        {
          id: "msg_selection",
          type: "assistant",
          agent: "build",
          model,
          content: [{ type: "text", text: "clipboard selection target" }],
          finish: "stop",
          time: { created: 1, completed: 2 },
        },
      ],
      cursor: {},
    })
  if (url.pathname === `/api/session/${sessionID}/subagent`)
    return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
  if (
    ["pending", "permission", "todo", "skills"].some(
      (resource) => url.pathname === `/api/session/${sessionID}/${resource}`,
    )
  )
    return json({ data: [] })
  if (url.pathname === `/api/session/${sessionID}/guardrail`)
    return json({
      data: {
        rootSessionID: sessionID,
        profile: "standard",
        customRules: 0,
        approvals: 0,
        blocked: 0,
        counters: [],
        invalidFiles: [],
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
  if (url.pathname === "/api/model")
    return json({
      location,
      data: [
        {
          ...model,
          modelID: model.id,
          name: "Fixture",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 200000, output: 32000 },
        },
      ],
    })
  return undefined
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error("Expected clipboard selection transition did not occur")
}

test.each(["enabled", "disabled"])(
  "main transcript uses explicit copy when dialog copy-on-select is %s",
  async (mode) => {
    const writes: string[] = []
    const screen = await renderScreen({
      width: 100,
      height: 40,
      args: { sessionID },
      route,
      clipboard: {
        read: async () => undefined,
        write: async (text) => {
          writes.push(text)
        },
      },
      config: { terminal: { copy_on_select: mode === "enabled" }, animations: false },
      settle: "clipboard selection target",
    })
    try {
      const row = screen.lines().findIndex((line) => line.includes("clipboard selection target"))
      const column = screen.lines()[row].indexOf("clipboard selection target")
      await screen.mouse.drag(column, row, column + "clipboard selection target".length - 1, row)
      await screen.renderOnce()
      expect(screen.renderer.getSelection()?.getSelectedText()).toBe("clipboard selection target")
      expect(writes).toEqual([])
      screen.input.pressKey("c", { ctrl: true })
      await until(() => writes.length === 1 && screen.renderer.getSelection() === null)
      expect(writes).toEqual(["clipboard selection target"])
      expect(screen.renderer.isDestroyed).toBe(false)
    } finally {
      await screen.dispose()
    }
  },
  30000,
)

test.each([
  ["enabled", 80],
  ["disabled", 80],
  ["default", 80],
  ["enabled", 100],
  ["disabled", 100],
  ["default", 100],
] as const)(
  "Settings names dialog scope and dialog release honors %s at %i columns",
  async (mode, width) => {
    const writes: string[] = []
    const screen = await renderScreen({
      width,
      height: 40,
      args: { sessionID },
      route,
      clipboard: {
        read: async () => undefined,
        write: async (text) => {
          writes.push(text)
        },
      },
      config: { terminal: mode === "default" ? {} : { copy_on_select: mode === "enabled" }, animations: false },
      settle: "Message YCoding…",
    })
    try {
      screen.input.pressKey("p", { ctrl: true })
      await until(() => screen.renderer.currentFocusedEditor instanceof InputRenderable)
      const palette = screen.renderer.currentFocusedEditor
      await screen.input.typeText("Open settings")
      screen.input.pressKey("ARROW_DOWN")
      screen.input.pressEnter()
      await until(
        () =>
          screen.frame().includes("Settings") &&
          screen.renderer.currentFocusedEditor instanceof InputRenderable &&
          screen.renderer.currentFocusedEditor !== palette,
      )
      await screen.input.typeText("copy")
      await until(() => screen.frame().includes("Dialog copy on select"))
      await screen.renderOnce()
      expect(screen.frame()).toContain("Dialog copy on select")
      const row = screen.lines().findIndex((line) => line.trim() === "Terminal")
      expect(row).toBeGreaterThan(-1)
      const column = screen.lines()[row].indexOf("Terminal")
      await screen.mouse.drag(column, row, column + "Terminal".length - 1, row)
      await screen.renderOnce()
      const enabled = mode === "default" ? process.platform !== "win32" : mode === "enabled"
      expect(writes).toEqual(enabled ? ["Terminal"] : [])
      if (enabled) expect(screen.renderer.getSelection()).toBeNull()
      if (!enabled) expect(screen.renderer.getSelection()?.getSelectedText()).toBe("Terminal")
    } finally {
      await screen.dispose()
    }
  },
  30000,
)
