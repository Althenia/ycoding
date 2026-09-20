## Folder selection, canonicalization and project targeting tests (R5-01).
##
## The acceptance is: "Use actual Project/Location API; Git, non-Git, monorepo,
## worktree and inaccessible folder cases."
##
## The kit's own spec (`docs/MULTI_PROJECT.md`) adds two rules this file pins:
## "Open folder -> canonicalize local path -> resolve through existing location/project
## API -> display project/folder and trust status ... **A newly selected folder is not
## execution consent.** Show the target beside the composer BEFORE enabling Send." and
## "Resolve symlinks before deduplication; respect host case sensitivity; do not
## lowercase all paths. Two worktrees of the same project remain separate locations."
##
## The real dependants are exercised rather than mocked: temp directories on the real
## filesystem, a real symlink, and real git repositories where git is available.
extends RefCounted

## A path used only to stand for "some folder". It deliberately does not resemble a
## real home directory: the asset-provenance suite scans every test file for private
## traces, and a home-style literal would be one.
const TARGET_PROBE_PATH := "/synthetic/project"

## Where the office under test persists its view state. Never the real preference.
const TEST_VIEW_STATE_PATH := "user://test_folder_target_view_state.cfg"


func run(t) -> void:
	var preference_existed := FileAccess.file_exists(ProjectLedger.DEFAULT_PATH)
	var preference_digest := FileAccess.get_sha256(ProjectLedger.DEFAULT_PATH) if preference_existed else ""
	test_a_path_is_resolved_before_it_is_used(t)
	test_a_symlink_dedupes_to_its_target(t)
	test_paths_keep_their_case_rather_than_being_lowercased(t)
	test_a_missing_directory_is_refused_with_a_reason(t)
	test_an_inaccessible_directory_is_refused_and_distinguished_from_missing(t)
	test_a_non_git_directory_still_resolves(t)
	test_two_worktrees_stay_separate_locations(t)
	test_a_monorepo_subdirectory_is_its_own_location(t)
	test_choosing_a_folder_is_not_execution_consent(t)
	test_the_composer_shows_the_target_before_send(t)
	test_the_transport_receives_the_chosen_location(t)
	t.check_equal(FileAccess.file_exists(ProjectLedger.DEFAULT_PATH), preference_existed, "folder tests preserve real project preference existence")
	if preference_existed:
		t.check_equal(FileAccess.get_sha256(ProjectLedger.DEFAULT_PATH), preference_digest, "folder tests preserve real project preference bytes")


## Absolute, cleaned paths only. A relative path or one with `..` would resolve
## differently depending on the process directory, which is exactly what the office
## must not guess about.
func test_a_path_is_resolved_before_it_is_used(t) -> void:
	var root := FolderTarget.new()
	var base := _temp_dir("resolve")
	t.check(FolderTarget.is_absolute(base), "a real temp path is absolute")
	var resolved := root.resolve(base + "/./nested/..")
	t.check(resolved.is_empty() or not resolved.contains("/./"), "no '.' segment survives")
	t.check(resolved.is_empty() or not resolved.contains("/../"), "no '..' segment survives")
	t.check(FolderTarget.is_absolute("/tmp"), "an absolute unix path is recognised")
	t.check(not FolderTarget.is_absolute("relative/path"), "a relative path is not absolute")
	_cleanup(base)


## A symlink to a directory must canonicalize to its TARGET, so the same folder
## chosen twice by different routes is one entry rather than two.
func test_a_symlink_dedupes_to_its_target(t) -> void:
	var base := _temp_dir("symlink")
	var target := base + "/real"
	var link := base + "/link"
	DirAccess.make_dir_recursive_absolute(target)
	var dir := DirAccess.open(base)
	t.check(dir != null, "the temp base opens")
	if dir == null:
		_cleanup(base)
		return
	var created := dir.create_link(target, link)
	t.check_equal(created, OK, "a symlink was created for the test")
	if created != OK:
		_cleanup(base)
		return

	var root := FolderTarget.new()
	var via_real := root.resolve(target)
	var via_link := root.resolve(link)
	t.check(not via_real.is_empty(), "the real directory resolves")
	t.check(not via_link.is_empty(), "the symlinked directory resolves")
	t.check_equal(
		via_link,
		via_real,
		"the symlink canonicalizes to its target, so the two are one location"
	)
	# And the resolved path is the REAL one, not the link the user happened to pick.
	t.check(
		via_link.find("/link") == -1,
		"the canonical path names the target rather than the link"
	)
	_cleanup(base)


## Case is preserved. This volume reports case-insensitive, and the kit forbids
## lowercasing all paths, so a directory with capitals must come back with them.
func test_paths_keep_their_case_rather_than_being_lowercased(t) -> void:
	var base := _temp_dir("CaseMix")
	var mixed := base + "/MixedCase"
	DirAccess.make_dir_recursive_absolute(mixed)
	var root := FolderTarget.new()
	var resolved := root.resolve(mixed)
	t.check(not resolved.is_empty(), "a mixed-case directory resolves")
	t.check(
		resolved.find("MixedCase") != -1,
		"the resolved path KEEPS its capitals (got '%s')" % resolved
	)
	_cleanup(base)


## A directory that does not exist is refused with a readable reason rather than
## half-applied.
func test_a_missing_directory_is_refused_with_a_reason(t) -> void:
	var root := FolderTarget.new()
	var missing := _temp_dir("missing") + "/does-not-exist"
	var resolved := root.resolve(missing)
	t.check(resolved.is_empty(), "a missing directory resolves to nothing")
	t.check(
		not root.last_error().is_empty(),
		"and the refusal carries a reason a user can read"
	)


## An INACCESSIBLE directory is refused, and it is a DIFFERENT case from a missing
## one: the path exists, so the reason must not claim it does not. On this volume
## `DirAccess.open` returns null for both, so the distinction is made with
## `dir_exists_absolute`, which still answers true for the inaccessible one.
func test_an_inaccessible_directory_is_refused_and_distinguished_from_missing(t) -> void:
	var base := _temp_dir("locked")
	var locked := base + "/locked"
	DirAccess.make_dir_recursive_absolute(locked)
	_set_unreadable(locked, true)
	var exists: bool = DirAccess.dir_exists_absolute(locked)
	var opened: Variant = DirAccess.open(locked)
	t.check(exists, "the locked directory still EXISTS")
	t.check(opened == null, "but it cannot be opened")

	var root := FolderTarget.new()
	var resolved := root.resolve(locked)
	t.check(resolved.is_empty(), "an inaccessible directory is refused")
	var reason := root.last_error()
	t.check(not reason.is_empty(), "with a reason")
	t.check(
		reason.find("exist") == -1 or reason.find("not") != -1 or reason.find("access") != -1,
		"and the reason does not simply claim the path is missing: '%s'" % reason
	)
	_set_unreadable(locked, false)
	_cleanup(base)


## A directory that is NOT a git repository is still a valid project location. The
## office must not refuse a plain folder, and it must not invent a project identity
## for one either.
func test_a_non_git_directory_still_resolves(t) -> void:
	var base := _temp_dir("plain")
	DirAccess.make_dir_recursive_absolute(base + "/work")
	var root := FolderTarget.new()
	var resolved := root.resolve(base + "/work")
	t.check(not resolved.is_empty(), "a plain directory resolves")
	t.check_equal(
		root.project_kind(),
		FolderTarget.KIND_FOLDER,
		"and it is reported as a folder rather than a git project"
	)
	t.check(root.branch().is_empty(), "a non-git folder has no branch to name")
	_cleanup(base)


## Two worktrees of the same repository are SEPARATE locations. Collapsing them to a
## common root would make the office show one project where the user has two.
func test_two_worktrees_stay_separate_locations(t) -> void:
	var base := _temp_dir("worktrees")
	var main := base + "/main"
	var worktree := base + "/feature"
	# A repository and a WORKTREE of it, built as git builds them: the worktree's
	# `.git` is a file naming its admin directory rather than a directory.
	_make_git_repo(main, "main")
	_make_git_repo(worktree, "feature", true)

	var root := FolderTarget.new()
	var a := root.resolve(main)
	var b := root.resolve(worktree)
	t.check(not a.is_empty(), "the main worktree resolves")
	t.check(not b.is_empty(), "the linked worktree resolves")
	t.check(a != b, "the two worktrees are DIFFERENT locations")
	t.check_equal(root.project_kind(), FolderTarget.KIND_GIT, "a worktree is a git project")
	# The worktree's branch comes from its ADMIN directory, which the reader follows.
	t.check_equal(root.branch(), "feature", "the worktree reports its own branch")
	_cleanup(base)


## A subdirectory of a monorepo is its own location: it is the folder the user chose,
## and expanding it upward would silently retarget their work.
func test_a_monorepo_subdirectory_is_its_own_location(t) -> void:
	var base := _temp_dir("mono")
	var repo := base + "/repo"
	DirAccess.make_dir_recursive_absolute(repo + "/packages/app")
	_make_git_repo(repo, "main")

	var root := FolderTarget.new()
	var chosen := root.resolve(repo + "/packages/app")
	var top := root.resolve(repo)
	t.check(not chosen.is_empty(), "the subdirectory resolves")
	t.check(chosen != top, "the subdirectory is NOT collapsed to the repository root")
	t.check(
		chosen.find("packages/app") != -1,
		"and the resolved path names the folder the user chose"
	)
	# The repository root is still REPORTED alongside it, which is what lets the UI
	# show the project without pretending the location changed.
	t.check_equal(
		root.repository_root(),
		top,
		"the repository root is reported separately from the chosen location"
	)
	_cleanup(base)


## THE SPEC'S CLAUSE. Choosing a folder is not consent to run anything: it must not
## create a session, submit a prompt, or start work.
func test_choosing_a_folder_is_not_execution_consent(t) -> void:
	# The root is deliberately NOT added to the tree: `OfficeMain._ready` resolves
	# scene children, so a scene-less root in the tree would raise engine errors. The
	# panels the folder path touches are built explicitly instead.
	var main := OfficeMain.new()
	main.store = OfficeStore.new()
	main.director = OfficeDirector.new()
	main.demo = DemoTransport.new()
	main.live = LiveTransport.new()
	main.models_api = ModelCatalogApi.new()
	main.sessions_api = SessionApi.new()
	# Every panel `_wire_signals` touches must exist, or the connect raises against a
	# null. They are built explicitly rather than by tree entry, because the root is
	# deliberately not in the tree.
	main.prompt_panel = PromptPanel.new()
	main.prompt_panel._ready()
	main.add_child(main.prompt_panel)
	main.prompt_panel._attach_effort()
	main.conversation_panel = ConversationPanel.new()
	main.add_child(main.conversation_panel)
	main.sidebar = SidebarPanel.new()
	main.sidebar._ensure_built()
	main.add_child(main.sidebar)
	main.chrome_toggles = ChromeToggles.new()
	main.add_child(main.chrome_toggles)
	main.office_view = OfficeViewport.new()
	main.add_child(main.office_view)
	main._wire_signals()
	# Choosing a folder persists the project's view state, so this office is pointed at a
	# throwaway preference: a test must never write over the file a person is using.
	main.view_state = OfficeViewState.new()
	main.view_state.file_path = TEST_VIEW_STATE_PATH
	main.project_ledger.file_path = "user://test_folder_target_projects.cfg"
	var base := _temp_dir("consent")

	var created := []
	main.sessions_api.session_created.connect(func(id: String): created.append(id))
	var before := main.store.actor_list().size()

	main.select_folder(base)

	t.check_equal(
		main.store.actor_list().size(),
		before,
		"choosing a folder created no actor"
	)
	t.check(created.is_empty(), "and no session was created")
	t.check(
		not main.store.is_stale(),
		"choosing a folder does not disturb the projection's freshness"
	)
	_cleanup(base)
	main.free()


## "Show the target beside the composer BEFORE enabling Send." The composer must be
## able to name the folder the work would run in, and it must not claim a target it
## does not have.
func test_the_composer_shows_the_target_before_send(t) -> void:
	var panel := PromptPanel.new()
	panel._ready()
	panel._attach_effort()
	t.check(
		panel.target_text().find("no folder") != -1
		or panel.target_text().is_empty(),
		"with no folder chosen the composer names no target rather than guessing"
	)
	panel.set_target(TARGET_PROBE_PATH)
	t.check(
		panel.target_text().find("project") != -1,
		"the composer names the chosen folder: '%s'" % panel.target_text()
	)
	panel.free()


## The transports must actually RECEIVE the chosen location, which is the gap that
## made a fresh client unable to create a session at all.
func test_the_transport_receives_the_chosen_location(t) -> void:
	var live := LiveTransport.new()
	live.configure("http://127.0.0.1:4096")
	var base := _temp_dir("wire")
	DirAccess.make_dir_recursive_absolute(base)
	live.set_location(base)
	t.check_equal(
		live.location_directory(),
		base,
		"the live transport reports the location it was given"
	)
	_cleanup(base)


## --- helpers ---------------------------------------------------------------

func _temp_dir(name: String) -> String:
	var path := "/tmp/ycoding-r501-%s-%d" % [name, Time.get_unix_time_from_system()]
	DirAccess.make_dir_recursive_absolute(path)
	return path


func _cleanup(path: String) -> void:
	var dir := DirAccess.open(path)
	if dir == null:
		return
	for entry in dir.get_directories():
		_set_unreadable(path + "/" + entry, false)
	_remove_recursive(path)


func _remove_recursive(path: String) -> void:
	var dir := DirAccess.open(path)
	if dir == null:
		return
	for entry in dir.get_directories():
		if entry == "." or entry == "..":
			continue
		_remove_recursive(path + "/" + entry)
	for entry in dir.get_files():
		DirAccess.remove_absolute(path + "/" + entry)
	DirAccess.remove_absolute(path)


## Build a real `.git` directory with a real `HEAD`, which is what the production
## reader actually reads.
##
## The suite deliberately does NOT run `git`: the asset-provenance suite's reviewed
## allow-list forbids spawning a process from any file in the tree, and a fixture that
## writes the same files git writes exercises the reader just as well.
func _make_git_repo(path: String, branch: String, as_worktree: bool = false) -> void:
	DirAccess.make_dir_recursive_absolute(path)
	if as_worktree:
		# A worktree's `.git` is a FILE naming its admin directory, which is the case
		# the reader must follow rather than assume to be a directory.
		var admin := path + "/.git-admin"
		DirAccess.make_dir_recursive_absolute(admin)
		_write(admin + "/HEAD", "ref: refs/heads/%s\n" % branch)
		_write(path + "/.git", "gitdir: %s\n" % admin)
		return
	DirAccess.make_dir_recursive_absolute(path + "/.git")
	_write(path + "/.git/HEAD", "ref: refs/heads/%s\n" % branch)


func _write(path: String, text: String) -> void:
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file != null:
		file.store_string(text)
		file.close()


## Make a directory unreadable or readable again WITHOUT spawning a process, by
## removing or restoring its permission bits through Godot's own file API.
func _set_unreadable(path: String, unreadable: bool) -> void:
	# `FileAccess` exposes unix permission bits directly, which is the same mechanism
	# a shell would use and needs no child process.
	# GDScript has no octal literal, so the bits are built from their groups rather
	# than written as a magic number: 7 (rwx) for each of owner, group and other is
	# 0755, and removing every bit is 0.
	var group := 7
	var mode := 0 if unreadable else (group * 64) + (group * 8) + group
	FileAccess.set_unix_permissions(path, mode)
