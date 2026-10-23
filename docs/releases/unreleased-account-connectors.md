# Unreleased account connectors

## Added

- Opt-in ChatGPT and Claude account connector tools in Sessions through hosted MCP. Each provider is disabled by default and selects an existing YCoding OAuth profile with per-connector allow and deny policies.
- Request-local tool schemas and executors retain the selected account binding and recheck profile replacement, configuration disablement, and connector denial before dispatch. Actions ask by default and retain existing permission ceilings and Session guardrails.
- Claude organization-blocked tools stay unavailable. Organization-required approval and tools marked for user interaction require a fresh human decision; saved approvals and automation cannot approve them.

## Limitations

Connector availability depends on the account's hosted-service access and completed upstream authorization. Claude profiles require the `user:mcp_servers` grant. Connector setup and consent remain in ChatGPT or Claude; this path launches no native client, copies no external client's credentials, and uses no desktop cookies or native-client identity. Live account entitlement and catalog access remain unverified.
