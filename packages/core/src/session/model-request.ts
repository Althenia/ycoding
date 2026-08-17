export * as SessionModelRequest from "./model-request"

import {
  LLM,
  LLMRequest,
  Message,
  SystemPart,
  mergeGenerationOptions,
  mergeHttpOptions,
  mergeProviderOptions,
} from "@ycoding-ai/ai"
import { OpenAIOptions } from "@ycoding-ai/ai/protocols/utils/openai-options"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { SessionError } from "@ycoding-ai/schema/session-error"
import { Context, Effect, Layer } from "effect"
import type { AgentV2 } from "../agent"
import { Config } from "../config"
import { ConfigEfficiency } from "../config/efficiency"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { PluginHooks } from "../plugin/hooks"
import { OpenAICodex } from "../plugin/provider/openai-codex"
import { ToolRegistry } from "../tool/registry"
import { SessionContext } from "./context"
import { SessionModelHeaders } from "./model-headers"
import { SessionRunnerCache } from "./runner/cache"
import { SessionCacheRuntime } from "./runner/cache-runtime"
import { SessionRunnerModel } from "./runner/model"
import { MAX_STEPS_PROMPT } from "./runner/max-steps"
import PROMPT_DEFAULT from "./runner/prompt/base.txt"
import { isProviderImage, toLLMMessages } from "./runner/to-llm-message"
import { ImageAnalyzer } from "./runner/image-analyzer"
import { ConfigImageAnalyzer } from "../config/image-analyzer"
import { Catalog } from "../catalog"
import { SessionContinuation } from "./runner/continuation"
import { Hash } from "../util/hash"
import { SessionMessage } from "./message"
import { SessionProviderState } from "./provider-state"
import { AttachmentStore } from "../attachment-store"

const fingerprintValue = (value: unknown, ancestors: ReadonlySet<object> = new Set()): unknown => {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "function" || typeof value === "symbol") return undefined
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64")
  if (typeof value !== "object") return String(value)
  if (ancestors.has(value)) throw new TypeError("Continuation fingerprint contains a cycle")
  const nested = new Set(ancestors).add(value)
  if (Array.isArray(value)) return value.map((item) => fingerprintValue(item, nested))
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, fingerprintValue(item, nested)] as const)
      .filter((entry) => entry[1] !== undefined),
  )
}

type ToolCallResolution =
  | { readonly type: "reject"; readonly error: SessionError.Error }
  | { readonly type: "settle"; readonly settle: ToolRegistry.Materialization["settle"] }

interface Prepared {
  readonly request: LLMRequest
  readonly inputIDs: ReadonlyArray<SessionMessage.ID>
  readonly cache: {
    readonly promptCacheKey: string
    readonly systemDigest: string
    readonly toolDigest: string
  }
  readonly continuation: {
    readonly fingerprint: SessionContinuation.Fingerprint
    readonly eligible: boolean
    readonly used: boolean
    readonly representedThroughMessageID?: SessionMessage.ID
    readonly representedMessageCount: number
  }
  readonly resolveToolCall: (name: string) => ToolCallResolution
}

interface PrepareInput {
  readonly context: SessionContext.Loaded
  readonly step: number
  readonly model?: SessionRunnerModel.Resolved
  readonly messages?: ReadonlyArray<Message>
  readonly execution?: number
  readonly disableContinuation?: boolean
  readonly terminalResponseRecovery?: boolean
}

export const baseSystem = (context: Pick<SessionContext.Loaded, "agent" | "initial">) =>
  [context.agent.info.system ? context.agent.info.system : PROMPT_DEFAULT, context.initial]
    .filter((part) => part.length > 0)
    .map(SystemPart.make)

export function toolPermissions(agent: Pick<AgentV2.Info, "mode" | "permissions">, ceiling: PermissionV2.Ruleset) {
  return PermissionV2.merge(
    agent.permissions,
    ceiling,
    ...(agent.mode === "subagent"
      ? [
          [
            { action: "subagent", resource: "*", effect: "deny" as const },
            { action: "subagent_control", resource: "*", effect: "deny" as const },
          ],
        ]
      : []),
  )
}

/**
 * Builds an outbound model request and captures the tool-call capability that
 * must remain paired with it. It does not execute the request or mutate
 * Session state.
 */
export interface Interface {
  /** Builds one outbound model request and its matching tool-call capability. */
  readonly prepare: (input: PrepareInput) => Effect.Effect<Prepared>
}

/** Location-scoped outbound model-request preparation. */
export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionModelRequest") {}

export const layer = (options?: SessionModelHeaders.Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const registry = yield* ToolRegistry.Service
      const config = yield* Config.Service
      const cacheRuntime = yield* SessionCacheRuntime.Service
      const continuation = yield* SessionContinuation.Service
      const providerState = yield* SessionProviderState.Service
      const db = (yield* Database.Service).db
      const attachments = yield* AttachmentStore.Service
      const catalog = yield* Catalog.Service
      const imageAnalyzer = yield* ImageAnalyzer.Service.pipe(Effect.orElseSucceed(() => undefined as unknown as ImageAnalyzer.Interface))

      const prepare = Effect.fn("SessionModelRequest.prepare")(function* (input: PrepareInput) {
        const session = input.context.session
        const agent = input.context.agent
        const resolved = input.model ?? input.context.model
        const model = resolved.model
        const providerMetadataKey = model.route.providerMetadataKey ?? model.provider
        const efficiencyInfo = Config.latest(yield* config.entries(), "efficiency")
        const responsesState = ConfigEfficiency.openAIResponsesState(efficiencyInfo)
        const stepLimitReached = agent.info.steps !== undefined && input.step >= agent.info.steps
        const terminalResponseRecovery = input.terminalResponseRecovery === true
        const toolsDisabled = terminalResponseRecovery || stepLimitReached
        const permissions = toolPermissions(agent.info, session.permissionCeiling ?? [])
        const executableTools = toolsDisabled ? undefined : yield* registry.materialize(permissions)
        const system = baseSystem(input.context)
        const materialized = yield* providerState.materialize({
          sessionID: session.id,
          provider: model.provider,
          modelID: resolved.ref.id,
          stateless: responsesState === "stateless",
        })
        const attachmentFiles = input.context.messages.flatMap((message) =>
          message.type === "user" ? (message.files ?? []) : [],
        )
        const verifiedAttachments = yield* Effect.forEach(
          [...new Map(attachmentFiles.map((file) => [file.content.digest, file])).values()],
          (file) =>
            attachments.read(file.content).pipe(
              Effect.orDie,
              Effect.map((bytes) => ({ file, bytes })),
            ),
          { concurrency: 4 },
        )
        const images = new Map(
          verifiedAttachments.flatMap(({ file, bytes }) =>
            isProviderImage(file) ? [[file.content.digest, bytes] as const] : [],
          ),
        )
        let fallbackDescriptions: ReadonlyMap<string, string> | undefined
        if (images.size > 0) {
          const runningInfo = yield* catalog.model.get(resolved.ref.providerID, resolved.ref.id).pipe(
            Effect.orElseSucceed(() => undefined as unknown as import("../model").ModelV2.Info | undefined),
          )
          const multimodal = runningInfo ? ImageAnalyzer.isMultimodal(runningInfo.capabilities) : false
          if (!multimodal) {
            const entriesImg = yield* config.entries()
            const analyzerInfo = Config.latest(entriesImg, "image_analyzer")
            const analyzerEnabled = analyzerInfo ? ConfigImageAnalyzer.isEnabled(analyzerInfo) : false
            if (analyzerEnabled && imageAnalyzer) {
              const imageInputs = verifiedAttachments
                .filter(({ file }) => isProviderImage(file))
                .map(({ file, bytes }) => ({ file, bytes }))
              const analyzed = yield* imageAnalyzer.analyze(imageInputs).pipe(
                Effect.orElseSucceed(() =>
                  new Map(
                    imageInputs.map(({ file }) => [
                      file.content.digest,
                      ImageAnalyzer.failureBlock(file, "vision analysis error"),
                    ]),
                  ),
                ),
              )
              fallbackDescriptions = analyzed
            } else {
              const reason = analyzerInfo === undefined ? "image analyzer not configured" : "vision analyzer unavailable"
              fallbackDescriptions = new Map(
                [...images.keys()].map((digest) => {
                  const file = verifiedAttachments.find((v) => v.file.content.digest === digest)?.file
                  return [digest, ImageAnalyzer.failureBlock(file!, reason)] as const
                }),
              )
            }
          }
        }
        const attachmentMaterialization = {
          images,
          absolutePath: (file: (typeof attachmentFiles)[number]) => attachments.absolutePath(file.content),
          ...(fallbackDescriptions ? { fallbackDescriptions } : {}),
        }
        const loweredHistory = input.context.messages.map((message) =>
          toLLMMessages([message], resolved.ref, providerMetadataKey, materialized, attachmentMaterialization),
        )
        const history = loweredHistory.flat()
        const messages = [
          ...(stepLimitReached && !terminalResponseRecovery
            ? [...history, Message.assistant(MAX_STEPS_PROMPT)]
            : history),
          ...(input.messages ?? []),
          input.context.liveState.rendered,
        ]
        const toolDefinitions = executableTools?.definitions ?? []
        const toolsByName = new Map(toolDefinitions.map((tool) => [tool.name, tool]))
        // Hooks may reshape available definitions but cannot advertise tools omitted by permissions or the Step limit.
        const contextEvent = yield* hooks.trigger("session", "context", {
          sessionID: session.id,
          agent: agent.id,
          model: resolved.ref,
          system,
          messages,
          tools: Object.fromEntries(
            toolDefinitions.map((tool) => [
              tool.name,
              { description: tool.description, input: { ...tool.inputSchema } },
            ]),
          ),
        })
        const hookedTools = Object.entries(contextEvent.tools).flatMap(([name, tool]) => {
          const registered = toolsByName.get(name)
          return registered
            ? [Object.assign({}, registered, { description: tool.description, inputSchema: tool.input })]
            : []
        })
        const namespaceInput = {
          projectID: session.projectID,
          directory: session.location.directory,
          workspaceID: session.location.workspaceID,
          providerID: resolved.ref.providerID,
          modelID: resolved.ref.id,
          variant: resolved.ref.variant ?? "default",
          policyRevision: CACHE_POLICY_REVISION,
          permissions,
          system: contextEvent.system,
          tools: hookedTools,
        }
        const now = Date.now()
        const baselineKey = SessionRunnerCache.promptCacheNamespace(
          { ...namespaceInput, routeID: resolved.model.route.id },
          now,
        )
        const systemDigest = SessionRunnerCache.systemDigest(contextEvent.system)
        const toolDigest = SessionRunnerCache.toolDigest(hookedTools)
        const efficiency = SessionRunnerCache.efficiencySettings(efficiencyInfo)
        const ttl = yield* cacheRuntime.policy({
          sessionID: session.id,
          namespace: SessionRunnerCache.promptCacheNamespace(namespaceInput),
          modelID: model.id,
          configured: efficiency.anthropicTtl,
        })
        const generation = yield* cacheRuntime.generation({
          sessionID: session.id,
          model: resolved.ref,
          routeID: resolved.model.route.id,
          apiModelID: model.id,
          systemDigest,
          toolDigest,
          baselineKey,
          now,
        })
        const cache = SessionRunnerCache.providerOptions({
          ...namespaceInput,
          apiModelID: model.id,
          sessionID: session.id,
          routeID: resolved.model.route.id,
          anthropicTtlSeconds: ttl.ttlSeconds,
          openaiMode: efficiency.openaiMode,
          openaiExtendedRetention: efficiency.openaiExtendedRetention,
          generation,
        }, now)
        const directOpenAIResponses =
          model.provider === "openai" && SessionContinuation.isResponsesRoute(model.route.id)
        const baseRequest = LLM.request({
          model,
          http: {
            headers: SessionModelHeaders.make(session, options),
          },
          providerOptions: mergeProviderOptions(
            cache.providerOptions,
            directOpenAIResponses ? { openai: { store: responsesState === "stored" } } : undefined,
          ),
          cache: cache.cache,
          system: contextEvent.system,
          messages: contextEvent.messages,
          tools: hookedTools,
          toolChoice: toolsDisabled ? "none" : undefined,
        })
        const effectiveRequest = LLMRequest.update(baseRequest, {
          generation: mergeGenerationOptions(
            model.route.defaults.generation,
            model.defaults?.generation,
            baseRequest.generation,
          ),
          providerOptions: mergeProviderOptions(
            model.route.defaults.providerOptions,
            model.defaults?.providerOptions,
            baseRequest.providerOptions,
          ),
          http: mergeHttpOptions(model.route.defaults.http, model.defaults?.http, baseRequest.http),
        })
        const effectiveOpenAI = effectiveRequest.providerOptions?.openai ?? {}
        const {
          previousResponseId: _previousResponseID,
          continuationInputStart: _continuationInputStart,
          promptCacheKey: _promptCacheKey,
          ...semanticOpenAI
        } = effectiveOpenAI
        const continuationMode = efficiencyInfo?.openai_responses_continuation ?? "auto"
        const authority = directOpenAIResponses
          ? yield* SessionContinuation.captureAuthority(db, session.id).pipe(Effect.orDie)
          : { generation: 0, contextRevision: 0 }
        const volatileStart = contextEvent.messages.findLastIndex((message) => message.volatile !== true) + 1
        const stableMessages = contextEvent.messages.slice(0, volatileStart)
        const volatileMessages = contextEvent.messages.slice(volatileStart)
        const representedMessageCount = input.context.messages.length
        const representedThroughMessageID = input.context.messages.at(-1)?.id
        const continuationFingerprint: SessionContinuation.Fingerprint = {
          sessionID: session.id,
          contextRevision: authority.contextRevision,
          continuationGeneration: authority.generation,
          provider: model.provider,
          routeID: model.route.id,
          modelID: resolved.ref.id,
          variant: resolved.ref.variant,
          connectionIdentityDigest: resolved.connectionIdentityDigest,
          representedThroughMessageID,
          representedMessageCount,
          promptCacheKey: cache.promptCacheKey,
          instructionsDigest: Hash.sha256(
            SessionRunnerCache.canonicalJson(
              fingerprintValue({
                system: baseRequest.system,
                updates: stableMessages.filter((message) => message.role === "system"),
              }),
            ),
          ),
          toolsDigest: cache.toolDigest,
          optionsDigest: Hash.sha256(
            SessionRunnerCache.canonicalJson(
              fingerprintValue({
                generation: effectiveRequest.generation,
                openai: semanticOpenAI,
                toolChoice: effectiveRequest.toolChoice,
                responseFormat: effectiveRequest.responseFormat,
                cache: effectiveRequest.cache,
                http: { body: effectiveRequest.http?.body, query: effectiveRequest.http?.query },
              }),
            ),
          ),
          volatileContextDigest: Hash.sha256(SessionRunnerCache.canonicalJson(fingerprintValue(volatileMessages))),
        }
        const eligible =
          directOpenAIResponses &&
          continuationMode !== "off" &&
          responsesState === "stored" &&
          OpenAIOptions.store(effectiveRequest) === true &&
          !terminalResponseRecovery
        const state =
          !eligible || input.disableContinuation === true
            ? undefined
            : yield* continuation.select({
                ...continuationFingerprint,
                mode: continuationMode,
                store: OpenAIOptions.store(effectiveRequest) === true,
                completeMessageIDs: input.context.messages.map((message) => message.id),
              })
        const continuationInputStart = state
          ? loweredHistory
              .slice(0, state.representedMessageCount)
              .reduce((count, messages) => count + messages.length, 0) + 1
          : 0
        const continuedMessages = state ? stableMessages : contextEvent.messages
        const transportRequest =
          model.route.id !== OpenAICodex.routeID
            ? baseRequest
            : LLMRequest.update(baseRequest, {
                providerOptions: mergeProviderOptions(baseRequest.providerOptions, {
                  openai: {
                    responsesWebSocket: {
                      sessionKey: SessionRunnerCache.providerSessionNamespace({
                        projectID: session.projectID,
                        sessionID: session.id,
                        providerID: resolved.ref.providerID,
                      }),
                      fingerprint: SessionContinuation.transportFingerprint(continuationFingerprint),
                      messageBoundary: baseRequest.messages.length - 1,
                      fullReplay: input.disableContinuation === true,
                    },
                  },
                }),
              })
        const request =
          state === undefined
            ? transportRequest
            : LLMRequest.update(transportRequest, {
                messages: continuedMessages,
                providerOptions: mergeProviderOptions(baseRequest.providerOptions, {
                  openai: {
                    previousResponseId: state.responseID,
                    continuationInputStart,
                  },
                }),
              })
        const userMessageIDs = new Set(
          input.context.messages.flatMap((message) => (message.type === "user" ? [message.id] : [])),
        )
        // LLM.request preserves the hook-final messages and their order. Read receipt membership
        // from that input rather than re-reading the constructed request.
        const inputIDs = [
          ...new Set(
            request.messages
              .slice(continuationInputStart)
              .flatMap((message) =>
                message.role === "user" && message.id && userMessageIDs.has(SessionMessage.ID.make(message.id))
                  ? [SessionMessage.ID.make(message.id)]
                  : [],
              ),
          ),
        ]
        const resolveToolCall = (name: string): ToolCallResolution => {
          if (!executableTools)
            return {
              type: "reject",
              error: {
                type: "tool.execution",
                message: terminalResponseRecovery
                  ? "Tools are disabled for terminal response recovery"
                  : "Tools are disabled after the maximum agent steps",
              },
            }
          if (toolsByName.has(name) && !Object.hasOwn(contextEvent.tools, name))
            return {
              type: "reject",
              error: { type: "tool.execution", message: `Tool is not available for this request: ${name}` },
            }
          return { type: "settle", settle: executableTools.settle }
        }
        return {
          request,
          inputIDs,
          continuation: {
            fingerprint: continuationFingerprint,
            eligible: terminalResponseRecovery ? false : eligible,
            used: state !== undefined,
            representedThroughMessageID,
            representedMessageCount,
          },
          cache: {
            promptCacheKey: cache.promptCacheKey,
            systemDigest: cache.systemDigest,
            toolDigest: cache.toolDigest,
          },
          resolveToolCall,
        }
      })

      return Service.of({ prepare })
    }),
  )

export function configured(options?: SessionModelHeaders.Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [
      PluginHooks.node,
      ToolRegistry.node,
      Config.node,
      Database.node,
      SessionCacheRuntime.node,
      SessionContinuation.node,
      SessionProviderState.node,
      AttachmentStore.node,
      Catalog.node,
      ImageAnalyzer.node,
    ],
  })
}

export const node = configured()
