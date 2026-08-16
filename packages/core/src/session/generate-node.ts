export * as SessionGenerateNode from "./generate-node"

import { LLM, LLMClient, Message, SystemPart } from "@ycoding-ai/ai"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { PermissionV2 } from "../permission"
import { PluginHooks } from "../plugin/hooks"
import { SessionContext } from "./context"
import { SessionGenerate } from "./generate"
import { SessionHistory } from "./history"
import { SessionModelHeaders } from "./model-headers"
import { SessionRunnerCache } from "./runner/cache"
import { SessionRunnerModel } from "./runner/model"
import PROMPT_DEFAULT from "./runner/prompt/base.txt"
import { toLLMMessages } from "./runner/to-llm-message"

export const layer = (options?: SessionModelHeaders.Options) =>
  Layer.effect(
    SessionGenerate.Service,
    Effect.gen(function* () {
      const context = yield* SessionContext.Service
      const database = yield* Database.Service
      const hooks = yield* PluginHooks.Service
      const llm = yield* LLMClient.Service
      const models = yield* SessionRunnerModel.Service

      return SessionGenerate.Service.of({
        generate: Effect.fn("SessionGenerate.generate")(function* (input) {
          const selection = yield* context.select(input.sessionID)
          const selected = yield* models.resolve(selection.session)
          const history = yield* SessionHistory.preview(database.db, selection.session.id, selection.instructions)
          const permissions = PermissionV2.merge(
            selection.agent.info.permissions,
            selection.session.permissionCeiling ?? [],
          )
          const system = [selection.agent.info.system ? selection.agent.info.system : PROMPT_DEFAULT, history.initial]
            .filter((part) => part.length > 0)
            .map(SystemPart.make)
          const providerMetadataKey = selected.model.route.providerMetadataKey ?? selected.model.provider
          const contextEvent = yield* hooks.trigger("session", "context", {
            sessionID: selection.session.id,
            agent: selection.agent.id,
            model: selected.ref,
            system,
            messages: [
              ...toLLMMessages(history.messages, selected.ref, providerMetadataKey),
              ...(history.instructionUpdate ? [Message.system(history.instructionUpdate)] : []),
              Message.user(input.prompt),
            ],
            tools: {},
          })
          const { providerOptions } = SessionRunnerCache.providerOptions({
            projectID: selection.session.projectID,
            directory: selection.session.location.directory,
            workspaceID: selection.session.location.workspaceID,
            providerID: selected.ref.providerID,
            modelID: selected.ref.id,
            variant: selected.ref.variant ?? "default",
            policyRevision: CACHE_POLICY_REVISION,
            permissions,
            system: contextEvent.system,
            tools: [],
            sessionID: selection.session.id,
            routeID: selected.model.route.id,
          })
          const response = yield* llm.generate(
            LLM.request({
              model: selected.model,
              http: { headers: SessionModelHeaders.make(selection.session, options) },
              providerOptions,
              system: contextEvent.system,
              messages: contextEvent.messages,
              tools: [],
              toolChoice: "none",
            }),
          )
          return response.text
        }),
      })
    }),
  )

export function configured(options?: SessionModelHeaders.Options) {
  return makeLocationNode({
    service: SessionGenerate.Service,
    layer: layer(options),
    deps: [SessionContext.node, Database.node, PluginHooks.node, SessionRunnerModel.node, llmClient],
  })
}

export const node = configured()
