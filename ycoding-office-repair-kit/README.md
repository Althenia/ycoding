# YCoding Office — Local Repair, Expansion & Release Kit

Prepared 2026-09-16. **A local development handoff with tested utility code, not a completed desktop application.**

Continue the existing Godot client in Althenia/ycoding. This revision includes the original repair request, six attached references and later screenshot notes, all-settings coverage, multiple projects/folders, a walkable user avatar, multipage Sessions/Settings/Statistics, provider quota/budgets, and build/install/GitHub Release/Pages integration.

## Evidence boundary

Secure files `list_roots` returned `FORBIDDEN: This conversation does not support developer MCPs`. No local Mac checkout was read/changed or native app/provider run here. Public GitHub source was independently inspected at `77ef4315fa66a8c51c4288e00bfa0a77a635eb63`. Current local/uncommitted differences are unknown. All application tasks start **not_started**; utility-test results live in PACK_VALIDATION.md.

## Start locally

Extract this folder beside the checkout, not on top of it. Do not replace existing AGENTS.md.

```sh
REPO="/Users/viadz/Workspace/Project/ycoding"
KIT="/absolute/path/to/ycoding-office-repair-kit"
python3 "$KIT/tools/verify_pack.py" --root "$KIT"
python3 -B "$KIT/tools/local_audit.py" --repo "$REPO" --out "$KIT/evidence/local-audit-01"
```

Open the checkout in your local agent, supply this kit as context, and paste STARTER_PROMPT.md. It starts with inspection and native reproduction, then continues into repair. The audit writes a bounded metadata/candidate report to a fresh outside-repo directory; it does not execute the application or access credential files.

## Files to read

| Area | Files |
|---|---|
| Approved scope | references/REQUEST.md, references/ADDENDUM.md, MVP.md |
| Plan/progress | WORKPLAN.md, MILESTONES.md, TODO.md, TRACKING.md, CHECKLIST.md |
| Instructions | AGENTS.md, STARTER_PROMPT.md, prompts/, templates/ |
| Architecture/design | PROJECT_LAYOUT.md, docs/UI_SPEC.md, docs/MULTIPAGE_NAVIGATION.md |
| New project/player flows | docs/MULTI_PROJECT.md, docs/PLAYER_CONTROLS.md |
| Complete settings | docs/ALL_SETTINGS.md, docs/SETTINGS_CATALOG.md, tracking/settings_catalog.json |
| Analytics | docs/STATISTICS_AND_QUOTAS.md |
| Truthful runtime/fidelity | docs/PROVIDER_REPAIR.md, docs/CONVERSATIONS.md, docs/OFFICE_FIDELITY.md |
| Build/install/release | docs/BUILD_INSTALL_RELEASE.md, docs/GITHUB_SETUP.md, integration/ |
| Local verification | docs/TEST_PLAN.md, docs/ACCEPTANCE.md, evidence/ |
| Source evidence | docs/REMOTE_AUDIT.md, docs/SOURCES.md, integration/BASELINE.json |

## Delivery integration

The repository already has native Office builds, a CLI/Office installer, and Release/Pages workflows. This kit adds tested wrappers and guarded changes to those owners rather than a competing pipeline.

```sh
python3 "$KIT/tools/merge_delivery.py" --repo "$REPO"          # preview only
python3 "$KIT/tools/merge_delivery.py" --repo "$REPO" --apply  # explicit local edits
# After integration, from the repository:
python3 script/office_tasks.py doctor
python3 script/office_tasks.py verify
```

The merger refuses altered baseline files and pre-existing conflicting destinations; on source drift reconcile deliberately. It never stages/commits/publishes. GitHub signing secrets, protected environments, Pages configuration, runtime fixes and native acceptance still require local work. Read installation and signing docs before any install or release.

## Maintain the handoff

`tracking/tasks.json` owns status. Evidence references actual sanitized files. Run:

```sh
python3 "$KIT/tools/render_tracking.py" --root "$KIT"
python3 -B -m unittest discover -s "$KIT/tools" -p 'test_*.py' -v
python3 "$KIT/tools/verify_pack.py" --root "$KIT"
```

This package does not include a replacement application, production art pack, credentials, font binaries or downloaded Godot/Bun dependencies. It includes everything authored for continuing development locally; real tools/accounts/platforms remain prerequisites. Reference images stay private development material and are excluded from release/website builds. Earlier prototype percentages and completion claims are not acceptance standards.
