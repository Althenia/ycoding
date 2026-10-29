// Minimal surface of the `ws` package used by the relay transport on Node
// runtimes, which cannot send WebSocket upgrade headers through the DOM
// `WebSocket` constructor. The package ships no type declarations.
declare module "ws" {
  export interface NodeWebSocket {
    readonly readyState: number
    readonly bufferedAmount: number
    readonly isPaused: boolean
    on(type: "message", listener: (data: Buffer, isBinary: boolean) => void): unknown
    on(type: "close", listener: (code: number, reason: Buffer) => void): unknown
    on(type: "error", listener: (error: Error) => void): unknown
    on(type: "open", listener: () => void): unknown
    on(type: "ping" | "pong", listener: (data: Buffer) => void): unknown
    on(type: string, listener: (...args: unknown[]) => void): unknown
    once(type: "message", listener: (data: Buffer, isBinary: boolean) => void): unknown
    once(type: "close", listener: (code: number, reason: Buffer) => void): unknown
    once(type: "error", listener: (error: Error) => void): unknown
    once(type: "open", listener: () => void): unknown
    once(type: "ping" | "pong", listener: (data: Buffer) => void): unknown
    once(type: string, listener: (...args: unknown[]) => void): unknown
    off(type: string, listener: (...args: unknown[]) => void): unknown
    addEventListener(
      type: string,
      listener: (event: { readonly type?: string; readonly data?: unknown }) => void,
    ): void
    removeEventListener(
      type: string,
      listener: (event: { readonly type?: string; readonly data?: unknown }) => void,
    ): void
    send(value: string | Uint8Array): void
    ping(): void
    pong(): void
    pause(): void
    close(code?: number, reason?: string): void
    terminate(): void
  }

  export interface NodeWebSocketServer {
    on(
      type: "connection",
      listener: (socket: NodeWebSocket, request: import("node:http").IncomingMessage) => void,
    ): unknown
    on(type: "listening", listener: () => void): unknown
    on(type: "error", listener: (error: Error) => void): unknown
    on(type: "close", listener: () => void): unknown
    on(type: string, listener: (...args: unknown[]) => void): unknown
    address(): import("node:net").AddressInfo | string | null
    close(callback?: (error?: Error) => void): void
  }

  export const WebSocket: {
    readonly CLOSED: number
    new (
      url: string,
      options?: {
        readonly headers?: Record<string, string>
        readonly maxPayload?: number
        readonly closeTimeout?: number
      },
    ): NodeWebSocket
    new (
      url: string,
      protocols: string[],
      options?: {
        readonly headers?: Record<string, string>
        readonly maxPayload?: number
        readonly closeTimeout?: number
      },
    ): NodeWebSocket
  }

  export const WebSocketServer: {
    new (options?: {
      readonly port?: number
      readonly host?: string
      readonly server?: import("node:http").Server
      readonly maxPayload?: number
    }): NodeWebSocketServer
  }
}
