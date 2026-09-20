# Local execution setup

Target supplied by the user: `/Users/viadz/Workspace/Project/ycoding`. Do not assume it is available in another environment. Use local filesystem access and a local terminal/agent; Secure files is optional once that environment has direct authorized access.

## Required capabilities

Existing checkout and its instructions, its pinned Godot editor/runtime, current project dependencies, the YCoding executable/service setup used by the TUI, and Python 3.10+ for this kit's tools. Use the existing project's lockfiles and owning package manager. Native desktop rendering/interaction must run on the host. A container can help isolated tests but does not by itself prove native GUI behavior.

The exact Godot version, desktop path, dependency install command, start command, package checks and export presets must be discovered in R0. Do not upgrade or install a framework to match this handoff. A missing optional MCP must not stop work that the editor/CLI/local agent can perform directly.

## Non-destructive inventory

```sh
REPO="/Users/viadz/Workspace/Project/ycoding"
KIT="/absolute/path/to/ycoding-office-repair-kit"
python3 -B "$KIT/tools/local_audit.py" --repo "$REPO" --out "$KIT/evidence/local-audit-01"
```

The audit includes bounded Git revision/status metadata and source candidate locations, not source/configuration values. It does not probe or execute Godot/Bun; use the separate delivery doctor and verified local commands after audit.

Then inspect discovered root/package guides, real startup/config scripts and test suites using the local agent. Run only the repository's documented owning commands after verifying them. Do not guess `bun test` at root; an earlier repository snapshot intentionally rejected it, and current behavior needs checking.

## Native evidence

Use the actual supported launch path and record cwd/arguments with secrets redacted. Capture the native window at relevant sizes and scale settings. A command like `godot --headless --path <discovered-project> --editor --quit` may be useful after checking version/side effects, but import changes are local build work and it is not a visual test. Do not use it as proof of compositor/input/Retina behavior.

Record the service process/environment origin when comparing TUI and desktop. Inspect only necessary credential presence and precedence via the supported mechanism. Never `printenv`, dump configuration stores or put keys on a command line/screenshot.

## ZIP and evidence use

This kit may be extracted anywhere outside the checkout. Keep a single authoritative task ledger. Use fresh audit output directories. Before sharing evidence, review filenames, logs, screenshots and message contents for personal information/secrets. Original reference screenshots are private supplied material, not shipping assets.
