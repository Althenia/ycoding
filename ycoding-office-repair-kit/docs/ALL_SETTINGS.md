# Settings completeness contract

“All settings” means every current user-facing YCoding capability gets an intentional desktop treatment, including advanced controls. It does not mean adding a no-op control for every schema key or copying unavailable features from another product. A source-audited catalog and a coverage check make omissions visible.

## Required inventory and gate

`tracking/settings_catalog.json` contains a starting field-level catalog derived from the pinned configuration reference, plus proposed desktop-only controls. Each entry records domain, field pattern, page, scope, treatment, source and verification. **All are pending local verification.** `tools/settings_coverage.py` compares exported runtime/TUI JSON Schemas with classified paths and fails on uncovered leaves. A wildcard only covers the actual record domain (e.g. provider settings), not unrelated top-level fields. The tool reports coverage, not implementation: a second `--require-verified` gate refuses rows without an audited consumer/evidence disposition. New keys and changed commands require review each release.

Locally generate current runtime schema through the existing Config.Info/Pages owner; inventory TUI config and the complete `packages/tui/src/config/keybind.ts` action registry too. Classify every discovered setting and every TUI action. Keep docs/source divergence visible. Fields accepted but ignored (`instructions`, deprecated `terminal.copy_on_select`) must not get misleading toggles. Removed keys stay removed. Terminal-only semantics get an explicit terminal-only explanation or a genuine desktop equivalent; do not silently delete them from the inventory.

## Sources of truth and edit ownership

Runtime configuration, `cli.json`, managed-service files, credential storage and desktop preferences are DIFFERENT surfaces. A dark/light desktop change must not rewrite all terminal preferences. Runtime settings preserve global/project/folder precedence, unknown valid extension data, comments, environment/file substitutions, and externally made edits. Saving must use a supported validated owner; Godot never opens the runtime database. The inspected desktop currently writes no runtime config, so full settings requires an explicit scoped settings read/write API or existing equivalent, not just UI rows.

Proposed narrow server setting service: read effective values + source provenance + editable source revision; validate a scoped patch; preview diff; commit with expected revision; return effective readback. Operation names and wire shapes are **proposed**, not asserted to exist. Locate current equivalents first. Keep secrets redacted, record-only dynamic options schema-aware, atomic writes and conflict handling. A multi-scope edit is not automatically transactional; save clearly per owner and report partial failure rather than fake all-success. Do not edit a live registration file. Environment-owned settings show the controlling variable name and require restart where applicable; never dump environment values.

`credential.update` in the inspected Protocol changes a LABEL; it is not an API-key update endpoint. Discover the actual integration/OAuth/key storage flow. Secret forms are write-only, masked, never auto-copied to logs or desktop preferences. “Disconnect” explains affected sessions; removing an account does not delete history. Test credentials using the selected account through the real service, not a browser-side provider call.

## Interaction contract for every editable setting

Show label, concise explanation, current effective value, source/scope badge, inherited/overridden state, supported range/options, restart/next-request timing and reset-to-inherited. Search by name and concept. Basic rows use toggles/selects/text; Advanced has schema-guided editors for records, arrays, request overlays, custom policies and source files. A supported setting is reachable without guessing a config path. Disallowed/unsupported values show an explanatory error, not silent fallback. Autosave must acknowledge pending/saved/failed state; grouped complex editors use Apply/Cancel and an unsaved-change prompt.

On save: validate -> persist via owner with concurrency check -> reread effective state -> confirm restart/runtime effect -> report success. Retest reload/restart, inherited override, global/project switch, invalid data, write failure and concurrent edit. No setting is “done” from a screenshot alone.

## Categories that cannot be omitted

General/startup/update; appearance/theme/text scale and independent office zoom; keybindings and input conflicts; notifications/sounds/ntfy; projects/folders/references; providers/auth/custom endpoints; models/variants/request parameters; agents/roles/step caps/autonomy; skills/commands/instructions; permissions/guardrails/custom safety rules; shell/sandbox/resource limits; MCP/auth/timeouts/codemode; plugins/hooks; browser/computer capability and OS permissions; attachments/vision; formatters/LSP/watchers; compaction/helper models/cache/continuation; conversations/diffs/paste; usage/quota/advisory/enforced-budget distinction; local service/diagnostics/data/privacy; advanced/runtime environment ownership. See the field-level catalog for the exact initial paths.

Do not invent voice, pets, theme packs, every external provider quota, browser capabilities on unsupported OSes, or a hard budget with no backend enforcement. Such omissions are classified with evidence, not hidden. Complete means every relevant live source item is implemented or explicitly classified with an honest user-visible alternative, and required missing functionality remains a blocking task.
