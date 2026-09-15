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
func status_rows() -> Array[Dictionary]:
	var rows: Array[Dictionary] = []
	for actor in actor_list():
		rows.append(
			{
				"name": actor.identity.display_name,
				"session_id": actor.identity.session_id,
				"state": actor.status_label,
				"glyph": WorkState.glyph(actor.work_state),
				"attention": actor.attention_required,
				"settled": actor.settled_status,
			}
		)
	return rows


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
	return false


func apply_session_created(session_id: String, data: Dictionary) -> bool:
	if session_id.is_empty():
		return false
	var parent := str(data.get("parentID", ""))
	var agent := str(data.get("agent", "agent"))
	var identity := ActorIdentity.new(session_id, agent, parent, agent.capitalize())
	if actors.has(session_id):
		actors[session_id].identity = identity
		return true
	actors[session_id] = ActorPresentation.new(identity)
	if parent.is_empty():
		root_session_id = session_id
	assign_ordinals()
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
func invalidate_epoch(new_epoch: String) -> void:
	source_epoch = new_epoch
	for actor in actors.values():
		actor.interaction_token += 1
		actor.queue_generation += 1
