# Tagged project artifacts and tag recall

## Added

- Skills, commands and agents can carry up to eight lowercase tags. The `project_artifact` tool accepts `tags` on write, and replacing the list in a later version replaces the old tags.
- `project_artifact` with `action: "search"` lists a project's recallable artifacts by query, tags or both. Results are names, descriptions, tags and version identity only, never artifact content. Ranking uses the same lexical retrieval as memory and skill selection.
- Search is read-only, limited to the calling project, and applies the session's `project_artifact` permission to each hit. It reads only trial and active artifacts whose stored bytes match the recorded digest, so deleted, disabled, replaced or altered artifacts never appear.
- A manually written managed skill can carry unprefixed `metadata` activation keys (`activation: auto`, `version`, `keywords`, `events`, `commands`, `paths`). They survive create and edit, read back with the skill, and select it only on a matching cue that the session's skill permission allows. Model-written artifacts cannot set them.

## Changed

- Artifacts without tags keep working and remain searchable by query. Tags and artifact content carry no trust and never create skills or run anything.
- An `artifact.update` over the v5 connection keeps the stored tags and activation metadata, because its definition does not carry them. The server reads the current version, checks its digest and merges the two before writing, so a legacy client edit no longer drops them. Replacing tags goes through the `project_artifact` tool.
