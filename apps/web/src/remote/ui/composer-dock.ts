export type ComposerDockEvent = "toggle" | "new-session" | "pending-request" | "palette-draft"

export function composerDockCollapsed(collapsed: boolean, event: ComposerDockEvent) {
  if (event === "toggle") return !collapsed
  if (event === "new-session" || event === "pending-request" || event === "palette-draft") return false
  return collapsed
}

export function composerReserve(rowEnd: number, mainBottom: number) {
  return Math.max(0, Math.ceil(mainBottom - rowEnd))
}
