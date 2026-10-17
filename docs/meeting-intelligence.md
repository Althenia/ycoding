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

The native command bundles the meeting runtime, starts a private server that loads it for the project directory (default: the current directory), arms a meeting unless one is already ready, recording or stopping, and opens the live page; `--no-open` prints the page address without opening a browser. When a meeting runtime already serves that directory, the command reuses it and exits after printing the page. Otherwise it keeps running: **Ctrl+C** stops and finalizes an active recording, then shuts the private server down. The speech prerequisites above still apply; the command installs no Python packages or model weights. The executable embeds the Python worker source and launches the configured Python interpreter with `-c`, so no separate worker script file is required.

The live page is served only on the numeric loopback address and authenticated by the per-bridge view key in its URL fragment. Start, Live and Review form one reading sheet with consent-led capture, runtime health and sources, processing metrics (buffered seconds, backlog and processed seconds), transcript, summary, findings and Ask AI. Operational details and findings are disclosures; values the runtime does not report display as unreported. Its controls start page-owned capture, stop and finalize after confirmation, and retry failed audio without restarting capture.

Native launch surfaces also issue a separate owner link carrying a narrow owner-settings credential beside the view key. Opening it adds an Owner settings section for the Ask AI model/variant and knowledge connector bindings. The ordinary live-page address never shows or enables those controls. Keep the owner link private; do not share it.

The installed executable cannot load Meeting's Solid TUI plugin, so the `/meeting` TUI commands require the source launcher. A source-run TUI with the Solid preload can instead use persistent configuration: preserve existing configuration entries and add the absolute `extensions/meeting/src/plugin.ts` path to the project's runtime `plugins` array, and the absolute `extensions/meeting/src/tui.tsx` path to global `cli.json` `plugins`. Restart that source runtime. The runtime plugin's `options` hold the configuration below; there is no top-level `meeting` key.

The alternative multilingual model is `openai/whisper-large-v3`, under the **same Hugging Face backend**, not an OpenAI API. Its default safetensors weights are approximately 3.09 GB and require separate authorization. Models stay outside Git in a configurable cache. Inference uses local files, safetensors, and no model-supplied Python code. Neither default speech model requires a paid API key.

### Browser capture

Run `ycoding meeting` (or `/meeting start` in the source TUI) and open the printed live page address. Acknowledge participant consent and organizational policy, optionally enable the separate microphone, and start capture from that page. In Chrome's native picker select the meeting tab and share its audio. A cancelled picker, a selection without audio, or denied microphone permission leaves capture stopped with recovery guidance. No extension installation or pairing is required.

Keep the live page open while recording. Tab audio and microphone audio are separate sources; microphone audio is never routed to the speakers. Use headphones to limit acoustic echo. Stop explicitly when the meeting ends; browser track termination also stops capture.

If speech recognition fails, recording stops and the transcript so far remains saved. Use **Retry failed audio**, or `/meeting retry`, then press Start again with fresh consent.

Ask AI answers questions from bounded transcript evidence through a tool-free meeting-intelligence Session; answers are advisory. One question per meeting runs at a time. The live page's question-and-answer list keeps the latest 50 entries per meeting in process memory and is cleared on restart; the analysis Session's prompts and results remain durable. Each question captures `analysis.askModel` at admission and creates its Session with that selection; changing it in Owner settings affects later questions only and never rebinds a meeting's incremental-analysis Session, which keeps the model selected when it was created. An unavailable admitted selection fails the answer; no other model is substituted.

Closing the TUI page does not stop recording. Closing or reloading the live page ends its capture; missed heartbeats stop the runtime if the page cannot send Stop. Stop from the live page, with Ctrl+C in `ycoding meeting`, or with `/meeting stop`. The live page exposes visible recording state and Stop.

### Live-page bridge contract

The native `POST /control` with `{action:"view"}` returns `{url:"http://127.0.0.1:<port>/view#key=<view-key>"}`. With `{action:"owner-view"}` it returns `{url:"http://127.0.0.1:<port>/view#key=<view-key>&owner=<owner-key>"}` for trusted native launch and control surfaces; the two keys are independent per-bridge credentials. Native control retains its separate owner-only controller credential. View requests use `Authorization: Bearer <view-key>`, exact `Host: 127.0.0.1:<port>`, and an absent Origin or exactly `http://127.0.0.1:<port>`. Query-bearing URLs are rejected. No view route grants CORS; OPTIONS returns 405.

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

Owner settings use `Authorization: Bearer <owner-key>` with the same exact Host and Origin rules as view routes. The view key, the controller credential and missing credentials return 401 there, and the owner key returns 401 on every view, capture, Ask and native-control route. `GET /view/owner/settings` returns the saved `askModel`, the current `analysisModel`, the full live catalog (`models`: providerID, id, name, enabled/status when reported, variant IDs, profile names when reported), full MCP inventory (`servers`: name, status when reported, tool names; no tool is called), and `knowledge` (`mcpEnabled`, `autoApply:false`, `requireApproval:true`, and saved bindings with a `writeCapability` of `revision-aware`, `manual-only` or `unavailable` when a write tool is bound). Inventory entries are never count-truncated; a serialized reply beyond the bridge's 1 MiB bound fails explicitly with 500 `{error:"owner_failed"}`. `POST /view/owner/settings` accepts only `{askModel?:"inherit"|{providerID,id,variant?,profile?}, knowledge?:{mcpEnabled,bindings:[{server,search,read,write?,enabled?}]}}` with at least one field, names of at most 200 characters and at most 4 bindings; any other field returns 400 `{error:"invalid_settings"}`. A model, variant or reported profile absent from live inventory, a disabled or deprecated model, or a duplicate server binding returns 422 `{error:"selection_unavailable"}` and persists nothing. Live server/tool checks apply only to active bindings; disabling a binding or turning connectors off persists without requiring its tools to be available, and enabling revalidates them. A valid update writes through the existing owner-only `settings.json` path, applies bindings to new retrieval, and returns fresh owner settings. These routes cannot call MCP tools, approve or reject proposals or findings, control capture, or change any other configuration.

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
  "analysis": { "model": "inherit", "askModel": "inherit", "incremental": true, "maxCharacters": 32000 },
  "knowledge": { "mcpEnabled": true, "autoApply": false, "requireApproval": true, "bindings": [] },
  "storage": { "provider": "sqlite", "retainAudio": false, "retentionDays": null }
}
```

`device` accepts `auto`, `cuda`, `mps`, or `cpu`; explicit unavailable devices fail. CPU selection reports a performance warning. This is **windowed chunk inference**, not token-level speech streaming. Disabling `streaming.enabled` prevents live capture. VAD is an energy threshold, not a neural speech detector or diarization system.

`cacheDir`, `pythonExecutable`, and `requestTimeoutMs` belong to `transcription`. Model-management commands accept `YCODING_MEETING_CACHE`, `YCODING_MEETING_PYTHON`, `YCODING_MEETING_MODEL`, and `YCODING_MEETING_DEVICE`. Validated runtime changes are saved in the meeting data directory's `settings.json`; saved settings override initial plugin options. Put no credentials in these options.

Model switches drain and finalize healthy old-model audio before unloading. When inference has failed, an explicitly selected replacement processes the retained window without discarding it. Explicit retry replaces an unhealthy worker before processing retained audio. Streaming geometry changes require stopped capture. A null fallback target selects no fallback; an explicitly configured fallback appears in health and transcript model attribution. No smaller checkpoint is selected silently.

The transcription module exports `registerModel`, `registerProvider`, `createProvider`, `listModels`, `getModelCompatibility`, and `installModel`. A plugin composition can register another backend without changing analysis. Hugging Face model registration declares a Whisper architecture; the worker verifies actual cached metadata before loading. Other registered providers own their model identifiers and compatibility. No whisper.cpp conversion or API speech backend is advertised.

`analysis.model: "inherit"` inherits the source Session's model and profile binding through runtime Session creation, or uses normal YCoding resolution when none is supplied. Starting from a Session uses that Session unless the command explicitly names another one. The source Session must belong to the current Location. Overrides use `{providerID, id, variant?, profile?}`. Existing Claude Code and ChatGPT sign-in flows own authentication; no credentials are scraped and no second provider client is added.

`analysis.askModel` accepts the same `inherit` or override forms and selects the model for Ask AI question Sessions only. Its `inherit` value uses the `analysis.model` selection. Incremental and final analysis always use the meeting's existing analysis Session. The Owner settings section carries an explicit profile across model and variant changes while the provider stays the same; choosing another provider drops it. Unavailable saved variants remain visible and are preserved when saving connector changes. With `askModel` unset or `inherit`, each question captures the effective `analysis.model` selection at admission, so existing Ask behavior follows the analysis selection until an explicit Ask model is saved. Owner-settings saves never change `analysis.model`.

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

Each canonical Location has an owner-only directory under `$XDG_DATA_HOME/ycoding/meeting`, defaulting to `~/.local/share/ycoding/meeting`. A separate SQLite database owns meeting metadata, transcripts, findings, summaries, plans, references, proposals, approvals and processing jobs. Schema initialization is transactional; future/unrelated schemas are rejected. The YCoding Session database is not migrated.

Raw audio is not stored. A packet acknowledgement means bounded **volatile admission**, not durable audio recovery. A crash can lose untranscribed audio while preserving completed transcripts and partial analysis. Recovery marks formerly recording meetings interrupted; re-arming and fresh live-page consent are required. A failed window can be retried only while retained in the process.

The bridge binds numeric loopback, checks exact Host and same-origin page requests, bounds payloads and separates native control from view/capture authority. The native descriptor has owner-only permissions. The view key appears only in the native-issued URL fragment, not in a query or server log; keep the full page address private. The owner key likewise travels only in the native-issued owner-link fragment. The page clears the fragment from history immediately, holds both credentials in page memory only, and puts neither in browser storage, view state, events or external referrers. Reloading the page discards them; reopen the current view or owner link from YCoding. Opening an owner link in a tab that already shows the same meeting adopts its owner credential for that page instance. No audio is sent to an external speech service. Transcript-derived analysis text goes to the selected existing AI provider under its privacy terms.

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
bun run --cwd extensions/meeting test:integration:chrome:owner
```

MCP tests use the real client/registry and a disposable local server, with deterministic extraction at the model boundary. Plugin smoke uses the real supervisor. The launcher test starts the source launcher's private server from an ordinary project directory with the launcher environment, as the TUI does. TUI tests render the native page and the start command's live page address. Bridge integration checks authenticated capture, strict messages, Host/Origin/size boundaries, removed routes and heartbeat expiry. Runtime-state integration sends capture through `/view/capture` and retains inference failure/retry, duplicate sequence, backlog and finalization assertions. The separate Chrome suite requires `YCODING_TEST_ISOLATED_BROWSER_CHROME` pointing to installed Chrome for Testing; it exercises the real live page, capture tracks and bridge using controlled browser media, not the live Google Meet application or real speech inference. The owner Chrome suite exercises the real page with ordinary, owner and invalid owner links against catalog and MCP registry doubles; it proves rendered settings behavior and persistence, not a live provider or knowledge server. The model test command performs actual local inference; reference evaluation separates Thai-only NFC character error rate from case-insensitive English technical-term recall. Verify operating-system microphone permission, native picker behavior, playback and actual Meet hangup separately in a consented call.
