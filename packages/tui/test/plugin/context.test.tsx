/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ConfigProvider } from "../../src/config"
import { ClientProvider } from "../../src/context/client"
import { DataProvider } from "../../src/context/data"
import { Keymap } from "../../src/context/keymap"
import { LocationProvider } from "../../src/context/location"
import { RouteProvider } from "../../src/context/route"
import { TuiLifecycleProvider } from "../../src/context/runtime"
import { ThemeProvider } from "../../src/context/theme"
import { PluginProvider, usePlugin } from "../../src/plugin/context"
import { createNotifications } from "../../src/feature-plugins/system/notifications"
import { contexts } from "../fixture/client-observer-plugin"
import { createApi, createEventStream, createFetch, json } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test("invalid plugin modules report a user-facing error without an internal runtime label", async () => {
  function ErrorState() {
    const plugins = usePlugin()
    return <text>{(() => {
      const state = plugins.list().find((entry) => entry.target === "invalid-fixture")
      return state?.status === "failed" ? state.error : state?.status
    })()}</text>
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <TuiLifecycleProvider value={{ add: () => () => {} }}>
          <ConfigProvider config={createTuiResolvedConfig({ plugins: ["invalid-fixture"], attention: { enabled: false } })}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <Keymap.Provider>
                <RouteProvider>
                  <ClientProvider api={createApi(createFetch().fetch)}>
                    <DataProvider>
                      <LocationProvider>
                        <PluginProvider packages={{ resolve: async () => new URL("../fixture/tui-client.ts", import.meta.url).href }}>
                          <ErrorState />
                        </PluginProvider>
                      </LocationProvider>
                    </DataProvider>
                  </ClientProvider>
                </RouteProvider>
              </Keymap.Provider>
            </ThemeProvider>
          </ConfigProvider>
        </TuiLifecycleProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 12 },
  )
  try {
    await app.waitForFrame((frame) => frame.includes("invalid-fixture"))
    expect(app.captureCharFrame()).toContain("Invalid TUI plugin module: invalid-fixture")
    expect(app.captureCharFrame()).not.toContain("V2")
  } finally {
    app.renderer.destroy()
  }
})

test("active production plugin contexts follow a managed-service client replacement", async () => {
  const initialEvents = createEventStream()
  const replacementEvents = createEventStream()
  const pendingStarted = Promise.withResolvers<void>()
  const pendingResponse = Promise.withResolvers<Response>()
  let gatePending = false
  const permission = (id: string) => ({ id, sessionID: "ses_context", action: "shell", resources: [], metadata: {} })
  const initial = createApi(createFetch((url) => {
    if (url.pathname !== "/api/session/ses_context/permission") return undefined
    if (gatePending) {
      pendingStarted.resolve()
      return pendingResponse.promise
    }
    return json({ data: [permission("permission_initial")] })
  }, initialEvents).fetch)
  const replacement = createApi(createFetch((url) => url.pathname === "/api/session/ses_context/permission"
    ? json({ data: [permission("permission_replacement")] }) : undefined, replacementEvents).fetch)
  const finalizers = new Set<() => Promise<void>>()
  let cleanupNotifications: (() => void | Promise<void>) | undefined
  let restoreNotify: (() => void) | undefined
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <TuiLifecycleProvider value={{ add: (finalizer) => {
          finalizers.add(finalizer)
          return () => { finalizers.delete(finalizer) }
        } }}>
          <ConfigProvider config={createTuiResolvedConfig({ plugins: ["client-observer-fixture"], attention: { enabled: false } })}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <Keymap.Provider>
                <RouteProvider>
                  <ClientProvider api={initial} service={{ reconnect: async () => ({ api: replacement }), restart: async () => {} }}>
                    <DataProvider>
                      <LocationProvider>
                        <PluginProvider packages={{ resolve: async () => new URL("../fixture/client-observer-plugin.ts", import.meta.url).href }}>
                          <text>Plugin context lifecycle</text>
                        </PluginProvider>
                      </LocationProvider>
                    </DataProvider>
                  </ClientProvider>
                </RouteProvider>
              </Keymap.Provider>
            </ThemeProvider>
          </ConfigProvider>
        </TuiLifecycleProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 12 },
  )
  try {
    await app.waitFor(() => contexts.length === 1 && initialEvents.subscriptions() > 0)
    const context = contexts[0]
    expect(context.client).toBe(initial)
    expect((await context.client.permission.list({ sessionID: "ses_context" }))[0].id).toBe("permission_initial")
    const checkpoints: (() => Promise<void>)[] = []
    const notifications = createNotifications((_delay, run) => {
      checkpoints.push(run)
      return () => {
        const position = checkpoints.indexOf(run)
        if (position !== -1) checkpoints.splice(position, 1)
      }
    })
    const cleanup = await notifications.setup(context)
    if (typeof cleanup === "function") cleanupNotifications = cleanup
    const notify = spyOn(context.attention, "notify").mockResolvedValue({ ok: true, notification: true, sound: true })
    restoreNotify = () => notify.mockRestore()
    gatePending = true
    initialEvents.emit({ id: "permission_asked", created: 1, type: "permission.v2.asked", data: permission("permission_replacement") })
    await app.waitFor(() => checkpoints.length === 1)
    const confirming = checkpoints.shift()!()
    await pendingStarted.promise
    initialEvents.disconnect()
    await app.waitFor(() => replacementEvents.subscriptions() > 0)
    pendingResponse.resolve(json({ message: "old service unavailable" }, { status: 500 }))
    await confirming
    expect(checkpoints).toHaveLength(1)
    await checkpoints.shift()!()
    expect(notify.mock.calls).toEqual([[{
      title: undefined, message: "Permission needs input",
      notification: { when: "blurred" }, sound: { name: "permission", when: "always" },
    }]])
    expect(contexts).toEqual([context])
    expect((await context.client.permission.list({ sessionID: "ses_context" }))[0].id).toBe("permission_replacement")
    expect(context.client).toBe(replacement)
  } finally {
    pendingResponse.resolve(json({ data: [] }))
    await cleanupNotifications?.()
    restoreNotify?.()
    await Promise.all([...finalizers].map((finalizer) => finalizer()))
    app.renderer.destroy()
    initialEvents.disconnect()
    replacementEvents.disconnect()
  }
})
