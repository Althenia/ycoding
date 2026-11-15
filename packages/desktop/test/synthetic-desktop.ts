import fs from "node:fs/promises"
import { BackendController } from "../src/backend-controller"
import { env, launch, revision, syntheticBundle } from "./synthetic-backend"

export type SyntheticCall = { method: string; route: string; query: URLSearchParams; body: Record<string, unknown> }

export async function syntheticDesktop(handle: (call: SyntheticCall) => unknown = () => undefined, options: NonNullable<ConstructorParameters<typeof BackendController>[1]> = {}) {
  const resources = await syntheticBundle()
  const calls: SyntheticCall[] = []
  const controller = new BackendController(resources, { editor: { read: async () => ({ status: "disabled" }), close: () => {} }, ...options, env, launch, cwd: resources, fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === "/api/health") return Response.json({ healthy: true, version: "synthetic", pid: 101, sourceEpoch: "synthetic" })
    if (url.pathname === "/api/event") return new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'))
      request.signal.addEventListener("abort", () => stream.close(), { once: true })
    } }), { headers: { "content-type": "text/event-stream" } })
    const body: unknown = request.body ? await request.json() : {}
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Synthetic request body must be an object")
    const call = { method: request.method, route: url.pathname, query: url.searchParams, body: { ...body } }
    calls.push(call)
    const value = await handle(call)
    if (value instanceof Response) return value
    if (value !== undefined) return Response.json(value)
    if (url.pathname === "/api/coordination") return Response.json({ data: [] })
    if (url.pathname === "/api/coordination/settings") return Response.json({ data: { enabled: false, categories: [] } })
    if (url.pathname === "/api/project/inventory") return Response.json({ data: [], cursor: {} })
    return new Response(null, { status: 204 })
  }, { preconnect: () => {} }) })
  try {
    const connected = await controller.connect({ mode: "shared", server: "http://synthetic.invalid" })
    return { controller, calls, resources, revision: revision(connected), async close() { await controller.disconnect(); await fs.rm(resources, { recursive: true, force: true }) } }
  } catch (error) { await controller.disconnect(); await fs.rm(resources, { recursive: true, force: true }); throw error }
}
