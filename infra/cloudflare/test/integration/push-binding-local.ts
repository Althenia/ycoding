import { spawn } from "bun"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { RemoteWebSocketPath } from "../../../../packages/remote/src/index"
import { TestPeer } from "../../../../packages/remote/test/peer"
import {
  create,
  encodeStrict,
  ControlSchema,
  ScopeSchema,
  EmptySchema,
  PeerRole,
} from "../../../../packages/protocol/src/v5"
import { generateVapidKeys } from "../../script/vapid-keys"
import { base64UrlEncode, sha256Hex } from "../../src/auth/crypto"

const root = new URL("../../../../", import.meta.url).pathname
const wrangler = `${root}node_modules/.bin/wrangler`
let config = "infra/cloudflare/wrangler.jsonc"
const port = 47000 + Math.floor(Math.random() * 1000)
const origin = `http://127.0.0.1:${port}`
const accountID = "usr_binding_local"
const deviceID = "dev_binding_local"
const accessToken = "push-binding-local-access-token"
const browsers = { laptop: "push-binding-laptop-cookie", phone: "push-binding-phone-cookie" } as const
const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/admin-local-${name}`
let worker: { kill: () => unknown; exited: Promise<number> } | undefined
let home: string | undefined
let pushStub: { port: number | undefined; stop: (closeActive?: boolean) => unknown } | undefined
const sockets: TestPeer[] = []

try {
  home = await mkdtemp(join(root, "infra/cloudflare/.push-binding-"))
  const persist = join(home, "wrangler")
  const original = await Bun.file(join(root, config)).json()
  await mkdir(join(home, "assets"))
  await Bun.write(join(home, "assets/index.html"), "<!doctype html><title>Local push fixture</title>")
  config = join(home, "wrangler.json")
  await Bun.write(
    config,
    JSON.stringify({
      ...original,
      main: join(root, "infra/cloudflare/test/integration/push-stub-worker.ts"),
      routes: [],
      assets: { ...original.assets, directory: join(home, "assets") },
      d1_databases: original.d1_databases.map(
        (database: { binding: string; database_name: string; database_id: string }) => ({
          ...database,
          migrations_dir: join(root, "infra/cloudflare/migrations"),
        }),
      ),
    }),
  )
  const vapid = await generateVapidKeys()
  const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  const keys = {
    p256dh: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", receiver.publicKey))),
    auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
  }
  const delivered: string[] = []
  const settled = new Set<string>()
  const answers = new Map<string, number>()
  pushStub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname === "/relay-settled") {
        const value = (await request.json()) as { attention: string[] }
        settled.add(JSON.stringify(value.attention))
        return new Response(null, { status: 204 })
      }
      const target = new URL(request.url).pathname.replace("/push/", "")
      await request.arrayBuffer()
      delivered.push(target)
      const status = answers.get(target) ?? 201
      if (status === 0) return new Promise<Response>(() => {})
      return new Response(null, { status })
    },
  })
  await run(["d1", "migrations", "apply", "ycoding-prod-db", "--local", "--config", config, "--persist-to", persist])
  const now = Date.now()
  const deviceKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const jwk = await crypto.subtle.exportKey("jwk", deviceKey.publicKey)
  const publicKey = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y })
  await run([
    "d1",
    "execute",
    "ycoding-prod-db",
    "--local",
    "--config",
    config,
    "--persist-to",
    persist,
    "--command",
    [
      `INSERT INTO "user" (id, created_at) VALUES ('${accountID}', ${now});`,
      ...(await Promise.all(
        Object.values(browsers).map(
          async (cookie) =>
            `INSERT INTO browser_session (id, user_id, created_at, expires_at) VALUES ('${await sha256Hex(cookie)}', '${accountID}', ${now}, ${now + 600_000});`,
        ),
      )),
      `INSERT INTO device (id, user_id, name, public_key_jwk, key_algorithm, created_at) VALUES ('${deviceID}', '${accountID}', 'Binding machine', '${publicKey}', 'ES256', ${now});`,
      `INSERT INTO device_credential (id, device_id, kind, created_at, expires_at) VALUES ('${await sha256Hex(accessToken)}', '${deviceID}', 'access', ${now}, ${now + 600_000});`,
    ].join("\n"),
  ])
  expect(
    !(await fetch(`${origin}/health`).then(
      () => true,
      () => false,
    )),
    "Chosen port already serves another process",
  )
  const start = async () => {
    worker = spawn(
      [
        wrangler,
        "dev",
        "--local",
        "--config",
        config,
        "--persist-to",
        persist,
        "--port",
        String(port),
        "--define",
        `PUSH_STUB_PORT:${pushStub?.port}`,
        "--var",
        `VAPID_PUBLIC_KEY:${vapid.VAPID_PUBLIC_KEY}`,
        "--var",
        `VAPID_PRIVATE_KEY:${vapid.VAPID_PRIVATE_KEY}`,
        "--var",
        "VAPID_SUBJECT:mailto:local-test@example.invalid",
      ],
      { cwd: root, stdout: "ignore", stderr: "ignore" },
    )
    let ready = false
    for (let attempt = 0; attempt < 150 && !ready; attempt += 1) {
      ready = await fetch(`${origin}/health`).then(
        (response) => response.status === 200,
        () => false,
      )
      if (!ready) await Bun.sleep(100)
    }
    expect(ready, "Local workerd did not start")
  }
  await start()

  const register = async (cookie: string, body: unknown) =>
    (
      await fetch(`${origin}/api/push/subscriptions`, {
        method: "POST",
        headers: { cookie: `yc_session=${cookie}`, origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).status
  const categories = { "agent-completed": true, "approval-requested": true, "machine-offline": true }
  expect(
    (await register(browsers.laptop, { endpoint: endpoint("laptop"), keys, categories })) === 200,
    "The laptop subscription was not registered",
  )
  expect(
    (await register(browsers.phone, { endpoint: endpoint("phone"), keys, categories })) === 200,
    "The phone subscription was not registered",
  )

  const open = async (attentive: readonly string[]) => {
    const agent = await connect(`ws://127.0.0.1:${port}${RemoteWebSocketPath.agent}`, {
      authorization: `Bearer ${accessToken}`,
    })
    const tabs = {
      laptop: [await tab(browsers.laptop), await tab(browsers.laptop)],
      phone: [await tab(browsers.phone)],
    }
    agent.send({
      case: "control",
      value: create(ControlSchema, { kind: { case: "status", value: { running: [], attention: [...attentive] } } }),
    })
    await tabs.phone[0].wait(() =>
      tabs.phone[0].raw.some((frame) => frame.body.case === "control" && frame.body.value.kind.case === "status"),
    )
    return { agent, tabs }
  }
  const tab = async (cookie: string) => {
    const socket = await connect(`ws://127.0.0.1:${port}${RemoteWebSocketPath.client}?device=${deviceID}`, {
      cookie: `yc_session=${cookie}`,
      origin,
    })
    const id = socket.request(
      "notice.subscribe",
      create(ScopeSchema, { target: { case: "machine", value: {} } }),
      encodeStrict(EmptySchema, create(EmptySchema)),
    )
    await socket.next("settled", id)
    return socket
  }
  const presented = (socket: TestPeer) =>
    socket.raw.flatMap((frame) =>
      frame.body.case === "control" &&
      frame.body.value.kind.case === "notice" &&
      frame.body.value.kind.value.kind.case === "present"
        ? frame.body.value.kind.value.kind.value.items.flatMap((item) =>
            item.kind.case === "notice" ? [item.kind.value.notice!.id] : [],
          )
        : [],
    )
  let attention: string[] = []
  let session = await open(attention)
  let noticeCount = 0
  const notice = async (expectedPushes: number) => {
    const before = {
      laptop: session.tabs.laptop.flatMap(presented).length,
      phone: session.tabs.phone.flatMap(presented).length,
      pushes: delivered.length,
    }
    attention = [...attention, `ses_${attention.length + 1}`]
    noticeCount += 1
    session.agent.send({
      case: "control",
      value: create(ControlSchema, { kind: { case: "status", value: { running: [], attention } } }),
    })
    await until(
      () =>
        (session.tabs.phone[0]?.raw ?? []).some(
          (frame) =>
            frame.body.case === "control" &&
            frame.body.value.kind.case === "notice" &&
            frame.body.value.kind.value.kind.case === "added" &&
            frame.body.value.kind.value.kind.value.notices.some((item) => item.id === `ntc_${noticeCount}`),
        ) && delivered.length === before.pushes + expectedPushes,
      `notice ${noticeCount} did not reach the tabs and ${expectedPushes} push requests`,
    )
    await until(() => settled.has(JSON.stringify(attention)), `notice ${noticeCount} push outcomes did not settle`)
    return {
      pushed: delivered.slice(before.pushes).sort(),
      laptop: session.tabs.laptop.flatMap(presented).length - before.laptop,
      phone: session.tabs.phone.flatMap(presented).length - before.phone,
    }
  }

  answers.set("phone", 403)
  const first = await notice(2)
  expect(
    JSON.stringify(first) === JSON.stringify({ pushed: ["laptop", "phone"], laptop: 0, phone: 1 }),
    `owner outcomes did not decide each browser: ${JSON.stringify(first)}`,
  )
  answers.delete("phone")

  expect(
    (await register(browsers.laptop, { endpoint: endpoint("laptop-renewed"), keys, replaces: endpoint("laptop") })) ===
      200,
    "The relay refused the laptop renewal",
  )
  const renewed = await notice(2)
  expect(
    JSON.stringify(renewed) === JSON.stringify({ pushed: ["laptop-renewed", "phone"], laptop: 0, phone: 0 }),
    `a renewal with every tab silent changed who presents: ${JSON.stringify(renewed)}`,
  )

  expect(
    (await register(browsers.laptop, { endpoint: endpoint("laptop-third"), keys, categories })) === 200,
    "The laptop replacement was not registered",
  )
  const replaced = await notice(2)
  expect(
    JSON.stringify(replaced) === JSON.stringify({ pushed: ["laptop-third", "phone"], laptop: 0, phone: 0 }),
    `a browser kept two live registrations: ${JSON.stringify(replaced)}`,
  )

  worker?.kill()
  if (worker) await worker.exited
  for (const socket of sockets.splice(0)) socket.stop()
  await start()
  session = await open(attention)
  const restored = await notice(2)
  expect(
    JSON.stringify(restored) === JSON.stringify({ pushed: ["laptop-third", "phone"], laptop: 0, phone: 0 }),
    `ownership did not survive a worker restart: ${JSON.stringify(restored)}`,
  )

  answers.set("laptop-third", 0)
  answers.set("phone", 403)
  const started = performance.now()
  const hung = await notice(2)
  expect(
    JSON.stringify(hung) === JSON.stringify({ pushed: ["laptop-third", "phone"], laptop: 1, phone: 1 }),
    `a timed-out or rejected push was not presented once by its browser: ${JSON.stringify(hung)}`,
  )
  expect(
    performance.now() - started >= 10_000,
    "the fallback for the rejected browser arrived before the hung delivery was abandoned",
  )
  answers.delete("phone")
  answers.delete("laptop-third")
  const afterHang = await notice(2)
  expect(
    JSON.stringify(afterHang) === JSON.stringify({ pushed: ["laptop-third", "phone"], laptop: 0, phone: 0 }),
    `delivery did not continue after an abandoned push: ${JSON.stringify(afterHang)}`,
  )

  answers.set("laptop-third", 410)
  const expired = await notice(2)
  expect(
    JSON.stringify(expired) === JSON.stringify({ pushed: ["laptop-third", "phone"], laptop: 1, phone: 0 }),
    `an expired push was not presented once by the laptop: ${JSON.stringify(expired)}`,
  )
  const unregistered = await notice(1)
  expect(
    JSON.stringify(unregistered) === JSON.stringify({ pushed: ["phone"], laptop: 1, phone: 0 }),
    `a browser without a registration was not presented once: ${JSON.stringify(unregistered)}`,
  )

  console.log(
    `PASS: local workerd+D1 server-owned push: two verified browsers on one account are judged by their own subscriptions; a D1 renewal with no page participation, a replacement registration, and a worker restart keep one registration per browser and its outcome; a push service that never answers is abandoned at the 10-second deadline and its browser presents once, as does a rejected browser; expired and missing registrations present exactly once. Push service deliveries: ${delivered.join(",")}`,
  )
} finally {
  for (const socket of sockets) socket.stop()
  worker?.kill()
  if (worker) await worker.exited
  pushStub?.stop(true)
  if (home) await rm(home, { recursive: true, force: true })
}

async function connect(url: string, headers: Record<string, string>) {
  const socket = new TestPeer(
    url,
    headers,
    new URL(url).pathname === RemoteWebSocketPath.agent ? PeerRole.AGENT : PeerRole.REMOTE_CLIENT,
  )
  sockets.push(socket)
  await socket.ready
  return socket
}

async function until(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return
    await Bun.sleep(50)
  }
  throw new Error(message)
}

function expect(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

async function run(args: string[]) {
  const process = spawn([wrangler, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exit !== 0)
    throw new Error(`Local D1 fixture command failed (${exit}): ${stdout.slice(-500)} ${stderr.slice(-500)}`)
}
