import { WebSocket } from "ws"

export type NodeSocket = {
  readonly readyState: number
  binaryType: string
  on(event: "open" | "close" | "error", listener: () => void): unknown
  on(event: "message", listener: (data: unknown, binary: boolean) => void): unknown
  on(
    event: "unexpected-response",
    listener: (request: unknown, response: { statusCode?: number; resume(): unknown }) => void,
  ): unknown
  send(bytes: Uint8Array): unknown
  close(code?: number, reason?: string): void
  terminate(): void
}
export type SocketOptions = {
  readonly headers: Readonly<Record<string, string>>
  readonly maxPayload: number
  readonly perMessageDeflate: false
  readonly followRedirects: false
}

export const openNodeSocket = (url: string, options: SocketOptions): NodeSocket => new WebSocket(url, options)
