export * as SessionModelRequest from "./model-request"

import { LLM, Message, SystemPart, type LLMRequest } from "@ycoding-ai/ai"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { SessionError } from "@ycoding-ai/schema/session-error"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { PluginHooks } from "../plugin/hooks"
import { ToolRegistry } from "../tool/registry"
import { SessionContext } from "./context"
import { SessionModelHeaders } from "./model-headers"
import { SessionRunnerCache } from "./runner/cache"
import { SessionRunnerModel } from "./runner/model"
import { MAX_STEPS_PROMPT } from "./runner/max-steps"
import PROMPT_DEFAULT from "./runner/prompt/base.txt"
import { toLLMMessages } from "./runner/to-llm-message"

type ToolCallResolution =
  | { readonly type: "reject"; readonly error: SessionError.Error }
  | { readonly type: "settle"; readonly settle: ToolRegistry.Materialization["settle"] }

interface Prepared {
  readonly request: LLMRequest
  readonly resolveToolCall: (name: string) => ToolCallResolution
}

interface PrepareInput {
  readonly context: SessionContext.Loaded
  readonly step: number
  readonly model?: SessionRunnerModel.Resolved
  readonly messages?: ReadonlyArray<Message>
}

export const baseSystem = (context: Pick<SessionContext.Loaded, "agent" | "initial">) =>
  [context.agent.info.system ? context.agent.info.system : PROMPT_DEFAULT, context.initial]
    .filter((part) => part.length > 0)
    .map(SystemPart.make)

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

      const prepare = Effect.fn("SessionModelRequest.prepare")(function* (input: PrepareInput) {
        const session = input.context.session
        const agent = input.context.agent
        const resolved = input.model ?? input.context.model
        const model = resolved.model
        const providerMetadataKey = model.route.providerMetadataKey ?? model.provider
        const stepLimitReached = agent.info.steps !== undefined && input.step >= agent.info.steps
        const permissions = PermissionV2.merge(agent.info.permissions, session.permissionCeiling ?? [])
        const executableTools = stepLimitReached ? undefined : yield* registry.materialize(permissions)
        const system = baseSystem(input.context)
        const history = toLLMMessages(input.context.messages, resolved.ref, providerMetadataKey)
        const messages = [
          ...(stepLimitReached ? [...history, Message.assistant(MAX_STEPS_PROMPT)] : history),
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
        const { providerOptions: requestProviderOptions } = SessionRunnerCache.providerOptions({
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
          sessionID: session.id,
          routeID: resolved.model.route.id,
        })
        const request = LLM.request({
          model,
          http: {
            headers: SessionModelHeaders.make(session, options),
          },
          providerOptions: requestProviderOptions,
          system: contextEvent.system,
          messages: contextEvent.messages,
          tools: hookedTools,
          toolChoice: stepLimitReached ? "none" : undefined,
        })
        const resolveToolCall = (name: string): ToolCallResolution => {
          if (!executableTools)
            return {
              type: "reject",
              error: { type: "tool.execution", message: "Tools are disabled after the maximum agent steps" },
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
          resolveToolCall,
        }
      })

      return Service.of({ prepare })
    }),
  )

export function configured(options?: SessionModelHeaders.Options) {
  return makeLocationNode({ service: Service, layer: layer(options), deps: [PluginHooks.node, ToolRegistry.node] })
}

export const node = configured()
