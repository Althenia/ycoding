## R5-06 native capture: a blocked project is answerable from a page that is not the office.
##
## Drives the REAL `res://app/main.tscn` scene, so the panels, layout and route owner are the
## production ones. The one prepared thing is the request itself: a pending human-attention
## request is durable server state, and a driver cannot make a live service block on demand,
## so the request is placed in the queue in the exact shape the wire delivers
## (kind, request id, owning session id, data).
##
## Sequence, all in the real scene:
##   1. a CHILD session is blocked on a permission request
##   2. the PARENT is selected - the drawer shows the family, so the child's request must
##      be answerable there, and must name the child
##   3. the user moves to the Statistics page - the request must STAY answerable
##   4. the drawer's own stop must name the session the drawer shows, not the selection
##
## Each step prints what the drawer actually renders, read back from the panel rather than
## from the values the driver wrote, so the state and the capture are bound together.
##
## Kit-local; no repository source depends on it.
##
## Run:
##   godot --path apps/office --resolution 1280x720 \
##     --script res://r5_06_capture_tmp.gd -- <outdir>
extends SceneTree

const DemoCapture := preload("res://tools/demo_capture.gd")

const SETTLE_FRAMES := 4

var _outdir := ""
var _scene: Node = null
var _waited := 0
var _settle := 0
var _step := 0
var _done := false


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	_outdir = str(args[0]) if args.size() > 0 else "/tmp/r5-06"
	DirAccess.make_dir_recursive_absolute(_outdir)
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)
	print("R506 start outdir=", _outdir)


func _process(_delta: float) -> bool:
	if _done or _scene == null:
		return true
	if not DemoCapture.started(_scene):
		_waited += 1
		var failure := DemoCapture.failure(_scene)
		if not failure.is_empty():
			print("R506 blocked: ", failure)
			quit(2)
			return true
		if _waited > 900:
			print("R506 blocked: demo never started")
			quit(2)
			return true
		return false
	_waited += 1
	if _waited < 5:
		return false
	if _settle > 0:
		_settle -= 1
		return false
	_advance()
	return false


func _advance() -> void:
	if _step >= _steps().size():
		_finish()
		return
	var step: Dictionary = _steps()[_step]
	_step += 1
	callv(str(step["call"]), step.get("args", []))
	_settle = SETTLE_FRAMES


func _steps() -> Array:
	return [
		{"call": "_seed"},
		{"call": "_show_family"},
		{"call": "_capture", "args": ["r5-06-family-attention.png"]},
		{"call": "_leave_the_office"},
		{"call": "_capture", "args": ["r5-06-answerable-on-statistics.png"]},
		{"call": "_report_stop"},
	]


## A parent with a delegated child, and the child blocked on a permission request.
func _seed() -> void:
	_scene.store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_r506_parent",
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-capture",
	})
	_scene.store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_r506_child",
		"data": {"agent": "lead", "title": "Child", "parentID": "ses_r506_parent"},
		"sourceEpoch": "epoch-capture",
	})
	_scene.store.attention.push(
		AttentionQueue.KIND_PERMISSION, "req_r506_child", "ses_r506_child",
		{"summary": "the child wants to run a shell command"}
	)
	print("R506 seeded: parent + child, child blocked on a permission request")


## The parent selected: the drawer speaks for the family, so the child's request is here.
func _show_family() -> void:
	_scene.store.select_actor("ses_r506_parent")
	_scene.conversation_panel.show_actor(_scene.store, "ses_r506_parent", "")
	_read_back("parent selected")


## The user goes to another page. The request must not disappear with the office.
func _leave_the_office() -> void:
	_scene._on_route_requested(OfficeRoute.STATISTICS)
	_read_back("statistics route")


func _read_back(label: String) -> void:
	var panel = _scene.conversation_panel
	print("R506 %s: route='%s' drawer_visible=%s cards=%d" % [
		label, _scene.router.route(), str(panel.visible),
		panel._attention_box.get_child_count(),
	])
	print("R506 %s: drawer_text='%s'" % [label, _drawer_text(panel).replace("\n", " | ")])
	print("R506 %s: stop_enabled=%s stop_reason='%s'" % [
		label, str(not panel._stop.disabled), panel._stop.tooltip_text,
	])


## What the drawer actually renders, so the report is about what a user can read.
func _drawer_text(panel) -> String:
	var text := ""
	for node in panel._attention_box.get_children():
		text += _label_text(node) + "\n"
	return text.strip_edges()


func _label_text(node: Node) -> String:
	var out := ""
	if node is Label:
		out += (node as Label).text
	for child in node.get_children():
		out += _label_text(child)
	return out


## The stop clause: the control must name the session the DRAWER shows, not the selection.
func _report_stop() -> void:
	var panel = _scene.conversation_panel
	var asked: Array[String] = []
	panel.stop_requested.connect(func(session_id: String) -> void: asked.append(session_id))
	panel._stop.pressed.emit()
	print("R506 stop asked for=%s while the selection is '%s'" % [
		str(asked), _scene._prompt_target(),
	])


func _capture(capture_path: String = "") -> void:
	var texture := root.get_texture()
	if texture == null:
		print("R506 no texture to capture")
		quit(1)
		return
	var image := texture.get_image()
	if image == null:
		print("R506 no image to capture")
		quit(1)
		return
	var path := "%s/%s" % [_outdir, capture_path if not capture_path.is_empty() else "r5-06-capture.png"]
	image.save_png(path)
	print("R506 captured ", path)


func _finish() -> void:
	_done = true
	print("R506 done")
	if _scene.live != null:
		_scene.live.stop()
	quit(0)
