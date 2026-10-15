import worker from "../../src/index"
import { DeviceRelay } from "../../src/relay/durable-object"
import type { WorkerEnv } from "../../src/env"
import { decodeStrict, FrameSchema } from "../../../../packages/protocol/src/v5"

class EventAuthorityRelay extends DeviceRelay {
  private holding = false
  private readonly held: { socket: WebSocket; message: ArrayBuffer }[] = []

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/_fixture/hold") {
      this.holding = true
      return new Response(null, { status: 204 })
    }
    if (url.pathname === "/_fixture/held") return Response.json({ count: this.held.length })
    if (url.pathname === "/_fixture/release") {
      const input = await request.json<{ sessionID: string; change: "revoked" | "expired" | "valid" }>()
      if (input.change === "revoked")
        await this.env.DB.prepare("UPDATE browser_session SET revoked_at=? WHERE id=?")
          .bind(Date.now() - 1, input.sessionID)
          .run()
      if (input.change === "expired")
        await this.env.DB.prepare("UPDATE browser_session SET expires_at=? WHERE id=?")
          .bind(Date.now() - 1, input.sessionID)
          .run()
      this.holding = false
      for (const entry of this.held.splice(0)) await super.webSocketMessage(entry.socket, entry.message)
      return new Response(null, { status: 204 })
    }
    return super.fetch(request)
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.holding && typeof message !== "string") {
      const frame = decodeStrict(FrameSchema, new Uint8Array(message))
      if (frame.body.case === "eventBatch") {
        this.held.push({ socket, message })
        return
      }
    }
    await super.webSocketMessage(socket, message)
  }
}

export { EventAuthorityRelay as DeviceRelay }
export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith("/_fixture/"))
      return env.DEVICE_RELAY.getByName(`usr_owner:${url.searchParams.get("device")}`).fetch(request)
    return worker.fetch(request, env)
  },
}
