# Keep machine awake

## Changed

- macOS Keep machine awake holds display and idle system sleep and renews a native user-activity assertion every second, independently of shared lid-control ownership.
- TUI Status and web Settings → Machine report display and activity separately, including errors and unsupported parts.
- Activity confirms native assertion success, not an unlocked screen or guaranteed automatic-lock prevention. Deliberate locks and managed security policy remain effective.
