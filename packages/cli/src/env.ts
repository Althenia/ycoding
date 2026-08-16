import { Config } from "effect"

// Every environment variable the CLI reads, in one place. Consumers yield
// these instead of touching process.env so the full surface stays visible,
// typed, and redacted where secret.

// The ycoding server password: sent by clients connecting to an explicit
// --server, and adopted by a manually run or standalone server. The legacy
// name is still honored.
export const password = Config.redacted("YCODING_PASSWORD").pipe(
  Config.orElse(() => Config.redacted("YCODING_SERVER_PASSWORD")),
  Config.withDefault(undefined),
)

export * as Env from "./env"
