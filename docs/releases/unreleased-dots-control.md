# Dots device decisions

## Added

- Authenticated Dots device grants authorize selected task and typed decision operations across nonarchived device-owned Sessions. Decisions carry client provenance and require exact native candidates; grants end on revocation, unbinding, or OAuth expiry.
- MCP progress and blocker notifications are captured immediately, deduplicated, and reconciled. Web and TUI conversation views identify client-originated decisions.

## Changed

- Decision settlement retains explicit denies, permission ceilings, ownership, binding, revocation, and at-most-once checks. Room and prompt text cannot authorize decisions.
