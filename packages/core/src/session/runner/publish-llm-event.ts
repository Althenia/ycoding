import { ToolOutput, type LLMEvent, type ProviderMetadata, type ToolResultValue } from "@ycoding-ai/ai"
import { Effect } from "effect"
import { EventV2 } from "../../event"
import { ModelV2 } from "../../model"
import { SessionEvent } from "../event"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import { SessionError } from "@ycoding-ai/schema/session-error"
import { Session } from "@ycoding-ai/schema/session"
import { Money } from "@ycoding-ai/schema/money"
import { AgentV2 } from "../../agent"
import { Snapshot } from "../../snapshot"
import { RelativePath } from "../../schema"
import { SessionUsage } from "../usage"

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly model: ModelV2.Ref
  readonly providerMetadataKey: string
  readonly snapshot?: Snapshot.ID
  readonly assistantMessageID?: SessionMessage.ID
  readonly captureProviderState?: (
    state: Record<string, unknown> | undefined,
    selector: { readonly messageID: SessionMessage.ID; readonly partOrdinal: number; readonly partKind: string },
  ) => Record<string, unknown> | undefined
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { value }

const message = (value: unknown) => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

type SettledOutput =
  | { readonly structured: Record<string, unknown>; readonly content: ToolOutput["content"] }
  | { readonly error: SessionError.Error }

const settledOutput = (value: ToolOutput | undefined, result: ToolResultValue): SettledOutput => {
  if (result.type === "error") return { error: { type: "tool.execution", message: message(result.value) } }
  const settled = value ?? ToolOutput.fromResultValue(result)
  if (!settled) throw new Error(`Unsupported tool result: ${message(result)}`)
  return { structured: record(settled.structured), content: settled.content }
}

const fileChanges = (tool: string, structured: Record<string, unknown>) => {
  if (tool !== "edit" && tool !== "patch") return []
  const files = structured.files
  if (!Array.isArray(files)) return []
  return files.flatMap((file) => {
    if (typeof file !== "object" || file === null || Array.isArray(file)) return []
    const value = file as Record<string, unknown>
    if (
      typeof value.file !== "string" ||
      typeof value.patch !== "string" ||
      typeof value.additions !== "number" ||
      !Number.isSafeInteger(value.additions) ||
      value.additions < 0 ||
      typeof value.deletions !== "number" ||
      !Number.isSafeInteger(value.deletions) ||
      value.deletions < 0
    )
      return []
    return [
      {
        path: RelativePath.make(value.file),
        patch: value.patch,
        additions: value.additions,
        deletions: value.deletions,
      },
    ]
  })
}

/** Persist one step without executing tools or starting a continuation step. */
export const createLLMEventPublisher = (events: Pick<EventV2.Interface, "publish">, input: Input) => {
  const tools = new Map<
    string,
    {
      readonly assistantMessageID: SessionMessage.ID
      readonly name: string
      readonly partOrdinal: number
      called: boolean
      settled: boolean
      providerExecuted: boolean
    }
  >()
  let nextContentOrdinal = 0
  const reasoningContentOrdinals = new Map<string, number>()
  let assistantMessageID = input.assistantMessageID
  let stepStarted = input.assistantMessageID !== undefined
  let stepFailed = false
  let providerFailed = false
  let retryEvidence = false
  let assistantText = false
  let stepFailure: SessionError.Error | undefined
  let stepSettlement:
    | {
        readonly finish: Extract<LLMEvent, { type: "step-finish" }>["reason"]
        readonly tokens: ReturnType<typeof SessionUsage.tokens>
        readonly reporting: ReturnType<typeof SessionUsage.providerCache>
        readonly providerState?: Record<string, unknown>
      }
    | undefined

  const startAssistant = Effect.fnUntraced(function* () {
    if (stepStarted && assistantMessageID !== undefined) return assistantMessageID
    assistantMessageID ??= SessionMessage.ID.create()
    stepStarted = true
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID: input.sessionID,
      agent: input.agent,
      model: input.model,
      assistantMessageID,
      snapshot: input.snapshot,
    })
    return assistantMessageID
  })
  const currentAssistantMessageID = () =>
    assistantMessageID === undefined
      ? Effect.die(new Error("Tool event before assistant step start"))
      : Effect.succeed(assistantMessageID)
  const providerState = (metadata: ProviderMetadata | undefined) => metadata?.[input.providerMetadataKey]
  const capturedProviderState = (
    metadata: ProviderMetadata | undefined,
    messageID: SessionMessage.ID,
    partOrdinal: number,
    partKind: string,
  ) => {
    const state = providerState(metadata)
    if (input.captureProviderState) return input.captureProviderState(state, { messageID, partOrdinal, partKind })
    return state
  }
  const textPhase = (metadata: ProviderMetadata | undefined) => {
    const phase = providerState(metadata)?.phase
    return phase === "commentary" || phase === "final_answer" ? phase : undefined
  }
  const fragments = (
    name: string,
    ended: (id: string, value: string, ordinal: number, state?: Record<string, unknown>) => Effect.Effect<void>,
    single = false,
  ) => {
    const chunks = new Map<
      string,
      { readonly ordinal: number; readonly values: string[]; state?: Record<string, unknown> }
    >()
    let nextOrdinal = 0
    const start = (id: string, state?: Record<string, unknown>) =>
      Effect.suspend(() => {
        if (chunks.has(id)) return Effect.die(new Error(`Duplicate ${name} start: ${id}`))
        if (single && chunks.size > 0) return Effect.die(new Error(`${name} start before end: ${id}`))
        const ordinal = nextOrdinal++
        chunks.set(id, { ordinal, values: [], state })
        return Effect.succeed(ordinal)
      })
    const append = (id: string, value: string, state?: Record<string, unknown>) =>
      Effect.suspend(() => {
        const current = chunks.get(id)
        if (!current) return Effect.die(new Error(`${name} delta before start: ${id}`))
        current.values.push(value)
        if (state !== undefined) current.state = { ...current.state, ...state }
        return Effect.succeed(current.ordinal)
      })
    const end = Effect.fnUntraced(function* (id: string, state?: Record<string, unknown>, value?: string) {
      const current = chunks.get(id)
      if (!current) return yield* Effect.die(new Error(`${name} end before start: ${id}`))
      yield* ended(
        id,
        value ?? current.values.join(""),
        current.ordinal,
        state === undefined ? current.state : { ...current.state, ...state },
      )
      chunks.delete(id)
    })
    const flush = Effect.fnUntraced(function* () {
      for (const id of chunks.keys()) yield* end(id)
    })
    return { start, append, end, flush, has: (id: string) => chunks.has(id) }
  }

  const text = fragments(
    "text",
    (_textID, value, ordinal, state) =>
      Effect.gen(function* () {
        const phase = state?.phase
        yield* events.publish(SessionEvent.Text.Ended, {
          sessionID: input.sessionID,
          assistantMessageID: yield* currentAssistantMessageID(),
          ordinal,
          text: value,
          phase: phase === "commentary" || phase === "final_answer" ? phase : undefined,
        })
        if (value.trim().length > 0) assistantText = true
      }),
    true,
  )
  const reasoning = fragments(
    "reasoning",
    (_reasoningID, value, ordinal, state) =>
      Effect.gen(function* () {
        yield* events.publish(SessionEvent.Reasoning.Ended, {
          sessionID: input.sessionID,
          assistantMessageID: yield* currentAssistantMessageID(),
          ordinal,
          text: value,
          state,
        })
      }),
    true,
  )
  const toolInput = fragments("tool input", (callID, value) =>
    Effect.gen(function* () {
      const tool = tools.get(callID)
      if (!tool) return yield* Effect.die(new Error(`Tool input end before start: ${callID}`))
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID: input.sessionID,
        assistantMessageID: tool.assistantMessageID,
        callID,
        text: value,
      })
    }),
  )

  const flushFragments = Effect.fnUntraced(function* () {
    yield* text.flush()
    yield* reasoning.flush()
    yield* toolInput.flush()
  })

  const startToolInput = Effect.fnUntraced(function* (event: {
    readonly id: string
    readonly name: string
    readonly providerExecuted?: boolean
  }) {
    if (tools.has(event.id)) return yield* Effect.die(new Error(`Duplicate tool input start: ${event.id}`))
    const assistantMessageID = yield* startAssistant()
    tools.set(event.id, {
      assistantMessageID,
      name: event.name,
      partOrdinal: nextContentOrdinal++,
      called: false,
      settled: false,
      providerExecuted: event.providerExecuted === true,
    })
    yield* toolInput.start(event.id)
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID: input.sessionID,
      assistantMessageID,
      callID: event.id,
      name: event.name,
    })
  })

  const endToolInput = Effect.fnUntraced(function* (
    event: { readonly id: string; readonly name: string },
    value?: string,
  ) {
    const tool = tools.get(event.id)
    if (!tool) return yield* Effect.die(new Error(`Tool input end before start: ${event.id}`))
    if (tool.name !== event.name)
      return yield* Effect.die(new Error(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`))
    if (!toolInput.has(event.id)) return yield* Effect.die(new Error(`Duplicate tool input end: ${event.id}`))
    yield* toolInput.end(event.id, undefined, value)
  })

  const failMalformedToolInput = Effect.fnUntraced(function* (event: {
    readonly id: string
    readonly name: string
    readonly raw: string
  }) {
    if (!tools.has(event.id)) yield* startToolInput(event)
    const tool = tools.get(event.id)
    if (!tool || tool.called || tool.settled)
      return yield* Effect.die(new Error(`Malformed tool input after call settlement: ${event.id}`))
    if (tool.name !== event.name)
      return yield* Effect.die(new Error(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`))
    if (toolInput.has(event.id)) yield* endToolInput(event, event.raw)
    tool.settled = true
    yield* events.publish(SessionEvent.Tool.Failed, {
      sessionID: input.sessionID,
      assistantMessageID: tool.assistantMessageID,
      callID: event.id,
      error: {
        type: "tool.input-json",
        message: "Tool call arguments were malformed JSON and were not executed. Retry with valid JSON.",
      },
      executed: false,
    })
  })

  const flush = Effect.fn("SessionRunner.flush")(function* () {
    yield* flushFragments()
  })

  const failTools = Effect.fnUntraced(function* (error: SessionError.Error, mode: "all" | "hosted" | "uncalled") {
    let failed = false
    for (const [callID, tool] of tools) {
      if (tool.settled || (mode === "hosted" && !tool.providerExecuted) || (mode === "uncalled" && tool.called))
        continue
      tool.settled = true
      failed = true
      yield* events.publish(SessionEvent.Tool.Failed, {
        sessionID: input.sessionID,
        assistantMessageID: tool.assistantMessageID,
        callID,
        error,
        executed: tool.providerExecuted,
      })
    }
    return failed
  })

  const failAssistant = Effect.fnUntraced(function* (error: SessionError.Error) {
    yield* flush()
    yield* failTools(error, "uncalled")
    yield* startAssistant()
    if (stepFailure === undefined) stepFailure = error
  })

  const publishStepFailure = Effect.fnUntraced(function* (details?: {
    readonly cost?: Money.USD
    readonly tokens?: ReturnType<typeof SessionUsage.tokens>
    readonly providerCache?: Session.ProviderCacheDiagnostics
    readonly snapshot?: Snapshot.ID
    readonly files?: readonly RelativePath[]
  }) {
    if (stepFailed || stepFailure === undefined) return
    const assistantMessageID = yield* startAssistant()
    stepFailed = true
    yield* events.publish(SessionEvent.Step.Failed, {
      sessionID: input.sessionID,
      assistantMessageID,
      error: stepFailure,
      ...details,
    })
  })

  const failUnsettledTools = Effect.fn("SessionRunner.failUnsettledTools")(function* (
    error: SessionError.Error,
    hostedOnly = false,
  ) {
    return yield* failTools(error, hostedOnly ? "hosted" : "all")
  })

  const assistantMessageIDForTool = (callID: string) => {
    const tool = tools.get(callID)
    return tool ? Effect.succeed(tool.assistantMessageID) : Effect.die(new Error(`Unknown tool call: ${callID}`))
  }

  const publish = Effect.fn("SessionRunner.publishLLMEvent")(function* (event: LLMEvent, error?: SessionError.Error) {
    switch (event.type) {
      case "step-start":
        yield* startAssistant()
        return
      case "text-start":
        retryEvidence = true
        nextContentOrdinal += 1
        const startedTextPhase = textPhase(event.providerMetadata)
        const startedTextState = startedTextPhase === undefined ? undefined : { phase: startedTextPhase }
        const startedTextOrdinal = yield* text.start(event.id, startedTextState)
        yield* events.publish(SessionEvent.Text.Started, {
          sessionID: input.sessionID,
          assistantMessageID: yield* startAssistant(),
          ordinal: startedTextOrdinal,
          phase: startedTextPhase,
        })
        return
      case "text-delta":
        const deltaTextPhase = textPhase(event.providerMetadata)
        const deltaTextOrdinal = yield* text.append(
          event.id,
          event.text,
          deltaTextPhase === undefined ? undefined : { phase: deltaTextPhase },
        )
        yield* events.publish(SessionEvent.Text.Delta, {
          sessionID: input.sessionID,
          assistantMessageID: yield* currentAssistantMessageID(),
          ordinal: deltaTextOrdinal,
          delta: event.text,
        })
        return
      case "text-end":
        const endedTextPhase = textPhase(event.providerMetadata)
        yield* text.end(event.id, endedTextPhase === undefined ? undefined : { phase: endedTextPhase })
        return
      case "reasoning-start":
        retryEvidence = true
        const reasoningMessageID = yield* startAssistant()
        const reasoningContentOrdinal = nextContentOrdinal++
        reasoningContentOrdinals.set(event.id, reasoningContentOrdinal)
        const startedReasoningOrdinal = yield* reasoning.start(event.id)
        const startedReasoningState = capturedProviderState(
          event.providerMetadata,
          reasoningMessageID,
          reasoningContentOrdinal,
          "reasoning",
        )
        yield* reasoning.append(event.id, "", startedReasoningState)
        yield* events.publish(SessionEvent.Reasoning.Started, {
          sessionID: input.sessionID,
          assistantMessageID: reasoningMessageID,
          ordinal: startedReasoningOrdinal,
          state: startedReasoningState,
        })
        return
      case "reasoning-delta":
        const reasoningDeltaContentOrdinal = reasoningContentOrdinals.get(event.id)
        if (reasoningDeltaContentOrdinal === undefined)
          return yield* Effect.die(new Error(`Reasoning delta before start: ${event.id}`))
        const deltaReasoningOrdinal = yield* reasoning.append(
          event.id,
          event.text,
          capturedProviderState(
            event.providerMetadata,
            yield* currentAssistantMessageID(),
            reasoningDeltaContentOrdinal,
            "reasoning",
          ),
        )
        yield* events.publish(SessionEvent.Reasoning.Delta, {
          sessionID: input.sessionID,
          assistantMessageID: yield* currentAssistantMessageID(),
          ordinal: deltaReasoningOrdinal,
          delta: event.text,
        })
        return
      case "reasoning-end":
        const reasoningEndContentOrdinal = reasoningContentOrdinals.get(event.id)
        if (reasoningEndContentOrdinal === undefined)
          return yield* Effect.die(new Error(`Reasoning end before start: ${event.id}`))
        const endedReasoningOrdinal = yield* reasoning.append(event.id, "")
        yield* reasoning.end(
          event.id,
          capturedProviderState(
            event.providerMetadata,
            yield* currentAssistantMessageID(),
            reasoningEndContentOrdinal,
            "reasoning",
          ),
        )
        reasoningContentOrdinals.delete(event.id)
        return
      case "tool-input-start":
        retryEvidence = true
        yield* startToolInput(event)
        return
      case "tool-input-delta": {
        const tool = tools.get(event.id)
        if (!tool) return yield* Effect.die(new Error(`Tool input delta before start: ${event.id}`))
        if (tool.name !== event.name)
          return yield* Effect.die(new Error(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`))
        if (!toolInput.has(event.id)) return yield* Effect.die(new Error(`Tool input delta after end: ${event.id}`))
        yield* toolInput.append(event.id, event.text)
        yield* events.publish(SessionEvent.Tool.Input.Delta, {
          sessionID: input.sessionID,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          delta: event.text,
        })
        return
      }
      case "tool-input-end":
        yield* endToolInput(event)
        return
      case "tool-input-error":
        retryEvidence = true
        yield* failMalformedToolInput(event)
        return
      case "tool-call": {
        retryEvidence = true
        if (!tools.has(event.id)) yield* startToolInput(event)
        const tool = tools.get(event.id)!
        if (toolInput.has(event.id)) yield* endToolInput(event)
        if (tool.name !== event.name)
          return yield* Effect.die(new Error(`Tool call name changed for ${event.id}: ${tool.name} -> ${event.name}`))
        if (tool.called) return yield* Effect.die(new Error(`Duplicate tool call: ${event.id}`))
        tool.called = true
        tool.providerExecuted = event.providerExecuted === true
        yield* events.publish(SessionEvent.Tool.Called, {
          sessionID: input.sessionID,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          input: record(event.input),
          executed: tool.providerExecuted,
          state: capturedProviderState(event.providerMetadata, tool.assistantMessageID, tool.partOrdinal, "tool-call"),
        })
        return
      }
      case "tool-result": {
        const tool = tools.get(event.id)
        if (!tool?.called) return yield* Effect.die(new Error(`Tool result before call: ${event.id}`))
        if (tool.name !== event.name)
          return yield* Effect.die(new Error(`Tool result name changed for ${event.id}: ${tool.name} -> ${event.name}`))
        if (tool.settled) {
          if (event.result.type === "error") return
          return yield* Effect.die(new Error(`Duplicate tool result: ${event.id}`))
        }
        tool.settled = true
        const result = error ? { error } : settledOutput(event.output, event.result)
        const executed = event.providerExecuted === true || tool.providerExecuted
        const resultState = capturedProviderState(
          event.providerMetadata,
          tool.assistantMessageID,
          tool.partOrdinal,
          "tool-result",
        )
        if ("error" in result) {
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID: input.sessionID,
            assistantMessageID: tool.assistantMessageID,
            callID: event.id,
            error: result.error,
            result: event.result,
            executed,
            resultState,
          })
          return
        }
        yield* events.publish(SessionEvent.Tool.Success, {
          sessionID: input.sessionID,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          ...result,
          ...(executed ? { result: event.result } : {}),
          executed,
          resultState,
        })
        yield* Effect.forEach(
          fileChanges(tool.name, result.structured),
          (change) => events.publish(SessionEvent.FileChange.Recorded, { sessionID: input.sessionID, change }),
          { discard: true },
        )
        return
      }
      case "tool-error": {
        const tool = tools.get(event.id)
        if (!tool?.called) return yield* Effect.die(new Error(`Tool error before call: ${event.id}`))
        if (tool.name !== event.name)
          return yield* Effect.die(new Error(`Tool error name changed for ${event.id}: ${tool.name} -> ${event.name}`))
        if (tool.settled) return yield* Effect.die(new Error(`Duplicate tool error: ${event.id}`))
        tool.settled = true
        yield* events.publish(SessionEvent.Tool.Failed, {
          sessionID: input.sessionID,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          error:
            event.message === `Unknown tool: ${event.name}`
              ? { type: "tool.unknown", message: event.message }
              : { type: "tool.execution", message: event.message },
          executed: tool.providerExecuted,
          resultState: capturedProviderState(
            event.providerMetadata,
            tool.assistantMessageID,
            tool.partOrdinal,
            "tool-result",
          ),
        })
        return
      }
      case "step-finish":
        yield* flush()
        if (stepSettlement) return yield* Effect.die(new Error("Duplicate step finish"))
        stepSettlement = {
          finish: event.reason,
          tokens: SessionUsage.tokens(event.usage),
          reporting: SessionUsage.providerCache(event.usage),
          providerState: providerState(event.providerMetadata),
        }
        if (event.reason === "content-filter") {
          providerFailed = true
          yield* failAssistant({ type: "provider.content-filter", message: "Provider blocked the response" })
          return
        }
        return
      case "finish":
        return
      case "provider-error":
        providerFailed = true
        yield* failAssistant({ type: "provider.unknown", message: event.message })
        return
    }
  })

  return {
    publish,
    flush,
    failAssistant,
    publishStepFailure,
    failUnsettledTools,
    hasProviderError: () => providerFailed,
    hasRetryEvidence: () => retryEvidence,
    hasAssistantText: () => assistantText,
    hasStepStarted: () => stepStarted,
    stepFailure: () => stepFailure,
    stepSettlement: () => stepSettlement,
    startAssistant,
    assistantMessageID: assistantMessageIDForTool,
  }
}
