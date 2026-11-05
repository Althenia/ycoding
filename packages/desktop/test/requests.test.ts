import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { BackendController } from "../src/backend-controller"
import type { ConnectionState } from "../src/contract"
import { requestReply } from "../src/requests"
import { env, launch, message, peer, revision, syntheticBundle, writes } from "./synthetic-backend"

const invalid = "This answer is invalid. Refresh requests and answer again."
const unsent = "The backend connection changed before the answer was sent. Refresh requests and answer again."
const permission = { kind: "permission", sessionID: "ses_synthetic", revision: 3, requestID: "per_synthetic", reply: "reject", message: "Not this file" } as const
const form = { kind: "form", sessionID: "ses_synthetic", revision: 3, formID: "frm_synthetic", answer: { choice: "keep", count: 2, confirm: true, tags: ["a", "b"] } } as const
const cancel = { kind: "form-cancel", sessionID: "ses_synthetic", revision: 3, formID: "frm_synthetic" } as const

test("request replies keep the exact kind, Session, connection revision, request and answer", () => {
  expect(requestReply(permission)).toEqual(permission)
  expect(requestReply({ ...permission, reply: "always", message: undefined })).toEqual({ kind: "permission", sessionID: "ses_synthetic", revision: 3, requestID: "per_synthetic", reply: "always" })
  expect(requestReply(form)).toEqual(form)
  expect(requestReply(cancel)).toEqual(cancel)
})

test("form answers keep prototype-named field keys as their own answers without changing the answer's prototype", () => {
  const reply = requestReply(JSON.parse('{"kind":"form","sessionID":"ses_synthetic","revision":3,"formID":"frm_synthetic","answer":{"__proto__":["kept"],"constructor":"also","plain":true}}'))
  if (reply.kind !== "form") throw new Error("Expected a form answer.")
  expect(Object.keys(reply.answer)).toEqual(["__proto__", "constructor", "plain"])
  expect(Object.getOwnPropertyDescriptor(reply.answer, "__proto__")?.value).toEqual(["kept"])
  expect(Object.getPrototypeOf(reply.answer)).toBe(Object.prototype)
  expect(JSON.stringify(reply.answer)).toBe('{"__proto__":["kept"],"constructor":"also","plain":true}')
})

test("request replies refuse unknown kinds, extra intent, unknown decisions and malformed answers", () => {
  const { revision: _, ...unfenced } = permission
  for (const value of [
    null,
    { ...permission, kind: "guardrail" },
    { ...permission, autonomy: "yolo" },
    { ...permission, reply: "allow" },
    unfenced,
    { ...permission, revision: -1 },
    { ...permission, revision: 1.5 },
    { ...permission, requestID: "../per" },
    { ...permission, message: "x".repeat(4097) },
    { ...form, answer: ["keep"] },
    { ...form, answer: { nested: { value: 1 } } },
    { ...form, answer: { tags: ["a", 1] } },
    { ...form, answer: { count: Number.NaN } },
    { ...cancel, answer: {} },
  ]) expect(() => requestReply(value)).toThrow(invalid)
  expect(() => requestReply({ ...permission, sessionID: "other" })).toThrow("Choose a Session.")
})

test("form answers are limited to 500000 UTF-8 bytes of JSON", () => {
  const answer = { a: "é".repeat(249_996) }
  expect(new TextEncoder().encode(JSON.stringify(answer)).length).toBe(500_000)
  expect(requestReply({ ...form, answer })).toEqual({ ...form, answer })
  expect(() => requestReply({ ...form, answer: { a: `${answer.a}é` } })).toThrow(invalid)
})

test("interrupt, pending reads and replies validate first and then require a connected backend", async () => {
  const controller = new BackendController("/nonexistent-desktop-resources")
  expect(await message(controller.interrupt("not-a-session"))).toBe("Choose a Session.")
  expect(await message(controller.reply({ ...permission, reply: "allow" }))).toBe(invalid)
  for (const pending of [controller.interrupt("ses_synthetic"), controller.requests("ses_synthetic"), controller.reply(permission), controller.reply(cancel)])
    expect(await message(pending)).toBe("Connect to a backend before using Sessions.")
})

test("an answer read under an earlier backend connection is refused on every later connection before any request", async () => {
  const resources = await syntheticBundle()
  const first: string[] = []
  const second: string[] = []
  using a = peer(first, () => 101)
  using b = peer(second, () => 202)
  const controller = new BackendController(resources, { env, launch })
  try {
    const old = revision(await controller.connect({ mode: "shared", server: a.url.href }))
    const next = revision(await controller.connect({ mode: "shared", server: b.url.href }))
    expect(next).toBeGreaterThan(old)
    for (const answer of [{ ...permission, revision: old }, { ...form, revision: old }, { ...cancel, revision: old }])
      expect(await message(controller.reply(answer))).toBe(unsent)
    await controller.disconnect()
    const again = revision(await controller.connect({ mode: "shared", server: a.url.href }))
    expect(again).toBeGreaterThan(next)
    expect(await message(controller.reply({ ...permission, revision: old }))).toBe(unsent)
    expect(await message(controller.reply({ ...cancel, revision: next }))).toBe(unsent)
    expect([...writes(first), ...writes(second)]).toEqual([])
  } finally {
    await controller.disconnect()
    await fs.rm(resources, { recursive: true, force: true })
  }
}, 30_000)

test("a same-backend reconnect reports an in-flight answer as unconfirmed and refuses the older answer before any request", async () => {
  const resources = await syntheticBundle()
  const routes: string[] = []
  let pid = 101
  const replying = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const endFirstStream = Promise.withResolvers<void>()
  using server = peer(routes, () => pid, async (route) => {
    if (route === "/api/session/ses_synthetic/permission") return Response.json({ data: [{ id: "per_synthetic", sessionID: "ses_synthetic", action: "edit", resources: [] }] })
    if (route === "/api/session/ses_synthetic/form") return Response.json({ data: [] })
    if (route !== "/api/session/ses_synthetic/permission/per_synthetic/reply") return undefined
    replying.resolve()
    await release.promise
    return new Response(null, { status: 204 })
  }, endFirstStream.promise)
  const reconnected = Promise.withResolvers<ConnectionState>()
  const controller = new BackendController(resources, { env, launch, onState: (state) => { if (state.status === "connected" && state.backendPID === 202) reconnected.resolve(state) } })
  try {
    const initial = revision(await controller.connect({ mode: "shared", server: server.url.href }))
    const pending = await controller.requests("ses_synthetic")
    expect(pending.revision).toBe(initial)
    expect(pending.permissions.map((request) => request.id)).toEqual(["per_synthetic"])
    const inFlight = message(controller.reply({ ...permission, revision: pending.revision }))
    await replying.promise
    pid = 202
    endFirstStream.resolve()
    expect(revision(await reconnected.promise)).toBeGreaterThan(initial)
    release.resolve()
    expect(await inFlight).toBe("The answer was not confirmed before the connection changed. Refresh requests to see whether it was applied.")
    const settled = writes(routes)
    expect(settled.filter((route) => route.startsWith("POST "))).toEqual(["POST /api/session/ses_synthetic/permission/per_synthetic/reply"])
    expect(await message(controller.reply({ ...permission, revision: pending.revision }))).toBe(unsent)
    expect(writes(routes)).toEqual(settled)
  } finally {
    release.resolve()
    endFirstStream.resolve()
    await controller.disconnect()
    await fs.rm(resources, { recursive: true, force: true })
  }
}, 30_000)
