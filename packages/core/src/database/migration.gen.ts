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
    import("./migration/20260801114207_drop-session-archived"),
    import("./migration/20260803004514_session-file-change-ledger"),
    import("./migration/20260803011247_session-usage"),
    import("./migration/20260804120956_selective-compaction-harness"),
    import("./migration/20260804123002_continuation-generation-fence"),
    import("./migration/20260804142728_session-authority-revisions"),
  ])
).map((module) => module.default) satisfies DatabaseMigration.Migration[]
