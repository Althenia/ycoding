import path from "node:path"
import type { NativeDots } from "@ycoding-ai/core/dots/native"
import type { DotsAccess } from "@ycoding-ai/core/dots/access"
import { createCcaComputerControl, type CcaComputerControl } from "./cca-computer"
import { createCcaExecutorHost } from "./cca-executor-host"
import { createRemoteControlHost, type RemoteControlStatus } from "./host"
import { createRemoteControlStateStore } from "./state"
import { connectRemoteControlSocket, macDeviceKind } from "./socket"

export async function startNativeRemoteControl(input: {
  readonly native: NativeDots.Host
  readonly stateDirectory: string
  readonly codexHome: string
  readonly onDiagnostic: (message: string) => void
}) {
  const store = createRemoteControlStateStore(path.join(input.stateDirectory, "remote-control.json"))
  const host = createRemoteControlHost({
    native: input.native,
    store,
    codexHome: input.codexHome,
    connect: connectRemoteControlSocket,
    deviceKind: macDeviceKind,
    onDiagnostic: input.onDiagnostic,
  })
  const executorStatePath = path.join(input.stateDirectory, "cca-executor.json")
  const executor = createCcaExecutorHost({
    native: input.native,
    statePath: executorStatePath,
    installationID: async () => (await store.load()).installationID,
    onDiagnostic: input.onDiagnostic,
  })
  const computer = createCcaComputerControl({ native: input.native, statePath: executorStatePath, onDiagnostic: input.onDiagnostic })
  const unregister = input.native.attachTransport(remoteControlTransport(host.status, computer))
  const stop = async () => {
    unregister()
    await Promise.all([host.stop(), executor.stop()])
  }
  try {
    await host.start()
    await executor.start()
  } catch (error) {
    await stop()
    throw error
  }
  return stop
}

export function remoteControlTransport(status: () => Promise<RemoteControlStatus>, computer: CcaComputerControl): DotsAccess.Transport {
  return {
    computer: computer.computer,
    attachComputer: computer.attach,
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
