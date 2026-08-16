export * as ProjectArtifactSource from "./source"
export * as ProjectArtifactStandardSourceRegistry from "./source-registry"
export { StandardSourceRegistry, make, registryNode } from "./source-registry"

import path from "path"
import { define } from "@ycoding-ai/plugin/effect/plugin"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { Project } from "@ycoding-ai/schema/project"
import { Agent } from "@ycoding-ai/schema/agent"
import { Session } from "@ycoding-ai/schema/session"
import { Context, DateTime, Effect, Exit, Layer, Option, Schema, Scope, Stream } from "effect"
import { AgentV2 } from "../agent"
import { CommandV2 } from "../command"
import { makeLocationNode } from "../effect/app-node"
import { Global } from "../global"
import { Location } from "../location"
import { ProjectArtifactStore } from "../project-artifact"
import { ProjectArtifactAccounting } from "./accounting"
import { EventV2 } from "../event"
import { SessionEvent } from "../session/event"
import { SessionStore } from "../session/store"
import { SessionAutonomy } from "../session/autonomy"
import { State } from "../state"
import { Hash } from "../util/hash"
import { SkillV2 } from "../skill"
import { ProjectArtifactAdapterRegistry, type VersionIndex } from "./adapter/index"
import { ProjectArtifactPackage } from "./package"
import { StandardSourceRegistry, registryNode, type Record } from "./source-registry"

export interface Provenance {
  readonly scope: "project" | "global"
  readonly scopeID: ProjectArtifact.ScopeID
  readonly versionID: ProjectArtifact.VersionID
  readonly kind: ProjectArtifact.Kind
  readonly id: ProjectArtifact.ID
  readonly expectedRevision: ProjectArtifact.Revision
  readonly expectedDigest: ProjectArtifact.Digest
}


export interface Interface {
  readonly refresh: () => Effect.Effect<void>
  readonly provenance: (kind: ProjectArtifact.Kind, id: string) => Effect.Effect<Provenance | undefined>
  readonly activate: (input: {
    readonly kind: ProjectArtifact.Kind
    readonly id: string
    readonly sessionID: Session.ID
    readonly agentID?: Agent.ID
    readonly source: ProjectArtifact.ActivationSource
    readonly boundarySeq: ProjectArtifact.Revision
    readonly messageID?: string
    readonly callID?: string
    readonly activatedAt?: ProjectArtifact.TimestampMillis
  }) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/ProjectArtifactSource") {}

const decodeMarker = Schema.decodeUnknownOption(Schema.fromJsonString(ProjectArtifactPackage.Marker))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const accounting = yield* ProjectArtifactAccounting.Service
    const commands = yield* CommandV2.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const registry = yield* StandardSourceRegistry
    const skills = yield* SkillV2.Service
    const store = yield* ProjectArtifactStore.Service
    const sessions = yield* SessionStore.Service
    const events = yield* EventV2.Service
    const autonomy = yield* SessionAutonomy.Service
    const scope = yield* Scope.Scope
    const key = JSON.stringify({ directory: location.directory, workspaceID: location.workspaceID })
    const active = new Map<string, Provenance>()
    let adapterScope = yield* Scope.fork(scope)
    const executions = new Map<string, { readonly goalMode: boolean; readonly startedAt: number }>()
    const terminals = new Set<string>()
    const managedActivations = new Map<Session.ID, Map<ProjectArtifact.ActivationID, ProjectArtifact.Activation>>()

    const refreshUnsafe = Effect.fn("ProjectArtifactSource.refresh")(function* () {
      const observed = yield* standardSources({ agents, commands, global, location, skills })
      const summaries =
        location.project.id === Project.ID.global
          ? []
          : yield* Effect.all([
              store.list({ scope: { type: "project" }, projectID: location.project.id, stage: "trial" }),
              store.list({ scope: { type: "project" }, projectID: location.project.id, stage: "active" }),
            ])
      const candidates = yield* Effect.forEach(
        summaries.flat().filter((summary): summary is ProjectArtifact.ArtifactSummary => "currentVersionID" in summary),
        (summary) =>
          store
            .get({ scope: { type: "project" }, projectID: location.project.id, kind: summary.kind, id: summary.id })
            .pipe(Effect.flatMap((details) => validate({ details, global, location }))),
      )
      const standard = observed.filter(
        (source) =>
          !candidates.some(
            (candidate) =>
              candidate !== undefined &&
              source.kind === candidate.kind &&
              source.id === candidate.id &&
              (source.path === candidate.version.contentPath ||
                source.managedScopeID === candidate.details.artifact.scope.id),
          ),
      )
      const allowed = (yield* Effect.forEach(
        candidates.filter((candidate): candidate is Candidate => candidate !== undefined),
        (candidate) => {
          const existing = standard.filter((source) => source.kind === candidate.kind && source.id === candidate.id)
          if (existing.length === 0) return Effect.succeed(candidate)
          const exactShadow =
            candidate.details.artifact.shadowedScopeID !== undefined &&
            existing.every(
              (source) =>
              source.scope === "global" &&
              source.managedScopeID === candidate.details.artifact.shadowedScopeID &&
              source.managedVersionID === candidate.details.currentVersion.provenance.originVersionID &&
              source.managedDigest === candidate.details.currentVersion.provenance.originEvidenceDigest,
            )
          if (exactShadow) return Effect.succeed(candidate)
          return Effect.logWarning("project artifact collision", {
            kind: candidate.kind,
            id: candidate.id,
            scopeID: candidate.details.artifact.scope.id,
            sources: existing.length,
          }).pipe(Effect.as(undefined))
        },
      )).filter((candidate): candidate is Candidate => candidate !== undefined)
      const nextActive = new Map<string, Provenance>()
      for (const candidate of allowed) {
        nextActive.set(candidateKey(candidate.kind, candidate.id), {
          scope: "project",
          scopeID: candidate.version.scopeID,
          versionID: candidate.version.versionID,
          kind: candidate.kind,
          id: candidate.id,
          expectedRevision: candidate.details.artifact.revision,
          expectedDigest: candidate.details.currentVersion.contentDigest,
        })
      }
      const globalScope = yield* store.resolveGlobalScope()
      for (const source of standard) {
          if (
            source.scope !== "global" ||
            source.managedScopeID !== globalScope.id ||
            source.managedVersionID === undefined ||
            source.managedDigest === undefined
          )
            continue
          const details = yield* store
            .get({ scope: { type: "global" }, kind: source.kind, id: source.id })
            .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          if (
            !details ||
            details.artifact.scope.id !== source.managedScopeID ||
            details.currentVersion.id !== source.managedVersionID ||
            details.currentVersion.contentDigest !== source.managedDigest
          )
            continue
          nextActive.set(candidateKey(source.kind, source.id), {
            scope: "global",
            scopeID: source.managedScopeID,
            versionID: source.managedVersionID,
            kind: source.kind,
            id: source.id,
            expectedRevision: details.artifact.revision,
            expectedDigest: details.currentVersion.contentDigest,
          })
      }
      const nextScope = yield* Scope.fork(scope)
      const registered = yield* State.batch(
        Effect.gen(function* () {
          yield* skills.transform((draft) => {
            for (const candidate of allowed.filter((candidate) => candidate.kind === "skill"))
              ProjectArtifactAdapterRegistry.get("skill").activate(candidate.version, { skill: draft })
          }).pipe(Effect.provideService(Scope.Scope, nextScope))
          yield* commands.transform((draft) => {
            for (const candidate of allowed.filter((candidate) => candidate.kind === "command"))
              ProjectArtifactAdapterRegistry.get("command").activate(candidate.version, { command: draft })
          }).pipe(Effect.provideService(Scope.Scope, nextScope))
          yield* agents.transform((draft) => {
            for (const candidate of allowed.filter((candidate) => candidate.kind === "agent"))
              ProjectArtifactAdapterRegistry.get("agent").activate(candidate.version, { agent: draft })
          }).pipe(Effect.provideService(Scope.Scope, nextScope))
        }),
      ).pipe(Effect.exit)
      if (Exit.isFailure(registered)) {
        yield* Scope.close(nextScope, registered)
        return yield* Effect.failCause(registered.cause)
      }
      yield* State.batch(
        Effect.gen(function* () {
          registry.replace(key, standard)
          active.clear()
          for (const [key, value] of nextActive) active.set(key, value)
          yield* Scope.close(adapterScope, Exit.void)
          adapterScope = nextScope
        }),
      )
    })

    const refresh = () =>
      refreshUnsafe().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("project artifact source refresh failed", { cause }).pipe(Effect.asVoid),
        ),
      )

    yield* events
      .subscribe([
        SessionEvent.Execution.Started,
        SessionEvent.Execution.Succeeded,
        SessionEvent.Execution.Failed,
        SessionEvent.Execution.Interrupted,
      ])
      .pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === "session.execution.started") {
              const session = yield* sessions.get(event.data.sessionID)
              if (
                !session ||
                session.location.directory !== location.directory ||
                session.location.workspaceID !== location.workspaceID
              )
                return
              const state = yield* autonomy
                .get(event.data.sessionID)
                .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(SessionAutonomy.defaultState)))
              executions.set(event.data.sessionID, { goalMode: state.goal?.status === "active", startedAt: DateTime.toEpochMillis(event.created) })
              return
            }
            const session = yield* sessions.get(event.data.sessionID)
            if (
              !session ||
              session.location.directory !== location.directory ||
              session.location.workspaceID !== location.workspaceID
            )
              return
            const messages = yield* sessions.context(event.data.sessionID)
            const assistant = messages.findLast((message) => message.type === "assistant")
            const terminal = assistant
              ? `${event.data.sessionID}:${assistant.id}`
              : `${event.data.sessionID}:boundary:${event.durable?.seq ?? 0}`
            if (terminals.has(terminal)) return
            const tools = assistant?.type === "assistant" ? assistant.content.filter((content) => content.type === "tool") : []
            const outcome =
              event.type === "session.execution.succeeded"
                ? "succeeded"
                : event.type === "session.execution.failed"
                  ? "failed"
                  : "interrupted"
            const execution = executions.get(event.data.sessionID)
            const goal = yield* autonomy
              .get(event.data.sessionID)
              .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(SessionAutonomy.defaultState)))
            const activations = Array.from(managedActivations.get(event.data.sessionID)?.values() ?? [])
            const managedKinds = [...messages.flatMap((message) => {
              if (message.type === "skill" && message.artifact) return [message.artifact.kind]
              if (message.type === "agent-switched" && message.artifact) return [message.artifact.kind]
              if (message.type !== "user") return []
              const artifact = message.metadata?.projectArtifact
              return artifact && typeof artifact === "object" && artifact !== null && "kind" in artifact && typeof artifact.kind === "string"
                ? [artifact.kind]
                : []
            }), ...activations.map((activation) => activation.artifact.kind)]
            const managedTool = (tool: (typeof tools)[number]) =>
              activations.some(
                (activation) =>
                  activation.messageID === assistant?.id &&
                  activation.callID === tool.id &&
                  ((tool.name === "skill" && activation.source === "skill-tool") ||
                    (tool.name === "subagent" && activation.source === "subagent-launch")),
              )
            const kind = (Array.from(new Set(managedKinds)).toSorted()[0] ?? "skill") as ProjectArtifact.Kind
            const tokens = assistant?.type === "assistant" ? assistant.tokens : undefined
            const observed = yield* accounting
              .observe({
                projectID: session.projectID,
                sessionID: event.data.sessionID,
                terminalMessageID: assistant?.id,
                boundarySeq: ProjectArtifact.Revision.make(event.durable?.seq ?? 0),
                kind,
                agentID: session.agent,
                modelID: session.model ? `${session.model.providerID}/${session.model.id}` : "unknown",
                goalMode: execution?.goalMode ?? false,
                standardInvocationCount: ProjectArtifact.Revision.make(
                  messages.filter((message) => message.type === "skill" && message.artifact === undefined).length +
                    tools.filter(
                      (tool) =>
                        tool.state.status === "completed" &&
                        (tool.name === "skill" || tool.name === "subagent") &&
                        !managedTool(tool),
                    ).length,
                ),
                externalConfounded: new Set(managedKinds).size > 1,
                terminalOutcome: outcome,
                goalStatus:
                  execution?.goalMode && goal.goal?.status === "completed"
                    ? "completed"
                    : execution?.goalMode && goal.goal?.status === "stopped"
                      ? "stopped"
                      : execution?.goalMode && goal.goal?.status === "exhausted"
                        ? "exhausted"
                        : "none",
                repeatFix: false,
                latencyMs: execution ? ProjectArtifact.TimestampMillis.make(Math.max(0, DateTime.toEpochMillis(event.created) - execution.startedAt)) : undefined,
                inputTokens: ProjectArtifact.Revision.make(Math.max(0, Math.floor(tokens?.input ?? 0))),
                outputTokens: ProjectArtifact.Revision.make(Math.max(0, Math.floor(tokens?.output ?? 0))),
                cacheReadTokens: ProjectArtifact.Revision.make(Math.max(0, Math.floor(tokens?.cache.read ?? 0))),
                completedToolCount: ProjectArtifact.Revision.make(tools.filter((tool) => tool.state.status === "completed").length),
                failedToolCount: ProjectArtifact.Revision.make(tools.filter((tool) => tool.state.status === "error").length),
                observedAt: ProjectArtifact.TimestampMillis.make(DateTime.toEpochMillis(event.created)),
              })
            terminals.add(terminal)
            executions.delete(event.data.sessionID)
            const evaluated = new Set<ProjectArtifact.VersionID>()
            for (const observation of observed) {
              if (evaluated.has(observation.artifact.versionID)) continue
              evaluated.add(observation.artifact.versionID)
              const provenance = active.get(candidateKey(observation.artifact.kind, observation.artifact.id))
              if (
                !provenance ||
                provenance.scopeID !== observation.artifact.scopeID ||
                provenance.versionID !== observation.artifact.versionID
              ) {
                yield* Effect.logWarning("project artifact governor skipped stale provenance", {
                  scopeID: observation.artifact.scopeID,
                  kind: observation.artifact.kind,
                  id: observation.artifact.id,
                  versionID: observation.artifact.versionID,
                })
                continue
              }
              yield* store
                .evaluateGovernor({
                  scopeID: provenance.scopeID,
                  kind: provenance.kind,
                  id: provenance.id,
                  expectedRevision: provenance.expectedRevision,
                  expectedVersionID: provenance.versionID,
                  expectedDigest: provenance.expectedDigest,
                  agentID: session.agent,
                  modelID: session.model ? `${session.model.providerID}/${session.model.id}` : "unknown",
                  goalMode: execution?.goalMode ?? false,
                })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("project artifact governor evaluation failed", {
                      cause,
                      versionID: observation.artifact.versionID,
                    }),
                  ),
                )
            }
          }).pipe(
            Effect.catchCause((cause) => Effect.logWarning("project artifact terminal observation failed", { cause })),
          ),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )

    return yield* Effect.acquireRelease(
      Effect.succeed(
        Service.of({
          refresh,
          provenance: (kind, id) => Effect.sync(() => active.get(candidateKey(kind, ProjectArtifact.ID.make(id)))),
          activate: Effect.fn("ProjectArtifactSource.activate")(function* (input) {
            const provenance = yield* Effect.sync(() => active.get(candidateKey(input.kind, ProjectArtifact.ID.make(input.id))))
            if (!provenance) return
            const message = input.messageID
              ? (yield* sessions.context(input.sessionID)).find((message) => message.id === input.messageID)
              : undefined
            const activation = ProjectArtifact.Activation.make({
                  id: ProjectArtifact.ActivationID.make(
                    `paa_${Hash.sha256([input.sessionID, provenance.versionID, input.source, input.boundarySeq, input.messageID, input.callID].join("\0")).slice(0, 32)}`,
                  ),
                  artifact: {
                    scopeID: provenance.scopeID,
                    kind: provenance.kind,
                    id: provenance.id,
                    versionID: provenance.versionID,
                  },
                  projectID: location.project.id,
                  sessionID: input.sessionID,
                  agentID: input.agentID,
                  source: input.source,
                  messageID: input.messageID,
                  callID: input.callID,
                  boundarySeq: input.boundarySeq,
                  activatedAt:
                    input.activatedAt ??
                    ProjectArtifact.TimestampMillis.make(
                      message ? DateTime.toEpochMillis(message.time.created) : Date.now(),
                    ),
                })
            yield* accounting.activate(activation)
            const current = managedActivations.get(input.sessionID) ?? new Map()
            current.set(activation.id, activation)
            managedActivations.set(input.sessionID, current)
          }),
        }),
      ),
      () => Effect.sync(() => registry.remove(key)),
    )
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    AgentV2.node,
    CommandV2.node,
    Global.node,
    Location.node,
    ProjectArtifactStore.node,
    ProjectArtifactAccounting.node,
    EventV2.node,
    SessionStore.node,
    SessionAutonomy.node,
    registryNode,
    SkillV2.node,
  ],
})

export const Plugin = define({
  id: "ycoding.project-artifact.source",
  effect: Effect.fn("ProjectArtifactSource.Plugin")(function* () {
    const source = yield* Service
    yield* source.refresh()
  }),
})

type Candidate = {
  readonly kind: "skill" | "command" | "agent"
  readonly id: ProjectArtifact.ID
  readonly details: ProjectArtifact.ArtifactDetails
  readonly version: VersionIndex
}

function candidateKey(kind: ProjectArtifact.Kind, id: ProjectArtifact.ID) {
  return `${kind}:${id}`
}

function standardMarkerPath(contentPath: string, kind: ProjectArtifact.Kind, id: ProjectArtifact.ID) {
  if (kind === "skill") return path.join(path.dirname(contentPath), ".ycoding-project-artifact.json")
  return path.join(path.dirname(contentPath), `.${id}.ycoding-project-artifact.json`)
}

function sourceScope(input: { readonly location: Location.Interface; readonly path?: string }) {
  if (!input.path) return "global" as const
  const relative = path.relative(input.location.project.directory, input.path)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? "project" as const : "global" as const
}

function standardSources(input: {
  readonly agents: AgentV2.Interface
  readonly commands: CommandV2.Interface
  readonly global: Global.Interface
  readonly location: Location.Interface
  readonly skills: SkillV2.Interface
}) {
  return Effect.gen(function* () {
    const sources = [
      ...(yield* input.skills.list()).map((skill) => ({ kind: "skill" as const, id: ProjectArtifact.ID.make(skill.id), path: skill.location })),
      ...(yield* input.commands.list()).flatMap((command) =>
        (command.locations?.length ? command.locations : [undefined]).map((location) => ({
          kind: "command" as const,
          id: ProjectArtifact.ID.make(command.name),
          path: location,
        })),
      ),
      ...(yield* input.agents.list()).flatMap((agent) =>
        (agent.locations?.length ? agent.locations : [undefined]).map((location) => ({
          kind: "agent" as const,
          id: ProjectArtifact.ID.make(agent.id),
          path: location,
        })),
      ),
    ]
    return yield* Effect.forEach(sources, (source) => readStandardSource({ ...source, location: input.location }))
  })
}

function readStandardSource(input: {
  readonly kind: "skill" | "command" | "agent"
  readonly id: ProjectArtifact.ID
  readonly path?: string
  readonly location: Location.Interface
}) {
  return Effect.promise(async () => {
    const scope = sourceScope(input)
    if (!input.path) return { scope, kind: input.kind, id: input.id } satisfies Record
    const markerPath = standardMarkerPath(input.path, input.kind, input.id)
    const marker = await Bun.file(markerPath)
      .text()
      .then((content) => Option.getOrUndefined(decodeMarker(content)), () => undefined)
    const valid =
      marker &&
      marker.kind === input.kind &&
      marker.id === input.id &&
      (await Bun.file(input.path).text().then((content) => Hash.sha256(content) === marker.contentDigest, () => false))
    return {
      scope,
      projectID: scope === "project" ? input.location.project.id : undefined,
      kind: input.kind,
      id: input.id,
      path: input.path,
      managedScopeID: valid ? marker.scopeID : undefined,
      managedVersionID: valid ? marker.versionID : undefined,
      managedDigest: valid ? marker.contentDigest : undefined,
    } satisfies Record
  })
}

function validate(input: {
  readonly details: ProjectArtifact.ArtifactDetails
  readonly global: Global.Interface
  readonly location: Location.Interface
}) {
  return Effect.tryPromise({
    try: async () => {
      const artifact = input.details.artifact
      if (artifact.scope.type !== "project" || artifact.stage === "degraded" || artifact.stage === "disabled" || artifact.stage === "quarantine") return undefined
      if (artifact.kind === "plugin") return undefined
      const root = path.join(input.global.data, "project-artifacts", artifact.scope.storageID)
      const contentPath = ProjectArtifactPackage.activeContentPath(root, artifact.kind, artifact.id)
      const marker = Option.getOrUndefined(decodeMarker(await Bun.file(ProjectArtifactPackage.activeMarkerPath(root, artifact.kind, artifact.id)).text()))
      const content = await Bun.file(contentPath).text()
      if (
        !marker ||
        marker.scopeID !== artifact.scope.id ||
        marker.versionID !== input.details.currentVersion.id ||
        marker.kind !== artifact.kind ||
        marker.id !== artifact.id ||
        marker.contentDigest !== input.details.currentVersion.contentDigest ||
        Hash.sha256(content) !== marker.contentDigest
      )
        return undefined
      const definition = ProjectArtifactAdapterRegistry.parse(artifact.kind, content)
      if (JSON.stringify(definition) !== JSON.stringify(input.details.definition)) return undefined
      return {
        kind: artifact.kind,
        id: artifact.id,
        details: input.details,
        version: {
          scopeID: artifact.scope.id,
          versionID: input.details.currentVersion.id,
          id: artifact.id,
          contentPath,
          definition,
        },
      } satisfies Candidate
    },
    catch: () => new Error("project artifact validation failed"),
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))
}
