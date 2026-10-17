# Rust third-party notices

`script/rust-notices.ts` owns the generated section of the root `NOTICE`, delimited by the
`BEGIN GENERATED RUST THIRD-PARTY NOTICES` and `END GENERATED RUST THIRD-PARTY NOTICES` marker lines. Text
before the section is hand-maintained and is never modified.

## Commands

Run from the repository root with the locked registry sources available offline:

```sh
bun script/rust-notices.ts          # regenerate NOTICE
bun script/rust-notices.ts --check  # exit 1 when NOTICE differs from the generated output
bun test --cwd script ./rust-notices.test.ts
```

## Closure

The generator runs `cargo tree --offline --locked -p ycoding-runtime -e normal --no-dedupe` for each target in
`sources.json` and unions the results. Procedural-macro subtrees, build scripts, development dependencies, and
workspace crates are excluded. Every remaining package must resolve to a crates.io package in `cargo metadata`.

## Evidence rules

Generation fails on any of these conditions:

- A crate ships no license, copying, notice, or copyright file and has no supplement or election.
- The shipped texts do not evidence the crate's SPDX expression (an `OR` needs one satisfied side, an `AND` all). A `WITH` exception is supported only for `Apache-2.0 WITH LLVM-exception` and needs the exception text; any other exception fails.
- `sources.json` contains a `nested` action other than `include` or `exclude`, an empty reason, or a duplicate `nested` (crate and path), election, correction, or header entry.
- A license file below the crate root has no `include` or `exclude` rule in `nested`, or a rule names a missing file or
  a crate outside the closure.
- A supplement, election, correction, or header entry names a crate version outside the closure, ships alongside
  packaged license text, or fails its digest or marker check.
- The DuckDB archive's `third_party` directories differ from `native.duckdb.licenses`, or the SQLite source lacks its
  public-domain dedication.
- A repository-owned license file listed in `embedded` or the models.dev license digest is missing or changed.

## Data (`sources.json`, `texts/`)

| Key | Meaning |
| --- | --- |
| `targets` | Release artifacts and the Rust target triple each is built for; must match the release workflow matrix. |
| `nested` | Include or exclude decision with a reason for each license file below a crate root. |
| `supplements` | Upstream license files for crates that publish none, pinned by repository, revision, path, URL, and SHA-256. |
| `elections` | Owner-approved election of one offered license for a crate version whose package and upstream publish no text. The canonical Apache-2.0 text is pinned by SHA-256; the package must still contain the stated grant. `caveats` records unresolved upstream matters and is printed with the election. |
| `corrections` | Owner-approved evidence that a crate version's declared SPDX metadata is wrong, pinned to the declared value. |
| `headers` | Source-header notices reproduced from a crate file between two marker strings. |
| `native` | DuckDB `third_party` licenses (pinned to the DuckDB revision recorded in the crate) and the SQLite dedication. |
| `embedded` | License files kept in this repository for ported code. |
| `models` | License of the bundled models.dev snapshot. |

Entries exist only for evidence that was read and hashed. When a crate version changes, the pinned entries fail
until their evidence is re-read; update `sources.json` and `texts/` together with the version, then regenerate.
`texts/evidence/` holds upstream files that justify an election and are not reproduced in `NOTICE`.
