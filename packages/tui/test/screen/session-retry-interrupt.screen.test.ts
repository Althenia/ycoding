import { expect, test } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import type { YCodingEvent } from "@ycoding-ai/client"
import { directory as defaultDirectory, json, sessionSnapshot } from "../fixture/tui-client"
import { DESIGN_VIEWPORT } from "../viewport"
import { renderScreen } from "./harness"

const sessionID = "ses_retry_interrupt"
const directory = `${process.env.HOME}/Workspace/Personal/YCoding`
const location = { directory, project: { id: "project", directory } }
const session = {
  id: sessionID,
  title: "Retry interrupt",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 4 },
}

/**
 * A step interrupted during provider retry backoff keeps its assistant row open until the next
 * prompt, because the retry attempt already published `Step.Started`. Reading that open row as
 * activity pinned the header at "cooking" for a Session that had already settled.
 */
test("an interrupt during provider retry sends once and keeps the draft editable until settlement", async () => {
  const interrupts: string[] = []
  const requested = Promise.withResolvers<void>()
  const retried = Promise.withResolvers<void>()
  const release = Promise.withResolvers<Response>()
  let sessionStatus = () => "idle"
  const screen = await renderScreen({
    ...DESIGN_VIEWPORT,
    args: { sessionID },
    settle: "retry",
    sessionReady: true,
    data: (value) => { sessionStatus = () => value.session.status(sessionID) },
    route: (url, request) => {
      if (url.pathname === `/api/session/${sessionID}/interrupt` && request.method === "POST") {
        interrupts.push(sessionID)
        if (interrupts.length === 2) {
          retried.resolve()
          return release.promise
        }
        requested.resolve()
        return json({ _tag: "InvalidRequestError", message: "Interrupt unavailable", field: "sessionID" }, { status: 400 })
      }
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === "/api/session/active") return json({ data: { [sessionID]: {} } })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/snapshot`)
        return sessionSnapshot(sessionID, [
            { id: "msg_user", type: "user", text: "Retry then interrupt.", time: { created: 1 } },
            {
              id: "msg_assistant",
              type: "assistant",
              agent: "build",
              model: { providerID: "anthropic", id: "claude-opus-5" },
              content: [],
              retry: { attempt: 2, at: Date.now() + 30_000, error: { type: "provider.transport", message: "Provider unavailable" } },
              time: { created: 2 },
            },
          ], { session })
      if (url.pathname === `/api/session/${sessionID}/pending`) return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/permission`) return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/subagent`) return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
      if (url.pathname === `/api/session/${sessionID}/todo`) return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/skills`) return json({ data: [] })
      if (url.pathname === "/path")
        return json({ home: process.env.HOME, state: "", config: "", worktree: defaultDirectory, directory })
      return undefined
    },
  })

  try {
    expect(screen.lines()[1]).toContain("retry")
    await screen.waitForEventStream()
    const execution = async (seq: number, active: boolean) => {
      screen.events.emit({
        id: `evt_retry_${seq}`,
        created: seq + 3,
        type: active ? "session.execution.started" : "session.execution.interrupted",
        durable: { aggregateID: sessionID, seq, version: 1 },
        location: { directory },
        data: active ? { sessionID } : { sessionID, reason: "user" },
      } as YCodingEvent)
      const expected = active ? "running" : "idle"
      const deadline = Date.now() + 2_000
      while (sessionStatus() !== expected && Date.now() < deadline) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        await screen.renderOnce()
      }
      expect(sessionStatus()).toBe(expected)
    }
    await execution(1, true)
    expect(screen.renderer.currentFocusedEditor).not.toBeNull()
    const pressEscape = () => new Promise<void>((resolve, reject) => {
      const observe = (key: KeyEvent) => {
        if (key.name !== "escape") return
        clearTimeout(timeout)
        screen.renderer.keyInput.off("keypress", observe)
        resolve()
      }
      const timeout = setTimeout(() => {
        screen.renderer.keyInput.off("keypress", observe)
        reject(new Error("The terminal did not decode Escape"))
      }, 2000)
      screen.renderer.keyInput.prependListener("keypress", observe)
      screen.input.pressEscape()
    })
    await pressEscape()
    expect(interrupts).toEqual([])
    await pressEscape()
    const waitForInterrupt = async (request: Promise<void>) => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          request,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Escape did not send a Session interrupt")), 2000)
          }),
        ])
      } finally {
        clearTimeout(timeout)
      }
    }
    await waitForInterrupt(requested.promise)
    expect(interrupts).toEqual([sessionID])
    const failed = Date.now() + 2_000
    while (!screen.frame().includes("Failed to interrupt") && Date.now() < failed) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      await screen.renderOnce()
    }
    expect(screen.frame()).toContain("Failed to interrupt")
    expect(sessionStatus()).toBe("running")
    await pressEscape()
    await execution(2, false)
    await execution(3, true)
    await pressEscape()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(interrupts).toEqual([sessionID])
    await pressEscape()
    await waitForInterrupt(retried.promise)
    expect(interrupts).toEqual([sessionID, sessionID])
    await pressEscape()
    await pressEscape()
    await screen.input.typeText("Draft during interrupt")
    await screen.renderOnce()
    expect(screen.frame()).toContain("Draft during interrupt")
    expect(screen.frame()).toContain("Interrupt requested")
    const deadlineWarning = Date.now() + 6_000
    while (!screen.frame().includes("No reply within 5 seconds") && Date.now() < deadlineWarning) {
      await Bun.sleep(20)
    }
    expect(screen.frame()).toContain("No reply within 5 seconds")
    expect(screen.frame()).toContain("Draft during interrupt")
    expect(interrupts).toEqual([sessionID, sessionID])
    expect(sessionStatus()).toBe("running")
    release.resolve(json({ data: {} }))
    await execution(4, false)

    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const header = screen.lines()[1] ?? ""
      if (header.includes("ready")) break
      await Bun.sleep(20)
    }

    const header = screen.lines()[1] ?? ""
    expect(header).not.toContain("cooking")
    expect(header).toContain("ready")
    expect(screen.frame()).toContain("Draft during interrupt")
  } finally {
    release.resolve(json({ data: {} }))
    await screen.dispose()
  }
}, 60_000)
