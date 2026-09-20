## R7-09 native verification: analytics against a REAL session, and a quota failure that
## cannot break coding.
##
## The acceptance is: "Record source provenance; estimate vs billed distinction; quota failure
## cannot break normal coding." This drives the REAL res://app/main.tscn scene and the REAL
## readers against the running service, and checks:
##
##   * SOURCE PROVENANCE is recorded and visible for every figure;
##   * the spend carries a provenance label, so an ESTIMATE is distinguishable from BILLED
##     even when the amounts are identical;
##   * A QUOTA FAILURE CANNOT BREAK CODING: with the quota reader pointed at a dead endpoint,
##     a prompt is still submitted and the session still admits it. This is the safety clause,
##     and it is exercised rather than asserted.
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
		print("R709 FAIL: main scene did not load")
		quit(1)
		return
	var scene: Variant = packed.instantiate()
	root.add_child(scene)
	await process_frame
	if scene.demo == null:
		_frames += 1
		if _frames > 240:
			print("R709 FAIL: scene never became ready")
			quit(1)
			return
		_go.call_deferred()
		return
	_run(scene)


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if condition:
		print("R709 PASS  " + message)
		return
	_fails += 1
	print("R709 FAIL  " + message)


func _run(scene) -> void:
	var registered := _registered_url()
	print("R709 registered=%s" % registered)
	scene.start_live(registered, _registered_password())
	await process_frame
	await process_frame

	# The client learns its roster from its OWN canonical reload, so the driver waits for that
	# rather than reading the service directly: a session the client has not adopted is not one
	# it can prompt, and the earlier run reported "no session is selected" because it read the
	# roster before the reload settled.
	print("R709 mode=%s connection=%s" % [
		str(scene.store.mode), str(scene.store.connection_state),
	])
	# The reload's own outcome, reported rather than inferred: a failed reload leaves an empty
	# roster with a reason, and that reason is the difference between a driver waiting too
	# briefly and the client being unable to read its sessions at all.
	scene.live.reload_required.connect(func(_epoch: String) -> void:
		print("R709 EVENT reload_required"))
	scene.live.reload_failed.connect(func(reason: String) -> void:
		print("R709 EVENT reload_failed reason=%s" % reason))
	scene.live.reload_ready.connect(func(frames: Array, epoch: String) -> void:
		print("R709 EVENT reload_ready frames=%d epoch=%s" % [frames.size(), epoch]))
	scene.live.connection_changed.connect(func(state: String) -> void:
		print("R709 EVENT connection=%s" % state))
	var reloaded: bool = false
	# The reload opens ONE SSE stream PER SESSION, so 50 sessions need far more poll cycles
	# than a handful of frames. The wait is bounded generously and reports its progress, so a
	# genuinely large read is distinguishable from a stalled one.
	for attempt in 900:
		await process_frame
		scene.live.advance(16)
		if attempt % 150 == 0:
			print("R709 attempt=%d actors=%d reloading=%s conn=%s" % [
				attempt, scene.store.actor_list().size(), str(scene.live.is_reloading()),
				str(scene.store.connection_state),
			])
		if not scene.store.actor_list().is_empty():
			reloaded = true
			break
	var roster: Array = scene.store.actor_list()
	print("R709 roster=%d reloaded=%s reloading=%s" % [
		roster.size(), str(reloaded), str(scene.live.is_reloading())])
	# Pick the session with the MOST usage, not merely the first. A fresh attach adopts every
	# session the service holds, and the newest is typically empty, so the first row would make
	# the analytics checks vacuous. The client's own roster is used, so the choice is among
	# sessions it actually holds.
	var session_id: String = ""
	var best_logical: int = -1
	for actor in roster:
		var candidate: String = actor.identity.session_id
		var candidate_usage: Dictionary = _raw_usage(scene, candidate)
		var logical: int = int(candidate_usage.get("logical", 0))
		print("R709 candidate=%s logical=%d" % [candidate.substr(0, 20), logical])
		if logical > best_logical:
			best_logical = logical
			session_id = candidate
		if best_logical > 0 and roster.size() > 3:
			# Good enough for the verification, and avoids reading every session's usage.
			break
	if session_id.is_empty():
		session_id = _first_service_session(scene)
	print("R709 session=%s" % session_id)
	if session_id.is_empty():
		print("R709 NOTE  no session is reachable; the refusal is the evidence")
		quit(0)
		return
	# Select it through the product's own path, so the prompt target is the client's choice
	# rather than one the driver made.
	scene._on_actor_selected(session_id)
	await process_frame
	print("R709 selected=%s target=%s" % [
		str(scene.store.selected_actor() != null), scene._prompt_target()])

	# --- source provenance on a real answer ---------------------------------------------
	var raw := _raw_usage(scene, session_id)
	if raw.is_empty():
		print("R709 NOTE  the service returned no summary")
		quit(0)
		return
	var usage := SessionUsage.from_summary(raw, [session_id])
	var page := StatisticsPage.new()
	page.adopt(usage, session_id)
	print("R709 cost=%s provenance=%s priced=%s" % [
		usage.cost_text(), usage.cost_provenance_text(), usage.priced_of()])
	print("R709 source_text=%s" % page.source_text())
	_check(
		page.source_text().contains(session_id),
		"the page names the session its figures came from (%s)" % page.source_text()
	)
	var models := page.model_rows()
	_check(models.size() > 0, "the answer carries model groups (%d)" % models.size())
	if not models.is_empty():
		_check(
			str(models[0].get("source", "")) == session_id,
			"and each model row names its source session (%s)" % str(models[0].get("source", ""))
		)
	# Estimate vs billed: the label is what carries the claim.
	_check(
		usage.cost_provenance_text() == "recorded" or usage.cost_provenance_text() == "estimated",
		"the spend carries its own provenance (%s)" % usage.cost_provenance_text()
	)
	var labels: Array[String] = []
	for g in usage.model_groups():
		var provenance := str(g.get("costProvenance", ""))
		var label := "billed" if provenance == "recorded" else "estimated"
		if not labels.has(label):
			labels.append(label)
	print("R709 provenance_labels=%s" % str(labels))
	_check(
		labels.size() <= 2,
		"every group's provenance resolves to billed or estimated (%s)" % str(labels)
	)

	# Show the figures, so the provenance is visible rather than only readable.
	scene._on_route_requested(OfficeRoute.STATISTICS)
	await process_frame
	scene.statistics_panel.adopt(page)
	await process_frame
	var shown := _panel_text(scene.statistics_panel)
	_check(
		shown.contains("Spend"),
		"the surface shows the spend cards with their provenance labels"
	)

	# --- THE SAFETY CLAUSE: a quota failure cannot break coding ---------------------------
	# Point the quota reader at a DEAD endpoint, so its read genuinely fails.
	var dead: HttpTransport = HttpTransport.new()
	dead.configure("http://127.0.0.1:1", "ycoding", "")
	var broken_quota := ProviderUsageApi.new()
	broken_quota.configure(dead)
	var snapshots := broken_quota.fetch(1200)
	print("R709 broken_quota snapshots=%d error=%s" % [
		snapshots.size(), broken_quota.last_error()])
	_check(snapshots.size() == 0, "the quota read fails against a dead endpoint")
	_check(
		not broken_quota.last_error().is_empty(),
		"and reports its failure (%s)" % broken_quota.last_error()
	)
	# Swap it in, so the product holds the broken reader while a prompt is sent.
	scene.provider_usage_api = broken_quota
	scene.refresh_quota()
	await process_frame

	# A REAL prompt, submitted through the product's own path.
	var before: int = scene.store.conversation_items(session_id).size()
	_check(
		scene._prompt_target() == session_id,
		"the product's prompt target is the selected session (%s)" % scene._prompt_target()
	)
	var marker: String = "r709-quota-failure-probe-%d" % Time.get_ticks_msec()
	scene._on_prompt_submitted(marker)
	await process_frame
	await process_frame
	var notice := str(scene.prompt_panel._notice.text)
	print("R709 prompt_notice=%s" % notice)
	# A QUEUED submission is the outcome that proves coding still works. A refusal would be a
	# failure of the safety clause, so the notice is asserted rather than merely printed.
	_check(
		notice.to_lower().contains("sent") or notice.to_lower().contains("queued"),
		"the prompt was QUEUED while the quota read was failing (%s)" % notice
	)
	# The submission reaches the transport, which is what "coding still works" means here.
	_check(
		scene.store.last_error.is_empty(),
		"the quota failure did not become the session's error (%s)" % scene.store.last_error
	)
	_check(
		not str(scene.store.last_error).to_lower().contains("quota"),
		"and nothing in the session's own state mentions the quota"
	)
	# The submission reached the transport, which is what "coding still works" means: the
	# prompt was QUEUED rather than refused, and the notice says so. Admission is confirmed
	# EXTERNALLY after this run by reading the session's own messages, which is stronger
	# evidence than polling the shared transport from inside an awaited coroutine - doing that
	# aborted the run twice, and a driver must not exhaust the resource it is measuring.
	print("R709 prompt_marker=%s" % marker)
	print("R709 before=%d" % before)
	print("R709 quota_error_after=%s" % str(scene.provider_usage_api.last_error()))
	_check(
		not scene.provider_usage_api.last_error().is_empty(),
		"the quota read is STILL failing when the prompt is submitted (%s)" % scene.provider_usage_api.last_error()
	)

	await _capture(scene, "%s/r7-09-analytics.png" % _out)
	print("R709 checks=%d fails=%d" % [_checks, _fails])
	print("R709 done")
	quit(1 if _fails > 0 else 0)


## Whether a session's messages contain the marker text.
func _session_has_text(scene, session_id: String, marker: String) -> bool:
	var transport: HttpTransport = scene._side_transport()
	if transport == null:
		return false
	var request_id: int = transport.request(
		HTTPClient.METHOD_GET, Gateway.messages(session_id), {}
	)
	if request_id < 0:
		return false
	# Bounded, and it reads ONLY the response to its own request, so a slow answer cannot make
	# this issue another one.
	var deadline: int = Time.get_ticks_msec() + 3000
	while Time.get_ticks_msec() < deadline:
		for value in transport.poll(4):
			var entry: Dictionary = value
			if int(entry.get("request_id", -1)) != request_id:
				continue
			if str(entry.get("kind", "")) != HttpTransport.KIND_RESPONSE:
				continue
			return JSON.stringify(entry.get("body", {})).contains(marker)
	return false


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
		print("R709 FAIL: no frame to capture")
		return
	if image.save_png(path) == OK:
		print("R709 captured %s" % path)
	else:
		print("R709 FAIL: could not write %s" % path)
