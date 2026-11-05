import { Effect, Schema } from "effect"

export const SessionScope = Schema.Literals(["bound", "standalone"])
export type SessionScope = typeof SessionScope.Type

export const SessionScopeWithDefault = SessionScope.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed("bound" as const)),
)
