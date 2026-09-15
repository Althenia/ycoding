## Synthetic DEMO transport.
##
## Reads the handoff fixtures, translates them to the real wire shape through
## FixtureTranslator, and emits them on a deterministic clock. It has no network
## capability at all: there is no live mutation path here by construction.
class_name DemoTransport
extends RefCounted

signal event_ready(event: Dictionary)
signal playback_finished

var _events: Array[Dictionary] = []
var _index: int = 0
var _elapsed_ms: int = 0
var _playing: bool = false
var _loop: bool = false

var fixture_id: String = ""


## Load a fixture from an absolute path. Returns an error string, or "".
func load_fixture(path: String) -> String:
	if not FileAccess.file_exists(path):
		return "fixture not found: %s" % path
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return "fixture unreadable: %s" % path
	_events.clear()
	_index = 0
	_elapsed_ms = 0
	while not file.eof_reached():
		var line := file.get_line().strip_edges()
		if line.is_empty():
			continue
		var parsed = JSON.parse_string(line)
		if typeof(parsed) != TYPE_DICTIONARY:
			return "invalid fixture record at line %d" % (_index + 1)
		for translated in FixtureTranslator.translate(parsed):
			_events.append(translated)
	_events.sort_custom(func(a, b): return int(a["_fixture_at_ms"]) < int(b["_fixture_at_ms"]))
	return ""


func play(loop: bool = false) -> void:
	_loop = loop
	_playing = true


func stop() -> void:
	_playing = false


func is_playing() -> bool:
	return _playing


func event_count() -> int:
	return _events.size()


## Advance the deterministic clock and emit every due event.
func advance(delta_ms: int) -> void:
	if not _playing:
		return
	_elapsed_ms += delta_ms
	while _index < _events.size() and int(_events[_index]["_fixture_at_ms"]) <= _elapsed_ms:
		event_ready.emit(_events[_index])
		_index += 1
	if _index < _events.size():
		return
	if _loop:
		_index = 0
		_elapsed_ms = 0
		return
	_playing = false
	playback_finished.emit()


func elapsed_ms() -> int:
	return _elapsed_ms


## Fixture records are synthetic by construction; the UI must never present them
## as live runtime facts.
func is_synthetic() -> bool:
	return true
