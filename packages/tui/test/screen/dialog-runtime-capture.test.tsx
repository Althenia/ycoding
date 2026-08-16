/** @jsxImportSource @opentui/solid */
import type { ProviderUsageListOutput } from "@ycoding-ai/client"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import path from "node:path"
import type { JSX } from "solid-js"
import { ClientProvider } from "../../src/context/client"
import { DataProvider } from "../../src/context/data"
import { Keymap } from "../../src/context/keymap"
import { LocationProvider } from "../../src/context/location"
import { ThemeProvider } from "../../src/context/theme"
import { GuardrailPrompt } from "../../src/routes/session/guardrail"
import { PermissionPrompt } from "../../src/routes/session/permission"
import { ProviderUsageDialogContent } from "../../src/routes/session/provider-usage"
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
  resources: ["bun test"],
  metadata: {},
  save: ["workspace"],
}

const guardrailRequest = {
  id: "guardrail_capture",
  rootSessionID: "session_capture",
  sessionID: "session_capture",
  action: "shell",
  resources: ["bun test"],
  ruleIDs: ["standard.review.shell"],
  reason: "Shell command needs review",
  standard: true,
}

test("captures runtime dialog frames at reference dimensions", async () => {
  for (const viewport of viewports) {
    await capture(`dialog-runtime-provider-usage-${viewport.width}x${viewport.height}.txt`, viewport, "Provider Usage", () => (
      <RuntimeProviders>
        <ProviderUsageDialogContent snapshots={() => providerSnapshots} now={() => 1_000} />
      </RuntimeProviders>
    ))
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
    await Bun.write(path.join(output, name), rows.join("\n"))
  } finally {
    app.renderer.destroy()
  }
}
