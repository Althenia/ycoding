# Local OpenSSL source adaptation

This package is an unpublished local adaptation. The manifest version `300.5.7+3.5.7` identifies the local package; it is not a published `openssl-src` release.

## Sources

- Builder: published `openssl-src` `300.5.5+3.5.5`, archive SHA-256 `3f1787d533e03597a7934fd0a765f0d28e94ecc5fb7789f8053b1e699a56f709`, matching its Cargo registry index checksum. Package: <https://crates.io/crates/openssl-src/300.5.5+3.5.5>.
- Native source: official OpenSSL `3.5.7` distribution, archive SHA-256 `a8c0d28a529ca480f9f36cf5792e2cd21984552a3c8e4aa11a24aa31aeac98e8`. Archive: <https://www.openssl.org/source/openssl-3.5.7.tar.gz>.

The `openssl/` tree uses the official distribution's source files without Node-specific include wrappers or the Node `x86asm.pl` modification. It omits three example private-key files that the library build does not use: `apps/rsa8192.pem`, `demos/cms/cakey.pem`, and `demos/smime/cakey.pem`. Generate native headers through OpenSSL's Configure build, not Node's separate configuration tree.

## Builder changes

`src/lib.rs` preserves the published builder's feature handling, crypto selections, target mappings, platform/compiler/linker handling and error propagation. Its only local source changes are:

1. Emit `cargo:rerun-if-changed` for the native source directory when `try_build` runs, so Cargo tracks native source changes.
2. Keep `no-docs` and `no-demos` alongside the published builder's `no-tests`, preserving the library-only build selection.

`build.rs` tracks the absolute path to the manifest. Cargo rebuilds `openssl-src` when switching checkouts that share a target directory, even if the previous checkout still exists. `openssl-sys` then uses the native source from the current checkout. Repeat builds in the same checkout can reuse the builder.

The local manifest is retained separately from the published crate's generated manifest. It keeps the local version label, the existing `cc = "1.0"` declaration and the published feature names; the published manifest declares `cc = "1.0.79"`. Feature selections are implemented by the restored builder, not silently ignored.

## Licenses

- `LICENSE-MIT` and `LICENSE-APACHE` are unchanged published builder license texts.
- `openssl/LICENSE.txt` is the unchanged official OpenSSL license text.

Archive checksums establish the retained source identities. No detached-signature authentication is claimed here.
