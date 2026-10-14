import { spawn } from "bun"
import path from "node:path"
import { mkdirSync } from "node:fs"
import {
  create,
  encodeStrict,
  encodeLossless,
  ScopeSchema,
  PeerRole,
  ControlSchema,
  PublicEventSchema,
  EventRecordSchema,
  BulkStartSchema,
  BulkPieceSchema,
  BulkEndSchema,
  ContentKind,
  ResultSchema,
  session_attachment_read_ResultSchema,
  type Decision,
} from "@ycoding-ai/remote"
import { sha256Hex, randomToken } from "../../../infra/cloudflare/src/auth/crypto"
import { createRemoteTransport } from "../src/remote/transport"
import { writeWireMessage } from "../src/remote/wire"
import { remotePayloadCodecs } from "@ycoding-ai/remote"
import { fixtureSession, fixtureTokens } from "./wire-peer"
import { createAgentPeer, startAgent } from "./core-peer"

const root = path.resolve(import.meta.dir, "../../..")
const scratch = path.join(root, "apps/web/.lane-logs", `relay-local-${crypto.randomUUID()}`)
mkdirSync(scratch, { recursive: true })
const configPath = path.join(scratch, "wrangler.json")
const persist = path.join(scratch, "state")
const wranglerBin = path.join(root, "node_modules/.bin/wrangler")
const portReservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("reserved") })
const port = portReservation.port
portReservation.stop(true)
const origin = `http://127.0.0.1:${port}`
const cookie = randomToken(32)
const access = randomToken(32)
const sessionID = "ses_remote"
const backendEpoch = "web-fixture-backend"
const scope = create(ScopeSchema, { target: { case: "session", value: sessionID } })
let wrangler: ReturnType<typeof spawn> | undefined
let agent: ReturnType<typeof createAgentPeer> | undefined
let agentSocket: WebSocket | undefined
let agentTimer: ReturnType<typeof setInterval> | undefined
let dispatchIndex = 0
const nativeSocket = (url: string, headers: Readonly<Record<string, string>>) =>
  Reflect.construct(WebSocket, [url, { headers }]) as WebSocket
const events: unknown[] = []
const transport = createRemoteTransport({
  url: `${origin.replace("http:", "ws:")}/ws/v5/client?device=dev_web`,
  createSocket: (url) => nativeSocket(url, { cookie: `yc_session=${cookie}`, origin }),
  handlers: { onEvents: (_sessionID, batch) => events.push(...batch) },
})

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function run(args: string[]) {
  const process = spawn([wranglerBin, ...args], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => process.kill(), 60_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  clearTimeout(timer)
  expect(code === 0, `Wrangler command failed (${code}): ${stdout}\n${stderr}`)
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (!(await predicate())) {
    expect(Date.now() < deadline, "Local relay condition timed out")
    await Bun.sleep(25)
  }
}

function result(dispatch: Extract<Decision, { type: "dispatch" }>, value: unknown) {
  agent!.result(dispatch, value)
}

async function nextDispatch() {
  await waitFor(() => agent!.dispatches.length > dispatchIndex)
  return agent!.dispatches[dispatchIndex++]!
}

try {
  const config = await Bun.file(path.join(root, "infra/cloudflare/wrangler.jsonc")).json()
  await Bun.write(
    configPath,
    JSON.stringify({
      ...config,
      main: path.join(root, "infra/cloudflare/src/index.ts"),
      routes: [],
      assets: { ...config.assets, directory: path.join(root, "apps/web/dist") },
      d1_databases: config.d1_databases.map(
        (database: { binding: string; database_name: string; database_id: string }) => ({
          ...database,
          migrations_dir: path.join(root, "infra/cloudflare/migrations"),
        }),
      ),
    }),
  )
  await run([
    "d1",
    "migrations",
    "apply",
    "ycoding-prod-db",
    "--local",
    "--config",
    configPath,
    "--persist-to",
    persist,
  ])
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  const publicKey = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y })
  const now = Date.now()
  await run([
    "d1",
    "execute",
    "ycoding-prod-db",
    "--local",
    "--config",
    configPath,
    "--persist-to",
    persist,
    "--command",
    `INSERT INTO "user" VALUES ('usr_web', ${now}); INSERT INTO browser_session (id,user_id,created_at,expires_at) VALUES ('${await sha256Hex(cookie)}','usr_web',${now},${now + 600_000}); INSERT INTO device (id,user_id,name,public_key_jwk,key_algorithm,created_at) VALUES ('dev_web','usr_web','Web fixture','${publicKey}','ES256',${now}); INSERT INTO device_credential (id,device_id,kind,created_at,expires_at) VALUES ('${await sha256Hex(access)}','dev_web','access',${now},${now + 600_000});`,
  ])
  wrangler = spawn(
    [wranglerBin, "dev", "--local", "--config", configPath, "--persist-to", persist, "--port", String(port)],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  )
  await waitFor(
    async () =>
      fetch(`${origin}/health`)
        .then((response) => response.ok)
        .catch(() => false),
    90_000,
  )
  agent = createAgentPeer(() => performance.now(), undefined)
  agentSocket = nativeSocket(`${origin.replace("http:", "ws:")}/ws/v5/agent`, { authorization: `Bearer ${access}` })
  agentSocket.binaryType = "arraybuffer"
  const socket = agentSocket
  agent.message = (data) => {
    if (socket.readyState === 1) socket.send(data)
  }
  agent.close = (code, reason) => socket.close(code, reason)
  socket.addEventListener("open", () => startAgent(agent!))
  socket.addEventListener("message", (event) => agent!.receive(event.data))
  agentTimer = setInterval(() => {
    agent!.connection.advance(performance.now())
    agent!.flush()
  }, 25)
  await waitFor(() => agent!.connection.state === "established")
  transport.connect()
  await waitFor(() => transport.status().kind === "open")

  const read = transport.request("session.todo.list", { sessionID })
  result(await nextDispatch(), { data: [{ content: "Verify binary v5", status: "in_progress", priority: "high" }] })
  const readOutcome = await read
  expect(
    readOutcome.status === "ok" &&
      JSON.stringify(readOutcome.value) ===
        JSON.stringify({ data: [{ content: "Verify binary v5", status: "in_progress", priority: "high" }] }),
    "Typed read did not reach the actual web binding",
  )
  console.log("PASS actual web v5 binding: typed read through workerd/D1/Durable Object")

  const subscribe = transport.request("event.subscribe", { sessionID })
  const subscribed = await nextDispatch()
  await waitFor(() =>
    agent!.sent.some(
      (frame) =>
        frame.body.case === "control" &&
        frame.body.value.kind.case === "subscriptionSnapshot" &&
        frame.body.value.kind.value.sessionIds.includes(sessionID),
    ),
  )
  for (const frame of agent.sent) {
    if (frame.body.case !== "control" || frame.body.value.kind.case !== "subscriptionSnapshot") continue
    agent.connection.updateRelayInterests(frame.body.value.kind.value, performance.now())
  }
  const subscriptionID = "web-live-events"
  expect(
    agent.connection.registerRelayInterest(sessionID, subscriptionID, backendEpoch, performance.now()).length === 0,
    "Backend observer registration failed",
  )
  agent.body({
    case: "control",
    value: create(ControlSchema, { kind: { case: "resyncRequired", value: { scope, sourceEpoch: backendEpoch } } }),
  })
  result(subscribed, { subscription_id: subscriptionID })
  expect((await subscribe).status === "ok", "Web event subscription did not settle")
  const hydrate = transport.request("session.snapshot", { sessionID })
  result(await nextDispatch(), {
    data: {
      sourceEpoch: backendEpoch,
      session: { ...fixtureSession(sessionID), tokens: fixtureTokens },
      messages: [],
      watermark: { type: "log.synced", aggregateID: sessionID, seq: 0 },
    },
  })
  expect((await hydrate).status === "ok", "Web subscription hydration failed")
  agent.connection.enqueueEvent(
    create(EventRecordSchema, {
      eventId: "evt_web",
      createdMs: BigInt(now),
      event: {
        typeName: PublicEventSchema.typeName,
        payload: encodeStrict(
          PublicEventSchema,
          writeWireMessage(PublicEventSchema, {
            id: "evt_web",
            created: now,
            type: "session.status",
            data: { sessionID, status: { type: "busy" } },
          }),
        ),
      },
    }),
    { subscriptionID, scope, sourceEpoch: backendEpoch },
    performance.now(),
  )
  agent.flush()
  await waitFor(() => events.length === 1)
  expect(
    JSON.stringify(events[0]) ===
      JSON.stringify({
        id: "evt_web",
        created: now,
        type: "session.status",
        data: { sessionID, status: { type: "busy" } },
      }),
    "Web event decoder changed the typed event",
  )
  console.log("PASS actual web v5 binding: accepted subscription, canonical snapshot and typed event")

  const raw = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)
  const assetRead = transport.request("session.attachment.read", { sessionID, input: { digest: "a".repeat(64) } })
  const attachment = await nextDispatch()
  const metadata = encodeStrict(
    session_attachment_read_ResultSchema,
    writeWireMessage(session_attachment_read_ResultSchema, { data: { mime: "image/png", bytes: raw.byteLength } }),
  )
  agent.body({
    case: "result",
    value: create(ResultSchema, {
      requestId: attachment.requestID,
      operationId: attachment.operation.operationId,
      settlement: attachment.operation.settlement,
      outcome: {
        case: "assetMetadata",
        value: {
          metadata: { typeName: attachment.operation.resultType, payload: metadata },
          mime: encodeLossless("image/png"),
          byteCount: BigInt(raw.byteLength),
        },
      },
    }),
  })
  const transferID = "web-socket-asset"
  agent.body({
    case: "bulkStart",
    value: create(BulkStartSchema, {
      requestId: attachment.requestID,
      transferId: transferID,
      operationId: attachment.operation.operationId,
      typeName: attachment.operation.resultType,
      contentKind: ContentKind.ASSET,
      byteCount: BigInt(raw.byteLength),
      chunkCount: 1,
    }),
  })
  agent.body({
    case: "bulkPiece",
    value: create(BulkPieceSchema, { transferId: transferID, index: 0, offset: 0n, data: raw }),
  })
  agent.body({
    case: "bulkEnd",
    value: create(BulkEndSchema, {
      transferId: transferID,
      byteCount: BigInt(raw.byteLength),
      outcome: { case: "success", value: {} },
    }),
  })
  const assetOutcome = await assetRead
  expect(
    assetOutcome.status === "ok" && typeof assetOutcome.value === "object" && assetOutcome.value !== null,
    "Socket asset did not settle",
  )
  const asset = assetOutcome.value as { readonly data: Uint8Array; readonly mime: string; readonly release: () => void }
  expect(
    asset.mime === "image/png" &&
      Buffer.from(asset.data).equals(Buffer.from(raw)) &&
      typeof asset.release === "function",
    "takeAsset did not transfer exact bytes and release ownership",
  )
  asset.release()
  asset.release()
  expect(transport.status().kind === "open" && agent.failures.length === 0, "Asset release damaged the connection")
  console.log("PASS actual web v5 binding: session.attachment.read socket bulk through takeAsset and release")
  console.log("3 passed, 0 failed (actual web adapter, real local workerd, D1 and Durable Object; synthetic backend)")
} finally {
  transport.close()
  clearInterval(agentTimer)
  agentSocket?.close()
  wrangler?.kill()
  if (wrangler) await wrangler.exited
}
