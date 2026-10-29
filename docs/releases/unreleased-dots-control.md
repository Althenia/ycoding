# Dots device decisions

## Added

- Authenticated Dots device grants authorize selected task and typed decision operations across nonarchived device-owned Sessions. Decisions carry client provenance and require exact native candidates; grants end on revocation, unbinding, or OAuth expiry.
- MCP progress and blocker notifications are captured immediately, deduplicated, and reconciled. Web and TUI conversation views identify client-originated decisions.
- Native Dots clients can create a root Session in any existing local directory and rename, archive, unarchive, or delete eligible roots. Delete removes the whole root family only when no descendant is foreign-owned.
- The YCoding service keeps this computer's Dots executor online while Dots access is On. It reuses one stored device enrollment, reconnects after drops with backoff, runs Dots task commands and file operations under local permission checks, and stops when access turns Off.
- Each ChatGPT Dots task on this computer gets its own YCoding Session in the task's folder, which records the task's commands, file changes, and denials. Dots can list your YCoding projects and pick one as the task's folder.
- `ycoding dots attach` attaches this computer's Dots executor to your Dot, which ChatGPT's own settings cannot do for a computer other than the one ChatGPT runs on. It shows whether the computer is attached, warns that attaching detaches your other computers from the Dot, asks for confirmation unless `--yes` is given, and reports the state ChatGPT lists afterwards. Dots status now includes this attached state.

## Changed

- Pending permission, guardrail, Form, Question, deferred-review, recovery, and managed-child decisions on eligible roots reach the native client immediately, including roots it has not opened.
- Native `initialize` and CCA `environment/info` report `macos` and `windows` for the `darwin` and `win32` platforms.
- The service-hosted Dots executor reports exec-server version `0.165.0-alpha.1.2`, the release whose protocol it matches, instead of `0.0.0`; it still advertises no optional capabilities.
- The Dots executor behaves like a standalone ChatGPT exec-server and no longer reports thread readiness on the desktop app's behalf.
- The Dots executor keeps one registration and encryption key while it runs, so a Dots task can resume its executor session, including running commands, for 30 seconds after the connection drops.
- Decision settlement retains explicit denies, permission ceilings, ownership, binding, revocation, and at-most-once checks. Room and prompt text cannot authorize decisions.
- The Dots executor runs ChatGPT commands and file operations that request a sandbox instead of rejecting them. It applies the requested filesystem restrictions to its own file operations and to the command's working folder, under your home directory and the usual permission checks. A refusal is reported as a sandbox denial so ChatGPT can ask for approval and retry. Commands still run with your user account's access, because YCoding cannot confine a running program's file or network access.

## Fixed

- A short-lived command that loads global configuration and stored credentials exits once its work finishes, even when it finishes before the configuration watcher has started. Closing now waits for the watcher to start and then stops it instead of leaving it running.
