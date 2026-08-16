/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@ycoding-ai/client"
import { SessionRowView } from "../src/routes/session/index"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { DEFAULT_THEMES } from "../src/theme/builtins"
import { resolveThemeFile } from "../src/theme/v2/resolve"
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
              <SessionRowView row={row} message={message} />
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

describe("transcript row residency", () => {
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
      messages: 42,
      tokens: { input: 1_000, output: 100, reasoning: 50, cache: { read: 40, write: 10 } },
      time: { created: 1 },
    }
    const app = await renderTranscript(
      { type: "message", messageID: message.id },
      (messageID) => (messageID === message.id ? message : undefined),
    )
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")

    expect(frame(app)).toContain("~ compacted · 42 messages → 1.2k tokens")
    expect(app.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("~ compacted"))?.fg.toInts()).toEqual(
      theme.text.hint.toInts(),
    )

    app.renderer.destroy()
  })
})
