// Minimal surface of the `ws` package used by the relay transport on Node
// runtimes, which cannot send WebSocket upgrade headers through the DOM
// `WebSocket` constructor. The package ships no type declarations.
declare module "ws" {
  import { EventEmitter } from "node:events"

  export type RawData = Buffer | ArrayBuffer | Buffer[]

  export interface NodeWebSocket extends EventEmitter {
    binaryType: "nodebuffer" | "arraybuffer" | "fragments"
    readonly readyState: number
    readonly bufferedAmount: number
    readonly isPaused: boolean
    on(type: "message", listener: (data: Buffer, isBinary: boolean) => void): this
    on(type: "close", listener: (code: number, reason: Buffer) => void): this
    on(type: "error", listener: (error: Error) => void): this
    on(type: "open", listener: () => void): this
    on(type: "ping" | "pong", listener: (data: Buffer) => void): this
    on(
      type: "unexpected-response",
      listener: (request: import("node:http").ClientRequest, response: import("node:http").IncomingMessage) => void,
    ): this
    on(type: string, listener: (...args: unknown[]) => void): this
    once(type: "message", listener: (data: Buffer, isBinary: boolean) => void): this
    once(type: "close", listener: (code: number, reason: Buffer) => void): this
    once(type: "error", listener: (error: Error) => void): this
    once(type: "open", listener: () => void): this
    once(type: "ping" | "pong", listener: (data: Buffer) => void): this
    once(
      type: "unexpected-response",
      listener: (request: import("node:http").ClientRequest, response: import("node:http").IncomingMessage) => void,
    ): this
    once(type: string, listener: (...args: unknown[]) => void): this
    off(type: "message", listener: (data: Buffer, isBinary: boolean) => void): this
    off(type: "close", listener: (code: number, reason: Buffer) => void): this
    off(type: "error", listener: (error: Error) => void): this
    off(type: "open", listener: () => void): this
    off(type: "ping" | "pong", listener: (data: Buffer) => void): this
    off(
      type: "unexpected-response",
      listener: (request: import("node:http").ClientRequest, response: import("node:http").IncomingMessage) => void,
    ): this
    off(type: string, listener: (...args: unknown[]) => void): this
    addEventListener(
      type: string,
      listener: (event: { readonly type?: string; readonly data?: unknown }) => void,
    ): void
    removeEventListener(
      type: string,
      listener: (event: { readonly type?: string; readonly data?: unknown }) => void,
    ): void
    send(value: string | Uint8Array, callback?: (error?: Error) => void): void
    send(value: string | Uint8Array, options: { readonly binary?: boolean }, callback?: (error?: Error) => void): void
    ping(): void
    pong(): void
    pause(): void
    resume(): void
    close(code?: number, reason?: string): void
    terminate(): void
  }

  export interface NodeWebSocketServer extends EventEmitter {
    on(
      type: "connection",
      listener: (socket: NodeWebSocket, request: import("node:http").IncomingMessage) => void,
    ): this
    on(type: "listening", listener: () => void): this
    on(type: "error", listener: (error: Error) => void): this
    on(type: "close", listener: () => void): this
    on(type: string, listener: (...args: unknown[]) => void): this
    once(type: "listening", listener: () => void): this
    once(type: string, listener: (...args: unknown[]) => void): this
    readonly clients: Set<NodeWebSocket>
    address(): import("node:net").AddressInfo | string | null
    close(callback?: (error?: Error) => void): void
  }

  export const WebSocket: {
    readonly CLOSED: number
    new (
      url: string | URL,
      options?: {
        readonly headers?: Record<string, string>
        readonly maxPayload?: number
        readonly closeTimeout?: number
        readonly perMessageDeflate?: boolean
        readonly handshakeTimeout?: number
      },
    ): NodeWebSocket
    new (
      url: string | URL,
      protocols: string[],
      options?: {
        readonly headers?: Record<string, string>
        readonly maxPayload?: number
        readonly closeTimeout?: number
        readonly perMessageDeflate?: boolean
        readonly handshakeTimeout?: number
      },
    ): NodeWebSocket
  }

  export const WebSocketServer: {
    new (options?: {
      readonly port?: number
      readonly host?: string
      readonly server?: import("node:http").Server
      readonly maxPayload?: number
      readonly handleProtocols?: (protocols: Set<string>, request: import("node:http").IncomingMessage) => string | false
      readonly verifyClient?: (
        info: { readonly origin: string; readonly secure: boolean; readonly req: import("node:http").IncomingMessage },
        callback: (
          accepted: boolean,
          code?: number,
          message?: string,
          headers?: import("node:http").OutgoingHttpHeaders,
        ) => void,
      ) => void
    }): NodeWebSocketServer
  }
}
