## Asset provenance, secrets and dangerous-action contract tests (TASK-046).
##
## These pin the two release claims that no visual test can see:
##
##   1. every asset that ships is accounted for — the manifest and the real
##      directory must agree, and every PNG must be declared by the in-repo
##      generator, so an untracked or externally-sourced asset cannot ship
##      silently;
##   2. nothing in the client bundles a credential, runs a command, or answers a
##      human request on the user's behalf.
##
## The scans read the real tree rather than a fixture: a hand-copied list would
## stop being evidence the moment a file is added.
extends RefCounted

const ART_DIR := "res://office/art"
const MANIFEST := "res://office/art/ASSETS.md"
## Every generator that produces shipped art. Each is hermetic and deterministic;
## the icon is drawn by its own script rather than jammed into the scene-atlas
## generator, so the rule names both instead of assuming one.
const GENERATORS := [
	"res://tools/generate_art.py",
	"res://tools/generate_icon.py",
]

## Text file types a credential could hide in. Rasters carry no readable strings.
const TEXT_SUFFIXES := [".gd", ".py", ".md", ".json", ".jsonl", ".cfg", ".tres", ".tscn", ".sh", ".godot", ".txt"]

## Directories that are engine cache, bytecode cache or version control, not
## shipped client content.
const SKIPPED_DIRS := [".godot", "__pycache__", ".git"]

## Process-spawning engine APIs. None is used anywhere in this client, so the
## reviewed allow-list is empty. A hit means new code can run a command, which
## requires review rather than a silent pass — the failure names the file.
const SPAWN_PATTERN := "OS\\.(execute|create_process|shell_open|execute_with_pipe|create_process_with_pipe)"

## Engine APIs that turn text into behaviour. A rich-text control with a
## clickable-meta callback is the only built-in that can run a URL or a command
## out of displayed text, and the expression/eval helpers turn text into code.
## The transcript renders through plain `Label.text`, which is inert.
##
## This suite necessarily spells those API names out, so it excludes its own file
## from the scan below rather than weakening the pattern.
const EVAL_PATTERN := "RichTextLabel|meta_clicked|Expression\\.|str_to_var|GDScript\\.|load_as_text"

## The scanner's own file, excluded from the eval scan by name so the exclusion
## cannot silently widen to real client code.
const SCANNER_SELF := "res://tests/suites/test_asset_provenance.gd"

## A credential assigned to a non-empty literal, in any common spelling.
##
## `[:=]{1,2}` covers both plain assignment and GDScript's inferred-declaration
## `:=`, which would otherwise hide a bundled key from this scan. An empty
## literal is deliberately not a hit: nothing leaks from `var token := ""`.
const CREDENTIAL_PATTERN := "(?i)(?:password|passphrase|api_?key|secret|token|credential)[ \\t]*[:=]{1,2}[ \\t]*\\\\?\"[^\"]+\""

## Unambiguous secret material: provider token prefixes and PEM private keys.
const SECRET_MATERIAL_PATTERN := "BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|xox[baprs]-"

## Personal or machine-specific traces that must not ship. An absolute home
## directory and a real e-mail address are the two that leak silently.
const PRIVATE_TRACE_PATTERN := "/Users/[a-z]|/home/[a-z]|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"

## The one reviewed credential-shaped literal in the tree: the synthetic password
## the loopback fixture server uses to prove its own Basic-auth handling. It is
## not a real credential, it is never read from a file or the environment, and it
## authorises nothing beyond a test server bound to 127.0.0.1.
const CREDENTIAL_ALLOW_LIST := ["tools/fixture_server.py"]

## Substrings that mark a value as synthetic rather than a real secret.
const SYNTHETIC_MARKERS := ["selftest", "self-test", "example", "demo", "dummy", "test", "fake", "placeholder"]

## The client runtime directories. These ship; tools and tests do not.
const RUNTIME_DIRS := ["app", "ui", "core", "office", "integration"]

## The only OS calls the shipped runtime may make: reading the service
## registration path from the environment. None of these spawns a process.
const RUNTIME_OS_ALLOW_LIST := ["OS.get_environment"]

const REPLIES := ["once", "always", "reject"]


func run(t) -> void:
	test_every_shipped_png_appears_in_the_manifest(t)
	test_every_manifest_row_is_a_shipped_png(t)
	test_manifest_total_matches_the_directory(t)
	test_manifest_dimensions_match_the_files(t)
	test_every_asset_is_declared_by_the_generator(t)
	test_the_generator_is_hermetic_and_seeded(t)
	test_no_credential_is_bundled(t)
	test_no_private_trace_is_bundled(t)
	test_transcript_text_cannot_execute_commands(t)
	test_the_runtime_never_shells_out(t)
	test_demo_never_answers_a_human_request(t)
	test_a_refused_reply_leaves_the_request_pending(t)
	test_only_the_schema_literals_are_offered(t)


## --- asset manifest ---------------------------------------------------------

## An unlisted PNG is an asset of unknown origin and licence. This is the
## regression that stops one shipping unnoticed.
func test_every_shipped_png_appears_in_the_manifest(t) -> void:
	var listed := _manifest_entries()
	t.check(not listed.is_empty(), "the manifest parses into rows")
	if listed.is_empty():
		return
	for name in _shipped_pngs():
		t.check(
			listed.has(name),
			"shipped asset %s is listed in ASSETS.md" % name
		)


## A stale row claims provenance for a file that no longer exists.
func test_every_manifest_row_is_a_shipped_png(t) -> void:
	var shipped := {}
	for name in _shipped_pngs():
		shipped[name] = true
	for name in _manifest_entries():
		t.check(
			shipped.has(name),
			"ASSETS.md row %s names a file that really ships" % name
		)


## The manifest carries its own count, so the two can be compared directly.
func test_manifest_total_matches_the_directory(t) -> void:
	var text := FileAccess.get_file_as_string(MANIFEST)
	t.check(not text.is_empty(), "the manifest is readable")
	var match := RegEx.create_from_string("Total: (\\d+) shipped PNG assets").search(text)
	t.check(match != null, "the manifest states a total")
	if match == null:
		return
	t.check_equal(
		int(match.get_string(1)),
		_shipped_pngs().size(),
		"the manifest's stated total matches the shipped PNG count"
	)


## A wrong size in the manifest makes the provenance record untrue about the
## bytes that ship. The IHDR chunk is the file's own authority.
func test_manifest_dimensions_match_the_files(t) -> void:
	var claimed := _claimed_sizes()
	var checked := 0
	for name in _shipped_pngs():
		t.check(claimed.has(name), "ASSETS.md claims a size for %s" % name)
		if not claimed.has(name):
			continue
		var actual := _png_size(ART_DIR.path_join(name))
		t.check(
			actual.x > 0 and actual.y > 0,
			"%s decodes as a PNG with positive dimensions" % name
		)
		var expected: Vector2i = claimed[name]
		t.check(
			actual == expected,
			"%s is %dx%d on disk and %dx%d in ASSETS.md" % [
				name, actual.x, actual.y, expected.x, expected.y
			]
		)
		checked += 1
	t.check_equal(checked, _shipped_pngs().size(), "every shipped PNG's size was checked")


## --- generator provenance ---------------------------------------------------

## Every shipped PNG must be declared by the in-repo generator, so "generated
## in-repo" stays a checked fact rather than a claim. The declared set is read
## out of the generator's own call sites, not a second hand-kept list.
func test_every_asset_is_declared_by_the_generator(t) -> void:
	var declared := {}
	for generator in GENERATORS:
		var source := FileAccess.get_file_as_string(generator)
		t.check(not source.is_empty(), "the generator %s is readable" % generator)
		if source.is_empty():
			continue
		var functions := _defined_functions(source)
		var outputs := _generator_outputs(source)
		for name in outputs:
			t.check(
				functions.has(outputs[name]),
				"generator function %s for %s is defined" % [outputs[name], name]
			)
			declared[name] = generator
	for name in _shipped_pngs():
		# A shipped PNG must be produced by an in-repo generator. WHICH generator is
		# not the property under test, so a second hermetic script is allowed: what
		# matters is that no asset ships without one.
		t.check(
			declared.has(name),
			"shipped asset %s is produced by an in-repo generator" % name
		)


## Determinism means every source of variation is a fixed integer seed and the
## generator reaches outside itself for nothing — no clock, no entropy, no
## network, no subprocess. An unseeded or time-seeded draw would make the
## committed bytes unreproducible.
func test_the_generator_is_hermetic_and_seeded(t) -> void:
	for generator in GENERATORS:
		var source := FileAccess.get_file_as_string(generator)
		t.check(not source.is_empty(), "the generator %s is readable" % generator)
		if source.is_empty():
			continue
		for forbidden in [
			"urllib", "requests", "socket", "http.client", "urlopen",
			"subprocess", "popen", "os.system", "os.exec",
			"urandom", "uuid", "getpid", "datetime", "time.time", "time.monotonic",
			"random.seed(", "random.random(", "random.randrange(",
		]:
			t.check(
				source.find(forbidden) == -1,
				"%s does not reach outside itself via %s" % [generator, forbidden]
			)
	# A generator that draws randomly must bind every draw to a fixed seed; one
	# that is entirely deterministic needs no RNG at all. The scene generator does
	# draw, so its seated RNG is required; the icon generator does not draw, so it
	# is not.
	var scene := FileAccess.get_file_as_string("res://tools/generate_art.py")
	var seeds := RegEx.create_from_string("random\\.Random\\(([^)]*)\\)").search_all(scene)
	t.check(not seeds.is_empty(), "the scene generator uses an explicitly seeded RNG")


## --- secrets and private traces ---------------------------------------------

## No credential may ship. The single reviewed exception is the synthetic
## loopback password in the fixture server's own selftest; it must stay
## recognisably synthetic.
##
## This file's own scan-pattern constants are excluded from the credential-shaped
## check only, because `CREDENTIAL_PATTERN := "..."` is textually indistinguishable
## from an assigned credential. The exclusion is by exact filename and does not
## cover real secret material, which is still scanned here.
func test_no_credential_is_bundled(t) -> void:
	var regex := RegEx.create_from_string(CREDENTIAL_PATTERN)
	var material := RegEx.create_from_string(SECRET_MATERIAL_PATTERN)
	var scanned := 0
	for path in _text_files():
		var text := FileAccess.get_file_as_string(path)
		if text.is_empty():
			continue
		scanned += 1
		var relative := path.trim_prefix("res://")
		var allowed := _is_allow_listed(relative)
		for line_number in _matching_lines(text, material):
			t.check(
				false,
				"secret material on %s:%d" % [path, line_number]
			)
		if path == SCANNER_SELF:
			continue
		for line_number in _matching_lines(text, regex):
			if not allowed:
				t.check(
					false,
					"a credential-shaped literal ships in %s:%d" % [path, line_number]
				)
				continue
			var line := str(text.split("\n")[line_number - 1]).to_lower()
			t.check(
				SYNTHETIC_MARKERS.any(func(marker): return line.find(marker) != -1),
				"the allow-listed value in %s:%d is marked synthetic" % [path, line_number]
			)
	t.check(scanned > 40, "the credential scan really read the tree (%d files)" % scanned)


## A home directory or a real e-mail address is a private trace that leaks the
## machine and the person who built the client.
func test_no_private_trace_is_bundled(t) -> void:
	var regex := RegEx.create_from_string(PRIVATE_TRACE_PATTERN)
	for path in _text_files():
		var text := FileAccess.get_file_as_string(path)
		if text.is_empty():
			continue
		for line_number in _matching_lines(text, regex):
			t.check(
				false,
				"a private trace ships in %s:%d" % [path, line_number]
			)


## --- dangerous actions ------------------------------------------------------

## Transcript text is data. It must reach the screen through an inert control and
## must never be evaluated as code or markup that can act.
func test_transcript_text_cannot_execute_commands(t) -> void:
	var regex := RegEx.create_from_string(EVAL_PATTERN)
	for path in _source_files():
		if path == SCANNER_SELF:
			continue
		var text := FileAccess.get_file_as_string(path)
		if text.is_empty():
			continue
		for line_number in _matching_lines(text, regex):
			t.check(
				false,
				"text-to-behaviour API used in %s:%d" % [path, line_number]
			)
	# The real flow: a transcript message carrying shell-shaped text must land in
	# inert controls that carry it verbatim, and the panel must contain no
	# markup-rendering control that could act on it.
	var store := OfficeStore.new()
	var hostile := "run `rm -rf /` and $(whoami) now"
	store.record_interaction({
		"id": "i1",
		"kind": "delegation",
		"session_id": "ses_exec",
		"description": hostile,
		"source": "session.task.updated",
	})
	var panel := ConversationPanel.new()
	panel._ready()
	panel.show_actor(store, "ses_exec")
	var labels := 0
	var markup := 0
	var verbatim := false
	var pending: Array[Node] = [panel]
	while not pending.is_empty():
		var node: Node = pending.pop_back()
		if node is RichTextLabel:
			markup += 1
		if node is Label:
			labels += 1
			if (node as Label).text == hostile:
				verbatim = true
		for child in node.get_children():
			pending.append(child)
	t.check(labels > 0, "the transcript renders through plain Labels")
	t.check_equal(markup, 0, "the transcript contains no markup-rendering control")
	t.check(verbatim, "the message text reaches the screen verbatim, as inert data")
	panel.free()


## The shipped runtime may read configuration; it may never run a command. The
## reviewed allow-list is empty, so any hit is a new dangerous action.
func test_the_runtime_never_shells_out(t) -> void:
	var spawn := RegEx.create_from_string(SPAWN_PATTERN)
	for path in _text_files():
		var text := FileAccess.get_file_as_string(path)
		if text.is_empty():
			continue
		for line_number in _matching_lines(text, spawn):
			t.check(
				false,
				"%s:%d spawns a process; review it and add it to the allow-list" % [path, line_number]
			)
	# Inside the shipped runtime, the only OS calls are environment reads.
	var os_call := RegEx.create_from_string("OS\\.\\w+")
	for directory in RUNTIME_DIRS:
		for path in _walk("res://" + directory):
			if not path.ends_with(".gd"):
				continue
			var text := FileAccess.get_file_as_string(path)
			if text.is_empty():
				continue
			for call in os_call.search_all(text):
				t.check(
					RUNTIME_OS_ALLOW_LIST.has(call.get_string(0)),
					"the runtime uses only reviewed OS calls, not %s in %s" % [
						call.get_string(0), path
					]
				)


## A synthetic office asks for nothing, so no layer may answer on the user's
## behalf. DEMO must refuse before it touches any transport, and the request must
## still be pending afterwards.
func test_demo_never_answers_a_human_request(t) -> void:
	var main := OfficeMain.new()
	var store := OfficeStore.new()
	main.store = store
	# A transport exists and is unconfigured, so a DEMO path that reached it would
	# report the transport error instead of the DEMO refusal.
	main.live = LiveTransport.new()
	store.attention.push(AttentionQueue.KIND_PERMISSION, "prq_demo", "ses_demo", {})

	var refusal: String = main.answer_attention("prq_demo", {"reply": "once"})
	t.check_equal(store.mode, OfficeStore.MODE_DEMO, "the office starts in DEMO")
	t.check(
		refusal.find("DEMO") != -1,
		"DEMO refuses to answer and says why, instead of reaching a transport"
	)
	t.check(
		store.attention.has("prq_demo"),
		"the request is still pending after the DEMO refusal"
	)
	main.free()


## A reply that never reached the runtime must not retire the request, or the UI
## would stop offering a decision the user still owes.
func test_a_refused_reply_leaves_the_request_pending(t) -> void:
	var main := OfficeMain.new()
	var store := OfficeStore.new()
	main.store = store
	main.live = LiveTransport.new()
	store.mode = OfficeStore.MODE_LIVE
	store.attention.push(AttentionQueue.KIND_PERMISSION, "prq_live", "ses_live", {})

	var reason: String = main.answer_attention("prq_live", {"reply": "once"})
	t.check(not reason.is_empty(), "an unreachable transport reports a reason")
	t.check(
		store.attention.has("prq_live"),
		"a reply that failed to send leaves the request pending"
	)
	t.check(
		store.attention.blocks("ses_live"),
		"the session is still shown as blocked on the unanswered request"
	)
	t.check_equal(store.attention.count(), 1, "exactly one request is still owed an answer")
	main.free()


## The offered answers are the schema's three literals. An automation value like
## `auto` or `yolo` must be refused here rather than forwarded, so the client
## cannot widen an approval boundary.
func test_only_the_schema_literals_are_offered(t) -> void:
	var request := {"kind": AttentionQueue.KIND_GUARDRAIL, "data": {}}
	var shape := AttentionQueue.reply_shape(request)
	t.check_equal(shape.get("type", ""), "literal", "a guardrail request takes a literal reply")
	t.check_equal(shape.get("allowed", []), REPLIES, "the offered literals are exactly the schema set")
	for literal in REPLIES:
		t.check(
			not AttentionQueue.literal_payload(literal).is_empty(),
			"the schema literal %s is accepted" % literal
		)
	for unsupported in ["auto", "yolo", "always_allow", "yes", ""]:
		t.check(
			AttentionQueue.literal_payload(unsupported).is_empty(),
			"the automation value %s is refused" % unsupported
		)


## --- reading the real tree --------------------------------------------------

## Every PNG that ships in the art directory.
func _shipped_pngs() -> Array[String]:
	var out: Array[String] = []
	for name in DirAccess.get_files_at(ART_DIR):
		if name.ends_with(".png"):
			out.append(name)
	out.sort()
	return out


## Filenames that have a manifest row. Reads the real table, so a row added by
## hand and a file dropped in by hand are both detected.
func _manifest_entries() -> Dictionary:
	var out := {}
	for line in FileAccess.get_file_as_string(MANIFEST).split("\n"):
		var text := line.strip_edges()
		if not text.begins_with("|"):
			continue
		var name := text.get_slice("|", 1).strip_edges()
		if name.ends_with(".png"):
			out[name] = true
	return out


## The size each manifest row claims, keyed by filename.
func _claimed_sizes() -> Dictionary:
	var out := {}
	for line in FileAccess.get_file_as_string(MANIFEST).split("\n"):
		var text := line.strip_edges()
		if not text.begins_with("|"):
			continue
		var name := text.get_slice("|", 1).strip_edges()
		if not name.ends_with(".png"):
			continue
		var size := text.get_slice("|", 2).strip_edges()
		var parts := size.split("x")
		if parts.size() != 2:
			continue
		out[name] = Vector2i(int(parts[0]), int(parts[1]))
	return out


## Width and height read from the PNG's own IHDR chunk: bytes 16..23 of the file.
## The IHDR fields are big-endian (PNG spec), while `PackedByteArray.decode_u32`
## is little-endian, so the bytes are assembled explicitly. This reads the shipped
## bytes directly and is independent of the import cache.
func _png_size(path: String) -> Vector2i:
	var bytes := FileAccess.get_file_as_bytes(path)
	if bytes.size() < 24 or bytes.slice(0, 8) != PackedByteArray([137, 80, 78, 71, 13, 10, 26, 10]):
		return Vector2i.ZERO
	return Vector2i(_be32(bytes, 16), _be32(bytes, 20))


func _be32(bytes: PackedByteArray, offset: int) -> int:
	return (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]


## The filename-to-function map the generator itself declares, read from its
## output calls. This mirrors the generator's own wiring, not its drawing.
func _generator_outputs(source: String) -> Dictionary:
	var out := {}
	for match in RegEx.create_from_string("(\\w+)\\(\\)\\.to_png\\(out / \"([^\"]+)\"\\)").search_all(source):
		out[match.get_string(2)] = match.get_string(1)
	for match in RegEx.create_from_string("props\\[\"([^\"]+)\"\\] = (\\w+)\\(").search_all(source):
		out["prop_%s.png" % match.get_string(1)] = match.get_string(2)
	var decor := _between(source, "def build_wall_decor()", "def build_props()")
	for match in RegEx.create_from_string("\"(\\w+)\": (\\w+)\\(").search_all(decor):
		out["wall_%s.png" % match.get_string(1)] = match.get_string(2)
	var roles := _between(source, "ROLE_PALETTE = {", "SKIN =")
	for match in RegEx.create_from_string("(?m)^    \"(\\w+)\": \\{").search_all(roles):
		out["char_%s.png" % match.get_string(1)] = "build_character_sheet"
	return out


func _defined_functions(source: String) -> Dictionary:
	var out := {}
	for match in RegEx.create_from_string("(?m)^def (\\w+)").search_all(source):
		out[match.get_string(1)] = true
	return out


func _between(source: String, start_marker: String, end_marker: String) -> String:
	var start := source.find(start_marker)
	if start == -1:
		return ""
	var end := source.find(end_marker, start)
	return source.substr(start, source.length() - start) if end == -1 else source.substr(start, end - start)


## Every text file in the client, as res:// paths.
func _text_files() -> Array[String]:
	var out: Array[String] = []
	for path in _walk("res://"):
		for suffix in TEXT_SUFFIXES:
			if path.ends_with(suffix):
				out.append(path)
				break
	return out


## Godot source and scene files, where an engine API is actually invoked.
func _source_files() -> Array[String]:
	var out: Array[String] = []
	for path in _walk("res://"):
		if path.ends_with(".gd") or path.ends_with(".tscn") or path.ends_with(".tres"):
			out.append(path)
	return out


## Recursive listing of res://, skipping engine and bytecode caches.
func _walk(directory: String) -> Array[String]:
	var out: Array[String] = []
	var pending: Array[String] = [directory]
	while not pending.is_empty():
		var current: String = pending.pop_back()
		for sub in DirAccess.get_directories_at(current):
			if not SKIPPED_DIRS.has(sub):
				pending.append(current.path_join(sub))
		for file in DirAccess.get_files_at(current):
			out.append(current.path_join(file))
	return out


## 1-based line numbers where the pattern matches.
func _matching_lines(text: String, regex: RegEx) -> Array[int]:
	var out: Array[int] = []
	var lines := text.split("\n")
	for index in lines.size():
		if regex.search(str(lines[index])) != null:
			out.append(index + 1)
	return out


func _is_allow_listed(relative_path: String) -> bool:
	return CREDENTIAL_ALLOW_LIST.any(func(entry): return relative_path.ends_with(entry))
