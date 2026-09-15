## Live attach integration check.
##
## Drives the REAL LiveTransport against the loopback fixture server, so the whole
## LIVE path is exercised: configure, health probe, connection state, and an event
## reaching the store. Needs a listening server, so it runs from
## tools/verify-integration.sh rather than the headless unit runner.
extends SceneTree

var _pass := 0
var _fail := 0
var _fails: Array[String] = []


func _check(condition: bool, message: String) -> void:
	if condition:
		_pass += 1
		return
	_fail += 1
	_fails.append(message)


func _init() -> void:
	var base := ""
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--base="):
			base = argument.substr(7)
	if base.is_empty():
		print("LIVE-ATTACH: missing --base")
		quit(1)
		return

	var live := LiveTransport.new()
	var states: Array[String] = []
	var errors: Array[String] = []
	var events: Array = []
	live.connection_changed.connect(func(state: String): states.append(state))
	live.failure.connect(func(message: String): errors.append(message))
	live.event_ready.connect(func(event: Dictionary): events.append(event))

	# An unconfigured transport must refuse rather than silently idle.
	var blank := LiveTransport.new()
	_check(not blank.configure("").is_empty(), "an empty address is refused")
	_check(not blank.is_synthetic(), "LIVE is never synthetic")

	var error := live.configure(base)
	_check(error.is_empty(), "the fixture address is accepted")
	_check(not live.is_playing(), "it does not claim to be connected before play")

	live.play()
	_check(live.is_playing(), "play starts the transport")
	_check(states.has(OfficeStore.CONNECTION_SYNCING), "it reports syncing first")
	_check(
		not states.has(OfficeStore.CONNECTION_LIVE),
		"it does not claim live before the service answers"
	)

	# Poll until the health probe settles.
	var deadline := Time.get_ticks_msec() + 4000
	while Time.get_ticks_msec() < deadline:
		live.advance(0)
		if states.has(OfficeStore.CONNECTION_LIVE):
			break
	_check(
		states.has(OfficeStore.CONNECTION_LIVE),
		"it reaches LIVE against a real service"
	)
	_check(errors.is_empty(), "no failure was reported")
	_check(live.last_error().is_empty(), "no error text was recorded")
	# The stream and the health probe race, and the service's own
	# `server.connected` frame can land first. What matters is that a connection
	# frame carrying the epoch arrives, not which one won.
	_check(events.size() >= 1, "frames reached the event stream")
	var connected := false
	var epoch_seen := false
	for event in events:
		if str(event.get("type", "")) == Wire.CONNECTED:
			connected = true
			if not str(event.get("sourceEpoch", "")).is_empty():
				epoch_seen = true
	_check(connected, "a connection frame reached the event stream")
	_check(epoch_seen, "the connection frame carries the service's source epoch")

	# Submitting a prompt and switching a model are the two mutations the composer
	# performs. Both must be real requests whose acceptance is observable as
	# durable state, not fire-and-forget calls.
	var session_id := "ses_attach"
	var created := HttpTransport.new()
	created.configure(base)
	created.request(HTTPClient.METHOD_POST, "/api/session", {"id": session_id})
	# Wait for the create to SETTLE. Polling until it returns empty exits on the
	# first call, before the socket has answered, and the prompt would then be
	# refused by a session the service never created.
	var created_ok := false
	var create_deadline := Time.get_ticks_msec() + 5000
	while Time.get_ticks_msec() < create_deadline and not created_ok:
		for entry in created.poll():
			if str(entry.get("kind", "")) == "response" and int(entry.get("status", 0)) == 200:
				created_ok = true
	_check(created_ok, "the fixture session was created for the prompt checks")

	# A refusal must be reported rather than silently ignored.
	_check(
		not live.submit_prompt("", "hello").is_empty(),
		"prompting with no session is refused before it reaches the socket"
	)
	_check(
		live.submit_prompt(session_id, "attach prompt", "msg_attach_1").is_empty(),
		"a prompt with a stable id is accepted"
	)

	# The proof of admission is the durable event the service publishes, which
	# arrives on the live feed the transport is already subscribed to.
	var admitted := false
	var prompt_deadline := Time.get_ticks_msec() + 5000
	while Time.get_ticks_msec() < prompt_deadline and not admitted:
		live.advance(0)
		for event in events:
			if str(event.get("type", "")) != "session.input.admitted":
				continue
			var data: Dictionary = event.get("data", {})
			if str(data.get("inputID", "")) == "msg_attach_1":
				admitted = true
	_check(admitted, "the prompt became durable state the service announced")

	_check(
		live.switch_model(session_id, "openrouter/deepseek/deepseek-v4.1-flash#high").is_empty(),
		"a valid model reference is accepted"
	)
	_check(
		not live.switch_model(session_id, "openrouter").is_empty(),
		"a reference with no model id is refused"
	)

	# A canonical reload must rebuild the projection from the durable logs. The
	# feed is volatile, so a reconnect may have holes; a reload that returns
	# nothing while reporting success would silently empty the office.
	var reload_frames: Array = []
	var reload_failures: Array = []
	live.reload_ready.connect(func(frames: Array, _epoch: String): reload_frames.append_array(frames))
	live.reload_failed.connect(func(reason: String): reload_failures.append(reason))
	live.reload()
	_check(live.is_reloading(), "a reload reports that it is in progress")

	var reload_deadline := Time.get_ticks_msec() + 8000
	while Time.get_ticks_msec() < reload_deadline and live.is_reloading():
		live.advance(0)
	_check(not live.is_reloading(), "the reload settles rather than hanging")
	_check(reload_failures.is_empty(), "the reload reported no failure")
	_check(reload_frames.size() > 0, "the reload returned real frames, not an empty batch")

	var reload_types := {}
	for frame in reload_frames:
		reload_types[str(frame.get("type", ""))] = true
	_check(
		reload_types.has("session.created"),
		"the reload replayed a session's durable history"
	)
	_check(
		not reload_types.has("log.synced"),
		"the log watermark is bookkeeping, not a replayed event"
	)

	live.stop()
	_check(not live.is_playing(), "stop ends the transport")

	print("LIVE-ATTACH: pass=%d fail=%d" % [_pass, _fail])
	for failure in _fails:
		print("  FAIL: ", failure)
	quit(1 if _fail > 0 else 0)
