## R5-03 finding: does the composer stay inside the window at every scale?
##
## The composer floats over the office with its BOTTOM edge fixed. Before the fix the
## layout reserved 116 px for rows that need more, so the engine clamped the placed
## control DOWNWARD past the window and the target line - the thing the composer exists
## to name - was cut off. This measures the placed rect and the panel's own content
## minimum at every text scale and reports both, plus whether the last row is on screen.
##
## Kit-local; no repository source depends on it.
##
## Run:
##   godot --path apps/office --resolution 1280x720 \
##     --script res://r5_03_fit_tmp.gd
extends SceneTree

const DemoCapture := preload("res://tools/demo_capture.gd")

const SIZES := [Vector2(1280, 720), Vector2(1600, 900), Vector2(1920, 1080)]

var _scene: Node = null
var _waited := 0
var _step := 0
var _settle := 0
var _done := false


func _initialize() -> void:
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)
	print("R503F start")


func _process(_delta: float) -> bool:
	if _done:
		return true
	if _scene == null:
		return true
	if not DemoCapture.started(_scene):
		_waited += 1
		if _waited > 900:
			print("R503F blocked: demo never started")
			quit(2)
			return true
		return false
	_waited += 1
	if _waited < 5:
		return false
	if _settle > 0:
		_settle -= 1
		if _settle == 0:
			_measure()
		return false
	if _step >= UiScale.STEPS.size():
		_done = true
		print("R503F done")
		if _scene.live != null:
			_scene.live.stop()
		quit(0)
		return true
	_apply(UiScale.STEPS[_step])
	_step += 1
	_settle = 4
	return false


## Apply one text scale through the production path, so what is measured is what a user
## who presses the text-size control would get - not a value the driver forced.
func _apply(scale: float) -> void:
	_scene._cycle_scale(scale)
	_scene._shell.size = SIZES[0]
	_scene._apply_regions()


func _measure() -> void:
	var panel = _scene.prompt_panel
	var label = panel._target_label
	if label == null:
		print("R503F no target label")
		return
	var needed: float = panel.get_combined_minimum_size().y
	var scale := OfficeTheme.text_scale()
	print("R503F scale=%.2f panel_rect=%s needed_h=%.1f window_h=%.1f" % [
		scale, str(Rect2(panel.global_position, panel.size)), needed, root.size.y,
	])
	for size: Vector2 in SIZES:
		_scene._shell.size = size
		_scene._apply_regions()
		# Re-read after the placement, because the placement is what is under test.
		var placed := Rect2(panel.global_position, panel.size)
		var row := Rect2(label.global_position, label.size)
		print("R503F   size=%s placed_bottom=%.1f inside_window=%s row_bottom=%.1f row_on_screen=%s row_name='%s'" % [
			str(size), placed.end.y, str(placed.end.y <= size.y + 0.5),
			row.end.y, str(row.end.y <= size.y + 0.5), label.text,
		])
