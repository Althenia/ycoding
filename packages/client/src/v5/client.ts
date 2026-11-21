import { bind } from "./generated/surface.js"
import { bindFrontendBoundary } from "./generated/frontend-boundary.js"
import { LocalTransport } from "./socket.js"
import type { V5Options } from "./socket.js"

export function make(options: V5Options) {
  const transport = new LocalTransport(options)
  return Object.assign(bindFrontendBoundary(transport, bind(transport)), { transport })
}

export type V5Client = ReturnType<typeof make>
