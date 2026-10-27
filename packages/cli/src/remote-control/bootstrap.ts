import path from "node:path"
import type { NativeDots } from "@ycoding-ai/core/dots/native"
import type { DotsAccess } from "@ycoding-ai/core/dots/access"
import { createRemoteControlHost, type RemoteControlStatus } from "./host"
import { createRemoteControlStateStore } from "./state"
import { connectRemoteControlSocket, macDeviceKind } from "./socket"

export async function startNativeRemoteControl(input: {
  readonly native: NativeDots.Host
  readonly stateDirectory: string
  readonly codexHome: string
  readonly onDiagnostic: (message: string) => void
}) {
  const host = createRemoteControlHost({
    native: input.native,
    store: createRemoteControlStateStore(path.join(input.stateDirectory, "remote-control.json")),
    codexHome: input.codexHome,
    connect: connectRemoteControlSocket,
    deviceKind: macDeviceKind,
    onDiagnostic: input.onDiagnostic,
  })
  const unregister = input.native.attachTransport(remoteControlTransport(host.status))
  await host.start().catch(async (error: unknown) => { unregister(); await host.stop(); throw error })
  return async () => { unregister(); await host.stop() }
}

export function remoteControlTransport(status: () => Promise<RemoteControlStatus>): DotsAccess.Transport {
  return {
    status: async () => {
      const current = await status().catch((): RemoteControlStatus => ({ state: "error", problem: "connection" }))
      return {
        state: current.state === "on" ? "connected" : current.state,
        ...(current.serverName === undefined ? {} : { hostname: current.serverName }),
        ...(current.problem === undefined ? {} : { problem: current.problem }),
      }
    },
  }
}
