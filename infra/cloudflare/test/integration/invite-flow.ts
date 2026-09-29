import { spawn } from "bun"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"

const root = new URL("../../../../", import.meta.url).pathname
const wrangler = `${root}node_modules/.bin/wrangler`
const config = "infra/cloudflare/wrangler.jsonc"
const port = 47000 + Math.floor(Math.random() * 1000)
const origin = `http://127.0.0.1:${port}`
const adminKey = "A".repeat(48)
let worker: { kill: () => unknown; exited: Promise<number> } | undefined
let home: string | undefined
let socket: WebSocket | undefined

try {
  await mkdir(join(root, ".cache/tmp"), { recursive: true })
  home = await mkdtemp(join(root, ".cache/tmp/invite-flow-"))
  const persist = join(home, "wrangler")
  const migrate = spawn([wrangler, "d1", "migrations", "apply", "ycoding-prod-db", "--local", "--config", config, "--persist-to", persist],
    { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [migrateOut, migrateError, migrated] = await Promise.all([new Response(migrate.stdout).text(), new Response(migrate.stderr).text(), migrate.exited])
  if (migrated !== 0) throw new Error(`Local migration failed (${migrated}): ${migrateOut.slice(-500)} ${migrateError.slice(-500)}`)
  worker = spawn([wrangler, "dev", "--config", config, "--persist-to", persist, "--port", String(port), "--var", `ADMIN_API_KEY:${adminKey}`],
    { cwd: root, stdout: "ignore", stderr: "ignore" })
  let ready = false
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(`${origin}/health`)).status === 200) { ready = true; break }
    } catch {}
    await Bun.sleep(100)
  }
  if (!ready) throw new Error("Local Worker did not start")
  const invitePage = await fetch(`${origin}/remote/invite`)
  if (invitePage.status !== 200 || !invitePage.headers.get("content-type")?.includes("text/html") ||
    !(await invitePage.text()).includes('id="app"')) throw new Error("Worker did not serve the invite SPA route")

  const admin = (method: string, path: string, body?: unknown) => fetch(`${origin}${path}`, { method,
    headers: { authorization: `Bearer ${adminKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const signed = (method: string, path: string, cookie?: string, body?: unknown) => fetch(`${origin}${path}`, { method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { origin, "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const created = await admin("POST", "/api/admin/invites", { label: "Local invite" })
  if (created.status !== 201) throw new Error(`Admin creation returned ${created.status}`)
  const invite: unknown = await created.json()
  if (!isRecord(invite) || typeof invite.id !== "string" || typeof invite.url !== "string") throw new Error("Invite response incomplete")
  const token = invite.url.split("#")[1]
  if (!token || new URL(invite.url).pathname !== "/remote/invite")
    throw new Error(`Invite did not use a fragment (${new URL(invite.url).origin}, ${new URL(invite.url).pathname})`)

  const accepted = await signed("POST", "/api/auth/invite", undefined, { token })
  if (accepted.status !== 201) throw new Error(`Invite redemption returned ${accepted.status}`)
  const firstCookie = cookie(accepted)
  const redeemed: unknown = await accepted.json()
  if (!isRecord(redeemed) || typeof redeemed.accessKey !== "string") throw new Error("Access key missing")
  const second = await signed("POST", "/api/auth/key", undefined, { accessKey: redeemed.accessKey })
  if (second.status !== 204) throw new Error(`Access key sign-in returned ${second.status}`)
  const secondCookie = cookie(second)
  for (const browserCookie of [firstCookie, secondCookie])
    if ((await signed("GET", "/api/me", browserCookie)).status !== 200) throw new Error("Invited browser could not read its account")

  const enrollmentResponse = await signed("POST", "/api/devices/enrollments", firstCookie, {})
  if (enrollmentResponse.status !== 200) throw new Error(`Enrollment returned ${enrollmentResponse.status}`)
  const enrollment: unknown = await enrollmentResponse.json()
  if (!isRecord(enrollment) || typeof enrollment.enrollmentID !== "string" || typeof enrollment.code !== "string") throw new Error("Enrollment incomplete")
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  const enrolled = await signed("POST", "/api/devices/enroll", undefined, { enrollmentID: enrollment.enrollmentID,
    code: enrollment.code, name: "Local machine", publicKey: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } })
  if (enrolled.status !== 200) throw new Error(`Device enrollment returned ${enrolled.status}`)
  const device: unknown = await enrolled.json()
  if (!isRecord(device) || typeof device.deviceID !== "string") throw new Error("Device ID missing")
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws/v3/client?device=${device.deviceID}`, { headers: { cookie: firstCookie, origin } })
  await Promise.race([new Promise<void>((resolve, reject) => {
    socket?.addEventListener("open", () => resolve(), { once: true })
    socket?.addEventListener("error", () => reject(new Error("Client socket failed to open")), { once: true })
  }), Bun.sleep(10_000).then(() => { throw new Error("Client socket did not open") })])
  const closed = new Promise<number>((resolve) => socket?.addEventListener("close", (event) => resolve(event.code), { once: true }))
  const deleted = await admin("DELETE", `/api/admin/invites/${invite.id}`)
  if (deleted.status !== 204) throw new Error(`Admin deletion returned ${deleted.status}`)
  const closeCode = await Promise.race([closed, Bun.sleep(10_000).then(() => { throw new Error("Client socket stayed open") })])
  if (closeCode !== 4401 && closeCode !== 4403) throw new Error(`Unexpected client close code ${closeCode}`)
  for (const browserCookie of [firstCookie, secondCookie])
    if ((await signed("GET", "/api/me", browserCookie)).status !== 401) throw new Error("Deleted invite still authorized a browser")
  if ((await signed("POST", "/api/auth/key", undefined, { accessKey: redeemed.accessKey })).status !== 401)
    throw new Error("Deleted invite still authorized its key")
  console.log("Local workerd invite flow passed: two browsers, revoked key, and closed client socket")
} finally {
  socket?.close()
  worker?.kill()
  if (worker) await worker.exited
  if (home) await rm(home, { recursive: true, force: true })
}

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie")?.split(";")[0]
  if (!value || !value.startsWith("yc_session=")) throw new Error("Browser session cookie missing")
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
