# YCoding Meet capture companion

Requires Chrome 116+ and a separately running local YCoding meeting bridge. This opt-in companion installs unpacked and does not change the existing browser-control extension or release archives.

## Install and capture

1. Run `bun extensions/meeting/companion/build.js` from the repository root. The dependency-free copy build writes `extensions/meeting/companion/.build`, canonical YCoding icons, and local Geist fonts plus their license.
2. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select that `.build` directory.
3. Arm a meeting in the TUI. Copy the local bridge address and one-use pairing code into the companion popup. Codes expire after 60 seconds and redeem once. The TUI shows the remaining time, replaces an expired code with an instruction to run `/meeting start` again, and hides the code after Chrome redeems it. A successful new pairing revokes the old capture bearer.
4. Select the Google Meet meeting tab, open the companion popup, check participant consent, and separately choose optional microphone capture. Use headphones; echo cancellation is enabled for microphone input. The toolbar popup cannot show Chrome's microphone prompt, so the first Start with microphone opens a YCoding tab that requests it; choose Allow while visiting the site, return to the Meet tab and press Start again. If the microphone is blocked, that tab offers Chrome's site settings for the extension.
5. Press **Start selected Meet tab**. The popup displays **Capturing** and the toolbar badge displays **REC**. Remote tab audio continues to play; microphone audio is never routed to playback.
6. Press **Stop capture**, use Ctrl+Shift+Y (Command+Shift+Y on Mac), or stop the meeting in the TUI. Configure a conflicting shortcut in `chrome://extensions/shortcuts`.

After rebuilding an installed unpacked companion, click **Reload** for **YCoding Meet capture** in `chrome://extensions`. Reopening the popup alone does not replace its running service worker. Browser-control pairing and meeting-capture pairing are separate; a connected YCoding Chrome bridge does not authorize audio capture. Use the address and fresh code from `/meeting start`, not an address from an expired test runtime.

The toolbar uses a branded microphone icon to distinguish Meeting capture from the browser-control Y icon; both popup headers retain the Y logo. The compact popup is 320 CSS pixels wide. Expand **Capture help** for headphones, echo cancellation, arming with `ycoding meeting` or `/meeting start`, keyboard shortcuts and call-closure limitations; consent, optional microphone choice and Stop remain outside help.

## Delivery and lifetime

Capture messages go only to the numeric loopback address using a capture-only bearer in `chrome.storage.session`. The extension cannot call the native-only `/control` endpoint. No audio or bearer is written to extension configuration, disk, logs, page content or a query string.

AudioWorklet emits source-local monotonic quarter-second mono Float32 packets. The sender keeps at most 32 packets, one audio request in flight, and retries the identical payload/sequence after unknown acknowledgements or HTTP 429. Each network attempt has a 3-second deadline, with at most four attempts and a 1-second retry delay. Heartbeats use a separate single-in-flight channel every five seconds; the bridge expires liveness after 20 seconds. The backend acknowledges bounded process-memory admission without waiting for speech or model inference; raw audio is not persisted. A runtime crash can lose admitted audio that has not yet been transcribed, while durable meeting history remains. Overflow or exhausted recovery stops locally with a visible error rather than silently dropping packets. `{stop:true}` from either channel stops and releases capture immediately.

Tracks, source nodes, worklet ports, audio contexts and the offscreen document are released on Stop, tab closure/document navigation, ended tracks, permission revocation, capture failure, or service-worker restart. Re-pairing, extension/browser reload and backend restart never resume recording automatically. Pending capture is not recovered from session storage; it is torn down.

The scoped call observer wraps the standard `RTCPeerConnection.close` method only during capture. Any closed connection stops recording conservatively, including an internal Meet reconnection. It reads no captions, transcript, participant data, button labels or invented Meet selectors. **A same-document Meet hangup that does not invoke this standard close method cannot be detected by the Chrome tab-capture API; use explicit Stop.** Actual Meet hangup coverage and Chrome capture/playback require a live joined-call check; boundary doubles do not prove them.

Errors expose categories and recovery actions, not callback exception text or credentials. When Stop cannot be acknowledged, the popup reports the uncertain backend outcome; check the TUI meeting state.

Audio processor failure stops capture visibly. A completed user or keyboard Stop returns to Ready without a failure alert. Reopening the popup reflects the active source choices; after capture ends, a new Start requires checking consent again. Late status reads cannot overwrite a pending action or change its microphone choice. Status reads are single-in-flight; an unavailable worker shows a reload instruction, while permission failures remain visible until another user action.

When the runtime reports `{stop:true,reason:"inference_failed"}`, the companion releases capture and explains that speech recognition failed on part of the audio, recording stopped, and the transcript so far is saved. Use **Retry failed audio** on the live page or `/meeting retry`, then press Start again with fresh consent. No retry or capture restart happens automatically. A backend stop without an allow-listed reason displays the ordinary backend-stopped message rather than raw exception text or `capture_cancelled`.

## Live-view backend

The native controller's `{action:"view"}` returns the local `/view#key=<viewKey>` address. The page UI is a separate surface; this companion does not render it. The fragment carries a separate random 32-byte view key, never the native control or capture credential. API calls send the view key in an Authorization bearer header, not a query string. Keys live for the bridge process and are never logged.

- `GET /view/state` returns the selected meeting, meeting list, transcript segments, findings, summary, health, audio, analysis, pairing address/code/expiry, configuration and `ask:{history,busy}`. It exposes no native control or capture credential.
- `POST /view/control` accepts exactly `{action:"pair"}`, `{action:"stop"}` or `{action:"retry"}`. Pair issues a fresh one-use code; Stop and Retry call the existing runtime controls. Configuration, knowledge approvals, model controls and meeting creation are not available through this capability.
- `POST /view/ask` accepts exactly `{question:string}` with a nonempty question of at most 2000 characters. Answers are advisory, derived from a bounded recent transcript including source-labelled finalized and temporary evidence; temporary text can change. One question may run per meeting at a time; another gets HTTP 409. Provider or context errors remain visible instead of fabricated answers. The meeting-intelligence Session has no tools.

View requests require the exact numeric loopback Host and an absent Origin or exactly the bridge origin. The view API has no CORS; bodies are capped at 16 KiB. The latest 50 question/answer entries per meeting are an in-process live-view index and are not written to meeting storage; they disappear when the runtime restarts. The analysis Sessions use normal durable YCoding Session history, so this memory-only index does not mean provider prompts/results are absent from Session storage. Transcript content can be sent to the configured analysis model; raw audio is not sent by Ask AI.

## Browser verification

Set `YCODING_TEST_ISOLATED_BROWSER_CHROME` to an installed Chrome for Testing executable supporting `Extensions.loadUnpacked` and `Extensions.triggerAction`, then run `bun run --cwd extensions/meeting test:integration:chrome`. The suite uses a disposable profile, opens the real native popup, checks its width and marks, and exercises pairing, consent, tab PCM delivery, popup closure/reopening and Stop cleanup through the real Chrome APIs and authenticated bridge. The audio page is a controlled fixture at a Meet-shaped URL, not Google's Meet application. No Chrome API doubles or production-profile credentials are used.

Setting `YCODING_MEETING_TEST_AUDIO` to a consented Thai WAV also runs the installed speech model, real SQLite persistence, and the existing signed-in YCoding provider for the final summary. Set `YCODING_MEETING_TEST_EXPECTED_TEXT` to a known phrase from its reference transcript to assert speech-content preservation. This opt-in check sends transcript text, not audio, to that provider. `YCODING_MEETING_SCREENSHOTS` optionally names a directory for unpaired light/dark popup screenshots. Microphone denial uses Chrome's permission setting with a fake input device; tab audio still comes from the fixture page through real tab capture. These checks do not establish acoustic playback quality, operating-system microphone consent, or every Google Meet hangup path.
