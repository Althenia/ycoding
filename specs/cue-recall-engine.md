# Cue and Recall

Design contract. The engine selects knowledge and procedures for the next model request. It does not author knowledge, run procedures, or grant access. The [tool contract](#tool-contract) defines the observable behavior of retrieval and repair.

## Sources and ownership

Use one Rust reader and retrieval pipeline for automatic recall, skill selection and tool consumers. An OKF 0.3 bundle contains the authoritative memory. A standard skill directory contains its `SKILL.md` and optional supporting files. A served skill must supply the same document; an advertisement alone is not a procedure. Keep verified MCP resource identity, manifest digest, scope and resource access checks. Build shipped procedures from standard skill files. Do not treat a transcript, search index or filesystem watcher as an alternative source of truth for memory.

The native memory store, parser, per-query BM25, graph export and tool authority live in `rust/crates/core/src/resources/memory` and `tools/builtin/memory.rs` within that crate's `src` directory. Their Bun counterparts are `packages/core/src/memory.ts`, `memory/` and `tool/memory.ts`. Preserve maintenance and graph operations; replace the duplicate reading and scoring implementations. Process-memory telemetry is unrelated.

The native skill catalog combines configured directories, remote catalogs, embedded declarations and MCP entries. Discovery also accepts flat Markdown; the current parser interprets `slash`, `ycoding/slash`, `ycoding/autoinvoke` and conflict declarations. The skill tool handles resource reads; Session skill activation and status have separate owners. Bun has corresponding skill, MCP, plugin, Session, tool and instruction producers. Replace selection in these producers; retain origin checks and the durable record of what the Session actually loaded. Account connector discovery must not eagerly download procedures to build an index.

Trace consumers through native runtime dispatch, TypeScript server handlers, shared Schema and Protocol, generated Client, CLI run commands, TUI picker/status/prompt, Desktop Session views and Web Session controls. Presentation clients consume the same results; none may rank candidates or decide permission. Regenerate changed public descriptors through their owner. Update runtime, repository resource and memory guides and release notes when behavior ships.

## Cues and activation grammar

Consume `session.input.promoted` before encoding the admitted request, `session.compacted` after successful compaction, and `skill.updated` to invalidate discovery. Use internal identifiers `command.invoked` for an admitted command and argv, `path.selected` for a resolved workspace path, `session.recovered` for the reconstructed Session, and `memory.changed` after committed content changes. Internal identifiers do not create public events. Only a trusted runtime transition emits a cue. Text that spells an event or resembles a shell command is ordinary query text. Replay the same Session event identity at most once per source revision and prompt assembly; do not replay tool actions.

```yaml
---
name: rust-build
description: Diagnose Cargo build failures.
metadata:
  version: "1"
  activation: auto
  keywords: "cargo build, linker"
  events: "command.invoked"
  commands: "cargo build, cargo check"
  paths: "rust/**/Cargo.toml, rust/**/*.rs"
---
```

`metadata` is the Agent Skills extension point: both keys and values are strings. These six keys define this activation vocabulary; the upstream specification does not prescribe their meanings. `version` is an opaque nonempty skill version, not a permission or ranking weight. Match `activation` case-sensitively. Omitted activation leaves ordinary discovery and explicit loading available. `manual` excludes all implicit activation. For `auto`, split list values on literal commas, trim surrounding whitespace, deduplicate, and reject empty terms or malformed values for automatic selection. Unknown metadata stays untouched. Invalid activation metadata never broadens activation. Do not interpret a top-level or prefixed spelling as a trigger.

Events match whole identifiers. Command patterns match literal argv prefixes on token boundaries, with no shell evaluation, substring match, expansion or regex. Paths use `/`-separated workspace-relative globs (`*` within one segment, `**` across segments, `?` for one nonseparator); reject absolute paths, `..` and escapes including symlinks. Keywords feed lexical retrieval. Event, command and path matches are alternatives. Filter by visibility, scope, permission and conflict policy before using any result. An explicit ID takes precedence; if denied or missing, do not replace it with a near match. Deterministic cues precede implicit relevance. Repeated cues for one document produce one activation.

## Retrieval and context

Search the permitted collection with BM25 over its indexed fields. Preserve exact filters and order matching hits by descending score and ascending canonical ID. Exclude zero-score entries. Do not ask another model to decide a routine match.

Show names, descriptions and source references before bodies. Include only the selected content; open supporting files on demand. Each injected item identifies its kind, origin, scope, ID, byte digest and selection reason. Deduplicate by source identity and revision; when identical content has multiple authorized origins, retain its provenance but inject the content once. Keep the cacheable instructions, tool definitions and provider/profile affinity unchanged. Append per-turn context after the stable prefix. Allocate at most 2,048 tokens to automatic context, also bounded by the actual remaining request budget. Count wrappers and provenance. Omit a whole item when it will not fit; never truncate explicit instructions silently. A blocked explicit load must be observable before dispatch.

Key index entries by scope, canonical source, content hash and analyzer revision. Update touched entries and remove stale revisions on rename, delete or changed visibility. Persist derived data outside the bundle. Rebuild from source after deletion or corruption without changing source bytes. Readers see one committed generation. Two worktrees of one repository share its memory; unrelated repositories do not. Do not search shared knowledge on behalf of a repository-only operation. Never inject denied, disabled, trashed or out-of-scope material.

Design limits for the default corpus: 1,000 concepts, 8 MiB of input per collection, 64 KiB per concept; one background index job, at most two compute threads, 512 MiB incremental resident memory, 512 MiB derived disk per collection and 60 seconds per rebuild slice. Account for staging generations in measurements. Time out or cancel an over-budget job without publishing an incomplete generation. Recheck source identity on consumption so an old generation cannot resurrect deleted content. When a snapshot cannot be published, score its in-memory index without changing the committed generation.

## Persistence and recovery

Read OKF 0.3 as UTF-8 Markdown with YAML 1.2 core mappings. A concept needs a nonempty type. Preserve unknown keys, raw content and bundle-relative IDs. Exclude reserved index and log files, dot directories, and nonconcept assets from retrieval. Respect bundle-root and file-relative references without escaping containment. Do not promote malformed freshness, unknown lifecycle states or stale verification into trusted facts. Do not execute embedded computations or fetch sources. Keep recoverable trash outside the visible bundle tree.

On first use by a new build, acquire the exclusive migration fence over all affected roots. Refuse concurrent unfenced writers; an open older writer is not a verified snapshot. Inventory active and archived documents, receipts, unknown files, links, IDs, permissions, content digests, scope boundaries and repository identity. Create a private read-only rollback copy, re-read it, and compare against the locked source before staging. A count alone cannot verify backup. Compare restored tool-visible content, digests, receipt identities and graph targets. Validate conforming entries independently and verify that each recorded preservation exception keeps its original name, bytes and digest. If either comparison fails, leave the source authoritative and report the affected identity and reason, without its content.

Flush staged files and directories, then atomically publish one generation pointer on the same filesystem and sync its parent. The pointer selects the complete old or complete new collection set. Leave the backup outside the active store. Restart before publication discards or verifies owned staging; restart afterwards verifies the committed generation without importing again. No automatic purge, lossy normalization, duplicate write or empty-store substitution. For ordinary mutations, compare the expected digest under the writer fence; refresh derived indexes after the authoritative commit. Report committed mutations accurately on index failure. Reconstruct selection after compaction or recovery against current source revisions and permissions, not solely from old message bodies.

The legacy writers do not share a fence. Native memory locks `.locks/collection.lock`; Bun memory uses a reclaimable heartbeat directory; Meeting's proposal writer locks `.locks/meeting-write.lock`. Bun checks its owner token when releasing the lease, not immediately before replacing the file. A paused process can therefore outlive its lease. Neither an empty lock directory nor two matching inventories establish that an old writer cannot commit later. Require an exclusive cutover that drains these writers and prevents them from reopening the roots. Without that guarantee, leave the old roots authoritative and do not publish the generation.

## Boundary acceptance

| ID | Starting state and action | Required observation |
| --- | --- | --- |
| AC-01 | Load a conformant bundle with an unknown type, extension object, scalar tag, reserved files, relative links and a symlink outside its root; discover a standard skill without activation keys. | Preserve the concept and extension; treat the scalar as one tag. Neither reserved files nor external targets become concepts. The skill remains explicitly loadable. |
| AC-02 | Promote an explicit request for `rust-build` beside a stronger keyword candidate. Repeat with permission denied, then with a manual-only skill and an implicit query. | Only the requested skill activates on success, nothing substitutes on denial, and the manual skill never activates implicitly. No permission or tool invocation follows from activation. |
| AC-03 | Register separate auto skills for `command.invoked`, `cargo check`, and `rust/**/*.rs`. Submit each cue in isolation, then submit argv `cargo checker`, a path in another repository, a quoted event name and invalid array metadata. | The first three match their eligible rules; the counterexamples do not trigger a deterministic activation. Unknown and unconfigured skills remain discoverable. |
| AC-04 | Search a permitted collection for matching terms and an unrelated query. | Matching entries have positive BM25 scores and deterministic order; the unrelated query injects nothing. |
| AC-05 | Query a permitted repository twice, modify one concept, delete another, open an unrelated repository, then remove the derived index. | Stale and foreign content never appears. Rebuild yields the same eligible results. No authoritative file changes during lookup. |
| AC-06 | Interrupt a rebuild or exceed a rebuild resource limit. | An unpublished in-memory index can return current matches. An incomplete build never replaces a committed snapshot. |
| AC-07 | Select the same content by two routes; assemble requests at the token boundary and one token below it. Change only the query, then recover and compact the Session. | Content and provenance fit the budget; stable prefix bytes do not change. The first subsequent request restores eligible active skills and relevant memories once. A deleted or newly denied item stays absent. |
| AC-08 | Race two Sessions with different replacements for one digest. Interrupt a synthetic migration during backup, staging, before pointer publication and immediately after it. Repeat from a read-only copy. | Exactly one replacement wins. Every restart exposes one complete generation; rerun preserves bytes, digest fences, graph targets, archived entries and receipts. A failed backup comparison leaves the old store untouched. |
| AC-09 | Invoke all 11 `memory` actions and `skill` load, repeat load and resource read via the registered tools. Exercise explicit Session activation via native dispatch and client controls. | Preserve schemas, limits, authority boundaries, exact content and recovery operations. All surfaces project the same selected IDs. |
| AC-10 | Search the frozen synthetic holdout with the native BM25 implementation. | Resolve at least 8 of 10 diagnostic answers, retrieve at least 6 of 8 relevant IDs in the first five hits, and abstain on both negative queries. |
| AC-11 | Write one conforming concept and place an existing `---\ntype: Decision\nnote: cobalt\n` entry next to it. Migrate, interrupt before and after publication, and rerun. Read, list and search for `cobalt`, then repair with the original digest. | Both IDs survive. Before repair the raw entry keeps its exact bytes and SHA-256; search finds it and diagnostics identify how to repair it. A stale repair changes nothing. A valid repair clears the diagnostic. A new unterminated write fails with the fix and creates no entry. |
| AC-12 | Query a corpus with ID, title, tag and phrase matches, a weak lexical match and a query without matching terms. Repeat with an unchanged index and with a newly built in-memory index. | Every positive BM25 hit is eligible before the limit. Cached and newly built indexes return identical scores and order; a query without matching terms returns nothing. |

## Plugin registration boundary

The public plugin `skill.source` operation accepts `{type: "embedded", skill: {id, name, location, content}}`. The schema requires an absolute `location`, but the host accepts a body without reading a file there. The native catalog likewise returns the supplied body. Requiring a `SKILL.md` therefore changes what third-party plugins can register, not just how shipped procedures are packaged. Directory sources already support a plugin that ships `skills/<id>/SKILL.md`. The embedded-source contract remains unchanged pending a decision on its removal.

## Measurement and dependency gates

Accept 0.13.4 when the synthetic retrieval thresholds, selected Cue & Recall tests, Rust formatting, Clippy for the affected crates and the affected documentation checks pass.

The held-out fixture in `rust/crates/core/benches/cue-recall-corpus.json` has eight synthetic concepts and ten holdout queries, including two negatives. At the memory search boundary, `cue_recall_fixture_quality` matched 8 of 10 expected diagnostic answers, retrieved 6 of 8 relevant concepts in the first five hits and returned no hits for either negative query.

A separate matched comparison used baseline `2e82a3b` and the candidate worktree before the BM25-only change. Seed `19706` determined the order of the same ten frozen queries across three repetitions. Each build searched a fresh synthetic collection in a new process, then repeated the same query three times. This gives 30 first searches and 90 warm searches per build. The first searches include index construction where applicable; the OS file cache was not cleared.

| Matched measurement | Baseline | Indexed candidate |
| --- | ---: | ---: |
| First search p50 / p95 | 7.615 / 9.163 ms | 21.896 / 52.775 ms |
| Warm search p50 / p95 | 7.631 / 9.185 ms | 4.626 / 5.977 ms |
| Whole-process CPU time | 0.10–0.14 s | 0.13–0.16 s |
| Whole-process peak RSS | 14,368,768–14,467,072 bytes | 31,227,904–34,750,464 bytes |
| Persistent index | 0 bytes | 12,832 bytes |

Across repetitions, the median paired first-search penalty ranged from 12.443 to 15.186 ms. The median paired warm-search saving ranged from 2.781 to 3.243 ms. These ranges describe observed variation, not confidence intervals or a production latency guarantee.

In the request-encoding fixture, each of three requests appended one repository reference message. The first two encoded to identical 719-byte OpenAI Chat JSON bodies. Changing the retrieval suffix produced a 716-byte body with a 210-byte common prefix. The native estimator returned 162, 162 and 161 input tokens. No provider received those bodies, so the fixture does not measure billed input, cache eligibility or a cache read.

The lexical fixture stored a 12,832-byte index. Its ten queries contained 206 UTF-8 bytes and returned 1,592 bytes of concept content before prompt selection. Two matching command cues selected the expected rule, and both negative cues abstained. This checks the command predicate, not end-to-end skill precision.

Separate Session tests inspect instructions in the first request received by a local provider fixture. A keyword match selected `build`; the unrelated query selected nothing. Reopening restored `kept` and `manual-kept`. Successful compaction also selected `compaction-only`; a resumed managed task with no new input selected `recovery-only` once. An interruption after input promotion preserved the explicit `manual-kept` selection without adding the unrequested compaction skill. These checks exercise the runner and its permission filters, not a baseline-versus-candidate skill benchmark or a live agent task.

At the default lexical corpus limits, the native executable searched 1,000 synthetic documents totaling 8,388,608 bytes, including one 65,536-byte document. A cold process took 33.81 s and peaked at 77,234,176 bytes RSS; the snapshot occupied 55,328 bytes. A fresh process reused it in 8.48 s with 66,945,024 bytes peak RSS and returned the same result and score. These are end-to-end process measurements, not worst-case bounds on arbitrary content or measurements of transient disk usage.

| Upstream revision | Inspected surface | License and distribution rule |
| --- | --- | --- |
| [Open Knowledge Format `527e81a`](https://github.com/open-knowledge-format/open-knowledge-format/tree/527e81aff55992be21507e97004286789126f88c) | `SPEC.md` v0.3 and `skills/okf-generate/scripts/validate.py` | Apache-2.0; implement the format, retain license and applicable notices for copied material. |
| [Agent Skills `83021e2`](https://github.com/agentskills/agentskills/tree/83021e2be457a9b6679148719c1f6074f0ad975e) | [published specification](https://agentskills.io/specification), `skills-ref/src/skills_ref/validator.py` | Root and reference code Apache-2.0; documentation CC-BY-4.0. Describe interoperability independently; attribution applies to reproduced or adapted documentation. |
| [Tantivy `605f7e9`](https://github.com/quickwit-oss/tantivy/tree/605f7e989072cea5d76fc658c256e62deb9f68c9) | `src/query/bm25.rs`, collection statistics provider | MIT; include copyright and permission notice for the shipped crate. |

The repository distributes its code as AGPL-3.0-only. MIT and Apache-2.0 code can be included with their respective terms and notices preserved. Keep the existing upstream MIT notice. Inspect transitive dependencies, target availability and applicable attributions; update `NOTICE` for material actually included. Study of an algorithm is not incorporation of the upstream implementation.

## Tool contract

1. `memory.search` retains its input and output schemas. Return positive BM25 scores in descending order with ascending canonical ID as the tie-break. Apply the limit after matching and filtering. `score` is comparable only within one result.
2. New writes require OKF 0.3 §4 frontmatter. An existing entry missing its closing delimiter is a preservation exception, not a reason to refuse migration or rewrite data. Leave its original ID, path and bytes in place. Index its raw text, use its exact-byte digest, and expose repair guidance in the existing warnings array. Do not create a shadow copy for serving reads. An explicit, digest-checked conforming replacement is the repair. The mixed collection switches atomically with a verified backup, and rerunning never modifies unrepaired entries.
