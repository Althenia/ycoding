# Mock/demo reachability audit

The user explicitly forbids production fallback to fake responses or simulated work. The current supplied screenshot shows synthetic playback, but it does not prove all production paths select it. Inspect startup and fallbacks to establish reachability.

Search relevant desktop/runtime code for demo, mock, fixture, fake, stub, sample, placeholder, hardcoded response, simulated streaming, seed responses and fallback mode. The kit scanner returns **candidates only**. Review every production-relevant path and classify it:

- `test_only`: isolated test data/tools; retain where useful.
- `development_only`: explicit developer harness not reachable from normal production startup; verify export/launch boundaries.
- `production_reachable`: normal startup, failed connection, missing credentials or menu action can substitute fake work; repair/remove the inappropriate path.
- `false_positive`: harmless word, documentation/example or unrelated stub; retain with rationale.
- `unknown`: not yet traced; cannot close the audit.

Record file/symbol/line, entrypoint/call chain, default/export behavior, action, tests and evidence in `tracking/mock_audit.json`. Reachability proof matters more than keyword count. Do not delete legitimate tests to make a grep empty.

A live startup failure must remain a visible configuration/connection/provider error. Development playback must never share production session storage or report fake messages as real. Prior demo assets/scenarios can stay in isolated tests or developer tools, but production packaging must not auto-load them. Removing a DEMO label while retaining synthetic execution is not a repair.

Verification: native normal launch; deliberately missing service; missing/invalid credentials; provider unavailable/error; restart with no existing session. Each must show truthful empty/error/pending states, never a populated fake office workflow. Include an integration assertion that production mode cannot select a replay provider through its failure path.
