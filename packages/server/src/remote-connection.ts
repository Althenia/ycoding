export * as RemoteConnection from "./remote-connection"

import { Remote } from "@ycoding-ai/protocol/groups/remote"
import { Context } from "effect"

export interface Interface {
  readonly status: () => Promise<Remote.Status>
  readonly set: (enabled: boolean) => Promise<Remote.Status>
  readonly shutdown: () => Promise<void>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding-ai/server/RemoteConnection") {}

export const unavailable: Interface = {
  status: async () => ({ state: "off" }),
  set: async () => ({ state: "error", message: "Remote connection is unavailable in this server" }),
  shutdown: async () => {},
}
