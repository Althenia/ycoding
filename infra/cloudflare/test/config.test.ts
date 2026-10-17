import { expect, test } from "bun:test"

test("adopts the existing production Worker, only the requested Cloudflare resources, and Worker-first relay routes the SPA fallback cannot mask", async () => {
  const config = await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).json()
  expect(config).toMatchObject({
    name: "ycoding-cloud",
    compatibility_date: "2026-09-20",
    workers_dev: true,
    preview_urls: false,
    routes: [{ pattern: "ycoding.althenia.app", custom_domain: true }],
    d1_databases: [
      { binding: "DB", database_name: "ycoding-prod-db", database_id: "3384fc56-42d6-40a1-af04-5a75bd391132" },
    ],
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

test("beta selects an isolated Worker, domain, D1 and same-Worker Durable Object namespaces while inheriting assets and exports", async () => {
  const config = await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).json()
  expect(Object.keys(config.env)).toEqual(["beta"])
  expect(config.env.beta).toEqual({
    name: "ycoding-cloud-beta",
    routes: [{ pattern: "beta.ycoding.althenia.app", custom_domain: true }],
    d1_databases: [
      { binding: "DB", database_name: "ycoding-beta-db", database_id: "3f94c84b-4b74-4e9f-af3f-fae112369930" },
    ],
    durable_objects: { bindings: [{ name: "DEVICE_RELAY", class_name: "DeviceRelay" }] },
  })
  expect(config.env.beta.name).not.toBe(config.name)
  expect(config.env.beta.d1_databases[0].database_id).not.toBe(config.d1_databases[0].database_id)
  expect(config.env.beta.assets).toBeUndefined()
  expect(config.env.beta.exports).toBeUndefined()
  expect(config.env.beta.migrations).toBeUndefined()
  expect(config.env.beta.durable_objects.bindings[0].script_name).toBeUndefined()
  expect(config.env.beta.durable_objects.bindings[0].environment).toBeUndefined()
})
