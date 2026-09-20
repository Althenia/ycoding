## Per-project desktop view state tests (R5-05).
##
## The acceptance is: "Restore last route, session, draft, camera and safe position;
## no credentials in preferences."
##
## The kit fixes the shape: `UIViewState(entry_id, selected_session_id, unsent_draft,
## selected_actor_id, camera_state, player_position, view_route)`, it is DISPOSABLE
## desktop data rather than runtime authority, a saved player position is validated
## against the current map and recovered to an unblocked spawn, no token or credential
## belongs in it, and the store is atomic, schema-versioned and recovers from corrupt
## data.
##
## Each clause fails differently, so each is a separate property:
##
##   * ROUND TRIP - what was remembered is what is restored, per project;
##   * CREDENTIALS - only the declared fields can reach the file, so a credential
##     cannot, asserted by the saved text rather than by the object;
##   * SCHEMA - the file declares its version, and a version this build does not know
##     is not adopted;
##   * CORRUPTION - a damaged file is survived, with a readable reason;
##   * SAFE POSITION - a saved position on a blocked cell or off the map recovers to an
##     unblocked spawn;
##   * ATOMICITY - a write goes through a temporary file, so a failed write cannot
##     leave a half-written preference behind.
##
## Persistence uses throwaway files under `user://` that are removed again, so the
## suite never touches a real preference.
extends RefCounted


const TEST_PATH := "user://test_view_state.cfg"


func run(t) -> void:
	test_state_round_trips_per_project(t)
	test_each_project_keeps_its_own_state(t)
	test_only_declared_fields_can_reach_the_file(t)
	test_no_credential_ever_reaches_the_file(t)
	test_the_file_declares_its_schema_version(t)
	test_an_unknown_schema_version_is_not_adopted(t)
	test_a_corrupt_file_recovers_with_a_reason(t)
	test_a_position_outside_the_map_recovers_to_a_spawn(t)
	test_a_position_on_a_blocked_cell_recovers_to_a_spawn(t)
	test_a_usable_position_is_kept(t)
	test_a_saved_camera_is_validated_against_the_map(t)
	test_a_route_that_does_not_exist_is_not_restored(t)
	test_the_write_is_atomic_and_leaves_no_partial_file(t)


## A tiny map: row 0 is blocked, rows 1-3 are free. Small enough to reason about
## exactly, and built directly because the blocker rule is what is under test - not the
## real office's furniture.
func _navigation() -> OfficeNavigation:
	var navigation := OfficeNavigation.new()
	navigation.build(
		4, 4,
		[{"cell": Vector2i(0, 0), "size": Vector2i(4, 1), "blocking": true}],
		{}
	)
	return navigation


func _state(draft: String = "half-written thought") -> Dictionary:
	return {
		"selected_session_id": "ses_alpha",
		"selected_actor_id": "ses_alpha",
		"unsent_draft": draft,
		"view_route": OfficeRoute.SESSIONS,
		"camera_state": {"position": Vector2(64.0, 96.0), "zoom": 1.5},
		"player_position": Vector2(80.0, 80.0),
	}


## What was remembered for a project is what is restored for it.
func test_state_round_trips_per_project(t) -> void:
	var store := OfficeViewState.new()
	store.remember("entry-a", _state())
	t.check_equal(store.save(TEST_PATH), OK, "the state is written")

	var reloaded := OfficeViewState.new()
	reloaded.load(TEST_PATH)
	t.check_equal(reloaded.last_error(), "", "a clean file reports no fault")
	var restored := reloaded.state_for("entry-a")
	t.check_equal(
		str(restored.get("unsent_draft", "")), "half-written thought",
		"the draft is restored"
	)
	t.check_equal(
		str(restored.get("selected_session_id", "")), "ses_alpha",
		"the session is restored"
	)
	t.check_equal(
		str(restored.get("view_route", "")), OfficeRoute.SESSIONS,
		"the route is restored"
	)
	var camera: Dictionary = restored.get("camera_state", {})
	t.check_equal(
		int(camera.get("zoom", 0.0) * 100.0), 150,
		"the camera zoom is restored"
	)
	DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))


## A draft belongs to the project it was typed in. Restoring one project's draft into
## another is the same class of defect as sending work to the wrong folder.
func test_each_project_keeps_its_own_state(t) -> void:
	var store := OfficeViewState.new()
	store.remember("entry-a", _state("alpha draft"))
	store.remember("entry-b", _state("beta draft"))
	t.check_equal(store.save(TEST_PATH), OK, "both projects are written")

	var reloaded := OfficeViewState.new()
	reloaded.load(TEST_PATH)
	t.check_equal(
		str(reloaded.state_for("entry-a").get("unsent_draft", "")), "alpha draft",
		"the first project keeps its own draft"
	)
	t.check_equal(
		str(reloaded.state_for("entry-b").get("unsent_draft", "")), "beta draft",
		"the second project keeps its own draft"
	)
	t.check(
		reloaded.state_for("entry-unknown").is_empty(),
		"a project with no saved state has none rather than another project's"
	)
	DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))


## The store copies only the declared fields, so an undeclared one cannot be written.
func test_only_declared_fields_can_reach_the_file(t) -> void:
	var dirty := _state()
	dirty["something_undeclared"] = "should not be stored"
	dirty["nested"] = {"deeper": "also not stored"}
	var store := OfficeViewState.new()
	store.remember("entry-a", dirty)

	var restored := store.state_for("entry-a")
	t.check(
		not restored.has("something_undeclared"),
		"an undeclared field is not kept"
	)
	t.check(not restored.has("nested"), "nor is an undeclared nested field")
	t.check_equal(
		str(restored.get("unsent_draft", "")), "half-written thought",
		"the declared fields are still kept"
	)


## The credential clause, asserted against the FILE rather than against the object: a
## value that never reaches the object also never reaches the disk.
func test_no_credential_ever_reaches_the_file(t) -> void:
	var store := OfficeViewState.new()
	var secretive := _state()
	secretive["password"] = "hunter2-secret-value"
	secretive["token"] = "tok-secret-value"
	secretive["authorization"] = "Bearer secret-value"
	secretive["api_key"] = "key-secret-value"
	secretive["base_url"] = "http://127.0.0.1:4399/?password=secret-value"
	store.remember("entry-a", secretive)
	t.check_equal(store.save(TEST_PATH), OK, "the state is written")

	var text := FileAccess.get_file_as_string(TEST_PATH)
	for probe in ["hunter2-secret-value", "tok-secret-value", "Bearer secret-value",
			"key-secret-value", "password=secret-value"]:
		t.check(
			not text.contains(probe),
			"the saved preference never carries '%s'" % probe
		)
	t.check(
		not text.to_lower().contains("password"),
		"the saved preference names no credential field at all"
	)
	DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))


## A versioned file lets a newer build change the shape without a reader guessing.
func test_the_file_declares_its_schema_version(t) -> void:
	var store := OfficeViewState.new()
	store.remember("entry-a", _state())
	t.check_equal(store.save(TEST_PATH), OK, "the state is written")
	var config := ConfigFile.new()
	t.check_equal(config.load(TEST_PATH), OK, "the file is a readable preference")
	t.check(
		config.has_section_key(OfficeViewState.SECTION, OfficeViewState.VERSION_KEY),
		"the file declares its schema version"
	)
	t.check_equal(
		int(config.get_value(OfficeViewState.SECTION, OfficeViewState.VERSION_KEY, -1)),
		OfficeViewState.SCHEMA_VERSION,
		"and the version is the one this build writes"
	)
	DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))


## A file written by a build this one does not understand is NOT adopted: guessing at an
## unknown shape is how a preference store reads nonsense as state.
func test_an_unknown_schema_version_is_not_adopted(t) -> void:
	var config := ConfigFile.new()
	config.set_value(OfficeViewState.SECTION, OfficeViewState.VERSION_KEY, OfficeViewState.SCHEMA_VERSION + 7)
	config.set_value(OfficeViewState.SECTION, "states", {"entry-a": _state()})
	t.check_equal(config.save(TEST_PATH), OK, "a future-version file is written")

	var store := OfficeViewState.new()
	store.load(TEST_PATH)
	t.check(
		store.state_for("entry-a").is_empty(),
		"a file from an unknown schema version is not adopted"
	)
	t.check(
		not store.last_error().is_empty(),
		"and the reason is readable rather than silent"
	)
	DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))


## A damaged file is survived. The alternative - raising, or adopting whatever parsed -
## would either break the launch or present nonsense as the user's own state.
func test_a_corrupt_file_recovers_with_a_reason(t) -> void:
	var file := FileAccess.open(TEST_PATH, FileAccess.WRITE)
	file.store_string("this is not a preference file at all")
	file.close()
	var store := OfficeViewState.new()
	store.load(TEST_PATH)
	t.check(
		store.state_for("entry-a").is_empty(),
		"a corrupt file yields no state rather than nonsense"
	)
	t.check(not store.last_error().is_empty(), "and says what happened")
	# Recovery means the store is still usable, not merely non-crashing.
	store.remember("entry-a", _state("after recovery"))
	t.check_equal(store.save(TEST_PATH), OK, "the store recovers by writing again")
	var reloaded := OfficeViewState.new()
	reloaded.load(TEST_PATH)
	t.check_equal(
		str(reloaded.state_for("entry-a").get("unsent_draft", "")), "after recovery",
		"and the recovered state reads back"
	)
	DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))


## A position off the map cannot be restored: the map has changed, or the file is
## damaged, and either way the user would be looking at nothing.
func test_a_position_outside_the_map_recovers_to_a_spawn(t) -> void:
	var navigation := _navigation()
	var spawn := OfficeViewState.recover_position(navigation)
	t.check(
		not navigation.is_blocked(OfficeViewState.cell_of(spawn)),
		"the recovery spawn is an unblocked cell"
	)
	for bogus in [Vector2(-500.0, 90.0), Vector2(900.0, 40.0), Vector2(64.0, 9999.0)]:
		t.check_equal(
			OfficeViewState.safe_position(bogus, navigation), spawn,
			"a position off the map recovers to the spawn: %s" % str(bogus)
		)


## A position on a wall or a desk cannot be restored either: the avatar would be inside
## the geometry, which is exactly what "safe position" forbids.
func test_a_position_on_a_blocked_cell_recovers_to_a_spawn(t) -> void:
	var navigation := _navigation()
	var spawn := OfficeViewState.recover_position(navigation)
	var in_wall := Vector2(1, 0) * OfficeNavigation.TILE + OfficeNavigation.CENTRE_OFFSET
	t.check(navigation.is_blocked(OfficeViewState.cell_of(in_wall)), "the cell is a wall")
	t.check_equal(
		OfficeViewState.safe_position(in_wall, navigation), spawn,
		"a position standing on a blocked cell recovers to the spawn"
	)
	# A saved position that is not a position at all recovers too, rather than being
	# coerced into one.
	for rubbish in [null, "somewhere", [], 42]:
		t.check_equal(
			OfficeViewState.safe_position(rubbish, navigation), spawn,
			"a saved position that is not a position recovers to the spawn"
		)


## A usable position is KEPT. Recovering always would silently discard the state this
## exists to restore.
func test_a_usable_position_is_kept(t) -> void:
	var navigation := _navigation()
	var standing := Vector2(2, 2) * OfficeNavigation.TILE + OfficeNavigation.CENTRE_OFFSET
	t.check(not navigation.is_blocked(OfficeViewState.cell_of(standing)), "the cell is free")
	t.check_equal(
		OfficeViewState.safe_position(standing, navigation), standing,
		"a position on a free cell is restored as saved"
	)


## The camera is validated for the same reason the position is: a view parked off the
## map shows the user nothing. The zoom bound is the VIEWPORT's to decide, so a zoom
## this store cannot vouch for is dropped rather than guessed at.
func test_a_saved_camera_is_validated_against_the_map(t) -> void:
	var navigation := _navigation()
	var good := OfficeViewState.safe_camera(
		{"position": Vector2(48.0, 48.0), "zoom": 1.25}, navigation
	)
	t.check_equal(int(good.get("zoom", 0.0) * 100.0), 125, "a sane zoom is kept")
	var camera_position: Vector2 = good.get("position", Vector2.ZERO)
	t.check(
		camera_position.x >= 0.0 and camera_position.x <= navigation.width * OfficeNavigation.TILE,
		"and the position stays inside the map"
	)
	var far := OfficeViewState.safe_camera(
		{"position": Vector2(99999.0, -99999.0), "zoom": 1.0}, navigation
	)
	var far_position: Vector2 = far.get("position", Vector2.ZERO)
	t.check(
		far_position.x >= 0.0
		and far_position.x <= navigation.width * OfficeNavigation.TILE
		and far_position.y >= 0.0
		and far_position.y <= navigation.height * OfficeNavigation.TILE,
		"a camera off the map is brought back inside it"
	)
	# A zoom the store cannot vouch for is omitted, so the viewport fits the world.
	for rubbish in [0.0, -3.0, "wide", null, INF, NAN]:
		t.check(
			not OfficeViewState.safe_camera({"position": Vector2(48.0, 48.0), "zoom": rubbish}, navigation).has("zoom"),
			"an unusable zoom is dropped rather than guessed: %s" % str(rubbish)
		)


## The route is a closed set, so a saved route that this build does not have is not
## restored. The office is the default surface by contract.
func test_a_route_that_does_not_exist_is_not_restored(t) -> void:
	var store := OfficeViewState.new()
	var stale := _state()
	stale["view_route"] = "a-route-from-a-newer-build"
	store.remember("entry-a", stale)
	var restored := store.state_for("entry-a")
	t.check_equal(
		str(restored.get("view_route", "")), OfficeRoute.DEFAULT,
		"an unknown route falls back to the default surface"
	)
	# And a route that does exist is kept.
	store.remember("entry-b", _state())
	t.check_equal(
		str(store.state_for("entry-b").get("view_route", "")), OfficeRoute.SESSIONS,
		"a route that exists is kept"
	)


## The write goes through a temporary file, and the PREVIOUS state survives a write that
## cannot complete.
##
## The decisive observation is not "no temporary file is left behind" - that is trivially
## true of an implementation that never uses one, and asserting only that let a
## straight-to-target write pass this suite. The temporary path is OCCUPIED by a
## directory instead, so a write that truly goes through it cannot complete while a write
## straight to the target would. The failing write must also leave the previous state
## intact, which is the whole point of publishing by rename.
func test_the_write_is_atomic_and_leaves_no_partial_file(t) -> void:
	var store := OfficeViewState.new()
	store.remember("entry-a", _state("original draft"))
	t.check_equal(store.save(TEST_PATH), OK, "the first write succeeds")
	t.check(
		not FileAccess.file_exists(OfficeViewState.temp_path(TEST_PATH)),
		"the temporary file is consumed once the write settles"
	)

	# Occupy the temporary path, so the write cannot go through it. A store that wrote
	# straight to the target would succeed here and pass the assertions below vacuously.
	var temp := OfficeViewState.temp_path(TEST_PATH)
	var blocked := DirAccess.make_dir_absolute(ProjectSettings.globalize_path(temp))
	t.check_equal(blocked, OK, "the temporary path is occupied")
	t.check(
		store.save(TEST_PATH) != OK,
		"a write that cannot go through its temporary file reports failure"
	)
	t.check(
		not FileAccess.file_exists(temp),
		"and no temporary file stands where the directory is"
	)
	# The payoff: the state that was already there is still the whole truth.
	var survived := OfficeViewState.new()
	survived.load(TEST_PATH)
	t.check_equal(
		str(survived.state_for("entry-a").get("unsent_draft", "")), "original draft",
		"the previous state survives a write that could not complete"
	)
	DirAccess.remove_absolute(ProjectSettings.globalize_path(temp))

	# A later write replaces it wholesale, and the replacement is what the file holds.
	store.remember("entry-a", _state("replacement draft"))
	t.check_equal(store.save(TEST_PATH), OK, "a later write succeeds")
	t.check(
		not FileAccess.file_exists(temp),
		"and leaves no temporary behind"
	)
	var reloaded := OfficeViewState.new()
	reloaded.load(TEST_PATH)
	t.check_equal(
		str(reloaded.state_for("entry-a").get("unsent_draft", "")), "replacement draft",
		"the replacement is what the file holds"
	)

	# A write that CANNOT succeed reports the failure and creates nothing.
	var unreachable := "user://no-such-directory-xyz/view.cfg"
	t.check(
		store.save(unreachable) != OK,
		"a write to an impossible path reports failure rather than claiming success"
	)
	t.check(
		not FileAccess.file_exists(unreachable),
		"and no partial file appears at the failed path"
	)
	DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))
