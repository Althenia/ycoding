/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Show, createSignal } from "solid-js"
import { ClipboardProvider } from "../../../src/context/clipboard"
import type { FormWithLocation } from "../../../src/context/data"
import { ClientProvider } from "../../../src/context/client"
import { ThemeProvider } from "../../../src/context/theme"
import { Keymap } from "../../../src/context/keymap"
import { ConfigProvider } from "../../../src/config"
import { ToastProvider } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createApi, createEventStream, createFetch } from "../../fixture/tui-client"

async function mountForm(root: string, width = 80, bottomAnchored = false, escalated = false, extra?: Partial<FormWithLocation>, height = 20) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })

  const replies: unknown[] = []
  const copied: string[] = []
  const events = createEventStream()
  const transport = createFetch(
    (url, request) =>
      url.pathname === "/api/session/ses_test/form/frm_test/reply"
        ? request.json().then((answer) => {
            replies.push(answer)
            return new Response(null, { status: 204 })
          })
        : undefined,
    events,
  )
  const config = createTuiResolvedConfig()
  const form = {
    id: "frm_test",
    sessionID: "ses_test",
    title: "Authorization required",
    ...(escalated
      ? {
          coordinationEscalation: {
            reasons: [
              { sessionID: "ses_driver", reason: "The assignment leaves this choice open." },
              { sessionID: "ses_master", reason: "Choose the desired result." },
            ],
          },
        }
      : {}),
    fields: [
      {
        key: "authorization",
        type: "external",
        url: "https://example.com/authorize",
        title: "Authorize access",
      },
    ],
    ...extra,
  } satisfies FormWithLocation
  const [current, setCurrent] = createSignal(form)
  const { FormPrompt } = await import("../../../src/routes/session/form")

  function Harness() {
    return (
      <TestTuiContexts
        directory={root}
        paths={{
          home: root,
          state,
          worktree: root,
        }}
      >
        <ClipboardProvider
          value={{
            write(text) {
              copied.push(text)
              return Promise.resolve()
            },
          }}
        >
          <ConfigProvider config={config}>
            <Keymap.Provider>
              <ClientProvider api={createApi(transport.fetch)}>
                <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                  <ToastProvider>
                    <Show when={bottomAnchored} fallback={<FormPrompt form={current()} />}>
                      <box height="100%" flexDirection="column">
                        <box flexGrow={1} />
                        <FormPrompt form={current()} />
                        <text>Session footer</text>
                      </box>
                    </Show>
                  </ToastProvider>
                </ThemeProvider>
              </ClientProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </ClipboardProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width, height, kittyKeyboard: true })
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(height < 20 ? "enter" : "Authorization required"))
  return { app, copied, replies, assess: (assessment: FormWithLocation["assessment"]) => setCurrent(current => ({ ...current, assessment })) }
}

test("question grades name confidence and recommendations without selecting an answer", async () => {
  await using tmp = await tmpdir()
  const fields: FormWithLocation["fields"] = [{ key: "q0", type: "string", title: "Database", options: [
    { value: "SQLite", label: "SQLite" }, { value: "Postgres", label: "Postgres" },
  ] }]
  const assessment = { mode: "yolo" as const, sourceSessionID: "ses_test", fields: [{ key: "q0", status: "assessed" as const,
    reason: "Choose the local engine.", recommendation: ["SQLite"], grades: [
      { choice: "SQLite", confidence: 0.96, evidence: "Local storage fits." },
      { choice: "Postgres", confidence: 0.82, evidence: "Requires a server." },
    ],
  }] }
  const prompt = await mountForm(tmp.path, 100, false, false, { fields, assessment })
  try {
    expect(prompt.app.captureCharFrame()).toContain("Answers YOLO")
    expect(prompt.app.captureCharFrame()).toContain("source ses_test")
    expect(prompt.app.captureCharFrame()).toContain("Assessed")
    expect(prompt.app.captureCharFrame()).toContain("awaiting an authorized client decision")
    expect(prompt.app.captureCharFrame()).toContain("confidence 0.96")
    expect(prompt.app.captureCharFrame()).toContain("Local storage fits.")
    expect(prompt.app.captureCharFrame()).toContain("Recommended: SQLite")
    expect(prompt.app.captureCharFrame()).not.toContain("Allow")
    expect(prompt.replies).toEqual([])
    prompt.app.mockInput.pressKey("2")
    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ answer: { q0: "Postgres" } }])
  } finally {
    prompt.app.renderer.destroy()
  }
})

for (const [mode, status, label] of [["yolo", "pending", "Assessing options"], ["yolo", "unavailable", "Assessment unavailable"], ["manual", "not_assessed", "Not assessed"], ["auto", "not_assessed", "Not assessed"]] as const) test(`${mode} ${status} is literal warning status without fabricated grades or approval`, async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 100, false, false, {
    fields: [{ key: "q0", type: "string", options: [{ value: "a", label: "A" }] }],
    assessment: { mode, sourceSessionID: "ses_test", fields: [{ key: "q0", status, reason: "The reported assessment reason." }] },
  })
  try {
    expect(prompt.app.captureCharFrame()).toContain(label)
    expect(prompt.app.captureCharFrame()).toContain("The reported assessment reason.")
    expect(prompt.app.captureCharFrame()).not.toContain("confidence")
    expect(prompt.app.captureCharFrame()).not.toContain("Allow")
    expect(prompt.replies).toEqual([])
  } finally { prompt.app.renderer.destroy() }
})

test("long question grades keep short-terminal actions reachable and preserve a multiselect draft across live assessment", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 40, false, false, {
    fields: [{ key: "q0", type: "multiselect", title: "Database", options: [{ value: "SQLite", label: "SQLite" }, { value: "Postgres", label: "Postgres" }] }],
    assessment: { mode: "yolo", sourceSessionID: "ses_test", fields: [{ key: "q0", status: "pending", reason: "Assessing options." }] },
  }, 12)
  try {
    expect(prompt.app.captureCharFrame()).toContain("enter")
    prompt.app.mockInput.pressKey("2")
    prompt.assess({ mode: "yolo", sourceSessionID: "ses_test", fields: [{ key: "q0", status: "assessed", reason: "Choose compatible options.", recommendation: ["SQLite"], grades: [
      { choice: "SQLite", confidence: 0.96, evidence: "Local tradeoffs. ".repeat(25) },
      { choice: "Postgres", confidence: 0.82, evidence: "Server tradeoffs. ".repeat(25) },
    ] }] })
    await prompt.app.waitForFrame(frame => frame.includes("confidence 0.82"))
    expect(prompt.app.captureCharFrame()).toContain("enter")
    expect(prompt.replies).toEqual([])
    prompt.app.mockInput.pressKey("right")
    await prompt.app.waitForFrame(frame => frame.includes("Postgres"))
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ answer: { q0: ["Postgres"] } }])
  } finally { prompt.app.renderer.destroy() }
})

test("Project escalation reasons appear above the native form without choosing an answer", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 120, false, true)
  try {
    expect(prompt.app.captureCharFrame()).toContain("Project escalation")
    expect(prompt.app.captureCharFrame()).toContain("The assignment leaves this choice open.")
    expect(prompt.app.captureCharFrame()).toContain("Choose the desired result.")
    expect(prompt.replies).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("requires explicit acknowledgement before submitting an external field", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path)
  try {
    prompt.app.mockInput.pressKey("right")
    await prompt.app.waitForFrame((frame) => frame.includes("(acknowledgement required)"))
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("External action must be acknowledged"))
    expect(prompt.replies).toEqual([])

    prompt.app.mockInput.pressKey("left")
    prompt.app.mockInput.pressKey("c")
    await prompt.app.waitForFrame((frame) => frame.includes("press enter to confirm"))
    expect(prompt.copied).toEqual(["https://example.com/authorize"])
    expect(prompt.replies).toEqual([])

    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("Acknowledged"))
    expect(prompt.replies).toEqual([])

    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ answer: { authorization: true } }])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("includes external acknowledgements in progress", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 32)
  try {
    expect(prompt.app.captureCharFrame()).toContain("0/1")
    expect(prompt.replies).toEqual([])
  } finally {
    prompt.app.renderer.destroy()
  }
})

const formBorderRows = (frame: string) => frame.split("\n").filter((line) => line.includes("┃")).length

test("a short single-choice form is content-sized on a tall terminal and still submits by key", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, true, false, {
    fields: [{ key: "q0", type: "string", title: "Pick one", options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] }],
  }, 40)
  try {
    const lines = prompt.app.captureCharFrame().split("\n")
    expect(formBorderRows(prompt.app.captureCharFrame())).toBeLessThanOrEqual(12)
    expect(lines[0]).not.toContain("┃")
    expect(prompt.app.captureCharFrame()).toContain("Alpha")
    expect(prompt.app.captureCharFrame()).toContain("enter")
    prompt.app.mockInput.pressKey("2")
    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ answer: { q0: "b" } }])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("a long multiselect form is viewport-bounded, reveals the keyboard-selected option and submits from Confirm", async () => {
  await using tmp = await tmpdir()
  const options = Array.from({ length: 12 }, (_, i) => ({
    value: `v${i}`,
    label: `Option ${i + 1}`,
    description: `Description for option ${i + 1} with some extra words`,
  }))
  const prompt = await mountForm(tmp.path, 80, true, false, {
    fields: [{ key: "q0", type: "multiselect", title: "Pick many", options }],
  }, 24)
  try {
    expect(formBorderRows(prompt.app.captureCharFrame())).toBeLessThanOrEqual(15)
    expect(
      prompt.app
        .captureCharFrame()
        .split("\n")
        .find((line) => line.includes("enter")),
    ).toContain("esc")
    expect(prompt.app.captureCharFrame().split("\n")[0]).not.toContain("┃")
    expect(prompt.app.captureCharFrame()).toContain("enter")
    expect(prompt.app.captureCharFrame()).not.toContain("Option 12")
    for (let i = 0; i < 11; i++) prompt.app.mockInput.pressKey("j")
    await prompt.app.waitForFrame((frame) => frame.includes("Option 12"))
    expect(prompt.app.captureCharFrame()).toContain("enter")
    prompt.app.mockInput.pressEnter()
    prompt.app.mockInput.pressKey("right")
    await prompt.app.waitForFrame((frame) => frame.includes("Review"))
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ answer: { q0: ["v11"] } }])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("a free-text form stays bounded and answerable after a narrow short resize", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, true, false, {
    fields: [{ key: "name", type: "string", title: "Your name" }],
  }, 24)
  try {
    prompt.app.renderer.resize(40, 12)
    await prompt.app.waitForFrame((frame) => frame.includes("Your name") && frame.includes("enter"))
    expect(formBorderRows(prompt.app.captureCharFrame())).toBeLessThanOrEqual(7)
    expect(
      prompt.app
        .captureCharFrame()
        .split("\n")
        .find((line) => line.includes("enter")),
    ).toContain("esc")
    await prompt.app.mockInput.typeText("Ada")
    await prompt.app.waitForFrame((frame) => frame.includes("Ada"))
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("Review"))
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ answer: { name: "Ada" } }])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("a multiline free-text editor shows its last line at 40x12 and submits the complete value through Review", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 40, true, false, {
    fields: [{ key: "notes", type: "string", title: "Notes" }],
  }, 12)
  try {
    const value = "line1\nline2\nline3\nline4\nline5\nline6"
    await prompt.app.mockInput.pasteBracketedText(value)
    await prompt.app.waitForFrame((frame) => frame.includes("line6"))
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitForFrame((frame) => frame.includes("Review"))
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ answer: { notes: value } }])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("a multiline custom answer shows its last line at 40x12 and submits the complete value", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 40, true, false, {
    fields: [{ key: "q0", type: "string", title: "Pick one", custom: true, options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] }],
  }, 12)
  try {
    prompt.app.mockInput.pressKey("3")
    await prompt.app.waitForFrame((frame) => frame.includes("Type your own answer"))
    const value = "line1\nline2\nline3\nline4\nline5\nline6"
    await prompt.app.mockInput.pasteBracketedText(value)
    await prompt.app.waitForFrame((frame) => frame.includes("line6"))
    prompt.app.mockInput.pressEnter()
    await prompt.app.waitFor(() => prompt.replies.length === 1)
    expect(prompt.replies).toEqual([{ answer: { q0: value } }])
  } finally {
    prompt.app.renderer.destroy()
  }
})

test("keeps a form surface immediately above the session footer", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, true)
  try {
    const lines = prompt.app.captureCharFrame().split("\n")
    const footer = lines.findIndex((line) => line.includes("Session footer"))

    expect(footer).toBe(19)
    // The form surface is a SplitBorder, whose vertical glyph is the heavy "┃" rather than "│".
    expect(lines[footer - 1]).toContain("┃")
  } finally {
    prompt.app.renderer.destroy()
  }
})
