# Target layout — evolve the current app, do not scaffold a replacement

Verified existing project: apps/office/project.godot, app/main.gd, core/, integration/, office/, ui/, tests/, tools/. Keep feature-cohesive modules and root instructions. The additions below are proposed seams; reuse corresponding current files when they already exist.

```text
apps/office/
  app/                 composition root, route owner, shortcuts/input context
  core/                pure presentation state, identity, reducers, reconciliation
    projects/          project entries, request scope, view/draft cache
    statistics/        presentation filters/formatting (not runtime accounting DB)
    settings/          display registry, dirty forms, provenance
  integration/         existing HTTP/SSE client and typed wire mapping
  office/
    maps/hq/           existing map, blockers, anchors, art
    actors/            runtime actors + separately controlled PlayerActor
    director/          semantic cosmetic choreography/ambient schedules
  ui/
    shell/             persistent sidebar + content route stack
    office/            world viewport and bottom composer overlay
    sessions/          rich transcript, history, source/agent inspector
    settings/          grouped nav, search, scoped form/advanced editors
    statistics/        overview, breakdowns, quota, budget views
  tests/               production-module unit/scene + separate loopback/native tiers
  tools/               existing verify/build/export; preserve owner entrypoints
script/
  office_tasks.py       new task wrapper; calls existing owners
  office_release.py     archive gate + additive website builder
  setup_office_godot.py pinned editor/template installer for CI/local explicit use
  install-office.ps1   versioned per-user Windows CLI+GUI installer
  office_tests/        delivery utility unit tests
.github/workflows/
  release.yml          extend existing matrix/gates/publish; no second publisher
  pages.yml            extend existing docs deployment with Office downloads
  office-ci.yml        added read-only PR checks; no provider/signing secrets
Taskfile.office.yml     optional convenience; Python entrypoints also work directly
```

Scene composition: AppShell -> Sidebar + ContentHost; ContentHost routes OfficePage / SessionsPage / StatisticsPage. OfficePage -> WorldViewport + bounded Composer + context drawer. ModalLayer owns Settings and dialogs/focus. A critical attention layer is accessible across routes. Player input only owns the visible focused world. Hide/show screens must not duplicate runtime clients or drop durable state.

YCoding remains authoritative for service lifecycle/config/credentials/provider/tools/usage/permissions. Godot stores only appropriate desktop preferences and draft/view state. New settings or statistics APIs belong to public Schema/Protocol with minimal Core services and regenerated clients. Do not put app-window geometry in Agent.Info or native player positions in the runtime schema.
