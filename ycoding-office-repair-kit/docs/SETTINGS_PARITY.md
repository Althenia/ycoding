# Settings, selection and TUI parity

The TUI is the functional baseline, not a layout template. The original request requires appropriate desktop equivalents, not every feature visible in another application's screenshot. Current TUI behavior and desktop gaps are **unverified** until local inspection.

## Build a settings inventory from source

For each candidate setting identify: current TUI interaction, schema/config owner, public read/write route, scope (global/project/session/agent/desktop), precedence, effective-value readback, validation, apply timing, restart behavior and required tests. Record a supported/unsupported/unknown capability, not a guess. Add no-op controls nowhere.

| Group | Audit and implement where actually supported |
|---|---|
| Providers / credentials | Existing provider setup mechanism, configured/available status, validation, safe credential update flow, connectivity diagnostics |
| Model defaults / active model | Scope-aware default vs session selection, catalog errors, actual request selection and persistence |
| Reasoning / effort | Model/runtime capability lookup, exact supported values, effective selection, reset semantics; omit unsupported invented controls |
| Runtime behavior | Existing autonomy, permission, queue/steer or similar controls with correct mediation; guardrails are not a generic access toggle |
| Appearance | Light/dark/system where supported, effective UI scale, office zoom separately, reduced motion and motion speed if implemented |
| Workspace / session | Existing location, navigation/history preferences and valid startup behavior |
| Keyboard | Current shortcuts and applicable graphical equivalents; avoid conflicts with text input/IME |
| Integrations | Existing YCoding integrations only, with a working management path; do not clone unrelated settings pages |

Provider/key state remains in its authoritative store. Desktop layout/theme preferences can be local. Do not create competing config layers. Display inheritance/scope; when an environment override wins, say so instead of claiming a saved UI value is effective.

## Model picker details

Group by actual provider; search if the list warrants it; handle long names, keyboard and focus; represent unavailable/missing configuration explicitly. Selection is not confirmed until the supported write/apply path and effective value agree. Preserve existing session behavior on provider errors. An effort choice must be legal for the selected model; changing models revalidates it. The supplied “Medium” reference is a visual example, not a hardcoded universal setting.

## Functional parity audit

Start from [tracking/tui_parity.json](../tracking/tui_parity.json). Inspect TUI components/controllers, runtime routes and relevant tests. Add all discovered capabilities needed for the desktop. For each row record source path/symbol, tested behavior, desktop equivalent, gap, decision and evidence. Absence in one search result is not proof of absence.

Minimum required: new session, prompt, response/stream, provider/model, tools, permissions/reviews, session/history, settings, error, cancellation, keyboard and office representation. Conditional capabilities—attachments, queueing, additional model options—must be implemented when part of the required TUI workflow or explicitly resolved, not silently removed because integration is difficult.

## Settings acceptance

Open via mouse and keyboard; tab order sensible; current effective values load; validation errors show inline; successful save uses owner/readback; cancel does not mutate; scope and restart requirement are clear; settings survive restart; returning to office preserves draft/session. Verify dark/light and high-scale forms for clipping. Each visible control needs a behavior test; “the scene contains a button” is not completion.

## Complete inventory

The expanded field-level contract is in [ALL_SETTINGS.md](ALL_SETTINGS.md) and [SETTINGS_CATALOG.md](SETTINGS_CATALOG.md). The smaller table above is only a navigation overview; it does not limit coverage. Run the schema coverage gate and audit the entire current TUI command registry before accepting settings parity.
