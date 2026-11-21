# Ordinary user-app main producer

Each CLI artifact exports `openUserApp(selection, options)` beside `run` through its `server-process` subpath. `@ycoding-ai/cli/server-process` uses the root mirror only for an explicitly selected host handoff. `run` retains its Effect contract. The producer runs in Node/main, not a renderer.

```ts
openUserApp(
  selection: { mode: "managed" } | { mode: "external"; url: string } | { mode: "private" },
  options: { location: NonNullable<V5Options["location"]>; signal?: AbortSignal },
): Promise<{ readonly api: Omit<V5Client, "transport">; close(): Promise<void> }>
```

The selected Location is explicit and must name an existing absolute directory. The returned API physically excludes `transport`. It includes no service restart or reconnect controller, endpoint, password or command. Native v5 method types, RequestOptions signals, typed event iterables, iterator return, unsubscribe, unsent/unknown delivery status, domain rejection and resync semantics remain Client-owned. Uncertain mutations are never replayed.

## Selection and identity

- Managed selection uses the installed channel's registration/config namespace and the installed frontend command. Shared Service.ensure receives the exact installed version and `existing: "preserve"`. Every observed incumbent is preserved: incompatible, failed, legacy and ambiguous owners fail rather than being stopped or replaced; compatible waiting owners remain owned by their existing process. Missing registration permits normal contenders. Cancellation and handle close do not stop or restart managed owners or contenders. The producer rejects version mismatch and fences registration URL, PID, instance ID, version and password across acquisition, health and handshake. Native registration ID equals the server's source epoch.
- External selection uses the explicitly selected HTTP(S) URL and the existing main-side password binding. It neither starts nor stops the server. Authentication and exact-version mismatch fail. HTTP and WebSocket redirects are disabled.
- Private selection launches the verified native payload with the selected Location as cwd and the verified frontend executable passed explicitly. The native child issues a URL-only readiness line. Health PID must equal the owned child PID; health source epoch must equal native v5 Ready source epoch. Native v5 verifies wire revision, digest, peer role and connection epochs. No profile or health equivalence is fabricated.

Opening cancellation cancels acquisition only. After opening succeeds, its signal is detached. Operation signals retain their existing Client meaning.

## Lifetime

The handle retains its Scope. `close()` immediately retires the API, settles pending operations/subscriptions, and always returns the same promise. That promise waits for the owned WebSocket's actual close event. The Node ws adapter preserves explicit authentication headers, enforces the v5 server-frame limit, and disables compression and redirects.

Managed and external close only their client. Private close also closes its retained server Scope and awaits native process/attachment close and join. Native acquire/release owns the awaited memoized cleanup; calling `retire()` alone is not its receipt. Cleanup failure, nonzero exit and forced termination reject shutdown rather than reporting success.

## Artifact and errors

The shipped ESM module and declarations reside in `lib`. Its packet contains the matching frontend executable, native Brotli payload, installed version/channel, OS/architecture, native v5 revision/digest and SHA-256 bindings for module, declarations, frontend, payload and decompressed native executable. Both canonical builders assemble this packet using their existing native/runtime assets. Library-only Node output is not a usable packet without its bound frontend. Missing or mismatched packets fail; the producer never resolves Cargo/source executables or derives its frontend command from the embedding process. Existing output is not overwritten or deleted by the packet assembler.

Every artifact owns a separate packet. The canonical builders mirror a packet into the root `lib` only when `--target=<host-os>-<host-arch>` explicitly selects a single matching host. An implicit host selection or a multi-target plan never creates a root mirror. Existing artifact and root directories are preserved through exclusive creation. Root mirrors are host-specific; no optional-platform dispatcher or implicit host choice is provided.

Opening and close errors contain only fixed codes and bounded messages, without raw causes, stack paths, endpoint URLs, credentials, environment, stderr or command paths:

| Code           | Message                                            |
| -------------- | -------------------------------------------------- |
| artifact       | The installed user-app artifact is invalid.        |
| configuration  | The user-app configuration is invalid.             |
| authentication | The selected server rejected authentication.       |
| version        | The selected server version is incompatible.       |
| contract       | The selected server has an incompatible contract.  |
| identity       | The selected server identity changed.              |
| cancelled      | Opening the user-app connection was cancelled.     |
| unavailable    | The selected server is unavailable.                |
| shutdown       | The user-app connection did not shut down cleanly. |

This API adds no task admission, credential, grant, ceiling carrier or trust-policy exception. The generic desktop bridge remains fail-closed. Renderer IPC, bundled-content provenance, handler allow-lists, navigation restrictions and Electron runtime compatibility belong to the embedding application.
