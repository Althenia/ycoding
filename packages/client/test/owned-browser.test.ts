import { expect, test } from "bun:test"
import { YCoding } from "../src/promise/index"

test("owned-tab lifecycle carries the Session and call fences through generated routes", async () => {
  const requests: Request[] = []
  const tab = {
    id: "btab_owned",
    sessionID: "ses_owner",
    title: "Fixture",
    page: { origin: "https://example.test", path: "/fixture" },
    status: "shared" as const,
    generation: 3,
    documentGeneration: 1,
    observationRevision: 0,
    mode: "owned" as const,
  }
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      if (new URL(request.url).pathname.endsWith("/close")) return new Response(null, { status: 204 })
      return Response.json({ data: tab })
    },
  })

  expect(await client.browser.open({ sessionID: "ses_owner", generation: 3, url: "https://example.test/fixture", callID: "call_open" })).toEqual(tab)
  await client.browser.close({ sessionID: "ses_owner", tabID: tab.id, generation: 3, callID: "call_close" })

  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ["POST", "/api/session/ses_owner/browser/open"],
    ["POST", "/api/session/ses_owner/browser/close"],
  ])
  expect(await requests[0].json()).toEqual({ generation: 3, url: "https://example.test/fixture", callID: "call_open" })
  expect(await requests[1].json()).toEqual({ tabID: "btab_owned", generation: 3, callID: "call_close" })
})

test("failed owned-tab creation is not retried or redirected to selected tabs", async () => {
  const requests: Request[] = []
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      requests.push(input instanceof Request ? input : new Request(input, init))
      return new Response("Unavailable", { status: 503 })
    },
  })

  await expect(client.browser.open({ sessionID: "ses_owner", generation: 3, url: "https://example.test/fixture", callID: "call_open" })).rejects.toThrow()
  expect(requests).toHaveLength(1)
  expect(new URL(requests[0].url).pathname).toBe("/api/session/ses_owner/browser/open")
})

test("profile control release carries the tab, generation, and call fences and tabs expose the lease", async () => {
  const requests: Request[] = []
  const tab = {
    id: "btab_profile",
    sessionID: "ses_holder",
    title: "Fixture",
    page: { origin: "https://example.test", path: "/fixture" },
    status: "shared" as const,
    generation: 3,
    documentGeneration: 1,
    observationRevision: 0,
    mode: "profile" as const,
    lease: "other" as const,
  }
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      if (new URL(request.url).pathname.endsWith("/release")) return new Response(null, { status: 204 })
      return Response.json({ data: [tab] })
    },
  })

  expect(await client.browser.tabs({ sessionID: "ses_holder" })).toEqual([tab])
  await client.browser.release({ sessionID: "ses_holder", tabID: tab.id, generation: 3, callID: "call_release" })

  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ["GET", "/api/session/ses_holder/browser/tabs"],
    ["POST", "/api/session/ses_holder/browser/release"],
  ])
  expect(await requests[1].json()).toEqual({ tabID: "btab_profile", generation: 3, callID: "call_release" })
})
