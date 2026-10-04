import { expect, test } from "bun:test"
import { json } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_shell_keybind"
const shellID = "sh_keybind"
const directory = "/tmp/ycoding/shell-keybind"
const location = { directory, project: { id: "proj_shell_keybind", directory } }
const session = {
  id: sessionID,
  title: "Shell owner",
  projectID: location.project.id,
  location: { directory },
  agent: "build",
  model: { providerID: "test", id: "test-model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}
const shell = {
  id: shellID,
  status: "running",
  command: "bun test provider",
  cwd: directory,
  shell: "bash",
  file: "shell.log",
  pid: 123,
  metadata: { sessionID },
  time: { started: Date.now() - 1000 },
}

test("rebound shell-output kill and back keys act on the real shell and Session routes", async () => {
  const kills: string[] = []
  process.env.YCODING_ROUTE = JSON.stringify({ type: "shell-output", sessionID, shellID })
  try {
    const screen = await renderScreen({
      width: 100,
      height: 40,
      kittyKeyboard: true,
      settle: "bun test provider",
      config: { keybinds: { app_exit: "ctrl+c", shell_output_kill: "ctrl+k", shell_output_back: "q" } },
      route: (url, request) => {
        if (url.pathname === "/api/location") return json(location)
        if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
        if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
        if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
        if (url.pathname === `/api/session/${sessionID}/subagent`)
          return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
        if (/^\/api\/session\/[^/]+\/(pending|permission|form|todo|skills|guardrail\/request)$/.test(url.pathname))
          return json({ data: [] })
        if (url.pathname === "/api/shell") return json({ location, data: [shell] })
        if (url.pathname === `/api/shell/${shellID}/output`)
          return json({ location, data: { output: "shell output", cursor: 12, size: 12, truncated: false } })
        if (url.pathname === `/api/shell/${shellID}` && request.method === "DELETE") {
          kills.push(shellID)
          return new Response(null, { status: 204 })
        }
        return undefined
      },
    })
    try {
      expect(screen.frame()).toContain("bun test provider")
      screen.input.pressKey("d", { ctrl: true })
      await screen.renderer.idle()
      await screen.renderOnce()
      const inactiveDeadline = Date.now() + 10_000
      while (!screen.frame().includes("bun test provider") && !screen.frame().includes("Message YCoding…") && Date.now() < inactiveDeadline)
        await new Promise<void>((resolve) => setImmediate(resolve))
      expect(kills).toEqual([])
      expect(screen.frame()).toContain("bun test provider")
      screen.input.pressKey("ESCAPE")
      await screen.renderer.idle()
      await screen.renderOnce()
      while (!screen.frame().includes("bun test provider") && !screen.frame().includes("Message YCoding…") && Date.now() < inactiveDeadline)
        await new Promise<void>((resolve) => setImmediate(resolve))
      expect(screen.frame()).toContain("bun test provider")
      expect(screen.frame()).not.toContain("Message YCoding…")
      screen.input.pressKey("k", { ctrl: true })
      const deadline = Date.now() + 10_000
      while (kills.length === 0 && Date.now() < deadline) await new Promise<void>((resolve) => setImmediate(resolve))
      expect(kills).toEqual([shellID])
      screen.input.pressKey("q")
      while (!screen.frame().includes("Message YCoding…") && Date.now() < deadline)
        await new Promise<void>((resolve) => setImmediate(resolve))
      expect(screen.frame()).toContain("Message YCoding…")
      expect(screen.frame()).not.toContain("bun test provider")
    } finally {
      await screen.dispose()
    }
  } finally {
    delete process.env.YCODING_ROUTE
  }
}, 30_000)
