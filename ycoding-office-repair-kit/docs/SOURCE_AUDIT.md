# Evidence boundary and initial audit

## Access

On 2026-09-16 the requested Secure files retry discovered the connector and invoked `list_roots`. Actual result: `FORBIDDEN: This conversation does not support developer MCPs`. This is a conversation/tool permission restriction, not proof that the repository is missing. No roots were returned. Do not guess a root or retry access through another connector to bypass it.

No checkout reads, edits, local Git inspection, native launch, tests, provider requests or configuration inspection occurred here. GitHub snapshots from earlier conversation turns are historical context, not the current local implementation.

## What the input supports

- The requested target is `/Users/viadz/Workspace/Project/ycoding` and the user requests an independent audit, repair and completion loop. Source: [request, Objective / Audit Before Modification](../references/REQUEST.md).
- The user reports broken real-provider integration, insufficient settings, unfinished UX and inappropriate mock/demo paths. These are reported defects, not independently verified root causes. Source: request sections of those names.
- The supplied 1600×900 YCoding image visibly shows a large white left panel, a large bottom-right composer, truncated top-right UI, low-contrast ancillary composer controls, and a DEMO / synthetic playback label. Source: [image 02](../references/images/02-current-ycoding-problem.png).
- The user wants an expansive pixel office, fixed left navigation and a constrained bottom-centered composer, with real runtime behavior. Source: request Core Product Layout / Composer / Completion Standard.

## What remains unknown

Actual desktop path, local revision/dirty state, Godot version, process launch method, service endpoint/auth contract, model/provider availability, configuration precedence, error cause, implementation of controls, test coverage, production reachability of demo data, active workers and animation fidelity. Record these in [local_architecture.json](../tracking/local_architecture.json), not as guesses.

## Initial diagnosis hypotheses — do not implement blindly

H1: double application of UI scale, such as root stretch plus scaled theme/minimum sizes. H2: a parent container or combined minimum size prevents the sidebar/composer from shrinking. H3: UI overlays inherit office/world scaling or use root rather than content-region coordinates. H4: debug/demo launch is selected by default or used after failed live initialization. H5: a GUI-started daemon uses different configuration/environment from the working TUI. H6: selection displayed in the composer is not the effective request model. H7: event/response handling treats accepted input as completed output.

Each requires source inspection, an actual reproduction and counterexample tests. No percentage-of-completion estimate can be derived from these screenshots.

## Subsequent public-source access

GitHub connector access succeeded after the Secure files failure. Read REMOTE_AUDIT.md for pinned source findings and integration/BASELINE.json for guarded file identities. This does not change the lack of local/native/provider evidence. The old TUI-only migration is no longer presumed necessary: the public revision already contains apps/office and release paths.
