import type { RemoteDeviceInfo } from "@ycoding-ai/remote"

export const deviceAliasStorageKey = "ycoding.remote.device-aliases"
export const deviceAliasLimit = 48

export type DeviceAliasStorage = Pick<Storage, "getItem" | "setItem">
export type DeviceAliases = Readonly<Record<string, string>>

export function readDeviceAliases(storage?: DeviceAliasStorage): DeviceAliases {
  try {
    const value = (storage ?? globalThis.localStorage).getItem(deviceAliasStorageKey)
    if (value === null) return {}
    const decoded: unknown = JSON.parse(value)
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return {}
    return Object.fromEntries(
      Object.entries(decoded).flatMap(([id, alias]) =>
        typeof alias === "string" && alias.trim().length > 0
          ? [[id, alias.trim().slice(0, deviceAliasLimit).trim()]]
          : [],
      ),
    )
  } catch {
    return {}
  }
}

export function setDeviceAlias(deviceID: string, value: string, storage?: DeviceAliasStorage): DeviceAliases {
  const aliases = readDeviceAliases(storage)
  const alias = value.trim().slice(0, deviceAliasLimit).trim()
  const next = Object.fromEntries([
    ...Object.entries(aliases).filter(([id]) => id !== deviceID),
    ...(alias.length === 0 ? [] : [[deviceID, alias]]),
  ])
  try {
    ;(storage ?? globalThis.localStorage).setItem(deviceAliasStorageKey, JSON.stringify(next))
  } catch {}
  return next
}

export function clearDeviceAlias(deviceID: string, storage?: DeviceAliasStorage): DeviceAliases {
  return setDeviceAlias(deviceID, "", storage)
}

export function displayDeviceName(device: Pick<RemoteDeviceInfo, "id" | "name">, aliases: DeviceAliases): string {
  return aliases[device.id] || device.name
}
