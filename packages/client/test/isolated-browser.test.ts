import { expect, test } from "bun:test"
import { compile } from "@ycoding-ai/httpapi-codegen"
import { ClientApi, groupNames, promiseOmitEndpoints } from "@ycoding-ai/protocol/client"
import { YCoding } from "../src/promise/index"

test("isolated browser start remains compilable by the owning client generator", () => {
  const contract = compile(ClientApi, { groupNames, omitEndpoints: promiseOmitEndpoints })

  expect(
    contract.groups
      .find((group) => group.identifier === "isolatedBrowser")
      ?.endpoints.some((endpoint) => endpoint.endpoint.identifier === "isolatedBrowser.start"),
  ).toBe(true)
})

test("isolated lifecycle uses its own Session-location routes without pairing", async () => {
  const requests: Request[] = []
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      return Response.json({ data: { mode: "isolated", state: "stopped" } })
    },
  })
  const scope = { sessionID: "ses_isolated" }

  expect(await client.isolatedBrowser.status(scope)).toEqual({ mode: "isolated", state: "stopped" })
  await client.isolatedBrowser.start({ ...scope, url: "http://localhost:8080/fixture" })
  await client.isolatedBrowser.control({ ...scope, action: "pause" })
  await client.isolatedBrowser.control({ ...scope, action: "resume" })
  await client.isolatedBrowser.stop(scope)

  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ["GET", "/api/session/ses_isolated/browser/isolated"],
    ["POST", "/api/session/ses_isolated/browser/isolated/start"],
    ["POST", "/api/session/ses_isolated/browser/isolated/control"],
    ["POST", "/api/session/ses_isolated/browser/isolated/control"],
    ["DELETE", "/api/session/ses_isolated/browser/isolated"],
  ])
  expect(await requests[1].json()).toEqual({ url: "http://localhost:8080/fixture" })
  expect(await requests[2].json()).toEqual({ action: "pause" })
  expect(await requests[3].json()).toEqual({ action: "resume" })
})

test("isolated action transmits instance and freshness fences without changing call identity", async () => {
  const requests: Request[] = []
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      requests.push(input instanceof Request ? input : new Request(input, init))
      return Response.json({ data: { mode: "isolated", status: "uncertain", callID: "call_original" } })
    },
  })
  const input = {
    sessionID: "ses_isolated",
    instanceID: "ib_0123456789abcdef",
    tabID: "btab_0123456789abcdef",
    generation: 3,
    documentGeneration: 4,
    observationRevision: 5,
    callID: "call_original",
    action: { type: "click" as const, ref: "e1" },
  }

  expect(await client.isolatedBrowser.action(input)).toEqual({
    mode: "isolated",
    status: "uncertain",
    callID: "call_original",
  })
  expect(requests).toHaveLength(1)
  expect(new URL(requests[0].url).pathname).toBe("/api/session/ses_isolated/browser/isolated/action")
  expect(await requests[0].json()).toEqual({
    instanceID: input.instanceID,
    tabID: input.tabID,
    generation: 3,
    documentGeneration: 4,
    observationRevision: 5,
    callID: "call_original",
    action: { type: "click", ref: "e1" },
  })
})

test("failed isolated start is not replayed or redirected to selected-tab pairing", async () => {
  const requests: Request[] = []
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      requests.push(input instanceof Request ? input : new Request(input, init))
      return new Response("Unavailable", { status: 503 })
    },
  })

  await expect(
    client.isolatedBrowser.start({ sessionID: "ses_isolated", url: "http://localhost:8080/fixture" }),
  ).rejects.toThrow()
  expect(requests).toHaveLength(1)
  expect(new URL(requests[0].url).pathname).toBe("/api/session/ses_isolated/browser/isolated/start")
})
