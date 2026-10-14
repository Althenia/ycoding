import { RemoteWebSocketPath } from "@ycoding-ai/remote"

export function remoteWebSocketURL(origin: string, deviceID: string) {
  const url = new URL(RemoteWebSocketPath.client, origin)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("device", deviceID)
  return url.href
}
