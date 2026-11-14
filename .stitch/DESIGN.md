---
version: alpha
name: YCoding web Stitch mapping
description: Stitch-to-repository mapping for the Direction A Ledger refresh of the web and desktop workspace.
surface: web
extends: ../apps/web/DESIGN.md
---

# YCoding web design guidance for Stitch

## Overview

Stitch project `projects/15933380309160575156` ("YCoding web refresh") selects Direction A — Ledger for the Web and Desktop workspace. This file maps its screens to repository tokens and components; it adds no token or rule.

## Principles

- Repository tokens, components and runtime contracts win over specimen values.
- Web and Desktop render one Ledger composition through the shared workspace components.

## Rules

| ID | Status | Binding statement | Enforcing check |
| --- | --- | --- | --- |
| S1 | approved | Stitch Ledger screens MUST map to the Ledger direction section of `../apps/web/DESIGN.md` and the rules R1–R12 of `../DESIGN.md`; specimen hex values, fonts and canvas labels MUST NOT enter production. | review-only |

## Authority and scope

`apps/web/DESIGN.md` and its brand-root `DESIGN.md` are the binding web rules; `apps/web/src/styles/tokens.css` owns rendered values. This file only adds Stitch-to-repository mapping guidance. Surface composition lives in `apps/web/src/styles/base.css`, `apps/web/src/styles/site.css`, `apps/web/src/styles/docs.css`, and `apps/web/src/styles/remote.css`. Component and route owners are `apps/web/src/ui` and `apps/web/src/remote/ui`; product copy and public links come from `apps/web/src/content` and the live route, not a generated specimen.

Use this guidance for the YCoding remote-workspace and public-site screens in Stitch project `projects/15933380309160575156` ("YCoding web refresh"), whose selected direction is "Direction A Ledger". The Ledger screens supply the requested layout and interaction direction; the repository supplies semantic tokens, product content, runtime contracts, and accessibility requirements. Map the selected Ledger compositions into the existing SolidJS components rather than importing generated HTML, fonts, or a competing palette.

## Tokens and components

- Map page, quiet/raised/sunken surfaces, primary/muted/subtle ink, borders, focus, primary action, attention, danger, and terminal plates to the corresponding `--yc-*` semantic tokens in `tokens.css`. Use the theme-specific values via `data-theme="dark"`; do not introduce a competing palette or hard-code Stitch's near-match greens and dark backgrounds.
- Use `--yc-font-sans` for UI text, `--yc-font-mono` for terminal/code text, and the existing `--yc-size-*`, `--yc-leading-*`, `--yc-weight-*`, and tracking roles. Do not add Inter or externally hosted fonts to the application or its review rebuild.
- Use the existing `--yc-space-*`, radius, shadow, gutter, header, rail, content-width, and control metrics. A standard control is 44px high with a 44px minimum hit area; dense controls are 36px only with a fine pointer and 44px with a coarse pointer. Breakpoint steps are defined in `tokens.css`, not inferred from Stitch canvas labels.
- The remote workspace adopts the Ledger visual language, not its content, on Web and Desktop. The rules, token mapping, geometry and type scale are the "Ledger direction" section of `apps/web/DESIGN.md`. In short: a 256px rail whose head holds `[Y] YCoding` and an inline `New chat` pill, then `Search sessions`, an inline `All · Waiting · Running · Idle` filter strip with counts, a lowercase monospace workspace heading and flat 36px single-line Session rows with leading status icons, no pin buttons and no machine footer; a 56px conversation header with `Title   workspace · branch` on one baseline; assistant prose on `--yc-bg` without boxes, flat inline tool and changed-files rows, and a right-aligned green-tinted user bubble with inline thumbnails, file chip and `Queued` receipt; one 20px-radius composer card holding the borderless `Ask YCoding…` textarea, chips and the green circular send button; a 448px `Session companion` with text-only `Activity`, `Changes` and `Context` tabs, `Active window`, a single-baseline `182,400 / 500K tokens` total, a three-column breakdown and `Step & prompt cache diagnostics`; and an open single-column Settings (`Machine`, `Appearance`, `Notifications`, `Permissions`, `App`). UI text and titles use `--yc-font-sans`; labels, chips, metadata, counters and code use `--yc-font-mono`. Do not add text transforms to text that tests or assistive technology read.
- Compose existing buttons, navigation, cards, form fields, tables, notices, dialogs, focus styles, and code blocks from `base.css` and their owning surface stylesheets. Extend a component only after checking its consumers. Preserve real SolidJS route/state wiring and keyboard semantics; design specimens are not implementations.
- Keep real YCoding identity, supported public links, accessible names, loading/empty/error states, and account/device/Session distinctions. Use bracketed placeholders in design specimens instead of invented account identities, device names, ages, versions, or production statistics. Offline mode does not queue remote mutations.
- Check light and dark themes, 320/390/768/1024/1440 widths, focus-visible, contrast, reduced motion, touch hit areas, and horizontal containment in the real web application. A Stitch screenshot alone does not verify those behaviors.

## Ledger screens

Stitch project `projects/15933380309160575156`; each screen has a rendered image and `spec.html` specimen.

| Screen ID | Screen title | Theme and viewport |
| --- | --- | --- |
| `2068fdf43828456691b7d121093d426c` | YCoding - Direction A Ledger Dark | Dark, 1280x1024 |
| `9928275e1648456082e57fd5376894b6` | YCoding Remote Workspace - Direction A Ledger | Dark, 1800x1040 |
| `6ab97c95b6d7406d8fe96f5a7ab0ebcd` | YCoding Remote Workspace - Direction A Ledger Light (Repaired) | Light, 1280x1024 |
| `520bccb042ae47429a861d505607734d` | YCoding Remote Workspace - Direction A Ledger Light (1800x1040) | Light, 1800x1040 |
| `f59f4a9d17454e4db752b174f33ca700` | YCoding - Settings (Direction A Ledger Dark) | Dark, 1280x1024 |
| `c35bac00043a45dcad4493b30740c71c` | YCoding - Settings (Direction A Ledger Light) | Light, 1800x1040 |

Specimen hex values are references; rendered colors resolve only to `--yc-*` tokens in `tokens.css`.

## Source interpretation

Use the Ledger screens as composition references. Variants show the same product states, not additional routes. Keep specimen viewport labels, review-board framing, synthetic identities, sample transcript content, and release data out of production.

Retain the repository palette, system fonts, canonical brand assets, and accessible control sizing where the Stitch previews differ. Treat the result as design alignment with these scoped exceptions, not pixel-identical reproduction. Validate the real components and interactions at the relevant viewport and theme; generated previews do not establish runtime behavior.

## Verification

Render the real web and desktop workspaces in both themes at 1280, 1440 and 1800px and 390px, compare them with the Ledger screens above, and run `python3 ~/.agents/skills/daedalus/scripts/design_md.py lint .stitch/DESIGN.md --strict`.

## Maintenance

Update this mapping when the selected Stitch screens change, together with the Ledger direction section of `apps/web/DESIGN.md`.
