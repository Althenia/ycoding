import path from "node:path"
import type { NativeDots } from "@ycoding-ai/core/dots/native"
import { createRemoteControlHost } from "./host"
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
  await host.start()
  return () => host.stop()
}
