# Walkable user avatar

Status: approved feature; not an agent and not an execution primitive.

The user has a distinct avatar labelled **You**. Default movement is WASD or arrow keys while the office owns keyboard focus. Four-direction sprite animation, normalized diagonal speed, collision with walls/furniture, safe spawn, camera follow and an optional click-to-walk action make the office explorable. E near an employee opens its real inspector/conversation; E near a workstation opens the corresponding supported view. Walking, approaching an employee, or crossing a doorway never launches work, sends a message, grants approval or changes project filesystem scope.

## Input contract

Register remappable `player_left/right/up/down`, `interact`, `focus_composer`, `camera_recenter`, `camera_pan` and `click_to_walk` actions. Proposed defaults: WASD/arrows move; E interacts; Cmd/Ctrl+L focuses composer; middle-drag or Space+drag pans when world-focused; Home recentres; wheel zoom is confined to the world. Remove the old unmodified WASD/arrow camera bindings; migration must not retain both consumers. Keep application shortcuts in the current registry, not scattered per scene.

Route GUI events first. Use `_unhandled_input` for discrete world actions, but **do not assume it gates `Input.is_action_pressed`**. Physics polling reads global key state even when a text control consumed the event. A central `can_move`/input-context gate must require: window focused, Office route active, world focus, no modal/menu, no IME composition, no TextEdit/LineEdit/editor/terminal field focused and no pending focus release. Clear stored input/velocity on context changes; suppress held keys until released after a modal closes. Dropdown navigation must not walk the player. Alt combinations remain available for text entry. Escape dismisses the innermost popup/focus first; never quits or silently stops work.

## Godot boundary

Add a scoped PlayerActor scene to the existing world, normally CharacterBody2D + collision shape + AnimatedSprite2D + interaction Area2D. Reuse the map's navigation blockers, sprite scaling, palette and Y-sort. Normalized velocity and `move_and_slide()` handle continuous movement; use existing path navigation for click-to-walk, canceled by manual input. Never let a stuck player permanently block NPC work anchors: NPC interactions use reservations and soft/nonblocking player avoidance or a safe bounded repath. Player movement stays cosmetic to YCoding.

Follow camera is separate from the UI scale. Manual pan suspends follow until Recenter. The camera's usable area excludes the sidebar and honors composer/attention safe zones. Reduced motion removes camera easing, bob and exaggerated transitions but leaves direct avatar movement and essential feedback usable. Optional hide-player/overview mode makes walking unnecessary for all core workflows. Per-project player/camera state is saved on project switch; leaving the Office route stops movement while runtime subscriptions continue.

## Acceptance

Typing `wasd`, arrows, E and Space in every text input causes zero movement. Held-key focus loss does not drift. Keyboard remapping persists and detects collisions with mandatory copy/paste/send/escape shortcuts. Mouse click/drag on UI never routes world movement. Walls/chairs/doorways block correctly; player and agent depth is correct; no actors trap each other. Interaction opens the right session. 30/60/120 fps produce equivalent movement distance; diagonal speed matches cardinal speed. Verify dark/light, 100–200% UI text scale, small windows, camera bounds, reduced motion, project switch and missing spawn recovery in native Godot footage.
