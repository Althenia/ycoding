/** @jsxImportSource @opentui/solid */
import { type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import type { JSX } from "solid-js"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { DataProvider } from "../src/context/data"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { LandingHero } from "../src/routes/home"
import { Footer } from "../src/routes/session/footer"
import { Header, headerSegments } from "../src/routes/session/header"
import { SubagentEconomicsSurface } from "../src/routes/session/subagent-economics"
import { DEFAULT_THEMES } from "../src/theme/builtins"
import { resolveThemeFile } from "../src/theme/v2/resolve"
import { createApi, createFetch } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE } from "./viewport"

const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")

const identity = {
  path: "~/Workspace/Personal/YCoding",
  branch: "main",
  agent: "Build",
  model: "anthropic/claude-opus-5",
  variant: "max",
}

async function render(view: () => JSX.Element, size: { width: number; height: number }, settle: string) {
  const config = createTuiResolvedConfig()
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <Keymap.Provider config={config}>{view()}</Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    size,
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(settle))
  return app
}

type ImageNode = Renderable & {
  source: string
  loadPromise: Promise<unknown>
  image?: unknown
}

function findImage(node: Renderable): ImageNode | undefined {
  if ("source" in node && "loadPromise" in node && "image" in node) return node as ImageNode
  return node
    .getChildren()
    .flatMap((child) => findImage(child) ?? [])
    .at(0)
}

describe("session footer identity", () => {
  test("drops the session id the sidebar already shows", async () => {
    const config = createTuiResolvedConfig()
    const calls = createFetch()
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={config}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <Keymap.Provider config={config}>
                <ClientProvider api={createApi(calls.fetch)}>
                  <DataProvider>
                    <Footer branch="main" sessionID="ses_0085fc701234567" autonomy={{ mode: "normal" }} />
                  </DataProvider>
                </ClientProvider>
              </Keymap.Provider>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 120, height: 3 },
    )
    app.renderer.start()

    try {
      await app.waitForFrame((frame) => frame.includes("subagents"))
      const frame = app.captureCharFrame()
      expect(frame).toContain("main")
      expect(frame).toContain("goal off")
      expect(frame).toContain("YOLO off")
      expect(frame).toContain("subagents 0")
      expect(frame).toContain("shells 0")
      expect(frame).not.toContain("ses_")
    } finally {
      app.renderer.destroy()
    }
  })
})

describe("header brand version", () => {
  for (const width of [120, DESIGN_VIEWPORT.width, DESIGN_VIEWPORT_WIDE.width]) {
    test(`renders the installation version beside the brand at ${width} columns`, async () => {
      const app = await render(() => <Header {...identity} state={{ type: "ready" }} />, { width, height: 4 }, `v${InstallationVersion}`)

      try {
        const line = app.captureCharFrame().split("\n")[1] ?? ""
        const image = findImage(app.renderer.root)
        expect(String(image?.source)).toEndWith("ycoding-mark-256.png")
        expect(image?.width).toBe(6)
        expect(image?.height).toBe(1)
        expect(image?.y).toBe(1)
        expect(line).toContain(`v${InstallationVersion}`)
        expect(line).not.toContain("y. ycoding")
        // The brand plus version must not squeeze the identity run or the status out of the strip.
        expect(line).toContain(headerSegments({ ...identity, width }).map((segment) => segment.label).join(" · "))
        const versionLabel = `v${InstallationVersion}`
        const firstSegment = headerSegments({ ...identity, width })[0]!.label
        expect(line.indexOf(firstSegment) - (line.indexOf(versionLabel) + versionLabel.length)).toBe(2)
        expect(line.trimEnd().length).toBe(width - 3)
        expect(line.trimEnd()).toEndWith("ready")

        const version = app
          .captureSpans()
          .lines.flatMap((row) => row.spans)
          .find((span) => span.text.includes(`v${InstallationVersion}`))
        expect(version?.fg.toInts()).toEqual(theme.text.subdued.toInts())
      } finally {
        app.renderer.destroy()
      }
    })
  }
})

describe("landing hero", () => {
  test("mounts the native brand image and preserves the sized empty fallback", async () => {
    const app = await render(() => <LandingHero />, { width: 80, height: 24 }, "terminal coding agent")

    const image = findImage(app.renderer.root)
    expect(image).toBeDefined()
    expect(String(image?.source)).toEndWith("ycoding-mark-256.png")
    image!.source = "/missing-ycoding-mark.png"
    await app.waitForFrame(() => findImage(app.renderer.root) === undefined)
    expect(findImage(app.renderer.root)).toBeUndefined()
    expect(app.captureCharFrame()).not.toContain("█   █")
    app.renderer.destroy()
  })
})

describe("subagent economics band", () => {
  test("carries a full-width top rule without moving its rows or columns", async () => {
    const app = await render(
      () => (
        <box width={DESIGN_VIEWPORT.width} flexDirection="column">
          <SubagentEconomicsSurface
            economics={{
              strip: [],
              context: "54.0K/1.0M",
              cacheHit: "74%",
              prefix: "1.0K",
              reads: "900",
              writes: "12",
              spent: "$0.13",
              rollsUpTo: "Parent session",
            }}
          />
        </box>
      ),
      { width: DESIGN_VIEWPORT.width, height: 8 },
      "SUBAGENT ECONOMICS",
    )

    try {
      const lines = app.captureCharFrame().split("\n")
      expect([...(lines[0] ?? "")].filter((character) => character === "─")).toHaveLength(DESIGN_VIEWPORT.width)
      expect(lines.findIndex((line) => line.includes("SUBAGENT ECONOMICS"))).toBe(1)
      expect(lines.findIndex((line) => line.includes("Context"))).toBe(3)
      expect(lines.findIndex((line) => line.includes("54.0K/1.0M"))).toBe(5)
      // Board 15 columns: Context 3, Cache hit 31, Prefix 58, Reads 85, Writes 112, Spent 139, Rolls up to 167.
      expect(lines[3]?.indexOf("Context")).toBe(3)
      expect(lines[3]?.indexOf("Cache hit")).toBe(31)
      expect(lines[3]?.indexOf("Prefix")).toBe(58)
      expect(lines[3]?.indexOf("Reads")).toBe(85)
      expect(lines[3]?.indexOf("Writes")).toBe(112)
      expect(lines[3]?.indexOf("Spent")).toBe(139)
      expect(lines[3]?.indexOf("Rolls up to")).toBe(167)
      expect(lines[6]?.trim()).toBe("")

      const rule = app
        .captureSpans()
        .lines[0]?.spans.find((span) => span.text.includes("─"))
      expect(rule?.fg.toInts()).toEqual(theme.border.default.toInts())
    } finally {
      app.renderer.destroy()
    }
  })
})
