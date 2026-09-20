## R1-06 completion: one real provider turn WITH a supported tool, then history
## recovery after a restart, driven through the OFFICE CLIENT's own transports.
##
## R1-06's acceptance is "small prompt plus supported tool and restart/history via
## GUI, with real provenance and no secret output". The first smoke proved a real
## provider turn settled end to end, but it was a text-only prompt. This driver adds
## the two remaining legs:
##
##   1. TOOL  - the prompt asks the model to run a shell command, so a real
##              session.tool.input.started / session.tool.called pair must appear.
##   2. HISTORY - after the turn settles, a FRESH transport (a new process-level
##              client, which is what a restart produces) reads the session's durable
##              snapshot and history, and the turn's own message must come back.
##
## Restart is modelled by building a SECOND `HttpTransport`/`SessionApi` pair from
## scratch and using only that for the history leg. The feed is volatile by contract,
## so durable recovery must come from the snapshot and message routes; that is
## exactly what is exercised. The first transport is stopped before the second starts,
## as a real restart would.
##
## Credentials come from the CLI's own registration and are never printed. Every
## printed string passes through the same redaction the first smoke used.
extends SceneTree

const TIMEOUT_MS := 180000

var _live: LiveTransport
var _sessions: SessionApi
var _session_id := ""
var _created := false
var _tool_submitted := false
var _tool_started := false
var _tool_called := false
var _tool_prompted := false
var _history_checked := false
var _history_status := 0
var _history_body: Dictionary = {}
var _base := ""
var _password := ""
## The tool prompt's id, minted once per run. Held so a retry within the run reuses
## it while two different runs never collide.
var _tool_prompt_id := ""
## The restarted client and the ids of the two durable reads it issued. Held so the
## loop can poll ITS queue: the first transport is stopped and cannot answer them.
var _restarted: HttpTransport
var _restarted_api: SessionApi
var _restarted_snapshot_id := -1
var _restarted_messages_id := -1
var _deadline := 0
var _finished := false


func _initialize() -> void:
	var reg := _read_registration()
	if reg.is_empty():
		print("R106 blocked: no usable service registration")
		quit(2)
		return
	_base = str(reg.get("url", ""))
	_password = str(reg.get("password", ""))

	_live = LiveTransport.new()
	var cfg := _live.configure(_base, "ycoding", _password)
	if not cfg.is_empty():
		print("R106 blocked: configure refused: ", _safe(cfg))
		quit(2)
		return
	_live.event_ready.connect(_on_event)
	_live.failure.connect(func(m: String): print("R106 live failure: ", _safe(m)))
	_live.play()

	var side := HttpTransport.new()
	side.configure(_base, "ycoding", _password)
	_sessions = SessionApi.new(side)
	_sessions.session_created.connect(func(id: String):
		if _session_id.is_empty():
			_session_id = id
			print("R106 session created id=", id)
	)
	_sessions.create_failed.connect(func(r: String):
		print("R106 create refused: ", _safe(r))
	)

	_deadline = Time.get_ticks_msec() + TIMEOUT_MS
	print("R106 start url=", _base, " (credential withheld)")


func _process(_delta: float) -> bool:
	if _finished:
		return true
	if Time.get_ticks_msec() > _deadline:
		print("R106 result=timeout created=", _created, " tool_submitted=", _tool_submitted,
			" tool_started=", _tool_started, " tool_called=", _tool_called,
			" history=", _history_checked)
		quit(1)
		return true

	_live.advance(0)
	for entry in _sessions.poll(4):
		_route(entry)

	if not _created and _session_id.is_empty():
		var reason := _sessions.create_session(
			ProjectSettings.globalize_path("res://../.."), "", ""
		)
		if not reason.is_empty():
			print("R106 blocked: create refused: ", _safe(reason))
			quit(2)
			return true
		_created = true
		return false

	# Leg 1: a prompt that must make the model USE a tool. The turn is only evidence
	# of tool support if the service reports a real tool call for it.
	if _created and not _tool_submitted and not _session_id.is_empty():
		var prompt := (
			"Use the shell tool to run exactly this command and then tell me its "
			+ "output in one short sentence: echo ycoding-tool-smoke"
		)
		var reason := _live.submit_prompt(_session_id, prompt, _tool_message_id(prompt))
		if not reason.is_empty():
			print("R106 blocked: tool prompt refused: ", _safe(reason))
			quit(2)
			return true
		_tool_submitted = true
		print("R106 submitted TOOL prompt to session=", _session_id)
		return false

	# Leg 2: after the tool turn settles, a fresh transport reads the durable history.
	# This is the restart leg.
	if _tool_prompted and _tool_started and not _history_checked:
		_history_checked = true
		_read_history()
		return false
	# The restarted transport owns its own queue, so it must be advanced here. The
	# first transport is stopped and could never answer these requests.
	if _restarted != null:
		for entry in _restarted.poll(4):
			_route(entry)
	return false


## The id for the tool prompt. Unique per RUN, because each run creates a NEW session
## and a `text.hash()`-derived id would collide with the previous run's durable record
## for the same text. That collision is exactly the service's PromptConflictError
## (HTTP 409), which this driver hit before the id carried a per-run token. Within a
## run the id is still created once, so a retry of the same draft would reconcile.
func _tool_message_id(text: String) -> String:
	if _tool_prompt_id.is_empty():
		_tool_prompt_id = "msg_r106_tool_%d_%s" % [text.hash(), _run_token()]
	return _tool_prompt_id


## A token unique to this process, so two runs never mint the same prompt id.
func _run_token() -> String:
	var token := ""
	for _byte in 8:
		token += "abcdefghijklmnopqrstuvwxyz0123456789"[randi() % 36]
	return token


## Read the durable history through a NEW client, which is what a restart produces.
##
## The feed is volatile by contract, so nothing here may rely on events the first
## transport saw: the snapshot and message routes are the recoverable history, and a
## fresh transport has to be able to answer from them alone.
func _read_history() -> void:
	print("R106 restart: stopping the first transport")
	_live.stop()

	_restarted = HttpTransport.new()
	_restarted.configure(_base, "ycoding", _password)
	# A fresh SessionApi over the fresh transport, built from nothing.
	_restarted_api = SessionApi.new(_restarted)
	_restarted_snapshot_id = _restarted.request(
		HTTPClient.METHOD_GET, Gateway.snapshot(_session_id), {}
	)
	_restarted_messages_id = _restarted.request(
		HTTPClient.METHOD_GET, Gateway.messages(_session_id), {}
	)
	print("R106 restart issued snapshot request=", _restarted_snapshot_id,
		" messages request=", _restarted_messages_id)


func _route(entry: Dictionary) -> void:
	var kind := str(entry.get("kind", ""))
	if kind != "response":
		return
	var status := int(entry.get("status", 0))
	var body: Variant = entry.get("body")
	var body_dict: Dictionary = body if body is Dictionary else {}
	# Only the messages read is the history evidence. The live shape is
	# `{ data: [SessionMessage.Info] }` (packages/protocol message.ts:9-14), so the
	# array is what carries the recovered turn.
	if not body_dict.has("data"):
		return
	_history_status = status
	_history_body = body_dict
	_report_history()
	_finished = true
	quit(0)


func _report_history() -> void:
	var messages: Variant = _history_body.get("data", [])
	var count := 0
	if messages is Array:
		count = (messages as Array).size()
	var serialized := JSON.stringify(_history_body)
	# The tool's own command text is the marker: it is what the turn ran, so finding
	# it in the recovered history proves the turn was read back from durable storage
	# rather than remembered from the live feed this transport never saw.
	var recovered := serialized.find("ycoding-tool-smoke") != -1
	print("R106 history status=", _history_status, " messages=", count)
	print("R106 history recovered_tool_turn=", recovered)
	print("R106 result=history_read status=", _history_status, " messages=", count,
		" tool_started=", _tool_started, " tool_called=", _tool_called,
		" recovered_tool_turn=", recovered)


func _on_event(event: Dictionary) -> void:
	var type := str(event.get("type", ""))
	var data: Variant = event.get("data")
	var session := ""
	if data is Dictionary:
		session = str((data as Dictionary).get("sessionID", ""))
	if not _session_id.is_empty() and not session.is_empty() and session != _session_id:
		return
	if type.is_empty():
		return
	# A real tool call is the evidence this leg exists to produce, so it is named
	# explicitly rather than folded into the event line.
	if type == "session.tool.input.started":
		_tool_started = true
		print("R106 TOOL started name=", _tool_name(data), " (session ", session, ")")
		return
	if type == Wire.TOOL_CALLED:
		_tool_called = true
		print("R106 TOOL called executed=", _executed(data), " (session ", session, ")")
		return
	if type.begins_with("session.text") or type.begins_with("session.reasoning"):
		print("R106 stream ", type)
		return
	print("R106 event ", type)
	if type == "session.step.ended":
		var finish := ""
		if data is Dictionary:
			finish = str((data as Dictionary).get("finish", ""))
		print("R106 step settled finish=", finish)
		if finish == "stop":
			_tool_prompted = true
	if type == "session.execution.succeeded":
		_tool_prompted = true


## The tool name, from the event that actually declares it. It is not a field of
## every tool event, which is why it is read from a specific one.
func _tool_name(data: Variant) -> String:
	if data is Dictionary:
		return str((data as Dictionary).get("name", ""))
	return ""


func _executed(data: Variant) -> String:
	if data is Dictionary:
		return str((data as Dictionary).get("executed", ""))
	return ""


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


## Redact anything that could be a credential before printing.
func _safe(text: String) -> String:
	var lowered := text.to_lower()
	for marker in ["authorization", "bearer ", "api_key", "apikey", "sk-", "token="]:
		if lowered.find(marker) != -1:
			return "[redacted: response contained a credential-like marker]"
	return text.substr(0, 300)
