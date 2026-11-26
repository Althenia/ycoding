import { YCoding } from "@ycoding-ai/client/promise"
import { auth, type IsolatedServer } from "../remote-harness"
import { v5Server } from "./v5-server"

type Selectors = {
  params?: { sessionID?: string; parentID?: string }
  query?: { parentID?: string; limit?: number; cursor?: string; before?: string; after?: number; follow?: boolean }
}

function page<T extends { cursor: { previous?: string | null; next?: string | null } }>(result: T) {
  const { previous, next } = result.cursor
  return { data: { ...result, cursor: { previous: previous ?? undefined, next: next ?? undefined } } }
}

export function decisionWatchPeer(server: IsolatedServer) {
  const { session, decision, event } = YCoding.make({ baseUrl: server.base, headers: { authorization: auth } })
  const peer = v5Server(async (name, input) => {
    const { params, query } = input as Selectors
    const sessionID = params?.sessionID ?? ""
    switch (name) {
      case "health.get": return { data: await (await server.request("/api/health")).json() }
      case "session.get": return { data: await session.get({ sessionID }) }
      case "session.snapshot": return { data: await session.snapshot({ sessionID, ...query }) }
      case "session.list": return page(await session.list(query))
      case "session.active": return { data: await session.active() }
      case "session.outstanding": return session.outstanding()
      case "session.todo.list": return { data: await session.todo.list({ sessionID }) }
      case "session.pending.list": return { data: await session.pending.list({ sessionID }) }
      case "session.subagent.list": return page(await session.subagent.list({ parentID: params?.parentID ?? "", ...query }))
      case "decision.list": return { data: await decision.list() }
      default: throw new Error(`Unexpected watch read: ${name}`)
    }
  }, {
    stream(name, input, stream) {
      const { params, query } = input as Selectors
      const controller = new AbortController()
      const options = { signal: controller.signal }
      const rows = name === "event.subscribe" ? event.subscribe(options)
        : name === "session.log" && params?.sessionID ? session.log({ sessionID: params.sessionID, ...query }, options)
        : undefined
      if (!rows) throw new Error(`Unexpected watch stream: ${name}`)
      void (async () => {
        try {
          for await (const item of rows) if (item.type !== "server.connected") stream.send(item)
        } catch (error) {
          if (!controller.signal.aborted) console.error(error)
        } finally {
          stream.end()
        }
      })()
      return () => controller.abort()
    },
  })
  return { base: new URL(peer.url).origin, close: peer.close }
}
