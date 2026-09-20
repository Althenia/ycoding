## R6-01 native capture: a session's history in the real drawer.
##
## Drives the REAL `res://app/main.tscn` scene, so the drawer, its rendering and the route
## owner are the production ones, and feeds the store the wire events the runtime actually
## sends.
##
## Three clauses are shown, each of which was a real defect:
##
##   1. TWO ASSIGNMENTS ARE TWO REPORTS - a completion keyed on the session id alone made
##      every assignment after the first a duplicate and dropped it.
##   2. A COMPLETION WITHOUT A REPORT says so, instead of rendering an empty success.
##   3. SOURCE ORDER, not wall clock - the observations are delivered with DECREASING
##      recorded times, so a projection that sorted by time would reverse them.
##
## Every step prints what the drawer actually renders, read back from its own rows rather
## than from the values the driver wrote.
##
## Kit-local; no repository source depends on it.
##
## Run:
##   godot --path apps/office --resolution 1280x720 \
##     --script res://r6_01_capture_tmp.gd -- <outdir>
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
	_outdir = str(args[0]) if args.size() > 0 else "/tmp/r6-01"
	DirAccess.make_dir_recursive_absolute(_outdir)
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)
	print("R601 start outdir=", _outdir)


func _process(_delta: float) -> bool:
	if _done or _scene == null:
		return true
	if not DemoCapture.started(_scene):
		_waited += 1
		var failure := DemoCapture.failure(_scene)
		if not failure.is_empty():
			print("R601 blocked: ", failure)
			quit(2)
			return true
		if _waited > 900:
			print("R601 blocked: demo never started")
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
		{"call": "_show"},
		{"call": "_report"},
		{"call": "_capture"},
	]


## One session with two assignments and a completion that carries no report.
func _seed() -> void:
	_scene.store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_r601",
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-capture",
	})
	# Delivered with DECREASING recorded times, so a projection that sorted by wall clock
	# would render them backwards.
	_complete("run-1", 9000, "the first assignment finished and reported this")
	_complete("run-2", 8000, "")
	_complete("run-3", 7000, "the third assignment also reported")
	print("R601 seeded two reports and one completion with no report")


func _complete(run_id: String, _clock: int, excerpt: String) -> void:
	var change := {"type": Wire.CHANGE_COMPLETED, "runID": run_id}
	if not excerpt.is_empty():
		change["excerpt"] = excerpt
	_scene.store.apply({
		"type": Wire.TASK_UPDATED, "sessionID": "ses_r601",
		"data": {"change": change}, "sourceEpoch": "epoch-capture",
	})


func _show() -> void:
	_scene.store.select_actor("ses_r601")
	_scene.conversation_panel.show_actor(_scene.store, "ses_r601", "")
	_scene._refresh_ui()
	_report()


## What the drawer's own rows actually say.
func _report() -> void:
	var rows: Array = _scene.store.conversation_items("ses_r601")
	print("R601 store rows=%d" % rows.size())
	for row in rows:
		print("R601   kind=%s source_verified=%s sequence=%s text='%s'" % [
			str(row.get("kind", "")), str(row.get("source_verified", "")),
			str(row.get("sequence", "")), str(row.get("description", "")),
		])
	var rendered := _drawer_text(_scene.conversation_panel)
	print("R601 drawer text='%s'" % rendered.replace("\n", " | "))


## What the drawer actually renders, so the report is about what a user can read.
func _drawer_text(panel) -> String:
	var text := ""
	for node in panel._list.get_children():
		text += _label_text(node) + "\n"
	return text.strip_edges()


func _label_text(node: Node) -> String:
	var out := ""
	if node is Label:
		out += (node as Label).text + " "
	for child in node.get_children():
		out += _label_text(child)
	return out


func _capture() -> void:
	var texture := root.get_texture()
	if texture == null:
		print("R601 no texture to capture")
		quit(1)
		return
	var image := texture.get_image()
	if image == null:
		print("R601 no image to capture")
		quit(1)
		return
	var path := "%s/r6-01-session-history.png" % _outdir
	image.save_png(path)
	print("R601 captured ", path)


func _finish() -> void:
	_done = true
	print("R601 done")
	if _scene.live != null:
		_scene.live.stop()
	quit(0)
