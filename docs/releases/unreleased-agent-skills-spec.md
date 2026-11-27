# Agent Skills specification alignment

## Changed

- A skill is a `<directory>/SKILL.md` file whose `name` equals the directory name. Root-level `*.md` files and `SKILL.md` files nested under a skill's `references/` or `assets/` are no longer skills. Discovery stops descending at the first `SKILL.md`.
- Discovery validates `name` (lowercase letters, digits and single hyphens, at most 64 characters), `description` (required, at most 1024 characters), `compatibility` (at most 500 characters), and the string types of `license` and `allowed-tools`. A skill that fails is skipped and reported as a diagnostic.
- YCoding-specific skill settings moved into the specification's string-valued `metadata` map without a prefix: `display-name`, `slash`, `conflicts` and `instruction-conflicts` (comma-separated lists). The `ycoding/slash`, `ycoding/autoinvoke` and `ycoding/conflicts` spellings and the top-level `slash` field are gone. Automatic selection is controlled only by `metadata.activation`.
- Managed project-artifact skills are rendered as specification-conformant `SKILL.md` files. The artifact ID is the skill `name`, the artifact name becomes `display-name`, and `project_artifact` guidance describes the specification's name, description and 500-line body limits.
- URL skill catalogs list only `SKILL.md` files; the `<name>.md` alternative is no longer accepted.
- The duplicate `core/project-artifact-authoring` instruction is removed. The `ycoding/project-artifact-authoring` instruction remains.
- Skill discovery produces retrieval documents through the shared recall document type. Each document carries kind `skill`, a scope (project, global and built-in sources map to project, knowledge and workspace), the source path, a revision and a SHA-256 content hash, title, description, body, tags, keywords, identifiers, conflict relationships, and the `auto` or `manual` activation signal. Managed artifact skills take their revision and content hash from the stored version and are marked verified. Discovery reads `metadata.tags` for these documents.
- The bundled Dots operator skill is `session-operator`; the `ycoding-` prefix is gone from its name, directory, source files and installed path. The service removes the `ycoding-operator` file that earlier versions installed under `<data>/dots/skills`. The `ycoding-dots-skills` capability root ID is unchanged.
- Skills can describe themselves with string `metadata` keys `purpose`, `applicability`, `triggers`, `capabilities`, `prerequisites` and `related`. Discovery rejects a blank, non-string or oversized value, and every built-in skill declares all six. These keys feed the skill's retrieval document and never activate it.
- Built-in skills now produce retrieval documents with the same fields as directory skills.

## Removed

- The automatic cleanup of generated skill directories that carried a legacy marker file. Reset now covers managed artifacts and generated skills explicitly.
