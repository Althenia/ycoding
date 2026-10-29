import { Flag } from "effect/unstable/cli"
import { Spec } from "../framework/spec"
import { ServerParams } from "./run"

export const DecisionCommand = Spec.make("decision", {
  description: "Inspect pending decisions across all Sessions and Locations",
  commands: [Spec.make("list", {
    description: "List pending decisions and their exact API commands",
    params: { ...ServerParams, json: Flag.boolean("json").pipe(Flag.withDefault(false)) },
  })],
})

export function shellCommand(argv: readonly string[]) {
  return argv.map((arg) => /^[A-Za-z0-9_./=:-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`).join(" ")
}
