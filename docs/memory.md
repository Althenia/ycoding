# Repository memories and shared knowledge

Memory stores linked, human-readable Markdown concepts. It separates repository memories, shared by all worktrees of one local Git repository, from shared knowledge. It is an explicit knowledge store, not Session history, a prompt cache, or a project artifact. Concept content is never injected into prompts, and transcripts are never extracted into memory.

## Agent guidance

Every Session receives built-in `ycoding/workspace-memory` guidance. It directs agents to search memory before substantive work, verify retrieved facts against live files, and, after the primary task is complete and validated, write or update concepts for newly verified, durable, non-obvious facts and decisions with their sources. It forbids storing transient task state, transcripts, logs, secrets, credentials, private URLs, customer data, or speculation. Every such call goes through the `memory` tool and its [permission boundary](#permission-boundary).

## Explicit requests

Ask the agent to use the built-in `memory` tool directly:

- “Search workspace memory for build constraints.”
- “Read the `build/testing` memory concept.”
- “Save this verified decision to workspace memory, preserving its sources.”
- “Export the workspace memory graph and give me its local file path.”

Every action accepts optional `scope: "repository" | "knowledge"`. Repository scope is the default; select `knowledge` explicitly for shared cross-repository concepts. The read/write/export interface is:

| Action | Input | Result |
| --- | --- | --- |
| `status` | No additional fields | Enabled state, selected scope/root, base, knowledge root, repository/worktree association when available, and limits. |
| `list` | Optional `offset` and `limit` | Concept metadata, total count, and warnings; defaults to 20, maximum 100. |
| `search` | `query`; optional `type`, `tag`, `limit` | Ranked metadata and bounded snippets; defaults to 10, maximum 50. |
| `read` | `id` | Complete Markdown and its SHA-256 digest. |
| `write` | `id`, `content`; optional `expectedDigest` | Committed digest, whether the concept was created, and warnings. |
| `graph` | No additional fields | Local HTML path, digest, node/edge counts, and warnings. |

Search is local lexical matching, not semantic or embedding search. It matches Unicode words in IDs, titles, types, tags, descriptions, and body text; title/ID matches rank above body-only matches. Ties sort by concept ID. Queries are limited to 1–1,024 characters. Search and list do not repair or create files.

## Repository identity and storage

The default base is `<YCoding data directory>/memory`, normally `~/.local/share/ycoding/memory`. The repository layout uses `repository/repo_<sha256>/`, keyed by the canonical Git common directory, not by the opened worktree folder or remote URL.

The main checkout, its subdirectories, symlink aliases, and linked worktrees share repository memories. Separate local Git repositories remain isolated even if their remotes match. Shared concepts live under `knowledge/`; knowledge operations remain available outside Git. Changing the configured base changes where YCoding looks and does not migrate existing files.

An explicit write or graph export creates storage. Missing storage reads as empty; inaccessible storage is an error. Disabling the feature leaves existing files intact. On POSIX, managed scope directories are private (`0700`) and newly written concept and derived files use `0600`.

```text
memory/
  repository/
    repo_<sha256>/
      index.md
      mem_build_rules.md
      graph.html
  knowledge/
    index.md
    testing.md
    graph.html
```

Concept Markdown is authoritative. Root/nested `index.md` and `graph.html` are derived; do not edit them as knowledge. The repository index associates memories with the repository and its checkout/worktree paths, so review it before sharing. Repository exports include shared knowledge for cross-tree traversal; knowledge-only exports do not scan other repositories.

## Maintenance lifecycle

The maintenance contract is collection-scoped:

- **Update:** read the entry and pass its current digest to `write`. A stale digest must not overwrite newer content.
- **Delete:** move an exact, digest-checked entry to recoverable trash. Repository deletion affects all worktrees sharing that collection; shared-knowledge deletion affects all its consumers.
- **Inspect trash:** list recoverable entries separately. Trash is excluded from normal search, concept lists, indexes, and newly generated graphs.
- **Restore:** restore to the original concept ID, refusing to overwrite an existing entry.
- **Purge:** permanently remove an explicitly selected trash entry. Purge does not mean deleting an entire repository collection or every entry matching a wildcard.
- **Vacuum:** preview first, then explicitly apply cleanup of recognized obsolete generated files and rebuild derived indexes. Preserve live concepts, unknown files, trash, and other collections. This is file maintenance, not SQLite `VACUUM`.

There is no automatic expiry, eviction, or deletion of a repository collection merely because a checkout cannot be found. Trash remains until explicitly restored or purged, subject to bounded storage. Maintenance must use the same permission, guardrail, locking, and path-containment boundaries as other mutations.

Deleting an entry whose receipt already exists for the same concept ID and bytes reuses that archived copy and consumes no additional trash capacity; the receipt is reused only after its archived bytes and original-id metadata validate, otherwise the deletion refuses. A genuinely new receipt is admitted only from a complete, readable trash inventory: a truncated or unreadable listing refuses the new deletion instead of admitting it against partial counts. Explicitly selected valid purge and restore operations remain available in that state.

Managed graph output must be refreshed or invalidated after deletion so it does not continue presenting the removed entry; a failed derived-file update must be reported as a warning after the committed deletion. Purging a trash entry does not erase copies, backups, or previously shared graph exports, and does not promise secure physical erasure.

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

IDs are slash-separated lowercase letters, digits, underscores, and hyphens, starting each segment with a letter or digit. Supply no extension. Absolute paths, dot segments, symlink escapes, and reserved `index`, `log`, or `_meta` segments are rejected.

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

The whole tool uses the `memory` visibility policy. `status`, `list`, `search`, and `read` require `memory_read`; `write` and `graph` require `memory_write`. Repository graph export also requires read authority for the shared-knowledge root. Mutations acquire the existing `file_mutation` Session guardrail reservation. Explicit permission denies remain effective. No memory-specific automatic allow rule is installed.

Approval covers the resolved workspace memory root. The operation checks the root again after approval rather than writing to a changed configuration target. `status` may resolve paths but does not read concept content. Disabled operations do not read or delete knowledge.

## Offline graph and reader

The `graph` action returns an HTML file path to open manually in a browser. The file embeds a snapshot of the concepts, has no external assets or network requests, and is read-only with respect to the source Markdown.

Use Search and Type to filter the visible concepts. Select a graph node or matching-concept button with a pointer or keyboard (`Tab`, then `Enter` or `Space`) to update the plain-text Markdown reader. Related-concept buttons navigate connected concepts. Lines show the selected concept's relationships. An empty bundle has an explicit empty state.

The reader displays untrusted concept text as text, never executable HTML. The exported file contains complete concept contents, not just titles; share it only with the intended audience. Export again after editing concepts to refresh the snapshot. Graph export neither opens a browser automatically nor starts a server.
