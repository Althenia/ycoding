import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { testRender } from "@opentui/solid"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { make } from "@ycoding-ai/client/v5"
import { Service } from "@ycoding-ai/client/service"
import { fixture } from "../../../rust/crates/runtime/tests/support/launcher-client"
import { ClientProvider, useClient } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { LocationProvider, useLocation } from "../src/context/location"
import { ClipboardProvider } from "../src/context/clipboard"
import { ThemeProvider } from "../src/context/theme"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ToastProvider } from "../src/ui/toast"
import { FormPrompt } from "../src/routes/session/form"
import { formKey } from "../src/util/form"
import { runInteractiveDeferredMode } from "../src/mini/runtime"
import { RunFormBody } from "../src/mini/footer.form"
import { RUN_THEME_FALLBACK } from "../src/mini/theme"
import type { FooterView, MiniHost } from "../src/mini/types"
import { TestTuiContexts } from "../test/fixture/tui-environment"
import { createTuiResolvedConfig } from "../test/fixture/tui-runtime"
import { createFooterApiFixture } from "../test/mini/fixture/footer-api"

async function start() {
  const binary = process.env.YCODING_TEST_RUST_RUNTIME
  if (!binary) throw new Error("YCODING_TEST_RUST_RUNTIME must name the built Rust runtime")
  const runtime = await fixture(binary)
  try {
    const endpoint = await Service.ensure({ file: runtime.file, command: runtime.command("tui-global-forms") })
    const directory = path.join(runtime.configDir, "selected work ไทย")
    const other = path.join(runtime.configDir, "other")
    await Promise.all([mkdir(directory), mkdir(other)])
    const client = make({ endpoint, location: { directory: other } })
    const location = await client.location.get({ location: { directory } })
    const options = {
      headers: {
        "x-ycoding-directory": encodeURIComponent(location.directory),
        ...(location.workspaceID ? { "x-ycoding-workspace": location.workspaceID } : {}),
      },
    }
    return {
      runtime,
      endpoint,
      client,
      location,
      directory,
      options,
      async [Symbol.asyncDispose]() {
        client.transport.close()
        await runtime.dispose()
      },
    }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

test("full TUI replies and cancels Rust global Forms in their Location and rehydrates on reconnect", async () => {
  await using source = await start()
  const client = source.client
  const formLists: string[][] = []
  const listForms = client.form.request.list
  let resolveFormListReload: (() => void) | undefined
  client.form.request.list = async (input, options) => {
    const response = await listForms(input, options)
    formLists.push(response.data.map((form) => form.id))
    resolveFormListReload?.()
    resolveFormListReload = undefined
    return response
  }
  const config = createTuiResolvedConfig()
  const createdForms: string[] = []
  const createdOwners: string[] = []
  const createdLocations: (string | undefined)[] = []
  const createdWorkspaceIDs: (string | undefined)[] = []
  const listenedForms: string[] = []
  const projectedForms: string[][] = []
  const reconnected = Promise.withResolvers<void>()
  let serverConnections = 0
  let data!: ReturnType<typeof useData>
  let connection!: ReturnType<typeof useClient>
  function Forms() {
    data = useData()
    connection = useClient()
    const location = useLocation()
    onMount(() => location.set(source.location))
    onCleanup(
      connection.event.on("form.created", (event) => {
        createdForms.push(event.data.form.id)
        createdOwners.push(event.data.form.sessionID)
        createdLocations.push(event.location?.directory)
        createdWorkspaceIDs.push(event.location?.workspaceID)
      }),
    )
    onCleanup(
      connection.event.on("server.connected", () => {
        serverConnections += 1
        if (serverConnections === 2) reconnected.resolve()
      }),
    )
    onCleanup(
      connection.event.listen(({ details }) => {
        if (details.type === "form.created") {
          listenedForms.push(details.data.form.id)
          projectedForms.push(data.session.form.list("global", source.location)?.map((form) => form.id) ?? [])
        }
      }),
    )
    const current = () => data.session.form.list("global", source.location)?.[0]
    return (
      <Show when={current() && formKey(current()!)} keyed fallback={<text>No pending form</text>}>
        {(_) => {
          const form = current()!
          return <FormPrompt form={form} />
        }}
      </Show>
    )
  }
  const first = await client.form.create(
    { sessionID: "global", title: "Full global reply", fields: [{ key: "ok", type: "boolean" }] },
    source.options,
  )
  const app = await testRender(
    () => (
      <TestTuiContexts
        directory={source.directory}
        paths={{ home: source.runtime.configDir, state: path.join(source.runtime.configDir, "tui-state") }}
      >
        <ClipboardProvider value={{ write: async () => {} }}>
          <ConfigProvider config={config}>
            <Keymap.Provider>
              <ClientProvider api={client}>
                <DataProvider>
                  <LocationProvider>
                    <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                      <ToastProvider>
                        <Forms />
                      </ToastProvider>
                    </ThemeProvider>
                  </LocationProvider>
                </DataProvider>
              </ClientProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </ClipboardProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24, kittyKeyboard: true },
  )
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("Full global reply"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("No pending form"))
    expect(await client.form.state({ sessionID: "global", formID: first.id }, source.options)).toMatchObject({
      status: "answered",
    })
    const second = await client.form.create(
      { sessionID: "global", title: "Full global cancel", fields: [{ key: "value", type: "string" }] },
      source.options,
    )
    expect(second.id).not.toBe(first.id)
    await app.waitFor(() => createdForms.includes(second.id))
    expect(createdForms).toContain(second.id)
    expect(listenedForms).toContain(second.id)
    expect(projectedForms.at(-1)).toContain(second.id)
    expect(createdOwners.at(-1)).toBe("global")
    expect(createdLocations.at(-1)).toBe(source.location.directory)
    expect(createdWorkspaceIDs.at(-1)).toBe(source.location.workspaceID)
    await app.waitFor(
      () => data.session.form.list("global", source.location)?.some((form) => form.id === second.id) ?? false,
    )
    expect(data.session.form.list("global", source.location)?.some((form) => form.id === second.id)).toBe(true)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Full global cancel")
    const formListReload = Promise.withResolvers<void>()
    resolveFormListReload = formListReload.resolve
    await client.transport.reconnect()
    await reconnected.promise
    await formListReload.promise
    expect(formLists.at(-1)).toContain(second.id)
    await app.waitFor(
      () => data.session.form.list("global", source.location)?.some((form) => form.id === second.id) ?? false,
    )
    expect(data.session.form.list("global", source.location)?.map((form) => form.id)).toEqual([second.id])
    await app.waitForFrame((frame) => frame.includes("Full global cancel"))
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("No pending form"))
    expect(await client.form.state({ sessionID: "global", formID: second.id }, source.options)).toMatchObject({
      status: "cancelled",
    })
    expect(data.session.form.list("global", source.location)).toEqual([])
  } finally {
    app.renderer.destroy()
    client.transport.close()
  }
}, 120_000)

test("Mini runtime routes reply/cancel to the global Form Location and removes the rendered blocker after reconnect", async () => {
  await using source = await start()
  const mini = make({ endpoint: source.endpoint, location: { directory: "/wrong-default" } })
  const session = await source.client.session.create({ location: { directory: source.directory } })
  const first = await source.client.form.create(
    { sessionID: "global", title: "Mini global reply", fields: [{ key: "ok", type: "boolean" }] },
    source.options,
  )
  const [view, setView] = createSignal<FooterView>({ type: "prompt" })
  const footer = createFooterApiFixture()
  const ready = Promise.withResolvers<void>()
  const rehydrated = Promise.withResolvers<void>()
  let app!: Awaited<ReturnType<typeof testRender>>
  const host: MiniHost = {
    terminal: { stdin: process.stdin },
    platform: "darwin",
    stdout: { write() {} },
    files: { readText: async () => "" },
    editor: { open: async () => undefined },
    paths: { home: source.runtime.configDir },
    signals: { sigint: { subscribe: () => () => {} }, sigusr2: { subscribe: () => () => {} } },
    startup: { showTiming: false, now: () => 0 },
    diagnostics: {},
    preferences: { resolveVariant: async () => undefined, saveVariant: async () => {} },
  }
  const task = runInteractiveDeferredMode(
    {
      host,
      sdk: mini,
      directory: source.directory,
      target: async () => ({
        sessionID: session.id,
        location: await source.client.location.get({ location: { directory: source.directory } }),
        agent: "build",
        model: undefined,
        variant: undefined,
        resume: false,
      }),
      reconnect: async () => {
        const next = make({ endpoint: source.endpoint, location: { directory: "/wrong-default" } })
        const list = next.form.request.list
        next.form.request.list = async (request, options) => {
          const result = await list(request, options)
          rehydrated.resolve()
          return result
        }
        await next.transport.ready()
        return next
      },
      agent: "build",
      model: undefined,
      variant: undefined,
      files: [],
      thinking: false,
    },
    {
      createRuntimeLifecycle: async (input) => {
        const original = footer.api.event
        footer.api.event = (event) => {
          original(event)
          if (event.type === "stream.view") setView(event.view)
        }
        app = await testRender(
          () => (
            <Show when={view().type === "form" ? view() : undefined} keyed fallback={<text>Mini composer ready</text>}>
              {(current) =>
                current.type === "form" ? (
                  <RunFormBody
                    request={current.request}
                    theme={RUN_THEME_FALLBACK.footer}
                    onReply={input.onFormReply}
                    onCancel={input.onFormCancel}
                  />
                ) : null
              }
            </Show>
          ),
          { width: 80, height: 24, kittyKeyboard: true },
        )
        app.renderer.start()
        ready.resolve()
        return {
          footer: footer.api,
          onResize: () => () => {},
          refreshTheme: () => {},
          resetForReplay: async () => {},
          close: async () => {},
        }
      },
    },
  )
  try {
    await ready.promise
    await app.waitForFrame((frame) => frame.includes("Mini global reply"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Mini composer ready"))
    expect(await source.client.form.state({ sessionID: "global", formID: first.id }, source.options)).toMatchObject({
      status: "answered",
    })
    const second = await source.client.form.create(
      { sessionID: "global", title: "Mini global cancel", fields: [{ key: "value", type: "string" }] },
      source.options,
    )
    await app.waitForFrame((frame) => frame.includes("Mini global cancel"))
    await mini.transport.reconnect()
    await rehydrated.promise
    await app.waitForFrame((frame) => frame.includes("Mini global cancel"))
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("Mini composer ready"))
    expect(await source.client.form.state({ sessionID: "global", formID: second.id }, source.options)).toMatchObject({
      status: "cancelled",
    })
  } finally {
    footer.api.close()
    await task
    app?.renderer.destroy()
    mini.transport.close()
  }
}, 120_000)
