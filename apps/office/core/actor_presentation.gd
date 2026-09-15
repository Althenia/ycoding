## Scoped presentation record for one actor.
##
## Canonical status fields are separate from position/animation, so the status
## panel never waits for a cosmetic sequence.
class_name ActorPresentation
extends RefCounted

var identity: ActorIdentity
var work_state: int = WorkState.Kind.IDLE
var status_label: String = "Idle"
var activity_label: String = ""
var task_description: String = ""
var attention_required: bool = false
var settled_status: String = ""
var selected: bool = false

## Presentation-only fields. Never a backend command.
var map_position: Vector2 = Vector2.ZERO
var destination: Vector2 = Vector2.ZERO
var interaction_token: int = 0
var queue_generation: int = 0

func _init(p_identity: ActorIdentity) -> void:
	identity = p_identity


func set_work(state: int) -> void:
	work_state = state
	status_label = WorkState.label(state)


func is_running() -> bool:
	return (
		work_state != WorkState.Kind.IDLE
		and work_state != WorkState.Kind.WAITING
		and work_state != WorkState.Kind.BLOCKED
	)


func to_dictionary() -> Dictionary:
	return {
		"session_id": identity.session_id,
		"agent_id": identity.agent_id,
		"display_name": identity.display_name,
		"work_state": work_state,
		"status_label": status_label,
		"activity_label": activity_label,
		"attention_required": attention_required,
		"settled_status": settled_status,
		"map_position": [map_position.x, map_position.y],
	}
