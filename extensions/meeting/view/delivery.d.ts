declare const source: string
export default source

export function createDelivery(options: {
  key: string
  fetch: (url: string, options: RequestInit) => Promise<Response>
  wait: (ms: number) => Promise<void>
  onState: (phase: string) => void
  onFailure: (reason: string) => void
  onStop?: (reason: string) => void
}): { send: (message: Record<string, unknown>) => Promise<void>; close: () => void }
