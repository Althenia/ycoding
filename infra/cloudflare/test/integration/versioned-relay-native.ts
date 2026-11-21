import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { createRemoteTransport, type RemoteTransportRequest } from "../../../../apps/web/src/remote/transport"
import { deltaChunk, finishChunk } from "../../../../packages/ai/test/lib/openai-chunks"
import { WireLimit } from "../../../../packages/remote/src/index"
import { startRustRuntime } from "./rust-runtime"
import {
  browserHeaders,
  connectSocket,
  devices,
  registration,
  socketURL,
  v4SessionList,
  type Check,
} from "./versioned-relay-peers"
import { eventually, isolatedEnvironment, record } from "./versioned-relay-worker"

const sessionID = "ses_native_relay"
const contentSessionID = "ses_native_relay_content"
const promptID = "msg_native_attachment"
const providerID = "relay-acceptance"
const model = { providerID, id: "local-model" }
const attachment = Buffer.from("Native relay attachment acceptance\n".repeat(96))
const digest = createHash("sha256").update(attachment).digest("hex")
const answer = "Loopback assistant text. ".repeat(64_000)
const smallAnswer = "One live delta from the local provider."

export function runtimeBinding() {
  const packaged = process.env.YCODING_RELAY_RUST_CLI
  const runtimePath = process.env.YCODING_RUNTIME_EXECUTABLE
  const executable = packaged ?? runtimePath
  assert.ok(
    executable && isAbsolute(executable),
    "Bind YCODING_RELAY_RUST_CLI to the packaged candidate or YCODING_RUNTIME_EXECUTABLE to the native build",
  )
  assert.ok(!(packaged && runtimePath), "Select only one Rust executable")
  return { executable, packaged: packaged !== undefined }
}

export async function checkNativeRelay(root: string, origin: string, cookie: string, check: Check) {
  const binding = runtimeBinding()
  const workspace = join(root, "workspace")
  const config = join(root, "fixture-config")
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(config, { recursive: true })])
  let requests = 0
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions" || request.method !== "POST")
        return new Response(null, { status: 404 })
      const input: unknown = await request.json()
      if (!record(input) || input.model !== model.id || input.stream !== true)
        return new Response(null, { status: 400 })
      requests++
      const reply = JSON.stringify(input.messages).includes("Prepare canonical bulk") ? answer : smallAnswer
      const frames = [deltaChunk({ role: "assistant" })]
      for (let index = 0; index < reply.length; index += 16_384)
        frames.push(deltaChunk({ content: reply.slice(index, index + 16_384) }))
      const body = [...frames, finishChunk("stop")].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")
      return new Response(`${body}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
    },
  })
  try {
    await Bun.write(join(config, "models.json"), "{}")
    await Bun.write(
      join(config, "ycoding.json"),
      JSON.stringify({
        model: `${providerID}/${model.id}`,
        providers: {
          [providerID]: {
            package: "aisdk:@ai-sdk/openai-compatible",
            name: "Relay acceptance provider",
            settings: { baseURL: `${provider.url.origin}/v1`, apiKey: "synthetic" },
            models: {
              [model.id]: {
                name: "Loopback fixture",
                capabilities: { tools: false, input: ["text"], output: ["text"] },
                limit: { context: 100_000, output: 4096 },
                cost: { input: 2, output: 3, cache: { read: 0, write: 0 } },
              },
            },
          },
        },
      }),
    )
    const runtime = await startRustRuntime(join(root, "native"), workspace, config, binding)
    try {
      const local = runtime.client
      const created = await local.session.create({
        id: sessionID,
        title: "Native relay acceptance",
        model,
        location: { directory: workspace },
      })
      assert.equal(created.id, sessionID)
      const enrollment = await registration(origin, cookie)
      const enrolled = await local.remote.enroll({
        ...enrollment,
        relayOrigin: origin,
        name: "Native relay acceptance",
      })
      const deviceID = enrolled.deviceID
      assert.equal(enrolled.relayOrigin, origin)
      await local.remote.set({ enabled: true })
      await eventually("native AGENT ready", async () => {
        const status = await local.remote.get()
        assert.notEqual(status.state, "error", status.message)
        return status.state === "on" ? true : undefined
      })
      const events: unknown[] = []
      const transport = openWeb(origin, cookie, deviceID, (eventSessionID, batch) => {
        if (eventSessionID === sessionID) events.push(...batch)
      })
      try {
        await eventually("Web v5 Ready", () => (transport.status().kind === "open" ? true : undefined))
        const request = async (operation: string, input?: RemoteTransportRequest, socket = transport) => {
          const outcome = await socket.request(operation, input)
          if (outcome.status !== "ok")
            throw new Error(`${operation}: ${JSON.stringify(outcome)}, ${socket.diagnostics()}`)
          return outcome.value
        }
        const independent = async <T>(run: (socket: ReturnType<typeof openWeb>) => Promise<T>) => {
          const socket = openWeb(origin, cookie, deviceID)
          try {
            await eventually("independent Web v5 Ready", () => (socket.status().kind === "open" ? true : undefined))
            return await run(socket)
          } finally {
            socket.close()
          }
        }
        await check("v5 native enrollment and Web socket return the named Session", async () => {
          assert.equal((await devices(origin, cookie, "v5")).find((item) => item.id === deviceID)?.online, true)
          const list = await request("session.list")
          assert.match(JSON.stringify(list), /"id":"ses_native_relay"/)
          assert.match(JSON.stringify(list), /Native relay acceptance/)
        })
        await check("v4 client with a valid cookie cannot read a live v5 agent", async () => {
          assert.equal((await devices(origin, cookie, "v4")).find((item) => item.id === deviceID)?.online, false)
          const result = await v4SessionList(origin, cookie, deviceID)
          assert.equal(result.ok, false)
          assert.equal(result.error?.code, "agent_unavailable")
          assert.equal(result.value, undefined)
        })
        await check("v5 Web subscribes and reads a named Session snapshot", async () => {
          const subscription = request("event.subscribe", { sessionID })
          const snapshot = await request("session.snapshot", { sessionID })
          await subscription
          assert.equal(field(field(field(snapshot, "data"), "session"), "id"), sessionID)
        })
        await check("v5 Web synchronizes the named Session event log", async () => {
          const logged = await request("session.log", { sessionID, input: { follow: false } })
          assert.ok(
            typeof field(logged, "watermark") === "number",
            "Durable log did not synchronize through the Web transport",
          )
        })
        await local.session.prompt({ sessionID, id: "msg_native_live", text: "Emit one small live event." })
        const completedMessage = (id: string, text: string) =>
          eventually(
            "native assistant completion",
            async () => {
              const snapshot = await local.session.snapshot({ sessionID: id })
              return snapshot.messages.find(
                (item) => "content" in item && item.content.some((part) => "text" in part && part.text === text),
              )
            },
            30_000,
          )
        const live = await completedMessage(sessionID, smallAnswer)
        await check("v5 Web receives the named Session's live text", async () => {
          const event = await eventually("live Web text", () =>
            events.find((event) => field(event, "type") === "session.text.delta"),
          )
          assert.equal(field(field(event, "data"), "sessionID"), sessionID)
          assert.equal(field(field(event, "data"), "assistantMessageID"), live.id)
          const delta = field(field(event, "data"), "delta")
          assert.ok(typeof delta === "string" && delta.length > 0 && smallAnswer.includes(delta))
        })
        await request("session.list")
        transport.close()
        const bulkSession = await local.session.create({
          id: contentSessionID,
          title: "Native canonical content",
          model,
          location: { directory: workspace },
        })
        assert.equal(bulkSession.id, contentSessionID)
        await local.session.prompt({
          sessionID: contentSessionID,
          id: promptID,
          text: "Prepare canonical bulk.",
          files: [{ uri: `data:text/plain;base64,${attachment.toString("base64")}`, name: "relay-acceptance.txt" }],
        })
        const message = await completedMessage(contentSessionID, answer)
        assert.equal(requests, 2, "Expected two actual synthetic provider turns")
        await check("v5 native agent remains present after canonical content production", async () => {
          const [remote, listed] = await Promise.all([local.remote.get(), devices(origin, cookie, "v5")])
          assert.equal(
            listed.find((item) => item.id === deviceID)?.online,
            true,
            `Provider turn affected the agent: ${remote.state} ${remote.message ?? ""}`,
          )
        })

        const http = (suffix: string) => {
          let count = 0
          return {
            count: () => count,
            deviceID,
            async fetch(path: string, init?: RequestInit) {
              count++
              const url = new URL(path, origin)
              assert.equal(url.origin, origin)
              assert.equal(url.pathname, `/api/remote/devices/${deviceID}/sessions/${contentSessionID}/${suffix}`)
              assert.deepEqual([...url.searchParams.keys()].sort(), ["connectionEpoch", "requestID", "transferID"])
              for (const selector of url.searchParams.keys()) assert.ok(url.searchParams.get(selector), selector)
              const headers = {
                ...Object.fromEntries(new Headers(init?.headers)),
                ...browserHeaders(origin, cookie),
                "accept-encoding": "gzip, deflate, br",
              }
              const noEpoch = new URL(url)
              noEpoch.searchParams.delete("connectionEpoch")
              assert.equal((await fetch(noEpoch, { headers })).status, 400, "Partial live selector was accepted")
              for (const [key, altered] of [
                ["connectionEpoch", "foreign-epoch"],
                ["requestID", "18446744073709551615"],
                ["transferID", "foreign-transfer"],
              ] as const) {
                const wrong = new URL(url)
                wrong.searchParams.set(key, altered)
                assert.equal((await fetch(wrong, { headers })).status, 409, `A foreign ${key} opened the live body`)
              }
              const wrongTarget = new URL(url)
              const object = suffix.startsWith("messages/") ? "msg_wrong_target" : "0".repeat(64)
              wrongTarget.pathname = wrongTarget.pathname.replace(/[^/]+$/, object)
              assert.equal(
                (await fetch(wrongTarget, { headers })).status,
                400,
                "The live declaration allowed reading a different object",
              )
              const body = await fetch(url, { ...init, headers })
              assert.equal(body.status, 200)
              assert.equal(body.headers.get("content-encoding"), "identity")
              assert.match(body.headers.get("cache-control") ?? "", /\bno-transform\b/)
              assert.equal(body.headers.get("x-ycoding-connection-epoch"), url.searchParams.get("connectionEpoch"))
              assert.equal(body.headers.get("x-ycoding-transfer-id"), url.searchParams.get("transferID"))
              const length = Number(body.headers.get("content-length"))
              assert.ok(length > 0, "Workerd must publish exact Content-Length")
              if (suffix.startsWith("attachments/")) assert.equal(length, attachment.length)
              else assert.ok(length > Number(WireLimit.SERVER_FRAME_BYTES))
              return body
            },
          }
        }
        await check("v5 Web reads one complete named message through live HTTP bulk", () =>
          independent(async (socket) => {
            const bulk = http(`messages/${message.id}`)
            const result = await request(
              "session.message",
              { sessionID: contentSessionID, input: { messageID: message.id }, httpBulk: bulk },
              socket,
            )
            assert.equal(field(field(result, "data"), "id"), message.id)
            const content = field(field(result, "data"), "content")
            assert.ok(
              Array.isArray(content) && content.some((part) => field(part, "text") === answer),
              "Bulk message changed the provider text",
            )
            assert.equal(bulk.count(), 1)
          }),
        )
        await check("v5 Web reads the exact named attachment via live HTTP bulk", () =>
          independent(async (socket) => {
            const bulk = http(`attachments/${digest}`)
            const asset = await request(
              "session.attachment.read",
              { sessionID: contentSessionID, input: { digest }, httpBulk: bulk },
              socket,
            )
            assert.ok(asset && typeof asset === "object" && "data" in asset && asset.data instanceof Uint8Array)
            assert.deepEqual(Buffer.from(asset.data), attachment)
            assert.equal(bulk.count(), 1)
            if ("release" in asset && typeof asset.release === "function") asset.release()
          }),
        )

        await check(
          "completed Session log and live subscription recover large output on the same Web connection",
          async () => {
            await independent(async (subscriber) => {
              await independent(async (unrelated) => {
                const subscribed = request("event.subscribe", { sessionID }, subscriber)
                const before = field(await request("session.snapshot", { sessionID }, subscriber), "data")
                const epoch = field(before, "sourceEpoch")
                assert.ok(typeof epoch === "string" && epoch.length > 0)
                await subscribed
                const log = await request("session.log", { sessionID, input: { follow: false } }, subscriber)
                assert.ok(typeof field(log, "watermark") === "number")
                await request("session.list", undefined, unrelated)
                const opened = subscriber.opened()
                await local.session.prompt({
                  sessionID,
                  id: "msg_native_live_overflow",
                  text: "Prepare canonical bulk during a live subscription.",
                })
                const oversized = await completedMessage(sessionID, answer)
                const listed = await devices(origin, cookie, "v5")
                const native = await local.remote.get()
                assert.equal(
                  listed.find((item) => item.id === deviceID)?.online,
                  true,
                  `Relay lost the native agent: ${native.state}; subscriber=${subscriber.diagnostics()}; other=${unrelated.diagnostics()}`,
                )
                await eventually("the live browser receives its named Session resync", () =>
                  subscriber.resyncs.includes(sessionID) ? true : undefined,
                )
                const recovered = field(await request("session.snapshot", { sessionID }, subscriber), "data")
                assert.equal(field(recovered, "sourceEpoch"), epoch)
                assert.equal(
                  subscriber.opened(),
                  opened,
                  "The subscriber reconnected instead of recovering its original epoch",
                )
                const messages = field(recovered, "messages")
                assert.ok(Array.isArray(messages))
                const record = messages.find((item) => field(item, "id") === oversized.id)
                const content = field(record, "content")
                assert.ok(
                  Array.isArray(content) && content.some((part) => field(part, "text") === answer),
                  "Canonical resync did not restore the full named message",
                )
                await request("session.list", undefined, unrelated)
              })
            })
          },
        )
      } finally {
        transport.close()
      }
    } finally {
      await runtime.close()
    }
  } finally {
    await provider.stop(true)
  }
}

export async function checkStoredUsage(root: string, origin: string, cookie: string, check: Check) {
  const binding = runtimeBinding()
  const seeder = process.env.YCODING_RELAY_USAGE_SEED
  assert.ok(
    seeder && isAbsolute(seeder),
    "Bind YCODING_RELAY_USAGE_SEED to the Cargo-built usage_performance_seed example",
  )
  const locationRoot = join(root, "locations")
  const workspace = join(locationRoot, "location-0000")
  const config = join(root, "fixture-config")
  const database = join(root, "usage.redb")
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(config, { recursive: true })])
  await Bun.write(join(config, "models.json"), "{}")
  await Bun.write(join(config, "ycoding.json"), JSON.stringify({ analytics_retention: { usage_days: 31 } }))
  const seed = Bun.spawn([seeder, database, locationRoot, String(Date.now()), "8", "1", "0"], {
    cwd: workspace,
    env: isolatedEnvironment(root),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exit, stderr] = await Promise.all([
    seed.exited,
    new Response(seed.stderr).text(),
    new Response(seed.stdout).text(),
  ])
  assert.equal(exit, 0, `Native Store fixture initialization failed: ${stderr.slice(-2048)}`)
  const runtime = await startRustRuntime(join(root, "native"), workspace, config, { ...binding, database })
  try {
    const local = runtime.client
    assert.equal((await local.location.get()).directory, workspace)
    const fresh = await registration(origin, cookie)
    const device = await local.remote.enroll({ ...fresh, relayOrigin: origin, name: "Native Usage acceptance" })
    await local.remote.set({ enabled: true })
    await eventually("seeded native agent ready", async () => {
      const status = await local.remote.get()
      assert.notEqual(status.state, "error", status.message)
      return status.state === "on" ? true : undefined
    })
    const socket = openWeb(origin, cookie, device.deviceID)
    try {
      await eventually("Web ready for seeded native Usage", () => (socket.status().kind === "open" ? true : undefined))
      const read = async (operation: string, input?: Readonly<Record<string, unknown>>) => {
        const outcome = await socket.request(operation, { input })
        if (outcome.status === "ok") return outcome.value
        throw new Error(`${operation}: ${JSON.stringify(outcome)}, ${socket.diagnostics()}`)
      }
      const exactUsage = (operation: string, metrics: unknown) => {
        const counts = {
          logical: field(metrics, "logical"),
          tokens: field(metrics, "tokens"),
          cost: field(metrics, "cost"),
        }
        assert.equal(counts.logical, 8)
        assert.deepEqual(counts.tokens, { input: 8028, output: 828, reasoning: 28, cache: { read: 28, write: 28 } })
        assert.ok(typeof counts.cost === "number" && Math.abs(counts.cost - 0.0028) < 1e-10)
        console.log(`${operation} native stored totals ${JSON.stringify(counts)}`)
      }
      const breakdown = { group: "model", limit: 10 } as const
      await check("v5 Web Usage providers reads the native Location provider publication", async () => {
        const providers = await eventually("native provider publication", async () => {
          const outcome = await socket.request("providerUsage.list")
          if (outcome.status === "ok") return outcome.value
          if (
            outcome.status === "failed" &&
            outcome.error.message === "Location provider usage service is not available"
          )
            return undefined
          throw new Error(`providerUsage.list: ${JSON.stringify(outcome)}, ${socket.diagnostics()}`)
        })
        const direct = await local.providerUsage.list()
        assert.equal(field(field(providers, "location"), "directory"), workspace)
        assert.deepEqual(field(providers, "data"), direct.data)
        console.log(`providerUsage.list native published providers=${direct.data.length}`)
      })
      await check("v5 Web Usage summary reads eight real native Store records", async () => {
        exactUsage("usage.get", field(await read("usage.get"), "data"))
      })
      await check("v5 Web Usage report groups the seeded models and returns exact stored totals", async () => {
        const report = await eventually(
          "native Usage report ready",
          async () => {
            const outcome = await socket.request("usage.report", { input: breakdown })
            if (outcome.status === "ok") return field(outcome.value, "data")
            if (outcome.status === "failed" && outcome.error.message === "Usage store unavailable") return undefined
            throw new Error(`usage.report: ${JSON.stringify(outcome)}, ${socket.diagnostics()}`)
          },
          30_000,
        )
        assert.equal(field(report, "group"), "model")
        exactUsage("usage.report", field(report, "total"))
        const rows = field(report, "rows")
        assert.ok(Array.isArray(rows) && rows.length === 2)
        for (const modelID of ["model-00", "model-01"]) assert.match(JSON.stringify(rows), new RegExp(modelID))
      })
      await check("v5 Web Usage dashboard returns precise summary and breakdown from the native Store", async () => {
        const dashboard = await eventually(
          "native Usage dashboard ready",
          async () => {
            const data = field(await read("usage.dashboard", { breakdown }), "data")
            const status = field(data, "status")
            assert.notEqual(status, "error", String(field(data, "message")))
            return status === "ready" ? data : undefined
          },
          45_000,
        )
        exactUsage("usage.dashboard summary", field(dashboard, "summary"))
        exactUsage("usage.dashboard breakdown", field(field(dashboard, "breakdown"), "total"))
      })
    } finally {
      socket.close()
    }
  } finally {
    await runtime.close()
  }
}

export function openWeb(
  origin: string,
  cookie: string,
  deviceID: string,
  onEvents?: (sessionID: string, events: readonly unknown[]) => void,
  observeSocket?: (socket: WebSocket) => void,
) {
  let close: { code: number; reason: string } | undefined
  let opened = 0
  const resyncs: string[] = []
  const transport = createRemoteTransport({
    url: socketURL(origin, "v5", deviceID),
    createSocket: (url) => {
      const socket = connectSocket(url, browserHeaders(origin, cookie))
      observeSocket?.(socket)
      socket.addEventListener("open", () => opened++, { once: true })
      socket.addEventListener(
        "close",
        (event) => {
          close = { code: event.code, reason: event.reason }
        },
        { once: true },
      )
      return socket
    },
    handlers: { onEvents, onResync: (sessionID) => resyncs.push(sessionID) },
    requestTimeoutMs: 15_000,
  })
  transport.connect()
  return {
    ...transport,
    opened: () => opened,
    resyncs,
    diagnostics: () => JSON.stringify({ status: transport.status(), close }),
  }
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? Reflect.get(value, key) : undefined
}
