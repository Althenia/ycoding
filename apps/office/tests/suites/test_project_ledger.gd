## Recent and pinned project navigation tests (R5-02).
##
## The acceptance is: "Compact counts/attention; rename display label only; remove
## never deletes data."
##
## The kit's own model (`docs/MULTI_PROJECT.md`) fixes the shape:
## `DesktopProjectEntry(local_entry_id, canonical_directory, resolved_project_id,
## resolved_location, display_name, pin_order, last_opened)`, with runtime IDs opaque.
## Three consequences are pinned here because they are the ones that go wrong:
##
##   * RENAME changes the DISPLAY LABEL ONLY. The canonical directory is the identity,
##     so renaming must never move, rename or retarget a real folder.
##   * REMOVE takes an entry out of the list and NOTHING else. No file, credential or
##     history may be deleted by it.
##   * ORDER is deterministic: pinned entries first by their pin order, then recents by
##     most-recently-opened, so the list does not reshuffle for no reason.
##
## The per-project counts and attention badge are computed from the real store rather
## than stored, because a stored count would go stale the moment a session started.
extends RefCounted


func run(t) -> void:
	test_a_new_entry_keeps_the_location_it_was_added_with(t)
	test_the_same_folder_added_twice_is_one_entry(t)
	test_a_symlinked_route_to_one_folder_is_one_entry(t)
	test_rename_changes_the_label_only(t)
	test_removing_an_entry_deletes_nothing_but_the_entry(t)
	test_pinned_entries_sort_before_recents(t)
	test_recents_are_ordered_by_last_opened(t)
	test_a_corrupt_store_falls_back_instead_of_failing(t)
	test_counts_and_attention_come_from_the_store(t)
	test_a_pinned_project_can_be_unpinned(t)
	test_the_rail_shows_projects_with_compact_counts(t)


## An entry records the canonical directory, the resolved location and a label, with
## an opaque local id that is not derived from the path.
func test_a_new_entry_keeps_the_location_it_was_added_with(t) -> void:
	var ledger := ProjectLedger.new()
	var base := _temp_dir("add")
	var entry := ledger.add(base, "ses_proj", "My project")
	t.check(not entry.is_empty(), "adding a real folder produces an entry")
	if entry.is_empty():
		_cleanup(base)
		return
	var canonical := str(entry["canonical_directory"])
	t.check(FolderTarget.is_absolute(canonical), "the canonical directory is absolute")
	t.check(
		canonical.ends_with(base.get_file()),
		"the canonical directory names the same folder (got '%s')" % canonical
	)
	# Two routes to the same folder must agree on the canonical form. `/tmp` IS a
	# symlink on macOS, so this is a real resolution rather than a string operation.
	var ledger_direct := ProjectLedger.new()
	ledger_direct.add("/private" + base, "ses_proj", "Via private")
	t.check_equal(
		str(ledger_direct.entries()[0]["canonical_directory"]),
		canonical,
		"the direct and symlinked routes agree on one canonical directory"
	)
	t.check_equal(str(entry["display_name"]), "My project", "the label is kept")
	t.check_equal(str(entry["resolved_location"]), "ses_proj", "the resolved location is kept")
	t.check(not str(entry["local_entry_id"]).is_empty(), "the entry has a local id")
	t.check(
		str(entry["local_entry_id"]).find(base) == -1,
		"the local id is OPAQUE rather than derived from the path"
	)
	t.check(entry.has("pin_order"), "pin order is part of the entry")
	t.check(entry.has("last_opened"), "last opened is part of the entry")
	_cleanup(base)


## Adding the same folder twice is one entry, not two, and it updates rather than
## duplicates.
func test_the_same_folder_added_twice_is_one_entry(t) -> void:
	var ledger := ProjectLedger.new()
	var base := _temp_dir("twice")
	ledger.add(base, "ses_a", "First")
	ledger.add(base, "ses_a", "Second")
	t.check_equal(ledger.entries().size(), 1, "the folder appears once")
	t.check_equal(
		str(ledger.entries()[0]["display_name"]),
		"Second",
		"and the later add updates the existing entry"
	)
	_cleanup(base)


## A symlinked route to a folder already in the list is the SAME entry, because
## deduplication happens on the canonical path rather than on what was clicked.
func test_a_symlinked_route_to_one_folder_is_one_entry(t) -> void:
	var base := _temp_dir("linkdedupe")
	var target := base + "/real"
	DirAccess.make_dir_recursive_absolute(target)
	var dir := DirAccess.open(base)
	if dir == null:
		_cleanup(base)
		return
	if dir.create_link(target, base + "/link") != OK:
		t.check(true, "this filesystem cannot create a symlink, so the case is skipped")
		_cleanup(base)
		return
	var ledger := ProjectLedger.new()
	ledger.add(target, "ses_a", "Via real")
	ledger.add(base + "/link", "ses_a", "Via link")
	t.check_equal(ledger.entries().size(), 1, "both routes resolve to one entry")
	_cleanup(base)


## RENAME IS A LABEL CHANGE ONLY. The directory on disk must be untouched, and the
## canonical path must not change.
func test_rename_changes_the_label_only(t) -> void:
	var ledger := ProjectLedger.new()
	var base := _temp_dir("rename")
	ledger.add(base, "ses_a", "Original")
	var canonical := str(ledger.entries()[0]["canonical_directory"])
	var id := str(ledger.entries()[0]["local_entry_id"])
	t.check(ledger.rename(id, "Renamed"), "the rename succeeds")
	t.check_equal(
		str(ledger.entries()[0]["display_name"]),
		"Renamed",
		"the label changed"
	)
	t.check_equal(
		str(ledger.entries()[0]["canonical_directory"]),
		canonical,
		"the canonical directory is UNCHANGED by a rename"
	)
	t.check(
		DirAccess.dir_exists_absolute(base),
		"and the real folder still exists under its original name"
	)
	# An unknown id is refused rather than silently ignored.
	t.check(not ledger.rename("nope", "x"), "renaming an unknown entry is refused")
	_cleanup(base)


## REMOVE deletes the entry and nothing else. No file, no credential, no history.
func test_removing_an_entry_deletes_nothing_but_the_entry(t) -> void:
	var ledger := ProjectLedger.new()
	var base := _temp_dir("remove")
	var inside := base + "/important.txt"
	var file := FileAccess.open(inside, FileAccess.WRITE)
	if file != null:
		file.store_string("irreplaceable work\n")
		file.close()
	ledger.add(base, "ses_a", "Doomed entry")
	var id := str(ledger.entries()[0]["local_entry_id"])

	t.check(ledger.remove(id), "the entry is removed")
	t.check_equal(ledger.entries().size(), 0, "the list no longer holds it")
	t.check(
		DirAccess.dir_exists_absolute(base),
		"the FOLDER still exists after the entry is removed"
	)
	t.check(
		FileAccess.file_exists(inside),
		"and so does a file inside it"
	)
	# Removing an unknown id is refused rather than treated as success.
	t.check(not ledger.remove("nope"), "removing an unknown entry is refused")
	_cleanup(base)


## Pinned entries come first, ordered by their own pin order, so a pinned project
## does not drift down the list as other projects are opened.
func test_pinned_entries_sort_before_recents(t) -> void:
	var ledger := ProjectLedger.new()
	var a := _temp_dir("pinA")
	var b := _temp_dir("pinB")
	var c := _temp_dir("pinC")
	ledger.add(a, "ses_a", "A")
	ledger.add(b, "ses_b", "B")
	ledger.add(c, "ses_c", "C")
	var id_a := str(ledger.entries()[0]["local_entry_id"])
	var id_c := str(ledger.entries()[2]["local_entry_id"])
	ledger.pin(id_c, 1)
	ledger.pin(id_a, 2)
	var names := []
	for entry in ledger.entries():
		names.append(str(entry["display_name"]))
	t.check_equal(names[0], "C", "the first pin order leads")
	t.check_equal(names[1], "A", "the second pin order follows")
	t.check_equal(names[2], "B", "an unpinned entry comes after the pinned ones")
	_cleanup(a)
	_cleanup(b)
	_cleanup(c)


## Recents are ordered by most-recently-opened, so the list answers "where was I".
func test_recents_are_ordered_by_last_opened(t) -> void:
	var ledger := ProjectLedger.new()
	var a := _temp_dir("recA")
	var b := _temp_dir("recB")
	ledger.add(a, "ses_a", "A")
	ledger.add(b, "ses_b", "B")
	var id_a := str(ledger.entries()[0]["local_entry_id"])
	# A opens most recently.
	ledger.touch(id_a)
	var names := []
	for entry in ledger.entries():
		names.append(str(entry["display_name"]))
	t.check_equal(names[0], "A", "the most recently opened entry leads")
	_cleanup(a)
	_cleanup(b)


## A corrupt or hand-edited store must fall back rather than fail: losing the recents
## list is survivable, and the office must still start.
func test_a_corrupt_store_falls_back_instead_of_failing(t) -> void:
	var path := "user://test-corrupt-%d.cfg" % Time.get_unix_time_from_system()
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file != null:
		file.store_string("this is not a config file at all\n[unclosed section\n=\n")
		file.close()
	var ledger := ProjectLedger.new()
	ledger.file_path = path
	ledger.load()
	t.check_equal(ledger.entries().size(), 0, "a corrupt store yields an empty list")
	t.check(not ledger.last_error().is_empty(), "and reports that it could not be read")
	DirAccess.remove_absolute(ProjectSettings.globalize_path(path))


## Counts and attention are DERIVED from the live store, so a started session shows
## up immediately rather than waiting for the ledger to be rewritten.
func test_counts_and_attention_come_from_the_store(t) -> void:
	var store := OfficeStore.new()
	store.apply({"type": Wire.CONNECTED, "sessionID": "", "data": {}, "sourceEpoch": "e1"})
	var base := _temp_dir("counts")
	for id in ["ses_one", "ses_two"]:
		store.apply({
			"type": Wire.SESSION_CREATED, "sessionID": id,
			# The location rides in `data`, which is where the store reads it.
			"data": {"agent": "lead", "title": "Lead", "location": {"directory": base}},
			"sourceEpoch": "e1",
		})
	store.apply({
		"type": Wire.STEP_STARTED, "sessionID": "ses_one",
		"data": {}, "sourceEpoch": "e1",
	})
	store.apply({
		"type": Wire.GUARDRAIL_ASKED, "sessionID": "ses_two",
		"data": {
			"id": "grq_c", "sessionID": "ses_two", "action": "git.push",
			"resources": ["main"], "reason": "Protected",
		},
		"sourceEpoch": "e1",
	})

	var ledger := ProjectLedger.new()
	ledger.add(base, "ses_proj", "Counted")
	var summary := ledger.summary_for(base, store)
	t.check_equal(int(summary["sessions"]), 2, "both sessions are counted for the folder")
	t.check(int(summary["running"]) >= 1, "the running session is counted as running")
	t.check(int(summary["attention"]) >= 1, "the pending review is counted as attention")
	# A folder with nothing in it reports zeroes rather than being omitted.
	var other := _temp_dir("empty")
	var empty := ledger.summary_for(other, store)
	t.check_equal(int(empty["sessions"]), 0, "an unopened folder reports no sessions")
	t.check_equal(int(empty["attention"]), 0, "and no attention")
	_cleanup(base)
	_cleanup(other)


## Unpinning puts an entry back among the recents rather than removing it.
func test_a_pinned_project_can_be_unpinned(t) -> void:
	var ledger := ProjectLedger.new()
	var a := _temp_dir("unpinA")
	var b := _temp_dir("unpinB")
	ledger.add(a, "ses_a", "A")
	ledger.add(b, "ses_b", "B")
	var id_a := str(ledger.entries()[0]["local_entry_id"])
	ledger.pin(id_a, 1)
	t.check(int(ledger.entries()[0]["pin_order"]) > 0, "the entry is pinned")
	ledger.unpin(id_a)
	var entry := ledger.find(id_a)
	t.check(not entry.is_empty(), "the entry still exists after unpinning")
	t.check_equal(int(entry["pin_order"]), 0, "and is no longer pinned")
	t.check_equal(ledger.entries().size(), 2, "nothing was removed")
	_cleanup(a)
	_cleanup(b)


## --- helpers ---------------------------------------------------------------

func _temp_dir(name: String) -> String:
	var path := "/tmp/ycoding-r502-%s-%d" % [name, Time.get_unix_time_from_system()]
	DirAccess.make_dir_recursive_absolute(path)
	return path


func _cleanup(path: String) -> void:
	var dir := DirAccess.open(path)
	if dir == null:
		return
	for entry in dir.get_directories():
		FileAccess.set_unix_permissions(path + "/" + entry, 493)
	for entry in dir.get_files():
		DirAccess.remove_absolute(path + "/" + entry)
	DirAccess.remove_absolute(path)


## The project list must be REACHABLE, not merely modelled: the rail's own rows are
## built and inspected here. Counts are compact, so a quiet project carries no
## suffix at all rather than a row of zeroes.
func test_the_rail_shows_projects_with_compact_counts(t) -> void:
	var sidebar := SidebarPanel.new()
	sidebar._ensure_built()
	t.root.add_child(sidebar)

	var ledger := ProjectLedger.new()
	var store := OfficeStore.new()
	store.apply({"type": Wire.CONNECTED, "sessionID": "", "data": {}, "sourceEpoch": "e1"})
	var busy := _temp_dir("railbusy")
	var quiet := _temp_dir("railquiet")
	ledger.add(quiet, "ses_q", "Quiet")
	var busy_entry := ledger.add(busy, "ses_b", "Busy")
	ledger.pin(str(busy_entry["local_entry_id"]), 1)
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_b",
		"data": {"agent": "lead", "title": "Lead", "location": {"directory": busy}},
		"sourceEpoch": "e1",
	})
	store.apply({"type": Wire.STEP_STARTED, "sessionID": "ses_b", "data": {}, "sourceEpoch": "e1"})

	sidebar.set_projects(ledger, store)
	var rows := sidebar._projects_box.get_children()
	t.check_equal(rows.size(), 2, "the rail carries a row per project")
	if rows.size() != 2:
		_cleanup(busy)
		_cleanup(quiet)
		sidebar.free()
		return

	var first: Button = rows[0]
	var second: Button = rows[1]
	t.check(
		first.text.begins_with(SidebarPanel.MARK_PINNED),
		"the pinned project leads and carries the pin marker: '%s'" % first.text
	)
	t.check(
		first.text.find("running") != -1,
		"the busy project shows its running count: '%s'" % first.text
	)
	t.check(
		second.text.find("running") == -1 and second.text.find("!") == -1,
		"a quiet project carries NO suffix rather than a row of zeroes: '%s'" % second.text
	)
	# The full path is in the tooltip, because the row label is shortened.
	t.check(
		first.tooltip_text.ends_with(busy.get_file()),
		"the row's tooltip carries the full canonical directory: '%s'" % first.tooltip_text
	)
	t.check(
		FolderTarget.is_absolute(first.tooltip_text),
		"and it is an absolute path rather than a shortened label"
	)
	# Pressing a row asks the root to open that project, rather than acting itself.
	var asked: Array[String] = []
	sidebar.project_requested.connect(func(id: String): asked.append(id))
	first.pressed.emit()
	t.check_equal(asked.size(), 1, "pressing a row asks the root to open the project")
	_cleanup(busy)
	_cleanup(quiet)
	sidebar.free()
