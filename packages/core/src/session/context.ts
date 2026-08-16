export * as SessionContext from "./context"

import { Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { InstructionDiscovery } from "../instruction-discovery"
import { Instructions } from "../instructions/index"
import { InstructionBuiltIns } from "../instructions/builtins"
import { ProjectArtifactInstructions } from "../project-artifact/instructions"
import { Location } from "../location"
import { McpInstructions } from "../mcp/instructions"
import { PluginSupervisor } from "../plugin/supervisor"
import { ReferenceInstructions } from "../reference/instructions"
import { SkillInstructions } from "../skill/instructions"
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
  readonly agent: AgentV2.Selection & { readonly info: AgentV2.Info }
  readonly instructions: Instructions.Instructions
}

export interface Loaded {
  readonly session: SessionSchema.Info
  readonly agent: AgentV2.Selection & { readonly info: AgentV2.Info }
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
  /** Resolves the model and active history for that selection. */
  readonly load: (selection: Selection) => Effect.Effect<Loaded, SessionRunnerModel.Error>
  /** Reads the active context revision without preparing model-visible history. */
  readonly revision: (sessionID: SessionSchema.ID) => Effect.Effect<number>
}

/** Location-scoped model-context loader for durable Session Steps. */
export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionContext") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const builtins = yield* InstructionBuiltIns.Service
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
    const store = yield* SessionStore.Service

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
      const agent = yield* agents.select(session.agent)
      if (!agent.info) return yield* new AgentNotFoundError({ sessionID: session.id, agent: session.agent ?? agent.id })
      const instructions = yield* Effect.all(
        [
          builtins.load(sessionID),
          discovery.load(),
          skillInstructions.load(agent),
          referenceInstructions.load(),
          mcpInstructions.load(agent),
          Effect.succeed(projectArtifactInstructions),
          entries.load(sessionID),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.map(Instructions.combine))
      return { session, agent: { ...agent, info: agent.info }, instructions }
    })

    const load = Effect.fn("SessionContext.load")(function* (selection: Selection) {
      const contextRevision = yield* revision(selection.session.id)
      const model = yield* models.resolve(selection.session)
      const history = yield* SessionHistory.entriesForRunner(db, selection.session.id, selection.instructions)
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
    AgentV2.node,
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
  ],
})
