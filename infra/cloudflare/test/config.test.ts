import { expect, test } from "bun:test"

test("routes relay paths to the Worker so SPA fallback cannot mask them", async () => {
  const config = await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).json()
  const first = config.assets?.run_worker_first ?? []
  expect(first).toContain("/api/*")
  expect(first).toContain("/ws/*")
  expect(first).toContain("/health")
  expect(first.some((pattern: string) => pattern.startsWith("!"))).toBe(false)
  expect(config.assets?.not_found_handling).toBe("single-page-application")
  expect(config.assets?.binding).toBe("ASSETS")
})

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
