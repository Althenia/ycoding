# Native computer use

YCoding exposes one platform-neutral `computer` tool. Core owns capability reporting, Session ownership, revision fencing, cancellation, permissions, and guardrails. The provider is an isolated native macOS helper; Windows and Linux report `unsupported`.

## Supported capabilities

| Platform | Application | Read operation                                                                                     | Mutation                                                                                                          |
| -------- | ----------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| macOS    | iTerm       | Inspect one explicit window, tab, and session identity                                             | Send text, optionally followed by a newline, to that exact session                                                |
| macOS    | Finder      | Inspect one canonical file path                                                                    | Move that file to one canonical destination directory                                                             |
| macOS    | Desktop     | Inspect one running app window's bounded Accessibility tree; capture that window as a bounded JPEG | Press an AX control, set a text field or text area value, move an AX scrollbar one step, or confirm an AX control |

`status` reports the current platform and its filtered capability list. Unsupported platforms report `unsupported` with no capabilities and reject an application operation before invoking a native helper.

Desktop targeting requires the running application's exact bundle ID, process ID, and Core Graphics window ID. The native helper verifies the window owner and matches exactly one Accessibility window whose window ID equals the requested ID; missing or ambiguous matches fail closed. The target window does not need to be frontmost, focused, or on the current Space, and YCoding never activates it. Because macOS omits windows on other Spaces from an application's Accessibility window list, the helper resolves a window that Core Graphics reports as off-screen by probing that application's Accessibility element identifiers through private macOS Accessibility interfaces, bounded to 2,000 identifiers and one second. A window beyond that bound fails closed as unavailable. Inspect returns at most 64 AX elements, each with a child-index path, role, and bounded label; the revision includes their current values without exposing those values. Child paths are limited to five levels and 16 children per level. Capture uses ScreenCaptureKit for that same window, returns a JPEG image to the model, and limits encoded data to 40 KB. It requires macOS 14 or later and granted Accessibility and Screen Recording access to the helper app.

Desktop mutations require an exact inspected revision for that Session and window. `desktop.click` performs an advertised AX Press action; `desktop.type` sets the value of a settable AX text field or text area (up to 4096 UTF-8 bytes); `desktop.scroll` moves a settable AX scrollbar by 0.1 of its normalized range; `desktop.key` performs an advertised AX Confirm action for Enter only. These do not synthesize global keyboard/pointer events, activate applications, or use the clipboard. YCoding does not target the frontmost application, launch target apps, capture another app/window, perform arbitrary Apple Events, open Finder items, or read unrelated iTerm sessions. Desktop operations request Accessibility access, capture also requests Screen Recording access, and iTerm and Finder operations request Automation access to that application. While access is missing, macOS adds **YCoding Computer Use** to that Privacy & Security list and may show its allow prompt; the operation fails closed until the user allows the app and retries. An Automation request waits for the user's answer, and an answer later than the 30-second helper response limit fails the call.

## Ownership and mutation safety

An inspect operation claims the exact target for the observing Session and returns a revision. A mutation must come from the same Session and include that exact revision. Another Session, a stale revision, a released Session, or an uncertain prior result requires a fresh inspect.

iTerm text uses the normal `computer` permission boundary and the shell guardrail before native execution. Finder paths are canonicalized through the Location mutation boundary; external paths require external-directory permission, and a move uses the file-mutation guardrail. Cancellation targets an active call owned by the same Session.

Every desktop operation (including inspect and capture) requires the `computer` permission before native dispatch. The standard guardrail profile has no desktop review; custom guardrail rules for the `computer` action still apply. The target resource includes its bundle ID, process ID, and window ID.

If a mutating helper process settles ambiguously, YCoding reports an unknown outcome and invalidates the claim. It does not replay the mutation automatically.

Cancellation and Session release invalidate the claim immediately, but retain the active target lock until the native invocation settles. A late successful response cannot restore a cancelled claim or report that cancelled call as successful; another call must wait for settlement and inspect again.

## Helper discovery

Packaged macOS TUI and Node executables resolve `YCoding Computer Use.app` only as a sibling of the running executable. macOS release archives after v0.7.1 contain the executable, that ad-hoc signed app bundle (whose executable is `Contents/MacOS/ycoding-computer-use`), and the `ycoding-chrome-extension` folder. Releases v0.2.0 through v0.7.1 also contain a separate `ycoding-computer-helper` executable, and v0.7.1 contains the `ycoding-computer-helper.app` bundle with identifier `app.ycoding.computer-helper`. Installing a later release removes a sibling `ycoding-computer-helper` and `ycoding-computer-helper.app` and restores them if the installation fails. The curl installer verifies the checksum and exact archive entry set for each supported version before installation.

The app bundle displays as **YCoding Computer Use** with the YCoding icon in macOS privacy settings, which list an app bundle by its filename. Its installed filename and bundle identifier are `YCoding Computer Use.app` and `app.ycoding.computer-use`; the separate bare helper can appear under its executable name.

Source development is explicit and does not write beside the user's Bun executable or compile native code during runtime startup:

```sh
bun run build:computer-use
bun dev
```

On macOS, the first command compiles and ad-hoc signs the current source into the repository-ignored `packages/core/.cache/computer-use/YCoding Computer Use.app` bundle, replacing any previous build there. A source process running under Bun resolves that fixed development path. If it has not been built, computer operations fail as helper unavailable; YCoding does not compile it automatically. The build requires the macOS command-line developer tools and supports host `arm64` or `x64`.

Every computer operation uses an app-context invocation: Core writes a request file in a private temporary directory, launches the sibling `YCoding Computer Use.app` with LaunchServices, waits for its response file, and removes the directory. The app executable accepts request and response absolute file paths as arguments. Missing, invalid, cancelled, or timed-out response after a mutation has an uncertain outcome and requires reinspection. Release builds are ad-hoc signed, so macOS ties privacy grants to each release; after installing or updating, remove the existing **YCoding Computer Use** entries and allow the new ones. An archive downloaded with a web browser carries the `com.apple.quarantine` attribute; after extracting it, run `xattr -dr com.apple.quarantine <extracted-folder>` before starting `ycoding`. The curl installer and `ycoding update` download without that attribute. A source build is also ad-hoc signed unless `YCODING_MACOS_SIGNING_IDENTITY` names a code-signing identity in the build user's keychain; macOS ties an ad-hoc app's grants to that exact build. After an ad-hoc rebuild, turning the existing **YCoding Computer Use** entry off and on does not grant the new app; remove the entry with **−**, and the next operation adds it again for the user to allow.

## Packaging and installation

The ordinary Bun and Node CLI builds emit only complete artifacts. A macOS host can build their supported macOS architectures and matching signed app bundles. A non-macOS host explicitly reports that it is skipping macOS targets rather than creating Darwin artifacts without the required helper; an explicit unavailable Node target fails instead of succeeding without output. Release CI builds each Darwin target on a matching macOS runner and stages the main executable and app bundle.

For macOS releases from v0.7.1, the curl installer and `ycoding update` prepare the executable, the app bundle, and any version-specific `ycoding-computer-helper` in the install directory, preserve installed components, and restore them when a replacement fails. This is rollback-based recovery across renames, not a crash-atomic swap. If a restore rename also fails, the updater retains the only old backup, reports its exact path and destination, and exits unsuccessfully. Published macOS releases from v0.2.0 through v0.7.0 contain the executable and `ycoding-computer-helper`; explicit self-update rollback to a published pre-v0.2.0 release accepts its historical single-file archive and leaves any sibling helper unchanged. Linux archives through v0.7.1 contain only the main executable; later Linux archives add the `ycoding-chrome-extension` folder.
