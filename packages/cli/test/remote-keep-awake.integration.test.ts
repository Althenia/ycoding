import { expect, test } from "bun:test"
import { createLocalServer } from "../src/remote-local"

test("machine keep-awake uses authenticated global routes without a Session or Location", async () => {
  const requests: { method: string; path: string; body?: unknown; directory: string | null; workspace: string | null; authenticated: boolean }[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = request.method === "PUT" ? await request.json() as { enabled: boolean } : undefined
    requests.push({ method: request.method, path: new URL(request.url).pathname, body,
      directory: request.headers.get("x-ycoding-directory"), workspace: request.headers.get("x-ycoding-workspace"),
      authenticated: request.headers.get("authorization") === "Basic " + btoa("ycoding:test-only-password") })
    return Response.json({ data: body === undefined ? { state: "off" } : body.enabled
      ? { state: "unsupported", message: "Keep machine awake is available on macOS only." }
      : { state: "off" } })
  } })
  try {
    const local = createLocalServer({ url: `http://127.0.0.1:${server.port}`, auth: { type: "basic", username: "ycoding", password: "test-only-password" } })
    expect(await local.keepAwakeGet()).toEqual({ state: "off" })
    expect(await local.keepAwakeSet(true)).toEqual({ state: "unsupported", message: "Keep machine awake is available on macOS only." })
    expect(await local.keepAwakeSet(false)).toEqual({ state: "off" })
    expect(requests).toEqual([
      { method: "GET", path: "/api/keep-awake", body: undefined, directory: null, workspace: null, authenticated: true },
      { method: "PUT", path: "/api/keep-awake", body: { enabled: true }, directory: null, workspace: null, authenticated: true },
      { method: "PUT", path: "/api/keep-awake", body: { enabled: false }, directory: null, workspace: null, authenticated: true },
    ])
  } finally { server.stop(true) }
})
