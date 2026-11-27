# Recursive harness adaptation

## Added

- The core harness module adapts a session's configuration to its task. It probes small edits to the system prompt, guardrails, memory, tool guidance, subagents, skills, scripts and plugins, keeps only edits with contrast evidence that stay inside the session's authorization, and publishes the result as a content-addressed, reversible version.
- Modes: `disabled`, `adaptive` (optimizes only when the baseline is insufficient), `parallel` and `sequential`.
- Guardrails can be added but never replaced or removed by adaptation.
- Lessons from completed tasks are stored as experience concepts in workspace memory, with evidence-less lessons marked as assumptions, and recalled for later tasks.
- Rollback to any stored version.
