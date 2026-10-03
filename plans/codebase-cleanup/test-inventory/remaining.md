# SL remaining-package retention inventory

Local evidence; do not commit. Source baseline: cleanup `ecfaff06`; no production changes in these packages. Review combines live public exports, caller tests, named cases and their assertions, and per-file JUnit runs. Generated client source and SVG/PNG assets are public/artifact outputs, not production-source inspection; retain their contract/design gates. No arbitrary test-count reduction.

All named cases in each group below are kept at their existing assertion sites, except the provided-client HTTP case rewritten below. Reasons apply to the entire stated case group; no case is approved for deletion. Runtime execution expands to 240 passing cases across 21 files. Mixed real local-server/socket and unit boundaries are not labeled unit-only. Each file ran separately as `bun test --cwd <package> <relative-test-file> --timeout 30000 --reporter=junit --reporter-outfile=<temporary-output>` under an 8 GiB process-tree cap. Every command exited 0. Wall times include process startup and concurrent work in other lanes, not exclusive-machine measurements.

| File / case group | Cases | Class / retained behavior and assertion boundary | Layer | Baseline wall s |
|---|---:|---|---|---:|
| effect-drizzle-sqlite/test/sqlite.test.ts | 7 | keep: selection, transaction commit, failure and explicit rollback, lock error, returning/empty updates, migration idempotency; exact query rows and typed failure assertions | real SQLite adapter integration | 0.077 |
| http-recorder/test/cassette.test.ts | 8 | keep: secret-write prevention, failed append integrity, concurrent appends, metadata ownership, malformed/path rejection, lifecycle and listing; persisted rows/files and typed outcomes | cassette memory/filesystem integration | 0.149 |
| http-recorder/test/http.test.ts | 18 | keep/rewrite: supplied-client layer, ordered/out-of-order/concurrent replay, exhaustion/nonconsumption, redacted diagnostics, unused/missing cassette, CI and auto modes, ordered recordings, live-versus-redacted response, null-body and binary bytes | real recorder with local HTTP transport and replay | 0.135 |
| http-recorder/test/redaction.test.ts | 10 | keep: query/credentials/headers/error/metadata/body secrecy, additive options and unchanged safe JSON bytes; isolated rule assertions plus public HTTP/WebSocket flows | isolated trust-boundary rules | 0.087 |
| http-recorder/test/websocket.test.ts | 11 | keep: constructor scope, URL/protocol validation, causal ordering, public decorator, concurrent handlers, single ownership/nonconsumption, unfinished close, failed recording and binary reconnects; exact frames, files, errors, Deferred completion | recorder/socket integration with verified external ports | 0.137 |
| httpapi-codegen/test/generate.test.ts | 77 | keep: one compiled contract and both emitters, authoritative imports, nested names/collisions/prototype safety, wire types, transport channels, status/error/SSE/binary outcomes, schema/codecs, safe paths and strict generated-consumer compilation; compiled contract, generated output and executed client assertions are distinct boundaries | compiler/emitter contracts plus generated-client flows | 0.200 |
| httpapi-codegen/test/write.test.ts | 6 | keep: output containment, manifest-owned cleanup, unsafe/duplicate/case-collision/private-manifest/symlink refusal; real filesystem outcomes | generated-output integrity integration | 0.141 |
| remote/test/base64.test.ts | 1 | keep: admitted base64 grammar and trailing-bit contract; accepted/rejected encoded values | wire contract | 0.012 |
| remote/test/completions.test.ts | 5 | keep: agent-only bounded completion/guardrail roots, duplicate/content rejection, serialized minimal identity, optional bounded titles; parser/serializer outcomes | closed remote wire contract | 0.012 |
| remote/test/contract.test.ts | 47 | keep: strict operation inputs, bounds, role surfaces, ownership-related IDs, enrollment/signature vocabulary, request/response/chunks/status/alert/notice shapes; parsers reject extra/unbounded/wrong-surface values | closed remote contract/security boundary | 0.022 |
| remote/test/streams.test.ts | 8 | keep: ordered bounded batches, control-surface cancellation and priority translation, wrong-surface/malformed rejection; exact accepted frames and rejection outcomes | closed remote wire contract | 0.013 |
| simulation/test/actions.test.ts | 7 | keep: literal matching, key normalization, actual click/semantic identity, lazy snapshot state, duplicate/invalid semantics; rendered interaction and refusal assertions | renderer/action integration | 0.176 |
| simulation/test/brand-assets.test.ts | 4 | keep: owned geometry/palette, maskable safe zone, even icon margins and exact generated dimensions; SVG artifact and actual decoded pixels | design/artifact drift | 1.105 |
| simulation/test/frontend-server.test.ts | 1 | keep: handshake/state/capture/snapshot/malformed JSON and cleanup; real socket responses and successful port rebound | frontend server/renderer flow | 0.137 |
| simulation/test/manifest.test.ts | 2 | keep: decoded manifest and typed invalid-schema failure | public configuration contract | 0.084 |
| simulation/test/network.test.ts | 1 | keep: scoped route/log isolation and unmatched failure | network-service isolation | 0.088 |
| simulation/test/openai.test.ts | 3 | keep: exact SSE text/finish/tool-input wire and typed malformed JSON refusal | provider-neutral event-to-wire flow | 0.091 |
| simulation/test/png.test.ts | 4 | keep: valid frame dimensions/PNG, real symbol pixels distinct from missing glyph, adjacent blocks and heavy box-boundary rendering | actual raster rendering regressions | 0.147 |
| simulation/test/protocol.test.ts | 10 | keep: UI text/click/snapshot, tool lifecycle uniqueness, shared handshake decoding, versions/capabilities/roles and supported/optional semantics; schema and real dispatch outcomes | public control contract | 0.089 |
| simulation/test/recording.test.ts | 3 | keep: versioned ANSI timeline, renderer-destroy completion and live text while recording; decoded files and renderer outcomes | recording/renderer integration | 0.083 |
| simulation/test/simulated-provider.test.ts | 7 | keep: stream settlement, late attach/replacement, interruption/backpressure/disconnect and scoped SDK tool overlays with progress/ordering/replay/cancellation; actual queues, streams, results and errors | backend/controller/SDK integration | 1.384 |

Total measured per-file wall time: 4.369 s. No removed group needs a mutation probe. No source-text assertions or success-path sleeps found in these reviewed groups requiring deletion; generated-code output assertions and design-asset checks remain required. Existing assertion-free waits for absent unused cassette or concurrent socket handlers assert successful lifecycle completion, not mock call counts.

## Supplied-client response guard (G14)

The `HttpRecorder.layer` test used the provided-client public export but discarded both response bodies. Other response tests exercised the Fetch-composed export. Rewrite the same case to assert the two recorded replies `first` then `second` through the supplied-client boundary. Derive expected bytes from the existing admitted cassette requests and response fixture; no fixture regeneration, network access, or production changes.

Baseline file: 18 pass, exit 0. Revised `bun test --cwd packages/http-recorder test/http.test.ts --reporter=junit --reporter-outfile=<temporary-output>`: exit 0, 18 pass, 35 assertions, 0.104 s. Touched-file oxlint: exit 0, zero warnings/errors.

Discrimination probe: temporarily return a wrong response body from `responseFromSnapshot`; `bun test --cwd packages/http-recorder test/http.test.ts -t 'decorates a provided'` exits 1 with the exact two-body mismatch (1 fail, 17 filtered). Restore exact production expression. Remaining stability/typecheck checks are pending; no completion claim for this rewritten group yet.

## AC15 pass (lane `ai-contracts`, base `d30e97bf`)

Live per-file JUnit at `d30e97bf` reproduces every row above: 21 files, 240 cases, 0 failures (summed JUnit seconds: remote 0.029, http-recorder 0.401, httpapi-codegen 0.657, effect-drizzle-sqlite 0.223, simulation 2.781). `packages/effect-sqlite-node` has no tests. No file in these packages changed in this pass, so no probe or stability run was required; the G14 supplied-client rewrite is already on the base and its file passed (18 cases).

Previously unclassified files in scope, all `keep`:

| File / case group | Cases | Class / retained behavior | Layer | JUnit s |
|---|---:|---|---|---:|
| script/build-web-assets.test.ts | 6 | keep: release contract; public installer/config/font-license publication, no internal docs, unsafe-path and missing-input refusal, owner build step | build script integration | 1.871 |
| script/chrome-for-testing.test.ts | 10 | keep: release contract; Stable mac-arm64 provisioning, minimum major, corrupt/mismatched archive refusal, HTTPS-only, CLI argument failure | provisioning script with fixture transport | 0.062 |
| script/install.test.ts | 46 (10 macOS-only skips) | keep: release contract; installer PATH/profile rules, checksum and rollback, archive entry limits and unknown-entry skipping, updater-accepted layout, extension install, argument refusal (including removed `--office`) | real shell installer against fixture releases | 2.660 |
| script/release.test.ts | 35 | keep: release contract; workflow ordering, signing, archive layout, notes, deployment gating, cache policy | workflow contract | 0.490 |
| script/typecheck-cache.integration.test.ts | 3 | keep: required AGENTS gate for Turbo typecheck inputs | Turbo integration | 2.352 |
| script/ycoding-package-identity.test.ts | 3 | keep: package scope and published executable identity | workspace contract | 0.011 |
| script/ycoding-rebrand.test.ts | 3 | keep: rebrand policy rewrite/preserve/classify rules | brand trust boundary | 0.003 |
| script/ycoding-residuals.test.ts | 3 | keep: brand residual scanner, including the removed office client path | brand gate | 0.002 |
| script/ycoding-workspace.test.ts | 2 | keep: approved workspace package set | workspace contract | 0.010 |
| packages/script/test/preview-build.test.ts | 2 | keep: preview build numbering uniqueness and stability | release versioning | 0.001 |

`script/*.test.ts` totals 9 files, 111 cases (101 pass, 10 skipped because the host is not macOS), 1,873 lines, 7.461 summed JUnit seconds. These are always-kept release contracts; no deduplication was justified (the two `test.each` groups already table their rows). Their workflow and installer text assertions are the release contract itself, not production-source inspection.
