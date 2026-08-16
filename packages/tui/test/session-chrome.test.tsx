/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import { modeChips } from "../src/component/prompt/mode-chips"
import {
  headerSegments,
  headerStatusLabel,
  type SessionHeaderState,
} from "../src/routes/session/header"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

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
  const cases: Array<[SessionHeaderState, string]> = [
    [{ type: "ready" }, "ready"],
    [{ type: "working", elapsed: 4.14 }, "working 4.1s"],
    [{ type: "awaiting-input", count: 1 }, "1 subagent awaiting input"],
    [{ type: "awaiting-input", count: 2 }, "2 subagents awaiting input"],
    [{ type: "provider-error", code: 429 }, "provider error \u00b7 429"],
    [{ type: "provider-error" }, "provider error"],
    [{ type: "yolo" }, "YOLO \u00b7 auto-approve"],
  ]

  for (const [state, expected] of cases) {
    test(`renders ${expected}`, () => {
      expect(headerStatusLabel(state)).toBe(expected)
    })
  }
})

async function renderHeader(width: number, state: SessionHeaderState) {
  const config = createTuiResolvedConfig()
  const [{ ConfigProvider }, { ThemeProvider }, { Header }] = await Promise.all([
    import("../src/config"),
    import("../src/context/theme"),
    import("../src/routes/session/header"),
  ])

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <Header {...identity} state={state} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height: 6 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("ycoding"))
  return app
}

describe("autonomy mode chips", () => {
  test("shows both modes off for a normal session", () => {
    expect(modeChips({ autonomy: { mode: "normal" } })).toEqual([
      { key: "goal", label: "goal off", tone: "off" },
      { key: "yolo", label: "YOLO off", tone: "off" },
    ])
  })

  test("inverts YOLO because it auto-approves", () => {
    expect(modeChips({ autonomy: { mode: "yolo" } })[1]).toEqual({
      key: "yolo",
      label: "YOLO",
      tone: "danger",
    })
  })

  test("shows goal progress against the no-progress bound while active", () => {
    const autonomy = {
      mode: "goal",
      goal: { text: "ship", status: "active", iteration: 7, noProgress: 3, maxNoProgress: 5 },
    } as const
    expect(modeChips({ autonomy })[0]).toEqual({ key: "goal", label: "goal 3/5", tone: "on" })
  })

  test("keeps a terminal goal status visible after leaving goal mode", () => {
    const autonomy = {
      mode: "normal",
      goal: { text: "ship", status: "completed", iteration: 7, noProgress: 0, maxNoProgress: 5 },
    } as const
    expect(modeChips({ autonomy })[0]).toEqual({ key: "goal", label: "goal completed", tone: "off" })
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
                <ModeChips autonomy={{ mode: "yolo" }} />
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
  test("shows brand, identity, and status on the strip at 160 columns", async () => {
    const app = await renderHeader(160, { type: "working", elapsed: 4.1 })
    const frame = app.captureCharFrame()
    expect(frame).toContain("y. ycoding")
    expect(frame).toContain("~/Workspace/Personal/YCoding")
    expect(frame).toContain("main")
    expect(frame).toContain("working 4.1s")
    app.renderer.destroy()
  })

  test("drops the path and branch at 80 columns instead of shrinking the state word", async () => {
    const app = await renderHeader(80, { type: "ready" })
    const frame = app.captureCharFrame()
    expect(frame).toContain("y. ycoding")
    expect(frame).toContain("claude-opus-5")
    expect(frame).not.toContain("Workspace")
    expect(frame).toContain("ready")
    app.renderer.destroy()
  })

  test("renders the danger rule under the header in YOLO", async () => {
    const app = await renderHeader(100, { type: "yolo" })
    const frame = app.captureCharFrame()
    expect(frame).toContain("YOLO \u00b7 auto-approve")
    expect(frame).toContain("\u2500".repeat(20))
    app.renderer.destroy()
  })

  test("reveals the binding for the focused segment only", async () => {
    const config = createTuiResolvedConfig()
    const [{ ConfigProvider }, { ThemeProvider }, { Header }] = await Promise.all([
      import("../src/config"),
      import("../src/context/theme"),
      import("../src/routes/session/header"),
    ])
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={config}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <Header {...identity} state={{ type: "ready" }} focused="model" />
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 160, height: 6 },
    )
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("ycoding"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("\u2303x m change")
    expect(frame).not.toContain("\u2303t cycle")
    app.renderer.destroy()
  })
})
