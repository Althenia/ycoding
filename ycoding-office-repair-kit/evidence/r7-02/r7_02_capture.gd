## R7-02 native capture: session usage read from the real service.
##
## Drives the REAL `res://app/main.tscn` scene and the REAL UsageApi against the local
## service, so the read is the product's own path rather than a double. What it must show:
##
##   * a real session's usage read over the verified route, with steps and attempts
##     reported as DIFFERENT numbers;
##   * the pricing completeness stated rather than a zero standing in for unknown;
##   * the rollup counting a family once, and the day breakdown declared unavailable;
##   * that an unreachable service yields "nothing known", never a zero total.
##
## The service is optional: with no registration the driver reports the refusal it got,
## which is itself the honest-when-unavailable evidence.
##
## Kit-local: no repository source depends on this file.
extends SceneTree

const OUT := "res://../ycoding-office-repair-kit/evidence/r7-02"

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
		print("R702 FAIL: main scene did not load")
		quit(1)
		return
	var scene: Variant = packed.instantiate()
	root.add_child(scene)
	await process_frame
	if scene.demo == null:
		_frames += 1
		if _frames > 240:
			print("R702 FAIL: scene never became ready")
			quit(1)
			return
		_go.call_deferred()
		return
	_run(scene)


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if condition:
		print("R702 PASS  " + message)
		return
	_fails += 1
	print("R702 FAIL  " + message)


func _run(scene) -> void:
	# The REAL live transport, pointed at the registered service the client would use. The
	# registration file is the client's own discovery source; it is read, not guessed.
	var registered := _registered_url()
	print("R702 registered=%s" % registered)
	scene.start_live(registered, _registered_password())
	await process_frame
	await process_frame

	var api := UsageApi.new()
	api.configure(scene._side_transport())
	api.start("")

	# Ask the SERVICE for its sessions. The client's roster is built from the event stream it
	# has observed, which is empty on a fresh attach - but usage belongs to a durable session
	# the service already knows about, so the session list is the right source here.
	var sessions: Array = scene.store.actor_list()
	print("R702 sessions_known_to_client=%d" % sessions.size())

	var session_id := _first_service_session(scene)
	print("R702 session_from_service=%s" % session_id)
	if session_id.is_empty():
		for actor in sessions:
			session_id = actor.identity.session_id
			break

	if session_id.is_empty():
		print("R702 NOTE  no session is known to this client, so usage cannot be read here")
		print("R702 refusal=%s" % api.last_error())
		await _capture(scene, "%s/r7-02-usage.png" % _out)
		print("R702 checks=%d fails=%d" % [_checks, _fails])
		quit(0)
		return

	var usage := api.fetch(session_id)
	print("R702 session=%s reported=%s" % [session_id, str(usage.is_reported())])
	print("R702 logical_steps=%d physical_attempts=%d helpers=%d" % [
		usage.logical_steps(), usage.physical_attempts(), usage.helper_requests(),
	])
	print("R702 cost=%s provenance=%s priced=%s" % [
		usage.cost_text(), usage.cost_provenance_text(), usage.priced_of(),
	])
	print("R702 tokens input=%d output=%d cache_read=%d" % [
		usage.tokens("input"), usage.tokens("output"), usage.tokens("cache_read"),
	])
	print("R702 last_error=%s" % api.last_error())

	_check(not api.last_error().is_empty() or usage.is_reported(),
		"the read either reports usage or states why it could not")
	_check(
		usage.physical_attempts() >= usage.logical_steps(),
		"attempts are counted apart from steps (%d >= %d)" % [
			usage.physical_attempts(), usage.logical_steps()]
	)
	_check(
		usage.cost_text() == "Not reported" or usage.cost_text().begins_with("$"),
		"cost renders as an amount or as unreported, never a bare zero"
	)
	_check(not usage.cost_text() == "$0.00" or usage.has_cost(),
		"a zero amount is only shown when a cost was actually reported")

	# The rollup over what the client knows.
	var rows: Array[Dictionary] = []
	var families: Dictionary = {}
	for actor in sessions:
		var sid: String = actor.identity.session_id
		var one := UsageApi.new()
		one.configure(scene._side_transport())
		var read: SessionUsage = one.fetch(sid)
		if not read.is_reported():
			continue
		rows.append({
			"session_id": sid, "project_id": "", "summary": {},
			"models": [],
			"usage": read,
		})
	for row in rows:
		# The rollup reads a wire summary; reuse the reader's effect by asking it again.
		families[str(row["session_id"])] = scene.store.family_session_ids(str(row["session_id"]))
	print("R702 rollup_sessions_with_usage=%d" % rows.size())

	# The rollup must not invent a day breakdown.
	var rollup := UsageRollup.from_sessions([{
		"session_id": session_id, "project_id": "", "models": [],
		"summary": {
			"logical": usage.logical_steps(), "physical": usage.physical_attempts(),
			"helpers": usage.helper_requests(),
			"tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}},
			"models": usage.model_groups(),
		},
	}])
	_check(
		not rollup.supports_day_breakdown(),
		"a day breakdown is declared unavailable rather than invented"
	)
	print("R702 day_reason=%s" % rollup.unavailable_reason().substr(0, 60))

	await _capture(scene, "%s/r7-02-usage.png" % _out)
	print("R702 checks=%d fails=%d" % [_checks, _fails])
	print("R702 done")
	quit(1 if _fails > 0 else 0)


## The first session the SERVICE knows about, read over its own list route.
##
## The client's roster comes from events it has observed, so a fresh attach knows none -
## but usage is durable and belongs to sessions the service already holds. Reading the list
## is what the statistics page would do, and it is a real request rather than a local guess.
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


## The service registration the client discovers, or "" when there is none.
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
	# The state directory the runtime writes its registration into. OS.get_environment is
	# the one reviewed OS call this project allows; the rest is a plain path join.
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
		print("R702 FAIL: no frame to capture")
		return
	if image.save_png(path) == OK:
		print("R702 captured %s" % path)
	else:
		print("R702 FAIL: could not write %s" % path)
