---
name: computer-use
description: "Use when a task needs the interaction tool to operate a macOS application window in the background: reading or clicking its controls on the user's Mac. Do not use for web pages in Chrome, shell work, or coding tasks."
metadata:
  display-name: "Computer use"
  purpose: "Operate one macOS application window through the interaction tool."
  applicability: "Native macOS application windows; not for web pages in Chrome or shell work."
  triggers: "operate a Mac app, click a window control, read an application window"
  capabilities: "window observation, clicking, typing"
  prerequisites: "macOS with the computer-use helper, user approval for each action"
  related: "browser-use"
---
# Computer use

Operate a macOS application window through the single `interaction` tool. Every action needs the user's approval and targets one exact window.

## Start

1. Call `interaction` with `operation: "request"` and a `selection` for macOS naming the application window. Do not guess the window; ask the user which one if unclear.
2. Poll `operation: "status"` until the state is `active`. The user approves natively on the Mac; do not act before then. If the request is rejected or stopped, tell the user and stop.
3. Keep the `generation` from the active status. A new request or a stop invalidates it.

## Background only

Actions run in the background. YCoding never activates the app, raises the window, switches Spaces, or takes the keyboard or cursor from the user. If an action cannot complete without the foreground, it pauses on its first attempt with its reason and waits for the user's Resume or Stop; YCoding never retries it with focus emulation or any other focus workaround.

## Act

- Call `observe` with the active `generation`. Act only with element IDs and the `revision` from the latest observation.
- Call `perform` with `generation`, `revision`, and one `action`. Observe again after every action or any `stale` result; never reuse old IDs.
- Request exact confirmation (`operation: "confirm"` with the same action and revision) before anything irreversible: sending, purchasing, deleting, overwriting, or changing system or account settings. Perform only after the user approves.
- Touch only the granted window. Do not act on other windows or apps.

## Paused

Status or a result of `paused` carries a `reason`: `foreground_required`, `file_chooser`, `dialog`, `captcha`, `sensitive`, or `user_takeover`. The user must act on the Mac.

- Stop acting. Do not retry, observe in a loop, or work around the pause.
- Tell the user exactly what is needed, for example "Dismiss the open dialog in the app, then resume."
- Continue only after status returns to `active`; observe again before acting.

## Stop and safety

- Stop on password, one-time-code, payment, or other sensitive fields and on CAPTCHAs. Hand control to the user. Never ask the user to paste secrets into the chat.
- Stop on uncertain results. Observe, or ask the user, before repeating an action.
- The user can press Stop at any time. After a stop, the generation is dead: report what was done and do not request again unless asked.
- The tool returns element data, not pixels.
