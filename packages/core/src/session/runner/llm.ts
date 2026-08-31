export * as SessionRunnerLLM from "./llm"

import {
  LLMClient,
  LLMError,
  LLMEvent,
  LLMRequest,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@ycoding-ai/ai"
import { Money } from "@ycoding-ai/schema/money"
import { SessionError } from "@ycoding-ai/schema/session-error"
import { Cause, Effect, Exit, Fiber, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { PermissionV2 } from "../../permission"
import { QuestionTool } from "../../tool/question"
import { ToolOutputStore } from "../../tool-output-store"
import { OpenAICodex } from "../../plugin/provider/openai-codex"
import { InstructionState } from "../instruction-state"
import { SessionCompaction } from "../compaction"
import { SessionCacheDiagnostics } from "../cache-diagnostics"
import { SessionContext } from "../context"
import { SessionCompactionJob } from "../compaction-job"
import { SessionContextPressure } from "../context-pressure"
import { SessionEvent } from "../event"
import { SessionPending } from "../pending"
import { SessionProviderRequest } from "../provider-request"
import { SessionModelRequest } from "../model-request"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionTitle } from "../title"
import { Service } from "./index"
import { createLLMEventPublisher } from "./publish-llm-event"
import { RelativePath } from "../../schema"
import { Snapshot } from "../../snapshot"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"
import { StepFailedError } from "../error"
import { toSessionError } from "../to-session-error"
import { SessionCacheRuntime } from "./cache-runtime"
import { SessionCompactionGate } from "./compaction-gate"
import { SessionContinuation } from "./continuation"
import { SessionProviderState } from "../provider-state"
import { SessionRunnerRetry } from "./retry"
import { SessionUsage } from "../usage"
import { SessionAutonomy } from "../autonomy"
import { SessionTable } from "../sql"
import { eq } from "drizzle-orm"
import { Message } from "@ycoding-ai/ai"

type StepEnd = {
  readonly snapshot?: Snapshot.ID
  readonly files?: readonly RelativePath[]
}

type AttemptState = {
  current?: SessionProviderRequest.Tracker
  attempts: number
  continuationFallback?: boolean
  overflowRecovery?: "pending" | "used"
}

type RecoveryMode = "normal" | "terminal-response" | "transport"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const store = yield* SessionStore.Service
    const context = yield* SessionContext.Service
    const modelRequests = yield* SessionModelRequest.Service
    const snapshots = yield* Snapshot.Service
    const database = yield* Database.Service
    const db = database.db
    const compaction = yield* SessionCompaction.Service
    const compactionJobs = yield* SessionCompactionJob.Service
    const config = yield* Config.Service
    const title = yield* SessionTitle.Service
    const providerRequests = yield* SessionProviderRequest.Service
    const cacheRuntime = yield* SessionCacheRuntime.Service
    const continuation = yield* SessionContinuation.Service
    let executionGeneration = 0
    // Title generation is a side effect of the first step; it must not delay step continuation.
    // Tracked per process so repeated wakes before the second user message arrives don't
    // re-fire a redundant LLM call; `SessionTitle` itself is idempotent based on durable history.
    const titleAttempted = new Set<SessionSchema.ID>()
    const forkTitle = yield* FiberSet.makeRuntime<never, void, never>()
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
      return session
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* store.context(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "streaming" && tool.state.status !== "running")) continue
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            assistantMessageID: message.id,
            callID: tool.id,
            error: { type: "aborted", message: `Tool execution interrupted: ${tool.name}` },
            executed: tool.executed === true,
          })
        }
      }
    })
    // Declining an interactive prompt halts the drain instead of becoming model-facing tool output.
    const isUserDeclined = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some(
        (reason) =>
          Cause.isDieReason(reason) &&
          (reason.defect instanceof PermissionV2.DeclinedError || reason.defect instanceof QuestionTool.CancelledError),
      )

    const attemptStep = Effect.fn("SessionRunner.attemptStep")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionPending.Delivery | undefined,
      step: number,
      requestTrackerState: AttemptState,
      execution: number,
      assistantMessageID?: SessionMessage.ID,
      recoveryMode: RecoveryMode = "normal",
      onPromotion?: () => void,
    ) {
      const selected = yield* context.select(sessionID)
      // Establish what the model knows before admitting what the user said, so
      // a blocked first step leaves pending inputs untouched.
      yield* InstructionState.prepare(db, events, selected.instructions, selected.session.id)
      let currentStep = step
      let promoted = 0
      if (promotion) {
        if (promotion === "steer") promoted = yield* SessionPending.promoteSteers(db, events, selected.session.id)
        if (promotion === "queue") {
          promoted += Number(yield* SessionPending.promoteNextQueued(db, events, selected.session.id))
          promoted += yield* SessionPending.promoteSteers(db, events, selected.session.id)
        }
        if (promoted > 0) {
          currentStep = 1
          onPromotion?.()
        }
      }
      const initialContext = yield* context.load(selected)
      const goalMessages = (sessionID: SessionSchema.ID) =>
        Effect.gen(function* () {
          const row = yield* db
            .select({ autonomy: SessionTable.autonomy })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get()
            .pipe(Effect.orDie)
          if (!row) return [] as ReadonlyArray<Message>
          const state = SessionAutonomy.read(row.autonomy)
          if (!state.goal || state.goal.status !== "active") return [] as ReadonlyArray<Message>
          const text = [
            `Active autonomous goal (iteration ${state.goal.iteration}, noProgress ${state.goal.noProgress}/${state.goal.maxNoProgress}): ${state.goal.text}`,
            "Only call goal report after you encounter a blocker, try to resolve it yourself, and still cannot make progress.",
            "Do not call goal report for ordinary progress; each report consumes one no-progress retry attempt.",
            "Active background subagents or shells are unfinished work, not automatic no progress; continue useful independent work or finish the iteration and wait for automatic notification.",
            "Call goal complete only after the goal is achieved and verified. Completion remains your explicit agent-owned decision.",
          ].join("\n")
          return [Message.make({ role: "system", content: text })] as ReadonlyArray<Message>
        })
      const prepare = (loaded: SessionContext.Loaded, fullRebase = false) =>
        Effect.gen(function* () {
          const extra = yield* goalMessages(loaded.session.id)
          return yield* modelRequests.prepare({
            context: loaded,
            step: currentStep,
            execution,
            disableContinuation:
              fullRebase || requestTrackerState.continuationFallback === true || recoveryMode !== "normal",
            terminalResponseRecovery: recoveryMode === "terminal-response",
            ...(extra.length > 0 ? { messages: extra } : {}),
          })
        })
      const initialPrepared = yield* prepare(initialContext)
      const limits = initialContext.model.model.route.defaults.limits
      const compactionPolicy = SessionContextPressure.policy(yield* config.entries())
      const candidate =
        limits?.context === undefined || limits.output === undefined
          ? { context: initialContext, prepared: initialPrepared, compacted: false }
          : yield* SessionCompactionGate.ensureWithinLimit({
              sessionID: initialContext.session.id,
              policy: compactionPolicy,
              capabilities: {
                contextWindowTokens: limits.context,
                maxOutputTokens: limits.output,
                contextSafetyMarginTokens: compactionPolicy.contextSafetyMarginTokens,
              },
              candidate: { context: initialContext, prepared: initialPrepared },
              force: requestTrackerState.overflowRecovery === "pending",
              reload: ({ fullRebase }) =>
                Effect.gen(function* () {
                  if (fullRebase) yield* continuation.clear(sessionID)
                  const selected = yield* context.select(sessionID)
                  yield* InstructionState.prepare(db, events, selected.instructions, selected.session.id)
                  const loaded = yield* context.load(selected)
                  return { context: loaded, prepared: yield* prepare(loaded, fullRebase) }
                }),
            }).pipe(
              Effect.provideService(Database.Service, database),
              Effect.provideService(SessionCompaction.Service, compaction),
              Effect.provideService(SessionCompactionJob.Service, compactionJobs),
            )
      if (candidate.context.contextRevision !== (yield* context.revision(sessionID)))
        return { _tag: "RestartAfterCompaction", step: currentStep, promoted } as const
      if (requestTrackerState.overflowRecovery === "pending") requestTrackerState.overflowRecovery = "used"
      const loaded = candidate.context
      const originalPrepared = candidate.prepared
      const session = loaded.session
      const agent = loaded.agent
      const resolved = loaded.model
      let requestTracker = requestTrackerState.current
      if (!requestTracker) {
        requestTracker = yield* providerRequests.next({
          sessionID: session.id,
          expectedContextRevision: loaded.contextRevision,
          inputID: loaded.messages.findLast((message) => message.type === "user")?.id,
          source: "step",
          agent: agent.id,
          model: resolved.ref,
          routeID: resolved.model.route.id,
          promptCacheKey: originalPrepared.cache.promptCacheKey,
          systemDigest: originalPrepared.cache.systemDigest,
          toolDigest: originalPrepared.cache.toolDigest,
        }).pipe(
          Effect.catchTag("SessionProviderRequest.StaleContextRevision", () => Effect.succeed(undefined)),
        )
        if (!requestTracker)
          return { _tag: "RestartAfterCompaction", step: currentStep, promoted } as const
        requestTrackerState.current = requestTracker
      }
      const startSnapshot = yield* snapshots.capture()
      const prepared = {
        ...originalPrepared,
        request: LLMRequest.update(originalPrepared.request, { id: requestTracker.requestID }),
      }
      const unreadInputIDs = new Set(
        loaded.messages.flatMap((message) =>
          message.type === "user" && message.time.consumed === undefined ? [message.id] : [],
        ),
      )
      const consumedInputIDs = prepared.inputIDs.filter((inputID) => unreadInputIDs.has(inputID))
      const effective = resolved
      const effectiveModel = effective.model
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      const ownedToolFibers: Array<Fiber.Fiber<void, ToolOutputStore.Error>> = []
      const providerStateCaptures: SessionProviderState.CaptureInput[] = []
      let needsContinuation = false
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        agent: agent.id,
        // The selected catalog identity, not model.id: route-level ids are provider API
        // model ids (for example gpt-5.5-fast resolves to api id gpt-5.5).
        model: effective.ref,
        providerMetadataKey: effectiveModel.route.providerMetadataKey ?? effectiveModel.provider,
        snapshot: startSnapshot,
        assistantMessageID,
        captureProviderState: (state, selector) => {
          if (state?.opaqueCompactionItem !== undefined)
            providerStateCaptures.push({
              ...selector,
              sessionID: session.id,
              provider: effectiveModel.provider,
              modelID: effective.ref.id,
              contextRevision: originalPrepared.continuation.fingerprint.contextRevision,
              state,
            })
          return SessionProviderState.redact(state)
        },
      })
      const publication = Semaphore.makeUnsafe(1)
      // Durable publishes are serialized so tool fibers and step settlement never interleave
      // mid-event.
      const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) => publication.withPermit(effect)
      const publish = (event: LLMEvent, error?: SessionError.Error) => serialized(publisher.publish(event, error))
      const stepUsage = (settlement: NonNullable<ReturnType<typeof publisher.stepSettlement>>) => ({
        cost: SessionUsage.calculateCost(effective.cost, settlement.tokens),
        tokens: settlement.tokens,
      })
      const providerCache = (settlement: NonNullable<ReturnType<typeof publisher.stepSettlement>>) => ({
        mechanism: SessionCacheDiagnostics.mechanism(effectiveModel.route.id, effective.ref, settlement.tokens),
        ...settlement.reporting,
      })
      let overflowFailure: ProviderErrorEvent | undefined
      let continuationFailure: ProviderErrorEvent | undefined
      const [consumedInputID, ...remainingConsumedInputIDs] = consumedInputIDs
      let inputConsumptionPending = consumedInputID !== undefined
      requestTrackerState.attempts += 1
      const providerStream = llm.stream(prepared.request).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (inputConsumptionPending && consumedInputID) {
              inputConsumptionPending = false
              yield* serialized(
                events.publish(SessionEvent.InputConsumed, {
                  sessionID: session.id,
                  inputIDs: [consumedInputID, ...remainingConsumedInputIDs],
                }),
              )
            }
            if (overflowFailure || continuationFailure || publisher.hasProviderError()) return
            if (LLMEvent.is.providerError(event) && isContextOverflowFailure(event) && !publisher.hasRetryEvidence()) {
              overflowFailure = event
              return
            }
            if (
              LLMEvent.is.providerError(event) &&
              originalPrepared.continuation.used &&
              !publisher.hasRetryEvidence() &&
              isInvalidPreviousResponse(event.message)
            ) {
              continuationFailure = event
              return
            }
            yield* publish(event)
            if (LLMEvent.is.stepFinish(event)) {
              const settlement =
                publisher.stepSettlement() ??
                (yield* Effect.die(new Error("Step finish did not produce provider settlement")))
              const usage = stepUsage(settlement)
              yield* serialized(
                events.publish(SessionEvent.DiagnosticsUpdated, {
                  sessionID: session.id,
                  diagnostics: SessionCacheDiagnostics.calculate({
                    model: effective.ref,
                    tokens: usage.tokens,
                    estimatedCost: usage.cost,
                    contextLimit: effectiveModel.route.defaults.limits?.context,
                    providerCache: providerCache(settlement),
                  }),
                }),
              )
            }
            if (LLMEvent.is.toolInputError(event)) {
              if (prepared.resolveToolCall(event.name).type === "settle") needsContinuation = true
              return
            }
            if (event.type !== "tool-call" || event.providerExecuted) return
            const tool = prepared.resolveToolCall(event.name)
            if (tool.type === "reject") {
              yield* serialized(publisher.failUnsettledTools(tool.error))
              if (recoveryMode === "terminal-response") yield* serialized(publisher.failAssistant(tool.error))
              return
            }
            needsContinuation = true
            const assistantMessageID = yield* publisher.assistantMessageID(event.id)
            ownedToolFibers.push(
              yield* Effect.uninterruptibleMask((restore) =>
                restore(
                  tool.settle({
                    sessionID: session.id,
                    agent: agent.id,
                    messageID: assistantMessageID,
                    call: event,
                    progress: (update) =>
                      serialized(
                        events.publish(SessionEvent.Tool.Progress, {
                          sessionID: session.id,
                          assistantMessageID,
                          callID: event.id,
                          structured: { ...update.structured },
                          content: [...update.content],
                        }),
                      ),
                  }),
                ).pipe(
                  Effect.flatMap((settlement) =>
                    publish(
                      LLMEvent.toolResult({
                        id: event.id,
                        name: event.name,
                        result: settlement.result,
                        output: settlement.output,
                      }),
                      settlement.error,
                    ),
                  ),
                ),
              ).pipe(FiberSet.run(toolFibers)),
            )
          }),
        ),
        Effect.ensuring(serialized(publisher.flush())),
      )

      const completeProviderRequest = (
        settlement?: NonNullable<ReturnType<typeof publisher.stepSettlement>>,
        override?: "provider-not-reported" | "retry-fallback",
      ) => {
        const usage = settlement
          ? stepUsage(settlement)
          : {
              cost: Money.USD.zero,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            }
        const estimatedCost = settlement ? SessionUsage.estimatedCost(effective.cost, settlement.tokens) : undefined
        const cache = settlement ? providerCache(settlement) : undefined
        const invalidation =
          override ??
          (requestTrackerState.continuationFallback === true
            ? "retry-fallback"
            : requestTracker.defaultInvalidation === "compaction-reset"
              ? "compaction-reset"
              : settlement && settlement.tokens.cache.read > 0
              ? "stable-hit"
              : cache?.mechanism === "none"
                ? "cache-disabled"
                : cache && !cache.readReported
                  ? "provider-not-reported"
                  : undefined)
        return Effect.all(
          [
            requestTracker.complete({
              tokens: usage.tokens,
              ...(estimatedCost === undefined ? {} : { cost: estimatedCost }),
              continuation:
                requestTrackerState.continuationFallback === true
                  ? "fallback"
                  : originalPrepared.continuation.used
                    ? "continued"
                    : "full",
              ...(invalidation === undefined ? {} : { invalidation }),
              ...(cache === undefined ? {} : { cacheReadReported: cache.readReported }),
            }),
            cacheRuntime.observe({
              namespace: originalPrepared.cache.promptCacheKey,
              cacheRead: usage.tokens.cache.read,
              cacheWrite: usage.tokens.cache.write,
              eligible: usage.tokens.input + usage.tokens.cache.read + usage.tokens.cache.write,
            }),
          ],
          { discard: true },
        )
      }

      const captureStepEnd = Effect.fnUntraced(function* () {
        const snapshot = yield* snapshots.capture()
        const files =
          startSnapshot && snapshot
            ? yield* snapshots
                .files({ from: startSnapshot, to: snapshot })
                .pipe(Effect.catch(() => Effect.succeed(undefined)))
            : undefined
        return { snapshot, files }
      })

      const publishStepEnd = (settlement: NonNullable<ReturnType<typeof publisher.stepSettlement>>, end: StepEnd) =>
        Effect.gen(function* () {
          const cache = providerCache(settlement)
          const responseID = settlement.providerState?.responseId
          yield* serialized(
            events.publish(
              SessionEvent.Step.Ended,
              {
                sessionID: session.id,
                assistantMessageID: yield* publisher.startAssistant(),
                finish: settlement.finish,
                ...stepUsage(settlement),
                contextLimit: effectiveModel.route.defaults.limits?.context,
                ...(cache === undefined ? {} : { providerCache: cache }),
                ...end,
              },
              {
                commit: () =>
                  Effect.gen(function* () {
                    yield* Effect.forEach(providerStateCaptures, (capture) =>
                      SessionProviderState.captureInTransaction(db, capture),
                    )
                    if (
                      originalPrepared.continuation.eligible &&
                      typeof responseID === "string" &&
                      responseID.length > 0
                    )
                      yield* SessionContinuation.rememberInTransaction(db, {
                        ...originalPrepared.continuation.fingerprint,
                        responseID,
                        representedThroughMessageID: originalPrepared.continuation.representedThroughMessageID,
                        representedMessageCount: originalPrepared.continuation.representedMessageCount,
                      })
                  }).pipe(Effect.orDie),
              },
            ),
          )
          yield* completeProviderRequest(settlement)
        })

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // Gather the evidence: how did the provider stream end?
          const stream = yield* restore(providerStream).pipe(Effect.exit)
          const streamFailure = Option.getOrUndefined(Exit.findErrorOption(stream))
          // Note: Exit.hasInterrupts is a type guard whose false branch unsoundly narrows
          // away non-interrupt failures, so both interrupt checks stay Cause-based.
          const streamInterrupted = stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)
          const streamSettlementFailure =
            streamFailure ?? (stream._tag === "Failure" && !streamInterrupted ? Cause.squash(stream.cause) : undefined)
          const llmFailure = streamFailure instanceof LLMError ? streamFailure : undefined
          const contextOverflowFailure =
            overflowFailure !== undefined || (llmFailure !== undefined && isContextOverflowFailure(llmFailure))

          let overflowLimit: SessionError.Error | undefined
          if (contextOverflowFailure && !publisher.hasRetryEvidence()) {
            if (requestTrackerState.overflowRecovery === undefined) {
              requestTrackerState.overflowRecovery = "pending"
              return {
                _tag: "RestartAfterOverflow",
                step: currentStep,
                promoted,
                assistantMessageID: publisher.hasStepStarted() ? yield* publisher.startAssistant() : undefined,
              } as const
            }
            overflowLimit = {
              type: "context.limit",
              message: "The provider still rejected the request for context overflow after one compaction rebase",
            }
            yield* serialized(publisher.failAssistant(overflowLimit))
          }

          const invalidPreviousResponse =
            continuationFailure !== undefined ||
            (streamFailure instanceof LLMError && isInvalidPreviousResponse(streamFailure.reason.message))
          if (originalPrepared.continuation.used && !publisher.hasRetryEvidence() && invalidPreviousResponse) {
            yield* continuation.clear(session.id)
            return {
              _tag: "RestartWithoutContinuation",
              step: currentStep,
              promoted,
              assistantMessageID: publisher.hasStepStarted() ? yield* publisher.startAssistant() : undefined,
            } as const
          }

          // An unrecovered held-back overflow becomes the step's durable provider error. A
          // thrown LLM failure records the assistant failure unless a provider error was
          // already recorded from the stream. Terminal publication waits for owned tools.
          if (overflowFailure && !overflowLimit) yield* publish(overflowFailure)
          if (llmFailure && !streamInterrupted && !publisher.hasProviderError()) {
            const error = toSessionError(llmFailure)
            if (
              recoveryMode !== "terminal-response" &&
              SessionRunnerRetry.isRetryable(llmFailure) &&
              !publisher.hasRetryEvidence()
            ) {
              yield* serialized(publisher.flush())
              return yield* new SessionRunnerRetry.RetryableFailure({
                cause: llmFailure,
                assistantMessageID: yield* publisher.startAssistant(),
                error,
                step: currentStep,
              })
            }
            yield* serialized(publisher.failAssistant(error))
          }
          if (streamSettlementFailure && !llmFailure && !streamInterrupted && !publisher.hasProviderError())
            yield* serialized(publisher.failAssistant(toSessionError(streamSettlementFailure)))
          // Provider error events only arrive from the stream, so the flag is final here.
          const providerFailed = publisher.hasProviderError()
          const postOutputCodexReadFailure =
            effectiveModel.route.id === OpenAICodex.routeID &&
            !providerFailed &&
            !streamInterrupted &&
            llmFailure?.reason._tag === "Transport" &&
            llmFailure.reason.kind === "read" &&
            publisher.hasRetryEvidence()
          const recoverableTransportFailure = recoveryMode === "normal" && postOutputCodexReadFailure

          // Settle every owned tool fiber. FiberSet.join returns on the first failure, so retain
          // the individual fibers and await all exits before publishing the terminal step event.
          if (streamInterrupted) yield* FiberSet.clear(toolFibers)
          const settled = yield* restore(
            Effect.forEach(ownedToolFibers, Fiber.await, { concurrency: "unbounded" }),
          ).pipe(Effect.exit)
          const settledCauses =
            settled._tag === "Failure"
              ? [settled.cause]
              : settled.value.flatMap((exit) => (exit._tag === "Failure" ? [exit.cause] : []))
          const toolsInterrupted = settledCauses.some(Cause.hasInterrupts)
          const userDeclined = settledCauses.some(isUserDeclined)

          if (settled._tag === "Failure") yield* FiberSet.clear(toolFibers)
          if (userDeclined || streamInterrupted || toolsInterrupted) {
            yield* serialized(publisher.failUnsettledTools({ type: "aborted", message: "Tool execution interrupted" }))
            yield* serialized(publisher.failAssistant({ type: "aborted", message: "Step interrupted" }))
          }
          // A settled tool fiber failure is one of two things. A defect from a tool
          // implementation becomes a failed tool call the model can read, and the step still
          // settles so the model may recover. A typed infrastructure failure (tool output
          // could not be persisted) also fails the assistant and then fails the drain.
          const settledFailure = settledCauses.find((cause) => !Cause.hasInterrupts(cause) && !isUserDeclined(cause))
          const infraError =
            settledFailure === undefined ? undefined : Option.getOrUndefined(Cause.findErrorOption(settledFailure))
          if (settledFailure !== undefined) {
            const failure = infraError ?? Cause.squash(settledFailure)
            const error = toSessionError(failure)
            yield* serialized(publisher.failUnsettledTools(error))
            if (infraError !== undefined) yield* serialized(publisher.failAssistant(error))
          }

          // Fail unresolved calls before the terminal step event. Local calls have joined, so
          // these sweeps only close calls that could not produce a truthful settlement.
          if (providerFailed)
            yield* serialized(publisher.failUnsettledTools({ type: "aborted", message: "Tool execution interrupted" }))
          if (llmFailure && !providerFailed)
            yield* serialized(
              publisher.failUnsettledTools(
                {
                  type: "tool.result-missing",
                  message: "Provider did not return a tool result",
                },
                true,
              ),
            )
          const hostedResultMissing =
            stream._tag === "Success" && !providerFailed
              ? yield* serialized(
                  publisher.failUnsettledTools(
                    { type: "tool.result-missing", message: "Provider did not return a tool result" },
                    true,
                  ),
                )
              : false
          if (hostedResultMissing && !publisher.stepSettlement())
            yield* serialized(
              publisher.failAssistant({
                type: "tool.result-missing",
                message: "Provider did not return a tool result",
              }),
            )

          const missingSettlement =
            stream._tag === "Success" && !providerFailed && publisher.stepSettlement() === undefined
          let carriedStepFailure: SessionError.Error | undefined
          if (missingSettlement && !publisher.stepFailure()) {
            const error = { type: "provider.invalid-output", message: "Provider did not settle the step" } as const
            if (publisher.hasStepStarted()) yield* serialized(publisher.failAssistant(error))
            if (!publisher.hasStepStarted() && assistantMessageID !== undefined) {
              carriedStepFailure = error
              yield* serialized(
                events.publish(SessionEvent.Step.Failed, {
                  sessionID: session.id,
                  assistantMessageID,
                  error,
                  ...(yield* captureStepEnd()),
                }),
              )
            }
          }
          const existingStepFailure = publisher.stepFailure() ?? carriedStepFailure
          if (
            recoveryMode === "terminal-response" &&
            !existingStepFailure &&
            (!publisher.stepSettlement() || !publisher.hasAssistantText() || needsContinuation)
          )
            yield* serialized(
              publisher.failAssistant({
                type: "provider.invalid-output",
                message: "Terminal response recovery requires non-whitespace assistant text",
              }),
            )
          const stepFailure = publisher.stepFailure() ?? carriedStepFailure
          const stepSettlement = publisher.stepSettlement()
          if (stepSettlement && !stepFailure) yield* publishStepEnd(stepSettlement, yield* captureStepEnd())
          if (stepFailure && carriedStepFailure === undefined) {
            const end = yield* captureStepEnd()
            const cache = stepSettlement ? providerCache(stepSettlement) : undefined
            yield* serialized(
              publisher.publishStepFailure({
                ...(stepSettlement ? stepUsage(stepSettlement) : {}),
                ...(cache === undefined ? {} : { providerCache: cache }),
                ...end,
              }),
            )
            yield* completeProviderRequest(stepSettlement)
          }
          if (!stepSettlement) {
            yield* completeProviderRequest(undefined, "provider-not-reported")
          }

          const recoverableTerminalSilence =
            recoveryMode !== "terminal-response" &&
            missingSettlement &&
            !publisher.hasAssistantText() &&
            !needsContinuation &&
            (!publisher.hasStepStarted() || stepFailure?.type === "provider.invalid-output")
          const promotePendingSteerAfterExhaustedRecovery =
            recoveryMode === "terminal-response" &&
            !publisher.hasAssistantText() &&
            !needsContinuation &&
            stepFailure?.type === "provider.invalid-output" &&
            (yield* SessionPending.has(db, session.id, "steer"))
          const promotePendingSteerAfterTransportRecovery =
            recoveryMode === "transport" &&
            postOutputCodexReadFailure &&
            (yield* SessionPending.has(db, session.id, "steer"))
          if (overflowLimit) return yield* new StepFailedError({ error: overflowLimit })
          if (streamInterrupted) return yield* Effect.interrupt
          if (
            stream._tag === "Failure" &&
            !recoverableTransportFailure &&
            !promotePendingSteerAfterTransportRecovery
          )
            return yield* Effect.failCause(stream.cause)
          if (userDeclined) return yield* Effect.interrupt
          if ((toolsInterrupted || infraError !== undefined) && settledFailure)
            return yield* Effect.failCause(settledFailure)
          if (toolsInterrupted && settled._tag === "Failure") return yield* Effect.failCause(settled.cause)
          if (
            stepFailure &&
            !recoverableTerminalSilence &&
            !promotePendingSteerAfterExhaustedRecovery &&
            !promotePendingSteerAfterTransportRecovery &&
            !recoverableTransportFailure
          )
            return yield* new StepFailedError({ error: stepFailure })
          return {
            _tag: "Completed",
            needsContinuation:
              needsContinuation ||
              promotePendingSteerAfterExhaustedRecovery ||
              promotePendingSteerAfterTransportRecovery,
            step: currentStep,
            promoted,
            transportRecovery: recoverableTransportFailure,
            terminalSilence:
              recoverableTerminalSilence ||
              (stepSettlement !== undefined && !publisher.hasAssistantText() && !needsContinuation),
          } as const
        }),
      )
    }, Effect.scoped)

    const runStep = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionPending.Delivery | undefined,
      step: number,
      execution: number,
      recoveryMode: RecoveryMode = "normal",
    ) {
      let currentPromotion = promotion
      let currentStep = step
      let assistantMessageID: SessionMessage.ID | undefined
      let promoted = false
      const requestTrackerState: AttemptState = { attempts: 0 }
      const completeRetryFallback = () =>
        requestTrackerState.current?.complete({
          invalidation: "retry-fallback",
          continuation: "fallback",
          cost: Money.USD.zero,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }) ?? Effect.void
      while (true) {
        const attempt = yield* Effect.suspend(() =>
          attemptStep(
            sessionID,
            currentPromotion,
            currentStep,
            requestTrackerState,
            execution,
            assistantMessageID,
            recoveryMode,
            () => {
              promoted = true
            },
          ),
        ).pipe(
          Effect.tapError((error) =>
            error instanceof SessionRunnerRetry.RetryableFailure
              ? Effect.sync(() => {
                  currentStep = error.step
                  assistantMessageID = error.assistantMessageID
                  currentPromotion = undefined
                })
              : Effect.void,
          ),
          Effect.retryOrElse(SessionRunnerRetry.schedule(events, sessionID, requestTrackerState.attempts), (error) => {
            if (!(error instanceof SessionRunnerRetry.RetryableFailure)) return Effect.fail(error)
            return completeRetryFallback().pipe(
              Effect.andThen(
                events.publish(SessionEvent.Step.Failed, {
                  sessionID,
                  assistantMessageID: error.assistantMessageID,
                  error: error.error,
                }),
              ),
              Effect.andThen(Effect.fail(error.cause)),
            )
          }),
        )
        if (attempt._tag === "Completed")
          return {
            needsContinuation: attempt.needsContinuation,
            step: attempt.step,
            promoted,
            transportRecovery: attempt.transportRecovery,
            terminalSilence: attempt.terminalSilence,
          }
        if (attempt._tag === "RestartWithoutContinuation") {
          requestTrackerState.continuationFallback = true
          assistantMessageID = attempt.assistantMessageID ?? assistantMessageID
        }
        if (attempt._tag === "RestartAfterOverflow")
          assistantMessageID = attempt.assistantMessageID ?? assistantMessageID
        yield* Effect.yieldNow
        currentPromotion = undefined
        currentStep = attempt.step
      }
    })

    // Execution lifecycle is published per busy period by SessionExecution, not per drain here.
    const drainExecution = Effect.fn("SessionRunner.drainExecution")(function* (
      input: {
        readonly sessionID: SessionSchema.ID
        readonly force: boolean
      },
      execution: number,
    ) {
      const hasSteer = yield* SessionPending.has(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionPending.has(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue) return
      yield* failInterruptedTools(input.sessionID)
      let promotion: SessionPending.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      let shouldRun = input.force || hasSteer || hasQueue
      let terminalResponseRecoveryUsed = false
      while (shouldRun) {
        let needsContinuation = true
        let step = 1
        let recoveryMode: RecoveryMode = "normal"
        // Repeat steps while continuation is needed. A step needs continuation only
        // when it recorded local tool calls whose results the model has not yet seen;
        // a provider error suppresses it. Pending steers also continue the loop so
        // interjections are answered before the session goes idle.
        while (needsContinuation) {
          const result = yield* runStep(input.sessionID, promotion, step, execution, recoveryMode)
          // Steer/queue promotion inside runStep has already made the pending input a visible
          // user message by this point, so the first-user-message check below is reliable.
          if (!titleAttempted.has(input.sessionID)) {
            titleAttempted.add(input.sessionID)
            forkTitle(title.generateForFirstPrompt(yield* getSession(input.sessionID)).pipe(Effect.ignore))
          }
          if (result.promoted) terminalResponseRecoveryUsed = false
          needsContinuation = result.needsContinuation
          step = result.step + 1
          recoveryMode = "normal"
          if (result.transportRecovery) {
            if (yield* SessionPending.has(db, input.sessionID, "steer")) {
              needsContinuation = true
              promotion = "steer"
              continue
            }
            recoveryMode = "transport"
            needsContinuation = true
            promotion = undefined
            continue
          }
          if (result.terminalSilence && !needsContinuation && !terminalResponseRecoveryUsed) {
            if (yield* SessionPending.has(db, input.sessionID, "steer")) {
              needsContinuation = true
              promotion = "steer"
              continue
            }
            terminalResponseRecoveryUsed = true
            recoveryMode = "terminal-response"
            needsContinuation = true
            promotion = undefined
            continue
          }
          if (needsContinuation) {
            promotion = "steer"
            continue
          }
          promotion = "steer"
          needsContinuation = yield* SessionPending.has(db, input.sessionID, "steer")
        }
        const hasSteer = yield* SessionPending.has(db, input.sessionID, "steer")
        const hasQueue = hasSteer ? false : yield* SessionPending.has(db, input.sessionID, "queue")
        shouldRun = hasSteer || hasQueue
        promotion = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      }
    })

    const drain = Effect.fn("SessionRunner.drain")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      const execution = ++executionGeneration
      return yield* drainExecution(input, execution)
    })

    return Service.of({ drain })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    llmClient,
    SessionContext.node,
    SessionModelRequest.node,
    SessionProviderRequest.node,
    SessionCacheRuntime.node,
    SessionContinuation.node,
    SessionProviderState.node,
    SessionCompactionJob.node,
    SessionStore.node,
    SessionCompaction.node,
    SessionTitle.node,
    Config.node,
    Snapshot.node,
    Database.node,
  ],
})

const isInvalidPreviousResponse = (message: string) =>
  /previous[_ ]response(?:_id)?/i.test(message) && /invalid|expired|not found|unknown/i.test(message)
