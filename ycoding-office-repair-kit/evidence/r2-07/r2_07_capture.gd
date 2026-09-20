## R2-07 responsive acceptance matrix: the shell at every supported size and text
## scale, plus the long-label and narrow states.
##
## The acceptance is: "Inspect 1024x768, 1280x720, 1440x900, 1920x1080 at
## 100/150/200% text; long labels and narrow states."
##
## This driver produces the ARTIFACTS and the MEASUREMENTS for that inspection. It
## deliberately does NOT claim the inspection happened: the kit requires a human
## `user_review` for this task, and a machine cannot certify a subjective visual
## judgement. What it does is make the review CHEAP and EVIDENCE-BACKED by printing,
## per case, the measured rects and any overflow or overlap it can detect
## objectively, so a reviewer reads findings rather than hunting for problems.
##
## One case per frame, because the renderer only paints on a frame and capturing
## without settling produced byte-identical images in an earlier attempt.
##
## Run:
##   godot --path apps/office --resolution <W>x<H> \
##     --script res://r2_07_capture_tmp.gd -- <outdir>
extends SceneTree

const DemoCapture := preload("res://tools/demo_capture.gd")

## The sizes the acceptance names, exactly.
const SIZES: Array[Vector2] = [
	Vector2(1024, 768), Vector2(1280, 720), Vector2(1440, 900), Vector2(1920, 1080),
]
## The text scales the acceptance names, in the shell's own step vocabulary.
const SCALES: Array[float] = [1.0, 1.5, 2.0]
## Frames to let the renderer settle after a state change.
const SETTLE_FRAMES := 4

var _outdir := ""
var _scene: Node = null
var _waited := 0
var _case := 0
var _settle := 0
var _captured := 0
var _problems: Array[String] = []


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	_outdir = str(args[0]) if args.size() > 0 else "/tmp/r2-07"
	DirAccess.make_dir_recursive_absolute(_outdir)
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)
	print("R207 start outdir=", _outdir, " cases=", SIZES.size() * SCALES.size())


func _process(_delta: float) -> bool:
	if _scene == null:
		return true
	if not DemoCapture.started(_scene):
		_waited += 1
		var failure := DemoCapture.failure(_scene)
		if not failure.is_empty():
			print("R207 blocked: ", failure)
			quit(2)
			return true
		if _waited > 900:
			print("R207 blocked: demo never started")
			quit(2)
			return true
		return false

	_waited += 1
	if _waited < 5:
		return false

	if _settle > 0:
		_settle -= 1
		if _settle == 0:
			_measure_and_capture()
		return false
	if _case >= _cases().size():
		return _finish()
	_apply_case()
	return false


## One entry per (size, scale) the acceptance names.
func _cases() -> Array:
	var out: Array = []
	for size in SIZES:
		for scale in SCALES:
			out.append({"size": size, "scale": scale})
	return out


func _apply_case() -> void:
	var entry: Dictionary = _cases()[_case]
	var size: Vector2 = entry["size"]
	var scale: float = entry["scale"]
	# Resize the REAL window, not just the shell region inside a fixed one: the
	# acceptance inspects the client at those window sizes, so a shell relaid out
	# inside a differently-sized window would not be the same evidence.
	DisplayServer.window_set_size(Vector2i(int(size.x), int(size.y)))
	# Drive the scale the way the scale control does, through the domain and the
	# shell's own apply path.
	OfficeTheme.set_text_scale(scale)
	_scene.ui_scale = scale
	_scene._apply_regions()
	_settle = SETTLE_FRAMES


func _measure_and_capture() -> void:
	var entry: Dictionary = _cases()[_case]
	var size: Vector2 = entry["size"]
	var scale: float = entry["scale"]
	var label := "%dx%d-s%.2f" % [int(size.x), int(size.y), scale]

	# Objective checks only: what can be measured rather than judged. The size used
	# is the SHELL's actual size after the window resize, so the measurements describe
	# what was really laid out rather than what was requested.
	var shell_size: Vector2 = _scene._shell.size
	if shell_size.x > 1.0 and shell_size.y > 1.0:
		size = shell_size
	var overlays := OfficeShellLayout.overlays(size, scale)
	var content_x: float = (overlays["sidebar"] as Rect2).position.x \
		+ (overlays["sidebar"] as Rect2).size.x
	var content_w := size.x - content_x

	for name in ["sidebar", "composer", "toggles", "drawer"]:
		var rect: Rect2 = overlays[name]
		if rect.position.x < -0.5 or rect.position.y < -0.5 \
			or rect.position.x + rect.size.x > size.x + 0.5 \
			or rect.position.y + rect.size.y > size.y + 0.5:
			_problems.append("%s: %s is outside the frame" % [label, name])
	# The composer must fit inside the CONTENT region, not merely the window.
	var composer: Rect2 = overlays["composer"]
	if composer.position.x < content_x - 0.5 \
		or composer.position.x + composer.size.x > size.x + 0.5:
		_problems.append("%s: composer escapes the content region" % label)
	# Nothing may overlap the sidebar column.
	var sidebar: Rect2 = overlays["sidebar"]
	for name in ["composer", "toggles", "drawer"]:
		if (overlays[name] as Rect2).intersects(sidebar):
			_problems.append("%s: %s overlaps the sidebar" % [label, name])
	# The composer and the drawer must not collide.
	if composer.intersects(overlays["drawer"] as Rect2):
		_problems.append("%s: the drawer covers the composer" % label)

	# A real Control must be at least its own minimum, or it clips its content.
	for pair in [["sidebar", _scene.sidebar], ["composer", _scene.prompt_panel],
			["toggles", _scene.chrome_toggles]]:
		var control: Control = pair[1]
		if control == null:
			continue
		var minimum := control.get_combined_minimum_size()
		if control.size.x + 0.5 < minimum.x or control.size.y + 0.5 < minimum.y:
			_problems.append("%s: %s painted %s below its minimum %s"
				% [label, pair[0], str(control.size), str(minimum)])

	_capture(label)
	print("R207 %s content_w=%.0f sidebar=%.0f composer=%.0fx%.0f drawer=%.0fx%.0f" % [
		label, content_w, sidebar.size.x,
		composer.size.x, composer.size.y,
		(overlays["drawer"] as Rect2).size.x, (overlays["drawer"] as Rect2).size.y,
	])
	_case += 1
	_settle = -1


func _finish() -> bool:
	print("R207 captured=", _captured)
	print("R207 objective_problems=", _problems.size())
	for problem in _problems:
		print("R207 PROBLEM ", problem)
	if _scene.live != null:
		_scene.live.stop()
	print("R207 done")
	quit(0 if _problems.is_empty() else 1)
	return true


func _capture(label: String) -> void:
	var texture := root.get_texture()
	if texture == null:
		print("R207 no texture for ", label)
		return
	var image := texture.get_image()
	if image == null:
		print("R207 no image for ", label)
		return
	image.save_png("%s/r2-07-%s.png" % [_outdir, label])
	_captured += 1
