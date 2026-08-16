/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { ConfigProvider } from "../src/config"
import { modeChips, ModeChips } from "../src/component/prompt/mode-chips"
import { ThemeProvider } from "../src/context/theme"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test("derives the goal chip from the current mode instead of retained goal state", () => {
  const active = modeChips({
    autonomy: { mode: "normal", yolo: false, goal: { runID: "run_footer_guardrail_mode_chips_fixture", text: "ship", status: "active", iteration: 3, noProgress: 3, maxNoProgress: 5 },
    },
  })[0]
  expect(active).toEqual({ key: "goal", label: "goal", tone: "on" })
  expect(active?.label).not.toContain("/")

  const completed = { runID: "run_footer_guardrail_mode_chips_fixture", text: "ship", status: "completed" as const, iteration: 3, noProgress: 0, maxNoProgress: 5 }
  expect(modeChips({ autonomy: { mode: "normal", yolo: false, goal: completed } })).toEqual([
    { key: "goal", label: "goal off", tone: "off" },
    { key: "yolo", label: "YOLO off", tone: "off" },
  ])

  const retained = { runID: "run_footer_guardrail_mode_chips_fixture", text: "ship", status: "active" as const, iteration: 3, noProgress: 3, maxNoProgress: 5 }
  expect(modeChips({ autonomy: { mode: "normal", yolo: true, goal: retained } })).toEqual([
    { key: "goal", label: "goal off", tone: "off" },
    { key: "yolo", label: "YOLO", tone: "danger" },
  ])
  expect(modeChips({ autonomy: { mode: "normal", yolo: true, goal: retained }, guardrailPending: true })[0]).toEqual({
    key: "goal",
    label: "guardrail blocked",
    tone: "warning",
  })
})

test("renders the idle, goal, YOLO, and guardrail footer states at 80 columns", async () => {
  const [guardrailPending] = createSignal(true)
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <box flexDirection="column">
              <box><ModeChips autonomy={{ mode: "normal", yolo: false }} /></box>
              <box>
                <ModeChips
                  autonomy={{ mode: "normal", yolo: false, goal: { runID: "run_footer_guardrail_mode_chips_fixture", text: "ship", status: "active", iteration: 3, noProgress: 3, maxNoProgress: 5 },
                  }}
                />
              </box>
              <box><ModeChips autonomy={{ mode: "normal", yolo: true }} /></box>
              <box>
                <ModeChips
                  autonomy={{ mode: "normal", yolo: true, goal: { runID: "run_footer_guardrail_mode_chips_fixture", text: "ship", status: "active", iteration: 3, noProgress: 3, maxNoProgress: 5 },
                  }}
                  guardrailPending={guardrailPending()}
                />
              </box>
            </box>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 6 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("guardrail blocked"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("goal off")
    expect(frame).toContain("YOLO off")
    expect(frame).toContain("goal")
    expect(frame).not.toContain("goal 3/5")
    expect(frame).toContain("guardrail blocked")
    expect(frame).toContain("YOLO")
    const guardrailChip = app.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.trim() === "guardrail blocked")
    if (!guardrailChip) throw new Error("expected the guardrail-blocked goal chip")
    expect(guardrailChip.fg.toInts()).toEqual(RGBA.fromHex("#0F1115").toInts())
    expect(guardrailChip.bg.toInts()).toEqual(RGBA.fromHex("#F0BE62").toInts())
    expect(modeChips({ autonomy: { mode: "normal", yolo: true } })[1]).toMatchObject({ label: "YOLO", tone: "danger" })
  } finally {
    app.renderer.destroy()
  }
})

test("clearing a pending guardrail restores the prior YOLO footer state", async () => {
  const [guardrailPending, setGuardrailPending] = createSignal(true)
  const autonomy = { mode: "normal" as const, yolo: true, goal: { runID: "run_footer_guardrail_mode_chips_fixture", text: "ship", status: "active" as const, iteration: 3, noProgress: 3, maxNoProgress: 5 },
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <ModeChips autonomy={autonomy} guardrailPending={guardrailPending()} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 2 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("guardrail blocked"))
  setGuardrailPending(false)
  await app.waitForFrame((frame) => frame.includes("goal off") && !frame.includes("blocked"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("goal off")
    expect(frame).not.toContain("blocked")
    expect(frame).toContain("YOLO")
  } finally {
    app.renderer.destroy()
  }
})
