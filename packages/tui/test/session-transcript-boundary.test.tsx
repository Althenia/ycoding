/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@ycoding-ai/client"
import { SessionRowView } from "../src/routes/session/index"
import { messageHistoryPlaceholders } from "../src/context/data"
import { groupHistoryRows, historyTogglePlaceholder } from "../src/routes/session/rows"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { DEFAULT_THEMES } from "../src/theme/builtins"
import { resolveThemeFile } from "../src/theme/v2/resolve"

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

function colorFor(app: Awaited<ReturnType<typeof testRender>>, label: string) {
  return app.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes(label))?.fg.toInts()
}

function compactionLine(app: Awaited<ReturnType<typeof testRender>>) {
  return frame(app)
    .split("\n")
    .find((line) => line.includes("~ compacted"))
    ?.trim()
}

describe("transcript archive boundaries", () => {
  test("renders collapsed and expanded archived pages as distinct transcript boundaries", async () => {
    const collapsed = await renderTranscript({
      type: "history",
      placeholders: [{ sessionID: "ses_test", cursor: "page-1", state: "collapsed", count: 1000 }],
    })
    const expanded = await renderTranscript({
      type: "history",
      placeholders: [{ sessionID: "ses_test", cursor: "page-1", state: "expanded", count: 1000 }],
    })
    const failed = await renderTranscript({
      type: "history",
      placeholders: [{ sessionID: "ses_test", cursor: "page-1", state: "error" }],
    })

    expect(frame(collapsed)).toContain("~ archived · 1,000 messages · ⌃x ↑ load")
    expect(frame(expanded)).toContain("~ archived · 1,000 messages · ⌃x ↑ hide")
    expect(frame(failed)).toContain("~ archived · ⌃x ↑ retry")

    collapsed.renderer.destroy()
    expanded.renderer.destroy()
    failed.renderer.destroy()
  })

  test("renders an archived transcript marker with the hint token", async () => {
    const app = await renderTranscript({
      type: "history",
      placeholders: [{ sessionID: "ses_test", cursor: "page-1", state: "collapsed", count: 1000 }],
    })
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")

    expect(colorFor(app, "~ archived")).toEqual(theme.text.hint.toInts())

    app.renderer.destroy()
  })

  test("omits unavailable archive page metadata without an empty segment", async () => {
    const app = await renderTranscript({
      type: "history",
      placeholders: [{ sessionID: "ses_test", cursor: "page-1", state: "collapsed", count: 1000 }],
    })

    expect(frame(app)).not.toContain("pages")
    expect(frame(app)).not.toContain("·  ·")

    app.renderer.destroy()
  })

  test("renders each archive marker's tracked page ordinal without fabricating a multi-page range", async () => {
    const trackedPages = [
      { sessionID: "ses_test", cursor: "first", oldestID: "msg_1", newestID: "msg_400", count: 400, state: "collapsed" as const },
      { sessionID: "ses_test", cursor: "second", oldestID: "msg_401", newestID: "msg_800", count: 400, state: "collapsed" as const },
      { sessionID: "ses_test", cursor: "third", oldestID: "msg_801", newestID: "msg_1204", count: 404, state: "collapsed" as const },
    ]
    const placeholders = messageHistoryPlaceholders(trackedPages)
    const placeholder = placeholders[2]
    const expectedPage = trackedPages.findIndex((page) => page.cursor === placeholder.cursor) + 1
    const app = await renderTranscript({ type: "history", placeholders: [placeholder] })
    const output = frame(app)

    expect(placeholders).toHaveLength(trackedPages.length)
    expect(placeholder.pages).toEqual({ start: expectedPage, end: expectedPage })
    expect(output).toContain(`~ archived · page ${expectedPage} · 404 messages · ⌃x ↑ load`)
    expect(output).not.toContain("pages ")

    app.renderer.destroy()
  })

  test("renders a single tracked archive page without a degenerate range", async () => {
    const placeholder = messageHistoryPlaceholders([
      { sessionID: "ses_test", cursor: "first", oldestID: "msg_1", newestID: "msg_400", count: 400, state: "collapsed" },
    ])[0]
    const app = await renderTranscript({ type: "history", placeholders: [placeholder] })

    expect(frame(app)).toContain("~ archived · page 1 · 400 messages · ⌃x ↑ load")
    expect(frame(app)).not.toContain("pages 1–1")

    app.renderer.destroy()
  })

  test("renders consecutive collapsed archive placeholders as one page-range marker with their complete total", async () => {
    const placeholders = messageHistoryPlaceholders([
      { sessionID: "ses_test", cursor: "first", oldestID: "msg_1", newestID: "msg_400", count: 400, state: "collapsed" },
      { sessionID: "ses_test", cursor: "second", oldestID: "msg_401", newestID: "msg_800", count: 400, state: "collapsed" },
      { sessionID: "ses_test", cursor: "third", oldestID: "msg_801", newestID: "msg_1204", count: 404, state: "collapsed" },
    ])
    const rows = groupHistoryRows(placeholders)
    const app = await renderTranscript(rows[0])

    expect(rows).toHaveLength(1)
    expect(frame(app)).toContain("~ archived · pages 1–3 · 1,204 messages · ⌃x ↑ load")

    app.renderer.destroy()
  })

  test("omits a grouped archive total when any collapsed placeholder count is unknown", async () => {
    const placeholders = messageHistoryPlaceholders([
      { sessionID: "ses_test", cursor: "first", oldestID: "msg_1", newestID: "msg_400", count: 400, state: "collapsed" },
      { sessionID: "ses_test", cursor: "second", state: "collapsed" },
    ])
    const app = await renderTranscript(groupHistoryRows(placeholders)[0])

    expect(frame(app)).toContain("~ archived · ⌃x ↑ load")
    expect(frame(app)).not.toContain("400 messages")

    app.renderer.destroy()
  })

  test("excludes an expanded archive page from collapsed ranges and retains its own marker", async () => {
    const placeholders = messageHistoryPlaceholders([
      { sessionID: "ses_test", cursor: "first", oldestID: "msg_1", newestID: "msg_400", count: 400, state: "collapsed" },
      { sessionID: "ses_test", cursor: "second", oldestID: "msg_401", newestID: "msg_800", count: 400, state: "expanded" },
      { sessionID: "ses_test", cursor: "third", oldestID: "msg_801", newestID: "msg_1200", count: 400, state: "collapsed" },
    ])
    const rows = groupHistoryRows(placeholders)
    const app = await renderTranscript(rows[1])

    expect(rows).toHaveLength(3)
    expect(frame(app)).toContain("~ archived · page 2 · 400 messages · ⌃x ↑ hide")

    app.renderer.destroy()
  })

  test("activates only the first collapsed page represented by a grouped archive row", () => {
    const rows = groupHistoryRows(
      messageHistoryPlaceholders([
        { sessionID: "ses_test", cursor: "first", oldestID: "msg_1", newestID: "msg_400", count: 400, state: "collapsed" },
        { sessionID: "ses_test", cursor: "second", oldestID: "msg_401", newestID: "msg_800", count: 400, state: "collapsed" },
        { sessionID: "ses_test", cursor: "third", oldestID: "msg_801", newestID: "msg_1200", count: 400, state: "collapsed" },
      ]),
    )

    expect(rows).toHaveLength(1)
    expect(historyTogglePlaceholder(rows[0])).toMatchObject({ cursor: "first" })
  })

  test("omits the page segment and its separator when no tracked page records are available", async () => {
    const placeholder = messageHistoryPlaceholders([
      { sessionID: "ses_test", cursor: "unknown", state: "collapsed", count: 400 },
    ])[0]
    const app = await renderTranscript({ type: "history", placeholders: [placeholder] })

    expect(frame(app)).toContain("~ archived · 400 messages · ⌃x ↑ load")
    expect(frame(app)).not.toContain("page ")
    expect(frame(app)).not.toContain("·  ·")

    app.renderer.destroy()
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
    expect(frame(app)).not.toContain("→")

    app.renderer.destroy()
  })

  test("renders available completed-compaction metrics without fabricating missing ones", async () => {
    const base = {
      type: "compaction" as const,
      status: "completed" as const,
      reason: "auto" as const,
      summary: "",
      recent: "",
      time: { created: 1 },
    }
    const both: Extract<SessionMessageInfo, { type: "compaction" }> = {
      ...base,
      id: "msg_compaction_both",
      messages: 42,
      tokens: { input: 1_000, output: 100, reasoning: 50, cache: { read: 40, write: 10 } },
    }
    const messagesOnly: Extract<SessionMessageInfo, { type: "compaction" }> = {
      ...base,
      id: "msg_compaction_messages",
      messages: 42,
    }
    const tokensOnly: Extract<SessionMessageInfo, { type: "compaction" }> = {
      ...base,
      id: "msg_compaction_tokens",
      tokens: { input: 1_000, output: 100, reasoning: 50, cache: { read: 40, write: 10 } },
    }
    const neither: Extract<SessionMessageInfo, { type: "compaction" }> = { ...base, id: "msg_compaction_neither" }
    const render = (message: Extract<SessionMessageInfo, { type: "compaction" }>) =>
      renderTranscript(
        { type: "message", messageID: message.id },
        (messageID) => (messageID === message.id ? message : undefined),
      )
    const bothApp = await render(both)
    const messagesOnlyApp = await render(messagesOnly)
    const tokensOnlyApp = await render(tokensOnly)
    const neitherApp = await render(neither)

    expect(compactionLine(bothApp)).toContain("~ compacted · 42 messages → 1.2k tokens")
    expect(compactionLine(messagesOnlyApp)).toContain("~ compacted · 42 messages")
    expect(compactionLine(messagesOnlyApp)).not.toContain("→")
    expect(compactionLine(tokensOnlyApp)).toContain("~ compacted → 1.2k tokens")
    expect(compactionLine(tokensOnlyApp)).not.toContain("messages")
    expect(compactionLine(neitherApp)).toContain("~ compacted")
    expect(compactionLine(neitherApp)).not.toContain("·")
    expect(compactionLine(neitherApp)).not.toContain("→")

    bothApp.renderer.destroy()
    messagesOnlyApp.renderer.destroy()
    tokensOnlyApp.renderer.destroy()
    neitherApp.renderer.destroy()
  })

  test("renders non-failed compaction with the hint token and failed compaction in error red", async () => {
    const completed: Extract<SessionMessageInfo, { type: "compaction" }> = {
      id: "msg_compaction_completed",
      type: "compaction",
      status: "completed",
      reason: "auto",
      summary: "",
      recent: "",
      time: { created: 1 },
    }
    const failed: Extract<SessionMessageInfo, { type: "compaction" }> = {
      id: "msg_compaction_failed",
      type: "compaction",
      status: "failed",
      reason: "auto",
      error: { type: "unknown", message: "" },
      time: { created: 1 },
    }
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
    const completedApp = await renderTranscript(
      { type: "message", messageID: completed.id },
      (messageID) => (messageID === completed.id ? completed : undefined),
    )
    const failedApp = await renderTranscript(
      { type: "message", messageID: failed.id },
      (messageID) => (messageID === failed.id ? failed : undefined),
    )

    expect(colorFor(completedApp, "~ compacted")).toEqual(theme.text.hint.toInts())
    expect(colorFor(failedApp, "Compaction")).toEqual(theme.text.feedback.error.default.toInts())
    expect(frame(failedApp)).toContain("Compaction")
    expect(frame(failedApp)).not.toContain("→")

    completedApp.renderer.destroy()
    failedApp.renderer.destroy()
  })
})
