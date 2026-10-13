import { spawn } from "bun"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { create, encodeStrict, CompletionsSchema } from "../../../../packages/protocol/src/v5"

const root = path.resolve(import.meta.dir, "../../../..")
const wrangler = path.join(root, "node_modules/.bin/wrangler")
const home = mkdtempSync(path.join(root, "infra/cloudflare/.notice-store-"))
const entry = path.join(home, "worker.js")
const config = path.join(home, "wrangler.json")
const persist = path.join(home, "state")
const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("reserved") })
const port = reservation.port
reservation.stop(true)
const origin = `http://127.0.0.1:${port}`
let worker: ReturnType<typeof spawn> | undefined

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
async function start() {
  worker = spawn([wrangler, "dev", "--local", "--config", config, "--persist-to", persist, "--port", String(port)], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/health`)).status === 200) return
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error("Notice-store workerd readiness deadline exceeded")
}

try {
  mkdirSync(path.join(home, "assets"))
  await Bun.write(path.join(home, "assets/index.html"), "<!doctype html><title>Local notice fixture</title>")
  await Bun.write(
    entry,
    `
import { DurableObject } from "cloudflare:workers"
import { createNoticeStore } from ${JSON.stringify(path.join(root, "infra/cloudflare/src/relay/notice-store.ts"))}
import { decodeStrict, CompletionsSchema } from ${JSON.stringify(path.join(root, "packages/protocol/src/v5/index.ts"))}
export class DeviceRelay extends DurableObject {
  fail = false
  store = createNoticeStore({ sql: this.ctx.storage.sql, kv: this.ctx.storage.kv, transactionSync: (operation) => this.ctx.storage.transactionSync(() => {
    const value = operation()
    if (this.fail) { this.fail = false; throw new Error("Synthetic commit failure") }
    return value
  }) })
  async fetch(request) {
    if (new URL(request.url).pathname === "/api/fixture-clear") { this.store.clear(); return Response.json({ page: this.store.page() }) }
    const bytes = new Uint8Array(await request.arrayBuffer())
    if (bytes.length > 65536) return new Response(null, { status: 413 })
    const value = decodeStrict(CompletionsSchema, bytes)
    if (value.items.some((item) => item.sequence > BigInt(Number.MAX_SAFE_INTEGER) || item.createdMs > BigInt(Number.MAX_SAFE_INTEGER))) return new Response(null, { status: 413 })
    this.fail = request.headers.get("x-fixture-fail") === "1"
    try {
      const recorded = this.store.complete(value.items.map((item) => ({ id: item.id, sessionID: item.sessionId, seq: Number(item.sequence), created: Number(item.createdMs) })), value.more)
      return Response.json({ page: this.store.page(), recorded, failed: false })
    } catch { return Response.json({ page: this.store.page(), failed: true }) }
  }
}
export default { async fetch(request, env) {
  if (new URL(request.url).pathname === "/health") { await env.DB.prepare("SELECT 1").first(); return new Response("ready") }
  return env.DEVICE_RELAY.getByName("notice-store-fixture").fetch(request)
} }
`,
  )
  const original = await Bun.file(path.join(root, "infra/cloudflare/wrangler.jsonc")).json()
  await Bun.write(
    config,
    JSON.stringify({
      ...original,
      main: entry,
      routes: [],
      assets: { ...original.assets, directory: path.join(home, "assets") },
    }),
  )
  await start()
  const receipt = (sessionId: string, sequence: bigint) => ({
    id: `evt_${sessionId}_${sequence}`,
    sessionId,
    sequence,
    createdMs: 1000n + sequence,
  })
  const call = async (items: ReturnType<typeof receipt>[], more = false, fail = false) => {
    const response = await fetch(origin, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf", "x-fixture-fail": fail ? "1" : "0" },
      body: encodeStrict(CompletionsSchema, create(CompletionsSchema, { items, more })),
    })
    check(response.status === 200, "Notice fixture rejected valid typed receipts")
    return (await response.json()) as {
      page: { total: number; notices: { id: string; sessionID: string }[] }
      recorded?: { notices: { id: string }[] }
      failed: boolean
    }
  }
  check(
    (
      await call(
        Array.from({ length: 200 }, (_, index) => receipt(`ses_${index}`, 10n)),
        true,
      )
    ).page.total === 0,
    "First baseline page notified",
  )
  check((await call([], true)).page.total === 0, "Empty baseline page notified")
  check((await call([receipt("ses_last", 50n)])).page.total === 0, "Final baseline page notified")
  const live = await call([receipt("ses_0", 11n), receipt("ses_new", 1n)])
  check(
    live.page.total === 2 && live.recorded?.notices.length === 2,
    "New completion receipts did not append exactly once",
  )
  check(
    (await call([receipt("ses_0", 11n), receipt("ses_last", 49n)])).recorded?.notices.length === 0,
    "Duplicate or older receipt notified",
  )
  const failed = await call([receipt("ses_0", 12n)], false, true)
  check(failed.failed && failed.page.total === 2, "KV+SQL transaction failure changed persistent notices")
  const retry = await call([receipt("ses_0", 12n)])
  check(
    retry.page.total === 3 && retry.recorded?.notices[0]?.id === "ntc_3",
    "Rolled-back receipt did not retry exactly once",
  )
  const cleared = await fetch(`${origin}/api/fixture-clear`, { method: "POST" })
  check(
    cleared.status === 200 && ((await cleared.json()) as { page: { total: number } }).page.total === 0,
    "Clear did not remove notices",
  )
  worker?.kill()
  if (worker) await worker.exited
  await start()
  const restored = await call([receipt("ses_0", 12n), receipt("ses_new", 1n)])
  check(restored.page.total === 0 && restored.recorded?.notices.length === 0, "Restart/readAll erased completion dedup")
  const newer = await call([receipt("ses_0", 13n)])
  check(
    newer.page.total === 1 && newer.recorded?.notices[0]?.id === "ntc_4",
    "Restart lost the baseline marker or monotonic notice identity",
  )
  console.log(
    "1 passed, 0 failed: real workerd notice SQLite/KV rollback, retry, paged silent baseline, typed completion receipts, clear and process restart",
  )
} finally {
  worker?.kill()
  if (worker) await worker.exited
  rmSync(home, { recursive: true, force: true })
}
