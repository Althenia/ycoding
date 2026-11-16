# CSS audit

Run the raw audit from the repository root with Bun, Python 3 and the installed Daedalus scanner:

```sh
bun run --cwd apps/web audit:css /path/to/daedalus/scripts/audit_css.py
```

The entry verifies that all thirteen owners are reachable through the current application module graph. It scans tokens.css, base.css, site.css, remote.css, docs.css, composer.css, projects.css, team-view.css, command-palette.css, device-alias.css, custom-select.css, modal.css and file-change-card.css with the unchanged Daedalus scanner, using tokens.css and DESIGN.md as its contracts.

Standard output is the complete raw scanner JSON object with `files`, `error`, `warning`, `info` and `findings`. Every raw finding remains present. There are no classified exceptions or adjusted counters. Exit 0 requires thirteen scanned files and zero raw errors and warnings; every warning, including an unknown code, fails. Invalid counters, unresolved source imports, missing prerequisites and inconsistent scanner exits also fail. Informational findings remain visible without changing the warning threshold.

The shared foundation owns scrollbar properties and WebKit parts unconditionally. Its feature-detected standard-property reset preserves the owned WebKit thumb in engines where standard properties otherwise replace those parts. Forced colors use system inks; transient overlay visibility remains controlled by the engine and operating system. The audit does not establish visual acceptance, physical-device keyboard behavior or untested engine rendering.

Run the selected boundary regressions:

```sh
bun test --cwd apps/web src/styles/css-audit.test.ts
```

The regressions assert raw-result preservation, rejection of every warning category, malformed-result failure, CSS parser boundaries and reachability of all thirteen owners. Responsive and native interaction checks remain in their owning source and browser suites.
