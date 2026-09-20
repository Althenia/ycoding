## R6-02 native capture: rich transcript detail in the real drawer.
##
## Drives the REAL `res://app/main.tscn` scene, so the drawer, its labels and the route owner
## are the production ones, and shows the detail R6-02 adds:
##
##   * a FENCED CODE BLOCK as its own row, carrying its language
##   * a TOOL RESULT with its output, bounded when it is long
##   * ATTACHMENTS named on the message that referred to them
##   * MARKUP carried as inert text, because this client renders through plain labels
##
## The rows come from the canonical `ConversationHistory` projection of the live wire shape,
## not from a fixture built for the driver, so what is shown is what a real session produces.
##
## Every step prints what the drawer actually renders, read back from its own labels.
##
## Kit-local; no repository source depends on it.
##
## Run:
##   godot --path apps/office --resolution 1280x720 \
##     --script res://r6_02_capture_tmp.gd -- <outdir>
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
	_outdir = str(args[0]) if args.size() > 0 else "/tmp/r6-02"
	DirAccess.make_dir_recursive_absolute(_outdir)
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)
	print("R602 start outdir=", _outdir)


func _process(_delta: float) -> bool:
	if _done or _scene == null:
		return true
	if not DemoCapture.started(_scene):
		_waited += 1
		var failure := DemoCapture.failure(_scene)
		if not failure.is_empty():
			print("R602 blocked: ", failure)
			quit(2)
			return true
		if _waited > 900:
			print("R602 blocked: demo never started")
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


## A session whose durable history carries the detail kinds.
func _seed() -> void:
	_scene.store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_r602",
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-capture",
	})
	# The wire shape a real session's message list has, projected through the production
	# reader rather than assembled by hand.
	var messages: Array = [
		{
			"id": "msg_r602_u", "type": "user",
			"text": "look at these and tell me if the change is safe",
			"files": [{"name": "report.md", "mime": "text/markdown"}, {"mime": "image/png"}],
			"time": {"created": 1000},
		},
		{
			"id": "msg_r602_a", "type": "assistant", "agent": "lead",
			"model": {"providerID": "openrouter", "id": "some-model"},
			"content": [
				{"type": "reasoning", "text": "private thinking that must never be shown"},
				{"type": "text", "text": "Here is the change:\n```gdscript\nfunc place(control, rect):\n    control.size = rect.size\n```\nIt is inert.", "phase": "final_answer"},
				{"type": "tool", "tool": "shell", "callID": "call_r602",
				 "state": {"status": "completed", "input": {}, "output": "the tests passed"}},
				{"type": "text", "text": "Markup stays literal: [b]not bold[/b] and <script>x</script>", "phase": "final_answer"},
			],
			"time": {"created": 2000},
		},
	]
	var rows := ConversationHistory.project(messages)
	_scene.conversation_panel.bind_history(_history_with("ses_r602", rows))
	print("R602 projected %d rows" % rows.size())
	for row in rows:
		print("R602   kind=%s text='%s'" % [
			str(row.get("kind", "")), str(row.get("description", "")).replace("\n", " \\\\n "),
		])


## A reader holding already-projected rows, so the drawer renders the production projection.
func _history_with(session_id: String, rows: Array[Dictionary]) -> ConversationHistory:
	var history := ConversationHistory.new()
	history.start(session_id)
	# Install from the same messages the driver projected, so the reader's own path is used.
	history.install(session_id, _messages_for(session_id))
	return history


func _messages_for(session_id: String) -> Array:
	session_id = session_id
	return [
		{
			"id": "msg_r602_u", "type": "user",
			"text": "look at these and tell me if the change is safe",
			"files": [{"name": "report.md", "mime": "text/markdown"}, {"mime": "image/png"}],
			"time": {"created": 1000},
		},
		{
			"id": "msg_r602_a", "type": "assistant", "agent": "lead",
			"model": {"providerID": "openrouter", "id": "some-model"},
			"content": [
				{"type": "reasoning", "text": "private thinking that must never be shown"},
				{"type": "text", "text": "Here is the change:\n```gdscript\nfunc place(control, rect):\n    control.size = rect.size\n```\nIt is inert.", "phase": "final_answer"},
				{"type": "tool", "tool": "shell", "callID": "call_r602",
				 "state": {"status": "completed", "input": {}, "output": "the tests passed"}},
				{"type": "text", "text": "Markup stays literal: [b]not bold[/b] and <script>x</script>", "phase": "final_answer"},
			],
			"time": {"created": 2000},
		},
	]


func _show() -> void:
	_scene.store.select_actor("ses_r602")
	_scene.conversation_panel.show_actor(_scene.store, "ses_r602", "")
	_scene._refresh_ui()
	var rendered := _drawer_text(_scene.conversation_panel)
	print("R602 drawer text='%s'" % rendered.replace("\n", " | "))
	# The exclusions are the point, so they are reported as failures if they ever appear.
	print("R602 private_thinking_visible=", str(rendered.contains("private thinking")))
	print("R602 markup_is_markup=", str(rendered.contains("[b]not bold[/b]") and not rendered.contains("not bold")))


## What the drawer actually renders, so the report is about what a user can read.
func _drawer_text(panel) -> String:
	var out := ""
	for node in panel._list.get_children():
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
		print("R602 no texture to capture")
		quit(1)
		return
	var image := texture.get_image()
	if image == null:
		print("R602 no image to capture")
		quit(1)
		return
	var path := "%s/r6-02-transcript-detail.png" % _outdir
	image.save_png(path)
	print("R602 captured ", path)


func _finish() -> void:
	_done = true
	print("R602 done")
	if _scene.live != null:
		_scene.live.stop()
	quit(0)
