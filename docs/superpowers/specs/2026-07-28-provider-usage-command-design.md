# Provider Usage Command Design

## Goal

Move provider quota and credit reporting out of persistent session chrome and into a dedicated **Provider Usage** command-palette menu. The command reports usage only for providers used by currently running sessions in the current session family.

## Scope

- Add a `Provider Usage` command to the session command palette.
- Hide the command unless at least one currently running root or subagent session uses a provider that supports usage inquiry.
- Open a dedicated dialog that renders one section per unique active provider.
- Remove the existing provider-usage sidebar plugin and its sidebar tests.
- Preserve the existing provider usage API, normalization, cache, and formatting utilities unless a focused extraction is required for reuse.

## Active Provider Selection

The current session family is the root session plus all loaded descendants returned by `data.session.family(route.sessionID)`.

A session contributes a provider only when:

1. `data.session.status(sessionID) === "running"`.
2. The session has `model.providerID`.
3. The provider usage service returns a snapshot whose status is not `unsupported`.

Provider IDs are deduplicated before rendering. Parallel sessions using the same provider share one provider row. The system does not add, average, or otherwise combine quota percentages across sessions because provider usage is account-level rather than session-level.

The current product configures one selected credential per provider; session metadata does not select separate credentials. Therefore provider ID is the correct UI-level deduplication key. The core provider usage cache continues to single-flight requests by `providerID:credentialID`.

## Command Visibility

The command uses ID `session.provider-usage` and title `Provider Usage` in the `Session` command group.

The command is registered only when the active-provider probe contains at least one snapshot with status `available`, `stale`, `unauthorized`, or `error`.

Visibility behavior:

- `unsupported`: omit the provider and do not count it toward command visibility.
- `available`: show the provider and its windows.
- `stale`: show the last known windows and stale status.
- `unauthorized`: show the provider with `Usage unavailable`.
- `error`: show the provider with `Usage unavailable`.
- No qualifying snapshots: hide the command.
- Initial unresolved probe: hide the command.

## Data Flow

A session-level controller derives unique provider IDs reactively from the current session family and running statuses. It probes each unique provider through `client.providerUsage.get({ providerID })` without forcing refresh.

The controller stores results by provider ID and guards asynchronous settlement with a generation token so results for a previous session family or provider set cannot re-enable the command after navigation or status changes.

Opening the dialog refreshes the currently active provider set with `refresh: true`. The core cache single-flights concurrent refreshes for the same provider and selected credential. The dialog keeps the previous snapshot while refreshing and replaces it only with the latest completed result.

## Dialog

Create a focused `ProviderUsageDialog` component. It renders provider sections directly rather than using selectable fake command rows.

Each available or stale provider section contains:

- provider label;
- freshness/stability status;
- one row per usage window;
- a progress bar for percentage windows;
- formatted usage values;
- reset timing where reported;
- provider message where relevant.

Unauthorized and error snapshots render the provider label plus exactly `Usage unavailable`.

The dialog title is `Provider Usage`. Closing follows normal dialog behavior. No provider row is interactive.

## Sidebar Removal

Delete the `internal:sidebar-provider-usage` built-in registration and remove its sidebar component. Provider usage must not appear in the main-session sidebar or subagent footer after this change.

## Concurrency and Correctness

- Deduplicate active sessions by provider ID before API calls.
- Rely on the existing core cache for credential-level single-flight behavior.
- Use a UI generation token to discard stale asynchronous probe and refresh results.
- Never sum provider usage across sessions.
- Recompute visibility when a family member starts, stops, changes model, is created, or is deleted through existing reactive session data.

## Testing

Add tests for:

1. Active-provider derivation includes only running family sessions and deduplicates provider IDs.
2. Unsupported snapshots are omitted and hide the command when no other provider qualifies.
3. Available, stale, unauthorized, and error snapshots make the command visible.
4. Unauthorized and error providers render `Usage unavailable`.
5. Percentage windows render progress bars and reset labels in the dedicated dialog.
6. A stale async result cannot overwrite a newer provider set.
7. The sidebar built-in no longer registers provider usage.

Run the focused TUI tests, TUI typecheck, full TUI test suite, root typecheck, lint, workspace boundary check, brand residual check, and generated-client drift check.
