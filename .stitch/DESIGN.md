# YCoding web design guidance for Stitch

## Authority and scope

The implemented design system is `apps/web/src/styles/tokens.css` and `apps/web/src/styles/base.css`; surface composition lives in `apps/web/src/styles/site.css`, `apps/web/src/styles/docs.css`, and `apps/web/src/styles/remote.css`. The component and route owners are `apps/web/src/ui` and `apps/web/src/remote/ui`. Product copy and public links come from `apps/web/src/content` and the corresponding live route, not a generated specimen.

Use this guidance for the YCoding remote-workspace and public-site screens in Stitch project `16683752543265506864`. The project screens supply the requested layout and interaction direction; the repository supplies semantic tokens, product content, runtime contracts, and accessibility requirements. Map the selected Stitch “Terminal Slate” compositions into the existing SolidJS components rather than importing generated HTML, fonts, or a competing palette.

## Tokens and components

- Map page, quiet/raised/sunken surfaces, primary/muted/subtle ink, borders, focus, primary action, attention, danger, and terminal plates to the corresponding `--yc-*` semantic tokens in `tokens.css`. Use the theme-specific values via `data-theme="dark"`; do not introduce a competing palette or hard-code Stitch's near-match greens and dark backgrounds.
- Use `--yc-font-sans` for UI text, `--yc-font-mono` for terminal/code text, and the existing `--yc-size-*`, `--yc-leading-*`, `--yc-weight-*`, and tracking roles. Do not add Inter or externally hosted fonts to the application or its review rebuild.
- Use the existing `--yc-space-*`, radius, shadow, gutter, header, rail, content-width, and control metrics. A standard control is 44px high with a 44px minimum hit area; dense controls are 36px only with a fine pointer and 44px with a coarse pointer. Breakpoint steps are defined in `tokens.css`, not inferred from Stitch canvas labels.
- The remote workspace adopts the Stitch terminal visual language, not its content: `.app` scopes the radius steps to 2/4/6px; labels, metadata, state chips, buttons, and navigation use `--yc-font-mono` while titles and prose keep `--yc-font-sans`; lists are flat ruled rows with a 2px accent on selection; tool, shell, request, and picker surfaces carry a sunken header bar; the selected conversation is one centered column (notices, breadcrumb, transcript, pending requests, composer); permission, guardrail, and question cards share a header bar, body, and end-aligned action footer in a single column; the composer is one bordered box with a control footer at every width. Do not add text transforms to text that tests or assistive technology read.
- Compose existing buttons, navigation, cards, form fields, tables, notices, dialogs, focus styles, and code blocks from `base.css` and their owning surface stylesheets. Extend a component only after checking its consumers. Preserve real SolidJS route/state wiring and keyboard semantics; design specimens are not implementations.
- Keep real YCoding identity, supported public links, accessible names, loading/empty/error states, and account/device/Session distinctions. Use bracketed placeholders in design specimens instead of invented account identities, device names, ages, versions, or production statistics. Offline mode does not queue remote mutations.
- Check light and dark themes, 320/390/768/1024/1440 widths, focus-visible, contrast, reduced motion, touch hit areas, and horizontal containment in the real web application. A Stitch screenshot alone does not verify those behaviors.

## Source interpretation

Use the responsive R01–R08 workspace families and P09–P14 public-site families as composition references. Repeated variants provide examples of the same product states, not additional routes. Keep specimen viewport labels, review-board framing, synthetic identities, sample transcript content, and release data out of production.

Retain the repository palette, system fonts, canonical brand assets, and accessible control sizing where the Stitch previews differ. Treat the result as design alignment with these scoped exceptions, not pixel-identical reproduction. Validate the real components and interactions at the relevant viewport and theme; generated previews do not establish runtime behavior.
