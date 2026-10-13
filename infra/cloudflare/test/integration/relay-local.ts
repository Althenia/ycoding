import { spawn } from "bun"
import type { Subprocess } from "bun"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import {
  create,
  encodeStrict,
  decodeStrict,
  encodeLossless,
  ScopeSchema,
  PeerRole,
  ControlSchema,
  EmptySchema,
  ConnectorNoticeBeforeSchema,
  ConnectorNoticeIDsSchema,
  ConnectorNoticePageSchema,
  ConnectorNoticeSettlementSchema,
  session_todo_list_RequestSchema,
  session_todo_list_ResultSchema,
  session_interrupt_RequestSchema,
  ContentKind,
  BulkStartSchema,
  BulkPieceSchema,
  BulkEndSchema,
  LedgerClass,
  event_subscribe_RequestSchema,
  event_subscribe_ResultSchema,
  event_unsubscribe_RequestSchema,
  PublicEventSchema,
  EventRecordSchema,
  ResultSchema,
  encodeAssetMetadata,
  session_attachment_read_RequestSchema,
  session_attachment_read_ResultSchema,
} from "../../../../packages/protocol/src/v5"
import { TestPeer } from "../../../../packages/remote/test/peer"
import {
  RemoteWebSocketPath,
  takeAsset,
  decodeRemoteResult,
  decodeRemoteEvent,
} from "../../../../packages/remote/src/index"
import { ReservationBudget } from "../../../../packages/protocol/src/v5/connection"
import { sha256Hex, randomToken } from "../../src/auth/crypto"

const root = path.resolve(import.meta.dir, "../../../..")
const scratch = mkdtempSync(path.join(root, "infra/cloudflare/.v5-relay-"))
const configPath = path.join(scratch, "wrangler.json")
const persist = path.join(scratch, "state")
const wranglerBin = path.join(root, "node_modules/.bin/wrangler")
const peers: TestPeer[] = []
const checks: string[] = []
let wrangler: Subprocess | undefined
const standin = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ keys: [] }) })
const portReservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("reserved") })
const port = portReservation.port
portReservation.stop(true)
const origin = `http://127.0.0.1:${port}`
const wsOrigin = `ws://127.0.0.1:${port}`
const cookie = randomToken(32)
const foreignCookie = randomToken(32)
const access = randomToken(32)
const otherAccess = randomToken(32)
const empty = encodeStrict(EmptySchema, create(EmptySchema))
const machine = create(ScopeSchema, { target: { case: "machine", value: {} } })
const session = create(ScopeSchema, { target: { case: "session", value: "ses_remote" } })
const todo = encodeStrict(
  session_todo_list_RequestSchema,
  create(session_todo_list_RequestSchema, { params: { sessionID: encodeLossless("ses_remote") } }),
)
const todoResult = encodeStrict(
  session_todo_list_ResultSchema,
  create(session_todo_list_ResultSchema, { data: { items: [] } }),
)

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
async function run(args: string[]) {
  const process = spawn([wranglerBin, ...args], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const timeout = setTimeout(() => process.kill(), 60_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  clearTimeout(timeout)
  if (code !== 0) throw new Error(`Local Wrangler command failed (${code})\n${stdout}\n${stderr}`)
  return stdout
}
async function sql(command: string) {
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
    command,
  ])
}
function peer(
  role: PeerRole.AGENT | PeerRole.REMOTE_CLIENT,
  options: {
    device?: string
    cookie?: string
    access?: string
    budgets?: ConstructorParameters<typeof TestPeer>[3]
    hello?: ConstructorParameters<typeof TestPeer>[4]
  } = {},
) {
  const url = `${wsOrigin}${role === PeerRole.AGENT ? RemoteWebSocketPath.agent : `${RemoteWebSocketPath.client}?device=${options.device ?? "dev_relay"}`}`
  const headers =
    role === PeerRole.AGENT
      ? { authorization: `Bearer ${options.access ?? access}` }
      : {
          cookie: `yc_session=${options.cookie ?? cookie}`,
          origin,
          "x-ycoding-owner": "forged",
          "x-ycoding-device": "dev_other",
        }
  const client = new TestPeer(url, headers, role, options.budgets, options.hello)
  peers.push(client)
  return client
}
async function ready() {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/health`)).status === 200) return
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error("Local workerd readiness deadline exceeded")
}
async function settled(client: TestPeer, name: string, scope = machine, payload = empty) {
  const id = client.request(name, scope, payload)
  return client.next("settled", id)
}

try {
  mkdirSync(path.join(scratch, "assets"))
  await Bun.write(path.join(scratch, "assets/index.html"), "<!doctype html><title>Local relay fixture</title>")
  const config = await Bun.file(path.join(root, "infra/cloudflare/wrangler.jsonc")).json()
  await Bun.write(
    configPath,
    JSON.stringify({
      ...config,
      main: path.join(root, "infra/cloudflare/src/index.ts"),
      routes: [],
      assets: { ...config.assets, directory: path.join(scratch, "assets") },
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
  const expires = now + 600_000
  await sql(`INSERT INTO "user" VALUES ('usr_owner', ${now}), ('usr_foreign', ${now});
    INSERT INTO browser_session (id,user_id,created_at,expires_at) VALUES ('${await sha256Hex(cookie)}','usr_owner',${now},${expires}), ('${await sha256Hex(foreignCookie)}','usr_foreign',${now},${expires});
    INSERT INTO device (id,user_id,name,public_key_jwk,key_algorithm,created_at) VALUES ('dev_relay','usr_owner','Relay fixture','${publicKey}','ES256',${now}), ('dev_other','usr_owner','Other fixture','${publicKey}','ES256',${now}), ('dev_foreign','usr_foreign','Foreign fixture','${publicKey}','ES256',${now});
    INSERT INTO device_credential (id,device_id,kind,created_at,expires_at) VALUES ('${await sha256Hex(access)}','dev_relay','access',${now},${expires}), ('${await sha256Hex(otherAccess)}','dev_other','access',${now},${expires});`)
  wrangler = spawn(
    [
      wranglerBin,
      "dev",
      "--local",
      "--config",
      configPath,
      "--persist-to",
      persist,
      "--port",
      String(port),
      "--var",
      "GOOGLE_CLIENT_ID:local-relay",
      "--var",
      "GOOGLE_CLIENT_SECRET:synthetic",
      "--var",
      "GOOGLE_ALLOWED_EMAILS:relay@example.invalid",
      "--var",
      `GOOGLE_ISSUER:http://127.0.0.1:${standin.port}`,
      "--var",
      `GOOGLE_TOKEN_ENDPOINT:http://127.0.0.1:${standin.port}/token`,
      "--var",
      `GOOGLE_JWKS_URI:http://127.0.0.1:${standin.port}/certs`,
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  )
  await ready()

  for (const version of [3, 4, 6])
    for (const role of ["client", "agent"])
      expect(
        (await fetch(`${origin}/ws/v${version}/${role}`, { headers: { upgrade: "websocket" } })).status === 404,
        "Non-v5 route was admitted",
      )
  expect(
    (
      await fetch(`${origin}${RemoteWebSocketPath.client}?device=dev_relay`, {
        headers: { upgrade: "websocket", origin, cookie: `yc_session=${foreignCookie}` },
      })
    ).status === 403,
    "Cross-owner device was admitted",
  )
  expect(
    (
      await fetch(`${origin}${RemoteWebSocketPath.client}?device=dev_foreign`, {
        headers: { upgrade: "websocket", origin, cookie: `yc_session=${cookie}` },
      })
    ).status === 403,
    "Foreign device was admitted",
  )
  expect(
    (
      await fetch(`${origin}${RemoteWebSocketPath.client}?device=dev_relay`, {
        headers: { upgrade: "websocket", origin: "https://other.example.invalid", cookie: `yc_session=${cookie}` },
      })
    ).status === 403,
    "Cross-origin browser was admitted",
  )
  expect(
    (await fetch(`${origin}${RemoteWebSocketPath.agent}`, { headers: { upgrade: "websocket" } })).status === 401,
    "Missing agent credential was admitted",
  )
  checks.push("exact version, cookie/bearer, cross-origin, owner/device isolation")

  for (const change of ["revision", "digest", "role", "epoch"] as const) {
    const invalid = peer(PeerRole.REMOTE_CLIENT, {
      hello: (frame) => {
        if (frame.body.case !== "hello") throw new Error("Missing Hello")
        if (change === "revision") frame.body.value.revision = 4
        if (change === "digest") frame.body.value.contractDigest = new Uint8Array(32)
        if (change === "role") frame.body.value.role = PeerRole.AGENT
        if (change === "epoch") frame.connectionEpoch = "forged"
        return frame
      },
    })
    expect((await invalid.closed).code === 1008, `Mismatched Hello ${change} did not reject with 1008`)
  }
  const text = new WebSocket(`${wsOrigin}${RemoteWebSocketPath.client}?device=dev_relay`, {
    headers: { cookie: `yc_session=${cookie}`, origin },
  })
  const textClosed = new Promise<number>((resolve) =>
    text.addEventListener("close", (event) => resolve(event.code), { once: true }),
  )
  await new Promise<void>((resolve) => text.addEventListener("open", () => resolve(), { once: true }))
  text.send('{"type":"request"}')
  expect((await textClosed) === 1008, "Text socket did not reject before handshake")
  checks.push("binary-only handshake rejects mismatched revision/digest/role and fabricated epoch")

  const agent = peer(PeerRole.AGENT, { budgets: { deliveryTimeoutMs: 60_000 } })
  const first = peer(PeerRole.REMOTE_CLIENT)
  const second = peer(PeerRole.REMOTE_CLIENT)
  await Promise.all([agent.ready, first.ready, second.ready])
  expect(
    first.connection.state === "established" && agent.connection.state === "established",
    "Role handshake did not establish",
  )
  const a = first.request("session.todo.list", session, todo)
  const b = second.request("session.todo.list", session, todo)
  expect(a === "1" && b === "1", "Peer request IDs are not connection-local")
  const dispatches = [await agent.next("dispatch"), await agent.next("dispatch")]
  expect(dispatches[0].requestID !== dispatches[1].requestID, "Relay correlation IDs collided")
  expect(
    dispatches.every((item) => Buffer.from(item.request.payload).equals(Buffer.from(todo))),
    "Relay re-encoded the domain request",
  )
  for (const dispatch of dispatches) agent.result(dispatch, todoResult)
  const results = await Promise.all([first.next("settled", a), second.next("settled", b)])
  expect(
    results.every((result) => result.status === "success"),
    "Result forwarding failed",
  )
  expect(
    results.every(
      (result) =>
        decodeRemoteResult("session.todo.list", result.payload!).$typeName === session_todo_list_ResultSchema.typeName,
    ),
    "Remote client result codec did not decode the real forwarded settlement",
  )
  checks.push("real Connection peers handshake and forward opaque RPCs with per-browser correlation")

  const notice = await settled(first, "notice.subscribe")
  const page = decodeStrict(ConnectorNoticePageSchema, notice.payload!.payload)
  expect(page.notice?.kind.case === "added" && page.unavailable === false, "Notice subscribe result is not typed")
  agent.send({
    case: "control",
    value: create(ControlSchema, { kind: { case: "completions", value: { items: [], more: false } } }),
  })
  agent.send({
    case: "control",
    value: create(ControlSchema, {
      kind: {
        case: "completions",
        value: {
          items: [{ id: "evt_complete", sequence: 1n, createdMs: BigInt(now), sessionId: "ses_remote" }],
          more: false,
        },
      },
    }),
  })
  await first
    .wait(() =>
      first.raw.some(
        (frame) =>
          frame.body.case === "control" &&
          frame.body.value.kind.case === "notice" &&
          frame.body.value.kind.value.kind.case === "added",
      ),
    )
    .catch((cause: unknown) => {
      throw new Error("Waiting for the persisted notice notification", { cause })
    })
  const listed = decodeStrict(
    ConnectorNoticePageSchema,
    (
      await settled(
        first,
        "notice.list",
        machine,
        encodeStrict(ConnectorNoticeBeforeSchema, create(ConnectorNoticeBeforeSchema, { before: encodeLossless("") })),
      )
    ).payload!.payload,
  )
  expect(
    listed.notice!.kind.case === "added" && listed.notice!.kind.value.total === 1n,
    "Completion notice was not persisted",
  )
  const read = decodeStrict(
    ConnectorNoticeSettlementSchema,
    (
      await settled(
        first,
        "notice.read",
        machine,
        encodeStrict(ConnectorNoticeIDsSchema, create(ConnectorNoticeIDsSchema, { ids: ["ntc_1"] })),
      )
    ).payload!.payload,
  )
  expect(read.notification?.kind.case === "removed", "Notice read did not remove the selected item")
  expect((await settled(first, "notice.readAll")).status === "success", "Notice readAll failed")
  expect(
    agent.queue.every((entry) => entry.decision.type !== "dispatch"),
    "A notice RPC was forwarded to the agent",
  )
  checks.push("relay-owned subscribe/list/read/readAll and completion notice persistence")

  const bulkID = second.request("session.todo.list", session, todo)
  const bulkRequest = await agent.next("dispatch")
  const bulkPayload = encodeStrict(
    session_todo_list_ResultSchema,
    create(session_todo_list_ResultSchema, { data: { items: [] } }),
  )
  const start = create(BulkStartSchema, {
    requestId: bulkRequest.requestID,
    transferId: "typed-bulk",
    operationId: bulkRequest.operation.operationId,
    typeName: bulkRequest.operation.resultType,
    contentKind: ContentKind.TYPED_MESSAGE,
    byteCount: BigInt(bulkPayload.length),
    chunkCount: 1,
  })
  agent.send({ case: "bulkStart", value: start })
  agent.send({
    case: "bulkPiece",
    value: create(BulkPieceSchema, { transferId: start.transferId, index: 0, offset: 0n, data: bulkPayload }),
  })
  agent.send({
    case: "bulkEnd",
    value: create(BulkEndSchema, {
      transferId: start.transferId,
      byteCount: start.byteCount,
      outcome: { case: "success", value: {} },
    }),
  })
  expect((await second.next("settled", bulkID)).status === "success", "Typed bulk did not settle")
  const complete = await second.next("bulkComplete")
  expect(Buffer.from(complete.data).equals(Buffer.from(bulkPayload)), "Typed bulk changed bytes")
  second.connection.releaseBulk(complete.transferID)
  checks.push("typed bulk forwards without relay reassembly and completes at the endpoint")

  const subscriptionID = "accepted-backend-observer"
  const backendEpoch = "canonical-backend-source"
  const subscriber = peer(PeerRole.REMOTE_CLIENT)
  await subscriber.ready
  const registeredClients = new Set<string>()
  async function backendSubscribe(client: TestPeer) {
    const requestID = client.request(
      "event.subscribe",
      session,
      encodeStrict(event_subscribe_RequestSchema, create(event_subscribe_RequestSchema, { scope: session })),
    )
    const dispatch = await agent.next("dispatch")
    await agent.wait(() =>
      agent.queue.some(
        (item) =>
          item.frame?.body.case === "control" &&
          item.frame.body.value.kind.case === "subscriptionSnapshot" &&
          !registeredClients.has(item.frame.body.value.kind.value.clientId) &&
          item.frame.body.value.kind.value.sessionIds.includes("ses_remote"),
      ),
    )
    const index = agent.queue.findIndex(
      (item) =>
        item.frame?.body.case === "control" &&
        item.frame.body.value.kind.case === "subscriptionSnapshot" &&
        !registeredClients.has(item.frame.body.value.kind.value.clientId) &&
        item.frame.body.value.kind.value.sessionIds.includes("ses_remote"),
    )
    const frame = agent.queue.splice(index, 1)[0]!.frame!
    if (frame.body.case !== "control" || frame.body.value.kind.case !== "subscriptionSnapshot")
      throw new Error("Missing full snapshot")
    registeredClients.add(frame.body.value.kind.value.clientId)
    const interests = agent.connection.updateRelayInterests(frame.body.value.kind.value, performance.now())
    expect(!interests.decisions.some((item) => item.type === "closed"), "Snapshot closed the shared observer")
    if (interests.added.includes("ses_remote"))
      expect(
        agent.connection.registerRelayInterest("ses_remote", subscriptionID, backendEpoch, performance.now()).length ===
          0,
        "Backend-accepted observer registration failed",
      )
    if (interests.added.includes("ses_remote"))
      agent.send({
        case: "control",
        value: create(ControlSchema, {
          kind: { case: "resyncRequired", value: { scope: session, sourceEpoch: backendEpoch } },
        }),
      })
    agent.result(
      dispatch,
      encodeStrict(
        event_subscribe_ResultSchema,
        create(event_subscribe_ResultSchema, { subscriptionId: encodeLossless(subscriptionID) }),
      ),
    )
    expect(
      agent.connection.acceptSubscription(
        dispatch.requestID,
        subscriptionID,
        session,
        performance.now(),
        "send",
        backendEpoch,
      ).length === 0,
      "RPC association replaced or rejected the union observer",
    )
    const settled = await client.next("settled", requestID)
    expect(settled.status === "success", "Subscription Result did not reach the browser")
    expect(
      client.connection.acceptSubscription(
        requestID!,
        subscriptionID,
        session,
        performance.now(),
        "receive",
        backendEpoch,
      ).length === 0,
      "Browser registration failed",
    )
    return frame.body.value.kind.value.clientId
  }
  const firstClientID = await backendSubscribe(first)
  const otherClientID = await backendSubscribe(subscriber)
  expect(
    firstClientID !== otherClientID && agent.connection.relaySubscriptionID("ses_remote") === subscriptionID,
    "Clients did not share the accepted backend identity",
  )
  const event = create(EventRecordSchema, {
    eventId: "evt_live",
    createdMs: BigInt(now),
    event: {
      typeName: PublicEventSchema.typeName,
      payload: encodeStrict(
        PublicEventSchema,
        create(PublicEventSchema, {
          kind: {
            case: "sessionStatus",
            value: {
              id: encodeLossless("evt_live"),
              created: now,
              type: 1,
              data: {
                sessionID: encodeLossless("ses_remote"),
                status: { kind: { case: "value1", value: { type: 1 } } },
              },
            },
          },
        }),
      ),
    },
  })
  agent.connection.enqueueEvent(event, { subscriptionID, scope: session, sourceEpoch: backendEpoch }, performance.now())
  const deliveries = await Promise.all([first.next("events"), subscriber.next("events")]).catch((cause) => {
    throw new Error(
      `Fanout: agent=${JSON.stringify(agent.connection.counters)}, first=${JSON.stringify(first.connection.counters)}, second=${JSON.stringify(subscriber.connection.counters)}, agent-event-bytes=${agent.connection.ledger(LedgerClass.EVENT).handedBytes}, first-frames=${first.raw.slice(-6).map((frame) => frame.body.case)}, second-frames=${subscriber.raw.slice(-6).map((frame) => frame.body.case)}`,
      { cause },
    )
  })
  expect(
    deliveries.every(
      (item) =>
        item.batch.subscriptionId === subscriptionID &&
        item.batch.sourceEpoch === backendEpoch &&
        item.batch.events.length === 1 &&
        item.batch.events[0]!.eventId === event.eventId &&
        Buffer.from(item.batch.events[0]!.event!.payload).equals(Buffer.from(event.event!.payload)),
    ),
    "Forwarding rewrote the backend batch",
  )
  expect(
    first.raw.some((frame) => frame.body.case === "ready" && frame.body.value.sourceEpoch !== backendEpoch),
    "Fixture collapsed relay and backend epochs",
  )
  expect(
    deliveries.every((delivery) => decodeRemoteEvent(delivery.batch.events[0]!.event!).kind.case === "sessionStatus"),
    "Remote client event decoder did not preserve the real subscribed event",
  )
  const retained = agent.connection.ledger(LedgerClass.EVENT).handedBytes
  expect(retained > 0, "Upstream event was consumed on native handoff")
  first.connection.consume(LedgerClass.EVENT, deliveries[0]!.ordinal!, performance.now())
  first.flush()
  subscriber.connection.consume(LedgerClass.EVENT, deliveries[1]!.ordinal!, performance.now())
  subscriber.flush()
  await agent.wait(() => agent.connection.ledger(LedgerClass.EVENT).handedBytes === 0)
  checks.push("whole EventBatch identity and bytes survive fanout; upstream credit waits for every downstream ticket")
  checks.push(
    "Remote-owned REMOTE_CLIENT binding encodes generated requests and decodes real results and subscribed events",
  )
  subscriber.stop()
  await agent.wait(() =>
    agent.queue.some(
      (item) =>
        item.frame?.body.case === "control" &&
        item.frame.body.value.kind.case === "subscriptionSnapshot" &&
        item.frame.body.value.kind.value.clientId === otherClientID &&
        item.frame.body.value.kind.value.sessionIds.length === 0,
    ),
  )
  expect(
    agent.connection.releaseRelayClient(otherClientID, performance.now()).removed.length === 0 &&
      agent.connection.relaySubscriptionID("ses_remote") === subscriptionID,
    "Disconnect revoked another client's interest",
  )
  const unsubscription = first.request(
    "event.unsubscribe",
    session,
    encodeStrict(
      event_unsubscribe_RequestSchema,
      create(event_unsubscribe_RequestSchema, { subscriptionId: subscriptionID }),
    ),
  )
  expect((await first.next("settled", unsubscription)).status === "success", "Unsubscribe did not settle locally")
  first.connection.releaseSubscription(subscriptionID, performance.now())
  expect(
    agent.connection.releaseRelayClient(firstClientID, performance.now()).removed.includes("ses_remote"),
    "Last client did not release the backend observer",
  )
  checks.push(
    "immutable client snapshots register one shared observer and disconnect/unsubscribe release only their membership",
  )

  registeredClients.delete(firstClientID)
  await backendSubscribe(first)
  agent.send({ case: "streamEnd", value: { $typeName: "ycoding.v5.StreamEnd", subscriptionId: subscriptionID } })
  expect(
    (await first.next("streamEnded")).subscriptionID === subscriptionID,
    "Finite StreamEnd did not reach its accepted browser subscription",
  )
  await agent.wait(() => agent.connection.ledger(LedgerClass.EVENT).handedBytes === 0)
  agent.connection.releaseRelayClient(firstClientID, performance.now())
  checks.push(
    "AGENT and RELAY carry finite StreamEnd on the event ledger after prior responsibility and return upstream credit",
  )

  for (const length of [0, 65537]) {
    const requestID = second.request(
      "session.attachment.read",
      session,
      encodeStrict(
        session_attachment_read_RequestSchema,
        create(session_attachment_read_RequestSchema, {
          params: { sessionID: encodeLossless("ses_remote"), digest: encodeLossless("a".repeat(64)) },
        }),
      ),
    )
    const dispatch = await agent.next("dispatch")
    const metadata = encodeAssetMetadata(
      session_attachment_read_ResultSchema,
      create(session_attachment_read_ResultSchema, {
        data: { mime: encodeLossless("image/png"), bytes: BigInt(length) },
      }),
    )
    agent.send({
      case: "result",
      value: create(ResultSchema, {
        requestId: dispatch.requestID,
        operationId: dispatch.operation.operationId,
        settlement: dispatch.operation.settlement,
        outcome: { case: "assetMetadata", value: metadata },
      }),
    })
    const declaration = await second.next("assetMetadata", requestID)
    expect(
      declaration.metadata.byteCount === BigInt(length) &&
        !second.queue.some((item) => item.decision.type === "settled" && item.decision.requestID === requestID),
      `Metadata settled the asset before its raw body: expected=${length}, declared=${declaration.metadata.byteCount}, id=${requestID}, settlements=${JSON.stringify(second.queue.flatMap((item) => (item.decision.type === "settled" ? [{ id: item.decision.requestID, status: item.decision.status }] : [])))}`,
    )
    const transferId = `asset-${length}`
    agent.send({
      case: "bulkStart",
      value: create(BulkStartSchema, {
        requestId: dispatch.requestID,
        transferId,
        operationId: dispatch.operation.operationId,
        typeName: dispatch.operation.resultType,
        contentKind: ContentKind.ASSET,
        byteCount: BigInt(length),
        chunkCount: Math.ceil(length / 65536),
      }),
    })
    const data = new Uint8Array(length).fill(173)
    for (let offset = 0, index = 0; offset < length; offset += 65536, index++)
      agent.send({
        case: "bulkPiece",
        value: create(BulkPieceSchema, {
          transferId,
          index,
          offset: BigInt(offset),
          data: data.subarray(offset, offset + 65536),
        }),
      })
    agent.send({
      case: "bulkEnd",
      value: create(BulkEndSchema, { transferId, byteCount: BigInt(length), outcome: { case: "success", value: {} } }),
    })
    expect((await second.next("settled", requestID)).status === "success", "Asset BulkEnd did not settle successfully")
    const complete = await second.next("bulkComplete")
    if (!complete.metadata) throw new Error("Missing completed asset metadata")
    expect(
      takeAsset(second.connection, complete, new ReservationBudget(1)) === undefined &&
        second.connection.assetMetadataRetainedBytes > 0,
      "Failed owner reservation released the live connection's asset",
    )
    const owner = new ReservationBudget(2 * 1024 * 1024)
    const asset = takeAsset(second.connection, complete, owner)
    expect(
      asset !== undefined &&
        Buffer.from(asset.data).equals(Buffer.from(data)) &&
        Buffer.from(asset.result.payload).equals(Buffer.from(metadata.metadata!.payload)),
      "Ownership handoff changed the asset or its canonical typed Result",
    )
    expect(
      second.connection.assetMetadataRetainedBytes === 0 && owner.used > 0,
      "Completed asset was released without a charged consumer owner",
    )
    asset!.release()
    asset!.release()
    expect(owner.used === 0, "Asset owner release leaked or double-refunded its charge")
  }
  checks.push(
    "nonterminal asset metadata, empty and multi-piece raw delivery, canonical Result and reserve-before-release ownership",
  )
  const cancelledAssetID = second.request(
    "session.attachment.read",
    session,
    encodeStrict(
      session_attachment_read_RequestSchema,
      create(session_attachment_read_RequestSchema, {
        params: { sessionID: encodeLossless("ses_remote"), digest: encodeLossless("b".repeat(64)) },
      }),
    ),
  )
  const cancelledAsset = await agent.next("dispatch")
  agent.send({
    case: "result",
    value: create(ResultSchema, {
      requestId: cancelledAsset.requestID,
      operationId: cancelledAsset.operation.operationId,
      settlement: cancelledAsset.operation.settlement,
      outcome: {
        case: "assetMetadata",
        value: encodeAssetMetadata(
          session_attachment_read_ResultSchema,
          create(session_attachment_read_ResultSchema, { data: { mime: encodeLossless("image/png"), bytes: 1n } }),
        ),
      },
    }),
  })
  await second.next("assetMetadata", cancelledAssetID)
  second.connection.cancel(cancelledAssetID!, performance.now())
  second.flush()
  expect(
    second.connection.assetMetadataRetainedBytes === 0 &&
      (await agent.next("cancelled")).requestID === cancelledAsset.requestID,
    "Cancellation retained metadata or failed to stop delivery",
  )
  checks.push("cancelling a declared but incomplete asset releases endpoint metadata and forwards cancellation")

  const cancelID = first.request(
    "session.interrupt",
    session,
    encodeStrict(
      session_interrupt_RequestSchema,
      create(session_interrupt_RequestSchema, { params: { sessionID: encodeLossless("ses_remote") } }),
    ),
  )
  const cancelled = await agent.next("dispatch")
  const cancellation = first.connection.cancel(cancelID, performance.now())
  expect(
    cancellation.some((entry) => entry.type === "settled" && entry.status === "unknown"),
    "Transmitted mutation cancellation invented rollback",
  )
  first.flush()
  expect(
    (await agent.next("cancelled", cancelled.requestID)).mutation,
    "Cancel was not forwarded to the mutation owner",
  )
  checks.push("transmitted cancellation settles unknown and forwards once without rollback")

  const other = peer(PeerRole.AGENT, { access: otherAccess })
  const otherBrowser = peer(PeerRole.REMOTE_CLIENT, { device: "dev_other" })
  await Promise.all([other.ready, otherBrowser.ready])
  const otherID = otherBrowser.request("session.todo.list", session, todo)
  const isolated = await other.next("dispatch")
  other.result(isolated, todoResult)
  expect((await otherBrowser.next("settled", otherID)).status === "success", "Second owned device did not progress")
  expect(
    agent.queue.every((entry) => entry.decision.type !== "dispatch"),
    "Request crossed devices",
  )
  checks.push("forged routing headers are stripped and separate device Durable Objects stay isolated")

  const rate = peer(PeerRole.REMOTE_CLIENT, { budgets: { clientRate: 1000 } })
  await rate.ready
  for (let index = 0; index < 120; index++) {
    const result = await settled(
      rate,
      "notice.list",
      machine,
      encodeStrict(ConnectorNoticeBeforeSchema, create(ConnectorNoticeBeforeSchema, { before: encodeLossless("") })),
    )
    expect(result.status === "success", `Request budget rejected valid frame ${index}`)
  }
  rate.request(
    "notice.list",
    machine,
    encodeStrict(ConnectorNoticeBeforeSchema, create(ConnectorNoticeBeforeSchema, { before: encodeLossless("") })),
  )
  expect((await rate.closed).reason === "LIMIT", "Real relay did not enforce the 120-frame receive rate")
  checks.push("real workerd normal-frame receive rate limit (Connection peer with a higher local sender budget)")

  const stalled = peer(PeerRole.REMOTE_CLIENT)
  stalled.autoConsume = false
  await stalled.ready
  for (let index = 0; index < 4; index++)
    agent.send({
      case: "control",
      value: create(ControlSchema, {
        kind: {
          case: "status",
          value: {
            running: Array.from({ length: 500 }, (_, item) => `ses_${index}_${item}_${"x".repeat(100)}`),
            attention: [],
          },
        },
      }),
    })
  await second.wait(
    () =>
      second.raw.filter((frame) => frame.body.case === "control" && frame.body.value.kind.case === "status").length >=
      4,
  )
  expect(
    agent.connection.ledger(LedgerClass.NORMAL).handedBytes > 0,
    "send refunded upstream status ownership before stalled-recipient consumption",
  )
  const healthyID = second.request("session.todo.list", session, todo)
  agent.result(await agent.next("dispatch"), todoResult)
  expect((await second.next("settled", healthyID)).status === "success", "Stalled peer blocked a healthy peer")
  const stalledClose = await Promise.race([
    stalled.closed,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Stalled recipient consumption deadline was not enforced")),
        35_000,
      )
      void stalled.closed.finally(() => clearTimeout(timer))
    }),
  ])
  expect(stalledClose.reason === "LIMIT", "Stalled recipient escaped the handed-consumption deadline")
  checks.push("handed status accounting survives native send and isolates a stalled recipient")

  const survivor = peer(PeerRole.REMOTE_CLIENT)
  await survivor.ready
  const pending = survivor.request("session.todo.list", session, todo)
  await agent.next("dispatch")
  agent.stop()
  expect((await survivor.closed).code === 1012, "Agent loss did not reconstruct transmitted work")
  expect(
    survivor.queue.some(
      (entry) =>
        entry.decision.type === "settled" &&
        entry.decision.requestID === pending &&
        entry.decision.status === "unknown",
    ),
    "Disconnect lost unknown settlement",
  )
  const replacement = peer(PeerRole.AGENT)
  await replacement.ready
  const reopened = peer(PeerRole.REMOTE_CLIENT)
  await reopened.ready
  const post = reopened.request("session.todo.list", session, todo)
  const postDispatch = await replacement.next("dispatch")
  replacement.result(postDispatch, todoResult)
  expect(
    (await reopened.next("settled", post)).status === "success" &&
      replacement.queue.every((entry) => entry.decision.type !== "dispatch"),
    "Replacement replayed old work",
  )
  checks.push("agent disconnect/replacement settles unknown, creates fresh epochs and never replays")

  await sql(`UPDATE browser_session SET revoked_at=${Date.now()} WHERE id='${await sha256Hex(cookie)}'`)
  reopened.request("session.todo.list", session, todo)
  expect((await reopened.closed).code === 4401, "Fresh D1 authorization did not enforce revocation")
  expect(
    replacement.queue.every((entry) => entry.decision.type !== "dispatch"),
    "Revoked owner forwarded a control",
  )
  checks.push("fresh local D1 revocation blocks forwarding after socket authentication")
  for (const client of peers) expect(client.failures.length === 0, "Protocol-conformant peer failed")
  for (const check of checks) console.log(`PASS ${check}`)
  console.log(`${checks.length} passed, 0 failed (real local workerd, D1, Durable Object, binary Connection peers)`)
} finally {
  for (const client of peers) client.stop()
  wrangler?.kill()
  if (wrangler) await wrangler.exited
  standin.stop(true)
  rmSync(scratch, { recursive: true, force: true })
}
