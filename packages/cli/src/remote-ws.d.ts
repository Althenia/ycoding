// Minimal surface of the `ws` package used by the relay transport on Node
// runtimes, which cannot send WebSocket upgrade headers through the DOM
// `WebSocket` constructor. The package ships no type declarations.
declare module "ws" {
  export interface NodeWebSocket {
    readonly readyState: number
    readonly on: (type: string, listener: (...args: unknown[]) => void) => unknown
    readonly off: (type: string, listener: (...args: unknown[]) => void) => unknown
    readonly send: (value: string) => void
    readonly close: (code?: number, reason?: string) => void
  }

  export const WebSocket: new (url: string, options?: { readonly headers?: Record<string, string> }) => NodeWebSocket
}
