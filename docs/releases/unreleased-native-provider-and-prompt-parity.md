# Native providers and prompts

## Changed

- Terminal, Desktop, and Web connect menus show OpenAI, Claude, Antigravity, OpenRouter, and Custom OpenAI-compatible Endpoint in that order. Credentials and historical Sessions for retired providers remain readable. A retired provider cannot start a model request.
- Rust uses the Bun v0.12.2 wording for built-in agents and Project roles. Shared tool descriptions follow the same release where the native contracts agree. The built-in `ycoding` skill now points to the Rust runtime and its verification commands.

## Fixed

- A Session announces instruction changes when the active instruction content changes, without repeating the notice on the next turn.
- Runtime state updates no longer rewrite the reusable request prefix on Codex, Claude Code, and Antigravity. Cache reuse and retention remain decisions made by each provider.
