## R7-06 native capture: four kinds of limit, kept distinct in the real drawer.
##
## Drives the REAL res://app/main.tscn scene and the REAL store. The acceptance requires
## provider quota, rate limits, context limits and local advisory budgets to REMAIN DISTINCT,
## and for no enforced control to exist. What it must show:
##
##   * each of the runtime's own wire error types classified, with its KIND visible;
##   * a rate limit, an exhausted quota and a context overflow labelled differently;
##   * the context window figure read from the step and shown with the overflow;
##   * no control anywhere claiming to enforce a limit.
##
## Kit-local: no repository source depends on this file.
extends SceneTree

var _out := ""
var _frames := 0
var _checks := 0
var _fails := 0


func _init() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() > 0:
		_out = str(args[0])


func _initialize() -> void:
	_go()


func _go() -> void:
	var packed := load("res://app/main.tscn")
	if packed == null:
		print("R706 FAIL: main scene did not load")
		quit(1)
		return
	var scene: Variant = packed.instantiate()
	root.add_child(scene)
	await process_frame
	if scene.demo == null:
		_frames += 1
		if _frames > 240:
			print("R706 FAIL: scene never became ready")
			quit(1)
			return
		_go.call_deferred()
		return
	_run(scene)


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if condition:
		print("R706 PASS  " + message)
		return
	_fails += 1
	print("R706 FAIL  " + message)


func _run(scene) -> void:
	scene.start_demo_mode()
	await process_frame
	var store: Variant = scene.store
	var session_id := "ses_r706"
	store.apply({
		"type": "session.created", "sessionID": session_id,
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-r706",
	})
	# A step that reports the model's window, so the overflow afterwards is explicable.
	store.apply({
		"type": "session.step.ended", "sessionID": session_id,
		"data": {"assistantMessageID": "msg_1", "contextLimit": 200000},
		"sourceEpoch": "epoch-r706",
	})

	# THREE different failures, each with the wire type the RUNTIME emits.
	var failures := [
		{"type": "provider.rate-limit", "message": "Rate limit reached for this model."},
		{"type": "provider.quota", "message": "Your credit balance is too low to continue."},
		{"type": "context.limit", "message": "The provider still rejected the request for context overflow after one compaction rebase."},
	]
	for failure in failures:
		store.apply({
			"type": "session.step.failed", "sessionID": session_id,
			"data": {"error": failure}, "sourceEpoch": "epoch-r706",
		})

	var rows: Array = store.limit_events(session_id)
	print("R706 limit_events=%d" % rows.size())
	var kinds: Array[String] = []
	for row in rows:
		print("R706   kind=%s label=%s detail=%s" % [
			str(row.get("kind", "")), LimitEvent.label(str(row.get("kind", ""))),
			str(row.get("detail", "")),
		])
		if not kinds.has(str(row.get("kind", ""))):
			kinds.append(str(row.get("kind", "")))

	_check(rows.size() == 3, "all three failures reached the store (%d)" % rows.size())
	_check(
		kinds.size() == 3,
		"and they are THREE DISTINCT kinds (%s)" % str(kinds)
	)
	_check(
		kinds.has(LimitEvent.KIND_RATE_LIMIT) and kinds.has(LimitEvent.KIND_QUOTA)
		and kinds.has(LimitEvent.KIND_CONTEXT),
		"a rate limit, a quota and a context overflow are each their own kind"
	)
	_check(
		store.context_limit_for(session_id) == 200000,
		"the model context window was read from the step (%d)" % store.context_limit_for(session_id)
	)
	# The overflow's detail names the window; the others do not claim one.
	for row in rows:
		if str(row.get("kind", "")) == LimitEvent.KIND_CONTEXT:
			_check(
				str(row.get("detail", "")).contains("200000"),
				"the context overflow names the window it exceeded"
			)
		if str(row.get("kind", "")) == LimitEvent.KIND_QUOTA:
			_check(
				not str(row.get("detail", "")).contains("200000"),
				"and a quota failure does NOT claim a context window"
			)

	# No kind is enforced, and no control claims to be.
	for kind in kinds:
		_check(not LimitEvent.is_enforced(kind), "the '%s' kind is not enforced" % kind)
	_check(
		not _has_enforce_control(scene.conversation_panel),
		"no control in the drawer claims to enforce a limit"
	)

	# Show them in the drawer, so the distinction is visible rather than only readable.
	scene._on_actor_selected(session_id)
	scene.conversation_panel.show_actor(store, session_id)
	await process_frame
	await process_frame
	var shown := _panel_text(scene.conversation_panel)
	print("R706 drawer_names_rate=%s" % str(shown.contains("rate limit")))
	print("R706 drawer_names_quota=%s" % str(shown.contains("quota")))
	print("R706 drawer_names_context=%s" % str(shown.contains("context limit")))
	_check(
		shown.to_lower().contains("rate limit"),
		"the drawer names the rate limit"
	)
	_check(shown.to_lower().contains("quota"), "the drawer names the quota")
	_check(shown.to_lower().contains("context limit"), "the drawer names the context limit")

	await _capture(scene, "%s/r7-06-limit-kinds.png" % _out)
	print("R706 checks=%d fails=%d" % [_checks, _fails])
	print("R706 done")
	quit(1 if _fails > 0 else 0)


## Whether a subtree contains a control claiming to enforce a limit.
func _has_enforce_control(node) -> bool:
	if node is Button:
		var text := (node as Button).text.to_lower()
		if text.contains("enforce"):
			return true
	for child in node.get_children():
		if _has_enforce_control(child):
			return true
	return false


func _panel_text(node) -> String:
	var out := ""
	if node is Label:
		out += " " + node.text
	elif node is Button:
		out += " " + node.text
	for child in node.get_children():
		out += " " + _panel_text(child)
	return out.strip_edges()


func _capture(scene, path: String) -> void:
	scene.capture_mode = true
	await process_frame
	await process_frame
	var image := root.get_viewport().get_texture().get_image()
	if image == null:
		print("R706 FAIL: no frame to capture")
		return
	if image.save_png(path) == OK:
		print("R706 captured %s" % path)
	else:
		print("R706 FAIL: could not write %s" % path)
