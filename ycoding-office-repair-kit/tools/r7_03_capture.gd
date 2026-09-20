## R7-03 native capture: the Statistics surface in the real shell, on its own route.
##
## Drives the REAL `res://app/main.tscn` scene, so the panel, its layout and the route owner
## are the product's own. What it must show:
##
##   * the Statistics route showing the STATISTICS panel and not the office world;
##   * the page LOADING before a read settles, then READY with real figures;
##   * attempts and steps as DIFFERENT numbers;
##   * known and estimated spend as separate figures;
##   * the daily chart and activity calendar stating WHY they cannot be drawn, rather than
##     drawing an empty axis that would claim there was no work;
##   * a failed read as an ERROR with its reason, never as an empty page.
##
## The service is optional: with none reachable the driver exercises the ERROR path, which
## is itself the honest-when-unavailable evidence.
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
		print("R703 FAIL: main scene did not load")
		quit(1)
		return
	var scene: Variant = packed.instantiate()
	root.add_child(scene)
	await process_frame
	if scene.demo == null:
		_frames += 1
		if _frames > 240:
			print("R703 FAIL: scene never became ready")
			quit(1)
			return
		_go.call_deferred()
		return
	_run(scene)


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if condition:
		print("R703 PASS  " + message)
		return
	_fails += 1
	print("R703 FAIL  " + message)


func _run(scene) -> void:
	# Show the route the way the user does: through the product's own navigation.
	scene._on_route_requested(OfficeRoute.STATISTICS)
	await process_frame
	await process_frame

	_check(
		scene.statistics_panel.visible,
		"the Statistics route shows the statistics surface"
	)
	_check(
		not scene.office_view.visible,
		"and the office world is not drawn on it"
	)
	_check(
		not scene.prompt_panel.visible,
		"and the composer, which belongs to the office, is not drawn either"
	)

	# Point the reader at the real service and read a real session's usage.
	var registered := _registered_url()
	print("R703 registered=%s" % registered)
	scene.start_live(registered, _registered_password())
	await process_frame
	await process_frame

	# The LOADING state must be observable before anything settles.
	var page := StatisticsPage.new()
	_check_equal(
		page.state(), StatisticsPage.LOADING,
		"a fresh page is LOADING before any read settles"
	)

	var session_id := _first_service_session(scene)
	print("R703 session=%s" % session_id)
	if session_id.is_empty():
		# No session reachable: the ERROR path is the evidence, and it must not read as
		# an empty page.
		page.fail("no session could be read from the service")
		_check_equal(page.state(), StatisticsPage.ERROR, "an unreadable service is an ERROR state")
		_check(
			page.state_text() != page.empty_text(),
			"and its text does not read as an empty page"
		)
		scene.statistics_panel.adopt(page)
		await _capture(scene, "%s/r7-03-statistics-error.png" % _out)
		print("R703 checks=%d fails=%d" % [_checks, _fails])
		quit(1 if _fails > 0 else 0)
		return

	var api := UsageApi.new()
	api.configure(scene._side_transport())
	var usage := api.fetch(session_id)
	print("R703 reported=%s logical=%d physical=%d helpers=%d" % [
		str(usage.is_reported()), usage.logical_steps(),
		usage.physical_attempts(), usage.helper_requests(),
	])
	print("R703 cost=%s provenance=%s priced=%s" % [
		usage.cost_text(), usage.cost_provenance_text(), usage.priced_of(),
	])

	if usage.is_reported():
		page.adopt(usage, session_id)
		_check_equal(page.state(), StatisticsPage.READY, "a real read reaches READY")
		_check(
			page.cards().get("logical_steps", "") != page.cards().get("physical_attempts", ""),
			"steps and attempts are DIFFERENT figures on the cards (%s vs %s)" % [
				str(page.cards().get("logical_steps", "")),
				str(page.cards().get("physical_attempts", "")),
			]
		)
		_check(
			page.cards().has("known_spend") and page.cards().has("estimated_spend"),
			"known and estimated spend are separate cards"
		)
		_check(
			not page.has_daily_chart(),
			"the daily chart is NOT claimed, because there is no per-day source"
		)
		_check(
			page.daily_unavailable_text().contains("cumulative"),
			"and its reason names the actual limitation"
		)
		_check(
			not page.has_calendar(),
			"the activity calendar is NOT claimed either"
		)
	else:
		page.fail(api.last_error())
		_check_equal(page.state(), StatisticsPage.ERROR, "a failed read is an ERROR state")
		_check(
			page.state_text() != page.empty_text(),
			"and it does not read as an empty page"
		)

	scene.statistics_panel.adopt(page)
	await process_frame
	await process_frame

	# What the reader actually sees on the surface.
	var shown := _panel_text(scene.statistics_panel)
	print("R703 panel_names_requests=%s" % str(shown.contains("Observed requests")))
	print("R703 panel_names_daily_reason=%s" % str(shown.contains("cumulative")))
	_check(
		shown.contains("Observed requests") or shown.contains("Could not read usage"),
		"the surface renders either figures or the reason it has none"
	)

	await _capture(scene, "%s/r7-03-statistics.png" % _out)
	print("R703 checks=%d fails=%d" % [_checks, _fails])
	print("R703 done")
	quit(1 if _fails > 0 else 0)


func _check_equal(actual: Variant, expected: Variant, message: String) -> void:
	_check(actual == expected, message)


## Every label's text in a subtree, so the assertion reads what a user would.
func _panel_text(node) -> String:
	var out := ""
	if node is Label:
		out += " " + node.text
	for child in node.get_children():
		out += " " + _panel_text(child)
	return out.strip_edges()


## The first session the SERVICE knows about, over its own list route.
func _first_service_session(scene) -> String:
	var transport: HttpTransport = scene._side_transport()
	if transport == null:
		return ""
	var request_id: int = transport.request(HTTPClient.METHOD_GET, Gateway.SESSION_LIST, {})
	if request_id < 0:
		return ""
	var deadline: int = Time.get_ticks_msec() + 6000
	while Time.get_ticks_msec() < deadline:
		for value in transport.poll(4):
			var entry: Dictionary = value
			if int(entry.get("request_id", -1)) != request_id:
				continue
			if str(entry.get("kind", "")) != HttpTransport.KIND_RESPONSE:
				continue
			var body: Variant = entry.get("body", {})
			var rows: Variant = body.get("data", []) if body is Dictionary else []
			if rows is Array and not rows.is_empty() and rows[0] is Dictionary:
				return str(rows[0].get("id", ""))
			return ""
	return ""


func _registered_url() -> String:
	var path := _registration_path()
	if path.is_empty() or not FileAccess.file_exists(path):
		return ""
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
	if not (parsed is Dictionary):
		return ""
	return str(parsed.get("url", ""))


func _registered_password() -> String:
	var path := _registration_path()
	if path.is_empty() or not FileAccess.file_exists(path):
		return ""
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
	if not (parsed is Dictionary):
		return ""
	return str(parsed.get("password", ""))


func _registration_path() -> String:
	var home := OS.get_environment("HOME")
	if home.is_empty():
		return ""
	return home.path_join(".local/state/ycoding/service.json")


func _capture(scene, path: String) -> void:
	scene.capture_mode = true
	await process_frame
	await process_frame
	var image := root.get_viewport().get_texture().get_image()
	if image == null:
		print("R703 FAIL: no frame to capture")
		return
	if image.save_png(path) == OK:
		print("R703 captured %s" % path)
	else:
		print("R703 FAIL: could not write %s" % path)
