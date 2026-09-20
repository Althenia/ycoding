## R6-04 native capture: a hard review and an ordinary one, in the real drawer.
##
## Drives the REAL `res://app/main.tscn` scene, so the drawer, its attention cards and the
## controls it builds are the production ones.
##
## Two requests are placed on the same session, in the exact shape the wire delivers:
##
##   * a HARD guardrail review (`hardReview: true`), which may be approved ONCE or rejected
##   * an ORDINARY guardrail review, which also offers the session-wide approval
##
## The contrast is the point: the same control surface shows different answers because the
## runtime said so, not because the UI guessed. Both cards' controls are read back from the
## drawer, so the report is about what a user can actually press.
##
## Kit-local; no repository source depends on it.
##
## Run:
##   godot --path apps/office --resolution 1280x720 \
##     --script res://r6_04_capture_tmp.gd -- <outdir>
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
	_outdir = str(args[0]) if args.size() > 0 else "/tmp/r6-04"
	DirAccess.make_dir_recursive_absolute(_outdir)
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)
	print("R604 start outdir=", _outdir)


func _process(_delta: float) -> bool:
	if _done or _scene == null:
		return true
	if not DemoCapture.started(_scene):
		_waited += 1
		var failure := DemoCapture.failure(_scene)
		if not failure.is_empty():
			print("R604 blocked: ", failure)
			quit(2)
			return true
		if _waited > 900:
			print("R604 blocked: demo never started")
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
		{"call": "_capture"},
	]


## One hard review and one ordinary review on the same session.
func _seed() -> void:
	_scene.store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_r604",
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-capture",
	})
	_review("grq_r604_hard", true, "this removes files")
	_review("grq_r604_ordinary", false, "this writes a file")
	print("R604 seeded one HARD review and one ORDINARY review")


func _review(request_id: String, hard: bool, reason: String) -> void:
	var request := {
		"id": request_id, "sessionID": "ses_r604", "rootSessionID": "ses_r604",
		"action": "shell", "resources": ["rm -rf build"],
		"ruleIDs": ["rule-1"], "reason": reason, "standard": false,
	}
	if hard:
		request["hardReview"] = true
	_scene.store.apply({
		"type": Wire.GUARDRAIL_ASKED, "sessionID": "ses_r604",
		"data": request, "sourceEpoch": "epoch-capture",
	})


func _show() -> void:
	_scene.store.select_actor("ses_r604")
	_scene.conversation_panel.show_actor(_scene.store, "ses_r604", "")
	_scene._refresh_ui()
	# What the QUEUE will accept for each request, which is the rule the controls follow.
	for request_id in ["grq_r604_hard", "grq_r604_ordinary"]:
		var request: Dictionary = {}
		for entry in _scene.store.attention.pending():
			if str(entry["id"]) == request_id:
				request = entry
		var shape := AttentionQueue.reply_shape(request)
		print("R604 %s offers=%s hard=%s" % [
			request_id, str(shape.get("allowed", [])),
			str(AttentionQueue.is_hard_review(request)),
		])
	# And what the drawer actually built, read back from its own controls.
	print("R604 drawer text='%s'" % _drawer_text(_scene.conversation_panel).replace("\n", " | "))
	print("R604 buttons=%s" % str(_button_labels(_scene.conversation_panel)))


## Every button the drawer built, so the offered choices are read from the UI rather than the
## rule that produced them.
func _button_labels(panel) -> Array:
	var out: Array = []
	var pending: Array[Node] = [panel]
	while not pending.is_empty():
		var node: Node = pending.pop_back()
		if node is Button and not (node as Button).text.strip_edges().is_empty():
			out.append((node as Button).text)
		for child in node.get_children():
			pending.append(child)
	return out


func _drawer_text(panel) -> String:
	var out := ""
	for node in panel._attention_box.get_children():
		out += _label_text(node) + "\n"
	return out.strip_edges()


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
		print("R604 no texture to capture")
		quit(1)
		return
	var image := texture.get_image()
	if image == null:
		print("R604 no image to capture")
		quit(1)
		return
	var path := "%s/r6-04-hard-review.png" % _outdir
	image.save_png(path)
	print("R604 captured ", path)


func _finish() -> void:
	_done = true
	print("R604 done")
	if _scene.live != null:
		_scene.live.stop()
	quit(0)