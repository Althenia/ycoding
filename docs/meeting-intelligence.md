# Meeting intelligence

The opt-in Meeting extension captures consented Google Meet tab audio, transcribes locally, and uses YCoding's existing Session generation and MCP registry for evidence-backed analysis. Its interface is a native TUI plugin. See [configuration](./configuration.md), [runtime](./runtime.md), and [repository resources](./repository-resources.md).

## Installation and startup

Use this checkout's runtime; its plugin API includes the required Location-scoped MCP domain. The existing browser-control companion and release archive layout are unchanged.

```sh
bun install
bun run --cwd extensions/meeting model doctor
bun run --cwd extensions/meeting model list
bun run --cwd extensions/meeting build
```

The Python executable must have `torch`, `transformers`, `numpy`, and `huggingface_hub`. Doctor reports installed versions and hardware availability. Prepare a dedicated Python environment explicitly; package installation downloads the speech runtime, separately from model weights:

```sh
python3 -m venv extensions/meeting/.venv
extensions/meeting/.venv/bin/python -m pip install torch transformers numpy huggingface_hub
export YCODING_MEETING_PYTHON="$PWD/extensions/meeting/.venv/bin/python"
bun run --cwd extensions/meeting model doctor
```

Select that same absolute executable through `transcription.pythonExecutable` in the runtime plugin options; the model CLI environment variable does not configure the plugin. On Windows use `extensions/meeting/.venv/Scripts/python.exe`. Audio-file testing requires `ffmpeg`. Plugin loading installs nothing and downloads no models.

The default is `biodatlab/whisper-th-large-v3-combined`, approximately 3.22 GB of weights. Review size and license before authorizing its download:

```sh
bun run --cwd extensions/meeting model install biodatlab/whisper-th-large-v3-combined --authorize-download
bun run --cwd extensions/meeting model test /path/to/consented-audio.wav --reference=/path/to/reference.txt
bun run extensions/meeting/script/dev.ts /path/to/project
```

Development startup launches the source TUI with a private server and temporary plugin configuration, without overwriting global configuration. Run it from any directory and pass the project path; it supplies the Solid JSX preload to both the TUI and its private server. `TMPDIR` must not contain whitespace. YCoding still owns stored provider profiles. Custom global provider settings may need a normal installation rather than this isolated configuration. Quit the TUI normally to stop its private server and remove the temporary configuration.

### `ycoding meeting`

`ycoding meeting [directory]` runs Meeting from the native Bun-built `ycoding` executable without the TUI. Meeting is native-only: the Node CLI excludes the Meeting runtime, and `meeting` and `serve --meeting` exit nonzero with `Meeting requires the native ycoding executable; it is not supported by the Node CLI.` before starting a meeting server or arming capture.

The native command bundles the meeting runtime, starts a private server that loads it for the project directory (default: the current directory), arms a meeting unless one is already ready, recording or stopping, and opens the live page; `--no-open` prints the page address without opening a browser. When a meeting runtime already serves that directory, the command reuses it and exits after printing the page. Otherwise it keeps running: **Ctrl+C** stops and finalizes an active recording, then shuts the private server down. The speech prerequisites above still apply; the command installs no Python packages or model weights. The executable embeds the Python worker source and launches the configured Python interpreter with `-c`, so no separate worker script file is required.

The live page is served only on the loopback address and authenticated by the one-time key in its URL fragment. It shows an operations rail (runtime health and sources, always-visible processing metrics — buffered seconds, backlog and processed seconds — model details, Chrome guidance, pairing and recovery actions), the transcript in the central column, and an insights column with the summary, findings and Ask AI. On narrow screens operations come first, then the transcript, then insights and Ask AI. Its controls issue a new pairing code, stop and finalize after confirmation, and retry failed audio; values the runtime does not report display as unreported.

The installed executable cannot load Meeting's Solid TUI plugin, so the `/meeting` TUI commands require the source launcher. A source-run TUI with the Solid preload can instead use persistent configuration: preserve existing configuration entries and add the absolute `extensions/meeting/src/plugin.ts` path to the project's runtime `plugins` array, and the absolute `extensions/meeting/src/tui.tsx` path to global `cli.json` `plugins`. Restart that source runtime. The runtime plugin's `options` hold the configuration below; there is no top-level `meeting` key.

The alternative multilingual model is `openai/whisper-large-v3`, under the **same Hugging Face backend**, not an OpenAI API. Its default safetensors weights are approximately 3.09 GB and require separate authorization. Models stay outside Git in a configurable cache. Inference uses local files, safetensors, and no model-supplied Python code. Neither default speech model requires a paid API key.

### Chrome

Build with `bun extensions/meeting/companion/build.js`. In `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `extensions/meeting/companion/.build`. Chrome 116+ is required. See the [companion guide](../extensions/meeting/companion/README.md).

Reload **YCoding Meet capture** in `chrome://extensions` after rebuilding it. Its pairing is separate from the browser-control extension; a connected browser-control bridge does not authorize recording. Use a running meeting runtime and a fresh pairing code rather than an expired test endpoint.

Run `ycoding meeting` (or `/meeting start` in the source TUI), enter the displayed loopback address and one-use pairing code in the popup within its displayed 60-second window (an expired code is replaced by an instruction to run `/meeting start` again), select the Google Meet tab, acknowledge participant consent and organizational policy, optionally enable the separate microphone, and press **Start selected Meet tab**. Chrome cannot show its microphone prompt in the toolbar popup, so the first microphone Start opens a YCoding tab that requests access instead of recording; choose **Allow while visiting the site**, return to the Meet tab, and press Start again. If the microphone is blocked, that tab offers Chrome's site settings for the extension. Tab playback is preserved; microphone audio is never routed to the speakers. Use headphones to limit acoustic echo. The popup's **Capture help** holds the headphone, echo-cancellation and arming guidance; consent and the optional microphone remain visible controls.

If speech recognition fails, recording stops and the transcript so far remains saved. Use **Retry failed audio**, or `/meeting retry`, then press Start again with fresh consent.

Ask AI answers questions from bounded transcript evidence through a tool-free meeting-intelligence Session; answers are advisory. One question per meeting runs at a time. The live page's question-and-answer list keeps the latest 50 entries per meeting in process memory and is cleared on restart; the analysis Session's prompts and results remain durable.

Closing the TUI page or the live page does not stop recording. Stop in the popup, with its keyboard shortcut, with Ctrl+C in `ycoding meeting`, or with `/meeting stop`. The toolbar badge and popup expose visible recording state and Stop.

## Configuration

Plugin options use camelCase JSON/JSONC:

```json
{
  "transcription": {
    "provider": "huggingface",
    "model": "biodatlab/whisper-th-large-v3-combined",
    "language": "th",
    "task": "transcribe",
    "device": "auto",
    "chunkSeconds": 15,
    "overlapSeconds": 2
  },
  "streaming": { "enabled": true, "vad": true, "sampleRate": 16000, "maxBufferedSeconds": 60 },
  "vocabulary": { "preserveTechnicalTerms": true, "hints": ["Redis", "PostgreSQL"] },
  "fallback": { "enabled": true, "provider": null, "model": null },
  "analysis": { "model": "inherit", "incremental": true, "maxCharacters": 32000 },
  "knowledge": { "mcpEnabled": true, "autoApply": false, "requireApproval": true, "bindings": [] },
  "storage": { "provider": "sqlite", "retainAudio": false, "retentionDays": null }
}
```

`device` accepts `auto`, `cuda`, `mps`, or `cpu`; explicit unavailable devices fail. CPU selection reports a performance warning. This is **windowed chunk inference**, not token-level speech streaming. Disabling `streaming.enabled` prevents live capture. VAD is an energy threshold, not a neural speech detector or diarization system.

`cacheDir`, `pythonExecutable`, and `requestTimeoutMs` belong to `transcription`. Model-management commands accept `YCODING_MEETING_CACHE`, `YCODING_MEETING_PYTHON`, `YCODING_MEETING_MODEL`, and `YCODING_MEETING_DEVICE`. Validated runtime changes are saved in the meeting data directory's `settings.json`; saved settings override initial plugin options. Put no credentials in these options.

Model switches drain and finalize healthy old-model audio before unloading. When inference has failed, an explicitly selected replacement processes the retained window without discarding it. Explicit retry replaces an unhealthy worker before processing retained audio. Streaming geometry changes require stopped capture. A null fallback target selects no fallback; an explicitly configured fallback appears in health and transcript model attribution. No smaller checkpoint is selected silently.

The transcription module exports `registerModel`, `registerProvider`, `createProvider`, `listModels`, `getModelCompatibility`, and `installModel`. A plugin composition can register another backend without changing analysis. Hugging Face model registration declares a Whisper architecture; the worker verifies actual cached metadata before loading. Other registered providers own their model identifiers and compatibility. No whisper.cpp conversion or API speech backend is advertised.

`analysis.model: "inherit"` inherits the source Session's model and profile binding through runtime Session creation, or uses normal YCoding resolution when none is supplied. Starting from a Session uses that Session unless the command explicitly names another one. The source Session must belong to the current Location. Overrides use `{providerID, id, variant?, profile?}`. Existing Claude Code and ChatGPT sign-in flows own authentication; no credentials are scraped and no second provider client is added.

## Commands and review

| Command                                                                               | Behavior                                                                                                                               |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/meeting start [sessionID] [title]`                                                  | Initialize speech, arm a meeting and show pairing; Chrome activation/consent remains required.                                         |
| `/meeting stop`                                                                       | Stop admission, flush and finalize audio, and request final analysis.                                                                  |
| `/meeting status`, `/meeting transcript`                                              | Show lifecycle, source, health, backlog and original/corrected transcript.                                                             |
| `/meeting summary`                                                                    | Analyze finalized evidence beyond the stable checkpoint.                                                                               |
| `/meeting plan`                                                                       | Propose a test-first plan from human-confirmed decisions/requirements.                                                                 |
| `/meeting knowledge-review`                                                           | Show target, old/new content, evidence, expected revision and review state.                                                            |
| `/meeting models`, `/meeting config`                                                  | Inspect actual model inventory and current settings.                                                                                   |
| `/meeting model-select <model>`                                                       | Drain and switch an installed model.                                                                                                   |
| `/meeting model-install <model> confirm-download`                                     | Explicitly authorize that model download after reviewing inventory.                                                                    |
| `/meeting configure <JSON>`                                                           | Validate and save a complete configuration object.                                                                                     |
| `/meeting confirm <findingID> confirm`, `/meeting reject-finding <findingID> confirm` | Record a separate human finding decision.                                                                                              |
| `/meeting approve <proposalID> confirm`, `/meeting reject <proposalID> confirm`       | Record a separate knowledge decision after review.                                                                                     |
| `/meeting correct <segmentID> <text>`                                                 | Preserve raw evidence, audit a correction, invalidate dependent confirmations/proposals, and learn bounded technical vocabulary hints. |
| `/meeting retry`                                                                      | Retry failed inference while this process still holds its audio window.                                                                |
| `/meeting reconcile`                                                                  | Revisit a stopped meeting in bounded batches with fresh knowledge retrieval.                                                           |
| `/meeting delete <meetingID> DELETE`                                                  | Delete an idle meeting and its dependent local records.                                                                                |

All findings begin unconfirmed, including possible decisions. Each finding/proposal must cite finalized segment IDs from the supplied evidence. Owners/deadlines are optional and must occur in supporting evidence; changed assignments require fresh human confirmation. Plans whose supporting evidence changes are marked invalidated and require reconfirmation and explicit regeneration. Model confidence is not a calibrated probability. Remote audio is a mixed stream with unknown speaker identity; microphone audio identifies a source, not a person's name. Diarization is not included.

Analysis uses one dedicated Session through tool-free generation. Its model input contains a bounded evidence batch and rolling summary, not full accumulated transcript history. Transcript and MCP content are untrusted data. Model output cannot confirm findings or authorize writes. Plans label repository components uninspected unless supported by canonical evidence; implementing a plan requires a separate normal coding instruction and permission path. This generation API does not expose token usage; the extension records measured latency rather than fabricated usage.

## MCP knowledge contract

Configure a server through normal `mcp.servers`, then explicitly bind operations in `knowledge.bindings`: `{server, search, read, write?}`. Names are checked against the live Location registry; tool descriptions/annotations never grant authority.

| Operation | Arguments                         | Structured response (or JSON text response)        |
| --------- | --------------------------------- | -------------------------------------------------- |
| Search    | `{query, limit: 3}`               | `{documents: [{id}]}`                              |
| Read      | `{id}`                            | `{id, revision, content}`                          |
| Replace   | `{id, content, expectedRevision}` | Acknowledgement, followed by a required read-back. |

The writer must advertise required `id`, `content`, and `expectedRevision` fields and enforce atomic optimistic concurrency. Merely accepting an extra argument is not a revision guarantee. Use a server's supported adapter when native document shapes differ; arbitrary write signatures are not guessed.

Bounded retrieval is cached by server/capability/query; references persist independently from proposals. Every proposal retains complete old/new content, explanation, evidence, confidence, revision and approval history. Approval re-reads both content and revision; a stale source blocks writing. Read-back requires the proposed content and a changed revision. Read-only/non-revision-aware writers leave manual proposals. A failed write or read-back is **uncertain** and never automatically replayed.

## Persistence, privacy and recovery

Each canonical Location has an owner-only directory under `$XDG_DATA_HOME/ycoding/meeting`, defaulting to `~/.local/share/ycoding/meeting`. A separate SQLite database owns meeting metadata, transcripts, findings, summaries, plans, references, proposals, approvals and processing jobs. Schema initialization is transactional; future/unrelated schemas are rejected. The YCoding Session database is not migrated.

Raw audio is not stored. A packet acknowledgement means bounded **volatile admission**, not durable audio recovery. A crash can lose untranscribed audio while preserving completed transcripts and partial analysis. Recovery marks formerly recording meetings interrupted; re-arming and a fresh Chrome activation are required. A failed window can be retried only while retained in the process.

The bridge binds numeric loopback, checks Host/exact paired Origin, bounds payloads and separates native control from capture authority. Pairing yields a capture-only bearer in Chrome session storage; the native descriptor has owner-only permissions. Credentials are absent from configuration, URLs and logs. No audio is sent to an external speech service. Transcript-derived analysis text goes to the selected existing AI provider under its privacy terms.

`retentionDays` removes expired inactive meetings; null retains history until explicit deletion. Model weights are independent of meeting retention. To uninstall, stop capture, remove both plugin configuration entries, unload the companion and restart the runtime. Delete local meeting directories/model caches only after separately confirming those data deletions.

## Limitations and troubleshooting

- Missing model: inspect inventory and explicitly authorize installation; never silently change the checkpoint.
- CPU backlog: inspect measured real-time factor and queue state. Sustained overload stops capture visibly rather than dropping arbitrary speech; use verified acceleration or stop recording.
- Lost pairing: stop, re-arm and pair again. Inspect state after an uncertain native mutation before retrying.
- Audio processor failure: capture stops and releases its audio resources; reopen the companion and start again only after confirming consent.
- Speech recognition failure: the meeting stops with reason `inference_failed`, its audio window and transcript are retained, and nothing retries automatically. The popup and toolbar show the reason; retry explicitly, then start again.
- Empty MCP bindings: analysis can run, but no canonical context or external knowledge updates are available.
- Google Meet same-document hangup is browser-dependent. The companion conservatively stops on a scoped standard WebRTC connection close; explicit Stop is required when no such close occurs. Verify browser permissions, devices and playback on the target platform.
- Read-speech scores do not establish noisy-meeting or spontaneous Thai-English accuracy. Use consented representative recordings with reference transcripts, not text-only or synthesized examples.

## Verification

```sh
bun run --cwd extensions/meeting test:unit
bun run --cwd extensions/meeting test:integration
bun test --cwd packages/core test/meeting-mcp.integration.test.ts test/meeting-plugin.integration.test.ts
bun run --cwd extensions/meeting typecheck
python3 -m unittest discover -s extensions/meeting/python -p 'test_*.py'
bun run --cwd extensions/meeting test:integration:chrome
```

MCP tests use the real client/registry and a disposable local server, with deterministic extraction at the model boundary. Plugin smoke uses the real supervisor. The launcher test starts the source launcher's private server from an ordinary project directory with the launcher environment, as the TUI does. TUI tests render the native page. The separate Chrome suite requires `YCODING_TEST_ISOLATED_BROWSER_CHROME` pointing to installed Chrome for Testing with the extension-debugging commands; it verifies native popup sizing, real tab capture and cleanup with a controlled audio page, not the live Google Meet application. Setting `YCODING_MEETING_TEST_AUDIO` to a consented Thai WAV opts into the installed speech model, SQLite and existing signed-in AI provider within that browser flow. Chrome boundary doubles alone do not establish capture. The model test command performs actual local inference; reference evaluation separates Thai-only NFC character error rate from case-insensitive English technical-term recall. Verify operating-system microphone permission and actual Meet hangup separately in a consented call.
