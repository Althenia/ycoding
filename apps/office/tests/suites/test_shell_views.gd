## Files, diff and shell view tests (R6-05).
##
## The acceptance is: "Use actual APIs; read-only details and supported actions; do not
## substitute a fake terminal."
##
## Two real gaps, each verified against the live schema before a line was written:
##
##   * SHELL: the runtime emits `session.shell.started` and `session.shell.ended`, and exposes
##     `shell.list`, `shell.get` and a PAGEABLE `shell.output` carrying a cursor and a size
##     (packages/schema/src/shell.ts, packages/protocol/src/groups/shell.ts). The office read
##     none of it, so a session that ran commands showed nothing about them.
##   * FILE CHANGE: the row already shows the path, the counts and a bounded patch. What it
##     must NOT do is claim more than the wire carries, or present a patch as the whole file.
##
## The clause that shapes everything here is "do not substitute a fake terminal". A shell view
## is READ-ONLY detail about a command the runtime ran - its command, its working directory, its
## status, and its captured output - and nothing in it may invite the user to type into it.
##
## Each clause fails differently:
##
##   * SHELL ROWS - a shell event becomes a row naming the command and how it ended;
##   * STATUS IS THE RUNTIME'S - `running` is never presented as finished;
##   * OUTPUT IS PAGEABLE - the reader exposes the real paging cursor rather than pretending a
##     page is the whole output;
##   * NO FAKE TERMINAL - the view carries no input control and claims no interactivity;
##   * FILE CHANGE - the patch is bounded and marked, and never presented as the whole file.
extends RefCounted


func run(t) -> void:
	test_a_shell_event_becomes_a_row_naming_the_command(t)
	test_a_shell_row_reports_the_runtime_status(t)
	test_a_running_shell_is_never_presented_as_finished(t)
	test_shell_output_is_readable_and_records_whether_more_remains(t)
	test_the_shell_reader_exposes_no_input_control(t)
	test_a_file_change_shows_its_path_counts_and_patch(t)
	test_a_file_change_patch_is_bounded_and_marked(t)
	test_the_drawer_shows_a_shell_the_session_ran(t)
	test_the_drawer_never_shows_a_running_shell_as_finished(t)
	test_the_drawer_says_when_more_output_remains(t)
	test_the_drawer_offers_no_way_to_type_a_command(t)


## A shell as the runtime reports it (`Shell.Info`).
func _shell(shell_id: String, status: String, command: String = "echo hi") -> Dictionary:
	return {
		"id": shell_id, "status": status, "command": command,
		"cwd": "/workspace/project", "shell": "/bin/sh", "file": "/tmp/output.txt",
		"metadata": {}, "time": {"created": 1000},
	}


## Record a session so a shell can belong to one.
func _session(store: OfficeStore, session_id: String = "ses_a") -> void:
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": session_id,
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-a",
	})


## A shell event becomes a row that names the command, so a session's commands are visible at
## all - which they were not.
func test_a_shell_event_becomes_a_row_naming_the_command(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	store.apply({
		"type": ShellView.SHELL_STARTED, "sessionID": "ses_a",
		"data": {"shell": _shell("sh_1", "running", "npm run build")},
		"sourceEpoch": "epoch-a",
	})
	var rows := store.shells_for("ses_a")
	t.check_equal(rows.size(), 1, "a started shell is recorded")
	if rows.is_empty():
		return
	t.check(
		str(rows[0].get("command", "")).contains("npm run build"),
		"and the row names the command the runtime ran (%s)" % str(rows[0].get("command", ""))
	)
	t.check_equal(
		str(rows[0].get("shell_id", "")), "sh_1",
		"and carries the shell's own id, so its output can be paged later"
	)
	# The working directory is part of the detail: a command's meaning depends on where it ran.
	t.check(
		not str(rows[0].get("cwd", "")).is_empty(),
		"and states the directory it ran in"
	)


## The status is the RUNTIME's, never inferred from whether an output arrived.
func test_a_shell_row_reports_the_runtime_status(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	store.apply({
		"type": ShellView.SHELL_STARTED, "sessionID": "ses_a",
		"data": {"shell": _shell("sh_1", "running")}, "sourceEpoch": "epoch-a",
	})
	t.check_equal(
		str(store.shells_for("ses_a")[0].get("status", "")), "running",
		"the started shell reports the runtime's status"
	)
	# The end event carries the settled status AND the output.
	store.apply({
		"type": ShellView.SHELL_ENDED, "sessionID": "ses_a",
		"data": {
			"shell": _shell("sh_1", "exited"),
			"output": {"output": "the build finished", "cursor": 18, "size": 18, "truncated": false},
		},
		"sourceEpoch": "epoch-a",
	})
	var rows := store.shells_for("ses_a")
	t.check_equal(rows.size(), 1, "the end event updates the same shell rather than adding one")
	t.check_equal(
		str(rows[0].get("status", "")), "exited",
		"and its status is the settled one the runtime reported"
	)


## A shell still running must never read as finished. Presenting a running command as done is
## the same class of untruth as an invented success.
func test_a_running_shell_is_never_presented_as_finished(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	store.apply({
		"type": ShellView.SHELL_STARTED, "sessionID": "ses_a",
		"data": {"shell": _shell("sh_1", "running")}, "sourceEpoch": "epoch-a",
	})
	var row: Dictionary = store.shells_for("ses_a")[0]
	t.check(
		not ShellView.is_settled(row),
		"a running shell is not settled"
	)
	# Every status the schema declares is classified, so a new one cannot silently read as
	# finished just because it is not "running".
	for status in ["exited", "timeout", "memory-limit", "killed"]:
		var settled := _shell("sh_x", status)
		t.check(
			ShellView.is_settled({"status": str(settled["status"])}),
			"the declared status '%s' is settled" % status
		)
	t.check(
		not ShellView.is_settled({"status": "running"}),
		"and only 'running' is unsettled"
	)
	t.check(
		not ShellView.is_settled({}),
		"a shell with no status is not treated as finished"
	)


## Output is pageable, and the reader must record whether MORE remains rather than presenting
## one page as the whole output. The runtime supplies the cursor and the size for exactly this.
func test_shell_output_is_readable_and_records_whether_more_remains(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	store.apply({
		"type": ShellView.SHELL_ENDED, "sessionID": "ses_a",
		"data": {
			"shell": _shell("sh_1", "exited"),
			# A page of a LONGER output: the cursor is behind the total size.
			"output": {"output": "the first page", "cursor": 14, "size": 900, "truncated": false},
		},
		"sourceEpoch": "epoch-a",
	})
	var output := ShellView.output_of(store.shells_for("ses_a")[0])
	t.check_equal(str(output.get("output", "")), "the first page", "the page's text is kept")
	t.check(
		ShellView.has_more(output),
		"and the reader reports that MORE output remains (%s of %s)" % [
			str(output.get("cursor", "")), str(output.get("size", "")),
		]
	)
	# A complete read reports no more, so the state is not permanently "more remains".
	var done := {"output": "all of it", "cursor": 100, "size": 100, "truncated": false}
	t.check(not ShellView.has_more(done), "a caught-up read reports no more")
	# A truncated capture says so, because the output is NOT the whole of what the command
	# produced and a reader must not treat it as the whole.
	var cut := {"output": "partial", "cursor": 7, "size": 7, "truncated": true}
	t.check(ShellView.is_truncated(cut), "a truncated capture is reported as truncated")


## "Do not substitute a fake terminal." A shell view is READ-ONLY detail, so it carries no
## input control and claims no interactivity.
func test_the_shell_reader_exposes_no_input_control(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	store.apply({
		"type": ShellView.SHELL_ENDED, "sessionID": "ses_a",
		"data": {
			"shell": _shell("sh_1", "exited"),
			"output": {"output": "done", "cursor": 4, "size": 4, "truncated": false},
		},
		"sourceEpoch": "epoch-a",
	})
	var row: Dictionary = store.shells_for("ses_a")[0]
	# The row carries detail, and nothing that could be sent back.
	for forbidden in ["input", "stdin", "command_input", "send", "write"]:
		t.check(
			not row.has(forbidden),
			"a shell row carries no '%s' field to type into" % forbidden
		)
	t.check(
		ShellView.is_read_only(row),
		"and the row declares itself read-only detail"
	)


## A file change shows its path, its counts and its patch, which the wire does carry.
func test_a_file_change_shows_its_path_counts_and_patch(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	store.apply({
		"type": Wire.FILE_CHANGE, "sessionID": "ses_a",
		"data": {"change": {
			"path": "src/main.ts", "patch": "@@ -1 +1 @@\n-old\n+new",
			"additions": 1, "deletions": 1,
		}},
		"sourceEpoch": "epoch-a",
	})
	var rows := store.conversation_items("ses_a").filter(
		func(r): return str(r.get("kind", "")) == "file_change"
	)
	t.check_equal(rows.size(), 1, "the change is one row")
	if rows.is_empty():
		return
	t.check_equal(str(rows[0].get("path", "")), "src/main.ts", "the path is carried")
	t.check_equal(int(rows[0].get("additions", 0)), 1, "the additions are carried")
	t.check_equal(int(rows[0].get("deletions", 0)), 1, "the deletions are carried")
	t.check(
		str(rows[0].get("patch", "")).contains("+new"),
		"and the patch excerpt is carried"
	)
	# The change KIND is genuinely absent from the wire
	# (packages/schema/src/session-event.ts: FileChange.Info has no `kind`), so the row must not
	# invent one.
	t.check(
		not rows[0].has("change_kind"),
		"and no change kind is invented for a schema that carries none"
	)


## A patch is an EXCERPT. It is bounded, and the cut is marked, because a patch presented as the
## whole change would misrepresent what was changed.
func test_a_file_change_patch_is_bounded_and_marked(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	var huge := "+a line\n".repeat(4000)
	store.apply({
		"type": Wire.FILE_CHANGE, "sessionID": "ses_a",
		"data": {"change": {
			"path": "src/big.ts", "patch": huge, "additions": 4000, "deletions": 0,
		}},
		"sourceEpoch": "epoch-a",
	})
	var rows := store.conversation_items("ses_a").filter(
		func(r): return str(r.get("kind", "")) == "file_change"
	)
	if rows.is_empty():
		t.check(false, "the change row exists")
		return
	var patch := str(rows[0].get("patch", ""))
	t.check(
		patch.length() < huge.length(),
		"the patch is bounded rather than carried whole (%d of %d)" % [patch.length(), huge.length()]
	)
	# Bounded by the store's own excerpt ceiling, so the bound asserted here is the one that
	# actually applies rather than a second limit invented for the test.
	t.check(
		patch.length() <= OfficeStore.MAX_MESSAGE_EXCERPT,
		"and bounded by the store's excerpt ceiling (%d <= %d)" % [
			patch.length(), OfficeStore.MAX_MESSAGE_EXCERPT,
		]
	)
	t.check(
		patch.contains("…"),
		"and the cut is marked, because the patch is an excerpt rather than the whole change"
	)
	# A small patch is carried whole, so the bound does not cut what fits.
	store.apply({
		"type": Wire.FILE_CHANGE, "sessionID": "ses_a",
		"data": {"change": {
			"path": "src/small.ts", "patch": "-a\n+b", "additions": 1, "deletions": 1,
		}},
		"sourceEpoch": "epoch-a",
	})
	var small := store.conversation_items("ses_a").filter(
		func(r): return str(r.get("path", "")) == "src/small.ts"
	)
	if small.size() == 1:
		t.check(
			str(small[0].get("patch", "")) == "-a\n+b",
			"a small patch is carried unchanged"
		)


## ---------------------------------------------------------------------------------------
## The drawer renders shell detail, so a session that ran commands shows them. This is the
## part that must not become a fake terminal: the detail is READ-ONLY.
## ---------------------------------------------------------------------------------------


## Build a drawer against a real tree so its `_ready` runs, which is the only way its list
## exists. Adding the panel to a scene-less root leaves `_list` null and every assertion here
## would be made against nothing.
func _open_drawer(t, store: OfficeStore) -> ConversationPanel:
	var panel := ConversationPanel.new()
	panel._store = store
	t.root.add_child(panel)
	await t.process_frame
	panel.show_actor(store, "ses_a")
	return panel


func _drawer_text(panel: ConversationPanel) -> String:
	var out := ""
	if panel._list == null:
		return out
	for node in panel._list.get_children():
		out += " " + _text_of(node)
	return out.strip_edges()


func _text_of(node) -> String:
	if node is Label:
		return node.text
	var out := ""
	for child in node.get_children():
		out += " " + _text_of(child)
	return out.strip_edges()


## The command a session ran is visible in the drawer at all - it was not before.
func test_the_drawer_shows_a_shell_the_session_ran(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	store.apply({
		"type": ShellView.SHELL_ENDED, "sessionID": "ses_a",
		"data": {
			"shell": _shell("sh_1", "exited", "npm run build"),
			"output": {"output": "compiled ok", "cursor": 11, "size": 11, "truncated": false},
		},
		"sourceEpoch": "epoch-a",
	})
	var panel := await _open_drawer(t, store)
	var text := _drawer_text(panel)
	t.check(
		text.contains("npm run build"),
		"the drawer shows the command the session ran"
	)
	t.check(text.contains("compiled ok"), "and its captured output")
	t.check(text.contains("/workspace/project"), "and the directory it ran in")
	panel.free()


## A running shell must not read as finished in the drawer either.
func test_the_drawer_never_shows_a_running_shell_as_finished(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	store.apply({
		"type": ShellView.SHELL_STARTED, "sessionID": "ses_a",
		"data": {"shell": _shell("sh_1", "running", "sleep 30")}, "sourceEpoch": "epoch-a",
	})
	var panel := await _open_drawer(t, store)
	var text := _drawer_text(panel)
	t.check(text.contains("running"), "the drawer states the runtime's status")
	t.check(
		not text.contains("exited"),
		"and never presents a running command as finished"
	)
	panel.free()


## Output that is only PART of what the command produced must say so, so a page is not
## mistaken for the whole.
func test_the_drawer_says_when_more_output_remains(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	store.apply({
		"type": ShellView.SHELL_ENDED, "sessionID": "ses_a",
		"data": {
			"shell": _shell("sh_1", "exited"),
			"output": {"output": "the first page", "cursor": 14, "size": 900, "truncated": true},
		},
		"sourceEpoch": "epoch-a",
	})
	var panel := await _open_drawer(t, store)
	var text := _drawer_text(panel)
	t.check(text.contains("14 of 900"), "the drawer states how much of the output was read")
	t.check(text.contains("truncated"), "and that the capture was truncated")
	panel.free()


## The detail is READ-ONLY. A control that accepted a command would make this a fake terminal,
## which the acceptance forbids outright.
func test_the_drawer_offers_no_way_to_type_a_command(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	store.apply({
		"type": ShellView.SHELL_ENDED, "sessionID": "ses_a",
		"data": {
			"shell": _shell("sh_1", "exited"),
			"output": {"output": "done", "cursor": 4, "size": 4, "truncated": false},
		},
		"sourceEpoch": "epoch-a",
	})
	var panel := await _open_drawer(t, store)
	t.check(
		not _accepts_input(panel._list),
		"nothing in a shell row accepts typed input"
	)
	t.check(not _accepts_input(panel), "and the drawer offers no shell input control at all")
	panel.free()


## Whether a subtree contains anything that could accept a typed command.
func _accepts_input(node) -> bool:
	if node is LineEdit or node is TextEdit:
		return true
	for child in node.get_children():
		if _accepts_input(child):
			return true
	return false
