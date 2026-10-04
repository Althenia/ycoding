import { expect, test } from "bun:test"

test("adopts the existing production Worker, only the requested Cloudflare resources, and Worker-first relay routes the SPA fallback cannot mask", async () => {
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
  expect(config.assets).toEqual({
    directory: "../../apps/web/dist",
    binding: "ASSETS",
    not_found_handling: "single-page-application",
    run_worker_first: [
      "/api",
      "/api/*",
      "/ws",
      "/ws/*",
      "/health",
      "/remote",
      "/remote/*",
      "/docs",
      "/docs/*",
      "/changelog",
      "/changelog/*",
      "/",
    ],
  })
  expect(JSON.stringify(config)).not.toContain("_redirects")
  expect(JSON.stringify(config)).not.toContain("api.ycoding.althenia.app")
  expect(JSON.stringify(config)).not.toContain("relay.ycoding.althenia.app")
})
