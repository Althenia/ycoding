## OfficeDirector: deterministic fact -> cosmetic behavior.
##
## It consumes presentation state and emits local visual actions only. It cannot
## launch subagents, approve tools, prompt models, write the repository, or
## modify session history. Runtime updates never wait for it.
class_name OfficeDirector
extends RefCounted

## Bounded cosmetic queue per actor (handoff integration default).
const MAX_QUEUED_ACTIONS := 8
const MAX_ACTION_AGE_MS := 10_000

const ACTION_IDLE := "idle"
const ACTION_WORK := "work"
const ACTION_VISIT := "visit"
const ACTION_BUBBLE := "bubble"
const ACTION_SETTLE := "settle"
const ACTION_AMBIENT := "ambient"

var _queue: Array[Dictionary] = []


## Convert a store state change into a cosmetic action, or null when the change
## warrants no animation (canonical state is already visible in the panel).
func plan(actor: ActorPresentation, previous_state: int) -> Dictionary:
	if actor == null:
		return {}
	if actor.attention_required:
		# Human attention preempts everything and never queues behind animation.
		_queue.clear()
		return {
			"action": ACTION_BUBBLE,
			"actor": actor.identity.session_id,
			"token": actor.interaction_token,
			"generation": actor.queue_generation,
			"text": "Waiting for your decision",
			"source_backed": false,
		}
	if actor.work_state == WorkState.Kind.BLOCKED:
		return {
			"action": ACTION_BUBBLE,
			"actor": actor.identity.session_id,
			"token": actor.interaction_token,
			"generation": actor.queue_generation,
			"text": "Blocked",
			"source_backed": false,
		}
	if actor.work_state == previous_state:
		return {}
	if actor.is_running():
		return {
			"action": ACTION_WORK,
			"actor": actor.identity.session_id,
			"token": actor.interaction_token,
			"generation": actor.queue_generation,
			"state": actor.work_state,
		}
	return {
		"action": ACTION_SETTLE,
		"actor": actor.identity.session_id,
		"token": actor.interaction_token,
		"generation": actor.queue_generation,
		"settled": actor.settled_status,
	}


## Queue a decorative action with bounds and aging.
## Queue a decorative action with bounds, aging and coalescing.
##
## Coalescing is per actor and keeps only the newest: two pending movements for one
## actor would make it walk to a place it has already been told to leave, so the
## older intent is dropped rather than performed.
func enqueue(action: Dictionary, now_ms: int) -> bool:
	var actor_id := str(action.get("actor", ""))
	if actor_id.is_empty():
		return false
	_queue = _queue.filter(func(entry: Dictionary) -> bool:
		return str(entry.get("actor", "")) != actor_id)
	if _queue.size() >= MAX_QUEUED_ACTIONS:
		return false
	var entry := action.duplicate()
	entry["queued_at_ms"] = now_ms
	_queue.append(entry)
	return true


func dequeue(now_ms: int) -> Dictionary:
	while not _queue.is_empty():
		var entry: Dictionary = _queue.pop_front()
		if now_ms - int(entry.get("queued_at_ms", now_ms)) > MAX_ACTION_AGE_MS:
			continue
		return entry
	return {}


func queue_size() -> int:
	return _queue.size()


func clear() -> void:
	_queue.clear()


## A late callback from a superseded sequence must not revive stale state.
static func is_current(action: Dictionary, actor: ActorPresentation) -> bool:
	if actor == null:
		return false
	return (
		int(action.get("token", -1)) == actor.interaction_token
		and int(action.get("generation", -1)) == actor.queue_generation
	)


## Ambient behavior is cosmetic, preemptible, and costs no model calls. It never
## carries conversational text.
func plan_ambient(actor: ActorPresentation, tick: int) -> Dictionary:
	if actor == null or actor.is_running() or actor.attention_required:
		return {}
	# Every option must have a real destination, or the ambient action is a
	# no-op. "read" goes to the focus chair, "stretch" to the play room, and
	# "pause" stays put, which is the one case where staying is the behaviour.
	var options: Array[String] = ["read", "stretch", "pause"]
	var pick: String = options[tick % options.size()]
	return {
		"action": ACTION_AMBIENT,
		"actor": actor.identity.session_id,
		"ambient": pick,
		"token": actor.interaction_token,
		"generation": actor.queue_generation,
		"source_backed": false,
	}
