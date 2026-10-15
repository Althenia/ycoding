import { spawn } from "bun"
import type { Subprocess } from "bun"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import {
  create,
  encodeStrict,
  encodeLossless,
  ScopeSchema,
  PeerRole,
  ControlSchema,
  LedgerClass,
  event_subscribe_RequestSchema,
  event_subscribe_ResultSchema,
  PublicEventSchema,
  EventRecordSchema,
} from "../../../../packages/protocol/src/v5"
import { TestPeer } from "../../../../packages/remote/test/peer"
import { RemoteWebSocketPath } from "../../../../packages/remote/src/index"
import { sha256Hex, randomToken } from "../../src/auth/crypto"

const root = path.resolve(import.meta.dir, "../../../..")
const scratch = mkdtempSync(path.join(root, "infra/cloudflare/.event-authority-"))
const configPath = path.join(scratch, "wrangler.json")
const persist = path.join(scratch, "state")
const wranglerBin = path.join(root, "node_modules/.bin/wrangler")
const peers: TestPeer[] = []
const failures: Error[] = []
let wrangler: Subprocess | undefined
const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("reserved") })
const port = reservation.port!
reservation.stop(true)
const origin = `http://127.0.0.1:${port}`
const scope = create(ScopeSchema, { target: { case: "session", value: "ses_authority" } })
const subscriptionID = "authority-observer"
const sourceEpoch = "authority-source"

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
}

async function until(check: () => Promise<boolean>, message: string) {
  const deadline = performance.now() + 10_000
  while (performance.now() < deadline) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error(message)
}

async function command(device: string, action: string, body?: unknown) {
  const response = await fetch(`${origin}/_fixture/${action}?device=${device}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  })
  expect(response.ok, `Fixture ${action} failed: ${response.status}`)
  return response
}

function peer(device: string, role: PeerRole.AGENT | PeerRole.REMOTE_CLIENT, token: string) {
  const client = new TestPeer(
    `${origin.replace("http:", "ws:")}${role === PeerRole.AGENT ? RemoteWebSocketPath.agent : `${RemoteWebSocketPath.client}?device=${device}`}`,
    role === PeerRole.AGENT ? { authorization: `Bearer ${token}` } : { cookie: `yc_session=${token}`, origin },
    role,
  )
  peers.push(client)
  return client
}

async function subscribe(agent: TestPeer, client: TestPeer) {
  const requestID = client.request(
    "event.subscribe",
    scope,
    encodeStrict(event_subscribe_RequestSchema, create(event_subscribe_RequestSchema, { scope })),
  )
  const dispatch = await agent.next("dispatch")
  await agent.wait(() =>
    agent.queue.some(
      (entry) =>
        entry.frame?.body.case === "control" &&
        entry.frame.body.value.kind.case === "subscriptionSnapshot" &&
        entry.frame.body.value.kind.value.sessionIds.includes("ses_authority"),
    ),
  )
  const index = agent.queue.findIndex(
    (entry) =>
      entry.frame?.body.case === "control" &&
      entry.frame.body.value.kind.case === "subscriptionSnapshot" &&
      entry.frame.body.value.kind.value.sessionIds.includes("ses_authority"),
  )
  const frame = agent.queue.splice(index, 1)[0]!.frame!
  expect(frame.body.case === "control" && frame.body.value.kind.case === "subscriptionSnapshot", "Missing interests")
  const interests = agent.connection.updateRelayInterests(frame.body.value.kind.value, performance.now())
  expect(!interests.decisions.some((entry) => entry.type === "closed"), "Interest update failed")
  if (interests.added.length) {
    expect(
      agent.connection.registerRelayInterest("ses_authority", subscriptionID, sourceEpoch, performance.now()).length ===
        0,
      "Observer registration failed",
    )
    agent.send({
      case: "control",
      value: create(ControlSchema, { kind: { case: "resyncRequired", value: { scope, sourceEpoch } } }),
    })
  }
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
      scope,
      performance.now(),
      "send",
      sourceEpoch,
    ).length === 0,
    "Agent subscription failed",
  )
  expect((await client.next("settled", requestID)).status === "success", "Subscription did not settle")
  expect(
    client.connection.acceptSubscription(requestID, subscriptionID, scope, performance.now(), "receive", sourceEpoch)
      .length === 0,
    "Client subscription failed",
  )
}

function emit(agent: TestPeer, eventID: string) {
  agent.connection.enqueueEvent(
    create(EventRecordSchema, {
      eventId: eventID,
      createdMs: 1n,
      event: {
        typeName: PublicEventSchema.typeName,
        payload: encodeStrict(
          PublicEventSchema,
          create(PublicEventSchema, {
            kind: {
              case: "catalogUpdated",
              value: { id: encodeLossless(eventID), created: 1, type: 1, data: {} },
            },
          }),
        ),
      },
    }),
    { subscriptionID, scope, sourceEpoch },
    performance.now(),
  )
  agent.flush()
}

async function consume(client: TestPeer, eventID: string) {
  const delivery = await client.next("events")
  expect(delivery.batch.events[0]?.eventId === eventID, "Event identity changed")
  client.connection.consume(LedgerClass.EVENT, delivery.ordinal!, performance.now())
  client.flush()
}

try {
  mkdirSync(path.join(scratch, "assets"))
  await Bun.write(path.join(scratch, "assets/index.html"), "<!doctype html><title>Relay authority fixture</title>")
  const config = await Bun.file(path.join(root, "infra/cloudflare/wrangler.jsonc")).json()
  await Bun.write(
    configPath,
    JSON.stringify({
      ...config,
      main: path.join(import.meta.dir, "event-authority-worker.ts"),
      routes: [],
      assets: { directory: path.join(scratch, "assets"), binding: "ASSETS", run_worker_first: true },
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
  const cases = await Promise.all(
    (["revoked", "expired", "valid"] as const).map(async (change) => {
      const token = randomToken()
      const sibling = randomToken()
      const access = randomToken()
      return {
        change,
        token,
        sibling,
        access,
        sessionID: await sha256Hex(token),
        siblingID: await sha256Hex(sibling),
        accessID: await sha256Hex(access),
        device: `dev_${change}`,
      }
    }),
  )
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
    `INSERT INTO "user" VALUES ('usr_owner', ${now});` +
      cases
        .map(
          (item) => `
      INSERT INTO browser_session (id,user_id,created_at,expires_at) VALUES
        ('${item.sessionID}','usr_owner',${now},${now + 600_000}),
        ('${item.siblingID}','usr_owner',${now},${now + 600_000});
      INSERT INTO device (id,user_id,name,public_key_jwk,key_algorithm,created_at) VALUES
        ('${item.device}','usr_owner','Authority fixture','${publicKey}','ES256',${now});
      INSERT INTO device_credential (id,device_id,kind,created_at,expires_at) VALUES
        ('${item.accessID}','${item.device}','access',${now},${now + 600_000});`,
        )
        .join(""),
  ])
  wrangler = spawn(
    [wranglerBin, "dev", "--local", "--config", configPath, "--persist-to", persist, "--port", String(port)],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  )
  await until(
    async () =>
      fetch(`${origin}/health`).then(
        (response) => response.ok,
        () => false,
      ),
    "Worker not ready",
  )
  for (const item of cases) {
    const agent = peer(item.device, PeerRole.AGENT, item.access)
    await agent.ready
    const sibling = peer(item.device, PeerRole.REMOTE_CLIENT, item.sibling)
    await sibling.ready
    await subscribe(agent, sibling)
    const client = peer(item.device, PeerRole.REMOTE_CLIENT, item.token)
    const admitted = performance.now()
    await client.ready
    await subscribe(agent, client)
    await command(item.device, "hold")
    const eventID = `evt_${item.change}`
    emit(agent, eventID)
    await until(async () => {
      const held: { count: number } = await (await command(item.device, "held")).json()
      return held.count === 1
    }, "Event not held")
    await command(item.device, "release", { sessionID: item.sessionID, change: item.change })
    const elapsed = performance.now() - admitted
    expect(elapsed < 5000, `Fixture missed recipient authority cache interval: ${elapsed} ms`)
    await consume(sibling, eventID)
    await client.wait(
      () => client.socket.readyState === 3 || client.raw.some((frame) => frame.body.case === "eventBatch"),
    )
    const protectedFrames = client.raw.filter((frame) => frame.body.case === "eventBatch").length
    if (item.change === "valid") {
      await consume(client, eventID)
      expect(client.socket.readyState === 1, "Valid recipient disconnected")
    }
    if (item.change !== "valid" && (protectedFrames || (await client.closed).code !== 4401)) {
      failures.push(new Error(`Protected EventBatch reached ${item.change} recipient (${protectedFrames} frames)`))
    }
    console.log(JSON.stringify({ change: item.change, protectedFrames, cacheIntervalMs: Math.round(elapsed) }))
    const followup = `evt_${item.change}_followup`
    emit(agent, followup)
    await consume(sibling, followup)
    if (item.change === "valid") await consume(client, followup)
    for (const connection of [client, sibling, agent]) {
      expect(connection.failures.length === 0, "Protocol peer failed")
      connection.stop()
    }
  }
  if (failures.length) throw new AggregateError(failures, "Fresh EventBatch recipient authority failed")
  console.log(
    "3 passed, 0 failed (real workerd DeviceRelay, local D1, held native EventBatch, valid sibling continuity)",
  )
} finally {
  for (const client of peers) client.stop()
  wrangler?.kill()
  if (wrangler) await wrangler.exited
  rmSync(scratch, { recursive: true, force: true })
}
