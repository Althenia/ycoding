import { expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { getEventListeners } from "node:events"
import { mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Result } from "effect"
import { McpEvents } from "@ycoding-ai/schema/mcp-events"
import { canonicalJSON, grantTtl, normalizeArguments, subscriptionIdentity } from "../src/mcp-events/identity"
import { mapEvent } from "../src/mcp-events/capture"
import { isPublicAddress, makeProtectedSend, type ConnectInput } from "../src/mcp-events/protected-http"
import { decodeSecret, keyFile, makeSecretBox } from "../src/mcp-events/secret-box"
import { sign } from "../src/mcp-events/signing"

const keyBytes = Buffer.alloc(32, 3)
const secret = "whsec_" + Buffer.alloc(32, 7).toString("base64")

test("signing secret must be whsec_ base64 decoding to 24-64 bytes", () => {
  expect(Result.isSuccess(decodeSecret(secret))).toBe(true)
  const decoded = decodeSecret(secret)
  expect(Result.isSuccess(decoded) ? Array.from(decoded.success) : []).toEqual(Array.from(Buffer.alloc(32, 7)))
  for (const bad of ["whsec_" + Buffer.alloc(23).toString("base64"), "whsec_" + Buffer.alloc(65).toString("base64"), "secret", "whsec_!!!", "whsec_"])
    expect(Result.isFailure(decodeSecret(bad))).toBe(true)
  const failure = decodeSecret("whsec_!!!")
  if (Result.isFailure(failure)) expect(failure.failure).toMatchObject({ category: "invalid_params", reason: "invalid_secret" })
})

test("standard webhooks signature covers id, timestamp, and exact body bytes", () => {
  const body = JSON.stringify({ eventId: "evt_1", name: "session.progress", data: { state: "running" } })
  const signature = sign({ id: "evt_1", timestampSeconds: 1_700_000_000, body, secrets: [Buffer.alloc(32, 7)] })
  const expected = "v1," + createHmac("sha256", Buffer.alloc(32, 7)).update(`evt_1.1700000000.${body}`).digest("base64")
  expect(signature).toBe(expected)
  const dual = sign({ id: "evt_1", timestampSeconds: 1_700_000_000, body, secrets: [Buffer.alloc(32, 7), Buffer.alloc(32, 9)] })
  expect(dual.split(" ")).toHaveLength(2)
  expect(dual.startsWith(expected)).toBe(true)
})

test("secret box round-trips ciphertext without containing the secret and keys stay 0600 non-symlink files", async () => {
  const box = makeSecretBox(keyBytes)
  const cipher = box.encrypt(Buffer.alloc(32, 7))
  expect(cipher).not.toContain(Buffer.alloc(32, 7).toString("base64"))
  expect(box.decrypt(cipher)).toEqual(Buffer.alloc(32, 7))
  expect(box.decrypt("bogus")).toBeUndefined()
  expect(box.fingerprint(Buffer.alloc(32, 7))).toMatch(/^[a-f0-9]{32}$/)

  const dir = mkdtempSync(join(tmpdir(), "ycoding-mcp-events-key-"))
  const path = join(dir, "key")
  const first = await Effect.runPromise(keyFile(path))
  expect(first).toHaveLength(32)
  expect(await Effect.runPromise(keyFile(path))).toEqual(first)
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600)

  const target = join(dir, "target")
  writeFileSync(target, Buffer.alloc(32, 1), { mode: 0o600 })
  const link = join(dir, "link")
  symlinkSync(target, link)
  const exit = await Effect.runPromise(Effect.exit(keyFile(link)))
  expect(exit._tag).toBe("Failure")
  if (exit._tag === "Failure") expect(Cause.squash(exit.cause)).toMatchObject({ category: "unavailable", reason: "secure_storage_unavailable" })
})

test("canonical identity ignores argument key order and scopes the full principal", () => {
  expect(canonicalJSON({ b: 1, a: { d: [1, 2], c: true } })).toBe('{"a":{"c":true,"d":[1,2]},"b":1}')
  const principal = { ownerID: "own", deviceID: "dev", clientID: "cli", grantID: "grt", epoch: "e1" }
  const a = subscriptionIdentity(principal, "https://r.test/cb", "session.progress", normalizeArguments({ session_id: "ses_a" } as never))
  const b = subscriptionIdentity(principal, "https://r.test/cb", "session.progress", normalizeArguments({ include_descendants: false, session_id: "ses_a" } as never))
  expect(a).toEqual(b)
  expect(a.id).toMatch(/^sub_[a-f0-9]{32}$/)
  for (const changed of [
    { ...principal, ownerID: "other" },
    { ...principal, deviceID: "other" },
    { ...principal, clientID: "other" },
    { ...principal, grantID: "other" },
    { ...principal, epoch: "e2" },
  ]) expect(subscriptionIdentity(changed, "https://r.test/cb", "session.progress", a.args).id).not.toBe(a.id)
  expect(subscriptionIdentity(principal, "https://r.test/other", "session.progress", a.args).id).not.toBe(a.id)
})

test("ttl grants default to 24h, floor at 60s, cap at 7d and at the grant expiry, and stay finite for null", () => {
  const now = 1_000_000
  const grant = now + 30 * 86_400_000
  expect(grantTtl({ ttlMs: undefined, grantExpiresAt: grant, now })).toBe(now + 86_400_000)
  expect(grantTtl({ ttlMs: null, grantExpiresAt: grant, now })).toBe(now + 86_400_000)
  expect(grantTtl({ ttlMs: 1_000, grantExpiresAt: grant, now })).toBe(now + 60_000)
  expect(grantTtl({ ttlMs: 30 * 86_400_000, grantExpiresAt: grant, now })).toBe(now + 7 * 86_400_000)
  expect(grantTtl({ ttlMs: undefined, grantExpiresAt: now + 3_600_000, now })).toBe(now + 3_600_000)
})

test("only globally public addresses are accepted at connect time", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])
    expect(isPublicAddress(ip)).toBe(true)
  for (const ip of [
    "10.0.0.1", "172.16.5.4", "192.168.1.1", "127.0.0.1", "0.0.0.0", "169.254.169.254", "100.64.0.1",
    "192.0.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "198.18.0.1", "224.0.0.1", "240.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "not-an-ip",
  ]) expect(isPublicAddress(ip)).toBe(false)
})

test("protected send pins the validated address, preserves TLS hostname, and never follows redirects or rebinding", async () => {
  const seen: ConnectInput[] = []
  let lookups = 0
  const send = makeProtectedSend({
    lookup: async (hostname) => {
      lookups++
      expect(hostname).toBe("receiver.example.test")
      return lookups === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "10.0.0.8", family: 4 }]
    },
    connect: async (input) => {
      seen.push(input)
      return { status: 302, body: "" }
    },
  })
  const request = { url: "https://receiver.example.test/cb", body: "{}", headers: {}, timeoutMs: 10_000 }
  const response = await Effect.runPromise(send(request))
  expect(response.status).toBe(302)
  expect(seen).toEqual([{ ip: "93.184.216.34", servername: "receiver.example.test", hostname: "receiver.example.test", port: 443, path: "/cb", headers: {}, body: "{}", timeoutMs: seen[0].timeoutMs, signal: expect.any(AbortSignal) }])
  expect(seen[0].timeoutMs).toBeGreaterThan(0)
  expect(seen[0].timeoutMs).toBeLessThanOrEqual(10_000)
  const rebound = await Effect.runPromise(Effect.exit(send(request)))
  expect(rebound._tag).toBe("Failure")
  if (rebound._tag === "Failure") expect(Cause.squash(rebound.cause)).toMatchObject({ category: "callback_endpoint", reason: "endpoint_rejected" })
  expect(seen).toHaveLength(1)

  for (const addresses of [
    [{ address: "8.8.8.8", family: 4 }, { address: "169.254.169.254", family: 4 }],
    [{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }, { address: "fe80::1", family: 6 }],
    [],
  ]) {
    const mixed = makeProtectedSend({ lookup: async () => addresses, connect: async () => ({ status: 200, body: "" }) })
    expect((await Effect.runPromise(Effect.exit(mixed(request))))._tag).toBe("Failure")
  }
  for (const url of ["http://receiver.example.test/cb", "https://user:pass@receiver.example.test/cb", "https://127.0.0.1/cb", "not a url"]) {
    const bad = makeProtectedSend({ lookup: async () => [{ address: "8.8.8.8", family: 4 }], connect: async () => ({ status: 200, body: "" }) })
    expect((await Effect.runPromise(Effect.exit(bad({ ...request, url }))))._tag).toBe("Failure")
  }
})

test("capture maps attention and material execution events to metadata only", () => {
  const permission = mapEvent({ type: "permission.asked", id: "evt-src-1", data: { id: "per_1", sessionID: "ses_a", action: "shell", resources: ["rm -rf /private"], metadata: { command: "secret" } } })
  expect(permission).toMatchObject({ name: "session.permission.changed", sessionID: "ses_a", state: "pending", requestID: "per_1", category: "shell" })
  expect(JSON.stringify(permission)).not.toContain("rm -rf")
  expect(JSON.stringify(permission)).not.toContain("secret")

  expect(mapEvent({ type: "permission.replied", id: "e2", data: { sessionID: "ses_a", requestID: "per_1", reply: "reject" } }))
    .toMatchObject({ name: "session.permission.changed", state: "resolved", requestID: "per_1", reason: "reject" })
  expect(mapEvent({ type: "question.timed_out", id: "e3", data: { sessionID: "ses_a", requestID: "que_1" } }))
    .toMatchObject({ name: "session.question.changed", state: "cancelled", reason: "timed_out" })
  expect(mapEvent({ type: "form.created", id: "e4", data: { form: { id: "frm_1", sessionID: "ses_a", title: "Private title", fields: [] } } }))
    .toMatchObject({ name: "session.form.changed", state: "pending", requestID: "frm_1" })
  expect(mapEvent({ type: "session.review.deferred", id: "e5", data: { sessionID: "ses_a", itemID: "rev_1", kind: "guardrail", payload: { text: "no" } } }))
    .toMatchObject({ name: "session.guardrail.changed", state: "deferred", itemID: "rev_1" })
  expect(mapEvent({ type: "session.guardrail.escalated", id: "e6", data: { sessionID: "ses_a", requestID: "gr_1", grades: [{ evidence: "private evidence" }] } }))
    .toBeUndefined()

  const failed = mapEvent({ type: "session.execution.failed", id: "e7", data: { sessionID: "ses_a", error: { type: "provider.transport", message: "raw credential detail" } } })
  expect(failed).toMatchObject({ name: "session.error", state: "failed", category: "provider.transport" })
  expect(JSON.stringify(failed)).not.toContain("credential")
  expect(mapEvent({ type: "session.work.completed", id: "e8", data: { sessionID: "ses_a", inputID: "msg_1" } }))
    .toMatchObject({ name: "session.completed", state: "completed" })
  expect(mapEvent({ type: "session.task.updated", id: "e9", data: { sessionID: "ses_child", change: { type: "completed", excerpt: "private excerpt" } } }))
    .toMatchObject({ name: "session.progress", state: "completed", taskID: "ses_child" })
  for (const type of ["session.text.delta", "session.tool.progress", "session.step.ended", "session.usage.recorded", "session.task.updated"])
    expect(mapEvent({ type, id: "ex", data: type === "session.task.updated" ? { sessionID: "ses_a", change: { type: "progressed" } } : { sessionID: "ses_a" } })).toBeUndefined()
  expect(mapEvent({ type: "permission.asked", id: "e10", data: { id: "per_2", sessionID: "global" } })).toBeUndefined()
})

test("Dots completion notifications carry input correlation without message content", () => {
  const first = mapEvent({ type: "session.work.completed", id: "evt_work_first", data: {
    sessionID: "ses_a", inputID: "msg_dots_first", assistantMessageID: "msg_reply",
    text: "Synthetic private response", exchangeID: "caller-selected/exchange", coordinator: "synthetic-coordinator",
  } })
  expect(first).toEqual({ name: "session.completed", sessionID: "ses_a", state: "completed", requestID: "msg_dots_first", sourceID: "evt_work_first" })
  expect(mapEvent({ type: "session.work.completed", id: "evt_work_second", data: { sessionID: "ses_a", inputID: "msg_dots_first" } })?.sourceID).toBe("evt_work_second")
  for (const inputID of [undefined, "invalid/id", "m".repeat(129)]) {
    const mapped = mapEvent({ type: "session.work.completed", id: "evt_work_missing", data: { sessionID: "ses_a", inputID } })
    expect(mapped?.requestID).toBeUndefined()
    expect(mapped?.sourceID).toBe("evt_work_missing")
  }
})

test("Dots report notifications expose only input correlation and report kind", () => {
  const value = mapEvent({ type: "session.dots.report.recorded", id: "evt_report_first", data: { sessionID: "ses_a", text: "Private synthetic body", envelope: { kind: "blocker", replyToMessageID: "msg_input", coordinator: { clientID: "private-client" } } } })
  expect(value).toEqual({ name: "session.progress", sessionID: "ses_a", state: "running", requestID: "msg_input", category: "blocker", sourceID: "evt_report_first" })
  expect(mapEvent({ type: "session.dots.report.recorded", id: "evt_bad", data: { sessionID: "ses_a", envelope: { kind: "blocker" } } })).toBeUndefined()
})

test("failure values never carry callback or secret material", () => {
  const failure = new McpEvents.Failure({ category: "invalid_params", reason: "invalid_secret" })
  expect(JSON.stringify(failure)).not.toContain("whsec_")
  expect(failure.message).toBe("invalid_params: invalid_secret")
})

test("protected send bounds DNS and rejects oversized UTF-8 bodies before lookup", async () => {
  let lookups = 0
  const send = makeProtectedSend({
    lookup: () => { lookups++; return new Promise(() => {}) },
    connect: async () => { throw new Error("unexpected connection") },
  })
  const request = { url: "https://receiver.example.test/cb", body: "{}", headers: {}, timeoutMs: 10 }
  const timeout = await Promise.race([
    Effect.runPromise(Effect.exit(send(request))),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100)),
  ])
  expect(timeout).toBeDefined()
  if (timeout?._tag === "Failure") expect(Cause.squash(timeout.cause)).toMatchObject({ reason: "timeout" })
  expect(timeout?._tag).toBe("Failure")
  const oversize = await Promise.race([
    Effect.runPromise(Effect.exit(send({ ...request, body: "é".repeat(131_073) }))),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100)),
  ])
  expect(oversize?._tag).toBe("Failure")
  if (oversize?._tag === "Failure") expect(Cause.squash(oversize.cause)).toMatchObject({ reason: "payload_too_large" })
  expect(lookups).toBe(1)
})

test("protected send settles cancelled connections and removes caller abort listeners", async () => {
  const controller = new AbortController()
  let connected!: () => void
  const started = new Promise<void>((resolve) => { connected = resolve })
  let connectionSignal: AbortSignal | undefined
  const send = makeProtectedSend({
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    connect: (input) => {
      connectionSignal = input.signal
      connected()
      return new Promise(() => {})
    },
  })
  const pending = Effect.runPromise(Effect.exit(send({ url: "https://receiver.example.test", body: "{}", headers: {}, timeoutMs: 1000, signal: controller.signal })))
  await started
  controller.abort()
  const result = await Promise.race([pending, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100))])
  expect(result?._tag).toBe("Failure")
  expect(connectionSignal?.aborted).toBe(true)
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  const success = makeProtectedSend({ lookup: async () => [{ address: "8.8.8.8", family: 4 }], connect: async () => ({ status: 204, body: "" }) })
  const active = new AbortController()
  await Effect.runPromise(success({ url: "https://receiver.example.test", body: "{}", headers: {}, timeoutMs: 1000, signal: active.signal }))
  expect(getEventListeners(active.signal, "abort")).toHaveLength(0)
})
