/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@ycoding-ai/client"
import { SessionRowView } from "../src/routes/session/index"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

async function renderTranscript(
  row: Parameters<typeof SessionRowView>[0]["row"],
  message: Parameters<typeof SessionRowView>[0]["message"] = () => undefined,
) {
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <box flexDirection="column">
              <text>before</text>
              <SessionRowView row={row} message={message} history={() => {}} />
              <text>after</text>
            </box>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 72, height: 5 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("before"))
  return app
}

function frame(app: Awaited<ReturnType<typeof testRender>>) {
  return app
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
}

describe("transcript archive boundaries", () => {
  test("renders collapsed and expanded archived pages as distinct transcript boundaries", async () => {
    const collapsed = await renderTranscript({
      type: "history",
      placeholder: { sessionID: "ses_test", cursor: "page-1", state: "collapsed", count: 1000 },
    })
    const expanded = await renderTranscript({
      type: "history",
      placeholder: { sessionID: "ses_test", cursor: "page-1", state: "expanded", count: 1000 },
    })

    expect(frame(collapsed)).toContain("~ archived · 1,000 messages · ↑ load")
    expect(frame(expanded)).toContain("~ archived · 1,000 messages · ↑ hide")

    collapsed.renderer.destroy()
    expanded.renderer.destroy()
  })

  test("does not allocate a line for an unresolved transcript row", async () => {
    const app = await renderTranscript({ type: "message", messageID: "missing" })

    expect(frame(app)).toContain("before\nafter")

    app.renderer.destroy()
  })

  test("renders a completed compaction as a muted transcript marker", async () => {
    const message: Extract<SessionMessageInfo, { type: "compaction" }> = {
      id: "msg_compaction",
      type: "compaction",
      status: "completed",
      reason: "auto",
      summary: "",
      recent: "",
      time: { created: 1 },
    }
    const app = await renderTranscript(
      { type: "message", messageID: message.id },
      (messageID) => (messageID === message.id ? message : undefined),
    )

    expect(frame(app)).toContain("~ compacted")

    app.renderer.destroy()
  })
})
