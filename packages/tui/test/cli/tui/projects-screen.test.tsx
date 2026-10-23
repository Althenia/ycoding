/** @jsxImportSource @opentui/solid */
import { InputRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { type Config, ConfigProvider } from "../../../src/config"
import { ClientProvider } from "../../../src/context/client"
import { CoordinationProvider } from "../../../src/context/coordination"
import { Keymap } from "../../../src/context/keymap"
import { RouteProvider, useRoute } from "../../../src/context/route"
import { ThemeProvider } from "../../../src/context/theme"
import { ProjectsScreen } from "../../../src/routes/session/projects"
import { DialogProvider } from "../../../src/ui/dialog"
import { Toast, ToastProvider } from "../../../src/ui/toast"
import { backend, groupID, leadID, workerID, type WriteBody } from "../../fixture/coordination-backend"
import { createApi, createEventStream, createFetch } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

async function mount() {
  const server = backend()
  const events = createEventStream()
  const fetch = createFetch(server.route, events)
  const persisted: { attention?: { coordination?: Config.CoordinationNotifications } } = {}
  let route!: ReturnType<typeof useRoute>
  function Probe() {
    route = useRoute()
    return null
  }
  const service: Config.Interface = {
    path: "/tmp/ycoding-test.json",
    get: async () => persisted,
    update: async (change: (draft: typeof persisted) => void) => {
      change(persisted)
      return persisted
    },
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()} service={service}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <RouteProvider initialRoute={{ type: "projects", sessionID: leadID }}>
                    <ClientProvider api={createApi(fetch.fetch)}>
                      <CoordinationProvider>
                        <Probe />
                        <ProjectsScreen />
                      </CoordinationProvider>
                    </ClientProvider>
                  </RouteProvider>
                </DialogProvider>
                <Toast />
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 110, height: 120, kittyKeyboard: true },
  )
  app.renderer.start()
  return { app, server, persisted, route: () => route }
}

type App = Awaited<ReturnType<typeof mount>>["app"]

const cursorLine = (app: App) => app.captureCharFrame().split("\n").find((line) => line.trimStart().startsWith("▸")) ?? ""
const row = (app: App, label: string) =>
  app.captureCharFrame().split("\n").find((line) => line.replace(/^\s*▸?\s*/, "").startsWith(label)) ?? ""

async function focus(app: App, label: string) {
  app.mockInput.pressKey("HOME")
  await app.renderOnce()
  for (let attempt = 0; attempt < 120; attempt++) {
    if (cursorLine(app).includes(label)) return
    app.mockInput.pressArrow("down")
    await app.renderOnce()
  }
  throw new Error(`The cursor never reached "${label}":\n${app.captureCharFrame()}`)
}

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 5_000
  while (!check() && Date.now() < deadline) await Bun.sleep(10)
  if (!check()) throw new Error(`Timed out waiting for ${label}`)
}

async function edit(app: App, label: string, text: string) {
  await focus(app, label)
  app.mockInput.pressEnter()
  await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
  for (let index = 0; index < 160; index++) app.mockInput.pressBackspace()
  await app.mockInput.typeText(text)
  app.mockInput.pressEnter()
  await app.renderOnce()
}

const memberFields = (body: WriteBody) =>
  (body.members ?? []).map((member) => ({
    sessionID: member.sessionID,
    role: member.role,
    allowedTools: member.allowedTools,
    resourceScopes: member.resourceScopes,
  }))

test("rendered role, capacity and delegation controls persist through the generated client and keep every other limit", async () => {
  const { app, server } = await mount()
  try {
    await app.waitForFrame((frame) => frame.includes("Release train"))
    await until(() => row(app, "Delegated decisions").includes("custom narrowing (permission, review)"), "global delegation policy")

    await focus(app, "Worker A")
    app.mockInput.pressEnter()
    await app.renderOnce()
    await focus(app, "Role")
    app.mockInput.pressArrow("right")
    await until(() => server.state.writes.length === 1, "role write")
    const role = server.state.writes[0]!
    expect(role.method).toBe("PUT")
    expect(role.path).toBe(`/api/coordination/${groupID}/members`)
    expect(role.body.revision).toBe(7)
    expect(memberFields(role.body)).toEqual([
      { sessionID: leadID, role: "coordinator", allowedTools: ["read"], resourceScopes: ["/repo/**"] },
      { sessionID: workerID, role: "observer", allowedTools: ["read", "grep"], resourceScopes: ["/repo/src/**"] },
      { sessionID: "ses_watcher000001", role: "observer", allowedTools: undefined, resourceScopes: undefined },
    ])
    expect(role.body.policy).toBeUndefined()

    await edit(app, "Concurrency", "uncapped")
    await until(() => server.state.writes.length === 2, "capacity write")
    const capacity = server.state.writes[1]!
    expect(capacity.body.policy).toMatchObject({
      concurrency: null,
      queueCapacity: 40,
      budget: 5,
      delegatedDecisions: { categories: ["permission", "review"], actions: ["shell:git status"] },
    })
    expect(memberFields(capacity.body)).toEqual(memberFields(role.body).map((member, index) => ({ ...member, role: ["coordinator", "worker", "observer"][index] })))

    await focus(app, "Allow review")
    app.mockInput.pressEnter()
    await until(() => server.state.writes.length === 3, "delegation write")
    const delegated = server.state.writes[2]!.body.policy
    expect(delegated?.delegatedDecisions).toEqual({
      categories: ["permission"],
      actions: ["shell:git status"],
      resources: ["/repo/src/**"],
      expiresAt: 1_800_000_000_000,
    })
    expect(delegated?.concurrency).toBe(3)
  } finally {
    app.renderer.destroy()
  }
})

test("renaming writes the new name with the loaded revision and the unchanged members", async () => {
  const { app, server } = await mount()
  try {
    await app.waitForFrame((frame) => frame.includes("Release train"))
    await edit(app, "Name", "Shipping train")
    await until(() => server.state.writes.length === 1, "rename write")
    const write = server.state.writes[0]!
    expect(write.body.name).toBe("Shipping train")
    expect(write.body.revision).toBe(7)
    expect(memberFields(write.body).map((member) => member.sessionID)).toEqual([leadID, workerID, "ses_watcher000001"])
  } finally {
    app.renderer.destroy()
  }
})

test("a lifecycle control reloads the project and the notification filter persists to the TUI configuration", async () => {
  const { app, server, persisted } = await mount()
  try {
    await app.waitForFrame((frame) => frame.includes("Release train"))
    server.state.status = "stopped"
    await focus(app, "Stop dispatch")
    app.mockInput.pressEnter()
    await until(() => server.state.writes.some((write) => write.path.endsWith("/stop")), "stop write")
    expect(server.state.writes.find((write) => write.path.endsWith("/stop"))!.body).toEqual({ revision: 7 })
    await app.waitForFrame((frame) => frame.includes("Re-arm group"))

    await focus(app, "Category: failure")
    app.mockInput.pressEnter()
    await until(() => persisted.attention?.coordination !== undefined, "persisted filter")
    expect(persisted.attention?.coordination).toEqual({
      scope: "all",
      categories: ["question", "permission", "review", "completion"],
    })
    await app.waitForFrame((frame) => frame.split("\n").some((line) => line.includes("Category: failure") && line.includes("off")))
  } finally {
    app.renderer.destroy()
  }
})

test("escape leaves the screen for the Session it was opened from", async () => {
  const { app, route } = await mount()
  try {
    await app.waitForFrame((frame) => frame.includes("Release train"))
    app.mockInput.pressEscape()
    await app.renderOnce()
    expect(route().data).toMatchObject({ type: "session", sessionID: leadID })
  } finally {
    app.renderer.destroy()
  }
})
