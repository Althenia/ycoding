export interface ScriptCDP {
  send(tabId: number, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  onEvent(tabId: number, listener: (method: string, params: unknown) => void): () => void
}
export function runScript(input: {
  readonly tabId: number
  readonly leaseID: string
  readonly mode: "script" | "code"
  readonly source: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}, cdp: ScriptCDP, worlds: Map<string, unknown>): Promise<unknown>
export function discardWorlds(worlds: Map<string, unknown>, leaseID: string): void
