export * as StandaloneCompaction from "./standalone-compaction"

import { LLMClient } from "@ycoding-ai/ai"
import { Effect, Layer } from "effect"
import { Agent } from "../agent"
import { ConfigCompaction } from "../config/compaction"
import { StandaloneConfig } from "../config/standalone"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { EventRuntime } from "../event"
import { StandaloneAgent } from "../plugin/standalone-agent"
import { SessionCompaction } from "./compaction"
import { SessionLiveState } from "./live-state"
import { SessionProviderRequest } from "./provider-request"
import { StandaloneHelperPolicy } from "./standalone-helper-policy"
import { SessionStore } from "./store"

export const node = makeLocationNode({
  service: SessionCompaction.Service,
  layer: Layer.effect(SessionCompaction.Service, Effect.gen(function* () {
    const llm = yield* LLMClient.Service
    const config = yield* StandaloneConfig.Service
    const agents = yield* Agent.Service
    const agentState = yield* StandaloneAgent.Service
    const helpers = yield* StandaloneHelperPolicy.Service
    const requests = yield* SessionProviderRequest.Service
    const store = yield* SessionStore.Service
    const liveState = yield* SessionLiveState.Service
    const events = yield* EventRuntime.Service
    const { db } = yield* Database.Service
    return SessionCompaction.Service.of({ manifest: (job, prepareOwner) => Effect.gen(function* () {
      const snapshot = yield* config.snapshot()
      yield* agentState.refresh()
      return yield* SessionCompaction.make({
        db, llm, agents, helpers, requests, store, liveState, events,
        entries: () => config.snapshot().pipe(Effect.map((current) => current.entries)),
        config: ConfigCompaction.resolve(snapshot.entries.flatMap((entry) => entry.info.compaction ? [entry.info.compaction] : [])),
      }).manifest(job, prepareOwner)
    }).pipe(Effect.mapError((error) => error instanceof SessionCompaction.ManifestError ? error : new SessionCompaction.ManifestError({ code: "migration_failed" }))) })
  })),
  deps: [llmClient, StandaloneConfig.node, Agent.node, StandaloneAgent.node, StandaloneHelperPolicy.node, SessionProviderRequest.node, SessionStore.node, SessionLiveState.standaloneNode, EventRuntime.node, Database.node],
})
