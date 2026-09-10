# Native computer use

Status: **implemented on macOS for iTerm and Finder; unsupported on other platforms**

YCoding exposes one platform-neutral `computer` tool. Core owns capability reporting, Session ownership, revision fencing, cancellation, permissions, and guardrails. The first provider is an isolated native macOS helper; no Windows or Linux provider is implemented.

## Supported capabilities

| Platform | Application | Read operation                                         | Mutation                                                           |
| -------- | ----------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| macOS    | iTerm       | Inspect one explicit window, tab, and session identity | Send text, optionally followed by a newline, to that exact session |
| macOS    | Finder      | Inspect one canonical file path                        | Move that file to one canonical destination directory              |

`status` reports the current platform and its filtered capability list. Unsupported platforms report `unsupported` with no capabilities and reject an application operation before invoking a native helper.

YCoding does not use frontmost-application targeting, global keyboard or pointer input, the clipboard, screen capture, arbitrary Apple Events, app launch, Finder reveal/open, or unrelated iTerm sessions. The helper checks existing app identity and macOS Automation authorization without showing a permission prompt. Unavailable authorization fails closed.

## Ownership and mutation safety

An inspect operation claims the exact target for the observing Session and returns a revision. A mutation must come from the same Session and include that exact revision. Another Session, a stale revision, a released Session, or an uncertain prior result requires a fresh inspect.

iTerm text uses the normal `computer` permission boundary and the shell guardrail before native execution. Finder paths are canonicalized through the Location mutation boundary; external paths require external-directory permission, and a move uses the file-mutation guardrail. Cancellation targets an active call owned by the same Session.

If a mutating helper process settles ambiguously, YCoding reports an unknown outcome and invalidates the claim. It does not replay the mutation automatically.

Cancellation and Session release invalidate the claim immediately, but retain the active target lock until the native invocation settles. A late successful response cannot restore a cancelled claim or report that cancelled call as successful; another call must wait for settlement and inspect again.

## Helper discovery

Packaged macOS TUI and Node executables resolve `ycoding-computer-helper` only as a sibling of the running executable. Release archives contain both direct executable entries, and the curl installer verifies the checksum and exact archive entry set before installation.

Source development is explicit and does not write beside the user's Bun executable or compile native code during runtime startup:

```sh
bun run build:computer-helper
bun dev
```

On macOS, the first command compiles and ad-hoc signs the current source into the repository-ignored `packages/core/.cache/computer-helper/ycoding-computer-helper`. A source process running under Bun resolves that fixed development path. If it has not been built, computer operations fail as helper unavailable; YCoding does not compile it automatically. The build requires the macOS command-line developer tools and supports host `arm64` or `x64`.

## Packaging and installation

The ordinary Bun and Node CLI builds emit only complete artifacts. A macOS host can build their supported macOS architectures and matching helpers. A non-macOS host explicitly reports that it is skipping macOS targets rather than creating Darwin artifacts without the required helper; an explicit unavailable Node target fails instead of succeeding without output. Release CI builds each Darwin target on a matching macOS runner, stages only the main executable and helper, and archives both.

For macOS upgrades, the curl installer and `ycoding update` prepare both files in the install directory, preserve any installed pair, and restore that prior pair when either final replacement fails. This is rollback-based recovery across two renames, not a crash-atomic pair swap. If a restore rename also fails, the updater retains the only old backup, reports its exact path and destination, and exits unsuccessfully. Explicit self-update rollback to a published pre-0.2.0 macOS release accepts its historical single-file archive and leaves any sibling helper unchanged. Linux archives and installs remain main-executable only.

## Validation boundary

Automated coverage verifies capability filtering, ownership and revision fencing, cancellation, helper resolution, helper protocol decoding, build planning, signed arm64 and x64 helper construction, sibling packaging, exact installer archive entries, and installer rollback under an injected final-replacement failure.

Live iTerm text submission is intentionally excluded from routine tests because it would mutate a user's terminal session. Release workflow execution and macOS Automation authorization remain environment-specific release/operator checks.
