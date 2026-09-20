## R1-06 real-provider smoke, driven through the OFFICE CLIENT's own transport stack.
##
## This is deliberately NOT a curl: it uses `LiveTransport` + `SessionApi`, the same
## modules the composer path uses, so the evidence covers the client's real request
## construction, auth, SSE parsing and settlement rather than an ad-hoc HTTP call.
##
## Credentials are read from the CLI's own registration file and are never printed.
## The prompt is the kit's bounded smoke ("reply with a short confirmation") and the
## response text is printed only after being stripped of anything that looks like a
## secret, because a provider echo can contain one.
extends SceneTree

const TIMEOUT_MS := 120000

var _live: LiveTransport
var _sessions: SessionApi
var _session_id := ""
var _created := false
var _submitted := false
var _deadline := 0
var _finished := false


func _initialize() -> void:
	var reg := _read_registration()
	if reg.is_empty():
		print("SMOKE blocked: no usable service registration")
		quit(2)
		return

	var base := str(reg.get("url", ""))
	var password := str(reg.get("password", ""))

	_sessions = SessionApi.new()
	_live = LiveTransport.new()
	var cfg := _live.configure(base, "ycoding", password)
	if not cfg.is_empty():
		print("SMOKE blocked: configure refused: ", cfg)
		quit(2)
		return

	_live.event_ready.connect(_on_event)
	_live.failure.connect(func(m: String): print("SMOKE live failure: ", _safe(m)))
	_live.play()

	# The side transport the session API needs, exactly as the composition root builds.
	var side := HttpTransport.new()
	side.configure(base, "ycoding", password)
	_sessions = SessionApi.new(side)
	# The id arrives on a signal, not in the poll entry: connect it or the smoke never
	# learns which session to prompt.
	_sessions.session_created.connect(func(id: String):
		if _session_id.is_empty():
			_session_id = id
			print("SMOKE session created id=", id)
	)
	_sessions.create_failed.connect(func(r: String):
		print("SMOKE create refused: ", _safe(r))
	)

	_deadline = Time.get_ticks_msec() + TIMEOUT_MS
	print("SMOKE start url=", base, " (credential withheld)")


func _process(_delta: float) -> bool:
	if _finished:
		return true
	if Time.get_ticks_msec() > _deadline:
		print("SMOKE result=timeout after ", TIMEOUT_MS, "ms; created=", _created,
			" submitted=", _submitted)
		quit(1)
		return true

	_live.advance(0)
	for entry in _sessions.poll(4):
		_route(entry)

	# Stage 1: create a session in a REAL directory. The client refuses an empty
	# location rather than guessing one, which is correct behaviour but means the smoke
	# must supply a directory; the repository itself is the honest choice.
	if not _created and _session_id.is_empty():
		var reason := _sessions.create_session(ProjectSettings.globalize_path("res://../.."), "", "")
		if not reason.is_empty():
			print("SMOKE blocked: create refused: ", _safe(reason))
			quit(2)
			return true
		_created = true
		return false

	# Stage 2: submit the bounded smoke once the session exists.
	if _created and not _submitted and not _session_id.is_empty():
		var reason := _live.submit_prompt(_session_id, "Reply with a single short confirmation.")
		if not reason.is_empty():
			print("SMOKE blocked: prompt refused: ", _safe(reason))
			quit(2)
			return true
		_submitted = true
		print("SMOKE submitted prompt to session=", _session_id)
		return false
	return false


func _route(entry: Dictionary) -> void:
	var kind := str(entry.get("kind", ""))
	var body: Variant = entry.get("body")
	if body is Dictionary:
		var data: Variant = (body as Dictionary).get("data")
		if data is Dictionary:
			var id := str((data as Dictionary).get("id", ""))
			if not id.is_empty() and _session_id.is_empty():
				_session_id = id
				print("SMOKE session created id=", id)


func _on_event(event: Dictionary) -> void:
	var type := str(event.get("type", ""))
	var data: Variant = event.get("data")
	var session := ""
	if data is Dictionary:
		session = str((data as Dictionary).get("sessionID", ""))
	# Only OUR session is evidence. The global feed carries every other session too,
	# and counting their events was the bug in the first attempt.
	if not _session_id.is_empty() and session != _session_id:
		return
	if type.is_empty():
		return
	if type.begins_with("session.text") or type.begins_with("session.reasoning"):
		print("SMOKE stream ", type)
		return
	print("SMOKE event ", type)
	if type == "session.step.ended":
		var finish := ""
		if data is Dictionary:
			finish = str((data as Dictionary).get("finish", ""))
		print("SMOKE step settled finish=", finish)
		if finish == "stop":
			print("SMOKE result=settled type=", type, " finish=", finish)
			_finished = true
			quit(0)
	if type == "session.execution.succeeded":
		print("SMOKE result=settled type=", type)
		_finished = true
		quit(0)


func _read_registration() -> Dictionary:
	var home := OS.get_environment("HOME")
	if home.is_empty():
		return {}
	var path := "%s/.local/state/ycoding/service.json" % home
	if not FileAccess.file_exists(path):
		return {}
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
	if parsed is Dictionary and not str((parsed as Dictionary).get("url", "")).is_empty():
		return parsed
	return {}


## Redact anything that could be a credential before printing. Provider echoes are not
## trusted to be secret-free.
func _safe(text: String) -> String:
	var lowered := text.to_lower()
	for marker in ["authorization", "bearer ", "api_key", "apikey", "sk-", "token="]:
		if lowered.find(marker) != -1:
			return "[redacted: response contained a credential-like marker]"
	return text.substr(0, 300)
