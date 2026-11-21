import { expect, test } from "bun:test"
import { YCoding } from "../src/promise"

test("generated Interaction client sends only typed Session requests and generation fences", async () => {
  const requests: Request[] = []
  const client = YCoding.make({ baseUrl: "http://localhost", fetch: async (input, init) => {
    requests.push(new Request(input, init))
    return Response.json({ data: { state: "unavailable" } })
  } })
  const sessionID = "ses_interaction"
  const generation = crypto.randomUUID()
  expect(Object.keys(client.sessionInteraction)).toEqual(["status", "request", "preview", "stop", "resume"])
  expect(await client.sessionInteraction.status({ sessionID })).toEqual({ state: "unavailable" })
  await client.sessionInteraction.request({ sessionID, payload: { platform: "chrome", mode: "isolated", url: "https://example.test/" } })
  await client.sessionInteraction.preview({ sessionID, generation })
  await client.sessionInteraction.stop({ sessionID, generation })
  await client.sessionInteraction.resume({ sessionID, generation })
  expect(requests.map(({ method, url }) => [method, new URL(url).pathname])).toEqual([
    ["GET", "/api/session/ses_interaction/interaction"],
    ["POST", "/api/session/ses_interaction/interaction"],
    ["GET", "/api/session/ses_interaction/interaction/preview"],
    ["POST", "/api/session/ses_interaction/interaction/stop"],
    ["POST", "/api/session/ses_interaction/interaction/resume"],
  ])
  expect(await requests[1]?.json()).toEqual({ platform: "chrome", mode: "isolated", url: "https://example.test/" })
  expect(new URL(requests[2].url).searchParams.get("generation")).toBe(generation)
  expect(await requests[3]?.json()).toEqual({ generation })
  expect(await requests[4]?.json()).toEqual({ generation })
})
