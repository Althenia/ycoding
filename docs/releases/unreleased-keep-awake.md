# Keep machine awake

## Changed

- Keep machine awake holds both the display and the idle system awake on macOS in the Rust and Bun backends. Bun also renews a separate user-activity assertion every second. These holds do not depend on shared lid-control ownership.
- TUI Status and web Settings → Machine report display and activity separately, including errors and unsupported parts.
- Activity confirms native assertion success, not an unlocked screen or guaranteed automatic-lock prevention. Deliberate locks and managed security policy remain effective.
