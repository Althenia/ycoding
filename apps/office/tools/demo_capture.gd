## Shared DEMO opt-in for developer capture harnesses.
##
## Production boot no longer implies DEMO, so a harness must ask for it. This
## waits until `_ready` has built the scene, then calls the composition root's
## public `start_demo_mode()`. A scene already playing is adopted as-is, so the
## same harness works both before and after the boot default is removed.
##
## It deliberately does NOT touch `capture_mode`: each harness keeps its own
## existing clock handling so captured output is unchanged.
##
## Developer harness only: nothing under `app/` or `ui/` loads this script, and a
## normal launch runs `res://app/main.tscn` with no tool script attached.
extends RefCounted

## Bounded so a fixture that never loads fails the run instead of hanging it.
const MAX_WAIT_FRAMES := 600

static var _waited_frames := 0


## True once the scene is built and demo playback is running. Safe to call every
## frame until it returns true; call `failure` to distinguish waiting from error.
static func started(scene: Node) -> bool:
	if scene == null or scene.demo == null or scene.store == null:
		return false
	if not scene.demo.is_playing():
		scene.start_demo_mode()
	if not scene.demo.is_playing():
		_waited_frames += 1
		return false
	return true


## A non-empty reason once the demo failed to start; "" while still waiting.
static func failure(scene: Node) -> String:
	if scene != null and scene.demo != null and scene.demo.is_playing():
		return ""
	if scene != null and scene.store != null and not scene.store.last_error.is_empty():
		return scene.store.last_error
	if _waited_frames >= MAX_WAIT_FRAMES:
		return "demo did not start within %d frames" % MAX_WAIT_FRAMES
	return ""
