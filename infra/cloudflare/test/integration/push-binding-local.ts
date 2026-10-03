import { spawn } from "bun"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { RemoteWebSocketPath, parseRelayToClientMessage, type RemoteRelayToClient } from "../../../../packages/remote/src/index"
import { generateVapidKeys } from "../../script/vapid-keys"
import { base64UrlEncode, sha256Hex } from "../../src/auth/crypto"

const root = new URL("../../../../", import.meta.url).pathname
const wrangler = `${root}node_modules/.bin/wrangler`
const config = "infra/cloudflare/wrangler.jsonc"
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
const sockets: WebSocket[] = []

try {
  await mkdir(join(root, ".cache/tmp"), { recursive: true })
  home = await mkdtemp(join(root, ".cache/tmp/push-binding-"))
  const persist = join(home, "wrangler")
  const vapid = await generateVapidKeys()
  const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  const keys = { p256dh: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", receiver.publicKey))), auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))) }
  const delivered: string[] = []
  const answers = new Map<string, number>()
  pushStub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const target = new URL(request.url).pathname.replace("/push/", "")
    await request.arrayBuffer()
    delivered.push(target)
    const status = answers.get(target) ?? 201
    if (status === 0) return new Promise<Response>(() => {})
    return new Response(null, { status })
  } })
  await run(["d1", "migrations", "apply", "ycoding-prod-db", "--local", "--config", config, "--persist-to", persist])
  const now = Date.now()
  const deviceKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const jwk = await crypto.subtle.exportKey("jwk", deviceKey.publicKey)
  const publicKey = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y })
  await run(["d1", "execute", "ycoding-prod-db", "--local", "--config", config, "--persist-to", persist, "--command", [
    `INSERT INTO "user" (id, created_at) VALUES ('${accountID}', ${now});`,
    ...await Promise.all(Object.values(browsers).map(async (cookie) =>
      `INSERT INTO browser_session (id, user_id, created_at, expires_at) VALUES ('${await sha256Hex(cookie)}', '${accountID}', ${now}, ${now + 600_000});`)),
    `INSERT INTO device (id, user_id, name, public_key_jwk, key_algorithm, created_at) VALUES ('${deviceID}', '${accountID}', 'Binding machine', '${publicKey}', 'ES256', ${now});`,
    `INSERT INTO device_credential (id, device_id, kind, created_at, expires_at) VALUES ('${await sha256Hex(accessToken)}', '${deviceID}', 'access', ${now}, ${now + 600_000});`,
  ].join("\n")])
  expect(!await fetch(`${origin}/health`).then(() => true, () => false), "Chosen port already serves another process")
  const start = async () => {
    worker = spawn([wrangler, "dev", "infra/cloudflare/test/integration/push-stub-worker.ts", "--local", "--config", config,
      "--persist-to", persist, "--port", String(port), "--define", `PUSH_STUB_PORT:${pushStub?.port}`,
      "--var", `VAPID_PUBLIC_KEY:${vapid.VAPID_PUBLIC_KEY}`, "--var", `VAPID_PRIVATE_KEY:${vapid.VAPID_PRIVATE_KEY}`,
      "--var", "VAPID_SUBJECT:mailto:local-test@example.invalid"], { cwd: root, stdout: "ignore", stderr: "ignore" })
    let ready = false
    for (let attempt = 0; attempt < 150 && !ready; attempt += 1) {
      ready = await fetch(`${origin}/health`).then((response) => response.status === 200, () => false)
      if (!ready) await Bun.sleep(100)
    }
    expect(ready, "Local workerd did not start")
  }
  await start()

  const register = async (cookie: string, body: unknown) =>
    (await fetch(`${origin}/api/push/subscriptions`, { method: "POST", headers: { cookie: `yc_session=${cookie}`, origin, "content-type": "application/json" }, body: JSON.stringify(body) })).status
  const categories = { "agent-completed": true, "approval-requested": true, "machine-offline": true }
  expect(await register(browsers.laptop, { endpoint: endpoint("laptop"), keys, categories }) === 200, "The laptop subscription was not registered")
  expect(await register(browsers.phone, { endpoint: endpoint("phone"), keys, categories }) === 200, "The phone subscription was not registered")

  const open = async (attentive: readonly string[]) => {
    const agent = await connect(`ws://127.0.0.1:${port}${RemoteWebSocketPath.agent}`, { authorization: `Bearer ${accessToken}` })
    const tabs = { laptop: [await tab(browsers.laptop), await tab(browsers.laptop)], phone: [await tab(browsers.phone)] }
    agent.send({ type: "status", running: [], attention: attentive })
    await Bun.sleep(300)
    return { agent, tabs }
  }
  const tab = async (cookie: string) => {
    const socket = await connect(`ws://127.0.0.1:${port}${RemoteWebSocketPath.client}?device=${deviceID}`, { cookie: `yc_session=${cookie}`, origin })
    socket.send({ type: "request", id: "subscribe", operation: "notice.subscribe" })
    await until(() => socket.frames.some((frame) => frame.type === "response" && frame.id === "subscribe"), "a tab could not subscribe to notices")
    return socket
  }
  const presented = (socket: { frames: RemoteRelayToClient[] }) =>
    socket.frames.flatMap((frame) => frame.type === "notice.present" ? frame.items.flatMap((item) => item.kind === "notice" ? [item.notice.id] : []) : [])
  let attention: string[] = []
  let session = await open(attention)
  let noticeCount = 0
  const notice = async (expectedPushes: number, settleMs = 400) => {
    const before = { laptop: session.tabs.laptop.flatMap(presented).length, phone: session.tabs.phone.flatMap(presented).length, pushes: delivered.length }
    attention = [...attention, `ses_${attention.length + 1}`]
    noticeCount += 1
    session.agent.send({ type: "status", running: [], attention })
    await until(() => (session.tabs.phone[0]?.frames ?? []).some((frame) => frame.type === "notice.added" && frame.notices.some((item) => item.id === `ntc_${noticeCount}`))
      && delivered.length === before.pushes + expectedPushes, `notice ${noticeCount} did not reach the tabs and ${expectedPushes} push requests`)
    await Bun.sleep(settleMs)
    return { pushed: delivered.slice(before.pushes).sort(), laptop: session.tabs.laptop.flatMap(presented).length - before.laptop, phone: session.tabs.phone.flatMap(presented).length - before.phone }
  }

  answers.set("phone", 403)
  const first = await notice(2)
  expect(JSON.stringify(first) === JSON.stringify({ pushed: ["laptop", "phone"], laptop: 0, phone: 1 }), `owner outcomes did not decide each browser: ${JSON.stringify(first)}`)
  answers.delete("phone")

  expect(await register(browsers.laptop, { endpoint: endpoint("laptop-renewed"), keys, replaces: endpoint("laptop") }) === 200, "The relay refused the laptop renewal")
  const renewed = await notice(2)
  expect(JSON.stringify(renewed) === JSON.stringify({ pushed: ["laptop-renewed", "phone"], laptop: 0, phone: 0 }), `a renewal with every tab silent changed who presents: ${JSON.stringify(renewed)}`)

  expect(await register(browsers.laptop, { endpoint: endpoint("laptop-third"), keys, categories }) === 200, "The laptop replacement was not registered")
  const replaced = await notice(2)
  expect(JSON.stringify(replaced) === JSON.stringify({ pushed: ["laptop-third", "phone"], laptop: 0, phone: 0 }), `a browser kept two live registrations: ${JSON.stringify(replaced)}`)

  worker?.kill()
  if (worker) await worker.exited
  for (const socket of sockets.splice(0)) socket.close()
  await start()
  session = await open(attention)
  const restored = await notice(2)
  expect(JSON.stringify(restored) === JSON.stringify({ pushed: ["laptop-third", "phone"], laptop: 0, phone: 0 }), `ownership did not survive a worker restart: ${JSON.stringify(restored)}`)

  answers.set("laptop-third", 0)
  answers.set("phone", 403)
  const started = performance.now()
  const hung = await notice(2, 10_800)
  expect(JSON.stringify(hung) === JSON.stringify({ pushed: ["laptop-third", "phone"], laptop: 1, phone: 1 }), `a timed-out or rejected push was not presented once by its browser: ${JSON.stringify(hung)}`)
  expect(performance.now() - started >= 10_000, "the fallback for the rejected browser arrived before the hung delivery was abandoned")
  answers.delete("phone")
  const afterHang = await notice(2)
  expect(JSON.stringify(afterHang) === JSON.stringify({ pushed: ["laptop-third", "phone"], laptop: 0, phone: 0 }), `delivery did not continue after an abandoned push: ${JSON.stringify(afterHang)}`)

  answers.set("laptop-third", 410)
  const expired = await notice(2)
  expect(JSON.stringify(expired) === JSON.stringify({ pushed: ["laptop-third", "phone"], laptop: 1, phone: 0 }), `an expired push was not presented once by the laptop: ${JSON.stringify(expired)}`)
  const unregistered = await notice(1)
  expect(JSON.stringify(unregistered) === JSON.stringify({ pushed: ["phone"], laptop: 1, phone: 0 }), `a browser without a registration was not presented once: ${JSON.stringify(unregistered)}`)

  console.log(`PASS: local workerd+D1 server-owned push: two verified browsers on one account are judged by their own subscriptions; a D1 renewal with no page participation, a replacement registration, and a worker restart keep one registration per browser and its outcome; a push service that never answers is abandoned at the 10-second deadline and its browser presents once, as does a rejected browser; expired and missing registrations present exactly once. Push service deliveries: ${delivered.join(",")}`)
} finally {
  for (const socket of sockets) socket.close()
  worker?.kill()
  if (worker) await worker.exited
  pushStub?.stop(true)
  if (home) await rm(home, { recursive: true, force: true })
}

async function connect(url: string, headers: Record<string, string>) {
  const socket = new WebSocket(url, { headers })
  sockets.push(socket)
  const frames: RemoteRelayToClient[] = []
  socket.addEventListener("message", (event) => {
    const frame = parseRelayToClientMessage(String(event.data))
    if (!frame.ok) return
    if (frame.value.type === "ping") socket.send(JSON.stringify({ type: "pong" }))
    frames.push(frame.value)
  })
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("close", (event) => reject(new Error(`Socket ${url} closed ${event.code} ${event.reason}`)), { once: true })
  })
  return { frames, send: (frame: unknown) => socket.send(JSON.stringify(frame)) }
}

async function until(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  if (exit !== 0) throw new Error(`Local D1 fixture command failed (${exit}): ${stdout.slice(-500)} ${stderr.slice(-500)}`)
}
