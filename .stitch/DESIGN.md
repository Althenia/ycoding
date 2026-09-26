# YCoding web design guidance for Stitch

## Authority and scope

The implemented design system is `apps/web/src/styles/tokens.css` and `apps/web/src/styles/base.css`; surface composition lives in `apps/web/src/styles/site.css`, `apps/web/src/styles/docs.css`, and `apps/web/src/styles/remote.css`. The component and route owners are `apps/web/src/ui` and `apps/web/src/remote/ui`. Product copy and public links come from `apps/web/src/content` and the corresponding live route, not a generated specimen.

Use this guidance for the YCoding remote-workspace and public-site Stitch screens. The selected Stitch “Terminal Slate” preset and its generated HTML are proposals, not the token or behavior authority. The user requires these screens to follow YCoding's implemented design system. The source-to-rebuild direction is repository → Stitch proposal → local review; applying a proposal to production requires a separate, digest-bound visual review.

## Tokens and components

- Map page, quiet/raised/sunken surfaces, primary/muted/subtle ink, borders, focus, primary action, attention, danger, and terminal plates to the corresponding `--yc-*` semantic tokens in `tokens.css`. Use the theme-specific values via `data-theme="dark"`; do not introduce a competing palette or hard-code Stitch's near-match greens and dark backgrounds.
- Use `--yc-font-sans` for UI text, `--yc-font-mono` for terminal/code text, and the existing `--yc-size-*`, `--yc-leading-*`, `--yc-weight-*`, and tracking roles. Do not add Inter or externally hosted fonts to the application or its review rebuild.
- Use the existing `--yc-space-*`, radius, shadow, gutter, header, rail, content-width, and control metrics. A standard control is 44px high with a 44px minimum hit area; dense controls are 36px only with a fine pointer and 44px with a coarse pointer. Breakpoint steps are defined in `tokens.css`, not inferred from Stitch canvas labels.
- The remote workspace adopts the Stitch terminal visual language, not its content: `.app` scopes the radius steps to 2/4/6px; labels, metadata, state chips, buttons, and navigation use `--yc-font-mono` while titles and prose keep `--yc-font-sans`; lists are flat ruled rows with a 2px accent on selection; tool, shell, request, and picker surfaces carry a sunken header bar; the selected conversation is one centered column (notices, breadcrumb, transcript, pending requests, composer); permission, guardrail, and question cards share a header bar, body, and end-aligned action footer in a single column; the composer is one bordered box with a control footer at every width. Do not add text transforms to text that tests or assistive technology read.
- Compose existing buttons, navigation, cards, form fields, tables, notices, dialogs, focus styles, and code blocks from `base.css` and their owning surface stylesheets. Extend a component only after checking its consumers. Preserve real SolidJS route/state wiring and keyboard semantics; design specimens are not implementations.
- Keep real YCoding identity, supported public links, accessible names, loading/empty/error states, and account/device/Session distinctions. Use bracketed placeholders in design specimens instead of invented account identities, device names, ages, versions, or production statistics. Offline mode does not queue remote mutations.
- Check light and dark themes, 320/390/768/1024/1440 widths, focus-visible, contrast, reduced motion, touch hit areas, and horizontal containment in the real web application. A Stitch screenshot alone does not verify those behaviors.

## Current conflict and review status

The saved R06, R07, and P14 Stitch previews render with Inter and dark surfaces distinct from the current YCoding token values. Preserve their layout evidence while mapping colors and typography to the implemented tokens in review rebuilds; record the divergence instead of declaring pixel fidelity. R06, R07, and P14 content corrections are saved in Stitch, but their source remains a proposal. The existing `.aphrodite/stitch-review/approval-binding.json` rejects the prior generic-card rebuild, so no new production-UI approval is implied by this file.
