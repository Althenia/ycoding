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
  compactions: NonNullable<Parameters<typeof SessionRowView>[0]["compactions"]> = () => [],
) {
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <box flexDirection="column">
              <text>before</text>
              <SessionRowView row={row} message={message} compaction={compaction} compactions={compactions} />
              <text>after</text>
            </box>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 72, height: 12 },
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
  test("does not render a completed duplicate Skill tool part", async () => {
    const message: Extract<SessionMessageInfo, { type: "assistant" }> = {
      id: "msg_duplicate_skill",
      type: "assistant",
      agent: "build",
      model: { providerID: "anthropic", id: "claude-opus-5" },
      content: [
        {
          type: "tool",
          id: "call_duplicate_skill",
          name: "skill",
          state: {
            status: "completed",
            input: { id: "focus-test" },
            content: [{ type: "text", text: "duplicate" }],
            structured: { alreadyActive: true },
          },
          time: { created: 1, ran: 1, completed: 2 },
        },
      ],
      finish: "tool-calls",
      time: { created: 1, completed: 2 },
    }
    const app = await renderTranscript(
      { type: "part", ref: { messageID: message.id, partID: "call_duplicate_skill" } },
      (messageID) => (messageID === message.id ? message : undefined),
    )

    expect(frame(app)).toContain("before\nafter")
    expect(frame(app)).not.toContain("Loaded")

    app.renderer.destroy()
  })

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
      summary: "This durable summary must not render as transcript chat content.",
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
    expect(frame(app)).not.toContain("This durable summary")
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
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
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
        status: "pending",
        time: { created: 1 },
      },
      {
        jobID: "cmp_running",
        messageID: "msg_compaction_running",
        trigger: "advised",
        status: "running",
        time: { created: 2 },
      },
      {
        jobID: "cmp_completed",
        messageID: "msg_compaction_completed",
        trigger: "advised",
        status: "completed",
        revision: 1,
        boundary: { messageID: "msg_boundary", seq: 9 },
        metrics: { excludedMessages: 42, excludedParts: 7, inputTokens: 121_000, retainedTokens: 68_000 },
        time: { created: 3 },
      },
    ] satisfies DataSessionCompactionLifecycle[]
    const labels: (string | string[])[] = [
      "~ compaction pending",
      "~ compacting",
      "~ compaction pending",
      "~ compacting · advised",
      [
        "~ compacted · 42 items excluded · 121k → 68k tokens",
        "~53k tokens saved total",
        "▓▓▓▓▓▓▓▓▓▓▓▓▓",
        "███████████",
        "Compression #1 (~53k tokens removed, 44% reduction)",
        "Items: 42 messages compressed",
      ],
    ]

    for (const [index, lifecycle] of lifecycles.entries()) {
      const app = await renderTranscript(
        { type: "compaction", jobID: lifecycle.jobID },
        () => undefined,
        (jobID) => (jobID === lifecycle.jobID ? lifecycle : undefined),
      )

      try {
        for (const label of Array.isArray(labels[index]) ? labels[index] : [labels[index]]) expect(frame(app)).toContain(label)
        if (index < 2) {
          expect(frame(app)).not.toContain("background")
          expect(frame(app)).not.toContain("advised")
        }
        expect(frame(app)).not.toContain("resp_")
        expect(frame(app)).not.toContain("encrypted_content")
        if (lifecycle.status === "completed") {
          const bar = frame(app).split("\n").find((line) => line.includes("█") && line.includes("▓")) ?? ""
          expect(bar.indexOf("█")).toBeLessThan(bar.indexOf("▓"))
          expect(
            app.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("█"))?.bg.toInts(),
          ).toEqual(theme.text.subdued.toInts())
        }
      } finally {
        app.renderer.destroy()
      }
    }
  })

  test("renders real V1 and V2 failed compactions as zero-line diagnostic-only state", async () => {
    const legacy: Extract<SessionMessageInfo, { type: "compaction" }> = {
      id: "msg_compaction_failed_v1",
      type: "compaction",
      reason: "auto",
      status: "failed",
      error: { type: "provider_failed", message: "must remain diagnostic-only" },
      time: { created: 1 },
    }
    const current: DataSessionCompactionLifecycle = {
      jobID: "cmp_failed_v2",
      messageID: "msg_compaction_failed_v2",
      trigger: "mandatory",
      status: "failed",
      code: "context_limit_unresolved",
      error: { type: "context_limit_unresolved", message: "must remain diagnostic-only" },
      time: { created: 2 },
    }
    const legacyApp = await renderTranscript(
      { type: "message", messageID: legacy.id },
      (messageID) => (messageID === legacy.id ? legacy : undefined),
    )
    const currentApp = await renderTranscript(
      { type: "compaction", jobID: current.jobID },
      () => undefined,
      (jobID) => (jobID === current.jobID ? current : undefined),
    )

    try {
      expect(frame(legacyApp)).toContain("before\nafter")
      expect(frame(currentApp)).toContain("before\nafter")
      expect(current.status).toBe("failed")
    } finally {
      legacyApp.renderer.destroy()
      currentApp.renderer.destroy()
    }
  })

  test("renders cancelled and superseded compactions as neutral terminal markers", async () => {
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
    const lifecycles = [
      { jobID: "cmp_cancelled", code: "cancelled", label: "~ compaction cancelled", color: theme.text.hint },
      { jobID: "cmp_superseded", code: "superseded", label: "~ compaction superseded", color: theme.text.hint },
    ] as const

    for (const lifecycle of lifecycles) {
      const app = await renderTranscript(
        { type: "compaction", jobID: lifecycle.jobID },
        () => undefined,
        (jobID) =>
          jobID === lifecycle.jobID
            ? {
                jobID: lifecycle.jobID,
                status: "failed",
                code: lifecycle.code,
                error: { type: `compaction_${lifecycle.code}`, message: "must not render" },
                time: { created: 1 },
              }
            : undefined,
      )

      try {
        expect(frame(app)).toContain(lifecycle.label)
        expect(frame(app)).not.toContain("failed")
        expect(
          app
            .captureSpans()
            .lines.flatMap((line) => line.spans)
            .find((span) => span.text.includes(lifecycle.label))
            ?.fg.toInts(),
        ).toEqual(lifecycle.color.toInts())
      } finally {
        app.renderer.destroy()
      }
    }
  })

  test("sums completed compactions while retaining per-compaction metrics", async () => {
    const first: DataSessionCompactionLifecycle = {
      jobID: "cmp_first",
      status: "completed",
      revision: 1,
      boundary: { messageID: "msg_first", seq: 1 },
      metrics: { excludedMessages: 10, excludedParts: 0, inputTokens: 20_000, retainedTokens: 8_000 },
      time: { created: 1 },
    }
    const second: DataSessionCompactionLifecycle = {
      jobID: "cmp_second",
      status: "completed",
      revision: 2,
      boundary: { messageID: "msg_second", seq: 2 },
      metrics: { excludedMessages: 20, excludedParts: 0, inputTokens: 100_000, retainedTokens: 60_000 },
      time: { created: 2 },
    }
    const app = await renderTranscript(
      { type: "compaction", jobID: second.jobID },
      () => undefined,
      (jobID) => (jobID === second.jobID ? second : undefined),
      () => [first, second],
    )

    try {
      expect(frame(app)).toContain("~52k tokens saved total")
      expect(frame(app)).toContain("▓▓▓▓▓▓▓▓▓▓▓▓▓▓")
      expect(frame(app)).toContain("██████████")
      const bar = frame(app).split("\n").find((line) => line.includes("█") && line.includes("▓")) ?? ""
      expect(bar.indexOf("█")).toBeLessThan(bar.indexOf("▓"))
      expect(frame(app)).toContain("Compression #2 (~40k tokens removed, 40% reduction)")
      expect(frame(app)).toContain("Items: 20 messages compressed")
    } finally {
      app.renderer.destroy()
    }
  })
})
