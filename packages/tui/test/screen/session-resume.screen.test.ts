import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { sessionHistoryFixture } from "../fixture/session-history"
import { tmpdir } from "../fixture/fixture"
import { json } from "../fixture/tui-client"
import { renderScreen } from "./harness"
import type { useData } from "../../src/context/data"

async function until(screen: Awaited<ReturnType<typeof renderScreen>>, ready: () => boolean) {
  const deadline = Date.now() + 5000
  while (!ready() && Date.now() < deadline) {
    await screen.renderOnce()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  if (!ready()) throw new Error(`Screen condition did not settle:\n${screen.frame()}`)
}

test("--continue resolves a real Session ID before issuing Session requests or showing an error toast", async () => {
  await using state = await tmpdir()
  const fixture = sessionHistoryFixture(2)
  fixture.release()
  const lookup = Promise.withResolvers<void>()
  const lookupStarted = Promise.withResolvers<void>()
  const paths: string[] = []
  const writes: string[] = []
  let data!: ReturnType<typeof useData>
  const args = { continue: true, sessionID: undefined }
  const screen = await renderScreen({
    width: 120,
    height: 36,
    state: state.path,
    args,
    settle: "",
    data: (value) => {
      data = value
    },
    config: { attention: { enabled: false } },
    route: async (url, request) => {
      if (request.method === "POST") writes.push(url.pathname)
      if (url.pathname === "/api/model/default") {
        const response = await fixture.route(new URL("http://test/api/location"), request)
        return json({ location: await response?.json(), data: { selection: { providerID: "fixture", id: "fixture" } } })
      }
      if (url.pathname === "/api/session" && url.searchParams.get("limit") === "1") {
        lookupStarted.resolve()
        await lookup.promise
      }
      if (url.pathname.startsWith("/api/session/")) {
        const id = url.pathname.split("/")[3]
        if (id !== "active") {
          paths.push(url.pathname)
          if (!id?.startsWith("ses"))
            return json(
              { _tag: "InvalidRequestError", message: "Invalid session ID", field: "sessionID" },
              { status: 400 },
            )
        }
      }
      if (url.pathname === `/api/session/${fixture.sessionID}/prompt` && request.method === "POST") {
        const body: unknown = await request.json()
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
            sessionID: fixture.sessionID,
            admittedSeq: 1,
            timeCreated: 1,
            type: "user",
            data: { text: body.text },
            delivery: "steer",
          },
        })
      }
      return fixture.route(url, request)
    },
  })
  try {
    await lookupStarted.promise
    await until(screen, () => screen.frame().includes("Message YCoding"))
    await until(screen, () => !!data.location.model.list()?.length && !!data.location.agent.list()?.length)
    await screen.input.typeText("first resumed input")
    screen.input.pressEnter()
    await screen.renderOnce()
    expect(writes).toEqual([])
    expect(screen.frame()).toContain("first resumed input")
    expect(paths).toEqual([])
    expect(screen.frame()).not.toContain("Invalid session ID")
    lookup.resolve()
    await until(screen, () => screen.frame().includes("Synthetic response 1"))
    expect(paths).toContain(`/api/session/${fixture.sessionID}/snapshot`)
    expect(paths.filter((value) => !value.split("/")[3]?.startsWith("ses"))).toEqual([])
    expect(screen.frame()).not.toContain("Invalid session ID")
    expect(screen.frame()).not.toContain("Session not found: dummy")
    expect(screen.frame()).toContain("first resumed input")
    screen.input.pressEnter()
    await until(screen, () => writes.length === 2)
    expect(writes).toEqual([`/api/session/${fixture.sessionID}/prompt`, `/api/session/${fixture.sessionID}/prompt`])
  } finally {
    lookup.resolve()
    await screen.dispose()
  }
}, 30_000)

test("--session and Session-list resume keep every read bound to a real Session ID", async () => {
  await using state = await tmpdir()
  const fixture = sessionHistoryFixture(2)
  fixture.release()
  const malformed: string[] = []
  const screen = await renderScreen({
    width: 120,
    height: 36,
    state: state.path,
    args: { sessionID: fixture.sessionID },
    settle: "Synthetic response 1",
    config: { attention: { enabled: false } },
    route: async (url, request) => {
      if (url.pathname.startsWith("/api/session/")) {
        const id = url.pathname.split("/")[3]
        if (id !== "active" && !id?.startsWith("ses")) {
          malformed.push(url.pathname)
          return json(
            { _tag: "InvalidRequestError", message: "Invalid session ID", field: "sessionID" },
            { status: 400 },
          )
        }
      }
      return fixture.route(url, request)
    },
  })
  try {
    expect(screen.frame()).toContain("Synthetic response 1")
    screen.input.pressKey("p", { ctrl: true })
    await until(
      screen,
      () => screen.frame().includes("Commands") && screen.renderer.currentFocusedEditor instanceof InputRenderable,
    )
    await screen.input.typeText("New session")
    await screen.renderOnce()
    screen.input.pressEnter()
    await until(
      screen,
      () => !screen.frame().includes("Synthetic response 1") && screen.frame().includes("Message YCoding"),
    )
    screen.input.pressKey("p", { ctrl: true })
    await until(
      screen,
      () => screen.frame().includes("Commands") && screen.renderer.currentFocusedEditor instanceof InputRenderable,
    )
    await screen.input.typeText("Switch session")
    await screen.renderOnce()
    screen.input.pressEnter()
    await until(screen, () => screen.frame().includes("Synthetic performance session"))
    screen.input.pressEnter()
    await until(screen, () => screen.frame().includes("Synthetic response 1"))
    expect(malformed).toEqual([])
    expect(screen.frame()).not.toContain("Invalid session ID")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("a resumed Session retains the draft with a catalog warning until its model catalog loads", async () => {
  await using state = await tmpdir()
  const fixture = sessionHistoryFixture(2)
  fixture.release()
  const catalog = Promise.withResolvers<void>()
  const writes: string[] = []
  let data!: ReturnType<typeof useData>
  const screen = await renderScreen({
    width: 120,
    height: 36,
    state: state.path,
    args: { sessionID: fixture.sessionID },
    settle: "Synthetic response 1",
    data: (value) => {
      data = value
    },
    config: { attention: { enabled: false } },
    route: async (url, request) => {
      if (request.method === "POST") writes.push(url.pathname)
      if (url.pathname === "/api/model") await catalog.promise
      if (url.pathname === `/api/session/${fixture.sessionID}/prompt` && request.method === "POST") {
        const body: unknown = await request.json()
        if (!body || typeof body !== "object" || !("id" in body) || typeof body.id !== "string")
          throw new Error("Expected prompt input")
        return json({
          data: {
            id: body.id,
            sessionID: fixture.sessionID,
            admittedSeq: 1,
            timeCreated: 1,
            type: "user",
            data: { text: "held resumed input" },
            delivery: "steer",
          },
        })
      }
      return fixture.route(url, request)
    },
  })
  try {
    await screen.input.typeText("held resumed input")
    screen.input.pressEnter()
    await until(screen, () => screen.frame().includes("model catalog is not available yet"))
    expect(screen.frame()).toContain("held resumed input")
    expect(writes).toEqual([])
    expect(data.location.model.list(data.session.get(fixture.sessionID)?.location)).toBeUndefined()
    catalog.resolve()
    await until(screen, () => {
      const location = data.session.get(fixture.sessionID)?.location
      return !!location && !!data.location.model.list(location)?.length && !!data.location.agent.list(location)?.length
    })
    screen.input.pressEnter()
    await until(screen, () => writes.includes(`/api/session/${fixture.sessionID}/prompt`))
    expect(writes).toEqual([`/api/session/${fixture.sessionID}/prompt`])
  } finally {
    catalog.resolve()
    await screen.dispose()
  }
}, 30_000)
