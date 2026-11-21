import { YCoding } from "@ycoding-ai/client/v5"
import {
  LedgerClass, PeerRole, RemoteWebSocketPath, ReservationBudget, ResultSchema,
  create, createRelayConnection, frameReservation, handoffBinary, receiveBinary,
  type Frame,
} from "@ycoding-ai/remote"
import { Schema } from "effect"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import os from "node:os"
import path from "node:path"

export const rows = 200_000
export const locations = 2_500
export const unpricedLocations = 100
export const day = 86_400_000
export const rates = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }

const repository = path.resolve(import.meta.dirname, "../../../..")

async function cargoTarget() {
  const args = ["cargo", "metadata", "--locked", "--no-deps", "--format-version", "1", "--manifest-path", "rust/Cargo.toml"]
  const child = Bun.spawn(args, { cwd: repository, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`Cargo metadata failed (${code}): ${stderr}`)
  return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ target_directory: Schema.String })))(stdout).target_directory
}

export const round = (value: number) => Math.round(value * 10) / 10

export const Seeded = Schema.Struct({
  rows: Schema.Number,
  locations: Schema.Number,
  unpricedDirectories: Schema.Array(Schema.String),
  oldest: Schema.Number,
  newest: Schema.Number,
  populations: Schema.Array(
    Schema.Struct({
      model: Schema.Struct({
        providerID: Schema.String,
        id: Schema.String,
        variant: Schema.optional(Schema.String),
        profile: Schema.optional(Schema.String),
      }),
      requests: Schema.Number,
      recorded: Schema.Number,
      recordedCost: Schema.Number,
      decisionUnpriced: Schema.Number,
      catalogPriced: Schema.Number,
      catalogTokens: Schema.Struct({
        input: Schema.Number,
        output: Schema.Number,
        reasoning: Schema.Number,
        cacheRead: Schema.Number,
        cacheWrite: Schema.Number,
      }),
    }),
  ),
})

async function executable(file: string, build: string) {
  await access(file, constants.X_OK).catch(() => {
    throw new Error(`${file} is not built; run ${build}`)
  })
}

async function seed(seedExecutable: string, store: string, locationRoot: string, now: number) {
  const child = Bun.spawn(
    [seedExecutable, store, locationRoot, String(now), String(rows), String(locations), String(unpricedLocations)],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`Usage seed failed (${code}): ${stderr}`)
  return Schema.decodeUnknownSync(Schema.fromJsonString(Seeded))(stdout.trim())
}

export async function createUsageFixture(now = Date.now()) {
  const release = path.join(await cargoTarget(), "release")
  const runtimeExecutable = process.env.YCODING_RUNTIME_EXECUTABLE ?? path.join(release, "ycoding-runtime")
  const seedExecutable = path.join(release, "examples/usage_performance_seed")
  await executable(
    seedExecutable,
    "cargo build --locked --release --manifest-path rust/Cargo.toml -p ycoding-core --example usage_performance_seed",
  )
  await executable(
    runtimeExecutable,
    "cargo build --locked --release --manifest-path rust/Cargo.toml -p ycoding-runtime --bin ycoding-runtime",
  )
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-usage-dashboard-"))
  const remove = () => rm(root, { recursive: true, force: true })
  try {
    const locationRoot = path.join(root, "locations")
    const workspace = path.join(root, "workspace")
    const config = path.join(root, "config/ycoding")
    const store = path.join(root, "data/usage-performance.redb")
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(config, { recursive: true }),
      mkdir(path.dirname(store), { recursive: true }),
      ...Array.from({ length: unpricedLocations }, (_, index) =>
        mkdir(path.join(locationRoot, `location-${String(index).padStart(4, "0")}`), { recursive: true }),
      ),
    ])
    await writeFile(path.join(config, "models.json"), "{}")
    await writeFile(
      path.join(config, "ycoding.json"),
      JSON.stringify({
        providers: {
          local: {
            package: "aisdk:@ai-sdk/openai-compatible",
            name: "Local synthetic",
            settings: { baseURL: "http://127.0.0.1:9/v1", apiKey: "synthetic" },
            models: Object.fromEntries(
              [0, 1, 2].map((index) => [
                `local-${index}`,
                {
                  name: `Local ${index}`,
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  limit: { context: 100_000, output: 4_096 },
                  cost: {
                    input: rates.input,
                    output: rates.output,
                    cache: { read: rates.cacheRead, write: rates.cacheWrite },
                  },
                },
              ]),
            ),
          },
        },
        analytics_retention: { usage_days: 31 },
      }),
    )
    const seedStarted = performance.now()
    const seeded = await seed(seedExecutable, store, locationRoot, now)
    return {
      now,
      seeded,
      seedMs: round(performance.now() - seedStarted),
      remove,
      startRuntime: () => startRuntime(runtimeExecutable, path.join(root, "runtime"), workspace, config, store),
    }
  } catch (error) {
    await remove()
    throw error
  }
}

async function startRuntime(runtimeExecutable: string, root: string, workspace: string, config: string, store: string) {
  const password = crypto.randomUUID()
  await mkdir(path.join(root, "home"), { recursive: true })
  const child = Bun.spawn([runtimeExecutable, "--stdio", "--port", "0"], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_DATA_HOME: path.join(root, "data"),
      YCODING_CONFIG_DIR: config,
      YCODING_CONFIG_PROJECT_DISABLE: "1",
      YCODING_DISABLE_MODELS_FETCH: "1",
      YCODING_MODELS_PATH: path.join(config, "models.json"),
      YCODING_DB: store,
      YCODING_VERSION: "local",
      YCODING_PASSWORD: password,
      YCODING_PRINT_LOGS: "1",
      YCODING_LOG_LEVEL: process.env.YCODING_LOG_LEVEL ?? "INFO",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const errors = new Response(child.stderr).text()
  const diagnostics = async () => (await errors)
    .replaceAll(password, "[fixture password]")
    .replaceAll(Buffer.from(`ycoding:${password}`).toString("base64"), "[fixture authorization]")
    .replaceAll(path.dirname(root), "[fixture directory]")
    .slice(-8192)
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader()
  const startupTimeout = 600_000
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, startupTimeout)
  let output = ""
  try {
    while (!output.includes("\n")) {
      const next = await reader.read()
      if (next.done) {
        const reason = timedOut ? `did not report readiness within ${startupTimeout}ms` : `exited before readiness (${await child.exited})`
        throw new Error(`Rust runtime ${reason}: ${await diagnostics()}`)
      }
      output += next.value
    }
    const ready = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ url: Schema.String })))(output.split("\n")[0])
    const client = YCoding.make({
      endpoint: { url: ready.url, auth: { type: "basic", username: "ycoding", password } },
      location: { directory: workspace },
    })
    try {
      await client.transport.ready()
    } catch (error) {
      client.transport.close()
      throw error
    }
    return {
      client,
      async close() {
        client.transport.close()
        const shutdown = setTimeout(() => child.kill("SIGKILL"), 10_000)
        try {
          await child.stdin.end()
          const code = await child.exited
          if (code !== 0) throw new Error(`Rust runtime shutdown failed (${code}): ${await diagnostics()}`)
        } finally {
          clearTimeout(shutdown)
        }
      },
    }
  } catch (error) {
    child.kill("SIGKILL")
    await child.exited
    throw error
  } finally {
    clearTimeout(timeout)
    reader.releaseLock()
  }
}

type RelayRole = PeerRole.AGENT | PeerRole.REMOTE_CLIENT
type RelayPeer = Bun.ServerWebSocket<{ role: RelayRole; connection: ReturnType<typeof createRelayConnection> }>

export function createUsageRelay(deviceID: string) {
  const accessToken = crypto.randomUUID()
  const reservation = new ReservationBudget(32 * 1024 * 1024)
  const peers = new Map<RelayRole, RelayPeer>()
  const pending = new Map<string, { browserID: string; start: number }>()
  const connector: { ms: number; outcome: string }[] = []
  const failures: string[] = []
  const now = () => performance.now()
  const flush = (peer: RelayPeer) => {
    const decisions = handoffBinary(peer.data.connection, (bytes) => { peer.send(bytes) }, now())
    for (const decision of decisions) {
      if (decision.type === "closed") throw new Error(`Relay handoff closed (${decision.category})`)
    }
  }
  const forward = (peer: RelayPeer, body: Frame["body"]) => {
    for (const decision of peer.data.connection.enqueue(body, frameReservation(body), now())) {
      if (decision.type === "closed") throw new Error(`Relay forwarding closed (${decision.category})`)
    }
  }
  const server = Bun.serve<RelayPeer["data"]>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      if (request.method === "POST") {
        if (url.pathname === "/api/devices/enroll") return Response.json({ deviceID })
        if (url.pathname === "/api/devices/challenge") return Response.json({ challengeID: "usage-perf", nonce: "fixture-nonce" })
        if (["/api/devices/token", "/api/devices/refresh"].includes(url.pathname)) {
          return Response.json({ accessToken, accessExpiresAt: Date.now() + 900_000, refreshToken: "fixture-refresh", refreshExpiresAt: Date.now() + 900_000 })
        }
      }
      const role = url.pathname === RemoteWebSocketPath.agent && request.headers.get("authorization") === `Bearer ${accessToken}`
        ? PeerRole.AGENT
        : url.pathname === RemoteWebSocketPath.client && url.searchParams.get("device") === deviceID
          ? PeerRole.REMOTE_CLIENT
          : undefined
      if (role === undefined) return new Response(null, { status: 404 })
      const connection = createRelayConnection(role, crypto.randomUUID(), "usage-performance", now(), reservation)
      if (server.upgrade(request, { data: { role, connection } })) return undefined
      return new Response(null, { status: 426 })
    },
    websocket: {
      open(peer) { peers.set(peer.data.role, peer) },
      close(peer) {
        peer.data.connection.close()
        if (peers.get(peer.data.role) === peer) peers.delete(peer.data.role)
      },
      message(peer, raw) {
        const { connection, role } = peer.data
        try {
          const { frame, decisions } = receiveBinary(connection, typeof raw === "string" ? raw : Uint8Array.from(raw).buffer, now())
          for (const decision of decisions) {
            if (decision.type === "closed") throw new Error(`Relay ingress closed (${decision.category})`)
            if (decision.type === "dispatch") {
              if (role !== PeerRole.REMOTE_CLIENT || decision.operation.diagnosticName !== "usage.dashboard") {
                throw new Error(`Unexpected relay request: ${decision.operation.diagnosticName}`)
              }
              const agent = peers.get(PeerRole.AGENT)
              if (!agent || !decision.request.scope) throw new Error("Usage connector is not ready")
              const start = now()
              const requested = agent.data.connection.request(decision.operation.operationId, decision.request.scope, decision.request.payload, decision.request.payload.byteLength + 512, start)
              if (!requested.requestID) throw new Error("Usage connector request was refused")
              pending.set(requested.requestID, { browserID: decision.requestID, start })
              flush(agent)
            }
            if (role !== PeerRole.AGENT) continue
            const browser = peers.get(PeerRole.REMOTE_CLIENT)
            if (decision.type === "bulkForward") {
              if (!browser) throw new Error("Usage result has no browser")
              const body = decision.frame.body
              if (body.case === "bulkStart") {
                const request = pending.get(body.value.requestId)
                if (!request) throw new Error("Usage result has no request")
                forward(browser, { ...body, value: { ...body.value, requestId: request.browserID } })
              } else {
                forward(browser, body)
              }
              flush(browser)
            }
            if (decision.type === "settled") {
              const request = pending.get(decision.requestID)
              if (!browser || !request || !decision.settlement) throw new Error(`Unmatched connector outcome: ${decision.status}`)
              pending.delete(decision.requestID)
              connector.push({ ms: now() - request.start, outcome: decision.status })
              if (frame?.body.case === "result") {
                const body = { case: "result", value: create(ResultSchema, { ...frame.body.value, requestId: request.browserID }) } as const
                forward(browser, body)
                flush(browser)
              }
            }
          }
          if (frame && (frame.ledger === LedgerClass.BULK || frame.ledger === LedgerClass.NORMAL) &&
              ["request", "result", "control", "bulkStart", "bulkPiece", "bulkEnd"].includes(frame.body.case ?? "")) {
            connection.consume(frame.ledger, frame.deliveryOrdinal, now())
          }
          flush(peer)
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
          for (const active of peers.values()) active.close(1011, "Usage relay failed")
        }
      },
    },
  })
  return {
    origin: server.url.origin,
    url: `ws://${server.url.host}${RemoteWebSocketPath.client}?device=${deviceID}`,
    connector,
    failures,
    close: () => server.stop(true),
  }
}
