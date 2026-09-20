## Bounded presentation read model.
##
## This is NOT durable authority: the service owns all session and history data.
## Live and demo inputs pass through the same reducer using the real wire
## vocabulary from `Wire`. Fixture-only labels are translated upstream by
## DemoTransport.
class_name OfficeStore
extends RefCounted

const MODE_DEMO := "DEMO"
const MODE_LIVE := "LIVE"

## `session.tool.called` declares neither `tool` nor `name`: its fields are the
## shared `ToolBase` (`assistantMessageID`, `callID`) plus `input`, `executed` and
## `state?` (`packages/schema/src/session-event.ts:529-540`). The tool name is
## published on `session.tool.input.started` as `name` (`session-event.ts:499-507`),
## so the store learns it there and applies it to the call that shares its `callID`.
const TOOL_INPUT_STARTED := "session.tool.input.started"

const CONNECTION_SYNCING := "syncing"
const CONNECTION_LIVE := "live"
const CONNECTION_RECONNECTING := "reconnecting"
const CONNECTION_DISCONNECTED := "disconnected"

## Tunable bound from the handoff integration defaults.
const MAX_CONVERSATION_ITEMS := 512

## A guard for walking real session parentage. Deeper than any supported
## delegation tree, and it stops a malformed cycle rather than trusting one.
const FAMILY_DEPTH_LIMIT := 32

## How many agents can play in the play room at once. The lounge holds a
## ping-pong table and a pair of sofas, so this is a real floor limit rather than
## an arbitrary cap.
const PLAY_SPOTS := 4
const MAX_MESSAGE_EXCERPT := 240

var mode: String = MODE_DEMO
var connection_state: String = CONNECTION_SYNCING
var source_epoch: String = ""
## What a completion with no report text says. It states what happened and points at the
## session, rather than rendering an empty line that reads as a success with nothing to
## show for it. The wording itself lives with the transcript's own vocabulary, so one reader
## cannot drift from another.
const COMPLETION_WITHOUT_REPORT := ConversationHistory.NO_REPORT_STATUS

var revision: int = 0
## The order observations were APPLIED in, which is the causal order the projection has.
## A separate counter from `revision`, because the transcript must be ordered by the order
## its own rows arrived rather than by how many events of every kind have been seen.
var _next_interaction_sequence: int = 0

var actors: Dictionary = {}
var interactions: Array[Dictionary] = []
var seen_interaction_ids: Dictionary = {}
## Ordinal for a file change that carries no durable seq. Only used when the wire
## gives none, so a genuine second change to one path stays a second item.
var _file_change_ordinal: int = 0
## Shells the runtime reported for each session, most recent last. Keyed by the
## runtime's own shell id, because `started` and `ended` describe ONE shell and an
## end must update it rather than append a second.
var _shells: Dictionary = {}
## The limit failures the runtime reported, per session. A rate limit, an exhausted quota and
## a context overflow are DIFFERENT things from different sources, and each keeps its own
## kind so a reader is never sent to the wrong fix (apps/office/core/limit_event.gd).
var _limit_events: Dictionary = {}
## The model context window the session's last step reported, per session. Read from the step
## rather than assumed, so an overflow afterwards is explicable.
var _context_limits: Dictionary = {}
var root_session_id: String = ""
var last_error: String = ""
## Tool names learned from `session.tool.input.started`, keyed by `callID`, because
## `session.tool.called` declares no name. Bounded, so a call that never reaches
## its `called` event (interrupt, crash) cannot grow this without limit.
var _tool_names: Dictionary = {}
const TOOL_NAME_LIMIT := 64
## Live assistant text, keyed by `"<assistantMessageID>:<ordinal>"`.
##
## `session.text.delta` frames are EPHEMERAL and `session.text.ended` carries the
## authoritative full value, so deltas accumulate only for live display and an `ended`
## REPLACES what they built rather than appending to it. Ordinal is part of the key
## because one assistant message can emit more than one text block. Reasoning is kept
## in a SEPARATE map: the product forbids presenting hidden model reasoning as
## conversation content, so the two must never merge.
var _stream_text: Dictionary = {}
var _stream_reasoning: Dictionary = {}
## Bounded so a stream that never terminates cannot grow the maps without limit.
const STREAM_BLOCK_LIMIT := 64
## Set when the projection is known to be incomplete, e.g. after a reconnect that
## could not be resumed. Cleared only by a completed reload.
var stale: bool = false

## Requests a session is blocked on. Separate from `interactions`, which records
## history: a request is live state that must be answerable and then retired.
var attention: AttentionQueue = AttentionQueue.new()


func actor_for(session_id: String) -> ActorPresentation:
	return actors.get(session_id)


func actor_list() -> Array[ActorPresentation]:
	var list: Array[ActorPresentation] = []
	for actor in actors.values():
		list.append(actor)
	list.sort_custom(func(a: ActorPresentation, b: ActorPresentation): return a.identity.session_id < b.identity.session_id)
	return list


func select_actor(session_id: String) -> void:
	for actor in actors.values():
		actor.selected = actor.identity.session_id == session_id


func selected_actor() -> ActorPresentation:
	for actor in actors.values():
		if actor.selected:
			return actor
	return null


## Current-state labels for the status panel. Reads from canonical fields only.
## Refresh the derived presence on every actor. Called after any mutation so the
## world never has to ask the store per-frame.
func sync_presence() -> void:
	for actor in actor_list():
		actor.presence = station_of(actor.identity.session_id)


func status_rows() -> Array[Dictionary]:
	var rows: Array[Dictionary] = []
	for actor in actor_list():
		rows.append(
			{
				"name": actor.identity.display_name,
				"presence": actor.presence,
				"presence_label": Presence.label(actor.presence),
				"session_id": actor.identity.session_id,
				"state": actor.status_label,
				"glyph": WorkState.glyph(actor.work_state),
				"attention": actor.attention_required,
				"settled": actor.settled_status,
				"activity": actor.activity_label,
			}
		)
	return rows


## Where an actor is in the office. Derived from canonical state rather than
## stored, so presence cannot drift from work state or departure.
func presence_of(session_id: String) -> String:
	var actor := actor_for(session_id)
	if actor == null:
		return ""
	if actor.departed:
		return Presence.LEFT
	if Presence.is_working(actor.work_state):
		return Presence.AT_WORK
	return Presence.PLAYING if has_play_spot(session_id) else Presence.WAITING


## The station an actor belongs at, by presence AND work state.
##
## Presence answers "on shift or not"; the work state answers "doing what". The
## world only moves an actor when this changes, so it needs both.
func station_of(session_id: String) -> String:
	var actor := actor_for(session_id)
	if actor == null:
		return ""
	if actor.departed:
		return "left"
	match presence_of(session_id):
		Presence.AT_WORK:
			# Consolidating context is retreading what it has seen, which is what
			# the focus station is for. Everything else works at its desk.
			return "focus" if actor.work_state == WorkState.Kind.COMPACTING else "desk"
		Presence.PLAYING:
			return "play"
		Presence.WAITING:
			return "waiting"
	return ""


## The actor a report should be delivered to: its parent session, or the root.
##
## `session.task.updated` already carries the change; parentage is what decides
## where the report physically goes.
func report_target_for(session_id: String) -> String:
	var actor := actor_for(session_id)
	if actor == null:
		return ""
	var parent := actor.identity.parent_session_id
	if not parent.is_empty() and actor_for(parent) != null:
		return parent
	return root_session_id


## Seat holders, in a stable order. Only actors on shift occupy the floor.
func seated_actors() -> Array[ActorPresentation]:
	var out: Array[ActorPresentation] = []
	for actor in actor_list():
		if presence_of(actor.identity.session_id) == Presence.AT_WORK:
			out.append(actor)
	return out


## Actors playing in the play room.
func playing_actors() -> Array[ActorPresentation]:
	var out: Array[ActorPresentation] = []
	for actor in actor_list():
		if presence_of(actor.identity.session_id) == Presence.PLAYING:
			out.append(actor)
	return out


## Actors who have ended and left the office.
func departed_actors() -> Array[ActorPresentation]:
	var out: Array[ActorPresentation] = []
	for actor in actor_list():
		if actor.departed:
			out.append(actor)
	return out


## Whether this actor holds one of the bounded play spots.
##
## Deterministic: the earliest actors by id take the spots, so the same roster
## always produces the same arrangement and a viewer sees no unexplained churn.
func has_play_spot(session_id: String) -> bool:
	var idle: Array[ActorPresentation] = []
	for actor in actor_list():
		if actor.departed or Presence.is_working(actor.work_state):
			continue
		idle.append(actor)
	if idle.size() > PLAY_SPOTS:
		idle = idle.slice(0, PLAY_SPOTS)
	for actor in idle:
		if actor.identity.session_id == session_id:
			return true
	return false


## Conversation items for the history drawer, oldest first.
## A session's observations in SOURCE ORDER.
##
## The filter preserves the order the rows were applied in, which is the causal order the
## runtime produced them. Sorting by a wall-clock field instead would reorder concurrent
## events the runtime ordered deliberately, which the kit forbids.
func conversation_items(session_id: String) -> Array[Dictionary]:
	return interactions.filter(func(item): return item.get("session_id", "") == session_id)


## The shells the runtime reported for a session, in the order it opened them.
##
## Read-only detail about commands that have ALREADY run, so a caller can show what a
## session did without inviting input. There is deliberately no shell SUBMIT path here:
## a command is run through the runtime's own tool invocation, never typed into a view.
func shells_for(session_id: String) -> Array[Dictionary]:
	var rows: Array[Dictionary] = []
	for shell in _shells.get(session_id, []):
		rows.append(shell)
	return rows


## Fold a shell event into the session's shell list.
##
## `ended` carries the same shell id as `started`, so it UPDATES that shell: appending a
## second row would present one command as two. A status the runtime did not report is
## never invented, and the output is carried in the runtime's own paging shape
## (`output`, `cursor`, `size`, `truncated`) so a reader can tell a page from the whole.
func apply_shell(session_id: String, data: Dictionary, type: String) -> bool:
	if actor_for(session_id) == null:
		return false
	var shell: Dictionary = data.get("shell", {})
	var shell_id := str(shell.get("id", ""))
	if shell_id.is_empty():
		return false
	var rows: Array = _shells.get(session_id, [])
	var row := {
		"session_id": session_id,
		"shell_id": shell_id,
		"command": ShellView.bound_patch(str(shell.get("command", ""))),
		"cwd": str(shell.get("cwd", "")),
		"status": str(shell.get("status", "")),
		"read_only": true,
	}
	var output: Variant = data.get("output", {})
	if output is Dictionary and not output.is_empty():
		row["output"] = {
			"output": ShellView.bound_patch(str(output.get("output", ""))),
			"cursor": int(output.get("cursor", 0)),
			"size": int(output.get("size", 0)),
			"truncated": bool(output.get("truncated", false)),
		}
	# One shell is one row, whichever event describes it.
	for i in rows.size():
		if str(rows[i].get("shell_id", "")) == shell_id:
			rows[i] = row
			_shells[session_id] = rows
			return true
	rows.append(row)
	_shells[session_id] = rows
	return true


## The real session family for a session: the root of its delegation tree and
## every session under that root, root first.
##
## Read-only and derived from durable parentage carried by `session.created`, so
## the drawer can present one thread without inventing a relationship. An unknown
## session is its own family, so selection never silently widens to the roster.
## Just the sessions whose PARENT is this one, sorted.
##
## Distinct from `family_session_ids`, which names the whole delegation tree including
## ancestors. An inspector stating where an assignment sits must not call its parent a child.
func child_session_ids(session_id: String) -> Array[String]:
	if session_id.is_empty():
		return []
	var out: Array[String] = []
	for actor in actor_list():
		if actor.identity.parent_session_id == session_id:
			out.append(actor.identity.session_id)
	out.sort()
	return out


func family_session_ids(session_id: String) -> Array[String]:
	if session_id.is_empty():
		return []
	var root := session_id
	for _step in FAMILY_DEPTH_LIMIT:
		var actor := actor_for(root)
		if actor == null:
			break
		var parent := actor.identity.parent_session_id
		if parent.is_empty() or actor_for(parent) == null:
			break
		root = parent
	if actor_for(root) == null:
		return [session_id]
	var out: Array[String] = [root]
	var descendants: Array[String] = []
	for actor in actor_list():
		var id := actor.identity.session_id
		if id != root and _descends_from(id, root):
			descendants.append(id)
	descendants.sort()
	out.append_array(descendants)
	return out


## Whether a session sits under a given ancestor. Bounded, so a malformed
## parentage cycle cannot hang the drawer.
func _descends_from(session_id: String, ancestor: String) -> bool:
	var current := session_id
	for _step in FAMILY_DEPTH_LIMIT:
		var actor := actor_for(current)
		if actor == null:
			return false
		current = actor.identity.parent_session_id
		if current.is_empty():
			return false
		if current == ancestor:
			return true
	return false


## ---- Reducer -----------------------------------------------------------------
## `event` uses the real shape: { type, sessionID, data, sourceEpoch }.
func apply(event: Dictionary) -> bool:
	var type := str(event.get("type", ""))
	if type.is_empty():
		return false
	if event.has("sourceEpoch"):
		var epoch := str(event["sourceEpoch"])
		if not epoch.is_empty() and epoch != source_epoch:
			# An epoch change invalidates every cursor and cosmetic sequence.
			if not source_epoch.is_empty():
				invalidate_epoch(epoch)
			source_epoch = epoch
	var data: Dictionary = event.get("data", {})
	var session_id := str(event.get("sessionID", data.get("sessionID", "")))
	revision += 1
	match type:
		Wire.CONNECTED:
			connection_state = CONNECTION_LIVE
		Wire.SESSION_CREATED:
			return apply_session_created(session_id, data)
		Wire.SESSION_STATUS:
			return apply_status(session_id, data)
		Wire.STEP_ENDED:
			read_context_limit(session_id, data)
			return apply_activity(session_id, WorkState.Kind.PROCESSING, type)
		Wire.EXECUTION_STARTED, Wire.STEP_STARTED, Wire.TEXT_STARTED, Wire.REASONING_STARTED:
			return apply_activity(session_id, WorkState.Kind.PROCESSING, type)
		Wire.TEXT_DELTA, Wire.REASONING_DELTA:
			return apply_stream_delta(session_id, data, type)
		Wire.TEXT_ENDED, Wire.REASONING_ENDED:
			return apply_stream_ended(session_id, data, type)
		TOOL_INPUT_STARTED:
			return learn_tool_name(session_id, data)
		Wire.TOOL_CALLED:
			return apply_tool(session_id, data, true)
		Wire.TOOL_SUCCESS:
			return apply_tool(session_id, data, false)
		Wire.TOOL_FAILED:
			return apply_activity(session_id, WorkState.Kind.BLOCKED, type)
		Wire.EXECUTION_SUCCEEDED:
			return apply_settled(session_id, "succeeded")
		Wire.EXECUTION_FAILED:
			return apply_execution_failure(session_id, data)
		Wire.EXECUTION_INTERRUPTED:
			return apply_settled(session_id, "cancelled")
		Wire.TASK_UPDATED:
			return apply_task_change(session_id, data)
		Wire.INPUT_ADMITTED, Wire.INPUT_PROMOTED:
			return apply_activity(session_id, WorkState.Kind.PROCESSING, type)
		Wire.STEP_FAILED:
			return apply_step_failure(session_id, data)
		Wire.FILE_CHANGE:
			return apply_file_change(session_id, data, event)
		Wire.SHELL_STARTED, Wire.SHELL_ENDED:
			return apply_shell(session_id, data, type)
		Wire.COMPACTION_STARTED, Wire.COMPACTION_ADMITTED:
			return apply_activity(session_id, WorkState.Kind.COMPACTING, type)
		Wire.COMPACTION_ENDED, Wire.COMPACTION_FAILED:
			return apply_activity(session_id, WorkState.Kind.PROCESSING, type)
		Wire.PERMISSION_ASKED:
			return apply_attention(
				AttentionQueue.KIND_PERMISSION, session_id, data, "Approve this action?"
			)
		Wire.GUARDRAIL_ASKED:
			return apply_attention(
				AttentionQueue.KIND_GUARDRAIL, session_id, data, "Review this action?"
			)
		Wire.SESSION_DELETED, Wire.SESSION_ARCHIVED:
			return apply_departure(session_id, true)
		Wire.SESSION_UNARCHIVED:
			return apply_departure(session_id, false)
	return false


## Record a permission or guardrail request the runtime is blocked on.
##
## These are EPHEMERAL events, so they are not durable history; the queue is what
## makes them answerable. `summary` is only a fallback caption: the real detail is
## the action and its resources, which is what the user actually has to judge.
func apply_attention(kind: String, session_id: String, data: Dictionary, fallback: String) -> bool:
	var request_id := str(data.get("id", ""))
	if request_id.is_empty():
		return false
	var actor := actor_for(session_id)
	if actor != null:
		actor.attention_required = true
	var detail: Dictionary = data.duplicate()
	detail["summary"] = permission_summary(data, fallback, kind == AttentionQueue.KIND_GUARDRAIL)
	attention.push(kind, request_id, session_id, detail)
	record_interaction(
		{
			"id": "%s:%s" % [kind, request_id],
			"kind": kind,
			"session_id": session_id,
			"description": str(detail["summary"]),
			"source": Wire.PERMISSION_ASKED if kind == AttentionQueue.KIND_PERMISSION else Wire.GUARDRAIL_ASKED,
			"source_verified": true,
		}
	)
	return true


## What a request is asking for, in the terms the schema supplies.
##
## A permission names an action and its resources: `PermissionV2.Request` declares
## `id`, `sessionID`, `action`, `resources`, `save?`, `metadata?`, `source?`
## (`packages/schema/src/permission.ts:24-35`) and no `reason`. Only
## `Guardrail.Request` declares `reason` (`packages/schema/src/guardrail.ts:57`),
## which is the most useful sentence available there. Nothing is invented: when
## the wire carries no detail the caller's neutral fallback stands, and a reason is
## never rendered for a family whose schema cannot carry one.
func permission_summary(data: Dictionary, fallback: String, has_reason: bool = false) -> String:
	var action := str(data.get("action", "")).strip_edges()
	var resources: Array = data.get("resources", [])
	var parts: Array[String] = []
	if not action.is_empty():
		parts.append(action)
	if not resources.is_empty():
		parts.append(", ".join(resources.map(func(item: Variant) -> String: return str(item))))
	if has_reason:
		var reason := str(data.get("reason", "")).strip_edges()
		if not reason.is_empty():
			parts.append(reason)
	var joined := " — ".join(parts)
	return joined if not joined.is_empty() else fallback


func apply_session_created(session_id: String, data: Dictionary) -> bool:
	if session_id.is_empty():
		return false
	var parent := str(data.get("parentID", ""))
	var agent := str(data.get("agent", "agent"))
	var identity := ActorIdentity.new(session_id, agent, parent, agent.capitalize())
	if actors.has(session_id):
		actors[session_id].identity = identity
		_apply_placement(actors[session_id] as ActorPresentation, data)
		return true
	var actor := ActorPresentation.new(identity)
	_apply_placement(actor, data)
	actors[session_id] = actor
	if parent.is_empty():
		root_session_id = session_id
	assign_ordinals()
	return true


## Adopt the durable placement carried by `session.created`.
##
## The real event carries `location: {directory}` and `model: Model.Ref`
## (`{id, providerID, variant?}`, `packages/schema/src/model.ts:14-18`). A
## session's location is its own and does not follow a later directory change, so
## it is stored per actor. Values are only taken when the event actually carries
## them; nothing is invented, and a partial event leaves the previous value intact
## rather than blanking it.
func _apply_placement(actor: ActorPresentation, data: Dictionary) -> void:
	var location: Variant = data.get("location")
	if location is Dictionary:
		var directory := str((location as Dictionary).get("directory", ""))
		if not directory.is_empty():
			actor.location_directory = directory
	var model: Variant = data.get("model")
	if model is Dictionary:
		# The wire carries fields; the client's composed reference is built from
		# them, and only a complete pair of `providerID`/`id` composes one.
		var ref: Dictionary = model
		var provider_id := str(ref.get("providerID", ""))
		var id := str(ref.get("id", ""))
		if not provider_id.is_empty() and not id.is_empty():
			var variant := str(ref.get("variant", ""))
			actor.model_ref = ModelCatalog.format_ref(
				{"providerID": provider_id, "id": id, "variant": variant}
			)
	# Demo data is synthetic; it must never be presented as a real location.
	if bool(data.get("synthetic", false)):
		actor.synthetic = true


## The locations currently represented, sorted. More than one means the roster is
## not location-scoped and the UI must not claim a single directory.
func locations() -> Array[String]:
	var seen := {}
	for actor in actor_list():
		if not actor.location_directory.is_empty():
			seen[actor.location_directory] = true
	var out: Array[String] = []
	for directory in seen:
		out.append(str(directory))
	out.sort()
	return out


## True when every placed session agrees on one directory.
func has_single_location() -> bool:
	return locations().size() == 1


## A session has ended and its actor leaves the office, or has been restored and
## returns. Leaving does not erase the session: history stays, the seat frees.
func apply_departure(session_id: String, departed: bool) -> bool:
	var actor := actor_for(session_id)
	if actor == null:
		return false
	actor.departed = departed
	if departed:
		actor.attention_required = false
		actor.set_work(WorkState.Kind.IDLE)
	return true


## Two sessions using the same agent definition get distinct display names.
func assign_ordinals() -> void:
	var by_agent: Dictionary = {}
	for actor in actor_list():
		var ids: Array = by_agent.get(actor.identity.agent_id, [])
		ids.append(actor.identity.session_id)
		by_agent[actor.identity.agent_id] = ids
	for agent_id in by_agent:
		var ids: Array = by_agent[agent_id]
		ids.sort()
		for index in ids.size():
			actors[ids[index]].identity.apply_ordinal(index, ids.size())


func apply_status(session_id: String, data: Dictionary) -> bool:
	var actor := actor_for(session_id)
	if actor == null:
		return false
	var status: Dictionary = data.get("status", {})
	var kind := str(status.get("type", ""))
	if kind == Wire.STATUS_BUSY:
		actor.set_work(WorkState.Kind.PROCESSING)
	elif kind == Wire.STATUS_RETRY:
		actor.set_work(WorkState.Kind.WAITING)
	elif kind == Wire.STATUS_IDLE:
		actor.set_work(WorkState.Kind.IDLE)
	return true


func apply_activity(session_id: String, state: int, event_type: String) -> bool:
	var actor := actor_for(session_id)
	if actor == null:
		return false
	# A settled actor stays settled until new real work arrives.
	actor.settled_status = ""
	actor.set_work(state)
	actor.activity_label = event_type
	return true


## Accumulate one live stream fragment.
##
## Deltas are ephemeral: they exist so a user sees text arrive. The authoritative value
## arrives later on the matching `ended`, which replaces what these built.
func apply_stream_delta(session_id: String, data: Dictionary, type: String) -> bool:
	var actor := actor_for(session_id)
	if actor == null:
		return false
	var delta := str(data.get("delta", ""))
	if delta.is_empty():
		return false
	var block := _stream_key(session_id, data)
	var reasoning := type == Wire.REASONING_DELTA
	var map := _stream_reasoning if reasoning else _stream_text
	_bounded_stream_insert(map, block)
	map[block] = str(map.get(block, "")) + delta
	actor.settled_status = ""
	actor.set_work(WorkState.Kind.PROCESSING)
	return true


## The terminal value of a stream block.
##
## `Ended` is the replayable full-value boundary, so it REPLACES the accumulated deltas
## rather than appending to them: appending would double the text whenever the deltas
## had already arrived. A block whose `ended` was never seen keeps its partial value,
## which is honest - it is incomplete, not wrong.
func apply_stream_ended(session_id: String, data: Dictionary, type: String) -> bool:
	var actor := actor_for(session_id)
	if actor == null:
		return false
	var text := str(data.get("text", ""))
	var block := _stream_key(session_id, data)
	var reasoning := type == Wire.REASONING_ENDED
	var map := _stream_reasoning if reasoning else _stream_text
	_bounded_stream_insert(map, block)
	map[block] = text
	return true


## The identity of one stream block: the session, the assistant message and the
## ordinal. The session is part of it because two sessions can carry the same message
## id, and a shared key would show one session's text against another.
func _stream_key(session_id: String, data: Dictionary) -> String:
	return "%s:%s:%s" % [
		session_id,
		str(data.get("assistantMessageID", "")),
		str(data.get("ordinal", "")),
	]


## The live text of one block, or "" when nothing arrived. Read by the UI.
func stream_text(session_id: String, assistant_message_id: String, ordinal: int) -> String:
	return str(_stream_text.get("%s:%s:%d" % [session_id, assistant_message_id, ordinal], ""))


## Every live text block for one session, in ordinal order, as
## `{ "assistantMessageID", "ordinal", "text" }`. The drawer renders these so the
## answer appears as it arrives instead of only when it is replayed.
func stream_blocks(session_id: String) -> Array[Dictionary]:
	var prefix := session_id + ":"
	var blocks: Array[Dictionary] = []
	for key in _stream_text:
		if not str(key).begins_with(prefix):
			continue
		var text := str(_stream_text[key])
		if text.is_empty():
			continue
		var parts := str(key).split(":")
		if parts.size() < 3:
			continue
		blocks.append({
			"assistantMessageID": parts[1],
			"ordinal": int(parts[2]),
			"text": text,
		})
	blocks.sort_custom(func(a, b) -> bool:
		return int(a["ordinal"]) < int(b["ordinal"])
	)
	return blocks


## Evict the oldest block when the map is full, so a stream that never terminates is
## bounded like every other projection here.
func _bounded_stream_insert(map: Dictionary, block: String) -> void:
	if map.has(block) or map.size() < STREAM_BLOCK_LIMIT:
		return
	map.erase(map.keys()[0])


## `session.tool.input.started` is the only tool event that carries the tool name
## (`name`), and `session.tool.called` is the only one that says the call was
## entered. They share `callID`, so the name is held per call until the call is
## entered. Nothing is guessed: a call whose name was never announced stays
## generic rather than inheriting another call's name.
func learn_tool_name(session_id: String, data: Dictionary) -> bool:
	if actor_for(session_id) == null:
		return false
	var call_id := str(data.get("callID", ""))
	var name := str(data.get("name", ""))
	if call_id.is_empty() or name.is_empty():
		return false
	if _tool_names.size() >= TOOL_NAME_LIMIT:
		_tool_names.erase(_tool_names.keys()[0])
	_tool_names[call_id] = name
	return true


func apply_tool(session_id: String, data: Dictionary, called: bool) -> bool:
	var actor := actor_for(session_id)
	if actor == null:
		return false
	if not called:
		actor.set_work(WorkState.Kind.PROCESSING)
		return true
	var call_id := str(data.get("callID", ""))
	var name := str(_tool_names.get(call_id, ""))
	var state := WorkState.from_tool(name)
	actor.set_work(state)
	# Only a classified tool becomes an attributed activity label.
	actor.activity_label = name if not name.is_empty() else "tool"
	return true


## The limit failures a session reported, in the order the runtime reported them.
func limit_events(session_id: String) -> Array[Dictionary]:
	var rows: Array[Dictionary] = []
	for item in _limit_events.get(session_id, []):
		rows.append(item)
	return rows


## The model context window the session's last step reported, or 0 when none was reported.
##
## Zero means NOT REPORTED rather than "no window": the window is the provider's fact, and a
## session that has not reported one has not said.
func context_limit_for(session_id: String) -> int:
	return int(_context_limits.get(session_id, 0))


## Record the context window a step reported. A step that reports none leaves the known figure
## alone rather than zeroing it, because the window does not change between steps.
func read_context_limit(session_id: String, data: Dictionary) -> bool:
	var reported: Variant = data.get("contextLimit", null)
	if reported == null:
		return false
	_context_limits[session_id] = int(reported)
	return true


## Record a failed step. The runtime classifies the failure, and the classification is kept
## rather than flattened into one generic error.
##
## A failed step is a real terminal outcome, so it also settles the actor: leaving it working
## would present a stopped session as busy.
func apply_step_failure(session_id: String, data: Dictionary) -> bool:
	if not _record_limit(session_id, data):
		return false
	apply_settled(session_id, "failed")
	return true


## Record a failed execution. It carries an error the same way a step does, and it was
## previously discarded with the status alone.
func apply_execution_failure(session_id: String, data: Dictionary) -> bool:
	_record_limit(session_id, data)
	return apply_settled(session_id, "failed")


## Classify and store one reported failure.
##
## An error this build does not recognise is still recorded, as `unclassified`: dropping it
## would hide a real failure because its spelling was unfamiliar.
func _record_limit(session_id: String, data: Dictionary) -> bool:
	var actor := actor_for(session_id)
	if actor == null:
		return false
	var error: Variant = data.get("error", {})
	if not (error is Dictionary):
		error = {}
	var message := str((error as Dictionary).get("message", ""))
	var kind := LimitEvent.classify(error)
	# The step reports the model's window as a TOP-LEVEL field of its own data, beside the
	# error rather than inside it (packages/schema/src/session-event.ts). A failure that
	# reports one updates the known window, so the overflow is explicable from the same event.
	read_context_limit(session_id, data)
	var context_limit := context_limit_for(session_id)
	var row := {
		"session_id": session_id,
		"kind": kind,
		"message": message,
		"detail": LimitEvent.detail(error, kind, context_limit),
		"context_limit": context_limit,
		"source_verified": true,
	}
	var rows: Array = _limit_events.get(session_id, [])
	rows.append(row)
	_limit_events[session_id] = rows
	return true


func apply_settled(session_id: String, status: String) -> bool:
	var actor := actor_for(session_id)
	if actor == null:
		return false
	actor.set_work(WorkState.Kind.IDLE)
	# Inactive is not success; the terminal status is recorded verbatim.
	actor.settled_status = status
	actor.attention_required = false
	return true


## `session.task.updated` carries `SessionOrchestration.Change`, a tagged union
## of {type: ...} plus kind-specific fields. Only real facts map to speech.
func apply_task_change(session_id: String, data: Dictionary) -> bool:
	var change: Dictionary = data.get("change", {})
	var change_type := str(change.get("type", ""))
	var actor := actor_for(session_id)
	match change_type:
		Wire.CHANGE_LAUNCHED:
			if actor != null:
				actor.task_description = str(change.get("description", ""))
				actor.set_work(WorkState.Kind.PROCESSING)
			var child_id := str(change.get("inputID", ""))
			var parent_id := str(change.get("parentID", session_id))
			record_interaction(
				{
					"id": "delegation:%s" % str(change.get("toolCallID", child_id)),
					"kind": "delegation",
					"session_id": parent_id,
					"target_session_id": child_id,
					"description": str(change.get("description", "")),
					"source": "session.task.updated",
					"source_verified": true,
				}
			)
		Wire.CHANGE_QUESTION_ASKED:
			if actor != null:
				actor.attention_required = true
			var asked: Dictionary = change.get("question", {})
			attention.push(
				AttentionQueue.KIND_QUESTION,
				str(asked.get("id", "")),
				session_id,
				asked
			)
			var question: Dictionary = change.get("question", {})
			record_interaction(
				{
					"id": "question:%s" % str(question.get("id", "")),
					"kind": "question",
					"session_id": session_id,
					"description": str(question.get("text", "")),
					"source": "session.task.updated",
					"source_verified": true,
				}
			)
		Wire.CHANGE_QUESTION_ANSWERED:
			if actor != null:
				actor.attention_required = false
			# The runtime answered it, so it is no longer answerable here.
			attention.resolve(str((change.get("answer", {}) as Dictionary).get("questionID", "")))
			var answer: Dictionary = change.get("answer", {})
			record_interaction(
				{
					"id": "answer:%s" % str(answer.get("questionID", "")),
					"kind": "answer",
					"session_id": session_id,
					"description": str(answer.get("text", "")),
					"source": "session.task.updated",
					"source_verified": true,
				}
			)
		Wire.CHANGE_COMPLETED:
			if actor != null:
				actor.set_work(WorkState.Kind.IDLE)
				actor.settled_status = "succeeded"
			# A session runs MANY assignments, so keying the report on the session made every
			# completion after the first a duplicate and dropped it - the kit's "no duplicate
			# report projections" cut both ways. The report is keyed on the terminal event
			# itself, which is what makes two assignments two reports and a repeat of one
			# assignment still one.
			var excerpt := str(change.get("excerpt", ""))
			var report := {
				"id": "report:%s" % _terminal_key(session_id, change),
				"kind": "report",
				"session_id": session_id,
				"source": Wire.TASK_UPDATED,
			}
			if excerpt.strip_edges().is_empty():
				# A completion with no report text is a STATUS, not a message. The kit
				# requires "Completed; open session" rather than an invented success
				# statement, so the row says what actually happened and is marked as a
				# status the runtime generated rather than a source message.
				report["description"] = COMPLETION_WITHOUT_REPORT
				report["source_verified"] = false
			else:
				report["description"] = excerpt
				report["source_verified"] = true
			record_interaction(report)
		Wire.CHANGE_CANCELLED:
			if actor != null:
				actor.set_work(WorkState.Kind.IDLE)
				actor.settled_status = "cancelled"
		Wire.CHANGE_LOST:
			if actor != null:
				actor.set_work(WorkState.Kind.IDLE)
				actor.settled_status = "lost"
		Wire.CHANGE_FAILED:
			if actor != null:
				actor.set_work(WorkState.Kind.BLOCKED)
				actor.settled_status = "failed"
		Wire.CHANGE_PROGRESSED:
			if actor != null:
				var progress: Dictionary = change.get("progress", {})
				actor.activity_label = str(progress.get("text", ""))
		_:
			return false
	return true


## `session.file-change.recorded` carries `change = {path, patch, additions,
## deletions}` (Schema `Session.Event.FileChange.Info`). The runtime publishes it
## from `edit`/`patch` tool results, so the path and counts are real facts.
##
## The wire sends no change-kind field on this event, so none is recorded or
## rendered. The durable seq keys the item when the event carries one, so a
## genuine second change to the same path stays a second item.
func apply_file_change(session_id: String, data: Dictionary, event: Dictionary) -> bool:
	var actor := actor_for(session_id)
	if actor == null:
		return false
	actor.settled_status = ""
	actor.set_work(WorkState.Kind.TYPING)
	actor.activity_label = Wire.FILE_CHANGE
	var change: Dictionary = data.get("change", {})
	var path := str(change.get("path", ""))
	if path.is_empty():
		return false
	var durable: Dictionary = event.get("durable", {})
	var seq := str(durable.get("seq", ""))
	if seq.is_empty():
		_file_change_ordinal += 1
		seq = str(_file_change_ordinal)
	record_interaction(
		{
			"id": "file_change:%s:%s:%s" % [session_id, path, seq],
			"kind": "file_change",
			"session_id": session_id,
			"path": path,
			"additions": int(change.get("additions", 0)),
			"deletions": int(change.get("deletions", 0)),
			"patch": _bounded(str(change.get("patch", ""))),
			"description": "%s  +%d  -%d" % [path, int(change.get("additions", 0)), int(change.get("deletions", 0))],
			"source": Wire.FILE_CHANGE,
			"source_verified": true,
		}
	)
	return true


## What identifies ONE terminal event.
##
## The wire's terminal change carries no id of its own, so the identity is composed from
## what it does carry: the session, its kind, and the excerpt the runtime sent. Two
## DIFFERENT completions of one session carry different excerpts and are therefore two
## reports; the same completion delivered twice composes the same key and is one.
func _terminal_key(session_id: String, change: Dictionary) -> String:
	var excerpt := str(change.get("excerpt", ""))
	return "%s:%s:%s" % [session_id, str(change.get("type", "")), excerpt.hash()]


## Bounded, deduplicated conversation insert. A repeated source identity is one
## item, not two; a genuinely distinct message stays distinct.
##
## Every item carries the store's OWN sequence number, taken as the event is applied.
## That is the causal order the projection actually has: the kit forbids sorting
## concurrent source events by wall clock alone, and the wall clock is also wrong in
## practice, because a replay delivers a burst of events whose recorded times are seconds
## apart and can arrive in any order.
func record_interaction(item: Dictionary) -> void:
	var id := str(item.get("id", ""))
	if id.is_empty() or seen_interaction_ids.has(id):
		return
	seen_interaction_ids[id] = true
	item["description"] = _bounded(str(item.get("description", "")))
	item["sequence"] = _next_interaction_sequence
	_next_interaction_sequence += 1
	interactions.append(item)
	if interactions.size() > MAX_CONVERSATION_ITEMS:
		var dropped: Dictionary = interactions.pop_front()
		seen_interaction_ids.erase(str(dropped.get("id", "")))



## Truncate untrusted text to the ceiling and mark that text was removed.
##
## The marker is inside the ceiling, so the returned string never exceeds it, and
## the cut is on a character boundary: GDScript `substr` indexes characters, not
## bytes, so a multibyte message is never split mid-codepoint.
## Shell detail is observed state, like interactions, so an epoch change drops it.
func _bounded(text: String) -> String:
	if text.length() <= MAX_MESSAGE_EXCERPT:
		return text
	return text.substr(0, MAX_MESSAGE_EXCERPT - 1) + "…"


## An epoch change discards comparable cursors and cosmetic sequences without
## discarding durable history.
## Reconcile a reconnect.
##
## The global feed is volatile by contract: events during a disconnection are
## missed, and a restarted service has a NEW epoch. So a reconnect is not a
## resume — the projection may have holes. The honest response is to discard the
## projection and reload it canonically, which is what this marks.
##
## `stale` is deliberately a one-way flag: only a completed reload clears it, so
## no layer can quietly present a projection it knows is incomplete.
func mark_stale() -> void:
	stale = true
	connection_state = CONNECTION_RECONNECTING
	for actor in actors.values():
		actor.interaction_token += 1
		actor.queue_generation += 1


## Replace the projection with canonically reloaded state.
##
## The epoch and watermark come from the reload, not from the caller's memory, so
## the store never claims a watermark it has not actually reached.
func adopt_reload(reloaded: Array, new_epoch: String, _watermark: int = 0) -> void:
	actors.clear()
	interactions.clear()
	seen_interaction_ids.clear()
	attention.clear()
	_tool_names.clear()
	_stream_text.clear()
	_stream_reasoning.clear()
	_shells.clear()
	_limit_events.clear()
	_context_limits.clear()
	root_session_id = ""
	last_error = ""
	source_epoch = new_epoch
	stale = false
	for entry in reloaded:
		if entry is Dictionary:
			var event: Dictionary = entry
			apply(event)
	connection_state = CONNECTION_LIVE


## True while the projection is known to be incomplete after a reconnect.
##
## Presentation may keep drawing, but anything claiming completeness must check
## this first.
func is_stale() -> bool:
	return stale


func invalidate_epoch(new_epoch: String) -> void:
	stale = true
	source_epoch = new_epoch
	for actor in actors.values():
		actor.interaction_token += 1
		actor.queue_generation += 1
