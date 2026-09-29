export const toastDuration = 6_000
export const toastExit = 220

export function createToastTimer(options: {
  readonly duration: number
  readonly exit: number
  readonly onChange: (state: { readonly paused: boolean; readonly leaving: boolean }) => void
  readonly onDone: () => void
}) {
  let remaining = options.duration
  let started = performance.now()
  let paused = false
  let leaving = false
  let exitTimer: ReturnType<typeof setTimeout> | undefined
  const dismiss = () => {
    if (leaving) return
    clearTimeout(timer)
    leaving = true
    options.onChange({ paused, leaving })
    exitTimer = setTimeout(options.onDone, options.exit)
  }
  let timer = setTimeout(dismiss, remaining)
  return {
    dismiss,
    pause: () => {
      if (paused || leaving) return
      remaining -= performance.now() - started
      clearTimeout(timer)
      paused = true
      options.onChange({ paused, leaving })
    },
    resume: () => {
      if (!paused || leaving) return
      paused = false
      started = performance.now()
      timer = setTimeout(dismiss, Math.max(0, remaining))
      options.onChange({ paused, leaving })
    },
    dispose: () => {
      clearTimeout(timer)
      clearTimeout(exitTimer)
    },
  }
}
