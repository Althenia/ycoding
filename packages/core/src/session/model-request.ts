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
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { PluginHooks } from "../plugin/hooks"
import { ToolRegistry } from "../tool/registry"
import { SessionContext } from "./context"
import { SessionModelHeaders } from "./model-headers"
import { SessionRunnerCache } from "./runner/cache"
import { SessionCacheRuntime } from "./runner/cache-runtime"
import { SessionRunnerModel } from "./runner/model"
import { MAX_STEPS_PROMPT } from "./runner/max-steps"
import PROMPT_DEFAULT from "./runner/prompt/base.txt"
import { toLLMMessages } from "./runner/to-llm-message"
import { SessionContinuation } from "./runner/continuation"
import { Hash } from "../util/hash"
import { SessionMessage } from "./message"

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

export function toolPermissions(
  agent: Pick<AgentV2.Info, "mode" | "permissions">,
  ceiling: PermissionV2.Ruleset,
) {
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

      const prepare = Effect.fn("SessionModelRequest.prepare")(function* (input: PrepareInput) {
        const session = input.context.session
        const agent = input.context.agent
        const resolved = input.model ?? input.context.model
        const model = resolved.model
        const providerMetadataKey = model.route.providerMetadataKey ?? model.provider
        const stepLimitReached = agent.info.steps !== undefined && input.step >= agent.info.steps
        const terminalResponseRecovery = input.terminalResponseRecovery === true
        const toolsDisabled = terminalResponseRecovery || stepLimitReached
        const permissions = toolPermissions(agent.info, session.permissionCeiling ?? [])
        const executableTools = toolsDisabled ? undefined : yield* registry.materialize(permissions)
        const system = baseSystem(input.context)
        const history = toLLMMessages(input.context.messages, resolved.ref, providerMetadataKey)
        const messages = [
          ...(stepLimitReached && !terminalResponseRecovery ? [...history, Message.assistant(MAX_STEPS_PROMPT)] : history),
          ...(input.messages ?? []),
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
        const efficiencyInfo = Config.latest(yield* config.entries(), "efficiency")
        const efficiency = SessionRunnerCache.efficiencySettings(efficiencyInfo)
        const ttl = yield* cacheRuntime.policy({
          namespace: SessionRunnerCache.promptCacheNamespace(namespaceInput),
          modelID: model.id,
          configured: efficiency.anthropicTtl,
        })
        const cache = SessionRunnerCache.providerOptions({
          ...namespaceInput,
          apiModelID: model.id,
          sessionID: session.id,
          routeID: resolved.model.route.id,
          anthropicTtlSeconds: ttl.ttlSeconds,
          openaiMode: efficiency.openaiMode,
          openaiExtendedRetention: efficiency.openaiExtendedRetention,
        })
        const baseRequest = LLM.request({
          model,
          http: {
            headers: SessionModelHeaders.make(session, options),
          },
          providerOptions: cache.providerOptions,
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
        const continuationFingerprint: SessionContinuation.Fingerprint = {
          sessionID: session.id,
          execution: input.execution ?? 0,
          routeID: model.route.id,
          model: resolved.ref,
          promptCacheKey: cache.promptCacheKey,
          systemDigest: Hash.sha256(
            SessionRunnerCache.canonicalJson(
              fingerprintValue({
                system: baseRequest.system,
                updates: baseRequest.messages.filter((message) => message.role === "system"),
              }),
            ),
          ),
          toolDigest: cache.toolDigest,
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
        }
        const eligible =
          input.execution !== undefined &&
          continuationMode !== "off" &&
          OpenAIOptions.store(effectiveRequest) === true &&
          SessionContinuation.isResponsesRoute(model.route.id)
        if (input.disableContinuation === true || terminalResponseRecovery) yield* continuation.clear(session.id)
        let state =
          input.execution === undefined || input.disableContinuation === true || terminalResponseRecovery
            ? undefined
            : yield* continuation.select({
                ...continuationFingerprint,
                mode: continuationMode,
                store: OpenAIOptions.store(effectiveRequest) === true,
              })
        if (state && state.representedMessages >= baseRequest.messages.length) {
          yield* continuation.clear(session.id)
          state = undefined
        }
        const request =
          state === undefined
            ? baseRequest
            : LLMRequest.update(baseRequest, {
                providerOptions: mergeProviderOptions(baseRequest.providerOptions, {
                  openai: {
                    previousResponseId: state.responseID,
                    continuationInputStart: state.representedMessages,
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
            contextEvent.messages
              .slice(state?.representedMessages ?? 0)
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
    deps: [PluginHooks.node, ToolRegistry.node, Config.node, SessionCacheRuntime.node, SessionContinuation.node],
  })
}

export const node = configured()
