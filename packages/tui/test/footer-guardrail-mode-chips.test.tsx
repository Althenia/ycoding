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
import { localAutonomyView } from "../src/util/session-autonomy"

test("sleep chips wait for the machine read", () => {
  const autonomy = localAutonomyView({ mode: "normal", yolo: 0, sleep: {} })
  for (const machineAwake of [undefined, true, false]) {
    const chips = modeChips({ autonomy, machineAwake })
    expect(chips.find((chip) => chip.key === "yolo")).toEqual({ key: "yolo", label: "Ask first", tone: "off" })
    expect(chips.find((chip) => chip.key === "sleep")).toEqual({
      key: "sleep",
      label: machineAwake === false ? "asleep · machine may sleep" : "asleep",
      tone: machineAwake === false ? "warning" : "on",
    })
  }
})

for (const mode of ["dark", "light"] as const) {
  test(`renders sleep mode chips in ${mode}`, async () => {
    const [asleep, setAsleep] = createSignal(true)
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <ThemeProvider mode={mode} source={{ discover: () => Promise.resolve({}) }}>
              <box flexDirection="row" gap={2}>
                <ModeChips autonomy={localAutonomyView({ mode: "normal", yolo: 0, sleep: asleep() ? {} : undefined })} />
              </box>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 80, height: 3 },
    )
    app.renderer.start()
    try {
      await app.waitForFrame((frame) => frame.includes("asleep"))
      expect(app.captureCharFrame()).toContain("Ask first")
      expect(app.captureCharFrame()).not.toContain("machine may sleep")
      const spans = app.captureSpans().lines.flatMap((line) => line.spans)
      const manual = spans.find((span) => span.text.includes("Ask first"))
      const sleep = spans.find((span) => span.text.includes("asleep"))
      expect(manual?.bg.toInts()).not.toEqual(sleep?.bg.toInts())
      setAsleep(false)
      await app.waitForFrame((frame) => frame.includes("Ask first") && !frame.includes("asleep"))
    } finally {
      app.renderer.destroy()
    }
  })
}

test("derives the goal chip from the active goal status and labels the approval level", () => {
  const retained = { text: "ship", status: "active" as const, iteration: 3, noProgress: 3, maxNoProgress: 5 }
  const active = modeChips({ autonomy: localAutonomyView({ mode: "normal", yolo: false, goal: retained }) })[0]
  expect(active).toEqual({ key: "goal", label: "goal", tone: "on" })
  expect(active?.label).not.toContain("/")

  const completed = { text: "ship", status: "completed" as const, iteration: 3, noProgress: 0, maxNoProgress: 5 }
  expect(modeChips({ autonomy: localAutonomyView({ mode: "normal", yolo: false, goal: completed }) })).toEqual([
    { key: "goal", label: "goal off", tone: "off" },
    { key: "yolo", label: "Ask first", tone: "off" },
  ])

  expect(modeChips({ autonomy: localAutonomyView({ mode: "normal", yolo: true, goal: retained }) })).toEqual([
    { key: "goal", label: "goal", tone: "on" },
    { key: "yolo", label: "Tools + reviews", tone: "danger" },
  ])
  expect(
    modeChips({ autonomy: localAutonomyView({ mode: "normal", yolo: true, goal: retained }), guardrailPending: true })[0],
  ).toEqual({ key: "goal", label: "goal", tone: "on" })
  expect(modeChips({ autonomy: localAutonomyView({ mode: "normal", yolo: 1 }), guardrailPending: true })[0]).toEqual({
    key: "goal",
    label: "goal off",
    tone: "off",
  })
  expect(modeChips({ autonomy: localAutonomyView({ mode: "normal", yolo: 0 }) })).toEqual([
    { key: "goal", label: "goal off", tone: "off" },
    { key: "yolo", label: "Ask first", tone: "off" },
  ])
  expect(modeChips({})[1]).toEqual({ key: "yolo", label: "unknown", tone: "off" })
})

test("renders the idle, goal, level, and answers-auto footer states at 80 columns", async () => {
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <box flexDirection="column">
              <box>
                <ModeChips autonomy={localAutonomyView({ mode: "normal", yolo: false })} />
              </box>
              <box>
                <ModeChips
                  autonomy={localAutonomyView({
                    mode: "normal",
                    yolo: false,
                    goal: { text: "ship", status: "active", iteration: 3, noProgress: 3, maxNoProgress: 5 },
                  })}
                />
              </box>
              <box>
                <ModeChips autonomy={localAutonomyView({ mode: "normal", yolo: true })} />
              </box>
              <box>
                <ModeChips
                  autonomy={localAutonomyView({
                    mode: "normal",
                    yolo: true,
                    autoAnswer: true,
                    goal: { text: "ship", status: "active", iteration: 3, noProgress: 3, maxNoProgress: 5 },
                  })}
                />
              </box>
            </box>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 12 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("answers auto"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("goal off")
    expect(frame).toContain("Ask first")
    expect(frame).toContain("goal")
    expect(frame).not.toContain("goal 3/5")
    expect(frame).toContain("answers auto")
    expect(frame).toContain("Tools + reviews")
    const answersChip = app
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.trim() === "answers auto")
    if (!answersChip) throw new Error("expected the answers-auto chip")
    expect(answersChip.fg.toInts()).toEqual(RGBA.fromHex("#0F1115").toInts())
    expect(answersChip.bg.toInts()).toEqual(RGBA.fromHex("#F0BE62").toInts())
    expect(modeChips({ autonomy: localAutonomyView({ mode: "normal", yolo: true }) })[1]).toMatchObject({
      label: "Tools + reviews",
      tone: "danger",
    })
  } finally {
    app.renderer.destroy()
  }
})

test("renders readable warning ink on the light theme's filled answers chip", async () => {
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="light" source={{ discover: () => Promise.resolve({}) }}>
            <ModeChips
              autonomy={localAutonomyView({
                mode: "normal",
                yolo: true,
                autoAnswer: true,
                goal: { text: "ship", status: "active", iteration: 1, noProgress: 0, maxNoProgress: 5 },
              })}
            />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 4 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("answers auto"))
  try {
    const chip = app
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.trim() === "answers auto")
    expect(chip?.bg.toInts()).toEqual(RGBA.fromHex("#d68c27").toInts())
    expect(chip?.fg.toInts()).toEqual(RGBA.fromInts(0, 0, 0).toInts())
  } finally {
    app.renderer.destroy()
  }
})

test("pairs the Catppuccin warning band with readable ink instead of focused-primary ink", async () => {
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ theme: { name: "catppuccin", mode: "light" } })}>
          <ThemeProvider mode="light" source={{ discover: () => Promise.resolve({}) }}>
            <ModeChips
              autonomy={localAutonomyView({
                mode: "normal",
                yolo: true,
                autoAnswer: true,
                goal: { text: "ship", status: "active", iteration: 1, noProgress: 0, maxNoProgress: 5 },
              })}
            />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 4 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("answers auto"))
  try {
    const chip = app
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.trim() === "answers auto")
    expect(chip?.bg.toInts()).toEqual([223, 142, 29, 255])
    expect(chip?.fg.toInts()).toEqual([0, 0, 0, 255])
  } finally {
    app.renderer.destroy()
  }
})

test("turning auto-answer off removes only the answers chip", async () => {
  const [autoAnswer, setAutoAnswer] = createSignal(true)
  const autonomy = () =>
    localAutonomyView({
      mode: "normal",
      yolo: true,
      autoAnswer: autoAnswer(),
      goal: { text: "ship", status: "active", iteration: 3, noProgress: 3, maxNoProgress: 5 },
    })
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <ModeChips autonomy={autonomy()} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 4 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("answers auto"))
  setAutoAnswer(false)
  await app.waitForFrame((frame) => frame.includes("goal") && !frame.includes("answers auto"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("goal")
    expect(frame).not.toContain("goal off")
    expect(frame).not.toContain("answers auto")
    expect(frame).toContain("Tools + reviews")
  } finally {
    app.renderer.destroy()
  }
})
