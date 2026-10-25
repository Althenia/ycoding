import type { DotsPubSub } from "./pubsub"

export const DotsSocket = {
  async open(url: string, protocols: string[], headers: Record<string, string>): Promise<DotsPubSub.Socket> {
    const { NodeWS } = await import("@effect/platform-node/NodeSocket")
    const socket = new NodeWS.WebSocket(url, protocols, { headers })
    return {
      get readyState() { return socket.readyState },
      addEventListener: (type, listener) => socket.addEventListener(type, listener),
      removeEventListener: (type, listener) => socket.removeEventListener(type, listener),
      send: (data) => socket.send(data),
      close: () => {
        if (socket.readyState === 0) socket.once("error", () => {})
        socket.close()
      },
    }
  },
}
