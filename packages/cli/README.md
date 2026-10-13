# YCoding CLI

The CLI owns command presentation, local-service discovery, native packaging, installer/updater integration and TUI startup. The Rust runtime owns execution and durable state.

Native builds embed the host-target `ycoding-runtime` inside `ycoding`. Launch extracts the payload to a version- and digest-specific path under the YCoding bin directory; it adds no release-archive entry. `serve`, `serve --service`, `serve --stdio` and `serve --meeting` start that executable. Service discovery uses its private registration and authenticated readiness/stop endpoints. The frontend does not open or recover the backend database or install a backend observability exporter.

For source execution, build `rust/crates/runtime` first. Set `YCODING_RUNTIME_EXECUTABLE` to select a source runtime explicitly; installed builds use their embedded payload. See [runtime configuration](../../docs/configuration.md#rust-runtime-executable).
