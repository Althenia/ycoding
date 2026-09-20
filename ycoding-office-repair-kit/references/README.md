# Reference materials and interpretation

[REQUEST.md](REQUEST.md) is an unchanged copy of the user's attached audit/repair/completion instructions. The supplied source has priority over proposed sizes and examples elsewhere in this kit. Its priority order is explicit requirements → previously agreed design → TUI functionality → screenshots → current implementation.

| Image | Role | Apply / do not infer |
|---|---|---|
| [01 app shell](images/01-app-shell-reference.png) | Overall reference | Compact sidebar, unobtrusive composer; usage banner is not evidence about YCoding |
| [02 current YCoding](images/02-current-ycoding-problem.png) | Reported problematic render | Audit geometry, oversized controls and synthetic mode; one image does not prove every production launch uses demo |
| [03 effort picker](images/03-model-effort-reference.png) | Control-quality reference | Compact selection and hierarchy; no hardcoded model names or universal effort levels |
| [04 sidebar](images/04-sidebar-reference.png) | Navigation quality | Grouping, density, pinned footer; do not invent PR, voice, account or schedule functionality |
| [05 composer](images/05-composer-reference.png) | Input composition | Multiline text, compact action row, supported model/permission information |
| [06 settings](images/06-settings-reference.png) | Settings quality | Grouped rows, readable descriptions and real controls; derive actual categories from YCoding |

Do not blindly copy another product's branding, model catalog, permissions semantics or billing controls. YCoding's pixel office remains the main content view. Exact original filenames and SHA-256 hashes are in [manifest.json](manifest.json).

These images may include personal UI/account information supplied by the user. Keep them in private development context, not public screenshots, shipped assets, fixtures or documentation releases. The kit grants no new rights in artwork or fonts. No font binaries are included.
