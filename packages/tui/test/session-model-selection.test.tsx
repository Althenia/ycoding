/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { InputRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { ModelDaybreak } from "@ycoding-ai/client"
import { createEffect, onMount } from "solid-js"
import { DialogModel } from "../src/component/dialog-model"
import { ArgsProvider } from "../src/context/args"
import { ClientProvider } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { Keymap } from "../src/context/keymap"
import { LocalProvider, useLocal } from "../src/context/local"
import { LocationProvider, useLocation } from "../src/context/location"
import { RouteProvider, useRoute, type Route } from "../src/context/route"
import { ThemeProvider } from "../src/context/theme"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { Toast, ToastProvider } from "../src/ui/toast"
import { ConfigProvider } from "../src/config"
import { createApi, createEventStream, createFetch, json, type FetchHandler } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

/**
 * Explicit model selection must await the durable Session switch before committing the local
 * preference, serialize rapid choices against the latest desired target, keep the home preference
 * local, and never let a completion from a Session the user has left retarget the on-screen
 * preference. Only the HTTP boundary is controlled; LocalProvider and the picker run for real.
 */

const sessionID = "ses_model_selection"
const root = "/tmp/ycoding/session-model-selection"
const directory = "/tmp/ycoding/packages/tui"
const location = { directory, project: { id: "proj_model_selection", directory: "/tmp/ycoding" } }
const session = {
  id: sessionID,
  title: "Model selection",
  projectID: "proj_model_selection",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  time: { created: 1, updated: 2 },
}

type PreferenceModel = { providerID: string; modelID: string }

const switches: Array<{ sessionID: string; model: { providerID: string; id: string; variant?: string } }> = []

function model(input: {
  id: string
  providerID: string
  name: string
  context: number
  daybreak?: ModelDaybreak[]
}) {
  return {
    id: input.id,
    modelID: input.id,
    providerID: input.providerID,
    name: input.name,
    family: "",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 1 },
    cost: [],
    status: "active" as const,
    enabled: true,
    ...(input.daybreak === undefined ? {} : { daybreak: input.daybreak }),
    limit: { context: input.context, output: 32_000 },
  }
}

const models = [
  model({ id: "claude-opus-5", providerID: "anthropic", name: "Claude Opus 5", context: 200_000 }),
  {
    ...model({ id: "gpt-5-2", providerID: "openai", name: "GPT-5.2", context: 300_000 }),
    variants: [{ id: "high" }, { id: "low" }],
  },
  model({ id: "gemini-3-pro", providerID: "google", name: "Gemini 3 Pro", context: 1_000_000 }),
]

const route: FetchHandler = async (url, request) => {
  if (url.pathname === `/api/session/${sessionID}/model` && request.method === "POST") {
    const body = (await request.json()) as { model: { providerID: string; id: string; variant?: string } }
    switches.push({ sessionID, model: body.model })
    return new Response(null, { status: 204 })
  }
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === "/api/session/active") return json({ data: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === "/api/model") return json({ location, data: models })
  if (url.pathname === "/api/provider")
    return json({
      location,
      data: [
        { id: "anthropic", name: "Anthropic" },
        { id: "openai", name: "OpenAI" },
        { id: "google", name: "Google" },
      ],
    })
  if (url.pathname === "/api/agent")
    return json({
      location,
      data: [
        { id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] },
        { id: "reviewer", name: "Reviewer", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] },
      ],
    })
  if (url.pathname === "/api/integration")
    return json({
      location,
      data: [
        {
          id: "anthropic",
          name: "Claude",
          methods: [],
          connections: [{ type: "credential" as const, id: "cred_test", label: "test" }],
        },
      ],
    })
  return undefined
}

async function renderPicker(input: {
  catalog?: typeof models
  route?: Route
  order?: readonly PreferenceModel[]
  /** Home has no Session, so the picker omits the Session API target. */
  home?: boolean
  recent?: PreferenceModel[]
  /** A distinct state directory per case keeps one preference file out of another's. */
  stateDir: string
  /** Stored per-model variant preferences, so a default selection can prove it clears one. */
  storedVariant?: Record<string, string>
  /** Skips opening the picker, for cases that exercise LocalProvider actions only. */
  withoutPicker?: boolean
}) {
  const state = path.join(root, input.stateDir)
  await mkdir(state, { recursive: true })
  await Bun.write(
    path.join(state, "model.json"),
    JSON.stringify({ recent: input.recent ?? [], favorite: [], variant: input.storedVariant ?? {} }),
  )

  const events = createEventStream()
  const transport = createFetch((url, request) => {
    if (input.catalog && url.pathname === "/api/model") return json({ location, data: input.catalog })
    return route(url, request)
  }, events)
  let current: PreferenceModel | undefined
  let currentVariant: string | undefined
  let pendingTarget: (PreferenceModel & { variant?: string }) | undefined
  let navigate: ((next: Route) => void) | undefined
  let cycle: ((direction: 1 | -1) => Promise<void>) | undefined
  let variantCycle: (() => Promise<void>) | undefined
  let commitPending: ((model: { providerID: string; id: string; variant?: string }) => void) | undefined

  function Probe() {
    const local = useLocal()
    const router = useRoute()
    navigate = router.navigate
    cycle = (direction) => local.model.cycle(direction)
    variantCycle = () => local.model.variant.cycle()
    commitPending = (model) => local.model.commitPending(sessionID, model)
    createEffect(() => {
      current = local.model.current()
      currentVariant = local.model.variant.current()
      pendingTarget = local.model.pendingTarget(sessionID)
    })
    return null
  }

  function Fixture() {
    const dialog = useDialog()
    if (!input.withoutPicker)
      onMount(() =>
        dialog.replace(() => <DialogModel sessionID={input.home ? undefined : sessionID} order={input.order} />),
      )
    return <SyncLocation />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state }}>
        <ArgsProvider>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <Keymap.Provider>
              <ToastProvider>
                <RouteProvider initialRoute={input.route ?? { type: "session", sessionID }}>
                  <ClientProvider api={createApi(transport.fetch)}>
                    <DataProvider>
                      <LocationProvider>
                        <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                          <LocalProvider>
                            <DialogProvider>
                              <Probe />
                              <Fixture />
                            </DialogProvider>
                            <Toast />
                          </LocalProvider>
                        </ThemeProvider>
                      </LocationProvider>
                    </DataProvider>
                  </ClientProvider>
                </RouteProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </ArgsProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 40 },
  )
  app.renderer.start()
  if (!input.withoutPicker) {
    await app.waitForFrame((frame) => frame.includes("Select model"))
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
  }
  return {
    app,
    current: () => current,
    variant: () => currentVariant,
    pendingTarget: () => pendingTarget,
    variantCycle: () => {
      if (!variantCycle) throw new Error("LocalProvider is not mounted")
      return variantCycle()
    },
    commitPending: (model: { providerID: string; id: string; variant?: string }) => commitPending?.(model),
    cycle: (direction: 1 | -1) => {
      if (!cycle) throw new Error("LocalProvider is not mounted")
      return cycle(direction)
    },
    navigate: (next: Route) => navigate?.(next),
    async dispose() {
      app.renderer.destroy()
      await Bun.sleep(0)
    },
  }
}

function SyncLocation() {
  const data = useData()
  const location = useLocation()
  createEffect(() => location.set(data.location.default()))
  return null
}

async function waitFor(predicate: () => boolean, label: string, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${label}`)
}

test("renders one row for a Daybreak-advertising model and records the ordinary model id", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "daybreak",
    order: [{ providerID: "openai", modelID: "gpt-5.6-luna" }],
    catalog: [
      ...models,
      model({
        id: "gpt-5.6-luna",
        providerID: "openai",
        name: "GPT-5.6 Luna",
        context: 1_050_000,
        daybreak: ["daybreak_blue", "daybreak_red"],
      }),
    ],
  })
  try {
    await screen.app.waitForFrame((frame) => frame.includes("GPT-5.6 Luna"))
    const frame = screen.app.captureCharFrame()
    const rows = frame.split("\n").filter((row) => row.includes("GPT-5.6 Luna"))
    expect(rows).toHaveLength(1)
    expect(frame).not.toContain("· Daybreak Blue")
    expect(frame).not.toContain("· Daybreak Red")
    screen.app.mockInput.pressEnter()
    await waitFor(() => screen.pendingTarget()?.modelID === "gpt-5.6-luna", "the desired model")
    expect(screen.current()).toEqual({ providerID: "openai", modelID: "gpt-5.6-luna" })
    expect(switches).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("model and variant picker selection performs no Session request", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "picker",
    order: [{ providerID: "openai", modelID: "gpt-5-2" }],
  })
  try {
    screen.app.mockInput.pressEnter()
    await screen.app.waitForFrame((frame) => frame.includes("Select variant"))
    screen.app.mockInput.pressEnter()
    await waitFor(() => screen.pendingTarget()?.variant === "high", "the desired model variant")
    expect(screen.current()).toEqual({ providerID: "openai", modelID: "gpt-5-2" })
    expect(screen.variant()).toBe("high")
    expect(switches).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("rapid model cycling keeps only the newest Session target", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "cycle",
    withoutPicker: true,
    recent: [
      { providerID: "anthropic", modelID: "claude-opus-5" },
      { providerID: "openai", modelID: "gpt-5-2" },
      { providerID: "google", modelID: "gemini-3-pro" },
    ],
  })
  try {
    await waitFor(() => screen.current()?.modelID === "claude-opus-5", "the initial model")
    await Promise.all([screen.cycle(1), screen.cycle(1)])
    expect(screen.pendingTarget()).toEqual({ providerID: "google", modelID: "gemini-3-pro" })
    expect(screen.current()).toEqual({ providerID: "google", modelID: "gemini-3-pro" })
    expect(switches).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("switching routes does not leak one Session's desired model", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "navigation",
    order: [{ providerID: "google", modelID: "gemini-3-pro" }],
  })
  try {
    screen.app.mockInput.pressEnter()
    await waitFor(() => screen.pendingTarget()?.modelID === "gemini-3-pro", "the Session target")
    screen.navigate({ type: "session", sessionID: "ses_other" })
    await waitFor(() => screen.current()?.modelID === "claude-opus-5", "the other Session preference")
    screen.navigate({ type: "session", sessionID })
    await waitFor(() => screen.current()?.modelID === "gemini-3-pro", "the restored Session target")
    expect(switches).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("selecting a model resets a stored variant until a variant is chosen", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "variant-default",
    order: [{ providerID: "openai", modelID: "gpt-5-2" }],
    storedVariant: { "openai/gpt-5-2": "high" },
  })
  try {
    screen.app.mockInput.pressEnter()
    await waitFor(() => screen.pendingTarget()?.modelID === "gpt-5-2", "the desired model")
    expect(screen.pendingTarget()).toEqual({ providerID: "openai", modelID: "gpt-5-2" })
    expect(screen.variant()).toBeUndefined()
    expect(switches).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("rapid variant cycling advances from the newest pending variant", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "variant-cycle",
    withoutPicker: true,
    recent: [{ providerID: "openai", modelID: "gpt-5-2" }],
  })
  try {
    await waitFor(() => screen.current()?.modelID === "gpt-5-2", "the model preference")
    await Promise.all([screen.variantCycle(), screen.variantCycle()])
    expect(screen.pendingTarget()).toEqual({ providerID: "openai", modelID: "gpt-5-2", variant: "low" })
    expect(screen.variant()).toBe("low")
    expect(switches).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("variant cycling keeps advancing when the catalog lists the none sentinel first", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "variant-cycle-none",
    withoutPicker: true,
    recent: [{ providerID: "openai", modelID: "gpt-5-2" }],
    catalog: models.map((item) =>
      item.id === "gpt-5-2"
        ? { ...item, variants: [{ id: "none" }, { id: "high" }, { id: "low" }] }
        : item,
    ),
  })
  try {
    await waitFor(() => screen.current()?.modelID === "gpt-5-2", "the model preference")
    await screen.variantCycle()
    expect(screen.pendingTarget()).toEqual({ providerID: "openai", modelID: "gpt-5-2", variant: "high" })
    await screen.variantCycle()
    expect(screen.variant()).toBe("low")
    await screen.variantCycle()
    expect(screen.pendingTarget()).toEqual({ providerID: "openai", modelID: "gpt-5-2" })
    await screen.variantCycle()
    expect(screen.variant()).toBe("high")
    expect(switches).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("keeps the desired target until the matching prompt submission commits it", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "pending-commit",
    order: [{ providerID: "openai", modelID: "gpt-5-2" }],
  })
  try {
    screen.app.mockInput.pressEnter()
    await screen.app.waitForFrame((frame) => frame.includes("Select variant"))
    screen.app.mockInput.pressEnter()
    await waitFor(() => screen.pendingTarget()?.variant === "high", "the desired target")

    screen.commitPending({ providerID: "openai", id: "gpt-5-2", variant: "low" })
    expect(screen.pendingTarget()?.variant).toBe("high")

    screen.commitPending({ providerID: "openai", id: "gpt-5-2", variant: "high" })
    await waitFor(() => screen.pendingTarget() === undefined, "the committed target")
    expect(screen.current()).toEqual({ providerID: "openai", modelID: "gpt-5-2" })
    expect(screen.variant()).toBe("high")
    expect(switches).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("selecting a model with no variants does not inherit the prior model's stored variant", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "variant-no-catalog-variants",
    order: [{ providerID: "google", modelID: "gemini-3-pro" }],
    storedVariant: { "openai/gpt-5-2": "high" },
  })
  try {
    await waitFor(() => screen.current()?.modelID === "claude-opus-5", "the session model")
    screen.app.mockInput.pressEnter()
    await waitFor(() => screen.pendingTarget()?.modelID === "gemini-3-pro", "the desired model")
    expect(screen.pendingTarget()).toEqual({ providerID: "google", modelID: "gemini-3-pro" })
    expect(screen.variant()).toBeUndefined()
    expect(switches).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("selecting a model that does not offer the stored variant value clears it", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "variant-unoffered",
    order: [{ providerID: "openai", modelID: "gpt-5-2" }],
    storedVariant: { "openai/gpt-5-2": "max" },
  })
  try {
    screen.app.mockInput.pressEnter()
    await screen.app.waitForFrame((frame) => frame.includes("Select variant"))
    expect(screen.variant()).toBeUndefined()
    screen.app.mockInput.pressEscape()
    await waitFor(() => screen.pendingTarget()?.modelID === "gpt-5-2", "the desired model")
    expect(screen.pendingTarget()).toEqual({ providerID: "openai", modelID: "gpt-5-2" })
    expect(screen.variant()).toBeUndefined()
    expect(switches).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("the home screen commits the next-Session preference without a Session API call", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "home",
    route: { type: "home" },
    home: true,
    order: [{ providerID: "google", modelID: "gemini-3-pro" }],
  })
  try {
    screen.app.mockInput.pressEnter()
    await waitFor(() => screen.current()?.modelID === "gemini-3-pro", "the home preference")
    expect(screen.pendingTarget()).toBeUndefined()
    expect(switches).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)
