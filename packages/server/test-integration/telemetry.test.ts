import { expect, test } from "bun:test"
import { ServerProcess } from "@ycoding-ai/server/process"
import { Database as SqliteDatabase } from "bun:sqlite"
import { Effect, Exit, Scope } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sample = {
  kind: "request",
  at: "2026-10-04T12:00:00.000Z",
  operation: "session.list",
  outcome: "ok",
  queueMs: 5,
  settlementMs: 20,
  totalMs: 25,
}

test("authenticated machine-global telemetry persists on the selected local Server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-server-telemetry-"))
  const database = join(directory, "telemetry.db")
  const port = await availablePort()
  let scope = await Effect.runPromise(Scope.make())
  const base = `http://127.0.0.1:${port}`
  const auth = { authorization: `Basic ${Buffer.from("ycoding:telemetry-test").toString("base64")}` }
  const start = async () => {
    const startup = ServerProcess.start<never, never>({
      hostname: "127.0.0.1",
      port,
      password: "telemetry-test",
      database: { path: database },
      config: { directory, project: false, content: "{}" },
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
    }).pipe(Effect.provideService(Scope.Scope, scope))
    await Effect.runPromise(startup as Effect.Effect<Effect.Success<typeof startup>, Effect.Error<typeof startup>>)
  }
  try {
    await start()
    expect((await fetch(`${base}/api/server/web-latency`)).status).toBe(401)
    expect(
      (
        await fetch(`${base}/api/server/web-latency`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ samples: [sample] }),
        })
      ).status,
    ).toBe(401)
    expect((await fetch(`${base}/api/server/telemetry/consent`)).status).toBe(401)
    expect(await fetch(`${base}/api/server/telemetry/consent`, { headers: auth }).then((r) => r.json())).toEqual({
      noticeVersion: 1,
    })
    const disabled = await fetch(`${base}/api/server/web-latency`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ samples: [sample] }),
    })
    expect(disabled.status).toBe(403)
    expect(await disabled.json()).toEqual({ _tag: "TelemetryDisabled" })
    expect(await fetch(`${base}/api/server/web-latency`, { headers: auth }).then((r) => r.json())).toEqual({
      data: [],
      cursor: {},
    })
    for (const input of [
      { enabled: true, noticeVersion: 2 },
      { enabled: true, noticeVersion: 1, extra: true },
    ])
      expect(
        (
          await fetch(`${base}/api/server/telemetry/consent`, {
            method: "PUT",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify(input),
          })
        ).status,
      ).toBe(400)
    const consent = await fetch(`${base}/api/server/telemetry/consent`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, noticeVersion: 1 }),
    }).then((r) => r.json())
    expect(consent).toEqual({ enabled: true, noticeVersion: 1, decidedAt: expect.any(Number) })
    expect(await fetch(`${base}/api/server/telemetry/consent`, { headers: auth }).then((r) => r.json())).toEqual({
      noticeVersion: 1,
      consent,
    })
    const appended = await fetch(`${base}/api/server/web-latency`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "x-ycoding-directory": "/private/other" },
      body: JSON.stringify({ samples: [sample] }),
    })
    expect(appended.status).toBe(200)
    expect(await appended.json()).toEqual({ accepted: 1 })
    for (const body of [
      { samples: [] },
      { samples: Array.from({ length: 21 }, () => sample) },
      { samples: [{ ...sample, at: "2026-02-30T12:00:00.000Z" }] },
      { samples: [{ ...sample, settlementMs: 19 }] },
      { samples: [{ ...sample, receivedAt: 1 }] },
      { samples: [{ ...sample, operation: "session.private-id" }] },
      { samples: [sample], sessionID: "ses_foreign" },
    ]) {
      const rejected = await fetch(`${base}/api/server/web-latency`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      expect(rejected.status).toBe(400)
    }
    for (const query of ["?limit=201", "?before=not-a-cursor", "?sessionID=ses_foreign"])
      expect((await fetch(`${base}/api/server/web-latency${query}`, { headers: auth })).status).toBe(400)
    const listed = await fetch(`${base}/api/server/web-latency`, { headers: auth })
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({ data: [{ receivedAt: expect.any(Number), sample }], cursor: {} })
    const task = { kind: "client", at: sample.at, surface: "web", metric: "transcript.load", durationMs: 70 }
    const second = await fetch(`${base}/api/server/web-latency`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ samples: [task] }),
    })
    expect(await second.json()).toEqual({ accepted: 1 })
    const newest = await fetch(`${base}/api/server/web-latency?limit=1`, { headers: auth })
    const page: unknown = await newest.json()
    expect(page).toMatchObject({ data: [{ receivedAt: expect.any(Number), sample: task }] })
    if (
      typeof page !== "object" ||
      page === null ||
      !("cursor" in page) ||
      typeof page.cursor !== "object" ||
      page.cursor === null ||
      !("next" in page.cursor) ||
      typeof page.cursor.next !== "string"
    )
      throw new Error("Telemetry page cursor was missing")
    const cursor = page.cursor.next
    expect(
      await fetch(`${base}/api/server/web-latency?limit=1&before=${cursor}`, { headers: auth }).then((r) => r.json()),
    ).toMatchObject({ data: [{ receivedAt: expect.any(Number), sample }] })

    await Effect.runPromise(Scope.close(scope, Exit.void))
    scope = await Effect.runPromise(Scope.make())
    await start()
    const reopened = await fetch(`${base}/api/server/web-latency`, { headers: auth })
    expect((await reopened.json()).data).toHaveLength(2)
    expect(await fetch(`${base}/api/server/telemetry/consent`, { headers: auth }).then((r) => r.json())).toEqual({
      noticeVersion: 1,
      consent,
    })
    await fetch(`${base}/api/server/telemetry/consent`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, noticeVersion: 1 }),
    })
    expect(
      (
        await fetch(`${base}/api/server/web-latency`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ samples: [sample] }),
        })
      ).status,
    ).toBe(403)

    await Effect.runPromise(Scope.close(scope, Exit.void))
    const stale = new SqliteDatabase(database)
    stale.query("UPDATE web_latency SET received_at = 0 WHERE id = 1").run()
    stale.close()
    scope = await Effect.runPromise(Scope.make())
    await start()
    const afterBoot = new SqliteDatabase(database, { readonly: true })
    expect(afterBoot.query<{ count: number }, []>("SELECT count(*) AS count FROM web_latency").get()?.count).toBe(1)
    afterBoot.close()
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Failed to reserve telemetry port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}
