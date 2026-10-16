/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import type { AgentInfo, ModelInfo, ModelRef, SessionInfo } from "@ycoding-ai/client"
import { createEffect, onMount } from "solid-js"
import path from "node:path"
import { Prompt, type PromptRef } from "../src/component/prompt"
import { Header } from "../src/routes/session/header"
import { ArgsProvider } from "../src/context/args"
import { ClientProvider, useClient } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { EditorContextProvider } from "../src/context/editor"
import { ExitProvider } from "../src/context/exit"
import { Keymap } from "../src/context/keymap"
import { LocalProvider, useLocal } from "../src/context/local"
import { LocationProvider, useLocation } from "../src/context/location"
import { RouteProvider, useRoute } from "../src/context/route"
import { ThemeProvider } from "../src/context/theme"
import { ConfigProvider } from "../src/config"
import { FrecencyProvider } from "../src/prompt/frecency"
import { PromptHistoryProvider } from "../src/prompt/history"
import { PromptStashProvider } from "../src/prompt/stash"
import { PromptRefProvider } from "../src/context/prompt"
import { DialogProvider } from "../src/ui/dialog"
import { Toast, ToastProvider } from "../src/ui/toast"
import { tmpdir } from "./fixture/fixture"
import { createApi, createEventStream, createFetch, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const directory = "/tmp/ycoding/resume-selection"
const location = { directory, project: { id: "proj_resume", directory } }
const otherLocation = { directory: `${directory}/other`, project: location.project }
const savedModel: ModelRef = { providerID: "fixture", id: "session-model", profile: "Work", variant: "high" }
const session: SessionInfo = {
  id: "ses_resume_selection",
  title: "Resume selection",
  projectID: location.project.id,
  location: { directory },
  agent: "reviewer",
  model: savedModel,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}
const catalog = ["session-model", "home-model"].map(
  (id): ModelInfo => ({
    id,
    modelID: id,
    providerID: "fixture",
    name: id,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [{ id: "low" }, { id: "high" }],
    profiles: [{ name: "Work", active: false, variants: ["high", "low"] }],
    time: { released: 1 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 200_000, output: 32_000 },
  }),
)
const agents = ["build", "reviewer"].map(
  (id): AgentInfo => ({
    id,
    name: id === "build" ? "Build" : "Reviewer",
    request: { settings: {}, headers: {}, body: {} },
    mode: "primary",
    hidden: false,
    permissions: [],
    model: { providerID: "fixture", id: "home-model", variant: "low" },
  }),
)

async function renderResume(input: {
  state: string
  otherLocation?: boolean
  model?: ModelRef
  missingAgent?: boolean
}) {
  const resumed = { ...session, model: input.model ?? savedModel }
  await Bun.write(
    path.join(input.state, "model.json"),
    JSON.stringify({
      recent: [{ providerID: "fixture", modelID: "home-model" }],
      favorite: [],
      variant: { "fixture/session-model": "low", "fixture/session-model#profile=Work": "low" },
    }),
  )
  const gates = {
    session: Promise.withResolvers<void>(),
    agents: Promise.withResolvers<void>(),
    models: Promise.withResolvers<void>(),
  }
  const writes: Array<{ path: string; body: unknown }> = []
  const submitted = new Map<string, { agentID: string; model: ModelRef }>()
  const events = createEventStream()
  const transport = createFetch(async (url, request) => {
    if (request.method === "POST") {
      const body: unknown = await request.json()
      writes.push({ path: url.pathname, body })
      if (url.pathname.endsWith("/prompt")) {
        if (
          !body ||
          typeof body !== "object" ||
          !("id" in body) ||
          typeof body.id !== "string" ||
          !("text" in body) ||
          typeof body.text !== "string"
        )
          throw new Error("Expected prompt input")
        return json({
          data: {
            id: body.id,
            sessionID: resumed.id,
            admittedSeq: 1,
            timeCreated: 1,
            type: "user",
            data: { text: body.text },
            delivery: "steer",
          },
        })
      }
      return new Response(null, { status: 204 })
    }
    if (url.pathname === "/api/location")
      return json(url.searchParams.get("directory") === otherLocation.directory ? otherLocation : location)
    if (url.pathname === "/api/session") return json({ data: [], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) {
      await gates.session.promise
      return json({ data: resumed })
    }
    if (url.pathname === "/api/session/ses_other_resume")
      return json({ data: { ...resumed, id: "ses_other_resume", agent: "build", model: agents[0].model } })
    if (url.pathname === "/api/agent") {
      await gates.agents.promise
      return json({ location, data: input.missingAgent ? agents.slice(0, 1) : agents })
    }
    if (url.pathname === "/api/model") {
      await gates.models.promise
      return json({ location, data: catalog })
    }
    if (url.pathname === "/api/model/default")
      return json({ location, data: { selection: { providerID: "fixture", id: "home-model", variant: "low" } } })
    if (url.pathname === "/api/provider") return json({ location, data: [{ id: "fixture", name: "Fixture" }] })
    if (url.pathname === `/api/session/${session.id}/subagent`)
      return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
    return undefined
  }, events)
  let data!: ReturnType<typeof useData>
  let local!: ReturnType<typeof useLocal>
  let router!: ReturnType<typeof useRoute>
  let prompt!: PromptRef
  let connected = false
  function Fixture() {
    data = useData()
    local = useLocal()
    router = useRoute()
    const currentLocation = useLocation()
    const client = useClient()
    createEffect(() => {
      connected = client.connection.status() === "connected"
    })
    createEffect(() => {
      data.session.submissions.list(session.id).forEach((entry) =>
        submitted.set(entry.input.promptID, {
          agentID: entry.input.payload.agentID,
          model: { ...entry.input.payload.model },
        }),
      )
    })
    onMount(() => {
      currentLocation.set(input.otherLocation ? otherLocation : location)
      void data.location.sync(location)
      void data.session.sync(session.id)
    })
    return (
      <>
        <Header
          agent={data.session.get(session.id)?.agent}
          model={data.session.get(session.id)?.model && `fixture/${data.session.get(session.id)?.model?.id}`}
          variant={data.session.get(session.id)?.model?.variant}
          profile={data.session.get(session.id)?.model?.profile}
          pendingAgent={local.agent.current()?.name}
          pendingModel={local.model.current() && `fixture/${local.model.current()?.modelID}`}
          pendingVariant={local.model.variant.current()}
          state={{ type: "ready" }}
        />
        <Prompt
          sessionID={router.data.type === "session" ? router.data.sessionID : undefined}
          ref={(value) => {
            if (value) prompt = value
          }}
        />
      </>
    )
  }
  const app = await testRender(
    () => (
      <TestTuiContexts directory={directory} paths={{ state: input.state }}>
        <ExitProvider exit={() => {}}>
          <ArgsProvider>
            <ConfigProvider config={createTuiResolvedConfig({ animations: false, prompt: { editor: false } })}>
              <Keymap.Provider>
                <ToastProvider>
                  <RouteProvider initialRoute={{ type: "session", sessionID: session.id }}>
                    <ClientProvider api={createApi(transport.fetch)}>
                      <DataProvider>
                        <LocationProvider>
                          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                            <LocalProvider>
                              <PromptStashProvider>
                                <DialogProvider>
                                  <FrecencyProvider>
                                    <PromptHistoryProvider>
                                      <EditorContextProvider><PromptRefProvider>
                                        <Fixture />
                                      </PromptRefProvider></EditorContextProvider>
                                    </PromptHistoryProvider>
                                  </FrecencyProvider>
                                </DialogProvider>
                              </PromptStashProvider>
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
        </ExitProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 24 },
  )
  app.renderer.start()
  await app.waitFor(() => connected && local.model.ready && !!prompt)
  return {
    app,
    data,
    local,
    router,
    writes,
    submitted,
    prompt,
    async release(key: keyof typeof gates) {
      gates[key].resolve()
      await app.waitFor(() =>
        key === "session"
          ? !!data.session.get(session.id)
          : key === "agents"
            ? !!data.location.agent.list(location)
            : !!data.location.model.list(location),
      )
      await app.renderOnce()
    },
    dispose() {
      Object.values(gates).forEach((gate) => gate.resolve())
      app.renderer.destroy()
    },
  }
}

const orders = [
  ["session", "agents", "models"],
  ["session", "models", "agents"],
  ["agents", "session", "models"],
  ["agents", "models", "session"],
  ["models", "session", "agents"],
  ["models", "agents", "session"],
] as const

test.each(orders)("resume selection follows Session, not load order %s/%s/%s", async (first, second, third) => {
  const order = [first, second, third]
  await using state = await tmpdir()
  const fixture = await renderResume({ state: state.path })
  try {
    for (const key of order) {
      await fixture.release(key)
      if (!fixture.data.session.get(session.id)) {
        expect(fixture.local.agent.current()).toBeUndefined()
        expect(fixture.local.model.current()).toBeUndefined()
        expect(fixture.local.model.variant.current()).toBeUndefined()
        continue
      }
      expect(fixture.local.model.current()).toEqual({
        providerID: "fixture",
        modelID: "session-model",
        profile: "Work",
      })
      expect(fixture.local.model.variant.current()).toBe("high")
      if (!fixture.data.location.agent.list(location)) continue
      expect(fixture.local.agent.current()?.id).toBe("reviewer")
      expect(fixture.app.captureCharFrame()).not.toContain("→ Build")
    }
    fixture.prompt.set({ text: "first resumed prompt", pasted: [] })
    fixture.prompt.submit()
    await fixture.app.waitFor(() => fixture.writes.filter((write) => write.path.endsWith("/prompt")).length === 2)
    expect(fixture.writes.map((write) => write.path)).toEqual([
      `/api/session/${session.id}/prompt`,
      `/api/session/${session.id}/prompt`,
    ])
    expect([...fixture.submitted.values()]).toEqual([{ agentID: "reviewer", model: savedModel }])
    expect(fixture.data.session.get(session.id)?.model).toEqual(savedModel)
  } finally {
    fixture.dispose()
  }
})

test("first resumed prompt validates against Session Location even before presentation Location catches up", async () => {
  await using state = await tmpdir()
  const fixture = await renderResume({ state: state.path, otherLocation: true })
  try {
    await fixture.release("session")
    await fixture.release("agents")
    await fixture.release("models")
    fixture.prompt.set({ text: "first resumed prompt", pasted: [] })
    fixture.prompt.submit()
    await fixture.app.waitFor(
      () => fixture.writes.length > 0 || fixture.app.captureCharFrame().includes("Model selection needs attention"),
    )
    expect(fixture.app.captureCharFrame()).not.toContain("Model selection needs attention")
    await fixture.app.waitFor(() => fixture.writes.filter((write) => write.path.endsWith("/prompt")).length === 2)
    expect(fixture.writes.some((write) => write.path.endsWith("/agent"))).toBe(false)
    expect(fixture.prompt.current.text).toBe("")
  } finally {
    fixture.dispose()
  }
})

test("resume keeps omitted variant absent despite remembered effort", async () => {
  await using state = await tmpdir()
  const fixture = await renderResume({ state: state.path, model: { ...savedModel, variant: undefined } })
  try {
    await fixture.release("models")
    await fixture.release("agents")
    await fixture.release("session")
    expect(fixture.local.model.variant.current()).toBeUndefined()
    expect(fixture.local.model.current()).toEqual({ providerID: "fixture", modelID: "session-model", profile: "Work" })
  } finally {
    fixture.dispose()
  }
})

test("navigation isolates explicit agent choices from home and other Sessions", async () => {
  await using state = await tmpdir()
  const fixture = await renderResume({ state: state.path })
  try {
    await fixture.release("session")
    await fixture.release("agents")
    await fixture.release("models")
    fixture.local.agent.set("build")
    expect(fixture.local.agent.current()?.id).toBe("build")
    fixture.router.navigate({ type: "home" })
    expect(fixture.local.agent.current()?.id).toBe("build")
    fixture.local.agent.set("reviewer")
    fixture.router.navigate({ type: "session", sessionID: "ses_other_resume" })
    expect(fixture.local.agent.current()).toBeUndefined()
    expect(fixture.local.model.current()).toBeUndefined()
    await fixture.data.session.sync("ses_other_resume")
    expect(fixture.local.agent.current()?.id).toBe("build")
    expect(fixture.local.model.current()).toEqual({ providerID: "fixture", modelID: "home-model" })
    expect(fixture.local.model.variant.current()).toBe("low")
    fixture.router.navigate({ type: "session", sessionID: session.id })
    expect(fixture.local.agent.current()?.id).toBe("build")
    expect(fixture.local.model.current()).toEqual({ providerID: "fixture", modelID: "session-model", profile: "Work" })
    expect(fixture.local.model.variant.current()).toBe("high")
    fixture.router.navigate({ type: "home" })
    expect(fixture.local.agent.current()?.id).toBe("reviewer")
  } finally {
    fixture.dispose()
  }
})

test("an unavailable saved agent never falls back to the first agent on submit", async () => {
  await using state = await tmpdir()
  const fixture = await renderResume({ state: state.path, missingAgent: true })
  try {
    await fixture.release("session")
    await fixture.release("agents")
    await fixture.release("models")
    fixture.prompt.set({ text: "retain for missing agent", pasted: [] })
    fixture.prompt.submit()
    await fixture.app.waitFor(
      () => fixture.writes.length > 0 || fixture.app.captureCharFrame().includes("Agent selection needs attention"),
    )
    expect(fixture.writes).toEqual([])
    expect(fixture.prompt.current.text).toBe("retain for missing agent")
  } finally {
    fixture.dispose()
  }
})
