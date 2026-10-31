import { Argument, Flag } from "effect/unstable/cli"
import { Spec } from "../framework/spec"
import { ServerParams } from "./run"

export const watchTimeout = 300

export const DecisionCommand = Spec.make("decision", {
  description: "Inspect pending decisions across all Sessions and Locations",
  commands: [Spec.make("list", {
    description: "List pending decisions and their exact API commands",
    params: { ...ServerParams, json: Flag.boolean("json").pipe(Flag.withDefault(false)) },
  }), Spec.make("watch", {
    description: "Wait until a Session needs a decision or its execution settles",
    params: {
      ...ServerParams,
      session: Argument.string("session").pipe(Argument.withDescription("Session ID to watch")),
      input: Flag.string("input").pipe(Flag.withDescription("Admitted input ID whose execution completes the watch"), Flag.optional),
      after: Flag.integer("after").pipe(Flag.withDescription("Read Session events after this sequence"), Flag.optional),
      family: Flag.boolean("family").pipe(Flag.withDescription("Watch root work and descendant execution and decisions"), Flag.withDefault(false)),
      checkpoint: Flag.string("checkpoint").pipe(Flag.withDescription("Resume a family watch from its checkpoint"), Flag.optional),
      timeout: Flag.integer("timeout").pipe(Flag.withDescription("Seconds to wait before reporting progress (1-3600)"), Flag.withDefault(watchTimeout)),
      json: Flag.boolean("json").pipe(Flag.withDefault(false)),
    },
  })],
})

export function shellCommand(argv: readonly string[]) {
  return argv.map((arg) => /^[A-Za-z0-9_./=:-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`).join(" ")
}
