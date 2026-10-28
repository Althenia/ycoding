import { expect, test } from "bun:test"
import { createLocalServer } from "../src/remote-local"

test("local dashboard adapter posts the composed input once and returns every status unchanged", async () => {
  const requests: { path: string; method: string; body: unknown; directory: string | null }[] = []
  const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  const readyWithQuota = { status: "ready" as const, asOf: 5, revision: "r1", summary: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens }, quota: { status: "preparing" as const }, live: { asOf: 5, active: 0, streaming: 0, models: [], history: [] } }
  const answers: unknown[] = [{ status: "preparing" }, { status: "error", message: "failed" }, readyWithQuota]
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push({ path: new URL(request.url).pathname, method: request.method, body: await request.json(), directory: request.headers.get("x-ycoding-directory") })
    return Response.json({ data: answers.shift() })
  } })
  try {
    const local = createLocalServer({ url: server.url.href, auth: { type: "basic", username: "ycoding", password: "fixture" } })
    const input = { daily: { group: "day" as const, timeZone: "UTC" }, monthly: { group: "month" as const }, breakdown: { group: "provider-model" as const, limit: 25 }, refresh: true }
    expect(await local.usageDashboard(input)).toEqual({ status: "preparing" })
    expect(await local.usageDashboard(input)).toEqual({ status: "error", message: "failed" })
    expect(await local.usageDashboard({ breakdown: input.breakdown })).toEqual(readyWithQuota)
    expect(requests.map((request) => request.body)).toEqual([input, input, { breakdown: input.breakdown }])
    expect(requests.every((request) => request.path === "/api/usage/dashboard" && request.method === "POST" && request.directory === null)).toBe(true)
  } finally { await server.stop(true) }
})

test("local accounting adapter preserves generated query arrays, filters and backend-resolved Locations", async () => {
  const requests: { path: string; query: Record<string, string[]>; directory: string | null }[] = []
  const empty = { requests: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: { pricedRequests: 0, unpricedRequests: 0 } }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url)
    requests.push({ path: url.pathname, query: Object.fromEntries([...new Set(url.searchParams.keys())].map((key) => [key, url.searchParams.getAll(key)])), directory: request.headers.get("x-ycoding-directory") })
    if (url.pathname.endsWith("/prompts")) return Response.json({ data: { units: [], unattributed: empty, history: "retained" } })
    if (url.pathname.endsWith("/tasks")) return Response.json({ data: { tasks: [], total: empty, history: "retained" } })
    if (url.pathname.endsWith("/forecast")) return Response.json({ location: { directory: "/verified", project: { id: "prj_1", directory: "/verified" } }, data: { asOf: 1, localScope: url.searchParams.get("localScope"), localRates: [], quotas: [] } })
    return Response.json({ data: { group: "profile", rows: [], total: {}, rowCount: 0 } })
  } })
  try {
    const local = createLocalServer({ url: server.url.href, auth: { type: "basic", username: "ycoding", password: "fixture" } })
    await local.promptCosts("ses_root", { directory: "/verified" }, ["msg_first", "msg_second"])
    await local.taskCosts("ses_root", { directory: "/verified" }, ["ses_child", "ses_nested"])
    await local.sessionUsageReport("ses_root", { directory: "/verified" }, { group: "profile", providerID: "openai", profile: "Work", modelID: "shared", selectedEffort: "high" })
    await local.usageForecast("location", { directory: "/verified" })
    await local.usageForecast("backend")
    expect(requests[0]).toMatchObject({ path: "/api/session/ses_root/usage/prompts", query: { inputIDs: ["msg_first", "msg_second"] }, directory: "%2Fverified" })
    expect(requests[1]).toMatchObject({ path: "/api/session/ses_root/usage/tasks", query: { sessionIDs: ["ses_child", "ses_nested"] }, directory: "%2Fverified" })
    expect(requests[2]?.query).toEqual({ group: ["profile"], providerID: ["openai"], profile: ["Work"], modelID: ["shared"], selectedEffort: ["high"] })
    expect(requests[3]).toMatchObject({ path: "/api/provider/usage/forecast", query: { localScope: ["location"] }, directory: "%2Fverified" })
    expect(requests[4]).toMatchObject({ path: "/api/provider/usage/forecast", query: { localScope: ["backend"] }, directory: null })
  } finally { await server.stop(true) }
})
