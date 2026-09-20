/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { InputRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
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
let switchGate: Promise<void> | undefined
let releaseSwitch: (() => void) | undefined
/** The Session switch response for the next POST; replaced per case. */
let switchResponse: () => Response | Promise<Response> = () => new Response(null, { status: 204 })

function model(input: { id: string; providerID: string; name: string; context: number }) {
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

/** Per-request gates, so a case can release one selection while a later one stays in flight. */
let switchGatePlan: Array<Promise<void> | undefined> = []

const route: FetchHandler = async (url, request) => {
  if (url.pathname === `/api/session/${sessionID}/model` && request.method === "POST") {
    const body = (await request.json()) as { model: { providerID: string; id: string; variant?: string } }
    switches.push({ sessionID, model: body.model })
    const planned = switchGatePlan[switches.length - 1]
    if (planned) await planned
    else if (switchGate) await switchGate
    return switchResponse()
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
  let currentAgent: string | undefined
  let pendingTarget: (PreferenceModel & { variant?: string }) | undefined
  let navigate: ((next: Route) => void) | undefined
  let cycle: ((direction: 1 | -1) => Promise<void>) | undefined
  let setAgent: ((id: string) => void) | undefined
  let variantCycle: (() => Promise<void>) | undefined

  function Probe() {
    const local = useLocal()
    const router = useRoute()
    navigate = router.navigate
    cycle = (direction) => local.model.cycle(direction)
    setAgent = (id) => local.agent.set(id)
    variantCycle = () => local.model.variant.cycle()
    createEffect(() => {
      current = local.model.current()
      currentVariant = local.model.variant.current()
      currentAgent = local.agent.current()?.id
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
    agent: () => currentAgent,
    pendingTarget: () => pendingTarget,
    setAgent: (id: string) => setAgent?.(id),
    variantCycle: () => {
      if (!variantCycle) throw new Error("LocalProvider is not mounted")
      return variantCycle()
    },
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

test("renders Daybreak as a separate model and switches using its catalog identity", async () => {
  switches.length = 0
  switchGate = undefined
  switchResponse = () => new Response(null, { status: 204 })
  const normal = model({ id: "gpt-5.6-luna", providerID: "openai", name: "GPT-5.6 Luna", context: 1_050_000 })
  const screen = await renderPicker({
    stateDir: "daybreak",
    order: [{ providerID: "openai", modelID: "gpt-5.6-luna-daybreak-blue" }],
    catalog: [...models, normal, { ...normal, id: "gpt-5.6-luna-daybreak-blue", name: "GPT-5.6 Luna · Daybreak Blue" }],
  })
  try {
    await screen.app.waitForFrame((frame) => frame.includes("GPT-5.6 Luna · Daybreak Blue"))
    const rows = screen.app.captureCharFrame().split("\n").filter((row) => row.includes("GPT-5.6 Luna"))
    expect(rows).toHaveLength(2)
    expect(rows.some((row) => !row.includes("Daybreak"))).toBe(true)
    screen.app.mockInput.pressEnter()
    await waitFor(() => screen.current()?.modelID === "gpt-5.6-luna-daybreak-blue", "the Daybreak preference")
    expect(switches).toEqual([{ sessionID, model: { providerID: "openai", id: "gpt-5.6-luna-daybreak-blue" } }])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("the picker awaits the durable switch before committing the local preference", async () => {
  switches.length = 0
  switchResponse = () => new Response(null, { status: 204 })
  switchGate = new Promise<void>((resolve) => (releaseSwitch = resolve))
  const screen = await renderPicker({
    stateDir: "picker",
    order: [{ providerID: "openai", modelID: "gpt-5-2" }],
  })
  try {
    expect(screen.current()).toEqual({ providerID: "anthropic", modelID: "claude-opus-5" })
    screen.app.mockInput.pressEnter()
    await waitFor(() => switches.length > 0, "the switch request")
    expect(switches).toEqual([{ sessionID, model: { providerID: "openai", id: "gpt-5-2" } }])
    // The preference is not committed while the switch is still in flight.
    expect(screen.current()).toEqual({ providerID: "anthropic", modelID: "claude-opus-5" })

    releaseSwitch?.()
    await waitFor(() => screen.current()?.modelID === "gpt-5-2", "the committed preference")
    expect(screen.current()).toEqual({ providerID: "openai", modelID: "gpt-5-2" })
  } finally {
    switchGate = undefined
    releaseSwitch = undefined
    await screen.dispose()
  }
}, 30_000)

test("a refused switch keeps the previous preference and reports the block", async () => {
  switches.length = 0
  switchGate = undefined
  switchResponse = () =>
    json(
      {
        _tag: "ModelSwitchBlockedError",
        status: "blocked",
        currentModel: { providerID: "anthropic", id: "claude-opus-5" },
        targetModel: { providerID: "openai", id: "gpt-5-2" },
        currentContextTokens: 250_000,
        targetSafeInputTokens: 200_000,
        requiredReductionTokens: 50_000,
        reason: "context-window-exceeded",
      },
      { status: 409 },
    )
  const screen = await renderPicker({
    stateDir: "picker-blocked",
    order: [{ providerID: "openai", modelID: "gpt-5-2" }],
  })
  try {
    screen.app.mockInput.pressEnter()
    await waitFor(() => switches.length > 0, "the switch request")
    await waitFor(() => screen.app.captureCharFrame().includes("Model switch blocked"), "the block warning")
    // A refusal must not silently retarget the preference the user sees.
    expect(screen.current()).toEqual({ providerID: "anthropic", modelID: "claude-opus-5" })
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("rapid cycling serializes against the latest desired target", async () => {
  switches.length = 0
  switchResponse = () => new Response(null, { status: 204 })
  switchGate = new Promise<void>((resolve) => (releaseSwitch = resolve))
  const screen = await renderPicker({
    stateDir: "cycle",
    recent: [
      { providerID: "anthropic", modelID: "claude-opus-5" },
      { providerID: "openai", modelID: "gpt-5-2" },
      { providerID: "google", modelID: "gemini-3-pro" },
    ],
  })
  try {
    expect(screen.current()).toEqual({ providerID: "anthropic", modelID: "claude-opus-5" })
    void screen.cycle(1)
    void screen.cycle(1)
    await waitFor(() => switches.length > 0, "the first cycle request")
    expect(switches).toEqual([{ sessionID, model: { providerID: "openai", id: "gpt-5-2" } }])

    releaseSwitch?.()
    await waitFor(() => switches.length > 1, "the queued cycle request")
    // The queued choice advances from the latest desired target, not the still-uncommitted preference.
    expect(switches).toEqual([
      { sessionID, model: { providerID: "openai", id: "gpt-5-2" } },
      { sessionID, model: { providerID: "google", id: "gemini-3-pro" } },
    ])
  } finally {
    switchGate = undefined
    releaseSwitch = undefined
    await screen.dispose()
  }
}, 30_000)

test("the home screen commits the next-Session preference without a Session API call", async () => {
  switches.length = 0
  switchGate = undefined
  switchResponse = () => new Response(null, { status: 204 })
  const screen = await renderPicker({
    stateDir: "home",
    route: { type: "home" },
    home: true,
    order: [{ providerID: "openai", modelID: "gpt-5-2" }],
  })
  try {
    screen.app.mockInput.pressEnter()
    await waitFor(() => screen.current()?.modelID === "gpt-5-2", "the local preference")
    expect(switches).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("a completion after navigation does not retarget the on-screen preference", async () => {
  switches.length = 0
  switchResponse = () => new Response(null, { status: 204 })
  switchGate = new Promise<void>((resolve) => (releaseSwitch = resolve))
  const screen = await renderPicker({
    stateDir: "navigation",
    order: [{ providerID: "openai", modelID: "gpt-5-2" }],
  })
  try {
    screen.app.mockInput.pressEnter()
    await waitFor(() => switches.length > 0, "the switch request")
    // The user leaves the Session while the durable switch is still in flight.
    screen.navigate({ type: "home" })
    await Bun.sleep(50)
    releaseSwitch?.()
    await waitFor(() => switches.length > 0, "the settled switch")
    await Bun.sleep(150)
    // The durable switch applies to the captured Session; the local preference keeps its own value.
    expect(screen.current()).toEqual({ providerID: "anthropic", modelID: "claude-opus-5" })
  } finally {
    switchGate = undefined
    releaseSwitch = undefined
    await screen.dispose()
  }
}, 30_000)

test("an agent switch during a pending selection does not retarget the new agent preference", async () => {
  switches.length = 0
  switchResponse = () => new Response(null, { status: 204 })
  switchGate = new Promise<void>((resolve) => (releaseSwitch = resolve))
  const screen = await renderPicker({
    stateDir: "agent-identity",
    order: [{ providerID: "openai", modelID: "gpt-5-2" }],
  })
  try {
    expect(screen.agent()).toBe("build")
    screen.app.mockInput.pressEnter()
    await waitFor(() => switches.length > 0, "the switch request")
    // The user switches agents inside the same Session while the model request is in flight. The
    // completed result belongs to the agent captured at selection time.
    screen.setAgent("reviewer")
    await Bun.sleep(50)
    releaseSwitch?.()
    await waitFor(() => screen.pendingTarget() === undefined, "the settled selection")
    expect(screen.agent()).toBe("reviewer")
    expect(screen.current()).toEqual({ providerID: "anthropic", modelID: "claude-opus-5" })
  } finally {
    switchGate = undefined
    releaseSwitch = undefined
    await screen.dispose()
  }
}, 30_000)

test("selecting the default variant clears a stored variant instead of retaining it", async () => {
  switches.length = 0
  switchResponse = () => new Response(null, { status: 204 })
  switchGate = undefined
  const screen = await renderPicker({
    stateDir: "variant-default",
    order: [{ providerID: "openai", modelID: "gpt-5-2" }],
    storedVariant: { "openai/gpt-5-2": "high" },
  })
  try {
    screen.app.mockInput.pressEnter()
    await waitFor(() => screen.current()?.modelID === "gpt-5-2", "the committed model")
    await waitFor(() => screen.variant() === undefined, "the cleared variant")
    // The durable switch omitted the variant, so the local preference must not keep sending `high`.
    expect(screen.variant()).toBeUndefined()
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("the header renders the desired target while the switch is still in flight", async () => {
  switches.length = 0
  switchResponse = () => new Response(null, { status: 204 })
  switchGate = new Promise<void>((resolve) => (releaseSwitch = resolve))
  const screen = await renderPicker({
    stateDir: "pending-progress",
    order: [{ providerID: "openai", modelID: "gpt-5-2" }],
  })
  try {
    screen.app.mockInput.pressEnter()
    await waitFor(() => switches.length > 0, "the switch request")
    await waitFor(
      () => screen.pendingTarget()?.modelID === "gpt-5-2",
      "the reactive pending target while switching",
    )
    // The preference has not committed yet, so the displayed target is progress, not the active model.
    expect(screen.current()).toEqual({ providerID: "anthropic", modelID: "claude-opus-5" })
    releaseSwitch?.()
    await waitFor(() => screen.pendingTarget() === undefined, "the settled pending target")
    expect(screen.current()).toEqual({ providerID: "openai", modelID: "gpt-5-2" })
  } finally {
    switchGate = undefined
    releaseSwitch = undefined
    await screen.dispose()
  }
}, 30_000)

test("keeps the latest pending target after an earlier rapid selection settles", async () => {
  switches.length = 0
  switchResponse = () => new Response(null, { status: 204 })
  switchGate = undefined
  let releaseFirst!: () => void
  let releaseSecond!: () => void
  const first = new Promise<void>((resolve) => (releaseFirst = resolve))
  const second = new Promise<void>((resolve) => (releaseSecond = resolve))
  switchGatePlan = [first, second]
  const screen = await renderPicker({
    stateDir: "rapid-progress",
    recent: [
      { providerID: "anthropic", modelID: "claude-opus-5" },
      { providerID: "openai", modelID: "gpt-5-2" },
      { providerID: "google", modelID: "gemini-3-pro" },
    ],
  })
  try {
    // Two rapid choices queue; the first is in flight and the second waits behind it.
    void screen.cycle(1)
    void screen.cycle(1)
    await waitFor(() => switches.length >= 1, "the first switch request")
    // Progress already shows the latest desired target while only the first is in flight.
    await waitFor(() => screen.pendingTarget()?.modelID === "gemini-3-pro", "the latest desired target")

    // The first selection settles and releases the second, which is still pending. Progress must
    // keep showing the latest target rather than disappearing with the first request.
    releaseFirst()
    await waitFor(() => switches.length === 2, "the queued second switch request")
    expect(screen.pendingTarget()?.modelID).toBe("gemini-3-pro")

    releaseSecond()
    await waitFor(() => screen.pendingTarget() === undefined, "the settled pending target")
    expect(screen.current()).toEqual({ providerID: "google", modelID: "gemini-3-pro" })
  } finally {
    releaseFirst()
    releaseSecond()
    switchGatePlan = []
    switchGate = undefined
    await screen.dispose()
  }
}, 30_000)

test("variant cycling for an existing Session performs a durable switch, not a local edit", async () => {
  switches.length = 0
  switchResponse = () => new Response(null, { status: 204 })
  switchGate = undefined
  const screen = await renderPicker({
    stateDir: "variant-cycle",
    withoutPicker: true,
    recent: [{ providerID: "openai", modelID: "gpt-5-2" }],
  })
  try {
    // The picker is absent, so the LocalProvider variant cycle is the only surface under test.
    await waitFor(() => screen.current()?.modelID === "gpt-5-2", "the session preference")
    switches.length = 0
    void screen.variantCycle()
    await waitFor(() => switches.length > 0, "the variant switch request")
    expect(switches).toEqual([{ sessionID, model: { providerID: "openai", id: "gpt-5-2", variant: "high" } }])
  } finally {
    await screen.dispose()
  }
}, 30_000)
