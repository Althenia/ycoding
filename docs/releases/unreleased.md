# Unreleased

## Added

- Connect approved MCP clients to an enrolled machine through relay-issued OAuth and explicit owner consent. Relay MCP provides Session controls, including creation in existing directories strictly below home, while retaining runtime permission and guardrail enforcement.
- Enable or disable Relay MCP with `ycoding remote mcp on|off|status` or the TUI's Relay MCP control. Access starts disabled; disabling it revokes client grants. Relay deployment requires the MCP authorization migration and an additional Google callback URI described in the deployment guide.

## Changed

- Keep machine-awake status in the TUI command palette and Status dialog without a duplicate line beneath the composer.
