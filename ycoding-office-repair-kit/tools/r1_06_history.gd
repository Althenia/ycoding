## R1-06 restart/history leg: read a SETTLED tool turn's durable history through a
## FRESH client.
##
## The first R1-06 completion run produced session `ses_f53be6ed8ffe3BRDN6O5jURbPY`
## with a real, settled tool turn (session.tool.input.started name=shell ->
## session.tool.called -> session.tool.success -> shell.created/shell.exited).
##
## That turn is durable state. This driver proves the RESTART leg without needing a
## new provider turn, which matters because the provider was failing steps
## intermittently while this was being verified: it builds a brand-new
## `HttpTransport`, reads the session's snapshot and message history, and checks that
## the turn's own tool command text comes back. Nothing is remembered from a live
## feed, because this process never opened one - which is exactly the restart case.
##
## The session id is supplied on the command line so the read targets the recorded
## turn rather than a guessed one. Credentials come from the CLI registration and are
## never printed; every printed string is redacted.
##
## Run with:
##   godot --headless --path apps/office --script res://r1_06_history_tmp.gd -- <sessionID>
extends SceneTree

const TIMEOUT_MS := 60000

## The marker the tool actually ran. Finding it in the recovered history proves the
## turn was read back from durable storage rather than re-derived.
const TOOL_MARKER := "ycoding-tool-smoke"

var _session_id := ""
var _base := ""
var _password := ""
var _transport: HttpTransport
var _snapshot_id := -1
var _messages_id := -1
var _snapshot_status := 0
var _messages_status := 0
var _messages_count := 0
var _marker_found := false
var _seen := false
var _deadline := 0


func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if not str(arg).begins_with("--") and _session_id.is_empty():
			_session_id = str(arg)
	if _session_id.is_empty():
		print("R106H blocked: no session id supplied")
		quit(2)
		return

	var reg := _read_registration()
	if reg.is_empty():
		print("R106H blocked: no usable service registration")
		quit(2)
		return
	_base = str(reg.get("url", ""))
	_password = str(reg.get("password", ""))

	# A brand-new client. This process has never held a live feed, so everything it
	# reports must come from the durable routes.
	_transport = HttpTransport.new()
	# `HttpTransport.configure` returns void and records any parse failure in
	# `last_error()`, unlike LiveTransport's returning form.
	_transport.configure(_base, "ycoding", _password)
	if not _transport.last_error().is_empty():
		print("R106H blocked: configure refused: ", _safe(_transport.last_error()))
		quit(2)
		return

	_snapshot_id = _transport.request(HTTPClient.METHOD_GET, Gateway.snapshot(_session_id), {})
	_messages_id = _transport.request(HTTPClient.METHOD_GET, Gateway.messages(_session_id), {})
	_deadline = Time.get_ticks_msec() + TIMEOUT_MS
	print("R106H start url=", _base, " session=", _session_id, " (credential withheld)")


func _process(_delta: float) -> bool:
	if _seen:
		return true
	if Time.get_ticks_msec() > _deadline:
		print("R106H result=timeout snapshot=", _snapshot_status, " messages=", _messages_status)
		quit(1)
		return true
	for entry in _transport.poll(4):
		_route(entry)
	return false


func _route(entry: Dictionary) -> void:
	if str(entry.get("kind", "")) != "response":
		return
	var status := int(entry.get("status", 0))
	var body: Variant = entry.get("body")
	var dict: Dictionary = body if body is Dictionary else {}

	# The messages read is the history evidence. Its live shape is
	# `{ data: [SessionMessage.Info] }` (packages/protocol/src/groups/message.ts:9-14).
	if dict.has("data") and (dict["data"] is Array):
		_messages_status = status
		var rows: Array = dict["data"]
		_messages_count = rows.size()
		_marker_found = JSON.stringify(rows).find(TOOL_MARKER) != -1
		_seen = true
		print("R106H messages status=", status, " count=", _messages_count)
		print("R106H marker_in_messages=", _marker_found)
		print("R106H result=history_read messages=", _messages_count,
			" marker_recovered=", _marker_found)
		quit(0)
		return

	# Anything else with a session-shaped body is the snapshot read.
	if dict.has("session") or dict.has("id") or dict.has("sourceEpoch"):
		_snapshot_status = status
		var serialized := JSON.stringify(dict)
		print("R106H snapshot status=", status,
			" marker_in_snapshot=", serialized.find(TOOL_MARKER) != -1)


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


func _safe(text: String) -> String:
	var lowered := text.to_lower()
	for marker in ["authorization", "bearer ", "api_key", "apikey", "sk-", "token="]:
		if lowered.find(marker) != -1:
			return "[redacted: response contained a credential-like marker]"
	return text.substr(0, 300)
