export const startupTimeout = 120_000

export function pollDelay(elapsed: number) {
  return Math.min(elapsed < 5_000 ? 100 : 1_000, Math.max(0, startupTimeout - elapsed))
}
