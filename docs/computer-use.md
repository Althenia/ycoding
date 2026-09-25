# Native computer use

YCoding exposes one platform-neutral `computer` tool. Core owns capability reporting, Session ownership, revision fencing, cancellation, permissions, and guardrails. The provider is an isolated native macOS helper; Windows and Linux report `unsupported`.

## Supported capabilities

| Platform | Application | Read operation                                                                                     | Mutation                                                                                                          |
| -------- | ----------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| macOS    | iTerm       | Inspect one explicit window, tab, and session identity                                             | Send text, optionally followed by a newline, to that exact session                                                |
| macOS    | Finder      | Inspect one canonical file path                                                                    | Move that file to one canonical destination directory                                                             |
| macOS    | Desktop     | Inspect one running app window's bounded Accessibility tree; capture that window as a bounded JPEG | Press an AX control, set a text field or text area value, move an AX scrollbar one step, or confirm an AX control |

`status` reports the current platform and its filtered capability list. Unsupported platforms report `unsupported` with no capabilities and reject an application operation before invoking a native helper.

Desktop targeting requires the running application's exact bundle ID, process ID, and Core Graphics window ID. The native helper verifies the window owner and matches one Accessibility window by bounds; missing or ambiguous matches fail closed. Inspect returns at most 64 AX elements, each with a child-index path, role, and bounded label; the revision includes their current values without exposing those values. Child paths are limited to five levels and 16 children per level. Capture uses ScreenCaptureKit for that same window, returns a JPEG image to the model, and limits encoded data to 40 KB. It requires macOS 14 or later and granted Accessibility and Screen Recording access to the helper app.

Desktop mutations require an exact inspected revision for that Session and window. `desktop.click` performs an advertised AX Press action; `desktop.type` sets the value of a settable AX text field or text area (up to 4096 UTF-8 bytes); `desktop.scroll` moves a settable AX scrollbar by 0.1 of its normalized range; `desktop.key` performs an advertised AX Confirm action for Enter only. These do not synthesize global keyboard/pointer events, activate applications, or use the clipboard. YCoding does not target the frontmost application, launch target apps, capture another app/window, perform arbitrary Apple Events, open Finder items, or read unrelated iTerm sessions. The helper checks existing app identity and authorization without showing a permission prompt; unavailable authorization fails closed.

## Ownership and mutation safety

An inspect operation claims the exact target for the observing Session and returns a revision. A mutation must come from the same Session and include that exact revision. Another Session, a stale revision, a released Session, or an uncertain prior result requires a fresh inspect.

iTerm text uses the normal `computer` permission boundary and the shell guardrail before native execution. Finder paths are canonicalized through the Location mutation boundary; external paths require external-directory permission, and a move uses the file-mutation guardrail. Cancellation targets an active call owned by the same Session.

Every desktop operation (including inspect and capture) requires the `computer` permission and a Session hard guardrail review before native dispatch. A human must reply `once` or `reject`; YOLO, goal automation, Always reuse, and ordinary custom allow rules cannot bypass that review. The target resource includes its bundle ID, process ID, and window ID.

If a mutating helper process settles ambiguously, YCoding reports an unknown outcome and invalidates the claim. It does not replay the mutation automatically.

Cancellation and Session release invalidate the claim immediately, but retain the active target lock until the native invocation settles. A late successful response cannot restore a cancelled claim or report that cancelled call as successful; another call must wait for settlement and inspect again.

## Helper discovery

Packaged macOS TUI and Node executables resolve `ycoding-computer-helper` and `ycoding-computer-helper.app` only as siblings of the running executable. macOS release archives from v0.7.1 contain the executable, bare helper, and signed app bundle. The curl installer verifies the checksum and exact archive entry set for each supported version before installation.

The app bundle displays as **YCoding Computer Use** with the YCoding icon in macOS privacy settings. Its installed filename and bundle identifier are `ycoding-computer-helper.app` and `app.ycoding.computer-helper`; the separate bare helper can appear under its executable name.

Source development is explicit and does not write beside the user's Bun executable or compile native code during runtime startup:

```sh
bun run build:computer-helper
bun dev
```

On macOS, the first command compiles and ad-hoc signs the current source into the repository-ignored `packages/core/.cache/computer-helper/ycoding-computer-helper` and its sibling `.app` bundle. A source process running under Bun resolves that fixed development path. If it has not been built, computer operations fail as helper unavailable; YCoding does not compile it automatically. The build requires the macOS command-line developer tools and supports host `arm64` or `x64`.

Desktop operations use a separate app-context invocation: Core writes a request file in a private temporary directory, launches the sibling `ycoding-computer-helper.app` with LaunchServices, waits for its response file, and removes the directory. The native helper accepts request and response absolute file paths as arguments. Missing, invalid, cancelled, or timed-out response after a desktop mutation has an uncertain outcome and requires reinspection. The bare helper executable's stdin path remains for iTerm and Finder; it cannot supply the desktop app's Accessibility or Screen Recording grant. An ad-hoc signature does not guarantee permissions persist across rebuilds or upgrades; the user may need to grant the installed app again.

## Packaging and installation

The ordinary Bun and Node CLI builds emit only complete artifacts. A macOS host can build their supported macOS architectures, matching bare helpers, and signed app bundles. A non-macOS host explicitly reports that it is skipping macOS targets rather than creating Darwin artifacts without the required helper; an explicit unavailable Node target fails instead of succeeding without output. Release CI builds each Darwin target on a matching macOS runner and stages the main executable, bare helper, and app bundle.

For macOS releases from v0.7.1, the curl installer and `ycoding update` prepare the executable, bare helper, and app bundle in the install directory, preserve installed components, and restore them when a replacement fails. This is rollback-based recovery across renames, not a crash-atomic swap. If a restore rename also fails, the updater retains the only old backup, reports its exact path and destination, and exits unsuccessfully. Published macOS releases from v0.2.0 through v0.7.0 contain the executable and bare helper; explicit self-update rollback to a published pre-v0.2.0 release accepts its historical single-file archive and leaves any sibling helper unchanged. Linux archives and installs remain main-executable only.
