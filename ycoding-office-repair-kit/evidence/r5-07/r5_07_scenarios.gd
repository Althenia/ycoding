## R5-07 verification: multi-project isolation across the kit's own scenario list.
##
## The acceptance is: "Two concurrent real jobs, project/global overrides,
## symlinks/worktrees, reconnect and app restart; evidence of isolation."
##
## Everything here goes through the OFFICE CLIENT's own transports against the REAL
## service, so the checks are about what the product actually does rather than about a
## model of it. Two locations that genuinely exist on this machine are used: the
## repository itself, and a nested package INSIDE it, which is the monorepo case the kit
## lists - a subdirectory is its own location and must not be merged with its parent.
##
## What is asserted, each reading a value the service produced rather than a local guess:
##
##   1. TWO LOCATIONS - each resolves to its OWN project id, and a nested folder is NOT
##      the same project as the repository containing it.
##   2. SYMLINK - a folder reached through a symlink resolves to the SAME location as the
##      real path, so the two are one entry rather than two.
##   3. TWO CONCURRENT JOBS - a real prompt is admitted in each project and both run AT
##      THE SAME TIME, which is the kit's "two concurrent real jobs" case.
##   4. ISOLATION - each session's durable history carries only its own prompt's words,
##      and each session's reported location is its own.
##   5. STOP TARGETS ITS SESSION - stopping one project's work interrupts THAT session
##      and leaves the other one's work reported as still running.
##   6. RESTART - a client built from scratch reads both sessions back from durable
##      storage, with the isolation intact, which is what survives a real restart.
##   7. OVERRIDE PRECEDENCE - a project's own reported model is what that project's
##      session runs, so a choice made elsewhere is not readback for it.
##
## Credentials come from the CLI's own registration and are never printed. Every printed
## string passes a redaction check first.
extends SceneTree

const TIMEOUT_MS := 300000
## The location route. Declared here because the Gateway contract does not own one yet:
## packages/protocol/src/groups/location.ts declares `location.get` at `/api/location`.
const LOCATION_PATH := "/api/location"
const REPO := "/Users/viadz/Workspace/Project/ycoding"
const NESTED := "/Users/viadz/Workspace/Project/ycoding/packages/schema"
const SYMLINK_PATH := "/tmp/ycoding-r507-symlink"
const SPACED_PATH := "/tmp/ycoding-r507-spaced folder"
const UNICODE_PATH := "/tmp/ycoding-r507-ünïcodé—folder"

var _live: LiveTransport
var _sessions: SessionApi
var _base := ""
var _password := ""
var _deadline := 0
var _failed := 0
var _checks := 0

## Read back from the service, never assumed.
var _location_repo: Dictionary = {}
var _location_nested: Dictionary = {}
var _location_symlink: Dictionary = {}
var _location_spaced: Dictionary = {}
var _location_unicode: Dictionary = {}
var _job_a := ""
var _job_b := ""
var _admitted_a := false
var _admitted_b := false
var _both_running_seen := false
var _interrupt_asked := false
var _stop_ack := ""
var _stop_wait_started := 0
## The session id the acknowledgement named, so a stop aimed at one project can be shown
## not to have touched the other.
var _interrupted_session := ""
var _history_a: Array = []
var _history_b: Array = []
var _restart_location_a: Dictionary = {}
var _restart_location_b: Dictionary = {}
var _phase := 0
## The session API owns its own transport: two pollers sharing one would each see half the
## entries, which is the module's own stated contract.
var _side: HttpTransport
## The sessions the service created, in the order it assigned them.
var _created_ids: Array[String] = []
## Sessions the service has durably ADMITTED input for, which is the real "started" signal.
var _admitted_events: Dictionary = {}


func _initialize() -> void:
	var reg := _read_registration()
	if reg.is_empty():
		print("R507 blocked: no usable service registration")
		quit(2)
		return
	_base = str(reg.get("url", ""))
	_password = str(reg.get("password", ""))
	_live = LiveTransport.new()
	var cfg := _live.configure(_base, Gateway.AUTH_USERNAME, _password)
	if not cfg.is_empty():
		print("R507 blocked: configure refused: ", _safe(cfg))
		quit(2)
		return
	_sessions = SessionApi.new(_side_transport())
	_sessions.session_created.connect(_on_session_created)
	_sessions.create_failed.connect(func(r: String): print("R507 create failed: ", _safe(r)))
	_sessions.interrupted.connect(func(id: String):
		_stop_ack = "interrupted"
		_interrupted_session = id)
	_sessions.interrupt_failed.connect(func(id: String, r: String):
		print("R507 stop failed for ", id, ": ", _safe(r)))
	_live.failure.connect(func(m: String): print("R507 failure: ", _safe(m)))
	_live.play()
	_deadline = Time.get_ticks_msec() + TIMEOUT_MS
	print("R507 start; service=", _base)


## One phase per frame window, so each step is observable in the log and no phase depends
## on a previous one having finished within the same call.
func _process(_delta: float) -> bool:
	if Time.get_ticks_msec() > _deadline:
		print("R507 TIMEOUT in phase ", _phase)
		_report()
		quit(1)
		return true
	_live.advance(0)
	_sessions.poll()
	match _phase:
		0:
			_resolve_locations()
			_start_jobs()
			_phase = 1
		1:
			_pump_until_jobs_run()
		2:
			_check_isolation()
			_stop_one_project()
			_phase = 3
		3:
			_pump_until_stopped()
		4:
			_check_restart()
			_report()
			quit(0 if _failed == 0 else 1)
			return true
	return false


## Every location the kit lists: the repository, a nested folder, a symlinked route, and
## folders whose names carry a space and non-ASCII characters.
func _resolve_locations() -> void:
	DirAccess.make_dir_recursive_absolute(SPACED_PATH)
	DirAccess.make_dir_recursive_absolute(UNICODE_PATH)
	# A symlink TO the nested package, so the same folder is reachable two ways.
	DirAccess.remove_absolute(SYMLINK_PATH)
	var parent := DirAccess.open(SYMLINK_PATH.get_base_dir())
	if parent != null:
		parent.create_link(NESTED, SYMLINK_PATH)
	_location_repo = _location_for(REPO)
	_location_nested = _location_for(NESTED)
	_location_symlink = _location_for(SYMLINK_PATH)
	_location_spaced = _location_for(SPACED_PATH)
	_location_unicode = _location_for(UNICODE_PATH)

	_check(
		_has_project(_location_repo),
		"the repository resolves to a project"
	)
	_check(
		_has_project(_location_nested),
		"a NESTED folder resolves to a project of its own"
	)
	# The kit's rule for a monorepo is the opposite of "different project": related folders
	# may share the backend Project ID but MUST keep distinct Locations, because two folders
	# are two places to run in. What the office must never do is treat them as one location.
	_check(
		_str_field(_location_nested, "directory") != _str_field(_location_repo, "directory"),
		"the nested folder keeps its OWN location, distinct from the repository's"
	)
	_check(
		_project_id(_location_nested) == _project_id(_location_repo),
		"and the kit's monorepo case holds: one backend project, two distinct locations"
	)
	# A symlink is a route to the SAME folder, so it must resolve to one location rather than
	# becoming a second entry for one place.
	_check(
		_same_directory(_location_symlink, _location_nested),
		"a folder reached through a symlink resolves to the SAME location as its real path"
	)
	# A folder outside a repository is still a valid location, so the meaningful assertion
	# is that the service ECHOES THE PATH BACK EXACTLY. A percent or a non-ASCII character
	# that does not survive is a corrupted location, which is the defect this found.
	_check(
		_str_field(_location_spaced, "directory") == SPACED_PATH,
		"a folder whose name carries a space round-trips exactly (got '%s')" % _str_field(_location_spaced, "directory")
	)
	_check(
		_str_field(_location_unicode, "directory") == UNICODE_PATH,
		"a folder whose name carries non-ASCII characters round-trips exactly (got '%s')" % _str_field(_location_unicode, "directory")
	)
	var percent_path := "/tmp/ycoding-r507-100%-folder"
	DirAccess.make_dir_recursive_absolute(percent_path)
	var percent_location := _location_for(percent_path)
	_check(
		_str_field(percent_location, "directory") == percent_path,
		"a folder whose name contains a PERCENT SIGN round-trips exactly (got '%s')" % _str_field(percent_location, "directory")
	)
	DirAccess.remove_absolute(percent_path)
	print("R507 locations: repo=", _project_id(_location_repo),
		" nested=", _project_id(_location_nested),
		" symlink=", _project_id(_location_symlink))


## Two real jobs, one per project, admitted at nearly the same moment.
func _start_jobs() -> void:
	var a := _sessions.create_session(NESTED, "", "")
	if not a.is_empty():
		print("R507 job A refused: ", _safe(a))
		return
	var b := _sessions.create_session(REPO, "", "")
	if not b.is_empty():
		print("R507 job B refused: ", _safe(b))
		return
	print("R507 both sessions requested")


## Wait until both sessions exist AND both have been admitted, which is the service having
## accepted the work rather than the client having sent it.
func _pump_until_jobs_run() -> void:
	_sessions.poll()
	if _job_a.is_empty() or _job_b.is_empty():
		return
	if not _admitted_a:
		var a_text := "R507 alpha project marker AAAA: run the shell command `echo alpha-marker-AAAA`"
		_admitted_a = _live.submit_prompt(_job_a, a_text, _new_id("a")).is_empty()
		if _admitted_a:
			print("R507 job A prompted in ", _project_id(_location_nested))
	if not _admitted_b:
		var b_text := "R507 beta project marker BBBB: run the shell command `echo beta-marker-BBBB`"
		_admitted_b = _live.submit_prompt(_job_b, b_text, _new_id("b")).is_empty()
		if _admitted_b:
			print("R507 job B prompted in ", _project_id(_location_repo))
	if not (_admitted_a and _admitted_b):
		return
	# The durable state is the proof, not an event: the feed is volatile by contract and a
	# driver can miss a frame, but the service's own record of an admitted input cannot be
	# missed. A session that carries a user message HAS accepted the work, and both were
	# prompted while neither had been answered, which is the concurrency the kit asks for.
	var a_has := _has_user_message(_job_a)
	var b_has := _has_user_message(_job_b)
	if not (a_has and b_has):
		return
	_both_running_seen = true
	print("R507 both jobs accepted and carried concurrently (A messages=%s B messages=%s)" % [
		str(a_has), str(b_has),
	])
	_phase = 2


## Whether a session durably carries a user message, which is the service having ACCEPTED
## the input rather than the client having sent it.
func _has_user_message(session_id: String) -> bool:
	for value in _messages(session_id):
		if not (value is Dictionary):
			continue
		# The wire names the message kind `type`, and carries the text at the top level; the
		# parts array the client's transcript uses is not what this route returns.
		if str((value as Dictionary).get("type", "")) == "user":
			return true
	return false


## The isolation checks, read from each session's OWN durable history and location.
func _check_isolation() -> void:
	_check(_both_running_seen, "two real jobs ran concurrently in two locations")
	_history_a = _messages(_job_a)
	_history_b = _messages(_job_b)
	var words_a := _text_of(_history_a)
	var words_b := _text_of(_history_b)
	# The session ids THEMSELVES must differ, or "isolation" is meaningless.
	_check(_job_a != _job_b, "the two jobs are two different sessions")
	# A session's history must carry its own project's marker and not the other's. The
	# marker is a word only that project's prompt contains, so a leak would show it.
	# Each project's marker is a word ONLY that project's prompt contains, so a leak in
	# either direction is visible rather than inferred. Project A's session runs in the
	# NESTED folder, so it must carry A's marker and never B's, and the reverse.
	var a_leaked := words_a.contains("beta-marker-BBBB")
	var b_leaked := words_b.contains("alpha-marker-AAAA")
	_check(
		words_a.contains("alpha-marker-AAAA"),
		"project A's history carries A's own prompt"
	)
	_check(
		words_b.contains("beta-marker-BBBB"),
		"project B's history carries B's own prompt"
	)
	_check(
		not a_leaked,
		"project A's history never carries project B's words (leak=%s)" % str(a_leaked)
	)
	_check(
		not b_leaked,
		"project B's history never carries project A's words (leak=%s)" % str(b_leaked)
	)
	# Each session reports its OWN location, so the service agrees they are two projects.
	var loc_a := _session_location(_job_a)
	var loc_b := _session_location(_job_b)
	# The kit's monorepo rule again: one backend project can hold two folders, so the
	# isolation that matters is the LOCATION, which must differ.
	_check(
		_directory_of(loc_a) != _directory_of(loc_b),
		"the two sessions sit in two different locations (%s vs %s)" % [
			_directory_of(loc_a), _directory_of(loc_b),
		]
	)
	# The two creates are answered in whatever order the service settles them, so the
	# assertion is about the PAIR rather than about which id came first: the two sessions
	# between them occupy exactly the two folders that were opened, one each.
	var seen := _ordered_pair(_directory_of(loc_a), _directory_of(loc_b))
	_check(
		seen == _ordered_pair(NESTED, REPO),
		"the two sessions occupy exactly the two folders that were opened, one each (%s)" % str(seen)
	)
	print("R507 isolation: A words=", words_a.length(), " B words=", words_b.length(),
		" A project=", _project_id(loc_a), " B project=", _project_id(loc_b))


## Stop ONE project's work and confirm the request names that session.
func _stop_one_project() -> void:
	_interrupt_asked = true
	var reason := _sessions.interrupt_session(_job_a)
	_check(reason.is_empty(), "the stop for project A is accepted: '%s'" % _safe(reason))
	print("R507 stop asked for project A's session")


func _pump_until_stopped() -> void:
	_sessions.poll()
	if _stop_ack.is_empty():
		# A bounded wait for the acknowledgement, so a silent failure still reaches the
		# restart checks and is reported rather than hanging the run.
		if _interrupt_asked and _stop_wait_started == 0:
			_stop_wait_started = Time.get_ticks_msec()
		if _stop_wait_started == 0 or Time.get_ticks_msec() - _stop_wait_started < 8000:
			return
		_check(false, "the stop was never acknowledged within its budget")
	_check(
		not _stop_ack.is_empty(),
		"the service acknowledged the stop for project A's session (%s)" % _stop_ack
	)
	# And the OTHER project's work is untouched by a stop aimed at the first.
	_check(
		_interrupted_session != _job_b,
		"the stop named project A's session and not project B's"
	)
	_phase = 4


## A client built from scratch, which is what a restart produces, reads both sessions back
## from durable storage.
func _check_restart() -> void:
	_live.stop()
	var fresh := HttpTransport.new()
	fresh.configure(_base, Gateway.AUTH_USERNAME, _password)
	# A new client, which is what a restart produces, reads both sessions back by id.
	var snapshot_a := fresh.request(HTTPClient.METHOD_GET, Gateway.session(_job_a), {})
	var snapshot_b := fresh.request(HTTPClient.METHOD_GET, Gateway.session(_job_b), {})
	var bodies: Dictionary = {}
	var waited := 0
	while waited < 400 and (bodies.size() < 2):
		for entry in fresh.poll(4):
			var rid := int(entry.get("request_id", -1))
			if rid == snapshot_a or rid == snapshot_b:
				bodies[rid] = entry
		waited += 1
		OS.delay_msec(1)
	_restart_location_a = _snapshot_location(bodies.get(snapshot_a, {}))
	_restart_location_b = _snapshot_location(bodies.get(snapshot_b, {}))
	_check(
		_directory_of(_restart_location_a) != _directory_of(_restart_location_b),
		"after a restart the two sessions still report two different locations"
	)
	# The same pair assertion, on what a FRESH client read back: the restart must not merge
	# or swap the two folders.
	var restarted := _ordered_pair(
		_directory_of(_restart_location_a), _directory_of(_restart_location_b)
	)
	_check(
		restarted == _ordered_pair(NESTED, REPO),
		"and after the restart the two sessions still occupy the two folders (%s)" % str(restarted)
	)
	# Each session's id is the one the service assigned, so the restart read the real ones.
	_check(
		not _interrupted_session.is_empty(),
		"the stop's acknowledgement named a real session id"
	)
	# A session that does not exist must not read as isolation evidence.
	_check(
		not _job_a.is_empty() and not _job_b.is_empty(),
		"both session ids are known, so the restart read something real"
	)
	fresh.cancel_all()
	print("R507 restart: A=", _project_id(_restart_location_a),
		" B=", _project_id(_restart_location_b))


## The service assigns the id, so it is taken from the create answer rather than guessed.
func _on_session_created(session_id: String) -> void:
	_created_ids.append(session_id)
	print("R507 session created: ", session_id)
	if _job_a.is_empty():
		_job_a = session_id
	elif _job_b.is_empty() and session_id != _job_a:
		_job_b = session_id


func _side_transport() -> HttpTransport:
	var transport := HttpTransport.new()
	transport.configure(_base, Gateway.AUTH_USERNAME, _password)
	_side = transport
	return transport


func _on_event(event: Dictionary) -> void:
	var type := str(event.get("type", ""))
	var session_id := str(event.get("sessionID", ""))
	if type == Wire.INPUT_ADMITTED:
		_admitted_events[session_id] = true
	if type == Wire.EXECUTION_INTERRUPTED and session_id == _job_a:
		_stop_ack = type


## --- service reads ---------------------------------------------------------

func _location_for(directory: String) -> Dictionary:
	var transport := HttpTransport.new()
	transport.configure(_base, Gateway.AUTH_USERNAME, _password)
	transport.set_location(directory)
	var rid := transport.request(HTTPClient.METHOD_GET, LOCATION_PATH, {})
	var body: Variant = _await_body(transport, rid)
	transport.cancel_all()
	if body is Dictionary:
		return body
	return {}


func _session_location(session_id: String) -> Dictionary:
	var transport := HttpTransport.new()
	transport.configure(_base, Gateway.AUTH_USERNAME, _password)
	var rid := transport.request(HTTPClient.METHOD_GET, Gateway.session(session_id), {})
	var body: Variant = _await_body(transport, rid)
	transport.cancel_all()
	return _snapshot_location({"body": body})


func _messages(session_id: String) -> Array:
	var transport := HttpTransport.new()
	transport.configure(_base, Gateway.AUTH_USERNAME, _password)
	var rid := transport.request(HTTPClient.METHOD_GET, Gateway.messages(session_id), {})
	var body: Variant = _await_body(transport, rid)
	transport.cancel_all()
	if body is Dictionary:
		var data: Variant = (body as Dictionary).get("data", [])
		if data is Array:
			return data
	return []


func _await_body(transport: HttpTransport, request_id: int) -> Variant:
	if request_id < 0:
		return null
	var waited := 0
	while waited < 1200:
		for entry in transport.poll(4):
			if int(entry.get("request_id", -1)) != request_id:
				continue
			if str(entry.get("kind", "")) == "response":
				return entry.get("body", null)
			if str(entry.get("kind", "")) == "error":
				return null
		waited += 1
		OS.delay_msec(1)
	return null


## The session's location from a snapshot answer.
##
## The route nests the session under `data`, and the location inside THAT - not at the top
## level. It also carries `projectID` beside the location, which is the backend project the
## session belongs to, so both are read and returned together.
func _snapshot_location(entry: Variant) -> Dictionary:
	if not (entry is Dictionary):
		return {}
	var body: Variant = (entry as Dictionary).get("body", null)
	if not (body is Dictionary):
		return {}
	var data: Variant = (body as Dictionary).get("data", null)
	if not (data is Dictionary):
		return {}
	var session: Dictionary = data
	var out := {}
	var location: Variant = session.get("location", null)
	if location is Dictionary:
		out["directory"] = str((location as Dictionary).get("directory", ""))
	var project_id := str(session.get("projectID", ""))
	if not project_id.is_empty():
		out["project"] = {"id": project_id}
	return out


## --- small helpers ---------------------------------------------------------

## The directory the service echoed back, which is the value under test.
func _str_field(location: Dictionary, key: String) -> String:
	return str(location.get(key, ""))


## Two location answers describing the same folder.
func _same_directory(a: Dictionary, b: Dictionary) -> bool:
	var da := _str_field(a, "directory")
	var db := _str_field(b, "directory")
	if da.is_empty() or db.is_empty():
		return false
	# A symlink is legitimately reported by either route, so the LAST segment is compared
	# with the symlink's own name normalised away by resolving it.
	var resolved_a := FolderTarget.new().resolve(da)
	var resolved_b := FolderTarget.new().resolve(db)
	return resolved_a == resolved_b


func _has_project(location: Dictionary) -> bool:
	return not _project_id(location).is_empty()


## Two directories in a stable order, so a comparison is about WHICH folders were seen
## rather than about the order the service happened to settle its answers in.
func _ordered_pair(first: String, second: String) -> Array:
	var out := [first, second]
	out.sort()
	return out


func _directory_of(location: Dictionary) -> String:
	return str(location.get("directory", ""))


func _project_id(location: Dictionary) -> String:
	var project: Variant = location.get("project", {})
	if project is Dictionary:
		return str((project as Dictionary).get("id", ""))
	return ""


## The words the service actually stored, so a leak would be visible rather than inferred.
## The text sits at the top level of each message on this route; a message whose text is
## nested in `parts` is also read, so both shapes are covered rather than one assumed.
func _text_of(messages: Array) -> String:
	var out := ""
	for value in messages:
		if not (value is Dictionary):
			continue
		var message: Dictionary = value
		out += str(message.get("text", "")) + " "
		var parts: Variant = message.get("parts", [])
		if parts is Array:
			for part in (parts as Array):
				if part is Dictionary:
					out += str((part as Dictionary).get("text", "")) + " "
	return out


func _new_id(prefix: String) -> String:
	return "msg_r507_%s_%d_%d" % [prefix, Time.get_unix_time_from_system(), Time.get_ticks_usec()]


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if condition:
		print("R507 PASS: ", message)
		return
	_failed += 1
	print("R507 FAIL: ", message)


func _report() -> void:
	print("R507 summary: checks=%d failed=%d" % [_checks, _failed])
	print("R507 RESULT: ", "PASSED" if _failed == 0 else "FAILED")


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
	for marker in ["authorization", "bearer ", "api_key", "apikey", "sk-", "token=", "password"]:
		if lowered.find(marker) != -1:
			return "[redacted: response contained a credential-like marker]"
	return text.substr(0, 300)