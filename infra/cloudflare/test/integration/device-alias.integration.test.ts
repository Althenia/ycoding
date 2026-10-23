import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"

test("local workerd and D1 retain owner-shared aliases across clients and restart", async () => {
  const root = new URL("../../../../", import.meta.url).pathname
  await mkdir(path.join(root, ".cache/tmp"), { recursive: true })
  const home = await mkdtemp(path.join(root, ".cache/tmp/device-alias-"))
  const config = path.join(home, "wrangler.json")
  const persist = path.join(home, "state")
  const migrations = path.join(home, "migrations")
  const wrangler = path.join(root, "node_modules/.bin/wrangler")
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" }
  let worker: ReturnType<typeof Bun.spawn> | undefined
  const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) })
  const port = reserved.port
  const origin = `http://127.0.0.1:${port}`
  reserved.stop(true)
  const command = async (args: readonly string[]) => {
    const process = Bun.spawn([wrangler, ...args, "--config", config, "--local", "--persist-to", persist], { cwd: root, env, stdout: "ignore", stderr: "pipe" })
    const error = await new Response(process.stderr).text()
    expect(await process.exited, error.slice(-2000)).toBe(0)
  }
  const start = async () => {
    worker = Bun.spawn([wrangler, "dev", "--config", config, "--local", "--persist-to", persist, "--port", String(port)], { cwd: root, env, stdout: "ignore", stderr: "ignore" })
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (await fetch(`${origin}/health`).then((response) => response.ok, () => false)) return
      await Bun.sleep(100)
    }
    throw new Error("The local alias Worker did not become ready")
  }
  try {
    await mkdir(migrations)
    for (const name of (await readdir(path.join(root, "infra/cloudflare/migrations"))).filter((name) => name.endsWith(".sql") && name < "0008_device_alias.sql"))
      await Bun.write(path.join(migrations, name), Bun.file(path.join(root, "infra/cloudflare/migrations", name)))
    await Bun.write(config, JSON.stringify({ name: "ycoding-alias-local", main: path.join(root, "infra/cloudflare/src/index.ts"), compatibility_date: "2026-09-20",
      d1_databases: [{ binding: "DB", database_name: "alias-local", database_id: "00000000-0000-0000-0000-000000000001", migrations_dir: migrations }],
      durable_objects: { bindings: [{ name: "DEVICE_RELAY", class_name: "DeviceRelay" }, { name: "PREVIEW_DIRECTORY", class_name: "PreviewDirectory" }] },
      migrations: [{ tag: "local-v1", new_sqlite_classes: ["DeviceRelay", "PreviewDirectory"] }],
    }))
    await command(["d1", "migrations", "apply", "alias-local"])
    const seed = path.join(home, "seed.sql")
    const publicKey = JSON.stringify({ kty: "EC", crv: "P-256", x: "A".repeat(43), y: "A".repeat(43) })
    await Bun.write(seed, `INSERT INTO "user" (id, created_at) VALUES ('owner', 1), ('other', 1);
      INSERT INTO device (id, user_id, name, public_key_jwk, key_algorithm, created_at) VALUES ('dev_one', 'owner', 'synthetic-host.local', '${publicKey}', 'P-256', 1);
      INSERT INTO browser_session (id, user_id, created_at, expires_at) VALUES
        ('${createHash("sha256").update("synthetic-owner-one").digest("hex")}', 'owner', 1, ${Date.now() + 600_000}),
        ('${createHash("sha256").update("synthetic-owner-two").digest("hex")}', 'owner', 1, ${Date.now() + 600_000}),
        ('${createHash("sha256").update("synthetic-other").digest("hex")}', 'other', 1, ${Date.now() + 600_000});`)
    await command(["d1", "execute", "alias-local", "--file", seed])
    await Bun.write(path.join(migrations, "0008_device_alias.sql"), Bun.file(path.join(root, "infra/cloudflare/migrations/0008_device_alias.sql")))
    await command(["d1", "migrations", "apply", "alias-local"])
    await start()
    const patch = (alias: string | null, token = "synthetic-owner-one", requestOrigin = origin) => fetch(`${origin}/api/devices/dev_one/alias`, {
      method: "PATCH", headers: { origin: requestOrigin, cookie: `yc_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ alias }),
    })
    const read = async (token: string) => {
      const response = await fetch(`${origin}/api/me`, { headers: { cookie: `yc_session=${token}` } })
      expect(response.status).toBe(200)
      return await response.json() as { devices: { id: string; name: string; alias: string | null; online: boolean }[] }
    }
    expect((await read("synthetic-owner-one")).devices[0]).toMatchObject({ id: "dev_one", name: "synthetic-host.local", alias: null, online: false })
    expect((await patch("Studio")).status).toBe(200)
    expect((await read("synthetic-owner-two")).devices[0]).toMatchObject({ alias: "Studio", name: "synthetic-host.local" })
    expect((await patch("Denied", "synthetic-other")).status).toBe(404)
    expect((await read("synthetic-other")).devices).toEqual([])
    expect((await patch("Denied", "synthetic-owner-one", "https://other.test")).status).toBe(403)
    expect((await patch("x".repeat(49))).status).toBe(400)
    worker?.kill()
    if (worker) await worker.exited
    await start()
    expect((await read("synthetic-owner-two")).devices[0]).toMatchObject({ alias: "Studio", name: "synthetic-host.local" })
    expect((await patch(null)).status).toBe(200)
    expect((await read("synthetic-owner-two")).devices[0]).toMatchObject({ alias: null, name: "synthetic-host.local" })
  } finally {
    worker?.kill()
    if (worker) await worker.exited
    await rm(home, { recursive: true, force: true })
  }
}, 120_000)
