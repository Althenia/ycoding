# cca-noise-reference

Rust Clatter 2.2.0 reference initiator for the CCA Noise interop tests
(`packages/cli/test/cca-noise.test.ts` and
`packages/cli/test/cca-noise-carrier.integration.test.ts`). It speaks a
line-delimited JSON protocol on stdin/stdout: `start`, `finish`, `encrypt`,
`decrypt`.

Build from the repository root:

```sh
CARGO_HOME=/tmp/ycoding-cargo-home CARGO_TARGET_DIR=/tmp/ycoding-cargo-target CARGO_BUILD_JOBS=2 \
  cargo build --release --manifest-path packages/cli/test/fixture/cca-noise-reference/Cargo.toml
```

The binary lands at `/tmp/ycoding-cargo-target/release/cca-noise-reference`.
Tests resolve it through `CCA_NOISE_REFERENCE_BIN`, defaulting to that path,
and fail when it is missing.
