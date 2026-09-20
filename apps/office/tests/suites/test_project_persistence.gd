extends RefCounted


func run(t) -> void:
	test_project_store_paths_are_instance_owned(t)


func test_project_store_paths_are_instance_owned(t) -> void:
	var first := ProjectLedger.new()
	# Stop before any write if persistence cannot yet be isolated from real preferences.
	var configurable := first.get_property_list().any(func(value: Dictionary) -> bool:
		return value.name == "file_path")
	t.check(configurable, "project persistence must support an instance-owned path")
	if not configurable:
		return
	var existed := FileAccess.file_exists(ProjectLedger.DEFAULT_PATH)
	var original := FileAccess.get_sha256(ProjectLedger.DEFAULT_PATH) if existed else ""
	var base := "user://test_project_persistence_%d" % Time.get_ticks_usec()
	t.check_equal(DirAccess.make_dir_recursive_absolute(base), OK, "create isolated project directory")
	var first_path := base.path_join("first.cfg")
	var second_path := base.path_join("second.cfg")
	first.set("file_path", first_path)
	first.add(ProjectSettings.globalize_path(base), "", "First")
	t.check_equal(first.save(), OK, "save uses first instance path")
	var second := ProjectLedger.new()
	second.set("file_path", second_path)
	second.add(ProjectSettings.globalize_path(base), "", "Second")
	t.check_equal(second.save(), OK, "save uses second instance path")
	first.load()
	second.load()
	t.check_equal(first.entries().size(), 1, "first persisted entry loads")
	t.check_equal(second.entries().size(), 1, "second persisted entry loads")
	if not first.entries().is_empty() and not second.entries().is_empty():
		t.check_equal(first.entries()[0].display_name, "First", "first read stays isolated")
		t.check_equal(second.entries()[0].display_name, "Second", "second read stays isolated")
	t.check_equal(FileAccess.file_exists(ProjectLedger.DEFAULT_PATH), existed, "real preference existence unchanged")
	if existed:
		t.check_equal(FileAccess.get_sha256(ProjectLedger.DEFAULT_PATH), original, "real preference bytes unchanged")
	DirAccess.remove_absolute(first_path)
	DirAccess.remove_absolute(second_path)
	DirAccess.remove_absolute(base)
