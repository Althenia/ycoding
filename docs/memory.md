# Repository memories and shared knowledge

Memory stores linked, human-readable Markdown concepts. It separates repository memories, shared by all worktrees of one local Git repository, from shared knowledge. It is an explicit knowledge store, not Session history, a prompt cache, or a project artifact. Concept content is never injected into Session prompts, and transcripts are never extracted into memory.

When a `/suggest` request selects memory scopes, bounded search snippets are sent only to that next-message prediction helper request, to its configured helper provider. Selecting a scope in the dialog is consent for that request: the calling Session's selected agent must have effective `memory_read` permission evaluated as `allow` or `ask` for each collection root, and `deny` skips that collection without raising a permission prompt. Repository scope supplies project memory when the Location is in Git; knowledge scope supplies shared/global knowledge. The helper searches each selected, available, permitted scope once, takes at most three hits each, and sends only bounded titles/IDs and snippets of at most 600 characters. Disabled memory or search failures degrade to prediction without those snippets. These snippets never enter the Session's transcript, durable instructions, or subsequent model-visible history. The helper provider's ordinary privacy, quota, and pricing policies apply.

When a `/prompt` request selects memory scopes, the same bounded search is sent only to that prompt-drafting helper. The query is the trimmed intent plus bounded recent user and assistant text. Selecting a scope is consent for that request under the same `memory_read` rule: `allow` or `ask` searches the collection, and `deny` skips it without a permission prompt. Each selected scope contributes at most three hits with snippets of at most 600 characters. Disabled memory or search failures degrade to a draft without those snippets. The snippets never enter the Session transcript. The generated text is returned for composer review only; nothing is admitted or sent.

## Agent guidance

Every Session receives built-in `ycoding/workspace-memory` guidance. It directs agents to search memory before substantive work, verify retrieved facts against live files, and, after the primary task is complete and validated, write or update concepts for newly verified, durable, non-obvious facts and decisions with their sources. It forbids storing transient task state, transcripts, logs, secrets, credentials, private URLs, customer data, or speculation. Every such call goes through the `memory` tool and its [permission boundary](#permission-boundary).

## Explicit requests

Ask the agent to use the built-in `memory` tool directly:

- “Search workspace memory for build constraints.”
- “Read the `build/testing` memory concept.”
- “Save this verified decision to workspace memory, preserving its sources.”
- “Export the workspace memory graph and give me its local file path.”

Every action accepts optional `scope: "repository" | "knowledge"`. Repository scope is the default; select `knowledge` explicitly for shared cross-repository concepts. The interface is:

| Action    | Input                                                                                       | Result                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `status`  | No additional fields                                                                        | Enabled state, selected scope/root, base, knowledge root, repository/worktree association when available, and limits. |
| `list`    | Optional `offset` (integer ≥ 0) and `limit` (1–100, default 20)                             | `concepts` metadata, `total` count, and warnings.                                                                     |
| `search`  | `query` (1–1,024 characters); optional `type`, `tag`, `limit` (1–50, default 10)            | `hits`: concept metadata, `score`, a bounded `snippet`, and warnings.                                                 |
| `read`    | `id`                                                                                        | `id`, complete Markdown `content`, and its SHA-256 `digest`.                                                          |
| `write`   | `id`, `content`; optional `expectedDigest`                                                  | `id`, committed `digest`, whether the concept was `created`, and warnings.                                            |
| `graph`   | No additional fields                                                                        | Local HTML `path`, `digest`, `nodes` and `edges` counts, and warnings.                                                |
| `delete`  | `id`, required `expectedDigest`                                                             | `id`, `trashID`, `digest`, and warnings.                                                                              |
| `trash`   | Optional `offset` (integer ≥ 0) and `limit` (1–100, default 20)                             | `entries` (`id`, `trashID`, `digest`), `total`, and warnings.                                                         |
| `restore` | `trashID`, required `expectedDigest`                                                        | Restored `id`, `digest`, and warnings.                                                                                |
| `purge`   | `trashID`, required `expectedDigest`                                                        | `trashID`, `purged`, and warnings.                                                                                    |
| `vacuum`  | Optional `dryRun` (default `true`) and `expectedDigest` (required when `dryRun` is `false`) | `dryRun`, inventory `digest`, `removed` collection-relative paths, and warnings.                                      |

Every `digest` is a SHA-256 hash, and its subject depends on the action. For concepts and trash entries it hashes the exact content bytes; for `graph` it hashes the exported HTML; for `vacuum` it is a plan digest over the planned removals, live concepts, and trash inventory. `delete`, `restore`, `purge`, and applied `vacuum` require the current digest and fail without changing anything when it is missing, malformed, or stale. In `write`, `expectedDigest` stays optional: omit it to create, supply the current digest to replace, and an exact retry of identical bytes succeeds. A `trashID` is `trash_` followed by 64 lowercase hexadecimal characters.

Search is local lexical BM25 ranking over the selected collection, not semantic or embedding search:

- **Tokens:** the query and concept text are lowercased as a whole string with JavaScript lowercasing, then NFC-normalized, then split into words of Unicode letters, numbers, and underscores. This normalization applies only to matching; stored concept content is never normalized. There is no stemming, accent or locale folding, phrase, prefix, or Boolean syntax. Distinct query tokens are whole-token OR terms: a concept matches when any token occurs.
- **Fields:** three aggregate fields score: title and ID combined (boost 4), type, tags, and description combined (boost 2), and body (boost 1). Each aggregate field is length-normalized separately against its own average length, which includes every concept in the collection, even those with an empty field. An aggregate field's BM25 term score (`k1` = 1.2, `b` = 0.75) is multiplied by its boost.
- **IDF:** `ln(1 + (N − df + 0.5) / (df + 0.5))`, where `N` is the number of concepts in the collection and `df` is the number whose any field contains the token.
- **Filters:** `type` and `tag` are exact, case-sensitive matches applied after scoring; collection statistics (`N`, `df`, field lengths) are computed before filtering and do not change with filters.
- **Order:** higher scores rank first; ties sort by ascending concept ID. Scores depend on the collection's contents and are comparable only within one result.
- **Snippet:** at most 320 UTF-16 code units from the body, positioned at the first matching token's original text and never splitting a surrogate pair. It is not guaranteed to end on a whole-character (grapheme) boundary.

Search and list do not repair or create files, and search keeps no persisted index.

## Repository identity and storage

The default base is `<YCoding data directory>/memory`, normally `~/.local/share/ycoding/memory`. The repository layout uses `repository/repo_<sha256>/`, keyed by the canonical Git common directory, not by the opened worktree folder or remote URL.

The main checkout, its subdirectories, symlink aliases, and linked worktrees share repository memories. Separate local Git repositories remain isolated even if their remotes match. Shared concepts live under `knowledge/`; knowledge operations remain available outside Git. Changing the configured base changes where YCoding looks and does not migrate existing files.

An explicit write or graph export creates storage, and an applied vacuum on missing storage can create the collection root. Delete, restore, and purge require existing storage and never create it; a vacuum preview never creates storage or lock files. Missing storage reads as empty; inaccessible storage is an error. Disabling the feature leaves existing files intact. On POSIX, managed scope directories are private (`0700`) and newly written concept and derived files use `0600`.

```text
memory/
  repository/
    repo_<sha256>/
      index.md
      mem_build_rules.md
      graph.html
      trash/
        trash_<sha256>.md
        trash_<sha256>.json
  knowledge/
    index.md
    testing.md
    graph.html
```

Concept Markdown is authoritative. Root/nested `index.md` and `graph.html` are derived; do not edit them as knowledge. Each `trash/` entry is an archived copy (`.md`) with a version 1 receipt (`.json`) that records its original concept ID; both are managed by the tool. The repository index associates memories with the repository and its checkout/worktree paths, so review it before sharing. Repository exports include shared knowledge for cross-tree traversal; knowledge-only exports do not scan other repositories.

## Maintenance lifecycle

The maintenance contract is collection-scoped:

- **Update:** read the entry and pass its current digest to `write`. A stale digest must not overwrite newer content.
- **Delete:** move an exact, digest-checked entry to recoverable trash. Repository deletion affects all worktrees sharing that collection; shared-knowledge deletion affects all its consumers.
- **Inspect trash:** list recoverable entries separately. Trash is excluded from normal search, concept lists, indexes, and newly generated graphs.
- **Restore:** restore to the original concept ID, refusing to overwrite an existing entry. The `trashID` and the entry's current digest are required.
- **Purge:** permanently remove one explicitly selected trash entry, identified by its `trashID` and current digest. Purge does not mean deleting an entire repository collection or every entry matching a wildcard.
- **Vacuum:** collection-local file maintenance, not SQLite `VACUUM`. `dryRun` defaults to `true`; the preview lists the paths an apply would remove and returns a `digest` that binds the exact bytes of each, the live concepts, and the trash inventory. Apply with `dryRun: false` and that exact `expectedDigest`; a missing or stale digest removes nothing. Apply removes only:
  - recognized obsolete generated `index.md` files; and
  - recognized orphan trash receipts: regular, size-bounded version 1 `.json` receipts with a valid concept ID whose archived copy is absent.

  The preview lists at most the configured `max_concepts` known orphan receipts and adds a truncation warning when more exist; apply removes exactly that unchanged previewed batch, so repeat preview and apply to clear a larger backlog. It then rebuilds derived indexes. Vacuum preserves every archived copy, live concept, and other collection, plus unrecognized, malformed, oversized, symlinked, and unknown-version receipts, temporary files, and any file it did not inspect. An archive without a receipt is reported with an `unpaired-trash` warning and left unchanged: it is a nonblocking advisory diagnostic, not a recoverable receipt entry, its bytes do not count toward receipt capacity, and vacuum never cleans it up automatically. The bound covers orphan-receipt selection and diagnostic output, not every directory read.

There is no automatic expiry, eviction, bulk prune, or deletion of a repository collection merely because a checkout cannot be found. Trash remains until explicitly restored or purged, subject to bounded storage. Maintenance uses the same permission, guardrail, locking, and path-containment boundaries as other mutations.

Deleting an entry whose receipt already exists for the same concept ID and bytes reuses that archived copy and consumes no additional trash capacity; the receipt is reused only after its archived bytes and original-id metadata validate, otherwise the deletion refuses. A genuinely new receipt is admitted only from a complete, readable receipt inventory: a truncated or unreadable receipt listing refuses the new deletion instead of admitting it against partial counts. Unpaired archives never block a deletion on their own. Explicitly selected valid purge and restore operations remain available in that state, and so does bounded recovery cleanup by applied vacuum. Only a new distinct deletion stays refused until the receipt inventory is complete again, for example after an applied vacuum removes the orphan receipts that made it incomplete.

A mutation refreshes or invalidates the managed graph of its own collection so it does not continue presenting a removed entry. An exported repository graph embeds a snapshot of shared knowledge: a knowledge write, deletion, or purge does not refresh or revoke it, and it keeps that snapshot until the repository graph is exported again. Purging a trash entry does not erase copies, backups, or previously shared graph exports, and does not promise secure physical erasure.

When a mutation commits and a later ordinary filesystem or derived-file step fails, the result reports the actual committed change with warnings: `index-out-of-date` for derived indexes and graphs, `vacuum-incomplete` when an applied vacuum removed only part of its plan, and `trash-metadata-out-of-date` when a restore or purge leaves its receipt file behind. Maintenance provides no rollback and no all-or-nothing guarantee across files. An interruption or process crash can leave partial state and may return no result, so inspect with `read`, `trash`, and a vacuum preview before retrying.

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

These are the defaults. Set `"enabled": false` to disable operations without deleting knowledge. Optional `path` overrides the managed base: `~/` expands against the user home; relative paths resolve against the repository's main checkout so linked worktrees share the base, or the current Location folder outside Git. Use a common absolute base to share knowledge across repositories when overriding the default. The byte/count limits must be positive integers; `path` must not be blank. Limits apply to concept bytes, not derived indexes or the HTML export.

See [configuration precedence](./configuration.md#runtime-configuration-discovery-and-precedence) and [permissions](./configuration.md#permissions).

## Author a concept

IDs are slash-separated lowercase letters, digits, underscores, and hyphens, starting each segment with a letter or digit. Supply no extension. Absolute paths, dot segments, symlink escapes, and reserved `index`, `log`, `_meta`, or `trash` segments are rejected.

Each concept requires YAML frontmatter with a nonempty `type`. Types are open-ended. Optional `title`, `description`, string-array `tags`, and source records are validated. Unknown metadata and exact UTF-8 content, including a byte-order mark, are preserved.

```markdown
---
type: Decision
title: Test ownership
tags: [testing, architecture]
sources:
  - id: guide
    resource: repo:///AGENTS.md
custom:
  owner: runtime
---

Run checks from the package that owns the behavior.[^guide]
See [build constraints](build/constraints.md).
```

Each source record requires `resource`; `id` is optional unless the body cites that source. Declared source IDs must be unique. A source-footnote reference must have a matching source record or Markdown footnote definition. YCoding checks this structure; it does not verify that a source exists or supports the statement. Save only verified, relevant knowledge and do not store secrets or private customer data.

Links may be relative (`../decisions.md`), memory-root-relative (`/knowledge/testing.md` or `/repository/repo_<sha256>/mem_build_rules.md`), or reference-style Markdown links. From a repository collection's root, `../../knowledge/testing.md` reaches shared knowledge. Links inside code do not create graph edges. Links to concepts outside the selected export remain dangling rather than triggering scans of other repositories. Dangling links produce warnings rather than inventing targets. External URLs are not fetched by memory or its graph.

## Safe updates and failures

Without `expectedDigest`, a write is create-only. To replace a concept, read it first and pass that digest. A stale digest fails without overwriting the current content. If current bytes already equal the requested bytes, the exact retry succeeds without rewriting the concept.

A bundle lock serializes cooperating tool writers, and a same-directory temporary file is atomically renamed for each update. Direct edits in an editor are not transactionally locked: read again before overwriting an externally edited file. Avoid concurrent manual edits during tool writes.

If the concept commits but rebuilding an index fails, the result includes the committed digest and an `index-out-of-date` warning. Do not blindly replay it as a failed write. The next explicit write or graph export rebuilds indexes; read-only operations do not. Malformed unrelated concepts are reported in warnings; capacity excess fails explicitly.

## Permission boundary

The whole tool uses the `memory` visibility policy. These actions require `memory_read`:

- `status`, `list`, `search`, and `read`;
- `trash`; and
- `vacuum` with `dryRun` omitted or `true` (the preview).

These require `memory_write`: `write`, `graph`, `delete`, `restore`, `purge`, and `vacuum` with `dryRun: false`. Repository graph export also requires read authority for the shared-knowledge root.

Every `memory_write` action also acquires a `file_mutation` Session guardrail reservation on the collection root, released when the action settles. Its metadata carries the `memoryAction`, an `operation` of `remove` for `delete`, `purge`, and applied `vacuum` or `write` for `write`, `restore`, and `graph`, and a digest of the exact input, so a granted review does not cover a changed operation. `purge` and applied `vacuum` have no separate built-in confirmation flag; the applicable permission and guardrail approvals still apply, and an approval covers only the exact reviewed destructive scope. Reads, `trash`, and the vacuum preview take no guardrail reservation. A collection root outside the YCoding data directories, such as one under a configured `path`, can fall under ordinary outside-repository guardrail review.

Explicit permission denies remain effective. No memory-specific automatic allow rule is installed.

Approval covers the resolved workspace memory root. The operation checks the root again after approval rather than writing to a changed configuration target. `status` may resolve paths but does not read concept content. Disabled operations do not read or delete knowledge.

## Offline graph and reader

The `graph` action returns an HTML file path to open manually in a browser. The file embeds a snapshot of the concepts, has no external assets or network requests, and is read-only with respect to the source Markdown.

Use Search and Type to filter the visible concepts. Select a graph node or matching-concept button with a pointer or keyboard (`Tab`, then `Enter` or `Space`) to update the plain-text Markdown reader. Related-concept buttons navigate connected concepts. Lines show the selected concept's relationships. An empty bundle has an explicit empty state.

The reader displays untrusted concept text as text, never executable HTML. The exported file contains complete concept contents, not just titles; share it only with the intended audience. Export again after editing or removing concepts, including shared knowledge, to refresh the snapshot; an existing file is never revoked, and copies outside the managed folder remain. Graph export neither opens a browser automatically nor starts a server.
