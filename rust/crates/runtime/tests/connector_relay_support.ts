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
  event_subscribe_RequestSchema,
  event_subscribe_ResultSchema,
  event_unsubscribe_RequestSchema,
  session_todo_list_RequestSchema,
  PublicEventSchema,
  Connector_ErrorSchema,
} from "../../../../packages/protocol/src/v5"
import { TestPeer } from "../../../../packages/remote/test/peer"
import { sha256Hex, randomToken } from "../../../../infra/cloudflare/src/auth/crypto"

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
async function subscribe(client: TestPeer, sourceEpoch: string) {
  const id = client.request(
    "event.subscribe",
    session,
    encodeStrict(event_subscribe_RequestSchema, create(event_subscribe_RequestSchema, { scope: session })),
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
    client.connection.acceptSubscription(id, accepted, session, performance.now(), "receive", sourceEpoch).length === 0,
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
  await Promise.all(peers.map((peer) => peer.ready))
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
  expect(
    peers.every((peer) => peer.failures.length === 0),
    "Remote client protocol failure",
  )
  console.error(
    "PASS: real workerd enrollment, Rust AGENT connect, snapshot union, canonical epoch, ordered live/durable EVENTS, shared release and final observer release",
  )
} finally {
  clearTimeout(deadline)
  peers.forEach((peer) => peer.stop())
  worker?.kill()
  if (worker) await worker.exited
  if (workerOutput) console.error(await workerOutput)
  standin.stop(true)
}
