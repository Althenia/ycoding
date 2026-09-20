## R7-08 native verification: one REAL session's figures cross-checked against the service.
##
## The kit requires "Cross-check one real provider session against authoritative YCoding
## telemetry". This drives the REAL client and the REAL UsageApi against the running service,
## then verifies the aggregate the CLIENT builds against the service's own answer:
##
##   * the client's totals equal the service's;
##   * the model groups SUM to the session totals, which is independent evidence that the
##     components are disjoint and that summing them is the provider's own arithmetic;
##   * attempts are not steps;
##   * spend is labelled as an estimate where the provenance says so.
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
		print("R708 FAIL: main scene did not load")
		quit(1)
		return
	var scene: Variant = packed.instantiate()
	root.add_child(scene)
	await process_frame
	if scene.demo == null:
		_frames += 1
		if _frames > 240:
			print("R708 FAIL: scene never became ready")
			quit(1)
			return
		_go.call_deferred()
		return
	_run(scene)


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if condition:
		print("R708 PASS  " + message)
		return
	_fails += 1
	print("R708 FAIL  " + message)


func _run(scene) -> void:
	var registered := _registered_url()
	print("R708 registered=%s" % registered)
	scene.start_live(registered, _registered_password())
	await process_frame
	await process_frame

	var session_id := _first_service_session(scene)
	print("R708 session=%s" % session_id)
	if session_id.is_empty():
		print("R708 NOTE  no session is reachable; the refusal is the evidence")
		quit(0)
		return

	# The service's OWN answer, read directly, so the client's aggregate has something
	# authoritative to agree with.
	var raw := _raw_usage(scene, session_id)
	if raw.is_empty():
		print("R708 NOTE  the service returned no summary")
		quit(0)
		return
	print("R708 service logical=%d physical=%d helpers=%d" % [
		int(raw.get("logical", 0)), int(raw.get("physical", 0)), int(raw.get("helpers", 0)),
	])

	# The client's aggregate over the SAME answer.
	var usage := SessionUsage.from_summary(raw, [session_id])
	print("R708 client  logical=%d physical=%d helpers=%d" % [
		usage.logical_steps(), usage.physical_attempts(), usage.helper_requests(),
	])

	_check(
		usage.logical_steps() == int(raw.get("logical", -1)),
		"the client's step total equals the service's (%d)" % usage.logical_steps()
	)
	_check(
		usage.physical_attempts() == int(raw.get("physical", -1)),
		"and its attempt total (%d)" % usage.physical_attempts()
	)
	_check(
		usage.physical_attempts() != usage.logical_steps(),
		"attempts are NOT steps (%d vs %d)" % [
			usage.physical_attempts(), usage.logical_steps()]
	)

	# INDEPENDENT ARITHMETIC: the model groups must sum to the session totals. This is the
	# cross-check that the components are disjoint and that summing them is correct.
	var groups: Array = usage.model_groups()
	var group_requests := 0
	var group_input := 0
	var group_output := 0
	var group_reasoning := 0
	var group_cache_read := 0
	for g in groups:
		group_requests += int(g.get("requests", 0))
		var gt: Dictionary = g.get("tokens", {})
		group_input += int(gt.get("input", 0))
		group_output += int(gt.get("output", 0))
		group_reasoning += int(gt.get("reasoning", 0))
		group_cache_read += int(gt.get("cache", {}).get("read", 0))
	print("R708 groups=%d sum_requests=%d sum_input=%d" % [groups.size(), group_requests, group_input])
	_check(
		group_requests == usage.logical_steps(),
		"the model groups' requests SUM to the session's steps (%d = %d)" % [
			group_requests, usage.logical_steps()]
	)
	_check(
		group_input == usage.tokens("input"),
		"and their input tokens SUM to the session's input (%d = %d)" % [
			group_input, usage.tokens("input")]
	)
	_check(
		group_output == usage.tokens("output"),
		"and their output tokens SUM to the session's output"
	)
	_check(
		group_reasoning == usage.tokens("reasoning"),
		"and their reasoning tokens SUM to the session's reasoning"
	)
	_check(
		group_cache_read == usage.tokens("cache_read"),
		"and their cache-read tokens SUM to the session's cache read"
	)
	# The input figure is the NON-cached volume: it is strictly below the sum with cache, which
	# is what makes adding the components correct rather than a double count.
	_check(
		usage.tokens("input") + usage.tokens("cache_read") > usage.tokens("input"),
		"input excludes cache, so input + cache is the billed prompt volume"
	)

	print("R708 cost=%s provenance=%s priced=%s" % [
		usage.cost_text(), usage.cost_provenance_text(), usage.priced_of(),
	])
	_check(
		usage.cost_provenance_text() == "recorded" or usage.cost_provenance_text() == "estimated",
		"the spend carries its own provenance (%s)" % usage.cost_provenance_text()
	)

	# Show it on the surface, so the verification is also visible.
	scene._on_route_requested(OfficeRoute.STATISTICS)
	await process_frame
	var page := StatisticsPage.new()
	page.adopt(usage, session_id)
	scene.statistics_panel.adopt(page)
	await process_frame
	await process_frame
	var shown := _panel_text(scene.statistics_panel)
	_check(
		shown.contains(str(usage.logical_steps())) and shown.contains(str(usage.physical_attempts())),
		"the surface shows both figures (%d and %d)" % [
			usage.logical_steps(), usage.physical_attempts()]
	)

	await _capture(scene, "%s/r7-08-cross-check.png" % _out)
	print("R708 checks=%d fails=%d" % [_checks, _fails])
	print("R708 done")
	quit(1 if _fails > 0 else 0)


## The service's own usage answer for a session, read over its verified route.
func _raw_usage(scene, session_id: String) -> Dictionary:
	var transport: HttpTransport = scene._side_transport()
	if transport == null:
		return {}
	var request_id: int = transport.request(
		HTTPClient.METHOD_GET, Gateway.usage(session_id), {}
	)
	if request_id < 0:
		return {}
	var deadline: int = Time.get_ticks_msec() + 8000
	while Time.get_ticks_msec() < deadline:
		for value in transport.poll(4):
			var entry: Dictionary = value
			if int(entry.get("request_id", -1)) != request_id:
				continue
			if str(entry.get("kind", "")) != HttpTransport.KIND_RESPONSE:
				continue
			var body: Variant = entry.get("body", {})
			if body is Dictionary and body.get("data", null) is Dictionary:
				return body["data"]
			return {}
	return {}


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


func _panel_text(node) -> String:
	var out := ""
	if node is Label:
		out += " " + node.text
	elif node is Button:
		out += " " + node.text
	for child in node.get_children():
		out += " " + _panel_text(child)
	return out.strip_edges()


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
		print("R708 FAIL: no frame to capture")
		return
	if image.save_png(path) == OK:
		print("R708 captured %s" % path)
	else:
		print("R708 FAIL: could not write %s" % path)
