import type { ModelDaybreak } from "@ycoding-ai/client"

export type DaybreakPlan =
  | { readonly type: "request"; readonly daybreak: ModelDaybreak | null }
  | { readonly type: "reject"; readonly message: string }

const PROGRAMS: Record<string, ModelDaybreak> = {
  blue: "daybreak_blue",
  daybreak_blue: "daybreak_blue",
  red: "daybreak_red",
  daybreak_red: "daybreak_red",
}

export function daybreakStateLabel(daybreak?: ModelDaybreak) {
  if (daybreak === "daybreak_blue") return "blue"
  if (daybreak === "daybreak_red") return "red"
  return "off"
}

export function daybreakTitle(daybreak?: ModelDaybreak) {
  return `Daybreak: ${daybreakStateLabel(daybreak)} (cycle off→blue→red, /daybreak blue|red|off)`
}

export function daybreakSuccessLabel(daybreak: ModelDaybreak | null) {
  if (daybreak === null) return "Daybreak disabled"
  return `Daybreak ${daybreakStateLabel(daybreak)} enabled`
}

export function daybreakPlan(input: {
  current?: ModelDaybreak
  advertised?: readonly ModelDaybreak[]
  argument?: string
}): DaybreakPlan {
  const advertised = input.advertised ?? []
  const token = input.argument?.trim().split(/\s+/)[0]
  if (token === undefined || token === "") return cycleDaybreak(input.current, advertised)
  if (token === "off") return { type: "request", daybreak: null }
  const program = PROGRAMS[token]
  if (!program) return { type: "reject", message: "Daybreak accepts blue, red, or off" }
  if (!advertised.includes(program))
    return { type: "reject", message: `Daybreak ${daybreakStateLabel(program)} is not available for this model` }
  return { type: "request", daybreak: program }
}

function cycleDaybreak(current: ModelDaybreak | undefined, advertised: readonly ModelDaybreak[]): DaybreakPlan {
  if (current === "daybreak_red") return { type: "request", daybreak: null }
  if (current === "daybreak_blue")
    return advertised.includes("daybreak_red")
      ? { type: "request", daybreak: "daybreak_red" }
      : { type: "request", daybreak: null }
  if (advertised.includes("daybreak_blue")) return { type: "request", daybreak: "daybreak_blue" }
  if (advertised.includes("daybreak_red")) return { type: "request", daybreak: "daybreak_red" }
  return { type: "reject", message: "Daybreak is not available for this model" }
}
