/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import type { SessionAutonomyView } from "@ycoding-ai/client"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { FooterAutonomy } from "../src/routes/session/footer"
import { DEFAULT_THEMES } from "../src/theme/builtins"
import { resolveThemeFile } from "../src/theme/resolve"
import { autonomyView } from "./fixture/autonomy"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

for (const mode of ["dark", "light"] as const) {
  for (const width of [32, 40, 50, 60, 80, 200]) {
    test(`footer indicators wrap whole labels at ${width} columns in ${mode}`, async () => {
      const [view, setView] = createSignal<SessionAutonomyView | undefined>(autonomyView(
        {},
        { permissions: "auto", guardrails: "yolo", asleep: true, inherited: { permissions: "ses_parent", answers: "ses_root" } },
      ))
      const app = await testRender(
        () => (
          <TestTuiContexts>
            <ConfigProvider config={createTuiResolvedConfig()}>
              <ThemeProvider mode={mode} source={{ discover: () => Promise.resolve({}) }}>
                <box width={width} paddingLeft={3} paddingRight={3}>
                  <FooterAutonomy autonomy={view()} />
                </box>
              </ThemeProvider>
            </ConfigProvider>
          </TestTuiContexts>
        ),
        { width, height: 8 },
      )
      app.renderer.start()
      try {
        await app.waitForFrame((frame) => frame.includes("asleep"))
        const labels = ["Permissions Auto · inherited", "Guardrails YOLO", "Answers Manual · inherited", "asleep"]
        const frame = app.captureCharFrame()
        for (const label of labels) {
          expect(frame.replace(/\s+/g, " ")).toContain(label)
          expect(frame.split("\n").some((line) => line.includes(label.split(" · ")[0]!))).toBe(true)
          if (label.length <= width - 6) expect(frame.split("\n").some((line) => line.includes(label))).toBe(true)
        }
        expect(frame).not.toContain("Permissions Manual")
        expect(frame).not.toContain("review box")
        expect(frame).not.toContain("ses_parent")
        const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, mode, "ycoding")
        const spans = app.captureSpans().lines.flatMap((line) => line.spans)
        for (const label of labels) {
          expect(spans.find((span) => span.text.includes(label.split(" · ")[0]!))?.fg.toInts()).toEqual(
            (label.startsWith("Answers") ? theme.text.feedback.success.default : theme.text.feedback.warning.default).toInts(),
          )
        }
        setView(undefined)
        await app.waitForFrame((frame) => frame.includes("Permissions unknown"))
        const unknown = app.captureCharFrame()
        for (const title of ["Permissions", "Guardrails", "Answers"]) expect(unknown).toContain(`${title} unknown`)
        expect(unknown).not.toMatch(/Manual|asleep|inherited/)
        expect(app.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("Permissions unknown"))?.fg.toInts()).toEqual(theme.text.subdued.toInts())
        setView(autonomyView({}, { guardrails: "auto", guardrailsEnabled: false, inherited: { guardrails: "ses_root" } }))
        await app.waitForFrame((frame) => frame.includes("disabled"))
        const annotated = app.captureCharFrame().split("\n")
        const guardrails = annotated.findIndex((line) => line.includes("Guardrails Auto"))
        const answers = annotated.findIndex((line) => line.includes("Answers Manual"))
        expect(guardrails).toBeGreaterThanOrEqual(0)
        expect(answers).toBeGreaterThanOrEqual(guardrails)
        expect(app.captureCharFrame().indexOf("Answers Manual")).toBeGreaterThan(app.captureCharFrame().indexOf("Guardrails Auto"))
        expect(annotated.slice(guardrails, answers + 1).join(" ").split("Answers Manual")[0]!.replace(/\s+/g, " ")).toContain("Guardrails Auto · inherited · disabled")
        for (const line of annotated) {
          expect(line.slice(0, 3).trim()).toBe("")
          expect(line.slice(width - 3).trim()).toBe("")
        }
        if (width - 6 >= "Guardrails Auto · inherited · disabled".length)
          expect(annotated[guardrails]).toContain("Guardrails Auto · inherited · disabled")
      } finally {
        app.renderer.destroy()
      }
    })
  }
}

test("footer modes remain independent from goals, family sleep, and guardrail availability", async () => {
  const [view, setView] = createSignal(autonomyView())
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <FooterAutonomy autonomy={view()} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 110, height: 4 },
  )
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("Permissions Manual"))
    for (const modes of [
      {},
      { permissions: "yolo", guardrails: "yolo", answers: "yolo" },
      { permissions: "auto" },
      { guardrails: "auto" },
      { answers: "auto" },
      { permissions: "auto", guardrails: "yolo", answers: "yolo" },
      { permissions: "auto", guardrails: "auto", answers: "auto" },
    ] as const) {
      setView(autonomyView({ ...modes, goal: { text: "Ship safely", status: "active", iteration: 1, noProgress: 0, maxNoProgress: 3 } }, { guardrailsEnabled: false, asleep: true }))
      await app.waitForFrame((frame) => frame.includes("asleep") && (["permissions", "guardrails", "answers"] as const).every((category) => {
        const row = category === "permissions" ? "Permissions" : category === "guardrails" ? "Guardrails" : "Answers"
        const expected = view().effective[category]
        return frame.includes(`${row} ${expected === "yolo" ? "YOLO" : expected === "auto" ? "Auto" : "Manual"}`)
      }))
      const frame = app.captureCharFrame()
      for (const [category, title] of [["permissions", "Permissions"], ["guardrails", "Guardrails"], ["answers", "Answers"]] as const) {
        const expected = view().effective[category]
        expect(frame).toContain(`${title} ${expected === "yolo" ? "YOLO" : expected === "auto" ? "Auto" : "Manual"}`)
      }
      expect(frame).toContain(`Guardrails ${view().effective.guardrails === "yolo" ? "YOLO" : view().effective.guardrails === "auto" ? "Auto" : "Manual"} · disabled`)
      expect(frame).not.toMatch(/review box|goal|Ship safely/)
    }
  } finally {
    app.renderer.destroy()
  }
})
