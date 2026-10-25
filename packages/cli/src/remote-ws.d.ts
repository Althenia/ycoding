// Minimal surface of the `ws` package used by the relay transport on Node
// runtimes, which cannot send WebSocket upgrade headers through the DOM
// `WebSocket` constructor. The package ships no type declarations.
declare module "ws" {
  export interface NodeWebSocket {
    readonly readyState: number
    readonly bufferedAmount: number
    readonly on: (type: string, listener: (...args: unknown[]) => void) => unknown
    readonly off: (type: string, listener: (...args: unknown[]) => void) => unknown
    readonly once: (type: string, listener: (...args: unknown[]) => void) => unknown
    readonly addEventListener: (type: string, listener: (event: { readonly type?: string; readonly data?: unknown }) => void) => void
    readonly removeEventListener: (type: string, listener: (event: { readonly type?: string; readonly data?: unknown }) => void) => void
    readonly send: (value: string) => void
    readonly close: (code?: number, reason?: string) => void
  }

  export const WebSocket: {
    new (url: string, options?: { readonly headers?: Record<string, string> }): NodeWebSocket
    new (url: string, protocols: string[], options?: { readonly headers?: Record<string, string> }): NodeWebSocket
  }
}
