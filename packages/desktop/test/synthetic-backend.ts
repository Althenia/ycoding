import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ConnectionState } from "../src/contract"
import { createEventStream, createFetch } from "../../tui/test/fixture/tui-client"

export const env = { PATH: "/usr/bin:/bin" }

export const message = (promise: Promise<unknown>) => promise.then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error))
export const writes = (routes: readonly string[]) => routes.filter((route) => !/ \/api\/(health|event)$/.test(route))

export function revision(state: ConnectionState) {
  if (state.revision === undefined) throw new Error("A connected state carries its revision.")
  return state.revision
}

export function launch(command: readonly [string, ...string[]]): readonly [string, ...string[]] {
  if (command[1] === "--version") return ["/bin/echo", "ycoding vsynthetic"]
  return ["/bin/echo", JSON.stringify({ type: "desktop.endpoint", version: "synthetic", endpoint: { url: command[command.indexOf("--server") + 1] } })]
}

export async function syntheticBundle() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-desktop-synthetic-"))
  const bytes = "synthetic executable bytes"
  await fs.mkdir(path.join(root, "backend"))
  await fs.writeFile(path.join(root, "backend/ycoding"), bytes, { mode: 0o700 })
  await fs.writeFile(path.join(root, "backend.json"), JSON.stringify({
    executable: "backend/ycoding",
    version: "synthetic",
    files: [{ path: "backend/ycoding", sha256: createHash("sha256").update(bytes).digest("hex") }],
  }))
  return root
}

export function peer(
  routes: string[],
  pid: () => number,
  handle: (route: string, request: Request) => Promise<Response | undefined> | undefined = () => undefined,
  firstStreamEnds?: Promise<void>,
  onSubscribe?: () => Promise<void> | undefined,
) {
  const events = createEventStream()
  const fixture = createFetch(async (url, request) => {
    const route = url.pathname
    routes.push(`${request.method} ${route}`)
    if (route === "/api/health") return Response.json({ healthy: true, version: "synthetic-shared", pid: pid(), sourceEpoch: `epoch-${pid()}` })
    if (route === "/api/event") {
      await onSubscribe?.()
      return events.connect()
    }
    return (await handle(route, request)) ?? new Response(null, { status: 404 })
  }, events)
  if (firstStreamEnds) void firstStreamEnds.then(() => events.disconnect())
  return fixture.listen((request) => fixture.fetch(request))
}
