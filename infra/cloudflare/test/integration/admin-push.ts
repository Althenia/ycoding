import { spawn } from "bun"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { generateVapidKeys } from "../../script/vapid-keys"
import { base64UrlEncode, sha256Hex } from "../../src/auth/crypto"
import { deriveWebPushKeys } from "../../src/push/crypto"

const root = new URL("../../../../", import.meta.url).pathname
const wrangler = `${root}node_modules/.bin/wrangler`
const config = "infra/cloudflare/wrangler.jsonc"
const port = 48000 + Math.floor(Math.random() * 1000)
const origin = `http://127.0.0.1:${port}`
const adminKey = "A".repeat(48)
const accountID = "usr_admin_local_owner"
const otherAccountID = "usr_admin_local_other"
const cookieToken = "admin-push-local-cookie"
const endpoint = (outcome: string) => `https://fcm.googleapis.com/fcm/send/admin-local-${outcome}`
let worker: { kill: () => unknown; exited: Promise<number> } | undefined
let home: string | undefined
let pushStub: { port: number | undefined; stop: (closeActive?: boolean) => unknown } | undefined

try {
  await mkdir(join(root, ".cache/tmp"), { recursive: true })
  home = await mkdtemp(join(root, ".cache/tmp/admin-push-"))
  const persist = join(home, "wrangler")
  const vapid = await generateVapidKeys()
  const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  const receiverBytes = new Uint8Array(await crypto.subtle.exportKey("raw", receiver.publicKey))
  const auth = crypto.getRandomValues(new Uint8Array(16))
  const requests: { path: string; method: string; encoding: string | null; body: Uint8Array }[] = []
  pushStub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const path = new URL(request.url).pathname
    requests.push({ path, method: request.method, encoding: request.headers.get("content-encoding"), body: new Uint8Array(await request.arrayBuffer()) })
    return new Response(null, { status: path === "/push/rejected" ? 403 : path === "/push/expired" ? 410 : 201 })
  } })
  await run(["d1", "migrations", "apply", "ycoding-prod-db", "--local", "--config", config, "--persist-to", persist])
  const now = Date.now()
  await run(["d1", "execute", "ycoding-prod-db", "--local", "--config", config, "--persist-to", persist, "--command", [
    `INSERT INTO "user" (id, created_at) VALUES ('${accountID}', ${now}), ('${otherAccountID}', ${now});`,
    `INSERT INTO browser_session (id, user_id, created_at, expires_at) VALUES ('${await sha256Hex(cookieToken)}', '${accountID}', ${now}, ${now + 600_000});`,
    ...["accepted", "rejected", "expired", "unreachable"].map((outcome) =>
      `INSERT INTO push_subscription (endpoint, account_id, p256dh, auth, created_at) VALUES ('${endpoint(outcome)}', '${accountID}', '${base64UrlEncode(receiverBytes)}', '${base64UrlEncode(auth)}', ${now});`),
  ].join("\n")])
  const occupied = await fetch(`${origin}/health`).then(() => true, () => false)
  expect(!occupied, "Chosen port already serves another process")
  worker = spawn([wrangler, "dev", "infra/cloudflare/test/integration/push-stub-worker.ts", "--local", "--config", config,
    "--persist-to", persist, "--port", String(port), "--define", `PUSH_STUB_PORT:${pushStub.port}`,
    "--var", `ADMIN_API_KEY:${adminKey}`, "--var", `VAPID_PUBLIC_KEY:${vapid.VAPID_PUBLIC_KEY}`,
    "--var", `VAPID_PRIVATE_KEY:${vapid.VAPID_PRIVATE_KEY}`, "--var", "VAPID_SUBJECT:mailto:local-test@example.invalid"],
    { cwd: root, stdout: "ignore", stderr: "ignore" })
  let ready = false
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(`${origin}/health`)).status === 200) { ready = true; break }
    } catch {}
    await Bun.sleep(100)
  }
  expect(ready, "Local workerd did not start")
  const call = (body: unknown, options: { bearer?: string; cookie?: boolean; path?: string; method?: string } = { bearer: adminKey }) =>
    fetch(`${origin}${options.path ?? "/api/admin/push/test"}`, { method: options.method ?? "POST",
      headers: { "content-type": "application/json", ...(options.bearer === undefined ? {} : { authorization: `Bearer ${options.bearer}` }),
        ...(options.cookie ? { cookie: `yc_session=${cookieToken}`, origin } : {}) }, body: JSON.stringify(body) })
  const target = { accountID, endpoint: endpoint("accepted") }
  expect((await fetch(`${origin}/api/me`, { headers: { cookie: `yc_session=${cookieToken}` } })).status === 200, "Fixture cookie is not authenticated")
  for (const options of [{}, { cookie: true }, { bearer: "wrong-admin-key" }])
    expect((await call(target, options)).status === 401, "Admin push accepted missing or invalid Bearer authentication")
  expect((await call(target, { bearer: adminKey, path: "/api/push/test", cookie: true })).status === 404, "Removed cookie endpoint remains reachable")
  expect((await call({ ...target, accountID: otherAccountID })).status === 404, "Another account can target the registered endpoint")
  expect((await call({ ...target, keys: { auth: "forbidden" } })).status === 400, "Admin endpoint accepted caller-supplied keys")
  expect((await call({ ...target, endpoint: "https://example.invalid/collector" })).status === 400, "Admin endpoint accepted an arbitrary destination")
  expect(requests.length === 0, "A denied request reached the push stand-in")

  for (const outcome of ["accepted", "rejected", "expired", "unreachable"] as const) {
    const before = requests.length
    const response = await call({ accountID, endpoint: endpoint(outcome) })
    expect(response.status === 200, `${outcome} returned API status ${response.status}`)
    const expected = { outcome, ...(outcome === "unreachable" ? {} : { status: outcome === "accepted" ? 201 : outcome === "rejected" ? 403 : 410 }) }
    expect(JSON.stringify(await response.json()) === JSON.stringify(expected), `${outcome} returned a dishonest delivery outcome`)
    expect(requests.length === before + (outcome === "unreachable" ? 0 : 1), `${outcome} sent to more than the claimed subscription`)
    if (outcome === "expired") {
      expect((await call({ accountID, endpoint: endpoint(outcome) })).status === 404, "Expired subscription remains registered")
      continue
    }
    expect((await call({ accountID, endpoint: endpoint(outcome) })).status === 429, `${outcome} did not retain the per-subscription rate claim`)
    expect(requests.length === before + (outcome === "unreachable" ? 0 : 1), "Rate-limited request delivered another push")
  }
  expect(requests.map((request) => request.path).join(",") === "/push/accepted,/push/rejected,/push/expired", "Push target routing changed")
  const sent = requests[0]
  expect(sent.method === "POST" && sent.encoding === "aes128gcm", "Registered target did not receive an encrypted Web Push POST")
  const sender = sent.body.slice(21, 86)
  const publicSender = await crypto.subtle.importKey("raw", sender, { name: "ECDH", namedCurve: "P-256" }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: publicSender }, receiver.privateKey, 256))
  const keys = await deriveWebPushKeys(shared, auth, receiverBytes, sender, sent.body.slice(0, 16))
  const key = await crypto.subtle.importKey("raw", keys.cek, "AES-GCM", false, ["decrypt"])
  const clear = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: keys.nonce }, key, sent.body.slice(86)))
  expect(new TextDecoder().decode(clear.slice(0, -1)) === '{"category":"test"}', "Test push carried caller-controlled payload")
  console.log("PASS: local workerd+D1 admin push authentication, exact ownership, old-route removal, validation, rate claims, encrypted test payload, and accepted/rejected/expired/unreachable outcomes; 3 local push POSTs, no real delivery")
} finally {
  worker?.kill()
  if (worker) await worker.exited
  pushStub?.stop(true)
  if (home) await rm(home, { recursive: true, force: true })
}

function expect(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

async function run(args: string[]) {
  const process = spawn([wrangler, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  if (exit !== 0) throw new Error(`Local D1 fixture command failed (${exit}): ${stdout.slice(-500)} ${stderr.slice(-500)}`)
}
