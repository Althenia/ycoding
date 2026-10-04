export function createRemoteStoreClock() {
  // An integer origin keeps `at - current` and split advances exact; a fractional origin yields 2999.9999999999995.
  let current = Math.round(performance.now())
  const timers: { readonly at: number; readonly callback: () => void; cancelled: boolean }[] = []
  return {
    now: () => current,
    schedule: (callback: () => void, ms: number) => {
      const timer = { at: current + ms, callback, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
    pendingDelays: () => timers.filter((timer) => !timer.cancelled).map((timer) => timer.at - current).sort((left, right) => left - right),
    advanceBy: async (ms: number) => {
      const end = current + ms
      for (;;) {
        const timer = timers.filter((entry) => !entry.cancelled && entry.at <= end).sort((left, right) => left.at - right.at)[0]
        if (timer === undefined) break
        timer.cancelled = true
        current = timer.at
        timer.callback()
        await Promise.resolve()
      }
      current = end
    },
  }
}
