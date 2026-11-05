export * as SessionContext from "./context"

import { Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import type { Model } from "@ycoding-ai/schema/model"
import { Agent } from "../agent"
import { Catalog } from "../catalog"
import { Config } from "../config"
import { StandaloneConfig } from "../config/standalone"
import { ConfigMemory } from "../config/memory"
import { Database } from "../database/database"
import { CoordinationService } from "../coordination/index"
import { CoordinationInstructions } from "../coordination/instructions"
import { CoordinationAccess } from "./coordination-access"
import { CoordinationModel } from "./coordination-model"
import { makeLocationNode } from "../effect/app-node"
import { InstructionDiscovery } from "../instruction-discovery"
import { Instructions } from "../instructions/index"
import { InstructionBuiltIns } from "../instructions/builtins"
import { ProjectArtifactInstructions } from "../project-artifact/instructions"
import { Location } from "../location"
import { McpInstructions } from "../mcp/instructions"
import { ModelGuidanceInstructions } from "../model-incident/instructions"
import { Permission } from "../permission"
import { MemoryInstructions } from "../memory/instructions"
import { PluginSupervisor } from "../plugin/supervisor"
import { StandaloneAgent } from "../plugin/standalone-agent"
import { ReferenceInstructions } from "../reference/instructions"
import { SkillInstructions } from "../skill/instructions"
import { ToolRegistry } from "../tool/registry"
import { StandaloneTools } from "../tool/standalone-tools"
import { AgentNotFoundError, ScopeUnavailableError } from "./error"
import { SessionHistory } from "./history"
import { InstructionEntry } from "./instruction-entry"
import { SessionLiveState } from "./live-state"
import { SessionMessage } from "./message"
import { SessionRunnerModel } from "./runner/model"
import { StandaloneModel } from "./runner/standalone-model"
import { SessionSchema } from "./schema"
import { SessionContextStateTable } from "./sql"
import { SessionStore } from "./store"

export interface Selection {
  readonly session: SessionSchema.Info
  readonly agent: Agent.Selection & { readonly info: Agent.Info }
  readonly instructions: Instructions.Instructions
  readonly modelOverride?: Model.Ref
  readonly configGeneration?: number
}

export interface Loaded {
  readonly session: SessionSchema.Info
  readonly agent: Agent.Selection & { readonly info: Agent.Info }
  readonly model: SessionRunnerModel.Resolved
  readonly contextRevision: number
  readonly initial: string
  readonly messages: ReadonlyArray<SessionMessage.Info>
  readonly liveState: SessionLiveState.Snapshot
  readonly configGeneration?: number
}

/**
 * Resolves model-request state in two phases: `select` fixes the Session,
 * agent, and instruction sources; `load` adds the model and active history for
 * that selection. This module does not build or execute the model request.
 */
export interface Interface {
  /** Selects the Session, agent, and instruction sources used by subsequent work. */
  readonly select: (sessionID: SessionSchema.ID) => Effect.Effect<Selection, AgentNotFoundError | ScopeUnavailableError>
  /** Resolves the model and active history for that selection, or for `model` in place of the Session's model. */
  readonly load: (
    selection: Selection,
    options?: { readonly model?: Model.Ref },
  ) => Effect.Effect<Loaded, SessionRunnerModel.Error | ScopeUnavailableError>
  /** Reads the active context revision without preparing model-visible history. */
  readonly revision: (sessionID: SessionSchema.ID) => Effect.Effect<number>
}

/** Rules that decide which tools a Session's selected agent can see and call. */
export function toolPermissions(agent: Pick<Agent.Info, "mode" | "permissions">, ceiling: Permission.Ruleset) {
  return Permission.merge(
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

/** Location-scoped model-context loader for durable Session Steps. */
export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionContext") {}

const boundSource = Effect.gen(function* () {
  return {
    scope: "bound" as const, config: yield* Config.Service, models: yield* SessionRunnerModel.Service,
    discovery: yield* InstructionDiscovery.Service, mcpInstructions: yield* McpInstructions.Service,
    plugins: yield* PluginSupervisor.Service, referenceInstructions: yield* ReferenceInstructions.Service,
    skillInstructions: yield* SkillInstructions.Service,
  }
})
const standaloneSource = Effect.gen(function* () {
  return { scope: "standalone" as const, config: yield* StandaloneConfig.Service, agents: yield* StandaloneAgent.Service, models: yield* StandaloneModel.Service }
})
const makeLayer = <R>(sourceEffect: Effect.Effect<Effect.Success<typeof boundSource> | Effect.Success<typeof standaloneSource>, never, R>) => Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const catalog = yield* Catalog.Service
    const coordination = yield* CoordinationService.Service
    const builtins = yield* InstructionBuiltIns.Service
    const db = (yield* Database.Service).db
    const entries = yield* InstructionEntry.Service
    const location = yield* Location.Service
    const liveState = yield* SessionLiveState.Service
    const source = yield* sourceEffect
    const projectArtifactInstructions = ProjectArtifactInstructions.make()
    const memoryInstructions = MemoryInstructions.make()
    const store = yield* SessionStore.Service
    const registry = yield* ToolRegistry.Service
    const selections = new WeakSet<Selection>()
    const unavailable = () => new ScopeUnavailableError({ operation: "standalone context configuration" })

    const revision = Effect.fn("SessionContext.revision")(function* (sessionID: SessionSchema.ID) {
      const state = yield* db
        .select({ revision: SessionContextStateTable.revision })
        .from(SessionContextStateTable)
        .where(eq(SessionContextStateTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!state) return yield* Effect.die(new Error(`Context state not found for Session ${sessionID}`))
      return state.revision
    })

    const select = Effect.fn("SessionContext.select")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt

      if (source.scope === "standalone" && session.scope !== source.scope) return yield* unavailable()
      if (source.scope === "bound") yield* source.plugins.flush
      const configSnapshot = source.scope === "standalone"
        ? yield* source.config.snapshot().pipe(Effect.mapError(unavailable))
        : { entries: yield* source.config.entries(), generation: undefined }
      if (source.scope === "standalone") yield* source.agents.refresh().pipe(Effect.mapError(unavailable))
      const access = yield* coordination.accessOf(sessionID)
      const scoped = access !== undefined && access.role !== "executor"
      const modelOverride = yield* CoordinationModel.override(db, sessionID)
      const agent = yield* agents.select(session.agent)
      if (!agent.info) return yield* new AgentNotFoundError({ sessionID: session.id, agent: session.agent ?? agent.id })
      if (source.scope === "standalone" && !Agent.isSelectable(agent.info)) return yield* new AgentNotFoundError({ sessionID: session.id, agent: agent.id })
      const configEntries = configSnapshot.entries
      const capabilities = Config.capabilities(configEntries)
      const permissions = toolPermissions(agent.info, session.permissionCeiling ?? [])
      const tools = yield* registry.available([...permissions, ...CoordinationAccess.rules(scoped)], capabilities)
      const memoryEnabled = ConfigMemory.resolve(
        configEntries.flatMap((entry) => (entry.type === "document" && entry.info.memory ? [entry.info.memory] : [])),
      ).enabled
      const guidanceModel = modelOverride ?? session.model ?? (source.scope === "bound" ? yield* catalog.model.defaultSelection() : undefined)
      const instructions = yield* Effect.all(
        [
          builtins.load({ sessionID, capabilities, tools, scope: source.scope }),
          ...(source.scope === "bound" ? [source.discovery.load(), source.skillInstructions.load(agent), source.referenceInstructions.load(), source.mcpInstructions.load(agent)] : []),
          Effect.succeed(Instructions.when(access !== undefined, CoordinationInstructions.make(access?.role ?? "executor"))),
          Effect.succeed(
            Instructions.when(
              InstructionBuiltIns.enabled("project-artifact-authoring", { capabilities, tools }),
              projectArtifactInstructions,
            ),
          ),
          Effect.succeed(
            Instructions.when(
              memoryEnabled && InstructionBuiltIns.enabled("memory", { capabilities, tools }),
              memoryInstructions,
            ),
          ),
          Effect.succeed(
            guidanceModel === undefined
              ? Instructions.empty
              : Instructions.when(
                  InstructionBuiltIns.enabled("model-guidance", { capabilities, tools }),
                  ModelGuidanceInstructions.make(db, guidanceModel),
                ),
          ),
          entries.load(sessionID),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.map(Instructions.combine))
      if (source.scope === "standalone") {
        if (configSnapshot.generation === undefined) return yield* unavailable()
        yield* source.config.assert(configSnapshot.generation).pipe(Effect.mapError(unavailable))
      }
      const selected: Selection = { session, agent: { ...agent, info: agent.info }, instructions, ...(modelOverride === undefined ? {} : { modelOverride }), ...(configSnapshot.generation === undefined ? {} : { configGeneration: configSnapshot.generation }) }
      selections.add(selected)
      return selected
    })

    const load = Effect.fn("SessionContext.load")(function* (
      selection: Selection,
      options?: { readonly model?: Model.Ref },
    ) {
      if (source.scope === "standalone") {
        if (!selections.has(selection) || selection.configGeneration === undefined) return yield* unavailable()
        yield* source.config.assert(selection.configGeneration).pipe(Effect.mapError(unavailable))
      }
      const contextRevision = yield* revision(selection.session.id)
      const modelRef = options?.model ?? selection.modelOverride
      const model = yield* source.models.resolve(
        modelRef === undefined ? selection.session : { ...selection.session, model: modelRef },
      ).pipe(Effect.mapError((error) => error instanceof StandaloneConfig.InvalidError ? unavailable() : error))
      const history = yield* SessionHistory.entriesForRunner(
        db,
        selection.session.id,
        selection.instructions,
        model.ref,
        model.accountIdentityDigest,
      )
      const live = yield* liveState.load(selection.session.id).pipe(Effect.catch((error) => error instanceof ScopeUnavailableError ? Effect.fail(error) : Effect.die(error)))
      if (source.scope === "standalone" && selection.configGeneration !== undefined) yield* source.config.assert(selection.configGeneration).pipe(Effect.mapError(unavailable))
      return {
        session: selection.session,
        agent: selection.agent,
        model,
        contextRevision,
        initial: history.initial,
        messages: history.entries.map((entry) => entry.message),
        liveState: live,
        ...(selection.configGeneration === undefined ? {} : { configGeneration: selection.configGeneration }),
      }
    })

    return Service.of({ select, load, revision })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: makeLayer(boundSource),
  deps: [
    Agent.node,
    Catalog.node,
    Config.node,
    Database.node,
    InstructionBuiltIns.node,
    InstructionDiscovery.node,
    InstructionEntry.node,
    Location.node,
    SessionLiveState.node,
    McpInstructions.node,
    PluginSupervisor.node,
    ReferenceInstructions.node,
    SessionRunnerModel.node,
    SessionStore.node,
    SkillInstructions.node,
    ToolRegistry.node,
    CoordinationService.node,
  ],
})

export const standaloneNode = makeLocationNode({
  service: Service,
  layer: makeLayer(standaloneSource),
  deps: [Agent.node, Catalog.node, StandaloneConfig.node, StandaloneAgent.node, Database.node, InstructionBuiltIns.node, InstructionEntry.node, Location.node, SessionLiveState.standaloneNode, StandaloneModel.node, SessionStore.node, ToolRegistry.standaloneNode, StandaloneTools.node, CoordinationService.node],
})
