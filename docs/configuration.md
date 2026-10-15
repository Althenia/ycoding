# Configuration reference

This document specifies configuration for the Rust-backend beta. Rust Core validates runtime JSON/JSONC; the terminal owns `cli.json` presentation preferences. The beta uses explicit trusted process extensions, native provider routes, and revision 5 backend controls. See the [process-extension v5 contract](../specs/process-extension-v5.md) for grants and lifecycle rules.

Runtime builds embed the models.dev snapshot selected by the CLI's `MODELS_DEV_API_JSON`, or its checked-in snapshot when unset. Model discovery prefers configured file/cache data, then the bundled snapshot when disk data is unavailable; refresh is best effort. Bootstrap failures report the composition stage on stderr and retain the `production composition failed` startup error while stdio stdout remains reserved for readiness.

## Configure by task

| Task                                      | Read                                                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Choose which configuration wins           | [Discovery and precedence](#runtime-configuration-discovery-and-precedence), [JSON/JSONC](#json-and-jsonc-behavior).                                                       |
| Connect an account and choose a model     | [Providers and models](#providers-and-models), [profiles](#provider-profiles), [Claude Code accounts](#claude-code-account-profiles), [model selectors](#model-selectors). |
| Control agent authority                   | [Permissions](#permissions), [agents](#agents), [guardrails](#guardrail-configuration-and-custom-files).                                                                   |
| Extend repository behavior                | [Commands](#commands), [skills and instructions](#skills-and-ambient-instructions), [plugins](#plugins-and-hooks), [MCP](#mcp).                                            |
| Manage context and knowledge              | [Compaction](#compaction-and-experimental-settings), [workspace memory](#workspace-memory), [provider efficiency](#provider-efficiency).                                   |
| Adjust presentation and service operation | [CLI/TUI](#clitui-configuration), [managed service](#managed-service-configuration).                                                                                       |

Runtime settings belong in `ycoding.json` or `ycoding.jsonc`; terminal preferences belong in `cli.json`. These surfaces do not substitute for each other.

## Workspace memory

The `memory` runtime object enables explicit repository-memory and shared-knowledge operations. It defaults to `enabled: true`, `max_concept_bytes: 65536`, `max_bundle_bytes: 8388608`, and `max_concepts: 1000`. Its optional `path` selects the managed base instead of `<YCoding data directory>/memory`; `~/` uses the user home and relative paths use the repository's main checkout, or the current Location outside Git. Fields merge independently in normal configuration order.

Setting `enabled: false` preserves existing files. Enabling memory does not create storage, extract transcripts, or recall concepts into prompts. See [Workspace knowledge memory](./memory.md) for examples, workspace identity, permissions, update conflicts, retrieval bounds, and offline graph use.

## Configuration surfaces

YCoding has three independent configuration surfaces:

| Surface                       | Files                                                                                                         | Scope                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime configuration         | `ycoding.json`, `ycoding.jsonc`, `.ycoding/ycoding.json`, `.ycoding/ycoding.jsonc`                            | Models, agents, permissions, MCP, providers, process extensions, skills, commands, references, compaction, formatters, LSP, and runtime behavior. |
| CLI/TUI configuration         | `cli.json` in the YCoding global config directory                                                             | Theme, keybindings, notifications, prompt behavior, transcript presentation, mouse, and terminal integration.                                     |
| Managed-service configuration | `service.json`, `service-local.json`, or `service-<channel-hash>.json` in the YCoding global config directory | Managed background-server hostname, port, and private password.                                                                                   |

The obsolete files `tui.json` and `kv.json` have no effect. Project-local `.ycoding/tui.json` is not a supported configuration source.

## Global directories

The beta channel keeps its own data directory and imports a copy of existing data on first start without changing stable data.

Stable YCoding uses the `ycoding` namespace. The Rust runtime's `beta` channel uses `ycoding-beta` for configuration, state, data, cache, and temporary files. XDG bases must be absolute; unset or relative bases use the home-directory fallbacks below. `ycoding-runtime --paths` emits the resolved `namespace`, `config`, `state`, `data`, `cache`, and `serviceFilename` as JSON without creating directories or starting a server. Configuration and terminal preferences are channel-local; stable files are not copied automatically. Project `ycoding.json`/`ycoding.jsonc` files still participate in discovery.

| Purpose                        | Base                                                           |
| ------------------------------ | -------------------------------------------------------------- |
| Configuration                  | `$XDG_CONFIG_HOME/<namespace>`, or `~/.config/<namespace>`     |
| State and service registration | `$XDG_STATE_HOME/<namespace>`, or `~/.local/state/<namespace>` |
| Data and logs                  | `$XDG_DATA_HOME/<namespace>`, or `~/.local/share/<namespace>`  |
| Cache                          | `$XDG_CACHE_HOME/<namespace>`, or `~/.cache/<namespace>`       |

`YCODING_CONFIG_DIR` overrides the global configuration directory used by the process.

The Rust beta runtime stores its database at `$XDG_DATA_HOME/ycoding-beta/ycoding.redb` (fallback `~/.local/share/ycoding-beta/ycoding.redb`). On first start it imports the stable `$XDG_DATA_HOME/ycoding/ycoding.db` (fallback `~/.local/share/ycoding/ycoding.db`) through the Store SQLite importer. It copies the SQLite file and any WAL or rollback journal into a private, uniquely named directory under `$TMPDIR/ycoding-beta` (the OS temporary directory when unset). SHA-256 fingerprints of the complete original file set before copying, the private copy, and the original after copying must match, including sidecar membership. Observed changes retry at most three times; if stable is writing, first beta start refuses with “close stable and retry” guidance. WAL header evidence or a valid file rollback journal is required. MEMORY/OFF and rollback-header snapshots without a valid journal are conservatively refused because their connection-local modes are indistinguishable on disk. This guard detects observed concurrent modification; it does not stop stable processes or prove quiescence. SQLite recovery and WAL checkpointing run only against the copy; the stable files are never opened through SQLite, checkpointed, or written by the beta runtime. Stable credentials and other stored data remain private in the copy and imported database.

The importer validates the exact supported SQLite schema and resumes a recognizable candidate through private versioned whole-table checkpoints. Resume requires unchanged original database/sidecar and resource fingerprints, matching candidate identity/catalog and verified completed-table digests. A changed source rejects stale staging and starts a fresh generation. Managed attachment and project-artifact content retain their relative identities and bytes in private beta copies. Each store activates only as a complete verified unit: verification precedes final provenance, resource publication precedes atomic database publication, and an atomic private version-2 selection record at `$XDG_STATE_HOME/ycoding-beta/stable-import-v1.json` (fallback `~/.local/state/ycoding-beta/stable-import-v1.json`) binds the sealed database identity/generation, source/copy fingerprints and resource inventory. An absent-source decision is durable before empty-store initialization and survives later stable creation.

Subsequent starts reuse the selected beta store and never merge later stable changes. Cancellation, panic and process death retain recognizable unactivated staging; incomplete copies start a fresh generation. After database publication, marker-loss recovery requires the same identity and retained sealed selection evidence; it never reimports or overwrites acknowledged beta database/resource writes. POSIX publication syncs candidates and directories before the selection record. Invalid or v1 markers, missing selected stores, incompatible storage and unbound existing stores refuse startup without rebind, reset, SQLite fallback or replacement. Original SQLite and resources remain unchanged. Private abandoned files are not discovery state. Core and lazy Meeting imports activate separately; this is not a cross-store coordinated cutover.

## Private evaluation runs

`ycoding run --config <file>` starts a private Rust server and applies the original JSON/JSONC document as `YCODING_CONFIG_CONTENT`, the highest-priority runtime layer. Comments and trailing commas are accepted. The file path resolves from `PWD` (or the process working directory); `{file:...}` references in that inline document resolve from the run directory, not the document's containing directory. Global and project configuration still participate below it.

`ycoding run --isolated` starts a private server with fresh temporary data, cache, state and runtime scratch directories. Its canonical store is `<temporary data>/<namespace>/ycoding.redb`. Stored credentials and Sessions are unavailable; provider environment variables and explicit configuration still work. Existing stable data and beta import markers are outside the private roots and are neither imported nor activated. The temporary tree is removed after the child stops, including startup and run errors. User configuration remains a read source; unrelated user data, configuration, cache and state are unchanged. This isolates runtime storage, not tool or filesystem authority.

```sh
ycoding run --isolated --config ./eval.jsonc --model openai/gpt-5.6-sol "Inspect the fixture"
```

Either flag selects a private server and rejects `--server`. `--config` rejects an unreadable or malformed document and any defined `YCODING_CONFIG_CONTENT`, including an empty value, before allocating isolated data or spawning a server. Without these flags, `run` keeps its normal server selection. `--config` alone uses the normal persistent data roots; combine it with `--isolated` for disposable storage.

## JSON run output

`ycoding run --format json` writes one JSON object per line to standard output. Every line has `type`, `timestamp` (epoch milliseconds), and `sessionID`. Besides `text`, `reasoning`, `tool_use`, and `error` lines, the run reports metrics in three line types. Default text output prints no metrics and performs no usage reads. Optional context, cache telemetry, and ledger prices remain absent when unreported.

- `step_start`: `part.agent` and `part.model` (`providerID`, `id`, and `variant` or `profile` when selected) for the step.
- `step_finish`: `part.reason`, `part.cost` (USD), and `part.tokens` (`input`, `output`, `reasoning`, `cache.read`, `cache.write`). It adds `part.contextLimit`, `part.contextBreakdown`, and `part.providerCache` only when the step reports them.
- `run_finish`: exactly one line after the last event, including after an `error` line and after an interrupted run. It is not written when the run fails before the prompt is submitted or when prompt admission fails with an error.

`run_finish` fields:

| Field            | Meaning                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`         | `succeeded`, `failed` (an error line, a failed execution, or a rejected permission, question, form, or guardrail), or `interrupted`.                                                                                                                                                                                         |
| `durationMs`     | Wall time from just before prompt admission to the end of the run.                                                                                                                                                                                                                                                           |
| `steps`          | Ended and failed steps of the run's own Session.                                                                                                                                                                                                                                                                             |
| `turns`          | Turns of the run's own Session observed during the run.                                                                                                                                                                                                                                                                      |
| `tokens`, `cost` | Reported token usage and USD cost summed over those steps, starting at zero.                                                                                                                                                                                                                                                 |
| `context`        | `limit`, the last positive context window a step reported, and `peakInput`, the largest `input + cache.read + cache.write` of one step. Each is omitted when no step reported it.                                                                                                                                            |
| `models`         | Distinct full model references the steps used.                                                                                                                                                                                                                                                                               |
| `total`          | Provider-request usage of the whole run window: `tokens`, `requests` (`logical` requests, `physical` attempts including retries, and `helpers`, the non-step requests such as titles and compaction), `cost` with `costProvenance`, and `steps` and `turns` summed over the run's Session and its managed subagent Sessions. |
| `children`       | One entry per descendant Session: `sessionID`, `kind`, `agent`, `tokens`, `requests`, and `cost` with `costProvenance`, plus `status`, `steps`, and `turns` for subagents and `steps` for helpers when observed.                                                                                                             |
| `usageError`     | Replaces `total` and `children` when the usage reads fail; the other fields are still written.                                                                                                                                                                                                                               |

`total` and `children` come from the Session usage report over revision 5, which covers the Session, its subagent Sessions, and their hidden compaction helper Sessions. The CLI reads every report page and recursively reads every descendant task page. The report includes provider requests recorded from the prompt's admission time through the root Session's last event. An empty time window is widened to one millisecond. Title requests are recorded under the Session they name. Ledger `cost` is absent when no request in scope has a recorded or catalog-estimated price; `costProvenance`, when present, is `recorded` or `current_catalog`.

A `subagent` child has the task `status` (`starting`, `running`, `waiting`, `cancelling`, `cancelled`, `completed`, `failed`, or `lost`) read at the end of the run and zero usage when it made no request in the window. A `helper` child is a hidden Session without a task record; its agent comes from that Session and it has no `status` or `turns`. The run ends when its own Session settles, so background subagents may still be running. Totals include usage recorded up to that moment; an in-flight request reports only the usage recorded so far.

A step is one logical model call, counted when it ends or fails. A turn is one execution of a Session, from `session.execution.started` to its terminal execution event, that promoted at least one input; steers promoted during that execution belong to the same turn, while a queued input or a notice that wakes an idle Session starts another. An execution that promoted no input (an empty wake or a compaction-only drain) is not a turn. Counts come from events observed during the run. A subagent reports explicit zero `steps` and `turns` if none were observed, while a helper reports `steps` only when the run observed its steps, never a fabricated zero. Helpers contribute provider usage but not `total.steps` or `total.turns`. The run ends at the first terminal execution event of its own Session, so its own `turns` is 1 unless it ends before promoting any input, in which case it is 0. Exit codes are unchanged.

```json
{"type":"step_start","timestamp":1791950288605,"sessionID":"ses_1","part":{"type":"step-start","agent":"god","model":{"providerID":"openai","id":"gpt-5"}}}
{"type":"run_finish","timestamp":1791950288735,"sessionID":"ses_1","status":"succeeded","durationMs":405,"steps":2,"turns":1,"tokens":{"input":110,"output":30,"reasoning":0,"cache":{"read":140,"write":0}},"cost":0.02,"context":{"limit":400000,"peakInput":150},"models":[{"providerID":"openai","id":"gpt-5"}],"total":{"tokens":{"input":110,"output":30,"reasoning":0,"cache":{"read":140,"write":0}},"requests":{"logical":2,"physical":2,"helpers":0},"cost":0.02,"costProvenance":"recorded","steps":2,"turns":1},"children":[]}
```

## Installation and release channels

Stable installation uses `curl -fsSL https://ycoding.althenia.app/install.sh | sh` and resolves GitHub's latest stable release. The Rust backend beta channel starts at `0.11.0-beta.1`:

```sh
curl -fsSL https://beta.ycoding.althenia.app/install.sh | sh -s -- --beta
```

The installer accepts `--beta` or `YCODING_CHANNEL=beta` to select the newest published, non-draft `X.Y.Z-beta.N` prerelease. `YCODING_VERSION` pins an exact version and takes precedence over channel discovery. These are installer options, not runtime JSON/JSONC settings.

`ycoding update` derives its channel from the running version. Beta builds select the higher of the newest beta and newest stable by semantic version, so a newer stable supersedes the beta, including the stable release of the same version. Stable builds stay on stable unless an explicit `--version <version>` is supplied. Background update notices follow the same selection. To switch back explicitly, run the normal stable install command above.

### Native computer helper

Native computer use has no JSON/JSONC setting or helper-path environment override. The CLI supplies the frontend executable as native asset owner; `YCoding Computer Use.app` stays beside `ycoding`, including installations in `~/.local/bin`, while Rust runs from its extracted path. The backend retains one helper process over a private socket. Desktop access needs Accessibility, capture needs Screen Recording, and iTerm/Finder/Safari/Chrome control needs Automation authorization for that app; allow **YCoding Computer Use** in Privacy & Security and retry.

The release workflow uses the `YCoding Code Signing` identity, a self-signed code-signing certificate rather than notarized Apple Developer ID signing. The designated requirement names `app.ycoding.computer-use` and its certificate; macOS decides whether existing grants apply. Ad-hoc builds pin one build and require renewed grants: remove denied entries with **−** and allow the entry added by the rebuilt app. Browser-downloaded archives carry quarantine; after extraction use `xattr -dr com.apple.quarantine <extracted-folder>` before launch. The installer and updater download without that attribute.

Safari `webbrowser.eval`, `webbrowser.back`, `webbrowser.forward`, and `webbrowser.reload` require Safari's **Develop > Allow JavaScript from Apple Events** setting; Chrome `webbrowser.eval` requires Chrome's **View > Developer > Allow JavaScript from Apple Events** setting. When these calls fail, they report `native_failure` with an unknown outcome and a message that points to the setting.

For macOS source development, build the helper explicitly with `bun run build:computer-use`. To exercise installed asset resolution, build/install a native artifact containing the app and run its packaged checks. Set `YCODING_MACOS_SIGNING_IDENTITY` to your own stable signing identity to preserve privacy grants where macOS permits; without it builds are ad-hoc signed and require renewed entries. Runtime startup does not compile/install the app or write beside Bun. Windows and Linux expose no native computer capabilities. See [Native computer use](./computer-use.md).

On POSIX systems, YCoding restricts its log directory to mode `0700` and the active YCoding log file to `0600`, whether that file is new or pre-existing. Startup repairs more-permissive modes without deleting or rewriting existing log content.

The server-hosted remote connector writes warning-level diagnostics to the active YCoding log file in `$XDG_DATA_HOME/ycoding/log` with `component=remote-connector`. A relay-close entry records the close code and whether the connector reconnects. A state transition records `from`, `state`, and, when known, `retryable`. A startup or recovery failure records a fixed `cause` category (`authorization_rejected`, `setup_failed`, or `startup_failed`); a rejected credential exchange also records its `operation` (`enroll`, `challenge`, `token`, or `refresh`) and HTTP `status`. Failure entries omit raw error bodies, so credentials, bearer tokens, and frame payloads never reach the log. A remote request that takes 1 s or longer on the machine writes `slow remote request <operation> took <N>ms on this device`, naming only the operation and duration. Session-scoped reads verify the Session with one `session.get` at its recorded Location, scanning the full Session inventory only for an ID the connector has not yet seen; captured-change summaries are reused while every member Session's durable event position is unchanged and read paged `message.capturedInputs` projections when recomputed.

When `$XDG_CONFIG_HOME` is `~/.config`, the global JSONC source is `~/.config/ycoding/ycoding.jsonc`. Compaction helper selection reads the merged runtime configuration from this normal discovery chain; it does not use a separate helper-only configuration file.

## Runtime configuration discovery and precedence

Configuration entries are assembled from lowest to highest priority. For scalar values, the latest document that defines the field wins. Agents, commands, providers, extensions, permissions, and similar domains apply their own ordered merge behavior.

The document order is:

1. Global `ycoding.json`.
2. Global `ycoding.jsonc`.
3. The file named by `YCODING_CONFIG`, when set.
4. Direct `ycoding.json` and `ycoding.jsonc` files discovered from broad ancestors toward the current working directory.
5. `ycoding.json` and `ycoding.jsonc` inside ancestor `.ycoding` directories, from broad ancestors toward the current working directory.
6. Authenticated well-known integration configuration.
7. `YCODING_CONFIG_CONTENT`, which has the highest priority.

Example order:

```text
global -> explicit file -> project -> authenticated well-known sources -> inline content
```

Within one directory, `ycoding.jsonc` is loaded after `ycoding.json` and therefore has higher priority for fields it defines.

Well-known configuration participates only when its integration has a saved key.
Resolution binds to the latest saved key for that integration, independently of
the active provider profile, and checks that the selected credential is still
current after resolution. Embedded documents precede remote documents from the
same manifest. Source updates and credential or connection changes rebuild
acquired Locations; an explicit resource refresh resolves configuration again
even when the manifest is unchanged. A resolution or rebuild failure retains the
published Location generation and reports the failure without exposing key values.

Project discovery walks upward from the current directory. It is not limited to the detected project root. Set `YCODING_CONFIG_PROJECT_DISABLE=true` or `YCODING_DISABLE_PROJECT_CONFIG=true` to disable project discovery.

## JSON and JSONC behavior

Both JSON and JSONC support:

- `//` comments;
- trailing commas;
- unknown properties, which are dropped individually with diagnostics;
- `$schema` metadata;
- environment substitution with `{env:NAME}`;
- file substitution with `{file:path}`.

Unparsable JSON/JSONC and unsupported executable-plugin declarations skip the affected document. Ordinary unknown keys and invalid values are recovered at the smallest valid boundary, preserving unrelated settings. Invalid named MCP server, provider, command, or reference values drop that entry; invalid agent fields can be dropped individually. Invalid permissions fail closed with action-wide or scope-wide denies appended after valid rules. Invalid `guardrails` values become `{ "enabled": true }` with default limits. Location-scoped `config.diagnostics` returns document path, reason, message, parsed-item `jsonPath`, and `failClosed` for security recovery. TUI Status lists Configuration diagnostics and their fail-closed marker.

`{file:path}` is resolved relative to the containing configuration file. Absolute paths and `~/` are supported. The referenced file is trimmed and inserted as a JSON string fragment. A `{file:...}` token inside a `//` comment is not resolved.

Example:

```jsonc
{
  "username": "{env:USER}",
  "mcp": {
    "servers": {
      "private": {
        "type": "remote",
        "url": "https://mcp.example.com",
        "headers": {
          "Authorization": "Bearer {file:./secrets/mcp-token.txt}",
        },
      },
    },
  },
}
```

Missing environment variables become an empty string. A missing `{file:...}` reference fails configuration loading for that Location and is shown as a configuration error.

The configuration JSON Schema is generated from the runtime-owned `Config.Info` Schema during the public web build. Its public endpoint is [`https://ycoding.althenia.app/ycoding.schema.json`](https://ycoding.althenia.app/ycoding.schema.json). Publish the built web assets before using the endpoint.

After deployment, use the endpoint in `ycoding.jsonc` for editor validation:

```jsonc
{
  "$schema": "https://ycoding.althenia.app/ycoding.schema.json",
}
```

Use the generated YCoding schema endpoint rather than a different product's schema.

## Terminal installation and commands

After the public site and a native release are published, `curl -fsSL https://ycoding.althenia.app/install.sh | sh` installs a checksum-verified release executable in `~/.local/bin`. Installation does not require a separate Bun runtime. The installer applies the same archive checks as `ycoding update`. It checks the shell configuration and adds the binary directory to PATH only when needed; unsupported shells receive manual PATH guidance.

`ycoding` opens the interactive terminal interface. `ycoding --model <[profile#]provider/model[#variant]> "prompt"` executes a direct non-interactive run instead. `ycoding run --help` lists the explicit run command's options. These paths share the existing durable Session execution and permission handling.

`ycoding api <operation> [--data <request-json>]` invokes a local-role v5 operation by its diagnostic name, not an HTTP method/path. Supply the complete typed request object, including `params`, `query`, and/or `payload` required by that operation. Results print as JSON; event streams print one JSON event per line. For example:

```sh
ycoding api health.get
ycoding api session.rename --data '{"params":{"sessionID":"ses_example"},"payload":{"title":"Example"}}'
```

CLI attachment admission uses backend-readable file references. The caller retains its source files until admission is confirmed; the backend materializes the durable managed copy. Unknown admission outcomes require reconciliation or explicit retry, not removal of the source.

The installed executable includes `ycoding service start`, `restart`, `status`, `stop`, `get`, `set`, and `unset` for the managed background server. `ycoding service --help` lists these controls. `status` reports the running endpoint or `stopped` without starting a server. `restart` interrupts executing Sessions; let their work finish before restarting to apply an update.

**Keep machine awake** is an opt-in, runtime-only control in the TUI command palette and the web client's **Settings → Machine** section. The TUI Status dialog also reports its state. It controls the selected backend machine, not the phone or browser viewing it. On macOS it prevents idle system sleep while enabled; closing the lid or requesting sleep manually still allows sleep. Disabling it or stopping, restarting, updating, or crashing the backend releases the inhibitor. Each backend starts with it off. Linux and Windows report unsupported. There is no saved preference or automatic re-enabling, and the web control requires a reachable machine.

The TUI palette, Status dialog, and web control report **Checking** until the backend answers, rather than assuming Off. The web control shows **Unavailable** for an unreachable machine or unavailable operation, **Unsupported** for an unsupported platform, and **Error** for a backend inhibitor failure. A failed or unknown change remains visible without claiming it took effect; reconnect does not replay or rearm it. Keeping the machine awake does not preserve execution or network connectivity through manual sleep or lid closure.

`ycoding update` checks GitHub Releases and replaces an installed release only after verifying its archive checksum and contents. It checks every archive entry, accepting only regular files and directories and rejecting links, devices, absolute or parent-relative paths, unsafe or duplicate names, entries above the size limit, and archives with more than 1024 entries; it requires the files the release version needs and extracts only those, so additional archive entries are ignored and never written. In a terminal it redraws one progress line: a download bar with percentage and megabytes when the release reports its size (otherwise the megabytes received), then checksum verification and installation; redirected output prints each phase once. macOS releases from 0.2.0 through 0.7.0 contain `ycoding` and `ycoding-computer-helper`; 0.7.1 contains those files plus the signed `ycoding-computer-helper.app` bundle. Later macOS releases contain `ycoding`, the `YCoding Computer Use.app` bundle, and `ycoding-chrome-extension`; the installer and updater require the app's signature to verify (`codesign --verify --deep --strict`) but do not compare its signing identity with the installed app's, and macOS may request renewed Privacy & Security authorization when an update changes the app's signing identity, as described under native computer use; installing one removes a sibling `ycoding-computer-helper` and `ycoding-computer-helper.app`. Self-update preserves and restores the installed files and apps together if replacement fails. Explicit rollback to a published pre-0.2.0 macOS version accepts its historical single-file archive and leaves any sibling helper unchanged. Linux releases through 0.7.1 are single-file, and later Linux releases add `ycoding-chrome-extension`; installing a later release on either platform replaces that folder and restores it if replacement fails. Self-update supports macOS arm64/x64 and Linux x64, matching the shell installer. Development builds must be rebuilt locally: `bun run build:tui` writes the executable, the macOS `YCoding Computer Use.app`, and `ycoding-chrome-extension` together under `dist/tui/<target>/bin`, and `bun run install:local` copies all of them into `~/.local/bin` on macOS and Linux. It fails without changing the installation when the build is incomplete or the macOS app fails signature verification, and replaces each installed item by rename so a running `ycoding` keeps its open executable. Each build re-signs the app ad hoc unless `YCODING_MACOS_SIGNING_IDENTITY` names a signing identity. After installing, `install:local` reads the installed app's actual signature and prints whether it is ad-hoc signed, in which case each build has a different code requirement and you remove the old **YCoding Computer Use** Privacy & Security entries and allow the new one when prompted, or signed by a named certificate, in which case macOS decides whether existing grants apply. Windows users must exit YCoding and replace the executable from the release ZIP manually.

After `ycoding update` installs a release, it checks the running service with `session.outstanding`. An executing drain or live background shell counts as running work. With no running work it restarts the service from the installed executable; pending inputs, settled notices, and non-running goals do not delay that restart. Running work leaves the service unchanged and directs the user to `ycoding service restart`; `--force` permits a graceful restart that interrupts it. A failed or five-second timed-out work read keeps the service running unless forced. A failed restart leaves the installation in place and exits 1. No running service means no restart, and an unchanged or rolled-back installation never queries or restarts it. The executable performing the update owns these checks.

The background update check resolves the newest release from the same GitHub Releases source and only announces its availability with the explicit `ycoding update` command. It never downloads release assets, installs an update, replaces executables, or restarts the application. An omitted `autoupdate`, `true`, and `"notify"` all enable notice-only checks for patch, minor, and major releases; `false` disables the check. Installation requires the user to run `ycoding update`.

### Meeting capture

The Rust backend enables Meeting with `ycoding-runtime --meeting`. Each booted
Location gets one Meeting service and an authenticated numeric-loopback bridge.
Its live-page assets and Python worker source are compiled into the executable;
packaged runs need neither an adjacent view directory nor a `worker.py` file.
The configured `pythonExecutable` and local speech dependencies remain required.
The Meeting directory's private `settings.json` overrides defaults; enabling
Meeting does not download weights or start recording. Native clients discover
the private `bridge.json` descriptor and obtain a separate view key for the
consent-led browser capture page.

Meeting storage is per canonical Location. Its key is the first 32 hexadecimal
characters of SHA-256 over the Location's real path. The stable source is
`$XDG_DATA_HOME/ycoding/meeting/<key>/meetings.sqlite`; the beta runtime uses
`$XDG_DATA_HOME/ycoding-beta/meeting/<key>/meetings.redb`. Without `XDG_DATA_HOME`,
the base is `~/.local/share`. On the Location's first beta start, the runtime
copies the stable SQLite database and any sidecars to private scratch, imports
the copy, verifies provenance, and atomically publishes the beta store before
opening Meeting. Stable files remain unchanged. The beta Meeting directory's
private `stable-import-v1.json` contains its version-2 sealed selection or source-absence decision; later
starts reuse the beta store rather than merge stable changes. Import failures
leave no partial selected store or completion marker, log a clear Meeting
diagnostic, and keep the Location usable. `YCODING_CHANNEL=beta` selects that
same beta directory for native discovery. Settings are read from the selected
channel's Meeting directory. A live or unverifiable stable `runtime.lock` owner refuses that Location's import without signalling or stopping it; close the stable Meeting owner and retry. The shared source-copy guard and resume/selection rules above apply independently to each Meeting store.

Meeting requires the native Bun-built `ycoding` executable. The Node CLI excludes Meeting; `meeting` and `serve --meeting` exit nonzero with an error directing you to the native executable, without starting a meeting server or arming capture.

`ycoding meeting [directory] [--no-open]` starts a private Rust server for the directory (default: the current directory), arms a meeting, and opens or prints its local live page; it reuses an existing reachable Meeting bridge. `ycoding serve --meeting` enables the same backend service for composed Locations. The page owns browser-tab audio capture under its separate view key, with fresh participant consent and an optional microphone; no capture extension or pairing is required. Keep it open while recording. See [meeting intelligence](./meeting-intelligence.md#ycoding-meeting) for speech prerequisites and consent.

### Remote access

`ycoding remote` gives the authenticated owner of an enrolled machine access to every Session in that machine's backend through a relay deployment. The local process keeps execution authority; see [Runtime behavior](./runtime.md#remote-relay-agent) for backend-derived Location, authorization, reconnection, and frame-bounding rules.

With machine-wide consent enabled, the connected Web workspace sends bounded content-free timing batches through the authenticated relay. The local backend retains at most 10,000 samples for 30 days; the relay stores none. Settings → Web latency shows the last 60 tab-local measurements and reads saved rows from the selected machine through `telemetry.list`. Account and relay-local timings remain tab-local. See [telemetry](./runtime.md#telemetry) for consent, bounds, and failure states.

The standalone terminal artifact and the full CLI expose the same remote subcommands and handlers. Remote access does not require a separate full-CLI installation.

In the browser, **New session** selects from existing repositories recorded by that backend. Open a missing repository locally, then use **Refresh repositories**. New Sessions use the selected directory's configured `default_agent` and `model` when no Session-specific selection exists; configure providers and credentials on the machine. The browser does not accept an arbitrary directory or create repositories.

| Command                                                                               | Purpose                                                                                                                                               |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ycoding remote enroll <enrollmentID> [--name <name>] [--relay <origin>] [--replace]` | Enroll this machine with a relay. The one-use enrollment code is read from the terminal, never argv.                                                  |
| `ycoding remote connect [--relay <origin>] [--server <url> \| --standalone]`          | Turn on the resolved server's remote connection and return once it is on; `--standalone` stays in the foreground until Ctrl-C.                        |
| `ycoding remote disconnect [--server <url> \| --standalone]`                          | Turn off the resolved server's remote connection.                                                                                                     |
| `ycoding remote status [--server <url> \| --standalone]`                              | Read enrollment, redacted credential validity, and connection state from the resolved backend; an unenrolled backend reports that it is not enrolled. |
| `ycoding remote sessions [--server <url> \| --standalone]`                            | List every Session in the backend through its authoritative Location.                                                                                 |

`ycoding remote enroll` requires a relay origin, and `--replace` is required before an existing device identity can be overwritten. `ycoding remote connect` requires an enrolled device and refuses to bridge a local server over a LAN or public-network endpoint.

The Rust runtime owns the remote connection for its lifetime, including when no TUI is open. CLI/TUI controls use authenticated `remote.get` and `remote.set` (`{ enabled }`). States are `off`, `connecting`, `on`, and `error`; the Remote connection toggle enables from off and disables from the other states. Enabling grants the enrolled owner access to every existing and future backend Session. An unenrolled machine directs the user to `ycoding remote enroll <enrollmentID>`. The backend persists the on/off choice in private `remote.json`, restores it at startup, and closes the connector at shutdown without clearing the choice. Unreadable preferences report an error rather than silently connecting. Device enrollment is backend-owned and stored in private `remote-device.json`; its relay origin is pinned.

The runtime owns retry and credential refresh. Disabling/shutdown cancels recovery and fences late connection work. Invalid enrollment, rejected credentials, and relay-origin mismatch require attention, not automatic reenrollment. `ycoding remote connect` requires a private loopback backend, validates a relay override against the enrolled origin, and waits up to 30 seconds for on. An explicit connect retries repaired setup. The backend runtime lock owns the service; the CLI acquires no connector lock and never reads private device credentials.

Local state lives outside any repository checkout:

| File                 | Location                         | Contents                                                                    |
| -------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| `remote-device.json` | Channel's global state directory | Private device identity, pinned relay origin, keys, and refresh credential. |
| `remote.json`        | Channel's global state directory | Backend-owned connection on/off preference.                                 |

The runtime writes private state atomically. The CLI reads only redacted enrollment from `remote.get` and submits the hidden one-use code through `remote.enroll`; it does not read the identity file, generate device keys, sign challenges, or refresh credentials. The private key stays on the backend; credentials use request bodies and upgrade headers, never URL/argv/environment. Malformed files fail explicitly and remain for the operator.

Relay sign-in is restricted by a server-only allowlist. `GOOGLE_ALLOWED_EMAILS` holds comma-, whitespace-, or newline-separated Google addresses matched exactly after trimming and lowercasing, with no wildcards or domain suffixes, and it is never returned through an API, a redirect, a log, or the browser bundle. Admission requires a configured entry, a Google-verified email, and an exact match; a missing or empty list denies every Google sign-in. The relay deployment also supplies `GOOGLE_CLIENT_ID` and the `GOOGLE_CLIENT_SECRET` secret.

Provisioning is an operator action in `infra/cloudflare`. `wrangler.jsonc` selects the Durable Object and D1 bindings, the static-assets binding for the built web client, and the custom domain; the Google secrets are set with `wrangler secret put`.

## Rejected configuration keys

Ordinary unknown or removed keys are dropped individually with a diagnostic. Executable-plugin declarations are a separate fail-closed boundary: `plugins`, `plugin`, `npm`, singular `provider`, and executable provider packages reject the affected document. Native provider package identities are accepted without executing npm code. Other individually rejected keys include:

```text
logLevel
server
command
reference
snapshot
autoshare
disabled_providers
enabled_providers
small_model
mode
agent
permission
tools
attachment
layout
decisions
```

Individually dropped items appear in `config.diagnostics` with document path, JSON path, reason, and message; security recovery carries `failClosed: true`. Executable-plugin rejection reports an ignored document instead of a partial load. The TUI shows Configuration diagnostics in Status.

The MCP shape where server names appear directly under `mcp` is also rejected. Use `mcp.servers`.

## Complete top-level runtime fields

| Field                   | Type                                  | Purpose                                                                                            |
| ----------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `$schema`               | string                                | Optional editor metadata only.                                                                     |
| `shell`                 | string                                | Preferred shell for terminal and shell execution.                                                  |
| `shell_sandbox`         | `disabled`, `optional`, or `required` | Shell isolation policy.                                                                            |
| `shell_memory_limit_mb` | non-negative integer                  | Default shell command process-tree memory limit in MiB; zero disables the default.                 |
| `model`                 | model selector                        | Default model.                                                                                     |
| `default_agent`         | string                                | Default selectable primary agent.                                                                  |
| `autoupdate`            | boolean or `notify`                   | Notice-only update checks; `false` disables checks. Installation is always manual.                 |
| `share`                 | `manual`, `auto`, or `disabled`       | Session sharing policy accepted by Schema.                                                         |
| `enterprise.url`        | string                                | Enterprise sharing endpoint accepted by Schema.                                                    |
| `username`              | string                                | Display and telemetry identity.                                                                    |
| `permissions`           | permission rules                      | Global ordered tool permission rules.                                                              |
| `agents`                | record                                | Built-in overrides and custom agents.                                                              |
| `snapshots`             | boolean                               | Undo/revert snapshot behavior.                                                                     |
| `watcher.ignore`        | string array                          | Watcher ignore patterns.                                                                           |
| `formatter`             | boolean or formatter record           | Built-in formatter enablement and overrides.                                                       |
| `lsp`                   | boolean or LSP record                 | Built-in language-server enablement and overrides.                                                 |
| `attachments`           | object                                | Attachment processing, currently image limits and resizing.                                        |
| `tool_output`           | object                                | Tool-output truncation limits.                                                                     |
| `mcp`                   | object                                | MCP defaults and named servers.                                                                    |
| `compaction`            | object                                | Selective-compaction retention, budget, manifest, and advisory policy.                             |
| `session_retention`     | object                                | Global-only idle Session family deletion; see [Session retention](#session-retention).             |
| `skills`                | string array                          | Additional skill directories or HTTP(S) sources.                                                   |
| `commands`              | record                                | Named slash commands.                                                                              |
| `instructions`          | string array                          | Accepted by Schema, but no current runtime consumer reads this field. Do not rely on it.           |
| `instruction_max_bytes` | positive integer                      | Maximum bytes loaded from each ambient instruction file; default 51,200, maximum 1,048,576.        |
| `references`            | record                                | Named local or Git context sources.                                                                |
| `extensions`            | array                                 | Explicit trusted process definitions and host grants; see [plugins and hooks](#plugins-and-hooks). |
| `providers`             | record                                | Provider and model overrides.                                                                      |
| `memory`                | object                                | On-demand workspace knowledge enablement, base path, and concept/bundle limits.                    |
| `efficiency`            | object                                | Helper-model, prompt-cache, and provider-continuation policy.                                      |
| `image_analyzer`        | object                                | Image analysis fallback for text-only models.                                                      |
| `experimental`          | object                                | Subagent depth and resource policies.                                                              |

### Shell memory limits

`shell_sandbox` delegates isolation to an enforceable runtime backend. No shell sandbox backend is bundled: `optional` runs without sandboxing and reports a warning, while `required` rejects execution when no backend is available. A managed worktree is not sandbox-allowed by default.

The model-facing shell `timeout` input is not a configuration field. It accepts whole milliseconds up to 3,600,000 (one hour); omission or `0` selects the finite 600,000 ms default. Values above one hour are rejected. A foreground command that remains active after 300,000 ms is moved to the background without being terminated; its selected timeout still applies.

`shell_memory_limit_mb` sets the Location-wide default for non-interactive shell commands. The shell tool's `memory_limit_mb` input overrides it for one command; zero explicitly selects unlimited memory. Omission uses the configured default, and omission with no default remains unlimited.

A finite limit supplies `GOMEMLIMIT=<limit>MiB` to Go runtimes and appends `--max-old-space-size=<limit>` to `NODE_OPTIONS` for Node processes. Bun does not expose an inherited heap-size option equivalent to Node's, so Bun itself is governed by the sampled process-tree ceiling while child Go or Node runtimes receive their soft hints.

On macOS and Linux, YCoding samples aggregate resident memory for the detached shell process group every 250 milliseconds and terminates the group with status `memory-limit` after a sample exceeds the limit. Sampling can overshoot between checks, shared pages can be counted more than once, and a command that deliberately creates a new process group can escape aggregate accounting. This is resource control, not a security boundary or a kernel hard limit. Windows rejects a finite shell memory limit because the current process abstraction cannot assign the command to a Job Object before it starts.

### Field defaults and nested Schema contract

The field reference below expands the overview. `unset` means the field is optional in Schema and has no default specified here.

| Field path                                        | Exact type or closed values                                                    | Default         | Operational remark                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------ |
| `$schema`                                         | string                                                                         | unset           | Editor metadata only.                                                                            |
| `shell`                                           | string                                                                         | unset           | Shell executable or command selector.                                                            |
| `shell_sandbox`                                   | `disabled` \| `optional` \| `required`                                         | unset           | Shell isolation policy.                                                                          |
| `shell_memory_limit_mb`                           | non-negative integer `<= 1048576`                                              | unset           | Default sampled resident-memory limit in MiB; zero means unlimited.                              |
| `model`                                           | model selector                                                                 | unset           | Session/agent model fallback.                                                                    |
| `default_agent`, `username`                       | string                                                                         | unset           | Primary agent ID and display identity.                                                           |
| `autoupdate`                                      | boolean \| `notify`                                                            | unset           | Notice-only checks; `false` disables them.                                                       |
| `share`                                           | `manual` \| `auto` \| `disabled`                                               | unset           | Sharing policy.                                                                                  |
| `enterprise.url`                                  | string                                                                         | unset           | Enterprise endpoint.                                                                             |
| `permissions`                                     | ordered `[{ action: string, resource: string, effect: allow \| deny \| ask }]` | unset           | Global permission rules.                                                                         |
| `agents`                                          | record of `Config.Agent`                                                       | unset           | Inline agent definitions and overrides.                                                          |
| `snapshots`                                       | boolean                                                                        | unset           | Snapshot switch.                                                                                 |
| `watcher`                                         | `Config.Watcher`                                                               | unset           | Watcher filters.                                                                                 |
| `formatter`                                       | boolean \| record of `Config.Formatter.Entry`                                  | unset           | Formatter enablement and overrides.                                                              |
| `lsp`                                             | boolean \| record of `Config.LSP.Entry`                                        | unset           | Language-server enablement and overrides.                                                        |
| `attachments`, `tool_output`, `mcp`, `compaction` | their named `Config.*` object                                                  | unset           | Runtime tooling and context controls.                                                            |
| `guardrails`                                      | `Config.Guardrail`                                                             | unset           | Root-Session-family guardrail configuration; custom-source and reply rules are documented below. |
| `skills`, `instructions`                          | string[]                                                                       | unset           | Extra skill sources; `instructions` has no current ambient-discovery consumer.                   |
| `instruction_max_bytes`                           | positive integer `<= 1048576`                                                  | `51200`         | Per-ambient-instruction UTF-8 byte cap.                                                          |
| `commands`                                        | record of `Config.Command`                                                     | unset           | Inline slash commands.                                                                           |
| `references`                                      | record of `Config.Reference.Entry`                                             | unset           | Named local or Git context sources.                                                              |
| `extensions`                                      | process-definition array                                                       | unset           | Identity, absolute executable, arguments, and explicit host grants.                              |
| `providers`                                       | record of `Config.Provider`                                                    | unset           | Provider/model overrides.                                                                        |
| `provider_usage`                                  | `Config.ProviderUsage`                                                         | unset           | Read-only provider-usage client bridge.                                                          |
| `efficiency`                                      | `Config.Efficiency`                                                            | runtime-derived | Helper-model, cache, and continuation policy.                                                    |
| `image_analyzer`                                  | `Config.ImageAnalyzer`                                                         | unset           | Vision fallback for text-only models: provider/model, prompt, and thresholds.                    |
| `experimental`                                    | `Config.Experimental`                                                          | unset           | Experimental runtime policy.                                                                     |

| Nested field path                                                                                                            | Exact type or closed values                                                                                     | Default                         | Operational remark                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents.<id>.model`                                                                                                          | model selector                                                                                                  | unset                           | Agent model override.                                                                                                                                                             |
| `agents.<id>.request.headers`, `.request.body`                                                                               | string record, JSON record                                                                                      | unset                           | Provider request overlays.                                                                                                                                                        |
| `agents.<id>.system`, `.description`                                                                                         | string                                                                                                          | unset                           | System instruction and display description.                                                                                                                                       |
| `agents.<id>.mode`                                                                                                           | `subagent` \| `primary` \| `all`                                                                                | unset                           | Agent availability.                                                                                                                                                               |
| `agents.<id>.hidden`, `.disabled`                                                                                            | boolean                                                                                                         | unset                           | Visibility and disable switches.                                                                                                                                                  |
| `agents.<id>.color`                                                                                                          | `#RRGGBB` \| `primary` \| `secondary` \| `accent` \| `success` \| `warning` \| `error` \| `info`                | unset                           | TUI color.                                                                                                                                                                        |
| `agents.<id>.steps`                                                                                                          | positive integer                                                                                                | unset                           | Agent step allowance.                                                                                                                                                             |
| `agents.<id>.permissions`                                                                                                    | `Permission.Rule[]`                                                                                             | unset                           | Agent permission additions.                                                                                                                                                       |
| `commands.<name>.template`                                                                                                   | string                                                                                                          | required                        | Command prompt template.                                                                                                                                                          |
| `commands.<name>.description`, `.agent`                                                                                      | string                                                                                                          | unset                           | Picker description and agent ID.                                                                                                                                                  |
| `commands.<name>.model`                                                                                                      | model selector                                                                                                  | unset                           | Command model override.                                                                                                                                                           |
| `commands.<name>.subtask`                                                                                                    | boolean                                                                                                         | unset                           | Subtask request.                                                                                                                                                                  |
| `references.<name>`                                                                                                          | string \| `{ repository: string, branch?, description?, hidden? }` \| `{ path: string, description?, hidden? }` | required per entry              | Reference source.                                                                                                                                                                 |
| `mcp.timeout.startup`, `.catalog`, `.execution`                                                                              | positive integer milliseconds                                                                                   | runtime-derived                 | Global timeout overrides.                                                                                                                                                         |
| `mcp.servers.<name>`                                                                                                         | local \| remote server object                                                                                   | required per entry              | Discriminated by `.type`.                                                                                                                                                         |
| local `.command`                                                                                                             | string[]                                                                                                        | required                        | Stdio command and arguments.                                                                                                                                                      |
| local `.cwd`, `.environment`, `.disabled`, `.timeout`                                                                        | string, string record, boolean, timeout object                                                                  | unset                           | Local-server options; relative `cwd` resolves from workspace.                                                                                                                     |
| remote `.url`                                                                                                                | string                                                                                                          | required                        | Remote MCP endpoint.                                                                                                                                                              |
| remote `.headers`, `.disabled`, `.timeout`                                                                                   | string record, boolean, timeout object                                                                          | unset                           | Remote-server options.                                                                                                                                                            |
| local/remote `.codemode`                                                                                                     | boolean                                                                                                         | `true`                          | Code Mode catalog exposure.                                                                                                                                                       |
| remote `.oauth`                                                                                                              | `false` \| OAuth object                                                                                         | unset                           | OAuth configuration.                                                                                                                                                              |
| `.oauth.client_id`, `.client_secret`, `.scope`, `.redirect_uri`                                                              | string                                                                                                          | unset                           | OAuth client fields.                                                                                                                                                              |
| `.oauth.callback_port`                                                                                                       | integer `1..65535`                                                                                              | unset                           | Local OAuth callback port.                                                                                                                                                        |
| `providers.<id>.name`, `.package`                                                                                            | string                                                                                                          | unset                           | Provider identity/implementation override.                                                                                                                                        |
| `providers.<id>.env`                                                                                                         | string[]                                                                                                        | unset                           | Credential variable names; never place credential values in config.                                                                                                               |
| `providers.<id>.settings`, `.headers`, `.body`                                                                               | JSON record, string record, JSON record                                                                         | unset                           | Provider request overlays.                                                                                                                                                        |
| `providers.<id>.catalog.source`                                                                                              | `openai-models`                                                                                                 | unset                           | Optional model catalog discovery for a configured provider.                                                                                                                       |
| `providers.<id>.models.<id>.modelID`, `.family`, `.name`, `.package`                                                         | model ID, model family, string, string                                                                          | unset                           | Model identity.                                                                                                                                                                   |
| model `.settings`, `.headers`, `.body`                                                                                       | JSON record, string record, JSON record                                                                         | unset                           | Model request overlays.                                                                                                                                                           |
| model `.capabilities.tools`                                                                                                  | boolean                                                                                                         | unset                           | Tool-call declaration.                                                                                                                                                            |
| model `.capabilities.input`, `.output`                                                                                       | string[]                                                                                                        | unset                           | Input/output modality names.                                                                                                                                                      |
| model `.variants[]`                                                                                                          | `{ id: variant ID, settings?, headers?, body? }`                                                                | unset                           | Named request variants.                                                                                                                                                           |
| model `.cost`                                                                                                                | cost object \| cost object[]                                                                                    | unset                           | USD-per-million input/output cost; optional cache and context-tier data.                                                                                                          |
| model `.disabled`                                                                                                            | boolean                                                                                                         | unset                           | Model disable switch.                                                                                                                                                             |
| model `.limit.context`, `.input`, `.output`                                                                                  | integer                                                                                                         | unset                           | Declared model limits.                                                                                                                                                            |
| model `.api`                                                                                                                 | `chat` \| `responses`                                                                                           | unset                           | OpenAI-compatible request surface; `responses` overrides the source default and the catalog value.                                                                                |
| `formatter.<name>`                                                                                                           | `{ disabled?, command?: string[], environment?: Record<string, string>, extensions?: string[] }`                | unset                           | Formatter override.                                                                                                                                                               |
| `lsp.<name>`                                                                                                                 | `{ disabled: true }` \| `{ command: string[], extensions?, disabled?, env?, initialization? }`                  | unset                           | LSP override.                                                                                                                                                                     |
| `attachments.image.auto_resize`                                                                                              | boolean                                                                                                         | unset                           | Image resizing.                                                                                                                                                                   |
| `attachments.image.max_width`, `.max_height`, `.max_base64_bytes`                                                            | positive integer                                                                                                | unset                           | Image limits.                                                                                                                                                                     |
| `tool_output.max_lines`, `.max_bytes`                                                                                        | positive integer                                                                                                | unset                           | Output truncation thresholds.                                                                                                                                                     |
| `watcher.ignore`                                                                                                             | string[]                                                                                                        | unset                           | Watcher ignore patterns.                                                                                                                                                          |
| `compaction.keep_recent_messages`                                                                                            | non-negative integer                                                                                            | `20`                            | Number of newest complete messages protected from selective exclusion. Model-switch boundary advice requires an explicit value.                                                   |
| `compaction.reserved_output_tokens`                                                                                          | non-negative integer                                                                                            | `0`                             | Output-token reservation used by compaction helper requests.                                                                                                                      |
| `compaction.context_safety_margin_tokens`                                                                                    | non-negative integer                                                                                            | `4096`                          | Tokens reserved from the model input budget before context-pressure and model-switch fit calculations.                                                                            |
| `compaction.timeout_seconds`                                                                                                 | non-negative integer                                                                                            | `60`                            | Total provider-assisted checkpoint-generation budget across all helper calls; expiry stops helper traffic and uses the local canonical checkpoint, while `0` disables the budget. |
| `compaction.max_output_tokens`                                                                                               | non-negative integer                                                                                            | `0`                             | Compaction helper output cap; `0` uses the model cap.                                                                                                                             |
| `compaction.max_manifest_bytes`                                                                                              | non-negative integer                                                                                            | `65536`                         | UTF-8 cap for one strict ContextManifest candidate.                                                                                                                               |
| `compaction.max_internal_passes`                                                                                             | non-negative integer                                                                                            | `8`                             | Maximum physical manifest-generation calls, including repair attempts.                                                                                                            |
| `compaction.advisory`                                                                                                        | `false` \| `{ consider_percent, strongly_advised_percent }`                                                     | `{ 70, 90 }`                    | Disables automatic soft-pressure admission or sets ordered integer thresholds from 1 through 99. Mandatory pressure at the hard cap is independent of this switch.                |
| `guardrails.enabled`                                                                                                         | boolean                                                                                                         | unset                           | Guardrail switch.                                                                                                                                                                 |
| `guardrails.max_concurrent_shells`, `.max_concurrent_subagents`, `.max_pending_reviews`, `.shell_wait_seconds`               | positive integer                                                                                                | unset                           | Root-Session-family caps for running shells, running subagents, and pending reviews; seconds a shell over its cap waits for a slot.                                               |
| `provider_usage.codex_app_server.command`                                                                                    | non-empty string                                                                                                | required when object is present | Direct executable, not a shell command.                                                                                                                                           |
| `provider_usage.codex_app_server.args`                                                                                       | string[]                                                                                                        | unset                           | Executable arguments.                                                                                                                                                             |
| `provider_usage.codex_app_server.cwd`                                                                                        | string                                                                                                          | unset                           | Client working directory.                                                                                                                                                         |
| `provider_usage.codex_app_server.timeout_ms`                                                                                 | positive integer `<= 30000`                                                                                     | unset                           | App-server timeout.                                                                                                                                                               |
| `efficiency.title`                                                                                                           | `local` \| `model` \| `off`                                                                                     | `local`                         | Title policy.                                                                                                                                                                     |
| `efficiency.helper_models.title`, `.goal`, `.decision`, `.prediction`, `.prompt`, `.compaction.main`, `.compaction.subagent` | model selector \| `session`                                                                                     | `session`                       | Independent model selection for title, goal, decision, next-message prediction, prompt drafting, and ContextManifest helpers.                                                     |
| `efficiency.prompt_cache.anthropic_ttl`                                                                                      | `adaptive` \| `5m` \| `1h`                                                                                      | `adaptive`                      | Cache lifetime policy.                                                                                                                                                            |
| `efficiency.prompt_cache.openai_mode`                                                                                        | `auto` \| `implicit` \| `explicit`                                                                              | `auto`                          | OpenAI cache lowering.                                                                                                                                                            |
| `efficiency.prompt_cache.openai_extended_retention`                                                                          | boolean                                                                                                         | `false`                         | Pre-GPT-5.6 OpenAI and Meta Muse Spark `24h` retention request.                                                                                                                   |
| `efficiency.openai_responses_continuation`                                                                                   | `auto` \| `on` \| `off`                                                                                         | `auto`                          | Response continuation policy.                                                                                                                                                     |
| `efficiency.openai_responses_state`                                                                                          | `stored` \| `stateless`                                                                                         | `stored`                        | Direct OpenAI Responses storage mode. Stored mode permits compatible response-ID continuation; stateless mode replays opaque provider state.                                      |
| `experimental.subagent_depth`                                                                                                | non-negative integer                                                                                            | `1`                             | Maximum nesting depth.                                                                                                                                                            |
| `experimental.policies`                                                                                                      | `Config.Policy.Info[]`                                                                                          | unset                           | Ordered configured-resource policies.                                                                                                                                             |

Configured-resource policy uses `provider.use` with a provider-ID resource and an
`allow` or `deny` effect. Policy documents load in reverse document-source order;
within each source the last matching statement wins. A matching statement in a
broader source therefore overrides one in a narrower source. Unmatched resources
default to allow. Action and resource patterns support `*` and `?`.

Denial removes the provider's models and integration references from available
catalogs and rejects model selection before account preparation, discovery or
generation effects. Resource policy does not grant tool permissions or delete
saved credentials. Reload rebuilds policy with the catalog before publishing the
replacement generation.

### Provider-usage reporting

`provider_usage` configures only the optional Codex app-server fields above. Its output appears separately as **Codex app-server** with unknown account attribution; it does not replace or inherit a stored profile's quota. Provider usage refreshes use credentials already stored for the matching YCoding integration; they do not discover credentials from another application's files, keychain, or browser cookies.

OpenRouter always attempts `GET https://openrouter.ai/api/v1/credits` with its configured account key, even without management metadata. When permitted, **Credits** measures lifetime usage against purchased credits and **Balance** is remaining credit; a 401/403 on this optional call leaves balance absent while `/key` spend remains available. `/key` supplies measured Today, This Week, and This Month spend and a Key Limit only for capped keys. Its current-window used amount is the cap minus `limit_remaining`, not lifetime key usage.

Claude Code OAuth exposes Session, Weekly, model-scoped weekly, and Extra usage from Anthropic's usage endpoint; Codex OAuth or a configured app-server exposes Session, Weekly, Spark, reset credits, and Extra usage. Stored Z.ai or Z.ai Coding Plan keys expose Session, Weekly, and Web Searches when reported. Muse quota comes from inference-response observations. These provider-internal metrics are best effort. The Usage view separately shows **YCoding local** Today spend from retained, priced requests for supported providers. This provider-wide local amount is not attributed to a credential profile, does not read another application's session logs, and is not an account-wide provider charge; unpriced requests cannot create a dollar amount, while a recorded $0.00 remains a measured zero. Missing values stay unreported.

## Model selectors

A model selector may be a string:

```json
"openrouter/openai/gpt-5#high"
```

or an explicit object:

```json
{
  "providerID": "openrouter",
  "model": "openai/gpt-5",
  "variant": "high"
}
```

The variant is optional; omission uses the selected model's settings and is not a named variant. YCoding does not create `default` or `base` variants for omission. Every explicit variant ID must be offered by the selected model, or model resolution fails with `VariantUnavailableError`; source-offered IDs retain their names and settings. An offered `none` variant can select reasoning effort `none` on OpenAI models. The TUI variant cycle includes an offered `none` variant.

Catalog reasoning variants reach the provider request in its own format. Native OpenRouter variants send their `reasoning` object (`effort`, `enabled`, or `max_tokens`), merged with configured OpenRouter reasoning options.

## Provider efficiency

The optional `efficiency` block controls provider-request amplification and prompt caching:

```jsonc
{
  "efficiency": {
    "title": "local",
    "helper_models": {
      "title": "openai/gpt-5-mini#low",
      "goal": "openai/gpt-5-mini#low",
      "compaction": {
        "main": "session",
        "subagent": "openai/gpt-5-mini#low",
      },
    },
    "prompt_cache": {
      "anthropic_ttl": "adaptive",
      "openai_mode": "auto",
      "openai_extended_retention": false,
    },
    "openai_responses_continuation": "auto",
    "openai_responses_state": "stored",
  },
}
```

| Field                                    | Values                         | Default    | Purpose                                                                                                          |
| ---------------------------------------- | ------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `title`                                  | `local`, `model`, `off`        | `local`    | Generate Session titles locally, with a model, or not at all.                                                    |
| `helper_models.title`                    | model selector, `session`      | `session`  | Model for model-generated Session titles.                                                                        |
| `helper_models.prediction`               | model selector, `session`      | `session`  | Model for next-message prediction; an explicit `agents.prediction.model` takes precedence.                       |
| `helper_models.prompt`                   | model selector, `session`      | `session`  | Model for `/prompt` drafts; an explicit `agents.prompt.model` takes precedence.                                  |
| `helper_models.goal`                     | model selector, `session`      | `session`  | Model for model-based goal synthesis.                                                                            |
| `helper_models.decision`                 | model selector, `session`      | `session`  | Model for hidden decision-agent judgments; an explicit `agents.decision.model` takes precedence.                 |
| `helper_models.compaction.main`          | model selector, `session`      | `session`  | Model for ContextManifest generation in main chats.                                                              |
| `helper_models.compaction.subagent`      | model selector, `session`      | `session`  | Model for ContextManifest generation in child Sessions.                                                          |
| `prompt_cache.anthropic_ttl`             | `adaptive`, `5m`, `1h`         | `adaptive` | Choose Anthropic-compatible cache lifetime behavior.                                                             |
| `prompt_cache.openai_mode`               | `auto`, `implicit`, `explicit` | `auto`     | Select OpenAI prompt-cache behavior according to model and route capabilities.                                   |
| `prompt_cache.openai_extended_retention` | boolean                        | `false`    | Request `24h` cache retention for supported pre-GPT-5.6 OpenAI and Meta Muse Spark models.                       |
| `openai_responses_continuation`          | `auto`, `on`, `off`            | `auto`     | Reuse compatible durable direct OpenAI Responses state when state mode is `stored` and effective storage allows. |
| `openai_responses_state`                 | `stored`, `stateless`          | `stored`   | Select provider-stored response-ID continuation or stateless opaque replay for direct OpenAI Responses.          |

`prompt_cache.anthropic_ttl: "adaptive"` gives root Session steps the one-hour bucket from their first request. Child Sessions and title, goal, and compaction requests get the five-minute bucket. A request source never changes its TTL, because changing it misses every cache entry written earlier. Models without published extended-TTL support always use five minutes.

## Image analysis fallback

Text-only models cannot natively receive `image/*` media. When `image_analyzer` is configured, YCoding replaces provider images with a deterministic text description so any agent gets consistent understanding. Provider images are managed user attachments and inline `data:` PNG, JPEG, GIF, or WebP images in completed local tool results. A tool-result image's description replaces that image in place inside the same tool result, so the tool call ID and the tool's text are unchanged. Durable Session history keeps the original image. Provider-executed tool results are sent unchanged, and YCoding never fetches a tool-result URI to analyze it.

Multimodal models (those whose `capabilities.input` contains `image/*` or `vision`) bypass the fallback and receive media natively.

Configuration:

```jsonc
{
  // Preferred selector string ([profile#]provider/model[#variant])
  "image_analyzer": {
    "enabled": true,
    "model": "anthropic/claude-sonnet-4",
    "prompt": "Custom prompt (optional)",
    "max_images": 4,
    "max_bytes": 5242880,
  },
  // Legacy separate fields also accepted:
  // "image_analyzer": { "enabled": true, "provider": "anthropic", "model": "claude-sonnet-4", "variant": "high" }
}
```

| Field                 | Type                  | Default                                               | Purpose                                                                                                                         |
| --------------------- | --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`             | boolean               | `true` when `model` is resolvable, otherwise disabled | Enable/disable fallback. `false` forces passthrough to managed-attachment metadata.                                             |
| `model`               | model selector string | unset                                                 | Vision model used to analyze images (e.g. `"anthropic/claude-sonnet-4"` or `"openai/gpt-4o"`). Required when `enabled` is true. |
| `provider`            | string                | unset                                                 | Legacy alternative to `model` selector when `model` is a plain id without `/`.                                                  |
| `variant`             | string                | unset                                                 | Variant id when using `provider`/`model` separate fields. Ignored if `model` already contains `#variant`.                       |
| `prompt` / `template` | string                | standard pattern                                      | Custom prompt that replaces the built-in comprehensive pattern. `template` is an alias for `prompt`.                            |
| `max_images`          | positive integer      | unset                                                 | Maximum images analyzed per request; excess images become failure notes.                                                        |
| `max_bytes`           | positive integer      | unset                                                 | Maximum bytes per image; oversized images become failure notes.                                                                 |

Standard pattern prompt (used when `prompt` is omitted) is deterministic across agents and instructs the vision model to emit ONLY valid TOON matching the structured schema. Schema is defined in `packages/core/src/session/runner/image-analysis.schema.toon` and exported as `IMAGE_ANALYSIS_TOON_EXAMPLE` from `packages/core/src/session/runner/image-analyzer.ts` (version `1`). It preserves the 7 comprehensive sections as structured fields but in token-efficient tabular form per Chad Vision TOON 4.1 (2-space indent, explicit `[N]` and `{fields}`, tabular for uniform arrays, list-form for non-uniform):

- `version`, `image{name,mime,digest,bytes,description?}`, `scene{overview}`, `objects[N]{type,count,description}`, `text_ocr[N]{content,location}`, `layout{arrangement,spatial,composition}`, `colors{palette[],style,mood}`, `details[]`, `confidence{level,uncertainties[]}`

Prompt embeds the TOON header template as a concrete ` ```toon` example and instructs: “Output ONLY valid TOON matching schema below, 2-space indent, explicit `[N]` and `{fields}`, no JSON, no markdown wrapper except optional ` ```toon` block, tabular for uniform arrays, list-form for non-uniform”. Example header: `objects[2]{type,count,description}:` followed by CSV rows. Token-efficient vs prior free-text 7-heading prose; agent extracts the ` ```toon` block verbatim without re-parsing prose. Measured/visible vs inferred separation via `confidence.uncertainties` aligns with Chad Vision practices.

Fallback replaces each `media` part with a single text block preserving TOON verbatim:

````
[Image Analysis: <filename> (<mime>) via <provider/model>]

```toon
version: "1"
image:
  name: photo.png
  ...
scene:
  overview: ...
objects[2]{type,count,description}:
  cat,1,...
...
```

Original description: ... (if present)
SHA-256: ...
Bytes: ...

````

TOON is validated via `@toon-format/toon` decode when available (`stripToonFences` + `isValidToon`), with metadata (SHA-256, Bytes) kept outside the block for efficient extraction.

Graceful degradation: if the configured vision model is unavailable, the provider is not configured, the request fails, or thresholds are exceeded, the image is not dropped. A failure note with the same header prefix and preserved SHA-256/bytes/description is inserted instead of media, so the agent still sees that an image was present.

Caching and TeamView: the vision analysis is a separate provider request and does not change the stable system/tool prompt-cache prefix of the main request. Each successful description is reused per image content digest, vision model, and effective prompt for the life of the runtime process, so later steps replay byte-identical user messages and make no further vision request for that image. Failed analyses are retried on a later step, and a runtime restart analyzes each image once more. TeamView remains a durable chronological Synthetic user-authority observation; tool semantics are unchanged.

`prompt_cache.openai_mode: "auto"` uses hybrid caching for direct OpenAI Responses requests on GPT-5.6 and later. Requests without a plugin-owned volatile suffix send request-wide implicit mode, keep OpenAI's managed implicit breakpoint, and reserve that breakpoint one of OpenAI's latest 50 read candidates. A request ending in plugin-owned volatile context instead compiles with request-wide explicit mode, keeps that suffix unmarked, and uses all 50 candidates for stable explicit boundaries. In ordinary implicit mode YCoding emits at most 49 explicit `input_text` candidates: one combined system-text marker when system text exists, then the newest eligible non-volatile user and local tool-result text boundaries. `"explicit"` disables the managed breakpoint and uses at most 50 explicit candidates. OpenAI can write the latest three explicit candidates plus the managed breakpoint in implicit mode, or the latest four explicit candidates in explicit mode. Assistant replay remains unmarked `output_text`; marked local tool results use `input_text` inside `function_call_output.output` while structured media remains unchanged. Tool definitions, tool calls, provider-executed tool results, and plugin-owned volatile messages receive no generated marker. Older public OpenAI models remain implicit. ChatGPT Codex requests are key-only for every model: YCoding emits none of `prompt_cache_breakpoint`, `prompt_cache_options`, or `prompt_cache_retention`, and uses the Session-scoped prompt-cache key for `session-id`, `thread-id`, and `x-client-request-id`; the explicitly selected WebSocket route also uses it for process-local socket affinity. Every key-carrying route derives its provider `prompt_cache_key` from the Session ID and the prompt-cache namespace, so parallel Sessions never share a provider key. Request-shape tests do not verify live Codex cache reuse, which remains provider-controlled without a hit-rate guarantee. OpenAI-compatible gateways and unsupported model families omit GPT-5.6-only fields. `"implicit"` disables YCoding's generated explicit markers.

Direct OpenAI GPT-5.6 Responses requests automatically request `reasoning.context: "all_turns"` and enable server-side compaction at `200000` rendered tokens. In `stateless` mode, encrypted compaction items are retained outside public Session messages and replayed only for the same provider model. In `stored` mode, compatible requests may instead continue with `previous_response_id`. Direct OpenAI is Responses-only; configured third-party OpenAI-compatible Chat remains a separate route family. ChatGPT OAuth uses Codex HTTP/SSE by default. Set `providers.openai.settings.transport` to `"websocket"` to select the distinct Codex WebSocket route; `"http"` or omission selects HTTP/SSE, and neither route falls back to the other.

The native OpenAI and ChatGPT/Codex routes do not consume `chunkTimeout`, `headerTimeout`, or `timeout` from `providers.openai.settings`. `chunkTimeout` and `timeout` are AI-SDK adapter controls for providers resolved through an AI-SDK package, while `headerTimeout` currently has no runtime consumer. These fields do not prevent an established Codex SSE socket from being reset; native Codex recovery uses the bounded transport retry policy documented in [`runtime.md`](./runtime.md).

Daybreak is OpenAI's Trusted Access for Cyber program with two access levels, `daybreak_blue` and `daybreak_red`, selected per Session as `session.daybreak`; an absent value is off and requests keep standard safeguards. ChatGPT connections discover Daybreak availability from the authenticated Codex model catalog at startup and when the active connection changes. Catalog requests use the supported Codex catalog client version `0.157.1`, independently of the YCoding release version, and retain `User-Agent: ycoding/<version>`. Each ordinary model entry advertising `daybreak_blue` or `daybreak_red` in `available_access_programs.cyber` carries an advertised `daybreak` list containing exactly those programs. Discovery runs in the background with a three-second timeout; missing, unknown, invalid, or unavailable metadata never blocks ordinary model use. Changing the connection clears the previous account's discovery, and late responses cannot restore it.

Use `/daybreak blue`, `/daybreak red`, or `/daybreak off`, or the Daybreak command in the landing or Session command palette. Without an argument, `/daybreak` cycles off → blue → red → off, offering only programs the selected model profile advertises. An explicit named profile uses its own advertised programs, including an empty list; it does not inherit model-wide programs. The provider default uses the model-wide advertisement. The model picker lists ordinary models, not separate Daybreak entries. A landing selection updates the header immediately without creating a Session; it is saved durably as `session.daybreak.set` after Session creation and before the first prompt or explicit goal starts. A Session toggle saves the selection immediately. If saving fails, the prompt or goal does not start. The header shows `Daybreak Blue` or `Daybreak Red` beside the current model name; an unsupported model, profile, or provider shows the saved selection as `(inactive)`. Switching back to a supported model or profile restores the selected mode; `/daybreak off` clears it and removes the indicator.

Requests carry `access_programs: { cyber: <program> }` only when the provider is `openai`, the credential is ChatGPT OAuth, the resolved route is a Codex HTTP or WebSocket backend route, and the active model advertises the selected program. Unsupported models, API-key credentials, custom providers, GPT through OpenRouter, Anthropic, and DeepSeek omit the field while retaining the stored Session selection. Discovery is not entitlement: missing metadata does not establish an authorization denial, and neither plan names nor a ChatGPT UI toggle grant inference access. OpenAI still enforces authorization. Daybreak does not change YCoding permissions, guardrails, or autonomy.

The Core `websearch` tool is provider-independent local search backed by Exa or Parallel. It is distinct from `OpenAI.webSearch(...)`, which adds OpenAI-hosted `web_search` to a direct Responses request and executes at OpenAI.

When `openai_extended_retention` is true, supported pre-GPT-5.6 direct OpenAI requests and Meta Muse Spark requests use `prompt_cache_retention: "24h"`. GPT-5.6-and-later `auto` and `explicit` requests use `prompt_cache_options.ttl: "30m"`; `30m` is that model family's only supported minimum reuse lifetime, not a hard expiry, and OpenAI applies a separate 24-hour maximum. The setting remains false by default because pre-GPT-5.6 extended provider retention may have different privacy and eligibility properties.

`openai_responses_continuation` never changes `openai_responses_state`. The default `stored` state sends `store: true` on direct OpenAI Responses requests; choose `stateless` to send `store: false` and disable response-ID continuation. Enabling extended cache retention or stored Responses state may change provider data-retention behavior; make that choice explicitly.

The default `local` title mode makes no provider request. Set `title` to `model` for model-generated titles; `title: "off"` leaves the initial generated Session title unchanged. Explicit `/goal <text>` calculation always uses a model, while resuming a retained goal does not recalculate it.

### Next-message prediction

| Key                                        | Type                        | Default   | Contract                                                                                                                                                                                        |
| ------------------------------------------ | --------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `efficiency.helper_models.prediction`      | model selector or `session` | `session` | Resolve like the title helper: explicit `agents.prediction.model` wins, otherwise use this selection or the Session/default model.                                                              |
| TUI `keybinds["prompt.prediction.accept"]` | key binding                 | `right`   | Tab or this configurable shortcut fills only while the prompt is empty and a matching ghost suggestion is shown; never sends. Tab and the configured shortcut retain normal behavior otherwise. |

Predictions run only when requested with `/suggest [hint]` in the TUI or web composer; no configuration key enables or disables them. The command opens a dialog with **Project memory (this repository)** and **Global memory (shared knowledge)**, both unselected by default. The hidden primary `prediction` agent has its own prediction system prompt and no tools. Override its prompt with `agents.prediction.system` if needed. The helper receives the latest user and assistant text, bounded to 2,000 and 4,000 characters, and the optional hint, bounded to 2,000 characters. Each selected memory scope adds at most three search hits with snippets of at most 600 characters when the selected agent's effective `memory_read` is `allow` or `ask`; `deny` skips that scope, and memory failures degrade to conversation-only prediction. Accepted output is a single line of 2–40 words and at most 400 characters. Prediction requests use ordinary provider pricing, usage, and privacy policies, including accounting for partial usage before cancellation. Input admission or agent, model, or profile selection cancels in-flight prediction. The TUI and web dismiss on typing, Escape, or new Session activity and reject late suggestions for the dismissed assistant source. TUI acceptance uses Tab or its configurable shortcut, defaulting to Right; web acceptance uses Tab, Right, or **Use suggestion**. Tab retains normal behavior when no suggestion is shown. Neither acceptance path sends or replaces a nonempty draft.

```json
{
  "efficiency": { "helper_models": { "prediction": "session" } }
}
```

### Prompt generation

| Key                               | Type                        | Default   | Contract                                                                                                                       |
| --------------------------------- | --------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `efficiency.helper_models.prompt` | model selector or `session` | `session` | Resolve like the title helper: explicit `agents.prompt.model` wins, otherwise use this selection or the Session/default model. |

Prompt drafts run only when requested with `/prompt <intent>` in the TUI or web composer; no configuration key enables or disables them. The hidden primary `prompt` agent has its own prompt-drafting system prompt and no tools; override it with `agents.prompt.system` if needed. The helper receives the mode (`start`, `steer`, `queue`, or `goal`), the trimmed intent of at most 4,000 characters, the latest user text and assistant text parts bounded to 2,000 and 4,000 characters when present, and at most three snippets of at most 600 characters from each selected memory scope whose selected agent's effective `memory_read` is `allow` or `ask`; `deny` skips that scope, and memory failures degrade to drafting without snippets. Accepted output is at most 8,000 characters and may span lines. Prompt requests use ordinary provider pricing, usage, and privacy policies and are accounted under source `prompt`, including partial usage before cancellation. A newer request for the same Session, or moving, deleting, or archiving the Session, cancels an in-flight request; input admission and execution do not.

```json
{
  "efficiency": { "helper_models": { "prompt": "session" } }
}
```

### Goal helper selection

Configure the goal pre-prompt with `agents.goal.system`. This helper synthesizes objectives and generates context-aware synthetic steers for activation, resume, and continuation. Select its model with `agents.goal.model` or `efficiency.helper_models.goal`; leave both unset to use the current Session model. For example:

```jsonc
{
  "agents": {
    "goal": {
      "system": "Derive one concise, verifiable objective from the user's explicit request and conversation. Return only the objective.",
    },
  },
  "efficiency": {
    "helper_models": { "goal": "session" },
  },
}
```

An unavailable configured model, failed provider request, or empty calculation leaves the prior goal unchanged. The runtime does not fall back to raw input or another model on that failure. The user replaces objectives explicitly; ordinary chat and agent goal-tool calls cannot rewrite them.

For titles, goals, and decision judgments, an explicit model on the hidden agent precedes `efficiency.helper_models.<role>`; a missing value or `session` uses the Session model. Local compaction selects `.compaction.main` or `.subagent` before creating its taskless helper child. An explicit compaction helper precedes the agent-pinned model; missing/`session` retains agent-model then owner-model precedence. A child owner's `session` means its own model. An explicit helper without a profile uses the provider default; inheritance of the full Session model retains its profile. Compaction helper identity/cache state is isolated from the owner. Codex remote compaction uses the owner model; failure falls back to the configured local helper. Direct OpenAI can compact inline on its Session model.

## Permissions

Permissions are evaluated in order. Each rule has:

```json
{
  "action": "read",
  "resource": "src/**",
  "effect": "allow"
}
```

`effect` is `allow`, `deny`, or `ask`.

The TUI has no separate auto-approve permission toggle. Automatic handling is controlled by durable Session autonomy:
YOLO 0 is manual; YOLO 1 auto-approves `ask` permissions and ordinary guardrail reviews, YOLO 2 also answers questions/forms, and YOLO 3 currently behaves like YOLO 2.
An active goal also handles questions/forms and `ask` permissions at YOLO 0, but does not auto-approve guardrail reviews
below effective YOLO 1. Stored numeric levels retain their values without migration or mapping. Explicit denies and inherited permission ceilings remain enforced. Manual permission decisions,
including approval for the current Session, remain available.

For noninteractive runs, `ycoding run --yolo <0-3>` sets the durable Session level before admitting the prompt. Omitting the flag preserves an adopted Session's autonomy; `--yolo 0` explicitly selects manual handling. A failed autonomy update prevents prompt admission.

The noninteractive client does not approve requests locally: any remaining permission, question, form or guardrail blocker is rejected or cancelled and the run exits unsuccessfully. Hard guardrail reviews always require a human decision and cannot be approved by this CLI path.

Home-directory expansion applies to path resources for `external_directory`, `read`, and `edit`. It does not rewrite shell command text.

The `worktree` permission controls listing and creating managed Git worktrees; its built-in default is `allow`, and the read-only BTW advisor asks. Creation also passes through the Session `file_mutation` guardrail. Managed worktrees are stored at `<data>/worktrees/<repo-key>/<name>`, where `repo-key` is `repo_` plus the SHA-256 of the canonical Git common directory, and branch names match directory names. Every checkout listed for the same Git repository (the main checkout and its linked worktrees) is treated as internal for `external_directory`; all other outside paths remain external.

`glob` and `grep` search roots must resolve inside the active Location, including through symlinks. `grep` also accepts an absolute file path directly inside YCoding's managed tool-output directory. A direct file search checks `read` permission before scanning; a directory search checks `read` for each matched file before returning any results. A denied match rejects the search result. `webfetch` checks its `webfetch` URL permission before every HTTP redirect destination, refusing an unapproved destination and limiting chains to ten redirects.

Example:

```jsonc
{
  "permissions": [
    { "action": "read", "resource": "**", "effect": "allow" },
    { "action": "edit", "resource": "src/**", "effect": "ask" },
    { "action": "external_directory", "resource": "~/secrets/**", "effect": "deny" },
  ],
}
```

## Agents

Agents can be defined inline under `agents` or as Markdown resources. See [`repository-resources.md`](./repository-resources.md#agents).

Inline shape:

```jsonc
{
  "default_agent": "god",
  "agents": {
    "reviewer": {
      "description": "Review changes without editing files",
      "mode": "subagent",
      "model": "openrouter/anthropic/claude-sonnet-4",
      "color": "info",
      "steps": 20,
      "permissions": [{ "action": "edit", "resource": "**", "effect": "deny" }],
    },
  },
}
```

When `default_agent` is omitted, YCoding selects the maintained `god` primary agent. Agent listings place the effective default first, so a new TUI session starts with `god` while an explicit `default_agent` remains authoritative. The selectable built-in primaries are `GSD`, `architech`, `god`, and `yangi`; maintained subagents are `occam`, `omoikane`, `wittgenstein`, and `zeus`. `GSD` (Get shit done) is the one-shot delivery profile: it implements directly when fastest, delegates independent work in parallel when useful, and verifies root-cause fixes with focused tests and required affected checks. The visible `btw` advisor and hidden `compaction`, `title`, `goal`, `decision`, and `summary` helpers remain registered. `decision` is a hidden primary helper with all tools denied. `compaction` remains `mode: primary`; its internal taskless child Session does not create a managed subagent task. `build`, `plan`, `explore`, `general`, `analyze`, and `brainstorm` are not built-ins.

Agent fields:

- `model`;
- `request.headers` and `request.body`;
- `system`;
- `description`;
- `mode`: `subagent`, `primary`, or `all`;
- `hidden`;
- `color`: six-digit hex or `primary`, `secondary`, `accent`, `success`, `warning`, `error`, `info`;
- `steps`;
- `disabled`;
- `permissions`.

## Commands

Commands may be inline or Markdown resources. See [`repository-resources.md`](./repository-resources.md#commands).

```jsonc
{
  "commands": {
    "review": {
      "template": "Review the current diff and report concrete defects.",
      "description": "Review the current change",
      "agent": "reviewer",
      "model": "openrouter/anthropic/claude-sonnet-4",
      "subtask": true,
    },
  },
}
```

## Skills and ambient instructions

`skills` accepts local directories, `~/` paths, relative paths, and HTTP(S) URLs.

```jsonc
{
  "skills": ["./team-skills", "~/shared/skills", "https://example.com/skills/archive"],
  "instruction_max_bytes": 102400,
}
```

Ambient instructions currently come from:

- `AGENTS.md` in the global YCoding config directory;
- `AGENTS.md` discovered from the project root toward the current directory;
- MCP server instructions;
- activated skills;
- explicit durable session instruction injection.

The top-level `instructions` field is Schema-accepted but not connected to current instruction discovery.

## References

Reference names cannot contain `/`, whitespace, a backtick, or a comma.

A string beginning with `.`, `/`, or `~` is a local path. Other strings are treated as Git repository references.

```jsonc
{
  "references": {
    "service": "../service",
    "platform": {
      "repository": "https://github.com/example/platform.git",
      "branch": "main",
      "description": "Platform contracts",
      "hidden": false,
    },
    "runbooks": {
      "path": "~/runbooks",
      "description": "Private operational runbooks",
    },
  },
}
```

Relative local paths resolve from the containing configuration file.

## Plugins and hooks

Runtime customization uses explicit `extensions` entries with `identity`, absolute `executable`, optional `args`, and host-granted capabilities. Duplicate identities replace in place. Native process validation rejects JS/TS executables and Node/Bun/npm/npx launchers. Configured processes start while composing their Location under configuration trust; explicit launch or grant-action `ask`/`deny` rules block startup. Tool calls independently enforce the calling Session's permissions and ceilings. Grants constrain host calls, not ambient OS authority. See [repository resources](./repository-resources.md#plugins) for an example and the [process-extension contract](../specs/process-extension-v5.md) for schemas, failure outcomes, and cleanup.

Executable runtime `plugins`, `plugin`, `npm`, singular `provider`, or non-native provider-package declarations reject the affected configuration document. Dynamic npm provider execution and runtime plugin-file auto-discovery are unsupported. Hooks use typed process-extension stages; there is no top-level `hooks` configuration key.

TUI presentation plugins use global `cli.json` `plugins`, with ordered enable/remove selectors. They do not compose backend tools or execution. `frontendPackage.resolve` resolves trusted presentation packages on the backend for local clients; npm must be on its PATH, installation scripts are disabled, and archive/entrypoint integrity is verified.

Meeting speech, processing, analysis, knowledge bindings, and retention use the channel's per-Location Meeting `settings.json`. `ycoding meeting` and `ycoding serve --meeting` enable Rust Meeting services without a runtime plugin declaration or a top-level `meeting` key; enabling them does not download weights or start recording. The source Meeting launcher starts the same Rust backend and attaches its TUI presentation plugin through temporary `cli.json` configuration. It requires a built `rust/target/debug/ycoding-runtime` or `YCODING_RUNTIME_EXECUTABLE`. See [Meeting capture](#meeting-capture).

## MCP

MCP configuration is nested under `mcp.servers`.

MCP server definitions are read when a Location's services boot. Changes to `mcp.servers` take effect after the server restarts or the Location is evicted and initialized again.

```jsonc
{
  "mcp": {
    "timeout": {
      "startup": 15000,
      "catalog": 10000,
      "execution": 120000,
    },
    "servers": {
      "local-tools": {
        "type": "local",
        "command": ["bun", "run", "./tools/mcp.ts"],
        "cwd": ".",
        "environment": { "MODE": "local" },
        "codemode": true,
      },
      "remote-tools": {
        "type": "remote",
        "url": "https://mcp.example.com",
        "headers": { "Authorization": "Bearer {env:MCP_TOKEN}" },
        "oauth": false,
        "codemode": true,
      },
    },
  },
}
```

Local server fields:

- `command`: required string array;
- `cwd`: optional, relative to the workspace; the resolved working directory (the Location directory when unset) must exist and be a directory, otherwise the server fails with `Working directory does not exist: <path>` or `Working directory is not a directory: <path>` without starting a process;
- `environment`;
- `disabled`;
- `codemode`;
- `timeout`.

Remote server fields:

- `url`;
- `headers`;
- `oauth`: object or `false`;
- `disabled`;
- `codemode`;
- `timeout`.

OAuth fields are `client_id`, `client_secret`, `scope`, `callback_port`, and `redirect_uri`.

YCoding negotiates the MCP protocol revision with local stdio and remote Streamable HTTP servers alike. It first sends `server/discover` offering revision `2026-07-28`. A server that supports that revision connects on it: no `initialize` handshake runs, every request carries the `io.modelcontextprotocol/protocolVersion`, client-information, and client-capabilities `_meta` envelope, and Streamable HTTP requests also carry the `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` headers. An unsupported-protocol-version error (`-32022`) that lists a revision of `2026-07-28` or later fails the connection, because the server is a 2026-era server without a revision YCoding supports. Any other answer falls back to the `initialize` handshake offering `2025-11-25`; the server may answer with `2025-06-18`, `2025-03-26`, `2024-11-05`, or `2024-10-07`. A local server receives the probe in the process YCoding starts for the connection. When that process answers with an error, the `initialize` handshake runs in the same process. When it exits or does not answer within 5 seconds, or within the startup timeout if that is shorter, YCoding stops it and starts the command once more for the `initialize` handshake, which has its own startup timeout. A remote server that answers the probe with HTTP 5xx or an unusable reply, or does not answer within the startup timeout, fails to connect; HTTP 401 runs the OAuth handling below. For the life of the YCoding process, a server configuration that connected on a 2025-era revision connects again with `initialize` and no probe; a connection failure discards that knowledge, so the next connection probes again. A `2026-07-28` server receives `server/discover` on every connection because its answer supplies the server's capabilities.

On `2026-07-28` connections, a server asks for input by returning `input_required` from a tool call, prompt, or resource read; YCoding answers form and URL elicitations through the same forms it uses for 2025-era `elicitation/create` requests and retries the call. A URL elicitation completes when the form is answered, because `2026-07-28` has no elicitation-complete notification. Tool, prompt, and resource list changes arrive on a `subscriptions/listen` stream that YCoding opens once per connection when the server advertises `listChanged`; changes made after the server ends that stream are not received until the server reconnects. YCoding does not request server log notifications on `2026-07-28` connections. When a 2025-era Streamable HTTP server answers a request in an existing session with HTTP 404, YCoding runs `initialize` once for the expired session and retries the request, unless the request was cancelled or timed out meanwhile; if that `initialize` fails, the connection closes. A tool whose `outputSchema` cannot be compiled is called without output validation; the other tools of that server keep theirs.

A remote server's OAuth credentials are stored as profiles of its integration, keyed by server name and URL, and every Location and process sharing the data directory uses them. Each connection uses the integration's active profile and reads the stored credential on every request, so a token refreshed or rotated by one connection is used by all of them. When the server rejects the access token, the connection refreshes it with the stored refresh token and retries the request. It keeps the stored refresh token when the token response omits one and stores the rotated token when one is returned. Within one process, a refresh token is exchanged once. Concurrent identical refresh requests share that exchange. When the exchange returns a rotated refresh token, later requests presenting the exchanged token reuse its result until a request presents the rotated token. When a refresh is rejected after the stored token has already been replaced, the connection retries with the replacement. When the token still stored is rejected, the connection removes that profile and reports `needs_auth`. Access tokens are refreshed only after the server rejects them, not ahead of their expiry. Simultaneous refreshes of one single-use refresh token from different processes are not coordinated. Stored tokens and dynamically registered client information record the issuer of the authorization server that produced them, and a credential recorded for a different authorization server is not presented; a credential stored without an issuer is treated as issued by the authorization server discovered when it is used and records that issuer the next time its tokens are saved. The interactive login checks the callback's `state` and then validates its `iss` parameter against the authorization server's metadata before redeeming the code or showing an error the callback reports, and dynamic client registration declares `application_type` `native` for loopback or custom-scheme redirect URIs and `web` otherwise.

Default MCP timeouts are:

| Phase                                                       | Default    |
| ----------------------------------------------------------- | ---------- |
| Transport startup, protocol negotiation, and initialization | 30 seconds |
| Catalog discovery such as `tools/list` and `prompts/list`   | 30 seconds |
| Tool and prompt execution                                   | 12 hours   |

Override a phase globally under `mcp.timeout` or per server under that server's `timeout`. Package-manager launchers such as `npx -y ...` may need a larger startup or catalog timeout on first use.

The TUI displays configured MCP servers in `/mcps`, the status dialog, the sidebar, and the Home/Session footer. Footer counts use `connected/configured` form so failed or pending servers remain visible.

Initial MCP failures and authentication requirements are shown in MCP and Status rather than corner toasts, including the first transition from `pending` to either state. Once a server has settled, a later transition into `failed` or `needs_auth` produces a toast; repeated reads of the same state do not repeat the alert. Selecting an MCP entry in Status opens the MCP dialog for details and connection actions.

An MCP server that declares both the Resources capability and the `io.modelcontextprotocol/skills` extension can publish MCP skills. YCoding lists only validated entry metadata—server label, `SKILL.md` URI, frontmatter, and declared manifest—during catalog discovery; it does not retrieve `SKILL.md` or supporting-file bytes while connecting or listing. The extension is unavailable when either declaration is absent. Loading a selected skill retrieves its declared entry and content only after approval; see [repository resources](./repository-resources.md#mcp-resources-and-prompts) for the content and activation rules.

Status meanings:

| Status                      | Meaning                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pending`                   | The transport is starting or the initial tool catalog is still loading.                                    |
| `connected`                 | Initialization and initial `tools/list` completed successfully.                                            |
| `disabled`                  | Disabled by configuration or disconnected for the current runtime.                                         |
| `needs_auth`                | The remote server requires its registered OAuth flow.                                                      |
| `needs_client_registration` | OAuth requires an explicit client registration.                                                            |
| `failed`                    | Startup, initialization, or initial tool discovery failed. Open the MCP dialog to inspect the exact error. |

Each failed or authorization-blocked connection logs an `mcp connect failed` warning with the server name, the Location `directory`, the resolved `cwd` for local servers, and the status.

YCoding reads the `ycoding` configuration namespace only. Copy required MCP definitions explicitly into the current configuration format.

## Providers and models

The beta's supported providers are OpenAI (API key and Codex subscription), Anthropic (API key and Claude Code subscription), OpenRouter, Cursor, Meta (Muse and API key), Cline (`cline-pass`), Z.ai, MiniMax, Kimi, and OpenAI-compatible custom endpoints. The native catalog includes the regional and coding-plan IDs for Z.ai, MiniMax, and Kimi. Configurations naming other providers load with an unsupported-provider diagnostic and exclude those entries while retaining unrelated valid settings; choosing an excluded provider cannot start model work.

The TUI's custom-endpoint dialog sends `provider.configure` to the backend's global configuration target and waits for its registered result before connecting or activating a credential profile. Credential material is excluded from that configuration request. Provider and model read models refresh after configuration and credential settlement; partial failure remains visible instead of being reported as a completed save. The frontend writes its own preferences and UI history under its frontend XDG state root and does not initialize backend data or cache directories to resolve those paths.

Provider entries support:

- `name`;
- credential environment names in `env`;
- package override in `package`;
- request `settings`, `headers`, and `body` overlays;
- named `models`.

The TUI's `/connect` menu includes a Custom OpenAI-compatible endpoint option. Its dialog writes a provider into the existing global
`ycoding.json` or `ycoding.jsonc` (preferring JSON when both exist), or creates `ycoding.json`
when neither exists. It preserves unrelated provider fields and model entries, and allows an
optional `openai-models` catalog source plus model entries with required IDs and optional names,
families, API types, and disabled flags. API keys are stored as named integration credential
profiles; the provider config refers to that integration so model requests resolve the active
profile. Existing profiles can be selected and activated from the dialog. When profile-backed model
discovery uses the endpoint, its URL must use HTTPS or loopback HTTP, contain no embedded URL
credentials, and not redirect; config-key and header-based catalog discovery keeps its existing
behavior. The dialog highlights the selected catalog source and API type with a filled background.

### Provider profiles

A provider may hold several named profiles: multiple accounts or multiple API keys for the same
provider. A profile is the stored credential's user-facing name. Connecting asks for that name
(`/connect`, the TUI command palette's `Connect integration`, its model selector's connect action, or the web palette's `Connect provider`),
and re-using a name updates that profile instead of replacing the provider's credentials.

In the web, **Connect provider** uses the selected machine and current Session or landing repository.
API keys and manual authorization codes pass through the authenticated relay and are stored only by
the machine's credential owner. A successful connection creates or replaces the named profile and
makes it that provider's global default; it does not reselect an existing Session's explicit profile.
The dialog offers registered key, remote-capable OAuth, and command methods. Loopback-only or
undeclared OAuth methods state that sign-in must happen on the backend machine. A registered command
runs on that machine and may still require local browser interaction. Failed or unknown outcomes
require checking authentication status or refreshing profiles before an explicit retry; writes are
never automatically replayed. Model/profile selection uses **Select provider and model** and retains
the composer's existing pending-selection and draft behavior.

One profile per provider is its default profile; a model reference without a profile uses it. A Session
can select an eligible named profile alongside its model independently of that default, so two Sessions
or subagents can use different accounts for the same provider and model simultaneously. Selecting a
Session profile does not change the default. In the TUI provider dialog, the default profile is marked
**Default profile** and every other stored profile offers **Make `<name>` the default**.
**Use provider default** clears explicit selection. Provider usage reports supported stored profiles;
provider-wide local spend is not per-profile billing.

Model availability, effort variants, and Daybreak access follow the selected profile. A model offered
only by another named profile stays selectable with that profile; it is not usable through an
ineligible provider default. Authenticated custom-provider discovery maintains each stored profile's
own inventory and request settings.

Provider and model configuration overlays apply to every eligible profile, including the default
profile. Configured packages, endpoints, headers, request bodies, and effort variants remain
authoritative after account-specific discovery; selecting a profile does not discard them or
borrow another account's discovered settings.

The public model reference carries the user-chosen `profile` name. Structured configuration selectors
accept it too. String shorthand uses `[profile#]provider/model[#variant]`; omitting the profile uses
the provider's default profile:

```text
Work#openai/gpt-6-luna#high
openai/gpt-6-luna#high
```

Use structured selectors for profile names containing `/` or `#`.

```jsonc
{
  "model": {
    "providerID": "openai",
    "model": "gpt-6-luna",
    "variant": "high",
    "profile": "Work",
  },
}
```

Profile names resolve only within that provider's integration. A missing, renamed, removed, or replaced
explicit profile blocks provider work instead of selecting another account. Re-selecting the same
named profile explicitly restores its binding after replacement. Ordinary token refresh does not
change the selected account. Reusing a Session or admitted-input ID retains its original binding.

Model controls and the Session header distinguish explicit profiles from the provider default. Pending
changes apply before prompt admission; failure preserves the draft. An unavailable saved selection
stays visible with a recovery action. Helpers and subagents keep their existing model precedence. An
explicitly chosen helper model with no profile uses the chosen provider's default profile; only
inheriting the whole owning Session model retains its profile. Explicit profile names select accounts
only within their provider. See the
[profile isolation contract](../specs/provider-profiles.md).

### Claude Code account profiles

The Anthropic integration offers **Claude Code account** as an OAuth method alongside the separate `ANTHROPIC_API_KEY` method. Claude Code account profiles require the `claude` executable on `PATH`. Start from `/connect`, the command palette's **Connect integration**, or the model selector's connect action; choose **Anthropic**, then **Claude Code account**, and name the profile. YCoding runs `claude auth login --claudeai` with `CLAUDE_CONFIG_DIR` set to an isolated profile directory under `<YCoding data directory>/claude-code/profiles/`. The ordinary Claude CLI login and its default configuration remain separate.

The Claude CLI opens the browser; the TUI shows the authorization URL and polls the automatic sign-in attempt. If the pending attempt advertises manual code entry, press `e` and enter the code; the same attempt continues polling until it settles. In the Anthropic integration's profile menu, **Add profile** starts another sign-in, **Use <name>** activates an existing profile, and **Disconnect <name>** removes one. Reusing a profile name replaces that profile's sign-in and activates it; new names retain their own account. The first available name is `default`, and when that name is taken, the prompt offers the next unused `profile-<number>` name.

The isolated Claude CLI profile owns its OAuth credentials. On macOS, Claude Code stores credentials in a Keychain service scoped to that profile; on other platforms, the profile uses its own `.credentials.json`. YCoding does not expose the profile's internal source identifier or Keychain service name. Existing named Claude profiles remain listed, but a profile without its corresponding isolated CLI credentials requires a fresh sign-in; YCoding cannot infer separate account identities from shared CLI credentials. A missing selected profile, or expired credentials that refresh cannot restore, requires reconnect before its model request proceeds. API-key authentication remains separate and is not converted into a Claude Code account profile.

## Decisions

Judgments run only when an agent calls the `decision` tool with `provider: "agent"` and `request: { state, questions }`. Main, child, and side-chat Sessions share the tool and its built-in guidance within effective permissions and inherited ceilings. The calling agent decides when a bounded judgment is useful. The top-level `decisions` configuration key is unsupported and surfaces a removed-key diagnostic; helper model settings remain supported.

The hidden decision agent uses the selected model's regular authentication, privacy, quota, and billing route. Credentials are managed through the selected model integration and never passed as decision-tool inputs or results. Shared agent guidance directs bounded classification, option choice, grading, ranking, unverifiable predicates, and recommendations before `question`, using only authorized evidence.

Requests supply JSON state and 1–32 uniquely named `predicate`, `choice`, or `score` questions. Choices use `{ value, description }`; scores use `{ label, description }` levels with distinguishable adjacent criteria. Batch independent questions and separate dependent ones. Verify factual claims with tests, grep, typechecks, or inventory rather than judging them. Reuse unchanged judgments and preserve explicit owner choices. See [explicit runtime judgments](./runtime.md#explicit-decision-judgments) and the [decision contract](../specs/decisions.md).

### Decision agent

The hidden primary `decision` agent evaluates JSON state and bounded questions without tools and returns strict TOON. Its ID is reserved for the decision tool, not foreground Session or command selection. Select its model with `agents.decision.model`, then `efficiency.helper_models.decision`; missing helper configuration or `"session"` uses the owner Session model, or the normal default resolver when no model is selected. The selected model's existing authentication route is used, including supported subscription routes. Its provider's ordinary privacy, quotas, and pricing apply. This does not establish free usage or a zero-retention guarantee, and local Session history and tool results remain durable.

Retain the owner Session model for the helper:

```jsonc
{
  "efficiency": { "helper_models": { "decision": "session" } },
}
```

Confidence is self-reported and uncalibrated. Every question type can abstain for insufficient evidence: the helper returns `type: refusal`, null `answer`, `choice`, and `score`, and confidence `0`. Refusal is distinct from a real option or low-confidence pick. The tool preserves that structured result and adds a model-visible explanation to gather missing evidence or ask the user. Set the action threshold by the cost of being wrong; treat refusal, errors, low or close confidence, and disagreement with evidence as uncertainty. Judgments never grant permission, supply the user's answer, or prove completion.

Schema-invalid calls return tool errors identifying the field path, expected shape/allowed values, and a minimal valid request without echoing evidence or secrets. Empty questions explicitly request one bounded question or skipping the tool. Helper-unavailable errors identify model settings and authentication to check; invalid TOON errors identify uncertainty rather than fabricated answers. No unchanged judgment is retried automatically. See the [agent input and TOON contract](../specs/decisions.md#decision-agent-inputs).

### Muse (Meta)

The builtin `muse` provider supports a **Meta Muse Code account** or a **Meta Model API key**. Run `ycoding`, open `/connect`, choose **Muse (Meta)**, and name the profile:

- **Meta Muse Code account** starts Meta's OAuth device flow. Open the displayed verification URL and enter the code; YCoding polls until authorization succeeds, is denied, or expires. Access tokens and optional refresh tokens stay in YCoding's credential store.
- **Meta Model API key** stores a direct key; alternatively set `META_API_KEY` in the server process environment. Direct keys use `https://api.meta.ai/v1` and skip account key minting.

For an account, YCoding lazily mints an inference key with `POST https://api.meta.ai/muse-code/key` using the Meta access token and `{"onboard":false}`. A response requiring payment or reporting an inactive subscription fails with a subscription/payment setup message and the action URL when supplied. The key and returned base URL are cached only in memory for that credential ID and generation. An inference HTTP 401 remints once and retries once; a second rejection requires re-login. Direct-key requests do not remint.

Model discovery reads `GET <origin of base URL>/muse-code/models` on connection startup or change and reconciles stored credentials every minute. Model data comes from each row's `metadata["muse-code"]`: names use `name` when present, otherwise the row's `id`, release dates use `release_date`, and input/output capabilities use `modalities`. Hidden models, non-tool models, models without text output, and rows without integer `limit.context` and `limit.output` are skipped with a warning; limits are never inferred. Failed discovery retains only the same account's existing inventory and retries on reconciliation. Effort choices follow the catalog's `variants` keys in catalog order, including `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` when advertised. Each variant sends its catalog `reasoningEffort`; the default effort comes from `options.reasoningEffort` and is omitted when absent. Catalog temperature and top-p hints are not sent.

Inference uses streaming OpenAI Responses with `store: false`, encrypted reasoning, automatic reasoning summaries, full-input replay, and YCoding's Session-scoped prompt cache key. Requests carry `x-client-id: tbh:exec` and matching Muse session UUID headers; the SDK hook has no Session identity, so those headers use one process-stable UUID. Provider thoughts remain reasoning in the transcript. Commentary message phases, function tool calls, cached-input usage, and reasoning-token usage use the Responses adapter. Trailing `response.subscription_usage` events update subscription quota without changing inference bytes: the reported window duration supplies its label (300 minutes is a **5-hour window**), alongside **Weekly** usage and reset times. These snapshots have source `response_stream` and stability `observed`; they are isolated per credential profile, while environment-key observations remain unbound.

Limits: account token refresh is unsupported. Tokens with a reported expiry, or tokens rejected by Meta, require re-login through `/connect` → **Muse (Meta)**. When authorization reports no expiry, YCoding stores expiry as unknown. Minted key lifetime is unknown; YCoding relies on the bounded HTTP 401 remint rather than a guessed expiry. Model cost is unreported. Subscription quota is unreported until an inference response supplies it and is retained only in memory; a quota read never mints a key or calls a separate usage endpoint. Missing metrics stay absent rather than becoming zero; catalog rows do not establish pricing or remaining usage.

### Cursor

The `cursor` provider runs models from a Cursor subscription through YCoding's native Cursor client, which speaks Cursor's private Connect-RPC agent protocol with a CLI-shaped client identity. Use it only with a Cursor account you own; Cursor may change or restrict that protocol without notice.

Connect it with `ycoding auth login` (or `/connect`) and choose **Cursor**:

- **Cursor account (browser login)** opens Cursor's PKCE sign-in page and stores the returned access and refresh tokens; YCoding refreshes the access token within five minutes of its expiry.
- **Cursor API key (crsr\_…)** stores a key from cursor.com settings; the package exchanges it for an access token and refreshes that token itself.
- `CURSOR_API_KEY` in the environment is used as a connection without storing it.

Credentials stay in YCoding's integration store; YCoding never writes them to Protocol, events, or logs. Model discovery, the model cache (`cursor-models.json`), Cursor project metadata (`projects/<slug>/`), and 24-hour conversation snapshots (`cursor-conversations/`) live under `$XDG_CACHE_HOME/ycoding/cursor`.

The Cursor request context reads project `.ycoding` configuration up to the filesystem root and YCoding's global configuration, including `ycoding.json` and `ycoding.jsonc`. It can discover `.claude/skills` and `.agents/skills` from the project ancestry and home directory, but sends only skill paths and descriptions in provider context: activated skill content still comes from the Session's instructions. This filesystem collector does not see inline or explicit `YCODING_CONFIG` sources or Location-scoped configuration overrides, so those sources may not appear in provider-side resource hints. Cursor's project metadata stays in YCoding's cache, not in the repository. These context sources do not grant tool authority or replace the Session's Location.

The Cursor adapter appends a stable SYSTEM instruction after the existing system content: identify as an AI agent rather than Cursor, follow user instructions within higher-priority instructions, permissions and guardrails, and use only declared tools and MCP capabilities. It requires task-relevant authorized use before claiming a declared capability is unavailable, distinguishes permission denial from unavailability, and prohibits unrelated probes, repeated denied actions and invented capabilities. This supplement applies only to the Cursor provider package; it does not change durable Session instructions, tool discovery or permissions.

YCoding discovers the account's models when the connection starts or changes, and reconciles the stored connection every minute, so a connection made by another YCoding process is picked up without restarting. A failed discovery keeps the models already published and is retried by the next reconcile; with no usable connection, or after failed discovery with no cached list and nothing published yet, the provider has no models. Each advertised context size is a distinct catalog model: the base size uses `<model>`, and alternatives use a size suffix such as `<model>-500k` or `<model>-1m`. When Cursor offers effort choices, their IDs are `low`, `medium`, `high`, or `xhigh`; selecting one sends its full source-offered parameter tuple, including context size. A single non-effort tuple is the model's setting rather than an extra picker choice. Fast tuples use a separate `<model>-fast` entry, with a distinct cost only when Cursor publishes one. Base entries use Cursor's advertised context (200,000 when unpublished, 256,000 for `default`) and a 32,000 output limit; 1M entries use a 128,000 output limit. An explicitly saved old variant label that is not offered remains unavailable until the user selects a current choice; YCoding does not silently remap it. Image input is advertised only when Cursor's model list reports image support. Costs are the package's published Cursor token rates; they are local estimates, not Cursor billing.

Limits: Cursor-native interactions without a YCoding tool (interactive background-shell input, image generation, native web, pull-request, MCP-resource download, and source-control requests) are declined to Cursor and the Run continues. Web search and fetch reach Cursor only when the agent advertises `websearch` or `webfetch` as direct tools. A Run held open with no tool result for 10 minutes is closed and the next step rebuilds from history.

Model entries support:

- `modelID`, `family`, `name`, and `package`;
- request overlays;
- `capabilities.tools`, `capabilities.input`, and `capabilities.output`;
- variants as an array of `{ id, settings?, headers?, body? }`;
- cost information;
- `disabled`;
- `limit.context`, `limit.input`, and `limit.output`;
- `api`, the OpenAI-compatible request surface (`chat` or `responses`) documented below.

OpenAI-compatible endpoints resolve their request surface with the source code default first,
then any value discovered by the catalog, then an explicit `api` on the provider `settings`
(`providers.<id>.settings.api`) or on a model entry (`providers.<id>.models.<id>.api`). The
model entry value wins over the provider value, and either overrides the chat default and any
catalog value. An omitted `api` keeps the chat-completions route; set it to `responses` to use
the OpenAI Responses route against the configured `baseURL`.

A provider with `catalog.source: "openai-models"` discovers models from its authenticated
`GET <baseURL>/models` endpoint. Discovered records may publish `name`, `capabilities`,
`limit`, and `variants`; those values are imported directly and override matching standard
catalog metadata for that provider model. This lets self-hosted OpenAI-compatible endpoints
report their real context/input/output limits and named request variants without duplicating
every model in YCoding configuration.

### Rust backend endpoint configuration

The Rust backend accepts provider-level `providers.<id>.package` and model-level
`providers.<id>.models.<model>.package` declarations when the identity belongs to
the native router's closed set (`resources::model::family`). Every identity can
use one optional `aisdk:` prefix. For example,
`aisdk:@openrouter/ai-sdk-provider` selects the native OpenRouter implementation,
and `@ycoding-ai/ai/providers/openai` selects the native OpenAI implementation.
Model-level packages override their provider's package. These declarations do
not execute npm provider code; dynamic provider loading is unsupported. Unknown
package identities, singular `provider`, and executable `plugins`, `npm` or `plugin`
declarations are rejected.

Local v5 clients can use `provider.configure` to persist an endpoint in global
or project configuration. The backend selects the target, preserves unrelated
JSONC comments/settings, validates endpoint URLs and implementation collisions,
reloads and confirms integration registration. OpenAI-compatible endpoints accept
chat or Responses and optional model discovery. Supplied model fields are merged
without erasing omitted fields.
The request cannot contain an API key or credential profile. Connect and activate
credentials separately through `integration.connect.key` and `credential.activate`.

`mcp.configure` persists a typed server definition in `mcp.servers.<name>` and
reloads it. Environment values, headers and OAuth secrets remain in that
configuration definition. A replacement that reports failed startup restores the
previous configured definitions and retains the usable Location generation;
authentication-required and intentionally disabled states remain explicit.
`mcp.add` is live-only.

`ycoding mcp add` uses `mcp.configure` with project scope, or global scope with `--global`. It reports the backend-selected target; it does not edit a frontend-local configuration file.

Provider writes prefer `ycoding.json` then `ycoding.jsonc` in the selected
directory. MCP writes prefer those files, then `.ycoding/ycoding.json` and
`.ycoding/ycoding.jsonc`. Both use `ycoding.json` when no candidate exists. Global
scope uses the backend configuration directory and project scope uses its
Location directory. Production permits both scopes for local clients; remote
clients cannot invoke these operations. Rust discovery includes an existing
`.ycoding` directory under the global configuration directory after its
top-level JSON/JSONC sources, so the nested MCP targets are reloaded too.
A written file whose reload or
registration fails is reported as an explicit partial failure with its target.

`frontendPackage.resolve` is also local-only. It installs npm registry
presentation packages into the backend cache, requires npm on the backend PATH,
disables installation scripts, and returns an exact package identity with
archive/file digests and a verified TUI entrypoint. It does not load backend
extensions or transfer package assets to a remote browser.

TUI registry-package loading resolves the current managed endpoint before calling `frontendPackage.resolve` and imports the verified returned entrypoint. A rejected package produces no local entrypoint.

## Formatter, LSP, attachment, and output settings

Formatter configuration is `false`, `true`, or a record:

```jsonc
{
  "formatter": {
    "prettier": {
      "command": ["bun", "x", "prettier", "--write", "$FILE"],
      "extensions": [".ts", ".tsx"],
      "environment": { "NODE_ENV": "development" },
    },
  },
}
```

Each formatter entry supports `disabled`, `command`, `environment`, and `extensions`.

LSP configuration is `false`, `true`, or a record. A server entry supports `command`, `extensions`, `disabled`, `env`, and `initialization`. `{ "disabled": true }` is also accepted.

```jsonc
{
  "attachments": {
    "image": {
      "auto_resize": true,
      "max_width": 2048,
      "max_height": 2048,
      "max_base64_bytes": 8000000,
    },
  },
  "tool_output": {
    "max_lines": 2000,
    "max_bytes": 200000,
  },
  "watcher": {
    "ignore": ["node_modules/**", "dist/**"],
  },
}
```

## Compaction and experimental settings

```jsonc
{
  "compaction": {
    "keep_recent_messages": 20,
    "reserved_output_tokens": 4096,
    "context_safety_margin_tokens": 4096,
    "timeout_seconds": 60,
    "max_output_tokens": 4096,
    "max_manifest_bytes": 65536,
    "max_internal_passes": 8,
    "advisory": {
      "consider_percent": 70,
      "strongly_advised_percent": 90,
    },
  },
  "experimental": {
    "subagent_depth": 2,
    "policies": [],
  },
}
```

Soft thresholds are runtime-owned. A Session starts background compaction once when it rises from normal pressure to `consider`, and once more only if it rises to `advised`. A successful or deduplicated admission latches the level until pressure returns to normal; a failed admission unlatches it for a later retry. Mandatory pressure never starts this soft path. No cooldown or polling configuration is required.

`experimental.subagent_depth` defaults to `1` when omitted.

## Guardrail configuration and custom files

`guardrails` controls the Location-scoped root-Session-family safety service:

```jsonc
{
  "guardrails": {
    "enabled": true,
    "max_concurrent_shells": 8,
    "shell_wait_seconds": 60,
    "max_concurrent_subagents": 8,
    "max_pending_reviews": 16,
  },
}
```

| Field                                 | Exact type       | Default | Operational remark                                                                                        |
| ------------------------------------- | ---------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `guardrails.enabled`                  | boolean          | `true`  | Enables the guardrail service; no configuration or approval reply overrides a standard catastrophic deny. |
| `guardrails.max_concurrent_shells`    | positive integer | `8`     | Running-shell cap per root Session family, including background shells.                                   |
| `guardrails.shell_wait_seconds`       | positive integer | `60`    | How long a shell over the cap waits, first come first served, for a slot before failing with the limit.   |
| `guardrails.max_concurrent_subagents` | positive integer | `8`     | Running-subagent cap per root Session family.                                                             |
| `guardrails.max_pending_reviews`      | positive integer | `16`    | Pending-review cap per root Session family.                                                               |

Standard recursive-deletion rules exclude `/tmp`, `/private/tmp`, `/var/tmp`, `/private/var/tmp`, `/var/folders`, and the process `TMPDIR`, including descendants. Filesystem root, configured or other exact user homes, and system-directory deletion are denied. Project-root, ancestor, and direct home-child deletion, destructive Git, force push, and destructive database statements require hard human review. Edits, writes, patches, and shell commands that reach outside the repository require ordinary review through the normal review/YOLO path, without helper classification; every checkout of this repository (the main checkout and every linked worktree sharing its Git common directory) and temporary roots count as inside, and recognized read-only shell commands (including `cd`, `exit`, `ps`, `pgrep`, and `lsof`) are exempt, as are read-only segments of compound commands that do not redirect outside. An interpreter's script argument (`sh`, `bash`, `zsh`, `node`, `bun`, `deno`, `python`, `python3`, `ruby`, `perl`) and a heredoc body consumed by a non-shell interpreter are executed code, not outside operands; a command whose working directory is outside still requires review. Paths under YCoding's global config, data, cache, state, temporary, bin, log, and repos directories, including descendants, do not require that review. A path is also exempt when the calling Session's effective `external_directory` permission is `allow`, using the same directory-glob resource and `~` expansion as other path permissions from global and project `permissions` and from the agent. `ask` and `deny` do not exempt a path. A shell command that also reaches a non-exempt outside path still requires review. These exemptions do not apply to hard reviews or catastrophic denies. Publication, production deployment, security-policy changes, and MCP execution have no standard guardrail rule.

Custom rule files are direct `guardrails/*.md` children of the global config directory and each discovered repository `Config.Directory`; nested directories are not scanned. Source layers evaluate nearest repository first, then broader repositories, then the global directory. Within a layer, rules sort by descending numeric `priority`, then deterministic lexical file path and rule ID. See [`guardrails-and-provider-usage.md`](./guardrails-and-provider-usage.md#custom-guardrails) for the complete file contract and the unoverrideable catastrophic-deny, reply, and transient-approval rules.

## CLI/TUI configuration

The terminal client reads one global file:

```text
<YCoding config directory>/cli.json
```

It accepts JSONC and preserves comments when the TUI updates settings.

Example:

```jsonc
{
  "theme": { "name": "ycoding", "mode": "dark" },
  "leader": { "timeout": 2000 },
  "scroll": { "speed": 1, "acceleration": true },
  "attention": {
    "enabled": true,
    "notifications": true,
    "sound": true,
    "volume": 0.4,
    "sound_pack": "ycoding.default",
    "sounds": {
      "permission": "~/sounds/permission.wav",
      "done": "~/sounds/done.wav",
    },
  },
  "diffs": { "wrap": "word", "tree": true, "single": false, "view": "auto" },
  "terminal": { "title": true, "copy_on_select": false },
  "prompt": { "editor": true, "paste": "compact" },
  "session": {
    "sidebar": "auto",
    "scrollbar": true,
    "thinking": "show",
    "grouping": "auto",
  },
  "hints": { "onboarding": true },
  "debug": { "devtools": false, "timing": false },
  "animations": true,
  "mouse": true,
}
```

Defaults applied by the TUI:

| Setting                   | Default           |
| ------------------------- | ----------------- |
| `attention.enabled`       | `true`            |
| `attention.notifications` | `true`            |
| `attention.sound`         | `true`            |
| `attention.volume`        | `0.4`             |
| `attention.sound_pack`    | `ycoding.default` |
| `leader.timeout`          | `2000` ms         |
| `mouse`                   | `true`            |

All other `cli.json` fields are optional and remain `unset` until configured. The schema-recognized field paths are:

| Field path                                                         | Exact type or closed values                       | Default               | Operational remark                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `theme.name`                                                       | string                                            | unset                 | Discovered theme ID: a built-in such as `ycoding`, `one-dark`, `one-dark-pro`, or `high-contrast`, or a custom theme file. A standalone theme that omits `text.separator`, `text.hint`, or `text.label` reads them as its own `text.subdued`; an unreadable custom theme file is skipped without affecting the others. |
| `theme.mode`                                                       | `system` \| `dark` \| `light`                     | unset                 | `system` follows the terminal.                                                                                                                                                                                                                                                                                         |
| `keybinds.<command>`                                               | key-sequence override                             | unset                 | The supported command names and default bindings are owned by `packages/tui/src/config/keybind.ts`.                                                                                                                                                                                                                    |
| `plugins[]`                                                        | string \| `{ package: string, options?: record }` | unset                 | TUI-side plugin directives, separate from Core runtime plugins.                                                                                                                                                                                                                                                        |
| `leader.timeout`                                                   | positive integer milliseconds                     | `2000`                | Wait time after the leader key.                                                                                                                                                                                                                                                                                        |
| `scroll.speed`                                                     | number `>= 0.001`                                 | unset                 | Distance per scroll-input tick.                                                                                                                                                                                                                                                                                        |
| `scroll.acceleration`                                              | boolean                                           | unset                 | Repeated-input acceleration.                                                                                                                                                                                                                                                                                           |
| `attention.enabled`, `.notifications`, `.sound`                    | boolean                                           | `true`                | Master alerts, system notifications, and attention sound.                                                                                                                                                                                                                                                              |
| `attention.volume`                                                 | number `0..1`                                     | `0.4`                 | Attention-sound volume.                                                                                                                                                                                                                                                                                                |
| `attention.sound_pack`                                             | string                                            | `ycoding.default`     | Active sound-pack ID.                                                                                                                                                                                                                                                                                                  |
| `attention.sounds.<event>`                                         | string                                            | unset                 | Event is `default`, `question`, `permission`, `error`, `done`, or `subagent_done`.                                                                                                                                                                                                                                     |
| `diffs.wrap`                                                       | `word` \| `none`                                  | unset                 | Diff line wrapping.                                                                                                                                                                                                                                                                                                    |
| `diffs.tree`, `.single`                                            | boolean                                           | unset                 | File-tree visibility and single-patch view.                                                                                                                                                                                                                                                                            |
| `diffs.view`                                                       | `auto` \| `split` \| `unified`                    | unset                 | `auto` selects from terminal width.                                                                                                                                                                                                                                                                                    |
| `terminal.title`                                                   | boolean                                           | unset                 | Terminal title updates.                                                                                                                                                                                                                                                                                                |
| `terminal.copy_on_select`                                          | boolean                                           | `true` except Windows | Copy a dialog's mouse selection when it is released; main screens require an explicit copy action.                                                                                                                                                                                                                     |
| `prompt.editor`                                                    | boolean                                           | unset                 | Adds active editor file or selection to prompt context.                                                                                                                                                                                                                                                                |
| `prompt.paste`                                                     | `compact` \| `full`                               | unset                 | Large-paste presentation.                                                                                                                                                                                                                                                                                              |
| `session.sidebar`                                                  | `auto` \| `hide`                                  | unset                 | `auto` shows the sidebar when width permits.                                                                                                                                                                                                                                                                           |
| `session.scrollbar`                                                | boolean                                           | unset                 | Transcript scrollbar.                                                                                                                                                                                                                                                                                                  |
| `session.thinking`                                                 | `show` \| `hide`                                  | unset                 | Default reasoning visibility.                                                                                                                                                                                                                                                                                          |
| `session.grouping`                                                 | `auto` \| `none`                                  | unset                 | Related transcript-item grouping.                                                                                                                                                                                                                                                                                      |
| `hints.onboarding`, `debug.devtools`, `debug.timing`, `animations` | boolean                                           | unset                 | Guidance, diagnostics, and animation switches.                                                                                                                                                                                                                                                                         |
| `mouse`                                                            | boolean                                           | `true`                | Terminal mouse capture.                                                                                                                                                                                                                                                                                                |

Attention sound names are `default`, `question`, `permission`, `error`, `done`, and `subagent_done`. System notifications for attention events are requested while the terminal is blurred or before it has reported its focus, and are suppressed while it is known to be focused; delivery also depends on the terminal's notification support and the operating system's notification settings for that terminal.

`terminal.copy_on_select` controls copy-on-select in dialogs. When enabled (the default except on Windows), releasing a dialog's mouse selection copies it. Main screens, including the transcript, always require an explicit copy action regardless of this setting. Use `Ctrl+C` on every supported platform or `Cmd+C` on macOS to copy a selection, and press `Esc` to clear it. Selection copy consumes `Ctrl+C` and cannot exit the application. Without a selection, `Ctrl+C` keeps its prompt behavior and requires two presses to exit from an empty prompt; `Esc` never exits YCoding.

`keybinds` is a record of command names to key sequences. The complete current key map lives in `packages/tui/src/config/keybind.ts`; that file is authoritative when bindings are added or renamed.

`session_find` opens Find in loaded history in the current Session. Its default is `ctrl+shift+g`; set `keybinds.session_find` in `cli.json` to override it. The command palette also provides **Find in loaded history**.

`keybinds.session_task_pin_toggle` defaults to `p` and pins or unpins the selected child task while the TUI Subagents composer list is focused.

The TUI `plugins` array accepts strings or `{ package, options }` and configures presentation plugins. Backend customization uses `extensions` instead.

Built-in TUI selectors settle before optional plugin loading; see [terminal plugin ordering](./repository-resources.md#ordered-enablement-and-removal). Optional plugins do not delay the Home or Session shell. Status lists their loading and failure states.

Assistant and compaction transcript text always renders as Markdown. There is no syntax-source display setting.

## Managed-service configuration

The background service uses a channel-specific file in the global YCoding config directory:

| Channel                                | File                              |
| -------------------------------------- | --------------------------------- |
| `latest`                               | `service.json`                    |
| `local`                                | `service-local.json`              |
| Other channel, including branch builds | `service-<SHA-1-of-channel>.json` |

Shape:

```json
{
  "hostname": "127.0.0.1",
  "port": 29706,
  "password": "private-generated-value"
}
```

`hostname`, `port`, and `password` are optional. The password is generated and persisted with mode `0600` when absent.
HTTP requests authenticate with `Authorization: Basic` using the username `ycoding` and the configured password. Query-string credentials do not authenticate requests.

Default managed ports are deterministic and product-namespaced:

```text
10000 + (first 32 bits of SHA-1("ycoding:<channel>") mod 50000)
```

This prevents branch builds of YCoding from colliding with another product process using the same channel name.

When a configured port is occupied, edit the channel-specific service file and choose another integer from `1` to `65535`. `ycoding --standalone` is a temporary alternative that starts a private server instead of the managed service.

One managed service owns a file-backed database at a time, across ports. The Rust launcher holds `<data directory>/runtime.lock` through database import, composition, serving, and shutdown; a contender whose namespace is already owned exits successfully without replacing the active registration, including while the owner is starting. Beta and stable have separate data and lock paths. The OS releases each lock when its owning process exits. Store open validates the complete catalog and codecs; an incompatible or unreadable store fails startup unchanged.

The matching registration file is stored in the YCoding state directory. It contains the service instance ID, version, URL, PID, and private password. Do not hand-edit a live registration file.

Managed-service startup checks readiness more frequently during its initial wait, then uses a slower polling cadence. Polling delays are capped by the remaining startup wait and do not shorten the backoff between server spawn attempts. Both Effect and Promise clients return only a healthy, compatible service in the `ready` state.

### Rust runtime executable

The native CLI embeds the `ycoding-runtime` executable and extracts it into a version-and-SHA-256-addressed private path before launch; a cached payload must match the embedded digest. Source execution requires a built `rust/target/debug/ycoding-runtime` or `YCODING_RUNTIME_EXECUTABLE`. Native payload builds require a matching host. No runtime file is added to the release archive.

The extracted path is `<bin>/runtime/<frontend version>/<SHA-256>/ycoding-runtime` (`.exe` on Windows), preserving an existing service executable during update. Source-only `YCODING_RUNTIME_EXECUTABLE` does not override an installed embedded payload. Backend observability starts in Rust, not the CLI process. `--frontend-executable` binds installed native assets to the frontend directory, so the computer-use app stays beside `ycoding`; without it, helper-dependent operations report `helper_unavailable` rather than guessing another asset owner.

The Rust executable accepts an optional leading `serve`, `--hostname <host>`, `--port <port>`, `--service`, `--stdio`, repeatable `--cors <origin>`, `--meeting`, `--paths`, and `--frontend-executable <path>`. The CLI supplies its own frontend executable path for native assets. `--service` and `--stdio` cannot combine. Meeting is off by default. Hostname defaults to `127.0.0.1`; an explicit port is 0–65535 (0 is ephemeral). Without a port, a non-service process binds the first free port from 4096; service mode uses the channel default. Service configuration supplies hostname/port/password with arguments taking precedence. The CLI passes its installation version/channel; direct Rust launch uses `YCODING_VERSION` and `YCODING_CHANNEL` (defaults: crate version and `local`).

The password resolves from the service file in service mode, otherwise from `YCODING_PASSWORD` then `YCODING_SERVER_PASSWORD`; when no source supplies one the process generates one, persists it into the service file in service mode, and prints it as `server password <password>` only in default mode. HTTP and WebSocket requests authenticate with Basic auth as user `ycoding`. A generated password is never printed in service or stdio mode. In stdio mode the binary captures the lease password while single-threaded, removes both password variables from its process environment, then creates the Tokio runtime; tool subprocesses cannot inherit those lease variables.

Bootstrap initializes the resolved roots, installs Core observability with its guard retained through shutdown, opens the Store, composes `Core::production`, and binds the TCP listener before publishing readiness. Stdio mode prints exactly one line `{"url":"http://<address>"}`; default and service modes print `server listening on http://<address>`. Authenticated `GET /health` is the bootstrap/readiness surface; `GET /api/health` serves the TypeScript service-discovery contract. Both reject missing or incorrect Basic auth with `401` and return `200` with `{healthy: true, version, pid, sourceEpoch}` when ready. `/ws/v5/local` serves the v5 socket and typed `health.get` with the same identity.

Service registration contains exactly `id`, `version`, `url`, `pid`, and `password`. The launcher writes a unique `0600` temporary file, syncs it, and atomically renames it into the state directory after readiness. The beta service filename is `service-a295e0bdde1938d1fbfd343e5a3e569e868e1465.json` and its default port is `34393`. The service checks registration ownership every five seconds and shuts down when any of these fields changes or the file becomes unreadable. Clean shutdown removes the registration only when all five fields still match this process's registration; JSON formatting and property order do not change ownership. Discovery reads only registration, checks authenticated health and PID/version agreement, and gates the required version. Ensure reuses a compatible ready service, replaces a version mismatch through the exact instance identity, and does not kill slow-starting contenders.

Shutdown is graceful: `SIGINT`, `SIGTERM`, stdin close in stdio mode, loss of service registration, or accepted `health.stop` stops acceptance, drains/closes wire connections, shuts down Core maintenance, closes the Store, and removes only owned registration. `POST /api/service/stop` accepts the TypeScript `ServiceStatus.StopRequest` body `{instanceID}`; typed v5 `health.stop` uses the same identity. Only the exact managed instance can return `{accepted:true}`. An unmanaged runtime or stale identity returns `{accepted:false}`; malformed HTTP input returns `400`. The v5 stop Result is sent before initiating shutdown, or shutdown proceeds when that requesting connection is lost. Normal shutdown exits `0`; usage errors exit `2`; startup/runtime failures exit `1`, and service-mode failures also write a private diagnostic to `YCODING_SERVICE_STARTUP_ERROR_FILE` when set.

## Chrome extension connection

The landing command palette also offers **Connect Chrome**. It scopes the connection to a Session in the current Location, creating an idle Session only when none is available.

The **Connect Chrome** command in both the Mini and full Session palettes displays the connected loopback service address and current pairing state. A paired but disconnected extension is reported as **Paired; waiting for Chrome to reconnect** and does not offer another pairing code. Use **f** to explicitly forget the saved trust; when unpaired, **p** creates a one-time code. The full dialog keeps a generated code visible through status polls and **r** refreshes until the code is used or expires. The dialog also shows the extension folder to load unpacked: `ycoding-chrome-extension` beside the installed executable, or `extensions/chrome` in a source checkout. Enter the code in the extension's popup. The popup uses `http://127.0.0.1:4096` by default; if the view shows another address, enter it once under **Local service address**. The extension remembers the address and reconnect credential, so pairing does not require the initiating Session to remain active. Pairing authorizes eligible existing and future tabs in that Chrome profile, including the active tab. The manifest requests `tabs`, `tabGroups`, `alarms`, `debugger`, and `storage`, with host access limited to loopback. Omitted browser mode uses the paired profile; `mode: "owned"` opens Session-owned background tabs. Model-driven profile reads require site permissions without a standard access review; mutations require site permissions, and group changes also require control permission. Owned-tab open requires target-site permissions. Approved site actions may cause incidental downloads; explicit download/upload access is not configured. See [Chrome browser bridge](./browser-extension.md) for ownership, badges, and safety limits.

The popup shows **Local service address**, **Pairing code**, and **Connect YCoding** only before pairing. It then shows a connection indicator, with **Forget pairing** to revoke browser access. A temporary outage retains the pairing and retries without another code, including after Chrome startup or YCoding service restart; an explicit stop leaves it paused until **Retry connection** is chosen. The popup supports light and dark themes.

## Isolated browser availability

Temporary headless browsing is started explicitly from the current Session's **Isolated browser** command, not by enabling a config key. The implementation requires macOS arm64 and installed Google Chrome major 152 or newer in its standard application location. It does not install Chrome, accept an arbitrary executable or debugging endpoint, or reuse a personal profile. Unsupported environments report unavailable; matching the version does not bypass startup capability checks.

The URL must use HTTP or HTTPS without embedded credentials. Stop the paired Chrome bridge before starting isolated mode, or stop isolated mode before creating extension pairing. Browser permissions and Session guardrails still govern model actions. See the [isolated-browser contract](../specs/isolated-browser.md) for temporary-state semantics, restrictions, and environment-specific validation evidence and limits.

## Runtime capability selection

The resolved Location `capabilities` policy controls tool visibility, builtin and
ambient instructions, skill IDs, MCP server admission and managed artifact catalogs.
Each runner step acquires the current configuration generation before selecting
instructions and materializing tools. Agent permissions and inherited Session
ceilings still restrict that selection; subagents cannot regain nesting tools.
Disabled instruction keys publish durable removals and can re-enable under the same
keys. MCP server admission remains fixed at Location boot: unrelated configuration
reloads change accessible-tool guidance without restarting the manager.

`capabilities.websearch_provider` accepts `"exa"` or `"parallel"`. Every web-search
call reads the resolved Location pin before `YCODING_WEBSEARCH_PROVIDER`, provider
enable flags or stable Session-based selection. Removing the pin restores normal
selection; transport authentication, limits and credential redaction are unchanged.

## Session retention

```json
{
  "session_retention": {
    "days": 7
  }
}
```

| Key                      | Type             | Default | Effect                                                                                       |
| ------------------------ | ---------------- | ------- | -------------------------------------------------------------------------------------------- |
| `session_retention.days` | positive integer | `7`     | Delete a root Session family once every member has been idle for longer than this many days. |

`session_retention` is global-only: the backend reads global configuration, `YCODING_CONFIG`, and `YCODING_CONFIG_CONTENT`, ignoring project settings because one canonical Store serves every project. Each sweep reads retention configuration. See [automatic Session retention](./runtime.md#automatic-session-retention) for family scope, exemptions, and scheduling.

### Rust backend validation

The Rust configuration validator in `ycoding-core` accepts the same keys with these shapes:

| Key                                            | Rust-validated shape          | Consumer behavior                                                                                                                                                                    |
| ---------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session_retention.days`                       | positive integer              | `ycoding-core` reads the latest defining document; an absent or rejected value uses 7 days. Load the configuration from the global directory so project documents are not consulted. |
| `guardrails.shell_wait_seconds`                | positive integer              | Seconds a shell admitted at the running-shell cap waits, first come first served, for a released slot; the default is 60.                                                            |
| `guardrails.max_concurrent_subagents`          | positive integer              | Running-subagent cap per root Session family; the default is 8, and reaching the cap fails immediately.                                                                              |
| `efficiency.helper_models.prompt`              | `session` or a model selector | Selects the model for `/prompt` drafts. An explicit agent model takes precedence; a missing value or `session` retains agent-model, then owner-Session-model, precedence.            |
| `guardrails.max_concurrent_shells`             | positive integer              | Running-shell cap per root Session family; the default is 8.                                                                                                                         |
| `guardrails.max_pending_reviews`               | positive integer              | Pending-review cap per root Session family; the default is 16, and reaching the cap fails immediately.                                                                               |
| `efficiency.helper_models.title`               | `session` or a model selector | Selects the model for model-generated Session titles under the same precedence as `prompt`.                                                                                          |
| `efficiency.helper_models.goal`                | `session` or a model selector | Selects the model for model-based goal synthesis under the same precedence as `prompt`.                                                                                              |
| `efficiency.helper_models.decision`            | `session` or a model selector | Selects the model for decision-agent judgments under the same precedence as `prompt`.                                                                                                |
| `efficiency.helper_models.prediction`          | `session` or a model selector | Selects the model for next-message prediction under the same precedence as `prompt`.                                                                                                 |
| `efficiency.helper_models.compaction.main`     | `session` or a model selector | Selects the local compaction helper model for main chats; an explicit compaction selection takes precedence over an agent model.                                                     |
| `efficiency.helper_models.compaction.subagent` | `session` or a model selector | Selects the local compaction helper model for child Sessions under the same precedence as `compaction.main`.                                                                         |

Unknown configuration keys are removed individually by the Rust validator, invalid named entries are removed as units, malformed permissions append deny rules after valid rules, and malformed guardrails become `{ "enabled": true }`; these recoveries are reported as configuration diagnostics.

## Store maintenance

The beta's canonical database is redb; Session retention and projection cleanup use Store transactions, not SQLite vacuum or PRAGMA operations. The derived analytics engine owns usage/report tables and purge reconciliation. An unreadable or unsupported store fails startup without reset or replacement. Preserve a backup before an approved stored-data transition; stable import uses the [private-copy lifecycle](#global-directories).

## Runtime environment variables

Stable operator-facing variables:

| Variable                         | Effect                                                     |
| -------------------------------- | ---------------------------------------------------------- |
| `YCODING_CONFIG`                 | Explicit runtime config file.                              |
| `YCODING_CONFIG_CONTENT`         | Highest-priority inline runtime config.                    |
| `YCODING_CONFIG_DIR`             | Override global configuration directory.                   |
| `YCODING_CONFIG_PROJECT_DISABLE` | Disable project config discovery.                          |
| `YCODING_DISABLE_PROJECT_CONFIG` | Alias for disabling project config discovery.              |
| `YCODING_PASSWORD`               | Password for an explicitly connected or standalone server. |
| `YCODING_SERVER_PASSWORD`        | Server-password alias.                                     |
| `YCODING_MODELS_URL`             | Override model catalog URL.                                |
| `YCODING_MODELS_PATH`            | Read model catalog from a local file.                      |
| `YCODING_DISABLE_MODELS_FETCH`   | Disable model-catalog network refresh.                     |
| `YCODING_DISABLE_AUTOUPDATE`     | Disable update checks.                                     |
| `YCODING_LOG_LEVEL`              | Logging threshold.                                         |
| `YCODING_PRINT_LOGS`             | Print logs to the terminal.                                |
| `YCODING_CLIENT`                 | Client identity reported by the process.                   |
| `YCODING_SIMULATE`               | Enable simulation backend behavior.                        |
| `YCODING_GIT_BASH_PATH`          | Windows Git Bash path.                                     |
| `YCODING_FILEWATCHER_DISABLE`    | Disable filesystem watcher.                                |
| `YCODING_DISABLE_FILEWATCHER`    | Alternate filesystem-watcher disable switch.               |
| `YCODING_DISABLE_FFF`            | Disable the FFF filesystem backend.                        |
| `YCODING_WEBSEARCH_PROVIDER`     | Select web-search provider.                                |
| `YCODING_TERMINAL`               | Override terminal identity used by shell and PTY behavior. |
| `YCODING_REMOTE_URL`             | Relay origin used by the `ycoding remote` commands.        |

Build, packaging, test, and internal diagnostic variables are not stable end-user configuration. Examples include `YCODING_VERSION`, `YCODING_CHANNEL`, native-library paths, Drive simulation variables, and the internal managed-service startup-error file.

`YCODING_REMOTE_URL` is a relay origin: HTTPS only, except that plain HTTP is accepted for `localhost`, `127.0.0.1`, and `[::1]` development. It must not carry credentials, a query, a fragment, or a path. A `--relay` flag takes precedence over the environment, which takes precedence over the origin stored by `ycoding remote enroll`. Device credentials are bound to the enrolled origin, so an override that changes the origin is refused before any credential is sent.

## Reload behavior

YCoding watches runtime configuration directories and explicit files. Changes are debounced by 100 ms and publish `config.updated`.

Agent, command, and skill files inside watched `.ycoding` or global config directories reload even when the JSON document list itself is unchanged. Production atomically replaces the Location generation, its configured process extensions, and MCP tool catalog; held work retains its captured generation until release.

Ecosystem skill roots such as `~/.claude/skills` and `~/.agents/skills` are not watched. Skill files are re-read whenever skills are listed so edits and deletions are still reflected.

The TUI's **Refresh models and providers** command calls `provider.refresh` for the current Location. The backend rediscovers sources, publishes `config.updated`, and refreshes provider discovery, including configured `openai-models` catalogs. Environment values come from the backend process and do not change through a refresh.

CLI/TUI `cli.json` updates are serialized, written atomically through a temporary file, and preserve existing JSONC comments.

## Troubleshooting

- Inspect `config.diagnostics` or TUI Status for skipped documents, unsupported providers, recovered items, and fail-closed permission/guardrail recovery. Unsupported executable-plugin declarations reject the document; ordinary invalid entries do not discard unrelated valid settings.
- A missing `{file:...}` reference fails configuration loading for that Location and surfaces as a configuration error; it does not skip only that document.
- `instructions` is accepted but currently inactive; use `AGENTS.md` or skills.
- `tui.json`, `kv.json`, `config.json`, and project `.ycoding/tui.json` are not read.
- A managed-service port conflict is not fixed by deleting session data. Change the channel service config port or use `ycoding --standalone`.
- Run with `--log-level all` and `YCODING_PRINT_LOGS=1` when investigating configuration discovery.
- Each `location services booted` log line records the Location `directory`, total `durationMs`, and a `stages` map of per-service construction milliseconds; use it to identify a slow Location boot stage.
