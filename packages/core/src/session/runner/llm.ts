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
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { classifyProviderFailure } from "@ycoding-ai/ai/provider-error"
import { SessionError } from "@ycoding-ai/schema/session-error"
import { Cause, Clock, Effect, Exit, Fiber, FiberSet, Layer, Option, Schedule, Semaphore, Stream } from "effect"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventRuntime } from "../../event"
import { EventTable } from "../../event/sql"
import { Permission } from "../../permission"
import { Skill } from "../../skill"
import { FSUtil } from "../../fs-util"
import { ProjectArtifactAccounting } from "../../project-artifact/accounting"
import { ProjectArtifactSource } from "../../project-artifact/source"
import { SessionSkill } from "../skill"
import { ToolOutputStore } from "../../tool-output-store"
import { InstructionState } from "../instruction-state"
import { SessionCompaction } from "../compaction"
import { SessionCacheDiagnostics } from "../cache-diagnostics"
import { SessionContext } from "../context"
import { SessionCompactionJob } from "../compaction-job"
import { SessionContextPressure } from "../context-pressure"
import { SessionEvent } from "../event"
import { SessionPending } from "../pending"
import { SessionProviderRequest } from "../provider-request"
import { SessionUsageAttribution } from "../usage-attribution"
import { SessionStepBoundary } from "../step-boundary"
import { SessionModelRequest } from "../model-request"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionTitle } from "../title"
import { SessionPrediction } from "../prediction"
import { Service } from "./index"
import { createLLMEventPublisher } from "./publish-llm-event"
import { RelativePath } from "../../schema"
import { Snapshot } from "../../snapshot"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"
import { StepFailedError } from "../error"
import { toSessionError } from "../to-session-error"
import { SessionCompactionGate } from "./compaction-gate"
import { SessionContinuation } from "./continuation"
import { SessionProviderState } from "../provider-state"
import { SessionRunnerRetry } from "./retry"
import { SessionModelFallback } from "./fallback"
import type { Model } from "@ycoding-ai/schema/model"
import { SessionUsage } from "../usage"
import { Token } from "../../util/token"
import { SessionLiveState } from "../live-state"
import { renderTeamObservation } from "../orchestration-view"
import { SessionHistory } from "../history"
import { ModelIncident } from "../../model-incident/index"
import { MAX_STEPS_PROMPT, MAX_STEPS_RESET_PROMPT } from "./max-steps"
import { DotsPeer } from "../../dots/peer"
import { DotsContext } from "../../dots/context"
import { DotsRuntimeNode } from "../../dots/node"
import { and, eq, inArray, sql } from "drizzle-orm"

type StepEnd = {
  readonly snapshot?: Snapshot.ID
  readonly files?: readonly RelativePath[]
}

type AttemptState = {
  current?: SessionProviderRequest.Tracker
  completeFallback?: () => Effect.Effect<void>
  accountIdentityDigest?: string
  mixedAccountProvenance?: boolean
  contextBreakdown?: ReturnType<typeof SessionContextPressure.breakdown>
  attempts: number
  continuationFallback?: boolean
  overflowRecovery?: "pending" | "used"
  skills?: ReadonlyArray<Skill.ID>
  agent?: SessionContext.Selection["agent"]["id"]
  route: Route
}

type Route = {
  primary?: Model.Ref
  model?: Model.Ref
  attempting?: Model.Ref
  tried: Model.Ref[]
}

type RecoveryMode = "normal" | "terminal-response" | "provider"
const isContextSource = (value: unknown): value is SessionHistory.ObservationSource =>
  value === "session-state" || value === "team-view" || value === "step-limit" || value === "dots"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const stepBoundary = yield* SessionStepBoundary.Service
    const llm = yield* LLMClient.Service
    const store = yield* SessionStore.Service
    const context = yield* SessionContext.Service
    const modelRequests = yield* SessionModelRequest.Service
    const snapshots = yield* Snapshot.Service
    const database = yield* Database.Service
    const db = database.db
    const dotsTools = yield* DotsRuntimeNode.RequestTools
    const promoteRoutine: SessionPending.PromotionGuard<StepFailedError> = (entry, promote) =>
      dotsTools.promoteRoutine(entry, promote).pipe(
        Effect.catchTag("DotsRuntime.Error", (error) => Effect.fail(new StepFailedError({ error: toSessionError(error) }))),
      )
    const dotsContext = DotsContext.make({ db, events })
    const compaction = yield* SessionCompaction.Service
    const compactionJobs = yield* SessionCompactionJob.Service
    const config = yield* Config.Service
    const title = yield* SessionTitle.Service
    const providerRequests = yield* SessionProviderRequest.Service
    const continuation = yield* SessionContinuation.Service
    const liveState = yield* SessionLiveState.Service
    const skills = yield* Skill.Service
    const fs = yield* FSUtil.Service
    const permission = yield* Permission.Service
    const accounting = yield* ProjectArtifactAccounting.Service
    const artifactSource = yield* ProjectArtifactSource.Service
    const resolveRequestedSkills = Effect.fn("SessionRunner.resolveRequestedSkills")(function* (
      selected: SessionContext.Selection,
      ids: ReadonlyArray<Skill.ID>,
      catalog: ReadonlyArray<Skill.Info>,
    ) {
      return yield* Effect.forEach(ids, (id) =>
        Effect.gen(function* () {
          const skill = catalog.find((skill) => skill.id === id)
          if (!skill)
            return yield* new StepFailedError({
              error: { type: "skill.unavailable", message: `Skill unavailable: ${id}` },
            })
          const access = yield* permission
            .evaluateEffective({
              sessionID: selected.session.id,
              agent: selected.agent.id,
              action: "skill",
              resource: id,
            })
            .pipe(Effect.orDie)
          if (access === "deny")
            return yield* new StepFailedError({
              error: { type: "permission.rejected", message: `Permission denied: skill (${id})` },
            })
          return skill
        }),
      )
    })
    const activateSkills = Effect.fn("SessionRunner.activateSkills")(function* (
      selected: SessionContext.Selection,
      resolved: ReadonlyArray<Skill.Info>,
    ) {
      yield* Effect.forEach(
        resolved,
        (skill) =>
          Effect.gen(function* () {
            const provenance = yield* artifactSource.provenance("skill", skill.id)
            yield* SessionSkill.activate(
              { events, store, accounting, fs },
              { session: selected.session, skill, provenance },
            ).pipe(Effect.orDie)
          }),
        { discard: true },
      )
    })
    const activateRequestedSkills = Effect.fn("SessionRunner.activateRequestedSkills")(function* (
      selected: SessionContext.Selection,
      ids: ReadonlyArray<Skill.ID>,
      catalog: ReadonlyArray<Skill.Info>,
    ) {
      yield* activateSkills(selected, yield* resolveRequestedSkills(selected, ids, catalog))
    })
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
      for (const message of yield* SessionHistory.unsettledToolMessages(db, sessionID)) {
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
    const appendContextObservations = Effect.fn("SessionRunner.appendContextObservations")(function* (
      selected: SessionContext.Selection,
      step: number,
      terminalResponseRecovery: boolean,
    ) {
      const history = yield* SessionHistory.observationState(db, selected.session.id)
      const observed = yield* db
        .selectDistinct({ source: sql<string>`json_extract(${EventTable.data}, '$.source')` })
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, selected.session.id),
            eq(
              EventTable.type,
              EventRuntime.versionedType(
                SessionEvent.ContextObserved.type,
                SessionEvent.ContextObserved.durable.version,
              ),
            ),
            inArray(sql<string>`json_extract(${EventTable.data}, '$.source')`, [
              "session-state",
              "team-view",
              "step-limit",
            ]),
          ),
        )
        .limit(3)
        .all()
        .pipe(Effect.orDie)
      const observedSources = new Set(
        observed.flatMap((event) => (isContextSource(event.source) ? [event.source] : [])),
      )
      const state = yield* liveState.load(selected.session.id).pipe(Effect.orDie)
      const inheritedTeam = state.teamView === undefined ? history.present.has("team-view") : false
      const stepLimitReached = selected.agent.info.steps !== undefined && step >= selected.agent.info.steps
      const stepLimit = terminalResponseRecovery
        ? undefined
        : stepLimitReached
          ? MAX_STEPS_PROMPT
          : observedSources.has("step-limit") || history.present.has("step-limit")
            ? MAX_STEPS_RESET_PROMPT
            : undefined
      const observations = [
        { source: "session-state" as const, text: state.text },
        ...(state.teamView
          ? [{ source: "team-view" as const, text: state.teamView.text }]
          : inheritedTeam || observedSources.has("team-view")
            ? [{ source: "team-view" as const, text: renderTeamObservation([]).text }]
            : []),
        ...(stepLimit ? [{ source: "step-limit" as const, text: stepLimit }] : []),
      ]
      yield* Effect.forEach(
        observations.filter((observation) => history.latest.get(observation.source) !== observation.text),
        (observation) =>
          events.publish(SessionEvent.ContextObserved, {
            sessionID: selected.session.id,
            source: observation.source,
            text: observation.text,
          }),
        { discard: true },
      )
      yield* dotsContext.observe(selected.session.id, yield* dotsTools.observation(
        selected.session.id,
        SessionContext.toolPermissions(selected.agent.info, selected.session.permissionCeiling ?? []),
        terminalResponseRecovery || stepLimitReached,
      ))
    })

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
      let selected = yield* context.select(sessionID)
      const route = requestTrackerState.route
      // Establish what the model knows before admitting what the user said, so
      // a blocked first step leaves pending inputs untouched.
      yield* InstructionState.prepare(db, events, selected.instructions, selected.session.id)
      let currentStep = step
      let promoted = 0
      let resetting = 0
      const inputSkills = new Map<string, ReadonlyArray<Skill.Info>>()
      const dispatchInputs = new Set<SessionMessage.ID>()
      const prepareInput = Effect.fn("SessionRunner.prepareInput")(function* (entry: SessionPending.Info) {
        if (DotsPeer.resetsStepAllowance(entry)) resetting++
        if (entry.type !== "user") return
        if (entry.data.metadata?.inputOrigin === "coordination") dispatchInputs.add(entry.id)
        const requested = SessionSkill.selected(entry.data.metadata)
        if (!requested.length && !entry.data.text.includes("$")) return
        const catalog = yield* skills.list()
        const ids = [
          ...new Set([
            ...requested,
            ...SessionSkill.mentions(entry.data.text, catalog).map((skill) => Skill.ID.make(skill.id)),
          ]),
        ]
        inputSkills.set(entry.id, yield* resolveRequestedSkills(selected, ids, catalog))
        requestTrackerState.skills = [...new Set([...(requestTrackerState.skills ?? []), ...ids])]
      })
      const activateInputSkills = Effect.fn("SessionRunner.activateInputSkills")(function* (
        entry: SessionPending.Info,
      ) {
        const resolved = inputSkills.get(entry.id)
        if (resolved) yield* activateSkills(selected, resolved)
      })
      if (promotion) {
        if (promotion === "steer")
          promoted = yield* SessionPending.promoteSteers(
            db,
            events,
            selected.session.id,
            prepareInput,
            activateInputSkills,
            promoteRoutine,
          )
        if (promotion === "queue") {
          promoted += Number(
            yield* SessionPending.promoteNextQueued(db, events, selected.session.id, prepareInput, activateInputSkills, promoteRoutine),
          )
          promoted += yield* SessionPending.promoteSteers(
            db,
            events,
            selected.session.id,
            prepareInput,
            activateInputSkills,
            promoteRoutine,
          )
        }
        if (promoted > 0) {
          if (resetting > 0) currentStep = 1
          if (selected.modelOverride !== undefined || dispatchInputs.size > 0) {
            selected = yield* context.select(sessionID)
            yield* InstructionState.prepare(db, events, selected.instructions, selected.session.id)
          }
          onPromotion?.()
        }
      }
      requestTrackerState.agent = selected.agent.id
      const selectedModel = selected.modelOverride ?? selected.session.model
      if (
        route.primary !== undefined &&
        selectedModel !== undefined &&
        (route.primary.providerID !== selectedModel.providerID ||
          route.primary.id !== selectedModel.id ||
          route.primary.profile !== selectedModel.profile ||
          route.primary.variant !== selectedModel.variant)
      ) {
        route.primary = undefined
        route.model = undefined
        route.tried.length = 0
      }
      if (!promotion && requestTrackerState.skills?.length)
        yield* activateRequestedSkills(selected, requestTrackerState.skills, yield* skills.list())
      yield* appendContextObservations(selected, currentStep, recoveryMode === "terminal-response")
      const configEntries = yield* config.entries()
      const fallbackFrom = (attempted: Model.Ref, error: SessionError.Error) =>
        Effect.gen(function* () {
          const primary = route.primary ?? attempted
          const next =
            recoveryMode === "terminal-response" || selected.modelOverride !== undefined
              ? undefined
              : SessionModelFallback.next(configEntries, primary, [...route.tried, attempted])
          if (next === undefined) return undefined
          route.primary = primary
          return {
            _tag: "RestartWithFallback",
            step: currentStep,
            promoted,
            assistantMessageID: yield* startedAssistant(attempted),
            from: attempted,
            next,
            error,
          } as const
        })
      const startedAssistant = (attempted: Model.Ref) =>
        Effect.gen(function* () {
          if (assistantMessageID !== undefined) return assistantMessageID
          const started = SessionMessage.ID.create()
          const snapshot = yield* snapshots.capture()
          yield* events.publish(SessionEvent.Step.Started, {
            sessionID: selected.session.id,
            assistantMessageID: started,
            agent: selected.agent.id,
            model: attempted,
            snapshot,
          })
          return started
        })
      const loading = yield* context.load(selected, route.model === undefined ? undefined : { model: route.model }).pipe(
        Effect.map((loaded) => ({ _tag: "Loaded", loaded }) as const),
        Effect.catchIf(SessionModelFallback.unavailable, (error) =>
          Effect.gen(function* () {
            const attempted = route.model ?? selectedModel
            if (attempted === undefined) return yield* error
            return (yield* fallbackFrom(attempted, toSessionError(error))) ?? (yield* error)
          }),
        ),
      )
      if (loading._tag === "RestartWithFallback") return loading
      const initialContext = loading.loaded
      const attempting = initialContext.model.ref
      const primary = (route.primary ??= selectedModel ?? attempting)
      route.attempting = attempting
      const prepare = (loaded: SessionContext.Loaded, fullRebase = false) =>
        modelRequests.prepare({
          context: loaded,
          step: currentStep,
          execution,
          disableContinuation:
            fullRebase ||
            requestTrackerState.continuationFallback === true ||
            recoveryMode !== "normal" ||
            route.model !== undefined,
          terminalResponseRecovery: recoveryMode === "terminal-response",
        })
      const initialPrepared = yield* prepare(initialContext)
      const limits = initialContext.model.model.route.defaults.limits
      const compactionPolicy = SessionContextPressure.policy(configEntries)
      const lastProviderInput = SessionCacheDiagnostics.latestAssistant(initialContext.messages)?.tokens
      const fallbackNext =
        recoveryMode === "terminal-response" || selected.modelOverride !== undefined
          ? undefined
          : SessionModelFallback.next(configEntries, primary, [...route.tried, attempting])
      if (
        route.model !== undefined &&
        fallbackNext !== undefined &&
        limits?.context !== undefined &&
        SessionCompactionGate.estimatedProviderInputTokens(initialPrepared.request) >=
          limits.context - compactionPolicy.contextSafetyMarginTokens
      ) {
        const skipped = yield* fallbackFrom(attempting, {
          type: "context.limit",
          message: `The request exceeds the input budget of ${attempting.providerID}/${attempting.id}`,
        })
        if (skipped) return skipped
      }
      const candidate =
        route.model !== undefined || limits?.context === undefined || limits.output === undefined
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
              prepareOwner: (job) =>
                Effect.gen(function* () {
                  const loaded = yield* context.load(yield* context.select(job.sessionID))
                  const through = yield* SessionHistory.entriesForModelThrough(
                    db,
                    job.sessionID,
                    job.requestedThrough.seq,
                  )
                  const ids = new Set(through.map((entry) => entry.message.id))
                  const owner = yield* modelRequests.prepare({
                    context: {
                      ...loaded,
                      messages: loaded.messages.filter(
                        (message) =>
                          ids.has(message.id) ||
                          (message.type === "synthetic" && message.metadata?.remoteCompactionV2 === true),
                      ),
                    },
                    step: currentStep,
                    disableContinuation: true,
                  })
                  return {
                    request: owner.request,
                    cache: owner.cache,
                    cost: loaded.model.cost,
                    modelRef: loaded.model.ref,
                    accountIdentityDigest: loaded.model.accountIdentityDigest,
                    contextRevision: loaded.contextRevision,
                  }
                }),
              force: requestTrackerState.overflowRecovery === "pending",
              canReduce: (candidate, target) =>
                SessionCompactionGate.canReduce(candidate.prepared.request, candidate.context.messages, target),
              ...(lastProviderInput === undefined
                ? {}
                : {
                    lastProviderInputTokens:
                      lastProviderInput.input + lastProviderInput.cache.read + lastProviderInput.cache.write,
                    lastProviderTotalTokens:
                      lastProviderInput.input +
                      lastProviderInput.output +
                      lastProviderInput.reasoning +
                      lastProviderInput.cache.read +
                      lastProviderInput.cache.write,
                  }),
              reload: ({ fullRebase }) =>
                Effect.gen(function* () {
                  if (fullRebase) yield* continuation.clear(sessionID)
                  const selected = yield* context.select(sessionID)
                  yield* InstructionState.prepare(db, events, selected.instructions, selected.session.id)
                  if (requestTrackerState.skills?.length)
                    yield* activateRequestedSkills(selected, requestTrackerState.skills, yield* skills.list())
                  yield* appendContextObservations(selected, currentStep, recoveryMode === "terminal-response")
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
      if (requestTracker && requestTrackerState.accountIdentityDigest !== resolved.accountIdentityDigest)
        requestTrackerState.mixedAccountProvenance = true
      if (!requestTracker) {
        requestTracker = yield* providerRequests
          .next({
            sessionID: session.id,
            expectedContextRevision: loaded.contextRevision,
            inputID: loaded.messages.findLast((message) => message.type === "user")?.id,
            source: "step",
            agent: agent.id,
            model: resolved.ref,
            connectionIdentityDigest: resolved.accountIdentityDigest,
            routeID: resolved.model.route.id,
            promptCacheKey: originalPrepared.cache.promptCacheKey,
            systemDigest: originalPrepared.cache.systemDigest,
            toolDigest: originalPrepared.cache.toolDigest,
          })
          .pipe(Effect.catchTag("SessionProviderRequest.StaleContextRevision", () => Effect.succeed(undefined)))
        if (!requestTracker) return { _tag: "RestartAfterCompaction", step: currentStep, promoted } as const
        requestTrackerState.current = requestTracker
        requestTrackerState.accountIdentityDigest = resolved.accountIdentityDigest
      }
      const startSnapshot = yield* snapshots.capture()
      const prepared = {
        ...originalPrepared,
        request: LLMRequest.update(originalPrepared.request, { id: requestTracker.requestID }),
      }
      const contextBreakdown = SessionContextPressure.breakdown(prepared.request)
      requestTrackerState.contextBreakdown = contextBreakdown
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
      yield* Effect.acquireRelease(events.listen(publisher.observe), (unsubscribe) => unsubscribe)
      // Durable publishes are serialized so tool fibers and step settlement never interleave
      // mid-event.
      const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) => publication.withPermit(effect)
      const publish = (event: LLMEvent, error?: SessionError.Error) => serialized(publisher.publish(event, error))
      const stepUsage = (settlement: NonNullable<ReturnType<typeof publisher.stepSettlement>>) => ({
        cost: SessionUsage.calculateCost(effective.cost, settlement.tokens, settlement.oneHourCacheWrites),
        tokens: settlement.tokens,
      })
      const providerCache = (settlement: NonNullable<ReturnType<typeof publisher.stepSettlement>>) => ({
        mechanism: SessionCacheDiagnostics.mechanism(effectiveModel.route.id, effective.ref, settlement.tokens),
        ...settlement.reporting,
      })
      let overflowFailure: ProviderErrorEvent | undefined
      let continuationFailure: ProviderErrorEvent | undefined
      let firstTextNs: bigint | undefined
      let firstReasoningNs: bigint | undefined
      let firstToolInputNs: bigint | undefined
      let streamedOutput = ""
      const streamedToolInputs = new Set<string>()
      const completedToolInputs = new Set<string>()
      const receivedOutput = SessionUsage.receivedOutput()
      const recentGeneration = yield* providerRequests.recentSteps(session.id, effective.ref)
      const previousDiagnostics = yield* store.diagnostics(session.id)
      const previousSpeed = SessionCacheDiagnostics.generationSpeed(recentGeneration, { model: effective.ref })!
      const previous = previousDiagnostics ?? SessionCacheDiagnostics.calculate({
        model: effective.ref, tokens: SessionUsage.tokens(undefined), estimatedCost: Money.USD.zero,
      })
      const attempt = requestTrackerState.attempts + 1
      let lastPublishedNs: bigint | undefined
      let generationFrozen = false
      const liveGeneration = () => {
        const timing = receivedOutput.sample()
        const sample = SessionCacheDiagnostics.generationSample(timing ? { receivedOutput: timing } : undefined)
        return { attempt, ...(sample ? { sample: { model: effective.ref, ...sample } } : {}) }
      }
      const publishLiveGeneration = Effect.fnUntraced(function* () {
        const live = liveGeneration()
        yield* requestTracker.updateGeneration(live)
        const settlement = publisher.stepSettlement()
        const base = settlement ? SessionCacheDiagnostics.calculate({
          model: effective.ref,
          tokens: settlement.tokens,
          estimatedCost: stepUsage(settlement).cost,
          contextLimit: effectiveModel.route.defaults.limits?.context,
          contextBreakdown,
          routeID: effectiveModel.route.id,
          providerCache: providerCache(settlement),
        }) : previous
        yield* serialized(events.publish(SessionEvent.DiagnosticsUpdated, {
          sessionID: session.id,
          diagnostics: { ...base, generationSpeed: { ...previousSpeed, live: { requestID: ProviderRequest.ID.make(requestTracker.requestID), ...live } } },
        }))
      })
      let generationTiming: ReturnType<typeof SessionUsage.generationTiming>
      let generationUsage: Extract<LLMEvent, { type: "step-finish" }>["usage"]
      let generationEndedNs: bigint | undefined
      let generationDiagnosticsPublished = false
      const publishGenerationDiagnostics = Effect.fnUntraced(function* () {
        if (generationDiagnosticsPublished) return
        generationTiming = SessionUsage.generationTiming(generationUsage, {
          text: firstTextNs,
          reasoning: firstReasoningNs,
          toolInput: firstToolInputNs,
          started: generationStartedNs,
          ended: generationEndedNs ?? (yield* Clock.currentTimeNanos),
          streamedOutput,
        })
        generationDiagnosticsPublished = true
      })
      const [consumedInputID, ...remainingConsumedInputIDs] = consumedInputIDs
      let inputConsumptionPending = consumedInputID !== undefined
      requestTrackerState.attempts += 1
      const generationStartedNs = yield* Clock.currentTimeNanos
      const providerStream = publishLiveGeneration().pipe(
        Effect.andThen(llm.stream(prepared.request).pipe(Stream.runForEach((event) =>
          Effect.gen(function* () {
            const receivedNs = yield* Clock.currentTimeNanos
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
            yield* requestTracker.observeEvent(event)
            if (LLMEvent.is.providerError(event) && isContextOverflowFailure(event) && !publisher.hasRetryEvidence()) {
              overflowFailure = event
              return
            }
            if (
              LLMEvent.is.providerError(event) &&
              originalPrepared.continuation.used &&
              !publisher.hasRetryEvidence() &&
              !isContextOverflowFailure(event) &&
              (isInvalidPreviousResponse(event.message) || isBareInvalidPrompt(event.message))
            ) {
              continuationFailure = event
              return
            }
            if (LLMEvent.is.providerError(event)) {
              const failure = new LLMError({
                module: effectiveModel.route.id,
                method: "stream",
                reason: classifyProviderFailure({ message: event.message }),
              })
              if (
                SessionRunnerRetry.isRetryable(failure) ||
                (fallbackNext !== undefined && !publisher.hasRetryEvidence() && SessionModelFallback.immediate(failure))
              )
                yield* failure
            }
            if (event.type === "text-delta" || event.type === "reasoning-delta" || event.type === "tool-input-delta")
              streamedOutput += event.text
            if (event.type === "tool-input-delta" && event.text.length > 0) streamedToolInputs.add(event.id)
            const output = event.type === "text-delta" || event.type === "reasoning-delta" || event.type === "tool-input-delta"
              ? event.text
              : event.type === "tool-call" && !streamedToolInputs.has(event.id) && !completedToolInputs.has(event.id)
                ? JSON.stringify(event.input) ?? ""
                : ""
            if (event.type === "tool-call") completedToolInputs.add(event.id)
            if (event.type === "tool-call") streamedOutput += output
            if (!generationFrozen && output.length > 0) {
              receivedOutput.observe(receivedNs, Token.estimate(streamedOutput))
              yield* requestTracker.updateGeneration(liveGeneration())
              if (lastPublishedNs === undefined || receivedNs - lastPublishedNs >= 250_000_000n) {
                lastPublishedNs = receivedNs
                yield* publishLiveGeneration()
              }
            }
            if (event.type === "text-delta" && event.text.length > 0 && firstTextNs === undefined)
              firstTextNs = receivedNs
            if (event.type === "reasoning-delta" && event.text.length > 0 && firstReasoningNs === undefined)
              firstReasoningNs = receivedNs
            if (event.type === "tool-input-delta" && event.text.length > 0 && firstToolInputNs === undefined)
              firstToolInputNs = receivedNs
            if (LLMEvent.is.stepFinish(event)) {
              generationUsage = event.usage
              generationEndedNs = receivedNs
            }
            if (LLMEvent.is.providerError(event)) generationEndedNs ??= receivedNs
            yield* publish(event)
            if (LLMEvent.is.stepFinish(event)) {
              generationFrozen = true
              yield* publishLiveGeneration()
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
                  }).pipe(Effect.provideService(SessionUsageAttribution.Current, requestTracker.usageAnchor ?? null)),
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
        ))),
        Effect.onExit(() => Effect.gen(function* () {
          generationEndedNs ??= yield* Clock.currentTimeNanos
          if (!generationFrozen) {
            generationFrozen = true
            yield* publishLiveGeneration()
          }
        })),
        Effect.ensuring(serialized(publisher.flush())),
        Effect.onExit(() => requestTracker.settle()),
      )

      let requestCompleted = false
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
        const estimatedCost = settlement
          ? SessionUsage.estimatedCost(effective.cost, settlement.tokens, settlement.oneHourCacheWrites)
          : undefined
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
        return Effect.gen(function* () {
          if (requestCompleted) return
          requestCompleted = true
          yield* publishGenerationDiagnostics()
          const received = receivedOutput.sample()
          yield* requestTracker.complete({
            assistantMessageID: publisher.currentMessageID(),
            connectionIdentityDigest: requestTrackerState.mixedAccountProvenance
              ? null
              : requestTrackerState.accountIdentityDigest,
            tokens: usage.tokens,
            ...(estimatedCost === undefined ? {} : { cost: estimatedCost }),
            continuation:
              requestTrackerState.continuationFallback === true || override === "retry-fallback"
                ? "fallback"
                : originalPrepared.continuation.used
                  ? "continued"
                  : "full",
            ...(invalidation === undefined ? {} : { invalidation }),
            ...(cache === undefined ? {} : { cacheReadReported: cache.readReported }),
            ...(settlement?.timing === undefined && generationTiming === undefined && received === undefined
              ? {}
              : { timing: { ...settlement?.timing, ...generationTiming, ...(received ? { receivedOutput: received } : {}) } }),
          })
          yield* serialized(events.publish(SessionEvent.DiagnosticsUpdated, {
            sessionID: session.id,
            diagnostics: settlement ? SessionCacheDiagnostics.calculate({
              model: effective.ref,
              tokens: settlement.tokens,
              estimatedCost: stepUsage(settlement).cost,
              contextLimit: effectiveModel.route.defaults.limits?.context,
              contextBreakdown,
              routeID: effectiveModel.route.id,
              providerCache: providerCache(settlement),
              generationSpeed: SessionCacheDiagnostics.generationSpeed(recentGeneration,
                { model: effective.ref, timing: received ? { receivedOutput: received } : undefined }),
            }) : {
              ...previous,
              generationSpeed: SessionCacheDiagnostics.generationSpeed(recentGeneration,
                { model: effective.ref, timing: received ? { receivedOutput: received } : undefined }),
            },
          }))
        })
      }
      requestTrackerState.completeFallback = () => completeProviderRequest(publisher.stepSettlement(), "retry-fallback")

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
                contextBreakdown,
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
            if (
              requestTrackerState.overflowRecovery === undefined &&
              route.model === undefined &&
              (limits?.context === undefined ||
                limits.output === undefined ||
                SessionCompactionGate.canReduce(
                  prepared.request,
                  loaded.messages,
                  SessionCompactionGate.targetInputTokens(
                    {
                      contextWindowTokens: limits.context,
                    },
                    compactionPolicy,
                  ),
                ))
            ) {
              requestTrackerState.overflowRecovery = "pending"
              return {
                _tag: "RestartAfterOverflow",
                step: currentStep,
                promoted,
                assistantMessageID: publisher.hasStepStarted() ? yield* publisher.startAssistant() : undefined,
              } as const
            }
            if (requestTrackerState.overflowRecovery === "used") {
              overflowLimit = {
                type: "context.limit",
                message: "The provider still rejected the request for context overflow after one compaction rebase",
              }
              yield* serialized(publisher.failAssistant(overflowLimit))
            }
          }

          const invalidPreviousResponse =
            continuationFailure !== undefined ||
            (streamFailure instanceof LLMError && isInvalidPreviousResponse(streamFailure.reason.message)) ||
            (streamFailure instanceof LLMError &&
              streamFailure.reason._tag === "InvalidRequest" &&
              streamFailure.reason.classification !== "context-overflow" &&
              isBareInvalidPrompt(streamFailure.reason.message))
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
            if (fallbackNext !== undefined && !publisher.hasRetryEvidence() && SessionModelFallback.immediate(llmFailure)) {
              yield* serialized(publisher.flush())
              return {
                _tag: "RestartWithFallback",
                step: currentStep,
                promoted,
                assistantMessageID: yield* publisher.startAssistant(),
                from: attempting,
                next: fallbackNext,
                error,
              } as const
            }
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
          const postOutputProviderFailure =
            !providerFailed &&
            !streamInterrupted &&
            llmFailure !== undefined &&
            SessionRunnerRetry.isRetryable(llmFailure) &&
            ((llmFailure.reason._tag === "Transport" && llmFailure.reason.kind === "read") ||
              llmFailure.reason._tag === "ProviderInternal") &&
            publisher.hasRetryEvidence()
          const recoverableProviderFailure = recoveryMode === "normal" && postOutputProviderFailure

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

          if (settled._tag === "Failure") yield* FiberSet.clear(toolFibers)
          if (streamInterrupted || toolsInterrupted) {
            yield* serialized(publisher.failUnsettledTools({ type: "aborted", message: "Tool execution interrupted" }))
            yield* serialized(publisher.failAssistant({ type: "aborted", message: "Step interrupted" }))
          }
          // A settled tool fiber failure is one of two things. A defect from a tool
          // implementation becomes a failed tool call the model can read, and the step still
          // settles so the model may recover. A typed infrastructure failure (tool output
          // could not be persisted) also fails the assistant and then fails the drain.
          const settledFailure = settledCauses.find((cause) => !Cause.hasInterrupts(cause))
          const infraError =
            settledFailure === undefined ? undefined : Option.getOrUndefined(Cause.findErrorOption(settledFailure))
          if (settledFailure !== undefined) {
            const failure = infraError ?? Cause.squash(settledFailure)
            const error = toSessionError(failure)
            yield* serialized(publisher.failUnsettledTools(error))
            if (infraError !== undefined) yield* serialized(publisher.failAssistant(error))
          }

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

          if (stream._tag === "Success" && !providerFailed && publisher.stepSettlement() !== undefined) {
            const incomplete = yield* serialized(publisher.failIncompleteToolInputs())
            if (incomplete.some((name) => prepared.resolveToolCall(name).type === "settle")) needsContinuation = true
          }

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
                  contextBreakdown,
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
                message:
                  "The provider returned no answer after text-only recovery. Retry the request or choose another model.",
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
                contextBreakdown,
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
          const promotePendingSteerAfterProviderRecovery =
            recoveryMode === "provider" &&
            postOutputProviderFailure &&
            (yield* SessionPending.has(db, session.id, "steer"))
          if (overflowLimit) return yield* new StepFailedError({ error: overflowLimit })
          if (streamInterrupted) return yield* Effect.interrupt
          if (stream._tag === "Failure" && !recoverableProviderFailure && !promotePendingSteerAfterProviderRecovery)
            return yield* Effect.failCause(stream.cause)
          if ((toolsInterrupted || infraError !== undefined) && settledFailure)
            return yield* Effect.failCause(settledFailure)
          if (toolsInterrupted && settled._tag === "Failure") return yield* Effect.failCause(settled.cause)
          if (
            stepFailure &&
            !recoverableTerminalSilence &&
            !promotePendingSteerAfterExhaustedRecovery &&
            !promotePendingSteerAfterProviderRecovery &&
            !recoverableProviderFailure
          )
            return yield* new StepFailedError({ error: stepFailure })
          return {
            _tag: "Completed",
            needsContinuation:
              needsContinuation ||
              promotePendingSteerAfterExhaustedRecovery ||
              promotePendingSteerAfterProviderRecovery,
            step: currentStep,
            promoted,
            providerRecovery: recoverableProviderFailure
              ? {
                  delay:
                    llmFailure.reason._tag === "ProviderInternal"
                      ? Math.max(0, llmFailure.reason.retryAfterMs ?? 0)
                      : 0,
                }
              : undefined,
            terminalSilence:
              recoverableTerminalSilence ||
              (stepSettlement !== undefined && !publisher.hasAssistantText() && !needsContinuation),
          } as const
        }),
      )
    }, Effect.scoped)

    const runStepUnlocked = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionPending.Delivery | undefined,
      step: number,
      execution: number,
      recoveryMode: RecoveryMode,
      route: Route,
    ) {
      let currentPromotion = promotion
      let currentStep = step
      let assistantMessageID: SessionMessage.ID | undefined
      let promoted = false
      const requestTrackerState: AttemptState = { attempts: 0, route }
      const exhaustedFallback = (failure: SessionRunnerRetry.RetryableFailure) =>
        Effect.gen(function* () {
          if (route.primary === undefined || route.attempting === undefined) return undefined
          const next = SessionModelFallback.next(yield* config.entries(), route.primary, [
            ...route.tried,
            route.attempting,
          ])
          if (next === undefined) return undefined
          return {
            _tag: "RestartWithFallback",
            step: failure.step,
            promoted: 0,
            assistantMessageID: failure.assistantMessageID,
            from: route.attempting,
            next,
            error: failure.error,
          } as const
        })
      const completeRetryFallback = () =>
        requestTrackerState.completeFallback?.() ?? requestTrackerState.current?.complete({
          assistantMessageID,
          connectionIdentityDigest: requestTrackerState.mixedAccountProvenance
            ? null
            : requestTrackerState.accountIdentityDigest,
          invalidation: "retry-fallback",
          continuation: "fallback",
          cost: Money.USD.zero,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }) ?? Effect.void
      const settleOpenStep = (cause: Cause.Cause<unknown>) =>
        Effect.gen(function* () {
          const openAssistantID = assistantMessageID
          if (openAssistantID === undefined) return
          const found = yield* store.message(openAssistantID)
          if (found?.message.type !== "assistant" || found.message.time.completed !== undefined) return
          yield* completeRetryFallback()
          yield* events.publish(SessionEvent.Step.Failed, {
            sessionID,
            assistantMessageID: openAssistantID,
            error: Cause.hasInterrupts(cause)
              ? { type: "aborted", message: "Step interrupted" }
              : toSessionError(Option.getOrElse(Cause.findErrorOption(cause), () => Cause.squash(cause))),
            contextBreakdown: requestTrackerState.contextBreakdown,
          })
        })
      return yield* Effect.gen(function* () {
      while (true) {
        const attempt = yield* Effect.suspend(() =>
          (requestTrackerState.current?.retryResume() ?? Effect.void).pipe(Effect.andThen(attemptStep(
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
          ))),
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
          Effect.retryOrElse(SessionRunnerRetry.schedule(events, sessionID, requestTrackerState.attempts).pipe(
            Schedule.tap(() => requestTrackerState.current?.retryWait() ?? Effect.void),
          ), (error) => {
            if (!(error instanceof SessionRunnerRetry.RetryableFailure)) return Effect.fail(error)
            return exhaustedFallback(error).pipe(
              Effect.flatMap((rerouted) => (rerouted ? Effect.succeed(rerouted) : Effect.fail(error.cause))),
            )
          }),
        )
        if (attempt._tag === "Completed")
          return {
            needsContinuation: attempt.needsContinuation,
            step: attempt.step,
            promoted,
            providerRecovery: attempt.providerRecovery,
            terminalSilence: attempt.terminalSilence,
          }
        if (attempt._tag === "RestartWithoutContinuation") {
          requestTrackerState.continuationFallback = true
          assistantMessageID = attempt.assistantMessageID ?? assistantMessageID
        }
        if (attempt._tag === "RestartAfterOverflow")
          assistantMessageID = attempt.assistantMessageID ?? assistantMessageID
        if (attempt._tag === "RestartWithFallback") {
          assistantMessageID = attempt.assistantMessageID
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* requestTrackerState.current?.complete({
                assistantMessageID: attempt.assistantMessageID,
                connectionIdentityDigest: null,
                invalidation: "retry-fallback",
                continuation: "fallback",
                cost: Money.USD.zero,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              }) ?? Effect.void
              const agent = requestTrackerState.agent
              const time = yield* Clock.currentTimeMillis
              yield* events.publish(
                SessionEvent.Step.Rerouted,
                {
                  sessionID,
                  assistantMessageID: attempt.assistantMessageID,
                  model: attempt.next,
                  error: attempt.error,
                },
                {
                  commit: () =>
                    agent === undefined
                      ? Effect.void
                      : ModelIncident.recordFallback(db, {
                          sessionID,
                          agent,
                          from: attempt.from,
                          to: attempt.next,
                          category: attempt.error.type,
                          time,
                        }),
                },
              )
              route.tried.push(attempt.from)
              route.model = attempt.next
              requestTrackerState.current = undefined
              requestTrackerState.completeFallback = undefined
              requestTrackerState.accountIdentityDigest = undefined
              requestTrackerState.mixedAccountProvenance = undefined
              requestTrackerState.attempts = 0
            }),
          )
        }
        yield* Effect.yieldNow
        currentPromotion = undefined
        currentStep = attempt.step
      }
      }).pipe(
        // Every started Step owes exactly one terminal event. Attempts settle the Steps they
        // can; this settles a carried Step that a failure, defect, or interruption left open,
        // including interruption during retry backoff and fallback resolution or preparation.
        Effect.onError((cause) => settleOpenStep(cause)),
      )
    })

    const runStep = (...args: Parameters<typeof runStepUnlocked>) =>
      stepBoundary.withStep(args[0], runStepUnlocked(...args))

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
      const route: Route = { tried: [] }
      while (shouldRun) {
        let needsContinuation = true
        let step = 1
        let recoveryMode: RecoveryMode = "normal"
        // Repeat steps while continuation is needed. A step needs continuation only
        // when it recorded local tool calls whose results the model has not yet seen;
        // a provider error suppresses it. Pending steers also continue the loop so
        // interjections are answered before the session goes idle.
        while (needsContinuation) {
          const result = yield* runStep(input.sessionID, promotion, step, execution, recoveryMode, route)
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
          if (result.providerRecovery) {
            if (result.providerRecovery.delay > 0) yield* Effect.sleep(result.providerRecovery.delay)
            if (yield* SessionPending.has(db, input.sessionID, "steer")) {
              needsContinuation = true
              promotion = "steer"
              continue
            }
            recoveryMode = "provider"
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
    EventRuntime.node,
    SessionStepBoundary.node,
    llmClient,
    SessionContext.node,
    SessionLiveState.node,
    SessionModelRequest.node,
    DotsRuntimeNode.requestToolsNode,
    SessionProviderRequest.node,
    SessionContinuation.node,
    SessionProviderState.node,
    SessionCompactionJob.node,
    SessionStore.node,
    SessionCompaction.node,
    SessionTitle.node,
    SessionPrediction.node,
    Config.node,
    Snapshot.node,
    Database.node,
    Skill.node,
    FSUtil.node,
    Permission.node,
    ProjectArtifactAccounting.node,
    ProjectArtifactSource.node,
  ],
})

const isInvalidPreviousResponse = (message: string) =>
  /previous[_ ]response(?:_id)?/i.test(message) && /invalid|expired|not found|unknown/i.test(message)

// Bare `invalid_prompt` carries no `previous_response` text, but on a stored
// continuation it means the same thing: the provider-side prefix the request
// chained onto is unusable. Kept narrow on purpose — a generic
// "Invalid request" must NOT fall back (covered by
// "does not treat a generic invalid request as stale continuation state").
const isBareInvalidPrompt = (message: string) => /invalid_prompt/i.test(message)
