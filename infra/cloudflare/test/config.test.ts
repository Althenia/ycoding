import { expect, test } from "bun:test"

test("adopts the existing production Worker and only the requested Cloudflare resources", async () => {
  const config = await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).json()
  expect(config).toMatchObject({
    name: "ycoding-cloud",
    compatibility_date: "2026-09-20",
    workers_dev: true,
    preview_urls: false,
    routes: [{ pattern: "ycoding.althenia.app", custom_domain: true }],
    d1_databases: [{ binding: "DB", database_name: "ycoding-prod-db" }],
    durable_objects: { bindings: [{ name: "DEVICE_RELAY", class_name: "DeviceRelay" }] },
    exports: { DeviceRelay: { type: "durable-object", storage: "sqlite" } },
  })
  expect(config.migrations).toBeUndefined()
  expect(JSON.stringify(config)).not.toContain("api.ycoding.althenia.app")
  expect(JSON.stringify(config)).not.toContain("relay.ycoding.althenia.app")
})
