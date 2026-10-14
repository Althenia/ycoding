# Stable Meeting baseline

These synthetic SQLite files capture the stable Meeting schema and history at
`df540c74`. Runtime stable-import tests copy them directly into an isolated stable
data directory; materialization requires neither Bun nor the TypeScript Meeting
implementation.

- `checkpointed/meetings.sqlite` contains the closed store, without sidecars.
- `wal/meetings.sqlite`, `wal/meetings.sqlite-wal`, and `wal/meetings.sqlite-shm`
  capture the same store before its writer closed. The WAL and SHM are nonempty.
  The main database alone has nine empty tables; the captured WAL supplies all
  nine rows. The source is a frozen uncheckpointed store, not a running writer.
- `snapshot.json` exposes the complete schema, indexes, rowids, stored row values,
  pragmas, file lengths, and SHA-256 hashes for review. Each of the nine provenance
  tables has one row. JSON strings preserve their original bytes, including Thai
  text, surrounding raw-text whitespace, and captured meeting timestamps.

Binary files retain the exact SQLite page layout, WAL frames, and SHM state. A SQL
dump alone cannot preserve those bytes. Never open the committed databases in
place: SQLite may checkpoint them or rewrite their sidecars. `verify.ts` inspects
private copies and verifies both states against the reviewed snapshot.

The persisted pragmas include `user_version=1`, `journal_mode=wal`, UTF-8 encoding,
and a 4096-byte page size. The stable writer's connection-local settings are
`foreign_keys=ON`, `busy_timeout=5000`, `synchronous=FULL`, and `secure_delete=ON`;
they are applied only to verification copies because they are not all persisted
in the database. Integrity and foreign-key checks must return `ok` and no rows.

## Verification

From the repository root:

```sh
bun run extensions/meeting/test/fixture/stable-meeting/verify.ts
```

To compare another capture containing `checkpointed/` and `wal/` directories,
pass its directory as the first argument. The comparison checks every file's
length and SHA-256, complete schema, all nine tables' rowids and values, all listed
pragmas, integrity, and equality of the checkpointed and WAL-backed logical state.

## Capture and equivalence evidence

The baseline was generated exactly once with Bun 1.4.3 from the stable store at
`df540c74`: capture all three files after the writer's `ready` signal, then close
the same writer and capture its checkpointed database. Before deleting the
fixture-generation program, the comparison command was:

```sh
bun run extensions/meeting/test/fixture/stable-meeting/verify.ts .verification-tmp/meeting-fixture/generated
```

It exited 0 with `Stable Meeting baseline: bytes, schema, nine-table rows, pragmas
and integrity match`. All four files were byte-identical to the capture. The
checkpointed and WAL-backed views had identical schema, rows, and pragmas. The
runtime import suite retains source/sidecar byte-preservation, nine-table
provenance, absence, restart idempotency, marker recovery, and corruption-isolation
assertions; it also requires a nonempty captured SHM.
