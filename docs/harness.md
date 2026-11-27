# Recursive harness adaptation

The harness module (`rust/crates/core/src/harness`) lets a session adapt its own configuration to the task in front of it. The harness is the set of editable items around the model: system prompt text, guardrails, memory entries, tool guidance, subagents, skills, scripts and plugins. The module probes small, reversible edits to those items against the session's own recent behavior, keeps the ones that measurably help, and records what it learned as experiences that later sessions recall.

## Harness and versions

A `Harness` maps each `Component` to a list of `Item`s (a key and its content). A `Version` is an immutable snapshot with a content-addressed id (`hv_` plus 32 hex characters of the SHA-256 of the parent id and the canonical harness), its parent, the edits that produced it, a creation time and the session that adopted it. The empty harness is the root version and always exists.

`FileVersions` stores versions as JSON under a directory: one file per version plus a `current` pointer. `publish(version, expected)` moves the pointer only when the current id equals `expected`; otherwise it returns `Error::Conflict`. A new version must be a child of `expected` and its id must match its content. Publishing a version that is already stored moves the pointer back to it, which is how rollback works. Two sessions that adapt at the same time cannot both win: the later publication fails and that session continues on the winner's version.

## Modes

`Settings.mode` selects how `Engine::prepare` behaves.

| Mode         | Behavior                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `disabled`   | Returns the current version and emits a skipped event. Nothing runs and `reflect` records nothing.                                         |
| `adaptive`   | Runs a baseline and optimizes only when it is insufficient: the outcome is not completed, or the signal count reaches `min_signals`.      |
| `parallel`   | Always optimizes, in one round: up to `steps` candidates are probed and composed together.                                                 |
| `sequential` | Runs up to `max_depth` rounds. Each round starts from the previous round's composed version. Only the final result is published.           |

## Round

1. **Baseline.** `Prober::baseline` runs the task on the base harness and returns an `Execution` (outcome, tokens, latency, signal counts) plus a `Replay` the probes reuse.
2. **Propose.** `Proposer::propose` receives the task, the base version, the baseline and the recalled experiences, and returns at most `steps` candidates. The engine truncates anything beyond that, drops candidates for another base, duplicate ids and empty edit lists, and recomputes each candidate's harness from its edits.
3. **Authorize.** Every candidate edit is checked against the `Ceiling` before it is probed (see below). A candidate with any rejected edit is dropped whole.
4. **Probe.** Candidates run in chunks of `max_concurrency`. Each chunk receives an equal share of the remaining token budget; a chunk starts only while tokens and latency remain. Tokens add up across probes and latency adds the slowest probe per chunk.
5. **Compose.** `Proposer::compose` selects the edits to keep. The engine keeps an edit only when it appears in a probed candidate, has a contrast with non-empty `better` evidence and a non-empty observation, and passes authorization again against the running harness. The composed harness must also fit `max_items`. Everything else lands in `dropped` with a reason.
6. **Adopt.** The kept edits become a child version published against the version read at the start. If the harness is unchanged nothing is published.

## Authorization

The `Ceiling` describes what a session may change; no edit can exceed it.

- `skills`, `agents`, `plugins` and `scripts` list the keys that may be set or removed in the matching component.
- `max_item_bytes` bounds the content of one item and `max_items` bounds the total item count.
- Guardrail items can be added. They can never be replaced or removed.
- Removing an item that does not exist is invalid.

## Experiences

`Proposer::reflect` turns a completed task into `Experience` records: a cue, a lesson, evidence, a confidence, the applicability (domains, components, agents) and the harness change it concerns. `Strategy` keeps successes and failures apart and `Basis` keeps observed facts apart from assumptions.

`Engine::reflect` normalizes every record before storing it: empty cues or lessons are discarded, ids become lowercase slugs, evidence is deduplicated, confidence is clamped to 0–1, an experience without evidence becomes `Assumed`, assumed confidence is capped at 0.5, and a success is discarded unless the task completed. In adaptive mode reflection runs only after an adaptation or a task that did not complete.

`MemoryExperiences` stores each experience as an `Experience` OKF concept at `experiences/<id>` in a memory scope, using the memory service's experience support, and recalls them with the task text. Recall drops experiences whose applicability names a different agent or no shared domain. Memory requires every experience to cite evidence as a reference, so each evidence string is stored percent-encoded under a `harness://evidence/` resource and decoded on recall; an experience with no evidence is stored with the `harness://assumed` marker, tagged `assumed`, and comes back with empty evidence. The linked change is stored as the version id followed by the percent-encoded edit summaries, truncated to the reference limit.

## Configuration

The `harness` runtime object turns adaptation on. Without it no harness runs and Sessions behave unchanged. With it, every Session run prepares a harness version before the first Step, appends the version's `system-prompt` and `tool-guidance` items to the Step system prompt, and records a reflection after the run settles. Fields merge independently in normal configuration order.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `harness.mode` | `adaptive` \| `parallel` \| `sequential` \| `disabled` | `adaptive` | Selects the behavior in the Modes table. `disabled` keeps the current version and records a skipped evaluation. |
| `harness.steps` | positive integer | `1` | Candidates probed per round. |
| `harness.max_concurrency` | positive integer | `2` | Probes run at once. |
| `harness.max_depth` | integer 1 to 255 | `1` | Rounds in `sequential` mode. |
| `harness.max_tokens` | positive integer | `200000` | Token budget for one preparation. |
| `harness.max_latency_ms` | positive integer | `600000` | Latency budget for one preparation. |
| `harness.min_signals` | non-negative integer | `2` | Signal count at which `adaptive` mode judges a baseline insufficient. |
| `harness.recall_limit` | non-negative integer | `5` | Experiences recalled per task. |
| `harness.ceiling.skills`, `.agents`, `.plugins`, `.scripts` | array of names | empty | Keys an edit may set or remove in the matching component. |
| `harness.ceiling.max_item_bytes` | positive integer | `4096` | Largest content of one item. |
| `harness.ceiling.max_items` | positive integer | `64` | Largest total item count. |

Versions are stored under `<YCoding data directory>/harness` and experiences are stored as repository memory concepts. A probe is a dry replay: it sends the task to the helper model with the candidate's prompt items and executes no tools.

## Events

`Events::emit` receives an `Event` for each stage: `Baseline` (signal count and whether the harness was judged insufficient), `Proposed`, `Probed` (candidate, outcome, tokens, latency), `Composed` (kept and dropped counts), `Adopted` (version and parent), `RolledBack` and `Reflected`. A `Skipped` detail carries the reason when a stage ends the run: `disabled`, `baseline-sufficient`, `no-candidates`, `no-probe-results`, `budget-exhausted`, `no-improvement`, `no-change` or `conflict: …`.
