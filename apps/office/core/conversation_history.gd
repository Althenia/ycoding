## Canonical conversation history from the service.
##
## The office used to build its transcript only from live events it happened to observe, so
## a session the user had not watched - or any session at all, after a restart - showed
## nothing. This reads the service's own message list instead, which is the durable truth the
## kit requires the desktop to render.
##
## Two rules shape the projection:
##
##   * PRIVATE REASONING IS NOT A MESSAGE. The kit says so in those words. A `reasoning` part
##     is the model's own thinking, so it is dropped rather than rendered as something anyone
##     said - and it is dropped here, at the projection, so no caller has to remember.
##   * THE SERVICE'S ORDER IS THE ORDER. The list arrives ordered; the wall clock is never
##     consulted, because a replay can deliver a burst whose recorded times are seconds apart
##     in any order and the kit forbids wall-clock ordering where the runtime supplies one.
##
## The wire shape is taken from the live schema (packages/schema/src/session-message.ts): a
## user message carries top-level `text`, a system message likewise, and an assistant carries
## `content`, an array of tagged parts.
##
## A read is keyed to the session it was started for, so a late answer for a session the user
## has LEFT is never installed as the current history. Every row carries its source message
## id, so a durable row can displace a remembered one for the same message.
class_name ConversationHistory
extends RefCounted

## The kinds a projected row can have. A closed set, so a reader can switch on it.
const KIND_PROMPT := "prompt"
const KIND_ANSWER := "answer"
const KIND_OBSERVATION := "observation"
const KIND_TOOL := "tool"

## The kind of a projected row, by message type. A type this build does not know is projected
## as an observation rather than silently dropped or guessed at.
const KIND_BY_TYPE := {
	"user": KIND_PROMPT,
	"assistant": KIND_ANSWER,
	"system": KIND_OBSERVATION,
	"synthetic": KIND_OBSERVATION,
}

## The source every canonical row comes from.
const SOURCE := "session.message"

## The text shown when an assistant message carried no words at all - only thinking, or only
## a tool call. It states what is there rather than rendering an empty answer.
const NO_WORDS := "(no text in this message)"

## A fenced block is a distinct kind of content, so it is its own row.
const KIND_CODE := "code"

## How much tool output one row carries. A result can be enormous, and a row that carries all
## of it is unusable; the cut is MARKED, so a reader is never misled about what they have.
const TOOL_OUTPUT_LIMIT := 2000
const TRUNCATION_MARK := "…"

## What a completion with no report text says. Declared here as the single source of that
## wording, so the store's projection and any reader agree rather than drifting apart.
const NO_REPORT_STATUS := "Completed; open session for the report"

## What an attachment with no name is called. The runtime did not name it, so it is described
## by what IS known rather than given an invented name.
const UNNAMED_ATTACHMENT := "(attachment with no name)"

## The fence that opens and closes a code block.
const FENCE := "```"

var _rows: Dictionary = {}
var _current := ""
var _pending := ""
var _last_error := ""


## The session the user is looking at. A read is only installed for this one.
func current_session() -> String:
	return _current


func is_pending() -> bool:
	return not _pending.is_empty()


func last_error() -> String:
	return _last_error


## Whether this session's history has been read, so an empty history is not mistaken for an
## unread one and awaited forever.
func has_read(session_id: String) -> bool:
	if session_id.is_empty():
		return false
	return _rows.has(session_id)


## Begin reading a session. Leaves any CACHED rows for other sessions alone, because the user
## may return to them, and clears only this session's error.
func start(session_id: String) -> void:
	_current = session_id
	_pending = session_id
	_last_error = ""


## Install a completed read. Only the CURRENT session's answer is installed, so a late answer
## for a session the user has left cannot become the history on screen.
func install(session_id: String, messages: Array) -> void:
	if session_id.is_empty():
		return
	if session_id != _pending and session_id != _current:
		return
	_rows[session_id] = project(messages)
	if _pending == session_id:
		_pending = ""


## Report that a read could not complete. The history stays UNREAD and the reason is kept,
## because presenting a partial list as the whole of it is the same untruth as inventing one.
func fail(session_id: String, reason: String) -> void:
	if session_id != _pending and session_id != _current:
		return
	_rows.erase(session_id)
	if _pending == session_id:
		_pending = ""
	_last_error = reason


## The rows read for a session, or empty when it has not been read.
func rows_for(session_id: String) -> Array[Dictionary]:
	var rows: Variant = _rows.get(session_id, null)
	if rows is Array:
		return (rows as Array).duplicate(true)
	return []


## Project a service message list into rows.
##
## Static and pure, so the projection is asserted directly rather than through a transport.
static func project(messages: Array) -> Array[Dictionary]:
	var rows: Array[Dictionary] = []
	for value in messages:
		if not (value is Dictionary):
			continue
		var message: Dictionary = value
		var message_id := str(message.get("id", ""))
		if message_id.is_empty():
			# A message with no id cannot be source-linked, so it cannot be displaced by a
			# durable row for the same message. It is skipped rather than given a made-up id.
			continue
		var type := str(message.get("type", ""))
		for row in _rows_of(message, type, message_id):
			rows.append(row)
	return rows


## Every row one message produces. An assistant may produce an answer AND tool rows; the
## others produce exactly one row.
static func _rows_of(message: Dictionary, type: String, message_id: String) -> Array[Dictionary]:
	if type == "assistant":
		return _assistant_rows(message, message_id)
	var kind := str(KIND_BY_TYPE.get(type, KIND_OBSERVATION))
	var text := str(message.get("text", "")).strip_edges()
	# A message that names files is unusable without knowing which. The NAMES are listed as
	# text; nothing about a file's content is claimed, because the runtime did not send it.
	var named := _file_names(message)
	if not named.is_empty():
		text = text + ("\n" if not text.is_empty() else "") + named
	# A synthetic or system observation is generated by the runtime, not written by a person,
	# so it is never presented as a verified source message.
	var verified := type == "user"
	return [_row(kind, message_id, text, verified, str(message.get("time", {}).get("created", "")))]


## An assistant message's rows: its VISIBLE words as an answer, and each tool call as tool
## output.
##
## A `reasoning` part is deliberately skipped. It is the model's private thinking, and the kit
## forbids rendering private reasoning as a social message - so it is dropped at the
## projection, where no caller can forget to drop it.
static func _assistant_rows(message: Dictionary, message_id: String) -> Array[Dictionary]:
	var rows: Array[Dictionary] = []
	var created := str(message.get("time", {}).get("created", ""))
	# The prose and the fenced blocks are kept APART, so a block is its own row rather than
	# buried in the surrounding answer.
	var prose: Array[String] = []
	var blocks: Array[Dictionary] = []
	var content: Variant = message.get("content", [])
	if content is Array:
		for value in (content as Array):
			if not (value is Dictionary):
				continue
			var part: Dictionary = value
			match str(part.get("type", "")):
				"text":
					var split := _split_fences(str(part.get("text", "")))
					for text in (split["prose"] as Array):
						prose.append(text)
					blocks.append_array(split["blocks"])
				"reasoning":
					# Private thinking. Never a message, and never merged into one - not into
					# prose, not into a code row, and not into a tool row.
					continue
				"tool":
					rows.append(_tool_row(part, message_id, created))
	if not prose.is_empty():
		rows.push_front(_row(KIND_ANSWER, message_id, "\n".join(prose), true, created))
	# The code rows follow the answer, in the order the blocks appeared.
	for index in blocks.size():
		var block: Dictionary = blocks[index]
		rows.append(_code_row(block, message_id, created, index))
	return rows


## Separate a message's PROSE from any fenced code blocks.
##
## A fence is a delimiter, not content, so the markers are dropped and the language is kept.
## An UNCLOSED fence is treated as prose rather than swallowing the rest of the message into a
## block the runtime never delimited: text the runtime sent must never be lost to a parse.
static func _split_fences(text: String) -> Dictionary:
	var prose: Array[String] = []
	var blocks: Array[Dictionary] = []
	var lines := text.split("\n")
	var current: Array[String] = []
	var language := ""
	var in_block := false
	for line in lines:
		if line.strip_edges().begins_with(FENCE):
			if in_block:
				blocks.append({"language": language, "body": "\n".join(current)})
				current = []
				language = ""
				in_block = false
				continue
			in_block = true
			language = line.strip_edges().substr(FENCE.length()).strip_edges()
			continue
		if in_block:
			current.append(line)
			continue
		prose.append(line)
	# An unclosed fence is prose, not a block: nothing the runtime sent is dropped.
	if in_block:
		prose.append(FENCE + language)
		prose.append_array(current)
	var kept_prose: Array[String] = []
	for value in prose:
		if not value.strip_edges().is_empty():
			kept_prose.append(value)
	return {"prose": kept_prose, "blocks": blocks}


## One fenced block as its own row, carrying the language and the body as text.
static func _code_row(
	block: Dictionary, message_id: String, created: String, index: int
) -> Dictionary:
	var language := str(block.get("language", ""))
	var body := str(block.get("body", ""))
	var text := body if language.is_empty() else language + "\n" + body
	var row := _row(KIND_CODE, message_id, text, true, created)
	# The row id must be unique per block, or a second block in one message would be dropped
	# as a duplicate of the first.
	row["id"] = "%s:%s:code:%d" % [SOURCE, message_id, index]
	if not language.is_empty():
		row["language"] = language
	return row


## One tool call as tool output. The tool is NAMED, because output with no tool named is not
## traceable to anything.
static func _tool_row(part: Dictionary, message_id: String, created: String) -> Dictionary:
	var tool := str(part.get("tool", ""))
	var state: Dictionary = part.get("state", {})
	var status := str(state.get("status", ""))
	# Only the fields the runtime SENT are read. A running call has no output, so no output
	# is claimed for it.
	var output := str(state.get("output", "")).strip_edges()
	var text := tool if not tool.is_empty() else "tool"
	if not status.is_empty():
		text += " · " + status
	if not output.is_empty():
		text += " · " + _bounded(output)
	var row := _row(KIND_TOOL, message_id, text, true, created)
	var call_id := str(part.get("callID", ""))
	if not call_id.is_empty():
		row["call_id"] = call_id
	return row


## Output long enough to make a row unusable is cut, and the cut is MARKED. A silent cut
## would present a partial result as the whole of it.
static func _bounded(text: String) -> String:
	if text.length() <= TOOL_OUTPUT_LIMIT:
		return text
	return text.substr(0, TOOL_OUTPUT_LIMIT) + TRUNCATION_MARK


## The files a message names, as one line of text. An attachment the runtime did not name is
## still reported, described by what IS known rather than given an invented name.
static func _file_names(message: Dictionary) -> String:
	var files: Variant = message.get("files", [])
	if not (files is Array) or (files as Array).is_empty():
		return ""
	var names: Array[String] = []
	for value in (files as Array):
		if value is String:
			var direct := str(value).strip_edges()
			if not direct.is_empty():
				names.append(direct)
			continue
		if not (value is Dictionary):
			continue
		var entry: Dictionary = value
		var name := str(entry.get("name", "")).strip_edges()
		names.append(name if not name.is_empty() else UNNAMED_ATTACHMENT)
	if names.is_empty():
		return ""
	return "attachments: " + ", ".join(names)


## One projected row, with the source fields the kit requires: the message, the kind, the
## time the runtime recorded, and whether the words are a person's or the runtime's own.
static func _row(
	kind: String, message_id: String, text: String, verified: bool, created: String
) -> Dictionary:
	var row := {
		"id": "%s:%s" % [SOURCE, message_id],
		"message_id": message_id,
		"kind": kind,
		"description": text,
		"source": SOURCE,
		"source_verified": verified,
	}
	if not created.is_empty():
		row["created"] = created
	return row
