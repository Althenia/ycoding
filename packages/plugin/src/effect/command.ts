import type { CommandApi } from "@ycoding-ai/client/effect/api"
import type { Command } from "@ycoding-ai/schema/command"
import type { Effect } from "effect"
import type { Mutable } from "./mutable.js"
import type { Transform } from "./registration.js"

type CommandInfo = Omit<Mutable<Command.Info>, "locations"> & { locations?: Command.Info["locations"] }

export interface CommandDraft {
  list(): readonly CommandInfo[]
  get(name: string): CommandInfo | undefined
  update(name: string, update: (command: CommandInfo) => void): void
  remove(name: string): void
}

export interface CommandDomain extends CommandApi<unknown> {
  readonly transform: Transform<CommandDraft>
  readonly reload: () => Effect.Effect<void>
}
