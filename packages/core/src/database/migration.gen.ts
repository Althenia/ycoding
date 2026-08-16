import type { DatabaseMigration } from "./migration"

export const migrations = (
  await Promise.all([
    import("./migration/20260725062914_drop-application-cache"),
    import("./migration/20260726004318_self-improvement-generation-failure"),
    import("./migration/20260726160111_agentic-project-artifacts"),
    import("./migration/20260726182810_retire-self-improvement"),
    import("./migration/20260727000736_observation-session-identity"),
    import("./migration/20260727001011_observation-sessionless-identity"),
    import("./migration/20260728025034_dusty_havok"),
    import("./migration/20260728084114_provider-request-optional-cost"),
  ])
).map((module) => module.default) satisfies DatabaseMigration.Migration[]
