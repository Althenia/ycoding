/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import type { KeymapLayer } from "@ycoding-ai/plugin/tui/context"
import { ConfigProvider } from "../../../packages/tui/src/config"
import { ThemeProvider } from "../../../packages/tui/src/context/theme"
import { createTuiResolvedConfig } from "../../../packages/tui/test/fixture/tui-runtime"
import { MeetingCommands, MeetingPage, type MeetingContext } from "../src/tui"
import type { MeetingView } from "../src/types"

const fixture: MeetingView = {
  meeting: {
    id: "meeting-1",
    title: "Thai product review",
    sessionID: "session-1",
    status: "recording",
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
  },
  meetings: [
    {
      id: "meeting-1",
      title: "Thai product review",
      sessionID: "session-1",
      status: "recording",
      createdAt: "2026-10-09T00:00:00.000Z",
      updatedAt: "2026-10-09T00:00:00.000Z",
    },
    {
      id: "meeting-2",
      title: "Follow-up",
      sessionID: "session-2",
      status: "stopped",
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
    },
  ],
  segments: [
    {
      id: "segment-1",
      meetingID: "meeting-1",
      sequence: 1,
      source: "microphone",
      speakerID: "speaker-1",
      startMs: 0,
      endMs: 1000,
      rawText: "ต้นฉบับภาษาไทย",
      text: "ข้อความที่แก้ไขแล้ว",
      state: "final",
      model: "fixture-model",
      createdAt: "2026-10-09T00:00:00.000Z",
    },
  ],
  findings: [
    {
      id: "finding-1",
      meetingID: "meeting-1",
      kind: "decision",
      summary: "Keep the reviewed original and correction separate",
      sourceSegmentIds: ["segment-1"],
      confidence: 0.9,
      status: "unconfirmed",
      createdAt: "2026-10-09T00:00:00.000Z",
    },
  ],
  proposals: [
    {
      id: "proposal-1",
      meetingID: "meeting-1",
      server: "knowledge",
      target: "notes/project.md",
      operation: "replace",
      existingContent: "Existing note",
      suggestedContent: "Suggested note",
      explanation: "The meeting provides new evidence.",
      sourceSegmentIds: ["segment-1"],
      references: [],
      expectedRevision: "rev-7",
      confidence: 0.9,
      status: "pending",
      createdAt: "2026-10-09T00:00:00.000Z",
    },
  ],
  summary: {
    id: "summary-1",
    meetingID: "meeting-1",
    throughSequence: 1,
    summary: "Reviewed summary",
    final: true,
    createdAt: "2026-10-09T00:00:00.000Z",
    latencyMs: 10,
  },
  plan: {
    meetingID: "meeting-1",
    content: "Review the source transcript",
    findingIds: ["finding-1"],
    sourceSegmentIds: ["segment-1"],
    status: "proposed",
    createdAt: "2026-10-09T00:00:00.000Z",
  },
  health: { model: "fixture-model", provider: "fixture-provider", device: "cpu", status: "ready" },
  audio: { bufferedSeconds: 2, processedSeconds: 10, backlog: 1 },
  analysis: { status: "ready", latencyMs: 12 },
  config: { language: "th" },
}

async function render(
  control: (input: unknown) => Promise<unknown>,
  readyText = "Existing: Existing note",
  originSessionID?: string,
) {
  const layers: KeymapLayer[] = []
  const [initialCommand, setInitialCommand] = createSignal("")
  const [commandID, setCommandID] = createSignal(0)
  const [sourceSessionID, setSourceSessionID] = createSignal<string>()
  let nextCommandID = 0
  const context = {
    keymap: {
      layer: (input: () => KeymapLayer) => {
        layers.push(input())
      },
    },
    ui: {
      router: {
        current: () =>
          originSessionID
            ? { type: "session" as const, sessionID: originSessionID }
            : { type: "plugin" as const, id: "ycoding.meeting", name: "meeting" },
        navigate: (destination: Parameters<MeetingContext["ui"]["router"]["navigate"]>[0]) => {
          if (destination.type !== "plugin" || typeof destination.data?.command !== "string") return
          setInitialCommand(destination.data.command)
          setSourceSessionID(
            typeof destination.data.sourceSessionID === "string" ? destination.data.sourceSessionID : undefined,
          )
          setCommandID(++nextCommandID)
        },
      },
    },
  } satisfies MeetingContext
  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
          <>
            <MeetingCommands context={context} />
            <MeetingPage
              context={context}
              control={control}
              initialCommand={initialCommand()}
              commandID={commandID()}
              sourceSessionID={sourceSessionID()}
            />
          </>
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width: 120, height: 40 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(readyText))
  return { app, commands: () => layers.flatMap((layer) => layer.commands ?? []) }
}

test("Meeting page renders actual original and corrected Thai transcript and keeps start consent-gated", async () => {
  const calls: unknown[] = []
  const screen = await render(async (input) => {
    calls.push(input)
    if (typeof input === "object" && input !== null && "action" in input && input.action === "select")
      return { ...fixture, meeting: fixture.meetings[1] }
    return fixture
  })
  try {
    screen.app.renderer.resize(80, 24)
    await screen.app.renderOnce()
    expect(screen.app.captureCharFrame()).toContain("Thai product review")
    const next = screen.commands().find((item) => item.id === "meeting.next")!
    expect(next.bind).toBe("down")
    await next.run()
    expect(calls.at(-1)).toEqual({ action: "select", meetingID: "meeting-2" })
    const frame = screen.app.captureCharFrame()
    expect(frame).toContain("Original: ต้นฉบับภาษาไทย")
    expect(frame).toContain("Corrected: ข้อความที่แก้ไขแล้ว")
    expect(frame).toContain("Plan · proposed")
    const command = screen.commands().find((item) => item.id === "meeting.command")!
    expect(command.slash).toEqual({ name: "meeting", arguments: true })
    await command.run("start")
    await screen.app.waitForFrame((next) => next.includes("Capture is armed"))
    expect(calls.at(-1)).toEqual({ action: "start" })
    expect(screen.app.captureCharFrame()).toContain("Recording starts only after the Chrome click and consent.")
  } finally {
    screen.app.renderer.destroy()
  }
})

test("pairing shows the code only while it can still be redeemed", async () => {
  const pairing = { url: "http://127.0.0.1:59099", code: "valid-code-123" }
  const valid = await render(
    async () => ({ ...fixture, pairing: { ...pairing, expiresAt: Date.now() + 45_000 } }),
    "Pair Chrome",
  )
  try {
    const frame = valid.app.captureCharFrame()
    expect(frame).toContain("valid-code-123")
    expect(frame).toMatch(/expires in (4[0-5]|3\d)s/)
  } finally {
    valid.app.renderer.destroy()
  }
  const expired = await render(
    async () => ({ ...fixture, pairing: { ...pairing, code: "expired-code-456", expiresAt: Date.now() - 1_000 } }),
    "Pairing code expired",
  )
  try {
    const frame = expired.app.captureCharFrame()
    expect(frame).not.toContain("expired-code-456")
    expect(frame).toContain("run /meeting start for a new code")
  } finally {
    expired.app.renderer.destroy()
  }
})

test("knowledge approval requires review followed by a separate explicit confirmation", async () => {
  const calls: unknown[] = []
  let approve!: (input: unknown) => void
  const approved = new Promise<unknown>((resolve) => {
    approve = resolve
  })
  const screen = await render(async (input) => {
    calls.push(input)
    if (typeof input === "object" && input !== null && "action" in input && input.action === "approve") approve(input)
    return fixture
  })
  try {
    const command = screen.commands().find((item) => item.id === "meeting.command")!
    await command.run("approve proposal-1")
    await screen.app.waitForFrame((frame) => frame.includes("Then run /meeting approve proposal-1 confirm."))
    expect(calls).toHaveLength(1)
    await command.run("approve proposal-1 confirm")
    expect(await approved).toEqual({ action: "approve", proposalID: "proposal-1", meetingID: "meeting-1" })
  } finally {
    screen.app.renderer.destroy()
  }
})

test("invalidated plans show their stale evidence state without automatically regenerating", async () => {
  const calls: unknown[] = []
  const screen = await render(async (input) => {
    calls.push(input)
    return { ...fixture, plan: { ...fixture.plan, status: "rejected" } }
  }, "Review the source transcript")
  try {
    const frame = screen.app.captureCharFrame()
    expect(frame).toContain("Plan · rejected")
    expect(frame).toContain("Plan is not current; reconfirm findings and regenerate")
    expect(frame).not.toContain("Plan · proposed")
    expect(calls).toEqual([{ action: "status" }])
  } finally {
    screen.app.renderer.destroy()
  }
})

test("untrusted transcript and knowledge control sequences render as visible escapes without changing evidence", async () => {
  const rawText = "ภาษาไทย\u001b[31mAPI\u001b[0m"
  const content = "note\u001b]52;c;ZmFrZQ==\u0007"
  const value = {
    ...fixture,
    segments: fixture.segments.map((segment) => ({ ...segment, rawText, text: rawText })),
    proposals: fixture.proposals.map((proposal) => ({ ...proposal, existingContent: content })),
  }
  const screen = await render(async () => value, "Suggested: Suggested note")
  try {
    const frame = screen.app.captureCharFrame()
    expect(frame).toContain("ภาษาไทย\\u001b[31mAPI\\u001b[0m")
    expect(frame).toContain("note\\u001b]52;c;ZmFrZQ==\\u0007")
    expect(frame).not.toContain("\u001b")
    expect(value.segments[0]?.rawText).toBe(rawText)
    expect(value.proposals[0]?.existingContent).toBe(content)
  } finally {
    screen.app.renderer.destroy()
  }
})

test("starting from a Session inherits that Session's provider selection without overriding an explicit Session", async () => {
  const started = Promise.withResolvers<unknown>()
  const explicit = Promise.withResolvers<unknown>()
  const screen = await render(
    async (input) => {
      if (typeof input === "object" && input !== null && "action" in input && input.action === "start") {
        if ("sessionID" in input && input.sessionID === "explicit-session") explicit.resolve(input)
        else started.resolve(input)
      }
      return fixture
    },
    "Existing: Existing note",
    "origin-session",
  )
  try {
    const command = screen.commands().find((item) => item.id === "meeting.command")!
    await command.run("start")
    expect(await started.promise).toEqual({ action: "start", sessionID: "origin-session" })
    await command.run("start explicit-session")
    expect(await explicit.promise).toEqual({ action: "start", sessionID: "explicit-session" })
  } finally {
    screen.app.renderer.destroy()
  }
})

test("model installation requires displayed inventory and a separate explicit confirmation", async () => {
  const calls: unknown[] = []
  let install!: (input: unknown) => void
  const installed = new Promise<unknown>((resolve) => {
    install = resolve
  })
  const screen = await render(async (input) => {
    calls.push(input)
    if (typeof input === "object" && input !== null && "action" in input && input.action === "models")
      return { ...fixture, models: [{ id: "local-model", downloadSize: "2 GB" }] }
    if (typeof input === "object" && input !== null && "action" in input && input.action === "model-install")
      install(input)
    return fixture
  })
  try {
    const command = screen.commands().find((item) => item.id === "meeting.command")!
    await command.run("model-install local-model confirm-download")
    expect(calls.at(-1)).not.toHaveProperty("action", "model-install")
    await command.run("model-install local-model")
    await screen.app.waitForFrame((frame) => frame.includes("Review the model inventory above"))
    expect(screen.app.captureCharFrame()).toContain("downloadSize")
    await command.run("model-install local-model confirm-download")
    expect(await installed).toEqual({ action: "model-install", model: "local-model", authorized: true })
  } finally {
    screen.app.renderer.destroy()
  }
})

test("controller failures remain errors and clear the loading state", async () => {
  const screen = await render(async () => {
    throw new Error("bridge unavailable")
  }, "bridge unavailable")
  try {
    const frame = screen.app.captureCharFrame()
    expect(frame).toContain("✗ bridge unavailable")
    expect(frame).not.toContain("Loading Meeting state…")
    expect(frame).not.toContain("Capture is armed")
  } finally {
    screen.app.renderer.destroy()
  }
})

test("native control errors are shown instead of being reported as malformed success", async () => {
  const screen = await render(async () => ({ error: "native control rejected" }), "native control rejected")
  try {
    const frame = screen.app.captureCharFrame()
    expect(frame).toContain("✗ native control rejected")
    expect(frame).not.toContain("invalid view")
  } finally {
    screen.app.renderer.destroy()
  }
})

test("model inventory failure does not show a successful models notice", async () => {
  const screen = await render(async (input) => {
    if (typeof input === "object" && input !== null && "action" in input && input.action === "models")
      return { error: "model inventory unavailable" }
    return fixture
  })
  try {
    const command = screen.commands().find((item) => item.id === "meeting.command")!
    await command.run("models")
    await screen.app.waitForFrame((frame) => frame.includes("model inventory unavailable"))
    const frame = screen.app.captureCharFrame()
    expect(frame).toContain("✗ model inventory unavailable")
    expect(frame).not.toContain("Models are shown from controller state")
  } finally {
    screen.app.renderer.destroy()
  }
})

test("retry and reconcile slash commands invoke their explicit controller actions", async () => {
  const calls: unknown[] = []
  let requestRetry!: () => void
  let requestReconcile!: () => void
  const retryRequested = new Promise<void>((resolve) => {
    requestRetry = resolve
  })
  const reconcileRequested = new Promise<void>((resolve) => {
    requestReconcile = resolve
  })
  const screen = await render(async (input) => {
    calls.push(input)
    if (typeof input !== "object" || input === null || !("action" in input)) return fixture
    if (input.action === "retry") requestRetry()
    if (input.action === "reconcile") requestReconcile()
    return fixture
  })
  try {
    const command = screen.commands().find((item) => item.id === "meeting.command")!
    await command.run("retry")
    await retryRequested
    expect(
      calls.find(
        (input) => typeof input === "object" && input !== null && "action" in input && input.action === "retry",
      ),
    ).toEqual({ action: "retry", meetingID: "meeting-1" })
    await command.run("reconcile")
    await reconcileRequested
    expect(
      calls.find(
        (input) => typeof input === "object" && input !== null && "action" in input && input.action === "reconcile",
      ),
    ).toEqual({ action: "reconcile", meetingID: "meeting-1" })
  } finally {
    screen.app.renderer.destroy()
  }
})

test("manual knowledge proposals remain review-only without a writer", async () => {
  const calls: unknown[] = []
  const manual = {
    ...fixture,
    proposals: fixture.proposals.map((proposal) => ({ ...proposal, status: "manual" as const })),
  }
  const screen = await render(async (input) => {
    calls.push(input)
    return manual
  })
  try {
    const command = screen.commands().find((item) => item.id === "meeting.command")!
    expect(screen.app.captureCharFrame()).toContain("manual review; no writer is available")
    await command.run("approve proposal-1 confirm")
    await screen.app.waitForFrame((frame) => frame.includes("Open knowledge review and select a pending proposal"))
    expect(
      calls.some(
        (input) => typeof input === "object" && input !== null && "action" in input && input.action === "approve",
      ),
    ).toBe(false)
  } finally {
    screen.app.renderer.destroy()
  }
})
