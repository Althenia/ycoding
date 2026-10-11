import { expect, test } from "bun:test"
import { createLocalServer, LocalFailure } from "../src/remote-local"

test("local telemetry consent uses machine endpoints and disabled appends retain a distinct failure", async () => {
  const requests: { readonly method: string; readonly path: string; readonly body?: unknown }[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const body = request.method === "GET" ? undefined : await request.json()
      requests.push({ method: request.method, path: url.pathname, ...(body === undefined ? {} : { body }) })
      if (url.pathname === "/api/server/telemetry/consent" && request.method === "GET")
        return Response.json({ noticeVersion: 1 })
      if (url.pathname === "/api/server/telemetry/consent" && request.method === "PUT")
        return Response.json({ enabled: true, noticeVersion: 1, decidedAt: 100 })
      if (url.pathname === "/api/server/web-latency") return Response.json({ _tag: "TelemetryDisabled" }, { status: 403 })
      return new Response(null, { status: 404 })
    },
  })
  try {
    const local = createLocalServer({ url: `http://127.0.0.1:${server.port}` })
    expect(await local.telemetryConsentGet()).toEqual({ noticeVersion: 1 })
    expect(await local.telemetryConsentSet({ enabled: true, noticeVersion: 1 })).toEqual({ enabled: true, noticeVersion: 1, decidedAt: 100 })
    await expect(local.latencyAppend([{ kind: "long-task", at: "2026-10-04T12:00:00.000Z", durationMs: 70 }])).rejects.toMatchObject({
      name: "LocalFailure",
      kind: "telemetry_disabled",
    } satisfies Partial<LocalFailure>)
    expect(requests).toEqual([
      { method: "GET", path: "/api/server/telemetry/consent" },
      { method: "PUT", path: "/api/server/telemetry/consent", body: { enabled: true, noticeVersion: 1 } },
      { method: "POST", path: "/api/server/web-latency", body: { samples: [{ kind: "long-task", at: "2026-10-04T12:00:00.000Z", durationMs: 70 }] } },
    ])
  } finally {
    await server.stop(true)
  }
})
