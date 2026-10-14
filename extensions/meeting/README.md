# Meeting clients and runtime bridge

The Rust `ycoding-runtime --meeting` option starts one Meeting service for each
booted Location. The service owns its Meeting database, capture leases,
transcription worker, settings, and restricted analysis Sessions. The terminal
view, native control client and live page use its authenticated numeric-loopback
HTTP bridge; Meeting has no v5 operations.

The private discovery descriptor is
`$XDG_DATA_HOME/ycoding/meeting/<location-key>/bridge.json`, where the key is the
first 32 hexadecimal characters of SHA-256 over the canonical Location path.
Without `XDG_DATA_HOME`, the base is `~/.local/share`. Clients require a regular,
non-symlink descriptor of at most 4096 bytes owned by the current user, without
group or other access. Its exact fields are `url`, `token`, and `pid`.

With `YCODING_CHANNEL=beta`, discovery and runtime storage use
`$XDG_DATA_HOME/ycoding-beta/meeting/<location-key>` with the same canonical key.
On that Location's first beta start, a stable
`ycoding/meeting/<location-key>/meetings.sqlite` is copied with its SQLite
sidecars to private scratch, imported and verified, then atomically published as
`ycoding-beta/meeting/<location-key>/meetings.redb`. Stable files remain unchanged.
The beta directory's private `stable-import-v1.json` records whether a source was
present. Restarts keep the beta store; a missing marker is reconstructed only
from completed import provenance. A failed import publishes no partial store or
completion marker and logs a Location-scoped failure without stopping the server.
Saved Meeting settings remain local to each channel's directory.

Native clients authenticate `/control` with the descriptor token and send no
Origin. `{"action":"view"}` returns a live-page URL whose fragment carries a
separate view key. The page uses that key for `/view/state`, `/view/control`,
`/view/ask`, and `/view/capture`; it cannot install models, reconfigure the runtime,
or use native control authority. Capture starts only after a meeting is armed
and the page confirms fresh consent. Closing or losing the capture page expires
the lease; no raw audio is persisted.

The runtime embeds the HTML, CSS and fonts, JavaScript modules, and brand mark
from `view`, preserving the exact asset responses and security policy in
`view/assets.ts`. It also embeds `python/worker.py` and passes it to the configured
`pythonExecutable` with `-c`. Neither source nor packaged runs need adjacent page
or worker files. Python and speech dependencies must be available locally;
model installation always requires explicit authorization.

Saved `settings.json` in the Meeting directory takes precedence over defaults.
Starting the service neither downloads weights nor records audio. See
[`docs/configuration.md`](../../docs/configuration.md#meeting-capture) and
[`rust/crates/core/README.md`](../../rust/crates/core/README.md#meeting) for the
runtime and wire constraints.

## Checks

Run from the repository root:

```sh
bun run --cwd extensions/meeting test:unit
bun run --cwd extensions/meeting typecheck
~/.cache/ycoding/cargo-gate.sh bun run --cwd extensions/meeting test:integration
~/.cache/ycoding/cargo-gate.sh cargo test --manifest-path rust/Cargo.toml --locked -p ycoding-core --test 'meeting_*'
~/.cache/ycoding/cargo-gate.sh cargo test --manifest-path rust/Cargo.toml --locked -p ycoding-runtime --test production --test meeting_clients
~/.cache/ycoding/cargo-gate.sh cargo test --manifest-path rust/Cargo.toml --locked -p ycoding-runtime --test meeting_import --test launcher
```

The `meeting_clients` integration test copies the real runtime binary to a
directory without release assets, boots it with `--meeting`, and runs the
existing discovery/control, live-page delivery and rendered TUI clients against
its bridge. Its local protocol worker substitutes only speech inference; it
checks exact embedded assets, native/view credential separation, capture and
finalization, transcript rendering, and shutdown cleanup. It does not prove
native audio capture or Windows behavior.

The source launcher (`bun run extensions/meeting/script/dev.ts <project>`) starts
a private Rust runtime with `--meeting` and attaches the source TUI with its
terminal plugin. It requires a built `rust/target/debug/ycoding-runtime`, or
`YCODING_RUNTIME_EXECUTABLE`. The integration fixtures use this launcher in both
normal and beta channels and prove a nonempty live MCP registry round trip.

`bun run --cwd extensions/meeting test:integration:chrome` uses the real Rust
runtime and browser-owned capture with controlled speech/model/media fixtures.
Set `YCODING_TEST_ISOLATED_BROWSER_CHROME` to Chrome for Testing. The optional-state
display case omits only read-only diagnostics; capture, controls and persistence
remain Rust-owned. No native picker, live Meet call or actual model is proved.
