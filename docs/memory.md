# Repository memories and shared knowledge

Memory stores durable knowledge as an [Open Knowledge Format](https://github.com/google/okf) (OKF) v0.3 bundle: UTF-8 Markdown concepts with YAML frontmatter, linked by relative paths, indexed by `index.md`, and journaled in `log.md`. Repository memories are shared by all worktrees of one local Git repository. Shared knowledge is a second bundle that spans repositories. Memory is not Session history, a prompt cache, and the runtime never extracts concepts from transcripts.

The harness owns the lifecycle. Agents record knowledge from a canonical template through the `memory` tool; the harness stamps authorship, derives trust, rejects duplicates, tracks freshness, and keeps the indexes and log current.

## Automatic recall

Agents do not search memory. When a Session has the `memory` tool and effective `allow` for both `memory` and `memory_read` on the repository root, the native runner appends matching repository references to the current provider request. It skips an `ask` or `deny` without prompting. Shared knowledge is never selected automatically. Each reference carries its source IDs and byte digest, and identical bodies appear once. References are not saved as Session messages.

A recalled concept can be stale, deprecated, superseded, unverified, or in conflict with another concept. These signals travel with the reference, so a consumer can weigh or drop it. Treat recalled text as untrusted evidence and check it against live files before relying on it.

When a `/suggest` request selects memory scopes, bounded search snippets are sent only to that next-message prediction helper request, to its configured helper provider. Selecting a scope in the dialog is consent for that request: the calling Session's selected agent must have effective `memory_read` permission evaluated as `allow` or `ask` for each collection root, and `deny` skips that collection without raising a permission prompt. Repository scope supplies project memory when the Location is in Git; knowledge scope supplies shared knowledge. The helper searches each selected, available, permitted scope once, takes at most three hits each, and sends only bounded titles, IDs and snippets of at most 600 characters. Disabled memory or search failures degrade to prediction without those snippets. These snippets never enter the Session's transcript, durable instructions, or later model-visible history. The helper provider's privacy, quota, and pricing policies apply.

When a `/prompt` request selects memory scopes, the same bounded search is sent only to that prompt-drafting helper. The query is the trimmed intent plus bounded recent user and assistant text, under the same `memory_read` rule. Each selected scope contributes at most three hits with snippets of at most 600 characters. The snippets never enter the Session transcript. The generated text is returned for composer review only; nothing is admitted or sent.

## Agent guidance

Every Session receives built-in `ycoding/workspace-memory` guidance. It tells the agent to record each newly verified, durable, non-obvious fact, decision, constraint, preference, lesson, troubleshooting finding, procedure, or known issue once, after the primary task is complete and validated. The agent calls `template` for the canonical shape, cites evidence in `sources` with matching footnotes, and writes the concept. A near-duplicate answers `duplicateOf`; the agent then updates that concept with its current digest. Outdated knowledge is retired with `supersede` or `retire`.

The guidance states what memory holds: durable verified knowledge only. Procedures belong in skills, events in Session history, and behavior in harness configuration.

The guidance forbids transient task state, transcripts, logs, secrets, credentials, personal data, private URLs, machine-local paths, and speculation. It also forbids writing `generated` or `verified` fields. Every call goes through the `memory` tool and its [permission boundary](#permission-boundary).

## Tool actions

Every action accepts an optional `scope` of `repository` (default) or `knowledge`.

| Action      | Input                                                                                       | Result                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `status`    | No additional fields                                                                        | Enabled state, selected scope and root, base, knowledge root, repository and worktree association, and limits.                 |
| `template`  | `kind`: `fact`, `decision`, `constraint`, `preference`, `lesson`, `troubleshooting`, `procedure`, or `known-issue` | The canonical `type`, its `purpose`, and a Markdown skeleton to fill in.                                      |
| `write`     | `id`, `content`; optional `expectedDigest`, `allowHumanActor`                               | `id`, committed `digest`, `created`, `warnings`, advisory `diagnostics`, and `duplicateOf` when a near-duplicate exists.       |
| `read`      | `id`                                                                                        | `id`, complete Markdown `content`, and its SHA-256 `digest`.                                                                   |
| `list`      | Optional `offset` (≥ 0) and `limit` (1–100, default 20)                                     | Concept metadata with lifecycle `signals`, `total`, and warnings.                                                              |
| `search`    | `query` (1–1,024 characters); optional `type`, `tag`, `limit` (1–50, default 10)            | Ranked hits with `score`, a bounded `snippet`, lifecycle `signals`, and warnings. An administrative lookup; Sessions recall automatically. |
| `review`    | No additional fields                                                                        | Concepts flagged stale, deprecated, draft, unverified, conflicting, or verified before their latest change, plus findings.    |
| `supersede` | `id`, `replacement`, required `expectedDigest`                                              | Marks `id` deprecated and links `superseded_by` to the replacement.                                                           |
| `retire`    | `id`, required `expectedDigest`                                                             | Marks `id` deprecated with no replacement.                                                                                     |
| `graph`     | No additional fields                                                                        | Local HTML `path`, `digest`, `nodes` and `edges` counts, and warnings.                                                         |
| `delete`    | `id`, required `expectedDigest`                                                             | `id`, `trashID`, `digest`, and warnings.                                                                                       |
| `trash`     | Optional `offset` (≥ 0) and `limit` (1–100, default 20)                                     | `entries` (`id`, `trashID`, `digest`), `total`, and warnings.                                                                  |
| `restore`   | `trashID`, required `expectedDigest`                                                        | Restored `id`, `digest`, and warnings.                                                                                         |
| `purge`     | `trashID`, required `expectedDigest`                                                        | `trashID`, `purged`, and warnings.                                                                                             |
| `vacuum`    | Optional `dryRun` (default `true`) and `expectedDigest` (required when `dryRun` is `false`) | `dryRun`, inventory `digest`, `removed` collection-relative paths, and warnings.                                               |

Every `digest` is a SHA-256 hash. For concepts and trash entries it hashes the exact content bytes; for `graph` it hashes the exported HTML; for `vacuum` it is a plan digest over the planned removals, live concepts, and trash inventory. `delete`, `restore`, `purge`, `supersede`, `retire`, and applied `vacuum` require the current digest and change nothing when it is missing, malformed, or stale. In `write`, `expectedDigest` stays optional: omit it to create, supply the current digest to replace, and an exact retry of identical bytes succeeds. A `trashID` is `trash_` followed by 64 lowercase hexadecimal characters.

Search and list leave the Markdown collection unchanged.

Search runs locally and returns ranked results from the selected collection. [`cue-retrieval.md`](./cue-retrieval.md) describes the engine:

- **Tokens:** the query and concept text are NFC-normalized and lowercased, then split into word tokens that keep underscores. Common English function words are dropped from the query. This normalization applies only to matching; stored concept content is never normalized. There is no stemming, accent or locale folding, prefix, or Boolean syntax. Distinct query tokens are OR terms.
- **Fields:** Tantivy BM25 scores the title (boost 3), identifiers (3), tags (2), keywords (2), description (2), type (2), body (1), and relationships (0.5). Each field is length-normalized separately.
- **Exact tiers:** a concept whose ID, title, tag, or identifier equals the query, or whose body contains the query as a phrase, ranks above BM25-only results.
- **Filters:** `type` and `tag` are exact, case-sensitive matches. `Toolchain` does not match the tag `toolchain`.
- **Order:** exact tiers first, then higher BM25 scores; ties sort by ascending concept ID. Search returns the top `limit` results without a score floor. Scores depend on the collection's contents and are comparable only within one result.
- **Snippet:** at most 320 UTF-16 code units from the body, positioned at the first matching token's original text and never splitting a surrogate pair. It is not guaranteed to end on a whole-character (grapheme) boundary.


## Concept templates

Each canonical type has a template with a shared foundation and type-specific optional fields. The shared foundation is `type`, `title`, `description`, `tags`, and, where a claim needs evidence, `sources` with matching footnotes. Type-specific fields use the `x-ycoding-` prefix so they stay clear of OKF's reserved keys.

| Kind              | `type`         | Sourced | Sections                           | Type-specific fields                                                  |
| ----------------- | -------------- | ------- | ---------------------------------- | --------------------------------------------------------------------- |
| `fact`            | Verified Fact  | yes     | Fact, Evidence                     | `x-ycoding-subject`                                                   |
| `decision`        | Decision       | yes     | Decision, Rationale, Consequences  | `x-ycoding-revisit-when`                                              |
| `constraint`      | Constraint     | yes     | Constraint, Reason                 | `x-ycoding-applies-to`, `x-ycoding-enforced-by`                       |
| `preference`      | Preference     | yes     | Preference, Evidence               | `x-ycoding-applies-to`                                                |
| `lesson`          | Lesson         | no      | Lesson, Context                    | `x-ycoding-trigger`                                                   |
| `troubleshooting` | Troubleshooting| no      | Symptom, Cause, Fix                | `x-ycoding-symptom`                                                   |
| `procedure`       | Procedure      | no      | When to use, Steps                 | `x-ycoding-applies-to`                                                |
| `known-issue`     | Known Issue    | no      | Issue, Workaround, Resolution      | `x-ycoding-affects`, `x-ycoding-workaround`, `x-ycoding-resolution`   |
| `experience`      | Experience     | yes     | Cue, Lesson, Evidence              | `x-ycoding-cue`, `x-ycoding-lesson`, `x-ycoding-applicability`, `x-ycoding-outcome`, `x-ycoding-confidence`, `x-ycoding-harness-change` |

Templates guide authors; they are not a schema. A concept with any other `type` is valid OKF and is accepted. A write returns advisory `diagnostics` with `Y` codes for deviations: a missing title (`Y301`), description (`Y302`) or body (`Y303`), a non-canonical type (`Y300`), missing source citations on a sourced type (`Y304`), a missing template section (`Y305`), a machine-local path (`Y310`), and a private URL (`Y311`). Advice never blocks a write.

## Experiences

An `Experience` concept records one cue-triggered lesson from one observed outcome. The native harness produces experiences through `Service::record_experience(scope, id, &Experience, expected_digest)`. `experience::render` builds the canonical Markdown, `experience::id` derives a stable ID from the cue and outcome, and every write of a concept whose `type` is `Experience` (any letter case) passes the same validation, whichever path wrote it.

| Field                      | Where                         | Rule                                                                                       |
| -------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------ |
| cue                        | `x-ycoding-cue`               | Required. One line, at most 240 characters. The situation that should recall the lesson.   |
| lesson                     | `x-ycoding-lesson`            | Required. One line, at most 600 characters. The rule the outcome established.              |
| applicability              | `x-ycoding-applicability`     | Required. One line, at most 240 characters. Where the lesson holds.                        |
| outcome                    | `x-ycoding-outcome`           | Required. Exactly `success` or `failure`.                                                  |
| confidence                 | `x-ycoding-confidence`        | Required. A number from 0 to 1, written as a quoted string. The writer's own estimate.     |
| evidence                   | `sources` with footnotes      | Required. One to eight sources. Each `resource` is a URI with a scheme other than `file`, or the absolute path of another concept ending in `.md`, with no whitespace. |
| linked harness change      | `x-ycoding-harness-change`    | Optional. One whitespace-free string of at most 300 characters, such as a `repo:///` path, a commit, or an ID. |

Rejections carry a reason: `experience-cue-invalid`, `experience-lesson-invalid`, `experience-applicability-invalid`, `experience-outcome-invalid`, `experience-confidence-invalid`, `experience-harness-change-invalid`, `experience-evidence-missing`, `experience-evidence-invalid`, `experience-transcript` (two or more lines that start with a speaker label such as `user:` or `assistant:`), and `experience-body-too-long` (more than 4096 bytes).

Trust comes only from verification events. Confidence, outcome, and evidence never raise it, and the producer never writes `generated` or `verified`. An experience stays unverified until a human confirms it through `write` with `allowHumanActor`, and any edit to its content drops that verification. The title is the outcome plus the cue, so one cue can hold one success and one failure. A second experience with the same title or a near-identical body answers `duplicateOf` instead of creating a duplicate.

Memory holds durable verified knowledge, skills hold procedures, Session history holds events, and harness configuration holds behavior. An experience carries the distilled lesson and a reference to its evidence. It never carries a transcript, a command log, step-by-step instructions, or the state of a running task.

Retrieval receives an experience as a `Document` whose `keywords` include the cue and whose `identifiers` include the linked harness change, next to the usual tags, sources, and body.

## Authoring contract

IDs are slash-separated lowercase letters, digits, underscores, and hyphens, starting each segment with a letter or digit. Supply no extension. Absolute paths, dot segments, symlink escapes, and the reserved `index` and `log` segments are rejected. Hand-placed concepts with any other safe file name are still read, listed and recalled.

A concept needs YAML frontmatter with a nonempty string `type`, delimited by `---` lines, holding one mapping with unique keys. OKF treats every other field as optional, so a malformed optional field never rejects a concept or hides it from readers. It surfaces as a warning on `list` and `review` instead. A write is rejected only for:

- frontmatter that is not a YAML mapping, has duplicate keys, is unterminated, or lacks `type`;
- a credential pattern anywhere in the content (private key blocks, GitHub and AWS tokens, Bearer headers);
- a `verified` event the harness cannot attribute, or a `human:` actor without `allowHumanActor`.

```markdown
---
type: Decision
title: Test ownership
description: Checks run from the package that owns the behavior.
tags: [testing, architecture]
sources:
  - id: guide
    resource: repo:///AGENTS.md
    title: Repository guide
---

# Decision

Run checks from the package that owns the behavior.[^guide]

[^guide]: Repository guide.
```

Each source needs a `resource`; `id` is optional unless the body cites that source. A footnote with no matching source is a warning. YCoding checks this structure and does not verify that the cited material exists or supports the claim. Links may be relative (`../decisions.md`), bundle-root-relative (`/testing/build.md`), or reference-style. A link must stay inside the bundle. Links in code do not create edges, and dangling links produce warnings. Unknown frontmatter fields and exact UTF-8 content, including a byte-order mark, are preserved. Attested computation concepts (`runtime`, `attester`) are read and validated; their embedded code is never executed.

## Provenance, trust and freshness

The harness, not the agent, owns provenance:

- **Authorship.** On every meaningful content change the harness stamps `generated: { by: ycoding/<version>, at: <time> }`. An unchanged rewrite keeps the existing stamp and its digest.
- **Verification.** `verified` is a list of `{ by, at }` events. An agent cannot add one. A human event is accepted only when the write sets `allowHumanActor` after the person explicitly confirmed, and its time is not in the future. An existing event passes through unchanged.
- **Trust tier.** Derived from current `verified` events only: `unverified` when none is current, `machine-confirmed` for non-human actors, `human-reviewed` when a human event is current. An event is current only when its `at` is not earlier than `generated.at`, or when the concept has no `generated`. Editing a verified concept drops it back to `unverified`; the earlier events stay in the file as history and never count. A `verified` entry may be a single mapping or a list. Trust is advisory and never makes a concept ineligible.
- **Lifecycle status.** `status` is `stable`, `draft`, or `deprecated`; other values read as non-current. `supersede` and `retire` set `deprecated` and maintain `superseded_by`. The harness never invents `stale_after`.
- **Freshness.** A concept is stale once `stale_after` has passed, and a malformed `stale_after` is flagged.
- **Conflicts.** Two or more current concepts with the same normalized `type` and `title` under different IDs conflict. Creating one is answered with `duplicateOf` instead of storing it; hand-placed files can still conflict.
- **Duplicates.** A create is a duplicate when a current concept has the same normalized type and title, or a body with at least 90% token overlap and at least eight tokens.

`list`, `search`, and automatic recall expose these as `signals`: `status`, `current`, `trust`, `stale`, `stale_after`, `superseded_by`, `verification_older_than_content`, and `conflicts_with`. `review` collects the flagged concepts so they can be repaired.

## Content validation

Every concept's frontmatter, and the bundle-root `index.md` frontmatter, is checked against a content schema that is compiled into the runtime. The schema is derived from OKF v0.3 SPEC.md at upstream revision `527e81aff55992be21507e97004286789126f88c`. Upstream publishes no machine-readable schema at that revision, so the schema is a derived, unofficial reading of the spec text and carries no authority beyond the sections it cites. It is the same file the `okf-knowledge-bundle` skill packages, and a test fails if the two copies differ.

Before the check, the content is reduced to the spec's normal form: a null, empty string or empty list is an absent key, a property that holds a list may be written as one item, and unknown keys are always accepted. Findings name the parsed field and its spec section and never quote the rejected value:

- `S100` is an error: a missing required field such as `sources[0].resource`, `verified[0].at`, `usage_window.to`, `parameters[0].type`, `executor.resource`, or `runtime` on an Attested Computation, or a value of the wrong type or form, such as a non-string `title` or a `stale_after` that is not an RFC 3339 date-time or date.
- `S101` is a warning: a vocabulary or convention such as an unknown `status` or an actor that is not `<producer>/<version>` or `<scheme>:<id>`.

The schema cannot express links, path fields, bundle confinement, trust tiers or the reserved-file rules. The checks listed in the authoring contract and the `W` codes cover those and run beside the schema, not instead of it. Optional metadata defects are reported and never reject a read or a write. Only `type` is required on an ordinary concept.

Older bundles are compatibility inputs. A bundle that declares no `okf_version`, or declares 0.2 or earlier, may use the v0.1 `timestamp` key when `generated` is absent, and may resolve a path field that does not resolve from its file against the bundle root (`W119`). A bundle that declares 0.3 or later ignores `timestamp` for trust, freshness and retrieval revision, and resolves path fields from the file or from the bundle root with a leading `/` only. Footnote definitions such as `[^id]: text` are never read as link reference definitions.

The conformance suite includes the SPEC Appendix A finance bundle as a fixture under `rust/crates/core/tests/fixtures/okf_appendix_a`. Its example actors, usage window, typed parameters and license belong to the fixture only. No default, template or generated index requires or copies them, and validation never executes or evaluates the example computations or attesters.

## Repository identity and storage

The default base is `<YCoding data directory>/memory`, normally `~/.local/share/ycoding/memory`. The repository layout uses `repository/repo_<sha256>/`, keyed by the canonical Git common directory, not by the opened worktree folder or remote URL.

The main checkout, its subdirectories, symlink aliases, and linked worktrees share repository memories. Separate local Git repositories remain isolated even if their remotes match. Shared concepts live under `knowledge/`; knowledge operations remain available outside Git. Changing the configured base changes where YCoding looks and does not move existing files.

An explicit write or graph export creates storage, and an applied vacuum on missing storage can create the collection root. Delete, restore, and purge require existing storage and never create it; a vacuum preview never creates storage or lock files. Missing storage reads as empty; inaccessible storage is an error. Disabling the feature leaves existing files intact. On POSIX, managed scope directories are private (`0700`) and newly written files use `0600`.

```text
memory/
  repository/
    repo_<sha256>/
      index.md
      log.md
      build_rules.md
      testing/
        index.md
        ownership.md
      graph.html
      .trash/
        trash_<sha256>.md
        trash_<sha256>.json
  knowledge/
    index.md
    log.md
    testing.md
```

Concept Markdown is authoritative. The root `index.md` carries `okf_version: "0.3"`, a title, a description, and an `x-ycoding-repository` identifier, then lists subdirectories and concepts. Nested `index.md` files list their directory. A generated index is rewritten from the concepts; an `index.md` whose frontmatter you wrote yourself keeps that frontmatter. Indexes name no machine-local paths. `log.md` has no frontmatter and records each change as a dated bullet under a `## YYYY-MM-DD` heading, newest date first. `graph.html` is derived. Do not edit derived files as knowledge. The `.trash/` folder sits outside the bundle: each entry is an archived copy (`.md`) with a version 1 receipt (`.json`) that records the original concept ID.

## Maintenance lifecycle

The maintenance contract is collection-scoped:

- **Update:** read the entry and pass its current digest to `write`. A stale digest must not overwrite newer content.
- **Retire:** `supersede` and `retire` mark an entry deprecated and keep it readable; recall treats it as non-current.
- **Delete:** move an exact, digest-checked entry to recoverable trash. Repository deletion affects all worktrees sharing that collection; shared-knowledge deletion affects all its consumers.
- **Inspect trash:** list recoverable entries separately. Trash is excluded from normal listing, recall, indexes, and newly generated graphs.
- **Restore:** restore to the original concept ID, refusing to overwrite an existing entry. The `trashID` and the entry's current digest are required.
- **Purge:** permanently remove one explicitly selected trash entry, identified by its `trashID` and current digest.
- **Vacuum:** collection-local file maintenance. `dryRun` defaults to `true`; the preview lists the paths an apply would remove and returns a `digest` that binds the exact bytes of each, the live concepts, and the trash inventory. Apply with `dryRun: false` and that exact `expectedDigest`; a missing or stale digest removes nothing. Apply removes only recognized obsolete generated `index.md` files and recognized orphan trash receipts (regular, size-bounded version 1 `.json` receipts with a valid concept ID whose archived copy is absent). The preview lists at most the configured `max_concepts` receipts and adds a truncation warning when more exist. It then rebuilds the indexes. Vacuum preserves every archived copy, live concept, and other collection, plus unrecognized, malformed, oversized, symlinked, and unknown-version receipts and any file it did not inspect. An archive without a receipt is reported with an `unpaired-trash` warning and left unchanged.

There is no automatic expiry, eviction, bulk prune, or deletion of a repository collection merely because a checkout cannot be found. Trash remains until explicitly restored or purged, subject to bounded storage. Deleting an entry whose receipt already exists for the same concept ID and bytes reuses that archived copy; a genuinely new receipt is admitted only from a complete, readable receipt inventory. A truncated or unreadable listing refuses the new deletion. Restore, purge, and applied vacuum stay available in that state.

A mutation refreshes the managed indexes, log, and graph of its own collection. An exported repository graph embeds a snapshot of shared knowledge and keeps it until exported again. Purging a trash entry does not erase copies, backups, or earlier graph exports.

When a mutation commits and a later ordinary filesystem or derived-file step fails, the result reports the actual committed change with warnings: `index-out-of-date` for derived indexes and graphs, `vacuum-incomplete` when an applied vacuum removed only part of its plan, and `trash-metadata-out-of-date` when a restore or purge leaves its receipt file behind. Maintenance provides no rollback across files. An interruption can leave partial state, so inspect with `read`, `trash`, and a vacuum preview before retrying.

## One-time reset

The harness can reset legacy memory state once, through `Service::reset_plan` and `Service::reset`. The reset is never started automatically and never recurs.

The plan inventories and digests everything it would remove:

- legacy repository collections and shared knowledge under the memory base;
- generated indexes, graph exports, and legacy `trash` folders inside them;
- the retrieval caches under `<data directory>/recall`;
- obsolete `.ycoding-memory-migration-*` control directories next to the base.

Applying the plan requires its exact digest and an empty archive directory outside the base. The reset copies each removed tree into the archive, verifies the copy, removes the original, and initializes clean OKF v0.3 bundles for shared knowledge. It never follows symbolic links, never migrates legacy content into the new bundles, and leaves everything else in place: skills, unrelated files, Session history, credentials, configuration, and user data. A stale digest, a non-empty archive, or an archive inside the base refuses the reset with nothing changed.

## Configuration

Use the normal runtime configuration discovery chain. Fields merge independently, with the last defined value winning.

```jsonc
{
  "memory": {
    "enabled": true,
    "max_concept_bytes": 65536,
    "max_bundle_bytes": 8388608,
    "max_concepts": 1000,
  },
}
```

These are the defaults. Set `"enabled": false` to disable operations without deleting knowledge. Optional `path` overrides the managed base: `~/` expands against the user home; relative paths resolve against the repository's main checkout so linked worktrees share the base, or the current Location folder outside Git. Use a common absolute base to share knowledge across repositories when overriding the default. The byte and count limits must be positive integers; `path` must not be blank. Limits apply to concept bytes, not derived indexes or the HTML export.

See [configuration precedence](./configuration.md#runtime-configuration-discovery-and-precedence) and [permissions](./configuration.md#permissions).

## Safe updates and failures

Without `expectedDigest`, a write is create-only. To replace a concept, read it first and pass that digest. A stale digest fails without overwriting the current content. If current bytes already equal the requested bytes, the exact retry succeeds without rewriting the concept.

A bundle lock serializes cooperating tool writers, and a same-directory temporary file is atomically renamed for each update. Direct edits in an editor are not transactionally locked: read again before overwriting an externally edited file. If the concept commits but refreshing the generated files fails, the result includes the committed digest and an `index-out-of-date` warning. Do not replay it as a failed write; a later write or graph export refreshes those files. Malformed unrelated concepts are reported in warnings; capacity excess fails explicitly.

## Permission boundary

The whole tool uses the `memory` visibility policy. These actions require `memory_read`:

- `status`, `template`, `list`, `search`, `read`, and `review`;
- `trash`; and
- `vacuum` with `dryRun` omitted or `true`.

These require `memory_write`: `write`, `supersede`, `retire`, `graph`, `delete`, `restore`, `purge`, and `vacuum` with `dryRun: false`. Repository graph export also requires read authority for the shared-knowledge root.

Every `memory_write` action also acquires a `file_mutation` Session guardrail reservation on the collection root, released when the action settles. Its metadata carries the `memoryAction`, an `operation` of `remove` for `delete`, `purge`, and applied `vacuum`, or `write` for the other mutations, and a digest of the exact input, so a granted review does not cover a changed operation. `purge` and applied `vacuum` have no separate built-in confirmation flag; the applicable permission and guardrail approvals still apply, and an approval covers only the exact reviewed destructive scope. Reads, `trash`, and the vacuum preview take no guardrail reservation. A collection root outside the YCoding data directories, such as one under a configured `path`, can fall under ordinary outside-repository guardrail review.

Explicit permission denies remain effective. No memory-specific automatic allow rule is installed. Approval covers the resolved workspace memory root, and the operation checks the root again after approval rather than writing to a changed configuration target. Disabled operations do not read or delete knowledge.

## Offline graph and reader

The `graph` action returns an HTML file path to open manually in a browser. The file embeds a snapshot of the concepts, has no external assets or network requests, and is read-only with respect to the source Markdown.

Use Search and Type to filter the visible concepts. Select a graph node or matching-concept button with a pointer or keyboard (`Tab`, then `Enter` or `Space`) to update the plain-text Markdown reader. Related-concept buttons navigate connected concepts. An empty bundle has an explicit empty state.

The reader displays untrusted concept text as text, never executable HTML. The exported file contains complete concept contents, so share it only with the intended audience. Export again after editing or removing concepts, including shared knowledge, to refresh the snapshot; an existing file is never revoked, and copies outside the managed folder remain. Graph export neither opens a browser automatically nor starts a server.

## What belongs in memory

Memory holds durable, verified knowledge. Procedures belong in skills, events belong in Session history, and behavior belongs in harness configuration. Write a concept for a fact or decision that stays true across Sessions, cite its sources, and link to the skill that applies it. Do not copy a procedure, a transcript or a setting into a concept. [Where knowledge lives](./repository-resources.md#where-knowledge-lives) describes the same split from the skill side.
