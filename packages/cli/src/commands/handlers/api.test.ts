import { expect, test } from "bun:test"
import { YCoding } from "@ycoding-ai/client/v5"
import { invokeOperation, resolveOperation } from "./api"
import { v5Server } from "../../../test/fixture/v5-server"

test("generic API resolves the local typed catalog and rejects HTTP and remote-only names", () => {
  expect(resolveOperation("health.get").requestType).toBe("ycoding.v5.health_get_Request")
  expect(() => resolveOperation("GET /api/health")).toThrow("Local operation not found")
  expect(() => resolveOperation("notice.list")).toThrow("Local operation not found")
})

test("generic API invokes the catalog request and returns the typed result over v5", async () => {
  const requests: unknown[] = []
  const server = v5Server((name, data) => {
    requests.push({ name, data })
    return { data: { accepted: true } }
  })
  const client = YCoding.make({ endpoint: { url: server.url } })
  try {
    expect(await invokeOperation(client, "health.stop", { payload: { instanceID: "instance_fixture" } })).toEqual({
      data: { accepted: true },
    })
    expect(requests).toEqual([{ name: "health.stop", data: { payload: { instanceID: "instance_fixture" } } }])
  } finally {
    client.transport.close()
    await server.close()
  }
})
