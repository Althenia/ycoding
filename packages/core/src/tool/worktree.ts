export * as WorktreeTool from "./worktree"

import path from "path"
import { ToolFailure } from "@ycoding-ai/ai"
import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { FSUtil } from "../fs-util"
import { Git } from "../git"
import { Global } from "../global"
import { Location } from "../location"
import { Permission } from "../permission"
import { ProjectCopy } from "../project/copy"
import { AbsolutePath } from "../schema"
import { Hash } from "../util/hash"
import { SessionGuardrail } from "../session/guardrail"
import { Tool } from "./tool"

export const name = "worktree"

const Name = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/))
export const Input = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({ action: Schema.Literal("create"), name: Name }),
]).pipe(Schema.toTaggedUnion("action"))

export const Output = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("list"),
    worktrees: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        branch: Schema.String.pipe(Schema.optional),
        current: Schema.Boolean,
      }),
    ),
  }),
  Schema.Struct({ action: Schema.Literal("create"), path: Schema.String, branch: Schema.String }),
]).pipe(Schema.toTaggedUnion("action"))

export const Plugin = {
  id: "ycoding.tool.worktree",
  effect: Effect.fn("WorktreeTool.Plugin")(function* (ctx: PluginContext) {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const copies = yield* ProjectCopy.Service
    const permission = yield* Permission.Service
    const guardrail = yield* SessionGuardrail.Service

    yield* ctx.tool
      .transform((draft) =>
        draft.add(
          name,
          Tool.withPermission(
            Tool.make({
              description:
                "List worktrees for the current Git repository or create a managed worktree on a named branch. Creation does not switch the current Session's Location. A later Session can use the returned path.",
              input: Input,
              output: Output,
              toModelOutput: ({ output }) => [
                {
                  type: "text",
                  text:
                    output.action === "list"
                      ? output.worktrees
                          .map(
                            (item) =>
                              `${item.current ? "Current" : "Worktree"}: ${item.path}${item.branch ? ` (${item.branch})` : " (detached HEAD)"}`,
                          )
                          .join("\n") || "No worktrees found"
                      : `Created worktree on branch ${output.branch} at ${output.path}`,
                },
              ],
              execute: (input, context) =>
                Effect.gen(function* () {
                  const source = { type: "tool" as const, messageID: context.messageID, callID: context.callID }
                  const repository = yield* git.repo
                    .discover(location.directory)
                    .pipe(
                      Effect.mapError(
                        (error) => new ToolFailure({ message: "Unable to inspect the current Git repository", error }),
                      ),
                    )
                  if (!repository)
                    return yield* new ToolFailure({ message: "The current Location is not inside a Git repository" })

                  if (input.action === "list") {
                    yield* permission
                      .assert({
                        action: name,
                        resources: [repository.worktree],
                        save: ["*"],
                        sessionID: context.sessionID,
                        agent: context.agent,
                        source,
                      })
                      .pipe(
                        Effect.mapError(
                          (error) => new ToolFailure({ message: "Unable to list worktrees: permission denied", error }),
                        ),
                      )
                    const entries = yield* git.worktree
                      .list(repository)
                      .pipe(
                        Effect.mapError(
                          (error) => new ToolFailure({ message: "Unable to list repository worktrees", error }),
                        ),
                      )
                    const currentDirectory = yield* fs.realPath(location.directory)
                    return {
                      action: "list" as const,
                      worktrees: yield* Effect.forEach(entries, (entry) =>
                        Effect.gen(function* () {
                          const found = yield* git.repo.discover(entry.directory)
                          return {
                            path: entry.directory,
                            ...(found ? { branch: yield* git.history.branch(found) } : {}),
                            current: FSUtil.contains(entry.directory, currentDirectory),
                          }
                        }),
                      ),
                    }
                  }

                  const parent = yield* fs.resolve(
                    path.join(
                      global.data,
                      "worktrees",
                      `repo_${Hash.sha256(yield* fs.realPath(repository.commonDirectory))}`,
                    ),
                  )
                  const target = path.join(parent, input.name)
                  yield* permission
                    .assert({
                      action: name,
                      resources: [target],
                      save: ["*"],
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source,
                    })
                    .pipe(
                      Effect.mapError(
                        (error) => new ToolFailure({ message: "Unable to create worktree: permission denied", error }),
                      ),
                    )
                  if (yield* fs.existsSafe(target))
                    return yield* new ToolFailure({ message: `A worktree named ${input.name} already exists` })
                  const reservation = yield* guardrail
                    .assert({
                      sessionID: context.sessionID,
                      action: "file_mutation",
                      resources: [target],
                      metadata: { operation: "create_git_worktree" },
                    })
                    .pipe(
                      Effect.mapError(
                        (error) => new ToolFailure({ message: "Session guardrail rejected worktree creation", error }),
                      ),
                    )
                  const result = yield* copies
                    .create({
                      projectID: location.project.id,
                      strategy: ProjectCopy.StrategyID.make("git_worktree"),
                      sourceDirectory: location.project.directory,
                      directory: AbsolutePath.make(parent),
                      name: input.name,
                      branch: input.name,
                    })
                    .pipe(
                      Effect.mapError(
                        (error) =>
                          new ToolFailure({
                            message:
                              error instanceof ProjectCopy.DestinationExistsError
                                ? `A worktree named ${input.name} already exists at ${error.directory}`
                                : error instanceof Git.WorktreeError &&
                                    /branch .* already exists|already exists/i.test(error.message)
                                  ? `A branch named ${input.name} already exists`
                                  : error instanceof ProjectCopy.StrategyUnavailableError
                                    ? `Git worktree strategy is unavailable: ${error.strategy}`
                                    : error instanceof ProjectCopy.SourceDirectoryNotFoundError ||
                                        error instanceof ProjectCopy.DirectoryUnavailableError
                                      ? `The current project directory is unavailable: ${error.directory}`
                                      : `Unable to create Git worktree: ${error.message}`,
                            error,
                          }),
                      ),
                      Effect.ensuring(reservation.release),
                    )
                  return { action: "create" as const, path: result.directory, branch: input.name }
                }).pipe(
                  Effect.mapError((error) =>
                    error instanceof ToolFailure
                      ? error
                      : new ToolFailure({ message: "Worktree operation failed", error }),
                  ),
                ),
            }),
            name,
          ),
          { codemode: false },
        ),
      )
      .pipe(Effect.orDie)
  }),
}
