export * as SessionContext from "./context"

import { Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import type { Model } from "@ycoding-ai/schema/model"
import { Agent } from "../agent"
import { Catalog } from "../catalog"
import { Config } from "../config"
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
import { ReferenceInstructions } from "../reference/instructions"
import { SkillInstructions } from "../skill/instructions"
import { ToolRegistry } from "../tool/registry"
import { AgentNotFoundError } from "./error"
import { SessionHistory } from "./history"
import { InstructionEntry } from "./instruction-entry"
import { SessionLiveState } from "./live-state"
import { SessionMessage } from "./message"
import { SessionRunnerModel } from "./runner/model"
import { SessionSchema } from "./schema"
import { SessionContextStateTable } from "./sql"
import { SessionStore } from "./store"

export interface Selection {
  readonly session: SessionSchema.Info
  readonly agent: Agent.Selection & { readonly info: Agent.Info }
  readonly instructions: Instructions.Instructions
  readonly modelOverride?: Model.Ref
}

export interface Loaded {
  readonly session: SessionSchema.Info
  readonly agent: Agent.Selection & { readonly info: Agent.Info }
  readonly model: SessionRunnerModel.Resolved
  readonly contextRevision: number
  readonly initial: string
  readonly messages: ReadonlyArray<SessionMessage.Info>
  readonly liveState: SessionLiveState.Snapshot
}

/**
 * Resolves model-request state in two phases: `select` fixes the Session,
 * agent, and instruction sources; `load` adds the model and active history for
 * that selection. This module does not build or execute the model request.
 */
export interface Interface {
  /** Selects the Session, agent, and instruction sources used by subsequent work. */
  readonly select: (sessionID: SessionSchema.ID) => Effect.Effect<Selection, AgentNotFoundError>
  /** Resolves the model and active history for that selection, or for `model` in place of the Session's model. */
  readonly load: (
    selection: Selection,
    options?: { readonly model?: Model.Ref },
  ) => Effect.Effect<Loaded, SessionRunnerModel.Error>
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

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const catalog = yield* Catalog.Service
    const coordination = yield* CoordinationService.Service
    const builtins = yield* InstructionBuiltIns.Service
    const config = yield* Config.Service
    const db = (yield* Database.Service).db
    const discovery = yield* InstructionDiscovery.Service
    const entries = yield* InstructionEntry.Service
    const location = yield* Location.Service
    const liveState = yield* SessionLiveState.Service
    const mcpInstructions = yield* McpInstructions.Service
    const models = yield* SessionRunnerModel.Service
    const plugins = yield* PluginSupervisor.Service
    const referenceInstructions = yield* ReferenceInstructions.Service
    const skillInstructions = yield* SkillInstructions.Service
    const projectArtifactInstructions = ProjectArtifactInstructions.make()
    const memoryInstructions = MemoryInstructions.make()
    const store = yield* SessionStore.Service
    const registry = yield* ToolRegistry.Service

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

      yield* plugins.flush
      const access = yield* coordination.accessOf(sessionID)
      const scoped = access !== undefined && access.role !== "executor"
      const modelOverride = yield* CoordinationModel.override(db, sessionID)
      const agent = yield* agents.select(session.agent)
      if (!agent.info) return yield* new AgentNotFoundError({ sessionID: session.id, agent: session.agent ?? agent.id })
      const configEntries = yield* config.entries()
      const capabilities = Config.capabilities(configEntries)
      const permissions = toolPermissions(agent.info, session.permissionCeiling ?? [])
      const tools = yield* registry.available([...permissions, ...CoordinationAccess.rules(scoped)], capabilities)
      const memoryEnabled = ConfigMemory.resolve(
        configEntries.flatMap((entry) => (entry.type === "document" && entry.info.memory ? [entry.info.memory] : [])),
      ).enabled
      const guidanceModel = modelOverride ?? session.model ?? (yield* catalog.model.defaultSelection())
      const instructions = yield* Effect.all(
        [
          builtins.load({ sessionID, capabilities, tools }),
          discovery.load(),
          skillInstructions.load(agent),
          referenceInstructions.load(),
          mcpInstructions.load(agent),
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
      return { session, agent: { ...agent, info: agent.info }, instructions, ...(modelOverride === undefined ? {} : { modelOverride }) }
    })

    const load = Effect.fn("SessionContext.load")(function* (
      selection: Selection,
      options?: { readonly model?: Model.Ref },
    ) {
      const contextRevision = yield* revision(selection.session.id)
      const modelRef = options?.model ?? selection.modelOverride
      const model = yield* models.resolve(
        modelRef === undefined ? selection.session : { ...selection.session, model: modelRef },
      )
      const history = yield* SessionHistory.entriesForRunner(
        db,
        selection.session.id,
        selection.instructions,
        model.ref,
        model.accountIdentityDigest,
      )
      const live = yield* liveState.load(selection.session.id).pipe(Effect.orDie)
      return {
        session: selection.session,
        agent: selection.agent,
        model,
        contextRevision,
        initial: history.initial,
        messages: history.entries.map((entry) => entry.message),
        liveState: live,
      }
    })

    return Service.of({ select, load, revision })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
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
