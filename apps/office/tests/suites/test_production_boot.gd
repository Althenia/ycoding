## Production boot tests (R1-01, R1-02).
##
## The composition root decides which transport owns the office. These pin the
## rule this repair establishes:
##
##   * a normal launch attaches to the registered local service, and otherwise
##     renders an honest disconnected office that names what is missing and offers
##     a retry;
##   * synthetic playback is reached only through the explicit demo action;
##   * a LIVE office never adopts the synthetic model catalogue, so a failed model
##     read leaves the composer list empty with the service's own refusal reason.
##
## The boot decision is driven directly rather than through `_ready`: `_ready` is
## the only production caller and needs the real scene, while the panels are wired
## here exactly as `_ready` wires them, so `_refresh_ui` runs its real path.
##
## Discovery is pointed at a path that exists nowhere, so a launch case never
## depends on whether the machine running the suite happens to have a service
## registered.
extends RefCounted

## A path that exists nowhere. Empty and missing inputs are both skipped by
## `ServiceRegistration.candidates`, which is why restoring an unset variable to
## "" is equivalent to not having set it.
const MISSING_SERVICE_FILE := "/nonexistent-ycoding-office-test"

## A loopback address nothing is listening on. Port 1 is reserved and never
## served, so an attach attempt is refused rather than answered, which is exactly
## the failed-service case under test.
## Where the office under test persists its view state. Never the real preference.
const TEST_VIEW_STATE_PATH := "user://test_boot_view_state.cfg"

const REGISTERED_URL := "http://127.0.0.1:1"

## The value a registration carries in its optional credential field. Named
## neutrally on purpose: it is not a real secret and must never be treated as one.
const REGISTERED_VALUE := "synthetic-test-value"


func run(t) -> void:
	var preference_existed := FileAccess.file_exists(ProjectLedger.DEFAULT_PATH)
	var preference_digest := FileAccess.get_sha256(ProjectLedger.DEFAULT_PATH) if preference_existed else ""
	test_a_launch_without_a_registration_fabricates_nothing(t)
	test_the_disconnected_rail_offers_a_wired_retry(t)
	test_retrying_without_a_registration_keeps_the_composer_draft(t)
	test_a_registration_attaches_live_without_a_toggle(t)
	test_the_first_attach_reads_the_canonical_state_once(t)
	test_a_reconnect_reads_the_canonical_state_again(t)
	test_the_registered_value_reaches_the_transport_and_is_never_rendered(t)
	test_live_never_installs_the_synthetic_catalogue(t)
	test_a_live_state_change_never_installs_the_synthetic_catalogue(t)
	test_demo_still_offers_the_labelled_synthetic_catalogue(t)
	test_demo_is_reached_only_through_the_explicit_action(t)
	test_leaving_demo_without_a_service_discards_the_synthetic_office(t)
	test_a_prompt_id_survives_the_retry_it_must_reconcile(t)
	test_a_different_draft_gets_its_own_prompt_id(t)
	test_the_id_is_retired_by_durable_admission_not_by_the_request(t)
	test_another_inputs_admission_does_not_retire_the_draft(t)
	test_the_send_reports_admission_not_completion(t)
	test_the_same_text_aimed_at_two_projects_is_two_inputs(t)
	test_a_retry_aimed_at_the_same_project_still_reconciles(t)
	test_the_composer_names_the_project_the_prompt_would_reach(t)
	test_a_model_chosen_for_one_project_does_not_follow_into_another(t)
	test_another_projects_transcript_never_appears(t)
	test_switching_project_re_reads_the_catalogue_for_that_project(t)
	test_a_late_catalogue_answer_cannot_overwrite_another_project(t)
	test_switching_project_neither_cancels_nor_moves_in_flight_work(t)
	test_switching_project_writes_and_restores_each_projects_view_state(t)
	test_a_saved_session_is_not_restored_when_it_is_not_in_the_roster(t)
	t.check_equal(FileAccess.file_exists(ProjectLedger.DEFAULT_PATH), preference_existed, "boot tests preserve real project preference existence")
	if preference_existed:
		t.check_equal(FileAccess.get_sha256(ProjectLedger.DEFAULT_PATH), preference_digest, "boot tests preserve real project preference bytes")


## A composition root wired the way `_ready` wires it, without the scene. The
## panels are children of the root so freeing the root frees them, and the root is
## never inside a tree, so no `_ready` fires on its own. The two panels that need
## building are built explicitly, which is how the other suites drive them too.
func _bootable() -> OfficeMain:
	var main := OfficeMain.new()
	main.store = OfficeStore.new()
	main.director = OfficeDirector.new()
	main.demo = DemoTransport.new()
	main.live = LiveTransport.new()
	main.models_api = ModelCatalogApi.new()
	main.sessions_api = SessionApi.new()
	main.prompt_panel = PromptPanel.new()
	main.prompt_panel._ready()
	main.add_child(main.prompt_panel)
	# This fixture is freed before deferred scene-tree attachment can run.
	main.prompt_panel._attach_effort()
	main.sidebar = SidebarPanel.new()
	main.sidebar._ensure_built()
	main.add_child(main.sidebar)
	main.conversation_panel = ConversationPanel.new()
	main.add_child(main.conversation_panel)
	main.chrome_toggles = ChromeToggles.new()
	main.add_child(main.chrome_toggles)
	# The viewport's `_ready` resolves nodes from the scene, so it is built but
	# never readied: its world stays null and `refresh` is a no-op, which is the
	# state a boot decision test needs.
	main.office_view = OfficeViewport.new()
	main.add_child(main.office_view)
	# Choosing a folder persists the project's view state, so this office is pointed at a
	# throwaway preference: a test must never write over the file a person is using.
	main.view_state = OfficeViewState.new()
	main.view_state.file_path = TEST_VIEW_STATE_PATH
	main.project_ledger.file_path = "user://test_boot_projects.cfg"
	main._wire_signals()
	return main


## Point discovery at a file that does not exist, returning what was there.
func _hide_registration() -> Dictionary:
	var previous := {
		"YCODING_SERVICE_FILE": OS.get_environment("YCODING_SERVICE_FILE"),
		"XDG_STATE_HOME": OS.get_environment("XDG_STATE_HOME"),
		"HOME": OS.get_environment("HOME"),
	}
	OS.set_environment("YCODING_SERVICE_FILE", MISSING_SERVICE_FILE)
	OS.set_environment("XDG_STATE_HOME", MISSING_SERVICE_FILE)
	OS.set_environment("HOME", MISSING_SERVICE_FILE)
	return previous


func _restore_environment(previous: Dictionary) -> void:
	for name in previous:
		OS.set_environment(str(name), str(previous[name]))


## AC1. A launch with no service registration must not fabricate an office, and it
## must say what is missing and how to fix it.
func test_a_launch_without_a_registration_fabricates_nothing(t) -> void:
	var main := _bootable()
	main._boot_with({})
	t.check_equal(
		main.store.mode,
		OfficeStore.MODE_LIVE,
		"the office boots onto the live path, not into synthetic playback"
	)
	t.check_equal(
		main.store.connection_state,
		OfficeStore.CONNECTION_DISCONNECTED,
		"the disconnected state is stated rather than left as a healthy default"
	)
	t.check(main.store.actors.is_empty(), "no actor is fabricated")
	t.check(main.store.interactions.is_empty(), "no synthetic history is recorded")
	t.check_equal(main.store.root_session_id, "", "no synthetic root session is adopted")
	t.check(not main.demo.is_playing(), "synthetic playback is not started")
	t.check(not main.live.is_playing(), "no live feed is claimed either")

	# The message is the whole point of the state: an empty office with no next
	# step reads as broken.
	var message := main.store.last_error
	t.check(not message.is_empty(), "the state says what is missing")
	t.check(message.find("service.json") != -1, "it names the registration that was not found")
	t.check(message.find("ycoding service start") != -1, "it names the command that fixes it")
	t.check_equal(
		main.sidebar._detail_label.text,
		message,
		"the rail states the actionable message"
	)
	t.check_equal(
		main.sidebar._detail_label.get_theme_color("font_color"),
		OfficeTheme.danger(),
		"a disconnected office is not painted as healthy"
	)
	main.free()


## AC1. The retry affordance is reachable: it is part of the rail, and the rail's
## signal reaches the connection path.
func test_the_disconnected_rail_offers_a_wired_retry(t) -> void:
	var main := _bootable()
	main._boot_with({})
	t.check(main.sidebar.retry_available(), "a disconnected LIVE office offers a retry")
	t.check(
		main.sidebar.retry_connection_requested.is_connected(main._retry_connection),
		"the retry affordance is wired to the connection path"
	)
	main.free()


## AC1. A failed connection must not cost the user what they typed.
func test_retrying_without_a_registration_keeps_the_composer_draft(t) -> void:
	var main := _bootable()
	main._boot_with({})
	var previous := _hide_registration()
	main.prompt_panel._input.text = "work in progress"
	main.sidebar._retry_button.pressed.emit()
	_restore_environment(previous)
	t.check_equal(
		main.store.mode,
		OfficeStore.MODE_LIVE,
		"a failed retry stays on the live path"
	)
	t.check(not main.demo.is_playing(), "a failed retry never falls back to synthetic playback")
	t.check_equal(
		main.prompt_panel.current_text(),
		"work in progress",
		"the composer draft survives the failed connection"
	)
	t.check(main.store.actors.is_empty(), "and still no actor is fabricated")
	main.free()


## AC2. A registered service is attached with no user action.
func test_a_registration_attaches_live_without_a_toggle(t) -> void:
	var main := _bootable()
	main._boot_with({"url": REGISTERED_URL, "pid": 4242})
	t.check_equal(main.store.mode, OfficeStore.MODE_LIVE, "the office is LIVE")
	t.check_equal(
		main.live.base_url(),
		REGISTERED_URL,
		"it attached to the registered address"
	)
	t.check(main.live.is_playing(), "the live transport is running")
	t.check(not main.demo.is_playing(), "the synthetic transport is not started")
	t.check(main.store.actors.is_empty(), "the attach itself fabricates nothing")
	t.check_equal(
		main.store.connection_state,
		OfficeStore.CONNECTION_SYNCING,
		"it does not claim a connection before the service answers"
	)
	t.check(
		main.sidebar.retry_available(),
		"an unconfirmed attach still offers the retry affordance"
	)
	main.live.stop()
	main.free()


## R1-02. The registration's credential reaches the transport and is never placed
## in anything a user can see.
func test_the_registered_value_reaches_the_transport_and_is_never_rendered(t) -> void:
	var main := _bootable()
	main._boot_with({"url": REGISTERED_URL, "pid": 4242, "password": REGISTERED_VALUE})
	t.check_equal(
		str(main.live.credentials().get("password", "")),
		REGISTERED_VALUE,
		"the registration's value reaches the transport"
	)
	t.check_equal(
		main.prompt_panel.current_text().find(REGISTERED_VALUE),
		-1,
		"the composer never renders it"
	)
	t.check_equal(
		main.sidebar._detail_label.text.find(REGISTERED_VALUE),
		-1,
		"the rail never renders it"
	)
	t.check_equal(
		main.store.last_error.find(REGISTERED_VALUE),
		-1,
		"and it is never copied into user-visible state"
	)
	main.live.stop()
	main.free()


## AC4 / D2. A LIVE office must never adopt the synthetic catalogue, and a failed
## model read must surface the service's own refusal.
func test_live_never_installs_the_synthetic_catalogue(t) -> void:
	var main := _bootable()
	main._boot_with({"url": REGISTERED_URL, "pid": 4242})
	# The read settles on the frame loop, so the loop is driven here the way `_process`
	# drives it - bounded by the read's own budget, so an unresponsive port cannot hang
	# the suite.
	var deadline := Time.get_ticks_msec() + 8000
	while main.models_api.is_pending() and Time.get_ticks_msec() < deadline:
		main._settle_models()
		OS.delay_msec(1)
	t.check(
		not main.models_api.is_pending(),
		"the read settles within its budget instead of staying in flight"
	)
	t.check(
		main.prompt_panel._models.is_empty(),
		"the composer offers no model after the read failed"
	)
	t.check(
		not ModelCatalog.is_demo_catalog(main.prompt_panel._models),
		"the synthetic catalogue is not installed in LIVE"
	)
	t.check_equal(main.prompt_panel.pill_text(), "No models", "the composer says there are none")
	t.check(main.prompt_panel._pill.disabled, "and the pill cannot act")
	t.check(not main.store.last_error.is_empty(), "the service's real refusal is surfaced")
	t.check_equal(
		main.store.last_error,
		main.models_api.last_error(),
		"the surfaced reason is the model reader's own, not a fabricated one"
	)
	main.live.stop()
	main.free()


## D2. `_refresh_ui` runs on every state change, so the guard has to be in the
## catalogue lookup rather than only at fetch time.
func test_a_live_state_change_never_installs_the_synthetic_catalogue(t) -> void:
	var main := _bootable()
	main.store.mode = OfficeStore.MODE_LIVE
	main._refresh_ui()
	t.check(main.prompt_panel._models.is_empty(), "a LIVE refresh installs no model list")
	t.check(
		not ModelCatalog.is_demo_catalog(main.prompt_panel._models),
		"certainly not the synthetic one"
	)
	main._on_event({"type": Wire.CONNECTED, "sessionID": "", "data": {}, "sourceEpoch": "epoch-live"})
	t.check(
		main.prompt_panel._models.is_empty(),
		"a later event refresh still installs none"
	)
	main.free()


## The mirror: DEMO still offers the synthetic set, so removing the LIVE fallback
## does not remove the labelled preview.
func test_demo_still_offers_the_labelled_synthetic_catalogue(t) -> void:
	var main := _bootable()
	main.store.mode = OfficeStore.MODE_DEMO
	main._refresh_ui()
	t.check(
		ModelCatalog.is_demo_catalog(main.prompt_panel._models),
		"the DEMO catalogue in play is identified as synthetic"
	)
	main.free()


## AC3. DEMO is reached only through the explicit action, and it stays labelled.
func test_demo_is_reached_only_through_the_explicit_action(t) -> void:
	var main := _bootable()
	main._boot_with({})
	t.check_equal(main.store.mode, OfficeStore.MODE_LIVE, "the boot did not enter DEMO")
	t.check(not main.demo.is_playing(), "and started no synthetic playback")
	main.start_demo_mode()
	t.check_equal(main.store.mode, OfficeStore.MODE_DEMO, "the explicit action enters DEMO")
	t.check(main.demo.is_playing(), "and the synthetic clock runs")
	t.check(
		ModelCatalog.is_demo_catalog(main.prompt_panel._models),
		"the synthetic catalogue is in play and labelled"
	)
	t.check_equal(main.sidebar.mode_text(), OfficeStore.MODE_DEMO, "the rail names DEMO")
	t.check(
		main.sidebar._detail_label.text.find("Synthetic") != -1,
		"and states that playback is synthetic"
	)
	t.check(not main.sidebar.retry_available(), "DEMO offers no connection retry")
	main.free()


## Leaving DEMO for LIVE with nothing to attach to must not leave synthetic work
## on screen under a LIVE badge. The actors, their history and the synthetic clock
## all belong to DEMO and are discarded when it is left, however the transition was
## reached.
func test_leaving_demo_without_a_service_discards_the_synthetic_office(t) -> void:
	var main := _bootable()
	main._boot_with({})
	main.start_demo_mode()
	# Synthetic playback has produced real state by now, so the test would fail on
	# an empty office for the wrong reason.
	main.demo.advance(20000)
	t.check(
		not main.store.actors.is_empty(),
		"synthetic playback populated the office, which is what must be discarded"
	)
	var previous := _hide_registration()
	main._on_mode_toggle()
	_restore_environment(previous)
	t.check_equal(main.store.mode, OfficeStore.MODE_LIVE, "the toggle enters the live path")
	t.check(not main.demo.is_playing(), "synthetic playback is stopped")
	t.check(main.store.actors.is_empty(), "no synthetic actor survives the transition")
	t.check(main.store.interactions.is_empty(), "no synthetic history survives it")
	t.check(not main.store.last_error.is_empty(), "the failed attach says why")
	t.check(main.sidebar.retry_available(), "and the retry is offered again")
	t.check(
		not ModelCatalog.is_demo_catalog(main.prompt_panel._models),
		"and the synthetic catalogue is gone from the composer"
	)
	main.free()


## A transport whose requests are HELD until a test settles them.
##
## The race under test is an answer arriving after the client has moved on, which a
## transport that settles immediately cannot produce: every response would belong to
## the newest request. Holding each request lets a test deliver an OLD answer late, and
## the request list records which location each read was issued for.
class HoldingTransport extends "res://integration/http_transport.gd":
	var requests: Array = []
	var cancelled: Array = []
	var locations: Array = []
	var _location := ""
	var _settled: Array = []

	func set_location(directory: String, workspace_id: String = "") -> void:
		_location = directory
		locations.append(directory)
		workspace_id = workspace_id

	func request(method: int, path: String, body: Dictionary = {}) -> int:
		requests.append({
			"method": method, "path": path, "body": body, "location": _location,
		})
		return requests.size()

	func poll(budget_ms: int = 4) -> Array[Dictionary]:
		budget_ms = budget_ms
		var entries: Array[Dictionary] = []
		entries.assign(_settled)
		_settled.clear()
		return entries

	func cancel(request_id: int) -> void:
		cancelled.append(request_id)

	## Deliver a settled response for one held request, optionally after newer ones.
	func deliver(request_id: int, models: Array) -> void:
		_settled.append({
			"request_id": request_id, "kind": "response", "status": 200,
			"body": {"data": models}, "event": {}, "error": "",
		})


func _models_for(id: String, provider: String) -> Array:
	return [{
		"id": id, "modelID": id, "providerID": provider, "name": id,
		"variants": [], "status": "active", "enabled": true,
	}]


func _temp_project(name: String) -> String:
	var path := "/tmp/ycoding-r504-%s-%d" % [name, Time.get_unix_time_from_system()]
	DirAccess.make_dir_recursive_absolute(path)
	return path


## A LIVE office whose model reads are held, so a switch can be raced deliberately.
func _live_with_held_models(main: OfficeMain) -> HoldingTransport:
	var held := HoldingTransport.new()
	main._side = held
	main.models_api.configure(held)
	main.store.mode = OfficeStore.MODE_LIVE
	return held


## R5-04. The model route is location-scoped, so the catalogue the composer offers must
## be the one read for the project in front of the user. Reading it once at attach and
## never again left the PREVIOUS project's models on offer after a switch - the user
## picks from one project's list and the prompt goes to another.
func test_switching_project_re_reads_the_catalogue_for_that_project(t) -> void:
	var main := _bootable()
	var held := _live_with_held_models(main)
	main.select_folder(_temp_project("alpha"))
	var first := str(main.folder_target.directory())
	main.select_folder(_temp_project("beta"))
	var second := str(main.folder_target.directory())
	t.check(second != first, "the two projects are genuinely different folders")
	var reads := held.requests.size()
	t.check(
		reads >= 2,
		"switching project issues a fresh catalogue read (issued %d)" % reads
	)
	if reads >= 2:
		t.check_equal(
			str(held.requests[reads - 1].get("location", "")), second,
			"the newest read is scoped to the project now in front of the user"
		)
	main.live.stop()
	main.free()


## R5-04. A late answer for the project the user left must not become the current
## catalogue. The read the service was asked for no longer describes where the user is,
## so installing it would offer another project's models.
func test_a_late_catalogue_answer_cannot_overwrite_another_project(t) -> void:
	var main := _bootable()
	var held := _live_with_held_models(main)
	main.select_folder(_temp_project("alpha"))
	var alpha_read := held.requests.size()
	main.select_folder(_temp_project("beta"))
	var beta_read := held.requests.size()
	if beta_read < 2:
		t.check(false, "a read is issued for each project")
		main.live.stop()
		main.free()
		return
	# The project the user LEFT answers LAST, which is the race.
	held.deliver(alpha_read, _models_for("alpha-only-model", "alpha-provider"))
	# The installer is driven, not the raw poll: polling here would consume the entry
	# and leave nothing for the one production path that installs a catalogue.
	main._settle_models()
	t.check(
		not str(main.prompt_panel.pill_text()).contains("alpha"),
		"the departed project's answer does not become the catalogue (pill: '%s')" % main.prompt_panel.pill_text()
	)
	var refs: Array[String] = []
	for entry in main._service_models:
		refs.append(str(entry.get("id", "")))
	t.check(
		not refs.has("alpha-only-model"),
		"the departed project's model is not offered"
	)
	# The project the user is IN answers, and that one is installed. A session there
	# reports a model from that catalogue, which is what makes the install observable
	# in the composer rather than only in a field.
	_project(main, "ses_r504_beta", str(main.folder_target.directory()), "beta-provider/beta-only-model")
	main.store.select_actor("ses_r504_beta")
	held.deliver(beta_read, _models_for("beta-only-model", "beta-provider"))
	main._settle_models()
	var offered: Array[String] = []
	for entry in main._service_models:
		offered.append(str(entry.get("id", "")))
	t.check(
		offered.has("beta-only-model"),
		"the current project's own catalogue is the one installed (offering %s)" % str(offered)
	)
	t.check(
		not offered.has("alpha-only-model"),
		"and the departed project's model is not among them"
	)
	t.check_equal(
		main.prompt_panel.model_ref(), "beta-provider/beta-only-model",
		"the composer names the current project's model"
	)
	main.live.stop()
	main.free()


## R5-04. Switching project must not cancel work already accepted, nor re-aim it. The
## stop a user asked for names the session it was asked for, and a switch afterwards
## neither withdraws the request nor moves it to the project now on screen.
func test_switching_project_neither_cancels_nor_moves_in_flight_work(t) -> void:
	var main := _bootable()
	var held := _live_with_held_models(main)
	var stops: Array[String] = []
	# The session API takes its transport at construction and owns its own queue, so it
	# is rebuilt on the held transport and the root's handlers are re-wired to it. An
	# aborted call here would skip the assertions below and still report success.
	main.sessions_api = SessionApi.new(held)
	main.sessions_api.interrupted.connect(func(session_id: String) -> void: stops.append(session_id))
	_project(main, "ses_a", "/workspace/alpha", "openai/gpt-5")
	_project(main, "ses_b", "/workspace/beta", "openai/gpt-5")
	main.store.select_actor("ses_a")
	main._refresh_ui()
	var reason := main.stop_session("ses_a")
	t.check_equal(reason, "", "the stop is accepted while the user is in that project")
	var stop_read := held.requests.size()
	t.check(stop_read > 0, "the stop actually reached the transport")
	# The user moves to another project while the stop is in flight.
	main.select_folder(_temp_project("beta"))
	t.check(
		not held.cancelled.has(stop_read),
		"switching project does not withdraw the stop already accepted"
	)
	# The service answers, and the answer is attributed to the session it was asked for.
	held.deliver(stop_read, [])
	main.sessions_api.poll()
	t.check_equal(stops, ["ses_a"] as Array[String], "the stop still names the project it was asked for")
	main.live.stop()
	main.free()


## R5-05. A project's view state is written when the user leaves it and restored when they
## return, so switching back resumes the work instead of restarting it.
##
## The store is pointed at a throwaway file, because a test must never write over the
## preference a person is actually using.
func test_switching_project_writes_and_restores_each_projects_view_state(t) -> void:
	var main := _bootable()
	DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_VIEW_STATE_PATH))
	var alpha := _temp_project("alpha")
	var beta := _temp_project("beta")

	main.select_folder(alpha)
	main.prompt_panel.set_draft("alpha half-written")
	main.router.go(OfficeRoute.STATISTICS)
	t.check_equal(main.router.route(), OfficeRoute.STATISTICS, "the first project is on a route")

	# Switch away, then back. The draft and the route belong to the project they were
	# made in.
	main.select_folder(beta)
	t.check_equal(
		main.prompt_panel.current_text(), "",
		"the new project starts with no draft of the other project's"
	)
	main.select_folder(alpha)
	t.check_equal(
		main.prompt_panel.current_text(), "alpha half-written",
		"returning to a project restores its draft"
	)
	t.check_equal(
		main.router.route(), OfficeRoute.STATISTICS,
		"and restores the surface it was left on"
	)
	# And the other project kept its own.
	main.router.go(OfficeRoute.SESSIONS)
	main.select_folder(beta)
	t.check_equal(
		main.prompt_panel.current_text(), "",
		"the second project still has its own draft, not the first's"
	)
	main.live.stop()
	main.free()
	DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_VIEW_STATE_PATH))


## R5-05. A saved session that the office no longer has must NOT be restored. Selecting a
## session that is not in the roster would paint a prompt target that receives nothing.
func test_a_saved_session_is_not_restored_when_it_is_not_in_the_roster(t) -> void:
	var main := _bootable()
	DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_VIEW_STATE_PATH))
	var alpha := _temp_project("alpha")
	main.select_folder(alpha)
	var entry_id := str(main.project_ledger.find_by_directory(alpha).get("local_entry_id", ""))
	t.check(not entry_id.is_empty(), "the project has a ledger entry")

	# A saved state naming a session this office does not have.
	main.view_state.remember(entry_id, {
		"selected_session_id": "ses_that_left_the_roster",
		"unsent_draft": "kept",
		"view_route": OfficeRoute.SESSIONS,
	})
	main._restore_view_state(entry_id)
	t.check(
		main.store.selected_actor() == null,
		"a session that is not in the roster is not selected"
	)
	t.check_equal(
		main._prompt_target(), main.store.root_session_id,
		"the prompt target falls back to the root rather than a session that is not there"
	)
	t.check_equal(
		main.prompt_panel.current_text(), "kept",
		"the rest of the saved state is still restored"
	)
	main.live.stop()
	main.free()
	DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_VIEW_STATE_PATH))


## R5-03. One project: a session in its own folder, reporting the model it runs.
## Built from the durable event the service actually sends, so the projection under
## test is the production one.
func _project(main: OfficeMain, session_id: String, directory: String, model: String) -> void:
	var parts := model.split("/")
	main.store.apply({
		"type": Wire.SESSION_CREATED,
		"sessionID": session_id,
		"data": {
			"agent": "lead",
			"title": session_id,
			"location": {"directory": directory},
			"model": {"providerID": parts[0], "id": parts[1]},
		},
		"sourceEpoch": "epoch-live",
	})


## R5-03. A draft's identity is scoped by the work it is aimed at. Keying only on the
## text made the same words sent to a second project reuse the first project's id -
## and the service reconciles an id match as an exact retry, so the second project's
## send was answered as a duplicate of a prompt it had never received.
func test_the_same_text_aimed_at_two_projects_is_two_inputs(t) -> void:
	var main := _bootable()
	_project(main, "ses_a", "/workspace/alpha", "openai/gpt-5")
	_project(main, "ses_b", "/workspace/beta", "openai/gpt-5")
	var to_a := main._prompt_message_id("ses_a", "run the tests")
	var to_b := main._prompt_message_id("ses_b", "run the tests")
	t.check(to_b != to_a, "the same words sent to another project are a new input")
	t.check(
		to_a.begins_with("msg_") and to_b.begins_with("msg_"),
		"both carry the service's message prefix"
	)
	main.free()


## R5-03. Scoping the id must not break the exact-retry contract it exists to keep:
## the same draft aimed at the same project still reconciles.
func test_a_retry_aimed_at_the_same_project_still_reconciles(t) -> void:
	var main := _bootable()
	_project(main, "ses_a", "/workspace/alpha", "openai/gpt-5")
	t.check_equal(
		main._prompt_message_id("ses_a", "run the tests"),
		main._prompt_message_id("ses_a", "run the tests"),
		"an exact retry against the same project keeps its id"
	)
	main.free()


## R5-03. The composer must name the project that would receive the prompt. The
## target is re-resolved from the live selection at submit time, so a composer left
## showing the last folder the picker returned would name a project the work never
## reaches once another session is selected.
func test_the_composer_names_the_project_the_prompt_would_reach(t) -> void:
	var main := _bootable()
	_project(main, "ses_a", "/workspace/alpha", "openai/gpt-5")
	_project(main, "ses_b", "/workspace/beta", "openai/gpt-5")
	main.store.select_actor("ses_b")
	main._refresh_ui()
	t.check_equal(main._prompt_target(), "ses_b", "the selected session is the target")
	t.check_equal(
		main.prompt_panel.target_text(), "/workspace/beta",
		"the composer names the folder the selected session runs in"
	)
	# Selecting the other project moves the name with the target, so the two can
	# never disagree about where a prompt would land.
	main.store.select_actor("ses_a")
	main._refresh_ui()
	t.check_equal(
		main.prompt_panel.target_text(), "/workspace/alpha",
		"the name follows the target when the selection moves"
	)
	main.free()


## R5-03. A model chosen for one project must not silently become the model for
## another. The composer reads the TARGET's own model unless the user chose one for
## that target, so switching projects cannot carry a choice across with it.
func test_a_model_chosen_for_one_project_does_not_follow_into_another(t) -> void:
	var main := _bootable()
	_project(main, "ses_a", "/workspace/alpha", "openai/gpt-5")
	_project(main, "ses_b", "/workspace/beta", "anthropic/claude-opus")
	main.store.select_actor("ses_a")
	main._refresh_ui()
	main._on_model_selected("openai/gpt-6")
	# The composer's model is re-derived on every refresh, so the refresh is what
	# installs it; reading the panel without one would read a transient value.
	main._refresh_ui()
	t.check_equal(
		main.prompt_panel.model_ref(), "openai/gpt-6",
		"the choice applies to the project it was made for"
	)
	main.store.select_actor("ses_b")
	main._refresh_ui()
	t.check_equal(
		main.prompt_panel.model_ref(), "anthropic/claude-opus",
		"another project reports its own model, not a choice made elsewhere"
	)
	# Returning to the first project remembers the choice made there.
	main.store.select_actor("ses_a")
	main._refresh_ui()
	t.check_equal(
		main.prompt_panel.model_ref(), "openai/gpt-6",
		"the choice made for a project survives a trip to another one"
	)
	main.free()


## R5-03. The transcript shows the selected session's own work. Another project's
## messages are never mixed in, however recently they arrived.
func test_another_projects_transcript_never_appears(t) -> void:
	var main := _bootable()
	_project(main, "ses_a", "/workspace/alpha", "openai/gpt-5")
	_project(main, "ses_b", "/workspace/beta", "openai/gpt-5")
	main.store.record_interaction({
		"id": "i-alpha", "session_id": "ses_a", "kind": "prompt",
		"description": "alpha only words", "source": "fixture",
	})
	main.store.record_interaction({
		"id": "i-beta", "session_id": "ses_b", "kind": "prompt",
		"description": "beta only words", "source": "fixture",
	})
	# The drawer resolves its own children on `_ready`, which never fires for a
	# scene-less root, so it is built explicitly - the same idiom this suite already
	# uses for the composer.
	var drawer := ConversationPanel.new()
	drawer._ready()
	main.add_child(drawer)
	drawer.show_actor(main.store, "ses_b", "")
	var texts: Array[String] = []
	for item in drawer._thread_items:
		texts.append(str(item.get("description", "")))
	t.check(texts.has("beta only words"), "the selected project's own work is shown")
	t.check(
		not texts.has("alpha only words"),
		"another project's work never appears in this transcript"
	)
	main.free()


## R1-04. The service reconciles an EXACT retry only when the id matches. Deriving
## the id from the second-resolution clock defeated that: a retry more than a second
## later minted a NEW id, which the service admitted as a second prompt. The id must
## therefore survive the retry it exists to reconcile.
func test_a_prompt_id_survives_the_retry_it_must_reconcile(t) -> void:
	var main := _bootable()
	_project(main, "ses_root", "/workspace/alpha", "openai/gpt-5")
	var first := main._prompt_message_id("ses_root", "deploy the fix")
	# The clocks differ, so a clock-derived id would differ too.
	var second := main._prompt_message_id("ses_root", "deploy the fix")
	t.check_equal(second, first, "an exact retry keeps the same prompt id")
	t.check(second.begins_with("msg_"), "the id keeps the service's message prefix")
	main.free()


## R1-04. A different draft is a new input, so it must not inherit the previous
## draft's id: the service would reconcile it as a retry of text it never saw.
func test_a_different_draft_gets_its_own_prompt_id(t) -> void:
	var main := _bootable()
	_project(main, "ses_root", "/workspace/alpha", "openai/gpt-5")
	var first := main._prompt_message_id("ses_root", "first draft")
	var second := main._prompt_message_id("ses_root", "second draft")
	t.check(second != first, "a different draft gets a different id")
	# And returning to the first draft is still a new input, not the old id.
	var third := main._prompt_message_id("ses_root", "first draft")
	t.check(third != first, "returning to an earlier draft does not reuse its id")
	main.free()


## R1-04. The id is retired by the DURABLE admission, not by the request returning.
## A queued request can still time out, and a retry after that timeout must reuse
## the id so the service reconciles it instead of admitting the prompt twice.
func test_the_id_is_retired_by_durable_admission_not_by_the_request(t) -> void:
	var main := _bootable()
	main._boot_with({"url": REGISTERED_URL, "pid": 4242})
	main.store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_root",
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-live",
	})
	var id := main._prompt_message_id("ses_root", "send me")
	# The transport is attached to a dead port, so nothing is admitted. The id must
	# survive, because the user's next action is a retry of this same draft.
	main._on_prompt_submitted("send me")
	t.check_equal(
		main._prompt_message_id("ses_root", "send me"),
		id,
		"an unconfirmed send keeps its id, so a timeout retry reconciles"
	)
	# Now the service durably admits exactly this input.
	main._on_event({
		"type": Wire.INPUT_ADMITTED, "sessionID": "ses_root",
		"data": {"inputID": id}, "sourceEpoch": "epoch-live",
	})
	t.check(
		main._prompt_message_id("ses_root", "send me") != id,
		"the durable admission retires the id, so a deliberate resend is a new input"
	)
	main.live.stop()
	main.free()


## R1-04. An admission for someone else's input must not retire this draft's id.
func test_another_inputs_admission_does_not_retire_the_draft(t) -> void:
	var main := _bootable()
	_project(main, "ses_root", "/workspace/alpha", "openai/gpt-5")
	main._boot_with({"url": REGISTERED_URL, "pid": 4242})
	var id := main._prompt_message_id("ses_root", "mine")
	main._on_event({
		"type": Wire.INPUT_ADMITTED, "sessionID": "ses_root",
		"data": {"inputID": "msg_someone_else"}, "sourceEpoch": "epoch-live",
	})
	t.check_equal(
		main._prompt_message_id("ses_root", "mine"),
		id,
		"an unrelated admission leaves this draft's id alone"
	)
	main.live.stop()
	main.free()


## R1-04. Admission and completion must be distinguishable. The office reports that
## the prompt was ACCEPTED, and the durable work state is what shows running; a
## successful send must not be presented as the work having finished.
func test_the_send_reports_admission_not_completion(t) -> void:
	var main := _bootable()
	main._boot_with({"url": REGISTERED_URL, "pid": 4242})
	main.store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_root",
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-live",
	})
	main.store.connection_state = OfficeStore.CONNECTION_LIVE
	main._on_prompt_submitted("do the thing")
	# The attach is on a dead port, so the refusal path is what must be honest.
	t.check(
		not main.prompt_panel._notice.text.is_empty(),
		"a send always reports its outcome"
	)
	t.check(
		main.store.actor_for("ses_root").settled_status.is_empty(),
		"a submission never claims the work finished"
	)
	main.live.stop()
	main.free()


## THE REGRESSION: a client that only consumed the event feed would show an empty office even
## though the service holds sessions, because the feed starts from NOW and replays nothing, and
## `reload_required` fires only on a feed error or an epoch change.
##
## So reaching LIVE on a FIRST attach must ask for the canonical read. Without this the office
## connected (`conn=live`) and still held zero of the service's fifty sessions.
func test_the_first_attach_reads_the_canonical_state_once(t) -> void:
	var main := _bootable()
	t.check(not main.store.is_stale(), "a fresh office claims no read yet")
	main._on_connection_changed(OfficeStore.CONNECTION_LIVE)
	# Asking for the canonical read MARKS the projection stale, and only a completed reload
	# clears that. So staleness is the observable proof that the read was asked for, without a
	# test-only field in production.
	t.check(
		main.store.is_stale(),
		"reaching LIVE on a first attach asks for the canonical read"
	)
	# Complete the read, then send LIVE again: a repeated state must NOT re-ask, or an office
	# would re-read the whole session list every time the transport reported itself live.
	main.store.adopt_reload([], "epoch-1")
	t.check(not main.store.is_stale(), "a completed read clears the staleness")
	main._on_connection_changed(OfficeStore.CONNECTION_LIVE)
	t.check(
		not main.store.is_stale(),
		"and a repeated LIVE state does NOT ask again"
	)
	main.free()


## A RECONNECT reads the canonical state again, because the feed is volatile and anything
## sent during the gap is lost.
func test_a_reconnect_reads_the_canonical_state_again(t) -> void:
	var main := _bootable()
	t.check_equal(main.start_live(REGISTERED_URL), "", "the initial attach accepts its endpoint")
	main._on_connection_changed(OfficeStore.CONNECTION_LIVE)
	main.store.adopt_reload([], "epoch-1")
	t.check(not main.store.is_stale(), "the first attach has read")
	t.check_equal(main.start_live(REGISTERED_URL), "", "the reconnect accepts its endpoint")
	main._on_connection_changed(OfficeStore.CONNECTION_LIVE)
	t.check(
		main.store.is_stale(),
		"a RECONNECT asks for the canonical read again"
	)
	main.live.stop()
	main.free()
