/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { SessionOrchestrationTask } from "@ycoding-ai/client"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { ClipboardProvider } from "../src/context/clipboard"
import { DataProvider } from "../src/context/data"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { SubagentAnswerComposer } from "../src/routes/session/subagent-blocked"
import { DialogProvider } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { createApi, createEventStream, createFetch, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const task: SessionOrchestrationTask = {
  parentID: "ses_parent",
  sessionID: "ses_child",
  agent: "general",
  description: "Boundary check",
  model: { providerID: "openai", id: "gpt-6.1-sol" },
  background: true,
  state: "waiting",
  question: { id: "qst_open", text: "Continue?", time: 1 },
  revision: 1,
  time: { created: 1, updated: 1 },
}

async function mount(input?: { gate?: Promise<void>; fail?: boolean; refreshFails?: boolean }) {
  const [current, update] = createSignal(task)
  const writes: { path: string; body: unknown }[] = []
  const events = createEventStream()
  const transport = createFetch(async (url, request) => {
    if (request.method !== "GET") {
      writes.push({ path: url.pathname, body: await request.json() })
      await input?.gate
      return input?.fail
        ? json({ message: "Rejected answer" }, { status: 500 })
        : json({ data: { ...task, state: "running", question: undefined } })
    }
    if (url.pathname === "/api/session/ses_parent/subagent")
      return input?.refreshFails
        ? json({ message: "Refresh unavailable" }, { status: 400 })
        : json({ data: [], summary: { total: 0, active: 0, waiting: 0, running: 0 }, cursor: {} })
    return undefined
  }, events)
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ClipboardProvider value={{}}>
              <ClientProvider api={createApi(transport.fetch)}>
                <DataProvider>
                  <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                    <ToastProvider>
                      <DialogProvider>
                        <SubagentAnswerComposer task={current()} />
                      </DialogProvider>
                    </ToastProvider>
                  </ThemeProvider>
                </DataProvider>
              </ClientProvider>
            </ClipboardProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 10, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Enter answer"))
  return {
    app,
    writes,
    update,
    dispose() {
      app.renderer.destroy()
      events.disconnect()
    },
  }
}

test.each(["/goal new objective", "/yolo 3", "quit", "!echo literal"])(
  "answers %s as literal text, not a command",
  async (text) => {
    const fixture = await mount()
    try {
      await fixture.app.mockInput.typeText(text)
      fixture.app.mockInput.pressKey("RETURN")
      await fixture.app.waitForFrame((frame) => frame.includes("Answer sent"))
      expect(fixture.writes).toEqual([
        { path: "/api/session/ses_parent/subagent/ses_child/question/qst_open/answer", body: { text } },
      ])
      expect(fixture.app.captureCharFrame()).not.toContain(text)
    } finally {
      fixture.dispose()
    }
  },
)

test("blank answers do nothing and bracketed multiline Unicode paste remains literal", async () => {
  const fixture = await mount()
  try {
    fixture.app.mockInput.pressKey("RETURN")
    await fixture.app.renderOnce()
    expect(fixture.writes).toEqual([])
    const text = "réponse 安全\n/goal stays literal"
    await fixture.app.mockInput.pasteBracketedText(text)
    await fixture.app.waitForFrame((frame) => frame.includes("/goal stays literal"))
    expect(fixture.writes).toEqual([])
    fixture.app.mockInput.pressKey("RETURN")
    await fixture.app.waitForFrame((frame) => frame.includes("Answer sent"))
    expect(fixture.writes[0]?.body).toEqual({ text })
  } finally {
    fixture.dispose()
  }
})

test.each(["changed", "resolved"])("a %s question cannot receive the retained draft", async (state) => {
  const fixture = await mount()
  try {
    await fixture.app.mockInput.typeText("Retain this draft")
    fixture.update(
      state === "resolved"
        ? { ...task, state: "running", question: undefined }
        : { ...task, question: { id: "qst_new", text: "Another question", time: 2 } },
    )
    fixture.app.mockInput.pressKey("RETURN")
    await fixture.app.waitForFrame((frame) => frame.includes("Question changed or resolved"))
    expect(fixture.writes).toEqual([])
    expect(fixture.app.captureCharFrame()).toContain("Retain this draft")
  } finally {
    fixture.dispose()
  }
})

test("failed transport preserves the draft and explicit retry submits the same owned question", async () => {
  const options = { fail: true }
  const fixture = await mount(options)
  try {
    await fixture.app.mockInput.typeText("Retry this draft")
    fixture.app.mockInput.pressKey("RETURN")
    await fixture.app.waitForFrame((frame) => frame.includes("Answer not sent"))
    expect(fixture.app.captureCharFrame()).toContain("Retry this draft")
    expect(fixture.writes).toHaveLength(1)
    options.fail = false
    fixture.app.mockInput.pressKey("RETURN")
    await fixture.app.waitForFrame((frame) => frame.includes("Answer sent"))
    expect(fixture.writes).toHaveLength(2)
    expect(fixture.writes[1]).toEqual(fixture.writes[0])
    expect(fixture.app.captureCharFrame()).not.toContain("Retry this draft")
  } finally {
    fixture.dispose()
  }
})

test("duplicate Enter coalesces in flight and settlement does not clear a newer draft or resend", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const fixture = await mount({ gate, refreshFails: true })
  try {
    await fixture.app.mockInput.typeText("First answer")
    fixture.app.mockInput.pressKey("RETURN")
    await fixture.app.waitForFrame((frame) => frame.includes("Sending answer"))
    await fixture.app.mockInput.typeText(" with an unsent edit")
    fixture.app.mockInput.pressKey("RETURN")
    await fixture.app.waitForFrame((frame) => frame.includes("First answer with an unsent edit"))
    expect(fixture.writes).toHaveLength(1)
    release()
    await fixture.app.waitForFrame((frame) => frame.includes("Answer sent · refresh failed"))
    expect(fixture.app.captureCharFrame()).toContain("First answer with an unsent edit")
    fixture.app.mockInput.pressKey("RETURN")
    await fixture.app.renderOnce()
    expect(fixture.writes).toEqual([
      { path: "/api/session/ses_parent/subagent/ses_child/question/qst_open/answer", body: { text: "First answer" } },
    ])
  } finally {
    release()
    fixture.dispose()
  }
})
