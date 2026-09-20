## Kit lane-V native evidence driver (lives in the repair kit, not the repository).
##
## Boots the real main scene, drives demo playback deterministically to a target
## playback time through the scene's own handlers, prints the per-actor canonical
## state (work state label, presence, activity, tool names the store learned), then
## writes a PNG of the rendered frame — same two-stage shape as
## apps/office/tools/capture_scene.gd.
##
##   godot --path apps/office --resolution 1280x720 \
##     --script /abs/kit/tools/capture_classified_state.gd -- --out=<abs> --at-ms=56000
extends SceneTree

const DemoCapture := preload("res://tools/demo_capture.gd")
const STEP_MS := 250

var _scene: Node
var _elapsed := 0
var _at_ms := 56000
var _out := "user://classified_capture.png"
var _stage := 0


func _initialize() -> void:
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--out="):
			_out = argument.substr("--out=".length())
		elif argument.begins_with("--at-ms="):
			_at_ms = int(argument.substr("--at-ms=".length()))
	var packed := load("res://app/main.tscn")
	if packed == null:
		push_error("lane-v: main scene failed to load")
		quit(1)
		return
	_scene = packed.instantiate()
	root.add_child(_scene)


func _advance_to_target() -> void:
	while _elapsed < _at_ms:
		_elapsed += STEP_MS
		_scene.demo.advance(STEP_MS)
		if _elapsed % 6000 == 0:
			_scene._tick_ambient()


func _process(_delta: float) -> bool:
	if not DemoCapture.started(_scene):
		var reason := DemoCapture.failure(_scene)
		if not reason.is_empty():
			push_error("lane-v: demo did not start: %s" % reason)
			quit(1)
			return true
		return false
	if _stage == 0:
		_advance_to_target()
		print("lane-v: reached %d ms of playback" % _elapsed)
		_stage = 1
		return false
	if _stage == 1:
		_stage = 2
		return false
	_report()
	var image := root.get_texture().get_image()
	var absolute := _out if _out.is_absolute_path() else ProjectSettings.globalize_path(_out)
	var error := image.save_png(absolute)
	if error != OK:
		push_error("lane-v: failed to write %s (error %d)" % [absolute, error])
		quit(1)
		return true
	print("lane-v: wrote %s (%dx%d)" % [absolute, image.get_width(), image.get_height()])
	quit(0)
	return true


func _report() -> void:
	if _scene.store == null:
		return
	print(
		"lane-v: actors=%d interactions=%d mode=%s conn=%s"
		% [
			_scene.store.actors.size(),
			_scene.store.interactions.size(),
			_scene.store.mode,
			_scene.store.connection_state,
		]
	)
	print("lane-v: viewport=%s" % [_scene.get_viewport().get_visible_rect().size])
	print("lane-v: learned tool names=%s" % [_scene.store._tool_names])
	for actor in _scene.store.actor_list():
		var node = _scene.office_view.world.actors.get(actor.identity.session_id)
		print(
			"lane-v: actor=%s agent=%s work_state=%d(%s) presence=%s activity=%s settled=%s glyph=%s pos=%s walking=%s"
			% [
				actor.identity.session_id,
				actor.identity.agent_id,
				actor.work_state,
				WorkState.label(actor.work_state),
				actor.presence,
				actor.activity_label,
				actor.settled_status if not actor.settled_status.is_empty() else "-",
				WorkState.glyph(actor.work_state),
				node.position if node != null else Vector2.ZERO,
				node.is_walking() if node != null else "no-node",
			]
		)