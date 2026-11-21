# Browser use

Drive the user's Chrome through the single `interaction` tool. Every action needs the user's approval and runs only inside the tabs YCoding controls.

## Start

1. Call `interaction` with `operation: "request"` and a `selection` for Chrome: `mode: "tab"` for the current authorized tab, `mode: "owned"` for a new YCoding tab (add `url`), or `mode: "isolated"` for a separate temporary browser.
2. Poll `operation: "status"` until the state is `active`. The user approves in the Chrome extension popup or mini panel; do not act before then. If the request is rejected or stopped, tell the user and stop.
3. Keep the `generation` from the active status. A new request or a stop invalidates it.

## Act

- Call `observe` with the active `generation`. Act only with element IDs and the `revision` from the latest observation.
- Call `perform` with `generation`, `revision`, and one `action`. Observe again after every action or any `stale` result; never reuse old IDs.
- Stay on the granted origin. Use `navigate` only within it.
- Request exact confirmation (`operation: "confirm"` with the same action and revision) before anything irreversible: purchases, submissions, deletions, sending messages, account or permission changes. Perform only after the user approves. Isolated Chrome supports no confirmation or irreversible actions.
- Never touch, list, or switch to tabs outside the YCoding control group.
- YCoding never focuses Chrome, but Chrome itself may raise its window when a page opens a new tab or window.

## Script and Code modes

`operation: "run"` with `generation`, the latest `revision`, and `script: { mode, source, timeoutMs? }` runs JavaScript in the granted Chrome tab. `timeoutMs` is 100–60000 (default 10000). macOS grants return `refused` with `unsupported`.

- `script`: `source` is an async function body run once in a fresh isolated world of the tab's top frame. `return` a JSON value. Nothing survives the run. Use it for one-off reads and bulk DOM work that would take many observe/perform steps: extracting a table, counting matches, reading computed state.
- `code`: `source` runs REPL-style in one isolated world kept for this grant, with top-level `await` and redeclaration; bindings persist between `code` runs. The last expression is the value. Navigation, Stop or the end of the grant discards the world. Use it when earlier results feed later steps.
- Prefer `perform` for single clicks and form fills the user should be able to follow. A run reaches only the granted tab with the page's own origin and site permissions: no other tabs, windows or popups, no cookies or browser storage, no navigation, and no focus or window changes.
- `window.open` returns `null` in a run, and runs and `perform` clicks carry no user activation, so pages cannot open file pickers or popups from them. Hand steps that need a real user click to the user.
- These throw `SecurityError` in a run: other-window access (`opener`, cross-window `postMessage`), workers and `BroadcastChannel`, storage, cookies, caches and locks, `URL.createObjectURL`, inserting scripts, frames, objects or other active elements, `on*` attributes, `javascript:` URLs, HTML-string parsing (`innerHTML`, `document.write`, `DOMParser` and similar), and clicks or form submits that would leave the tab. Read and edit the DOM with element and text APIs instead.
- A tab that another tab opened, or that opened another tab, refuses runs with `refused` reason `policy`; use `perform` there, or ask the user to open the page in a fresh tab.
- Hidden data: password, one-time-code, payment and autocomplete-sensitive input values read as empty. Never work around this or ask the user for those values; hand sensitive steps to the user.
- A JavaScript dialog or file chooser the page opens during a run returns `paused` with reason `dialog` or `file_chooser`; handle it as described under Paused.
- A run is an action: it needs the current `revision`, consumes it, and is never replayed. Observe again before the next `perform` or `run`. Each run asks for `browser_script` permission.
- The result is `{ type: "script", result }`. `completed` carries `value` (or `valueTruncated: true` above 64 KiB); `error` carries `{ name, message, stack? }`; `timeout` and `stopped` carry no value. These four include `logs`: console output and exceptions from the script's own world only, at most 200 entries, then `logsTruncated: true`. Values, logs and errors are redacted. `refused` and `paused` carry a `reason`.
- `stopped` means the user pressed Stop or control was revoked; the generation is dead and a further run is refused `stale`. `timeout` means the script was terminated; shorten it or split the work. If the page left the approved URL during a run, control is revoked but the result still returns. A tool failure saying the outcome is uncertain means control was revoked; do not repeat the run.

## Paused

Status or a result of `paused` carries a `reason`: `foreground_required`, `file_chooser`, `dialog`, `captcha`, `sensitive`, or `user_takeover`. The user must act in the browser.

- An action that needs focus pauses on its first attempt and waits for the user's Resume or Stop. YCoding never retries it with focus emulation or any other focus workaround.
- Stop acting. Do not retry, observe in a loop, or work around the pause.
- Tell the user exactly what is needed, for example "Choose the file in the open dialog, then press Resume in the mini panel."
- Continue only after status returns to `active`; observe again before acting.

## Stop and safety

- Stop on password, one-time-code, payment, or other sensitive fields and on CAPTCHAs. Hand the page to the user. Never ask the user to paste secrets into the chat.
- Stop on uncertain results. Observe, or ask the user, before repeating an action.
- The user can press Capture in the mini panel to send a redacted screenshot into this Session as a steer message. Suggest it when you need to see what the user sees. Treat it as the user's input for that moment, not a standing view.
- The user can press Stop at any time. After a stop, the generation is dead: report what was done and do not request again unless asked.
- The tool returns element data, not pixels.
