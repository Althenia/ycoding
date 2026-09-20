## R6-05 native capture: files, diff and shell views in the real drawer.
##
## Drives the REAL `res://app/main.tscn` scene, so the drawer, its rows and the route
## owner are the product's own. What this must show:
##
##   * a SHELL the runtime ran, with its command, its directory, its settled status and its
##     captured output, including that MORE output remains - pageable detail, not a page
##     presented as the whole;
##   * that the detail is READ-ONLY: the capture reports every input control in the drawer,
##     so "do not substitute a fake terminal" is shown rather than asserted;
##   * a FILE CHANGE with its path, counts and bounded, marked patch;
##   * the drawer NAMES its source for each row, so a reader can tell which durable event
##     produced it.
##
## Kit-local: no repository source depends on this file.
extends SceneTree

const OUT_DIR := "res://../ycoding-office-repair-kit/evidence/r6-05"

var _out := ""
var _frames := 0
var _shots := 0


func _init() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() > 0:
		_out = str(args[0])


func _initialize() -> void:
	_root_go()


func _root_go() -> void:
	var packed := load("res://app/main.tscn")
	if packed == null:
		print("R605 FAIL: main scene did not load")
		quit(1)
		return
	var scene = packed.instantiate()
	root.add_child(scene)
	await process_frame
	if scene.demo == null:
		# `_ready` runs after `_initialize`, so the scene is retried until it is built.
		_frames += 1
		if _frames > 240:
			print("R605 FAIL: scene never became ready")
			quit(1)
			return
		_root_go.call_deferred()
		return
	_run(scene)


func _run(scene) -> void:
	scene.start_demo_mode()
	await process_frame

	var store = scene.store
	# A real session, created the way the runtime reports one.
	var session_id := "ses_r605"
	store.apply({
		"type": "session.created", "sessionID": session_id,
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-r605",
	})

	# A shell whose output is LONGER than the page read, so "more remains" is real.
	store.apply({
		"type": "session.shell.started", "sessionID": session_id,
		"data": {"shell": {
			"id": "sh_r605", "status": "running", "command": "bun test packages/core",
			"cwd": "/workspace/ycoding", "shell": "/bin/sh", "file": "/tmp/sh_r605.txt",
			"metadata": {}, "time": {"created": 1000},
		}},
		"sourceEpoch": "epoch-r605",
	})
	store.apply({
		"type": "session.shell.ended", "sessionID": session_id,
		"data": {
			"shell": {
				"id": "sh_r605", "status": "exited", "command": "bun test packages/core",
				"cwd": "/workspace/ycoding", "shell": "/bin/sh", "file": "/tmp/sh_r605.txt",
				"metadata": {}, "time": {"created": 1000},
			},
			"output": {
				"output": "bun test v1.2.0\n\npackages/core/session.test.ts:\n✓ admits one prompt\n✓ promotes at a safe boundary",
				"cursor": 94, "size": 4180, "truncated": true,
			},
		},
		"sourceEpoch": "epoch-r605",
	})

	# A file change, with a patch too big to carry whole so the excerpt is visibly marked.
	# A representative change. The BOUND is proven in the unit suite with a 4000-line patch;
	# here the excerpt must fit alongside the shell row it is being shown with.
	var patch := "@@ -118,4 +118,7 @@ export namespace SessionV2\n" \
		+ "   export const prompt = (input: Prompt.Input) =>\n" \
		+ "-    admit(input, { resume: true })\n" \
		+ "+    admit(input, { resume: input.resume ?? true })\n" \
		+ "+  // A steered prompt promotes at the next safe step boundary.\n"
	store.apply({
		"type": "session.file-change.recorded", "sessionID": session_id,
		"data": {"change": {
			"path": "packages/core/src/session.ts", "patch": patch,
			"additions": 3, "deletions": 1,
		}},
		"sourceEpoch": "epoch-r605",
	})

	# Show the session in the drawer. `_on_actor_selected` is the product's own selection
	# path, so the drawer is driven the way a click drives it rather than around it.
	scene._on_actor_selected(session_id)
	scene.conversation_panel.show_actor(store, session_id)
	await process_frame
	await process_frame

	var drawer_text := _drawer_text(scene.conversation_panel)
	var shells: Array = store.shells_for(session_id)

	print("R605 shells=%d" % shells.size())
	if shells.is_empty():
		print("R605 FAIL: the shell was not recorded")
		quit(1)
		return
	var row: Dictionary = shells[0]
	var output: Dictionary = row.get("output", {})
	print("R605 shell status=%s command=%s cwd=%s read_only=%s" % [
		str(row.get("status", "")), str(row.get("command", "")),
		str(row.get("cwd", "")), str(row.get("read_only", false)),
	])
	print("R605 output cursor=%d size=%d truncated=%s more=%s" % [
		int(output.get("cursor", 0)), int(output.get("size", 0)),
		str(output.get("truncated", false)), str(ShellView.has_more(output)),
	])
	var inputs := _input_controls(scene.conversation_panel)
	print("R605 drawer_input_controls=%d" % inputs)
	print("R605 drawer_names_the_command=%s" % str(drawer_text.contains("bun test packages/core")))
	print("R605 drawer_states_paging=%s" % str(drawer_text.contains("94 of 4180")))
	print("R605 drawer_states_truncation=%s" % str(drawer_text.contains("truncated")))

	await _capture(scene, "%s/r6-05-shell-and-diff.png" % _out)
	print("R605 done")
	quit(0)


## Every control in a subtree that could accept typed input. The acceptance forbids
## substituting a fake terminal, so this must stay at zero.
func _input_controls(node) -> int:
	var count := 0
	if node is LineEdit or node is TextEdit:
		count += 1
	for child in node.get_children():
		count += _input_controls(child)
	return count


func _drawer_text(panel) -> String:
	if panel._list == null:
		return ""
	var out := ""
	for node in panel._list.get_children():
		out += " " + _label_text(node)
	return out.strip_edges()


func _label_text(node) -> String:
	if node is Label:
		return node.text
	var out := ""
	for child in node.get_children():
		out += " " + _label_text(child)
	return out.strip_edges()


func _capture(scene, path: String) -> void:
	scene.capture_mode = true
	await process_frame
	await process_frame
	var image := root.get_viewport().get_texture().get_image()
	if image == null:
		print("R605 FAIL: no frame to capture")
		return
	if image.save_png(path) == OK:
		_shots += 1
		print("R605 captured %s" % path)
	else:
		print("R605 FAIL: could not write %s" % path)
