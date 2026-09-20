## R6-01 native evidence: the office reads a session's DURABLE history.
##
## The kit's verification for this clause is "send, see response, close/open inspector, switch
## sessions, restart desktop, confirm same durable content". This driver proves the part that
## was missing entirely: the office had NO canonical read, so a session it had not watched
## showed nothing.
##
## It goes through the CLIENT'S OWN modules - the real `ConversationApi` and the real
## `ConversationHistory` projection - against the real service, so what is checked is what the
## product does rather than a model of it.
##
## The decisive property is RESTART EQUIVALENCE: a brand-new reader that has observed NOTHING,
## with no live feed at all, must produce the same rows as the session's own durable content.
## A reader that only knew what the live feed told it would produce nothing here.
##
## Credentials come from the CLI's own registration and are never printed.
##
## Run:
##   godot --headless --path apps/office --script res://r6_01_history_tmp.gd
extends SceneTree

const TIMEOUT_MS := 60000

var _base := ""
var _password := ""
var _failed := 0
var _checks := 0


func _initialize() -> void:
	var reg := _read_registration()
	if reg.is_empty():
		print("R601H blocked: no usable service registration")
		quit(2)
		return
	_base = str(reg.get("url", ""))
	_password = str(reg.get("password", ""))

	# Find a session the service already has history for. This is what a restart looks like:
	# a client that has watched nothing, reading a session that already exists.
	var session_id := _first_session_with_messages()
	if session_id.is_empty():
		print("R601H blocked: no session with durable messages to read")
		quit(2)
		return
	print("R601H reading existing session ", session_id)

	# A FRESH reader, exactly as a restarted client would build one.
	var transport := HttpTransport.new()
	transport.configure(_base, Gateway.AUTH_USERNAME, _password)
	var api := ConversationApi.new()
	api.configure(transport)
	var started := api.start(session_id)
	_check(started, "the canonical read is issued to the service")
	var waited := 0
	while api.is_pending() and waited < 3000:
		api.poll()
		waited += 1
		OS.delay_msec(1)
	_check(not api.is_pending(), "the read settles within its budget")
	_check(api.last_error().is_empty(), "and reports no failure (%s)" % api.last_error())

	var rows := api.history.rows_for(session_id)
	_check(api.history.has_read(session_id), "the session is recorded as read")
	_check(rows.size() > 0, "a session with durable messages yields rows (%d)" % rows.size())

	# Every row must be source-linked, and none may carry private thinking.
	var private_markers := 0
	var ids: Array[String] = []
	for row in rows:
		var message_id := str(row.get("message_id", ""))
		ids.append(message_id)
		_check(message_id != "", "every row names its source message")
		var kind := str(row.get("kind", ""))
		_check(
			["prompt", "answer", "observation", "tool"].has(kind),
			"the row's kind is one of the declared ones ('%s')" % kind
		)
		# Reasoning is never projected, so no row may be a reasoning kind.
		if kind == "reasoning":
			private_markers += 1
	_check(private_markers == 0, "no row is private reasoning")

	# The decisive one: the rows the office now shows match the session's durable content,
	# read by a client that observed nothing.
	var durable := _raw_message_ids(session_id)
	print("R601H rows projected=%d, durable messages=%d" % [rows.size(), durable.size()])
	# A message may project into MORE than one row: an assistant message with tool parts
	# becomes an answer row PLUS one row per tool call. So the property is not a count but a
	# COVERAGE: every durable message contributes at least one row, and no row names a message
	# the service does not hold.
	var covered := {}
	for message_id in ids:
		covered[message_id] = true
	var missing := 0
	for message_id in durable:
		if str(message_id).is_empty():
			continue
		if not covered.has(message_id):
			missing += 1
	_check(
		missing == 0,
		"every durable message is represented by at least one row (%d missing)" % missing
	)
	var unmatched := 0
	for message_id in ids:
		if not durable.has(message_id):
			unmatched += 1
	_check(unmatched == 0, "every projected row's message exists durably (%d unmatched)" % unmatched)
	_check(
		covered.size() == durable.size(),
		"and the rows cover exactly the durable message set (%d vs %d)" % [covered.size(), durable.size()]
	)

	# A session the reader has NOT read is correctly reported as unread rather than empty.
	var other := _other_session(session_id)
	if not other.is_empty():
		_check(
			not api.history.has_read(other),
			"a session this reader has not read is unread, not empty"
		)
		_check(
			api.history.rows_for(other).is_empty(),
			"and yields no rows rather than another session's"
		)

	transport.cancel_all()
	print("R601H summary: checks=%d failed=%d" % [_checks, _failed])
	print("R601H RESULT: ", "PASSED" if _failed == 0 else "FAILED")
	quit(0 if _failed == 0 else 1)


## The raw message ids the service holds for a session, read with its own transport.
func _raw_message_ids(session_id: String) -> Dictionary:
	var ids := {}
	var transport := HttpTransport.new()
	transport.configure(_base, Gateway.AUTH_USERNAME, _password)
	var rid := transport.request(HTTPClient.METHOD_GET, Gateway.messages(session_id), {})
	var waited := 0
	while waited < 1200:
		for entry in transport.poll(4):
			if int(entry.get("request_id", -1)) != rid:
				continue
			if str(entry.get("kind", "")) == "response":
				var body: Variant = entry.get("body", {})
				if body is Dictionary:
					var data: Variant = (body as Dictionary).get(Gateway.ENVELOPE_DATA, [])
					if data is Array:
						for value in (data as Array):
							if value is Dictionary:
								ids[str((value as Dictionary).get("id", ""))] = true
				transport.cancel_all()
				return ids
		waited += 1
		OS.delay_msec(1)
	transport.cancel_all()
	return ids


## The first session the service reports that has durable messages.
func _first_session_with_messages() -> String:
	var transport := HttpTransport.new()
	transport.configure(_base, Gateway.AUTH_USERNAME, _password)
	var rid := transport.request(HTTPClient.METHOD_GET, Gateway.SESSION_LIST, {})
	var sessions: Array = []
	var waited := 0
	while waited < 1200:
		for entry in transport.poll(4):
			if int(entry.get("request_id", -1)) != rid:
				continue
			if str(entry.get("kind", "")) == "response":
				var body: Variant = entry.get("body", {})
				if body is Dictionary:
					var data: Variant = (body as Dictionary).get(Gateway.ENVELOPE_DATA, [])
					if data is Array:
						sessions = data
				waited = 99999
				break
		waited += 1
		OS.delay_msec(1)
	transport.cancel_all()
	for value in sessions:
		if not (value is Dictionary):
			continue
		var session_id := str((value as Dictionary).get("id", ""))
		if session_id.is_empty():
			continue
		if _raw_message_ids(session_id).size() >= 2:
			return session_id
	return ""


## A different session from the one just read, for the unread check.
func _other_session(session_id: String) -> String:
	var transport := HttpTransport.new()
	transport.configure(_base, Gateway.AUTH_USERNAME, _password)
	var rid := transport.request(HTTPClient.METHOD_GET, Gateway.SESSION_LIST, {})
	var waited := 0
	while waited < 1200:
		for entry in transport.poll(4):
			if int(entry.get("request_id", -1)) != rid:
				continue
			if str(entry.get("kind", "")) == "response":
				var body: Variant = entry.get("body", {})
				if body is Dictionary:
					var data: Variant = (body as Dictionary).get(Gateway.ENVELOPE_DATA, [])
					if data is Array:
						for value in (data as Array):
							if value is Dictionary:
								var candidate := str((value as Dictionary).get("id", ""))
								if not candidate.is_empty() and candidate != session_id:
									transport.cancel_all()
									return candidate
				waited = 99999
		waited += 1
		OS.delay_msec(1)
	transport.cancel_all()
	return ""


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if condition:
		print("R601H PASS: ", message)
		return
	_failed += 1
	print("R601H FAIL: ", message)


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
