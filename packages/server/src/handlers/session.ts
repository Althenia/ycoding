import { SessionV2 } from "@ycoding-ai/core/session"
import { InstructionEntry } from "@ycoding-ai/core/session/instruction-entry"
import { DateTime, Effect, Schema, Stream } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { SessionsCursor } from "@ycoding-ai/protocol/groups/session"
import {
  ConflictError,
  CommandEvaluationError,
  CommandNotFoundError,
  InvalidRequestError,
  InvalidCursorError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionBusyError,
  SessionNotFoundError,
  SkillConflictNotFoundError,
  SkillNotFoundError,
  UnknownError,
  ForbiddenError,
  QuestionNotFoundError,
} from "@ycoding-ai/protocol/errors"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionTodo } from "@ycoding-ai/core/session/todo"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { SessionEvent } from "@ycoding-ai/core/session/event"

const DefaultSessionsLimit = 50
const isPublicDurableSessionEvent = Schema.is(SessionEvent.PublicDurable)

export const SessionHandler = HttpApiBuilder.group(Api, "server.session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const orchestration = yield* SessionOrchestration.Service

    return handlers
      .handle(
        "session.list",
        Effect.fn(function* (ctx) {
          const query =
            ctx.query.cursor !== undefined
              ? yield* SessionsCursor.parse(ctx.query.cursor).pipe(
                  Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
                )
              : ctx.query
          const page = yield* session.list({
            ...query,
            workspaceID: query.workspace,
            limit: ctx.query.limit ?? DefaultSessionsLimit,
          })
          const sessions = page.data
          const first = sessions[0]
          const last = sessions.at(-1)
          return {
            data: sessions,
            cursor: {
              previous: first
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: first.id,
                      time: DateTime.toEpochMillis(first.time.updated),
                      direction: "previous",
                    },
                  })
                : undefined,
              next: last
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: last.id,
                      time: DateTime.toEpochMillis(last.time.updated),
                      direction: "next",
                    },
                  })
                : undefined,
            },
          }
        }),
      )
      .handle(
        "session.create",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .create(
                ctx.payload.parentID
                  ? {
                      id: ctx.payload.id,
                      parentID: ctx.payload.parentID,
                      agent: ctx.payload.agent,
                      model: ctx.payload.model,
                    }
                  : {
                      id: ctx.payload.id,
                      agent: ctx.payload.agent,
                      model: ctx.payload.model,
                      location: ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) },
                    },
              )
              .pipe(Effect.mapError(mapSessionNotFound)),
          }
        }),
      )
      .handle(
        "session.active",
        Effect.fn(function* () {
          const active = yield* session.active
          return {
            data: Object.fromEntries(Array.from(active, (sessionID) => [sessionID, { type: "running" as const }])),
          }
        }),
      )
      .handle(
        "session.get",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.get(ctx.params.sessionID).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.diagnostics",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.diagnostics(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.MessageDecodeError", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to decode session message for cache diagnostics").pipe(
                  Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.autonomy.get",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.autonomy.get(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.autonomy.set",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.autonomy.set({ sessionID: ctx.params.sessionID, ...ctx.payload }).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.remove",
        Effect.fn(function* (ctx) {
          yield* session.remove(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.subagent.list",
        Effect.fn(function* (ctx) {
          return { data: yield* orchestration.list(ctx.params.parentID).pipe(Effect.mapError(mapSessionNotFound)) }
        }),
      )
      .handle(
        "session.subagent.launch",
        Effect.fn(function* (ctx) {
          const parent = yield* session.get(ctx.params.parentID).pipe(Effect.mapError(mapSessionNotFound))
          const prepared = yield* SessionOrchestration.preflight(parent, {
            agent: AgentV2.ID.make(ctx.payload.agent),
            model: ctx.payload.model,
          }).pipe(Effect.mapError(mapLaunchError))
          return {
            data: yield* orchestration
              .launch({
                parentID: ctx.params.parentID,
                parentAssistantMessageID: ctx.payload.parentAssistantMessageID,
                toolCallID: ctx.payload.toolCallID,
                agent: AgentV2.ID.make(ctx.payload.agent),
                description: ctx.payload.description,
                prompt: ctx.payload.prompt,
                background: ctx.payload.background === true,
                model: ctx.payload.model,
                prepared,
              })
              .pipe(Effect.mapError(mapLaunchError)),
          }
        }),
      )
      .handle(
        "session.subagent.message",
        Effect.fn(function* (ctx) {
          return {
            data: yield* orchestration
              .send({
                parentID: ctx.params.parentID,
                childID: ctx.params.childID,
                messageID: ctx.payload.messageID,
                text: ctx.payload.text,
                delivery: ctx.payload.delivery,
              })
              .pipe(Effect.mapError(mapControlError)),
          }
        }),
      )
      .handle(
        "session.subagent.answer",
        Effect.fn(function* (ctx) {
          return {
            data: yield* orchestration
              .answer({
                parentID: ctx.params.parentID,
                childID: ctx.params.childID,
                questionID: ctx.params.questionID,
                text: ctx.payload.text,
                data: ctx.payload.data,
              })
              .pipe(Effect.mapError(mapAnswerError)),
          }
        }),
      )
      .handle(
        "session.subagent.cancel",
        Effect.fn(function* (ctx) {
          return {
            data: yield* orchestration
              .cancel({ parentID: ctx.params.parentID, childID: ctx.params.childID })
              .pipe(Effect.mapError(mapControlError)),
          }
        }),
      )
      .handle(
        "session.subagent.resume",
        Effect.fn(function* (ctx) {
          return {
            data: yield* orchestration
              .resume({ parentID: ctx.params.parentID, childID: ctx.params.childID })
              .pipe(Effect.mapError(mapControlError)),
          }
        }),
      )
      .handle(
        "session.todo.list",
        Effect.fn(function* (ctx) {
          const todo = yield* SessionTodo.Service
          return { data: yield* todo.get(ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.todo.update",
        Effect.fn(function* (ctx) {
          const todo = yield* SessionTodo.Service
          yield* todo.update({ sessionID: ctx.params.sessionID, todos: ctx.payload.todos })
          return { data: ctx.payload.todos }
        }),
      )
      .handle(
        "session.fork",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.fork({ sessionID: ctx.params.sessionID, messageID: ctx.payload.messageID }).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.MessageNotFoundError",
                (error) =>
                  new MessageNotFoundError({
                    sessionID: error.sessionID,
                    messageID: error.messageID,
                    message: `Message not found: ${error.messageID}`,
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.switchAgent",
        Effect.fn(function* (ctx) {
          yield* session.switchAgent({ sessionID: ctx.params.sessionID, agent: ctx.payload.agent }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.switchModel",
        Effect.fn(function* (ctx) {
          yield* session.switchModel({ sessionID: ctx.params.sessionID, model: ctx.payload.model }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.rename",
        Effect.fn(function* (ctx) {
          yield* session.rename({ sessionID: ctx.params.sessionID, title: ctx.payload.title }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.move",
        Effect.fn(function* (ctx) {
          yield* session
            .move({
              sessionID: ctx.params.sessionID,
              directory: ctx.payload.directory,
              workspaceID: ctx.payload.workspaceID,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.DestinationNotFoundError", (error) =>
                Effect.fail(new InvalidRequestError({ message: `Directory does not exist: ${error.directory}` })),
              ),
              Effect.catchTag("Session.DestinationNotDirectoryError", (error) =>
                Effect.fail(new InvalidRequestError({ message: `Not a directory: ${error.directory}` })),
              ),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.prompt",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .prompt({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                text: ctx.payload.text,
                files: ctx.payload.files,
                agents: ctx.payload.agents,
                metadata: ctx.payload.metadata,
                delivery: ctx.payload.delivery,
                resume: ctx.payload.resume,
              })
              .pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
                Effect.catchTag("Session.PromptConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                      resource: error.messageID,
                    }),
                  ),
                ),
                Effect.catchTag("Session.AttachmentError", (error) =>
                  Effect.fail(new InvalidRequestError({ message: error.message, field: "files" })),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.command",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .command({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                command: ctx.payload.command,
                arguments: ctx.payload.arguments,
                agent: ctx.payload.agent,
                model: ctx.payload.model,
                files: ctx.payload.files,
                agents: ctx.payload.agents,
                delivery: ctx.payload.delivery,
                resume: ctx.payload.resume,
              })
              .pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
                Effect.catchTag("Command.NotFoundError", (error) =>
                  Effect.fail(
                    new CommandNotFoundError({
                      command: error.command,
                      message: error.message,
                    }),
                  ),
                ),
                Effect.catchTag("Command.EvaluationError", (error) =>
                  Effect.fail(
                    new CommandEvaluationError({
                      command: error.command,
                      message: error.message,
                    }),
                  ),
                ),
                Effect.catchTag("Session.PromptConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                      resource: error.messageID,
                    }),
                  ),
                ),
                Effect.catchTag("Session.AttachmentError", (error) =>
                  Effect.fail(new InvalidRequestError({ message: error.message, field: "files" })),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.skill",
        Effect.fn(function* (ctx) {
          yield* session
            .skill({
              sessionID: ctx.params.sessionID,
              id: ctx.payload.id,
              skill: ctx.payload.skill,
              resume: ctx.payload.resume,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.SkillNotFoundError", (error) =>
                Effect.fail(new SkillNotFoundError({ skill: error.skill, message: `Skill not found: ${error.skill}` })),
              ),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.skills",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.skills(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) => Effect.fail(mapSessionNotFound(error))),
              Effect.catchTags({
                "Session.AgentNotFoundError": Effect.die,
                "Session.MessageDecodeError": Effect.die,
              }),
            ),
          }
        }),
      )
      .handle(
        "session.resolveSkillConflict",
        Effect.fn(function* (ctx) {
          yield* resolveSkillConflict(session, {
            sessionID: ctx.params.sessionID,
            winner: ctx.payload.winner,
            loser: ctx.payload.loser,
          })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.synthetic",
        Effect.fn(function* (ctx) {
          const data = yield* session
            .synthetic({
              id: ctx.payload.id,
              sessionID: ctx.params.sessionID,
              text: ctx.payload.text,
              description: ctx.payload.description,
              metadata: ctx.payload.metadata,
              delivery: ctx.payload.delivery,
              resume: ctx.payload.resume,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.SyntheticConflictError", (error) =>
                Effect.fail(
                  new ConflictError({
                    message: `Synthetic input ID conflicts with an existing durable record: ${error.inputID}`,
                    resource: error.inputID,
                  }),
                ),
              ),
            )
          return { data }
        }),
      )
      .handle(
        "session.shell",
        Effect.fn(function* (ctx) {
          yield* session
            .shell({ sessionID: ctx.params.sessionID, id: ctx.payload.id, command: ctx.payload.command })
            .pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag(
                "ShellSandbox.Unavailable",
                (error) => new ServiceUnavailableError({ message: error.message, service: "shell-sandbox" }),
              ),
              Effect.catchTag("Shell.SpawnError", (error) => new InvalidRequestError({ message: error.message })),
              Effect.catchTag(
                "Guardrail.BlockedError",
                (error) => new InvalidRequestError({ message: error.reason, kind: "guardrail" }),
              ),
              Effect.catchTag(
                "Guardrail.DeclinedError",
                () => new InvalidRequestError({ message: "Session guardrail review was rejected", kind: "guardrail" }),
              ),
              Effect.catchTag(
                "Guardrail.CapExceededError",
                (error) =>
                  new ServiceUnavailableError({
                    message: `Session guardrail cap exceeded: ${error.counter} ${error.current}/${error.limit}`,
                    service: "guardrail",
                  }),
              ),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.compact",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.compact({ sessionID: ctx.params.sessionID, id: ctx.payload.id }).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.CompactionConflictError", (error) =>
                Effect.fail(
                  new ConflictError({
                    message: `Compaction input ID conflicts with an existing durable record: ${error.inputID}`,
                    resource: error.inputID,
                  }),
                ),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.wait",
        Effect.fn(function* (ctx) {
          yield* session.wait(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.stage",
        Effect.fn(function* (ctx) {
          yield* Effect.log("session.revert.stage", {
            sessionID: ctx.params.sessionID,
            messageID: ctx.payload.messageID,
            files: ctx.payload.files,
          })
          return {
            data: yield* session.revert.stage({ ...ctx.params, ...ctx.payload }).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.MessageNotFoundError",
                (error) =>
                  new MessageNotFoundError({
                    sessionID: error.sessionID,
                    messageID: error.messageID,
                    message: `Message not found: ${error.messageID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.BusyError",
                (error) =>
                  new SessionBusyError({
                    sessionID: error.sessionID,
                    message: `Session is busy: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag("Snapshot.Error", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to stage session revert", { cause: error }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({
                        message: "Unexpected server error. Check server logs for details.",
                        ref,
                      }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.revert.clear",
        Effect.fn(function* (ctx) {
          yield* Effect.log("session.revert.clear", { sessionID: ctx.params.sessionID })
          yield* session.revert.clear(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag(
              "Session.BusyError",
              (error) =>
                new SessionBusyError({
                  sessionID: error.sessionID,
                  message: `Session is busy: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag("Snapshot.Error", (error) => {
              const ref = `err_${crypto.randomUUID().slice(0, 8)}`
              return Effect.logError("failed to clear session revert", { cause: error }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new UnknownError({
                      message: "Unexpected server error. Check server logs for details.",
                      ref,
                    }),
                  ),
                ),
              )
            }),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.commit",
        Effect.fn(function* (ctx) {
          yield* Effect.log("session.revert.commit", { sessionID: ctx.params.sessionID })
          yield* session.revert.commit(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag(
              "Session.BusyError",
              (error) =>
                new SessionBusyError({
                  sessionID: error.sessionID,
                  message: `Session is busy: ${error.sessionID}`,
                }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.context",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.context(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.MessageDecodeError", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to decode session message").pipe(
                  Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.pending.list",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.pending(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.instructions.entry.list",
        Effect.fn(function* (ctx) {
          const instructions = yield* InstructionEntry.Service
          return { data: yield* instructions.list(ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.instructions.entry.put",
        Effect.fn(function* (ctx) {
          const instructions = yield* InstructionEntry.Service
          yield* instructions.put({ sessionID: ctx.params.sessionID, key: ctx.params.key, value: ctx.payload.value })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.instructions.entry.remove",
        Effect.fn(function* (ctx) {
          const instructions = yield* InstructionEntry.Service
          yield* instructions.remove({ sessionID: ctx.params.sessionID, key: ctx.params.key })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.generate",
        Effect.fn(function* (ctx) {
          const text = yield* session.generate({ sessionID: ctx.params.sessionID, prompt: ctx.payload.prompt }).pipe(
            Effect.mapError((error) =>
              error._tag === "Session.NotFoundError"
                ? new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  })
                : new ServiceUnavailableError({ message: error.message, service: "session generation" }),
            ),
          )
          return { data: { text } }
        }),
      )
      .handle(
        "session.log",
        Effect.fn((ctx) =>
          Effect.succeed(
            session
              .log({ sessionID: ctx.params.sessionID, after: ctx.query.after, follow: ctx.query.follow })
              .pipe(
                Stream.filter((item) => item.type === "log.synced" || isPublicDurableSessionEvent(item)),
                Stream.orDie,
              ),
          ),
        ),
      )
      .handle(
        "session.interrupt",
        Effect.fn(function* (ctx) {
          yield* session.interrupt(ctx.params.sessionID)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.background",
        Effect.fn(function* (ctx) {
          yield* session.background(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.message",
        Effect.fn(function* (ctx) {
          const message = yield* session.message(ctx.params)
          if (message) return { data: message }
          return yield* new MessageNotFoundError({
            sessionID: ctx.params.sessionID,
            messageID: ctx.params.messageID,
            message: `Message not found: ${ctx.params.messageID}`,
          })
        }),
      )
  }),
)

const mapSessionNotFound = (error: SessionV2.NotFoundError) =>
  new SessionNotFoundError({ sessionID: error.sessionID, message: `Session not found: ${error.sessionID}` })

export const resolveSkillConflict = (
  session: SessionV2.Interface,
  input: Parameters<SessionV2.Interface["resolveSkillConflict"]>[0],
) =>
  session.resolveSkillConflict(input).pipe(
    Effect.catchTag("Session.NotFoundError", (error) => Effect.fail(mapSessionNotFound(error))),
    Effect.catchTag("Session.SkillConflictNotFoundError", () =>
      Effect.fail(new SkillConflictNotFoundError({ message: "Skill conflict not found" })),
    ),
    Effect.catchTags({
      "Session.AgentNotFoundError": Effect.die,
      "Session.MessageDecodeError": Effect.die,
    }),
  )

function mapOwnershipError(error: SessionOrchestration.OwnershipError) {
  if (error._tag === "Session.NotFoundError") return mapSessionNotFound(error)
  if (error._tag === "SessionOrchestration.NotFoundError")
    return new SessionNotFoundError({ sessionID: error.childID, message: `Session not found: ${error.childID}` })
  return new ForbiddenError({ message: `Session ${error.childID} is not a direct managed child of ${error.parentID}` })
}

function mapLaunchError(error: SessionOrchestration.LaunchError | SessionOrchestration.InvalidRequestError) {
  if (error._tag === "Session.NotFoundError") return mapSessionNotFound(error)
  if (error._tag === "SessionOrchestration.ConflictError") return new ConflictError({ message: error.message })
  return new InvalidRequestError({ message: error.message })
}

function mapControlError(error: SessionOrchestration.ControlError) {
  if (error._tag === "SessionOrchestration.ConflictError") return new ConflictError({ message: error.message })
  return mapOwnershipError(error)
}

function mapAnswerError(error: SessionOrchestration.AnswerError) {
  if (error._tag === "SessionOrchestration.QuestionNotFoundError")
    return new QuestionNotFoundError({
      requestID: error.questionID,
      message: `Question not found: ${error.questionID}`,
    })
  if (error._tag === "SessionOrchestration.InvalidRequestError")
    return new InvalidRequestError({ message: error.message })
  return mapControlError(error)
}
