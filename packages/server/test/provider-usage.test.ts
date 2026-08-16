import { expect, test } from "bun:test"
import { ProviderUsage, ProviderUsageV2 } from "@ycoding-ai/core/provider-usage"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { Effect } from "effect"
import { getProviderUsage, listProviderUsage, ProviderUsageHandler } from "../src/handlers/provider-usage"

const openai = ProviderV2.ID.make("openai")
const snapshot = new ProviderUsage.Snapshot({
  providerID: openai,
  label: "Codex",
  status: "available",
  source: "provider_internal_api",
  stability: "best_effort",
  updatedAt: 100,
  windows: [new ProviderUsage.Window({ id: "codex-primary", label: "5-hour", unit: "percent", used: 25 })],
})

test("provider usage handlers forward refresh and return normalized snapshots", async () => {
  const calls: unknown[] = []
  const service = ProviderUsageV2.Service.of({
    get: (input) =>
      Effect.sync(() => {
        calls.push(["get", input])
        return snapshot
      }),
    list: (input) =>
      Effect.sync(() => {
        calls.push(["list", input])
        return [snapshot]
      }),
    observe: () => Effect.die("unused"),
  })

  expect(await Effect.runPromise(listProviderUsage(service, true))).toEqual([snapshot])
  expect(await Effect.runPromise(getProviderUsage(service, openai, false))).toEqual(snapshot)
  expect(calls).toEqual([
    ["list", { refresh: true }],
    ["get", { providerID: openai, refresh: false }],
  ])
  expect(JSON.stringify(snapshot)).not.toContain("credential")
  expect(ProviderUsageHandler).toBeDefined()
})

test("provider usage handler registers list and provider routes", async () => {
  const source = await Bun.file(new URL("../src/handlers/provider-usage.ts", import.meta.url)).text()
  expect(source).toContain('"providerUsage.list"')
  expect(source).toContain('"providerUsage.get"')
})
