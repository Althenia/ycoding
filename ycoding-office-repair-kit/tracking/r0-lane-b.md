# Lane B — R0-04 settings inventory / R0-06 mock reachability

Analyst lane B, node `openrouter/deepseek-v4.1-flash#high`. Read-only on sources.
Authoritative revision at read time: `a4bb99ed1cd43766985c0752fa8f55209496c2c9` (branch `main`).
Kit docs inspected are pinned to older revision `77ef4315fa66a8c51c4288e00bfa0a77a635eb63`.

Rows marked `[kit-only]` are taken from a kit document and were not confirmed against a
live file. Every other row carries a live `path:line`.

---

## Production mock reachability

Boot path: `project.godot:15 run/main_scene="res://app/main.tscn"` → `app/main.tscn:9`
(`Main` script `res://app/main.gd`) → `OfficeMain._ready() app/main.gd:49`.

There is **no** production/LIVE gate, no command-line check, no env check, and no
export-preset difference before `_start_demo()` at `app/main.gd:95`. `export_presets.cfg:9,51,81`
all use `export_filter="all_resources"` with empty include/exclude filters, so
`fixtures/*.jsonl` and `integration/demo_transport.gd` are packaged for every target.

`_start_demo()` (`app/main.gd:134-143`) sets `store.mode = MODE_DEMO`, loads
`res://fixtures/oauth-workplace.jsonl` (`app/main.gd:8`), connects `demo.event_ready`
and calls `demo.play(true)` (looping). A normal launch therefore always begins as
synthetic DEMO playback.

Classification of every demo/fixture/synthetic candidate found:

| # | Candidate (path:line) | Kind | Classification | Why |
|---|---|---|---|---|
| 1 | `app/main.gd:8` `DEMO_FIXTURE := "res://fixtures/oauth-workplace.jsonl"` | const | `production_reachable` | Loaded by `_start_demo()` on every boot |
| 2 | `app/main.gd:95` `_start_demo()` | call | `production_reachable` | Unconditional boot; `_ready()` has no branch above it |
| 3 | `app/main.gd:134-143` `_start_demo()` body | func | `production_reachable` | Sets MODE_DEMO, `demo.play(true)` loop |
| 4 | `app/main.gd:142` `demo.play(true)` | call | `production_reachable` | Looping synthetic playback |
| 5 | `app/main.gd:22` `var demo: DemoTransport` | field | `production_reachable` | Instantiated at `app/main.gd:55` on every boot |
| 6 | `app/main.gd:55` `demo = DemoTransport.new()` | call | `production_reachable` | Constructed unconditionally |
| 7 | `app/main.gd:227` `_start_demo()` in `start_demo_mode()` | call | `production_reachable` | User-triggered mode toggle back to demo |
| 8 | `app/main.gd:244` `start_demo_mode()` from `_on_mode_toggle()` | call | `production_reachable` | Sidebar product pill toggles LIVE↔DEMO |
| 9 | `app/main.gd:583-584` `_model_catalog()` → `ModelCatalog.demo_catalog()` | func | `production_reachable` | Reaches composer in DEMO, and in LIVE after fetch failure (see #10) |
| 10 | `app/main.gd:862` `_refresh_ui()` → `set_models(_model_catalog(), …)` | call | `production_reachable` | Thin wire fault: `_refresh_models()` at `:203-215` sets an empty LIVE list, then the next `_refresh_ui()` re-installs the demo list |
| 11 | `app/main.gd:136` `demo.load_fixture(DEMO_FIXTURE)` | call | `production_reachable` | Production boot |
| 12 | `integration/demo_transport.gd:1-86` whole module | module | `production_reachable` | Owns no gate; constructed from the composition root |
| 13 | `integration/demo_transport.gd:22-41` `load_fixture()` | func | `production_reachable` | Reads shipped fixture, sorts by `_fixture_at_ms` |
| 14 | `integration/demo_transport.gd:62-76` `advance()` | func | `production_reachable` | Emits fixture events on the synthetic clock |
| 15 | `integration/demo_transport.gd:85-86` `is_synthetic()` returns `true` | func | `false_positive` | Truthful marker, but nothing in production branches on it |
| 16 | `integration/fixture_translator.gd:1-184` whole module | module | `production_reachable` | Called by `demo_transport.gd:38` |
| 17 | `integration/fixture_translator.gd:71` `"_synthetic": true` | field | `production_reachable` | Every translated event is flagged, but the flag is never displayed |
| 18 | `integration/fixture_translator.gd:39-40` `DEMO_DIRECTORY` / `DEMO_MODEL_REF` | const | `production_reachable` | Fabricated session placement; `synthetic:true` at `:52` is stored but not rendered |
| 19 | `integration/fixture_translator.gd:50-52` `location`/`model`/`synthetic` in `_observed()` | field | `production_reachable` | Synthetic directory and model reach `OfficeStore.apply_session_created` |
| 20 | `core/model_catalog.gd:160-231` `demo_catalog()` | func | `production_reachable` | Fabricated models: deepseek-v4.1-flash, deepseek-v4-pro, claude-sonnet-4, gpt-5.6-luna |
| 21 | `core/model_catalog.gd:236-244` `is_demo_catalog()` | func | `production_reachable` | Used only to append the `· demo list` suffix |
| 22 | `ui/prompt/prompt_panel.gd:224-225` `label += "  ·  demo list"` | literal | `production_reachable` | The only rendered demo disclosure in the whole client |
| 23 | `core/office_store.gd:398-399` `actor.synthetic = true` | field | `false_positive` | Set from the event flag; no UI reads it (grep: only assignment site) |
| 24 | `ui/shell/sidebar_panel.gd:21,256-266,290` DEMO badge + `"synthetic"` note | literal | `production_reachable` | Mode badge reads `DEMO`, not the data's synthetic flag |
| 25 | `fixtures/oauth-workplace.jsonl`, `fixtures/reconnect-and-concurrency.jsonl` | data | `production_reachable` | Shipped in every export; `oauth-workplace` is the boot fixture |
| 26 | `tools/flow_check.gd` (whole) | harness | `development_only` | `--script` entry, not the main scene |
| 27 | `tools/capture_scene.gd:29,43`, `capture_variants.gd:13,19`, `capture_report.gd:16,22`, `capture_effort.gd:16` | harness | `development_only` | Screenshot harnesses; drive `_scene.demo` directly |
| 28 | `tools/fixture_server.py` | stub | `development_only` | Loopback stub used by `verify-integration.sh:22` |
| 29 | `tools/_probe_live*.gd` | probe | `development_only` | Developer probes |
| 30 | `tests/suites/test_demo_transport.gd` | test | `test_only` | Exercises the transport in isolation |
| 31 | `tests/suites/test_fixture_translator.gd` | test | `test_only` | Asserts fixture labels never leak (`:30-43`) |
| 32 | `tests/integration/transport_contract.gd`, `tests/integration/live_attach.gd` | test | `test_only` | Against the loopback stub only |

**Answer.** Yes: `demo_transport.gd`, `fixture_translator.gd` and the fixture data are
reached in a normal production launch, unconditionally, because `app/main.gd:95` runs
`_start_demo()` from `_ready()` with no gate of any kind. Condition list for demo in
production: none required — it is the default. The only conditional re-entry is
`_on_mode_toggle()` (`:242-245`) returning a LIVE client to demo.

The `_synthetic` / `synthetic` markers are pervasive (`fixture_translator.gd:71,111`,
`office_store.gd:399`) but only one of them is ever rendered
(`prompt_panel.gd:224-225`), so synthetic state is stored and then dropped.

---

## Demo-dependent tests

Classified by what the test *asserts*, not by whether the word "demo" appears.

### A. Legitimately encode demo behaviour (isolated unit tests — keep)

| Test (path:line) | Assertion text | Verdict |
|---|---|---|
| `tests/suites/test_demo_transport.gd:19-23` | `"shipped fixture loads without error"`, `"fixture produced wire events"` | legitimate: unit test of the transport |
| `tests/suites/test_demo_transport.gd:26-29` | `"missing fixture reports an error"` | legitimate: failure branch |
| `tests/suites/test_demo_transport.gd:44` | `"every demo event is marked synthetic"` | legitimate: marker contract |
| `tests/suites/test_demo_transport.gd:50-62` | `"demo transport exposes no network method named %s"` | legitimate: no-network boundary |
| `tests/suites/test_fixture_translator.gd:30-43` | `"fixture label %s leaked into a wire event"` | legitimate: translation contract |
| `tests/suites/test_fixture_translator.gd:52` | `"synthetic connection is labelled"` | legitimate |
| `tests/suites/test_model_catalog.gd:156-184` | `"the demo catalogue is identified as demo"`, `"an empty catalogue is not labelled demo"` | legitimate: catalogue helper contract |
| `tests/suites/test_model_catalog_api.gd:158-187` | `"server data is never presented as the synthetic demo list"`, `"a wire-carried synthetic marker cannot label a live catalogue as demo"` | legitimate: live-data guard |
| `tests/suites/test_live_transport.gd:71-73` | `"LIVE is not synthetic"` | legitimate |
| `tests/suites/test_live_transport.gd:201,215-226` | `"an unconfigured transport refuses a model switch"` | legitimate, though its name (`test_model_switch_refuses_the_demo_catalogue`) overstates what it checks — it never passes a demo-catalogue id while configured |
| `tests/suites/test_sidebar.gd:44-56` | `"the mode row names DEMO"`, `"DEMO and LIVE do not read the same"` | legitimate: badge contract |
| `tests/suites/test_sidebar.gd:61-74` | `"DEMO uses the warm accent"` | legitimate |
| `tests/suites/test_office_store.gd:173-176` | `"store defaults to DEMO"` | legitimate: reducer default |
| `tests/suites/test_motion.gd:11-88` | `user://test_motion.cfg` persistence | legitimate, unrelated to demo |

### B. Enshrine the rejected production-demo boot (must change with the fix)

| Test / tool (path:line) | Assertion text or behaviour | Problem |
|---|---|---|
| `tests/suites/test_asset_provenance.gd:381` | `"the office starts in DEMO"` — constructs `OfficeMain.new()` with no scene and asserts the default mode | Pins the production default to DEMO; the honest default after repair is an error/pending state |
| `tools/flow_check.gd:72` | `_check(store.mode == OfficeStore.MODE_DEMO, "mode stays DEMO")` | Boots the real `main.tscn` (`:22`) and asserts the synthetic mode survives |
| `tools/flow_check.gd:73` | `_check(store.root_session_id == "demo-root", "root session identified")` | Hardcodes the fixture's root id |
| `tools/flow_check.gd:74-75` | `"multiple scoped actors registered"`, `"source-backed interactions recorded"` | Asserts synthetic actors/interactions are present after boot |
| `tools/flow_check.gd:104` | `"a settled success only occurs inside synthetic DEMO"` | Encodes "success only exists in demo" as a *truthfulness* check |
| `tools/flow_check.gd:107-110` | `"demo never silently becomes LIVE"` | The mirror of the actual defect: it asserts the converse direction only |
| `tools/flow_check.gd:112` | `_check(_main.demo != null, "demo transport is the active transport")` | Asserts demo is the active transport on a normal boot |
| `tools/capture_scene.gd:3,29,43`, `capture_variants.gd:13-19`, `capture_report.gd:16-29`, `capture_effort.gd:16` | Drive `_scene.demo.advance()` / `_scene.prompt_panel` after instantiating `main.tscn` | Every visual capture path depends on the demo boot; a fix that removes the default demo boot breaks all captures |

`tools/verify.sh:44` runs `flow_check.gd` as a mandatory stage, so suite B's
expectations are enforced by the repository gate, not just by individual tests.

---

## Missed/advanced settings

Live leaves present in the config schema but absent from
`tracking/settings_catalog.json` (236 entries), ranked by desktop relevance and by
whether the kit's own coverage gate would flag them. `docs/configuration.md`
coverage is noted because a kit row sourced from docs inherits doc gaps.

| Rank | Live leaf (path:line) | In kit catalog? | In docs/configuration.md? | Why it matters |
|---|---|---|---|---|
| 1 | `providers.*.catalog.source` — `packages/core/src/config/provider.ts:63-65,72` | **absent** | **absent** | Only live value `"openai-models"`; consumed at `packages/core/src/config/plugin/provider.ts:81`. An entirely undiscovered setting: schema + consumer + zero documentation. |
| 2 | `image_analyzer.enabled` — `packages/core/src/config/image-analyzer.ts:8` | wildcard `SET-114` `image_analyzer*` | yes (section "Image analysis fallback") | A boolean gate with real fallback semantics (`isEnabled` at `:48-53` requires a resolvable model). Wildcard rows never get a Boolean treatment. |
| 3 | `image_analyzer.model` — `image-analyzer.ts:9` | wildcard only | yes | Model selection semantics (`resolveSelection` `:18-46` accepts `provider/model#variant`, bare model + provider, or either alone). A free-text row cannot validate this. |
| 4 | `image_analyzer.provider` — `image-analyzer.ts:10` | wildcard only | yes | Interacts with `model` per `:28-44`; a wrong pair silently disables the analyzer. |
| 5 | `image_analyzer.variant` — `image-analyzer.ts:11` | wildcard only | yes | Appended only when `model` has no `#` (`:29,38`). |
| 6 | `image_analyzer.template` — `image-analyzer.ts:13` | wildcard only | **absent** | Deprecated alias for `prompt`: `effectivePrompt` at `:55` is `info.prompt ?? info.template`. Exactly the class of key `ALL_SETTINGS.md` says must not get a misleading toggle. |
| 7 | `image_analyzer.max_images` — `image-analyzer.ts:14` | wildcard only | **absent** | Positive integer bound. |
| 8 | `image_analyzer.max_bytes` — `image-analyzer.ts:15` | wildcard only | **absent** | Positive integer bound. |
| 9 | `providers.*.models.*.cost.tier.type` / `.size` — `provider.ts:26-29` | `SET-068` `cost*` wildcard | **absent** | Context-tiered pricing. Wildcard gives no schema-guided editor. |
| 10 | `providers.*.models.*.cost.cache.read` / `.write` — `provider.ts:20-23` | `SET-068` wildcard | **absent** | Money-typed (`USDPerMillionTokens`); needs its own control, not free text. |
| 11 | `experimental.policies[].action` — `packages/core/src/config/policy.ts:9` | `SET-032` wildcard | partial | Closed single literal `"provider.use"` — an enum, not an open string. |
| 12 | `mcp.servers.*.oauth` as `false` — `packages/schema/src/mcp.ts:45` | `SET-087` treats it as an object | partial | The union is `OAuthConfig \| false`; disabling OAuth is a distinct state the catalog does not model. |
| 13 | `compaction.advisory` as `false` — `packages/core/src/config/compaction.ts:8-18` | `SET-122-124` model only the object form | yes | `advisory: false` disables it; the kit's percent rows cannot express that. |
| 14 | `formatter` boolean form — `packages/core/src/config/formatter.ts:12` | `SET-096` names the field, not the union | yes | `Schema.Union([Schema.Boolean, Record(...)])`. |
| 15 | `lsp` boolean form and `{disabled:true}` entry — `packages/core/src/config/lsp.ts:5-7,18` | `SET-101-106` omit the `Disabled` struct | yes | Three shapes: boolean, `{disabled:true}`, full `Server`. |
| 16 | `references.*` string form — `packages/core/src/config/reference.ts:18` | `SET-038` names `references.*` | yes | A bare string is a local path or Git repo (docs "References"); the kit rows assume the object forms. |
| 17 | `plugins[]` string form — `packages/core/src/config/plugin.ts:10` | `SET-093-095` assume the Entry object | yes | `Schema.Union([Schema.String, Entry])`. |
| 18 | `providers.*.models.*.limit.*` bounds — `provider.ts:35-39` | `SET-070-072` present | yes | Present, but no consumer-evidence; `status: pending_local_verification` for every row. |
| 19 | `shell_memory_limit_mb` ceiling — `packages/core/src/config/shell.ts:5` (`MAX_MEMORY_LIMIT_MB`) | `SET-010` present, no bound | yes | A range the UI must enforce; not recorded. |
| 20 | `provider_usage.codex_app_server.timeout_ms` ceiling 30 000 — `provider-usage.ts:10` | `SET-141` present, no bound | yes | Same gap. |

### Environment variables missed by the kit's `environment:` rows

The kit lists 22 `environment:*` rows; all 22 are the documented stable set. Live
tree adds operator-facing variables the kit does not carry:

| Variable | Live evidence | Kit catalog |
|---|---|---|
| `YCODING_SERVICE_FILE` | `apps/office/app/main.gd:267` | absent |
| `YCODING_OFFICE_DIR` | `script/install.sh:216-217` | absent |
| `YCODING_SHOW_TTFD` | `packages/cli/src/mini-host.ts:167` | absent |
| `YCODING_SERVER_USERNAME` | `packages/cli/test/standalone.test.ts:13` | absent (test-only) |
| `YCODING_CONFIG_CONTENT` | consumed by config discovery; docs:54 | `SET-178` present |

`YCODING_SERVICE_FILE` and `YCODING_OFFICE_DIR` are the desktop-relevant gaps: both
are documented (`docs/configuration.md:585,604`) and both change client behaviour,
yet neither appears in the kit's environment inventory.

### Removed keys the kit does not carry

`packages/core/src/config.ts:215-233` rejects 17 removed top-level keys
(`logLevel`, `server`, `command`, `reference`, `snapshot`, `plugin`, `autoshare`,
`disabled_providers`, `enabled_providers`, `small_model`, `mode`, `agent`,
`provider`, `permission`, `tools`, `attachment`, `layout`) plus the legacy `mcp`
shape (`:236-247`). A whole removed-config document is ignored with a warning
(`:251-254`). The kit catalog has no row for this rejection surface, so a desktop
settings UI has no inventory of keys it must refuse.

---

## Live setting inventory (counts)

Live sources walked, in order:
`packages/core/src/config.ts:44-148` (33 top-level fields) → the 24 modules under
`packages/core/src/config/` → `packages/tui/src/config/index.tsx:36-134` (TUI/client
config, the schema `packages/cli/src/config/schema.ts:4` re-exports as `cli.json`) →
`docs/configuration.md`.

`apps/office` has **no settings surface at all**. Grep for `settings|Settings` over
`apps/office/**/*.gd` returns only comments (`app/main.gd:830`, `ui/prompt/prompt_panel.gd:328`).
The complete set of client-side controls is:

| Control (path:line) | Setting it changes | Persisted? |
|---|---|---|
| `ui/shell/chrome_toggles.gd:20-24` "Motion" toggle | reduced motion (`.office/AGENTS.md` rule) | yes — `core/motion.gd:18` `user://motion.cfg:34-49`, written at `app/main.gd:834` |
| `ui/shell/chrome_toggles.gd:28-31` "Light" action | palette mode (`ui/shell/office_theme.gd:78-82`) | **no** — static var, in-memory |
| `ui/shell/chrome_toggles.gd:28-31` "Text" action | text scale (`ui/shell/office_theme.gd:25-30`, bounds `app/ui_scale.gd:15-16`) | **no** — in-memory; docs claim a corrupt *stored* value falls back (`docs/configuration.md:651`) but nothing stores it |
| `ui/prompt/prompt_panel.gd:96,188-210` model pill | live model switch | **no** — request only |
| `ui/prompt/prompt_panel.gd:84-90` "Ask for approval" | — | disabled by construction (`:81-83`, `tooltip "Approval mode is not implemented"`) |
| `ui/prompt/prompt_panel.gd:282-300` attach menu | — | every entry `set_item_disabled(true)` |
| `ui/prompt/effort_slider.gd` | model variant/effort | in-memory |
| `ui/shell/sidebar_panel.gd:54-67` agent menu | agent selection | in-memory |
| `app/shortcuts.gd:60-68` `BINDINGS` | 9 fixed bindings, no remap path | **no** — const |

Counts against the kit catalog (`tracking/settings_catalog.json`, 236 rows):

| Bucket | Count | Basis |
|---|---|---|
| Kit catalog rows (all) | 236 | `settings_catalog.json` `settings[]`, ids SET-001…SET-236 |
| — domain `runtime` | 141 | live schema has 33 top-level fields; the rest are nested leaves/wildcards |
| — domain `tui` | 32 | live `packages/tui/src/config/index.tsx` has 20 top-level fields — the kit enumerates them exhaustively and correctly |
| — domain `desktop` | 38 | **proposed, not live** — no such schema exists anywhere in the tree |
| — domain `environment` | 22 | all 22 match `docs/configuration.md:1044-1065` |
| — domain `service` | 3 | managed-service file (`docs/configuration.md:992-1024`), not runtime config |
| Live runtime settings with no kit row | ≥ 1 definite (`providers.*.catalog.source`) + ~19 wildcard-only leaves (table above) | |
| Settings with a control in `apps/office` | **3 of 236**, and only 1 of those persists | motion, palette mode, text scale |
| `desktop:*` rows whose "control" exists | 0 | no desktop settings store exists; `desktop:*` cannot be read or written by the client |

Kit status field is `pending_local_verification` for every row, and
`consumer_evidence: []` throughout — the catalog is a docs-derived hypothesis, not a
source-audited inventory.

---

## Kit-vs-live settings diff

| Kit row | Live schema path (file:line) | Verdict |
|---|---|---|
| `SET-001 runtime:autoupdate` | `packages/core/src/config.ts:64-68` | confirmed |
| `SET-002 runtime:username` | `packages/core/src/config.ts:79` | confirmed in schema; **no consumer found** via `Config.latest(..., "username")` |
| `SET-003 runtime:default_agent` | `packages/core/src/config.ts:61`; consumer `config/plugin/agent.ts:57` | confirmed |
| `SET-004 runtime:model` | `packages/core/src/config.ts:58`; consumer `config/plugin/provider.ts:162` | confirmed |
| `SET-005 runtime:snapshots` | `packages/core/src/config.ts:88`; consumer `packages/core/src/snapshot.ts:137` | confirmed |
| `SET-006 runtime:share` | `packages/core/src/config.ts:69-71` | confirmed in schema; consumer not located in this lane |
| `SET-007 runtime:enterprise.url` | `packages/core/src/config.ts:72-78` | confirmed in schema; consumer not located in this lane |
| `SET-008-010 shell / shell_sandbox / shell_memory_limit_mb` | `config.ts:47,50,54`; consumers `packages/core/src/shell.ts:256-292` | confirmed, values consumed |
| `SET-011-023 agents.*` | `config/agent.ts:14-25` (11 fields) | confirmed; kit splits request into 2 rows (`:16`) and permissions into 3 (`:24`) |
| `SET-024-026 permissions[]` | `config.ts:82` → `packages/schema/src/permission.ts:58-64` | confirmed |
| `SET-027-030 guardrails.*` | `config/guardrail.ts:8-13`; consumer `session/guardrail.ts:156` | confirmed |
| `SET-031-032 experimental.*` | `config/experimental.ts:7-14`; consumer `tool/subagent.ts:145` | confirmed |
| `SET-033-037 commands.*` | `config/command.ts:6-12` | confirmed |
| `SET-038-043 references.*` | `config/reference.ts:5-21` | confirmed in schema; consumer not located in this lane |
| `SET-044-045 skills / instruction_max_bytes` | `config.ts:115,124`; consumer `instruction-discovery.ts:95` | confirmed |
| `SET-046 instructions[]` | `config.ts:121-123` | **confirmed inactive** — matches docs:173 "no current runtime consumer reads this field" |
| `SET-047 $schema` | `config.ts:45` | confirmed |
| `SET-048-072 providers.*` | `config/provider.ts:67-74` + nested classes `:20-61` | confirmed **except** `catalog` (missing — see Missed section) |
| `SET-073-092 mcp.*` | `config/mcp.ts:18-21` → `packages/schema/src/mcp.ts:7-54` | confirmed |
| `SET-093-095 plugins[]` | `config/plugin.ts:5-13` | confirmed in schema; consumer not located in this lane |
| `SET-096-100 formatter.*` | `config/formatter.ts:5-12` | confirmed in schema; consumer not located in this lane |
| `SET-101-106 lsp.*` | `config/lsp.ts:5-18` | confirmed in schema; consumer not located in this lane |
| `SET-107 watcher.ignore[]` | `config/watcher.ts:5-7` | confirmed in schema; consumer not located in this lane |
| `SET-108-114 attachments.* / tool_output.* / image_analyzer*` | `config/attachments.ts:6-15`, `config/tool-output.ts:6-9`, `config/image-analyzer.ts:7-16` | confirmed; `image_analyzer` under-enumerated (see Missed) |
| `SET-115-124 compaction.*` | `config/compaction.ts:21-30` | confirmed; all 8 fields + the 2 advisory percents match |
| `SET-125-135 efficiency.*` | `config/efficiency.ts:6-34` | confirmed; all 10 leaves match |
| `SET-136-137 ntfy.*` | `config/ntfy.ts:5-8`; consumer `tool/ntfy.ts:40` | confirmed |
| `SET-138-141 provider_usage.codex_app_server.*` | `config/provider-usage.ts:6-15`; consumer `provider-usage.ts:175` | confirmed |
| `SET-142-173 tui:*` | `packages/tui/src/config/index.tsx:37-134` | confirmed exhaustively: `theme.name/:39`, `theme.mode/:40`, `keybinds/:45`, `plugins/:46`, `leader.timeout/:51`, `scroll.speed/:58`, `scroll.acceleration/:61`, `attention.enabled/:68`, `.notifications/:69`, `.sound/:70`, `.volume/:71`, `.sound_pack/:74`, `.sounds/:75`, `diffs.wrap/:82`, `.tree/:85`, `.single/:86`, `.view/:87`, `terminal.title/:94`, `.copy_on_select/:95`, `prompt.editor/:100`, `.paste/:103`, `session.sidebar/:110`, `.scrollbar/:113`, `.thinking/:114`, `.grouping/:117`, `hints.onboarding/:124`, `debug.devtools/:129`, `.timing/:130`, `animations/:133`, `mouse/:134` |
| `SET-173 tui:terminal.copy_on_select` | `index.tsx:95` (accepted) | confirmed deprecated/ignored, matching docs:1000 |
| `SET-174-176 service:*` | `docs/configuration.md:992-1024` `[kit-only for the file shape]` | not runtime config; no live schema to confirm against |
| `SET-177-198 environment:*` | `docs/configuration.md:1044-1065` | confirmed for the 22 documented names; list is incomplete (see Missed) |
| `SET-199-236 desktop:*` | **no live path** | **proposed only** — no settings store, no read/write route, no schema. `ALL_SETTINGS.md` requires these be implemented or explicitly classified; none is currently in any category |

Notable mismatch: `SET-144 tui:keybinds.*` says "audit_complete_action_registry" is
pending, but the registry is fully enumerable at
`packages/tui/src/config/keybind.ts:45-260` (names + defaults) and
`:265-429` (`CommandMap`, 165 command ids). The kit has no row per action, so
"every TUI action" coverage cannot be demonstrated from the catalog alone.

---

## TUI command parity table

Live TUI command surface: `packages/tui/src/app.tsx:580-979` (`appCommands`, 51 entries
including the 9 `session.quick_switch.*` and the conditional `service.restart`), plus
`packages/tui/src/component/command-palette.tsx:7-11` (3 promoted commands) and
`packages/tui/src/config/keybind.ts:265-429` (the 165-id binding map). Slash names are
declared per command (`app.tsx` `slash:` at `:596,606,629,674,683,710,735,749,758,767,778,797,806,837,846`).

| Command (TUI source) | TUI source (file:line) | Office equivalent | Status |
|---|---|---|---|
| `command.palette.show` | `app.tsx:583`; palette `component/command-palette.tsx:1-72` | **absent** | no command surface in the client |
| `session.list` | `app.tsx:592-599` | `ui/shell/sidebar_panel.gd:177-186` session list; select at `app/main.gd:74` | partial (list + select; no fuzzy picker) |
| `session.new` | `app.tsx:602-612` | `app/main.gd:621-631` `_on_new_session()` ← `sidebar_panel.gd:76` | present, **LIVE only** |
| `session.quick_switch.1-9` | `app.tsx:614-622` | **absent** | |
| `model.list` | `app.tsx:624-632` | `ui/prompt/prompt_panel.gd:96,188-210` pill popover | partial (menu, no search/dialog) |
| `model.cycle_recent` / `_reverse` | `app.tsx:635-651` | **absent** | |
| `model.cycle_favorite` / `_reverse` | `app.tsx:653-669` | **absent** | |
| `agent.list` | `app.tsx:671-678` | `ui/shell/sidebar_panel.gd:54-67` `set_agents()` | partial |
| `mcp.list` | `app.tsx:680-687` | **absent** | |
| `agent.cycle` / `agent.cycle.reverse` | `app.tsx:689-696`, `:723-730` | **absent** | |
| `variant.cycle` | `app.tsx:698-704` | `ui/prompt/effort_slider.gd` | partial |
| `variant.list` | `app.tsx:706-721` | `ui/prompt/effort_slider.gd` | partial |
| `provider.connect` | `app.tsx:732-744` | **absent** | |
| `ycoding.settings` | `app.tsx:746-754`; `component/dialog-config.tsx:1-313` (all 20 TUI fields) | **absent** | the single biggest gap |
| `ycoding.status` | `app.tsx:756-763` | `ui/shell/sidebar_panel.gd:282-300` footer | partial |
| `server.pair` | `app.tsx:765-772` | **absent** | |
| `service.restart` | `app.tsx:773-793` | **absent** | |
| `ycoding.debug` | `app.tsx:795-802` | **absent** | |
| `theme.switch` | `app.tsx:804-811` | `app/main.gd:796-798` `_cycle_theme()` (cycles, no list) | partial |
| `theme.switch_mode` | `app.tsx:813-822` | same `_cycle_theme()` | partial |
| `theme.mode.lock` | `app.tsx:824-833` | **absent** | |
| `help.show` | `app.tsx:835-842` | **absent** | `Shortcuts.DESCRIPTIONS` `app/shortcuts.gd:70-80` exists but is never rendered |
| `app.exit` | `app.tsx:844-849` | OS window close only | absent as a command |
| `app.debug` | `app.tsx:851-858` | **absent** | |
| `app.console` | `app.tsx:860-867` | **absent** | |
| `app.heap_snapshot` | `app.tsx:869-881` | **absent** | |
| `terminal.suspend` | `app.tsx:883-893` | n/a (not a terminal) | not applicable |
| `terminal.title.toggle` | `app.tsx:895-909` | **absent** | |
| `app.toggle.animations` | `app.tsx:911-923` | `ui/shell/chrome_toggles.gd:23` Motion toggle | partial (office equivalent exists) |
| `app.toggle.file_context` | `app.tsx:925-937` | **absent** | |
| `app.toggle.diffwrap` | `app.tsx:939-954` | **absent** | |
| `app.toggle.paste_summary` | `app.tsx:956-968` | `prompt_panel.gd:284-292` disabled attach menu only | absent functionally |
| diff-viewer family (`diff.open`…`diff.help`) | `keybind.ts:59-74` | **absent** | no diff viewer |
| `session.export/copy/move/fork/rename/delete/archive/share/unshare/interrupt/background/compact` | `keybind.ts:298-321` | `session.interrupt` partial at `app/main.gd:659-662`; all others **absent** | |
| autonomy / queued / skills / child / pin / stash / messages / input families | `keybind.ts:322-420` | **absent** | |

Office-only actions with no TUI command: none — the office adds no capability the
TUI lacks; it removes many.

---

## Honesty defect sites

Ranked by severity. "Honest" means an unreachable service/provider produces a
visible error or empty state, never plausible-looking fabricated work.

| Sev | Defect | Sites | Required change |
|---|---|---|---|
| **1** | Production boots into synthetic looping playback with no gate | `app/main.gd:95` (call), `:134-143` (`_start_demo`), `:142` (`play(true)`) | `_ready()` must not call `_start_demo()`; demo must require an explicit action. `_start_demo()`'s body would then be reached only from `start_demo_mode()` `:219-227`. |
| **2** | Fabricated model list silently replaces a failed LIVE read | `app/main.gd:203-215` (`_refresh_models` sets `[]` + reason), `:862` (`_refresh_ui` unconditionally re-installs `_model_catalog()`), `:583-584` (`_model_catalog()` → `ModelCatalog.demo_catalog()`), `core/model_catalog.gd:160-231` | The composer must hold one catalogue owner. `_refresh_ui()` must not overwrite a LIVE list; on LIVE, an empty catalogue must render as "no models / <reason>" (`prompt_panel.gd:205-208` already supports the empty state). |
| **3** | Fabricated session placement reaches the store and is never disclosed | `integration/fixture_translator.gd:39-40` (`DEMO_DIRECTORY`, `DEMO_MODEL_REF`), `:50-52`, `core/office_store.gd:398-399` (`actor.synthetic = true`), and no reader of `actor.synthetic` anywhere in `ui/` | Either the demo path is unreachable in production (defect 1), or the synthetic flag must be rendered. `sidebar_panel.gd:120-123` would be the place. |
| **4** | LIVE palette mode is not persisted, so a session restart silently reverts to dark | `ui/shell/office_theme.gd:11,78-82` (`static var _mode`), `ui/shell/office_theme.gd:16,25-30` (`_text_scale`), versus `docs/configuration.md:640-652` which implies a corrupt *stored* scale falls back | Add a persisted preference beside `core/motion.gd`, or correct the doc. |
| **5** | Attach and approval affordances are disabled placeholders that state their own status | `ui/prompt/prompt_panel.gd:81-90`, `:282-300` | Acceptable per `apps/office/AGENTS.md` ("A control that cannot act is disabled and states why"). Recorded as known-limited, not a defect to fix in this lane. |
| **6** | `switch_model` on LIVE does not refuse a synthetic reference | `integration/live_transport.gd:321-347` (no `is_demo_catalog` guard), contradicting the intent named by `tests/suites/test_live_transport.gd:199-226` | Either add the guard or rename the test; today the test only proves an unconfigured transport refuses. |

---

## Unknowns

- Whether the office can even read `cli.json` / runtime config: no client code opens
  either file. `apps/office/AGENTS.md` says it never opens the runtime database, and
  `ALL_SETTINGS.md` says the desktop currently writes no runtime config. Not
  independently verified in this lane beyond grepping for the file names.
- Consumer locations for `username`, `share`, `enterprise.url`, `watcher.ignore`,
  `formatter`, `lsp`, `tool_output`, `references`, `plugins`, `providers` were not
  traced beyond `Config.latest(...)` grep. `providers` is consumed indirectly through
  `config/plugin/provider.ts`; the others may be read via plugin layers this lane did
  not open. Treat the "consumer not located" rows as unverified, not absent.
- Whether `desktop:*` settings (SET-199…SET-236) are intended to be a new store or a
  projection of existing ones: `ALL_SETTINGS.md` states they are proposed. No live
  path exists.
- No Godot process was run in this lane, so none of the demo-reachability conclusions
  is runtime-verified; all are static path evidence. Deferred to the lane that owns
  the single Godot process.
- Visual capture tools (`capture_scene.gd` etc.) were read but not executed; the
  claim that they depend on the demo boot is from their source, not from a run.

---

## Verification

Read-only audit. The only file written is this note.
