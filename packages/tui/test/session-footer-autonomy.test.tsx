/** @jsxImportSource @opentui/solid */
import type { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { SessionAutonomyView } from "@ycoding-ai/client"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { DataProvider } from "../src/context/data"
import { Keymap } from "../src/context/keymap"
import { RouteProvider } from "../src/context/route"
import { ThemeProvider } from "../src/context/theme"
import { Footer, FooterAutonomy } from "../src/routes/session/footer"
import { DEFAULT_THEMES } from "../src/theme/builtins"
import { readableTint } from "../src/theme/component"
import { resolveThemeFile } from "../src/theme/resolve"
import type { ProjectContext } from "../src/util/coordination"
import { autonomyView } from "./fixture/autonomy"
import { createApi, createFetch } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const widths = [32, 40, 60, 79, 80, 110, 120, 160, 200]

const member = (sessionID: string, title: string, role: "master" | "member") => ({
  sessionID,
  title,
  role,
  state: "idle" as const,
  directory: "/work/release",
  lastActivity: 0,
  pending: 0,
})

const project: ProjectContext = {
  role: "master",
  project: {
    id: "prj_release",
    name: "Release train",
    revision: 1,
    active: true,
    concurrency: null,
    created: 0,
    master: member("ses_footer", "Lead", "master"),
    members: [member("ses_docs", "Docs worker", "member")],
  },
}

const delegated = () =>
  autonomyView(
    {},
    { permissions: "auto", guardrails: "yolo", asleep: true, inherited: { permissions: "ses_parent", answers: "ses_root" } },
  )

const formats = {
  permissions: [/Permissions Auto/, /P Auto/, /P Auto/, /P:A/],
  guardrails: [/Guardrails YOLO/, /G YOLO/, /G YOLO/, /G:Y/],
  answers: [/Answers Manual/, /A Manual/, /A Manual/, /A:M/],
}

function palette(mode: "dark" | "light") {
  return resolveThemeFile(DEFAULT_THEMES.ycoding, mode, "ycoding")
}

function luminance(color: RGBA) {
  const [r, g, b] = color.toInts().slice(0, 3).map((value) => {
    const channel = value / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: RGBA, b: RGBA) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

function FooterHarness(props: {
  autonomy?: SessionAutonomyView
  project?: ProjectContext
  branch?: string
  onProjectTab?: () => void
  onProjectIdentity?: () => void
}) {
  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      { id: "project.members", title: "Project members", group: "Projects", bind: "<leader>p", run: () => props.onProjectTab?.() },
      { id: "command.palette.show", title: "Commands", group: "System", bind: "ctrl+p", run: () => undefined },
    ],
    bindings: ["project.members", "command.palette.show"],
  }))
  return (
    <Footer
      branch={props.branch}
      sessionID="ses_footer"
      autonomy={props.autonomy}
      project={props.project}
      onProjectTab={props.onProjectTab}
      onProjectIdentity={props.onProjectIdentity}
    />
  )
}

async function renderFooter(input: {
  width: number
  mode: "dark" | "light"
  autonomy?: () => SessionAutonomyView | undefined
  project?: ProjectContext
  branch?: string
  onProjectTab?: () => void
  onProjectIdentity?: () => void
}) {
  const config = createTuiResolvedConfig()
  const calls = createFetch()
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode={input.mode} source={{ discover: () => Promise.resolve({}) }}>
            <Keymap.Provider config={config}>
              <ClientProvider api={createApi(calls.fetch)}>
                <DataProvider>
                  <RouteProvider initialRoute={{ type: "session", sessionID: "ses_footer" }}>
                    <box width={input.width} flexDirection="column">
                      <FooterHarness
                        autonomy={input.autonomy?.()}
                        project={input.project}
                        branch={input.branch}
                        onProjectTab={input.onProjectTab}
                        onProjectIdentity={input.onProjectIdentity}
                      />
                    </box>
                  </RouteProvider>
                </DataProvider>
              </ClientProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: input.width, height: 3 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => /shells \d|sh\d/.test(frame) && /⌃p/.test(frame))
  return app
}

type App = Awaited<ReturnType<typeof renderFooter>>

function footerRow(app: App) {
  return app.captureCharFrame().split("\n")[0] ?? ""
}

function rowSpans(app: App) {
  return app.captureSpans().lines[0]?.spans ?? []
}

function expectOneRow(app: App, width: number) {
  const lines = app.captureCharFrame().split("\n")
  expect(lines[0].trim()).not.toBe("")
  expect(lines.slice(1).every((line) => line.trim() === "")).toBe(true)
  expect(lines[0].slice(0, 3).trim()).toBe("")
  expect(lines[0].slice(width - 3).trim()).toBe("")
}

function expectReadableChrome(app: App, mode: "dark" | "light") {
  const theme = palette(mode)
  const spans = rowSpans(app)
  for (const span of spans) {
    if (!span.text.trim()) continue
    expect(contrast(span.fg, span.bg)).toBeGreaterThanOrEqual(4.5)
  }
  expect(spans[0].bg.toInts()).toEqual(theme.background.default.toInts())
  expect(spans.at(-1)!.bg.toInts()).toEqual(theme.background.default.toInts())
}

function chip(app: App, fill: RGBA) {
  return rowSpans(app).filter((span) => span.bg.toInts().join() === fill.toInts().join() && span.text.trim())
}

function rank(row: string) {
  return Math.max(
    ...Object.values(formats).map((patterns) => patterns.findIndex((pattern) => pattern.test(row))),
  )
}

for (const mode of ["dark", "light"] as const) {
  test(`footer authority uses unfilled semantic ink on the canvas in ${mode}`, async () => {
    const theme = palette(mode)
    const app = await renderFooter({ width: 200, mode, autonomy: delegated })
    try {
      const spans = app.captureSpans().lines.flatMap((line) => line.spans)
      for (const word of ["Auto", "YOLO", "Manual"]) {
        const span = spans.find((item) => item.text.includes(word))
        expect(span).toBeDefined()
        expect(span!.bg.toInts()).toEqual(theme.background.default.toInts())
        expect(contrast(span!.fg, span!.bg)).toBeGreaterThanOrEqual(4.5)
      }
      expect(app.captureCharFrame()).toContain("●")
    } finally {
      app.renderer.destroy()
    }
  })
  test(`footer shows complete category-mode pairs with semantic ink in ${mode}`, async () => {
    const theme = palette(mode)
    const app = await renderFooter({ width: 200, mode, autonomy: delegated })
    try {
      const spans = app.captureSpans().lines.flatMap((line) => line.spans)
      for (const [ink, label] of [
        [theme.background.action.destructive.default, "Auto"],
        [theme.text.feedback.warning.default, "YOLO"],
        [theme.text.feedback.success.default, "Manual"],
      ] as const) {
        const span = spans.find((item) => item.text.trim() === label)!
        expect(span.fg.toInts()).toEqual(readableTint(ink, theme.background.default).toInts())
        expect(span.bg.toInts()).toEqual(theme.background.default.toInts())
      }
      expect(app.captureCharFrame()).toContain("● Permissions Auto")
      expect(app.captureCharFrame()).toContain("● Guardrails YOLO")
      expect(app.captureCharFrame()).toContain("● Answers Manual")
    } finally {
      app.renderer.destroy()
    }
  })

  test(`Project footer stays one fitted row with authority, sleep, shells and palette at every width in ${mode}`, async () => {
    const theme = palette(mode)
    const ranks: number[] = []
    for (const width of widths) {
      const app = await renderFooter({ width, mode, autonomy: delegated, project, branch: "main" })
      try {
        expectOneRow(app, width)
        const row = footerRow(app)
        for (const patterns of Object.values(formats)) expect(patterns.some((pattern) => pattern.test(row))).toBe(true)
        expect(row.search(/Permissions|P[ :]/)).toBeLessThan(row.search(/Guardrails|G[ :]/))
        expect(row.search(/Guardrails|G[ :]/)).toBeLessThan(row.search(/Answers|A [AMY]|A:/))
        expect(row).toMatch(/asleep|sl\*/)
        expect(row).toMatch(/shells 0|sh0/)
        expect(row).toContain("⌃p")
        expect(row).not.toMatch(/ses_parent|ses_root/)
        expect(row).not.toContain("inherited")
        expect(row.search(/shells 0|sh0/)).toBeLessThan(row.search(/Permissions|P[ :]/))
        if (width <= 40) expect(row).not.toContain("Master")
        if (width >= 60) expect(row).toContain("◇ Master")
        if (width >= 60) expect(row).toMatch(/⌃x p/)
        const projectAt = row.indexOf("⌃x p")
        if (projectAt >= 0) {
          const usageAt = row.indexOf("⌃x", projectAt + 1)
          expect(usageAt).toBeGreaterThan(projectAt)
          expect(row.lastIndexOf("⌃p")).toBeGreaterThan(usageAt)
        }
        ranks.push(rank(row))
        expect(rowSpans(app).filter((span) => span.text.includes("●"))).toHaveLength(3)
        expect(chip(app, theme.background.action.primary.focused).map((span) => span.text.trim())).toEqual([
          row.includes("sl*") ? "sl*" : "asleep",
        ])
        for (const span of rowSpans(app).filter((span) => span.text.includes("●"))) expect(contrast(span.fg, span.bg)).toBeGreaterThanOrEqual(4.5)
        expectReadableChrome(app, mode)
        if (width === 200) {
          for (const label of ["◇ Master of Release train", "main", "subagents 0", "shells 0", "Permissions Auto", "Guardrails YOLO", "Answers Manual", "asleep", "⌃x p project", "usage", "⌃p commands"])
            expect(row.replace(/ +/g, " ")).toContain(label)
          const spans = rowSpans(app)
          const key = spans.find((span) => span.text.includes("⌃x p"))!
          const label = spans.find((span) => span.text.includes("project"))!
          const usageLabel = spans.find((span) => span.text.includes("usage"))!
          expect(key.fg.toInts()).toEqual(theme.text.default.toInts())
          expect(label.fg.toInts()).toEqual(readableTint(theme.text.subdued, theme.background.default).toInts())
          expect(label.fg.toInts()).toEqual(usageLabel.fg.toInts())
          expect(row.indexOf("project")).toBeLessThan(row.indexOf("usage"))
          expect(row.slice(row.indexOf("project"), row.indexOf("⌃x", row.indexOf("project"))).trim()).toBe("project")
        }
        if (width === 32) {
          expect(row).toMatch(/P:A.*G:Y.*A:M/)
          expect(row).toContain("sl*")
        }
      } finally {
        app.renderer.destroy()
      }
    }
    for (let index = 1; index < ranks.length; index++) expect(ranks[index]).toBeLessThanOrEqual(ranks[index - 1])
  }, 60_000)

  test(`unknown stays subdued while known modes and disabled inheritance remain distinct in ${mode}`, async () => {
    const theme = palette(mode)
    const [view, setView] = createSignal<SessionAutonomyView | undefined>(undefined)
    for (const width of [32, 200]) {
      setView(undefined)
      const app = await renderFooter({ width, mode, autonomy: view })
      try {
        expectOneRow(app, width)
        const unknown = footerRow(app)
        if (width === 200) for (const label of ["Permissions unknown", "Guardrails unknown", "Answers unknown", "sleep unknown"]) expect(unknown).toContain(label)
        else expect(unknown).toMatch(/P:\? G:\? A:\? sl\?/)
        expect(unknown).not.toMatch(/Manual|asleep|inherited/)
        expect(rowSpans(app).filter((span) => span.text.trim() && span.bg.toInts().join() !== theme.background.default.toInts().join())).toEqual([])
        expectReadableChrome(app, mode)

        setView(autonomyView())
        await app.waitForFrame((frame) => /Manual|P:M/.test(frame))
        expectOneRow(app, width)
        const manual = footerRow(app)
        if (width === 200) {
          for (const label of ["Permissions Manual", "Guardrails Manual", "Answers Manual", "sleep"]) expect(manual).toContain(label)
          expect(manual).not.toContain("asleep")
        } else expect(manual).toMatch(/P:M.*G:M.*A:M.*sl(?![*?])/)
        expect(rowSpans(app).filter((span) => span.text.includes("●"))).toHaveLength(3)
        expectReadableChrome(app, mode)

        setView(autonomyView({}, { guardrails: "auto", guardrailsEnabled: false, inherited: { guardrails: "ses_root" } }))
        await app.waitForFrame((frame) => /disabled|G:A!/.test(frame))
        expectOneRow(app, width)
        const disabled = footerRow(app)
        expect(disabled).toMatch(width === 200 ? /Guardrails Auto +· disabled/ : /G:A *!/)
        expect(disabled).not.toContain("ses_root")
        expect(rowSpans(app).find((span) => span.text.trim() === (width === 200 ? "Auto" : "A"))?.fg.toInts()).toEqual(readableTint(theme.background.action.destructive.default, theme.background.default).toInts())
        expectReadableChrome(app, mode)
      } finally {
        app.renderer.destroy()
      }
    }
  }, 60_000)
}

test("FooterAutonomy picks the longest single-row format within its measured width", async () => {
  const [budget, setBudget] = createSignal(200)
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <box width={200} height={3} flexDirection="column">
              <FooterAutonomy autonomy={delegated()} width={budget()} />
            </box>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 200, height: 3 },
  )
  app.renderer.start()
  try {
    const full = ["● Permissions Auto", "● Guardrails YOLO", "● Answers Manual", " asleep "].join("  ")
    const short = ["● P Auto", "● G YOLO", "● A Manual", " asleep "].join("  ")
    const codes = ["●P:A", "●G:Y", "●A:M", " sl* "].join(" ")
    const compact = "●P:A ●G:Y ●A:M sl*"
    for (const [width, expected] of [
      [200, full],
      [full.length, full],
      [full.length - 1, short],
      [short.length, short],
      [short.length - 1, codes],
      [codes.length, codes],
      [codes.length - 1, compact],
      [compact.length, compact],
    ] as const) {
      setBudget(width)
      await app.waitForFrame((frame) => frame.split("\n")[0].trimEnd() === expected.trimEnd())
      const lines = app.captureCharFrame().split("\n")
      expect(lines[0].trimEnd()).toBe(expected.trimEnd())
      expect(lines.slice(1).every((line) => line.trim() === "")).toBe(true)
    }
  } finally {
    app.renderer.destroy()
  }
})

for (const mode of ["dark", "light"] as const) {
  test(`inline Project identity names the Project and role without the Master title in ${mode}`, async () => {
    const titled = { ...project.project, master: member("ses_footer", "Lead planner", "master") }
    for (const [role, expected] of [
      ["master", "◇ Master of Release train"],
      ["supervisor", "↑ Supervisor in Release train"],
      ["member", "↑ Member of Release train"],
    ] as const) {
      const app = await renderFooter({ width: 200, mode, autonomy: () => autonomyView(), project: { role, project: titled } })
      try {
        const row = footerRow(app)
        expect(row).toContain(expected)
        expect(row).not.toContain("Lead planner")
        expect(row).not.toContain("· master")
      } finally {
        app.renderer.destroy()
      }
    }
  })
}

test("Project identity and shortcut keep their click actions on the single footer row", async () => {
  const clicks: string[] = []
  const app = await renderFooter({
    width: 160,
    mode: "dark",
    autonomy: () => autonomyView(),
    project,
    onProjectTab: () => clicks.push("tab"),
    onProjectIdentity: () => clicks.push("identity"),
  })
  try {
    const row = footerRow(app)
    await app.mockMouse.click(row.indexOf("◇ Master") + 2, 0)
    await app.mockMouse.click(row.indexOf("project") + 2, 0)
    expect(clicks).toEqual(["identity", "tab"])
  } finally {
    app.renderer.destroy()
  }
})

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
      const frame = app.captureCharFrame().replace(/ +/g, " ")
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
