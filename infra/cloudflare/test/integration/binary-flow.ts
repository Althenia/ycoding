import { spawn } from "bun"
import path from "node:path"
import { mkdir, mkdtemp } from "node:fs/promises"
import { TestPeer } from "../../../../packages/remote/test/peer"
import {
  create,
  encodeStrict,
  decodeStrict,
  encodeLossless,
  PeerRole,
  LedgerClass,
  ScopeSchema,
  EmptySchema,
  ControlSchema,
  ConnectorNoticePageSchema,
  ConnectorNoticeBeforeSchema,
  session_todo_list_RequestSchema,
  session_todo_list_ResultSchema,
  FrameSchema,
  event_subscribe_RequestSchema,
  event_subscribe_ResultSchema,
  PublicEventSchema,
  EventRecordSchema,
  BulkStartSchema,
  BulkPieceSchema,
  BulkEndSchema,
  StreamEndSchema,
  ContentKind,
  FailureCategory,
  operations,
  toBinary,
  encodeAssetMetadata,
  ResultSchema,
  session_attachment_read_RequestSchema,
  session_attachment_read_ResultSchema,
} from "../../../../packages/protocol/src/v5"
import type { Frame } from "../../../../packages/protocol/src/v5"
import type { Decision } from "../../../../packages/protocol/src/v5/connection"
import { randomToken, sha256Hex, base64UrlEncode } from "../../src/auth/crypto"
import { generateVapidKeys } from "../../script/vapid-keys"
import { RelayLimits, WireLimit, readHttpBulk, httpBulkQuery } from "../../../../packages/remote/src/index"

const root = path.resolve(import.meta.dir, "../../../..")
const selected = process.argv
  .find((argument) => argument.startsWith("--group="))
  ?.slice(8)
  .split(",")
const groups = ["storage", "predecessor", "stall", "http", "limits", "authority", "d1"]
expect(!selected?.some((name) => !groups.includes(name)), "Unknown native wire-flow group")
const enabled = (name: string) => selected === undefined || selected.includes(name)
await mkdir(path.join(root, ".cache/tmp"), { recursive: true })
const scratch = await mkdtemp(path.join(root, ".cache/tmp/wire-native-"))
const peers: TestPeer[] = []
const receipts: string[] = []
const pushes: number[] = []
const receiver = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    expect(request.headers.get("content-encoding") === "aes128gcm", "Push must be encrypted")
    pushes.push((await request.arrayBuffer()).byteLength)
    return new Response(null, { status: 201 })
  },
})
const vapid = await generateVapidKeys()
const send = (body: Frame["body"], peer: TestPeer) => peer.send(body)
const machine = create(ScopeSchema, { target: { case: "machine", value: {} } })
const scope = create(ScopeSchema, { target: { case: "session", value: "ses_native" } })
const todo = encodeStrict(
  session_todo_list_RequestSchema,
  create(session_todo_list_RequestSchema, {
    params: { sessionID: encodeLossless("ses_native") },
  }),
)

function expect(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

await Bun.write(
  path.join(scratch, "worker.ts"),
  `
import worker, { DeviceRelay } from ${JSON.stringify(path.join(root, "infra/cloudflare/src/index.ts"))};
import { createD1AuthStore } from ${JSON.stringify(path.join(root, "infra/cloudflare/src/auth/d1-store.ts"))};
import { decodeStrict, FrameSchema, WireLimit } from ${JSON.stringify(path.join(root, "packages/protocol/src/v5/index.ts"))};
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  return url.hostname === "fcm.googleapis.com" ? nativeFetch(${JSON.stringify(receiver.url.href)}, init) : nativeFetch(input, init);
};
class EvidenceRelay extends DeviceRelay {
  generation = crypto.randomUUID();
  received = [];
  held = [];
  pendingClose = [];
  closedCallbacks = 0;
  holdClose = false;
  holdClass;
  overrideRole;
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/_wire/dump") return Response.json({
      generation: this.generation, received: this.received, held: this.held.map(item => item.receipt),
      pendingClose: this.pendingClose.length, closedCallbacks: this.closedCallbacks,
      identities: this.ctx.getWebSockets().map(socket => socket.deserializeAttachment()),
      kv: [...await this.ctx.storage.list({ prefix: "completion" })],
      notices: [...this.ctx.storage.sql.exec("SELECT seq, category, session_id, created_at FROM notice ORDER BY seq")],
    });
    if (url.pathname === "/_wire/hold") {
      const body = await request.json(); this.holdClass = body.kind; this.overrideRole = body.role;
      this.holdClose = body.close === true; return new Response(null, {status:204});
    }
    if (url.pathname === "/_wire/release") {
      this.holdClass = undefined; this.holdClose = false;
      for (const item of this.held.splice(0)) item.resolve();
      for (const resolve of this.pendingClose.splice(0)) resolve();
      return new Response(null, {status:204});
    }
    if (url.pathname === "/_wire/expose") { globalThis.__wireInspect = this; return new Response(null, {status:204}); }
    if (url.pathname === "/_wire/unexpose") { delete globalThis.__wireInspect; return new Response(null, {status:204}); }
    if (url.pathname === "/_wire/dispose") return super.fetch(new Request("http://fixture/_ycoding/close-device", {headers:{"x-ycoding-internal":"1"}}));
    return super.fetch(request);
  }
  async webSocketMessage(socket, message) {
    const identity = socket.deserializeAttachment();
    const bytes = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
    const maximum = identity.role === "agent" ? WireLimit.SERVER_FRAME_BYTES : WireLimit.CLIENT_FRAME_BYTES;
    const frame = typeof message === "string" || bytes > maximum ? undefined : (() => { try { return decodeStrict(FrameSchema, new Uint8Array(message)); } catch { return undefined; } })();
    const kind = frame?.body.case === "control" ? frame.body.value.kind.case : frame?.body.case ?? (typeof message === "string" || bytes > maximum ? "overlimit" : "malformed");
    const receipt = {role:identity.role, bytes, kind, ledger:frame?.ledger};
    this.received.push(receipt); if(this.received.length > 256) this.received.shift();
    if(this.holdClass === kind && this.overrideRole === identity.role) {
      this.holdClass = undefined;
      await new Promise(resolve => this.held.push({resolve, receipt}));
    }
    await super.webSocketMessage(socket, message);
  }
  async webSocketClose(socket) {
    if(this.holdClose && socket.deserializeAttachment()?.role === "agent")
      await new Promise(resolve => this.pendingClose.push(resolve));
    await super.webSocketClose(socket); this.closedCallbacks++;
  }
}
export { EvidenceRelay as DeviceRelay };
export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  if(url.pathname === "/_wire/rotate") {
    const body = await request.json();
    try { return Response.json({rotated:await createD1AuthStore(env.DB).rotateBrowserSession(body.current,body.next,body.now)}); }
    catch(error) { return new Response(String(error), {status:500}); }
  }
  if(url.pathname.startsWith("/_wire/")) return env.DEVICE_RELAY.get(env.DEVICE_RELAY.idFromName(url.searchParams.get("name"))).fetch(request);
  return worker.fetch(request, env, ctx);
}};
`,
)
const built = await Bun.build({
  entrypoints: [path.join(scratch, "worker.ts")],
  target: "browser",
  format: "esm",
  outdir: path.join(scratch, "bundle"),
  external: ["cloudflare:workers"],
  minify: false,
})
expect(built.success, `Worker fixture did not build: ${built.logs.join("\n")}`)
await Bun.write(
  path.join(scratch, "driver.mjs"),
  `
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
const {Miniflare, convertV4MiniflareOptions} = await import(process.argv[2]);
const {unstable_splitSqlQuery} = await import(process.argv[4]);
const options = JSON.parse(await readFile(process.argv[3], "utf8"));
const mf = new Miniflare({...convertV4MiniflareOptions(options), unsafeInspectDurableObjects:true});
const ready = await mf.ready;
const database = await mf.getD1Database("DB");
const server = createServer(async (request,response) => {
  try {
    const chunks=[]; for await(const chunk of request) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString() || "{}");
    let result;
    if(request.url === "/d1") result = await database.prepare(body.query).bind(...(body.bindings ?? [])).all();
    if(request.url === "/migrate") result = await database.batch(unstable_splitSqlQuery(body.query).map(query=>database.prepare(query)));
    if(request.url === "/do") result = await (await mf.unsafeGetDurableObjectStorage("wire-evidence", "DeviceRelay", {name:body.name})).exec(body.query, ...(body.bindings ?? []));
    if(request.url === "/evict") { await mf.unsafeEvictDurableObject("wire-evidence","DeviceRelay",{name:body.name,webSockets:"hibernate"}); result={evicted:true}; }
    response.writeHead(200,{"content-type":"application/json"}); response.end(JSON.stringify(result ?? null));
  } catch(error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
console.log(JSON.stringify({phase:"ready", origin:String(ready), control:"http://127.0.0.1:"+server.address().port, inspector:String(await mf.getInspectorURL())}));
await new Promise(resolve=>process.stdin.on("end",resolve).resume());
await new Promise(resolve=>server.close(resolve)); await mf.dispose();
`,
)
await Bun.write(
  path.join(scratch, "options.json"),
  JSON.stringify({
    name: "wire-evidence",
    scriptPath: built.outputs[0]!.path,
    modules: true,
    compatibilityDate: "2026-09-20",
    port: 0,
    inspectorPort: 0,
    host: "127.0.0.1",
    d1Databases: { DB: "wire-native" },
    durableObjects: { DEVICE_RELAY: { className: "DeviceRelay", useSQLite: true } },
    d1Persist: path.join(scratch, "d1"),
    durableObjectsPersist: path.join(scratch, "objects"),
    bindings: {
      GOOGLE_CLIENT_ID: "wire-test",
      GOOGLE_CLIENT_SECRET: "synthetic",
      GOOGLE_ALLOWED_EMAILS: "wire@example.invalid",
      VAPID_PUBLIC_KEY: vapid.VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: vapid.VAPID_PRIVATE_KEY,
      VAPID_SUBJECT: "mailto:wire@example.invalid",
    },
  }),
)
const wrangler = path.dirname(Bun.resolveSync("wrangler/package.json", root))
const miniflare = Bun.resolveSync("miniflare", wrangler)
const child = spawn(
  [
    "node",
    path.join(scratch, "driver.mjs"),
    miniflare,
    path.join(scratch, "options.json"),
    Bun.resolveSync("wrangler", root),
  ],
  {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: Bun.file(path.join(scratch, "workerd.log")),
  },
)
const deadline = setTimeout(() => child.kill(), 240_000)
const output = child.stdout.getReader()
const initial = new TextDecoder()
let pending = ""
const ready = await (async () => {
  while (true) {
    const part = await output.read()
    expect(!part.done, `Native workerd driver exited before readiness; ${scratch}`)
    pending += initial.decode(part.value)
    for (const line of pending.split("\n").slice(0, -1)) {
      if (line.startsWith('{"phase":"ready"'))
        return JSON.parse(line) as { origin: string; control: string; inspector: string }
    }
    pending = pending.slice(pending.lastIndexOf("\n") + 1)
  }
})()
const drain = (async () => {
  while (!(await output.read()).done) {}
})()
const origin = ready.origin.replace(/\/$/, "")
const control = async (route: string, body: object) => {
  const response = await fetch(`${ready.control}${route}`, {
    method: "POST",
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  expect(response.ok, `Native tooling ${route}: ${await response.clone().text()}`)
  return response.json() as Promise<unknown>
}
const sql = (query: string, bindings: (string | number | null)[] = []) => control("/d1", { query, bindings })
const owner = "usr_wire_native"
const cookie = randomToken()
const otherCookie = randomToken()
type Fixture = { device: string; name: string; access: string }
type Dump = {
  generation: string
  held: { bytes: number; role: string; kind: string; ledger: number }[]
  received: { bytes: number; role: string; kind: string }[]
  pendingClose: number
  closedCallbacks: number
  kv: [string, unknown][]
  notices: { seq: number; category: string; session_id: string; created_at: number }[]
  identities: { connectionID: string; role: string; ownerID: string; deviceID: string; browserSessionID: string }[]
}
const fixtureCommand = async (fixture: Fixture, route: string, body?: object) => {
  const response = await fetch(`${origin}/_wire/${route}?name=${encodeURIComponent(fixture.name)}`, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  expect(response.ok, `Fixture ${route} failed: ${response.status}`)
  return route === "dump" ? ((await response.json()) as Dump) : undefined
}
const dump = async (fixture: Fixture) => (await fixtureCommand(fixture, "dump"))!
async function nativeClosed(peer: TestPeer, label: string) {
  await peer
    .wait(() => peer.socket.readyState === 3)
    .catch((cause: unknown) => {
      throw new Error(`Native close missing: ${label}`, { cause })
    })
  return peer.closed
}
async function until<T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> {
  const end = Date.now() + 15_000
  while (true) {
    const result = await read()
    if (result !== undefined) return result
    expect(Date.now() < end, label)
    await Bun.sleep(10)
  }
}
async function device(label: string, expires = Date.now() + 600_000): Promise<Fixture> {
  const device = `dev_${label}`
  const access = randomToken()
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const publicKey = await crypto.subtle.exportKey("jwk", key.publicKey)
  await sql("INSERT INTO device (id,user_id,name,public_key_jwk,key_algorithm,created_at) VALUES (?,?,?,?,?,?)", [
    device,
    owner,
    label,
    JSON.stringify({ kty: "EC", crv: "P-256", x: publicKey.x, y: publicKey.y }),
    "ES256",
    Date.now(),
  ])
  await sql("INSERT INTO device_credential (id,device_id,kind,created_at,expires_at) VALUES (?,?, 'access',?,?)", [
    await sha256Hex(access),
    device,
    Date.now(),
    expires,
  ])
  return { device, access, name: `${owner}:${device}` }
}
function peer(
  fixture: Fixture,
  role: PeerRole.AGENT | PeerRole.REMOTE_CLIENT,
  token = role === PeerRole.AGENT ? fixture.access : cookie,
) {
  const result = new TestPeer(
    `${origin.replace("http", "ws")}/ws/v5/${role === PeerRole.AGENT ? "agent" : `client?device=${fixture.device}`}`,
    role === PeerRole.AGENT ? { authorization: `Bearer ${token}` } : { cookie: `yc_session=${token}`, origin },
    role,
  )
  peers.push(result)
  return result
}
async function notice(client: TestPeer) {
  const id = client.request(
    "notice.list",
    machine,
    encodeStrict(ConnectorNoticeBeforeSchema, create(ConnectorNoticeBeforeSchema, { before: encodeLossless("") })),
  )
  const result = await client.next("settled", id)
  expect(result.status === "success" && result.payload !== undefined, "Relay-local notice read failed")
  return decodeStrict(ConnectorNoticePageSchema, result.payload.payload)
}
const completion = (sequence: bigint): Frame["body"] => ({
  case: "control",
  value: create(ControlSchema, {
    kind: {
      case: "completions",
      value: {
        items: [{ id: `native-${sequence}`, sessionId: "ses_native", sequence, createdMs: sequence }],
        more: false,
      },
    },
  }),
})

async function inspection(fixture: Fixture) {
  await fixtureCommand(fixture, "expose")
  const endpoint = new URL(ready.inspector)
  endpoint.protocol = "http:"
  endpoint.pathname = "/json/list"
  const targets = (await (await fetch(endpoint)).json()) as {
    title: string
    id: string
    webSocketDebuggerUrl: string
  }[]
  const target = targets.find((entry) => `${entry.title} ${entry.id}`.includes("wire-evidence"))
  expect(target, "TOOLING: local workerd inspector did not expose the actual Worker target")
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const contexts: { id: number; name: string }[] = []
  let sequence = 0
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("TOOLING: inspector socket failed")), { once: true })
  })
  socket.addEventListener("message", (event) => {
    const response = JSON.parse(String(event.data)) as {
      id?: number
      result?: Record<string, unknown>
      error?: { message: string }
      method?: string
      params?: { context?: { id: number; name: string } }
    }
    if (response.method === "Runtime.executionContextCreated" && response.params?.context)
      contexts.push(response.params.context)
    if (response.id === undefined) return
    const request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    clearTimeout(request.timer)
    if (response.error) {
      request.reject(new Error(`TOOLING: inspector ${response.error.message}`))
      return
    }
    request.resolve(response.result ?? {})
  })
  const command = (method: string, params: object = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`TOOLING: inspector ${method} timed out`))
      }, 10_000)
      pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
  try {
    await opened
    await command("Runtime.enable")
    const instance = (
      await command("Runtime.evaluate", {
        expression: "globalThis.__wireInspect",
        objectGroup: "wire-budget",
        ...(contexts[0] ? { contextId: contexts[0].id } : {}),
      })
    ).result as { objectId?: string }
    expect(instance.objectId, "TOOLING: inspector cannot observe the actual native Durable Object")
    const properties = await command("Runtime.getProperties", { objectId: instance.objectId, ownProperties: true })
    const relay = (properties.privateProperties as { name: string; value: { objectId?: string } }[] | undefined)?.find(
      (property) => property.name === "#relay",
    )?.value.objectId
    expect(relay, "TOOLING: workerd inspector does not expose the production relay reservation owner")
    const identities = (await dump(fixture)).identities
    const result = await command("Runtime.callFunctionOn", {
      objectId: relay,
      returnByValue: true,
      functionDeclaration: `function(identities) { return { used: this.reservation.used, limit: this.reservation.limit, peers: identities.flatMap(identity => { const connection=this.connection(identity.connectionID); return connection ? [{role:identity.role, epoch:connection.connectionEpoch, retained:connection.retainedBytes, reassembly:connection.bulkRetainedBytes, http:connection.httpHandedBytes, ledgers:[1,2,3,4].map(kind=>{const ledger=connection.ledger(kind);return {kind,handed:ledger.handedBytes,received:ledger.receivedBytes,queued:ledger.queuedBytes};})}] : []; }) }; }`,
      arguments: [{ value: identities }],
    })
    const exception = result.exceptionDetails
    expect(!exception, "TOOLING: native reservation observation failed")
    const budget = (
      result.result as {
        value: {
          used: number
          limit: number
          peers: {
            role: string
            epoch: string
            http: number
            retained: number
            reassembly: number
            ledgers: { kind: number; handed: number; received: number; queued: number }[]
          }[]
        }
      }
    ).value
    const heap = await command("Runtime.getHeapUsage")
    expect(
      budget.limit === RelayLimits.applicationBytes && budget.used >= 0 && budget.used <= budget.limit,
      "Actual workerd relay exceeded its aggregate application reservation",
    )
    await command("Runtime.releaseObjectGroup", { objectGroup: "wire-budget" })
    return { budget, heap }
  } finally {
    socket.close()
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error("Inspector closed"))
    }
    await fixtureCommand(fixture, "unexpose")
  }
}

function consumeReceived(peer: TestPeer, ledger: LedgerClass) {
  while (peer.connection.ledger(ledger).receivedCount > 0) {
    peer.connection.consume(ledger, peer.connection.ledger(ledger).consumed + 1n, performance.now())
    expect(peer.connection.state !== "closed", "Native receipt consumption violated its ledger prefix")
  }
  peer.flush()
}

function forgedCredit(peer: TestPeer, ledger: LedgerClass, through: bigint, transferId?: string) {
  const tiny = peer.connection.ledger(LedgerClass.TINY)
  peer.socket.send(
    toBinary(
      FrameSchema,
      create(FrameSchema, {
        revision: 5,
        connectionEpoch: peer.connection.connectionEpoch,
        ledger: LedgerClass.TINY,
        deliveryOrdinal: tiny.sentOrdinal + 1n,
        tinyConsumedThrough: tiny.receivedOrdinal,
        body: {
          case: "control",
          value: {
            kind: {
              case: "credit",
              value: { ledger, consumedThrough: through, ...(transferId === undefined ? {} : { transferId }) },
            },
          },
        },
      }),
    ),
  )
}

async function subscribe(agent: TestPeer, client: TestPeer, id: string, announce = true) {
  const requestID = client.request(
    "event.subscribe",
    scope,
    encodeStrict(event_subscribe_RequestSchema, create(event_subscribe_RequestSchema, { scope })),
  )
  const input = await agent.next("dispatch")
  if (announce)
    send(
      {
        case: "control",
        value: create(ControlSchema, {
          kind: { case: "resyncRequired", value: { scope, sourceEpoch: "native-epoch" } },
        }),
      },
      agent,
    )
  agent.result(
    input,
    encodeStrict(
      event_subscribe_ResultSchema,
      create(event_subscribe_ResultSchema, { subscriptionId: encodeLossless(id) }),
    ),
  )
  expect(
    agent.connection.acceptSubscription(input.requestID, id, scope, performance.now(), "send", "native-epoch")
      .length === 0,
    "Backend rejected the actual subscription identity",
  )
  expect((await client.next("settled", requestID)).status === "success", "Native subscription did not settle")
  expect(
    client.connection.acceptSubscription(requestID, id, scope, performance.now(), "receive", "native-epoch").length ===
      0,
    "Browser rejected the actual subscription identity",
  )
  for (const peer of [client, agent]) consumeReceived(peer, LedgerClass.NORMAL)
  await agent.wait(() => agent.connection.ledger(LedgerClass.NORMAL).handedBytes === 0)
}

async function stallReceipts() {
  for (const kind of [
    "status",
    "completions",
    "blocked",
    "inventoryInvalidated",
    "resyncRequired",
    "priority",
    "failure",
  ] as const) {
    const fixture = await device(`stall_${kind}`)
    const agent = peer(fixture, PeerRole.AGENT)
    await agent.ready
    const browser = peer(fixture, PeerRole.REMOTE_CLIENT)
    const healthy = peer(fixture, PeerRole.REMOTE_CLIENT)
    await Promise.all([browser.ready, healthy.ready])
    const body: Frame["body"] = {
      case: "control",
      value: create(ControlSchema, {
        kind:
          kind === "status"
            ? { case: kind, value: { running: [], attention: [] } }
            : kind === "completions"
              ? { case: kind, value: { items: [], more: false } }
              : kind === "blocked"
                ? { case: kind, value: { sessionId: "ses_native" } }
                : kind === "resyncRequired"
                  ? { case: kind, value: { scope, sourceEpoch: "native-epoch" } }
                  : kind === "priority"
                    ? { case: kind, value: { mode: 1 } }
                    : kind === "failure"
                      ? { case: kind, value: { category: FailureCategory.MALFORMED } }
                      : { case: kind, value: {} },
      }),
    }
    const sender = kind === "priority" ? browser : agent
    await fixtureCommand(fixture, "hold", { kind, role: kind === "priority" ? "client" : "agent" })
    send(body, sender)
    const native = await until(async () => {
      const value = await dump(fixture)
      return value.held.length ? value : undefined
    }, `Native ${kind} callback was not held`)
    const charge = native.held[0]!.bytes
    const observed = await inspection(fixture)
    console.log(
      JSON.stringify({
        phase: "native-control-owner",
        kind,
        nativeReceiptBytes: charge,
        senderHandedBytes: sender.connection.ledger(LedgerClass.NORMAL).handedBytes,
        application: observed.budget,
        heap: observed.heap,
        nativePerSocketBacking: "unreported",
      }),
    )
    expect(
      sender.connection.ledger(LedgerClass.NORMAL).queuedBytes === 0 &&
        sender.connection.ledger(LedgerClass.NORMAL).handedBytes === charge,
      `${kind} send completion released outstanding charge`,
    )
    await notice(healthy)
    expect(sender.connection.ledger(LedgerClass.NORMAL).handedBytes === charge, `${kind} was refunded by another peer`)
    await fixtureCommand(fixture, "release", {})
    if (kind === "failure")
      expect(
        (await nativeClosed(sender, "ProtocolFailure terminal")).code === 1002,
        "ProtocolFailure did not dispose its native owner",
      )
    await sender.wait(() => sender.connection.ledger(LedgerClass.NORMAL).handedBytes === 0)
    await fixtureCommand(fixture, "dispose")
    expect((await inspection(fixture)).budget.used === 0, `${kind} disposal retained application reservations`)
    receipts.push(
      `TEST-034 native ${kind}: ${charge} handed bytes retained through stalled callback; independent recipient progressed; consumption/disposal released charge`,
    )
    agent.stop()
    browser.stop()
    healthy.stop()
  }

  const fixture = await device("stalled_delivery")
  const agent = peer(fixture, PeerRole.AGENT)
  await agent.ready
  const browser = peer(fixture, PeerRole.REMOTE_CLIENT)
  const healthy = peer(fixture, PeerRole.REMOTE_CLIENT)
  await Promise.all([browser.ready, healthy.ready])
  agent.autoConsume = false
  const requested = browser.request(
    "event.subscribe",
    scope,
    encodeStrict(event_subscribe_RequestSchema, create(event_subscribe_RequestSchema, { scope })),
  )
  const dispatch = await agent.next("dispatch")
  await agent.wait(() =>
    agent.raw.some((frame) => frame.body.case === "control" && frame.body.value.kind.case === "subscriptionSnapshot"),
  )
  const retained = await inspection(fixture)
  expect(
    retained.budget.peers.some(
      (entry) =>
        entry.role === "agent" &&
        entry.ledgers.some((ledger) => ledger.kind === LedgerClass.NORMAL && ledger.handed > 0),
    ),
    "Actual relay did not retain handed Request/SubscriptionSnapshot bytes",
  )
  await notice(healthy)
  expect(
    browser.connection.ledger(LedgerClass.NORMAL).handedBytes > 0,
    "Another recipient refunded the stalled forwarded request",
  )
  agent.autoConsume = true
  consumeReceived(agent, LedgerClass.NORMAL)
  send(
    {
      case: "control",
      value: create(ControlSchema, { kind: { case: "resyncRequired", value: { scope, sourceEpoch: "native-epoch" } } }),
    },
    agent,
  )
  agent.result(
    dispatch,
    encodeStrict(
      event_subscribe_ResultSchema,
      create(event_subscribe_ResultSchema, { subscriptionId: encodeLossless("stalled") }),
    ),
  )
  agent.connection.acceptSubscription(dispatch.requestID, "stalled", scope, performance.now(), "send", "native-epoch")
  expect(
    (await browser.next("settled", requested)).status === "success",
    "Stalled subscription failed after receipt release",
  )
  browser.connection.acceptSubscription(requested, "stalled", scope, performance.now(), "receive", "native-epoch")
  consumeReceived(browser, LedgerClass.NORMAL)
  await agent.wait(() => agent.connection.ledger(LedgerClass.NORMAL).handedBytes === 0)
  await subscribe(agent, healthy, "stalled", false)

  browser.autoConsume = false
  const id = browser.request("session.todo.list", scope, todo)
  const input = await agent.next("dispatch")
  agent.result(
    input,
    encodeStrict(session_todo_list_ResultSchema, create(session_todo_list_ResultSchema, { data: { items: [] } })),
  )
  expect((await browser.next("settled", id)).status === "success", "Inline result never reached native browser")
  const resultCharge = agent.connection.ledger(LedgerClass.NORMAL).handedBytes
  expect(
    resultCharge > 0 && agent.connection.ledger(LedgerClass.NORMAL).queuedBytes === 0,
    "Inline result was uncharged after send",
  )
  await notice(healthy)
  expect(
    agent.connection.ledger(LedgerClass.NORMAL).handedBytes === resultCharge,
    "Independent read refunded another browser's result",
  )
  for (const kind of ["zero", "over", "duplicate", "stale"] as const) {
    const forged = peer(fixture, PeerRole.REMOTE_CLIENT)
    await forged.ready
    await forged.wait(() =>
      forged.raw.some((frame) => frame.body.case === "control" && frame.body.value.kind.case === "pong"),
    )
    if (kind === "duplicate" || kind === "stale") {
      await notice(forged)
      if (kind === "stale") await notice(forged)
      await until(async () => {
        const actual = await inspection(fixture)
        const owned = actual.budget.peers.find((entry) => entry.epoch === forged.connection.connectionEpoch)
        return owned?.ledgers.find((ledger) => ledger.kind === LedgerClass.NORMAL)?.handed === 0 ? true : undefined
      }, "Actual native peer did not consume its legitimate prefix before forged re-credit")
    }
    const through =
      kind === "zero"
        ? 0n
        : kind === "over"
          ? 999n
          : forged.connection.ledger(LedgerClass.NORMAL).receivedOrdinal - (kind === "stale" ? 1n : 0n)
    forgedCredit(forged, LedgerClass.NORMAL, through)
    const rejection = await nativeClosed(forged, `forged credit ${through}`)
    expect(
      rejection.code === 1002,
      `Forged credit ${through} closed ${rejection.code} ${rejection.reason}, not established protocol rejection`,
    )
    expect(
      agent.connection.ledger(LedgerClass.NORMAL).handedBytes === resultCharge,
      "Forged credit refunded another recipient",
    )
  }
  consumeReceived(browser, LedgerClass.NORMAL)
  await agent.wait(() => agent.connection.ledger(LedgerClass.NORMAL).handedBytes === 0)
  browser.autoConsume = true

  const event = create(EventRecordSchema, {
    eventId: "evt_native_stall",
    createdMs: 1n,
    event: {
      typeName: PublicEventSchema.typeName,
      payload: encodeStrict(
        PublicEventSchema,
        create(PublicEventSchema, {
          kind: {
            case: "catalogUpdated",
            value: { id: encodeLossless("evt_native_stall"), created: 1, type: 1, data: {} },
          },
        }),
      ),
    },
  })
  agent.connection.enqueueEvent(
    event,
    { subscriptionID: "stalled", scope, sourceEpoch: "native-epoch" },
    performance.now(),
  )
  agent.flush()
  await browser.next("events")
  const eventCharge = agent.connection.ledger(LedgerClass.EVENT).handedBytes
  expect(eventCharge > 0, "Delivered event was not retained through recipient consumption")
  await notice(healthy)
  expect(agent.connection.ledger(LedgerClass.EVENT).handedBytes === eventCharge, "Independent read refunded an event")
  consumeReceived(browser, LedgerClass.EVENT)
  expect(
    agent.connection.ledger(LedgerClass.EVENT).handedBytes === eventCharge,
    "First event recipient refunded the second recipient",
  )
  await healthy.next("events")
  consumeReceived(healthy, LedgerClass.EVENT)
  await agent.wait(() => agent.connection.ledger(LedgerClass.EVENT).handedBytes === 0)
  await fixtureCommand(fixture, "hold", { kind: "streamEnd", role: "agent" })
  send({ case: "streamEnd", value: create(StreamEndSchema, { subscriptionId: "stalled" }) }, agent)
  await until(
    async () => ((await dump(fixture)).held.length ? true : undefined),
    "Native finite terminal did not reach its receipt barrier",
  )
  expect(agent.connection.ledger(LedgerClass.EVENT).handedBytes > 0, "Finite stream terminal lost its event charge")
  await notice(healthy)
  await fixtureCommand(fixture, "release", {})
  await browser.next("streamEnded")
  await healthy.next("streamEnded")
  await agent.wait(() => agent.connection.ledger(LedgerClass.EVENT).handedBytes === 0)

  const noticeID = browser.request("notice.subscribe", machine, encodeStrict(EmptySchema, create(EmptySchema)))
  expect((await browser.next("settled", noticeID)).status === "success", "Native notice subscription failed")
  browser.autoConsume = false
  send(
    {
      case: "control",
      value: create(ControlSchema, { kind: { case: "blocked", value: { sessionId: "ses_native_notice" } } }),
    },
    agent,
  )
  const beforeNotice = browser.raw.length
  await browser.wait(() =>
    browser.raw
      .slice(beforeNotice)
      .some((frame) => frame.body.case === "control" && frame.body.value.kind.case === "notice"),
  )
  expect(browser.connection.ledger(LedgerClass.NORMAL).receivedBytes > 0, "Native Notice delivery lost its charge")
  await notice(healthy)
  const noticeBudget = await inspection(fixture)
  expect(
    noticeBudget.budget.peers.some(
      (entry) =>
        entry.role === "client" &&
        entry.ledgers.some((ledger) => ledger.kind === LedgerClass.NORMAL && ledger.handed > 0),
    ),
    "Actual relay did not retain Notice handoff",
  )
  consumeReceived(browser, LedgerClass.NORMAL)
  browser.autoConsume = true

  const bulkID = browser.request("session.todo.list", scope, todo)
  const bulkInput = await agent.next("dispatch")
  const bytes = encodeStrict(
    session_todo_list_ResultSchema,
    create(session_todo_list_ResultSchema, { data: { items: [] } }),
  )
  const operation = operations.find((item) => item.diagnosticName === "session.todo.list")!
  for (const [kind, body, ledger] of [
    [
      "bulkStart",
      {
        case: "bulkStart",
        value: create(BulkStartSchema, {
          requestId: bulkInput.requestID,
          transferId: "native-bulk",
          operationId: operation.operationId,
          typeName: operation.resultType,
          contentKind: ContentKind.TYPED_MESSAGE,
          byteCount: BigInt(bytes.length),
          chunkCount: 1,
        }),
      },
      LedgerClass.NORMAL,
    ],
    [
      "bulkPiece",
      {
        case: "bulkPiece",
        value: create(BulkPieceSchema, { transferId: "native-bulk", index: 0, offset: 0n, data: bytes }),
      },
      LedgerClass.BULK,
    ],
    [
      "bulkEnd",
      {
        case: "bulkEnd",
        value: create(BulkEndSchema, {
          transferId: "native-bulk",
          byteCount: BigInt(bytes.length),
          outcome: { case: "success", value: {} },
        }),
      },
      LedgerClass.NORMAL,
    ],
  ] as const) {
    await agent.wait(() => agent.connection.ledger(ledger).handedBytes === 0)
    await fixtureCommand(fixture, "hold", { kind, role: "agent" })
    send(body, agent)
    const held = await until(async () => {
      const value = await dump(fixture)
      return value.held.length ? value : undefined
    }, `Native ${kind} did not reach the barrier`)
    const charge = held.held[0]!.bytes
    expect(
      agent.connection.ledger(ledger).queuedBytes === 0 && agent.connection.ledger(ledger).handedBytes === charge,
      `${kind} released its socket-handed charge`,
    )
    await notice(healthy)
    expect(agent.connection.ledger(ledger).handedBytes === charge, `${kind} charge crossed recipients`)
    await fixtureCommand(fixture, "release", {})
    await agent.wait(() => agent.connection.ledger(ledger).handedBytes === 0)
    expect(
      browser.connection.bulkRetainedBytes === bytes.length,
      `${kind} did not transfer into bounded endpoint assembly`,
    )
    const relay = await inspection(fixture)
    expect(
      relay.budget.peers.every((entry) => entry.reassembly === 0),
      "Actual workerd relay reassembled opaque bulk",
    )
  }
  expect((await browser.next("settled", bulkID)).status === "success", "Native typed bulk did not settle")
  const complete = await browser.next("bulkComplete")
  expect(
    complete.data.length === bytes.length && complete.data.every((byte, index) => byte === bytes[index]),
    "Native typed bulk changed its exact bytes",
  )
  browser.connection.releaseBulk(complete.transferID)
  expect(browser.connection.bulkRetainedBytes === 0, "Endpoint release retained completed bulk")
  receipts.push(
    "TEST-034 actual workerd Request, SubscriptionSnapshot, inline Result, Event, StreamEnd, Notice and typed BulkStart/Piece/End preserve charge or bounded assembly ownership; forged credit cannot refund another peer",
  )
  const measured = await inspection(fixture)
  console.log(
    JSON.stringify({
      phase: "workerd-allocation",
      nativeReceipt: (await dump(fixture)).received,
      application: measured.budget,
      heap: measured.heap,
    }),
  )
  agent.stop()
  browser.stop()
  healthy.stop()
  await until(
    async () => ((await dump(fixture)).identities.length === 0 ? true : undefined),
    "Native stalled peers did not detach",
  )
  expect((await inspection(fixture)).budget.used === 0, "Native stalled teardown retained application reservations")
}

async function nativeLimits() {
  for (const role of [PeerRole.REMOTE_CLIENT, PeerRole.AGENT] as const) {
    const fixture = await device(`native_limit_${role}`)
    const agent = peer(fixture, PeerRole.AGENT)
    await agent.ready
    const sender = role === PeerRole.AGENT ? agent : peer(fixture, role)
    await sender.ready
    const before = await inspection(fixture)
    const size = (role === PeerRole.AGENT ? WireLimit.SERVER_FRAME_BYTES : WireLimit.CLIENT_FRAME_BYTES) + 1
    sender.socket.send(new Uint8Array(size))
    const closed = await nativeClosed(sender, `application role ${role}`)
    expect(closed.code === 1002 && closed.reason === "LIMIT", "Application bound was not rejected at native receipt")
    const observed = await dump(fixture)
    expect(
      observed.received.some((entry) => entry.bytes === size && entry.kind === "overlimit"),
      "App-overlimit frame did not reach the native callback within the native cap",
    )
    const after = await inspection(fixture)
    expect(after.budget.used < before.budget.used, "App-overlimit rejection retained or added an application owner")
    console.log(
      JSON.stringify({
        phase: "native-app-bound",
        role,
        nativeReceiptBytes: size,
        applicationBefore: before.budget,
        applicationAfter: after.budget,
        heapBefore: before.heap,
        heapAfter: after.heap,
        nativeBackingStorage: after.heap.backingStorageSize ?? "unreported",
      }),
    )
    agent.stop()
  }
  const fixture = await device("native_cap")
  const agent = peer(fixture, PeerRole.AGENT)
  await agent.ready
  const browser = peer(fixture, PeerRole.REMOTE_CLIENT)
  await browser.ready
  browser.socket.send(new Uint8Array(RelayLimits.nativeReceiveBytes + 1))
  expect(
    (await nativeClosed(browser, "native cap")).code === 1009,
    "Native cap overflow was not a separate platform close",
  )
  expect(
    (await dump(fixture)).received.every((entry) => entry.bytes <= RelayLimits.nativeReceiveBytes),
    "Native-cap overflow reached application callback allocation",
  )
  receipts.push(
    "TEST-029/055 native 32-MiB overflow is separate from below-cap application rejection; actual application reservation and V8 heap/backing-store observations recorded without claiming zero native allocation",
  )
  agent.stop()
}

async function nativeHttpConsumers() {
  for (const mode of ["success", "cancel", "truncated"] as const) {
    const fixture = await device(`http_${mode}`)
    const agent = peer(fixture, PeerRole.AGENT)
    await agent.ready
    const browser = peer(fixture, PeerRole.REMOTE_CLIENT)
    const healthy = peer(fixture, PeerRole.REMOTE_CLIENT)
    await Promise.all([browser.ready, healthy.ready])
    const digest = "a".repeat(64)
    const bytes = new Uint8Array(WireLimit.BULK_WINDOW_BYTES + 1).fill(217)
    const operation = operations.find((entry) => entry.diagnosticName === "session.attachment.read")!
    const id = browser.request(
      operation.diagnosticName,
      scope,
      encodeStrict(
        session_attachment_read_RequestSchema,
        create(session_attachment_read_RequestSchema, {
          params: { sessionID: encodeLossless("ses_native"), digest: encodeLossless(digest) },
        }),
      ),
    )
    browser.connection.expectHttpBulk(id)
    const dispatch = await agent.next("dispatch")
    send(
      {
        case: "result",
        value: create(ResultSchema, {
          requestId: dispatch.requestID,
          operationId: operation.operationId,
          settlement: operation.settlement,
          outcome: {
            case: "assetMetadata",
            value: encodeAssetMetadata(
              session_attachment_read_ResultSchema,
              create(session_attachment_read_ResultSchema, {
                data: { mime: encodeLossless("image/png"), bytes: BigInt(bytes.length) },
              }),
            ),
          },
        }),
      },
      agent,
    )
    send(
      {
        case: "bulkStart",
        value: create(BulkStartSchema, {
          requestId: dispatch.requestID,
          transferId: "backend-http",
          operationId: operation.operationId,
          typeName: operation.resultType,
          contentKind: ContentKind.ASSET,
          byteCount: BigInt(bytes.length),
          chunkCount: Math.ceil(bytes.length / WireLimit.BULK_PIECE_BYTES),
        }),
      },
      agent,
    )
    const declaration = await browser.next("httpBulkStart")
    const url = `${origin}/api/remote/devices/${fixture.device}/sessions/ses_native/attachments/${digest}?${httpBulkQuery(browser.connection, declaration)}`
    const headers = { origin, cookie: `yc_session=${cookie}` }
    for (const target of [
      { url: url.replace("/ses_native/", "/ses_foreign/"), headers, status: 400 },
      { url: url.replace(declaration.start.transferId, "foreign_transfer"), headers, status: 409 },
      { url, headers: { ...headers, cookie: `yc_session=${otherCookie}` }, status: 403 },
    ]) {
      const response = await fetch(target.url, { headers: target.headers, signal: AbortSignal.timeout(10_000) })
      expect(response.status === target.status, `Native HTTP foreign scope/transfer/owner accepted: ${response.status}`)
    }
    const responseReady = fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
    for (let index = 0; index < Math.ceil(bytes.length / WireLimit.BULK_PIECE_BYTES); index++)
      send(
        {
          case: "bulkPiece",
          value: create(BulkPieceSchema, {
            transferId: "backend-http",
            index,
            offset: BigInt(index * WireLimit.BULK_PIECE_BYTES),
            data: bytes.slice(index * WireLimit.BULK_PIECE_BYTES, (index + 1) * WireLimit.BULK_PIECE_BYTES),
          }),
        },
        agent,
      )
    const response = await responseReady
    expect(response.status === 200, "Native HTTP declaration did not bind to its owning socket")
    expect(
      agent.connection.ledger(LedgerClass.BULK).queuedBytes > 0 &&
        agent.connection.ledger(LedgerClass.BULK).handedBytes > 0,
      "Unread native HTTP body did not retain and backpressure its producer",
    )
    const stalled = await until(async () => {
      const actual = await inspection(fixture)
      return actual.budget.peers.some((entry) => entry.http > 0) ? actual : undefined
    }, "Actual workerd HTTP handoff had no bounded owner")
    expect(
      stalled.budget.peers.every((entry) => entry.reassembly === 0 && entry.http <= WireLimit.BULK_WINDOW_BYTES),
      "Native relay HTTP reassembled opaque data or exceeded its shared window",
    )
    const charge = agent.connection.ledger(LedgerClass.BULK).handedBytes
    await notice(healthy)
    expect(
      agent.connection.ledger(LedgerClass.BULK).handedBytes === charge,
      "Healthy HTTP-independent recipient refunded a stalled body",
    )
    const stranger = peer(fixture, PeerRole.REMOTE_CLIENT)
    await stranger.ready
    await stranger.wait(() =>
      stranger.raw.some((frame) => frame.body.case === "control" && frame.body.value.kind.case === "pong"),
    )
    forgedCredit(stranger, LedgerClass.BULK, 1n, declaration.start.transferId)
    expect(
      (await nativeClosed(stranger, "foreign HTTP credit")).code === 1002,
      "A foreign connection credited another HTTP transfer",
    )
    expect(
      agent.connection.ledger(LedgerClass.BULK).handedBytes === charge,
      "Foreign transfer Credit released the stalled producer",
    )
    const applied: Decision[] = []
    const abort = new AbortController()
    if (mode === "cancel") abort.abort(new Error("Synthetic native consumer cancellation"))
    const reading = readHttpBulk(browser.connection, declaration, response, {
      now: () => performance.now(),
      signal: abort.signal,
      apply(entries) {
        applied.push(...entries)
        browser.flush()
      },
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    if (mode === "success") {
      await agent.wait(() => agent.connection.ledger(LedgerClass.BULK).queuedBytes === 0)
      send(
        {
          case: "bulkEnd",
          value: create(BulkEndSchema, {
            transferId: "backend-http",
            byteCount: BigInt(bytes.length),
            outcome: { case: "success", value: {} },
          }),
        },
        agent,
      )
    }
    if (mode === "truncated") agent.stop()
    const outcome = await reading
    expect(
      outcome.ok === (mode === "success"),
      "Native HTTP cancellation/truncation/EOF outcome disagreed with its terminal",
    )
    if (mode === "success") {
      expect(
        outcome.ok && outcome.value.bytes === BigInt(bytes.length),
        "Native HTTP reader changed exact declared byte count",
      )
      const complete = await until(
        () =>
          [...applied, ...browser.queue.map((entry) => entry.decision)].find((entry) => entry.type === "bulkComplete"),
        "Native HTTP EOF did not produce a completed asset",
      )
      expect(
        complete.data.length === bytes.length && complete.data.every((byte, index) => byte === bytes[index]),
        "Native HTTP bytes changed",
      )
      browser.connection.releaseBulk(complete.transferID)
    }
    if (mode === "cancel") {
      await agent.next("cancelled", dispatch.requestID)
      await agent.wait(() => agent.connection.ledger(LedgerClass.BULK).handedBytes === 0)
      expect(
        agent.connection.ledger(LedgerClass.BULK).queuedBytes === 0,
        "Cancelled native HTTP producer retained queued pieces",
      )
      expect(
        agent.raw.filter((frame) => frame.body.case === "control" && frame.body.value.kind.case === "cancel").length ===
          1,
        "Native body and socket cancellation duplicated the backend effect",
      )
    }
    if (mode !== "success")
      expect(
        ![...applied, ...browser.queue.map((entry) => entry.decision)].some(
          (entry) =>
            entry.type === "bulkComplete" ||
            (entry.type === "settled" && entry.requestID === id && entry.status === "success"),
        ),
        "Native failed HTTP read published successful settlement",
      )
    expect(browser.connection.bulkRetainedBytes === 0, "Native HTTP endpoint retained released/cancelled assembly")
    for (const actor of [agent, browser, healthy]) actor.stop()
    await until(
      async () => ((await dump(fixture)).identities.length === 0 ? true : undefined),
      "Native HTTP peers did not detach",
    )
    expect((await inspection(fixture)).budget.used === 0, "Native HTTP teardown retained application reservations")
    receipts.push(
      `TEST-026/034 actual native HTTP ${mode}: foreign ownership rejected, stalled producer stays charged, healthy peer progresses, bounded raw handoff and terminal/teardown release verified`,
    )
  }
}

async function authorityMatrix() {
  const fixture = await device("ingress_authority")
  const expired = randomToken()
  const revoked = randomToken()
  const expiredAccess = randomToken()
  const revokedAccess = randomToken()
  const refresh = randomToken()
  for (const [token, expires, revokedAt] of [
    [expired, Date.now() - 1, null],
    [revoked, Date.now() + 60_000, Date.now()],
  ] as const)
    await sql("INSERT INTO browser_session (id,user_id,created_at,expires_at,revoked_at) VALUES (?,?,?,?,?)", [
      await sha256Hex(token),
      owner,
      Date.now() - 1000,
      expires,
      revokedAt,
    ])
  for (const [token, kind, expires, revokedAt] of [
    [expiredAccess, "access", Date.now() - 1, null],
    [revokedAccess, "access", Date.now() + 60_000, Date.now()],
    [refresh, "refresh", Date.now() + 60_000, null],
  ] as const)
    await sql(
      "INSERT INTO device_credential (id,device_id,kind,created_at,expires_at,revoked_at) VALUES (?,?,?,?,?,?)",
      [await sha256Hex(token), fixture.device, kind, Date.now() - 1000, expires, revokedAt],
    )
  const clientURL = `${origin}/ws/v5/client?device=${fixture.device}`
  const clientHeaders = { upgrade: "websocket", origin, cookie: `yc_session=${cookie}` }
  const cases: { name: string; url: string; headers: Record<string, string>; status: number }[] = [
    { name: "missing cookie", url: clientURL, headers: { upgrade: "websocket", origin }, status: 401 },
    {
      name: "bad cookie",
      url: clientURL,
      headers: { ...clientHeaders, cookie: "yc_session=synthetic-invalid" },
      status: 401,
    },
    {
      name: "expired cookie",
      url: clientURL,
      headers: { ...clientHeaders, cookie: `yc_session=${expired}` },
      status: 401,
    },
    {
      name: "revoked cookie",
      url: clientURL,
      headers: { ...clientHeaders, cookie: `yc_session=${revoked}` },
      status: 401,
    },
    {
      name: "wrong owner",
      url: clientURL,
      headers: { ...clientHeaders, cookie: `yc_session=${otherCookie}` },
      status: 403,
    },
    {
      name: "forged owner and role",
      url: clientURL,
      headers: {
        ...clientHeaders,
        cookie: `yc_session=${otherCookie}`,
        "x-ycoding-role": "agent",
        "x-ycoding-owner": owner,
        "x-ycoding-device": fixture.device,
      },
      status: 403,
    },
    {
      name: "cross origin",
      url: clientURL,
      headers: { ...clientHeaders, origin: "https://foreign.example.invalid" },
      status: 403,
    },
    {
      name: "missing origin",
      url: clientURL,
      headers: { upgrade: "websocket", cookie: `yc_session=${cookie}` },
      status: 403,
    },
    { name: "unknown device", url: `${origin}/ws/v5/client?device=dev_missing`, headers: clientHeaders, status: 404 },
    ...[undefined, "synthetic-invalid", expiredAccess, revokedAccess, refresh].map((token, index) => ({
      name: `agent credential ${index}`,
      url: `${origin}/ws/v5/agent`,
      headers: { upgrade: "websocket", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      status: 401,
    })),
  ]
  for (const entry of cases) {
    const response = await fetch(entry.url, { headers: entry.headers, signal: AbortSignal.timeout(10_000) })
    expect(response.status === entry.status, `${entry.name}: expected ${entry.status}, received ${response.status}`)
  }
  const backend = peer(fixture, PeerRole.AGENT)
  await backend.ready
  const forged = new TestPeer(
    clientURL.replace("http", "ws"),
    {
      cookie: `yc_session=${cookie}`,
      origin,
      "x-ycoding-role": "agent",
      "x-ycoding-owner": "usr_wire_other",
      "x-ycoding-device": "dev_wrong",
      "x-ycoding-browser-session": "bs_forged",
      "x-ycoding-credential-expires-at": "9999999999999",
      "x-ycoding-directory": "/not-a-backend-location",
    },
    PeerRole.REMOTE_CLIENT,
  )
  peers.push(forged)
  await forged.ready
  const verifiedBrowserID = await sha256Hex(cookie)
  expect(
    (await dump(fixture)).identities.some(
      (identity) =>
        identity.role === "client" &&
        identity.ownerID === owner &&
        identity.deviceID === fixture.device &&
        identity.browserSessionID === verifiedBrowserID,
    ),
    "Browser headers replaced verified attachment authority",
  )
  await notice(forged)
  const id = forged.request("session.todo.list", scope, todo)
  const input = await backend.next("dispatch")
  expect(
    input.request.scope?.target.case === "session" && input.request.scope.target.value === "ses_native",
    "Untrusted routing headers changed protected scope",
  )
  backend.result(
    input,
    encodeStrict(session_todo_list_ResultSchema, create(session_todo_list_ResultSchema, { data: { items: [] } })),
  )
  expect(
    (await forged.next("settled", id)).status === "success",
    "Untrusted headers redirected an authorized owner away from its device",
  )
  forged.stop()
  backend.stop()

  const foreignAgent = await device("forged_agent")
  await sql("UPDATE device SET user_id=? WHERE id=?", ["usr_wire_other", foreignAgent.device])
  const isolated = new TestPeer(
    `${origin.replace("http", "ws")}/ws/v5/agent`,
    {
      authorization: `Bearer ${foreignAgent.access}`,
      "x-ycoding-role": "client",
      "x-ycoding-owner": owner,
      "x-ycoding-device": fixture.device,
      "x-ycoding-browser-session": "bs_forged",
      "x-ycoding-credential-expires-at": "9999999999999",
    },
    PeerRole.AGENT,
  )
  peers.push(isolated)
  await isolated.ready
  const actual = await dump({ ...foreignAgent, name: `usr_wire_other:${foreignAgent.device}` })
  expect(
    actual.identities.some(
      (identity) =>
        identity.role === "agent" &&
        identity.ownerID === "usr_wire_other" &&
        identity.deviceID === foreignAgent.device &&
        identity.browserSessionID === foreignAgent.device,
    ),
    "Forged agent headers replaced the credential's verified owner or device",
  )
  expect(
    (await dump(fixture)).identities.every(
      (identity) => identity.role !== "agent" || identity.deviceID === fixture.device,
    ),
    "Foreign agent credential widened into another device relay",
  )
  isolated.stop()

  for (const state of ["revoked", "deleted"] as const) {
    const denied = await device(`agent_device_${state}`)
    if (state === "revoked") await sql("UPDATE device SET revoked_at=? WHERE id=?", [Date.now(), denied.device])
    if (state === "deleted") await sql("DELETE FROM device WHERE id=?", [denied.device])
    const response = await fetch(`${origin}/ws/v5/agent`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${denied.access}` },
      signal: AbortSignal.timeout(10_000),
    })
    expect(response.status === 401, `A ${state} device retained agent upgrade authority`)
  }

  for (const boundary of ["request", "result"] as const)
    for (const change of [
      "browser-revoked",
      "browser-expired",
      "device-revoked",
      "device-deleted",
      "owner-changed",
      ...(boundary === "result" ? (["agent-expired"] as const) : []),
    ] as const) {
      const held = await device(
        `fresh_${boundary}_${change.replaceAll("-", "_")}`,
        Date.now() + (change === "agent-expired" ? 3000 : 600_000),
      )
      const browserCookie = randomToken()
      const browserID = await sha256Hex(browserCookie)
      await sql("INSERT INTO browser_session (id,user_id,created_at,expires_at) VALUES (?,?,?,?)", [
        browserID,
        owner,
        Date.now(),
        Date.now() + 600_000,
      ])
      const agent = peer(held, PeerRole.AGENT)
      await agent.ready
      const browser = peer(held, PeerRole.REMOTE_CLIENT, browserCookie)
      await browser.ready
      await fixtureCommand(held, "hold", { kind: boundary, role: boundary === "request" ? "client" : "agent" })
      const requestID = browser.request("session.todo.list", scope, todo)
      if (boundary === "result") {
        const input = await agent.next("dispatch")
        agent.result(
          input,
          encodeStrict(session_todo_list_ResultSchema, create(session_todo_list_ResultSchema, { data: { items: [] } })),
        )
      }
      await until(
        async () => ((await dump(held)).held.length ? true : undefined),
        `${change} did not reach native delivery barrier`,
      )
      if (change === "browser-revoked")
        await sql("UPDATE browser_session SET revoked_at=? WHERE id=?", [Date.now(), browserID])
      if (change === "browser-expired")
        await sql("UPDATE browser_session SET expires_at=? WHERE id=?", [Date.now() - 1, browserID])
      if (change === "device-revoked") await sql("UPDATE device SET revoked_at=? WHERE id=?", [Date.now(), held.device])
      if (change === "device-deleted") await sql("DELETE FROM device WHERE id=?", [held.device])
      if (change === "owner-changed")
        await sql("UPDATE device SET user_id=? WHERE id=?", ["usr_wire_other", held.device])
      if (change === "agent-expired")
        expect(
          (await nativeClosed(agent, "held Result credential expiry")).code === 4401,
          "Expired agent credential retained native delivery authority",
        )
      await fixtureCommand(held, "release", {})
      const rejection = await nativeClosed(browser, `${boundary}:${change}`)
      if (boundary === "request")
        expect(
          rejection.code === (change.startsWith("browser") ? 4401 : 4403) &&
            !agent.queue.some((entry) => entry.decision.type === "dispatch"),
          `${change} reached protected backend or lost its authority close code`,
        )
      const settled = await browser.next("settled", requestID)
      expect(settled.status === "unknown", `${boundary}:${change} delivered protected success after authority loss`)
      expect(
        !browser.raw.some(
          (frame) =>
            frame.body.case === "result" &&
            frame.body.value.requestId === requestID &&
            frame.body.value.outcome.case === "success",
        ),
        `${boundary}:${change} exposed protected result bytes`,
      )
      agent.stop()
    }
  receipts.push(
    "TEST-031 actual D1 missing/bad/expired/revoked credentials, wrong owner, origin and forged routing matrix; held native requests and Results recheck browser/device/owner authority before dispatch or delivery",
  )
}

async function d1Rollback() {
  const current = "bs_wire_rotation_before"
  const next = { id: "bs_wire_rotation_after", userID: owner, createdAt: Date.now(), expiresAt: Date.now() + 600_000 }
  await sql("INSERT INTO browser_session (id,user_id,created_at,expires_at) VALUES (?,?,?,?)", [
    current,
    owner,
    next.createdAt - 1,
    next.expiresAt,
  ])
  await sql(
    "INSERT INTO push_subscription (endpoint,account_id,browser_session_id,p256dh,auth,created_at,agent_completed,approval_requested,machine_offline) VALUES (?,?,?,?,?,?,0,0,0)",
    ["https://fcm.googleapis.com/fcm/send/wire-rotation", owner, current, "synthetic", "synthetic", next.createdAt],
  )
  await sql(
    "CREATE TRIGGER wire_reject_rotation BEFORE UPDATE OF browser_session_id ON push_subscription BEGIN SELECT RAISE(ABORT, 'wire D1 rollback'); END",
  )
  const rotate = () =>
    fetch(`${origin}/_wire/rotate`, {
      method: "POST",
      body: JSON.stringify({ current, next, now: next.createdAt }),
      signal: AbortSignal.timeout(10_000),
    })
  const failed = await rotate()
  expect(
    failed.status === 500 && (await failed.text()).includes("wire D1 rollback"),
    "Actual D1 batch did not reach its injected storage fault",
  )
  const before = (await sql("SELECT id,revoked_at FROM browser_session WHERE id IN (?,?) ORDER BY id", [
    current,
    next.id,
  ])) as { results: { id: string; revoked_at: number | null }[] }
  expect(
    before.results.length === 1 && before.results[0]?.id === current && before.results[0].revoked_at === null,
    "Actual D1 rollback inserted a successor or revoked its predecessor",
  )
  const ownership = (await sql("SELECT browser_session_id FROM push_subscription WHERE browser_session_id IN (?,?)", [
    current,
    next.id,
  ])) as { results: { browser_session_id: string }[] }
  expect(
    ownership.results.length === 1 && ownership.results[0]?.browser_session_id === current,
    "Actual D1 rollback changed push ownership",
  )
  await sql("DROP TRIGGER wire_reject_rotation")
  const retried = await rotate()
  expect(
    retried.ok && ((await retried.json()) as { rotated: boolean }).rotated,
    "Actual D1 valid rotation retry failed",
  )
  const duplicate = await rotate()
  expect(
    duplicate.ok && !((await duplicate.json()) as { rotated: boolean }).rotated,
    "Actual D1 repeated rotation was admitted twice",
  )
  const after = (await sql("SELECT id,revoked_at FROM browser_session WHERE id IN (?,?) ORDER BY id", [
    current,
    next.id,
  ])) as { results: { id: string; revoked_at: number | null }[] }
  expect(
    after.results.length === 2 &&
      after.results.some((row) => row.id === current && row.revoked_at === next.createdAt) &&
      after.results.some((row) => row.id === next.id && row.revoked_at === null),
    "Actual D1 rotation did not atomically switch authority",
  )
  const transferred = (await sql("SELECT browser_session_id FROM push_subscription WHERE browser_session_id IN (?,?)", [
    current,
    next.id,
  ])) as { results: { browser_session_id: string }[] }
  expect(
    transferred.results.length === 1 && transferred.results[0]?.browser_session_id === next.id,
    "Actual D1 retry did not transfer push ownership once",
  )
  receipts.push(
    "TEST-035 actual workerd D1 production rotation batch rolls back successor, predecessor and push ownership together, then admits exactly one retry",
  )
}

try {
  for (const file of [
    "0001_auth.sql",
    "0002_push.sql",
    "0003_invite.sql",
    "0004_push_categories.sql",
    "0005_push_browser_owner.sql",
  ])
    await control("/migrate", { query: await Bun.file(path.join(root, "infra/cloudflare/migrations", file)).text() })
  const now = Date.now()
  for (const id of [owner, "usr_wire_other"]) await sql('INSERT INTO "user" VALUES (?,?)', [id, now])
  for (const [token, user] of [
    [cookie, owner],
    [otherCookie, "usr_wire_other"],
  ])
    await sql("INSERT INTO browser_session (id,user_id,created_at,expires_at) VALUES (?,?,?,?)", [
      await sha256Hex(token!),
      user!,
      now,
      now + 600_000,
    ])
  if (enabled("storage")) {
    const fixture = await device("storage")
    const agent = peer(fixture, PeerRole.AGENT)
    await agent.ready
    const browser = peer(fixture, PeerRole.REMOTE_CLIENT)
    await browser.ready
    const receiveKey = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
    const registration = await fetch(`${origin}/api/push/subscriptions`, {
      method: "POST",
      headers: { cookie: `yc_session=${cookie}`, origin, "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: "https://fcm.googleapis.com/fcm/send/wire-native",
        keys: {
          p256dh: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", receiveKey.publicKey))),
          auth: randomToken(16),
        },
        categories: { "agent-completed": true, "approval-requested": false, "machine-offline": false },
      }),
    })
    expect(registration.ok, "Native push registration failed")
    send(completion(1n), agent)
    await until(
      async () =>
        (await dump(fixture)).kv.some(([key, value]) => key === "completion:ses_native" && value === 1)
          ? true
          : undefined,
      "Initial completion cursor missing",
    )
    expect(
      pushes.length === 0 && (await dump(fixture)).notices.length === 0,
      "Initial completion baseline was not silent",
    )
    await control("/do", {
      name: fixture.name,
      query:
        "CREATE TRIGGER wire_reject_notice BEFORE INSERT ON notice BEGIN SELECT RAISE(ABORT, 'wire native rollback'); END",
    })
    send(completion(2n), agent)
    await until(
      async () => ((await notice(browser)).unavailable ? true : undefined),
      "Native rollback was not reported unavailable",
    )
    const rolledBack = await dump(fixture)
    expect(
      rolledBack.kv.some(([key, value]) => key === "completion:ses_native" && value === 1),
      "Native rollback advanced completion cursor",
    )
    expect(rolledBack.notices.length === 0 && pushes.length === 0, "Native rollback leaked notice or push")
    await control("/do", { name: fixture.name, query: "DROP TRIGGER wire_reject_notice" })
    const unresolved = browser.request("session.todo.list", scope, todo)
    await agent.next("dispatch")
    const generation = rolledBack.generation
    await control("/evict", { name: fixture.name })
    const restored = await dump(fixture)
    expect(restored.generation !== generation, "Native eviction did not reconstruct the Durable Object")
    expect(
      (await agent.closed).code === 1012 && (await browser.closed).code === 1012,
      "Restored sockets were not epoch-fenced",
    )
    expect(
      (await browser.next("settled", unresolved)).status === "unknown",
      "Hibernation replayed or rejected sent unresolved work",
    )
    expect(
      restored.kv.some(([key, value]) => key === "completion:ses_native" && value === 1),
      "Hibernation lost durable high-water",
    )
    const successor = peer(fixture, PeerRole.AGENT)
    await successor.ready
    const reconnected = peer(fixture, PeerRole.REMOTE_CLIENT)
    await reconnected.ready
    await notice(reconnected)
    expect(
      !successor.queue.some((entry) => entry.decision.type === "dispatch"),
      "Hibernation replayed a predecessor request to its successor",
    )
    expect(
      successor.connection.connectionEpoch !== agent.connection.connectionEpoch,
      "Successor reused its predecessor epoch",
    )
    send(completion(2n), successor)
    await until(
      async () => ((await dump(fixture)).notices.length === 1 && pushes.length === 1 ? true : undefined),
      "Retried native completion did not notify once",
    )
    send(completion(2n), successor)
    await notice(reconnected)
    const accepted = await dump(fixture)
    expect(
      accepted.notices.length === 1 &&
        pushes.slice().length === 1 &&
        accepted.kv.some(([key, value]) => key === "completion:ses_native" && value === 2),
      "Native completion retry duplicated its cursor, notice or push",
    )
    await control("/evict", { name: fixture.name })
    const persisted = await dump(fixture)
    expect(
      persisted.generation !== accepted.generation &&
        JSON.stringify(persisted.notices) === JSON.stringify(accepted.notices) &&
        persisted.kv.some(([key, value]) => key === "completion:ses_native" && value === 2) &&
        pushes.slice().length === 1,
      "Native hibernation changed committed notice/cursor state or emitted another push",
    )
    receipts.push("TEST-035 actual DO SQLite/KV transaction rollback and reconstructed exactly-once completion/push")
    receipts.push(
      "TEST-032 actual native hibernation reconstruction retains durable state and fences attached socket epochs",
    )
  }

  if (enabled("predecessor")) {
    const late = await device("late", Date.now() + 3000)
    const predecessor = peer(late, PeerRole.AGENT)
    await predecessor.ready
    await fixtureCommand(late, "hold", { close: true })
    const ended = await nativeClosed(predecessor, "expired predecessor")
    expect(ended.code === 4401, "Expired native credential did not remove predecessor")
    await until(
      async () => ((await dump(late)).pendingClose === 1 ? true : undefined),
      "Native predecessor close callback was not held",
    )
    const fresh = randomToken()
    await sql("INSERT INTO device_credential (id,device_id,kind,created_at,expires_at) VALUES (?,?, 'access',?,?)", [
      await sha256Hex(fresh),
      late.device,
      Date.now(),
      Date.now() + 120_000,
    ])
    const replacement = peer(late, PeerRole.AGENT, fresh)
    await replacement.ready
    const nextClient = peer(late, PeerRole.REMOTE_CLIENT)
    await nextClient.ready
    await subscribe(replacement, nextClient, "late-successor")
    const before = (await dump(late)).closedCallbacks
    await fixtureCommand(late, "release", {})
    await until(
      async () => ((await dump(late)).closedCallbacks > before ? true : undefined),
      "Held native close callback did not complete",
    )
    const id = nextClient.request("session.todo.list", scope, todo)
    const dispatch = await replacement.next("dispatch")
    replacement.result(
      dispatch,
      encodeStrict(session_todo_list_ResultSchema, create(session_todo_list_ResultSchema, { data: { items: [] } })),
    )
    expect(
      (await nextClient.next("settled", id)).status === "success",
      "Late predecessor close removed successor authority/correlation",
    )
    send({ case: "streamEnd", value: create(StreamEndSchema, { subscriptionId: "late-successor" }) }, replacement)
    expect(
      (await nextClient.next("streamEnded")).subscriptionID === "late-successor",
      "Late predecessor close removed successor subscription interest",
    )
    receipts.push("TEST-032 expired predecessor native callback cannot remove the already-established successor")
  }

  if (enabled("stall")) await stallReceipts()
  if (enabled("http")) await nativeHttpConsumers()
  if (enabled("limits")) await nativeLimits()
  if (enabled("authority")) await authorityMatrix()
  if (enabled("d1")) await d1Rollback()

  if (enabled("authority")) {
    const denied = await device("authority")
    const backend = peer(denied, PeerRole.AGENT)
    await backend.ready
    const client = peer(denied, PeerRole.REMOTE_CLIENT)
    await client.ready
    await fixtureCommand(denied, "hold", { kind: "request", role: "client" })
    client.request("session.todo.list", scope, todo)
    const held = await until(async () => {
      const value = await dump(denied)
      return value.held.length ? value : undefined
    }, "Authority request did not reach native receipt barrier")
    expect(held.held[0]!.bytes > 0, "Native request receipt was empty")
    expect(
      client.connection.ledger(LedgerClass.NORMAL).queuedBytes === 0 &&
        client.connection.ledger(LedgerClass.NORMAL).handedBytes === held.held[0]!.bytes,
      "Socket handoff released request charge before native consumption",
    )
    await sql("UPDATE browser_session SET revoked_at=? WHERE id=?", [Date.now(), await sha256Hex(cookie)])
    await fixtureCommand(denied, "release", {})
    expect(
      (await nativeClosed(client, "revoked held request")).code === 4401,
      "Fresh D1 authority did not reject revoked browser before dispatch",
    )
    expect(
      !backend.queue.some((entry) => entry.decision.type === "dispatch"),
      "Revoked held browser request reached protected backend",
    )
    receipts.push(
      "TEST-031/034 native request handoff retains its exact charge; fresh D1 revocation rejects before backend dispatch",
    )
  }
  console.log(JSON.stringify({ phase: "native-evidence", scratch, inspector: ready.inspector, pushes: pushes.length }))
} finally {
  for (const receipt of receipts) console.log(`ok - ${receipt}`)
  for (const peer of peers) peer.stop()
  child.stdin.end()
  const exited = await child.exited
  clearTimeout(deadline)
  await drain
  receiver.stop(true)
  expect(exited === 0, `Native tooling driver failed (${exited}); ${scratch}`)
}
