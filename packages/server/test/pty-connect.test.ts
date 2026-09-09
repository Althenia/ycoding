import { expect, test } from "bun:test"
import { Pty } from "@ycoding-ai/core/pty"
import { PtyProtocol } from "@ycoding-ai/core/pty/protocol"
import { PtyTicket } from "@ycoding-ai/core/pty/ticket"
import { ServerProcess } from "@ycoding-ai/server/process"
import { Effect, Exit, Schema, Scope } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PtyConnect } from "../src/pty-connect"

test("requires a Session-scoped single-mode PTY websocket ticket query", () => {
  expect(
    PtyConnect.parse(
      "/api/pty/pty_test/connect?ticket=one&sessionID=ses_owner&access=inspect&generation=2&offset=40",
    ) as unknown,
  ).toEqual({
    ticket: "one",
    sessionID: "ses_owner",
    access: "inspect",
    generation: 2,
    offset: 40,
    fence: undefined,
  })
  expect(PtyConnect.parse("/api/pty/pty_test/connect?sessionID=ses_owner&access=inspect&generation=2")).toBeUndefined()
  expect(
    PtyConnect.parse("/api/pty/pty_test/connect?ticket=one&sessionID=ses_owner&access=control&generation=2&offset=40"),
  ).toBeUndefined()
})

test("accepts fenced user-control websocket tickets and rejects invalid replay offsets", () => {
  expect(
    PtyConnect.parse(
      "/api/pty/pty_test/connect?ticket=one&sessionID=ses_owner&access=control&generation=2&offset=40&fence=7",
    ),
  ).toMatchObject({ access: "control", fence: 7 })
  expect(
    PtyConnect.parse("/api/pty/pty_test/connect?ticket=one&sessionID=ses_owner&access=inspect&generation=2&offset=-1"),
  ).toBeUndefined()
})

const ptyTest = process.platform === "win32" ? test.skip : test
const ptyResponse = Schema.Struct({ data: Pty.Info })
const tokenResponse = Schema.Struct({ data: PtyTicket.ConnectToken })

ptyTest(
  "enforces live Session and ticket authorization, inspect-only access, writer fences, and shutdown closure",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ycoding-server-pty-"))
    const port = await availablePort()
    const scope = await Effect.runPromise(Scope.make())
    const base = `http://127.0.0.1:${port}`
    const auth = `Basic ${Buffer.from("ycoding:test-password").toString("base64")}`
    const location = new URLSearchParams({ "location[directory]": directory }).toString()
    const ownerID = "ses_pty_server_owner"
    const otherID = "ses_pty_server_other"
    let closed = false

    const request = (path: string, body?: unknown, ticket = false) =>
      fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: auth,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(ticket ? { "x-ycoding-ticket": "1" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })

    try {
      const startingRaw = ServerProcess.start<never, never>({
        hostname: "127.0.0.1",
        port,
        password: "test-password",
        database: { path: ":memory:" },
        config: { directory, project: false, content: "{}" },
        fs: { filewatcher: false, fff: false },
      }).pipe(Effect.provideService(Scope.Scope, scope))
      // The assembled router carries static Request<"Requires", ...> markers that resolve when
      // a real request is dispatched; this mirrors the maintained CLI server boundary.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runtime-owned router requirement markers are not services callers can provide
      const starting = startingRaw as Effect.Effect<
        Effect.Success<typeof startingRaw>,
        Effect.Error<typeof startingRaw>
      >
      await Effect.runPromise(starting)

      for (const id of [ownerID, otherID]) {
        const response = await request("/api/session", { id, location: { directory } })
        expect(response.status).toBe(200)
      }

      const createdResponse = await request(`/api/pty?${location}`, {
        sessionID: ownerID,
        command: "/usr/bin/env",
        args: ["sh", "-c", "cat"],
        cwd: directory,
      })
      expect(createdResponse.status).toBe(200)
      const created = Schema.decodeUnknownSync(ptyResponse)(await createdResponse.json())

      const inspectToken = await token(request, location, created.data.id, {
        sessionID: ownerID,
        access: "inspect",
        generation: created.data.generation,
      })
      const wrongTicket = await fetch(
        connectURL(base, location, created.data.id, {
          ...inspectToken,
          ticket: `${inspectToken.ticket}-wrong`,
          sessionID: ownerID,
          offset: created.data.output.endOffset,
        }).replace("ws://", "http://"),
      )
      expect(wrongTicket.status).toBe(403)
      const wrongSession = await fetch(
        connectURL(base, location, created.data.id, {
          ...inspectToken,
          sessionID: otherID,
          offset: created.data.output.endOffset,
        }).replace("ws://", "http://"),
      )
      expect(wrongSession.status).toBe(404)

      const inspector = socketProbe(
        connectURL(base, location, created.data.id, {
          ...inspectToken,
          sessionID: ownerID,
          offset: created.data.output.endOffset,
        }),
      )
      await inspector.open
      expect(await inspector.nextControl()).toMatchObject({ type: "replay", generation: created.data.generation })
      inspector.socket.send("inspect-must-not-write\n")
      expect((await inspector.close).code).toBe(4409)
      expect(inspector.dataText()).not.toContain("inspect-must-not-write")
      const afterInspectResponse = await request(
        `/api/pty/${created.data.id}?${location}&sessionID=${encodeURIComponent(ownerID)}`,
      )
      expect(afterInspectResponse.status).toBe(200)
      const afterInspect = Schema.decodeUnknownSync(ptyResponse)(await afterInspectResponse.json())
      expect(afterInspect.data.output.endOffset).toBe(created.data.output.endOffset)

      const takenResponse = await request(`/api/pty/${created.data.id}/control?${location}`, {
        sessionID: ownerID,
        generation: created.data.generation,
        expectedFence: created.data.control.fence,
        action: "take",
      })
      expect(takenResponse.status).toBe(200)
      const taken = Schema.decodeUnknownSync(ptyResponse)(await takenResponse.json())

      const staleToken = await request(
        `/api/pty/${created.data.id}/connect-token?${location}`,
        {
          sessionID: ownerID,
          access: "control",
          generation: created.data.generation,
          expectedFence: created.data.control.fence,
        },
        true,
      )
      expect(staleToken.status).toBe(409)

      const controlToken = await token(request, location, created.data.id, {
        sessionID: ownerID,
        access: "control",
        generation: created.data.generation,
        expectedFence: taken.data.control.fence,
      })
      const controller = socketProbe(
        connectURL(base, location, created.data.id, {
          ...controlToken,
          sessionID: ownerID,
          offset: taken.data.output.endOffset,
        }),
      )
      await controller.open
      expect(await controller.nextControl()).toMatchObject({ type: "replay", generation: created.data.generation })
      controller.socket.send("fenced-control-write\n")
      await controller.untilData("fenced-control-write")
      const afterControlResponse = await request(
        `/api/pty/${created.data.id}?${location}&sessionID=${encodeURIComponent(ownerID)}`,
      )
      expect(afterControlResponse.status).toBe(200)
      const afterControl = Schema.decodeUnknownSync(ptyResponse)(await afterControlResponse.json())

      const pausedResponse = await request(`/api/pty/${created.data.id}/control?${location}`, {
        sessionID: ownerID,
        generation: created.data.generation,
        expectedFence: taken.data.control.fence,
        action: "pause",
      })
      expect(pausedResponse.status).toBe(200)
      controller.socket.send("stale-control-must-not-write\n")
      expect((await controller.close).code).toBe(4409)
      expect(controller.dataText()).not.toContain("stale-control-must-not-write")
      const afterStaleResponse = await request(
        `/api/pty/${created.data.id}?${location}&sessionID=${encodeURIComponent(ownerID)}`,
      )
      expect(afterStaleResponse.status).toBe(200)
      const afterStale = Schema.decodeUnknownSync(ptyResponse)(await afterStaleResponse.json())
      expect(afterStale.data.output.endOffset).toBe(afterControl.data.output.endOffset)

      const shutdownToken = await token(request, location, created.data.id, {
        sessionID: ownerID,
        access: "inspect",
        generation: created.data.generation,
      })
      const shutdownSocket = socketProbe(
        connectURL(base, location, created.data.id, {
          ...shutdownToken,
          sessionID: ownerID,
          offset: afterStale.data.output.endOffset,
        }),
      )
      await shutdownSocket.open
      expect(await shutdownSocket.nextControl()).toMatchObject({ type: "replay", generation: created.data.generation })

      const shutdown = Effect.runPromise(Scope.close(scope, Exit.void))
      closed = true
      expect(await shutdownSocket.untilControl("end")).toEqual({
        type: "end",
        generation: created.data.generation,
        reason: "service_shutdown",
      })
      expect((await shutdownSocket.close).code).toBe(1012)
      await shutdown
    } finally {
      if (!closed) await Effect.runPromise(Scope.close(scope, Exit.void))
      await rm(directory, { recursive: true, force: true })
    }
  },
  30_000,
)

async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("failed to reserve test port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

async function token(
  request: (path: string, body?: unknown, ticket?: boolean) => Promise<Response>,
  location: string,
  ptyID: string,
  input: { sessionID: string; access: "inspect" | "control"; generation: number; expectedFence?: number },
) {
  const response = await request(`/api/pty/${ptyID}/connect-token?${location}`, input, true)
  expect(response.status).toBe(200)
  return Schema.decodeUnknownSync(tokenResponse)(await response.json()).data
}

function connectURL(
  base: string,
  location: string,
  ptyID: string,
  input: {
    ticket: string
    sessionID: string
    access: "inspect" | "control"
    generation: number
    offset: number
    fence?: number
  },
) {
  const query = new URLSearchParams(location)
  query.set("ticket", input.ticket)
  query.set("sessionID", input.sessionID)
  query.set("access", input.access)
  query.set("generation", String(input.generation))
  query.set("offset", String(input.offset))
  if (input.fence !== undefined) query.set("fence", String(input.fence))
  return `${base.replace("http://", "ws://")}/api/pty/${ptyID}/connect?${query}`
}

function socketProbe(url: string) {
  const socket = new WebSocket(url)
  socket.binaryType = "arraybuffer"
  const messages: Array<string | ArrayBuffer> = []
  const data: Uint8Array[] = []
  const waiting: Array<(message: string | ArrayBuffer) => void> = []
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string" && !(event.data instanceof ArrayBuffer)) return
    const next = waiting.shift()
    if (next) next(event.data)
    else messages.push(event.data)
  })
  const nextFrame = async () => {
    const decoded = PtyProtocol.decodeServerFrame(await nextMessage(messages, waiting))
    if (decoded?.type === "data") data.push(decoded.value)
    return decoded
  }
  const nextControl = async (): Promise<PtyProtocol.Control> => {
    while (true) {
      const decoded = await nextFrame()
      if (decoded?.type === "control") return decoded.value
    }
  }
  const dataText = () => data.map((chunk) => new TextDecoder().decode(chunk)).join("")
  return {
    socket,
    open: new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new Error(`failed to open ${url}`)), { once: true })
    }),
    close: new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true })),
    nextControl,
    async untilControl(type: PtyProtocol.Control["type"]) {
      while (true) {
        const control = await nextControl()
        if (control.type === type) return control
      }
    },
    async untilData(text: string) {
      while (!dataText().includes(text)) await nextFrame()
    },
    dataText,
  }
}

function nextMessage(messages: Array<string | ArrayBuffer>, waiting: Array<(message: string | ArrayBuffer) => void>) {
  const current = messages.shift()
  if (current !== undefined) return Promise.resolve(current)
  return new Promise<string | ArrayBuffer>((resolve) => waiting.push(resolve))
}
