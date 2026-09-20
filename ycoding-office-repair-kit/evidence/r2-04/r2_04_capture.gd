## R2-04 native capture: the route navigation rows in the real shell.
##
## Drives the REAL `res://app/main.tscn` scene, enters DEMO (so the office is
## populated and the rail is fully built), then steps through the routes ONE STEP
## PER FRAME, capturing after each settle.
##
## One step per frame is the point, not a style choice: the renderer only paints on
## a frame, and doing every switch inside a single `_process` call produced three
## BYTE-IDENTICAL images, which proves nothing about routing. Spreading the steps
## across frames lets the surface actually change before it is captured.
##
## Each capture prints the route, the world's visibility and which rail row is
## marked, so the image and the state it shows are bound together in the log.
##
## Kit-local; no repository source depends on it.
##
## Run:
##   godot --path apps/office --resolution 1280x720 \
##     --script res://r2_04_capture_tmp.gd -- <outdir>
extends SceneTree

const DemoCapture := preload("res://tools/demo_capture.gd")

## Frames to let the renderer settle after a state change before capturing.
const SETTLE_FRAMES := 4

var _outdir := ""
var _scene: Node = null
var _waited := 0
var _step := 0
var _settle := 0
var _captured := 0


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	_outdir = str(args[0]) if args.size() > 0 else "/tmp/r2-04-captures"
	DirAccess.make_dir_recursive_absolute(_outdir)
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)
	print("R204 start outdir=", _outdir)


func _process(_delta: float) -> bool:
	if _scene == null:
		return true
	if not DemoCapture.started(_scene):
		_waited += 1
		var failure := DemoCapture.failure(_scene)
		if not failure.is_empty():
			print("R204 blocked: ", failure)
			quit(2)
			return true
		if _waited > 900:
			print("R204 blocked: demo never started")
			quit(2)
			return true
		return false

	# Let the scene run a few frames after demo starts, so the rail is fully drawn.
	_waited += 1
	if _waited < 5:
		return false

	# One step per frame. A settle counter gates each capture, so every image is of
	# a frame the renderer has actually painted in the state being asserted.
	if _settle > 0:
		_settle -= 1
		if _settle == 0:
			_do_step()
		return false

	if _step > _steps().size():
		return _finish()
	_advance()
	return false


## The ordered steps: the initial route, then a switch per other route, then back.
func _steps() -> Array[String]:
	var out: Array[String] = []
	for route in OfficeRoute.ALL:
		out.append(route)
	out.append(OfficeRoute.OFFICE)
	return out


func _advance() -> void:
	var steps := _steps()
	var name := steps[_step]
	if _captured > 0:
		# Route through the RAIL'S OWN signal, exactly as a user click would, rather
		# than calling the router directly, so the real path is exercised.
		if _scene.sidebar._route_buttons.has(name):
			(_scene.sidebar._route_buttons[name] as Button).pressed.emit()
	_settle = SETTLE_FRAMES
	_step += 1


func _do_step() -> void:
	var steps := _steps()
	var name := steps[_step - 1]
	_capture(name)
	if _step >= steps.size():
		_settle = -1


func _finish() -> bool:
	print("R204 returned route=", _scene.router.route(),
		" shows_world=", _scene.router.shows_world(),
		" captured=", _captured)
	if _scene.live != null:
		_scene.live.stop()
	print("R204 done")
	quit(0)
	return true


func _capture(name: String) -> void:
	var texture := root.get_texture()
	if texture == null:
		print("R204 no texture to capture for ", name)
		return
	var image := texture.get_image()
	if image == null:
		print("R204 no image for ", name)
		return
	image.save_png("%s/r2-04-%s.png" % [_outdir, name])
	_captured += 1
	# Which rail row is marked, read from the real buttons.
	var marked := ""
	for route in OfficeRoute.ALL:
		if _scene.sidebar._route_buttons.has(route):
			var button: Button = _scene.sidebar._route_buttons[route]
			if button.text.contains(SidebarPanel.MARK_SELECTED):
				marked = route
	print("R204 captured %s route=%s world_visible=%s marked_row=%s" % [
		name, _scene.router.route(), _scene.office_view.visible, marked,
	])
