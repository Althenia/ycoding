/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import type { Renderable } from "@opentui/core"
import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { Keymap } from "../src/context/keymap"
import { modeChips } from "../src/component/prompt/mode-chips"
import {
  Header,
  pendingModelVariant,
  headerSegments,
  headerStatusLabel,
  type SessionHeaderIdentity,
  type SessionHeaderSegmentKey,
  type SessionHeaderState,
} from "../src/routes/session/header"
import { PromptFooterIdentity } from "../src/component/prompt"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { DEFAULT_THEMES } from "../src/theme/builtins"
import { resolveThemeFile } from "../src/theme/v2/resolve"
import { getGlyph } from "../src/ui/glyph"

const identity = {
  path: "~/Workspace/Personal/YCoding",
  branch: "main",
  agent: "Build",
  model: "anthropic/claude-opus-5",
  variant: "max",
}

function labels(width: number) {
  return headerSegments({ ...identity, width }).map((segment) => segment.label)
}

describe("header truncation ladder", () => {
  test("keeps the full path at 160 columns", () => {
    expect(labels(160)).toEqual([
      "~/Workspace/Personal/YCoding",
      "main",
      "Build",
      "anthropic/claude-opus-5",
      "max",
    ])
  })

  test("keeps the last two path parts at 140 columns", () => {
    expect(labels(140)).toEqual(["Personal/YCoding", "main", "Build", "anthropic/claude-opus-5", "max"])
  })

  test("keeps only the path basename at 120 columns", () => {
    expect(labels(120)).toEqual(["YCoding", "main", "Build", "anthropic/claude-opus-5", "max"])
  })

  test("drops the path and shortens the model at 100 columns", () => {
    expect(labels(100)).toEqual(["main", "Build", "claude-opus-5", "max"])
  })

  test("drops the branch whole at 80 columns", () => {
    expect(labels(80)).toEqual(["Build", "claude-opus-5", "max"])
  })

  test("omits segments the session has not resolved yet", () => {
    expect(headerSegments({ width: 160, agent: "Build" }).map((segment) => segment.key)).toEqual(["agent"])
  })
})

describe("header status", () => {
  const cases: Array<[SessionHeaderState, number, string]> = [
    [{ type: "ready" }, 100, "ready"],
    [{ type: "working", elapsed: 4.14 }, 120, "cooking 4.1s"],
    [{ type: "thinking", elapsed: 4.14 }, 120, "thinking · 4.1s"],
    [{ type: "tool-running", elapsed: 4.14 }, 120, "tool running · 4.1s"],
    [{ type: "waiting", count: 1 }, 100, "waiting · 1 subagent"],
    [{ type: "waiting", count: 2 }, 100, "waiting · 2 subagents"],
    [{ type: "awaiting-input", count: 1 }, 100, "? awaiting input"],
    [{ type: "awaiting-input", count: 2 }, 100, "? awaiting input"],
    [{ type: "provider-error", message: "Provider overloaded; retry in 30 seconds." }, 100, "provider error"],
    [{ type: "autonomy", yolo: 2, goalActive: false, state: { type: "ready" } }, 100, "YOLO 2 \u00b7 auto-approve · ready"],
    [{ type: "autonomy", yolo: 0, goalActive: true, state: { type: "working", elapsed: 4.14 } }, 120, "Goal · autonomous · cooking 4.1s"],
  ]

  for (const [state, width, expected] of cases) {
    test(`renders ${expected}`, () => {
      expect(headerStatusLabel(state, width)).toBe(expected)
    })
  }

  test("renders a bare elapsed value for working at 100 columns", () => {
    expect(headerStatusLabel({ type: "working", elapsed: 4.14 }, 100)).toBe("4.1s")
  })

  test("shows the active shell count instead of ready", () => {
    expect(headerStatusLabel({ type: "ready" }, 100, 3)).toBe("3 shells running")
  })

  test("reports the retry attempt and countdown", () => {
    expect(headerStatusLabel({ type: "retry-scheduled", attempt: 2, at: 15_000 }, 100, undefined, 10_000)).toBe(
      "1 failed · retry 2 · in 5s",
    )
  })

  test("reports retrying without countdown", () => {
    expect(headerStatusLabel({ type: "retrying", attempt: 2 }, 100)).toBe("retrying · attempt 2")
  })

  test("keeps active autonomy and retry status visible together", () => {
    expect(
      headerStatusLabel(
        { type: "autonomy", yolo: 0, goalActive: true, state: { type: "retry-scheduled", attempt: 2, at: 15_000 } },
        100,
        undefined,
        10_000,
      ),
    ).toBe("Goal · autonomous · 1 failed · retry 2 · in 5s")
  })

  test("keeps active autonomy and retrying visible together", () => {
    expect(
      headerStatusLabel({ type: "autonomy", yolo: 0, goalActive: true, state: { type: "retrying", attempt: 2 } }, 100, undefined, 10_000),
    ).toBe("Goal · autonomous · retrying · attempt 2")
  })
})

test("shows the selected model and variant only while the session still uses a different next-prompt choice", () => {
  expect(
    pendingModelVariant(
      { model: "GPT-5.6 Terra", variant: "high" },
      { pendingModel: "GPT-5.6 Terra", pendingVariant: "xhigh" },
    ),
  ).toBe("→ GPT-5.6 Terra · xhigh")
  expect(
    pendingModelVariant(
      { model: "GPT-5.6 Terra", variant: "high" },
      { pendingModel: "GPT-5.6 Terra", pendingVariant: "high" },
    ),
  ).toBeUndefined()
})

function HeaderKeymap(props: Parameters<typeof Header>[0]) {
  Keymap.createLayer(() => ({
    commands: [
      { id: "session.move", run: () => {} },
      { id: "model.list", run: () => {} },
      { id: "agent.list", run: () => {} },
      { id: "variant.cycle", run: () => {} },
    ],
  }))
  const leaderActive = Keymap.useLeaderActive()
  return (
    <>
      <Header {...props} />
      <text>{leaderActive() ? "leader pending" : ""}</text>
    </>
  )
}

function findSpinnerInterval(node: Renderable): number | undefined {
  if ("interval" in node && "frames" in node && typeof node.interval === "number" && Array.isArray(node.frames)) {
    return node.interval
  }
  return node
    .getChildren()
    .flatMap((child) => findSpinnerInterval(child) ?? [])
    .at(0)
}

async function renderHeader(
  width: number,
  state: SessionHeaderState,
  input: {
    focused?: SessionHeaderSegmentKey
    leaderPending?: boolean
    subagent?: boolean
    config?: ReturnType<typeof createTuiResolvedConfig>
    identity?: SessionHeaderIdentity
  } = {},
) {
  const config = input.config ?? createTuiResolvedConfig()
  const headerIdentity = input.identity ?? identity
  const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
    import("../src/config"),
    import("../src/context/theme"),
  ])

  const app = await testRender(
    () => (
      <TestTuiContexts>
          <ConfigProvider config={config}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <Keymap.Provider config={config}>
                <HeaderKeymap {...headerIdentity} state={state} focused={input.focused} subagent={input.subagent} />
              </Keymap.Provider>
            </ThemeProvider>
          </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height: 6, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(input.subagent ? "subagent" : `v${InstallationVersion}`))
  if (input.leaderPending) {
    app.mockInput.pressKey("x", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("leader pending"))
  }
  return app
}

describe("autonomy mode chips", () => {
  test("shows both modes off for a normal session", () => {
    expect(modeChips({ autonomy: { mode: "normal", yolo: 0 } })).toEqual([
      { key: "goal", label: "goal off", tone: "off" },
      { key: "yolo", label: "YOLO off", tone: "off" },
    ])
  })

  test("inverts YOLO because it auto-approves", () => {
    expect(modeChips({ autonomy: { mode: "normal", yolo: 2 } })[1]).toEqual({
      key: "yolo",
      label: "YOLO 2",
      tone: "danger",
    })
  })

  test("shows only the goal label while goal mode is active", () => {
    const autonomy = { mode: "normal", yolo: 0, goal: { runID: "run_session_chrome_fixture", text: "ship", status: "active", iteration: 7, noProgress: 3, maxNoProgress: 5 },
    } as const
    const chip = modeChips({ autonomy })[0]
    expect(chip).toEqual({ key: "goal", label: "goal", tone: "on" })
    expect(chip?.label).not.toContain("/")
  })

  test("shows goal off after leaving goal mode with retained terminal state", () => {
    const autonomy = { mode: "normal", yolo: 0, goal: { runID: "run_session_chrome_fixture", text: "ship", status: "completed", iteration: 7, noProgress: 0, maxNoProgress: 5 },
    } as const
    expect(modeChips({ autonomy })[0]).toEqual({ key: "goal", label: "goal off", tone: "off" })
  })

  test("renders the chips on the composer status row", async () => {
    const config = createTuiResolvedConfig()
    const [{ ConfigProvider }, { ThemeProvider }, { ModeChips }] = await Promise.all([
      import("../src/config"),
      import("../src/context/theme"),
      import("../src/component/prompt/mode-chips"),
    ])
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={config}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <box flexDirection="row" gap={2}>
                <ModeChips autonomy={{ mode: "normal", yolo: 2 }} />
              </box>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 60, height: 4 },
    )
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("YOLO"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("goal off")
    expect(frame).toContain("YOLO")
    expect(frame).not.toContain("YOLO off")
    app.renderer.destroy()
  })
})

describe("header rendering", () => {
  test("renders every identity segment with its design token", async () => {
    const app = await renderHeader(160, { type: "ready" })
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
    const spans = app.captureSpans().lines.flatMap((line) => line.spans)

    expect(spans.find((span) => span.text.includes("~/Workspace/Personal/YCoding"))?.fg.toInts()).toEqual(
      theme.text.subdued.toInts(),
    )
    expect(spans.find((span) => span.text.includes("main"))?.fg.toInts()).toEqual(
      theme.text.feedback.info.default.toInts(),
    )
    expect(spans.find((span) => span.text.includes("Build"))?.fg.toInts()).toEqual(theme.text.default.toInts())
    expect(spans.find((span) => span.text.includes("anthropic/claude-opus-5"))?.fg.toInts()).toEqual(
      theme.text.subdued.toInts(),
    )
    expect(spans.find((span) => span.text.includes("max"))?.fg.toInts()).toEqual(
      theme.text.feedback.success.default.toInts(),
    )

    app.renderer.destroy()
  })

  test("renders segment separators with the separator token instead of subdued text", async () => {
    const app = await renderHeader(160, { type: "ready" })
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
    const separator = app.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.trim() === "·")

    expect(separator?.fg.toInts()).toEqual(theme.text.separator.toInts())
    expect(separator?.fg.toInts()).not.toEqual(theme.text.subdued.toInts())

    app.renderer.destroy()
  })

  test("renders the branch at 100 columns", async () => {
    const present = await renderHeader(100, { type: "ready" })
    expect(present.captureCharFrame()).toContain("main")
    present.renderer.destroy()
  })

  test("renders every supported status with its semantic theme token", async () => {
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
    const cases: Array<[SessionHeaderState, string, { toInts(): readonly number[] }]> = [
      [{ type: "ready" }, "ready", theme.text.subdued],
      [{ type: "working", elapsed: 4.1 }, "cooking 4.1s", theme.text.feedback.success.default],
      [{ type: "thinking", elapsed: 4.1 }, "thinking · 4.1s", theme.text.feedback.success.default],
      [{ type: "tool-running", elapsed: 4.1 }, "tool running · 4.1s", theme.text.feedback.info.default],
      [{ type: "waiting", count: 2 }, "waiting · 2 subagents", theme.text.feedback.info.default],
      [{ type: "awaiting-input", count: 1 }, "? awaiting input", theme.text.feedback.warning.default],
      [{ type: "provider-error", message: "Provider overloaded; retry in 30 seconds." }, "provider error", theme.text.feedback.error.default],
      [{ type: "autonomy", yolo: 2, goalActive: false, state: { type: "ready" } }, "YOLO 2 · auto-approve · ready", theme.text.feedback.error.default],
      [{ type: "autonomy", yolo: 0, goalActive: true, state: { type: "ready" } }, "Goal · autonomous · ready", theme.text.feedback.success.default],
      [{ type: "retry-scheduled", attempt: 2, at: Date.now() + 5_000 }, "1 failed · retry 2 · in", theme.text.feedback.warning.default],
      [{ type: "retrying", attempt: 2 }, "retrying · attempt 2", theme.text.feedback.warning.default],
    ]

    for (const [state, label, color] of cases) {
      const app = await renderHeader(160, state)
      const status = app.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes(label))
      expect(status?.text).toContain(label)
      const colorInts = color.toInts()
      expect(status?.fg.toInts()).toEqual([colorInts[0], colorInts[1], colorInts[2], colorInts[3]])
      app.renderer.destroy()
    }
  })

  test("renders the generic provider failure label instead of the detailed message", async () => {
    const app = await renderHeader(160, { type: "provider-error", message: "Provider overloaded; retry in 30 seconds." })
    const frame = app.captureCharFrame()
    expect(frame).toContain("provider error")
    expect(frame).not.toContain("Provider overloaded; retry in 30 seconds.")
    app.renderer.destroy()
  })

  test("shows the brand mark, mint dot trail, version, identity, and cooking status on the strip at 160 columns", async () => {
    const app = await renderHeader(160, { type: "working", elapsed: 4.1 })
    const frame = app.captureCharFrame()
    const lines = frame.split("\n")
    expect(frame).toMatch(/\.\.●|\.●\.|●\.\./)
    expect(frame).toContain(`v${InstallationVersion}`)
    expect(frame).not.toContain("y. ycoding")
    expect(frame).toContain("~/Workspace/Personal/YCoding")
    expect(frame).toContain("main")
    expect(frame).toContain("cooking 4.1s")
    expect(lines.findIndex((line) => line.includes(`v${InstallationVersion}`))).toBe(1)
    expect(lines[0]?.trim()).toBe("")
    expect(lines[2]?.trim()).toBe("")
    app.renderer.destroy()
  })

  test("drops the path and branch at 80 columns instead of shrinking the state word", async () => {
    const app = await renderHeader(80, { type: "ready" })
    const frame = app.captureCharFrame()
    expect(frame).toContain(`v${InstallationVersion}`)
    expect(frame).not.toContain("y. ycoding")
    expect(frame).toContain("claude-opus-5")
    expect(frame).not.toContain("Workspace")
    expect(frame).toContain("ready")
    app.renderer.destroy()
  })

  test("renders the danger rule as a full-width filled band under the header in YOLO", async () => {
    const app = await renderHeader(100, { type: "autonomy", yolo: 2, goalActive: false, state: { type: "ready" } })
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
    const frame = app.captureCharFrame()
    // Board 12 states YOLO with the header's right-hand status in the error ink. The previous
    // full-width destructive band under the header was an invention and read as a huge red bar.
    expect(frame).toContain("YOLO 2 \u00b7 auto-approve")
    expect(app.captureSpans().lines[3]?.spans ?? []).not.toHaveLength(0)
    expect(
      (app.captureSpans().lines[3]?.spans ?? []).some((span) =>
        span.bg.toInts().every((value, index) => value === theme.background.action.destructive.default.toInts()[index]),
      ),
    ).toBe(false)
    app.renderer.destroy()
  })

  test("counts down the top-right retry indicator", async () => {
    const app = await renderHeader(160, { type: "retry-scheduled", attempt: 2, at: Date.now() + 1_500 })
    await app.waitForFrame((frame) => frame.includes("1 failed · retry 2 · in 2s"))
    await Bun.sleep(600)
    await app.waitForFrame((frame) => frame.includes("1 failed · retry 2 · in 1s"))
    expect(app.captureCharFrame()).not.toMatch(/\.\.●|\.●\.|●\.\./)
    app.renderer.destroy()
  })

  test("scheduled retry shows countdown without animation", async () => {
    const app = await renderHeader(160, { type: "retry-scheduled", attempt: 2, at: Date.now() + 5_000 })
    expect(app.captureCharFrame()).toContain("1 failed · retry 2 · in")
    expect(app.captureCharFrame()).not.toMatch(/\.\.●|\.●\.|●\.\./)
    app.renderer.destroy()
  })

  test("animates retrying with the warning dot trail without countdown", async () => {
    const app = await renderHeader(160, { type: "retrying", attempt: 2 })
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
    const initial = app.captureCharFrame()
    const initialTrail = initial.match(/\.\.●|\.●\.|●\.\./)?.[0]

    expect(initialTrail).toBeDefined()
    expect(initial).toContain("retrying · attempt 2")
    expect(initial).not.toContain(" in ")
    expect(initial).not.toContain(getGlyph("failed").glyph)
    await app.waitForFrame((frame) => {
      const trail = frame.match(/\.\.●|\.●\.|●\.\./)?.[0]
      return !!trail && trail !== initialTrail && frame.includes("retrying · attempt 2")
    })

    const spans = app.captureSpans().lines.flatMap((line) => line.spans)
    expect(spans.find((span) => /\.\.●|\.●\.|●\.\./.test(span.text))?.fg.toInts()).toEqual(
      theme.text.feedback.warning.default.toInts(),
    )
    expect(spans.find((span) => span.text.includes("retrying · attempt 2"))?.fg.toInts()).toEqual(
      theme.text.feedback.warning.default.toInts(),
    )
    app.renderer.destroy()
  })

  test("reveals the binding for the focused segment only", async () => {
    const app = await renderHeader(160, { type: "ready" }, { focused: "model" })
    const frame = app.captureCharFrame()
    expect(frame).toContain("\u2303x m change")
    expect(frame).not.toContain("\u2303t cycle")
    app.renderer.destroy()
  })

  test("reveals bound segment hints while the leader key is pending", async () => {
    const app = await renderHeader(160, { type: "ready" }, { leaderPending: true })
    const frame = app.captureCharFrame()

    expect(frame).toContain("⌃x m change")
    app.renderer.destroy()
  })

  test("does not reveal an unbound segment hint while the leader key is pending", async () => {
    const app = await renderHeader(160, { type: "ready" }, { leaderPending: true })

    expect(app.captureCharFrame()).not.toContain("move")
    app.renderer.destroy()
  })

  test("keeps an explicit focused segment ahead of the leader-pending state", async () => {
    const app = await renderHeader(160, { type: "ready" }, { focused: "model", leaderPending: true })
    const frame = app.captureCharFrame()

    expect(frame).toContain("⌃x m change")
    expect(frame).not.toContain("⌃x a change")
    app.renderer.destroy()
  })

  test("hides hints without a focused segment or pending leader key", async () => {
    const app = await renderHeader(160, { type: "ready" })
    const frame = app.captureCharFrame()

    expect(frame).not.toContain("⌃x m change")
    expect(frame).not.toContain("⌃x a change")
    app.renderer.destroy()
  })

  test("keeps a focused model subdued and uses the label token for its hint", async () => {
    const app = await renderHeader(160, { type: "ready" }, { focused: "model" })
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
    const spans = app.captureSpans().lines.flatMap((line) => line.spans)
    const model = spans.find((span) => span.text.includes("anthropic/claude-opus-5"))
    const hint = spans.find((span) => span.text.includes("\u2303x m change"))

    expect(model?.fg.toInts()).toEqual(theme.text.subdued.toInts())
    expect(model?.bg.toInts()).toEqual(theme.background.surface.overlay.toInts())
    expect(hint?.fg.toInts()).toEqual(theme.text.label.toInts())

    app.renderer.destroy()
  })

  test("resolves a focused hint from the configured keymap", async () => {
    const app = await renderHeader(160, { type: "ready" }, {
      focused: "model",
      config: createTuiResolvedConfig({ keybinds: { model_list: "ctrl+k" } }),
    })

    expect(app.captureCharFrame()).toContain("⌃k change")
    expect(app.captureCharFrame()).not.toContain("⌃x m change")
    app.renderer.destroy()
  })

  test("omits the hint for a focused segment whose command is unbound", async () => {
    const app = await renderHeader(160, { type: "ready" }, { focused: "path" })

    expect(app.captureCharFrame()).not.toContain("move")
    app.renderer.destroy()
  })

  test("renders subagent identity and cooking status in the info token", async () => {
    const app = await renderHeader(160, { type: "working", elapsed: 4.1 }, { subagent: true })
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
    const spans = app.captureSpans().lines.flatMap((line) => line.spans)
    const brand = spans.find((span) => span.text.includes("◦ subagent"))
    const status = spans.find((span) => span.text.includes("cooking 4.1s"))

    expect(brand?.fg.toInts()).toEqual(theme.text.feedback.info.default.toInts())
    expect(status?.fg.toInts()).toEqual(theme.text.feedback.info.default.toInts())
    app.renderer.destroy()
  })

  test("keeps main-session cooking status and dot trail in the accent token", async () => {
    const app = await renderHeader(160, { type: "working", elapsed: 4.1 })
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
    const spans = app.captureSpans().lines.flatMap((line) => line.spans)
    const status = spans.find((span) => span.text.includes("cooking 4.1s"))

    expect(spans.find((span) => /\.\.●|\.●\.|●\.\./.test(span.text))?.fg.toInts()).toEqual(theme.text.feedback.success.default.toInts())
    expect(status?.fg.toInts()).toEqual(theme.text.feedback.success.default.toInts())
    app.renderer.destroy()
  })

  test("uses the slower native spinner interval while preserving normal working success color", async () => {
    const app = await renderHeader(160, { type: "working", elapsed: 4.1 })
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
    const spans = app.captureSpans().lines.flatMap((line) => line.spans)

    expect(findSpinnerInterval(app.renderer.root)).toBe(160)
    expect(spans.find((span) => /\.\.●|\.●\.|●\.\./.test(span.text))?.fg.toInts()).toEqual(
      theme.text.feedback.success.default.toInts(),
    )
    app.renderer.destroy()
  })

  test("uses the YOLO error token for the dot trail and adjacent working status", async () => {
    const app = await renderHeader(160, { type: "autonomy", yolo: 2, goalActive: false, state: { type: "working", elapsed: 4.1 } })
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
    const spans = app.captureSpans().lines.flatMap((line) => line.spans)
    const dotTrail = spans.find((span) => /\.\.●|\.●\.|●\.\./.test(span.text))
    const status = spans.find((span) => span.text.includes("YOLO 2 · auto-approve · cooking 4.1s"))

    expect(dotTrail?.fg.toInts()).toEqual(theme.text.feedback.error.default.toInts())
    expect(status?.fg.toInts()).toEqual(theme.text.feedback.error.default.toInts())
    app.renderer.destroy()
  })

  test("keeps the animation-disabled normal working fallback static and success-colored", async () => {
    const app = await renderHeader(
      160,
      { type: "working", elapsed: 4.1 },
      { config: createTuiResolvedConfig({ animations: false }) },
    )
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
    const spans = app.captureSpans().lines.flatMap((line) => line.spans)
    const fallback = spans.find((span) => span.text.includes("⋯"))

    expect(app.captureCharFrame()).not.toMatch(/\.\.●|\.●\.|●\.\./)
    expect(fallback?.fg.toInts()).toEqual(theme.text.feedback.success.default.toInts())
    app.renderer.destroy()
  })

  test("renders next-prompt agent, model, and variant for a main Session but not a subagent", async () => {
    const config = createTuiResolvedConfig()
    const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
      import("../src/config"),
      import("../src/context/theme"),
    ])
    let setPendingAgent!: (value: string | undefined) => void
    let setPending!: (value: Pick<SessionHeaderIdentity, "pendingModel" | "pendingVariant">) => void
    let setSubagent!: (value: boolean) => void
    function LiveHeader() {
      const [pendingAgent, setAgent] = createSignal<string>()
      const [pending, set] = createSignal<Pick<SessionHeaderIdentity, "pendingModel" | "pendingVariant">>({})
      const [subagent, setSubagentSignal] = createSignal(false)
      setPendingAgent = setAgent
      setPending = set
      setSubagent = setSubagentSignal
      return (
        <Header
          {...identity}
          pendingAgent={pendingAgent()}
          pendingModel={pending().pendingModel}
          pendingVariant={pending().pendingVariant}
          state={{ type: "ready" }}
          subagent={subagent()}
        />
      )
    }
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={config}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <Keymap.Provider config={config}>
                <LiveHeader />
              </Keymap.Provider>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 160, height: 6, kittyKeyboard: true },
    )
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("anthropic/claude-opus-5"))
    setPendingAgent("Zeus")
    await app.waitForFrame((frame) => frame.includes("→ Zeus"))
    setPending({ pendingModel: "GPT-5.6 Terra", pendingVariant: "high" })
    await app.waitForFrame((frame) => frame.includes("→ GPT-5.6 Terra · high"))
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
    const highlight = app
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("→ GPT-5.6 Terra · high"))

    expect(highlight?.fg.toInts()).toEqual(theme.text.subdued.toInts())
    setSubagent(true)
    await app.waitForFrame((frame) => frame.includes("subagent"))
    expect(app.captureCharFrame()).not.toContain("→ Zeus")
    expect(app.captureCharFrame()).not.toContain("→ GPT-5.6 Terra · high")
    app.renderer.destroy()
  })

  test("updates active elapsed time and stops after becoming ready", async () => {
    const config = createTuiResolvedConfig()
    const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
      import("../src/config"),
      import("../src/context/theme"),
    ])
    let setState!: (state: SessionHeaderState) => void
    function LiveHeader() {
      const [state, set] = createSignal<SessionHeaderState>({ type: "thinking", startedAt: Date.now() - 1_000 })
      setState = set
      return <Header {...identity} state={state()} />
    }
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={config}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <Keymap.Provider config={config}>
                <LiveHeader />
              </Keymap.Provider>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 160, height: 6, kittyKeyboard: true },
    )
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("thinking · 1."))
    const initial = app.captureCharFrame()
    await Bun.sleep(200)
    expect(app.captureCharFrame()).not.toBe(initial)
    setState({ type: "ready" })
    await app.waitForFrame((frame) => frame.includes("ready"))
    const settled = app.captureCharFrame()
    await Bun.sleep(200)
    expect(app.captureCharFrame()).toBe(settled)
    app.renderer.destroy()
  })

})

describe("footer branch identity", () => {
  test("renders the branch and session chip with subdued text in footer order", async () => {
    const config = createTuiResolvedConfig()
    const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
      import("../src/config"),
      import("../src/context/theme"),
    ])
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={config}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <box flexDirection="row">
                <PromptFooterIdentity branch="main" sessionID="ses_0085fc701234567" />
              </box>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 80, height: 2 },
    )
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("main"))
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
    const spans = app.captureSpans().lines.flatMap((line) => line.spans)
    const branch = spans.find((span) => span.text.includes("main"))
    const session = spans.find((span) => span.text.includes("ses_0085fc701…"))

    expect(branch?.fg.toInts()).toEqual(theme.text.subdued.toInts())
    expect(branch?.fg.toInts()).not.toEqual(theme.text.feedback.info.default.toInts())
    expect(session?.text).toContain("ses_0085fc701…")
    expect(app.captureCharFrame().indexOf("main")).toBeLessThan(app.captureCharFrame().indexOf("ses_0085fc701…"))
    app.renderer.destroy()
  })

  test("omits the session chip when no session id exists", async () => {
    const config = createTuiResolvedConfig()
    const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
      import("../src/config"),
      import("../src/context/theme"),
    ])
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={config}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <box flexDirection="row">
                <PromptFooterIdentity branch="main" sessionID={undefined} />
              </box>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 80, height: 2 },
    )
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("main"))
    expect(app.captureCharFrame()).not.toContain("ses_")
    app.renderer.destroy()
  })

  test("keeps a short session id unpadded and without an ellipsis", async () => {
    const config = createTuiResolvedConfig()
    const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
      import("../src/config"),
      import("../src/context/theme"),
    ])
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={config}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <box flexDirection="row">
                <PromptFooterIdentity sessionID="ses_short" />
              </box>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 80, height: 2 },
    )
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("ses_short"))
    expect(app.captureCharFrame()).toContain("ses_short")
    expect(app.captureCharFrame()).not.toContain("ses_short…")
    app.renderer.destroy()
  })

  test("renders the branch first when present and omits it when absent", async () => {
    const config = createTuiResolvedConfig()
    const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
      import("../src/config"),
      import("../src/context/theme"),
    ])
    const present = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={config}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <box flexDirection="row">
                <PromptFooterIdentity branch="main" />
                <text>ses_0085fc701</text>
              </box>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 80, height: 2 },
    )
    present.renderer.start()
    await present.waitForFrame((frame) => frame.includes("ses_0085fc701"))
    const presentFrame = present.captureCharFrame()
    expect(presentFrame.indexOf("main")).toBeLessThan(presentFrame.indexOf("ses_0085fc701"))
    present.renderer.destroy()

    const absent = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={config}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <box flexDirection="row">
                <PromptFooterIdentity />
                <text>ses_0085fc701</text>
              </box>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 80, height: 2 },
    )
    absent.renderer.start()
    await absent.waitForFrame((frame) => frame.includes("ses_0085fc701"))
    expect(absent.captureCharFrame()).not.toContain("main")
    absent.renderer.destroy()
  })
})
