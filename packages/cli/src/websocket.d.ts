declare module "ws" {
  export const WebSocket: new (
    url: string,
    options?: { readonly headers?: Readonly<Record<string, string>> },
  ) => import("@ycoding-ai/client/v5").Socket
}
