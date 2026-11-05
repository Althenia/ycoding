import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { BackendController } from "../src/backend-controller"
import type { ConnectionState } from "../src/contract"
import { env, launch, message, peer, revision, syntheticBundle, writes } from "./synthetic-backend"

const hidden = "synthetic-hidden-value"
const sessionID = "ses_synthetic"
const switchPath = `/api/session/${sessionID}/model`
const stopFirst = "Stop the running chat before switching models."
const invalid = "This model is not in the current list. Refresh models and choose again."
const valid = { id: "synthetic-model", providerID: "synthetic-provider" }

const unconfirmed = "The model switch was not confirmed. Refresh models to see whether it changed."

type Backend = { session: unknown; active: () => unknown; location: unknown; models: unknown; fallback: unknown; inventory: unknown; reply: () => Promise<Response> }
type Observed = { routes: string[]; switches: unknown[]; locations: (string | null)[][] }
type Connection = { readonly pid?: () => number; readonly firstStreamEnds?: Promise<void>; readonly onState?: (state: ConnectionState) => void }

function modelRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "synthetic-model",
    modelID: "synthetic-upstream-model",
    providerID: "synthetic-provider",
    name: "Synthetic Model",
    settings: { token: hidden },
    headers: { authorization: hidden },
    body: { key: hidden },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [{ id: "fast", headers: { authorization: hidden } }, { id: "deep" }],
    profiles: [{ name: "work", active: true, variants: ["fast"] }],
    time: { released: 1 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 200_000, output: 32_000 },
    ...overrides,
  }
}

function sessionRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: sessionID,
    projectID: "prj_synthetic",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    title: "Synthetic",
    location: { directory: "/synthetic/repo" },
    model: valid,
    ...overrides,
  }
}

function backend(): Backend {
  return {
    session: sessionRecord(),
    active: () => ({}),
    location: { directory: "/synthetic/repo", project: { id: "prj_synthetic", directory: "/synthetic/repo" } },
    models: [modelRecord(), modelRecord({ id: { value: hidden }, name: "Malformed" })],
    fallback: { selection: valid, headers: { authorization: hidden } },
    inventory: [
      { projectID: "prj_synthetic", projectWorktree: "/synthetic/repo", directory: "/synthetic/repo", sessions: 1, timeActive: 1, available: true },
      { projectID: "prj_gone", projectWorktree: "/synthetic/gone", directory: "/synthetic/gone", sessions: 1, timeActive: 1, available: false },
    ],
    reply: () => Promise.resolve(new Response(null, { status: 204 })),
  }
}

async function connected(state: Backend, run: (controller: BackendController, observed: Observed, current: number) => Promise<void>, connection: Connection = {}) {
  const resources = await syntheticBundle()
  const observed: Observed = { routes: [], switches: [], locations: [] }
  using server = peer(observed.routes, connection.pid ?? (() => 101), async (route, request) => {
    if (route === "/api/session/active") return Response.json({ data: state.active() })
    if (route === `/api/session/${sessionID}`) return Response.json({ data: state.session })
    if (route === "/api/project/inventory") return Response.json({ data: state.inventory, cursor: {} })
    if (route === "/api/model" || route === "/api/model/default") {
      const query = new URL(request.url).searchParams
      observed.locations.push([query.get("location[directory]"), query.get("location[workspace]")])
      return Response.json({ location: state.location, data: route === "/api/model" ? state.models : state.fallback })
    }
    if (route !== switchPath || request.method !== "POST") return undefined
    const body: unknown = await request.json()
    observed.switches.push(body)
    return state.reply()
  }, connection.firstStreamEnds)
  const controller = new BackendController(resources, { env, launch, onState: connection.onState })
  try {
    await run(controller, observed, revision(await controller.connect({ mode: "shared", server: server.url.href })))
  } finally {
    await controller.disconnect()
    await fs.rm(resources, { recursive: true, force: true })
  }
}

test("repository directories are limited to 4096 UTF-8 bytes before a backend is used", async () => {
  const controller = new BackendController("/nonexistent-desktop-resources")
  const directory = `/${"é".repeat(2047)}x`
  for (const pending of [controller.createSession({ directory, sessionID }), controller.models({ directory })])
    expect(await message(pending)).toBe("Connect to a backend before using Sessions.")
  for (const pending of [controller.createSession({ directory: `${directory}é`, sessionID }), controller.models({ directory: `${directory}é` })])
    expect(await message(pending)).toBe("Choose a previously opened repository.")
})

test("a Session catalog is read for the backend Session's own location and carries only whitelisted fields", async () => {
  await connected(backend(), async (controller, observed, current) => {
    const result = await controller.models(sessionID)
    expect(result).toMatchObject({ revision: current, source: { sessionID }, current: valid, running: false, default: valid })
    expect(result.models.map((model) => model.id)).toEqual(["synthetic-model"])
    expect(JSON.stringify(result)).not.toContain(hidden)
    expect(observed.locations).toEqual([["/synthetic/repo", null], ["/synthetic/repo", null]])
    expect(observed.switches).toEqual([])
  })
}, 30_000)

test("a New chat catalog is read only for an available opened directory", async () => {
  await connected(backend(), async (controller, observed) => {
    const result = await controller.models({ directory: "/synthetic/repo" })
    expect(Object.keys(result).sort()).toEqual(["default", "models", "revision", "source"])
    expect(result.source).toEqual({ directory: "/synthetic/repo" })
    const reads = observed.locations.length
    expect(await message(controller.models({ directory: "/synthetic/gone" }))).toBe("Choose an available, previously opened repository for the new chat.")
    expect(observed.locations.length).toBe(reads)
  })
}, 30_000)

test("models served for another location are refused and no switch follows", async () => {
  await connected({ ...backend(), location: { directory: "/synthetic/other" } }, async (controller, observed, current) => {
    const refused = "The backend returned models for a different location. Refresh to retry."
    expect(await message(controller.models(sessionID))).toBe(refused)
    expect(await message(controller.switchModel({ sessionID, revision: current, model: valid }))).toBe(refused)
    expect(observed.switches).toEqual([])
  })
}, 30_000)

test("a switch sends exactly the listed choice after a fresh catalog check", async () => {
  await connected(backend(), async (controller, observed) => {
    const listed = await controller.models(sessionID)
    expect(await controller.switchModel({ sessionID, revision: listed.revision, model: { ...valid, profile: "work", variant: "fast" } })).toBeNull()
    expect(observed.switches).toEqual([{ model: { ...valid, variant: "fast", profile: "work" } }])
    expect(writes(observed.routes).filter((route) => route.startsWith("POST "))).toEqual([`POST ${switchPath}`])
  })
}, 30_000)

test("switching is refused while the Session runs, including a run that starts between the checks", async () => {
  await connected({ ...backend(), active: () => ({ [sessionID]: { type: "running" } }) }, async (controller, observed, current) => {
    expect(await controller.models(sessionID)).toMatchObject({ running: true })
    expect(await message(controller.switchModel({ sessionID, revision: current, model: valid }))).toBe(stopFirst)
    expect(observed.switches).toEqual([])
  })
  let reads = 0
  await connected({ ...backend(), active: () => ++reads === 1 ? {} : { [sessionID]: { type: "running" } } }, async (controller, observed, current) => {
    expect(await message(controller.switchModel({ sessionID, revision: current, model: valid }))).toBe(stopFirst)
    expect(reads).toBe(2)
    expect(observed.switches).toEqual([])
  })
  await connected({ ...backend(), active: () => ({ [sessionID]: { type: "queued" } }) }, async (controller, observed, current) => {
    expect(await message(controller.switchModel({ sessionID, revision: current, model: valid }))).toBe("The backend returned an invalid Session state. Refresh to retry.")
    expect(observed.switches).toEqual([])
  })
}, 30_000)

test("a switch refuses unlisted choices, another Session and malformed backend data before any mutation", async () => {
  const state = backend()
  await connected(state, async (controller, observed, current) => {
    const choose = (model: unknown) => message(controller.switchModel({ sessionID, revision: current, model }))
    for (const model of [{ ...valid, profile: "work", variant: "deep" }, { ...valid, profile: "missing" }, { ...valid, variant: "missing" }, { ...valid, headers: { authorization: hidden } }])
      expect(await choose(model)).toBe(invalid)
    const cases: [unknown, string][] = [
      [sessionRecord({ id: "ses_other" }), "The backend returned a different Session. Refresh and choose again."],
      [sessionRecord({ location: { directory: { value: hidden } } }), "The backend returned an invalid Session location. Refresh to retry."],
      [sessionRecord({ model: { id: { value: hidden }, providerID: "synthetic-provider" } }), "The backend returned an invalid Session model. Refresh to retry."],
    ]
    for (const [session, expected] of cases) {
      state.session = session
      expect(await choose(valid)).toBe(expected)
    }
    expect(observed.switches).toEqual([])
  })
}, 30_000)

test("a failed switch request is reported as not confirmed", async () => {
  await connected({ ...backend(), reply: () => Promise.resolve(new Response(null, { status: 500 })) }, async (controller, observed, current) => {
    expect(await message(controller.switchModel({ sessionID, revision: current, model: valid }))).toBe(unconfirmed)
    expect(observed.switches).toEqual([{ model: valid }])
  })
}, 30_000)

test("a switch in flight when the connection changes is reported as not confirmed and is not sent again", async () => {
  let pid = 101
  const switching = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const endFirstStream = Promise.withResolvers<void>()
  const reconnected = Promise.withResolvers<void>()
  const state: Backend = {
    ...backend(),
    reply: async () => {
      switching.resolve()
      await release.promise
      return new Response(null, { status: 204 })
    },
  }
  try {
    await connected(state, async (controller, observed, current) => {
      const inFlight = message(controller.switchModel({ sessionID, revision: current, model: valid }))
      await switching.promise
      pid = 202
      endFirstStream.resolve()
      await reconnected.promise
      release.resolve()
      expect(await inFlight).toBe("The model switch was not confirmed before the connection changed. Refresh models to see whether it changed.")
      expect(await message(controller.switchModel({ sessionID, revision: current, model: valid })))
        .toBe("The backend connection changed before the model was switched. Refresh models and choose again.")
      expect(observed.switches).toEqual([{ model: valid }])
      expect(writes(observed.routes).filter((route) => route.startsWith("POST "))).toEqual([`POST ${switchPath}`])
    }, { pid: () => pid, firstStreamEnds: endFirstStream.promise, onState: (next) => { if (next.status === "connected" && next.backendPID === 202) reconnected.resolve() } })
  } finally {
    release.resolve()
    endFirstStream.resolve()
  }
}, 30_000)

test("a backend model name over 1024 bytes is refused, and so is a backend Session record with a different ID", async () => {
  const state = backend()
  await connected(state, async (controller, observed, current) => {
    state.models = [modelRecord({ name: "x".repeat(1025) })]
    expect((await controller.models(sessionID)).models).toEqual([])
    expect(await message(controller.switchModel({ sessionID, revision: current, model: valid }))).toBe(invalid)
    state.models = [modelRecord({ name: "x".repeat(1024) })]
    expect((await controller.models(sessionID)).models.map((model) => model.name.length)).toEqual([1024])
    state.session = sessionRecord({ id: "ses_other" })
    expect(await message(controller.models(sessionID))).toBe("The backend returned a different Session. Refresh and choose again.")
    expect(await message(controller.switchModel({ sessionID, revision: current, model: valid }))).toBe("The backend returned a different Session. Refresh and choose again.")
    expect(observed.switches).toEqual([])
  })
}, 30_000)

test("a switch chosen under an earlier backend connection is refused before any request", async () => {
  const resources = await syntheticBundle()
  const first: string[] = []
  const second: string[] = []
  using a = peer(first, () => 101)
  using b = peer(second, () => 202)
  const controller = new BackendController(resources, { env, launch })
  try {
    const old = revision(await controller.connect({ mode: "shared", server: a.url.href }))
    await controller.connect({ mode: "shared", server: b.url.href })
    expect(await message(controller.switchModel({ sessionID, revision: old, model: valid })))
      .toBe("The backend connection changed before the model was switched. Refresh models and choose again.")
    expect([...writes(first), ...writes(second)]).toEqual([])
  } finally {
    await controller.disconnect()
    await fs.rm(resources, { recursive: true, force: true })
  }
}, 30_000)
