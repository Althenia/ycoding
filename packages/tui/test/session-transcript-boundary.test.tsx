/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@ycoding-ai/client"
import type { DataSessionCompactionLifecycle } from "../src/context/data"
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
  compaction: NonNullable<Parameters<typeof SessionRowView>[0]["compaction"]> = () => undefined,
) {
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <box flexDirection="column">
              <text>before</text>
              <SessionRowView row={row} message={message} compaction={compaction} />
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

  test("renders a decode-only historical V1 compaction marker", async () => {
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
    const app = await renderTranscript({ type: "message", messageID: message.id }, (messageID) =>
      messageID === message.id ? message : undefined,
    )
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")

    expect(frame(app)).toContain("~ compacted · 42 messages → 1.2k tokens")
    expect(
      app
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text.includes("~ compacted"))
        ?.fg.toInts(),
    ).toEqual(theme.text.hint.toInts())

    app.renderer.destroy()
  })

  test("renders sanitized V2 compaction lifecycle labels", async () => {
    const lifecycles = [
      {
        jobID: "cmp_queued_provisional",
        status: "pending",
        time: { created: 0 },
      },
      {
        jobID: "cmp_running_provisional",
        status: "running",
        time: { created: 0 },
      },
      {
        jobID: "cmp_queued",
        messageID: "msg_compaction_queued",
        trigger: "advised",
        admissionMode: "background",
        status: "pending",
        time: { created: 1 },
      },
      {
        jobID: "cmp_running",
        messageID: "msg_compaction_running",
        trigger: "advised",
        admissionMode: "background",
        status: "running",
        time: { created: 2 },
      },
      {
        jobID: "cmp_completed",
        messageID: "msg_compaction_completed",
        trigger: "advised",
        admissionMode: "background",
        status: "completed",
        revision: 1,
        boundary: { messageID: "msg_boundary", seq: 9 },
        metrics: { excludedMessages: 42, excludedParts: 7, inputTokens: 121_000, retainedTokens: 68_000 },
        time: { created: 3 },
      },
      {
        jobID: "cmp_failed",
        messageID: "msg_compaction_failed",
        trigger: "mandatory",
        admissionMode: "mandatory",
        status: "failed",
        code: "context_limit_unresolved",
        error: {
          type: "context_limit_unresolved",
          message: "resp_private encrypted_content must not render",
        },
        time: { created: 4 },
      },
    ] satisfies DataSessionCompactionLifecycle[]
    const labels = [
      "~ compaction queued",
      "~ compacting",
      "~ compaction queued · background",
      "~ compacting · advised · background",
      "~ compacted · 42 items excluded · 121k → 68k tokens",
      "~ compaction failed · context_limit_unresolved",
    ]

    for (const [index, lifecycle] of lifecycles.entries()) {
      const app = await renderTranscript(
        { type: "compaction", jobID: lifecycle.jobID },
        () => undefined,
        (jobID) => (jobID === lifecycle.jobID ? lifecycle : undefined),
      )

      try {
        expect(frame(app)).toContain(labels[index])
        if (index < 2) {
          expect(frame(app)).not.toContain("background")
          expect(frame(app)).not.toContain("advised")
        }
        expect(frame(app)).not.toContain("resp_")
        expect(frame(app)).not.toContain("encrypted_content")
      } finally {
        app.renderer.destroy()
      }
    }
  })
})
