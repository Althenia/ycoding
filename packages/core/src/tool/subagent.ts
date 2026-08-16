export * as SubagentTool from "./subagent"

import { Message, ToolFailure } from "@ycoding-ai/ai"
import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { DescriptionText, PromptText } from "@ycoding-ai/schema/session-orchestration"
import { Cause, Effect, Schedule, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Config } from "../config"
import { PluginRuntime } from "../plugin/runtime"
import { PermissionV2 } from "../permission"
import { SessionGuardrail } from "../session/guardrail"
import { SessionSchema } from "../session/schema"
import { SessionMessage } from "../session/message"
import { ModelV2 } from "../model"
import { SessionOrchestration } from "../session/orchestration"
import { SessionRunnerModel } from "../session/runner/model"
import { ProjectArtifactSource } from "../project-artifact/source"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { Tool } from "./tool"

export const name = "subagent"

const NO_TEXT = "Subagent completed without a text response."
export const progressPrompt = "Report current status, blockers, and ETA."
const backgroundStarted = (sessionID: SessionSchema.ID) =>
  `Subagent launched (id: ${sessionID}). No polling is required. Do not mention the launch or any running, completed, failed, or total status unless the user explicitly asks for subagent status.`

export const repeatProgress = <E, R>(send: Effect.Effect<unknown, E, R>) =>
  Effect.sleep("10 minutes").pipe(Effect.andThen(send), Effect.repeat(Schedule.forever))

export const Input = Schema.Struct({
  agent: Schema.String.annotate({ description: "The configured agent to run as the subagent" }),
  description: DescriptionText.annotate({ description: "A short description of the subagent's task" }),
  prompt: PromptText.annotate({ description: "The task for the subagent to perform" }),
  background: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Deprecated. Subagents always run in the background.",
  }),
  model: ModelV2.Ref.pipe(Schema.optional).annotate({
    description: "Optional canonical provider, model, and variant override for this child",
  }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literals(["completed", "running"]),
  output: Schema.String,
})

export const description = [
  "Spawn a subagent: a child session running a configured agent with fresh context.",
  "Subagents launch as durable background children and return immediately; no polling is required.",
  "Do not mention subagent status unless the user explicitly asks. Keep launch, running, completed, failed, and total bookkeeping internal.",
  "If a child failure prevents the requested outcome, report the blocker without routine status counts.",
].join("\n")

export const availableAgents = Effect.fn("SubagentTool.availableAgents")(function* (input: {
  readonly permission: Pick<PermissionV2.Interface, "evaluateEffective">
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly candidates: ReadonlyArray<AgentV2.Info>
}) {
  const evaluated = yield* Effect.forEach(input.candidates, (candidate) => {
    if (candidate.mode === "primary" || candidate.hidden) return Effect.succeed(undefined)
    return input.permission
      .evaluateEffective({
        sessionID: input.sessionID,
        agent: input.agent,
        action: name,
        resource: candidate.id,
      })
      .pipe(Effect.map((effect) => (effect === "deny" ? undefined : candidate)))
  })
  return evaluated
    .filter((candidate): candidate is AgentV2.Info => candidate !== undefined)
    .toSorted((left, right) => left.id.localeCompare(right.id))
})

export const Plugin = {
  id: "ycoding.tool.subagent",
  effect: Effect.fn("SubagentTool.Plugin")(function* (ctx: PluginContext) {
    const runtime = yield* PluginRuntime.Service
    const agents = yield* AgentV2.Service
    const config = yield* Config.Service
    const permission = yield* PermissionV2.Service
    const guardrail = yield* SessionGuardrail.Service
    const models = yield* SessionRunnerModel.Service
    const orchestration = runtime.orchestration
    const projectArtifactSource = yield* ProjectArtifactSource.Service

    // Concatenate the child's final completed assistant text. Distinguishes "completed with no
    // text" (generic string) from "failed" (the run effect fails, surfaced as a job error).
    const latestAssistantText = Effect.fn("SubagentTool.latestAssistantText")(function* (sessionID: SessionSchema.ID) {
      const messages = yield* runtime.session.messages({ sessionID, order: "desc", limit: 20 })
      const assistant = messages.find(
        (message) =>
          message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
      )
      if (assistant === undefined || assistant.type !== "assistant") return NO_TEXT
      const text = assistant.content
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("")
      return text.length > 0 ? text : NO_TEXT
    })

    yield* ctx.tool
      .transform((draft) =>
        draft.add(
          name,
          Tool.make({
            description,
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const parent = yield* runtime.session
                  .get(context.sessionID)
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                    ),
                  )
                let current = parent
                let depth = 0
                while (current.parentID) {
                  depth++
                  current = yield* runtime.session
                    .get(current.parentID)
                    .pipe(
                      Effect.mapError(
                        (error) => new ToolFailure({ message: `Parent session not found: ${current.parentID}`, error }),
                      ),
                    )
                }
                const limit = Config.latest(yield* config.entries(), "experimental")?.subagent_depth ?? 1
                if (depth >= limit)
                  return yield* new ToolFailure({
                    message: `Subagent depth limit reached (${limit}). Increase "experimental.subagent_depth" to allow nested subagents.`,
                  })
                const prepared = yield* SessionOrchestration.preflight(parent, {
                  agent: AgentV2.ID.make(input.agent),
                  model: input.model,
                  caller: context.agent,
                }).pipe(
                  Effect.provideService(AgentV2.Service, agents),
                  Effect.provideService(SessionRunnerModel.Service, models),
                  Effect.mapError((error) => new ToolFailure({ message: error.message, error })),
                )
                yield* SessionOrchestration.authorize(context.sessionID, prepared.target.id, {
                  agent: context.agent,
                  messageID: context.messageID,
                  callID: context.callID,
                }).pipe(
                  Effect.provideService(PermissionV2.Service, permission),
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Subagent denied: ${prepared.target.id}`, error }),
                  ),
                )
                const reservation = yield* guardrail
                  .assert({
                    sessionID: context.sessionID,
                    action: name,
                    resources: [prepared.target.id],
                    metadata: { description: input.description },
                  })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Session guardrail rejected subagent: ${prepared.target.id}`, error }),
                    ),
                  )
                const child = yield* orchestration
                  .launch({
                    parentID: context.sessionID,
                    parentAssistantMessageID: context.messageID,
                    toolCallID: context.callID,
                    agent: AgentV2.ID.make(input.agent),
                    description: input.description,
                    prompt: input.prompt,
                    background: true,
                    model: input.model,
                    prepared,
                  })
                  .pipe(
                    Effect.mapError((error) => new ToolFailure({ message: error.message, error })),
                    Effect.onError(() => reservation.release),
                  )

                yield* projectArtifactSource
                  .activate({
                    kind: "agent",
                    id: input.agent,
                    sessionID: context.sessionID,
                    agentID: AgentV2.ID.make(input.agent),
                    source: "subagent-launch",
                    boundarySeq: ProjectArtifact.Revision.make(0),
                    messageID: context.messageID,
                    callID: context.callID,
                  })
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("project artifact subagent activation failed", {
                        cause,
                        sessionID: context.sessionID,
                      }),
                    ),
                  )

                yield* context.progress({
                  structured: { sessionID: child.sessionID, status: "running" },
                })

                const run = Effect.scoped(
                  Effect.gen(function* () {
                    yield* repeatProgress(
                      orchestration.send({
                        parentID: context.sessionID,
                        childID: child.sessionID,
                        messageID: SessionMessage.ID.create(),
                        text: progressPrompt,
                        delivery: "steer",
                      }),
                    ).pipe(Effect.forkScoped)
                    yield* runtime.session.resume(child.sessionID)
                    const text = yield* latestAssistantText(child.sessionID)
                    yield* orchestration.settle(child.sessionID, {
                      type: "completed",
                      excerpt: text.slice(0, 16 * 1024),
                    })
                    return text
                  }),
                ).pipe(
                  Effect.tapCause((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? Effect.void
                      : orchestration
                          .settle(child.sessionID, {
                            type: "failed",
                            error: Cause.pretty(cause),
                            excerpt: Cause.pretty(cause).slice(0, 16 * 1024),
                          })
                          .pipe(Effect.ignore),
                  ),
                  Effect.onInterrupt(() => runtime.session.interrupt(child.sessionID)),
                  Effect.ensuring(reservation.release),
                )

                const info = yield* runtime.job
                  .start({
                    id: child.sessionID,
                    type: name,
                    title: input.description,
                    metadata: {},
                    run,
                  })
                  .pipe(Effect.onError(() => reservation.release))

                yield* runtime.job.background(info.id)
                return {
                  sessionID: child.sessionID,
                  status: "running" as const,
                  output: backgroundStarted(child.sessionID),
                }
              }),
          }),
          { codemode: false },
        ),
      )
      .pipe(Effect.orDie)

    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const team = yield* orchestration
          .teamView(event.sessionID)
          .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)))
        // The TeamView changes on every child state update, so it is appended after all real
        // history as a volatile message that never carries a cache breakpoint.
        if (team && team.view.children.length > 0)
          event.messages.push(Message.make({ role: "user", content: team.text, volatile: true }))
        const tool = event.tools[name]
        if (!tool) return
        const selected = yield* agents.resolve(event.agent)
        if (!selected) return
        const available = yield* availableAgents({
          permission,
          sessionID: event.sessionID,
          agent: selected.id,
          candidates: yield* agents.list(),
        }).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed([])))
        if (available.length === 0) return
        tool.description = [
          tool.description,
          "",
          "Available subagents:",
          ...available.map(
            (agent) =>
              `- ${agent.id}: ${agent.description ?? "This subagent should only be called when explicitly requested."}`,
          ),
        ].join("\n")
      }),
    )
  }),
}
