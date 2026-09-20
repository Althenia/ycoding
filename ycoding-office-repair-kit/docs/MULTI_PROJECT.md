# Multi-project and folder workspaces

Status: approved feature; proposed design pending local implementation. Source snapshot: ProjectGroup supports list/current/directories; LocationQuery is a deep-object query; Session creation can carry Location. This is not evidence of a finished desktop project switcher.

## Product model

One **project office** is the spatial view of one active folder/location. Keep one application window, a persistent left sidebar and one active office view. Other projects' agents continue in YCoding. Switching a view never stops or relocates a session. Open multiple folders as separate entries; a monorepo can group related folders under the same backend Project ID but must retain their distinct Location and branch/worktree context. A non-Git folder is valid. Do not invent a backend Workspace ID from a directory name.

Sidebar composition: New session; Office / Sessions / Statistics; Projects with recent and pinned folder entries; per-project running count and human-attention badge; Settings and connection status anchored at the bottom. New folder uses the native folder picker. Cmd/Ctrl+O opens it; Cmd/Ctrl+K searches projects and actions. Labels may shorten paths; tooltips and the composer target reveal the resolved absolute directory and branch. Renaming a sidebar label never renames a directory.

## Core flow

Open folder -> canonicalize local path -> resolve through existing location/project API -> display project/folder and trust status -> choose/reopen a root session -> load snapshot and current activity -> select office. A newly selected folder is not execution consent. Show the target beside the composer BEFORE enabling Send.

During a long run in A, switch to B, submit an unrelated task, see A's attention badge, visit A to answer it, then return to B with B's draft, selected model, camera and player position preserved. The user can open Sessions or Statistics without canceling either run. Recent/pinned projects, drafts and camera preferences persist locally; durable messages remain server-owned.

## State and identity

Maintain DesktopProjectEntry(local_entry_id, canonical_directory, resolved_project_id, resolved_location, display_name, pin_order, last_opened), with runtime IDs opaque. Scope every request, response and cache entry by **service identity + location + session ID**. Do not use provider/model/agent name as a session cache key. Resolve symlinks before deduplication; respect host case sensitivity; do not lowercase all paths. Two worktrees of the same project remain separate locations. Removal from recents never deletes files, credentials or history.

UIViewState(entry_id, selected_session_id, unsent_draft, selected_actor_id, camera_state, player_position, view_route) is disposable desktop data, not runtime authority. Validate saved player position against the current map; recover to an unblocked spawn. No tokens/credentials in this object. Use an atomic, schema-versioned desktop preference store with a recovery path for corrupt data.

## Switch transaction

1. Save current draft/view state and clear movement keys. Increment a view generation number.
2. Resolve selected folder and load its canonical state. Keep the new target visible during loading.
3. Apply responses only to the matching cache key/generation; late results for A may refresh A but must never repaint B.
4. Render current actor statuses, not a replay of every historic walk. Restore navigation and safe player/camera state.
5. Re-enable actions when the verified target is ready. Never change an in-flight prompt's captured target.

The Send action captures session/location/model once. If a new-session response arrives after switching projects, attach it only to its original project. Do not resubmit a timed-out request with a fresh message ID. Stop and approval always target the displayed explicit session/family, including background-project alerts.

## Scope rules

Runtime global configuration follows YCoding's discovery/precedence. Folder/project overrides apply to the matching Location. An active session model choice is not automatically a global default. Settings show Global / Project: name / Folder: path / Session when applicable; only implement scopes the owner supports. “All projects” in Statistics aggregates data without expanding any agent's filesystem permissions.

Multi-root execution in a single session is NOT silently invented: use the existing references/context mechanism and explicit permissions, or separate sessions. Moving an existing session to a different directory requires a supported runtime operation and confirmation, never updating only a UI label.

## Acceptance scenarios

Two independent repos and one plain folder; nested monorepo folder; symlink duplicate; two worktrees; path containing spaces/non-ASCII; missing/read-only folder; reconnect; renamed folder; no accessible location; A/B response race; unsent draft per project; settings override readback; aggregate statistics isolation; background approval and stop; reopening the app. Verify requests with sanitized Location traces and native UI captures. No cross-project transcript or credential bleed.
