import { expect, test } from "bun:test"
import { IsolatedBrowser } from "@ycoding-ai/core/isolated-browser"
import { ServerProcess } from "@ycoding-ai/server/process"
import { Effect, Exit, Logger, Schema, Scope } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

const statusResponse = Schema.Struct({ data: IsolatedBrowser.Schema.Status })
const observationResponse = Schema.Struct({ data: IsolatedBrowser.Schema.Observation })
const actionResponse = Schema.Struct({ data: IsolatedBrowser.Schema.ActionResult })
const auth = `Basic ${Buffer.from("ycoding:test-password").toString("base64")}`

test("authenticates the complete lifecycle without disclosing page-private markers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-server-isolated-browser-"))
  const privateQuery = "private-query-marker-7b31"
  const privateInput = "private-input-marker-3d92"
  const privateDOM = "private-dom-marker-8f14"
  const fixture = browserFixture({ privateInput, privateDOM })
  const server = await startServer({ directory, database: { path: ":memory:" } })
  const sessionID = "ses_isolated_server_owner"

  try {
    expect((await fetch(`${server.base}/api/session/${sessionID}/browser/isolated`)).status).toBe(401)
    await createSession(server, sessionID, directory)
    expect(await status(server, sessionID)).toEqual({ mode: "isolated", state: "stopped" })

    const started = await startBrowser(
      server,
      sessionID,
      `http://127.0.0.1:${fixture.server.port}/fixture?private=${privateQuery}#not-projected`,
    )
    expect(started).toMatchObject({
      mode: "isolated",
      state: "ready",
      tab: { sessionID, page: { origin: `http://127.0.0.1:${fixture.server.port}`, path: "/fixture" } },
    })
    const observed = await observe(server, sessionID, started, "observe-server")
    const button = observed.elements.find((element) => element.role === "button" && element.name === "Submit")
    expect(button).toBeDefined()
    const actionHTTP = await server.request(
      `/api/session/${sessionID}/browser/isolated/action`,
      json({
        instanceID: started.instanceID,
        tabID: observed.tabID,
        generation: observed.generation,
        documentGeneration: observed.documentGeneration,
        observationRevision: observed.revision,
        callID: "click-server",
        action: { type: "click", ref: button!.ref },
      }),
    )
    expect(actionHTTP.status, await actionHTTP.clone().text()).toBe(200)
    const action = Schema.decodeUnknownSync(actionResponse)(await actionHTTP.json()).data
    expect(action).toMatchObject({
      mode: "isolated",
      instanceID: started.instanceID,
      callID: "click-server",
      status: "completed",
      tab: { title: "Clicked" },
    })

    const messages = await (await server.request(`/api/session/${sessionID}/message`)).text()
    const events = await (await server.request(`/api/experimental/session/${sessionID}/log?follow=false`)).text()
    const publicOutput = JSON.stringify({ started, observed, action, messages, events, logs: server.logs })
    expect(publicOutput).not.toContain(privateQuery)
    expect(publicOutput).not.toContain(privateInput)
    expect(publicOutput).not.toContain(privateDOM)

    expect((await server.request(`/api/session/${sessionID}/browser/isolated`, { method: "DELETE" })).status).toBe(204)
    expect(await status(server, sessionID)).toEqual({ mode: "isolated", state: "stopped" })
  } finally {
    await server.close()
    await fixture.server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

test("derives the Location from the Session and invalidates cross-Location and disposed references", async () => {
  const root = await mkdtemp(join(tmpdir(), "ycoding-server-isolated-browser-location-"))
  const firstDirectory = join(root, "first")
  const secondDirectory = join(root, "second")
  await Promise.all([Bun.write(join(firstDirectory, ".keep"), ""), Bun.write(join(secondDirectory, ".keep"), "")])
  const fixture = browserFixture({ countActions: true })
  const server = await startServer({ directory: root, database: { path: ":memory:" } })
  const firstSessionID = "ses_isolated_location_first"
  const secondSessionID = "ses_isolated_location_second"

  try {
    await createSession(server, firstSessionID, firstDirectory)
    await createSession(server, secondSessionID, secondDirectory)
    const first = await startBrowser(server, firstSessionID, fixture.url)
    const observed = await observe(server, firstSessionID, first, "observe-location-owner")
    const button = observed.elements.find((element) => element.role === "button" && element.name === "Submit")
    expect(button).toBeDefined()

    const redirected = Schema.decodeUnknownSync(statusResponse)(
      await (
        await server.request(`/api/session/${firstSessionID}/browser/isolated`, {
          headers: { "x-ycoding-directory": secondDirectory },
        })
      ).json(),
    ).data
    expect(redirected).toMatchObject({ state: "ready", instanceID: first.instanceID })

    const location = new URLSearchParams({ "location[directory]": firstDirectory })
    expect((await server.request(`/api/debug/location?${location}`, { method: "DELETE" })).status).toBe(204)
    expect(await status(server, firstSessionID)).toEqual({ mode: "isolated", state: "stopped" })
    const disposed = await action(server, firstSessionID, first, observed, button!.ref, "disposed-location")
    expect(disposed.status).toBe(503)
    expect(fixture.actions()).toBe(0)

    const second = await startBrowser(server, secondSessionID, fixture.url)
    const crossLocation = await action(server, secondSessionID, first, observed, button!.ref, "cross-location")
    expect(crossLocation.status).toBe(403)
    expect(fixture.actions()).toBe(0)
    expect(await status(server, secondSessionID)).toMatchObject({ state: "ready", instanceID: second.instanceID })
  } finally {
    await server.close()
    await fixture.server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

test("keeps a durable Session stopped after restart and never dispatches old instance references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-server-isolated-browser-restart-"))
  const database = join(directory, "isolated-browser.db")
  const fixture = browserFixture({ countActions: true })
  const sessionID = "ses_isolated_server_restart"
  const first = await startServer({ directory, database: { path: database } })
  let second: TestServer | undefined

  try {
    await createSession(first, sessionID, directory)
    const started = await startBrowser(first, sessionID, fixture.url)
    const observed = await observe(first, sessionID, started, "observe-before-restart")
    const button = observed.elements.find((element) => element.role === "button" && element.name === "Submit")
    expect(button).toBeDefined()
    expect(fixture.loads()).toBe(1)
    await first.close()

    second = await startServer({ directory, database: { path: database } })
    expect(await status(second, sessionID)).toEqual({ mode: "isolated", state: "stopped" })
    expect(fixture.loads()).toBe(1)
    const stale = await action(second, sessionID, started, observed, button!.ref, "stale-after-restart")
    expect(stale.status).toBe(503)
    expect(fixture.actions()).toBe(0)
    expect(fixture.loads()).toBe(1)

    const restarted = await startBrowser(second, sessionID, fixture.url)
    expect(restarted.instanceID).not.toBe(started.instanceID)
    expect(fixture.loads()).toBe(2)
    expect(fixture.actions()).toBe(0)
  } finally {
    await first.close()
    if (second) await second.close()
    await fixture.server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}, 90_000)

test.each(["moved", "archived", "deleted"] as const)(
  "releases isolated-browser ownership when its durable Session is %s",
  async (transition) => {
    const root = await mkdtemp(join(tmpdir(), `ycoding-server-isolated-browser-${transition}-`))
    const source = join(root, "source")
    const destination = join(root, "destination")
    await Promise.all([Bun.write(join(source, ".keep"), ""), Bun.write(join(destination, ".keep"), "")])
    const fixture = lifecycleFixture()
    const server = await startServer({ directory: root, database: { path: ":memory:" } })
    const sessionID = `ses_isolated_${transition}`

    try {
      await createSession(server, sessionID, source)
      const started = await startBrowser(server, sessionID, fixture.url)
      const observed = await observe(server, sessionID, started, `observe-${transition}`)
      const blocker = observed.elements.find((element) => element.role === "button" && element.name === "Block")
      expect(blocker).toBeDefined()
      await eventually(() => (fixture.streamActivity() >= 2 && fixture.streams() >= 1 ? true : undefined))

      const pending = action(server, sessionID, started, observed, blocker!.ref, `pending-${transition}`)
      await eventually(() => (fixture.blocked() >= 1 ? true : undefined))
      const transitionHTTP = await transitionSession(server, sessionID, transition, destination)
      expect(transitionHTTP.status, await transitionHTTP.clone().text()).toBe(204)
      const pendingHTTP = await pending
      expect(pendingHTTP.status, await pendingHTTP.clone().text()).toBe(200)
      expect(Schema.decodeUnknownSync(actionResponse)(await pendingHTTP.json()).data).toMatchObject({
        instanceID: started.instanceID,
        callID: `pending-${transition}`,
        status: "uncertain",
      })

      await eventually(() => (fixture.closedStreams() >= 1 ? true : undefined))
      const settledActivity = await stableValue(fixture.streamActivity)
      await Bun.sleep(150)
      expect(fixture.streamActivity()).toBe(settledActivity)
      const staleBeforeRestore = await action(
        server,
        sessionID,
        started,
        observed,
        blocker!.ref,
        `stale-${transition}`,
      )
      expect(staleBeforeRestore.status).toBe(transition === "moved" ? 503 : 404)
      expect(fixture.blocked()).toBe(1)

      await restoreSession(server, sessionID, transition, source)
      const restarted = await startBrowser(server, sessionID, fixture.url)
      expect(restarted.instanceID).not.toBe(started.instanceID)
      const staleAfterRestore = await action(
        server,
        sessionID,
        started,
        observed,
        blocker!.ref,
        `restored-stale-${transition}`,
      )
      expect(staleAfterRestore.status).toBe(403)
      expect(fixture.blocked()).toBe(1)
      expect((await server.request(`/api/session/${sessionID}/browser/isolated`, { method: "DELETE" })).status).toBe(204)
    } finally {
      await server.close()
      await fixture.server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000,
)

type TestServer = Awaited<ReturnType<typeof startServer>>

async function startServer(options: { directory: string; database: { readonly path: string } }) {
  const port = await availablePort()
  const scope = await Effect.runPromise(Scope.make())
  const logs: string[] = []
  const logger = Logger.map(Logger.formatStructured, (entry) => logs.push(JSON.stringify(entry)))
  const startingRaw = ServerProcess.start<never, never>({
    hostname: "127.0.0.1",
    port,
    password: "test-password",
    database: options.database,
    config: { directory: options.directory, project: false, content: "{}" },
    fs: { filewatcher: false, fff: false },
  }).pipe(Effect.provideService(Scope.Scope, scope))
  // Runtime-owned request markers are supplied when the assembled router dispatches.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const starting = startingRaw as Effect.Effect<Effect.Success<typeof startingRaw>, Effect.Error<typeof startingRaw>>
  await Effect.runPromise(starting.pipe(Effect.provide(Logger.layer([logger]))))
  let closed = false
  const base = `http://127.0.0.1:${port}`
  return {
    base,
    logs,
    request(path: string, options: RequestInit = {}) {
      const headers = new Headers(options.headers)
      headers.set("authorization", auth)
      return fetch(`${base}${path}`, { ...options, headers })
    },
    async close() {
      if (closed) return
      closed = true
      await Effect.runPromise(Scope.close(scope, Exit.void))
    },
  }
}

function browserFixture(options: {
  readonly privateInput?: string
  readonly privateDOM?: string
  readonly countActions?: boolean
}) {
  let loads = 0
  let actions = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/action") {
        actions++
        return new Response(null, { status: 204 })
      }
      if (url.pathname !== "/fixture") return new Response(null, { status: 204 })
      loads++
      return new Response(
        `<!doctype html><title>Fixture</title><button aria-label="Submit" onclick="${
          options.countActions ? "fetch('/action', { method: 'POST' });" : ""
        }document.title='Clicked'">Go</button><input aria-label="Name" value="${
          options.privateInput ?? ""
        }"><div hidden>${options.privateDOM ?? ""}</div>`,
        { headers: { "content-type": "text/html" } },
      )
    },
  })
  return {
    server,
    url: `http://127.0.0.1:${server.port}/fixture`,
    loads: () => loads,
    actions: () => actions,
  }
}

function lifecycleFixture() {
  let blocked = 0
  let streams = 0
  let closedStreams = 0
  let streamActivity = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/blocked") {
        blocked++
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/stream") {
        streams++
        const body = new ReadableStream({
          start(controller) {
            const interval = setInterval(() => {
              streamActivity++
              controller.enqueue(new TextEncoder().encode("activity\n"))
            }, 20)
            request.signal.addEventListener(
              "abort",
              () => {
                clearInterval(interval)
                closedStreams++
                controller.close()
              },
              { once: true },
            )
          },
        })
        return new Response(body, { headers: { "content-type": "text/plain" } })
      }
      if (url.pathname !== "/fixture") return new Response(null, { status: 204 })
      return new Response(
        `<!doctype html><title>Lifecycle fixture</title><button aria-label="Block" onclick="fetch('/blocked',{method:'POST'});while(true){}">Block</button><script>fetch('/stream')</script>`,
        { headers: { "content-type": "text/html" } },
      )
    },
  })
  return {
    server,
    url: `http://127.0.0.1:${server.port}/fixture`,
    blocked: () => blocked,
    streams: () => streams,
    closedStreams: () => closedStreams,
    streamActivity: () => streamActivity,
  }
}

function transitionSession(
  server: TestServer,
  sessionID: string,
  transition: "moved" | "archived" | "deleted",
  destination: string,
) {
  if (transition === "moved")
    return server.request(`/api/session/${sessionID}/move`, json({ directory: destination }))
  if (transition === "archived") return server.request(`/api/session/${sessionID}/archive`, { method: "POST" })
  return server.request(`/api/session/${sessionID}`, { method: "DELETE" })
}

async function restoreSession(
  server: TestServer,
  sessionID: string,
  transition: "moved" | "archived" | "deleted",
  source: string,
) {
  if (transition === "moved") {
    const response = await server.request(`/api/session/${sessionID}/move`, json({ directory: source }))
    expect(response.status, await response.clone().text()).toBe(204)
    return
  }
  if (transition === "archived") {
    const response = await server.request(`/api/session/${sessionID}/archive`, { method: "DELETE" })
    expect(response.status, await response.clone().text()).toBe(204)
    return
  }
  await createSession(server, sessionID, source)
}

async function eventually<T>(check: () => T | undefined, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = check()
    if (value !== undefined) return value
    await Bun.sleep(20)
  }
  throw new Error("timed out waiting for isolated-browser lifecycle evidence")
}

async function stableValue(read: () => number) {
  const deadline = Date.now() + 5_000
  let previous = read()
  while (Date.now() < deadline) {
    await Bun.sleep(100)
    const current = read()
    if (current === previous) return current
    previous = current
  }
  throw new Error("isolated-browser fixture activity did not stop")
}

async function createSession(server: TestServer, sessionID: string, directory: string) {
  const response = await server.request("/api/session", json({ id: sessionID, location: { directory } }))
  expect(response.status, await response.clone().text()).toBe(200)
}

async function status(server: TestServer, sessionID: string) {
  return Schema.decodeUnknownSync(statusResponse)(
    await (await server.request(`/api/session/${sessionID}/browser/isolated`)).json(),
  ).data
}

async function startBrowser(server: TestServer, sessionID: string, url: string) {
  const response = await server.request(`/api/session/${sessionID}/browser/isolated/start`, json({ url }))
  expect(response.status, await response.clone().text()).toBe(200)
  const started = Schema.decodeUnknownSync(statusResponse)(await response.json()).data
  if (!started.instanceID || !started.tab) throw new Error("isolated browser start omitted active instance metadata")
  return { ...started, instanceID: started.instanceID, tab: started.tab }
}

async function observe(
  server: TestServer,
  sessionID: string,
  started: Awaited<ReturnType<typeof startBrowser>>,
  callID: string,
) {
  const response = await server.request(
    `/api/session/${sessionID}/browser/isolated/observe`,
    json({
      instanceID: started.instanceID,
      tabID: started.tab.id,
      generation: started.tab.generation,
      callID,
    }),
  )
  expect(response.status, await response.clone().text()).toBe(200)
  return Schema.decodeUnknownSync(observationResponse)(await response.json()).data
}

function action(
  server: TestServer,
  sessionID: string,
  started: Awaited<ReturnType<typeof startBrowser>>,
  observed: IsolatedBrowser.Observation,
  ref: string,
  callID: string,
) {
  return server.request(
    `/api/session/${sessionID}/browser/isolated/action`,
    json({
      instanceID: started.instanceID,
      tabID: observed.tabID,
      generation: observed.generation,
      documentGeneration: observed.documentGeneration,
      observationRevision: observed.revision,
      callID,
      action: { type: "click", ref },
    }),
  )
}

function json(value: unknown) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  }
}

async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("failed to reserve isolated-browser test port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}
