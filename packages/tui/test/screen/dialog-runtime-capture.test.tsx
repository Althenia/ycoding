/** @jsxImportSource @opentui/solid */
import type { ProviderUsageListOutput } from "@ycoding-ai/client"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { BoxRenderable, type Renderable } from "@opentui/core"
import path from "node:path"
import type { JSX } from "solid-js"
import { ClientProvider } from "../../src/context/client"
import { DataProvider } from "../../src/context/data"
import { Keymap } from "../../src/context/keymap"
import { LocationProvider } from "../../src/context/location"
import { ThemeProvider } from "../../src/context/theme"
import { GuardrailPrompt } from "../../src/routes/session/guardrail"
import { PermissionPrompt } from "../../src/routes/session/permission"
import { ProviderUsageScreenContent } from "../../src/routes/session/provider-usage"
import { ToastProvider } from "../../src/ui/toast"
import { ConfigProvider } from "../../src/config"
import { createApi, createFetch } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE } from "../viewport"

const output = path.resolve(import.meta.dir, "../../../../.aphrodite/renders")
const viewports = [DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE] as const

const providerSnapshots: ProviderUsageListOutput["data"] = [
  {
    providerID: "provider-capture",
    label: "Provider capture",
    status: "available",
    source: "local_client_rpc",
    stability: "best_effort",
    updatedAt: 1_000,
    windows: [
      { id: "primary", label: "Primary", unit: "percent", used: 71 },
      { id: "secondary", label: "Secondary", unit: "percent" },
    ],
  },
]

const permissionRequest = {
  id: "permission_capture",
  sessionID: "session_capture",
  action: "shell",
  resources: ["rm -rf packages/tui/dist"],
  metadata: {},
  save: ["workspace"],
}

const guardrailRequest = {
  id: "guardrail_capture",
  rootSessionID: "session_capture",
  sessionID: "session_capture",
  action: "shell",
  resources: ["rm -rf ~/Downloads/cache-dump"],
  ruleIDs: ["standard.review.shell"],
  reason: "bash wants to write outside the workspace",
  standard: true,
}

test("captures runtime dialog frames at reference dimensions", async () => {
  for (const viewport of viewports) {
    for (const tab of ["overview", "usage"] as const) {
      await capture(`screen-runtime-provider-usage-${tab}-${viewport.width}x${viewport.height}.txt`, viewport, tab === "overview" ? "YCODING BACKEND" : "Provider capture", () => (
        <RuntimeProviders>
          <ProviderUsageFixture tab={tab} />
        </RuntimeProviders>
      ))
    }
    await capture(`dialog-runtime-permission-${viewport.width}x${viewport.height}.txt`, viewport, "Permission required", () => (
      <RuntimeProviders>
        <PermissionPrompt request={permissionRequest} />
      </RuntimeProviders>
    ))
    await capture(`dialog-runtime-guardrail-${viewport.width}x${viewport.height}.txt`, viewport, "Guardrail blocked", () => (
      <RuntimeProviders>
        <GuardrailPrompt request={guardrailRequest} />
      </RuntimeProviders>
    ))
  }
}, 120_000)

function ProviderUsageFixture(props: { tab: "overview" | "usage" }) {
  return (
    <ProviderUsageScreenContent
        initialTab={props.tab}
        snapshots={() => providerSnapshots}
        now={() => 1_000}
        backendUsage={() => ({
          logical: 3,
          physical: 3,
          helpers: 0,
          continued: 0,
          fallback: 0,
          tokens: { input: 2_863, output: 128, reasoning: 0, cache: { read: 247_996, write: 14_184 } },
          cacheReadReported: true,
          cost: 10.12,
          models: [
            {
              model: { providerID: "anthropic", id: "claude-opus-5", variant: "high" },
              requests: 1,
              tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 12_004 } },
              cacheReadReported: true,
              cost: 9.08,
            },
            {
              model: { providerID: "anthropic", id: "claude-sonnet-5" },
              requests: 2,
              tokens: { input: 1_452, output: 75, reasoning: 0, cache: { read: 27_324, write: 2_180 } },
              cacheReadReported: true,
              cost: 1.04,
            },
          ],
        })}
    />
  )
}

function RuntimeProviders(props: { children: JSX.Element }) {
  const transport = createFetch(() => undefined)
  return (
    <TestTuiContexts>
      <ConfigProvider config={createTuiResolvedConfig()}>
        <Keymap.Provider>
          <ClientProvider api={createApi(transport.fetch)}>
            <DataProvider>
              <LocationProvider>
                <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                  <ToastProvider>{props.children}</ToastProvider>
                </ThemeProvider>
              </LocationProvider>
            </DataProvider>
          </ClientProvider>
        </Keymap.Provider>
      </ConfigProvider>
    </TestTuiContexts>
  )
}

async function capture(
  name: string,
  viewport: (typeof viewports)[number],
  settle: string,
  view: () => JSX.Element,
) {
  const app = await testRender(view, viewport)
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(settle))

  try {
    const frame = app.captureCharFrame()
    const rows = frame.endsWith("\n") ? frame.slice(0, -1).split("\n") : frame.split("\n")
    expect(rows).toHaveLength(viewport.height)
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(viewport.width)
    if (name.includes("provider-usage")) assertProviderUsageScreen(rows, name.includes("provider-usage-usage"))
    if (name.includes("permission")) assertPermissionGrammar(app.renderer.root, rows, viewport.width)
    if (name.includes("guardrail")) assertGuardrailGrammar(app.renderer.root, rows, viewport.width)
    await Bun.write(path.join(output, name), rows.join("\n"))
  } finally {
    app.renderer.destroy()
  }
}

function assertProviderUsageScreen(rows: string[], quotas: boolean) {
  const frame = rows.join("\n")
  expect(frame).toContain("▌▐ Usage")
  expect(frame).toContain("refresh")
  expect(frame).toContain("back")
  expect(frame).toContain("Overview")
  expect(frame).toContain("Usage")
  if (quotas) {
    expect(frame).toContain("Provider capture")
    expect(frame).toContain("71%")
    expect(frame).toContain("Not reported")
    return
  }
  expect(frame).toContain("LIFETIME MODEL BREAKDOWN · YCODING BACKEND")
  expect(frame).toContain("247,996/14,184")
  expect(frame).not.toContain("Provider capture")
}

function assertPermissionGrammar(root: Renderable, rows: string[], width: number) {
  const panel = requireDialog(root, "session.permission")
  const title = origin(rows, "Permission required")
  expect(panel.width).toBe(width)
  expectAt(rows, title.row, width - 7, "esc")
  expectAt(rows, title.row + 3, title.column + 3, "S")
  expectAt(rows, title.row + 3, title.column + 4, "earch")
  expectAt(rows, title.row + 6, title.column, "bash wants to run")
  expectAt(rows, title.row + 7, title.column + 3, "rm -rf packages/tui/dist")
  expectAt(rows, title.row + 10, title.column, "Choose")
  expectAt(rows, title.row + 11, title.column + 3, "Allow once")
  expectAt(rows, title.row + 13, title.column + 3, "Allow for this session")
  expectAt(rows, title.row + 15, title.column + 3, "Deny")
  expectCenteredSelectionBand(panel, root, "session.permission.action.once")
}

function assertGuardrailGrammar(root: Renderable, rows: string[], width: number) {
  const panel = requireDialog(root, "session.guardrail")
  const title = origin(rows, "Guardrail blocked")
  expect(panel.width).toBe(width)
  expectAt(rows, title.row, width - 7, "esc")
  expectAt(rows, title.row + 3, title.column + 3, "S")
  expectAt(rows, title.row + 3, title.column + 4, "earch")
  expectAt(rows, title.row + 6, title.column, "bash wants to write outside the workspace")
  expectAt(rows, title.row + 7, title.column, "!")
  expectAt(rows, title.row + 7, title.column + 3, "rm -rf ~/Downloads/cache-dump")
  expectAt(rows, title.row + 7, width - 11, "Blocked")
  expectAt(rows, title.row + 10, title.column, "Choose")
  expectAt(rows, title.row + 11, title.column + 3, "Deny")
  expectAt(rows, title.row + 13, title.column + 3, "Allow once")
  expectAt(rows, title.row + 15, title.column + 3, "Allow for this session")
  expectAt(rows, title.row + 18, title.column + 3, "guardrails apply even in YOLO")
  expectCenteredSelectionBand(panel, root, "session.guardrail.action.reject")
}

function origin(rows: string[], title: string) {
  const row = rows.findIndex((line) => line.includes(title))
  if (row === -1) throw new Error(`missing dialog title ${title}`)
  return { row, column: rows[row].indexOf(title) }
}

function expectAt(rows: string[], row: number, column: number, text: string) {
  expect(rows[row]?.slice(column, column + text.length)).toBe(text)
}

function expectCenteredSelectionBand(panel: BoxRenderable, root: Renderable, id: string) {
  const selected = descendants(root).find((item) => item.id === id)
  if (!selected) throw new Error(`missing selected action ${id}`)
  const spacer = descendants(root).find((item) => item.id === `${id}.spacer`)
  const band = descendants(root).find((item) => item.id === `${id}.band`)
  if (!spacer || !band) throw new Error(`missing selected action band ${id}`)
  expect(selected.x).toBe(panel.x)
  expect(selected.width).toBe(panel.width - 1)
  expect(band.x).toBe(panel.x)
  expect(band.width).toBe(panel.width - 1)
  expect(band.height).toBe(1)
  expect(band.y).toBe(selected.y)
  expect(spacer.y).toBe(selected.y + 1)
  expect(spacer.height).toBe(1)
  expect(spacer.backgroundColor.toInts()).toEqual(panel.backgroundColor.toInts())
  expect(band.backgroundColor.toInts()).not.toEqual(panel.backgroundColor.toInts())
}

function requireDialog(root: Renderable, id: string) {
  const panel = descendants(root).find((item) => item.id === id)
  if (panel) return panel
  throw new Error(`missing dialog panel ${id}`)
}

function descendants(root: Renderable): BoxRenderable[] {
  return root.getChildren().flatMap((child) => (child instanceof BoxRenderable ? [child, ...descendants(child)] : []))
}
