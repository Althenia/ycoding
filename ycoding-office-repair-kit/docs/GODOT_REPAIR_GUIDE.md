# Godot implementation guidance — audit first

This is a repair strategy, not a patch against an inspected scene tree. Use the installed project version; consult its matching documentation before using properties. Official sources are listed in [SOURCES.md](SOURCES.md).

## 1. Find every scale owner

Inspect `project.godot`, startup scripts, themes, scene node transforms and viewport setup. Record root `content_scale_mode`, `content_scale_size` and `content_scale_factor`, viewport rect, Control global rect/combined minimum size, theme font sizes, ancestor transforms, office viewport size, camera zoom and texture filtering.

Hypothesis to test: base-window scaling + explicit content scale + already-multiplied font/minimum sizes may compound. Godot's root stretch scale is an additional factor; it is not simply a synonym for device DPI. Fix the measured ownership error, not by scattering inverse multipliers through child widgets. [W2]

## 2. Repair layout ownership

A Container positions its direct Control children. An attempted manual offset can be undone on its next layout pass. Use expand/fill settings, bounded minimum sizes and a Control wrapper for overlays. Long text in a Button/Label/OptionButton may increase the combined minimum size of its entire ancestor chain; inspect that path before changing window dimensions. [W1, W4]

For the shell: container-managed sidebar + expanding MainRegion. Inside MainRegion: full-rect OfficeHost; separately anchored composer overlay. Constrain the composer width intentionally, not via its TextEdit's content-derived width. Use padding containers for spacing. Keep native titlebar/header insets explicit.

## 3. Separate world rendering from shell density

Preserve the current office canvas if it can be clipped, zoomed and resized independently. Otherwise a SubViewport inside a SubViewportContainer is a reasonable bounded repair. Verify `stretch`, viewport size and forwarded input behavior; do not scale the SubViewportContainer's Control transform as a shortcut. This choice changes input coordinates and needs tests. [W3]

Render app UI at a resolution appropriate for readable text. Configure nearest filtering and pixel-consistent positioning for world assets. Avoid applying a low-resolution whole-app viewport just to achieve pixel art. Snap rendered world positions without making semantic state or pathfinding depend on raster coordinates. [W2]

## 4. Input and overlays

Check `mouse_filter`, focus modes and handled-event propagation. Transparent layout surfaces should not swallow office clicks; actual panels must not leak clicks through to actors or move the camera while typing. Containers, SubViewport forwarding and popup coordinates need end-to-end testing at changed scale. Prefer the engine's built-in routing over manually synthesizing duplicate mouse events. [W3, W4]

Enter/Shift+Enter, IME, Escape, focus return after a menu, mouse wheel in text/history versus world zoom, and keyboard navigation all need runtime tests. Do not infer their behavior from inspector properties.

## 5. Live transport and event projection

Use current public service contracts; do not import the TypeScript runtime into Godot or reimplement provider invocation. Godot HTTPClient requires polling and supports incremental response chunks, but HTTP chunk boundaries are not SSE messages. Reuse/fix the existing parser; test incremental UTF-8, LF/CRLF, multiline data, comments, incomplete frames, bounded buffers and network errors. [W5]

Inspect current server guarantees. Earlier documentation described a volatile stream and canonical snapshots; that is a hypothesis to verify in the checkout, not a promise of replay. Never assume Last-Event-ID resumes everything. On reconnect, reconcile canonical session/message/orchestration state and pending questions; discard obsolete visual actions. Keep terminal/status changes from being rolled back by stale events. Do not add new durable events merely to move sprites.

## 6. Diagnostics and removal

Add temporary opt-in geometry/source correlation diagnostics if the existing code lacks them. Do not ship a permanent debug overlay. Export numeric geometry in the format described by `templates/layout-capture.example.json`; record actual values, never values calculated from this kit's target. Remove or disable instrumentation safely after collecting evidence. Headless import/compiler checks supplement, not replace, a native render.
