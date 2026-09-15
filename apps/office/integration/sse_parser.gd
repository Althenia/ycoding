## Incremental Server-Sent Events framing parser.
##
## Byte-oriented and chunk-boundary safe: raw bytes are buffered until a full
## line terminator arrives, so a UTF-8 sequence split across two network reads is
## never decoded in isolation. Only the blank line terminating an event
## dispatches it; an event still unterminated at EOF stays pending. Field syntax
## follows the WHATWG event-stream rules (comments, `data:`, `event:`, `id:`,
## `retry:`, unknown fields ignored, one optional leading space stripped).
class_name SseParser
extends RefCounted

const LINE_LIMIT_BYTES := 1024 * 1024

var _buffer := PackedByteArray()
var _data_lines: Array[String] = []
var _event_name := ""
var _event_id := ""
var _retry := -1
var _pending_cr := false
var _last_error := ""


## Append raw bytes; returns every COMPLETE event decoded in this call.
## Each entry is { "event": String, "data": String, "id": String, "retry": int }
## where "retry" is -1 when the field is absent.
func feed(chunk: PackedByteArray) -> Array[Dictionary]:
	var events: Array[Dictionary] = []
	if chunk.is_empty():
		return events
	var incoming := chunk
	if _pending_cr:
		_pending_cr = false
		# The previous chunk ended on a bare CR; absorb the LF that completes it
		# instead of reading it as a second terminator.
		if incoming[0] == 0x0A:
			incoming = incoming.slice(1)
	_buffer.append_array(incoming)
	while not _buffer.is_empty():
		var index := _terminator_index()
		if index < 0:
			if _buffer.size() > LINE_LIMIT_BYTES:
				_fail_oversize()
			break
		var width := 1
		if _buffer[index] == 0x0D:
			if index + 1 < _buffer.size():
				if _buffer[index + 1] == 0x0A:
					width = 2
			else:
				_pending_cr = true
		var line_bytes := _buffer.slice(0, index)
		_buffer = _buffer.slice(index + width)
		if line_bytes.size() > LINE_LIMIT_BYTES:
			_fail_oversize()
			break
		var event := _consume_line(line_bytes.get_string_from_utf8())
		if not event.is_empty():
			events.append(event)
			_last_error = ""
	return events


## True when a partially received event is buffered.
func has_pending() -> bool:
	return (
		not _buffer.is_empty()
		or not _data_lines.is_empty()
		or not _event_name.is_empty()
		or not _event_id.is_empty()
		or _retry != -1
	)


## Bytes buffered for the event currently being assembled.
func pending_bytes() -> int:
	return _buffer.size()


## Human-readable last error, or "" when none. Oversize input sets this.
func last_error() -> String:
	return _last_error


## Returns the completed event, or an empty dictionary when the line only
## mutated buffered state or was ignored.
func _consume_line(line: String) -> Dictionary:
	if line.is_empty():
		return _build_event()
	if line.begins_with(":"):
		return {}
	var colon := line.find(":")
	if colon < 0:
		return {}
	var field := line.substr(0, colon)
	var value := line.substr(colon + 1)
	if value.begins_with(" "):
		value = value.substr(1)
	match field:
		"data":
			_data_lines.append(value)
		"event":
			_event_name = value
		"id":
			_event_id = value
		"retry":
			if value.is_valid_int():
				_retry = value.to_int()
	return {}


func _build_event() -> Dictionary:
	if _data_lines.is_empty():
		_reset_event()
		return {}
	var event := {
		"event": _event_name,
		"data": "\n".join(_data_lines),
		"id": _event_id,
		"retry": _retry,
	}
	_reset_event()
	return event


## First LF or CR in the buffer, or -1 when no line terminator is complete yet.
func _terminator_index() -> int:
	var lf := _buffer.find(0x0A)
	var cr := _buffer.find(0x0D)
	if lf < 0:
		return cr
	if cr < 0:
		return lf
	return lf if lf < cr else cr


func _reset_event() -> void:
	_data_lines.clear()
	_event_name = ""
	_event_id = ""
	_retry = -1


func _fail_oversize() -> void:
	_last_error = "SSE line exceeded the %d byte limit; buffer dropped" % LINE_LIMIT_BYTES
	_buffer.clear()
	_pending_cr = false
	_reset_event()
