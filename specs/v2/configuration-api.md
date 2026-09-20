# Configuration API

The configuration API exposes the Location-scoped configuration owner over HTTP. It is an additive
surface: the runtime reads configuration the same way it did before, and this API only adds a
validated read, preview, and write path for the same owner.

## Ownership

`@ycoding/v2/Config` remains the single configuration owner. The API adds no second store, no
parallel reader, and no client-side merge. Every value the API returns is produced by the same
`Config.latest` fold the runtime uses, and every write goes through the same `Info` schema that
validates configuration files at load time.

The service is Location-scoped. `Location` is resolved per request by the standard Location
middleware, so a request with no `location` query resolves the server's default Location.

## Operations

| Method | Path                  | Purpose                                           |
| ------ | --------------------- | ------------------------------------------------- |
| `GET`  | `/api/config`         | Effective values with provenance and redaction.   |
| `POST` | `/api/config/preview` | Validate a patch; return changes and revisions.   |
| `PUT`  | `/api/config`         | Commit a validated patch and return the readback. |

All three accept the shared `LocationQuery` and return `Location.response`, so the response reports
the resolved Location alongside `data`.

## Read

`Config.Read` carries two fields:

- `values`: effective top-level configuration values, keyed by top-level configuration key. A key
  no document defines is absent.
- `sources`: contributing documents in ascending priority, each with its absolute `path`, its
  `scope`, the top-level `keys` it defines, and its `revision`.

`scope` is `global` for documents under the platform configuration directory, `project` for any
discovered project document, and `virtual` for a document without a file path, such as well-known
integration configuration or inline `YCODING_CONFIG_CONTENT`.

`revision` is the SHA-256 of the document's raw bytes before `{env:}` and `{file:}` substitution.
Because the token text is part of the digest, an edit that only changes a substitution token still
changes the revision. A virtual or unreadable document falls back to the digest of its decoded
value set so clients can still report provenance.

### Redaction

Reads never return resolved credential material. Provider `headers`, MCP `environment`, and
credential field names such as `apiKey`, `client_secret`, and `access_token` are replaced by the
sentinel `[redacted]`. Keys remain visible so a client can report which values are configured
without receiving them. A patch may set these values; the API does not return them back.
Preview and commit `changes` apply the same redaction as read values; persisted values
retain the submitted content. Schema-validation rejections identify affected recognized
top-level keys without echoing submitted values or arbitrary unknown key names.

## Preview

`Config.Patch` is the request payload:

- `patch`: top-level keys to set. A `null` value removes the key. A nested object replaces the whole
  subtree at that key.
- `scope`: `global` or `project`. There is no `session` scope; session overrides belong to the
  session contract and are not configuration files.
- `expectedRevision`: optional revision from a previous read or preview.

The payload has no path field. The write target is always the document discovery already found for
the requested scope, so a client cannot choose an arbitrary filesystem path.

`Config.Preview` reports the `scope`, the resolved `path`, the `revision` the patch was validated
against, the `result` revision the document would have after the patch, and the list of `changes`.
Preview writes nothing. Pass the reported `revision` back as `expectedRevision` to commit; a
concurrent edit is then rejected rather than silently overwritten.

Validation rejects before any write:

- keys the current runtime removed, such as `server`, `permission`, or a legacy `mcp` server map;
- values the `Info` schema rejects, including unknown top-level keys;
- a scope that has no configuration document to write.

Rejections return `ConfigInvalidError` with an actionable `message`, the affected `path` when one is
known, and HTTP 400. The message never contains file contents or credential material.

## Commit

`Config.Commit` reports the `scope`, `path`, and new `revision`, the applied `changes`, the settled
`read`, and `unsettled` keys.

`unsettled` lists patched keys whose effective value is still owned by another document after the
write. Removing a project value that a global document also defines is the common case: the write
succeeds, the project key is gone, and the effective value settles back to the global one.

### Preservation and atomicity

The write edits the existing document with JSONC path edits rather than re-serializing a parsed
value, so comments, formatting, unknown unrelated fields, and `{env:}`/`{file:}` substitution tokens
survive the roundtrip. The edit is written to a temporary file in the same directory and renamed
over the target. An existing restrictive file mode is preserved.

After a committed write the service re-runs discovery, reloads derived policies, and publishes
`config.updated`, so consumers observe the new effective values through the existing reload path.

## Errors

| Status | Error                | Condition                                              |
| ------ | -------------------- | ------------------------------------------------------ |
| `400`  | `ConfigInvalidError` | Invalid patch, removed key, stale revision, no target. |
| `401`  | `UnauthorizedError`  | Missing or invalid server authorization.               |

## Related

- Runtime configuration keys, discovery order, and substitution: [`docs/configuration.md`](../../docs/configuration.md).
- Location resolution and the `LocationQuery` contract: [`packages/protocol/src/groups/location.ts`](../../packages/protocol/src/groups/location.ts).
- Configuration schema: `Config.Info` in [`packages/core/src/config.ts`](../../packages/core/src/config.ts).
