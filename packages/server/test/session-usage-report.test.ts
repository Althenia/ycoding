import { expect, test } from "bun:test"
import { SessionV2 } from "@ycoding-ai/core/session"
import { Effect } from "effect"
import { sessionHttp } from "./session-http"

const sessionID = SessionV2.ID.make("ses_usage_report_http")
const metrics = {
  logical: 2,
  physical: 3,
  helpers: 1,
  continued: 1,
  fallback: 0,
  tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 20, write: 1 } },
  cacheReadReported: true,
}

function fixture(usageReport: SessionV2.Interface["usageReport"]) {
  const locationCalls = { value: 0 }
  const http = sessionHttp({ usageReport }, { onLocation: () => void locationCalls.value++ })
  return {
    request: (query: string) => http.request(`/api/session/${sessionID}/usage/report?${query}`),
    locationCalls,
    [Symbol.asyncDispose]: http[Symbol.asyncDispose],
  }
}

test("decodes a filtered report request through location middleware and returns the safe envelope", async () => {
  const received: unknown[] = []
  await using f = fixture((input) =>
    Effect.sync(() => {
      received.push(input)
      return {
        group: input.group,
        rows: [{ key: "2026-02-01", label: "2026-02-01", ...metrics }],
        total: metrics,
        rowCount: 1,
      }
    }),
  )

  const response = await f.request(
    "group=day&from=1769904000000&to=1769990400000&offset=0&limit=25&sort=tokens&order=desc",
  )
  expect(response.status).toBe(200)
  expect(f.locationCalls.value).toBe(1)
  expect(received).toEqual([
    {
      sessionID,
      group: "day",
      from: 1769904000000,
      to: 1769990400000,
      offset: 0,
      limit: 25,
      sort: "tokens",
      order: "desc",
    },
  ])
  const body = await response.json()
  expect(body).toEqual({
    data: {
      group: "day",
      rows: [{ key: "2026-02-01", label: "2026-02-01", ...metrics }],
      total: metrics,
      rowCount: 1,
    },
  })
  expect(JSON.stringify(body)).not.toMatch(/route|namespace|digest|promptCache|credential|payload|models/)
})

test("rejects invalid ranges and page limits before the Core report read", async () => {
  const calls = { value: 0 }
  await using f = fixture(() => Effect.sync(() => {
    calls.value++
    return { group: "day", rows: [], total: metrics, rowCount: 0 }
  }))

  for (const query of [
    "group=day&from=2&to=2",
    "group=day&limit=201",
    "group=day&sort=requests",
    "group=day&order=newest",
  ]) {
    const response = await f.request(query)
    expect(response.status).toBe(400)
  }
  expect(calls.value).toBe(0)
})

test("retains the typed unknown-Session response", async () => {
  await using f = fixture(() => Effect.fail(new SessionV2.NotFoundError({ sessionID })))
  const response = await f.request("group=project")

  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ _tag: "SessionNotFoundError", sessionID })
})
