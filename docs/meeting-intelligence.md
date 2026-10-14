# Meeting intelligence

The opt-in Meeting live page captures consented browser-tab audio, transcribes locally, and uses YCoding's existing Session generation and MCP registry for evidence-backed analysis. Its runtime and native TUI plugins own processing and review. See [configuration](./configuration.md), [runtime](./runtime.md), and [repository resources](./repository-resources.md).

## Installation and startup

Use this checkout's runtime; its plugin API includes the required Location-scoped MCP domain. Capture runs in the live page; the browser-control extension is independent.

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

The native command starts the embedded Rust backend with Meeting enabled and prepares the project directory (default: the current directory) through client v5. It reads that Location's private bridge descriptor, arms a meeting unless one is already ready, recording or stopping, and opens the live page; `--no-open` prints the page address without opening a browser. When a meeting runtime already serves that directory, the command reuses it and exits after printing the page. Otherwise it keeps running: **Ctrl+C** stops and finalizes an active recording, then shuts the private server down. Meeting history persists in `meetings.redb` and is restored when the runtime restarts. The speech prerequisites above still apply; the command installs no Python packages or model weights. The executable embeds the Python worker source and launches the configured Python interpreter with `-c`, so no separate worker script file is required.

The live page is served only on the numeric loopback address and authenticated by the per-bridge view key in its URL fragment. Start, Live and Review form one reading sheet with consent-led capture, runtime health and sources, processing metrics (buffered seconds, backlog and processed seconds), transcript, summary, findings and Ask AI. Operational details and findings are disclosures; values the runtime does not report display as unreported. Its controls start page-owned capture, stop and finalize after confirmation, and retry failed audio without restarting capture.

The installed executable cannot load Meeting's Solid TUI plugin, so the `/meeting` TUI commands require the source launcher. A source-run TUI with the Solid preload can instead use persistent configuration: preserve existing configuration entries and add the absolute `extensions/meeting/src/plugin.ts` path to the project's runtime `plugins` array, and the absolute `extensions/meeting/src/tui.tsx` path to global `cli.json` `plugins`. Restart that source runtime. The runtime plugin's `options` hold the configuration below; there is no top-level `meeting` key.

The alternative multilingual model is `openai/whisper-large-v3`, under the **same Hugging Face backend**, not an OpenAI API. Its default safetensors weights are approximately 3.09 GB and require separate authorization. Models stay outside Git in a configurable cache. Inference uses local files, safetensors, and no model-supplied Python code. Neither default speech model requires a paid API key.

### Browser capture

Run `ycoding meeting` (or `/meeting start` in the source TUI) and open the printed live page address. Acknowledge participant consent and organizational policy, optionally enable the separate microphone, and start capture from that page. In Chrome's native picker select the meeting tab and share its audio. A cancelled picker, a selection without audio, or denied microphone permission leaves capture stopped with recovery guidance. No extension installation or pairing is required.

Keep the live page open while recording. Tab audio and microphone audio are separate sources; microphone audio is never routed to the speakers. Use headphones to limit acoustic echo. Stop explicitly when the meeting ends; browser track termination also stops capture.

If speech recognition fails, recording stops and the transcript so far remains saved. Use **Retry failed audio**, or `/meeting retry`, then press Start again with fresh consent.

Ask AI answers questions from bounded transcript evidence through a tool-free meeting-intelligence Session; answers are advisory. One question per meeting runs at a time. The live page's question-and-answer list keeps the latest 50 entries per meeting in process memory and is cleared on restart; the analysis Session's prompts and results remain durable.

Closing the TUI page does not stop recording. Closing or reloading the live page ends its capture; missed heartbeats stop the runtime if the page cannot send Stop. Stop from the live page, with Ctrl+C in `ycoding meeting`, or with `/meeting stop`. The live page exposes visible recording state and Stop.

### Live-page bridge contract

The native `POST /control` with `{action:"view"}` returns `{url:"http://127.0.0.1:<port>/view#key=<view-key>"}`. Native control retains its separate owner-only controller credential. View requests use `Authorization: Bearer <view-key>`, exact `Host: 127.0.0.1:<port>`, and an absent Origin or exactly `http://127.0.0.1:<port>`. Query-bearing URLs are rejected. No view route grants CORS; OPTIONS returns 405.

`POST /view/capture` accepts strict JSON messages:

| Type      | Exact fields                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------- |
| Start     | `{type:"start", captureID, microphone:boolean, consent:true}`                                  |
| Audio     | `{type:"audio", captureID, source:"remote"\|"microphone", sequence, startMs, sampleRate, pcm}` |
| Stop      | `{type:"stop", captureID, reason}`                                                             |
| Heartbeat | `{type:"heartbeat", captureID}`                                                                |

`captureID` is 1–128 ASCII letters, digits, underscores or hyphens. Sequence is a nonnegative safe integer; startMs is finite and nonnegative. Sample rate is an integer from 1 to 192000. PCM is canonical base64 of float32LE samples, at most 1,024,000 characters and one second, with every sample finite and in [-1,1]. Stop reason is 1–256 characters without ASCII controls. The JSON body limit is 1,048,576 bytes; other view POST bodies retain the 16,384-byte limit.

Capture returns 200 with `{accepted:true}` for new Start and active Heartbeat, `{accepted:true, duplicate:true}` for an already-active Start, and `{accepted:true, duplicate:boolean}` for Audio. Stop, inactive capture and shutdown return `{stop:true}`; failed inference returns `{stop:true, reason:"inference_failed"}`. Admission pressure returns 429 `{error:"busy"}` with `Retry-After: 1`. Invalid capture returns 400 `{error:"invalid_capture"}`, unauthorized requests 401 `{error:"unauthorized"}`, invalid Host/Origin 403 `{error:"invalid_host"}` or `{error:"invalid_origin"}`, wrong method 405 `{error:"method_not_allowed"}`, oversized body 413 `{error:"payload_too_large"}`, unsupported content type 415 `{error:"invalid_content_type"}`, and capture callback failure 500 `{error:"callback_failed"}`. Invalid URLs, JSON or unreadable bodies return 400 `{error:"invalid_url"}`, `{error:"invalid_json"}` or `{error:"invalid_body"}`. The retired `/pair` and `/capture` paths return 404 `{error:"not_found"}`.

`GET /view/state` exposes meeting, meetings, segments, findings, summary, plan, proposals, health, audio, analysis, config and ask when present. It has no pairing field. `POST /view/control` accepts exactly `{action:"stop"}` or `{action:"retry"}` and returns the existing controller state. Ask AI remains `POST /view/ask` with `{question}`; these routes do not grant model, configuration or knowledge-write authority.

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
| `/meeting start [sessionID] [title]`                                                  | Initialize speech, arm a meeting and show its live page address; page activation and consent remain required.                          |
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

Each canonical Location has an owner-only directory under `$XDG_DATA_HOME/ycoding/meeting`, defaulting to `~/.local/share/ycoding/meeting`. Beta installations use `ycoding-beta/meeting` under the same data base. Native control discovery follows the installation channel; both channels use the first 32 lowercase hexadecimal characters of the canonical Location path's SHA-256 as the directory key. A separate SQLite database owns meeting metadata, transcripts, findings, summaries, plans, references, proposals, approvals and processing jobs. Schema initialization is transactional; future/unrelated schemas are rejected. The YCoding Session database is not migrated.

Raw audio is not stored. A packet acknowledgement means bounded **volatile admission**, not durable audio recovery. A crash can lose untranscribed audio while preserving completed transcripts and partial analysis. Recovery marks formerly recording meetings interrupted; re-arming and fresh live-page consent are required. A failed window can be retried only while retained in the process.

The bridge binds numeric loopback, checks exact Host and same-origin page requests, bounds payloads and separates native control from view/capture authority. The native descriptor has owner-only permissions. The view key appears only in the native-issued URL fragment, not in a query or server log; keep the full page address private. No audio is sent to an external speech service. Transcript-derived analysis text goes to the selected existing AI provider under its privacy terms.

`retentionDays` removes expired inactive meetings; null retains history until explicit deletion. Model weights are independent of meeting retention. To uninstall, stop capture, remove both plugin configuration entries and restart the runtime. Delete local meeting directories/model caches only after separately confirming those data deletions.

## Limitations and troubleshooting

- Missing model: inspect inventory and explicitly authorize installation; never silently change the checkpoint.
- CPU backlog: inspect measured real-time factor and queue state. Sustained overload stops capture visibly rather than dropping arbitrary speech; use verified acceleration or stop recording.
- Unavailable page or invalid view key: obtain the live page address from the current runtime. Inspect state after an uncertain native mutation before retrying.
- Audio processor failure: capture stops and releases its audio resources; start again from the live page only after confirming consent.
- Speech recognition failure: the meeting stops with reason `inference_failed`, its audio window and transcript are retained, and nothing retries automatically. The live page shows the reason; retry explicitly, then start again with fresh consent.
- Empty MCP bindings: analysis can run, but no canonical context or external knowledge updates are available.
- Google Meet same-document hangup is not a capture-track termination guarantee. Stop explicitly when the call ends. Verify browser permissions, devices and playback on the target platform.
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

MCP tests use the real client/registry and a disposable local server, with deterministic extraction at the model boundary. Plugin smoke uses the real supervisor. The launcher test starts the source launcher's private server from an ordinary project directory with the launcher environment, as the TUI does. TUI tests render the native page and the start command's live page address. Bridge integration checks authenticated capture, strict messages, Host/Origin/size boundaries, removed routes and heartbeat expiry. Runtime-state integration sends capture through `/view/capture` and retains inference failure/retry, duplicate sequence, backlog and finalization assertions. The separate Chrome suite requires `YCODING_TEST_ISOLATED_BROWSER_CHROME` pointing to installed Chrome for Testing; it exercises the real live page, capture tracks and bridge using controlled browser media, not the live Google Meet application or real speech inference. The model test command performs actual local inference; reference evaluation separates Thai-only NFC character error rate from case-insensitive English technical-term recall. Verify operating-system microphone permission, native picker behavior, playback and actual Meet hangup separately in a consented call.
