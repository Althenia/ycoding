import type { DotsAccess } from "@ycoding-ai/core/dots/access"
import type { CcaComputerControl } from "./cca-computer"
import type { RemoteControlStatus } from "./host"

export function remoteControlTransport(status: () => Promise<RemoteControlStatus>, computer: CcaComputerControl, conversation: DotsAccess.Conversation): DotsAccess.Transport {
  return {
    conversation,
    computer: computer.computer,
    attachComputer: computer.attach,
    detachComputer: computer.detach,
    removeComputer: computer.remove,
    status: async () => {
      const current = await status().catch((): RemoteControlStatus => ({ state: "error", problem: "connection" }))
      return {
        state: current.state === "on" ? "connected" : current.state,
        ...(current.serverName === undefined ? {} : { hostname: current.serverName }),
        ...(current.name === undefined ? {} : { name: current.name }),
        ...(current.problem === undefined ? {} : { problem: current.problem }),
      }
    },
  }
}
