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

const CONNECTION_SYNCING := "syncing"
const CONNECTION_LIVE := "live"
const CONNECTION_RECONNECTING := "reconnecting"
const CONNECTION_DISCONNECTED := "disconnected"

## Tunable bound from the handoff integration defaults.
const MAX_CONVERSATION_ITEMS := 512

## How many agents can play in the play room at once. The lounge holds a
## ping-pong table and a pair of sofas, so this is a real floor limit rather than
## an arbitrary cap.
const PLAY_SPOTS := 4
const MAX_MESSAGE_EXCERPT := 240

var mode: String = MODE_DEMO
var connection_state: String = CONNECTION_SYNCING
var source_epoch: String = ""
var revision: int = 0

var actors: Dictionary = {}
var interactions: Array[Dictionary] = []
var seen_interaction_ids: Dictionary = {}
var root_session_id: String = ""
var last_error: String = ""
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
func conversation_items(session_id: String) -> Array[Dictionary]:
	return interactions.filter(func(item): return item.get("session_id", "") == session_id)


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
		Wire.EXECUTION_STARTED, Wire.STEP_STARTED, Wire.TEXT_STARTED, Wire.REASONING_STARTED:
			return apply_activity(session_id, WorkState.Kind.PROCESSING, type)
		Wire.TOOL_CALLED:
			return apply_tool(session_id, data, true)
		Wire.TOOL_SUCCESS:
			return apply_tool(session_id, data, false)
		Wire.TOOL_FAILED:
			return apply_activity(session_id, WorkState.Kind.BLOCKED, type)
		Wire.EXECUTION_SUCCEEDED:
			return apply_settled(session_id, "succeeded")
		Wire.EXECUTION_FAILED:
			return apply_settled(session_id, "failed")
		Wire.EXECUTION_INTERRUPTED:
			return apply_settled(session_id, "cancelled")
		Wire.TASK_UPDATED:
			return apply_task_change(session_id, data)
		Wire.INPUT_ADMITTED, Wire.INPUT_PROMOTED:
			return apply_activity(session_id, WorkState.Kind.PROCESSING, type)
		Wire.FILE_CHANGE:
			return apply_activity(session_id, WorkState.Kind.TYPING, type)
		Wire.COMPACTION_STARTED, Wire.COMPACTION_ADMITTED:
			return apply_activity(session_id, WorkState.Kind.COMPACTING, type)
		Wire.COMPACTION_ENDED, Wire.COMPACTION_FAILED:
			return apply_activity(session_id, WorkState.Kind.PROCESSING, type)
		Wire.SESSION_DELETED, Wire.SESSION_ARCHIVED:
			return apply_departure(session_id, true)
		Wire.SESSION_UNARCHIVED:
			return apply_departure(session_id, false)
	return false


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
## The real event carries `location: {directory}` and `model: {providerID,id,
## variant}`. A session's location is its own and does not follow a later
## directory change, so it is stored per actor. Values are only taken when the
## event actually carries them; nothing is invented, and a partial event leaves
## the previous value intact rather than blanking it.
func _apply_placement(actor: ActorPresentation, data: Dictionary) -> void:
	var location: Variant = data.get("location")
	if location is Dictionary:
		var directory := str((location as Dictionary).get("directory", ""))
		if not directory.is_empty():
			actor.location_directory = directory
	var model: Variant = data.get("model")
	if model is Dictionary:
		var ref := str((model as Dictionary).get("ref", ""))
		if not ref.is_empty():
			actor.model_ref = ref
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


func apply_tool(session_id: String, data: Dictionary, called: bool) -> bool:
	var actor := actor_for(session_id)
	if actor == null:
		return false
	if not called:
		actor.set_work(WorkState.Kind.PROCESSING)
		return true
	var name := str(data.get("tool", data.get("name", "")))
	var state := WorkState.from_tool(name)
	actor.set_work(state)
	# Only a classified tool becomes an attributed activity label.
	actor.activity_label = name if not name.is_empty() else "tool"
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
			record_interaction(
				{
					"id": "report:%s" % session_id,
					"kind": "report",
					"session_id": session_id,
					"description": str(change.get("excerpt", "")),
					"source": "session.task.updated",
					"source_verified": true,
				}
			)
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


## Bounded, deduplicated conversation insert. A repeated source identity is one
## item, not two; a genuinely distinct message stays distinct.
func record_interaction(item: Dictionary) -> void:
	var id := str(item.get("id", ""))
	if id.is_empty() or seen_interaction_ids.has(id):
		return
	seen_interaction_ids[id] = true
	var excerpt := str(item.get("description", ""))
	if excerpt.length() > MAX_MESSAGE_EXCERPT:
		item["description"] = excerpt.substr(0, MAX_MESSAGE_EXCERPT) + "…"
	interactions.append(item)
	if interactions.size() > MAX_CONVERSATION_ITEMS:
		var dropped: Dictionary = interactions.pop_front()
		seen_interaction_ids.erase(str(dropped.get("id", "")))


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
