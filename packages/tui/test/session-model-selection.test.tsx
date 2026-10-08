/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { InputRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { ModelDaybreak, ModelProfile } from "@ycoding-ai/client"
import { createEffect, onMount } from "solid-js"
import { DialogModel, type DialogModelResult } from "../src/component/dialog-model"
import { DialogVariant } from "../src/component/dialog-variant"
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

type PreferenceModel = { providerID: string; modelID: string; profile?: string }

const switches: Array<{ sessionID: string; model: { providerID: string; id: string; variant?: string; profile?: string } }> = []
const integrationWrites: string[] = []

function model(input: {
  id: string
  providerID: string
  name: string
  context: number
  variants?: string[]
  daybreak?: ModelDaybreak[]
  profiles?: ModelProfile[]
  enabled?: boolean
}) {
  return {
    id: input.id,
    modelID: input.id,
    providerID: input.providerID,
    name: input.name,
    family: "",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: (input.variants ?? []).map((id) => ({ id })),
    time: { released: 1 },
    cost: [],
    status: "active" as const,
    enabled: input.enabled ?? true,
    ...(input.profiles === undefined ? {} : { profiles: input.profiles }),
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
    const body = (await request.json()) as { model: { providerID: string; id: string; variant?: string; profile?: string } }
    switches.push({ sessionID, model: body.model })
    return new Response(null, { status: 204 })
  }
  if (url.pathname.includes("/integration") && request.method !== "GET") integrationWrites.push(url.pathname)
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
        {
          id: "build",
          name: "Build",
          request: { headers: {}, body: {} },
          mode: "primary",
          hidden: false,
          permissions: [],
        },
        {
          id: "reviewer",
          name: "Reviewer",
          request: { headers: {}, body: {} },
          mode: "primary",
          hidden: false,
          permissions: [],
        },
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
  sessionModel?: { providerID: string; id: string; variant?: string; profile?: string }
  /** Skips opening the picker, for cases that exercise LocalProvider actions only. */
  withoutPicker?: boolean
  variantPicker?: boolean
  onComplete?: (result: DialogModelResult) => void
}) {
  const state = path.join(root, input.stateDir)
  await mkdir(state, { recursive: true })
  await Bun.write(
    path.join(state, "model.json"),
    JSON.stringify({ recent: input.recent ?? [], favorite: [], variant: input.storedVariant ?? {} }),
  )

  const events = createEventStream()
  const transport = createFetch((url, request) => {
    if (url.pathname === "/api/model/default") {
      const selected = (input.catalog ?? models).find((item) => item.enabled)
      return json({
        location,
        data: selected
          ? { selection: { providerID: selected.providerID, id: selected.id } }
          : null,
      })
    }
    if (input.catalog && url.pathname === "/api/model") return json({ location, data: input.catalog })
    if (input.sessionModel && url.pathname === "/api/session")
      return json({ data: [{ ...session, model: input.sessionModel }], cursor: {} })
    if (input.sessionModel && url.pathname === `/api/session/${sessionID}`)
      return json({ data: { ...session, model: input.sessionModel } })
    return route(url, request)
  }, events)
  let current: PreferenceModel | undefined
  let currentVariant: string | undefined
  let reasoning: boolean | undefined
  let pendingTarget: (PreferenceModel & { variant?: string }) | undefined
  let navigate: ((next: Route) => void) | undefined
  let cycle: ((direction: 1 | -1) => Promise<void>) | undefined
  let variantCycle: (() => Promise<void>) | undefined
  let commitPending: ((model: { providerID: string; id: string; variant?: string; profile?: string }) => void) | undefined
  let select: ((model: PreferenceModel & { variant?: string }) => Promise<void>) | undefined
  let eventSeq = 0
  let sessionLoaded = false
  let modelReady = false
  let durableModel: { providerID: string; id: string; variant?: string; profile?: string } | undefined

  function Probe() {
    const local = useLocal()
    const data = useData()
    const router = useRoute()
    onMount(() => void data.session.sync(sessionID))
    navigate = router.navigate
    cycle = (direction) => local.model.cycle(direction)
    variantCycle = () => local.model.variant.cycle()
    commitPending = (model) => local.model.commitPending(sessionID, model)
    select = (model) => local.model.select(model, { sessionID: input.home ? undefined : sessionID })
    createEffect(() => {
      current = local.model.current()
      currentVariant = local.model.variant.current()
      reasoning = local.model.parsed().reasoning
      pendingTarget = local.model.pendingTarget(sessionID)
      sessionLoaded = data.session.get(sessionID) !== undefined
      durableModel = data.session.get(sessionID)?.model
      modelReady = local.model.ready
    })
    return null
  }

  function Fixture() {
    const dialog = useDialog()
    if (!input.withoutPicker)
      onMount(() =>
        dialog.replace(() =>
          input.variantPicker ? (
            <DialogVariant sessionID={input.home ? undefined : sessionID} />
          ) : (
            <DialogModel
              sessionID={input.home ? undefined : sessionID}
              order={input.order}
              onComplete={input.onComplete}
            />
          ),
        ),
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
  await app.waitFor(() => sessionLoaded && modelReady)
  if (!input.withoutPicker) {
    await app.waitForFrame((frame) => frame.includes(input.variantPicker ? "Select variant" : "Select model"))
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
  }
  return {
    app,
    current: () => current,
    variant: () => currentVariant,
    reasoning: () => reasoning,
    durableModel: () => durableModel,
    pendingTarget: () => pendingTarget,
    variantCycle: () => {
      if (!variantCycle) throw new Error("LocalProvider is not mounted")
      return variantCycle()
    },
    commitPending: (model: { providerID: string; id: string; variant?: string; profile?: string }) => commitPending?.(model),
    select: (model: PreferenceModel & { variant?: string }) => {
      if (!select) throw new Error("LocalProvider is not mounted")
      return select(model)
    },
    modelSelected: (model: { providerID: string; id: string; variant?: string; profile?: string }) => {
      eventSeq += 1
      events.emit({
        id: `evt_selected_${eventSeq}`,
        created: eventSeq + 2,
        durable: { aggregateID: sessionID, seq: eventSeq, version: 1 },
        type: "session.model.selected",
        location: { directory },
        data: { sessionID, model },
      })
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

async function selectProviderDefault(screen: Awaited<ReturnType<typeof renderPicker>>) {
  await waitFor(() => {
    const frame = screen.app.captureCharFrame()
    return frame.includes("Provider profile") || frame.includes("Select variant") || screen.pendingTarget() !== undefined
  }, "profile, variant, or completed model selection")
  if (!screen.app.captureCharFrame().includes("Provider profile")) return
  screen.app.mockInput.pressKey("HOME")
  screen.app.mockInput.pressEnter()
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

test("profile-only Session selection stays pending without activating an integration", async () => {
  switches.length = 0
  integrationWrites.length = 0
  const screen = await renderPicker({
    stateDir: "profile-only-selection",
    withoutPicker: true,
    sessionModel: { providerID: "anthropic", id: "claude-opus-5", profile: "Work" },
    catalog: models.map((item) => item.id === "claude-opus-5"
      ? { ...item, profiles: [{ name: "Work", active: true }, { name: "Personal", active: false }] }
      : item),
  })
  try {
    await waitFor(() => screen.current()?.modelID === "claude-opus-5", "the Session model")
    await screen.select({ providerID: "anthropic", modelID: "claude-opus-5", profile: "Personal" })
    expect(screen.pendingTarget()).toEqual({ providerID: "anthropic", modelID: "claude-opus-5", profile: "Personal" })
    expect(screen.current()).toEqual({ providerID: "anthropic", modelID: "claude-opus-5", profile: "Personal" })
    expect(switches).toEqual([])
    expect(integrationWrites).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("model selection presents a named profile even when it is the only eligible profile", async () => {
  switches.length = 0
  integrationWrites.length = 0
  const screen = await renderPicker({
    stateDir: "single-profile-selection",
    order: [{ providerID: "anthropic", modelID: "claude-opus-5" }],
    catalog: models.map((item) => item.id === "claude-opus-5"
      ? { ...item, profiles: [{ name: "Work", active: true }] }
      : item),
  })
  try {
    screen.app.mockInput.pressEnter()
    await screen.app.waitForFrame((frame) => frame.includes("Provider profile"))
    expect(screen.app.captureCharFrame()).toContain("Use provider default")
    expect(screen.app.captureCharFrame()).toContain("Work")
    await screen.app.mockInput.typeText("Work")
    screen.app.mockInput.pressEnter()
    await waitFor(() => screen.pendingTarget()?.profile === "Work", "the explicit named profile")
    expect(screen.pendingTarget()).toEqual({ providerID: "anthropic", modelID: "claude-opus-5", profile: "Work" })
    expect(switches).toEqual([])
    expect(integrationWrites).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("model selection renders only the selected profile's variants and keeps clear and invalid choices scoped", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "profile-variant-selection",
    order: [{ providerID: "openai", modelID: "gpt-5-2" }],
    sessionModel: { providerID: "openai", id: "gpt-5-2", profile: "Work", variant: "high" },
    catalog: models.map((item) => item.id === "gpt-5-2"
      ? {
          ...item,
          variants: [],
          enabled: false,
          profiles: [
            { name: "Work", active: true, variants: ["high"] },
            { name: "Personal", active: false, variants: ["low", "personal-only"] },
          ],
        }
      : item),
  })
  try {
    screen.app.mockInput.pressEnter()
    await screen.app.waitForFrame((frame) => frame.includes("Provider profile"))
    screen.app.mockInput.pressKey("END")
    screen.app.mockInput.pressEnter()
    await screen.app.waitForFrame((frame) => frame.includes("Select variant"))
    expect(screen.app.captureCharFrame()).toContain("low")
    expect(screen.app.captureCharFrame()).toContain("personal-only")
    expect(screen.app.captureCharFrame()).not.toContain("high")
    screen.app.mockInput.pressKey("END")
    screen.app.mockInput.pressEnter()
    await waitFor(() => screen.pendingTarget()?.profile === "Personal", "the selected Personal profile")
    await waitFor(() => screen.pendingTarget()?.variant === "personal-only", "the Personal-only variant")
    expect(screen.pendingTarget()).toEqual({
      providerID: "openai",
      modelID: "gpt-5-2",
      profile: "Personal",
      variant: "personal-only",
    })
    expect(screen.reasoning()).toBe(true)
    await screen.variantCycle()
    expect(screen.pendingTarget()).toEqual({
      providerID: "openai",
      modelID: "gpt-5-2",
      profile: "Personal",
      variant: "low",
    })
    await screen.select({ providerID: "openai", modelID: "gpt-5-2", profile: "Personal", variant: "high" })
    expect(screen.pendingTarget()).toEqual({
      providerID: "openai",
      modelID: "gpt-5-2",
      profile: "Personal",
      variant: "low",
    })
    await screen.select({ providerID: "openai", modelID: "gpt-5-2", profile: "Personal", variant: undefined })
    expect(screen.pendingTarget()).toEqual({ providerID: "openai", modelID: "gpt-5-2", profile: "Personal" })
    expect(screen.variant()).toBeUndefined()
    await screen.select({ providerID: "openai", modelID: "gpt-5-2", profile: undefined, variant: undefined })
    expect(screen.pendingTarget()).toEqual({ providerID: "openai", modelID: "gpt-5-2", profile: "Personal" })
    expect(switches).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("same-provider model selection does not drop an explicit profile that the target does not offer", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "same-provider-unavailable-profile",
    withoutPicker: true,
    sessionModel: { providerID: "openai", id: "gpt-5-2", profile: "Work", variant: "high" },
    catalog: [
      ...models,
      model({
        id: "gpt-personal-only",
        providerID: "openai",
        name: "GPT Personal",
        context: 300_000,
        profiles: [{ name: "Personal", active: true, variants: ["low"] }],
        enabled: false,
      }),
    ],
  })
  try {
    await waitFor(() => screen.current()?.profile === "Work", "the current Work profile")
    await screen.select({ providerID: "openai", modelID: "gpt-personal-only" })
    expect(screen.pendingTarget()).toEqual({
      providerID: "openai",
      modelID: "gpt-personal-only",
      profile: "Work",
    })
    expect(screen.current()).toEqual({
      providerID: "openai",
      modelID: "gpt-personal-only",
      profile: "Work",
    })
    expect(switches).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("same-provider selection cannot use a profile-only model through provider default", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "same-provider-disabled-default",
    withoutPicker: true,
    sessionModel: { providerID: "openai", id: "gpt-5-2" },
    catalog: [
      ...models,
      model({
        id: "gpt-personal-only",
        providerID: "openai",
        name: "GPT Personal",
        context: 300_000,
        profiles: [{ name: "Personal", active: true, variants: ["low"] }],
        enabled: false,
      }),
    ],
  })
  try {
    await waitFor(() => screen.current()?.modelID === "gpt-5-2", "the current provider-default model")
    await screen.select({ providerID: "openai", modelID: "gpt-personal-only" })
    expect(screen.pendingTarget()).toBeUndefined()
    expect(screen.current()).toEqual({ providerID: "openai", modelID: "gpt-5-2" })
    expect(switches).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("choosing provider default explicitly clears a Session profile without activating an integration", async () => {
  switches.length = 0
  integrationWrites.length = 0
  const screen = await renderPicker({
    stateDir: "explicit-provider-default",
    order: [{ providerID: "anthropic", modelID: "claude-opus-5" }],
    sessionModel: { providerID: "anthropic", id: "claude-opus-5", profile: "Work" },
    catalog: models.map((item) => item.id === "claude-opus-5"
      ? { ...item, profiles: [{ name: "Work", active: true }, { name: "Personal", active: false }] }
      : item),
  })
  try {
    screen.app.mockInput.pressEnter()
    await screen.app.waitForFrame((frame) => frame.includes("Provider profile"))
    screen.app.mockInput.pressKey("HOME")
    screen.app.mockInput.pressEnter()
    await waitFor(() => screen.pendingTarget() !== undefined && screen.pendingTarget()?.profile === undefined, "provider default")
    expect(screen.pendingTarget()).toEqual({ providerID: "anthropic", modelID: "claude-opus-5", variant: undefined })
    expect(switches).toEqual([])
    expect(integrationWrites).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("profile picker keeps an unavailable saved profile visible and offers an explicit default", async () => {
  const screen = await renderPicker({
    stateDir: "unavailable-profile-picker",
    order: [{ providerID: "anthropic", modelID: "claude-opus-5" }],
    sessionModel: { providerID: "anthropic", id: "claude-opus-5", profile: "Removed" },
    catalog: models.map((item) => item.id === "claude-opus-5"
      ? { ...item, profiles: [{ name: "Work", active: true }] }
      : item),
  })
  try {
    await waitFor(() => screen.current()?.profile === "Removed", "the unavailable saved profile")
    screen.app.mockInput.pressEnter()
    await screen.app.waitForFrame((frame) => frame.includes("Provider profile"))
    expect(screen.app.captureCharFrame()).toContain("Unavailable: Removed")
    expect(screen.app.captureCharFrame()).toContain("Use provider default")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("home keeps an unavailable saved variant visible without falling through to absence", async () => {
  const screen = await renderPicker({
    home: true,
    route: { type: "home" },
    stateDir: "stale-home-variant",
    withoutPicker: true,
    recent: [{ providerID: "anthropic", modelID: "claude-opus-5" }],
    storedVariant: { "anthropic/claude-opus-5": "removed" },
  })
  try {
    expect(screen.variant()).toBe("removed")
  } finally {
    await screen.dispose()
  }
}, 30000)

test("implicit selection preserves a stale explicit Session variant until an explicit correction", async () => {
  const screen = await renderPicker({
    stateDir: "stale-session-variant",
    withoutPicker: true,
    sessionModel: { providerID: "openai", id: "gpt-5-2", variant: "removed" },
    storedVariant: { "openai/gpt-5-2": "high" },
  })
  try {
    await screen.select({ providerID: "openai", modelID: "gpt-5-2" })
    expect(screen.variant()).toBe("removed")
    expect(screen.pendingTarget()?.variant).toBe("removed")
  } finally {
    await screen.dispose()
  }
}, 30000)

test("variant picker shows source ids without a synthesized default description", async () => {
  const screen = await renderPicker({
    stateDir: "source-variant-labels",
    variantPicker: true,
    sessionModel: { providerID: "openai", id: "gpt-5-2", variant: "balanced" },
    catalog: models.map((item) =>
      item.id === "gpt-5-2" ? { ...item, variants: [{ id: "none" }, { id: "balanced" }, { id: "high" }] } : item,
    ),
  })
  try {
    await screen.app.waitForFrame((frame) => frame.includes("balanced"))
    expect(screen.app.captureCharFrame()).not.toContain("default")
    expect(screen.app.captureCharFrame()).toContain("none")
    screen.app.mockInput.pressEnter()
    await waitFor(() => screen.variant() === "none", "explicit offered none")
    expect(screen.pendingTarget()?.variant).toBe("none")
  } finally {
    await screen.dispose()
  }
}, 30000)

test("variant picker keeps unavailable selection visible and clears it with a separate action", async () => {
  const screen = await renderPicker({
    stateDir: "explicit-clear-variant",
    variantPicker: true,
    sessionModel: { providerID: "openai", id: "gpt-5-2", variant: "removed" },
    catalog: models.map((item) => (item.id === "gpt-5-2" ? { ...item, variants: [] } : item)),
  })
  try {
    await screen.app.waitForFrame((frame) => frame.includes("removed") && frame.includes("unavailable"))
    expect(screen.app.captureCharFrame()).toContain("Clear selection")
    screen.app.mockInput.pressKey("TAB")
    screen.app.mockInput.pressEnter()
    await waitFor(() => screen.pendingTarget() !== undefined && screen.variant() === undefined, "explicit clear")
    expect(screen.pendingTarget()).toEqual({ providerID: "openai", modelID: "gpt-5-2" })
  } finally {
    await screen.dispose()
  }
}, 30000)

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

test.each([
  { name: "model", stateDir: "cancel-model-completion", selectModel: false },
  { name: "variant", stateDir: "cancel-variant-completion", selectModel: true },
])(
  "Escape from the $name dialog reports cancellation without selecting a model",
  async ({ stateDir, selectModel }) => {
    switches.length = 0
    const results: DialogModelResult[] = []
    const screen = await renderPicker({
      stateDir,
      order: [{ providerID: "openai", modelID: "gpt-5-2" }],
      onComplete: (result) => results.push(result),
    })
    try {
      if (selectModel) {
        screen.app.mockInput.pressEnter()
        await screen.app.waitForFrame((frame) => frame.includes("Select variant"))
        expect(results).toEqual([])
      }
      screen.app.mockInput.pressEscape()
      await screen.app.waitFor(() => results.length > 0)
      expect(results).toEqual([{ type: "cancelled" }])
      expect(screen.pendingTarget()).toBeUndefined()
      expect(switches).toEqual([])
    } finally {
      await screen.dispose()
    }
  },
  30_000,
)

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

test("selecting a model restores its valid stored variant without another variant choice", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "variant-default",
    order: [{ providerID: "openai", modelID: "gpt-5-2" }],
    storedVariant: { "openai/gpt-5-2": "high" },
  })
  try {
    screen.app.mockInput.pressEnter()
    await selectProviderDefault(screen)
    await waitFor(() => screen.pendingTarget()?.modelID === "gpt-5-2", "the desired model")
    expect(screen.pendingTarget()).toEqual({ providerID: "openai", modelID: "gpt-5-2", variant: "high" })
    expect(screen.variant()).toBe("high")
    expect(screen.app.captureCharFrame()).not.toContain("Select variant")
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
    sessionModel: { providerID: "openai", id: "gpt-5-2" },
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

test("variant cycling displays none and wraps only through offered variants", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "variant-cycle-none",
    variantPicker: true,
    recent: [{ providerID: "openai", modelID: "gpt-5-2" }],
    sessionModel: { providerID: "openai", id: "gpt-5-2", variant: "high" },
    catalog: models.map((item) =>
      item.id === "gpt-5-2" ? { ...item, variants: [{ id: "none" }, { id: "low" }, { id: "high" }] } : item,
    ),
  })
  try {
    await waitFor(() => screen.current()?.modelID === "gpt-5-2", "the model preference")
    await screen.variantCycle()
    expect(screen.pendingTarget()).toEqual({ providerID: "openai", modelID: "gpt-5-2", variant: "none" })
    expect(screen.variant()).toBe("none")
    await screen.app.waitForFrame((frame) => frame.includes("none"))
    await screen.variantCycle()
    expect(screen.pendingTarget()).toEqual({ providerID: "openai", modelID: "gpt-5-2", variant: "low" })
    await screen.variantCycle()
    expect(screen.variant()).toBe("high")
    await screen.variantCycle()
    expect(screen.pendingTarget()).toEqual({ providerID: "openai", modelID: "gpt-5-2", variant: "none" })
    await screen.variantCycle()
    expect(screen.variant()).toBe("low")
    expect(switches).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("renders and persists an advertised none variant from model selection", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "variant-saved-none",
    order: [{ providerID: "openai", modelID: "gpt-5-2" }],
    recent: [{ providerID: "openai", modelID: "gpt-5-2" }],
    storedVariant: { "openai/gpt-5-2": "none" },
    catalog: models.map((item) =>
      item.id === "gpt-5-2" ? { ...item, variants: [{ id: "none" }, { id: "low" }] } : item,
    ),
  })
  try {
    screen.app.mockInput.pressEnter()
    await selectProviderDefault(screen)
    await waitFor(() => screen.pendingTarget()?.variant === "none", "the selected none variant")
    expect(await Bun.file(path.join(root, "variant-saved-none", "model.json")).json()).toMatchObject({
      variant: { "openai/gpt-5-2": "none" },
    })
    expect(screen.variant()).toBe("none")
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
    await selectProviderDefault(screen)
    await screen.app.waitForFrame((frame) => frame.includes("Select variant"))
    screen.app.mockInput.pressEnter()
    await waitFor(() => screen.pendingTarget()?.variant === "high", "the desired target")

    screen.commitPending({ providerID: "openai", id: "gpt-5-2", variant: "low" })
    expect(screen.pendingTarget()?.variant).toBe("high")

    screen.modelSelected({ providerID: "openai", id: "gpt-5-2", variant: "high" })
    await waitFor(() => screen.durableModel()?.id === "gpt-5-2", "the confirmed durable target")
    screen.commitPending({ providerID: "openai", id: "gpt-5-2", variant: "high" })
    await waitFor(() => screen.pendingTarget() === undefined, "the committed target")
    expect(screen.current()).toEqual({ providerID: "openai", modelID: "gpt-5-2" })
    expect(screen.variant()).toBe("high")
    expect(switches).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("Session model authority follows durable changes without using the agent's model preference", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "durable-authority",
    withoutPicker: true,
    recent: [{ providerID: "openai", modelID: "gpt-5-2" }],
  })
  try {
    await waitFor(() => screen.current()?.modelID === "claude-opus-5", "the durable Session model")
    screen.modelSelected({ providerID: "openai", id: "gpt-5-2", variant: "low" })
    await waitFor(
      () => screen.current()?.modelID === "gpt-5-2" && screen.variant() === "low",
      "the externally selected model and variant",
    )
    expect(screen.pendingTarget()).toBeUndefined()
    await screen.select({ providerID: "google", modelID: "gemini-3-pro" })
    screen.modelSelected({ providerID: "openai", id: "gpt-5-2", variant: "high" })
    expect(screen.current()).toEqual({ providerID: "google", modelID: "gemini-3-pro" })
    expect(screen.variant()).toBeUndefined()
    expect(switches).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("ModelSelected replaces the whole Session reference when the target omits the prior max effort", async () => {
  const screen = await renderPicker({
    stateDir: "durable-ref-replacement",
    withoutPicker: true,
    sessionModel: { providerID: "openai", id: "gpt-5-2", variant: "max" },
    catalog: models.map((item) =>
      item.id === "gpt-5-2" ? { ...item, variants: [{ id: "high" }, { id: "max" }] } : item,
    ),
  })
  try {
    expect(screen.durableModel()).toEqual({ providerID: "openai", id: "gpt-5-2", variant: "max" })
    const next = { providerID: "google", id: "gemini-3-pro" }
    screen.modelSelected(next)
    await waitFor(() => screen.durableModel()?.id === next.id, "the new durable identity")
    expect(screen.durableModel()).toEqual(next)
    expect("variant" in screen.durableModel()!).toBe(false)
    expect(screen.current()).toEqual({ providerID: "google", modelID: "gemini-3-pro" })
    expect(screen.variant()).toBeUndefined()
    screen.modelSelected({ providerID: "openai", id: "gpt-5-2", variant: "max" })
    await waitFor(() => screen.durableModel()?.variant === "max", "the named effort")
    screen.modelSelected({ providerID: "openai", id: "gpt-5-2" })
    await waitFor(() => screen.durableModel()?.variant === undefined, "the base model reference")
    expect(screen.durableModel()).toEqual({ providerID: "openai", id: "gpt-5-2" })
    expect("variant" in screen.durableModel()!).toBe(false)
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("model round trips restore each target's valid effort, including uncommitted choices", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "variant-round-trip",
    withoutPicker: true,
    sessionModel: { providerID: "openai", id: "gpt-5-2", variant: "high" },
  })
  try {
    await waitFor(() => screen.variant() === "high", "the durable effort")
    await screen.select({ providerID: "google", modelID: "gemini-3-pro" })
    expect(screen.variant()).toBeUndefined()
    await screen.select({ providerID: "openai", modelID: "gpt-5-2" })
    expect(screen.pendingTarget()).toEqual({ providerID: "openai", modelID: "gpt-5-2", variant: "high" })
    await screen.select({ providerID: "openai", modelID: "gpt-5-2", variant: "low" })
    await screen.select({ providerID: "google", modelID: "gemini-3-pro" })
    await screen.select({ providerID: "openai", modelID: "gpt-5-2" })
    expect(screen.variant()).toBe("low")
    await screen.select({ providerID: "openai", modelID: "gpt-5-2", variant: undefined })
    expect(screen.pendingTarget()).toEqual({ providerID: "openai", modelID: "gpt-5-2" })
    expect(screen.variant()).toBeUndefined()
    expect(switches).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("invalid model or explicit effort selections preserve the prior pending choice and preferences", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "variant-rejection",
    withoutPicker: true,
    storedVariant: { "openai/gpt-5-2": "low" },
  })
  try {
    await waitFor(() => screen.current()?.modelID === "claude-opus-5", "the durable model")
    await screen.select({ providerID: "openai", modelID: "gpt-5-2", variant: "high" })
    const pending = screen.pendingTarget()
    await screen.select({ providerID: "openai", modelID: "gpt-5-2", variant: "max" })
    expect(screen.pendingTarget()).toEqual(pending)
    await screen.select({ providerID: "google", modelID: "gemini-3-pro", variant: "high" })
    expect(screen.pendingTarget()).toEqual(pending)
    await screen.select({ providerID: "openai", modelID: "missing" })
    expect(screen.pendingTarget()).toEqual(pending)
    expect(screen.variant()).toBe("high")
    await screen.select({ providerID: "google", modelID: "gemini-3-pro" })
    await screen.select({ providerID: "openai", modelID: "gpt-5-2" })
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

test("selecting a model with an unoffered saved variant keeps it after picker cancellation", async () => {
  switches.length = 0
  const screen = await renderPicker({
    stateDir: "variant-unoffered",
    order: [{ providerID: "openai", modelID: "gpt-5-2" }],
    storedVariant: { "openai/gpt-5-2": "max" },
  })
  try {
    screen.app.mockInput.pressEnter()
    await screen.app.waitForFrame((frame) => frame.includes("Select variant"))
    expect(screen.variant()).toBe("max")
    screen.app.mockInput.pressEscape()
    await waitFor(() => screen.pendingTarget()?.modelID === "gpt-5-2", "the desired model")
    expect(screen.pendingTarget()).toEqual({ providerID: "openai", modelID: "gpt-5-2", variant: "max" })
    await waitFor(() => screen.variant() === "max", "the retained unavailable variant")
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
