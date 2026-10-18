import { expect, test } from "bun:test"
import path from "node:path"
import { decodeDomain, encodeDomain, YCoding } from "@ycoding-ai/client/v5"
import { decodeLossless } from "@ycoding-ai/protocol/v5"
import { ScriptedPeer } from "../../client/test/fixture/v5-peer"
import {
  PRIVATE_MARKER,
  captureSmokeOutput,
  isolatedBrowserSmokeEnvironment,
  runIsolatedBrowserSmoke,
  stopSmokeRuntime,
} from "./isolated-browser-smoke"

test("browser smoke isolates native configuration, home overrides, stores, and temporary paths on every host", () => {
  const root = path.resolve("/fixture/isolated-smoke")
  const ambient = Object.fromEntries(
    [
      "HOME",
      "YCODING_TEST_HOME",
      "TMPDIR",
      "TMP",
      "TEMP",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
      "YCODING_DB",
      "YCODING_SQLITE_IMPORT_SOURCE",
      "YCODING_CONFIG_DIR",
      "YCODING_CONFIG",
      "YCODING_CONFIG_CONTENT",
      "YCODING_REMOTE_URL",
      "NODE_TLS_REJECT_UNAUTHORIZED",
    ].map((key) => [key, `ambient-${key}`]),
  )
  const env = isolatedBrowserSmokeEnvironment(root, {
    ...ambient,
    PATH: "retained-path",
    YCODING_CONFIG_PROJECT_DISABLE: "0",
  })
  expect(Reflect.get(env, "PATH")).toBe("retained-path")
  expect(env.HOME).toBe(path.join(root, "home"))
  expect(env.YCODING_TEST_HOME).toBe(env.HOME)
  for (const [key, directory] of [
    ["XDG_CONFIG_HOME", "config"],
    ["XDG_DATA_HOME", "data"],
    ["XDG_CACHE_HOME", "cache"],
    ["XDG_STATE_HOME", "state"],
  ])
    expect(Reflect.get(env, key)).toBe(path.join(root, directory))
  for (const key of ["TMPDIR", "TMP", "TEMP"]) expect(Reflect.get(env, key)).toBe(path.join(root, "tmp"))
  for (const key of [
    "YCODING_DB",
    "YCODING_SQLITE_IMPORT_SOURCE",
    "YCODING_CONFIG",
    "YCODING_CONFIG_CONTENT",
    "YCODING_REMOTE_URL",
    "NODE_TLS_REJECT_UNAUTHORIZED",
  ])
    expect(Reflect.get(env, key)).toBeUndefined()
  expect(env.YCODING_CONFIG_DIR).toBe(path.join(root, "config", "ycoding"))
  expect(env.YCODING_CONFIG_PROJECT_DISABLE).toBe("1")
  expect(env.YCODING_DISABLE_MODELS_FETCH).toBe("1")
  expect(env.YCODING_DISABLE_CHANNEL_DB).toBe("1")
})

const project = "/fixture/packaged-browser"
const sessionID = "ses_isolated_packaged_smoke"
const page = { origin: "http://127.0.0.1:43210", path: "/fixture" }
const tab = {
  id: "btab_packaged",
  sessionID,
  title: "Packaged fixture",
  page,
  status: "shared",
  generation: 1,
  documentGeneration: 2,
  observationRevision: 3,
}
const started = { mode: "isolated", state: "ready", instanceID: "ibrowser_packaged", tab }
const observed = {
  mode: "isolated",
  instanceID: started.instanceID,
  tabID: tab.id,
  generation: tab.generation,
  documentGeneration: tab.documentGeneration,
  revision: 4,
  title: tab.title,
  page,
  elements: [{ ref: "button_1", role: "button", name: "Submit" }],
  truncated: false,
}

function fixture(
  options: { reject?: string; stall?: string; observation?: unknown; action?: unknown; actions?: number } = {},
) {
  const peer = new ScriptedPeer()
  const requests: { name: string; input: unknown }[] = []
  let actions = 0
  peer.onRequest = (dispatch) => {
    const name = dispatch.operation.diagnosticName
    requests.push({ name, input: decodeDomain(dispatch.operation.requestType, dispatch.request.payload) })
    if (name !== "session.create") {
      expect(dispatch.request.scope?.target.case).toBe("session")
      if (dispatch.request.scope?.target.case === "session") expect(dispatch.request.scope.target.value).toBe(sessionID)
    } else {
      expect(dispatch.request.scope?.target.case).toBe("location")
      if (dispatch.request.scope?.target.case === "location")
        expect(decodeLossless(dispatch.request.scope.target.value)).toBe(project)
    }
    if (name === options.stall) return
    if (name === options.reject) return peer.reject(dispatch)
    if (name === "isolatedBrowser.action") actions++
    const results: Record<string, unknown> = {
      "session.create": {
        data: {
          id: sessionID,
          projectID: "project_fixture",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
          title: "Packaged browser",
          location: { directory: project },
        },
      },
      "isolatedBrowser.start": { data: started },
      "isolatedBrowser.observe": { data: options.observation ?? observed },
      "isolatedBrowser.action": {
        data: options.action ?? {
          mode: "isolated",
          instanceID: started.instanceID,
          callID: "click-packaged",
          tab: { ...tab, title: "Clicked" },
          status: "completed",
        },
      },
      "isolatedBrowser.stop": { data: {} },
      "isolatedBrowser.status": { data: { mode: "isolated", state: "stopped" } },
      "session.remove": { data: {} },
    }
    if (!(name in results)) throw new Error(`Unexpected smoke operation: ${name}`)
    peer.result(dispatch, {
      typeName: dispatch.operation.resultType,
      payload: encodeDomain(dispatch.operation.resultType, results[name]),
    })
  }
  const client = YCoding.make({
    endpoint: { url: "http://127.0.0.1:43211" },
    location: { directory: project },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  return {
    client,
    peer,
    requests,
    run: () =>
      runIsolatedBrowserSmoke(client, {
        project,
        url: `${page.origin}${page.path}?private=${PRIVATE_MARKER}`,
        actions: () => options.actions ?? actions,
        timeout: 100,
      }),
  }
}

test("packaged browser smoke uses typed v5 ownership and observation fences, then cleans its Session", async () => {
  const smoke = fixture()
  await smoke.run()
  expect(smoke.requests.map((request) => request.name)).toEqual([
    "session.create",
    "isolatedBrowser.start",
    "isolatedBrowser.observe",
    "isolatedBrowser.action",
    "isolatedBrowser.stop",
    "isolatedBrowser.status",
    "session.remove",
  ])
  expect(smoke.requests[0].input).toEqual({ payload: { id: sessionID, location: { directory: project } } })
  expect(smoke.requests[3].input).toEqual({
    params: { sessionID },
    payload: {
      instanceID: started.instanceID,
      tabID: tab.id,
      generation: observed.generation,
      documentGeneration: observed.documentGeneration,
      observationRevision: observed.revision,
      callID: "click-packaged",
      action: { type: "click", ref: "button_1" },
    },
  })
  expect(smoke.client.transport.state).toBe("closed")
})

test("browser smoke preserves typed rejection diagnostics and cleans up after observe failure", async () => {
  const smoke = fixture({ reject: "isolatedBrowser.observe" })
  await expect(smoke.run()).rejects.toThrow("observe isolated browser: InvalidRequestError: Scripted rejection")
  expect(smoke.requests.map((request) => request.name)).not.toContain("isolatedBrowser.action")
  expect(smoke.requests.slice(-3).map((request) => request.name)).toEqual([
    "isolatedBrowser.stop",
    "isolatedBrowser.status",
    "session.remove",
  ])
  expect(smoke.client.transport.state).toBe("closed")
})

test("browser smoke rejects a cross-owner observation before dispatching a click", async () => {
  const smoke = fixture({ observation: { ...observed, instanceID: "ibrowser_foreign" } })
  await expect(smoke.run()).rejects.toThrow("observation changed browser ownership")
  expect(smoke.requests.map((request) => request.name)).not.toContain("isolatedBrowser.action")
})

test("browser smoke fails private-marker disclosure without printing the marker", async () => {
  const smoke = fixture({ observation: { ...observed, title: PRIVATE_MARKER } })
  const error = await smoke.run().catch((error: unknown) => error)
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).toContain("disclosed a private marker")
  expect(String(error)).not.toContain(PRIVATE_MARKER)
  expect(smoke.requests.map((request) => request.name)).not.toContain("isolatedBrowser.action")
})

test("browser smoke bounds an unanswered action without retrying it and still attempts cleanup", async () => {
  const smoke = fixture({ stall: "isolatedBrowser.action" })
  await expect(smoke.run()).rejects.toThrow("click isolated browser: timed out")
  expect(smoke.requests.filter((request) => request.name === "isolatedBrowser.action")).toHaveLength(1)
  expect(smoke.requests.at(-1)?.name).toBe("session.remove")
  expect(smoke.client.transport.state).toBe("closed")
})

test("browser smoke still removes its Session and closes transport when browser stop fails", async () => {
  const smoke = fixture({ reject: "isolatedBrowser.stop" })
  await expect(smoke.run()).rejects.toThrow("stop isolated browser: InvalidRequestError: Scripted rejection")
  expect(smoke.requests.at(-1)?.name).toBe("session.remove")
  expect(smoke.client.transport.state).toBe("closed")
})

test.each(["rejected", "uncertain"])(
  "browser smoke fails %s clicks without replaying their side effect",
  async (status) => {
    const smoke = fixture({
      action: { mode: "isolated", instanceID: started.instanceID, callID: "click-packaged", tab, status },
    })
    await expect(smoke.run()).rejects.toThrow(`Packaged click did not complete: ${status}`)
    expect(smoke.requests.filter((request) => request.name === "isolatedBrowser.action")).toHaveLength(1)
    expect(smoke.requests.at(-1)?.name).toBe("session.remove")
  },
)

test.each([0, 2])("browser smoke fails when the fixture receives %i actions", async (actions) => {
  const smoke = fixture({ actions })
  await expect(smoke.run()).rejects.toThrow(
    actions === 0 ? "wait for browser action fixture: timed out" : "more than once",
  )
  expect(smoke.requests.at(-1)?.name).toBe("session.remove")
})

test("browser smoke drains readiness and detects markers split across log chunks with a bounded redacted tail", async () => {
  const stream = new TransformStream<Uint8Array, Uint8Array>()
  const writer = stream.writable.getWriter()
  const output = captureSmokeOutput(stream.readable)
  const encoder = new TextEncoder()
  await writer.write(encoder.encode('\n{"url":"http://127.0.0.1:12345"'))
  let ready = false
  void output.firstLine.then(() => {
    ready = true
  })
  await Bun.sleep(1)
  expect(ready).toBe(false)
  await writer.write(encoder.encode("}\n" + "x".repeat(100_000) + PRIVATE_MARKER.slice(0, 20)))
  expect(await output.firstLine).toBe('{"url":"http://127.0.0.1:12345"}')
  await writer.write(encoder.encode(PRIVATE_MARKER.slice(20)))
  await writer.close()
  await output.done
  expect(output.leaked()).toBe(true)
  expect(output.tail()).not.toContain(PRIVATE_MARKER)
  expect(output.tail()).toEndWith("[private marker]")
  expect(output.tail().length).toBeLessThanOrEqual(8_192)
})

test("browser smoke refuses an oversized readiness line but keeps draining runtime output", async () => {
  const stream = new TransformStream<Uint8Array, Uint8Array>()
  const writer = stream.writable.getWriter()
  const output = captureSmokeOutput(stream.readable)
  await writer.write(new TextEncoder().encode("x".repeat(65_537)))
  await expect(output.firstLine).rejects.toThrow("readiness exceeded 64 KiB")
  await writer.write(new TextEncoder().encode(PRIVATE_MARKER))
  await writer.close()
  await output.done
  expect(output.leaked()).toBe(true)
})

test("browser smoke reports early runtime exit without waiting for readiness timeout", async () => {
  const output = captureSmokeOutput(
    new ReadableStream({
      start(controller) {
        controller.close()
      },
    }),
  )
  await expect(output.firstLine).rejects.toThrow("produced no readiness line")
  await output.done
})

test("browser smoke gracefully joins its stdio child before cleanup", async () => {
  const child = Bun.spawn(
    [process.execPath, "-e", 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'],
    {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    },
  )
  try {
    await stopSmokeRuntime(child)
    expect(child.exitCode).toBe(0)
  } finally {
    child.kill()
    await child.exited
  }
})

test("browser smoke escalates a stuck owned child to bounded termination", async () => {
  const exited = Promise.withResolvers<number>()
  const events: (string | number)[] = []
  await expect(
    stopSmokeRuntime(
      {
        stdin: {
          end() {
            events.push("stdin closed")
          },
        },
        kill(signal) {
          events.push(signal ?? "terminate")
          if (signal === 9) exited.resolve(137)
        },
        exited: exited.promise,
      },
      10,
    ),
  ).rejects.toThrow("Packaged runtime exited with code 137")
  expect(events).toEqual(["stdin closed", 15, 9])
})

test("browser smoke joins and terminates its child after stdin closure fails", async () => {
  const exited = Promise.withResolvers<number>()
  const events: number[] = []
  await expect(
    stopSmokeRuntime(
      {
        stdin: {
          end() {
            throw new Error("sink already failed")
          },
        },
        kill(signal) {
          events.push(signal!)
          exited.resolve(0)
        },
        exited: exited.promise,
      },
      10,
    ),
  ).rejects.toThrow("sink already failed")
  expect(events).toEqual([15])
  expect(await exited.promise).toBe(0)
})

test("browser smoke continues bounded cleanup after a termination signal error", async () => {
  const exited = Promise.withResolvers<number>()
  const events: number[] = []
  await expect(
    stopSmokeRuntime(
      {
        stdin: { end() {} },
        kill(signal) {
          events.push(signal!)
          if (signal === 15) throw new Error("termination signal failed")
          exited.resolve(0)
        },
        exited: exited.promise,
      },
      10,
    ),
  ).rejects.toThrow("termination signal failed")
  expect(events).toEqual([15, 9])
  expect(await exited.promise).toBe(0)
})
