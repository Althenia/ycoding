import { Config } from "@ycoding-ai/core/config"
import { Effect } from "effect"

/**
 * A read-only `Config.Service` double for tests that only consume `entries()`. Write paths are
 * unreachable in those tests, so they fail loudly rather than returning fabricated results.
 */
export function stubConfig(input: Pick<Config.Interface, "entries">): Config.Interface {
  return {
    ...input,
    read: () => Effect.die("unused Config.read"),
    preview: () => Effect.die("unused Config.preview"),
    commit: () => Effect.die("unused Config.commit"),
  }
}
