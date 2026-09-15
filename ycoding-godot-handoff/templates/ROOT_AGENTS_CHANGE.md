# Root guide migration brief — do not replace the file

Read the actual root AGENTS.md and relevant docs. Apply the smallest coherent edit reflecting the user's new approved surface. Retain unrelated runtime, testing, style, ownership and safety rules.

Suggested meaning to adapt to the current wording:

> The TUI remains supported. A native Godot desktop client is an explicitly approved additional presentation surface and is initially in development. Both clients use the existing public YCoding service contracts. The Godot office is a read-model/interaction presentation, not an orchestration or persistence authority. Do not restore legacy Electron, browser, console or website products as part of this work.

Update root README/product-direction/architecture status consistently. Document where the native project lives, its scoped guide and verification commands. Preserve the JS package allowlist; add narrowly scoped native project verification. Do not mark the desktop “implemented” until its acceptance gates actually pass.

Evidence: policy diff, guardrail check and unchanged relevant TUI/backend regressions. No wholesale root-file overwrite.
