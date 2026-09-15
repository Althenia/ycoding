## Scene boot capture.
##
## Boots the real main scene, drives the demo clock deterministically to a target
## playback time, then writes a PNG of the rendered frame. Time-based rather than
## frame-based, because frame count is not playback time on uncapped runs.
##
##   "$GODOT_BIN" --path apps/office --resolution 1280x720 \
##     --script res://tools/capture_scene.gd -- --out=<abs path> --at-ms=35000
extends SceneTree

const STEP_MS := 250

var _scene: Node
var _elapsed := 0
var _at_ms := 35000
var _out := "user://office_capture.png"
var _stage := 0


func _initialize() -> void:
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--out="):
			_out = argument.substr("--out=".length())
		elif argument.begins_with("--at-ms="):
			_at_ms = int(argument.substr("--at-ms=".length()))
		elif argument.begins_with("--frames="):
			# Backwards-compatible alias: treat frames as 60fps milliseconds.
			_at_ms = int(argument.substr("--frames=".length())) * 1000 / 60
	var packed := load("res://app/main.tscn")
	if packed == null:
		push_error("capture: main scene failed to load")
		quit(1)
		return
	_scene = packed.instantiate()
	root.add_child(_scene)


## Step the demo through the scene's own handler so the production cascade runs.
## Deferred to the first frame because `_ready` has not run during `_initialize`.
func _advance_to_target() -> void:
	while _elapsed < _at_ms:
		_elapsed += STEP_MS
		_scene.demo.advance(STEP_MS)
		if _elapsed % 6000 == 0:
			_scene._tick_ambient()


func _process(_delta: float) -> bool:
	if _stage == 0:
		_advance_to_target()
		print("capture: reached %d ms of playback" % _elapsed)
		_stage = 1
		return false
	if _stage == 1:
		# Give the renderer one frame to present the advanced state.
		_stage = 2
		return false
	if _scene.store != null:
		print(
			"capture: actors=%d interactions=%d mode=%s conn=%s"
			% [
				_scene.store.actors.size(),
				_scene.store.interactions.size(),
				_scene.store.mode,
				_scene.store.connection_state,
			]
		)
		# Report the real viewport/camera numbers so a capture can be reasoned about.
		var viewport: OfficeViewport = _scene.office_view
		var camera: Camera2D = viewport.get_node("SubViewport/OfficeWorld/Camera")
		print(
			"capture: container=%s subviewport=%s camera=%s zoom=%s"
			% [viewport.size, (viewport.get_node("SubViewport") as SubViewport).size, camera.position, camera.zoom]
		)
	var image := root.get_texture().get_image()
	var absolute := _out if _out.is_absolute_path() else ProjectSettings.globalize_path(_out)
	var error := image.save_png(absolute)
	if error != OK:
		push_error("capture: failed to write %s (error %d)" % [absolute, error])
		quit(1)
		return true
	print("capture: wrote %s (%dx%d)" % [absolute, image.get_width(), image.get_height()])
	quit(0)
	return true
