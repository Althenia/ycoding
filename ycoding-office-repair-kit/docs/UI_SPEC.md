# UI repair specification

**Source requirements:** [original request](../references/REQUEST.md), Core Product Layout / UX/UI / Settings / Composer / Sidebar. **Numbers below are proposed YCoding design targets**, not verified code or pixel-perfect copies of the reference applications. Refine only with rendered evidence and user approval.

## Coordinate and scale contract

Use logical UI units for layout. Record physical window pixels, root content size, root content scale, effective UI scale, monitor/device scale and office zoom separately. Do not infer those from screenshot dimensions or `light_200_v8.png`'s filename.

Choose ONE owner of shell scale. The office camera and pixel scaling must not magnify the app sidebar, composer, settings or menus. Rendering sharp pixel art does not require pixelated app text. A 200% user setting must trigger responsive reflow when space shrinks; do not force the UI back to 100% to make a screenshot fit.

## App shell

At normal effective scale and a sufficiently wide logical viewport: sidebar target 264 logical units, acceptable design range 248–288. It touches the application left edge and fills the content height below native titlebar/header. Use 8/12/16/24 spacing steps, compact 32–36-unit navigation rows, 14-unit main UI text and 12-unit secondary text. Keep the footer anchored while long navigation scrolls.

At logical widths below 1000, default to a 56-unit rail; the full sidebar opens as a dismissible overlay on explicit request. Keep primary navigation/settings reachable and labelled by tooltips/focus text. Do not auto-close a user-opened drawer during interaction. The office fills all remaining content width and height, with clipping at the content region. Long titles truncate with access to the full value; they must not set the minimum width of the entire sidebar.

Do not render both an always-open session panel and a large sidebar by default. Inspector/history is bounded, closeable and preserves office context. When an inspector is pinned, center the composer in the remaining visible office rectangle, not the full application window. Dialogs may cover the scene temporarily; normal operation must not.

## Composer

Target width: `min(840, visible_office_width - 2 * gutter)`, where gutter is 24 normally and 16 in compact layout. Position it horizontally at the center of the **visible office region**, with bottom margin 24 normally / 16 compact. Default empty height is approximately 112; grow with text to a limit of `min(240, 0.35 * visible_office_height)`, then scroll internally. At exceptionally small heights, reduce nonessential gaps before making input/actions inaccessible; the text editor and send/stop must remain reachable.

Use a top input area and a lower compact action row. Keep the send/stop control fixed-size. Model/permission labels may truncate visually, but full values remain accessible through the picker/tooltip. Controls must wrap or move to a supported overflow menu, not push beyond bounds. Do not add a microphone, voice mode, attachment button or permission toggle unless the corresponding YCoding capability is real and wired.

Enter sends according to the app's existing configurable convention; Shift+Enter inserts a newline. IME composition must never accidentally send. Empty/whitespace-only prompts do not submit. Preserve draft on failure and across safe navigation. At send, clearly distinguish submitting/admitted/streaming/awaiting-approval/completed/error/cancelled. Do not clear user input before durable admission is confirmed. Use the existing input-ID/retry semantics; do not resend provider work blindly after a timeout.

During a run, use Stop where supported. If steering/queueing is supported by current YCoding, implement the existing semantics and make their state clear instead of assuming every session must disable all input. Stop requires runtime acknowledgement or reconciliation; stopping the typewriter animation is not cancellation.

## Model / effort / permission popovers

The screenshots specify polish, not a model registry. Populate provider/model options from current runtime configuration/catalog. Show missing configuration or availability errors honestly. Apply changes at the documented scope (session/default/agent) and expose the effective value. Reasoning/effort controls appear only when the selected model and runtime support them; use the actual enum/parameter mapping. A discrete menu is acceptable if more robust than a slider; never interpolate unsupported values.

Open popovers within the visible window. Include keyboard navigation, Escape dismissal and focus restoration. Reset returns to a documented default, not an arbitrary “Medium”. Permission options must reflect current autonomy, permission and guardrail rules; reference “full access” text does not override them.

## Settings

Use an explicit settings view with left category navigation and readable grouped rows; a scrollable form can temporarily replace the office region. Preserve workspace/session context and drafts when returning. Categories are discovered from existing functionality, then prioritized: provider/model configuration, runtime behavior where exposed, desktop appearance/scale/motion, session/workspace preferences and supported keyboard behavior.

Each control has an actual owner/read/write path, scope, effective value, validation, save/apply timing and persistence verification. No fake saved toast. Differentiate inherited/default values from overrides. Avoid duplicating secrets into Godot preferences or evidence. Where an existing credential path cannot safely be edited in Godot, implement an honest guided flow through the supported mechanism and verify it—not a decorative password field.

## Themes and visual states

Normal, hover, pressed, selected, focused, disabled, loading, error and pending-approval states must be deliberate. Dark and light themes share geometry. Use the token file as a proposed palette; test actual contrast after applying fonts/opacity. Do not make disabled text indistinguishable from the background, or use color alone for blocked/work states. Preserve native/vector text rendering while keeping world textures sharp. No font binaries are bundled in this kit.

## Layout acceptance

Run geometry checks against **runtime-exported logical rectangles** using `tools/check_layout_capture.py`. The validator checks only the captured default office-shell geometry; it does not prove interaction or visual quality. Modal/settings/drawer states need their own visual checks. A synthetic rectangle example cannot be marked live evidence.

At default office state: full-height aligned sidebar/content, no sidebar/composer overlap, composer centered within 2 logical units, at least one gutter on each side, no clipped controls, and substantial office remains visible. At compact/high-scale state: use a rail and menu reflow, not illegible text. Inspect actual screenshots at all cases in `contracts/verification-cases.json`.
