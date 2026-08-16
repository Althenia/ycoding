export const BUN_BINARY = "ycoding"
export const NODE_BINARY = "ycoding-node"

export function platformBinary(name: string, platform = process.platform) {
  return platform === "win32" ? `${name}.exe` : name
}
