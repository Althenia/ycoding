import { spawn } from "bun"
import path from "node:path"
import {
  create,
  encodeStrict,
  decodeStrict,
  encodeLossless,
  decodeLossless,
  ScopeSchema,
  PeerRole,
  LedgerClass,
  EmptySchema,
  event_subscribe_RequestSchema,
  event_subscribe_ResultSchema,
  event_unsubscribe_RequestSchema,
  session_todo_list_RequestSchema,
  session_snapshot_RequestSchema,
  session_snapshot_ResultSchema,
  session_message_RequestSchema,
  session_message_ResultSchema,
  PublicEventSchema,
  Connector_ErrorSchema,
} from "../../../../packages/protocol/src/v5"
import { TestPeer } from "../../../../packages/remote/test/peer"
import { httpBulkQuery, readHttpBulk } from "../../../../packages/remote/src/index"
import { sha256Hex, randomToken, base64UrlEncode } from "../../../../infra/cloudflare/src/auth/crypto"
import { generateVapidKeys } from "../../../../infra/cloudflare/script/vapid-keys"
import { deriveWebPushKeys } from "../../../../infra/cloudflare/src/push/crypto"

const root = path.resolve(import.meta.dir, "../../../..")
const scratch = process.argv[2]!
const configPath = path.join(scratch, "wrangler.json")
const persist = path.join(scratch, "worker-state")
const wranglerBin = path.join(root, "node_modules/.bin/wrangler")
const peers: TestPeer[] = []
let worker: ReturnType<typeof spawn> | undefined
let workerOutput: Promise<string> | undefined
const standin = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ keys: [] }) })
const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("reserved") })
const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
const pushAuth = crypto.getRandomValues(new Uint8Array(16))
const pushReceiver = new Uint8Array(await crypto.subtle.exportKey("raw", receiver.publicKey))
const pushes: { category: string; sessionID: string }[] = []
const pushStub = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    if (new URL(request.url).pathname !== "/push") return new Response(null, { status: 204 })
    expect(request.headers.get("content-encoding") === "aes128gcm", "Push is not encrypted")
    const body = new Uint8Array(await request.arrayBuffer())
    expect(body.length > 86, "Encrypted push record is incomplete")
    const sender = body.slice(21, 86)
    const publicSender = await crypto.subtle.importKey("raw", sender, { name: "ECDH", namedCurve: "P-256" }, false, [])
    const shared = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "ECDH", public: publicSender }, receiver.privateKey, 256),
    )
    const { cek, nonce } = await deriveWebPushKeys(shared, pushAuth, pushReceiver, sender, body.slice(0, 16))
    const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"])
    const clear = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(86)))
    expect(clear.at(-1) === 2, "Push record is not final")
    const payload: unknown = JSON.parse(new TextDecoder().decode(clear.slice(0, -1)))
    expect(
      typeof payload === "object" &&
        payload !== null &&
        "category" in payload &&
        typeof payload.category === "string" &&
        "sessionID" in payload &&
        typeof payload.sessionID === "string",
      "Push payload is not a Session notification",
    )
    pushes.push({ category: payload.category, sessionID: payload.sessionID })
    return new Response(null, { status: 201 })
  },
})
const vapid = await generateVapidKeys()
async function untilPush(category: string) {
  const deadline = Date.now() + 30_000
  while (!pushes.some((push) => push.category === category && push.sessionID === "ses_real_connector")) {
    if (Date.now() > deadline) throw new Error(`Missing decrypted ${category} push`)
    await Bun.sleep(25)
  }
}
const origin = `http://127.0.0.1:${reservation.port}`
reservation.stop(true)
const cookie = randomToken(32)
const input = (async function* () {
  let pending = ""
  for await (const bytes of Bun.stdin.stream()) {
    pending += new TextDecoder().decode(bytes)
    while (pending.includes("\n")) {
      const end = pending.indexOf("\n")
      yield JSON.parse(pending.slice(0, end))
      pending = pending.slice(end + 1)
    }
  }
})()
const deadline = setTimeout(() => {
  worker?.kill()
  throw new Error("Rust connector real-relay deadline exceeded")
}, 180_000)

function expect(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
async function command() {
  const next = await input.next()
  if (next.done) throw new Error("Rust connector owner closed stdin")
  return next.value as { deviceID: string; sourceEpoch: string }
}
async function run(args: string[]) {
  const child = spawn([wranglerBin, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const timeout = setTimeout(() => child.kill(), 60_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timeout)
  if (code !== 0) throw new Error(`Wrangler failed (${code})\n${stdout}\n${stderr}`)
}
const session = create(ScopeSchema, { target: { case: "session", value: "ses_real_connector" } })
async function subscribe(client: TestPeer, sourceEpoch: string, scope = session) {
  const id = client.request(
    "event.subscribe",
    scope,
    encodeStrict(event_subscribe_RequestSchema, create(event_subscribe_RequestSchema, { scope })),
  )
  const settled = await client.next("settled", id)
  if (settled.status === "unknown") console.error("Subscriber closed", await client.closed)
  expect(
    settled.status === "success",
    `Rust backend rejected subscription: ${settled.status}${settled.payload?.typeName === Connector_ErrorSchema.typeName ? ` code=${decodeStrict(Connector_ErrorSchema, settled.payload.payload).code}` : ""}`,
  )
  const answer = decodeStrict(event_subscribe_ResultSchema, settled.payload!.payload)
  const accepted = decodeLossless(answer.subscriptionId!)
  expect(
    client.connection.acceptSubscription(id, accepted, scope, performance.now(), "receive", sourceEpoch).length === 0,
    "Client rejected backend identity",
  )
  return accepted
}
async function events(client: TestPeer, count: number, sourceEpoch: string, subscriptionID: string) {
  const values = []
  while (values.length < count) {
    const entry = await client.next("events")
    expect(
      entry.batch.subscriptionId === subscriptionID && entry.batch.sourceEpoch === sourceEpoch,
      "Event identity or canonical epoch changed",
    )
    values.push(...entry.batch.events.map((event) => decodeStrict(PublicEventSchema, event.event!.payload)))
    client.connection.consume(LedgerClass.EVENT, entry.ordinal!, performance.now())
    client.flush()
  }
  expect(values.length === count, "Unexpected extra events")
  return values
}
async function release(client: TestPeer, subscriptionID: string) {
  const id = client.request(
    "event.unsubscribe",
    session,
    encodeStrict(
      event_unsubscribe_RequestSchema,
      create(event_unsubscribe_RequestSchema, { subscriptionId: subscriptionID }),
    ),
  )
  expect((await client.next("settled", id)).status === "success", "Relay release failed")
  client.connection.releaseSubscription(subscriptionID, performance.now())
}
try {
  await Bun.write(path.join(scratch, "assets/index.html"), "<!doctype html><title>Connector relay fixture</title>")
  const config = await Bun.file(path.join(root, "infra/cloudflare/wrangler.jsonc")).json()
  await Bun.write(
    configPath,
    JSON.stringify({
      ...config,
      main: path.join(root, "infra/cloudflare/test/integration/push-stub-worker.ts"),
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
    `INSERT INTO "user" VALUES ('usr_connector', ${now}); INSERT INTO browser_session (id,user_id,created_at,expires_at) VALUES ('${await sha256Hex(cookie)}','usr_connector',${now},${now + 600_000});`,
  ])
  worker = spawn(
    [
      wranglerBin,
      "dev",
      "--local",
      "--config",
      configPath,
      "--persist-to",
      persist,
      "--port",
      new URL(origin).port,
      "--var",
      "GOOGLE_CLIENT_ID:local-connector",
      "--var",
      "GOOGLE_CLIENT_SECRET:synthetic",
      "--var",
      "GOOGLE_ALLOWED_EMAILS:connector@example.invalid",
      "--var",
      `GOOGLE_ISSUER:http://127.0.0.1:${standin.port}`,
      "--var",
      `GOOGLE_TOKEN_ENDPOINT:http://127.0.0.1:${standin.port}/token`,
      "--var",
      `GOOGLE_JWKS_URI:http://127.0.0.1:${standin.port}/certs`,
      "--define",
      `PUSH_STUB_PORT:${pushStub.port}`,
      "--var",
      `VAPID_PUBLIC_KEY:${vapid.VAPID_PUBLIC_KEY}`,
      "--var",
      `VAPID_PRIVATE_KEY:${vapid.VAPID_PRIVATE_KEY}`,
      "--var",
      "VAPID_SUBJECT:mailto:local-test@example.invalid",
    ],
    { cwd: root, stdout: "pipe", stderr: "inherit" },
  )
  workerOutput = new Response(worker.stdout).text()
  const readyDeadline = Date.now() + 90_000
  while (true) {
    const response = await fetch(`${origin}/health`).catch(() => undefined)
    if (response?.status === 200) break
    if (Date.now() > readyDeadline) throw new Error("workerd readiness timed out")
    await Bun.sleep(100)
  }
  const enrollmentResponse = await fetch(`${origin}/api/devices/enrollments`, {
    method: "POST",
    headers: { cookie: `yc_session=${cookie}`, origin },
  })
  expect(enrollmentResponse.ok, "Local Worker does not serve enrollment routes")
  const enrollment = (await enrollmentResponse.json()) as { enrollmentID: string; code: string }
  console.log(JSON.stringify({ phase: "enrollment", origin, ...enrollment }))
  const owner = await command()
  const connectedDeadline = Date.now() + 30_000
  while (true) {
    const response = await fetch(`${origin}/api/devices`, { headers: { cookie: `yc_session=${cookie}` } })
    expect(response.ok, "Worker device list failed")
    const listing = (await response.json()) as { devices: { id: string; online: boolean }[] }
    const device = listing.devices.find((device) => device.id === owner.deviceID)
    expect(device, "Rust enrollment was not persisted by the Worker")
    if (device.online) break
    if (Date.now() > connectedDeadline) throw new Error("Relay did not confirm the Rust connector handshake")
    await Bun.sleep(25)
  }
  for (let index = 0; index < 2; index++)
    peers.push(
      new TestPeer(
        `${origin.replace("http", "ws")}/ws/v5/client?device=${owner.deviceID}`,
        { cookie: `yc_session=${cookie}`, origin },
        PeerRole.REMOTE_CLIENT,
      ),
    )
  await Promise.all(
    peers.map((peer) =>
      peer.ready.catch(async (cause: unknown) => {
        throw new Error(`REMOTE_CLIENT handshake closed: ${JSON.stringify(await peer.closed)}`, { cause })
      }),
    ),
  )
  const accepted = await subscribe(peers[0]!, owner.sourceEpoch)
  expect(
    (await subscribe(peers[1]!, owner.sourceEpoch)) === accepted,
    "Subscriptions do not share the backend observer identity",
  )
  console.log(JSON.stringify({ phase: "subscribed" }))
  await command()
  for (const peer of peers) {
    const received = await events(peer, 3, owner.sourceEpoch, accepted)
    expect(
      received.every(
        (event, index) =>
          event.kind.case === "sessionTextDelta" &&
          event.kind.value.data?.ordinal === BigInt(index) &&
          decodeLossless(event.kind.value.data.delta!) === `live-${index}`,
      ),
      "Live events changed order or payload",
    )
  }
  console.log(JSON.stringify({ phase: "live-delivered" }))
  await command()
  for (const peer of peers) {
    const [event] = await events(peer, 1, owner.sourceEpoch, accepted)
    expect(
      event!.kind.case === "sessionRenamed" && decodeLossless(event!.kind.value.data!.title!) === "Relay renamed",
      "Durable event did not cross the Rust connector",
    )
  }
  await release(peers[0]!, accepted)
  console.log(JSON.stringify({ phase: "released-one" }))
  await command()
  const [remaining] = await events(peers[1]!, 1, owner.sourceEpoch, accepted)
  expect(
    remaining!.kind.case === "sessionTextDelta" && remaining!.kind.value.data!.ordinal === 3n,
    "Remaining subscriber lost shared interest",
  )
  expect(!peers[0]!.queue.some((item) => item.decision.type === "events"), "Released subscriber received new events")
  await release(peers[1]!, accepted)
  const fence = peers[1]!.request(
    "session.todo.list",
    session,
    encodeStrict(
      session_todo_list_RequestSchema,
      create(session_todo_list_RequestSchema, { params: { sessionID: encodeLossless("ses_real_connector") } }),
    ),
  )
  expect((await peers[1]!.next("settled", fence)).status === "success", "Release fence failed")
  console.log(JSON.stringify({ phase: "released-all" }))
  await command()
  const pushKeys = {
    p256dh: base64UrlEncode(pushReceiver),
    auth: base64UrlEncode(pushAuth),
  }
  const registration = await fetch(`${origin}/api/push/subscriptions`, {
    method: "POST",
    headers: { cookie: `yc_session=${cookie}`, origin, "content-type": "application/json" },
    body: JSON.stringify({
      endpoint: "https://fcm.googleapis.com/fcm/send/flow-local-only",
      keys: pushKeys,
      categories: { "agent-completed": true, "approval-requested": true, "machine-offline": true },
    }),
  })
  expect(registration.status === 200, "Push subscription was not registered")
  const noticeID = peers[1]!.request(
    "notice.subscribe",
    create(ScopeSchema, { target: { case: "machine", value: {} } }),
    encodeStrict(EmptySchema, create(EmptySchema)),
  )
  expect((await peers[1]!.next("settled", noticeID)).status === "success", "Notice subscription failed")
  const noticed = (category: number) =>
    peers[1]!.raw.some(
      (frame) =>
        frame.body.case === "control" &&
        frame.body.value.kind.case === "notice" &&
        frame.body.value.kind.value.kind.case === "added" &&
        frame.body.value.kind.value.kind.value.notices.some(
          (notice) => notice.sessionId === "ses_real_connector" && notice.category === category,
        ),
    )
  console.log(JSON.stringify({ phase: "notifications-ready" }))
  await command()
  await peers[1]!.wait(() => noticed(1), 30_000)
  await untilPush("approval-requested")
  console.log(JSON.stringify({ phase: "attention-notified" }))
  await command()
  await peers[1]!.wait(() => noticed(2), 30_000)
  await untilPush("agent-completed")
  console.log(JSON.stringify({ phase: "completion-pushed" }))
  await command()
  const affected = await subscribe(peers[0]!, owner.sourceEpoch)
  const otherScope = create(ScopeSchema, { target: { case: "session", value: "ses_real_other" } })
  const healthy = await subscribe(peers[1]!, owner.sourceEpoch, otherScope)
  const epochs = peers.map((peer) => peer.connection.connectionEpoch)
  const healthyResyncs = peers[1]!.raw.filter(
    (frame) => frame.body.case === "control" && frame.body.value.kind.case === "resyncRequired",
  ).length
  console.log(JSON.stringify({ phase: "oversize-ready" }))
  await command()
  await events(peers[0]!, 2, owner.sourceEpoch, affected)
  const resync = await peers[0]!.next("resync")
  expect(
    resync.scope.target.case === "session" &&
      resync.scope.target.value === "ses_real_connector" &&
      resync.sourceEpoch === owner.sourceEpoch,
    "Oversize resync changed scope or source epoch",
  )
  const [unaffected] = await events(peers[1]!, 1, owner.sourceEpoch, healthy)
  expect(
    unaffected!.kind.case === "sessionTextDelta" && unaffected!.kind.value.data!.ordinal === 4n,
    "Oversize blocked an unrelated Session",
  )
  peers[0]!.connection.beginHydration(affected)
  const snapshotID = peers[0]!.request(
    "session.snapshot",
    session,
    encodeStrict(
      session_snapshot_RequestSchema,
      create(session_snapshot_RequestSchema, {
        params: { sessionID: encodeLossless("ses_real_connector") },
        query: {},
      }),
    ),
  )
  const settled = await peers[0]!.next("settled", snapshotID)
  expect(settled.status === "success", `Oversize canonical snapshot failed: ${settled.status}`)
  const snapshot = decodeStrict(session_snapshot_ResultSchema, settled.payload!.payload).data!
  const message = snapshot.messages!.items.find(
    (message) => message.kind.case === "value8" && decodeLossless(message.kind.value.id!) === "msg_real_oversized",
  )
  expect(message?.kind.case === "value8", "Oversized assistant is not in the canonical snapshot")
  const text = message.kind.value.content!.items.find((part) => part.kind.case === "value1")
  expect(
    text?.kind.case === "value1" && decodeLossless(text.kind.value.text!) === "x".repeat(2_320_000),
    "Canonical bulk recovery lost assistant text",
  )
  expect(
    peers[0]!.raw.some(
      (frame) =>
        frame.body.case === "bulkStart" &&
        frame.body.value.operationId === 4063 &&
        frame.body.value.byteCount > 2_320_000n,
    ),
    "Canonical recovery did not use typed bulk",
  )
  expect(decodeLossless(snapshot.sourceEpoch!) === owner.sourceEpoch, "Canonical snapshot changed backend epoch")
  const httpRequest = peers[0]!.request(
    "session.message",
    session,
    encodeStrict(
      session_message_RequestSchema,
      create(session_message_RequestSchema, {
        params: { sessionID: encodeLossless("ses_real_connector"), messageID: encodeLossless("msg_real_oversized") },
      }),
    ),
  )
  peers[0]!.connection.expectHttpBulk(httpRequest)
  const declaration = await peers[0]!.next("httpBulkStart")
  const response = await fetch(
    `${origin}/api/remote/devices/${owner.deviceID}/sessions/ses_real_connector/messages/msg_real_oversized?${httpBulkQuery(peers[0]!.connection, declaration).toString()}`,
    { headers: { cookie: `yc_session=${cookie}`, origin }, signal: AbortSignal.timeout(30_000) },
  )
  expect(response.status === 200, "Typed HTTP message route did not return 200")
  const consumed = await readHttpBulk(peers[0]!.connection, declaration, response, {
    now: () => performance.now(),
    apply(decisions) {
      peers[0]!.queue.push(...decisions.map((decision) => ({ decision })))
      peers[0]!.flush()
    },
  })
  expect(consumed.bytes === declaration.start.byteCount, "Typed HTTP message body was truncated")
  expect((await peers[0]!.next("settled", httpRequest)).status === "success", "Typed HTTP message did not settle")
  await peers[0]!.wait(() =>
    peers[0]!.queue.some(
      (item) => item.decision.type === "bulkComplete" && item.decision.transferID === declaration.start.transferId,
    ),
  )
  const completed = peers[0]!.queue.flatMap((item) =>
    item.decision.type === "bulkComplete" && item.decision.transferID === declaration.start.transferId
      ? [item.decision]
      : [],
  )
  expect(completed.length === 1, "Typed HTTP message completion was not exactly once")
  const fetched = decodeStrict(session_message_ResultSchema, completed[0]!.data).data!
  expect(fetched.kind.case === "value8", "Typed HTTP message is not an assistant")
  expect(
    fetched.kind.value.content!.items.some(
      (part) => part.kind.case === "value1" && decodeLossless(part.kind.value.text!) === "x".repeat(2_320_000),
    ),
    "Typed HTTP message did not preserve the full assistant reply",
  )
  expect(
    peers[0]!.raw.filter(
      (frame) => frame.body.case === "bulkEnd" && frame.body.value.transferId === declaration.start.transferId,
    ).length === 1,
    "Typed HTTP message did not receive exactly one canonical owning-socket BulkEnd",
  )
  expect(
    !peers[1]!.raw.some(
      (frame) => frame.body.case === "bulkEnd" && frame.body.value.transferId === declaration.start.transferId,
    ),
    "Typed HTTP message terminal reached another browser",
  )
  peers[0]!.connection.releaseBulk(declaration.start.transferId)
  expect(
    peers[0]!.connection.completeHydration(affected, owner.sourceEpoch, performance.now()).length === 0,
    "Canonical snapshot did not finish hydration",
  )
  console.log(JSON.stringify({ phase: "oversize-resynced" }))
  await command()
  const [recovered] = await events(peers[0]!, 1, owner.sourceEpoch, affected)
  expect(
    recovered!.kind.case === "sessionTextDelta" && recovered!.kind.value.data!.ordinal === 4n,
    "Resynced subscription no longer delivers events",
  )
  await events(peers[1]!, 1, owner.sourceEpoch, healthy)
  expect(
    peers.every(
      (peer, index) => peer.connection.state === "established" && peer.connection.connectionEpoch === epochs[index],
    ),
    "Oversize recycled a browser connection",
  )
  expect(
    peers[1]!.raw.filter((frame) => frame.body.case === "control" && frame.body.value.kind.case === "resyncRequired")
      .length === healthyResyncs,
    "Oversize invalidated an unrelated subscription",
  )
  console.log(JSON.stringify({ phase: "oversize-recovered" }))
  await command()
  expect(
    peers.every((peer) => peer.failures.length === 0),
    "Remote client protocol failure",
  )
  console.error(
    "PASS: real workerd enrollment, Rust AGENT connect, snapshot union, canonical epoch, ordered live/durable EVENTS, shared release, decrypted attention/completion pushes, oversized scoped resync, exact typed-bulk and HTTP recovery with one owning-socket terminal and stable peer epochs",
  )
} finally {
  clearTimeout(deadline)
  peers.forEach((peer) => peer.stop())
  worker?.kill()
  if (worker) await worker.exited
  if (workerOutput) console.error(await workerOutput)
  standin.stop(true)
  pushStub.stop(true)
}
