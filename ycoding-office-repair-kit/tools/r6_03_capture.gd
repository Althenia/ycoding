## R6-03 native capture: the inspector in the real drawer.
##
## Drives the REAL `res://app/main.tscn` scene, so the drawer, its header and the family line
## are the production ones, and shows what R6-03 adds:
##
##   * the TASK the assignment is working on
##   * PARENT/CHILD identity, both directions, with sessions named by id because an agent
##     configuration is reusable and two sessions sharing one are two actors
##   * a CLICK-THROUGH from a row to the exact session it came from
##
## Every step prints what the drawer actually renders, read back from its own controls.
##
## Kit-local; no repository source depends on it.
##
## Run:
##   godot --path apps/office --resolution 1280x720 \
##     --script res://r6_03_capture_tmp.gd -- <outdir>
extends SceneTree

const DemoCapture := preload("res://tools/demo_capture.gd")

const SETTLE_FRAMES := 4

var _outdir := ""
var _scene: Node = null
var _waited := 0
var _settle := 0
var _step := 0
var _done := false
var _asked: Array[String] = []


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	_outdir = str(args[0]) if args.size() > 0 else "/tmp/r6-03"
	DirAccess.make_dir_recursive_absolute(_outdir)
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)
	print("R603 start outdir=", _outdir)


func _process(_delta: float) -> bool:
	if _done or _scene == null:
		return true
	if not DemoCapture.started(_scene):
		_waited += 1
		var failure := DemoCapture.failure(_scene)
		if not failure.is_empty():
			print("R603 blocked: ", failure)
			quit(2)
			return true
		if _waited > 900:
			print("R603 blocked: demo never started")
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
		{"call": "_show_child"},
		{"call": "_show_parent"},
		{"call": "_open_source"},
		{"call": "_capture"},
	]


## A parent with a task and two children, so both directions of the family are visible.
func _seed() -> void:
	_scene.store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_r603_p",
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-capture",
	})
	_scene.store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_r603_c1",
		"data": {"agent": "backend", "title": "Backend", "parentID": "ses_r603_p"},
		"sourceEpoch": "epoch-capture",
	})
	_scene.store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_r603_c2",
		"data": {"agent": "backend", "title": "Backend", "parentID": "ses_r603_p"},
		"sourceEpoch": "epoch-capture",
	})
	# The parent is working on a task, and one child was handed work.
	_scene.store.apply({
		"type": Wire.TASK_UPDATED, "sessionID": "ses_r603_p",
		"data": {"change": {
			"type": Wire.CHANGE_LAUNCHED, "inputID": "ses_r603_c1", "parentID": "ses_r603_p",
			"toolCallID": "call_r603", "description": "handed the transcript repair to Backend",
		}},
		"sourceEpoch": "epoch-capture",
	})
	_scene.conversation_panel.open_session_requested.connect(
		func(session_id: String) -> void: _asked.append(session_id)
	)
	print("R603 seeded: one parent, two children sharing one agent configuration")


func _show_child() -> void:
	_scene.conversation_panel.show_actor(_scene.store, "ses_r603_c1", "")
	_report("child selected")


func _show_parent() -> void:
	_scene.conversation_panel.show_actor(_scene.store, "ses_r603_p", "")
	_report("parent selected")


## The click-through: a delegation row opens the CHILD it was handed to.
func _open_source() -> void:
	for item in _scene.conversation_panel._thread_items:
		if str(item.get("kind", "")) == "delegation":
			_scene.conversation_panel._open_source(str(item.get("id", "")))
			break
	print("R603 click-through asked for=%s (expected the child it was handed to)" % str(_asked))


## What the drawer's own controls hold.
func _report(label: String) -> void:
	var panel = _scene.conversation_panel
	print("R603 %s: title='%s'" % [label, _label_text(panel._title)])
	print("R603 %s: subtitle='%s'" % [label, _label_text(panel._subtitle)])
	print("R603 %s: family='%s'" % [label, _label_text(panel._family_text)])


func _label_text(node: Node) -> String:
	if node == null:
		return ""
	var out := ""
	if node is Label:
		out += (node as Label).text
	for child in node.get_children():
		out += _label_text(child)
	return out


func _capture() -> void:
	var texture := root.get_texture()
	if texture == null:
		print("R603 no texture to capture")
		quit(1)
		return
	var image := texture.get_image()
	if image == null:
		print("R603 no image to capture")
		quit(1)
		return
	var path := "%s/r6-03-inspector.png" % _outdir
	image.save_png(path)
	print("R603 captured ", path)


func _finish() -> void:
	_done = true
	print("R603 done")
	if _scene.live != null:
		_scene.live.stop()
	quit(0)
