# YCoding CLI

The CLI owns command presentation, local-service discovery, native packaging, installer/updater integration and TUI startup. The Rust runtime owns execution and durable state.

Native builds embed the host-target `ycoding-runtime` inside `ycoding`. Launch extracts the payload to a version- and digest-specific path under the YCoding bin directory; it adds no release-archive entry. `serve`, `serve --service`, `serve --stdio` and `serve --meeting` start that executable. Service discovery uses its private registration and authenticated readiness/stop endpoints. The frontend does not open or recover the backend database or install a backend observability exporter.

For source execution, build `rust/crates/runtime` first. Set `YCODING_RUNTIME_EXECUTABLE` to select a source runtime explicitly; installed builds use their embedded payload. See [runtime configuration](../../docs/configuration.md#rust-runtime-executable).

CLI operations use the binary v5 client. `ycoding api <operation> --data '<request JSON>'` resolves a local operation from the v5 catalog and validates its typed request; it accepts neither HTTP methods/paths nor arbitrary HTTP headers. Request JSON follows that operation's `params`, `query` and `payload` shape. Results print as JSON, event subscriptions as one JSON event per line, and file assets as bytes:

```sh
ycoding api health.get
ycoding api session.rename --data '{"params":{"sessionID":"ses_example"},"payload":{"title":"Example"}}'
```

`ycoding remote` submits backend enrollment and connection controls. Enabling the connector grants the enrolled machine owner access to every existing and future backend Session. The CLI reads the redacted device projection, never the runtime's private `remote-device.json`.

`ycoding run -f <file>` submits an absolute file URI, including for large images, rather than base64-inline content. The source remains caller-owned: the CLI neither deletes nor replaces it. Keep it available until durable admission is confirmed; reconcile an unknown admission against the Session before removing it.

`ycoding mcp add` submits `mcp.configure` to the managed backend with the requested project or global scope and reports the backend-selected configuration target. Backend validation, permissions, atomic writes and Location reload own the mutation. TUI registry packages resolve through `frontendPackage.resolve`; the backend returns the verified entrypoint asset, and package requests use the current managed endpoint.
