# Unreleased

## Added

- Connect approved MCP clients to an enrolled machine through relay-issued OAuth and explicit owner consent. Relay MCP provides Session controls, including creation in existing directories strictly below home, while retaining runtime permission and guardrail enforcement.
- Enable or disable Relay MCP with `ycoding remote mcp on|off|status` or the TUI's Relay MCP control. Access starts disabled; disabling it revokes client grants. Relay deployment requires the MCP authorization migration and an additional Google callback URI described in the deployment guide.
- Review whole-window quota pace beside recent-use forecasts in the TUI and web Usage views, with Ahead, Cutting it close, and Will run out verdicts when the provider reports suitable fixed-reset limits.
- Receive quota warnings after worsening pace or less than 10% remaining, with a silent initial observation and independent web In app and System switches. Alerts require a reported future reset and open Usage on the originating machine. Matching alerts collapse across machines. Quota alerts require an updated connected machine and relay.

## Changed

- Keep machine-awake status in the TUI command palette and Status dialog without a duplicate line beneath the composer.

## Fixed

- Open Session and Usage alerts on the correct machine after its cached availability becomes stale, including repeated activation of the same alert. Unavailable machines remain explicit without opening another machine.
- Keep Usage reports and cached forecasts responsive while provider quotas refresh, and reduce loading time across large retained usage histories.
