import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigCoordination } from "../src/config/coordination"

test("global coordination decisions default on without rewriting autonomy flags", () => {
  expect(ConfigCoordination.resolve()).toEqual({ enabled: true, categories: ["question", "permission", "review"] })
  expect(ConfigCoordination.resolve({ delegated_decisions: { enabled: false } }).enabled).toBe(false)
  expect(ConfigCoordination.resolve({ delegated_decisions: { categories: ["question"] } }).categories).toEqual(["question"])
})

test("group policy can narrow a global decision grant but never broaden or restore it", () => {
  const request = { category: "permission" as const, action: "read", resources: ["src/a.ts"], now: 10 }
  const global = ConfigCoordination.resolve()
  expect(ConfigCoordination.permits(global, undefined, request)).toBe(true)
  expect(ConfigCoordination.permits(global, { categories: ["question"] }, request)).toBe(false)
  expect(ConfigCoordination.permits(global, { categories: ["permission"], resources: ["src/*"] }, request)).toBe(true)
  expect(ConfigCoordination.permits(global, { categories: ["permission"], resources: ["tests/*"] }, request)).toBe(false)
  expect(ConfigCoordination.permits(global, { categories: [] }, request)).toBe(false)
  expect(ConfigCoordination.permits(ConfigCoordination.resolve({ delegated_decisions: { enabled: false } }), { categories: ["permission"] }, request)).toBe(false)
  expect(ConfigCoordination.permits(global, { categories: ["permission"], expiresAt: 10 }, request)).toBe(false)
})

test("global resource and action limits remain authoritative and all targets must match", () => {
  const global = ConfigCoordination.resolve({ delegated_decisions: { actions: ["read"], resources: ["src/*"] } })
  expect(ConfigCoordination.permits(global, undefined, { category: "permission", action: "write", resources: ["src/a.ts"], now: 0 })).toBe(false)
  expect(ConfigCoordination.permits(global, undefined, { category: "permission", action: "read", resources: ["src/a.ts", "outside/a.ts"], now: 0 })).toBe(false)
  expect(ConfigCoordination.permits(global, { categories: ["permission"], resources: ["*"] }, { category: "permission", action: "read", resources: ["outside/a.ts"], now: 0 })).toBe(false)
})

test("coordination decision config rejects malformed authority instead of widening it", () => {
  const decode = Schema.decodeUnknownSync(ConfigCoordination.Info, { onExcessProperty: "error" })
  for (const delegated_decisions of [{ enabled: 1 }, { categories: ["hard-review"] }, { actions: [""] }, { resources: Array(33).fill("*") }, { expires_at: -1 }])
    expect(() => decode({ delegated_decisions })).toThrow()
})
