import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { sha256Hex } from "@ycoding-ai/remote"
import { previewHarness, previewOrigins } from "./remote-app-preview-harness"

const routes = [{ path: "/", match: "prefix", methods: ["GET", "HEAD"] }]
const appPreview = { origins: previewOrigins, ports: [41234], frameAncestors: [] }
const register = (h: ReturnType<typeof previewHarness>, port = 41234) =>
  h.call("local_app_register", { host: "127.0.0.1", port, entryPath: "/", routes }).then((result) => result.structuredContent as { id: string; generation: string })

test("preview stays disabled without operator configuration and sends no preview frame", async () => {
  const h = previewHarness()
  try {
    await h.connect()
    const app = await register(h)
    const opened = await h.call("local_app_open", { id: app.id, generation: app.generation })
    expect(opened.structuredContent).toMatchObject({ status: "unavailable", reason: "preview_unconfigured" })
    expect(opened._meta?.localApp).toBeUndefined()
    expect(h.frames().filter((frame) => frame.type.startsWith("preview."))).toEqual([])
    expect(h.bindings()).toEqual([])
  } finally { await h.bridge.close() }
})

test("a relay with an empty or different origin list keeps preview unconfigured", async () => {
  for (const relayOrigins of [[], [previewOrigins[0]!]]) {
    const h = previewHarness({ appPreview, relayOrigins })
    try {
      await h.connect()
      const app = await register(h)
      expect((await h.call("local_app_open", { id: app.id, generation: app.generation })).structuredContent).toMatchObject({ reason: "preview_unconfigured" })
      expect(h.frames().filter((frame) => frame.type === "preview.allocate" || frame.type === "preview.lease")).toEqual([])
      expect(h.bindings()).toEqual([])
    } finally { await h.bridge.close() }
  }
})

test("only allowlisted loopback ports receive an origin, and frames carry digests rather than app IDs or tickets", async () => {
  const h = previewHarness({ appPreview })
  try {
    await h.connect()
    const blocked = await register(h, 41235)
    const refused = await h.call("local_app_open", { id: blocked.id, generation: blocked.generation })
    expect(refused.isError).toBe(true)
    expect(h.frames().filter((frame) => frame.type === "preview.allocate" || frame.type === "preview.lease")).toEqual([])
    const app = await register(h)
    const opened = await h.call("local_app_open", { id: app.id, generation: app.generation })
    expect(opened.structuredContent).toMatchObject({ status: "ready" })
    const url = new URL(opened._meta!.localApp!.url)
    expect(url.origin).toBe(previewOrigins[0])
    const ticket = url.searchParams.get("ticket")!
    const registration = await sha256Hex(`${app.id}:${app.generation}`)
    const allocate = h.frames().find((frame) => frame.type === "preview.allocate")!
    const lease = h.frames().find((frame) => frame.type === "preview.lease")!
    expect(allocate).toEqual({ type: "preview.allocate", id: allocate.id, registration, expiresAt: allocate.expiresAt })
    expect(lease).toEqual({ type: "preview.lease", id: lease.id, origin: previewOrigins[0], ticketHash: await sha256Hex(ticket), leaseTag: lease.leaseTag, registration, expiresAt: lease.expiresAt })
    const preview = JSON.stringify(h.frames().filter((frame) => frame.type.startsWith("preview.")))
    expect(preview).not.toContain(ticket)
    expect(preview).not.toContain(app.id)
    await h.bridge.close()
    expect(h.leases()).toBe(0)
    expect(h.bindings()).toEqual([{ origin: previewOrigins[0]!, ended: 1 }])
    expect((await h.worker(new Request(url.toString()))).status).toBe(410)
  } finally { await h.bridge.close() }
})

test("each registration receives its own single-use origin; revocation and restart never free one; an exhausted pool fails closed", async () => {
  const database = new Database(":memory:")
  const h = previewHarness({ appPreview, database })
  let first: URL
  try {
    await h.connect()
    const a = await register(h)
    first = new URL((await h.call("local_app_open", { id: a.id, generation: a.generation }))._meta!.localApp!.url)
    const reopened = new URL((await h.call("local_app_open", { id: a.id, generation: a.generation }))._meta!.localApp!.url)
    expect(reopened.origin).toBe(first.origin)
    expect((await h.worker(new Request(first.toString()))).status).toBe(401)
    await h.call("local_app_revoke", { id: a.id })
    expect((await h.worker(new Request(reopened.toString()))).status).toBe(410)
    const b = await register(h)
    const second = new URL((await h.call("local_app_open", { id: b.id, generation: b.generation }))._meta!.localApp!.url)
    expect(second.origin).toBe(previewOrigins[1])
  } finally { await h.bridge.close() }
  const restarted = previewHarness({ appPreview, database })
  try {
    await restarted.connect()
    const c = await register(restarted)
    const exhausted = await restarted.call("local_app_open", { id: c.id, generation: c.generation })
    expect(exhausted.isError).toBe(true)
    expect(JSON.stringify(exhausted)).toContain("preview_exhausted")
    expect(exhausted._meta?.localApp).toBeUndefined()
    expect(restarted.bindings().map((binding) => binding.origin)).toEqual(previewOrigins)
    expect((await restarted.worker(new Request(first!.toString()))).status).toBe(410)
  } finally { await restarted.bridge.close() }
  expect(h.relayed).toEqual([])
})
