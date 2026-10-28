export * as GenerationMeter from "./generation-meter"

import type { LLMEvent, Usage } from "@ycoding-ai/ai"
import type { Model } from "@ycoding-ai/schema/model"
import type { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import type { GenerationSpeedHistory } from "@ycoding-ai/schema/session-cache-diagnostics"
import { Token } from "../util/token"
import { SessionUsage } from "./usage"

export type Live = NonNullable<GenerationSpeedHistory["live"]>
export type Phase = Live["phase"]
export type Received = NonNullable<ProviderRequest.Timing["receivedOutput"]>
export type Change = "phase" | "output"

const WINDOW_NS = 5_000_000_000n
const MINIMUM_NS = 1_000_000_000n
const SPACING_NS = 250_000_000n

type Point = { readonly time: bigint; readonly tokens: number }

export const terminal = (phase: Phase) => phase === "completed" || phase === "failed" || phase === "cancelled"

export function sample(received: Received | undefined) {
  const tokens = received?.estimatedTokens
  const durationNs = received?.durationNs
  if (!Number.isSafeInteger(tokens) || !tokens || tokens <= 0 ||
    !Number.isSafeInteger(durationNs) || !durationNs || durationNs < Number(MINIMUM_NS)) return undefined
  const tokensPerSecond = tokens * 1_000_000_000 / durationNs
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return undefined
  return { tokens, durationNs, tokensPerSecond, estimated: true as const }
}

export function window() {
  const points: Point[] = []
  return {
    observe(time: bigint, tokens: number) {
      if (!Number.isSafeInteger(tokens) || tokens < 0) return
      const last = points.at(-1)
      if (last && time < last.time) return
      const point = { time, tokens }
      if (last?.time === time) {
        points[points.length - 1] = point
        return
      }
      if (points.length > 1 && time - points[points.length - 2]!.time < SPACING_NS) points.pop()
      points.push(point)
      while (points.length > 2 && points[1]!.time <= time - WINDOW_NS) points.shift()
    },
    sample: () => interval(points[0], points.at(-1)),
  }
}

export interface Input {
  readonly requestID: ProviderRequest.ID
  readonly attempt: number
  readonly model: Model.Ref
  readonly startedNs: bigint
  readonly onChange?: (meter: Meter, time: bigint) => void
}

export type Meter = ReturnType<typeof make>

export function make(input: Input) {
  const rolling = window()
  const streamedToolInputs = new Set<string>()
  const completedToolInputs = new Set<string>()
  let phase: Phase = "preparing"
  let now = input.startedNs
  let characters = 0
  let origin: Point | undefined
  let latest: Point | undefined
  let firstOutput: bigint | undefined
  let lastOutput: bigint | undefined
  let ended: bigint | undefined
  let usage: Usage | undefined
  let frozen = false

  const advance = (time: bigint) => {
    if (time > now) now = time
    return now
  }
  const speed = (value: Received | undefined) => {
    const measured = sample(value)
    return measured === undefined ? undefined : { model: input.model, ...measured }
  }

  const meter = {
    requestID: input.requestID,
    attempt: input.attempt,
    model: input.model,
    phase: () => phase,
    outputTokens: () => Token.estimateLength(characters),
    lastOutputNs: () => lastOutput,
    waiting(time: bigint) {
      if (phase !== "preparing") return
      phase = "waiting"
      input.onChange?.(meter, advance(time))
    },
    observe(event: LLMEvent, time: bigint): Change | undefined {
      if (terminal(phase) || frozen) return undefined
      const at = advance(time)
      if (event.type === "step-finish") {
        usage = event.usage
        ended = at
        frozen = true
        return undefined
      }
      if (event.type === "provider-error") {
        ended ??= at
        return undefined
      }
      const output = eventOutput(event)
      const next = nextPhase(event)
      const changed = next !== undefined && next !== phase
      if (changed) phase = next
      if (output.length > 0) {
        characters += output.length
        const point = { time: at, tokens: Token.estimateLength(characters) }
        rolling.observe(point.time, point.tokens)
        origin = origin === undefined || origin.time === at ? point : origin
        latest = point
        lastOutput = at
        if (event.type !== "tool-call") firstOutput ??= at
      }
      if (!changed && output.length === 0) return undefined
      input.onChange?.(meter, at)
      return changed ? "phase" : "output"
    },
    settle(outcome: ProviderRequest.Outcome, time: bigint) {
      if (terminal(phase)) return false
      const at = advance(time)
      ended ??= at
      phase = outcome
      input.onChange?.(meter, at)
      return true
    },
    live(): Live {
      const current = speed(rolling.sample())
      const final = terminal(phase) ? speed(interval(origin, latest)) : undefined
      return {
        requestID: input.requestID,
        attempt: input.attempt,
        phase,
        ...(firstOutput === undefined ? {} : { firstOutputMs: Number((firstOutput - input.startedNs) / 1_000_000n) }),
        ...(current === undefined ? {} : { sample: current }),
        ...(final === undefined ? {} : { final }),
      }
    },
    timing() {
      const generation = SessionUsage.generationTiming(usage, {
        started: input.startedNs,
        text: firstOutput,
        ended: ended ?? now,
        streamedCharacters: characters,
      })
      const whole = interval(origin, latest)
      if (generation === undefined && whole === undefined) return undefined
      return { ...generation, ...(whole === undefined ? {} : { receivedOutput: whole }) }
    },
  }

  function eventOutput(event: LLMEvent) {
    if (event.type === "text-delta" || event.type === "reasoning-delta") return event.text
    if (event.type === "tool-input-delta") {
      if (event.text.length > 0) streamedToolInputs.add(event.id)
      return event.text
    }
    if (event.type !== "tool-call" || completedToolInputs.has(event.id)) return ""
    completedToolInputs.add(event.id)
    return streamedToolInputs.has(event.id) ? "" : (JSON.stringify(event.input) ?? "")
  }

  return meter
}

function nextPhase(event: LLMEvent): Phase | undefined {
  if (event.type === "reasoning-delta" && event.text.length > 0) return "reasoning"
  if ((event.type === "text-delta" || event.type === "tool-input-delta") && event.text.length > 0) return "streaming"
  if (event.type === "tool-call") return "tool"
  return undefined
}

function interval(first: Point | undefined, last: Point | undefined): Received | undefined {
  if (!first || !last) return undefined
  const duration = last.time - first.time
  const estimatedTokens = last.tokens - first.tokens
  if (duration < MINIMUM_NS || duration > BigInt(Number.MAX_SAFE_INTEGER) ||
    !Number.isSafeInteger(estimatedTokens) || estimatedTokens <= 0) return undefined
  return { estimatedTokens, durationNs: Number(duration) }
}
