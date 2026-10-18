# Meeting intelligence

The opt-in Meeting live page captures consented browser-tab audio, transcribes locally, and uses YCoding's existing Session generation and MCP registry for evidence-backed analysis. The Rust runtime owns processing and persistence; its native TUI plugin and live page provide review and control through the private HTTP bridge. See [configuration](./configuration.md), [runtime](./runtime.md), and [repository resources](./repository-resources.md).

## Installation and startup

Use this checkout's Rust runtime with `--meeting` enabled. Capture runs in the live page; the browser-control extension is independent.

```sh
bun install
bun run --cwd extensions/meeting build
```

The Python executable must have `torch`, `transformers`, `numpy`, and `huggingface_hub`. Prepare a dedicated Python environment explicitly; package installation downloads the speech runtime, separately from model weights:

```sh
python3 -m venv extensions/meeting/.venv
extensions/meeting/.venv/bin/python -m pip install torch transformers numpy huggingface_hub
extensions/meeting/.venv/bin/python -c 'import torch, transformers, numpy, huggingface_hub; print(torch.__version__, transformers.__version__, numpy.__version__)'
```

Select that same absolute executable through `transcription.pythonExecutable` in the Meeting directory's `settings.json`, or with `/meeting configure` in the source TUI. On Windows use `extensions/meeting/.venv/Scripts/python.exe`. Starting Meeting installs nothing and downloads no models.

The default is `biodatlab/whisper-th-large-v3-combined`, approximately 3.22 GB of weights. Review size and license before authorizing its download:

```sh
bun run extensions/meeting/script/dev.ts /path/to/project
```

Development startup launches a private Rust runtime with `--meeting`, then attaches the source TUI with its Meeting TUI plugin and Solid JSX preload. It uses temporary terminal configuration without overwriting global configuration. Run it from any directory and pass the project path; `TMPDIR` must not contain whitespace. Build `ycoding-runtime` in `rust/target/debug` first, or set `YCODING_RUNTIME_EXECUTABLE` to that executable. YCoding owns stored provider profiles. Custom global provider settings may need a normal installation rather than this isolated configuration. Quit the TUI normally to stop the private runtime and remove its temporary configuration. Use `/meeting models` to inspect local availability and `/meeting model-install biodatlab/whisper-th-large-v3-combined confirm-download` to authorize the selected download explicitly.

### `ycoding meeting`

`ycoding meeting [directory]` runs Meeting from the native Bun-built `ycoding` executable without the TUI. Meeting is native-only: the Node CLI excludes the Meeting runtime, and `meeting` and `serve --meeting` exit nonzero with `Meeting requires the native ycoding executable; it is not supported by the Node CLI.` before starting a meeting server or arming capture.

The native command starts the embedded Rust backend with Meeting enabled and prepares the project directory (default: the current directory) through client v5. It reads that Location's private bridge descriptor, arms a meeting unless one is already ready, recording or stopping, and opens the live page; `--no-open` prints the page address without opening a browser. When a meeting runtime already serves that directory, the command reuses it and exits after printing the page. Otherwise it keeps running: **Ctrl+C** stops and finalizes an active recording, then shuts the private server down. Meeting history persists in `meetings.redb` and is restored when the runtime restarts. The speech prerequisites above still apply; the command installs no Python packages or model weights. The executable embeds the Python worker source and launches the configured Python interpreter with `-c`, so no separate worker script file is required.

The live page is served only on the numeric loopback address and authenticated by the per-bridge view key in its URL fragment. Setup, Live, Finalizing, Recovery and Review form one reading sheet. Setup shows connection and browser-capture readiness with fresh consent checks. Live keeps REC and Stop in a sticky strip, compact reported metrics above the transcript, and summary and Ask AI below it. Diagnostics starts collapsed; absent values display as Unreported. Stop releases capture after confirmation. Finalizing distinguishes audio processing (`stopping`) from final analysis (`analyzing`) and keeps the transcript readable.

Recovery retains the transcript and exposes explicit failed-audio Retry when audio remains in memory. **Review retained transcript** only changes the page layout: the warning and Retry remain visible, no audio is discarded, and capture never restarts. Review puts the summary, proposed actions and open questions before evidence, with other findings in a collapsed disclosure. Findings retain their reported decision status; evidence buttons focus and mark a resident transcript segment and pause Follow. A nonresident citation directs the reader to the full transcript in YCoding. Polling preserves the transcript anchor, original/corrected selection, Follow choice and unsent Ask draft.

`ycoding meeting` and `/meeting start` also issue a separate owner link carrying a narrow owner-settings credential beside the view key; `ycoding meeting` opens the owner link unless `--no-open` is given. Opening it adds a collapsed Owner settings disclosure separate from the lifecycle for the Ask AI model/variant and knowledge connector bindings. The ordinary live-page address never shows or enables those controls. Keep the owner link private; do not share it.

The installed executable cannot load Meeting's Solid TUI plugin, so the `/meeting` TUI commands require the source launcher. A source-run TUI with the Solid preload can use persistent terminal configuration: preserve existing global `cli.json` entries and add the absolute `extensions/meeting/src/tui.tsx` path to its `plugins` array. Its attached Rust backend must start with `--meeting`. Meeting reads the configuration below from its channel-local `settings.json`; there is no top-level `meeting` key or Meeting runtime-plugin entry.

The alternative multilingual model is `openai/whisper-large-v3`, under the **same Hugging Face backend**, not an OpenAI API. Its default safetensors weights are approximately 3.09 GB and require separate authorization. Models stay outside Git in a configurable cache. Inference uses local files, safetensors, and no model-supplied Python code. Neither default speech model requires a paid API key.

### Browser capture

Run `ycoding meeting` (or `/meeting start` in the source TUI) and open the printed live page address. Acknowledge participant consent and organizational policy, optionally enable the separate microphone, and start capture from that page. In Chrome's native picker select the meeting tab and share its audio. A cancelled picker, a selection without audio, or denied microphone permission leaves capture stopped with recovery guidance. No extension installation or pairing is required.

Keep the live page open while recording. Tab audio and microphone audio are separate sources; microphone audio is never routed to the speakers. Use headphones to limit acoustic echo. Stop explicitly when the meeting ends; browser track termination also stops capture.

If speech recognition fails, recording stops and the transcript so far remains saved. Use **Retry failed audio**, or `/meeting retry`, to process the retained audio without restarting capture. To record again, arm a new meeting in YCoding, open its link, and Start with fresh consent.

Ask AI answers questions from bounded transcript evidence through a tool-free meeting-intelligence Session; answers are advisory. One question per meeting runs at a time. The live page's question-and-answer list keeps the latest 50 entries per meeting in process memory and is cleared on restart; the analysis Session's prompts and results remain durable. Each question captures `analysis.askModel` at admission and creates its Session with that selection; changing it in Owner settings affects later questions only and never rebinds a meeting's analysis Session, which keeps the model selected when the meeting was armed. An unavailable admitted selection fails the answer; no other model is substituted.

Closing the TUI page does not stop recording. Closing or reloading the live page ends its capture; missed heartbeats stop the runtime if the page cannot send Stop. Stop from the live page, with Ctrl+C in `ycoding meeting`, or with `/meeting stop`. The live page exposes visible recording state and Stop.

### Live-page bridge contract

The native `POST /control` with `{action:"view"}` returns `{url:"http://127.0.0.1:<port>/view#key=<view-key>"}`. With `{action:"owner-view"}` it returns `{url:"http://127.0.0.1:<port>/view#key=<view-key>&owner=<owner-key>"}` for trusted native launch and control surfaces; the two keys are independent per-bridge credentials and change when the bridge restarts. Native control retains its separate owner-only controller credential. View requests use `Authorization: Bearer <view-key>`, exact `Host: 127.0.0.1:<port>`, and an absent Origin or exactly `http://127.0.0.1:<port>`. Query-bearing URLs are rejected. No view route grants CORS; OPTIONS returns 405.

`POST /view/capture` accepts strict JSON messages:

| Type      | Exact fields                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------- |
| Start     | `{type:"start", captureID, microphone:boolean, consent:true}`                                  |
| Audio     | `{type:"audio", captureID, source:"remote"\|"microphone", sequence, startMs, sampleRate, pcm}` |
| Stop      | `{type:"stop", captureID, reason}`                                                             |
| Heartbeat | `{type:"heartbeat", captureID}`                                                                |

`captureID` is 1–128 ASCII letters, digits, underscores or hyphens. Sequence is a nonnegative safe integer; startMs is finite and nonnegative. Sample rate is an integer from 1 to 192000. PCM is canonical base64 of float32LE samples, at most 1,024,000 characters and one second, with every sample finite and in [-1,1]. Stop reason is 1–256 characters without ASCII controls. The JSON body limit is 1,048,576 bytes; other view POST bodies retain the 16,384-byte limit.

Capture returns 200 with `{accepted:true}` for new Start and active Heartbeat, `{accepted:true, duplicate:true}` for an already-active Start, and `{accepted:true, duplicate:boolean}` for Audio. Stop, inactive capture and shutdown return `{stop:true}`; failed inference returns `{stop:true, reason:"inference_failed"}`. Admission pressure returns 429 `{error:"busy"}` with `Retry-After: 1`. Invalid capture returns 400 `{error:"invalid_capture"}`, unauthorized requests 401 `{error:"unauthorized"}`, invalid Host/Origin 403 `{error:"invalid_host"}` or `{error:"invalid_origin"}`, wrong method 405 `{error:"method_not_allowed"}`, oversized body 413 `{error:"payload_too_large"}`, unsupported content type 415 `{error:"invalid_content_type"}`, and capture callback failure 500 `{error:"callback_failed"}`. Invalid URLs, JSON or unreadable bodies return 400 `{error:"invalid_url"}`, `{error:"invalid_json"}` or `{error:"invalid_body"}`. The retired `/pair` and `/capture` paths return 404 `{error:"not_found"}`.

`GET /view/state` exposes meeting, meetings, segments, findings, summary, plan, proposals, health, audio, analysis, config and ask when present. It has no pairing field and carries neither the owner key nor the controller credential. `POST /view/control` accepts exactly `{action:"stop"}` or `{action:"retry"}` and returns the existing controller state. Ask AI remains `POST /view/ask` with `{question}`; these routes do not grant model, configuration or knowledge-write authority.

Owner settings use `Authorization: Bearer <owner-key>` with the same exact Host and Origin rules as view routes; `GET` and `POST` are the only methods. The view key, the controller credential and missing credentials return 401 there, and the owner key returns 401 on every view, capture, Ask and native-control route. `GET /view/owner/settings` returns the saved `askModel`, the current `analysisModel`, the full live Location catalog (`models`: providerID, id, name, enabled/status when reported, variant IDs, profile names when reported), full MCP inventory (`servers`: name, status when reported, tool names; no tool is called), and `knowledge` (`mcpEnabled`, `autoApply:false`, `requireApproval:true`, and saved bindings with a `writeCapability` of `revision-aware`, `manual-only` or `unavailable` when a write tool is bound). Inventory entries are never count-truncated; a serialized reply beyond 1 MiB, or an unavailable catalog or registry, fails with 500 `{error:"owner_failed"}`. `POST /view/owner/settings` accepts only `{askModel?:"inherit"|{providerID,id,variant?,profile?}, knowledge?:{mcpEnabled,bindings:[{server,search,read,write?,enabled?}]}}` with at least one field, names of 1–200 characters and at most 4 bindings, within the 16,384-byte view body limit; any other shape returns 400 `{error:"invalid_settings"}`. A model, variant or reported profile absent from live inventory, a disabled or deprecated model, or a duplicate server binding returns 422 `{error:"selection_unavailable"}` and persists nothing. Live server/tool checks apply only to active bindings; disabling a binding or turning connectors off persists without requiring its tools to be available, and enabling revalidates them. A valid update writes the owner-only `settings.json`, applies bindings to new retrieval, and returns fresh owner settings; a failed write keeps the previous settings live and returns 500 `{error:"owner_failed"}`. These routes cannot call MCP tools, approve or reject proposals or findings, control capture, or change any other configuration.

## Configuration

Meeting `settings.json` uses camelCase JSON:

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
  "analysis": { "model": "inherit", "askModel": "inherit", "incremental": true, "maxCharacters": 32000 },
  "knowledge": { "mcpEnabled": true, "autoApply": false, "requireApproval": true, "bindings": [] },
  "storage": { "provider": "sqlite", "retainAudio": false, "retentionDays": null }
}
```

`device` accepts `auto`, `cuda`, `mps`, or `cpu`; explicit unavailable devices fail. CPU selection reports a performance warning. This is **windowed chunk inference**, not token-level speech streaming. Disabling `streaming.enabled` prevents live capture. VAD is an energy threshold, not a neural speech detector or diarization system.

`cacheDir`, `pythonExecutable`, and `requestTimeoutMs` belong to `transcription`. Validated `/meeting configure` changes are saved in the Meeting data directory's `settings.json`; the service reads saved settings before opening the database. Put no credentials in these settings. `storage.provider` retains the strict wire value `"sqlite"`; the Rust runtime persists Meeting records in `meetings.redb`.

Model switches drain and finalize healthy old-model audio before unloading. When inference has failed, an explicitly selected replacement processes the retained window without discarding it. Explicit retry replaces an unhealthy worker before processing retained audio. Streaming geometry changes require stopped capture. A null fallback target selects no fallback; an explicitly configured fallback appears in health and transcript model attribution. No smaller checkpoint is selected silently.

The runtime supports the built-in Hugging Face provider and the two Whisper model identifiers above. Its worker verifies cached model metadata before loading. Dynamic model/provider registration, whisper.cpp conversion and API speech backends are not supported.

`analysis.model: "inherit"` inherits the source Session's model and profile binding through runtime Session creation, or uses normal YCoding resolution when none is supplied. Starting from a Session uses that Session unless the command explicitly names another one. The source Session must belong to the current Location. Overrides use `{providerID, id, variant?, profile?}`. Existing Claude Code and ChatGPT sign-in flows own authentication; no credentials are scraped and no second provider client is added.

`analysis.askModel` accepts the same `inherit` or override forms and selects the model for Ask AI question Sessions only. Its `inherit` value captures the effective `analysis.model` selection at question admission. Incremental and final analysis always use the meeting's existing analysis Session. The Owner settings section carries an explicit profile across model and variant changes while the provider stays the same; choosing another provider drops it. Unavailable saved variants remain visible and are preserved when saving connector changes. Owner-settings saves never change `analysis.model`.

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

Configure a server through normal `mcp.servers`, then explicitly bind operations in `knowledge.bindings`: `{server, search, read, write?, enabled?}`. Names are checked against the live Location registry; tool descriptions/annotations never grant authority. `enabled` defaults to `true`; a disabled binding and every binding while `knowledge.mcpEnabled` is false stay saved but retrieve nothing. The Owner settings section adds, removes and toggles bindings from reported server/tool inventory with each server bound at most once; saving calls no MCP tool, and capability is revalidated against the live registry on each retrieval and write.

| Operation | Arguments                         | Structured response (or JSON text response)        |
| --------- | --------------------------------- | -------------------------------------------------- |
| Search    | `{query, limit: 3}`               | `{documents: [{id}]}`                              |
| Read      | `{id}`                            | `{id, revision, content}`                          |
| Replace   | `{id, content, expectedRevision}` | Acknowledgement, followed by a required read-back. |

The writer must advertise required `id`, `content`, and `expectedRevision` fields and enforce atomic optimistic concurrency. Merely accepting an extra argument is not a revision guarantee. Use a server's supported adapter when native document shapes differ; arbitrary write signatures are not guessed.

Bounded retrieval is cached by server/capability/query; references persist independently from proposals. Every proposal retains complete old/new content, explanation, evidence, confidence, revision and approval history. Approval re-reads both content and revision; a stale source blocks writing. Read-back requires the proposed content and a changed revision. Read-only/non-revision-aware writers leave manual proposals. A failed write or read-back is **uncertain** and never automatically replayed.

## Persistence, privacy and recovery

Each canonical Location has an owner-only directory under `$XDG_DATA_HOME/ycoding/meeting`, defaulting to `~/.local/share/ycoding/meeting`. Beta installations use `ycoding-beta/meeting` under the same data base. Native control discovery follows the installation channel; both channels use the first 32 lowercase hexadecimal characters of the canonical Location path's SHA-256 as the directory key. A separate `meetings.redb` owns meeting metadata, transcripts, findings, summaries, plans, references, proposals, approvals and processing jobs.

The first beta start imports an existing stable `ycoding/meeting/<location-key>/meetings.sqlite` through private scratch, preserving the source database and sidecar bytes. Verified history is published atomically into `ycoding-beta/meeting/<location-key>/meetings.redb` with `stable-import-v1.json`; restarts retain the selected beta store. Import failure publishes no partial destination or completion marker, logs a Location-scoped diagnostic, and leaves other runtime services available. Settings remain channel-local and are not imported. Meeting history import is separate from the YCoding Session store's first-start import.

Raw audio is not stored. A packet acknowledgement means bounded **volatile admission**, not durable audio recovery. A crash can lose untranscribed audio while preserving completed transcripts and partial analysis. Recovery marks formerly recording meetings interrupted; re-arming and fresh live-page consent are required. A failed window can be retried only while retained in the process.

The bridge binds numeric loopback, checks exact Host and same-origin page requests, bounds payloads and separates native control from view/capture authority. The native descriptor has owner-only permissions. The view key appears only in the native-issued URL fragment, not in a query or server log; keep the full page address private. The owner key likewise travels only in the native-issued owner-link fragment. The page clears the fragment from history immediately, holds both credentials in page memory only, and puts neither in browser storage, view state, events or external referrers. Reloading the page discards them; reopen the current view or owner link from YCoding. Opening an owner link in a tab that already shows the same meeting adopts its owner credential for that page instance. No audio is sent to an external speech service. Transcript-derived analysis text goes to the selected existing AI provider under its privacy terms.

`retentionDays` removes expired inactive meetings; null retains history until explicit deletion. Model weights are independent of meeting retention. To disable Meeting, stop capture, start the backend without `--meeting`, and remove its terminal plugin entry if configured. Delete local Meeting directories/model caches only after separately confirming those data deletions.

## Limitations and troubleshooting

- The page receives the latest 101 transcript segments, not a paginated transcript API. Earlier evidence stays in YCoding; use `/meeting transcript`. No browser control loads older pages.
- Audio metrics are aggregate buffered seconds, processed seconds and chunk backlog. Failed-range timestamps, transcription lag, elapsed recording time and completion percentages are not reported; the page does not infer them.
- Summary checkpoints and Ask AI answers carry no structured segment citations. Only finding-provided citations become evidence buttons; summary and answer text is not converted into invented links.
- Reviewing retained evidence does not finalize missing audio or dismiss its failure. Finding confirmations, knowledge approvals, analysis retry and rearming stay in YCoding through the terminal handoff.
- Missing model: inspect inventory and explicitly authorize installation; never silently change the checkpoint.
- CPU backlog: inspect measured real-time factor and queue state. Sustained overload stops capture visibly rather than dropping arbitrary speech; use verified acceleration or stop recording.
- Unavailable page or invalid view key: obtain the live page address from the current runtime. Inspect state after an uncertain native mutation before retrying.
- Audio processor failure: capture stops and releases its audio resources; start again from the live page only after confirming consent.
- Speech recognition failure: the meeting stops with reason `inference_failed`, its audio window and transcript are retained, and nothing retries automatically. Retry explicitly; a new recording requires rearming in YCoding and fresh consent on its page.
- Empty MCP bindings: analysis can run, but no canonical context or external knowledge updates are available.
- Google Meet same-document hangup is not a capture-track termination guarantee. Stop explicitly when the call ends. Verify browser permissions, devices and playback on the target platform.
- Read-speech scores do not establish noisy-meeting or spontaneous Thai-English accuracy. Use consented representative recordings with reference transcripts, not text-only or synthesized examples.

## Verification

```sh
bun run --cwd extensions/meeting test:unit
bun run --cwd extensions/meeting test:integration
~/.cache/ycoding/cargo-gate.sh cargo test --manifest-path rust/Cargo.toml --locked -p ycoding-core --test 'meeting_*'
~/.cache/ycoding/cargo-gate.sh cargo test --manifest-path rust/Cargo.toml --locked -p ycoding-runtime --test meeting_clients --test meeting_import --test launcher
bun run --cwd extensions/meeting typecheck
python3 -m unittest discover -s extensions/meeting/python -p 'test_*.py'
bun run --cwd extensions/meeting test:integration:chrome
bun run --cwd extensions/meeting test:integration:chrome:owner
```

MCP integration runs the real Rust client/registry against a disposable local MCP process with deterministic extraction at the external model boundary. The launcher tests start the private Rust runtime from an ordinary project directory in normal and beta channels. TUI tests render the native page and the start command's live page address. Rust bridge/runtime suites cover authenticated capture, strict messages, Host/Origin/size boundaries, heartbeat expiry, inference failure/retry, duplicate sequences, backlog, finalization and restart. The separate Chrome suite requires `YCODING_TEST_ISOLATED_BROWSER_CHROME` pointing to installed Chrome for Testing; it exercises the real live page and Rust runtime using controlled browser media, local speech-worker and model stand-ins. Its Unreported-display case omits only optional diagnostics from a real state response. It does not exercise live Google Meet or actual speech inference. The owner Chrome suite exercises the real page with ordinary, owner and invalid owner links against the Rust runtime, a synthetic model catalog, a stand-in provider and a disposable MCP server; it proves rendered settings behavior, persistence and the selected Ask model's provider request, not a live provider or knowledge server. Verify operating-system microphone permission, native picker behavior, playback, representative Thai-English accuracy and actual Meet hangup separately in a consented call.
