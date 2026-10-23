import type { RemoteDeviceInfo } from "@ycoding-ai/remote"

export function displayDeviceName(device: Pick<RemoteDeviceInfo, "id" | "name" | "alias">): string {
  return device.alias ?? device.name
}
