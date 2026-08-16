/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createEffect, onMount, type JSX } from "solid-js"
import { DialogModel } from "../src/component/dialog-model"
import { ArgsProvider } from "../src/context/args"
import { ClientProvider } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { Keymap } from "../src/context/keymap"
import { LocalProvider } from "../src/context/local"
import { LocationProvider, useLocation } from "../src/context/location"
import { PermissionProvider } from "../src/context/permission"
import { RouteProvider } from "../src/context/route"
import { ThemeProvider } from "../src/context/theme"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { ConfigProvider } from "../src/config"
import { createApi, createEventStream, createFetch, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const state = "/tmp/ycoding/dialog-model-recent-footer"
const location = { directory: "/tmp/ycoding/packages/tui", project: { id: "proj_test", directory: "/tmp/ycoding" } }

test("recent and favorite rows render the formatted context window footer", async () => {
  await mkdir(state, { recursive: true })
  await Bun.write(
    path.join(state, "model.json"),
    JSON.stringify({
      recent: [{ providerID: "anthropic", modelID: "claude-sonnet-5" }],
      favorite: [{ providerID: "openai", modelID: "gpt-5-2" }],
      variant: {},
    }),
  )

  const app = await testRender(
    () => (
      <DialogProviders>
        <DialogFixture />
      </DialogProviders>
    ),
    { width: 140, height: 40 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Recent"))

  try {
    const rows = app.captureCharFrame().replace(/\n$/, "").split("\n")
    const recent = rows.find((row) => row.includes("Claude Sonnet 5"))
    expect(recent).toBeTruthy()
    expect(recent).toContain("262.144k")
    const favorite = rows.find((row) => row.includes("GPT-5.2"))
    expect(favorite).toBeTruthy()
    expect(favorite).toContain("300k")
  } finally {
    app.renderer.destroy()
  }
})

function DialogFixture() {
  const dialog = useDialog()
  onMount(() => dialog.replace(() => <DialogModel />))
  return <SyncLocation />
}

function SyncLocation() {
  const data = useData()
  const location = useLocation()
  createEffect(() => location.set(data.location.default()))
  return null
}

function DialogProviders(props: { children: JSX.Element }) {
  const events = createEventStream()
  const transport = createFetch(route, events)
  return (
    <TestTuiContexts paths={{ state }}>
      <ArgsProvider>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ToastProvider>
              <RouteProvider initialRoute={{ type: "home" }}>
                <ClientProvider api={createApi(transport.fetch)}>
                  <PermissionProvider>
                    <DataProvider>
                      <LocationProvider>
                        <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                          <LocalProvider>
                            <DialogProvider>{props.children}</DialogProvider>
                          </LocalProvider>
                        </ThemeProvider>
                      </LocationProvider>
                    </DataProvider>
                  </PermissionProvider>
                </ClientProvider>
              </RouteProvider>
            </ToastProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </ArgsProvider>
    </TestTuiContexts>
  )
}

function route(url: URL) {
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/model") return json({ location, data: models })
  if (url.pathname === "/api/provider") return json({ location, data: providers })
  if (url.pathname === "/api/integration") return json({ location, data: integrations })
  return undefined
}

const model = (input: { id: string; providerID: string; name: string; family: string; context: number; enabled?: boolean }) => ({
  id: input.id,
  modelID: input.id,
  providerID: input.providerID,
  name: input.name,
  family: input.family,
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [],
  time: { released: 1 },
  cost: [],
  status: "active" as const,
  enabled: input.enabled ?? true,
  limit: { context: input.context, output: 32_000 },
})

const models = [
  model({ id: "claude-opus-5", providerID: "anthropic", name: "Claude Opus 5", family: "deep reasoning", context: 200_000 }),
  model({ id: "claude-sonnet-5", providerID: "anthropic", name: "Claude Sonnet 5", family: "balanced", context: 262_144 }),
  model({ id: "claude-haiku-4-5", providerID: "anthropic", name: "Claude Haiku 4.5", family: "fast", context: 200_000 }),
  model({ id: "gpt-5-2", providerID: "openai", name: "GPT-5.2", family: "", context: 300_000 }),
  model({ id: "gemini-3-pro", providerID: "google", name: "Gemini 3 Pro", family: "connect first", context: 1_000_000, enabled: false }),
]

const providers = [
  { id: "anthropic", name: "Anthropic" },
  { id: "openai", name: "OpenAI" },
  { id: "google", name: "Not configured" },
]

const integrations = [
  { id: "anthropic", name: "Claude", methods: [], connections: [{ type: "credential" as const, id: "cred_test", label: "test" }] },
]