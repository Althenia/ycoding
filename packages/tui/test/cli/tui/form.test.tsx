/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createSignal, Show } from "solid-js"
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
import { formKey } from "../../../src/util/form"

async function mountForm(
  root: string,
  width = 80,
  bottomAnchored = false,
  pending?: {
    form: FormWithLocation
    respond: (url: URL, request: Request) => Promise<Response> | undefined
  },
) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })

  const replies: unknown[] = []
  const copied: string[] = []
  const events = createEventStream()
  const transport = createFetch(
    (url, request) =>
      pending
        ? pending.respond(url, request)
        : url.pathname === "/api/session/ses_test/form/frm_test/reply"
          ? request.json().then((answer) => {
              replies.push(answer)
              return new Response(null, { status: 204 })
            })
          : undefined,
    events,
  )
  const config = createTuiResolvedConfig()
  const api = createApi(transport.fetch)
  const [form, setForm] = createSignal<FormWithLocation>(
    pending?.form ?? {
      id: "frm_test",
      sessionID: "ses_test",
      title: "Authorization required",
      fields: [
        {
          key: "authorization",
          type: "external",
          url: "https://example.com/authorize",
          title: "Authorize access",
        },
      ],
    },
  )
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
              <ClientProvider api={api}>
                <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                  <ToastProvider>
                    <Show
                      when={bottomAnchored}
                      fallback={
                        <Show when={formKey(form())} keyed>
                          {(_) => {
                            const current = form()
                            return <FormPrompt form={current} />
                          }}
                        </Show>
                      }
                    >
                      <box height="100%" flexDirection="column">
                        <box flexGrow={1} />
                        <FormPrompt form={form()} />
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

  const app = await testRender(() => <Harness />, { width, height: 20, kittyKeyboard: true })
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(form().title))
  return { app, copied, replies, setForm, api }
}

test("same-ID global Forms from different Locations mount their own answer state", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountForm(tmp.path, 80, false, {
    form: {
      id: "frm_shared",
      sessionID: "global",
      title: "First Location",
      location: { directory: "/one" },
      fields: [{ key: "draft", type: "string", default: "first answer" }],
    },
    respond: () => undefined,
  })
  try {
    await prompt.app.waitForFrame((frame) => frame.includes("first answer"))
    prompt.setForm({
      id: "frm_shared",
      sessionID: "global",
      title: "Second Location",
      location: { directory: "/two" },
      fields: [{ key: "draft", type: "string", default: "second answer" }],
    })
    await prompt.app.waitForFrame((frame) => frame.includes("Second Location") && frame.includes("second answer"))
    expect(prompt.app.captureCharFrame()).not.toContain("first answer")
  } finally {
    prompt.app.renderer.destroy()
  }
})

test.each(["reply", "cancel"] as const)(
  "an uncertain global Form %s preserves a newer rendered answer draft",
  async (mutation) => {
    await using tmp = await tmpdir()
    const sent = Promise.withResolvers<void>()
    const response = Promise.withResolvers<Response>()
    let requests = 0
    const prompt = await mountForm(tmp.path, 80, false, {
      form: {
        id: "frm_old",
        sessionID: "global",
        location: { directory: "/selected" },
        title: "Old global Form",
        fields: [{ key: "ok", type: mutation === "reply" ? "boolean" : "string" }],
      },
      respond(url) {
        if (!url.pathname.endsWith(`/${mutation}`)) return
        requests++
        sent.resolve()
        return response.promise
      },
    })
    try {
      if (mutation === "reply") prompt.app.mockInput.pressEnter()
      else prompt.app.mockInput.pressEscape()
      await sent.promise
      prompt.setForm({
        id: "frm_new",
        sessionID: "global",
        location: { directory: "/selected" },
        title: "New global Form",
        fields: [{ key: "draft", type: "string" }],
      })
      await prompt.app.waitForFrame((frame) => frame.includes("New global Form"))
      await prompt.app.mockInput.typeText("keep newer draft")
      await prompt.app.waitForFrame((frame) => frame.includes("keep newer draft"))
      await prompt.api.transport.reconnect()
      expect(prompt.app.captureCharFrame()).toContain("keep newer draft")
      expect(requests).toBe(1)
    } finally {
      response.resolve(new Response(null, { status: 204 }))
      prompt.app.renderer.destroy()
    }
  },
)

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
