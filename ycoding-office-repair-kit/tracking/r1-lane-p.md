# Lane P — documentation reconciliation for the LIVE boot change

HEAD: a4bb99e (`main`), dirty tree (other lanes' work present). Untracked kit present.
Owner paths (exactly these three): `docs/runtime.md`, `docs/configuration.md`, `apps/office/AGENTS.md`.

## Code evidence (read before editing)

`apps/office/app/main.gd`:
- `_ready()` (line 61) ends with `_boot_live()`; the preceding comment states synthetic
  playback is never the default and this path cannot reach it.
- `_boot_live()` (178) → `_boot_with(_read_service_registration())`.
- `_boot_with(registration)` (185): empty registration → `_enter_disconnected_live(NO_SERVICE_MESSAGE)`;
  otherwise `start_live(...)`, falling back to `_enter_disconnected_live(error)`.
- `_enter_disconnected_live(message)` (209): `MODE_LIVE` + `CONNECTION_DISCONNECTED`, message set,
  composer keeps its draft, models cleared.
- `_retry_connection()` (234): only in LIVE, re-reads registration and re-boots.
- `start_live(...)` (248) comment: "LIVE is only entered on an explicit request **or by the boot
  decision**"; `_start_demo()` (146) comment: reachable ONLY through the explicit demo action,
  driven by `_on_mode_toggle()` (347) / `start_demo_mode()`.
- `NO_SERVICE_MESSAGE` (14) names `service.json` and `ycoding service start`.
- `ServiceRegistration.candidates` (`integration/service_registration.gd`): override, then
  `$XDG_STATE_HOME/ycoding/service.json`, then `$HOME/.local/state/ycoding/service.json`.

## 1. `docs/runtime.md` — changed

Before (lines 621–625):
```
- **DEMO** is synthetic playback from a fixture. It performs no mutation, and the
  store exposes no mutation method in that mode.
- **LIVE** attaches to an existing local service and is entered only on an
  explicit request; DEMO never becomes LIVE on its own. The office attaches to a
  service but never starts or stops one.
```

After:
```
- **DEMO** is synthetic playback from a fixture, reachable only by an explicit
  user mode action. It performs no mutation, and the store exposes no mutation
  method in that mode.
- **LIVE** is the mode a normal launch enters: the client reads the local service
  registration and attaches when one is present, and otherwise renders a
  disconnected office that names what is missing. It attaches to a service but
  never starts or stops one; DEMO never becomes LIVE on its own.
```

Justification: `_ready` → `_boot_live` → `_boot_with`; `_start_demo` reachable only from
`_on_mode_toggle`/`start_demo_mode`. Kept still-true invariants: synthetic playback / no mutation
method, attach-not-start/stop, LIVE mutations incl. refusal reporting, volatile event feed =
reconnect is not a resume, canonical reload, attention reply shapes, room justification, motion —
all re-read after edit and unchanged in the file.

## 2. `docs/configuration.md` — changed (one clause)

Before:
```
`apps/office` needs no configuration of its own. In LIVE it reads the same local
service registration the CLI writes, so the address and password are not retyped.
```
After:
```
`apps/office` needs no configuration of its own. On start it reads the same local
service registration the CLI writes, so the address and password are not retyped.
```
Justification: the read now happens at boot, before any mode choice (`_boot_live` → `_read_service_registration`),
not only after choosing LIVE. Still-true parts kept verbatim: no configuration of its own,
`YCODING_SERVICE_FILE` override, `XDG_STATE_HOME` then `~/.local/state`, registration under the
**state** directory not the config directory, no own credentials, never starts/stops a service.
Rest of the section (Installation onward) is installation-only and unaffected.

## 3. `apps/office/AGENTS.md` — changed (single Truthfulness bullet)

Before:
```
- `DEMO` is explicitly synthetic and cannot perform live mutations. `LIVE` preserves the same prompt admission, delivery, and approval semantics as the TUI. Never auto-switch DEMO to LIVE.
```
After:
```
- A normal launch enters `LIVE`: it reads the local service registration and attaches when one is present, and otherwise states the missing registration rather than fabricating an office. `DEMO` is explicitly synthetic, cannot perform live mutations, and is reachable only by an explicit user action. `LIVE` preserves the same prompt admission, delivery, and approval semantics as the TUI. Never auto-switch DEMO to LIVE.
```
Justification: same functions as above. "Never auto-switch DEMO to LIVE" and the following
"In LIVE the client performs the mutations the UI exposes" bullet are preserved untouched.
No other bullet or section of the file was edited.

## Deliberately left alone

- `apps/office/AGENTS.md` "Shell" / "Designed dimensions and regions" section (sidebar "floats
  over the office", office full-bleed) — owned by the in-flight R2 shell lane; not touched.

## Other stale passages found (NOT owned — not edited)

- `README.md:43`: "it needs a running `ycoding` service for live sessions and works offline with
  synthetic playback otherwise." The "otherwise" still implies synthetic playback is the fallback
  offline mode; current boot renders a LIVE-but-disconnected office, and DEMO requires an explicit
  user action. Stale.
- `docs/releases/v0.2.5.md:8`: "The desktop client attaches to a running `ycoding` service for live
  sessions ... and works offline with synthetic playback otherwise." Same overstatement; release
  note for a shipped version, so it describes v0.2.5 behavior and arguably is historical. Flagged,
  not edited.

All other `docs/*.md` and `README.md` hits for office/DEMO/synthetic playback are architecture,
product-direction, install, or unrelated-attachment prose with no boot claim.

## Unverified

- No runtime click-through of the Retry affordance or disconnected screen; behavior read from
  `main.gd` source only. No Godot run (single-process lock held by other lanes).
- No documentation lint/build gate exists for these prose files; correctness checked by re-reading
  each edited passage against `main.gd`.
